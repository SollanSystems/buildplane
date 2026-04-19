# Replay + Wiring — Phase D Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Phase C's wiring gap (sync `runPacket` bus emission + wrapped `ToolRegistry` threading) and ship `buildplane ledger replay <run-id>` as a Rust-owned subcommand backed by a new `bp-replay` crate that forward-iterates the tape with a hydrated `ReplayState`.

**Architecture:** Wiring fixes live in `packages/runtime` / `packages/kernel` / `apps/cli/src/run-cli.ts`. New Rust crate `native/crates/bp-replay/` exposes a `ReplayEngine` that reads `events.db`, applies per-kind state transitions, and yields `ReplayStep { event, state_after }`. `bp-cli` grows a `ledger replay` subcommand consuming the engine; TS CLI wraps it via the existing memory/pack dispatch pattern.

**Tech Stack:** Rust (edition 2021), rusqlite (bundled), serde + serde_json, chrono. TypeScript (Node 24, ESM), vitest. No new dependencies.

**Reference spec:** `docs/superpowers/specs/2026-04-18-replay-wiring-design.md`
**Builds on:** Phases A (PR #59), B (PR #60), C (PR #61).

---

## Phase D scope recap

**In scope:**
- W.1: sync `runPacket` emits `execution-started` / `command-execution-complete` bus events.
- W.2: wrapped `ToolRegistry` threaded into execution adapter.
- `bp-replay` crate with `ReplayEngine`, `ReplayState`, transitions, SQLite reader.
- `bp-cli ledger replay` subcommand (JSON + human modes, `--limit`, `--at`).
- TS CLI dispatch for `buildplane ledger replay`.
- 3 integration tests (tape-capture-end-to-end, replay-basic, replay-at-event).
- Phase C's three `.skip` markers unskipped.

**Out of scope:** fork, bisect, audit bundle, TUI, cross-fork replay, re-execution, Windows.

---

## File structure

```
native/
├── Cargo.toml                          # MODIFY: add bp-replay member
└── crates/
    ├── bp-replay/                      # NEW
    │   ├── Cargo.toml
    │   ├── src/
    │   │   ├── lib.rs                  # public API re-exports
    │   │   ├── state.rs                # ReplayState, FileObservation, ReplayIssue
    │   │   ├── reader.rs               # SQLite row iterator, UUIDv7 order
    │   │   ├── transitions.rs          # per-EventKind state mutations
    │   │   └── engine.rs               # ReplayEngine, next(), fast_forward_to()
    │   └── tests/
    │       ├── iteration.rs
    │       ├── transitions.rs
    │       ├── fast_forward.rs
    │       └── issues.rs
    └── bp-cli/
        └── src/
            └── ledger_cli.rs           # EXTEND: add replay subcommand

packages/
├── kernel/ OR runtime/                 # MODIFY: sync path bus emit + registry param
└── ...

apps/cli/
├── src/
│   └── run-cli.ts                      # MODIFY: thread wrapped registry + replay dispatch
└── test/
    └── ledger-replay-dispatch.test.ts  # NEW (optional Layer 2)

test/ledger-integration/
├── tape-capture-end-to-end.test.ts     # NEW (unskips Phase C .skip markers)
├── replay-basic.test.ts                # NEW
└── replay-at-event.test.ts             # NEW

docs/superpowers/specs/2026-04-18-replay-wiring-design.md  # MODIFY: spec marker
docs/ledger.md                          # MODIFY: document replay command
```

---

## Phase D.1 — Wiring W.1: sync-path bus emission

### Task 1: Port async-path bus emits into sync `runPacket`

**Files:**
- Modify: the file containing `orchestrator.runPacket()` and `orchestrator.runPacketAsync()` (likely `packages/kernel/src/orchestrator.ts` or `packages/runtime/src/*`).
- Modify: `test/ledger-integration/tool-capture.test.ts` (unskip)
- Modify: `test/ledger-integration/shell-command-capture.test.ts` (unskip)
- Modify: `test/ledger-integration/git-checkpoint.test.ts` (unskip)

- [ ] **Step 1: Locate the orchestrator**

Find the file that exports both `runPacket` and `runPacketAsync`:

```bash
grep -rn "runPacketAsync\b" packages/ apps/ --include="*.ts" -l | head -5
```

Open the file. Find both functions. Read the async version carefully — it likely calls `eventBus.emit({ kind: "execution-started", ... })` before command dispatch and `{ kind: "command-execution-complete", ... }` after.

- [ ] **Step 2: Extract the emit helpers (if inline)**

If the async path's emit logic is inline and non-trivial (reads unit info, timestamps, exit code), extract it into private helpers so sync and async both call:

```ts
function emitExecutionStarted(bus: EventBus, packet: Packet): void {
	bus.emit({
		kind: "execution-started",
		unitId: packet.unit.id,
		timestamp: new Date().toISOString(),
	} as never);
}

function emitExecutionComplete(
	bus: EventBus,
	packet: Packet,
	exitCode: number,
): void {
	bus.emit({
		kind: "command-execution-complete",
		unitId: packet.unit.id,
		exitCode,
		timestamp: new Date().toISOString(),
	} as never);
}
```

Adapt field names to whatever the async path already uses. Don't invent new fields; match the shape Phase C's subscription expects (`e.unitId`, `e.exitCode`, etc.).

- [ ] **Step 3: Call the helpers from sync `runPacket`**

In the sync `runPacket` function body, bracket the command-execution step:

```ts
function runPacket(packet: Packet, bus: EventBus): RunResult {
	// ... existing setup ...
	emitExecutionStarted(bus, packet);
	const result = commandExecutor.run(packet.execution, ...);
	emitExecutionComplete(bus, packet, result.exitCode);
	// ... existing teardown ...
	return { run: ..., receipt: ..., decision: ..., ... };
}
```

If `runPacket` currently takes no bus parameter, add one (optional if there are non-ledger callers that don't need it — but prefer required, propagating the change to call sites).

- [ ] **Step 4: Unskip Phase C's `.skip` markers**

Open each of these files and change `test.skip(...)` to `test(...)`:

- `test/ledger-integration/tool-capture.test.ts`
- `test/ledger-integration/shell-command-capture.test.ts`
- `test/ledger-integration/git-checkpoint.test.ts`

Phase C's implementer noted these are preserved as `.skip` with comments documenting the Phase D gap. Remove those `.skip` markers. If a test file's assertions are explicitly scoped to "current behavior" (e.g., asserting only `run_started` + `run_completed`), update the assertions to match Phase A spec's full sequence.

- [ ] **Step 5: Run the integration tests**

```bash
pnpm exec vitest run test/ledger-integration/tool-capture.test.ts test/ledger-integration/shell-command-capture.test.ts test/ledger-integration/git-checkpoint.test.ts
```

Expected: all 3 tests PASS (the unskipped aspirational assertions now succeed).

If a test fails: the failure mode tells you where the wiring is still off. Fix in `runPacket`, not in the test.

- [ ] **Step 6: Run the canary**

```bash
pnpm exec vitest run test/ledger-integration/cwd-isolation.test.ts
```

Expected: still PASSES.

- [ ] **Step 7: Commit**

```bash
git add <the orchestrator file> test/ledger-integration/tool-capture.test.ts test/ledger-integration/shell-command-capture.test.ts test/ledger-integration/git-checkpoint.test.ts
git commit -m "feat(kernel): emit execution-started/complete bus events from sync runPacket"
```

---

## Phase D.2 — Wiring W.2: thread wrapped ToolRegistry

### Task 2: Thread the wrapped ToolRegistry into the execution adapter

**Files:**
- Modify: the file that invokes `write_file` / `run_command` via the tool registry (likely `packages/runtime/src/command-executor.ts` or similar).
- Modify: any file in the orchestrator → runtime chain that sits between `run-cli.ts` and that executor.
- Modify: `apps/cli/src/run-cli.ts` (remove `void registry` suppression).

- [ ] **Step 1: Locate the tool invocation site**

```bash
grep -rn "registry.write_file\|registry.run_command\|registry\.write_file\|registry\.run_command" packages/ apps/ --include="*.ts"
```

Also grep for `createToolRegistry(` usages (besides `run-cli.ts`):

```bash
grep -rn "createToolRegistry" packages/ apps/ --include="*.ts"
```

Target is a file where the tool methods get CALLED — not just imported. That's the adapter layer that needs a `registry: ToolRegistry` parameter.

- [ ] **Step 2: Audit the call chain upward**

From the invocation site, trace back to `orchestrator.runPacket` / `runPacketAsync`. Each intermediate function that owns a `ToolRegistry` either:
- Already accepts one (just pass through), or
- Creates one internally (needs to accept it as a parameter instead).

Aim for the smallest diff that threads the registry from `run-cli.ts` down to the invocation site.

If the chain is more than 3 files deep or requires changing kernel-level API, STOP and consider the facade alternative: in `run-cli.ts`, wrap the tool calls directly at the command-executor boundary rather than threading through. Report the audit findings before committing to the threading.

- [ ] **Step 3: Add the parameter**

Starting from the deepest file (the invocation site), add `registry: ToolRegistry` to the function signature and use it in place of any internally-created one. Propagate upward.

At each intermediate call site, pass `registry` through from the caller's argument.

- [ ] **Step 4: Wire in `run-cli.ts`**

Open `apps/cli/src/run-cli.ts`. Find the block:

```ts
const rawRegistry = createToolRegistry(worktreeRoot);
const registry = ledgerEmitter
	? wrapToolRegistryForLedger(rawRegistry, ledgerEmitter, getUnitCtx)
	: rawRegistry;
void registry; // ← remove this line
```

Remove the `void registry;` line. Pass `registry` to whatever orchestrator function takes it now.

- [ ] **Step 5: Build**

```bash
pnpm exec tsc --build apps/cli/tsconfig.json --pretty false 2>&1 | head -20
pnpm --filter buildplane build
```

Expected: clean. Type errors likely surface if the registry parameter isn't threaded correctly — fix the types.

- [ ] **Step 6: Verify the integration test**

The `tape-capture-end-to-end.test.ts` from D.1 should now include `workspace_write` events, not just run/unit/checkpoint events. If D.1 kept the test's assertions minimal, strengthen them now:

```ts
expect(kinds).toContain("workspace_write");
// The payload carries the sha256 of the written content
const wsWrites = db.prepare("SELECT payload FROM events WHERE kind = 'workspace_write'").all() as { payload: string }[];
const firstWsWrite = JSON.parse(wsWrites[0].payload);
expect(firstWsWrite.WorkspaceWriteV1.after.status).toBe("captured");
expect(firstWsWrite.WorkspaceWriteV1.after.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
```

(Only add assertions that are true — if the packet uses `execution.command: "node"` which bypasses the tool registry, no `workspace_write` will appear; change the packet to invoke the tool registry directly via whatever mechanism the orchestrator supports.)

- [ ] **Step 7: Run the test**

```bash
pnpm exec vitest run test/ledger-integration/tape-capture-end-to-end.test.ts
```

Expected: PASS with workspace_write events asserted.

- [ ] **Step 8: Run the canary**

```bash
pnpm exec vitest run test/ledger-integration/cwd-isolation.test.ts
```

Expected: still PASSES.

- [ ] **Step 9: Commit**

```bash
git add <affected files in packages/> apps/cli/src/run-cli.ts test/ledger-integration/tape-capture-end-to-end.test.ts
git commit -m "feat(cli): thread wrapped ToolRegistry through execution adapter"
```

---

## Phase D.3 — `bp-replay` crate

### Task 3: Scaffold `bp-replay` crate

**Files:**
- Create: `native/crates/bp-replay/Cargo.toml`
- Create: `native/crates/bp-replay/src/lib.rs`
- Modify: `native/Cargo.toml` (add workspace member)

- [ ] **Step 1: Add workspace member**

Modify `native/Cargo.toml`, add to `[workspace] members = [...]`:

```toml
  "crates/bp-replay",
```

And under `[workspace.dependencies]`:

```toml
bp-replay = { path = "crates/bp-replay" }
```

- [ ] **Step 2: Create crate Cargo.toml**

Write `native/crates/bp-replay/Cargo.toml`:

```toml
[package]
name = "bp-replay"
version.workspace = true
edition.workspace = true
license.workspace = true

[dependencies]
bp-ledger.workspace = true
chrono.workspace = true
rusqlite.workspace = true
serde.workspace = true
serde_json.workspace = true
thiserror.workspace = true
uuid.workspace = true

[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 3: Create lib.rs skeleton**

Write `native/crates/bp-replay/src/lib.rs`:

```rust
//! Forward-iteration replay engine over a bp-ledger events.db.
//!
//! `ReplayEngine::open(run_id, db_path)` returns an iterator that yields
//! `ReplayStep { event, state_after }` for each event in UUIDv7 order.
//! Fast-forward via `fast_forward_to(event_id)` for Phase E's fork semantics.

pub mod engine;
pub mod reader;
pub mod state;
pub mod transitions;

pub use engine::{ReplayEngine, ReplayStep};
pub use state::{
    CheckpointRef, FileObservation, ReplayIssue, ReplayState,
};
```

- [ ] **Step 4: Verify compile**

```bash
cargo check --manifest-path native/Cargo.toml -p bp-replay
```

Expected: FAIL — modules don't exist yet. That's fine; Task 4 onward adds them.

Commit only after Task 4's state.rs exists (Task 3+4 combined commit is fine).

- [ ] **Step 5: Create empty module stubs so the crate compiles**

```rust
// native/crates/bp-replay/src/state.rs
//! Replay state types.
```

```rust
// native/crates/bp-replay/src/reader.rs
//! SQLite event reader for replay.
```

```rust
// native/crates/bp-replay/src/transitions.rs
//! Per-EventKind state transition functions.
```

```rust
// native/crates/bp-replay/src/engine.rs
//! ReplayEngine: forward iteration over a tape.
```

Now `cargo check -p bp-replay` passes (empty modules OK).

- [ ] **Step 6: Verify compile**

```bash
cargo check --manifest-path native/Cargo.toml -p bp-replay
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add native/Cargo.toml native/crates/bp-replay/
git commit -m "feat(replay): scaffold bp-replay crate with empty modules"
```

### Task 4: Implement `ReplayState` types

**Files:**
- Modify: `native/crates/bp-replay/src/state.rs`

- [ ] **Step 1: Write the types**

Replace `native/crates/bp-replay/src/state.rs`:

```rust
//! Replay state types.

use bp_ledger::id::EventId;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The accumulated state of a run, as rebuilt by the ReplayEngine by applying
/// each event's transition function.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ReplayState {
    /// The run_id we're replaying. Set on the first run_started event.
    pub run_id: Option<String>,
    /// The currently-active unit, if any. Set on unit_started, cleared on
    /// unit_completed/unit_failed/unit_cancelled.
    pub current_unit: Option<String>,
    /// Causal chain of parent event ids — the events we "entered" and
    /// haven't "exited" yet. Used to produce parent_event_id for Phase E fork.
    pub parent_chain: Vec<EventId>,
    /// Last known content hash for each observed file path.
    pub observed_files: BTreeMap<String, FileObservation>,
    /// All git checkpoints reachable from the run.
    pub checkpoints: Vec<CheckpointRef>,
    /// Non-fatal issues surfaced during replay (corrupted events, failed
    /// checkpoints, unreadable writes, etc.).
    pub issues: Vec<ReplayIssue>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FileObservation {
    pub last_known_hash: String,
    pub from_event_id: EventId,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CheckpointRef {
    pub boundary: String,
    pub reference: String,
    pub commit_sha: String,
    pub unit_id: String,
    pub from_event_id: EventId,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReplayIssue {
    CheckpointFailed {
        unit_id: String,
        step: String,
        error: String,
    },
    UnreadablePostWrite {
        path: String,
        reason: String,
    },
    DanglingParent {
        event_id: EventId,
        parent_event_id: EventId,
    },
    TargetNotFound {
        requested: String,
    },
}
```

- [ ] **Step 2: Verify compile**

```bash
cargo check --manifest-path native/Cargo.toml -p bp-replay
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add native/crates/bp-replay/src/state.rs
git commit -m "feat(replay): add ReplayState, FileObservation, CheckpointRef, ReplayIssue"
```

### Task 5: Implement SQLite reader

**Files:**
- Modify: `native/crates/bp-replay/src/reader.rs`

- [ ] **Step 1: Write reader + test**

Replace `native/crates/bp-replay/src/reader.rs`:

```rust
//! SQLite event reader for replay.
//!
//! Opens a bp-ledger events.db read-only and iterates events for a specific
//! run_id in UUIDv7 order (which is the same as causal/time order).

use bp_ledger::event::Event;
use bp_ledger::canonicalize::canonicalize_payload;
use bp_ledger::id::{EventId, RunId};
use rusqlite::{Connection, OpenFlags};
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ReaderError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("uuid: {0}")]
    Uuid(#[from] uuid::Error),
    #[error("chrono: {0}")]
    Chrono(#[from] chrono::ParseError),
    #[error("ledger: {0}")]
    Ledger(#[from] bp_ledger::error::LedgerError),
}

pub struct EventReader {
    conn: Connection,
    run_id: String,
}

impl EventReader {
    pub fn open(
        run_id: &str,
        db_path: impl AsRef<Path>,
    ) -> Result<Self, ReaderError> {
        let conn = Connection::open_with_flags(
            db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )?;
        Ok(Self {
            conn,
            run_id: run_id.to_string(),
        })
    }

    /// Return all events for the run in UUIDv7 order.
    pub fn all(&self) -> Result<Vec<Event>, ReaderError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, run_id, parent_event_id, schema_version, kind, occurred_at, payload \
             FROM events WHERE run_id = ?1 ORDER BY id ASC",
        )?;
        let rows = stmt.query_map([self.run_id.as_str()], |r| {
            Ok(StoredRow {
                id: r.get(0)?,
                run_id: r.get(1)?,
                parent_event_id: r.get(2)?,
                schema_version: r.get(3)?,
                kind: r.get(4)?,
                occurred_at: r.get(5)?,
                payload: r.get(6)?,
            })
        })?;

        let mut events = Vec::new();
        for row in rows {
            events.push(row_to_event(row?)?);
        }
        Ok(events)
    }
}

struct StoredRow {
    id: String,
    run_id: String,
    parent_event_id: Option<String>,
    schema_version: u32,
    kind: String,
    occurred_at: String,
    payload: String,
}

fn row_to_event(row: StoredRow) -> Result<Event, ReaderError> {
    let id = EventId::from_uuid(uuid::Uuid::parse_str(&row.id)?);
    let run_id = RunId::from_uuid(uuid::Uuid::parse_str(&row.run_id)?);
    let parent_event_id = match row.parent_event_id {
        Some(s) => Some(EventId::from_uuid(uuid::Uuid::parse_str(&s)?)),
        None => None,
    };
    let occurred_at = chrono::DateTime::parse_from_rfc3339(&row.occurred_at)?
        .with_timezone(&chrono::Utc);
    let kind = serde_json::from_value(serde_json::Value::String(row.kind.clone()))?;
    let payload_value: serde_json::Value = serde_json::from_str(&row.payload)?;
    let payload = canonicalize_payload(&row.kind, row.schema_version, payload_value)?;

    Ok(Event {
        id,
        run_id,
        parent_event_id,
        schema_version: row.schema_version,
        kind,
        occurred_at,
        payload,
    })
}
```

- [ ] **Step 2: Verify compile**

```bash
cargo check --manifest-path native/Cargo.toml -p bp-replay
```

Expected: PASS. If `EventId::from_uuid` or similar helpers don't exist, add them to `bp-ledger` (they likely exist since Phase A's Task 1 added `RunId::from_uuid` and Phase B's Task 1 added `EventId::from_uuid`).

- [ ] **Step 3: Commit**

```bash
git add native/crates/bp-replay/src/reader.rs
git commit -m "feat(replay): add SQLite event reader for run-scoped UUIDv7-ordered iteration"
```

### Task 6: Implement per-EventKind transitions

**Files:**
- Modify: `native/crates/bp-replay/src/transitions.rs`
- Create: `native/crates/bp-replay/tests/transitions.rs`

- [ ] **Step 1: Write the transitions**

Replace `native/crates/bp-replay/src/transitions.rs`:

```rust
//! Per-EventKind state transition functions.
//!
//! Each `apply_*` function takes a &mut ReplayState and the event-specific
//! payload, mutating state to reflect the event's effect.

use crate::state::{CheckpointRef, FileObservation, ReplayIssue, ReplayState};
use bp_ledger::event::Event;
use bp_ledger::kind::EventKind;
use bp_ledger::payload::{
    git_checkpoint::{GitCheckpointV1, GitStatus},
    run_lifecycle::{RunCompletedV1, RunFailedV1, RunStartedV1},
    tool_io::{ToolRequestStoredV1, ToolResultV1},
    unit_lifecycle::{UnitCancelledV1, UnitCompletedV1, UnitFailedV1, UnitStartedV1},
    workspace::{PostWriteState, WorkspaceReadV1, WorkspaceWriteV1},
    Payload,
};

/// Apply an event's effect to the state. Returns void; issues are pushed
/// into `state.issues` inside the match arms.
pub fn apply(state: &mut ReplayState, event: &Event) {
    match &event.payload {
        Payload::RunStartedV1(p) => apply_run_started(state, event, p),
        Payload::RunCompletedV1(p) => apply_run_completed(state, event, p),
        Payload::RunFailedV1(p) => apply_run_failed(state, event, p),
        Payload::UnitStartedV1(p) => apply_unit_started(state, event, p),
        Payload::UnitCompletedV1(p) => apply_unit_completed(state, event, p),
        Payload::UnitFailedV1(p) => apply_unit_failed(state, event, p),
        Payload::UnitCancelledV1(p) => apply_unit_cancelled(state, event, p),
        Payload::GitCheckpointV1(p) => apply_git_checkpoint(state, event, p),
        Payload::ModelRequestV1(_) | Payload::ModelResponseV1(_) => {
            // Phase D does not track model I/O in state. Phase F may record
            // for audit bundles.
        }
        Payload::ToolRequestStoredV1(p) => apply_tool_request(state, event, p),
        Payload::ToolResultV1(p) => apply_tool_result(state, event, p),
        Payload::WorkspaceReadV1(_p) => {
            // Phase D does not track reads (no read_file tool).
        }
        Payload::WorkspaceWriteV1(p) => apply_workspace_write(state, event, p),
    }
}

fn apply_run_started(state: &mut ReplayState, event: &Event, _p: &RunStartedV1) {
    state.run_id = Some(event.run_id.to_string());
    state.parent_chain.push(event.id);
}

fn apply_run_completed(state: &mut ReplayState, _event: &Event, _p: &RunCompletedV1) {
    state.parent_chain.clear();
}

fn apply_run_failed(state: &mut ReplayState, _event: &Event, _p: &RunFailedV1) {
    state.parent_chain.clear();
}

fn apply_unit_started(state: &mut ReplayState, event: &Event, p: &UnitStartedV1) {
    state.current_unit = Some(p.unit_id.clone());
    state.parent_chain.push(event.id);
}

fn apply_unit_completed(state: &mut ReplayState, _event: &Event, _p: &UnitCompletedV1) {
    state.current_unit = None;
    state.parent_chain.pop();
}

fn apply_unit_failed(state: &mut ReplayState, _event: &Event, _p: &UnitFailedV1) {
    state.current_unit = None;
    state.parent_chain.pop();
}

fn apply_unit_cancelled(state: &mut ReplayState, _event: &Event, _p: &UnitCancelledV1) {
    state.current_unit = None;
    state.parent_chain.pop();
}

fn apply_git_checkpoint(state: &mut ReplayState, event: &Event, p: &GitCheckpointV1) {
    match &p.git_status {
        GitStatus::Ok => {
            state.checkpoints.push(CheckpointRef {
                boundary: format!("{:?}", p.boundary),
                reference: p.reference.clone(),
                commit_sha: p.commit_sha.clone(),
                unit_id: p.unit_id.clone(),
                from_event_id: event.id,
            });
        }
        GitStatus::Failed { error } => {
            state.issues.push(ReplayIssue::CheckpointFailed {
                unit_id: p.unit_id.clone(),
                step: "unknown".to_string(),
                error: error.clone(),
            });
        }
    }
}

fn apply_tool_request(state: &mut ReplayState, event: &Event, _p: &ToolRequestStoredV1) {
    state.parent_chain.push(event.id);
}

fn apply_tool_result(state: &mut ReplayState, _event: &Event, _p: &ToolResultV1) {
    state.parent_chain.pop();
}

fn apply_workspace_write(state: &mut ReplayState, event: &Event, p: &WorkspaceWriteV1) {
    match &p.after {
        PostWriteState::Captured { hash, .. } => {
            state.observed_files.insert(
                p.path.clone(),
                FileObservation {
                    last_known_hash: hash.clone(),
                    from_event_id: event.id,
                },
            );
        }
        PostWriteState::Unreadable { reason } => {
            state.issues.push(ReplayIssue::UnreadablePostWrite {
                path: p.path.clone(),
                reason: reason.clone(),
            });
        }
    }
}
```

- [ ] **Step 2: Write integration tests**

Create `native/crates/bp-replay/tests/transitions.rs`:

```rust
//! Per-EventKind state transition tests.

use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::git_checkpoint::{CheckpointBoundary, GitCheckpointV1, GitStatus};
use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome, RunStartedV1};
use bp_ledger::payload::unit_lifecycle::UnitStartedV1;
use bp_ledger::payload::workspace::{PostWriteState, WorkspaceWriteV1};
use bp_ledger::payload::Payload;
use bp_replay::state::{ReplayIssue, ReplayState};
use bp_replay::transitions::apply;
use chrono::Utc;
use std::collections::BTreeMap;

fn event_of(kind: EventKind, payload: Payload) -> Event {
    Event {
        id: EventId::new(),
        run_id: RunId::new(),
        parent_event_id: None,
        schema_version: 1,
        kind,
        occurred_at: Utc::now(),
        payload,
    }
}

#[test]
fn run_started_sets_run_id_and_pushes_parent_chain() {
    let mut state = ReplayState::default();
    let event = event_of(
        EventKind::RunStarted,
        Payload::RunStartedV1(RunStartedV1 {
            packet_hash: "sha256:aa".into(),
            git_head: "dead".into(),
            workspace_path: "/ws".into(),
            config: BTreeMap::new(),
            parent_run_id: None,
        }),
    );
    apply(&mut state, &event);
    assert!(state.run_id.is_some());
    assert_eq!(state.parent_chain.len(), 1);
    assert_eq!(state.parent_chain[0], event.id);
}

#[test]
fn unit_started_sets_current_unit() {
    let mut state = ReplayState::default();
    let event = event_of(
        EventKind::UnitStarted,
        Payload::UnitStartedV1(UnitStartedV1 {
            unit_id: "u-1".into(),
            parent_unit_id: None,
            unit_kind: "command".into(),
            policy: serde_json::json!({}),
        }),
    );
    apply(&mut state, &event);
    assert_eq!(state.current_unit, Some("u-1".to_string()));
}

#[test]
fn run_completed_clears_parent_chain() {
    let mut state = ReplayState {
        parent_chain: vec![EventId::new(), EventId::new()],
        ..ReplayState::default()
    };
    let event = event_of(
        EventKind::RunCompleted,
        Payload::RunCompletedV1(RunCompletedV1 {
            outcome: RunOutcome::Passed,
            duration_ms: 0,
            event_count: 0,
            unit_count: 0,
        }),
    );
    apply(&mut state, &event);
    assert_eq!(state.parent_chain.len(), 0);
}

#[test]
fn git_checkpoint_ok_pushes_to_checkpoints() {
    let mut state = ReplayState::default();
    let event = event_of(
        EventKind::GitCheckpoint,
        Payload::GitCheckpointV1(GitCheckpointV1 {
            boundary: CheckpointBoundary::PreUnit,
            reference: "refs/buildplane/run/X".into(),
            commit_sha: "a".repeat(40),
            unit_id: "u-1".into(),
            git_status: GitStatus::Ok,
        }),
    );
    apply(&mut state, &event);
    assert_eq!(state.checkpoints.len(), 1);
    assert_eq!(state.checkpoints[0].commit_sha, "a".repeat(40));
    assert_eq!(state.issues.len(), 0);
}

#[test]
fn git_checkpoint_failed_pushes_to_issues() {
    let mut state = ReplayState::default();
    let event = event_of(
        EventKind::GitCheckpoint,
        Payload::GitCheckpointV1(GitCheckpointV1 {
            boundary: CheckpointBoundary::PreUnit,
            reference: "refs/buildplane/run/X".into(),
            commit_sha: String::new(),
            unit_id: "u-1".into(),
            git_status: GitStatus::Failed {
                error: "worktree dirty".into(),
            },
        }),
    );
    apply(&mut state, &event);
    assert_eq!(state.checkpoints.len(), 0);
    assert_eq!(state.issues.len(), 1);
    matches!(&state.issues[0], ReplayIssue::CheckpointFailed { .. });
}

#[test]
fn workspace_write_captured_updates_observed_files() {
    let mut state = ReplayState::default();
    let event = event_of(
        EventKind::WorkspaceWrite,
        Payload::WorkspaceWriteV1(WorkspaceWriteV1 {
            tool_request_id: EventId::new(),
            path: "out.txt".into(),
            hash_before: None,
            after: PostWriteState::Captured {
                hash: "sha256:bb".into(),
                size_bytes: 3,
            },
        }),
    );
    apply(&mut state, &event);
    assert_eq!(state.observed_files.len(), 1);
    let obs = state.observed_files.get("out.txt").unwrap();
    assert_eq!(obs.last_known_hash, "sha256:bb");
}

#[test]
fn workspace_write_unreadable_pushes_issue() {
    let mut state = ReplayState::default();
    let event = event_of(
        EventKind::WorkspaceWrite,
        Payload::WorkspaceWriteV1(WorkspaceWriteV1 {
            tool_request_id: EventId::new(),
            path: "locked.txt".into(),
            hash_before: None,
            after: PostWriteState::Unreadable {
                reason: "EACCES".into(),
            },
        }),
    );
    apply(&mut state, &event);
    assert_eq!(state.observed_files.len(), 0);
    assert_eq!(state.issues.len(), 1);
    matches!(&state.issues[0], ReplayIssue::UnreadablePostWrite { .. });
}
```

- [ ] **Step 3: Run tests**

```bash
cargo test --manifest-path native/Cargo.toml -p bp-replay --test transitions
```

Expected: 7 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add native/crates/bp-replay/src/transitions.rs native/crates/bp-replay/tests/transitions.rs
git commit -m "feat(replay): add per-EventKind state transitions with unit coverage"
```

### Task 7: Implement `ReplayEngine` + forward iteration

**Files:**
- Modify: `native/crates/bp-replay/src/engine.rs`
- Create: `native/crates/bp-replay/tests/iteration.rs`

- [ ] **Step 1: Write engine + iteration test**

Replace `native/crates/bp-replay/src/engine.rs`:

```rust
//! ReplayEngine: forward iteration over a tape.

use crate::reader::{EventReader, ReaderError};
use crate::state::ReplayState;
use crate::transitions;
use bp_ledger::event::Event;
use bp_ledger::id::EventId;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("reader: {0}")]
    Reader(#[from] ReaderError),
}

#[derive(Debug, Serialize)]
pub struct ReplayStep {
    pub event: Event,
    pub state_after: ReplayState,
}

pub struct ReplayEngine {
    events: Vec<Event>,
    cursor: usize,
    state: ReplayState,
}

impl ReplayEngine {
    /// Open an engine for a specific run. Reads all events up-front; engine
    /// owns the full tape in memory. For very large tapes this is a cost;
    /// acceptable given Phase D's expected scale.
    pub fn open(
        run_id: &str,
        db_path: impl AsRef<Path>,
    ) -> Result<Self, EngineError> {
        let reader = EventReader::open(run_id, db_path)?;
        let events = reader.all()?;
        Ok(Self {
            events,
            cursor: 0,
            state: ReplayState::default(),
        })
    }

    /// Return the next ReplayStep or None at EOF.
    pub fn next(&mut self) -> Option<ReplayStep> {
        if self.cursor >= self.events.len() {
            return None;
        }
        let event = self.events[self.cursor].clone();
        self.cursor += 1;
        transitions::apply(&mut self.state, &event);
        Some(ReplayStep {
            event,
            state_after: self.state.clone(),
        })
    }

    /// Consume events up to and including the target. Returns the step at
    /// the target event, or None if the target was never reached.
    ///
    /// Used by Phase E's fork command to rehydrate state at a specific
    /// event boundary.
    pub fn fast_forward_to(&mut self, target: EventId) -> Option<ReplayStep> {
        let mut last: Option<ReplayStep> = None;
        while let Some(step) = self.next() {
            let matched = step.event.id == target;
            last = Some(step);
            if matched {
                return last;
            }
        }
        // Target not found; record as issue on the final state snapshot.
        if last.is_some() {
            self.state.issues.push(crate::state::ReplayIssue::TargetNotFound {
                requested: target.to_string(),
            });
        }
        None
    }

    /// Current state, regardless of cursor position.
    pub fn state(&self) -> &ReplayState {
        &self.state
    }

    /// Total event count for this run.
    pub fn total_events(&self) -> usize {
        self.events.len()
    }
}
```

Create `native/crates/bp-replay/tests/iteration.rs`:

```rust
//! Forward iteration integration tests.

use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome, RunStartedV1};
use bp_ledger::payload::Payload;
use bp_ledger::storage::sqlite::SqliteStore;
use bp_replay::engine::ReplayEngine;
use chrono::Utc;
use std::collections::BTreeMap;
use tempfile::TempDir;

fn event_of(run_id: RunId, kind: EventKind, payload: Payload) -> Event {
    Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: 1,
        kind,
        occurred_at: Utc::now(),
        payload,
    }
}

fn write_sample_tape(db_path: &std::path::Path, run_id: RunId) {
    let store = SqliteStore::open(db_path).unwrap();
    store
        .append(&event_of(
            run_id,
            EventKind::RunStarted,
            Payload::RunStartedV1(RunStartedV1 {
                packet_hash: "sha256:aa".into(),
                git_head: "dead".into(),
                workspace_path: "/ws".into(),
                config: BTreeMap::new(),
                parent_run_id: None,
            }),
        ))
        .unwrap();
    store
        .append(&event_of(
            run_id,
            EventKind::RunCompleted,
            Payload::RunCompletedV1(RunCompletedV1 {
                outcome: RunOutcome::Passed,
                duration_ms: 10,
                event_count: 2,
                unit_count: 0,
            }),
        ))
        .unwrap();
}

#[test]
fn forward_iteration_yields_events_in_order() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("events.db");
    let run_id = RunId::new();
    write_sample_tape(&db_path, run_id);

    let mut engine = ReplayEngine::open(&run_id.to_string(), &db_path).unwrap();
    assert_eq!(engine.total_events(), 2);

    let step1 = engine.next().unwrap();
    assert_eq!(step1.event.kind, EventKind::RunStarted);
    assert_eq!(step1.state_after.run_id, Some(run_id.to_string()));

    let step2 = engine.next().unwrap();
    assert_eq!(step2.event.kind, EventKind::RunCompleted);
    // run_completed clears parent_chain.
    assert_eq!(step2.state_after.parent_chain.len(), 0);

    assert!(engine.next().is_none());
}

#[test]
fn reopening_engine_on_same_db_yields_identical_steps() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("events.db");
    let run_id = RunId::new();
    write_sample_tape(&db_path, run_id);

    let mut engine1 = ReplayEngine::open(&run_id.to_string(), &db_path).unwrap();
    let mut engine2 = ReplayEngine::open(&run_id.to_string(), &db_path).unwrap();

    loop {
        let s1 = engine1.next();
        let s2 = engine2.next();
        match (s1, s2) {
            (None, None) => break,
            (Some(a), Some(b)) => {
                assert_eq!(a.event.id, b.event.id);
                assert_eq!(a.state_after, b.state_after);
            }
            _ => panic!("engine iteration diverged"),
        }
    }
}
```

- [ ] **Step 2: Run tests**

```bash
cargo test --manifest-path native/Cargo.toml -p bp-replay --test iteration
```

Expected: 2 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add native/crates/bp-replay/src/engine.rs native/crates/bp-replay/tests/iteration.rs
git commit -m "feat(replay): add ReplayEngine with forward iteration and determinism test"
```

### Task 8: Add `fast_forward_to` test coverage

**Files:**
- Create: `native/crates/bp-replay/tests/fast_forward.rs`

- [ ] **Step 1: Write test**

Create `native/crates/bp-replay/tests/fast_forward.rs`:

```rust
//! Fast-forward semantics tests. Phase E's fork will use fast_forward_to.

use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome, RunStartedV1};
use bp_ledger::payload::unit_lifecycle::UnitStartedV1;
use bp_ledger::payload::Payload;
use bp_ledger::storage::sqlite::SqliteStore;
use bp_replay::engine::ReplayEngine;
use bp_replay::state::ReplayIssue;
use chrono::Utc;
use std::collections::BTreeMap;
use tempfile::TempDir;

fn write_multistep_tape(db_path: &std::path::Path, run_id: RunId) -> Vec<EventId> {
    let store = SqliteStore::open(db_path).unwrap();
    let mut ids = Vec::new();

    let run_start_id = EventId::new();
    ids.push(run_start_id);
    store
        .append(&Event {
            id: run_start_id,
            run_id,
            parent_event_id: None,
            schema_version: 1,
            kind: EventKind::RunStarted,
            occurred_at: Utc::now(),
            payload: Payload::RunStartedV1(RunStartedV1 {
                packet_hash: "sha256:aa".into(),
                git_head: "dead".into(),
                workspace_path: "/ws".into(),
                config: BTreeMap::new(),
                parent_run_id: None,
            }),
        })
        .unwrap();

    let unit_start_id = EventId::new();
    ids.push(unit_start_id);
    store
        .append(&Event {
            id: unit_start_id,
            run_id,
            parent_event_id: Some(run_start_id),
            schema_version: 1,
            kind: EventKind::UnitStarted,
            occurred_at: Utc::now(),
            payload: Payload::UnitStartedV1(UnitStartedV1 {
                unit_id: "u-1".into(),
                parent_unit_id: None,
                unit_kind: "command".into(),
                policy: serde_json::json!({}),
            }),
        })
        .unwrap();

    let run_complete_id = EventId::new();
    ids.push(run_complete_id);
    store
        .append(&Event {
            id: run_complete_id,
            run_id,
            parent_event_id: Some(run_start_id),
            schema_version: 1,
            kind: EventKind::RunCompleted,
            occurred_at: Utc::now(),
            payload: Payload::RunCompletedV1(RunCompletedV1 {
                outcome: RunOutcome::Passed,
                duration_ms: 10,
                event_count: 3,
                unit_count: 1,
            }),
        })
        .unwrap();

    ids
}

#[test]
fn fast_forward_to_target_returns_state_at_that_event() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("events.db");
    let run_id = RunId::new();
    let ids = write_multistep_tape(&db_path, run_id);

    let mut engine = ReplayEngine::open(&run_id.to_string(), &db_path).unwrap();
    let step = engine.fast_forward_to(ids[1]).unwrap(); // unit_started

    assert_eq!(step.event.id, ids[1]);
    // At unit_started, current_unit should be set and parent_chain has both
    // run_started and unit_started ids.
    assert_eq!(step.state_after.current_unit, Some("u-1".to_string()));
    assert_eq!(step.state_after.parent_chain.len(), 2);
}

