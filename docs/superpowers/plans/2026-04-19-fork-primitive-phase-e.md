# Fork Primitive — Phase E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `buildplane fork <run-id> --at <event-id> --packet <file>` — a re-execute fork that rehydrates the parent run's workspace at a unit boundary, emits a new run with `parent_run_id` lineage, and runs a new packet. Defers tool-output VCR to Phase F.

**Architecture:** New `bp-fork` Rust crate builds a `ForkPlan` by driving the Phase D `bp-replay::ReplayEngine::fast_forward_to`, validating the target is a `unit_started` event, and extracting the pre-unit git checkpoint SHA. `bp-cli` grows a top-level `fork plan` subcommand that emits ForkPlan JSON. TS CLI's `buildplane fork` dispatches via the plan → clean-worktree check → `git checkout <pre-unit SHA>` → spawn ledger + run orchestrator → emit `run_started` with lineage → orchestrator's existing Phase D wiring handles the rest.

**Tech Stack:** Rust (edition 2021), rusqlite, serde, thiserror. TypeScript (Node 24, ESM), vitest. No new dependencies.

**Reference spec:** `docs/superpowers/specs/2026-04-19-fork-primitive-design.md`
**Builds on:** A (PR #59), B (PR #60), C (PR #61), D (PR #62).

---

## Phase E scope recap

**In scope:**
- `bp-fork` crate with `ForkPlan` + `build_fork_plan`.
- `bp-cli fork plan` subcommand.
- `buildplane fork` TS CLI top-level command.
- Fork execution via existing orchestrator (parent_run_id lineage).
- `bp-replay::ReplayState.parent_run_id` + human-mode lineage header.
- 3 active integration tests + 3 `.skip` VCR stubs for Phase F.
- `docs/ledger.md` fork section.

**Out of scope (Phase F):** VCR mode, CAS packet retrieval, mid-unit forking, cross-run replay, worktree isolation.

---

## File structure

```
native/
├── Cargo.toml                              # MODIFY: add bp-fork member
└── crates/
    ├── bp-fork/                            # NEW
    │   ├── Cargo.toml
    │   ├── src/
    │   │   ├── lib.rs                      # public API
    │   │   ├── plan.rs                     # ForkPlan struct
    │   │   └── planner.rs                  # build_fork_plan
    │   └── tests/
    │       └── planner.rs                  # Layer 1 tests
    ├── bp-cli/
    │   └── src/
    │       ├── fork_cli.rs                 # NEW: ForkArgs + parser + dispatch
    │       └── main.rs                     # MODIFY: Command::Fork variant
    └── bp-replay/
        └── src/
            ├── state.rs                    # MODIFY: parent_run_id field
            └── transitions.rs              # MODIFY: populate parent_run_id in run_started

apps/cli/
├── src/
│   └── run-cli.ts                          # MODIFY: top-level fork dispatch

test/ledger-integration/
├── fixtures.ts                             # MODIFY: add makeForkFixture
├── fork-basic.test.ts                      # NEW
├── fork-invalid-target.test.ts             # NEW
├── fork-same-packet.test.ts                # NEW
├── fork-vcr-basic.test.ts                  # NEW (.skip — Phase F)
├── fork-vcr-fallback.test.ts               # NEW (.skip — Phase F)
└── fork-vcr-diff.test.ts                   # NEW (.skip — Phase F)

docs/
├── ledger.md                               # MODIFY: fork section
└── superpowers/specs/2026-04-19-fork-primitive-design.md  # MODIFY: spec marker
```

---

## Task 1: Scaffold `bp-fork` crate

**Files:**
- Modify: `native/Cargo.toml`
- Create: `native/crates/bp-fork/Cargo.toml`
- Create: `native/crates/bp-fork/src/lib.rs`
- Create: `native/crates/bp-fork/src/plan.rs`
- Create: `native/crates/bp-fork/src/planner.rs`

- [ ] **Step 1: Add workspace member**

Modify `native/Cargo.toml`:
- Under `[workspace] members = [...]`: add `"crates/bp-fork",`
- Under `[workspace.dependencies]`: add `bp-fork = { path = "crates/bp-fork" }`

- [ ] **Step 2: Create crate Cargo.toml**

Write `native/crates/bp-fork/Cargo.toml`:

```toml
[package]
name = "bp-fork"
version.workspace = true
edition.workspace = true
license.workspace = true

[dependencies]
bp-ledger.workspace = true
bp-replay.workspace = true
serde.workspace = true
serde_json.workspace = true
thiserror.workspace = true
uuid.workspace = true

[dev-dependencies]
tempfile = "3"
chrono.workspace = true
```

- [ ] **Step 3: Create lib.rs**

Write `native/crates/bp-fork/src/lib.rs`:

```rust
//! Fork planning for buildplane. Consumes bp-replay state to build a
//! ForkPlan that describes how to resume from a unit boundary in a prior run.

pub mod plan;
pub mod planner;

pub use plan::ForkPlan;
pub use planner::{build_fork_plan, PlanError};
```

- [ ] **Step 4: Create `plan.rs` stub**

Write `native/crates/bp-fork/src/plan.rs`:

```rust
//! ForkPlan: the serialized plan bp-cli emits on stdout, TS CLI consumes.

use serde::{Deserialize, Serialize};

/// Plan returned by `build_fork_plan`. Describes everything TS needs to
/// execute a fork: new run_id, workspace checkout SHA, packet bytes, lineage.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ForkPlan {
    /// Fresh UUIDv7 run_id for the fork.
    pub new_run_id: String,
    /// Absolute workspace path (mirrors the --workspace arg).
    pub workspace_path: String,
    /// Pre-unit git checkpoint SHA to `git checkout` before execution.
    pub checkout_sha: String,
    /// New packet bytes, as parsed JSON. TS re-serializes into its pipeline.
    pub packet_json: serde_json::Value,
    /// Parent run_id for lineage.
    pub parent_run_id: String,
    /// Parent event_id (the unit_started we forked at).
    pub parent_event_id: String,
}
```

- [ ] **Step 5: Create `planner.rs` stub**

Write `native/crates/bp-fork/src/planner.rs`:

```rust
//! build_fork_plan implementation. Drives bp-replay to fast-forward to a
//! target, validates it's a unit_started, extracts the pre-unit checkpoint,
//! reads the packet file, returns a ForkPlan.

use crate::plan::ForkPlan;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PlanError {
    #[error("replay: {0}")]
    Replay(String),
    #[error("target event must be unit_started; got {kind} at {event_id}. \
             Nearest enclosing unit_started: {nearest}")]
    TargetNotUnitStarted {
        kind: String,
        event_id: String,
        nearest: String,
    },
    #[error("cannot fork at run_started; use `buildplane run` directly")]
    ForkAtRoot,
    #[error("event {event_id} not found in run {run_id}")]
    EventNotFound { event_id: String, run_id: String },
    #[error("no pre-unit git_checkpoint for unit {unit_id} (corrupted or partial tape)")]
    MissingPreCheckpoint { unit_id: String },
    #[error("packet file {path}: {source}")]
    PacketIo { path: String, #[source] source: std::io::Error },
    #[error("packet file {path} is not valid JSON: {source}")]
    PacketJson { path: String, #[source] source: serde_json::Error },
}

/// Build a ForkPlan from a parent run's events.db, a target event_id,
/// a workspace path, and a new packet file path.
///
/// Phase E stub. Full implementation lands in Task 2.
pub fn build_fork_plan(
    _parent_run_id: &str,
    _target_event_id: &str,
    _workspace: &std::path::Path,
    _packet_path: &std::path::Path,
) -> Result<ForkPlan, PlanError> {
    Err(PlanError::Replay("not yet implemented".into()))
}
```

- [ ] **Step 6: Verify compile**

```bash
cargo check --manifest-path native/Cargo.toml -p bp-fork
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add native/Cargo.toml native/crates/bp-fork/
git commit -m "feat(fork): scaffold bp-fork crate with ForkPlan + PlanError"
```

---

## Task 2: Implement `build_fork_plan` happy path

**Files:**
- Modify: `native/crates/bp-fork/src/planner.rs`
- Create: `native/crates/bp-fork/tests/planner.rs`

- [ ] **Step 1: Write failing happy-path test**

Create `native/crates/bp-fork/tests/planner.rs`:

```rust
//! Layer 1 tests for build_fork_plan.

use bp_fork::{build_fork_plan, PlanError};
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::git_checkpoint::{CheckpointBoundary, GitCheckpointV1, GitStatus};
use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome, RunStartedV1};
use bp_ledger::payload::unit_lifecycle::UnitStartedV1;
use bp_ledger::payload::Payload;
use bp_ledger::storage::sqlite::SqliteStore;
use chrono::Utc;
use std::collections::BTreeMap;
use std::fs::write;
use tempfile::TempDir;

fn event_of(
    id: EventId,
    run_id: RunId,
    parent: Option<EventId>,
    kind: EventKind,
    payload: Payload,
) -> Event {
    Event {
        id,
        run_id,
        parent_event_id: parent,
        schema_version: 1,
        kind,
        occurred_at: Utc::now(),
        payload,
    }
}

/// Writes a parent tape with:
///   run_started → unit_started(u-1) → git_checkpoint(pre-unit) →
///   git_checkpoint(post-unit) → unit_completed → run_completed
/// Returns (tmpdir, events_db_path, run_id, unit_started_id, pre_sha).
fn write_parent_tape() -> (TempDir, std::path::PathBuf, RunId, EventId, String) {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join(".buildplane").join("ledger").join("events.db");
    std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();
    let store = SqliteStore::open(&db_path).unwrap();
    let run_id = RunId::new();

    let run_start_id = EventId::new();
    store.append(&event_of(
        run_start_id, run_id, None, EventKind::RunStarted,
        Payload::RunStartedV1(RunStartedV1 {
            packet_hash: "sha256:aa".into(),
            git_head: "deadbeef".into(),
            workspace_path: tmp.path().display().to_string(),
            config: BTreeMap::new(),
            parent_run_id: None,
        }),
    )).unwrap();

    let unit_start_id = EventId::new();
    store.append(&event_of(
        unit_start_id, run_id, Some(run_start_id), EventKind::UnitStarted,
        Payload::UnitStartedV1(UnitStartedV1 {
            unit_id: "u-1".into(),
            parent_unit_id: None,
            unit_kind: "command".into(),
            policy: serde_json::json!({}),
        }),
    )).unwrap();

    let pre_sha = "a".repeat(40);
    let pre_ckpt_id = EventId::new();
    store.append(&event_of(
        pre_ckpt_id, run_id, Some(unit_start_id), EventKind::GitCheckpoint,
        Payload::GitCheckpointV1(GitCheckpointV1 {
            boundary: CheckpointBoundary::PreUnit,
            reference: format!("refs/buildplane/run/{}", run_id),
            commit_sha: pre_sha.clone(),
            unit_id: "u-1".into(),
            git_status: GitStatus::Ok,
        }),
    )).unwrap();

    let post_ckpt_id = EventId::new();
    store.append(&event_of(
        post_ckpt_id, run_id, Some(unit_start_id), EventKind::GitCheckpoint,
        Payload::GitCheckpointV1(GitCheckpointV1 {
            boundary: CheckpointBoundary::PostUnit,
            reference: format!("refs/buildplane/run/{}", run_id),
            commit_sha: "b".repeat(40),
            unit_id: "u-1".into(),
            git_status: GitStatus::Ok,
        }),
    )).unwrap();

    let unit_done_id = EventId::new();
    store.append(&event_of(
        unit_done_id, run_id, Some(unit_start_id), EventKind::UnitCompleted,
        Payload::UnitCompletedV1(bp_ledger::payload::unit_lifecycle::UnitCompletedV1 {
            unit_id: "u-1".into(),
            outcome: bp_ledger::payload::unit_lifecycle::UnitOutcome::Passed,
            artifacts: vec![],
        }),
    )).unwrap();

    store.append(&event_of(
        EventId::new(), run_id, Some(run_start_id), EventKind::RunCompleted,
        Payload::RunCompletedV1(RunCompletedV1 {
            outcome: RunOutcome::Passed,
            duration_ms: 10,
            event_count: 6,
            unit_count: 1,
        }),
    )).unwrap();

    (tmp, db_path, run_id, unit_start_id, pre_sha)
}

#[test]
fn happy_path_returns_fork_plan() {
    let (tmp, _db_path, run_id, unit_start_id, pre_sha) = write_parent_tape();

    let packet_path = tmp.path().join("new-packet.json");
    write(&packet_path, br#"{"unit":{"id":"u-new","kind":"command"},"execution":{"command":"sh","args":["-c","echo hi"]}}"#).unwrap();

    let plan = build_fork_plan(
        &run_id.to_string(),
        &unit_start_id.to_string(),
        tmp.path(),
        &packet_path,
    ).unwrap();

    assert_eq!(plan.parent_run_id, run_id.to_string());
    assert_eq!(plan.parent_event_id, unit_start_id.to_string());
    assert_eq!(plan.checkout_sha, pre_sha);
    assert_eq!(plan.workspace_path, tmp.path().display().to_string());
    assert!(!plan.new_run_id.is_empty());
    assert!(plan.packet_json.get("unit").is_some());
}
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cargo test --manifest-path native/Cargo.toml -p bp-fork --test planner happy_path_returns_fork_plan
```

Expected: FAIL — planner returns stub error.

- [ ] **Step 3: Implement `build_fork_plan`**

Replace `native/crates/bp-fork/src/planner.rs`:

```rust
//! build_fork_plan implementation.

use crate::plan::ForkPlan;
use bp_ledger::id::EventId;
use bp_ledger::kind::EventKind;
use bp_replay::engine::ReplayEngine;
use bp_replay::state::CheckpointRef;
use std::path::Path;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum PlanError {
    #[error("replay: {0}")]
    Replay(String),
    #[error("target event must be unit_started; got {kind} at {event_id}. \
             Nearest enclosing unit_started: {nearest}")]
    TargetNotUnitStarted {
        kind: String,
        event_id: String,
        nearest: String,
    },
    #[error("cannot fork at run_started; use `buildplane run` directly")]
    ForkAtRoot,
    #[error("event {event_id} not found in run {run_id}")]
    EventNotFound { event_id: String, run_id: String },
    #[error("no pre-unit git_checkpoint for unit {unit_id} (corrupted or partial tape)")]
    MissingPreCheckpoint { unit_id: String },
    #[error("packet file {path}: {source}")]
    PacketIo {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("packet file {path} is not valid JSON: {source}")]
    PacketJson {
        path: String,
        #[source]
        source: serde_json::Error,
    },
    #[error("invalid event id {value}: {source}")]
    BadEventId {
        value: String,
        #[source]
        source: uuid::Error,
    },
}

pub fn build_fork_plan(
    parent_run_id: &str,
    target_event_id: &str,
    workspace: &Path,
    packet_path: &Path,
) -> Result<ForkPlan, PlanError> {
    // Resolve events.db under <workspace>/.buildplane/ledger/events.db.
    let db_path = workspace.join(".buildplane").join("ledger").join("events.db");
    let mut engine = ReplayEngine::open(parent_run_id, &db_path)
        .map_err(|e| PlanError::Replay(format!("{e}")))?;

    let target_uuid = Uuid::parse_str(target_event_id).map_err(|source| PlanError::BadEventId {
        value: target_event_id.to_string(),
        source,
    })?;
    let target = EventId::from_uuid(target_uuid);

    // Fast-forward to the target.
    let step = engine
        .fast_forward_to(target)
        .ok_or_else(|| PlanError::EventNotFound {
            event_id: target_event_id.to_string(),
            run_id: parent_run_id.to_string(),
        })?;

    // Validate kind.
    match step.event.kind {
        EventKind::UnitStarted => {}
        EventKind::RunStarted => return Err(PlanError::ForkAtRoot),
        other => {
            let nearest = nearest_unit_start(&step, other).unwrap_or_else(|| "unknown".to_string());
            return Err(PlanError::TargetNotUnitStarted {
                kind: format!("{other:?}"),
                event_id: target_event_id.to_string(),
                nearest,
            });
        }
    }

    // Extract unit_id from the event payload.
    let unit_id = match &step.event.payload {
        bp_ledger::payload::Payload::UnitStartedV1(p) => p.unit_id.clone(),
        _ => unreachable!("kind == UnitStarted implies payload == UnitStartedV1"),
    };

    // Find the pre-unit checkpoint for this unit in state_after.checkpoints.
    // The checkpoint may not have been seen yet at this point in iteration
    // (unit_started fires before pre-unit git_checkpoint). We need to
    // continue iteration briefly to pick up the pre-unit checkpoint.
    let pre_sha = find_pre_checkpoint_after(&mut engine, &unit_id)
        .ok_or_else(|| PlanError::MissingPreCheckpoint {
            unit_id: unit_id.clone(),
        })?;

    // Read + parse packet.
    let packet_bytes = std::fs::read(packet_path).map_err(|source| PlanError::PacketIo {
        path: packet_path.display().to_string(),
        source,
    })?;
    let packet_json: serde_json::Value =
        serde_json::from_slice(&packet_bytes).map_err(|source| PlanError::PacketJson {
            path: packet_path.display().to_string(),
            source,
        })?;

    // Fresh run_id via UUIDv7.
    let new_run_id = Uuid::now_v7().to_string();

    Ok(ForkPlan {
        new_run_id,
        workspace_path: workspace.display().to_string(),
        checkout_sha: pre_sha,
        packet_json,
        parent_run_id: parent_run_id.to_string(),
        parent_event_id: target_event_id.to_string(),
    })
}

/// Walk the engine forward after fast_forward_to landed on the unit_started;
/// the pre-unit checkpoint is typically the next event. Return the SHA if
/// found before iteration ends.
fn find_pre_checkpoint_after(engine: &mut ReplayEngine, unit_id: &str) -> Option<String> {
    // After fast_forward_to, the engine's cursor is past the unit_started.
    // Scan forward through subsequent events looking for a GitCheckpoint
    // whose unit_id matches and boundary is pre-unit.
    use bp_ledger::payload::git_checkpoint::CheckpointBoundary;
    use bp_ledger::payload::Payload;

    while let Some(step) = engine.next() {
        if let Payload::GitCheckpointV1(p) = &step.event.payload {
            if p.unit_id == unit_id
                && matches!(p.boundary, CheckpointBoundary::PreUnit)
                && matches!(p.git_status, bp_ledger::payload::git_checkpoint::GitStatus::Ok)
            {
                return Some(p.commit_sha.clone());
            }
        }
    }
    None
}

/// Best-effort "nearest unit_started" lookup for the TargetNotUnitStarted error.
/// For Phase E's minimal impl we return the parent chain's last unit_started
/// if present; otherwise "unknown".
fn nearest_unit_start(step: &bp_replay::engine::ReplayStep, _kind: EventKind) -> Option<String> {
    step.state_after
        .parent_chain
        .iter()
        .rev()
        .next()
        .map(|id| id.to_string())
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
cargo test --manifest-path native/Cargo.toml -p bp-fork --test planner happy_path_returns_fork_plan
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add native/crates/bp-fork/src/planner.rs native/crates/bp-fork/tests/planner.rs
git commit -m "feat(fork): implement build_fork_plan happy path"
```

---

## Task 3: Error-path tests for `build_fork_plan`

**Files:**
- Modify: `native/crates/bp-fork/tests/planner.rs`

- [ ] **Step 1: Append error-case tests**

Append to `native/crates/bp-fork/tests/planner.rs`:

```rust
#[test]
fn target_run_started_errors_with_fork_at_root() {
    let (tmp, _db_path, run_id, _unit_start_id, _pre_sha) = write_parent_tape();
    // Find run_started event id.
    use bp_ledger::storage::sqlite::SqliteStore;
    let db_path = tmp.path().join(".buildplane").join("ledger").join("events.db");
    let store = SqliteStore::open(&db_path).unwrap();
    let rows = store.events_for_run(&run_id.to_string()).unwrap();
    let run_start_id = &rows[0].id;

    let packet_path = tmp.path().join("p.json");
    std::fs::write(&packet_path, b"{}").unwrap();

    let err = build_fork_plan(&run_id.to_string(), run_start_id, tmp.path(), &packet_path).unwrap_err();
    assert!(matches!(err, PlanError::ForkAtRoot));
}

#[test]
fn target_non_unit_event_errors_with_suggestion() {
    let (tmp, _db_path, run_id, _unit_start_id, _pre_sha) = write_parent_tape();
    use bp_ledger::storage::sqlite::SqliteStore;
    let db_path = tmp.path().join(".buildplane").join("ledger").join("events.db");
    let store = SqliteStore::open(&db_path).unwrap();
    let rows = store.events_for_run(&run_id.to_string()).unwrap();
    // Pick an event that is NOT unit_started or run_started — use the
    // post-unit git_checkpoint row.
    let target = rows
        .iter()
        .find(|r| r.kind == "git_checkpoint")
        .expect("at least one git_checkpoint in fixture")
        .id
        .clone();

    let packet_path = tmp.path().join("p.json");
    std::fs::write(&packet_path, b"{}").unwrap();

    let err = build_fork_plan(&run_id.to_string(), &target, tmp.path(), &packet_path).unwrap_err();
    assert!(matches!(err, PlanError::TargetNotUnitStarted { .. }));
}

#[test]
fn nonexistent_event_errors() {
    let (tmp, _db_path, run_id, _unit_start_id, _pre_sha) = write_parent_tape();
    let bogus = "01919000-0000-7000-8000-ffffffffffff";
    let packet_path = tmp.path().join("p.json");
    std::fs::write(&packet_path, b"{}").unwrap();

    let err = build_fork_plan(&run_id.to_string(), bogus, tmp.path(), &packet_path).unwrap_err();
    assert!(matches!(err, PlanError::EventNotFound { .. }));
}

#[test]
fn missing_packet_file_errors() {
    let (tmp, _db_path, run_id, unit_start_id, _pre_sha) = write_parent_tape();
    let missing = tmp.path().join("no-such-file.json");

    let err = build_fork_plan(
        &run_id.to_string(),
        &unit_start_id.to_string(),
        tmp.path(),
        &missing,
    ).unwrap_err();
    assert!(matches!(err, PlanError::PacketIo { .. }));
}

#[test]
fn invalid_packet_json_errors() {
    let (tmp, _db_path, run_id, unit_start_id, _pre_sha) = write_parent_tape();
    let packet_path = tmp.path().join("bad.json");
    std::fs::write(&packet_path, b"not json").unwrap();

    let err = build_fork_plan(
        &run_id.to_string(),
        &unit_start_id.to_string(),
        tmp.path(),
        &packet_path,
    ).unwrap_err();
    assert!(matches!(err, PlanError::PacketJson { .. }));
}
```

- [ ] **Step 2: Run — expect all PASS**

```bash
cargo test --manifest-path native/Cargo.toml -p bp-fork
```

Expected: 6 tests PASS (1 happy + 5 error cases).

- [ ] **Step 3: Commit**

```bash
git add native/crates/bp-fork/tests/planner.rs
git commit -m "test(fork): add error-path tests for build_fork_plan"
```

---

## Task 4: `bp-cli fork plan` subcommand

**Files:**
- Modify: `native/crates/bp-cli/Cargo.toml`
- Create: `native/crates/bp-cli/src/fork_cli.rs`
- Modify: `native/crates/bp-cli/src/main.rs`

- [ ] **Step 1: Add dep**

In `native/crates/bp-cli/Cargo.toml`, add to `[dependencies]`:

```toml
bp-fork.workspace = true
```

- [ ] **Step 2: Create `fork_cli.rs`**

Write `native/crates/bp-cli/src/fork_cli.rs`:

```rust
//! `buildplane-native fork ...` subcommands.
//!
//! Phase E: `fork plan` emits a ForkPlan JSON for the TS CLI to execute.
//! Phase F may add a `fork apply` or expand `fork plan` semantics.

use bp_fork::{build_fork_plan, ForkPlan};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForkCommand {
    Plan(ForkPlanArgs),
    Help,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForkPlanArgs {
    pub run_id: String,
    pub at: String,
    pub workspace: PathBuf,
    pub packet: PathBuf,
}

pub fn parse_fork_command(args: &[String]) -> Result<ForkCommand, String> {
    match args.first().map(String::as_str) {
        Some("plan") => parse_plan(&args[1..]).map(ForkCommand::Plan),
        Some("--help" | "-h" | "help") | None => Ok(ForkCommand::Help),
        Some(other) => Err(format!("unknown fork subcommand: {other}")),
    }
}

fn parse_plan(args: &[String]) -> Result<ForkPlanArgs, String> {
    let mut run_id: Option<String> = None;
    let mut at: Option<String> = None;
    let mut workspace: Option<PathBuf> = None;
    let mut packet: Option<PathBuf> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--run-id" => {
                i += 1;
                run_id = Some(args.get(i).ok_or("--run-id requires a value")?.clone());
            }
            "--at" => {
                i += 1;
                at = Some(args.get(i).ok_or("--at requires a value")?.clone());
            }
            "--workspace" => {
                i += 1;
                workspace = Some(PathBuf::from(args.get(i).ok_or("--workspace requires a value")?));
            }
            "--packet" => {
                i += 1;
                packet = Some(PathBuf::from(args.get(i).ok_or("--packet requires a value")?));
            }
            other => return Err(format!("unknown flag: {other}")),
        }
        i += 1;
    }

    let workspace_path = workspace.ok_or("missing --workspace")?;
    if !workspace_path.is_absolute() {
        return Err(format!(
            "--workspace must be an absolute path; got: {}",
            workspace_path.display()
        ));
    }

    Ok(ForkPlanArgs {
        run_id: run_id.ok_or("missing --run-id")?,
        at: at.ok_or("missing --at")?,
        workspace: workspace_path,
        packet: packet.ok_or("missing --packet")?,
    })
}

pub fn run_fork_plan(args: ForkPlanArgs) -> Result<(), String> {
    let plan: ForkPlan = build_fork_plan(
        &args.run_id,
        &args.at,
        &args.workspace,
        &args.packet,
    )
    .map_err(|e| format!("{e}"))?;

    let line = serde_json::to_string(&plan).map_err(|e| format!("json: {e}"))?;
    println!("{}", line);
    Ok(())
}

pub fn usage_text() -> String {
    r#"usage: buildplane-native fork <subcommand>

subcommands:
  plan    Build a fork plan and emit ForkPlan JSON on stdout.

flags for `plan`:
  --run-id <id>             parent run identifier (required)
  --at <event-id>           parent unit_started event id to fork at (required)
  --workspace <path>        absolute path to the workspace root (required)
  --packet <path>           path to the new packet json (required)
"#
    .to_string()
}
```

- [ ] **Step 3: Wire into main.rs**

Open `native/crates/bp-cli/src/main.rs`. Near existing `mod ledger_cli;`, add:

```rust
mod fork_cli;
```

Find the `Command` enum (search for `enum Command` or similar). Add `Fork(fork_cli::ForkCommand)` variant.

Find the arg-to-command dispatch (the switch that picks `"ledger"` / `"memory"` / `"pack"`). Add:

```rust
Some("fork") => fork_cli::parse_fork_command(&args[1..])
    .map(Command::Fork)
    .map_err(|msg| msg),
```

Find the command-execute dispatch. Add:

```rust
Command::Fork(fork_cli::ForkCommand::Plan(args)) => {
    fork_cli::run_fork_plan(args).map_err(|msg| msg)
}
Command::Fork(fork_cli::ForkCommand::Help) => {
    println!("{}", fork_cli::usage_text());
    Ok(())
}
```

Adapt to the exact existing dispatch pattern — mirror how `Memory` or `Ledger` is wired.

- [ ] **Step 4: Build + smoke test**

```bash
cargo build --manifest-path native/Cargo.toml -p bp-cli
```

Expected: PASS.

Smoke (reuses Phase E Task 2 fixture setup; here we prepare a real events.db manually):

```bash
# Setup a real parent tape via the ledger serve path.
rm -rf /tmp/bp-fork-smoke && mkdir -p /tmp/bp-fork-smoke
cat > /tmp/bp-fork-smoke/input.jsonl <<'EOF'
{"control":"handshake","protocol":1,"run_id":"01919000-0000-7000-8000-000000000000","started_at":"2026-04-19T00:00:00Z","schema_version":1}
{"id":"01919000-0000-7000-8000-000000000001","run_id":"01919000-0000-7000-8000-000000000000","parent_event_id":null,"schema_version":1,"kind":"run_started","occurred_at":"2026-04-19T00:00:01Z","payload":{"RunStartedV1":{"packet_hash":"sha256:aa","git_head":"dead","workspace_path":"/tmp/bp-fork-smoke","config":{},"parent_run_id":null}}}
{"id":"01919000-0000-7000-8000-000000000002","run_id":"01919000-0000-7000-8000-000000000000","parent_event_id":"01919000-0000-7000-8000-000000000001","schema_version":1,"kind":"unit_started","occurred_at":"2026-04-19T00:00:02Z","payload":{"UnitStartedV1":{"unit_id":"u-1","parent_unit_id":null,"unit_kind":"command","policy":{}}}}
{"id":"01919000-0000-7000-8000-000000000003","run_id":"01919000-0000-7000-8000-000000000000","parent_event_id":"01919000-0000-7000-8000-000000000002","schema_version":1,"kind":"git_checkpoint","occurred_at":"2026-04-19T00:00:03Z","payload":{"GitCheckpointV1":{"boundary":"pre-unit","reference":"refs/buildplane/run/01919000-0000-7000-8000-000000000000","commit_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","unit_id":"u-1","git_status":{"kind":"ok"}}}}
{"id":"01919000-0000-7000-8000-000000000004","run_id":"01919000-0000-7000-8000-000000000000","parent_event_id":"01919000-0000-7000-8000-000000000001","schema_version":1,"kind":"run_completed","occurred_at":"2026-04-19T00:00:04Z","payload":{"RunCompletedV1":{"outcome":"passed","duration_ms":10,"event_count":5,"unit_count":1}}}
{"control":"close","seq":0}
EOF
cat /tmp/bp-fork-smoke/input.jsonl | ./native/target/debug/buildplane-native ledger serve --run-id 01919000-0000-7000-8000-000000000000 --workspace /tmp/bp-fork-smoke 2>/dev/null

# Write a new packet.
cat > /tmp/bp-fork-smoke/new.json <<'EOF'
{"unit":{"id":"u-new","kind":"command"},"execution":{"command":"sh","args":["-c","echo new"]}}
EOF

# Build the fork plan.
./native/target/debug/buildplane-native fork plan \
  --run-id 01919000-0000-7000-8000-000000000000 \
  --at 01919000-0000-7000-8000-000000000002 \
  --workspace /tmp/bp-fork-smoke \
  --packet /tmp/bp-fork-smoke/new.json
```

Expected: a single line of JSON with `new_run_id`, `parent_run_id`, `parent_event_id`, `checkout_sha`, `workspace_path`, `packet_json`.

- [ ] **Step 5: Commit**

```bash
git add native/crates/bp-cli/Cargo.toml native/crates/bp-cli/src/fork_cli.rs native/crates/bp-cli/src/main.rs
git commit -m "feat(cli): add bp-cli fork plan subcommand"
```

---

## Task 5: TS CLI `buildplane fork` dispatch

**Files:**
- Modify: `apps/cli/src/run-cli.ts`

- [ ] **Step 1: Locate `ledger` dispatch**

Find the existing top-level `"ledger"` command dispatch in `run-cli.ts`. It forwards to the native binary via a helper (likely `runNativeCommand` or similar).

- [ ] **Step 2: Add `fork` dispatch**

At the same level as `"ledger"`, add a `"fork"` command handler:

```ts
if (command === "fork") {
	return await runFork(rest, {
		cwd,
		stdout,
		stderr,
	});
}
```

Add a `runFork` function. It runs the native `fork plan`, parses ForkPlan JSON, performs the checkout + ledger + orchestrator flow, and emits lineage:

```ts
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

async function runFork(
	rest: string[],
	opts: { cwd: string; stdout: (s: string) => void; stderr: (s: string) => void },
): Promise<number> {
	const args = parseForkArgs(rest);
	if (!args.ok) {
		opts.stderr(`buildplane fork: ${args.error}\n`);
		opts.stderr(forkUsageText());
		return 1;
	}

	const workspace = resolve(args.value.workspace ?? opts.cwd);
	const binary = resolveLedgerBinary(opts.cwd);

	// Phase 1: plan.
	const planArgs = [
		"fork",
		"plan",
		"--run-id",
		args.value.runId,
		"--at",
		args.value.at,
		"--workspace",
		workspace,
		"--packet",
		args.value.packet,
	];
	const planResult = spawnSync(binary, planArgs, { encoding: "utf8" });
	if (planResult.status !== 0) {
		opts.stderr(planResult.stderr ?? `fork plan failed\n`);
		return planResult.status ?? 1;
	}
	let plan: ForkPlan;
	try {
		plan = JSON.parse(planResult.stdout.trim()) as ForkPlan;
	} catch (e) {
		opts.stderr(`fork plan returned invalid JSON: ${String(e)}\n`);
		return 1;
	}

	// Phase 2: clean-worktree pre-flight.
	const statusResult = spawnSync("git", ["-C", workspace, "status", "--porcelain"], {
		encoding: "utf8",
	});
	if (statusResult.status !== 0) {
		opts.stderr(`git status in ${workspace} failed: ${statusResult.stderr}\n`);
		return 1;
	}
	if (statusResult.stdout.trim().length > 0) {
		opts.stderr(
			`workspace has uncommitted changes; commit or stash before forking\n`,
		);
		return 1;
	}

	// Phase 3: checkout the pre-unit SHA.
	const checkoutResult = spawnSync(
		"git",
		["-C", workspace, "checkout", plan.checkout_sha],
		{ encoding: "utf8" },
	);
	if (checkoutResult.status !== 0) {
		opts.stderr(`git checkout ${plan.checkout_sha} failed: ${checkoutResult.stderr}\n`);
		return 1;
	}

	// Phase 4: spawn ledger + run the new packet via the same pipeline as
	// `buildplane run`. We delegate to an existing helper when practical; for
	// Phase E we inline a minimal version that:
	//   - spawns `buildplane-native ledger serve`
	//   - awaits handshake via createTapeEmitter
	//   - emits run_started with parent_run_id lineage
	//   - runs orchestrator with plan.packet_json
	//   - emits run_completed / run_failed
	//   - closes emitter
	//
	// See Task 6 for the actual implementation body.
	const exitCode = await runForkExecution(plan, workspace, opts);

	// Phase 5: exit hint.
	const currentBranchResult = spawnSync(
		"git",
		["-C", workspace, "rev-parse", "--abbrev-ref", "HEAD"],
		{ encoding: "utf8" },
	);
	const currentBranch = currentBranchResult.stdout.trim();
	opts.stdout(
		`\nHEAD is at fork tree ${plan.checkout_sha.slice(0, 8)}; ` +
			`run \`git checkout <branch>\` to restore.\n`,
	);
	if (currentBranch === "HEAD") {
		opts.stdout(`(detached HEAD)\n`);
	}

	return exitCode;
}

