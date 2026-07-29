import type { GovernedActivityClaimPort } from "@buildplane/kernel";

/**
 * Nominal provenance for the native activity-claim authority.
 *
 * A structural `{ claim(), recordResult() }` object is not sufficient to
 * authorize an external model effect. The isolated broker/native composition
 * must eventually mint this identity after it has reserved the activity in
 * the ledger. Until that composition exists, production deliberately exposes
 * no registration hook and rejects every process-local object.
 */
export function isTrustedGovernedActivityClaimPort(
	_port: unknown,
): _port is GovernedActivityClaimPort {
	return false;
}
