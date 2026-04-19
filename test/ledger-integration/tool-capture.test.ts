import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { makeBuildplaneRunFixture } from "./fixtures.js";

// Phase D: runPacket now emits execution-started / command-execution-complete
// on the event bus, so unit-boundary events (unit_started, git_checkpoint,
// unit_completed) fire for sync command packets via the cliEventBus subscriber
// in run-cli.  tool_request / workspace_write remain out of scope for Task 1
// (those require the instrumented ToolRegistry to be threaded into the
// command-execution adapter, which is Task 2 work).

describe("tool-capture", () => {
	it("captures run lifecycle events in events.db for a command packet", async () => {
		const fixture = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "unit-write",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["out.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: {
					command: "node",
					args: ["-e", "require('node:fs').writeFileSync('out.txt', 'hello');"],
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
