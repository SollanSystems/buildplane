//! Manifest-bound V5 dispatch reducer tests.

use bp_ledger::canonicalize::canonical_event_hash;
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::run_lifecycle::RunStartedV1;
use bp_ledger::payload::trust_spine::{
    attempt_context_content_v1_digest, attempt_context_recorded_v1_digest,
    context_manifest_content_v1_digest, dispatch_envelope_v3_body_digest,
    dispatch_envelope_v4_digest, dispatch_envelope_v5_digest, sandbox_profile_content_v1_digest,
    worker_manifest_content_v1_digest, ActionEvidenceVersionV1, AttemptContextContentV1,
    AttemptContextDeclaredV1, AttemptContextRecordedV1, AttemptFeedbackV1, CommitModeV1,
    ContextManifestContentV1, ContextManifestDeclaredV1, ContextManifestEntryKindV1,
    ContextManifestEntryV1, ContextTaintV1, ContextTrustLevelV1, DispatchBudgetV1,
    DispatchEnvelopeBodyV2, DispatchEnvelopeV3, DispatchEnvelopeV4, DispatchEnvelopeV5,
    ExecutionRoleV1, GovernedDispatchV5AdmissionRecordedV1, SandboxProfileContentV1,
    SandboxProfileDeclaredV1, SandboxRuntimeV1, TrustTierV1, WorkerHarnessV1,
    WorkerManifestContentV1, WorkerManifestDeclaredV1, WorkerProviderV1, WorkflowGraphDeclaredV2,
    WorkflowGraphNodeV2,
};
use bp_ledger::payload::Payload;
use bp_ledger::signing::{public_key_hash, sign_event, ActorKeyRef, TrustedPublicKeys};
use bp_ledger::storage::sqlite::{
    GovernedDispatchV5AdmissionAuthorityV1, GovernedDispatchV5AdmissionDispositionV1,
    GovernedDispatchV5AdmissionRequestV1, GovernedDispatchV5AdmissionSealRequestV1, SqliteStore,
};
use bp_replay::engine::{ReplayEngine, TrustSpineSignerRole, TrustedReplayAuthorities};
use bp_replay::state::{AttemptContextReplayState, ReplayIssue, ReplayState};
use bp_replay::transitions::apply_legacy_projection_unchecked;
use bp_replay::{TrustedGovernedRecoveryError, TrustedGovernedRecoverySnapshot};
use chrono::{SecondsFormat, Utc};
use ed25519_dalek::SigningKey;
use rusqlite::params;
use std::collections::BTreeMap;
use std::path::Path;
use tempfile::TempDir;

fn digest(hex: char) -> String {
    format!("sha256:{}", hex.to_string().repeat(64))
}

fn kernel_signer() -> ActorKeyRef {
    ActorKeyRef {
        actor_id: "kernel".into(),
        key_id: "kernel-main".into(),
        public_key_hash: None,
    }
}

fn reviewer_signer() -> ActorKeyRef {
    ActorKeyRef {
        actor_id: "reviewer".into(),
        key_id: "reviewer-main".into(),
        public_key_hash: None,
    }
}

fn admission_signer() -> ActorKeyRef {
    ActorKeyRef {
        actor_id: "admission".into(),
        key_id: "admission-main".into(),
        public_key_hash: None,
    }
}

fn checkpoint_signer() -> ActorKeyRef {
    ActorKeyRef {
        actor_id: "checkpoint".into(),
        key_id: "checkpoint-main".into(),
        public_key_hash: None,
    }
}

fn signer_with_key(signer: ActorKeyRef, signing_key: &SigningKey) -> ActorKeyRef {
    ActorKeyRef {
        public_key_hash: Some(public_key_hash(&signing_key.verifying_key())),
        ..signer
    }
}

fn trusted_authorities(signing_key: &SigningKey) -> TrustedReplayAuthorities {
    let key_hash = public_key_hash(&signing_key.verifying_key());
    let mut keys = TrustedPublicKeys::default();
    keys.insert_public_key(
        key_hash.clone(),
        signing_key.verifying_key().to_bytes().to_vec(),
    );
    let mut authorities = TrustedReplayAuthorities::new(keys);
    authorities.allow_signer(
        TrustSpineSignerRole::Kernel,
        ActorKeyRef {
            public_key_hash: Some(key_hash),
            ..kernel_signer()
        },
    );
    authorities
}

fn protected_v5_admission_replay_authorities(
    source_signing_key: &SigningKey,
    admission_signing_key: &SigningKey,
    checkpoint_signing_key: &SigningKey,
    allow_admission_signer: bool,
) -> (
    GovernedDispatchV5AdmissionAuthorityV1,
    TrustedReplayAuthorities,
    ActorKeyRef,
    ActorKeyRef,
    ActorKeyRef,
) {
    let source_signer = signer_with_key(kernel_signer(), source_signing_key);
    let admission_signer = signer_with_key(admission_signer(), admission_signing_key);
    let checkpoint_signer = signer_with_key(checkpoint_signer(), checkpoint_signing_key);
    let mut keys = TrustedPublicKeys::default();
    keys.insert_public_key(
        source_signer
            .public_key_hash
            .clone()
            .expect("source signer key hash"),
        source_signing_key.verifying_key().to_bytes().to_vec(),
    );
    keys.insert_public_key(
        admission_signer
            .public_key_hash
            .clone()
            .expect("admission signer key hash"),
        admission_signing_key.verifying_key().to_bytes().to_vec(),
    );
    keys.insert_public_key(
        checkpoint_signer
            .public_key_hash
            .clone()
            .expect("checkpoint signer key hash"),
        checkpoint_signing_key.verifying_key().to_bytes().to_vec(),
    );
    let admission_authority = GovernedDispatchV5AdmissionAuthorityV1::new_governed_realm(
        keys.clone(),
        source_signer.clone(),
        admission_signer.clone(),
        checkpoint_signer.clone(),
        digest('8'),
    )
    .expect("construct protected V5 admission authority");
    let mut authorities = TrustedReplayAuthorities::new(keys);
    authorities.allow_signer(TrustSpineSignerRole::Kernel, source_signer.clone());
    if allow_admission_signer {
        authorities.allow_signer(TrustSpineSignerRole::Admission, admission_signer.clone());
    }
    authorities.allow_signer(TrustSpineSignerRole::Kernel, checkpoint_signer.clone());
    (
        admission_authority,
        authorities,
        source_signer,
        admission_signer,
        checkpoint_signer,
    )
}