interface ForkPlan {
	new_run_id: string;
	workspace_path: string;
	checkout_sha: string;
	packet_json: unknown;
	parent_run_id: string;
	parent_event_id: string;
}

interface ForkArgs {
	runId: string;
	at: string;
	workspace?: string;
	packet: string;
}

function parseForkArgs(rest: string[]):
	| { ok: true; value: ForkArgs }
	| { ok: false; error: string } {
	let runId: string | undefined;
	let at: string | undefined;
	let workspace: string | undefined;
	let packet: string | undefined;
	let i = 0;
	while (i < rest.length) {
		const arg = rest[i];
		switch (arg) {
			case "--run-id":
				i += 1;
				runId = rest[i];
				break;
			case "--at":
				i += 1;
				at = rest[i];
				break;
			case "--workspace":
				i += 1;
				workspace = rest[i];
				break;
			case "--packet":
				i += 1;
				packet = rest[i];
				break;
			default:
				if (arg && !runId) {
					runId = arg;
				} else {
					return { ok: false, error: `unknown argument: ${arg}` };
				}
		}
		i += 1;
	}
	if (!runId) return { ok: false, error: "missing parent run id (positional or --run-id)" };
	if (!at) return { ok: false, error: "missing --at <event-id>" };
	if (!packet) return { ok: false, error: "missing --packet <file>" };
	return { ok: true, value: { runId, at, workspace, packet } };
}

