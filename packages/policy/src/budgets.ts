import type {
	BudgetConstraints,
	PolicyDecision,
	ResourceUsageSnapshot,
	UnitPacket,
} from "@buildplane/kernel";

/**
 * Evaluate whether accumulated resource usage exceeds budget constraints.
 *
 * Returns a reject decision if any hard limit is breached, null if within limits.
 * Returns null if no budgets are defined.
 */
export function evaluateBudgets(
	_packet: UnitPacket,
	usage: ResourceUsageSnapshot,
	budgets?: BudgetConstraints,
): PolicyDecision | null {
	if (!budgets) {
		return null;
	}

	const reasons: string[] = [];

	if (
		budgets.maxTokens !== undefined &&
		usage.totalTokens > budgets.maxTokens
	) {
		reasons.push(
			`token budget exceeded: ${usage.totalTokens}/${budgets.maxTokens} tokens`,
		);
	}

	if (
		budgets.maxComputeTimeMs !== undefined &&
		usage.elapsedMs > budgets.maxComputeTimeMs
	) {
		reasons.push(
			`compute time budget exceeded: ${usage.elapsedMs}/${budgets.maxComputeTimeMs}ms`,
		);
	}

	if (reasons.length > 0) {
		return {
			kind: "reject-run",
			outcome: "rejected",
			reasons,
		};
	}

	return null;
}
