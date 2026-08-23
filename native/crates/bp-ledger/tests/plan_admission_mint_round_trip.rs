//! The mint round trip: a `plan_admitted` minted against a REAL store must
//! verify under the external verifier (mint-control S2 acceptance criterion 2).
//!
//! **This is the repo's first Rust-test-shells-to-node pattern.** It exists
//! because S2 is a broker-private composition with no transport, so no
//! TypeScript harness can reach the mint; the existing round trip
//! (`test/ledger-integration/planforge-plan-admission.test.ts`) spawns the CLI
//! from TypeScript, and putting a signing path behind a CLI verb — even a
//! `cfg`-gated one — is refused by the standing invariant. It skips rather than
//! fails when `node` is absent so a bare `cargo test` outside CI stays green.
//!
//! It must never be satisfied by the committed `test/fixtures/signed-tape/`
//! corpus: that fixture already contains a signed, verifiable `plan_admitted`,
//! so "the verifier exits 0 over a tape containing plan_admitted" is a
//! statement that was already true and proves nothing. The tape here is
//! exported from a store this control actually wrote to.

use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::run_lifecycle::RunStartedV1;
use bp_ledger::payload::Payload;
use bp_ledger::signing::{public_key_hash, ActorKeyRef, TrustedPublicKeys};
use bp_ledger::storage::sqlite::{
    PlanAdmissionAuthorityV1, PlanAdmissionDispositionV1, PlanAdmissionRequestV1,
    PlanAdmissionSealRequestV1, SqliteStore,
};
use bp_ledger::tape_export::export_signed_tape;
use chrono::Utc;
use ed25519_dalek::SigningKey;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use tempfile::TempDir;
use uuid::Uuid;

const KERNEL_SEED: [u8; 32] = [59u8; 32];
const RUN_UUID: &str = "01919000-0000-7000-8000-00000000ab01";
const RUN_STARTED_EVENT_UUID: &str = "01919000-0000-7000-8000-00000000ab02";
const REQUEST_UUID: &str = "01919000-0000-7000-8000-00000000ab03";

fn kernel_key() -> SigningKey {
    SigningKey::from_bytes(&KERNEL_SEED)
}

fn kernel_signer() -> ActorKeyRef {
    ActorKeyRef {
        actor_id: "kernel".into(),
        key_id: "kernel-main".into(),
        public_key_hash: Some(public_key_hash(&kernel_key().verifying_key())),
    }
}

fn authority() -> PlanAdmissionAuthorityV1 {
    let mut trusted = TrustedPublicKeys::default();
    let verifying = kernel_key().verifying_key();
    trusted.insert_public_key(public_key_hash(&verifying), verifying.to_bytes().to_vec());
    PlanAdmissionAuthorityV1::new_kernel_realm(
        trusted,
        kernel_signer(),
        format!("sha256:{}", "ab".repeat(32)),
    )
    .unwrap()
}

fn run_id() -> RunId {
    RunId::from_uuid(Uuid::parse_str(RUN_UUID).unwrap())
}

fn plan_bytes() -> Vec<u8> {
    b"## Title\nMint round trip\n\n## Goal\nClose PlanForge criterion 5.\n".to_vec()
}

fn repository_root() -> PathBuf {
    // native/crates/bp-ledger -> native/crates -> native -> <repo root>
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("the crate is nested three levels below the repository root")
        .to_path_buf()
}

fn write_keyring(root: &Path) {
    let dir = root.join("kernel");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("kernel-main.ed25519"), KERNEL_SEED).unwrap();
}

fn seed_run_started(store: &SqliteStore) {
    let event = Event {
        id: EventId::from_uuid(Uuid::parse_str(RUN_STARTED_EVENT_UUID).unwrap()),
        run_id: run_id(),
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::RunStarted,
        occurred_at: Utc::now(),
        payload: Payload::RunStartedV1(RunStartedV1 {
            packet_hash: "sha256:aa".into(),
            git_head: "c".repeat(40),
            workspace_path: "/ws".into(),
            config: BTreeMap::new(),
            parent_run_id: None,
            parent_event_id: None,
        }),
    };
    store
        .append_signed(&event, &kernel_key(), &kernel_signer())
        .unwrap();
}

