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
