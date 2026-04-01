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

// ── Policy Profiles ─────────────────────────────────────────

export interface PolicyProfile {
	readonly name: string;
	readonly budgets?: BudgetConstraints;
	readonly retry?: RetryPolicy;
	readonly trustGates?: TrustGateConfig;
}

// ── Trust Gates ─────────────────────────────────────────────

export interface TrustGateConfig {
	/** Tools that are explicitly blocked — any call to these tools is rejected */
	readonly restrictedTools?: readonly string[];
	/** If set, only these tools are allowed — any tool not in this list is rejected */
	readonly allowedTools?: readonly string[];
	/**
	 * When true, the run requires explicit operator approval before execution begins.
	 * The orchestrator suspends the run and returns { suspended: true }.
	 * Resume via `buildplane approve <run-id>`.
	 */
	readonly requiresApproval?: boolean;
}

// ── Retry Policy ────────────────────────────────────────────

export interface RetryPolicy {
	readonly maxRetries: number;
	/** If true, the orchestrator injects failure reasons into the model's next prompt */
	readonly injectFailureContext?: boolean;
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
