import { spawnSync } from "node:child_process";
import { parse as parseUuid, stringify as stringifyUuid } from "uuid";

const INSTALLED_AUTHORITY_CLIENT =
	"/usr/libexec/buildplane/buildplane-authority-client";

export interface ProtectedPromotionExecutionInputV1 {
	readonly promotionDecisionEventId: string;
}

export type ProtectedPromotionExecutionResultV1 = {
	readonly status:
		| "rejected"
		| "pending"
		| "recorded"
		| "lease_expired"
		| "reconciliation_required";
};

function isCanonicalUuid(value: string): boolean {
	try {
		return stringifyUuid(parseUuid(value)) === value;
	} catch {
		return false;
	}
}

export async function executeProtectedPromotion(
	input: ProtectedPromotionExecutionInputV1,
): Promise<ProtectedPromotionExecutionResultV1 | undefined> {
	if (
		process.platform !== "linux" ||
		!isCanonicalUuid(input.promotionDecisionEventId)
	) {
		return undefined;
	}
	try {
		const result = spawnSync(INSTALLED_AUTHORITY_CLIENT, [], {
			input: JSON.stringify({
				schema_version: 1,
				operation: "execute_promotion",
				promotion_decision_event_id: input.promotionDecisionEventId,
			}),
			encoding: "utf8",
			env: {},
			shell: false,
			timeout: 10_000,
			maxBuffer: 1_024,
			windowsHide: true,
		});
		if (
			result.error !== undefined ||
			result.status !== 0 ||
			result.signal !== null ||
			result.stderr !== ""
		) {
			return undefined;
		}
		return parseProtectedPromotionExecutionResult(result.stdout);
	} catch {
		return undefined;
	}
}

function parseProtectedPromotionExecutionResult(
	source: string,
): ProtectedPromotionExecutionResultV1 | undefined {
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
		Object.keys(record).join(",") !== "schema_version,status" ||
		record.schema_version !== 1 ||
		![
			"rejected",
			"pending",
			"recorded",
			"lease_expired",
			"reconciliation_required",
		].includes(record.status as string)
	) {
		return undefined;
	}
	return Object.freeze({
		status: record.status as ProtectedPromotionExecutionResultV1["status"],
	});
}
