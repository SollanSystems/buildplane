use bp_ledger::canonicalize::{canonical_event_bytes, canonicalize_payload};
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::plan_lifecycle::{
    PlanAdmittedV1, PlanReceiptOutcome, PlanReceiptRecordedV1,
};
use bp_ledger::payload::Payload;
use bp_ledger::serve::{serve_with_protocol, SigningConfig};
use bp_ledger::signing::ActorKeyRef;
use bp_ledger::storage::sqlite::{CheckpointPolicy, SqliteStore};
use bp_ledger::storage::Cas;
use bp_ledger::LedgerError;
use chrono::Utc;
use ed25519_dalek::SigningKey;
use std::io::Cursor;
use tempfile::TempDir;

const INGEST_RUN_UUID: &str = "01919000-0000-7000-8000-0000000000a1";

fn admitted() -> PlanAdmittedV1 {
    PlanAdmittedV1 {
        plan_id: "pf-plan-001".into(),
        plan_digest: "sha256:aa".into(),
        input_digest: "sha256:bb".into(),
        trusted_base: "deadbeef".into(),
        decided_by: "operator:khall".into(),
        decided_at: "2026-05-30T00:00:00Z".into(),
        idempotency_key: "planforge:v0:buildplane:deadbeef:abcd1234".into(),
        authorized_next_step: "dispatch_admitted_plan".into(),
    }
}

#[test]
fn plan_kinds_use_wire_names() {
    assert_eq!(EventKind::PlanAdmitted.as_wire(), "plan_admitted");
    assert_eq!(EventKind::PlanReceiptRecorded.as_wire(), "plan_receipt");
    assert_eq!(
        serde_json::to_string(&EventKind::PlanAdmitted).unwrap(),
        r#""plan_admitted""#
    );
}

#[test]
fn plan_admitted_canonicalizes_by_kind_and_variant() {
    let payload = Payload::PlanAdmittedV1(admitted());
    let value = serde_json::to_value(&payload).unwrap();
    match canonicalize_payload("plan_admitted", 1, value).unwrap() {
        Payload::PlanAdmittedV1(p) => {
            assert_eq!(p.plan_id, "pf-plan-001");
            assert_eq!(p.authorized_next_step, "dispatch_admitted_plan");
        }
        other => panic!("unexpected variant: {other:?}"),
    }
}

#[test]
fn plan_admitted_rejects_mismatched_kind() {
    let value = serde_json::to_value(Payload::PlanAdmittedV1(admitted())).unwrap();
    assert!(canonicalize_payload("plan_receipt", 1, value).is_err());
}

#[test]
fn plan_receipt_canonical_bytes_carry_chain_and_digest() {
    let event = Event {
        id: EventId::new(),
        run_id: RunId::new(),
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::PlanReceiptRecorded,
        occurred_at: Utc::now(),
        payload: Payload::PlanReceiptRecordedV1(PlanReceiptRecordedV1 {
            plan_id: "pf-plan-001".into(),
            admission_event_id: EventId::new(),
            outcome: PlanReceiptOutcome::Completed,
            side_effects: vec!["fs.write:declared_scope".into()],
            result_digest: "sha256:cc".into(),
            decided_at: "2026-05-30T00:01:00Z".into(),
        }),
    };
    let json = String::from_utf8(canonical_event_bytes(&event).unwrap()).unwrap();
    assert!(json.contains("plan_receipt"));
    assert!(json.contains("admission_event_id"));
    assert!(json.contains("result_digest"));
    assert!(json.contains("completed"));
}

fn ingest_run_id() -> RunId {
    RunId::from_uuid(uuid::Uuid::parse_str(INGEST_RUN_UUID).unwrap())
}

fn plan_admitted_event() -> Event {
    Event {
        id: EventId::new(),
        run_id: ingest_run_id(),
        parent_event_id: None,
        schema_version: 1,
        kind: EventKind::PlanAdmitted,
        occurred_at: Utc::now(),
        payload: Payload::PlanAdmittedV1(admitted()),
    }
}

fn ingest_fixture() -> (SqliteStore, Cas, TempDir) {
    let tmp = TempDir::new().unwrap();
    let store = SqliteStore::open(tmp.path().join("events.db")).unwrap();
    let cas = Cas::open(tmp.path().join("objects")).unwrap();
    (store, cas, tmp)
}

fn ingest_signer() -> (SigningKey, ActorKeyRef) {
    (
        SigningKey::from_bytes(&[91u8; 32]),
        ActorKeyRef {
            actor_id: "kernel".into(),
            key_id: "kernel-main".into(),
            public_key_hash: None,
        },
    )
}

fn ingest_stdin(event: &Event) -> String {
    format!(
        concat!(
            r#"{{"control":"handshake","protocol":1,"run_id":"{run_id}","#,
            r#""started_at":"2026-08-17T00:00:00Z","schema_version":1}}"#,
            "\n{event}\n",
            r#"{{"control":"close","seq":0}}"#,
            "\n",
        ),
        run_id = INGEST_RUN_UUID,
        event = serde_json::to_string(event).unwrap(),
    )
}