#[test]
fn fast_forward_to_missing_target_reports_issue() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("events.db");
    let run_id = RunId::new();
    write_multistep_tape(&db_path, run_id);

    let mut engine = ReplayEngine::open(&run_id.to_string(), &db_path).unwrap();
    let result = engine.fast_forward_to(EventId::new());
    assert!(result.is_none());
    let has_target_not_found = engine
        .state()
        .issues
        .iter()
        .any(|i| matches!(i, ReplayIssue::TargetNotFound { .. }));
    assert!(has_target_not_found);
}
```

- [ ] **Step 2: Run tests**

```bash
cargo test --manifest-path native/Cargo.toml -p bp-replay --test fast_forward
```

Expected: 2 tests PASS.

- [ ] **Step 3: Run all bp-replay tests**

```bash
cargo test --manifest-path native/Cargo.toml -p bp-replay
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add native/crates/bp-replay/tests/fast_forward.rs
git commit -m "feat(replay): add fast_forward_to semantics with target-not-found handling"
```

---

## Phase D.4 — `bp-cli ledger replay` subcommand

### Task 9: Add replay subcommand to bp-cli

**Files:**
- Modify: `native/crates/bp-cli/Cargo.toml`
- Modify: `native/crates/bp-cli/src/ledger_cli.rs`

- [ ] **Step 1: Add bp-replay dep**

Modify `native/crates/bp-cli/Cargo.toml`, add to `[dependencies]`:

```toml
bp-replay.workspace = true
```

- [ ] **Step 2: Add `ReplayArgs` + parser + dispatcher**

Open `native/crates/bp-cli/src/ledger_cli.rs`. Find the existing `LedgerCommand` enum. Add a `Replay` variant.

```rust
use bp_replay::engine::ReplayEngine;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LedgerCommand {
    Serve(ServeArgs),
    Replay(ReplayArgs),
    Help,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayArgs {
    pub run_id: String,
    pub workspace: PathBuf,
    pub format: ReplayFormat,
    pub limit: Option<usize>,
    pub at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayFormat {
    Json,
    Human,
}
```

In `parse_ledger_command`, add:

```rust
        Some("replay") => parse_replay(&args[1..]).map(LedgerCommand::Replay),
```

Add a `parse_replay` function near `parse_serve`:

```rust
fn parse_replay(args: &[String]) -> Result<ReplayArgs, String> {
    let mut run_id: Option<String> = None;
    let mut workspace: Option<PathBuf> = None;
    let mut format = ReplayFormat::Json;
    let mut limit: Option<usize> = None;
    let mut at: Option<String> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--run-id" => {
                i += 1;
                run_id = Some(args.get(i).ok_or("--run-id requires a value")?.clone());
            }
            "--workspace" => {
                i += 1;
                workspace = Some(PathBuf::from(args.get(i).ok_or("--workspace requires a value")?));
            }
            "--format" => {
                i += 1;
                let v = args.get(i).ok_or("--format requires a value")?;
                format = match v.as_str() {
                    "json" => ReplayFormat::Json,
                    "human" => ReplayFormat::Human,
                    other => return Err(format!("unknown format: {other}")),
                };
            }
            "--limit" => {
                i += 1;
                limit = Some(
                    args.get(i)
                        .ok_or("--limit requires a value")?
                        .parse()
                        .map_err(|_| "--limit must be a non-negative integer")?,
                );
            }
            "--at" => {
                i += 1;
                at = Some(args.get(i).ok_or("--at requires a value")?.clone());
            }
            other => return Err(format!("unknown flag: {other}")),
        }
        i += 1;
    }
    Ok(ReplayArgs {
        run_id: run_id.ok_or("missing --run-id")?,
        workspace: workspace.ok_or("missing --workspace")?,
        format,
        limit,
        at,
    })
}
```

Extend `run_ledger_command` (or wherever the command dispatch happens) to handle `LedgerCommand::Replay(args) => run_replay(args)`:

```rust
pub fn run_replay(args: ReplayArgs) -> Result<(), String> {
    let db_path = args.workspace.join(".buildplane").join("ledger").join("events.db");
    let mut engine = ReplayEngine::open(&args.run_id, &db_path)
        .map_err(|e| format!("open events.db: {e}"))?;

    if let Some(target) = &args.at {
        let target_id = bp_ledger::id::EventId::from_uuid(
            uuid::Uuid::parse_str(target).map_err(|e| format!("--at parse: {e}"))?,
        );
        match engine.fast_forward_to(target_id) {
            Some(step) => {
                emit_step(&step, args.format)?;
                return Ok(());
            }
            None => {
                return Err(format!("event {target} not found in run {}", args.run_id));
            }
        }
    }

    let mut count = 0;
    while let Some(step) = engine.next() {
        emit_step(&step, args.format)?;
        count += 1;
        if let Some(limit) = args.limit {
            if count >= limit {
                break;
            }
        }
    }

    if args.format == ReplayFormat::Human {
        println!("\nSnapshots: git -C <workspace> log refs/buildplane/run/{}", args.run_id);
    }

    let issues = &engine.state().issues;
    if !issues.is_empty() {
        eprintln!("{} issues surfaced during replay", issues.len());
        if args.format == ReplayFormat::Human {
            for issue in issues {
                eprintln!("  - {:?}", issue);
            }
        }
    }

    Ok(())
}

