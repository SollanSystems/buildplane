import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
	ActionRequestedV2,
	BuildplaneWorkspacePort,
	CreateGovernedWorkspaceCandidateInput,
	DurableActionReceiptV2,
	DurableActionRequestV2,
	GovernedActionEvidencePort,
	GovernedActivityClaimPort,
	GovernedActivityResultDispositionV1,
	GovernedActivityResultOutcomeV1,
	GovernedDispatchLineageV3,
	GovernedWorkspaceCandidateCreationResult,
	GrantedGovernedActivityClaimV1,
	RecordActionReceiptV2Input,
} from "@buildplane/kernel";
import {
	canonicalActionReceiptRecordedV2Digest,
	canonicalActionRequestedV2Digest,
	isCanonicalBuildplaneCandidateRef,
} from "@buildplane/kernel";

/** A function that runs a git command and returns its result synchronously. */
export type GitCommandRunner = (
	args: string[],
	options: { cwd: string; encoding: "utf8"; input?: string },
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Creates a BuildplaneWorkspacePort backed by real Git worktrees.
 *
 * @param runGit Custom runner for testing (defaults to `child_process.spawnSync("git", ...)`).
 */
export interface CreateGitWorkspaceAdapterOptions {
	runGit?: GitCommandRunner;
	gitBinary?: string;
	/** Injectable clock for durable governed-action evidence tests. */
	now?: () => string;
}

/**
 * Identifies one immutable implementation candidate. The three components are
 * deliberately part of the durable Git ref name, so a retry cannot silently
 * reuse another candidate from the same run.
 */
export interface GitWorkspaceCandidateIdentity {
	readonly candidateId: string;
	readonly runId: string;
	readonly attempt: number;
}

/** Input required to commit a detached worktree as an immutable candidate. */
export interface CreateGitWorkspaceCandidateInput
	extends GitWorkspaceCandidateIdentity {
	readonly path: string;
	readonly baseSha: string;
	readonly projectRoot?: string;
}

/**
 * Content-addressed facts about a candidate. `candidateCommitSha` is Git's
 * object identity; every `*Digest` is a SHA-256 digest over deterministic
 * content derived from that exact commit and base. `candidateDigest` is the
 * adapter-specific raw-Git digest, not the kernel's richer CandidateArtifactV1
 * digest (which also binds workflow, provenance, and action receipts).
 */
export interface GitWorkspaceCandidate extends GitWorkspaceCandidateIdentity {
	readonly schemaVersion: 1;
	readonly candidateKey: string;
	readonly candidateRef: string;
	readonly baseSha: string;
	readonly candidateCommitSha: string;
	readonly commitDigest: string;
	readonly treeDigest: string;
	readonly patchDigest: string;
	readonly changedFilesDigest: string;
	readonly candidateDigest: string;
}

/** Input required to promote an already-created immutable candidate. */
export interface PromoteGitWorkspaceCandidateInput {
	readonly projectRoot: string;
	readonly candidate: GitWorkspaceCandidate;
	/** Signed branch expected by the governed promotion decision. */
	readonly targetRef: string;
}

/** A promotion either advances the target once or reports the prior advance. */
export interface GitWorkspaceCandidatePromotionResult {
	readonly status: "promoted" | "already_promoted" | "reconciliation_required";
	readonly mergedHeadSha: string;
	readonly candidateDigest: string;
	readonly promotionGitBinding: {
		readonly targetRef: string;
		readonly targetHeadBeforeSha: string;
		readonly targetHeadAfterSha: string;
		readonly mergedHeadSha: string;
		readonly candidateCommitSha: string;
		readonly mergeParentShas: readonly [string, string];
		readonly mergedTreeSha: string;
		readonly mergedTreeDigest: string;
		/** Immutable candidate-keyed Git receipt retained across tape crashes. */
		readonly promotionReceiptRef: string;
		readonly worktreeSyncState: "pending_reconciliation" | "target_advanced";
	};
}

/** A receipt probe observes a prior CAS; it never represents a new CAS. */
export type GitWorkspaceCandidatePromotionInspectionResult = Omit<
	GitWorkspaceCandidatePromotionResult,
	"status"
> & {
	readonly status: "already_promoted" | "reconciliation_required";
};

export type GitWorkspaceCandidateErrorCode =
	| "CANDIDATE_INVALID_IDENTITY"
	| "CANDIDATE_CREATION_FAILED"
	| "CANDIDATE_WORKSPACE_HEAD_MISMATCH"
	| "CANDIDATE_WORKSPACE_TOPOLOGY_INVALID"
	| "CANDIDATE_REF_MISMATCH"
	| "CANDIDATE_BASE_MISMATCH"
	| "CANDIDATE_DIGEST_MISMATCH"
	| "CANDIDATE_STALE_BASE"
	| "CANDIDATE_TARGET_REF_REQUIRED"
	| "CANDIDATE_TARGET_REF_UNAVAILABLE"
	| "CANDIDATE_TARGET_REF_MISMATCH"
	| "CANDIDATE_TARGET_DIRTY"
	| "CANDIDATE_PROMOTION_FAILED";

/**
 * A machine-actionable candidate transaction failure. Callers must never use a
 * candidate error as a fallback merge authorization. A post-CAS target that no
 * longer contains the candidate merge is instead returned as a durable
 * `reconciliation_required` result, never retried as a fresh promotion.
 */
export class GitWorkspaceCandidateError extends Error {
	readonly code: GitWorkspaceCandidateErrorCode;

	constructor(code: GitWorkspaceCandidateErrorCode, message: string) {
		super(message);
		this.name = "GitWorkspaceCandidateError";
		this.code = code;
	}
}

/** The adapter's concrete surface, including trust-spine candidate primitives. */
export interface GitWorktreeAdapter extends BuildplaneWorkspacePort {
	createWorkspaceCandidate(
		input: CreateGitWorkspaceCandidateInput,
	): GitWorkspaceCandidate;
	promoteWorkspaceCandidate(
		input: PromoteGitWorkspaceCandidateInput,
	): GitWorkspaceCandidatePromotionResult;
	inspectWorkspaceCandidatePromotion(
		input: PromoteGitWorkspaceCandidateInput,
	): GitWorkspaceCandidatePromotionInspectionResult | null;
	promoteGovernedWorkspaceCandidate?(
		input: PromoteGitWorkspaceCandidateInput,
	): GitWorkspaceCandidatePromotionResult;
	inspectGovernedWorkspaceCandidatePromotion?(
		input: PromoteGitWorkspaceCandidateInput,
	): GitWorkspaceCandidatePromotionInspectionResult | null;
	createGovernedWorkspaceCandidate(
		input: CreateGovernedWorkspaceCandidateInput,
	): Promise<GovernedWorkspaceCandidateCreationResult>;
}

/**
 * The governed adapter deliberately has no raw candidate or target-branch
 * mutation surface.
 * A future native decision-bound promotion executor will be a separate,
 * authority-bearing capability rather than an ambient method inherited from
 * the general Git adapter.
 */
export interface GovernedGitWorktreeAdapter
	extends Omit<
		GitWorktreeAdapter,
		| "commitAndMergeWorkspace"
		| "createWorkspaceCandidate"
		| "promoteWorkspaceCandidate"
		| "promoteGovernedWorkspaceCandidate"
	> {
	readonly governedWorkspaceBoundary: "pinned-governed-git-v1";
}

const DEFAULT_GIT_IDENTITY = Object.freeze({
	name: "Buildplane",
	email: "buildplane@local",
});

/**
 * Governed Git effects are deliberately not allowed to inherit the host PATH,
 * Git configuration, credentials, or environment.  The normal adapter is
 * still useful for the explicitly unsafe/raw lane, so its runner remains
 * injectable.  Candidate creation in the governed lane never uses it.
 *
 * This is intentionally Linux-only.  Governed execution requires the same
 * Linux/WSL isolation substrate as the OCI worker boundary; falling back to a
 * host-shell Git binary would silently expand authority.
 */
const GOVERNED_GIT_BINARY = "/usr/bin/git";
const GOVERNED_GIT_FIXED_OPTIONS = [
	"--no-optional-locks",
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"commit.gpgSign=false",
	"-c",
	"gpg.program=false",
	"-c",
	"gpg.ssh.program=false",
	"-c",
	"diff.external=false",
] as const;

function governedGitEnvironment(): NodeJS.ProcessEnv {
	return {
		PATH: "/usr/bin:/bin",
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		TZ: "UTC",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_COUNT: "0",
		GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: DEFAULT_GIT_IDENTITY.name,
		GIT_AUTHOR_EMAIL: DEFAULT_GIT_IDENTITY.email,
		GIT_COMMITTER_NAME: DEFAULT_GIT_IDENTITY.name,
		GIT_COMMITTER_EMAIL: DEFAULT_GIT_IDENTITY.email,
	};
}

function governedGitUnavailable(message: string): SpawnSyncReturns<string> {
	return {
		pid: 0,
		// `SpawnSyncReturns<T>` models the stdio tuple even when a process could
		// not be launched. Keep that shape so callers never have to treat this
		// fail-closed result as a partially initialized host process.
		output: [null, "", message],
		stdout: "",
		stderr: message,
		status: 1,
		signal: null,
		error: new Error(message),
	};
}

/**
 * Create the sole runner used to materialize a governed candidate.  It is a
 * fresh immutable closure with a fixed executable and a scrubbed environment,
 * so a caller's PATH/GIT_* configuration cannot redirect a signed Git effect.
 */
function createPinnedGovernedGitRunner(): GitCommandRunner {
	return (args, spawnOptions) => {
		if (process.platform !== "linux") {
			return governedGitUnavailable(
				"Governed Git candidate creation requires Linux or WSL; host-shell fallback is denied.",
			);
		}

		let executable: string;
		try {
			executable = realpathSync(GOVERNED_GIT_BINARY);
			if (!statSync(executable).isFile()) {
				return governedGitUnavailable(
					`Governed Git executable ${GOVERNED_GIT_BINARY} is not a regular file.`,
				);
			}
		} catch (error) {
			return governedGitUnavailable(
				`Pinned governed Git executable ${GOVERNED_GIT_BINARY} is unavailable: ${errorMessage(error)}.`,
			);
		}

		return spawnSync(executable, [...GOVERNED_GIT_FIXED_OPTIONS, ...args], {
			...spawnOptions,
			env: governedGitEnvironment(),
		});
	};
}

/**
 * Config keys that can cause Git to launch a helper, consult credentials, or
 * load mutable configuration outside the candidate overlay.  A governed
 * repository must not rely on any of them until the OCI action plane owns a
 * policy-approved equivalent.  The conservative refusal is intentional: a
 * successful candidate is never worth ambient host execution.
 */
function isUnsafeGovernedGitConfigKey(key: string): boolean {
	const normalized = key.toLowerCase();
	return (
		normalized === "core.hookspath" ||
		normalized === "core.fsmonitor" ||
		normalized === "core.worktree" ||
		normalized === "core.sshcommand" ||
		normalized === "core.gitproxy" ||
		normalized === "core.askpass" ||
		normalized === "core.editor" ||
		normalized === "diff.external" ||
		normalized === "commit.gpgsign" ||
		normalized === "gpg.program" ||
		normalized === "gpg.ssh.program" ||
		(normalized.startsWith("filter.") &&
			/\.(clean|smudge|process|required)$/.test(normalized)) ||
		(normalized.startsWith("merge.") && normalized.endsWith(".driver")) ||
		(normalized.startsWith("diff.") && normalized.endsWith(".command")) ||
		(normalized.startsWith("credential.") && normalized.endsWith(".helper")) ||
		// This extension only opts a repository into a separate worktree config
		// file. The caller scans both the root and candidate effective configs,
		// so its presence is not itself an execution helper or an authority
		// bypass. Unsafe keys in either scope still fail closed above.
		normalized.startsWith("include.") ||
		normalized.startsWith("includeif.")
	);
}

function assertGovernedGitConfiguration(
	runGit: GitCommandRunner,
	...directories: readonly string[]
): void {
	const inspected = new Set<string>();
	for (const directory of directories) {
		if (inspected.has(directory)) continue;
		inspected.add(directory);
		// Do not limit this to --local: a linked worktree can have an effective
		// `config.worktree` scope. The pinned environment has already disabled
		// system/global config; this sees every remaining repository-controlled
		// scope without executing any configured helper.
		const configuration = executeGitCommand(runGit, directory, [
			"config",
			"--includes",
			"--null",
			"--name-only",
			"--list",
		]);
		if (configuration.status !== 0) {
			throw new Error(
				`Governed Git configuration could not be read: ${formatGitFailure(configuration)}.`,
			);
		}
		for (const key of configuration.stdout.split("\0")) {
			if (key.length === 0) continue;
			if (isUnsafeGovernedGitConfigKey(key)) {
				throw new Error(
					`Governed Git repository configuration contains unsupported helper-bearing key ${key}.`,
				);
			}
		}
	}
}

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
): GitWorktreeAdapter {
	const gitBinary = options?.gitBinary ?? "git";
	const now = options?.now ?? (() => new Date().toISOString());
	// This closure is separate from `runGit`: raw callers may intentionally
	// configure their runner, but a governed candidate must always use the
	// pinned action-plane executable below.
	const governedRunGit = createPinnedGovernedGitRunner();
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
	const adapter: GitWorktreeAdapter = {
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

		createWorkspaceCandidate(
			input: CreateGitWorkspaceCandidateInput,
		): GitWorkspaceCandidate {
			const identity = validateCandidateIdentity(input);
			const projectRoot =
				input.projectRoot ?? dirname(dirname(dirname(input.path)));
			const baseSha = resolveCommitOrThrow(
				runGit,
				projectRoot,
				input.baseSha,
				"CANDIDATE_BASE_MISMATCH",
				"candidate base",
			);
			const candidateRef = candidateRefFor(identity);

			// The named ref is the idempotency anchor. If it already exists, do not
			// touch the worktree (which may contain a later retry's edits); validate
			// and return precisely the immutable candidate it names.
			const existingCandidateCommit = resolveRefCommitOrNull(
				runGit,
				projectRoot,
				candidateRef,
			);
			if (existingCandidateCommit !== null) {
				return deriveAndValidateCandidate(
					runGit,
					projectRoot,
					{
						schemaVersion: 1,
						...identity,
						candidateKey: candidateKeyFor(identity),
						candidateRef,
						baseSha,
						candidateCommitSha: existingCandidateCommit,
						...emptyCandidateDigestFields(),
					},
					{ allowUnspecifiedDigests: true },
				);
			}

			const workspaceHead = resolveCommitOrThrow(
				runGit,
				input.path,
				"HEAD",
				"CANDIDATE_WORKSPACE_HEAD_MISMATCH",
				"candidate workspace HEAD",
			);
			let candidateCommitSha: string;
			if (workspaceHead === baseSha) {
				// Commit only inside the detached candidate worktree. The root target
				// is neither checked out nor merged here.
				const add = executeGitCommand(runGit, input.path, [
					"add",
					"--all",
					"--",
					".",
					":!.buildplane",
				]);
				if (add.status !== 0) {
					throw new GitWorkspaceCandidateError(
						"CANDIDATE_CREATION_FAILED",
						`Candidate staging failed in worktree ${input.path}: ${formatGitFailure(add)}`,
					);
				}
				const commit = executeGitCommand(runGit, input.path, [
					"commit",
					"--allow-empty",
					"--no-verify",
					"-m",
					candidateCommitMessage(identity),
				]);
				if (commit.status !== 0) {
					throw new GitWorkspaceCandidateError(
						"CANDIDATE_CREATION_FAILED",
						`Candidate commit failed in worktree ${input.path}: ${formatGitFailure(commit)}`,
					);
				}
				candidateCommitSha = resolveCommitOrThrow(
					runGit,
					input.path,
					"HEAD",
					"CANDIDATE_WORKSPACE_HEAD_MISMATCH",
					"candidate workspace HEAD after commit",
				);
			} else {
				// There is no durable, content-addressed identity for a commit made
				// before the candidate ref exists. Parent and subject are both mutable
				// conventions, not proof that this is the original candidate. A retry
				// must reconcile the interrupted creation instead of silently adopting
				// an ambiguous workspace commit.
				throw new GitWorkspaceCandidateError(
					"CANDIDATE_WORKSPACE_HEAD_MISMATCH",
					`Candidate workspace HEAD ${workspaceHead} does not equal base ${baseSha}; the durable candidate ref ${candidateRef} is absent, so automatic recovery is denied.`,
				);
			}

			const candidate = deriveCandidateArtifact(
				runGit,
				projectRoot,
				identity,
				candidateRef,
				baseSha,
				candidateCommitSha,
			);
			const createRef = executeGitCommand(runGit, projectRoot, [
				"update-ref",
				candidateRef,
				candidateCommitSha,
				emptyObjectId(runGit, projectRoot),
			]);
			if (createRef.status === 0) {
				return candidate;
			}

			// Another process may have won the create-only ref write. Read it back
			// and return only if it resolves to the same immutable candidate.
			const concurrentCandidateCommit = resolveRefCommitOrNull(
				runGit,
				projectRoot,
				candidateRef,
			);
			if (concurrentCandidateCommit !== null) {
				const concurrentCandidate = deriveAndValidateCandidate(
					runGit,
					projectRoot,
					{
						schemaVersion: 1,
						...identity,
						candidateKey: candidateKeyFor(identity),
						candidateRef,
						baseSha,
						candidateCommitSha: concurrentCandidateCommit,
						...emptyCandidateDigestFields(),
					},
					{ allowUnspecifiedDigests: true },
				);
				if (concurrentCandidate.candidateDigest === candidate.candidateDigest) {
					return concurrentCandidate;
				}
			}

			throw new GitWorkspaceCandidateError(
				"CANDIDATE_REF_MISMATCH",
				`Could not create immutable candidate ref ${candidateRef}: ${formatGitFailure(createRef)}.`,
			);
		},

		async createGovernedWorkspaceCandidate(
			input: CreateGovernedWorkspaceCandidateInput,
		): Promise<GovernedWorkspaceCandidateCreationResult> {
			const governed = validateGovernedCandidateCreationInput(input);
			const verifiedTopology = assertGovernedCandidateWorktreeTopology(
				governedRunGit,
				governed.projectRoot,
				governed.candidatePath,
			);
			// Even a direct library call (outside the orchestrator) cannot turn the
			// candidate helper into a host-config execution path.
			assertGovernedGitConfiguration(
				governedRunGit,
				verifiedTopology.projectRoot,
				verifiedTopology.candidatePath,
			);
			const execution = createGovernedCandidateExecutionContext(
				governed,
				verifiedTopology,
			);
			const requestedAt = now();
			const actionRequest = governedCandidateActionRequest(
				execution,
				requestedAt,
			);

			// The tape write is the pre-effect boundary. If it fails, the Git
			// materialization is never attempted.
			const durableRequest =
				await execution.actionEvidencePort.recordActionRequested(actionRequest);
			assertDurableCandidateActionRequest(durableRequest, actionRequest);
			assertGovernedCandidateTopologyRemainsPinned({
				runGit: governedRunGit,
				expected: execution.topology,
			});
			const activityClaim = requireGrantedCandidateActivityClaim(
				await execution.activityClaimPort.claim({
					dispatch: execution.dispatch,
					durableRequest,
					activityId: actionRequest.actionId,
					idempotencyKey: actionRequest.idempotencyKey,
					leaseDurationMs: GOVERNED_CANDIDATE_ACTIVITY_LEASE_DURATION_MS,
				}),
				actionRequest,
			);

			const effectStartedAtMs = Date.now();
			try {
				assertCandidateActivityClaimUnexpiredAt(activityClaim, now());
			} catch (error) {
				try {
					await recordUnknownGovernedCandidateActivityAndReceipt({
						execution,
						durableRequest,
						activityClaim,
						cause: error,
						completedAt: now(),
						wallTimeMs: 0,
					});
				} catch (terminalError) {
					throw unknownGovernedCandidateEffectError(error, terminalError);
				}
				throw error;
			}
			let candidate: GitWorkspaceCandidate;
			try {
				candidate = materializeVerifiedGovernedWorkspaceCandidate({
					execution,
					runGit: governedRunGit,
					now,
				});
			} catch (error) {
				const completedAt = now();
				try {
					await recordUnknownGovernedCandidateActivityAndReceipt({
						execution,
						durableRequest,
						activityClaim,
						cause: error,
						completedAt,
						wallTimeMs: Math.max(0, Date.now() - effectStartedAtMs),
					});
				} catch (terminalError) {
					throw unknownGovernedCandidateEffectError(error, terminalError);
				}
				throw error;
			}

			const completedAt = now();
			const receiptInput = governedCandidateSuccessReceipt(
				execution,
				durableRequest.actionRequestDigest,
				candidate,
				completedAt,
				Math.max(0, Date.now() - effectStartedAtMs),
			);
			let activityResult: Extract<
				GovernedActivityResultDispositionV1,
				{ readonly state: "recorded" }
			>;
			try {
				activityResult = await recordGovernedCandidateActivityResult({
					execution,
					durableRequest,
					activityClaim,
					outcome: "succeeded",
					resultDigest: requireCanonicalDigest(
						receiptInput.resultDigest,
						"candidate Git result digest",
					),
					resultRef: requireNonEmptyString(
						receiptInput.resultRef,
						"candidate Git result reference",
					),
					evidenceDigest: requireCanonicalDigest(
						receiptInput.evidenceDigest,
						"candidate Git evidence digest",
					),
					evidenceRef: requireNonEmptyString(
						receiptInput.evidenceRef,
						"candidate Git evidence reference",
					),
				});
			} catch (error) {
				throw unknownGovernedCandidateEffectError(candidate, error);
			}
			let durableReceipt: DurableActionReceiptV2;
			try {
				durableReceipt =
					await execution.actionEvidencePort.recordActionReceipt(receiptInput);
			} catch (error) {
				// The Git ref may now exist but is not durably evidenced. The caller
				// must reconcile that unknown effect; never continue to seal or
				// expose the candidate for acceptance/promotion.
				throw unknownGovernedCandidateEffectError(candidate, error);
			}
			assertDurableCandidateActionReceipt(durableReceipt, actionRequest);

			return {
				candidate,
				actionReceipt: {
					actionId: actionRequest.actionId,
					actionReceiptRef: durableReceipt.receipt.actionReceiptRef,
					actionReceiptDigest: durableReceipt.actionReceiptDigest,
				},
				candidateCreateActionEvidence: {
					actionId: actionRequest.actionId,
					actionRequestRef: durableRequest.actionRequestRef,
					actionRequestDigest: durableRequest.actionRequestDigest,
					activityClaimEventRef: activityClaim.claimEventId,
					activityClaimEventDigest: activityClaim.claimEventDigest,
					activityResultEventRef: activityResult.resultEventId,
					activityResultEventDigest: activityResult.resultEventDigest,
					actionReceiptRef: durableReceipt.receipt.actionReceiptRef,
					actionReceiptDigest: durableReceipt.actionReceiptDigest,
				},
			};
		},

		inspectWorkspaceCandidatePromotion(
			input: PromoteGitWorkspaceCandidateInput,
		): GitWorkspaceCandidatePromotionInspectionResult | null {
			return inspectExistingWorkspaceCandidatePromotionReceipt(runGit, input);
		},

		promoteWorkspaceCandidate(
			input: PromoteGitWorkspaceCandidateInput,
		): GitWorkspaceCandidatePromotionResult {
			const signedTargetRef = requirePromotionTargetRef(input.targetRef);
			const candidate = deriveAndValidateCandidate(
				runGit,
				input.projectRoot,
				input.candidate,
			);
			const targetRef = resolveTargetBranchRefOrThrow(
				runGit,
				input.projectRoot,
			);
			if (signedTargetRef !== targetRef) {
				throw new GitWorkspaceCandidateError(
					"CANDIDATE_TARGET_REF_MISMATCH",
					`Candidate ${candidate.candidateDigest} is authorized for ${signedTargetRef}, but the checked-out target branch is ${targetRef}.`,
				);
			}
			// The immutable receipt is the first recovery source. It is written in
			// the same Git transaction as the target CAS, so a tape crash cannot
			// make the merge undiscoverable when another actor later replaces the
			// target branch.
			const existingReceipt = readPromotionReceiptOrThrow(
				runGit,
				input.projectRoot,
				candidate,
			);
			if (existingReceipt) {
				return promotionResultFromReceipt(
					runGit,
					input.projectRoot,
					candidate,
					targetRef,
					existingReceipt,
				);
			}

			// Older target-bound promotions may predate the receipt ref. Recover the
			// exact historical merge only if it remains reachable, then retain a
			// receipt before returning any strict binding to the kernel.
			const existingPromotion = findExistingCandidatePromotionSha(
				runGit,
				input.projectRoot,
				candidate,
				targetRef,
			);
			if (existingPromotion !== null) {
				const mergeFacts = readExactCandidatePromotionFactsOrThrow(
					runGit,
					input.projectRoot,
					existingPromotion,
					candidate,
				);
				const receipt = ensurePromotionReceiptOrThrow(
					runGit,
					input.projectRoot,
					candidate,
					mergeFacts,
				);
				return promotionResultFromReceipt(
					runGit,
					input.projectRoot,
					candidate,
					targetRef,
					receipt,
				);
			}

			const targetHead = resolveCommitOrThrow(
				runGit,
				input.projectRoot,
				targetRef,
				"CANDIDATE_STALE_BASE",
				"target HEAD",
			);
			if (targetHead !== candidate.baseSha) {
				throw new GitWorkspaceCandidateError(
					"CANDIDATE_STALE_BASE",
					`Candidate ${candidate.candidateDigest} is stale: target HEAD ${targetHead} does not equal candidate base ${candidate.baseSha}.`,
				);
			}
			if (!adapter.checkWorktreeClean(input.projectRoot)) {
				throw new GitWorkspaceCandidateError(
					"CANDIDATE_TARGET_DIRTY",
					`Target repository ${input.projectRoot} is dirty; candidate promotion is denied.`,
				);
			}

			// Root currently equals the candidate base, so the candidate tree is the
			// deterministic two-parent merge result. Create the merge object without
			// touching root, then use update-ref's old-value precondition as the one
			// target-branch mutation. A competing root advance therefore fails closed
			// instead of causing Git to merge this candidate onto a newer base.
			const candidateTreeSha = resolveTreeOrThrow(
				runGit,
				input.projectRoot,
				candidate.candidateCommitSha,
			);
			const mergeCommit = executeGitCommand(runGit, input.projectRoot, [
				"commit-tree",
				candidateTreeSha,
				"-p",
				candidate.baseSha,
				"-p",
				candidate.candidateCommitSha,
				"-m",
				candidatePromotionMessage(candidate),
			]);
			if (mergeCommit.status !== 0 || mergeCommit.stdout.trim().length === 0) {
				throw new GitWorkspaceCandidateError(
					"CANDIDATE_PROMOTION_FAILED",
					`Candidate ${candidate.candidateDigest} merge commit creation failed: ${formatGitFailure(mergeCommit)}.`,
				);
			}
			const mergedHeadSha = resolveCommitOrThrow(
				runGit,
				input.projectRoot,
				mergeCommit.stdout.trim(),
				"CANDIDATE_PROMOTION_FAILED",
				"candidate promotion merge commit",
			);
			// Validate the actual commit object before the one target-branch CAS.
			// In particular, never let a syntactically valid but unrelated SHA
			// reach `update-ref` merely because a command runner returned it.
			const mergeFacts = readExactCandidatePromotionFactsOrThrow(
				runGit,
				input.projectRoot,
				mergedHeadSha,
				candidate,
			);
			const receipt: CandidatePromotionReceipt = {
				receiptRef: promotionReceiptRefForCandidate(candidate),
				mergeFacts,
			};
			const advanceHead = advancePromotionRefsAtomically(
				runGit,
				input.projectRoot,
				targetRef,
				candidate.baseSha,
				receipt,
			);
			if (advanceHead.status !== 0) {
				const completedReceipt = readPromotionReceiptOrThrow(
					runGit,
					input.projectRoot,
					candidate,
				);
				if (completedReceipt) {
					return promotionResultFromReceipt(
						runGit,
						input.projectRoot,
						candidate,
						targetRef,
						completedReceipt,
					);
				}
				const completedByAnotherAttempt = findExistingCandidatePromotionSha(
					runGit,
					input.projectRoot,
					candidate,
					targetRef,
				);
				if (completedByAnotherAttempt !== null) {
					const completedFacts = readExactCandidatePromotionFactsOrThrow(
						runGit,
						input.projectRoot,
						completedByAnotherAttempt,
						candidate,
					);
					const completedReceipt = ensurePromotionReceiptOrThrow(
						runGit,
						input.projectRoot,
						candidate,
						completedFacts,
					);
					return promotionResultFromReceipt(
						runGit,
						input.projectRoot,
						candidate,
						targetRef,
						completedReceipt,
					);
				}
				const currentHead = resolveCommitOrThrow(
					runGit,
					input.projectRoot,
					targetRef,
					"CANDIDATE_STALE_BASE",
					"target HEAD after failed candidate promotion",
				);
				if (currentHead !== candidate.baseSha) {
					throw new GitWorkspaceCandidateError(
						"CANDIDATE_STALE_BASE",
						`Candidate ${candidate.candidateDigest} is stale: target HEAD advanced to ${currentHead} before promotion could commit.`,
					);
				}
				throw new GitWorkspaceCandidateError(
					"CANDIDATE_PROMOTION_FAILED",
					`Candidate ${candidate.candidateDigest} target ref update failed: ${formatGitFailure(advanceHead)}.`,
				);
			}
			// Never reset or otherwise rewrite the root checkout after CAS. A user
			// edit or another branch update may race this observation; the immutable
			// receipt survives either race and turns a target replacement into an
			// explicit reconciliation result instead of a stale retry.
			const persistedReceipt = readPromotionReceiptOrThrow(
				runGit,
				input.projectRoot,
				candidate,
			);
			if (
				persistedReceipt === null ||
				persistedReceipt.mergeFacts.mergedHeadSha !== mergedHeadSha
			) {
				throw new GitWorkspaceCandidateError(
					"CANDIDATE_PROMOTION_FAILED",
					`Atomic promotion transaction did not retain immutable receipt ${receipt.receiptRef}.`,
				);
			}
			return promotionResultFromReceipt(
				runGit,
				input.projectRoot,
				candidate,
				targetRef,
				persistedReceipt,
				"promoted",
			);
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
 * Construct the only Git adapter accepted by the governed V3 lane. Unlike the
 * general adapter, every Git operation (repository probe, detached worktree,
 * candidate ref, and any future promotion) uses a fixed Linux executable with
 * a scrubbed environment and rejects helper-bearing local configuration before
 * it can execute. There is intentionally no caller-supplied binary or runner.
 */
export function createGovernedGitWorktreeAdapter(): GovernedGitWorktreeAdapter {
	const runGit = createPinnedGovernedGitRunner();
	const adapter = createGitWorktreeAdapter({ runGit });
	// A pinned Git executable is not, by itself, promotion authority. Do not
	// leak the generic target-ref CAS capability through the governed adapter:
	// a future native decision-bound promotion executor must own that effect.
	const {
		commitAndMergeWorkspace: _unsafeLegacyMerge,
		createWorkspaceCandidate: _unsafeRawCandidateCreation,
		promoteWorkspaceCandidate: _unsafePromotion,
		promoteGovernedWorkspaceCandidate: _unsupportedGovernedPromotion,
		...readOnlyGovernedAdapter
	} = adapter;
	const assertSafeRepository = (projectRoot: string): void => {
		assertGovernedGitConfiguration(runGit, projectRoot);
	};

	return Object.freeze({
		...readOnlyGovernedAdapter,
		governedWorkspaceBoundary: "pinned-governed-git-v1" as const,
		assertRunnableRepository(projectRoot: string) {
			assertSafeRepository(projectRoot);
			return adapter.assertRunnableRepository(projectRoot);
		},
		prepareWorkspace(projectRoot: string, runId: string, headSha: string) {
			assertSafeRepository(projectRoot);
			return adapter.prepareWorkspace(projectRoot, runId, headSha);
		},
		async createGovernedWorkspaceCandidate(
			input: CreateGovernedWorkspaceCandidateInput,
		) {
			assertSafeRepository(requireGovernedCandidateProjectRoot(input));
			return adapter.createGovernedWorkspaceCandidate(input);
		},
		inspectWorkspaceCandidatePromotion(
			input: PromoteGitWorkspaceCandidateInput,
		) {
			assertSafeRepository(input.projectRoot);
			return adapter.inspectWorkspaceCandidatePromotion(input);
		},
		inspectGovernedWorkspaceCandidatePromotion(
			input: PromoteGitWorkspaceCandidateInput,
		) {
			assertSafeRepository(input.projectRoot);
			return adapter.inspectWorkspaceCandidatePromotion(input);
		},
	});
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

const CANDIDATE_ID_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const CANONICAL_SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const FULL_GIT_OBJECT_ID = /^[a-f0-9]{40,64}$/;
const GOVERNED_CANDIDATE_ACTIVITY_LEASE_DURATION_MS = 300_000;

/**
 * A synchronous, pre-await capture of caller-owned candidate inputs. The
 * nested dispatch and ports are bound into the execution context before any
 * durable write; this object only prevents later reads of the outer packet.
 */
interface ValidatedGovernedCandidateCreationInput {
	readonly identity: GitWorkspaceCandidateIdentity;
	readonly projectRoot: string;
	readonly candidatePath: string;
	readonly baseSha: string;
	readonly dispatch: GovernedDispatchLineageV3;
	readonly actionEvidencePort: GovernedActionEvidencePort;
	readonly activityClaimPort: GovernedActivityClaimPort;
}

function validateGovernedCandidateCreationInput(
	input: CreateGovernedWorkspaceCandidateInput,
): ValidatedGovernedCandidateCreationInput {
	const identity = Object.freeze(
		validateCandidateIdentity({
			candidateId: input.candidateId,
			runId: input.runId,
			attempt: input.attempt,
		}),
	);
	const projectRoot = requireGovernedCandidateProjectRoot(input);
	const candidatePath = input.path;
	const baseSha = input.baseSha;
	const dispatch = input.governedDispatch;
	const actionEvidencePort = input.actionEvidencePort;
	const activityClaimPort = input.activityClaimPort;
	if (
		dispatch.schemaVersion !== 3 ||
		dispatch.trustTier !== "governed" ||
		dispatch.commitMode !== "atomic" ||
		dispatch.actionEvidenceVersion !== "sealed_v3"
	) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_INVALID_IDENTITY",
			"Governed candidate creation requires a sealed_v3 activity-claim V3 atomic governed dispatch.",
		);
	}
	if (
		dispatch.runId !== identity.runId ||
		dispatch.attempt !== identity.attempt ||
		dispatch.executionRole !== "implementer"
	) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_INVALID_IDENTITY",
			"Governed candidate identity must match an implementer V3 dispatch run and attempt.",
		);
	}
	if (
		!FULL_GIT_OBJECT_ID.test(baseSha) ||
		!FULL_GIT_OBJECT_ID.test(dispatch.baseCommitSha) ||
		baseSha !== dispatch.baseCommitSha
	) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_BASE_MISMATCH",
			"Governed candidate baseSha must exactly match the signed V3 dispatch baseCommitSha.",
		);
	}
	for (const [field, value] of Object.entries({
		envelopeDigest: dispatch.envelopeDigest,
		capabilityBundleDigest: dispatch.capabilityBundleDigest,
		policyDigest: dispatch.policyDigest,
		contextManifestDigest: dispatch.contextManifestDigest,
		workerManifestDigest: dispatch.workerManifestDigest,
		sandboxProfileDigest: dispatch.sandboxProfileDigest,
		repositoryBindingDigest: dispatch.repositoryBindingDigest,
		ledgerAuthorityRealmDigest: dispatch.ledgerAuthorityRealmDigest,
		governedPacketDigest: dispatch.governedPacketDigest,
	})) {
		if (typeof value !== "string" || !CANONICAL_SHA256_DIGEST.test(value)) {
			throw new GitWorkspaceCandidateError(
				"CANDIDATE_INVALID_IDENTITY",
				`Governed candidate dispatch ${field} must be a canonical SHA-256 digest.`,
			);
		}
	}
	if (
		typeof dispatch.workflowId !== "string" ||
		dispatch.workflowId.length === 0 ||
		typeof dispatch.unitId !== "string" ||
		dispatch.unitId.length === 0 ||
		typeof dispatch.provenanceRef !== "string" ||
		dispatch.provenanceRef.length === 0 ||
		typeof dispatch.authorityActor !== "string" ||
		dispatch.authorityActor.length === 0
	) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_INVALID_IDENTITY",
			"Governed candidate dispatch must contain workflow, unit, provenance, and authority identity.",
		);
	}
	return Object.freeze({
		identity,
		projectRoot,
		candidatePath,
		baseSha,
		dispatch,
		actionEvidencePort,
		activityClaimPort,
	});
}

