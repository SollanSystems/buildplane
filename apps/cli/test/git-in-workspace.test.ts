import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitInWorkspace, tryGitInWorkspace } from "../src/git-in-workspace.js";

function git(cwd: string, ...args: string[]): string {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(r.stderr);
	return r.stdout.trim();
}

describe("gitInWorkspace", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bp-giw-"));
		git(dir, "init", "-q");
		git(dir, "config", "user.email", "test@test");
		git(dir, "config", "user.name", "test");
		writeFileSync(join(dir, "init.txt"), "init");
		git(dir, "add", ".");
		git(dir, "commit", "-q", "-m", "init");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("executes git in the passed workspace regardless of process.cwd()", () => {
		const originalCwd = process.cwd();
		try {
			process.chdir(tmpdir());
			const sha = gitInWorkspace(dir, ["rev-parse", "HEAD"]).trim();
			expect(sha).toMatch(/^[0-9a-f]{40}$/);
		} finally {
			process.chdir(originalCwd);
		}
	});

	it("throws on non-zero exit with stderr included", () => {
		expect(() => gitInWorkspace(dir, ["nonsensical-subcommand"])).toThrow(
			/git/i,
		);
	});

	it("rejects non-absolute workspace paths", () => {
		expect(() =>
			gitInWorkspace("relative/path", ["rev-parse", "HEAD"]),
		).toThrow(/absolute/i);
	});

	it("resolves path literally — does not resolve symlinks or ..", () => {
		const workspaceAbs = resolve(dir);
		const sha = gitInWorkspace(workspaceAbs, ["rev-parse", "HEAD"]).trim();
		expect(sha).toMatch(/^[0-9a-f]{40}$/);
	});

	it("tryGitInWorkspace returns null for a missing ref", () => {
		const result = tryGitInWorkspace(dir, [
			"show-ref",
			"--hash",
			"refs/buildplane/run/nonexistent",
		]);
		expect(result).toBeNull();
	});

	it("tryGitInWorkspace returns output on success", () => {
		const sha = tryGitInWorkspace(dir, ["rev-parse", "HEAD"]);
		expect(sha?.trim()).toMatch(/^[0-9a-f]{40}$/);
	});

	it("tryGitInWorkspace rejects non-absolute workspace paths", () => {
		expect(() =>
			tryGitInWorkspace("relative/path", ["rev-parse", "HEAD"]),
		).toThrow(/absolute/i);
	});
});
