import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { makeBuildplaneRunFixture } from "./fixtures.js";

// Shape B — tool_request/tool_result/workspace_write NOT captured for command packets.
//
// Probe result (see probe script in task brief): running a simple command packet
// through makeBuildplaneRunFixture (--raw path, sync orchestrator.runPacket)
// produces exactly ["run_started", "run_completed"].
//
// Why: Phase C's wrapToolRegistryForLedger instruments write_file / run_command
// TOOL calls, but the command-packet execution path in the kernel uses the sync
// runPacket() method which never emits "execution-started" on the event bus.
// The event-bus subscription that would fire unit_started / git_checkpoint /
// unit_completed only runs in runPacketAsync(), which is only used for model
// packets and TUI mode.  The sync path emits run_started + run_completed
// directly on the ledger emitter, but nothing else.
//
// Additionally, the ToolRegistry wrapper is created but the underlying runtime
// executePacket() dispatches command packets directly through the process-spawn
// adapter — it does NOT route through any ToolRegistry method.  tool_request,
// tool_result, and workspace_write therefore never reach the ledger.
//
// Phase D will thread the instrumented registry into the execution adapter and
// switch the raw sync path to use runPacketAsync so that unit-boundary events
// fire.  Until then, this test exercises what Phase C CAN capture end-to-end:
// the run-level lifecycle events (run_started + run_completed).

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

			// Run-lifecycle events are always present — these come from direct
			// ledgerEmitter.emit() calls in the raw path, not from the event bus.
			expect(kinds).toContain("run_started");
			expect(kinds).toContain("run_completed");

			// run_started must be the first event; run_completed must be the last.
			expect(kinds[0]).toBe("run_started");
			expect(kinds[kinds.length - 1]).toBe("run_completed");

			// Phase C unit-boundary events (unit_started, git_checkpoint,
			// unit_completed) do NOT appear in the tape for sync command packets
			// because runPacket() never fires "execution-started" on the event bus.
			// Phase D is expected to address this gap.

			// tool_request / tool_result / workspace_write do NOT appear because
			// command dispatch bypasses the ToolRegistry wrapper entirely.

			db.close();
		} finally {
			await fixture.cleanup();
		}
	}, 30_000);
});
