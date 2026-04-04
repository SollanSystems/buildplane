/**
 * Policy types — constraints, profiles, and evaluation inputs.
 *
 * These define the vocabulary the policy engine uses to evaluate
 * whether a run should continue, be rejected, or be retried.
 * The orchestrator resolves these from the packet's policyProfile
 * field and passes them to the policy port.
 */
export function createResourceUsageSnapshot() {
	return {
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		elapsedMs: 0,
	};
}
//# sourceMappingURL=policy.js.map
