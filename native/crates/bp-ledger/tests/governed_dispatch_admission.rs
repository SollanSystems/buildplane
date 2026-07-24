//! Durable governed-dispatch admission coverage.
//!
//! Admission is intentionally a two-phase native control: the signed V3
//! dispatch becomes durable with an immutable projection first, then a distinct
//! checkpoint seal makes that projection recovery-verifiable. A raw V3 event
//! or generic signed append is not admission success.

use bp_ledger::event::Event;
use bp_ledger::id::RunId;
use bp_ledger::kind::EventKind;
use bp_ledger::payload::trust_spine::{
    dispatch_envelope_v3_body_digest, ActionEvidenceVersionV1, CommitModeV1, DispatchBudgetV1,
    DispatchEnvelopeBodyV2, DispatchEnvelopeV3, ExecutionRoleV1, TrustTierV1,
};
use bp_ledger::signing::{public_key_hash, ActorKeyRef, TrustedPublicKeys};
use bp_ledger::storage::sqlite::{
    GovernedDispatchAdmissionAuthorityV1, GovernedDispatchAdmissionDispositionV1,
    GovernedDispatchAdmissionRequestV1, GovernedDispatchAdmissionSealRequestV1, SqliteStore,
};
use bp_ledger::LedgerError;
use bp_ledger::Payload;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use ed25519_dalek::SigningKey;

const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST_C: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const DIGEST_D: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const DIGEST_E: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

fn timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn actor(actor_id: &str, key_id: &str, key: &SigningKey) -> ActorKeyRef {
    ActorKeyRef {
        actor_id: actor_id.into(),
        key_id: key_id.into(),
        public_key_hash: Some(public_key_hash(&key.verifying_key())),
    }
}

fn trusted_keys(keys: &[&SigningKey]) -> TrustedPublicKeys {
    let mut trusted = TrustedPublicKeys::default();
    for key in keys {
        trusted.insert_public_key(
            public_key_hash(&key.verifying_key()),
            key.verifying_key().to_bytes().to_vec(),
        );
    }
    trusted
}

fn governed_implementer_dispatch(now: DateTime<Utc>, realm_digest: &str) -> DispatchEnvelopeV3 {
    let body = DispatchEnvelopeBodyV2 {
        workflow_id: "workflow-1".into(),
        workflow_revision: "r1".into(),
        unit_id: "implement-unit-1".into(),
        attempt: 1,
        execution_role: ExecutionRoleV1::Implementer,
        commit_mode: CommitModeV1::Atomic,
        provenance_ref: "admission:1".into(),
        base_commit_sha: "1".repeat(40),
        capability_bundle_digest: DIGEST_A.into(),
        acceptance_contract_digest: DIGEST_B.into(),
        context_manifest_digest: DIGEST_C.into(),
        worker_manifest_digest: DIGEST_D.into(),
        sandbox_profile_digest: DIGEST_E.into(),
        budget: DispatchBudgetV1 {
            max_tokens: Some(1024),
            max_compute_time_ms: Some(60_000),
        },
        trust_tier: TrustTierV1::Governed,
        idempotency_key: "dispatch:workflow-1:implement-unit-1:1".into(),
        issued_at: timestamp(now - Duration::seconds(1)),
        expires_at: timestamp(now + Duration::minutes(10)),
    };
    let action_evidence_version = ActionEvidenceVersionV1::SealedV3;
    let envelope_digest = dispatch_envelope_v3_body_digest(
        &body,
        action_evidence_version,
        DIGEST_A,
        realm_digest,
        Some(DIGEST_C),
    )
    .expect("hash governed implementer dispatch");
    DispatchEnvelopeV3 {
        body,
        action_evidence_version,
        repository_binding_digest: DIGEST_A.into(),
        ledger_authority_realm_digest: realm_digest.into(),
        governed_packet_digest: Some(DIGEST_C.into()),
        envelope_digest,
    }
}

fn rehash_dispatch(dispatch: &mut DispatchEnvelopeV3) {
    dispatch.envelope_digest = dispatch_envelope_v3_body_digest(
        &dispatch.body,
        dispatch.action_evidence_version,
        &dispatch.repository_binding_digest,
        &dispatch.ledger_authority_realm_digest,
        dispatch.governed_packet_digest.as_deref(),
    )
    .expect("rehash V3 dispatch");
}

