//! Regression coverage for the protected, idempotent ModelActionIntent V1
//! issuer. The test intentionally exercises the SQLite projection directly;
//! the store itself owns protected-CAS parsing and evidence derivation, so no
//! caller can substitute a model request or evidence descriptor.

use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::activity_claim::ActivityResultOutcomeV1;
use bp_ledger::payload::model_evidence::{
    canonical_model_action_input_v1_bytes, model_request_semantic_v1_digest,
    CanonicalModelActionInputV1, CredentialFreeNormalizedModelRequestV1, ModelProviderV1,
};
use bp_ledger::payload::trust_spine::{
    action_receipt_set_v1_digest, action_requested_v2_digest, dispatch_envelope_v3_body_digest,
    dispatch_envelope_v4_digest, governed_dispatch_policy_digest_v1, ActionEvidenceVersionV1,
    ActionFailureV1, ActionKindV1, ActionReceiptOutcomeV2, ActionReceiptRecordedV2,
    ActionReceiptSetEntryV1, ActionReceiptSetRecordedV1, ActionRequestedV2, ActionResourceUsageV1,
    CommitModeV1, DispatchBudgetV1, DispatchEnvelopeBodyV2, DispatchEnvelopeV3, DispatchEnvelopeV4,
    ExecutionRoleV1, TrustTierV1,
};
use bp_ledger::payload::Payload;
use bp_ledger::signing::{public_key_hash, ActorKeyRef, TrustedPublicKeys};
use bp_ledger::storage::sqlite::{
    ActivityClaimAuthorityV1, ActivityClaimRequestV1, ActivityResultDispositionV1,
    GovernedModelActionAuthorizeAndClaimDispositionV1,
    GovernedModelActionAuthorizeAndClaimRequestV1, GovernedModelActionResultRequestV1,
    ModelActionIntentIssueDispositionV1, ModelActionIntentIssueRequestV1, SqliteStore,
};
use bp_ledger::storage::Cas;
use bp_ledger::LedgerError;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use ed25519_dalek::SigningKey;
use tempfile::TempDir;

const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST_C: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const DIGEST_D: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const DIGEST_E: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

fn timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn signer(key: &SigningKey) -> ActorKeyRef {
    ActorKeyRef {
        actor_id: "kernel".into(),
        key_id: "kernel-main".into(),
        public_key_hash: Some(public_key_hash(&key.verifying_key())),
    }
}

fn authority(key: &SigningKey, realm_digest: &str) -> ActivityClaimAuthorityV1 {
    let signer = signer(key);
    let mut keys = TrustedPublicKeys::default();
    keys.insert_public_key(
        signer
            .public_key_hash
            .clone()
            .expect("test signer has a public key hash"),
        key.verifying_key().to_bytes().to_vec(),
    );
    ActivityClaimAuthorityV1::new_governed_realm(
        keys,
        signer.clone(),
        signer.clone(),
        signer,
        realm_digest.into(),
    )
    .expect("construct protected test authority")
}

fn dispatch(now: DateTime<Utc>, realm_digest: &str) -> DispatchEnvelopeV3 {
    let body = DispatchEnvelopeBodyV2 {
        workflow_id: "workflow-1".into(),
        workflow_revision: "r1".into(),
        unit_id: "unit-1".into(),
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
            max_compute_time_ms: Some(10_000),
        },
        trust_tier: TrustTierV1::Governed,
        idempotency_key: "dispatch:workflow-1:unit-1:1".into(),
        // Keep the fixture inside the signed compute window. The native
        // issuer revalidates this same bounded authority immediately before
        // it records a model intent.
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
    .expect("hash dispatch");
    DispatchEnvelopeV3 {
        body,
        action_evidence_version,
        repository_binding_digest: DIGEST_A.into(),
        ledger_authority_realm_digest: realm_digest.into(),
        governed_packet_digest: Some(DIGEST_C.into()),
        envelope_digest,
    }
}

fn action_request(
    run_id: RunId,
    dispatch: &DispatchEnvelopeV3,
    now: DateTime<Utc>,
    canonical_input_ref: &str,
    canonical_input_digest: &str,
) -> ActionRequestedV2 {
    ActionRequestedV2 {
        run_id: run_id.to_string(),
        workflow_id: dispatch.body.workflow_id.clone(),
        unit_id: dispatch.body.unit_id.clone(),
        attempt: dispatch.body.attempt,
        provenance_ref: dispatch.body.provenance_ref.clone(),
        action_id: "model-action-1".into(),
        idempotency_key: "action:model-action-1".into(),
        action_kind: ActionKindV1::Model,
        canonical_input_digest: canonical_input_digest.into(),
        canonical_input_ref: canonical_input_ref.into(),
        dispatch_envelope_digest: dispatch.envelope_digest.clone(),
        repository_binding_digest: dispatch.repository_binding_digest.clone(),
        ledger_authority_realm_digest: dispatch.ledger_authority_realm_digest.clone(),
        governed_packet_digest: dispatch.governed_packet_digest.clone(),
        capability_bundle_digest: dispatch.body.capability_bundle_digest.clone(),
        policy_digest: governed_dispatch_policy_digest_v1(
            &dispatch.body.acceptance_contract_digest,
        )
        .expect("derive policy binding"),
        context_manifest_digest: dispatch.body.context_manifest_digest.clone(),
        worker_manifest_digest: dispatch.body.worker_manifest_digest.clone(),
        sandbox_profile_digest: dispatch.body.sandbox_profile_digest.clone(),
        authority_actor: "kernel".into(),
        execution_role: dispatch.body.execution_role,
        requested_at: timestamp(now),
    }
}

