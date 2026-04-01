import { describe, expect, it } from "vitest";
import { parseStrategyPacket } from "../src/packet.js";

const minimalChildPacket = {
	unit: {
		id: "unit-impl",
		kind: "command",
		scope: "task",
		inputRefs: [],
		expectedOutputs: [],
		verificationContract: "exit-0",
		policyProfile: "default",
	},
	execution: { command: "echo", args: ["hello"] },
	verification: { requiredOutputs: [] },
};

const minimalReviewerPacket = {
	unit: {
		id: "unit-reviewer",
		kind: "command",
		scope: "task",
		inputRefs: [],
		expectedOutputs: [],
		verificationContract: "exit-0",
		policyProfile: "default",
	},
	execution: { command: "echo", args: ["review"] },
	verification: { requiredOutputs: [] },
};

describe("parseStrategyPacket", () => {
	it("parses a valid implement-then-review packet", () => {
		const raw = {
			id: "strategy-1",
			mode: "implement-then-review",
			mergePolicy: "reviewer-must-approve",
			children: [
				{ role: "implementer", packet: minimalChildPacket },
				{
					role: "reviewer",
					packet: minimalReviewerPacket,
					dependsOn: ["unit-impl"],
				},
			],
		};

		const result = parseStrategyPacket(raw);

		expect(result.id).toBe("strategy-1");
		expect(result.mode).toBe("implement-then-review");
		expect(result.mergePolicy).toBe("reviewer-must-approve");
		expect(result.children).toHaveLength(2);
		expect(result.children[0].role).toBe("implementer");
		expect(result.children[1].role).toBe("reviewer");
		expect(result.children[1].dependsOn).toEqual(["unit-impl"]);
	});

	it("parses a valid single-mode packet", () => {
		const raw = {
			id: "strategy-single",
			mode: "single",
			mergePolicy: "direct",
			children: [{ role: "implementer", packet: minimalChildPacket }],
		};

		const result = parseStrategyPacket(raw);

		expect(result.id).toBe("strategy-single");
		expect(result.mode).toBe("single");
		expect(result.mergePolicy).toBe("direct");
		expect(result.children).toHaveLength(1);
	});

	it("throws when children is missing", () => {
		const raw = {
			id: "strategy-bad",
			mode: "single",
			mergePolicy: "direct",
		};

		expect(() => parseStrategyPacket(raw)).toThrow(
			"strategyPacket.children must be a non-empty array",
		);
	});

	it("throws when children is empty", () => {
		const raw = {
			id: "strategy-bad",
			mode: "single",
			mergePolicy: "direct",
			children: [],
		};

		expect(() => parseStrategyPacket(raw)).toThrow(
			"strategyPacket.children must be a non-empty array",
		);
	});

	it("throws on invalid role", () => {
		const raw = {
			id: "strategy-bad",
			mode: "single",
			mergePolicy: "direct",
			children: [{ role: "unknown-role", packet: minimalChildPacket }],
		};

		expect(() => parseStrategyPacket(raw)).toThrow(
			"strategyPacket.children[0].role must be one of",
		);
	});

	it("throws when dependsOn references an unknown unit id", () => {
		const raw = {
			id: "strategy-bad",
			mode: "implement-then-review",
			mergePolicy: "reviewer-must-approve",
			children: [
				{
					role: "implementer",
					packet: minimalChildPacket,
					dependsOn: ["nonexistent-unit"],
				},
			],
		};

		expect(() => parseStrategyPacket(raw)).toThrow(
			'references unknown unit id "nonexistent-unit"',
		);
	});

	it("validates nested child packets via parseUnitPacket", () => {
		const badChildPacket = {
			unit: {
				id: "unit-bad",
				kind: "command",
				scope: "task",
				inputRefs: [],
				expectedOutputs: [],
				// missing verificationContract
				policyProfile: "default",
			},
			execution: { command: "echo" },
			verification: {},
		};

		const raw = {
			id: "strategy-nested-bad",
			mode: "single",
			mergePolicy: "direct",
			children: [{ role: "implementer", packet: badChildPacket }],
		};

		expect(() => parseStrategyPacket(raw)).toThrow(
			"packet.unit.verificationContract must be a non-empty string",
		);
	});
});
