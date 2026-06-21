import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
	AcceptanceCheckResult,
	AcceptanceContractV0,
	AcceptanceDiffScopeResult,
	AcceptanceEvidence,
	AcceptanceRecordInput,
	BuildplanePolicyPort,
	BuildplaneRuntimePort,
	BuildplaneStoragePort,
	BuildplaneWorkspacePort,
	ExecutionReceipt,
	InspectSnapshot,
	PolicyDecision,
	PolicyProfile,
	RunAdmissionLocalEvidenceStore,
	StatusSnapshot,
	UnitPacket,
	WorkspaceSnapshot,
} from "@buildplane/kernel";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { validationEvents } = vi.hoisted(() => ({
	validationEvents: [] as string[],
}));

vi.mock("../src/workspace-paths.js", async () => {
	const actual = await vi.importActual<
		typeof import("../src/workspace-paths.js")
	>("../src/workspace-paths.js");

	return {
		...actual,
		validatePacketForWorkspaceRoot(packet: UnitPacket, workspaceRoot: string) {
			validationEvents.push("validate-packet-for-workspace-root");
			return actual.validatePacketForWorkspaceRoot(packet, workspaceRoot);
		},
	};
});

import { createBuildplaneOrchestrator } from "../src/orchestrator";

const packet: UnitPacket = {
	unit: {
		id: "unit-1",
		kind: "command",
		scope: "task",
		inputRefs: [],
		expectedOutputs: ["tmp/out.txt"],
		verificationContract: "exit-0-and-required-outputs",
		policyProfile: "default",
	},
	execution: {
		command: "node",
		cwd: "nested/../nested",
	},
	verification: {
		requiredOutputs: ["tmp/out.txt"],
	},
};

type FailurePoint =
	| "prepareWorkspace"
	| "recordWorkspacePrepared"
	| "markRunRunning"
	| "runtime"
	| "recordExecutionEvidence"
	| "policy"
	| "commitRunFailureOutcome"
	| "commitRunSuccessOutcome"
	| "recordWorkspaceDeleted"
	| "recordWorkspaceCleanupFailed"
	| "deleteWorkspace";