fn action_request_with_identity(
    run_id: RunId,
    dispatch: &DispatchEnvelopeV3,
    now: DateTime<Utc>,
    canonical_input_ref: &str,
    canonical_input_digest: &str,
    action_id: &str,
) -> ActionRequestedV2 {
    let mut request = action_request(
        run_id,
        dispatch,
        now,
        canonical_input_ref,
        canonical_input_digest,
    );
    request.action_id = action_id.into();
    request.idempotency_key = format!("action:{action_id}");
    request
}

fn terminal_model_receipt(
    request: &ActionRequestedV2,
    outcome: ActionReceiptOutcomeV2,
) -> ActionReceiptRecordedV2 {
    assert_ne!(outcome, ActionReceiptOutcomeV2::Succeeded);
    ActionReceiptRecordedV2 {
        run_id: request.run_id.clone(),
        workflow_id: request.workflow_id.clone(),
        unit_id: request.unit_id.clone(),
        attempt: request.attempt,
        provenance_ref: request.provenance_ref.clone(),
        action_id: request.action_id.clone(),
        idempotency_key: request.idempotency_key.clone(),
        action_request_digest: action_requested_v2_digest(request).expect("hash action request"),
        dispatch_envelope_digest: request.dispatch_envelope_digest.clone(),
        capability_bundle_digest: request.capability_bundle_digest.clone(),
        policy_digest: request.policy_digest.clone(),
        context_manifest_digest: request.context_manifest_digest.clone(),
        worker_manifest_digest: request.worker_manifest_digest.clone(),
        sandbox_profile_digest: request.sandbox_profile_digest.clone(),
        authority_actor: request.authority_actor.clone(),
        execution_role: request.execution_role,
        outcome,
        result_digest: None,
        result_ref: None,
        evidence_digest: DIGEST_A.into(),
        evidence_ref: format!("cas:evidence:{}", request.action_id),
        resource_usage: ActionResourceUsageV1 {
            wall_time_ms: 1,
            cpu_time_ms: Some(1),
            peak_memory_bytes: Some(1),
            input_bytes: Some(1),
            output_bytes: Some(1),
            input_tokens: None,
            output_tokens: None,
        },
        redactions: Vec::new(),
        failure: Some(ActionFailureV1 {
            code: "effect_terminal".into(),
            message_digest: DIGEST_B.into(),
            retryable: false,
        }),
        authorization_ref: None,
        action_receipt_ref: format!("receipt:{}", request.action_id),
        completed_at: "2026-07-17T00:00:02.000Z".into(),
    }
}

fn sealed_model_receipt_set(request: &ActionRequestedV2) -> ActionReceiptSetRecordedV1 {
    let mut set = ActionReceiptSetRecordedV1 {
        run_id: request.run_id.clone(),
        workflow_id: request.workflow_id.clone(),
        unit_id: request.unit_id.clone(),
        attempt: request.attempt,
        provenance_ref: request.provenance_ref.clone(),
        dispatch_envelope_digest: request.dispatch_envelope_digest.clone(),
        action_receipt_set_ref: format!("set:{}", request.action_id),
        action_receipt_set_digest: String::new(),
        receipts: vec![ActionReceiptSetEntryV1 {
            action_id: request.action_id.clone(),
            action_receipt_ref: format!("receipt:{}", request.action_id),
            action_receipt_digest: DIGEST_C.into(),
        }],
        sealed_at: "2026-07-17T00:00:02.000Z".into(),
    };
    set.action_receipt_set_digest =
        action_receipt_set_v1_digest(&set).expect("hash action receipt set");
    set
}

fn canonical_model_input() -> CanonicalModelActionInputV1 {
    let normalized_provider_request = CredentialFreeNormalizedModelRequestV1 {
        provider: ModelProviderV1::Openai,
        model: "gpt-5.6".into(),
        system_prompt: Some("You are a bounded implementation worker.".into()),
        prompt: "Change only the candidate overlay and return a closed result.".into(),
        response_schema_digest: DIGEST_E.into(),
    };
    let tool_capabilities = Vec::new();
    let redaction_commitments = Vec::new();
    let model_request_digest = model_request_semantic_v1_digest(
        &normalized_provider_request,
        &tool_capabilities,
        &redaction_commitments,
    )
    .expect("hash canonical model input");
    CanonicalModelActionInputV1 {
        schema_version: 1,
        normalized_provider_request,
        tool_capabilities,
        redaction_commitments,
        model_request_digest,
    }
}

fn issue_request(
    run_id: RunId,
    dispatch_event_id: EventId,
    action_request_event_id: EventId,
) -> ModelActionIntentIssueRequestV1 {
    ModelActionIntentIssueRequestV1 {
        run_id,
        dispatch_event_id,
        action_request_event_id,
    }
}

fn graph_bound_dispatch_v4(dispatch_v3: DispatchEnvelopeV3) -> DispatchEnvelopeV4 {
    let mut dispatch_v4 = DispatchEnvelopeV4 {
        dispatch_v3,
        workflow_graph_digest: DIGEST_D.into(),
        workflow_graph_declaration_event_ref: EventId::new(),
        envelope_digest: String::new(),
    };
    dispatch_v4.envelope_digest = dispatch_envelope_v4_digest(
        &dispatch_v4.dispatch_v3,
        &dispatch_v4.workflow_graph_digest,
        &dispatch_v4.workflow_graph_declaration_event_ref,
    )
    .expect("hash graph-bound dispatch");
    dispatch_v4
}