/** Governed candidate effects never infer their repository authority. */
function requireGovernedCandidateProjectRoot(
	input: CreateGovernedWorkspaceCandidateInput,
): string {
	const projectRoot = input.projectRoot;
	if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_INVALID_IDENTITY",
			"Governed candidate creation requires an explicit non-empty projectRoot.",
		);
	}
	return projectRoot;
}

interface VerifiedGovernedCandidateWorktreeTopology {
	readonly projectRoot: string;
	readonly candidatePath: string;
	readonly projectCommonDir: string;
	readonly candidateGitDir: string;
}

interface GovernedCandidateMaterializationInput
	extends CreateGitWorkspaceCandidateInput {
	readonly projectRoot: string;
}

/** The candidate flow needs only its two durable evidence methods. */
interface CapturedGovernedCandidateActionEvidencePort {
	readonly recordActionRequested: GovernedActionEvidencePort["recordActionRequested"];
	readonly recordActionReceipt: GovernedActionEvidencePort["recordActionReceipt"];
}

/**
 * Immutable authority and effect data for one governed candidate operation.
 * This is intentionally constructed before the first awaited evidence write:
 * TypeScript `readonly` does not protect a caller-owned object at runtime.
 */
interface GovernedCandidateExecutionContext {
	readonly materialization: GovernedCandidateMaterializationInput;
	readonly topology: VerifiedGovernedCandidateWorktreeTopology;
	readonly dispatch: GovernedDispatchLineageV3;
	readonly actionEvidencePort: CapturedGovernedCandidateActionEvidencePort;
	readonly activityClaimPort: GovernedActivityClaimPort;
}

