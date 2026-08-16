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
 *
 * QUARANTINED WRITE SURFACE (operator decision 2026-08-15). `activity_started` and
 * `activity_completed` are on the native *signed-only* denylist (`bp-ledger`
 * `serve.rs` `reject_caller_supplied_authority_event`, serve.rs:314-315): a
 * caller-supplied append can never reach a signed tape, by protocol design — such
 * effects require a dedicated native control that replays and verifies the
 * preceding evidence. Every construction of this port is fed a `--sign` emitter,
 * so the signed-only list applies to all of them. Do NOT re-wire it without that
 * native control. See `docs/operations/trust-spine-compatibility-matrix.md`.
 *
 * This factory has no reachable production callers, and it is dead behind TWO
 * INDEPENDENT gates. Removing either one alone does NOT resurrect it, so a future
 * editor must clear both — and clearing both resurrects a writer the tape rejects:
 *
 *  1. Both `run-cli.ts` constructions — inside `runPlanForgeDispatchCommand` and
 *     inside `resumePlanForgePlanFromInput` — sit after an unconditional
 *     `blockPlanForgeLegacyExecution()` throw, so neither body ever runs.
 *  2. INDEPENDENTLY of that throw, `runPlanForgeDispatchCommand` returns early to
 *     `runPlanForgeBrokerDispatchCommand` whenever the args carry
 *     `--admission-ref` or `--task-ref` — and that early return fires BEFORE the
 *     `blockPlanForgeLegacyExecution()` call, not after it. The broker dispatch
 *     command never touches the activity port at all. So the only argument shapes
 *     that could reach the construction below are exactly the ones the throw in
 *     gate 1 rejects, and the only argument shapes that skip the throw take a
 *     branch that has no activity port.
 *
 * Gate 2 is the one that is easy to lose: it is a plain early `return` several
 * lines above the throw, with nothing marking it as load-bearing for deadness.
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
 *
 * QUARANTINED WRITE SURFACE (operator decision 2026-08-15) on the same terms as
 * {@link createLedgerActivityPort} — same two kinds, same native *signed-only*
 * denylist. Its single `run-cli.ts` construction is live, but its getter can only
 * ever return `null`: the raw-run block that would bind the emitter is gated on a
 * hard-coded `const useLedger = false`, so both methods take the no-op path and
 * nothing is ever emitted. Binding an emitter there is what would resurrect the
 * writer; do NOT do so without the native control described above.
 */
export function createDeferredLedgerActivityPort(
	getEmitter: () => TapeEmitter | null,
): LedgerActivityPort {
	return makeLedgerActivityPort(getEmitter);
}
