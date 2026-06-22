import type { PlanForgeCompileResult } from "./compile.js";
import { hasLine } from "./compile.js";
import type { ParsedTask } from "./parse-tasks.js";
import {
	PLANFORGE_REQUIRED_EVIDENCE,
	PLANFORGE_VALIDATION_STATUS_INSUFFICIENT_EVIDENCE,
	PLANFORGE_VALIDATION_STATUS_PASS,
	PLANFORGE_VALIDATION_STATUS_UNSAFE_TO_RUN,
	type PlanForgeRequiredEvidence,
	type PlanForgeValidation,
	type PlanForgeValidationCheck,
	type PlanForgeValidationStatus,
} from "./schema.js";

export function hasForbiddenPlanForgeGoalIntent(
	goal: string | undefined,
): boolean {
	if (!goal) {
		return false;
	}
	const forbiddenGoalIntent =
		/\b(push(?:es)?|deploys?|merges?|open\s+(?:prs?|pull\s+requests?)|pull\s+requests?|network\s+writes?|board\s+writes?|kanban|gsd2|github|worker[-\s]+spawns?|spawn\s+(?:a\s+)?workers?|execute\s+code|code\s+executions?|run\s+commands?)\b/gi;
	for (const match of goal.matchAll(forbiddenGoalIntent)) {
		const index = match.index ?? 0;
		const prefix = goal.slice(Math.max(0, index - 24), index).toLowerCase();
		if (
			/(?:\bno\b|\bnot\b|\bwithout\b|\bmust not\b|\bdoes not\b|\bdo not\b)(?:\s+(?:to|use|perform|request|run|open|create|any|a|an|the)){0,3}\W*$/.test(
				prefix,
			)
		) {
			continue;
		}
		return true;
	}
	return false;
}

export interface PlanForgeValidateResult {
	status: PlanForgeValidationStatus;
	validation: PlanForgeValidation;
}

export function validate(
	compiled: PlanForgeCompileResult,
): PlanForgeValidateResult {
	const { goal, remote, trustedBase, worktreePolicy, safetyConstraints } =
		compiled;
	const missingEvidence: PlanForgeRequiredEvidence[] = [];
	const unsafeReasons: string[] = [];

	if (!goal) {
		missingEvidence.push("operator_goal");
	}
	if (!remote) {
		missingEvidence.push("repository_remote");
	}
	if (!trustedBase) {
		missingEvidence.push("trusted_base");
	}
	if (
		!hasLine(safetyConstraints ?? "", "- Dry-run only.") ||
		!hasLine(
			safetyConstraints ?? "",
			"- No Kanban, GSD2, GitHub, network, push, PR, deploy, merge, or worker-spawn side effects.",
		)
	) {
		missingEvidence.push("dry_run_constraints");
	}
	if (
		!hasLine(
			safetyConstraints ?? "",
			"- Buildplane kernel validates and admits plans.",
		) ||
		!hasLine(safetyConstraints ?? "", "- Coding agents are untrusted workers.")
	) {
		missingEvidence.push("trusted_boundary");
	}
	if (!worktreePolicy) {
		missingEvidence.push("worktree_policy");
	} else if (worktreePolicy !== "isolated-worktree-required") {
		unsafeReasons.push("worktree policy must require an isolated worktree");
	}
	if (hasForbiddenPlanForgeGoalIntent(goal)) {
		unsafeReasons.push("goal requests a forbidden side effect");
	}
	if (compiled.parsedTasks.length === 0) {
		// 'tasks' is not yet in PLANFORGE_REQUIRED_EVIDENCE (extending that public
		// const tuple is a breaking change deferred to GAP-9); the runtime cast is
		// narrowly scoped to this push.
		missingEvidence.push("tasks" as PlanForgeRequiredEvidence);
	}

	const status: PlanForgeValidationStatus =
		unsafeReasons.length > 0
			? PLANFORGE_VALIDATION_STATUS_UNSAFE_TO_RUN
			: missingEvidence.length > 0
				? PLANFORGE_VALIDATION_STATUS_INSUFFICIENT_EVIDENCE
				: PLANFORGE_VALIDATION_STATUS_PASS;
	const checks: PlanForgeValidationCheck[] = [
		{
			id: "trusted-boundary",
			status:
				missingEvidence.includes("dry_run_constraints") ||
				missingEvidence.includes("trusted_boundary")
					? "INSUFFICIENT_EVIDENCE"
					: "PASS",
			message:
				"Buildplane kernel validates and admits the plan; coding agents remain untrusted workers.",
			evidenceRefs: [compiled.evidenceRefs[0]],
		},
		{
			id: "dry-run-only",
			status:
				unsafeReasons.length > 0
					? "UNSAFE_TO_RUN"
					: missingEvidence.includes("dry_run_constraints")
						? "INSUFFICIENT_EVIDENCE"
						: "PASS",
			message:
				"The proposed plan emits review artifacts only and forbids execution, board writes, network writes, push, deploy, and merge.",
			evidenceRefs: [compiled.evidenceRefs[0]],
		},
		{
			id: "evidence-present",
			status: missingEvidence.length > 0 ? "INSUFFICIENT_EVIDENCE" : "PASS",
			message:
				"Operator goal, repository remote, trusted base, worktree policy, and safety constraints are present.",
			evidenceRefs: [compiled.evidenceRefs[1]],
		},
		{
			id: "tasks-present",
			status:
				compiled.parsedTasks.length === 0 ? "INSUFFICIENT_EVIDENCE" : "PASS",
			message: "Plan declares at least one task with verification commands.",
			evidenceRefs: [compiled.evidenceRefs[0]],
		},
		{
			id: "tasks-valid",
			status:
				compiled.parsedTasks.length > 0 &&
				compiled.parsedTasks.every(
					(t: ParsedTask) => t.verificationCommands.length > 0,
				)
					? "PASS"
					: compiled.parsedTasks.length === 0
						? "INSUFFICIENT_EVIDENCE"
						: "UNSAFE_TO_RUN",
			message: "Every declared task carries at least one verification command.",
			evidenceRefs: [compiled.evidenceRefs[0]],
		},
	];

	return {
		status,
		validation: {
			status,
			checks,
			requiredEvidence: PLANFORGE_REQUIRED_EVIDENCE,
			missingEvidence,
			unsafeReasons,
		},
	};
}
