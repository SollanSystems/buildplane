import type { TapeEmitter } from "@buildplane/ledger-client";

export interface CapabilityDeniedEmitInput {
	readonly runId: string;
	readonly bundleDigest: string;
	readonly tool: string;
	readonly reason: string;
	readonly target: string;
}

/** Append a signed `capability_denied` quarantine event when a tape port exists. */
export function emitCapabilityDenied(
	emitter: TapeEmitter,
	input: CapabilityDeniedEmitInput,
): void {
	emitter.emit("capability_denied", {
		CapabilityDeniedV1: {
			run_id: input.runId,
			bundle_digest: input.bundleDigest,
			tool: input.tool,
			reason: input.reason,
			target: input.target,
		},
	});
}
