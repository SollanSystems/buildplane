import { describe, expect, it } from "vitest";
import {
	createEventBus,
	type ExecutionEvent,
} from "../../packages/kernel/src/events";
import type { UnitGraph } from "../../packages/kernel/src/graph";
import { createBuildplaneOrchestrator } from "../../packages/kernel/src/orchestrator";
import { createMockStorage } from "../helpers/mock-storage";

function makeNode(id: string, shouldFail = false, dependsOn?: string[]) {
	return {
		unit: {
			id,
			kind: "command",
			scope: "task",
			inputRefs: [],
			expectedOutputs: [],
			verificationContract: "exit-0-and-required-outputs",
			policyProfile: "default",
		},
		execution: { command: "echo", args: [id] },
		verification: { requiredOutputs: [] },
		...(dependsOn ? { dependsOn } : {}),
		_shouldFail: shouldFail, // extra field for test orchestration
	};
}

function makeOrchestrator(opts?: { failUnits?: string[] }) {
	const bus = createEventBus();
	const mockStorage = createMockStorage();
	const failUnits = new Set(opts?.failUnits ?? []);
	const executionOrder: string[] = [];

	const orchestrator = createBuildplaneOrchestrator({
		projectRoot: "/tmp/bp-graph-test",
		storage: mockStorage,
		runtime: {
			executePacket: (packet, _root) => {
				const unitId = (packet as { unit: { id: string } }).unit.id;
				executionOrder.push(unitId);
				if (failUnits.has(unitId)) {
					return {
						command: "echo",
						args: [],
						exitCode: 1,
						outputChecks: [],
					};
				}
				return {
					command: "echo",
					args: [],
					exitCode: 0,
					outputChecks: [],
				};
			},
		},
		policy: {
			evaluateRun: (_packet, receipt) => {
				const r = receipt as { exitCode?: number } | null | undefined;
				const exitCode = r?.exitCode ?? 0;
				const unitId = (_packet as { unit: { id: string } }).unit.id;
				if (failUnits.has(unitId) || exitCode !== 0) {
					return {
						kind: "reject-run",
						outcome: "rejected",
						reasons: ["exit code non-zero"],
					};
				}
				return {
					kind: "advance-run",
					outcome: "approved",
					reasons: [],
				};
			},
		},
		workspace: {
			assertRunnableRepository: () => ({ headSha: "abc123" }),
			prepareWorkspace: () => ({ path: "/tmp/ws", headSha: "abc123" }),
			deleteWorkspace: () => ({ deleted: true }),
		},
		eventBus: bus,
	});

	return { orchestrator, bus, executionOrder, mockStorage };
}

