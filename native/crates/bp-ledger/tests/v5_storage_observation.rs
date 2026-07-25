//! Non-authoritative V5 storage-observation coverage.
//!
//! A V5 observation records verified tape bindings for audit and later
//! protected-host review only. It must not make V5 dispatches claimable.

use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::trust_spine::{
    attempt_context_content_v1_digest, context_manifest_content_v1_digest,
    dispatch_envelope_v3_body_digest, dispatch_envelope_v4_digest, dispatch_envelope_v5_digest,
    sandbox_profile_content_v1_digest, worker_manifest_content_v1_digest, workflow_graph_v2_digest,
    ActionEvidenceVersionV1, AttemptContextContentV1, AttemptContextDeclaredV1, AttemptFeedbackV1,
    CommitModeV1, ContextManifestContentV1, ContextManifestDeclaredV1, ContextManifestEntryKindV1,
    ContextManifestEntryV1, ContextTaintV1, ContextTrustLevelV1, DispatchBudgetV1,
    DispatchEnvelopeBodyV2, DispatchEnvelopeV3, DispatchEnvelopeV4, DispatchEnvelopeV5,
    ExecutionRoleV1, PriorCandidateRefV1, SandboxProfileContentV1, SandboxProfileDeclaredV1,
    SandboxRuntimeV1, TrustTierV1, WorkerHarnessV1, WorkerManifestContentV1,
    WorkerManifestDeclaredV1, WorkerProviderV1, WorkflowGraphDeclaredV2, WorkflowGraphNodeV2,
};
use bp_ledger::signing::{public_key_hash, ActorKeyRef, TrustedPublicKeys};
use bp_ledger::storage::sqlite::{
    ActivityClaimAuthorityV1, ActivityClaimRequestV1, GovernedDispatchAdmissionAuthorityV1,
    GovernedDispatchV5ObservationDispositionV1, GovernedDispatchV5ObservationRequestV1,
    SqliteStore,
};
use bp_ledger::{LedgerError, Payload};
use chrono::{Duration, SecondsFormat, Utc};
use ed25519_dalek::SigningKey;
use rusqlite::params;

fn digest(hex: char) -> String {
    format!("sha256:{}", hex.to_string().repeat(64))
}

fn timestamp(value: chrono::DateTime<Utc>) -> String {
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

fn admission_authority(
    key: &SigningKey,
    signer: &ActorKeyRef,
) -> GovernedDispatchAdmissionAuthorityV1 {
    let checkpoint_key = SigningKey::from_bytes(&[91u8; 32]);
    let checkpoint_signer = actor("kernel:checkpoint", "checkpoint-1", &checkpoint_key);
    GovernedDispatchAdmissionAuthorityV1::new_governed_realm(
        trusted_keys(&[key, &checkpoint_key]),
        signer.clone(),
        checkpoint_signer,
        digest('9'),
    )
    .expect("construct admission authority")
}

fn activity_claim_authority(key: &SigningKey, signer: &ActorKeyRef) -> ActivityClaimAuthorityV1 {
    ActivityClaimAuthorityV1::new(
        trusted_keys(&[key]),
        signer.clone(),
        signer.clone(),
        signer.clone(),
    )
    .expect("construct activity-claim authority")
}

fn event(run_id: RunId, kind: EventKind, payload: Payload) -> Event {
    Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind,
        occurred_at: Utc::now(),
        payload,
    }
}

struct V5Fixture {
    run_id: RunId,
    graph_event: Event,
    context_event: Event,
    worker_event: Event,
    sandbox_event: Event,
    retry_event: Option<Event>,
    dispatch_event: Event,
    dispatch: DispatchEnvelopeV5,
}

