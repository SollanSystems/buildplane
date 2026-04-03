import { describe, expect, it } from "vitest";
import { parseUnitPacket } from "../../packages/kernel/src/packet";

const baseUnit = {
	id: "unit-test",
	kind: "command",
	scope: "task",
	inputRefs: [],
	expectedOutputs: [],
	verificationContract: "exit-0-and-required-outputs",
	policyProfile: "default",
};

describe("parseUnitPacket — model support", () => {
	it("parses a valid command packet", () => {
		const packet = parseUnitPacket(
			JSON.stringify({
				unit: baseUnit,
				execution: { command: "echo", args: ["hello"] },
				verification: { requiredOutputs: [] },
			}),
		);

		expect(packet.execution).toBeDefined();
		expect(packet.execution?.command).toBe("echo");
		expect(packet.model).toBeUndefined();
	});

	it("parses a valid model packet", () => {
		const packet = parseUnitPacket(
			JSON.stringify({
				unit: { ...baseUnit, kind: "model" },
				model: {
					provider: "anthropic",
					model: "claude-sonnet-4-20250514",
					systemPrompt: "You are helpful.",
				},
				verification: { requiredOutputs: [] },
			}),
		);

		expect(packet.model).toBeDefined();
		expect(packet.model?.provider).toBe("anthropic");
		expect(packet.model?.model).toBe("claude-sonnet-4-20250514");
		expect(packet.model?.systemPrompt).toBe("You are helpful.");
		expect(packet.execution).toBeUndefined();
	});

	it("parses a model packet with tools", () => {
		const packet = parseUnitPacket(
			JSON.stringify({
				unit: { ...baseUnit, kind: "model" },
				model: {
					provider: "anthropic",
					model: "claude-sonnet-4-20250514",
					tools: [
						{
							name: "read_file",
							description: "Read a file",
							parameters: { path: { type: "string" } },
						},
					],
				},
				verification: { requiredOutputs: [] },
			}),
		);

		expect(packet.model?.tools).toHaveLength(1);
		expect(packet.model?.tools?.[0].name).toBe("read_file");
	});

	it("rejects a packet with both execution and model", () => {
		expect(() =>
			parseUnitPacket(
				JSON.stringify({
					unit: baseUnit,
					execution: { command: "echo" },
					model: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
					verification: { requiredOutputs: [] },
				}),
			),
		).toThrow("either 'execution' or 'model', not both");
	});

	it("rejects a packet with neither execution nor model", () => {
		expect(() =>
			parseUnitPacket(
				JSON.stringify({
					unit: baseUnit,
					verification: { requiredOutputs: [] },
				}),
			),
		).toThrow("either an 'execution' block or a 'model' block");
	});

	it("rejects a model packet missing provider", () => {
		expect(() =>
			parseUnitPacket(
				JSON.stringify({
					unit: baseUnit,
					model: { model: "claude-sonnet-4-20250514" },
					verification: { requiredOutputs: [] },
				}),
			),
		).toThrow("packet.model.provider must be a non-empty string");
	});

	it("rejects a model packet missing model name", () => {
		expect(() =>
			parseUnitPacket(
				JSON.stringify({
					unit: baseUnit,
					model: { provider: "anthropic" },
					verification: { requiredOutputs: [] },
				}),
			),
		).toThrow("packet.model.model must be a non-empty string");
	});
});
