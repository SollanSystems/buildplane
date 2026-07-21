use crate::activity_decision::classify_replayed_governed_action_v1;
use crate::state::{ModelActionAuthorizationReplayState, ModelActionIntentReplayState};
use crate::{
    ActionDecisionBlockReasonV1, ActionDecisionDispositionV1, ActionEvidenceReplayState,
    ActionReceiptReplayState, ActionReplayState, ActionRequestReplayState,
    ActivityClaimReplayState, ActivityResultReplayState, RecordedActionDecisionQueryV1,
    RecordedActionDecisionV1, RecordedActionIdentityV1, WorkflowDispatchReplayState,
    WorkflowInstanceV1, WorkflowPhaseV1,
};
use bp_ledger::id::EventId;
use bp_ledger::payload::activity_claim::ActivityResultOutcomeV1;
use bp_ledger::payload::trust_spine::{
    ActionEvidenceVersionV1, ActionKindV1, ActionReceiptOutcomeV2, ActionResourceUsageV1,
    DispatchBudgetV1, ExecutionRoleV1, ModelRequestEvidenceV1, TrustScopeEvidenceV1, TrustTierV1,
};
use bp_ledger::signing::ActorKeyRef;
use std::collections::BTreeMap;

const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

struct Fixture {
    workflow: WorkflowInstanceV1,
    query: RecordedActionDecisionQueryV1,
}