fn v5_fixture(attempt: u32) -> V5Fixture {
    let run_id = RunId::new();
    let now = Utc::now();
    let context_manifest = ContextManifestContentV1 {
        entries: vec![ContextManifestEntryV1 {
            kind: ContextManifestEntryKindV1::RepositoryFile,
            reference: "repo:AGENTS.md".into(),
            digest: digest('a'),
            provenance_ref: "provenance:repository".into(),
            trust: ContextTrustLevelV1::Verified,
            taint: ContextTaintV1::Clean,
        }],
    };
    let worker_manifest = WorkerManifestContentV1 {
        provider: WorkerProviderV1::OpenAi,
        model: "gpt-5".into(),
        harness: WorkerHarnessV1::OpenAiApiSdk,
        image_digest: digest('b'),
        tool_manifest_digest: digest('c'),
        skill_manifest_digest: digest('d'),
        capability_bundle_digest: digest('e'),
        execution_role: ExecutionRoleV1::Implementer,
    };
    let sandbox_profile = SandboxProfileContentV1 {
        runtime: SandboxRuntimeV1::RootlessOci,
        rootless: true,
        image_digest: worker_manifest.image_digest.clone(),
        read_only_rootfs: true,
        writable_overlay_digest: digest('f'),
        mount_manifest_digest: digest('a'),
        environment_manifest_digest: digest('b'),
        network_policy_digest: digest('c'),
        resource_policy_digest: digest('d'),
        secret_handle_manifest_digest: digest('e'),
    };
    let context_declaration = ContextManifestDeclaredV1 {
        run_id: run_id.to_string(),
        workflow_id: "workflow-v5".into(),
        workflow_revision: "r1".into(),
        unit_id: "unit-v5".into(),
        attempt,
        provenance_ref: "admission:v5".into(),
        context_manifest_digest: context_manifest_content_v1_digest(&context_manifest)
            .expect("hash context manifest"),
        context_manifest,
        idempotency_key: format!("context-manifest:workflow-v5:unit-v5:{attempt}"),
        declared_at: timestamp(now),
    };
    let worker_declaration = WorkerManifestDeclaredV1 {
        run_id: run_id.to_string(),
        workflow_id: "workflow-v5".into(),
        workflow_revision: "r1".into(),
        unit_id: "unit-v5".into(),
        attempt,
        provenance_ref: "admission:v5".into(),
        worker_manifest_digest: worker_manifest_content_v1_digest(&worker_manifest)
            .expect("hash worker manifest"),
        worker_manifest,
        idempotency_key: format!("worker-manifest:workflow-v5:unit-v5:{attempt}"),
        declared_at: timestamp(now),
    };
    let sandbox_declaration = SandboxProfileDeclaredV1 {
        run_id: run_id.to_string(),
        workflow_id: "workflow-v5".into(),
        workflow_revision: "r1".into(),
        unit_id: "unit-v5".into(),
        attempt,
        provenance_ref: "admission:v5".into(),
        sandbox_profile_digest: sandbox_profile_content_v1_digest(&sandbox_profile)
            .expect("hash sandbox profile"),
        sandbox_profile,
        idempotency_key: format!("sandbox-profile:workflow-v5:unit-v5:{attempt}"),
        declared_at: timestamp(now),
    };

    let graph_packet_digest = digest('f');
    let mut graph = WorkflowGraphDeclaredV2 {
        run_id: run_id.to_string(),
        workflow_id: "workflow-v5".into(),
        workflow_revision: "r1".into(),
        nodes: vec![WorkflowGraphNodeV2 {
            unit_id: "unit-v5".into(),
            depends_on: vec![],
            execution_role: ExecutionRoleV1::Implementer,
            governed_packet_digest: graph_packet_digest.clone(),
        }],
        max_concurrent: 1,
        graph_digest: String::new(),
        idempotency_key: "graph-v2:workflow-v5:r1".into(),
        declared_at: timestamp(now),
    };
    graph.graph_digest = workflow_graph_v2_digest(&graph).expect("hash graph");
    let graph_event = event(
        run_id,
        EventKind::WorkflowGraphDeclaredV2,
        Payload::WorkflowGraphDeclaredV2(graph.clone()),
    );
    let context_event = event(
        run_id,
        EventKind::ContextManifestDeclaredV1,
        Payload::ContextManifestDeclaredV1(context_declaration.clone()),
    );
    let worker_event = event(
        run_id,
        EventKind::WorkerManifestDeclaredV1,
        Payload::WorkerManifestDeclaredV1(worker_declaration.clone()),
    );
    let sandbox_event = event(
        run_id,
        EventKind::SandboxProfileDeclaredV1,
        Payload::SandboxProfileDeclaredV1(sandbox_declaration.clone()),
    );
    let retry_declaration = (attempt > 1).then(|| {
        let attempt_context = AttemptContextContentV1 {
            attempt,
            retry_feedback: vec![AttemptFeedbackV1 {
                feedback_ref: "cas:retry-feedback:v5".into(),
                feedback_digest: digest('a'),
            }],
            prior_candidates: vec![PriorCandidateRefV1 {
                candidate_ref: "refs/buildplane/candidates/workflow-v5/unit-v5/1".into(),
                candidate_digest: digest('b'),
            }],
        };
        AttemptContextDeclaredV1 {
            run_id: run_id.to_string(),
            workflow_id: "workflow-v5".into(),
            workflow_revision: "r1".into(),
            unit_id: "unit-v5".into(),
            attempt,
            provenance_ref: "admission:v5".into(),
            attempt_context_digest: attempt_context_content_v1_digest(&attempt_context)
                .expect("hash attempt context"),
            attempt_context,
            idempotency_key: format!("attempt-context:workflow-v5:unit-v5:{attempt}"),
            declared_at: timestamp(now),
        }
    });
    let retry_event = retry_declaration.as_ref().map(|declaration| {
        event(
            run_id,
            EventKind::AttemptContextDeclaredV1,
            Payload::AttemptContextDeclaredV1(declaration.clone()),
        )
    });

    let body = DispatchEnvelopeBodyV2 {
        workflow_id: "workflow-v5".into(),
        workflow_revision: "r1".into(),
        unit_id: "unit-v5".into(),
        attempt,
        execution_role: ExecutionRoleV1::Implementer,
        commit_mode: CommitModeV1::Atomic,
        provenance_ref: "admission:v5".into(),
        base_commit_sha: "1".repeat(40),
        capability_bundle_digest: worker_declaration
            .worker_manifest
            .capability_bundle_digest
            .clone(),
        acceptance_contract_digest: digest('c'),
        context_manifest_digest: context_declaration.context_manifest_digest.clone(),
        worker_manifest_digest: worker_declaration.worker_manifest_digest.clone(),
        sandbox_profile_digest: sandbox_declaration.sandbox_profile_digest.clone(),
        budget: DispatchBudgetV1 {
            max_tokens: Some(1_024),
            max_compute_time_ms: Some(60_000),
        },
        trust_tier: TrustTierV1::Governed,
        idempotency_key: format!("dispatch:workflow-v5:unit-v5:{attempt}"),
        issued_at: timestamp(now - Duration::seconds(1)),
        expires_at: timestamp(now + Duration::minutes(10)),
    };
    let dispatch_v3 = DispatchEnvelopeV3 {
        envelope_digest: dispatch_envelope_v3_body_digest(
            &body,
            ActionEvidenceVersionV1::SealedV3,
            &digest('a'),
            &digest('9'),
            Some(&graph_packet_digest),
        )
        .expect("hash V3 dispatch"),
        body,
        action_evidence_version: ActionEvidenceVersionV1::SealedV3,
        repository_binding_digest: digest('a'),
        ledger_authority_realm_digest: digest('9'),
        governed_packet_digest: Some(graph_packet_digest),
    };
    let dispatch_v4 = DispatchEnvelopeV4 {
        envelope_digest: dispatch_envelope_v4_digest(
            &dispatch_v3,
            &graph.graph_digest,
            &graph_event.id,
        )
        .expect("hash V4 dispatch"),
        dispatch_v3,
        workflow_graph_digest: graph.graph_digest,
        workflow_graph_declaration_event_ref: graph_event.id,
    };
    let mut dispatch = DispatchEnvelopeV5 {
        dispatch_v4,
        context_manifest_declaration_event_ref: context_event.id,
        context_manifest_digest: context_declaration.context_manifest_digest,
        worker_manifest_declaration_event_ref: worker_event.id,
        worker_manifest_digest: worker_declaration.worker_manifest_digest,
        sandbox_profile_declaration_event_ref: sandbox_event.id,
        sandbox_profile_digest: sandbox_declaration.sandbox_profile_digest,
        attempt_context_declaration_event_ref: retry_event.as_ref().map(|event| event.id),
        attempt_context_digest: retry_declaration
            .map(|declaration| declaration.attempt_context_digest),
        envelope_digest: String::new(),
    };
    dispatch.envelope_digest = dispatch_envelope_v5_digest(&dispatch).expect("hash V5 dispatch");
    let dispatch_event = event(
        run_id,
        EventKind::DispatchEnvelopeV5,
        Payload::DispatchEnvelopeV5(dispatch.clone()),
    );

    V5Fixture {
        run_id,
        graph_event,
        context_event,
        worker_event,
        sandbox_event,
        retry_event,
        dispatch_event,
        dispatch,
    }
}