function createGovernedCandidateExecutionContext(
	input: ValidatedGovernedCandidateCreationInput,
	topology: VerifiedGovernedCandidateWorktreeTopology,
): GovernedCandidateExecutionContext {
	const materialization = Object.freeze({
		candidateId: input.identity.candidateId,
		runId: input.identity.runId,
		attempt: input.identity.attempt,
		baseSha: input.baseSha,
		path: topology.candidatePath,
		projectRoot: topology.projectRoot,
	});
	return Object.freeze({
		materialization,
		topology,
		dispatch: snapshotGovernedDispatchLineageV3(input.dispatch),
		actionEvidencePort: captureCandidateActionEvidencePort(
			input.actionEvidencePort,
		),
		activityClaimPort: captureCandidateActivityClaimPort(
			input.activityClaimPort,
		),
	});
}

function snapshotGovernedDispatchLineageV3(
	input: GovernedDispatchLineageV3,
): GovernedDispatchLineageV3 {
	if (!input.budget || typeof input.budget !== "object") {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_INVALID_IDENTITY",
			"Governed candidate dispatch must contain a budget object.",
		);
	}
	return Object.freeze({
		schemaVersion: input.schemaVersion,
		runId: input.runId,
		workflowId: input.workflowId,
		workflowRevision: input.workflowRevision,
		unitId: input.unitId,
		attempt: input.attempt,
		provenanceRef: input.provenanceRef,
		dispatchEnvelopeRef: input.dispatchEnvelopeRef,
		envelopeDigest: input.envelopeDigest,
		baseCommitSha: input.baseCommitSha,
		repositoryBindingDigest: input.repositoryBindingDigest,
		ledgerAuthorityRealmDigest: input.ledgerAuthorityRealmDigest,
		governedPacketDigest: input.governedPacketDigest,
		executionRole: input.executionRole,
		commitMode: input.commitMode,
		trustTier: input.trustTier,
		capabilityBundleDigest: input.capabilityBundleDigest,
		acceptanceContractDigest: input.acceptanceContractDigest,
		policyDigest: input.policyDigest,
		contextManifestDigest: input.contextManifestDigest,
		workerManifestDigest: input.workerManifestDigest,
		sandboxProfileDigest: input.sandboxProfileDigest,
		budget: Object.freeze({
			maxTokens: input.budget.maxTokens,
			maxComputeTimeMs: input.budget.maxComputeTimeMs,
		}),
		idempotencyKey: input.idempotencyKey,
		authorityActor: input.authorityActor,
		actionEvidenceVersion: input.actionEvidenceVersion,
		issuedAt: input.issuedAt,
		expiresAt: input.expiresAt,
	});
}

