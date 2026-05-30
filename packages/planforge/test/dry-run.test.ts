import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { digest } from "../src/digest.ts";
import { createPlanForgeDryRunPlan } from "../src/index.ts";

const fixtureRoot = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../apps/cli/test/fixtures/planforge",
);
const inputFixture = join(fixtureRoot, "goal-input.md");
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

	it("preserves the input-basename evidence anchor in evidence refs", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const refs = plan.validation.checks.flatMap((check) => check.evidenceRefs);
		expect(refs).toContain("goal-input.md#safety-constraints");
		expect(refs).toContain("goal-input.md#repository-context");
	});
});
