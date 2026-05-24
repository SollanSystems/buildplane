//! Verification-on-read status coverage for detached event signatures.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use bp_ledger::canonicalize::{canonical_event_bytes, canonical_event_hash};
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
use bp_ledger::payload::Payload;
use bp_ledger::signing::{
    ActorKeyRef, EventSignatureV1, SignatureAlgorithm, TrustedPublicKeys, VerificationStatus,
};
use bp_ledger::storage::sqlite::SqliteStore;
use chrono::Utc;
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};

fn sample_event() -> Event {
    Event {
        id: EventId::new(),
        run_id: RunId::new(),
        parent_event_id: None,
        schema_version: 1,
        kind: EventKind::RunCompleted,
        occurred_at: Utc::now(),
        payload: Payload::RunCompletedV1(RunCompletedV1 {
            outcome: RunOutcome::Passed,
            duration_ms: 1,
            event_count: 1,
            unit_count: 0,
        }),
    }
}

fn fixture_key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}

fn public_key_hash(signing_key: &SigningKey) -> String {
    let digest = Sha256::digest(signing_key.verifying_key().as_bytes());
    format!("sha256:{digest:x}")
}

fn trusted_keys(signing_key: &SigningKey) -> TrustedPublicKeys {
    let mut keys = TrustedPublicKeys::default();
    keys.insert_public_key(
        public_key_hash(signing_key),
        signing_key.verifying_key().to_bytes().to_vec(),
    );
    keys
}

fn signed_fixture(event: &Event, signing_key: &SigningKey) -> EventSignatureV1 {
    let bytes = canonical_event_bytes(event).unwrap();
    let signature = signing_key.sign(&bytes);
    EventSignatureV1 {
        event_id: event.id,
        canonical_event_hash: canonical_event_hash(event).unwrap(),
        signer: ActorKeyRef {
            actor_id: "kernel".into(),
            key_id: "kernel-main".into(),
            public_key_hash: Some(public_key_hash(signing_key)),
        },
        algorithm: SignatureAlgorithm::Ed25519,
        signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        signed_at: "2026-05-22T23:30:00Z".parse().unwrap(),
    }
}

#[test]
fn unsigned_events_report_unsigned() {
    let store = SqliteStore::open_in_memory().unwrap();
    let event = sample_event();
    store.append(&event).unwrap();

    let rows = store
        .verified_events_for_run(&event.run_id.to_string(), &TrustedPublicKeys::default())
        .unwrap();

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].verification, VerificationStatus::Unsigned);
    assert!(rows[0].signature.is_none());
}

#[test]
fn valid_signature_reports_verified() {
    let store = SqliteStore::open_in_memory().unwrap();
    let event = sample_event();
    let signing_key = fixture_key();
    let signature = signed_fixture(&event, &signing_key);
    store.append(&event).unwrap();
    store.append_event_signature(&signature).unwrap();

    let rows = store
        .verified_events_for_run(&event.run_id.to_string(), &trusted_keys(&signing_key))
        .unwrap();

    assert_eq!(rows[0].verification, VerificationStatus::Verified);
    assert_eq!(rows[0].signature.as_ref().unwrap().event_id, event.id);
}

#[test]
fn signature_without_registered_public_key_reports_missing_key() {
    let store = SqliteStore::open_in_memory().unwrap();
    let event = sample_event();
    let signing_key = fixture_key();
    let signature = signed_fixture(&event, &signing_key);
    store.append(&event).unwrap();
    store.append_event_signature(&signature).unwrap();

    let rows = store
        .verified_events_for_run(&event.run_id.to_string(), &TrustedPublicKeys::default())
        .unwrap();

    assert_eq!(rows[0].verification, VerificationStatus::MissingKey);
}

#[test]
fn stored_hash_mismatch_reports_hash_mismatch() {
    let store = SqliteStore::open_in_memory().unwrap();
    let event = sample_event();
    let signing_key = fixture_key();
    let mut signature = signed_fixture(&event, &signing_key);
    signature.canonical_event_hash = "sha256:bad".into();
    store.append(&event).unwrap();
    store.append_event_signature(&signature).unwrap();

    let rows = store
        .verified_events_for_run(&event.run_id.to_string(), &trusted_keys(&signing_key))
        .unwrap();

    assert_eq!(rows[0].verification, VerificationStatus::HashMismatch);
}

#[test]
fn invalid_signature_reports_bad_signature() {
    let store = SqliteStore::open_in_memory().unwrap();
    let event = sample_event();
    let signing_key = fixture_key();
    let mut signature = signed_fixture(&event, &signing_key);
    signature.signature = URL_SAFE_NO_PAD.encode([1u8; 64]);
    store.append(&event).unwrap();
    store.append_event_signature(&signature).unwrap();

    let rows = store
        .verified_events_for_run(&event.run_id.to_string(), &trusted_keys(&signing_key))
        .unwrap();

    assert_eq!(rows[0].verification, VerificationStatus::BadSignature);
}

#[test]
fn unsupported_algorithm_reports_unsupported_algorithm() {
    let store = SqliteStore::open_in_memory().unwrap();
    let event = sample_event();
    let signing_key = fixture_key();
    let signature = signed_fixture(&event, &signing_key);
    store.append(&event).unwrap();
    store.append_event_signature(&signature).unwrap();
    store
        .conn_for_tests()
        .execute(
            "UPDATE event_signatures SET algorithm = 'future_sig' WHERE event_id = ?1",
            [event.id.to_string()],
        )
        .expect_err("append-only trigger should reject direct mutation");

    // Insert unsupported algorithm through a fresh store row to prove read-side handling.
    let other = sample_event();
    store.append(&other).unwrap();
    store
        .conn_for_tests()
        .execute(
            r#"INSERT INTO event_signatures (
                event_id, canonical_event_hash, actor_id, key_id, public_key_hash, algorithm, signature, signed_at
            ) VALUES (?1, ?2, 'kernel', 'kernel-main', ?3, 'future_sig', ?4, '2026-05-22T23:30:00Z')"#,
            rusqlite::params![
                other.id.to_string(),
                canonical_event_hash(&other).unwrap(),
                public_key_hash(&signing_key),
                signature.signature,
            ],
        )
        .unwrap();

    let rows = store
        .verified_events_for_run(&other.run_id.to_string(), &trusted_keys(&signing_key))
        .unwrap();

    assert_eq!(
        rows[0].verification,
        VerificationStatus::UnsupportedAlgorithm
    );
}
