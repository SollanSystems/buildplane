import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EventBus, EventContext } from "./events.js";
import {
	createGraphScheduler,
	type GraphResult,
	type UnitGraph,
} from "./graph.js";
import type { BudgetConstraints, PolicyProfile } from "./policy.js";
import type {
	BuildplanePolicyPort,
	BuildplaneProfileRegistryPort,
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
import { createRunScopedBus } from "./run-scoped-bus.js";
import { runStrategy } from "./strategy-executor.js";
import type { Run, StrategyPacket, StrategyResult } from "./types.js";
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
	approveRun(runId: string): Run;
	rejectSuspendedRun(runId: string): Run;
	runGraphAsync(graph: UnitGraph, eventBus?: EventBus): Promise<GraphResult>;
	runStrategy(
		strategy: StrategyPacket,
		eventBus?: EventBus,
	): Promise<StrategyResult>;
}

export interface CreateBuildplaneOrchestratorOptions {
	readonly projectRoot: string;
	readonly storage: BuildplaneStoragePort;
	readonly runtime: BuildplaneRuntimePort;
	readonly policy: BuildplanePolicyPort;
	readonly workspace: BuildplaneWorkspacePort;
	readonly eventBus?: EventBus;
	readonly profileRegistry?: BuildplaneProfileRegistryPort;
	readonly budgets?: BudgetConstraints;
}

