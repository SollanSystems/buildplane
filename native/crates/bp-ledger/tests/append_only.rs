//! Verify the SQL triggers block UPDATE and DELETE on the events table.

use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
use bp_ledger::payload::Payload;
use bp_ledger::storage::sqlite::SqliteStore;
use chrono::Utc;

fn sample_event() -> Event {
    Event {
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
    }
}

#[test]
fn update_on_events_is_rejected() {
    let store = SqliteStore::open_in_memory().unwrap();
    let event = sample_event();
    store.append(&event).unwrap();

    let err = store
        .conn_for_tests()
        .execute("UPDATE events SET kind = 'tampered' WHERE id = ?1", [event.id.to_string()]);
    assert!(err.is_err(), "expected trigger to reject UPDATE");
    assert!(format!("{:?}", err.unwrap_err()).contains("append-only"));
}

#[test]
fn delete_on_events_is_rejected() {
    let store = SqliteStore::open_in_memory().unwrap();
    let event = sample_event();
    store.append(&event).unwrap();

    let err = store
        .conn_for_tests()
        .execute("DELETE FROM events WHERE id = ?1", [event.id.to_string()]);
    assert!(err.is_err(), "expected trigger to reject DELETE");
    assert!(format!("{:?}", err.unwrap_err()).contains("append-only"));
}

#[test]
fn duplicate_append_is_rejected() {
    let store = SqliteStore::open_in_memory().unwrap();
    let event = sample_event();
    store.append(&event).unwrap();
    let err = store.append(&event);
    assert!(err.is_err(), "expected PRIMARY KEY violation on duplicate id");
}
