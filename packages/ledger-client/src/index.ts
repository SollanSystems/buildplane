// Public API for @buildplane/ledger-client.
//
// Phase A shipped the types skeleton; Phase B adds the runtime.

export {
	type CreateTapeEmitterOptions,
	createTapeEmitter,
	type EmitOptions,
	type TapeEmitter,
} from "./emitter.js";

export {
	type LedgerFailure,
	type LedgerFailureKind,
	LedgerHandshakeError,
} from "./failure.js";

export * from "./generated/index.js";
export type { Payload } from "./payload.js";