struct V5Fixture {
    graph: Event,
    context_manifest: Event,
    worker_manifest: Event,
    sandbox_profile: Event,
    attempt_context: Option<Event>,
    dispatch_v3: Event,
    dispatch_v4: Event,
    dispatch: Event,
}

fn v5_fixture(attempt: u32, attempt_context_provenance: Option<&str>) -> V5Fixture {
    assert!(attempt > 0);
    let run_id = RunId::new();
    let packet_digest = digest('a');
    let context_manifest = ContextManifestContentV1 { entries: vec![] };
    let context_manifest_digest = context_manifest_content_v1_digest(&context_manifest).unwrap();
    let worker_manifest = WorkerManifestContentV1 {
        provider: WorkerProviderV1::OpenAi,
        model: "gpt-5.6".into(),
        harness: WorkerHarnessV1::OpenAiApiSdk,
        image_digest: digest('b'),
        tool_manifest_digest: digest('c'),
        skill_manifest_digest: digest('d'),
        capability_bundle_digest: digest('e'),
        execution_role: ExecutionRoleV1::Implementer,
    };
    let worker_manifest_digest = worker_manifest_content_v1_digest(&worker_manifest).unwrap();
    let sandbox_profile = SandboxProfileContentV1 {
        runtime: SandboxRuntimeV1::RootlessOci,
        rootless: true,
        image_digest: worker_manifest.image_digest.clone(),
        read_only_rootfs: true,
        writable_overlay_digest: digest('0'),
        mount_manifest_digest: digest('1'),
        environment_manifest_digest: digest('2'),
        network_policy_digest: digest('3'),
        resource_policy_digest: digest('4'),
        secret_handle_manifest_digest: digest('5'),
    };
    let sandbox_profile_digest = sandbox_profile_content_v1_digest(&sandbox_profile).unwrap();
    let body = DispatchEnvelopeBodyV2 {
        workflow_id: "workflow-v5".into(),
        workflow_revision: "r1".into(),
        unit_id: "unit-a".into(),
        attempt,
        execution_role: ExecutionRoleV1::Implementer,
        commit_mode: CommitModeV1::Atomic,
        provenance_ref: "admission:workflow-v5".into(),
        base_commit_sha: "1".repeat(40),
        capability_bundle_digest: worker_manifest.capability_bundle_digest.clone(),
        acceptance_contract_digest: digest('6'),
        context_manifest_digest: context_manifest_digest.clone(),
        worker_manifest_digest: worker_manifest_digest.clone(),
        sandbox_profile_digest: sandbox_profile_digest.clone(),
        budget: DispatchBudgetV1 {
            max_tokens: Some(100),
            max_compute_time_ms: Some(1_000),
        },
        trust_tier: TrustTierV1::Governed,
        idempotency_key: format!("dispatch:workflow-v5:unit-a:{attempt}"),
        issued_at: "2026-07-25T00:01:00Z".into(),
        expires_at: "2026-07-25T01:01:00Z".into(),
    };
    let mut graph = WorkflowGraphDeclaredV2 {
        run_id: run_id.to_string(),
        workflow_id: body.workflow_id.clone(),
        workflow_revision: body.workflow_revision.clone(),
        nodes: vec![WorkflowGraphNodeV2 {
            unit_id: body.unit_id.clone(),
            depends_on: vec![],
            execution_role: body.execution_role,
            governed_packet_digest: packet_digest.clone(),
        }],
        max_concurrent: 1,
        graph_digest: String::new(),
        idempotency_key: "graph:workflow-v5:r1".into(),
        declared_at: "2026-07-25T00:00:00Z".into(),
    };
    graph.graph_digest = bp_ledger::payload::trust_spine::workflow_graph_v2_digest(&graph).unwrap();
    let graph_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::WorkflowGraphDeclaredV2,
        occurred_at: Utc::now(),
        payload: Payload::WorkflowGraphDeclaredV2(graph.clone()),
    };

    let context_manifest_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: Some(graph_event.id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::ContextManifestDeclaredV1,
        occurred_at: Utc::now(),
        payload: Payload::ContextManifestDeclaredV1(ContextManifestDeclaredV1 {
            run_id: graph.run_id.clone(),
            workflow_id: body.workflow_id.clone(),
            workflow_revision: body.workflow_revision.clone(),
            unit_id: body.unit_id.clone(),
            attempt,
            provenance_ref: body.provenance_ref.clone(),
            context_manifest,
            context_manifest_digest: context_manifest_digest.clone(),
            idempotency_key: format!("context:workflow-v5:unit-a:{attempt}"),
            declared_at: "2026-07-25T00:00:01Z".into(),
        }),
    };
    let worker_manifest_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: Some(graph_event.id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::WorkerManifestDeclaredV1,
        occurred_at: Utc::now(),
        payload: Payload::WorkerManifestDeclaredV1(WorkerManifestDeclaredV1 {
            run_id: graph.run_id.clone(),
            workflow_id: body.workflow_id.clone(),
            workflow_revision: body.workflow_revision.clone(),
            unit_id: body.unit_id.clone(),
            attempt,
            provenance_ref: body.provenance_ref.clone(),
            worker_manifest,
            worker_manifest_digest: worker_manifest_digest.clone(),
            idempotency_key: format!("worker:workflow-v5:unit-a:{attempt}"),
            declared_at: "2026-07-25T00:00:02Z".into(),
        }),
    };
    let sandbox_profile_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: Some(graph_event.id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::SandboxProfileDeclaredV1,
        occurred_at: Utc::now(),
        payload: Payload::SandboxProfileDeclaredV1(SandboxProfileDeclaredV1 {
            run_id: graph.run_id.clone(),
            workflow_id: body.workflow_id.clone(),
            workflow_revision: body.workflow_revision.clone(),
            unit_id: body.unit_id.clone(),
            attempt,
            provenance_ref: body.provenance_ref.clone(),
            sandbox_profile,
            sandbox_profile_digest: sandbox_profile_digest.clone(),
            idempotency_key: format!("sandbox:workflow-v5:unit-a:{attempt}"),
            declared_at: "2026-07-25T00:00:03Z".into(),
        }),
    };
    let attempt_context_event = (attempt > 1).then(|| {
        let attempt_context = AttemptContextContentV1 {
            attempt,
            retry_feedback: vec![AttemptFeedbackV1 {
                feedback_ref: "cas:retry-feedback:1".into(),
                feedback_digest: digest('9'),
            }],
            prior_candidates: vec![],
        };
        let attempt_context_digest = attempt_context_content_v1_digest(&attempt_context).unwrap();
        Event {
            id: EventId::new(),
            run_id,
            parent_event_id: Some(graph_event.id),
            schema_version: Event::CURRENT_SCHEMA_VERSION,
            kind: EventKind::AttemptContextDeclaredV1,
            occurred_at: Utc::now(),
            payload: Payload::AttemptContextDeclaredV1(AttemptContextDeclaredV1 {
                run_id: graph.run_id.clone(),
                workflow_id: body.workflow_id.clone(),
                workflow_revision: body.workflow_revision.clone(),
                unit_id: body.unit_id.clone(),
                attempt,
                provenance_ref: attempt_context_provenance
                    .unwrap_or(body.provenance_ref.as_str())
                    .into(),
                attempt_context,
                attempt_context_digest,
                idempotency_key: format!("retry-context:workflow-v5:unit-a:{attempt}"),
                declared_at: "2026-07-25T00:00:04Z".into(),
            }),
        }
    });

    let action_evidence_version = ActionEvidenceVersionV1::SealedV3;
    let repository_binding_digest = digest('7');
    let ledger_authority_realm_digest = digest('8');
    let dispatch_v3 = DispatchEnvelopeV3 {
        envelope_digest: dispatch_envelope_v3_body_digest(
            &body,
            action_evidence_version,
            &repository_binding_digest,
            &ledger_authority_realm_digest,
            Some(packet_digest.as_str()),
        )
        .unwrap(),
        body,
        action_evidence_version,
        repository_binding_digest,
        ledger_authority_realm_digest,
        governed_packet_digest: Some(packet_digest),
    };
    let dispatch_v3_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: Some(graph_event.id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::DispatchEnvelopeV3,
        occurred_at: Utc::now(),
        payload: Payload::DispatchEnvelopeV3(dispatch_v3.clone()),
    };
    let mut dispatch_v4 = DispatchEnvelopeV4 {
        dispatch_v3,
        workflow_graph_digest: graph.graph_digest.clone(),
        workflow_graph_declaration_event_ref: graph_event.id,
        envelope_digest: String::new(),
    };
    dispatch_v4.envelope_digest = dispatch_envelope_v4_digest(
        &dispatch_v4.dispatch_v3,
        &dispatch_v4.workflow_graph_digest,
        &dispatch_v4.workflow_graph_declaration_event_ref,
    )
    .unwrap();
    let dispatch_v4_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: Some(graph_event.id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::DispatchEnvelopeV4,
        occurred_at: Utc::now(),
        payload: Payload::DispatchEnvelopeV4(dispatch_v4.clone()),
    };
    let attempt_context_binding = attempt_context_event.as_ref().map(|event| {
        let Payload::AttemptContextDeclaredV1(declaration) = &event.payload else {
            unreachable!("attempt context fixture event has the expected payload")
        };
        (event.id, declaration.attempt_context_digest.clone())
    });
    let mut dispatch_v5 = DispatchEnvelopeV5 {
        dispatch_v4,
        context_manifest_declaration_event_ref: context_manifest_event.id,
        context_manifest_digest,
        worker_manifest_declaration_event_ref: worker_manifest_event.id,
        worker_manifest_digest,
        sandbox_profile_declaration_event_ref: sandbox_profile_event.id,
        sandbox_profile_digest,
        attempt_context_declaration_event_ref: attempt_context_binding.as_ref().map(|(id, _)| *id),
        attempt_context_digest: attempt_context_binding.map(|(_, digest)| digest),
        envelope_digest: String::new(),
    };
    dispatch_v5.envelope_digest = dispatch_envelope_v5_digest(&dispatch_v5).unwrap();
    let dispatch_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: Some(graph_event.id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::DispatchEnvelopeV5,
        occurred_at: Utc::now(),
        payload: Payload::DispatchEnvelopeV5(dispatch_v5),
    };

    V5Fixture {
        graph: graph_event,
        context_manifest: context_manifest_event,
        worker_manifest: worker_manifest_event,
        sandbox_profile: sandbox_profile_event,
        attempt_context: attempt_context_event,
        dispatch_v3: dispatch_v3_event,
        dispatch_v4: dispatch_v4_event,
        dispatch: dispatch_event,
    }
}

