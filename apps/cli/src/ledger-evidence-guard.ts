import type { LedgerFailure, TapeEmitter } from "@buildplane/ledger-client";

/** The subset of a live emitter the guard needs; keeps fakes cheap. */
export type GuardableEmitter = Pick<TapeEmitter, "onFailure" | "close">;

export interface LedgerEvidenceGuard {
	/**
	 * The latched reason the tape stopped accepting evidence, or `null` while it
	 * is still healthy. A non-null value means events the caller emitted are NOT
	 * on the tape, so the run must not report a clean result.
	 */
	lostEvidence(): string | null;
	/**
	 * Close the tape, surfacing a rejected close instead of swallowing it.
	 *
	 * Deliberately never throws: every call site is a `finally` unwinding some
	 * other outcome, and throwing there would replace the original error with a
	 * cleanup error. The failure is surfaced through `report` and `lostEvidence`
	 * instead, which the caller folds into its exit code.
	 *
	 * Idempotent, and skipped entirely once the tape has already failed — the
	 * real emitter throws `ledger failed; close unavailable` in that state, which
	 * would only bury the first, informative reason under a second one.
	 */
	close(): Promise<void>;
}

/**
 * Make a tape emitter's failures observable.
 *
 * `TapeEmitter.emit` is synchronous, returns `void`, and routes queue-write
 * errors into `.catch(() => {})`; once the emitter has latched `failed` it
 * silently returns early from every subsequent `emit`. So on any writer whose
 * own contract is synchronous — the event-bus subscriber that drives
 * `beginLedgerUnit`/`completeLedgerUnit`, the `ToolRegistry` proxy from
 * `wrapToolRegistryForLedger`, the `ClaudeToolEvent` sink, `runGitCheckpoint` —
 * there is no return channel to reject on, and awaiting a flush per emit is not
 * possible without changing those contracts (and would add a subprocess
 * round-trip per tool call). `onFailure` is the emitter's designed channel for
 * exactly this case; this guard is the one place it is turned into a loud,
 * latched, exit-code-bearing signal.
 *
 * Ports whose own contract IS async — `ledger-activity-port.ts` — keep awaiting
 * `flush()` per emit instead, which is strictly stronger; this guard is the
 * fallback for the writers that cannot.
 */
export function guardLedgerEvidence(
	emitter: GuardableEmitter,
	report: (line: string) => void,
): LedgerEvidenceGuard {
	let lost: string | null = null;
	let closed = false;

	function recordLoss(reason: string): void {
		if (lost !== null) return;
		lost = reason;
		report(`ledger evidence lost: ${reason}\n`);
	}

	emitter.onFailure((failure: LedgerFailure) => {
		recordLoss(failure.message);
	});

	return {
		lostEvidence(): string | null {
			return lost;
		},
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			if (lost !== null) return;
			try {
				await emitter.close();
			} catch (err) {
				recordLoss(err instanceof Error ? err.message : String(err));
			}
		},
	};
}
