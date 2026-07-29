import { createHash } from "node:crypto";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

const WORKFLOW_STATUSES = new Set([
	"dispatched",
	"candidate_created",
	"acceptance_passed",
	"review_approved",
	"promotion_approval_pending",
	"promotion_pending",
	"promotion_reconciliation_required",
	"promotion_reconciliation_resolved",
	"cancellation_requested",
	"promoted",
	"rejected",
	"completed",
	"failed",
	"cancelled",
] as const);

const TRUSTED_EVENT_KINDS = new Set([
	"dispatch_envelope_v3",
	"workflow_graph_declared_v1",
	"action_requested_v2",
	"activity_claimed_v1",
	"activity_heartbeat_recorded_v1",
	"activity_result_recorded_v1",
	"action_receipt_recorded_v2",
	"action_receipt_set_recorded_v1",
	"candidate_created_v2",
	"candidate_completion_recorded_v1",
	"candidate_acceptance_recorded",
	"review_verdict_recorded_v2",
	"promotion_approval_requested",
	"promotion_decision_recorded",
	"promotion_result_recorded",
	"promotion_reconciliation_resolved",
	"workflow_timer_scheduled_v1",
	"workflow_timer_fired_v1",
	"workflow_cancellation_requested_v1",
	"workflow_terminal",
	"workflow_terminal_v2",
] as const);

const ACTION_KINDS = new Set([
	"filesystem",
	"process",
	"git",
	"model",
	"network",
	"secret",
	"mcp",
	"a2a",
	"external_service",
] as const);

const ACTION_OUTCOMES = new Set([
	"succeeded",
	"failed",
	"denied",
	"unknown",
] as const);

const DECISION_KINDS = new Set(["acceptance", "review", "promotion"] as const);

const DECISION_OUTCOMES = new Set([
	"pass",
	"fail",
	"approve",
	"request_changes",
	"reject",
	"abstain",
	"promote",
	"reconciliation_required",
	"rejected",
] as const);

export type TrustedTapeWorkflowStatusV1 = (typeof WORKFLOW_STATUSES extends Set<
	infer Status
>
	? Status
	: never) &
	string;
export type TrustedTapeEventKindV1 = (typeof TRUSTED_EVENT_KINDS extends Set<
	infer Kind
>
	? Kind
	: never) &
	string;
export type TrustedTapeActionKindV1 = (typeof ACTION_KINDS extends Set<
	infer Kind
>
	? Kind
	: never) &
	string;
export type TrustedTapeActionOutcomeV1 = (typeof ACTION_OUTCOMES extends Set<
	infer Outcome
>
	? Outcome
	: never) &
	string;
export type TrustedTapeDecisionKindV1 = (typeof DECISION_KINDS extends Set<
	infer Kind
>
	? Kind
	: never) &
	string;
export type TrustedTapeDecisionOutcomeV1 =
	(typeof DECISION_OUTCOMES extends Set<infer Outcome> ? Outcome : never) &
		string;

/**
 * Explicitly selected, tape-derived fields permitted to enter the local
 * telemetry projection. Content, credentials, prompts, tool arguments,
 * results, paths, and arbitrary event metadata are intentionally absent.
 */
export interface TrustedTapeRunOtelFactsV1 {
	readonly id: string;
	readonly workflowId: string;
	readonly unitId: string;
	readonly attempt: number;
	readonly tapeRootDigest: string;
	readonly policyDigest: string;
	readonly contextManifestDigest: string;
	readonly workerManifestDigest: string;
	readonly sandboxProfileDigest: string;
	readonly status: TrustedTapeWorkflowStatusV1;
	readonly startedAt: string;
	readonly completedAt: string;
}

export interface TrustedTapeEventOtelFactsV1 {
	readonly id: string;
	readonly kind: TrustedTapeEventKindV1;
	readonly occurredAt: string;
	readonly digest: string;
}

export interface TrustedTapeActionOtelFactsV1 {
	readonly id: string;
	readonly kind: TrustedTapeActionKindV1;
	readonly outcome: TrustedTapeActionOutcomeV1;
	readonly occurredAt: string;
	readonly receiptDigest: string;
}