function captureCandidateActionEvidencePort(
	input: GovernedActionEvidencePort,
): CapturedGovernedCandidateActionEvidencePort {
	if (
		!input ||
		typeof input.recordActionRequested !== "function" ||
		typeof input.recordActionReceipt !== "function"
	) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_CREATION_FAILED",
			"Governed candidate creation requires durable action evidence before any Git effect.",
		);
	}
	return Object.freeze({
		recordActionRequested: input.recordActionRequested.bind(input),
		recordActionReceipt: input.recordActionReceipt.bind(input),
	});
}

/**
 * The candidate materialization effect is allowed only in a separate detached
 * linked worktree. In particular, a directory nested below the target root is
 * valid only when Git reports that nested directory as a distinct worktree
 * top-level; a normal target subdirectory is never an implementation overlay.
 *
 * This check intentionally performs only filesystem and pinned-Git reads. It
 * returns the canonical paths that later governed mutation code must use; raw
 * packet paths are never a post-await Git-write authority.
 */
function assertGovernedCandidateWorktreeTopology(
	runGit: GitCommandRunner,
	projectRootInput: string,
	candidatePathInput: string,
): VerifiedGovernedCandidateWorktreeTopology {
	const projectRoot = canonicalGovernedCandidateDirectory(
		projectRootInput,
		"projectRoot",
	);
	const candidatePath = canonicalGovernedCandidateDirectory(
		candidatePathInput,
		"candidate path",
	);
	if (projectRoot === candidatePath) {
		throw governedCandidateTopologyError(
			"candidate path resolves to the target projectRoot",
		);
	}

	const projectTopLevel = resolveGovernedGitTopologyDirectory(
		runGit,
		projectRoot,
		["rev-parse", "--show-toplevel"],
		"projectRoot Git top-level",
	);
	const candidateTopLevel = resolveGovernedGitTopologyDirectory(
		runGit,
		candidatePath,
		["rev-parse", "--show-toplevel"],
		"candidate Git top-level",
	);
	if (candidateTopLevel !== candidatePath) {
		throw governedCandidateTopologyError(
			"candidate path is an alias or subdirectory rather than its Git worktree top-level",
		);
	}
	if (candidateTopLevel === projectTopLevel) {
		throw governedCandidateTopologyError(
			"candidate and target resolve to the same Git worktree",
		);
	}

	const projectCommonDir = resolveGovernedGitTopologyDirectory(
		runGit,
		projectRoot,
		["rev-parse", "--git-common-dir"],
		"projectRoot Git common directory",
	);
	const candidateCommonDir = resolveGovernedGitTopologyDirectory(
		runGit,
		candidatePath,
		["rev-parse", "--git-common-dir"],
		"candidate Git common directory",
	);
	if (projectCommonDir !== candidateCommonDir) {
		throw governedCandidateTopologyError(
			"candidate does not share the target repository's Git common directory",
		);
	}

	const candidateGitDir = resolveGovernedGitTopologyDirectory(
		runGit,
		candidatePath,
		["rev-parse", "--git-dir"],
		"candidate Git directory",
	);
	if (!isLinkedWorktreeGitDirectory(projectCommonDir, candidateGitDir)) {
		throw governedCandidateTopologyError(
			"candidate Git directory is not a linked-worktree administrative directory",
		);
	}

	const symbolicHead = executeGitCommand(runGit, candidatePath, [
		"symbolic-ref",
		"-q",
		"HEAD",
	]);
	if (
		symbolicHead.error !== undefined ||
		symbolicHead.status !== 1 ||
		symbolicHead.stdout.trim().length !== 0
	) {
		throw governedCandidateTopologyError("candidate HEAD is not detached");
	}

	assertCandidateIsRegisteredDetachedWorktree(
		runGit,
		projectRoot,
		candidatePath,
	);
	return Object.freeze({
		projectRoot,
		candidatePath,
		projectCommonDir,
		candidateGitDir,
	});
}