fn apply_manifest_declarations(state: &mut ReplayState, fixture: &V5Fixture) {
    apply_legacy_projection_unchecked(state, &fixture.context_manifest);
    apply_legacy_projection_unchecked(state, &fixture.worker_manifest);
    apply_legacy_projection_unchecked(state, &fixture.sandbox_profile);
    if let Some(attempt_context) = fixture.attempt_context.as_ref() {
        apply_legacy_projection_unchecked(state, attempt_context);
    }
}

fn append_signed_v5_source(
    store: &SqliteStore,
    fixture: &V5Fixture,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
) {
    for event in [
        &fixture.graph,
        &fixture.context_manifest,
        &fixture.worker_manifest,
        &fixture.sandbox_profile,
        &fixture.dispatch,
    ] {
        store
            .append_signed(event, signing_key, signer)
            .expect("append protected V5 source evidence");
    }
}

fn record_and_seal_v5_admission(
    store: &SqliteStore,
    fixture: &V5Fixture,
    authority: &GovernedDispatchV5AdmissionAuthorityV1,
    admission_signing_key: &SigningKey,
    admission_signer: &ActorKeyRef,
    checkpoint_signing_key: &SigningKey,
    checkpoint_signer: &ActorKeyRef,
) -> EventId {
    let Payload::DispatchEnvelopeV5(dispatch) = &fixture.dispatch.payload else {
        panic!("fixture dispatch must contain a V5 envelope");
    };
    let resolved_source_event_id = store
        .resolve_unique_governed_dispatch_v5_source_by_digest_v1(
            fixture.dispatch.run_id,
            dispatch.envelope_digest.as_str(),
            authority,
        )
        .expect("resolve the authoritative V5 source before admission");
    assert_eq!(
        resolved_source_event_id, fixture.dispatch.id,
        "the bounded source projection must resolve the fixture dispatch"
    );
    let admission_event_id = match store
        .record_governed_dispatch_v5_admission_v1(
            &GovernedDispatchV5AdmissionRequestV1 {
                run_id: fixture.dispatch.run_id,
                dispatch_event_id: fixture.dispatch.id,
            },
            authority,
            admission_signing_key,
            admission_signer,
        )
        .expect("record separately signed V5 admission receipt")
    {
        GovernedDispatchV5AdmissionDispositionV1::AwaitingCheckpoint {
            admission_event_id, ..
        } => admission_event_id,
        other => panic!("new V5 admission must await a checkpoint, got {other:?}"),
    };
    store
        .seal_governed_dispatch_v5_admission_v1(
            &GovernedDispatchV5AdmissionSealRequestV1 {
                run_id: fixture.dispatch.run_id,
                admission_event_id,
            },
            authority,
            checkpoint_signing_key,
            checkpoint_signer,
        )
        .expect("seal a checkpoint prefix containing the V5 admission receipt");
    admission_event_id
}

