import { existsSync } from "node:fs";
import { join } from "node:path";
import { createBudgetEnforcer } from "./budget.js";
import type { EventBus } from "./events.js";
import type {
	BuildplanePolicyPort,
	BuildplaneRuntimePort,
	BuildplaneStoragePort,
	BuildplaneWorkspacePort,
} from "./ports.js";
import type {
	BudgetLimits,
	ExecutionReceipt,
	InspectSnapshot,
	PolicyDecision,
	RunInfrastructureFailure,
	RunPacketResult,
	StatusSnapshot,
	StepRecord,
	UnitPacket,
	WorkspaceSnapshot,
} from "./run-loop.js";
import type { Run, StepKind, StepStatus } from "./types.js";
import { validatePacketForWorkspaceRoot } from "./workspace-paths.js";

/** A no-op event bus for the sync path when no bus is provided. */
const noopBus: EventBus = {
	subscribe: () => () => {},
	emit: () => {},
};

export interface BuildplaneOrchestrator {
	initializeProject(): ReturnType<BuildplaneStoragePort["initializeProject"]>;
	runPacket(packet: UnitPacket): RunPacketResult;
	runPacketAsync(
		packet: UnitPacket,
		eventBus?: EventBus,
	): Promise<RunPacketResult>;
	getStatus(): StatusSnapshot;
	inspect(id: string): InspectSnapshot;
}

export interface CreateBuildplaneOrchestratorOptions {
	readonly projectRoot: string;
	readonly storage: BuildplaneStoragePort;
	readonly runtime: BuildplaneRuntimePort;
	readonly policy: BuildplanePolicyPort;
	readonly workspace: BuildplaneWorkspacePort;
	readonly eventBus?: EventBus;
}

