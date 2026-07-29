//! M1-S7: emit deterministic signed-tape fixtures consumed by the external
//! verifier (`scripts/verify-signed-tape.mjs`). Deterministic by construction:
//! fixed signing key, fixed UUIDv7 event ids (ascending = tape order), fixed
//! timestamps. No EventId::new()/Utc::now(). Emits three variants:
//!   valid/      — every signature valid, checkpoint root correct
//!   tampered/   — one event's payload mutated AFTER signing (hash_mismatch)
//!   bad-root/   — checkpoint validly signed over a deliberately wrong root
//!   plan-cycle/ — full M2 PlanForge admission cycle on a DISTINCT run_id
//!
//! Usage: bp-ledger-gen-signed-tape <out-dir>
//! Writes <out-dir>/{valid,tampered,bad-root,plan-cycle}/tape.json.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::activity::{ActivityCompletedV1, ActivityStartedV1, ActivityType};
use bp_ledger::payload::checkpoint::{tape_root_hash, TapeCheckpointV1, TapeRootAlgorithm};
use bp_ledger::payload::plan_lifecycle::{
    PlanAdmittedV1, PlanReceiptOutcome, PlanReceiptRecordedV1,
};
use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome, RunStartedV1};
use bp_ledger::payload::unit_lifecycle::UnitStartedV1;
use bp_ledger::payload::Payload;
use bp_ledger::signing::{public_key_hash, sign_event, ActorKeyRef, EventSignatureV1};
use chrono::{DateTime, Utc};
use ed25519_dalek::SigningKey;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn fixed_event_id(n: u8) -> EventId {
    EventId::from_uuid(
        uuid::Uuid::parse_str(&format!("01919000-0000-7000-8000-{:012}", n)).unwrap(),
    )
}
fn fixed_run_id() -> RunId {
    RunId::from_uuid(uuid::Uuid::parse_str("01919000-0000-7000-8000-0000000000ff").unwrap())
}
/// Distinct deterministic run id for the M2 plan-cycle tape so it is isolated
/// from the M1-S7 valid/tampered/bad-root fixtures at the run level, not just
/// at the event-id level.
fn fixed_plan_cycle_run_id() -> RunId {
    RunId::from_uuid(uuid::Uuid::parse_str("01919000-0000-7000-8000-0000000000fe").unwrap())
}
fn at(s: &str) -> DateTime<Utc> {
    s.parse().unwrap()
}

fn covered_events() -> Vec<Event> {
    let run_id = fixed_run_id();
    vec![
        Event {
            id: fixed_event_id(1),
            run_id,
            parent_event_id: None,
            schema_version: 1,
            kind: EventKind::RunStarted,
            occurred_at: at("2026-05-29T00:00:00Z"),
            payload: Payload::RunStartedV1(RunStartedV1 {
                packet_hash: "sha256:aa".into(),
                git_head: "dead".into(),
                workspace_path: "/ws".into(),
                config: BTreeMap::new(),
                parent_run_id: None,
                parent_event_id: None,
            }),
        },
        Event {
            id: fixed_event_id(2),
            run_id,
            parent_event_id: Some(fixed_event_id(1)),
            schema_version: 1,
            kind: EventKind::UnitStarted,
            occurred_at: at("2026-05-29T00:00:01Z"),
            payload: Payload::UnitStartedV1(UnitStartedV1 {
                unit_id: "u-1".into(),
                parent_unit_id: None,
                unit_kind: "command".into(),
                policy: json!({}),
            }),
        },
        Event {
            id: fixed_event_id(3),
            run_id,
            parent_event_id: Some(fixed_event_id(2)),
            schema_version: 1,
            kind: EventKind::RunCompleted,
            occurred_at: at("2026-05-29T00:00:02Z"),
            payload: Payload::RunCompletedV1(RunCompletedV1 {
                outcome: RunOutcome::Passed,
                duration_ms: "2".into(),
                event_count: "3".into(),
                unit_count: "1".into(),
            }),
        },
    ]
}

fn checkpoint_event(tape_root: String) -> Event {
    Event {
        id: fixed_event_id(10),
        run_id: fixed_run_id(),
        parent_event_id: Some(fixed_event_id(3)),
        schema_version: 1,
        kind: EventKind::TapeCheckpoint,
        occurred_at: at("2026-05-29T00:00:03Z"),
        payload: Payload::TapeCheckpointV1(TapeCheckpointV1 {
            run_id: fixed_run_id(),
            checkpoint_index: 0,
            through_event_id: fixed_event_id(3),
            through_event_count: 3,
            previous_checkpoint_event_id: None,
            tape_root_hash: tape_root,
            algorithm: TapeRootAlgorithm::Sha256Linear,
        }),
    }
}