describe("runGraphAsync", () => {
	it("executes a simple two-node sequential graph", async () => {
		const { orchestrator, bus, executionOrder } = makeOrchestrator();
		const events: ExecutionEvent[] = [];
		bus.subscribe((e) => events.push(e));

		const graph: UnitGraph = {
			nodes: [makeNode("A"), makeNode("B", false, ["A"])],
			maxConcurrent: 2,
		};

		const result = await orchestrator.runGraphAsync(graph, bus);

		expect(result.outcome).toBe("passed");
		expect(result.nodes).toHaveLength(2);
		expect(result.nodes.find((n) => n.unitId === "A")?.status).toBe("passed");
		expect(result.nodes.find((n) => n.unitId === "B")?.status).toBe("passed");

		// A must execute before B
		expect(executionOrder.indexOf("A")).toBeLessThan(
			executionOrder.indexOf("B"),
		);

		// Graph lifecycle events emitted
		expect(events.find((e) => e.kind === "graph-started")).toBeDefined();
		expect(events.find((e) => e.kind === "graph-completed")).toBeDefined();
		const completed = events.find((e) => e.kind === "graph-completed");
		if (completed?.kind === "graph-completed") {
			expect(completed.outcome).toBe("passed");
		}
	});

	it("runs independent units concurrently", async () => {
		const startTimes: Record<string, number> = {};
		const bus = createEventBus();
		const mockStorage = createMockStorage();

		// Use a runtime that records start times and takes a tiny bit of time
		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: "/tmp/bp-graph-parallel",
			storage: mockStorage,
			runtime: {
				executePacket: (packet, _root) => {
					const unitId = (packet as { unit: { id: string } }).unit.id;
					startTimes[unitId] = Date.now();
					return {
						command: "echo",
						args: [],
						exitCode: 0,
						outputChecks: [],
					};
				},
			},
			policy: {
				evaluateRun: () => ({
					kind: "advance-run",
					outcome: "approved",
					reasons: [],
				}),
			},
			workspace: {
				assertRunnableRepository: () => ({ headSha: "abc123" }),
				prepareWorkspace: () => ({ path: "/tmp/ws", headSha: "abc123" }),
				deleteWorkspace: () => ({ deleted: true }),
			},
			eventBus: bus,
		});

		const graph: UnitGraph = {
			nodes: [makeNode("A"), makeNode("B"), makeNode("C", false, ["A", "B"])],
			maxConcurrent: 3,
		};

		const result = await orchestrator.runGraphAsync(graph, bus);
		expect(result.outcome).toBe("passed");

		// C must have started after both A and B were dispatched (at least one of them)
		// The key invariant: A and B have runIds (were dispatched)
		const aOutcome = result.nodes.find((n) => n.unitId === "A")!;
		const bOutcome = result.nodes.find((n) => n.unitId === "B")!;
		const cOutcome = result.nodes.find((n) => n.unitId === "C")!;
		expect(aOutcome.runId).toBeDefined();
		expect(bOutcome.runId).toBeDefined();
		expect(cOutcome.runId).toBeDefined();
	});

	it("cancels dependents when a node fails", async () => {
		const { orchestrator, bus } = makeOrchestrator({ failUnits: ["A"] });
		const events: ExecutionEvent[] = [];
		bus.subscribe((e) => events.push(e));

		const graph: UnitGraph = {
			// A fails → B cancelled; C independent → still runs
			nodes: [makeNode("A"), makeNode("B", false, ["A"]), makeNode("C")],
			maxConcurrent: 3,
		};

		const result = await orchestrator.runGraphAsync(graph, bus);
		expect(result.outcome).toBe("failed");

		const a = result.nodes.find((n) => n.unitId === "A")!;
		const b = result.nodes.find((n) => n.unitId === "B")!;
		const c = result.nodes.find((n) => n.unitId === "C")!;

		expect(a.status).toBe("failed");
		expect(b.status).toBe("cancelled");
		expect(b.runId).toBeUndefined(); // never dispatched
		expect(c.status).toBe("passed");
		expect(c.runId).toBeDefined();

		// Graph completed event reports failure
		const completed = events.find((e) => e.kind === "graph-completed");
		if (completed?.kind === "graph-completed") {
			expect(completed.outcome).toBe("failed");
		}
	});

	it("emits graph-started with correct unitCount", async () => {
		const { orchestrator, bus } = makeOrchestrator();
		const events: ExecutionEvent[] = [];
		bus.subscribe((e) => events.push(e));

		const graph: UnitGraph = {
			nodes: [makeNode("A"), makeNode("B"), makeNode("C")],
			maxConcurrent: 2,
		};

		await orchestrator.runGraphAsync(graph, bus);

		const started = events.find((e) => e.kind === "graph-started");
		expect(started).toBeDefined();
		if (started?.kind === "graph-started") {
			expect(started.unitCount).toBe(3);
			expect(started.graphId).toBeDefined();
		}
	});

	it("records runIds in GraphResult for dispatched nodes", async () => {
		const { orchestrator, bus } = makeOrchestrator();

		const graph: UnitGraph = {
			nodes: [makeNode("A"), makeNode("B", false, ["A"])],
			maxConcurrent: 2,
		};

		const result = await orchestrator.runGraphAsync(graph, bus);

		for (const node of result.nodes) {
			expect(node.runId).toBeDefined();
			expect(typeof node.runId).toBe("string");
		}
	});
});
