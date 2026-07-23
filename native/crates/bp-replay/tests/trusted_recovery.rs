use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::trust_spine::{
    dispatch_envelope_v3_body_digest, dispatch_envelope_v4_digest,
    governed_dispatch_policy_digest_v1, workflow_graph_v2_digest, ActionEvidenceVersionV1,
    ActionKindV1, ActionRequestedV2, CommitModeV1, DispatchBudgetV1, DispatchEnvelopeBodyV2,
    DispatchEnvelopeV3, DispatchEnvelopeV4, ExecutionRoleV1, TrustTierV1, WorkflowGraphDeclaredV2,
    WorkflowGraphNodeV2,
};
use bp_ledger::payload::Payload;
use bp_ledger::signing::{public_key_hash, ActorKeyRef, TrustedPublicKeys};
use bp_ledger::storage::sqlite::{CheckpointPolicy, SqliteStore};
use bp_replay::engine::{ReplayEngine, TrustSpineSignerRole, TrustedReplayAuthorities};
use bp_replay::{
    ReplayIssue, TrustedGovernedRecoveryError, TrustedGovernedRecoverySnapshot,
    VerifiedOtelProjectionErrorV1,
};
use chrono::{SecondsFormat, Utc};
use ed25519_dalek::SigningKey;
use tempfile::TempDir;

const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST_C: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const WORKFLOW_ID_SENTINEL: &str = "forbidden-workflow-id-sentinel";
const WORKFLOW_REVISION_SENTINEL: &str = "forbidden-workflow-revision-sentinel";
const UNIT_ID_SENTINEL: &str = "forbidden-unit-id-sentinel";
const ACTION_ID_SENTINEL: &str = "forbidden-action-id-sentinel";

fn kernel_signer() -> ActorKeyRef {
    ActorKeyRef {
        actor_id: "kernel".to_string(),
        key_id: "kernel-main".to_string(),
        public_key_hash: None,
    }
}

fn trusted_authorities(signing_key: &SigningKey) -> (TrustedReplayAuthorities, ActorKeyRef) {
    let hash = public_key_hash(&signing_key.verifying_key());
    let signer = ActorKeyRef {
        public_key_hash: Some(hash.clone()),
        ..kernel_signer()
    };
    let mut keys = TrustedPublicKeys::default();
    keys.insert_public_key(hash, signing_key.verifying_key().to_bytes().to_vec());
    let mut authorities = TrustedReplayAuthorities::new(keys);
    authorities.allow_signer(TrustSpineSignerRole::Kernel, signer.clone());
    (authorities, signer)
}

fn sealed_v3_dispatch() -> DispatchEnvelopeV3 {
    let body = DispatchEnvelopeBodyV2 {
        workflow_id: "workflow-1".to_string(),
        workflow_revision: "r1".to_string(),
        unit_id: "unit-1".to_string(),
        attempt: 1,
        execution_role: ExecutionRoleV1::Implementer,
        commit_mode: CommitModeV1::Atomic,
        provenance_ref: "admission:1".to_string(),
        base_commit_sha: "1".repeat(40),
        capability_bundle_digest: DIGEST_A.to_string(),
        acceptance_contract_digest: DIGEST_B.to_string(),
        context_manifest_digest: DIGEST_A.to_string(),
        worker_manifest_digest: DIGEST_B.to_string(),
        sandbox_profile_digest: DIGEST_C.to_string(),
        budget: DispatchBudgetV1 {
            max_tokens: Some(2_048),
            max_compute_time_ms: Some(60_000),
        },
        trust_tier: TrustTierV1::Governed,
        idempotency_key: "dispatch:workflow-1:unit-1:1".to_string(),
        issued_at: "2026-07-17T00:00:00Z".to_string(),
        expires_at: "2026-07-17T01:00:00Z".to_string(),
    };
    let action_evidence_version = ActionEvidenceVersionV1::SealedV3;
    let envelope_digest = dispatch_envelope_v3_body_digest(
        &body,
        action_evidence_version,
        DIGEST_A,
        DIGEST_B,
        Some(DIGEST_C),
    )
    .expect("canonical sealed V3 dispatch");
    DispatchEnvelopeV3 {
        body,
        action_evidence_version,
        repository_binding_digest: DIGEST_A.to_string(),
        ledger_authority_realm_digest: DIGEST_B.to_string(),
        governed_packet_digest: Some(DIGEST_C.to_string()),
        envelope_digest,
    }
}