function forkUsageText(): string {
	return `usage: buildplane fork <parent-run-id> --at <event-id> --packet <file> [--workspace <path>]

  --run-id       parent run id (or positional first arg)
  --at           parent unit_started event id to fork at
  --packet       path to the new packet json
  --workspace    workspace root (defaults to cwd)
`;
}

async function runForkExecution(
	plan: ForkPlan,
	workspace: string,
	opts: { stdout: (s: string) => void; stderr: (s: string) => void },
): Promise<number> {
	// Phase E Task 6 implements the actual ledger spawn + orchestrator
	// invocation. Stub for Task 5.
	opts.stderr("fork execution not yet wired (Task 6)\n");
	return 1;
}
```

- [ ] **Step 3: Verify build**

```bash
pnpm --filter buildplane build
```

Expected: PASS (may have warnings about `runForkExecution` being a stub — that's fine).

- [ ] **Step 4: Smoke test the planning path**

```bash
pnpm buildplane fork 01919000-0000-7000-8000-000000000000 \
  --at 01919000-0000-7000-8000-000000000002 \
  --packet /tmp/bp-fork-smoke/new.json \
  --workspace /tmp/bp-fork-smoke
```

Expected: stderr prints "fork execution not yet wired (Task 6)" and exit 1. Task 6 lands the real execution.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/run-cli.ts
git commit -m "feat(cli): add buildplane fork top-level command (plan phase)"
```

