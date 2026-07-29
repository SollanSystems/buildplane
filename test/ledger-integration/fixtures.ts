import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
	createTapeEmitter,
	newEventId,
	type TapeEmitter,
} from "@buildplane/ledger-client";

const LEDGER_FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));
export const LEDGER_TEST_REPO_ROOT = resolve(LEDGER_FIXTURES_DIR, "../..");

const cleanupTempDir = async (dir: string) => {
	await rm(dir, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 100,
	});
};

export function resolveNativeBinaryForLedgerTests(): string {
	const explicit = process.env.BUILDPLANE_NATIVE_BIN;
	if (explicit) {
		return explicit;
	}

	const debugBinary = join(
		LEDGER_TEST_REPO_ROOT,
		"native",
		"target",
		"debug",
		"buildplane-native",
	);
	if (existsSync(debugBinary)) {
		return debugBinary;
	}

	const releaseBinary = join(
		LEDGER_TEST_REPO_ROOT,
		"native",
		"target",
		"release",
		"buildplane-native",
	);
	if (existsSync(releaseBinary)) {
		return releaseBinary;
	}

	return "buildplane-native";
}

export interface LedgerFixture {
	dir: string; // absolute tempdir path
	runId: string;
	binary: string; // resolved native binary
	child: ChildProcess;
	emitter: TapeEmitter;
	cleanup: () => Promise<void>;
}

/** Create an isolated workspace, spawn the real bp-ledger subprocess, perform
 * handshake, and hand back an emitter + cleanup. Intended for Layer 3
 * integration tests.
 *
 * CRITICAL: all paths here live under `mkdtemp(tmpdir())`; no test using this
 * helper touches `process.cwd()` or any repo-local path. This mitigates the
 * class of test-isolation bug that corrupted feat/ledger-phase-a and
 * feat/ledger-phase-b during earlier smoke tests.
 */
export async function makeLedgerFixture(options?: {
	runId?: string;
	handshakeTimeoutMs?: number;
}): Promise<LedgerFixture> {
	const dir = await mkdtemp(join(tmpdir(), "bp-ledger-it-"));
	const runId = options?.runId ?? "01919000-0000-7000-8000-000000000000";

	// Locate the native binary using the ledger-integration fixture root rather
	// than process.cwd(), which can be changed by unrelated tests before this
	// helper runs.
	const binary = resolveNativeBinaryForLedgerTests();

	// NOTE: cwd must NOT be a bare temp dir. The native binary resolves its
	// "native workspace" by walking ancestors of cwd looking for Cargo.toml +
	// packs/. Use the repo root derived from this fixture file so the binary
	// starts successfully; the --workspace flag points to the isolated temp dir
	// that holds the SQLite ledger.
	const child = spawn(
		binary,
		[
			"ledger",
			"serve",
			"--run-id",
			runId,
			"--workspace",
			dir,
			"--schema-version",
			"1",
		],
		{ stdio: ["pipe", "inherit", "pipe"], cwd: LEDGER_TEST_REPO_ROOT },
	);
	if (!child.stdin || !child.stderr) {
		throw new Error("subprocess stdio missing");
	}
	const exit = new Promise<number>((resolve) => {
		child.on("exit", (code) => resolve(code ?? -1));
	});

	const emitter = await createTapeEmitter({
		childStdin: child.stdin as Writable,
		childStderr: child.stderr as Readable,
		childExit: exit,
		workspacePath: dir,
		runId,
		handshakeTimeoutMs: options?.handshakeTimeoutMs ?? 5_000,
	});

	// Track whether the child has exited via any means (exit code or signal).
	let childDead = false;
	child.on("exit", () => {
		childDead = true;
	});

	const cleanup = async () => {
		// Only call emitter.close() if the child is still alive. A second
		// close() on an already-exited child creates a promise that never
		// settles (stdin is gone, close_ack never arrives) and hangs forever.
		// Use `childDead` rather than `exitCode` because signal-killed processes
		// have `exitCode === null` even after they are gone.
		if (!childDead) {
			try {
				await emitter.close();
			} catch {
				// Tolerate errors (e.g. emitter already failed/closed).
			}
		}
		if (!childDead) {
			child.kill("SIGTERM");
			await once(child, "exit");
		}
		await cleanupTempDir(dir);
	};

	return { dir, runId, binary, child, emitter, cleanup };
}

