/**
 * Policy types — constraints, profiles, and evaluation inputs.
 *
 * These define the vocabulary the policy engine uses to evaluate
 * whether a run should continue, be rejected, or be retried.
 * The orchestrator resolves these from the packet's policyProfile
 * field and passes them to the policy port.
 */

// ── Budget Constraints ──────────────────────────────────────

export interface BudgetConstraints {
	/** Maximum total tokens (prompt + completion) before aborting */
	readonly maxTokens?: number;
	/** Maximum wall-clock time in milliseconds before aborting */
	readonly maxComputeTimeMs?: number;
}

// ── Resource Usage Tracking ─────────────────────────────────

export interface ResourceUsageSnapshot {
	readonly promptTokens: number;
	readonly completionTokens: number;
	readonly totalTokens: number;
	readonly elapsedMs: number;
}

export function createResourceUsageSnapshot(): ResourceUsageSnapshot {
	return {
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		elapsedMs: 0,
	};
}
