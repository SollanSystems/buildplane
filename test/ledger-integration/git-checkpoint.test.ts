import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeBuildplaneRunFixture } from "./fixtures.js";

describe("unsafe raw checkpoint boundary", () => {
	it("does not create checkpoint tape records for a raw command packet", async () => {
		const fixture = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "unit-ckpt",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["a.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: {
					command: "sh",
					args: ["-c", "echo a > a.txt"],
				},
				verification: { requiredOutputs: ["a.txt"] },
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
