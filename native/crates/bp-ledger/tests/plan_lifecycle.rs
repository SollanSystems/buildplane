use bp_ledger::canonicalize::{canonical_event_bytes, canonicalize_payload};
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::plan_lifecycle::{
    PlanAdmittedV1, PlanReceiptOutcome, PlanReceiptRecordedV1,
};
use bp_ledger::payload::Payload;
use chrono::Utc;

fn admitted() -> PlanAdmittedV1 {
    PlanAdmittedV1 {
        plan_id: "pf-plan-001".into(),
        plan_digest: "sha256:aa".into(),
        input_digest: "sha256:bb".into(),
        trusted_base: "deadbeef".into(),
        decided_by: "operator:khall".into(),
        decided_at: "2026-05-30T00:00:00Z".into(),
        idempotency_key: "planforge:v0:buildplane:deadbeef:abcd1234".into(),
        authorized_next_step: "dispatch_admitted_plan".into(),
    }
}

#[test]
fn plan_kinds_use_wire_names() {
    assert_eq!(EventKind::PlanAdmitted.as_wire(), "plan_admitted");
    assert_eq!(EventKind::PlanReceiptRecorded.as_wire(), "plan_receipt");
    assert_eq!(
        serde_json::to_string(&EventKind::PlanAdmitted).unwrap(),
        r#""plan_admitted""#
    );
}

#[test]
fn plan_admitted_canonicalizes_by_kind_and_variant() {
    let payload = Payload::PlanAdmittedV1(admitted());
    let value = serde_json::to_value(&payload).unwrap();
    match canonicalize_payload("plan_admitted", 1, value).unwrap() {
        Payload::PlanAdmittedV1(p) => {
            assert_eq!(p.plan_id, "pf-plan-001");
            assert_eq!(p.authorized_next_step, "dispatch_admitted_plan");
        }
        other => panic!("unexpected variant: {other:?}"),
    }
}

#[test]
fn plan_admitted_rejects_mismatched_kind() {
    let value = serde_json::to_value(Payload::PlanAdmittedV1(admitted())).unwrap();
    assert!(canonicalize_payload("plan_receipt", 1, value).is_err());
}

#[test]
fn plan_receipt_canonical_bytes_carry_chain_and_digest() {
    let event = Event {
        id: EventId::new(),
        run_id: RunId::new(),
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::PlanReceiptRecorded,
        occurred_at: Utc::now(),
        payload: Payload::PlanReceiptRecordedV1(PlanReceiptRecordedV1 {
            plan_id: "pf-plan-001".into(),
            admission_event_id: EventId::new(),
            outcome: PlanReceiptOutcome::Completed,
            side_effects: vec!["fs.write:declared_scope".into()],
            result_digest: "sha256:cc".into(),
            decided_at: "2026-05-30T00:01:00Z".into(),
        }),
    };
    let json = String::from_utf8(canonical_event_bytes(&event).unwrap()).unwrap();
    assert!(json.contains("plan_receipt"));
    assert!(json.contains("admission_event_id"));
    assert!(json.contains("result_digest"));
    assert!(json.contains("completed"));
}
