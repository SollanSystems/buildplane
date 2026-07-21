/**
 * Wire protocol primitives for the bp-ledger IPC.
 *
 * Control messages go TS -> Rust on stdin (via string lines) and Rust -> TS on
 * stderr (as JSON ack lines). This file has no I/O — it builds strings and
 * parses strings.
 */

export interface HandshakeArgs {
	protocol: number;
	runId: string;
	startedAt: string;
	schemaVersion: number;
}

export function buildHandshake(args: HandshakeArgs): string {
	return `${JSON.stringify({
		control: "handshake",
		protocol: args.protocol,
		run_id: args.runId,
		started_at: args.startedAt,
		schema_version: args.schemaVersion,
	})}\n`;
}

export function buildFlush(seq: number): string {
	return `{"control":"flush","seq":${seq}}\n`;
}

export function buildClose(seq: number): string {
	return `{"control":"close","seq":${seq}}\n`;
}

/**
 * A write-ahead claim for one nondeterministic governed activity.  The
 * native ledger verifies the dispatch/action-request lineage before it grants
 * the lease; callers must never perform the effect for any non-granted
 * response.
 */
export interface ClaimActivityV1Args {
	requestId: string;
	runId: string;
	activityId: string;
	idempotencyKey: string;
	dispatchEventId: string;
	actionRequestEventId: string;
	/** Must be between 1 second and 15 minutes, inclusive. */
	leaseDurationMs: number;
}

/** Build the closed `claim_activity_v1` control request. */
export function buildClaimActivityV1(args: ClaimActivityV1Args): string {
	assertNonEmptyActivityFields(args, [
		"requestId",
		"runId",
		"activityId",
		"idempotencyKey",
		"dispatchEventId",
		"actionRequestEventId",
	]);
	if (
		!Number.isSafeInteger(args.leaseDurationMs) ||
		args.leaseDurationMs < 1_000 ||
		args.leaseDurationMs > 900_000
	) {
		throw new RangeError(
			"claim_activity_v1 leaseDurationMs must be an integer from 1000 through 900000",
		);
	}
	return `${JSON.stringify({
		control: "claim_activity_v1",
		request_id: args.requestId,
		run_id: args.runId,
		activity_id: args.activityId,
		idempotency_key: args.idempotencyKey,
		dispatch_event_id: args.dispatchEventId,
		action_request_event_id: args.actionRequestEventId,
		lease_duration_ms: args.leaseDurationMs,
	})}\n`;
}

/** JSONL control-wire spelling of the generated ActivityResultOutcomeV1 enum. */
export type ActivityResultOutcomeWireV1 = "succeeded" | "failed" | "unknown";

/**
 * The terminal record for an activity lease. `result*` stays explicit on the
 * wire, including when absent, while outcome evidence is always required so a
 * failed or unknown effect still leaves independently inspectable evidence.
 */
export interface RecordActivityResultV1Args {
	requestId: string;
	runId: string;
	activityId: string;
	idempotencyKey: string;
	leaseId: string;
	outcome: ActivityResultOutcomeWireV1;
	resultDigest: string | null;
	resultRef: string | null;
	evidenceDigest: string;
	evidenceRef: string;
}

