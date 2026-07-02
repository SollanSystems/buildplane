import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const readRepoFile = (path: string) => readFileSync(join(root, path), "utf8");

describe("GSD-2 Milestone 1 operator contract", () => {
	it("drops the stale gsd2 surface from the published v0.5 cut (M6-S13 / O5)", () => {
		// Operator decision O5: gsd2 is a stale pre-M2 experiment dropped from the
		// published surface — the bin is removed and the README no longer advertises
		// it. The source (apps/cli/src/gsd2*.ts) + its unit tests stay in place;
		// source cleanup is post-v0.5.
		const cliPkg = JSON.parse(readRepoFile("apps/cli/package.json"));
		expect(cliPkg.bin?.gsd2).toBeUndefined();
		expect(cliPkg.bin?.buildplane).toBe("./dist/index.js");

		const readme = readRepoFile("README.md");
		expect(readme).not.toContain("## GSD-2 repo-local task state");
	});

	it("marks Milestone 1 CLI skeleton tasks as implemented in the GSD-2 plan", () => {
		const plan = readRepoFile(
			"docs/superpowers/plans/2026-04-28-gsd2-autonomous-workflow-implementation.md",
		);

		expect(plan).toContain("## Milestone 1 implementation status");
		expect(plan).toContain(
			"- [x] Add `pnpm gsd2` source command and package bin metadata.",
		);
		expect(plan).toContain(
			"- [x] Implement `gsd2 status` as read-only state inspection.",
		);
		expect(plan).toContain(
			"- [x] Implement `gsd2 new` for minimal `.gsd2` task creation.",
		);
		expect(plan).toContain(
			"- [x] Implement `gsd2 validate` for envelope/receipt checks.",
		);
		expect(plan).toContain(
			"- [x] Implement `gsd2 run --dry-run <task-id>` without worker execution.",
		);
		expect(plan).toContain(
			"- [x] Add focused tests for schema validation and no-execution CLI behavior.",
		);
	});
});