export interface LegacyReplayTapeFixture {
	dir: string;
	eventsDbPath: string;
	runId: string;
	unitStartedEventId: string;
	cleanup: () => Promise<void>;
}

/**
 * Create a minimal unsigned legacy tape for read-only replay tests.
 *
 * This deliberately uses the generic native `ledger serve` endpoint rather
 * than `run --raw`: unsafe runs must not manufacture a signed tape authority
 * or a trusted receipt. The fixture exists only to preserve backwards replay
 * coverage for already-recorded legacy events.
 */
export async function makeLegacyReplayTapeFixture(): Promise<LegacyReplayTapeFixture> {
	const fixture = await makeLedgerFixture();
	const runStartedEventId = newEventId();
	const unitStartedEventId = newEventId();
	const unitCompletedEventId = newEventId();
	const runCompletedEventId = newEventId();

	fixture.emitter.emit(
		"run_started",
		{
			RunStartedV1: {
				packet_hash: "sha256:legacy-replay-fixture",
				git_head: "deadbeef",
				workspace_path: fixture.dir,
				config: {},
				parent_run_id: null,
			},
		},
		{ id: runStartedEventId },
	);
	fixture.emitter.emit(
		"unit_started",
		{
			UnitStartedV1: {
				unit_id: "legacy-replay-unit",
				parent_unit_id: null,
				unit_kind: "command",
				policy: {},
			},
		},
		{ id: unitStartedEventId, parent: runStartedEventId },
	);
	fixture.emitter.emit(
		"unit_completed",
		{
			UnitCompletedV1: {
				unit_id: "legacy-replay-unit",
				outcome: "passed",
				artifacts: [],
			},
		},
		{ id: unitCompletedEventId, parent: unitStartedEventId },
	);
	fixture.emitter.emit(
		"run_completed",
		{
			RunCompletedV1: {
				outcome: "passed",
				duration_ms: "1",
				event_count: "4",
				unit_count: "1",
			},
		},
		{ id: runCompletedEventId, parent: runStartedEventId },
	);
	await fixture.emitter.close();

	return {
		dir: fixture.dir,
		eventsDbPath: join(fixture.dir, ".buildplane", "ledger", "events.db"),
		runId: "01919000-0000-7000-8000-000000000000",
		unitStartedEventId,
		cleanup: fixture.cleanup,
	};
}

export interface LegacyForkPreflightTapeFixture {
	dir: string;
	eventsDbPath: string;
	runId: string;
	runStartedEventId: string;
	unitStartedEventId: string;
	preUnitGitCheckpointEventId: string;
	cleanup: () => Promise<void>;
}

/**
 * Create the minimum unsigned legacy tape needed to reject invalid fork
 * targets before fork execution. It uses generic native `ledger serve`, never
 * `run --raw`, and intentionally creates no git repository, kernel key, or
 * trusted authority artifact.
 */
export async function makeLegacyForkPreflightTapeFixture(): Promise<LegacyForkPreflightTapeFixture> {
	const fixture = await makeLedgerFixture();
	const runId = "01919000-0000-7000-8000-000000000000";
	const runStartedEventId = newEventId();
	const unitStartedEventId = newEventId();
	const preUnitGitCheckpointEventId = newEventId();

	try {
		fixture.emitter.emit(
			"run_started",
			{
				RunStartedV1: {
					packet_hash: `sha256:${"a".repeat(64)}`,
					git_head: "deadbeef",
					workspace_path: fixture.dir,
					config: {},
					parent_run_id: null,
				},
			},
			{ id: runStartedEventId },
		);
		fixture.emitter.emit(
			"unit_started",
			{
				UnitStartedV1: {
					unit_id: "legacy-fork-preflight-unit",
					parent_unit_id: null,
					unit_kind: "command",
					policy: {},
				},
			},
			{ id: unitStartedEventId, parent: runStartedEventId },
		);
		fixture.emitter.emit(
			"git_checkpoint",
			{
				GitCheckpointV1: {
					boundary: "pre-unit",
					reference: `refs/buildplane/run/${runId}`,
					commit_sha: "a".repeat(40),
					unit_id: "legacy-fork-preflight-unit",
					git_status: { kind: "ok" },
				},
			},
			{ id: preUnitGitCheckpointEventId, parent: unitStartedEventId },
		);
		await fixture.emitter.close();
	} catch (error) {
		await fixture.cleanup();
		throw error;
	}

	return {
		dir: fixture.dir,
		eventsDbPath: join(fixture.dir, ".buildplane", "ledger", "events.db"),
		runId,
		runStartedEventId,
		unitStartedEventId,
		preUnitGitCheckpointEventId,
		cleanup: fixture.cleanup,
	};
}

