import {
	bundleDigest,
	CAPABILITY_BUNDLE_SCHEMA_VERSION,
} from "@buildplane/capability-broker";
import type {
	GovernedDispatchLineageV3,
	RunPacketOptions,
	RunPacketResult,
	UnitPacket,
} from "@buildplane/kernel";
import { canonicalGovernedUnitPacketV1Digest } from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import {
	candidateIdForDispatch,
	executeGovernedCandidateSession,
} from "../src/governed-candidate-session.js";
import type { ResolvedGovernedDispatchSnapshot } from "../src/ledger-governed-dispatch-resolver.js";
import { governedPolicyDigestForAcceptanceContract } from "../src/ledger-governed-dispatch-resolver.js";

const RUN_ID = "00000000-0000-7000-8000-000000000061";
const BASE_SHA = "a".repeat(40);
const DIGEST = (character: string) => `sha256:${character.repeat(64)}`;
const PROJECT_ROOT = "/tmp/buildplane-governed-candidate-session";

function verifiedAuthorityPorts() {
	return {
		projectRoot: PROJECT_ROOT,
		repositoryBindingPort: {
			assertDispatchRepositoryBinding({ projectRoot, dispatch: verified }) {
				if (
					projectRoot !== PROJECT_ROOT ||
					verified.repositoryBindingDigest !== DIGEST("a")
				) {
					throw new TypeError("unexpected repository binding");
				}
			},
		},
		ledgerAuthorityRealmPort: {
			assertDispatchLedgerAuthorityRealm({ dispatch: verified }) {
				if (verified.ledgerAuthorityRealmDigest !== DIGEST("9")) {
					throw new TypeError("unexpected ledger authority realm");
				}
			},
		},
	};
}

function packet(overrides: Record<string, unknown> = {}): UnitPacket {
	const capabilityBundle = {
		schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
		bundleId: "governed-candidate-session",
		fsWrite: ["src/**"],
		tools: { run_command: { allowlist: ["node"] } },
	};
	return {
		unit: {
			id: "unit-governed-session",
			kind: "implementation",
			scope: "src",
			inputRefs: [],
			expectedOutputs: [],
			verificationContract: "node --version",
			policyProfile: "governed",
		},
		execution_role: "implementer",
		execution: { command: "node", args: ["--version"] },
		verification: { requiredOutputs: [] },
		provenance_ref: "plan-admitted:fixture",
		capability_bundle: capabilityBundle,
		capability_bundle_digest: bundleDigest(capabilityBundle),
		acceptance_contract: {
			schemaVersion: 1,
			contract_version: "v0",
			diff_scope: { allowed_globs: ["src/**"] },
			checks: [{ command: "node --version" }],
		},
		trust_scope: {
			schemaVersion: 1,
			lane: "governed",
			principal: "kernel",
			scope: "candidate-session",
		},
		...overrides,
	} as UnitPacket;
}

function dispatch(
	source = packet(),
	overrides: Partial<GovernedDispatchLineageV3> = {},
): GovernedDispatchLineageV3 {
	const acceptanceContractDigest = DIGEST("b");
	const now = Date.now();
	return {
		schemaVersion: 3,
		runId: RUN_ID,
		workflowId: "workflow-governed-session",
		workflowRevision: "1",
		unitId: source.unit.id,
		attempt: 1,
		provenanceRef: source.provenance_ref,
		dispatchEnvelopeRef: "00000000-0000-7000-8000-000000000062",
		envelopeDigest: DIGEST("c"),
		baseCommitSha: BASE_SHA,
		repositoryBindingDigest: DIGEST("a"),
		ledgerAuthorityRealmDigest: DIGEST("9"),
		governedPacketDigest: canonicalGovernedUnitPacketV1Digest(source),
		executionRole: "implementer",
		commitMode: "atomic",
		trustTier: "governed",
		capabilityBundleDigest: source.capability_bundle_digest ?? "",
		acceptanceContractDigest,
		policyDigest: governedPolicyDigestForAcceptanceContract(
			acceptanceContractDigest,
		),
		contextManifestDigest: DIGEST("d"),
		workerManifestDigest: DIGEST("e"),
		sandboxProfileDigest: DIGEST("f"),
		budget: { maxTokens: 100, maxComputeTimeMs: 30_000 },
		idempotencyKey: "dispatch:governed-session",
		authorityActor: "kernel",
		actionEvidenceVersion: "sealed_v3",
		issuedAt: new Date(now - 1_000).toISOString(),
		expiresAt: new Date(now + 15 * 60_000).toISOString(),
		...overrides,
	};
}

