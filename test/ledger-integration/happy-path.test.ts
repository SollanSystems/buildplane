import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { makeLedgerFixture } from "./fixtures.js";

describe("happy path", () => {
	it("writes a 6-event run into events.db with causal chain", async () => {
		const fixture = await makeLedgerFixture();
		try {
			const runStartedId = "01919000-0000-7000-8000-000000000010";
			fixture.emitter.emit(
				"run_started",
				{
					RunStartedV1: {
						packet_hash: "sha256:aa",
						git_head: "deadbeef",
						workspace_path: fixture.dir,
						config: {},
						parent_run_id: null,
					},
				},
				{ id: runStartedId },
			);

			const unitStartedId = "01919000-0000-7000-8000-000000000011";
			fixture.emitter.emit(
				"unit_started",
				{
					UnitStartedV1: {
						unit_id: "u-1",
						parent_unit_id: null,
						unit_kind: "command",
						policy: {},
					},
				},
				{ parent: runStartedId, id: unitStartedId },
			);

			const toolReqId = "01919000-0000-7000-8000-000000000012";
			fixture.emitter.emit(
				"tool_request",
				{
					ToolRequestStoredV1: {
						tool_name: "shell",
						arguments: { cmd: "echo hi" },
						env: {
							redacted: true,
							hash: "sha256:aa",
							hint: "env_var",
						},
						working_directory: fixture.dir,
						unit_id: "u-1",
					},
				},
				{ parent: unitStartedId, id: toolReqId },
			);

			fixture.emitter.emit(
				"tool_result",
				{
					ToolResultV1: {
						tool_request_id: toolReqId,
						stdout: "hi\n",
						stderr: "",
						exit_code: 0,
						output: null,
						duration_ms: 10,
					},
				},
				{ parent: toolReqId },
			);

			fixture.emitter.emit(
				"unit_completed",
				{
					UnitCompletedV1: {
						unit_id: "u-1",
						outcome: "passed",
						artifacts: [],
					},
				},
				{ parent: unitStartedId },
			);

			fixture.emitter.emit(
				"run_completed",
				{
					RunCompletedV1: {
						outcome: "passed",
						duration_ms: 42,
						event_count: 6,
						unit_count: 1,
					},
				},
				{ parent: runStartedId },
			);

			await fixture.emitter.close();

			const db = new DatabaseSync(
				join(fixture.dir, ".buildplane", "ledger", "events.db"),
			);
			const rows = db
				.prepare("SELECT kind, parent_event_id FROM events ORDER BY id ASC")
				.all() as { kind: string; parent_event_id: string | null }[];

			expect(rows.map((r) => r.kind)).toEqual([
				"run_started",
				"unit_started",
				"tool_request",
				"tool_result",
				"unit_completed",
				"run_completed",
			]);
			expect(rows[0].parent_event_id).toBeNull();
			expect(rows[1].parent_event_id).toBe(runStartedId);
			expect(rows[2].parent_event_id).toBe(unitStartedId);
			expect(rows[3].parent_event_id).toBe(toolReqId);
			expect(rows[4].parent_event_id).toBe(unitStartedId);
			expect(rows[5].parent_event_id).toBe(runStartedId);
			db.close();
		} finally {
			await fixture.cleanup();
		}
	}, 30_000);
});
