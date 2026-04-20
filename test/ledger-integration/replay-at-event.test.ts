import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
	makeBuildplaneRunFixture,
	resolveNativeBinaryForLedgerTests,
} from "./fixtures.js";

const NATIVE_BIN = resolveNativeBinaryForLedgerTests();

describe("replay --at event", () => {
	it("fast-forwards to target event and emits state there", async () => {
		const fixture = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "unit-ff",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["a.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: { command: "sh", args: ["-c", "echo a > a.txt"] },
				verification: { requiredOutputs: ["a.txt"] },
			},
		});

		try {
			const db = new DatabaseSync(fixture.eventsDbPath);
			const runId = (
				db.prepare("SELECT DISTINCT run_id FROM events LIMIT 1").get() as {
					run_id: string;
				}
			).run_id;
			const targetRow = db
				.prepare(
					"SELECT id FROM events WHERE kind = 'unit_started' ORDER BY id ASC LIMIT 1",
				)
				.get() as { id: string } | undefined;
			db.close();

			if (!targetRow) {
				return;
			}
			const targetId = targetRow.id;

			const result = spawnSync(
				NATIVE_BIN,
				[
					"ledger",
					"replay",
					"--run-id",
					runId,
					"--workspace",
					fixture.dir,
					"--format",
					"json",
					"--at",
					targetId,
				],
				{ encoding: "utf8" },
			);
			expect(result.status).toBe(0);

			const lines = result.stdout.trim().split("\n").filter(Boolean);
			expect(lines.length).toBe(1);

			const step = JSON.parse(lines[0]);
			expect(step.event.id).toBe(targetId);
			expect(step.event.kind).toBe("unit_started");
			expect(step.state_after.current_unit).toBeDefined();
		} finally {
			await fixture.cleanup();
		}
	}, 30_000);

	it("non-existent target id exits non-zero", async () => {
		const fixture = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "unit-miss",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["out.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: { command: "sh", args: ["-c", "echo ok > out.txt"] },
				verification: { requiredOutputs: ["out.txt"] },
			},
		});

		try {
			const db = new DatabaseSync(fixture.eventsDbPath);
			const runId = (
				db.prepare("SELECT DISTINCT run_id FROM events LIMIT 1").get() as {
					run_id: string;
				}
			).run_id;
			db.close();

			const result = spawnSync(
				NATIVE_BIN,
				[
					"ledger",
					"replay",
					"--run-id",
					runId,
					"--workspace",
					fixture.dir,
					"--format",
					"json",
					"--at",
					"01919000-0000-7000-8000-ffffffffffff",
				],
				{ encoding: "utf8" },
			);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("not found");
		} finally {
			await fixture.cleanup();
		}
	}, 30_000);
});
