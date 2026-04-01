import {
	type SpawnSyncOptions,
	type SpawnSyncReturns,
	spawnSync,
} from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitWorktreeAdapter } from "../src";

const tempRoots: string[] = [];

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			rmSync(root, { recursive: true, force: true });
		}
	}
	vi.unstubAllEnvs();
});

describe("git worktree adapter", () => {
	it("pins HEAD, creates a deterministic worktree, and deletes it", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();

		const { headSha } = adapter.assertRunnableRepository(repo);
		const workspace = adapter.prepareWorkspace(repo, "run-1", headSha);

		expect(workspace).toEqual({
			path: join(repo, ".buildplane", "workspaces", "run-1"),
			headSha,
		});
		expect(readGitHead(workspace.path)).toBe(headSha);
		expect(existsSync(workspace.path)).toBe(true);

		const deleted = adapter.deleteWorkspace(workspace);

		expect(deleted).toEqual({ deleted: true });
		expect(existsSync(workspace.path)).toBe(false);
	});

	it("creates from the supplied pinned headSha even after source HEAD moves", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();
		const { headSha } = adapter.assertRunnableRepository(repo);

		writeFileSync(join(repo, "future.txt"), "future\n");
		runGitOrThrow(repo, ["add", "future.txt"]);
		runGitOrThrow(repo, ["commit", "-m", "future"]);
		const movedHeadSha = readGitHead(repo);

		const workspace = adapter.prepareWorkspace(repo, "run-2", headSha);

		expect(movedHeadSha).not.toBe(headSha);
		expect(readGitHead(workspace.path)).toBe(headSha);
		expect(existsSync(join(workspace.path, "future.txt"))).toBe(false);
	});

	it("fails clearly when the git binary is unavailable", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter({
			gitBinary: "git-definitely-missing-buildplane",
		});

		expect(() => adapter.assertRunnableRepository(repo)).toThrow(
			/git .* unavailable/i,
		);
	});

	it("fails clearly when the project root is not a git repository", () => {
		const root = createTempRoot("buildplane-not-git-");
		const adapter = createGitWorktreeAdapter();

		expect(() => adapter.assertRunnableRepository(root)).toThrow(
			/not a git repository/i,
		);
	});

	it("ignores inherited git environment when targeting a repository", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();

		vi.stubEnv("GIT_DIR", "/definitely/not/the/repo/.git");
		vi.stubEnv("GIT_WORK_TREE", "/definitely/not/the/repo");
		vi.stubEnv("GIT_INDEX_FILE", "/definitely/not/the/repo/index");

		expect(adapter.assertRunnableRepository(repo)).toEqual({
			headSha: readGitHead(repo),
		});
	});

	it("rejects dirty repositories while ignoring persisted buildplane state", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();

		mkdirSync(join(repo, ".buildplane", "logs"), { recursive: true });
		writeFileSync(join(repo, ".buildplane", "state.db"), "sqlite\n");
		writeFileSync(
			join(repo, ".buildplane", "project.json"),
			'{"schemaVersion":1}\n',
		);
		writeFileSync(
			join(repo, ".buildplane", "logs", "run-1.stdout.log"),
			"ignored\n",
		);

		expect(adapter.assertRunnableRepository(repo)).toEqual({
			headSha: readGitHead(repo),
		});

		writeFileSync(join(repo, "dirty.txt"), "dirty\n");

		expect(() => adapter.assertRunnableRepository(repo)).toThrow(
			/working tree is not clean/i,
		);
	});

	it("does not let retained leftovers under .buildplane/workspaces poison cleanliness checks", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();

		mkdirSync(join(repo, ".buildplane", "workspaces", "run-retained"), {
			recursive: true,
		});
		writeFileSync(
			join(repo, ".buildplane", "workspaces", "run-retained", "log.txt"),
			"left behind\n",
		);

		expect(adapter.assertRunnableRepository(repo)).toEqual({
			headSha: readGitHead(repo),
		});
	});

	it("rejects dirty packet inputs stored under .buildplane", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();

		mkdirSync(join(repo, ".buildplane", "packets"), { recursive: true });
		writeFileSync(
			join(repo, ".buildplane", "packets", "packet.json"),
			'{"name":"baseline"}\n',
		);
		runGitOrThrow(repo, ["add", ".buildplane/packets/packet.json"]);
		runGitOrThrow(repo, ["commit", "-m", "add packet fixture"]);
		writeFileSync(
			join(repo, ".buildplane", "packets", "packet.json"),
			'{"name":"dirty"}\n',
		);

		expect(() => adapter.assertRunnableRepository(repo)).toThrow(
			/working tree is not clean/i,
		);
	});

	it("checks cleanliness from the repository root even when invoked from a subdirectory", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();
		const nestedRoot = join(repo, "packages", "cli");
		mkdirSync(nestedRoot, { recursive: true });
		writeFileSync(join(repo, "root-dirty.txt"), "dirty\n");

		expect(() => adapter.assertRunnableRepository(nestedRoot)).toThrow(
			/working tree is not clean/i,
		);
	});

	it("rejects unresolved HEAD in an empty repository", () => {
		const repo = createEmptyRepo();
		const adapter = createGitWorktreeAdapter();

		expect(() => adapter.assertRunnableRepository(repo)).toThrow(
			/unresolved HEAD|HEAD/i,
		);
	});

	it("surfaces worktree creation failures cleanly", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter({
			runGit: createSeam((args, options) => {
				if (args[0] === "worktree" && args[1] === "add") {
					return failureResult(
						options,
						"fatal: synthetic worktree add failure",
					);
				}
				return spawnSync("git", args, options);
			}),
		});
		const { headSha } = adapter.assertRunnableRepository(repo);

		expect(() => adapter.prepareWorkspace(repo, "run-3", headSha)).toThrow(
			/worktree add failed|synthetic worktree add failure/i,
		);
	});

	it("surfaces delete failures cleanly", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter({
			runGit: createSeam((args, options) => {
				if (args[0] === "worktree" && args[1] === "remove") {
					return failureResult(
						options,
						"fatal: synthetic worktree remove failure",
					);
				}
				return spawnSync("git", args, options);
			}),
		});
		const { headSha } = adapter.assertRunnableRepository(repo);
		const workspace = adapter.prepareWorkspace(repo, "run-4", headSha);

		expect(adapter.deleteWorkspace(workspace)).toEqual({
			deleted: false,
			cleanupError: expect.stringMatching(
				/worktree remove failed|synthetic worktree remove failure/i,
			),
		});
		expect(existsSync(workspace.path)).toBe(true);
	});
});

