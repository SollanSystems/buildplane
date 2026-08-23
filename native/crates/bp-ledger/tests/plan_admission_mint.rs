//! Durable `plan_admitted` mint coverage (mint-control S2, storage half).
//!
//! Unlike every other native admission control, a plan admission has no signed
//! predecessor on the tape (`kind.rs` carries no `plan_compiled` /
//! `plan_validated` / `plan_previewed`). Its evidence is therefore the exact
//! content-addressed bytes the control loaded, and these tests pin that the
//! control — not its caller — derives every field it can derive, refuses
//! everything it cannot verify, and produces recovery evidence only.

use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::run_lifecycle::RunStartedV1;
use bp_ledger::payload::Payload;
use bp_ledger::signing::{public_key_hash, ActorKeyRef, TrustedPublicKeys};
use bp_ledger::storage::sqlite::{
    PlanAdmissionAuthorityV1, PlanAdmissionDispositionV1, PlanAdmissionRequestV1,
    PlanAdmissionSealRequestV1, SqliteStore, PLAN_ADMISSION_AUTHORIZED_NEXT_STEP_V1,
};
use bp_ledger::LedgerError;
use chrono::Utc;
use ed25519_dalek::SigningKey;
use rusqlite::params;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use tempfile::TempDir;
use uuid::Uuid;

const KERNEL_SEED: [u8; 32] = [77u8; 32];
const OTHER_SEED: [u8; 32] = [78u8; 32];
const RUN_UUID: &str = "01919000-0000-7000-8000-0000000000c1";
const RUN_STARTED_EVENT_UUID: &str = "01919000-0000-7000-8000-0000000000c2";
const REQUEST_UUID: &str = "01919000-0000-7000-8000-0000000000d1";

fn kernel_key() -> SigningKey {
    SigningKey::from_bytes(&KERNEL_SEED)
}

fn other_key() -> SigningKey {
    SigningKey::from_bytes(&OTHER_SEED)
}

fn signer_for(actor_id: &str, key_id: &str, key: &SigningKey) -> ActorKeyRef {
    ActorKeyRef {
        actor_id: actor_id.into(),
        key_id: key_id.into(),
        public_key_hash: Some(public_key_hash(&key.verifying_key())),
    }
}

fn kernel_signer() -> ActorKeyRef {
    signer_for("kernel", "kernel-main", &kernel_key())
}

fn trusted_keys(keys: &[&SigningKey]) -> TrustedPublicKeys {
    let mut trusted = TrustedPublicKeys::default();
    for key in keys {
        let verifying = key.verifying_key();
        trusted.insert_public_key(public_key_hash(&verifying), verifying.to_bytes().to_vec());
    }
    trusted
}

fn realm_digest() -> String {
    format!("sha256:{}", "ab".repeat(32))
}

fn authority() -> PlanAdmissionAuthorityV1 {
    PlanAdmissionAuthorityV1::new_kernel_realm(
        trusted_keys(&[&kernel_key(), &other_key()]),
        kernel_signer(),
        realm_digest(),
    )
    .expect("the kernel plan-admission realm is well formed")
}

fn run_id() -> RunId {
    RunId::from_uuid(Uuid::parse_str(RUN_UUID).unwrap())
}

fn request_id() -> Uuid {
    Uuid::parse_str(REQUEST_UUID).unwrap()
}

fn sha256_digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn plan_bytes() -> Vec<u8> {
    b"## Title\nMint control S2\n\n## Goal\nProve the plan-admission mint.\n".to_vec()
}

fn content_ref(bytes: &[u8]) -> String {
    format!("cas://{}", sha256_digest(bytes))
}

fn trusted_base() -> String {
    "a".repeat(40)
}