#[test]
fn model_intent_issuer_v4_binds_the_outer_dispatch_digest_and_rejects_inner_or_wrong_digests() {
    let now = DateTime::parse_from_rfc3339("2026-07-17T00:10:00.000Z")
        .unwrap()
        .with_timezone(&Utc);
    let key = SigningKey::from_bytes(&[91; 32]);
    let signer = signer(&key);
    let authority = authority(&key, DIGEST_B);
    let canonical_input = canonical_model_input();
    let canonical_input_bytes =
        canonical_model_action_input_v1_bytes(&canonical_input).expect("encode canonical input");

    let store = SqliteStore::open_in_memory().expect("open store");
    let temp = TempDir::new().expect("create CAS root");
    let cas = Cas::open(temp.path()).expect("open protected CAS");
    let input_ref = cas
        .put_canonical_bytes(&canonical_input_bytes)
        .expect("store canonical model input");
    let run_id = RunId::new();
    let dispatch_v4 = graph_bound_dispatch_v4(dispatch(now, DIGEST_B));
    let dispatch_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::DispatchEnvelopeV4,
        occurred_at: now - Duration::seconds(1),
        payload: Payload::DispatchEnvelopeV4(dispatch_v4.clone()),
    };
    store
        .append_signed(&dispatch_event, &key, &signer)
        .expect("append graph-bound dispatch");
    let mut request = action_request(
        run_id,
        &dispatch_v4.dispatch_v3,
        now,
        &input_ref.to_cas_ref(),
        input_ref.digest(),
    );
    request.dispatch_envelope_digest = dispatch_v4.envelope_digest.clone();
    let request_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: Some(dispatch_event.id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::ActionRequestedV2,
        occurred_at: now,
        payload: Payload::ActionRequestedV2(request.clone()),
    };
    store
        .append_signed(&request_event, &key, &signer)
        .expect("append outer-bound model action request");

    let issue = issue_request(run_id, dispatch_event.id, request_event.id);
    let issued = store
        .issue_model_action_intent_v1_at_for_tests(&issue, &cas, &authority, &key, &signer, now)
        .expect("outer V4 digest must issue a model intent");
    assert!(matches!(
        issued,
        ModelActionIntentIssueDispositionV1::Issued { .. }
    ));
    let intent = store
        .events_for_run(&run_id.to_string())
        .expect("read issued intent")
        .into_iter()
        .find_map(
            |row| match row.to_event().expect("decode tape event").payload {
                Payload::ModelActionIntentV1(intent) => Some(intent),
                _ => None,
            },
        )
        .expect("model intent was recorded");
    assert_eq!(intent.dispatch_event_ref, dispatch_event.id);
    assert_eq!(intent.dispatch_envelope_digest, dispatch_v4.envelope_digest);

    for (label, supplied_digest) in [("nested V3", true), ("unrelated", false)] {
        let rejected_store = SqliteStore::open_in_memory().expect("open rejected store");
        let rejected_temp = TempDir::new().expect("create rejected CAS root");
        let rejected_cas = Cas::open(rejected_temp.path()).expect("open rejected CAS");
        let rejected_input_ref = rejected_cas
            .put_canonical_bytes(&canonical_input_bytes)
            .expect("store rejected canonical input");
        let rejected_run_id = RunId::new();
        let rejected_v4 = graph_bound_dispatch_v4(dispatch(now, DIGEST_B));
        let rejected_dispatch_event = Event {
            id: EventId::new(),
            run_id: rejected_run_id,
            parent_event_id: None,
            schema_version: Event::CURRENT_SCHEMA_VERSION,
            kind: EventKind::DispatchEnvelopeV4,
            occurred_at: now - Duration::seconds(1),
            payload: Payload::DispatchEnvelopeV4(rejected_v4.clone()),
        };
        rejected_store
            .append_signed(&rejected_dispatch_event, &key, &signer)
            .expect("append rejected graph-bound dispatch");
        let mut rejected_request = action_request(
            rejected_run_id,
            &rejected_v4.dispatch_v3,
            now,
            &rejected_input_ref.to_cas_ref(),
            rejected_input_ref.digest(),
        );
        rejected_request.dispatch_envelope_digest = if supplied_digest {
            rejected_v4.dispatch_v3.envelope_digest.clone()
        } else {
            DIGEST_E.into()
        };
        let rejected_request_event = Event {
            id: EventId::new(),
            run_id: rejected_run_id,
            parent_event_id: Some(rejected_dispatch_event.id),
            schema_version: Event::CURRENT_SCHEMA_VERSION,
            kind: EventKind::ActionRequestedV2,
            occurred_at: now,
            payload: Payload::ActionRequestedV2(rejected_request),
        };
        rejected_store
            .append_signed(&rejected_request_event, &key, &signer)
            .expect("append rejected model action request");

        let error = rejected_store
            .issue_model_action_intent_v1_at_for_tests(
                &issue_request(
                    rejected_run_id,
                    rejected_dispatch_event.id,
                    rejected_request_event.id,
                ),
                &rejected_cas,
                &authority,
                &key,
                &signer,
                now,
            )
            .expect_err("only the outer V4 digest may issue model authority");
        assert!(matches!(
            error,
            LedgerError::ModelActionIntentAuthorityRejected { .. }
        ));
        assert_eq!(
            rejected_store.event_count().expect("count rejected tape"),
            2,
            "{label} digest must not append a model intent"
        );
    }
}

