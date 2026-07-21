import { createHash } from "node:crypto";
import {
	bundleDigest,
	CAPABILITY_BUNDLE_SCHEMA_VERSION,
} from "@buildplane/capability-broker";
import {
	canonicalGovernedAcceptanceContractV1Digest,
	canonicalGovernedUnitPacketV1Digest,
} from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import {
	__testOnlyIssueGovernedDispatchAdmissionV3,
	GOVERNED_DISPATCH_POLICY_DIGEST_DOMAIN_V1,
	type GovernedDispatchAdmissionInputV3,
	issueGovernedDispatchAdmissionV3,
	type SignedDispatchTapeEmitter,
} from "../src/governed-dispatch-admission.js";
import { GOVERNED_AUTHORITY_BROKER_REQUIRED } from "../src/governed-ledger-authority.js";

const RUN_ID = "01919000-0000-7000-8000-000000000001";
const EVENT_ID = "01919000-0000-7000-8000-000000000002";
const ISSUED_AT = "2026-07-18T12:00:00.000Z";
const EXPIRES_AT = "2026-07-18T12:05:00.000Z";
const BASE_SHA = "a".repeat(40);
const ACCEPTANCE_CONTRACT = {
	schemaVersion: 1,
	contract_version: "v0",
	diff_scope: { allowed_globs: ["apps/cli/**"] },
	checks: [{ command: "node --version" }],
};

const TRUST_SCOPE = {
	schemaVersion: 1,
	lane: "governed",
	principal: "kernel",
	scope: "apps/cli",
};

interface RecordedEmit {
	readonly kind: string;
	readonly payload: unknown;
	readonly options: unknown;
}

interface FakeEmitter {
	readonly emitter: SignedDispatchTapeEmitter;
	readonly emits: RecordedEmit[];
	flushCalls: number;
	flushObservedAfterEmit: number[];
}

function createFakeEmitter(options?: {
	readonly runId?: string;
	readonly authorityActor?: string;
	readonly onFlush?: () => Promise<void>;
}): FakeEmitter {
	const emits: RecordedEmit[] = [];
	const fake: FakeEmitter = {
		emits,
		flushCalls: 0,
		flushObservedAfterEmit: [],
		emitter: {
			signedDispatchAuthority: "ledger-signed-v1",
			runId: options?.runId ?? RUN_ID,
			authorityActor: options?.authorityActor ?? "kernel",
			emit(kind, payload, emitOptions) {
				emits.push({ kind, payload, options: emitOptions });
			},
			async flush() {
				fake.flushCalls += 1;
				fake.flushObservedAfterEmit.push(emits.length);
				await options?.onFlush?.();
			},
		},
	};
	return fake;
}

function governedPacket(overrides: Record<string, unknown> = {}): string {
	const capabilityBundle = {
		schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
		bundleId: "governed-dispatch-admission",
		fsWrite: ["apps/cli/**"],
		tools: { run_command: { allowlist: ["node"] } },
	};
	return JSON.stringify({
		unit: {
			id: "unit-governed-dispatch",
			kind: "implementation",
			scope: "apps/cli",
			inputRefs: [],
			expectedOutputs: [],
			verificationContract: "node --version",
			policyProfile: "governed",
		},
		execution_role: "implementer",
		execution: { command: "node", args: ["--version"] },
		verification: { requiredOutputs: [] },
		provenance_ref: "plan-admitted:01919000-0000-7000-8000-000000000099",
		capability_bundle: capabilityBundle,
		capability_bundle_digest: bundleDigest(capabilityBundle),
		acceptance_contract: ACCEPTANCE_CONTRACT,
		trust_scope: TRUST_SCOPE,
		...overrides,
	});
}

function request(
	emitter: SignedDispatchTapeEmitter,
	overrides: Record<string, unknown> = {},
): GovernedDispatchAdmissionInputV3 {
	return {
		emitter,
		sourcePacket: governedPacket(),
		runId: RUN_ID,
		workflowId: "workflow-governed-dispatch",
		workflowRevision: "revision-7",
		attempt: 1,
		commitMode: "atomic",
		trustTier: "governed",
		actionEvidenceVersion: "sealed_v3",
		contextManifestDigest: digest("c"),
		workerManifestDigest: digest("d"),
		sandboxProfileDigest: digest("e"),
		repositoryBindingDigest: digest("a"),
		ledgerAuthorityRealm: authorityRealm(),
		budget: { maxTokens: 2_048, maxComputeTimeMs: 60_000 },
		idempotencyKey:
			"dispatch:workflow-governed-dispatch:unit-governed-dispatch:1",
		issuedAt: ISSUED_AT,
		expiresAt: EXPIRES_AT,
		readCurrentBaseSha: () => BASE_SHA,
		now: () => new Date("2026-07-18T12:01:00.000Z"),
		generateEventId: () => EVENT_ID,
		...overrides,
	} as GovernedDispatchAdmissionInputV3;
}

