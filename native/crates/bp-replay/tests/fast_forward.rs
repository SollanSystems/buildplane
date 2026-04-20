//! Fast-forward semantics tests.

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
    store.append(&Event {
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
            parent_event_id: None,
        }),
    }).unwrap();

    let unit_start_id = EventId::new();
    ids.push(unit_start_id);
    store.append(&Event {
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
    }).unwrap();

    let run_complete_id = EventId::new();
    ids.push(run_complete_id);
    store.append(&Event {
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
    }).unwrap();

    ids
}

#[test]
fn fast_forward_to_target_returns_state_at_that_event() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("events.db");
    let run_id = RunId::new();
    let ids = write_multistep_tape(&db_path, run_id);

    let mut engine = ReplayEngine::open(&run_id.to_string(), &db_path).unwrap();
    let step = engine.fast_forward_to(ids[1]).unwrap();

    assert_eq!(step.event.id, ids[1]);
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
