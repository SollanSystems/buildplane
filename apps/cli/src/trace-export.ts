import { createHash } from "node:crypto";
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
					readonly version: "0.1.0";
				};
				readonly spans: readonly TraceSpan[];
			}[];
		}[];
	};
	readonly traceGrading: {
		readonly schema: "buildplane.trace_grading.v0";
		readonly runId: string;
		readonly candidateTraceRef: string;
		readonly rubrics: readonly string[];
	};
}

const SECRET_KEY_PATTERN =
	/(api[_-]?key|authorization|bearer|credential|password|secret|token)/iu;

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

function stringAttr(key: string, value: string): TraceAttribute {
	return {
		key,
		value: { stringValue: value },
	};
}

function intAttr(key: string, value: number): TraceAttribute {
	return {
		key,
		value: { intValue: Math.trunc(value).toString() },
	};
}

function doubleAttr(key: string, value: number): TraceAttribute {
	return {
		key,
		value: { doubleValue: value },
	};
}

function boolAttr(key: string, value: boolean): TraceAttribute {
	return {
		key,
		value: { boolValue: value },
	};
}

function safeString(value: string): string {
	let sanitized = "";
	for (const char of value) {
		const code = char.charCodeAt(0);
		sanitized += code < 32 || (code >= 127 && code <= 159) ? " " : char;
		if (sanitized.length >= 500) {
			return sanitized.slice(0, 500);
		}
	}
	return sanitized;
}

function safeMetadataAttributes(
	prefix: string,
	metadata: Readonly<Record<string, string | number | boolean>> | undefined,
): TraceAttribute[] {
	if (!metadata) return [];
	const attributes: TraceAttribute[] = [];
	for (const [key, value] of Object.entries(metadata).sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		if (SECRET_KEY_PATTERN.test(key)) {
			attributes.push(stringAttr(`${prefix}.${key}`, "[REDACTED]"));
			continue;
		}
		if (typeof value === "boolean") {
			attributes.push(boolAttr(`${prefix}.${key}`, value));
		} else if (typeof value === "number") {
			attributes.push(
				Number.isInteger(value)
					? intAttr(`${prefix}.${key}`, value)
					: doubleAttr(`${prefix}.${key}`, value),
			);
		} else {
			attributes.push(stringAttr(`${prefix}.${key}`, safeString(value)));
		}
	}
	return attributes;
}

