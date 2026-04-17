# Event Tape Capture — Design

**Date:** 2026-04-17
**Status:** Approved (pending written-spec review)
**Sub-project of:** Buildplane replayable-ledger roadmap, phase #2 of the decomposition in `docs/strategy/buildplane-positioning.md`.

## 1. Goal & Success Criteria

### Goal

Every `buildplane run` produces a durable, state-reconstructible tape: a structured record of every model request/response, every tool call's inputs/outputs and file-level effects, every unit lifecycle transition, and git checkpoints at unit boundaries. The tape is owned by a new Rust crate, `bp-ledger`, and is rich enough that downstream features (`replay`, `fork`, `bisect`) can reconstruct run state at any event boundary without re-executing the model or tools.

This sub-project delivers only the **capture** half of the replayable ledger. Consuming the tape (`replay`, `fork`, `bisect`, audit bundles) is the scope of later sub-projects.

### In scope

1. A new Rust crate `bp-ledger` with an append-only event log (SQLite) and a content-addressed blob store (local filesystem) for workspace file contents.
2. A hardened IPC contract: TS spawns `bp-ledger` as a long-running subprocess per run; events flow over stdin as JSON-lines with a typed schema generated from Rust.
3. Tool-level instrumentation in the TS kernel/adapter layer that emits the required events for model calls, tool calls, and tool-observed file reads/writes.
4. Git-commit checkpoints at unit-start and unit-end (leveraging the existing clean-worktree precondition).
5. Structural secret redaction: specific schema fields (auth headers, env values, known-credential-shaped fields) are hashed on write.
6. A `buildplane ledger inspect <run-id>` CLI command to walk the tape. Not replay, not fork — just read. This is the proof the capture works.
7. Crash-safe ledger: if `bp-ledger` dies mid-run, the run fails loudly with a `ledger_failure` event written to the existing state store. No silent data loss.

### Out of scope (deferred)

- `replay` / `fork` / `bisect` commands — they read the tape; this sub-project writes it.
- Audit bundle signing / export.
- Encryption at rest (reserved for enterprise tier).
- MCP tool instrumentation beyond what goes through the existing kernel adapter. Unobserved events are a documented gap; the unit-boundary git checkpoint is the fallback.
- Unifying the three memory models (separate sub-project).
- Backfill of existing runs' data. Tape starts empty on day-1 of this feature.
- Windows support. Linux and macOS only.

### Success criteria

1. A `run` of a packet that makes one model call and one tool call produces a tape with: `run_started`, `unit_started`, `model_request`, `model_response`, `tool_request`, `tool_result` (with input/output file hashes), `unit_completed`, `run_completed` — in that causal order, with `parent_event_id` chains intact.
2. `buildplane ledger inspect <run-id>` renders a human-readable walk of that tape.
3. Hashed-but-stored workspace files from a recorded run can be retrieved by content hash from the CAS.
4. Killing `bp-ledger` mid-run causes the run to fail with `ledger_failure`, not hang or silently continue.
5. A field marked `secret` in the schema never appears in plaintext in the stored event.
6. A run with 50 tool calls captures all 50 without loss, ordered correctly, within a bounded TS-side latency overhead (target: <5% over current run time — measured, not assumed).

### Non-goals (explicit)

- We do **not** claim deterministic re-execution. The tape enables controlled reconstruction and informed fork, not byte-identical replay. This is consistent with the positioning doc's honest framing of "replay" (see `docs/strategy/buildplane-positioning.md:7`).
- We do **not** capture ambient state outside tool observations. The safety net is the unit-boundary git commit; fork fidelity degrades if tools bypass the adapter, and we document that.

### Budget

~3–4 weeks for a focused developer, given that TS/Rust bridge hardening is in scope. See Section 6 for phase breakdown.

---

## 2. Architecture

### Component diagram

```
┌─────────────────────────────────────────────────────────────┐
│  apps/cli  (TS)                                             │
│   run-cli.ts → spawns bp-ledger, wires tape emitter         │
└─────────────────────────────────────────────────────────────┘
                         │                   │
                         │ stdin JSON-lines  │ (exit code + stderr)
                         ▼                   ▲
┌─────────────────────────────────────────────────────────────┐
│  packages/kernel  (TS)                                      │
│   ┌─────────────────────────┐  ┌──────────────────────┐     │
│   │ event-bus (existing)    │  │ tape-emitter (NEW)   │     │
│   │  ExecutionEvent         │─▶│  envelope + forward  │─────┐
│   └─────────────────────────┘  └──────────────────────┘     │
│   ┌─────────────────────────┐                               │
│   │ tool-adapter (NEW hook) │                               │
│   │  pre/post read + write  │                               │
│   └─────────────────────────┘                               │
└─────────────────────────────────────────────────────────────┘
                                                              │
                                                              │ stdin
                                                              ▼
┌─────────────────────────────────────────────────────────────┐
│  native/crates/bp-ledger  (Rust, NEW)                       │
│   ┌─────────────────┐  ┌───────────────────┐                │
│   │ ingest loop     │─▶│ validator + sig   │                │
│   │ JSONL→Event     │  │ schema version    │                │
│   └─────────────────┘  └───────────────────┘                │
│            │                                                │
│            ├──▶ sqlite: events table (envelope + payload)   │
│            └──▶ fs CAS: .buildplane/ledger/objects/ab/cdef… │
│                 (blob bytes, sha256-keyed)                  │
└─────────────────────────────────────────────────────────────┘
                                                              │
                                                              ▼
┌─────────────────────────────────────────────────────────────┐
│  native/crates/bp-cli  (Rust, EXTENDED)                     │
│   buildplane-native ledger inspect <run-id> → reads SQLite  │
└─────────────────────────────────────────────────────────────┘
```

