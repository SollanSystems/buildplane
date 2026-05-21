import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	PLANFORGE_ALLOWED_SIDE_EFFECTS,
	PLANFORGE_FORBIDDEN_SIDE_EFFECTS,
	PLANFORGE_PLAN_SCHEMA_VERSION,
	PLANFORGE_RECEIPT_SCHEMA_VERSION,
	PLANFORGE_REQUIRED_EVIDENCE,
	PLANFORGE_TASK_IDS,
	PLANFORGE_VALIDATION_STATUSES,
} from "../src/planforge-schema";

interface ExpectedPlanFixture {
	schemaVersion: string;
	tasks: Array<{
		id: string;
		allowedSideEffects: string[];
		forbiddenSideEffects: string[];
	}>;
	validation: {
		status: string;
		checks: Array<{ status: string }>;
		requiredEvidence: string[];
	};
	receiptPreview: {
		schemaVersion: string;
		status: string;
		notes: string[];
	};
}

function loadExpectedPlanFixture(): ExpectedPlanFixture {
	return JSON.parse(
		readFileSync(
			join(
				process.cwd(),
				"apps/cli/test/fixtures/planforge/expected-plan.json",
			),
			"utf8",
		),
	) as ExpectedPlanFixture;
}

function uniqueValues(values: readonly string[]): string[] {
	return Array.from(new Set(values));
}

describe("planforge schema constants", () => {
	it("matches the checked-in PlanForge fixture schema versions", () => {
		const expectedPlan = loadExpectedPlanFixture();

		expect(PLANFORGE_PLAN_SCHEMA_VERSION).toBe(expectedPlan.schemaVersion);
		expect(PLANFORGE_RECEIPT_SCHEMA_VERSION).toBe(
			expectedPlan.receiptPreview.schemaVersion,
		);
	});

	it("matches the checked-in PlanForge fixture vocabularies", () => {
		const expectedPlan = loadExpectedPlanFixture();
		const fixtureStatusVocabulary = uniqueValues([
			expectedPlan.validation.status,
			expectedPlan.receiptPreview.status,
			...expectedPlan.validation.checks.map((check) => check.status),
			...expectedPlan.receiptPreview.notes.flatMap(
				(note) =>
					note.match(
						/\b(?:PASS|BLOCKED|FAILED|INSUFFICIENT_EVIDENCE|UNSAFE_TO_RUN)\b/g,
					) ?? [],
			),
		]);
		const fixtureAllowedSideEffects = uniqueValues(
			expectedPlan.tasks.flatMap((task) => task.allowedSideEffects),
		);
		const fixtureForbiddenSideEffects = uniqueValues(
			expectedPlan.tasks.flatMap((task) => task.forbiddenSideEffects),
		);

		expect([...PLANFORGE_VALIDATION_STATUSES]).toEqual(fixtureStatusVocabulary);
		expect([...PLANFORGE_REQUIRED_EVIDENCE]).toEqual(
			expectedPlan.validation.requiredEvidence,
		);
		expect([...PLANFORGE_TASK_IDS]).toEqual(
			expectedPlan.tasks.map((task) => task.id),
		);
		expect([...PLANFORGE_ALLOWED_SIDE_EFFECTS]).toEqual(
			fixtureAllowedSideEffects,
		);
		expect([...PLANFORGE_FORBIDDEN_SIDE_EFFECTS]).toEqual(
			fixtureForbiddenSideEffects,
		);
	});
});
