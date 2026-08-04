import type {
	LedgerActivityCompleteInput,
	LedgerActivityPort,
	LedgerActivityStartInput,
} from "@buildplane/kernel";
import type { ActivityType, TapeEmitter } from "@buildplane/ledger-client";
import { digest } from "@buildplane/planforge";

/**
 * Shared port body. Reads the signed {@link TapeEmitter} via `getEmitter` at
 * activity time. When the getter returns `null` (no signed ledger bound — e.g. a
 * non-ledger `buildplane run`), both methods are no-ops, so run behaviour is
 * byte-unchanged. Both methods await `emitter.flush()` so they resolve only once
 * the event is durably on the signed tape: for `activityStarted` that is
 * write-ahead ordering (the orchestrator awaits it before invoking the
 * activity); for `activityCompleted` it is the failure channel — `emit()` alone
 * swallows queue-write errors, so without the flush a rejected append (the
 * native signed-ingest denylist rejects `activity_completed`) would resolve as
 * success while nothing reached the tape.
 */
function makeLedgerActivityPort(
	getEmitter: () => TapeEmitter | null,
): LedgerActivityPort {
	return {
		async activityStarted(i: LedgerActivityStartInput): Promise<void> {
			const emitter = getEmitter();
			if (!emitter) return;
			emitter.emit("activity_started", {
				ActivityStartedV1: {
					run_id: i.runId,
					activity_id: i.activityId,
					// ActivityStartedV1.activity_type is the generated `ActivityType` enum
					// (Model/Tool/Command); its values equal the kernel string-union values,
					// so the cast is sound.
					activity_type: i.activityType as ActivityType,
					input_digest: digest(i.input),
				},
			});
			await emitter.flush(); // durable before the activity is invoked
		},
		async activityCompleted(i: LedgerActivityCompleteInput): Promise<void> {
			const emitter = getEmitter();
			if (!emitter) return;
			emitter.emit("activity_completed", {
				ActivityCompletedV1: {
					run_id: i.runId,
					activity_id: i.activityId,
					result_digest: digest(i.result),
					result: i.result,
				},
			});
			await emitter.flush(); // surfaces a rejected append instead of resolving silently
		},
	};
}

/**
 * CLI-layer {@link LedgerActivityPort} over a signed {@link TapeEmitter} that
 * already exists at construction time (the `planforge dispatch` path opens the
 * emitter before the orchestrator).
 */
export function createLedgerActivityPort(
	emitter: TapeEmitter,
): LedgerActivityPort {
	return makeLedgerActivityPort(() => emitter);
}

/**
 * Deferred variant for the `buildplane run` path, where the orchestrator is
 * constructed (`loadCliOrchestrator`) BEFORE the run-block signed emitter is
 * spawned. The getter is read lazily at activity time — by which point the run
 * block has bound the signed emitter (or left it `null` for a non-ledger run, in
 * which case bracketing is skipped).
 */
export function createDeferredLedgerActivityPort(
	getEmitter: () => TapeEmitter | null,
): LedgerActivityPort {
	return makeLedgerActivityPort(getEmitter);
}