fn admission_authority(
    dispatch_key: &SigningKey,
    checkpoint_key: &SigningKey,
    realm_digest: &str,
) -> (
    GovernedDispatchAdmissionAuthorityV1,
    ActorKeyRef,
    ActorKeyRef,
) {
    let dispatch_signer = actor("broker:dispatch", "dispatch-1", dispatch_key);
    let checkpoint_signer = actor("kernel:checkpoint", "checkpoint-1", checkpoint_key);
    let authority = GovernedDispatchAdmissionAuthorityV1::new_governed_realm(
        trusted_keys(&[dispatch_key, checkpoint_key]),
        dispatch_signer.clone(),
        checkpoint_signer.clone(),
        realm_digest.into(),
    )
    .expect("construct governed admission authority");
    (authority, dispatch_signer, checkpoint_signer)
}

#[test]
fn governed_dispatch_admission_records_and_exact_retry_resolves_original_awaiting_checkpoint() {
    let store = SqliteStore::open_in_memory().expect("open in-memory ledger");
    let dispatch_key = SigningKey::from_bytes(&[7_u8; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[9_u8; 32]);
    let (authority, dispatch_signer, _) =
        admission_authority(&dispatch_key, &checkpoint_key, DIGEST_B);
    let request = GovernedDispatchAdmissionRequestV1 {
        run_id: RunId::new(),
        dispatch: governed_implementer_dispatch(Utc::now(), DIGEST_B),
    };

    let first = store
        .record_governed_dispatch_admission_v1(
            &request,
            &authority,
            &dispatch_key,
            &dispatch_signer,
        )
        .expect("record governed admission");
    let (dispatch_event_id, dispatch_event_digest, semantic_identity_digest, idempotency_key) =
        match first {
            GovernedDispatchAdmissionDispositionV1::AwaitingCheckpoint {
                dispatch_event_id,
                dispatch_event_digest,
                semantic_identity_digest,
                idempotency_key,
            } => (
                dispatch_event_id,
                dispatch_event_digest,
                semantic_identity_digest,
                idempotency_key,
            ),
            other => panic!("new admission must await its dedicated checkpoint, got {other:?}"),
        };
    assert_eq!(store.event_count().unwrap(), 1);

    let retry = store
        .record_governed_dispatch_admission_v1(
            &request,
            &authority,
            &dispatch_key,
            &dispatch_signer,
        )
        .expect("resolve exact admission retry");
    assert_eq!(
        retry,
        GovernedDispatchAdmissionDispositionV1::AwaitingCheckpoint {
            dispatch_event_id,
            dispatch_event_digest,
            semantic_identity_digest,
            idempotency_key,
        }
    );
    assert_eq!(
        store.event_count().unwrap(),
        1,
        "retry must not append a second dispatch"
    );
}

#[test]
fn governed_dispatch_admission_rejects_mismatched_idempotency_or_attempt_reuse_without_append() {
    let store = SqliteStore::open_in_memory().expect("open in-memory ledger");
    let dispatch_key = SigningKey::from_bytes(&[11_u8; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[13_u8; 32]);
    let (authority, dispatch_signer, _) =
        admission_authority(&dispatch_key, &checkpoint_key, DIGEST_B);
    let request = GovernedDispatchAdmissionRequestV1 {
        run_id: RunId::new(),
        dispatch: governed_implementer_dispatch(Utc::now(), DIGEST_B),
    };
    store
        .record_governed_dispatch_admission_v1(
            &request,
            &authority,
            &dispatch_key,
            &dispatch_signer,
        )
        .expect("record original admission");

    let mut same_key_different_dispatch = request.clone();
    same_key_different_dispatch
        .dispatch
        .repository_binding_digest = DIGEST_D.into();
    rehash_dispatch(&mut same_key_different_dispatch.dispatch);
    let error = store
        .record_governed_dispatch_admission_v1(
            &same_key_different_dispatch,
            &authority,
            &dispatch_key,
            &dispatch_signer,
        )
        .expect_err("same idempotency key may not select different V3 authority bytes");
    assert!(matches!(
        error,
        LedgerError::GovernedDispatchAdmissionConflict { .. }
    ));

    let mut same_attempt_different_key = request.clone();
    same_attempt_different_key.dispatch.body.idempotency_key = "dispatch:other-key".into();
    rehash_dispatch(&mut same_attempt_different_key.dispatch);
    let error = store
        .record_governed_dispatch_admission_v1(
            &same_attempt_different_key,
            &authority,
            &dispatch_key,
            &dispatch_signer,
        )
        .expect_err("one workflow/unit/attempt may not have two admission projections");
    assert!(matches!(
        error,
        LedgerError::GovernedDispatchAdmissionConflict { .. }
    ));
    assert_eq!(
        store.event_count().unwrap(),
        1,
        "conflicts must not append another V3 dispatch"
    );
}

#[test]
fn governed_dispatch_admission_rejects_changed_revision_and_idempotency_for_same_attempt() {
    let store = SqliteStore::open_in_memory().expect("open in-memory ledger");
    let dispatch_key = SigningKey::from_bytes(&[15_u8; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[17_u8; 32]);
    let (authority, dispatch_signer, _) =
        admission_authority(&dispatch_key, &checkpoint_key, DIGEST_B);
    let request = GovernedDispatchAdmissionRequestV1 {
        run_id: RunId::new(),
        dispatch: governed_implementer_dispatch(Utc::now(), DIGEST_B),
    };
    store
        .record_governed_dispatch_admission_v1(
            &request,
            &authority,
            &dispatch_key,
            &dispatch_signer,
        )
        .expect("record original admission");

    let mut changed_revision_and_key = request.clone();
    changed_revision_and_key.dispatch.body.workflow_revision = "r2".into();
    changed_revision_and_key.dispatch.body.idempotency_key =
        "dispatch:workflow-1:implement-unit-1:r2".into();
    rehash_dispatch(&mut changed_revision_and_key.dispatch);
    let error = store
        .record_governed_dispatch_admission_v1(
            &changed_revision_and_key,
            &authority,
            &dispatch_key,
            &dispatch_signer,
        )
        .expect_err("one workflow/unit/attempt may not gain a changed-revision sibling");
    assert!(matches!(
        error,
        LedgerError::GovernedDispatchAdmissionConflict { .. }
    ));
    assert_eq!(
        store.event_count().unwrap(),
        1,
        "a changed revision and idempotency key must not append a second V3 dispatch"
    );
}

#[test]
fn governed_dispatch_admission_rejects_unsafe_v3_posture_without_write() {
    let store = SqliteStore::open_in_memory().expect("open in-memory ledger");
    let dispatch_key = SigningKey::from_bytes(&[17_u8; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[19_u8; 32]);
    let (authority, dispatch_signer, _) =
        admission_authority(&dispatch_key, &checkpoint_key, DIGEST_B);
    let mut unsafe_dispatch = governed_implementer_dispatch(Utc::now(), DIGEST_B);
    unsafe_dispatch.body.execution_role = ExecutionRoleV1::Candidate;
    rehash_dispatch(&mut unsafe_dispatch);
    let request = GovernedDispatchAdmissionRequestV1 {
        run_id: RunId::new(),
        dispatch: unsafe_dispatch,
    };

    let error = store
        .record_governed_dispatch_admission_v1(
            &request,
            &authority,
            &dispatch_key,
            &dispatch_signer,
        )
        .expect_err("candidate V3 dispatch must never be escalated to governed admission");
    assert!(matches!(
        error,
        LedgerError::GovernedDispatchAdmissionAuthorityRejected { .. }
    ));
    assert_eq!(
        store.event_count().unwrap(),
        0,
        "unsafe posture must not write a tape event"
    );
}

#[test]
fn governed_dispatch_admission_rejects_inactive_or_elapsed_authority_without_append() {
    let dispatch_key = SigningKey::from_bytes(&[41_u8; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[43_u8; 32]);
    let (authority, dispatch_signer, _) =
        admission_authority(&dispatch_key, &checkpoint_key, DIGEST_B);
    let now = Utc::now();

    let mut expired = governed_implementer_dispatch(now - Duration::minutes(20), DIGEST_B);
    expired.body.budget.max_compute_time_ms = None;
    rehash_dispatch(&mut expired);
    let inactive = governed_implementer_dispatch(now + Duration::minutes(5), DIGEST_B);
    let compute_deadline_elapsed =
        governed_implementer_dispatch(now - Duration::minutes(2), DIGEST_B);

    for (description, dispatch, expected_reason) in [
        ("expired", expired, "expired"),
        ("not yet active", inactive, "not yet active"),
        (
            "compute deadline elapsed",
            compute_deadline_elapsed,
            "compute deadline has elapsed",
        ),
    ] {
        let store = SqliteStore::open_in_memory().expect("open in-memory ledger");
        let request = GovernedDispatchAdmissionRequestV1 {
            run_id: RunId::new(),
            dispatch,
        };

        let error = store
            .record_governed_dispatch_admission_v1(
                &request,
                &authority,
                &dispatch_key,
                &dispatch_signer,
            )
            .expect_err("{description} V3 authority must not be admitted");
        assert!(matches!(
            error,
            LedgerError::GovernedDispatchAdmissionAuthorityRejected { reason }
                if reason.contains(expected_reason)
        ));
        assert_eq!(
            store.event_count().unwrap(),
            0,
            "{description} authority must not append a tape event"
        );
    }
}

#[test]
fn governed_dispatch_admission_blocks_changed_revision_raw_v3_without_native_projection() {
    let store = SqliteStore::open_in_memory().expect("open in-memory ledger");
    let dispatch_key = SigningKey::from_bytes(&[23_u8; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[29_u8; 32]);
    let (authority, dispatch_signer, _) =
        admission_authority(&dispatch_key, &checkpoint_key, DIGEST_B);
    let request = GovernedDispatchAdmissionRequestV1 {
        run_id: RunId::new(),
        dispatch: governed_implementer_dispatch(Utc::now(), DIGEST_B),
    };
    let mut raw_dispatch = request.dispatch.clone();
    raw_dispatch.body.workflow_revision = "r2".into();
    raw_dispatch.body.idempotency_key = "dispatch:workflow-1:implement-unit-1:r2".into();
    rehash_dispatch(&mut raw_dispatch);
    let raw_event = Event {
        id: bp_ledger::EventId::new(),
        run_id: request.run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::DispatchEnvelopeV3,
        occurred_at: Utc::now(),
        payload: Payload::DispatchEnvelopeV3(raw_dispatch),
    };
    store
        .append_signed(&raw_event, &dispatch_key, &dispatch_signer)
        .expect("direct signed append leaves a raw V3 event for reconciliation coverage");

    let error = store
        .record_governed_dispatch_admission_v1(
            &request,
            &authority,
            &dispatch_key,
            &dispatch_signer,
        )
        .expect_err("raw V3 event cannot be silently adopted as an admission");
    assert!(matches!(
        error,
        LedgerError::GovernedDispatchAdmissionReconciliationRequired { .. }
    ));
    assert_eq!(
        store.event_count().unwrap(),
        1,
        "reconciliation must not append a sibling dispatch"
    );
}

#[test]
fn governed_dispatch_admission_withholds_success_until_its_exact_checkpoint_seals_and_retries() {
    let store = SqliteStore::open_in_memory().expect("open in-memory ledger");
    let dispatch_key = SigningKey::from_bytes(&[31_u8; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[37_u8; 32]);
    let (authority, dispatch_signer, checkpoint_signer) =
        admission_authority(&dispatch_key, &checkpoint_key, DIGEST_B);
    let request = GovernedDispatchAdmissionRequestV1 {
        run_id: RunId::new(),
        dispatch: governed_implementer_dispatch(Utc::now(), DIGEST_B),
    };
    let awaiting = store
        .record_governed_dispatch_admission_v1(
            &request,
            &authority,
            &dispatch_key,
            &dispatch_signer,
        )
        .expect("record admission before sealing");
    let dispatch_event_id = match awaiting {
        GovernedDispatchAdmissionDispositionV1::AwaitingCheckpoint {
            dispatch_event_id, ..
        } => dispatch_event_id,
        other => panic!("unsealed admission must not report success, got {other:?}"),
    };
    let seal_request = GovernedDispatchAdmissionSealRequestV1 {
        run_id: request.run_id,
        dispatch_event_id,
    };

    store.fail_next_checkpoint_signature_insert_for_tests();
    let error = store
        .seal_governed_dispatch_admission_v1(
            &seal_request,
            &authority,
            &checkpoint_key,
            &checkpoint_signer,
        )
        .expect_err("failed checkpoint must withhold admission success");
    assert!(matches!(error, LedgerError::AppendOnlyViolation(_)));
    assert_eq!(
        store.event_count().unwrap(),
        1,
        "failed checkpoint insert must roll back"
    );
    assert!(matches!(
        store
            .record_governed_dispatch_admission_v1(
                &request,
                &authority,
                &dispatch_key,
                &dispatch_signer,
            )
            .expect("retry resolves the original unsealed record"),
        GovernedDispatchAdmissionDispositionV1::AwaitingCheckpoint { .. }
    ));

    let sealed = store
        .seal_governed_dispatch_admission_v1(
            &seal_request,
            &authority,
            &checkpoint_key,
            &checkpoint_signer,
        )
        .expect("retry seals the original admission rather than appending another dispatch");
    let checkpoint_event_id = match &sealed {
        GovernedDispatchAdmissionDispositionV1::Sealed {
            dispatch_event_id: sealed_dispatch_event_id,
            checkpoint_event_id,
            ..
        } => {
            assert_eq!(*sealed_dispatch_event_id, dispatch_event_id);
            *checkpoint_event_id
        }
        other => panic!("dedicated seal must report a sealed admission, got {other:?}"),
    };
    assert_ne!(checkpoint_event_id, dispatch_event_id);
    assert_eq!(
        store.event_count().unwrap(),
        2,
        "sealing emits only the checkpoint"
    );
    assert_eq!(
        store
            .record_governed_dispatch_admission_v1(
                &request,
                &authority,
                &dispatch_key,
                &dispatch_signer,
            )
            .expect("sealed retry resolves the original sealed admission"),
        sealed
    );
}