fn plan_cycle_events() -> Vec<Event> {
    let run_id = fixed_plan_cycle_run_id();
    vec![
        Event {
            id: fixed_event_id(21),
            run_id,
            parent_event_id: None,
            schema_version: 1,
            kind: EventKind::RunStarted,
            occurred_at: at("2026-05-30T00:00:00Z"),
            payload: Payload::RunStartedV1(RunStartedV1 {
                packet_hash: "sha256:aa".into(),
                git_head: "dead".into(),
                workspace_path: "/ws".into(),
                config: BTreeMap::new(),
                parent_run_id: None,
                parent_event_id: None,
            }),
        },
        Event {
            id: fixed_event_id(22),
            run_id,
            parent_event_id: Some(fixed_event_id(21)),
            schema_version: 1,
            kind: EventKind::PlanAdmitted,
            occurred_at: at("2026-05-30T00:00:01Z"),
            payload: Payload::PlanAdmittedV1(PlanAdmittedV1 {
                plan_id: "pf-plan-fixture".into(),
                plan_digest: "sha256:aa".into(),
                input_digest: "sha256:bb".into(),
                trusted_base: "dead".into(),
                decided_by: "operator:fixture".into(),
                decided_at: "2026-05-30T00:00:01Z".into(),
                idempotency_key: "planforge:v0:buildplane:dead:fixture".into(),
                authorized_next_step: "dispatch_admitted_plan".into(),
            }),
        },
        Event {
            id: fixed_event_id(23),
            run_id,
            parent_event_id: Some(fixed_event_id(22)),
            schema_version: 1,
            kind: EventKind::ActivityStarted,
            occurred_at: at("2026-05-30T00:00:02Z"),
            payload: Payload::ActivityStartedV1(ActivityStartedV1 {
                run_id,
                activity_id: "act-1".into(),
                activity_type: ActivityType::Model,
                input_digest: "sha256:dd".into(),
            }),
        },
        Event {
            id: fixed_event_id(24),
            run_id,
            parent_event_id: Some(fixed_event_id(23)),
            schema_version: 1,
            kind: EventKind::ActivityCompleted,
            occurred_at: at("2026-05-30T00:00:03Z"),
            payload: Payload::ActivityCompletedV1(ActivityCompletedV1 {
                run_id,
                activity_id: "act-1".into(),
                result_digest: "sha256:ee".into(),
                result: json!({"content": "ok"}),
            }),
        },
        Event {
            id: fixed_event_id(25),
            run_id,
            parent_event_id: Some(fixed_event_id(24)),
            schema_version: 1,
            kind: EventKind::PlanReceiptRecorded,
            occurred_at: at("2026-05-30T00:00:04Z"),
            payload: Payload::PlanReceiptRecordedV1(PlanReceiptRecordedV1 {
                plan_id: "pf-plan-fixture".into(),
                admission_event_id: fixed_event_id(22),
                outcome: PlanReceiptOutcome::Completed,
                side_effects: vec!["fs.write:declared_scope".into()],
                result_digest: "sha256:cc".into(),
                decided_at: "2026-05-30T00:00:04Z".into(),
            }),
        },
    ]
}

fn plan_cycle_checkpoint(tape_root: String) -> Event {
    Event {
        id: fixed_event_id(26),
        run_id: fixed_plan_cycle_run_id(),
        parent_event_id: Some(fixed_event_id(25)),
        schema_version: 1,
        kind: EventKind::TapeCheckpoint,
        occurred_at: at("2026-05-30T00:00:05Z"),
        payload: Payload::TapeCheckpointV1(TapeCheckpointV1 {
            run_id: fixed_plan_cycle_run_id(),
            checkpoint_index: 0,
            through_event_id: fixed_event_id(25),
            through_event_count: 5,
            previous_checkpoint_event_id: None,
            tape_root_hash: tape_root,
            algorithm: TapeRootAlgorithm::Sha256Linear,
        }),
    }
}

fn signer() -> ActorKeyRef {
    ActorKeyRef {
        actor_id: "kernel".into(),
        key_id: "kernel-main".into(),
        public_key_hash: None,
    }
}

fn entry(event: &Event, sig: &EventSignatureV1) -> Value {
    let bytes = serde_json::to_vec(event).unwrap();
    json!({ "canonical_event_b64": STANDARD.encode(&bytes), "signature": serde_json::to_value(sig).unwrap() })
}

