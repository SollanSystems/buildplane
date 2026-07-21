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
                parent_event_id: None,
            }),
        ))
        .unwrap();
    store
        .append(&event_of(
            run_id,
            EventKind::RunCompleted,
            Payload::RunCompletedV1(RunCompletedV1 {
                outcome: RunOutcome::Passed,
                duration_ms: "10".into(),
                event_count: "2".into(),
                unit_count: "0".into(),
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

#[test]
fn verified_events_exposes_the_immutable_open_snapshot_without_advancing_replay() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("events.db");
    let run_id = RunId::new();
    write_sample_tape(&db_path, run_id);

    let mut engine = ReplayEngine::open(&run_id.to_string(), &db_path).unwrap();
    let snapshot_ids = engine
        .verified_events()
        .iter()
        .map(|verified| verified.event.id)
        .collect::<Vec<_>>();

    assert_eq!(snapshot_ids.len(), 2);
    assert_eq!(engine.next().unwrap().event.id, snapshot_ids[0]);
    assert_eq!(
        engine
            .verified_events()
            .iter()
            .map(|verified| verified.event.id)
            .collect::<Vec<_>>(),
        snapshot_ids,
        "replay progress must not mutate or truncate the opened verification snapshot"
    );
}
