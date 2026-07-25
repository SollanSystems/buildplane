import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeBuildplaneRunFixture } from "./fixtures.js";

describe("unsafe shell command execution", () => {
	it("completes without creating a tape authority", async () => {
		const fixture = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "unit-shell",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["shell-out.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: {
					command: "sh",
					args: ["-c", "echo hi > shell-out.txt"],
				},
				verification: { requiredOutputs: ["shell-out.txt"] },
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
