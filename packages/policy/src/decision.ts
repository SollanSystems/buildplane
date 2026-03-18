import type {
	ExecutionReceipt,
	PolicyDecision,
	UnitPacket,
} from "@buildplane/kernel";

export function evaluateRun(
	_packet: UnitPacket,
	receipt: ExecutionReceipt,
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