fn fixture(result: Option<ActivityResultOutcomeV1>) -> Fixture {
    let dispatch_event_id = EventId::new();
    let action_request_event_id = EventId::new();
    let claim_event_id = EventId::new();
    let action_id = "action-1".to_string();
    let idempotency_key = "action-key-1".to_string();
    let request = ActionRequestReplayState {
        event_id: action_request_event_id,
        action_id: action_id.clone(),
        idempotency_key: idempotency_key.clone(),
        action_kind: ActionKindV1::Process,
        canonical_input_digest: DIGEST_A.into(),
        canonical_input_ref: "cas:input-1".into(),
        repository_binding_digest: DIGEST_A.into(),
        ledger_authority_realm_digest: DIGEST_B.into(),
        governed_packet_digest: Some(DIGEST_A.into()),
        policy_digest: DIGEST_B.into(),
        authority_actor: "kernel".into(),
        execution_role: ExecutionRoleV1::Implementer,
        requested_at: "2026-07-20T00:00:00Z".into(),
        action_request_digest: DIGEST_A.into(),
    };
    let activity_result = result.map(|outcome| ActivityResultReplayState {
        event_id: EventId::new(),
        event_digest: DIGEST_B.into(),
        run_id: "run-1".into(),
        activity_id: action_id.clone(),
        idempotency_key: idempotency_key.clone(),
        claim_event_id,
        claim_event_digest: DIGEST_B.into(),
        lease_id: "lease-1".into(),
        outcome,
        result_digest: (outcome == ActivityResultOutcomeV1::Succeeded).then(|| DIGEST_A.into()),
        result_ref: (outcome == ActivityResultOutcomeV1::Succeeded).then(|| "cas:result-1".into()),
        evidence_digest: DIGEST_B.into(),
        evidence_ref: "cas:evidence-1".into(),
        recorded_at: "2026-07-20T00:01:00Z".into(),
    });
    let claim = ActivityClaimReplayState {
        event_id: claim_event_id,
        claim_event_digest: DIGEST_B.into(),
        run_id: "run-1".into(),
        activity_id: action_id.clone(),
        idempotency_key: idempotency_key.clone(),
        action_kind: ActionKindV1::Process,
        action_request_event_id,
        action_request_digest: DIGEST_A.into(),
        dispatch_event_id,
        dispatch_envelope_digest: DIGEST_B.into(),
        authority_actor: "kernel".into(),
        lease_id: "lease-1".into(),
        lease_expires_at: "2026-07-20T00:10:00Z".into(),
        claimed_at: "2026-07-20T00:00:01Z".into(),
        signer: Some(ActorKeyRef {
            actor_id: "kernel".into(),
            key_id: "kernel-main".into(),
            public_key_hash: Some(DIGEST_A.into()),
        }),
        heartbeats: vec![],
        result: activity_result,
    };
    let identity = RecordedActionIdentityV1 {
        run_id: "run-1".into(),
        workflow_id: "workflow-1".into(),
        workflow_revision: "revision-1".into(),
        unit_id: "unit-1".into(),
        attempt: 1,
        dispatch_event_ref: dispatch_event_id.to_string(),
        dispatch_envelope_digest: DIGEST_B.into(),
        action_id: action_id.clone(),
        idempotency_key: idempotency_key.clone(),
        action_request_event_ref: action_request_event_id.to_string(),
        action_request_digest: DIGEST_A.into(),
        activity_claim_event_ref: claim_event_id.to_string(),
        activity_claim_event_digest: DIGEST_B.into(),
        lease_id: "lease-1".into(),
    };
    let mut actions = BTreeMap::new();
    actions.insert(
        action_id,
        ActionReplayState {
            request,
            model_intent: None,
            model_authorization: None,
            activity_claim: Some(claim),
            receipt: None,
        },
    );
    Fixture {
        workflow: WorkflowInstanceV1 {
            run_id: "run-1".into(),
            workflow_id: "workflow-1".into(),
            workflow_revision: "revision-1".into(),
            unit_id: "unit-1".into(),
            attempt: 1,
            phase: WorkflowPhaseV1::Dispatched,
            dispatch: WorkflowDispatchReplayState {
                dispatch_version: 3,
                event_id: dispatch_event_id,
                envelope_digest: DIGEST_B.into(),
                provenance_ref: "provenance:1".into(),
                base_commit_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
                repository_binding_digest: Some(DIGEST_A.into()),
                ledger_authority_realm_digest: Some(DIGEST_B.into()),
                governed_packet_digest: Some(DIGEST_A.into()),
                workflow_graph_digest: None,
                workflow_graph_declaration_event_ref: None,
                capability_bundle_digest: DIGEST_A.into(),
                acceptance_contract_digest: DIGEST_B.into(),
                context_manifest_digest: DIGEST_A.into(),
                worker_manifest_digest: DIGEST_B.into(),
                sandbox_profile_digest: DIGEST_A.into(),
                execution_role: ExecutionRoleV1::Implementer,
                commit_mode: bp_ledger::payload::trust_spine::CommitModeV1::Atomic,
                budget: DispatchBudgetV1 {
                    max_tokens: Some(100),
                    max_compute_time_ms: None,
                },
                trust_tier: TrustTierV1::Governed,
                idempotency_key: "dispatch-key-1".into(),
                issued_at: "2026-07-20T00:00:00Z".into(),
                expires_at: "2026-07-20T01:00:00Z".into(),
                signature_ref: None,
                action_evidence_version: Some(ActionEvidenceVersionV1::SealedV3),
            },
            action_evidence: Some(ActionEvidenceReplayState {
                action_evidence_version: ActionEvidenceVersionV1::SealedV3,
                actions,
                sealed_receipt_set: None,
                pending_action_ids: vec!["action-1".into()],
                unknown_action_ids: vec![],
                failed_action_ids: vec![],
            }),
            retry_context: None,
            timers: BTreeMap::new(),
            cancellation: None,
            candidate: None,
            candidate_completion: None,
            acceptance: None,
            reviews: BTreeMap::new(),
            promotion_approval: None,
            promotion: None,
            terminal: None,
        },
        query: RecordedActionDecisionQueryV1 {
            schema_version: 1,
            identity,
            observed_at: "2026-07-20T00:05:00Z".into(),
        },
    }
}