/// Production ingress intentionally rejects caller-supplied V5 receipts. This
/// test-only writer lets replay be exercised against a byte-valid, signed tape
/// that bypassed that ingress, so the reducer's independent role and binding
/// checks cannot regress into trusting storage admission projections.
fn append_signed_v5_admission_receipt_directly_for_replay_test(
    db_path: &Path,
    event: &Event,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
) {
    let signature = sign_event(event, signing_key, signer, Utc::now())
        .expect("sign a canonical direct V5 admission receipt");
    let connection = rusqlite::Connection::open(db_path).expect("open test ledger connection");
    connection
        .execute(
            r#"INSERT INTO events (id, run_id, parent_event_id, schema_version, kind, occurred_at, payload)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#,
            params![
                event.id.to_string(),
                event.run_id.to_string(),
                event.parent_event_id.map(|event_id| event_id.to_string()),
                event.schema_version,
                event.kind_str(),
                event.occurred_at.to_rfc3339(),
                serde_json::to_string(&event.payload).expect("serialize direct receipt payload"),
            ],
        )
        .expect("insert direct V5 admission receipt event");
    connection
        .execute(
            r#"INSERT INTO event_signatures (
                    event_id, canonical_event_hash, actor_id, key_id, public_key_hash,
                    algorithm, signature, signed_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"#,
            params![
                signature.event_id.to_string(),
                signature.canonical_event_hash,
                signature.signer.actor_id,
                signature.signer.key_id,
                signature.signer.public_key_hash,
                "ed25519",
                signature.signature,
                signature.signed_at.to_rfc3339(),
            ],
        )
        .expect("insert direct V5 admission receipt signature");
}

fn append_checkpointed_anchor_after_direct_v5_admission(
    store: &SqliteStore,
    run_id: RunId,
    signing_key: &SigningKey,
    signer: &ActorKeyRef,
) {
    let anchor = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::RunStarted,
        occurred_at: Utc::now(),
        payload: Payload::RunStartedV1(RunStartedV1 {
            packet_hash: "sha256:recovery-anchor".into(),
            git_head: "recovery-anchor".into(),
            workspace_path: "/protected-host/recovery-anchor".into(),
            config: BTreeMap::new(),
            parent_run_id: None,
            parent_event_id: None,
        }),
    };
    store
        .append_signed_with_checkpoint(
            &anchor,
            signing_key,
            signer,
            &bp_ledger::storage::sqlite::CheckpointPolicy::every(1),
        )
        .expect("append a checkpointed anchor over the direct V5 admission receipt");
}

