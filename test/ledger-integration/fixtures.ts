import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { createTapeEmitter, type TapeEmitter } from "@buildplane/ledger-client";

const LEDGER_FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));
export const LEDGER_TEST_REPO_ROOT = resolve(LEDGER_FIXTURES_DIR, "../..");

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
		await rm(dir, { recursive: true, force: true });
	};

	return { dir, binary, child, emitter, cleanup };
}

export interface BuildplaneRunFixture {
	dir: string;
	eventsDbPath: string;
	exitCode: number;
	cleanup: () => Promise<void>;
}

/** Spin up an isolated workspace, initialize a Buildplane project, write a
 * packet.json, and run `runCli()` in-process with process.cwd() temporarily
 * chdir'd to the tempdir. Restores cwd + BUILDPLANE_NATIVE_BIN in finally.
 * Returns the run result + path to events.db.
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
 * NOTE on --raw flag: the ledger subprocess integration lives in the "raw"
 * single-shot execution path of run-cli.  The default strategy path bypasses
 * it entirely.  This fixture always passes --raw so that the ledger subprocess
 * is spawned and events.db is populated.  Tests that need the strategy path
 * should call runCli directly instead of using this fixture.
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
	let exitCode = 1;
	try {
		process.chdir(dir);
		// Inject resolved binary path so run-cli can find it from the tempdir.
		process.env.BUILDPLANE_NATIVE_BIN = nativeBinary;

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

		// 4. Run the packet using --raw to engage the ledger-subprocess path.
		//    The default strategy path does not spawn a ledger subprocess, so
		//    events.db would be empty/missing without this flag.
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
	}

	const eventsDbPath = join(dir, ".buildplane", "ledger", "events.db");

	const cleanup = async () => {
		await rm(dir, { recursive: true, force: true });
	};

	return { dir, eventsDbPath, exitCode, cleanup };
}

export interface ForkFixtureInputs {
	parentPacket: unknown;
	forkPacket: unknown;
	forkTargetKindHint?:
		| "unit_started"
		| "git_checkpoint"
		| "run_started"
		| "tool_request";
}

export interface ForkFixtureResult {
	dir: string;
	eventsDbPath: string;
	parentRunId: string;
	forkRunId: string;
	forkExitCode: number;
	cleanup: () => Promise<void>;
}

/** Run the parent packet, then fork at the first unit_started event
 * with the provided fork packet. Returns both run_ids and the events.db
 * path (both runs share the same file).
 */
export async function makeForkFixture(
	opts: ForkFixtureInputs,
): Promise<ForkFixtureResult> {
	const parent = await makeBuildplaneRunFixture({ packet: opts.parentPacket });
	const dir = parent.dir;
	const eventsDbPath = parent.eventsDbPath;

	// Read parent run_id + target event_id from events.db.
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(eventsDbPath);
	const parentRunId = (
		db.prepare("SELECT DISTINCT run_id FROM events LIMIT 1").get() as {
			run_id: string;
		}
	).run_id;
	const targetKind = opts.forkTargetKindHint ?? "unit_started";
	const targetRow = db
		.prepare("SELECT id FROM events WHERE kind = ? ORDER BY id ASC LIMIT 1")
		.get(targetKind) as { id: string } | undefined;
	db.close();
	if (!targetRow) {
		throw new Error(`fixture: no ${targetKind} event found in parent tape`);
	}
	const targetId = targetRow.id;

	// The fork command requires a clean working tree. After makeBuildplaneRunFixture
	// runs the packet, the workspace has modified/untracked files (ledger db, artifacts).
	// Commit them so the pre-flight git status check passes.
	const runGitForFork = (args: string[]) => {
		const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		if (r.status !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
		}
	};
	runGitForFork(["add", "-A"]);
	runGitForFork(["commit", "-q", "-m", "buildplane: post-run state"]);

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
			],
			{
				cwd: dir,
				stdout: () => {},
				stderr: () => {},
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
	const db2 = new DatabaseSync(eventsDbPath);
	const forkRow = db2
		.prepare(
			"SELECT run_id FROM events WHERE kind = 'run_started' " +
				"AND json_extract(payload, '$.RunStartedV1.parent_run_id') = ? LIMIT 1",
		)
		.get(parentRunId) as { run_id: string } | undefined;
	db2.close();

	const forkRunId = forkRow?.run_id ?? "";

	return {
		dir,
		eventsDbPath,
		parentRunId,
		forkRunId,
		forkExitCode,
		cleanup: parent.cleanup,
	};
}