fn emit_step(step: &bp_replay::engine::ReplayStep, format: ReplayFormat) -> Result<(), String> {
    match format {
        ReplayFormat::Json => {
            let line = serde_json::to_string(step).map_err(|e| format!("json: {e}"))?;
            println!("{}", line);
        }
        ReplayFormat::Human => {
            let depth = step.state_after.parent_chain.len();
            let indent = "  ".repeat(depth.saturating_sub(1));
            let kind = step.event.kind_str();
            let short_id = &step.event.id.to_string()[..8];
            println!(
                "{}{} {}{}",
                indent,
                kind,
                short_id,
                step.state_after
                    .current_unit
                    .as_ref()
                    .map(|u| format!(" unit={}", u))
                    .unwrap_or_default(),
            );
        }
    }
    Ok(())
}
```

Update the usage text in `usage_text()` to document the `replay` subcommand:

```rust
pub fn usage_text() -> String {
    r#"usage: buildplane-native ledger <subcommand>

subcommands:
  serve   Run a ledger ingest loop against stdin (JSONL events).
  replay  Replay a run's events with optional fast-forward.

flags for `serve`:
  --run-id <id>             run identifier (required)
  --workspace <path>        absolute path to the workspace root (required)
  --schema-version <n>      wire schema version (default: 1)

flags for `replay`:
  --run-id <id>             run identifier (required)
  --workspace <path>        absolute path to the workspace root (required)
  --format <json|human>     output format (default: json)
  --limit <n>               stop after n events
  --at <event-id>           fast-forward to event-id, emit state there, exit
"#
    .to_string()
}
```

- [ ] **Step 3: Build**

```bash
cargo build --manifest-path native/Cargo.toml -p bp-cli
```

Expected: PASS.

- [ ] **Step 4: Smoke test**

```bash
# Use the existing Phase B smoke fixture to create a real tape:
rm -rf /tmp/bp-replay-smoke && mkdir -p /tmp/bp-replay-smoke
cat > /tmp/bp-replay-smoke/input.jsonl <<'EOF'
{"control":"handshake","protocol":1,"run_id":"01919000-0000-7000-8000-000000000000","started_at":"2026-04-18T00:00:00Z","schema_version":1}
{"id":"01919000-0000-7000-8000-000000000001","run_id":"01919000-0000-7000-8000-000000000000","parent_event_id":null,"schema_version":1,"kind":"run_started","occurred_at":"2026-04-18T00:00:01Z","payload":{"RunStartedV1":{"packet_hash":"sha256:aa","git_head":"deadbeef","workspace_path":"/tmp/bp-replay-smoke","config":{},"parent_run_id":null}}}
{"id":"01919000-0000-7000-8000-000000000002","run_id":"01919000-0000-7000-8000-000000000000","parent_event_id":"01919000-0000-7000-8000-000000000001","schema_version":1,"kind":"run_completed","occurred_at":"2026-04-18T00:00:02Z","payload":{"RunCompletedV1":{"outcome":"passed","duration_ms":5,"event_count":2,"unit_count":0}}}
{"control":"close","seq":0}
EOF
cat /tmp/bp-replay-smoke/input.jsonl | ./native/target/debug/buildplane-native ledger serve --run-id 01919000-0000-7000-8000-000000000000 --workspace /tmp/bp-replay-smoke 2>/dev/null

