import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PlanForgePlan } from "../src/planforge-schema";
import {
	PLANFORGE_ALLOWED_SIDE_EFFECTS,
	PLANFORGE_FORBIDDEN_SIDE_EFFECTS,
	PLANFORGE_PLAN_SCHEMA_VERSION,
	PLANFORGE_RECEIPT_SCHEMA_VERSION,
	PLANFORGE_REQUIRED_EVIDENCE,
	PLANFORGE_VALIDATION_STATUSES,
} from "../src/planforge-schema";
import { writePlanSummaryToStorage } from "../src/run-cli.js";

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

const fixturePath = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures/planforge/expected-plan.json",
);

function loadExpectedPlanFixture(): ExpectedPlanFixture {
	return JSON.parse(readFileSync(fixturePath, "utf8")) as ExpectedPlanFixture;
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
		expect(expectedPlan.tasks.every((t) => t.id.length > 0)).toBe(true);
		expect([...PLANFORGE_ALLOWED_SIDE_EFFECTS]).toEqual(
			expect.arrayContaining(fixtureAllowedSideEffects),
		);
		expect([...PLANFORGE_ALLOWED_SIDE_EFFECTS]).toContain("code-edit");
		expect([...PLANFORGE_FORBIDDEN_SIDE_EFFECTS]).toEqual(
			fixtureForbiddenSideEffects,
		);
	});
});

describe("writePlanSummaryToStorage", () => {
	it("calls createSearchableDocument with the formatted summary", () => {
		const mockStorage = {
			createSearchableDocument: vi.fn().mockReturnValue({ id: "doc-1" }),
		};

		const plan = {
			id: "plan-xyz",
			title: "M5-S1",
			goal: "inbox",
			tasks: [{ id: "PF1" }, { id: "PF2" }],
		} as unknown as PlanForgePlan;
		const runs = [
			{ task: "PF1", status: "passed" },
			{ task: "PF2", status: "passed" },
		];

		writePlanSummaryToStorage(mockStorage, plan, runs, "completed", "sha-abc");

		expect(mockStorage.createSearchableDocument).toHaveBeenCalledOnce();
		const arg = mockStorage.createSearchableDocument.mock.calls[0][0];
		expect(arg.sourceTable).toBe("planforge_receipts");
		expect(arg.sourceId).toBe("plan-xyz");
		expect(arg.documentKind).toBe("plan-summary");
		expect(arg.title).toBe("M5-S1");
		expect(arg.bodyText).toContain("completed");
		expect(arg.bodyText).toContain("2/2");
		expect(arg.metadata?.planId).toBe("plan-xyz");
		expect(arg.metadata?.outcome).toBe("completed");
	});

	it("is a no-op when storage is undefined", () => {
		expect(() =>
			writePlanSummaryToStorage(
				undefined,
				{
					id: "p",
					title: "t",
					goal: "g",
					tasks: [],
				} as unknown as PlanForgePlan,
				[],
				"failed",
			),
		).not.toThrow();
	});
});
