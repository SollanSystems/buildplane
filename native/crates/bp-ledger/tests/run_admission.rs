use bp_ledger::canonicalize::{canonical_event_bytes, canonicalize_payload};
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::run_lifecycle::{
    RunAdmissionDecision, RunAdmissionDeniedSideEffectV1, RunAdmissionEvidenceInputV1,
    RunAdmissionRecordedV1,
};
use bp_ledger::payload::Payload;
use chrono::Utc;

fn pass_payload() -> RunAdmissionRecordedV1 {
    RunAdmissionRecordedV1 {
        receipt_id: "receipt-bp5b-pass".into(),
        receipt_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            .into(),
        receipt_ref: Some(
            "cas:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        ),
        idempotency_key: "admission:normalized-inputs:001".into(),
        decision: RunAdmissionDecision::Pass,
        policy_profile_id: "reviewed-green".into(),
        requested_side_effects: vec!["fs.write:declared_scope".into()],
        allowed_side_effects: vec!["fs.write:declared_scope".into()],
        denied_side_effects: Vec::new(),
        missing_evidence: Vec::new(),
        unsafe_requests: Vec::new(),
        evidence_inputs: vec![RunAdmissionEvidenceInputV1 {
            kind: "git.status".into(),
            reference: "evidence/git-status.txt".into(),
            digest: Some(
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
            ),
            required: true,
            status: "present".into(),
            reason: None,
        }],
        quarantine: false,
        will_execute_worker: true,
        authorized_next_step: "dispatch_after_admission_append".into(),
        decided_by: "buildplane.kernel.admission".into(),
        decided_at: "2026-05-24T22:41:16Z".into(),
    }
}

fn unsafe_payload() -> RunAdmissionRecordedV1 {
    RunAdmissionRecordedV1 {
        receipt_id: "receipt-bp5b-unsafe".into(),
        receipt_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
            .into(),
        receipt_ref: None,
        idempotency_key: "admission:normalized-inputs:002".into(),
        decision: RunAdmissionDecision::UnsafeToRun,
        policy_profile_id: "reviewed-green".into(),
        requested_side_effects: vec!["github.pr.merge".into(), "deploy:production".into()],
        allowed_side_effects: vec![],
        denied_side_effects: vec![RunAdmissionDeniedSideEffectV1 {
            effect: "github.pr.merge".into(),
            reason: "Merge requires separate operator approval.".into(),
        }],
        missing_evidence: vec!["operator_approval".into()],
        unsafe_requests: vec!["github.pr.merge".into(), "deploy:production".into()],
        evidence_inputs: vec![RunAdmissionEvidenceInputV1 {
            kind: "operator.approval".into(),
            reference: "evidence/operator-approval.json".into(),
            digest: None,
            required: true,
            status: "missing".into(),
            reason: Some("No explicit merge/deploy approval recorded.".into()),
        }],
        quarantine: true,
        will_execute_worker: false,
        authorized_next_step: "freeze_and_require_explicit_release_authority".into(),
        decided_by: "buildplane.kernel.admission".into(),
        decided_at: "2026-05-24T22:41:17Z".into(),
    }
}

#[test]
fn run_admission_event_kind_uses_wire_name() {
    let json = serde_json::to_string(&EventKind::RunAdmissionRecorded).unwrap();
    assert_eq!(json, r#""run_admission_recorded""#);
    assert_eq!(
        EventKind::RunAdmissionRecorded.as_wire(),
        "run_admission_recorded"
    );
}

#[test]
fn run_admission_recorded_pass_round_trips() {
    let payload = pass_payload();
    let serialized = serde_json::to_string(&payload).unwrap();
    let back: RunAdmissionRecordedV1 = serde_json::from_str(&serialized).unwrap();
    assert_eq!(payload, back);
    assert_eq!(back.decision, RunAdmissionDecision::Pass);
    assert!(back.will_execute_worker);
    assert!(!back.quarantine);
}

#[test]
fn run_admission_recorded_unsafe_round_trips_fail_closed() {
    let payload = unsafe_payload();
    let serialized = serde_json::to_string(&payload).unwrap();
    let value: serde_json::Value = serde_json::from_str(&serialized).unwrap();
    assert_eq!(value["decision"], "UNSAFE_TO_RUN");
    assert_eq!(value["quarantine"], true);
    assert_eq!(value["will_execute_worker"], false);
    assert!(value.get("receipt_ref").is_none());
    assert!(value["evidence_inputs"][0].get("digest").is_none());

    let back: RunAdmissionRecordedV1 = serde_json::from_value(value).unwrap();
    assert_eq!(back.decision, RunAdmissionDecision::UnsafeToRun);
    assert!(back.quarantine);
    assert!(!back.will_execute_worker);
    assert_eq!(
        back.unsafe_requests,
        vec!["github.pr.merge", "deploy:production"]
    );
}

#[test]
fn run_admission_payload_canonicalizes_by_kind_and_variant() {
    let payload = Payload::RunAdmissionRecordedV1(pass_payload());
    let payload_json = serde_json::to_value(&payload).unwrap();
    let canonical = canonicalize_payload("run_admission_recorded", 1, payload_json).unwrap();
    match canonical {
        Payload::RunAdmissionRecordedV1(recorded) => {
            assert_eq!(recorded.receipt_id, "receipt-bp5b-pass");
            assert_eq!(
                recorded.receipt_digest,
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            );
            assert_eq!(recorded.idempotency_key, "admission:normalized-inputs:001");
            assert_eq!(
                recorded.authorized_next_step,
                "dispatch_after_admission_append"
            );
        }
        other => panic!("unexpected payload variant: {other:?}"),
    }
}

#[test]
fn run_admission_canonical_event_bytes_include_compact_summary_not_raw_prose_or_secrets() {
    let event = Event {
        id: EventId::new(),
        run_id: RunId::new(),
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::RunAdmissionRecorded,
        occurred_at: Utc::now(),
        payload: Payload::RunAdmissionRecordedV1(pass_payload()),
    };

    let bytes = canonical_event_bytes(&event).unwrap();
    let json = String::from_utf8(bytes).unwrap();
    assert!(json.contains("run_admission_recorded"));
    assert!(json.contains("receipt_digest"));
    assert!(json.contains("idempotency_key"));
    assert!(json.contains("denied_side_effects"));
    assert!(!json.contains("ghp_"));
    assert!(!json.contains("API_KEY"));
    assert!(!json.contains("model confidence"));
    assert!(!json.contains("worker_prose"));
    assert!(!json.contains("raw_receipt"));
}