fn sealed_v3_dispatch_with_identity_and_timestamps(
    workflow_id: &str,
    workflow_revision: &str,
    unit_id: &str,
    issued_at: &str,
    expires_at: &str,
) -> DispatchEnvelopeV3 {
    let mut dispatch = sealed_v3_dispatch();
    dispatch.body.workflow_id = workflow_id.to_string();
    dispatch.body.workflow_revision = workflow_revision.to_string();
    dispatch.body.unit_id = unit_id.to_string();
    dispatch.body.issued_at = issued_at.to_string();
    dispatch.body.expires_at = expires_at.to_string();
    dispatch.envelope_digest = dispatch_envelope_v3_body_digest(
        &dispatch.body,
        dispatch.action_evidence_version,
        &dispatch.repository_binding_digest,
        &dispatch.ledger_authority_realm_digest,
        dispatch.governed_packet_digest.as_deref(),
    )
    .expect("canonical sealed V3 dispatch with test identity");
    dispatch
}

fn dispatch_event(run_id: RunId) -> Event {
    dispatch_event_with(run_id, sealed_v3_dispatch())
}

fn dispatch_event_with(run_id: RunId, dispatch: DispatchEnvelopeV3) -> Event {
    Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::DispatchEnvelopeV3,
        occurred_at: Utc::now(),
        payload: Payload::DispatchEnvelopeV3(dispatch),
    }
}

fn action_request_event(
    run_id: RunId,
    dispatch_event: &Event,
    dispatch: &DispatchEnvelopeV3,
    action_id: &str,
) -> Event {
    let occurred_at = Utc::now();
    let request = ActionRequestedV2 {
        run_id: run_id.to_string(),
        workflow_id: dispatch.body.workflow_id.clone(),
        unit_id: dispatch.body.unit_id.clone(),
        attempt: dispatch.body.attempt,
        provenance_ref: dispatch.body.provenance_ref.clone(),
        action_id: action_id.to_string(),
        idempotency_key: "action:fixture:1".to_string(),
        action_kind: ActionKindV1::Process,
        canonical_input_digest: DIGEST_A.to_string(),
        canonical_input_ref: "cas:input:fixture".to_string(),
        dispatch_envelope_digest: dispatch.envelope_digest.clone(),
        repository_binding_digest: dispatch.repository_binding_digest.clone(),
        ledger_authority_realm_digest: dispatch.ledger_authority_realm_digest.clone(),
        governed_packet_digest: dispatch.governed_packet_digest.clone(),
        capability_bundle_digest: dispatch.body.capability_bundle_digest.clone(),
        policy_digest: governed_dispatch_policy_digest_v1(
            &dispatch.body.acceptance_contract_digest,
        )
        .expect("fixture dispatch has a canonical acceptance-contract digest"),
        context_manifest_digest: dispatch.body.context_manifest_digest.clone(),
        worker_manifest_digest: dispatch.body.worker_manifest_digest.clone(),
        sandbox_profile_digest: dispatch.body.sandbox_profile_digest.clone(),
        authority_actor: "kernel".to_string(),
        execution_role: dispatch.body.execution_role,
        requested_at: occurred_at.to_rfc3339_opts(SecondsFormat::Nanos, true),
    };
    Event {
        id: EventId::new(),
        run_id,
        parent_event_id: Some(dispatch_event.id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::ActionRequestedV2,
        occurred_at,
        payload: Payload::ActionRequestedV2(request),
    }
}

fn declared_graph_v2(run_id: RunId) -> WorkflowGraphDeclaredV2 {
    let dispatch = sealed_v3_dispatch();
    let mut graph = WorkflowGraphDeclaredV2 {
        run_id: run_id.to_string(),
        workflow_id: dispatch.body.workflow_id,
        workflow_revision: dispatch.body.workflow_revision,
        nodes: vec![WorkflowGraphNodeV2 {
            unit_id: dispatch.body.unit_id,
            depends_on: vec![],
            execution_role: dispatch.body.execution_role,
            governed_packet_digest: dispatch
                .governed_packet_digest
                .expect("sealed V3 fixture binds its packet"),
        }],
        max_concurrent: 1,
        graph_digest: String::new(),
        idempotency_key: "graph-v2:workflow-1:r1".to_string(),
        declared_at: "2026-07-19T00:00:00Z".to_string(),
    };
    graph.graph_digest = workflow_graph_v2_digest(&graph).expect("canonical V2 graph");
    graph
}

fn graph_declaration_event(run_id: RunId, graph: WorkflowGraphDeclaredV2) -> Event {
    Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::WorkflowGraphDeclaredV2,
        occurred_at: Utc::now(),
        payload: Payload::WorkflowGraphDeclaredV2(graph),
    }
}

