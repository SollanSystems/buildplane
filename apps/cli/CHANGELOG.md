# buildplane

## 0.9.0

### Minor Changes

- 148ad73: M2-S6: receipt stage — a completed `planforge dispatch` emits one kernel-signed
  `plan_receipt` (chaining to the `plan_admitted` event id, canonical
  `result_digest`, declared `side_effects`); `buildplane ledger export-signed-tape`
  serializes a live `events.db` run into `buildplane.signed-tape.v1` for the
  external verifier, completing the admit → activities → receipt round-trip.

### Patch Changes

- Updated dependencies [148ad73]
  - @buildplane/planforge@0.5.0

## 0.8.0

### Minor Changes

- 6156fbf: M2-S5: activity bracketing — `executeOnce` emits a write-ahead, kernel-signed
  `activity_started` (durably flushed before invoke) and an `activity_completed`
  (recorded result + canonical `result_digest`) via a new kernel `LedgerActivityPort`,
  for both model and command activities. The CLI supplies the concrete signed-emitter
  adapter (`createLedgerActivityPort` / `createDeferredLedgerActivityPort`) and wires
  it into both `planforge dispatch` and `buildplane run` on a kernel-signed tape; a
  fail-fast `assertKernelSigningKey()` precondition guards every signed-ledger path.

### Patch Changes

- Updated dependencies [6156fbf]
  - @buildplane/kernel@0.4.0
  - @buildplane/adapters-codex@0.1.3
  - @buildplane/adapters-git@0.2.1
  - @buildplane/adapters-honcho@0.1.3
  - @buildplane/adapters-models@0.1.3
  - @buildplane/adapters-tools@0.1.3
  - @buildplane/policy@0.1.3
  - @buildplane/runtime@0.1.3
  - @buildplane/storage@0.2.2
  - @buildplane/ui-tui@0.1.3

## 0.7.0

### Minor Changes

- b1b7842: M2-S4: PlanForge dispatch stage — admitted plans dispatch one run per task,
  gated on a signed plan_admitted tape event (kernel-enforced), with provenance_ref
  on the packet + admission receipt and a verified worktree_clean git status.

### Patch Changes

- Updated dependencies [b1b7842]
  - @buildplane/kernel@0.3.0
  - @buildplane/planforge@0.4.0
  - @buildplane/adapters-git@0.2.0
  - @buildplane/adapters-codex@0.1.2
  - @buildplane/adapters-honcho@0.1.2
  - @buildplane/adapters-models@0.1.2
  - @buildplane/adapters-tools@0.1.2
  - @buildplane/policy@0.1.2
  - @buildplane/runtime@0.1.2
  - @buildplane/storage@0.2.1
  - @buildplane/ui-tui@0.1.2

## 0.6.0

### Minor Changes

- 253ea47: M2-S3: PlanForge admit stage — operator-approved signed `plan_admitted`.

  `buildplane planforge admit --input <file> --approve --operator <id>` records an
  operator-approved admission as a kernel-signed `plan_admitted` event on the L0
  tape (the first signed TS-spawned tape path). It fails closed with no tape write
  on a non-PASS plan, a missing `--approve`, or a missing `--operator`, and is
  idempotent by the plan's idempotency key. `@buildplane/planforge` adds the pure
  `buildPlanAdmittedPayload` builder.

### Patch Changes

- Updated dependencies [253ea47]
  - @buildplane/planforge@0.3.0

## 0.5.1

### Patch Changes

- Updated dependencies [77b2a14]
  - @buildplane/ledger-client@0.1.1
  - @buildplane/planforge@0.2.1

## 0.5.0

### Minor Changes

- e11cf0f: m2-s1: extract @buildplane/planforge package + runtime contract + canonical digest

  Lifts the PlanForge dry-run pipeline (`compile → validate → preview`) out of the
  CLI into a new, unit-testable `@buildplane/planforge` workspace package. The
  package owns the schema (constants + interfaces) and now exports the promoted
  runtime types `PlanForgeInput` and the full (non-preview) `PlanForgeReceipt`
  alongside `compile`/`validate`/`preview` and `createPlanForgeDryRunPlan`. The CLI
  `planforge dry-run` handler delegates to the package, and
  `apps/cli/src/planforge-schema.ts` becomes a non-breaking re-export shim.

  `planDigest`/`inputDigest` now use a canonical, key-sorted serializer
  (`canonicalJson` + `digest`) shared with the signed-tape path, replacing the
  insertion-order `JSON.stringify`. Dry-run output is otherwise unchanged: the
  golden fixture is identical except a one-time digest update
  (`inputDigest sha256:1a2924… → sha256:ac29ab…`,
  `planDigest sha256:d73b27… → sha256:510fa9…`). The subcommand gate, the
  `--write/--execute/--admit` block, and the hardcoded dry-run stubs
  (`dryRun`/`sideEffects`/`admittedBy`/`generatedAt`) are untouched.

### Patch Changes

- Updated dependencies [e11cf0f]
  - @buildplane/planforge@0.2.0

## 0.4.1

### Patch Changes

- Updated dependencies [c24dae5]
- Updated dependencies [ad3cde8]
  - @buildplane/storage@0.2.0
  - @buildplane/kernel@0.2.0
  - @buildplane/adapters-codex@0.1.1
  - @buildplane/adapters-git@0.1.1
  - @buildplane/adapters-honcho@0.1.1
  - @buildplane/adapters-models@0.1.1
  - @buildplane/adapters-tools@0.1.1
  - @buildplane/policy@0.1.1
  - @buildplane/runtime@0.1.1
  - @buildplane/ui-tui@0.1.1

