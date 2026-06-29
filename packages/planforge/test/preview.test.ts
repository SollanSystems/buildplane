import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createPlanForgeDryRunPlan } from "../src/index.ts";

const fixtureRoot = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../apps/cli/test/fixtures/planforge",
);
const inputFixture = join(fixtureRoot, "goal-input.md");

describe("preview: riskClass propagation", () => {
	it("surfaces riskClass on the plan validation", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		expect(plan.validation.riskClass).toBe("medium");
	});

	it("propagates riskClass into the receipt preview object", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		expect(plan.receiptPreview.riskClass).toBe(plan.validation.riskClass);
		expect(plan.receiptPreview.riskClass).toBe("medium");
	});
});