/** Re-read topology/config after an awaited governed boundary. */
function assertGovernedCandidateTopologyRemainsPinned(input: {
	readonly runGit: GitCommandRunner;
	readonly expected: VerifiedGovernedCandidateWorktreeTopology;
}): VerifiedGovernedCandidateWorktreeTopology {
	const observed = assertGovernedCandidateWorktreeTopology(
		input.runGit,
		input.expected.projectRoot,
		input.expected.candidatePath,
	);
	if (
		observed.projectRoot !== input.expected.projectRoot ||
		observed.candidatePath !== input.expected.candidatePath ||
		observed.projectCommonDir !== input.expected.projectCommonDir ||
		observed.candidateGitDir !== input.expected.candidateGitDir
	) {
		throw governedCandidateTopologyError(
			"candidate worktree topology changed after a governed boundary",
		);
	}
	assertGovernedGitConfiguration(
		input.runGit,
		observed.projectRoot,
		observed.candidatePath,
	);
	return observed;
}

/**
 * The only governed path to the generic candidate primitive. It rechecks the
 * pinned topology immediately before the synchronous Git materialization and
 * uses the pre-await, verified canonical workspace input rather than a
 * caller-owned packet object.
 */
function materializeVerifiedGovernedWorkspaceCandidate(input: {
	readonly execution: GovernedCandidateExecutionContext;
	readonly runGit: GitCommandRunner;
	readonly now: () => string;
}): GitWorkspaceCandidate {
	const topology = assertGovernedCandidateTopologyRemainsPinned({
		runGit: input.runGit,
		expected: input.execution.topology,
	});
	const materializationInput = input.execution.materialization;
	if (
		materializationInput.path !== topology.candidatePath ||
		materializationInput.projectRoot !== topology.projectRoot
	) {
		throw governedCandidateTopologyError(
			"candidate materialization input no longer matches the pinned worktree topology",
		);
	}
	// Reuse the idempotent candidate-ref primitive only through a fresh adapter
	// whose Git runner is immutable, pinned, and scrubbed. The generic/raw path
	// never receives the signed packet's mutable workspace string or identity.
	return createGitWorktreeAdapter({
		runGit: input.runGit,
		now: input.now,
	}).createWorkspaceCandidate(materializationInput);
}

function canonicalGovernedCandidateDirectory(
	input: unknown,
	label: string,
): string {
	if (
		typeof input !== "string" ||
		input.length === 0 ||
		input.includes("\0") ||
		!isAbsolute(input)
	) {
		throw governedCandidateTopologyError(
			`${label} must be a non-empty absolute directory path`,
		);
	}
	let resolved: string;
	let canonical: string;
	try {
		resolved = resolve(input);
		canonical = realpathSync(resolved);
		if (!statSync(canonical).isDirectory()) {
			throw new Error("path is not a directory");
		}
	} catch (error) {
		throw governedCandidateTopologyError(
			`${label} cannot be resolved as an existing directory: ${errorMessage(error)}`,
		);
	}
	if (input !== resolved || resolved !== canonical) {
		throw governedCandidateTopologyError(
			`${label} is not a canonical real path; aliases are not permitted`,
		);
	}
	return canonical;
}

function resolveGovernedGitTopologyDirectory(
	runGit: GitCommandRunner,
	cwd: string,
	args: string[],
	label: string,
): string {
	const result = executeGitCommand(runGit, cwd, args);
	if (result.status !== 0 || result.error !== undefined) {
		throw governedCandidateTopologyError(
			`${label} could not be read: ${formatGitFailure(result)}`,
		);
	}
	const output = readSingleLineGitTopologyPath(result.stdout, label);
	const path = isAbsolute(output) ? output : resolve(cwd, output);
	try {
		const canonical = realpathSync(path);
		if (!statSync(canonical).isDirectory()) {
			throw new Error("path is not a directory");
		}
		return canonical;
	} catch (error) {
		throw governedCandidateTopologyError(
			`${label} does not resolve to an existing directory: ${errorMessage(error)}`,
		);
	}
}

function readSingleLineGitTopologyPath(output: string, label: string): string {
	const path = output.replace(/\r?\n$/, "");
	if (path.length === 0 || path.includes("\0") || path.includes("\n")) {
		throw governedCandidateTopologyError(
			`${label} returned an invalid filesystem path`,
		);
	}
	return path;
}

function isLinkedWorktreeGitDirectory(
	commonDir: string,
	candidateGitDir: string,
): boolean {
	const relativePath = relative(commonDir, candidateGitDir);
	if (
		relativePath.length === 0 ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		return false;
	}
	const [firstSegment, ...remainingSegments] = relativePath.split(/[\\/]+/);
	return firstSegment === "worktrees" && remainingSegments.length > 0;
}

function assertCandidateIsRegisteredDetachedWorktree(
	runGit: GitCommandRunner,
	projectRoot: string,
	candidatePath: string,
): void {
	const listing = executeGitCommand(runGit, projectRoot, [
		"worktree",
		"list",
		"--porcelain",
		"-z",
	]);
	if (listing.status !== 0 || listing.error !== undefined) {
		throw governedCandidateTopologyError(
			`target worktree registry could not be read: ${formatGitFailure(listing)}`,
		);
	}

	let matches = 0;
	let detached = false;
	let hasBranch = false;
	for (const record of listing.stdout.split("\0\0")) {
		if (record.length === 0) continue;
		const fields = record.split("\0");
		const worktreeField = fields.find((field) => field.startsWith("worktree "));
		if (worktreeField === undefined) {
			throw governedCandidateTopologyError(
				"target worktree registry contains an invalid record",
			);
		}
		const listedPath = worktreeField.slice("worktree ".length);
		if (listedPath.length === 0 || listedPath.includes("\n")) {
			throw governedCandidateTopologyError(
				"target worktree registry contains an invalid path",
			);
		}
		let canonicalListedPath: string;
		try {
			const resolvedPath = isAbsolute(listedPath)
				? listedPath
				: resolve(projectRoot, listedPath);
			canonicalListedPath = realpathSync(resolvedPath);
			if (!statSync(canonicalListedPath).isDirectory()) {
				throw new Error("path is not a directory");
			}
		} catch (error) {
			throw governedCandidateTopologyError(
				`target worktree registry path cannot be resolved: ${errorMessage(error)}`,
			);
		}
		if (canonicalListedPath !== candidatePath) continue;
		matches += 1;
		detached = fields.includes("detached");
		hasBranch = fields.some((field) => field.startsWith("branch "));
	}
	if (matches !== 1 || !detached || hasBranch) {
		throw governedCandidateTopologyError(
			"candidate is absent from the target's detached linked-worktree registry entry",
		);
	}
}

function governedCandidateTopologyError(
	reason: string,
): GitWorkspaceCandidateError {
	return new GitWorkspaceCandidateError(
		"CANDIDATE_WORKSPACE_TOPOLOGY_INVALID",
		`Governed candidate path must be a distinct detached linked Git worktree for the explicit projectRoot: ${reason}.`,
	);
}

function governedCandidateActionRequest(
	execution: GovernedCandidateExecutionContext,
	requestedAt: string,
): ActionRequestedV2 {
	const { dispatch, materialization } = execution;
	const identity = materialization;
	const candidateKey = candidateKeyFor(identity);
	const canonicalInputJson = JSON.stringify({
		schemaVersion: 1,
		action: "create-immutable-candidate",
		candidateId: identity.candidateId,
		runId: identity.runId,
		attempt: identity.attempt,
		candidateKey,
		candidateRef: candidateRefFor(identity),
		baseSha: materialization.baseSha,
	});
	const canonicalInputDigest = sha256Digest(canonicalInputJson);
	return {
		schemaVersion: 2,
		runId: identity.runId,
		workflowId: dispatch.workflowId,
		unitId: dispatch.unitId,
		attempt: identity.attempt,
		provenanceRef: dispatch.provenanceRef,
		actionId: `git-candidate-create:${candidateKey}`,
		idempotencyKey: `${dispatch.idempotencyKey}:git-candidate-create`,
		actionKind: "git",
		canonicalInputDigest,
		// The input is non-secret and deliberately self-contained. It lets a
		// future tape/CAS reader recompute the digest without depending on a
		// mutable workspace path.
		canonicalInputRef: `inline-json:${encodeURIComponent(canonicalInputJson)}`,
		dispatchEnvelopeDigest: dispatch.envelopeDigest,
		capabilityBundleDigest: dispatch.capabilityBundleDigest,
		policyDigest: dispatch.policyDigest,
		contextManifestDigest: dispatch.contextManifestDigest,
		workerManifestDigest: dispatch.workerManifestDigest,
		sandboxProfileDigest: dispatch.sandboxProfileDigest,
		repositoryBindingDigest: dispatch.repositoryBindingDigest,
		ledgerAuthorityRealmDigest: dispatch.ledgerAuthorityRealmDigest,
		governedPacketDigest: dispatch.governedPacketDigest,
		authorityActor: dispatch.authorityActor,
		executionRole: dispatch.executionRole,
		requestedAt,
	};
}

function governedCandidateSuccessReceipt(
	execution: GovernedCandidateExecutionContext,
	actionRequestDigest: string,
	candidate: GitWorkspaceCandidate,
	completedAt: string,
	wallTimeMs: number,
): RecordActionReceiptV2Input {
	const { dispatch, materialization } = execution;
	const candidateEvidence = canonicalCandidateEvidence(candidate);
	const candidateDigest = sha256Digest(candidateEvidence);
	return {
		schemaVersion: 2,
		runId: materialization.runId,
		workflowId: dispatch.workflowId,
		unitId: dispatch.unitId,
		attempt: materialization.attempt,
		provenanceRef: dispatch.provenanceRef,
		actionId: `git-candidate-create:${candidate.candidateKey}`,
		idempotencyKey: `${dispatch.idempotencyKey}:git-candidate-create`,
		actionRequestDigest,
		dispatchEnvelopeDigest: dispatch.envelopeDigest,
		capabilityBundleDigest: dispatch.capabilityBundleDigest,
		policyDigest: dispatch.policyDigest,
		contextManifestDigest: dispatch.contextManifestDigest,
		workerManifestDigest: dispatch.workerManifestDigest,
		sandboxProfileDigest: dispatch.sandboxProfileDigest,
		authorityActor: dispatch.authorityActor,
		executionRole: dispatch.executionRole,
		outcome: "succeeded",
		resultDigest: candidateDigest,
		resultRef: `git-ref:${candidate.candidateRef}`,
		evidenceDigest: candidateDigest,
		evidenceRef: `git-ref:${candidate.candidateRef}`,
		resourceUsage: { wallTimeMs },
		redactions: [],
		completedAt,
	};
}

