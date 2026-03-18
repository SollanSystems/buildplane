import type {
	ExecutionReceipt,
	InspectSnapshot,
	PolicyDecision,
	StatusSnapshot,
	UnitPacket,
} from "./run-loop.js";
import type { Run } from "./types.js";

export interface BuildplaneStoragePort {
	initializeProject(): {
		created: boolean;
		projectRoot: string;
		stateDbPath: string;
	};
	createRun(packet: UnitPacket): Run;
	markRunRunning(runId: string): void;
	recordExecutionEvidence(runId: string, receipt: ExecutionReceipt): void;
	recordDecision(runId: string, decision: PolicyDecision): void;
	completeRun(runId: string, status: Run["status"]): Run;
	getStatusSnapshot(): StatusSnapshot;
	inspectTarget(id: string): InspectSnapshot;
}

export interface BuildplaneRuntimePort {
	executePacket(packet: UnitPacket, projectRoot: string): ExecutionReceipt;
}

export interface BuildplanePolicyPort {
	evaluateRun(packet: UnitPacket, receipt: ExecutionReceipt): PolicyDecision;
}

export interface BuildplaneWorkspacePort {
	assertRunnableRepository(projectRoot: string): { headSha: string };
	prepareWorkspace(
		projectRoot: string,
		runId: string,
		headSha: string,
	): {
		path: string;
		headSha: string;
	};
	deleteWorkspace(workspace: { path: string }): {
		deleted: boolean;
		cleanupError?: string;
	};
}