#[test]
fn model_intent_issuer_is_tape_verified_idempotent_and_conflict_closed() {
    let store = SqliteStore::open_in_memory().expect("open store");
    let temp = TempDir::new().expect("create CAS root");
    let cas = Cas::open(temp.path()).expect("open protected test CAS");
    let key = SigningKey::from_bytes(&[7; 32]);
    let signer = signer(&key);
    let realm_digest = DIGEST_B;
    let authority = authority(&key, realm_digest);
    let now = DateTime::parse_from_rfc3339("2026-07-17T00:10:00.000Z")
        .unwrap()
        .with_timezone(&Utc);
    let run_id = RunId::new();
    let dispatch = dispatch(now, realm_digest);
    let dispatch_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::DispatchEnvelopeV3,
        occurred_at: now - Duration::seconds(1),
        payload: Payload::DispatchEnvelopeV3(dispatch.clone()),
    };
    store
        .append_signed(&dispatch_event, &key, &signer)
        .expect("append signed dispatch");
    let canonical_input = canonical_model_input();
    let canonical_input_bytes =
        canonical_model_action_input_v1_bytes(&canonical_input).expect("encode canonical input");
    let canonical_input_ref = cas
        .put_canonical_bytes(&canonical_input_bytes)
        .expect("store canonical model input");
    let request = action_request(
        run_id,
        &dispatch,
        now,
        &canonical_input_ref.to_cas_ref(),
        canonical_input_ref.digest(),
    );
    let request_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: Some(dispatch_event.id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::ActionRequestedV2,
        occurred_at: now,
        payload: Payload::ActionRequestedV2(request.clone()),
    };
    store
        .append_signed(&request_event, &key, &signer)
        .expect("append signed model action request");

    let issue = issue_request(run_id, dispatch_event.id, request_event.id);
    let issued = store
        .issue_model_action_intent_v1_at_for_tests(&issue, &cas, &authority, &key, &signer, now)
        .expect("issue signed model intent");
    let (intent_event_id, intent_digest, model_request_evidence, trust_scope_evidence) =
        match issued {
            ModelActionIntentIssueDispositionV1::Issued {
                intent_event_id,
                intent_digest,
                model_request_evidence,
                trust_scope_evidence,
            } => (
                intent_event_id,
                intent_digest,
                model_request_evidence,
                trust_scope_evidence,
            ),
            other => panic!("first issue must create an intent, got {other:?}"),
        };
    let existing = store
        .issue_model_action_intent_v1_at_for_tests(
            &issue,
            &cas,
            &authority,
            &key,
            &signer,
            now + Duration::hours(1),
        )
        .expect("idempotent reissue returns the original signed intent after dispatch expiry");
    assert_eq!(
        existing,
        ModelActionIntentIssueDispositionV1::Existing {
            intent_event_id,
            intent_digest,
            model_request_evidence: model_request_evidence.clone(),
            trust_scope_evidence: trust_scope_evidence.clone(),
        }
    );
    assert_eq!(store.event_count().unwrap(), 3, "only one intent is signed");

    let conflicting = ModelActionIntentIssueRequestV1 {
        dispatch_event_id: EventId::new(),
        ..issue
    };
    let error = store
        .issue_model_action_intent_v1_at_for_tests(
            &conflicting,
            &cas,
            &authority,
            &key,
            &signer,
            now,
        )
        .expect_err("different dispatch cannot replace the immutable intent");
    assert!(
        matches!(
            error,
            LedgerError::ModelActionIntentIdempotencyConflict { .. }
        ),
        "unexpected error: {error}"
    );
    assert_eq!(
        store.event_count().unwrap(),
        3,
        "conflict cannot append an intent"
    );

    let events = store.events_for_run(&run_id.to_string()).unwrap();
    let intent_event = events
        .into_iter()
        .find_map(|row| match row.to_event().unwrap().payload {
            Payload::ModelActionIntentV1(intent) => Some(intent),
            _ => None,
        })
        .expect("one signed intent event");
    assert_eq!(
        intent_event.action_request_digest,
        action_requested_v2_digest(&request).unwrap()
    );
    assert_eq!(
        intent_event.canonical_input_ref,
        canonical_input_ref.to_cas_ref()
    );
    assert_eq!(intent_event.model_request_evidence, model_request_evidence);
    assert_eq!(intent_event.trust_scope_evidence, trust_scope_evidence);
    assert_eq!(intent_event.intent_actor, "kernel");
    assert!(intent_event.candidate_binding.is_none());
}

#[test]
fn a_model_intent_alone_never_grants_the_generic_activity_claim_lane() {
    let store = SqliteStore::open_in_memory().expect("open store");
    let temp = TempDir::new().expect("create CAS root");
    let cas = Cas::open(temp.path()).expect("open protected test CAS");
    let key = SigningKey::from_bytes(&[37; 32]);
    let signer = signer(&key);
    let realm_digest = DIGEST_B;
    let authority = authority(&key, realm_digest);
    let now = DateTime::parse_from_rfc3339("2026-07-17T00:10:00.000Z")
        .unwrap()
        .with_timezone(&Utc);
    let run_id = RunId::new();
    let dispatch = dispatch(now, realm_digest);
    let dispatch_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::DispatchEnvelopeV3,
        occurred_at: now - Duration::seconds(1),
        payload: Payload::DispatchEnvelopeV3(dispatch.clone()),
    };
    store
        .append_signed(&dispatch_event, &key, &signer)
        .expect("append signed dispatch");
    let canonical_input = canonical_model_input();
    let canonical_input_bytes =
        canonical_model_action_input_v1_bytes(&canonical_input).expect("encode canonical input");
    let canonical_input_ref = cas
        .put_canonical_bytes(&canonical_input_bytes)
        .expect("store canonical model input");
    let request = action_request(
        run_id,
        &dispatch,
        now,
        &canonical_input_ref.to_cas_ref(),
        canonical_input_ref.digest(),
    );
    let request_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: Some(dispatch_event.id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::ActionRequestedV2,
        occurred_at: now,
        payload: Payload::ActionRequestedV2(request.clone()),
    };
    store
        .append_signed(&request_event, &key, &signer)
        .expect("append signed model action request");
    store
        .issue_model_action_intent_v1_at_for_tests(
            &issue_request(run_id, dispatch_event.id, request_event.id),
            &cas,
            &authority,
            &key,
            &signer,
            now,
        )
        .expect("issue write-ahead model intent");

    let error = store
        .claim_activity_v1_at_for_tests(
            &ActivityClaimRequestV1 {
                run_id,
                activity_id: request.action_id,
                idempotency_key: request.idempotency_key,
                dispatch_event_id: dispatch_event.id,
                action_request_event_id: request_event.id,
                lease_duration_ms: 1_000,
            },
            &authority,
            &key,
            &signer,
            now + Duration::milliseconds(1),
        )
        .expect_err("a write-ahead intent is not provider-effect authority");

    assert!(
        matches!(error, LedgerError::ActivityClaimAuthorityRejected { .. }),
        "unexpected error: {error}"
    );
    assert!(
        error.to_string().contains("native model authority transaction"),
        "the generic lane must explain that model effects need their dedicated authority path: {error}"
    );
    assert_eq!(
        store.event_count().unwrap(),
        3,
        "rejected model claims must not append an activity lease"
    );
}

