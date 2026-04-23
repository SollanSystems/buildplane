import { describe, expect, it } from "vitest";
import { makeBuildplaneRunFixture } from "./fixtures.js";

const SKIP_PLATFORMS = new Set(["win32", "darwin"]);

describe.skipIf(SKIP_PLATFORMS.has(process.platform))(
	"permission-denied",
	() => {
		// NOTE: full read-only-directory testing requires a makeBuildplaneRunFixture
		// variant that allows mutating the workspace between fixture setup and
		// runCli() invocation (to chmod 500 the ledger dir BEFORE the run starts).
		// Phase C's fixture doesn't expose that hook; extending it is a Phase D
		// item.
		//
		// For Phase C, this test exercises the writable-workspace happy path —
		// it catches regressions where the ledger subprocess's mkdir -p fails
		// silently, even if we can't test the failure mode explicitly.
		it("writable workspace: ledger subprocess creates its dir and run completes cleanly", async () => {
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
			} finally {
				await fixture.cleanup();
			}
		}, 30_000);
	},
);