function governedCandidateFailureReceipt(
	execution: GovernedCandidateExecutionContext,
	actionRequestDigest: string,
	error: unknown,
	completedAt: string,
	wallTimeMs: number,
): RecordActionReceiptV2Input {
	const { dispatch, materialization } = execution;
	const message = errorMessage(error);
	const messageDigest = sha256Digest(message);
	const code =
		error instanceof GitWorkspaceCandidateError
			? error.code
			: "GIT_CANDIDATE_CREATION_UNKNOWN";
	return {
		schemaVersion: 2,
		runId: materialization.runId,
		workflowId: dispatch.workflowId,
		unitId: dispatch.unitId,
		attempt: materialization.attempt,
		provenanceRef: dispatch.provenanceRef,
		actionId: `git-candidate-create:${candidateKeyFor(materialization)}`,
		idempotencyKey: `${dispatch.idempotencyKey}:git-candidate-create`,
		actionRequestDigest,
		dispatchEnvelopeDigest: dispatch.envelopeDigest,
		capabilityBundleDigest: dispatch.capabilityBundleDigest,
		policyDigest: dispatch.policyDigest,
		contextManifestDigest: dispatch.contextManifestDigest,
		workerManifestDigest: dispatch.workerManifestDigest,
		sandboxProfileDigest: dispatch.sandboxProfileDigest,
		authorityActor: dispatch.authorityActor,
		executionRole: dispatch.executionRole,
		outcome: "unknown",
		evidenceDigest: messageDigest,
		evidenceRef: `error:git-candidate-create:${messageDigest}`,
		resourceUsage: { wallTimeMs },
		redactions: [],
		failure: { code, messageDigest, retryable: false },
		completedAt,
	};
}

/**
 * Bind the native control surface once per candidate materialization. This
 * prevents caller-side property swaps from changing the authority writer
 * between the request, claim, result, and receipt steps.
 */
function captureCandidateActivityClaimPort(
	input: GovernedActivityClaimPort,
): GovernedActivityClaimPort {
	if (
		!input ||
		typeof input.claim !== "function" ||
		typeof input.recordResult !== "function"
	) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_CREATION_FAILED",
			"Governed candidate creation requires a native activity-claim port before any Git effect.",
		);
	}
	return Object.freeze({
		claim: input.claim.bind(input),
		recordResult: input.recordResult.bind(input),
	});
}

function requireGrantedCandidateActivityClaim(
	disposition: Awaited<ReturnType<GovernedActivityClaimPort["claim"]>>,
	actionRequest: ActionRequestedV2,
): GrantedGovernedActivityClaimV1 {
	if (disposition.state !== "granted") {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_CREATION_FAILED",
			`Governed candidate Git action was not granted a native activity lease: ${disposition.state}.`,
		);
	}
	if (
		disposition.activityId !== actionRequest.actionId ||
		disposition.idempotencyKey !== actionRequest.idempotencyKey ||
		requireNonEmptyString(
			disposition.claimEventId,
			"candidate Git activity claim event id",
		) !== disposition.claimEventId ||
		requireCanonicalDigest(
			disposition.claimEventDigest,
			"candidate Git activity claim event digest",
		) !== disposition.claimEventDigest ||
		requireNonEmptyString(
			disposition.leaseId,
			"candidate Git activity lease id",
		) !== disposition.leaseId
	) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_CREATION_FAILED",
			"Native activity claim did not bind the candidate Git action identity.",
		);
	}
	parseTimestamp(
		disposition.leaseExpiresAt,
		"candidate Git activity lease expiry",
	);
	return disposition;
}

function assertCandidateActivityClaimUnexpiredAt(
	claim: GrantedGovernedActivityClaimV1,
	observedAt: string,
): void {
	const observedAtMs = parseTimestamp(
		observedAt,
		"candidate Git activity observed time",
	);
	const leaseExpiresAtMs = parseTimestamp(
		claim.leaseExpiresAt,
		"candidate Git activity lease expiry",
	);
	if (observedAtMs >= leaseExpiresAtMs) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_CREATION_FAILED",
			"Native activity lease expired before candidate Git materialization could begin.",
		);
	}
}

async function recordGovernedCandidateActivityResult(input: {
	readonly execution: GovernedCandidateExecutionContext;
	readonly durableRequest: DurableActionRequestV2;
	readonly activityClaim: GrantedGovernedActivityClaimV1;
	readonly outcome: GovernedActivityResultOutcomeV1;
	readonly resultDigest: string | null;
	readonly resultRef: string | null;
	readonly evidenceDigest: string;
	readonly evidenceRef: string;
}): Promise<
	Extract<GovernedActivityResultDispositionV1, { readonly state: "recorded" }>
> {
	const result = await input.execution.activityClaimPort.recordResult({
		dispatch: input.execution.dispatch,
		durableRequest: input.durableRequest,
		claim: input.activityClaim,
		outcome: input.outcome,
		resultDigest: input.resultDigest,
		resultRef: input.resultRef,
		evidenceDigest: input.evidenceDigest,
		evidenceRef: input.evidenceRef,
	});
	if (
		result.state !== "recorded" ||
		result.resultOutcome !== input.outcome ||
		requireNonEmptyString(
			result.resultEventId,
			"candidate Git activity result event id",
		) !== result.resultEventId ||
		requireCanonicalDigest(
			result.resultEventDigest,
			"candidate Git activity result event digest",
		) !== result.resultEventDigest
	) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_CREATION_FAILED",
			"Native activity result did not terminally record the candidate Git action.",
		);
	}
	return result;
}

/**
 * Once candidate Git materialization may have started, pessimistically pin the
 * native activity to `unknown` before writing the matching unknown receipt.
 * If the terminal native write is indeterminate, no receipt is emitted: replay
 * must block or reconcile instead of accepting a receipt with no activity
 * result.
 */
async function recordUnknownGovernedCandidateActivityAndReceipt(input: {
	readonly execution: GovernedCandidateExecutionContext;
	readonly durableRequest: DurableActionRequestV2;
	readonly activityClaim: GrantedGovernedActivityClaimV1;
	readonly cause: unknown;
	readonly completedAt: string;
	readonly wallTimeMs: number;
}): Promise<void> {
	const receiptInput = governedCandidateFailureReceipt(
		input.execution,
		input.durableRequest.actionRequestDigest,
		input.cause,
		input.completedAt,
		input.wallTimeMs,
	);
	await recordGovernedCandidateActivityResult({
		execution: input.execution,
		durableRequest: input.durableRequest,
		activityClaim: input.activityClaim,
		outcome: "unknown",
		resultDigest: null,
		resultRef: null,
		evidenceDigest: receiptInput.evidenceDigest,
		evidenceRef: receiptInput.evidenceRef,
	});
	const durableReceipt =
		await input.execution.actionEvidencePort.recordActionReceipt(receiptInput);
	assertDurableCandidateActionReceipt(
		durableReceipt,
		input.durableRequest.actionRequest,
		"unknown",
	);
}

function requireCanonicalDigest(value: unknown, label: string): string {
	if (typeof value !== "string" || !CANONICAL_SHA256_DIGEST.test(value)) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_CREATION_FAILED",
			`${label} must be a canonical SHA-256 digest.`,
		);
	}
	return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_CREATION_FAILED",
			`${label} must be a non-empty string.`,
		);
	}
	return value;
}

function parseTimestamp(value: unknown, label: string): number {
	if (typeof value !== "string") {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_CREATION_FAILED",
			`${label} must be an RFC 3339 timestamp.`,
		);
	}
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_CREATION_FAILED",
			`${label} must be an RFC 3339 timestamp.`,
		);
	}
	return timestamp;
}

function canonicalCandidateEvidence(candidate: GitWorkspaceCandidate): string {
	return JSON.stringify({
		schemaVersion: candidate.schemaVersion,
		candidateId: candidate.candidateId,
		runId: candidate.runId,
		attempt: candidate.attempt,
		candidateKey: candidate.candidateKey,
		candidateRef: candidate.candidateRef,
		baseSha: candidate.baseSha,
		candidateCommitSha: candidate.candidateCommitSha,
		commitDigest: candidate.commitDigest,
		treeDigest: candidate.treeDigest,
		patchDigest: candidate.patchDigest,
		changedFilesDigest: candidate.changedFilesDigest,
		candidateDigest: candidate.candidateDigest,
	});
}

function sha256Digest(value: string): string {
	return `sha256:${sha256(value)}`;
}

function assertDurableCandidateActionRequest(
	result: DurableActionRequestV2,
	requested: ActionRequestedV2,
): void {
	if (
		result.actionRequest.actionId !== requested.actionId ||
		result.actionRequest.idempotencyKey !== requested.idempotencyKey ||
		result.actionRequest.runId !== requested.runId ||
		result.actionRequest.actionKind !== "git" ||
		result.actionRequest.governedPacketDigest !==
			requested.governedPacketDigest ||
		canonicalActionRequestedV2Digest(result.actionRequest) !==
			result.actionRequestDigest ||
		result.actionRequestDigest !==
			canonicalActionRequestedV2Digest(requested) ||
		!CANONICAL_SHA256_DIGEST.test(result.actionRequestDigest)
	) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_CREATION_FAILED",
			"Action evidence port returned a request that does not bind the candidate Git action.",
		);
	}
}

function assertDurableCandidateActionReceipt(
	result: DurableActionReceiptV2,
	requested: ActionRequestedV2,
	expectedOutcome: "succeeded" | "unknown" = "succeeded",
): void {
	if (
		result.receipt.actionId !== requested.actionId ||
		result.receipt.idempotencyKey !== requested.idempotencyKey ||
		result.receipt.runId !== requested.runId ||
		result.receipt.outcome !== expectedOutcome ||
		typeof result.receipt.actionReceiptRef !== "string" ||
		result.receipt.actionReceiptRef.length === 0 ||
		result.actionReceiptDigest !==
			canonicalActionReceiptRecordedV2Digest(result.receipt) ||
		!CANONICAL_SHA256_DIGEST.test(result.actionReceiptDigest)
	) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_CREATION_FAILED",
			"Action evidence port returned a receipt that does not bind the candidate Git action.",
		);
	}
}

function unknownGovernedCandidateEffectError(
	effect: unknown,
	receiptError: unknown,
): GitWorkspaceCandidateError {
	return new GitWorkspaceCandidateError(
		"CANDIDATE_CREATION_FAILED",
		`Governed candidate Git action reached an unknown effect state and requires reconciliation: ${errorMessage(effect)}; durable receipt error: ${errorMessage(receiptError)}.`,
	);
}

function validateCandidateIdentity(
	identity: GitWorkspaceCandidateIdentity,
): GitWorkspaceCandidateIdentity {
	if (
		typeof identity.candidateId !== "string" ||
		!CANDIDATE_ID_SEGMENT.test(identity.candidateId) ||
		typeof identity.runId !== "string" ||
		!CANDIDATE_ID_SEGMENT.test(identity.runId) ||
		!Number.isSafeInteger(identity.attempt) ||
		identity.attempt < 1 ||
		!isCanonicalBuildplaneCandidateRef(
			`refs/buildplane/candidates/${identity.candidateId}/${identity.runId}/${identity.attempt}`,
		)
	) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_INVALID_IDENTITY",
			"Candidate identity requires safe ref segments for candidateId/runId and a positive integer attempt.",
		);
	}
	return {
		candidateId: identity.candidateId,
		runId: identity.runId,
		attempt: identity.attempt,
	};
}

function candidateKeyFor(identity: GitWorkspaceCandidateIdentity): string {
	return `${identity.candidateId}/${identity.runId}/${identity.attempt}`;
}

function candidateRefFor(identity: GitWorkspaceCandidateIdentity): string {
	return `refs/buildplane/candidates/${candidateKeyFor(identity)}`;
}

function promotionReceiptRefFor(
	identity: GitWorkspaceCandidateIdentity,
): string {
	return `refs/buildplane/promotions/${candidateKeyFor(identity)}`;
}

function promotionReceiptRefForCandidate(
	candidate: GitWorkspaceCandidate,
): string {
	return promotionReceiptRefFor(validateCandidateIdentity(candidate));
}

function candidateCommitMessage(
	identity: GitWorkspaceCandidateIdentity,
): string {
	return `feat: buildplane candidate ${candidateKeyFor(identity)}`;
}