/** Build the closed `record_activity_result_v1` control request. */
export function buildRecordActivityResultV1(
	args: RecordActivityResultV1Args,
): string {
	assertNonEmptyActivityFields(args, [
		"requestId",
		"runId",
		"activityId",
		"idempotencyKey",
		"leaseId",
		"evidenceDigest",
		"evidenceRef",
	]);
	if (
		args.outcome !== "succeeded" &&
		args.outcome !== "failed" &&
		args.outcome !== "unknown"
	) {
		throw new TypeError(
			"record_activity_result_v1 outcome must be succeeded, failed, or unknown",
		);
	}
	assertNullablePair(
		"record_activity_result_v1 result",
		args.resultDigest,
		args.resultRef,
	);
	if (args.resultDigest !== null) {
		assertCanonicalSha256(
			"record_activity_result_v1 resultDigest",
			args.resultDigest,
		);
	}
	assertCanonicalSha256(
		"record_activity_result_v1 evidenceDigest",
		args.evidenceDigest,
	);
	if (
		args.outcome === "succeeded" &&
		(args.resultDigest === null || args.resultRef === null)
	) {
		throw new TypeError(
			"record_activity_result_v1 succeeded outcome requires resultDigest and resultRef",
		);
	}
	if (
		args.outcome === "unknown" &&
		(args.resultDigest !== null || args.resultRef !== null)
	) {
		throw new TypeError(
			"record_activity_result_v1 unknown outcome forbids resultDigest and resultRef",
		);
	}
	return `${JSON.stringify({
		control: "record_activity_result_v1",
		request_id: args.requestId,
		run_id: args.runId,
		activity_id: args.activityId,
		idempotency_key: args.idempotencyKey,
		lease_id: args.leaseId,
		outcome: args.outcome,
		result_digest: args.resultDigest,
		result_ref: args.resultRef,
		evidence_digest: args.evidenceDigest,
		evidence_ref: args.evidenceRef,
	})}\n`;
}

/**
 * Request an authority-owned heartbeat for an already-issued activity lease.
 *
 * The caller can name only the durable action and its opaque lease. The
 * native authority reconstructs the signed claim/dispatch lineage, chooses
 * the bounded extension, and records the signed heartbeat. Callers cannot
 * supply a dispatch, timestamp, expiry, or signed-heartbeat payload.
 */
export interface HeartbeatActivityV1Args {
	requestId: string;
	runId: string;
	activityId: string;
	idempotencyKey: string;
	leaseId: string;
	/** Caller-selected, one-extension idempotency key. */
	heartbeatId: string;
}

/** Build the closed `heartbeat_activity_v1` authority request. */
export function buildHeartbeatActivityV1(
	args: HeartbeatActivityV1Args,
): string {
	assertNonEmptyActivityFields(args, [
		"requestId",
		"runId",
		"activityId",
		"idempotencyKey",
		"leaseId",
		"heartbeatId",
	]);
	return `${JSON.stringify({
		control: "heartbeat_activity_v1",
		request_id: args.requestId,
		run_id: args.runId,
		activity_id: args.activityId,
		idempotency_key: args.idempotencyKey,
		lease_id: args.leaseId,
		heartbeat_id: args.heartbeatId,
	})}\n`;
}

function assertNonEmptyActivityFields(
	value: object,
	fields: readonly string[],
): void {
	const record = value as Record<string, unknown>;
	for (const field of fields) {
		if (
			typeof record[field] !== "string" ||
			record[field].trim().length === 0
		) {
			throw new TypeError(`${field} must be a non-empty string`);
		}
	}
}

function assertNullablePair(
	label: string,
	digest: string | null,
	ref: string | null,
): void {
	if ((digest === null) !== (ref === null)) {
		throw new TypeError(`${label} digest and ref must be provided together`);
	}
	for (const [field, value] of [
		["digest", digest],
		["ref", ref],
	] as const) {
		if (
			value !== null &&
			(typeof value !== "string" || value.trim().length === 0)
		) {
			throw new TypeError(
				`${label} ${field} must be a non-empty string or null`,
			);
		}
	}
}

function assertCanonicalSha256(field: string, value: string): void {
	if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
		throw new TypeError(`${field} must be a canonical sha256 digest`);
	}
}

export interface HandshakeAck {
	control: "handshake_ack";
	ready: boolean;
	ledger_version?: string;
	schema_version?: number;
	reason?: string;
}

export interface FlushAck {
	control: "flush_ack";
	seq: number;
	last_event_id: string;
}

export interface CloseAck {
	control: "close_ack";
	events_written: number;
	last_event_id: string;
}

export interface ErrorLine {
	control: "error";
	kind: string;
	line: number;
	message: string;
}

export interface ActivityClaimGrantedLine {
	control: "claim_activity_v1_result";
	request_id: string;
	outcome: "granted";
	claim_event_id: string;
	claim_event_digest: string;
	lease_id: string;
	lease_expires_at: string;
}

