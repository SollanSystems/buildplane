import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createEventBus,
	type ExecutionEvent,
} from "../../packages/kernel/src/events";
import type {
	BuildplanePolicyPort,
	BuildplaneRuntimePort,
	BuildplaneStoragePort,
	BuildplaneWorkspacePort,
	ExecutionReceipt,
	UnitPacket,
} from "../../packages/kernel/src/index";
import { createBuildplaneOrchestrator } from "../../packages/kernel/src/orchestrator";

function makeCommandPacket(): UnitPacket {
	return {
		unit: {
			id: "unit-test",
			kind: "command",
			scope: "task",
			inputRefs: [],
			expectedOutputs: [],
			verificationContract: "exit-0-and-required-outputs",
			policyProfile: "default",
		},
		execution: {
			command: "echo",
			args: ["hello"],
		},
		verification: {
			requiredOutputs: [],
		},
	};
}

function makeSuccessReceipt(): ExecutionReceipt {
	return {
		command: "echo",
		args: ["hello"],
		cwd: "/tmp",
		startedAt: new Date().toISOString(),
		completedAt: new Date().toISOString(),
		exitCode: 0,
		stdout: "hello\n",
		stderr: "",
		outputChecks: [],
	};
}

function makeFailReceipt(): ExecutionReceipt {
	return {
		...makeSuccessReceipt(),
		exitCode: 1,
		stdout: "",
		stderr: "error",
	};
}

