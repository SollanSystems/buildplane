import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { makeBuildplaneRunFixture } from "./fixtures.js";

describe("tape-capture end-to-end", () => {
	it("command packet produces the full Phase A event sequence", async () => {
		const fixture = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "unit-e2e",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["out.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: {
					command: "sh",
					args: ["-c", "echo hello > out.txt"],
				},
				verification: { requiredOutputs: ["out.txt"] },
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

			expect(kinds).toContain("run_started");
			expect(kinds).toContain("unit_started");
			expect(kinds).toContain("git_checkpoint");
			expect(kinds).toContain("unit_completed");
			expect(kinds).toContain("run_completed");

			// Pre + post checkpoints at minimum.
			const checkpointCount = kinds.filter(
				(k) => k === "git_checkpoint",
			).length;
			expect(checkpointCount).toBeGreaterThanOrEqual(2);

			db.close();
		} finally {
			await fixture.cleanup();
		}
	}, 30_000);
});