export interface TrustedTapeDecisionOtelFactsV1 {
	readonly id: string;
	readonly kind: TrustedTapeDecisionKindV1;
	readonly outcome: TrustedTapeDecisionOutcomeV1;
	readonly occurredAt: string;
	readonly digest: string;
}

/**
 * The only accepted input to the exporter. `governance` is deliberately
 * closed to governed tape facts: raw output can never be relabelled as a
 * trusted trace by adding telemetry-shaped fields.
 */
export interface TrustedTapeOtelProjectionInputV1 {
	readonly schemaVersion: 1;
	readonly governance: "governed";
	readonly run: TrustedTapeRunOtelFactsV1;
	readonly events: readonly TrustedTapeEventOtelFactsV1[];
	readonly actions: readonly TrustedTapeActionOtelFactsV1[];
	readonly decisions: readonly TrustedTapeDecisionOtelFactsV1[];
}

export type OtelAttributeValueV1 =
	| { readonly stringValue: string }
	| { readonly intValue: string }
	| { readonly boolValue: boolean };

export interface OtelAttributeV1 {
	readonly key: string;
	readonly value: OtelAttributeValueV1;
}

export interface OtelSpanV1 {
	readonly traceId: string;
	readonly spanId: string;
	readonly parentSpanId?: string;
	readonly name:
		| "buildplane.workflow"
		| "buildplane.event"
		| "buildplane.action"
		| "buildplane.decision";
	readonly kind: 1;
	readonly startTimeUnixNano: string;
	readonly endTimeUnixNano: string;
	readonly attributes: readonly OtelAttributeV1[];
}

export interface TrustedTapeOtelProjectionV1 {
	readonly schemaVersion: 1;
	/**
	 * This pure formatter validates a closed data shape but cannot verify a tape
	 * signature or checkpoint chain. A native verified-tape exporter is required
	 * before telemetry may claim an authoritative tape source.
	 */
	readonly authority: {
		readonly tape: "unverified";
		/** A projection is evidence export only; it cannot authorize an action. */
		readonly export: "none";
	};
	readonly trace: {
		readonly resourceSpans: readonly {
			readonly resource: { readonly attributes: readonly OtelAttributeV1[] };
			readonly scopeSpans: readonly {
				readonly scope: {
					readonly name: "buildplane";
					readonly version: "1.0.0";
				};
				readonly spans: readonly OtelSpanV1[];
			}[];
		}[];
	};
}

const ATTRIBUTE = {
	actionCount: "buildplane.action_count",
	actionId: "buildplane.action.id",
	actionKind: "buildplane.action.kind",
	actionOutcome: "buildplane.action.outcome",
	actionReceiptDigest: "buildplane.action.receipt_digest",
	attempt: "buildplane.attempt",
	contextManifestDigest: "buildplane.context_manifest.digest",
	decisionCount: "buildplane.decision_count",
	decisionDigest: "buildplane.decision.digest",
	decisionId: "buildplane.decision.id",
	decisionKind: "buildplane.decision.kind",
	decisionOutcome: "buildplane.decision.outcome",
	eventCount: "buildplane.event_count",
	eventDigest: "buildplane.event.digest",
	eventId: "buildplane.event.id",
	eventKind: "buildplane.event.kind",
	governance: "buildplane.governance",
	policyDigest: "buildplane.policy.digest",
	projectionSchema: "buildplane.projection.schema",
	runId: "buildplane.run.id",
	runStatus: "buildplane.run.status",
	sandboxProfileDigest: "buildplane.sandbox_profile.digest",
	serviceName: "service.name",
	tapeRootDigest: "buildplane.tape.root_digest",
	unitId: "buildplane.unit.id",
	workerManifestDigest: "buildplane.worker_manifest.digest",
	workflowId: "buildplane.workflow.id",
} as const;