fn model_success_fixture(
    intent_at: &str,
    authorization_at: &str,
    authorization_expires_at: &str,
    include_matching_receipt: bool,
) -> Fixture {
    let mut fixture = fixture(Some(ActivityResultOutcomeV1::Succeeded));
    let dispatch = fixture.workflow.dispatch.clone();
    let action = fixture
        .workflow
        .action_evidence
        .as_mut()
        .expect("fixture has action evidence")
        .actions
        .get_mut("action-1")
        .expect("fixture has the action");
    action.request.action_kind = ActionKindV1::Model;
    let claim = action
        .activity_claim
        .as_mut()
        .expect("successful fixture has a claim");
    claim.action_kind = ActionKindV1::Model;
    claim.claimed_at = "2026-07-20T00:00:50Z".into();
    let result = claim
        .result
        .clone()
        .expect("successful fixture has a result");
    let intent_event_id = EventId::new();
    action.model_intent = Some(ModelActionIntentReplayState {
        event_id: intent_event_id,
        dispatch_event_ref: dispatch.event_id,
        dispatch_envelope_digest: dispatch.envelope_digest.clone(),
        action_request_event_ref: action.request.event_id,
        action_request_digest: action.request.action_request_digest.clone(),
        canonical_input_ref: action.request.canonical_input_ref.clone(),
        canonical_input_digest: action.request.canonical_input_digest.clone(),
        model_request_evidence: ModelRequestEvidenceV1 {
            schema_version: 1,
            cas_ref: "cas:model-request-1".into(),
            digest: DIGEST_A.into(),
        },
        trust_scope_evidence: TrustScopeEvidenceV1 {
            schema_version: 1,
            cas_ref: "cas:trust-scope-1".into(),
            digest: DIGEST_B.into(),
        },
        candidate_binding: None,
        intent_actor: "kernel".into(),
        intended_at: intent_at.into(),
        intent_digest: DIGEST_A.into(),
    });
    action.model_authorization = Some(ModelActionAuthorizationReplayState {
        event_id: EventId::new(),
        authorized_at: Some(authorization_at.into()),
        authorization_version: 2,
        intent_event_ref: Some(intent_event_id),
        intent_digest: Some(DIGEST_A.into()),
        dispatch_event_ref: dispatch.event_id.to_string(),
        dispatch_envelope_digest: dispatch.envelope_digest,
        action_request_ref: action.request.event_id.to_string(),
        action_request_digest: action.request.action_request_digest.clone(),
        packet_digest: dispatch
            .governed_packet_digest
            .expect("fixture dispatch binds a governed packet"),
        canonical_input_digest: action.request.canonical_input_digest.clone(),
        model_request_digest: DIGEST_A.into(),
        model_request_evidence_ref: Some("cas:model-request-1".into()),
        model_request_evidence_schema_version: Some(1),
        trust_scope_digest: DIGEST_B.into(),
        trust_scope_evidence_ref: Some("cas:trust-scope-1".into()),
        trust_scope_evidence_schema_version: Some(1),
        context_manifest_digest: dispatch.context_manifest_digest,
        policy_digest: action.request.policy_digest.clone(),
        sandbox_profile_digest: dispatch.sandbox_profile_digest,
        execution_role: action.request.execution_role,
        candidate_digest: None,
        candidate_view_digest: None,
        candidate_binding: None,
        authorization_actor: "kernel".into(),
        expires_at: authorization_expires_at.into(),
        authorization_ref: "authorization:1".into(),
        authorization_digest: DIGEST_B.into(),
    });
    if include_matching_receipt {
        action.receipt = Some(ActionReceiptReplayState {
            event_id: EventId::new(),
            action_id: action.request.action_id.clone(),
            idempotency_key: action.request.idempotency_key.clone(),
            action_request_digest: action.request.action_request_digest.clone(),
            outcome: ActionReceiptOutcomeV2::Succeeded,
            result_digest: result.result_digest,
            result_ref: result.result_ref,
            evidence_digest: result.evidence_digest,
            evidence_ref: result.evidence_ref,
            resource_usage: ActionResourceUsageV1 {
                wall_time_ms: 0,
                cpu_time_ms: None,
                peak_memory_bytes: None,
                input_bytes: None,
                output_bytes: None,
                input_tokens: None,
                output_tokens: None,
            },
            redactions: vec![],
            failure: None,
            authorization_ref: Some("authorization:1".into()),
            action_receipt_ref: "receipt:1".into(),
            action_receipt_digest: DIGEST_A.into(),
            completed_at: "2026-07-20T00:01:00Z".into(),
        });
    }
    fixture
}

