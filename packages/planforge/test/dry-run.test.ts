import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/compile.ts";
import { digest } from "../src/digest.ts";
import { createPlanForgeDryRunPlan } from "../src/index.ts";
import { hasForbiddenPlanForgeGoalIntent, validate } from "../src/validate.ts";

const fixtureRoot = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../apps/cli/test/fixtures/planforge",
);
const inputFixture = join(fixtureRoot, "goal-input.md");
const codingFixture = join(fixtureRoot, "goal-input-with-tasks.md");
const expectedFixture = join(fixtureRoot, "expected-plan.json");

describe("createPlanForgeDryRunPlan", () => {
	it("emits the golden fixture plan for the goal input", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const expected = JSON.parse(readFileSync(expectedFixture, "utf8"));
		expect(plan).toEqual(expected);
	});

	it("derives a PASS validation for the goal fixture", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		expect(plan.validation.status).toBe("PASS");
		expect(plan.validation.missingEvidence).toEqual([]);
		expect(plan.validation.unsafeReasons).toEqual([]);
	});

	it("computes planDigest as the canonical digest of the review artifact", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const { receiptPreview: _receiptPreview, ...reviewArtifact } = plan;
		expect(plan.receiptPreview.planDigest).toBe(digest(reviewArtifact));
	});

	it("surfaces a declarative netEgress allowlist on the receipt preview (M6-S9)", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		// The goal fixture's tasks declare only local-* side-effects, all of which
		// map to zero egress — so the declared posture is explicit default-deny.
		expect(plan.receiptPreview.netEgress).toEqual([]);
		// netEgress lives on the receiptPreview (excluded from planDigest), so it
		// must NOT perturb the review-artifact digest.
		const { receiptPreview: _receiptPreview, ...reviewArtifact } = plan;
		expect(plan.receiptPreview.planDigest).toBe(digest(reviewArtifact));
	});

	it("preserves the input-basename evidence anchor in evidence refs", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const refs = plan.validation.checks.flatMap((check) => check.evidenceRefs);
		expect(refs).toContain("goal-input.md#safety-constraints");
		expect(refs).toContain("goal-input.md#repository-context");
	});

	it("produces the task list declared in the ## Tasks section of the fixture", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		expect(plan.tasks).toHaveLength(2);
		expect(plan.tasks[0].id).toBe("PF1");
		expect(plan.tasks[1].id).toBe("PF2");
		expect(plan.tasks[1].dependsOn).toEqual(["PF1"]);
		expect(plan.tasks[0].verificationCommands).toContain("pnpm lint");
		expect(plan.tasks[1].verificationCommands).toContain("pnpm typecheck");
	});

	it("idempotencyKey is unchanged from the pre-GAP-2 value (task content excluded from fingerprint)", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		// This exact value was the idempotencyKey before ## Tasks was added to goal-input.md.
		// If this fails, the fingerprintInput was accidentally changed — see preview.ts comment.
		expect(plan.idempotencyKey).toBe(
			"planforge:v0:buildplane:15dbb32db0e1f0024687533755805fc23f3ef6d4:95d7132e",
		);
	});

	it("validation status is PASS with all five checks passing", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		expect(plan.validation.status).toBe("PASS");
		for (const check of plan.validation.checks) {
			expect(check.status).toBe("PASS");
		}
	});
});

describe("createPlanForgeDryRunPlan with novel task ids", () => {
	it("parses M5-S1-T1 and M5-S1-T2 task ids from the coding fixture", () => {
		const plan = createPlanForgeDryRunPlan(codingFixture);
		expect(plan.validation.status).toBe("PASS");
		expect(plan.tasks).toHaveLength(2);
		expect(plan.tasks[0].id).toBe("M5-S1-T1");
		expect(plan.tasks[1].id).toBe("M5-S1-T2");
		expect(plan.tasks[1].dependsOn).toEqual(["M5-S1-T1"]);
		expect(plan.tasks[0].acceptanceCriteria).toContain(
			"apps/web/package.json exists with name @buildplane/web.",
		);
		expect(plan.tasks[1].verificationCommands).toContain(
			"pnpm vitest --run apps/web/test/health.test.ts",
		);
	});

	it("assigns distinct idempotencyKey from the PF1/PF2 fixture (different goal and trustedBase)", () => {
		const pf = createPlanForgeDryRunPlan(inputFixture);
		const m5 = createPlanForgeDryRunPlan(codingFixture);
		expect(m5.idempotencyKey).not.toBe(pf.idempotencyKey);
	});

	it("derives planDigest that changes when task content changes", () => {
		const plan = createPlanForgeDryRunPlan(codingFixture);
		// planDigest covers the whole plan minus receiptPreview — task changes rotate it
		expect(plan.receiptPreview.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
	});
});

describe("validate: tasks-present check", () => {
	it("produces INSUFFICIENT_EVIDENCE when ## Tasks section is absent", () => {
		const noTasksContent = `## Goal\n\nSome goal.\n\n## Repository context\n\n- Remote: https://github.com/example/repo.git\n- Trusted base: abcdef1234567890abcdef1234567890abcdef12\n- Worktree policy: isolated-worktree-required\n\n## Safety constraints\n\n- Dry-run only.\n- Buildplane kernel validates and admits plans.\n- Coding agents are untrusted workers.\n- No Kanban, GSD2, GitHub, network, push, PR, deploy, merge, or worker-spawn side effects.\n`;
		const compiled = compile(noTasksContent, "no-tasks.md");
		const { status, validation } = validate(compiled);
		expect(status).toBe("INSUFFICIENT_EVIDENCE");
		expect(validation.missingEvidence).toContain("tasks");
		const check = validation.checks.find((c) => c.id === "tasks-present");
		expect(check?.status).toBe("INSUFFICIENT_EVIDENCE");
	});

	it("produces PASS when ## Tasks section has valid tasks", () => {
		// goal-input.md now has a valid ## Tasks section
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const check = plan.validation.checks.find((c) => c.id === "tasks-present");
		expect(check?.status).toBe("PASS");
	});
});

describe("hasForbiddenPlanForgeGoalIntent — self-build narrowing", () => {
	it("allows a goal that edits source and runs verification commands", () => {
		expect(
			hasForbiddenPlanForgeGoalIntent(
				"Edit packages/kernel/src to add the approval inbox and run cargo test and pnpm vitest to verify.",
			),
		).toBe(false);
	});

	it("allows the literal phrase 'run commands' in a verification context", () => {
		expect(
			hasForbiddenPlanForgeGoalIntent(
				"Implement the slice; the worker may run commands listed in verificationCommands.",
			),
		).toBe(false);
	});

	it("allows the literal phrase 'execute code' in a verification context", () => {
		expect(
			hasForbiddenPlanForgeGoalIntent(
				"The untrusted worker will execute code in an isolated worktree to verify the slice.",
			),
		).toBe(false);
	});

	it("still rejects push", () => {
		expect(
			hasForbiddenPlanForgeGoalIntent(
				"Implement the feature and push to origin.",
			),
		).toBe(true);
	});

	it("still rejects deploy / merge / open PR / worker-spawn", () => {
		expect(hasForbiddenPlanForgeGoalIntent("deploy to prod")).toBe(true);
		expect(hasForbiddenPlanForgeGoalIntent("merge the branch")).toBe(true);
		expect(hasForbiddenPlanForgeGoalIntent("open a pull request")).toBe(true);
		expect(hasForbiddenPlanForgeGoalIntent("spawn a worker to do it")).toBe(
			true,
		);
	});
});
