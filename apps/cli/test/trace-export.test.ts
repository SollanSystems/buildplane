import { describe, expect, it } from "vitest";
import { createOtelTraceExport } from "../src/trace-export.js";

const ALLOWED_ATTRIBUTE_KEYS = new Set([
	"service.name",
	"buildplane.authority",
	"buildplane.governance",
	"buildplane.trace.format",
	"buildplane.trace.schema",
	"buildplane.run_id",
	"buildplane.unit_id",
	"buildplane.run_status",
	"buildplane.verdict",
	"buildplane.event_count",
	"buildplane.evidence_count",
	"buildplane.decision_count",
	"buildplane.artifact_count",
	"buildplane.missing_evidence_count",
	"buildplane.event_id",
	"buildplane.event.kind",
	"buildplane.evidence.kind",
	"buildplane.evidence.status",
	"buildplane.policy.decision_kind",
	"buildplane.policy.outcome",
]);

describe("createOtelTraceExport", () => {
	it("marks inspector-derived output unsafe instead of presenting it as signed-tape telemetry", () => {
		const result = createOtelTraceExport(
			{
				kind: "run",
				unit: { id: "unit-local-trace", kind: "command" },
				run: {
					id: "run-local-trace",
					unitId: "unit-local-trace",
					status: "passed",
				},
				evidence: [],
				decisions: [],
				artifacts: [],
			},
			"/private/local-trace.json",
		);

		expect(result).toMatchObject({
			governance: "unsafe",
			authority: { tape: "unverified", export: "none" },
		});
		const attributes = result.trace.resourceSpans[0]?.resource.attributes ?? [];
		expect(attributes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					key: "buildplane.governance",
					value: { stringValue: "unsafe" },
				}),
				expect.objectContaining({
					key: "buildplane.authority",
					value: { stringValue: "none" },
				}),
				expect.objectContaining({
					key: "buildplane.trace.schema",
					value: {
						stringValue: "buildplane.local-inspector-trace.v1",
					},
				}),
			]),
		);
		expect(attributes).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ key: "buildplane.tape.root_digest" }),
			]),
		);
	});

	it("exports only the fixed redacted trace attribute allowlist", () => {
		const result = createOtelTraceExport(
			{
				kind: "run",
				unit: { id: "unit-1", kind: "command" },
				run: { id: "run-1", unitId: "unit-1", status: "passed" },
				provenance: {
					route: {
						worker: "SENTINEL_WORKER_NAME",
						source: "SENTINEL_ROUTE_SOURCE",
						provider: "SENTINEL_PROVIDER_NAME",
						model: "SENTINEL_MODEL_NAME",
					},
					policy: { profile: "SENTINEL_POLICY_PROFILE" },
				},
				eventTape: {
					firstOccurredAt: "2026-05-16T00:00:00.000Z",
					lastOccurredAt: "2026-05-16T00:00:01.000Z",
					terminalStatus: "passed",
					events: [
						{
							id: "event-1",
							kind: "run_admission_recorded",
							occurredAt: "2026-05-16T00:00:00.000Z",
							summary: "SENTINEL_MODEL_PROMPT",
							metadata: {
								prompt: "SENTINEL_TOOL_ARGUMENTS",
								result: "SENTINEL_TOOL_OUTPUT",
								candidateRef: "SENTINEL_ARBITRARY_REF",
							},
						},
						{
							id: "event-2",
							kind: "model_request",
							occurredAt: "2026-05-16T00:00:00.500Z",
							summary: "SENTINEL_MODEL_REQUEST_SUMMARY",
						},
					],
				},
				evidence: [
					{
						kind: "command-exit",
						status: "pass",
						message: "SENTINEL_EVIDENCE_MESSAGE",
					},
				],
				decisions: [
					{
						kind: "advance-run",
						outcome: "approved",
						reasons: ["SENTINEL_DECISION_REASON"],
					},
				],
				artifacts: [
					{
						type: "log",
						location: "/private/SENTINEL_ARTIFACT_PATH.txt",
					},
				],
			},
			"/private/SENTINEL_TRACE_OUTPUT_PATH.json",
		);

		const resourceSpans = result.trace.resourceSpans;
		const spans = resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
		const attributeKeys = [
			...resourceSpans.flatMap((resourceSpan) =>
				resourceSpan.resource.attributes.map((attribute) => attribute.key),
			),
			...spans.flatMap((span) =>
				span.attributes.map((attribute) => attribute.key),
			),
		];
		const serializedTrace = JSON.stringify(result.trace);

		expect(result).toMatchObject({
			format: "otel-json",
			runId: "run-1",
			spanCount: spans.length,
			traceGrading: {
				schema: "buildplane.trace_grading.v1",
				runId: "run-1",
			},
		});
		expect(result.traceGrading).not.toHaveProperty("candidateTraceRef");
		expect(resourceSpans[0]?.scopeSpans[0]?.scope).toEqual({
			name: "buildplane",
			version: "1.0.0",
		});
		expect(spans.map((span) => span.name)).toEqual([
			"buildplane.run",
			"buildplane.event",
			"buildplane.event",
			"buildplane.evidence",
			"buildplane.decision",
		]);
		expect(spans[0]?.events).toBeUndefined();
		expect(attributeKeys.every((key) => ALLOWED_ATTRIBUTE_KEYS.has(key))).toBe(
			true,
		);
		expect(serializedTrace).not.toContain("SENTINEL_MODEL_PROMPT");
		expect(serializedTrace).not.toContain("SENTINEL_MODEL_REQUEST_SUMMARY");
		expect(serializedTrace).not.toContain("SENTINEL_TOOL_ARGUMENTS");
		expect(serializedTrace).not.toContain("SENTINEL_TOOL_OUTPUT");
		expect(serializedTrace).not.toContain("SENTINEL_ARBITRARY_REF");
		expect(serializedTrace).not.toContain("SENTINEL_EVIDENCE_MESSAGE");
		expect(serializedTrace).not.toContain("SENTINEL_DECISION_REASON");
		expect(serializedTrace).not.toContain("SENTINEL_ARTIFACT_PATH");
		expect(serializedTrace).not.toContain("SENTINEL_WORKER_NAME");
		expect(serializedTrace).not.toContain("SENTINEL_ROUTE_SOURCE");
		expect(serializedTrace).not.toContain("SENTINEL_PROVIDER_NAME");
		expect(serializedTrace).not.toContain("SENTINEL_MODEL_NAME");
		expect(serializedTrace).not.toContain("SENTINEL_POLICY_PROFILE");
		expect(serializedTrace).not.toContain("SENTINEL_TRACE_OUTPUT_PATH");
	});
});
