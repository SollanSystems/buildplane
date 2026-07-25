//! Durable V5 governed-dispatch admission coverage.
//!
//! V5 source envelopes are already signed tape evidence.  A protected host
//! must turn that evidence into one separate admission record and one exact
//! checkpoint before any future V5 authority can exist.  These tests also
//! deliberately prove that the admission record itself does not make V5
//! actions claimable.

use bp_ledger::canonicalize::canonicalize;
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::trust_spine::{
    action_requested_v2_digest, attempt_context_content_v1_digest,
    context_manifest_content_v1_digest, dispatch_envelope_v3_body_digest,
    dispatch_envelope_v4_digest, dispatch_envelope_v5_digest, governed_dispatch_policy_digest_v1,
    sandbox_profile_content_v1_digest, worker_manifest_content_v1_digest, workflow_graph_v2_digest,
    ActionEvidenceVersionV1, ActionKindV1, ActionRequestedV2, AttemptContextContentV1,
    AttemptContextDeclaredV1, AttemptFeedbackV1, CommitModeV1, ContextManifestContentV1,
    ContextManifestDeclaredV1, ContextManifestEntryKindV1, ContextManifestEntryV1, ContextTaintV1,
    ContextTrustLevelV1, DispatchBudgetV1, DispatchEnvelopeBodyV2, DispatchEnvelopeV3,
    DispatchEnvelopeV4, DispatchEnvelopeV5, ExecutionRoleV1, PriorCandidateRefV1,
    SandboxProfileContentV1, SandboxProfileDeclaredV1, SandboxRuntimeV1, TrustTierV1,
    WorkerHarnessV1, WorkerManifestContentV1, WorkerManifestDeclaredV1, WorkerProviderV1,
    WorkflowGraphDeclaredV2, WorkflowGraphNodeV2,
};
use bp_ledger::signing::{public_key_hash, sign_event, ActorKeyRef, TrustedPublicKeys};
use bp_ledger::storage::sqlite::{
    ActivityClaimAuthorityV1, ActivityClaimRequestV1, CheckpointPolicy,
    GovernedDispatchV5AdmissionAuthorityV1, GovernedDispatchV5AdmissionDispositionV1,
    GovernedDispatchV5AdmissionRequestV1, GovernedDispatchV5AdmissionSealRequestV1, SqliteStore,
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

fn v5_admission_authority(
    source_key: &SigningKey,
    admission_key: &SigningKey,
    checkpoint_key: &SigningKey,
) -> (
    GovernedDispatchV5AdmissionAuthorityV1,
    ActorKeyRef,
    ActorKeyRef,
    ActorKeyRef,
) {
    let source_signer = actor("broker:v5-source", "source-1", source_key);
    let admission_signer = actor("kernel:v5-admission", "admission-1", admission_key);
    let checkpoint_signer = actor("kernel:v5-checkpoint", "checkpoint-1", checkpoint_key);
    let authority = GovernedDispatchV5AdmissionAuthorityV1::new_governed_realm(
        trusted_keys(&[source_key, admission_key, checkpoint_key]),
        source_signer.clone(),
        admission_signer.clone(),
        checkpoint_signer.clone(),
        digest('9'),
    )
    .expect("construct V5 admission authority");
    (
        authority,
        source_signer,
        admission_signer,
        checkpoint_signer,
    )
}

fn activity_claim_authority(key: &SigningKey, signer: &ActorKeyRef) -> ActivityClaimAuthorityV1 {
    ActivityClaimAuthorityV1::new(
        trusted_keys(&[key]),
        signer.clone(),
        signer.clone(),
        signer.clone(),
    )
    .expect("construct activity claim authority")
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

fn child_event(
    run_id: RunId,
    parent_event_id: EventId,
    kind: EventKind,
    payload: Payload,
) -> Event {
    Event {
        id: EventId::new(),
        run_id,
        parent_event_id: Some(parent_event_id),
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
    source_key: &SigningKey,
    source_signer: &ActorKeyRef,
    context_key: &SigningKey,
    context_signer: &ActorKeyRef,
) {
    store
        .append_signed(&fixture.graph_event, source_key, source_signer)
        .expect("append graph");
    store
        .append_signed(&fixture.context_event, context_key, context_signer)
        .expect("append context manifest");
    store
        .append_signed(&fixture.worker_event, source_key, source_signer)
        .expect("append worker manifest");
    store
        .append_signed(&fixture.sandbox_event, source_key, source_signer)
        .expect("append sandbox profile");
    if let Some(retry_event) = fixture.retry_event.as_ref() {
        store
            .append_signed(retry_event, source_key, source_signer)
            .expect("append retry context");
    }
    store
        .append_signed(&fixture.dispatch_event, source_key, source_signer)
        .expect("append V5 source dispatch");
}

fn v5_admission_count(store: &SqliteStore) -> i64 {
    store
        .conn_for_tests()
        .query_row(
            "SELECT COUNT(*) FROM governed_dispatch_v5_admissions",
            [],
            |row| row.get(0),
        )
        .expect("count V5 admissions")
}

fn v5_observation_count(store: &SqliteStore) -> i64 {
    store
        .conn_for_tests()
        .query_row(
            "SELECT COUNT(*) FROM governed_dispatch_v5_observations",
            [],
            |row| row.get(0),
        )
        .expect("count V5 observations")
}

fn checkpoint_count(store: &SqliteStore, run_id: RunId) -> i64 {
    store
        .conn_for_tests()
        .query_row(
            "SELECT COUNT(*) FROM events WHERE run_id = ?1 AND kind = 'tape_checkpoint'",
            params![run_id.to_string()],
            |row| row.get(0),
        )
        .expect("count V5 admission checkpoints")
}

fn action_request_for_v5_fixture(fixture: &V5Fixture, authority_actor: &str) -> ActionRequestedV2 {
    let dispatch_v3 = &fixture.dispatch.dispatch_v4.dispatch_v3;
    let body = &dispatch_v3.body;
    ActionRequestedV2 {
        run_id: fixture.run_id.to_string(),
        workflow_id: body.workflow_id.clone(),
        unit_id: body.unit_id.clone(),
        attempt: body.attempt,
        provenance_ref: body.provenance_ref.clone(),
        action_id: "v5-admission-must-not-claim".into(),
        idempotency_key: "v5-admission-must-not-claim".into(),
        action_kind: ActionKindV1::Process,
        canonical_input_digest: digest('f'),
        canonical_input_ref: "cas:input:v5-admission".into(),
        dispatch_envelope_digest: fixture.dispatch.envelope_digest.clone(),
        repository_binding_digest: dispatch_v3.repository_binding_digest.clone(),
        ledger_authority_realm_digest: dispatch_v3.ledger_authority_realm_digest.clone(),
        governed_packet_digest: dispatch_v3.governed_packet_digest.clone(),
        capability_bundle_digest: body.capability_bundle_digest.clone(),
        policy_digest: governed_dispatch_policy_digest_v1(&body.acceptance_contract_digest)
            .expect("derive canonical governed policy digest"),
        context_manifest_digest: body.context_manifest_digest.clone(),
        worker_manifest_digest: body.worker_manifest_digest.clone(),
        sandbox_profile_digest: body.sandbox_profile_digest.clone(),
        authority_actor: authority_actor.into(),
        execution_role: body.execution_role,
        requested_at: timestamp(Utc::now()),
    }
}

fn distinct_admission_receipt_sibling(
    store: &SqliteStore,
    fixture: &V5Fixture,
    admission_event_id: EventId,
) -> Event {
    let original = store
        .events_for_run(&fixture.run_id.to_string())
        .expect("read original V5 admission receipt")
        .into_iter()
        .find(|row| row.id == admission_event_id.to_string())
        .expect("find original V5 admission receipt")
        .to_event()
        .expect("decode original V5 admission receipt");
    let Payload::GovernedDispatchV5AdmissionRecordedV1(mut receipt) = original.payload else {
        panic!("admission projection must point to a V5 admission receipt");
    };
    let occurred_at = Utc::now();
    receipt.admitted_at = timestamp(occurred_at);
    Event {
        id: EventId::new(),
        run_id: fixture.run_id,
        parent_event_id: Some(fixture.dispatch_event.id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::GovernedDispatchV5AdmissionRecordedV1,
        occurred_at,
        payload: Payload::GovernedDispatchV5AdmissionRecordedV1(receipt),
    }
}

/// Test-only simulation of a historical/corrupted tape that already contains
/// a separately signed V5 receipt sibling. Public append paths must reject
/// this event (covered below), so this bypass is intentionally limited to the
/// SQLite test hook in order to exercise reconciliation of pre-existing data.
fn inject_signed_admission_receipt_sibling_for_reconciliation(
    store: &SqliteStore,
    event: Event,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
) {
    let event = canonicalize(event).expect("canonicalize synthetic receipt sibling");
    let signature = sign_event(&event, signing_key, signer, event.occurred_at)
        .expect("sign synthetic receipt sibling");
    let conn = store.conn_for_tests();
    conn.execute(
        r#"INSERT INTO events (id, run_id, parent_event_id, schema_version, kind, occurred_at, payload)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#,
        params![
            event.id.to_string(),
            event.run_id.to_string(),
            event.parent_event_id.map(|id| id.to_string()),
            event.schema_version,
            event.kind.as_wire(),
            event.occurred_at.to_rfc3339(),
            serde_json::to_string(&event.payload).expect("serialize synthetic receipt sibling"),
        ],
    )
    .expect("inject synthetic receipt sibling event");
    conn.execute(
        r#"INSERT INTO event_signatures (
                event_id, canonical_event_hash, actor_id, key_id, public_key_hash,
                algorithm, signature, signed_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, 'ed25519', ?6, ?7)"#,
        params![
            signature.event_id.to_string(),
            signature.canonical_event_hash,
            signature.signer.actor_id,
            signature.signer.key_id,
            signature.signer.public_key_hash,
            signature.signature,
            signature.signed_at.to_rfc3339(),
        ],
    )
    .expect("inject synthetic receipt sibling signature");
}

fn awaiting_admission_event_id(disposition: GovernedDispatchV5AdmissionDispositionV1) -> EventId {
    match disposition {
        GovernedDispatchV5AdmissionDispositionV1::AwaitingCheckpoint {
            admission_event_id, ..
        } => admission_event_id,
        other => panic!("unsealed V5 admission must await checkpoint, got {other:?}"),
    }
}

#[test]
fn first_attempt_v5_source_records_one_host_admission_then_exactly_one_checkpoint() {
    let store = SqliteStore::open_in_memory().expect("open store");
    let source_key = SigningKey::from_bytes(&[31u8; 32]);
    let admission_key = SigningKey::from_bytes(&[32u8; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[33u8; 32]);
    let (authority, source_signer, admission_signer, checkpoint_signer) =
        v5_admission_authority(&source_key, &admission_key, &checkpoint_key);
    let fixture = v5_fixture(1);
    append_fixture(
        &store,
        &fixture,
        &source_key,
        &source_signer,
        &source_key,
        &source_signer,
    );
    assert_eq!(store.event_count().expect("count raw source tape"), 5);
    assert_eq!(v5_admission_count(&store), 0);
    assert_eq!(v5_observation_count(&store), 0);

    let request = GovernedDispatchV5AdmissionRequestV1 {
        run_id: fixture.run_id,
        dispatch_event_id: fixture.dispatch_event.id,
    };
    let admission_event_id = awaiting_admission_event_id(
        store
            .record_governed_dispatch_v5_admission_v1(
                &request,
                &authority,
                &admission_key,
                &admission_signer,
            )
            .expect("record verified first-attempt V5 admission"),
    );
    assert_eq!(v5_admission_count(&store), 1);
    assert_eq!(
        v5_observation_count(&store),
        0,
        "admission must not need observation"
    );
    assert_eq!(
        store
            .event_count()
            .expect("count source plus admission tape"),
        6,
        "recording adds exactly one host-signed admission receipt"
    );
    let receipt_actor: String = store
        .conn_for_tests()
        .query_row(
            "SELECT actor_id FROM event_signatures WHERE event_id = ?1",
            params![admission_event_id.to_string()],
            |row| row.get(0),
        )
        .expect("read host admission receipt signature");
    assert_eq!(receipt_actor, admission_signer.actor_id);
    let (receipt_kind, receipt_parent): (String, Option<String>) = store
        .conn_for_tests()
        .query_row(
            "SELECT kind, parent_event_id FROM events WHERE id = ?1",
            params![admission_event_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read host admission receipt event");
    assert_eq!(receipt_kind, "governed_dispatch_v5_admission_recorded_v1");
    assert_eq!(
        receipt_parent,
        Some(fixture.dispatch_event.id.to_string()),
        "the protected receipt must bind exactly to the raw V5 source dispatch"
    );

    let replay_admission_event_id = awaiting_admission_event_id(
        store
            .record_governed_dispatch_v5_admission_v1(
                &request,
                &authority,
                &admission_key,
                &admission_signer,
            )
            .expect("replay same V5 admission"),
    );
    assert_eq!(replay_admission_event_id, admission_event_id);
    assert_eq!(v5_admission_count(&store), 1);
    assert_eq!(store.event_count().expect("count stable admission tape"), 6);

    let seal_request = GovernedDispatchV5AdmissionSealRequestV1 {
        run_id: fixture.run_id,
        admission_event_id,
    };
    let sealed = store
        .seal_governed_dispatch_v5_admission_v1(
            &seal_request,
            &authority,
            &checkpoint_key,
            &checkpoint_signer,
        )
        .expect("seal exact V5 admission prefix");
    assert!(matches!(
        sealed,
        GovernedDispatchV5AdmissionDispositionV1::Sealed {
            admission_event_id: sealed_admission_event_id,
            ..
        } if sealed_admission_event_id == admission_event_id
    ));
    assert_eq!(v5_admission_count(&store), 1);
    assert_eq!(checkpoint_count(&store, fixture.run_id), 1);
    assert_eq!(store.event_count().expect("count sealed V5 tape"), 7);

    let sealed_retry = store
        .seal_governed_dispatch_v5_admission_v1(
            &seal_request,
            &authority,
            &checkpoint_key,
            &checkpoint_signer,
        )
        .expect("replay exact V5 seal");
    assert!(matches!(
        sealed_retry,
        GovernedDispatchV5AdmissionDispositionV1::Sealed {
            admission_event_id: sealed_admission_event_id,
            ..
        } if sealed_admission_event_id == admission_event_id
    ));
    assert_eq!(v5_admission_count(&store), 1);
    assert_eq!(checkpoint_count(&store, fixture.run_id), 1);
    assert_eq!(store.event_count().expect("count stable sealed V5 tape"), 7);
}

#[test]
fn sealed_v5_admission_reopens_reconciliation_for_a_distinct_source_sibling() {
    let store = SqliteStore::open_in_memory().expect("open store");
    let source_key = SigningKey::from_bytes(&[35u8; 32]);
    let admission_key = SigningKey::from_bytes(&[36u8; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[37u8; 32]);
    let (authority, source_signer, admission_signer, checkpoint_signer) =
        v5_admission_authority(&source_key, &admission_key, &checkpoint_key);
    let fixture = v5_fixture(1);
    append_fixture(
        &store,
        &fixture,
        &source_key,
        &source_signer,
        &source_key,
        &source_signer,
    );
    let request = GovernedDispatchV5AdmissionRequestV1 {
        run_id: fixture.run_id,
        dispatch_event_id: fixture.dispatch_event.id,
    };
    let admission_event_id = awaiting_admission_event_id(
        store
            .record_governed_dispatch_v5_admission_v1(
                &request,
                &authority,
                &admission_key,
                &admission_signer,
            )
            .expect("record original V5 admission"),
    );
    let seal_request = GovernedDispatchV5AdmissionSealRequestV1 {
        run_id: fixture.run_id,
        admission_event_id,
    };
    assert!(matches!(
        store
            .seal_governed_dispatch_v5_admission_v1(
                &seal_request,
                &authority,
                &checkpoint_key,
                &checkpoint_signer,
            )
            .expect("seal original V5 admission"),
        GovernedDispatchV5AdmissionDispositionV1::Sealed { .. }
    ));
    assert_eq!(v5_admission_count(&store), 1);
    assert_eq!(checkpoint_count(&store, fixture.run_id), 1);
    assert_eq!(store.event_count().expect("count sealed V5 tape"), 7);

    // This sibling is separately signed, has a fresh event identity, and has
    // exactly the same immutable V5 body. It must not be treated as a benign
    // retry: it makes the sealed source identity ambiguous and requires
    // reconciliation before either the record or seal path can report success.
    let source_sibling = event(
        fixture.run_id,
        EventKind::DispatchEnvelopeV5,
        Payload::DispatchEnvelopeV5(fixture.dispatch.clone()),
    );
    store
        .append_signed(&source_sibling, &source_key, &source_signer)
        .expect("append distinct signed V5 source sibling");
    assert_eq!(store.event_count().expect("count source sibling tape"), 8);

    let record_retry = store.record_governed_dispatch_v5_admission_v1(
        &request,
        &authority,
        &admission_key,
        &admission_signer,
    );
    assert!(matches!(
        record_retry,
        Err(LedgerError::GovernedDispatchAdmissionReconciliationRequired { .. })
    ));
    let seal_retry = store.seal_governed_dispatch_v5_admission_v1(
        &seal_request,
        &authority,
        &checkpoint_key,
        &checkpoint_signer,
    );
    assert!(matches!(
        seal_retry,
        Err(LedgerError::GovernedDispatchAdmissionReconciliationRequired { .. })
    ));
    assert_eq!(v5_admission_count(&store), 1);
    assert_eq!(checkpoint_count(&store, fixture.run_id), 1);
    assert_eq!(
        store.event_count().expect("count reconciled sibling tape"),
        8,
        "reconciliation must not mint another receipt or checkpoint"
    );
}

#[test]
fn v5_admission_reopens_reconciliation_for_a_second_signed_receipt_sibling() {
    let store = SqliteStore::open_in_memory().expect("open store");
    let source_key = SigningKey::from_bytes(&[38u8; 32]);
    let admission_key = SigningKey::from_bytes(&[39u8; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[40u8; 32]);
    let (authority, source_signer, admission_signer, checkpoint_signer) =
        v5_admission_authority(&source_key, &admission_key, &checkpoint_key);
    let fixture = v5_fixture(1);
    append_fixture(
        &store,
        &fixture,
        &source_key,
        &source_signer,
        &source_key,
        &source_signer,
    );
    let request = GovernedDispatchV5AdmissionRequestV1 {
        run_id: fixture.run_id,
        dispatch_event_id: fixture.dispatch_event.id,
    };
    let admission_event_id = awaiting_admission_event_id(
        store
            .record_governed_dispatch_v5_admission_v1(
                &request,
                &authority,
                &admission_key,
                &admission_signer,
            )
            .expect("record original V5 admission"),
    );
    let receipt_sibling = distinct_admission_receipt_sibling(&store, &fixture, admission_event_id);
    inject_signed_admission_receipt_sibling_for_reconciliation(
        &store,
        receipt_sibling,
        &admission_key,
        &admission_signer,
    );
    assert_eq!(v5_admission_count(&store), 1);
    assert_eq!(checkpoint_count(&store, fixture.run_id), 0);
    assert_eq!(store.event_count().expect("count receipt sibling tape"), 7);

    let record_retry = store.record_governed_dispatch_v5_admission_v1(
        &request,
        &authority,
        &admission_key,
        &admission_signer,
    );
    assert!(matches!(
        record_retry,
        Err(LedgerError::GovernedDispatchAdmissionReconciliationRequired { .. })
    ));
    let seal_retry = store.seal_governed_dispatch_v5_admission_v1(
        &GovernedDispatchV5AdmissionSealRequestV1 {
            run_id: fixture.run_id,
            admission_event_id,
        },
        &authority,
        &checkpoint_key,
        &checkpoint_signer,
    );
    assert!(matches!(
        seal_retry,
        Err(LedgerError::GovernedDispatchAdmissionReconciliationRequired { .. })
    ));
    assert_eq!(v5_admission_count(&store), 1);
    assert_eq!(checkpoint_count(&store, fixture.run_id), 0);
    assert_eq!(
        store
            .event_count()
            .expect("count reconciled receipt sibling tape"),
        7,
        "reconciliation must not append another receipt or checkpoint"
    );
}

#[test]
fn v5_admission_rejects_wrong_source_or_admission_signer_without_a_write() {
    let expected_source_key = SigningKey::from_bytes(&[41u8; 32]);
    let admission_key = SigningKey::from_bytes(&[42u8; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[43u8; 32]);
    let (authority, source_signer, admission_signer, _) =
        v5_admission_authority(&expected_source_key, &admission_key, &checkpoint_key);

    let wrong_source_store = SqliteStore::open_in_memory().expect("open wrong-source store");
    let wrong_source_key = SigningKey::from_bytes(&[44u8; 32]);
    let wrong_source_signer = actor("untrusted:v5-source", "source-2", &wrong_source_key);
    let wrong_source_fixture = v5_fixture(1);
    append_fixture(
        &wrong_source_store,
        &wrong_source_fixture,
        &wrong_source_key,
        &wrong_source_signer,
        &wrong_source_key,
        &wrong_source_signer,
    );
    let wrong_source_result = wrong_source_store.record_governed_dispatch_v5_admission_v1(
        &GovernedDispatchV5AdmissionRequestV1 {
            run_id: wrong_source_fixture.run_id,
            dispatch_event_id: wrong_source_fixture.dispatch_event.id,
        },
        &authority,
        &admission_key,
        &admission_signer,
    );
    assert!(matches!(
        wrong_source_result,
        Err(LedgerError::GovernedDispatchAdmissionAuthorityRejected { .. })
    ));
    assert_eq!(v5_admission_count(&wrong_source_store), 0);
    assert_eq!(
        wrong_source_store
            .event_count()
            .expect("count rejected source tape"),
        5
    );

    let wrong_admission_store = SqliteStore::open_in_memory().expect("open wrong-admission store");
    let wrong_admission_fixture = v5_fixture(1);
    append_fixture(
        &wrong_admission_store,
        &wrong_admission_fixture,
        &expected_source_key,
        &source_signer,
        &expected_source_key,
        &source_signer,
    );
    let wrong_admission_key = SigningKey::from_bytes(&[45u8; 32]);
    let wrong_admission_signer = actor(
        "untrusted:v5-admission",
        "admission-2",
        &wrong_admission_key,
    );
    let wrong_admission_result = wrong_admission_store.record_governed_dispatch_v5_admission_v1(
        &GovernedDispatchV5AdmissionRequestV1 {
            run_id: wrong_admission_fixture.run_id,
            dispatch_event_id: wrong_admission_fixture.dispatch_event.id,
        },
        &authority,
        &wrong_admission_key,
        &wrong_admission_signer,
    );
    assert!(matches!(
        wrong_admission_result,
        Err(LedgerError::GovernedDispatchAdmissionAuthorityRejected { .. })
    ));
    assert_eq!(v5_admission_count(&wrong_admission_store), 0);
    assert_eq!(
        wrong_admission_store
            .event_count()
            .expect("count rejected admission tape"),
        5
    );
}

#[test]
fn generic_append_paths_cannot_poison_v5_admission_receipt_reconciliation() {
    let store = SqliteStore::open_in_memory().expect("open store");
    let source_key = SigningKey::from_bytes(&[46u8; 32]);
    let admission_key = SigningKey::from_bytes(&[47u8; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[48u8; 32]);
    let (authority, source_signer, admission_signer, _) =
        v5_admission_authority(&source_key, &admission_key, &checkpoint_key);
    let fixture = v5_fixture(1);
    append_fixture(
        &store,
        &fixture,
        &source_key,
        &source_signer,
        &source_key,
        &source_signer,
    );
    let admission_event_id = awaiting_admission_event_id(
        store
            .record_governed_dispatch_v5_admission_v1(
                &GovernedDispatchV5AdmissionRequestV1 {
                    run_id: fixture.run_id,
                    dispatch_event_id: fixture.dispatch_event.id,
                },
                &authority,
                &admission_key,
                &admission_signer,
            )
            .expect("record protected V5 admission receipt"),
    );
    let unsigned_forgery = distinct_admission_receipt_sibling(&store, &fixture, admission_event_id);
    let event_count_before = store
        .event_count()
        .expect("count protected tape before forgery");

    let unsigned_result = store.append(&unsigned_forgery);
    assert!(matches!(
        unsigned_result,
        Err(LedgerError::CallerSuppliedTrustSpineEvent { ref kind })
            if kind == "governed_dispatch_v5_admission_recorded_v1"
    ));
    assert_eq!(
        store.event_count().expect("count after unsigned forgery"),
        event_count_before
    );
    assert_eq!(v5_admission_count(&store), 1);
    assert_eq!(checkpoint_count(&store, fixture.run_id), 0);

    let signed_forgery = Event {
        id: EventId::new(),
        ..unsigned_forgery
    };
    let signed_result = store.append_signed_with_checkpoint(
        &signed_forgery,
        &source_key,
        &source_signer,
        &CheckpointPolicy::every(1),
    );
    assert!(matches!(
        signed_result,
        Err(LedgerError::CallerSuppliedTrustSpineEvent { ref kind })
            if kind == "governed_dispatch_v5_admission_recorded_v1"
    ));
    assert_eq!(
        store.event_count().expect("count after signed forgery"),
        event_count_before
    );
    assert_eq!(v5_admission_count(&store), 1);
    assert_eq!(checkpoint_count(&store, fixture.run_id), 0);
}

#[test]
fn v5_admission_rejects_missing_wrong_run_and_retry_source_evidence_without_a_write() {
    let source_key = SigningKey::from_bytes(&[51u8; 32]);
    let admission_key = SigningKey::from_bytes(&[52u8; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[53u8; 32]);
    let (authority, source_signer, admission_signer, _) =
        v5_admission_authority(&source_key, &admission_key, &checkpoint_key);

    let missing_store = SqliteStore::open_in_memory().expect("open missing source store");
    let missing_result = missing_store.record_governed_dispatch_v5_admission_v1(
        &GovernedDispatchV5AdmissionRequestV1 {
            run_id: RunId::new(),
            dispatch_event_id: EventId::new(),
        },
        &authority,
        &admission_key,
        &admission_signer,
    );
    assert!(matches!(
        missing_result,
        Err(LedgerError::GovernedDispatchAdmissionAuthorityRejected { .. })
    ));
    assert_eq!(v5_admission_count(&missing_store), 0);
    assert_eq!(missing_store.event_count().expect("count empty tape"), 0);

    let wrong_run_store = SqliteStore::open_in_memory().expect("open wrong-run source store");
    let wrong_run_fixture = v5_fixture(1);
    append_fixture(
        &wrong_run_store,
        &wrong_run_fixture,
        &source_key,
        &source_signer,
        &source_key,
        &source_signer,
    );
    let wrong_run_result = wrong_run_store.record_governed_dispatch_v5_admission_v1(
        &GovernedDispatchV5AdmissionRequestV1 {
            run_id: RunId::new(),
            dispatch_event_id: wrong_run_fixture.dispatch_event.id,
        },
        &authority,
        &admission_key,
        &admission_signer,
    );
    assert!(matches!(
        wrong_run_result,
        Err(LedgerError::GovernedDispatchAdmissionAuthorityRejected { .. })
    ));
    assert_eq!(v5_admission_count(&wrong_run_store), 0);
    assert_eq!(
        wrong_run_store
            .event_count()
            .expect("count wrong-run source tape"),
        5
    );

    let retry_store = SqliteStore::open_in_memory().expect("open retry source store");
    let retry_fixture = v5_fixture(2);
    append_fixture(
        &retry_store,
        &retry_fixture,
        &source_key,
        &source_signer,
        &source_key,
        &source_signer,
    );
    let retry_result = retry_store.record_governed_dispatch_v5_admission_v1(
        &GovernedDispatchV5AdmissionRequestV1 {
            run_id: retry_fixture.run_id,
            dispatch_event_id: retry_fixture.dispatch_event.id,
        },
        &authority,
        &admission_key,
        &admission_signer,
    );
    assert!(matches!(
        retry_result,
        Err(LedgerError::GovernedDispatchAdmissionAuthorityRejected { .. })
    ));
    assert_eq!(v5_admission_count(&retry_store), 0);
    assert_eq!(
        retry_store.event_count().expect("count retry source tape"),
        6
    );
}

#[test]
fn v5_admission_rejects_wrong_checkpoint_signer_without_emitting_a_checkpoint() {
    let store = SqliteStore::open_in_memory().expect("open store");
    let source_key = SigningKey::from_bytes(&[61u8; 32]);
    let admission_key = SigningKey::from_bytes(&[62u8; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[63u8; 32]);
    let (authority, source_signer, admission_signer, _) =
        v5_admission_authority(&source_key, &admission_key, &checkpoint_key);
    let fixture = v5_fixture(1);
    append_fixture(
        &store,
        &fixture,
        &source_key,
        &source_signer,
        &source_key,
        &source_signer,
    );
    let admission_event_id = awaiting_admission_event_id(
        store
            .record_governed_dispatch_v5_admission_v1(
                &GovernedDispatchV5AdmissionRequestV1 {
                    run_id: fixture.run_id,
                    dispatch_event_id: fixture.dispatch_event.id,
                },
                &authority,
                &admission_key,
                &admission_signer,
            )
            .expect("record V5 admission before wrong checkpoint"),
    );
    let wrong_checkpoint_key = SigningKey::from_bytes(&[64u8; 32]);
    let wrong_checkpoint_signer = actor(
        "untrusted:v5-checkpoint",
        "checkpoint-2",
        &wrong_checkpoint_key,
    );
    let result = store.seal_governed_dispatch_v5_admission_v1(
        &GovernedDispatchV5AdmissionSealRequestV1 {
            run_id: fixture.run_id,
            admission_event_id,
        },
        &authority,
        &wrong_checkpoint_key,
        &wrong_checkpoint_signer,
    );
    assert!(matches!(
        result,
        Err(LedgerError::GovernedDispatchAdmissionAuthorityRejected { .. })
    ));
    assert_eq!(v5_admission_count(&store), 1, "record remains awaiting");
    assert_eq!(checkpoint_count(&store, fixture.run_id), 0);
    assert_eq!(
        store.event_count().expect("count rejected checkpoint tape"),
        6,
        "a failed checkpoint signer must not append a checkpoint"
    );
}

#[test]
fn sealed_v5_admission_still_cannot_claim_a_v5_bound_action() {
    let store = SqliteStore::open_in_memory().expect("open store");
    let source_key = SigningKey::from_bytes(&[71u8; 32]);
    let admission_key = SigningKey::from_bytes(&[72u8; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[73u8; 32]);
    let (authority, source_signer, admission_signer, checkpoint_signer) =
        v5_admission_authority(&source_key, &admission_key, &checkpoint_key);
    let fixture = v5_fixture(1);
    append_fixture(
        &store,
        &fixture,
        &source_key,
        &source_signer,
        &source_key,
        &source_signer,
    );
    let admission_event_id = awaiting_admission_event_id(
        store
            .record_governed_dispatch_v5_admission_v1(
                &GovernedDispatchV5AdmissionRequestV1 {
                    run_id: fixture.run_id,
                    dispatch_event_id: fixture.dispatch_event.id,
                },
                &authority,
                &admission_key,
                &admission_signer,
            )
            .expect("record V5 admission"),
    );
    store
        .seal_governed_dispatch_v5_admission_v1(
            &GovernedDispatchV5AdmissionSealRequestV1 {
                run_id: fixture.run_id,
                admission_event_id,
            },
            &authority,
            &checkpoint_key,
            &checkpoint_signer,
        )
        .expect("seal V5 admission");

    let action_request = action_request_for_v5_fixture(&fixture, &source_signer.actor_id);
    action_requested_v2_digest(&action_request).expect("action request fixture is canonical");
    let action_request_event = child_event(
        fixture.run_id,
        fixture.dispatch_event.id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(action_request),
    );
    store
        .append_signed(&action_request_event, &source_key, &source_signer)
        .expect("append signed V5-bound action request");

    let claim = store.claim_activity_v1(
        &ActivityClaimRequestV1 {
            run_id: fixture.run_id,
            activity_id: "v5-admission-must-not-claim".into(),
            idempotency_key: "v5-admission-must-not-claim".into(),
            dispatch_event_id: fixture.dispatch_event.id,
            action_request_event_id: action_request_event.id,
            lease_duration_ms: 1_000,
        },
        &activity_claim_authority(&source_key, &source_signer),
        &source_key,
        &source_signer,
    );
    assert!(matches!(
        claim,
        Err(LedgerError::ActivityClaimAuthorityRejected { reason })
            if reason == "claim requires a signed dispatch_envelope_v3 or graph-bound dispatch_envelope_v4 event"
    ));
    let claim_rows: i64 = store
        .conn_for_tests()
        .query_row("SELECT COUNT(*) FROM activity_claims", [], |row| row.get(0))
        .expect("count rejected V5 activity claims");
    assert_eq!(claim_rows, 0, "sealed V5 admission remains evidence only");
}