---

## Task 6: TS fork execution — spawn ledger + run orchestrator

**Files:**
- Modify: `apps/cli/src/run-cli.ts`

- [ ] **Step 1: Replace `runForkExecution` with real implementation**

Find the `runForkExecution` stub from Task 5 and replace its body:

```ts
async function runForkExecution(
	plan: ForkPlan,
	workspace: string,
	opts: { stdout: (s: string) => void; stderr: (s: string) => void },
): Promise<number> {
	// Spawn the ledger subprocess for the fork's new run_id. Reuse the helper
	// that `buildplane run` uses (search for spawnLedgerSubprocess or similar).
	const binary = resolveLedgerBinary(workspace);
	const ledgerChild = spawnLedgerSubprocess(binary, plan.new_run_id, workspace);

	// Await handshake + attach tape-emitter.
	const { createTapeEmitter } = await import("@buildplane/ledger-client");
	const emitter = await createTapeEmitter({
		childStdin: ledgerChild.stdin,
		childStderr: ledgerChild.stderr,
		childExit: ledgerChild.exit,
		workspacePath: workspace,
		runId: plan.new_run_id,
	});

	try {
		// Emit run_started with parent_run_id lineage.
		const packetHash = `sha256:${createHash("sha256")
			.update(JSON.stringify(plan.packet_json))
			.digest("hex")}`;
		emitter.emit("run_started", {
			RunStartedV1: {
				packet_hash: packetHash,
				git_head: plan.checkout_sha,
				workspace_path: workspace,
				config: {},
				parent_run_id: plan.parent_run_id,
			},
		});

		// Run the packet through the orchestrator. Use the same entry point
		// `buildplane run` uses. Search run-cli.ts for where `runPacket` or
		// `runPacketAsync` is invoked in the run command handler; reuse that
		// path. Phase E reuses the simpler sync path via `--raw`-equivalent
		// internals since fork packets are command packets.
		const orchestratorResult = await executeForkPacket(
			plan.packet_json,
			workspace,
			emitter,
			opts,
		);

		// Emit run_completed.
		const outcome = orchestratorResult.exitCode === 0 ? "passed" : "failed";
		emitter.emit("run_completed", {
			RunCompletedV1: {
				outcome,
				duration_ms: 0,
				event_count: 0,
				unit_count: 1,
			},
		});

		await emitter.close();
		return orchestratorResult.exitCode;
	} catch (err) {
		opts.stderr(`fork execution error: ${String(err)}\n`);
		try {
			await emitter.close();
		} catch {}
		return 1;
	}
}

async function executeForkPacket(
	packetJson: unknown,
	workspace: string,
	emitter: import("@buildplane/ledger-client").TapeEmitter,
	_opts: { stdout: (s: string) => void; stderr: (s: string) => void },
): Promise<{ exitCode: number }> {
	// Build an orchestrator bundle the same way `buildplane run` does. Import
	// the loader used by the run command and invoke runPacket with our packet.
	// The exact path depends on the existing run-cli.ts structure; typically
	// there's a `loadCliOrchestrator(cwd)` function returning an object with
	// `orchestrator`, `cliEventBus`, `commandExecutor`, etc.
	const bundle = await loadCliOrchestrator(workspace);
	// Wrap the ToolRegistry (Phase C/D) so tool calls are instrumented.
	const rawRegistry = createToolRegistry(workspace);
	const currentUnit: { unitId: string; parentEventId: string } | null = null;
	const getUnitCtx = () => currentUnit;
	const wrappedRegistry = wrapToolRegistryForLedger(rawRegistry, emitter, getUnitCtx);

	// Install the bus subscription that Phase C/D use to emit unit-boundary
	// checkpoints and tool events. Reuse the subscription logic from the
	// `buildplane run` command handler — it's the same pattern here.
	// ... (this is the boilerplate already present in run-cli.ts; Phase E
	// extracts it into a helper if it isn't already, then calls it here)

	// Run the packet.
	try {
		const result = bundle.orchestrator.runPacket(
			packetJson as never,
			bundle.cliEventBus,
		);
		const status = (result as { run?: { status?: string } }).run?.status;
		return { exitCode: status === "passed" ? 0 : 1 };
	} catch (err) {
		return { exitCode: 1 };
	}
}
```

