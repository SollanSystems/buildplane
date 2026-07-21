import { createHash } from "node:crypto";
import { canonicalSha256Digest } from "@buildplane/kernel";

/**
 * Native DispatchEnvelopeV3 predates an explicit policy-manifest field. Until
 * the next additive native envelope revision carries one, this fixed function
 * derives the action-plane policy binding solely from the already signed
 * acceptance-contract digest. No caller chooses this digest independently.
 */
export const GOVERNED_DISPATCH_POLICY_DIGEST_DOMAIN_V1 =
	"buildplane.governed-dispatch-policy.v1\0";

export function deriveGovernedDispatchPolicyDigestV1(
	acceptanceContractDigest: string,
): string {
	const canonicalAcceptanceContractDigest = canonicalSha256Digest(
		acceptanceContractDigest,
	);
	if (canonicalAcceptanceContractDigest !== acceptanceContractDigest) {
		throw new TypeError(
			"acceptanceContractDigest must be a canonical sha256: digest.",
		);
	}
	return `sha256:${createHash("sha256")
		.update(GOVERNED_DISPATCH_POLICY_DIGEST_DOMAIN_V1, "utf8")
		.update(canonicalAcceptanceContractDigest, "utf8")
		.digest("hex")}`;
}
