/**
 * Shared mock storage factory for orchestrator integration tests.
 * Tracks run state in memory and implements all BuildplaneStoragePort methods
 * including the workspace-lifecycle methods required by runPacketAsync.
 */
import type {
	ApprovedPolicyDecision,
	BuildplaneStoragePort,
	RejectedPolicyDecision,
	Run,
	RunInfrastructureFailure,
} from "@buildplane/kernel";

export interface MockRun {
	id: string;
	unitId: string;
	status: string;
}

export function createMockStorage(): BuildplaneStoragePort & {
	runs: Record<string, MockRun>;
} {
	const runs: Record<string, MockRun> = {};
	let runCounter = 0;

	function getOrThrow(runId: string): MockRun {
		const run = runs[runId];
		if (!run) throw new Error(`run ${runId} not found`);
		return run;
	}

	return {
		runs,
		initializeProject: () => ({
			created: true,
			projectRoot: ".",
			stateDbPath: ".buildplane/state.db",
		}),
		createRun: (packet) => {
			const id = `run-${++runCounter}-${Math.random().toString(36).slice(2, 6)}`;
			runs[id] = { id, unitId: packet.unit.id, status: "pending" };
			return runs[id] as Run;
		},
		getChildRuns: (_parentRunId) => [],
		markRunRunning: (runId) => {
			getOrThrow(runId).status = "running";
		},
		recordExecutionEvidence: () => {},
		recordDecision: () => {},
		recordWorkspacePrepared: () => {},
		recordWorkspaceDeleted: () => {},
		recordWorkspaceCleanupFailed: () => {},
		suspendRun: (runId) => {
			const run = getOrThrow(runId);
			if (run.status !== "running") {
				throw new Error(
					`suspendRun requires a running run, got '${run.status}'.`,
				);
			}
			run.status = "suspended";
			return run as Run;
		},
		approveRun: (runId) => {
			const run = getOrThrow(runId);
			if (run.status !== "suspended") {
				throw new Error(
					`approveRun requires a suspended run, got '${run.status}'.`,
				);
			}
			run.status = "pending";
			return run as Run;
		},
		rejectSuspendedRun: (runId) => {
			const run = getOrThrow(runId);
			if (run.status !== "suspended") {
				throw new Error(
					`rejectSuspendedRun requires a suspended run, got '${run.status}'.`,
				);
			}
			run.status = "failed";
			return run as Run;
		},
		completeRun: (runId, status) => {
			const run = getOrThrow(runId);
			run.status = status;
			return run as Run;
		},
		commitRunSuccessOutcome: (runId, _decision: ApprovedPolicyDecision) => {
			const run = getOrThrow(runId);
			run.status = "passed";
			return run as Run;
		},
		commitRunFailureOutcome: (
			runId,
			_payload: {
				decision?: RejectedPolicyDecision;
				infrastructureFailure?: RunInfrastructureFailure;
				workspaceStatus?: "retained";
			},
		) => {
			const run = getOrThrow(runId);
			run.status = "failed";
			return run as Run;
		},
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
				suspended: 0,
			},
		}),
		inspectTarget: () => {
			throw new Error("inspectTarget not implemented in mock");
		},
	} as unknown as BuildplaneStoragePort & { runs: Record<string, MockRun> };
}
