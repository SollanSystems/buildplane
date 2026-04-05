import type {
	ExecutionReceipt,
	PolicyDecision,
	UnitPacket,
} from "./run-loop.js";
import type { Run, StrategyResult } from "./types.js";

export type LearningKind =
	| "fact"
	| "decision"
	| "constraint"
	| "preference"
	| "workflow"
	| "provider_heuristic";

export type LearningScope = "session" | "workspace" | "user" | "pack";

export interface ExtractedLearning {
	readonly kind: LearningKind;
	readonly scope: LearningScope;
	readonly title: string;
	readonly body: string;
}

export interface OutcomeExtractionInput {
	readonly run: Run;
	readonly receipt: ExecutionReceipt;
	readonly decision: PolicyDecision;
	readonly packet: UnitPacket;
	readonly strategyResult?: StrategyResult;
	readonly attemptCount?: number;
}

/**
 * Extract structured learnings from a completed run.
 * Pure function — no I/O, no side effects.
 * The extractor narrows `decision` internally; callers pass the raw PolicyDecision.
 */
export function extractLearnings(
	input: OutcomeExtractionInput,
): ExtractedLearning[] {
	const { decision, packet, attemptCount = 0 } = input;
	const learnings: ExtractedLearning[] = [];

	// Rule 1: Approved run → session-scoped fact
	if (decision.outcome === "approved") {
		const reasons =
			decision.reasons.length > 0
				? decision.reasons.join("; ")
				: "run completed successfully";
		learnings.push({
			kind: "fact",
			scope: "session",
			title: "Run approved",
			body: `Approved: ${reasons}`,
		});
	}

	// Rule 2: Rejected run → session-scoped constraint
	if (decision.outcome === "rejected") {
		const reasons =
			decision.reasons.length > 0
				? decision.reasons.join("; ")
				: "run rejected by policy";
		learnings.push({
			kind: "constraint",
			scope: "session",
			title: "Run rejected",
			body: `Rejected: ${reasons}`,
		});
	}

	// Rule 3: Retry succeeded → workspace-scoped provider_heuristic
	if (decision.outcome === "approved" && attemptCount > 0) {
		learnings.push({
			kind: "provider_heuristic",
			scope: "workspace",
			title: "Required retry to pass",
			body: `This task required ${attemptCount + 1} attempt(s) before passing. Consider adding feedback context upfront for similar tasks.`,
		});
	}

	// Rule 4: taskType + outcome → workspace-scoped decision
	const taskType = packet.intent?.taskType;
	if (taskType) {
		const outcome = decision.outcome === "approved" ? "passed" : "failed";
		learnings.push({
			kind: "decision",
			scope: "workspace",
			title: `${taskType} task outcome`,
			body: `A ${taskType} task ${outcome} on this codebase${attemptCount > 0 ? ` after ${attemptCount + 1} attempts` : ""}.`,
		});
	}

	// Rule 5: Strategy required multiple rounds → workspace-scoped workflow
	const roundCount = input.strategyResult?.rounds?.length ?? 0;
	if (roundCount > 1) {
		const feedback =
			input.decision.reasons.length > 0
				? input.decision.reasons.join("; ")
				: "none";
		learnings.push({
			kind: "workflow",
			scope: "workspace",
			title: "Strategy required multiple rounds",
			body: `Strategy required ${roundCount} rounds to complete. Feedback: ${feedback}.`,
		});
	}

	return learnings;
}
