import { spawnSync } from "node:child_process";
import { parse as parseUuid, stringify as stringifyUuid } from "uuid";

const INSTALLED_AUTHORITY_CLIENT =
	"/usr/libexec/buildplane/buildplane-authority-client";
const SEALED_RESULT = '{"schema_version":1,"status":"sealed"}\n';
const RECONCILIATION_REQUIRED_RESULT =
	'{"schema_version":1,"status":"reconciliation_required"}\n';

export interface ProtectedPromotionDecisionInputV1 {
	readonly promotionApprovalRequestEventId: string;
	readonly decision: "promote" | "reject";
}

export type ProtectedPromotionDecisionStatusV1 =
	| "sealed"
	| "reconciliation_required";

function isCanonicalUuid(value: string): boolean {
	try {
		return stringifyUuid(parseUuid(value)) === value;
	} catch {
		return false;
	}
}

/**
 * Submit one recovery-only operator decision through the fixed native client.
 *
 * The executable, endpoint, environment, and arguments are not caller
 * configurable. `undefined` means blocked or externally ambiguous and is
 * never permission to retry or fall back to local authority.
 */
export async function submitProtectedPromotionDecision(
	input: ProtectedPromotionDecisionInputV1,
): Promise<ProtectedPromotionDecisionStatusV1 | undefined> {
	if (
		process.platform !== "linux" ||
		!isCanonicalUuid(input.promotionApprovalRequestEventId) ||
		(input.decision !== "promote" && input.decision !== "reject")
	) {
		return undefined;
	}
	const request = `${JSON.stringify({
		schema_version: 1,
		promotion_approval_request_event_id: input.promotionApprovalRequestEventId,
		decision: input.decision,
	})}`;
	try {
		const result = spawnSync(INSTALLED_AUTHORITY_CLIENT, [], {
			input: request,
			encoding: "utf8",
			env: {},
			shell: false,
			timeout: 10_000,
			maxBuffer: 1_024,
			windowsHide: true,
		});
		if (
			result.error !== undefined ||
			result.signal !== null ||
			result.status !== 0 ||
			result.stderr !== ""
		) {
			return undefined;
		}
		if (result.stdout === SEALED_RESULT) {
			return "sealed";
		}
		if (result.stdout === RECONCILIATION_REQUIRED_RESULT) {
			return "reconciliation_required";
		}
		return undefined;
	} catch {
		return undefined;
	}
}