#[test]
fn a_minted_plan_admitted_verifies_under_the_external_verifier() {
    let tmp = TempDir::new().unwrap();
    let keyring_root = tmp.path().join("keys");
    write_keyring(&keyring_root);
    let store = SqliteStore::open(tmp.path().join("events.db")).unwrap();
    seed_run_started(&store);
    let authority = authority();

    let bytes = plan_bytes();
    let request = PlanAdmissionRequestV1 {
        run_id: run_id(),
        request_id: Uuid::parse_str(REQUEST_UUID).unwrap(),
        plan_content_ref: format!("cas://sha256:{:x}", Sha256::digest(&bytes)),
        plan_bytes: bytes,
        trusted_base: "c".repeat(40),
        decided_by: "operator:uid-1000".into(),
        asserted_plan_digest: format!("sha256:{}", "cd".repeat(32)),
        asserted_idempotency_key: "planforge:v0:buildplane:cccccccc:abcd1234".into(),
        asserted_validation_status: "PASS".into(),
    };

    let recorded = store
        .record_plan_admission_v1(&request, &authority, &kernel_key(), &kernel_signer())
        .expect("the mint records against a real store");
    let PlanAdmissionDispositionV1::AwaitingCheckpoint {
        admission_event_id, ..
    } = recorded
    else {
        panic!("a fresh mint is awaiting its checkpoint");
    };
    store
        .seal_plan_admission_v1(
            &PlanAdmissionSealRequestV1 {
                run_id: run_id(),
                admission_event_id,
            },
            &authority,
            &kernel_key(),
            &kernel_signer(),
        )
        .expect("the mint seals its own admission");

    let fixture_dir = tmp.path().join("exported-tape");
    std::fs::create_dir_all(&fixture_dir).unwrap();
    let tape = export_signed_tape(&store, &run_id().to_string(), &keyring_root)
        .expect("the live run exports as a signed tape");
    std::fs::write(
        fixture_dir.join("tape.json"),
        serde_json::to_vec_pretty(&tape).unwrap(),
    )
    .unwrap();

    // Pin, in-process, that the exported tape is the thing under test: a signed
    // plan_admitted the mint produced. Without this the node assertion below
    // could pass over a tape that never contained an admission at all.
    let events = tape["events"].as_array().expect("the tape carries events");
    let admissions = events
        .iter()
        .filter(|entry| {
            let bytes = base64_decode(entry["canonical_event_b64"].as_str().unwrap());
            let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            parsed["kind"] == "plan_admitted"
        })
        .collect::<Vec<_>>();
    assert_eq!(admissions.len(), 1, "the exported tape has one admission");
    assert!(
        !admissions[0]["signature"].is_null(),
        "the minted admission is signed, not an unsigned-lane leftover"
    );

    let verifier = repository_root().join("scripts/verify-signed-tape.mjs");
    assert!(
        verifier.is_file(),
        "the external verifier must exist at {}",
        verifier.display()
    );
    let Some(node) = node_command() else {
        eprintln!(
            "SKIPPED a_minted_plan_admitted_verifies_under_the_external_verifier: `node` is not \
             on PATH, so the external verifier cannot run here. CI runs this test with node \
             installed; a bare `cargo test` outside CI skips it rather than failing."
        );
        return;
    };

    let output = Command::new(node)
        .arg(&verifier)
        .arg("--fixture")
        .arg(&fixture_dir)
        .arg("--json")
        .output()
        .expect("the external verifier runs");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "verify-signed-tape.mjs must exit 0 over a tape the mint wrote.\nstdout: {stdout}\nstderr: {stderr}"
    );

    let report: serde_json::Value =
        serde_json::from_str(&stdout).expect("the verifier emits a JSON report under --json");
    assert_eq!(report["ok"], true);
    let verified_admissions = report["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["kind"] == "plan_admitted" && event["status"] == "verified")
        .count();
    assert_eq!(
        verified_admissions, 1,
        "the verifier must report the minted admission as verified, not unsigned: {stdout}"
    );
    assert!(
        report["checkpoints"]
            .as_array()
            .unwrap()
            .iter()
            .all(|checkpoint| checkpoint["status"] == "root_ok"),
        "the sealing checkpoint's tape root must recompute: {stdout}"
    );
}

fn node_command() -> Option<&'static str> {
    Command::new("node")
        .arg("--version")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|_| "node")
}

/// The tape envelope is base64 (standard alphabet); decoding it here keeps this
/// test independent of whichever base64 helper the exporter happens to use.
fn base64_decode(value: &str) -> Vec<u8> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut buffer = 0u32;
    let mut bits = 0u32;
    let mut out = Vec::new();
    for byte in value.bytes() {
        if byte == b'=' {
            break;
        }
        let Some(index) = ALPHABET.iter().position(|candidate| *candidate == byte) else {
            continue;
        };
        buffer = (buffer << 6) | index as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xFF) as u8);
        }
    }
    out
}