#[test]
fn sealed_successful_activity_result_is_reused_without_authorizing_another_effect() {
    let Fixture { workflow, query } = fixture(Some(ActivityResultOutcomeV1::Succeeded));

    let decision = classify_replayed_governed_action_v1(&workflow, &query);

    assert_eq!(
        decision.disposition,
        ActionDecisionDispositionV1::ReuseRecordedResult
    );
    assert_eq!(
        decision
            .result
            .as_ref()
            .map(|result| result.result_ref.as_str()),
        Some("cas:result-1")
    );
    assert!(decision.reason.is_none());
}

#[test]
fn active_claim_without_terminal_result_waits_instead_of_issuing_an_effect() {
    let Fixture { workflow, query } = fixture(None);

    let decision = classify_replayed_governed_action_v1(&workflow, &query);

    assert_eq!(
        decision.disposition,
        ActionDecisionDispositionV1::WaitForActiveLease
    );
    assert_eq!(
        decision.effective_lease_expires_at.as_deref(),
        Some("2026-07-20T00:10:00Z")
    );
}

#[test]
fn expired_claim_without_terminal_result_requires_reconciliation_not_retry() {
    let Fixture {
        workflow,
        mut query,
    } = fixture(None);
    query.observed_at = "2026-07-20T00:10:00Z".into();

    let decision = classify_replayed_governed_action_v1(&workflow, &query);

    assert_eq!(
        decision.disposition,
        ActionDecisionDispositionV1::ReconciliationRequired
    );
    assert_eq!(
        decision.reason,
        Some(ActionDecisionBlockReasonV1::LeaseExpired)
    );
}

#[test]
fn unknown_terminal_result_requires_reconciliation() {
    let Fixture { workflow, query } = fixture(Some(ActivityResultOutcomeV1::Unknown));

    let decision = classify_replayed_governed_action_v1(&workflow, &query);

    assert_eq!(
        decision.disposition,
        ActionDecisionDispositionV1::ReconciliationRequired
    );
    assert_eq!(
        decision.reason,
        Some(ActionDecisionBlockReasonV1::UnknownTerminalState)
    );
}

#[test]
fn failed_terminal_result_is_never_presented_as_retryable_work() {
    let Fixture { workflow, query } = fixture(Some(ActivityResultOutcomeV1::Failed));

    let decision = classify_replayed_governed_action_v1(&workflow, &query);

    assert_eq!(
        decision.disposition,
        ActionDecisionDispositionV1::TerminalFailure
    );
    assert_eq!(
        decision.reason,
        Some(ActionDecisionBlockReasonV1::TerminalFailure)
    );
}

#[test]
fn stale_claim_identity_and_missing_action_fail_closed() {
    let Fixture {
        workflow,
        mut query,
    } = fixture(None);
    query.identity.activity_claim_event_digest = DIGEST_A.into();

    let stale = classify_replayed_governed_action_v1(&workflow, &query);

    assert_eq!(stale.disposition, ActionDecisionDispositionV1::Blocked);
    assert_eq!(
        stale.reason,
        Some(ActionDecisionBlockReasonV1::ClaimIdentityMismatch)
    );

    query.identity.activity_claim_event_digest = DIGEST_B.into();
    query.identity.action_id = "missing-action".into();
    let missing = classify_replayed_governed_action_v1(&workflow, &query);
    assert_eq!(missing.disposition, ActionDecisionDispositionV1::Blocked);
    assert_eq!(
        missing.reason,
        Some(ActionDecisionBlockReasonV1::ActionNotFound)
    );
}

