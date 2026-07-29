import { createHash } from "node:crypto";
import type {
	DurableActionReceiptReferenceV2,
	GovernedDispatchLineageV3,
} from "./ports.js";

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RFC3339_UTC_PATTERN =
	/^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})[Tt ](?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.\d+)?Z$/;
const U32_MAX = 0xffff_ffff;
const RETRY_REQUEST_DIGEST_DOMAIN = "buildplane.governed-v3-retry-request.v1\0";
const ATTEMPT_CONTEXT_DIGEST_DOMAIN =
	"buildplane.attempt-context-recorded.v1\0";

/**
 * Exact durable action receipt identities available from the failed V3
 * execution. The structural resolver must select one of these receipts; it cannot point a
 * retry context at an unrelated action.
 */
export interface GovernedV3RetryPredecessorActionV1 {
	readonly actionId: string;
	readonly actionReceiptRef: string;
	readonly actionReceiptDigest: string;
}

/**
 * Immutable kernel request to the structural retry-context resolver. It
 * carries facts already admitted for the failed sealed-V3 execution, never a
 * TypeScript-generated authority or a next dispatch.
 */
export interface GovernedV3RetryRequestV1 {
	readonly schemaVersion: 1;
	readonly runId: string;
	readonly workflowId: string;
	readonly workflowRevision: string;
	readonly unitId: string;
	readonly priorAttempt: number;
	readonly nextAttempt: number;
	readonly priorDispatchEnvelopeDigest: string;
	readonly priorDispatchIdempotencyKey: string;
	readonly governedPacketDigest: string;
	readonly predecessorActions: readonly GovernedV3RetryPredecessorActionV1[];
	readonly feedbackContext: readonly string[];
}

/**
 * Closed, native-shaped `attempt_context_recorded_v1` data returned by the
 * TypeScript resolver. Its digest is only a structural consistency check: this
 * type carries neither a native signature nor tape-inclusion proof and must
 * never itself authorize retry execution.
 */
export interface UntrustedAttemptContextRecordedV1 {
	readonly runId: string;
	readonly workflowId: string;
	readonly workflowRevision: string;
	readonly unitId: string;
	readonly priorAttempt: number;
	readonly nextAttempt: number;
	readonly priorDispatchEnvelopeDigest: string;
	readonly priorTerminalEventRef: string;
	readonly priorTerminalEventDigest: string;
	readonly priorActionReceiptRef: string;
	readonly priorActionReceiptDigest: string;
	readonly feedbackRef: string;
	readonly feedbackDigest: string;
	readonly nextDispatchEnvelopeDigest: string;
	readonly nextDispatchIdempotencyKey: string;
	readonly retryActionNamespace: string;
	readonly idempotencyKey: string;
	readonly recordedAt: string;
	readonly attemptContextDigest: string;
}

/**
 * Closed, untrusted resolver response. It must bind the exact immutable
 * request, but is not an authority response or a native attestation.
 */
export interface UntrustedGovernedV3RetryContextResolutionV1 {
	readonly schemaVersion: 1;
	readonly retryRequestDigest: string;
	/** Exact action identity claimed for the prior receipt. */
	readonly predecessorAction: GovernedV3RetryPredecessorActionV1;
	readonly untrustedAttemptContext: UntrustedAttemptContextRecordedV1;
}

/**
 * Host-injected seam for structural retry-context lookup. The returned data is
 * deliberately untrusted: TypeScript can check its shape and digest, but
 * cannot verify native signature or tape proof. `null`/`undefined` means no
 * context was resolved.
 */
export interface GovernedV3RetryContextResolverPort {
	resolveUntrustedAttemptContext(
		input: GovernedV3RetryRequestV1,
	): Promise<UntrustedGovernedV3RetryContextResolutionV1 | null | undefined>;
}

/**
 * Structural inspection result only. Even the success variant explicitly says
 * that native attestation is still required, so it cannot be mistaken for
 * retry authority.
 */
export type UntrustedGovernedV3RetryContextInspection =
	| {
			readonly status: "structurally-consistent-untrusted";
			readonly nativeAttestation: "required";
			readonly untrustedAttemptContext: UntrustedAttemptContextRecordedV1;
	  }
	| {
			readonly status: "malformed" | "mismatch";
			readonly message: string;
	  };