### Data flow per run

1. TS CLI receives `buildplane run`. Before the run starts, it spawns `buildplane-native ledger serve --run-id <id> --workspace <path>` as a child process. Child stays alive for the life of the run.
2. The TS `event-bus` emits `ExecutionEvent`s as it does today. A new `tape-emitter` listener subscribes to the bus, wraps each event in the canonical envelope, and writes it as a JSON line to the ledger child's stdin.
3. The tool adapter gets new hooks. Before a tool call runs, it records intended reads with content hashes; after the call, it records actual writes with content hashes. File bytes for writes are stored in the CAS by Rust reading the file itself — TS sends the path, Rust reads, hashes, stores.
4. The Rust ingest loop parses JSON lines, validates the schema version, writes the event row to SQLite, and for any event carrying a file path, hashes the file and writes its contents to the CAS if not already present (content-addressed, dedup for free).
5. Unit-start and unit-end trigger git commits on a `refs/buildplane/run/<run-id>` ref. Commit SHA is referenced from unit lifecycle events. These are the git checkpoints — the safety net for events that go outside the tool adapter.
6. On run completion, TS closes the child's stdin. Rust flushes, fsyncs, exits 0. TS waits for the exit code before declaring the run complete. Non-zero exit → run is marked failed with a `ledger_failure` event written to the existing event store (so there's at least a record that the ledger failed).

### Repo layout

- **New Rust crate**: `native/crates/bp-ledger/` — the ledger daemon, the SQLite schema, the CAS, the ingest protocol. Library crate + bin target (`buildplane-ledger`) for direct use; also callable from `buildplane-native ledger serve`.
- **Extended Rust crate**: `native/crates/bp-cli/` — adds `ledger` subcommands (`serve`, `inspect`).
- **New TS package**: `packages/ledger-client/` — the tape-emitter, the IPC wire protocol, the schema types (generated from Rust via `typeshare` or similar). Single source of truth on the TS side for "how to talk to the ledger."
- **Modified TS package**: `packages/kernel/src/tool-adapter.ts` (or equivalent) — new hooks for pre/post read/write observation.
- **Modified TS package**: `apps/cli/src/run-cli.ts` — spawn/supervise the ledger child, wire the tape-emitter into the event bus.
- **No changes to**: `packages/storage/event-store.ts` — it keeps working as-is. The ledger is additive in v1; a later sub-project migrates/retires it.

### Storage layout

Per workspace, under `.buildplane/ledger/`:

- `events.db` — SQLite, single `events` table plus a `runs` index table. Schema is `bp-ledger`'s, not shared with `state.db`.
- `objects/` — content-addressed blob store, `objects/<aa>/<bbbb...>` layout (git-style prefix sharding). Immutable, append-only by construction.
- `schema_version` — one-line file with the current schema version. Readable for debug; authoritative version lives in event rows.

### Key contracts

- **Envelope is frozen v1.** The six envelope fields never change shape. Everything evolvable lives in the `payload`. This matters because `parent_event_id` traversal has to work across schema versions for bisect/fork to stay sound.
- **Payloads are versioned per-kind.** `ModelRequest.v1`, `ModelRequest.v2`, etc. Rust has a migration function per `(kind, version) → canonical` that runs on read, not write (tape is immutable; we interpret older tapes in-memory).
- **Blobs are immutable.** Once a content hash is written to the CAS, it's never overwritten. Garbage collection is a future concern; v1 is append-only forever.
- **TS never writes to `events.db` directly.** Ever. Any bypass breaks the IPC contract. A test enforces this (no SQLite import that touches `events.db` from TS code).

---

## 3. Data Model

### Envelope (frozen at v1)

Every event carries the same six envelope fields. These never change shape — migrations happen only inside `payload`.

