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

const DEFAULT_GIT_IDENTITY = Object.freeze({
	name: "Buildplane",
	email: "buildplane@local",
});

/**
 * `.buildplane/**` paths excluded from worktree-cleanliness git checks: per-repo
 * state + run-time artifacts (incl. ledger events.db + WAL) that are expected to
 * change during a run and must not read as "dirty". Single source of truth shared
 * by assertRunnableRepository (repo-root prefix) and checkWorktreeClean (worktree root).
 */
const BUILDPLANE_WORKTREE_CLEAN_EXCLUSIONS = [
	"state.db",
	"project.json",
	"artifacts/**",
	"evidence/**",
	"runs/**",
	"logs/**",
	"workspaces/**",
	"vcr/**",
	"ledger/**",
	"planforge/**",
] as const;

/** `:(exclude)<prefix>/<pattern>` pathspecs for the given `.buildplane` prefix. */
function buildplaneCleanExcludePathspecs(buildplanePrefix: string): string[] {
	return BUILDPLANE_WORKTREE_CLEAN_EXCLUSIONS.map(
		(pattern) => `:(exclude)${buildplanePrefix}/${pattern}`,
	);
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
			env.GIT_AUTHOR_NAME ??= DEFAULT_GIT_IDENTITY.name;
			env.GIT_AUTHOR_EMAIL ??= DEFAULT_GIT_IDENTITY.email;
			env.GIT_COMMITTER_NAME ??= DEFAULT_GIT_IDENTITY.name;
			env.GIT_COMMITTER_EMAIL ??= DEFAULT_GIT_IDENTITY.email;
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
				...buildplaneCleanExcludePathspecs(buildplanePrefix),
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

		checkWorktreeClean(worktreePath: string): boolean {
			const status = executeGitCommand(runGit, worktreePath, [
				"status",
				"--porcelain",
				"--untracked-files=all",
				"--",
				".",
				...buildplaneCleanExcludePathspecs(".buildplane"),
			]);
			if (status.status !== 0) {
				return false;
			}
			return status.stdout.trim().length === 0;
		},

		prepareWorkspace(projectRoot: string, runId: string, headSha: string) {
			const baseCheck = executeGitCommand(runGit, projectRoot, [
				"rev-parse",
				"--verify",
				"--quiet",
				`${headSha}^{commit}`,
			]);
			if (baseCheck.status !== 0) {
				throw new Error(
					`prepareWorkspace: base commit ${headSha} does not resolve to a commit in ${projectRoot} (stale or detached anchor): ${formatGitFailure(baseCheck)}.`,
				);
			}

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
		}): { mergedHeadSha: string } {
			const projectRoot =
				workspace.projectRoot ?? dirname(dirname(dirname(workspace.path)));

			// M5-S4 F1 — crash-window idempotency. The reconciler may re-drive this
			// merge after a crash between the merge and the execution marker. Git
			// history survives the crash, so probe the project root for a prior merge
			// commit carrying THIS run's merge message and, if present, return its SHA
			// without creating a second commit/merge. The merge message embeds the
			// runId (`feat: merge buildplane run {runId}`), so the probe is run-scoped.
			const existingMergeSha = findExistingRunMergeSha(
				runGit,
				projectRoot,
				workspace.runId,
			);
			if (existingMergeSha !== null) {
				return { mergedHeadSha: existingMergeSha };
			}

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

			const mergedHeadRes = executeGitCommand(runGit, projectRoot, [
				"rev-parse",
				"HEAD",
			]);
			if (mergedHeadRes.status !== 0) {
				throw new Error(
					`Git rev-parse HEAD failed in project root ${projectRoot} after merge: ${formatGitFailure(mergedHeadRes)}`,
				);
			}

			return { mergedHeadSha: mergedHeadRes.stdout.trim() };
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

/**
 * Returns the SHA of the most recent reachable commit whose subject is exactly
 * this run's merge message, or `null` if none. Used by `commitAndMergeWorkspace`
 * to stay idempotent across the crash-after-merge-before-marker window (M5-S4 F1):
 * the merge message embeds the runId, so a prior merge is detected run-scoped.
 */
function findExistingRunMergeSha(
	runGit: GitCommandRunner,
	projectRoot: string,
	runId: string,
): string | null {
	const subject = `feat: merge buildplane run ${runId}`;
	// Each line is `<40-hex-sha> <subject>`; split at the first space to match
	// the subject (the runId-embedded merge message) exactly.
	const log = executeGitCommand(runGit, projectRoot, [
		"log",
		"--format=%H %s",
		"HEAD",
	]);
	if (log.status !== 0) {
		return null;
	}
	for (const line of log.stdout.split("\n")) {
		const sep = line.indexOf(" ");
		if (sep === -1) continue;
		if (line.slice(sep + 1) === subject) {
			return line.slice(0, sep);
		}
	}
	return null;
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
