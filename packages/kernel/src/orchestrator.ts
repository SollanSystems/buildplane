import type {
	BuildplanePolicyPort,
	BuildplaneRuntimePort,
	BuildplaneStoragePort,
} from "./ports.js";
import type {
	InspectSnapshot,
	RunPacketResult,
	StatusSnapshot,
	UnitPacket,
} from "./run-loop.js";

export interface BuildplaneOrchestrator {
	initializeProject(): ReturnType<BuildplaneStoragePort["initializeProject"]>;
	runPacket(packet: UnitPacket): RunPacketResult;
	getStatus(): StatusSnapshot;
	inspect(id: string): InspectSnapshot;
}

export interface CreateBuildplaneOrchestratorOptions {
	readonly projectRoot: string;
	readonly storage: BuildplaneStoragePort;
	readonly runtime: BuildplaneRuntimePort;
	readonly policy: BuildplanePolicyPort;
}

export function createBuildplaneOrchestrator(
	options: CreateBuildplaneOrchestratorOptions,
): BuildplaneOrchestrator {
	const { projectRoot, storage, runtime, policy } = options;

	return {
		initializeProject() {
			return storage.initializeProject();
		},
		runPacket(packet) {
			const run = storage.createRun(packet);
			storage.markRunRunning(run.id);
			const receipt = runtime.executePacket(packet, projectRoot);
			storage.recordExecutionEvidence(run.id, receipt);
			const decision = policy.evaluateRun(packet, receipt);
			storage.recordDecision(run.id, decision);
			const completedRun = storage.completeRun(
				run.id,
				decision.outcome === "approved" ? "passed" : "failed",
			);

			return {
				run: completedRun,
				receipt,
				decision,
			};
		},
		getStatus() {
			return storage.getStatusSnapshot();
		},
		inspect(id: string) {
			return storage.inspectTarget(id);
		},
	};
}
