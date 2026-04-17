# Event Tape IPC — Phase B Design

**Date:** 2026-04-17
**Status:** Approved (pending written-spec review)
**Sub-project of:** Buildplane replayable-ledger roadmap, Phase B of the decomposition in `docs/strategy/buildplane-positioning.md`.
**Builds on:** `docs/superpowers/specs/2026-04-17-event-tape-capture-design.md` (Phase A — Rust `bp-ledger` crate, which shipped in PR #59).

## 1. Goal & Scope

### Goal

Make the `bp-ledger` subprocess reachable from TypeScript. Ship `@buildplane/ledger-client` with a hybrid `TapeEmitter` (mechanical envelope construction + IPC, content decisions left to callers), a proper handshake and control-message protocol on the Rust side, and enough integration tests to prove the full TS → stdin → Rust → SQLite → CAS path works end-to-end — so Phase C's tool-adapter instrumentation has a stable runtime to plug into.

### In scope

1. **`@buildplane/ledger-client` runtime.** `createTapeEmitter({ childStdin, childStderr, childExit, workspacePath })` returning `Promise<TapeEmitter>` that resolves after handshake completes. Methods: `emit(kind, payload, opts?)`, `flush()`, `close()`, `onFailure(cb)`, `stats()`. Envelope construction: UUIDv7 `id`, UTC RFC3339 `occurred_at`, `schema_version`, `parent_event_id` from caller opts.
2. **Control-message protocol in Rust `bp-ledger` serve.** `_handshake`, `_flush`, `_close` on stdin; responses on stderr as structured JSON ack lines. Schema-version mismatch rejected at handshake. Protocol errors emit `control:"error"` lines before non-zero exit.
3. **Backpressure + crash handling.** Bounded high-watermark queue (1024 events default). `.write()` returning false triggers a `drain` await before accepting more emits. Non-zero child exit triggers `onFailure({ exitCode, stderrTail, lastAckedEventId, ... })` and halts the run.
4. **Payload drift alarm (Phase A follow-up (a)).** Build-time exhaustiveness check that fails when the Rust `Payload` enum adds a variant not mirrored in the hand-written TS union.
5. **`ToolRequestV1` end-to-end test (Phase A follow-up (b)).** Integration test that produces the `ToolRequestStoredV1` wire shape through the emitter and verifies the stored SQLite row contains `{redacted, hash, hint}` — no raw secret bytes anywhere.
6. **Native binary resolution reuse.** The ledger-client caller uses the same resolution chain as `apps/cli/src/run-cli.ts:820-835` (env var → debug target → release target → PATH).
7. **Integration-test discipline.** All new tests use isolated tempdirs via a shared `makeLedgerFixture()` helper. Zero test runs `git init` or `git commit` in cwd. (Mitigates Phase A's test-isolation bug.)

### Out of scope (Phase C or later)

- Tool adapter hooks (`observeRead` / `observeWrite`) and real tool instrumentation.
- Git checkpoint emission at unit boundaries.
- `ledger inspect` subcommand.
- SQL-surface append-only hardening beyond what process isolation provides.
- Replacing the existing TS `event-store.ts` (deferred).
- Benchmark / perf regression gates.

### Success criteria

1. A TS script can spawn `buildplane-native ledger serve`, await `createTapeEmitter(...)`, emit a 6-event success-path run (`run_started` → `unit_started` → `tool_request` → `tool_result` → `unit_completed` → `run_completed`) — in causal order with `parent_event_id` chains intact — and the resulting `events.db` contains those 6 rows with correct payloads.
2. Handshake timeout (ledger never responds) aborts emitter creation with a clear error within the SLA (default 30s, configurable).
3. Killing the ledger subprocess mid-run causes `onFailure` to fire with exit code, stderr tail, and the last successfully acked event id; the run is marked failed.
4. Under a 10k-event stress emit, the emitter blocks cleanly via backpressure — no event loss, no drop, bounded memory.
5. Payload drift test fails the build when the hand-written TS union omits a variant the Rust enum has.
6. A `ToolRequestStoredV1` fixture with a known secret produces a SQLite payload whose `env` is the redaction shape; the raw secret string appears nowhere in the tape or CAS.

### Non-goals (explicit)

- The emitter does not introspect payloads for redaction. Redaction is a wire-format responsibility of the caller (they produce the "stored" shape when a field is sensitive).
- `flush()` is not "wait for all events to be durable on disk." It is "wait for the ledger to confirm it has drained and fsynced up to the most recent write." In practice the two are equivalent given the ledger's fsync discipline, but we don't promise durability beyond what `_flush` ack semantics guarantee.

### Budget

~5-7 days focused work, slightly expanded from Phase A spec's original estimate to cover the two included follow-ups.

---

## 2. Architecture

### Component layout (Phase B delta on top of Phase A)

```
┌──────────────────────────────────────────────────────────────┐
│  apps/cli/src/run-cli.ts  (TS, MODIFIED)                     │
│   ├─ new helper: resolveLedgerBinary()                       │
│   ├─ new helper: spawnLedgerSubprocess(runId, workspace)     │
│   └─ on `run` start: spawn + await createTapeEmitter()       │
└──────────────────────────────────────────────────────────────┘
                                │
                                │ stdio: [stdin=pipe, stdout=inherit, stderr=pipe]
                                ▼
┌──────────────────────────────────────────────────────────────┐
│  packages/ledger-client  (TS, NEW runtime code)              │
│   src/                                                       │
│   ├─ index.ts          - re-exports public API               │
│   ├─ emitter.ts        - createTapeEmitter factory + TapeEmitter
│   ├─ envelope.ts       - UUIDv7, occurred_at, parent threading
│   ├─ wire.ts           - JSONL framing, control message builders
│   ├─ handshake.ts      - handshake driver + stderr line parser
│   ├─ backpressure.ts   - bounded queue with drain semantics  │
│   ├─ failure.ts        - LedgerFailure type, stderr tailer   │
│   ├─ payload.ts        - (existing, hand-written Payload union)
│   ├─ generated/        - (existing, typeshare output)        │
│   └─ shims.ts          - (existing, Uuid/DateTime/Value aliases)
│   test/                                                      │
│   ├─ emitter.test.ts          - Layer 2 unit tests (mock pipes)
│   ├─ handshake.test.ts        - handshake/ack/timeout        │
│   ├─ backpressure.test.ts     - queue fill + drain           │
│   └─ payload-drift.test.ts    - exhaustiveness check         │
└──────────────────────────────────────────────────────────────┘
                                │
                                │ stdin JSONL, stderr control acks
                                ▼
┌──────────────────────────────────────────────────────────────┐
│  native/crates/bp-ledger/src/serve.rs  (Rust, EXTENDED)      │
│   ├─ new protocol state machine: AwaitingHandshake → Ingesting
│   ├─ handshake accept/reject on stderr                       │
│   ├─ _flush / _close recognition and ack                     │
│   └─ control:"error" on protocol violations                  │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  test/ledger-integration/  (TS, NEW)                         │
│   ├─ happy-path.test.ts           - full 6-event round trip  │
│   ├─ handshake-failure.test.ts    - timeout, version mismatch│
│   ├─ crash-recovery.test.ts       - SIGKILL mid-stream       │
│   ├─ backpressure.test.ts         - 10k event stress         │
│   └─ tool-request-redaction.test.ts - Phase A follow-up (b)  │
└──────────────────────────────────────────────────────────────┘
```

### Data flow (successful run)

1. `run-cli.ts` receives `buildplane run`, passes pre-flight (clean git worktree), generates run id.
2. `run-cli.ts` resolves the native binary path and spawns `buildplane-native ledger serve --run-id <id> --workspace <path>` with `stdio: ["pipe", "inherit", "pipe"]`.
3. `run-cli.ts` awaits `createTapeEmitter({ childStdin, childStderr, childExit, workspacePath, runId })`. Internally:
   - Emitter writes `{"control":"handshake","protocol":1,"run_id":"...","started_at":"...","schema_version":1}` as one JSONL line to `childStdin`.
   - Emitter attaches a line-reader to `childStderr`, awaits a line parseable as `{"control":"handshake_ack","ready":true,"ledger_version":"...","schema_version":1}`.
   - On timeout (default 30s), rejects with `LedgerHandshakeError{kind:"handshake_timeout"}`.
   - On `{"ready":false,"reason":"..."}`, rejects with `LedgerHandshakeError{kind:"handshake_rejected"}`.
   - On unexpected child exit during handshake, rejects with `LedgerHandshakeError{kind:"exit"}`.
4. With handshake complete, `run-cli.ts` wires the emitter into the existing event-bus listener. The listener's `onEvent` handler now also calls `emitter.emit(kind, payload, { parent })` for every event.
5. Orchestrator runs the packet; events stream through bus → listener → emitter → stdin → Rust → SQLite + CAS.
6. On run end: listener emits `run_completed`, then `run-cli.ts` calls `emitter.close()`. Emitter writes `_close`, waits for `close_ack` + child exit 0, then resolves.
7. `run-cli.ts` marks the run successful.

### Data flow (ledger dies mid-run)

1. Ledger subprocess exits non-zero (disk full, SIGKILL, bug).
2. Emitter's `childExit` promise resolves before `close()` was called.
3. `failure.ts` reads the last ~8KB of `childStderr` into `stderrTail`.
4. Emitter fires all registered `onFailure` callbacks synchronously with `{ exitCode, stderrTail, lastAckedEventId, kind:"exit", message }`.
5. Subsequent `emit()` calls short-circuit to no-op.
6. `run-cli.ts`'s `onFailure` handler writes a `ledger_failure` event into the existing `state.db` event store (per Phase A spec) and marks the run failed.

### Responsibility map

| Concern | Owner |
|---|---|
| Binary resolution, spawn, signal handling, stdio plumbing | `run-cli.ts` |
| Handshake protocol, control messages | `ledger-client/handshake.ts` + `wire.ts` |
| Envelope construction (id, timestamp, parent threading) | `ledger-client/envelope.ts` |
| Backpressure (bounded queue, block on overflow) | `ledger-client/backpressure.ts` |
| Child-exit watch, onFailure fan-out | `ledger-client/failure.ts` |
| JSONL ingest, canonicalize, SQLite write, CAS | `bp-ledger` (no change from Phase A) |
| Control-line parsing + ack writing | `bp-ledger/serve.rs` (new protocol module) |
| Wire-format production (adjacent-tagged enums) | caller's responsibility |

### Key contracts (new in Phase B)

- **Handshake is the one-and-only setup point.** An emitter that resolved to a `TapeEmitter` value has proven the ledger accepts the schema version and is ready to receive events. No emit ever happens before that.
- **Control messages are out-of-band.** They're JSONL lines on the same stdin stream, but their `control` field distinguishes them from event envelopes (events never have a `control` field). Rust rejects any line that has both an event shape and a `control` field.
- **Stderr is single-purpose for acks.** `bp-ledger` only writes JSON ack lines + protocol errors to stderr. No log lines, no warnings.
- **Emitter methods never reject after creation.** `emit` is sync + non-blocking (returns `void`); `flush`/`close` return Promises that resolve on success or fire `onFailure` + reject if the child died. No unexpected error bubbles up through `emit()`.

### What doesn't change from Phase A

- Everything in `bp-ledger` except `serve.rs` (and its tests). Storage, CAS, canonicalize, event types, payloads — untouched.
- `bp-ledger-macros`. No changes.
- `bp-cli`'s top-level dispatch. The `ledger serve` subcommand signature stays `--run-id --workspace --schema-version`.
- Existing `packages/storage/event-store.ts`. Still used for the `ledger_failure` escape hatch.

---

## 3. Public API + IPC Protocol

### TS public API

```ts
// src/index.ts (new public surface)
export interface CreateTapeEmitterOptions {
  childStdin: Writable;
  childStderr: Readable;
  childExit: Promise<number>;
  workspacePath: string;
  runId: RunId;
  /** Default: 30_000 ms. */
  handshakeTimeoutMs?: number;
  /** Default: 1024 events. */
  queueHighWatermark?: number;
  /** Default: 1. */
  schemaVersion?: number;
}

export interface EmitOptions {
  /** Parent event id, if any. UUIDv7. */
  parent?: EventId;
  /** Override auto-assigned id (tests only). */
  id?: EventId;
  /** Override occurred_at (tests only). */
  occurredAt?: string;
}

export interface TapeEmitter {
  /** Sync, non-blocking; queues for write. Blocks on internal backpressure via `.write()` returning false. */
  emit(kind: EventKind, payload: Payload, opts?: EmitOptions): void;
  /** Resolves when ledger acks `_flush`. Rejects if ledger died. */
  flush(): Promise<void>;
  /** Resolves when ledger acks `_close` and exits 0. Rejects on failure. */
  close(): Promise<void>;
  /** Register a callback fired exactly once when the ledger dies unexpectedly. */
  onFailure(cb: (reason: LedgerFailure) => void): void;
  /** Runtime stats for diagnostics. */
  stats(): { eventsEmitted: number; lastAckedEventId: EventId | null; queueDepth: number };
}

export interface LedgerFailure {
  kind: "exit" | "handshake_timeout" | "handshake_rejected" | "protocol_error";
  exitCode: number | null;
  stderrTail: string;
  lastAckedEventId: EventId | null;
  message: string;
}

export async function createTapeEmitter(opts: CreateTapeEmitterOptions): Promise<TapeEmitter>;

export class LedgerHandshakeError extends Error {
  constructor(readonly failure: LedgerFailure);
}

export type { Event, EventKind, Payload, EventId, RunId } from "./generated/index.js";
```

### API invariants

- `createTapeEmitter` is the only place an error can surface during setup. It rejects with `LedgerHandshakeError` on timeout, version mismatch, or spawn-time child death.
- `emit` cannot reject. If the ledger is dead, `emit` is a no-op; failure was already surfaced via `onFailure`.
- `flush` and `close` return Promises that resolve on success; on failure they reject with `LedgerFailure` and `onFailure` callbacks have already fired.
- Envelope fields set by the emitter: `id` (UUIDv7), `run_id` (from opts), `parent_event_id` (from EmitOptions.parent), `schema_version` (from opts), `occurred_at` (UTC now), `kind`, `payload`. Caller supplies `kind + payload + parent`; everything else is mechanical.

### IPC framing

Newline-delimited JSON (UTF-8), one object per line on stdin. Stderr carries JSON ack/error lines in the same framing. Both sides tolerate arbitrary whitespace between objects.

### Control messages

**TS → Rust (stdin):**

```jsonc
// Handshake (always the first line).
{"control":"handshake","protocol":1,"run_id":"01919...","started_at":"2026-04-17T12:00:00Z","schema_version":1}

// Flush (optional; can occur any time after handshake).
{"control":"flush","seq":42}

// Close (always the last line before stdin EOF).
{"control":"close","seq":43}

// Any line without a "control" field is a regular event envelope.
```

**Rust → TS (stderr):**

```jsonc
// Handshake success.
{"control":"handshake_ack","ready":true,"ledger_version":"0.1.0","schema_version":1}

// Handshake rejected.
{"control":"handshake_ack","ready":false,"reason":"schema version 99 not supported (supported: 1)"}

// Flush ack.
{"control":"flush_ack","seq":42,"last_event_id":"01919..."}

// Close ack (last stderr line before the child exits 0).
{"control":"close_ack","events_written":6,"last_event_id":"01919..."}

// Protocol error (last stderr line before the child exits non-zero).
{"control":"error","kind":"malformed_event","line":15,"message":"invalid json: ..."}
```

### Sequence numbers

`flush` and `close` include a monotonic `seq` integer starting at 0. Acks echo the `seq`. TS can use this to correlate acks with specific flushes when multiple are in flight. Events do not carry `seq` — they're identified by envelope `id`.

### Error kinds (stderr `control:"error"`)

- `malformed_event` — unparseable JSON or event envelope failed validation.
- `unsupported_schema` — event carried `schema_version` ≠ declared at handshake.
- `duplicate_event_id` — INSERT hit primary-key conflict.
- `storage_failure` — SQLite or CAS write failed.
- `internal_error` — catch-all with `message` for diagnostic.

After writing `control:"error"`, the ledger exits with a non-zero code matching the error kind (or `1` if no specific mapping).

### Backpressure mechanics

Emitter wraps `childStdin.write(line)` in a promise chain. When `write` returns `false`, the emitter awaits a single `drain` event before writing the next line. The public `emit()` method remains synchronous: it appends to an internal `Promise<void>` chain that serializes writes. Under burst load, `emit()` returns instantly while writes queue behind the pending chain. When the internal queue depth reaches `queueHighWatermark`, further `emit()` calls await the head of the chain before appending. Zero event loss, bounded memory, caller's event-producing code slows down naturally.

### Handshake timing

Ledger must respond to `_handshake` within `handshakeTimeoutMs` (default 30s). Ledger side: on spawn, the serve loop reads the first stdin line; if it's not a valid `control:"handshake"`, it exits non-zero without writing an ack. If valid, the ledger initializes SQLite (creates tables, runs `PRAGMA journal_mode=WAL`) and the CAS directory, then writes the ack. Database creation is inside the handshake window — for a cold start on a slow filesystem, this can be several hundred ms. Default 30s is generous enough that no legitimate run should time out.

### Child exit semantics

- **Clean close:** TS writes `_close`, awaits `close_ack`, awaits child exit 0.
- **Dirty exit:** any exit without a preceding `_close` is a `LedgerFailure{kind:"exit"}`.
- **Ledger-initiated failure:** internal error mid-run → writes `control:"error"` to stderr and exits non-zero. TS's stderr tailer surfaces the error; `onFailure` fires with the message.

### Rust-side changes

`native/crates/bp-ledger/src/serve.rs` grows a new entry point:

```rust
pub fn serve_with_protocol(
    stdin: impl Read,
    stderr: impl Write,
    store: &SqliteStore,
    cas: &Cas,
    declared_schema_version: u32,
) -> Result<ServeOutcome>;

pub struct ServeOutcome {
    pub events_written: u64,
    pub last_event_id: Option<EventId>,
}
```

Implemented as a state machine:

1. **AwaitingHandshake:** read line. If it's `control:"handshake"` with matching protocol + schema version, write `handshake_ack:{ready:true}`, transition. Else write `handshake_ack:{ready:false,reason}` and exit.
2. **Ingesting:** read lines. If `control:"flush"`: call `store.flush_fsync()` (new method), write `flush_ack`. If `control:"close"`: `flush_fsync()`, `close_ack`, exit 0. If regular event: canonicalize + append. On parse/validation/storage errors, write `control:"error"` and exit non-zero.

Existing `ingest()` stays around but becomes an internal helper. `bp-cli`'s `ledger serve` command switches from calling `ingest()` directly to calling `serve_with_protocol()`.

---

## 4. Testing Strategy

Phase B delta on top of Phase A's four-layer model.

### Layer 1 additions (Rust, inside `bp-ledger`)

New unit tests for the protocol state machine in `serve.rs`:

- **Handshake accepts valid, rejects invalid.** Fixtures for happy path, wrong protocol version, wrong schema version, missing fields. Assert correct ack shape on stderr.
- **Flush fsyncs and acks.** Mock/in-memory store; assert `store.flush_fsync()` is called and `flush_ack` carries the right `seq` + `last_event_id`.
- **Close acks then exits.** Assert `close_ack` is the last stderr line written.
- **Protocol error on malformed event.** Feed a bad JSON line mid-stream; assert `control:"error"` line is written with correct `line` number and non-zero exit.
- **First-line-not-handshake rejects.** Feed an event envelope as the first line; assert immediate non-zero exit with protocol error.
- **`_flush` before handshake rejects.** Asserts state-machine discipline.

Target: every state transition has a test.

### Layer 2 additions (TS, inside `packages/ledger-client`)

Unit tests with mock `Writable`/`Readable`/`Promise<number>`:

- **Envelope construction.** Given `emit("run_started", payload, {parent: id})`, assert the JSON line on mock stdin has: UUIDv7 `id`, correct `run_id`, `parent_event_id == id`, `schema_version`, RFC3339 `occurred_at`, `kind: "run_started"`, and the payload.
- **Handshake timeout.** Mock stderr that never emits; assert `createTapeEmitter` rejects with `LedgerHandshakeError{kind:"handshake_timeout"}` after the SLA.
- **Handshake rejection.** Mock stderr emits `handshake_ack:{ready:false}`; assert rejection with the reason.
- **Backpressure blocks.** Fill mock pipe to high-watermark; assert `stats().queueDepth` reports saturation and emit awaits `drain`.
- **onFailure fires on child exit.** Resolve `childExit` with non-zero; assert the onFailure callback fires within one tick with `{kind:"exit", exitCode, stderrTail, lastAckedEventId}`.
- **emit after failure is a no-op.** After onFailure fires, subsequent `emit()` calls do not write to the mock pipe.
- **flush ack correlation.** Two `flush()` calls in quick succession; assert each resolves when its matching `flush_ack` `seq` arrives.

### Layer 3 additions (TS → real Rust subprocess, under `test/ledger-integration/`)

**Critical discipline:** every integration test uses `mkdtemp` / `tmpdir` helpers that isolate the workspace. No test ever performs `git init` or `git commit` in `process.cwd()`. A shared `makeLedgerFixture()` helper enforces this.

- **happy-path.test.ts** — spawn the real binary, run the 6-event success criteria scenario, query SQLite, assert rows + causal chain.
- **handshake-failure.test.ts** — two cases: ledger binary missing (spawn error), ledger rejects schema version (stderr says `ready:false`). Assert both produce `LedgerHandshakeError` with the right kind.
- **crash-recovery.test.ts** — emit a few events, SIGKILL the child, assert `onFailure` fires with `kind:"exit"`, exit code matches SIGKILL's signal number, `stderrTail` contains whatever the ledger wrote before dying, and the partial events.db is internally consistent (`PRAGMA integrity_check` passes; last row is complete).
- **backpressure.test.ts** — stress emit 10,000 events as fast as possible; assert all are persisted (count matches), ordering preserved, queue depth never exceeded high watermark by more than one in-flight write, memory stable.
- **tool-request-redaction.test.ts** (Phase A follow-up (b)) — emit a `tool_request` envelope whose payload is `ToolRequestStoredV1` with `env: {redacted:true, hash:"sha256:abc", hint:"env_var"}` plus a secret-looking value in the raw test input. After close: query SQLite, grep the tape file system for the raw secret string, assert zero hits anywhere.

### Layer 4: payload drift alarm (Phase A follow-up (a))

Not a conventional unit test — a build-time exhaustiveness check with two halves:

**Rust half** — `native/crates/bp-ledger/tests/payload_variants.rs`:
- Uses manual enumeration or `strum`: asserts every variant of `EventKind` has a matching `Payload` constructor producible from a default fixture. Failing means: a variant exists that can't be fixtured, so TS tests can't exercise it.

**TS half** — `packages/ledger-client/test/payload-drift.test.ts`:
- Imports a JSON fixture file produced by `pnpm ledger:gen-fixtures` (new script).
- For each Rust `EventKind` variant, the fixtures file has one sample payload.
- An exhaustive TypeScript `switch` over `p.kind` where the `default` branch is typed as `never`. Adding a 15th Rust variant regenerates the fixture, which breaks this switch at compile time.

Fixture generator `pnpm ledger:gen-fixtures` is a one-shot Rust binary that emits canonical JSON for every variant. Run manually on Rust schema changes; CI enforces `git diff --exit-code` on the fixture file.

### Out-of-scope for Phase B testing

- Full eval-suite end-to-end run with the ledger enabled behind a flag. Phase C concern.
- Benchmarking tape-capture overhead. Deferred to Phase D.
- Cross-platform CAS / subprocess semantics. Linux + macOS only.

---

## 5. Phases + Sequencing

Phase B is sequential by nature (Rust protocol changes must land before TS client can integration-test against them). Total ~5-7 days focused work.

### Phase B.1 — Rust protocol state machine (2 days)

- Add `serve_with_protocol()` in `serve.rs` with the AwaitingHandshake → Ingesting state machine.
- Add `_handshake`, `_flush`, `_close` recognition and ack writing to stderr.
- Add `control:"error"` diagnostic line + non-zero exit on protocol violations.
- Wire `bp-cli ledger serve` to call `serve_with_protocol()` instead of raw `ingest()`.
- Rust Layer 1 tests for every state transition.

**Demo-able end-state:** `printf '{"control":"handshake",...}\n{event1}\n{"control":"close",...}\n' | buildplane-native ledger serve ...` writes an event, closes cleanly, stderr shows `handshake_ack` and `close_ack` in order.

**Gate:** all Layer 1 tests pass, old `bp-cli ledger serve` smoke still works (now exercising the handshake path).

### Phase B.2 — TS ledger-client runtime (2-3 days)

- Implement `emitter.ts`, `envelope.ts`, `wire.ts`, `handshake.ts`, `backpressure.ts`, `failure.ts` in `packages/ledger-client/src/`.
- Export public API from `index.ts`.
- TS Layer 2 tests with mock pipes for every public method and invariant.
- No changes to `run-cli.ts` yet.

**Demo-able end-state:** a standalone TS script can import `createTapeEmitter`, feed it mock pipes that replay scripted stderr acks, verify envelope construction by eyeballing mock stdin writes.

**Gate:** all Layer 2 tests pass; TS package builds cleanly with no type drift; generated types compile under all paths.

### Phase B.3 — Wire into run-cli.ts (1 day)

- Add `resolveLedgerBinary()` (mirrors existing `resolveNativeBinary`).
- Add `spawnLedgerSubprocess(runId, workspace)` helper.
- In the `run` command handler: pre-flight git check → resolve binary → spawn → `await createTapeEmitter(...)` → wire into event bus listener → run orchestrator → `emitter.close()` on finish.
- Add `onFailure` handler that writes `ledger_failure` to existing state.db event-store and marks the run failed.

**Demo-able end-state:** a real `pnpm buildplane run ./packet.json` produces an `events.db` alongside the existing `state.db`, with `run_started` / `run_completed` entries at minimum.

**Gate:** existing `run` command still works for all existing packet fixtures; ledger events.db created and populated with envelope events.

### Phase B.4 — Integration tests (1 day)

- `test/ledger-integration/` directory with the 5 test files outlined above.
- All use isolated tempdirs; zero test touches cwd git state.
- Tool-request redaction test proves Phase A follow-up (b).

**Demo-able end-state:** `pnpm test --filter test/ledger-integration/` passes all 5 scenarios locally and in CI.

**Gate:** all Layer 3 tests pass.

### Phase B.5 — Payload drift alarm + verification (0.5-1 day)

- Rust fixture generator binary + checked-in JSON fixtures.
- TS exhaustiveness switch test.
- `pnpm ledger:gen-fixtures` script + CI guard on fixture file git diff.
- Spec marker: "Phase B status: complete (YYYY-MM-DD)".
- Benchmark overhead measurement (informational; no gate).
- Final Phase B commit.

**Verification gate (sub-project "done"):**

- [ ] All Rust + TS unit tests + integration tests green.
- [ ] `pnpm buildplane run ./packet.json` produces a populated events.db alongside state.db.
- [ ] Payload drift alarm fails when manually mutating the TS switch.
- [ ] Tool-request redaction test proves no secret bytes in tape.
- [ ] Spec marker updated.
- [ ] No known event-loss or handshake-race bugs outstanding.

### Branching + shipping

Same strategy as Phase A: `feat/ledger-phase-b` off current main (once Phase A's PR #59 merges), progressive merge to main or long-lived branch per preference. Same `.husky/pre-push` hook mismatch will still apply; likely to need `--no-verify` again until the pre-existing test-isolation bug is fixed.

### What could make this slip

Ranked by probability:

1. **Pre-push hook test pollution on our own branch.** If Phase B adds integration tests that spawn subprocesses and those tests themselves have isolation bugs, they join the existing pile. Mitigation: `makeLedgerFixture()` + tempdir discipline enforced from Phase B.1.
2. **Handshake race conditions.** E.g., child writes `handshake_ack` before TS attaches a stderr reader. Mitigation: spawn sequence attaches the reader first, writes the handshake second.
3. **Node's `child_process.spawn` quirks on long-running stdin pipes.** Specifically `EPIPE` when child exits before stdin is closed. Mitigation: `failure.ts` swallows EPIPE on writes after `childExit` resolves.
4. **typeshare re-runs during Phase B producing different output.** Phase A's hand-written `Payload` + shims were careful; if someone bumps typeshare or adjusts annotations, the generated file shifts. Mitigation: pin the typeshare version in `scripts/ledger/generate-schema.sh` and run it as a no-op verification in CI.

---

## Appendix A: Decision Log

The three design decisions that shaped this spec, captured for future contributors asking "why this way?"

| # | Decision | Chosen option | Alternatives considered | Reason |
|---|---|---|---|---|
| 1 | Tape emitter responsibility | **C — Hybrid** (mechanical envelope + content by caller) | A (thin pipe), B (thick per-kind builders) | Envelope construction is mechanical and belongs in one place; content decisions (parent, redaction) are domain-specific and belong with callers. |
| 2 | Phase A follow-up inclusion | **B — (a) + (b) in scope; (c) deferred** | A (all three), C (only (a)) | (a) and (b) are natural byproducts of Phase B's TS-client + integration-test work. (c) SQL-surface hardening is a distinct concern that deserves its own sub-project. |
| 3 | Child process lifecycle | **A — Caller owns subprocess** | B (emitter owns), C (early-queue pattern) | Separation of concerns: binary resolution, spawn, cleanup belong in the CLI layer (matches existing `memory`/`pack` pattern). Testability: mock pipes without spawning a real process. Promise-returning `createTapeEmitter` is honest about handshake cost. |

---

## Appendix B: Relation to Other Sub-Projects

This sub-project is Phase B in the replayable-ledger roadmap.

0. **Foundation fixes** — SQLite transaction atomicity, memory ID collision, graph outcome classification. Pre-existing bugs. Parallel work.
1. **Unified memory model** — memory as a projection of the event log. Depends on Phase C (tool events) for full value.
2. **Event tape capture (Phase A)** — Rust `bp-ledger` crate. **Shipped in PR #59.**
3. **Event tape IPC (Phase B, this spec)** — TS client + handshake protocol + integration tests. Unlocks Phase C.
4. **Tool adapter instrumentation (Phase C)** — tool-level reads/writes, git checkpoints, real `buildplane run` → populated tape. Consumes Phase B.
5. **Replay + fork primitives (Phase D)** — consume tape to reconstruct state; produce new runs with lineage. Consumes B + C.
6. **Bisect (Phase E)** — walk tape for first bad event. Consumes B + C.
7. **Audit bundle + signing (Phase F)** — enterprise tier. Consumes everything.
8. **Cloud / team ledger** — hosted product surface.

Success of this sub-project is a precondition for Phase C. Failure or delay here delays everything downstream.
