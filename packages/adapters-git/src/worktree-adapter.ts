import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { BuildplaneWorkspacePort } from "@buildplane/kernel";

/** A function that runs a git command and returns its result synchronously. */
export type GitCommandRunner = (
	args: string[],
	options: { cwd: string; encoding: "utf8" },
) => SpawnSyncReturns<string>;

/** Details about why a git command failed. */
function formatGitFailure(result: SpawnSyncReturns<string>): string {
	const parts = [];
	if (result.stderr) parts.push(result.stderr.trim());
	if (result.stdout) parts.push(result.stdout.trim());
	if (result.error) parts.push(result.error.message);
	if (result.status !== null) parts.push(`exit code ${result.status}`);
	return parts.join("; ") || "unknown error";
}

/**
 * Creates a BuildplaneWorkspacePort backed by real Git worktrees.
 *
 * @param runGit Custom runner for testing (defaults to `child_process.spawnSync("git", ...)`).
 */
export interface CreateGitWorkspaceAdapterOptions {
	runGit?: GitCommandRunner;
	gitBinary?: string;
}

export function createGitWorktreeAdapter(
	options?: CreateGitWorkspaceAdapterOptions,
): BuildplaneWorkspacePort {
	const gitBinary = options?.gitBinary ?? "git";
	const runGit: GitCommandRunner =
		options?.runGit ??
		((args, spawnOptions) => {
			// Clear git env vars so tests pass
			const env = { ...process.env };
			delete env.GIT_DIR;
			delete env.GIT_WORK_TREE;
			delete env.GIT_INDEX_FILE;
			return spawnSync(gitBinary, args, { ...spawnOptions, env });
		});
	const adapter: BuildplaneWorkspacePort = {
		assertRunnableRepository(projectRoot: string) {
			// Check if git is available
			const versionCheck = runGit(["--version"], {
				cwd: projectRoot,
				encoding: "utf8",
			});
			if (versionCheck.error) {
				throw new Error(`git binary is unavailable: ${gitBinary}`);
			}

			const rootResolution = executeGitCommand(runGit, projectRoot, [
				"rev-parse",
				"--show-toplevel",
			]);
			if (rootResolution.status !== 0) {
				throw new Error(
					`${projectRoot} does not appear to be inside a git repository: ${formatGitFailure(rootResolution)}.`,
				);
			}

			const repositoryRoot = rootResolution.stdout.trim();
			// Compute the .buildplane prefix relative to the repo root.
			// When the project lives in a subdirectory (e.g. services/api/), git status
			// reports paths relative to the repo root, so the exclude pathspecs must be
			// relative to the repo root too (e.g. "services/api/.buildplane").
			// Resolve real paths to handle OS-level symlinks (e.g. /var → /private/var on macOS)
			// before computing the relative path — without this, relative() produces
			// traversal paths (../../..) that git rejects as "outside repository".
			const resolvedRepoRoot = realpathSync(repositoryRoot);
			const resolvedProjectRoot = realpathSync(projectRoot);
			const projectRelative = relative(resolvedRepoRoot, resolvedProjectRoot);
			const buildplanePrefix =
				projectRelative === ""
					? ".buildplane"
					: `${projectRelative}/.buildplane`;

			const headResolution = executeGitCommand(runGit, projectRoot, [
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

		commitAndMergeWorkspace(workspace: {
			path: string;
			runId: string;
			projectRoot?: string;
		}) {
			const projectRoot =
				workspace.projectRoot ?? dirname(dirname(dirname(workspace.path)));

			// Commit changes made in the worktree, excluding .buildplane/ state.
			// The worktree may contain its own .buildplane/ artifacts from nested
			// runs or the host project's state — these must not be merged back
			// as they would conflict with the main repo's .buildplane/ directory.
			executeGitCommand(runGit, workspace.path, [
				"add",
				"--all",
				"--",
				".",
				":!.buildplane",
			]);
			const commitRes = executeGitCommand(runGit, workspace.path, [
				"commit",
				"--allow-empty",
				"--no-verify",
				"-m",
				`feat: buildplane run ${workspace.runId}`,
			]);

			if (commitRes.status !== 0) {
				throw new Error(
					`Git commit failed in worktree ${workspace.path}: ${formatGitFailure(commitRes)}`,
				);
			}

			const newHeadRes = executeGitCommand(runGit, workspace.path, [
				"rev-parse",
				"HEAD",
			]);
			if (newHeadRes.status !== 0) {
				throw new Error(
					`Git rev-parse HEAD failed in worktree ${workspace.path}`,
				);
			}

			const newHead = newHeadRes.stdout.trim();

			// Merge back to project root
			const mergeRes = executeGitCommand(runGit, projectRoot, [
				"merge",
				"--no-ff",
				"-m",
				`feat: merge buildplane run ${workspace.runId}`,
				newHead,
			]);

			if (mergeRes.status !== 0) {
				throw new Error(
					`Git merge failed in project root ${projectRoot}: ${formatGitFailure(mergeRes)}`,
				);
			}
		},

		deleteWorkspace(workspace: { path: string; projectRoot?: string }) {
			const projectRoot =
				workspace.projectRoot ?? dirname(dirname(dirname(workspace.path)));
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
	};

	return adapter;
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
		// e.g., git is not installed, ENONENT
		return {
			...result,
			status: result.status ?? 1,
			stdout: result.stdout ?? "",
			stderr:
				result.stderr ??
				`Failed to launch git command: ${result.error.message}`,
		};
	}

	return result;
}