export function createBuildplaneOrchestrator(
	options: CreateBuildplaneOrchestratorOptions,
): BuildplaneOrchestrator {
	const { projectRoot, storage, runtime, policy, workspace } = options;
	const profileRegistry = options.profileRegistry;
	const topLevelBudgets = options.budgets;
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

	type PrepareRunResult =
		| {
				ok: true;
				ctx: {
					run: Run;
					validatedPacket: UnitPacket;
					workspace: WorkspaceSnapshot;
					projectRoot: string;
				};
		  }
		| { ok: false; result: RunPacketResult };

	function prepareRun(packet: UnitPacket): PrepareRunResult {
		storage.getStatusSnapshot();

		const validatedPacket = validatePacketForWorkspaceRoot(
			packet,
			join(projectRoot, ".buildplane", "workspaces", "future-run-id"),
		);
		const { headSha } = workspace.assertRunnableRepository(projectRoot);
		const run = storage.createRun(validatedPacket);

		let preparedWorkspace: WorkspaceSnapshot;

		try {
			const createdWorkspace = workspace.prepareWorkspace(
				projectRoot,
				run.id,
				headSha,
			);
			preparedWorkspace = toWorkspaceSnapshot(run, createdWorkspace);
		} catch (error) {
			const failure = infrastructureFailure("workspace-prepare-failed", error);
			return { ok: false, result: finalizeInfrastructureFailure(run, failure) };
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
					projectRoot,
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
			return { ok: false, result: finalizeInfrastructureFailure(run, failure) };
		}

		try {
			storage.markRunRunning(run.id);
		} catch (error) {
			const failure = infrastructureFailure("run-start-failed", error);
			return {
				ok: false,
				result: finalizeInfrastructureFailure(run, failure, {
					workspace: preparedWorkspace,
					workspaceStatus: "retained",
				}),
			};
		}

		return {
			ok: true,
			ctx: {
				run,
				validatedPacket,
				workspace: preparedWorkspace,
				projectRoot,
			},
		};
	}

	function finalizeRun(
		ctx: {
			run: Run;
			validatedPacket: UnitPacket;
			workspace: WorkspaceSnapshot;
		},
		receipt: ExecutionReceipt,
		preEvaluatedDecision?: PolicyDecision,
	): RunPacketResult {
		const { run, validatedPacket, workspace: preparedWorkspace } = ctx;

		if (!preEvaluatedDecision) {
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
		}

		let decision: PolicyDecision;
		if (preEvaluatedDecision) {
			decision = preEvaluatedDecision;
		} else {
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
		}

		if (decision.outcome === "rejected" || decision.outcome === "retrying") {
			const rejectedDecision =
				decision.outcome === "rejected"
					? decision
					: {
							kind: "reject-run" as const,
							outcome: "rejected" as const,
							reasons: decision.reasons,
						};
			try {
				const failedRun = storage.commitRunFailureOutcome(run.id, {
					decision: rejectedDecision,
					workspaceStatus: "retained",
				});

				return {
					run: failedRun,
					receipt,
					decision: rejectedDecision,
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
					decision: rejectedDecision,
					failure: infrastructureFailure(
						"run-failure-finalization-failed",
						error,
					),
				};
			}
		}

		// At this point decision.outcome === "approved"
		const approvedDecision =
			decision as import("./run-loop.js").ApprovedPolicyDecision;

		// Merge workspace changes first — if this fails we must not mark the run as passed
		// and must retain the workspace so changes are not lost.
		if (workspace.commitAndMergeWorkspace) {
			try {
				workspace.commitAndMergeWorkspace({
					path: preparedWorkspace.path,
					runId: run.id,
					projectRoot,
				});
			} catch (error) {
				return finalizeInfrastructureFailure(
					run,
					infrastructureFailure("merge-failed", error),
					{
						receipt,
						decision,
						workspace: preparedWorkspace,
						workspaceStatus: "retained",
					},
				);
			}
		}

		let completedRun: Run;
		try {
			completedRun = storage.commitRunSuccessOutcome(run.id, approvedDecision);
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
				projectRoot,
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
	}

	const orchestrator: BuildplaneOrchestrator = {
		initializeProject() {
			return storage.initializeProject();
		},
		runPacket(packet) {
			const prepared = prepareRun(packet);
			if (!prepared.ok) return prepared.result;
			const { ctx } = prepared;

			let receipt: ExecutionReceipt;
			try {
				receipt = runtime.executePacket(
					ctx.validatedPacket,
					ctx.workspace.path,
				);
			} catch (error) {
				const failure = infrastructureFailure(
					"runtime-execution-failed",
					error,
				);
				return finalizeInfrastructureFailure(ctx.run, failure, {
					workspace: ctx.workspace,
					workspaceStatus: "retained",
				});
			}

			return finalizeRun(ctx, receipt);
		},
		async runPacketAsync(packet, eventBus?) {
			const bus = eventBus ?? defaultBus;

			// Resolve policy profile from registry
			const profileName = packet.unit.policyProfile;
			let resolvedProfile: PolicyProfile | undefined;
			if (profileRegistry && profileName) {
				try {
					resolvedProfile = profileRegistry.resolve(profileName);
				} catch (error) {
					// Unknown profile — fail the run without workspace preparation
					const failure = infrastructureFailure(
						"profile-resolution-failed",
						error,
					);
					try {
						const validatedPacket = validatePacketForWorkspaceRoot(
							packet,
							join(projectRoot, ".buildplane", "workspaces", "future-run-id"),
						);
						const run = storage.createRun(validatedPacket);
						return finalizeInfrastructureFailure(run, failure);
					} catch {
						return {
							run: {
								id: "profile-error",
								unitId: packet.unit.id,
								status: "failed" as const,
							},
							failure,
						};
					}
				}
			}

			// Operator suspension gate — check before workspace preparation
			if (resolvedProfile?.trustGates?.requiresApproval === true) {
				const validatedPacket = validatePacketForWorkspaceRoot(
					packet,
					join(projectRoot, ".buildplane", "workspaces", "future-run-id"),
				);
				const run = storage.createRun(validatedPacket);
				storage.markRunRunning(run.id);
				const suspendedRun = storage.suspendRun(run.id);
				bus.emit({
					kind: "run-suspended",
					runId: run.id,
					unitId: packet.unit.id,
					timestamp: new Date().toISOString(),
					profileName: resolvedProfile.name,
					reason: "policy profile requires operator approval before execution",
				});
				return { run: suspendedRun, suspended: true } as RunPacketResult;
			}

			const prepared = prepareRun(packet);
			if (!prepared.ok) {
				// Emit a visible event when workspace preparation fails
				if (prepared.result.failure?.kind === "workspace-prepare-failed") {
					bus.emit({
						kind: "execution-error",
						runId: prepared.result.run.id,
						timestamp: new Date().toISOString(),
						message: prepared.result.failure.message,
						phase: "workspace-prepare",
					});
				}
				return prepared.result;
			}
			const { ctx } = prepared;

			const runContext: EventContext = {
				runId: ctx.run.id,
				executor:
					ctx.validatedPacket.routingHints?.preferredWorker ??
					(ctx.validatedPacket.model ? "ai-sdk" : "command"),
			};
			const scopedBus = createRunScopedBus(runContext, bus);

			// Budget enforcement: count tokens mid-stream and abort if limit exceeded
			const effectiveBudgets = resolvedProfile?.budgets ?? topLevelBudgets;
			const abortController = new AbortController();
			let budgetUnsubscribe: (() => void) | undefined;

			if (effectiveBudgets && policy.evaluateBudgets) {
				const runStartTime = Date.now();
				let tokenCount = 0;
				let budgetBreached = false;

				budgetUnsubscribe = scopedBus.subscribe((event) => {
					if (budgetBreached || abortController.signal.aborted) return;
					if (event.kind !== "model-token-delta") return;
					if (event.runId !== ctx.run.id) return;

					tokenCount++;
					const elapsedMs = Date.now() - runStartTime;
					const usage = {
						promptTokens: 0,
						completionTokens: tokenCount,
						totalTokens: tokenCount,
						elapsedMs,
					};

					const decision = policy.evaluateBudgets!(
						ctx.validatedPacket,
						usage,
						effectiveBudgets,
					);
					if (decision) {
						budgetBreached = true;
						const isTokensBreach =
							effectiveBudgets.maxTokens !== undefined &&
							tokenCount > effectiveBudgets.maxTokens;
						const budgetType: "tokens" | "time" = isTokensBreach
							? "tokens"
							: "time";
						const limit = isTokensBreach
							? effectiveBudgets.maxTokens!
							: (effectiveBudgets.maxComputeTimeMs ?? 0);
						const actual = isTokensBreach ? tokenCount : elapsedMs;
						scopedBus.emit({
							kind: "policy-budget-breached",
							runId: ctx.run.id,
							timestamp: new Date().toISOString(),
							budgetType,
							limit,
							actual,
						});
						abortController.abort();
					}
				});
			}

			async function executeOnce(p: UnitPacket): Promise<ExecutionReceipt> {
				scopedBus.emit({
					kind: "execution-started",
					runId: ctx.run.id,
					timestamp: new Date().toISOString(),
					executionType: p.model ? ("model" as const) : ("command" as const),
				});
				if (runtime.executePacketAsync) {
					return runtime.executePacketAsync(
						p,
						ctx.workspace.path,
						scopedBus,
						abortController.signal,
					);
				}
				const r = runtime.executePacket(p, ctx.workspace.path);
				scopedBus.emit({
					kind: "command-execution-complete",
					runId: ctx.run.id,
					timestamp: new Date().toISOString(),
					exitCode: r.exitCode,
					outputChecks: r.outputChecks.map((c) => ({
						path: c.path,
						exists: c.exists,
					})),
				});
				return r;
			}

			let currentPacket = ctx.validatedPacket;
			let currentReceipt: ExecutionReceipt;

			try {
				currentReceipt = await executeOnce(currentPacket);
			} catch (error) {
				budgetUnsubscribe?.();
				const message = error instanceof Error ? error.message : String(error);
				scopedBus.emit({
					kind: "execution-error",
					runId: ctx.run.id,
					timestamp: new Date().toISOString(),
					message,
					phase: "execution",
				});
				return finalizeInfrastructureFailure(
					ctx.run,
					infrastructureFailure("runtime-execution-failed", error),
					{
						workspace: ctx.workspace,
						workspaceStatus: "retained",
					},
				);
			}
			// Retry-aware policy loop — budget subscriber stays active across all attempts
			// so token usage accumulates cumulatively. budgetUnsubscribe is called in the
			// finally block after ALL attempts complete (success, rejection, or error).
			let attemptCount = 0;
			try {
				while (true) {
					storage.recordExecutionEvidence(ctx.run.id, currentReceipt);

					const decision = policy.evaluateRun(
						currentPacket,
						currentReceipt,
						resolvedProfile,
						attemptCount,
					);

					scopedBus.emit({
						kind: "policy-decision",
						runId: ctx.run.id,
						timestamp: new Date().toISOString(),
						decisionKind: decision.kind,
						outcome: decision.outcome,
						reasons: decision.reasons,
					});

					if (decision.kind !== "retry-run") {
						return finalizeRun(ctx, currentReceipt, decision);
					}

					// Retry: augment packet with feedback and re-execute
					attemptCount = decision.attemptNumber;
					const feedbackSuffix =
						decision.feedbackContext.length > 0
							? `\n\nPrevious attempt failed:\n${decision.feedbackContext.join("\n")}\n\nPlease fix these issues and try again.`
							: "";

					if (currentPacket.model) {
						currentPacket = {
							...currentPacket,
							model: {
								...currentPacket.model,
								systemPrompt:
									(currentPacket.model.systemPrompt ?? "") + feedbackSuffix,
							},
						};
					}

					try {
						currentReceipt = await executeOnce(currentPacket);
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						scopedBus.emit({
							kind: "execution-error",
							runId: ctx.run.id,
							timestamp: new Date().toISOString(),
							message,
							phase: "retry-execution",
						});
						return finalizeInfrastructureFailure(
							ctx.run,
							infrastructureFailure("runtime-execution-failed", error),
							{
								workspace: ctx.workspace,
								workspaceStatus: "retained",
							},
						);
					}
				}
			} finally {
				budgetUnsubscribe?.();
			}
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

		approveRun(runId) {
			return storage.approveRun(runId);
		},

		rejectSuspendedRun(runId) {
			return storage.rejectSuspendedRun(runId);
		},

		async runGraphAsync(
			graph: UnitGraph,
			eventBus?: EventBus,
		): Promise<GraphResult> {
			const bus = eventBus ?? defaultBus;
			const graphId = randomUUID();
			const scheduler = createGraphScheduler(graph);

			// Map from unitId → runId for toResult()
			const runIdMap = new Map<string, string>();

			bus.emit({
				kind: "graph-started",
				runId: graphId,
				graphId,
				unitCount: graph.nodes.length,
				timestamp: new Date().toISOString(),
			});

			// Build a lookup from unitId → UnitGraphNode for dispatch
			const nodeById = new Map(graph.nodes.map((n) => [n.unit.id, n]));

			// In-flight set: promises tagged with their unitId
			const inFlight = new Map<
				string,
				Promise<{ unitId: string; result: RunPacketResult }>
			>();

			/**
			 * Drain the scheduler: dispatch all newly ready units, then wait for
			 * one to complete (via Promise.race). Repeat until done.
			 */
			async function drainLoop(): Promise<void> {
				while (!scheduler.isDone()) {
					// Dispatch all ready units that aren't already in-flight
					for (const unitId of scheduler.readyUnits()) {
						if (inFlight.has(unitId)) continue;
						const graphNode = nodeById.get(unitId)!;
						// Build a UnitPacket from the graph node (strip dependsOn)
						const packet: UnitPacket = {
							unit: graphNode.unit,
							execution: graphNode.execution,
							model: graphNode.model,
							verification: graphNode.verification,
						};
						scheduler.markRunning(unitId);
						const promise = orchestrator
							.runPacketAsync(packet, bus)
							.then((result) => ({
								unitId,
								result,
							}));
						inFlight.set(unitId, promise);
					}

					if (inFlight.size === 0) {
						// No ready units and nothing in-flight — graph is stuck or done
						break;
					}

					// Wait for the next unit to complete
					const { unitId, result } = await Promise.race(inFlight.values());
					inFlight.delete(unitId);

					if (result.run.id) {
						runIdMap.set(unitId, result.run.id);
					}

					if (result.run.status === "passed") {
						scheduler.markPassed(unitId);
					} else {
						// failed, cancelled, suspended all count as failure for graph purposes
						scheduler.markFailed(unitId);
					}
				}
			}

			await drainLoop();

			const graphResult = scheduler.toResult(runIdMap);

			bus.emit({
				kind: "graph-completed",
				runId: graphId,
				graphId,
				outcome: graphResult.outcome,
				timestamp: new Date().toISOString(),
			});

			return graphResult;
		},

		async runStrategy(
			strategy: StrategyPacket,
			eventBus?: EventBus,
		): Promise<StrategyResult> {
			return runStrategy(strategy, orchestrator, eventBus);
		},
	};

	return orchestrator;
}
