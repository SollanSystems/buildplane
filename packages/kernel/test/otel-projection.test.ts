import { describe, expect, it } from "vitest";
import {
	projectTrustedTapeToOtelV1,
	type TrustedTapeOtelProjectionInputV1,
} from "../src/otel-projection.js";

const DIGEST_A =
	"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B =
	"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST_C =
	"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const DIGEST_D =
	"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const DIGEST_E =
	"sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const DIGEST_F =
	"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

function governedTape(
	overrides: Partial<TrustedTapeOtelProjectionInputV1> = {},
): TrustedTapeOtelProjectionInputV1 {
	return {
		schemaVersion: 1,
		governance: "governed",
		run: {
			id: "run-1",
			workflowId: "workflow-1",
			unitId: "unit-1",
			attempt: 1,
			tapeRootDigest: DIGEST_A,
			policyDigest: DIGEST_B,
			contextManifestDigest: DIGEST_C,
			workerManifestDigest: DIGEST_D,
			sandboxProfileDigest: DIGEST_E,
			status: "completed",
			startedAt: "2026-07-19T00:00:00.000Z",
			completedAt: "2026-07-19T00:00:03.000Z",
		},
		events: [
			{
				id: "event-2",
				kind: "activity_result_recorded_v1",
				occurredAt: "2026-07-19T00:00:02.000Z",
				digest: DIGEST_F,
			},
			{
				id: "event-1",
				kind: "dispatch_envelope_v3",
				occurredAt: "2026-07-19T00:00:01.000Z",
				digest: DIGEST_E,
			},
		],
		actions: [
			{
				id: "action-1",
				kind: "process",
				outcome: "succeeded",
				occurredAt: "2026-07-19T00:00:02.000Z",
				receiptDigest: DIGEST_D,
			},
		],
		decisions: [
			{
				id: "decision-1",
				kind: "review",
				outcome: "approve",
				occurredAt: "2026-07-19T00:00:03.000Z",
				digest: DIGEST_C,
			},
		],
		...overrides,
	};
}

const ALLOWED_ATTRIBUTE_KEYS = new Set([
	"service.name",
	"buildplane.projection.schema",
	"buildplane.governance",
	"buildplane.tape.root_digest",
	"buildplane.run.id",
	"buildplane.workflow.id",
	"buildplane.unit.id",
	"buildplane.attempt",
	"buildplane.run.status",
	"buildplane.policy.digest",
	"buildplane.context_manifest.digest",
	"buildplane.worker_manifest.digest",
	"buildplane.sandbox_profile.digest",
	"buildplane.event_count",
	"buildplane.action_count",
	"buildplane.decision_count",
	"buildplane.event.id",
	"buildplane.event.kind",
	"buildplane.event.digest",
	"buildplane.action.id",
	"buildplane.action.kind",
	"buildplane.action.outcome",
	"buildplane.action.receipt_digest",
	"buildplane.decision.id",
	"buildplane.decision.kind",
	"buildplane.decision.outcome",
	"buildplane.decision.digest",
]);