/**
 * Construct the one immutable request allowed to leave the kernel. This does
 * not create a retry context or a next dispatch; both remain outside this
 * structural-inspection seam.
 */
export function createGovernedV3RetryRequestV1(input: {
	readonly dispatch: GovernedDispatchLineageV3;
	readonly nextAttempt: number;
	readonly feedbackContext: readonly string[];
	readonly predecessorActions: readonly DurableActionReceiptReferenceV2[];
}): GovernedV3RetryRequestV1 {
	const request: GovernedV3RetryRequestV1 = {
		schemaVersion: 1,
		runId: input.dispatch.runId,
		workflowId: input.dispatch.workflowId,
		workflowRevision: input.dispatch.workflowRevision,
		unitId: input.dispatch.unitId,
		priorAttempt: input.dispatch.attempt,
		nextAttempt: input.nextAttempt,
		priorDispatchEnvelopeDigest: input.dispatch.envelopeDigest,
		priorDispatchIdempotencyKey: input.dispatch.idempotencyKey,
		governedPacketDigest: input.dispatch.governedPacketDigest,
		predecessorActions: Object.freeze(
			input.predecessorActions
				.map((action) =>
					Object.freeze({
						actionId: action.actionId,
						actionReceiptRef: action.actionReceiptRef,
						actionReceiptDigest: action.actionReceiptDigest,
					}),
				)
				.sort((left, right) =>
					left.actionId === right.actionId
						? 0
						: left.actionId < right.actionId
							? -1
							: 1,
				),
		),
		feedbackContext: Object.freeze([...input.feedbackContext]),
	};
	return Object.freeze(request);
}

/** Exact canonical digest over the immutable structural resolver request. */
export function canonicalGovernedV3RetryRequestV1Digest(
	input: GovernedV3RetryRequestV1,
): string {
	return canonicalDigest(RETRY_REQUEST_DIGEST_DOMAIN, {
		run_id: input.runId,
		workflow_id: input.workflowId,
		workflow_revision: input.workflowRevision,
		unit_id: input.unitId,
		prior_attempt: input.priorAttempt,
		next_attempt: input.nextAttempt,
		prior_dispatch_envelope_digest: input.priorDispatchEnvelopeDigest,
		prior_dispatch_idempotency_key: input.priorDispatchIdempotencyKey,
		governed_packet_digest: input.governedPacketDigest,
		predecessor_actions: [...input.predecessorActions]
			.sort((left, right) =>
				left.actionId === right.actionId
					? 0
					: left.actionId < right.actionId
						? -1
						: 1,
			)
			.map((action) => ({
				action_id: action.actionId,
				action_receipt_ref: action.actionReceiptRef,
				action_receipt_digest: action.actionReceiptDigest,
			})),
		feedback_context: [...input.feedbackContext],
	});
}

/**
 * Exact native `attempt_context_recorded_v1` digest over untrusted structural
 * data. This preserves every supplied `recordedAt` byte; computing it does not
 * attest, sign, or authorize the context.
 */
export function canonicalUntrustedAttemptContextRecordedV1Digest(
	input: Omit<UntrustedAttemptContextRecordedV1, "attemptContextDigest">,
): string {
	return canonicalDigest(ATTEMPT_CONTEXT_DIGEST_DOMAIN, {
		run_id: input.runId,
		workflow_id: input.workflowId,
		workflow_revision: input.workflowRevision,
		unit_id: input.unitId,
		prior_attempt: input.priorAttempt,
		next_attempt: input.nextAttempt,
		prior_dispatch_envelope_digest: input.priorDispatchEnvelopeDigest,
		prior_terminal_event_ref: input.priorTerminalEventRef,
		prior_terminal_event_digest: input.priorTerminalEventDigest,
		prior_action_receipt_ref: input.priorActionReceiptRef,
		prior_action_receipt_digest: input.priorActionReceiptDigest,
		feedback_ref: input.feedbackRef,
		feedback_digest: input.feedbackDigest,
		next_dispatch_envelope_digest: input.nextDispatchEnvelopeDigest,
		next_dispatch_idempotency_key: input.nextDispatchIdempotencyKey,
		retry_action_namespace: input.retryActionNamespace,
		idempotency_key: input.idempotencyKey,
		recorded_at: input.recordedAt,
	});
}