/**
 * Formats deterministic, content-redacted, caller-supplied governed-shape
 * facts as OpenTelemetry-shaped data. The parser closes the input schema and
 * prevents content-bearing fields from entering the export, but it does not
 * open or verify a signed tape. Consequently its output is explicitly
 * unverified and uses a non-authoritative local schema.
 *
 * This function is pure: it does not append to the tape, open a network
 * connection, persist telemetry, or grant execution/promotion authority.
 */
export function projectTrustedTapeToOtelV1(
	input: TrustedTapeOtelProjectionInputV1,
): TrustedTapeOtelProjectionV1 {
	const trusted = parseTrustedTapeOtelProjectionInputV1(input);
	const traceId = stableHex(
		"trace",
		trusted.run.id,
		trusted.run.tapeRootDigest,
		16,
	);
	const rootSpanId = stableHex(
		"workflow",
		trusted.run.id,
		trusted.run.tapeRootDigest,
		8,
	);
	const startedAt = timestampToUnixNano(trusted.run.startedAt);
	const completedAt = timestampToUnixNano(trusted.run.completedAt);
	const rootSpan = freezeSpan({
		traceId,
		spanId: rootSpanId,
		name: "buildplane.workflow",
		kind: 1,
		startTimeUnixNano: startedAt.nanoseconds,
		endTimeUnixNano: completedAt.nanoseconds,
		attributes: [
			stringAttribute(ATTRIBUTE.runId, trusted.run.id),
			stringAttribute(ATTRIBUTE.workflowId, trusted.run.workflowId),
			stringAttribute(ATTRIBUTE.unitId, trusted.run.unitId),
			integerAttribute(ATTRIBUTE.attempt, trusted.run.attempt),
			stringAttribute(ATTRIBUTE.runStatus, trusted.run.status),
			stringAttribute(ATTRIBUTE.tapeRootDigest, trusted.run.tapeRootDigest),
			stringAttribute(ATTRIBUTE.policyDigest, trusted.run.policyDigest),
			stringAttribute(
				ATTRIBUTE.contextManifestDigest,
				trusted.run.contextManifestDigest,
			),
			stringAttribute(
				ATTRIBUTE.workerManifestDigest,
				trusted.run.workerManifestDigest,
			),
			stringAttribute(
				ATTRIBUTE.sandboxProfileDigest,
				trusted.run.sandboxProfileDigest,
			),
			integerAttribute(ATTRIBUTE.eventCount, trusted.events.length),
			integerAttribute(ATTRIBUTE.actionCount, trusted.actions.length),
			integerAttribute(ATTRIBUTE.decisionCount, trusted.decisions.length),
		],
	});

	const spans: OtelSpanV1[] = [rootSpan];
	for (const event of sortFacts(trusted.events)) {
		const time = timestampToUnixNano(event.occurredAt);
		assertWithinRunWindow(
			time.milliseconds,
			startedAt.milliseconds,
			completedAt.milliseconds,
			"event",
		);
		spans.push(
			freezeSpan({
				traceId,
				spanId: stableHex("event", event.id, event.digest, 8),
				parentSpanId: rootSpanId,
				name: "buildplane.event",
				kind: 1,
				startTimeUnixNano: time.nanoseconds,
				endTimeUnixNano: time.nanoseconds,
				attributes: [
					stringAttribute(ATTRIBUTE.eventId, event.id),
					stringAttribute(ATTRIBUTE.eventKind, event.kind),
					stringAttribute(ATTRIBUTE.eventDigest, event.digest),
				],
			}),
		);
	}
	for (const action of sortFacts(trusted.actions)) {
		const time = timestampToUnixNano(action.occurredAt);
		assertWithinRunWindow(
			time.milliseconds,
			startedAt.milliseconds,
			completedAt.milliseconds,
			"action",
		);
		spans.push(
			freezeSpan({
				traceId,
				spanId: stableHex("action", action.id, action.receiptDigest, 8),
				parentSpanId: rootSpanId,
				name: "buildplane.action",
				kind: 1,
				startTimeUnixNano: time.nanoseconds,
				endTimeUnixNano: time.nanoseconds,
				attributes: [
					stringAttribute(ATTRIBUTE.actionId, action.id),
					stringAttribute(ATTRIBUTE.actionKind, action.kind),
					stringAttribute(ATTRIBUTE.actionOutcome, action.outcome),
					stringAttribute(ATTRIBUTE.actionReceiptDigest, action.receiptDigest),
				],
			}),
		);
	}
	for (const decision of sortFacts(trusted.decisions)) {
		const time = timestampToUnixNano(decision.occurredAt);
		assertWithinRunWindow(
			time.milliseconds,
			startedAt.milliseconds,
			completedAt.milliseconds,
			"decision",
		);
		spans.push(
			freezeSpan({
				traceId,
				spanId: stableHex("decision", decision.id, decision.digest, 8),
				parentSpanId: rootSpanId,
				name: "buildplane.decision",
				kind: 1,
				startTimeUnixNano: time.nanoseconds,
				endTimeUnixNano: time.nanoseconds,
				attributes: [
					stringAttribute(ATTRIBUTE.decisionId, decision.id),
					stringAttribute(ATTRIBUTE.decisionKind, decision.kind),
					stringAttribute(ATTRIBUTE.decisionOutcome, decision.outcome),
					stringAttribute(ATTRIBUTE.decisionDigest, decision.digest),
				],
			}),
		);
	}

	return Object.freeze({
		schemaVersion: 1,
		authority: Object.freeze({
			tape: "unverified" as const,
			export: "none" as const,
		}),
		trace: Object.freeze({
			resourceSpans: Object.freeze([
				Object.freeze({
					resource: Object.freeze({
						attributes: Object.freeze([
							stringAttribute(ATTRIBUTE.serviceName, "buildplane"),
							stringAttribute(
								ATTRIBUTE.projectionSchema,
								"buildplane.local-governed-facts-otel.v1",
							),
							stringAttribute(ATTRIBUTE.governance, "governed-unverified"),
						]),
					}),
					scopeSpans: Object.freeze([
						Object.freeze({
							scope: Object.freeze({
								name: "buildplane" as const,
								version: "1.0.0" as const,
							}),
							spans: Object.freeze(spans),
						}),
					]),
				}),
			]),
		}),
	});
}