fn request_with(bytes: Vec<u8>, ref_override: Option<String>) -> PlanAdmissionRequestV1 {
    let plan_content_ref = ref_override.unwrap_or_else(|| content_ref(&bytes));
    PlanAdmissionRequestV1 {
        run_id: run_id(),
        request_id: request_id(),
        plan_content_ref,
        plan_bytes: bytes,
        trusted_base: trusted_base(),
        decided_by: "operator:uid-1000".into(),
        asserted_plan_digest: format!("sha256:{}", "cd".repeat(32)),
        asserted_idempotency_key: "planforge:v0:buildplane:deadbeef:abcd1234".into(),
        asserted_validation_status: "PASS".into(),
    }
}

fn request() -> PlanAdmissionRequestV1 {
    request_with(plan_bytes(), None)
}

/// A signed predecessor so the sealed prefix is never a single-event degenerate
/// case: the checkpoint must cover the admission at a non-zero index.
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
            git_head: trusted_base(),
            workspace_path: "/ws".into(),
            config: BTreeMap::new(),
            parent_run_id: None,
            parent_event_id: None,
        }),
    };
    store
        .append_signed(&event, &kernel_key(), &kernel_signer())
        .expect("the seeded run_started must land");
}

fn fixture() -> (SqliteStore, TempDir) {
    let tmp = TempDir::new().unwrap();
    let store = SqliteStore::open(tmp.path().join("events.db")).unwrap();
    seed_run_started(&store);
    (store, tmp)
}

fn plan_admitted_count(store: &SqliteStore) -> i64 {
    store
        .events_for_run(&run_id().to_string())
        .unwrap()
        .into_iter()
        .filter(|row| row.kind == "plan_admitted")
        .count() as i64
}

fn checkpoint_count(store: &SqliteStore) -> i64 {
    store
        .events_for_run(&run_id().to_string())
        .unwrap()
        .into_iter()
        .filter(|row| row.kind == "tape_checkpoint")
        .count() as i64
}

fn projection_state(store: &SqliteStore) -> Option<String> {
    store
        .conn_for_tests()
        .query_row(
            "SELECT state FROM plan_admissions WHERE run_id = ?1 AND request_id = ?2",
            params![run_id().to_string(), request_id().to_string()],
            |row| row.get::<_, String>(0),
        )
        .ok()
}

fn awaiting(disposition: &PlanAdmissionDispositionV1) -> (EventId, String, String) {
    match disposition {
        PlanAdmissionDispositionV1::AwaitingCheckpoint {
            admission_event_id,
            admission_event_digest,
            admission_identity_digest,
            ..
        } => (
            *admission_event_id,
            admission_event_digest.clone(),
            admission_identity_digest.clone(),
        ),
        other => panic!("expected AwaitingCheckpoint, got {other:?}"),
    }
}

fn sealed(disposition: &PlanAdmissionDispositionV1) -> (EventId, String, EventId) {
    match disposition {
        PlanAdmissionDispositionV1::Sealed {
            admission_event_id,
            admission_event_digest,
            checkpoint_event_id,
            ..
        } => (
            *admission_event_id,
            admission_event_digest.clone(),
            *checkpoint_event_id,
        ),
        other => panic!("expected Sealed, got {other:?}"),
    }
}

