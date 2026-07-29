import { createHash } from "node:crypto";
import type { InspectSnapshot } from "@buildplane/kernel";
import { createInspectorProjection } from "./formatters.js";

type AttributeValue =
	| { readonly stringValue: string }
	| { readonly intValue: string }
	| { readonly doubleValue: number }
	| { readonly boolValue: boolean };

interface TraceAttribute {
	readonly key: string;
	readonly value: AttributeValue;
}

interface TraceSpan {
	readonly traceId: string;
	readonly spanId: string;
	readonly parentSpanId?: string;
	readonly name: string;
	readonly kind: 1;
	readonly startTimeUnixNano: string;
	readonly endTimeUnixNano: string;
	readonly attributes: readonly TraceAttribute[];
	readonly events?: readonly {
		readonly name: string;
		readonly timeUnixNano: string;
		readonly attributes: readonly TraceAttribute[];
	}[];
}

interface InspectSnapshotForTrace {
	readonly kind: string;
	readonly unit: { readonly id: string; readonly kind: string };
	readonly run: {
		readonly id: string;
		readonly unitId: string;
		readonly status: string;
	};
	readonly provenance?: {
		readonly route?: {
			readonly worker?: string;
			readonly source?: string;
			readonly provider?: string;
			readonly model?: string;
		};
		readonly policy?: {
			readonly profile?: string;
		};
	};
	readonly eventTape?: {
		readonly firstOccurredAt?: string;
		readonly lastOccurredAt?: string;
		readonly terminalStatus?: string;
		readonly events: readonly {
			readonly id: string;
			readonly kind: string;
			readonly occurredAt: string;
			readonly summary: string;
			readonly metadata?: Readonly<Record<string, string | number | boolean>>;
		}[];
	};
	readonly evidence: readonly {
		readonly kind: string;
		readonly status: string;
		readonly message?: string;
	}[];
	readonly decisions: readonly {
		readonly kind: string;
		readonly outcome: string;
		readonly reasons: readonly string[];
	}[];
	readonly artifacts: readonly {
		readonly type: string;
		readonly location: string;
	}[];
}

export interface TraceExportResult {
	readonly format: "otel-json";
	/**
	 * Inspector snapshots are local observations, not signed tape projections.
	 * They must never be presented as governed telemetry or promotion evidence.
	 */
	readonly governance: "unsafe";
	readonly authority: {
		readonly tape: "unverified";
		readonly export: "none";
	};
	readonly runId: string;
	readonly spanCount: number;
	readonly outPath: string;
	readonly trace: {
		readonly resourceSpans: readonly {
			readonly resource: {
				readonly attributes: readonly TraceAttribute[];
			};
			readonly scopeSpans: readonly {
				readonly scope: {
					readonly name: "buildplane";
					readonly version: "1.0.0";
				};
				readonly spans: readonly TraceSpan[];
			}[];
		}[];
	};
	readonly traceGrading: {
		readonly schema: "buildplane.trace_grading.v1";
		readonly runId: string;
	};
}

const TRACE_ATTRIBUTE_KEY = {
	authority: "buildplane.authority",
	artifactCount: "buildplane.artifact_count",
	decisionCount: "buildplane.decision_count",
	decisionKind: "buildplane.policy.decision_kind",
	decisionOutcome: "buildplane.policy.outcome",
	eventCount: "buildplane.event_count",
	eventId: "buildplane.event_id",
	eventKind: "buildplane.event.kind",
	governance: "buildplane.governance",
	evidenceCount: "buildplane.evidence_count",
	evidenceKind: "buildplane.evidence.kind",
	evidenceStatus: "buildplane.evidence.status",
	format: "buildplane.trace.format",
	missingEvidenceCount: "buildplane.missing_evidence_count",
	projectionSchema: "buildplane.trace.schema",
	runId: "buildplane.run_id",
	runStatus: "buildplane.run_status",
	serviceName: "service.name",
	unitId: "buildplane.unit_id",
	verdict: "buildplane.verdict",
} as const;

type TraceAttributeKey =
	(typeof TRACE_ATTRIBUTE_KEY)[keyof typeof TRACE_ATTRIBUTE_KEY];

function digestHex(value: string, bytes: number): string {
	return createHash("sha256")
		.update(value)
		.digest("hex")
		.slice(0, bytes * 2);
}

function traceId(runId: string): string {
	return digestHex(`trace:${runId}`, 16);
}

function spanId(seed: string): string {
	return digestHex(`span:${seed}`, 8);
}

function timeUnixMillis(value: string | undefined, fallbackMs = 0): number {
	const millis = value ? Date.parse(value) : Number.NaN;
	const safeMillis = Number.isFinite(millis) ? millis : fallbackMs;
	return Math.trunc(Math.max(safeMillis, 0));
}

function timeUnixNanoFromMillis(millis: number): string {
	return (BigInt(millis) * 1_000_000n).toString();
}

function stringAttr(key: TraceAttributeKey, value: string): TraceAttribute {
	return {
		key,
		value: { stringValue: value },
	};
}

function intAttr(key: TraceAttributeKey, value: number): TraceAttribute {
	return {
		key,
		value: { intValue: Math.trunc(value).toString() },
	};
}