function parseTrustedTapeOtelProjectionInputV1(
	input: unknown,
): TrustedTapeOtelProjectionInputV1 {
	const record = readClosedRecord(input, "TrustedTapeOtelProjectionInputV1", [
		"schemaVersion",
		"governance",
		"run",
		"events",
		"actions",
		"decisions",
	]);
	if (record.schemaVersion !== 1) {
		throw new TypeError(
			"TrustedTapeOtelProjectionInputV1 schemaVersion is unsupported.",
		);
	}
	if (record.governance !== "governed") {
		throw new TypeError(
			"TrustedTapeOtelProjectionInputV1 accepts governed tape facts only.",
		);
	}
	const events = readClosedArray(record.events, "events", parseEvent);
	const actions = readClosedArray(record.actions, "actions", parseAction);
	const decisions = readClosedArray(
		record.decisions,
		"decisions",
		parseDecision,
	);
	assertUniqueIds(events, "event");
	assertUniqueIds(actions, "action");
	assertUniqueIds(decisions, "decision");
	return Object.freeze({
		schemaVersion: 1,
		governance: "governed" as const,
		run: parseRun(record.run),
		events: Object.freeze(events),
		actions: Object.freeze(actions),
		decisions: Object.freeze(decisions),
	});
}

function parseRun(value: unknown): TrustedTapeRunOtelFactsV1 {
	const record = readClosedRecord(value, "run", [
		"id",
		"workflowId",
		"unitId",
		"attempt",
		"tapeRootDigest",
		"policyDigest",
		"contextManifestDigest",
		"workerManifestDigest",
		"sandboxProfileDigest",
		"status",
		"startedAt",
		"completedAt",
	]);
	const startedAt = readTimestamp(record.startedAt, "run.startedAt");
	const completedAt = readTimestamp(record.completedAt, "run.completedAt");
	if (Date.parse(startedAt) > Date.parse(completedAt)) {
		throw new RangeError("run.completedAt must not precede run.startedAt.");
	}
	return Object.freeze({
		id: readIdentifier(record.id, "run.id"),
		workflowId: readIdentifier(record.workflowId, "run.workflowId"),
		unitId: readIdentifier(record.unitId, "run.unitId"),
		attempt: readPositiveInteger(record.attempt, "run.attempt"),
		tapeRootDigest: readDigest(record.tapeRootDigest, "run.tapeRootDigest"),
		policyDigest: readDigest(record.policyDigest, "run.policyDigest"),
		contextManifestDigest: readDigest(
			record.contextManifestDigest,
			"run.contextManifestDigest",
		),
		workerManifestDigest: readDigest(
			record.workerManifestDigest,
			"run.workerManifestDigest",
		),
		sandboxProfileDigest: readDigest(
			record.sandboxProfileDigest,
			"run.sandboxProfileDigest",
		),
		status: readEnum(record.status, WORKFLOW_STATUSES, "run.status"),
		startedAt,
		completedAt,
	});
}

