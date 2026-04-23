import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGitCheckpoint } from "../src/ledger-git-checkpoint.js";

function git(cwd: string, ...args: string[]): string {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	}
	return r.stdout.trim();
}

describe("runGitCheckpoint", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bp-checkpoint-"));
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

	it("pre-unit creates a commit on refs/buildplane/run/<runId> without touching HEAD", () => {
		const emitter = { emit: vi.fn() };
		const headBefore = git(dir, "rev-parse", "HEAD");
		const runId = "01919000-0000-7000-8000-000000000000";

		runGitCheckpoint({
			boundary: "pre-unit",
			runId,
			unitId: "u-1",
			cwd: dir,
			emitter,
			parentEventId: "01919000-0000-7000-8000-000000000010",
		});

		const headAfter = git(dir, "rev-parse", "HEAD");
		expect(headAfter).toBe(headBefore);

		const refSha = git(
			dir,
			"show-ref",
			"--hash",
			`refs/buildplane/run/${runId}`,
		);
		expect(refSha).toMatch(/^[0-9a-f]{40}$/);

		expect(emitter.emit).toHaveBeenCalledOnce();
		const [kind, payload, opts] = emitter.emit.mock.calls[0];
		expect(kind).toBe("git_checkpoint");
		const p = payload as {
			GitCheckpointV1: {
				boundary: string;
				reference: string;
				commit_sha: string;
				unit_id: string;
				git_status: { kind: string };
			};
		};
		expect(p.GitCheckpointV1.boundary).toBe("pre-unit");
		expect(p.GitCheckpointV1.reference).toBe(`refs/buildplane/run/${runId}`);
		expect(p.GitCheckpointV1.commit_sha).toBe(refSha);
		expect(p.GitCheckpointV1.unit_id).toBe("u-1");
		expect(p.GitCheckpointV1.git_status.kind).toBe("ok");
		expect((opts as { parent: string }).parent).toBe(
			"01919000-0000-7000-8000-000000000010",
		);
	});

	it("post-unit chains on the prior pre-unit commit", () => {
		const emitter = { emit: vi.fn() };
		const runId = "01919000-0000-7000-8000-000000000001";

		runGitCheckpoint({
			boundary: "pre-unit",
			runId,
			unitId: "u-1",
			cwd: dir,
			emitter,
			parentEventId: undefined,
		});
		const preSha = git(
			dir,
			"show-ref",
			"--hash",
			`refs/buildplane/run/${runId}`,
		);

		runGitCheckpoint({
			boundary: "post-unit",
			runId,
			unitId: "u-1",
			cwd: dir,
			emitter,
			parentEventId: undefined,
		});
		const postSha = git(
			dir,
			"show-ref",
			"--hash",
			`refs/buildplane/run/${runId}`,
		);

		expect(postSha).not.toBe(preSha);
		const parent = git(dir, "rev-parse", `${postSha}^`);
		expect(parent).toBe(preSha);
	});

	it("captures dirty worktree via write-tree without touching HEAD", () => {
		const emitter = { emit: vi.fn() };
		const runId = "01919000-0000-7000-8000-000000000002";

		writeFileSync(join(dir, "dirty.txt"), "uncommitted");
		git(dir, "add", "dirty.txt");
		const headBefore = git(dir, "rev-parse", "HEAD");

		runGitCheckpoint({
			boundary: "pre-unit",
			runId,
			unitId: "u-1",
			cwd: dir,
			emitter,
			parentEventId: undefined,
		});

		const headAfter = git(dir, "rev-parse", "HEAD");
		expect(headAfter).toBe(headBefore);

		const refSha = git(
			dir,
			"show-ref",
			"--hash",
			`refs/buildplane/run/${runId}`,
		);
		const treeListing = git(dir, "ls-tree", "-r", "--name-only", refSha);
		expect(treeListing.split("\n")).toContain("dirty.txt");
	});

	it("does not modify the user's current branch", () => {
		const emitter = { emit: vi.fn() };
		const runId = "01919000-0000-7000-8000-000000000003";

		const branchBefore = git(dir, "rev-parse", "--abbrev-ref", "HEAD");
		const headBefore = git(dir, "rev-parse", "HEAD");

		runGitCheckpoint({
			boundary: "pre-unit",
			runId,
			unitId: "u-1",
			cwd: dir,
			emitter,
			parentEventId: undefined,
		});

		const branchAfter = git(dir, "rev-parse", "--abbrev-ref", "HEAD");
		const headAfter = git(dir, "rev-parse", "HEAD");
		expect(branchAfter).toBe(branchBefore);
		expect(headAfter).toBe(headBefore);
	});
});
