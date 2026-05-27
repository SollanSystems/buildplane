---
"buildplane": minor
---

M1 · S6 — tape-root checkpoint events: add periodic, signed tape-root checkpoints
so an external verifier can validate a compact tape prefix without replaying every
event. New `TapeCheckpoint` event kind (wire `tape_checkpoint`) and `#[typeshare]`
payload `TapeCheckpointV1` (`run_id`, `checkpoint_index`, `through_event_id`,
`through_event_count`, `previous_checkpoint_event_id`, `tape_root_hash`,
`algorithm`). The root is a monotonic local checkpoint, NOT a Merkle tree:

```text
tape_root_hash = "sha256:" + hex(sha256(join("\n", ordered canonical_event_hash strings through through_event_id)))
```

`payload::checkpoint::tape_root_hash` is the pure-function contract an external
verifier (S7) must mirror exactly: it hashes the per-event `sha256:<hex>` strings
of the signed events in tape order (UUIDv7 id ascending), `\n`-joined with no
trailing newline. Each checkpoint covers the full prefix of the run's signed
ordinary (non-checkpoint) events from run start through `through_event_id`.

Emission lives in the signed-append path. `SqliteStore::append_signed_with_checkpoint`
appends the ordinary event + its detached signature atomically (as before), then
— in signed mode with an enabled `CheckpointPolicy` — emits a checkpoint when the
per-run cadence is reached (default 256 signed events; `CheckpointPolicy::every(n)`
for tests) or when a `run_completed` event leaves ≥1 signed ordinary event
uncheckpointed since the last checkpoint. `checkpoint_index` increments per run and
`previous_checkpoint_event_id` chains the checkpoints. The checkpoint event is
signed and appended together with its signature in a single transaction, so a
checkpoint never persists without its signature (fail closed); a forced
signature-insert failure rolls back the checkpoint event too. Checkpoints belong
to signed mode only — the unsigned append path and a `Disabled` policy emit none.
The live signed serve loop (`SigningConfig::Signed`) defaults to cadence 256.
`tape_checkpoint` events are replay no-ops (tape-integrity metadata, not state
transitions). The frozen 7-field event envelope is unchanged.

Generated TypeScript bindings (`packages/ledger-client/src/generated/index.ts`),
the hand-written `Payload` union (`payload.ts`), and the payload-variants fixture
are regenerated to include `TapeCheckpointV1` / `TapeRootAlgorithm` (16 variants).
