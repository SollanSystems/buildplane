import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { makeBuildplaneRunFixture } from "./fixtures.js";

function gitInRepoRoot(...args: string[]): string {
	const r = spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
	if (r.status !== 0) throw new Error(r.stderr);
	return r.stdout.trim();
}

/** The Phase C canary. If this fails, every other integration test is untrusted —
 * the test-isolation bug from feat/ledger-phase-a and feat/ledger-phase-b-clean
 * can recur.
 */
describe("cwd-isolation canary", () => {
	it("running buildplane run in a tempdir does not modify repo-root git state", async () => {
		const headBefore = gitInRepoRoot("rev-parse", "HEAD");
		const statusBefore = gitInRepoRoot("status", "--porcelain");
		const bpRefsBefore = spawnSync(
			"git",
			["for-each-ref", "--format=%(refname)", "refs/buildplane/"],
			{ cwd: process.cwd(), encoding: "utf8" },
		).stdout;

		const fixture = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "unit-noop",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: [".buildplane/artifacts/canary/ok"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: {
					command: "node",
					args: [
						"-e",
						"const fs = require('node:fs'); fs.mkdirSync('.buildplane/artifacts/canary',{recursive:true}); fs.writeFileSync('.buildplane/artifacts/canary/ok','1');",
					],
				},
				verification: {
					requiredOutputs: [".buildplane/artifacts/canary/ok"],
				},
			},
		});

		try {
			const headAfter = gitInRepoRoot("rev-parse", "HEAD");
			const statusAfter = gitInRepoRoot("status", "--porcelain");
			const bpRefsAfter = spawnSync(
				"git",
				["for-each-ref", "--format=%(refname)", "refs/buildplane/"],
				{ cwd: process.cwd(), encoding: "utf8" },
			).stdout;

			expect(headAfter).toBe(headBefore);
			expect(statusAfter).toBe(statusBefore);
			expect(bpRefsAfter).toBe(bpRefsBefore);
		} finally {
			await fixture.cleanup();
		}
	}, 30_000);
});
