const fs = require("fs");
let code = fs.readFileSync("packages/kernel/src/orchestrator.ts", "utf8");

// Replace workspace cleanup for passing runs with a commit-and-merge
const target1 = `			let cleanupResult: { deleted: boolean; cleanupError?: string };
			try {
				cleanupResult = workspace.deleteWorkspace({
					path: preparedWorkspace.path,
				});
			} catch (error) {
				cleanupResult = {
					deleted: false,
					cleanupError: error instanceof Error ? error.message : String(error),
				};
			}
			if (!cleanupResult.deleted) {`;

const replacement1 = `			let cleanupResult: { deleted: boolean; cleanupError?: string };
			try {
				if (decision.outcome === "approved" && workspace.commitAndMergeWorkspace) {
					workspace.commitAndMergeWorkspace({ path: preparedWorkspace.path, runId: run.id });
				}
				cleanupResult = workspace.deleteWorkspace({
					path: preparedWorkspace.path,
				});
			} catch (error) {
				cleanupResult = {
					deleted: false,
					cleanupError: error instanceof Error ? error.message : String(error),
				};
			}
			if (!cleanupResult.deleted) {`;

// Replace async path cleanup
const target2 = `			/** Clean up the workspace; errors are emitted but don't override the primary result. */
			async function cleanupWorkspace(): Promise<void> {
				try {
					workspace.deleteWorkspace({ path: worktreeRoot });
					storage.recordWorkspaceDeleted(run.id);`;

const replacement2 = `			/** Clean up the workspace; errors are emitted but don't override the primary result. */
			async function cleanupWorkspace(mergeBack = false): Promise<void> {
				try {
					if (mergeBack && workspace.commitAndMergeWorkspace) {
						workspace.commitAndMergeWorkspace({ path: worktreeRoot, runId: run.id });
					}
					workspace.deleteWorkspace({ path: worktreeRoot });
					storage.recordWorkspaceDeleted(run.id);`;

// Pass true to cleanupWorkspace on advance-run
const target3 = `					if (decision.kind === "advance-run") {
						completedRun = storage.commitRunSuccessOutcome(run.id, decision);
					} else {
						completedRun = storage.commitRunFailureOutcome(run.id, {
							decision,
							workspaceStatus: "retained",
						});
					}
					const finalStatus =
						decision.outcome === "approved" ? "passed" : "failed";

					bus.emit({
						kind: "run-completed",
						runId: run.id,
						unitId: currentPacket.unit.id,
						timestamp: new Date().toISOString(),
						status: finalStatus as "passed" | "failed",
					});

					await cleanupWorkspace();`;

const replacement3 = `					if (decision.kind === "advance-run") {
						completedRun = storage.commitRunSuccessOutcome(run.id, decision);
					} else {
						completedRun = storage.commitRunFailureOutcome(run.id, {
							decision,
							workspaceStatus: "retained",
						});
					}
					const finalStatus =
						decision.outcome === "approved" ? "passed" : "failed";

					bus.emit({
						kind: "run-completed",
						runId: run.id,
						unitId: currentPacket.unit.id,
						timestamp: new Date().toISOString(),
						status: finalStatus as "passed" | "failed",
					});

					await cleanupWorkspace(decision.kind === "advance-run");`;

code = code.replace(target1, replacement1);
code = code.replace(target2, replacement2);
code = code.replace(target3, replacement3);

fs.writeFileSync("packages/kernel/src/orchestrator.ts", code);