fn tampered_entry(event: &Event, sig: &EventSignatureV1) -> Value {
    let mut tampered = event.clone();
    if let Payload::UnitStartedV1(u) = &mut tampered.payload {
        u.unit_id = "u-TAMPERED".into();
    }
    let bytes = serde_json::to_vec(&tampered).unwrap();
    json!({ "canonical_event_b64": STANDARD.encode(&bytes), "signature": serde_json::to_value(sig).unwrap() })
}

fn write_tape(out_dir: &Path, variant: &str, run_id: RunId, key: &SigningKey, entries: Vec<Value>) {
    let trusted = json!([{
        "public_key_hash": public_key_hash(&key.verifying_key()),
        "public_key_b64": STANDARD.encode(key.verifying_key().to_bytes()),
    }]);
    let tape = json!({
        "format": "buildplane.signed-tape.v1",
        "run_id": run_id.to_string(),
        "trusted_keys": trusted,
        "events": entries,
    });
    let dir = out_dir.join(variant);
    std::fs::create_dir_all(&dir).unwrap();
    let mut content = serde_json::to_string_pretty(&tape).unwrap();
    content.push('\n');
    std::fs::write(dir.join("tape.json"), content).unwrap();
}

fn main() {
    let out_dir = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("test/fixtures/signed-tape"));

    let key = SigningKey::from_bytes(&[7u8; 32]);
    let signed_at = at("2026-05-29T00:00:05Z");

    let covered = covered_events();
    let covered_sigs: Vec<EventSignatureV1> = covered
        .iter()
        .map(|e| sign_event(e, &key, &signer(), signed_at).unwrap())
        .collect();

    let ordered: Vec<String> = covered_sigs
        .iter()
        .map(|s| s.canonical_event_hash.clone())
        .collect();
    let correct_root = tape_root_hash(&ordered);

    // valid
    {
        let cp = checkpoint_event(correct_root.clone());
        let cp_sig = sign_event(&cp, &key, &signer(), signed_at).unwrap();
        let mut entries: Vec<Value> = covered
            .iter()
            .zip(&covered_sigs)
            .map(|(e, s)| entry(e, s))
            .collect();
        entries.push(entry(&cp, &cp_sig));
        write_tape(&out_dir, "valid", fixed_run_id(), &key, entries);
    }

    // tampered: event #2 payload changed AFTER signing (hash_mismatch)
    {
        let cp = checkpoint_event(correct_root.clone());
        let cp_sig = sign_event(&cp, &key, &signer(), signed_at).unwrap();
        let entries: Vec<Value> = vec![
            entry(&covered[0], &covered_sigs[0]),
            tampered_entry(&covered[1], &covered_sigs[1]),
            entry(&covered[2], &covered_sigs[2]),
            entry(&cp, &cp_sig),
        ];
        write_tape(&out_dir, "tampered", fixed_run_id(), &key, entries);
    }

    // bad-root: checkpoint validly signed over a WRONG root
    {
        let wrong_root = format!("sha256:{}", "0".repeat(64));
        let cp = checkpoint_event(wrong_root);
        let cp_sig = sign_event(&cp, &key, &signer(), signed_at).unwrap();
        let mut entries: Vec<Value> = covered
            .iter()
            .zip(&covered_sigs)
            .map(|(e, s)| entry(e, s))
            .collect();
        entries.push(entry(&cp, &cp_sig));
        write_tape(&out_dir, "bad-root", fixed_run_id(), &key, entries);
    }

    // plan-cycle: a full PlanForge admission cycle (M2-S2) — every event signed,
    // checkpoint root correct. Proves the external verifier validates the new kinds.
    {
        let events = plan_cycle_events();
        let sigs: Vec<EventSignatureV1> = events
            .iter()
            .map(|e| sign_event(e, &key, &signer(), signed_at).unwrap())
            .collect();
        let ordered: Vec<String> = sigs
            .iter()
            .map(|s| s.canonical_event_hash.clone())
            .collect();
        let root = tape_root_hash(&ordered);
        let cp = plan_cycle_checkpoint(root);
        let cp_sig = sign_event(&cp, &key, &signer(), signed_at).unwrap();
        let mut entries: Vec<Value> = events.iter().zip(&sigs).map(|(e, s)| entry(e, s)).collect();
        entries.push(entry(&cp, &cp_sig));
        write_tape(
            &out_dir,
            "plan-cycle",
            fixed_plan_cycle_run_id(),
            &key,
            entries,
        );
    }

    eprintln!("wrote signed-tape fixtures to {}", out_dir.display());
}
