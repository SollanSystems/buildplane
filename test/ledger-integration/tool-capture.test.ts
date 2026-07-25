import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeBuildplaneRunFixture } from "./fixtures.js";

describe("unsafe tool execution", () => {
	it("cannot upgrade a command packet into tape evidence", async () => {
		const fixture = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "unit-write",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["out.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: {
					command: "node",
					args: ["-e", "require('node:fs').writeFileSync('out.txt', 'hello');"],
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
