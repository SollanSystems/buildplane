import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { makeBuildplaneRunFixture } from "./fixtures.js";

// Phase D: runPacket now emits execution-started / command-execution-complete
// on the event bus, so unit-boundary events (unit_started, git_checkpoint,
// unit_completed) now fire for sync command packets.  workspace_write remains
// out of scope for Task 1.

describe("shell-command-capture", () => {
	it("captures run lifecycle events for a shell command packet", async () => {
		const fixture = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "unit-shell",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["shell-out.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: {
					command: "sh",
					args: ["-c", "echo hi > shell-out.txt"],
				},
				verification: { requiredOutputs: ["shell-out.txt"] },
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

			// Unit-boundary events now fire because runPacket emits execution-started
			// and command-execution-complete on the cliEventBus (Phase D Task 1).
			expect(kinds).toContain("unit_started");
			expect(kinds).toContain("git_checkpoint");
			expect(kinds).toContain("unit_completed");

			db.close();
		} finally {
			await fixture.cleanup();
		}
	}, 30_000);
});
