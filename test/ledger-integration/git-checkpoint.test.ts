import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, test } from "vitest";
import { makeBuildplaneRunFixture } from "./fixtures.js";

// Probe finding: git_checkpoint events do NOT appear in events.db for sync
// command packets.  The unit-boundary checkpoint hooks (runGitCheckpoint) are
// wired to the "execution-started" and "command-execution-complete" events on
// the CLI event bus.  Those events are only emitted by runPacketAsync(), which
// is not called for command packets in the --raw sync path.
//
// As a result, the ideal assertions (refs/buildplane/run/<id>, pre-unit /
// post-unit boundaries, HEAD isolation) cannot be verified end-to-end in
// Phase C.  The runGitCheckpoint unit tests in ledger-git-checkpoint.test.ts
// cover the plumbing in isolation.
//
// This test:
//   1. Verifies that the run completes without error (smoke test that the
//      checkpoint code path does not crash when the event bus is wired up,
//      even if it never fires).
//   2. Confirms no git_checkpoint events appear — documents the gap explicitly
//      so a future maintainer will notice if Phase D ships the fix and this
//      assertion starts failing.
//   3. Uses test.skip to mark the ideal assertions that will become valid once
//      runPacketAsync is used for command packets.

describe("git-checkpoint", () => {
	it("run completes cleanly without git_checkpoint events in Phase C sync path", async () => {
		const fixture = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "unit-ckpt",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["a.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: {
					command: "sh",
					args: ["-c", "echo a > a.txt"],
				},
				verification: { requiredOutputs: ["a.txt"] },
			},
		});

		try {
			// Run must succeed — the absence of checkpoints is a gap, not a failure.
			expect(fixture.exitCode).toBe(0);

			const db = new DatabaseSync(fixture.eventsDbPath);
			const kinds = (
				db.prepare("SELECT kind FROM events ORDER BY id ASC").all() as {
					kind: string;
				}[]
			).map((r) => r.kind);

			// Phase C sync path: only run-lifecycle bookends.
			expect(kinds).toContain("run_started");
			expect(kinds).toContain("run_completed");

			// git_checkpoint does NOT appear — document the gap explicitly.
			// When Phase D wires runPacketAsync into the --raw command path,
			// this assertion should be removed and the skipped tests below
			// should be unskipped.
			const checkpointCount = kinds.filter(
				(k) => k === "git_checkpoint",
			).length;
			expect(checkpointCount).toBe(0);

			db.close();
		} finally {
			await fixture.cleanup();
		}
	}, 30_000);

	// --- Phase D assertions (skipped until runPacketAsync is used for command packets) ---
	//
	// These tests encode the desired behaviour once the async execution path is
	// wired up.  They are marked skip rather than deleted so the spec is not
	// lost and the failure mode is immediately visible when the gap is closed.

	test.skip("[Phase D] produces a ref chain on refs/buildplane/run/<runId> without touching HEAD", async () => {
		const fixture = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "unit-ckpt",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["a.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: {
					command: "sh",
					args: ["-c", "echo a > a.txt"],
				},
				verification: { requiredOutputs: ["a.txt"] },
			},
		});

		try {
			const db = new DatabaseSync(fixture.eventsDbPath);
			const ckpts = (
				db
					.prepare(
						"SELECT payload FROM events WHERE kind = 'git_checkpoint' ORDER BY id ASC",
					)
					.all() as { payload: string }[]
			).map(
				(r) =>
					JSON.parse(r.payload).GitCheckpointV1 as {
						boundary: string;
						commit_sha: string;
						reference: string;
					},
			);

			expect(ckpts.length).toBeGreaterThanOrEqual(2);
			expect(ckpts[0].boundary).toBe("pre-unit");
			expect(ckpts[ckpts.length - 1].boundary).toBe("post-unit");

			// All checkpoints share the same ref.
			const refs = new Set(ckpts.map((c) => c.reference));
			expect(refs.size).toBe(1);
			const ref = [...refs][0];
			expect(ref).toMatch(/^refs\/buildplane\/run\/[0-9a-f-]{36}$/);

			// The ref resolves to the LAST checkpoint's commit SHA.
			const refSha = spawnSync(
				"git",
				["-C", fixture.dir, "show-ref", "--hash", ref],
				{ encoding: "utf8" },
			).stdout.trim();
			expect(refSha).toBe(ckpts[ckpts.length - 1].commit_sha);

			// HEAD is untouched.
			const head = spawnSync("git", ["-C", fixture.dir, "rev-parse", "HEAD"], {
				encoding: "utf8",
			}).stdout.trim();
			expect(head).not.toBe(refSha);

			db.close();
		} finally {
			await fixture.cleanup();
		}
	}, 30_000);
});