fn v5_admission_receipt_event(fixture: &V5Fixture) -> Event {
    let Payload::DispatchEnvelopeV5(dispatch) = &fixture.dispatch.payload else {
        unreachable!("V5 fixture dispatch event has the expected payload")
    };
    let occurred_at = chrono::DateTime::parse_from_rfc3339("2026-07-25T00:02:00.000Z")
        .expect("canonical fixture timestamp")
        .with_timezone(&Utc);
    Event {
        id: EventId::new(),
        run_id: fixture.dispatch.run_id,
        parent_event_id: Some(fixture.dispatch.id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::GovernedDispatchV5AdmissionRecordedV1,
        occurred_at,
        payload: Payload::GovernedDispatchV5AdmissionRecordedV1(
            GovernedDispatchV5AdmissionRecordedV1 {
                run_id: fixture.dispatch.run_id.to_string(),
                source_dispatch_event_ref: fixture.dispatch.id,
                source_dispatch_event_digest: canonical_event_hash(&fixture.dispatch)
                    .expect("canonical V5 source dispatch hash"),
                dispatch_envelope_digest: dispatch.envelope_digest.clone(),
                witness_evidence_digest: digest('b'),
                semantic_identity_digest: digest('c'),
                idempotency_key: dispatch
                    .dispatch_v4
                    .dispatch_v3
                    .body
                    .idempotency_key
                    .clone(),
                ledger_authority_realm_digest: dispatch
                    .dispatch_v4
                    .dispatch_v3
                    .ledger_authority_realm_digest
                    .clone(),
                admitted_at: occurred_at.to_rfc3339_opts(SecondsFormat::Millis, true),
            },
        ),
    }
}

/// Build the replay projection produced by a previously validated
/// `attempt_context_recorded_v1` event. These tests target the V5 dispatch
/// consumer, so its exact envelope binding is the only variable under test.
fn projected_retry_context_for_v5(
    fixture: &V5Fixture,
    next_dispatch_envelope_digest: String,
) -> AttemptContextReplayState {
    let Payload::DispatchEnvelopeV5(dispatch) = &fixture.dispatch.payload else {
        unreachable!("V5 fixture dispatch event has the expected payload")
    };
    let body = &dispatch.dispatch_v4.dispatch_v3.body;
    let mut context = AttemptContextRecordedV1 {
        run_id: fixture.dispatch.run_id.to_string(),
        workflow_id: body.workflow_id.clone(),
        workflow_revision: body.workflow_revision.clone(),
        unit_id: body.unit_id.clone(),
        prior_attempt: body.attempt - 1,
        next_attempt: body.attempt,
        prior_dispatch_envelope_digest: digest('a'),
        prior_terminal_event_ref: "event:prior-terminal".into(),
        prior_terminal_event_digest: digest('b'),
        prior_action_receipt_ref: "cas:prior-failed-receipt".into(),
        prior_action_receipt_digest: digest('c'),
        feedback_ref: "cas:retry-feedback:1".into(),
        feedback_digest: digest('9'),
        next_dispatch_envelope_digest,
        next_dispatch_idempotency_key: body.idempotency_key.clone(),
        retry_action_namespace: format!(
            "retry-action:{}:{}:{}",
            body.workflow_id, body.unit_id, body.attempt
        ),
        idempotency_key: format!(
            "retry-context:{}:{}:{}",
            body.workflow_id, body.unit_id, body.attempt
        ),
        recorded_at: "2026-07-25T00:00:05Z".into(),
        attempt_context_digest: String::new(),
    };
    context.attempt_context_digest =
        attempt_context_recorded_v1_digest(&context).expect("hash retry context");
    AttemptContextReplayState {
        event_id: EventId::new(),
        context,
    }
}

#[test]
fn v5_dispatch_requires_its_manifest_declarations_to_precede_it() {
    let fixture = v5_fixture(1, None);
    let mut state = ReplayState::default();

    apply_legacy_projection_unchecked(&mut state, &fixture.graph);
    apply_legacy_projection_unchecked(&mut state, &fixture.dispatch);

    assert!(state.workflow_instances.is_empty());
    assert!(state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("manifest declaration")
    )));
}

#[test]
fn v5_projects_only_after_exact_prior_manifest_declarations() {
    let fixture = v5_fixture(1, None);
    let mut state = ReplayState::default();

    apply_legacy_projection_unchecked(&mut state, &fixture.graph);
    apply_manifest_declarations(&mut state, &fixture);
    apply_legacy_projection_unchecked(&mut state, &fixture.dispatch);

    assert!(state.issues.is_empty());
    assert_eq!(state.context_manifest_declarations.len(), 1);
    assert_eq!(state.worker_manifest_declarations.len(), 1);
    assert_eq!(state.sandbox_profile_declarations.len(), 1);
    let workflow = state
        .workflow_instances
        .values()
        .next()
        .expect("V5 workflow projected after all declarations");
    assert_eq!(workflow.dispatch.dispatch_version, 5);
    let witnesses = workflow
        .manifest_declarations
        .as_ref()
        .expect("V5 projection retains declaration witnesses");
    assert!(witnesses.dispatch_verified_signer.is_none());
    assert!(witnesses.context_manifest.verified_signer.is_none());
    assert!(witnesses.worker_manifest.verified_signer.is_none());
    assert!(witnesses.sandbox_profile.verified_signer.is_none());
}

#[test]
fn v5_rejects_a_prior_declaration_when_its_digest_does_not_match_the_dispatch() {
    let mut fixture = v5_fixture(1, None);
    let Payload::ContextManifestDeclaredV1(declaration) = &mut fixture.context_manifest.payload
    else {
        unreachable!("context fixture event has the expected payload")
    };
    declaration.context_manifest.entries = vec![ContextManifestEntryV1 {
        kind: ContextManifestEntryKindV1::Document,
        reference: "cas:context:other".into(),
        digest: digest('9'),
        provenance_ref: "source:other".into(),
        trust: ContextTrustLevelV1::Trusted,
        taint: ContextTaintV1::Clean,
    }];
    declaration.context_manifest_digest =
        context_manifest_content_v1_digest(&declaration.context_manifest).unwrap();

    let mut state = ReplayState::default();
    apply_legacy_projection_unchecked(&mut state, &fixture.graph);
    apply_manifest_declarations(&mut state, &fixture);
    apply_legacy_projection_unchecked(&mut state, &fixture.dispatch);

    assert!(state.workflow_instances.is_empty());
    assert!(state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("context manifest declaration does not bind")
    )));
}

#[test]
fn v5_retry_requires_an_attempt_context_declaration_with_matching_provenance() {
    let fixture = v5_fixture(2, Some("admission:wrong-provenance"));
    let mut state = ReplayState::default();
    apply_legacy_projection_unchecked(&mut state, &fixture.graph);
    apply_manifest_declarations(&mut state, &fixture);
    apply_legacy_projection_unchecked(&mut state, &fixture.dispatch);

    assert!(state.workflow_instances.is_empty());
    assert!(state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("retry declaration does not bind")
    )));
}

