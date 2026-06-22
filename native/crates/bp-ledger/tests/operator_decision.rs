//! M5-S1: `operator_decision_recorded` tape vocabulary.

use bp_ledger::canonicalize::canonicalize_payload;
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::operator_decision::OperatorDecisionRecordedV1;
use bp_ledger::payload::Payload;
use bp_ledger::signing::{ActorKeyRef, TrustedPublicKeys, VerificationStatus};
use bp_ledger::storage::sqlite::SqliteStore;
use chrono::Utc;
use ed25519_dalek::SigningKey;
use sha2::{Digest, Sha256};

const FIXTURE_SEED: [u8; 32] = [23u8; 32];

fn operator_decision_payload() -> OperatorDecisionRecordedV1 {
    OperatorDecisionRecordedV1 {
        run_id: "01919000-0000-7000-8000-0000000000ff".into(),
        decision: "approved".into(),
        subject: "merge".into(),
        acceptance_event_id: Some("01919000-0000-7000-8000-000000000005".into()),
        admission_event_id: Some("01919000-0000-7000-8000-000000000004".into()),
        merge_commit: Some("deadbeef".into()),
        decided_by: "operator@buildplane".into(),
        decided_at: "2026-06-22T12:00:00Z".into(),
    }
}

#[test]
fn operator_decision_recorded_v1_round_trips() {
    let p = operator_decision_payload();
    let s = serde_json::to_string(&p).unwrap();
    assert_eq!(
        p,
        serde_json::from_str::<OperatorDecisionRecordedV1>(&s).unwrap()
    );
}

#[test]
fn operator_decision_recorded_canonical_bytes_are_stable() {
    let payload = Payload::OperatorDecisionRecordedV1(operator_decision_payload());
    let first = serde_json::to_vec(&payload).unwrap();
    let second = serde_json::to_vec(&payload).unwrap();
    assert_eq!(first, second);
}

#[test]
fn operator_decision_recorded_wire_kind_matches_payload_variant() {
    assert_eq!(
        EventKind::OperatorDecisionRecorded.as_wire(),
        "operator_decision_recorded"
    );
    assert_eq!(
        serde_json::to_string(&EventKind::OperatorDecisionRecorded).unwrap(),
        r#""operator_decision_recorded""#
    );
}

#[test]
fn operator_decision_recorded_canonicalizes_by_kind_and_variant() {
    let payload = Payload::OperatorDecisionRecordedV1(operator_decision_payload());
    let value = serde_json::to_value(&payload).unwrap();
    match canonicalize_payload("operator_decision_recorded", 1, value).unwrap() {
        Payload::OperatorDecisionRecordedV1(p) => {
            assert_eq!(p.decision, "approved");
            assert_eq!(p.subject, "merge");
        }
        other => panic!("unexpected payload {other:?}"),
    }
}

#[test]
fn operator_decision_recorded_rejects_mismatched_kind() {
    let payload = Payload::OperatorDecisionRecordedV1(operator_decision_payload());
    let value = serde_json::to_value(&payload).unwrap();
    let err = canonicalize_payload("acceptance_recorded", 1, value).unwrap_err();
    assert!(err.to_string().contains("AcceptanceRecordedV1"));
}

#[test]
fn signed_operator_decision_recorded_appends_and_verifies() {
    let signing_key = SigningKey::from_bytes(&FIXTURE_SEED);
    let mut trusted = TrustedPublicKeys::default();
    let hash = format!(
        "sha256:{:x}",
        Sha256::digest(signing_key.verifying_key().as_bytes())
    );
    trusted.insert_public_key(hash, signing_key.verifying_key().to_bytes().to_vec());

    let store = SqliteStore::open_in_memory().unwrap();
    let run_id = RunId::new();
    let event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: 1,
        kind: EventKind::OperatorDecisionRecorded,
        occurred_at: Utc::now(),
        payload: Payload::OperatorDecisionRecordedV1(operator_decision_payload()),
    };

    store
        .append_signed(
            &event,
            &signing_key,
            &ActorKeyRef {
                actor_id: "kernel".into(),
                key_id: "kernel-main".into(),
                public_key_hash: None,
            },
        )
        .unwrap();

    let rows = store
        .verified_events_for_run(&run_id.to_string(), &trusted)
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].verification, VerificationStatus::Verified);
    let parsed = rows[0].event.to_event().unwrap();
    match parsed.payload {
        Payload::OperatorDecisionRecordedV1(p) => {
            assert_eq!(p.decided_by, "operator@buildplane");
            assert_eq!(p.merge_commit.as_deref(), Some("deadbeef"));
        }
        other => panic!("unexpected payload {other:?}"),
    }
}
