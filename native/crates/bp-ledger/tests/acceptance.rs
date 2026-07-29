//! M4-S2: `acceptance_recorded` tape vocabulary.

use bp_ledger::canonicalize::canonicalize_payload;
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::acceptance::{AcceptanceCheckResultV1, AcceptanceRecordedV1};
use bp_ledger::payload::Payload;
use bp_ledger::signing::{ActorKeyRef, TrustedPublicKeys, VerificationStatus};
use bp_ledger::storage::sqlite::SqliteStore;
use chrono::Utc;
use ed25519_dalek::SigningKey;
use sha2::{Digest, Sha256};

const FIXTURE_SEED: [u8; 32] = [19u8; 32];

fn acceptance_payload() -> AcceptanceRecordedV1 {
    AcceptanceRecordedV1 {
        plan_id: "pf-plan-m4".into(),
        admission_event_id: "01919000-0000-7000-8000-000000000005".into(),
        contract_digest: "sha256:deadbeef".into(),
        outcome: "passed".into(),
        diff_scope_status: "passed".into(),
        out_of_scope_files: vec![],
        checks: vec![AcceptanceCheckResultV1 {
            command: "pnpm lint".into(),
            exit_code: "0".into(),
            status: "passed".into(),
        }],
        evaluated_at: "2026-06-19T12:00:00Z".into(),
    }
}

#[test]
fn acceptance_recorded_wire_kind_matches_payload_variant() {
    assert_eq!(
        EventKind::AcceptanceRecorded.as_wire(),
        "acceptance_recorded"
    );
    assert_eq!(
        serde_json::to_string(&EventKind::AcceptanceRecorded).unwrap(),
        r#""acceptance_recorded""#
    );
}

#[test]
fn acceptance_recorded_canonicalizes_by_kind_and_variant() {
    let payload = Payload::AcceptanceRecordedV1(acceptance_payload());
    let value = serde_json::to_value(&payload).unwrap();
    match canonicalize_payload("acceptance_recorded", 1, value).unwrap() {
        Payload::AcceptanceRecordedV1(p) => assert_eq!(p.outcome, "passed"),
        other => panic!("unexpected payload {other:?}"),
    }
}

#[test]
fn acceptance_recorded_rejects_mismatched_kind() {
    let payload = Payload::AcceptanceRecordedV1(acceptance_payload());
    let value = serde_json::to_value(&payload).unwrap();
    let err = canonicalize_payload("capability_denied", 1, value).unwrap_err();
    assert!(err.to_string().contains("CapabilityDeniedV1"));
}

#[test]
fn signed_acceptance_recorded_appends_and_verifies() {
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
        kind: EventKind::AcceptanceRecorded,
        occurred_at: Utc::now(),
        payload: Payload::AcceptanceRecordedV1(acceptance_payload()),
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
        Payload::AcceptanceRecordedV1(p) => {
            assert_eq!(p.contract_digest, "sha256:deadbeef");
        }
        other => panic!("unexpected payload {other:?}"),
    }
}
