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
			expect(fixture.forkExitCode).toBe(0);
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
			const forkKinds = (
				db
					.prepare("SELECT kind FROM events WHERE run_id = ? ORDER BY id ASC")
					.all(fixture.forkRunId) as { kind: string }[]
			).map((r) => r.kind);
			expect(forkKinds).toContain("run_started");
			expect(forkKinds).toContain("run_completed");

			db.close();
		} finally {
			await fixture.cleanup();
		}
	}, 60_000);
});