export interface BuildplaneRunFixture {
	dir: string;
	/** Conventional ledger location; unsafe raw execution does not create it. */
	eventsDbPath: string;
	exitCode: number;
	cleanup: () => Promise<void>;
}

/** Spin up an isolated workspace, initialize a Buildplane project, write a
 * packet.json, and run `runCli()` in-process with process.cwd() temporarily
 * chdir'd to the tempdir. Restores cwd + BUILDPLANE_NATIVE_BIN in finally.
 * Returns the unsafe-run result plus the conventional events.db path; the path
 * is not populated by raw execution.
 *
 * CRITICAL: tests using this fixture MUST NOT run concurrently with each
 * other (process.chdir is process-global). Vitest's default is worker-per-file
 * with sequential tests in a file — co-locating such tests in one file or
 * different files is fine; inside one file, don't mark `concurrent: true`.
 *
	// Binary resolution (same strategy as makeLedgerFixture):
	//  1. Honor BUILDPLANE_NATIVE_BIN if already set in the environment.
	//  2. Look for native/target/debug/buildplane-native relative to this
	//     fixture's repo root, not process.cwd().
	//  3. Fall back to "buildplane-native" on PATH.
	// The resolved binary is injected as BUILDPLANE_NATIVE_BIN so the run-cli
 *
 * NOTE on --raw: this helper exists for deferred unsafe execution and fork/VCR
 * migration. Raw execution does not spawn a ledger, create a signed tape, or
 * issue a trusted receipt. Tests needing a tape must use makeLedgerFixture()
 * or a purpose-built legacy tape fixture instead.
 */
export async function makeBuildplaneRunFixture(opts: {
	packet: unknown;
}): Promise<BuildplaneRunFixture> {
	const dir = await mkdtemp(join(tmpdir(), "bp-run-"));

	const nativeBinary = resolveNativeBinaryForLedgerTests();

	const runGit = (args: string[]) => {
		const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		if (r.status !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
		}
	};
	runGit(["init", "-q"]);
	runGit(["config", "user.email", "test@test"]);
	runGit(["config", "user.name", "test"]);
	runGit(["commit", "-q", "--allow-empty", "-m", "init"]);

	// Import runCli dynamically so module eval doesn't pull the whole CLI
	// into memory for non-fixture tests.
	const { runCli } = (await import("../../apps/cli/src/run-cli.js")) as {
		runCli: (
			argv: string[],
			options?: {
				cwd?: string;
				stdout?: (line: string) => void;
				stderr?: (line: string) => void;
			},
		) => Promise<number>;
	};

	const originalCwd = process.cwd();
	const originalNativeBin = process.env.BUILDPLANE_NATIVE_BIN;
	const originalHome = process.env.HOME;
	let exitCode = 1;
	try {
		process.chdir(dir);
		// Inject resolved binary path so run-cli can find it from the tempdir.
		process.env.BUILDPLANE_NATIVE_BIN = nativeBinary;

		// Keep the legacy helper's process environment isolated. This seed is
		// retained for deferred fixture compatibility only: raw execution does not
		// start `ledger serve --sign` or use it to create tape authority.
		const home = join(dir, "home");
		process.env.HOME = home;
		const keyDir = join(home, ".buildplane", "keys", "kernel");
		mkdirSync(keyDir, { recursive: true });
		writeFileSync(join(keyDir, "kernel-main.ed25519"), Buffer.alloc(32, 7));

		// 1. Initialize the Buildplane project (creates .buildplane/ structure).
		await runCli(["init"], {
			cwd: dir,
			stdout: (_s: string) => {},
			stderr: (_s: string) => {},
		});

		// 2. Commit the init artifacts so the working tree is clean.
		runGit(["add", "-A"]);
		runGit(["commit", "-q", "-m", "buildplane: init"]);

		// 3. Write the packet and commit it so the working tree stays clean.
		const packetPath = join(dir, "packet.json");
		writeFileSync(packetPath, JSON.stringify(opts.packet, null, 2));
		runGit(["add", "packet.json"]);
		runGit(["commit", "-q", "-m", "buildplane: add packet"]);

		// 4. Run the packet in the explicit unsafe lane. It does not spawn a
		//    ledger subprocess or populate events.db.
		exitCode = await runCli(["run", "--packet", packetPath, "--raw"], {
			cwd: dir,
			stdout: (_s: string) => {},
			stderr: (_s: string) => {},
		});
	} finally {
		process.chdir(originalCwd);
		// Restore BUILDPLANE_NATIVE_BIN to its original state.
		if (originalNativeBin === undefined) {
			delete process.env.BUILDPLANE_NATIVE_BIN;
		} else {
			process.env.BUILDPLANE_NATIVE_BIN = originalNativeBin;
		}
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
	}

	// Retained for deferred fork/VCR fixture migration; raw execution may leave
	// this conventional path absent.
	const eventsDbPath = join(dir, ".buildplane", "ledger", "events.db");

	const cleanup = async () => {
		await cleanupTempDir(dir);
	};

	return { dir, eventsDbPath, exitCode, cleanup };
}

