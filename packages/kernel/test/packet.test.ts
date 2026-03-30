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

	it("parses model.prompt when present", () => {
		const packet = parseUnitPacket(
			JSON.stringify({
				unit: {
					id: "unit-prompt",
					kind: "model",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				model: {
					provider: "anthropic",
					model: "claude-sonnet-4-20250514",
					prompt: "Implement the user auth module",
				},
				verification: { requiredOutputs: [] },
			}),
		);
		expect(packet.model?.prompt).toBe("Implement the user auth module");
	});

	it("allows prompt-less model packets (M1 compat)", () => {
		const packet = parseUnitPacket(
			JSON.stringify({
				unit: {
					id: "unit-no-prompt",
					kind: "model",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				model: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
				verification: { requiredOutputs: [] },
			}),
		);
		expect(packet.model?.prompt).toBeUndefined();
	});

	it("rejects empty model.prompt", () => {
		expect(() =>
			parseUnitPacket(
				JSON.stringify({
					unit: {
						id: "unit-empty",
						kind: "model",
						scope: "task",
						inputRefs: [],
						expectedOutputs: [],
						verificationContract: "exit-0-and-required-outputs",
						policyProfile: "default",
					},
					model: {
						provider: "anthropic",
						model: "claude-sonnet-4-20250514",
						prompt: "",
					},
					verification: { requiredOutputs: [] },
				}),
			),
		).toThrow(/non-empty string/);
	});

	it("parses routingHints.preferredWorker when present", () => {
		const packet = parseUnitPacket(
			JSON.stringify({
				unit: {
					id: "unit-hints",
					kind: "model",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				model: {
					provider: "anthropic",
					model: "claude-sonnet-4-20250514",
					prompt: "Do the thing",
				},
				verification: { requiredOutputs: [] },
				routingHints: { preferredWorker: "claude-code" },
			}),
		);
		expect(packet.routingHints?.preferredWorker).toBe("claude-code");
	});

	it("rejects unknown routingHints.preferredWorker", () => {
		expect(() =>
			parseUnitPacket(
				JSON.stringify({
					unit: {
						id: "unit-bad",
						kind: "model",
						scope: "task",
						inputRefs: [],
						expectedOutputs: [],
						verificationContract: "exit-0-and-required-outputs",
						policyProfile: "default",
					},
					model: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
					verification: { requiredOutputs: [] },
					routingHints: { preferredWorker: "unknown-worker" },
				}),
			),
		).toThrow(/preferredWorker/);
	});

	it("allows absent routingHints", () => {
		const packet = parseUnitPacket(
			JSON.stringify({
				unit: {
					id: "unit-no-hints",
					kind: "model",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				model: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
				verification: { requiredOutputs: [] },
			}),
		);
		expect(packet.routingHints).toBeUndefined();
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