#[test]
fn native_model_authority_commits_the_v2_authorization_and_one_lease_together() {
    let store = SqliteStore::open_in_memory().expect("open store");
    let temp = TempDir::new().expect("create CAS root");
    let cas = Cas::open(temp.path()).expect("open protected test CAS");
    let key = SigningKey::from_bytes(&[57; 32]);
    let signer = signer(&key);
    let realm_digest = DIGEST_B;
    let authority = authority(&key, realm_digest);
    let now = DateTime::parse_from_rfc3339("2026-07-17T00:10:00.000Z")
        .unwrap()
        .with_timezone(&Utc);
    let run_id = RunId::new();
    let dispatch = dispatch(now, realm_digest);
    let dispatch_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::DispatchEnvelopeV3,
        occurred_at: now - Duration::seconds(1),
        payload: Payload::DispatchEnvelopeV3(dispatch.clone()),
    };
    store
        .append_signed(&dispatch_event, &key, &signer)
        .expect("append signed dispatch");
    let canonical_input = canonical_model_input();
    let canonical_input_bytes =
        canonical_model_action_input_v1_bytes(&canonical_input).expect("encode canonical input");
    let canonical_input_ref = cas
        .put_canonical_bytes(&canonical_input_bytes)
        .expect("store canonical model input");
    let request = action_request(
        run_id,
        &dispatch,
        now,
        &canonical_input_ref.to_cas_ref(),
        canonical_input_ref.digest(),
    );
    let request_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: Some(dispatch_event.id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::ActionRequestedV2,
        occurred_at: now,
        payload: Payload::ActionRequestedV2(request.clone()),
    };
    store
        .append_signed(&request_event, &key, &signer)
        .expect("append signed model action request");

    let authority_request = GovernedModelActionAuthorizeAndClaimRequestV1 {
        run_id,
        dispatch_event_id: dispatch_event.id,
        action_request_event_id: request_event.id,
        lease_duration_ms: 1_000,
    };
    let granted = store
        .authorize_and_claim_governed_model_action_v1_at_for_tests(
            &authority_request,
            &cas,
            &authority,
            &key,
            &signer,
            now,
        )
        .expect("issue the native V2 model authority and lease");
    let (authorization_ref, claim_event_id, lease_id) = match granted {
        GovernedModelActionAuthorizeAndClaimDispositionV1::Granted {
            authorization_ref,
            claim_event_id,
            lease_id,
            ..
        } => (authorization_ref, claim_event_id, lease_id),
        other => panic!("first model authority call must grant a lease, got {other:?}"),
    };
    assert_eq!(
        store.event_count().unwrap(),
        5,
        "intent, V2 authorization, and lease must commit with no separately usable authority state"
    );

    let retry = store
        .authorize_and_claim_governed_model_action_v1_at_for_tests(
            &authority_request,
            &cas,
            &authority,
            &key,
            &signer,
            now + Duration::milliseconds(1),
        )
        .expect("retry resolves the original authority without a second lease");
    assert!(matches!(
        retry,
        GovernedModelActionAuthorizeAndClaimDispositionV1::Pending {
            authorization_ref: ref retry_ref,
            claim_event_id: retry_claim_event_id,
            ..
        } if retry_ref == &authorization_ref && retry_claim_event_id == claim_event_id
    ));
    assert_eq!(
        store.event_count().unwrap(),
        5,
        "retry cannot append a second authority"
    );

    let conflicting_lease = store
        .authorize_and_claim_governed_model_action_v1_at_for_tests(
            &GovernedModelActionAuthorizeAndClaimRequestV1 {
                lease_duration_ms: 2_000,
                ..authority_request.clone()
            },
            &cas,
            &authority,
            &key,
            &signer,
            now + Duration::milliseconds(1),
        )
        .expect_err("a retry cannot stretch the immutable provider lease");
    assert!(matches!(
        conflicting_lease,
        LedgerError::ModelActionAuthorizationIdempotencyConflict { .. }
    ));
    assert_eq!(
        store.event_count().unwrap(),
        5,
        "conflict cannot append authority"
    );

    let terminal = store
        .record_governed_model_action_result_v1_at_for_tests(
            &GovernedModelActionResultRequestV1 {
                run_id,
                lease_id: lease_id.clone(),
                outcome: ActivityResultOutcomeV1::Succeeded,
                result_digest: Some(DIGEST_C.into()),
                result_ref: Some("cas:model-result:1".into()),
                evidence_digest: DIGEST_D.into(),
                evidence_ref: "cas:model-evidence:1".into(),
            },
            &cas,
            &authority,
            &key,
            &signer,
            now + Duration::milliseconds(2),
        )
        .expect("record the model result through its native lease lane");
    assert!(matches!(
        terminal,
        ActivityResultDispositionV1::Recorded { .. }
    ));
    assert_eq!(
        store.event_count().unwrap(),
        6,
        "terminal result is exactly once"
    );

    let after_result = store
        .authorize_and_claim_governed_model_action_v1_at_for_tests(
            &authority_request,
            &cas,
            &authority,
            &key,
            &signer,
            now + Duration::milliseconds(3),
        )
        .expect("post-result retry reuses recorded authority state");
    assert!(matches!(
        after_result,
        GovernedModelActionAuthorizeAndClaimDispositionV1::Recorded {
            authorization_ref: ref retry_ref,
            claim_event_id: retry_claim_event_id,
            outcome: ActivityResultOutcomeV1::Succeeded,
            ..
        } if retry_ref == &authorization_ref && retry_claim_event_id == claim_event_id
    ));
    assert_eq!(
        store.event_count().unwrap(),
        6,
        "recorded retry cannot append another event"
    );

    let events = store.events_for_run(&run_id.to_string()).unwrap();
    assert!(events.iter().any(|row| matches!(
        row.to_event().unwrap().payload,
        Payload::ModelActionAuthorizedV2(_)
    )));
    assert!(events.iter().any(|row| matches!(
        row.to_event().unwrap().payload,
        Payload::ActivityClaimedV1(ref claim)
            if claim.purpose == bp_ledger::payload::activity_claim::ActivityClaimPurposeV1::GovernedModelActionV1
    )));
}

