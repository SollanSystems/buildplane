import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeBuildplaneRunFixture } from "./fixtures.js";

describe("unsafe raw execution evidence boundary", () => {
	it("does not create a tape that could be mistaken for governed evidence", async () => {
		const fixture = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "unit-e2e",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["out.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: {
					command: "sh",
					args: ["-c", "echo hello > out.txt"],
				},
				verification: { requiredOutputs: ["out.txt"] },
			},
		});

		try {
			expect(fixture.exitCode).toBe(0);
			expect(existsSync(fixture.eventsDbPath)).toBe(false);
		} finally {
			await fixture.cleanup();
		}
	}, 30_000);
});