function eventGenAiAttributes(kind: string): TraceAttribute[] {
	if (kind === "model_request") {
		return [stringAttr("gen_ai.operation.name", "chat")];
	}
	if (kind === "model_response") {
		return [stringAttr("gen_ai.operation.name", "chat.response")];
	}
	if (kind === "tool_request" || kind === "tool_result") {
		return [stringAttr("gen_ai.operation.name", "tool")];
	}
	return [];
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
	const inspector = createInspectorProjection(inspectorSnapshot);
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
				stringAttr("buildplane.run_id", snapshot.run.id),
				stringAttr("buildplane.unit_id", snapshot.run.unitId),
				stringAttr("buildplane.unit_kind", snapshot.unit.kind),
				stringAttr("buildplane.run_status", snapshot.run.status),
				stringAttr("buildplane.verdict", inspector.outcomeStrip.verdict),
				intAttr("buildplane.event_count", inspector.outcomeStrip.eventCount),
				intAttr(
					"buildplane.missing_evidence_count",
					inspector.outcomeStrip.missingEvidenceCount,
				),
				...(snapshot.provenance?.route?.worker
					? [
							stringAttr(
								"buildplane.route.worker",
								snapshot.provenance.route.worker,
							),
						]
					: []),
				...(snapshot.provenance?.route?.provider
					? [stringAttr("gen_ai.system", snapshot.provenance.route.provider)]
					: []),
				...(snapshot.provenance?.route?.model
					? [
							stringAttr(
								"gen_ai.request.model",
								snapshot.provenance.route.model,
							),
						]
					: []),
				...(snapshot.provenance?.policy?.profile
					? [
							stringAttr(
								"buildplane.policy.profile",
								snapshot.provenance.policy.profile,
							),
						]
					: []),
			],
			events: inspector.missingEvidence.map((missing, index) => ({
				name: "buildplane.missing_evidence",
				timeUnixNano: end,
				attributes: [
					intAttr("buildplane.index", index),
					stringAttr("buildplane.reason", safeString(missing)),
				],
			})),
		},
	];

	for (const event of snapshot.eventTape?.events ?? []) {
		const eventTime = timeUnixNanoFromMillis(timeUnixMillis(event.occurredAt));
		spans.push({
			traceId: id,
			spanId: spanId(`${snapshot.run.id}:event:${event.id}`),
			parentSpanId: rootSpanId,
			name: `buildplane.event.${event.kind}`,
			kind: 1,
			startTimeUnixNano: eventTime,
			endTimeUnixNano: eventTime,
			attributes: [
				stringAttr("buildplane.event_id", event.id),
				stringAttr("buildplane.event.kind", event.kind),
				stringAttr("buildplane.event.summary", safeString(event.summary)),
				...eventGenAiAttributes(event.kind),
				...safeMetadataAttributes("buildplane.event.metadata", event.metadata),
			],
		});
	}

	snapshot.evidence.forEach((evidence, index) => {
		spans.push({
			traceId: id,
			spanId: spanId(`${snapshot.run.id}:evidence:${index}`),
			parentSpanId: rootSpanId,
			name: `buildplane.evidence.${evidence.kind}`,
			kind: 1,
			startTimeUnixNano: end,
			endTimeUnixNano: end,
			attributes: [
				stringAttr("buildplane.evidence.kind", evidence.kind),
				stringAttr("buildplane.evidence.status", evidence.status),
				...(evidence.message
					? [
							stringAttr(
								"buildplane.evidence.message",
								safeString(evidence.message),
							),
						]
					: []),
			],
		});
	});

	snapshot.decisions.forEach((decision, index) => {
		spans.push({
			traceId: id,
			spanId: spanId(`${snapshot.run.id}:decision:${index}`),
			parentSpanId: rootSpanId,
			name: `buildplane.policy.${decision.kind}`,
			kind: 1,
			startTimeUnixNano: end,
			endTimeUnixNano: end,
			attributes: [
				stringAttr("buildplane.policy.decision_kind", decision.kind),
				stringAttr("buildplane.policy.outcome", decision.outcome),
				stringAttr(
					"buildplane.policy.reasons",
					safeString(decision.reasons.join("; ")),
				),
			],
		});
	});

	snapshot.artifacts.forEach((artifact, index) => {
		spans.push({
			traceId: id,
			spanId: spanId(`${snapshot.run.id}:artifact:${index}`),
			parentSpanId: rootSpanId,
			name: `buildplane.artifact.${artifact.type}`,
			kind: 1,
			startTimeUnixNano: end,
			endTimeUnixNano: end,
			attributes: [
				stringAttr("buildplane.artifact.type", artifact.type),
				stringAttr(
					"buildplane.artifact.location",
					safeString(artifact.location),
				),
			],
		});
	});

	const trace = {
		resourceSpans: [
			{
				resource: {
					attributes: [
						stringAttr("service.name", "buildplane"),
						stringAttr("buildplane.trace.format", "otel-json"),
					],
				},
				scopeSpans: [
					{
						scope: { name: "buildplane" as const, version: "0.1.0" as const },
						spans,
					},
				],
			},
		],
	};

	return {
		format: "otel-json",
		runId: snapshot.run.id,
		spanCount: spans.length,
		outPath,
		trace,
		traceGrading: {
			schema: "buildplane.trace_grading.v0",
			runId: snapshot.run.id,
			candidateTraceRef: outPath,
			rubrics: [
				"verdict is backed by recorded evidence",
				"missing evidence is surfaced explicitly",
				"policy and admission decisions are traceable",
			],
		},
	};
}