fn graph_bound_v4_dispatch_event(
    run_id: RunId,
    graph_event_ref: EventId,
    graph_digest: String,
) -> Event {
    let dispatch_v3 = sealed_v3_dispatch();
    let mut dispatch = DispatchEnvelopeV4 {
        dispatch_v3,
        workflow_graph_digest: graph_digest,
        workflow_graph_declaration_event_ref: graph_event_ref,
        envelope_digest: String::new(),
    };
    dispatch.envelope_digest = dispatch_envelope_v4_digest(
        &dispatch.dispatch_v3,
        &dispatch.workflow_graph_digest,
        &dispatch.workflow_graph_declaration_event_ref,
    )
    .expect("canonical graph-bound V4 dispatch");
    Event {
        id: EventId::new(),
        run_id,
        parent_event_id: Some(graph_event_ref),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::DispatchEnvelopeV4,
        occurred_at: Utc::now(),
        payload: Payload::DispatchEnvelopeV4(dispatch),
    }
}

#[test]
fn trusted_recovery_rejects_a_pinned_kernel_that_lacks_kernel_authority() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let run_id = RunId::new();
    let pinned_kernel = ActorKeyRef {
        actor_id: "kernel".to_string(),
        key_id: "kernel-main".to_string(),
        public_key_hash: Some("sha256:pinned-key".to_string()),
    };

    let error = TrustedGovernedRecoverySnapshot::open(
        &run_id.to_string(),
        &db_path,
        &TrustedReplayAuthorities::new(TrustedPublicKeys::default()),
        &pinned_kernel,
    )
    .expect_err("an unregistered pinned signer cannot root governed recovery");

    assert!(matches!(
        error,
        TrustedGovernedRecoveryError::PinnedKernelSignerUnauthorized { .. }
    ));
}

#[test]
fn trusted_recovery_returns_only_a_fully_checkpointed_sealed_v3_workflow() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let signing_key = SigningKey::from_bytes(&[7; 32]);
    let (authorities, pinned_kernel) = trusted_authorities(&signing_key);
    let dispatch = dispatch_event(run_id);
    store
        .append_signed_with_checkpoint(
            &dispatch,
            &signing_key,
            &kernel_signer(),
            &CheckpointPolicy::every(1),
        )
        .expect("append checkpointed signed dispatch");

    let snapshot = TrustedGovernedRecoverySnapshot::open(
        &run_id.to_string(),
        &db_path,
        &authorities,
        &pinned_kernel,
    )
    .expect("fully checkpointed trusted V3 tape");

    assert_eq!(snapshot.run_id(), run_id.to_string());
    assert_eq!(
        snapshot
            .workflow_for_dispatch_event_ref(&dispatch.id.to_string())
            .expect("sealed V3 workflow")
            .dispatch
            .event_id,
        dispatch.id
    );
    assert_eq!(
        snapshot.tape_integrity().signed_non_checkpoint_event_count,
        1
    );
    assert!(snapshot.workflow_for_candidate_digest(DIGEST_A).is_none());
    assert!(snapshot
        .workflow_for_promotion_identity(DIGEST_A, "promotion:1")
        .is_none());
}

