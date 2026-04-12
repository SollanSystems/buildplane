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
	const { decision, packet, receipt, attemptCount = 0 } = input;
	const learnings: ExtractedLearning[] = [];

	if (decision.outcome !== "approved" && decision.outcome !== "rejected") {
		return learnings;
	}

	// Rule 2: Rejected → enriched session constraint
	if (decision.outcome === "rejected") {
		const reasons =
			decision.reasons.length > 0
				? decision.reasons.join("; ")
				: "run rejected by policy";
		const failingOutput = receipt.outputChecks.find((c) => !c.exists);
		const missingClause = failingOutput
			? ` Missing output: ${failingOutput.path}.`
			: "";
		learnings.push({
			kind: "constraint",
			scope: "session",
			title: "Run rejected",
			body: `Rejected: exit code ${receipt.exitCode}.${missingClause} Contract: ${packet.unit.verificationContract}. Reasons: ${reasons}`,
		});
	}

	// Rule 3: Retry succeeded → sharpened workspace heuristic
	if (decision.outcome === "approved" && attemptCount > 0) {
		const feedback =
			decision.reasons.length > 0
				? decision.reasons.join("; ")
				: "no specific feedback";
		learnings.push({
			kind: "provider_heuristic",
			scope: "workspace",
			title: "Required retry to pass",
			body: `Succeeded after ${attemptCount + 1} attempts. Feedback that helped: ${feedback}`,
		});
	}

	// Rule 5: Multi-round strategy → sharpened workflow with round delta
	const rounds = input.strategyResult?.rounds;
	const roundCount = rounds?.length ?? 0;
	if (roundCount > 1 && rounds) {
		const roundSummaries: string[] = [];
		for (let i = 0; i < rounds.length; i++) {
			const round = rounds[i];
			const rejectedReasons: string[] = [];
			for (const [unitId, result] of round) {
				const d = result.decision as
					| { outcome: string; reasons: string[] }
					| undefined;
				if (d?.outcome === "rejected") {
					const prefix = unitId.endsWith("-reviewer") ? "reviewer" : unitId;
					rejectedReasons.push(
						`${prefix}: ${d.reasons.join("; ") || "rejected"}`,
					);
				}
			}
			if (rejectedReasons.length > 0) {
				roundSummaries.push(`Round ${i + 1} ${rejectedReasons.join(", ")}`);
			} else {
				roundSummaries.push(`Round ${i + 1}: approved`);
			}
		}
		learnings.push({
			kind: "workflow",
			scope: "workspace",
			title: "Strategy required multiple rounds",
			body: `Required ${roundCount} rounds. ${roundSummaries.join(". ")}.`,
		});
	}

	// Rule 6: Forbidden-path hit — each failing output → workspace constraint
	if (decision.outcome === "rejected") {
		const failingOutputs = receipt.outputChecks.filter((c) => !c.exists);
		for (const failing of failingOutputs) {
			learnings.push({
				kind: "constraint",
				scope: "workspace",
				title: `Verification failed: ${failing.path}`,
				body: `Output '${failing.path}' was expected but missing or empty. Contract: ${packet.unit.verificationContract}`,
			});
		}
	}

	// Rule 7: Verification-gate win — all outputs passed first try
	if (
		decision.outcome === "approved" &&
		attemptCount === 0 &&
		receipt.outputChecks.length > 0 &&
		receipt.outputChecks.every((c) => c.exists)
	) {
		learnings.push({
			kind: "fact",
			scope: "workspace",
			title: "Verification gate passed",
			body: `All expected outputs verified on first attempt: ${receipt.outputChecks.map((c) => c.path).join(", ")}`,
		});
	}

	return learnings;
}