#[test]
fn v5_retry_rejects_a_recorded_context_bound_only_to_the_nested_v4_envelope() {
    let fixture = v5_fixture(2, None);
    let Payload::DispatchEnvelopeV5(dispatch) = &fixture.dispatch.payload else {
        unreachable!("V5 fixture dispatch event has the expected payload")
    };
    let mut state = ReplayState::default();
    apply_legacy_projection_unchecked(&mut state, &fixture.graph);
    apply_manifest_declarations(&mut state, &fixture);
    let context =
        projected_retry_context_for_v5(&fixture, dispatch.dispatch_v4.envelope_digest.clone());
    state.attempt_contexts.insert(
        context.context.next_dispatch_envelope_digest.clone(),
        context,
    );

    apply_legacy_projection_unchecked(&mut state, &fixture.dispatch);

    assert!(state.workflow_instances.is_empty());
    assert!(state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("manifest-bound V5 dispatch envelope digest")
    )));
}

#[test]
fn v5_retry_projects_only_when_the_recorded_context_binds_the_outer_v5_envelope() {
    let fixture = v5_fixture(2, None);
    let Payload::DispatchEnvelopeV5(dispatch) = &fixture.dispatch.payload else {
        unreachable!("V5 fixture dispatch event has the expected payload")
    };
    let mut state = ReplayState::default();
    apply_legacy_projection_unchecked(&mut state, &fixture.graph);
    apply_manifest_declarations(&mut state, &fixture);
    let context = projected_retry_context_for_v5(&fixture, dispatch.envelope_digest.clone());
    state.attempt_contexts.insert(
        context.context.next_dispatch_envelope_digest.clone(),
        context,
    );

    apply_legacy_projection_unchecked(&mut state, &fixture.dispatch);

    assert!(
        state.issues.is_empty(),
        "V5 retry issues: {:#?}",
        state.issues
    );
    let workflow = state
        .workflow_instances
        .values()
        .next()
        .expect("V5 retry projects only after its outer envelope is bound");
    assert_eq!(workflow.dispatch.dispatch_version, 5);
    assert_eq!(workflow.dispatch.envelope_digest, dispatch.envelope_digest);
    assert_eq!(
        workflow
            .retry_context
            .as_ref()
            .expect("V5 retry retains its recorded lineage")
            .context
            .next_dispatch_envelope_digest,
        dispatch.envelope_digest
    );
}

#[test]
fn v5_retry_rejects_recorded_feedback_absent_from_its_declared_attempt_context() {
    let fixture = v5_fixture(2, None);
    let Payload::DispatchEnvelopeV5(dispatch) = &fixture.dispatch.payload else {
        unreachable!("V5 fixture dispatch event has the expected payload")
    };
    let mut state = ReplayState::default();
    apply_legacy_projection_unchecked(&mut state, &fixture.graph);
    apply_manifest_declarations(&mut state, &fixture);
    let mut context = projected_retry_context_for_v5(&fixture, dispatch.envelope_digest.clone());
    context.context.feedback_digest = digest('f');
    context.context.attempt_context_digest =
        attempt_context_recorded_v1_digest(&context.context).expect("rehash mutated retry context");
    state.attempt_contexts.insert(
        context.context.next_dispatch_envelope_digest.clone(),
        context,
    );

    apply_legacy_projection_unchecked(&mut state, &fixture.dispatch);

    assert!(state.workflow_instances.is_empty());
    assert!(state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("retry feedback")
    )));
}

#[test]
fn v3_and_v4_dispatches_remain_compatible_without_v5_manifest_declarations() {
    let fixture = v5_fixture(1, None);

    let mut v3_state = ReplayState::default();
    apply_legacy_projection_unchecked(&mut v3_state, &fixture.dispatch_v3);
    let v3_workflow = v3_state
        .workflow_instances
        .values()
        .next()
        .expect("V3 dispatch still projects without a V5 declaration");
    assert_eq!(v3_workflow.dispatch.dispatch_version, 3);
    assert!(v3_workflow.manifest_declarations.is_none());

    let mut v4_state = ReplayState::default();
    apply_legacy_projection_unchecked(&mut v4_state, &fixture.graph);
    apply_legacy_projection_unchecked(&mut v4_state, &fixture.dispatch_v4);
    let v4_workflow = v4_state
        .workflow_instances
        .values()
        .next()
        .expect("V4 dispatch still projects without a V5 declaration");
    assert_eq!(v4_workflow.dispatch.dispatch_version, 4);
    assert!(v4_workflow.manifest_declarations.is_none());
}

#[test]
fn v5_protected_host_admission_receipt_is_replay_evidence_not_execution_authority() {
    let fixture = v5_fixture(1, None);
    let mut state = ReplayState::default();
    apply_legacy_projection_unchecked(&mut state, &fixture.graph);
    apply_manifest_declarations(&mut state, &fixture);
    apply_legacy_projection_unchecked(&mut state, &fixture.dispatch);
    let before = state.clone();
    let receipt_event = v5_admission_receipt_event(&fixture);

    apply_legacy_projection_unchecked(&mut state, &receipt_event);

    assert_eq!(
        state, before,
        "a V5 protected-host receipt must not create executable workflow state or alter prior projection"
    );
}

