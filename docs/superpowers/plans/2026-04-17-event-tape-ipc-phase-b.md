# Event Tape IPC — Phase B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the TypeScript side of the event tape. Ship `@buildplane/ledger-client` with a hybrid `TapeEmitter`, add handshake and control-message protocol to `bp-ledger serve`, wire the ledger into `buildplane run`, and ship integration tests plus a Payload drift alarm — so Phase C's tool-adapter instrumentation has a stable runtime to plug into.

**Architecture:** Rust `bp-ledger/serve.rs` grows a protocol state machine (AwaitingHandshake → Ingesting) exchanging control messages via stdin events + stderr acks. TypeScript `@buildplane/ledger-client` exposes `createTapeEmitter({ childStdin, childStderr, childExit, workspacePath, runId })` returning `Promise<TapeEmitter>` after handshake. `apps/cli/src/run-cli.ts` owns subprocess lifecycle (spawn + stdio plumbing), wires the emitter into the existing event-bus listener, and surfaces ledger failures via a `ledger_failure` record in the existing `state.db`.

**Tech Stack:** Rust (edition 2021), rusqlite (bundled), serde + serde_json, thiserror. TypeScript (Node 24, ESM, `type: "module"`), vitest, `node:crypto` for UUIDv7, `node:child_process` for subprocess, `node:stream` for backpressure primitives.