function digest(fill: string): string {
	return `sha256:${fill.repeat(64)}`;
}

function authorityRealm() {
	return {
		kind: "host-governed-ledger-authority-v1" as const,
		realmDigest: digest("9"),
		ledgerWorkspace: "/var/lib/buildplane/governed-ledger",
		kernelActorId: "kernel",
		kernelKeyId: "kernel-main",
		kernelPublicKeyHash: digest("8"),
	};
}

function policyDigest(acceptanceContractDigest: string): string {
	return `sha256:${createHash("sha256")
		.update(GOVERNED_DISPATCH_POLICY_DIGEST_DOMAIN_V1, "utf8")
		.update(acceptanceContractDigest, "utf8")
		.digest("hex")}`;
}

describe("governed dispatch admission", () => {
	it("blocks local tape emission through the production entry point until an authority broker is available", async () => {
		const fake = createFakeEmitter();

		await expect(
			issueGovernedDispatchAdmissionV3(request(fake.emitter)),
		).rejects.toThrow(GOVERNED_AUTHORITY_BROKER_REQUIRED);
		expect(fake.emits).toEqual([]);
		expect(fake.flushCalls).toBe(0);
	});

	it("writes one native sealed V3 envelope under the generated event id and waits for durability", async () => {
		let releaseFlush: (() => void) | undefined;
		const flushGate = new Promise<void>((resolve) => {
			releaseFlush = resolve;
		});
		const fake = createFakeEmitter({ onFlush: () => flushGate });
		const issued = __testOnlyIssueGovernedDispatchAdmissionV3(
			request(fake.emitter),
		);

		for (let turn = 0; turn < 10 && fake.flushCalls === 0; turn += 1) {
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		expect(fake.emits).toHaveLength(1);
		expect(fake.flushCalls).toBe(1);
		expect(fake.flushObservedAfterEmit).toEqual([1]);

		let settled = false;
		void issued.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		releaseFlush?.();

		const lineage = await issued;
		const acceptanceContractDigest =
			canonicalGovernedAcceptanceContractV1Digest(ACCEPTANCE_CONTRACT);
		const governedPacketDigest = canonicalGovernedUnitPacketV1Digest(
			JSON.parse(governedPacket()),
		);
		expect(fake.emits[0]).toEqual({
			kind: "dispatch_envelope_v3",
			options: { id: EVENT_ID, occurredAt: ISSUED_AT },
			payload: {
				DispatchEnvelopeV3: {
					body: {
						workflow_id: "workflow-governed-dispatch",
						workflow_revision: "revision-7",
						unit_id: "unit-governed-dispatch",
						attempt: 1,
						execution_role: "implementer",
						commit_mode: "atomic",
						provenance_ref:
							"plan-admitted:01919000-0000-7000-8000-000000000099",
						base_commit_sha: BASE_SHA,
						capability_bundle_digest: bundleDigest({
							schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
							bundleId: "governed-dispatch-admission",
							fsWrite: ["apps/cli/**"],
							tools: { run_command: { allowlist: ["node"] } },
						}),
						acceptance_contract_digest: acceptanceContractDigest,
						context_manifest_digest: digest("c"),
						worker_manifest_digest: digest("d"),
						sandbox_profile_digest: digest("e"),
						budget: { max_tokens: 2_048, max_compute_time_ms: 60_000 },
						trust_tier: "governed",
						idempotency_key:
							"dispatch:workflow-governed-dispatch:unit-governed-dispatch:1",
						issued_at: ISSUED_AT,
						expires_at: EXPIRES_AT,
					},
					action_evidence_version: "sealed_v3",
					repository_binding_digest: digest("a"),
					ledger_authority_realm_digest: digest("9"),
					governed_packet_digest: governedPacketDigest,
					envelope_digest: expect.any(String),
				},
			},
		});
		expect(lineage).toMatchObject({
			schemaVersion: 3,
			runId: RUN_ID,
			workflowId: "workflow-governed-dispatch",
			workflowRevision: "revision-7",
			unitId: "unit-governed-dispatch",
			attempt: 1,
			dispatchEnvelopeRef: EVENT_ID,
			baseCommitSha: BASE_SHA,
			executionRole: "implementer",
			commitMode: "atomic",
			trustTier: "governed",
			acceptanceContractDigest,
			policyDigest: policyDigest(acceptanceContractDigest),
			repositoryBindingDigest: digest("a"),
			ledgerAuthorityRealmDigest: digest("9"),
			governedPacketDigest,
			authorityActor: "kernel",
			actionEvidenceVersion: "sealed_v3",
		});
		expect(Object.isFrozen(lineage)).toBe(true);
		expect(Object.isFrozen(lineage.budget)).toBe(true);
	});

	it("admits descriptor snapshots without invoking untrusted proxy get traps", async () => {
		const fake = createFakeEmitter();
		const value = request(fake.emitter);
		let reads = 0;
		const readTrap = <T extends object>(record: T): T =>
			new Proxy(record, {
				get(target, key, receiver) {
					reads += 1;
					return Reflect.get(target, key, receiver);
				},
			});
		const hostileInput = readTrap({
			...value,
			emitter: readTrap(value.emitter),
			ledgerAuthorityRealm: readTrap(value.ledgerAuthorityRealm),
			budget: readTrap(value.budget),
		});

		await expect(
			__testOnlyIssueGovernedDispatchAdmissionV3(hostileInput),
		).resolves.toMatchObject({
			runId: RUN_ID,
			commitMode: "atomic",
			trustTier: "governed",
		});
		expect(reads).toBe(0);
		expect(fake.emits).toHaveLength(1);
	});

	it.each([
		[
			"unsupported source role",
			(input: GovernedDispatchAdmissionInputV3) => ({
				...input,
				sourcePacket: governedPacket({ execution_role: "reviewer" }),
			}),
			/implementer/i,
		],
		[
			"unsupported mode",
			(input: GovernedDispatchAdmissionInputV3) => ({
				...input,
				commitMode: "incremental" as never,
			}),
			/atomic/i,
		],
		[
			"unsupported tier",
			(input: GovernedDispatchAdmissionInputV3) => ({
				...input,
				trustTier: "raw" as never,
			}),
			/governed/i,
		],
		[
			"legacy action evidence",
			(input: GovernedDispatchAdmissionInputV3) => ({
				...input,
				actionEvidenceVersion: "sealed-v2" as never,
			}),
			/sealed_v3/i,
		],
		[
			"expired timestamps",
			(input: GovernedDispatchAdmissionInputV3) => ({
				...input,
				expiresAt: "2026-07-18T12:00:30.000Z",
			}),
			/expired/i,
		],
		[
			"invalid timestamp order",
			(input: GovernedDispatchAdmissionInputV3) => ({
				...input,
				expiresAt: ISSUED_AT,
			}),
			/later than issued/i,
		],
		[
			"malformed capability digest",
			(input: GovernedDispatchAdmissionInputV3) => ({
				...input,
				sourcePacket: governedPacket({
					capability_bundle_digest: digest("f"),
				}),
			}),
			/does not match/i,
		],
		[
			"missing source governance",
			(input: GovernedDispatchAdmissionInputV3) => ({
				...input,
				sourcePacket: governedPacket({ acceptance_contract: {} }),
			}),
			/governed admission/i,
		],
		[
			"unknown nested acceptance contract field",
			(input: GovernedDispatchAdmissionInputV3) => ({
				...input,
				sourcePacket: governedPacket({
					acceptance_contract: { ...ACCEPTANCE_CONTRACT, injected: true },
				}),
			}),
			/acceptance_contract.*unknown field/i,
		],
		[
			"unversioned trust scope",
			(input: GovernedDispatchAdmissionInputV3) => ({
				...input,
				sourcePacket: governedPacket({
					trust_scope: {
						lane: "governed",
						principal: "kernel",
						scope: "apps/cli",
					},
				}),
			}),
			/trust_scope\.schemaVersion/i,
		],
		[
			"unknown admission field",
			(input: GovernedDispatchAdmissionInputV3) =>
				({ ...input, unexpected: true }) as GovernedDispatchAdmissionInputV3,
			/unknown/i,
		],
	] as const)("fails closed for %s without emitting", async (_label, alter, error) => {
		const fake = createFakeEmitter();

		await expect(
			__testOnlyIssueGovernedDispatchAdmissionV3(alter(request(fake.emitter))),
		).rejects.toThrow(error);
		expect(fake.emits).toEqual([]);
		expect(fake.flushCalls).toBe(0);
	});

	it("requires the injected signed emitter to be bound to the requested run", async () => {
		const fake = createFakeEmitter({
			runId: "01919000-0000-7000-8000-000000000003",
		});

		await expect(
			__testOnlyIssueGovernedDispatchAdmissionV3(request(fake.emitter)),
		).rejects.toThrow(/runId/i);
		expect(fake.emits).toEqual([]);
	});
});
