import {
	addNativeRfc3339UtcMilliseconds,
	addNativeRfc3339UtcNanoseconds,
	type NativeRfc3339UtcTimestamp,
	parseNativeRfc3339Utc,
} from "./native-rfc3339-utc.js";

/** The native sealed-dispatch contract stores compute budgets as `u32` ms. */
export const MAX_GOVERNED_COMPUTE_TIME_MS = 0xffff_ffff;

export interface GovernedDispatchAuthorityWindowInputV1 {
	readonly issuedAt: unknown;
	readonly expiresAt: unknown;
	readonly budget: unknown;
}

export type GovernedDispatchAuthorityWindowFailureV1 =
	| "invalid-clock"
	| "invalid-issued-at"
	| "invalid-expires-at"
	| "invalid-budget"
	| "invalid-window"
	| "not-yet-active"
	| "expired"
	| "compute-deadline-elapsed";

export type GovernedDispatchAuthorityWindowInspectionV1 =
	| {
			readonly state: "active";
			readonly issuedAt: NativeRfc3339UtcTimestamp;
			readonly expiresAt: NativeRfc3339UtcTimestamp;
			readonly effectiveDeadlineNanos: bigint;
			readonly deadlineSource: "expiry" | "compute";
	  }
	| {
			readonly state: "inactive";
			readonly failure: GovernedDispatchAuthorityWindowFailureV1;
	  };

export type GovernedDispatchAuthorityWindowValidationV1 =
	| {
			readonly state: "valid";
			readonly issuedAt: NativeRfc3339UtcTimestamp;
			readonly expiresAt: NativeRfc3339UtcTimestamp;
			readonly effectiveDeadlineNanos: bigint;
			readonly deadlineSource: "expiry" | "compute";
	  }
	| {
			readonly state: "invalid";
			readonly failure:
				| "invalid-issued-at"
				| "invalid-expires-at"
				| "invalid-budget"
				| "invalid-window";
	  };

/**
 * Validate immutable dispatch authority fields without deciding whether the
 * authority is live now. Reducers and replay projections retain expired
 * historical dispatches as status; effect boundaries use `inspect...` or
 * `assertActive...` immediately before an operation.
 */
export function validateGovernedDispatchAuthorityWindowV1(
	input: GovernedDispatchAuthorityWindowInputV1,
): GovernedDispatchAuthorityWindowValidationV1 {
	const issuedAt = parseNativeRfc3339Utc(input?.issuedAt);
	if (issuedAt === undefined) return invalid("invalid-issued-at");
	const expiresAt = parseNativeRfc3339Utc(input?.expiresAt);
	if (expiresAt === undefined) return invalid("invalid-expires-at");
	const maxComputeTimeMs = readMaxComputeTimeMs(input?.budget);
	if (maxComputeTimeMs === undefined) return invalid("invalid-budget");
	if (issuedAt.orderingNanos >= expiresAt.orderingNanos) {
		return invalid("invalid-window");
	}
	const computeDeadlineNanos =
		maxComputeTimeMs === null
			? undefined
			: addNativeRfc3339UtcMilliseconds(input.issuedAt, maxComputeTimeMs);
	if (
		maxComputeTimeMs !== null &&
		(computeDeadlineNanos === undefined ||
			computeDeadlineNanos <= issuedAt.orderingNanos)
	) {
		return invalid("invalid-budget");
	}
	const deadlineSource =
		computeDeadlineNanos !== undefined &&
		computeDeadlineNanos < expiresAt.orderingNanos
			? "compute"
			: "expiry";
	return Object.freeze({
		state: "valid",
		issuedAt,
		expiresAt,
		effectiveDeadlineNanos:
			deadlineSource === "compute"
				? (computeDeadlineNanos as bigint)
				: expiresAt.orderingNanos,
		deadlineSource,
	});
}

/**
 * Inspect one sealed dispatch authority window using the exact timestamp
 * ordering used by the native reducer. JavaScript clocks expose milliseconds,
 * so the lower/upper bounds deliberately fail closed for a fractional timestamp
 * that might still be in the future or already elapsed inside the current ms.
 */
export function inspectGovernedDispatchAuthorityWindowV1(
	input: GovernedDispatchAuthorityWindowInputV1,
	now: number | string = Date.now(),
): GovernedDispatchAuthorityWindowInspectionV1 {
	const bounds = authorityNowBounds(now);
	if (bounds === undefined) {
		return inactive("invalid-clock");
	}
	const { nowFloor, nowCeiling } = bounds;

	const validation = validateGovernedDispatchAuthorityWindowV1(input);
	if (validation.state === "invalid") return inactive(validation.failure);
	const { issuedAt, expiresAt, effectiveDeadlineNanos, deadlineSource } =
		validation;
	if (issuedAt.orderingNanos > nowFloor.orderingNanos) {
		return inactive("not-yet-active");
	}
	if (effectiveDeadlineNanos <= nowCeiling.orderingNanos) {
		return inactive(
			deadlineSource === "compute" ? "compute-deadline-elapsed" : "expired",
		);
	}
	return Object.freeze({
		state: "active",
		issuedAt,
		expiresAt,
		effectiveDeadlineNanos,
		deadlineSource,
	});
}

