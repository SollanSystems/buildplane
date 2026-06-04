import { describe, expect, it } from "vitest";
import { digest } from "../src/digest.ts";
import {
	type BuildPlanReceiptInput,
	buildPlanReceiptPayload,
} from "../src/receipt.ts";

function baseInput(
	overrides: Partial<BuildPlanReceiptInput> = {},
): BuildPlanReceiptInput {
	return {
		planId: "pf-plan-abc",
		admissionEventId: "01919000-0000-7000-8000-000000000016",
		outcome: "completed",
		sideEffects: ["fs.write:declared_scope"],
		result: {
			status: "dispatched",
			runs: [{ task: "PF1", status: "passed" }],
		},
		decidedAt: "2026-06-04T00:00:00Z",
		...overrides,
	};
}

describe("buildPlanReceiptPayload", () => {
	it("maps inputs to a plan_receipt wire payload with a canonical result_digest", () => {
		const input = baseInput();
		const payload = buildPlanReceiptPayload(input);
		expect(payload).toEqual({
			plan_id: "pf-plan-abc",
			admission_event_id: "01919000-0000-7000-8000-000000000016",
			outcome: "completed",
			side_effects: ["fs.write:declared_scope"],
			result_digest: digest(input.result),
			decided_at: "2026-06-04T00:00:00Z",
		});
	});

	it("computes result_digest as the canonical digest of the result", () => {
		const input = baseInput();
		expect(buildPlanReceiptPayload(input).result_digest).toBe(
			digest(input.result),
		);
		expect(buildPlanReceiptPayload(input).result_digest).toMatch(
			/^sha256:[0-9a-f]{64}$/,
		);
	});

	it("passes the terminal outcome through unchanged", () => {
		for (const outcome of ["completed", "failed", "aborted"] as const) {
			expect(buildPlanReceiptPayload(baseInput({ outcome })).outcome).toBe(
				outcome,
			);
		}
	});

	it("is deterministic for the same input", () => {
		expect(buildPlanReceiptPayload(baseInput())).toEqual(
			buildPlanReceiptPayload(baseInput()),
		);
	});

	it("copies side_effects so caller mutation cannot reach the payload", () => {
		const sideEffects = ["fs.write:a"];
		const payload = buildPlanReceiptPayload(baseInput({ sideEffects }));
		sideEffects.push("fs.write:b");
		expect(payload.side_effects).toEqual(["fs.write:a"]);
	});

	it("accepts an empty side_effects list (honest, not a stub)", () => {
		expect(
			buildPlanReceiptPayload(baseInput({ sideEffects: [] })).side_effects,
		).toEqual([]);
	});

	it("produces different result_digests for different results", () => {
		const a = buildPlanReceiptPayload(baseInput({ result: { ok: true } }));
		const b = buildPlanReceiptPayload(baseInput({ result: { ok: false } }));
		expect(a.result_digest).not.toBe(b.result_digest);
	});
});