describe("governed-facts OpenTelemetry formatter", () => {
	it("does not relabel caller-supplied facts as signature-verified tape authority", () => {
		const projection = projectTrustedTapeToOtelV1(governedTape());
		const resourceSpans = projection.trace.resourceSpans;
		const spans = resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
		const attributeKeys = [
			...resourceSpans.flatMap((resourceSpan) =>
				resourceSpan.resource.attributes.map((attribute) => attribute.key),
			),
			...spans.flatMap((span) =>
				span.attributes.map((attribute) => attribute.key),
			),
		];

		expect(projection).toMatchObject({
			schemaVersion: 1,
			authority: { tape: "unverified", export: "none" },
		});
		expect(
			resourceSpans[0]?.resource.attributes.find(
				(attribute) => attribute.key === "buildplane.projection.schema",
			)?.value,
		).toEqual({ stringValue: "buildplane.local-governed-facts-otel.v1" });
		expect(
			resourceSpans[0]?.resource.attributes.find(
				(attribute) => attribute.key === "buildplane.governance",
			)?.value,
		).toEqual({ stringValue: "governed-unverified" });
		expect(resourceSpans[0]?.scopeSpans[0]?.scope).toEqual({
			name: "buildplane",
			version: "1.0.0",
		});
		expect(spans.map((span) => span.name)).toEqual([
			"buildplane.workflow",
			"buildplane.event",
			"buildplane.event",
			"buildplane.action",
			"buildplane.decision",
		]);
		expect(attributeKeys.every((key) => ALLOWED_ATTRIBUTE_KEYS.has(key))).toBe(
			true,
		);
		expect(JSON.stringify(projection)).not.toContain("SENTINEL_PROMPT");
		expect(JSON.stringify(projection)).not.toContain("SENTINEL_SECRET");
	});

	it("rejects raw runs and content-bearing or arbitrary fields before projection", () => {
		expect(() =>
			projectTrustedTapeToOtelV1({ ...governedTape(), governance: "raw" }),
		).toThrow(/governed/i);
		expect(() =>
			projectTrustedTapeToOtelV1({
				...governedTape(),
				ambientAuthority: true,
			}),
		).toThrow(/closed/i);
		expect(() =>
			projectTrustedTapeToOtelV1({
				...governedTape(),
				events: [
					{
						...governedTape().events[0],
						prompt: "SENTINEL_PROMPT",
					},
				],
			}),
		).toThrow(/closed/i);
		expect(() =>
			projectTrustedTapeToOtelV1({
				...governedTape(),
				actions: [
					{
						...governedTape().actions[0],
						toolArguments: "SENTINEL_TOOL_ARGUMENTS",
						result: "SENTINEL_TOOL_RESULT",
						secret: "SENTINEL_SECRET",
					},
				],
			}),
		).toThrow(/closed/i);

		const accessorEvents = [governedTape().events[0]!];
		Object.defineProperty(accessorEvents, "0", {
			get: () => governedTape().events[0],
			enumerable: true,
		});
		expect(() =>
			projectTrustedTapeToOtelV1({
				...governedTape(),
				events: accessorEvents,
			}),
		).toThrow(/data property/i);

		const outOfRangeActions = [...governedTape().actions];
		Object.defineProperty(outOfRangeActions, "4294967295", {
			value: governedTape().actions[0],
			enumerable: true,
		});
		expect(() =>
			projectTrustedTapeToOtelV1({
				...governedTape(),
				actions: outOfRangeActions,
			}),
		).toThrow(/closed array/i);
	});

	it("is deterministic regardless of trusted record ordering", () => {
		const input = governedTape();
		const reordered = governedTape({
			events: [...input.events].reverse(),
			actions: [...input.actions].reverse(),
			decisions: [...input.decisions].reverse(),
		});

		expect(projectTrustedTapeToOtelV1(reordered)).toEqual(
			projectTrustedTapeToOtelV1(input),
		);
	});

	it("exports durable timer and cancellation evidence without exporting its contents", () => {
		const input = governedTape({
			run: {
				...governedTape().run,
				status: "cancellation_requested",
			},
			events: [
				{
					id: "timer-scheduled-1",
					kind: "workflow_timer_scheduled_v1",
					occurredAt: "2026-07-19T00:00:01.000Z",
					digest: DIGEST_A,
				},
				{
					id: "timer-fired-1",
					kind: "workflow_timer_fired_v1",
					occurredAt: "2026-07-19T00:00:02.000Z",
					digest: DIGEST_B,
				},
				{
					id: "cancellation-requested-1",
					kind: "workflow_cancellation_requested_v1",
					occurredAt: "2026-07-19T00:00:03.000Z",
					digest: DIGEST_C,
				},
			],
		});

		const projection = projectTrustedTapeToOtelV1(input);
		const spans = projection.trace.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
		expect(spans.map((span) => span.name)).toEqual([
			"buildplane.workflow",
			"buildplane.event",
			"buildplane.event",
			"buildplane.event",
			"buildplane.action",
			"buildplane.decision",
		]);
		expect(JSON.stringify(projection)).not.toContain("timer_id");
		expect(JSON.stringify(projection)).not.toContain("cancellation_id");
	});

	it("rejects ambiguous duplicate tape-derived identifiers", () => {
		const input = governedTape();
		expect(() =>
			projectTrustedTapeToOtelV1({
				...input,
				events: [input.events[0]!, { ...input.events[0]! }],
			}),
		).toThrow(/duplicate event id/i);
	});
});
