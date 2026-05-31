//! M1-S7: the generated `valid/` fixture must be a real signed tape — every
//! event verifies against the crate's own verifier and the checkpoint's
//! tape_root_hash recomputes from the covered events' stored hash strings.

use bp_ledger::event::Event;
use bp_ledger::payload::checkpoint::tape_root_hash;
use bp_ledger::payload::Payload;
use bp_ledger::signing::{
    verify_event_signature, EventSignatureV1, TrustedPublicKeys, VerificationStatus,
};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::Value;
use std::process::Command;

fn run_generator(out_dir: &std::path::Path) {
    let bin = env!("CARGO_BIN_EXE_bp-ledger-gen-signed-tape");
    let status = Command::new(bin).arg(out_dir).status().expect("generator runs");
    assert!(status.success(), "generator exited non-zero");
}

fn load_tape(path: &std::path::Path) -> Value {
    let bytes = std::fs::read(path).expect("read tape.json");
    serde_json::from_slice(&bytes).expect("tape.json parses")
}

fn assert_tape_is_a_real_signed_tape(tape: &Value) {
    assert_eq!(tape["format"], "buildplane.signed-tape.v1");

    let mut keys = TrustedPublicKeys::default();
    for k in tape["trusted_keys"].as_array().unwrap() {
        let hash = k["public_key_hash"].as_str().unwrap().to_string();
        let raw = STANDARD.decode(k["public_key_b64"].as_str().unwrap()).unwrap();
        keys.insert_public_key(hash, raw);
    }

    let events = tape["events"].as_array().unwrap();
    let mut covered_hashes: Vec<(String, String)> = Vec::new();
    let mut checkpoints: Vec<(Event, EventSignatureV1)> = Vec::new();

    for entry in events {
        let bytes = STANDARD.decode(entry["canonical_event_b64"].as_str().unwrap()).unwrap();
        let event: Event = serde_json::from_slice(&bytes).expect("event deserializes");
        let sig: EventSignatureV1 =
            serde_json::from_value(entry["signature"].clone()).expect("signature deserializes");

        assert_eq!(
            verify_event_signature(&event, &sig, &keys),
            VerificationStatus::Verified,
            "event {} should verify",
            event.id
        );

        if matches!(event.payload, Payload::TapeCheckpointV1(_)) {
            checkpoints.push((event, sig));
        } else {
            covered_hashes.push((event.id.to_string(), sig.canonical_event_hash.clone()));
        }
    }

    assert!(!checkpoints.is_empty(), "fixture must contain a checkpoint");
    covered_hashes.sort_by(|a, b| a.0.cmp(&b.0));
    let ordered: Vec<String> = covered_hashes.iter().map(|(_, h)| h.clone()).collect();
    let recomputed = tape_root_hash(&ordered);

    for (event, _) in &checkpoints {
        if let Payload::TapeCheckpointV1(cp) = &event.payload {
            assert_eq!(cp.tape_root_hash, recomputed, "checkpoint root recomputes");
            assert_eq!(cp.through_event_count as usize, ordered.len());
        }
    }
}

#[test]
fn valid_fixture_is_a_real_signed_tape() {
    let tmp = tempfile::tempdir().unwrap();
    run_generator(tmp.path());
    let tape = load_tape(&tmp.path().join("valid").join("tape.json"));
    assert_tape_is_a_real_signed_tape(&tape);
}

#[test]
fn plan_cycle_fixture_is_a_real_signed_tape() {
    let tmp = tempfile::tempdir().unwrap();
    run_generator(tmp.path());
    let tape = load_tape(&tmp.path().join("plan-cycle").join("tape.json"));
    assert_tape_is_a_real_signed_tape(&tape);

    // The plan-cycle tape must exercise all four new M2-S2 kinds.
    let wire_kinds: Vec<String> = tape["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            let bytes = STANDARD.decode(entry["canonical_event_b64"].as_str().unwrap()).unwrap();
            let event: Event = serde_json::from_slice(&bytes).unwrap();
            event.kind.as_wire().to_string()
        })
        .collect();
    for kind in ["plan_admitted", "activity_started", "activity_completed", "plan_receipt"] {
        assert!(
            wire_kinds.iter().any(|k| k == kind),
            "plan-cycle tape must contain {kind}"
        );
    }
}
