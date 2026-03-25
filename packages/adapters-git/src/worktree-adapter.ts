import {
	type SpawnSyncOptions,
	type SpawnSyncReturns,
	spawnSync,
} from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { BuildplaneWorkspacePort } from "@buildplane/kernel";

export interface CreateGitWorkspaceAdapterOptions {
	readonly gitBinary?: string;
	readonly runGit?: GitCommandRunner;
}

export type GitCommandRunner = (
	args: string[],
	options: SpawnSyncOptions,
) => SpawnSyncReturns<string>;

export function createGitWorkspaceAdapter(
	options: CreateGitWorkspaceAdapterOptions = {},
): BuildplaneWorkspacePort {
	const gitBinary = options.gitBinary ?? "git";
	const runGit: GitCommandRunner =
		options.runGit ??
		((args, spawnOptions) =>
			spawnSync(gitBinary, args, {
				env: createIsolatedGitEnv(spawnOptions.env),
				encoding: "utf8",
				...spawnOptions,
			}) as SpawnSyncReturns<string>);

	const adapter: BuildplaneWorkspacePort = {
		assertRunnableRepository(projectRoot: string) {
			const repositoryCheck = executeGitCommand(runGit, projectRoot, [
				"rev-parse",
				"--show-toplevel",
			]);
			if (repositoryCheck.status !== 0) {
				throw createRepositoryError(projectRoot, repositoryCheck);
			}
			const repositoryRoot = realpathSync(repositoryCheck.stdout.trim());
			const canonicalProjectRoot = realpathSync(projectRoot);
			const buildplanePrefix = toGitPath(
				relative(repositoryRoot, join(canonicalProjectRoot, ".buildplane")),
			);

			const headResolution = executeGitCommand(runGit, repositoryRoot, [
				"rev-parse",
				"HEAD",
			]);
			if (headResolution.status !== 0) {
				throw new Error(
					`Git HEAD is unresolved for ${projectRoot}: ${formatGitFailure(headResolution)}.`,
				);
			}

			const cleanlinessCheck = executeGitCommand(runGit, repositoryRoot, [
				"status",
				"--porcelain",
				"--untracked-files=all",
				"--",
				".",
				`:(exclude)${buildplanePrefix}/state.db`,
				`:(exclude)${buildplanePrefix}/project.json`,
				`:(exclude)${buildplanePrefix}/artifacts/**`,
				`:(exclude)${buildplanePrefix}/evidence/**`,
				`:(exclude)${buildplanePrefix}/runs/**`,
				`:(exclude)${buildplanePrefix}/logs/**`,
				`:(exclude)${buildplanePrefix}/workspaces/**`,
			]);
			if (cleanlinessCheck.status !== 0) {
				throw new Error(
					`Git working tree status could not be determined for ${projectRoot}: ${formatGitFailure(cleanlinessCheck)}.`,
				);
			}

			if (cleanlinessCheck.stdout.trim().length > 0) {
				throw new Error(
					`Git working tree is not clean for ${projectRoot}; commit, stash, or discard changes before running Buildplane.`,
				);
			}

			return {
				headSha: headResolution.stdout.trim(),
			};
		},

		prepareWorkspace(projectRoot: string, runId: string, headSha: string) {
			const workspacePath = join(
				projectRoot,
				".buildplane",
				"workspaces",
				runId,
			);
			mkdirSync(dirname(workspacePath), { recursive: true });

			const worktreeAdd = executeGitCommand(runGit, projectRoot, [
				"worktree",
				"add",
				"--detach",
				workspacePath,
				headSha,
			]);
			if (worktreeAdd.status !== 0) {
				throw new Error(
					`Git worktree add failed for ${workspacePath}: ${formatGitFailure(worktreeAdd)}.`,
				);
			}

			return {
				path: workspacePath,
				headSha,
			};
		},

		deleteWorkspace(workspace: { path: string }) {
			const projectRoot = dirname(dirname(dirname(workspace.path)));
			const worktreeRemove = executeGitCommand(runGit, projectRoot, [
				"worktree",
				"remove",
				"--force",
				workspace.path,
			]);

			if (worktreeRemove.status !== 0) {
				return {
					deleted: false,
					cleanupError: `Git worktree remove failed for ${workspace.path}: ${formatGitFailure(worktreeRemove)}.`,
				};
			}

			return { deleted: true };
		},
		captureWorkspaceDiff(workspacePath: string) {
			const diffResult = executeGitCommand(runGit, workspacePath, [
				"diff",
				"HEAD",
			]);
			if (diffResult.status !== 0) {
				return { diff: "", filesChanged: 0 };
			}

			const statResult = executeGitCommand(runGit, workspacePath, [
				"diff",
				"HEAD",
				"--stat",
			]);
			const filesChanged =
				statResult.status === 0 ? countChangedFiles(statResult.stdout) : 0;

			return { diff: diffResult.stdout, filesChanged };
		},
	};

	return adapter;
}

function countChangedFiles(statOutput: string): number {
	const lines = statOutput.trim().split("\n");
	// The last line of --stat is the summary, e.g. "3 files changed, ..."
	// Every line before it is one changed file.
	if (lines.length <= 1) {
		return 0;
	}
	return lines.length - 1;
}

function executeGitCommand(
	runGit: GitCommandRunner,
	cwd: string,
	args: string[],
): SpawnSyncReturns<string> {
	const result = runGit(args, {
		cwd,
		encoding: "utf8",
	});

	if (result.error) {
		throw new Error(
			`Git binary is unavailable: ${result.error.message || "unknown git error"}.`,
		);
	}

	return result;
}

function createIsolatedGitEnv(
	overrides: SpawnSyncOptions["env"],
): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_")) {
			delete env[key];
		}
	}

	return {
		...env,
		...overrides,
	};
}

function toGitPath(value: string): string {
	return value.split(sep).join("/");
}

function createRepositoryError(
	projectRoot: string,
	result: SpawnSyncReturns<string>,
): Error {
	const detail = formatGitFailure(result);
	if (/not a git repository/i.test(detail)) {
		return new Error(`${projectRoot} is not a git repository.`);
	}

	return new Error(
		`Git repository check failed for ${projectRoot}: ${detail}.`,
	);
}

function formatGitFailure(result: SpawnSyncReturns<string>): string {
	const stderr = result.stderr.trim();
	if (stderr.length > 0) {
		return stderr;
	}

	const stdout = result.stdout.trim();
	if (stdout.length > 0) {
		return stdout;
	}

	return `git exited with status ${result.status ?? "unknown"}`;
}
