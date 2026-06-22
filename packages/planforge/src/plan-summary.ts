import type { PlanForgePlan } from "./schema.js";

export interface PlanSummary {
	readonly planId: string;
	readonly title: string;
	readonly goal: string;
	readonly outcome: "completed" | "failed";
	readonly taskCount: number;
	readonly passedCount: number;
	readonly mergedSha?: string;
	readonly decidedAt: string;
}

export function summarizePlanReceipt(
	plan: PlanForgePlan,
	runs: ReadonlyArray<{ task: string; status: string }>,
	outcome: "completed" | "failed",
	mergedSha?: string,
): PlanSummary {
	const passedCount = runs.filter((r) => r.status === "passed").length;
	return {
		planId: plan.id,
		title: plan.title,
		goal: plan.goal,
		outcome,
		taskCount: plan.tasks.length,
		passedCount,
		mergedSha,
		decidedAt: new Date().toISOString(),
	};
}

export function formatPriorWorkEntry(summary: PlanSummary): string {
	const shaClause = summary.mergedSha
		? ` sha:${summary.mergedSha.slice(0, 8)}`
		: "";
	return `[${summary.outcome}] ${summary.title} — ${summary.passedCount}/${summary.taskCount} tasks passed${shaClause} — goal: ${summary.goal}`;
}
