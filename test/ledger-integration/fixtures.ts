import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
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
