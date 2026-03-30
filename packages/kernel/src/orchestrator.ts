import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EventBus } from "./events.js";
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
import { createRunScopedBus } from "./run-scoped-bus.js";
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

	type PrepareRunResult =
		| { ok: true; ctx: { run: Run; validatedPacket: UnitPacket; workspace: WorkspaceSnapshot; projectRoot: string } }
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
			const failure = infrastructureFailure(
				"workspace-prepare-failed",
				error,
			);
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
		ctx: { run: Run; validatedPacket: UnitPacket; workspace: WorkspaceSnapshot },
		receipt: ExecutionReceipt,
	): RunPacketResult {
		const { run, validatedPacket, workspace: preparedWorkspace } = ctx;

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
	}

	return {
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

			const prepared = prepareRun(packet);
			if (!prepared.ok) return prepared.result;
			const { ctx } = prepared;

			const scopedBus = createRunScopedBus(ctx.run.id, bus);

			scopedBus.emit({
				kind: "execution-started",
				runId: ctx.run.id,
				timestamp: new Date().toISOString(),
				executionType: packet.model ? ("model" as const) : ("command" as const),
			});

			let receipt: ExecutionReceipt;
			try {
				if (runtime.executePacketAsync) {
					receipt = await runtime.executePacketAsync(
						ctx.validatedPacket,
						ctx.workspace.path,
						scopedBus,
					);
				} else {
					receipt = runtime.executePacket(
						ctx.validatedPacket,
						ctx.workspace.path,
					);
					scopedBus.emit({
						kind: "command-execution-complete",
						runId: ctx.run.id,
						timestamp: new Date().toISOString(),
						exitCode: receipt.exitCode,
						outputChecks: receipt.outputChecks.map((c) => ({
							path: c.path,
							exists: c.exists,
						})),
					});
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				scopedBus.emit({
					kind: "execution-error",
					runId: ctx.run.id,
					timestamp: new Date().toISOString(),
					message,
					phase: "execution",
				});
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
