import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	makeLegacyReplayTapeFixture,
	resolveNativeBinaryForLedgerTests,
} from "./fixtures.js";

const NATIVE_BIN = resolveNativeBinaryForLedgerTests();

describe("replay --at event", () => {
	it("fast-forwards to target event and emits state there", async () => {
		const fixture = await makeLegacyReplayTapeFixture();

		try {
			const targetId = fixture.unitStartedEventId;

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
		const fixture = await makeLegacyReplayTapeFixture();

		try {
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
