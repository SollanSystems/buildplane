import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import { createTapeEmitter, type TapeEmitter } from "@buildplane/ledger-client";

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

	// Locate the native binary. Honor BUILDPLANE_NATIVE_BIN; otherwise fall
	// back to the debug build relative to the repo root (process.cwd() here
	// is the vitest invocation cwd, which is the repo root for `pnpm test`).
	const binary =
		process.env.BUILDPLANE_NATIVE_BIN ??
		join(process.cwd(), "native", "target", "debug", "buildplane-native");

	// NOTE: cwd must NOT be a bare temp dir. The native binary resolves its
	// "native workspace" by walking ancestors of cwd looking for Cargo.toml +
	// packs/. Use the repo root (process.cwd() during `pnpm test`) so the
	// binary starts successfully; the --workspace flag points to the isolated
	// temp dir that holds the SQLite ledger.
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
		{ stdio: ["pipe", "inherit", "pipe"] },
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
 * Binary resolution (same strategy as makeLedgerFixture):
 *  1. Honor BUILDPLANE_NATIVE_BIN if already set in the environment.
 *  2. Look for native/target/debug/buildplane-native relative to the vitest
 *     invocation cwd (the repo root when running `pnpm test`).
 *  3. Fall back to "buildplane-native" on PATH.
 * The resolved binary is injected as BUILDPLANE_NATIVE_BIN so the run-cli
 * subprocess-spawn path can locate it even when cwd is the tempdir.
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

	// Capture repo-root cwd BEFORE chdir so binary resolution uses the right base.
	const repoRoot = process.cwd();

	// Resolve the native binary using the same logic as makeLedgerFixture.
	const nativeBinary =
		process.env.BUILDPLANE_NATIVE_BIN ??
		(existsSync(
			join(repoRoot, "native", "target", "debug", "buildplane-native"),
		)
			? join(repoRoot, "native", "target", "debug", "buildplane-native")
			: existsSync(
						join(repoRoot, "native", "target", "release", "buildplane-native"),
					)
				? join(repoRoot, "native", "target", "release", "buildplane-native")
				: "buildplane-native");

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
