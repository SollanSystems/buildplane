import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { makeBuildplaneRunFixture } from "./fixtures.js";

const NATIVE_BIN =
	process.env.BUILDPLANE_NATIVE_BIN ??
	`${process.cwd()}/native/target/debug/buildplane-native`;

describe("replay basic", () => {
	it("streams one JSON line per event with hydrated state", async () => {
		const fixture = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "unit-replay",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["out.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: {
					command: "sh",
					args: ["-c", "echo hi > out.txt"],
				},
				verification: { requiredOutputs: ["out.txt"] },
			},
		});

		try {
			expect(fixture.exitCode).toBe(0);
			const db = new DatabaseSync(fixture.eventsDbPath);
			const runId = (
				db.prepare("SELECT DISTINCT run_id FROM events LIMIT 1").get() as {
					run_id: string;
				}
			).run_id;
			const expectedCount = (
				db.prepare("SELECT COUNT(*) as c FROM events").get() as { c: number }
			).c;
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
				],
				{ encoding: "utf8" },
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
