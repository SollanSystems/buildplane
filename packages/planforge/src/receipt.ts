import { digest } from "./digest.js";

/** Closed terminal outcome vocabulary for a plan receipt (mirrors `PlanReceiptOutcome`). */
export type PlanReceiptOutcome = "completed" | "failed" | "aborted";

/**
 * Wire shape of a `plan_receipt` tape-event payload. Structurally identical to
 * `@buildplane/ledger-client`'s generated `PlanReceiptRecordedV1`. planforge
 * stays a zero-dependency leaf, so the canonical type is not imported here; the
 * CLI emit site binds this to `PlanReceiptRecordedV1`, so a missing or mistyped
 * field fails typecheck. The Rust payload struct + byte-stable fixtures remain
 * the wire-shape source of truth.
 */
export interface PlanReceiptPayload {
	readonly plan_id: string;
	readonly admission_event_id: string;
	readonly outcome: PlanReceiptOutcome;
	readonly side_effects: string[];
	readonly result_digest: string;
	readonly decided_at: string;
}

export interface BuildPlanReceiptInput {
	readonly planId: string;
	/** The `plan_admitted` event id this receipt finalizes (chaining key). */
	readonly admissionEventId: string;
	readonly outcome: PlanReceiptOutcome;
	/** Declared side-effect scopes for the completed plan. */
	readonly sideEffects: readonly string[];
	/** Recorded plan result; digested into `result_digest` (not stored inline). */
	readonly result: unknown;
	/** Receipt timestamp, RFC3339 — injected by the caller (keeps the builder pure). */
	readonly decidedAt: string;
}

/**
 * Build the terminal `plan_receipt` payload. Pure and deterministic: the result
 * is bound only by its canonical `result_digest` (the receipt never stores the
 * result inline), and `decided_at` is supplied by the caller so the same inputs
 * always produce the same payload.
 */
export function buildPlanReceiptPayload(
	input: BuildPlanReceiptInput,
): PlanReceiptPayload {
	return {
		plan_id: input.planId,
		admission_event_id: input.admissionEventId,
		outcome: input.outcome,
		side_effects: [...input.sideEffects],
		result_digest: digest(input.result),
		decided_at: input.decidedAt,
	};
}
