import { describe, expect, it } from "vitest";
import {
	formatPriorWorkEntry,
	summarizePlanReceipt,
} from "../src/plan-summary.js";
import type { PlanForgePlan } from "../src/schema.js";

const basePlan: PlanForgePlan = {
	schemaVersion: "planforge.plan.v0",
	id: "plan-abc",
	idempotencyKey: "ikey-1",
	title: "M5-S1: approval inbox",
	goal: "Build the approval inbox UI",
	trustedBase: "sha-base",
	tasks: [
		{
			id: "PF1",
			title: "Scaffold route",
			objective: "Add /api/approvals route",
			assigneeHint: "claude-code",
			workspace: "apps/web",
			dependsOn: [],
			allowedSideEffects: ["local-doc"],
			forbiddenSideEffects: ["push"],
			acceptanceCriteria: ["route returns 200"],
			verificationCommands: ["pnpm vitest run"],
		},
		{
			id: "PF2",
			title: "Wire UI",
			objective: "Add ApprovalInbox component",
			assigneeHint: "claude-code",
			workspace: "apps/web",
			dependsOn: ["PF1"],
			allowedSideEffects: ["local-doc"],
			forbiddenSideEffects: ["push"],
			acceptanceCriteria: ["component renders"],
			verificationCommands: ["pnpm vitest run"],
		},
	],
	validation: {
		status: "PASS",
		checks: [],
		requiredEvidence: [],
		missingEvidence: [],
		unsafeReasons: [],
	},
	receiptPreview: {
		schemaVersion: "planforge.receipt.v0",
		status: "PASS",
		planId: "plan-abc",
		idempotencyKey: "ikey-1",
		inputDigest: "d1",
		planDigest: "d2",
		trustedBase: "sha-base",
		admittedBy: "buildplane-kernel",
		generatedAt: "2026-06-22T00:00:00.000Z",
		dryRun: true,
		sideEffects: [],
		notes: [],
	},
};

describe("summarizePlanReceipt", () => {
	it("produces a completed summary when all runs pass", () => {
		const runs = [
			{ task: "PF1", status: "passed" },
			{ task: "PF2", status: "passed" },
		];
		const summary = summarizePlanReceipt(
			basePlan,
			runs,
			"completed",
			"sha-merged",
		);
		expect(summary.planId).toBe("plan-abc");
		expect(summary.title).toBe("M5-S1: approval inbox");
		expect(summary.goal).toBe("Build the approval inbox UI");
		expect(summary.outcome).toBe("completed");
		expect(summary.taskCount).toBe(2);
		expect(summary.passedCount).toBe(2);
		expect(summary.mergedSha).toBe("sha-merged");
		expect(typeof summary.decidedAt).toBe("string");
	});

	it("counts partial failures correctly", () => {
		const runs = [
			{ task: "PF1", status: "passed" },
			{ task: "PF2", status: "failed" },
		];
		const summary = summarizePlanReceipt(basePlan, runs, "failed");
		expect(summary.outcome).toBe("failed");
		expect(summary.taskCount).toBe(2);
		expect(summary.passedCount).toBe(1);
		expect(summary.mergedSha).toBeUndefined();
	});

	it("handles empty runs", () => {
		const summary = summarizePlanReceipt(basePlan, [], "failed");
		expect(summary.taskCount).toBe(2);
		expect(summary.passedCount).toBe(0);
	});
});

describe("formatPriorWorkEntry", () => {
	it("returns a single-line summary with all key fields", () => {
		const summary = summarizePlanReceipt(
			basePlan,
			[
				{ task: "PF1", status: "passed" },
				{ task: "PF2", status: "passed" },
			],
			"completed",
			"abc1234",
		);
		const entry = formatPriorWorkEntry(summary);
		expect(entry).toContain("M5-S1: approval inbox");
		expect(entry).toContain("completed");
		expect(entry).toContain("2/2");
		expect(entry).toContain("abc1234");
	});

	it("omits mergedSha when not present", () => {
		const summary = summarizePlanReceipt(
			basePlan,
			[{ task: "PF1", status: "failed" }],
			"failed",
		);
		const entry = formatPriorWorkEntry(summary);
		expect(entry).not.toContain("sha:");
		expect(entry).toContain("failed");
	});
});
