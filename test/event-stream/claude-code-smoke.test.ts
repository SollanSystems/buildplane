import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { runCli } from "../../apps/cli/src/run-cli";
import { resolveNativeBinaryForLedgerTests } from "../ledger-integration/fixtures.js";

// ── Helpers ─────────────────────────────────────────────────

const cleanupPaths: string[] = [];

function git(cwd: string, args: string[]): void {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_")) delete env[key];
	}
	execFileSync("git", args, { cwd, env });
}

async function runCliCapture(cwd: string, argv: string[]) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const exitCode = await runCli(argv, {
		cwd,
		stdout: (line) => stdout.push(line),
		stderr: (line) => stderr.push(line),
	});
	return { exitCode, stdout, stderr };
}

afterAll(() => {
	for (const path of cleanupPaths.splice(0)) {
		rmSync(path, { force: true, recursive: true });
	}
});

// ── Stub claude binary ──────────────────────────────────────

/**
 * Creates a shell script that mimics `claude -p` in print mode:
 * - Creates an output.txt marker file in the current working directory
 * - Prints valid Claude JSON to stdout
 *
 * The executor spawns the binary with cwd set to the workspace worktree path,
 * so $PWD inside the stub is the workspace — no --cwd arg needed.
 *
 * Returns the directory containing the stub (to prepend to PATH).
 */
function createStubClaude(
	stdoutText = '{"result":"Task completed.","cost_usd":0.01,"duration_ms":1000,"num_turns":1}',
): string {
	const binDir = mkdtempSync(join(tmpdir(), "bp-stub-claude-"));
	cleanupPaths.push(binDir);

	const stubPath = join(binDir, "claude");
	writeFileSync(
		stubPath,
		`#!/bin/sh
# Stub claude binary for Buildplane smoke tests.
# The executor sets cwd to the workspace worktree, so $PWD is the workspace.

# Create the expected output file in the workspace
echo "stub-marker" > "$PWD/output.txt"

# Emit configurable stdout to simulate Claude CLI behavior
printf '%s\n' ${JSON.stringify(stdoutText)}
`,
	);
	chmodSync(stubPath, 0o755);
	return binDir;
}

// ── Tests ───────────────────────────────────────────────────

describe("claude-code e2e smoke test", () => {
	it("model packet with preferredWorker=claude-code runs through the stub binary", async () => {
		// Set up a temp workspace with a git repo
		const root = mkdtempSync(join(tmpdir(), "bp-claude-smoke-"));
		cleanupPaths.push(root);

		git(root, ["init"]);
		git(root, ["config", "user.name", "Test"]);
		git(root, ["config", "user.email", "t@t.co"]);
		// Gitignore buildplane state, and output.txt which the stub creates
		writeFileSync(join(root, ".gitignore"), ".buildplane/\noutput.txt\n");
		writeFileSync(join(root, "seed.txt"), "x");
		git(root, ["add", "."]);
		git(root, ["commit", "-m", "init"]);

		// Create stub claude binary in a separate temp dir (outside the git repo)
		const stubBinDir = createStubClaude();
		const origPath = process.env.PATH;
		const originalNativeBin = process.env.BUILDPLANE_NATIVE_BIN;
		process.env.PATH = `${stubBinDir}:${origPath}`;
		process.env.BUILDPLANE_NATIVE_BIN = resolveNativeBinaryForLedgerTests();

		// M2-S5: `buildplane run --raw` now signs the tape with the kernel key (D2),
		// so provision a temp-HOME kernel ed25519 seed (value irrelevant — only that
		// it resolves); otherwise the signed ledger init is skipped and events.db is
		// never created.
		const originalHome = process.env.HOME;
		const home = mkdtempSync(join(tmpdir(), "bp-claude-smoke-home-"));
		cleanupPaths.push(home);
		process.env.HOME = home;
		const keyDir = join(home, ".buildplane", "keys", "kernel");
		mkdirSync(keyDir, { recursive: true });
		writeFileSync(join(keyDir, "kernel-main.ed25519"), Buffer.alloc(32, 7));

		try {
			// Write the model packet with routingHints
			const packetPath = join(root, "packet.json");
			writeFileSync(
				packetPath,
				JSON.stringify({
					unit: {
						id: "unit-claude-smoke",
						kind: "model",
						scope: "task",
						inputRefs: [],
						expectedOutputs: ["output.txt"],
						verificationContract: "exit-0-and-required-outputs",
						policyProfile: "default",
					},
					model: {
						provider: "anthropic",
						model: "claude-sonnet-4-20250514",
						prompt: "Create output.txt with a marker.",
					},
					routingHints: {
						preferredWorker: "claude-code",
					},
					verification: {
						requiredOutputs: ["output.txt"],
					},
				}),
			);

			git(root, ["add", "packet.json"]);
			git(root, ["commit", "-m", "add packet"]);

			// Initialize the project
			const init = await runCliCapture(root, ["init"]);
			expect(init.exitCode).toBe(0);

			// Run the packet
			const run = await runCliCapture(root, [
				"run",
				"--packet",
				packetPath,
				"--raw",
			]);

			// The run should have completed successfully
			// (exit 0 means the stub binary ran, created output.txt in the
			// worktree, and the policy evaluator verified the required output)
			expect(run.exitCode).toBe(0);

			// Extract run ID
			const runId =
				run.stdout.find((line) => line.startsWith("run-id: "))?.slice(8) ?? "";
			expect(runId).not.toBe("");

			// Verify status shows the run passed
			const status = await runCliCapture(root, ["status", "--json"]);
			expect(status.exitCode).toBe(0);
			const statusPayload = JSON.parse(status.stdout.join("\n"));
			expect(statusPayload).toMatchObject({
				initialized: true,
				latestRun: { id: runId, status: "passed" },
			});

			const ledgerDbPath = join(root, ".buildplane", "ledger", "events.db");
			const db = new DatabaseSync(ledgerDbPath);
			const tapeRunIds = (
				db
					.prepare("SELECT DISTINCT run_id FROM events ORDER BY run_id ASC")
					.all() as {
					run_id: string;
				}[]
			).map((row) => row.run_id);
			expect(tapeRunIds).toEqual([runId]);

			const rows = db
				.prepare(
					"SELECT kind, payload FROM events WHERE run_id = ? ORDER BY id ASC",
				)
				.all(runId) as { kind: string; payload: string }[];
			const kinds = rows.map((row) => row.kind);
			expect(kinds).toContain("unit_started");
			expect(kinds).toContain("unit_completed");
			expect(kinds).toContain("git_checkpoint");
			const checkpointBoundaries = rows
				.filter((row) => row.kind === "git_checkpoint")
				.map(
					(row) =>
						(
							JSON.parse(row.payload) as {
								GitCheckpointV1: { boundary: string };
							}
						).GitCheckpointV1.boundary,
				);
			expect(checkpointBoundaries).toContain("pre-unit");
			expect(checkpointBoundaries).toContain("post-unit");
			db.close();
		} finally {
			process.env.PATH = origPath;
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
	});
});