fn append_fixture(
    store: &SqliteStore,
    fixture: &V5Fixture,
    default_key: &SigningKey,
    default_signer: &ActorKeyRef,
    context_key: &SigningKey,
    context_signer: &ActorKeyRef,
) {
    store
        .append_signed(&fixture.graph_event, default_key, default_signer)
        .expect("append graph");
    store
        .append_signed(&fixture.context_event, context_key, context_signer)
        .expect("append context manifest");
    store
        .append_signed(&fixture.worker_event, default_key, default_signer)
        .expect("append worker manifest");
    store
        .append_signed(&fixture.sandbox_event, default_key, default_signer)
        .expect("append sandbox profile");
    if let Some(retry_event) = fixture.retry_event.as_ref() {
        store
            .append_signed(retry_event, default_key, default_signer)
            .expect("append retry context");
    }
    store
        .append_signed(&fixture.dispatch_event, default_key, default_signer)
        .expect("append V5 dispatch");
}

fn observation_count(store: &SqliteStore) -> i64 {
    store
        .conn_for_tests()
        .query_row(
            "SELECT COUNT(*) FROM governed_dispatch_v5_observations",
            [],
            |row| row.get(0),
        )
        .expect("count V5 observations")
}

#[test]
fn first_attempt_v5_observation_records_exact_signed_graph_and_manifest_witnesses_without_authority(
) {
    let store = SqliteStore::open_in_memory().expect("open store");
    let signing_key = SigningKey::from_bytes(&[17u8; 32]);
    let signer = actor("broker:dispatch", "dispatch-1", &signing_key);
    let fixture = v5_fixture(1);
    append_fixture(
        &store,
        &fixture,
        &signing_key,
        &signer,
        &signing_key,
        &signer,
    );

    let authority = admission_authority(&signing_key, &signer);
    let request = GovernedDispatchV5ObservationRequestV1 {
        run_id: fixture.run_id,
        dispatch_event_id: fixture.dispatch_event.id,
    };
    let observed = store
        .observe_governed_dispatch_v5_admission_v1(&request, &authority)
        .expect("observe verified V5 dispatch");
    assert!(matches!(
        observed,
        GovernedDispatchV5ObservationDispositionV1::Observed { .. }
    ));

    let graph_event_digest: String = store
        .conn_for_tests()
        .query_row(
            "SELECT canonical_event_hash FROM event_signatures WHERE event_id = ?1",
            params![fixture.graph_event.id.to_string()],
            |row| row.get(0),
        )
        .expect("read graph event digest");
    let row: (
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        Option<String>,
    ) = store
        .conn_for_tests()
        .query_row(
            "SELECT authority, v4_graph_declaration_event_id, v4_graph_declaration_event_digest, \
                    context_manifest_event_id, worker_manifest_event_id, sandbox_profile_event_id, \
                    v5_envelope_digest, retry_context_event_id \
             FROM governed_dispatch_v5_observations \
             WHERE run_id = ?1 AND dispatch_event_id = ?2",
            params![
                fixture.run_id.to_string(),
                fixture.dispatch_event.id.to_string()
            ],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            },
        )
        .expect("read V5 observation");
    assert_eq!(row.0, "non_authoritative_v5_observation");
    assert_eq!(row.1, fixture.graph_event.id.to_string());
    assert_eq!(row.2, graph_event_digest);
    assert_eq!(row.3, fixture.context_event.id.to_string());
    assert_eq!(row.4, fixture.worker_event.id.to_string());
    assert_eq!(row.5, fixture.sandbox_event.id.to_string());
    assert_eq!(row.6, fixture.dispatch.envelope_digest);
    assert_eq!(row.7, None);

    let existing = store
        .observe_governed_dispatch_v5_admission_v1(&request, &authority)
        .expect("resolve existing V5 observation");
    assert!(matches!(
        existing,
        GovernedDispatchV5ObservationDispositionV1::Existing { .. }
    ));
    assert_eq!(observation_count(&store), 1);
    assert_eq!(
        store.event_count().expect("count tape events"),
        5,
        "an observation writes no tape event or checkpoint"
    );
    let claim_rows: i64 = store
        .conn_for_tests()
        .query_row("SELECT COUNT(*) FROM activity_claims", [], |row| row.get(0))
        .expect("count activity claims");
    assert_eq!(claim_rows, 0);

    let claim = store.claim_activity_v1(
        &ActivityClaimRequestV1 {
            run_id: fixture.run_id,
            activity_id: "v5-must-not-claim".into(),
            idempotency_key: "v5-must-not-claim".into(),
            dispatch_event_id: fixture.dispatch_event.id,
            action_request_event_id: EventId::new(),
            lease_duration_ms: 1_000,
        },
        &activity_claim_authority(&signing_key, &signer),
        &signing_key,
        &signer,
    );
    assert!(matches!(
        claim,
        Err(LedgerError::ActivityClaimAuthorityRejected { .. })
    ));
    let claim_rows_after: i64 = store
        .conn_for_tests()
        .query_row("SELECT COUNT(*) FROM activity_claims", [], |row| row.get(0))
        .expect("recount activity claims after rejected V5 claim");
    assert_eq!(
        claim_rows_after, 0,
        "V5 observation must not grant an activity claim"
    );
}

