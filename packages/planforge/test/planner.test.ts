import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPlanForgeDryRunPlan } from "../src/index.ts";
import { buildPlannerPlanMarkdown } from "../src/planner.ts";
import type { RoadmapSlice } from "../src/roadmap.ts";

const SLICE: RoadmapSlice = {
	id: "M5-S2",
	title: "Run inspector",
	status: "pending",
	objective:
		"Add a read-only run inspector that replays a single run from the signed tape.",
	allowedSideEffects: ["code-edit"],
	verificationCommands: [
		"pnpm -C . exec vitest run packages/kernel/test/run-inspector.test.ts",
		"pnpm typecheck",
	],
	acceptanceCriteria: [
		"The inspector reconstructs a run's event timeline from the tape with no side effects.",
	],
	dependsOn: ["M5-S1"],
	pathGlobs: ["packages/kernel/src/**", "packages/kernel/test/**"],
};

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "planner-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("buildPlannerPlanMarkdown", () => {
	it("emits a plan.md that validates PASS through the dry-run pipeline", () => {
		const md = buildPlannerPlanMarkdown({
			slice: SLICE,
			remote: "https://github.com/SollanSystems/buildplane.git",
			trustedBase: "15dbb32db0e1f0024687533755805fc23f3ef6d4",
		});
		const planPath = join(dir, "plan.md");
		writeFileSync(planPath, md, "utf8");
		const plan = createPlanForgeDryRunPlan(planPath);
		expect(plan.validation.status).toBe("PASS");
		expect(plan.validation.missingEvidence).toEqual([]);
		expect(plan.validation.unsafeReasons).toEqual([]);
	});

	it("includes the exact safety-constraint lines validate() string-matches", () => {
		const md = buildPlannerPlanMarkdown({
			slice: SLICE,
			remote: "r",
			trustedBase: "b",
		});
		expect(md).toContain("- Dry-run only.");
		expect(md).toContain("- Buildplane kernel validates and admits plans.");
		expect(md).toContain("- Coding agents are untrusted workers.");
		expect(md).toContain(
			"- No Kanban, GSD2, GitHub, network, push, PR, deploy, merge, or worker-spawn side effects.",
		);
	});

	it("emits the GAP-2 ## Tasks grammar (### <ID>: <Title> + bullet fields)", () => {
		const md = buildPlannerPlanMarkdown({
			slice: SLICE,
			remote: "r",
			trustedBase: "b",
		});
		expect(md).toContain("## Tasks");
		expect(md).toContain("### M5-S2: Run inspector");
		expect(md).toContain("- Objective:");
		expect(md).toContain("- Assignee-hint:");
		expect(md).toContain("- Workspace: isolated-worktree");
		expect(md).toContain("- Allowed-side-effects: code-edit");
		expect(md).toContain("- Verification-commands:");
		expect(md).toContain(
			"  - pnpm -C . exec vitest run packages/kernel/test/run-inspector.test.ts",
		);
	});

	it("round-trips through compile(): the emitted task maps back to the slice (D2)", () => {
		const md = buildPlannerPlanMarkdown({
			slice: SLICE,
			remote: "r",
			trustedBase: "b",
		});
		const planPath = join(dir, "plan.md");
		writeFileSync(planPath, md, "utf8");
		const plan = createPlanForgeDryRunPlan(planPath);
		expect(plan.tasks).toHaveLength(1);
		expect(plan.tasks[0].id).toBe("M5-S2");
		expect(plan.tasks[0].allowedSideEffects).toContain("code-edit");
		expect(plan.tasks[0].verificationCommands).toContain(
			"pnpm -C . exec vitest run packages/kernel/test/run-inspector.test.ts",
		);
		expect(plan.tasks[0].dependsOn).toEqual(["M5-S1"]);
	});

	it("is deterministic for the same slice and base", () => {
		const a = buildPlannerPlanMarkdown({
			slice: SLICE,
			remote: "r",
			trustedBase: "b",
		});
		const b = buildPlannerPlanMarkdown({
			slice: SLICE,
			remote: "r",
			trustedBase: "b",
		});
		expect(a).toBe(b);
	});
});