function parseEvent(value: unknown): TrustedTapeEventOtelFactsV1 {
	const record = readClosedRecord(value, "event", [
		"id",
		"kind",
		"occurredAt",
		"digest",
	]);
	return Object.freeze({
		id: readIdentifier(record.id, "event.id"),
		kind: readEnum(record.kind, TRUSTED_EVENT_KINDS, "event.kind"),
		occurredAt: readTimestamp(record.occurredAt, "event.occurredAt"),
		digest: readDigest(record.digest, "event.digest"),
	});
}

function parseAction(value: unknown): TrustedTapeActionOtelFactsV1 {
	const record = readClosedRecord(value, "action", [
		"id",
		"kind",
		"outcome",
		"occurredAt",
		"receiptDigest",
	]);
	return Object.freeze({
		id: readIdentifier(record.id, "action.id"),
		kind: readEnum(record.kind, ACTION_KINDS, "action.kind"),
		outcome: readEnum(record.outcome, ACTION_OUTCOMES, "action.outcome"),
		occurredAt: readTimestamp(record.occurredAt, "action.occurredAt"),
		receiptDigest: readDigest(record.receiptDigest, "action.receiptDigest"),
	});
}

function parseDecision(value: unknown): TrustedTapeDecisionOtelFactsV1 {
	const record = readClosedRecord(value, "decision", [
		"id",
		"kind",
		"outcome",
		"occurredAt",
		"digest",
	]);
	return Object.freeze({
		id: readIdentifier(record.id, "decision.id"),
		kind: readEnum(record.kind, DECISION_KINDS, "decision.kind"),
		outcome: readEnum(record.outcome, DECISION_OUTCOMES, "decision.outcome"),
		occurredAt: readTimestamp(record.occurredAt, "decision.occurredAt"),
		digest: readDigest(record.digest, "decision.digest"),
	});
}

function readClosedRecord(
	value: unknown,
	label: string,
	fields: readonly string[],
): Record<string, unknown> {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null) ||
		Object.getOwnPropertySymbols(value).length > 0
	) {
		throw new TypeError(`${label} must be a plain closed data object.`);
	}
	const expected = new Set(fields);
	const names = Object.getOwnPropertyNames(value);
	const unexpected = names.filter((field) => !expected.has(field));
	const missing = fields.filter((field) => !Object.hasOwn(value, field));
	if (unexpected.length > 0 || missing.length > 0) {
		throw new TypeError(
			`${label} must use a closed schema (unknown: ${unexpected.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}).`,
		);
	}
	const normalized: Record<string, unknown> = {};
	for (const field of fields) {
		const descriptor = Object.getOwnPropertyDescriptor(value, field);
		if (!descriptor || !("value" in descriptor)) {
			throw new TypeError(`${label}.${field} must be a data property.`);
		}
		normalized[field] = descriptor.value;
	}
	return normalized;
}