```rust
// native/crates/bp-ledger/src/event.rs
pub struct Event {
    pub id: EventId,                      // UUIDv7 (time-ordered)
    pub run_id: RunId,
    pub parent_event_id: Option<EventId>, // None only for run_started
    pub schema_version: u32,              // payload schema version
    pub kind: EventKind,                  // discriminator
    pub occurred_at: DateTime<Utc>,       // RFC3339, UTC only
    pub payload: Payload,                 // kind-specific
}
```

**Why UUIDv7 for `id`:** time-ordered by generation, so `ORDER BY id` is equivalent to `ORDER BY occurred_at` without a separate index or rowid reliance. Avoids the graph-scheduler-style TOCTOU issues with reordering.

**Why `parent_event_id` is a first-class field:** bisect and fork walk the causal graph, not the wall-clock timeline. Two tool calls started in parallel have the same parent but different order; their children form independent subtrees. Without `parent_event_id`, the tape is a list; with it, it's a tree. Cheap now, impossible to retrofit.

### Event kinds (v1 payloads)

Grouped by concern. Each is a distinct `EventKind` variant with its own versioned payload.

#### Run lifecycle

- `run_started` — packet snapshot (hashed, bytes in CAS), git HEAD at run start, model/tool/policy config, workspace path. Root of the tree.
- `run_completed` — outcome (`passed|failed|cancelled`), duration, summary counts.
- `run_failed` — failure reason, terminating event id.
- `ledger_failure` — written to `state.db` (existing store), not `events.db`, because by definition the ledger is broken. Captures what we lost.

#### Unit lifecycle

- `unit_started` — unit id, parent unit (for graph), kind (command/model/etc.), policy snapshot.
- `unit_completed` — outcome, artifacts produced (CAS hashes).
- `unit_failed` — reason, terminating event id.
- `unit_cancelled` — cause (timeout, parent-failed, operator-interrupt).

#### Git checkpoints (safety net)

- `git_checkpoint` — ref (`refs/buildplane/run/<run-id>/<unit-id>`), commit sha, boundary (`pre-unit | post-unit`). This is how we recover if tools bypass the adapter.

#### Model I/O

- `model_request` — provider, model id, sampling params, messages (array), tools (schema), system (string). Fields `messages[].content` and `system` are raw strings and may legitimately contain secrets — this is where field-level `secret` marking bites (see below).
- `model_response` — content (string), tool_calls (array of `{id, name, arguments}`), usage tokens, stop reason, latency. No `secret` fields — model output is what the operator asked for and is what replay needs.

#### Tool I/O

- `tool_request` — tool name, arguments (json), env (marked `secret`), working directory, parent unit. One event per intended call.
- `tool_result` — stdout, stderr, exit code (for shell tools), output (json for structured tools), duration, parent `tool_request` id. Caveat: free-form stdout/stderr cannot be structurally redacted.

#### Workspace observations (separate events, not nested)

- `workspace_read` — parent `tool_request` id, path, content hash, size. Emitted per file the tool observed reading.
- `workspace_write` — parent `tool_request` id, path, content hash before (null if new), content hash after, size after. Emitted per file the tool wrote.

Separate events (not nested inside `tool_result`) because:

- Causal chains stay flat and queryable (`SELECT * WHERE parent = X` gets everything).
- A single tool call that touches 100 files doesn't produce a 100-field `tool_result`.
- Fork-at-event-N works on any of them individually — you can fork just before a specific file write.

### Secret-field convention

Fields that carry secrets are marked with a `#[secret]` proc-macro attribute on the Rust struct. The macro does two things:

1. At serialize time, replaces the field's value with `{ "redacted": true, "hash": "sha256:abc...", "hint": "env_var" }`.
2. In generated TS types, emits `readonly` with a branded `Redacted<T>` wrapper so downstream code can't accidentally treat it as a raw string.

Fields marked `secret` in v1:

- `tool_request.env` (whole map — env is almost always sensitive in practice)
- `model_request.headers` — stored as a map for debuggability, with a structural allowlist of sensitive keys (`authorization`, `api_key`, `x-api-key`, `token`) redacted at the value level. Non-sensitive keys (`user-agent`, `accept`) stored raw.
- A small allowlist that gets reviewed in PR

Things **not** marked `secret` (by choice, with the honest limitation):

- `model_request.messages[].content` — too often the legitimate payload is the whole value. Operators who put secrets in prompts own that risk; docs will call this out.
- `tool_result.stdout/stderr` — free-form, can't structurally redact. Same operator-owned risk.

### Schema versioning

- `schema_version` lives in the envelope, applies to the payload.
- Rust's `Payload` enum has `v1`, `v2`, ... variants per kind as needed.
- Migration runs on read: the ledger never rewrites stored events. A `canonicalize(kind, version, payload) -> CanonicalPayload` function is the one place that knows how to read older versions. Tests enforce that a v1 payload round-trips through canonicalize without loss.
- The envelope's `schema_version` is a compatibility signal, not a format selector — the variant tag in Rust's enum is authoritative. The stored integer just helps external readers (audit bundles) route correctly.