#[test]
fn model_intent_issuer_permits_exactly_one_model_effect_per_sealed_dispatch_attempt() {
    let store = SqliteStore::open_in_memory().expect("open store");
    let temp = TempDir::new().expect("create CAS root");
    let cas = Cas::open(temp.path()).expect("open protected test CAS");
    let key = SigningKey::from_bytes(&[71; 32]);
    let signer = signer(&key);
    let realm_digest = DIGEST_B;
    let authority = authority(&key, realm_digest);
    let now = DateTime::parse_from_rfc3339("2026-07-17T00:10:00.000Z")
        .unwrap()
        .with_timezone(&Utc);
    let run_id = RunId::new();
    let dispatch = dispatch(now, realm_digest);
    let dispatch_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::DispatchEnvelopeV3,
        occurred_at: now - Duration::seconds(1),
        payload: Payload::DispatchEnvelopeV3(dispatch.clone()),
    };
    store
        .append_signed(&dispatch_event, &key, &signer)
        .expect("append signed dispatch");
    let canonical_input = canonical_model_input();
    let canonical_input_bytes =
        canonical_model_action_input_v1_bytes(&canonical_input).expect("encode canonical input");
    let canonical_input_ref = cas
        .put_canonical_bytes(&canonical_input_bytes)
        .expect("store canonical model input");

    let first_request = action_request(
        run_id,
        &dispatch,
        now,
        &canonical_input_ref.to_cas_ref(),
        canonical_input_ref.digest(),
    );
    let first_request_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: Some(dispatch_event.id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::ActionRequestedV2,
        occurred_at: now,
        payload: Payload::ActionRequestedV2(first_request),
    };
    store
        .append_signed(&first_request_event, &key, &signer)
        .expect("append first model action request");
    store
        .issue_model_action_intent_v1_at_for_tests(
            &issue_request(run_id, dispatch_event.id, first_request_event.id),
            &cas,
            &authority,
            &key,
            &signer,
            now,
        )
        .expect("first model action may issue its intent");

    let second_request = action_request_with_identity(
        run_id,
        &dispatch,
        now,
        &canonical_input_ref.to_cas_ref(),
        canonical_input_ref.digest(),
        "model-action-2",
    );
    let second_request_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: Some(dispatch_event.id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::ActionRequestedV2,
        occurred_at: now + Duration::milliseconds(1),
        payload: Payload::ActionRequestedV2(second_request),
    };
    store
        .append_signed(&second_request_event, &key, &signer)
        .expect("append second model action request for negative authority test");

    let error = store
        .issue_model_action_intent_v1_at_for_tests(
            &issue_request(run_id, dispatch_event.id, second_request_event.id),
            &cas,
            &authority,
            &key,
            &signer,
            now + Duration::milliseconds(2),
        )
        .expect_err("a second model request cannot receive the same dispatch token allowance");
    assert!(
        error
            .to_string()
            .contains("exactly one model provider effect"),
        "unexpected error: {error}"
    );
    assert_eq!(
        store.event_count().unwrap(),
        4,
        "the second request may be recorded but must never mint a second provider authority"
    );
}

#[test]
fn model_intent_issuer_rechecks_dispatch_expiry_immediately_before_signing() {
    let store = SqliteStore::open_in_memory().expect("open store");
    let temp = TempDir::new().expect("create CAS root");
    let cas = Cas::open(temp.path()).expect("open protected test CAS");
    let key = SigningKey::from_bytes(&[8; 32]);
    let signer = signer(&key);
    let realm_digest = DIGEST_B;
    let authority = authority(&key, realm_digest);
    let now = DateTime::parse_from_rfc3339("2026-07-17T00:10:00.000Z")
        .unwrap()
        .with_timezone(&Utc);
    let run_id = RunId::new();
    let mut dispatch = dispatch(now, realm_digest);
    dispatch.body.expires_at = timestamp(now + Duration::seconds(1));
    dispatch.envelope_digest = dispatch_envelope_v3_body_digest(
        &dispatch.body,
        dispatch.action_evidence_version,
        &dispatch.repository_binding_digest,
        &dispatch.ledger_authority_realm_digest,
        dispatch.governed_packet_digest.as_deref(),
    )
    .expect("rehash short-lived dispatch");
    let dispatch_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::DispatchEnvelopeV3,
        occurred_at: now - Duration::seconds(1),
        payload: Payload::DispatchEnvelopeV3(dispatch.clone()),
    };
    store
        .append_signed(&dispatch_event, &key, &signer)
        .expect("append signed dispatch");
    let canonical_input = canonical_model_input();
    let canonical_input_bytes =
        canonical_model_action_input_v1_bytes(&canonical_input).expect("encode canonical input");
    let canonical_input_ref = cas
        .put_canonical_bytes(&canonical_input_bytes)
        .expect("store canonical model input");
    let request = action_request(
        run_id,
        &dispatch,
        now,
        &canonical_input_ref.to_cas_ref(),
        canonical_input_ref.digest(),
    );
    let request_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: Some(dispatch_event.id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::ActionRequestedV2,
        occurred_at: now,
        payload: Payload::ActionRequestedV2(request),
    };
    store
        .append_signed(&request_event, &key, &signer)
        .expect("append signed model action request");

    let mut clock_samples = [now, now + Duration::seconds(2)].into_iter();
    let error = store
        .issue_model_action_intent_v1_with_clock_for_tests(
            &issue_request(run_id, dispatch_event.id, request_event.id),
            &cas,
            &authority,
            &key,
            &signer,
            || {
                clock_samples
                    .next()
                    .expect("issuer samples the clock twice")
            },
        )
        .expect_err("expiry crossed during CAS work must block a new signed intent");
    assert!(
        matches!(
            error,
            LedgerError::ModelActionIntentAuthorityRejected { .. }
        ),
        "unexpected error: {error}"
    );
    assert_eq!(
        store.event_count().unwrap(),
        2,
        "expired authority cannot append or backdate a model intent"
    );
}

