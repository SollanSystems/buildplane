import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCli } from "../../apps/cli/src/run-cli";

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
 * - Parses --cwd from arguments
 * - Creates an output.txt marker file in the workspace
 * - Prints valid Claude JSON to stdout
 *
 * Returns the directory containing the stub (to prepend to PATH).
 */
function createStubClaude(): string {
	const binDir = mkdtempSync(join(tmpdir(), "bp-stub-claude-"));
	cleanupPaths.push(binDir);

	const stubPath = join(binDir, "claude");
	writeFileSync(
		stubPath,
		`#!/bin/sh
# Stub claude binary for Buildplane smoke tests.
# Parse --cwd from arguments.
CWD=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cwd) shift; CWD="$1" ;;
  esac
  shift
done

# Create the expected output file in the workspace
if [ -n "$CWD" ]; then
  mkdir -p "$CWD"
  echo "stub-marker" > "$CWD/output.txt"
fi

# Emit valid Claude JSON to stdout
echo '{"result":"Task completed.","cost_usd":0.01,"duration_ms":1000,"num_turns":1}'
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
		process.env.PATH = `${stubBinDir}:${origPath}`;

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
			const run = await runCliCapture(root, ["run", "--packet", packetPath]);

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
		} finally {
			process.env.PATH = origPath;
		}
	});
});
