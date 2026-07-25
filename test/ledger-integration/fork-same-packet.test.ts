import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function runForkCli(
	args: string[],
	cwd: string,
): Promise<{ exitCode: number; stderr: string }> {
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
	let stderrCaptured = "";
	const originalCwd = process.cwd();
	let exitCode = 1;
	try {
		process.chdir(cwd);
		exitCode = await runCli(args, {
			cwd,
			stdout: () => {},
			stderr: (s) => {
				stderrCaptured += s;
			},
		});
	} finally {
		process.chdir(originalCwd);
	}
	return { exitCode, stderr: stderrCaptured };
}

describe("fork without --packet", () => {
	it("fails before opening a legacy tape", async () => {
		const root = mkdtempSync(join(tmpdir(), "bp-fork-no-packet-"));
		try {
			// No --packet flag.
			const result = await runForkCli(
				[
					"fork",
					"01919000-0000-7000-8000-000000000000",
					"--at",
					"01919000-0000-7000-8000-000000000001",
					"--workspace",
					root,
					"--raw",
				],
				root,
			);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toMatch(/packet/i);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);
});