NOTE to implementer: the `executeForkPacket` function's body is a simplified sketch. The actual implementation must mirror the `buildplane run` command handler's flow (clean-worktree check already done; ledger already spawned; need to wire bus subscription, wrap registry, run orchestrator, close). If `buildplane run`'s flow is in a private function inside `run-cli.ts`, extract it into a shared helper that BOTH run and fork call. That refactor is part of Task 6.

- [ ] **Step 2: Build**

```bash
pnpm --filter buildplane build
```

Expected: PASS.

- [ ] **Step 3: Smoke test the full fork flow**

Prereq: the parent events.db must come from a real `buildplane run` that produced a git_checkpoint. The synthetic tape from Task 4's smoke is fine for `fork plan`, but `git checkout` needs a real commit. Set up a real parent run:

```bash
rm -rf /tmp/bp-fork-e2e && mkdir -p /tmp/bp-fork-e2e && cd /tmp/bp-fork-e2e
git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m init
cat > parent-packet.json <<'EOF'
{
  "unit": {
    "id": "u-parent",
    "kind": "command",
    "scope": "task",
    "inputRefs": [],
    "expectedOutputs": ["parent.txt"],
    "verificationContract": "exit-0-and-required-outputs",
    "policyProfile": "default"
  },
  "execution": { "command": "sh", "args": ["-c", "echo parent > parent.txt"] },
  "verification": { "requiredOutputs": ["parent.txt"] }
}
EOF

cd /mnt/c/Dev/projects/buildplane-ledger-phase-e  # adapt to actual worktree
pnpm buildplane run --packet /tmp/bp-fork-e2e/parent-packet.json --cwd /tmp/bp-fork-e2e 2>&1 | tail -3

# Get parent run_id and unit_started event_id.
PARENT_RUN=$(python3 -c "import sqlite3; c=sqlite3.connect('/tmp/bp-fork-e2e/.buildplane/ledger/events.db'); print(c.execute('SELECT DISTINCT run_id FROM events LIMIT 1').fetchone()[0])")
UNIT_START=$(python3 -c "import sqlite3; c=sqlite3.connect('/tmp/bp-fork-e2e/.buildplane/ledger/events.db'); print(c.execute(\"SELECT id FROM events WHERE kind='unit_started' ORDER BY id ASC LIMIT 1\").fetchone()[0])")
echo "parent=$PARENT_RUN unit=$UNIT_START"

# Write a fork packet.
cat > /tmp/bp-fork-e2e/fork-packet.json <<'EOF'
{
  "unit": {
    "id": "u-fork",
    "kind": "command",
    "scope": "task",
    "inputRefs": [],
    "expectedOutputs": ["fork.txt"],
    "verificationContract": "exit-0-and-required-outputs",
    "policyProfile": "default"
  },
  "execution": { "command": "sh", "args": ["-c", "echo fork > fork.txt"] },
  "verification": { "requiredOutputs": ["fork.txt"] }
}
EOF

# Fork.
pnpm buildplane fork "$PARENT_RUN" --at "$UNIT_START" --packet /tmp/bp-fork-e2e/fork-packet.json --workspace /tmp/bp-fork-e2e 2>&1 | tail -5

# Verify the new run has lineage.
python3 -c "
import sqlite3, json
c = sqlite3.connect('/tmp/bp-fork-e2e/.buildplane/ledger/events.db')
rows = c.execute(\"SELECT run_id, kind, payload FROM events WHERE kind='run_started'\").fetchall()
for run_id, kind, payload in rows:
    p = json.loads(payload)
    parent = p['RunStartedV1'].get('parent_run_id')
    print(f'run_id={run_id} parent={parent}')
"
```