interface HarnessOptions {
	readonly policyOutcome?: PolicyDecision["outcome"];
	readonly throwOn?: readonly FailurePoint[];
	readonly deleteResult?: {
		readonly deleted: boolean;
		readonly cleanupError?: string;
	};
	readonly inspectWorkspace?: WorkspaceSnapshot;
	readonly acceptanceEvidence?: AcceptanceEvidence;
	readonly trustedAcceptanceCheckResults?: readonly AcceptanceCheckResult[];
	readonly policyDecisions?: readonly PolicyDecision[];
	readonly omitAcceptanceEvaluator?: boolean;
	readonly policyProfile?: PolicyProfile;
	readonly withAcceptancePort?: boolean;
	readonly diffScope?: AcceptanceDiffScopeResult;
	/** Initialize the workspace path as a real git repo so changedFiles capture
	 * reflects on-disk mutations (lets a check mutate the worktree). */
	readonly gitWorkspace?: boolean;
	/** Relative paths a simulated acceptance check writes into the workspace when
	 * `collectCheckResults` runs (mutation-after-execution). */
	readonly mutateOnCollectChecks?: readonly string[];
	/** Relative paths a simulated worker/check writes AND commits inside the
	 * worktree during `collectCheckResults`, advancing HEAD off the recorded base
	 * (exercises the diff-scope HEAD-advance fail-open). Requires gitWorkspace. */
	readonly commitOnCollectChecks?: readonly string[];
	/** Reject inside the acceptance port to exercise the write-ahead fail-closed path. */
	readonly throwOnRecordAcceptance?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
	const {
		policyOutcome = "approved",
		throwOn = [],
		deleteResult = { deleted: true },
		inspectWorkspace,
		acceptanceEvidence,
		trustedAcceptanceCheckResults = [],
		policyDecisions,
		omitAcceptanceEvaluator = false,
		policyProfile,
		withAcceptancePort = false,
		diffScope,
		gitWorkspace = false,
		mutateOnCollectChecks = [],
		commitOnCollectChecks = [],
		throwOnRecordAcceptance = false,
	} = options;
	const runEvents: string[] = [];
	const evidencePayloads: ExecutionReceipt[] = [];
	let evaluateRunCallCount = 0;
	const runtimeRoots: string[] = [];
	const acceptanceEvidenceCalls: AcceptanceEvidence[] = [];
	const acceptanceRecords: AcceptanceRecordInput[] = [];
	const diffScopeChangedFiles: (readonly string[])[] = [];
	const failurePayloads: Parameters<
		BuildplaneStoragePort["commitRunFailureOutcome"]
	>[1][] = [];
	const cleanupErrors: string[] = [];
	const root = mkdtempSync(join(tmpdir(), "buildplane-orchestrator-"));
	const workspacePath = join(root, ".buildplane", "workspaces", "run-1");
	// The recorded base SHA the acceptance gate's HEAD-advance guard compares
	// against. For a real git workspace it is the actual seed commit so the guard
	// sees an unchanged HEAD on normal runs; "abc123" is the inert placeholder the
	// non-git mock workspaces use.
	let workspaceHeadSha = "abc123";
	if (gitWorkspace) {
		mkdirSync(workspacePath, { recursive: true });
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", workspacePath, ...args], { stdio: "ignore" });
		git("init", "-q");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "test");
		writeFileSync(join(workspacePath, "seed.txt"), "seed\n");
		git("add", "-A");
		git("commit", "-q", "-m", "seed");
		workspaceHeadSha = execFileSync(
			"git",
			["-C", workspacePath, "rev-parse", "HEAD"],
			{ encoding: "utf8" },
		).trim();
	}
	const baseReceipt: ExecutionReceipt = {
		command: "node",
		args: [],
		cwd: workspacePath,
		startedAt: "2026-03-17T00:00:00.000Z",
		completedAt: "2026-03-17T00:00:01.000Z",
		exitCode: policyOutcome === "approved" ? 0 : 1,
		stdout: policyOutcome === "approved" ? "ok" : "",
		stderr: policyOutcome === "approved" ? "" : "failed",
		outputChecks: [
			{ path: "tmp/out.txt", exists: policyOutcome === "approved" },
		],
		acceptanceEvidence,
	};
	const statusSnapshot: StatusSnapshot = {
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
	};
	const inspectSnapshot: InspectSnapshot = {
		kind: "run",
		unit: packet.unit,
		run: {
			id: "run-1",
			unitId: packet.unit.id,
			status: inspectWorkspace?.status === "deleted" ? "passed" : "failed",
		},
		workspace: inspectWorkspace,
		runHistory: [{ id: "run-1", status: "failed" }],
		evidence: [],
		decisions: [],
		artifacts: [],
	};

	const shouldThrow = (point: FailurePoint) => throwOn.includes(point);

	const storage: BuildplaneStoragePort = {
		initializeProject() {
			runEvents.push("initialize-project");
			return {
				created: true,
				projectRoot: root,
				stateDbPath: join(root, ".buildplane", "state.db"),
			};
		},
		createRun() {
			runEvents.push("create-run");
			return { id: "run-1", unitId: packet.unit.id, status: "pending" };
		},
		markRunRunning() {
			runEvents.push("mark-run-running");
			if (shouldThrow("markRunRunning")) {
				throw new Error("markRunRunning persistence failed");
			}
		},
		recordExecutionEvidence(_runId, receipt) {
			runEvents.push("record-execution-evidence");
			evidencePayloads.push(receipt);
			if (shouldThrow("recordExecutionEvidence")) {
				throw new Error("recordExecutionEvidence persistence failed");
			}
		},
		recordDecision() {
			throw new Error("legacy recordDecision should not be used");
		},
		completeRun() {
			throw new Error("legacy completeRun should not be used");
		},
		recordWorkspacePrepared() {
			runEvents.push("record-workspace-prepared");
			if (shouldThrow("recordWorkspacePrepared")) {
				throw new Error("recordWorkspacePrepared persistence failed");
			}
		},
		commitRunFailureOutcome(_runId, payload) {
			runEvents.push("commit-run-failure-outcome");
			failurePayloads.push(payload);
			if (shouldThrow("commitRunFailureOutcome")) {
				throw new Error("commitRunFailureOutcome persistence failed");
			}
			return { id: "run-1", unitId: packet.unit.id, status: "failed" };
		},
		commitRunSuccessOutcome() {
			runEvents.push("commit-run-success-outcome");
			if (shouldThrow("commitRunSuccessOutcome")) {
				throw new Error("commitRunSuccessOutcome persistence failed");
			}
			return { id: "run-1", unitId: packet.unit.id, status: "passed" };
		},
		recordWorkspaceDeleted() {
			runEvents.push("record-workspace-deleted");
			if (shouldThrow("recordWorkspaceDeleted")) {
				throw new Error("recordWorkspaceDeleted persistence failed");
			}
		},
		recordWorkspaceCleanupFailed(_runId, message) {
			runEvents.push("record-workspace-cleanup-failed");
			if (shouldThrow("recordWorkspaceCleanupFailed")) {
				throw new Error("recordWorkspaceCleanupFailed persistence failed");
			}
			cleanupErrors.push(message);
		},
		getStatusSnapshot() {
			runEvents.push("get-status-snapshot-for-init-preflight");
			return statusSnapshot;
		},
		inspectTarget() {
			runEvents.push("inspect-target");
			return inspectSnapshot;
		},
		getChildRuns() {
			return [];
		},
		appendRunOutcome(input) {
			runEvents.push("append-run-outcome");
			return {
				id: "outcome-1",
				repoId: root,
				taskType: input.taskType,
				worker: input.worker,
				success: input.success,
				sourceRunId: input.sourceRunId,
				createdAt: "2026-03-17T00:00:02.000Z",
			};
		},
		listRunOutcomes() {
			return [];
		},
	};

	const runtime: BuildplaneRuntimePort = {
		executePacket(_packet, executionRoot) {
			runEvents.push("execute-packet");
			runtimeRoots.push(executionRoot);
			if (shouldThrow("runtime")) {
				throw new Error("runtime execution failed");
			}
			return baseReceipt;
		},
		async executePacketAsync(_packet, executionRoot, _bus) {
			runEvents.push("execute-packet");
			runtimeRoots.push(executionRoot);
			if (shouldThrow("runtime")) {
				throw new Error("runtime execution failed");
			}
			return baseReceipt;
		},
	};

	const policy: BuildplanePolicyPort = {
		...(omitAcceptanceEvaluator
			? {}
			: {
					evaluateAcceptanceDiffScope(changedFiles: readonly string[]) {
						diffScopeChangedFiles.push(changedFiles);
						return diffScope ?? { status: "passed", outOfScopeFiles: [] };
					},
					evaluateAcceptanceContract(
						contract: AcceptanceContractV0,
						evidence: AcceptanceEvidence,
					) {
						runEvents.push("evaluate-acceptance-contract");
						acceptanceEvidenceCalls.push(evidence);
						if (diffScope?.status === "blocked") {
							return {
								kind: "acceptance.contract" as const,
								outcome: "rejected" as const,
								reasons: [
									`acceptance.contract blocked out-of-scope files ${diffScope.outOfScopeFiles.join(", ")}`,
								],
							};
						}
						const failedCheck = contract.checks.find((check) => {
							const result = evidence.checkResults?.find(
								(entry) => entry.command === check.command,
							);
							return !result || result.exitCode !== 0;
						});
						if (failedCheck) {
							return {
								kind: "acceptance.contract" as const,
								outcome: "rejected" as const,
								reasons: [
									`acceptance.contract missing or failed check evidence for ${failedCheck.command}`,
								],
							};
						}
						return null;
					},
				}),
		evaluateRun() {
			runEvents.push("evaluate-run");
			if (shouldThrow("policy")) {
				throw new Error("policy evaluation failed");
			}

			if (policyDecisions) {
				const decision =
					policyDecisions[
						Math.min(evaluateRunCallCount, policyDecisions.length - 1)
					];
				evaluateRunCallCount += 1;
				return decision;
			}

			return policyOutcome === "approved"
				? { kind: "advance-run", outcome: "approved", reasons: [] }
				: {
						kind: "reject-run",
						outcome: "rejected",
						reasons: ["command exited with code 1"],
					};
		},
	};

	const workspace: BuildplaneWorkspacePort = {
		assertRunnableRepository() {
			runEvents.push("assert-repo");
			return { headSha: workspaceHeadSha };
		},
		checkWorktreeClean: () => true,
		prepareWorkspace() {
			runEvents.push("prepare-workspace");
			if (shouldThrow("prepareWorkspace")) {
				throw new Error("git worktree add failed");
			}
			return { path: workspacePath, headSha: workspaceHeadSha };
		},
		deleteWorkspace() {
			runEvents.push("delete-workspace");
			if (shouldThrow("deleteWorkspace")) {
				throw new Error("git worktree remove failed");
			}
			return deleteResult;
		},
	};

	const admissionStore: RunAdmissionLocalEvidenceStore = {
		writeReceiptArtifact(input) {
			return {
				ref: `artifact://${input.receipt.receipt_id}`,
				path: join(root, "run-admission.json"),
			};
		},
		appendAdmissionEvent(input) {
			return {
				ref: `event://${input.event.event_id}`,
				path: join(root, "run-admission-events.jsonl"),
			};
		},
	};

	return {
		root,
		workspacePath,
		runEvents,
		runtimeRoots,
		evidencePayloads,
		acceptanceEvidenceCalls,
		acceptanceRecords,
		diffScopeChangedFiles,
		failurePayloads,
		cleanupErrors,
		statusSnapshot,
		inspectSnapshot,
		orchestrator: createBuildplaneOrchestrator({
			projectRoot: root,
			storage,
			runtime,
			policy,
			workspace,
			admissionStore,
			acceptanceEvidencePort: {
				collectCheckResults() {
					runEvents.push("collect-acceptance-checks");
					for (const relPath of mutateOnCollectChecks) {
						const target = join(workspacePath, relPath);
						mkdirSync(dirname(target), { recursive: true });
						writeFileSync(target, "mutated-by-check\n");
						if (gitWorkspace) {
							execFileSync("git", ["-C", workspacePath, "add", "-A"], {
								stdio: "ignore",
							});
						}
					}
					for (const relPath of commitOnCollectChecks) {
						const target = join(workspacePath, relPath);
						mkdirSync(dirname(target), { recursive: true });
						writeFileSync(target, "committed-by-worker\n");
						execFileSync("git", ["-C", workspacePath, "add", "-A"], {
							stdio: "ignore",
						});
						execFileSync(
							"git",
							["-C", workspacePath, "commit", "-q", "-m", "worker commit"],
							{ stdio: "ignore" },
						);
					}
					return trustedAcceptanceCheckResults;
				},
			},
			acceptancePort: withAcceptancePort
				? {
						async recordAcceptance(input: AcceptanceRecordInput) {
							runEvents.push("acceptance-recorded");
							acceptanceRecords.push(input);
							if (throwOnRecordAcceptance) {
								throw new Error("ledger flush rejected");
							}
						},
					}
				: undefined,
			profileRegistry: policyProfile
				? {
						resolve(name) {
							runEvents.push("resolve-profile");
							if (name !== policyProfile.name) {
								throw new Error(`unknown profile: ${name}`);
							}
							return policyProfile;
						},
					}
				: undefined,
		}),
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function eventLog(runEvents: readonly string[]) {
	return [runEvents[0], ...validationEvents, ...runEvents.slice(1)];
}

beforeEach(() => {
	validationEvents.length = 0;
});

describe("kernel orchestrator", () => {
	it("orchestrates a successful packet run inside a prepared workspace", () => {
		const { orchestrator, runEvents, runtimeRoots, workspacePath, cleanup } =
			createHarness({ policyOutcome: "approved" });

		try {
			const result = orchestrator.runPacket(packet);

			expect(eventLog(runEvents)).toEqual([
				"get-status-snapshot-for-init-preflight",
				"validate-packet-for-workspace-root",
				"assert-repo",
				"create-run",
				"prepare-workspace",
				"record-workspace-prepared",
				"mark-run-running",
				"execute-packet",
				"record-execution-evidence",
				"evaluate-run",
				"commit-run-success-outcome",
				"delete-workspace",
				"record-workspace-deleted",
			]);
			expect(runtimeRoots).toEqual([workspacePath]);
			expect(result.run.status).toBe("passed");
			expect(result.decision?.outcome).toBe("approved");
			expect(result.workspace).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("enriches inspect workspace snapshots with a read-time existsOnDisk observation", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-orchestrator-inspect-"),
		);
		const workspacePath = join(root, ".buildplane", "workspaces", "run-1");
		mkdirSync(workspacePath, { recursive: true });

		const { orchestrator, cleanup } = createHarness({
			inspectWorkspace: {
				runId: "run-1",
				path: workspacePath,
				headSha: "abc123",
				status: "retained",
			},
		});

		try {
			const existingInspect = orchestrator.inspect("run-1");
			expect(existingInspect.workspace?.existsOnDisk).toBe(true);

			rmSync(workspacePath, { recursive: true, force: true });

			const missingInspect = orchestrator.inspect("run-1");
			expect(missingInspect.workspace?.existsOnDisk).toBe(false);
		} finally {
			cleanup();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("finalizes setup failures after run creation without recording a workspace row", () => {
		const { orchestrator, runEvents, runtimeRoots, failurePayloads, cleanup } =
			createHarness({ throwOn: ["prepareWorkspace"] });

		try {
			const result = orchestrator.runPacket(packet);

			expect(runEvents).not.toContain("record-workspace-prepared");
			expect(runEvents).not.toContain("evaluate-run");
			expect(runtimeRoots).toEqual([]);
			expect(failurePayloads).toEqual([
				expect.objectContaining({
					infrastructureFailure: {
						kind: "workspace-prepare-failed",
						message: "git worktree add failed",
					},
				}),
			]);
			expect(failurePayloads[0]).not.toHaveProperty("workspaceStatus");
			expect(result.failure).toEqual({
				kind: "workspace-prepare-failed",
				message: "git worktree add failed",
			});
			expect(result.workspace).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("best-effort cleans up when workspace persistence fails after git preparation", () => {
		const { orchestrator, runEvents, failurePayloads, cleanup } = createHarness(
			{
				throwOn: ["recordWorkspacePrepared"],
			},
		);

		try {
			const result = orchestrator.runPacket(packet);

			expect(eventLog(runEvents)).toEqual([
				"get-status-snapshot-for-init-preflight",
				"validate-packet-for-workspace-root",
				"assert-repo",
				"create-run",
				"prepare-workspace",
				"record-workspace-prepared",
				"delete-workspace",
				"commit-run-failure-outcome",
			]);
			expect(failurePayloads[0]).toMatchObject({
				infrastructureFailure: {
					kind: "workspace-persistence-failed",
					message: "recordWorkspacePrepared persistence failed",
				},
			});
			expect(failurePayloads[0]).not.toHaveProperty("workspaceStatus");
			expect(result.workspace).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("surfaces cleanup details when recordWorkspacePrepared fails and best-effort cleanup also fails", () => {
		const { orchestrator, cleanup, failurePayloads } = createHarness({
			throwOn: ["recordWorkspacePrepared"],
			deleteResult: {
				deleted: false,
				cleanupError: "worktree remove blocked",
			},
		});

		try {
			const result = orchestrator.runPacket(packet);

			expect(failurePayloads[0]).toMatchObject({
				infrastructureFailure: {
					kind: "workspace-persistence-failed",
					message: expect.stringMatching(
						/recordWorkspacePrepared persistence failed.*worktree remove blocked/i,
					),
				},
			});
			expect(result.failure?.message).toMatch(/worktree remove blocked/i);
			expect(result.workspace).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("retains rejected-policy workspaces and returns workspace metadata", () => {
		const {
			orchestrator,
			runEvents,
			runtimeRoots,
			failurePayloads,
			workspacePath,
			cleanup,
		} = createHarness({ policyOutcome: "rejected" });

		try {
			const result = orchestrator.runPacket(packet);

			expect(runEvents).not.toContain("delete-workspace");
			expect(runtimeRoots).toEqual([workspacePath]);
			expect(failurePayloads).toEqual([
				expect.objectContaining({
					decision: expect.objectContaining({ outcome: "rejected" }),
					workspaceStatus: "retained",
				}),
			]);
			expect(result.run.status).toBe("failed");
			expect(result.decision?.outcome).toBe("rejected");
			expect(result.workspace).toMatchObject({
				path: workspacePath,
				headSha: "abc123",
				status: "retained",
			});
		} finally {
			cleanup();
		}
	});

	it.each([
		["markRunRunning", "run-start-failed", "markRunRunning persistence failed"],
		[
			"recordExecutionEvidence",
			"execution-evidence-persistence-failed",
			"recordExecutionEvidence persistence failed",
		],
		["runtime", "runtime-execution-failed", "runtime execution failed"],
		["policy", "policy-evaluation-failed", "policy evaluation failed"],
	] as const)("retains prepared workspaces when %s fails after preparation", (failurePoint, expectedKind, expectedMessage) => {
		const { orchestrator, runEvents, failurePayloads, workspacePath, cleanup } =
			createHarness({ throwOn: [failurePoint] });

		try {
			const result = orchestrator.runPacket(packet);

			expect(runEvents).not.toContain("delete-workspace");
			expect(failurePayloads).toEqual([
				expect.objectContaining({
					infrastructureFailure: {
						kind: expectedKind,
						message: expectedMessage,
					},
					workspaceStatus: "retained",
				}),
			]);
			expect(result.failure).toEqual({
				kind: expectedKind,
				message: expectedMessage,
			});
			expect(result.workspace).toMatchObject({
				path: workspacePath,
				status: "retained",
			});
		} finally {
			cleanup();
		}
	});

	it("surfaces an infrastructure error when failed-path finalization cannot be persisted", () => {
		const { orchestrator, failurePayloads, cleanup } = createHarness({
			throwOn: ["runtime", "commitRunFailureOutcome"],
		});

		try {
			const result = orchestrator.runPacket(packet);

			expect(failurePayloads).toEqual([
				expect.objectContaining({
					infrastructureFailure: {
						kind: "runtime-execution-failed",
						message: "runtime execution failed",
					},
					workspaceStatus: "retained",
				}),
			]);
			expect(result.failure).toEqual({
				kind: "run-failure-finalization-failed",
				message: "commitRunFailureOutcome persistence failed",
			});
			expect(result.workspace).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("records cleanup failures separately after a passed run and returns actionable workspace metadata", () => {
		const { orchestrator, runEvents, cleanupErrors, workspacePath, cleanup } =
			createHarness({
				policyOutcome: "approved",
				deleteResult: { deleted: false, cleanupError: "disk busy" },
			});

		try {
			const result = orchestrator.runPacket(packet);

			expect(runEvents).toContain("record-workspace-cleanup-failed");
			expect(cleanupErrors).toEqual(["disk busy"]);
			expect(result.run.status).toBe("passed");
			expect(result.failure).toBeUndefined();
			expect(result.workspace).toMatchObject({
				path: workspacePath,
				status: "cleanup-failed",
				cleanupError: "disk busy",
			});
		} finally {
			cleanup();
		}
	});

	it("treats thrown workspace deletes as cleanup failures and returns actionable workspace metadata", () => {
		const { orchestrator, cleanupErrors, workspacePath, cleanup } =
			createHarness({
				policyOutcome: "approved",
				throwOn: ["deleteWorkspace"],
			});

		try {
			const result = orchestrator.runPacket(packet);

			expect(cleanupErrors).toEqual(["git worktree remove failed"]);
			expect(result.run.status).toBe("passed");
			expect(result.failure).toBeUndefined();
			expect(result.workspace).toMatchObject({
				path: workspacePath,
				status: "cleanup-failed",
				cleanupError: "git worktree remove failed",
			});
		} finally {
			cleanup();
		}
	});

	it("returns an infrastructure failure when cleanup-failed persistence also fails", () => {
		const { orchestrator, workspacePath, cleanup } = createHarness({
			policyOutcome: "approved",
			deleteResult: { deleted: false, cleanupError: "disk busy" },
			throwOn: ["recordWorkspaceCleanupFailed"],
		});

		try {
			const result = orchestrator.runPacket(packet);

			expect(result.run.status).toBe("passed");
			expect(result.failure).toEqual({
				kind: "workspace-cleanup-persistence-failed",
				message: "recordWorkspaceCleanupFailed persistence failed",
			});
			expect(result.workspace).toMatchObject({
				path: workspacePath,
				status: "cleanup-failed",
				cleanupError: "disk busy",
			});
		} finally {
			cleanup();
		}
	});

	it("surfaces the fallback cleanup message when delete returns no explicit error", () => {
		const { orchestrator, cleanupErrors, workspacePath, cleanup } =
			createHarness({
				policyOutcome: "approved",
				deleteResult: { deleted: false },
			});

		try {
			const result = orchestrator.runPacket(packet);

			expect(cleanupErrors).toEqual(["workspace cleanup failed"]);
			expect(result.workspace).toMatchObject({
				path: workspacePath,
				status: "cleanup-failed",
				cleanupError: "workspace cleanup failed",
			});
		} finally {
			cleanup();
		}
	});

	it("retains the prepared workspace when success finalization fails after policy approval", () => {
		const { orchestrator, runEvents, failurePayloads, workspacePath, cleanup } =
			createHarness({ throwOn: ["commitRunSuccessOutcome"] });

		try {
			const result = orchestrator.runPacket(packet);

			expect(runEvents).not.toContain("delete-workspace");
			expect(failurePayloads.at(-1)).toMatchObject({
				infrastructureFailure: {
					kind: "run-success-persistence-failed",
					message: "commitRunSuccessOutcome persistence failed",
				},
				workspaceStatus: "retained",
			});
			expect(result.run.status).toBe("failed");
			expect(result.failure).toEqual({
				kind: "run-success-persistence-failed",
				message: "commitRunSuccessOutcome persistence failed",
			});
			expect(result.workspace).toMatchObject({
				path: workspacePath,
				status: "retained",
			});
		} finally {
			cleanup();
		}
	});

	it("returns an infrastructure error when delete persistence fails after git cleanup succeeds", () => {
		const { orchestrator, workspacePath, cleanup } = createHarness({
			throwOn: ["recordWorkspaceDeleted"],
		});

		try {
			const result = orchestrator.runPacket(packet);

			expect(result.run.status).toBe("passed");
			expect(result.failure).toEqual({
				kind: "workspace-delete-persistence-failed",
				message: "recordWorkspaceDeleted persistence failed",
			});
			expect(result.workspace).toMatchObject({
				path: workspacePath,
				status: "active",
			});
		} finally {
			cleanup();
		}
	});

	it("rejects escaping packet paths before creating a run or workspace", () => {
		const { orchestrator, runEvents, cleanup } = createHarness();

		try {
			expect(() =>
				orchestrator.runPacket({
					...packet,
					execution: {
						...packet.execution,
						cwd: "../escape",
					},
				}),
			).toThrow(/outside the worktree root/i);
			expect(eventLog(runEvents)).toEqual([
				"get-status-snapshot-for-init-preflight",
				"validate-packet-for-workspace-root",
			]);
			expect(runEvents).not.toContain("assert-repo");
			expect(runEvents).not.toContain("create-run");
		} finally {
			cleanup();
		}
	});

	it("orchestrates a successful async run through the full workspace lifecycle", async () => {
		const { orchestrator, runEvents, runtimeRoots, workspacePath, cleanup } =
			createHarness({ policyOutcome: "approved" });

		try {
			const result = await orchestrator.runPacketAsync(packet);

			expect(eventLog(runEvents)).toEqual([
				"get-status-snapshot-for-init-preflight",
				"validate-packet-for-workspace-root",
				"assert-repo",
				"create-run",
				"prepare-workspace",
				"record-workspace-prepared",
				"mark-run-running",
				"execute-packet",
				"record-execution-evidence",
				"evaluate-run",
				"commit-run-success-outcome",
				"delete-workspace",
				"record-workspace-deleted",
			]);
			expect(runtimeRoots).toEqual([workspacePath]);
			expect(result.run.status).toBe("passed");
			expect(result.decision?.outcome).toBe("approved");
			expect(result.workspace).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("blocks async finalization when configured acceptance evidence is missing", async () => {
		const acceptanceContract: AcceptanceContractV0 = {
			contract_version: "v0",
			diff_scope: { allowed_globs: ["**"] },
			checks: [{ command: "pnpm lint" }],
		};
		const {
			orchestrator,
			runEvents,
			acceptanceEvidenceCalls,
			failurePayloads,
			workspacePath,
			cleanup,
		} = createHarness({
			policyOutcome: "approved",
			policyProfile: {
				name: "default",
				trustGates: { acceptanceContract },
			},
		});

		try {
			const result = await orchestrator.runPacketAsync(packet);

			expect(runEvents).toContain("collect-acceptance-checks");
			expect(runEvents).toContain("evaluate-acceptance-contract");
			expect(acceptanceEvidenceCalls).toEqual([
				expect.objectContaining({
					checkResults: [],
				}),
			]);
			expect(runEvents).not.toContain("evaluate-run");
			expect(runEvents).not.toContain("commit-run-success-outcome");
			expect(runEvents).not.toContain("delete-workspace");
			expect(failurePayloads).toEqual([
				expect.objectContaining({
					decision: expect.objectContaining({
						kind: "acceptance.contract",
						outcome: "rejected",
					}),
					workspaceStatus: "retained",
				}),
			]);
			expect(result.run.status).toBe("failed");
			expect(result.decision).toMatchObject({
				kind: "acceptance.contract",
				outcome: "rejected",
			});
			expect(result.workspace).toMatchObject({
				path: workspacePath,
				status: "retained",
			});
		} finally {
			cleanup();
		}
	});

	it("blocks sync finalization from trusted acceptance checks instead of receipt self-attestation", () => {
		const acceptanceContract: AcceptanceContractV0 = {
			contract_version: "v0",
			diff_scope: { allowed_globs: ["**"] },
			checks: [{ command: "pnpm lint" }],
		};
		const {
			orchestrator,
			runEvents,
			acceptanceEvidenceCalls,
			failurePayloads,
			workspacePath,
			cleanup,
		} = createHarness({
			acceptanceEvidence: {
				checkResults: [{ command: "pnpm lint", exitCode: 0 }],
			},
			trustedAcceptanceCheckResults: [{ command: "pnpm lint", exitCode: 1 }],
			policyOutcome: "approved",
			policyProfile: {
				name: "default",
				trustGates: { acceptanceContract },
			},
		});

		try {
			const result = orchestrator.runPacket(packet);

			expect(runEvents).toContain("resolve-profile");
			expect(runEvents).toContain("collect-acceptance-checks");
			expect(runEvents).toContain("evaluate-acceptance-contract");
			expect(runEvents).not.toContain("evaluate-run");
			expect(runEvents).not.toContain("commit-run-success-outcome");
			expect(runEvents).not.toContain("delete-workspace");
			expect(acceptanceEvidenceCalls).toEqual([
				expect.objectContaining({
					checkResults: [{ command: "pnpm lint", exitCode: 1 }],
				}),
			]);
			expect(failurePayloads).toEqual([
				expect.objectContaining({
					decision: expect.objectContaining({
						kind: "acceptance.contract",
						outcome: "rejected",
					}),
					workspaceStatus: "retained",
				}),
			]);
			expect(result.run.status).toBe("failed");
			expect(result.workspace).toMatchObject({
				path: workspacePath,
				status: "retained",
			});
		} finally {
			cleanup();
		}
	});

	it("allows async finalization when configured acceptance evidence is present", async () => {
		const acceptanceContract: AcceptanceContractV0 = {
			contract_version: "v0",
			diff_scope: { allowed_globs: ["**"] },
			checks: [{ command: "pnpm lint" }],
		};
		const {
			orchestrator,
			runEvents,
			acceptanceEvidenceCalls,
			workspacePath,
			cleanup,
		} = createHarness({
			trustedAcceptanceCheckResults: [{ command: "pnpm lint", exitCode: 0 }],
			policyOutcome: "approved",
			policyProfile: {
				name: "default",
				trustGates: { acceptanceContract },
			},
		});

		try {
			const result = await orchestrator.runPacketAsync(packet);

			expect(runEvents).toContain("evaluate-acceptance-contract");
			expect(acceptanceEvidenceCalls).toEqual([
				expect.objectContaining({
					checkResults: [{ command: "pnpm lint", exitCode: 0 }],
				}),
			]);
			expect(validationEvents).toEqual(["validate-packet-for-workspace-root"]);
			expect(runEvents).toEqual([
				"resolve-profile",
				"get-status-snapshot-for-init-preflight",
				"assert-repo",
				"create-run",
				"prepare-workspace",
				"record-workspace-prepared",
				"mark-run-running",
				"execute-packet",
				"record-execution-evidence",
				"collect-acceptance-checks",
				"evaluate-acceptance-contract",
				"evaluate-run",
				"commit-run-success-outcome",
				"delete-workspace",
				"record-workspace-deleted",
			]);
			expect(result.run.status).toBe("passed");
			expect(result.decision?.outcome).toBe("approved");
			expect(result.workspace).toBeUndefined();
			expect(workspacePath).toContain(".buildplane");
		} finally {
			cleanup();
		}
	});

	it("emits a passed acceptance_recorded before the merge when checks pass", async () => {
		const acceptanceContract: AcceptanceContractV0 = {
			contract_version: "v0",
			diff_scope: { allowed_globs: ["**"] },
			checks: [{ command: "pnpm lint" }],
		};
		const { orchestrator, runEvents, acceptanceRecords, cleanup } =
			createHarness({
				trustedAcceptanceCheckResults: [{ command: "pnpm lint", exitCode: 0 }],
				policyOutcome: "approved",
				withAcceptancePort: true,
				policyProfile: {
					name: "default",
					trustGates: { acceptanceContract },
				},
			});

		try {
			const result = await orchestrator.runPacketAsync(packet);

			// The signed verdict is appended BEFORE the workspace is merged.
			const recordedIdx = runEvents.indexOf("acceptance-recorded");
			const mergeIdx = runEvents.indexOf("commit-run-success-outcome");
			expect(recordedIdx).toBeGreaterThanOrEqual(0);
			expect(mergeIdx).toBeGreaterThan(recordedIdx);
			expect(runEvents).toContain("delete-workspace");

			expect(acceptanceRecords).toEqual([
				expect.objectContaining({
					outcome: "passed",
					diffScopeStatus: "passed",
					outOfScopeFiles: [],
					checkResults: [{ command: "pnpm lint", exitCode: 0 }],
				}),
			]);
			expect(result.run.status).toBe("passed");
		} finally {
			cleanup();
		}
	});

	it("emits a rejected acceptance_recorded and skips merge when a check fails", async () => {
		const acceptanceContract: AcceptanceContractV0 = {
			contract_version: "v0",
			diff_scope: { allowed_globs: ["**"] },
			checks: [{ command: "pnpm lint" }],
		};
		const {
			orchestrator,
			runEvents,
			acceptanceRecords,
			failurePayloads,
			workspacePath,
			cleanup,
		} = createHarness({
			trustedAcceptanceCheckResults: [{ command: "pnpm lint", exitCode: 1 }],
			policyOutcome: "approved",
			withAcceptancePort: true,
			policyProfile: {
				name: "default",
				trustGates: { acceptanceContract },
			},
		});

		try {
			const result = await orchestrator.runPacketAsync(packet);

			// The verdict is recorded even on rejection, before the no-merge short-circuit.
			const recordedIdx = runEvents.indexOf("acceptance-recorded");
			expect(recordedIdx).toBeGreaterThanOrEqual(0);
			expect(runEvents).not.toContain("commit-run-success-outcome");
			expect(runEvents).not.toContain("delete-workspace");

			expect(acceptanceRecords).toEqual([
				expect.objectContaining({
					outcome: "rejected",
					diffScopeStatus: "passed",
					outOfScopeFiles: [],
					checkResults: [{ command: "pnpm lint", exitCode: 1 }],
				}),
			]);
			expect(failurePayloads).toEqual([
				expect.objectContaining({
					decision: expect.objectContaining({
						kind: "acceptance.contract",
						outcome: "rejected",
					}),
					workspaceStatus: "retained",
				}),
			]);
			expect(result.run.status).toBe("failed");
			expect(result.workspace).toMatchObject({
				path: workspacePath,
				status: "retained",
			});
		} finally {
			cleanup();
		}
	});

	it("records a blocked diff_scope verdict and quarantines when the diff escapes scope", async () => {
		const acceptanceContract: AcceptanceContractV0 = {
			contract_version: "v0",
			diff_scope: { allowed_globs: ["docs/**"] },
			checks: [],
		};
		const {
			orchestrator,
			runEvents,
			acceptanceRecords,
			workspacePath,
			cleanup,
		} = createHarness({
			trustedAcceptanceCheckResults: [],
			policyOutcome: "approved",
			withAcceptancePort: true,
			diffScope: { status: "blocked", outOfScopeFiles: ["src/sneaky.ts"] },
			policyProfile: {
				name: "default",
				trustGates: { acceptanceContract },
			},
		});

		try {
			const result = await orchestrator.runPacketAsync(packet);

			expect(runEvents).toContain("acceptance-recorded");
			expect(runEvents).not.toContain("commit-run-success-outcome");
			expect(runEvents).not.toContain("delete-workspace");
			expect(acceptanceRecords).toEqual([
				expect.objectContaining({
					outcome: "rejected",
					diffScopeStatus: "blocked",
					outOfScopeFiles: ["src/sneaky.ts"],
				}),
			]);
			expect(result.run.status).toBe("failed");
			expect(result.workspace).toMatchObject({
				path: workspacePath,
				status: "retained",
			});
		} finally {
			cleanup();
		}
	});

	it("recomputes diff scope after acceptance checks mutate the worktree", async () => {
		const acceptanceContract: AcceptanceContractV0 = {
			contract_version: "v0",
			diff_scope: { allowed_globs: ["docs/**"] },
			checks: [{ command: "pnpm lint --fix" }],
		};
		const { orchestrator, acceptanceRecords, diffScopeChangedFiles, cleanup } =
			createHarness({
				gitWorkspace: true,
				// The check writes an out-of-scope file AFTER worker execution captured
				// changedFiles — the regression is that this file is invisible to the gate.
				mutateOnCollectChecks: ["src/sneaky.ts"],
				trustedAcceptanceCheckResults: [
					{ command: "pnpm lint --fix", exitCode: 0 },
				],
				policyOutcome: "approved",
				withAcceptancePort: true,
				diffScope: { status: "blocked", outOfScopeFiles: ["src/sneaky.ts"] },
				policyProfile: {
					name: "default",
					trustGates: { acceptanceContract },
				},
			});

		try {
			await orchestrator.runPacketAsync(packet);

			// The diff-scope evaluation must see the check-created out-of-scope file.
			expect(diffScopeChangedFiles.at(-1)).toContain("src/sneaky.ts");
			expect(acceptanceRecords).toEqual([
				expect.objectContaining({
					outcome: "rejected",
					diffScopeStatus: "blocked",
					outOfScopeFiles: ["src/sneaky.ts"],
				}),
			]);
		} finally {
			cleanup();
		}
	});

	it("rejects fail-closed when a worker commits inside the worktree (HEAD advances off the recorded base)", async () => {
		const acceptanceContract: AcceptanceContractV0 = {
			contract_version: "v0",
			diff_scope: { allowed_globs: ["docs/**"] },
			checks: [{ command: "true" }],
		};
		const {
			orchestrator,
			runEvents,
			acceptanceRecords,
			workspacePath,
			cleanup,
		} = createHarness({
			gitWorkspace: true,
			// A worker commits an out-of-scope file INSIDE the detached worktree.
			// The commit advances HEAD, so `git diff HEAD` reports an empty diff —
			// the bypass the HEAD-advance guard closes.
			commitOnCollectChecks: ["src/sneaky.ts"],
			trustedAcceptanceCheckResults: [{ command: "true", exitCode: 0 }],
			policyOutcome: "approved",
			withAcceptancePort: true,
			// The (now-empty) diff WOULD pass diff-scope; the guard rejects anyway
			// because HEAD no longer equals the recorded base SHA.
			diffScope: { status: "passed", outOfScopeFiles: [] },
			policyProfile: {
				name: "default",
				trustGates: { acceptanceContract },
			},
		});

		try {
			const result = await orchestrator.runPacketAsync(packet);

			// The committed out-of-scope delta must be quarantined, never merged.
			expect(runEvents).toContain("acceptance-recorded");
			expect(runEvents).not.toContain("commit-run-success-outcome");
			expect(runEvents).not.toContain("delete-workspace");
			expect(acceptanceRecords).toEqual([
				expect.objectContaining({
					outcome: "rejected",
					diffScopeStatus: "blocked",
				}),
			]);
			expect(result.run.status).toBe("failed");
			expect(result.workspace).toMatchObject({
				path: workspacePath,
				status: "retained",
			});
		} finally {
			cleanup();
		}
	});

	it("finalizes the run when acceptance recording fails (write-ahead fail-closed)", async () => {
		const acceptanceContract: AcceptanceContractV0 = {
			contract_version: "v0",
			diff_scope: { allowed_globs: ["**"] },
			checks: [{ command: "pnpm lint" }],
		};
		const { orchestrator, runEvents, failurePayloads, workspacePath, cleanup } =
			createHarness({
				trustedAcceptanceCheckResults: [{ command: "pnpm lint", exitCode: 0 }],
				policyOutcome: "approved",
				withAcceptancePort: true,
				throwOnRecordAcceptance: true,
				policyProfile: {
					name: "default",
					trustGates: { acceptanceContract },
				},
			});

		try {
			const result = await orchestrator.runPacketAsync(packet);

			// A rejected ledger flush must NOT escape unfinalized — it routes through
			// the infrastructure-failure path and quarantines the workspace.
			expect(runEvents).toContain("acceptance-recorded");
			expect(runEvents).not.toContain("commit-run-success-outcome");
			expect(runEvents).not.toContain("delete-workspace");
			expect(failurePayloads.at(-1)).toMatchObject({
				infrastructureFailure: {
					kind: "acceptance-record-failed",
					message: "ledger flush rejected",
				},
				workspaceStatus: "retained",
			});
			expect(result.run.status).toBe("failed");
			expect(result.failure).toMatchObject({
				kind: "acceptance-record-failed",
				message: "ledger flush rejected",
			});
			expect(result.workspace).toMatchObject({
				path: workspacePath,
				status: "retained",
			});
		} finally {
			cleanup();
		}
	});

	it("leaves finalization unchanged when no acceptance contract is configured", async () => {
		const { orchestrator, runEvents, acceptanceRecords, cleanup } =
			createHarness({
				policyOutcome: "approved",
				withAcceptancePort: true,
				// No policyProfile → no trustGates.acceptanceContract → opt-in gate off.
			});

		try {
			const result = await orchestrator.runPacketAsync(packet);

			expect(runEvents).not.toContain("collect-acceptance-checks");
			expect(runEvents).not.toContain("evaluate-acceptance-contract");
			expect(runEvents).not.toContain("acceptance-recorded");
			expect(acceptanceRecords).toEqual([]);
			expect(runEvents).toContain("commit-run-success-outcome");
			expect(runEvents).toContain("delete-workspace");
			expect(result.run.status).toBe("passed");
		} finally {
			cleanup();
		}
	});

	it("reattaches changedFiles evidence after retry execution", async () => {
		const { orchestrator, evidencePayloads, cleanup } = createHarness({
			policyDecisions: [
				{
					kind: "retry-run",
					outcome: "retrying",
					reasons: ["first attempt needs retry"],
					attemptNumber: 1,
					feedbackContext: ["fix and retry"],
				},
				{ kind: "advance-run", outcome: "approved", reasons: [] },
			],
		});

		try {
			const result = await orchestrator.runPacketAsync(packet);

			expect(result.run.status).toBe("passed");
			expect(evidencePayloads).toHaveLength(2);
			expect(evidencePayloads[0].changedFiles).toEqual([
				"../buildplane-diff-unavailable",
			]);
			expect(evidencePayloads[1].changedFiles).toEqual([
				"../buildplane-diff-unavailable",
			]);
		} finally {
			cleanup();
		}
	});

	it("fails closed when an acceptance contract is configured without an evaluator", async () => {
		const acceptanceContract: AcceptanceContractV0 = {
			contract_version: "v0",
			diff_scope: { allowed_globs: ["**"] },
			checks: [{ command: "pnpm lint" }],
		};
		const {
			orchestrator,
			runEvents,
			acceptanceEvidenceCalls,
			failurePayloads,
			workspacePath,
			cleanup,
		} = createHarness({
			acceptanceEvidence: {
				checkResults: [{ command: "pnpm lint", exitCode: 0 }],
			},
			omitAcceptanceEvaluator: true,
			policyOutcome: "approved",
			policyProfile: {
				name: "default",
				trustGates: { acceptanceContract },
			},
		});

		try {
			const result = await orchestrator.runPacketAsync(packet);

			expect(runEvents).not.toContain("evaluate-acceptance-contract");
			expect(acceptanceEvidenceCalls).toEqual([]);
			expect(runEvents).not.toContain("evaluate-run");
			expect(runEvents).not.toContain("commit-run-success-outcome");
			expect(runEvents).not.toContain("delete-workspace");
			expect(failurePayloads).toEqual([
				expect.objectContaining({
					decision: expect.objectContaining({
						kind: "acceptance.contract",
						outcome: "rejected",
						reasons: [
							"acceptance.contract configured but no evaluator is available.",
						],
					}),
					workspaceStatus: "retained",
				}),
			]);
			expect(result.run.status).toBe("failed");
			expect(result.decision).toMatchObject({
				kind: "acceptance.contract",
				outcome: "rejected",
			});
			expect(result.workspace).toMatchObject({
				path: workspacePath,
				status: "retained",
			});
		} finally {
			cleanup();
		}
	});

	it("retains rejected-policy workspaces in async path", async () => {
		const {
			orchestrator,
			runEvents,
			runtimeRoots,
			failurePayloads,
			workspacePath,
			cleanup,
		} = createHarness({ policyOutcome: "rejected" });

		try {
			const result = await orchestrator.runPacketAsync(packet);

			expect(runEvents).not.toContain("delete-workspace");
			expect(runtimeRoots).toEqual([workspacePath]);
			expect(failurePayloads).toEqual([
				expect.objectContaining({
					decision: expect.objectContaining({ outcome: "rejected" }),
					workspaceStatus: "retained",
				}),
			]);
			expect(result.run.status).toBe("failed");
			expect(result.decision?.outcome).toBe("rejected");
			expect(result.workspace).toMatchObject({
				path: workspacePath,
				headSha: "abc123",
				status: "retained",
			});
		} finally {
			cleanup();
		}
	});

	it("finalizes post-prepare infra failure with retained workspace in async", async () => {
		const { orchestrator, runEvents, failurePayloads, workspacePath, cleanup } =
			createHarness({ throwOn: ["runtime"] });

		try {
			const result = await orchestrator.runPacketAsync(packet);

			expect(runEvents).not.toContain("delete-workspace");
			expect(failurePayloads).toEqual([
				expect.objectContaining({
					infrastructureFailure: {
						kind: "runtime-execution-failed",
						message: "runtime execution failed",
					},
					workspaceStatus: "retained",
				}),
			]);
			expect(result.failure).toEqual({
				kind: "runtime-execution-failed",
				message: "runtime execution failed",
			});
			expect(result.workspace).toMatchObject({
				path: workspacePath,
				status: "retained",
			});
		} finally {
			cleanup();
		}
	});

	it("best-effort cleans up when recordWorkspacePrepared fails in async", async () => {
		const { orchestrator, runEvents, failurePayloads, cleanup } = createHarness(
			{
				throwOn: ["recordWorkspacePrepared"],
			},
		);

		try {
			const result = await orchestrator.runPacketAsync(packet);

			expect(eventLog(runEvents)).toEqual([
				"get-status-snapshot-for-init-preflight",
				"validate-packet-for-workspace-root",
				"assert-repo",
				"create-run",
				"prepare-workspace",
				"record-workspace-prepared",
				"delete-workspace",
				"commit-run-failure-outcome",
			]);
			expect(failurePayloads[0]).toMatchObject({
				infrastructureFailure: {
					kind: "workspace-persistence-failed",
					message: "recordWorkspacePrepared persistence failed",
				},
			});
			expect(failurePayloads[0]).not.toHaveProperty("workspaceStatus");
			expect(result.workspace).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("falls back to failed run when success-finalization fails in async", async () => {
		const { orchestrator, runEvents, failurePayloads, workspacePath, cleanup } =
			createHarness({ throwOn: ["commitRunSuccessOutcome"] });

		try {
			const result = await orchestrator.runPacketAsync(packet);

			expect(runEvents).not.toContain("delete-workspace");
			expect(failurePayloads.at(-1)).toMatchObject({
				infrastructureFailure: {
					kind: "run-success-persistence-failed",
					message: "commitRunSuccessOutcome persistence failed",
				},
				workspaceStatus: "retained",
			});
			expect(result.run.status).toBe("failed");
			expect(result.failure).toEqual({
				kind: "run-success-persistence-failed",
				message: "commitRunSuccessOutcome persistence failed",
			});
			expect(result.workspace).toMatchObject({
				path: workspacePath,
				status: "retained",
			});
		} finally {
			cleanup();
		}
	});

	it("delegates init and status to storage", () => {
		const { orchestrator, runEvents, statusSnapshot, cleanup } =
			createHarness();

		try {
			expect(orchestrator.initializeProject()).toEqual({
				created: true,
				projectRoot: expect.any(String),
				stateDbPath: expect.stringContaining(".buildplane/state.db"),
			});
			expect(orchestrator.getStatus()).toBe(statusSnapshot);
			expect(runEvents).toContain("initialize-project");
		} finally {
			cleanup();
		}
	});
});
