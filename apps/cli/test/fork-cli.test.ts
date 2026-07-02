import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ForkPlanShape = {
	new_run_id: string;
	workspace_path: string;
	checkout_sha: string;
	packet_json: unknown;
	parent_run_id: string;
	parent_event_id: string;
};

const hoisted = vi.hoisted(() => {
	const forkState: {
		plan: ForkPlanShape;
		parsePacketImpl: (input: string) => unknown;
		runPacketImpl: (packet: unknown) => unknown;
		runPacketAsyncImpl: (packet: unknown) => Promise<unknown>;
	} = {
		plan: {
			new_run_id: "fork-run-123",
			workspace_path: "/tmp/fork-workspace",
			checkout_sha: "abc1234",
			packet_json: {},
			parent_run_id: "parent-run-1",
			parent_event_id: "parent-event-1",
		},
		parsePacketImpl: (input: string) => JSON.parse(input),
		runPacketImpl: () => ({ run: { status: "passed" } }),
		runPacketAsyncImpl: async () => ({ run: { status: "passed" } }),
	};

	const parseUnitPacketMock = vi.fn((input: string) =>
		forkState.parsePacketImpl(input),
	);
	const runPacketMock = vi.fn((packet: unknown) =>
		forkState.runPacketImpl(packet),
	);
	const runPacketAsyncMock = vi.fn((packet: unknown) =>
		forkState.runPacketAsyncImpl(packet),
	);
	const createTapeEmitterMock = vi.fn(async () => ({
		emit: vi.fn(),
		close: vi.fn(async () => {}),
	}));

	const spawnSyncMock = vi.fn(
		(
			command: string,
			args: readonly string[] = [],
			_options?: { cwd?: string; encoding?: string },
		) => {
			if (command === "git" && args[0] === "-C" && args[2] === "status") {
				return { status: 0, stdout: "", stderr: "" };
			}
			if (command === "git" && args[0] === "-C" && args[2] === "checkout") {
				return { status: 0, stdout: "", stderr: "" };
			}
			if (args[0] === "fork" && args[1] === "plan") {
				return {
					status: 0,
					stdout: `${JSON.stringify(forkState.plan)}\n`,
					stderr: "",
				};
			}
			return { status: 0, stdout: "", stderr: "" };
		},
	);

	const spawnMock = vi.fn(() => {
		const child = new EventEmitter() as EventEmitter & {
			stdin: PassThrough;
			stderr: PassThrough;
			exitCode: number | null;
			kill: (signal?: string) => boolean;
		};
		child.stdin = new PassThrough();
		child.stderr = new PassThrough();
		child.exitCode = null;
		child.kill = () => {
			child.exitCode = 0;
			child.emit("exit", 0);
			return true;
		};
		return child;
	});

	return {
		forkState,
		parseUnitPacketMock,
		runPacketMock,
		runPacketAsyncMock,
		createTapeEmitterMock,
		spawnSyncMock,
		spawnMock,
	};
});

const {
	forkState,
	parseUnitPacketMock,
	runPacketMock,
	runPacketAsyncMock,
	createTapeEmitterMock,
} = hoisted;

vi.mock("node:child_process", async () => {
	const actual =
		await vi.importActual<typeof import("node:child_process")>(
			"node:child_process",
		);
	return {
		...actual,
		spawn: hoisted.spawnMock,
		spawnSync: hoisted.spawnSyncMock,
	};
});

vi.mock("@buildplane/adapters-tools", () => ({
	createToolRegistry: vi.fn(() => ({
		run_command: vi.fn(() => ({ exitCode: 0, stdout: "", stderr: "" })),
		write_file: vi.fn(() => ({ path: "out.txt" })),
	})),
}));

vi.mock("@buildplane/ledger-client", async (importOriginal) => ({
	// Spread the real module so value imports (e.g. the `RunOutcome` enum
	// dereferenced at module-eval by run-cli's RUN_OUTCOME_WIRE) resolve — mocking
	// only the two functions below left `RunOutcome` undefined and crashed the whole
	// fork-cli suite before any test ran.
	...(await importOriginal<typeof import("@buildplane/ledger-client")>()),
	createTapeEmitter: hoisted.createTapeEmitterMock,
	newEventId: vi.fn(() => "01900000-0000-7000-8000-000000000000"),
}));

