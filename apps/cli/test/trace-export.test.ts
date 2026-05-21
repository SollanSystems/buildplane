import { describe, expect, it } from "vitest";
import { createOtelTraceExport } from "../src/trace-export.js";

describe("createOtelTraceExport", () => {
	it("projects inspect evidence into a local OpenTelemetry-shaped trace", () => {
		const result = createOtelTraceExport(
			{
				kind: "run",
				unit: { id: "unit-1", kind: "command" },
				run: { id: "run-1", unitId: "unit-1", status: "passed" },
				provenance: {
					route: {
						worker: "codex",
						provider: "openai",
						model: "gpt-5.4",
					},
					policy: { profile: "default" },
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
							summary: "admission passed",
							metadata: {
								decision: "PASS",
								durationMs: 12.5,
								token: "raw-secret-value",
							},
						},
						{
							id: "event-2",
							kind: "model_request",
							occurredAt: "2026-05-16T00:00:00.500Z",
							summary: "model request",
						},
					],
				},
				evidence: [{ kind: "command-exit", status: "pass", message: "exit 0" }],
				decisions: [
					{ kind: "advance-run", outcome: "approved", reasons: ["ok"] },
				],
				artifacts: [{ type: "log", location: ".buildplane/log.txt" }],
			},
			"/tmp/run-1.trace.json",
		);

		const spans = result.trace.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
		expect(result).toMatchObject({
			format: "otel-json",
			runId: "run-1",
			spanCount: spans.length,
			traceGrading: {
				schema: "buildplane.trace_grading.v0",
				runId: "run-1",
			},
		});
		expect(spans[0]).toMatchObject({
			name: "buildplane.run",
			attributes: expect.arrayContaining([
				{ key: "buildplane.run_id", value: { stringValue: "run-1" } },
				{ key: "buildplane.verdict", value: { stringValue: "PASSED" } },
				{ key: "gen_ai.system", value: { stringValue: "openai" } },
				{ key: "gen_ai.request.model", value: { stringValue: "gpt-5.4" } },
			]),
		});
		expect(spans.every((span) => span.kind === 1)).toBe(true);
		expect(spans.map((span) => span.name)).toEqual(
			expect.arrayContaining([
				"buildplane.event.run_admission_recorded",
				"buildplane.event.model_request",
				"buildplane.evidence.command-exit",
				"buildplane.policy.advance-run",
				"buildplane.artifact.log",
			]),
		);
		expect(JSON.stringify(result.trace)).toContain('"doubleValue":12.5');
		expect(JSON.stringify(result)).not.toContain("raw-secret-value");
		expect(JSON.stringify(result)).toContain("[REDACTED]");
	});
});