/**
 * Inspect an untrusted resolver response for native-shaped structural
 * consistency. A successful inspection is explicitly not native attestation
 * and must never permit a second worker execution by itself.
 */
export function inspectUntrustedGovernedV3RetryContextResolution(
	request: GovernedV3RetryRequestV1,
	resolution: unknown,
): UntrustedGovernedV3RetryContextInspection {
	let parsed: UntrustedGovernedV3RetryContextResolutionV1;
	try {
		parsed = parseResolution(resolution);
	} catch (error) {
		return failure("malformed", error);
	}

	let expectedRequestDigest: string;
	try {
		expectedRequestDigest = canonicalGovernedV3RetryRequestV1Digest(request);
	} catch (error) {
		return failure("malformed", error);
	}
	if (parsed.retryRequestDigest !== expectedRequestDigest) {
		return {
			status: "mismatch",
			message:
				"untrusted retry-context response does not bind the exact governed V3 retry request.",
		};
	}

	const context = parsed.untrustedAttemptContext;
	if (
		context.runId !== request.runId ||
		context.workflowId !== request.workflowId ||
		context.workflowRevision !== request.workflowRevision ||
		context.unitId !== request.unitId ||
		context.priorAttempt !== request.priorAttempt ||
		context.nextAttempt !== request.nextAttempt ||
		context.priorDispatchEnvelopeDigest !== request.priorDispatchEnvelopeDigest
	) {
		return {
			status: "mismatch",
			message:
				"untrusted attempt context does not bind the exact run, workflow, unit, attempt, and prior sealed V3 dispatch.",
		};
	}
	if (
		context.nextDispatchEnvelopeDigest ===
			request.priorDispatchEnvelopeDigest ||
		context.nextDispatchIdempotencyKey ===
			request.priorDispatchIdempotencyKey ||
		context.retryActionNamespace === request.priorDispatchIdempotencyKey ||
		context.nextDispatchIdempotencyKey === context.retryActionNamespace ||
		context.nextDispatchIdempotencyKey === context.idempotencyKey ||
		context.retryActionNamespace === context.idempotencyKey
	) {
		return {
			status: "mismatch",
			message:
				"untrusted attempt context reuses or conflates a prior dispatch, retry namespace, or context idempotency identity.",
		};
	}
	if (
		parsed.predecessorAction.actionReceiptRef !==
			context.priorActionReceiptRef ||
		parsed.predecessorAction.actionReceiptDigest !==
			context.priorActionReceiptDigest
	) {
		return {
			status: "mismatch",
			message:
				"untrusted predecessor action does not match the structural attempt-context receipt binding.",
		};
	}
	const matchingPredecessors = request.predecessorActions.filter(
		(action) =>
			action.actionId === parsed.predecessorAction.actionId &&
			action.actionReceiptRef === context.priorActionReceiptRef &&
			action.actionReceiptDigest === context.priorActionReceiptDigest,
	);
	if (matchingPredecessors.length !== 1) {
		return {
			status: "mismatch",
			message:
				"untrusted attempt context does not bind exactly one durable predecessor action receipt from the failed V3 execution.",
		};
	}
	return {
		status: "structurally-consistent-untrusted",
		nativeAttestation: "required",
		untrustedAttemptContext: context,
	};
}

function parseResolution(
	input: unknown,
): UntrustedGovernedV3RetryContextResolutionV1 {
	const record = readClosedRecord(
		input,
		"untrustedGovernedV3RetryContextResolution",
		[
			"schemaVersion",
			"retryRequestDigest",
			"predecessorAction",
			"untrustedAttemptContext",
		],
	);
	if (record.schemaVersion !== 1) {
		throw new TypeError(
			"untrustedGovernedV3RetryContextResolution.schemaVersion must be 1.",
		);
	}
	return {
		schemaVersion: 1,
		retryRequestDigest: readSha256Digest(
			record,
			"retryRequestDigest",
			"untrustedGovernedV3RetryContextResolution",
		),
		predecessorAction: parsePredecessorAction(record.predecessorAction),
		untrustedAttemptContext: parseAttemptContext(
			record.untrustedAttemptContext,
		),
	};
}