export interface ForkFixtureInputs {
	parentPacket: unknown;
	forkPacket: unknown;
	forkArgs?: readonly string[];
	beforeFork?: (context: {
		dir: string;
		eventsDbPath: string;
		parentRunId: string;
		targetId: string;
	}) => Promise<void> | void;
	forkTargetKindHint?:
		| "unit_started"
		| "git_checkpoint"
		| "run_started"
		| "tool_request";
}

interface LegacyForkExecutionTapeFixture {
	dir: string;
	eventsDbPath: string;
	parentRunId: string;
	targetId: string;
	cleanup: () => Promise<void>;
}

interface LegacyCommandPacket {
	readonly unit?: {
		readonly id?: string;
		readonly kind?: string;
	};
	readonly execution?: {
		readonly command?: string;
		readonly args?: readonly string[];
		readonly cwd?: string;
	};
}

function legacyCommandPacket(packet: unknown): {
	readonly unitId: string;
	readonly unitKind: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
} {
	const candidate = packet as LegacyCommandPacket;
	const unitId = candidate.unit?.id;
	const command = candidate.execution?.command;
	if (!unitId || !command) {
		throw new Error(
			"legacy fork execution fixture requires a command packet with unit.id and execution.command",
		);
	}
	return {
		unitId,
		unitKind: candidate.unit?.kind ?? "command",
		command,
		args: candidate.execution?.args ?? [],
		cwd: candidate.execution?.cwd,
	};
}

/**
 * Produce the unsigned historical prefix required by the explicitly unsafe
 * fork/VCR compatibility lane. This is intentionally separate from
 * `run --raw`: raw execution must never manufacture a tape that could be
 * mistaken for governed evidence. The generic ledger endpoint is unsigned,
 * and the recorded command is represented only as legacy replay data.
 */
