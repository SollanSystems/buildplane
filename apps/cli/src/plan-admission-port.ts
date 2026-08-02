import type {
	PlanAdmissionPort,
	PlanAdmissionRecordInput,
} from "@buildplane/kernel";

/**
 * Minimal seam over the signed tape emitter. `plan_admitted` is deliberately NOT
 * in the emitter's caller-supplied denylist, so it may be emitted from here —
 * unlike the V5 dispatch admission, which is native-only.
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

export function createPlanAdmissionPort(
	emitter: PlanAdmissionEmitter,
): PlanAdmissionPort {
	return {
		async recordPlanAdmission(
			input: PlanAdmissionRecordInput,
		): Promise<string> {
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