#[test]
fn trusted_recovery_excludes_v5_dispatch_without_protected_host_admission_receipt() {
    let fixture = v5_fixture(1, None);
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let signing_key = SigningKey::from_bytes(&[36; 32]);
    let authorities = trusted_authorities(&signing_key);
    let pinned_kernel = ActorKeyRef {
        public_key_hash: Some(public_key_hash(&signing_key.verifying_key())),
        ..kernel_signer()
    };

    for event in [
        &fixture.graph,
        &fixture.context_manifest,
        &fixture.worker_manifest,
        &fixture.sandbox_profile,
        &fixture.dispatch,
    ] {
        store
            .append_signed_with_checkpoint(
                event,
                &signing_key,
                &kernel_signer(),
                &bp_ledger::storage::sqlite::CheckpointPolicy::every(1),
            )
            .expect("append checkpointed kernel-signed V5 source evidence");
    }

    let recovery = TrustedGovernedRecoverySnapshot::open(
        &fixture.dispatch.run_id.to_string(),
        &db_path,
        &authorities,
        &pinned_kernel,
    );

    assert!(
        matches!(
            &recovery,
            Err(TrustedGovernedRecoveryError::NoSealedV3GovernedWorkflow)
        ),
        "expected V5 recovery to fail closed without admission evidence, got {recovery:?}"
    );
}

#[test]
fn trusted_recovery_exposes_v5_only_after_a_coherent_admission_receipt() {
    let fixture = v5_fixture(1, None);
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let source_signing_key = SigningKey::from_bytes(&[37; 32]);
    let admission_signing_key = SigningKey::from_bytes(&[38; 32]);
    let checkpoint_signing_key = SigningKey::from_bytes(&[39; 32]);
    let (admission_authority, authorities, source_signer, admission_signer, pinned_kernel) =
        protected_v5_admission_replay_authorities(
            &source_signing_key,
            &admission_signing_key,
            &checkpoint_signing_key,
            true,
        );
    append_signed_v5_source(&store, &fixture, &source_signing_key, &source_signer);
    let admission_event_id = record_and_seal_v5_admission(
        &store,
        &fixture,
        &admission_authority,
        &admission_signing_key,
        &admission_signer,
        &checkpoint_signing_key,
        &pinned_kernel,
    );

    let snapshot = TrustedGovernedRecoverySnapshot::open(
        &fixture.dispatch.run_id.to_string(),
        &db_path,
        &authorities,
        &pinned_kernel,
    )
    .expect("coherent admission receipt should make the V5 workflow recoverable");
    let workflow = snapshot
        .workflow_for_dispatch_event_ref(&fixture.dispatch.id.to_string())
        .expect("admission-gated V5 workflow is visible in trusted recovery");

    assert_eq!(workflow.phase, bp_replay::WorkflowPhaseV1::Dispatched);
    assert!(workflow.candidate.is_none());
    assert!(workflow.promotion.is_none());
    let receipt_state = workflow
        .v5_admission_receipt
        .as_ref()
        .expect("only immutable V5 admission evidence is projected");
    assert_eq!(receipt_state.event_id, admission_event_id);
    assert_eq!(
        receipt_state.source_dispatch_event_ref, fixture.dispatch.id,
        "the receipt remains bound to the exact V5 source dispatch"
    );
}

#[test]
fn trusted_recovery_rejects_v5_receipt_without_a_permitted_admission_signer() {
    let fixture = v5_fixture(1, None);
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let source_signing_key = SigningKey::from_bytes(&[40; 32]);
    let admission_signing_key = SigningKey::from_bytes(&[41; 32]);
    let checkpoint_signing_key = SigningKey::from_bytes(&[42; 32]);
    let (_admission_authority, authorities, source_signer, _admission_signer, pinned_kernel) =
        protected_v5_admission_replay_authorities(
            &source_signing_key,
            &admission_signing_key,
            &checkpoint_signing_key,
            false,
        );
    append_signed_v5_source(&store, &fixture, &source_signing_key, &source_signer);
    let receipt_event = v5_admission_receipt_event(&fixture);
    append_signed_v5_admission_receipt_directly_for_replay_test(
        &db_path,
        &receipt_event,
        &source_signing_key,
        &source_signer,
    );
    append_checkpointed_anchor_after_direct_v5_admission(
        &store,
        fixture.dispatch.run_id,
        &checkpoint_signing_key,
        &pinned_kernel,
    );

    let recovery = TrustedGovernedRecoverySnapshot::open(
        &fixture.dispatch.run_id.to_string(),
        &db_path,
        &authorities,
        &pinned_kernel,
    );

    match recovery {
        Err(TrustedGovernedRecoveryError::ReplayIssue {
            issue:
                ReplayIssue::UnauthorizedTrustSpineSigner {
                    event_id,
                    required_role,
                    event_kind,
                    signer_actor_id,
                    ..
                },
        }) => {
            assert_eq!(event_id, receipt_event.id);
            assert_eq!(required_role, "admission");
            assert_eq!(event_kind, "governed_dispatch_v5_admission_recorded_v1");
            assert_eq!(signer_actor_id.as_deref(), Some("kernel"));
        }
        other => {
            panic!("expected an unauthorized admission receipt to block recovery, got {other:?}")
        }
    }
}

#[test]
fn trusted_recovery_rejects_a_v5_receipt_with_a_tampered_source_dispatch_digest() {
    let fixture = v5_fixture(1, None);
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let source_signing_key = SigningKey::from_bytes(&[43; 32]);
    let admission_signing_key = SigningKey::from_bytes(&[44; 32]);
    let checkpoint_signing_key = SigningKey::from_bytes(&[45; 32]);
    let (_admission_authority, authorities, source_signer, admission_signer, pinned_kernel) =
        protected_v5_admission_replay_authorities(
            &source_signing_key,
            &admission_signing_key,
            &checkpoint_signing_key,
            true,
        );
    append_signed_v5_source(&store, &fixture, &source_signing_key, &source_signer);
    let mut receipt_event = v5_admission_receipt_event(&fixture);
    let Payload::GovernedDispatchV5AdmissionRecordedV1(receipt) = &mut receipt_event.payload else {
        unreachable!("V5 admission fixture event has the expected payload")
    };
    receipt.source_dispatch_event_digest = digest('f');
    append_signed_v5_admission_receipt_directly_for_replay_test(
        &db_path,
        &receipt_event,
        &admission_signing_key,
        &admission_signer,
    );
    append_checkpointed_anchor_after_direct_v5_admission(
        &store,
        fixture.dispatch.run_id,
        &checkpoint_signing_key,
        &pinned_kernel,
    );

    let recovery = TrustedGovernedRecoverySnapshot::open(
        &fixture.dispatch.run_id.to_string(),
        &db_path,
        &authorities,
        &pinned_kernel,
    );

    assert!(matches!(
        recovery,
        Err(TrustedGovernedRecoveryError::ReplayIssue {
            issue: ReplayIssue::WorkflowTransitionRejected {
                event_id,
                event_kind,
                reason,
                ..
            },
        }) if event_id == receipt_event.id
            && event_kind == "governed_dispatch_v5_admission_recorded_v1"
            && reason.contains("exact source dispatch authority")
    ));
}

