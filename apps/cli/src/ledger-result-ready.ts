import type { ResultReadyPort } from "@buildplane/kernel";
import type { ResultReadyV1, TapeEmitter } from "@buildplane/ledger-client";

/**
 * Map the kernel-facing ids to the snake_case Tier-2 wire payload `ResultReadyV1`
 * (all-string fields — no `u64` precision hazard). The three ids chain the run to
 * the `plan_admitted` and `acceptance_recorded` events that authorized/accepted it.
 */
export function toResultReadyWirePayload(
	runId: string,
	admissionEventId: string,
	acceptanceEventId: string,
): ResultReadyV1 {
	return {
		run_id: runId,
		admission_event_id: admissionEventId,
		acceptance_event_id: acceptanceEventId,
	};
}

/**
 * Kernel-facing {@link ResultReadyPort} over the signed dispatch {@link TapeEmitter}
 * (M6-S7). Emitted on the SAME long-lived signed emitter the acceptance/activity
 * events ride, so `result_ready` lands on one serialized connection without a second
 * concurrent writer mid-run. `flush`es so `recordResultReady` resolves only once the
 * event is durably on the tape — write-ahead of the later operator merge/quarantine
 * decision. Mirrors {@link createAcceptancePort}: the emitter is kernel-signed
 * (`ledger serve --sign`, `key_id="kernel-main"`) by the dispatch caller.
 *
 * QUARANTINED WRITE SURFACE (operator decision 2026-08-15). `result_ready` is on
 * the native *signed-only* denylist (`bp-ledger` `serve.rs`
 * `reject_caller_supplied_authority_event`, serve.rs:325): a caller-supplied
 * append can never reach a signed tape, by protocol design — such effects require
 * a dedicated native control that replays and verifies the preceding evidence.
 * The kernel-signed emitter this port is documented to ride is exactly what puts
 * it on the wrong side of that list. This factory has no reachable production
 * callers: `run-cli.ts` names it twice, in `runPlanForgeDispatchCommand` and in
 * `resumePlanForgePlanFromInput`, but BOTH bodies sit after an unconditional
 * `blockPlanForgeLegacyExecution()` throw, so neither construction ever runs. Do
 * NOT re-wire it without that native control, and note that merely deleting the
 * `blockPlanForgeLegacyExecution()` gates would resurrect a writer that the tape
 * rejects. See `docs/operations/trust-spine-compatibility-matrix.md`.
 */
export function createResultReadyPort(emitter: TapeEmitter): ResultReadyPort {
	return {
		async recordResultReady(
			runId: string,
			admissionEventId: string,
			acceptanceEventId: string,
		): Promise<void> {
			emitter.emit("result_ready", {
				ResultReadyV1: toResultReadyWirePayload(
					runId,
					admissionEventId,
					acceptanceEventId,
				),
			});
			await emitter.flush();
		},
	};
}