#[test]
fn missing_action_evidence_or_claim_is_blocked_without_creating_a_lease() {
    let Fixture {
        mut workflow,
        query,
    } = fixture(None);
    workflow.action_evidence = None;

    let no_evidence = classify_replayed_governed_action_v1(&workflow, &query);
    assert_eq!(
        no_evidence.disposition,
        ActionDecisionDispositionV1::Blocked
    );
    assert_eq!(
        no_evidence.reason,
        Some(ActionDecisionBlockReasonV1::MissingActionEvidence)
    );

    let Fixture {
        mut workflow,
        query,
    } = fixture(None);
    workflow
        .action_evidence
        .as_mut()
        .expect("fixture has evidence")
        .actions
        .get_mut("action-1")
        .expect("fixture has action")
        .activity_claim = None;
    let no_claim = classify_replayed_governed_action_v1(&workflow, &query);
    assert_eq!(no_claim.disposition, ActionDecisionDispositionV1::Blocked);
    assert_eq!(
        no_claim.reason,
        Some(ActionDecisionBlockReasonV1::ClaimMissing)
    );
}

#[test]
fn model_claim_without_its_native_intent_and_authorization_is_blocked() {
    let Fixture {
        mut workflow,
        query,
    } = fixture(None);
    let action = workflow
        .action_evidence
        .as_mut()
        .expect("fixture has evidence")
        .actions
        .get_mut("action-1")
        .expect("fixture has action");
    action.request.action_kind = ActionKindV1::Model;
    action
        .activity_claim
        .as_mut()
        .expect("fixture has claim")
        .action_kind = ActionKindV1::Model;

    let decision = classify_replayed_governed_action_v1(&workflow, &query);

    assert_eq!(decision.disposition, ActionDecisionDispositionV1::Blocked);
    assert_eq!(
        decision.reason,
        Some(ActionDecisionBlockReasonV1::MalformedEvidence)
    );
}

#[test]
fn model_success_with_a_post_result_intent_is_not_reused() {
    let Fixture { workflow, query } = model_success_fixture(
        "2026-07-20T00:02:00Z",
        "2026-07-20T00:02:30Z",
        "2026-07-20T00:10:00Z",
        true,
    );

    let decision = classify_replayed_governed_action_v1(&workflow, &query);

    assert_eq!(decision.disposition, ActionDecisionDispositionV1::Blocked);
    assert_eq!(
        decision.reason,
        Some(ActionDecisionBlockReasonV1::MalformedEvidence)
    );
}

#[test]
fn model_success_with_a_pre_write_ahead_intent_is_not_reused() {
    let Fixture { workflow, query } = model_success_fixture(
        "2026-07-19T23:59:59Z",
        "2026-07-20T00:00:40Z",
        "2026-07-20T00:10:00Z",
        true,
    );

    let decision = classify_replayed_governed_action_v1(&workflow, &query);

    assert_eq!(decision.disposition, ActionDecisionDispositionV1::Blocked);
    assert_eq!(
        decision.reason,
        Some(ActionDecisionBlockReasonV1::MalformedEvidence)
    );
}

#[test]
fn model_success_with_a_post_result_authorization_is_not_reused() {
    let Fixture { workflow, query } = model_success_fixture(
        "2026-07-20T00:00:30Z",
        "2026-07-20T00:02:00Z",
        "2026-07-20T00:10:00Z",
        true,
    );

    let decision = classify_replayed_governed_action_v1(&workflow, &query);

    assert_eq!(decision.disposition, ActionDecisionDispositionV1::Blocked);
    assert_eq!(
        decision.reason,
        Some(ActionDecisionBlockReasonV1::MalformedEvidence)
    );
}

