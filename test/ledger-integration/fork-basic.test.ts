import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { makeForkFixture } from "./fixtures.js";

describe("fork basic", () => {
	it("re-executes with a new packet and preserves parent_run_id lineage", async () => {
		const fixture = await makeForkFixture({
			parentPacket: {
				unit: {
					id: "u-parent",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["parent.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: { command: "sh", args: ["-c", "echo parent > parent.txt"] },
				verification: { requiredOutputs: ["parent.txt"] },
			},
			forkPacket: {
				unit: {
					id: "u-fork",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["fork.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: { command: "sh", args: ["-c", "echo fork > fork.txt"] },
				verification: { requiredOutputs: ["fork.txt"] },
			},
		});

		try {
			expect(
				fixture.forkExitCode,
				`${fixture.forkStdout}\n${fixture.forkStderr}`,
			).toBe(0);
			expect(fixture.forkStdout).toContain("governance: unsafe");
			expect(fixture.forkStdout).toContain("trusted-receipt: false");
			expect(fixture.forkRunId).not.toBe("");
			expect(fixture.forkRunId).not.toBe(fixture.parentRunId);

			const db = new DatabaseSync(fixture.eventsDbPath);

			// Verify lineage: fork's run_started has parent_run_id == parent.
			const row = db
				.prepare(
					"SELECT payload FROM events WHERE run_id = ? AND kind = 'run_started' LIMIT 1",
				)
				.get(fixture.forkRunId) as { payload: string };
			const payload = JSON.parse(row.payload) as {
				RunStartedV1: { parent_run_id: string | null };
			};
			expect(payload.RunStartedV1.parent_run_id).toBe(fixture.parentRunId);

			// Verify fork tape has the full Phase A sequence.
			const forkRows = db
				.prepare(
					"SELECT kind, payload FROM events WHERE run_id = ? ORDER BY id ASC",
				)
				.all(fixture.forkRunId) as { kind: string; payload: string }[];
			const forkKinds = forkRows.map((row) => row.kind);
			expect(forkKinds).toContain("run_started");
			expect(forkKinds).toContain("run_completed");
			expect(forkKinds).toContain("unit_started");
			expect(forkKinds).toContain("unit_completed");
			expect(forkKinds).toContain("git_checkpoint");
			const checkpointBoundaries = forkRows
				.filter((row) => row.kind === "git_checkpoint")
				.map(
					(row) =>
						(
							JSON.parse(row.payload) as {
								GitCheckpointV1: { boundary: string };
							}
						).GitCheckpointV1.boundary,
				);
			expect(checkpointBoundaries).toContain("pre-unit");
			expect(checkpointBoundaries).toContain("post-unit");
			const signatureCount = (
				db
					.prepare(
						"SELECT COUNT(*) AS count FROM event_signatures AS signatures INNER JOIN events AS event ON event.id = signatures.event_id WHERE event.run_id = ?",
					)
					.get(fixture.forkRunId) as { count: number }
			).count;
			expect(signatureCount).toBe(0);

			db.close();

			// The unsafe fork runs in its own detached worktree. Its root caller
			// remains byte-for-byte untouched even when the child writes output.
			const { existsSync, readFileSync } = await import("node:fs");
			const { join } = await import("node:path");
			expect(fixture.forkWorkspace).not.toBe("");
			expect(existsSync(join(fixture.dir, "fork.txt"))).toBe(false);
			const forkOutputPath = join(fixture.forkWorkspace, "fork.txt");
			expect(existsSync(forkOutputPath)).toBe(true);
			expect(readFileSync(forkOutputPath, "utf8").trim()).toBe("fork");

			// The child receives a fresh storage projection keyed to its own absolute
			// root. Reusing the parent's state.db would either fail initialization or
			// couple isolated fork state back to the caller workspace.
			const parentState = new DatabaseSync(
				join(fixture.dir, ".buildplane", "state.db"),
				{ readOnly: true },
			);
			const childState = new DatabaseSync(
				join(fixture.forkWorkspace, ".buildplane", "state.db"),
				{ readOnly: true },
			);
			try {
				const parentProject = parentState
					.prepare("SELECT project_root FROM projects LIMIT 1")
					.get() as { project_root: string };
				const childProject = childState
					.prepare("SELECT project_root FROM projects LIMIT 1")
					.get() as { project_root: string };
				expect(parentProject.project_root).toBe(fixture.dir);
				expect(childProject.project_root).toBe(fixture.forkWorkspace);
			} finally {
				parentState.close();
				childState.close();
			}
		} finally {
			await fixture.cleanup();
		}
	}, 60_000);
});
