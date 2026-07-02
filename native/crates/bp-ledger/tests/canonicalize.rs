//! Canonicalize integration tests — v1 passthrough discipline.

use bp_ledger::canonicalize::{canonical_event_hash, canonicalize};
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
use bp_ledger::payload::workspace::WorkspaceReadV1;
use bp_ledger::payload::Payload;
use chrono::{DateTime, Utc};
use uuid::Uuid;

// M6-S7 (A3): `RunCompletedV1.{duration_ms,event_count,unit_count}` now serialize
// as strings on the wire (per-field override, matching `ResultReadyV1`), so the
// canonical hash of this fixture changed by design. Safe with no tape migration —
// `run_completed` was never emitted/signed onto any real tape.
const SIGNED_EVENT_FIXTURE_HASH: &str =
    "sha256:cf4d98cefe28f6257bcb290e3aac9664efc8c7756d85d8bf2d597eed91ae2f65";

fn fixed_signed_event_fixture() -> Event {
    Event {
        id: EventId::from_uuid(Uuid::parse_str("01919000-0000-7000-8000-000000000101").unwrap()),
        run_id: RunId::from_uuid(Uuid::parse_str("01919000-0000-7000-8000-000000000000").unwrap()),
        parent_event_id: Some(EventId::from_uuid(
            Uuid::parse_str("01919000-0000-7000-8000-000000000100").unwrap(),
        )),
        schema_version: 1,
        kind: EventKind::RunCompleted,
        occurred_at: "2026-05-21T21:29:00Z".parse::<DateTime<Utc>>().unwrap(),
        payload: Payload::RunCompletedV1(RunCompletedV1 {
            outcome: RunOutcome::Passed,
            duration_ms: "1234".into(),
            event_count: "7".into(),
            unit_count: "2".into(),
        }),
    }
}

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
            duration_ms: "0".into(),
            event_count: "0".into(),
            unit_count: "0".into(),
        }),
    };
    let out = canonicalize(original.clone()).unwrap();
    assert_eq!(out, original);
}

#[test]
fn canonical_event_hash_for_signed_fixture_is_stable() {
    let event = fixed_signed_event_fixture();
    let hash = canonical_event_hash(&event).unwrap();

    assert_eq!(hash, SIGNED_EVENT_FIXTURE_HASH);
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
            duration_ms: "0".into(),
            event_count: "0".into(),
            unit_count: "0".into(),
        }),
    };
    let err = canonicalize(event).unwrap_err();
    assert!(matches!(
        err,
        bp_ledger::LedgerError::UnsupportedSchemaVersion { .. }
    ));
}

#[test]
fn mismatched_kind_and_payload_errors() {
    let event = Event {
        id: EventId::new(),
        run_id: RunId::new(),
        parent_event_id: None,
        schema_version: 1,
        kind: EventKind::RunCompleted,
        occurred_at: Utc::now(),
        payload: Payload::WorkspaceReadV1(WorkspaceReadV1 {
            tool_request_id: EventId::new(),
            path: "README.md".into(),
            content_hash: "abc123".into(),
            size_bytes: 12,
        }),
    };
    let err = canonicalize(event).unwrap_err();
    assert!(matches!(err, bp_ledger::LedgerError::InvalidPayload { .. }));
}