#[test]
fn the_mint_records_and_seals_one_kernel_signed_plan_admitted() {
    let (store, _tmp) = fixture();
    let authority = authority();

    let recorded = store
        .record_plan_admission_v1(&request(), &authority, &kernel_key(), &kernel_signer())
        .expect("the mint must record a plan admission");
    let (admission_event_id, admission_event_digest, _identity) = awaiting(&recorded);
    assert_eq!(
        projection_state(&store).as_deref(),
        Some("awaiting_checkpoint")
    );

    let sealed_disposition = store
        .seal_plan_admission_v1(
            &PlanAdmissionSealRequestV1 {
                run_id: run_id(),
                admission_event_id,
            },
            &authority,
            &kernel_key(),
            &kernel_signer(),
        )
        .expect("the mint must seal its own admission");
    let (sealed_event_id, sealed_digest, checkpoint_event_id) = sealed(&sealed_disposition);

    assert_eq!(sealed_event_id, admission_event_id);
    assert_eq!(sealed_digest, admission_event_digest);
    assert_eq!(projection_state(&store).as_deref(), Some("sealed"));
    assert_eq!(plan_admitted_count(&store), 1);

    let (event, signature) = store
        .signed_events_for_run(&run_id().to_string())
        .unwrap()
        .into_iter()
        .find(|(event, _)| event.id == admission_event_id)
        .expect("the admission event is on the tape");
    let signature = signature.expect("the admission event is signed");
    assert_eq!(event.kind, EventKind::PlanAdmitted);
    assert_eq!(event.parent_event_id, None);
    assert_eq!(signature.signer.actor_id, "kernel");
    assert_eq!(signature.signer.key_id, "kernel-main");
    assert_eq!(signature.canonical_event_hash, admission_event_digest);

    let Payload::PlanAdmittedV1(payload) = event.payload else {
        panic!("the minted event must carry PlanAdmittedV1");
    };
    // Derived by the control, never accepted from the request.
    assert_eq!(payload.input_digest, sha256_digest(&plan_bytes()));
    assert!(payload.plan_id.starts_with("pf-plan-native-"));
    assert_eq!(payload.trusted_base, trusted_base());
    assert_eq!(payload.decided_by, "operator:uid-1000");
    assert!(!payload.decided_at.is_empty());
    assert_eq!(
        payload.authorized_next_step,
        PLAN_ADMISSION_AUTHORIZED_NEXT_STEP_V1
    );
    // Recorded, not trusted.
    assert_eq!(payload.plan_digest, request().asserted_plan_digest);
    assert_eq!(payload.idempotency_key, request().asserted_idempotency_key);

    // A checkpoint exists and is the one the seal named.
    let checkpoint = store
        .signed_events_for_run(&run_id().to_string())
        .unwrap()
        .into_iter()
        .find(|(event, _)| event.id == checkpoint_event_id)
        .expect("the sealing checkpoint is on the tape");
    assert_eq!(checkpoint.0.kind, EventKind::TapeCheckpoint);
}

/// The always-blocked entry and the mint coexist by construction: the block
/// lives in `validate_external_append`, which this control simply does not
/// call, while the narrow invariant that guard also carried (a strictly
/// monotonic ordinary id) is re-asserted directly. Nothing is bypassed
/// silently, and the mint is the only writer.
#[test]
fn the_public_append_paths_stay_closed_while_the_mint_is_open() {
    let (store, _tmp) = fixture();
    let authority = authority();
    let caller_supplied = Event {
        id: EventId::new(),
        run_id: run_id(),
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::PlanAdmitted,
        occurred_at: Utc::now(),
        payload: Payload::PlanAdmittedV1(bp_ledger::payload::plan_lifecycle::PlanAdmittedV1 {
            plan_id: "pf-plan-001".into(),
            plan_digest: format!("sha256:{}", "cd".repeat(32)),
            input_digest: sha256_digest(&plan_bytes()),
            trusted_base: trusted_base(),
            decided_by: "operator:forged".into(),
            decided_at: "2026-08-17T00:00:00Z".into(),
            idempotency_key: "planforge:v0:buildplane:deadbeef:abcd1234".into(),
            authorized_next_step: PLAN_ADMISSION_AUTHORIZED_NEXT_STEP_V1.into(),
        }),
    };

    let appended = store.append(&caller_supplied);
    assert!(
        matches!(
            appended,
            Err(LedgerError::CallerSuppliedTrustSpineEvent { .. })
        ),
        "a caller-supplied plan admission must stay refused, got {appended:?}"
    );

    store
        .record_plan_admission_v1(&request(), &authority, &kernel_key(), &kernel_signer())
        .expect("the dedicated control must still be able to mint");
    assert_eq!(plan_admitted_count(&store), 1);
}

