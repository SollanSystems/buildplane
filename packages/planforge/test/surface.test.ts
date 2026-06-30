import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as planforge from "../src/index.ts";
import {
	buildPlannerPlanMarkdown,
	loadRoadmapFromString,
	selectNextRoadmapSlice,
} from "../src/index.ts";

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

	it("re-exports the planner + roadmap surface", () => {
		expect(typeof buildPlannerPlanMarkdown).toBe("function");
		expect(typeof loadRoadmapFromString).toBe("function");
		expect(typeof selectNextRoadmapSlice).toBe("function");
	});

	it("the committed docs/roadmap.json is valid; M6-S6 is the first runtime slice", () => {
		const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
		const doc = loadRoadmapFromString(
			readFileSync(join(repoRoot, "docs/roadmap.json"), "utf8"),
		);
		expect(doc.milestone).toBe("M6");
		expect(doc.slices.find((s) => s.id === "M6-S6")?.status).toBe("pending");
		expect(selectNextRoadmapSlice(doc, [])?.id).toBe("M6-S6");
	});
});
