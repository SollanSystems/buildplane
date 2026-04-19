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
