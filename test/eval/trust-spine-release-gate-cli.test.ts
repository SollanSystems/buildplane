import {
	createHash,
	sign as cryptoSign,
	generateKeyPairSync,
	type KeyObject,
} from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	evaluateTrustSpineReleaseCampaignBundle as evaluateCampaignBundle,
	runTrustSpineReleaseGateCli,
	type TrustSpineReleaseCampaignEvaluationOptionsV1,
	type TrustSpineReleasePolicyV1,
	type TrustSpineReleaseTrustRootV1,
} from "../../eval/trust-spine-release-gate-cli.js";

const NOW = Date.parse("2026-07-20T12:00:00.000Z");
const COMMIT = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);
const REF = "refs/heads/main";
const RELEASE_POLICY_DIGEST_DOMAIN =
	"buildplane.trust-spine.release-policy.v1\0";
const RELEASE_EVALUATION_EVIDENCE_V1_DIGEST_DOMAIN =
	"buildplane.release-evaluation-evidence.v1\0";
type JsonObject = Record<string, unknown>;

const RELEASE_POLICY = {
	expectedProviders: ["anthropic", "openai"],
	expectedTrustTiers: ["standard"],
	targetRef: REF,
	minimumTasksPerGroup: 30,
	maxCapabilityRegression: 0.05,
	baselineByGroup: {
		"anthropic/standard": { passAt1: 1, passAll3: 1 },
		"openai/standard": { passAt1: 1, passAll3: 1 },
	},
	requiredCheckNames: ["verify"],
} satisfies TrustSpineReleasePolicyV1;

function evaluateTrustSpineReleaseCampaignBundle(
	bundle: unknown,
	trustRoot: unknown,
	overrides: Partial<TrustSpineReleaseCampaignEvaluationOptionsV1> = {},
) {
	return evaluateCampaignBundle(bundle, trustRoot, {
		releaseCommit: COMMIT,
		releaseRef: REF,
		now: NOW,
		...overrides,
	});
}

function canonicalJson(value: unknown): string {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number"
	) {
		return JSON.stringify(value);
	}
	if (typeof value === "string") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (typeof value === "object") {
		const record = value as JsonObject;
		return (
			"{" +
			Object.keys(record)
				.sort()
				.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
				.join(",") +
			"}"
		);
	}
	throw new TypeError("test bundle contains a non-JSON value");
}

function policyDigest(policy: TrustSpineReleasePolicyV1): string {
	return sha256(
		Buffer.from(
			`${RELEASE_POLICY_DIGEST_DOMAIN}${canonicalJson(policy)}`,
			"utf8",
		),
	);
}

