import type {
	OperatorDecisionPort,
	RecordOperatorDecisionInput,
} from "@buildplane/kernel";
import type { OperatorDecisionRecordedV1 } from "@buildplane/ledger-client";
import { createTapeEmitter, type TapeEmitter } from "@buildplane/ledger-client";
import {
	assertKernelSigningKey,
	PLANFORGE_KERNEL_SIGNING_KEY_ID,
	resolveLedgerBinary,
	spawnLedgerSubprocess,
} from "./ledger-emit.js";

/**
 * Map the kernel-facing camelCase decision input to the snake_case Tier-2 wire
 * payload `OperatorDecisionRecordedV1`. The live write-ahead path omits
 * `merge_commit` (M5-S4 D1: the merge has not happened at emit time); a present
 * `mergeCommit` is only set when post-hoc recording a completed merge.
 */
export function toOperatorDecisionWirePayload(
	input: RecordOperatorDecisionInput,
): OperatorDecisionRecordedV1 {
	return {
		run_id: input.runId,
		decision: input.decision,
		subject: input.subject,
		...(input.acceptanceEventId
			? { acceptance_event_id: input.acceptanceEventId }
			: {}),
		...(input.admissionEventId
			? { admission_event_id: input.admissionEventId }
			: {}),
		...(input.mergeCommit ? { merge_commit: input.mergeCommit } : {}),
		decided_by: input.decidedBy,
		decided_at: input.decidedAt,
	};
}

/**
 * Kernel-facing {@link OperatorDecisionPort} over the signed Rust ledger. Each
 * `recordDecision` spawns a `ledger serve --sign` subprocess (the standalone
 * emit pattern shared with `ledger-acceptance.ts` / `planforge-authorize-envelope.ts`
 * — `bp-ledger serve` has no run-status guard, so appending to a completed run
 * is supported), emits the signed `operator_decision_recorded`, `flush`es so the
 * decision is durably on the tape BEFORE the orchestrator applies the side
 * effect (write-ahead, M5-S4 D1), then `close`s the subprocess.
 */
export function createOperatorDecisionPort(cwd: string): OperatorDecisionPort {
	return {
		async recordDecision(input: RecordOperatorDecisionInput): Promise<void> {
			assertKernelSigningKey();
			const payload = toOperatorDecisionWirePayload(input);
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
					`operator-decision: signed ledger handshake failed: ${String(err)}`,
				);
			}
			try {
				emitter.emit("operator_decision_recorded", {
					OperatorDecisionRecordedV1: payload,
				});
				await emitter.flush();
				await emitter.close();
			} catch (err) {
				if (ledgerChild.child.exitCode === null) {
					ledgerChild.child.kill("SIGTERM");
				}
				throw new Error(
					`operator-decision: failed to append signed operator_decision_recorded: ${String(err)}`,
				);
			}
		},
	};
}