async function makeLegacyForkExecutionTapeFixture(
	parentPacket: unknown,
): Promise<LegacyForkExecutionTapeFixture> {
	const parentRunId = "01919000-0000-7000-8000-000000000001";
	const ledger = await makeLedgerFixture({ runId: parentRunId });
	const { dir, emitter } = ledger;
	const command = legacyCommandPacket(parentPacket);
	const runGit = (args: readonly string[]): string => {
		const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		if (result.status !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
		}
		return result.stdout;
	};

	try {
		runGit(["init", "-q"]);
		runGit(["config", "user.email", "test@test"]);
		runGit(["config", "user.name", "Buildplane Test"]);
		runGit(["commit", "-q", "--allow-empty", "-m", "init"]);

		const { runCli } = (await import("../../apps/cli/src/run-cli.js")) as {
			runCli: (
				argv: string[],
				options?: {
					cwd?: string;
					stdout?: (line: string) => void;
					stderr?: (line: string) => void;
				},
			) => Promise<number>;
		};
		const initExitCode = await runCli(["init"], {
			cwd: dir,
			stdout: () => {},
			stderr: () => {},
		});
		if (initExitCode !== 0) {
			throw new Error(
				"legacy fork execution fixture could not initialize project",
			);
		}
		runGit(["add", "-A"]);
		runGit(["commit", "-q", "-m", "buildplane: init"]);

		const baseSha = runGit(["rev-parse", "HEAD"]).trim();
		const runStartedEventId = newEventId();
		const targetId = newEventId();
		const checkpointEventId = newEventId();
		emitter.emit(
			"run_started",
			{
				RunStartedV1: {
					packet_hash: `sha256:${"a".repeat(64)}`,
					git_head: baseSha,
					workspace_path: dir,
					config: {},
					parent_run_id: null,
				},
			},
			{ id: runStartedEventId },
		);
		emitter.emit(
			"unit_started",
			{
				UnitStartedV1: {
					unit_id: command.unitId,
					parent_unit_id: null,
					unit_kind: command.unitKind,
					policy: {},
				},
			},
			{ id: targetId, parent: runStartedEventId },
		);
		emitter.emit(
			"git_checkpoint",
			{
				GitCheckpointV1: {
					boundary: "pre-unit",
					reference: `refs/buildplane/run/${parentRunId}`,
					commit_sha: baseSha,
					unit_id: command.unitId,
					git_status: { kind: "ok" },
				},
			},
			{ id: checkpointEventId, parent: targetId },
		);

		const commandResult = spawnSync(command.command, command.args, {
			cwd: command.cwd ? resolve(dir, command.cwd) : dir,
			encoding: "utf8",
		});
		if (commandResult.error) {
			throw commandResult.error;
		}
		const toolRequestId = newEventId();
		emitter.emit(
			"tool_request",
			{
				ToolRequestStoredV1: {
					tool_name: "run_command",
					arguments: {
						command: command.command,
						args: [...command.args],
					},
					env: {
						redacted: true,
						hash: "sha256:e3b0c44298fc1c149afbf4c8996fb924",
						hint: "env_var",
					},
					working_directory: command.cwd ?? "",
					unit_id: command.unitId,
				},
			},
			{ id: toolRequestId, parent: targetId },
		);
		emitter.emit(
			"tool_result",
			{
				ToolResultV1: {
					tool_request_id: toolRequestId,
					stdout: commandResult.stdout ?? "",
					stderr: commandResult.stderr ?? "",
					exit_code: commandResult.status ?? 1,
					output: null,
					duration_ms: 0,
				},
			},
			{ parent: toolRequestId },
		);
		await emitter.close();

		// The legacy tape and the deliberately unsafe parent side effects must be
		// committed so the real fork command's clean-worktree preflight can run.
		runGit(["add", "-A"]);
		runGit(["commit", "-q", "-m", "buildplane: legacy fork parent"]);

		return {
			dir,
			eventsDbPath: join(dir, ".buildplane", "ledger", "events.db"),
			parentRunId,
			targetId,
			cleanup: ledger.cleanup,
		};
	} catch (error) {
		await ledger.cleanup();
		throw error;
	}
}

export interface ForkFixtureResult {
	dir: string;
	eventsDbPath: string;
	parentRunId: string;
	forkRunId: string;
	/** Isolated detached worktree used by the unsafe fork attempt. */
	forkWorkspace: string;
	forkExitCode: number;
	forkStdout: string;
	forkStderr: string;
	cleanup: () => Promise<void>;
}

/** Run the parent packet, then fork at the first unit_started event
 * with the provided fork packet. Returns both run_ids and the events.db
 * path (both runs share the same file).
 */