#[test]
fn trusted_recovery_projects_a_verified_redacted_otel_view() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let signing_key = SigningKey::from_bytes(&[16; 32]);
    let (authorities, pinned_kernel) = trusted_authorities(&signing_key);
    let dispatch = dispatch_event(run_id);
    store
        .append_signed_with_checkpoint(
            &dispatch,
            &signing_key,
            &kernel_signer(),
            &CheckpointPolicy::every(1),
        )
        .expect("append checkpointed signed dispatch");

    let snapshot = TrustedGovernedRecoverySnapshot::open(
        &run_id.to_string(),
        &db_path,
        &authorities,
        &pinned_kernel,
    )
    .expect("fully checkpointed trusted V3 tape");

    let projection = snapshot
        .verified_otel_projection_v1()
        .expect("project a verified redacted OTel view");
    let encoded = serde_json::to_value(projection).expect("serialize verified OTel projection");

    assert_eq!(encoded["schema_version"], 1);
    assert_eq!(encoded["authority"]["tape"], "verified");
    assert_eq!(encoded["authority"]["export"], "none");
    assert_eq!(
        encoded["resource"]["tape_integrity"]["signed_non_checkpoint_event_count"],
        "1"
    );
    assert_eq!(encoded["spans"].as_array().map(Vec::len), Some(1));
    assert_eq!(encoded["spans"][0]["name"], "buildplane.workflow");
    assert_eq!(
        encoded["spans"][0]["attributes"]["workflow"]["dispatch_event_ref"],
        dispatch.id.to_string()
    );
    assert_eq!(
        encoded["spans"][0]["attributes"]["workflow"]["context_manifest_digest"],
        DIGEST_A
    );
    assert!(!encoded.to_string().contains("admission:1"));
    assert!(!encoded.to_string().contains(&"1".repeat(40)));
    assert!(!encoded.to_string().contains("dispatch:workflow-1:unit-1:1"));
}

#[test]
fn trusted_recovery_otel_projection_never_serializes_opaque_workflow_or_action_ids() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let signing_key = SigningKey::from_bytes(&[24; 32]);
    let (authorities, pinned_kernel) = trusted_authorities(&signing_key);
    let dispatch = sealed_v3_dispatch_with_identity_and_timestamps(
        WORKFLOW_ID_SENTINEL,
        WORKFLOW_REVISION_SENTINEL,
        UNIT_ID_SENTINEL,
        "2026-07-17T00:00:00Z",
        "2026-07-17T01:00:00Z",
    );
    let dispatch_event = dispatch_event_with(run_id, dispatch.clone());
    let action_event = action_request_event(run_id, &dispatch_event, &dispatch, ACTION_ID_SENTINEL);

    store
        .append_signed_with_checkpoint(
            &dispatch_event,
            &signing_key,
            &kernel_signer(),
            &CheckpointPolicy::every(1),
        )
        .expect("append checkpointed signed dispatch");
    store
        .append_signed_with_checkpoint(
            &action_event,
            &signing_key,
            &kernel_signer(),
            &CheckpointPolicy::every(1),
        )
        .expect("append checkpointed signed action request");

    let snapshot = TrustedGovernedRecoverySnapshot::open(
        &run_id.to_string(),
        &db_path,
        &authorities,
        &pinned_kernel,
    )
    .expect("fully checkpointed trusted V3 tape with a governed action");
    let projection = snapshot
        .verified_otel_projection_v1()
        .expect("project a verified redacted OTel view");
    let encoded = serde_json::to_string(&projection).expect("serialize verified OTel projection");

    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&encoded).expect("read projection JSON")["spans"]
            .as_array()
            .map(Vec::len),
        Some(2),
        "the signed fixture must project both workflow and action spans"
    );
    for forbidden in [
        WORKFLOW_ID_SENTINEL,
        WORKFLOW_REVISION_SENTINEL,
        UNIT_ID_SENTINEL,
        ACTION_ID_SENTINEL,
    ] {
        assert!(
            !encoded.contains(forbidden),
            "verified OTel projection leaked an arbitrary opaque identifier: {forbidden}"
        );
    }
}

