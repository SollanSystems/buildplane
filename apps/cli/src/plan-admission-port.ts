import type {
	PlanAdmissionPort,
	PlanAdmissionRecordInput,
} from "@buildplane/kernel";
import { PLANFORGE_AUTHORIZED_NEXT_STEP } from "@buildplane/planforge";

/**
 * Minimal seam over the signed tape emitter.
 *
 * QUARANTINED WRITE SURFACE (operator decision 2026-08-15). `plan_admitted` can
 * reach NEITHER generic-ingest lane, by protocol design — such effects require a
 * dedicated native control that replays and verifies the preceding evidence. A
 * signed append is refused at the wire guard (`bp-ledger` `serve.rs`
 * `reject_caller_supplied_authority_event`, serve.rs:312); an unsigned one clears
 * that guard and is refused one layer down by
 * `SqliteStore::validate_external_append`, which always blocks the kind — and,
 * because replay dispatches on the payload variant, also blocks a
 * `PlanAdmittedV1` payload under any other kind.
 * {@link createPlanAdmissionPort} has no production callers; its only callers are
 * `apps/cli/test/plan-admission-port.test.ts` (a unit test over a fake emitter)
 * and `test/ledger-integration/planforge-plan-admission.test.ts` — an EXECUTING
 * regression pin that drives this port over the real `TapeEmitter` against a live
 * `ledger serve` subprocess on each lane in turn, asserting both distinct native
 * rejections and a fail-closed empty tape after each. So, like the
 * operator-decision and run-completion ports, the native rejection for
 * `plan_admitted` is pinned by an executing test. Do NOT re-wire this port
 * without that native control. See
 * `docs/operations/trust-spine-compatibility-matrix.md`. The mechanics of why the
 * call-site guard does not catch this:
 *
 * `plan_admitted` is absent from the emitter's
 * `CALLER_SUPPLIED_TRUST_SPINE_KINDS` guard, but that does NOT make it emittable
 * on any tape. That guard mirrors only the native *always-blocked* wire denylist;
 * `plan_admitted` is on the native *signed-only* wire denylist
 * (`reject_caller_supplied_authority_event`, serve.rs:312, applied at
 * serve.rs:731-734), and the client cannot mirror that list because `emit` has no
 * signing context. A signed append from this port is rejected by the native
 * subprocess — `caller-supplied signed authority event plan_admitted is
 * rejected: the generic signed ingest endpoint cannot bless workflow lifecycle
 * or decision records`. An unsigned append is rejected too, by a different guard
 * on a different layer — `caller-supplied trust-spine event plan_admitted is
 * rejected: authority-bearing records must use a dedicated native control`,
 * reported as `storage_failure`. Both walls are documented in
 * `test/ledger-integration/planforge-plan-admission.test.ts`. So, like the V5
 * dispatch admission, `plan_admitted` needs a dedicated native control that
 * mints it from verified state; this port cannot reach a tape until one exists.
 *
 * Narrower than `TapeEmitter` on purpose: the real emitter's `emit` is
 * synchronous, fire-and-forget, and returns no id (the caller supplies one via
 * `opts.id`), so a port built directly on it could not resolve the durable event
 * id. This adapter shape keeps the port unit-testable without a live ledger; the
 * concrete `TapeEmitter`-backed adapter (emit + flush + acked id) is wired
 * separately.
 */
export interface PlanAdmissionEmitter {
	emit(kind: string, payload: unknown): Promise<string>;
}

const REQUIRED_FIELDS = [
	"planId",
	"planDigest",
	"inputDigest",
	"trustedBase",
	"decidedBy",
	"decidedAt",
	"idempotencyKey",
] as const satisfies readonly (keyof PlanAdmissionRecordInput)[];

export function createPlanAdmissionPort(
	emitter: PlanAdmissionEmitter,
): PlanAdmissionPort {
	return {
		async recordPlanAdmission(
			input: PlanAdmissionRecordInput,
		): Promise<string> {
			// This port is the only writer of a signed tape event that later
			// authorizes dispatch, and the `validation.status === PASS` gate in
			// `buildPlanAdmittedPayload` is bypassable here because the port accepts
			// a pre-built input. Assert fail-closed on our own terms rather than
			// trusting a callsite that does not exist yet.
			for (const field of REQUIRED_FIELDS) {
				const value = input[field];
				if (typeof value !== "string" || value.trim() === "") {
					throw new Error(
						`plan_admitted requires a non-empty ${field}; refusing to sign.`,
					);
				}
			}
			if (input.authorizedNextStep !== PLANFORGE_AUTHORIZED_NEXT_STEP) {
				throw new Error(
					`plan_admitted authorized_next_step must be "${PLANFORGE_AUTHORIZED_NEXT_STEP}", got "${input.authorizedNextStep}"; refusing to sign an admission that could never authorize dispatch.`,
				);
			}

			const eventId = await emitter.emit("plan_admitted", {
				PlanAdmittedV1: {
					plan_id: input.planId,
					plan_digest: input.planDigest,
					input_digest: input.inputDigest,
					trusted_base: input.trustedBase,
					decided_by: input.decidedBy,
					decided_at: input.decidedAt,
					idempotency_key: input.idempotencyKey,
					authorized_next_step: input.authorizedNextStep,
				},
			});
			if (!eventId) {
				throw new Error(
					"plan_admitted emitter did not return a signed event id.",
				);
			}
			return eventId;
		},
	};
}
