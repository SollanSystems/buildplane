import { describe, expect, it } from "vitest";
import * as planforge from "../src/index.ts";

describe("@buildplane/planforge public surface", () => {
	it("exposes the stage + digest API", () => {
		for (const name of [
			"compile",
			"validate",
			"preview",
			"createPlanForgeDryRunPlan",
			"canonicalJson",
			"digest",
		]) {
			expect(typeof (planforge as Record<string, unknown>)[name]).toBe(
				"function",
			);
		}
	});

	it("does NOT leak internal parse helpers", () => {
		for (const internal of [
			"hasLine",
			"listValue",
			"sectionText",
			"hasForbiddenPlanForgeGoalIntent",
		]) {
			expect(internal in planforge).toBe(false);
		}
	});
});