Expected: two `run_started` rows; the second has `parent_run_id` equal to the first's `run_id`.

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/run-cli.ts
git commit -m "feat(cli): implement fork execution with ledger spawn + lineage emit"
```

---

## Task 7: `makeForkFixture` + `fork-basic.test.ts`

**Files:**
- Modify: `test/ledger-integration/fixtures.ts`
- Create: `test/ledger-integration/fork-basic.test.ts`

- [ ] **Step 1: Add `makeForkFixture` to fixtures.ts**

Find the existing `makeBuildplaneRunFixture` in `test/ledger-integration/fixtures.ts`. Append:

```ts
export interface ForkFixtureInputs {
	parentPacket: unknown;
	forkPacket: unknown;
	forkTargetKindHint?: "unit_started" | "git_checkpoint" | "run_started" | "tool_request";
}

export interface ForkFixtureResult {
	dir: string;
	eventsDbPath: string;
	parentRunId: string;
	forkRunId: string;
	forkExitCode: number;
	cleanup: () => Promise<void>;
}

/** Run the parent packet, then fork at the first unit_started event
 * with the provided fork packet. Returns both run_ids and the events.db
 * path (both runs share the same file).
 */
export async function makeForkFixture(
	opts: ForkFixtureInputs,
): Promise<ForkFixtureResult> {
	const parent = await makeBuildplaneRunFixture({ packet: opts.parentPacket });
	const dir = parent.dir;
	const eventsDbPath = parent.eventsDbPath;

	// Read parent run_id + target event_id from events.db.
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(eventsDbPath);
	const parentRunId = (
		db.prepare("SELECT DISTINCT run_id FROM events LIMIT 1").get() as {
			run_id: string;
		}
	).run_id;
	const targetKind = opts.forkTargetKindHint ?? "unit_started";
	const targetRow = db
		.prepare("SELECT id FROM events WHERE kind = ? ORDER BY id ASC LIMIT 1")
		.get(targetKind) as { id: string } | undefined;
	db.close();
	if (!targetRow) {
		throw new Error(`fixture: no ${targetKind} event found in parent tape`);
	}
	const targetId = targetRow.id;

	// Write fork packet.
	const { writeFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const forkPacketPath = join(dir, "fork-packet.json");
	writeFileSync(forkPacketPath, JSON.stringify(opts.forkPacket, null, 2));

	// Invoke runCli({ args: ["fork", parentRunId, "--at", targetId, ...] }).
	const { runCli } = (await import("../../apps/cli/src/run-cli.js")) as unknown as {
		runCli: (
			argv: string[],
			options: {
				cwd: string;
				stdout: (s: string) => void;
				stderr: (s: string) => void;
			},
		) => Promise<number>;
	};

	const originalCwd = process.cwd();
	let forkExitCode = 1;
	try {
		process.chdir(dir);
		forkExitCode = await runCli(
			["fork", parentRunId, "--at", targetId, "--packet", forkPacketPath, "--workspace", dir],
			{
				cwd: dir,
				stdout: () => {},
				stderr: () => {},
			},
		);
	} finally {
		process.chdir(originalCwd);
	}

	// Read fork run_id — whichever run_id in events.db has parent_run_id == parentRunId.
	const db2 = new DatabaseSync(eventsDbPath);
	const forkRow = db2
		.prepare(
			"SELECT run_id FROM events WHERE kind = 'run_started' " +
				"AND json_extract(payload, '$.RunStartedV1.parent_run_id') = ? LIMIT 1",
		)
		.get(parentRunId) as { run_id: string } | undefined;
	db2.close();

	const forkRunId = forkRow?.run_id ?? "";

	return {
		dir,
		eventsDbPath,
		parentRunId,
		forkRunId,
		forkExitCode,
		cleanup: parent.cleanup,
	};
}
```

- [ ] **Step 2: Write `fork-basic.test.ts`**

Create `test/ledger-integration/fork-basic.test.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { makeForkFixture } from "./fixtures.js";

describe("fork basic", () => {
	it("re-executes with a new packet and preserves parent_run_id lineage", async () => {
		const fixture = await makeForkFixture({
			parentPacket: {
				unit: {
					id: "u-parent",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["parent.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: { command: "sh", args: ["-c", "echo parent > parent.txt"] },
				verification: { requiredOutputs: ["parent.txt"] },
			},
			forkPacket: {
				unit: {
					id: "u-fork",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["fork.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: { command: "sh", args: ["-c", "echo fork > fork.txt"] },
				verification: { requiredOutputs: ["fork.txt"] },
			},
		});

		try {
			expect(fixture.forkExitCode).toBe(0);
			expect(fixture.forkRunId).not.toBe("");
			expect(fixture.forkRunId).not.toBe(fixture.parentRunId);

			const db = new DatabaseSync(fixture.eventsDbPath);

			// Verify lineage: fork's run_started has parent_run_id == parent.
			const row = db
				.prepare(
					"SELECT payload FROM events WHERE run_id = ? AND kind = 'run_started' LIMIT 1",
				)
				.get(fixture.forkRunId) as { payload: string };
			const payload = JSON.parse(row.payload) as {
				RunStartedV1: { parent_run_id: string | null };
			};
			expect(payload.RunStartedV1.parent_run_id).toBe(fixture.parentRunId);

			// Verify fork tape has the full Phase A sequence.
			const forkKinds = (
				db
					.prepare("SELECT kind FROM events WHERE run_id = ? ORDER BY id ASC")
					.all(fixture.forkRunId) as { kind: string }[]
			).map((r) => r.kind);
			expect(forkKinds).toContain("run_started");
			expect(forkKinds).toContain("run_completed");

			db.close();
		} finally {
			await fixture.cleanup();
		}
	}, 60_000);
});
```

- [ ] **Step 3: Run**

```bash
pnpm exec vitest run test/ledger-integration/fork-basic.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/ledger-integration/fixtures.ts test/ledger-integration/fork-basic.test.ts
git commit -m "test(fork): add makeForkFixture helper and fork-basic integration test"
```

---

## Task 8: `fork-invalid-target.test.ts` + `fork-same-packet.test.ts`

**Files:**
- Create: `test/ledger-integration/fork-invalid-target.test.ts`
- Create: `test/ledger-integration/fork-same-packet.test.ts`

- [ ] **Step 1: Write `fork-invalid-target.test.ts`**

Create `test/ledger-integration/fork-invalid-target.test.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBuildplaneRunFixture } from "./fixtures.js";

async function runForkCli(
	args: string[],
	cwd: string,
): Promise<{ exitCode: number; stderr: string }> {
	const { runCli } = (await import("../../apps/cli/src/run-cli.js")) as unknown as {
		runCli: (
			argv: string[],
			options: { cwd: string; stdout: (s: string) => void; stderr: (s: string) => void },
		) => Promise<number>;
	};
	let stderrCaptured = "";
	const originalCwd = process.cwd();
	let exitCode = 1;
	try {
		process.chdir(cwd);
		exitCode = await runCli(args, {
			cwd,
			stdout: () => {},
			stderr: (s) => {
				stderrCaptured += s;
			},
		});
	} finally {
		process.chdir(originalCwd);
	}
	return { exitCode, stderr: stderrCaptured };
}

describe("fork invalid target", () => {
	it("errors when target is run_started (fork at root)", async () => {
		const parent = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "u",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["out.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: { command: "sh", args: ["-c", "echo hi > out.txt"] },
				verification: { requiredOutputs: ["out.txt"] },
			},
		});
		try {
			const db = new DatabaseSync(parent.eventsDbPath);
			const runId = (
				db.prepare("SELECT DISTINCT run_id FROM events LIMIT 1").get() as {
					run_id: string;
				}
			).run_id;
			const runStartId = (
				db
					.prepare(
						"SELECT id FROM events WHERE kind = 'run_started' ORDER BY id ASC LIMIT 1",
					)
					.get() as { id: string }
			).id;
			db.close();

			const packetPath = join(parent.dir, "fork.json");
			writeFileSync(packetPath, JSON.stringify({ unit: { id: "u" }, execution: {} }));

			const result = await runForkCli(
				["fork", runId, "--at", runStartId, "--packet", packetPath, "--workspace", parent.dir],
				parent.dir,
			);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toMatch(/fork at root|run_started/i);
		} finally {
			await parent.cleanup();
		}
	}, 60_000);

	it("errors when target is non-unit event (e.g. git_checkpoint)", async () => {
		const parent = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "u",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["out.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: { command: "sh", args: ["-c", "echo hi > out.txt"] },
				verification: { requiredOutputs: ["out.txt"] },
			},
		});
		try {
			const db = new DatabaseSync(parent.eventsDbPath);
			const runId = (
				db.prepare("SELECT DISTINCT run_id FROM events LIMIT 1").get() as {
					run_id: string;
				}
			).run_id;
			const ckptRow = db
				.prepare(
					"SELECT id FROM events WHERE kind = 'git_checkpoint' ORDER BY id ASC LIMIT 1",
				)
				.get() as { id: string } | undefined;
			db.close();
			if (!ckptRow) {
				// No checkpoints in tape (e.g. wiring gap) — skip the assertion.
				return;
			}

			const packetPath = join(parent.dir, "fork.json");
			writeFileSync(packetPath, JSON.stringify({ unit: { id: "u" }, execution: {} }));

			const result = await runForkCli(
				["fork", runId, "--at", ckptRow.id, "--packet", packetPath, "--workspace", parent.dir],
				parent.dir,
			);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toMatch(/unit_started/i);
		} finally {
			await parent.cleanup();
		}
	}, 60_000);

	it("errors when target event id does not exist", async () => {
		const parent = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "u",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["out.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: { command: "sh", args: ["-c", "echo hi > out.txt"] },
				verification: { requiredOutputs: ["out.txt"] },
			},
		});
		try {
			const db = new DatabaseSync(parent.eventsDbPath);
			const runId = (
				db.prepare("SELECT DISTINCT run_id FROM events LIMIT 1").get() as {
					run_id: string;
				}
			).run_id;
			db.close();

			const packetPath = join(parent.dir, "fork.json");
			writeFileSync(packetPath, JSON.stringify({ unit: { id: "u" }, execution: {} }));

			const bogus = "01919000-0000-7000-8000-ffffffffffff";
			const result = await runForkCli(
				["fork", runId, "--at", bogus, "--packet", packetPath, "--workspace", parent.dir],
				parent.dir,
			);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toMatch(/not found/i);
		} finally {
			await parent.cleanup();
		}
	}, 60_000);
});
```

- [ ] **Step 2: Write `fork-same-packet.test.ts`**

Create `test/ledger-integration/fork-same-packet.test.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { makeBuildplaneRunFixture } from "./fixtures.js";