function candidatePromotionMessage(candidate: GitWorkspaceCandidate): string {
	return `feat: promote buildplane candidate ${candidate.candidateDigest}`;
}

function emptyCandidateDigestFields(): Pick<
	GitWorkspaceCandidate,
	| "commitDigest"
	| "treeDigest"
	| "patchDigest"
	| "changedFilesDigest"
	| "candidateDigest"
> {
	return {
		commitDigest: "",
		treeDigest: "",
		patchDigest: "",
		changedFilesDigest: "",
		candidateDigest: "",
	};
}

function resolveCommitOrThrow(
	runGit: GitCommandRunner,
	cwd: string,
	revision: string,
	code: GitWorkspaceCandidateErrorCode,
	label: string,
): string {
	const resolved = executeGitCommand(runGit, cwd, [
		"rev-parse",
		"--verify",
		"--quiet",
		`${revision}^{commit}`,
	]);
	if (resolved.status !== 0 || resolved.stdout.trim().length === 0) {
		throw new GitWorkspaceCandidateError(
			code,
			`Could not resolve ${label} ${revision}: ${formatGitFailure(resolved)}.`,
		);
	}
	return resolved.stdout.trim();
}

function resolveTreeOrThrow(
	runGit: GitCommandRunner,
	cwd: string,
	commitSha: string,
): string {
	const resolved = executeGitCommand(runGit, cwd, [
		"rev-parse",
		"--verify",
		"--quiet",
		`${commitSha}^{tree}`,
	]);
	if (resolved.status !== 0 || resolved.stdout.trim().length === 0) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_REF_MISMATCH",
			`Could not resolve candidate tree for ${commitSha}: ${formatGitFailure(resolved)}.`,
		);
	}
	return resolved.stdout.trim();
}

function resolveRefCommitOrNull(
	runGit: GitCommandRunner,
	cwd: string,
	ref: string,
): string | null {
	const resolved = executeGitCommand(runGit, cwd, [
		"rev-parse",
		"--verify",
		"--quiet",
		`${ref}^{commit}`,
	]);
	if (resolved.status !== 0 || resolved.stdout.trim().length === 0) {
		return null;
	}
	return resolved.stdout.trim();
}

function gitTextOrThrow(
	runGit: GitCommandRunner,
	cwd: string,
	args: string[],
	code: GitWorkspaceCandidateErrorCode,
	label: string,
): string {
	const result = executeGitCommand(runGit, cwd, args);
	if (result.status !== 0) {
		throw new GitWorkspaceCandidateError(
			code,
			`Could not read ${label}: ${formatGitFailure(result)}.`,
		);
	}
	return result.stdout;
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function emptyObjectId(runGit: GitCommandRunner, cwd: string): string {
	const format = gitTextOrThrow(
		runGit,
		cwd,
		["rev-parse", "--show-object-format"],
		"CANDIDATE_REF_MISMATCH",
		"repository object format",
	).trim();
	if (format === "sha1") return "0".repeat(40);
	if (format === "sha256") return "0".repeat(64);
	throw new GitWorkspaceCandidateError(
		"CANDIDATE_REF_MISMATCH",
		`Unsupported Git object format ${format} while creating a candidate ref.`,
	);
}

function deriveCandidateArtifact(
	runGit: GitCommandRunner,
	projectRoot: string,
	identity: GitWorkspaceCandidateIdentity,
	candidateRef: string,
	baseSha: string,
	candidateCommitSha: string,
): GitWorkspaceCandidate {
	const parent = resolveCommitOrThrow(
		runGit,
		projectRoot,
		`${candidateCommitSha}^`,
		"CANDIDATE_BASE_MISMATCH",
		"candidate parent",
	);
	if (parent !== baseSha) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_BASE_MISMATCH",
			`Candidate commit ${candidateCommitSha} parent ${parent} does not equal declared base ${baseSha}.`,
		);
	}
	const commitDigest = sha256(
		gitTextOrThrow(
			runGit,
			projectRoot,
			["cat-file", "commit", candidateCommitSha],
			"CANDIDATE_REF_MISMATCH",
			"candidate commit",
		),
	);
	const treeDigest = sha256(
		gitTextOrThrow(
			runGit,
			projectRoot,
			["ls-tree", "-r", "--full-tree", "-z", candidateCommitSha],
			"CANDIDATE_REF_MISMATCH",
			"candidate tree",
		),
	);
	const patchDigest = sha256(
		gitTextOrThrow(
			runGit,
			projectRoot,
			[
				"-c",
				"core.quotePath=false",
				"-c",
				"diff.algorithm=myers",
				"-c",
				"diff.mnemonicPrefix=false",
				"-c",
				"diff.noprefix=false",
				"diff",
				"--binary",
				"--full-index",
				"--no-ext-diff",
				"--no-textconv",
				"--no-renames",
				"--no-color",
				"--no-indent-heuristic",
				"--unified=3",
				baseSha,
				candidateCommitSha,
			],
			"CANDIDATE_REF_MISMATCH",
			"candidate patch",
		),
	);
	const changedFilesDigest = sha256(
		gitTextOrThrow(
			runGit,
			projectRoot,
			[
				"-c",
				"core.quotePath=false",
				"-c",
				"diff.algorithm=myers",
				"-c",
				"diff.mnemonicPrefix=false",
				"-c",
				"diff.noprefix=false",
				"diff",
				"--name-only",
				"-z",
				"--no-ext-diff",
				"--no-textconv",
				"--no-renames",
				"--no-color",
				baseSha,
				candidateCommitSha,
			],
			"CANDIDATE_REF_MISMATCH",
			"candidate changed files",
		),
	);
	const candidateDigest = sha256(
		JSON.stringify({
			schemaVersion: 1,
			candidateId: identity.candidateId,
			runId: identity.runId,
			attempt: identity.attempt,
			candidateRef,
			baseSha,
			candidateCommitSha,
			commitDigest,
			treeDigest,
			patchDigest,
			changedFilesDigest,
		}),
	);
	return {
		schemaVersion: 1,
		...identity,
		candidateKey: candidateKeyFor(identity),
		candidateRef,
		baseSha,
		candidateCommitSha,
		commitDigest,
		treeDigest,
		patchDigest,
		changedFilesDigest,
		candidateDigest,
	};
}

function deriveAndValidateCandidate(
	runGit: GitCommandRunner,
	projectRoot: string,
	candidate: GitWorkspaceCandidate,
	options?: { allowUnspecifiedDigests?: boolean },
): GitWorkspaceCandidate {
	if (candidate.schemaVersion !== 1) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_DIGEST_MISMATCH",
			`Unsupported candidate schema version ${String(candidate.schemaVersion)}.`,
		);
	}
	const identity = validateCandidateIdentity(candidate);
	const expectedKey = candidateKeyFor(identity);
	const expectedRef = candidateRefFor(identity);
	if (
		candidate.candidateKey !== expectedKey ||
		candidate.candidateRef !== expectedRef
	) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_REF_MISMATCH",
			`Candidate identity does not match durable ref ${expectedRef}.`,
		);
	}
	const baseSha = resolveCommitOrThrow(
		runGit,
		projectRoot,
		candidate.baseSha,
		"CANDIDATE_BASE_MISMATCH",
		"candidate base",
	);
	if (baseSha !== candidate.baseSha) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_BASE_MISMATCH",
			`Candidate base ${candidate.baseSha} is not a canonical commit identity.`,
		);
	}
	const refCommit = resolveRefCommitOrNull(runGit, projectRoot, expectedRef);
	if (refCommit === null || refCommit !== candidate.candidateCommitSha) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_REF_MISMATCH",
			`Candidate ref ${expectedRef} does not resolve to declared commit ${candidate.candidateCommitSha}.`,
		);
	}
	const candidateCommitSha = resolveCommitOrThrow(
		runGit,
		projectRoot,
		candidate.candidateCommitSha,
		"CANDIDATE_REF_MISMATCH",
		"candidate commit",
	);
	if (candidateCommitSha !== candidate.candidateCommitSha) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_REF_MISMATCH",
			`Candidate commit ${candidate.candidateCommitSha} is not a canonical commit identity.`,
		);
	}
	const derived = deriveCandidateArtifact(
		runGit,
		projectRoot,
		identity,
		expectedRef,
		baseSha,
		candidateCommitSha,
	);
	const suppliedDigests = [
		candidate.commitDigest,
		candidate.treeDigest,
		candidate.patchDigest,
		candidate.changedFilesDigest,
		candidate.candidateDigest,
	];
	const hasNoDigests = suppliedDigests.every((digest) => digest === "");
	if (options?.allowUnspecifiedDigests === true && hasNoDigests) {
		return derived;
	}
	if (
		suppliedDigests.some(
			(digest) => typeof digest !== "string" || !SHA256_HEX.test(digest),
		)
	) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_DIGEST_MISMATCH",
			"Candidate digest fields must all be canonical SHA-256 hex values.",
		);
	}
	if (
		candidate.commitDigest !== derived.commitDigest ||
		candidate.treeDigest !== derived.treeDigest ||
		candidate.patchDigest !== derived.patchDigest ||
		candidate.changedFilesDigest !== derived.changedFilesDigest ||
		candidate.candidateDigest !== derived.candidateDigest
	) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_DIGEST_MISMATCH",
			`Candidate ${candidate.candidateDigest} does not match the content addressed by ${expectedRef}.`,
		);
	}
	return derived;
}

function findExistingCandidatePromotionSha(
	runGit: GitCommandRunner,
	projectRoot: string,
	candidate: GitWorkspaceCandidate,
	targetRef: string,
): string | null {
	const log = executeGitCommand(runGit, projectRoot, [
		"log",
		"--format=%H%x09%P%x09%s",
		targetRef,
	]);
	if (log.status !== 0) return null;
	for (const line of log.stdout.split("\n")) {
		const [commitSha, parentList, subject] = line.split("\t", 3);
		if (
			commitSha &&
			parentList &&
			subject === candidatePromotionMessage(candidate) &&
			isExactCandidatePromotionCommit(runGit, projectRoot, commitSha, candidate)
		) {
			return commitSha;
		}
	}
	return null;
}

/**
 * Promotion is a target-branch mutation, so callers must supply the signed
 * target before the adapter asks Git which branch is currently checked out.
 * TypeScript catches normal callers; this guard protects JS and deserialized
 * callers that can omit the field at runtime.
 */
function requirePromotionTargetRef(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_TARGET_REF_REQUIRED",
			"Candidate promotion requires a signed canonical target ref.",
		);
	}
	return value;
}

/**
 * Governed promotion cannot infer a target from detached HEAD. Resolve the
 * actual checked-out branch once and use that ref for both history lookup and
 * the CAS; an arbitrary `HEAD` update would otherwise mutate a detached
 * worktree without a signed branch identity.
 */
function resolveTargetBranchRefOrThrow(
	runGit: GitCommandRunner,
	projectRoot: string,
): string {
	const symbolicRef = executeGitCommand(runGit, projectRoot, [
		"symbolic-ref",
		"-q",
		"HEAD",
	]);
	const targetRef = symbolicRef.stdout.trim();
	if (symbolicRef.status !== 0 || !isCanonicalTargetBranchRef(targetRef)) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_TARGET_REF_UNAVAILABLE",
			`Candidate promotion requires a checked-out canonical branch target: ${formatGitFailure(symbolicRef)}.`,
		);
	}
	return targetRef;
}