function readClosedArray<T>(
	value: unknown,
	label: string,
	parse: (entry: unknown) => T,
): T[] {
	if (
		!Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Array.prototype
	) {
		throw new TypeError(`${label} must be a closed array.`);
	}
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (
		typeof length !== "number" ||
		!Number.isSafeInteger(length) ||
		length < 0
	) {
		throw new TypeError(`${label} must be a closed array.`);
	}
	const parsed: T[] = [];
	for (let index = 0; index < length; index += 1) {
		const descriptor = descriptors[String(index)];
		if (!descriptor || !("value" in descriptor)) {
			throw new TypeError(`${label}[${index}] must be a data property.`);
		}
		parsed.push(parse(descriptor.value));
	}
	for (const key of Reflect.ownKeys(descriptors)) {
		if (
			typeof key !== "string" ||
			(key !== "length" && !isArrayIndex(key, length))
		) {
			throw new TypeError(`${label} must be a closed array.`);
		}
	}
	return parsed;
}

function isArrayIndex(key: string, length: number): boolean {
	if (!/^(0|[1-9][0-9]*)$/.test(key)) return false;
	const index = Number(key);
	return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function readIdentifier(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		!IDENTIFIER.test(value) ||
		value.includes("..") ||
		value.includes("//") ||
		value.includes("@{")
	) {
		throw new TypeError(`${label} must be a canonical identifier.`);
	}
	return value;
}

function readDigest(value: unknown, label: string): string {
	if (typeof value !== "string" || !SHA256.test(value)) {
		throw new TypeError(`${label} must be a canonical SHA-256 digest.`);
	}
	return value;
}

function readTimestamp(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		!RFC3339_UTC.test(value) ||
		!Number.isFinite(Date.parse(value))
	) {
		throw new TypeError(`${label} must be an RFC3339 UTC timestamp.`);
	}
	return value;
}

function readPositiveInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError(`${label} must be a positive safe integer.`);
	}
	return value;
}

function readEnum<T extends string>(
	value: unknown,
	allowed: ReadonlySet<T>,
	label: string,
): T {
	if (typeof value !== "string" || !allowed.has(value as T)) {
		throw new TypeError(`${label} is unsupported.`);
	}
	return value as T;
}

function stableHex(
	kind: string,
	first: string,
	second: string,
	bytes: number,
): string {
	return createHash("sha256")
		.update("buildplane.otel-projection.v1\0")
		.update(kind)
		.update("\0")
		.update(first)
		.update("\0")
		.update(second)
		.digest("hex")
		.slice(0, bytes * 2);
}

function timestampToUnixNano(value: string): {
	readonly milliseconds: number;
	readonly nanoseconds: string;
} {
	const milliseconds = Date.parse(value);
	return Object.freeze({
		milliseconds,
		nanoseconds: (BigInt(milliseconds) * 1_000_000n).toString(),
	});
}

function assertWithinRunWindow(
	value: number,
	startedAt: number,
	completedAt: number,
	label: string,
): void {
	if (value < startedAt || value > completedAt) {
		throw new RangeError(
			`${label}.occurredAt falls outside the trusted run window.`,
		);
	}
}

function sortFacts<
	T extends { readonly id: string; readonly occurredAt: string },
>(facts: readonly T[]): readonly T[] {
	return [...facts].sort((left, right) => {
		if (left.occurredAt < right.occurredAt) return -1;
		if (left.occurredAt > right.occurredAt) return 1;
		if (left.id < right.id) return -1;
		if (left.id > right.id) return 1;
		return 0;
	});
}

function assertUniqueIds<T extends { readonly id: string }>(
	entries: readonly T[],
	label: string,
): void {
	const ids = new Set<string>();
	for (const entry of entries) {
		if (ids.has(entry.id)) {
			throw new TypeError(`duplicate ${label} id is not allowed.`);
		}
		ids.add(entry.id);
	}
}

function stringAttribute(key: string, value: string): OtelAttributeV1 {
	return Object.freeze({ key, value: Object.freeze({ stringValue: value }) });
}

function integerAttribute(key: string, value: number): OtelAttributeV1 {
	return Object.freeze({
		key,
		value: Object.freeze({ intValue: String(value) }),
	});
}

function freezeSpan(span: OtelSpanV1): OtelSpanV1 {
	return Object.freeze({
		...span,
		attributes: Object.freeze([...span.attributes]),
	});
}
