import type {
	CapabilityGrant,
	ExecutionReceipt,
	PolicyDecision,
	PolicyProfile,
	SideEffectReceipt,
	UnitPacket,
} from "@buildplane/kernel";

export function evaluateRun(
	_packet: UnitPacket,
	receipt: ExecutionReceipt,
	profile?: PolicyProfile,
	attemptCount?: number,
): PolicyDecision {
	const reasons: string[] = [];
	const unsafeReasons = evaluateSideEffects(receipt.sideEffects ?? [], profile);

	if (receipt.exitCode !== 0) {
		reasons.push(`command exited with code ${receipt.exitCode}`);
	}

	for (const check of receipt.outputChecks) {
		if (!check.exists) {
			reasons.push(`required output missing: ${check.path}`);
		}
	}

	if (unsafeReasons.length > 0) {
		return {
			kind: "reject-run",
			outcome: "rejected",
			reasons: [...unsafeReasons, ...reasons],
		};
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

function evaluateSideEffects(
	sideEffects: readonly SideEffectReceipt[],
	profile?: PolicyProfile,
): string[] {
	return sideEffects.flatMap((sideEffect) => {
		const grant = findMatchingGrant(
			sideEffect,
			profile?.capabilityGrants ?? [],
		);
		if (grant) return [];
		return [
			`UNSAFE_TO_RUN: side effect ${sideEffect.id} ${sideEffect.capability}.${sideEffect.action} target ${sideEffect.target} without matching capability grant; quarantine required.`,
		];
	});
}

function findMatchingGrant(
	sideEffect: SideEffectReceipt,
	grants: readonly CapabilityGrant[],
): CapabilityGrant | undefined {
	return grants.find((grant) => {
		if (!sideEffect.grantId || grant.id !== sideEffect.grantId) return false;
		return (
			grant.capability === sideEffect.capability &&
			matchesGrantScope(sideEffect.action, grant.actions) &&
			matchesGrantScope(sideEffect.target, grant.targets)
		);
	});
}

function matchesGrantScope(
	value: string,
	allowedValues: readonly string[],
): boolean {
	return allowedValues.includes("*") || allowedValues.includes(value);
}
