import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { UnitPacket } from "@buildplane/kernel";
import { createEventBus } from "@buildplane/kernel";
import { describe, expect, it, vi } from "vitest";
import { createCodexRenderer } from "../../adapters-models/src/renderers/index.js";
import { createCodexExecutor } from "../src/codex-executor.js";

// ---------------------------------------------------------------------------
// Mock spawn factory
// ---------------------------------------------------------------------------

interface MockSpawnOpts {
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	/** Simulate an error event instead of a close event (e.g. ENOENT). */
	errorMessage?: string;
}

function createMockSpawn(opts: MockSpawnOpts = {}) {
	const { stdout = "", stderr = "", exitCode = 0, errorMessage } = opts;

	return vi.fn((..._args: unknown[]) => {
		const emitter = new EventEmitter();

		const stdoutStream = new Readable({ read() {} });
		const stderrStream = new Readable({ read() {} });

		(emitter as Record<string, unknown>).stdout = stdoutStream;
		(emitter as Record<string, unknown>).stderr = stderrStream;
		(emitter as Record<string, unknown>).kill = () => {
			emitter.emit("close", -1);
		};

		setImmediate(() => {
			if (errorMessage) {
				const err = new Error(errorMessage);
				emitter.emit("error", err);
				return;
			}

			if (stdout) stdoutStream.push(stdout);
			stdoutStream.push(null);

			if (stderr) stderrStream.push(stderr);
			stderrStream.push(null);

			emitter.emit("close", exitCode);
		});

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
			provider: "codex",
			model: "o4-mini",
			prompt: "Write a hello world file.",
		},
		verification: {
			requiredOutputs: [],
		},
		...overrides,
	};
}

