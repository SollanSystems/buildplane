// Phase A ships types only. Phase B adds the tape-emitter, IPC protocol, and
// runtime code.

export * from "./generated/index.js";
// Re-export the hand-written Payload union (externally-tagged, matches wire format).
export type { Payload } from "./payload.js";
export * from "./shims.js";
