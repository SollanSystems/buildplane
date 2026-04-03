import type {
	ExecutionReceipt,
	PolicyDecision,
	PolicyProfile,
	UnitPacket,
} from "@buildplane/kernel";

export function evaluateRun(
	_packet: UnitPacket,
	receipt: ExecutionReceipt,
	profile?: PolicyProfile,
	attemptCount?: number,
): PolicyDecision {
	const reasons: string[] = [];

	if (receipt.exitCode !== 0) {
		reasons.push(`command exited with code ${receipt.exitCode}`);
	}

	for (const check of receipt.outputChecks) {
		if (!check.exists) {
			reasons.push(`required output missing: ${check.path}`);
		}
	}

	if (reasons.length > 0) {
		// Check if retries are available
		const retry = profile?.retry;
		const attempt = attemptCount ?? 0;
		if (retry && attempt < retry.maxRetries) {
			return {
				kind: "retry-run",
				outcome: "retrying",
				reasons,
				attemptNumber: attempt + 1,
				feedbackContext: retry.injectFailureContext !== false ? reasons : [],
			};
		}

		return {
			kind: "reject-run",
			outcome: "rejected",
			reasons,
		};
	}

	return {
		kind: "advance-run",
		outcome: "approved",
		reasons: [],
	};
}
