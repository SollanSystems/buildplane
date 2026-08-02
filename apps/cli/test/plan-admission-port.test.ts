import { describe, expect, it, vi } from "vitest";
import { createPlanAdmissionPort } from "../src/plan-admission-port.js";

const INPUT = {
	planId: "pf-plan-abcd1234",
	planDigest: "sha256:aa",
	inputDigest: "sha256:bb",
	trustedBase: "c".repeat(40),
	decidedBy: "operator-1",
	decidedAt: "2026-07-31T00:00:00Z",
	idempotencyKey: "planforge:v0:buildplane:base:abcd1234",
	authorizedNextStep: "dispatch",
};

describe("createPlanAdmissionPort", () => {
	it("emits plan_admitted and returns the signed event id", async () => {
		const emit = vi.fn(async () => "evt-000000000042");
		const port = createPlanAdmissionPort({ emit });

		const eventId = await port.recordPlanAdmission(INPUT);

		expect(eventId).toBe("evt-000000000042");
		expect(emit).toHaveBeenCalledTimes(1);
		const [kind, payload] = emit.mock.calls[0];
		expect(kind).toBe("plan_admitted");
		expect(payload).toEqual({
			PlanAdmittedV1: {
				plan_id: "pf-plan-abcd1234",
				plan_digest: "sha256:aa",
				input_digest: "sha256:bb",
				trusted_base: "c".repeat(40),
				decided_by: "operator-1",
				decided_at: "2026-07-31T00:00:00Z",
				idempotency_key: "planforge:v0:buildplane:base:abcd1234",
				authorized_next_step: "dispatch",
			},
		});
	});

	it("propagates an emit failure rather than returning an unusable id", async () => {
		const emit = vi.fn(async () => {
			throw new Error("tape unavailable");
		});
		const port = createPlanAdmissionPort({ emit });

		await expect(port.recordPlanAdmission(INPUT)).rejects.toThrow(
			/tape unavailable/,
		);
	});

	it("rejects an empty event id from the emitter", async () => {
		const emit = vi.fn(async () => "");
		const port = createPlanAdmissionPort({ emit });

		await expect(port.recordPlanAdmission(INPUT)).rejects.toThrow(
			/did not return a signed event id/i,
		);
	});
});
