import {
	type EmitOptions,
	newEventId,
	type TapeEmitter,
} from "@buildplane/ledger-client";
import type { UnitCtx } from "./ledger-tool-wrapper.js";

/**
 * Tracks the in-flight dispatch unit so the per-tool-call ledger sink
 * (`createClaudeToolLedgerEmitter`) can stamp each `tool_request` with the
 * correct `unit_id` and parent event id ON THE DISPATCH TAPE (M6-F2).
 *
 * The `planforge dispatch` path brackets each packet's execution with
 * `activity_started` / `activity_completed` events emitted by the kernel through
 * a {@link LedgerActivityPort} — unlike the `bp run` path, which brackets with
 * `unit_started`/`unit_completed` and already tracks unit ctx off the
 * cliEventBus. The tool sink needs the `activity_started` EVENT id as the
 * tool_request parent, but that id is auto-assigned inside the emitter and is
 * invisible to a plain port wrapper.
 *
 * So this tracker observes the tape emitter that feeds the activity port: it
 * assigns (and records) an explicit id for each `activity_started`, and clears
 * the active ctx on `activity_completed`. The dispatch loop supplies the packet
 * unit id via {@link DispatchToolUnitTracker.beginUnit} before each
 * `runPacketAsync`. Every other emit and lifecycle call is delegated unchanged
 * to the real signed writer, so activity, acceptance, and tool events all ride
 * the same serialized tape. It composes with `withCrashAfterActivityGuard`
 * transparently — the guard wraps the port, this wraps the emitter feeding it.
 */
export interface DispatchToolUnitTracker {
	/** Record the unit id of the packet about to be dispatched. */
	beginUnit(unitId: string): void;
	/** Wrap the dispatch tape emitter so `activity_started` ids are captured. */
	observe(emitter: TapeEmitter): TapeEmitter;
	/** Current dispatch unit ctx for the tool sink, or null between activities. */
	getUnitCtx(): UnitCtx | null;
}

export function createDispatchToolUnitTracker(): DispatchToolUnitTracker {
	let pendingUnitId: string | null = null;
	let activeCtx: UnitCtx | null = null;

	return {
		beginUnit(unitId: string): void {
			pendingUnitId = unitId;
		},
		getUnitCtx(): UnitCtx | null {
			return activeCtx;
		},
		observe(emitter: TapeEmitter): TapeEmitter {
			return {
				emit(kind: string, payload: unknown, opts?: EmitOptions): void {
					if (kind === "activity_started") {
						const id = opts?.id ?? newEventId();
						activeCtx = { unitId: pendingUnitId ?? "", parentEventId: id };
						emitter.emit(kind, payload, { ...opts, id });
						return;
					}
					if (kind === "activity_completed") {
						activeCtx = null;
					}
					emitter.emit(kind, payload, opts);
				},
				flush: () => emitter.flush(),
				close: () => emitter.close(),
				claimActivity: (args) => emitter.claimActivity(args),
				recordActivityResult: (args) => emitter.recordActivityResult(args),
				heartbeatActivity: (args) => emitter.heartbeatActivity(args),
				onFailure: (cb) => emitter.onFailure(cb),
				stats: () => emitter.stats(),
			};
		},
	};
}
