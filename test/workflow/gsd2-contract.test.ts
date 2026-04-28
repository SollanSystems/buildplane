import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const readRepoFile = (path: string) => readFileSync(join(root, path), "utf8");

describe("GSD-2 Milestone 1 operator contract", () => {
	it("documents the non-executing GSD-2 CLI skeleton in the README", () => {
		const readme = readRepoFile("README.md");

		expect(readme).toContain("## GSD-2 repo-local task state");
		expect(readme).toContain("pnpm gsd2 status");
		expect(readme).toContain('pnpm gsd2 new "<goal>" --route planning_only');
		expect(readme).toContain("pnpm gsd2 validate");
		expect(readme).toContain("pnpm gsd2 run --dry-run <task-id>");
		expect(readme).toContain(
			"Milestone 1 is intentionally non-executing: it writes and validates `.gsd2` state and previews routes, but it does not dispatch Buildplane runs, worktree-kernel slices, tmux sessions, or model workers.",
		);
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
