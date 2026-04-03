import { describe, expect, it } from "vitest";
import { createGraphScheduler, type UnitGraph } from "../src/graph.js";

function makeUnitNode(id: string, dependsOn?: readonly string[]) {
	return {
		unit: {
			id,
			kind: "command" as const,
			scope: "task" as const,
			inputRefs: [],
			expectedOutputs: [],
			verificationContract: "exit-0-and-required-outputs" as const,
			policyProfile: "default",
		},
		execution: { command: "echo", args: [id] },
		verification: { requiredOutputs: [] },
		...(dependsOn ? { dependsOn } : {}),
	};
}

describe("Graph cycle detection", () => {
	it("throws on simple cycle (A->B->A) with 'cycle' in error message", () => {
		const graph: UnitGraph = {
			nodes: [makeUnitNode("A", ["B"]), makeUnitNode("B", ["A"])],
		};

		expect(() => createGraphScheduler(graph)).toThrow(/cycle/i);
	});

	it("throws on longer cycle (A->B->C->A)", () => {
		const graph: UnitGraph = {
			nodes: [
				makeUnitNode("A", ["C"]),
				makeUnitNode("B", ["A"]),
				makeUnitNode("C", ["B"]),
			],
		};

		expect(() => createGraphScheduler(graph)).toThrow(/cycle/i);
	});

	it("throws on self-referencing node (A->A)", () => {
		const graph: UnitGraph = {
			nodes: [makeUnitNode("A", ["A"])],
		};

		expect(() => createGraphScheduler(graph)).toThrow(/cycle/i);
	});

	it("does NOT throw on valid DAG (A->B, A->C, B->C)", () => {
		const graph: UnitGraph = {
			nodes: [
				makeUnitNode("A"),
				makeUnitNode("B", ["A"]),
				makeUnitNode("C", ["A", "B"]),
			],
		};

		expect(() => createGraphScheduler(graph)).not.toThrow();
	});

	it("does NOT throw on empty graph", () => {
		const graph: UnitGraph = {
			nodes: [],
		};

		expect(() => createGraphScheduler(graph)).not.toThrow();
	});
});