/// The signed generic-ingest lane refuses `plan_admitted` in
/// `reject_caller_supplied_authority_event`, before any append is attempted.
#[test]
fn generic_signed_ingest_refuses_a_caller_supplied_plan_admitted_without_a_write() {
    let (store, cas, _tmp) = ingest_fixture();
    let (signing_key, signer) = ingest_signer();
    let mut stderr = Vec::new();

    let error = serve_with_protocol(
        Cursor::new(ingest_stdin(&plan_admitted_event()).into_bytes()),
        &mut stderr,
        &store,
        &cas,
        1,
        &SigningConfig::Signed {
            signing_key,
            signer,
            checkpoint_policy: CheckpointPolicy::every(1),
        },
    )
    .expect_err("the signed generic ingest lane must never bless a plan admission");

    assert!(
        matches!(
            error,
            LedgerError::CallerSuppliedSignedAuthorityEvent { ref kind }
                if kind == "plan_admitted"
        ),
        "expected a signed-authority rejection, got {error:?}"
    );
    assert_eq!(store.event_count().unwrap(), 0);
    assert!(String::from_utf8(stderr)
        .unwrap()
        .contains("caller_supplied_authority_event"));
}

/// The unsigned generic-ingest lane clears the wire guard (`plan_admitted` is
/// signed-only there) and is refused one layer down, in
/// `validate_external_append`, which the serve loop reports as
/// `storage_failure`.
#[test]
fn generic_unsigned_ingest_refuses_a_caller_supplied_plan_admitted_without_a_write() {
    let (store, cas, _tmp) = ingest_fixture();
    let mut stderr = Vec::new();

    let error = serve_with_protocol(
        Cursor::new(ingest_stdin(&plan_admitted_event()).into_bytes()),
        &mut stderr,
        &store,
        &cas,
        1,
        &SigningConfig::Unsigned,
    )
    .expect_err("the unsigned generic ingest lane must never land a plan admission");

    assert!(
        matches!(
            error,
            LedgerError::CallerSuppliedTrustSpineEvent { ref kind }
                if kind == "plan_admitted"
        ),
        "expected a trust-spine rejection, got {error:?}"
    );
    assert_eq!(store.event_count().unwrap(), 0);
    assert!(String::from_utf8(stderr)
        .unwrap()
        .contains("storage_failure"));
}

/// The refusal cannot be side-stepped by mislabelling the envelope either.
/// `bp-replay` dispatches on the payload variant and never reads `event.kind`
/// (`transitions.rs` `apply_with_verified_signer`), so a `PlanAdmittedV1`
/// payload carried under a permitted kind would still replay as a genuine
/// admission. Production writers canonicalize before appending, which enforces
/// kind/payload agreement — but the exclusivity claim must not rest on an
/// invariant only well-behaved callers honour.
///
/// This test and its mirror below pin the two INDEPENDENT clauses of
/// `validate_external_append`: this one the payload check, the mirror the kind
/// check. Both clauses raise the identical error, so a test that pairs
/// kind=PlanAdmitted with payload=PlanAdmittedV1 stays green if either clause is
/// deleted. Only this pair distinguishes them. Keep both.
#[test]
fn a_mislabelled_envelope_cannot_smuggle_a_plan_admitted_payload() {
    let store = SqliteStore::open_in_memory().unwrap();
    let smuggled = Event {
        kind: EventKind::ModelRequest,
        ..plan_admitted_event()
    };

    let outcome = store.append(&smuggled);

    assert!(
        matches!(
            outcome,
            Err(LedgerError::CallerSuppliedTrustSpineEvent { ref kind })
                if kind == "plan_admitted"
        ),
        "a plan-admission payload must be refused whatever kind it declares, got {outcome:?}"
    );
    assert_eq!(store.event_count().unwrap(), 0);
}

/// The mirror, pinning the kind check on its own. A `plan_admitted` envelope
/// carrying some other payload is not inert: `append` does not canonicalize, so
/// nothing else rejects the row, and the kernel's admitted-plan reader selects
/// by `kind = 'plan_admitted'` — a label-only row is exactly what it would find.
#[test]
fn a_plan_admitted_envelope_is_refused_whatever_payload_it_carries() {
    let store = SqliteStore::open_in_memory().unwrap();
    let mislabelled = Event {
        payload: Payload::PlanReceiptRecordedV1(PlanReceiptRecordedV1 {
            plan_id: "pf-plan-001".into(),
            admission_event_id: EventId::new(),
            outcome: PlanReceiptOutcome::Completed,
            side_effects: vec![],
            result_digest: "sha256:cc".into(),
            decided_at: "2026-08-17T00:00:00Z".into(),
        }),
        ..plan_admitted_event()
    };

    let outcome = store.append(&mislabelled);

    assert!(
        matches!(
            outcome,
            Err(LedgerError::CallerSuppliedTrustSpineEvent { ref kind })
                if kind == "plan_admitted"
        ),
        "a plan-admission envelope must be refused whatever payload it carries, got {outcome:?}"
    );
    assert_eq!(store.event_count().unwrap(), 0);
}

/// Every public append entry point shares `validate_external_append`, so the
/// refusal cannot be side-stepped by choosing a different one.
#[test]
fn every_public_store_append_path_refuses_a_caller_supplied_plan_admitted() {
    let store = SqliteStore::open_in_memory().unwrap();
    let (signing_key, signer) = ingest_signer();

    let unsigned = store.append(&plan_admitted_event());
    let signed = store.append_signed(&plan_admitted_event(), &signing_key, &signer);
    let checkpointed = store
        .append_signed_with_checkpoint(
            &plan_admitted_event(),
            &signing_key,
            &signer,
            &CheckpointPolicy::every(1),
        )
        .map(|_| ());

    for (path, outcome) in [
        ("append", unsigned),
        ("append_signed", signed),
        ("append_signed_with_checkpoint", checkpointed),
    ] {
        assert!(
            matches!(
                outcome,
                Err(LedgerError::CallerSuppliedTrustSpineEvent { ref kind })
                    if kind == "plan_admitted"
            ),
            "{path} must refuse a caller-supplied plan admission, got {outcome:?}"
        );
    }
    assert_eq!(store.event_count().unwrap(), 0);
}
