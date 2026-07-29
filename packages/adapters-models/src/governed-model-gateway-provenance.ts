import type { GovernedModelActionGateway } from "./governed-api-worker.js";

/**
 * Nominal provenance for the credential-owning governed model ActionGateway.
 *
 * A frozen structural callback is not an authorization boundary. The required
 * isolated broker/native composition does not exist in this process yet, so
 * production exposes no gateway-registration hook. A JavaScript caller must
 * not be able to bless a credential-owning callback by importing this internal
 * source module.
 */
/** Always false until an isolated provider gateway composition is available. */
export function isTrustedGovernedModelActionGateway(
	_gateway: unknown,
): _gateway is GovernedModelActionGateway {
	return false;
}

/**
 * No production gateway can be consumed before the external broker supplies a
 * real capability; returning undefined preserves fail-closed construction.
 */
export function trustedGovernedModelActionGatewayAuthorizeAndComplete(
	_gateway: unknown,
): GovernedModelActionGateway["authorizeAndComplete"] | undefined {
	return undefined;
}
