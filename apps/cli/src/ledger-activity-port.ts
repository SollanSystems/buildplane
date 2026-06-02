import type {
	LedgerActivityCompleteInput,
	LedgerActivityPort,
	LedgerActivityStartInput,
} from "@buildplane/kernel";
import type { ActivityType, TapeEmitter } from "@buildplane/ledger-client";
import { digest } from "@buildplane/planforge";

/**
 * CLI-layer {@link LedgerActivityPort}: wraps a signed ledger {@link TapeEmitter},
 * computes the canonical input/result digests, and emits the S2 activity bracket
 * events. `activityStarted` awaits `emitter.flush()` so it resolves only once the
 * event is durably on the signed tape (write-ahead — the orchestrator awaits it
 * before invoking the activity). `activityCompleted` needs no pre-resolve flush.
 */
export function createLedgerActivityPort(
	emitter: TapeEmitter,
): LedgerActivityPort {
	return {
		async activityStarted(i: LedgerActivityStartInput): Promise<void> {
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
			emitter.emit("activity_completed", {
				ActivityCompletedV1: {
					run_id: i.runId,
					activity_id: i.activityId,
					result_digest: digest(i.result),
					result: i.result,
				},
			});
		},
	};
}
