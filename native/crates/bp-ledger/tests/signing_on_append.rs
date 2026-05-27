//! M1-S4 sign-on-append integration: signed mode persists event + matching
//! detached signature atomically, fails closed on signing error, and never
//! leaks private-key bytes.

use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::keyring::{load_signing_key_at, KeyringRef};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
use bp_ledger::payload::Payload;
use bp_ledger::signing::{ActorKeyRef, TrustedPublicKeys, VerificationStatus};
use bp_ledger::storage::sqlite::SqliteStore;
use chrono::Utc;
use ed25519_dalek::SigningKey;
use sha2::{Digest, Sha256};
use std::path::Path;

const FIXTURE_SEED: [u8; 32] = [13u8; 32];

fn write_fixture_key(root: &Path, actor: &str, key_id: &str) {
    let dir = root.join(actor);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{key_id}.ed25519")), FIXTURE_SEED).unwrap();
}

fn kernel_signer() -> ActorKeyRef {
    ActorKeyRef {
        actor_id: "kernel".into(),
        key_id: "kernel-main".into(),
        public_key_hash: None,
    }
}

fn sample_event(run_id: RunId) -> Event {
    Event {
        id: EventId::new(),
        run_id,
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

fn trusted_for(signing_key: &SigningKey) -> TrustedPublicKeys {
    let mut keys = TrustedPublicKeys::default();
    let hash = format!(
        "sha256:{:x}",
        Sha256::digest(signing_key.verifying_key().as_bytes())
    );
    keys.insert_public_key(hash, signing_key.verifying_key().to_bytes().to_vec());
    keys
}

#[test]
fn signed_append_persists_event_and_signature_and_reads_verified() {
    let tmp = tempfile::tempdir().unwrap();
    write_fixture_key(tmp.path(), "kernel", "kernel-main");
    let signing_key = load_signing_key_at(tmp.path(), &KeyringRef::new("kernel", "kernel-main")).unwrap();

    let store = SqliteStore::open_in_memory().unwrap();
    let run_id = RunId::new();
    let event = sample_event(run_id);

    store
        .append_signed(&event, &signing_key, &kernel_signer())
        .unwrap();

    assert_eq!(store.event_count().unwrap(), 1);
    let sig_count: i64 = store
        .conn_for_tests()
        .query_row(
            "SELECT COUNT(*) FROM event_signatures WHERE event_id = ?1",
            [event.id.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(sig_count, 1, "matching signature row must be persisted");

    let rows = store
        .verified_events_for_run(&run_id.to_string(), &trusted_for(&signing_key))
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].verification, VerificationStatus::Verified);
}

#[test]
fn signing_failure_fails_closed_event_not_persisted() {
    let tmp = tempfile::tempdir().unwrap();
    write_fixture_key(tmp.path(), "kernel", "kernel-main");
    let signing_key = load_signing_key_at(tmp.path(), &KeyringRef::new("kernel", "kernel-main")).unwrap();

    let store = SqliteStore::open_in_memory().unwrap();
    let run_id = RunId::new();

    // schema_version 99 is unsupported, so canonicalization inside the signing
    // path fails. The whole append must roll back: no event row persisted.
    let mut bad = sample_event(run_id);
    bad.schema_version = 99;

    let before = store.event_count().unwrap();
    let result = store.append_signed(&bad, &signing_key, &kernel_signer());
    assert!(result.is_err(), "signing failure must surface as an error");
    assert_eq!(
        store.event_count().unwrap(),
        before,
        "event row must not persist when signing fails (fail closed)"
    );

    let sig_count: i64 = store
        .conn_for_tests()
        .query_row(
            "SELECT COUNT(*) FROM event_signatures WHERE event_id = ?1",
            [bad.id.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(sig_count, 0, "no signature row on failed signed append");
}

#[test]
fn signed_append_errors_never_contain_private_key_bytes() {
    let tmp = tempfile::tempdir().unwrap();
    write_fixture_key(tmp.path(), "kernel", "kernel-main");
    let signing_key = load_signing_key_at(tmp.path(), &KeyringRef::new("kernel", "kernel-main")).unwrap();

    let store = SqliteStore::open_in_memory().unwrap();
    let run_id = RunId::new();
    let mut bad = sample_event(run_id);
    bad.schema_version = 99;

    let err = store
        .append_signed(&bad, &signing_key, &kernel_signer())
        .unwrap_err();
    let msg = format!("{err}");

    // The seed byte (13) repeated should never surface; also assert no base64 of
    // the seed appears.
    let seed_hex = signing_key
        .to_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    assert!(!msg.contains(&seed_hex), "error leaked seed hex: {msg}");
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    let seed_b64 = URL_SAFE_NO_PAD.encode(signing_key.to_bytes());
    assert!(!msg.contains(&seed_b64), "error leaked seed base64: {msg}");
}

#[test]
fn unsigned_append_still_reads_back_unsigned() {
    let store = SqliteStore::open_in_memory().unwrap();
    let run_id = RunId::new();
    let event = sample_event(run_id);

    // Default unsigned path (signing off) preserves current behavior.
    store.append(&event).unwrap();

    let rows = store
        .verified_events_for_run(&run_id.to_string(), &TrustedPublicKeys::default())
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].verification, VerificationStatus::Unsigned);
}
