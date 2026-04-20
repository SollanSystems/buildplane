import { gitInWorkspace, tryGitInWorkspace } from "./git-in-workspace.js";
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

type GitStep = "write-tree" | "commit-tree" | "update-ref";

/** Run a git checkpoint using plumbing commands.
 *
 * write-tree captures the index. commit-tree produces a commit without
 * running hooks or touching HEAD. update-ref advances only the buildplane
 * run ref. The user's branch is never modified.
 *
 * If any git step fails, emits a git_checkpoint event with
 * git_status: { kind: "failed", data: { error: "<step>: <message>" } }
 * and does NOT throw — checkpoints are advisory and shouldn't abort a run.
 *
 * The wire shape matches Rust's GitStatus serde-tagged union
 * (tag="kind", content="data"). The failing step is folded into the
 * error string since the Rust schema's Failed variant has only `error`.
 */
export function runGitCheckpoint(input: GitCheckpointInput): void {
	const reference = `refs/buildplane/run/${input.runId}`;
	let commitSha = "";
	let status: { kind: "ok" } | { kind: "failed"; data: { error: string } } = {
		kind: "ok",
	};

	let lastStep: GitStep = "write-tree";
	try {
		const tree = gitInWorkspace(input.cwd, ["write-tree"]).trim();

		lastStep = "commit-tree";
		const existing = tryGitInWorkspace(input.cwd, [
			"show-ref",
			"--hash",
			reference,
		]);
		const commitArgs = ["commit-tree", tree];
		if (existing) {
			commitArgs.push("-p", existing.trim());
		}
		const message = `buildplane/${input.runId}/${input.unitId}/${input.boundary}`;
		commitSha = gitInWorkspace(input.cwd, commitArgs, {
			input: message,
		}).trim();

		lastStep = "update-ref";
		gitInWorkspace(input.cwd, ["update-ref", reference, commitSha]);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		status = { kind: "failed", data: { error: `${lastStep}: ${message}` } };
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