### Run index table

Alongside `events`, a lightweight `runs` table for listing and fast lookup:

```
runs (
  id PRIMARY KEY,
  started_at,
  completed_at NULLABLE,
  outcome NULLABLE,   -- null = in progress
  workspace_path,
  packet_hash,        -- points into CAS
  schema_version      -- highest envelope version written by this run
)
```

Derived from events (specifically `run_started` and `run_completed`). Cached for query speed. On ledger startup, could be rebuilt from events if missing.

### CAS layout

```
.buildplane/ledger/objects/
  ab/
    cdef0123...    (sha256 of content)
  ef/
    1234abcd...
```

Keyed by sha256, immutable. Written via O_TMPFILE + rename for atomic-create-if-missing. Reads are direct-mmap candidates if size matters. `fsync` the parent directory after each new blob to make crash semantics sane.

### What's not in the data model (by choice)

- No "event edits" or mutations. Append-only.
- No soft-delete. Forgetting a run means a future garbage-collection sub-project, not a DELETE statement.
- No embedded vector / semantic index. That's a memory-system concern and will derive from the ledger, per the positioning doc.
- No cross-run lineage fields beyond `run_started.parent_run_id` (a single optional pointer for forks). Fork graphs are traversed by following that pointer.

---

## 4. Capture Path + IPC Protocol

### Boot sequence (per run)

```
TS: run-cli `run` handler
  ├─ resolve native binary (existing logic in run-cli.ts:820-835, plus $PATH)
  ├─ pre-flight: clean git worktree check (already required)
  ├─ spawn: `buildplane-native ledger serve
  │          --run-id <uuid>
  │          --workspace <absolute path>
  │          --schema-version 1`
  │   ├─ stdio: ['pipe' (stdin), 'inherit' (stdout), 'pipe' (stderr)]
  │   ├─ kill on timeout: 30s handshake SLA
  │   └─ track exit via signal listener
  │
  ├─ wait for handshake line on stderr: `{"ready":true,"ledger_version":"..."}`
  │   (on error or timeout: abort run, user-facing error)
  │
  ├─ construct tape-emitter (new packages/ledger-client)
  │   ├─ subscribes to event-bus
  │   ├─ holds the child's stdin handle + write-queue
  │   └─ handles backpressure (see below)
  │
  ├─ orchestrator.runPacketAsync(packet, bus)  ← existing flow, unchanged
  │
  └─ on run finish (success or fail):
     ├─ emit `run_completed` or `run_failed` on bus (flushed through tape-emitter)
     ├─ close child's stdin
     ├─ await child's exit (10s cap)
     ├─ if exit != 0:
     │    ├─ read stderr buffer
     │    ├─ write `ledger_failure` to existing state.db event-store
     │    └─ mark run failed, surface to operator
     └─ return
```

### Why `ledger serve` as its own subcommand

- Separates `buildplane-native`'s monolithic invocation surface into named subcommands. The native binary is already going to grow (`memory …`, `pack …`, now `ledger …`).
- Makes the process testable directly from Rust: `cargo test` can spawn `ledger serve` with a scripted stdin and assert on the resulting `events.db` and CAS state.
- Gives operators a debug tool: `echo '{...}' | buildplane-native ledger serve --run-id test --workspace /tmp` runs the ledger against a canned stream.

### Wire protocol

Framing: newline-delimited JSON, one event per line, UTF-8. No length prefix. A malformed line is a protocol violation — the ledger closes stdin, writes the error to stderr, exits non-zero.

Control messages use the same JSON-line stream but with a reserved `kind` prefix of `_` (underscore — normal events never use this):

- `_handshake` — first line sent by TS after spawn. Carries `{ "protocol": 1, "run_id": "...", "started_at": "..." }`. Ledger responds via stderr (not stdin, to avoid coupling).
- `_flush` — optional TS → ledger; ledger must fsync and respond via stderr with `{ "flushed": true, "last_id": "..." }`. Used before critical checkpoints (e.g., between units).
- `_close` — written by TS before closing stdin. Ledger drains the queue, fsyncs, exits 0.

Handshake over stderr (not a bidirectional stdin/stdout dance) because the ledger's stdout is reserved for human-readable `inspect` output when the process is used standalone. Keeping channels single-purpose avoids the "is this stdout a log line or a protocol message?" trap.

### Event emission (TS side)

The new `packages/ledger-client/src/tape-emitter.ts`:

```ts
// pseudo-signature — final API in the implementation plan
interface TapeEmitter {
  emit(event: CanonicalEvent): void;
  flush(): Promise<void>;    // resolves when ledger acks _flush
  close(): Promise<void>;    // writes _close, awaits child exit
  onFailure(cb: (reason: LedgerFailure) => void): void;
}

function createTapeEmitter(opts: {
  childStdin: Writable;
  childExit: Promise<number>;
  workspacePath: string;
}): TapeEmitter;
```