export function createOtelTraceExport(
	snapshot: InspectSnapshotForTrace,
	outPath: string,
): TraceExportResult {
	const inspectorSnapshot = {
		kind: snapshot.kind,
		unit: snapshot.unit,
		run: snapshot.run,
		...(snapshot.provenance ? { provenance: snapshot.provenance } : {}),
		...(snapshot.eventTape
			? {
					eventTape: {
						...snapshot.eventTape,
						runId: snapshot.run.id,
						eventCount: snapshot.eventTape.events.length,
					},
				}
			: {}),
		evidence: snapshot.evidence,
		decisions: snapshot.decisions,
		artifacts: snapshot.artifacts,
	};
	const inspector = createInspectorProjection(
		inspectorSnapshot as unknown as InspectSnapshot,
	);
	const id = traceId(snapshot.run.id);
	const rootSpanId = spanId(`${snapshot.run.id}:root`);
	const startMillis = timeUnixMillis(snapshot.eventTape?.firstOccurredAt);
	const endMillis = timeUnixMillis(
		snapshot.eventTape?.lastOccurredAt,
		startMillis,
	);
	const start = timeUnixNanoFromMillis(startMillis);
	const end = timeUnixNanoFromMillis(endMillis);
	const spans: TraceSpan[] = [
		{
			traceId: id,
			spanId: rootSpanId,
			name: "buildplane.run",
			kind: 1,
			startTimeUnixNano: start,
			endTimeUnixNano: end,
			attributes: [
				stringAttr(TRACE_ATTRIBUTE_KEY.runId, snapshot.run.id),
				stringAttr(TRACE_ATTRIBUTE_KEY.unitId, snapshot.run.unitId),
				stringAttr(TRACE_ATTRIBUTE_KEY.runStatus, snapshot.run.status),
				stringAttr(TRACE_ATTRIBUTE_KEY.verdict, inspector.outcomeStrip.verdict),
				intAttr(
					TRACE_ATTRIBUTE_KEY.eventCount,
					inspector.outcomeStrip.eventCount,
				),
				intAttr(
					TRACE_ATTRIBUTE_KEY.missingEvidenceCount,
					inspector.outcomeStrip.missingEvidenceCount,
				),
				intAttr(
					TRACE_ATTRIBUTE_KEY.evidenceCount,
					inspector.outcomeStrip.evidenceCount,
				),
				intAttr(
					TRACE_ATTRIBUTE_KEY.decisionCount,
					inspector.outcomeStrip.decisionCount,
				),
				intAttr(
					TRACE_ATTRIBUTE_KEY.artifactCount,
					inspector.outcomeStrip.artifactCount,
				),
			],
		},
	];

	for (const event of snapshot.eventTape?.events ?? []) {
		const eventTime = timeUnixNanoFromMillis(timeUnixMillis(event.occurredAt));
		spans.push({
			traceId: id,
			spanId: spanId(`${snapshot.run.id}:event:${event.id}`),
			parentSpanId: rootSpanId,
			name: "buildplane.event",
			kind: 1,
			startTimeUnixNano: eventTime,
			endTimeUnixNano: eventTime,
			attributes: [
				stringAttr(TRACE_ATTRIBUTE_KEY.eventId, event.id),
				stringAttr(TRACE_ATTRIBUTE_KEY.eventKind, event.kind),
			],
		});
	}

	snapshot.evidence.forEach((evidence, index) => {
		spans.push({
			traceId: id,
			spanId: spanId(`${snapshot.run.id}:evidence:${index}`),
			parentSpanId: rootSpanId,
			name: "buildplane.evidence",
			kind: 1,
			startTimeUnixNano: end,
			endTimeUnixNano: end,
			attributes: [
				stringAttr(TRACE_ATTRIBUTE_KEY.evidenceKind, evidence.kind),
				stringAttr(TRACE_ATTRIBUTE_KEY.evidenceStatus, evidence.status),
			],
		});
	});

	snapshot.decisions.forEach((decision, index) => {
		spans.push({
			traceId: id,
			spanId: spanId(`${snapshot.run.id}:decision:${index}`),
			parentSpanId: rootSpanId,
			name: "buildplane.decision",
			kind: 1,
			startTimeUnixNano: end,
			endTimeUnixNano: end,
			attributes: [
				stringAttr(TRACE_ATTRIBUTE_KEY.decisionKind, decision.kind),
				stringAttr(TRACE_ATTRIBUTE_KEY.decisionOutcome, decision.outcome),
			],
		});
	});

	const trace = {
		resourceSpans: [
			{
				resource: {
					attributes: [
						stringAttr(TRACE_ATTRIBUTE_KEY.serviceName, "buildplane"),
						stringAttr(TRACE_ATTRIBUTE_KEY.format, "otel-json"),
						stringAttr(
							TRACE_ATTRIBUTE_KEY.projectionSchema,
							"buildplane.local-inspector-trace.v1",
						),
						stringAttr(TRACE_ATTRIBUTE_KEY.governance, "unsafe"),
						stringAttr(TRACE_ATTRIBUTE_KEY.authority, "none"),
					],
				},
				scopeSpans: [
					{
						scope: { name: "buildplane" as const, version: "1.0.0" as const },
						spans,
					},
				],
			},
		],
	};

	return {
		format: "otel-json",
		governance: "unsafe",
		authority: { tape: "unverified", export: "none" },
		runId: snapshot.run.id,
		spanCount: spans.length,
		outPath,
		trace,
		traceGrading: {
			schema: "buildplane.trace_grading.v1",
			runId: snapshot.run.id,
		},
	};
}