#[test]
fn model_success_with_a_pre_authorization_receipt_is_not_reused() {
    let Fixture {
        mut workflow,
        query,
    } = model_success_fixture(
        "2026-07-20T00:00:30Z",
        "2026-07-20T00:00:40Z",
        "2026-07-20T00:10:00Z",
        true,
    );
    workflow
        .action_evidence
        .as_mut()
        .expect("fixture has evidence")
        .actions
        .get_mut("action-1")
        .expect("fixture has action")
        .receipt
        .as_mut()
        .expect("fixture has receipt")
        .completed_at = "2026-07-20T00:00:39.999999Z".into();

    let decision = classify_replayed_governed_action_v1(&workflow, &query);

    assert_eq!(decision.disposition, ActionDecisionDispositionV1::Blocked);
    assert_eq!(
        decision.reason,
        Some(ActionDecisionBlockReasonV1::MalformedEvidence)
    );
}

#[test]
fn model_success_with_a_pre_claim_receipt_is_not_reused() {
    let Fixture {
        mut workflow,
        query,
    } = model_success_fixture(
        "2026-07-20T00:00:30Z",
        "2026-07-20T00:00:40Z",
        "2026-07-20T00:10:00Z",
        true,
    );
    workflow
        .action_evidence
        .as_mut()
        .expect("fixture has evidence")
        .actions
        .get_mut("action-1")
        .expect("fixture has action")
        .receipt
        .as_mut()
        .expect("fixture has receipt")
        .completed_at = "2026-07-20T00:00:49.999999Z".into();

    let decision = classify_replayed_governed_action_v1(&workflow, &query);

    assert_eq!(decision.disposition, ActionDecisionDispositionV1::Blocked);
    assert_eq!(
        decision.reason,
        Some(ActionDecisionBlockReasonV1::MalformedEvidence)
    );
}

#[test]
fn model_success_with_a_post_result_receipt_is_not_reused() {
    let Fixture {
        mut workflow,
        query,
    } = model_success_fixture(
        "2026-07-20T00:00:30Z",
        "2026-07-20T00:00:40Z",
        "2026-07-20T00:10:00Z",
        true,
    );
    workflow
        .action_evidence
        .as_mut()
        .expect("fixture has evidence")
        .actions
        .get_mut("action-1")
        .expect("fixture has action")
        .receipt
        .as_mut()
        .expect("fixture has receipt")
        .completed_at = "2026-07-20T00:01:00.000001Z".into();

    let decision = classify_replayed_governed_action_v1(&workflow, &query);

    assert_eq!(decision.disposition, ActionDecisionDispositionV1::Blocked);
    assert_eq!(
        decision.reason,
        Some(ActionDecisionBlockReasonV1::MalformedEvidence)
    );
}

#[test]
fn model_success_after_authorization_expiry_is_not_reused() {
    let Fixture { workflow, query } = model_success_fixture(
        "2026-07-20T00:00:30Z",
        "2026-07-20T00:00:40Z",
        "2026-07-20T00:00:45Z",
        true,
    );

    let decision = classify_replayed_governed_action_v1(&workflow, &query);

    assert_eq!(decision.disposition, ActionDecisionDispositionV1::Blocked);
    assert_eq!(
        decision.reason,
        Some(ActionDecisionBlockReasonV1::MalformedEvidence)
    );
}

#[test]
fn model_success_without_a_signed_authorization_time_is_not_reused() {
    let Fixture {
        mut workflow,
        query,
    } = model_success_fixture(
        "2026-07-20T00:00:30Z",
        "2026-07-20T00:00:40Z",
        "2026-07-20T00:10:00Z",
        true,
    );
    workflow
        .action_evidence
        .as_mut()
        .expect("fixture has evidence")
        .actions
        .get_mut("action-1")
        .expect("fixture has action")
        .model_authorization
        .as_mut()
        .expect("fixture has authorization")
        .authorized_at = None;

    let decision = classify_replayed_governed_action_v1(&workflow, &query);

    assert_eq!(decision.disposition, ActionDecisionDispositionV1::Blocked);
    assert_eq!(
        decision.reason,
        Some(ActionDecisionBlockReasonV1::MalformedEvidence)
    );
}