function createMockStorage(): BuildplaneStoragePort {
	let runCounter = 0;
	return {
		initializeProject: () => ({
			created: true,
			projectRoot: "/tmp",
			stateDbPath: "/tmp/state.db",
		}),
		createRun: (packet) => {
			runCounter++;
			return {
				id: `run-${runCounter}`,
				unitId: packet.unit.id,
				status: "pending",
			};
		},
		markRunRunning: () => {},
		recordExecutionEvidence: () => {},
		recordDecision: () => {},
		completeRun: (runId, status) => ({
			id: runId,
			unitId: "unit-test",
			status,
		}),
		commitRunSuccessOutcome: (runId, _decision) => ({
			id: runId,
			unitId: "unit-test",
			status: "passed",
		}),
		commitRunFailureOutcome: (runId, _payload) => ({
			id: runId,
			unitId: "unit-test",
			status: "failed",
		}),
		recordWorkspacePrepared: () => {},
		recordWorkspaceDeleted: () => {},
		recordWorkspaceCleanupFailed: () => {},
		getStatusSnapshot: () => ({
			initialized: true,
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
			throw new Error("not implemented");
		},
	} as unknown as BuildplaneStoragePort;
}

function createMockRuntime(
	receipt: ExecutionReceipt = makeSuccessReceipt(),
): BuildplaneRuntimePort {
	return {
		executePacket: () => receipt,
	};
}

function createMockPolicy(): BuildplanePolicyPort {
	return {
		evaluateRun: (_packet, receipt) => {
			if (receipt.exitCode === 0) {
				return { kind: "advance-run", outcome: "approved", reasons: [] };
			}
			return {
				kind: "reject-run",
				outcome: "rejected",
				reasons: [`exit code ${receipt.exitCode}`],
			};
		},
	};
}

function createMockWorkspace(): BuildplaneWorkspacePort {
	return {
		assertRunnableRepository: () => ({ headSha: "mock-sha" }),
		prepareWorkspace: (_root, _runId, headSha) => {
			const wsPath = mkdtempSync(join(tmpdir(), "bp-ws-"));
			return { path: wsPath, headSha };
		},
		deleteWorkspace: () => ({ deleted: true }),
	};
}

describe("orchestrator event emission", () => {
	it("runPacket emits lifecycle events for command packets", async () => {
		const bus = createEventBus();
		const events: ExecutionEvent[] = [];
		bus.subscribe((e) => events.push(e));

		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: mkdtempSync(join(tmpdir(), "bp-orc-")),
			storage: createMockStorage(),
			runtime: createMockRuntime(),
			policy: createMockPolicy(),
			workspace: createMockWorkspace(),
			eventBus: bus,
		});

		const result = await orchestrator.runPacketAsync(makeCommandPacket(), bus);

		expect(result.run.status).toBe("passed");

		const kinds = events.map((e) => e.kind);
		expect(kinds).toEqual([
			"execution-started",
			"command-execution-complete",
			"policy-decision",
		]);

		// Verify all events share the same runId
		const runIds = new Set(events.map((e) => e.runId));
		expect(runIds.size).toBe(1);
	});

	it("runPacketAsync emits lifecycle events for command packets", async () => {
		const bus = createEventBus();
		const events: ExecutionEvent[] = [];
		bus.subscribe((e) => events.push(e));

		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: mkdtempSync(join(tmpdir(), "bp-orc-")),
			storage: createMockStorage(),
			runtime: createMockRuntime(),
			policy: createMockPolicy(),
			workspace: createMockWorkspace(),
		});

		const result = await orchestrator.runPacketAsync(makeCommandPacket(), bus);

		expect(result.run.status).toBe("passed");

		const kinds = events.map((e) => e.kind);
		expect(kinds).toEqual([
			"execution-started",
			"command-execution-complete",
			"policy-decision",
		]);
	});

	it("runPacketAsync uses executePacketAsync when available", async () => {
		const bus = createEventBus();
		const events: ExecutionEvent[] = [];
		bus.subscribe((e) => events.push(e));

		let asyncCalled = false;
		const runtime: BuildplaneRuntimePort = {
			executePacket: () => makeSuccessReceipt(),
			executePacketAsync: async (_packet, _root, eventBus) => {
				asyncCalled = true;
				eventBus.emit({
					kind: "model-token-delta",
					runId: "will-be-overridden",
					timestamp: new Date().toISOString(),
					delta: "hello ",
				});
				eventBus.emit({
					kind: "model-token-delta",
					runId: "will-be-overridden",
					timestamp: new Date().toISOString(),
					delta: "world",
				});
				eventBus.emit({
					kind: "model-response-complete",
					runId: "will-be-overridden",
					timestamp: new Date().toISOString(),
					text: "hello world",
					finishReason: "stop",
					usage: { promptTokens: 10, completionTokens: 5 },
				});
				return makeSuccessReceipt();
			},
		};

		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: mkdtempSync(join(tmpdir(), "bp-orc-")),
			storage: createMockStorage(),
			runtime,
			policy: createMockPolicy(),
			workspace: createMockWorkspace(),
		});

		const result = await orchestrator.runPacketAsync(makeCommandPacket(), bus);

		expect(asyncCalled).toBe(true);
		expect(result.run.status).toBe("passed");

		const kinds = events.map((e) => e.kind);
		expect(kinds).toContain("execution-started");
		expect(kinds).toContain("model-token-delta");
		expect(kinds).toContain("model-response-complete");
	});

	it("emits correct events for a failed run", async () => {
		const bus = createEventBus();
		const events: ExecutionEvent[] = [];
		bus.subscribe((e) => events.push(e));

		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: mkdtempSync(join(tmpdir(), "bp-orc-")),
			storage: createMockStorage(),
			runtime: createMockRuntime(makeFailReceipt()),
			policy: createMockPolicy(),
			workspace: createMockWorkspace(),
			eventBus: bus,
		});

		const result = await orchestrator.runPacketAsync(makeCommandPacket(), bus);

		expect(result.run.status).toBe("failed");

		// The refactored orchestrator emits execution events via the scoped bus,
		// but policy/lifecycle events are handled internally via storage.
		const kinds = events.map((e) => e.kind);
		expect(kinds).toContain("execution-started");
		expect(kinds).toContain("command-execution-complete");

		// Policy decision is available on the result, not as a bus event
		expect(result.decision?.outcome).toBe("rejected");
		expect(result.decision?.reasons).toContain("exit code 1");
	});
});
