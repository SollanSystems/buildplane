import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EventBus, ExecutionEvent } from "./events.js";
import type {
	BudgetConstraints,
	PolicyProfile,
	ResourceUsageSnapshot,
} from "./policy.js";
import { createResourceUsageSnapshot } from "./policy.js";
import type {
	BuildplanePolicyPort,
	BuildplaneRuntimePort,
	BuildplaneStoragePort,
	BuildplaneWorkspacePort,
} from "./ports.js";
import type {
	ExecutionReceipt,
	InspectSnapshot,
	PolicyDecision,
	RunInfrastructureFailure,
	RunPacketResult,
	StatusSnapshot,
	UnitPacket,
	WorkspaceSnapshot,
} from "./run-loop.js";
import type { Run } from "./types.js";
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
	readonly budgets?: BudgetConstraints;
	readonly profileRegistry?: { resolve(name: string): PolicyProfile };
}

export function createBuildplaneOrchestrator(
	options: CreateBuildplaneOrchestratorOptions,
): BuildplaneOrchestrator {
	const {
		projectRoot,
		storage,
		runtime,
		policy,
		workspace,
		budgets: topLevelBudgets,
		profileRegistry,
	} = options;
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
			const run = storage.createRun(packet);

			bus.emit({
				kind: "run-created",
				runId: run.id,
				unitId: packet.unit.id,
				timestamp: new Date().toISOString(),
				status: "pending" as const,
			});

			storage.markRunRunning(run.id);

			bus.emit({
				kind: "run-started",
				runId: run.id,
				unitId: packet.unit.id,
				timestamp: new Date().toISOString(),
				status: "running" as const,
			});

			bus.emit({
				kind: "execution-started",
				runId: run.id,
				timestamp: new Date().toISOString(),
				executionType: packet.model ? ("model" as const) : ("command" as const),
			});

			// Budget enforcement: track token usage mid-flight and abort on breach
			const controller = new AbortController();
			const startTime = Date.now();
			const usage: ResourceUsageSnapshot = createResourceUsageSnapshot();
			let budgetBreached = false;

			// Resolve budgets: profile registry takes precedence, then top-level option
			let budgets: BudgetConstraints | undefined;
			try {
				const resolvedProfile = profileRegistry
					? profileRegistry.resolve(packet.unit.policyProfile)
					: undefined;
				budgets = resolvedProfile?.budgets ?? topLevelBudgets;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				bus.emit({
					kind: "execution-error",
					runId: run.id,
					timestamp: new Date().toISOString(),
					message,
					phase: "profile-resolution",
				});
				const failedRun = storage.completeRun(run.id, "failed");
				bus.emit({
					kind: "run-completed",
					runId: run.id,
					unitId: packet.unit.id,
					timestamp: new Date().toISOString(),
					status: "failed" as const,
				});
				return {
					run: failedRun,
					failure: { kind: "profile-resolution-failed", message },
				};
			}

			const budgetSubscription = budgets
				? bus.subscribe((event: ExecutionEvent) => {
						if (budgetBreached || controller.signal.aborted) return;

						if (event.kind === "model-token-delta") {
							// Approximate: count each delta as 1 completion token
							// Accurate usage arrives in model-response-complete
							(usage as { completionTokens: number }).completionTokens++;
							(usage as { totalTokens: number }).totalTokens =
								usage.promptTokens + usage.completionTokens;
							(usage as { elapsedMs: number }).elapsedMs =
								Date.now() - startTime;
						}

						if (policy.evaluateBudgets) {
							const decision = policy.evaluateBudgets(packet, usage, budgets);
							if (decision && decision.outcome === "rejected") {
								budgetBreached = true;

								bus.emit({
									kind: "policy-budget-breached",
									runId: run.id,
									timestamp: new Date().toISOString(),
									budgetType: "tokens",
									limit: budgets.maxTokens ?? 0,
									actual: usage.totalTokens,
								});

								controller.abort();
							}
						}
					})
				: undefined;

			let receipt: ExecutionReceipt;
			try {
				if (runtime.executePacketAsync) {
					receipt = await runtime.executePacketAsync(
						packet,
						projectRoot,
						bus,
						controller.signal,
					);
				} else {
					receipt = runtime.executePacket(packet, projectRoot);
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
				budgetSubscription?.();
				const message = error instanceof Error ? error.message : String(error);
				bus.emit({
					kind: "execution-error",
					runId: run.id,
					timestamp: new Date().toISOString(),
					message,
					phase: "execution",
				});
				const failedRun = storage.completeRun(run.id, "failed");
				bus.emit({
					kind: "run-completed",
					runId: run.id,
					unitId: packet.unit.id,
					timestamp: new Date().toISOString(),
					status: "failed" as const,
				});
				return {
					run: failedRun,
					failure: { kind: "runtime-execution-failed", message },
				};
			}

			// Clean up budget subscriber
			budgetSubscription?.();

			storage.recordExecutionEvidence(run.id, receipt);
			bus.emit({
				kind: "evidence-recorded",
				runId: run.id,
				timestamp: new Date().toISOString(),
				evidenceKind: "command-exit",
				status: receipt.exitCode === 0 ? "pass" : "fail",
			});

			const decision = policy.evaluateRun(packet, receipt);
			bus.emit({
				kind: "policy-decision",
				runId: run.id,
				timestamp: new Date().toISOString(),
				decisionKind: decision.kind,
				outcome: decision.outcome,
				reasons: decision.reasons,
			});

			storage.recordDecision(run.id, decision);
			const finalStatus = decision.outcome === "approved" ? "passed" : "failed";
			const completedRun = storage.completeRun(run.id, finalStatus);

			bus.emit({
				kind: "run-completed",
				runId: run.id,
				unitId: packet.unit.id,
				timestamp: new Date().toISOString(),
				status: finalStatus as "passed" | "failed",
			});

			return { run: completedRun, receipt, decision };
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