#[test]
fn model_success_without_a_bound_success_receipt_is_not_reused() {
    let Fixture { workflow, query } = model_success_fixture(
        "2026-07-20T00:00:30Z",
        "2026-07-20T00:00:40Z",
        "2026-07-20T00:10:00Z",
        false,
    );

    let decision = classify_replayed_governed_action_v1(&workflow, &query);

    assert_eq!(decision.disposition, ActionDecisionDispositionV1::Blocked);
    assert_eq!(
        decision.reason,
        Some(ActionDecisionBlockReasonV1::MalformedEvidence)
    );
}

#[test]
fn model_success_with_prior_live_authority_and_bound_success_receipt_is_reused() {
    let Fixture { workflow, query } = model_success_fixture(
        "2026-07-20T00:00:30Z",
        "2026-07-20T00:00:40Z",
        "2026-07-20T00:10:00Z",
        true,
    );

    let decision = classify_replayed_governed_action_v1(&workflow, &query);

    assert_eq!(
        decision.disposition,
        ActionDecisionDispositionV1::ReuseRecordedResult
    );
}

#[test]
fn legacy_nonsealed_and_malformed_replay_evidence_fail_closed() {
    let Fixture {
        mut workflow,
        query,
    } = fixture(None);
    workflow.dispatch.dispatch_version = 2;

    let legacy = classify_replayed_governed_action_v1(&workflow, &query);
    assert_eq!(legacy.disposition, ActionDecisionDispositionV1::Blocked);
    assert_eq!(
        legacy.reason,
        Some(ActionDecisionBlockReasonV1::UnsupportedDispatch)
    );

    workflow.dispatch.dispatch_version = 1;
    let v1 = classify_replayed_governed_action_v1(&workflow, &query);
    assert_eq!(v1.disposition, ActionDecisionDispositionV1::Blocked);
    assert_eq!(
        v1.reason,
        Some(ActionDecisionBlockReasonV1::UnsupportedDispatch)
    );

    workflow.dispatch.dispatch_version = 3;
    workflow.dispatch.action_evidence_version = Some(ActionEvidenceVersionV1::SealedV2);
    let nonsealed = classify_replayed_governed_action_v1(&workflow, &query);
    assert_eq!(nonsealed.disposition, ActionDecisionDispositionV1::Blocked);
    assert_eq!(
        nonsealed.reason,
        Some(ActionDecisionBlockReasonV1::UnsupportedDispatch)
    );

    workflow.dispatch.action_evidence_version = Some(ActionEvidenceVersionV1::SealedV3);
    workflow
        .action_evidence
        .as_mut()
        .expect("fixture has evidence")
        .actions
        .get_mut("action-1")
        .expect("fixture has action")
        .request
        .policy_digest = "not-a-digest".into();
    let malformed = classify_replayed_governed_action_v1(&workflow, &query);
    assert_eq!(malformed.disposition, ActionDecisionDispositionV1::Blocked);
    assert_eq!(
        malformed.reason,
        Some(ActionDecisionBlockReasonV1::MalformedEvidence)
    );
}

#[test]
fn decision_query_is_closed_and_versioned() {
    let Fixture { workflow, query } = fixture(None);
    let mut encoded = serde_json::to_value(query.clone()).expect("query serializes");
    encoded["forged_authority"] = serde_json::Value::Bool(true);
    assert!(serde_json::from_value::<RecordedActionDecisionQueryV1>(encoded).is_err());

    let decision = classify_replayed_governed_action_v1(&workflow, &query);
    let mut encoded = serde_json::to_value(decision).expect("decision serializes");
    encoded["forged_authority"] = serde_json::Value::Bool(true);
    assert!(serde_json::from_value::<RecordedActionDecisionV1>(encoded).is_err());
}
