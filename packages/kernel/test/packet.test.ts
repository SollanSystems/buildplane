import { describe, expect, it } from "vitest";
import { parseUnitPacket } from "../src/packet";

describe("parseUnitPacket", () => {
	it("parses a valid unit packet from JSON text", () => {
		const packet = parseUnitPacket(
			JSON.stringify({
				unit: {
					id: "unit-hello",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["tmp/out.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: {
					command: "node",
					args: ["-e", "console.log('ok')"],
				},
				verification: {
					requiredOutputs: ["tmp/out.txt"],
				},
			}),
		);

		expect(packet.unit.id).toBe("unit-hello");
		expect(packet.execution.command).toBe("node");
		expect(packet.execution.args).toEqual(["-e", "console.log('ok')"]);
		expect(packet.execution.cwd).toBeUndefined();
		expect(packet.verification.requiredOutputs).toEqual(["tmp/out.txt"]);
	});

	it("parses a packet with budget limits", () => {
		const packet = parseUnitPacket(
			JSON.stringify({
				unit: {
					id: "unit-budgeted",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [],
					verificationContract: "exit-0",
					policyProfile: "default",
				},
				execution: {
					command: "node",
				},
				budget: {
					maxDurationMs: 60000,
					maxTotalTokens: 10000,
					maxCommandCount: 5,
					maxSteps: 3,
					allowedPaths: ["src/**"],
					networkPolicy: "none",
				},
			}),
		);

		expect(packet.budget).toEqual({
			maxDurationMs: 60000,
			maxTotalTokens: 10000,
			maxCommandCount: 5,
			maxSteps: 3,
			allowedPaths: ["src/**"],
			networkPolicy: "none",
		});
	});

	it("omits budget when not specified", () => {
		const packet = parseUnitPacket(
			JSON.stringify({
				unit: {
					id: "unit-no-budget",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [],
					verificationContract: "exit-0",
					policyProfile: "default",
				},
				execution: {
					command: "node",
				},
			}),
		);

		expect(packet.budget).toBeUndefined();
	});

	it("preserves omitted execution args and cwd", () => {
		const packet = parseUnitPacket(
			JSON.stringify({
				unit: {
					id: "unit-no-args",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [],
					verificationContract: "exit-0",
					policyProfile: "default",
				},
				execution: {
					command: "node",
				},
			}),
		);

		expect(packet.execution.args).toBeUndefined();
		expect(packet.execution.cwd).toBeUndefined();
		expect(packet.verification.requiredOutputs).toEqual([]);
	});
});
