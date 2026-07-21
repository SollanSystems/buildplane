import { describe, expect, it } from "vitest";
import { buildEnvelope } from "../src/envelope.js";

describe("buildEnvelope", () => {
	const runId = "01919000-0000-7000-8000-000000000000";

	it("auto-generates id and occurred_at", () => {
		const env = buildEnvelope({
			runId,
			schemaVersion: 1,
			kind: "run_started",
			payload: { RunStartedV1: {} },
		});
		expect(env.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(env.run_id).toBe(runId);
		expect(env.schema_version).toBe(1);
		expect(env.kind).toBe("run_started");
		expect(env.parent_event_id).toBeNull();
		expect(env.occurred_at).toMatch(/Z$/);
	});

	it("threads parent_event_id", () => {
		const parent = "01919000-0000-7000-8000-000000000001";
		const env = buildEnvelope({
			runId,
			schemaVersion: 1,
			kind: "unit_started",
			payload: {},
			parent,
		});
		expect(env.parent_event_id).toBe(parent);
	});

	it("accepts explicit id and occurred_at (test override)", () => {
		const id = "01919000-0000-7000-8000-00000000000a";
		const env = buildEnvelope({
			runId,
			schemaVersion: 1,
			kind: "run_started",
			payload: {},
			id,
			occurredAt: "2026-04-17T12:00:00Z",
		});
		expect(env.id).toBe(id);
		expect(env.occurred_at).toBe("2026-04-17T12:00:00Z");
	});

	it("generates monotonic ids across rapid calls", () => {
		const ids = Array.from(
			{ length: 10 },
			() =>
				buildEnvelope({
					runId,
					schemaVersion: 1,
					kind: "run_started",
					payload: {},
				}).id,
		);
		const sorted = [...ids].sort();
		expect(ids).toEqual(sorted);
	});

	it("rejects action receipt resource values outside JavaScript's safe integer range", () => {
		expect(() =>
			buildEnvelope({
				runId,
				schemaVersion: 1,
				kind: "action_receipt_recorded_v2",
				payload: {
					resource_usage: {
						wall_time_ms: Number.MAX_SAFE_INTEGER + 1,
					},
				},
			}),
		).toThrow(/wall_time_ms/);
	});
});