#[test]
fn trusted_recovery_otel_projection_fails_closed_for_a_valid_out_of_range_timestamp() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let signing_key = SigningKey::from_bytes(&[25; 32]);
    let (authorities, pinned_kernel) = trusted_authorities(&signing_key);
    let dispatch = sealed_v3_dispatch_with_identity_and_timestamps(
        "workflow-1",
        "r1",
        "unit-1",
        "2263-01-01T00:00:00Z",
        "2263-01-01T01:00:00Z",
    );
    let dispatch_event = dispatch_event_with(run_id, dispatch);
    store
        .append_signed_with_checkpoint(
            &dispatch_event,
            &signing_key,
            &kernel_signer(),
            &CheckpointPolicy::every(1),
        )
        .expect("append checkpointed signed out-of-range dispatch");

    let snapshot = TrustedGovernedRecoverySnapshot::open(
        &run_id.to_string(),
        &db_path,
        &authorities,
        &pinned_kernel,
    )
    .expect("trusted replay must open a valid RFC3339 tape before OTel projection");
    let error = snapshot
        .verified_otel_projection_v1()
        .expect_err("an out-of-range OTel timestamp must fail closed");

    assert_eq!(
        error,
        VerifiedOtelProjectionErrorV1::TimestampOutsideOpenTelemetryRange
    );
    assert!(!error.to_string().contains("2263"));
}

#[test]
fn trusted_recovery_returns_a_fully_checkpointed_graph_bound_v4_workflow() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let signing_key = SigningKey::from_bytes(&[12; 32]);
    let (authorities, pinned_kernel) = trusted_authorities(&signing_key);
    let graph = declared_graph_v2(run_id);
    let graph_event = graph_declaration_event(run_id, graph.clone());

    store
        .append_signed_with_checkpoint(
            &graph_event,
            &signing_key,
            &kernel_signer(),
            &CheckpointPolicy::every(1),
        )
        .expect("append checkpointed V2 graph declaration");
    let dispatch =
        graph_bound_v4_dispatch_event(run_id, graph_event.id, graph.graph_digest.clone());
    store
        .append_signed_with_checkpoint(
            &dispatch,
            &signing_key,
            &kernel_signer(),
            &CheckpointPolicy::every(1),
        )
        .expect("append checkpointed graph-bound V4 dispatch");

    let snapshot = TrustedGovernedRecoverySnapshot::open(
        &run_id.to_string(),
        &db_path,
        &authorities,
        &pinned_kernel,
    )
    .expect("trusted replay must retain a validated V4 graph binding");
    let workflow = snapshot
        .workflow_for_dispatch_event_ref(&dispatch.id.to_string())
        .expect("validated graph-bound V4 workflow");

    assert_eq!(workflow.dispatch.dispatch_version, 4);
    assert_eq!(
        workflow.dispatch.workflow_graph_digest.as_deref(),
        Some(graph.graph_digest.as_str())
    );
    assert_eq!(
        workflow.dispatch.workflow_graph_declaration_event_ref,
        Some(graph_event.id)
    );
}

#[test]
fn trusted_recovery_rejects_a_signed_v4_dispatch_without_a_prior_graph_declaration() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let signing_key = SigningKey::from_bytes(&[13; 32]);
    let (authorities, pinned_kernel) = trusted_authorities(&signing_key);
    let dispatch = graph_bound_v4_dispatch_event(run_id, EventId::new(), DIGEST_A.to_string());

    store
        .append_signed_with_checkpoint(
            &dispatch,
            &signing_key,
            &kernel_signer(),
            &CheckpointPolicy::every(1),
        )
        .expect("append self-consistent V4 dispatch without its graph");

    let error = TrustedGovernedRecoverySnapshot::open(
        &run_id.to_string(),
        &db_path,
        &authorities,
        &pinned_kernel,
    )
    .expect_err("a missing graph declaration must not become recovery authority");

    assert!(matches!(
        error,
        TrustedGovernedRecoveryError::ReplayIssue {
            issue: ReplayIssue::WorkflowTransitionRejected { reason, .. }
        } if reason.contains("requires a previously declared V2 workflow graph")
    ));
}

#[test]
fn trusted_recovery_rejects_an_uncheckpointed_signed_tail() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let signing_key = SigningKey::from_bytes(&[8; 32]);
    let (authorities, pinned_kernel) = trusted_authorities(&signing_key);
    let dispatch = dispatch_event(run_id);
    store
        .append_signed(&dispatch, &signing_key, &kernel_signer())
        .expect("append signed dispatch without checkpoint");

    let error = TrustedGovernedRecoverySnapshot::open(
        &run_id.to_string(),
        &db_path,
        &authorities,
        &pinned_kernel,
    )
    .expect_err("uncheckpointed signed tail must not expose recovery authority");

    assert!(matches!(
        error,
        TrustedGovernedRecoveryError::TapeIntegrity(_)
    ));
}