function resolution(
	dispatched: GovernedDispatchLineageV3,
	overrides: Partial<ResolvedGovernedDispatchSnapshot> = {},
): ResolvedGovernedDispatchSnapshot {
	return {
		dispatch: dispatched,
		recovery: { requests: [], receipts: [], candidates: [] },
		phase: "dispatched",
		pendingActionIds: [],
		unknownActionIds: [],
		failedActionIds: [],
		...overrides,
	};
}

function candidateResult(
	dispatched: GovernedDispatchLineageV3,
): RunPacketResult {
	const candidateId = candidateIdForDispatch(dispatched);
	const candidateKey = `${candidateId}/${dispatched.runId}/${dispatched.attempt}`;
	const candidate = {
		schemaVersion: 1 as const,
		candidateId,
		runId: RUN_ID,
		attempt: 1,
		candidateKey,
		candidateRef: `refs/buildplane/candidates/${candidateKey}`,
		baseSha: BASE_SHA,
		candidateCommitSha: "b".repeat(40),
		commitDigest: DIGEST("1"),
		treeDigest: DIGEST("2"),
		patchDigest: DIGEST("3"),
		changedFilesDigest: DIGEST("4"),
		candidateDigest: DIGEST("5"),
	};
	return {
		run: { id: RUN_ID, unitId: dispatched.unitId, status: "passed" },
		candidate,
		decision: {
			kind: "advance-run",
			outcome: "approved",
			reasons: ["deterministic acceptance passed"],
		},
		candidateAcceptance: {
			candidateDigest: candidate.candidateDigest,
			candidateCommitSha: candidate.candidateCommitSha,
			acceptanceContractDigest: dispatched.acceptanceContractDigest,
			acceptanceRef: "01919000-0000-7000-8000-000000000061",
			outcome: "passed",
		},
	};
}

