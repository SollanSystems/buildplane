import type {
	OperatorDecisionPort,
	RunCompletionPort,
} from "@buildplane/kernel";
import { OperatorDecisionSurfaceRetiredError } from "@buildplane/kernel";

/**
 * The one reason both retired ports carry. It is operator-facing text: it
 * reaches a `bp web` user verbatim as the body of the 501 the Mission Control
 * decision route returns, and it is logged at boot for every recovered record
 * whose signed completion event was skipped.
 */
export const RETIRED_OPERATOR_DECISION_SURFACE_REASON =
	"the bp web operator-decision write surface is retired under Trust Spine containment (operator decision 2026-08-15): operator_decision_recorded and run_completed are caller-supplied authority kinds the signed protocol refuses; see docs/operations/trust-spine-compatibility-matrix.md";

/**
 * The retired `operator_decision_recorded` writer. It replaces the ledger-backed
 * `createOperatorDecisionPort` in the default CLI wiring: that port spawns a
 * signed `ledger serve --sign` append the native signed-only denylist rejects,
 * which surfaced as an opaque HTTP 500 on every approve/reject.
 *
 * `retired` is what actually governs — the orchestrator refuses the decision on
 * that marker before validation, emit, mirror or side effect. `recordDecision`
 * throwing is defense in depth: reaching it means the guard was bypassed, and a
 * bypassed guard must not be able to make an unrecordable decision look
 * recorded.
 */
export function createRetiredOperatorDecisionPort(): OperatorDecisionPort {
	return {
		retired: { reason: RETIRED_OPERATOR_DECISION_SURFACE_REASON },
		recordDecision(): Promise<void> {
			return Promise.reject(
				new OperatorDecisionSurfaceRetiredError(
					RETIRED_OPERATOR_DECISION_SURFACE_REASON,
				),
			);
		},
	};
}

/**
 * The retired `run_completed` writer, retired for the same reason and as one
 * unit with the decision port above (see {@link createRetiredOperatorDecisionPort}).
 * Its marker additionally lets startup recovery settle a historical
 * decided-but-unexecuted terminal record exactly once — skipping, and
 * disclosing, the signed terminal event it can never emit.
 */
export function createRetiredRunCompletionPort(): RunCompletionPort {
	return {
		retired: { reason: RETIRED_OPERATOR_DECISION_SURFACE_REASON },
		recordRunCompleted(): Promise<void> {
			return Promise.reject(
				new OperatorDecisionSurfaceRetiredError(
					RETIRED_OPERATOR_DECISION_SURFACE_REASON,
				),
			);
		},
	};
}
