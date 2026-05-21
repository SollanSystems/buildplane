import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { makeForkFixture } from "./fixtures.js";

describe("fork --vcr fallback [Phase F]", () => {
	it("fails closed when parent tape is missing a deterministic tool match", async () => {
		const fixture = await makeForkFixture({
			forkArgs: ["--vcr"],
			parentPacket: {
				unit: {
					id: "u-parent-vcr-miss",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: { command: "node", args: ["-e", "console.log('parent')"] },
				verification: { requiredOutputs: [] },
			},
			forkPacket: {
				unit: {
					id: "u-fork-vcr-miss",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: { command: "node", args: ["-e", "console.log('fork')"] },
				verification: { requiredOutputs: [] },
			},
		});

		try {
			expect(fixture.forkExitCode).toBe(1);
			const db = new DatabaseSync(fixture.eventsDbPath, { readOnly: true });
			const rows = db
				.prepare(
					"SELECT payload FROM events WHERE run_id = ? AND kind = 'tool_result' ORDER BY id ASC",
				)
				.all(fixture.forkRunId) as { payload: string }[];
			db.close();
			const payloads = rows.map((row) => row.payload).join("\n");
			expect(payloads).toContain("VCR miss");
			expect(payloads).toContain('"policy":"fail"');
		} finally {
			await fixture.cleanup();
		}
	}, 60_000);

	it("re-executes on VCR miss only when explicitly requested", async () => {
		const fixture = await makeForkFixture({
			forkArgs: ["--vcr", "--vcr-miss", "reexecute"],
			parentPacket: {
				unit: {
					id: "u-parent-vcr-reexecute",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: { command: "node", args: ["-e", "console.log('parent')"] },
				verification: { requiredOutputs: [] },
			},
			forkPacket: {
				unit: {
					id: "u-fork-vcr-reexecute",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["vcr-reexecuted.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: {
					command: "node",
					args: [
						"-e",
						"require('fs').writeFileSync('vcr-reexecuted.txt', 'ok'); console.log('fork');",
					],
				},
				verification: { requiredOutputs: ["vcr-reexecuted.txt"] },
			},
		});

		try {
			expect(fixture.forkExitCode).toBe(0);
			expect(existsSync(join(fixture.dir, "vcr-reexecuted.txt"))).toBe(true);

			const db = new DatabaseSync(fixture.eventsDbPath, { readOnly: true });
			const rows = db
				.prepare(
					"SELECT payload FROM events WHERE run_id = ? AND kind = 'tool_result' ORDER BY id ASC",
				)
				.all(fixture.forkRunId) as { payload: string }[];
			db.close();
			expect(rows.map((row) => row.payload).join("\n")).toContain(
				'"policy":"reexecute"',
			);
		} finally {
			await fixture.cleanup();
		}
	}, 60_000);
});
