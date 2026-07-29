//! M6-S6: `result_ready` tape vocabulary — the run-lifecycle signal that a run
//! produced an accepted, operator-reviewable result.

use bp_ledger::canonicalize::canonicalize_payload;
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::run_lifecycle::ResultReadyV1;
use bp_ledger::payload::Payload;
use bp_ledger::signing::{ActorKeyRef, TrustedPublicKeys, VerificationStatus};
use bp_ledger::storage::sqlite::SqliteStore;
use chrono::Utc;
use ed25519_dalek::SigningKey;
use sha2::{Digest, Sha256};

const FIXTURE_SEED: [u8; 32] = [37u8; 32];

fn result_ready_payload() -> ResultReadyV1 {
    ResultReadyV1 {
        run_id: "01919000-0000-7000-8000-0000000000ff".into(),
        admission_event_id: "01919000-0000-7000-8000-000000000004".into(),
        acceptance_event_id: "01919000-0000-7000-8000-000000000005".into(),
    }
}

#[test]
fn result_ready_v1_round_trips() {
    let p = result_ready_payload();
    let s = serde_json::to_string(&p).unwrap();
    assert_eq!(p, serde_json::from_str::<ResultReadyV1>(&s).unwrap());
}

#[test]
fn result_ready_wire_kind_matches_payload_variant() {
    assert_eq!(EventKind::ResultReady.as_wire(), "result_ready");
    assert_eq!(
        serde_json::to_string(&EventKind::ResultReady).unwrap(),
        r#""result_ready""#
    );
}

#[test]
fn result_ready_canonicalizes_by_kind_and_variant() {
    // Guards the non-compiler-enforced `kind_to_variant` arm: the wire string
    // `result_ready` must resolve to the `ResultReadyV1` variant.
    let payload = Payload::ResultReadyV1(result_ready_payload());
    let value = serde_json::to_value(&payload).unwrap();
    match canonicalize_payload("result_ready", 1, value).unwrap() {
        Payload::ResultReadyV1(p) => {
            assert_eq!(p, result_ready_payload());
            assert_eq!(p.admission_event_id, "01919000-0000-7000-8000-000000000004");
            assert_eq!(
                p.acceptance_event_id,
                "01919000-0000-7000-8000-000000000005"
            );
        }
        other => panic!("unexpected payload {other:?}"),
    }
}

#[test]
fn result_ready_rejects_mismatched_kind() {
    let payload = Payload::ResultReadyV1(result_ready_payload());
    let value = serde_json::to_value(&payload).unwrap();
    let err = canonicalize_payload("acceptance_recorded", 1, value).unwrap_err();
    assert!(err.to_string().contains("AcceptanceRecordedV1"));
}

#[test]
fn result_ready_canonical_bytes_are_stable() {
    let payload = Payload::ResultReadyV1(result_ready_payload());
    let first = serde_json::to_vec(&payload).unwrap();
    let second = serde_json::to_vec(&payload).unwrap();
    assert_eq!(first, second);
}

/// M6-S6 golden: pin the canonical-byte sha256 of the signed `result_ready`
/// payload. Byte-stability is enforced HERE by a test (not only by CI
/// fixture-freshness): a change to the wire field order / presence flips the
/// hash and trips this test, surfacing the tape-migration hazard before it ships.
#[test]
fn result_ready_canonical_bytes_golden() {
    let bytes = serde_json::to_vec(&Payload::ResultReadyV1(result_ready_payload())).unwrap();
    let hash = format!("sha256:{:x}", Sha256::digest(&bytes));
    assert_eq!(
        hash,
        "sha256:6b1bc1dd5da5b003147e0536b6462194b9f98c4d75ab40e970dc22ac743bfe62",
        "result_ready canonical bytes drifted: {}",
        String::from_utf8_lossy(&bytes)
    );
}

#[test]
fn signed_result_ready_appends_and_verifies() {
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
        kind: EventKind::ResultReady,
        occurred_at: Utc::now(),
        payload: Payload::ResultReadyV1(result_ready_payload()),
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
        Payload::ResultReadyV1(p) => {
            assert_eq!(p.run_id, "01919000-0000-7000-8000-0000000000ff");
            assert_eq!(p.admission_event_id, "01919000-0000-7000-8000-000000000004");
            assert_eq!(
                p.acceptance_event_id,
                "01919000-0000-7000-8000-000000000005"
            );
        }
        other => panic!("unexpected payload {other:?}"),
    }
}
