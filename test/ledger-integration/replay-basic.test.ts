import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
	makeLegacyReplayTapeFixture,
	resolveNativeBinaryForLedgerTests,
} from "./fixtures.js";

const NATIVE_BIN = resolveNativeBinaryForLedgerTests();

describe("replay basic", () => {
	it("streams one JSON line per event with hydrated state from an unsigned legacy tape", async () => {
		const fixture = await makeLegacyReplayTapeFixture();

		try {
			const db = new DatabaseSync(fixture.eventsDbPath, { readOnly: true });
			const expectedCount = (
				db.prepare("SELECT COUNT(*) as c FROM events").get() as { c: number }
			).c;
			const signatureCount = (
				db.prepare("SELECT COUNT(*) as c FROM event_signatures").get() as {
					c: number;
				}
			).c;
			db.close();
			expect(signatureCount).toBe(0);

			const result = spawnSync(
				NATIVE_BIN,
				[
					"ledger",
					"replay",
					"--run-id",
					fixture.runId,
					"--workspace",
					fixture.dir,
					"--format",
					"json",
				],
				{ encoding: "utf8", cwd: process.cwd() },
			);
			expect(result.status).toBe(0);

			const lines = result.stdout.trim().split("\n").filter(Boolean);
			expect(lines.length).toBe(expectedCount);

			for (const line of lines) {
				const step = JSON.parse(line);
				expect(step.event).toBeDefined();
				expect(step.event.id).toMatch(/^[0-9a-f-]{36}$/);
				expect(step.state_after).toBeDefined();
				expect(step.state_after.parent_chain).toBeInstanceOf(Array);
			}

			const lastStep = JSON.parse(lines[lines.length - 1]);
			if (lastStep.event.kind === "run_completed") {
				expect(lastStep.state_after.parent_chain.length).toBe(0);
			}
		} finally {
			await fixture.cleanup();
		}
	}, 30_000);
});
