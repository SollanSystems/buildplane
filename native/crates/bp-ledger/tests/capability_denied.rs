//! M3-S5: `capability_denied` tape vocabulary.

use bp_ledger::canonicalize::canonicalize_payload;
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::capability_broker::CapabilityDeniedV1;
use bp_ledger::payload::Payload;
use bp_ledger::signing::{ActorKeyRef, TrustedPublicKeys, VerificationStatus};
use bp_ledger::storage::sqlite::SqliteStore;
use chrono::Utc;
use ed25519_dalek::SigningKey;
use sha2::{Digest, Sha256};

const FIXTURE_SEED: [u8; 32] = [17u8; 32];

fn denied_payload() -> CapabilityDeniedV1 {
    CapabilityDeniedV1 {
        run_id: "run-m3-s5".into(),
        bundle_digest: "sha256:deadbeef".into(),
        tool: "write_file".into(),
        reason: "write path outside fsWrite allowlist".into(),
        target: "docs/readme.md".into(),
    }
}

#[test]
fn capability_denied_wire_kind_matches_payload_variant() {
    assert_eq!(EventKind::CapabilityDenied.as_wire(), "capability_denied");
    assert_eq!(
        serde_json::to_string(&EventKind::CapabilityDenied).unwrap(),
        r#""capability_denied""#
    );
}

#[test]
fn capability_denied_canonicalizes_by_kind_and_variant() {
    let payload = Payload::CapabilityDeniedV1(denied_payload());
    let value = serde_json::to_value(&payload).unwrap();
    match canonicalize_payload("capability_denied", 1, value).unwrap() {
        Payload::CapabilityDeniedV1(p) => assert_eq!(p.tool, "write_file"),
        other => panic!("unexpected payload {other:?}"),
    }
}

#[test]
fn capability_denied_rejects_mismatched_kind() {
    let payload = Payload::CapabilityDeniedV1(denied_payload());
    let value = serde_json::to_value(&payload).unwrap();
    let err = canonicalize_payload("workspace_write", 1, value).unwrap_err();
    assert!(err.to_string().contains("WorkspaceWriteV1"));
}

#[test]
fn signed_capability_denied_appends_and_verifies() {
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
        kind: EventKind::CapabilityDenied,
        occurred_at: Utc::now(),
        payload: Payload::CapabilityDeniedV1(CapabilityDeniedV1 {
            run_id: run_id.to_string(),
            ..denied_payload()
        }),
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
        Payload::CapabilityDeniedV1(p) => {
            assert_eq!(p.target, "docs/readme.md");
        }
        other => panic!("unexpected payload {other:?}"),
    }
}