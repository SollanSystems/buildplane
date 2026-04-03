import type { EventBus } from "./events.js";
import type {
	BuildplanePolicyPort,
	BuildplaneRuntimePort,
	BuildplaneStoragePort,
} from "./ports.js";
import type {
	ExecutionReceipt,
	InspectSnapshot,
	RunPacketResult,
	StatusSnapshot,
	UnitPacket,
} from "./run-loop.js";

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
	readonly eventBus?: EventBus;
}

export function createBuildplaneOrchestrator(
	options: CreateBuildplaneOrchestratorOptions,
): BuildplaneOrchestrator {
	const { projectRoot, storage, runtime, policy } = options;
	const defaultBus = options.eventBus ?? noopBus;

	function now(): string {
		return new Date().toISOString();
	}

	function executeSync(
		packet: UnitPacket,
		run: { id: string; unitId: string },
		bus: EventBus,
	): RunPacketResult {
		bus.emit({
			kind: "execution-started",
			runId: run.id,
			timestamp: now(),
			executionType: "command",
		});

		const receipt = runtime.executePacket(packet, projectRoot);

		bus.emit({
			kind: "command-execution-complete",
			runId: run.id,
			timestamp: now(),
			exitCode: receipt.exitCode,
			outputChecks: receipt.outputChecks.map((c) => ({
				path: c.path,
				exists: c.exists,
			})),
		});

		return finishRun(packet, run, receipt, bus);
	}

	async function executeAsync(
		packet: UnitPacket,
		run: { id: string; unitId: string },
		bus: EventBus,
	): Promise<RunPacketResult> {
		if (runtime.executePacketAsync) {
			bus.emit({
				kind: "execution-started",
				runId: run.id,
				timestamp: now(),
				executionType: "model",
			});

			const receipt = await runtime.executePacketAsync(
				packet,
				projectRoot,
				bus,
			);
			return finishRun(packet, run, receipt, bus);
		}

		// Fallback to sync execution
		return executeSync(packet, run, bus);
	}

	function finishRun(
		packet: UnitPacket,
		run: { id: string; unitId: string },
		receipt: ExecutionReceipt,
		bus: EventBus,
	): RunPacketResult {
		storage.recordExecutionEvidence(run.id, receipt);

		bus.emit({
			kind: "evidence-recorded",
			runId: run.id,
			timestamp: now(),
			evidenceKind: "command-exit",
			status: receipt.exitCode === 0 ? "pass" : "fail",
		});

		const decision = policy.evaluateRun(packet, receipt);

		bus.emit({
			kind: "policy-decision",
			runId: run.id,
			timestamp: now(),
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
			unitId: run.unitId,
			timestamp: now(),
			status: finalStatus,
		});

		return {
			run: completedRun,
			receipt,
			decision,
		};
	}

	function startRun(packet: UnitPacket, bus: EventBus) {
		const run = storage.createRun(packet);

		bus.emit({
			kind: "run-created",
			runId: run.id,
			unitId: packet.unit.id,
			timestamp: now(),
			status: "pending",
		});

		storage.markRunRunning(run.id);

		bus.emit({
			kind: "run-started",
			runId: run.id,
			unitId: packet.unit.id,
			timestamp: now(),
			status: "running",
		});

		return run;
	}

	return {
		initializeProject() {
			return storage.initializeProject();
		},

		runPacket(packet) {
			const run = startRun(packet, defaultBus);
			return executeSync(packet, run, defaultBus);
		},

		async runPacketAsync(packet, eventBus?) {
			const bus = eventBus ?? defaultBus;
			const run = startRun(packet, bus);
			return executeAsync(packet, run, bus);
		},

		getStatus() {
			return storage.getStatusSnapshot();
		},

		inspect(id: string) {
			return storage.inspectTarget(id);
		},
	};
}