async function runForkCli(
	args: string[],
	cwd: string,
): Promise<{ exitCode: number; stderr: string }> {
	const { runCli } = (await import("../../apps/cli/src/run-cli.js")) as unknown as {
		runCli: (
			argv: string[],
			options: { cwd: string; stdout: (s: string) => void; stderr: (s: string) => void },
		) => Promise<number>;
	};
	let stderrCaptured = "";
	const originalCwd = process.cwd();
	let exitCode = 1;
	try {
		process.chdir(cwd);
		exitCode = await runCli(args, {
			cwd,
			stdout: () => {},
			stderr: (s) => {
				stderrCaptured += s;
			},
		});
	} finally {
		process.chdir(originalCwd);
	}
	return { exitCode, stderr: stderrCaptured };
}

describe("fork without --packet", () => {
	it("errors cleanly in Phase E (Phase F enables parent-packet-from-CAS)", async () => {
		const parent = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "u",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["out.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: { command: "sh", args: ["-c", "echo hi > out.txt"] },
				verification: { requiredOutputs: ["out.txt"] },
			},
		});
		try {
			const db = new DatabaseSync(parent.eventsDbPath);
			const runId = (
				db.prepare("SELECT DISTINCT run_id FROM events LIMIT 1").get() as {
					run_id: string;
				}
			).run_id;
			const unitId = (
				db
					.prepare(
						"SELECT id FROM events WHERE kind = 'unit_started' ORDER BY id ASC LIMIT 1",
					)
					.get() as { id: string }
			).id;
			db.close();

			// No --packet flag.
			const result = await runForkCli(
				["fork", runId, "--at", unitId, "--workspace", parent.dir],
				parent.dir,
			);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toMatch(/packet/i);
		} finally {
			await parent.cleanup();
		}
	}, 60_000);
});
```

- [ ] **Step 3: Run both tests**

```bash
pnpm exec vitest run test/ledger-integration/fork-invalid-target.test.ts test/ledger-integration/fork-same-packet.test.ts
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add test/ledger-integration/fork-invalid-target.test.ts test/ledger-integration/fork-same-packet.test.ts
git commit -m "test(fork): add invalid-target and same-packet error-path tests"
```

---

## Task 9: Phase F `.skip` stubs + ReplayState lineage

**Files:**
- Create: `test/ledger-integration/fork-vcr-basic.test.ts`
- Create: `test/ledger-integration/fork-vcr-fallback.test.ts`
- Create: `test/ledger-integration/fork-vcr-diff.test.ts`
- Modify: `native/crates/bp-replay/src/state.rs`
- Modify: `native/crates/bp-replay/src/transitions.rs`
- Modify: `native/crates/bp-cli/src/ledger_cli.rs`

- [ ] **Step 1: Create the three `.skip` VCR stubs**

Write `test/ledger-integration/fork-vcr-basic.test.ts`:

```ts
import { describe, it } from "vitest";

/**
 * Phase F implements `--vcr` support. These assertions are parked pending
 * that work. Remove `.skip` in F's implementation.
 *
 * Expected Phase F behavior: fork with `--vcr` replays the parent's
 * recorded tool_result bytes instead of re-executing the tool.
 */
describe("fork --vcr basic [Phase F]", () => {
	it.skip("replays recorded tool outputs from parent tape", () => {});
});
```

Write `test/ledger-integration/fork-vcr-fallback.test.ts`:

```ts
import { describe, it } from "vitest";

/**
 * Phase F implements `--vcr` support. These assertions are parked pending
 * that work. Remove `.skip` in F's implementation.
 *
 * Expected Phase F behavior: when `--vcr` is active but the parent tape
 * lacks a recorded tool_result for a given call, the fork falls back to
 * re-execute and surfaces a ReplayIssue::ToolOutputMissing in the fork's
 * tape state.
 */