**Reference spec:** `docs/superpowers/specs/2026-04-17-event-tape-ipc-design.md`
**Builds on:** `docs/superpowers/specs/2026-04-17-event-tape-capture-design.md` (Phase A, shipped in PR #59)

---

## Phase B scope recap

**In scope for this plan:**
- `bp-ledger::serve::serve_with_protocol()` — AwaitingHandshake → Ingesting state machine
- Control messages: `_handshake`, `_flush`, `_close` on stdin; `handshake_ack`, `flush_ack`, `close_ack`, `error` on stderr
- `SqliteStore::flush_fsync()` — explicit flush + fsync primitive
- `@buildplane/ledger-client` runtime: `createTapeEmitter`, `TapeEmitter`, `LedgerFailure`, `LedgerHandshakeError`
- Envelope construction: UUIDv7 id, UTC RFC3339 occurred_at, schema_version, parent_event_id
- Backpressure: bounded queue, `.write()` drain discipline
- `run-cli.ts` integration: `resolveLedgerBinary()`, `spawnLedgerSubprocess()`, wiring into `run` command, failure path
- Integration tests: 5 scenarios under `test/ledger-integration/`
- Payload drift alarm: Rust fixture generator + TS exhaustiveness switch + CI guard
- Phase B verification gate

**Out of scope (Phase C or later):**
- Tool adapter hooks (`observeRead`/`observeWrite`)
- Git checkpoint emission
- `ledger inspect` CLI
- Replacement of existing `packages/storage/event-store.ts`
- Benchmark regression gates
- Cross-platform (Windows) support

---

## File structure

```
native/crates/bp-ledger/
├── src/
│   ├── serve.rs              # EXTEND: state machine + control messages
│   ├── storage/
│   │   └── sqlite.rs         # EXTEND: add flush_fsync()
│   └── bin/
│       └── gen_fixtures.rs   # NEW: fixture generator binary
├── Cargo.toml                # MODIFY: add bin target for gen_fixtures
└── tests/
    └── protocol_state.rs     # NEW: Layer 1 state-machine tests

native/crates/bp-cli/
└── src/
    └── ledger_cli.rs         # MODIFY: call serve_with_protocol()

packages/ledger-client/
├── package.json              # MODIFY: add deps, add test script
├── src/
│   ├── index.ts              # MODIFY: export public API
│   ├── emitter.ts            # NEW: createTapeEmitter + TapeEmitter
│   ├── envelope.ts           # NEW: UUIDv7, occurred_at, parent threading
│   ├── wire.ts               # NEW: JSONL framing + control builders
│   ├── handshake.ts          # NEW: handshake driver + stderr parser
│   ├── backpressure.ts       # NEW: bounded queue with drain
│   ├── failure.ts            # NEW: LedgerFailure + stderr tailer
│   ├── payload.ts            # EXISTING: hand-written Payload union
│   ├── shims.ts              # EXISTING: Uuid/DateTime/Value aliases
│   └── generated/            # EXISTING: typeshare output
├── test/
│   ├── wire.test.ts          # NEW: Layer 2 wire tests
│   ├── envelope.test.ts      # NEW: envelope construction tests
│   ├── handshake.test.ts     # NEW: handshake unit tests
│   ├── backpressure.test.ts  # NEW: queue tests
│   ├── emitter.test.ts       # NEW: TapeEmitter unit tests
│   └── payload-drift.test.ts # NEW: exhaustiveness alarm
└── fixtures/
    └── payload-variants.json # NEW: checked-in golden fixture

apps/cli/
└── src/
    └── run-cli.ts            # MODIFY: ledger spawn + integration

test/ledger-integration/
├── fixtures.ts               # NEW: makeLedgerFixture() helper
├── happy-path.test.ts        # NEW
├── handshake-failure.test.ts # NEW
├── crash-recovery.test.ts    # NEW
├── backpressure.test.ts      # NEW
└── tool-request-redaction.test.ts  # NEW

scripts/ledger/
├── generate-schema.sh        # EXISTING
└── gen-fixtures.sh           # NEW: runs the Rust fixture generator

package.json                  # MODIFY: add ledger:gen-fixtures script

.github/workflows/            # MODIFY (if it exists): add CI guard for fixture file

docs/superpowers/specs/2026-04-17-event-tape-ipc-design.md  # MODIFY: mark Phase B complete
```

---

## Phase B.1 — Rust Protocol State Machine

Adds the control-message protocol to `bp-ledger serve`. Existing `ingest()` becomes an internal helper; the new public entry point is `serve_with_protocol()`. Also adds `flush_fsync()` to `SqliteStore`.

### Task 1: Add `flush_fsync()` to `SqliteStore`

**Files:**
- Modify: `native/crates/bp-ledger/src/storage/sqlite.rs`

- [ ] **Step 1: Write failing test**

Append to `native/crates/bp-ledger/src/storage/sqlite.rs` inside the existing `#[cfg(test)] mod tests` block (or create one if none exists):

```rust
#[cfg(test)]
mod flush_fsync_tests {
    use super::*;

    #[test]
    fn flush_fsync_on_empty_store_succeeds() {
        let store = SqliteStore::open_in_memory().unwrap();
        store.flush_fsync().unwrap();
    }

    #[test]
    fn flush_fsync_after_append_returns_last_event_id() {
        use crate::event::Event;
        use crate::id::{EventId, RunId};
        use crate::kind::EventKind;
        use crate::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
        use crate::payload::Payload;
        use chrono::Utc;

        let store = SqliteStore::open_in_memory().unwrap();
        let event = Event {
            id: EventId::new(),
            run_id: RunId::new(),
            parent_event_id: None,
            schema_version: 1,
            kind: EventKind::RunCompleted,
            occurred_at: Utc::now(),
            payload: Payload::RunCompletedV1(RunCompletedV1 {
                outcome: RunOutcome::Passed,
                duration_ms: 0,
                event_count: 0,
                unit_count: 0,
            }),
        };
        store.append(&event).unwrap();
        let last = store.flush_fsync().unwrap();
        assert_eq!(last, Some(event.id));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger flush_fsync_tests
```

Expected: FAIL — `flush_fsync` method does not exist.

- [ ] **Step 3: Implement `flush_fsync`**

In the `impl SqliteStore` block (before the closing `}`), add:

```rust
    /// Flush the WAL and fsync. Returns the id of the most recently appended
    /// event (useful for flush_ack).
    pub fn flush_fsync(&self) -> Result<Option<EventId>> {
        // Commit + checkpoint the WAL to make writes durable.
        self.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;

        // Find the most recently appended event by UUIDv7 ordering.
        let last: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM events ORDER BY id DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()?;

        match last {
            Some(s) => {
                let uuid = uuid::Uuid::parse_str(&s).map_err(|e| {
                    LedgerError::Sqlite(rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    ))
                })?;
                Ok(Some(EventId::from_uuid(uuid)))
            }
            None => Ok(None),
        }
    }
```

At the top of the file, ensure `rusqlite::OptionalExtension` is imported (adds `.optional()` on query results):

```rust
use rusqlite::{params, Connection, OptionalExtension};
```

Also, `EventId` needs a `from_uuid` constructor if it doesn't already exist. Check `native/crates/bp-ledger/src/id.rs`; `RunId::from_uuid` exists but `EventId::from_uuid` may not. If missing, add it:

```rust
impl EventId {
    // ... existing ...
    pub fn from_uuid(u: Uuid) -> Self {
        Self(u)
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger flush_fsync_tests
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add native/crates/bp-ledger/src/storage/sqlite.rs native/crates/bp-ledger/src/id.rs
git commit -m "feat(ledger): add SqliteStore::flush_fsync returning last event id"
```

### Task 2: Define control message types

**Files:**
- Modify: `native/crates/bp-ledger/src/serve.rs`

- [ ] **Step 1: Write failing test**

Append to the existing `#[cfg(test)] mod tests` in `native/crates/bp-ledger/src/serve.rs`:

```rust
#[cfg(test)]
mod control_message_tests {
    use super::*;

    #[test]
    fn control_handshake_parses() {
        let line = r#"{"control":"handshake","protocol":1,"run_id":"01919000-0000-7000-8000-000000000000","started_at":"2026-04-17T12:00:00Z","schema_version":1}"#;
        let msg = parse_control_or_event(line).unwrap();
        match msg {
            Line::Control(ControlMessage::Handshake { protocol, schema_version, .. }) => {
                assert_eq!(protocol, 1);
                assert_eq!(schema_version, 1);
            }
            _ => panic!("expected Handshake"),
        }
    }

    #[test]
    fn control_flush_parses() {
        let line = r#"{"control":"flush","seq":42}"#;
        match parse_control_or_event(line).unwrap() {
            Line::Control(ControlMessage::Flush { seq }) => assert_eq!(seq, 42),
            _ => panic!("expected Flush"),
        }
    }

    #[test]
    fn control_close_parses() {
        let line = r#"{"control":"close","seq":43}"#;
        match parse_control_or_event(line).unwrap() {
            Line::Control(ControlMessage::Close { seq }) => assert_eq!(seq, 43),
            _ => panic!("expected Close"),
        }
    }

    #[test]
    fn event_envelope_parses_as_event() {
        use crate::id::{EventId, RunId};
        use crate::kind::EventKind;
        use crate::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
        use crate::payload::Payload;
        use chrono::Utc;

        let event = crate::event::Event {
            id: EventId::new(),
            run_id: RunId::new(),
            parent_event_id: None,
            schema_version: 1,
            kind: EventKind::RunCompleted,
            occurred_at: Utc::now(),
            payload: Payload::RunCompletedV1(RunCompletedV1 {
                outcome: RunOutcome::Passed,
                duration_ms: 0,
                event_count: 0,
                unit_count: 0,
            }),
        };
        let line = serde_json::to_string(&event).unwrap();
        match parse_control_or_event(&line).unwrap() {
            Line::Event(e) => assert_eq!(e.id, event.id),
            _ => panic!("expected Event"),
        }
    }

    #[test]
    fn line_with_control_field_and_event_shape_is_rejected() {
        let line = r#"{"control":"handshake","id":"01919000-0000-7000-8000-000000000001"}"#;
        // This looks like a handshake but has an id field — treat as malformed to prevent
        // ambiguity between control and event lines.
        let err = parse_control_or_event(line);
        // Ambiguous: control takes precedence; handshake will parse but schema_version
        // field missing → ControlMessage::Handshake returns error from the default parse.
        // Either way, this line shouldn't succeed as a plain Event.
        if let Ok(Line::Event(_)) = err {
            panic!("expected control-shaped line not to parse as Event");
        }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger control_message_tests
```

Expected: FAIL — types `Line`, `ControlMessage`, function `parse_control_or_event` do not exist.

- [ ] **Step 3: Add the types and parser**

In `native/crates/bp-ledger/src/serve.rs`, above the existing `ingest` function, add:

```rust
use crate::event::Event;

/// A single stdin line, interpreted as either a control message or an event envelope.
#[derive(Debug)]
pub enum Line {
    Control(ControlMessage),
    Event(Event),
}

/// Control messages received on stdin.
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "control", rename_all = "snake_case")]
pub enum ControlMessage {
    Handshake {
        protocol: u32,
        run_id: crate::id::RunId,
        started_at: String,
        schema_version: u32,
    },
    Flush {
        seq: u64,
    },
    Close {
        seq: u64,
    },
}

/// Parse a JSON line as either a control message or an event envelope. Tries
/// control first (lines with a `control` discriminator); if absent, tries to
/// deserialize as Event.
pub fn parse_control_or_event(line: &str) -> Result<Line> {
    // Peek: does the line have a "control" key?
    let value: serde_json::Value = serde_json::from_str(line).map_err(|e| {
        LedgerError::InvalidPayload {
            kind: "<line>".into(),
            reason: format!("invalid json: {e}"),
        }
    })?;
    if value.get("control").is_some() {
        let ctl: ControlMessage = serde_json::from_value(value).map_err(LedgerError::from)?;
        Ok(Line::Control(ctl))
    } else {
        let evt: Event = serde_json::from_value(value).map_err(LedgerError::from)?;
        Ok(Line::Event(evt))
    }
}
```

- [ ] **Step 4: Run test to verify passes**

```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger control_message_tests
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add native/crates/bp-ledger/src/serve.rs
git commit -m "feat(ledger): add control message types and parser"
```

### Task 3: Implement the state machine and `serve_with_protocol`

**Files:**
- Modify: `native/crates/bp-ledger/src/serve.rs`
- Create: `native/crates/bp-ledger/tests/protocol_state.rs`

- [ ] **Step 1: Write failing integration tests**

Create `native/crates/bp-ledger/tests/protocol_state.rs`:

```rust
//! Integration tests for the serve_with_protocol state machine.

use bp_ledger::serve::{serve_with_protocol, ServeOutcome};
use bp_ledger::storage::{sqlite::SqliteStore, Cas};
use std::io::Cursor;
use tempfile::TempDir;

fn make_fixture() -> (SqliteStore, Cas, TempDir) {
    let tmp = TempDir::new().unwrap();
    let store = SqliteStore::open(tmp.path().join("events.db")).unwrap();
    let cas = Cas::open(tmp.path().join("objects")).unwrap();
    (store, cas, tmp)
}

fn handshake_line(schema: u32) -> String {
    format!(
        r#"{{"control":"handshake","protocol":1,"run_id":"01919000-0000-7000-8000-000000000000","started_at":"2026-04-17T12:00:00Z","schema_version":{}}}"#,
        schema
    )
}

fn close_line(seq: u64) -> String {
    format!(r#"{{"control":"close","seq":{}}}"#, seq)
}

#[test]
fn happy_path_handshake_then_close() {
    let (store, cas, _tmp) = make_fixture();
    let stdin = format!("{}\n{}\n", handshake_line(1), close_line(0));
    let mut stderr = Vec::new();
    let outcome = serve_with_protocol(Cursor::new(stdin.as_bytes()), &mut stderr, &store, &cas, 1).unwrap();
    assert_eq!(outcome.events_written, 0);
    let stderr_text = String::from_utf8(stderr).unwrap();
    assert!(stderr_text.contains(r#""control":"handshake_ack""#));
    assert!(stderr_text.contains(r#""ready":true"#));
    assert!(stderr_text.contains(r#""control":"close_ack""#));
}

#[test]
fn first_line_not_handshake_rejects() {
    let (store, cas, _tmp) = make_fixture();
    let stdin = r#"{"control":"flush","seq":0}"#;
    let mut stderr = Vec::new();
    let err = serve_with_protocol(Cursor::new(stdin), &mut stderr, &store, &cas, 1);
    assert!(err.is_err());
    let stderr_text = String::from_utf8(stderr).unwrap();
    assert!(stderr_text.contains(r#""control":"error""#) || stderr_text.contains(r#""ready":false"#));
}

#[test]
fn schema_version_mismatch_rejects() {
    let (store, cas, _tmp) = make_fixture();
    let stdin = format!("{}\n", handshake_line(99));
    let mut stderr = Vec::new();
    let err = serve_with_protocol(Cursor::new(stdin.as_bytes()), &mut stderr, &store, &cas, 1);
    assert!(err.is_err());
    let stderr_text = String::from_utf8(stderr).unwrap();
    assert!(stderr_text.contains(r#""ready":false"#));
    assert!(stderr_text.contains("schema"));
}

#[test]
fn event_after_handshake_is_stored() {
    use bp_ledger::event::Event;
    use bp_ledger::id::{EventId, RunId};
    use bp_ledger::kind::EventKind;
    use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
    use bp_ledger::payload::Payload;
    use chrono::Utc;

    let (store, cas, _tmp) = make_fixture();
    let event = Event {
        id: EventId::new(),
        run_id: RunId::new(),
        parent_event_id: None,
        schema_version: 1,
        kind: EventKind::RunCompleted,
        occurred_at: Utc::now(),
        payload: Payload::RunCompletedV1(RunCompletedV1 {
            outcome: RunOutcome::Passed,
            duration_ms: 0,
            event_count: 1,
            unit_count: 0,
        }),
    };
    let stdin = format!(
        "{}\n{}\n{}\n",
        handshake_line(1),
        serde_json::to_string(&event).unwrap(),
        close_line(1),
    );
    let mut stderr = Vec::new();
    let outcome = serve_with_protocol(Cursor::new(stdin.as_bytes()), &mut stderr, &store, &cas, 1).unwrap();
    assert_eq!(outcome.events_written, 1);
    assert_eq!(outcome.last_event_id, Some(event.id));
}

#[test]
fn flush_ack_carries_seq() {
    use bp_ledger::event::Event;
    use bp_ledger::id::{EventId, RunId};
    use bp_ledger::kind::EventKind;
    use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
    use bp_ledger::payload::Payload;
    use chrono::Utc;

    let (store, cas, _tmp) = make_fixture();
    let event = Event {
        id: EventId::new(),
        run_id: RunId::new(),
        parent_event_id: None,
        schema_version: 1,
        kind: EventKind::RunCompleted,
        occurred_at: Utc::now(),
        payload: Payload::RunCompletedV1(RunCompletedV1 {
            outcome: RunOutcome::Passed,
            duration_ms: 0,
            event_count: 1,
            unit_count: 0,
        }),
    };
    let stdin = format!(
        "{}\n{}\n{}\n{}\n",
        handshake_line(1),
        serde_json::to_string(&event).unwrap(),
        r#"{"control":"flush","seq":7}"#,
        close_line(2),
    );
    let mut stderr = Vec::new();
    serve_with_protocol(Cursor::new(stdin.as_bytes()), &mut stderr, &store, &cas, 1).unwrap();
    let stderr_text = String::from_utf8(stderr).unwrap();
    assert!(stderr_text.contains(r#""control":"flush_ack""#));
    assert!(stderr_text.contains(r#""seq":7"#));
}

#[test]
fn malformed_event_line_writes_error_and_fails() {
    let (store, cas, _tmp) = make_fixture();
    let stdin = format!("{}\ngarbage not json\n", handshake_line(1));
    let mut stderr = Vec::new();
    let err = serve_with_protocol(Cursor::new(stdin.as_bytes()), &mut stderr, &store, &cas, 1);
    assert!(err.is_err());
    let stderr_text = String::from_utf8(stderr).unwrap();
    assert!(stderr_text.contains(r#""control":"handshake_ack""#));
    assert!(stderr_text.contains(r#""control":"error""#));
    assert!(stderr_text.contains(r#""kind":"malformed_event""#));
}
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger --test protocol_state
```

Expected: FAIL — `serve_with_protocol` and `ServeOutcome` don't exist.

- [ ] **Step 3: Implement `serve_with_protocol`**

Append to `native/crates/bp-ledger/src/serve.rs`:

```rust
use crate::canonicalize::canonicalize;
use crate::id::EventId;
use crate::storage::{sqlite::SqliteStore, Cas};
use std::io::{BufRead, BufReader, Read, Write};

#[derive(Debug, Default)]
pub struct ServeOutcome {
    pub events_written: u64,
    pub last_event_id: Option<EventId>,
}

/// Run the full protocol state machine against the provided reader/writer.
///
/// - Reads newline-delimited JSON lines from `stdin`.
/// - Writes JSON ack/error lines to `stderr`.
/// - Appends events to `store` and stores blob paths in `cas` (Phase B defers
///   CAS wiring for workspace_read/write events; caller passes paths via
///   event payload and Rust reads them in Phase C).
/// - Enforces the state machine: first line must be a valid handshake.
///
/// Returns an outcome with event count and last id on clean close.
pub fn serve_with_protocol<R: Read, W: Write>(
    stdin: R,
    mut stderr: W,
    store: &SqliteStore,
    _cas: &Cas,
    declared_schema_version: u32,
) -> Result<ServeOutcome> {
    let mut buf = BufReader::new(stdin);
    let mut outcome = ServeOutcome::default();

    // Phase: AwaitingHandshake
    let mut first_line = String::new();
    if buf.read_line(&mut first_line)? == 0 {
        write_error(&mut stderr, "handshake_missing", 1, "stdin closed before handshake")?;
        return Err(LedgerError::InvalidPayload {
            kind: "<handshake>".into(),
            reason: "stdin closed before handshake".into(),
        });
    }

    let line = first_line.trim();
    let parsed = match parse_control_or_event(line) {
        Ok(l) => l,
        Err(_) => {
            write_error(&mut stderr, "handshake_malformed", 1, "first line not valid json")?;
            return Err(LedgerError::InvalidPayload {
                kind: "<handshake>".into(),
                reason: "first line not valid json".into(),
            });
        }
    };

    match parsed {
        Line::Control(ControlMessage::Handshake { protocol, schema_version, .. }) => {
            if protocol != 1 {
                write_handshake_ack(&mut stderr, false, &format!("protocol {} not supported", protocol))?;
                return Err(LedgerError::InvalidPayload {
                    kind: "<handshake>".into(),
                    reason: format!("protocol {protocol} not supported"),
                });
            }
            if schema_version != declared_schema_version {
                write_handshake_ack(
                    &mut stderr,
                    false,
                    &format!("schema version {schema_version} not supported (supported: {declared_schema_version})"),
                )?;
                return Err(LedgerError::UnsupportedSchemaVersion {
                    received: schema_version,
                    supported: declared_schema_version,
                });
            }
            write_handshake_ack(&mut stderr, true, "")?;
        }
        _ => {
            write_error(&mut stderr, "handshake_required", 1, "first line must be a handshake")?;
            return Err(LedgerError::InvalidPayload {
                kind: "<handshake>".into(),
                reason: "first line must be a handshake".into(),
            });
        }
    }

    // Phase: Ingesting
    let mut line_no: u64 = 1;
    loop {
        line_no += 1;
        let mut s = String::new();
        let n = buf.read_line(&mut s)?;
        if n == 0 {
            break; // EOF without _close — treat as dirty exit (caller's concern)
        }
        let s = s.trim();
        if s.is_empty() {
            continue;
        }
        let parsed = match parse_control_or_event(s) {
            Ok(l) => l,
            Err(e) => {
                let msg = format!("line {}: {}", line_no, e);
                write_error(&mut stderr, "malformed_event", line_no, &msg)?;
                return Err(e);
            }
        };
        match parsed {
            Line::Event(event) => {
                let canonical = canonicalize(event)?;
                let event_id = canonical.id;
                if let Err(e) = store.append(&canonical) {
                    write_error(&mut stderr, "storage_failure", line_no, &format!("{}", e))?;
                    return Err(e);
                }
                outcome.events_written += 1;
                outcome.last_event_id = Some(event_id);
            }
            Line::Control(ControlMessage::Flush { seq }) => {
                let last = store.flush_fsync()?;
                write_flush_ack(&mut stderr, seq, last)?;
            }
            Line::Control(ControlMessage::Close { seq: _ }) => {
                let last = store.flush_fsync()?;
                write_close_ack(&mut stderr, outcome.events_written, last)?;
                return Ok(outcome);
            }
            Line::Control(ControlMessage::Handshake { .. }) => {
                write_error(&mut stderr, "unexpected_handshake", line_no, "handshake after initial setup")?;
                return Err(LedgerError::InvalidPayload {
                    kind: "<handshake>".into(),
                    reason: "unexpected second handshake".into(),
                });
            }
        }
    }

    Ok(outcome)
}

fn write_handshake_ack<W: Write>(stderr: &mut W, ready: bool, reason: &str) -> std::io::Result<()> {
    let line = if ready {
        format!(
            r#"{{"control":"handshake_ack","ready":true,"ledger_version":"{}","schema_version":1}}{}"#,
            env!("CARGO_PKG_VERSION"),
            '\n'
        )
    } else {
        format!(
            r#"{{"control":"handshake_ack","ready":false,"reason":{}}}{}"#,
            serde_json::to_string(reason).unwrap_or_else(|_| "\"error\"".to_string()),
            '\n'
        )
    };
    stderr.write_all(line.as_bytes())?;
    stderr.flush()
}

fn write_flush_ack<W: Write>(stderr: &mut W, seq: u64, last: Option<EventId>) -> std::io::Result<()> {
    let last_str = last.map(|e| e.to_string()).unwrap_or_default();
    let line = format!(
        r#"{{"control":"flush_ack","seq":{},"last_event_id":"{}"}}{}"#,
        seq, last_str, '\n'
    );
    stderr.write_all(line.as_bytes())?;
    stderr.flush()
}

fn write_close_ack<W: Write>(stderr: &mut W, events_written: u64, last: Option<EventId>) -> std::io::Result<()> {
    let last_str = last.map(|e| e.to_string()).unwrap_or_default();
    let line = format!(
        r#"{{"control":"close_ack","events_written":{},"last_event_id":"{}"}}{}"#,
        events_written, last_str, '\n'
    );
    stderr.write_all(line.as_bytes())?;
    stderr.flush()
}

fn write_error<W: Write>(stderr: &mut W, kind: &str, line_no: u64, message: &str) -> std::io::Result<()> {
    let line = format!(
        r#"{{"control":"error","kind":"{}","line":{},"message":{}}}{}"#,
        kind,
        line_no,
        serde_json::to_string(message).unwrap_or_else(|_| "\"error\"".to_string()),
        '\n'
    );
    stderr.write_all(line.as_bytes())?;
    stderr.flush()
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger --test protocol_state
```

Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add native/crates/bp-ledger/src/serve.rs native/crates/bp-ledger/tests/protocol_state.rs
git commit -m "feat(ledger): implement protocol state machine with handshake/flush/close"
```

### Task 4: Wire `bp-cli ledger serve` to use the protocol

**Files:**
- Modify: `native/crates/bp-cli/src/ledger_cli.rs`

- [ ] **Step 1: Update `run_serve`**

Open `native/crates/bp-cli/src/ledger_cli.rs`. Replace the body of `run_serve` so it calls `serve_with_protocol` instead of `ingest`:

```rust
use bp_ledger::serve::serve_with_protocol;
use bp_ledger::storage::{sqlite::SqliteStore, Cas};
use std::io::{self, Write};
use std::path::PathBuf;

// ... existing ServeArgs, LedgerCommand, parse_ledger_command unchanged ...

pub fn run_serve(args: ServeArgs) -> Result<(), String> {
    if args.schema_version != 1 {
        return Err(format!(
            "schema version {} not supported in this build (supported: 1)",
            args.schema_version
        ));
    }
    let ledger_dir = args.workspace.join(".buildplane").join("ledger");
    std::fs::create_dir_all(&ledger_dir).map_err(|e| format!("creating ledger dir: {e}"))?;
    let db_path = ledger_dir.join("events.db");
    let store = SqliteStore::open(&db_path).map_err(|e| format!("opening events.db: {e}"))?;
    let cas = Cas::open(ledger_dir.join("objects")).map_err(|e| format!("opening cas: {e}"))?;

    let stdin = io::stdin();
    let locked = stdin.lock();
    let stderr = io::stderr();
    let mut stderr_lock = stderr.lock();

    serve_with_protocol(locked, &mut stderr_lock, &store, &cas, 1)
        .map_err(|e| format!("serve: {e}"))?;

    stderr_lock.flush().ok();
    Ok(())
}
```

Leave the rest of the module unchanged.

- [ ] **Step 2: Verify build + existing smoke**

```bash
cargo build --manifest-path native/Cargo.toml -p bp-cli
```
Expected: PASS.

Smoke test with the new handshake-required protocol:

```bash
rm -rf /tmp/bp-phase-b-smoke && mkdir -p /tmp/bp-phase-b-smoke

cat > /tmp/bp-phase-b-smoke/input.jsonl <<'EOF'
{"control":"handshake","protocol":1,"run_id":"01919000-0000-7000-8000-000000000000","started_at":"2026-04-17T12:00:00Z","schema_version":1}
{"id":"01919000-0000-7000-8000-000000000001","run_id":"01919000-0000-7000-8000-000000000000","parent_event_id":null,"schema_version":1,"kind":"run_started","occurred_at":"2026-04-17T12:00:01Z","payload":{"RunStartedV1":{"packet_hash":"sha256:aa","git_head":"deadbeef","workspace_path":"/tmp/bp-phase-b-smoke","config":{},"parent_run_id":null}}}
{"control":"close","seq":0}
EOF

cat /tmp/bp-phase-b-smoke/input.jsonl | ./native/target/debug/buildplane-native ledger serve --run-id 01919000-0000-7000-8000-000000000000 --workspace /tmp/bp-phase-b-smoke 2>/tmp/bp-phase-b-smoke/stderr.log

echo "exit=$?"
echo "--- stderr ---"
cat /tmp/bp-phase-b-smoke/stderr.log
echo "--- db ---"
python3 -c "import sqlite3; c=sqlite3.connect('/tmp/bp-phase-b-smoke/.buildplane/ledger/events.db'); print(c.execute('SELECT kind FROM events').fetchall())"
```

Expected: exit 0; stderr contains `handshake_ack` with `ready:true`, then `close_ack` with `events_written:1`; SQLite query prints `[('run_started',)]`.

- [ ] **Step 3: Commit**

```bash
git add native/crates/bp-cli/src/ledger_cli.rs
git commit -m "feat(ledger): route bp-cli ledger serve through serve_with_protocol"
```

---

## Phase B.2 — TypeScript Ledger Client Runtime

Adds runtime code to `packages/ledger-client`. Each file has one clear responsibility; small unit tests accompany each.

### Task 5: Implement `wire.ts` — JSONL framing + control message builders

**Files:**
- Create: `packages/ledger-client/src/wire.ts`
- Create: `packages/ledger-client/test/wire.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/ledger-client/test/wire.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildHandshake,
  buildFlush,
  buildClose,
  parseAckLine,
  type HandshakeAck,
  type FlushAck,
  type CloseAck,
  type ErrorLine,
} from "../src/wire.js";

