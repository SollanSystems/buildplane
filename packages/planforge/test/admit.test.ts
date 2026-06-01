import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildPlanAdmittedPayload,
	PLANFORGE_AUTHORIZED_NEXT_STEP,
	PlanForgeAdmitRejectedError,
} from "../src/admit.ts";
import { createPlanForgeDryRunPlan } from "../src/index.ts";
import type { PlanForgePlan } from "../src/schema.ts";

const inputFixture = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../apps/cli/test/fixtures/planforge/goal-input.md",
);

function passPlan(): PlanForgePlan {
	return createPlanForgeDryRunPlan(inputFixture);
}

describe("buildPlanAdmittedPayload", () => {
	it("maps a PASS plan to a signed plan_admitted payload", () => {
		const plan = passPlan();
		const payload = buildPlanAdmittedPayload({
			plan,
			decidedBy: "operator:khall",
			decidedAt: "2026-06-01T00:00:00Z",
		});
		expect(payload).toEqual({
			plan_id: plan.id,
			plan_digest: plan.receiptPreview.planDigest,
			input_digest: plan.receiptPreview.inputDigest,
			trusted_base: plan.trustedBase,
			decided_by: "operator:khall",
			decided_at: "2026-06-01T00:00:00Z",
			idempotency_key: plan.idempotencyKey,
			authorized_next_step: PLANFORGE_AUTHORIZED_NEXT_STEP,
		});
		expect(PLANFORGE_AUTHORIZED_NEXT_STEP).toBe("dispatch_admitted_plan");
	});

	it("is deterministic for the same plan and operator", () => {
		const plan = passPlan();
		const a = buildPlanAdmittedPayload({
			plan,
			decidedBy: "operator:k",
			decidedAt: "2026-06-01T00:00:00Z",
		});
		const b = buildPlanAdmittedPayload({
			plan,
			decidedBy: "operator:k",
			decidedAt: "2026-06-01T00:00:00Z",
		});
		expect(a).toEqual(b);
		expect(a.idempotency_key).toBe(plan.idempotencyKey);
	});

	it("fails closed on a non-PASS plan with no payload", () => {
		const plan = passPlan();
		plan.validation = { ...plan.validation, status: "INSUFFICIENT_EVIDENCE" };
		expect(() =>
			buildPlanAdmittedPayload({
				plan,
				decidedBy: "operator:k",
				decidedAt: "2026-06-01T00:00:00Z",
			}),
		).toThrow(PlanForgeAdmitRejectedError);
	});

	it("fails closed when the operator identity is empty", () => {
		const plan = passPlan();
		expect(() =>
			buildPlanAdmittedPayload({
				plan,
				decidedBy: "  ",
				decidedAt: "2026-06-01T00:00:00Z",
			}),
		).toThrow(PlanForgeAdmitRejectedError);
	});
});