function createCommittedRepo(): string {
	const root = createEmptyRepo();
	writeFileSync(join(root, "tracked.txt"), "initial\n");
	runGitOrThrow(root, ["add", "tracked.txt"]);
	runGitOrThrow(root, ["commit", "-m", "initial"]);
	return root;
}

function createEmptyRepo(): string {
	const root = createTempRoot("buildplane-git-adapter-");
	runGitOrThrow(root, ["init"]);
	runGitOrThrow(root, ["config", "user.name", "Buildplane Test"]);
	runGitOrThrow(root, ["config", "user.email", "test@example.com"]);
	return root;
}

function createTempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

function readGitHead(cwd: string): string {
	const result = runGit(cwd, ["rev-parse", "HEAD"]);
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim());
	}
	return result.stdout.trim();
}

function runGitOrThrow(cwd: string, args: string[]): void {
	const result = runGit(cwd, args);
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim());
	}
}

function runGit(cwd: string, args: string[]) {
	return spawnSync("git", args, {
		cwd,
		env: isolatedGitEnv(),
		encoding: "utf8",
	});
}

function isolatedGitEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_")) {
			delete env[key];
		}
	}
	return env;
}

function createSeam(
	implementation: (
		args: string[],
		options: SpawnSyncOptions,
	) => SpawnSyncReturns<string>,
) {
	return (
		args: string[],
		options: SpawnSyncOptions,
	): SpawnSyncReturns<string> =>
		implementation(args, {
			...options,
			env: {
				...isolatedGitEnv(),
				...options.env,
			},
		});
}

function failureResult(
	options: SpawnSyncOptions,
	stderr: string,
): SpawnSyncReturns<string> {
	const encoding = options.encoding === "buffer" ? undefined : "utf8";
	return {
		status: 1,
		signal: null,
		output: ["", "", stderr],
		pid: 0,
		stdout: encoding ? "" : Buffer.alloc(0),
		stderr: encoding ? stderr : Buffer.from(stderr),
		error: undefined,
	} as SpawnSyncReturns<string>;
}
