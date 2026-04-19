import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { makeBuildplaneRunFixture } from "./fixtures.js";

// Phase D Task 2: the ledger-wrapped ToolRegistry is now threaded into the
// execution adapter (commandExecutor in run-cli).  run_command invocations for
// command packets flow through wrapToolRegistryForLedger, so tool_request and
// tool_result events appear in events.db in addition to the unit-boundary
// events that Task 1 added.

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

			// Task 2: tool_request + tool_result now appear because the wrapped
			// ToolRegistry is threaded into the commandExecutor in run-cli.
			// run_command is instrumented — every command packet emits these events.
			expect(kinds).toContain("tool_request");
			expect(kinds).toContain("tool_result");

			db.close();
		} finally {
			await fixture.cleanup();
		}
	}, 30_000);
});