export async function makeForkFixture(
	opts: ForkFixtureInputs,
): Promise<ForkFixtureResult> {
	const parent = await makeLegacyForkExecutionTapeFixture(opts.parentPacket);
	const { dir, eventsDbPath, parentRunId, targetId } = parent;
	if (opts.forkTargetKindHint && opts.forkTargetKindHint !== "unit_started") {
		await parent.cleanup();
		throw new Error(
			"legacy fork execution fixture only supports unit_started targets; use makeLegacyForkPreflightTapeFixture for invalid-target coverage",
		);
	}
	await opts.beforeFork?.({ dir, eventsDbPath, parentRunId, targetId });

	// The fork command requires a clean working tree. After makeBuildplaneRunFixture
	// runs the packet, the workspace has modified/untracked files (ledger db, artifacts).
	// Commit them so the pre-flight git status check passes.
	const runGitForFork = (args: string[]): string => {
		const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		if (r.status !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
		}
		return r.stdout;
	};
	if (runGitForFork(["status", "--porcelain"]).trim().length > 0) {
		runGitForFork(["add", "-A"]);
		runGitForFork(["commit", "-q", "-m", "buildplane: post-run state"]);
	}

	// Write fork packet.
	const { writeFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const forkPacketPath = join(dir, "fork-packet.json");
	writeFileSync(forkPacketPath, JSON.stringify(opts.forkPacket, null, 2));
	runGitForFork(["add", "fork-packet.json"]);
	runGitForFork(["commit", "-q", "-m", "buildplane: add fork packet"]);

	// Invoke runCli({ args: ["fork", parentRunId, "--at", targetId, ...] }).
	const { runCli } = (await import(
		"../../apps/cli/src/run-cli.js"
	)) as unknown as {
		runCli: (
			argv: string[],
			options: {
				cwd: string;
				stdout: (s: string) => void;
				stderr: (s: string) => void;
			},
		) => Promise<number>;
	};

	// Resolve the native binary before chdir so we can inject BUILDPLANE_NATIVE_BIN.
	// makeBuildplaneRunFixture restores the env var after its finally block, so we
	// must re-inject it here using the same fixture-root resolution helper.
	const nativeBinary = resolveNativeBinaryForLedgerTests();

	const originalCwd = process.cwd();
	const originalNativeBin = process.env.BUILDPLANE_NATIVE_BIN;
	let forkExitCode = 1;
	const forkStdout: string[] = [];
	const forkStderr: string[] = [];
	try {
		process.chdir(dir);
		process.env.BUILDPLANE_NATIVE_BIN = nativeBinary;
		forkExitCode = await runCli(
			[
				"fork",
				parentRunId,
				"--at",
				targetId,
				"--packet",
				forkPacketPath,
				"--workspace",
				dir,
				"--raw",
				...(opts.forkArgs ?? []),
			],
			{
				cwd: dir,
				stdout: (line) => forkStdout.push(line),
				stderr: (line) => forkStderr.push(line),
			},
		);
	} finally {
		process.chdir(originalCwd);
		if (originalNativeBin === undefined) {
			delete process.env.BUILDPLANE_NATIVE_BIN;
		} else {
			process.env.BUILDPLANE_NATIVE_BIN = originalNativeBin;
		}
	}

	// Read fork run_id — whichever run_id in events.db has parent_run_id == parentRunId.
	const { DatabaseSync } = await import("node:sqlite");
	const db2 = new DatabaseSync(eventsDbPath);
	const forkRow = db2
		.prepare(
			"SELECT run_id FROM events WHERE kind = 'run_started' " +
				"AND json_extract(payload, '$.RunStartedV1.parent_run_id') = ? LIMIT 1",
		)
		.get(parentRunId) as { run_id: string } | undefined;
	db2.close();

	const forkRunId = forkRow?.run_id ?? "";
	const combinedForkStdout = forkStdout.join("\n");
	const workspaceMatch =
		/(?:^|\n)fork workspace: (.+?) \(base [0-9a-f]{8}\)(?:\n|$)/.exec(
			combinedForkStdout,
		);
	const forkWorkspace = workspaceMatch?.[1] ?? "";

	return {
		dir,
		eventsDbPath,
		parentRunId,
		forkRunId,
		forkWorkspace,
		forkExitCode,
		forkStdout: combinedForkStdout,
		forkStderr: forkStderr.join("\n"),
		cleanup: parent.cleanup,
	};
}
