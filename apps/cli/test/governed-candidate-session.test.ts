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

function dispatch(source = packet()): GovernedDispatchLineageV3 {
	const acceptanceContractDigest = DIGEST("b");
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
		issuedAt: "2026-07-18T12:00:00Z",
		expiresAt: "2099-07-18T12:00:00Z",
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
	return {
		run: { id: RUN_ID, unitId: dispatched.unitId, status: "passed" },
		candidate: {
			schemaVersion: 1,
			candidateId: candidateIdForDispatch(dispatched),
			runId: RUN_ID,
			attempt: 1,
			candidateKey: "candidate-key",
			candidateRef: "refs/buildplane/candidates/candidate-key",
			baseSha: BASE_SHA,
			candidateCommitSha: "b".repeat(40),
			commitDigest: DIGEST("1"),
			treeDigest: DIGEST("2"),
			patchDigest: DIGEST("3"),
			changedFilesDigest: DIGEST("4"),
			candidateDigest: DIGEST("5"),
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
