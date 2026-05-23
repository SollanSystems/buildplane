//! Verify the SQL triggers block UPDATE and DELETE on the events table.

use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
use bp_ledger::payload::Payload;
use bp_ledger::storage::sqlite::SqliteStore;
use chrono::Utc;

const INSERT_SIGNATURE_SQL: &str = r#"
    INSERT INTO event_signatures (
        event_id,
        canonical_event_hash,
        actor_id,
        key_id,
        public_key_hash,
        algorithm,
        signature,
        signed_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
"#;

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

    let err = store.conn_for_tests().execute(
        "UPDATE events SET kind = 'tampered' WHERE id = ?1",
        [event.id.to_string()],
    );
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
    assert!(
        err.is_err(),
        "expected PRIMARY KEY violation on duplicate id"
    );
}

#[test]
fn event_signatures_table_exists() {
    let store = SqliteStore::open_in_memory().unwrap();
    let exists: i64 = store
        .conn_for_tests()
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'event_signatures'",
            [],
            |row| row.get(0),
        )
        .unwrap();

    assert_eq!(exists, 1, "event_signatures table should exist");
}

#[test]
fn update_on_event_signatures_is_rejected() {
    let store = SqliteStore::open_in_memory().unwrap();
    let event = sample_event();
    store.append(&event).unwrap();
    insert_signature_for_event(&store, event.id.to_string()).unwrap();

    let err = store.conn_for_tests().execute(
        "UPDATE event_signatures SET signature = 'tampered' WHERE event_id = ?1",
        [event.id.to_string()],
    );

    assert!(err.is_err(), "expected trigger to reject signature UPDATE");
    assert!(format!("{:?}", err.unwrap_err()).contains("append-only"));
}

#[test]
fn delete_on_event_signatures_is_rejected() {
    let store = SqliteStore::open_in_memory().unwrap();
    let event = sample_event();
    store.append(&event).unwrap();
    insert_signature_for_event(&store, event.id.to_string()).unwrap();

    let err = store.conn_for_tests().execute(
        "DELETE FROM event_signatures WHERE event_id = ?1",
        [event.id.to_string()],
    );

    assert!(err.is_err(), "expected trigger to reject signature DELETE");
    assert!(format!("{:?}", err.unwrap_err()).contains("append-only"));
}

#[test]
fn duplicate_signature_append_is_rejected() {
    let store = SqliteStore::open_in_memory().unwrap();
    let event = sample_event();
    store.append(&event).unwrap();
    insert_signature_for_event(&store, event.id.to_string()).unwrap();

    let err = insert_signature_for_event(&store, event.id.to_string());

    assert!(
        err.is_err(),
        "expected PRIMARY KEY violation on duplicate signature"
    );
}

#[test]
fn signature_for_missing_event_is_rejected() {
    let store = SqliteStore::open_in_memory().unwrap();

    let err = insert_signature_for_event(&store, EventId::new().to_string());

    assert!(
        err.is_err(),
        "expected FOREIGN KEY violation for missing event"
    );
}

fn insert_signature_for_event(
    store: &SqliteStore,
    event_id: String,
) -> std::result::Result<usize, rusqlite::Error> {
    store.conn_for_tests().execute(
        INSERT_SIGNATURE_SQL,
        rusqlite::params![
            event_id,
            "sha256:71ad93c5d6863d077cbdd5f885275e2ebac705364c44631875c9044eaffe6a08",
            "kernel",
            "kernel-main",
            "sha256:public-key",
            "ed25519",
            "base64url-signature",
            "2026-05-21T21:30:00Z",
        ],
    )
}
