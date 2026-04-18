import { spawnSync } from "node:child_process";
import type { LedgerEventEmitter } from "./ledger-tool-wrapper.js";

export type CheckpointBoundary = "pre-unit" | "post-unit";

export interface GitCheckpointInput {
	boundary: CheckpointBoundary;
	runId: string;
	unitId: string;
	cwd: string;
	emitter: LedgerEventEmitter;
	parentEventId?: string;
}

function git(cwd: string, args: string[], stdin?: string): string {
	const r = spawnSync("git", ["-C", cwd, ...args], {
		input: stdin,
		encoding: "utf8",
	});
	if (r.status !== 0) {
		const msg = `git ${args.join(" ")} failed: ${r.stderr.trim()}`;
		throw new Error(msg);
	}
	return r.stdout.trim();
}

function maybeRef(cwd: string, ref: string): string | null {
	const r = spawnSync("git", ["-C", cwd, "show-ref", "--hash", ref], {
		encoding: "utf8",
	});
	return r.status === 0 ? r.stdout.trim() : null;
}

/** Run a git checkpoint using plumbing commands.
 *
 * write-tree captures the index. commit-tree produces a commit without
 * running hooks or touching HEAD. update-ref advances only the buildplane
 * run ref. The user's branch is never modified.
 *
 * If any git step fails, emits a git_checkpoint event with
 * git_status: { kind: "failed", error: "..." } and does NOT throw —
 * checkpoints are advisory and shouldn't abort a run.
 */
export function runGitCheckpoint(input: GitCheckpointInput): void {
	const reference = `refs/buildplane/run/${input.runId}`;
	let commitSha = "";
	let status: { kind: "ok" } | { kind: "failed"; error: string } = {
		kind: "ok",
	};

	try {
		const tree = git(input.cwd, ["write-tree"]);

		const existing = maybeRef(input.cwd, reference);
		const commitArgs = ["commit-tree", tree];
		if (existing) {
			commitArgs.push("-p", existing);
		}
		const message = `buildplane/${input.runId}/${input.unitId}/${input.boundary}`;
		commitSha = git(input.cwd, commitArgs, message);

		git(input.cwd, ["update-ref", reference, commitSha]);
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		status = { kind: "failed", error };
	}

	input.emitter.emit(
		"git_checkpoint",
		{
			GitCheckpointV1: {
				boundary: input.boundary,
				reference,
				commit_sha: commitSha,
				unit_id: input.unitId,
				git_status: status,
			},
		},
		{ parent: input.parentEventId },
	);
}