function isCanonicalTargetBranchRef(value: string): boolean {
	const branch = value.startsWith("refs/heads/")
		? value.slice("refs/heads/".length)
		: undefined;
	if (
		branch === undefined ||
		branch.length === 0 ||
		branch.endsWith("/") ||
		branch.endsWith(".") ||
		branch.endsWith(".lock") ||
		branch.includes("..") ||
		branch.includes("//") ||
		branch.includes("@{")
	) {
		return false;
	}
	return branch
		.split("/")
		.every(
			(component) =>
				component.length > 0 &&
				!component.startsWith(".") &&
				!component.endsWith(".") &&
				component !== "@" &&
				/^[A-Za-z0-9_.@-]+$/.test(component),
		);
}

interface CandidatePromotionMergeFacts {
	readonly mergedHeadSha: string;
	readonly mergeParentShas: readonly [string, string];
	readonly mergedTreeSha: string;
}

/** Immutable Git write-ahead anchor for a candidate promotion attempt. */
interface CandidatePromotionReceipt {
	readonly receiptRef: string;
	readonly mergeFacts: CandidatePromotionMergeFacts;
}

function promotionGitBindingFor(
	candidate: GitWorkspaceCandidate,
	targetRef: string,
	targetHeadAfterSha: string,
	facts: CandidatePromotionMergeFacts,
	worktreeSyncState: "pending_reconciliation" | "target_advanced",
): GitWorkspaceCandidatePromotionResult["promotionGitBinding"] {
	return {
		targetRef,
		targetHeadBeforeSha: candidate.baseSha,
		targetHeadAfterSha,
		mergedHeadSha: facts.mergedHeadSha,
		candidateCommitSha: candidate.candidateCommitSha,
		mergeParentShas: facts.mergeParentShas,
		mergedTreeSha: facts.mergedTreeSha,
		mergedTreeDigest: candidate.treeDigest,
		promotionReceiptRef: promotionReceiptRefForCandidate(candidate),
		worktreeSyncState,
	};
}

function readExactCandidatePromotionFactsOrThrow(
	runGit: GitCommandRunner,
	projectRoot: string,
	commitSha: string,
	candidate: GitWorkspaceCandidate,
): CandidatePromotionMergeFacts {
	const facts = readExactCandidatePromotionFacts(
		runGit,
		projectRoot,
		commitSha,
		candidate,
	);
	if (!facts) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_PROMOTION_FAILED",
			`Candidate ${candidate.candidateDigest} promotion did not create the expected merge commit ${commitSha}.`,
		);
	}
	return facts;
}

function isExactCandidatePromotionCommit(
	runGit: GitCommandRunner,
	projectRoot: string,
	commitSha: string,
	candidate: GitWorkspaceCandidate,
): boolean {
	return (
		readExactCandidatePromotionFacts(
			runGit,
			projectRoot,
			commitSha,
			candidate,
		) !== null
	);
}

function readExactCandidatePromotionFacts(
	runGit: GitCommandRunner,
	projectRoot: string,
	commitSha: string,
	candidate: GitWorkspaceCandidate,
): CandidatePromotionMergeFacts | null {
	const metadata = executeGitCommand(runGit, projectRoot, [
		"show",
		"-s",
		"--format=%P%x09%s",
		commitSha,
	]);
	if (metadata.status !== 0) return null;
	const [parentList, subject] = metadata.stdout.trim().split("\t", 2);
	const parents = parentList?.split(" ") ?? [];
	if (
		subject !== candidatePromotionMessage(candidate) ||
		parents.length !== 2 ||
		parents[0] !== candidate.baseSha ||
		parents[1] !== candidate.candidateCommitSha
	) {
		return null;
	}

	// Subject and parent identities are insufficient during recovery: any actor
	// can manufacture a merge with the same metadata but a different tree. The
	// candidate has already been content-validated before this probe, so require
	// the promotion object to carry that exact Git tree before returning its SHA
	// to the kernel as an idempotent promotion result.
	const promotionTree = executeGitCommand(runGit, projectRoot, [
		"rev-parse",
		"--verify",
		"--quiet",
		`${commitSha}^{tree}`,
	]);
	const candidateTree = executeGitCommand(runGit, projectRoot, [
		"rev-parse",
		"--verify",
		"--quiet",
		`${candidate.candidateCommitSha}^{tree}`,
	]);
	if (
		promotionTree.status === 0 &&
		candidateTree.status === 0 &&
		promotionTree.stdout.trim().length > 0 &&
		promotionTree.stdout.trim() === candidateTree.stdout.trim()
	) {
		return {
			mergedHeadSha: commitSha,
			mergeParentShas: [parents[0] as string, parents[1] as string],
			mergedTreeSha: promotionTree.stdout.trim(),
		};
	}
	return null;
}

function readPromotionReceiptOrThrow(
	runGit: GitCommandRunner,
	projectRoot: string,
	candidate: GitWorkspaceCandidate,
): CandidatePromotionReceipt | null {
	const receiptRef = promotionReceiptRefForCandidate(candidate);
	const receiptCommit = resolveRefCommitOrNull(runGit, projectRoot, receiptRef);
	if (receiptCommit === null) return null;
	const mergeFacts = readExactCandidatePromotionFacts(
		runGit,
		projectRoot,
		receiptCommit,
		candidate,
	);
	if (!mergeFacts) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_PROMOTION_FAILED",
			`Immutable promotion receipt ${receiptRef} conflicts with candidate ${candidate.candidateDigest}.`,
		);
	}
	return { receiptRef, mergeFacts };
}

/**
 * Reads the only durable proof that a candidate promotion already crossed the
 * target-ref CAS boundary. This deliberately does not search historical merge
 * messages or synthesize a receipt: recovery may observe an existing immutable
 * receipt, but it must never create a replacement proof or a new merge.
 */
function inspectExistingWorkspaceCandidatePromotionReceipt(
	runGit: GitCommandRunner,
	input: PromoteGitWorkspaceCandidateInput,
): GitWorkspaceCandidatePromotionInspectionResult | null {
	const signedTargetRef = requirePromotionTargetRef(input.targetRef);
	const candidate = deriveAndValidateCandidate(
		runGit,
		input.projectRoot,
		input.candidate,
	);
	const targetRef = resolveTargetBranchRefOrThrow(runGit, input.projectRoot);
	if (signedTargetRef !== targetRef) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_TARGET_REF_MISMATCH",
			`Candidate ${candidate.candidateDigest} is authorized for ${signedTargetRef}, but the checked-out target branch is ${targetRef}.`,
		);
	}
	const receipt = readPromotionReceiptOrThrow(
		runGit,
		input.projectRoot,
		candidate,
	);
	if (receipt === null) return null;
	const result = promotionResultFromReceipt(
		runGit,
		input.projectRoot,
		candidate,
		targetRef,
		receipt,
	);
	const { status, ...inspection } = result;
	if (status === "promoted") {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_PROMOTION_FAILED",
			"Read-only candidate promotion inspection cannot report a new promotion.",
		);
	}
	return { ...inspection, status };
}

function ensurePromotionReceiptOrThrow(
	runGit: GitCommandRunner,
	projectRoot: string,
	candidate: GitWorkspaceCandidate,
	mergeFacts: CandidatePromotionMergeFacts,
): CandidatePromotionReceipt {
	const receiptRef = promotionReceiptRefForCandidate(candidate);
	const existing = readPromotionReceiptOrThrow(runGit, projectRoot, candidate);
	if (existing) {
		if (existing.mergeFacts.mergedHeadSha !== mergeFacts.mergedHeadSha) {
			throw new GitWorkspaceCandidateError(
				"CANDIDATE_PROMOTION_FAILED",
				`Immutable promotion receipt ${receiptRef} already names a different candidate merge.`,
			);
		}
		return existing;
	}

	const createReceipt = executeGitCommand(runGit, projectRoot, [
		"update-ref",
		receiptRef,
		mergeFacts.mergedHeadSha,
		emptyObjectId(runGit, projectRoot),
	]);
	if (createReceipt.status === 0) {
		return { receiptRef, mergeFacts };
	}

	const raced = readPromotionReceiptOrThrow(runGit, projectRoot, candidate);
	if (raced && raced.mergeFacts.mergedHeadSha === mergeFacts.mergedHeadSha) {
		return raced;
	}
	if (raced) {
		throw new GitWorkspaceCandidateError(
			"CANDIDATE_PROMOTION_FAILED",
			`Immutable promotion receipt ${receiptRef} raced with a different candidate merge.`,
		);
	}
	throw new GitWorkspaceCandidateError(
		"CANDIDATE_PROMOTION_FAILED",
		`Could not retain immutable promotion receipt ${receiptRef}: ${formatGitFailure(createReceipt)}.`,
	);
}

function advancePromotionRefsAtomically(
	runGit: GitCommandRunner,
	projectRoot: string,
	targetRef: string,
	baseSha: string,
	receipt: CandidatePromotionReceipt,
): SpawnSyncReturns<string> {
	return executeGitCommand(
		runGit,
		projectRoot,
		["update-ref", "--stdin"],
		[
			"start",
			`update ${targetRef} ${receipt.mergeFacts.mergedHeadSha} ${baseSha}`,
			`create ${receipt.receiptRef} ${receipt.mergeFacts.mergedHeadSha}`,
			"prepare",
			"commit",
			"",
		].join("\n"),
	);
}

function promotionResultFromReceipt(
	runGit: GitCommandRunner,
	projectRoot: string,
	candidate: GitWorkspaceCandidate,
	targetRef: string,
	receipt: CandidatePromotionReceipt,
	statusWhenTargetContains:
		| "promoted"
		| "already_promoted" = "already_promoted",
): GitWorkspaceCandidatePromotionResult {
	const targetHeadAfterSha = resolveCommitOrThrow(
		runGit,
		projectRoot,
		targetRef,
		"CANDIDATE_PROMOTION_FAILED",
		"target HEAD while recovering candidate promotion",
	);
	const targetStillContainsMerge =
		targetHeadAfterSha === receipt.mergeFacts.mergedHeadSha ||
		isCommitAncestor(
			runGit,
			projectRoot,
			receipt.mergeFacts.mergedHeadSha,
			targetHeadAfterSha,
		);
	const worktreeSyncState = targetStillContainsMerge
		? "pending_reconciliation"
		: "target_advanced";
	return {
		status: targetStillContainsMerge
			? statusWhenTargetContains
			: "reconciliation_required",
		mergedHeadSha: receipt.mergeFacts.mergedHeadSha,
		candidateDigest: candidate.candidateDigest,
		promotionGitBinding: promotionGitBindingFor(
			candidate,
			targetRef,
			targetHeadAfterSha,
			receipt.mergeFacts,
			worktreeSyncState,
		),
	};
}

function isCommitAncestor(
	runGit: GitCommandRunner,
	projectRoot: string,
	ancestorSha: string,
	descendantSha: string,
): boolean {
	return (
		executeGitCommand(runGit, projectRoot, [
			"merge-base",
			"--is-ancestor",
			ancestorSha,
			descendantSha,
		]).status === 0
	);
}

function executeGitCommand(
	runGit: GitCommandRunner,
	cwd: string,
	args: string[],
	input?: string,
): SpawnSyncReturns<string> {
	const result = runGit(args, {
		cwd,
		encoding: "utf8",
		...(input === undefined ? {} : { input }),
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
