import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type {
	ExecutionEvent,
	TaskRenderer,
	UnitPacket,
} from "@buildplane/kernel";
import { createEventBus } from "@buildplane/kernel";
import { describe, expect, it, vi } from "vitest";
import { createClaudeCodeExecutor } from "../src/claude-code-executor.js";

// ---------------------------------------------------------------------------
// Mock spawn factory
// ---------------------------------------------------------------------------

interface MockSpawnOpts {
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	delay?: number;
}

function createMockSpawn(opts: MockSpawnOpts = {}) {
	const { stdout = "", stderr = "", exitCode = 0, delay = 0 } = opts;

	return vi.fn((..._args: unknown[]) => {
		const emitter = new EventEmitter();

		const stdoutStream = new Readable({ read() {} });
		const stderrStream = new Readable({ read() {} });

		// Attach streams to the emitter to mimic ChildProcess
		(emitter as Record<string, unknown>).stdout = stdoutStream;
		(emitter as Record<string, unknown>).stderr = stderrStream;

		// Attach a kill method
		(emitter as Record<string, unknown>).kill = () => {
			emitter.emit("close", -1);
		};

		const fire = () => {
			if (stdout) stdoutStream.push(stdout);
			stdoutStream.push(null);

			if (stderr) stderrStream.push(stderr);
			stderrStream.push(null);

			emitter.emit("close", exitCode);
		};

		if (delay > 0) {
			setTimeout(fire, delay);
		} else {
			// Use setImmediate so callers can attach listeners first
			setImmediate(fire);
		}

		return emitter;
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePacket(overrides: Partial<UnitPacket> = {}): UnitPacket {
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
			provider: "claude-code",
			model: "claude-opus-4-5",
			prompt: "Write a hello world file.",
		},
		execution_role: "implementer",
		verification: {
			requiredOutputs: [],
		},
		...overrides,
	};
}

const PROJECT_ROOT = "/tmp/bp-test";
const UNSAFE_PERMISSION_FLAG = ["--dangerously", "skip", "permissions"].join(
	"-",
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ClaudeCodeExecutor", () => {
	it("valid Claude JSON output → receipt built, stdout preserved, one model-response-complete event emitted", async () => {
		const claudeOutput = JSON.stringify({ result: "Hello, world!" });
		const mockSpawn = createMockSpawn({ stdout: claudeOutput, exitCode: 0 });
		const executor = createClaudeCodeExecutor({ spawnFn: mockSpawn as never });
		const eventBus = createEventBus();

		const events: string[] = [];
		eventBus.subscribe((ev) => events.push(ev.kind));

		const receipt = await executor.executePacketAsync(
			makePacket(),
			PROJECT_ROOT,
			eventBus,
		);

		expect(receipt.exitCode).toBe(0);
		expect(receipt.stdout).toBe(claudeOutput);
		expect(events.filter((k) => k === "model-response-complete")).toHaveLength(
			1,
		);
	});

	it("governed packet → rejects before spawning the ambient Claude Code CLI", async () => {
		const mockSpawn = createMockSpawn({
			stdout: JSON.stringify({ result: "must not execute" }),
			exitCode: 0,
		});
		const executor = createClaudeCodeExecutor({ spawnFn: mockSpawn as never });
		const eventBus = createEventBus();

		await expect(
			executor.executePacketAsync(
				makePacket({ provenance_ref: "admission:governed-run" }),
				PROJECT_ROOT,
				eventBus,
			),
		).rejects.toThrow(/AMBIENT_HOST_WORKER_FORBIDDEN/);

		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it("malformed JSON → receipt built, no crash, no model-response-complete event", async () => {
		const mockSpawn = createMockSpawn({
			stdout: "not valid json at all",
			exitCode: 0,
		});
		const executor = createClaudeCodeExecutor({ spawnFn: mockSpawn as never });
		const eventBus = createEventBus();

		const events: string[] = [];
		eventBus.subscribe((ev) => events.push(ev.kind));

		const receipt = await executor.executePacketAsync(
			makePacket(),
			PROJECT_ROOT,
			eventBus,
		);

		expect(receipt.exitCode).toBe(0);
		expect(receipt.stdout).toBe("not valid json at all");
		expect(events.filter((k) => k === "model-response-complete")).toHaveLength(
			0,
		);
	});

	it("missing model.prompt → throws before spawn", async () => {
		const mockSpawn = createMockSpawn();
		const executor = createClaudeCodeExecutor({ spawnFn: mockSpawn as never });
		const eventBus = createEventBus();

		const packet = makePacket({
			model: { provider: "claude-code", model: "claude-opus-4-5" },
		});

		await expect(
			executor.executePacketAsync(packet, PROJECT_ROOT, eventBus),
		).rejects.toThrow(/prompt/i);

		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it("model.tools present → throws before spawn", async () => {
		const mockSpawn = createMockSpawn();
		const executor = createClaudeCodeExecutor({ spawnFn: mockSpawn as never });
		const eventBus = createEventBus();

		const packet = makePacket({
			model: {
				provider: "claude-code",
				model: "claude-opus-4-5",
				prompt: "do something",
				tools: [{ name: "bash", description: "Run bash", parameters: {} }],
			},
		});

		await expect(
			executor.executePacketAsync(packet, PROJECT_ROOT, eventBus),
		).rejects.toThrow(/tools/i);

		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it("command packet (has execution block) → throws before spawn", async () => {
		const mockSpawn = createMockSpawn();
		const executor = createClaudeCodeExecutor({ spawnFn: mockSpawn as never });
		const eventBus = createEventBus();

		const packet: UnitPacket = {
			unit: {
				id: "unit-cmd",
				kind: "command",
				scope: "task",
				inputRefs: [],
				expectedOutputs: [],
				verificationContract: "exit-0-and-required-outputs",
				policyProfile: "default",
			},
			execution: { command: "echo", args: ["hi"] },
			execution_role: "implementer",
			verification: { requiredOutputs: [] },
		};

		await expect(
			executor.executePacketAsync(packet, PROJECT_ROOT, eventBus),
		).rejects.toThrow(/command packet/i);

		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it("systemPrompt + prompt → CLI args contain folded prompt", async () => {
		const mockSpawn = createMockSpawn({
			stdout: JSON.stringify({ result: "ok" }),
		});
		const executor = createClaudeCodeExecutor({ spawnFn: mockSpawn as never });
		const eventBus = createEventBus();

		const packet = makePacket({
			model: {
				provider: "claude-code",
				model: "claude-opus-4-5",
				systemPrompt: "You are an expert.",
				prompt: "Write a hello world file.",
			},
		});

		await executor.executePacketAsync(packet, PROJECT_ROOT, eventBus);

		expect(mockSpawn).toHaveBeenCalledOnce();
		const callArgs = mockSpawn.mock.calls[0];
		// callArgs[1] is the args array
		const spawnArgs: string[] = callArgs[1] as string[];
		const promptIndex = spawnArgs.indexOf("-p");
		expect(promptIndex).toBeGreaterThanOrEqual(0);
		const passedPrompt = spawnArgs[promptIndex + 1];
		expect(passedPrompt).toContain("You are an expert.");
		expect(passedPrompt).toContain("---");
		expect(passedPrompt).toContain("Write a hello world file.");
	});

	it("model.model passed as --model argument", async () => {
		const mockSpawn = createMockSpawn({
			stdout: JSON.stringify({ result: "done" }),
		});
		const executor = createClaudeCodeExecutor({ spawnFn: mockSpawn as never });
		const eventBus = createEventBus();

		const packet = makePacket({
			model: {
				provider: "claude-code",
				model: "claude-sonnet-4-5",
				prompt: "Do something.",
			},
		});

		await executor.executePacketAsync(packet, PROJECT_ROOT, eventBus);

		const spawnArgs: string[] = mockSpawn.mock.calls[0][1] as string[];
		const modelIndex = spawnArgs.indexOf("--model");
		expect(modelIndex).toBeGreaterThanOrEqual(0);
		expect(spawnArgs[modelIndex + 1]).toBe("claude-sonnet-4-5");
	});

	it("absent unsafeMode omits dangerous flag and emits no unsafe evidence", async () => {
		const mockSpawn = createMockSpawn({
			stdout: JSON.stringify({ result: "done" }),
		});
		const executor = createClaudeCodeExecutor({ spawnFn: mockSpawn as never });
		const eventBus = createEventBus();
		const events: ExecutionEvent[] = [];
		eventBus.subscribe((ev) => events.push(ev));

		await executor.executePacketAsync(makePacket(), PROJECT_ROOT, eventBus);

		expect(mockSpawn).toHaveBeenCalledOnce();
		const spawnArgs: string[] = mockSpawn.mock.calls[0][1] as string[];
		expect(spawnArgs).not.toContain(UNSAFE_PERMISSION_FLAG);
		expect(events).not.toContainEqual(
			expect.objectContaining({
				kind: "evidence-recorded",
				evidenceKind: "claude-code-unsafe-mode-used",
			}),
		);
	});

	it("unsafeMode false omits dangerous flag and emits no unsafe evidence", async () => {
		const mockSpawn = createMockSpawn({
			stdout: JSON.stringify({ result: "done" }),
		});
		const executor = createClaudeCodeExecutor({
			spawnFn: mockSpawn as never,
			unsafeMode: false,
		});
		const eventBus = createEventBus();
		const events: ExecutionEvent[] = [];
		eventBus.subscribe((ev) => events.push(ev));

		await executor.executePacketAsync(makePacket(), PROJECT_ROOT, eventBus);

		expect(mockSpawn).toHaveBeenCalledOnce();
		const spawnArgs: string[] = mockSpawn.mock.calls[0][1] as string[];
		expect(spawnArgs).not.toContain(UNSAFE_PERMISSION_FLAG);
		expect(events).not.toContainEqual(
			expect.objectContaining({
				kind: "evidence-recorded",
				evidenceKind: "claude-code-unsafe-mode-used",
			}),
		);
	});

	it("explicit unsafeMode true passes dangerous flag and emits evidence before spawn", async () => {
		const mockSpawn = createMockSpawn({
			stdout: JSON.stringify({ result: "done" }),
		});
		const eventOrder: string[] = [];
		const orderedSpawn = vi.fn((...args: unknown[]) => {
			eventOrder.push("spawn");
			return mockSpawn(...args);
		});
		const executor = createClaudeCodeExecutor({
			spawnFn: orderedSpawn as never,
			unsafeMode: true,
		});
		const eventBus = createEventBus();
		const events: ExecutionEvent[] = [];
		eventBus.subscribe((ev) => {
			events.push(ev);
			if (
				ev.kind === "evidence-recorded" &&
				ev.evidenceKind === "claude-code-unsafe-mode-used"
			) {
				eventOrder.push("unsafe-evidence");
			}
		});

		await executor.executePacketAsync(makePacket(), PROJECT_ROOT, eventBus);

		expect(orderedSpawn).toHaveBeenCalledOnce();
		const spawnArgs: string[] = orderedSpawn.mock.calls[0][1] as string[];
		expect(spawnArgs).toContain(UNSAFE_PERMISSION_FLAG);
		expect(events).toContainEqual(
			expect.objectContaining({
				kind: "evidence-recorded",
				evidenceKind: "claude-code-unsafe-mode-used",
				status: "unsafe-mode-used",
			}),
		);
		expect(eventOrder.indexOf("unsafe-evidence")).toBeGreaterThanOrEqual(0);
		expect(eventOrder.indexOf("spawn")).toBeGreaterThanOrEqual(0);
		expect(eventOrder.indexOf("unsafe-evidence")).toBeLessThan(
			eventOrder.indexOf("spawn"),
		);
	});

	it("custom cliBinary option → used in spawn call", async () => {
		const mockSpawn = createMockSpawn({
			stdout: JSON.stringify({ result: "ok" }),
		});
		const executor = createClaudeCodeExecutor({
			spawnFn: mockSpawn as never,
			cliBinary: "/usr/local/bin/claude-custom",
		});
		const eventBus = createEventBus();

		await executor.executePacketAsync(makePacket(), PROJECT_ROOT, eventBus);

		expect(mockSpawn).toHaveBeenCalledOnce();
		expect(mockSpawn.mock.calls[0][0]).toBe("/usr/local/bin/claude-custom");
	});

	// ── Tool-permission grant (R7 FIX 1) ─────────────────────────────
	// A headless `claude -p` worker denies Edit/Write/Bash unless the tool is
	// granted via `--allowedTools`; the dogfood loop worker made zero edits until
	// this grant was threaded. Scope stays bounded post-hoc by M4 diff-scope +
	// acceptance, NOT by withholding the grant.

	it("allowedTools option → passed as --allowedTools followed by each tool name", async () => {
		const mockSpawn = createMockSpawn({
			stdout: JSON.stringify({ result: "done" }),
		});
		const executor = createClaudeCodeExecutor({
			spawnFn: mockSpawn as never,
			allowedTools: ["Edit", "Write", "Read", "Glob", "Grep", "Bash"],
		});
		const eventBus = createEventBus();

		await executor.executePacketAsync(makePacket(), PROJECT_ROOT, eventBus);

		const spawnArgs: string[] = mockSpawn.mock.calls[0][1] as string[];
		const idx = spawnArgs.indexOf("--allowedTools");
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(spawnArgs.slice(idx + 1, idx + 7)).toEqual([
			"Edit",
			"Write",
			"Read",
			"Glob",
			"Grep",
			"Bash",
		]);
	});

	it("absent allowedTools omits the --allowedTools flag (Claude default-deny stands)", async () => {
		const mockSpawn = createMockSpawn({
			stdout: JSON.stringify({ result: "done" }),
		});
		const executor = createClaudeCodeExecutor({ spawnFn: mockSpawn as never });
		const eventBus = createEventBus();

		await executor.executePacketAsync(makePacket(), PROJECT_ROOT, eventBus);

		const spawnArgs: string[] = mockSpawn.mock.calls[0][1] as string[];
		expect(spawnArgs).not.toContain("--allowedTools");
	});

	it("empty allowedTools array omits the --allowedTools flag", async () => {
		const mockSpawn = createMockSpawn({
			stdout: JSON.stringify({ result: "done" }),
		});
		const executor = createClaudeCodeExecutor({
			spawnFn: mockSpawn as never,
			allowedTools: [],
		});
		const eventBus = createEventBus();

		await executor.executePacketAsync(makePacket(), PROJECT_ROOT, eventBus);

		const spawnArgs: string[] = mockSpawn.mock.calls[0][1] as string[];
		expect(spawnArgs).not.toContain("--allowedTools");
	});

	it("granting allowedTools does NOT enable the dangerous skip-permissions flag", async () => {
		const mockSpawn = createMockSpawn({
			stdout: JSON.stringify({ result: "done" }),
		});
		const executor = createClaudeCodeExecutor({
			spawnFn: mockSpawn as never,
			allowedTools: ["Write", "Bash"],
		});
		const eventBus = createEventBus();

		await executor.executePacketAsync(makePacket(), PROJECT_ROOT, eventBus);

		const spawnArgs: string[] = mockSpawn.mock.calls[0][1] as string[];
		expect(spawnArgs).not.toContain(UNSAFE_PERMISSION_FLAG);
	});

	// ── Configurable timeout (R7 FIX 2) ──────────────────────────────
	// The worker timeout must be threadable — a hardcoded 300000ms killed a real
	// nine-file derivation mid-flight. A never-closing child proves the configured
	// value drives the kill (a hardcoded 300000ms would hang past vitest's 15s cap).

	it("custom timeoutMs is honored (worker killed with the configured value, not the 300000ms default)", async () => {
		const neverClosing = vi.fn((..._args: unknown[]) => {
			const emitter = new EventEmitter();
			const stdoutStream = new Readable({ read() {} });
			const stderrStream = new Readable({ read() {} });
			(emitter as Record<string, unknown>).stdout = stdoutStream;
			(emitter as Record<string, unknown>).stderr = stderrStream;
			// Real ChildProcess.kill() fires `close` on a later tick, so the timeout
			// handler finishes setting exitCode/stderr before close is observed.
			(emitter as Record<string, unknown>).kill = () => {
				setImmediate(() => emitter.emit("close", -1));
			};
			return emitter;
		});
		const executor = createClaudeCodeExecutor({
			spawnFn: neverClosing as never,
			timeoutMs: 25,
		});
		const eventBus = createEventBus();

		const receipt = await executor.executePacketAsync(
			makePacket(),
			PROJECT_ROOT,
			eventBus,
		);

		expect(receipt.exitCode).toBe(-1);
		expect(receipt.stderr).toBe("Timeout after 25ms");
	});

	it("sync executePacket throws", () => {
		const executor = createClaudeCodeExecutor();
		expect(() => executor.executePacket(makePacket(), PROJECT_ROOT)).toThrow(
			/async/i,
		);
	});

	it("stream-json output → one model-token-delta per assistant stream line + terminal complete", async () => {
		const lines = `${[
			JSON.stringify({ type: "system", subtype: "init" }),
			JSON.stringify({
				type: "assistant",
				message: { content: [{ type: "text", text: "hello " }] },
			}),
			JSON.stringify({
				type: "assistant",
				message: { content: [{ type: "text", text: "world" }] },
			}),
			JSON.stringify({
				type: "result",
				subtype: "success",
				result: "hello world",
			}),
		].join("\n")}\n`;
		const mockSpawn = createMockSpawn({ stdout: lines, exitCode: 0 });
		const executor = createClaudeCodeExecutor({ spawnFn: mockSpawn as never });
		const eventBus = createEventBus();
		const kinds: string[] = [];
		eventBus.subscribe((ev) => kinds.push(ev.kind));

		await executor.executePacketAsync(makePacket(), PROJECT_ROOT, eventBus);

		expect(kinds.filter((k) => k === "model-token-delta")).toHaveLength(2);
		expect(kinds.filter((k) => k === "model-response-complete")).toHaveLength(
			1,
		);
	});

	it("stream-json args contain --output-format stream-json --verbose", async () => {
		const lines = `${JSON.stringify({ type: "result", subtype: "success", result: "ok" })}\n`;
		const mockSpawn = createMockSpawn({ stdout: lines, exitCode: 0 });
		const executor = createClaudeCodeExecutor({ spawnFn: mockSpawn as never });
		const eventBus = createEventBus();

		await executor.executePacketAsync(makePacket(), PROJECT_ROOT, eventBus);

		const spawnArgs: string[] = mockSpawn.mock.calls[0][1] as string[];
		const fmtIndex = spawnArgs.indexOf("--output-format");
		expect(fmtIndex).toBeGreaterThanOrEqual(0);
		expect(spawnArgs[fmtIndex + 1]).toBe("stream-json");
		expect(spawnArgs).toContain("--verbose");
	});

	it("stream-json result line usage → receipt.tokenUsage = input + output tokens", async () => {
		const lines = `${[
			JSON.stringify({
				type: "assistant",
				message: { content: [{ type: "text", text: "hi" }] },
			}),
			JSON.stringify({
				type: "result",
				subtype: "success",
				result: "done",
				usage: { input_tokens: 120, output_tokens: 30 },
			}),
		].join("\n")}\n`;
		const mockSpawn = createMockSpawn({ stdout: lines, exitCode: 0 });
		const executor = createClaudeCodeExecutor({ spawnFn: mockSpawn as never });
		const eventBus = createEventBus();

		const receipt = await executor.executePacketAsync(
			makePacket(),
			PROJECT_ROOT,
			eventBus,
		);

		expect(receipt.tokenUsage).toBe(150);
	});

	it("no usage on the result line → receipt.tokenUsage is undefined", async () => {
		const lines = `${JSON.stringify({ type: "result", subtype: "success", result: "ok" })}\n`;
		const mockSpawn = createMockSpawn({ stdout: lines, exitCode: 0 });
		const executor = createClaudeCodeExecutor({ spawnFn: mockSpawn as never });
		const eventBus = createEventBus();

		const receipt = await executor.executePacketAsync(
			makePacket(),
			PROJECT_ROOT,
			eventBus,
		);

		expect(receipt.tokenUsage).toBeUndefined();
	});

	it("pre-aborted signal → child killed, non-zero receipt, no token deltas", async () => {
		const mockSpawn = createMockSpawn({ stdout: "", exitCode: 0, delay: 50 });
		const executor = createClaudeCodeExecutor({ spawnFn: mockSpawn as never });
		const eventBus = createEventBus();
		const kinds: string[] = [];
		eventBus.subscribe((ev) => kinds.push(ev.kind));
		const controller = new AbortController();
		controller.abort();

		const receipt = await executor.executePacketAsync(
			makePacket(),
			PROJECT_ROOT,
			eventBus,
			controller.signal,
		);

		expect(receipt.exitCode).not.toBe(0);
		expect(kinds.filter((k) => k === "model-token-delta")).toHaveLength(0);
	});

	it("stream-json tool_use block → one onToolEvent request emission", async () => {
		const lines = `${[
			JSON.stringify({
				type: "assistant",
				message: {
					content: [
						{
							type: "tool_use",
							id: "toolu_abc",
							name: "Bash",
							input: { command: "ls -la" },
						},
					],
				},
			}),
			JSON.stringify({ type: "result", subtype: "success", result: "ok" }),
		].join("\n")}\n`;
		const mockSpawn = createMockSpawn({ stdout: lines, exitCode: 0 });
		const toolEvents: unknown[] = [];
		const executor = createClaudeCodeExecutor({
			spawnFn: mockSpawn as never,
			onToolEvent: (ev) => toolEvents.push(ev),
		});
		const eventBus = createEventBus();

		await executor.executePacketAsync(makePacket(), PROJECT_ROOT, eventBus);

		expect(toolEvents).toEqual([
			{
				phase: "request",
				toolUseId: "toolu_abc",
				toolName: "Bash",
				input: { command: "ls -la" },
			},
		]);
	});

	it("stream-json tool_result block → one onToolEvent result emission", async () => {
		const lines = `${[
			JSON.stringify({
				type: "user",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_abc",
							content: "total 0",
							is_error: false,
						},
					],
				},
			}),
			JSON.stringify({ type: "result", subtype: "success", result: "ok" }),
		].join("\n")}\n`;
		const mockSpawn = createMockSpawn({ stdout: lines, exitCode: 0 });
		const toolEvents: unknown[] = [];
		const executor = createClaudeCodeExecutor({
			spawnFn: mockSpawn as never,
			onToolEvent: (ev) => toolEvents.push(ev),
		});
		const eventBus = createEventBus();

		await executor.executePacketAsync(makePacket(), PROJECT_ROOT, eventBus);

		expect(toolEvents).toEqual([
			{
				phase: "result",
				toolUseId: "toolu_abc",
				content: "total 0",
				isError: false,
			},
		]);
	});

	it("tool_result content as block array → normalized to flat string; is_error true preserved", async () => {
		const lines = `${[
			JSON.stringify({
				type: "user",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_x",
							content: [
								{ type: "text", text: "line1\n" },
								{ type: "text", text: "line2" },
							],
							is_error: true,
						},
					],
				},
			}),
			JSON.stringify({ type: "result", subtype: "success", result: "ok" }),
		].join("\n")}\n`;
		const mockSpawn = createMockSpawn({ stdout: lines, exitCode: 0 });
		const toolEvents: Array<{ content?: string; isError?: boolean }> = [];
		const executor = createClaudeCodeExecutor({
			spawnFn: mockSpawn as never,
			onToolEvent: (ev) => toolEvents.push(ev),
		});
		const eventBus = createEventBus();

		await executor.executePacketAsync(makePacket(), PROJECT_ROOT, eventBus);

		expect(toolEvents).toHaveLength(1);
		expect(toolEvents[0].content).toBe("line1\nline2");
		expect(toolEvents[0].isError).toBe(true);
	});

	it("tool_use/tool_result parsing leaves token-delta + result handling unchanged", async () => {
		const lines = `${[
			JSON.stringify({
				type: "assistant",
				message: {
					content: [
						{ type: "text", text: "thinking " },
						{
							type: "tool_use",
							id: "toolu_1",
							name: "Write",
							input: { path: "a.txt" },
						},
					],
				},
			}),
			JSON.stringify({
				type: "user",
				message: {
					content: [
						{ type: "tool_result", tool_use_id: "toolu_1", content: "done" },
					],
				},
			}),
			JSON.stringify({
				type: "result",
				subtype: "success",
				result: "all done",
				usage: { input_tokens: 100, output_tokens: 20 },
			}),
		].join("\n")}\n`;
		const mockSpawn = createMockSpawn({ stdout: lines, exitCode: 0 });
		const toolEvents: unknown[] = [];
		const executor = createClaudeCodeExecutor({
			spawnFn: mockSpawn as never,
			onToolEvent: (ev) => toolEvents.push(ev),
		});
		const eventBus = createEventBus();
		const kinds: string[] = [];
		eventBus.subscribe((ev) => kinds.push(ev.kind));

		const receipt = await executor.executePacketAsync(
			makePacket(),
			PROJECT_ROOT,
			eventBus,
		);

		// Existing behavior unchanged: one text delta, one terminal complete, usage summed.
		expect(kinds.filter((k) => k === "model-token-delta")).toHaveLength(1);
		expect(kinds.filter((k) => k === "model-response-complete")).toHaveLength(
			1,
		);
		expect(receipt.tokenUsage).toBe(120);
		// And both tool phases captured.
		expect(toolEvents).toHaveLength(2);
	});

	it("no onToolEvent callback → tool blocks parsed silently, token-delta path intact", async () => {
		const lines = `${[
			JSON.stringify({
				type: "assistant",
				message: {
					content: [
						{ type: "text", text: "hi" },
						{ type: "tool_use", id: "t1", name: "Bash", input: {} },
					],
				},
			}),
			JSON.stringify({ type: "result", subtype: "success", result: "ok" }),
		].join("\n")}\n`;
		const mockSpawn = createMockSpawn({ stdout: lines, exitCode: 0 });
		const executor = createClaudeCodeExecutor({ spawnFn: mockSpawn as never });
		const eventBus = createEventBus();
		const kinds: string[] = [];
		eventBus.subscribe((ev) => kinds.push(ev.kind));

		await executor.executePacketAsync(makePacket(), PROJECT_ROOT, eventBus);

		expect(kinds.filter((k) => k === "model-token-delta")).toHaveLength(1);
		expect(kinds.filter((k) => k === "model-response-complete")).toHaveLength(
			1,
		);
	});

	it("mid-flight abort → child killed, non-zero receipt", async () => {
		const lines = `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } })}\n`;
		const mockSpawn = createMockSpawn({
			stdout: lines,
			exitCode: 0,
			delay: 50,
		});
		const executor = createClaudeCodeExecutor({ spawnFn: mockSpawn as never });
		const eventBus = createEventBus();
		const controller = new AbortController();

		const promise = executor.executePacketAsync(
			makePacket(),
			PROJECT_ROOT,
			eventBus,
			controller.signal,
		);
		controller.abort();
		const receipt = await promise;

		expect(receipt.exitCode).not.toBe(0);
	});

	it.each([
		"reviewer",
		"adversary",
	] as const)("passes the %s packet role to its renderer", async (execution_role) => {
		const mockSpawn = createMockSpawn({
			stdout: JSON.stringify({ result: "done" }),
		});
		const renderer: TaskRenderer = {
			provider: "test",
			render: vi.fn(() => ({ prompt: "rendered task" })),
		};
		const executor = createClaudeCodeExecutor({
			renderer,
			spawnFn: mockSpawn as never,
		});
		const eventBus = createEventBus();
		const packet = makePacket({
			execution_role,
			intent: {
				objective: "Review the task.",
				taskType: "review",
				context: { files: [] },
				constraints: { scope: [], verification: [] },
				features: {
					ambiguity: "low",
					reversibility: "easy",
					verifierStrength: "strong",
				},
			},
			model: { provider: "claude-code", model: "claude-opus-4-5" },
		});

		await executor.executePacketAsync(packet, PROJECT_ROOT, eventBus);

		expect(renderer.render).toHaveBeenCalledWith(packet.intent, execution_role);
	});
});
