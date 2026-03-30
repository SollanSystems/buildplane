import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type {
	EventBus,
	ExecutionEvent,
	ModelResponseCompleteEvent,
	UnitPacket,
} from "@buildplane/kernel";
import { createEventBus } from "@buildplane/kernel";
import { createClaudeCodeExecutor } from "../src/claude-code-executor.js";

// ── Helpers ─────────────────────────────────────────────────

function createMockSpawn(opts: {
	stdout?: string;
	stderr?: string;
	exitCode?: number | null;
	error?: Error;
}) {
	return vi.fn().mockImplementation(() => {
		const child = new EventEmitter() as ReturnType<typeof import("node:child_process").spawn>;
		const stdoutEmitter = new EventEmitter();
		const stderrEmitter = new EventEmitter();
		(child as any).stdout = stdoutEmitter;
		(child as any).stderr = stderrEmitter;
		(child as any).pid = 12345;

		queueMicrotask(() => {
			if (opts.error) {
				child.emit("error", opts.error);
				return;
			}
			if (opts.stdout) {
				stdoutEmitter.emit("data", Buffer.from(opts.stdout));
			}
			if (opts.stderr) {
				stderrEmitter.emit("data", Buffer.from(opts.stderr));
			}
			child.emit("close", opts.exitCode ?? 0);
		});

		return child;
	});
}

function makeModelPacket(overrides: {
	prompt?: string;
	systemPrompt?: string;
	model?: string;
	tools?: readonly { name: string; description: string; parameters: Record<string, unknown> }[];
	requiredOutputs?: readonly string[];
} = {}): UnitPacket {
	return {
		unit: {
			id: "unit-1",
			kind: "model",
			scope: "task",
			inputRefs: [],
			expectedOutputs: [],
			verificationContract: "exit-0-and-required-outputs",
			policyProfile: "default",
		},
		model: {
			provider: "anthropic",
			model: overrides.model ?? "claude-sonnet-4-20250514",
			prompt: overrides.prompt,
			systemPrompt: overrides.systemPrompt,
			...(overrides.tools !== undefined ? { tools: overrides.tools } : {}),
		},
		verification: {
			requiredOutputs: overrides.requiredOutputs ?? [],
		},
	};
}