vi.mock("@buildplane/kernel", () => ({
	createBuildplaneOrchestrator: vi.fn(() => ({
		initializeProject: vi.fn(),
		runPacket: hoisted.runPacketMock,
		runPacketAsync: hoisted.runPacketAsyncMock,
		getStatus: vi.fn(() => ({ initialized: true })),
		inspect: vi.fn(),
		approveRun: vi.fn(),
		rejectSuspendedRun: vi.fn(),
		runGraphAsync: vi.fn(),
		runStrategy: vi.fn(),
	})),
	createEventBus: vi.fn(() => {
		const listeners: Array<(event: unknown) => void> = [];
		return {
			subscribe(listener: (event: unknown) => void) {
				listeners.push(listener);
				return () => {
					const index = listeners.indexOf(listener);
					if (index >= 0) listeners.splice(index, 1);
				};
			},
			emit(event: unknown) {
				for (const listener of [...listeners]) listener(event);
			},
		};
	}),
	parseUnitPacket: hoisted.parseUnitPacketMock,
}));

vi.mock("@buildplane/runtime", () => ({
	executePacket: vi.fn(() => ({
		command: "node",
		args: [],
		cwd: process.cwd(),
		startedAt: new Date().toISOString(),
		completedAt: new Date().toISOString(),
		exitCode: 0,
		stdout: "",
		stderr: "",
		outputChecks: [],
	})),
}));

vi.mock("@buildplane/policy", () => ({
	evaluateRun: vi.fn(() => ({ outcome: "accepted" })),
	// run-cli reads these off the policy module on every orchestrator load (the
	// finalization acceptance gate, M4-S3; the supervisor-loop runaway-guard
	// budget subscription, GAP-7) — the mock must expose the same surface or
	// vitest throws "No <export> is defined on the mock" before fork even runs.
	evaluateAcceptanceContract: vi.fn(() => null),
	evaluateArchitectureDiffScope: vi.fn(() => ({
		status: "passed",
		outOfScopeFiles: [],
		deniedFiles: [],
	})),
	evaluateBudgets: vi.fn(() => null),
}));

vi.mock("@buildplane/storage", () => ({
	createBuildplaneStorage: vi.fn(() => ({
		getStatusSnapshot: vi.fn(() => ({ initialized: true })),
	})),
	createEventStore: vi.fn(() => ({
		persistEvent: vi.fn(),
	})),
	resolveProjectLayout: vi.fn((root: string) => ({
		stateDbPath: join(root, ".buildplane", "missing-state.db"),
	})),
	createLearningStore: vi.fn(),
}));

vi.mock("@buildplane/adapters-git", () => ({
	createGitWorktreeAdapter: vi.fn(() => ({
		assertRunnableRepository: vi.fn(() => ({ headSha: "abc1234" })),
		prepareWorkspace: vi.fn(() => ({
			path: "/tmp/fork-workspace",
			headSha: "abc1234",
		})),
	})),
}));

import { createBuildplaneOrchestrator } from "@buildplane/kernel";
import { runCli } from "../src/run-cli";

function createTempForkInputs() {
	const root = mkdtempSync(join(tmpdir(), "buildplane-fork-cli-test-"));
	mkdirSync(root, { recursive: true });
	const packetPath = join(root, "fork-packet.json");
	writeFileSync(packetPath, JSON.stringify({ marker: true }, null, 2));
	return { root, packetPath };
}

beforeEach(() => {
	vi.clearAllMocks();
	forkState.plan = {
		new_run_id: "fork-run-123",
		workspace_path: "/tmp/fork-workspace",
		checkout_sha: "abc1234",
		packet_json: {},
		parent_run_id: "parent-run-1",
		parent_event_id: "parent-event-1",
	};
	forkState.parsePacketImpl = (input: string) => JSON.parse(input);
	forkState.runPacketImpl = () => ({ run: { status: "passed" } });
	forkState.runPacketAsyncImpl = async () => ({ run: { status: "passed" } });
	process.env.BUILDPLANE_NATIVE_BIN = "/tmp/buildplane-native";
});

afterEach(() => {
	delete process.env.BUILDPLANE_NATIVE_BIN;
});

