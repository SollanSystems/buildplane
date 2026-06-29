import type { PlanForgeCompileResult } from "./compile.js";
import { hasLine } from "./compile.js";
import {
	PLANFORGE_REQUIRED_EVIDENCE,
	PLANFORGE_VALIDATION_STATUS_INSUFFICIENT_EVIDENCE,
	PLANFORGE_VALIDATION_STATUS_PASS,
	PLANFORGE_VALIDATION_STATUS_UNSAFE_TO_RUN,
	type PlanForgeRequiredEvidence,
	type PlanForgeRiskClass,
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
	// The verification surface is governed by the declared verificationCommands +
	// the capability-bundle allowlist, not by goal prose — so 'run commands' /
	// 'execute code' are intentionally NOT forbidden here (a benign self-build goal
	// legitimately mentions running its verification commands). The truly-unsafe
	// boundary-crossing phrasings (push/deploy/merge/PR/network/board/worker-spawn)
	// stay rejected.
	const forbiddenGoalIntent =
		/\b(push(?:es)?|deploys?|merges?|open\s+(?:prs?|pull\s+requests?)|pull\s+requests?|network\s+writes?|board\s+writes?|kanban|gsd2|github|worker[-\s]+spawns?|spawn\s+(?:a\s+)?workers?)\b/gi;
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
		missingEvidence.push("tasks");
	}

	const status: PlanForgeValidationStatus =
		unsafeReasons.length > 0
			? PLANFORGE_VALIDATION_STATUS_UNSAFE_TO_RUN
			: missingEvidence.length > 0
				? PLANFORGE_VALIDATION_STATUS_INSUFFICIENT_EVIDENCE
				: PLANFORGE_VALIDATION_STATUS_PASS;
	const hasAllowedSideEffects = compiled.parsedTasks.some(
		(task) => task.allowedSideEffects.length > 0,
	);
	const riskClass: PlanForgeRiskClass =
		unsafeReasons.length > 0 ||
		status === PLANFORGE_VALIDATION_STATUS_UNSAFE_TO_RUN
			? "high"
			: missingEvidence.length > 0 ||
					status === PLANFORGE_VALIDATION_STATUS_INSUFFICIENT_EVIDENCE
				? "medium"
				: hasAllowedSideEffects
					? "medium"
					: "low";
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
			// 'tasks' is reported by the dedicated tasks-present check; this structural
			// guard only covers the operator-boundary evidence, so a tasks-only
			// absence does not misreport structural evidence as missing.
			status: missingEvidence.some((e) => e !== "tasks")
				? "INSUFFICIENT_EVIDENCE"
				: "PASS",
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
			// parseTasks() already drops any task with zero verification commands, so a
			// parsed task is invariably valid here — the only states are PASS (>=1 task)
			// and INSUFFICIENT_EVIDENCE (no tasks). The former UNSAFE_TO_RUN arm was
			// unreachable and has been collapsed.
			status:
				compiled.parsedTasks.length > 0 ? "PASS" : "INSUFFICIENT_EVIDENCE",
			message: "Every declared task carries at least one verification command.",
			evidenceRefs: [compiled.evidenceRefs[0]],
		},
	];

	return {
		status,
		validation: {
			status,
			riskClass,
			checks,
			requiredEvidence: PLANFORGE_REQUIRED_EVIDENCE,
			missingEvidence,
			unsafeReasons,
		},
	};
}