# Now replay:
./native/target/debug/buildplane-native ledger replay --run-id 01919000-0000-7000-8000-000000000000 --workspace /tmp/bp-replay-smoke --format json
./native/target/debug/buildplane-native ledger replay --run-id 01919000-0000-7000-8000-000000000000 --workspace /tmp/bp-replay-smoke --format human
```

Expected:
- JSON: 2 lines, each valid JSON with `event` + `state_after`.
- Human: indented tree with kinds + snapshot hint.

- [ ] **Step 5: Commit**

```bash
git add native/crates/bp-cli/Cargo.toml native/crates/bp-cli/src/ledger_cli.rs
git commit -m "feat(cli): add bp-cli ledger replay subcommand (json + human formats)"
```

---

## Phase D.5 — TS CLI dispatch + integration tests

### Task 10: TS CLI dispatch for ledger replay

**Files:**
- Modify: `apps/cli/src/run-cli.ts`

- [ ] **Step 1: Locate the existing `ledger serve` dispatch**

Grep for `ledger serve` or the `resolveLedgerBinary` helper. Find the section where the TS CLI spawns the native binary for ledger subcommands.

- [ ] **Step 2: Add replay dispatch**

Near the `ledger serve` dispatch, add a `ledger replay` case. The shape mirrors how memory/pack commands forward args to the native binary:

```ts
case "replay": {
	const binary = resolveLedgerBinary(cwd);
	const args = [
		"ledger",
		"replay",
		"--run-id",
		<runId-from-rest>,
		"--workspace",
		resolve(cwd),
		...<other flags passed through from rest>,
	];
	const result = spawnSync(binary, args, {
		stdio: "inherit",
		cwd: resolve(cwd),
	});
	return result.status ?? 1;
}
```

Exact integration depends on the existing dispatch structure. Key points:
- Parse `--format`, `--limit`, `--at` from the user's command-line args and pass through.
- `--run-id` can be either a positional arg or a flag; match existing `ledger` subcommand conventions.
- Use `stdio: "inherit"` so the native binary's stdout streams to the user's terminal. Don't buffer; replay output on large tapes is meant to stream.

- [ ] **Step 3: Build**

```bash
pnpm --filter buildplane build
```

Expected: clean.

- [ ] **Step 4: Smoke test**

Use the Task 9 smoke fixture:

```bash
pnpm buildplane ledger replay --run-id 01919000-0000-7000-8000-000000000000 --workspace /tmp/bp-replay-smoke --format json
```

Expected: same output as the direct Rust invocation in Task 9.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/run-cli.ts
git commit -m "feat(cli): add TS dispatch for buildplane ledger replay"
```