export function createBuildplaneOrchestrator(
	options: CreateBuildplaneOrchestratorOptions,
): BuildplaneOrchestrator {
	const { projectRoot, storage, runtime, policy, workspace } = options;
	const defaultBus = options.eventBus ?? noopBus;

	function infrastructureFailure(
		kind: string,
		error: unknown,
	): RunInfrastructureFailure {
		return {
			kind,
			message: error instanceof Error ? error.message : String(error),
		};
	}

	function toWorkspaceSnapshot(
		run: Run,
		preparedWorkspace: {
			path: string;
			headSha: string;
		},
	): WorkspaceSnapshot {
		return {
			runId: run.id,
			path: preparedWorkspace.path,
			headSha: preparedWorkspace.headSha,
			status: "active",
		};
	}

	function finalizeInfrastructureFailure(
		run: Run,
		failure: RunInfrastructureFailure,
		options?: {
			receipt?: ExecutionReceipt;
			decision?: PolicyDecision;
			workspace?: WorkspaceSnapshot;
			workspaceStatus?: "retained";
		},
	): RunPacketResult {
		try {
			const failedRun = storage.commitRunFailureOutcome(
				run.id,
				options?.workspaceStatus === "retained"
					? {
							infrastructureFailure: failure,
							workspaceStatus: "retained",
						}
					: {
							infrastructureFailure: failure,
						},
			);

			return {
				run: failedRun,
				receipt: options?.receipt,
				decision: options?.decision,
				failure,
				workspace:
					options?.workspaceStatus === "retained" && options.workspace
						? {
								...options.workspace,
								status: "retained",
							}
						: undefined,
			};
		} catch (finalizationError) {
			return {
				run: {
					id: run.id,
					unitId: run.unitId,
					status: "failed",
				},
				receipt: options?.receipt,
				decision: options?.decision,
				failure: infrastructureFailure(
					"run-failure-finalization-failed",
					finalizationError,
				),
			};
		}
	}

	return {
		initializeProject() {
			return storage.initializeProject();
		},
		runPacket(packet) {
			storage.getStatusSnapshot();

			const validatedPacket = validatePacketForWorkspaceRoot(
				packet,
				join(projectRoot, ".buildplane", "workspaces", "future-run-id"),
			);
			const { headSha } = workspace.assertRunnableRepository(projectRoot);
			const run = storage.createRun(validatedPacket);

			let preparedWorkspace: WorkspaceSnapshot | undefined;
			let receipt: ExecutionReceipt | undefined;

			try {
				const createdWorkspace = workspace.prepareWorkspace(
					projectRoot,
					run.id,
					headSha,
				);
				preparedWorkspace = toWorkspaceSnapshot(run, createdWorkspace);
			} catch (error) {
				const failure = infrastructureFailure(
					"workspace-prepare-failed",
					error,
				);
				return finalizeInfrastructureFailure(run, failure);
			}

			try {
				storage.recordWorkspacePrepared(run.id, {
					path: preparedWorkspace.path,
					headSha: preparedWorkspace.headSha,
					sourceProjectRoot: projectRoot,
				});
			} catch (error) {
				let cleanupDetail: string | undefined;
				try {
					const cleanupResult = workspace.deleteWorkspace({
						path: preparedWorkspace.path,
					});
					if (!cleanupResult.deleted) {
						cleanupDetail =
							cleanupResult.cleanupError ?? "workspace cleanup failed";
					}
				} catch (cleanupError) {
					cleanupDetail =
						cleanupError instanceof Error
							? cleanupError.message
							: String(cleanupError);
				}

				const failure = infrastructureFailure(
					"workspace-persistence-failed",
					cleanupDetail
						? `${error instanceof Error ? error.message : String(error)}; cleanup also failed: ${cleanupDetail}`
						: error,
				);
				return finalizeInfrastructureFailure(run, failure);
			}

			try {
				storage.markRunRunning(run.id);
			} catch (error) {
				const failure = infrastructureFailure("run-start-failed", error);
				return finalizeInfrastructureFailure(run, failure, {
					workspace: preparedWorkspace,
					workspaceStatus: "retained",
				});
			}

			try {
				receipt = runtime.executePacket(
					validatedPacket,
					preparedWorkspace.path,
				);
			} catch (error) {
				const failure = infrastructureFailure(
					"runtime-execution-failed",
					error,
				);
				return finalizeInfrastructureFailure(run, failure, {
					workspace: preparedWorkspace,
					workspaceStatus: "retained",
				});
			}

			try {
				storage.recordExecutionEvidence(run.id, receipt);
			} catch (error) {
				const failure = infrastructureFailure(
					"execution-evidence-persistence-failed",
					error,
				);
				return finalizeInfrastructureFailure(run, failure, {
					receipt,
					workspace: preparedWorkspace,
					workspaceStatus: "retained",
				});
			}

			let decision: PolicyDecision;
			try {
				decision = policy.evaluateRun(validatedPacket, receipt);
			} catch (error) {
				const failure = infrastructureFailure(
					"policy-evaluation-failed",
					error,
				);
				return finalizeInfrastructureFailure(run, failure, {
					receipt,
					workspace: preparedWorkspace,
					workspaceStatus: "retained",
				});
			}

			if (decision.outcome === "rejected") {
				try {
					const failedRun = storage.commitRunFailureOutcome(run.id, {
						decision,
						workspaceStatus: "retained",
					});

					return {
						run: failedRun,
						receipt,
						decision,
						workspace: {
							...preparedWorkspace,
							status: "retained",
						},
					};
				} catch (error) {
					return {
						run: {
							id: run.id,
							unitId: run.unitId,
							status: "failed",
						},
						receipt,
						decision,
						failure: infrastructureFailure(
							"run-failure-finalization-failed",
							error,
						),
					};
				}
			}

			let completedRun: Run;
			try {
				completedRun = storage.commitRunSuccessOutcome(run.id, decision);
			} catch (error) {
				const failure = infrastructureFailure(
					"run-success-persistence-failed",
					error,
				);
				return finalizeInfrastructureFailure(run, failure, {
					receipt,
					decision,
					workspace: preparedWorkspace,
					workspaceStatus: "retained",
				});
			}

			let cleanupResult: { deleted: boolean; cleanupError?: string };
			try {
				cleanupResult = workspace.deleteWorkspace({
					path: preparedWorkspace.path,
				});
			} catch (error) {
				cleanupResult = {
					deleted: false,
					cleanupError: error instanceof Error ? error.message : String(error),
				};
			}
			if (!cleanupResult.deleted) {
				const cleanupError =
					cleanupResult.cleanupError ?? "workspace cleanup failed";
				try {
					storage.recordWorkspaceCleanupFailed(run.id, cleanupError);
				} catch (error) {
					return {
						run: completedRun,
						receipt,
						decision,
						failure: infrastructureFailure(
							"workspace-cleanup-persistence-failed",
							error,
						),
						workspace: {
							...preparedWorkspace,
							status: "cleanup-failed",
							cleanupError,
						},
					};
				}

				return {
					run: completedRun,
					receipt,
					decision,
					workspace: {
						...preparedWorkspace,
						status: "cleanup-failed",
						cleanupError,
					},
				};
			}

			try {
				storage.recordWorkspaceDeleted(run.id);
			} catch (error) {
				return {
					run: completedRun,
					receipt,
					decision,
					failure: infrastructureFailure(
						"workspace-delete-persistence-failed",
						error,
					),
					workspace: preparedWorkspace,
				};
			}

			return {
				run: completedRun,
				receipt,
				decision,
			};
		},
		async runPacketAsync(packet, eventBus?) {
			const bus = eventBus ?? defaultBus;
			const isModelPacket = !!packet.model;
			const maxSteps = packet.budget?.maxSteps ?? (isModelPacket ? 3 : 1);
			const budgetLimits: BudgetLimits = {
				...packet.budget,
				maxSteps,
			};

			// 1. Create run
			const run = storage.createRun(packet);
			bus.emit({
				kind: "run-created",
				runId: run.id,
				unitId: packet.unit.id,
				timestamp: new Date().toISOString(),
				status: "pending" as const,
			});

			// 2. Prepare workspace
			let preparedWorkspace: WorkspaceSnapshot | undefined;
			try {
				const { headSha } = workspace.assertRunnableRepository(projectRoot);
				const created = workspace.prepareWorkspace(
					projectRoot,
					run.id,
					headSha,
				);
				preparedWorkspace = toWorkspaceSnapshot(run, created);
				try {
					storage.recordWorkspacePrepared(run.id, {
						path: created.path,
						headSha: created.headSha,
						sourceProjectRoot: projectRoot,
					});
				} catch (persistError) {
					// Storage failed after workspace was created — clean up the orphan
					try {
						workspace.deleteWorkspace({ path: created.path });
					} catch {
						// best-effort cleanup
					}
					throw persistError;
				}
			} catch (error) {
				const failure = infrastructureFailure(
					"workspace-prepare-failed",
					error,
				);
				bus.emit({
					kind: "execution-error",
					runId: run.id,
					timestamp: new Date().toISOString(),
					message: failure.message,
					phase: "workspace-prepare",
				});
				const failedRun = storage.completeRun(run.id, "failed");
				bus.emit({
					kind: "run-completed",
					runId: run.id,
					unitId: packet.unit.id,
					timestamp: new Date().toISOString(),
					status: "failed" as const,
				});
				return { run: failedRun, failure };
			}

			const executionRoot = preparedWorkspace.path;

			// Validate packet paths against the workspace root
			let validatedPacket: typeof packet;
			try {
				validatedPacket = validatePacketForWorkspaceRoot(packet, executionRoot);
			} catch (error) {
				const failure = infrastructureFailure(
					"packet-validation-failed",
					error,
				);
				bus.emit({
					kind: "execution-error",
					runId: run.id,
					timestamp: new Date().toISOString(),
					message: failure.message,
					phase: "validation",
				});
				const failedRun = storage.completeRun(run.id, "failed");
				bus.emit({
					kind: "run-completed",
					runId: run.id,
					unitId: packet.unit.id,
					timestamp: new Date().toISOString(),
					status: "failed" as const,
				});
				return { run: failedRun, failure };
			}

			// 3. Mark running
			storage.markRunRunning(run.id);
			bus.emit({
				kind: "run-started",
				runId: run.id,
				unitId: packet.unit.id,
				timestamp: new Date().toISOString(),
				status: "running" as const,
			});

			// 4. Initialize budget enforcer
			const budgetEnforcer = createBudgetEnforcer(budgetLimits, Date.now());

			// 5. Multi-step loop
			const steps: StepRecord[] = [];
			let lastReceipt: ExecutionReceipt | undefined;
			let lastDecision: PolicyDecision | undefined;
			let stepIndex = 0;
			let finalStatus: "passed" | "failed" = "failed";

			for (let attempt = 0; attempt < maxSteps; attempt++) {
				// 5a. Check budget
				const exhaustion = budgetEnforcer.check();
				if (exhaustion) {
					bus.emit({
						kind: "budget-exhausted",
						runId: run.id,
						timestamp: new Date().toISOString(),
						dimension: exhaustion.dimension,
						limit: exhaustion.limit,
						consumed: exhaustion.consumed,
					});
					break;
				}

				// 5b. Start step
				const stepId = `${run.id}-step-${stepIndex}`;
				const stepKind: StepKind = isModelPacket ? "model-turn" : "command";
				const stepStartedAt = new Date().toISOString();

				bus.emit({
					kind: "step-started",
					runId: run.id,
					timestamp: stepStartedAt,
					stepId,
					stepIndex,
					stepKind,
				});

				budgetEnforcer.recordStep();

				// 5c. Execute
				let receipt: ExecutionReceipt;
				bus.emit({
					kind: "execution-started",
					runId: run.id,
					timestamp: new Date().toISOString(),
					executionType: isModelPacket
						? ("model" as const)
						: ("command" as const),
				});

				try {
					if (runtime.executePacketAsync) {
						receipt = await runtime.executePacketAsync(
							validatedPacket,
							executionRoot,
							bus,
							run.id,
							budgetEnforcer,
						);
					} else {
						receipt = runtime.executePacket(validatedPacket, executionRoot);
						bus.emit({
							kind: "command-execution-complete",
							runId: run.id,
							timestamp: new Date().toISOString(),
							exitCode: receipt.exitCode,
							outputChecks: receipt.outputChecks.map((c) => ({
								path: c.path,
								exists: c.exists,
							})),
						});
					}
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					bus.emit({
						kind: "execution-error",
						runId: run.id,
						timestamp: new Date().toISOString(),
						message,
						phase: "execution",
					});
					const stepCompletedAt = new Date().toISOString();
					steps.push({
						id: stepId,
						kind: stepKind,
						status: "failed",
						startedAt: stepStartedAt,
						completedAt: stepCompletedAt,
					});
					bus.emit({
						kind: "step-completed",
						runId: run.id,
						timestamp: stepCompletedAt,
						stepId,
						stepKind,
						stepStatus: "failed",
					});
					break;
				}

				lastReceipt = receipt;

				// 5d. Record evidence (guarded — storage failure must not orphan the run)
				try {
					storage.recordExecutionEvidence(run.id, receipt);
				} catch (evidenceError) {
					bus.emit({
						kind: "execution-error",
						runId: run.id,
						timestamp: new Date().toISOString(),
						message:
							evidenceError instanceof Error
								? evidenceError.message
								: String(evidenceError),
						phase: "evidence-persistence",
					});
				}
				bus.emit({
					kind: "evidence-recorded",
					runId: run.id,
					timestamp: new Date().toISOString(),
					evidenceKind: isModelPacket ? "model-response" : "command-exit",
					status: receipt.exitCode === 0 ? "pass" : "fail",
				});

				// Token usage is tracked by the model executor via step-finish
				// events, which call budgetEnforcer.recordTokens() directly.

				// 5e. Complete step
				const stepCompletedAt = new Date().toISOString();
				const stepStatus: StepStatus = "completed";
				steps.push({
					id: stepId,
					kind: stepKind,
					status: stepStatus,
					startedAt: stepStartedAt,
					completedAt: stepCompletedAt,
				});
				bus.emit({
					kind: "step-completed",
					runId: run.id,
					timestamp: stepCompletedAt,
					stepId,
					stepKind,
					stepStatus,
				});

				// 5f. Evaluate policy (guarded — adapter failure must not orphan the run)
				let decision: PolicyDecision;
				try {
					decision = policy.evaluateRun(validatedPacket, receipt);
				} catch (policyError) {
					bus.emit({
						kind: "execution-error",
						runId: run.id,
						timestamp: new Date().toISOString(),
						message:
							policyError instanceof Error
								? policyError.message
								: String(policyError),
						phase: "policy-evaluation",
					});
					// Treat policy failure as rejection so the run can finalize
					decision = {
						kind: "reject-run",
						outcome: "rejected",
						reasons: [
							`Policy evaluation failed: ${policyError instanceof Error ? policyError.message : String(policyError)}`,
						],
					};
				}
				lastDecision = decision;

				const checks = [
					{
						name: "exit-code",
						passed: receipt.exitCode === 0,
						detail: `exit code ${receipt.exitCode}`,
					},
					...receipt.outputChecks.map((c) => ({
						name: `output:${c.path}`,
						passed: c.exists,
						detail: c.exists ? "exists" : "missing",
					})),
				];

				bus.emit({
					kind: "verification-result",
					runId: run.id,
					timestamp: new Date().toISOString(),
					passed: decision.outcome === "approved",
					checks,
				});

				bus.emit({
					kind: "policy-decision",
					runId: run.id,
					timestamp: new Date().toISOString(),
					decisionKind: decision.kind,
					outcome: decision.outcome,
					reasons: decision.reasons,
				});

				// Note: decision is NOT recorded here — the finalization methods
				// (commitRunSuccessOutcome/commitRunFailureOutcome) insert it.
				// Intermediate retry decisions are captured via policy-decision events.

				// 5g. If approved, re-check budget before marking success
				if (decision.outcome === "approved") {
					const postStepExhaustion = budgetEnforcer.check();
					if (postStepExhaustion) {
						bus.emit({
							kind: "budget-exhausted",
							runId: run.id,
							timestamp: new Date().toISOString(),
							dimension: postStepExhaustion.dimension,
							limit: postStepExhaustion.limit,
							consumed: postStepExhaustion.consumed,
						});
						// Budget exceeded despite policy approval — fail the run
						break;
					}
					finalStatus = "passed";
					break;
				}

				// 5h/5i. If rejected, decide whether to retry
				const remainingAttempts = maxSteps - (attempt + 1);
				const willRetry = remainingAttempts > 0 && isModelPacket;

				bus.emit({
					kind: "retry-decision",
					runId: run.id,
					timestamp: new Date().toISOString(),
					willRetry,
					reason: willRetry
						? `Verification failed; ${remainingAttempts} attempt(s) remaining`
						: "No retries remaining or command packet",
					attempt: attempt + 1,
					maxAttempts: maxSteps,
				});

				if (!willRetry) {
					break;
				}

				stepIndex++;
			}

			// 6. Capture diff
			if (preparedWorkspace && workspace.captureWorkspaceDiff) {
				try {
					const diffResult = workspace.captureWorkspaceDiff(
						preparedWorkspace.path,
					);
					if (diffResult.diff) {
						bus.emit({
							kind: "diff-captured",
							runId: run.id,
							timestamp: new Date().toISOString(),
							diff: diffResult.diff,
							filesChanged: diffResult.filesChanged,
						});
					}
				} catch {
					// Diff capture is best-effort
				}
			}

			// 7. Finalize run using workspace-aware commit methods
			let completedRun: Run;
			if (finalStatus === "passed" && lastDecision?.outcome === "approved") {
				completedRun = storage.commitRunSuccessOutcome(
					run.id,
					lastDecision as {
						kind: "advance-run";
						outcome: "approved";
						reasons: readonly string[];
					},
				);
			} else if (lastDecision?.outcome === "rejected") {
				completedRun = storage.commitRunFailureOutcome(run.id, {
					decision: lastDecision as {
						kind: "reject-run";
						outcome: "rejected";
						reasons: readonly string[];
					},
					workspaceStatus: "retained",
				});
			} else {
				completedRun = storage.commitRunFailureOutcome(run.id, {
					infrastructureFailure: {
						kind: "run-failed",
						message: "Run did not produce an approved policy decision",
					},
					workspaceStatus: "retained",
				});
			}

			bus.emit({
				kind: "run-completed",
				runId: run.id,
				unitId: packet.unit.id,
				timestamp: new Date().toISOString(),
				status: finalStatus,
			});

			// 8. Cleanup workspace (only on success)
			let workspaceResult: WorkspaceSnapshot | undefined = preparedWorkspace;
			if (preparedWorkspace && finalStatus === "passed") {
				try {
					const cleanupResult = workspace.deleteWorkspace({
						path: preparedWorkspace.path,
					});
					if (cleanupResult.deleted) {
						storage.recordWorkspaceDeleted(run.id);
						workspaceResult = {
							...preparedWorkspace,
							status: "deleted",
						};
					} else {
						const cleanupError =
							cleanupResult.cleanupError ?? "workspace cleanup failed";
						storage.recordWorkspaceCleanupFailed(run.id, cleanupError);
						workspaceResult = {
							...preparedWorkspace,
							status: "cleanup-failed",
							cleanupError,
						};
					}
				} catch (cleanupErr) {
					const errMsg =
						cleanupErr instanceof Error
							? cleanupErr.message
							: String(cleanupErr);
					try {
						storage.recordWorkspaceCleanupFailed(run.id, errMsg);
					} catch {
						// best-effort persistence
					}
					workspaceResult = {
						...preparedWorkspace,
						status: "cleanup-failed",
						cleanupError: errMsg,
					};
				}
			} else if (preparedWorkspace) {
				// Failed runs retain their workspace for debugging
				workspaceResult = {
					...preparedWorkspace,
					status: "retained",
				};
			}

			return {
				run: completedRun,
				receipt: lastReceipt,
				decision: lastDecision,
				workspace: workspaceResult,
				steps,
				budgetSnapshot: budgetEnforcer.snapshot(),
			};
		},
		getStatus() {
			return storage.getStatusSnapshot();
		},
		inspect(id) {
			const snapshot = storage.inspectTarget(id);
			if (!snapshot.workspace?.path) {
				return snapshot;
			}

			return {
				...snapshot,
				workspace: {
					...snapshot.workspace,
					existsOnDisk: existsSync(snapshot.workspace.path),
				},
			};
		},
	};
}
