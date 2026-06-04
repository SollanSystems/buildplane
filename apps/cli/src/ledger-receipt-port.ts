import type { TapeEmitter } from "@buildplane/ledger-client";
import type { PlanReceiptPayload } from "@buildplane/planforge";

/**
 * CLI-layer adapter that emits the terminal signed `plan_receipt` onto a signed
 * ledger {@link TapeEmitter} and flushes so the receipt is durable before the
 * subprocess closes (and before S7b recovery can read it back). The payload is
 * built by `@buildplane/planforge`'s `buildPlanReceiptPayload`; the wire shape
 * is enforced by the Rust `PlanReceiptRecordedV1` struct + byte-stable fixtures
 * + the external-verifier e2e, consistent with the activity-bracket port.
 */
export function createLedgerReceiptPort(emitter: TapeEmitter): {
	emitPlanReceipt(payload: PlanReceiptPayload): Promise<void>;
} {
	return {
		async emitPlanReceipt(payload: PlanReceiptPayload): Promise<void> {
			emitter.emit("plan_receipt", { PlanReceiptRecordedV1: payload });
			await emitter.flush(); // durable terminal receipt
		},
	};
}