function parsePredecessorAction(
	input: unknown,
): GovernedV3RetryPredecessorActionV1 {
	const record = readClosedRecord(input, "governedV3RetryPredecessorAction", [
		"actionId",
		"actionReceiptRef",
		"actionReceiptDigest",
	]);
	return Object.freeze({
		actionId: readNonEmptyString(
			record,
			"actionId",
			"governedV3RetryPredecessorAction",
		),
		actionReceiptRef: readNonEmptyString(
			record,
			"actionReceiptRef",
			"governedV3RetryPredecessorAction",
		),
		actionReceiptDigest: readSha256Digest(
			record,
			"actionReceiptDigest",
			"governedV3RetryPredecessorAction",
		),
	});
}

function parseAttemptContext(
	input: unknown,
): UntrustedAttemptContextRecordedV1 {
	const label = "untrustedAttemptContextRecordedV1";
	const record = readClosedRecord(input, label, [
		"runId",
		"workflowId",
		"workflowRevision",
		"unitId",
		"priorAttempt",
		"nextAttempt",
		"priorDispatchEnvelopeDigest",
		"priorTerminalEventRef",
		"priorTerminalEventDigest",
		"priorActionReceiptRef",
		"priorActionReceiptDigest",
		"feedbackRef",
		"feedbackDigest",
		"nextDispatchEnvelopeDigest",
		"nextDispatchIdempotencyKey",
		"retryActionNamespace",
		"idempotencyKey",
		"recordedAt",
		"attemptContextDigest",
	]);
	const context: UntrustedAttemptContextRecordedV1 = {
		runId: readNonEmptyString(record, "runId", label),
		workflowId: readNonEmptyString(record, "workflowId", label),
		workflowRevision: readNonEmptyString(record, "workflowRevision", label),
		unitId: readNonEmptyString(record, "unitId", label),
		priorAttempt: readPositiveU32(record, "priorAttempt", label),
		nextAttempt: readPositiveU32(record, "nextAttempt", label),
		priorDispatchEnvelopeDigest: readSha256Digest(
			record,
			"priorDispatchEnvelopeDigest",
			label,
		),
		priorTerminalEventRef: readNonEmptyString(
			record,
			"priorTerminalEventRef",
			label,
		),
		priorTerminalEventDigest: readSha256Digest(
			record,
			"priorTerminalEventDigest",
			label,
		),
		priorActionReceiptRef: readNonEmptyString(
			record,
			"priorActionReceiptRef",
			label,
		),
		priorActionReceiptDigest: readSha256Digest(
			record,
			"priorActionReceiptDigest",
			label,
		),
		feedbackRef: readNonEmptyString(record, "feedbackRef", label),
		feedbackDigest: readSha256Digest(record, "feedbackDigest", label),
		nextDispatchEnvelopeDigest: readSha256Digest(
			record,
			"nextDispatchEnvelopeDigest",
			label,
		),
		nextDispatchIdempotencyKey: readNonEmptyString(
			record,
			"nextDispatchIdempotencyKey",
			label,
		),
		retryActionNamespace: readNonEmptyString(
			record,
			"retryActionNamespace",
			label,
		),
		idempotencyKey: readNonEmptyString(record, "idempotencyKey", label),
		recordedAt: readRfc3339Utc(record, "recordedAt", label),
		attemptContextDigest: readSha256Digest(
			record,
			"attemptContextDigest",
			label,
		),
	};
	if (context.priorAttempt + 1 !== context.nextAttempt) {
		throw new TypeError(
			`${label}.nextAttempt must be exactly one greater than priorAttempt.`,
		);
	}
	if (
		context.nextDispatchIdempotencyKey === context.idempotencyKey ||
		context.nextDispatchIdempotencyKey === context.retryActionNamespace ||
		context.idempotencyKey === context.retryActionNamespace
	) {
		throw new TypeError(
			`${label} dispatch, retry-action, and context idempotency keys must be distinct.`,
		);
	}
	const expectedDigest =
		canonicalUntrustedAttemptContextRecordedV1Digest(context);
	if (context.attemptContextDigest !== expectedDigest) {
		throw new TypeError(
			`${label}.attemptContextDigest does not match canonical retry lineage.`,
		);
	}
	return Object.freeze(context);
}

