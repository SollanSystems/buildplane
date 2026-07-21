import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bundleDigest,
	CAPABILITY_BUNDLE_SCHEMA_VERSION,
} from "@buildplane/capability-broker";
import { describe, expect, it, vi } from "vitest";
import {
	canonicalGovernedV3RetryRequestV1Digest,
	canonicalUntrustedAttemptContextRecordedV1Digest,
	type GovernedV3RetryContextResolverPort,
	type GovernedV3RetryRequestV1,
	type UntrustedAttemptContextRecordedV1,
} from "../src/governed-retry-authority.js";
import { createBuildplaneOrchestrator } from "../src/orchestrator.js";
import { canonicalGovernedAcceptanceContractV1Digest } from "../src/packet.js";
import type {
	BuildplaneAcceptanceEvidencePort,
	BuildplanePolicyPort,
	BuildplaneRuntimePort,
	BuildplaneStoragePort,
	BuildplaneWorkspacePort,
	CandidateEvidencePort,
	CandidateGovernanceLineage,
	GovernedActionEvidencePort,
	GovernedActivityClaimPort,
	GovernedDispatchLineageV3,
	GovernedWorkerExecutionPort,
} from "../src/ports.js";
import type {
	UnitPacket,
	WorkspaceCandidateArtifact,
} from "../src/run-loop.js";
import {
	canonicalActionReceiptSetRecordedV1Digest,
	canonicalGovernedUnitPacketV1Digest,
} from "../src/trust-spine.js";

const RUN_ID = "01919000-0000-7000-8000-0000000000ce";
const CANDIDATE_DIGEST = "c".repeat(64);
const ENVELOPE_DIGEST = `sha256:${"d".repeat(64)}`;
const ACTION_RECEIPT_DIGEST = `sha256:${"e".repeat(64)}`;
const GOVERNED_ACCEPTANCE_CONTRACT = {
	schemaVersion: 1 as const,
	contract_version: "v0" as const,
	diff_scope: { allowed_globs: ["**"] },
	checks: [{ command: "candidate-check" }],
};
const GOVERNED_ACCEPTANCE_CONTRACT_DIGEST =
	canonicalGovernedAcceptanceContractV1Digest(GOVERNED_ACCEPTANCE_CONTRACT);
const GOVERNED_CAPABILITY_BUNDLE = {
	schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
	bundleId: "candidate-evidence-governed",
	fsRead: ["**"],
	fsWrite: ["tmp/**"],
	tools: { run_command: { allowlist: ["node"] } },
};
const GOVERNED_CAPABILITY_BUNDLE_DIGEST = bundleDigest(
	GOVERNED_CAPABILITY_BUNDLE,
);

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function packet(overrides: Partial<UnitPacket> = {}): UnitPacket {
	return {
		unit: {
			id: "candidate-unit",
			kind: "command",
			scope: "task",
			inputRefs: [],
			expectedOutputs: [],
			verificationContract: "exit-0",
			policyProfile: "governed",
		},
		execution: { command: "ignored", args: [] },
		execution_role: "implementer",
		verification: { requiredOutputs: [] },
		provenance_ref: "event://admission/1",
		capability_bundle: GOVERNED_CAPABILITY_BUNDLE,
		capability_bundle_digest: GOVERNED_CAPABILITY_BUNDLE_DIGEST,
		acceptance_contract: GOVERNED_ACCEPTANCE_CONTRACT,
		trust_scope: {
			schemaVersion: 1,
			lane: "governed",
			principal: "kernel:test",
			scope: "candidate-evidence",
		},
		...overrides,
	};
}

function v3Dispatch(
	baseCommitSha: string,
	capabilityBundleDigest: string,
	overrides: Partial<GovernedDispatchLineageV3> = {},
	boundPacket: UnitPacket = packet(),
): GovernedDispatchLineageV3 {
	return {
		schemaVersion: 3,
		runId: RUN_ID,
		workflowId: "workflow-v3",
		workflowRevision: "revision-v3",
		unitId: "candidate-unit",
		attempt: 1,
		provenanceRef: "event://admission/1",
		dispatchEnvelopeRef: "event://dispatch-v3/1",
		envelopeDigest: ENVELOPE_DIGEST,
		baseCommitSha,
		repositoryBindingDigest: `sha256:${"e".repeat(64)}`,
		ledgerAuthorityRealmDigest: `sha256:${"f".repeat(64)}`,
		governedPacketDigest: canonicalGovernedUnitPacketV1Digest(boundPacket),
		executionRole: "implementer",
		commitMode: "atomic",
		trustTier: "governed",
		capabilityBundleDigest,
		acceptanceContractDigest: GOVERNED_ACCEPTANCE_CONTRACT_DIGEST,
		policyDigest: `sha256:${"a".repeat(64)}`,
		contextManifestDigest: `sha256:${"b".repeat(64)}`,
		workerManifestDigest: `sha256:${"c".repeat(64)}`,
		sandboxProfileDigest: `sha256:${"d".repeat(64)}`,
		budget: {},
		idempotencyKey: "dispatch-v3:1",
		authorityActor: "kernel:test",
		actionEvidenceVersion: "sealed_v3",
		issuedAt: "2099-07-17T12:00:00Z",
		expiresAt: "2099-07-17T12:15:00Z",
		...overrides,
	};
}

function candidate(
	baseSha: string,
	candidateCommitSha: string,
): WorkspaceCandidateArtifact {
	return {
		schemaVersion: 1,
		candidateId: "candidate-flow",
		runId: RUN_ID,
		attempt: 1,
		candidateKey: "candidate-flow/run/1",
		candidateRef: "refs/buildplane/candidates/candidate-flow/run/1",
		baseSha,
		candidateCommitSha,
		commitDigest: "1".repeat(64),
		treeDigest: "2".repeat(64),
		patchDigest: "3".repeat(64),
		changedFilesDigest: "4".repeat(64),
		candidateDigest: CANDIDATE_DIGEST,
	};
}

const RETRY_WORKER_ACTION = {
	actionId: "deterministic-worker-action",
	actionReceiptRef: "event://action/retry-worker",
	actionReceiptDigest: `sha256:${"7".repeat(64)}`,
};

function untrustedRetryAttemptContextForRequest(
	request: GovernedV3RetryRequestV1,
	overrides: Partial<UntrustedAttemptContextRecordedV1> = {},
): UntrustedAttemptContextRecordedV1 {
	const base = {
		runId: request.runId,
		workflowId: request.workflowId,
		workflowRevision: request.workflowRevision,
		unitId: request.unitId,
		priorAttempt: request.priorAttempt,
		nextAttempt: request.nextAttempt,
		priorDispatchEnvelopeDigest: request.priorDispatchEnvelopeDigest,
		priorTerminalEventRef: "event://workflow-terminal/retry-1",
		priorTerminalEventDigest: `sha256:${"8".repeat(64)}`,
		priorActionReceiptRef:
			request.predecessorActions[0]?.actionReceiptRef ?? "",
		priorActionReceiptDigest:
			request.predecessorActions[0]?.actionReceiptDigest ?? "",
		feedbackRef: "cas://retry-feedback/candidate-evidence",
		feedbackDigest: `sha256:${"9".repeat(64)}`,
		nextDispatchEnvelopeDigest: `sha256:${"1".repeat(64)}`,
		nextDispatchIdempotencyKey: "dispatch-v3:2",
		retryActionNamespace: "retry-action:workflow-v3:candidate-unit:2",
		idempotencyKey: "retry-context:workflow-v3:candidate-unit:1:2",
		recordedAt: "2026-07-20T20:00:00.000Z",
		...overrides,
	};
	return {
		...base,
		attemptContextDigest:
			canonicalUntrustedAttemptContextRecordedV1Digest(base),
	};
}