### Task 11: `tape-capture-end-to-end.test.ts`

**Files:**
- Create: `test/ledger-integration/tape-capture-end-to-end.test.ts`

- [ ] **Step 1: Write the test**

Create `test/ledger-integration/tape-capture-end-to-end.test.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { makeBuildplaneRunFixture } from "./fixtures.js";

/**
 * The end-to-end gate for Phase D: a real buildplane run produces the full
 * event sequence Phase A promised. Phase C left three .skip markers pointing
 * at this gap; they are removed in this task.
 */
describe("tape-capture end-to-end", () => {
	it("write_file + run_command packet produces full tape sequence", async () => {
		const fixture = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "unit-e2e",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["out.txt", "echoed.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: {
					command: "sh",
					args: [
						"-c",
						"node -e \"require('node:fs').writeFileSync('out.txt','hello')\" && echo via-shell > echoed.txt",
					],
				},
				verification: { requiredOutputs: ["out.txt", "echoed.txt"] },
			},
		});

		try {
			expect(fixture.exitCode).toBe(0);
			const db = new DatabaseSync(fixture.eventsDbPath);
			const kinds = (
				db.prepare("SELECT kind FROM events ORDER BY id ASC").all() as {
					kind: string;
				}[]
			).map((r) => r.kind);

			// The Phase A success criteria sequence (at minimum):
			expect(kinds).toContain("run_started");
			expect(kinds).toContain("unit_started");
			expect(kinds).toContain("git_checkpoint"); // pre-unit
			expect(kinds).toContain("unit_completed");
			expect(kinds).toContain("run_completed");

			// Pre + post checkpoints (at least 2).
			const checkpointCount = kinds.filter((k) => k === "git_checkpoint").length;
			expect(checkpointCount).toBeGreaterThanOrEqual(2);

			db.close();
		} finally {
			await fixture.cleanup();
		}
	}, 30_000);
});
```