- `emit` is synchronous and non-blocking; events land in an internal queue drained on the event loop's next tick.
- Queue has a bounded high-watermark (default 1024 events). On overflow: block the emitter (which blocks the tool adapter, which slows the run) rather than drop events. Losing tape events silently is worse than slowing the run.
- `childExit` is a promise that resolves with the exit code; if it resolves before `close()` is called, the emitter surfaces `onFailure` and the orchestrator marks the run failed.

### Tool adapter instrumentation

New hooks in `packages/kernel/src/tool-adapter.ts` (pending a look at the actual file layout):

```ts
interface ToolAdapter {
  // existing: execute(tool, args) → result
  // new:
  observeRead(toolReqId: EventId, path: string): void;
  observeWrite(toolReqId: EventId, path: string, phase: "before" | "after"): void;
}
```

- `observeRead` is called by the tool implementation just before it reads a file. It emits a `workspace_read` event. TS sends only the path; Rust reads and hashes the file itself, to keep TS-side latency low and avoid double-reading.
- `observeWrite` is called twice per write: once before (to capture the pre-write hash if the file existed) and once after (to capture the post-write hash). Rust does the hashing both times.
- For tools that don't opt in (legacy tools, external shell commands): no events. The unit-boundary `git_checkpoint` is the fallback.

**Key constraint:** the tool adapter never captures file bytes directly. The event only carries the path and metadata. The Rust side owns all hashing and CAS writes.

Consequences:

- A tool that writes a 1GB file doesn't balloon the JSON-lines stream.
- TS-side captures are essentially free (a path string + a few ints per observation).
- If Rust can't read the file (permission denied, concurrent delete), the event is recorded with `status: "unreadable"` and a reason. The tape is honest about gaps.

### Git checkpoint events

At `unit_started` / `unit_completed`, the kernel:

1. Runs `git add -A && git commit --allow-empty -m "buildplane/run/<run-id>/<unit-id>/<boundary>"` on a ref `refs/buildplane/run/<run-id>`.
2. Emits a `git_checkpoint` event with the resulting commit SHA.

Notes:

- This happens on the `buildplane/run/*` ref, not on the user's current branch. The user's branch is untouched. Inspecting the checkpoints is done via `git log refs/buildplane/run/<run-id>`.
- `--allow-empty` is important — a unit that changed no files still needs a checkpoint so fork-at-unit-boundary always has a resolvable anchor.
- Git operations are sync (no JSONL round-trip). If git fails, the checkpoint event carries `git_status: "failed"` with the error — the tape records the failure, the run continues or aborts per policy.

### Backpressure + crash semantics