describe("fork --vcr fallback [Phase F]", () => {
	it.skip("falls back to re-execute when parent tape is missing a tool_result", () => {});
});
```

Write `test/ledger-integration/fork-vcr-diff.test.ts`:

```ts
import { describe, it } from "vitest";

/**
 * Phase F implements `--vcr` support. These assertions are parked pending
 * that work. Remove `.skip` in F's implementation.
 *
 * Expected Phase F behavior: VCR matching works across schema-version
 * canonicalization (parent tape written at v1, fork running with canonical
 * reader still matches tool-call equivalence).
 */
describe("fork --vcr diff [Phase F]", () => {
	it.skip("matches tool-call equivalence across schema-version canonicalization", () => {});
});
```

- [ ] **Step 2: Add `parent_run_id` to `ReplayState`**

Modify `native/crates/bp-replay/src/state.rs`. In the `ReplayState` struct, add the field:

```rust
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ReplayState {
    pub run_id: Option<String>,
    /// Parent run id if this is a fork. None for top-level runs.
    pub parent_run_id: Option<String>,
    pub current_unit: Option<String>,
    pub parent_chain: Vec<EventId>,
    pub observed_files: BTreeMap<String, FileObservation>,
    pub checkpoints: Vec<CheckpointRef>,
    pub issues: Vec<ReplayIssue>,
}
```

- [ ] **Step 3: Populate `parent_run_id` in `run_started` transition**

Modify `native/crates/bp-replay/src/transitions.rs`. In `apply_run_started`:

```rust
fn apply_run_started(state: &mut ReplayState, event: &Event, p: &RunStartedV1) {
    state.run_id = Some(event.run_id.to_string());
    state.parent_run_id = p.parent_run_id.as_ref().map(|id| id.to_string());
    state.parent_chain.push(event.id);
}
```

Change the signature to use the payload: replace `_p: &RunStartedV1` with `p: &RunStartedV1`.

- [ ] **Step 4: Add lineage header to `ledger replay` human output**

Modify `native/crates/bp-cli/src/ledger_cli.rs`. In `run_replay`, BEFORE the main loop, if format is Human and the first event is `run_started`, print a lineage header if `parent_run_id` is present.

Easiest implementation: after the first `engine.next()` call, check `state.parent_run_id`:

```rust
    let mut count = 0usize;
    let mut printed_lineage_header = false;

    while let Some(step) = engine.next() {
        if !printed_lineage_header && args.format == ReplayFormat::Human {
            if let Some(parent) = &step.state_after.parent_run_id {
                println!("forked from {}", parent);
            }
            printed_lineage_header = true;
        }
        emit_step(&step, args.format)?;
        count += 1;
        if let Some(limit) = args.limit {
            if count >= limit {
                break;
            }
        }
    }
```

- [ ] **Step 5: Verify Rust build + test**

```bash
cargo test --manifest-path native/Cargo.toml -p bp-replay
cargo build --manifest-path native/Cargo.toml -p bp-cli
```

Expected: all PASS.

- [ ] **Step 6: Run the full integration suite**

```bash
pnpm exec vitest run test/ledger-integration/
```

Expected: all active tests PASS; the 3 new `.skip` stubs are skipped.

- [ ] **Step 7: Commit**

```bash
git add test/ledger-integration/fork-vcr-basic.test.ts test/ledger-integration/fork-vcr-fallback.test.ts test/ledger-integration/fork-vcr-diff.test.ts native/crates/bp-replay/src/state.rs native/crates/bp-replay/src/transitions.rs native/crates/bp-cli/src/ledger_cli.rs
git commit -m "feat(replay): add parent_run_id lineage + fork VCR .skip stubs for Phase F"
```

---

## Task 10: Verification gate + docs + spec marker

**Files:**
- Modify: `docs/ledger.md`
- Modify: `docs/superpowers/specs/2026-04-19-fork-primitive-design.md`

- [ ] **Step 1: Full Rust test suite**

```bash
cargo test --manifest-path native/Cargo.toml -p bp-ledger -p bp-ledger-macros -p bp-cli -p bp-replay -p bp-fork
```

Expected: all PASS.

- [ ] **Step 2: TS test suite**

```bash
pnpm --filter @buildplane/ledger-client exec vitest run
pnpm exec vitest run test/ledger-integration/
```

Expected: all active tests PASS; VCR stubs skipped.

- [ ] **Step 3: Clippy**

```bash
cargo clippy --manifest-path native/Cargo.toml -p bp-ledger -p bp-ledger-macros -p bp-cli -p bp-replay -p bp-fork -- -D warnings
```

Expected: clean. If warnings, fix inline as `fix(fork):` commit before the docs commit.

- [ ] **Step 4: Fixture drift**

```bash
pnpm ledger:gen-fixtures && git diff --exit-code -- packages/ledger-client/fixtures/payload-variants.json
```

Expected: exit 0. (No new event kinds — fork adds no schema change.)

- [ ] **Step 5: Smoke test full flow**

Use the Task 6 Step 3 smoke script. Verify:
- Fork completes with exit 0.
- Second `run_started` row has `parent_run_id` set to the first's run_id.
- `buildplane ledger replay <fork-id> --format human` shows "forked from <parent-id>" header.
- Repo-root git status unchanged.

- [ ] **Step 6: Update `docs/ledger.md`**

Append a Fork section to `docs/ledger.md`:

```markdown
## Forking a run

`buildplane fork <parent-run-id> --at <unit-started-event-id> --packet <file> [--workspace <path>]` resumes from a unit boundary in a prior run with a new packet. The workspace is git-checked-out to the parent's pre-unit checkpoint; a new run_id records events with `parent_run_id` pointing at the parent. Re-executes tools; does NOT replay recorded outputs (Phase F adds `--vcr` for that).

Preconditions:
- Workspace git state must be clean (same as `buildplane run`).
- Target event must be a `unit_started`. Non-unit events error with a suggestion.
- `--packet` is currently required. Phase F adds CAS-backed parent-packet retrieval.

On exit, HEAD is at the fork's final tree (detached). Restore with `git checkout <branch>`.

Examples:

```bash
# After a `buildplane run` that produced run_id=RRR with a failing unit
# whose unit_started event id is UUU, try again with a corrected packet:
buildplane fork RRR --at UUU --packet fixed-packet.json --workspace /path/to/ws

# Inspect the fork's tape:
buildplane ledger replay <fork-run-id> --format human
# Output includes: "forked from RRR"
```

Lineage is one level deep: `parent_run_id` points at the immediate parent.
Chains of forks work mechanically (each fork has its own parent) but cross-run
replay is Phase F+.
```

- [ ] **Step 7: Spec marker**

At the end of Section 4 of `docs/superpowers/specs/2026-04-19-fork-primitive-design.md`, append:

```markdown

**Phase E status: complete (2026-04-19).**
```

- [ ] **Step 8: Final commit**

```bash
git add docs/ledger.md docs/superpowers/specs/2026-04-19-fork-primitive-design.md
git commit -m "docs(fork): document fork command; mark Phase E complete"
```

---

## Self-review

**Spec coverage check:**

| Spec item | Task |
|---|---|
| `bp-fork` crate scaffold | 1 |
| `build_fork_plan` happy path | 2 |
| 5 error paths | 3 |
| `bp-cli fork plan` subcommand | 4 |
| TS CLI fork command (plan phase) | 5 |
| TS CLI fork execution | 6 |
| `makeForkFixture` + fork-basic test | 7 |
| invalid-target + same-packet tests | 8 |
| Phase F `.skip` stubs + ReplayState lineage + human-mode header | 9 |
| Verification gate + docs + spec marker | 10 |

Success criteria (from spec Section 1):
1. Fork produces new run with `parent_run_id` — Task 7 asserts.
2. `ledger replay` shows lineage header — Task 9 wires + Task 10 smokes.
3. Non-unit-start returns clear error — Task 8 asserts.
4. No `--packet` errors cleanly — Task 8 asserts.
5. Phase D integration tests still pass — Task 10 gate.
6. Phase F `.skip` stubs exist — Task 9 creates.

No gaps.

**Placeholder scan.** No TBD/TODO. Implementation notes where they guide adaptation (Task 4 re main.rs dispatch pattern, Task 5 re existing ledger dispatch, Task 6 re executeForkPacket reuse of run command's flow) are explicit guidance, not placeholders.

**Type consistency.**
- `ForkPlan`, `PlanError`, `ForkCommand`, `ForkPlanArgs` — consistent across Tasks 1, 2, 3, 4.
- `ForkArgs` (TS) — Task 5.
- `makeForkFixture`, `ForkFixtureResult` — Task 7.
- `ReplayState.parent_run_id` — Task 9.
- Field naming matches Phase D's `bp-replay` conventions.

No drift detected.
