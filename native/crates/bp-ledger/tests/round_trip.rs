//! Round-trip events through SQLite.

use bp_ledger::canonicalize::canonicalize_payload;
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome, RunStartedV1};
use bp_ledger::payload::unit_lifecycle::UnitStartedV1;
use bp_ledger::payload::workspace::WorkspaceReadV1;
use bp_ledger::payload::Payload;
use bp_ledger::storage::sqlite::SqliteStore;
use chrono::Utc;
use std::collections::BTreeMap;

fn build(run_id: RunId, parent: Option<EventId>, kind: EventKind, payload: Payload) -> Event {
    Event {
        id: EventId::new(),
        run_id,
        parent_event_id: parent,
        schema_version: 1,
        kind,
        occurred_at: Utc::now(),
        payload,
    }
}

#[test]
fn events_for_run_returns_in_insert_order() {
    let store = SqliteStore::open_in_memory().unwrap();
    let run_id = RunId::new();

    let started = build(
        run_id,
        None,
        EventKind::RunStarted,
        Payload::RunStartedV1(RunStartedV1 {
            packet_hash: "sha256:aa".into(),
            git_head: "deadbeef".into(),
            workspace_path: "/tmp/ws".into(),
            config: BTreeMap::new(),
            parent_run_id: None,
            parent_event_id: None,
        }),
    );
    let unit = build(
        run_id,
        Some(started.id),
        EventKind::UnitStarted,
        Payload::UnitStartedV1(UnitStartedV1 {
            unit_id: "u-1".into(),
            parent_unit_id: None,
            unit_kind: "command".into(),
            policy: serde_json::json!({}),
        }),
    );
    let done = build(
        run_id,
        Some(started.id),
        EventKind::RunCompleted,
        Payload::RunCompletedV1(RunCompletedV1 {
            outcome: RunOutcome::Passed,
            duration_ms: 1,
            event_count: 3,
            unit_count: 1,
        }),
    );

    store.append(&started).unwrap();
    store.append(&unit).unwrap();
    store.append(&done).unwrap();

    let rows = store.events_for_run(&run_id.to_string()).unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].kind, "run_started");
    assert_eq!(rows[1].kind, "unit_started");
    assert_eq!(rows[2].kind, "run_completed");
}

#[test]
fn payload_round_trips_through_canonicalize() {
    let store = SqliteStore::open_in_memory().unwrap();
    let run_id = RunId::new();
    let event = build(
        run_id,
        None,
        EventKind::WorkspaceRead,
        Payload::WorkspaceReadV1(WorkspaceReadV1 {
            tool_request_id: EventId::new(),
            path: "README.md".into(),
            content_hash: "sha256:bb".into(),
            size_bytes: 42,
        }),
    );
    store.append(&event).unwrap();

    let rows = store.events_for_run(&run_id.to_string()).unwrap();
    let payload_json: serde_json::Value = serde_json::from_str(&rows[0].payload).unwrap();
    let canonical = canonicalize_payload(&rows[0].kind, rows[0].schema_version, payload_json).unwrap();

    match canonical {
        Payload::WorkspaceReadV1(p) => {
            assert_eq!(p.path, "README.md");
            assert_eq!(p.content_hash, "sha256:bb");
            assert_eq!(p.size_bytes, 42);
        }
        other => panic!("unexpected payload variant: {other:?}"),
    }
}