export interface ActivityClaimPendingLine {
	control: "claim_activity_v1_result";
	request_id: string;
	outcome: "pending";
	claim_event_id: string;
	lease_expires_at: string;
}

export interface ActivityClaimRecordedLine {
	control: "claim_activity_v1_result";
	request_id: string;
	outcome: "recorded";
	claim_event_id: string;
	result_event_id: string;
	result_event_digest: string;
	result_outcome: ActivityResultOutcomeWireV1;
}

export interface ActivityClaimLeaseExpiredLine {
	control: "claim_activity_v1_result";
	request_id: string;
	outcome: "lease_expired";
	claim_event_id: string;
	lease_expires_at: string;
}

export interface ActivityClaimRejectedLine {
	control: "claim_activity_v1_result";
	request_id: string;
	outcome: "rejected";
	code: string;
	message: string;
}

export type ActivityClaimResultLine =
	| ActivityClaimGrantedLine
	| ActivityClaimPendingLine
	| ActivityClaimRecordedLine
	| ActivityClaimLeaseExpiredLine
	| ActivityClaimRejectedLine;

export interface ActivityResultRecordedLine {
	control: "record_activity_result_v1_result";
	request_id: string;
	outcome: "recorded";
	result_event_id: string;
	result_event_digest: string;
	result_outcome: ActivityResultOutcomeWireV1;
}

export interface ActivityResultLeaseExpiredLine {
	control: "record_activity_result_v1_result";
	request_id: string;
	outcome: "lease_expired";
	claim_event_id: string;
	lease_expires_at: string;
}

export interface ActivityResultRejectedLine {
	control: "record_activity_result_v1_result";
	request_id: string;
	outcome: "rejected";
	code: string;
	message: string;
}

export type ActivityResultResultLine =
	| ActivityResultRecordedLine
	| ActivityResultLeaseExpiredLine
	| ActivityResultRejectedLine;

export interface ActivityHeartbeatRecordedLine {
	control: "heartbeat_activity_v1_result";
	request_id: string;
	outcome: "recorded" | "existing";
	heartbeat_event_id: string;
	heartbeat_event_digest: string;
	lease_expires_at: string;
}

export interface ActivityHeartbeatLeaseExpiredLine {
	control: "heartbeat_activity_v1_result";
	request_id: string;
	outcome: "lease_expired";
	claim_event_id: string;
	lease_expires_at: string;
}

export interface ActivityHeartbeatRejectedLine {
	control: "heartbeat_activity_v1_result";
	request_id: string;
	outcome: "rejected";
	code: string;
	message: string;
}

export type ActivityHeartbeatResultLine =
	| ActivityHeartbeatRecordedLine
	| ActivityHeartbeatLeaseExpiredLine
	| ActivityHeartbeatRejectedLine;

export type AckLine =
	| HandshakeAck
	| FlushAck
	| CloseAck
	| ErrorLine
	| ActivityClaimResultLine
	| ActivityResultResultLine
	| ActivityHeartbeatResultLine;

/** Parse a JSON ack line from the ledger's stderr. Returns null if unrecognized. */
export function parseAckLine(line: string): AckLine | null {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return null;
	}
	if (
		typeof value !== "object" ||
		value === null ||
		!("control" in value) ||
		typeof (value as { control: unknown }).control !== "string"
	) {
		return null;
	}
	const control = (value as { control: string }).control;
	switch (control) {
		case "handshake_ack":
		case "flush_ack":
		case "close_ack":
		case "error":
			return value as AckLine;
		case "claim_activity_v1_result":
			return parseActivityClaimResultLine(value);
		case "record_activity_result_v1_result":
			return parseActivityResultResultLine(value);
		case "heartbeat_activity_v1_result":
			return parseActivityHeartbeatResultLine(value);
		default:
			return null;
	}
}

/** True when a line claims to be one of the authority-bearing reply controls. */
export function isActivityControlResponseLine(line: string): boolean {
	try {
		const value: unknown = JSON.parse(line);
		return (
			isRecord(value) &&
			(value.control === "claim_activity_v1_result" ||
				value.control === "record_activity_result_v1_result" ||
				value.control === "heartbeat_activity_v1_result")
		);
	} catch {
		return false;
	}
}

