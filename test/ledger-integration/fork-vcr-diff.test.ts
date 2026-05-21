import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { makeForkFixture } from "./fixtures.js";

describe("fork --vcr diff [Phase F]", () => {
	it("matches deterministic tool-call equivalence across fork unit ids", async () => {
		const execution = {
			command: "node",
			args: ["-e", "console.log(JSON.stringify({ok:true, source:'parent'}))"],
		};
		const fixture = await makeForkFixture({
			forkArgs: ["--vcr"],
			parentPacket: {
				unit: {
					id: "u-parent-vcr-canonical",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution,
				verification: { requiredOutputs: [] },
			},
			forkPacket: {
				unit: {
					id: "u-fork-vcr-canonical",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution,
				verification: { requiredOutputs: [] },
			},
		});

		try {
			expect(
				fixture.forkExitCode,
				`${fixture.forkStdout}\n${fixture.forkStderr}`,
			).toBe(0);
			const db = new DatabaseSync(fixture.eventsDbPath, { readOnly: true });
			const row = db
				.prepare(
					"SELECT payload FROM events WHERE run_id = ? AND kind = 'tool_result' ORDER BY id DESC LIMIT 1",
				)
				.get(fixture.forkRunId) as { payload: string };
			db.close();

			const payload = JSON.parse(row.payload) as {
				ToolResultV1: { stdout: string; output?: { vcr?: string } };
			};
			expect(payload.ToolResultV1.output?.vcr).toBe("hit");
			expect(payload.ToolResultV1.stdout).toContain('"source":"parent"');
		} finally {
			await fixture.cleanup();
		}
	}, 60_000);
});