describe("governed candidate session", () => {
	it("executes exactly one candidate-only kernel run with immutable dispatch bindings", async () => {
		const source = packet();
		const dispatched = dispatch(source);
		const calls: Array<{ packet: UnitPacket; options: RunPacketOptions }> = [];
		const result = await executeGovernedCandidateSession({
			packet: source,
			dispatch: dispatched,
			resolution: resolution(dispatched),
			...verifiedAuthorityPorts(),
			orchestrator: {
				async runPacketAsync(current, _bus, options) {
					calls.push({ packet: current, options });
					return candidateResult(dispatched);
				},
			},
		});
		expect(result.candidate?.candidateDigest).toBe(DIGEST("5"));
		expect(calls).toHaveLength(1);
		expect(calls[0]?.options).toMatchObject({
			runId: RUN_ID,
			trustLane: "governed",
			finalizationMode: "create-candidate",
			workspaceBaseSha: BASE_SHA,
			governedDispatch: dispatched,
			candidateIdentity: {
				candidateId: candidateIdForDispatch(dispatched),
				attempt: 1,
			},
		});
		expect(calls[0]?.options).not.toHaveProperty("promotion");
		expect(calls[0]?.options.finalizationMode).not.toBe("auto-merge");
	});

	it("blocks future-issued and elapsed-compute dispatches before the kernel can create a candidate", async () => {
		const source = packet();
		const now = Date.now();
		const inactiveDispatches = [
			dispatch(source, {
				issuedAt: new Date(now + 60_000).toISOString(),
				expiresAt: new Date(now + 120_000).toISOString(),
			}),
			dispatch(source, {
				issuedAt: new Date(now - 60_000).toISOString(),
				expiresAt: new Date(now + 60_000).toISOString(),
				budget: { maxTokens: 100, maxComputeTimeMs: 1 },
			}),
		];
		let calls = 0;
		const orchestrator = {
			async runPacketAsync(): Promise<RunPacketResult> {
				calls += 1;
				throw new Error("inactive authority must not reach the orchestrator");
			},
		};

		for (const dispatched of inactiveDispatches) {
			await expect(
				executeGovernedCandidateSession({
					packet: source,
					dispatch: dispatched,
					resolution: resolution(dispatched),
					...verifiedAuthorityPorts(),
					orchestrator,
				}),
			).rejects.toThrow(/active verified dispatch authority window/i);
		}
		expect(calls).toBe(0);
	});

	it("blocks recovery state, model packets, and wrong roles before any orchestrator call", async () => {
		const source = packet();
		const dispatched = dispatch(source);
		let calls = 0;
		const orchestrator = {
			async runPacketAsync(): Promise<RunPacketResult> {
				calls += 1;
				return candidateResult(dispatched);
			},
		};
		await expect(
			executeGovernedCandidateSession({
				packet: source,
				dispatch: dispatched,
				resolution: resolution(dispatched, { pendingActionIds: ["action"] }),
				...verifiedAuthorityPorts(),
				orchestrator,
			}),
		).rejects.toThrow(/recovery/i);

		await expect(
			executeGovernedCandidateSession({
				packet: packet({
					execution: undefined,
					model: {
						provider: "openai",
						model: "gpt-test",
						prompt: "write code",
					},
				}),
				dispatch: dispatched,
				resolution: resolution(dispatched),
				...verifiedAuthorityPorts(),
				orchestrator,
			}),
		).rejects.toThrow(/model packets/i);
		expect(calls).toBe(0);
	});

	it("fails closed when the kernel result lacks a candidate or reports a merge", async () => {
		const source = packet();
		const dispatched = dispatch(source);
		await expect(
			executeGovernedCandidateSession({
				packet: source,
				dispatch: dispatched,
				resolution: resolution(dispatched),
				...verifiedAuthorityPorts(),
				orchestrator: {
					async runPacketAsync() {
						return {
							run: { id: RUN_ID, unitId: dispatched.unitId, status: "passed" },
							mergedHeadSha: "c".repeat(40),
						};
					},
				},
			}),
		).rejects.toThrow(/immutable candidate/i);
	});

	it("rejects a candidate result without an approved decision and passed acceptance", async () => {
		const source = packet();
		const dispatched = dispatch(source);
		const complete = candidateResult(dispatched);
		let calls = 0;

		await expect(
			executeGovernedCandidateSession({
				packet: source,
				dispatch: dispatched,
				resolution: resolution(dispatched),
				...verifiedAuthorityPorts(),
				orchestrator: {
					async runPacketAsync() {
						calls += 1;
						return {
							run: complete.run,
							candidate: complete.candidate,
						};
					},
				},
			}),
		).rejects.toThrow(
			/approved policy decision and passed candidate acceptance/i,
		);
		expect(calls).toBe(1);
	});

	it("rejects every completion field that is not bound to the sealed dispatch", async () => {
		const source = packet();
		const dispatched = dispatch(source);
		const complete = candidateResult(dispatched);
		const candidate = complete.candidate!;
		const acceptance = complete.candidateAcceptance!;
		const invalidResults: readonly [string, RunPacketResult][] = [
			[
				"non-passed run",
				{ ...complete, run: { ...complete.run, status: "failed" } },
			],
			[
				"wrong run id",
				{
					...complete,
					run: {
						...complete.run,
						id: "00000000-0000-7000-8000-000000000069",
					},
				},
			],
			[
				"wrong run unit",
				{ ...complete, run: { ...complete.run, unitId: "unit-substituted" } },
			],
			[
				"rejected policy decision",
				{
					...complete,
					decision: {
						kind: "reject-run",
						outcome: "rejected",
						reasons: ["candidate rejected"],
					},
				},
			],
			[
				"retry policy decision",
				{
					...complete,
					decision: {
						kind: "retry-run",
						outcome: "retrying",
						reasons: ["retry"],
						attemptNumber: 2,
						feedbackContext: [],
					},
				},
			],
			[
				"substituted candidate id",
				{
					...complete,
					candidate: { ...candidate, candidateId: "candidate-substituted" },
				},
			],
			[
				"target branch substituted as a candidate ref",
				{
					...complete,
					candidate: { ...candidate, candidateRef: "refs/heads/main" },
				},
			],
			[
				"unrelated Buildplane candidate key and ref",
				{
					...complete,
					candidate: {
						...candidate,
						candidateKey: `candidate-unrelated/${dispatched.runId}/${dispatched.attempt}`,
						candidateRef: `refs/buildplane/candidates/candidate-unrelated/${dispatched.runId}/${dispatched.attempt}`,
					},
				},
			],
			[
				"malformed matching candidate digest",
				{
					...complete,
					candidate: { ...candidate, candidateDigest: "not-a-digest" },
					candidateAcceptance: {
						...acceptance,
						candidateDigest: "not-a-digest",
					},
				},
			],
			[
				"upper-case matching candidate digest",
				{
					...complete,
					candidate: {
						...candidate,
						candidateDigest: `sha256:${"A".repeat(64)}`,
					},
					candidateAcceptance: {
						...acceptance,
						candidateDigest: `sha256:${"A".repeat(64)}`,
					},
				},
			],
			[
				"malformed matching candidate commit",
				{
					...complete,
					candidate: { ...candidate, candidateCommitSha: "not-a-commit" },
					candidateAcceptance: {
						...acceptance,
						candidateCommitSha: "not-a-commit",
					},
				},
			],
			[
				"upper-case matching candidate commit",
				{
					...complete,
					candidate: { ...candidate, candidateCommitSha: "B".repeat(40) },
					candidateAcceptance: {
						...acceptance,
						candidateCommitSha: "B".repeat(40),
					},
				},
			],
			[
				"rejected acceptance",
				{
					...complete,
					candidateAcceptance: { ...acceptance, outcome: "rejected" },
				},
			],
			[
				"substituted candidate digest",
				{
					...complete,
					candidateAcceptance: {
						...acceptance,
						candidateDigest: DIGEST("8"),
					},
				},
			],
			[
				"substituted candidate commit",
				{
					...complete,
					candidateAcceptance: {
						...acceptance,
						candidateCommitSha: "c".repeat(40),
					},
				},
			],
			[
				"substituted acceptance contract",
				{
					...complete,
					candidateAcceptance: {
						...acceptance,
						acceptanceContractDigest: DIGEST("9"),
					},
				},
			],
			[
				"missing acceptance contract",
				{
					...complete,
					candidateAcceptance: {
						...acceptance,
						acceptanceContractDigest: undefined,
					},
				},
			],
			[
				"empty acceptance reference",
				{
					...complete,
					candidateAcceptance: { ...acceptance, acceptanceRef: "   " },
				},
			],
			[
				"noncanonical acceptance event reference",
				{
					...complete,
					candidateAcceptance: {
						...acceptance,
						acceptanceRef: "00000000-0000-4000-8000-000000000001",
					},
				},
			],
			[
				"upper-case acceptance event reference",
				{
					...complete,
					candidateAcceptance: {
						...acceptance,
						acceptanceRef: "01919000-0000-7000-8000-00000000006A",
					},
				},
			],
		];
		let calls = 0;

		for (const [_name, invalid] of invalidResults) {
			await expect(
				executeGovernedCandidateSession({
					packet: source,
					dispatch: dispatched,
					resolution: resolution(dispatched),
					...verifiedAuthorityPorts(),
					orchestrator: {
						async runPacketAsync() {
							calls += 1;
							return invalid;
						},
					},
				}),
			).rejects.toThrow(/governed candidate session/i);
		}
		expect(calls).toBe(invalidResults.length);
	});

	it("normalizes canonical raw adapter candidate digests into strict V1 review evidence", async () => {
		const source = packet();
		const dispatched = dispatch(source);
		const complete = candidateResult(dispatched);
		const candidate = complete.candidate!;
		const acceptance = complete.candidateAcceptance!;
		const rawResult: RunPacketResult = {
			...complete,
			candidate: {
				...candidate,
				commitDigest: "1".repeat(64),
				treeDigest: "2".repeat(64),
				patchDigest: "3".repeat(64),
				changedFilesDigest: "4".repeat(64),
				candidateDigest: "5".repeat(64),
			},
			candidateAcceptance: {
				...acceptance,
				candidateDigest: "5".repeat(64),
				acceptanceContractDigest: "b".repeat(64),
			},
		};

		const result = await executeGovernedCandidateSession({
			packet: source,
			dispatch: dispatched,
			resolution: resolution(dispatched),
			...verifiedAuthorityPorts(),
			orchestrator: {
				async runPacketAsync() {
					return rawResult;
				},
			},
		});

		expect(result.candidate).toMatchObject({
			commitDigest: DIGEST("1"),
			treeDigest: DIGEST("2"),
			patchDigest: DIGEST("3"),
			changedFilesDigest: DIGEST("4"),
			candidateDigest: DIGEST("5"),
		});
		expect(result.candidateAcceptance).toMatchObject({
			candidateDigest: DIGEST("5"),
			acceptanceContractDigest: DIGEST("b"),
		});
	});

	it("returns immutable candidate completion snapshots after validation", async () => {
		const source = packet();
		const dispatched = dispatch(source);
		const complete = candidateResult(dispatched);
		const result = await executeGovernedCandidateSession({
			packet: source,
			dispatch: dispatched,
			resolution: resolution(dispatched),
			...verifiedAuthorityPorts(),
			orchestrator: {
				async runPacketAsync() {
					return complete;
				},
			},
		});
		const mutable = complete as unknown as {
			run: { id: string; unitId: string; status: string };
			candidate: { candidateRef: string; candidateDigest: string };
			decision: { reasons: string[] };
			candidateAcceptance: { acceptanceRef: string; candidateDigest: string };
		};

		mutable.run.status = "failed";
		mutable.candidate.candidateRef = "refs/heads/main";
		mutable.candidate.candidateDigest = DIGEST("8");
		mutable.decision.reasons.push("mutated after validation");
		mutable.candidateAcceptance.acceptanceRef =
			"00000000-0000-4000-8000-000000000001";
		mutable.candidateAcceptance.candidateDigest = DIGEST("9");

		expect(result).toMatchObject({
			run: { id: RUN_ID, unitId: dispatched.unitId, status: "passed" },
			candidate: {
				candidateRef: `refs/buildplane/candidates/${candidateIdForDispatch(dispatched)}/${dispatched.runId}/${dispatched.attempt}`,
				candidateDigest: DIGEST("5"),
			},
			decision: { reasons: ["deterministic acceptance passed"] },
			candidateAcceptance: {
				acceptanceRef: "01919000-0000-7000-8000-000000000061",
				candidateDigest: DIGEST("5"),
			},
		});
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.run)).toBe(true);
		expect(Object.isFrozen(result.candidate)).toBe(true);
		expect(Object.isFrozen(result.decision)).toBe(true);
		expect(Object.isFrozen(result.decision.reasons)).toBe(true);
		expect(Object.isFrozen(result.candidateAcceptance)).toBe(true);
	});

	it("captures getter-backed completion values once before returning a review snapshot", async () => {
		const source = packet();
		const dispatched = dispatch(source);
		const complete = candidateResult(dispatched);
		const candidate = complete.candidate!;
		let runReads = 0;
		let statusReads = 0;
		let candidateIdReads = 0;
		let candidateKeyReads = 0;
		const flippingRun = {
			id: complete.run.id,
			unitId: complete.run.unitId,
			get status() {
				statusReads += 1;
				return statusReads === 1 ? "passed" : "failed";
			},
		};
		const flippingCandidate = {
			...candidate,
			get candidateId() {
				candidateIdReads += 1;
				return candidateIdReads === 1
					? candidate.candidateId
					: "candidate-substituted";
			},
			get candidateKey() {
				candidateKeyReads += 1;
				return candidateKeyReads === 1
					? candidate.candidateKey
					: "candidate-substituted";
			},
		};
		const flippingResult = {
			...complete,
			candidate: flippingCandidate,
			get run() {
				runReads += 1;
				return flippingRun;
			},
		} as unknown as RunPacketResult;

		const result = await executeGovernedCandidateSession({
			packet: source,
			dispatch: dispatched,
			resolution: resolution(dispatched),
			...verifiedAuthorityPorts(),
			orchestrator: {
				async runPacketAsync() {
					return flippingResult;
				},
			},
		});

		expect(result).toMatchObject({
			run: { id: RUN_ID, unitId: dispatched.unitId, status: "passed" },
			candidate: {
				candidateId: candidate.candidateId,
				candidateKey: candidate.candidateKey,
			},
		});
		expect(runReads).toBe(1);
		expect(statusReads).toBe(1);
		expect(candidateIdReads).toBe(1);
		expect(candidateKeyReads).toBe(1);
	});

	it("rejects a changed command or trust scope before the orchestrator can execute", async () => {
		const source = packet();
		const dispatched = dispatch(source);
		let calls = 0;
		const orchestrator = {
			async runPacketAsync(): Promise<RunPacketResult> {
				calls += 1;
				return candidateResult(dispatched);
			},
		};

		for (const substituted of [
			packet({
				execution: { command: "node", args: ["--eval", "process.exit(0)"] },
			}),
			packet({
				trust_scope: {
					schemaVersion: 1,
					lane: "governed",
					principal: "kernel",
					scope: "substituted",
				},
			}),
		]) {
			await expect(
				executeGovernedCandidateSession({
					packet: substituted,
					dispatch: dispatched,
					resolution: resolution(dispatched),
					...verifiedAuthorityPorts(),
					orchestrator,
				}),
			).rejects.toThrow(/exact packet digest/i);
		}
		expect(calls).toBe(0);
	});
});