## 0.4.0

### Minor Changes

- 00d8d92: M1 · S4 — local keyring + signing-on-append: add the producer half of the signed
  event tape in `bp-ledger`. `signing::sign_event` signs `canonical_event_bytes`
  with an ed25519 key and emits an `EventSignatureV1` (base64url-no-pad signature
  that round-trips with the verify path; `signer.public_key_hash` set to
  `sha256:<hex(sha256(verifying_key))>` so it matches the `TrustedPublicKeys`
  lookup; deterministic for the same key+event). A new `keyring` module loads raw
  32-byte ed25519 seeds from `~/.buildplane/keys/<actor>/<key-id>.ed25519`
  (`$HOME`-resolved, actor-scoped per OPERATOR-DECISION-A); errors carry only the
  attempted path and an opaque reason, never key bytes. `SqliteStore::append_signed`
  signs first, then inserts the event row and the matching `event_signatures` row
  inside one transaction and commits only if all succeed — any signing or insert
  failure rolls back so no event row persists (fail closed). Signing is opt-in via
  `ledger serve --sign [--signing-key-id <id>]` (default OFF / unsigned, preserving
  legacy behavior; applies to the `kernel` actor); only a key reference crosses the
  config boundary. No event-envelope, generated-TS, or fixture changes.

  Review-gate hardening (cross-model L0 trust-surface review): keyring identifiers
  (`actor_id`/`key_id`) are now validated before any path join — anything with a
  path separator, `..`, a leading `.`, an absolute path, or a char outside
  `[A-Za-z0-9._-]` is rejected with a typed `UnsafeKeyringId` error (carries only
  the offending id descriptor, no key bytes), so `--signing-key-id ../../foo`,
  `/tmp/foo`, `a/b`, and `..` can no longer escape the actor-scoped dir.
  `verify_event_signature` now (a) rebinds the retrieved trusted key to its claimed
  `public_key_hash` and fails closed (`MissingKey`) if the registry maps a claimed
  hash to mismatched key bytes, and (b) rejects a signature whose `event_id` differs
  from the event under verification (`HashMismatch`). A new integration test proves
  the atomic-rollback guarantee by forcing the signature insert to fail _after_ the
  event insert succeeds within the same transaction (PK collision) and asserting the
  event row is rolled back.

  Deferred follow-ups (documented, intentionally not implemented this slice):

  - R-003: `SigningKey` is not zeroized on drop. M2 should wrap the loaded seed in a
    zeroizing container so private-key material is scrubbed from memory on drop.
  - R-004: signing is currently all-under-kernel (the `signer` is always the kernel
    actor). Per-actor signing authorship is a multi-actor follow-up, not in scope here.

- eb9bb5f: M1 · S6 — tape-root checkpoint events: add periodic, signed tape-root checkpoints
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

- b373716: Phase 2 · S1 — cross-layer injection dedup/precedence: introduce a pure `dedupeAcrossLayers` helper and apply it at the packet-enrichment injection assembly so a memory surfacing in more than one layer (structured repo-facts/procedures/documents, run_learnings, honcho) is injected once instead of concatenated verbatim. Cross-layer identity keys on normalized display text (layer tag stripped, whitespace/case folded) because only display strings survive to the assembly. Documented precedence is source-order `structured (repo-fact ≻ procedure ≻ document) ≻ run_learnings ≻ honcho`; the higher-precedence copy wins and distinct memories are preserved in stable order. Finer confidence/recency tie-breaks fall back to source order (the contract's documented fallback) because that data is not available at the assembly. Only `packet-enrichment.ts` (+ its test) changed; no port or DDL change.
- 2cb5874: Phase 2 · S2 — repo_facts branch-scoped filtering: add an optional `branch?` to `RepoFactRetrievalQuery`, thread it through `retrieveRepoFacts` and the store read helpers (`readRepoFactRows`/exact/fuzzy) with a `(branch = ? OR branch IS NULL)` clause so facts promoted on another branch no longer leak into unrelated runs (null-branch rows stay repo-global and always match), and have packet-enrichment pass the run's current branch. Additive/opt-in: omitting `branch` preserves today's unfiltered behavior. No DDL change; `valid_from_commit`/`valid_to_commit` and the ranking algorithm are untouched.
- 5548286: Phase 2 · S3 — episodes read path: add `listEvents({ runId, limit? })` to `BuildplaneStoragePort` (implemented via `EventStore.getEventsByRunId`) and a `memory episodes <runId> [--limit N] [--json]` CLI subcommand that lists a run's execution events with `--json` parity to `facts`/`procedures`; a missing `<runId>` exits non-zero with a clear message.

## 0.3.0

### Minor Changes

- 72416c2: Phase 1 memory subsystem slices:

  - **Repo-fact seeding** — `bootstrap seed [--json]` detects repo signals (primary language, test/build/typecheck/lint commands) and seeds durable `repo.*` structured facts via the existing `upsertRepoFact` port.
  - **Memory CLI reads** — `memory facts [--scope --json]` and `memory procedures [--task-type --json]` subcommands over the existing `listRepoFacts`/`listProcedures` reads; storage errors now surface instead of being swallowed.
  - **Reviewer memory injection** — reviewer packets now carry a review `intent` and the reviewer leg's enriched memories are persisted (`recordInjectedMemories`) on both the `run-strategy` and default `run --packet` paths.

## 0.2.0

### Minor Changes

- b46a88d: Add `buildplane pack export` for GitHub custom-agent and skill guidance exports.
