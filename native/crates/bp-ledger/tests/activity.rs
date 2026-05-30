use bp_ledger::canonicalize::{canonical_event_bytes, canonicalize_payload};
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::activity::{ActivityCompletedV1, ActivityStartedV1, ActivityType};
use bp_ledger::payload::Payload;
use chrono::Utc;
use serde_json::json;

#[test]
fn activity_kinds_use_wire_names() {
    assert_eq!(EventKind::ActivityStarted.as_wire(), "activity_started");
    assert_eq!(EventKind::ActivityCompleted.as_wire(), "activity_completed");
}

#[test]
fn activity_started_canonicalizes_by_kind_and_variant() {
    let payload = Payload::ActivityStartedV1(ActivityStartedV1 {
        run_id: RunId::new(),
        activity_id: "act-1".into(),
        activity_type: ActivityType::Tool,
        input_digest: "sha256:dd".into(),
    });
    let value = serde_json::to_value(&payload).unwrap();
    match canonicalize_payload("activity_started", 1, value).unwrap() {
        Payload::ActivityStartedV1(p) => {
            assert_eq!(p.activity_id, "act-1");
            assert_eq!(p.activity_type, ActivityType::Tool);
        }
        other => panic!("unexpected variant: {other:?}"),
    }
}

#[test]
fn activity_completed_canonical_bytes_carry_result_and_digest() {
    let event = Event {
        id: EventId::new(),
        run_id: RunId::new(),
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::ActivityCompleted,
        occurred_at: Utc::now(),
        payload: Payload::ActivityCompletedV1(ActivityCompletedV1 {
            run_id: RunId::new(),
            activity_id: "act-1".into(),
            result_digest: "sha256:ee".into(),
            result: json!({"content": "ok"}),
        }),
    };
    let bytes = canonical_event_bytes(&event).unwrap();
    let s = String::from_utf8(bytes).unwrap();
    assert!(s.contains("activity_completed"));
    assert!(s.contains("result_digest"));
    assert!(s.contains("\"result\""));
}

#[test]
fn activity_completed_rejects_mismatched_kind() {
    let value = serde_json::to_value(Payload::ActivityCompletedV1(ActivityCompletedV1 {
        run_id: RunId::new(),
        activity_id: "act-1".into(),
        result_digest: "sha256:ee".into(),
        result: json!({}),
    }))
    .unwrap();
    assert!(canonicalize_payload("activity_started", 1, value).is_err());
}
