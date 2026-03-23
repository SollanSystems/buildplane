import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createModelExecutor,
	type ModelResolver,
	type StreamFunction,
} from "../../packages/adapters-models/src/model-executor";
import {
	createEventBus,
	type ExecutionEvent,
} from "../../packages/kernel/src/events";
import type { UnitPacket } from "../../packages/kernel/src/run-loop";

function makeModelPacket(
	overrides?: Partial<NonNullable<UnitPacket["model"]>>,
): UnitPacket {
	return {
		unit: {
			id: "unit-model-test",
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
		},
	};
}

function makeCommandPacket(): UnitPacket {
	return {
		unit: {
			id: "unit-cmd-test",
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

function mockStreamFn(): StreamFunction {
	return () => ({
		fullStream: (async function* () {
			yield { type: "text-delta" as const, textDelta: "Hello" };
			yield { type: "text-delta" as const, textDelta: " world" };
			yield {
				type: "finish-step" as const,
				finishReason: "stop",
				usage: { promptTokens: 10, completionTokens: 5 },
			};
		})(),
	});
}

function mockModelResolver(): ModelResolver {
	return (provider: string, modelId: string) => ({
		provider,
		modelId,
		fake: true,
	});
}

describe("model executor", () => {
	it("emits token delta events for model packets", async () => {
		const bus = createEventBus();
		const events: ExecutionEvent[] = [];
		bus.subscribe((e) => events.push(e));

		const executor = createModelExecutor({
			streamFn: mockStreamFn(),
			modelResolver: mockModelResolver(),
		});

		const root = mkdtempSync(join(tmpdir(), "bp-model-"));
		const receipt = await executor.executePacketAsync(
			makeModelPacket(),
			root,
			bus,
		);

		expect(receipt.exitCode).toBe(0);
		expect(receipt.stdout).toBe("Hello world");

		const tokenDeltas = events.filter((e) => e.kind === "model-token-delta");
		expect(tokenDeltas).toHaveLength(2);
		if (tokenDeltas[0].kind === "model-token-delta") {
			expect(tokenDeltas[0].delta).toBe("Hello");
		}
		if (tokenDeltas[1].kind === "model-token-delta") {
			expect(tokenDeltas[1].delta).toBe(" world");
		}

		const responseComplete = events.find(
			(e) => e.kind === "model-response-complete",
		);
		expect(responseComplete).toBeDefined();
		if (responseComplete?.kind === "model-response-complete") {
			expect(responseComplete.text).toBe("Hello world");
			expect(responseComplete.finishReason).toBe("stop");
			expect(responseComplete.usage?.promptTokens).toBe(10);
			expect(responseComplete.usage?.completionTokens).toBe(5);
		}
	});

	it("emits tool call events", async () => {
		const bus = createEventBus();
		const events: ExecutionEvent[] = [];
		bus.subscribe((e) => events.push(e));

		const streamFn: StreamFunction = () => ({
			fullStream: (async function* () {
				yield {
					type: "tool-call" as const,
					toolCallId: "call-1",
					toolName: "read_file",
					input: { path: "/tmp/test.txt" },
				};
				yield {
					type: "tool-result" as const,
					toolCallId: "call-1",
					toolName: "read_file",
					output: "file contents",
				};
				yield { type: "text-delta" as const, textDelta: "Done" };
				yield { type: "finish-step" as const, finishReason: "stop" };
			})(),
		});

		const executor = createModelExecutor({
			streamFn,
			modelResolver: mockModelResolver(),
		});

		const root = mkdtempSync(join(tmpdir(), "bp-model-"));
		const receipt = await executor.executePacketAsync(
			makeModelPacket(),
			root,
			bus,
		);

		expect(receipt.exitCode).toBe(0);

		const toolStarted = events.find((e) => e.kind === "tool-call-started");
		expect(toolStarted).toBeDefined();
		if (toolStarted?.kind === "tool-call-started") {
			expect(toolStarted.toolName).toBe("read_file");
			expect(toolStarted.toolCallId).toBe("call-1");
		}

		const toolCompleted = events.find((e) => e.kind === "tool-call-completed");
		expect(toolCompleted).toBeDefined();
		if (toolCompleted?.kind === "tool-call-completed") {
			expect(toolCompleted.toolName).toBe("read_file");
			expect(toolCompleted.result).toBe("file contents");
		}
	});

	it("delegates command packets to sync executor", async () => {
		const bus = createEventBus();
		const root = mkdtempSync(join(tmpdir(), "bp-model-"));
		const executor = createModelExecutor({
			streamFn: mockStreamFn(),
			modelResolver: mockModelResolver(),
		});

		const receipt = await executor.executePacketAsync(
			makeCommandPacket(),
			root,
			bus,
		);

		expect(receipt.exitCode).toBe(0);
		expect(receipt.stdout).toContain("hello");
		expect(receipt.command).toBe("echo");
	});

	it("handles model execution errors gracefully", async () => {
		const bus = createEventBus();
		const events: ExecutionEvent[] = [];
		bus.subscribe((e) => events.push(e));

		const failingStreamFn: StreamFunction = () => ({
			// biome-ignore lint/correctness/useYield: intentionally throws before yielding
			fullStream: (async function* () {
				throw new Error("API connection failed");
			})(),
		});

		const executor = createModelExecutor({
			streamFn: failingStreamFn,
			modelResolver: mockModelResolver(),
		});

		const root = mkdtempSync(join(tmpdir(), "bp-model-"));
		const receipt = await executor.executePacketAsync(
			makeModelPacket(),
			root,
			bus,
		);

		expect(receipt.exitCode).toBe(1);
		expect(receipt.stderr).toContain("API connection failed");

		const errorEvent = events.find((e) => e.kind === "execution-error");
		expect(errorEvent).toBeDefined();
		if (errorEvent?.kind === "execution-error") {
			expect(errorEvent.message).toContain("API connection failed");
			expect(errorEvent.phase).toBe("model-execution");
		}
	});

	it("rejects unsupported provider via resolver", async () => {
		const bus = createEventBus();
		const events: ExecutionEvent[] = [];
		bus.subscribe((e) => events.push(e));

		const strictResolver: ModelResolver = (provider) => {
			throw new Error(`Unsupported model provider: ${provider}`);
		};

		const executor = createModelExecutor({
			streamFn: mockStreamFn(),
			modelResolver: strictResolver,
		});

		const root = mkdtempSync(join(tmpdir(), "bp-model-"));
		const receipt = await executor.executePacketAsync(
			makeModelPacket({ provider: "unknown-provider" }),
			root,
			bus,
		);

		expect(receipt.exitCode).toBe(1);
		expect(receipt.stderr).toContain("Unsupported model provider");
	});

	it("sync executePacket throws for model packets", () => {
		const executor = createModelExecutor({
			streamFn: mockStreamFn(),
			modelResolver: mockModelResolver(),
		});
		const root = mkdtempSync(join(tmpdir(), "bp-model-"));

		expect(() => executor.executePacket(makeModelPacket(), root)).toThrow(
			"Sync executePacket only supports command packets",
		);
	});

	it("aborts model execution when signal fires", async () => {
		const bus = createEventBus();
		const events: ExecutionEvent[] = [];
		bus.subscribe((e) => events.push(e));

		const controller = new AbortController();

		const streamFn: StreamFunction = () => ({
			fullStream: (async function* () {
				yield { type: "text-delta" as const, textDelta: "chunk1 " };
				yield { type: "text-delta" as const, textDelta: "chunk2 " };
				// Abort after 2 chunks
				controller.abort();
				yield { type: "text-delta" as const, textDelta: "chunk3 " };
				yield {
					type: "finish-step" as const,
					finishReason: "stop",
					usage: { promptTokens: 10, completionTokens: 30 },
				};
			})(),
		});

		const executor = createModelExecutor({
			streamFn,
			modelResolver: mockModelResolver(),
			toolBuilder: () => ({}),
		});

		const root = mkdtempSync(join(tmpdir(), "bp-model-"));
		const receipt = await executor.executePacketAsync(
			makeModelPacket(),
			root,
			bus,
			controller.signal,
		);

		expect(receipt.exitCode).toBe(1);
		expect(receipt.stderr).toContain("aborted");
		expect(receipt.stdout).toContain("chunk1");
		expect(receipt.stdout).toContain("chunk2");

		const responseComplete = events.find(
			(e) => e.kind === "model-response-complete",
		);
		expect(responseComplete).toBeDefined();
		if (responseComplete?.kind === "model-response-complete") {
			expect(responseComplete.finishReason).toBe("aborted");
		}
	});
});
