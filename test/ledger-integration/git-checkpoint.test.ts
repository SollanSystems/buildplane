import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, test } from "vitest";
import { makeBuildplaneRunFixture } from "./fixtures.js";

// Phase D: runPacket now emits execution-started / command-execution-complete
// on the cliEventBus, so the unit-boundary checkpoint hooks fire for sync
// command packets.  git_checkpoint events now appear in events.db.

describe("git-checkpoint", () => {
	it("produces git_checkpoint events for a sync command packet", async () => {
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
			expect(fixture.exitCode).toBe(0);

			const db = new DatabaseSync(fixture.eventsDbPath);
			const kinds = (
				db.prepare("SELECT kind FROM events ORDER BY id ASC").all() as {
					kind: string;
				}[]
			).map((r) => r.kind);

			// Run-lifecycle bookends.
			expect(kinds).toContain("run_started");
			expect(kinds).toContain("run_completed");

			// Unit-boundary events now fire (Phase D Task 1).
			expect(kinds).toContain("unit_started");
			expect(kinds).toContain("git_checkpoint");
			expect(kinds).toContain("unit_completed");

			db.close();
		} finally {
			await fixture.cleanup();
		}
	}, 30_000);

	test("[Phase D] produces a ref chain on refs/buildplane/run/<runId> without touching HEAD", async () => {
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
