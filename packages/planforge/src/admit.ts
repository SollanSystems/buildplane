import {
	PLANFORGE_VALIDATION_STATUS_PASS,
	type PlanForgePlan,
} from "./schema.js";

/** Next step a PlanForge admission authorizes; the dispatch authority. */
export const PLANFORGE_AUTHORIZED_NEXT_STEP = "dispatch_admitted_plan";

/**
 * Wire shape of a `plan_admitted` tape-event payload. Structurally identical to
 * `@buildplane/ledger-client`'s generated `PlanAdmittedV1`. planforge stays a
 * zero-dependency leaf, so the canonical type is not imported here; the CLI emit
 * site binds this to `PlanAdmittedV1`, making any drift a typecheck failure.
 */
export interface PlanAdmittedPayload {
	readonly plan_id: string;
	readonly plan_digest: string;
	readonly input_digest: string;
	readonly trusted_base: string;
	readonly decided_by: string;
	readonly decided_at: string;
	readonly idempotency_key: string;
	readonly authorized_next_step: string;
}

export interface AdmitPlanInput {
	readonly plan: PlanForgePlan;
	/** Operator identity recorded as `decided_by`; the kernel key signs the event. */
	readonly decidedBy: string;
	/** Admission timestamp, RFC3339. */
	readonly decidedAt: string;
}

/** Thrown when admission is rejected. Carries no payload — the caller must not write a tape event. */
export class PlanForgeAdmitRejectedError extends Error {
	readonly code = "PLANFORGE_ADMIT_REJECTED";

	constructor(message: string) {
		super(message);
		this.name = "PlanForgeAdmitRejectedError";
	}
}

function requireOperatorField(value: string, field: string): string {
	const trimmed = typeof value === "string" ? value.trim() : "";
	if (!trimmed) {
		throw new PlanForgeAdmitRejectedError(
			`${field} must be a non-empty string.`,
		);
	}
	return trimmed;
}

/**
 * Build the signed `plan_admitted` payload for a PASS plan. Fails closed with no
 * payload on any non-PASS validation status or a missing operator/timestamp —
 * the admit stage must never sign an unvalidated or unattributed admission. The
 * plan-derived digests/idempotency key are trusted as computed by `preview`.
 */
export function buildPlanAdmittedPayload(
	input: AdmitPlanInput,
): PlanAdmittedPayload {
	const { plan } = input;
	if (plan.validation.status !== PLANFORGE_VALIDATION_STATUS_PASS) {
		throw new PlanForgeAdmitRejectedError(
			`PlanForge admission requires validation status PASS; got ${plan.validation.status}. No tape event written.`,
		);
	}
	const decidedBy = requireOperatorField(
		input.decidedBy,
		"operator (decided_by)",
	);
	const decidedAt = requireOperatorField(input.decidedAt, "decided_at");
	return {
		plan_id: plan.id,
		plan_digest: plan.receiptPreview.planDigest,
		input_digest: plan.receiptPreview.inputDigest,
		trusted_base: plan.trustedBase,
		decided_by: decidedBy,
		decided_at: decidedAt,
		idempotency_key: plan.idempotencyKey,
		authorized_next_step: PLANFORGE_AUTHORIZED_NEXT_STEP,
	};
}
