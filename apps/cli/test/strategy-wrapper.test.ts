import { describe, expect, it } from "vitest";
import {
	REVIEWER_SYSTEM_PROMPT_TEMPLATE,
	wrapAsStrategy,
} from "../src/strategy-wrapper.js";

const modelPacket = {
	unit: {
		id: "task-1",
		kind: "model",
		scope: "task",
		inputRefs: [],
		expectedOutputs: ["output/result.js"],
		verificationContract: "exit-0-and-required-outputs",
		policyProfile: "default",
	},
	model: {
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		systemPrompt: "You are a build assistant.",
	},
	verification: { requiredOutputs: ["output/result.js"] },
	intent: {
		objective: "Write a hello world script",
		taskType: "implement",
		context: { files: [] },
		constraints: { scope: [], verification: [] },
		features: {
			ambiguity: "low",
			reversibility: "easy",
			verifierStrength: "strong",
		},
	},
};

const commandPacket = {
	unit: {
		id: "cmd-1",
		kind: "command",
		scope: "task",
		inputRefs: [],
		expectedOutputs: ["output/result.txt", "output/log.txt"],
		verificationContract: "exit-0-and-required-outputs",
		policyProfile: "default",
	},
	execution: {
		command: "node",
		args: ["-e", "require('fs').writeFileSync('output/result.txt','ok')"],
	},
	verification: { requiredOutputs: ["output/result.txt", "output/log.txt"] },
};

const noOutputsPacket = {
	unit: {
		id: "no-out-1",
		kind: "command",
		scope: "task",
		inputRefs: [],
		expectedOutputs: [],
		verificationContract: "exit-0-and-required-outputs",
		policyProfile: "default",
	},
	execution: { command: "echo", args: ["hello"] },
	verification: { requiredOutputs: [] },
};

describe("wrapAsStrategy", () => {
	it("wraps a model packet with a model reviewer", () => {
		const strategy = wrapAsStrategy(modelPacket);
		expect(strategy.id).toBe("auto-task-1");
		expect(strategy.mode).toBe("implement-then-review");
		expect(strategy.mergePolicy).toBe("reviewer-must-approve");
		expect(strategy.children).toHaveLength(2);

		const impl = strategy.children[0];
		expect(impl.role).toBe("implementer");
		expect(impl.packet).toBe(modelPacket);

		const rev = strategy.children[1];
		expect(rev.role).toBe("reviewer");
		expect(rev.dependsOn).toEqual(["task-1"]);
		expect(rev.packet.unit.id).toBe("task-1-reviewer");
		expect(rev.packet.unit.kind).toBe("model");
		expect(rev.packet.unit.scope).toBe("task");
		expect(rev.packet.unit.policyProfile).toBe("default");
		expect(rev.packet.unit.inputRefs).toEqual(["output/result.js"]);
		expect(rev.packet.unit.expectedOutputs).toEqual([]);
		expect(rev.packet.model?.systemPrompt).toContain("code reviewer");
		expect(rev.packet.model?.systemPrompt).toContain(
			"Write a hello world script",
		);
		expect(rev.packet.model?.prompt).toContain("Write a hello world script");
		expect(rev.packet.model?.provider).toBe("anthropic");
		expect(rev.packet.verification.requiredOutputs).toEqual([]);
		expect(rev.packet.intent?.taskType).toBe("review");
		expect(rev.packet.intent?.objective).toContain(
			"Write a hello world script",
		);
	});

	it("wraps a command packet with a file-check reviewer", () => {
		const strategy = wrapAsStrategy(commandPacket);
		expect(strategy.children).toHaveLength(2);

		const rev = strategy.children[1];
		expect(rev.role).toBe("reviewer");
		expect(rev.dependsOn).toEqual(["cmd-1"]);
		expect(rev.packet.unit.id).toBe("cmd-1-reviewer");
		expect(rev.packet.unit.kind).toBe("command");
		expect(rev.packet.execution?.command).toBe("sh");
		expect(rev.packet.execution?.args?.[1]).toContain(
			"test -s output/result.txt",
		);
		expect(rev.packet.execution?.args?.[1]).toContain("test -s output/log.txt");
		expect(rev.packet.model).toBeUndefined();
		expect(rev.packet.intent?.taskType).toBe("review");
		expect(rev.packet.intent?.objective).toContain("cmd-1");
	});

	it("uses 'true' command when no expected outputs", () => {
		const strategy = wrapAsStrategy(noOutputsPacket);
		const rev = strategy.children[1];
		expect(rev.packet.execution?.command).toBe("true");
		expect(rev.packet.execution?.args).toEqual([]);
		expect(rev.packet.intent?.taskType).toBe("review");
	});

	it("preserves routing hints for model reviewer packets", () => {
		const codexPacket = {
			...modelPacket,
			model: {
				provider: "codex",
				model: "o4-mini",
			},
			routingHints: { preferredWorker: "codex" },
		};

		const strategy = wrapAsStrategy(codexPacket);
		const reviewerPacket = strategy.children[1]?.packet;
		expect(reviewerPacket.routingHints).toEqual({ preferredWorker: "codex" });
	});

	it("exports the reviewer system prompt template", () => {
		expect(REVIEWER_SYSTEM_PROMPT_TEMPLATE).toContain("code reviewer");
	});
});