function parseActivityClaimResultLine(
	value: Record<string, unknown>,
): ActivityClaimResultLine | null {
	const outcome = value.outcome;
	switch (outcome) {
		case "granted":
			return hasExactStringFields(value, [
				"control",
				"request_id",
				"outcome",
				"claim_event_id",
				"claim_event_digest",
				"lease_id",
				"lease_expires_at",
			])
				? (value as unknown as ActivityClaimGrantedLine)
				: null;
		case "pending":
			return hasExactStringFields(value, [
				"control",
				"request_id",
				"outcome",
				"claim_event_id",
				"lease_expires_at",
			])
				? (value as unknown as ActivityClaimPendingLine)
				: null;
		case "recorded":
			return hasExactStringFields(value, [
				"control",
				"request_id",
				"outcome",
				"claim_event_id",
				"result_event_id",
				"result_event_digest",
				"result_outcome",
			]) && isActivityResultOutcome(value.result_outcome)
				? (value as unknown as ActivityClaimRecordedLine)
				: null;
		case "lease_expired":
			return hasExactStringFields(value, [
				"control",
				"request_id",
				"outcome",
				"claim_event_id",
				"lease_expires_at",
			])
				? (value as unknown as ActivityClaimLeaseExpiredLine)
				: null;
		case "rejected":
			return hasExactStringFields(value, [
				"control",
				"request_id",
				"outcome",
				"code",
				"message",
			])
				? (value as unknown as ActivityClaimRejectedLine)
				: null;
		default:
			return null;
	}
}

function parseActivityResultResultLine(
	value: Record<string, unknown>,
): ActivityResultResultLine | null {
	switch (value.outcome) {
		case "recorded":
			return hasExactStringFields(value, [
				"control",
				"request_id",
				"outcome",
				"result_event_id",
				"result_event_digest",
				"result_outcome",
			]) && isActivityResultOutcome(value.result_outcome)
				? (value as unknown as ActivityResultRecordedLine)
				: null;
		case "lease_expired":
			return hasExactStringFields(value, [
				"control",
				"request_id",
				"outcome",
				"claim_event_id",
				"lease_expires_at",
			])
				? (value as unknown as ActivityResultLeaseExpiredLine)
				: null;
		case "rejected":
			return hasExactStringFields(value, [
				"control",
				"request_id",
				"outcome",
				"code",
				"message",
			])
				? (value as unknown as ActivityResultRejectedLine)
				: null;
		default:
			return null;
	}
}

function parseActivityHeartbeatResultLine(
	value: Record<string, unknown>,
): ActivityHeartbeatResultLine | null {
	switch (value.outcome) {
		case "recorded":
		case "existing":
			return hasExactStringFields(value, [
				"control",
				"request_id",
				"outcome",
				"heartbeat_event_id",
				"heartbeat_event_digest",
				"lease_expires_at",
			])
				? (value as unknown as ActivityHeartbeatRecordedLine)
				: null;
		case "lease_expired":
			return hasExactStringFields(value, [
				"control",
				"request_id",
				"outcome",
				"claim_event_id",
				"lease_expires_at",
			])
				? (value as unknown as ActivityHeartbeatLeaseExpiredLine)
				: null;
		case "rejected":
			return hasExactStringFields(value, [
				"control",
				"request_id",
				"outcome",
				"code",
				"message",
			])
				? (value as unknown as ActivityHeartbeatRejectedLine)
				: null;
		default:
			return null;
	}
}

function hasExactStringFields(
	value: Record<string, unknown>,
	fields: readonly string[],
): boolean {
	const keys = Object.keys(value);
	if (
		keys.length !== fields.length ||
		!fields.every((field) => field in value)
	) {
		return false;
	}
	return fields.every(
		(field) =>
			typeof value[field] === "string" && value[field].trim().length > 0,
	);
}

function isActivityResultOutcome(
	value: unknown,
): value is ActivityResultOutcomeWireV1 {
	return value === "succeeded" || value === "failed" || value === "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
