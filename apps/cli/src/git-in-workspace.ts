import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

export interface GitInWorkspaceOptions {
	/** Data piped to git's stdin. Useful for e.g. `commit-tree` taking its message. */
	input?: string;
}

/** Run `git -C <workspace> ...args`. The workspace path must be absolute;
 * never falls back to `process.cwd()`. Throws on non-zero exit.
 *
 * This helper centralizes every git invocation in run-path code to prevent
 * the class of bug where `process.cwd()` drift pollutes the wrong directory
 * (see Phase B smoke-test pollution on feat/ledger-phase-a and
 * feat/ledger-phase-b-clean).
 */
export function gitInWorkspace(
	workspace: string,
	args: string[],
	opts: GitInWorkspaceOptions = {},
): string {
	if (!isAbsolute(workspace)) {
		throw new Error(
			`gitInWorkspace requires an absolute workspace path; got: ${workspace}`,
		);
	}
	const r = spawnSync("git", ["-C", workspace, ...args], {
		input: opts.input,
		encoding: "utf8",
	});
	if (r.status !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed (cwd=${workspace}): ${r.stderr.trim()}`,
		);
	}
	return r.stdout;
}

/** Fail-clean variant: returns null if the git command fails. Use for probing
 * (e.g., `show-ref` to check whether a ref exists).
 */
export function tryGitInWorkspace(
	workspace: string,
	args: string[],
): string | null {
	if (!isAbsolute(workspace)) {
		throw new Error(
			`tryGitInWorkspace requires an absolute workspace path; got: ${workspace}`,
		);
	}
	const r = spawnSync("git", ["-C", workspace, ...args], { encoding: "utf8" });
	return r.status === 0 ? r.stdout : null;
}