#[test]
fn model_intent_issuer_refuses_a_missing_or_substituted_canonical_input_without_append() {
    let store = SqliteStore::open_in_memory().expect("open store");
    let temp = TempDir::new().expect("create CAS root");
    let cas = Cas::open(temp.path()).expect("open protected test CAS");
    let key = SigningKey::from_bytes(&[9; 32]);
    let signer = signer(&key);
    let realm_digest = DIGEST_B;
    let authority = authority(&key, realm_digest);
    let now = DateTime::parse_from_rfc3339("2026-07-17T00:10:00.000Z")
        .unwrap()
        .with_timezone(&Utc);
    let run_id = RunId::new();
    let dispatch = dispatch(now, realm_digest);
    let dispatch_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::DispatchEnvelopeV3,
        occurred_at: now - Duration::seconds(1),
        payload: Payload::DispatchEnvelopeV3(dispatch.clone()),
    };
    store
        .append_signed(&dispatch_event, &key, &signer)
        .expect("append signed dispatch");

    // The signed action uses syntactically valid raw-CAS fields, but no object
    // with that raw digest exists in the protected CAS. The issuer must not
    // accept a caller-supplied replacement request or append an intent.
    let request = action_request(run_id, &dispatch, now, &format!("cas:{DIGEST_D}"), DIGEST_D);
    let request_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: Some(dispatch_event.id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::ActionRequestedV2,
        occurred_at: now,
        payload: Payload::ActionRequestedV2(request),
    };
    store
        .append_signed(&request_event, &key, &signer)
        .expect("append signed model action request");

    let error = store
        .issue_model_action_intent_v1_at_for_tests(
            &issue_request(run_id, dispatch_event.id, request_event.id),
            &cas,
            &authority,
            &key,
            &signer,
            now,
        )
        .expect_err("missing protected canonical input must fail closed");
    assert!(
        matches!(
            error,
            LedgerError::ModelActionIntentAuthorityRejected { .. }
        ),
        "unexpected error: {error}"
    );
    assert_eq!(
        store.event_count().unwrap(),
        2,
        "evidence failure cannot append a model intent"
    );
}

#[test]
fn model_intent_issuer_refuses_review_roles_until_a_native_candidate_view_exists() {
    let store = SqliteStore::open_in_memory().expect("open store");
    let temp = TempDir::new().expect("create CAS root");
    let cas = Cas::open(temp.path()).expect("open protected test CAS");
    let key = SigningKey::from_bytes(&[11; 32]);
    let signer = signer(&key);
    let realm_digest = DIGEST_B;
    let authority = authority(&key, realm_digest);
    let now = DateTime::parse_from_rfc3339("2026-07-17T00:10:00.000Z")
        .unwrap()
        .with_timezone(&Utc);
    let run_id = RunId::new();
    let mut review_dispatch = dispatch(now, realm_digest);
    review_dispatch.body.execution_role = ExecutionRoleV1::Reviewer;
    review_dispatch.envelope_digest = dispatch_envelope_v3_body_digest(
        &review_dispatch.body,
        review_dispatch.action_evidence_version,
        &review_dispatch.repository_binding_digest,
        &review_dispatch.ledger_authority_realm_digest,
        review_dispatch.governed_packet_digest.as_deref(),
    )
    .expect("rehash reviewer dispatch");
    let dispatch_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::DispatchEnvelopeV3,
        occurred_at: now - Duration::seconds(1),
        payload: Payload::DispatchEnvelopeV3(review_dispatch.clone()),
    };
    store
        .append_signed(&dispatch_event, &key, &signer)
        .expect("append signed reviewer dispatch");

    let canonical_input = canonical_model_input();
    let canonical_input_bytes =
        canonical_model_action_input_v1_bytes(&canonical_input).expect("encode canonical input");
    let canonical_input_ref = cas
        .put_canonical_bytes(&canonical_input_bytes)
        .expect("store canonical model input");
    let request = action_request(
        run_id,
        &review_dispatch,
        now,
        &canonical_input_ref.to_cas_ref(),
        canonical_input_ref.digest(),
    );
    assert_eq!(request.execution_role, ExecutionRoleV1::Reviewer);
    let request_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: Some(dispatch_event.id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::ActionRequestedV2,
        occurred_at: now,
        payload: Payload::ActionRequestedV2(request),
    };
    store
        .append_signed(&request_event, &key, &signer)
        .expect("append signed reviewer model request");

    let error = store
        .issue_model_action_intent_v1_at_for_tests(
            &issue_request(run_id, dispatch_event.id, request_event.id),
            &cas,
            &authority,
            &key,
            &signer,
            now,
        )
        .expect_err("reviewer model actions need a native candidate-view issuer");
    assert!(
        matches!(
            error,
            LedgerError::ModelActionIntentAuthorityRejected { .. }
        ),
        "unexpected error: {error}"
    );
    assert_eq!(
        store.event_count().unwrap(),
        2,
        "rejected reviewer actions cannot append a model intent"
    );
}

