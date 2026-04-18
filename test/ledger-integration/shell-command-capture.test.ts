import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { makeBuildplaneRunFixture } from "./fixtures.js";

// Shape B — realistic assertions based on probe findings.
//
// Probe result: a shell command packet run through the --raw path produces
// ["run_started", "run_completed"] in events.db.  git_checkpoint events do NOT
// appear because the sync runPacket() path never fires "execution-started" on
// the event bus, so the pre/post-unit checkpoint hooks are never called.
//
// workspace_write also does not appear: shell side effects (files written by
// the "sh -c" subprocess) bypass the ToolRegistry wrapper entirely — the
// process-spawn adapter in the kernel dispatches command packets directly.
//
// What Phase C CAN capture for a shell packet: the run-lifecycle bookends.
// This test asserts exactly that — no more, no less.  Phase D will add the
// git-tree and workspace_write assertions once the async execution path and
// instrumented registry are wired together.

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

			// Run-lifecycle events are always present — emitted directly via
			// ledgerEmitter.emit() in the raw path.
			expect(kinds).toContain("run_started");
			expect(kinds).toContain("run_completed");

			expect(kinds[0]).toBe("run_started");
			expect(kinds[kinds.length - 1]).toBe("run_completed");

			// git_checkpoint does NOT appear: the sync runPacket() path does not
			// emit "execution-started" on the event bus, so the unit-boundary
			// checkpoint hooks never fire.  Phase D will address this gap.

			// workspace_write does NOT appear: shell side effects bypass the
			// ToolRegistry wrapper (command packets dispatch via process spawn, not
			// through ToolRegistry methods).

			db.close();
		} finally {
			await fixture.cleanup();
		}
	}, 30_000);
});
