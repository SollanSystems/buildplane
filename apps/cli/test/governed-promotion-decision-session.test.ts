import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/run-cli.js";

function git(root: string, args: readonly string[]): string {
	return execFileSync("git", args, {
		cwd: root,
		encoding: "utf8",
		env: Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
		),
	});
}

function createGitProject(): string {
	const root = mkdtempSync(join(tmpdir(), "buildplane-promotion-decision-"));
	git(root, ["init"]);
	git(root, ["config", "user.name", "Buildplane Tests"]);
	git(root, ["config", "user.email", "tests@example.com"]);
	writeFileSync(join(root, "tracked.txt"), "baseline\n");
	git(root, ["add", "tracked.txt"]);
	git(root, ["commit", "-m", "baseline"]);
	const stateDirectory = join(root, ".buildplane");
	mkdirSync(stateDirectory, { recursive: true });
	writeFileSync(join(stateDirectory, "project.json"), "{}\n");
	writeFileSync(join(stateDirectory, "state.db"), "");
	return root;
}

function snapshotRoot(root: string): Record<string, string> {
	return {
		head: git(root, ["rev-parse", "HEAD"]).trim(),
		tree: git(root, ["rev-parse", "HEAD^{tree}"]).trim(),
		commitCount: git(root, ["rev-list", "--count", "HEAD"]).trim(),
		status: git(root, ["status", "--porcelain", "--untracked-files=all"]),
	};
}

describe("governed promotion-decision recovery session", () => {
	it("keeps a rejected recovery decision blocked without returning target, candidate, signer, worker, command, or callable authority", async () => {
		const root = createGitProject();
		const before = snapshotRoot(root);
		const stdout: string[] = [];
		const stderr: string[] = [];

		const exitCode = await runCli(
			[
				"run",
				"--resume",
				"host-recovery/reject-only",
				"--approve",
				"--decision",
				"reject",
				"--json",
			],
			{
				cwd: root,
				stdout: (line) => stdout.push(line),
				stderr: (line) => stderr.push(line),
				dependencies: {
					createOrchestrator: () => {
						throw new Error("legacy orchestrator must not be constructed");
					},
				},
			},
		);

		expect(exitCode).toBe(2);
		expect(stderr).toEqual([]);
		const payload = JSON.parse(stdout.join("\n")) as Record<string, unknown>;
		expect(payload).toEqual({
			governance: "governed",
			status: "recovery-required",
			executionStarted: "unknown",
			decision: { requested: "reject", state: "blocked" },
			promotion: { state: "not-executed" },
			recovery: { action: "contact-host", retry: "blocked" },
		});
		expect(Object.keys(payload).sort()).toEqual([
			"decision",
			"executionStarted",
			"governance",
			"promotion",
			"recovery",
			"status",
		]);
		for (const forbiddenField of [
			"candidate",
			"command",
			"git",
			"run",
			"signer",
			"targetRef",
			"worker",
		]) {
			expect(payload).not.toHaveProperty(forbiddenField);
		}
		expect(snapshotRoot(root)).toEqual(before);
	});
});
