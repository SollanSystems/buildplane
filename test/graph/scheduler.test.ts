import { describe, expect, it } from "vitest";
import {
	createGraphScheduler,
	type UnitGraph,
} from "../../packages/kernel/src/graph";

function node(id: string, dependsOn?: string[]) {
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
		command: { command: "echo", args: [id] },
		verification: { requiredOutputs: [] },
		...(dependsOn ? { dependsOn } : {}),
	};
}

describe("GraphScheduler", () => {
	describe("linear chain", () => {
		it("dispatches A first, then B after A passes, then C after B passes", () => {
			const graph: UnitGraph = {
				nodes: [node("A"), node("B", ["A"]), node("C", ["B"])],
				maxConcurrent: 3,
			};
			const sched = createGraphScheduler(graph);

			expect(sched.readyUnits()).toEqual(["A"]);
			sched.markRunning("A");
			expect(sched.readyUnits()).toEqual([]);
			sched.markPassed("A");

			expect(sched.readyUnits()).toEqual(["B"]);
			sched.markRunning("B");
			expect(sched.readyUnits()).toEqual([]);
			sched.markPassed("B");

			expect(sched.readyUnits()).toEqual(["C"]);
			sched.markRunning("C");
			sched.markPassed("C");

			expect(sched.isDone()).toBe(true);
			expect(sched.outcome()).toBe("passed");
		});
	});

	describe("fork-join", () => {
		it("B and C run concurrently after A passes", () => {
			// A → [B, C] — both depend on A, independent of each other
			const graph: UnitGraph = {
				nodes: [node("A"), node("B", ["A"]), node("C", ["A"])],
				maxConcurrent: 3,
			};
			const sched = createGraphScheduler(graph);

			expect(sched.readyUnits()).toEqual(["A"]);
			sched.markRunning("A");
			sched.markPassed("A");

			// Both B and C should be ready simultaneously
			const ready = sched.readyUnits();
			expect(ready).toContain("B");
			expect(ready).toContain("C");
			expect(ready).toHaveLength(2);

			sched.markRunning("B");
			sched.markRunning("C");
			sched.markPassed("B");
			sched.markPassed("C");

			expect(sched.isDone()).toBe(true);
			expect(sched.outcome()).toBe("passed");
		});
	});

	describe("fail-fast cancellation", () => {
		it("failing A cancels B (depends A) but not C (independent)", () => {
			const graph: UnitGraph = {
				nodes: [node("A"), node("B", ["A"]), node("C")],
				maxConcurrent: 3,
			};
			const sched = createGraphScheduler(graph);

			// A and C are both ready initially
			const initial = sched.readyUnits();
			expect(initial).toContain("A");
			expect(initial).toContain("C");

			sched.markRunning("A");
			sched.markRunning("C");
			sched.markFailed("A"); // B should be cancelled

			expect(sched.cancelledUnits()).toContain("B");
			expect(sched.cancelledUnits()).not.toContain("C");

			sched.markPassed("C");
			expect(sched.isDone()).toBe(true);
			expect(sched.outcome()).toBe("failed"); // A failed
		});

		it("cancels transitively: A fails → B cancelled → D (depends B) also cancelled", () => {
			// A → B → D, plus independent C
			const graph: UnitGraph = {
				nodes: [node("A"), node("B", ["A"]), node("D", ["B"]), node("C")],
				maxConcurrent: 4,
			};
			const sched = createGraphScheduler(graph);
			sched.markRunning("A");
			sched.markRunning("C");
			sched.markFailed("A");

			const cancelled = sched.cancelledUnits();
			expect(cancelled).toContain("B");
			expect(cancelled).toContain("D");
			expect(cancelled).not.toContain("C");

			sched.markPassed("C");
			expect(sched.isDone()).toBe(true);
			expect(sched.outcome()).toBe("failed");
		});
	});

	describe("concurrency cap", () => {
		it("dispatches at most maxConcurrent units at a time", () => {
			const graph: UnitGraph = {
				nodes: [node("A"), node("B"), node("C"), node("D")],
				maxConcurrent: 2,
			};
			const sched = createGraphScheduler(graph);

			// Only 2 should be ready even though all 4 are independent
			const ready = sched.readyUnits();
			expect(ready).toHaveLength(2);

		sched.markRunning(ready[0]!);
		sched.markRunning(ready[1]!);

		// No more ready while 2 are running
			expect(sched.readyUnits()).toHaveLength(0);

			sched.markPassed(ready[0]!);
			// One slot freed → one more becomes ready
			expect(sched.readyUnits()).toHaveLength(1);
		});

		it("default maxConcurrent is 2", () => {
			const graph: UnitGraph = {
				nodes: [node("A"), node("B"), node("C")],
			};
			const sched = createGraphScheduler(graph);
			expect(sched.readyUnits()).toHaveLength(2);
		});
	});

	describe("outcome tracking", () => {
		it("outcome is 'passed' when all nodes pass", () => {
			const graph: UnitGraph = {
				nodes: [node("A"), node("B")],
				maxConcurrent: 2,
			};
			const sched = createGraphScheduler(graph);
			sched.markRunning("A");
			sched.markRunning("B");
			sched.markPassed("A");
			sched.markPassed("B");
			expect(sched.outcome()).toBe("passed");
		});

		it("outcome is 'failed' when any node fails", () => {
			const graph: UnitGraph = {
				nodes: [node("A"), node("B")],
				maxConcurrent: 2,
			};
			const sched = createGraphScheduler(graph);
			sched.markRunning("A");
			sched.markRunning("B");
			sched.markFailed("A");
			sched.markPassed("B");
			expect(sched.outcome()).toBe("failed");
		});

		it("outcome is 'running' while nodes are active", () => {
			const graph: UnitGraph = { nodes: [node("A")], maxConcurrent: 1 };
			const sched = createGraphScheduler(graph);
			sched.markRunning("A");
			expect(sched.outcome()).toBe("running");
		});
	});

	describe("toResult", () => {
		it("builds GraphResult with per-node outcomes and runIds", () => {
			const graph: UnitGraph = {
				nodes: [node("A"), node("B", ["A"]), node("C")],
				maxConcurrent: 2,
			};
			const sched = createGraphScheduler(graph);
			sched.markRunning("A");
			sched.markRunning("C");
			sched.markFailed("A"); // B cancelled
			sched.markPassed("C");

			const runIdMap = new Map([
				["A", "run-A-001"],
				["C", "run-C-001"],
			]);
			const result = sched.toResult(runIdMap);

			expect(result.outcome).toBe("failed");
			const a = result.nodes.find((n) => n.unitId === "A");
			expect(a).toBeDefined();
			expect(a?.status).toBe("failed");
			expect(a?.runId).toBe("run-A-001");

			const b = result.nodes.find((n) => n.unitId === "B");
			expect(b).toBeDefined();
			expect(b?.status).toBe("cancelled");
			expect(b?.runId).toBeUndefined();

			const c = result.nodes.find((n) => n.unitId === "C");
			expect(c).toBeDefined();
			expect(c?.status).toBe("passed");
			expect(c?.runId).toBe("run-C-001");
		});
	});

	describe("validation", () => {
		it("throws on unknown dependsOn reference", () => {
			const graph: UnitGraph = {
				nodes: [node("A", ["nonexistent"])],
			};
			expect(() => createGraphScheduler(graph)).toThrow(
				/depends on unknown unit 'nonexistent'/,
			);
		});

		it("throws on markRunning non-pending node", () => {
			const graph: UnitGraph = { nodes: [node("A")], maxConcurrent: 1 };
			const sched = createGraphScheduler(graph);
			sched.markRunning("A");
			expect(() => sched.markRunning("A")).toThrow(/is not pending/);
		});

		it("throws on markPassed non-running node", () => {
			const graph: UnitGraph = { nodes: [node("A")], maxConcurrent: 1 };
			const sched = createGraphScheduler(graph);
			expect(() => sched.markPassed("A")).toThrow(/is not running/);
		});

		it("throws on markFailed non-running node", () => {
			const graph: UnitGraph = { nodes: [node("A")], maxConcurrent: 1 };
			const sched = createGraphScheduler(graph);
			expect(() => sched.markFailed("A")).toThrow(/is not running/);
		});
	});

	describe("single-node graph", () => {
		it("passes end-to-end", () => {
			const graph: UnitGraph = { nodes: [node("A")], maxConcurrent: 1 };
			const sched = createGraphScheduler(graph);
			expect(sched.readyUnits()).toEqual(["A"]);
			sched.markRunning("A");
			expect(sched.isDone()).toBe(false);
			sched.markPassed("A");
			expect(sched.isDone()).toBe(true);
			expect(sched.outcome()).toBe("passed");
		});
	});
});