#[test]
fn trusted_recovery_rejects_a_tape_signed_by_an_untrusted_kernel_key() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let tape_key = SigningKey::from_bytes(&[9; 32]);
    let trusted_key = SigningKey::from_bytes(&[10; 32]);
    let (authorities, pinned_kernel) = trusted_authorities(&trusted_key);
    let dispatch = dispatch_event(run_id);
    store
        .append_signed_with_checkpoint(
            &dispatch,
            &tape_key,
            &kernel_signer(),
            &CheckpointPolicy::every(1),
        )
        .expect("append differently signed tape");

    let error = TrustedGovernedRecoverySnapshot::open(
        &run_id.to_string(),
        &db_path,
        &authorities,
        &pinned_kernel,
    )
    .expect_err("unknown tape signature must not expose recovery authority");

    assert!(matches!(
        error,
        TrustedGovernedRecoveryError::ReplayIssue { .. }
    ));
}

#[test]
fn trusted_recovery_rejects_a_graph_bound_v4_dispatch_signed_by_an_unauthorized_kernel() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let trusted_key = SigningKey::from_bytes(&[14; 32]);
    let unauthorized_key = SigningKey::from_bytes(&[15; 32]);
    let (authorities, pinned_kernel) = trusted_authorities(&trusted_key);
    let graph = declared_graph_v2(run_id);
    let graph_event = graph_declaration_event(run_id, graph.clone());

    store
        .append_signed_with_checkpoint(
            &graph_event,
            &trusted_key,
            &kernel_signer(),
            &CheckpointPolicy::every(1),
        )
        .expect("append trusted V2 graph declaration");
    let dispatch =
        graph_bound_v4_dispatch_event(run_id, graph_event.id, graph.graph_digest.clone());
    store
        .append_signed_with_checkpoint(
            &dispatch,
            &unauthorized_key,
            &kernel_signer(),
            &CheckpointPolicy::every(1),
        )
        .expect("append V4 dispatch signed by a different key");

    let error = TrustedGovernedRecoverySnapshot::open(
        &run_id.to_string(),
        &db_path,
        &authorities,
        &pinned_kernel,
    )
    .expect_err("an unauthorized V4 signer must not yield recovery authority");

    assert!(matches!(
        error,
        TrustedGovernedRecoveryError::ReplayIssue {
            issue: ReplayIssue::UnverifiedTrustSpineEvent { .. }
                | ReplayIssue::UnauthorizedTrustSpineSigner { .. }
        }
    ));
}

#[test]
fn legacy_v3_replay_remains_readable_but_cannot_become_governed_recovery_authority() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let signing_key = SigningKey::from_bytes(&[11; 32]);
    let (authorities, pinned_kernel) = trusted_authorities(&signing_key);
    let mut legacy_dispatch = sealed_v3_dispatch();
    legacy_dispatch.action_evidence_version = ActionEvidenceVersionV1::SealedV2;
    legacy_dispatch.governed_packet_digest = None;
    legacy_dispatch.envelope_digest = dispatch_envelope_v3_body_digest(
        &legacy_dispatch.body,
        legacy_dispatch.action_evidence_version,
        &legacy_dispatch.repository_binding_digest,
        &legacy_dispatch.ledger_authority_realm_digest,
        None,
    )
    .expect("canonical legacy V3 dispatch");
    let dispatch = dispatch_event_with(run_id, legacy_dispatch);
    store
        .append_signed_with_checkpoint(
            &dispatch,
            &signing_key,
            &kernel_signer(),
            &CheckpointPolicy::every(1),
        )
        .expect("append checkpointed legacy V3 dispatch");

    let mut legacy_replay =
        ReplayEngine::open_with_trusted_authorities(&run_id.to_string(), &db_path, &authorities)
            .expect("legacy replay remains available");
    assert_eq!(legacy_replay.by_ref().count(), 2);
    assert!(legacy_replay.state().workflow_instance.is_some());

    let error = TrustedGovernedRecoverySnapshot::open(
        &run_id.to_string(),
        &db_path,
        &authorities,
        &pinned_kernel,
    )
    .expect_err("legacy V3 evidence cannot grant sealed V3 governed recovery authority");
    assert!(matches!(
        error,
        TrustedGovernedRecoveryError::NoSealedV3GovernedWorkflow
    ));
}
