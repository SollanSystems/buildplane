import type {
	RecordRunCompletedInput,
	RunCompletionOutcome,
	RunCompletionPort,
} from "@buildplane/kernel";
import type { RunCompletedV1, TapeEmitter } from "@buildplane/ledger-client";
import { createTapeEmitter, RunOutcome } from "@buildplane/ledger-client";
import {
	assertKernelSigningKey,
	PLANFORGE_KERNEL_SIGNING_KEY_ID,
	resolveLedgerBinary,
	spawnLedgerSubprocess,
} from "./ledger-emit.js";

const RUN_OUTCOME_WIRE: Record<RunCompletionOutcome, RunOutcome> = {
	passed: RunOutcome.Passed,
	failed: RunOutcome.Failed,
	cancelled: RunOutcome.Cancelled,
};

/**
 * Map the kernel-facing completion input to the Tier-2 wire payload
 * `RunCompletedV1`. `duration_ms`/`event_count`/`unit_count` are strings on the wire
 * (the U64 → TS-number hazard — M6-S7 A3), supplied synchronously by the
 * orchestrator from the inspect snapshot.
 */
export function toRunCompletedWirePayload(
	input: RecordRunCompletedInput,
): RunCompletedV1 {
	return {
		outcome: RUN_OUTCOME_WIRE[input.outcome],
		duration_ms: input.durationMs,
		event_count: input.eventCount,
		unit_count: input.unitCount,
	};
}

/**
 * Kernel-facing {@link RunCompletionPort} over the signed Rust ledger (M6-S7). Each
 * `recordRunCompleted` spawns a `ledger serve --sign` subprocess (the standalone
 * emit pattern shared with `ledger-operator-decision.ts` — `bp-ledger serve` has no
 * run-status guard, so appending a completion to an already-terminal run is
 * supported), emits the signed `run_completed`, `flush`es so it is durable on the
 * tape, then `close`s the subprocess. Used from the operator-decision path (a
 * separate CLI invocation with no live dispatch emitter), so it owns its subprocess
 * rather than sharing one.
 */
export function createRunCompletionPort(cwd: string): RunCompletionPort {
	return {
		async recordRunCompleted(input: RecordRunCompletedInput): Promise<void> {
			assertKernelSigningKey();
			const payload = toRunCompletedWirePayload(input);
			const binary = resolveLedgerBinary(cwd);
			const ledgerChild = spawnLedgerSubprocess(binary, input.runId, cwd, {
				sign: true,
				signingKeyId: PLANFORGE_KERNEL_SIGNING_KEY_ID,
			});
			let emitter: TapeEmitter;
			try {
				emitter = await createTapeEmitter({
					childStdin: ledgerChild.stdin,
					childStderr: ledgerChild.stderr,
					childExit: ledgerChild.exit,
					workspacePath: cwd,
					runId: input.runId,
				});
			} catch (err) {
				if (ledgerChild.child.exitCode === null) {
					ledgerChild.child.kill("SIGTERM");
				}
				throw new Error(
					`run-completed: signed ledger handshake failed: ${String(err)}`,
				);
			}
			try {
				emitter.emit("run_completed", { RunCompletedV1: payload });
				await emitter.flush();
				await emitter.close();
			} catch (err) {
				if (ledgerChild.child.exitCode === null) {
					ledgerChild.child.kill("SIGTERM");
				}
				throw new Error(
					`run-completed: failed to append signed run_completed: ${String(err)}`,
				);
			}
		},
	};
}
