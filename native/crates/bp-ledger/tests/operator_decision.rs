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
        envelope: None,
        decided_by: "operator@buildplane".into(),
        decided_at: "2026-06-22T12:00:00Z".into(),
    }
}

fn envelope_fixture() -> OperatorDecisionRecordedV1 {
    OperatorDecisionRecordedV1 {
        run_id: "pf-envelope-fixture".into(),
        decision: "approved".into(),
        subject: "authorize-envelope".into(),
        acceptance_event_id: None,
        admission_event_id: None,
        merge_commit: None,
        envelope: Some(
            "{\"allowed_side_effects\":[\"code-edit\"],\"allowed_verification_cmds\":[\"pnpm\",\"cargo\",\"tsc\"],\"envelope_version\":\"v0\",\"expires_at\":\"2026-07-01T00:00:00Z\",\"max_iterations\":8,\"milestone\":\"M5\",\"path_globs\":[\"src/**\"],\"token_budget\":4000000}"
                .into(),
        ),
        decided_by: "operator:khall".into(),
        decided_at: "2026-06-22T00:00:00Z".into(),
    }
}

#[test]
fn operator_decision_envelope_round_trips() {
    let p = envelope_fixture();
    let s = serde_json::to_string(&p).unwrap();
    assert_eq!(
        p,
        serde_json::from_str::<OperatorDecisionRecordedV1>(&s).unwrap()
    );
    // subject carries the GAP-10 authorize-envelope value; the canonical-JSON
    // envelope is a string field (no nested typeshared struct, no u64 hazard),
    // so its inner JSON is escaped on the wire.
    assert_eq!(p.subject, "authorize-envelope");
    assert!(s.contains("\"envelope\":"));
    assert!(p.envelope.as_deref().unwrap().contains("\"milestone\":\"M5\""));
}

#[test]
fn operator_decision_envelope_canonicalizes() {
    let payload = Payload::OperatorDecisionRecordedV1(envelope_fixture());
    let value = serde_json::to_value(&payload).unwrap();
    match canonicalize_payload("operator_decision_recorded", 1, value).unwrap() {
        Payload::OperatorDecisionRecordedV1(p) => {
            assert_eq!(p, envelope_fixture());
            assert_eq!(p.subject, "authorize-envelope");
            assert!(p.envelope.is_some());
        }
        other => panic!("unexpected payload {other:?}"),
    }
}

#[test]
fn operator_decision_none_envelope_omits_field_on_wire() {
    // A merge/resume record (envelope = None) must keep the M5-S1 wire shape:
    // `skip_serializing_if` drops the new field so existing signed records and
    // fixtures stay byte-identical.
    let s = serde_json::to_string(&operator_decision_payload()).unwrap();
    assert!(!s.contains("\"envelope\""));
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

/// A resume/rejected decision: every optional is `None`. With `envelope`'s
/// `skip_serializing_if` the field drops off the wire entirely, while the other
/// optionals (`acceptance_event_id`/`admission_event_id`/`merge_commit`) carry
/// `null` (no skip). Pins the M5-S4 write-ahead None-optionals shape.
fn resume_rejected_payload() -> OperatorDecisionRecordedV1 {
    OperatorDecisionRecordedV1 {
        run_id: "01919000-0000-7000-8000-0000000000bb".into(),
        decision: "rejected".into(),
        subject: "resume".into(),
        acceptance_event_id: None,
        admission_event_id: None,
        merge_commit: None,
        envelope: None,
        decided_by: "operator:khall".into(),
        decided_at: "2026-06-23T00:00:00Z".into(),
    }
}

/// M5-S4 golden: pin the canonical-byte sha256 of the signed
/// `operator_decision_recorded` payload for BOTH a populated approved/merge case
/// and a None-optionals rejected/resume case. Byte-stability is enforced HERE by
/// a test (not only by CI fixture-freshness): a change to the wire field order /
/// presence flips a hash and trips this test, surfacing the tape-migration
/// hazard before it ships.
#[test]
fn operator_decision_recorded_canonical_bytes_golden() {
    let merge_bytes =
        serde_json::to_vec(&Payload::OperatorDecisionRecordedV1(operator_decision_payload()))
            .unwrap();
    let merge_hash = format!("sha256:{:x}", Sha256::digest(&merge_bytes));
    assert_eq!(
        merge_hash,
        "sha256:c6ae60dbfccd48e9e7141b7b903c671673ac7903cb153c0afc82d853bf65f2cb",
        "approved/merge canonical bytes drifted: {}",
        String::from_utf8_lossy(&merge_bytes)
    );

    let resume_bytes =
        serde_json::to_vec(&Payload::OperatorDecisionRecordedV1(resume_rejected_payload()))
            .unwrap();
    let resume_hash = format!("sha256:{:x}", Sha256::digest(&resume_bytes));
    assert_eq!(
        resume_hash,
        "sha256:e64ff273654c915e82802fba5a288e3df5db3f9cb5cee972e08ef5eb360802a5",
        "rejected/resume canonical bytes drifted: {}",
        String::from_utf8_lossy(&resume_bytes)
    );
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
