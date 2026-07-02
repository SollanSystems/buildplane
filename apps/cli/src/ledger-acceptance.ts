import type {
	AcceptanceRecordInput,
	BuildplaneAcceptancePort,
} from "@buildplane/kernel";
import type { TapeEmitter } from "@buildplane/ledger-client";
import type { AcceptanceContractV0 } from "@buildplane/planforge";
import { evaluateArchitectureDiffScope } from "@buildplane/policy";

/** Plan identity the kernel does not carry on the verdict — supplied by the CLI. */
export interface AcceptanceRecordedEmitInput {
	readonly planId: string;
	readonly admissionEventId: string;
	readonly contractDigest: string;
	readonly outcome: "passed" | "rejected";
	readonly diffScopeStatus: "passed" | "blocked";
	readonly outOfScopeFiles: readonly string[];
	readonly checkResults: readonly { command: string; exitCode: number }[];
	readonly evaluatedAt: string;
}

/**
 * Append a signed `acceptance_recorded` finalization verdict. Every numeric
 * field is a String on the wire (`AcceptanceRecordedV1`) — the U64 → TS-number
 * hazard. A check `status` is `passed` iff its `exit_code` is 0.
 */
export function emitAcceptanceRecorded(
	emitter: TapeEmitter,
	input: AcceptanceRecordedEmitInput,
): void {
	emitter.emit("acceptance_recorded", {
		AcceptanceRecordedV1: {
			plan_id: input.planId,
			admission_event_id: input.admissionEventId,
			contract_digest: input.contractDigest,
			outcome: input.outcome,
			diff_scope_status: input.diffScopeStatus,
			out_of_scope_files: [...input.outOfScopeFiles],
			checks: input.checkResults.map((check) => ({
				command: check.command,
				exit_code: String(check.exitCode),
				status: check.exitCode === 0 ? "passed" : "failed",
			})),
			evaluated_at: input.evaluatedAt,
		},
	});
}

/**
 * Kernel-facing {@link BuildplaneAcceptancePort} over a signed {@link TapeEmitter}.
 * The kernel supplies the verdict it independently observed; this closure adds
 * the plan identity it derived per task, emits the signed event, and `flush`es so
 * `recordAcceptance` resolves only once the verdict is durably on the tape
 * (write-ahead — before the kernel merges or quarantines the workspace). Resolves
 * to the signed `acceptance_recorded` event id (M6-S7) — captured from the emitter's
 * post-flush ack, since the acceptance emit is the last write before the flush — so
 * the kernel can chain a terminal `result_ready` to it.
 */
export function createAcceptancePort(
	emitter: TapeEmitter,
	identity: { readonly planId: string; readonly contractDigest: string },
): BuildplaneAcceptancePort {
	return {
		async recordAcceptance(
			input: AcceptanceRecordInput,
		): Promise<string | undefined> {
			emitAcceptanceRecorded(emitter, {
				planId: identity.planId,
				admissionEventId: input.admissionEventId,
				contractDigest: identity.contractDigest,
				outcome: input.outcome,
				diffScopeStatus: input.diffScopeStatus,
				outOfScopeFiles: input.outOfScopeFiles,
				checkResults: input.checkResults,
				evaluatedAt: input.evaluatedAt,
			});
			await emitter.flush();
			return emitter.stats().lastAckedEventId ?? undefined;
		},
	};
}

/**
 * Structured diff-scope arm of the acceptance verdict for the signed event,
 * reusing the same deterministic matcher the architecture diff-scope gate uses
 * so the recorded `out_of_scope_files` match what the gate would block.
 */
export function evaluateAcceptanceDiffScope(
	changedFiles: readonly string[],
	contract: AcceptanceContractV0,
): { status: "passed" | "blocked"; outOfScopeFiles: readonly string[] } {
	const evaluation = evaluateArchitectureDiffScope(changedFiles, {
		allowedPaths: contract.diff_scope.allowed_globs,
		deniedPaths: contract.diff_scope.denied_globs,
	});
	return {
		status: evaluation.status,
		outOfScopeFiles: [...evaluation.outOfScopeFiles, ...evaluation.deniedFiles],
	};
}