#[test]
fn v5_observation_rejects_unsigned_or_wrongly_signed_manifest_witness_without_writing_shadow() {
    let store = SqliteStore::open_in_memory().expect("open store");
    let signing_key = SigningKey::from_bytes(&[23u8; 32]);
    let signer = actor("broker:dispatch", "dispatch-1", &signing_key);
    let wrong_key = SigningKey::from_bytes(&[24u8; 32]);
    let wrong_signer = actor("worker:untrusted", "worker-1", &wrong_key);
    let fixture = v5_fixture(1);
    append_fixture(
        &store,
        &fixture,
        &signing_key,
        &signer,
        &wrong_key,
        &wrong_signer,
    );

    let result = store.observe_governed_dispatch_v5_admission_v1(
        &GovernedDispatchV5ObservationRequestV1 {
            run_id: fixture.run_id,
            dispatch_event_id: fixture.dispatch_event.id,
        },
        &admission_authority(&signing_key, &signer),
    );
    assert!(matches!(
        result,
        Err(LedgerError::GovernedDispatchAdmissionAuthorityRejected { .. })
    ));
    assert_eq!(observation_count(&store), 0);
}

#[test]
fn v5_observation_rejects_retries_without_a_complete_outer_v5_retry_proof() {
    let store = SqliteStore::open_in_memory().expect("open store");
    let signing_key = SigningKey::from_bytes(&[29u8; 32]);
    let signer = actor("broker:dispatch", "dispatch-1", &signing_key);
    let fixture = v5_fixture(2);
    append_fixture(
        &store,
        &fixture,
        &signing_key,
        &signer,
        &signing_key,
        &signer,
    );

    let result = store.observe_governed_dispatch_v5_admission_v1(
        &GovernedDispatchV5ObservationRequestV1 {
            run_id: fixture.run_id,
            dispatch_event_id: fixture.dispatch_event.id,
        },
        &admission_authority(&signing_key, &signer),
    );
    assert!(matches!(
        result,
        Err(LedgerError::GovernedDispatchAdmissionAuthorityRejected { .. })
    ));
    assert_eq!(observation_count(&store), 0);
}