#[test]
fn model_intent_issuer_never_appends_after_failed_or_unknown_terminal_receipts() {
    for outcome in [
        ActionReceiptOutcomeV2::Failed,
        ActionReceiptOutcomeV2::Unknown,
    ] {
        let store = SqliteStore::open_in_memory().expect("open store");
        let temp = TempDir::new().expect("create CAS root");
        let cas = Cas::open(temp.path()).expect("open protected test CAS");
        let key = SigningKey::from_bytes(&[13; 32]);
        let signer = signer(&key);
        let realm_digest = DIGEST_B;
        let authority = authority(&key, realm_digest);
        let now = DateTime::parse_from_rfc3339("2026-07-17T00:10:00.000Z")
            .unwrap()
            .with_timezone(&Utc);
        let run_id = RunId::new();
        let dispatch = dispatch(now, realm_digest);
        let dispatch_event = Event {
            id: EventId::new(),
            run_id,
            parent_event_id: None,
            schema_version: Event::CURRENT_SCHEMA_VERSION,
            kind: EventKind::DispatchEnvelopeV3,
            occurred_at: now - Duration::seconds(1),
            payload: Payload::DispatchEnvelopeV3(dispatch.clone()),
        };
        store
            .append_signed(&dispatch_event, &key, &signer)
            .expect("append signed dispatch");
        let canonical_input = canonical_model_input();
        let canonical_input_bytes = canonical_model_action_input_v1_bytes(&canonical_input)
            .expect("encode canonical input");
        let canonical_input_ref = cas
            .put_canonical_bytes(&canonical_input_bytes)
            .expect("store canonical model input");
        let request = action_request(
            run_id,
            &dispatch,
            now,
            &canonical_input_ref.to_cas_ref(),
            canonical_input_ref.digest(),
        );
        let request_event = Event {
            id: EventId::new(),
            run_id,
            parent_event_id: Some(dispatch_event.id),
            schema_version: Event::CURRENT_SCHEMA_VERSION,
            kind: EventKind::ActionRequestedV2,
            occurred_at: now,
            payload: Payload::ActionRequestedV2(request.clone()),
        };
        store
            .append_signed(&request_event, &key, &signer)
            .expect("append signed model action request");
        let receipt_event = Event {
            id: EventId::new(),
            run_id,
            parent_event_id: Some(request_event.id),
            schema_version: Event::CURRENT_SCHEMA_VERSION,
            kind: EventKind::ActionReceiptRecordedV2,
            occurred_at: now + Duration::seconds(1),
            payload: Payload::ActionReceiptRecordedV2(terminal_model_receipt(&request, outcome)),
        };
        store
            .append_signed(&receipt_event, &key, &signer)
            .expect("append terminal receipt");

        let error = store
            .issue_model_action_intent_v1_at_for_tests(
                &issue_request(run_id, dispatch_event.id, request_event.id),
                &cas,
                &authority,
                &key,
                &signer,
                now + Duration::seconds(2),
            )
            .expect_err(
                "a terminal receipt closes the action lifecycle before model intent issuance",
            );
        assert!(
            matches!(
                error,
                LedgerError::ModelActionIntentAuthorityRejected { .. }
            ),
            "unexpected error for {outcome:?}: {error}"
        );
        assert_eq!(
            store.event_count().unwrap(),
            3,
            "{outcome:?} receipt cannot be followed by an intent"
        );
    }
}

#[test]
fn model_intent_issuer_never_appends_after_a_sealed_receipt_set() {
    let store = SqliteStore::open_in_memory().expect("open store");
    let temp = TempDir::new().expect("create CAS root");
    let cas = Cas::open(temp.path()).expect("open protected test CAS");
    let key = SigningKey::from_bytes(&[15; 32]);
    let signer = signer(&key);
    let realm_digest = DIGEST_B;
    let authority = authority(&key, realm_digest);
    let now = DateTime::parse_from_rfc3339("2026-07-17T00:10:00.000Z")
        .unwrap()
        .with_timezone(&Utc);
    let run_id = RunId::new();
    let dispatch = dispatch(now, realm_digest);
    let dispatch_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::DispatchEnvelopeV3,
        occurred_at: now - Duration::seconds(1),
        payload: Payload::DispatchEnvelopeV3(dispatch.clone()),
    };
    store
        .append_signed(&dispatch_event, &key, &signer)
        .expect("append signed dispatch");
    let canonical_input = canonical_model_input();
    let canonical_input_bytes =
        canonical_model_action_input_v1_bytes(&canonical_input).expect("encode canonical input");
    let canonical_input_ref = cas
        .put_canonical_bytes(&canonical_input_bytes)
        .expect("store canonical model input");
    let request = action_request(
        run_id,
        &dispatch,
        now,
        &canonical_input_ref.to_cas_ref(),
        canonical_input_ref.digest(),
    );
    let request_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: Some(dispatch_event.id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::ActionRequestedV2,
        occurred_at: now,
        payload: Payload::ActionRequestedV2(request.clone()),
    };
    store
        .append_signed(&request_event, &key, &signer)
        .expect("append signed model action request");
    let receipt_set_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: Some(request_event.id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::ActionReceiptSetRecordedV1,
        occurred_at: now + Duration::seconds(1),
        payload: Payload::ActionReceiptSetRecordedV1(sealed_model_receipt_set(&request)),
    };
    store
        .append_signed(&receipt_set_event, &key, &signer)
        .expect("append sealed receipt set");

    let error = store
        .issue_model_action_intent_v1_at_for_tests(
            &issue_request(run_id, dispatch_event.id, request_event.id),
            &cas,
            &authority,
            &key,
            &signer,
            now + Duration::seconds(2),
        )
        .expect_err("a sealed receipt set closes the workflow action lifecycle");
    assert!(
        matches!(
            error,
            LedgerError::ModelActionIntentAuthorityRejected { .. }
        ),
        "unexpected error: {error}"
    );
    assert_eq!(
        store.event_count().unwrap(),
        3,
        "sealed receipt sets cannot be followed by a model intent"
    );
}