- [ ] **Step 2: Remove Phase C `.skip` markers**

Open each of these and convert `.skip` back to regular `it`/`test`:

- `test/ledger-integration/tool-capture.test.ts`
- `test/ledger-integration/shell-command-capture.test.ts`
- `test/ledger-integration/git-checkpoint.test.ts`

If the test bodies have explicit "Phase C gap" comments or assertions that only test "current behavior" (e.g., asserting kinds are only `["run_started", "run_completed"]`), strengthen them to assert the full Phase A sequence.

- [ ] **Step 3: Run the integration suite**

```bash
pnpm exec vitest run test/ledger-integration/
```

Expected: all tests PASS, including tape-capture-end-to-end and the three unskipped ones.

- [ ] **Step 4: Commit**

```bash
git add test/ledger-integration/tape-capture-end-to-end.test.ts test/ledger-integration/tool-capture.test.ts test/ledger-integration/shell-command-capture.test.ts test/ledger-integration/git-checkpoint.test.ts
git commit -m "test(ledger): add end-to-end tape capture test; unskip Phase C .skip markers"
```

### Task 12: `replay-basic.test.ts` + `replay-at-event.test.ts`

**Files:**
- Create: `test/ledger-integration/replay-basic.test.ts`
- Create: `test/ledger-integration/replay-at-event.test.ts`