#[test]
fn a_replayed_request_id_with_a_different_body_is_an_identity_conflict() {
    let (store, _tmp) = fixture();
    let authority = authority();

    store
        .record_plan_admission_v1(&request(), &authority, &kernel_key(), &kernel_signer())
        .expect("the first mint must record");

    let mut different = request_with(b"## Title\nA different plan\n".to_vec(), None);
    different.request_id = request_id();

    let outcome =
        store.record_plan_admission_v1(&different, &authority, &kernel_key(), &kernel_signer());

    assert!(
        matches!(
            outcome,
            Err(LedgerError::PlanAdmissionIdempotencyConflict { run_id: ref reported, .. })
                if reported == &run_id().to_string()
        ),
        "a replayed request id with a different body must conflict, got {outcome:?}"
    );
    assert_eq!(plan_admitted_count(&store), 1);
}

#[test]
fn a_non_monotonic_admission_event_id_is_refused_without_a_write() {
    let (store, _tmp) = fixture();
    let authority = authority();

    // An ordinary event whose id is above every future UUIDv7 the mint can mint.
    let ceiling = Event {
        id: EventId::from_uuid(Uuid::parse_str("ffffffff-ffff-7fff-8fff-ffffffffffff").unwrap()),
        run_id: run_id(),
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::RunStarted,
        occurred_at: Utc::now(),
        payload: Payload::RunStartedV1(RunStartedV1 {
            packet_hash: "sha256:bb".into(),
            git_head: trusted_base(),
            workspace_path: "/ws".into(),
            config: BTreeMap::new(),
            parent_run_id: None,
            parent_event_id: None,
        }),
    };
    store
        .append_signed(&ceiling, &kernel_key(), &kernel_signer())
        .unwrap();
    let before = store.event_count().unwrap();

    let outcome =
        store.record_plan_admission_v1(&request(), &authority, &kernel_key(), &kernel_signer());

    assert!(
        matches!(outcome, Err(LedgerError::NonMonotonicEventId { .. })),
        "the mint must re-assert the monotonic ordinary-id invariant, got {outcome:?}"
    );
    assert_eq!(store.event_count().unwrap(), before);
    assert_eq!(plan_admitted_count(&store), 0);
    assert_eq!(projection_state(&store), None);
}

#[test]
fn an_interrupted_seal_resolves_to_identical_sealed_evidence_on_retry() {
    let (store, _tmp) = fixture();
    let authority = authority();

    let recorded = store
        .record_plan_admission_v1(&request(), &authority, &kernel_key(), &kernel_signer())
        .expect("the mint must record");
    let (admission_event_id, admission_event_digest, identity) = awaiting(&recorded);

    // Inject a real failure in the window the two-phase split exists to name:
    // the admission event is durably committed, and checkpoint emission then
    // fails.
    store.fail_next_checkpoint_signature_insert_for_tests();
    let interrupted = store.seal_plan_admission_v1(
        &PlanAdmissionSealRequestV1 {
            run_id: run_id(),
            admission_event_id,
        },
        &authority,
        &kernel_key(),
        &kernel_signer(),
    );
    assert!(
        interrupted.is_err(),
        "a failed checkpoint emission must not report a seal, got {interrupted:?}"
    );
    assert_eq!(
        projection_state(&store).as_deref(),
        Some("awaiting_checkpoint")
    );
    assert_eq!(checkpoint_count(&store), 0);

    // A legitimate retry of the SAME request resolves the existing record; it
    // never re-inserts and never hard-errors.
    let retried = store
        .record_plan_admission_v1(&request(), &authority, &kernel_key(), &kernel_signer())
        .expect("a legitimate retry must resolve, not conflict");
    let (retried_event_id, retried_digest, retried_identity) = awaiting(&retried);
    assert_eq!(retried_event_id, admission_event_id);
    assert_eq!(retried_digest, admission_event_digest);
    assert_eq!(retried_identity, identity);
    assert_eq!(plan_admitted_count(&store), 1);

    let seal_request = PlanAdmissionSealRequestV1 {
        run_id: run_id(),
        admission_event_id,
    };
    let first_seal = store
        .seal_plan_admission_v1(&seal_request, &authority, &kernel_key(), &kernel_signer())
        .expect("the retry must reach a seal, never a stall");
    let (sealed_event_id, sealed_digest, checkpoint_event_id) = sealed(&first_seal);
    assert_eq!(sealed_event_id, admission_event_id);
    assert_eq!(sealed_digest, admission_event_digest);

    // A second seal is idempotent (AlreadySealed), and a post-seal record retry
    // resolves to the identical sealed evidence.
    let second_seal = store
        .seal_plan_admission_v1(&seal_request, &authority, &kernel_key(), &kernel_signer())
        .expect("sealing twice must be idempotent");
    assert_eq!(second_seal, first_seal);

    let post_seal_record = store
        .record_plan_admission_v1(&request(), &authority, &kernel_key(), &kernel_signer())
        .expect("a post-seal retry must resolve to the sealed disposition");
    assert_eq!(post_seal_record, first_seal);
    assert_eq!(sealed(&post_seal_record).2, checkpoint_event_id);

    assert_eq!(plan_admitted_count(&store), 1);
    assert_eq!(projection_state(&store).as_deref(), Some("sealed"));
}