export function assertActiveGovernedDispatchAuthorityWindowV1(
	input: GovernedDispatchAuthorityWindowInputV1,
	now: number | string = Date.now(),
): Extract<GovernedDispatchAuthorityWindowInspectionV1, { state: "active" }> {
	const inspection = inspectGovernedDispatchAuthorityWindowV1(input, now);
	if (inspection.state === "inactive") {
		throw new TypeError(
			`governed dispatch authority window is ${inspection.failure.replaceAll("-", " ")}.`,
		);
	}
	return inspection;
}

function authorityNowBounds(now: number | string):
	| {
			readonly nowFloor: NativeRfc3339UtcTimestamp;
			readonly nowCeiling: NativeRfc3339UtcTimestamp;
	  }
	| undefined {
	if (typeof now === "string") {
		return authorityNowStringBounds(now);
	}
	if (!Number.isSafeInteger(now)) return undefined;
	try {
		const nowFloor = parseNativeRfc3339Utc(new Date(now).toISOString());
		const nowCeiling = parseNativeRfc3339Utc(new Date(now + 1).toISOString());
		return nowFloor === undefined || nowCeiling === undefined
			? undefined
			: Object.freeze({ nowFloor, nowCeiling });
	} catch {
		return undefined;
	}
}

/**
 * A string clock is exact only to the fractional precision it carries. In
 * particular, `Date#toISOString()` has millisecond precision, so treating it
 * as a nanosecond-exact observation would allow a dispatch to cross a
 * sub-millisecond authority boundary between observations. Use the next
 * representable value at the supplied precision as a fail-closed ceiling.
 */
function authorityNowStringBounds(now: string):
	| {
			readonly nowFloor: NativeRfc3339UtcTimestamp;
			readonly nowCeiling: NativeRfc3339UtcTimestamp;
	  }
	| undefined {
	const nowFloor = parseNativeRfc3339Utc(now);
	const match = /\.(\d+)(?:Z)$/.exec(now);
	if (nowFloor === undefined) return undefined;
	const fractionalDigits = match?.[1].length ?? 0;
	if (fractionalDigits === 9) {
		return Object.freeze({ nowFloor, nowCeiling: nowFloor });
	}
	// Native parsing retains nine fractional digits. More source digits denote
	// an interval inside that retained nanosecond rather than an exact clock.
	const retainedFractionalDigits = Math.min(fractionalDigits, 9);
	const precisionNanos = 10n ** BigInt(9 - retainedFractionalDigits);
	const ceilingOrderingNanos = addNativeRfc3339UtcNanoseconds(
		now,
		precisionNanos,
	);
	if (ceilingOrderingNanos === undefined) return undefined;
	return Object.freeze({
		nowFloor,
		nowCeiling: Object.freeze({
			text: now,
			orderingNanos: ceilingOrderingNanos,
		}),
	});
}

function readMaxComputeTimeMs(value: unknown): number | null | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	if (!Object.hasOwn(value, "maxComputeTimeMs")) {
		// The existing sealed V3 contract permits an omitted compute cap. Its
		// authority remains bounded by expiresAt; an explicitly supplied cap is
		// validated below and can only tighten that deadline.
		return null;
	}
	const maxComputeTimeMs = (value as { maxComputeTimeMs?: unknown })
		.maxComputeTimeMs;
	if (
		typeof maxComputeTimeMs !== "number" ||
		!Number.isSafeInteger(maxComputeTimeMs) ||
		maxComputeTimeMs < 1 ||
		maxComputeTimeMs > MAX_GOVERNED_COMPUTE_TIME_MS
	) {
		return undefined;
	}
	return maxComputeTimeMs;
}

function inactive(
	failure: GovernedDispatchAuthorityWindowFailureV1,
): Extract<GovernedDispatchAuthorityWindowInspectionV1, { state: "inactive" }> {
	return Object.freeze({ state: "inactive", failure });
}

function invalid(
	failure: Extract<
		GovernedDispatchAuthorityWindowFailureV1,
		| "invalid-issued-at"
		| "invalid-expires-at"
		| "invalid-budget"
		| "invalid-window"
	>,
): Extract<GovernedDispatchAuthorityWindowValidationV1, { state: "invalid" }> {
	return Object.freeze({ state: "invalid", failure });
}