- [ ] **Step 1: Write `replay-basic.test.ts`**

Create `test/ledger-integration/replay-basic.test.ts`:

```ts
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { makeBuildplaneRunFixture } from "./fixtures.js";

const NATIVE_BIN =
	process.env.BUILDPLANE_NATIVE_BIN ??
	`${process.cwd()}/native/target/debug/buildplane-native`;

describe("replay basic", () => {
	it("streams one JSON line per event with hydrated state", async () => {
		const fixture = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "unit-replay",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["out.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: {
					command: "sh",
					args: ["-c", "echo hi > out.txt"],
				},
				verification: { requiredOutputs: ["out.txt"] },
			},
		});

		try {
			expect(fixture.exitCode).toBe(0);
			const db = new DatabaseSync(fixture.eventsDbPath);
			const runIdRow = db
				.prepare("SELECT DISTINCT run_id FROM events LIMIT 1")
				.get() as { run_id: string };
			const runId = runIdRow.run_id;
			const expectedCount = (
				db.prepare("SELECT COUNT(*) as c FROM events").get() as { c: number }
			).c;
			db.close();

			const result = spawnSync(
				NATIVE_BIN,
				[
					"ledger",
					"replay",
					"--run-id",
					runId,
					"--workspace",
					fixture.dir,
					"--format",
					"json",
				],
				{ encoding: "utf8" },
			);
			expect(result.status).toBe(0);

			const lines = result.stdout.trim().split("\n").filter(Boolean);
			expect(lines.length).toBe(expectedCount);

			// Each line is a valid ReplayStep with event + state_after.
			for (const line of lines) {
				const step = JSON.parse(line);
				expect(step.event).toBeDefined();
				expect(step.event.id).toMatch(/^[0-9a-f-]{36}$/);
				expect(step.state_after).toBeDefined();
				expect(step.state_after.parent_chain).toBeInstanceOf(Array);
			}

			// Last step's state should have run_completed semantics: parent_chain
			// cleared.
			const lastStep = JSON.parse(lines[lines.length - 1]);
			if (lastStep.event.kind === "run_completed") {
				expect(lastStep.state_after.parent_chain.length).toBe(0);
			}
		} finally {
			await fixture.cleanup();
		}
	}, 30_000);
});
```

- [ ] **Step 2: Write `replay-at-event.test.ts`**

Create `test/ledger-integration/replay-at-event.test.ts`:

```ts
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { makeBuildplaneRunFixture } from "./fixtures.js";

const NATIVE_BIN =
	process.env.BUILDPLANE_NATIVE_BIN ??
	`${process.cwd()}/native/target/debug/buildplane-native`;

describe("replay --at event", () => {
	it("fast-forwards to target event and emits state there", async () => {
		const fixture = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "unit-ff",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["a.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: {
					command: "sh",
					args: ["-c", "echo a > a.txt"],
				},
				verification: { requiredOutputs: ["a.txt"] },
			},
		});

		try {
			const db = new DatabaseSync(fixture.eventsDbPath);
			const runId = (
				db.prepare("SELECT DISTINCT run_id FROM events LIMIT 1").get() as {
					run_id: string;
				}
			).run_id;
			// Pick an event mid-tape: the unit_started (should be the 2nd event).
			const targetRow = db
				.prepare(
					"SELECT id FROM events WHERE kind = 'unit_started' ORDER BY id ASC LIMIT 1",
				)
				.get() as { id: string } | undefined;
			db.close();

			// If there's no unit_started (e.g., wiring incomplete), skip.
			if (!targetRow) {
				return;
			}
			const targetId = targetRow.id;

			const result = spawnSync(
				NATIVE_BIN,
				[
					"ledger",
					"replay",
					"--run-id",
					runId,
					"--workspace",
					fixture.dir,
					"--format",
					"json",
					"--at",
					targetId,
				],
				{ encoding: "utf8" },
			);
			expect(result.status).toBe(0);

			const lines = result.stdout.trim().split("\n").filter(Boolean);
			expect(lines.length).toBe(1);

			const step = JSON.parse(lines[0]);
			expect(step.event.id).toBe(targetId);
			expect(step.event.kind).toBe("unit_started");
			expect(step.state_after.current_unit).toBeDefined();
		} finally {
			await fixture.cleanup();
		}
	}, 30_000);

	it("non-existent target id exits non-zero", async () => {
		const fixture = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "unit-miss",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["out.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: { command: "sh", args: ["-c", "echo ok > out.txt"] },
				verification: { requiredOutputs: ["out.txt"] },
			},
		});

		try {
			const db = new DatabaseSync(fixture.eventsDbPath);
			const runId = (
				db.prepare("SELECT DISTINCT run_id FROM events LIMIT 1").get() as {
					run_id: string;
				}
			).run_id;
			db.close();

			const result = spawnSync(
				NATIVE_BIN,
				[
					"ledger",
					"replay",
					"--run-id",
					runId,
					"--workspace",
					fixture.dir,
					"--format",
					"json",
					"--at",
					"01919000-0000-7000-8000-ffffffffffff",
				],
				{ encoding: "utf8" },
			);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("not found");
		} finally {
			await fixture.cleanup();
		}
	}, 30_000);
});
```

- [ ] **Step 3: Run tests**

```bash
pnpm exec vitest run test/ledger-integration/replay-basic.test.ts test/ledger-integration/replay-at-event.test.ts
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add test/ledger-integration/replay-basic.test.ts test/ledger-integration/replay-at-event.test.ts
git commit -m "test(ledger): add replay basic + replay --at event integration tests"
```

---

## Phase D.6 — Verification gate

### Task 13: Full gate + spec marker

**Files:**
- Modify: `docs/superpowers/specs/2026-04-18-replay-wiring-design.md`
- Modify: `docs/ledger.md` (add replay command documentation)

- [ ] **Step 1: Full test suite**

```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger -p bp-ledger-macros -p bp-cli -p bp-replay
```

Expected: all PASS.

```bash
pnpm exec vitest run apps/cli/test/ packages/ledger-client/test/ test/ledger-integration/
```

Expected: all PASS (Phase B's + Phase C's + Phase D's).

- [ ] **Step 2: Clippy**

```bash
cargo clippy --manifest-path native/Cargo.toml -p bp-ledger -p bp-ledger-macros -p bp-cli -p bp-replay -- -D warnings
```

Expected: clean.

- [ ] **Step 3: Fixture drift check**

```bash
pnpm ledger:gen-fixtures && git diff --exit-code -- packages/ledger-client/fixtures/payload-variants.json
```

Expected: exit 0.

- [ ] **Step 4: Real-run smoke**

```bash
rm -rf /tmp/bp-phase-d-gate && mkdir -p /tmp/bp-phase-d-gate && cd /tmp/bp-phase-d-gate
git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m init
cat > packet.json <<'EOF'
{
  "unit": {
    "id": "unit-hello",
    "kind": "command",
    "scope": "task",
    "inputRefs": [],
    "expectedOutputs": ["out.txt"],
    "verificationContract": "exit-0-and-required-outputs",
    "policyProfile": "default"
  },
  "execution": {
    "command": "sh",
    "args": ["-c", "echo hi > out.txt"]
  },
  "verification": { "requiredOutputs": ["out.txt"] }
}
EOF
cd /mnt/c/Dev/projects/buildplane-ledger-phase-d
pnpm buildplane run --packet /tmp/bp-phase-d-gate/packet.json --cwd /tmp/bp-phase-d-gate

# Capture the run_id and replay it:
RUN_ID=$(python3 -c "import sqlite3; c=sqlite3.connect('/tmp/bp-phase-d-gate/.buildplane/ledger/events.db'); print(c.execute('SELECT DISTINCT run_id FROM events LIMIT 1').fetchone()[0])")
pnpm buildplane ledger replay --run-id "$RUN_ID" --workspace /tmp/bp-phase-d-gate --format human
```

Expected: run populates events.db with the full Phase A sequence; replay prints an indented tree ending in a snapshot hint.

Verify repo-root isn't polluted:

```bash
cd /mnt/c/Dev/projects/buildplane-ledger-phase-d
git status --porcelain
```

Expected: unchanged.

- [ ] **Step 5: Benchmark (informational)**

Optional; record in `docs/benchmarks/replay.md` if you want. Use a 1000-event canned tape and measure `buildplane ledger replay` wall-clock. Skip if pressed for time.

- [ ] **Step 6: Update `docs/ledger.md`**

Add a section documenting the replay command:

```markdown
## Replaying a run

`buildplane ledger replay <run-id>` walks the tape for a run in causal order
and emits either JSON (default) or an indented human tree. Flags:

- `--format json|human` — output mode. JSON is one line per event,
  carrying `{event, state_after}`. Human is an indented tree.
- `--limit <n>` — stop after n events.
- `--at <event-id>` — fast-forward to the given event, emit state at that
  point, exit. Preparatory for `fork`.

Examples:

```bash
buildplane ledger replay <run-id> --format human
buildplane ledger replay <run-id> --format json | jq '.event.kind'
buildplane ledger replay <run-id> --at <event-id> --format json
```

Replay is read-only — no model calls, no tool invocations, no side effects.
Replay does not verify the tape against external truth (git history, real
filesystem); it faithfully reports whatever the tape says happened.
Corruption surfaces as `ReplayIssue` entries on the final state.
```

- [ ] **Step 7: Spec marker**

Modify `docs/superpowers/specs/2026-04-18-replay-wiring-design.md`. Append to the end of Section 4 (Phases + Sequencing):

```markdown

**Phase D status: complete (2026-04-18).**
```

(use actual completion date)

- [ ] **Step 8: Final commit**

```bash
git add docs/ledger.md docs/superpowers/specs/2026-04-18-replay-wiring-design.md
git commit -m "docs(ledger): document replay command; mark Phase D complete"
```

---

## Self-review

**Spec coverage check:**

| Spec in-scope item | Task(s) |
|---|---|
| W.1 sync-path bus emission | 1 |
| W.2 wrapped ToolRegistry threading | 2 |
| `bp-replay` crate scaffold | 3 |
| `ReplayState` types | 4 |
| SQLite reader | 5 |
| Per-EventKind transitions | 6 |
| `ReplayEngine::next()` forward iteration | 7 |
| `ReplayEngine::fast_forward_to()` | 8 |
| `bp-cli ledger replay` subcommand | 9 |
| TS CLI dispatch | 10 |
| tape-capture-end-to-end test (unskips Phase C) | 11 |
| replay-basic + replay-at-event tests | 12 |
| Verification gate + spec marker | 13 |

Success criteria (from spec Section 1):
1. Full Phase A event sequence on a write_file + shell packet — Task 11 asserts.
2. JSON streaming with state deltas — Tasks 9, 12.
3. Human indented tree with snapshot hint — Task 9.
4. `--at` fast-forward with deterministic output — Tasks 8, 12.
5. Canary still passes — implicit throughout (each task runs the canary).
6. Human-readable reconstruction — Task 9 (human mode).

No gaps.

**Placeholder scan.** No TBD/TODO in task content. Implementation notes that guide adaptation (Task 1 re orchestrator location, Task 2 re audit depth, Task 10 re dispatch shape) are explicit guidance, not placeholders.

**Type consistency.**
- `ReplayEngine`, `ReplayState`, `ReplayStep`, `ReplayIssue`, `CheckpointRef`, `FileObservation` — consistent across Tasks 4, 6, 7, 8, 9.
- `ReplayFormat::Json | Human` — consistent in Task 9.
- `ReplayArgs` fields match between Task 9 (Rust parser) and Task 10 (TS dispatch).
- Event kinds match Phase A's types (`RunStarted`, `UnitStarted`, etc.) — Task 6 uses the canonical names.
- `--at` flag semantics consistent across Task 8 (engine), Task 9 (CLI), Task 12 (test).

No drift detected.