async function runV3RetryHarness(
	governedRetryContextResolverPort?: GovernedV3RetryContextResolverPort,
) {
	const root = mkdtempSync(join(tmpdir(), "buildplane-v3-retry-context-"));
	git(root, ["init", "-q"]);
	git(root, ["config", "user.email", "retry@test.invalid"]);
	git(root, ["config", "user.name", "Retry Test"]);
	writeFileSync(join(root, "base.txt"), "base\n");
	git(root, ["add", "base.txt"]);
	git(root, ["commit", "-qm", "base"]);
	const baseSha = git(root, ["rev-parse", "HEAD"]);
	const commitCountBefore = git(root, ["rev-list", "--count", "HEAD"]);
	const capabilityBundleDigest = GOVERNED_CAPABILITY_BUNDLE_DIGEST;
	const governedDispatch = v3Dispatch(baseSha, capabilityBundleDigest);
	let workerCalls = 0;
	let candidateCalls = 0;
	const actionEvidencePort = {
		recordCandidateCompletion: vi.fn(),
	} as GovernedActionEvidencePort;
	const activityClaimPort = {} as GovernedActivityClaimPort;
	const storage = {
		initializeProject: () => ({
			created: true,
			projectRoot: root,
			stateDbPath: join(root, ".buildplane", "state.db"),
		}),
		createRun: () => ({
			id: RUN_ID,
			unitId: "candidate-unit",
			status: "pending" as const,
		}),
		getChildRuns: () => [],
		markRunRunning: () => {},
		recordExecutionEvidence: () => {},
		recordDecision: () => {},
		completeRun: () => ({
			id: RUN_ID,
			unitId: "candidate-unit",
			status: "passed" as const,
		}),
		recordWorkspacePrepared: () => {},
		commitRunFailureOutcome: () => ({
			id: RUN_ID,
			unitId: "candidate-unit",
			status: "failed" as const,
		}),
		commitRunSuccessOutcome: () => ({
			id: RUN_ID,
			unitId: "candidate-unit",
			status: "passed" as const,
		}),
		commitRunCandidateOutcome: () => ({
			id: RUN_ID,
			unitId: "candidate-unit",
			status: "passed" as const,
		}),
		recordWorkspaceDeleted: () => {},
		recordWorkspaceCleanupFailed: () => {},
		suspendRun: () => ({
			id: RUN_ID,
			unitId: "candidate-unit",
			status: "suspended" as const,
		}),
		approveRun: () => ({
			id: RUN_ID,
			unitId: "candidate-unit",
			status: "pending" as const,
		}),
		rejectSuspendedRun: () => ({
			id: RUN_ID,
			unitId: "candidate-unit",
			status: "failed" as const,
		}),
		getStatusSnapshot: () => ({
			initialized: true,
			latestRunUsedWorkspace: false,
			actionableWorkspaces: [],
			runCounts: {
				pending: 0,
				running: 0,
				passed: 0,
				failed: 0,
				cancelled: 0,
			},
		}),
	} as unknown as BuildplaneStoragePort;
	const workspace: BuildplaneWorkspacePort = {
		governedWorkspaceBoundary: "pinned-governed-git-v1",
		assertRunnableRepository: () => ({ headSha: baseSha }),
		checkWorktreeClean: (path) =>
			git(path, ["status", "--porcelain"]).length === 0,
		prepareWorkspace: () => ({ path: root, headSha: baseSha }),
		async createGovernedWorkspaceCandidate() {
			candidateCalls += 1;
			throw new Error("must not create a candidate after a retry decision");
		},
		deleteWorkspace: () => ({ deleted: true }),
	};
	const governedWorkerExecutionPort: GovernedWorkerExecutionPort = {
		async executeCandidatePacketAsync(input) {
			workerCalls += 1;
			expect(input.governedDispatch).toEqual(governedDispatch);
			return {
				executionReceipt: {
					command: "worker",
					args: [],
					cwd: root,
					startedAt: "2026-07-17T12:00:00.000Z",
					completedAt: "2026-07-17T12:00:01.000Z",
					exitCode: 0,
					stdout: "",
					stderr: "",
					outputChecks: [],
				},
				actionReceipts: [RETRY_WORKER_ACTION],
			};
		},
	};
	const orchestrator = createBuildplaneOrchestrator({
		projectRoot: root,
		storage,
		runtime: {
			executePacket: () => {
				throw new Error("ambient runtime must not execute");
			},
		} as BuildplaneRuntimePort,
		policy: {
			evaluateRun: () => ({
				kind: "retry-run",
				outcome: "retrying",
				reasons: ["exercise retry boundary"],
				attemptNumber: 2,
				feedbackContext: ["retry"],
			}),
			evaluateAcceptanceContract: () => null,
			evaluateAcceptanceDiffScope: () => ({
				status: "passed",
				outOfScopeFiles: [],
			}),
		} as BuildplanePolicyPort,
		workspace,
		admissionStore: {
			writeReceiptArtifact: () => ({
				ref: "artifact://admission",
				path: join(root, "admission.json"),
			}),
			appendAdmissionEvent: () => ({
				ref: "event://admission",
				path: join(root, "events.jsonl"),
			}),
		},
		admittedPlanReader: {
			async read() {
				return {
					authorizedNextStep: "dispatch_admitted_plan",
					signedByKernel: true,
				};
			},
		},
		profileRegistry: {
			resolve: () => ({
				name: "governed",
				trustGates: {
					acceptanceContract: GOVERNED_ACCEPTANCE_CONTRACT,
				},
			}),
		},
		candidateEvidencePort: {} as CandidateEvidencePort,
		governedWorkerExecutionPort,
		governedActionEvidencePort: actionEvidencePort,
		governedActivityClaimPort: activityClaimPort,
		governedRepositoryBindingPort: {
			assertDispatchRepositoryBinding: () => {},
		},
		governedLedgerAuthorityRealmPort: {
			assertDispatchLedgerAuthorityRealm: () => {},
		},
		...(governedRetryContextResolverPort
			? { governedRetryContextResolverPort }
			: {}),
	} as Parameters<typeof createBuildplaneOrchestrator>[0]);
	const result = await orchestrator.runPacketAsync(
		packet({ capability_bundle_digest: capabilityBundleDigest }),
		undefined,
		{
			finalizationMode: "create-candidate",
			candidateIdentity: { candidateId: "retry-blocked", attempt: 1 },
			governedDispatch,
		},
	);
	return {
		result,
		root,
		baseSha,
		commitCountBefore,
		governedDispatch,
		workerCalls,
		candidateCalls,
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

describe("candidate-bound acceptance", () => {
	it("blocks legacy candidate governance before touching any ambient port", async () => {
		const runtime = {
			executePacket: vi.fn(),
			executePacketAsync: vi.fn(),
		};
		const unavailablePort = new Proxy(
			{},
			{
				get() {
					throw new Error(
						"governed execution must fail before touching a port",
					);
				},
			},
		);
		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: "/tmp/buildplane-governed-blocked",
			storage: unavailablePort as BuildplaneStoragePort,
			runtime: runtime as unknown as BuildplaneRuntimePort,
			policy: unavailablePort as BuildplanePolicyPort,
			workspace: unavailablePort as BuildplaneWorkspacePort,
			admissionStore: null,
		});
		const governance: CandidateGovernanceLineage = {
			workflowId: "workflow-blocked",
			provenanceRef: "event://admission/blocked",
			envelopeDigest: ENVELOPE_DIGEST,
			acceptanceContractDigest: GOVERNED_ACCEPTANCE_CONTRACT_DIGEST,
			actionReceiptDigest: ACTION_RECEIPT_DIGEST,
		};

		await expect(
			orchestrator.runPacketAsync(packet(), undefined, {
				finalizationMode: "create-candidate",
				candidateIdentity: { candidateId: "blocked", attempt: 1 },
				candidateGovernance: governance,
			}),
		).rejects.toThrow(/governance fields.*verified sealed_v3 dispatch/i);
		expect(runtime.executePacket).not.toHaveBeenCalled();
		expect(runtime.executePacketAsync).not.toHaveBeenCalled();
	});

	it("blocks V3 candidate execution before the ambient runtime when no OCI action-plane port is configured", async () => {
		const runtime = {
			executePacket: vi.fn(),
			executePacketAsync: vi.fn(),
		};
		const unavailablePort = new Proxy(
			{},
			{
				get() {
					throw new Error(
						"governed execution must fail before touching a port",
					);
				},
			},
		);
		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: "/tmp/buildplane-governed-v3-no-oci",
			storage: unavailablePort as BuildplaneStoragePort,
			runtime: runtime as unknown as BuildplaneRuntimePort,
			policy: unavailablePort as BuildplanePolicyPort,
			workspace: unavailablePort as BuildplaneWorkspacePort,
			admissionStore: null,
		});

		await expect(
			orchestrator.runPacketAsync(packet(), undefined, {
				finalizationMode: "create-candidate",
				candidateIdentity: { candidateId: "blocked-v3", attempt: 1 },
				governedDispatch: v3Dispatch(
					"a".repeat(40),
					GOVERNED_CAPABILITY_BUNDLE_DIGEST,
				),
			}),
		).rejects.toThrow(
			/V3 governed candidate execution requires OCI ActionGateway/i,
		);
		expect(runtime.executePacket).not.toHaveBeenCalled();
		expect(runtime.executePacketAsync).not.toHaveBeenCalled();
	});

	it("fails V3 before any worker effect when durable action evidence is unavailable", async () => {
		const runtime = {
			executePacket: vi.fn(),
			executePacketAsync: vi.fn(),
		};
		const unavailablePort = new Proxy(
			{},
			{
				get() {
					throw new Error("V3 must fail before touching a runtime port");
				},
			},
		);
		const capabilityBundleDigest = GOVERNED_CAPABILITY_BUNDLE_DIGEST;
		const lineage = v3Dispatch("f".repeat(40), capabilityBundleDigest);
		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: "/tmp/buildplane-governed-v3-blocked",
			storage: unavailablePort as BuildplaneStoragePort,
			runtime: runtime as unknown as BuildplaneRuntimePort,
			policy: unavailablePort as BuildplanePolicyPort,
			workspace: unavailablePort as BuildplaneWorkspacePort,
			admissionStore: null,
			governedWorkerExecutionPort: {
				async executeCandidatePacketAsync() {
					throw new Error("must not execute");
				},
			},
		});

		await expect(
			orchestrator.runPacketAsync(
				packet({ capability_bundle_digest: capabilityBundleDigest }),
				undefined,
				{
					finalizationMode: "create-candidate",
					candidateIdentity: { candidateId: "blocked-v3", attempt: 1 },
					governedDispatch: lineage,
				},
			),
		).rejects.toThrow(/durable action evidence/i);
		expect(runtime.executePacket).not.toHaveBeenCalled();
		expect(runtime.executePacketAsync).not.toHaveBeenCalled();
	});

	it("fails V3 before any worker effect when native activity claims are unavailable", async () => {
		const worker = vi.fn();
		const materialize = vi.fn();
		const capabilityBundleDigest = GOVERNED_CAPABILITY_BUNDLE_DIGEST;
		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: "/tmp/buildplane-governed-v3-claim-blocked",
			storage: {
				commitRunCandidateOutcome: vi.fn(),
			} as unknown as BuildplaneStoragePort,
			runtime: {
				executePacket: vi.fn(),
			} as unknown as BuildplaneRuntimePort,
			policy: {} as BuildplanePolicyPort,
			workspace: {
				createGovernedWorkspaceCandidate: materialize,
			} as unknown as BuildplaneWorkspacePort,
			admissionStore: null,
			governedWorkerExecutionPort: {
				async executeCandidatePacketAsync() {
					worker();
					throw new Error("missing native claim must block before a worker");
				},
			},
			governedActionEvidencePort: {} as GovernedActionEvidencePort,
			candidateEvidencePort: {} as CandidateEvidencePort,
		});

		await expect(
			orchestrator.runPacketAsync(
				packet({ capability_bundle_digest: capabilityBundleDigest }),
				undefined,
				{
					finalizationMode: "create-candidate",
					candidateIdentity: { candidateId: "claim-blocked-v3", attempt: 1 },
					governedDispatch: v3Dispatch("f".repeat(40), capabilityBundleDigest),
				},
			),
		).rejects.toThrow(/native activity claims/i);
		expect(worker).not.toHaveBeenCalled();
		expect(materialize).not.toHaveBeenCalled();
	});

	it("fails V3 before any worker effect when candidate completion cannot be recorded", async () => {
		const worker = vi.fn();
		const materialize = vi.fn();
		const capabilityBundleDigest = GOVERNED_CAPABILITY_BUNDLE_DIGEST;
		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: "/tmp/buildplane-governed-v3-completion-blocked",
			storage: {
				commitRunCandidateOutcome: vi.fn(),
			} as unknown as BuildplaneStoragePort,
			runtime: {
				executePacket: vi.fn(),
			} as unknown as BuildplaneRuntimePort,
			policy: {} as BuildplanePolicyPort,
			workspace: {
				governedWorkspaceBoundary: "pinned-governed-git-v1",
				createGovernedWorkspaceCandidate: materialize,
			} as unknown as BuildplaneWorkspacePort,
			admissionStore: null,
			governedWorkerExecutionPort: {
				async executeCandidatePacketAsync() {
					worker();
					throw new Error(
						"missing completion writer must block before a worker",
					);
				},
			},
			governedActionEvidencePort: {
				recordActionRequested: vi.fn(),
				recordActionReceipt: vi.fn(),
				sealActionReceiptSet: vi.fn(),
				recordCandidateCreatedV2: vi.fn(),
			},
			governedActivityClaimPort: {} as GovernedActivityClaimPort,
			governedRepositoryBindingPort: {},
			governedLedgerAuthorityRealmPort: {},
			candidateEvidencePort: {} as CandidateEvidencePort,
		});

		await expect(
			orchestrator.runPacketAsync(
				packet({ capability_bundle_digest: capabilityBundleDigest }),
				undefined,
				{
					finalizationMode: "create-candidate",
					candidateIdentity: {
						candidateId: "completion-blocked-v3",
						attempt: 1,
					},
					governedDispatch: v3Dispatch("f".repeat(40), capabilityBundleDigest),
				},
			),
		).rejects.toThrow(/candidate-completion evidence/i);
		expect(worker).not.toHaveBeenCalled();
		expect(materialize).not.toHaveBeenCalled();
	});

	it("rejects a legacy sealed-v2 V3 dispatch before any worker effect", async () => {
		const runtime = {
			executePacket: vi.fn(),
			executePacketAsync: vi.fn(),
		};
		const unavailablePort = new Proxy(
			{},
			{
				get() {
					throw new Error(
						"legacy dispatch admission must fail before touching a port",
					);
				},
			},
		);
		const capabilityBundleDigest = GOVERNED_CAPABILITY_BUNDLE_DIGEST;
		const legacyLineage = v3Dispatch("f".repeat(40), capabilityBundleDigest, {
			actionEvidenceVersion: "sealed-v2",
		});
		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: "/tmp/buildplane-governed-v3-legacy-evidence",
			storage: unavailablePort as BuildplaneStoragePort,
			runtime: runtime as unknown as BuildplaneRuntimePort,
			policy: unavailablePort as BuildplanePolicyPort,
			workspace: unavailablePort as BuildplaneWorkspacePort,
			admissionStore: null,
			governedWorkerExecutionPort: {
				async executeCandidatePacketAsync() {
					throw new Error("legacy sealed-v2 dispatch must not execute");
				},
			},
		});

		await expect(
			orchestrator.runPacketAsync(
				packet({ capability_bundle_digest: capabilityBundleDigest }),
				undefined,
				{
					finalizationMode: "create-candidate",
					candidateIdentity: {
						candidateId: "legacy-v3-dispatch",
						attempt: 1,
					},
					governedDispatch: legacyLineage,
				},
			),
		).rejects.toThrow(/sealed_v3 activity-claim action evidence/i);
		expect(runtime.executePacket).not.toHaveBeenCalled();
		expect(runtime.executePacketAsync).not.toHaveBeenCalled();
	});

	it("rejects an expired V3 dispatch before it can touch a worker, tape, or workspace", async () => {
		const unavailablePort = new Proxy(
			{},
			{
				get() {
					throw new Error(
						"dispatch validation must fail before touching a port",
					);
				},
			},
		);
		const capabilityBundleDigest = GOVERNED_CAPABILITY_BUNDLE_DIGEST;
		const lineage = v3Dispatch("f".repeat(40), capabilityBundleDigest, {
			issuedAt: "2020-01-01T00:00:00Z",
			expiresAt: "2020-01-01T00:15:00Z",
		});
		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: "/tmp/buildplane-governed-expired",
			storage: unavailablePort as BuildplaneStoragePort,
			runtime: unavailablePort as BuildplaneRuntimePort,
			policy: unavailablePort as BuildplanePolicyPort,
			workspace: unavailablePort as BuildplaneWorkspacePort,
			admissionStore: null,
			governedWorkerExecutionPort: {
				async executeCandidatePacketAsync() {
					throw new Error("expired dispatch must not execute a worker");
				},
			},
			governedActionEvidencePort: unavailablePort as GovernedActionEvidencePort,
			candidateEvidencePort: unavailablePort as CandidateEvidencePort,
		});

		await expect(
			orchestrator.runPacketAsync(
				packet({ capability_bundle_digest: capabilityBundleDigest }),
				undefined,
				{
					finalizationMode: "create-candidate",
					candidateIdentity: { candidateId: "expired-v3", attempt: 1 },
					governedDispatch: lineage,
				},
			),
		).rejects.toThrow(/expired/i);
	});

	it("requires native-compatible RFC3339 UTC dispatch times before any worker effect", async () => {
		const unavailablePort = new Proxy(
			{},
			{
				get() {
					throw new Error(
						"dispatch timestamp validation must fail before touching a port",
					);
				},
			},
		);
		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: "/tmp/buildplane-governed-invalid-time",
			storage: unavailablePort as BuildplaneStoragePort,
			runtime: unavailablePort as BuildplaneRuntimePort,
			policy: unavailablePort as BuildplanePolicyPort,
			workspace: unavailablePort as BuildplaneWorkspacePort,
			admissionStore: null,
			governedWorkerExecutionPort: {
				async executeCandidatePacketAsync() {
					throw new Error("invalid dispatch time must not execute a worker");
				},
			},
			governedActionEvidencePort: unavailablePort as GovernedActionEvidencePort,
			candidateEvidencePort: unavailablePort as CandidateEvidencePort,
		});

		await expect(
			orchestrator.runPacketAsync(packet(), undefined, {
				finalizationMode: "create-candidate",
				candidateIdentity: { candidateId: "invalid-time", attempt: 1 },
				governedDispatch: v3Dispatch(
					"f".repeat(40),
					GOVERNED_CAPABILITY_BUNDLE_DIGEST,
					{ issuedAt: "2099-02-31T12:00:00Z" },
				),
			}),
		).rejects.toThrow(/RFC3339 UTC/i);
	});

	it("requires packet-bound acceptance, trust, and capability authority before a V3 worker effect", async () => {
		const unavailablePort = new Proxy(
			{},
			{
				get() {
					throw new Error(
						"strict governed admission must fail before touching a port",
					);
				},
			},
		);
		const worker = vi.fn();
		const governedDispatch = v3Dispatch(
			"f".repeat(40),
			GOVERNED_CAPABILITY_BUNDLE_DIGEST,
		);
		const malformedPackets: readonly [string, Partial<UnitPacket>][] = [
			["acceptance contract", { acceptance_contract: undefined }],
			["trust scope", { trust_scope: undefined }],
			[
				"capability authority",
				{
					capability_bundle: undefined,
					capability_bundle_digest: undefined,
				},
			],
		];

		for (const [label, overrides] of malformedPackets) {
			const orchestrator = createBuildplaneOrchestrator({
				projectRoot: `/tmp/buildplane-governed-${label}`,
				storage: unavailablePort as BuildplaneStoragePort,
				runtime: unavailablePort as BuildplaneRuntimePort,
				policy: unavailablePort as BuildplanePolicyPort,
				workspace: unavailablePort as BuildplaneWorkspacePort,
				admissionStore: null,
				governedWorkerExecutionPort: {
					async executeCandidatePacketAsync() {
						worker();
						throw new Error("malformed governed packet must not execute");
					},
				},
				governedActionEvidencePort:
					unavailablePort as GovernedActionEvidencePort,
				candidateEvidencePort: unavailablePort as CandidateEvidencePort,
			});

			await expect(
				orchestrator.runPacketAsync(packet(overrides), undefined, {
					finalizationMode: "create-candidate",
					candidateIdentity: { candidateId: `missing-${label}`, attempt: 1 },
					governedDispatch,
				}),
			).rejects.toThrow(/strictly admitted packet/i);
		}

		expect(worker).not.toHaveBeenCalled();
	});

	it("rejects a V3 envelope whose acceptance digest does not bind the packet", async () => {
		const unavailablePort = new Proxy(
			{},
			{
				get() {
					throw new Error(
						"acceptance digest mismatch must fail before touching a port",
					);
				},
			},
		);
		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: "/tmp/buildplane-governed-acceptance-digest",
			storage: unavailablePort as BuildplaneStoragePort,
			runtime: unavailablePort as BuildplaneRuntimePort,
			policy: unavailablePort as BuildplanePolicyPort,
			workspace: unavailablePort as BuildplaneWorkspacePort,
			admissionStore: null,
			governedWorkerExecutionPort: {
				async executeCandidatePacketAsync() {
					throw new Error("mismatched acceptance digest must not execute");
				},
			},
			governedActionEvidencePort: unavailablePort as GovernedActionEvidencePort,
			candidateEvidencePort: unavailablePort as CandidateEvidencePort,
		});

		await expect(
			orchestrator.runPacketAsync(
				packet({
					acceptance_contract: {
						...GOVERNED_ACCEPTANCE_CONTRACT,
						checks: [{ command: "different-check" }],
					},
				}),
				undefined,
				{
					finalizationMode: "create-candidate",
					candidateIdentity: {
						candidateId: "acceptance-digest-mismatch",
						attempt: 1,
					},
					governedDispatch: v3Dispatch(
						"f".repeat(40),
						GOVERNED_CAPABILITY_BUNDLE_DIGEST,
					),
				},
			),
		).rejects.toThrow(/acceptance contract digest/i);
	});

	it("fails a V3 retry closed when no structural retry-context resolver is available", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-v3-retry-blocked-"));
		try {
			git(root, ["init", "-q"]);
			git(root, ["config", "user.email", "retry@test.invalid"]);
			git(root, ["config", "user.name", "Retry Test"]);
			writeFileSync(join(root, "base.txt"), "base\n");
			git(root, ["add", "base.txt"]);
			git(root, ["commit", "-qm", "base"]);
			const baseSha = git(root, ["rev-parse", "HEAD"]);
			const commitCountBefore = git(root, ["rev-list", "--count", "HEAD"]);
			const capabilityBundleDigest = GOVERNED_CAPABILITY_BUNDLE_DIGEST;
			const governedDispatch = v3Dispatch(baseSha, capabilityBundleDigest);
			let workerCalls = 0;
			let candidateCalls = 0;
			const actionEvidencePort = {
				recordCandidateCompletion: vi.fn(),
			} as GovernedActionEvidencePort;
			const activityClaimPort = {} as GovernedActivityClaimPort;
			const storage = {
				initializeProject: () => ({
					created: true,
					projectRoot: root,
					stateDbPath: join(root, ".buildplane", "state.db"),
				}),
				createRun: () => ({
					id: RUN_ID,
					unitId: "candidate-unit",
					status: "pending" as const,
				}),
				getChildRuns: () => [],
				markRunRunning: () => {},
				recordExecutionEvidence: () => {},
				recordDecision: () => {},
				completeRun: () => ({
					id: RUN_ID,
					unitId: "candidate-unit",
					status: "passed" as const,
				}),
				recordWorkspacePrepared: () => {},
				commitRunFailureOutcome: () => ({
					id: RUN_ID,
					unitId: "candidate-unit",
					status: "failed" as const,
				}),
				commitRunSuccessOutcome: () => ({
					id: RUN_ID,
					unitId: "candidate-unit",
					status: "passed" as const,
				}),
				commitRunCandidateOutcome: () => ({
					id: RUN_ID,
					unitId: "candidate-unit",
					status: "passed" as const,
				}),
				recordWorkspaceDeleted: () => {},
				recordWorkspaceCleanupFailed: () => {},
				suspendRun: () => ({
					id: RUN_ID,
					unitId: "candidate-unit",
					status: "suspended" as const,
				}),
				approveRun: () => ({
					id: RUN_ID,
					unitId: "candidate-unit",
					status: "pending" as const,
				}),
				rejectSuspendedRun: () => ({
					id: RUN_ID,
					unitId: "candidate-unit",
					status: "failed" as const,
				}),
				getStatusSnapshot: () => ({
					initialized: true,
					latestRunUsedWorkspace: false,
					actionableWorkspaces: [],
					runCounts: {
						pending: 0,
						running: 0,
						passed: 0,
						failed: 0,
						cancelled: 0,
					},
				}),
			} as unknown as BuildplaneStoragePort;
			const workspace: BuildplaneWorkspacePort = {
				governedWorkspaceBoundary: "pinned-governed-git-v1",
				assertRunnableRepository: () => ({ headSha: baseSha }),
				checkWorktreeClean: (path) =>
					git(path, ["status", "--porcelain"]).length === 0,
				prepareWorkspace: () => ({ path: root, headSha: baseSha }),
				async createGovernedWorkspaceCandidate() {
					candidateCalls += 1;
					throw new Error("must not create a candidate after a retry decision");
				},
				deleteWorkspace: () => ({ deleted: true }),
			};
			const governedWorkerExecutionPort: GovernedWorkerExecutionPort = {
				async executeCandidatePacketAsync(input) {
					workerCalls += 1;
					expect(input.governedDispatch).toEqual(governedDispatch);
					return {
						executionReceipt: {
							command: "worker",
							args: [],
							cwd: root,
							startedAt: "2026-07-17T12:00:00.000Z",
							completedAt: "2026-07-17T12:00:01.000Z",
							exitCode: 0,
							stdout: "",
							stderr: "",
							outputChecks: [],
						},
						actionReceipts: [
							{
								actionId: "deterministic-worker-action",
								actionReceiptRef: "event://action/retry-worker",
								actionReceiptDigest: `sha256:${"7".repeat(64)}`,
							},
						],
					};
				},
			};
			const orchestrator = createBuildplaneOrchestrator({
				projectRoot: root,
				storage,
				runtime: {
					executePacket: () => {
						throw new Error("ambient runtime must not execute");
					},
				} as BuildplaneRuntimePort,
				policy: {
					evaluateRun: () => ({
						kind: "retry-run",
						outcome: "retrying",
						reasons: ["exercise retry boundary"],
						attemptNumber: 1,
						feedbackContext: ["retry"],
					}),
					evaluateAcceptanceContract: () => null,
					evaluateAcceptanceDiffScope: () => ({
						status: "passed",
						outOfScopeFiles: [],
					}),
				} as BuildplanePolicyPort,
				workspace,
				admissionStore: {
					writeReceiptArtifact: () => ({
						ref: "artifact://admission",
						path: join(root, "admission.json"),
					}),
					appendAdmissionEvent: () => ({
						ref: "event://admission",
						path: join(root, "events.jsonl"),
					}),
				},
				admittedPlanReader: {
					async read() {
						return {
							authorizedNextStep: "dispatch_admitted_plan",
							signedByKernel: true,
						};
					},
				},
				profileRegistry: {
					resolve: () => ({
						name: "governed",
						trustGates: {
							acceptanceContract: GOVERNED_ACCEPTANCE_CONTRACT,
						},
					}),
				},
				candidateEvidencePort: {} as CandidateEvidencePort,
				governedWorkerExecutionPort,
				governedActionEvidencePort: actionEvidencePort,
				governedActivityClaimPort: activityClaimPort,
				governedRepositoryBindingPort: {
					assertDispatchRepositoryBinding: () => {},
				},
				governedLedgerAuthorityRealmPort: {
					assertDispatchLedgerAuthorityRealm: () => {},
				},
			});

			const result = await orchestrator.runPacketAsync(
				packet({ capability_bundle_digest: capabilityBundleDigest }),
				undefined,
				{
					finalizationMode: "create-candidate",
					candidateIdentity: { candidateId: "retry-blocked", attempt: 1 },
					governedDispatch,
				},
			);

			expect(result.run.status).toBe("failed");
			expect(result.failure).toMatchObject({
				kind: "governed-v3-retry-context-resolver-unavailable",
			});
			expect(workerCalls).toBe(1);
			expect(candidateCalls).toBe(0);
			expect(git(root, ["rev-parse", "HEAD"])).toBe(baseSha);
			expect(git(root, ["rev-list", "--count", "HEAD"])).toBe(
				commitCountBefore,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not re-execute a V3 worker when the structural resolver returns no context", async () => {
		const resolveUntrustedAttemptContext = vi.fn(async () => undefined);
		const harness = await runV3RetryHarness({
			resolveUntrustedAttemptContext,
		});
		try {
			expect(harness.result.run.status).toBe("failed");
			expect(harness.result.failure).toMatchObject({
				kind: "governed-v3-retry-context-resolver-no-response",
			});
			expect(resolveUntrustedAttemptContext).toHaveBeenCalledTimes(1);
			expect(harness.workerCalls).toBe(1);
			expect(harness.candidateCalls).toBe(0);
			expect(git(harness.root, ["rev-parse", "HEAD"])).toBe(harness.baseSha);
			expect(git(harness.root, ["rev-list", "--count", "HEAD"])).toBe(
				harness.commitCountBefore,
			);
		} finally {
			harness.cleanup();
		}
	});

	it("does not re-execute a V3 worker when the structural response is malformed", async () => {
		const resolveUntrustedAttemptContext = vi.fn(
			async () =>
				({
					schemaVersion: 1,
					retryRequestDigest: "not-a-digest",
				}) as unknown as Awaited<
					ReturnType<
						GovernedV3RetryContextResolverPort["resolveUntrustedAttemptContext"]
					>
				>,
		);
		const harness = await runV3RetryHarness({
			resolveUntrustedAttemptContext,
		});
		try {
			expect(harness.result.failure).toMatchObject({
				kind: "governed-v3-retry-context-structural-malformed",
			});
			expect(resolveUntrustedAttemptContext).toHaveBeenCalledTimes(1);
			expect(harness.workerCalls).toBe(1);
			expect(harness.candidateCalls).toBe(0);
			expect(git(harness.root, ["rev-parse", "HEAD"])).toBe(harness.baseSha);
			expect(git(harness.root, ["rev-list", "--count", "HEAD"])).toBe(
				harness.commitCountBefore,
			);
		} finally {
			harness.cleanup();
		}
	});

	it("does not re-execute a V3 worker when untrusted context mismatches its predecessor action", async () => {
		const resolveUntrustedAttemptContext = vi.fn(async (request) => {
			const context = untrustedRetryAttemptContextForRequest(request, {
				priorActionReceiptRef: "event://action/substituted",
			});
			return {
				schemaVersion: 1 as const,
				retryRequestDigest: canonicalGovernedV3RetryRequestV1Digest(request),
				predecessorAction: {
					...request.predecessorActions[0],
					actionReceiptRef: "event://action/substituted",
				},
				untrustedAttemptContext: context,
			};
		});
		const harness = await runV3RetryHarness({
			resolveUntrustedAttemptContext,
		});
		try {
			expect(harness.result.failure).toMatchObject({
				kind: "governed-v3-retry-context-structural-mismatch",
			});
			expect(resolveUntrustedAttemptContext).toHaveBeenCalledTimes(1);
			expect(harness.workerCalls).toBe(1);
			expect(harness.candidateCalls).toBe(0);
			expect(git(harness.root, ["rev-parse", "HEAD"])).toBe(harness.baseSha);
			expect(git(harness.root, ["rev-list", "--count", "HEAD"])).toBe(
				harness.commitCountBefore,
			);
		} finally {
			harness.cleanup();
		}
	});

	it("blocks structurally consistent but untrusted context before a second V3 worker call", async () => {
		const resolveUntrustedAttemptContext = vi.fn(async (request) => {
			const predecessorAction = request.predecessorActions[0];
			if (!predecessorAction) {
				throw new Error("expected a durable first-attempt action receipt");
			}
			expect(Object.isFrozen(request)).toBe(true);
			expect(Object.isFrozen(request.predecessorActions)).toBe(true);
			expect(request).toMatchObject({
				runId: RUN_ID,
				workflowId: "workflow-v3",
				workflowRevision: "revision-v3",
				unitId: "candidate-unit",
				priorAttempt: 1,
				nextAttempt: 2,
				priorDispatchEnvelopeDigest: ENVELOPE_DIGEST,
				predecessorActions: [RETRY_WORKER_ACTION],
			});
			return {
				schemaVersion: 1 as const,
				retryRequestDigest: canonicalGovernedV3RetryRequestV1Digest(request),
				predecessorAction,
				untrustedAttemptContext:
					untrustedRetryAttemptContextForRequest(request),
			};
		});
		const harness = await runV3RetryHarness({
			resolveUntrustedAttemptContext,
		});
		try {
			expect(harness.result.failure).toMatchObject({
				kind: "governed-v3-retry-native-attestation-required",
			});
			expect(resolveUntrustedAttemptContext).toHaveBeenCalledTimes(1);
			expect(harness.workerCalls).toBe(1);
			expect(harness.candidateCalls).toBe(0);
			expect(git(harness.root, ["rev-parse", "HEAD"])).toBe(harness.baseSha);
			expect(git(harness.root, ["rev-list", "--count", "HEAD"])).toBe(
				harness.commitCountBefore,
			);
		} finally {
			harness.cleanup();
		}
	});

	it("fails closed before effects when storage returns a run ID that differs from the signed candidate dispatch", async () => {
		const capabilityBundleDigest = GOVERNED_CAPABILITY_BUNDLE_DIGEST;
		const baseSha = "f".repeat(40);
		const storageRunId = "storage-returned-other-run-id";
		const governedDispatch = v3Dispatch(baseSha, capabilityBundleDigest);
		const runtime = {
			executePacket: vi.fn(),
			executePacketAsync: vi.fn(),
		};
		const prepareWorkspace = vi.fn();
		const materializeCandidate = vi.fn();
		const executeGovernedWorker = vi.fn();
		const createRun = vi.fn(() => ({
			id: storageRunId,
			unitId: "candidate-unit",
			status: "pending" as const,
		}));
		const commitRunFailureOutcome = vi.fn((runId: string) => ({
			id: runId,
			unitId: "candidate-unit",
			status: "failed" as const,
		}));
		const storage = {
			getStatusSnapshot: vi.fn(() => ({
				initialized: true,
				latestRunUsedWorkspace: false,
				actionableWorkspaces: [],
				runCounts: {
					pending: 0,
					running: 0,
					passed: 0,
					failed: 0,
					cancelled: 0,
				},
			})),
			createRun,
			commitRunFailureOutcome,
			commitRunCandidateOutcome: vi.fn(),
		} as unknown as BuildplaneStoragePort;
		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: "/tmp/buildplane-signed-run-id-mismatch",
			storage,
			runtime: runtime as unknown as BuildplaneRuntimePort,
			policy: {} as BuildplanePolicyPort,
			workspace: {
				governedWorkspaceBoundary: "pinned-governed-git-v1",
				assertRunnableRepository: vi.fn(() => ({ headSha: baseSha })),
				prepareWorkspace,
				createGovernedWorkspaceCandidate: materializeCandidate,
			} as unknown as BuildplaneWorkspacePort,
			admissionStore: null,
			governedWorkerExecutionPort: {
				executeCandidatePacketAsync: executeGovernedWorker,
			} as unknown as GovernedWorkerExecutionPort,
			governedActionEvidencePort: {
				recordCandidateCompletion: vi.fn(),
			} as unknown as GovernedActionEvidencePort,
			governedActivityClaimPort: {} as GovernedActivityClaimPort,
			candidateEvidencePort: {} as CandidateEvidencePort,
			governedRepositoryBindingPort: {
				assertDispatchRepositoryBinding: vi.fn(),
			},
			governedLedgerAuthorityRealmPort: {
				assertDispatchLedgerAuthorityRealm: vi.fn(),
			},
		});

		expect(orchestrator.runCandidatePacketAsync).toBeDefined();
		const result = await orchestrator.runCandidatePacketAsync!(
			packet({ capability_bundle_digest: capabilityBundleDigest }),
			{ candidateId: "signed-run-id-mismatch", attempt: 1 },
			undefined,
			governedDispatch,
		);

		expect(createRun).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				finalizationMode: "create-candidate",
				governedDispatch,
				runId: RUN_ID,
				trustLane: "governed",
			}),
		);
		expect(result.run).toMatchObject({
			id: storageRunId,
			status: "failed",
		});
		expect(result.failure?.kind).toBe("governed-dispatch-lineage-invalid");
		expect(commitRunFailureOutcome).toHaveBeenCalledWith(
			storageRunId,
			expect.objectContaining({
				infrastructureFailure: expect.objectContaining({
					kind: "governed-dispatch-lineage-invalid",
				}),
			}),
		);
		expect(prepareWorkspace).not.toHaveBeenCalled();
		expect(materializeCandidate).not.toHaveBeenCalled();
		expect(executeGovernedWorker).not.toHaveBeenCalled();
		expect(runtime.executePacket).not.toHaveBeenCalled();
		expect(runtime.executePacketAsync).not.toHaveBeenCalled();
	});

	it("starts a sealed candidate run under its signed ID before freezing it for acceptance", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-candidate-flow-"));
		const events: string[] = [];
		let frozen: WorkspaceCandidateArtifact | undefined;
		let createdRunId: string | undefined;
		try {
			git(root, ["init", "-q"]);
			git(root, ["config", "user.email", "candidate@test.invalid"]);
			git(root, ["config", "user.name", "Candidate Test"]);
			writeFileSync(join(root, "base.txt"), "base\n");
			git(root, ["add", "base.txt"]);
			git(root, ["commit", "-qm", "base"]);
			const baseSha = git(root, ["rev-parse", "HEAD"]);
			const workspacePath = join(root, ".buildplane", "workspaces", RUN_ID);
			mkdirSync(join(root, ".buildplane", "workspaces"), { recursive: true });
			git(root, ["worktree", "add", "--detach", workspacePath, baseSha]);

			const storage = {
				initializeProject: () => ({
					created: true,
					projectRoot: root,
					stateDbPath: join(root, ".buildplane", "state.db"),
				}),
				createRun: (
					_packet: UnitPacket,
					options?: { readonly runId?: string },
				) => {
					createdRunId = options?.runId;
					return {
						id: options?.runId ?? "storage-generated-run-id",
						unitId: "candidate-unit",
						status: "pending" as const,
					};
				},
				getChildRuns: () => [],
				markRunRunning: () => {},
				recordExecutionEvidence: () => {},
				recordDecision: () => {},
				completeRun: () => ({
					id: RUN_ID,
					unitId: "candidate-unit",
					status: "passed" as const,
				}),
				recordWorkspacePrepared: () => {},
				commitRunFailureOutcome: () => ({
					id: RUN_ID,
					unitId: "candidate-unit",
					status: "failed" as const,
				}),
				commitRunSuccessOutcome: () => ({
					id: RUN_ID,
					unitId: "candidate-unit",
					status: "passed" as const,
				}),
				recordAcceptanceShadow: () => {},
				commitRunCandidateOutcome: (_runId: string, input: unknown) => {
					events.push("persist-candidate");
					expect(input).toMatchObject({
						candidate: expect.objectContaining({
							candidateCommitSha: frozen?.candidateCommitSha,
							actionEvidenceVersion: "sealed_v3",
						}),
					});
					return {
						id: RUN_ID,
						unitId: "candidate-unit",
						status: "passed" as const,
					};
				},
				recordWorkspaceDeleted: () => {},
				recordWorkspaceCleanupFailed: () => {},
				suspendRun: () => ({
					id: RUN_ID,
					unitId: "candidate-unit",
					status: "suspended" as const,
				}),
				approveRun: () => ({
					id: RUN_ID,
					unitId: "candidate-unit",
					status: "pending" as const,
				}),
				rejectSuspendedRun: () => ({
					id: RUN_ID,
					unitId: "candidate-unit",
					status: "failed" as const,
				}),
				getStatusSnapshot: () => ({
					initialized: true,
					latestRunUsedWorkspace: false,
					actionableWorkspaces: [],
					runCounts: {
						pending: 0,
						running: 0,
						passed: 0,
						failed: 0,
						cancelled: 0,
					},
				}),
				inspectTarget: () => {
					throw new Error("unused");
				},
			} as unknown as BuildplaneStoragePort;

			const runtime: BuildplaneRuntimePort = {
				executePacket: () => {
					events.push("execute");
					writeFileSync(join(workspacePath, "candidate.txt"), "candidate\n");
					return {
						command: "ignored",
						args: [],
						cwd: workspacePath,
						startedAt: "2026-07-17T12:00:00.000Z",
						completedAt: "2026-07-17T12:00:01.000Z",
						exitCode: 0,
						stdout: "",
						stderr: "",
						outputChecks: [],
					};
				},
			};

			const policy: BuildplanePolicyPort = {
				evaluateRun: () => {
					events.push("policy");
					return { kind: "advance-run", outcome: "approved", reasons: [] };
				},
				evaluateAcceptanceContract: () => null,
				evaluateAcceptanceDiffScope: () => ({
					status: "passed",
					outOfScopeFiles: [],
				}),
			};

			const workspace: BuildplaneWorkspacePort = {
				governedWorkspaceBoundary: "pinned-governed-git-v1",
				assertRunnableRepository: () => ({
					headSha: git(root, ["rev-parse", "HEAD"]),
				}),
				checkWorktreeClean: (path) =>
					git(path, ["status", "--porcelain"]).length === 0,
				prepareWorkspace: () => ({ path: workspacePath, headSha: baseSha }),
				async createGovernedWorkspaceCandidate(input) {
					events.push("materialize-git");
					expect(input.governedDispatch.workflowId).toBe("workflow-v3");
					expect(input.actionEvidencePort).toBe(actionEvidencePort);
					expect(input.activityClaimPort).toBe(activityClaimPort);
					git(workspacePath, ["add", "--all"]);
					git(workspacePath, ["commit", "-qm", "candidate"]);
					frozen = candidate(
						baseSha,
						git(workspacePath, ["rev-parse", "HEAD"]),
					);
					return {
						candidate: frozen,
						actionReceipt: {
							actionId: "git-candidate-create:candidate-flow/run/1",
							actionReceiptRef: "event://action/candidate-git",
							actionReceiptDigest: `sha256:${"8".repeat(64)}`,
						},
						candidateCreateActionEvidence: {
							actionId: "git-candidate-create:candidate-flow/run/1",
							actionRequestRef: "event://action-request/candidate-git",
							actionRequestDigest: `sha256:${"1".repeat(64)}`,
							activityClaimEventRef: "event://activity-claim/candidate-git",
							activityClaimEventDigest: `sha256:${"2".repeat(64)}`,
							activityResultEventRef: "event://activity-result/candidate-git",
							activityResultEventDigest: `sha256:${"3".repeat(64)}`,
							actionReceiptRef: "event://action/candidate-git",
							actionReceiptDigest: `sha256:${"8".repeat(64)}`,
						},
					};
				},
				deleteWorkspace: () => ({ deleted: true }),
			};

			const acceptanceEvidencePort: BuildplaneAcceptanceEvidencePort = {
				collectCheckResults: () => {
					events.push("check");
					expect(git(workspacePath, ["rev-parse", "HEAD"])).toBe(
						frozen?.candidateCommitSha,
					);
					return [{ command: "candidate-check", exitCode: 0 }];
				},
			};

			const candidateEvidencePort: CandidateEvidencePort = {
				async recordCandidateAcceptance(input) {
					events.push("candidate-acceptance");
					expect(input.candidate.candidateCommitSha).toBe(
						frozen?.candidateCommitSha,
					);
					expect(input.acceptanceContractDigest).toBe(
						GOVERNED_ACCEPTANCE_CONTRACT_DIGEST,
					);
					return {
						candidateDigest: `sha256:${CANDIDATE_DIGEST}`,
						candidateCommitSha: input.candidate.candidateCommitSha,
						acceptanceContractDigest: input.acceptanceContractDigest,
						acceptanceRef: "event://candidate-acceptance/1",
						outcome: input.outcome,
					};
				},
				async recordCandidateReview() {
					throw new Error("unused");
				},
			};

			const capabilityBundleDigest = GOVERNED_CAPABILITY_BUNDLE_DIGEST;
			const governedDispatch = v3Dispatch(baseSha, capabilityBundleDigest);
			const activityClaimPort = {} as GovernedActivityClaimPort;
			const actionEvidencePort: GovernedActionEvidencePort = {
				async recordActionRequested(input) {
					return {
						actionRequest: input,
						actionRequestRef: "event://action-request/unused",
						actionRequestDigest: `sha256:${"1".repeat(64)}`,
					};
				},
				async recordActionReceipt(input) {
					return {
						receipt: {
							...input,
							actionReceiptRef: "event://action-receipt/unused",
						},
						actionReceiptDigest: `sha256:${"2".repeat(64)}`,
					};
				},
				async sealActionReceiptSet(input) {
					events.push("seal-action-set");
					expect(input.receipts.map((receipt) => receipt.actionId)).toEqual([
						"git-candidate-create:candidate-flow/run/1",
						"worker-action",
					]);
					const withoutDigest = {
						schemaVersion: 1 as const,
						...input,
						actionReceiptSetRef: "event://action-set/1",
					};
					return {
						...withoutDigest,
						actionReceiptSetDigest:
							canonicalActionReceiptSetRecordedV1Digest(withoutDigest),
					};
				},
				async recordCandidateCreatedV2(input) {
					events.push("candidate-created-v2");
					expect(input.actionReceiptSetRef).toBe("event://action-set/1");
					expect("actionReceiptDigest" in input).toBe(false);
					return "event://candidate-created/1";
				},
				async recordCandidateCompletion(input) {
					events.push("candidate-completion");
					expect(input.candidateCreatedEventRef).toBe(
						"event://candidate-created/1",
					);
					expect(input.candidateCreateActionId).toBe(
						"git-candidate-create:candidate-flow/run/1",
					);
					expect(input.activityResultEventRef).toBe(
						"event://activity-result/candidate-git",
					);
					return {
						candidateCompletionRef: "event://candidate-completion/1",
						completionDigest: input.completionDigest,
					};
				},
			};
			const governedWorkerExecutionPort: GovernedWorkerExecutionPort = {
				async executeCandidatePacketAsync(input) {
					expect(input.runId).toBe(RUN_ID);
					expect(input.packet.execution_role).toBe("implementer");
					expect(input.governedDispatch).toEqual(governedDispatch);
					expect(input.actionEvidencePort).toBe(actionEvidencePort);
					return {
						executionReceipt: runtime.executePacket(
							input.packet,
							input.projectRoot,
						),
						actionReceipts: [
							{
								actionId: "worker-action",
								actionReceiptRef: "event://action/worker",
								actionReceiptDigest: `sha256:${"7".repeat(64)}`,
							},
						],
					};
				},
			};
			const orchestrator = createBuildplaneOrchestrator({
				projectRoot: root,
				storage,
				runtime,
				policy,
				workspace,
				admissionStore: {
					writeReceiptArtifact: () => ({
						ref: "artifact://admission",
						path: join(root, "admission.json"),
					}),
					appendAdmissionEvent: () => ({
						ref: "event://admission",
						path: join(root, "events.jsonl"),
					}),
				},
				admittedPlanReader: {
					async read() {
						return {
							authorizedNextStep: "dispatch_admitted_plan",
							signedByKernel: true,
						};
					},
				},
				profileRegistry: {
					resolve: () => ({
						name: "governed",
						trustGates: {
							acceptanceContract: GOVERNED_ACCEPTANCE_CONTRACT,
						},
					}),
				},
				acceptanceEvidencePort,
				candidateEvidencePort,
				governedWorkerExecutionPort,
				governedActionEvidencePort: actionEvidencePort,
				governedActivityClaimPort: activityClaimPort,
				governedRepositoryBindingPort: {
					assertDispatchRepositoryBinding: () => {},
				},
				governedLedgerAuthorityRealmPort: {
					assertDispatchLedgerAuthorityRealm: () => {},
				},
			});

			const runCandidatePacketAsync = orchestrator.runCandidatePacketAsync;
			expect(runCandidatePacketAsync).toBeDefined();
			const result = await runCandidatePacketAsync!(
				packet({ capability_bundle_digest: capabilityBundleDigest }),
				{ candidateId: "candidate-flow", attempt: 1 },
				undefined,
				governedDispatch,
			);

			expect(result.run.status).toBe("passed");
			expect(createdRunId).toBe(RUN_ID);
			expect(result.run.id).toBe(RUN_ID);
			expect(result.candidate?.candidateCommitSha).toBe(
				frozen?.candidateCommitSha,
			);
			expect(result.candidateAcceptance).toEqual({
				candidateDigest: `sha256:${CANDIDATE_DIGEST}`,
				candidateCommitSha: frozen?.candidateCommitSha,
				acceptanceContractDigest: GOVERNED_ACCEPTANCE_CONTRACT_DIGEST,
				acceptanceRef: "event://candidate-acceptance/1",
				outcome: "passed",
			});
			expect(events).toEqual([
				"execute",
				"policy",
				"materialize-git",
				"seal-action-set",
				"candidate-created-v2",
				"candidate-completion",
				"check",
				"candidate-acceptance",
				"persist-candidate",
			]);
			expect(git(root, ["rev-parse", "HEAD"])).toBe(baseSha);

			const eventsBeforeSynchronousAttempt = [...events];
			const syncResult = orchestrator.runPacket(
				packet({ capability_bundle_digest: capabilityBundleDigest }),
				undefined,
				{
					finalizationMode: "create-candidate",
					candidateIdentity: { candidateId: "candidate-flow", attempt: 2 },
					governedDispatch,
					runId: RUN_ID,
				},
			);
			expect(syncResult.run.status).toBe("failed");
			expect(syncResult.failure?.kind).toBe(
				"governed-candidate-async-required",
			);
			expect(events).toEqual(eventsBeforeSynchronousAttempt);
			expect(git(root, ["rev-parse", "HEAD"])).toBe(baseSha);

			await expect(
				orchestrator.runPacketAsync(
					packet({ capability_bundle_digest: capabilityBundleDigest }),
					undefined,
					{
						candidateIdentity: {
							candidateId: "candidate-flow",
							attempt: 3,
						},
						governedDispatch,
					},
				),
			).rejects.toThrow(/V3 governed dispatch requires finalizationMode/i);
			expect(events).toEqual(eventsBeforeSynchronousAttempt);
			expect(git(root, ["rev-parse", "HEAD"])).toBe(baseSha);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
