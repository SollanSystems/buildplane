//! Canonicalize integration tests — v1 passthrough discipline.

use bp_ledger::canonicalize::canonicalize;
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
use bp_ledger::payload::Payload;
use chrono::Utc;

#[test]
fn v1_passes_through_unchanged() {
    let original = Event {
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
    let out = canonicalize(original.clone()).unwrap();
    assert_eq!(out, original);
}

#[test]
fn unsupported_schema_version_errors() {
    let event = Event {
        id: EventId::new(),
        run_id: RunId::new(),
        parent_event_id: None,
        schema_version: 99,
        kind: EventKind::RunCompleted,
        occurred_at: Utc::now(),
        payload: Payload::RunCompletedV1(RunCompletedV1 {
            outcome: RunOutcome::Passed,
            duration_ms: 0,
            event_count: 0,
            unit_count: 0,
        }),
    };
    let err = canonicalize(event).unwrap_err();
    assert!(matches!(err, bp_ledger::LedgerError::UnsupportedSchemaVersion { .. }));
}
