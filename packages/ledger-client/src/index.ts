// Public API for @buildplane/ledger-client.
//
// Phase A shipped the types skeleton; Phase B adds the runtime.

/**
 * Generate a new event identifier for the ledger.
 *
 * Uses UUIDv7 so that lexical sort on id matches creation order —
 * critical for the ledger/replay invariants that rely on per-run
 * monotonic event ordering. Do NOT substitute randomUUID (v4):
 * v4 has no time component, and downstream consumers that sort
 * by id will see events out of order.
 */
export { v7 as newEventId } from "uuid";
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
export {
	ACTION_RESOURCE_USAGE_MAX_SAFE_INTEGER,
	assertActionReceiptRecordedV2SafeIntegerResources,
	assertActionResourceUsageV1SafeIntegers,
} from "./payload.js";
export {
	type ActivityClaimResultLine,
	type ActivityHeartbeatResultLine,
	type ActivityResultOutcomeWireV1,
	type ActivityResultResultLine,
	buildClaimActivityV1,
	buildHeartbeatActivityV1,
	buildRecordActivityResultV1,
	type ClaimActivityV1Args,
	type HeartbeatActivityV1Args,
	type RecordActivityResultV1Args,
} from "./wire.js";