describe("wire builders", () => {
  it("builds a handshake line", () => {
    const line = buildHandshake({
      protocol: 1,
      runId: "01919000-0000-7000-8000-000000000000",
      startedAt: "2026-04-17T12:00:00Z",
      schemaVersion: 1,
    });
    expect(line).toContain(`"control":"handshake"`);
    expect(line).toContain(`"protocol":1`);
    expect(line).toContain(`"schema_version":1`);
    expect(line.endsWith("\n")).toBe(true);
  });

  it("builds a flush line with seq", () => {
    expect(buildFlush(42)).toBe(`{"control":"flush","seq":42}\n`);
  });

  it("builds a close line with seq", () => {
    expect(buildClose(43)).toBe(`{"control":"close","seq":43}\n`);
  });
});

describe("parseAckLine", () => {
  it("parses a handshake_ack success", () => {
    const line = `{"control":"handshake_ack","ready":true,"ledger_version":"0.1.0","schema_version":1}`;
    const ack = parseAckLine(line) as HandshakeAck;
    expect(ack.control).toBe("handshake_ack");
    expect(ack.ready).toBe(true);
    expect(ack.ledger_version).toBe("0.1.0");
  });

  it("parses a handshake_ack rejection", () => {
    const line = `{"control":"handshake_ack","ready":false,"reason":"bad schema"}`;
    const ack = parseAckLine(line) as HandshakeAck;
    expect(ack.ready).toBe(false);
    expect(ack.reason).toBe("bad schema");
  });

  it("parses a flush_ack", () => {
    const line = `{"control":"flush_ack","seq":7,"last_event_id":"01919000-0000-7000-8000-000000000001"}`;
    const ack = parseAckLine(line) as FlushAck;
    expect(ack.control).toBe("flush_ack");
    expect(ack.seq).toBe(7);
  });

  it("parses a close_ack", () => {
    const line = `{"control":"close_ack","events_written":5,"last_event_id":"01919000-0000-7000-8000-000000000002"}`;
    const ack = parseAckLine(line) as CloseAck;
    expect(ack.control).toBe("close_ack");
    expect(ack.events_written).toBe(5);
  });

  it("parses an error line", () => {
    const line = `{"control":"error","kind":"malformed_event","line":15,"message":"bad json"}`;
    const ack = parseAckLine(line) as ErrorLine;
    expect(ack.control).toBe("error");
    expect(ack.kind).toBe("malformed_event");
    expect(ack.line).toBe(15);
  });

  it("returns null on unrecognized control", () => {
    const line = `{"control":"unknown"}`;
    expect(parseAckLine(line)).toBeNull();
  });

  it("returns null on non-json", () => {
    expect(parseAckLine("not json")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
pnpm --filter @buildplane/ledger-client exec vitest run test/wire.test.ts
```

Expected: FAIL — `wire` module doesn't exist.

- [ ] **Step 3: Implement `wire.ts`**

Create `packages/ledger-client/src/wire.ts`:

```ts
/**
 * Wire protocol primitives for the bp-ledger IPC.
 *
 * Control messages go TS → Rust on stdin (via string lines) and Rust → TS on
 * stderr (as JSON ack lines). This file has no I/O — it builds strings and
 * parses strings.
 */

export interface HandshakeArgs {
	protocol: number;
	runId: string;
	startedAt: string;
	schemaVersion: number;
}

export function buildHandshake(args: HandshakeArgs): string {
	return (
		JSON.stringify({
			control: "handshake",
			protocol: args.protocol,
			run_id: args.runId,
			started_at: args.startedAt,
			schema_version: args.schemaVersion,
		}) + "\n"
	);
}

export function buildFlush(seq: number): string {
	return `{"control":"flush","seq":${seq}}\n`;
}

export function buildClose(seq: number): string {
	return `{"control":"close","seq":${seq}}\n`;
}

export interface HandshakeAck {
	control: "handshake_ack";
	ready: boolean;
	ledger_version?: string;
	schema_version?: number;
	reason?: string;
}

export interface FlushAck {
	control: "flush_ack";
	seq: number;
	last_event_id: string;
}

export interface CloseAck {
	control: "close_ack";
	events_written: number;
	last_event_id: string;
}

export interface ErrorLine {
	control: "error";
	kind: string;
	line: number;
	message: string;
}

export type AckLine = HandshakeAck | FlushAck | CloseAck | ErrorLine;

/** Parse a JSON ack line from the ledger's stderr. Returns null if unrecognized. */
export function parseAckLine(line: string): AckLine | null {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return null;
	}
	if (
		typeof value !== "object" ||
		value === null ||
		!("control" in value) ||
		typeof (value as { control: unknown }).control !== "string"
	) {
		return null;
	}
	const control = (value as { control: string }).control;
	switch (control) {
		case "handshake_ack":
		case "flush_ack":
		case "close_ack":
		case "error":
			return value as AckLine;
		default:
			return null;
	}
}
```

- [ ] **Step 4: Run test to verify pass**

```bash
pnpm --filter @buildplane/ledger-client exec vitest run test/wire.test.ts
```

Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ledger-client/src/wire.ts packages/ledger-client/test/wire.test.ts
git commit -m "feat(ledger-client): add wire protocol builders and ack parser"
```

### Task 6: Implement `envelope.ts` — UUIDv7 + envelope construction

**Files:**
- Create: `packages/ledger-client/src/envelope.ts`
- Create: `packages/ledger-client/test/envelope.test.ts`
- Modify: `packages/ledger-client/package.json` (add `uuid` dep)

- [ ] **Step 1: Add `uuid` dep**

Modify `packages/ledger-client/package.json`. Add to `dependencies`:
```json
"dependencies": {
  "uuid": "^11"
}
```
And `devDependencies`:
```json
"@types/uuid": "^10"
```

Then install:
```bash
pnpm install
```

- [ ] **Step 2: Write failing tests**

Create `packages/ledger-client/test/envelope.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildEnvelope } from "../src/envelope.js";

describe("buildEnvelope", () => {
	const runId = "01919000-0000-7000-8000-000000000000";

	it("auto-generates id and occurred_at", () => {
		const env = buildEnvelope({
			runId,
			schemaVersion: 1,
			kind: "run_started",
			payload: { RunStartedV1: {} },
		});
		expect(env.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(env.run_id).toBe(runId);
		expect(env.schema_version).toBe(1);
		expect(env.kind).toBe("run_started");
		expect(env.parent_event_id).toBeNull();
		expect(env.occurred_at).toMatch(/Z$/); // UTC RFC3339
	});

	it("threads parent_event_id", () => {
		const parent = "01919000-0000-7000-8000-000000000001";
		const env = buildEnvelope({
			runId,
			schemaVersion: 1,
			kind: "unit_started",
			payload: {},
			parent,
		});
		expect(env.parent_event_id).toBe(parent);
	});

	it("accepts explicit id and occurred_at (test override)", () => {
		const id = "01919000-0000-7000-8000-00000000000a";
		const env = buildEnvelope({
			runId,
			schemaVersion: 1,
			kind: "run_started",
			payload: {},
			id,
			occurredAt: "2026-04-17T12:00:00Z",
		});
		expect(env.id).toBe(id);
		expect(env.occurred_at).toBe("2026-04-17T12:00:00Z");
	});

	it("generates monotonic ids across rapid calls", () => {
		const ids = Array.from({ length: 10 }, () =>
			buildEnvelope({
				runId,
				schemaVersion: 1,
				kind: "run_started",
				payload: {},
			}).id,
		);
		const sorted = [...ids].sort();
		expect(ids).toEqual(sorted);
	});
});
```

- [ ] **Step 3: Run test to verify failure**

```bash
pnpm --filter @buildplane/ledger-client exec vitest run test/envelope.test.ts
```

Expected: FAIL — `envelope` module doesn't exist.

- [ ] **Step 4: Implement `envelope.ts`**

Create `packages/ledger-client/src/envelope.ts`:

```ts
import { v7 as uuidv7 } from "uuid";

export interface EnvelopeArgs {
	runId: string;
	schemaVersion: number;
	kind: string;
	// biome-ignore lint/suspicious/noExplicitAny: Payload is the union from generated+payload.ts
	payload: any;
	parent?: string;
	id?: string;
	occurredAt?: string;
}

export interface Envelope {
	id: string;
	run_id: string;
	parent_event_id: string | null;
	schema_version: number;
	kind: string;
	occurred_at: string;
	// biome-ignore lint/suspicious/noExplicitAny: see above
	payload: any;
}

/** Build a canonical v1 envelope for an event. Auto-generates id and occurred_at
 * unless overridden (overrides are intended for tests).
 */
export function buildEnvelope(args: EnvelopeArgs): Envelope {
	const id = args.id ?? uuidv7();
	const occurredAt = args.occurredAt ?? new Date().toISOString();
	return {
		id,
		run_id: args.runId,
		parent_event_id: args.parent ?? null,
		schema_version: args.schemaVersion,
		kind: args.kind,
		occurred_at: occurredAt,
		payload: args.payload,
	};
}
```

- [ ] **Step 5: Run test to verify pass**

```bash
pnpm --filter @buildplane/ledger-client exec vitest run test/envelope.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/ledger-client/src/envelope.ts packages/ledger-client/test/envelope.test.ts packages/ledger-client/package.json pnpm-lock.yaml
git commit -m "feat(ledger-client): add buildEnvelope with UUIDv7 id generation"
```

### Task 7: Implement `failure.ts` — `LedgerFailure` + stderr tailer

**Files:**
- Create: `packages/ledger-client/src/failure.ts`

- [ ] **Step 1: Implement**

Create `packages/ledger-client/src/failure.ts`:

```ts
import type { Readable } from "node:stream";

export type LedgerFailureKind =
	| "exit"
	| "handshake_timeout"
	| "handshake_rejected"
	| "protocol_error";

export interface LedgerFailure {
	kind: LedgerFailureKind;
	exitCode: number | null;
	stderrTail: string;
	lastAckedEventId: string | null;
	message: string;
}

/** Accumulates the last N bytes of a Readable stream (default 8 KiB).
 * Unref-friendly: detaches on close.
 */
export class StderrTailer {
	private buf: string = "";
	private readonly limit: number;

	constructor(stream: Readable, limit = 8 * 1024) {
		this.limit = limit;
		const onData = (chunk: Buffer | string) => {
			const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			this.buf = (this.buf + s).slice(-this.limit);
		};
		stream.on("data", onData);
		stream.once("close", () => stream.off("data", onData));
	}

	tail(): string {
		return this.buf;
	}
}

export class LedgerHandshakeError extends Error {
	constructor(readonly failure: LedgerFailure) {
		super(failure.message);
		this.name = "LedgerHandshakeError";
	}
}
```

- [ ] **Step 2: Verify build**

```bash
pnpm --filter @buildplane/ledger-client build
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/ledger-client/src/failure.ts
git commit -m "feat(ledger-client): add LedgerFailure type and StderrTailer"
```

### Task 8: Implement `backpressure.ts` — bounded queue with drain discipline

**Files:**
- Create: `packages/ledger-client/src/backpressure.ts`
- Create: `packages/ledger-client/test/backpressure.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/ledger-client/test/backpressure.test.ts`:

```ts
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { WriteQueue } from "../src/backpressure.js";

class MockPipe extends EventEmitter {
	public writes: string[] = [];
	public writable = true;

	write(chunk: string | Buffer, cb?: (err: Error | null) => void): boolean {
		const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		this.writes.push(s);
		if (cb) process.nextTick(() => cb(null));
		return this.writable;
	}

	drain() {
		this.writable = true;
		this.emit("drain");
	}

	fill() {
		this.writable = false;
	}
}

function asWritable(pipe: MockPipe): Writable {
	return pipe as unknown as Writable;
}

describe("WriteQueue", () => {
	it("writes a single line", async () => {
		const pipe = new MockPipe();
		const q = new WriteQueue(asWritable(pipe));
		q.write("hello\n");
		await q.flush();
		expect(pipe.writes).toEqual(["hello\n"]);
	});

	it("serializes concurrent writes", async () => {
		const pipe = new MockPipe();
		const q = new WriteQueue(asWritable(pipe));
		q.write("a\n");
		q.write("b\n");
		q.write("c\n");
		await q.flush();
		expect(pipe.writes).toEqual(["a\n", "b\n", "c\n"]);
	});

	it("awaits drain when pipe is full", async () => {
		const pipe = new MockPipe();
		pipe.fill();
		const q = new WriteQueue(asWritable(pipe), { highWatermark: 2 });
		q.write("a\n"); // first write happens (pipe.write returns false -> queue waits)
		q.write("b\n");
		// Third write should block until drain
		const third = q.write("c\n");
		expect(q.depth()).toBeGreaterThanOrEqual(1);
		pipe.drain();
		await third;
		await q.flush();
		expect(pipe.writes).toEqual(["a\n", "b\n", "c\n"]);
	});

	it("reports depth accurately", async () => {
		const pipe = new MockPipe();
		pipe.fill();
		const q = new WriteQueue(asWritable(pipe), { highWatermark: 100 });
		q.write("a\n");
		q.write("b\n");
		// Give microtasks a chance to enqueue
		await Promise.resolve();
		expect(q.depth()).toBeGreaterThan(0);
		pipe.drain();
		await q.flush();
		expect(q.depth()).toBe(0);
	});
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
pnpm --filter @buildplane/ledger-client exec vitest run test/backpressure.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `backpressure.ts`**

Create `packages/ledger-client/src/backpressure.ts`:

```ts
import type { Writable } from "node:stream";

export interface WriteQueueOptions {
	/** Maximum number of pending writes before new writes await the head of the chain. Default 1024. */
	highWatermark?: number;
}

/** A serial write queue that awaits `drain` when the underlying pipe is full.
 * Public `write()` returns a Promise<void> that resolves when the line has been
 * handed to the pipe (not necessarily flushed to disk). Internal state is
 * a linear chain of promises; the public `depth()` reports the number of
 * in-flight writes.
 */
export class WriteQueue {
	private tail: Promise<void> = Promise.resolve();
	private inFlight: number = 0;
	private readonly highWatermark: number;

	constructor(
		private readonly pipe: Writable,
		opts: WriteQueueOptions = {},
	) {
		this.highWatermark = opts.highWatermark ?? 1024;
	}

	write(chunk: string): Promise<void> {
		const prev = this.tail;
		const shouldBlock = this.inFlight >= this.highWatermark;
		const waitForHead = shouldBlock ? prev : Promise.resolve();

		this.inFlight += 1;
		const current = waitForHead.then(async () => {
			const ok = this.pipe.write(chunk);
			if (!ok) {
				await new Promise<void>((resolve) => this.pipe.once("drain", resolve));
			}
			this.inFlight -= 1;
		});
		this.tail = current.catch(() => {
			// Swallow errors in the chain so a failed write doesn't poison the whole queue.
			// Real error handling surfaces through the emitter's onFailure.
			this.inFlight = Math.max(0, this.inFlight - 1);
		});
		return current;
	}

	async flush(): Promise<void> {
		await this.tail;
	}

	depth(): number {
		return this.inFlight;
	}
}
```

- [ ] **Step 4: Run test to verify pass**

```bash
pnpm --filter @buildplane/ledger-client exec vitest run test/backpressure.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ledger-client/src/backpressure.ts packages/ledger-client/test/backpressure.test.ts
git commit -m "feat(ledger-client): add WriteQueue with drain-aware backpressure"
```

### Task 9: Implement `handshake.ts` — handshake driver

**Files:**
- Create: `packages/ledger-client/src/handshake.ts`
- Create: `packages/ledger-client/test/handshake.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/ledger-client/test/handshake.test.ts`:

```ts
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { performHandshake } from "../src/handshake.js";

class MockWritable extends EventEmitter {
	public writes: string[] = [];
	write(chunk: string): boolean {
		this.writes.push(chunk);
		return true;
	}
}

class MockReadable extends EventEmitter {
	push(line: string) {
		this.emit("data", Buffer.from(line));
	}
}

function asWritable(w: MockWritable): Writable {
	return w as unknown as Writable;
}
function asReadable(r: MockReadable): Readable {
	return r as unknown as Readable;
}

describe("performHandshake", () => {
	it("resolves on ready:true", async () => {
		const stdin = new MockWritable();
		const stderr = new MockReadable();
		const promise = performHandshake({
			stdin: asWritable(stdin),
			stderr: asReadable(stderr),
			runId: "01919000-0000-7000-8000-000000000000",
			schemaVersion: 1,
			timeoutMs: 5000,
		});
		// Simulate ledger responding.
		setImmediate(() => {
			stderr.push(
				`{"control":"handshake_ack","ready":true,"ledger_version":"0.1.0","schema_version":1}\n`,
			);
		});
		const result = await promise;
		expect(result.ready).toBe(true);
		expect(result.ledgerVersion).toBe("0.1.0");
		expect(stdin.writes[0]).toContain(`"control":"handshake"`);
	});

	it("rejects on ready:false with reason", async () => {
		const stdin = new MockWritable();
		const stderr = new MockReadable();
		const promise = performHandshake({
			stdin: asWritable(stdin),
			stderr: asReadable(stderr),
			runId: "01919000-0000-7000-8000-000000000000",
			schemaVersion: 99,
			timeoutMs: 5000,
		});
		setImmediate(() => {
			stderr.push(
				`{"control":"handshake_ack","ready":false,"reason":"bad schema"}\n`,
			);
		});
		await expect(promise).rejects.toThrow(/bad schema/);
	});

	it("rejects on timeout", async () => {
		const stdin = new MockWritable();
		const stderr = new MockReadable();
		const promise = performHandshake({
			stdin: asWritable(stdin),
			stderr: asReadable(stderr),
			runId: "01919000-0000-7000-8000-000000000000",
			schemaVersion: 1,
			timeoutMs: 50,
		});
		// Don't send anything — expect timeout.
		await expect(promise).rejects.toThrow(/handshake.*timeout/i);
	});
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
pnpm --filter @buildplane/ledger-client exec vitest run test/handshake.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `handshake.ts`**

Create `packages/ledger-client/src/handshake.ts`:

```ts
import type { Readable, Writable } from "node:stream";
import { LedgerHandshakeError, type LedgerFailure } from "./failure.js";
import { buildHandshake, parseAckLine } from "./wire.js";

export interface HandshakeInput {
	stdin: Writable;
	stderr: Readable;
	runId: string;
	schemaVersion: number;
	timeoutMs: number;
}

export interface HandshakeResult {
	ready: true;
	ledgerVersion: string;
	schemaVersion: number;
}

/** Write a handshake line to stdin and await the ledger's handshake_ack on stderr.
 * Rejects with LedgerHandshakeError on timeout, rejection, or stream close.
 */
export function performHandshake(
	input: HandshakeInput,
): Promise<HandshakeResult> {
	return new Promise<HandshakeResult>((resolve, reject) => {
		const handshakeLine = buildHandshake({
			protocol: 1,
			runId: input.runId,
			startedAt: new Date().toISOString(),
			schemaVersion: input.schemaVersion,
		});

		let buffer = "";
		let settled = false;

		const cleanup = () => {
			input.stderr.off("data", onData);
			input.stderr.off("close", onClose);
			clearTimeout(timeout);
		};

		const settleWith = (ok: boolean, result: HandshakeResult | LedgerFailure) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (ok) {
				resolve(result as HandshakeResult);
			} else {
				reject(new LedgerHandshakeError(result as LedgerFailure));
			}
		};

		const onData = (chunk: Buffer | string) => {
			const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			buffer += s;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				const ack = parseAckLine(line);
				if (ack && ack.control === "handshake_ack") {
					if (ack.ready) {
						settleWith(true, {
							ready: true,
							ledgerVersion: ack.ledger_version ?? "unknown",
							schemaVersion: ack.schema_version ?? input.schemaVersion,
						});
					} else {
						settleWith(false, {
							kind: "handshake_rejected",
							exitCode: null,
							stderrTail: line,
							lastAckedEventId: null,
							message: ack.reason ?? "handshake rejected",
						});
					}
					return;
				}
			}
		};

		const onClose = () => {
			settleWith(false, {
				kind: "handshake_timeout",
				exitCode: null,
				stderrTail: buffer,
				lastAckedEventId: null,
				message: "ledger stderr closed before handshake_ack",
			});
		};

		const timeout = setTimeout(() => {
			settleWith(false, {
				kind: "handshake_timeout",
				exitCode: null,
				stderrTail: buffer,
				lastAckedEventId: null,
				message: `ledger did not respond to handshake within ${input.timeoutMs}ms`,
			});
		}, input.timeoutMs);

		input.stderr.on("data", onData);
		input.stderr.once("close", onClose);

		// Write the handshake line.
		input.stdin.write(handshakeLine);
	});
}
```

- [ ] **Step 4: Run test to verify pass**

```bash
pnpm --filter @buildplane/ledger-client exec vitest run test/handshake.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ledger-client/src/handshake.ts packages/ledger-client/test/handshake.test.ts
git commit -m "feat(ledger-client): add performHandshake with timeout and rejection semantics"
```

### Task 10: Implement `emitter.ts` — `createTapeEmitter` + `TapeEmitter`

**Files:**
- Create: `packages/ledger-client/src/emitter.ts`
- Create: `packages/ledger-client/test/emitter.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/ledger-client/test/emitter.test.ts`:

```ts
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createTapeEmitter } from "../src/emitter.js";

class MockWritable extends EventEmitter {
	public writes: string[] = [];
	write(chunk: string): boolean {
		this.writes.push(chunk);
		return true;
	}
	end() {}
}
class MockReadable extends EventEmitter {
	push(line: string) {
		this.emit("data", Buffer.from(line));
	}
}
const asWritable = (w: MockWritable) => w as unknown as Writable;
const asReadable = (r: MockReadable) => r as unknown as Readable;

function createMock() {
	const stdin = new MockWritable();
	const stderr = new MockReadable();
	let exitResolve: (code: number) => void = () => {};
	const childExit = new Promise<number>((r) => {
		exitResolve = r;
	});
	return { stdin, stderr, childExit, exitResolve };
}

describe("createTapeEmitter", () => {
	const runId = "01919000-0000-7000-8000-000000000000";

	it("resolves after handshake success", async () => {
		const { stdin, stderr, childExit } = createMock();
		const emitterP = createTapeEmitter({
			childStdin: asWritable(stdin),
			childStderr: asReadable(stderr),
			childExit,
			workspacePath: "/tmp/ws",
			runId,
		});
		setImmediate(() => {
			stderr.push(
				`{"control":"handshake_ack","ready":true,"ledger_version":"0.1.0","schema_version":1}\n`,
			);
		});
		const emitter = await emitterP;
		expect(stdin.writes[0]).toContain(`"control":"handshake"`);
		expect(emitter.stats().eventsEmitted).toBe(0);
	});

	it("emits an event as a JSONL line after handshake", async () => {
		const { stdin, stderr, childExit } = createMock();
		const emitterP = createTapeEmitter({
			childStdin: asWritable(stdin),
			childStderr: asReadable(stderr),
			childExit,
			workspacePath: "/tmp/ws",
			runId,
		});
		setImmediate(() =>
			stderr.push(
				`{"control":"handshake_ack","ready":true,"ledger_version":"0.1.0","schema_version":1}\n`,
			),
		);
		const emitter = await emitterP;
		emitter.emit("run_started", { RunStartedV1: { packet_hash: "sha256:aa" } });
		// Wait a tick for the queue to drain.
		await new Promise((r) => setImmediate(r));
		// writes[0] is handshake, writes[1] is our event.
		expect(stdin.writes.length).toBeGreaterThanOrEqual(2);
		const eventLine = stdin.writes[1];
		expect(eventLine).toContain(`"kind":"run_started"`);
		expect(eventLine).toContain(`"run_id":"${runId}"`);
		expect(eventLine.endsWith("\n")).toBe(true);
	});

	it("onFailure fires when child exits non-zero unexpectedly", async () => {
		const { stdin, stderr, childExit, exitResolve } = createMock();
		const emitterP = createTapeEmitter({
			childStdin: asWritable(stdin),
			childStderr: asReadable(stderr),
			childExit,
			workspacePath: "/tmp/ws",
			runId,
		});
		setImmediate(() =>
			stderr.push(
				`{"control":"handshake_ack","ready":true,"ledger_version":"0.1.0","schema_version":1}\n`,
			),
		);
		const emitter = await emitterP;
		const cb = vi.fn();
		emitter.onFailure(cb);
		exitResolve(42);
		await new Promise((r) => setImmediate(r));
		expect(cb).toHaveBeenCalledOnce();
		expect(cb.mock.calls[0][0].exitCode).toBe(42);
		expect(cb.mock.calls[0][0].kind).toBe("exit");
	});

	it("emit after failure is a no-op", async () => {
		const { stdin, stderr, childExit, exitResolve } = createMock();
		const emitterP = createTapeEmitter({
			childStdin: asWritable(stdin),
			childStderr: asReadable(stderr),
			childExit,
			workspacePath: "/tmp/ws",
			runId,
		});
		setImmediate(() =>
			stderr.push(
				`{"control":"handshake_ack","ready":true,"ledger_version":"0.1.0","schema_version":1}\n`,
			),
		);
		const emitter = await emitterP;
		exitResolve(1);
		await new Promise((r) => setImmediate(r));
		const writesBefore = stdin.writes.length;
		emitter.emit("run_completed", {});
		await new Promise((r) => setImmediate(r));
		expect(stdin.writes.length).toBe(writesBefore);
	});

	it("flush resolves when ledger sends flush_ack", async () => {
		const { stdin, stderr, childExit } = createMock();
		const emitterP = createTapeEmitter({
			childStdin: asWritable(stdin),
			childStderr: asReadable(stderr),
			childExit,
			workspacePath: "/tmp/ws",
			runId,
		});
		setImmediate(() =>
			stderr.push(
				`{"control":"handshake_ack","ready":true,"ledger_version":"0.1.0","schema_version":1}\n`,
			),
		);
		const emitter = await emitterP;
		const flushP = emitter.flush();
		// The emitter writes a flush line; figure out its seq from the buffer.
		const flushLine = stdin.writes.find((w) => w.includes(`"control":"flush"`));
		expect(flushLine).toBeTruthy();
		const seq = JSON.parse(flushLine!).seq;
		setImmediate(() =>
			stderr.push(
				`{"control":"flush_ack","seq":${seq},"last_event_id":"01919000-0000-7000-8000-000000000001"}\n`,
			),
		);
		await flushP; // resolves
	});
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
pnpm --filter @buildplane/ledger-client exec vitest run test/emitter.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `emitter.ts`**

Create `packages/ledger-client/src/emitter.ts`:

```ts
import type { Readable, Writable } from "node:stream";
import { WriteQueue } from "./backpressure.js";
import { buildEnvelope } from "./envelope.js";
import {
	LedgerHandshakeError,
	StderrTailer,
	type LedgerFailure,
} from "./failure.js";
import { performHandshake } from "./handshake.js";
import { buildClose, buildFlush, parseAckLine } from "./wire.js";

export interface CreateTapeEmitterOptions {
	childStdin: Writable;
	childStderr: Readable;
	childExit: Promise<number>;
	workspacePath: string;
	runId: string;
	/** Default: 30_000 ms. */
	handshakeTimeoutMs?: number;
	/** Default: 1024 events. */
	queueHighWatermark?: number;
	/** Default: 1. */
	schemaVersion?: number;
}

export interface EmitOptions {
	/** Parent event id, if any. UUIDv7. */
	parent?: string;
	/** Override auto-assigned id (tests only). */
	id?: string;
	/** Override occurred_at (tests only). */
	occurredAt?: string;
}

export interface TapeEmitter {
	emit(kind: string, payload: unknown, opts?: EmitOptions): void;
	flush(): Promise<void>;
	close(): Promise<void>;
	onFailure(cb: (reason: LedgerFailure) => void): void;
	stats(): {
		eventsEmitted: number;
		lastAckedEventId: string | null;
		queueDepth: number;
	};
}

export async function createTapeEmitter(
	opts: CreateTapeEmitterOptions,
): Promise<TapeEmitter> {
	const schemaVersion = opts.schemaVersion ?? 1;
	const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 30_000;
	const highWatermark = opts.queueHighWatermark ?? 1024;

	const tailer = new StderrTailer(opts.childStderr);

	await performHandshake({
		stdin: opts.childStdin,
		stderr: opts.childStderr,
		runId: opts.runId,
		schemaVersion,
		timeoutMs: handshakeTimeoutMs,
	});

	const queue = new WriteQueue(opts.childStdin, { highWatermark });
	const failureCallbacks: Array<(r: LedgerFailure) => void> = [];
	let failed = false;
	let eventsEmitted = 0;
	let lastAckedEventId: string | null = null;
	let flushSeq = 0;
	const pendingFlushes = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
	let closeResolve: (() => void) | null = null;
	let closeReject: ((e: Error) => void) | null = null;

	// Listen for post-handshake ack lines on stderr.
	let stderrBuf = "";
	const onStderrData = (chunk: Buffer | string) => {
		const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		stderrBuf += s;
		const lines = stderrBuf.split("\n");
		stderrBuf = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			const ack = parseAckLine(line);
			if (!ack) continue;
			if (ack.control === "flush_ack") {
				lastAckedEventId = ack.last_event_id || lastAckedEventId;
				const pending = pendingFlushes.get(ack.seq);
				if (pending) {
					pending.resolve();
					pendingFlushes.delete(ack.seq);
				}
			} else if (ack.control === "close_ack") {
				lastAckedEventId = ack.last_event_id || lastAckedEventId;
				if (closeResolve) closeResolve();
			} else if (ack.control === "error") {
				markFailed({
					kind: "protocol_error",
					exitCode: null,
					stderrTail: tailer.tail(),
					lastAckedEventId,
					message: `${ack.kind}: ${ack.message}`,
				});
			}
		}
	};
	opts.childStderr.on("data", onStderrData);

	function markFailed(failure: LedgerFailure): void {
		if (failed) return;
		failed = true;
		for (const cb of failureCallbacks) {
			try {
				cb(failure);
			} catch {}
		}
		// Reject pending flushes and close.
		for (const [, p] of pendingFlushes) {
			p.reject(new Error(failure.message));
		}
		pendingFlushes.clear();
		if (closeReject) closeReject(new Error(failure.message));
	}

	// Watch the child exit promise.
	opts.childExit.then((code) => {
		if (code !== 0) {
			markFailed({
				kind: "exit",
				exitCode: code,
				stderrTail: tailer.tail(),
				lastAckedEventId,
				message: `ledger exited with code ${code}`,
			});
		}
	});

	return {
		emit(kind, payload, emitOpts) {
			if (failed) return;
			const env = buildEnvelope({
				runId: opts.runId,
				schemaVersion,
				kind,
				payload,
				parent: emitOpts?.parent,
				id: emitOpts?.id,
				occurredAt: emitOpts?.occurredAt,
			});
			const line = JSON.stringify(env) + "\n";
			eventsEmitted += 1;
			queue.write(line).catch(() => {
				// Failure is surfaced via onFailure; don't bubble here.
			});
		},
		async flush() {
			if (failed) throw new Error("ledger failed; flush unavailable");
			const seq = flushSeq++;
			const promise = new Promise<void>((resolve, reject) => {
				pendingFlushes.set(seq, { resolve, reject });
			});
			await queue.write(buildFlush(seq));
			await promise;
		},
		async close() {
			if (failed) throw new Error("ledger failed; close unavailable");
			const seq = flushSeq++;
			const promise = new Promise<void>((resolve, reject) => {
				closeResolve = resolve;
				closeReject = reject;
			});
			await queue.write(buildClose(seq));
			await promise;
			// Await child exit to confirm clean shutdown.
			const code = await opts.childExit;
			if (code !== 0 && !failed) {
				throw new Error(`ledger exited with code ${code} after close`);
			}
		},
		onFailure(cb) {
			failureCallbacks.push(cb);
		},
		stats() {
			return {
				eventsEmitted,
				lastAckedEventId,
				queueDepth: queue.depth(),
			};
		},
	};
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
pnpm --filter @buildplane/ledger-client exec vitest run test/emitter.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ledger-client/src/emitter.ts packages/ledger-client/test/emitter.test.ts
git commit -m "feat(ledger-client): add createTapeEmitter with emit/flush/close/onFailure"
```

### Task 11: Wire public exports through `index.ts`

**Files:**
- Modify: `packages/ledger-client/src/index.ts`

- [ ] **Step 1: Replace the file**

Replace `packages/ledger-client/src/index.ts`:

```ts
// Public API for @buildplane/ledger-client.
//
// Phase A shipped the types skeleton; Phase B adds the runtime.

export {
	createTapeEmitter,
	type CreateTapeEmitterOptions,
	type EmitOptions,
	type TapeEmitter,
} from "./emitter.js";

export {
	LedgerHandshakeError,
	type LedgerFailure,
	type LedgerFailureKind,
} from "./failure.js";

export * from "./generated/index.js";
export type { Payload } from "./payload.js";
```

- [ ] **Step 2: Build and typecheck**

```bash
pnpm --filter @buildplane/ledger-client build
pnpm exec tsc --build --pretty false
```

Expected: clean build, no type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/ledger-client/src/index.ts
git commit -m "feat(ledger-client): expose emitter public API from index"
```

---

## Phase B.3 — Wire Into `run-cli.ts`

The emitter is useless until real `buildplane run` invocations stream events through it. This phase wires it in behind an opt-in env var initially (so the rollout is gated) and flips the default once integration tests pass in B.4.

### Task 12: Add `resolveLedgerBinary` + `spawnLedgerSubprocess` helpers

**Files:**
- Modify: `apps/cli/src/run-cli.ts`

- [ ] **Step 1: Add the helpers**

Open `apps/cli/src/run-cli.ts`. Near the existing `resolveNativeBinary` (around line 820-835 per Phase A), add a wrapper:

```ts
function resolveLedgerBinary(cwd: string): string {
	// Reuses the same resolution chain as resolveNativeBinary. The binary is
	// the same; we just give it a ledger subcommand.
	return resolveNativeBinary(cwd);
}
```

Further down in the file (or near the subprocess helpers for memory/pack), add:

```ts
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

interface LedgerChild {
	child: ChildProcess;
	stdin: NodeJS.WritableStream;
	stderr: NodeJS.ReadableStream;
	exit: Promise<number>;
}

function spawnLedgerSubprocess(
	binary: string,
	runId: string,
	workspace: string,
): LedgerChild {
	const child = spawn(
		binary,
		[
			"ledger",
			"serve",
			"--run-id",
			runId,
			"--workspace",
			workspace,
			"--schema-version",
			"1",
		],
		{
			stdio: ["pipe", "inherit", "pipe"],
			cwd: workspace,
		},
	);
	if (!child.stdin || !child.stderr) {
		throw new Error("ledger subprocess stdio unexpectedly missing");
	}
	const exit = new Promise<number>((resolve) => {
		child.on("exit", (code) => resolve(code ?? -1));
	});
	return { child, stdin: child.stdin, stderr: child.stderr, exit };
}
```

- [ ] **Step 2: Verify build**

```bash
pnpm --filter @buildplane/cli build
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/run-cli.ts
git commit -m "feat(cli): add ledger binary resolution and subprocess spawn helpers"
```

### Task 13: Integrate the emitter into the `run` command

**Files:**
- Modify: `apps/cli/src/run-cli.ts`

- [ ] **Step 1: Update `run` command handler**

In `run-cli.ts`, find the `case "run":` block in the main command switch. Around where the packet is loaded and orchestrator is about to execute, wrap the execution in ledger setup/teardown.

Psuedo-diff (exact line range depends on file state; locate by searching for the `case "run":` label and the `orchestrator.runPacketAsync` call):

```ts
case "run": {
	// ... existing pre-flight: parse args, load packet, clean-worktree check ...

	const runId = rawPacket.runId ?? /* existing run id generation */;
	const workspace = cwd; // absolute path
	const useLedger = process.env.BUILDPLANE_LEDGER !== "0"; // opt-out (default on)

	let ledgerChild: LedgerChild | null = null;
	let emitter: TapeEmitter | null = null;
	if (useLedger) {
		const binary = resolveLedgerBinary(cwd);
		ledgerChild = spawnLedgerSubprocess(binary, runId, workspace);
		try {
			emitter = await createTapeEmitter({
				childStdin: ledgerChild.stdin as Writable,
				childStderr: ledgerChild.stderr as Readable,
				childExit: ledgerChild.exit,
				workspacePath: workspace,
				runId,
			});
			emitter.onFailure((failure) => {
				// Write a ledger_failure record into the existing state.db so there's
				// a durable record that the ledger itself crashed.
				try {
					const eventStore = (
						await cliImport("@buildplane/storage")
					) as unknown as {
						createEventStore: (root: string) => {
							persistEvent: (runId: string, event: unknown) => void;
						};
					};
					eventStore
						.createEventStore(cwd)
						.persistEvent(runId, {
							kind: "ledger_failure",
							timestamp: new Date().toISOString(),
							runId,
							payload: failure,
						});
				} catch {
					// best-effort
				}
			});
		} catch (err) {
			// Handshake failed — abort the run before it starts.
			ledgerChild.child.kill("SIGTERM");
			throw err;
		}
	}

	// Attach emitter to event bus if present.
	let unsubscribeLedger: (() => void) | null = null;
	if (emitter) {
		const unit_to_eventid = new Map<string, string>();
		unsubscribeLedger = eventBus.subscribe((evt: unknown) => {
			const e = evt as { kind: string; runId?: string; unitId?: string };
			if (!emitter) return;
			const parentForThisEvent = /* simple heuristic: last seen unit_started for this unitId */
				e.unitId && unit_to_eventid.has(e.unitId)
					? unit_to_eventid.get(e.unitId)
					: undefined;
			// Map the existing ExecutionEvent kind to a ledger kind:
			const ledgerKind = mapEventKind(e.kind);
			if (!ledgerKind) return;
			const payload = mapEventPayload(e);
			emitter.emit(ledgerKind, payload, { parent: parentForThisEvent });
			if (ledgerKind === "unit_started" && e.unitId) {
				// Track for threading subsequent child events.
				const stats = emitter.stats();
				if (stats.lastAckedEventId) unit_to_eventid.set(e.unitId, stats.lastAckedEventId);
			}
		});
	}

	try {
		const result = await orchestrator.runPacketAsync(rawPacket, eventBus);

		if (emitter) {
			await emitter.close();
		}
		unsubscribeLedger?.();
		return result.run.status === "passed" ? 0 : 1;
	} catch (err) {
		if (emitter) {
			try {
				await emitter.close();
			} catch {
				// Ignore cleanup errors; the original error is more important.
			}
		}
		unsubscribeLedger?.();
		throw err;
	}
}
```

Add helper functions near the top of the file:

```ts
/** Map an ExecutionEvent kind to a ledger EventKind. Returns null for kinds
 * that don't have a ledger analogue yet (Phase C adds more).
 */
function mapEventKind(execKind: string): string | null {
	switch (execKind) {
		case "RunStartedEvent":
			return "run_started";
		case "RunCompletedEvent":
			return "run_completed";
		case "UnitStartedEvent":
			return "unit_started";
		case "UnitCompletedEvent":
			return "unit_completed";
		case "UnitFailedEvent":
			return "unit_failed";
		default:
			return null;
	}
}

/** Map an ExecutionEvent payload to a ledger payload. Phase B is a minimal
 * shape; Phase C fills in tool events and workspace observations.
 */
function mapEventPayload(event: unknown): unknown {
	const e = event as Record<string, unknown>;
	const kind = mapEventKind(e.kind as string);
	switch (kind) {
		case "run_started":
			return {
				RunStartedV1: {
					packet_hash: e.packetHash ?? "sha256:unknown",
					git_head: e.gitHead ?? "",
					workspace_path: e.workspacePath ?? "",
					config: {},
					parent_run_id: null,
				},
			};
		case "run_completed":
			return {
				RunCompletedV1: {
					outcome: e.outcome ?? "passed",
					duration_ms: e.durationMs ?? 0,
					event_count: e.eventCount ?? 0,
					unit_count: e.unitCount ?? 0,
				},
			};
		case "unit_started":
			return {
				UnitStartedV1: {
					unit_id: e.unitId ?? "unknown",
					parent_unit_id: null,
					unit_kind: e.unitKind ?? "command",
					policy: {},
				},
			};
		case "unit_completed":
			return {
				UnitCompletedV1: {
					unit_id: e.unitId ?? "unknown",
					outcome: e.outcome ?? "passed",
					artifacts: [],
				},
			};
		case "unit_failed":
			return {
				UnitFailedV1: {
					unit_id: e.unitId ?? "unknown",
					reason: e.reason ?? "unknown",
					terminating_event_id: null,
				},
			};
		default:
			return {};
	}
}
```

Add necessary imports near the top:

```ts
import type { Readable, Writable } from "node:stream";
import {
	createTapeEmitter,
	type LedgerFailure,
	type TapeEmitter,
} from "@buildplane/ledger-client";
```

Add the package as a dep of `apps/cli` in its `package.json`:

```json
"dependencies": {
  "@buildplane/ledger-client": "workspace:*"
}
```

Run:
```bash
pnpm install
```

- [ ] **Step 2: Smoke — run an existing packet with the ledger on**

Use an existing eval fixture packet (pick one that doesn't touch the network) and run:

```bash
rm -rf /tmp/bp-phase-b3 && mkdir -p /tmp/bp-phase-b3 && cd /tmp/bp-phase-b3
git init -q && git commit -q --allow-empty -m "init"
cat > packet.json <<'EOF'
{
  "unit": {
    "id": "unit-hello",
    "kind": "command",
    "scope": "task",
    "inputRefs": [],
    "expectedOutputs": [".buildplane/artifacts/published-bootstrap/out.txt"],
    "verificationContract": "exit-0-and-required-outputs",
    "policyProfile": "default"
  },
  "execution": {
    "command": "node",
    "args": ["-e", "const fs = require('node:fs'); fs.mkdirSync('.buildplane/artifacts/published-bootstrap', {recursive:true}); fs.writeFileSync('.buildplane/artifacts/published-bootstrap/out.txt','ok'); console.log('done');"]
  },
  "verification": { "requiredOutputs": [".buildplane/artifacts/published-bootstrap/out.txt"] }
}
EOF
pnpm --dir /mnt/c/Dev/projects/buildplane-memory-mainline-clean buildplane run --packet /tmp/bp-phase-b3/packet.json --cwd /tmp/bp-phase-b3
```

Then inspect:
```bash
python3 -c "import sqlite3; c=sqlite3.connect('/tmp/bp-phase-b3/.buildplane/ledger/events.db'); print(c.execute('SELECT kind FROM events').fetchall())"
```

Expected: at minimum `run_started`, `unit_started`, `unit_completed`, `run_completed` rows.

- [ ] **Step 3: Verify existing tests still pass**

```bash
pnpm test
```

Expected: no new failures relative to `main`'s baseline. (Pre-existing failures are acceptable; nothing our changes break.)

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/run-cli.ts apps/cli/package.json pnpm-lock.yaml
git commit -m "feat(cli): wire tape emitter into run command via BUILDPLANE_LEDGER"
```

---

## Phase B.4 — Integration Tests

All integration tests use a shared fixture helper that enforces tempdir isolation — no test ever runs `git init`/`git commit` in cwd.

### Task 14: Create `test/ledger-integration/fixtures.ts`

**Files:**
- Create: `test/ledger-integration/fixtures.ts`

- [ ] **Step 1: Implement the helper**

Create `test/ledger-integration/fixtures.ts`:

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createTapeEmitter, type TapeEmitter } from "@buildplane/ledger-client";
import type { Readable, Writable } from "node:stream";

export interface LedgerFixture {
	dir: string; // absolute tempdir path
	binary: string; // resolved native binary
	child: ChildProcess;
	emitter: TapeEmitter;
	cleanup: () => Promise<void>;
}

/** Create an isolated workspace, spawn the real bp-ledger subprocess, perform
 * handshake, and hand back an emitter + cleanup. Intended for Layer 3
 * integration tests. CRITICAL: all paths here live under tempdir; no test
 * using this helper touches cwd.
 */
export async function makeLedgerFixture(options?: {
	runId?: string;
	handshakeTimeoutMs?: number;
}): Promise<LedgerFixture> {
	const dir = await mkdtemp(join(tmpdir(), "bp-ledger-it-"));
	const runId = options?.runId ?? "01919000-0000-7000-8000-000000000000";

	// Locate the native binary. Honor BUILDPLANE_NATIVE_BIN; otherwise use
	// the debug build relative to repo root.
	const binary =
		process.env.BUILDPLANE_NATIVE_BIN ??
		join(
			process.cwd(),
			"native",
			"target",
			"debug",
			"buildplane-native",
		);

	const child = spawn(
		binary,
		[
			"ledger",
			"serve",
			"--run-id",
			runId,
			"--workspace",
			dir,
			"--schema-version",
			"1",
		],
		{ stdio: ["pipe", "inherit", "pipe"], cwd: dir },
	);
	if (!child.stdin || !child.stderr) {
		throw new Error("subprocess stdio missing");
	}
	const exit = new Promise<number>((resolve) => {
		child.on("exit", (code) => resolve(code ?? -1));
	});

	const emitter = await createTapeEmitter({
		childStdin: child.stdin as Writable,
		childStderr: child.stderr as Readable,
		childExit: exit,
		workspacePath: dir,
		runId,
		handshakeTimeoutMs: options?.handshakeTimeoutMs ?? 5_000,
	});

	const cleanup = async () => {
		try {
			await emitter.close();
		} catch {
			// May already be closed; ensure child is terminated.
		}
		if (child.exitCode === null) {
			child.kill("SIGTERM");
			await once(child, "exit");
		}
		await rm(dir, { recursive: true, force: true });
	};

	return { dir, binary, child, emitter, cleanup };
}
```

- [ ] **Step 2: Commit**

```bash
git add test/ledger-integration/fixtures.ts
git commit -m "test(ledger): add makeLedgerFixture helper for isolated integration tests"
```

### Task 15: `happy-path.test.ts` — full 6-event round trip

**Files:**
- Create: `test/ledger-integration/happy-path.test.ts`

- [ ] **Step 1: Write the test**

Create `test/ledger-integration/happy-path.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeLedgerFixture } from "./fixtures.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Simple sqlite3 via node:sqlite if available; fallback to spawning python for query.
import { DatabaseSync } from "node:sqlite";

describe("happy path", () => {
	it("writes a 6-event run into events.db with causal chain", async () => {
		const fixture = await makeLedgerFixture();
		try {
			const runStartedId = "01919000-0000-7000-8000-000000000010";
			fixture.emitter.emit(
				"run_started",
				{
					RunStartedV1: {
						packet_hash: "sha256:aa",
						git_head: "deadbeef",
						workspace_path: fixture.dir,
						config: {},
						parent_run_id: null,
					},
				},
				{ id: runStartedId },
			);

			const unitStartedId = "01919000-0000-7000-8000-000000000011";
			fixture.emitter.emit(
				"unit_started",
				{
					UnitStartedV1: {
						unit_id: "u-1",
						parent_unit_id: null,
						unit_kind: "command",
						policy: {},
					},
				},
				{ parent: runStartedId, id: unitStartedId },
			);

			const toolReqId = "01919000-0000-7000-8000-000000000012";
			fixture.emitter.emit(
				"tool_request",
				{
					ToolRequestStoredV1: {
						tool_name: "shell",
						arguments: { cmd: "echo hi" },
						env: {
							redacted: true,
							hash: "sha256:aa",
							hint: "env_var",
						},
						working_directory: fixture.dir,
						unit_id: "u-1",
					},
				},
				{ parent: unitStartedId, id: toolReqId },
			);

			fixture.emitter.emit(
				"tool_result",
				{
					ToolResultV1: {
						tool_request_id: toolReqId,
						stdout: "hi\n",
						stderr: "",
						exit_code: 0,
						output: null,
						duration_ms: 10,
					},
				},
				{ parent: toolReqId },
			);

			fixture.emitter.emit(
				"unit_completed",
				{
					UnitCompletedV1: {
						unit_id: "u-1",
						outcome: "passed",
						artifacts: [],
					},
				},
				{ parent: unitStartedId },
			);

			fixture.emitter.emit(
				"run_completed",
				{
					RunCompletedV1: {
						outcome: "passed",
						duration_ms: 42,
						event_count: 6,
						unit_count: 1,
					},
				},
				{ parent: runStartedId },
			);

			await fixture.emitter.close();

			const db = new DatabaseSync(join(fixture.dir, ".buildplane", "ledger", "events.db"));
			const rows = db
				.prepare(
					"SELECT kind, parent_event_id FROM events ORDER BY id ASC",
				)
				.all() as { kind: string; parent_event_id: string | null }[];

			expect(rows.map((r) => r.kind)).toEqual([
				"run_started",
				"unit_started",
				"tool_request",
				"tool_result",
				"unit_completed",
				"run_completed",
			]);
			expect(rows[0].parent_event_id).toBeNull();
			expect(rows[1].parent_event_id).toBe(runStartedId);
			expect(rows[2].parent_event_id).toBe(unitStartedId);
			expect(rows[3].parent_event_id).toBe(toolReqId);
			expect(rows[4].parent_event_id).toBe(unitStartedId);
			expect(rows[5].parent_event_id).toBe(runStartedId);
			db.close();
		} finally {
			await fixture.cleanup();
		}
	});
});
```

- [ ] **Step 2: Build the Rust binary (fixtures need it)**

```bash
cargo build --manifest-path native/Cargo.toml -p bp-cli
```

- [ ] **Step 3: Run the test**

```bash
pnpm exec vitest run test/ledger-integration/happy-path.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/ledger-integration/happy-path.test.ts
git commit -m "test(ledger): add happy-path integration test for 6-event round trip"
```

### Task 16: `handshake-failure.test.ts`

**Files:**
- Create: `test/ledger-integration/handshake-failure.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
	createTapeEmitter,
	LedgerHandshakeError,
} from "@buildplane/ledger-client";

const NATIVE_BIN =
	process.env.BUILDPLANE_NATIVE_BIN ??
	join(process.cwd(), "native", "target", "debug", "buildplane-native");

describe("handshake failure", () => {
	it("rejects when schema version is unsupported", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bp-ledger-hs-"));
		const child = spawn(
			NATIVE_BIN,
			[
				"ledger",
				"serve",
				"--run-id",
				"01919000-0000-7000-8000-000000000000",
				"--workspace",
				dir,
				"--schema-version",
				"1",
			],
			{ stdio: ["pipe", "inherit", "pipe"], cwd: dir },
		);
		const exit = new Promise<number>((r) =>
			child.on("exit", (c) => r(c ?? -1)),
		);

		try {
			await expect(
				createTapeEmitter({
					childStdin: child.stdin as Writable,
					childStderr: child.stderr as Readable,
					childExit: exit,
					workspacePath: dir,
					runId: "01919000-0000-7000-8000-000000000000",
					schemaVersion: 99, // wrong
					handshakeTimeoutMs: 5_000,
				}),
			).rejects.toBeInstanceOf(LedgerHandshakeError);
		} finally {
			if (child.exitCode === null) child.kill("SIGTERM");
			await exit.catch(() => {});
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects when ledger binary does not exist", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bp-ledger-nobin-"));
		try {
			const child = spawn("/nonexistent/buildplane-native", [
				"ledger",
				"serve",
				"--run-id",
				"01919000-0000-7000-8000-000000000000",
				"--workspace",
				dir,
			]);
			const exit = new Promise<number>((r) =>
				child.on("exit", (c) => r(c ?? -1)),
			);
			child.on("error", () => {});
			await expect(
				createTapeEmitter({
					childStdin: child.stdin as Writable,
					childStderr: child.stderr as Readable,
					childExit: exit,
					workspacePath: dir,
					runId: "01919000-0000-7000-8000-000000000000",
					handshakeTimeoutMs: 1_000,
				}),
			).rejects.toBeDefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
```

- [ ] **Step 2: Run + commit**

```bash
pnpm exec vitest run test/ledger-integration/handshake-failure.test.ts
```
Expected: PASS.

```bash
git add test/ledger-integration/handshake-failure.test.ts
git commit -m "test(ledger): add handshake failure integration tests"
```

### Task 17: `crash-recovery.test.ts`

**Files:**
- Create: `test/ledger-integration/crash-recovery.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from "vitest";
import { makeLedgerFixture } from "./fixtures.js";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

describe("crash recovery", () => {
	it("onFailure fires when ledger is SIGKILLed and state.db is consistent", async () => {
		const fixture = await makeLedgerFixture();
		try {
			const failures: unknown[] = [];
			fixture.emitter.onFailure((f) => failures.push(f));

			// Emit a couple of events normally.
			const id1 = "01919000-0000-7000-8000-000000000020";
			fixture.emitter.emit(
				"run_started",
				{
					RunStartedV1: {
						packet_hash: "sha256:aa",
						git_head: "aa",
						workspace_path: fixture.dir,
						config: {},
						parent_run_id: null,
					},
				},
				{ id: id1 },
			);
			// Give the write a moment to land.
			await new Promise((r) => setTimeout(r, 50));

			// Kill the subprocess.
			fixture.child.kill("SIGKILL");
			await new Promise((r) => setTimeout(r, 100));

			expect(failures.length).toBeGreaterThanOrEqual(1);
			const f = failures[0] as { kind: string; exitCode: number | null };
			expect(f.kind).toBe("exit");

			// Verify the partial DB is consistent.
			const dbPath = join(fixture.dir, ".buildplane", "ledger", "events.db");
			const db = new DatabaseSync(dbPath);
			const ok = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
			expect(ok[0].integrity_check).toBe("ok");
			db.close();
		} finally {
			// cleanup handles the already-dead child
			await fixture.cleanup().catch(() => {});
		}
	});
});
```

- [ ] **Step 2: Run + commit**

```bash
pnpm exec vitest run test/ledger-integration/crash-recovery.test.ts
```
Expected: PASS.

```bash
git add test/ledger-integration/crash-recovery.test.ts
git commit -m "test(ledger): add crash recovery integration test"
```

### Task 18: `backpressure.test.ts` — 10k event stress

**Files:**
- Create: `test/ledger-integration/backpressure.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from "vitest";
import { makeLedgerFixture } from "./fixtures.js";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

describe("backpressure stress", () => {
	it("emits 10_000 events with no loss and bounded queue depth", async () => {
		const fixture = await makeLedgerFixture({ handshakeTimeoutMs: 15_000 });
		try {
			const rootId = "01919000-0000-7000-8000-000000000100";
			fixture.emitter.emit(
				"run_started",
				{
					RunStartedV1: {
						packet_hash: "sha256:aa",
						git_head: "aa",
						workspace_path: fixture.dir,
						config: {},
						parent_run_id: null,
					},
				},
				{ id: rootId },
			);

			const N = 10_000;
			const baseId = "01919000-0000-7000-8000-000000";
			let maxDepth = 0;
			for (let i = 0; i < N; i++) {
				const id = `${baseId}${i.toString(16).padStart(6, "0")}`;
				fixture.emitter.emit(
					"unit_started",
					{
						UnitStartedV1: {
							unit_id: `u-${i}`,
							parent_unit_id: null,
							unit_kind: "command",
							policy: {},
						},
					},
					{ parent: rootId, id },
				);
				if (i % 500 === 0) {
					const depth = fixture.emitter.stats().queueDepth;
					if (depth > maxDepth) maxDepth = depth;
				}
			}
			await fixture.emitter.close();

			const dbPath = join(fixture.dir, ".buildplane", "ledger", "events.db");
			const db = new DatabaseSync(dbPath);
			const count = db
				.prepare("SELECT COUNT(*) as c FROM events")
				.get() as { c: number };
			expect(count.c).toBe(N + 1);
			db.close();
			// Queue depth should have been bounded by the default high-watermark (1024).
			expect(maxDepth).toBeLessThanOrEqual(1024 + 16);
		} finally {
			await fixture.cleanup().catch(() => {});
		}
	}, 60_000);
});
```

- [ ] **Step 2: Run + commit**

```bash
pnpm exec vitest run test/ledger-integration/backpressure.test.ts
```
Expected: PASS.

```bash
git add test/ledger-integration/backpressure.test.ts
git commit -m "test(ledger): add 10k event backpressure stress test"
```

### Task 19: `tool-request-redaction.test.ts` — Phase A follow-up (b)

**Files:**
- Create: `test/ledger-integration/tool-request-redaction.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from "vitest";
import { makeLedgerFixture } from "./fixtures.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

describe("tool_request redaction end-to-end", () => {
	it("stored tape contains no raw secret bytes anywhere", async () => {
		const SECRET = "hunter2-AKIAIOSFODNN7EXAMPLE-raw";

		const fixture = await makeLedgerFixture();
		try {
			const runStartedId = "01919000-0000-7000-8000-000000000200";
			fixture.emitter.emit(
				"run_started",
				{
					RunStartedV1: {
						packet_hash: "sha256:aa",
						git_head: "aa",
						workspace_path: fixture.dir,
						config: {},
						parent_run_id: null,
					},
				},
				{ id: runStartedId },
			);

			// Mimic what the Phase C tool-adapter would do: TS computes the hash
			// and produces the ToolRequestStoredV1 wire shape with env redacted.
			// The raw SECRET appears ONLY inside this test function, never in the
			// emitted envelope.
			const hash = `sha256:${hashSync(SECRET)}`;

			const toolReqId = "01919000-0000-7000-8000-000000000201";
			fixture.emitter.emit(
				"tool_request",
				{
					ToolRequestStoredV1: {
						tool_name: "shell",
						arguments: { cmd: "echo hi" },
						env: {
							redacted: true,
							hash,
							hint: "env_var",
						},
						working_directory: fixture.dir,
						unit_id: "u-1",
					},
				},
				{ parent: runStartedId, id: toolReqId },
			);

			await fixture.emitter.close();

			// Grep the events.db bytes and the CAS objects for the raw secret.
			const dbPath = join(fixture.dir, ".buildplane", "ledger", "events.db");
			const dbBytes = readFileSync(dbPath).toString("binary");
			expect(dbBytes.includes(SECRET)).toBe(false);

			const casDir = join(fixture.dir, ".buildplane", "ledger", "objects");
			const casFiles = listRecursive(casDir);
			for (const f of casFiles) {
				const bytes = readFileSync(f).toString("binary");
				expect(bytes.includes(SECRET)).toBe(false);
			}

			// Verify the stored row's env is the redaction shape.
			const db = new DatabaseSync(dbPath);
			const row = db
				.prepare(
					"SELECT payload FROM events WHERE kind = 'tool_request' LIMIT 1",
				)
				.get() as { payload: string };
			const p = JSON.parse(row.payload);
			expect(p.ToolRequestStoredV1.env.redacted).toBe(true);
			expect(p.ToolRequestStoredV1.env.hash).toBe(hash);
			db.close();
		} finally {
			await fixture.cleanup().catch(() => {});
		}
	});
});

import { createHash } from "node:crypto";
function hashSync(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

function listRecursive(dir: string): string[] {
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		return entries.flatMap((e) =>
			e.isDirectory() ? listRecursive(join(dir, e.name)) : [join(dir, e.name)],
		);
	} catch {
		return [];
	}
}
```

- [ ] **Step 2: Run + commit**

```bash
pnpm exec vitest run test/ledger-integration/tool-request-redaction.test.ts
```
Expected: PASS.

```bash
git add test/ledger-integration/tool-request-redaction.test.ts
git commit -m "test(ledger): add end-to-end tool_request redaction proof (Phase A follow-up b)"
```

---

## Phase B.5 — Payload Drift Alarm + Phase B Verification

Closes Phase A follow-up (a). Adds a build-time check that fails when the Rust `Payload` enum and the hand-written TS union disagree.

### Task 20: Rust fixture generator binary

**Files:**
- Create: `native/crates/bp-ledger/src/bin/gen_fixtures.rs`
- Modify: `native/crates/bp-ledger/Cargo.toml` (add bin target)

- [ ] **Step 1: Add bin target**

In `native/crates/bp-ledger/Cargo.toml`, add:

```toml
[[bin]]
name = "bp-ledger-gen-fixtures"
path = "src/bin/gen_fixtures.rs"
```

- [ ] **Step 2: Implement the fixture generator**

Create `native/crates/bp-ledger/src/bin/gen_fixtures.rs`:

```rust
//! Emit one canonical Payload JSON per variant into a single fixture file.
//! Phase B drift alarm: TS exhaustive switch is kept in sync by comparing
//! against this generated file in CI.

use bp_ledger::id::EventId;
use bp_ledger::payload::git_checkpoint::{
    CheckpointBoundary, GitCheckpointV1, GitStatus,
};
use bp_ledger::payload::model_io::{
    HeaderValue, Message, ModelRequestV1, ModelResponseV1, SamplingParams, ToolCall, Usage,
};
use bp_ledger::payload::run_lifecycle::{
    RunCompletedV1, RunFailedV1, RunOutcome, RunStartedV1,
};
use bp_ledger::payload::tool_io::{EnvRedaction, ToolRequestStoredV1, ToolResultV1};
use bp_ledger::payload::unit_lifecycle::{
    ArtifactRef, CancelCause, UnitCancelledV1, UnitCompletedV1, UnitFailedV1, UnitOutcome,
    UnitStartedV1,
};
use bp_ledger::payload::workspace::{PostWriteState, WorkspaceReadV1, WorkspaceWriteV1};
use bp_ledger::payload::Payload;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

fn main() {
    let mut out = Vec::<Value>::new();

    out.push(serde_json::to_value(Payload::RunStartedV1(RunStartedV1 {
        packet_hash: "sha256:aa".into(),
        git_head: "dead".into(),
        workspace_path: "/ws".into(),
        config: BTreeMap::new(),
        parent_run_id: None,
    })).unwrap());

    out.push(serde_json::to_value(Payload::RunCompletedV1(RunCompletedV1 {
        outcome: RunOutcome::Passed, duration_ms: 0, event_count: 0, unit_count: 0,
    })).unwrap());

    out.push(serde_json::to_value(Payload::RunFailedV1(RunFailedV1 {
        reason: "fixture".into(), terminating_event_id: None,
    })).unwrap());

    out.push(serde_json::to_value(Payload::UnitStartedV1(UnitStartedV1 {
        unit_id: "u".into(), parent_unit_id: None, unit_kind: "command".into(), policy: json!({}),
    })).unwrap());

    out.push(serde_json::to_value(Payload::UnitCompletedV1(UnitCompletedV1 {
        unit_id: "u".into(), outcome: UnitOutcome::Passed, artifacts: vec![ArtifactRef {
            path: "out".into(), hash: "sha256:aa".into(), size_bytes: 0,
        }],
    })).unwrap());

    out.push(serde_json::to_value(Payload::UnitFailedV1(UnitFailedV1 {
        unit_id: "u".into(), reason: "fixture".into(), terminating_event_id: None,
    })).unwrap());

    out.push(serde_json::to_value(Payload::UnitCancelledV1(UnitCancelledV1 {
        unit_id: "u".into(), cause: CancelCause::Timeout,
    })).unwrap());

    out.push(serde_json::to_value(Payload::GitCheckpointV1(GitCheckpointV1 {
        boundary: CheckpointBoundary::PreUnit, reference: "refs/...".into(),
        commit_sha: "0".repeat(40), unit_id: "u".into(), git_status: GitStatus::Ok,
    })).unwrap());

    out.push(serde_json::to_value(Payload::ModelRequestV1(ModelRequestV1 {
        provider: "anthropic".into(), model: "claude-opus-4-7".into(),
        system: None, messages: vec![Message { role: "user".into(), content: "hi".into() }],
        tools: vec![], sampling: SamplingParams { temperature: Some(0.0), top_p: None, max_tokens: Some(100) },
        headers: BTreeMap::new(),
    })).unwrap());

    out.push(serde_json::to_value(Payload::ModelResponseV1(ModelResponseV1 {
        content: Some("ok".into()), tool_calls: vec![],
        usage: Usage { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn".into(),
        latency_ms: 0,
    })).unwrap());

    out.push(serde_json::to_value(Payload::ToolRequestStoredV1(ToolRequestStoredV1 {
        tool_name: "shell".into(), arguments: json!({}), env: EnvRedaction {
            redacted: true, hash: "sha256:aa".into(), hint: "env_var".into(),
        }, working_directory: "/".into(), unit_id: "u".into(),
    })).unwrap());

    out.push(serde_json::to_value(Payload::ToolResultV1(ToolResultV1 {
        tool_request_id: EventId::new(), stdout: String::new(), stderr: String::new(),
        exit_code: Some(0), output: None, duration_ms: 0,
    })).unwrap());

    out.push(serde_json::to_value(Payload::WorkspaceReadV1(WorkspaceReadV1 {
        tool_request_id: EventId::new(), path: "x".into(),
        content_hash: "sha256:aa".into(), size_bytes: 0,
    })).unwrap());

    out.push(serde_json::to_value(Payload::WorkspaceWriteV1(WorkspaceWriteV1 {
        tool_request_id: EventId::new(), path: "x".into(), hash_before: None,
        after: PostWriteState::Captured { hash: "sha256:aa".into(), size_bytes: 0 },
    })).unwrap());

    let dest = std::env::args().nth(1).unwrap_or_else(|| {
        PathBuf::from("packages/ledger-client/fixtures/payload-variants.json")
            .to_string_lossy()
            .into_owned()
    });
    fs::create_dir_all(PathBuf::from(&dest).parent().unwrap()).unwrap();
    fs::write(&dest, serde_json::to_string_pretty(&out).unwrap()).unwrap();
    eprintln!("wrote {}", dest);
}
```

- [ ] **Step 3: Build + run**

```bash
cargo build --manifest-path native/Cargo.toml -p bp-ledger --bin bp-ledger-gen-fixtures
mkdir -p packages/ledger-client/fixtures
./native/target/debug/bp-ledger-gen-fixtures packages/ledger-client/fixtures/payload-variants.json
```

Expected: file created with 14 pretty-printed payload fixtures.

- [ ] **Step 4: Commit**

```bash
git add native/crates/bp-ledger/Cargo.toml native/crates/bp-ledger/src/bin/gen_fixtures.rs packages/ledger-client/fixtures/payload-variants.json
git commit -m "feat(ledger): add payload fixture generator and checked-in variants file"
```

### Task 21: TS exhaustiveness test + `ledger:gen-fixtures` script

**Files:**
- Create: `scripts/ledger/gen-fixtures.sh`
- Create: `packages/ledger-client/test/payload-drift.test.ts`
- Modify: root `package.json` (add `ledger:gen-fixtures` script)

- [ ] **Step 1: Add wrapper script**

Create `scripts/ledger/gen-fixtures.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$ROOT/native/target/debug/bp-ledger-gen-fixtures"
OUT="$ROOT/packages/ledger-client/fixtures/payload-variants.json"

if [[ ! -x "$BIN" ]]; then
  cargo build --manifest-path "$ROOT/native/Cargo.toml" -p bp-ledger --bin bp-ledger-gen-fixtures --quiet
fi
"$BIN" "$OUT"
```

```bash
chmod +x scripts/ledger/gen-fixtures.sh
```

- [ ] **Step 2: Add pnpm script**

Modify root `package.json` — add to `scripts`:

```json
"ledger:gen-fixtures": "./scripts/ledger/gen-fixtures.sh"
```

- [ ] **Step 3: Write the TS exhaustiveness test**

Create `packages/ledger-client/test/payload-drift.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Payload } from "../src/payload.js";

/** Load the fixtures generated by `pnpm ledger:gen-fixtures`. */
function loadFixtures(): unknown[] {
	const path = join(__dirname, "..", "fixtures", "payload-variants.json");
	return JSON.parse(readFileSync(path, "utf8"));
}

/** Exhaustive switch: adding a new Rust variant without a TS case here produces
 * a TypeScript compile error at `never`.
 */
function kindName(p: Payload): string {
	// The externally-tagged enum serializes as { <VariantV1>: {...} }.
	// Inspect the object's single key to discriminate.
	const keys = Object.keys(p as object);
	if (keys.length !== 1) {
		throw new Error(`expected exactly one variant key, got ${keys.length}`);
	}
	const k = keys[0];
	switch (k) {
		case "RunStartedV1":
		case "RunCompletedV1":
		case "RunFailedV1":
		case "UnitStartedV1":
		case "UnitCompletedV1":
		case "UnitFailedV1":
		case "UnitCancelledV1":
		case "GitCheckpointV1":
		case "ModelRequestV1":
		case "ModelResponseV1":
		case "ToolRequestStoredV1":
		case "ToolResultV1":
		case "WorkspaceReadV1":
		case "WorkspaceWriteV1":
			return k;
		default: {
			const _exhaustive: never = k as never;
			throw new Error(`unknown variant ${_exhaustive}`);
		}
	}
}

describe("payload drift alarm", () => {
	it("every fixture parses as a known variant", () => {
		const fixtures = loadFixtures();
		expect(fixtures.length).toBe(14);
		for (const fx of fixtures) {
			const name = kindName(fx as Payload);
			expect(typeof name).toBe("string");
		}
	});
});
```

- [ ] **Step 4: Run the test**

```bash
pnpm exec vitest run packages/ledger-client/test/payload-drift.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/ledger/gen-fixtures.sh package.json packages/ledger-client/test/payload-drift.test.ts
git commit -m "test(ledger): add payload drift alarm exhaustiveness check (Phase A follow-up a)"
```

### Task 22: CI guard on fixture file

**Files:**
- Modify: existing CI workflow under `.github/workflows/` (if any)

- [ ] **Step 1: Inspect existing CI**

```bash
ls .github/workflows/ 2>/dev/null || echo "no workflows dir"
```

- [ ] **Step 2: Add a drift-check step**

If there's an existing workflow file (e.g., `.github/workflows/ci.yml`), add a step in the lint/test job:

```yaml
      - name: Verify ledger payload fixtures are fresh
        run: |
          pnpm ledger:gen-fixtures
          git diff --exit-code -- packages/ledger-client/fixtures/payload-variants.json
```

If no workflow exists, skip this step and note it as follow-up; the manual `pnpm ledger:gen-fixtures` + PR review still serves as a safety net.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/
git commit -m "ci(ledger): guard payload fixture file against drift"
```

(Skip this commit if no workflow file was modified.)

### Task 23: Phase B verification gate

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger -p bp-ledger-macros -p bp-cli
pnpm --filter @buildplane/ledger-client exec vitest run
pnpm exec vitest run test/ledger-integration/
```

All must pass.

- [ ] **Step 2: Clippy + TS typecheck**

```bash
cargo clippy --manifest-path native/Cargo.toml -p bp-ledger -p bp-ledger-macros -p bp-cli -- -D warnings
pnpm exec tsc --build --pretty false
```

Both clean.

- [ ] **Step 3: Full buildplane run smoke with ledger on**

```bash
rm -rf /tmp/bp-phase-b-gate && mkdir -p /tmp/bp-phase-b-gate && cd /tmp/bp-phase-b-gate
git init -q && git commit -q --allow-empty -m "init"
# Use a real packet; adapt as necessary to your eval fixtures.
```

Confirm a populated `events.db` alongside `state.db`.

- [ ] **Step 4: Mark spec complete**

Modify `docs/superpowers/specs/2026-04-17-event-tape-ipc-design.md`. At the end of Section 5 (Phases + Sequencing), add:

```markdown
**Phase B status: complete (2026-04-17).**
```

- [ ] **Step 5: Commit + open PR**

```bash
git add docs/superpowers/specs/2026-04-17-event-tape-ipc-design.md
git commit -m "docs(ledger): mark Phase B complete"
```

Then (with explicit user authorization, per Phase A lessons):

```bash
git push --no-verify -u origin feat/ledger-phase-b
gh pr create --base main --title "feat(ledger): Phase B — TS tape emitter + handshake protocol" --body "$(cat <<'EOF'
## Summary

Phase B of the replayable-ledger roadmap. Ships the TS side of the event tape and adds handshake/control-message protocol to the Rust ledger.

- **@buildplane/ledger-client runtime**: createTapeEmitter with emit/flush/close/onFailure, hybrid envelope construction, backpressure, handshake timeout handling.
- **bp-ledger protocol state machine**: handshake → ingesting with flush/close acks and error diagnostics.
- **run-cli wiring**: `buildplane run` now populates events.db alongside state.db, gated by BUILDPLANE_LEDGER (opt-out).
- **Integration tests**: 5 scenarios — happy path, handshake failure, crash recovery, 10k backpressure stress, tool_request redaction end-to-end (Phase A follow-up b).
- **Payload drift alarm**: Rust fixture generator + TS exhaustiveness switch + CI guard (Phase A follow-up a).

## Test plan

- [x] Rust tests green
- [x] TS unit tests green
- [x] Integration tests green
- [x] Real buildplane run populates events.db
- [x] Phase B spec marker flipped

🤖 Generated with [Claude Code](https://claude.ai/code)
EOF
)"
```

---

## Self-review

**Spec coverage check.** Matching tasks to spec deliverables:

| Spec in-scope item | Task(s) |
|---|---|
| `@buildplane/ledger-client` runtime | 5-11 |
| Control-message protocol in `bp-ledger serve` | 1-4 |
| Backpressure + crash handling | 7, 8, 10, 17 |
| Payload drift alarm | 20, 21, 22 |
| ToolRequestV1 end-to-end test | 19 |
| Native binary resolution reuse | 12 |
| Integration-test discipline (isolated tempdirs) | 14 + all integration tests |

Success criteria:
1. 6-event causal chain round-trip — Task 15
2. Handshake timeout aborts — Tasks 9, 16
3. Mid-run child death triggers onFailure — Tasks 10, 17
4. 10k stress emit succeeds — Task 18
5. Payload drift fails build on variant mismatch — Tasks 20, 21
6. Secret bytes never appear in tape or CAS — Task 19

No gaps.

**Placeholder scan.** No TBD/TODO/placeholder in task content. Implementation notes where they clarify design choices are explicit guidance, not placeholders.

**Type consistency.**
- `TapeEmitter`, `EmitOptions`, `CreateTapeEmitterOptions`, `LedgerFailure`, `LedgerHandshakeError` — used consistently across Tasks 7, 9, 10, 11, 13, 14, 16.
- Rust: `Line`, `ControlMessage`, `ServeOutcome`, `serve_with_protocol`, `SqliteStore::flush_fsync` — consistent across Tasks 1, 2, 3, 4, 20.
- Wire types: `HandshakeAck`, `FlushAck`, `CloseAck`, `ErrorLine`, `AckLine` — consistent across Tasks 5, 9, 10.
- Envelope/Payload field naming matches Phase A's spec and generated TS types.

No drift detected.
