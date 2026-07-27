import { spawnSync } from "node:child_process";
import { parse as parseUuid, stringify as stringifyUuid } from "uuid";

const INSTALLED_AUTHORITY_CLIENT =
	"/usr/libexec/buildplane/buildplane-authority-client";
export interface ProtectedPromotionDecisionInputV1 {
	readonly promotionApprovalRequestEventId: string;
	readonly decision: "promote" | "reject";
}

export type ProtectedPromotionDecisionResultV2 =
	| {
			readonly status: "sealed";
			readonly promotionDecisionEventId: string;
	  }
	| {
			readonly status: "reconciliation_required";
	  };

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
): Promise<ProtectedPromotionDecisionResultV2 | undefined> {
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
		return parseProtectedPromotionDecisionResult(result.stdout);
	} catch {
		return undefined;
	}
}

function parseProtectedPromotionDecisionResult(
	source: string,
): ProtectedPromotionDecisionResultV2 | undefined {
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch {
		return undefined;
	}
	if (
		typeof value !== "object" ||
		value === null ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		`${JSON.stringify(value)}\n` !== source
	) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).join(",") !==
			"schema_version,status,promotion_decision_event_id" ||
		record.schema_version !== 2
	) {
		return undefined;
	}
	if (
		record.status === "sealed" &&
		typeof record.promotion_decision_event_id === "string" &&
		isCanonicalUuid(record.promotion_decision_event_id)
	) {
		return Object.freeze({
			status: "sealed" as const,
			promotionDecisionEventId: record.promotion_decision_event_id,
		});
	}
	if (
		record.status === "reconciliation_required" &&
		record.promotion_decision_event_id === null
	) {
		return Object.freeze({ status: "reconciliation_required" as const });
	}
	return undefined;
}