describe("fork CLI orchestration", () => {
	it("routes fork execution through runPacketAsync for planned model packets", async () => {
		const rawForkPacket = {
			unit: {
				id: "unit-fork-model",
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
				prompt: "Repair the failing test",
			},
			routingHints: { preferredWorker: "claude-code" },
		};
		forkState.plan.packet_json = rawForkPacket;
		forkState.parsePacketImpl = () => ({
			...rawForkPacket,
			verification: { requiredOutputs: [] },
		});
		forkState.runPacketImpl = () => {
			throw new Error("sync path should not be used for forked model packets");
		};
		forkState.runPacketAsyncImpl = async () => ({ run: { status: "passed" } });

		const { root, packetPath } = createTempForkInputs();
		const stdout: string[] = [];
		const stderr: string[] = [];

		const exitCode = await runCli(
			[
				"fork",
				"parent-run-1",
				"--at",
				"parent-event-1",
				"--packet",
				packetPath,
				"--workspace",
				root,
			],
			{
				cwd: root,
				stdout: (line) => stdout.push(line),
				stderr: (line) => stderr.push(line),
			},
		);

		expect(exitCode).toBe(0);
		expect(stderr.join("\n")).not.toContain("sync path should not be used");
		expect(parseUnitPacketMock).toHaveBeenCalledWith(
			JSON.stringify(rawForkPacket),
		);
		expect(runPacketAsyncMock).toHaveBeenCalledTimes(1);
		expect(runPacketAsyncMock).toHaveBeenCalledWith(
			expect.objectContaining({
				verification: { requiredOutputs: [] },
				routingHints: { preferredWorker: "claude-code" },
			}),
			expect.any(Object),
			expect.objectContaining({
				runId: "fork-run-123",
				parentRunId: "parent-run-1",
			}),
		);
		expect(runPacketMock).not.toHaveBeenCalled();
		expect(stdout.join("\n")).toContain(
			"fork run completed: fork-run-123 (exit 0)",
		);
	});

	it("normalizes planned packet JSON through parseUnitPacket before fork execution", async () => {
		const rawForkPacket = {
			unit: {
				id: "unit-fork-command",
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
		};
		forkState.plan.packet_json = rawForkPacket;
		forkState.parsePacketImpl = () => ({
			...rawForkPacket,
			verification: { requiredOutputs: [] },
		});
		forkState.runPacketImpl = (packet: unknown) => {
			const typed = packet as { verification?: { requiredOutputs?: string[] } };
			if (
				!typed.verification ||
				!Array.isArray(typed.verification.requiredOutputs)
			) {
				throw new Error("packet verification defaults were not normalized");
			}
			return { run: { status: "passed" } };
		};
		forkState.runPacketAsyncImpl = async (packet: unknown) => {
			const typed = packet as { verification?: { requiredOutputs?: string[] } };
			if (
				!typed.verification ||
				!Array.isArray(typed.verification.requiredOutputs)
			) {
				throw new Error("packet verification defaults were not normalized");
			}
			return { run: { status: "passed" } };
		};

		const { root, packetPath } = createTempForkInputs();
		const stderr: string[] = [];

		const exitCode = await runCli(
			[
				"fork",
				"parent-run-1",
				"--at",
				"parent-event-1",
				"--packet",
				packetPath,
				"--workspace",
				root,
			],
			{
				cwd: root,
				stdout: () => {},
				stderr: (line) => stderr.push(line),
			},
		);

		expect(exitCode).toBe(0);
		expect(stderr.join("\n")).not.toContain(
			"packet verification defaults were not normalized",
		);
		expect(parseUnitPacketMock).toHaveBeenCalledWith(
			JSON.stringify(rawForkPacket),
		);
		expect(runPacketAsyncMock).toHaveBeenCalledWith(
			expect.objectContaining({
				execution: rawForkPacket.execution,
				verification: { requiredOutputs: [] },
			}),
			expect.any(Object),
			expect.objectContaining({
				runId: "fork-run-123",
				parentRunId: "parent-run-1",
			}),
		);
	});

	it("closes the fork ledger emitter when planned packet normalization throws", async () => {
		forkState.plan.packet_json = { invalid: true };
		forkState.parsePacketImpl = () => {
			throw new Error("invalid fork packet");
		};

		const { root, packetPath } = createTempForkInputs();
		const stderr: string[] = [];

		const exitCode = await runCli(
			[
				"fork",
				"parent-run-1",
				"--at",
				"parent-event-1",
				"--packet",
				packetPath,
				"--workspace",
				root,
			],
			{
				cwd: root,
				stdout: () => {},
				stderr: (line) => stderr.push(line),
			},
		);

		expect(exitCode).toBe(1);
		expect(stderr.join("\n")).toContain(
			"fork orchestrator error: Error: invalid fork packet",
		);
		const emitter = await createTapeEmitterMock.mock.results[0]?.value;
		expect(emitter?.close).toHaveBeenCalledTimes(1);
	});

	it("closes the fork ledger emitter when orchestrator setup throws after handshake", async () => {
		vi.mocked(createBuildplaneOrchestrator).mockImplementationOnce(() => {
			throw new Error("orchestrator setup failed");
		});

		const { root, packetPath } = createTempForkInputs();
		const stderr: string[] = [];

		const exitCode = await runCli(
			[
				"fork",
				"parent-run-1",
				"--at",
				"parent-event-1",
				"--packet",
				packetPath,
				"--workspace",
				root,
			],
			{
				cwd: root,
				stdout: () => {},
				stderr: (line) => stderr.push(line),
			},
		);

		expect(exitCode).toBe(1);
		expect(stderr.join("\n")).toContain(
			"fork orchestrator error: Error: orchestrator setup failed",
		);
		const emitter = await createTapeEmitterMock.mock.results[0]?.value;
		expect(emitter?.close).toHaveBeenCalledTimes(1);
	});
});