const PROJECT_ROOT = "/tmp/bp-codex-test";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CodexExecutor", () => {
	it("successful run → receipt built with correct fields, stdout preserved", async () => {
		const mockSpawn = createMockSpawn({ stdout: "task done", exitCode: 0 });
		const executor = createCodexExecutor({ spawnFn: mockSpawn as never });
		const eventBus = createEventBus();

		const receipt = await executor.executePacketAsync(
			makePacket(),
			PROJECT_ROOT,
			eventBus,
		);

		expect(receipt.exitCode).toBe(0);
		expect(receipt.stdout).toBe("task done");
		expect(receipt.stderr).toBe("");
		expect(receipt.cwd).toBe(PROJECT_ROOT);
		expect(receipt.command).toBe("codex");
	});

	it("non-zero exit code → receipt has correct exitCode", async () => {
		const mockSpawn = createMockSpawn({ stderr: "error details", exitCode: 2 });
		const executor = createCodexExecutor({ spawnFn: mockSpawn as never });
		const eventBus = createEventBus();

		const receipt = await executor.executePacketAsync(
			makePacket(),
			PROJECT_ROOT,
			eventBus,
		);

		expect(receipt.exitCode).toBe(2);
		expect(receipt.stderr).toBe("error details");
	});

	it("ENOENT error → receipt has helpful error message, exitCode 1", async () => {
		const mockSpawn = createMockSpawn({
			errorMessage: "spawn codex ENOENT",
		});
		const executor = createCodexExecutor({ spawnFn: mockSpawn as never });
		const eventBus = createEventBus();

		const receipt = await executor.executePacketAsync(
			makePacket(),
			PROJECT_ROOT,
			eventBus,
		);

		expect(receipt.exitCode).toBe(1);
		expect(receipt.stderr).toMatch(/codex binary not found/i);
	});

	it("emits execution-started and command-execution-complete events", async () => {
		const mockSpawn = createMockSpawn({ exitCode: 0 });
		const executor = createCodexExecutor({ spawnFn: mockSpawn as never });
		const eventBus = createEventBus();

		const eventKinds: string[] = [];
		eventBus.subscribe((ev) => eventKinds.push(ev.kind));

		await executor.executePacketAsync(makePacket(), PROJECT_ROOT, eventBus);

		expect(eventKinds).toContain("execution-started");
		expect(eventKinds).toContain("command-execution-complete");
	});

	it("systemPrompt + prompt → folded prompt passed to codex CLI", async () => {
		const mockSpawn = createMockSpawn({ exitCode: 0 });
		const executor = createCodexExecutor({ spawnFn: mockSpawn as never });
		const eventBus = createEventBus();

		const packet = makePacket({
			model: {
				provider: "codex",
				model: "o4-mini",
				systemPrompt: "You are an expert.",
				prompt: "Write a hello world file.",
			},
		});

		await executor.executePacketAsync(packet, PROJECT_ROOT, eventBus);

		expect(mockSpawn).toHaveBeenCalledOnce();
		const spawnArgs: string[] = mockSpawn.mock.calls[0][1] as string[];
		// The prompt (last arg) should contain both systemPrompt and prompt
		const promptArg = spawnArgs[spawnArgs.length - 1];
		expect(promptArg).toContain("You are an expert.");
		expect(promptArg).toContain("---");
		expect(promptArg).toContain("Write a hello world file.");
	});

	it("renderer path folds injected memories into the codex prompt", async () => {
		const mockSpawn = createMockSpawn({ exitCode: 0 });
		const executor = createCodexExecutor({
			renderer: createCodexRenderer(),
			spawnFn: mockSpawn as never,
		});
		const eventBus = createEventBus();

		const packet = makePacket({
			intent: {
				objective: "Write a hello world file.",
				taskType: "implement",
				context: {
					files: ["output/result.txt"],
					priorWork: [],
					memories: ["[procedure] always write output/hello.js first"],
				},
				constraints: {
					scope: ["output/"],
					verification: ["test -f output/hello.js"],
				},
				features: {
					ambiguity: "low",
					reversibility: "easy",
					verifierStrength: "strong",
				},
			},
			model: {
				provider: "codex",
				model: "o4-mini",
			},
		});

		await executor.executePacketAsync(packet, PROJECT_ROOT, eventBus);

		const spawnArgs: string[] = mockSpawn.mock.calls[0][1] as string[];
		const promptArg = spawnArgs[spawnArgs.length - 1];
		expect(promptArg).toContain("<memories>");
		expect(promptArg).toContain("always write output/hello.js first");
	});

	it("model and --model flag passed to codex CLI args", async () => {
		const mockSpawn = createMockSpawn({ exitCode: 0 });
		const executor = createCodexExecutor({ spawnFn: mockSpawn as never });
		const eventBus = createEventBus();

		const packet = makePacket({
			model: { provider: "codex", model: "o3", prompt: "Do something." },
		});

		await executor.executePacketAsync(packet, PROJECT_ROOT, eventBus);

		const spawnArgs: string[] = mockSpawn.mock.calls[0][1] as string[];
		const modelIndex = spawnArgs.indexOf("--model");
		expect(modelIndex).toBeGreaterThanOrEqual(0);
		expect(spawnArgs[modelIndex + 1]).toBe("o3");
	});

	it("on Windows, npm-style cmd shims resolve to the JS entry so multiline prompts survive", async () => {
		const shimRoot = mkdtempSync(join(tmpdir(), "bp-codex-win-shim-"));
		const shimBin = join(shimRoot, "bin");
		const shimEntry = join(
			shimBin,
			"node_modules",
			"@openai",
			"codex",
			"bin",
			"codex.js",
		);
		mkdirSync(join(shimBin, "node_modules", "@openai", "codex", "bin"), {
			recursive: true,
		});
		writeFileSync(join(shimBin, "codex.cmd"), "@echo off\r\nexit /b 0\r\n");
		writeFileSync(shimEntry, "process.exit(0);\n");

		const originalPlatform = process.platform;
		const originalPath = process.env.PATH;
		const pathValue = [shimBin, originalPath ?? ""].filter(Boolean).join(";");
		Object.defineProperty(process, "platform", {
			configurable: true,
			value: "win32",
		});
		process.env.PATH = pathValue;

		try {
			const mockSpawn = createMockSpawn({ exitCode: 0 });
			const executor = createCodexExecutor({ spawnFn: mockSpawn as never });
			const eventBus = createEventBus();
			const packet = makePacket({
				model: {
					provider: "codex",
					model: "o4-mini",
					prompt: "<task>\nUse output/memory-helped.js from memories\n</task>",
				},
			});

			await executor.executePacketAsync(packet, PROJECT_ROOT, eventBus);

			expect(mockSpawn).toHaveBeenCalledOnce();
			expect(mockSpawn.mock.calls[0][0]).toBe(process.execPath);
			const spawnArgs: string[] = mockSpawn.mock.calls[0][1] as string[];
			expect(spawnArgs[0]).toBe(shimEntry);
			expect(spawnArgs[spawnArgs.length - 1]).toContain(
				"output/memory-helped.js",
			);
		} finally {
			Object.defineProperty(process, "platform", {
				configurable: true,
				value: originalPlatform,
			});
			process.env.PATH = originalPath;
			rmSync(shimRoot, { force: true, recursive: true });
		}
	});

	it("on Windows, local node_modules/.bin shims resolve to the package JS entry", async () => {
		const shimRoot = mkdtempSync(join(tmpdir(), "bp-codex-win-local-"));
		const shimDir = join(shimRoot, "node_modules");
		const shimEntry = join(shimDir, "@openai", "codex", "bin", "codex.js");
		const shimPath = join(shimDir, ".bin", "codex.cmd");
		mkdirSync(join(shimDir, ".bin"), { recursive: true });
		mkdirSync(join(shimDir, "@openai", "codex", "bin"), { recursive: true });
		writeFileSync(shimPath, "@echo off\r\nexit /b 0\r\n");
		writeFileSync(shimEntry, "process.exit(0);\n");

		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", {
			configurable: true,
			value: "win32",
		});

		try {
			const mockSpawn = createMockSpawn({ exitCode: 0 });
			const executor = createCodexExecutor({
				cliBinary: shimPath,
				spawnFn: mockSpawn as never,
			});
			const eventBus = createEventBus();

			await executor.executePacketAsync(makePacket(), PROJECT_ROOT, eventBus);

			expect(mockSpawn).toHaveBeenCalledOnce();
			expect(mockSpawn.mock.calls[0][0]).toBe(process.execPath);
			const spawnArgs: string[] = mockSpawn.mock.calls[0][1] as string[];
			expect(spawnArgs[0]).toBe(shimEntry);
		} finally {
			Object.defineProperty(process, "platform", {
				configurable: true,
				value: originalPlatform,
			});
			rmSync(shimRoot, { force: true, recursive: true });
		}
	});

	it("command packet (has execution block) → throws before spawn", async () => {
		const mockSpawn = createMockSpawn();
		const executor = createCodexExecutor({ spawnFn: mockSpawn as never });
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
			verification: { requiredOutputs: [] },
		};

		await expect(
			executor.executePacketAsync(packet, PROJECT_ROOT, eventBus),
		).rejects.toThrow(/command packet/i);

		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it("sync executePacket throws", () => {
		const executor = createCodexExecutor();
		expect(() => executor.executePacket(makePacket(), PROJECT_ROOT)).toThrow(
			/async/i,
		);
	});
});