| Situation | Behavior |
|---|---|
| Emitter queue fills | Block emit call → blocks tool adapter → slows the run. No event loss. |
| Ledger child slow to drain stdin | Same as above (Node's pipe buffer fills, `.write()` returns false, emitter awaits `'drain'`). |
| Ledger child dies mid-run | `childExit` resolves non-zero → orchestrator halts the run → `ledger_failure` written to `state.db` → user error message names the exit code + stderr tail. |
| TS process crashes | Child process receives SIGPIPE on stdin close → Rust catches, flushes what's queued, exits 0. Tape is truncated but consistent (last complete event is durable). |
| Disk full during CAS write | Ledger exits with specific error code → run fails with actionable message. |
| Schema version mismatch at spawn | Handshake returns `{ "ready": false, "reason": "version" }` → run aborts pre-flight. |

---

## 5. Testing Strategy

The tape is a system-of-record. Bugs in it are silent data corruption bugs — they don't throw, they just produce a tape that misrepresents what happened. Testing has to catch this class of bug, not just "code runs." Four layers.

### Layer 1: Rust unit tests (inside `bp-ledger`)

Scope: the ingest protocol, SQLite writes, CAS operations, migration functions.

Must-haves:

- **Round-trip per event kind.** For each `EventKind`, a test that: emits a canonical payload → serializes → parses → writes to ephemeral SQLite + CAS → reads back → asserts bit-equal. Catches serde drift and schema mistakes.
- **Migration coverage.** For every `(kind, version)` pair, a test that a fixture of that version canonicalizes to the expected canonical form. When v2 ships, v1 fixtures stay in the tree and keep passing.
- **CAS atomicity.** Kill a write mid-stream (e.g., truncate the temp file) and verify the final object directory doesn't contain a partial blob. The O_TMPFILE + rename pattern should make this structurally impossible, but assert it.
- **Append-only invariant.** Test that the ledger refuses an `UPDATE` or `DELETE` on the events table (enforced by a SQL trigger; trigger itself is tested).
- **Secret redaction.** For each field marked `#[secret]`, a test that serializing any value produces the `{ redacted, hash, hint }` shape, never the raw bytes. This is the single highest-signal test — if it breaks, you leak secrets.

Target: ≥90% line coverage in `bp-ledger`. Uncovered code should be explicit (e.g., panic-on-invariant-violation paths we don't want to stage).

### Layer 2: TS unit tests (inside `packages/ledger-client`)

Scope: the tape-emitter, the wire protocol, backpressure, handshake.

Must-haves:

- **Emit → JSONL.** Given an `ExecutionEvent`, assert the emitter writes a correct canonical envelope to the child's stdin. Uses a mock `Writable`, no real Rust process.
- **Backpressure blocks.** Fill the mock pipe's buffer; assert the emitter's `emit()` blocks (returns a pending promise) rather than dropping.
- **Child-died surfaces.** Mock `childExit` resolving non-zero mid-run; assert the `onFailure` callback fires with the exit code + stderr.
- **Handshake timeout.** Mock a child that never writes `_handshake`; assert the run aborts with a clear error within the SLA.
- **Schema type generation.** A snapshot test on the generated `.d.ts` output — if `typeshare` output drifts, the snapshot diff tells you exactly what changed. Prevents accidental schema breakage from a Rust refactor.

### Layer 3: Integration tests (TS → real Rust binary)

Scope: the full TS-spawns-Rust, emits events, reads back loop. Real subprocess, real SQLite, real CAS.

Must-haves:

- **Single-run fixture.** Run a minimal packet that writes one file via an instrumented tool and makes no model calls. Assert the resulting `events.db` contains exactly the expected events in causal order, and the CAS contains exactly the expected blob.
- **50-tool-call stress.** Run a packet that loops a shell-ish tool 50 times, each writing a small file. Assert all 50 tool calls and all 50 writes are captured, ordered correctly, with correct `parent_event_id` chains. Fails if backpressure drops events.
- **Ledger-crash recovery.** Run a packet; `SIGKILL` the ledger process mid-stream; assert the run fails with a `ledger_failure` event in `state.db` and a clear operator message. Assert the partial `events.db` is internally consistent (last durable event is complete, no truncated row).
- **Concurrent runs.** Spawn two runs in parallel against the same workspace. Each gets its own ledger subprocess; their event streams don't cross.
- **Permission denied on CAS write.** Mount the ledger directory read-only mid-run. Assert the ledger surfaces the error and the run aborts with an actionable message.
- **Schema mismatch.** TS spawns ledger with `--schema-version 99`; assert handshake rejects it with a clear error.

These live under `test/ledger-integration/`, not inside either package — they exercise the cross-boundary contract.

### Layer 4: Property tests (recommended, optional in v1)

A small set of generators (using `proptest` on Rust, `fast-check` on TS) that fuzz:

- Event stream replay: given any sequence of well-formed events, reading them back produces the same canonical sequence.
- Causal invariant: for any emitted sequence, every non-root event's `parent_event_id` points to an event that was written earlier.

These catch subtle ordering and serialization bugs the hand-written tests miss. Not strictly required for v1 but cheap to add and high-signal.

### Out-of-scope for v1 testing

- **Performance regressions.** We set a <5% overhead target in the goals, but v1 testing doesn't automate regression detection. A single manual benchmark at the end of the sub-project, recorded in the benchmarks doc. Automated perf tests are a later sub-project.
- **Real model provider I/O.** The existing `test/integration/model-e2e.test.ts` pattern covers real provider calls. For ledger testing we use canned `model_request`/`model_response` events directly — we're testing the tape, not the models.
- **Cross-platform CAS semantics.** v1 targets Linux and macOS. Windows is a known gap.

### Test data discipline

- Every fixture lives under `test/fixtures/ledger/<scenario>/` with a README.
- Fixture tapes are regenerated by a script (`scripts/regen-ledger-fixtures.sh`), not hand-edited. Prevents the "someone tweaked a byte and now the test passes for the wrong reason" drift.
- A single golden CAS directory is checked in — sha256 hashes are deterministic so this is safe.

### Verification gate (before marking sub-project done)

- All four test layers green in CI.
- `buildplane run` of the existing `eval/` suites runs to completion with tape capture enabled, and the benchmark overhead is measured and recorded.
- A human-readable `buildplane ledger inspect <run-id>` of a real run is eyeballed and looks reasonable (not a test, a smell-check).
- Docs updated: the README's five-verb table links to the ledger inspect command; a new `docs/ledger.md` documents the event kinds, the secret-redaction policy, and operator-owned risks.

---

## 6. Phases + Sequencing

The sub-project is mostly sequential (each phase blocks the next). Total ~3 weeks of focused work plus buffer. Each phase ends in a demonstrable state.

### Phase A — Schema & Rust skeleton (3–4 days)

**Deliverables**

- New crate `native/crates/bp-ledger/` compiled and in the workspace.
- Rust types for every envelope field and every v1 event kind (see Section 3).
- `#[secret]` proc macro implemented, with tests proving redaction on serialize.
- SQLite schema: `events` table + append-only enforcement trigger + `runs` index table.
- CAS skeleton: `objects/<aa>/<bbbb...>` directory, atomic-write helper (O_TMPFILE + rename).
- Schema generation wired: `typeshare` or equivalent emits `.d.ts` into `packages/ledger-client/src/generated/`.
- `buildplane-native ledger serve --run-id X --workspace Y` subcommand that reads JSONL from stdin and writes to SQLite + CAS — minimal functionality, no handshake yet.
- Rust Layer 1 tests: round-trip per event kind, secret-field redaction, append-only invariant.

**Demo-able end-state:** `echo '{...canonical event json...}' | buildplane-native ledger serve --run-id test --workspace /tmp/ws` produces a valid `events.db` entry with the correct envelope. Running it twice with the same event id fails loud (append-only).

**Gate to next phase:** Rust Layer 1 tests ≥90% coverage, schema generation produces compile-clean TS.

### Phase B — IPC + tape-emitter (5–7 days)

**Deliverables**

- New TS package `packages/ledger-client/` with:
  - `createTapeEmitter()` — emit, flush, close, onFailure.
  - Handshake protocol (`_handshake` → stderr `{ ready }`).
  - Backpressure: queue with bounded high-watermark, blocks on overflow, doesn't drop.
  - Child-exit surveillance: non-zero exit triggers `onFailure`.
- `buildplane-native ledger serve` now implements handshake + `_flush` + `_close` control messages.
- Integration tests (Layer 3 subset):
  - Single-event round-trip through real subprocess.
  - Handshake timeout fails cleanly.
  - Ledger crash mid-stream surfaces as `onFailure`.
  - Schema-version mismatch rejects at handshake.
- TS Layer 2 tests for the emitter in isolation (mock pipes).

**Demo-able end-state:** A ~20-line TS script can `spawn()` the ledger, complete a handshake, emit a `run_started` + `run_completed`, close, and inspect the resulting SQLite row. The IPC contract is real and honest.

**Gate to next phase:** integration tests green on Linux + macOS, no event loss under simulated backpressure (100k event stress run), ledger-crash semantics produce the documented error path.

### Phase C — Tool adapter instrumentation + git checkpoints (6–8 days)

**Deliverables**

- `packages/kernel/src/tool-adapter.ts` (or wherever the adapter lives) gains:
  - `observeRead(toolReqId, path)` and `observeWrite(toolReqId, path, phase)` hooks.
  - Automatic emission of `tool_request` / `tool_result` around every tool call (wrap at the adapter, not per-tool).
- Built-in tools instrumented: `read_file`, `write_file`, `shell` command executor.
- Git checkpoint logic: on `unit_started` / `unit_completed`, commit to `refs/buildplane/run/<run-id>/<unit-id>`, emit `git_checkpoint` with the commit SHA.
- Wire-up in `apps/cli/src/run-cli.ts`: spawn `ledger serve` on `run`, attach the tape-emitter to the event bus, close on finish.
- Integration tests (full Layer 3):
  - 50-tool-call stress with writes, no event loss.
  - Real `buildplane run` of a representative packet produces a complete tape.
  - Concurrent runs don't interleave.
  - Permission-denied CAS write surfaces correctly.

**Demo-able end-state:** A real `buildplane run ./test-packet.json` captures a complete tape to `.buildplane/ledger/events.db`, with all tool calls, file reads/writes, unit lifecycle events, and git checkpoints in causal order. You can query the SQLite and see the whole run.

**Gate to next phase:** all Layer 3 tests green, an instrumented eval-suite run produces a readable tape that an operator eyeball check says "yeah, that's the run."

### Phase D — Inspect + docs + verification gate (3–5 days)

**Deliverables**

- `buildplane-native ledger inspect <run-id>` subcommand: human-readable walk of the tape (JSON mode + TUI mode). Renders event tree by `parent_event_id`, pretty-prints payloads, dereferences CAS blobs on request (`--show-blob <hash>`).
- CLI surface: `buildplane ledger inspect <run-id>` in the TS CLI that shells out to the native binary (consistent with the existing `memory` and `pack` bridge).
- Docs:
  - `docs/ledger.md` — event kinds, secret-redaction policy, operator-owned risks, storage layout.
  - README's Core Concepts table links to the inspect command as the concrete proof-of-tape.
- Benchmark: run the `model-codex` eval suite with and without tape capture; record % overhead in `docs/benchmarks/ledger-overhead.md`.
- Dogfood: a full week of normal `buildplane run` usage by at least one person, with tape capture on. Any surprises get logged as v1-defect or v2-feature.

**Verification gate (sub-project done):**

- [ ] All four test layers green in CI.
- [ ] Benchmark overhead <5% on the reference suite (or documented reason why not, with mitigation plan).
- [ ] `buildplane ledger inspect` renders a real run cleanly.
- [ ] `docs/ledger.md` exists and is accurate.
- [ ] No known event-loss or corruption bugs outstanding.
- [ ] Dogfood week completed without critical issues.

### Branching + shipping

- Long-lived `feat/ledger` branch off `main`.
- Each phase is its own PR merged into `feat/ledger`. Each PR is independently reviewable, ideally <1000 lines of diff.
- `feat/ledger` → `main` merges only after Phase D's verification gate passes.
- Alternative: if each phase is safe on its own (Phase A adds an unused crate; Phase B adds an unused TS package; Phase C is the first point where behavior changes), each phase can merge to `main` as it goes, gated behind a `BUILDPLANE_LEDGER=1` env var until D.

**Recommended: progressive merge to `main` with env-var gate.** Keeps the long-lived branch from decaying, lets changes land close to their tests, and the env-var gate means tape capture can be turned off if dogfood finds a blocker.

### What could make this slip

Ranked by probability:

1. **Tool adapter changes are bigger than they look.** The existing adapter may not have clean pre/post hooks. If the adapter needs refactoring first, add 3–5 days.
2. **Git checkpoint performance.** Empty commits on every unit boundary are fast but non-zero cost. If the benchmark shows >5% overhead from git, we switch to `git write-tree` / `git hash-object` without commits, which is faster but loses the `git log` developer affordance. Add 2 days.
3. **`typeshare`-style codegen has gaps** for some Rust patterns (enums with data, generics). If we hit them and fall back to hand-written types at the boundary, the source-of-truth discipline erodes. Mitigation: try it early in Phase A; fail fast.
4. **CAS on Windows.** Out of scope per Section 5, but if Windows support becomes required mid-flight, add a week.
5. **Dogfood finds a load-bearing bug.** Phase D's week is budgeted for finding things, not fixing them. A serious finding pushes D's end by however long the fix takes.

---

## Appendix A: Decision Log

The six design decisions that drove this spec, captured as a record for future contributors asking "why this way?"

| # | Decision | Chosen option | Alternatives considered | Reason for choice |
|---|---|---|---|---|
| 1 | Tape capability level | **C — state-reconstructible** | A (inspect only), B (compare only), D (deterministic replay) | C is the capability level at which the five-verb vocabulary (playback/replay/fork/rerun/audit) becomes technically honest. D is impossible with current LLMs. |
| 2 | Tape ownership | **B — Rust-primary, bridge hardening in scope** | A (extend TS event store), C (dual-writer) | Long-term architecture + single source of truth. Dual-writer repeats the three-memory-model mistake. |
| 3 | Workspace state capture | **C — tool-level instrumentation + git checkpoints** | A (git-only), B (CAS snapshots of whole workspace) | Precision where we have control (tool adapter), safety net where we don't (git ref on unit boundaries). |
| 4 | IPC protocol | **A — stdin JSON-lines to long-running subprocess** | B (Unix socket daemon), C (N-API FFI), D (HTTP/gRPC) | Simplest path from today's `spawnSync`. Preserves upgrade path to socket/HTTP for hosted ledger later. |
| 5 | Schema source of truth | **A — Rust types → generated TS types** | B (JSON Schema), C (Protobuf), D (hand-written both sides) | Rust owns the ledger; Rust owns the schema. JSON-lines stays inspectable. Future language-neutral clients get JSON Schema derived from Rust as a secondary artifact. |
| 6 | Secrets handling | **C — structural redaction via schema** | A (raw + docs), B (pattern-based), D (encrypt-at-rest), E (C + D hybrid) | Known-unknowns rather than unknown-unknowns. Pattern-matching is security theater. Encrypt-at-rest is deferred to enterprise tier. |

---

## Appendix B: Relation to Other Sub-Projects

This sub-project is #2 in the replayable-ledger roadmap:

0. **Foundation fixes** — SQLite transaction atomicity, memory ID collision, graph outcome classification. Pre-existing bugs. Should land before or in parallel with #2.
1. **Unified memory model** — collapse Rust `bp-memory` + TS `learning-store` + kernel `memory-types` into one model with memory as a projection of the event log. Depends on #2 (the event log is the projection source).
2. **Event tape capture** — **this spec.** Unlocks 3, 4, 5.
3. **Real replay + fork primitives** — consume the tape from #2 to reconstruct run state and produce new runs with lineage.
4. **Bisect** — consume the tape from #2 to find first bad event.
5. **Audit bundle + signing** — enterprise tier. Exports signed bundles derived from the tape.
6. **Cloud / team ledger** — hosted version of the local ledger.

Success of this sub-project is a precondition for every thesis-delivery feature. Failure or delay here delays the entire roadmap.
