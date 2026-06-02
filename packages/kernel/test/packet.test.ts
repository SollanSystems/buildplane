import { describe, expect, it } from "vitest";
import { parseUnitPacket } from "../src/packet";

// Shared minimal unit fields used across tests
const baseUnit = {
	id: "unit-1",
	kind: "model",
	scope: "task",
	inputRefs: [],
	expectedOutputs: [],
	verificationContract: "exit-0",
	policyProfile: "default",
};

const baseModel = {
	provider: "anthropic",
	model: "claude-3-5-sonnet-20241022",
};

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

	it("preserves task intent when present on command packets", () => {
		const packet = parseUnitPacket(
			JSON.stringify({
				unit: {
					id: "unit-with-intent",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [],
					verificationContract: "exit-0",
					policyProfile: "default",
				},
				execution: {
					command: "node",
					args: ["-e", "console.log('ok')"],
				},
				intent: {
					objective: "Fix the TypeScript build",
					taskType: "implement",
					context: {
						files: ["apps/cli/src/run-cli.ts"],
						memories: ["[repo-fact] commands.typecheck: npx pnpm typecheck"],
					},
					constraints: {
						scope: ["apps/cli/src"],
						verification: ["npx pnpm typecheck"],
					},
					features: {
						ambiguity: "low",
						reversibility: "easy",
						verifierStrength: "strong",
					},
				},
				verification: { requiredOutputs: [] },
			}),
		);

		expect(packet.intent).toMatchObject({
			objective: "Fix the TypeScript build",
			taskType: "implement",
			context: {
				files: ["apps/cli/src/run-cli.ts"],
				memories: ["[repo-fact] commands.typecheck: npx pnpm typecheck"],
			},
			constraints: {
				scope: ["apps/cli/src"],
				verification: ["npx pnpm typecheck"],
			},
			features: {
				ambiguity: "low",
				reversibility: "easy",
				verifierStrength: "strong",
			},
		});
	});
});

describe("model.prompt", () => {
	it("parses prompt when present", () => {
		const packet = parseUnitPacket(
			JSON.stringify({
				unit: baseUnit,
				model: { ...baseModel, prompt: "Write a hello world program." },
				verification: { requiredOutputs: [] },
			}),
		);

		expect(packet.model?.prompt).toBe("Write a hello world program.");
	});

	it("allows prompt to be absent", () => {
		const packet = parseUnitPacket(
			JSON.stringify({
				unit: baseUnit,
				model: baseModel,
				verification: { requiredOutputs: [] },
			}),
		);

		expect(packet.model?.prompt).toBeUndefined();
	});

	it("rejects an empty prompt string", () => {
		expect(() =>
			parseUnitPacket(
				JSON.stringify({
					unit: baseUnit,
					model: { ...baseModel, prompt: "" },
					verification: { requiredOutputs: [] },
				}),
			),
		).toThrow("packet.model.prompt must be a non-empty string");
	});
});

describe("routingHints", () => {
	it("parses routingHints with preferredWorker", () => {
		const packet = parseUnitPacket(
			JSON.stringify({
				unit: baseUnit,
				model: baseModel,
				verification: { requiredOutputs: [] },
				routingHints: { preferredWorker: "claude-code" },
			}),
		);

		expect(packet.routingHints?.preferredWorker).toBe("claude-code");
	});

	it("allows routingHints to be absent", () => {
		const packet = parseUnitPacket(
			JSON.stringify({
				unit: baseUnit,
				model: baseModel,
				verification: { requiredOutputs: [] },
			}),
		);

		expect(packet.routingHints).toBeUndefined();
	});

	it("rejects an unknown preferredWorker value", () => {
		expect(() =>
			parseUnitPacket(
				JSON.stringify({
					unit: baseUnit,
					model: baseModel,
					verification: { requiredOutputs: [] },
					routingHints: { preferredWorker: "gpt-4o-worker" },
				}),
			),
		).toThrow(
			"packet.routingHints.preferredWorker must be one of: claude-code",
		);
	});

	it("parses effort correctly", () => {
		for (const effort of ["low", "medium", "high"] as const) {
			const packet = parseUnitPacket(
				JSON.stringify({
					unit: baseUnit,
					model: baseModel,
					verification: { requiredOutputs: [] },
					routingHints: { effort },
				}),
			);

			expect(packet.routingHints?.effort).toBe(effort);
		}
	});

	it("rejects an invalid effort value", () => {
		expect(() =>
			parseUnitPacket(
				JSON.stringify({
					unit: baseUnit,
					model: baseModel,
					verification: { requiredOutputs: [] },
					routingHints: { effort: "extreme" },
				}),
			),
		).toThrow("packet.routingHints.effort must be one of: low, medium, high");
	});
});

describe("provenance_ref", () => {
	const base = {
		unit: {
			id: "u1",
			kind: "task",
			scope: "src",
			verificationContract: "tsc",
			policyProfile: "default",
		},
		execution: { command: "true" },
		verification: { requiredOutputs: [] },
	};

	it("parses provenance_ref when present", () => {
		const packet = parseUnitPacket(
			JSON.stringify({ ...base, provenance_ref: "evt-123" }),
		);
		expect(packet.provenance_ref).toBe("evt-123");
	});

	it("defaults provenance_ref to empty string when absent", () => {
		const packet = parseUnitPacket(JSON.stringify(base));
		expect(packet.provenance_ref).toBe("");
	});

	it("throws when provenance_ref is present but empty", () => {
		expect(() =>
			parseUnitPacket(JSON.stringify({ ...base, provenance_ref: "" })),
		).toThrow(/provenance_ref/);
	});

	it("passes through reserved M3/M4 fields when present", () => {
		const packet = parseUnitPacket(
			JSON.stringify({
				...base,
				provenance_ref: "evt-1",
				capability_bundle: { id: "cb" },
				acceptance_contract: { version: 1 },
				trust_scope: "isolated",
			}),
		);
		expect(packet.capability_bundle).toEqual({ id: "cb" });
		expect(packet.acceptance_contract).toEqual({ version: 1 });
		expect(packet.trust_scope).toBe("isolated");
	});
});