#[test]
fn trusted_recovery_rejects_a_second_conflicting_v5_admission_receipt() {
    let fixture = v5_fixture(1, None);
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let source_signing_key = SigningKey::from_bytes(&[46; 32]);
    let admission_signing_key = SigningKey::from_bytes(&[47; 32]);
    let checkpoint_signing_key = SigningKey::from_bytes(&[48; 32]);
    let (_admission_authority, authorities, source_signer, admission_signer, pinned_kernel) =
        protected_v5_admission_replay_authorities(
            &source_signing_key,
            &admission_signing_key,
            &checkpoint_signing_key,
            true,
        );
    append_signed_v5_source(&store, &fixture, &source_signing_key, &source_signer);
    let first_receipt_event = v5_admission_receipt_event(&fixture);
    let second_receipt_event = v5_admission_receipt_event(&fixture);
    append_signed_v5_admission_receipt_directly_for_replay_test(
        &db_path,
        &first_receipt_event,
        &admission_signing_key,
        &admission_signer,
    );
    append_signed_v5_admission_receipt_directly_for_replay_test(
        &db_path,
        &second_receipt_event,
        &admission_signing_key,
        &admission_signer,
    );
    append_checkpointed_anchor_after_direct_v5_admission(
        &store,
        fixture.dispatch.run_id,
        &checkpoint_signing_key,
        &pinned_kernel,
    );

    let recovery = TrustedGovernedRecoverySnapshot::open(
        &fixture.dispatch.run_id.to_string(),
        &db_path,
        &authorities,
        &pinned_kernel,
    );

    assert!(matches!(
        recovery,
        Err(TrustedGovernedRecoveryError::ReplayIssue {
            issue: ReplayIssue::WorkflowTransitionRejected {
                event_id,
                event_kind,
                reason,
                ..
            },
        }) if event_id == second_receipt_event.id
            && event_kind == "governed_dispatch_v5_admission_recorded_v1"
            && reason.contains("conflicts with the existing immutable receipt evidence")
    ));
}

#[test]
fn replay_engine_binds_verified_kernel_signers_to_all_v5_manifest_witnesses() {
    let fixture = v5_fixture(1, None);
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let signing_key = SigningKey::from_bytes(&[31; 32]);
    let authorities = trusted_authorities(&signing_key);
    let run_id = fixture.graph.run_id.to_string();

    for event in [
        &fixture.graph,
        &fixture.context_manifest,
        &fixture.worker_manifest,
        &fixture.sandbox_profile,
        &fixture.dispatch,
    ] {
        store
            .append_signed(event, &signing_key, &kernel_signer())
            .expect("append kernel-signed V5 tape event");
    }

    let mut replay = ReplayEngine::open_with_trusted_authorities(&run_id, &db_path, &authorities)
        .expect("replay engine");
    assert_eq!(replay.by_ref().count(), 5);
    assert!(replay.state().issues.is_empty());
    let workflow = replay
        .state()
        .workflow_instances
        .values()
        .next()
        .expect("trusted V5 workflow projected");
    let witnesses = workflow
        .manifest_declarations
        .as_ref()
        .expect("trusted V5 workflow retains manifest witnesses");
    for signer in [
        witnesses.dispatch_verified_signer.as_ref(),
        witnesses.context_manifest.verified_signer.as_ref(),
        witnesses.worker_manifest.verified_signer.as_ref(),
        witnesses.sandbox_profile.verified_signer.as_ref(),
    ] {
        let signer = signer.expect("verified kernel signer retained on every V5 witness");
        assert_eq!(signer.actor_id, "kernel");
        assert_eq!(signer.key_id, "kernel-main");
        assert!(signer.public_key_hash.is_some());
    }
}

#[test]
fn replay_engine_rejects_a_non_kernel_v5_manifest_declaration() {
    let fixture = v5_fixture(1, None);
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let signing_key = SigningKey::from_bytes(&[32; 32]);
    let authorities = trusted_authorities(&signing_key);
    let run_id = fixture.graph.run_id.to_string();

    store
        .append_signed(&fixture.graph, &signing_key, &kernel_signer())
        .expect("append graph");
    store
        .append_signed(&fixture.context_manifest, &signing_key, &reviewer_signer())
        .expect("append reviewer-signed context declaration");
    for event in [
        &fixture.worker_manifest,
        &fixture.sandbox_profile,
        &fixture.dispatch,
    ] {
        store
            .append_signed(event, &signing_key, &kernel_signer())
            .expect("append kernel-signed V5 tape event");
    }

    let mut replay = ReplayEngine::open_with_trusted_authorities(&run_id, &db_path, &authorities)
        .expect("replay engine");
    assert_eq!(replay.by_ref().count(), 5);
    assert!(replay.state().workflow_instances.is_empty());
    assert!(replay.state().context_manifest_declarations.is_empty());
    assert!(replay.state().issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::UnauthorizedTrustSpineSigner {
            event_id,
            event_kind,
            required_role,
            signer_actor_id: Some(actor),
            ..
        } if *event_id == fixture.context_manifest.id
            && event_kind == "context_manifest_declared_v1"
            && required_role == "kernel"
            && actor == "reviewer"
    )));
}