function readClosedRecord(
	input: unknown,
	label: string,
	expectedFields: readonly string[],
): Record<string, unknown> {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		throw new TypeError(`${label} must be a closed object.`);
	}
	let keys: string[];
	let symbols: symbol[];
	try {
		keys = Object.getOwnPropertyNames(input);
		symbols = Object.getOwnPropertySymbols(input);
	} catch {
		throw new TypeError(`${label} must be a closed data object.`);
	}
	if (
		symbols.length > 0 ||
		keys.length !== expectedFields.length ||
		!expectedFields.every((field) => keys.includes(field))
	) {
		throw new TypeError(
			`${label} must contain exactly its closed schema fields.`,
		);
	}
	const record = input as Record<string, unknown>;
	const snapshot: Record<string, unknown> = Object.create(null);
	for (const field of expectedFields) {
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(record, field);
		} catch {
			throw new TypeError(`${label}.${field} must be a data property.`);
		}
		if (!descriptor || !("value" in descriptor)) {
			throw new TypeError(`${label}.${field} must be a data property.`);
		}
		// Never read through `record[field]` after inspection. An untrusted
		// Proxy can return a different value from its `get` trap than the data
		// descriptor we just validated. The closed-schema parser operates only
		// on this descriptor snapshot, so canonical digest checks see one stable
		// set of bytes and no user-defined getters execute.
		snapshot[field] = descriptor.value;
	}
	return Object.freeze(snapshot);
}

function readNonEmptyString(
	record: Record<string, unknown>,
	field: string,
	label: string,
): string {
	const value = record[field];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${label}.${field} must be a non-empty string.`);
	}
	return value;
}

function readSha256Digest(
	record: Record<string, unknown>,
	field: string,
	label: string,
): string {
	const value = readNonEmptyString(record, field, label);
	if (!SHA256_DIGEST_PATTERN.test(value)) {
		throw new TypeError(
			`${label}.${field} must be a lowercase SHA-256 digest.`,
		);
	}
	return value;
}

function readPositiveU32(
	record: Record<string, unknown>,
	field: string,
	label: string,
): number {
	const value = record[field];
	if (
		!Number.isSafeInteger(value) ||
		(value as number) < 1 ||
		(value as number) > U32_MAX
	) {
		throw new TypeError(`${label}.${field} must be a positive u32 integer.`);
	}
	return value as number;
}

/**
 * Mirrors native `validate_rfc3339_utc`: Chrono-compatible RFC3339 input that
 * ends in uppercase `Z`. Keep the raw string because native digest material
 * includes its exact `recorded_at` bytes.
 */
function readRfc3339Utc(
	record: Record<string, unknown>,
	field: string,
	label: string,
): string {
	const value = readNonEmptyString(record, field, label);
	const match = RFC3339_UTC_PATTERN.exec(value);
	if (!match?.groups) {
		throw new TypeError(`${label}.${field} must be an RFC3339 UTC timestamp.`);
	}
	const year = Number(match.groups.year);
	const month = Number(match.groups.month);
	const day = Number(match.groups.day);
	const hour = Number(match.groups.hour);
	const minute = Number(match.groups.minute);
	const second = Number(match.groups.second);
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > daysInProlepticGregorianMonth(year, month) ||
		hour > 23 ||
		minute > 59 ||
		second > 60
	) {
		throw new TypeError(
			`${label}.${field} must be a real RFC3339 UTC timestamp.`,
		);
	}
	return value;
}

/**
 * Mirrors Chrono's `NaiveDate::from_ymd_opt` calendar range check for the
 * four-digit years accepted by native `DateTime::parse_from_rfc3339`, including
 * year zero. Leap second 60 is range-checked separately by `readRfc3339Utc`.
 */
function daysInProlepticGregorianMonth(year: number, month: number): number {
	if (month === 2) {
		return isProlepticGregorianLeapYear(year) ? 29 : 28;
	}
	return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isProlepticGregorianLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function canonicalDigest(domain: string, value: unknown): string {
	const json = JSON.stringify(value);
	if (json === undefined) {
		throw new TypeError(
			"canonical retry-context payload must be JSON serializable.",
		);
	}
	return `sha256:${createHash("sha256")
		.update(domain, "utf8")
		.update(json, "utf8")
		.digest("hex")}`;
}

function failure(
	failureKind: "malformed" | "mismatch",
	error: unknown,
): Extract<
	UntrustedGovernedV3RetryContextInspection,
	{ readonly status: "malformed" | "mismatch" }
> {
	return {
		status: failureKind,
		message: error instanceof Error ? error.message : String(error),
	};
}