#[test]
fn content_that_does_not_hash_to_its_reference_is_refused() {
    let (store, _tmp) = fixture();
    let authority = authority();
    let request = request_with(plan_bytes(), Some(content_ref(b"a different object")));

    let outcome =
        store.record_plan_admission_v1(&request, &authority, &kernel_key(), &kernel_signer());

    assert!(
        matches!(outcome, Err(LedgerError::PlanInputDigestMismatch { .. })),
        "the mint must digest the bytes it loaded and refuse a mis-staged object, got {outcome:?}"
    );
    assert_eq!(plan_admitted_count(&store), 0);
}

#[test]
fn empty_plan_content_is_refused() {
    let (store, _tmp) = fixture();
    let authority = authority();
    let request = request_with(Vec::new(), None);

    let outcome =
        store.record_plan_admission_v1(&request, &authority, &kernel_key(), &kernel_signer());

    assert!(
        matches!(outcome, Err(LedgerError::PlanInputRejected { .. })),
        "empty plan content is not admissible evidence, got {outcome:?}"
    );
    assert_eq!(plan_admitted_count(&store), 0);
}

/// The projection is append-and-advance-once: it cannot be deleted, cannot be
/// mutated in place, and cannot be walked backwards out of `sealed`.
#[test]
fn the_projection_is_append_and_advance_once() {
    let (store, _tmp) = fixture();
    let authority = authority();
    let recorded = store
        .record_plan_admission_v1(&request(), &authority, &kernel_key(), &kernel_signer())
        .unwrap();
    let (admission_event_id, ..) = awaiting(&recorded);
    let conn = store.conn_for_tests();

    assert!(
        conn.execute("DELETE FROM plan_admissions", params![])
            .is_err(),
        "plan admissions are tape-backed and must not be deletable"
    );
    assert!(
        conn.execute(
            "UPDATE plan_admissions SET decided_by = 'operator:forged'",
            params![],
        )
        .is_err(),
        "an immutable projection column must not be mutable"
    );

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
        .unwrap();

    assert!(
        conn.execute(
            "UPDATE plan_admissions SET state = 'awaiting_checkpoint'",
            params![],
        )
        .is_err(),
        "a sealed projection must not walk backwards"
    );
    assert_eq!(projection_state(&store).as_deref(), Some("sealed"));
}

#[test]
fn a_non_pass_validation_assertion_is_refused() {
    let (store, _tmp) = fixture();
    let authority = authority();
    let mut request = request();
    request.asserted_validation_status = "BLOCKED".into();

    let outcome =
        store.record_plan_admission_v1(&request, &authority, &kernel_key(), &kernel_signer());

    assert!(
        matches!(
            outcome,
            Err(LedgerError::PlanAdmissionAuthorityRejected { ref reason })
                if reason.contains("validation")
        ),
        "a non-PASS assertion must fail closed as input hygiene, got {outcome:?}"
    );
    assert_eq!(plan_admitted_count(&store), 0);
}

