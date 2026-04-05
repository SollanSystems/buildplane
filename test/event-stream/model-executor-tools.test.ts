import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createModelExecutor,
	type ModelResolver,
	type StreamFunction,
	type ToolBuilder,
} from "../../packages/adapters-models/src/model-executor";
import {
	createEventBus,
	type ExecutionEvent,
} from "../../packages/kernel/src/events";
import type { UnitPacket } from "../../packages/kernel/src/run-loop";

function makeModelPacket(
	overrides?: Partial<NonNullable<UnitPacket["model"]>>,
	verification?: Partial<UnitPacket["verification"]>,
): UnitPacket {
	return {
		unit: {
			id: "unit-model-tools-test",
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
			systemPrompt: "You are a test assistant.",
			...overrides,
		},
		verification: {
			requiredOutputs: [],
			...verification,
		},
	};
}

function mockModelResolver(): ModelResolver {
	return (provider: string, modelId: string) => ({
		provider,
		modelId,
		fake: true,
	});
}

describe("model executor with tools", () => {
	it("passes tools to streamFn when toolBuilder is provided", async () => {
		const bus = createEventBus();
		let capturedTools: Record<string, unknown> | undefined;

		const streamFn: StreamFunction = (options) => {
			capturedTools = options.tools as Record<string, unknown>;
			return {
				fullStream: (async function* () {
					yield { type: "text-delta" as const, textDelta: "Done" };
					yield { type: "finish-step" as const, finishReason: "stop" };
				})(),
			};
		};

		const toolBuilder: ToolBuilder = () => ({
			write_file: { description: "mock write_file", fake: true },
			run_command: { description: "mock run_command", fake: true },
		});

		const executor = createModelExecutor({
			streamFn,
			modelResolver: mockModelResolver(),
			toolBuilder,
		});

		const root = realpathSync(mkdtempSync(join(tmpdir(), "bp-model-tools-")));
		await executor.executePacketAsync(makeModelPacket(), root, bus);

		expect(capturedTools).toBeDefined();
		expect(Object.keys(capturedTools as Record<string, unknown>)).toEqual([
			"write_file",
			"run_command",
		]);
	});

	it("emits tool-call-started and tool-call-completed events for tool use", async () => {
		const bus = createEventBus();
		const events: ExecutionEvent[] = [];
		bus.subscribe((e) => events.push(e));

		const streamFn: StreamFunction = () => ({
			fullStream: (async function* () {
				yield {
					type: "tool-call" as const,
					toolCallId: "call-write-1",
					toolName: "write_file",
					input: { path: "output.txt", content: "hello" },
				};
				yield {
					type: "tool-result" as const,
					toolCallId: "call-write-1",
					toolName: "write_file",
					output: { success: true, path: "output.txt" },
				};
				yield { type: "text-delta" as const, textDelta: "File written." };
				yield { type: "finish-step" as const, finishReason: "stop" };
			})(),
		});

		const toolBuilder: ToolBuilder = () => ({});

		const executor = createModelExecutor({
			streamFn,
			modelResolver: mockModelResolver(),
			toolBuilder,
		});

		const root = realpathSync(mkdtempSync(join(tmpdir(), "bp-model-tools-")));
		const receipt = await executor.executePacketAsync(
			makeModelPacket(),
			root,
			bus,
		);

		expect(receipt.exitCode).toBe(0);
		expect(receipt.stdout).toBe("File written.");

		const toolStarted = events.find((e) => e.kind === "tool-call-started");
		expect(toolStarted).toBeDefined();
		if (toolStarted?.kind === "tool-call-started") {
			expect(toolStarted.toolName).toBe("write_file");
			expect(toolStarted.toolCallId).toBe("call-write-1");
			expect(toolStarted.args).toEqual({
				path: "output.txt",
				content: "hello",
			});
		}

		const toolCompleted = events.find((e) => e.kind === "tool-call-completed");
		expect(toolCompleted).toBeDefined();
		if (toolCompleted?.kind === "tool-call-completed") {
			expect(toolCompleted.toolName).toBe("write_file");
			expect(toolCompleted.result).toEqual({
				success: true,
				path: "output.txt",
			});
		}
	});

	it("emits events for multiple tool calls in sequence", async () => {
		const bus = createEventBus();
		const events: ExecutionEvent[] = [];
		bus.subscribe((e) => events.push(e));

		const streamFn: StreamFunction = () => ({
			fullStream: (async function* () {
				yield {
					type: "tool-call" as const,
					toolCallId: "call-1",
					toolName: "write_file",
					input: { path: "a.txt", content: "aaa" },
				};
				yield {
					type: "tool-result" as const,
					toolCallId: "call-1",
					toolName: "write_file",
					output: { success: true, path: "a.txt" },
				};
				yield {
					type: "tool-call" as const,
					toolCallId: "call-2",
					toolName: "run_command",
					input: { command: "echo", args: ["done"] },
				};
				yield {
					type: "tool-result" as const,
					toolCallId: "call-2",
					toolName: "run_command",
					output: {
						success: true,
						exitCode: 0,
						stdout: "done\n",
						stderr: "",
					},
				};
				yield { type: "text-delta" as const, textDelta: "All done." };
				yield { type: "finish-step" as const, finishReason: "stop" };
			})(),
		});

		const toolBuilder: ToolBuilder = () => ({});

		const executor = createModelExecutor({
			streamFn,
			modelResolver: mockModelResolver(),
			toolBuilder,
		});

		const root = realpathSync(mkdtempSync(join(tmpdir(), "bp-model-tools-")));
		await executor.executePacketAsync(makeModelPacket(), root, bus);

		const toolStarts = events.filter((e) => e.kind === "tool-call-started");
		expect(toolStarts).toHaveLength(2);

		const toolCompletions = events.filter(
			(e) => e.kind === "tool-call-completed",
		);
		expect(toolCompletions).toHaveLength(2);

		if (toolStarts[0].kind === "tool-call-started") {
			expect(toolStarts[0].toolName).toBe("write_file");
		}
		if (toolStarts[1].kind === "tool-call-started") {
			expect(toolStarts[1].toolName).toBe("run_command");
		}
	});

	it("creates real tools from adapters-tools via toolBuilder", async () => {
		const root = realpathSync(
			mkdtempSync(join(tmpdir(), "bp-model-tools-real-")),
		);

		// Use the real createToolRegistry to verify the integration
		const { createToolRegistry } = await import(
			"../../packages/adapters-tools/src/index"
		);
		const registry = createToolRegistry(root);

		// Simulate what the real toolBuilder does: create registry and use it
		const writeResult = registry.write_file({
			path: "test-output.txt",
			content: "written by tool",
		});
		expect(writeResult.success).toBe(true);
		expect(readFileSync(join(root, "test-output.txt"), "utf8")).toBe(
			"written by tool",
		);

		const runResult = registry.run_command({
			command: "cat",
			args: ["test-output.txt"],
		});
		expect(runResult.success).toBe(true);
		expect(runResult.stdout.trim()).toBe("written by tool");
	});

	it("does not pass tools when toolBuilder returns empty object", async () => {
		const bus = createEventBus();
		let capturedTools: Record<string, unknown> | undefined;

		const streamFn: StreamFunction = (options) => {
			capturedTools = options.tools as Record<string, unknown> | undefined;
			return {
				fullStream: (async function* () {
					yield { type: "text-delta" as const, textDelta: "No tools" };
					yield { type: "finish-step" as const, finishReason: "stop" };
				})(),
			};
		};

		const toolBuilder: ToolBuilder = () => ({});

		const executor = createModelExecutor({
			streamFn,
			modelResolver: mockModelResolver(),
			toolBuilder,
		});

		const root = realpathSync(mkdtempSync(join(tmpdir(), "bp-model-tools-")));
		await executor.executePacketAsync(makeModelPacket(), root, bus);

		// Empty tools object should result in tools being undefined
		expect(capturedTools).toBeUndefined();
	});

	it("checks output files after model execution with tools", async () => {
		const bus = createEventBus();
		const root = realpathSync(
			mkdtempSync(join(tmpdir(), "bp-model-tools-output-")),
		);

		// Pre-create the expected output file (simulating what the tool would do)
		const { writeFileSync, mkdirSync } = await import("node:fs");
		mkdirSync(join(root, "out"), { recursive: true });
		writeFileSync(join(root, "out/result.txt"), "model output");

		const streamFn: StreamFunction = () => ({
			fullStream: (async function* () {
				yield { type: "text-delta" as const, textDelta: "Done" };
				yield { type: "finish-step" as const, finishReason: "stop" };
			})(),
		});

		const executor = createModelExecutor({
			streamFn,
			modelResolver: mockModelResolver(),
			toolBuilder: () => ({}),
		});

		const receipt = await executor.executePacketAsync(
			makeModelPacket(undefined, {
				requiredOutputs: ["out/result.txt", "missing.txt"],
			}),
			root,
			bus,
		);

		expect(receipt.outputChecks).toEqual([
			{ path: "out/result.txt", exists: true },
			{ path: "missing.txt", exists: false },
		]);
	});
});