function makeCommandPacket(): UnitPacket {
	return {
		unit: {
			id: "unit-cmd",
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

function collectEvents(bus: EventBus): ExecutionEvent[] {
	const events: ExecutionEvent[] = [];
	bus.subscribe((e) => events.push(e));
	return events;
}

// ── Tests ───────────────────────────────────────────────────

describe("createClaudeCodeExecutor", () => {
	it("valid Claude JSON → receipt + model-response-complete event", async () => {
		const claudeOutput = JSON.stringify({ result: "Generated code here" });
		const spawnFn = createMockSpawn({ stdout: claudeOutput, exitCode: 0 });
		const executor = createClaudeCodeExecutor({ spawnFn });
		const bus = createEventBus();
		const events = collectEvents(bus);

		const packet = makeModelPacket({ prompt: "Write hello.ts" });
		const receipt = await executor.executePacketAsync(packet, "/workspace", bus);

		expect(receipt.exitCode).toBe(0);
		expect(receipt.stdout).toBe(claudeOutput);
		expect(receipt.command).toBe("claude");
		expect(receipt.cwd).toBe("/workspace");

		const complete = events.find(
			(e) => e.kind === "model-response-complete",
		) as ModelResponseCompleteEvent | undefined;
		expect(complete).toBeDefined();
		expect(complete!.text).toBe("Generated code here");
		expect(complete!.finishReason).toBe("end_turn");

		// No model-token-delta events ever
		expect(events.filter((e) => e.kind === "model-token-delta")).toHaveLength(0);
	});

	it("malformed JSON → receipt, no model-response-complete", async () => {
		const spawnFn = createMockSpawn({ stdout: "not json {{{", exitCode: 0 });
		const executor = createClaudeCodeExecutor({ spawnFn });
		const bus = createEventBus();
		const events = collectEvents(bus);

		const packet = makeModelPacket({ prompt: "Do something" });
		const receipt = await executor.executePacketAsync(packet, "/workspace", bus);

		expect(receipt.exitCode).toBe(0);
		expect(receipt.stdout).toBe("not json {{{");
		expect(events.filter((e) => e.kind === "model-response-complete")).toHaveLength(0);
	});

	it("missing model.prompt → throw before spawn", async () => {
		const spawnFn = createMockSpawn({ stdout: "{}", exitCode: 0 });
		const executor = createClaudeCodeExecutor({ spawnFn });
		const bus = createEventBus();

		const packet = makeModelPacket({}); // no prompt
		await expect(
			executor.executePacketAsync(packet, "/workspace", bus),
		).rejects.toThrow(/prompt/i);

		expect(spawnFn).not.toHaveBeenCalled();
	});

	it("model.tools present → throw before spawn", async () => {
		const spawnFn = createMockSpawn({ stdout: "{}", exitCode: 0 });
		const executor = createClaudeCodeExecutor({ spawnFn });
		const bus = createEventBus();

		const packet = makeModelPacket({
			prompt: "Do work",
			tools: [{ name: "tool1", description: "A tool", parameters: {} }],
		});

		await expect(
			executor.executePacketAsync(packet, "/workspace", bus),
		).rejects.toThrow(/tools/i);

		expect(spawnFn).not.toHaveBeenCalled();
	});

	it("command packet → throw", async () => {
		const spawnFn = createMockSpawn({ stdout: "{}", exitCode: 0 });
		const executor = createClaudeCodeExecutor({ spawnFn });
		const bus = createEventBus();

		const packet = makeCommandPacket();
		await expect(
			executor.executePacketAsync(packet, "/workspace", bus),
		).rejects.toThrow(/model/i);

		expect(spawnFn).not.toHaveBeenCalled();
	});

	it("systemPrompt + prompt → folded envelope in -p arg", async () => {
		const claudeOutput = JSON.stringify({ result: "ok" });
		const spawnFn = createMockSpawn({ stdout: claudeOutput, exitCode: 0 });
		const executor = createClaudeCodeExecutor({ spawnFn });
		const bus = createEventBus();

		const packet = makeModelPacket({
			prompt: "Do the thing",
			systemPrompt: "You are helpful",
		});
		await executor.executePacketAsync(packet, "/workspace", bus);

		const callArgs = spawnFn.mock.calls[0][1] as string[];
		const pIdx = callArgs.indexOf("-p");
		expect(pIdx).toBeGreaterThan(-1);
		const envelope = callArgs[pIdx + 1];
		expect(envelope).toBe("You are helpful\n\n---\n\nDo the thing");
	});

	it("model.model → passed as --model", async () => {
		const claudeOutput = JSON.stringify({ result: "ok" });
		const spawnFn = createMockSpawn({ stdout: claudeOutput, exitCode: 0 });
		const executor = createClaudeCodeExecutor({ spawnFn });
		const bus = createEventBus();

		const packet = makeModelPacket({
			prompt: "Work",
			model: "claude-opus-4-20250514",
		});
		await executor.executePacketAsync(packet, "/workspace", bus);

		const callArgs = spawnFn.mock.calls[0][1] as string[];
		const modelIdx = callArgs.indexOf("--model");
		expect(modelIdx).toBeGreaterThan(-1);
		expect(callArgs[modelIdx + 1]).toBe("claude-opus-4-20250514");
	});

	it("spawn error (ENOENT) → throw", async () => {
		const err = new Error("spawn claude ENOENT") as NodeJS.ErrnoException;
		err.code = "ENOENT";
		const spawnFn = createMockSpawn({ error: err });
		const executor = createClaudeCodeExecutor({ spawnFn });
		const bus = createEventBus();

		const packet = makeModelPacket({ prompt: "Work" });
		await expect(
			executor.executePacketAsync(packet, "/workspace", bus),
		).rejects.toThrow(/ENOENT/);
	});

	it("sync executePacket → throw", () => {
		const executor = createClaudeCodeExecutor({});
		const packet = makeModelPacket({ prompt: "Work" });
		expect(() => executor.executePacket(packet, "/workspace")).toThrow();
	});

	it("receipt args references the actual spawn args array", async () => {
		const claudeOutput = JSON.stringify({ result: "done" });
		const spawnFn = createMockSpawn({ stdout: claudeOutput, exitCode: 0 });
		const executor = createClaudeCodeExecutor({ spawnFn });
		const bus = createEventBus();

		const packet = makeModelPacket({ prompt: "Build it" });
		const receipt = await executor.executePacketAsync(packet, "/workspace", bus);

		// args should contain the -p, --output-format, --model, --max-turns, --cwd flags
		expect(receipt.args).toContain("-p");
		expect(receipt.args).toContain("--output-format");
		expect(receipt.args).toContain("json");
		expect(receipt.args).toContain("--model");
		expect(receipt.args).toContain("--max-turns");
		expect(receipt.args).toContain("--cwd");
		expect(receipt.args).toContain("/workspace");
	});
});
