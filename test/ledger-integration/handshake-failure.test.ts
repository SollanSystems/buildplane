import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
	createTapeEmitter,
	LedgerHandshakeError,
} from "@buildplane/ledger-client";
import { describe, expect, it } from "vitest";

const NATIVE_BIN =
	process.env.BUILDPLANE_NATIVE_BIN ??
	join(process.cwd(), "native", "target", "debug", "buildplane-native");

describe("handshake failure", () => {
	it("rejects when schema version is unsupported", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bp-ledger-hs-"));
		const child = spawn(
			NATIVE_BIN,
			[
				"ledger",
				"serve",
				"--run-id",
				"01919000-0000-7000-8000-000000000000",
				"--workspace",
				dir,
				"--schema-version",
				"1",
			],
			{ stdio: ["pipe", "inherit", "pipe"], cwd: dir },
		);
		const exit = new Promise<number>((r) =>
			child.on("exit", (c) => r(c ?? -1)),
		);

		try {
			await expect(
				createTapeEmitter({
					childStdin: child.stdin as Writable,
					childStderr: child.stderr as Readable,
					childExit: exit,
					workspacePath: dir,
					runId: "01919000-0000-7000-8000-000000000000",
					schemaVersion: 99, // wrong
					handshakeTimeoutMs: 5_000,
				}),
			).rejects.toBeInstanceOf(LedgerHandshakeError);
		} finally {
			if (child.exitCode === null) child.kill("SIGTERM");
			await exit.catch(() => {});
			await rm(dir, { recursive: true, force: true });
		}
	}, 15_000);

	it("rejects when ledger binary does not exist", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bp-ledger-nobin-"));
		try {
			const child = spawn("/nonexistent/buildplane-native", [
				"ledger",
				"serve",
				"--run-id",
				"01919000-0000-7000-8000-000000000000",
				"--workspace",
				dir,
			]);
			const exit = new Promise<number>((r) =>
				child.on("exit", (c) => r(c ?? -1)),
			);
			child.on("error", () => {});
			await expect(
				createTapeEmitter({
					childStdin: child.stdin as Writable,
					childStderr: child.stderr as Readable,
					childExit: exit,
					workspacePath: dir,
					runId: "01919000-0000-7000-8000-000000000000",
					handshakeTimeoutMs: 1_000,
				}),
			).rejects.toBeDefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 15_000);
});
