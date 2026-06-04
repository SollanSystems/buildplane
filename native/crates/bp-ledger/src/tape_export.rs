//! M2-S6: export a live run's signed tape into the `buildplane.signed-tape.v1`
//! envelope consumed by the external verifier (`scripts/verify-signed-tape.mjs`).
//!
//! Read-only: reads `events.db` (via [`SqliteStore`]) and the keyring; it never
//! mutates the tape. Each exported event carries the *exact* canonical bytes it
//! was signed over (so `sha256(bytes)` matches the stored `canonical_event_hash`)
//! plus its detached signature; `trusted_keys` materializes each distinct
//! signer's public key from the keyring so the verifier can bind signatures to
//! keys. There is no `trusted_keys` table on the tape — the public keys are
//! derived from the keyring on the signing machine, which is where export runs.

use crate::canonicalize::canonical_event_bytes;
use crate::error::Result;
use crate::keyring::{load_signing_key_at, KeyringRef};
use crate::signing::public_key_hash;
use crate::storage::sqlite::SqliteStore;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::Path;

/// Serialize every event of `run_id` from `store` into the
/// `buildplane.signed-tape.v1` export envelope, resolving each distinct signer's
/// public key from the keyring rooted at `keyring_root`.
pub fn export_signed_tape(
    store: &SqliteStore,
    run_id: &str,
    keyring_root: &Path,
) -> Result<Value> {
    let signed = store.signed_events_for_run(run_id)?;

    let mut entries: Vec<Value> = Vec::with_capacity(signed.len());
    // Distinct (actor_id, key_id) signers, in stable order, for trusted_keys.
    let mut signers: BTreeSet<(String, String)> = BTreeSet::new();
    for (event, signature) in &signed {
        let bytes = canonical_event_bytes(event)?;
        let signature_json = match signature {
            Some(sig) => {
                signers.insert((sig.signer.actor_id.clone(), sig.signer.key_id.clone()));
                serde_json::to_value(sig)?
            }
            None => Value::Null,
        };
        entries.push(json!({
            "canonical_event_b64": STANDARD.encode(&bytes),
            "signature": signature_json,
        }));
    }

    let mut trusted: Vec<Value> = Vec::new();
    let mut seen_hashes: BTreeSet<String> = BTreeSet::new();
    for (actor_id, key_id) in signers {
        let key = load_signing_key_at(keyring_root, &KeyringRef::new(actor_id, key_id))?;
        let verifying_key = key.verifying_key();
        let hash = public_key_hash(&verifying_key);
        if seen_hashes.insert(hash.clone()) {
            trusted.push(json!({
                "public_key_hash": hash,
                "public_key_b64": STANDARD.encode(verifying_key.to_bytes()),
            }));
        }
    }

    Ok(json!({
        "format": "buildplane.signed-tape.v1",
        "run_id": run_id,
        "trusted_keys": trusted,
        "events": entries,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::Event;
    use crate::id::{EventId, RunId};
    use crate::kind::EventKind;
    use crate::payload::run_lifecycle::{RunCompletedV1, RunOutcome, RunStartedV1};
    use crate::payload::Payload;
    use crate::signing::ActorKeyRef;
    use chrono::Utc;
    use ed25519_dalek::SigningKey;
    use sha2::{Digest, Sha256};
    use std::collections::BTreeMap;
    use uuid::Uuid;

    const SEED: [u8; 32] = [13u8; 32];

    fn write_fixture_key(root: &Path, actor: &str, key_id: &str) {
        let dir = root.join(actor);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{key_id}.ed25519")), SEED).unwrap();
    }

    fn kernel_signer() -> ActorKeyRef {
        ActorKeyRef {
            actor_id: "kernel".into(),
            key_id: "kernel-main".into(),
            public_key_hash: None,
        }
    }

    fn event_id(n: u8) -> EventId {
        EventId::from_uuid(
            Uuid::parse_str(&format!("01919000-0000-7000-8000-{:012}", n)).unwrap(),
        )
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        format!("sha256:{:x}", Sha256::digest(bytes))
    }

    #[test]
    fn export_matches_signed_tape_v1_and_canonical_bytes_hash() {
        let tmp = tempfile::tempdir().unwrap();
        write_fixture_key(tmp.path(), "kernel", "kernel-main");
        let signing_key = SigningKey::from_bytes(&SEED);

        let store = SqliteStore::open_in_memory().unwrap();
        let run_id = RunId::from_uuid(
            Uuid::parse_str("01919000-0000-7000-8000-0000000000ff").unwrap(),
        );

        let started = Event {
            id: event_id(1),
            run_id,
            parent_event_id: None,
            schema_version: 1,
            kind: EventKind::RunStarted,
            occurred_at: Utc::now(),
            payload: Payload::RunStartedV1(RunStartedV1 {
                packet_hash: "sha256:aa".into(),
                git_head: "dead".into(),
                workspace_path: "/ws".into(),
                config: BTreeMap::new(),
                parent_run_id: None,
                parent_event_id: None,
            }),
        };
        let completed = Event {
            id: event_id(2),
            run_id,
            parent_event_id: Some(event_id(1)),
            schema_version: 1,
            kind: EventKind::RunCompleted,
            occurred_at: Utc::now(),
            payload: Payload::RunCompletedV1(RunCompletedV1 {
                outcome: RunOutcome::Passed,
                duration_ms: 1,
                event_count: 2,
                unit_count: 0,
            }),
        };
        store
            .append_signed(&started, &signing_key, &kernel_signer())
            .unwrap();
        store
            .append_signed(&completed, &signing_key, &kernel_signer())
            .unwrap();

        let tape = export_signed_tape(&store, &run_id.to_string(), tmp.path()).unwrap();

        assert_eq!(tape["format"], "buildplane.signed-tape.v1");
        assert_eq!(tape["run_id"], run_id.to_string());

        // trusted_keys: exactly one signer; its bytes hash to the claimed hash.
        let trusted = tape["trusted_keys"].as_array().unwrap();
        assert_eq!(trusted.len(), 1);
        let raw = STANDARD
            .decode(trusted[0]["public_key_b64"].as_str().unwrap())
            .unwrap();
        assert_eq!(raw.len(), 32);
        assert_eq!(
            sha256_hex(&raw),
            trusted[0]["public_key_hash"].as_str().unwrap()
        );

        // events: every entry carries signed canonical bytes whose sha256 matches
        // the detached signature's canonical_event_hash (the verifier's core gate).
        let events = tape["events"].as_array().unwrap();
        assert_eq!(events.len(), 2);
        for entry in events {
            let bytes = STANDARD
                .decode(entry["canonical_event_b64"].as_str().unwrap())
                .unwrap();
            let sig = &entry["signature"];
            assert_eq!(sig["algorithm"], "ed25519");
            assert_eq!(
                sha256_hex(&bytes),
                sig["canonical_event_hash"].as_str().unwrap()
            );
            assert_eq!(sig["signer"]["public_key_hash"], trusted[0]["public_key_hash"]);
        }
    }
}
