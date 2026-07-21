//! Integration tests for the serve_with_protocol state machine.

use bp_ledger::serve::{
    parse_control_or_event, serve_governed_with_protocol, serve_with_protocol,
    serve_with_protocol_with_activity_claims, ActivityClaimProtocolConfig,
    GovernedServeProtocolConfigV1, SigningConfig,
};
use bp_ledger::storage::{
    sqlite::{ActivityClaimAuthorityV1, CheckpointPolicy, SqliteStore},
    Cas,
};
use std::io::Cursor;
use tempfile::TempDir;

fn make_fixture() -> (SqliteStore, Cas, TempDir) {
    let tmp = TempDir::new().unwrap();
    let store = SqliteStore::open(tmp.path().join("events.db")).unwrap();
    let cas = Cas::open(tmp.path().join("objects")).unwrap();
    (store, cas, tmp)
}

fn handshake_line(schema: u32) -> String {
    format!(
        r#"{{"control":"handshake","protocol":1,"run_id":"01919000-0000-7000-8000-000000000000","started_at":"2026-04-17T12:00:00Z","schema_version":{}}}"#,
        schema
    )
}

fn close_line(seq: u64) -> String {
    format!(r#"{{"control":"close","seq":{}}}"#, seq)
}

fn governed_test_protocol(
    run_id: bp_ledger::RunId,
) -> (SigningConfig, GovernedServeProtocolConfigV1) {
    governed_test_protocol_with_checkpoint_policy(run_id, CheckpointPolicy::every(1))
}

fn governed_test_protocol_with_checkpoint_policy(
    run_id: bp_ledger::RunId,
    checkpoint_policy: CheckpointPolicy,
) -> (SigningConfig, GovernedServeProtocolConfigV1) {
    use bp_ledger::signing::{public_key_hash, ActorKeyRef, TrustedPublicKeys};
    use ed25519_dalek::SigningKey;

    let signing_key = SigningKey::from_bytes(&[31u8; 32]);
    let public_key_hash = public_key_hash(&signing_key.verifying_key());
    let signer = ActorKeyRef {
        actor_id: "kernel".into(),
        key_id: "kernel-main".into(),
        public_key_hash: Some(public_key_hash.clone()),
    };
    let mut trusted_keys = TrustedPublicKeys::default();
    trusted_keys.insert_public_key(
        public_key_hash,
        signing_key.verifying_key().to_bytes().to_vec(),
    );
    let authority = ActivityClaimAuthorityV1::new_governed_realm(
        trusted_keys,
        signer.clone(),
        signer.clone(),
        signer.clone(),
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
    )
    .expect("construct governed test authority");
    (
        SigningConfig::Signed {
            signing_key,
            signer,
            checkpoint_policy,
        },
        GovernedServeProtocolConfigV1 {
            expected_run_id: run_id,
            activity_claim_authority: authority,
        },
    )
}

#[test]
fn governed_serve_rejects_disabled_checkpoint_policy_before_reading_input() {
    use bp_ledger::id::RunId;
    use bp_ledger::storage::sqlite::CheckpointPolicy;
    use std::cell::Cell;
    use std::io::Read;
    use std::rc::Rc;

    struct CountingReader {
        reads: Rc<Cell<u32>>,
    }

    impl Read for CountingReader {
        fn read(&mut self, _buffer: &mut [u8]) -> std::io::Result<usize> {
            self.reads.set(self.reads.get() + 1);
            Ok(0)
        }
    }

    let (store, cas, _tmp) = make_fixture();
    let run_id =
        RunId::from_uuid(uuid::Uuid::parse_str("01919000-0000-7000-8000-000000000000").unwrap());
    let (signing, config) =
        governed_test_protocol_with_checkpoint_policy(run_id, CheckpointPolicy::Disabled);
    let reads = Rc::new(Cell::new(0));
    let mut stderr = Vec::new();

    let error = serve_governed_with_protocol(
        CountingReader {
            reads: reads.clone(),
        },
        &mut stderr,
        &store,
        &cas,
        1,
        &signing,
        &config,
    )
    .expect_err("governed serve must reject a disabled checkpoint policy before consuming stdin");

    assert!(matches!(
        error,
        bp_ledger::LedgerError::ActivityClaimAuthorityRejected { .. }
    ));
    assert_eq!(
        reads.get(),
        0,
        "disabled governed serve must not read stdin"
    );
    assert_eq!(store.event_count().unwrap(), 0);
    assert!(
        stderr.is_empty(),
        "disabled governed serve must not emit protocol output"
    );
}

#[test]
fn happy_path_handshake_then_close() {
    let (store, cas, _tmp) = make_fixture();
    let stdin = format!("{}\n{}\n", handshake_line(1), close_line(0));
    let mut stderr = Vec::new();
    let outcome = serve_with_protocol(
        Cursor::new(stdin.as_bytes()),
        &mut stderr,
        &store,
        &cas,
        1,
        &SigningConfig::Unsigned,
    )
    .unwrap();
    assert_eq!(outcome.events_written, 0);
    let stderr_text = String::from_utf8(stderr).unwrap();
    assert!(stderr_text.contains(r#""control":"handshake_ack""#));
    assert!(stderr_text.contains(r#""ready":true"#));
    assert!(stderr_text.contains(r#""control":"close_ack""#));
}

#[test]
fn governed_serve_rejects_all_caller_events_before_they_reach_the_tape() {
    use bp_ledger::event::Event;
    use bp_ledger::id::{EventId, RunId};
    use bp_ledger::kind::EventKind;
    use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
    use bp_ledger::payload::Payload;
    use chrono::Utc;

    let (store, cas, _tmp) = make_fixture();
    let run_id =
        RunId::from_uuid(uuid::Uuid::parse_str("01919000-0000-7000-8000-000000000000").unwrap());
    let (signing, config) = governed_test_protocol(run_id);
    let event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: 1,
        kind: EventKind::RunCompleted,
        occurred_at: Utc::now(),
        payload: Payload::RunCompletedV1(RunCompletedV1 {
            outcome: RunOutcome::Passed,
            duration_ms: "0".into(),
            event_count: "1".into(),
            unit_count: "0".into(),
        }),
    };
    let stdin = format!(
        "{}\n{}\n{}\n",
        handshake_line(1),
        serde_json::to_string(&event).unwrap(),
        close_line(0),
    );
    let mut stderr = Vec::new();
    let error = serve_governed_with_protocol(
        Cursor::new(stdin.as_bytes()),
        &mut stderr,
        &store,
        &cas,
        1,
        &signing,
        &config,
    )
    .expect_err("governed serve must never sign caller-supplied events");

    assert!(matches!(
        error,
        bp_ledger::LedgerError::CallerSuppliedGovernedEvent { .. }
    ));
    assert_eq!(store.event_count().unwrap(), 0);
    let output = String::from_utf8(stderr).unwrap();
    assert!(output.contains("caller_supplied_governed_event"));
}

#[test]
fn governed_serve_binds_the_handshake_and_every_activity_control_to_one_run() {
    use bp_ledger::id::RunId;

    let (store, cas, _tmp) = make_fixture();
    let run_id =
        RunId::from_uuid(uuid::Uuid::parse_str("01919000-0000-7000-8000-000000000000").unwrap());
    let (signing, config) = governed_test_protocol(run_id);
    let wrong_run = "01919000-0000-7000-8000-000000000001";
    let claim = format!(
        r#"{{"control":"claim_activity_v1","request_id":"claim-1","run_id":"{wrong_run}","activity_id":"action-1","idempotency_key":"key-1","dispatch_event_id":"01919000-0000-7000-8000-000000000002","action_request_event_id":"01919000-0000-7000-8000-000000000003","lease_duration_ms":1000}}"#,
    );
    let stdin = format!("{}\n{}\n{}\n", handshake_line(1), claim, close_line(0));
    let mut stderr = Vec::new();
    let error = serve_governed_with_protocol(
        Cursor::new(stdin.as_bytes()),
        &mut stderr,
        &store,
        &cas,
        1,
        &signing,
        &config,
    )
    .expect_err("a different run cannot use this governed session");

    assert!(matches!(
        error,
        bp_ledger::LedgerError::GovernedServeRunMismatch { .. }
    ));
    assert_eq!(store.event_count().unwrap(), 0);
    let output = String::from_utf8(stderr).unwrap();
    assert!(output.contains("governed_run_mismatch"));
}

#[test]
fn governed_serve_requires_signed_append_before_accepting_a_handshake() {
    use bp_ledger::id::RunId;

    let (store, cas, _tmp) = make_fixture();
    let run_id =
        RunId::from_uuid(uuid::Uuid::parse_str("01919000-0000-7000-8000-000000000000").unwrap());
    let (_signing, config) = governed_test_protocol(run_id);
    let error = serve_governed_with_protocol(
        Cursor::new(handshake_line(1)),
        Vec::new(),
        &store,
        &cas,
        1,
        &SigningConfig::Unsigned,
        &config,
    )
    .expect_err("governed serve must not downgrade to unsigned append");
    assert!(matches!(
        error,
        bp_ledger::LedgerError::ActivityClaimAuthorityRejected { .. }
    ));
    assert_eq!(store.event_count().unwrap(), 0);
}

#[test]
fn first_line_not_handshake_rejects() {
    let (store, cas, _tmp) = make_fixture();
    let stdin = r#"{"control":"flush","seq":0}"#;
    let mut stderr = Vec::new();
    let err = serve_with_protocol(
        Cursor::new(stdin),
        &mut stderr,
        &store,
        &cas,
        1,
        &SigningConfig::Unsigned,
    );
    assert!(err.is_err());
    let stderr_text = String::from_utf8(stderr).unwrap();
    assert!(
        stderr_text.contains(r#""control":"error""#) || stderr_text.contains(r#""ready":false"#)
    );
}

#[test]
fn schema_version_mismatch_rejects() {
    let (store, cas, _tmp) = make_fixture();
    let stdin = format!("{}\n", handshake_line(99));
    let mut stderr = Vec::new();
    let err = serve_with_protocol(
        Cursor::new(stdin.as_bytes()),
        &mut stderr,
        &store,
        &cas,
        1,
        &SigningConfig::Unsigned,
    );
    assert!(err.is_err());
    let stderr_text = String::from_utf8(stderr).unwrap();
    assert!(stderr_text.contains(r#""ready":false"#));
    assert!(stderr_text.contains("schema"));
}

#[test]
fn event_after_handshake_is_stored() {
    use bp_ledger::event::Event;
    use bp_ledger::id::{EventId, RunId};
    use bp_ledger::kind::EventKind;
    use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
    use bp_ledger::payload::Payload;
    use chrono::Utc;

    let (store, cas, _tmp) = make_fixture();
    let event = Event {
        id: EventId::new(),
        run_id: RunId::new(),
        parent_event_id: None,
        schema_version: 1,
        kind: EventKind::RunCompleted,
        occurred_at: Utc::now(),
        payload: Payload::RunCompletedV1(RunCompletedV1 {
            outcome: RunOutcome::Passed,
            duration_ms: "0".into(),
            event_count: "1".into(),
            unit_count: "0".into(),
        }),
    };
    let stdin = format!(
        "{}\n{}\n{}\n",
        handshake_line(1),
        serde_json::to_string(&event).unwrap(),
        close_line(1),
    );
    let mut stderr = Vec::new();
    let outcome = serve_with_protocol(
        Cursor::new(stdin.as_bytes()),
        &mut stderr,
        &store,
        &cas,
        1,
        &SigningConfig::Unsigned,
    )
    .unwrap();
    assert_eq!(outcome.events_written, 1);
    assert_eq!(outcome.last_event_id, Some(event.id));
}

#[test]
fn mismatched_kind_and_payload_is_rejected_before_store() {
    use bp_ledger::event::Event;
    use bp_ledger::id::{EventId, RunId};
    use bp_ledger::kind::EventKind;
    use bp_ledger::payload::workspace::WorkspaceReadV1;
    use bp_ledger::payload::Payload;
    use chrono::Utc;

    let (store, cas, _tmp) = make_fixture();
    let event = Event {
        id: EventId::new(),
        run_id: RunId::new(),
        parent_event_id: None,
        schema_version: 1,
        kind: EventKind::RunCompleted,
        occurred_at: Utc::now(),
        payload: Payload::WorkspaceReadV1(WorkspaceReadV1 {
            tool_request_id: EventId::new(),
            path: "README.md".into(),
            content_hash: "abc123".into(),
            size_bytes: 12,
        }),
    };
    let stdin = format!(
        "{}\n{}\n",
        handshake_line(1),
        serde_json::to_string(&event).unwrap(),
    );
    let mut stderr = Vec::new();
    let err = serve_with_protocol(
        Cursor::new(stdin.as_bytes()),
        &mut stderr,
        &store,
        &cas,
        1,
        &SigningConfig::Unsigned,
    );
    assert!(err.is_err());
    let stderr_text = String::from_utf8(stderr).unwrap();
    assert!(stderr_text.contains(r#""control":"handshake_ack""#));
    assert_eq!(store.event_count().unwrap(), 0);
}

#[test]
fn flush_ack_carries_seq() {
    use bp_ledger::event::Event;
    use bp_ledger::id::{EventId, RunId};
    use bp_ledger::kind::EventKind;
    use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
    use bp_ledger::payload::Payload;
    use chrono::Utc;

    let (store, cas, _tmp) = make_fixture();
    let event = Event {
        id: EventId::new(),
        run_id: RunId::new(),
        parent_event_id: None,
        schema_version: 1,
        kind: EventKind::RunCompleted,
        occurred_at: Utc::now(),
        payload: Payload::RunCompletedV1(RunCompletedV1 {
            outcome: RunOutcome::Passed,
            duration_ms: "0".into(),
            event_count: "1".into(),
            unit_count: "0".into(),
        }),
    };
    let stdin = format!(
        "{}\n{}\n{}\n{}\n",
        handshake_line(1),
        serde_json::to_string(&event).unwrap(),
        r#"{"control":"flush","seq":7}"#,
        close_line(2),
    );
    let mut stderr = Vec::new();
    serve_with_protocol(
        Cursor::new(stdin.as_bytes()),
        &mut stderr,
        &store,
        &cas,
        1,
        &SigningConfig::Unsigned,
    )
    .unwrap();
    let stderr_text = String::from_utf8(stderr).unwrap();
    assert!(stderr_text.contains(r#""control":"flush_ack""#));
    assert!(stderr_text.contains(r#""seq":7"#));
}

#[test]
fn signed_mode_ingests_non_authoritative_observation_and_reads_back_verified() {
    use bp_ledger::event::Event;
    use bp_ledger::id::{EventId, RunId};
    use bp_ledger::keyring::{load_signing_key_at, KeyringRef};
    use bp_ledger::kind::EventKind;
    use bp_ledger::payload::workspace::WorkspaceReadV1;
    use bp_ledger::payload::Payload;
    use bp_ledger::signing::{public_key_hash, ActorKeyRef, TrustedPublicKeys, VerificationStatus};
    use chrono::Utc;

    let (store, cas, tmp) = make_fixture();

    // Deterministic fixture key under a temp keyring root; never the real ~/.buildplane.
    let key_root = tmp.path().join("keys");
    std::fs::create_dir_all(key_root.join("kernel")).unwrap();
    std::fs::write(
        key_root.join("kernel").join("kernel-main.ed25519"),
        [5u8; 32],
    )
    .unwrap();
    let signing_key =
        load_signing_key_at(&key_root, &KeyringRef::new("kernel", "kernel-main")).unwrap();

    let signing = SigningConfig::Signed {
        signing_key: signing_key.clone(),
        signer: ActorKeyRef {
            actor_id: "kernel".into(),
            key_id: "kernel-main".into(),
            public_key_hash: None,
        },
        // This test asserts a single signed event reads back verified; disable
        // checkpoints so no final checkpoint event is emitted at run_completed.
        checkpoint_policy: bp_ledger::storage::sqlite::CheckpointPolicy::Disabled,
    };

    let run_id = RunId::new();
    let event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: 1,
        kind: EventKind::WorkspaceRead,
        occurred_at: Utc::now(),
        payload: Payload::WorkspaceReadV1(WorkspaceReadV1 {
            tool_request_id: EventId::new(),
            path: "src/lib.rs".into(),
            content_hash: "sha256:aa".into(),
            size_bytes: 1,
        }),
    };
    let stdin = format!(
        "{}\n{}\n{}\n",
        handshake_line(1),
        serde_json::to_string(&event).unwrap(),
        close_line(1),
    );
    let mut stderr = Vec::new();
    let outcome = serve_with_protocol(
        Cursor::new(stdin.as_bytes()),
        &mut stderr,
        &store,
        &cas,
        1,
        &signing,
    )
    .unwrap();
    assert_eq!(outcome.events_written, 1);

    let mut trusted = TrustedPublicKeys::default();
    trusted.insert_public_key(
        public_key_hash(&signing_key.verifying_key()),
        signing_key.verifying_key().to_bytes().to_vec(),
    );
    let rows = store
        .verified_events_for_run(&run_id.to_string(), &trusted)
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].verification, VerificationStatus::Verified);
}

#[test]
fn signed_serve_loop_emits_verified_checkpoints_for_observational_events_at_cadence() {
    use bp_ledger::event::Event;
    use bp_ledger::id::{EventId, RunId};
    use bp_ledger::kind::EventKind;
    use bp_ledger::payload::workspace::WorkspaceReadV1;
    use bp_ledger::payload::Payload;
    use bp_ledger::signing::{public_key_hash, ActorKeyRef, TrustedPublicKeys, VerificationStatus};
    use bp_ledger::storage::sqlite::CheckpointPolicy;
    use chrono::Utc;

    let (store, cas, tmp) = make_fixture();
    let key_root = tmp.path().join("keys");
    std::fs::create_dir_all(key_root.join("kernel")).unwrap();
    std::fs::write(
        key_root.join("kernel").join("kernel-main.ed25519"),
        [5u8; 32],
    )
    .unwrap();
    let signing_key = bp_ledger::keyring::load_signing_key_at(
        &key_root,
        &bp_ledger::keyring::KeyringRef::new("kernel", "kernel-main"),
    )
    .unwrap();

    // Live signed loop with a small explicit cadence so the test is fast.
    let signing = SigningConfig::Signed {
        signing_key: signing_key.clone(),
        signer: ActorKeyRef {
            actor_id: "kernel".into(),
            key_id: "kernel-main".into(),
            public_key_hash: None,
        },
        checkpoint_policy: CheckpointPolicy::every(2),
    };

    let run_id = RunId::new();
    let make = || Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: 1,
        kind: EventKind::WorkspaceRead,
        occurred_at: Utc::now(),
        payload: Payload::WorkspaceReadV1(WorkspaceReadV1 {
            tool_request_id: EventId::new(),
            path: "src/lib.rs".into(),
            content_hash: "sha256:aa".into(),
            size_bytes: 1,
        }),
    };
    let e1 = make();
    let e2 = make();
    let stdin = format!(
        "{}\n{}\n{}\n{}\n",
        handshake_line(1),
        serde_json::to_string(&e1).unwrap(),
        serde_json::to_string(&e2).unwrap(),
        close_line(1),
    );
    let mut stderr = Vec::new();
    let outcome = serve_with_protocol(
        Cursor::new(stdin.as_bytes()),
        &mut stderr,
        &store,
        &cas,
        1,
        &signing,
    )
    .unwrap();
    // Only ordinary ingested events are counted by the serve outcome.
    assert_eq!(outcome.events_written, 2);

    let mut trusted = TrustedPublicKeys::default();
    trusted.insert_public_key(
        public_key_hash(&signing_key.verifying_key()),
        signing_key.verifying_key().to_bytes().to_vec(),
    );
    let rows = store
        .verified_events_for_run(&run_id.to_string(), &trusted)
        .unwrap();
    // 2 ordinary events + 1 cadence checkpoint, all verified.
    assert_eq!(rows.len(), 3);
    for row in &rows {
        assert_eq!(row.verification, VerificationStatus::Verified);
    }
    let checkpoint_rows = rows
        .iter()
        .filter(|r| r.event.kind == "tape_checkpoint")
        .count();
    assert_eq!(
        checkpoint_rows, 1,
        "one checkpoint at cadence 2 over 2 events"
    );
}

#[test]
fn malformed_event_line_writes_error_and_fails() {
    let (store, cas, _tmp) = make_fixture();
    let stdin = format!("{}\ngarbage not json\n", handshake_line(1));
    let mut stderr = Vec::new();
    let err = serve_with_protocol(
        Cursor::new(stdin.as_bytes()),
        &mut stderr,
        &store,
        &cas,
        1,
        &SigningConfig::Unsigned,
    );
    assert!(err.is_err());
    let stderr_text = String::from_utf8(stderr).unwrap();
    assert!(stderr_text.contains(r#""control":"handshake_ack""#));
    assert!(stderr_text.contains(r#""control":"error""#));
    assert!(stderr_text.contains(r#""kind":"malformed_event""#));
}

#[test]
fn signed_generic_ingest_rejects_lifecycle_authority_with_jsonl_error() {
    use bp_ledger::event::Event;
    use bp_ledger::id::{EventId, RunId};
    use bp_ledger::kind::EventKind;
    use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome};
    use bp_ledger::payload::Payload;
    use bp_ledger::signing::ActorKeyRef;
    use bp_ledger::storage::sqlite::CheckpointPolicy;
    use chrono::Utc;
    use ed25519_dalek::SigningKey;

    let (store, cas, _tmp) = make_fixture();
    let signing = SigningConfig::Signed {
        signing_key: SigningKey::from_bytes(&[5u8; 32]),
        signer: ActorKeyRef {
            actor_id: "kernel".into(),
            key_id: "kernel-main".into(),
            public_key_hash: None,
        },
        checkpoint_policy: CheckpointPolicy::Disabled,
    };
    let event = Event {
        id: EventId::new(),
        run_id: RunId::new(),
        parent_event_id: None,
        schema_version: 1,
        kind: EventKind::RunCompleted,
        occurred_at: Utc::now(),
        payload: Payload::RunCompletedV1(RunCompletedV1 {
            outcome: RunOutcome::Passed,
            duration_ms: "0".into(),
            event_count: "1".into(),
            unit_count: "0".into(),
        }),
    };
    let stdin = format!(
        "{}\n{}\n{}\n",
        handshake_line(1),
        serde_json::to_string(&event).unwrap(),
        close_line(0),
    );
    let mut stderr = Vec::new();

    assert!(
        serve_with_protocol(
            Cursor::new(stdin.as_bytes()),
            &mut stderr,
            &store,
            &cas,
            1,
            &signing,
        )
        .is_err(),
        "the generic signed endpoint must reject caller-supplied lifecycle authority"
    );
    assert_eq!(
        store.event_count().unwrap(),
        0,
        "a rejected authority event must not reach the tape"
    );
    let messages: Vec<serde_json::Value> = String::from_utf8(stderr)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).expect("serve responses must be JSON"))
        .collect();
    let error = messages
        .iter()
        .find(|message| message["control"] == "error")
        .expect("rejected input must receive a JSONL error response");
    assert_eq!(error["kind"], "caller_supplied_authority_event");
    assert_eq!(error["line"], 2);
    assert!(error["message"]
        .as_str()
        .is_some_and(|message| message.contains("run_completed")));
}

#[test]
fn resolve_or_authorize_model_action_control_is_closed() {
    for line in [
        r#"{"control":"resolve_or_authorize_model_action_v1","request_id":"authority-request-1","authority_actor":"kernel:forged"}"#,
        r#"{"control":"resolve_or_authorize_model_action_v1","request_id":""}"#,
        r#"{"control":"resolve_or_authorize_model_action_v1"}"#,
    ] {
        assert!(
            parse_control_or_event(line).is_err(),
            "reserved authority control must reject malformed shape: {line}"
        );
    }
}

#[test]
fn resolve_or_authorize_model_action_gate_does_not_infer_authority_from_append_signing() {
    use bp_ledger::keyring::{load_signing_key_at, KeyringRef};
    use bp_ledger::signing::ActorKeyRef;
    use bp_ledger::storage::sqlite::CheckpointPolicy;

    let (store, cas, tmp) = make_fixture();
    let key_root = tmp.path().join("keys");
    std::fs::create_dir_all(key_root.join("kernel")).unwrap();
    std::fs::write(
        key_root.join("kernel").join("kernel-main.ed25519"),
        [7u8; 32],
    )
    .unwrap();
    let signing_key =
        load_signing_key_at(&key_root, &KeyringRef::new("kernel", "kernel-main")).unwrap();
    let signing = SigningConfig::Signed {
        signing_key,
        signer: ActorKeyRef {
            actor_id: "kernel".into(),
            key_id: "kernel-main".into(),
            public_key_hash: None,
        },
        checkpoint_policy: CheckpointPolicy::Disabled,
    };
    let stdin = format!(
        "{}\n{}\n{}\n{}\n",
        handshake_line(1),
        r#"{"control":"resolve_or_authorize_model_action_v1","request_id":"authority-request-1"}"#,
        r#"{"control":"flush","seq":9}"#,
        close_line(0),
    );
    let mut stderr = Vec::new();

    let outcome = serve_with_protocol(
        Cursor::new(stdin.as_bytes()),
        &mut stderr,
        &store,
        &cas,
        1,
        &signing,
    )
    .expect("the unavailable authority operation must return a closed result, not abort serve");

    assert_eq!(outcome.events_written, 0);
    assert_eq!(
        store.event_count().unwrap(),
        0,
        "the gate must never append"
    );

    let stderr_text = String::from_utf8(stderr).unwrap();
    let messages: Vec<serde_json::Value> = stderr_text
        .lines()
        .map(|line| serde_json::from_str(line).expect("serve responses must be JSON"))
        .collect();
    let authority_result = messages
        .iter()
        .find(|message| message["control"] == "resolve_or_authorize_model_action_v1_result")
        .expect("the authority operation must return one typed result");
    assert_eq!(authority_result["request_id"], "authority-request-1");
    assert_eq!(authority_result["outcome"], "rejected");
    assert_eq!(
        authority_result["code"],
        "trusted_replay_authority_unconfigured"
    );
    assert!(messages
        .iter()
        .any(|message| message["control"] == "flush_ack" && message["seq"] == 9));
    assert!(messages
        .iter()
        .any(|message| message["control"] == "close_ack"));
}

#[test]
fn activity_claim_control_is_closed_and_default_serve_fails_closed() {
    let malformed = r#"{"control":"claim_activity_v1","request_id":"claim-1","run_id":"01919000-0000-7000-8000-000000000000","activity_id":"action-1","idempotency_key":"key-1","dispatch_event_id":"01919000-0000-7000-8000-000000000001","action_request_event_id":"01919000-0000-7000-8000-000000000002","lease_duration_ms":1000,"forged_authority":true}"#;
    assert!(
        parse_control_or_event(malformed).is_err(),
        "authority-bearing claim controls must reject unknown fields"
    );

    let (store, cas, _tmp) = make_fixture();
    let claim = r#"{"control":"claim_activity_v1","request_id":"claim-1","run_id":"01919000-0000-7000-8000-000000000000","activity_id":"action-1","idempotency_key":"key-1","dispatch_event_id":"01919000-0000-7000-8000-000000000001","action_request_event_id":"01919000-0000-7000-8000-000000000002","lease_duration_ms":1000}"#;
    let stdin = format!("{}\n{}\n{}\n", handshake_line(1), claim, close_line(0));
    let mut stderr = Vec::new();
    let outcome = serve_with_protocol(
        Cursor::new(stdin.as_bytes()),
        &mut stderr,
        &store,
        &cas,
        1,
        &SigningConfig::Unsigned,
    )
    .expect("disabled authority controls return a typed rejection, not a protocol abort");
    assert_eq!(outcome.events_written, 0);
    assert_eq!(store.event_count().unwrap(), 0);
    let messages: Vec<serde_json::Value> = String::from_utf8(stderr)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let rejection = messages
        .iter()
        .find(|message| message["control"] == "claim_activity_v1_result")
        .expect("claim operation must emit one typed response");
    assert_eq!(rejection["outcome"], "rejected");
    assert_eq!(rejection["code"], "trusted_activity_authority_unconfigured");
}

#[test]
fn activity_claims_require_signed_append_even_with_trusted_authority_configured() {
    use bp_ledger::signing::{public_key_hash, ActorKeyRef, TrustedPublicKeys};
    use ed25519_dalek::SigningKey;

    let (store, cas, _tmp) = make_fixture();
    let signing_key = SigningKey::from_bytes(&[41u8; 32]);
    let actor = ActorKeyRef {
        actor_id: "kernel".into(),
        key_id: "kernel-main".into(),
        public_key_hash: Some(public_key_hash(&signing_key.verifying_key())),
    };
    let mut trusted = TrustedPublicKeys::default();
    trusted.insert_public_key(
        actor.public_key_hash.clone().unwrap(),
        signing_key.verifying_key().to_bytes().to_vec(),
    );
    let authority =
        ActivityClaimAuthorityV1::new(trusted, actor.clone(), actor.clone(), actor).unwrap();
    let claim = r#"{"control":"claim_activity_v1","request_id":"claim-1","run_id":"01919000-0000-7000-8000-000000000000","activity_id":"action-1","idempotency_key":"key-1","dispatch_event_id":"01919000-0000-7000-8000-000000000001","action_request_event_id":"01919000-0000-7000-8000-000000000002","lease_duration_ms":1000}"#;
    let stdin = format!("{}\n{}\n{}\n", handshake_line(1), claim, close_line(0));
    let mut stderr = Vec::new();
    serve_with_protocol_with_activity_claims(
        Cursor::new(stdin.as_bytes()),
        &mut stderr,
        &store,
        &cas,
        1,
        &SigningConfig::Unsigned,
        &ActivityClaimProtocolConfig::Signed(authority),
    )
    .unwrap();
    let messages: Vec<serde_json::Value> = String::from_utf8(stderr)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let rejection = messages
        .iter()
        .find(|message| message["control"] == "claim_activity_v1_result")
        .unwrap();
    assert_eq!(rejection["outcome"], "rejected");
    assert_eq!(rejection["code"], "signed_append_required");
    assert_eq!(store.event_count().unwrap(), 0);
}