#[test]
fn a_trusted_base_that_is_not_a_commit_sha_is_refused() {
    let (store, _tmp) = fixture();
    let authority = authority();
    let mut request = request();
    request.trusted_base = "not-a-commit".into();

    let outcome =
        store.record_plan_admission_v1(&request, &authority, &kernel_key(), &kernel_signer());

    assert!(
        matches!(
            outcome,
            Err(LedgerError::PlanAdmissionAuthorityRejected { ref reason })
                if reason.contains("trusted base")
        ),
        "the recorded trusted base must be a canonical commit sha, got {outcome:?}"
    );
    assert_eq!(plan_admitted_count(&store), 0);
}

#[test]
fn the_mint_signer_must_be_the_configured_kernel_authority() {
    let (store, _tmp) = fixture();
    let authority = authority();

    let outcome = store.record_plan_admission_v1(
        &request(),
        &authority,
        &other_key(),
        &signer_for("kernel", "kernel-main", &other_key()),
    );

    assert!(
        matches!(
            outcome,
            Err(LedgerError::PlanAdmissionAuthorityRejected { .. })
        ),
        "only the configured kernel signer may mint, got {outcome:?}"
    );
    assert_eq!(plan_admitted_count(&store), 0);
}

#[test]
fn sealing_requires_the_configured_kernel_authority() {
    let (store, _tmp) = fixture();
    let authority = authority();
    let recorded = store
        .record_plan_admission_v1(&request(), &authority, &kernel_key(), &kernel_signer())
        .unwrap();
    let (admission_event_id, ..) = awaiting(&recorded);

    let outcome = store.seal_plan_admission_v1(
        &PlanAdmissionSealRequestV1 {
            run_id: run_id(),
            admission_event_id,
        },
        &authority,
        &other_key(),
        &signer_for("kernel", "kernel-main", &other_key()),
    );

    assert!(
        matches!(
            outcome,
            Err(LedgerError::PlanAdmissionAuthorityRejected { .. })
        ),
        "only the configured kernel signer may seal, got {outcome:?}"
    );
    assert_eq!(
        projection_state(&store).as_deref(),
        Some("awaiting_checkpoint")
    );
    assert_eq!(checkpoint_count(&store), 0);
}

#[test]
fn a_sealed_admission_reopens_from_a_fresh_durable_connection() {
    let tmp = TempDir::new().unwrap();
    let database_path = tmp.path().join("events.db");
    let store = SqliteStore::open(&database_path).unwrap();
    seed_run_started(&store);
    let authority = authority();

    let recorded = store
        .record_plan_admission_v1(&request(), &authority, &kernel_key(), &kernel_signer())
        .unwrap();
    let (admission_event_id, ..) = awaiting(&recorded);
    let sealed_disposition = store
        .seal_plan_admission_v1(
            &PlanAdmissionSealRequestV1 {
                run_id: run_id(),
                admission_event_id,
            },
            &authority,
            &kernel_key(),
            &kernel_signer(),
        )
        .unwrap();
    drop(store);

    let reopened = SqliteStore::open(&database_path).unwrap();
    let resolved = reopened
        .resolve_sealed_plan_admission_v1(run_id(), admission_event_id, &authority)
        .expect("a fresh connection must reopen the exact sealed evidence");

    assert_eq!(resolved, sealed_disposition);
}

#[test]
fn an_unsealed_admission_is_not_resolvable_as_sealed_evidence() {
    let (store, _tmp) = fixture();
    let authority = authority();

    let recorded = store
        .record_plan_admission_v1(&request(), &authority, &kernel_key(), &kernel_signer())
        .unwrap();
    let (admission_event_id, ..) = awaiting(&recorded);

    let outcome = store.resolve_sealed_plan_admission_v1(run_id(), admission_event_id, &authority);

    assert!(
        matches!(
            outcome,
            Err(LedgerError::PlanAdmissionReconciliationRequired { .. })
        ),
        "an awaiting-checkpoint admission carries no sealed evidence, got {outcome:?}"
    );
}
