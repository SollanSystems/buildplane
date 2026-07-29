import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeBuildplaneRunFixture } from "./fixtures.js";

const SKIP_PLATFORMS = new Set(["win32", "darwin"]);

describe.skipIf(SKIP_PLATFORMS.has(process.platform))(
	"permission-denied",
	() => {
		it("writable unsafe workspace completes without creating a tape authority", async () => {
			const fixture = await makeBuildplaneRunFixture({
				packet: {
					unit: {
						id: "unit-noop",
						kind: "command",
						scope: "task",
						inputRefs: [],
						expectedOutputs: [],
						verificationContract: "exit-0-and-required-outputs",
						policyProfile: "default",
					},
					execution: { command: "sh", args: ["-c", "true"] },
					verification: { requiredOutputs: [] },
				},
			});

			try {
				expect(fixture.exitCode).toBe(0);
				expect(existsSync(fixture.eventsDbPath)).toBe(false);
			} finally {
				await fixture.cleanup();
			}
		}, 30_000);
	},
);