function sha256(value: Buffer | string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function releaseEvaluationEvidencePayload(
	claimKind:
		| "trial"
		| "target_branch_immutability"
		| "backward_replay_compatibility"
		| "required_check",
	claim: JsonObject,
	bindings: {
		readonly releaseCommit?: string;
		readonly releaseRef?: string;
		readonly policyDigest?: string;
		readonly corruptClaimDigest?: boolean;
	} = {},
): JsonObject {
	const material = {
		schema_version: 1,
		release_commit: bindings.releaseCommit ?? COMMIT,
		release_ref: bindings.releaseRef ?? REF,
		policy_digest: bindings.policyDigest ?? policyDigest(RELEASE_POLICY),
		claim_kind: claimKind,
		claim,
	};
	return {
		ReleaseEvaluationEvidenceV1: {
			...material,
			claim_digest: bindings.corruptClaimDigest
				? sha256("corrupted-release-evaluation-claim-digest")
				: sha256(
						Buffer.from(
							`${RELEASE_EVALUATION_EVIDENCE_V1_DIGEST_DOMAIN}${JSON.stringify(material)}`,
							"utf8",
						),
					),
		},
	};
}

interface TapeFixture {
	readonly tape: JsonObject;
	readonly tapeRootHash: string;
	readonly throughEventId: string;
	readonly throughEventCount: number;
	readonly eventHashes: ReadonlyMap<string, string>;
	readonly trustedTapeSigner: JsonObject;
	readonly trustedCheckpointSigner: JsonObject;
}

interface TapeFixtureOptions {
	readonly useCheckpointSignerForEvidence?: boolean;
	readonly useOrdinarySignerForCheckpoint?: boolean;
	readonly checkpointParentEventId?: string;
	readonly checkpointIndex?: number;
	readonly previousCheckpointEventId?: string | null;
	readonly secondCheckpointIndex?: number;
	readonly secondCheckpointPreviousEventId?: string | null;
	readonly secondCheckpointParentEventId?: string;
	readonly claimReleaseCommit?: string;
	readonly claimReleaseRef?: string;
	readonly claimPolicyDigest?: string;
	readonly corruptClaimDigest?: boolean;
	readonly claimProvider?: string;
	readonly reuseTrialSource?: boolean;
	readonly branchSourceId?: string;
	readonly claimUnknownField?: boolean;
	readonly unauthorizedEffects?: number;
}

const TAPE_ID = "campaign-tape";
const TAPE_RUN_ID = "campaign-run";
const GA_PROVIDERS = ["anthropic", "openai"] as const;
const CAMPAIGN_TASK_IDS = Object.freeze([
	"task-a",
	...Array.from({ length: 29 }, (_, index) => `task-${index + 2}`),
]);
const TRIALS = [1, 2, 3] as const;
const EVIDENCE_KINDS = [
	"request",
	"candidate",
	"acceptance",
	"review",
	"recovery",
	"terminal",
] as const;

interface TrialFixture {
	readonly provider: (typeof GA_PROVIDERS)[number];
	readonly taskId: string;
	readonly trial: (typeof TRIALS)[number];
}

const TRIAL_FIXTURES = Object.freeze(
	GA_PROVIDERS.flatMap((provider) =>
		CAMPAIGN_TASK_IDS.flatMap((taskId) =>
			TRIALS.map((trial) => ({ provider, taskId, trial })),
		),
	),
) satisfies readonly TrialFixture[];

function evidenceEventId(
	provider: TrialFixture["provider"],
	taskId: string,
	kind: (typeof EVIDENCE_KINDS)[number],
	trial: TrialFixture["trial"],
): string {
	if (taskId === "task-a") {
		return provider === "openai"
			? `${kind}-${trial}`
			: `anthropic-${kind}-${trial}`;
	}
	return `${provider}-${taskId}-${kind}-${trial}`;
}

function trialClaimEventId({ provider, taskId, trial }: TrialFixture): string {
	if (taskId === "task-a") {
		return provider === "openai"
			? `trial-claim-${trial}`
			: `anthropic-trial-claim-${trial}`;
	}
	return `${provider}-${taskId}-trial-claim-${trial}`;
}

const EVIDENCE_EVENT_IDS = Object.freeze([
	...TRIAL_FIXTURES.flatMap(({ provider, taskId, trial }) =>
		EVIDENCE_KINDS.map((kind) =>
			evidenceEventId(provider, taskId, kind, trial),
		),
	),
	"branch-proof",
	"replay-proof",
	"check-proof",
]);
const CLAIM_EVENT_IDS = Object.freeze([
	...TRIAL_FIXTURES.map(trialClaimEventId),
	"branch-claim",
	"replay-claim",
	"check-claim",
]);

function storedTapeEvent(
	id: string,
	kind: string,
	payload: JsonObject,
	privateKey: KeyObject,
	signer: JsonObject,
	parentEventId: string | null = null,
): { readonly entry: JsonObject; readonly canonicalEventHash: string } {
	const canonical = Buffer.from(
		JSON.stringify({
			id,
			run_id: TAPE_RUN_ID,
			parent_event_id: parentEventId,
			schema_version: 1,
			kind,
			occurred_at: "2026-07-20T12:00:00.000Z",
			payload,
		}),
		"utf8",
	);
	const canonicalEventHash = sha256(canonical);
	return {
		entry: {
			canonical_event_b64: canonical.toString("base64"),
			signature: {
				event_id: id,
				canonical_event_hash: canonicalEventHash,
				signer,
				algorithm: "ed25519",
				signature: cryptoSign(null, canonical, privateKey).toString(
					"base64url",
				),
				signed_at: "2026-07-20T12:00:00.000Z",
			},
		},
		canonicalEventHash,
	};
}

function createSignedTape(options: TapeFixtureOptions = {}): TapeFixture {
	const { privateKey: tapePrivateKey, publicKey: tapePublicKey } =
		generateKeyPairSync("ed25519");
	const tapeRaw = rawPublicKey(tapePublicKey);
	const tapeSigner = {
		actor_id: "test-tape-signer",
		key_id: "test-tape-key-1",
		public_key_hash: sha256(tapeRaw),
	};
	const { privateKey: checkpointPrivateKey, publicKey: checkpointPublicKey } =
		generateKeyPairSync("ed25519");
	const checkpointRaw = rawPublicKey(checkpointPublicKey);
	const checkpointSigner = {
		actor_id: "test-checkpoint-signer",
		key_id: "test-checkpoint-key-1",
		public_key_hash: sha256(checkpointRaw),
	};
	const signedEvidence = EVIDENCE_EVENT_IDS.map((id) =>
		storedTapeEvent(
			id,
			"evidence",
			{ EvidenceV1: { event_id: id } },
			options.useCheckpointSignerForEvidence
				? checkpointPrivateKey
				: tapePrivateKey,
			options.useCheckpointSignerForEvidence ? checkpointSigner : tapeSigner,
		),
	);
	const eventHashes = new Map(
		EVIDENCE_EVENT_IDS.map((id, index) => [
			id,
			signedEvidence[index].canonicalEventHash,
		]),
	);
	const source = (id: string): JsonObject => {
		const hash = eventHashes.get(id);
		if (!hash) throw new Error(`missing test source event ${id}`);
		return {
			source_event_id: id,
			source_canonical_event_hash: hash,
		};
	};
	const claimBindings = {
		releaseCommit: options.claimReleaseCommit,
		releaseRef: options.claimReleaseRef,
		policyDigest: options.claimPolicyDigest,
		corruptClaimDigest: options.corruptClaimDigest,
	};
	const claimPayload = (
		claimKind:
			| "trial"
			| "target_branch_immutability"
			| "backward_replay_compatibility"
			| "required_check",
		claim: JsonObject,
	): JsonObject => {
		if (options.claimUnknownField) claim.unknown = true;
		return releaseEvaluationEvidencePayload(claimKind, claim, claimBindings);
	};
	const trialClaim = (
		provider: "anthropic" | "openai",
		taskId: string,
		trial: 1 | 2 | 3,
	): JsonObject => ({
		task_id: taskId,
		provider: options.claimProvider ?? provider,
		trust_tier: "standard",
		trial,
		governance: "governed",
		passed: true,
		cost_usd_micros: 100_000,
		latency_ms: 1000,
		tokens: 100,
		tool_calls: 2,
		candidate_count: 1,
		reviewer_disagreed: false,
		false_approval: false,
		unauthorized_effects: options.unauthorizedEffects ?? 0,
		duplicate_effects: 0,
		safety_violations: 0,
		recovery_correct: true,
		illegitimate_success: false,
		sources: {
			model_request: source(
				evidenceEventId(provider, taskId, "request", trial),
			),
			candidate: source(evidenceEventId(provider, taskId, "candidate", trial)),
			acceptance: source(
				evidenceEventId(provider, taskId, "acceptance", trial),
			),
			review: source(evidenceEventId(provider, taskId, "review", trial)),
			recovery: source(evidenceEventId(provider, taskId, "recovery", trial)),
			terminal: options.reuseTrialSource
				? source(evidenceEventId(provider, taskId, "request", trial))
				: source(evidenceEventId(provider, taskId, "terminal", trial)),
		},
	});
	const signedClaims = [
		...TRIAL_FIXTURES.map(({ provider, taskId, trial }) =>
			storedTapeEvent(
				trialClaimEventId({ provider, taskId, trial }),
				"release_evaluation_evidence_v1",
				claimPayload("trial", trialClaim(provider, taskId, trial)),
				options.useCheckpointSignerForEvidence
					? checkpointPrivateKey
					: tapePrivateKey,
				options.useCheckpointSignerForEvidence ? checkpointSigner : tapeSigner,
			),
		),
		storedTapeEvent(
			"branch-claim",
			"release_evaluation_evidence_v1",
			claimPayload("target_branch_immutability", {
				immutable: true,
				source: source(options.branchSourceId ?? "branch-proof"),
			}),
			options.useCheckpointSignerForEvidence
				? checkpointPrivateKey
				: tapePrivateKey,
			options.useCheckpointSignerForEvidence ? checkpointSigner : tapeSigner,
		),
		storedTapeEvent(
			"replay-claim",
			"release_evaluation_evidence_v1",
			claimPayload("backward_replay_compatibility", {
				compatible: true,
				source: source("replay-proof"),
			}),
			options.useCheckpointSignerForEvidence
				? checkpointPrivateKey
				: tapePrivateKey,
			options.useCheckpointSignerForEvidence ? checkpointSigner : tapeSigner,
		),
		storedTapeEvent(
			"check-claim",
			"release_evaluation_evidence_v1",
			claimPayload("required_check", {
				name: "verify",
				conclusion: "success",
				source: source("check-proof"),
			}),
			options.useCheckpointSignerForEvidence
				? checkpointPrivateKey
				: tapePrivateKey,
			options.useCheckpointSignerForEvidence ? checkpointSigner : tapeSigner,
		),
	];
	for (const [index, id] of CLAIM_EVENT_IDS.entries()) {
		eventHashes.set(id, signedClaims[index].canonicalEventHash);
	}
	const orderedEvidence = [...eventHashes.entries()].sort(([left], [right]) =>
		left.localeCompare(right),
	);
	const throughEventId = orderedEvidence.at(-1)?.[0];
	if (!throughEventId)
		throw new Error("test signed tape has no evidence events");
	const tapeRootHash = sha256(
		Buffer.from(orderedEvidence.map(([, hash]) => hash).join("\n"), "utf8"),
	);
	const checkpoint = storedTapeEvent(
		"tape-checkpoint",
		"tape_checkpoint",
		{
			TapeCheckpointV1: {
				run_id: TAPE_RUN_ID,
				checkpoint_index: options.checkpointIndex ?? 0,
				through_event_id: throughEventId,
				through_event_count: orderedEvidence.length,
				previous_checkpoint_event_id: options.previousCheckpointEventId ?? null,
				tape_root_hash: tapeRootHash,
				algorithm: "sha256_linear",
			},
		},
		options.useOrdinarySignerForCheckpoint
			? tapePrivateKey
			: checkpointPrivateKey,
		options.useOrdinarySignerForCheckpoint ? tapeSigner : checkpointSigner,
		options.checkpointParentEventId ?? throughEventId,
	);
	const postCheckpoint = storedTapeEvent(
		"zz-post-checkpoint",
		"evidence",
		{ EvidenceV1: { event_id: "zz-post-checkpoint" } },
		options.useCheckpointSignerForEvidence
			? checkpointPrivateKey
			: tapePrivateKey,
		options.useCheckpointSignerForEvidence ? checkpointSigner : tapeSigner,
		"tape-checkpoint",
	);
	eventHashes.set("zz-post-checkpoint", postCheckpoint.canonicalEventHash);
	const secondCheckpoint =
		options.secondCheckpointIndex === undefined
			? undefined
			: (() => {
					const orderedPostCheckpointEvidence = [...eventHashes.entries()].sort(
						([left], [right]) => left.localeCompare(right),
					);
					const secondThroughEventId =
						orderedPostCheckpointEvidence.at(-1)?.[0];
					if (!secondThroughEventId) {
						throw new Error("test signed tape has no post-checkpoint evidence");
					}
					const secondTapeRootHash = sha256(
						Buffer.from(
							orderedPostCheckpointEvidence.map(([, hash]) => hash).join("\n"),
							"utf8",
						),
					);
					return storedTapeEvent(
						"tape-checkpoint-2",
						"tape_checkpoint",
						{
							TapeCheckpointV1: {
								run_id: TAPE_RUN_ID,
								checkpoint_index: options.secondCheckpointIndex,
								through_event_id: secondThroughEventId,
								through_event_count: orderedPostCheckpointEvidence.length,
								previous_checkpoint_event_id:
									options.secondCheckpointPreviousEventId === undefined
										? "tape-checkpoint"
										: options.secondCheckpointPreviousEventId,
								tape_root_hash: secondTapeRootHash,
								algorithm: "sha256_linear",
							},
						},
						checkpointPrivateKey,
						checkpointSigner,
						options.secondCheckpointParentEventId ?? secondThroughEventId,
					);
				})();
	return {
		tape: {
			format: "buildplane.signed-tape.v1",
			run_id: TAPE_RUN_ID,
			trusted_keys: [
				{
					public_key_hash: tapeSigner.public_key_hash,
					public_key_b64: tapeRaw.toString("base64"),
				},
				{
					public_key_hash: checkpointSigner.public_key_hash,
					public_key_b64: checkpointRaw.toString("base64"),
				},
			],
			events: [
				...signedEvidence.map(({ entry }) => entry),
				...signedClaims.map(({ entry }) => entry),
				checkpoint.entry,
				postCheckpoint.entry,
				...(secondCheckpoint ? [secondCheckpoint.entry] : []),
			],
		},
		tapeRootHash,
		throughEventId,
		throughEventCount: orderedEvidence.length,
		eventHashes,
		trustedTapeSigner: {
			actorId: tapeSigner.actor_id,
			keyId: tapeSigner.key_id,
			publicKeyHash: tapeSigner.public_key_hash,
			publicKeyB64: tapeRaw.toString("base64url"),
		},
		trustedCheckpointSigner: {
			actorId: checkpointSigner.actor_id,
			keyId: checkpointSigner.key_id,
			publicKeyHash: checkpointSigner.public_key_hash,
			publicKeyB64: checkpointRaw.toString("base64url"),
		},
	};
}

function eventRef(tape: TapeFixture, id: string): JsonObject {
	const canonicalEventHash = tape.eventHashes.get(id);
	if (!canonicalEventHash) throw new Error(`missing test tape event ${id}`);
	return {
		tapeId: TAPE_ID,
		tapeRootHash: tape.tapeRootHash,
		eventId: id,
		canonicalEventHash,
	};
}

function rawPublicKey(publicKey: KeyObject): Buffer {
	const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
	if (!jwk.x) throw new Error("generated Ed25519 key has no public component");
	return Buffer.from(jwk.x, "base64url");
}

interface SignedFixture {
	readonly bundle: JsonObject;
	readonly trustRoot: TrustSpineReleaseTrustRootV1;
}

function signedFixture(
	mutatePayload?: (payload: JsonObject) => void,
	tapeOptions?: TapeFixtureOptions,
): SignedFixture {
	const tape = createSignedTape(tapeOptions);
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const raw = rawPublicKey(publicKey);
	const host = {
		realm: "test.release.host",
		keyId: "test-host-1",
		actorId: "test-host",
		publicKeyHash: sha256(raw),
	};
	const trustRoot: TrustSpineReleaseTrustRootV1 = {
		format: "buildplane.trust-spine.release-trust-root.v1",
		schemaVersion: 1,
		maxCampaignAgeHours: 24,
		trustedHosts: [
			{
				...host,
				publicKeyB64: raw.toString("base64url"),
			},
		],
		trustedTapeSigners: [tape.trustedTapeSigner],
		trustedCheckpointSigners: [tape.trustedCheckpointSigner],
		releasePolicy: RELEASE_POLICY,
	};
	const payload: JsonObject = {
		format: "buildplane.trust-spine.release-campaign.v2",
		schemaVersion: 2,
		campaignId: "test-campaign",
		issuedAt: new Date(NOW - 60_000).toISOString(),
		expiresAt: new Date(NOW + 60_000).toISOString(),
		releaseCommit: COMMIT,
		releaseRef: REF,
		policyDigest: policyDigest(RELEASE_POLICY),
		host,
		tapeRoots: [
			{
				tapeId: TAPE_ID,
				tapeRootHash: tape.tapeRootHash,
				throughEventId: tape.throughEventId,
				throughEventCount: tape.throughEventCount,
				tape: tape.tape,
			},
		],
		trials: TRIAL_FIXTURES.map((trial) =>
			eventRef(tape, trialClaimEventId(trial)),
		),
		invariants: {
			targetBranchImmutability: eventRef(tape, "branch-claim"),
			backwardReplayCompatibility: eventRef(tape, "replay-claim"),
			requiredChecks: [eventRef(tape, "check-claim")],
		},
	};
	mutatePayload?.(payload);
	const signedDocument = {
		format: "buildplane.trust-spine.release-campaign-bundle.v1",
		schemaVersion: 1,
		payload,
	};
	const canonicalPayload = Buffer.from(canonicalJson(signedDocument), "utf8");
	const bundle: JsonObject = {
		format: "buildplane.trust-spine.release-campaign-bundle.v1",
		schemaVersion: 1,
		payload,
		attestation: {
			...host,
			algorithm: "ed25519",
			payloadSha256: sha256(canonicalPayload),
			signature: cryptoSign(null, canonicalPayload, privateKey).toString(
				"base64url",
			),
		},
	};
	return { bundle, trustRoot };
}

function campaignTapeRoot(payload: JsonObject): JsonObject {
	const roots = payload.tapeRoots as JsonObject[];
	if (roots.length !== 1)
		throw new Error("test campaign must contain one tape");
	return roots[0];
}

function campaignEvidenceRefs(payload: JsonObject): JsonObject[] {
	const trialRefs = payload.trials as JsonObject[];
	const invariants = payload.invariants as JsonObject;
	return [
		...trialRefs,
		invariants.targetBranchImmutability as JsonObject,
		invariants.backwardReplayCompatibility as JsonObject,
		...((invariants.requiredChecks as JsonObject[]) ?? []),
	];
}

describe("Trust Spine release-gate CLI evidence boundary", () => {
	it("accepts a complete signed campaign only when every gate input derives from bound evidence", () => {
		const { bundle, trustRoot } = signedFixture();

		const result = evaluateTrustSpineReleaseCampaignBundle(bundle, trustRoot, {
			releaseCommit: COMMIT,
			now: NOW,
		});

		expect(result).toMatchObject({ ready: true, blockers: [] });
	});

	it("never treats host-signed campaign outcomes as release evidence", () => {
		const { bundle, trustRoot } = signedFixture((payload) => {
			const trials = payload.trials as JsonObject[];
			trials[0].passed = true;
			const invariants = payload.invariants as JsonObject;
			(invariants.targetBranchImmutability as JsonObject).immutable = true;
		});

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(bundle, trustRoot),
		).toThrow(/unknown field|typed claim|claim event/i);
	});

	it("rejects legacy v1 raw-claim campaigns without a compatibility path", () => {
		const { bundle, trustRoot } = signedFixture((payload) => {
			payload.format = "buildplane.trust-spine.release-campaign.v1";
			payload.schemaVersion = 1;
			(payload.trials as JsonObject[])[0].passed = true;
		});

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(bundle, trustRoot),
		).toThrow(/format is not recognized/i);
	});

	it("binds the signed campaign to the root-pinned release policy digest", () => {
		const invalid = signedFixture((payload) => {
			payload.policyDigest = sha256("weaker-policy");
		});

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				invalid.bundle,
				invalid.trustRoot,
			),
		).toThrow(/policy digest/i);
	});

	it("fails closed when the root has no configured release policy", () => {
		const fixture = signedFixture();

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(fixture.bundle, {
				...fixture.trustRoot,
				releasePolicy: null,
			}),
		).toThrow(/release policy.*configured|policy.*unconfigured/i);
	});

	it("requires the root-pinned policy to cover both GA providers", () => {
		const fixture = signedFixture();

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(fixture.bundle, {
				...fixture.trustRoot,
				releasePolicy: {
					...RELEASE_POLICY,
					expectedProviders: ["openai"],
					baselineByGroup: {
						"openai/standard": { passAt1: 1, passAll3: 1 },
					},
				},
			}),
		).toThrow(/must include GA provider anthropic/i);
	});

	it("requires thirty held-out tasks for every provider and trust-tier group", () => {
		const fixture = signedFixture();

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(fixture.bundle, {
				...fixture.trustRoot,
				releasePolicy: {
					...RELEASE_POLICY,
					minimumTasksPerGroup: 29,
				},
			}),
		).toThrow(/minimumTasksPerGroup must be at least 30/i);
	});

	it("caps the signed GA capability-regression allowance at five percentage points", () => {
		const fixture = signedFixture();

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(fixture.bundle, {
				...fixture.trustRoot,
				releasePolicy: {
					...RELEASE_POLICY,
					maxCapabilityRegression: 0.051,
				},
			}),
		).toThrow(/maxCapabilityRegression must be between zero and 0\.05/i);
	});

	it("blocks a signed campaign with any unauthorized effect", () => {
		const fixture = signedFixture(undefined, { unauthorizedEffects: 1 });

		expect(
			evaluateTrustSpineReleaseCampaignBundle(
				fixture.bundle,
				fixture.trustRoot,
			),
		).toMatchObject({
			ready: false,
			blockers: expect.arrayContaining([
				expect.stringMatching(/unauthorized effect/i),
			]),
		});
	});

	it("requires the explicit release ref to equal the root-pinned target ref", () => {
		const fixture = signedFixture();

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				fixture.bundle,
				fixture.trustRoot,
				{ releaseRef: "refs/heads/not-main" },
			),
		).toThrow(/release ref.*pinned|target ref/i);
	});

	it("rejects a signer-controlled policy injection in the campaign payload", () => {
		const invalid = signedFixture((payload) => {
			payload.policy = {
				...RELEASE_POLICY,
				targetRef: "refs/heads/not-main",
			};
		});

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				invalid.bundle,
				invalid.trustRoot,
			),
		).toThrow(/unknown field.*policy/i);
	});

	it("rejects a fake tape-root label even when every campaign reference repeats it", () => {
		const fakeRoot = sha256("self-asserted-root");
		const invalid = signedFixture((payload) => {
			campaignTapeRoot(payload).tapeRootHash = fakeRoot;
			for (const evidence of campaignEvidenceRefs(payload)) {
				evidence.tapeRootHash = fakeRoot;
			}
		});

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				invalid.bundle,
				invalid.trustRoot,
				{ releaseCommit: COMMIT, now: NOW },
			),
		).toThrow(/checkpoint|tape root|root hash/i);
	});

	it("rejects a tape whose stored canonical bytes were changed after signing", () => {
		const invalid = signedFixture((payload) => {
			const tape = campaignTapeRoot(payload).tape as JsonObject;
			const entry = (tape.events as JsonObject[])[0];
			const canonical = JSON.parse(
				Buffer.from(entry.canonical_event_b64 as string, "base64").toString(
					"utf8",
				),
			) as JsonObject;
			canonical.occurred_at = "2026-07-20T12:00:01.000Z";
			entry.canonical_event_b64 = Buffer.from(
				JSON.stringify(canonical),
				"utf8",
			).toString("base64");
		});

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				invalid.bundle,
				invalid.trustRoot,
				{ releaseCommit: COMMIT, now: NOW },
			),
		).toThrow(/canonical event hash|hash/i);
	});

	it("rejects a tape whose detached event signature was tampered", () => {
		const invalid = signedFixture((payload) => {
			const tape = campaignTapeRoot(payload).tape as JsonObject;
			const entry = (tape.events as JsonObject[])[0];
			const signature = entry.signature as JsonObject;
			signature.signature = Buffer.alloc(64, 0).toString("base64url");
		});

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				invalid.bundle,
				invalid.trustRoot,
				{ releaseCommit: COMMIT, now: NOW },
			),
		).toThrow(/signature/i);
	});

	it("rejects generic checkpoint-covered events in place of typed claim events", () => {
		const invalid = signedFixture((payload) => {
			const trial = (payload.trials as JsonObject[])[0];
			const tape = campaignTapeRoot(payload).tape as JsonObject;
			const generic = (tape.events as JsonObject[]).find((entry) => {
				const canonical = JSON.parse(
					Buffer.from(entry.canonical_event_b64 as string, "base64").toString(
						"utf8",
					),
				) as JsonObject;
				return canonical.id === "request-1";
			});
			if (!generic) throw new Error("test generic event is absent");
			const signature = generic.signature as JsonObject;
			trial.eventId = signature.event_id;
			trial.canonicalEventHash = signature.canonical_event_hash;
		});

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				invalid.bundle,
				invalid.trustRoot,
				{ releaseCommit: COMMIT, now: NOW },
			),
		).toThrow(/release_evaluation_evidence_v1|typed claim/i);
	});

	it("rejects tape trusted_keys when the signer is not root pinned", () => {
		const fixture = signedFixture();

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				fixture.bundle,
				{ ...fixture.trustRoot, trustedTapeSigners: [] },
				{ releaseCommit: COMMIT, now: NOW },
			),
		).toThrow(/pinned.*tape signer|tape signer.*pinned/i);
	});

	it("rejects a checkpoint signed by an ordinary tape signer", () => {
		const invalid = signedFixture(undefined, {
			useOrdinarySignerForCheckpoint: true,
		});

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				invalid.bundle,
				invalid.trustRoot,
			),
		).toThrow(/checkpoint signer.*pinned|pinned.*checkpoint signer/i);
	});

	it("rejects ordinary evidence signed by a checkpoint authority", () => {
		const invalid = signedFixture(undefined, {
			useCheckpointSignerForEvidence: true,
		});

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				invalid.bundle,
				invalid.trustRoot,
			),
		).toThrow(/tape signer.*pinned|pinned.*tape signer/i);
	});

	it("rejects a checkpoint whose canonical parent is not its through event", () => {
		const invalid = signedFixture(undefined, {
			checkpointParentEventId: "wrong-parent-event",
		});

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				invalid.bundle,
				invalid.trustRoot,
			),
		).toThrow(/checkpoint parent.*through event|parent.*through/i);
	});

	it("rejects a nonzero initial checkpoint index with a forked previous link", () => {
		const invalid = signedFixture(undefined, {
			checkpointIndex: 1,
			previousCheckpointEventId: "some-other-checkpoint",
		});

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				invalid.bundle,
				invalid.trustRoot,
			),
		).toThrow(/checkpoint index|previous checkpoint|checkpoint chain/i);
	});

	it("accepts a sequential checkpoint chain", () => {
		const fixture = signedFixture(undefined, {
			secondCheckpointIndex: 1,
		});

		expect(
			evaluateTrustSpineReleaseCampaignBundle(
				fixture.bundle,
				fixture.trustRoot,
			),
		).toMatchObject({ ready: true, blockers: [] });
	});

	it("rejects a later checkpoint with a duplicate index", () => {
		const invalid = signedFixture(undefined, {
			secondCheckpointIndex: 0,
		});

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				invalid.bundle,
				invalid.trustRoot,
			),
		).toThrow(/checkpoint indexes.*duplicate|checkpoint index/i);
	});

	it("rejects a later checkpoint that forks its predecessor link", () => {
		const invalid = signedFixture(undefined, {
			secondCheckpointIndex: 1,
			secondCheckpointPreviousEventId: "some-other-checkpoint",
		});

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				invalid.bundle,
				invalid.trustRoot,
			),
		).toThrow(/previous checkpoint|checkpoint chain/i);
	});

	it("rejects evidence for a valid signed event after the declared checkpoint", () => {
		const invalid = signedFixture((payload) => {
			const tape = campaignTapeRoot(payload).tape as JsonObject;
			const postCheckpoint = (tape.events as JsonObject[]).find((entry) => {
				const canonical = JSON.parse(
					Buffer.from(entry.canonical_event_b64 as string, "base64").toString(
						"utf8",
					),
				) as JsonObject;
				return canonical.id === "zz-post-checkpoint";
			});
			if (!postCheckpoint)
				throw new Error("test post-checkpoint event is absent");
			const signature = postCheckpoint.signature as JsonObject;
			const trial = (payload.trials as JsonObject[])[0];
			trial.eventId = signature.event_id;
			trial.canonicalEventHash = signature.canonical_event_hash;
		});

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				invalid.bundle,
				invalid.trustRoot,
			),
		).toThrow(/verified event.*covered|tape root/i);
	});

	it("fails closed for unsigned, untrusted, stale, wrong-commit, and tampered bundles", () => {
		const unsigned = signedFixture().bundle;
		delete unsigned.attestation;
		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				unsigned,
				signedFixture().trustRoot,
				{
					releaseCommit: COMMIT,
					now: NOW,
				},
			),
		).toThrow(/attestation/i);

		const untrusted = signedFixture();
		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				untrusted.bundle,
				{ ...untrusted.trustRoot, trustedHosts: [] },
				{ releaseCommit: COMMIT, now: NOW },
			),
		).toThrow(/trusted host/i);

		const stale = signedFixture((payload) => {
			payload.issuedAt = new Date(NOW - 48 * 60 * 60 * 1000).toISOString();
			payload.expiresAt = new Date(NOW - 60_000).toISOString();
		});
		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(stale.bundle, stale.trustRoot, {
				releaseCommit: COMMIT,
				now: NOW,
			}),
		).toThrow(/stale|expired/i);

		const wrongCommit = signedFixture((payload) => {
			payload.releaseCommit = OTHER_COMMIT;
		});
		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				wrongCommit.bundle,
				wrongCommit.trustRoot,
				{ releaseCommit: COMMIT, now: NOW },
			),
		).toThrow(/commit/i);

		const tampered = signedFixture();
		((tampered.bundle.payload as JsonObject).trials as JsonObject[])[0].passed =
			false;
		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				tampered.bundle,
				tampered.trustRoot,
				{
					releaseCommit: COMMIT,
					now: NOW,
				},
			),
		).toThrow(/hash|signature/i);
	});

	it("rejects typed claims whose digest does not bind the claim body", () => {
		const invalid = signedFixture(undefined, { corruptClaimDigest: true });

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				invalid.bundle,
				invalid.trustRoot,
				{
					releaseCommit: COMMIT,
					now: NOW,
				},
			),
		).toThrow(/claim digest/i);
	});

	it("requires every typed claim to bind the requested release and policy", () => {
		const wrongCommit = signedFixture(undefined, {
			claimReleaseCommit: OTHER_COMMIT,
		});
		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				wrongCommit.bundle,
				wrongCommit.trustRoot,
			),
		).toThrow(/release commit/i);

		const wrongRef = signedFixture(undefined, {
			claimReleaseRef: "refs/heads/not-main",
		});
		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				wrongRef.bundle,
				wrongRef.trustRoot,
			),
		).toThrow(/release ref/i);

		const wrongPolicy = signedFixture(undefined, {
			claimPolicyDigest: sha256("other-pinned-policy"),
		});
		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				wrongPolicy.bundle,
				wrongPolicy.trustRoot,
			),
		).toThrow(/policy digest/i);
	});

	it("rejects source-event reuse inside a typed trial claim", () => {
		const invalid = signedFixture(undefined, { reuseTrialSource: true });

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				invalid.bundle,
				invalid.trustRoot,
				{
					releaseCommit: COMMIT,
					now: NOW,
				},
			),
		).toThrow(/six distinct source events|reuses evidence/i);
	});

	it("rejects source-event reuse across typed claims", () => {
		const invalid = signedFixture(undefined, { branchSourceId: "request-1" });

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				invalid.bundle,
				invalid.trustRoot,
			),
		).toThrow(/reuses evidence/i);
	});

	it("rejects unknown fields inside a signed typed claim", () => {
		const invalid = signedFixture(undefined, { claimUnknownField: true });

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				invalid.bundle,
				invalid.trustRoot,
				{
					releaseCommit: COMMIT,
					now: NOW,
				},
			),
		).toThrow(/unknown field/i);
	});

	it("rejects trial evidence for a provider outside the pinned release policy", () => {
		const invalid = signedFixture(undefined, {
			claimProvider: "unapproved-provider",
		});

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				invalid.bundle,
				invalid.trustRoot,
				{
					releaseCommit: COMMIT,
					now: NOW,
				},
			),
		).toThrow(/pinned release policy/i);
	});

	it("rejects unknown fields and duplicate declared tape roots", () => {
		const unknownField = signedFixture((payload) => {
			payload.precomputedReady = true;
		});
		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				unknownField.bundle,
				unknownField.trustRoot,
				{
					releaseCommit: COMMIT,
					now: NOW,
				},
			),
		).toThrow(/unknown field/i);

		const duplicateRoot = signedFixture((payload) => {
			const roots = payload.tapeRoots as JsonObject[];
			roots.push({ ...roots[0] });
		});
		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				duplicateRoot.bundle,
				duplicateRoot.trustRoot,
				{
					releaseCommit: COMMIT,
					now: NOW,
				},
			),
		).toThrow(/repeats tape root/i);
	});

	it("rejects the same signed tape when it is relabeled under a second campaign tape id", () => {
		const aliasedRoot = signedFixture((payload) => {
			const roots = payload.tapeRoots as JsonObject[];
			roots.push({ ...roots[0], tapeId: "campaign-tape-alias" });
		});

		expect(() =>
			evaluateTrustSpineReleaseCampaignBundle(
				aliasedRoot.bundle,
				aliasedRoot.trustRoot,
			),
		).toThrow(/same signed tape|source run/i);
	});

	it("requires an explicit absolute bundle path and never falls back to synthetic evidence", () => {
		const stderr: string[] = [];
		expect(
			runTrustSpineReleaseGateCli(["--commit", COMMIT], {
				stderr: (line) => stderr.push(line),
			}),
		).toBe(2);
		expect(stderr.join("\n")).toMatch(/--bundle/i);

		const fixture = signedFixture();
		const directory = mkdtempSync(join(tmpdir(), "trust-spine-campaign-"));
		const bundlePath = join(directory, "campaign.json");
		writeFileSync(bundlePath, JSON.stringify(fixture.bundle));
		stderr.length = 0;
		expect(
			runTrustSpineReleaseGateCli(
				["--bundle", bundlePath, "--commit", COMMIT],
				{ stderr: (line) => stderr.push(line), now: NOW },
			),
		).toBe(2);
		expect(stderr.join("\n")).toMatch(/--ref/i);

		stderr.length = 0;
		expect(
			runTrustSpineReleaseGateCli(
				["--bundle", bundlePath, "--commit", COMMIT, "--ref", REF],
				{ stderr: (line) => stderr.push(line), now: NOW },
			),
		).toBe(1);
		expect(stderr.join("\n")).toMatch(/release policy.*configured/i);
	});

	it("rejects duplicate JSON object keys before schema validation", () => {
		const fixture = signedFixture();
		const directory = mkdtempSync(
			join(tmpdir(), "trust-spine-duplicate-json-"),
		);
		const bundlePath = join(directory, "campaign.json");
		const serialized = JSON.stringify(fixture.bundle);
		writeFileSync(
			bundlePath,
			serialized.replace('{"format":', '{"format":"ignored","format":'),
		);
		const stderr: string[] = [];

		expect(
			runTrustSpineReleaseGateCli(
				["--bundle", bundlePath, "--commit", COMMIT, "--ref", REF],
				{ stderr: (line) => stderr.push(line), now: NOW },
			),
		).toBe(1);
		expect(stderr.join("\n")).toMatch(/duplicate JSON key/i);
	});

	it("never reaches the mutable eval execution path", () => {
		const source = readFileSync(
			join(process.cwd(), "eval", "trust-spine-release-gate-cli.ts"),
			"utf8",
		);
		expect(source).not.toMatch(/from\s+["'][^"']*runner/);
		expect(source).not.toMatch(/import\(["'][^"']*runner/);
	});
});
