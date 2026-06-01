import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitWorktreeAdapter } from "../src/index.js";

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, {
		cwd,
		stdio: ["ignore", "ignore", "ignore"],
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		},
	});
}

describe("checkWorktreeClean", () => {
	it("returns true for a clean worktree and false for a dirty one", () => {
		const repo = mkdtempSync(join(tmpdir(), "bp-ckwt-"));
		git(repo, "init");
		writeFileSync(join(repo, "f.txt"), "hi");
		git(repo, "add", "f.txt");
		git(repo, "commit", "-m", "init");

		const adapter = createGitWorktreeAdapter();
		const { headSha } = adapter.assertRunnableRepository(repo);
		const ws = adapter.prepareWorkspace(repo, "run-1", headSha);

		expect(adapter.checkWorktreeClean(ws.path)).toBe(true);

		writeFileSync(join(ws.path, "dirty.txt"), "x");
		expect(adapter.checkWorktreeClean(ws.path)).toBe(false);
	});

	it("returns false (fail-closed) for a non-repository path", () => {
		const notRepo = mkdtempSync(join(tmpdir(), "bp-norepo-"));
		const adapter = createGitWorktreeAdapter();
		expect(adapter.checkWorktreeClean(notRepo)).toBe(false);
	});
});
