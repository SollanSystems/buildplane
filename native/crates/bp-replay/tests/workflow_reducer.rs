//! Trust-spine V1 workflow reducer tests.
//!
//! These exercise the reducer directly so they prove that replay only changes
//! projected state. No test creates a worktree, invokes a provider, or performs
//! a promotion effect.

use bp_ledger::canonicalize::canonical_event_hash;
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::activity::{ActivityCompletedV1, ActivityStartedV1, ActivityType};
use bp_ledger::payload::activity_claim::{
    ActivityClaimPurposeV1, ActivityClaimedV1, ActivityHeartbeatRecordedV1,
    ActivityResultOutcomeV1, ActivityResultRecordedV1,
};
use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome, RunStartedV1};
use bp_ledger::payload::trust_spine::{
    action_receipt_recorded_v2_digest, action_receipt_set_v1_digest, action_requested_v2_digest,
    attempt_context_recorded_v1_digest, candidate_completion_recorded_v1_digest,
    candidate_view_v1_digest, dispatch_envelope_v2_body_digest, dispatch_envelope_v3_body_digest,
    dispatch_envelope_v4_digest, governed_dispatch_policy_digest_v1,
    model_action_authorized_v1_digest, model_action_authorized_v2_digest,
    model_action_intent_v1_digest, promotion_execution_claimed_v1_digest,
    review_verdict_output_v1_digest, workflow_graph_v2_digest, ActionEvidenceVersionV1,
    ActionFailureV1, ActionKindV1, ActionReceiptOutcomeV2, ActionReceiptRecordedV2,
    ActionReceiptSetEntryV1, ActionReceiptSetRecordedV1, ActionRequestedV2, ActionResourceUsageV1,
    AttemptContextRecordedV1, CandidateAcceptanceOutcomeV1, CandidateAcceptanceRecordedV1,
    CandidateCompletionRecordedV1, CandidateCreatedV1, CandidateCreatedV2, CandidateViewV1,
    CommitModeV1, DispatchBudgetV1, DispatchEnvelopeBodyV2, DispatchEnvelopeV1, DispatchEnvelopeV2,
    DispatchEnvelopeV3, DispatchEnvelopeV4, ExecutionRoleV1, ModelActionAuthorizedV1,
    ModelActionAuthorizedV2, ModelActionCandidateBindingV1, ModelActionIntentV1,
    ModelRequestEvidenceV1, PromotionApprovalRequestedV1, PromotionDecisionKindV1,
    PromotionDecisionRecordedV1, PromotionExecutionClaimedV1, PromotionExecutionLeaseBindingV1,
    PromotionGitBindingV1, PromotionReconciliationResolvedV1, PromotionResultOutcomeV1,
    PromotionResultRecordedV1, PromotionWorktreeSyncStateV1, ReconciliationResolutionOutcomeV1,
    ReviewDecisionV1, ReviewVerdictOutputV1, ReviewVerdictRecordedV1, ReviewVerdictRecordedV2,
    SignatureRefV1, TrustScopeEvidenceV1, TrustTierV1, WorkflowCancellationCauseV1,
    WorkflowCancellationRequestedV1, WorkflowGraphDeclaredV2, WorkflowGraphNodeV2,
    WorkflowTerminalOutcomeV1, WorkflowTerminalV1, WorkflowTerminalV2, WorkflowTimerFiredV1,
    WorkflowTimerKindV1, WorkflowTimerScheduledV1, MODEL_REQUEST_EVIDENCE_V1_SCHEMA_VERSION,
    TRUST_SCOPE_EVIDENCE_V1_SCHEMA_VERSION,
};
use bp_ledger::payload::Payload;
use bp_ledger::signing::{public_key_hash, ActorKeyRef, TrustedPublicKeys, VerificationStatus};
use bp_ledger::storage::sqlite::SqliteStore;
use bp_replay::engine::{ReplayEngine, TrustSpineSignerRole, TrustedReplayAuthorities};
use bp_replay::state::{ReplayIssue, ReplayState, WorkflowInstanceV1, WorkflowPhaseV1};
use bp_replay::transitions::apply;
use chrono::Utc;
use ed25519_dalek::SigningKey;
use std::collections::BTreeMap;
use tempfile::TempDir;

const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST_C: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

fn event_of(run_id: RunId, kind: EventKind, payload: Payload) -> Event {
    let occurred_at = match &payload {
        Payload::ActionRequestedV2(request) => {
            chrono::DateTime::parse_from_rfc3339(&request.requested_at)
                .expect("parse action requested_at")
                .with_timezone(&Utc)
        }
        _ => Utc::now(),
    };
    Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: 1,
        kind,
        occurred_at,
        payload,
    }
}

fn has_activity_transition_rejection(state: &ReplayState, expected_reason: &str) -> bool {
    state.issues.iter().any(|issue| {
        matches!(issue,
            ReplayIssue::ActivityTransitionRejected { reason, .. }
                | ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains(expected_reason))
    })
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

fn operator_signer() -> ActorKeyRef {
    ActorKeyRef {
        actor_id: "operator".into(),
        key_id: "operator-main".into(),
        public_key_hash: None,
    }
}

fn signer_with_public_key(signer: ActorKeyRef, signing_key: &SigningKey) -> ActorKeyRef {
    ActorKeyRef {
        public_key_hash: Some(public_key_hash(&signing_key.verifying_key())),
        ..signer
    }
}

fn trusted_keys(signing_key: &SigningKey) -> TrustedPublicKeys {
    let mut keys = TrustedPublicKeys::default();
    keys.insert_public_key(
        public_key_hash(&signing_key.verifying_key()),
        signing_key.verifying_key().to_bytes().to_vec(),
    );
    keys
}

fn trusted_authorities(signing_key: &SigningKey) -> TrustedReplayAuthorities {
    let mut authorities = TrustedReplayAuthorities::new(trusted_keys(signing_key));
    authorities.allow_signer(
        TrustSpineSignerRole::Kernel,
        signer_with_public_key(kernel_signer(), signing_key),
    );
    authorities.allow_signer(
        TrustSpineSignerRole::Reviewer,
        signer_with_public_key(reviewer_signer(), signing_key),
    );
    authorities.allow_signer(
        TrustSpineSignerRole::Operator,
        signer_with_public_key(operator_signer(), signing_key),
    );
    authorities
}

fn activity_started(run_id: RunId, activity_id: &str, input_digest: &str) -> Event {
    event_of(
        run_id,
        EventKind::ActivityStarted,
        Payload::ActivityStartedV1(ActivityStartedV1 {
            run_id,
            activity_id: activity_id.into(),
            activity_type: ActivityType::Command,
            input_digest: input_digest.into(),
        }),
    )
}

fn activity_completed(
    run_id: RunId,
    activity_id: &str,
    result_digest: &str,
    result: serde_json::Value,
) -> Event {
    event_of(
        run_id,
        EventKind::ActivityCompleted,
        Payload::ActivityCompletedV1(ActivityCompletedV1 {
            run_id,
            activity_id: activity_id.into(),
            result_digest: result_digest.into(),
            result,
        }),
    )
}

fn dispatch() -> DispatchEnvelopeV1 {
    DispatchEnvelopeV1 {
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
        context_manifest_digest: DIGEST_A.into(),
        worker_manifest_digest: DIGEST_B.into(),
        sandbox_profile_digest: DIGEST_C.into(),
        budget: DispatchBudgetV1 {
            max_tokens: Some(2_048),
            max_compute_time_ms: Some(60_000),
        },
        trust_tier: TrustTierV1::Governed,
        idempotency_key: "dispatch:workflow-1:unit-1:1".into(),
        issued_at: "2026-07-17T00:00:00Z".into(),
        expires_at: "2026-07-17T01:00:00Z".into(),
        envelope_digest: DIGEST_C.into(),
        signature_ref: SignatureRefV1 {
            algorithm: "ed25519".into(),
            key_id: "kernel-main".into(),
            signature: "detached-signature".into(),
        },
    }
}

fn dispatch_v2() -> DispatchEnvelopeV2 {
    let v1 = dispatch();
    let body = DispatchEnvelopeBodyV2 {
        workflow_id: v1.workflow_id,
        workflow_revision: v1.workflow_revision,
        unit_id: v1.unit_id,
        attempt: v1.attempt,
        execution_role: v1.execution_role,
        commit_mode: v1.commit_mode,
        provenance_ref: v1.provenance_ref,
        base_commit_sha: v1.base_commit_sha,
        capability_bundle_digest: v1.capability_bundle_digest,
        acceptance_contract_digest: v1.acceptance_contract_digest,
        context_manifest_digest: v1.context_manifest_digest,
        worker_manifest_digest: v1.worker_manifest_digest,
        sandbox_profile_digest: v1.sandbox_profile_digest,
        budget: v1.budget,
        trust_tier: v1.trust_tier,
        idempotency_key: v1.idempotency_key,
        issued_at: v1.issued_at,
        expires_at: v1.expires_at,
    };
    let envelope_digest = dispatch_envelope_v2_body_digest(&body).expect("serialize v2 body");
    DispatchEnvelopeV2 {
        body,
        envelope_digest,
    }
}

fn dispatch_v3() -> DispatchEnvelopeV3 {
    dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV2)
}

fn dispatch_v3_with_action_evidence(
    action_evidence_version: ActionEvidenceVersionV1,
) -> DispatchEnvelopeV3 {
    dispatch_v3_with_action_evidence_and_compute_budget(action_evidence_version, Some(60_000))
}

fn sealed_v3_dispatch_with_max_tokens(max_tokens: u32) -> DispatchEnvelopeV3 {
    let mut dispatch = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    dispatch.body.budget.max_tokens = Some(max_tokens);
    dispatch.envelope_digest = dispatch_envelope_v3_body_digest(
        &dispatch.body,
        dispatch.action_evidence_version,
        &dispatch.repository_binding_digest,
        &dispatch.ledger_authority_realm_digest,
        dispatch.governed_packet_digest.as_deref(),
    )
    .expect("serialize sealed_v3 token-budget dispatch body");
    dispatch
}

fn dispatch_v3_with_action_evidence_and_compute_budget(
    action_evidence_version: ActionEvidenceVersionV1,
    max_compute_time_ms: Option<u32>,
) -> DispatchEnvelopeV3 {
    let mut body = dispatch_v2().body;
    body.budget.max_compute_time_ms = max_compute_time_ms;
    let envelope_digest = dispatch_envelope_v3_body_digest(
        &body,
        action_evidence_version,
        DIGEST_A,
        DIGEST_B,
        (action_evidence_version == ActionEvidenceVersionV1::SealedV3).then_some(DIGEST_C),
    )
    .expect("serialize v3 dispatch body");
    DispatchEnvelopeV3 {
        body,
        action_evidence_version,
        repository_binding_digest: DIGEST_A.into(),
        ledger_authority_realm_digest: DIGEST_B.into(),
        governed_packet_digest: (action_evidence_version == ActionEvidenceVersionV1::SealedV3)
            .then(|| DIGEST_C.into()),
        envelope_digest,
    }
}

fn retry_dispatch(prior: &DispatchEnvelopeV3) -> DispatchEnvelopeV3 {
    let mut retry = prior.clone();
    retry.body.attempt = prior
        .body
        .attempt
        .checked_add(1)
        .expect("test retry attempt does not overflow");
    retry.body.idempotency_key = format!(
        "dispatch:{}:{}:{}",
        retry.body.workflow_id, retry.body.unit_id, retry.body.attempt
    );
    retry.envelope_digest = dispatch_envelope_v3_body_digest(
        &retry.body,
        retry.action_evidence_version,
        &retry.repository_binding_digest,
        &retry.ledger_authority_realm_digest,
        retry.governed_packet_digest.as_deref(),
    )
    .expect("serialize retry dispatch body");
    retry
}

fn event_occurred_at(event: &mut Event, timestamp: &str) {
    event.occurred_at = chrono::DateTime::parse_from_rfc3339(timestamp)
        .expect("parse event occurred_at")
        .with_timezone(&Utc);
}

fn activity_claim_event(run_id: RunId, claim: &ActivityClaimedV1) -> Event {
    let mut event = event_of(
        run_id,
        EventKind::ActivityClaimedV1,
        Payload::ActivityClaimedV1(claim.clone()),
    );
    event.parent_event_id = Some(claim.action_request_event_id);
    event_occurred_at(&mut event, &claim.claimed_at);
    event
}

fn activity_result_event(
    run_id: RunId,
    claim_event: &Event,
    result: &ActivityResultRecordedV1,
) -> Event {
    let mut event = event_of(
        run_id,
        EventKind::ActivityResultRecordedV1,
        Payload::ActivityResultRecordedV1(result.clone()),
    );
    event.parent_event_id = Some(claim_event.id);
    event_occurred_at(&mut event, &result.recorded_at);
    event
}

fn activity_heartbeat(
    claim_event: &Event,
    claim: &ActivityClaimedV1,
    heartbeat_at: &str,
    lease_expires_at: &str,
) -> ActivityHeartbeatRecordedV1 {
    ActivityHeartbeatRecordedV1 {
        run_id: claim.run_id,
        activity_id: claim.activity_id.clone(),
        idempotency_key: claim.idempotency_key.clone(),
        heartbeat_id: Some("heartbeat-replay".into()),
        heartbeat_request_digest: Some(DIGEST_A.into()),
        claim_event_id: claim_event.id,
        claim_event_digest: canonical_event_hash(claim_event).expect("hash claim event"),
        lease_id: claim.lease_id.clone(),
        dispatch_event_id: claim.dispatch_event_id,
        dispatch_envelope_digest: claim.dispatch_envelope_digest.clone(),
        lease_expires_at: lease_expires_at.into(),
        heartbeat_at: heartbeat_at.into(),
    }
}

fn activity_heartbeat_event(
    run_id: RunId,
    claim_event: &Event,
    heartbeat: &ActivityHeartbeatRecordedV1,
) -> Event {
    let mut event = event_of(
        run_id,
        EventKind::ActivityHeartbeatRecordedV1,
        Payload::ActivityHeartbeatRecordedV1(heartbeat.clone()),
    );
    event.parent_event_id = Some(claim_event.id);
    event_occurred_at(&mut event, &heartbeat.heartbeat_at);
    event
}

fn reviewer_dispatch_v3() -> DispatchEnvelopeV3 {
    reviewer_dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV2)
}

fn reviewer_dispatch_v3_with_action_evidence(
    action_evidence_version: ActionEvidenceVersionV1,
) -> DispatchEnvelopeV3 {
    let mut dispatch = dispatch_v3_with_action_evidence(action_evidence_version);
    dispatch.body.unit_id = "review-unit-1".into();
    dispatch.body.execution_role = ExecutionRoleV1::Reviewer;
    dispatch.body.idempotency_key = "dispatch:workflow-1:review-unit-1:1".into();
    dispatch.envelope_digest = dispatch_envelope_v3_body_digest(
        &dispatch.body,
        dispatch.action_evidence_version,
        &dispatch.repository_binding_digest,
        &dispatch.ledger_authority_realm_digest,
        dispatch.governed_packet_digest.as_deref(),
    )
    .expect("serialize reviewer v3 dispatch body");
    dispatch
}

fn action_request(
    run_id: RunId,
    dispatch: &DispatchEnvelopeV3,
    action_id: &str,
) -> ActionRequestedV2 {
    ActionRequestedV2 {
        run_id: run_id.to_string(),
        workflow_id: dispatch.body.workflow_id.clone(),
        unit_id: dispatch.body.unit_id.clone(),
        attempt: dispatch.body.attempt,
        provenance_ref: dispatch.body.provenance_ref.clone(),
        action_id: action_id.into(),
        idempotency_key: format!("action:{action_id}"),
        action_kind: ActionKindV1::Process,
        canonical_input_digest: DIGEST_A.into(),
        canonical_input_ref: format!("cas:input:{action_id}"),
        dispatch_envelope_digest: dispatch.envelope_digest.clone(),
        repository_binding_digest: dispatch.repository_binding_digest.clone(),
        ledger_authority_realm_digest: dispatch.ledger_authority_realm_digest.clone(),
        governed_packet_digest: dispatch.governed_packet_digest.clone(),
        capability_bundle_digest: dispatch.body.capability_bundle_digest.clone(),
        policy_digest: (dispatch.action_evidence_version == ActionEvidenceVersionV1::SealedV3)
            .then(|| {
                governed_dispatch_policy_digest_v1(&dispatch.body.acceptance_contract_digest)
                    .expect("derive sealed_v3 policy binding")
            })
            .unwrap_or_else(|| DIGEST_B.into()),
        context_manifest_digest: dispatch.body.context_manifest_digest.clone(),
        worker_manifest_digest: dispatch.body.worker_manifest_digest.clone(),
        sandbox_profile_digest: dispatch.body.sandbox_profile_digest.clone(),
        authority_actor: "kernel".into(),
        execution_role: dispatch.body.execution_role,
        requested_at: "2026-07-17T00:00:01Z".into(),
    }
}

fn action_receipt(
    request: &ActionRequestedV2,
    outcome: ActionReceiptOutcomeV2,
) -> ActionReceiptRecordedV2 {
    let succeeded = outcome == ActionReceiptOutcomeV2::Succeeded;
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
        result_digest: succeeded.then(|| DIGEST_C.into()),
        result_ref: succeeded.then(|| format!("cas:result:{}", request.action_id)),
        evidence_digest: DIGEST_A.into(),
        evidence_ref: format!("cas:evidence:{}", request.action_id),
        resource_usage: ActionResourceUsageV1 {
            wall_time_ms: 1,
            cpu_time_ms: Some(1),
            peak_memory_bytes: Some(1),
            input_bytes: Some(1),
            output_bytes: Some(1),
            // Model test receipts carry a complete pair so sealed_v3 paths
            // exercise token accounting. The published sealed-v2 fixture
            // intentionally remains no-token in gen_fixtures.rs.
            input_tokens: (request.action_kind == ActionKindV1::Model).then_some(1),
            output_tokens: (request.action_kind == ActionKindV1::Model).then_some(1),
        },
        redactions: vec![],
        failure: (!succeeded).then(|| ActionFailureV1 {
            code: "effect_unknown".into(),
            message_digest: DIGEST_B.into(),
            retryable: false,
        }),
        authorization_ref: None,
        action_receipt_ref: format!("receipt:{}", request.action_id),
        completed_at: "2026-07-17T00:00:02Z".into(),
    }
}

fn activity_claim(
    run_id: RunId,
    dispatch_event: &Event,
    request_event: &Event,
    request: &ActionRequestedV2,
) -> ActivityClaimedV1 {
    ActivityClaimedV1 {
        run_id,
        activity_id: request.action_id.clone(),
        idempotency_key: request.idempotency_key.clone(),
        action_kind: request.action_kind,
        action_request_event_id: request_event.id,
        action_request_digest: action_requested_v2_digest(request).expect("hash action request"),
        dispatch_event_id: dispatch_event.id,
        dispatch_envelope_digest: request.dispatch_envelope_digest.clone(),
        authority_actor: "kernel".into(),
        purpose: ActivityClaimPurposeV1::Generic,
        lease_id: format!("lease:{}", request.action_id),
        lease_expires_at: "2026-07-17T00:01:00Z".into(),
        claimed_at: "2026-07-17T00:00:01Z".into(),
    }
}

fn activity_result(
    claim_event: &Event,
    claim: &ActivityClaimedV1,
    outcome: ActivityResultOutcomeV1,
) -> ActivityResultRecordedV1 {
    let succeeded = outcome == ActivityResultOutcomeV1::Succeeded;
    ActivityResultRecordedV1 {
        run_id: claim.run_id,
        activity_id: claim.activity_id.clone(),
        idempotency_key: claim.idempotency_key.clone(),
        claim_event_id: claim_event.id,
        claim_event_digest: canonical_event_hash(claim_event).expect("hash claim event"),
        lease_id: claim.lease_id.clone(),
        outcome,
        result_digest: succeeded.then(|| DIGEST_C.into()),
        result_ref: succeeded.then(|| format!("cas:result:{}", claim.activity_id)),
        evidence_digest: DIGEST_A.into(),
        evidence_ref: format!("cas:evidence:{}", claim.activity_id),
        recorded_at: "2026-07-17T00:00:02Z".into(),
    }
}

/// Project every immutable prerequisite for one sealed_v3 model effect and
/// return its still-unrecorded terminal receipt. Tests can then mutate only
/// the receipt evidence they need to exercise while preserving the ordinary
/// dispatch → intent → authorization → lease → result lineage.
fn sealed_v3_model_receipt(
    state: &mut ReplayState,
    run_id: RunId,
    dispatch_event: &Event,
    dispatch: &DispatchEnvelopeV3,
    action_id: &str,
    receipt_outcome: ActionReceiptOutcomeV2,
) -> ActionReceiptRecordedV2 {
    let mut request = action_request(run_id, dispatch, action_id);
    request.action_kind = ActionKindV1::Model;
    let request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request.clone()),
    );
    apply(state, &request_event);

    let intent = model_action_intent(&request, dispatch_event, &request_event);
    let intent_event = model_action_intent_event(run_id, &intent);
    apply(state, &intent_event);
    let authorization = model_action_authorization_v2(&intent_event, &intent);
    apply(
        state,
        &model_action_authorization_v2_event(run_id, &intent_event, &authorization),
    );

    let mut claim = activity_claim(run_id, dispatch_event, &request_event, &request);
    claim.claimed_at = "2026-07-17T00:00:05Z".into();
    let claim_event = activity_claim_event(run_id, &claim);
    apply(state, &claim_event);
    let activity_outcome = match receipt_outcome {
        ActionReceiptOutcomeV2::Succeeded => ActivityResultOutcomeV1::Succeeded,
        ActionReceiptOutcomeV2::Unknown => ActivityResultOutcomeV1::Unknown,
        ActionReceiptOutcomeV2::Failed | ActionReceiptOutcomeV2::Denied => {
            ActivityResultOutcomeV1::Failed
        }
    };
    let mut result = activity_result(&claim_event, &claim, activity_outcome);
    result.recorded_at = "2026-07-17T00:00:06Z".into();
    apply(state, &activity_result_event(run_id, &claim_event, &result));

    let mut receipt = action_receipt(&request, receipt_outcome);
    receipt.authorization_ref = Some(authorization.authorization_ref);
    // This is provider completion time, not receipt-event append time. It is
    // after the authorization and no later than the activity result record.
    receipt.completed_at = "2026-07-17T00:00:06Z".into();
    receipt
}

struct SealedV3ActivityClaimFixture {
    state: ReplayState,
    run_id: RunId,
    claim: ActivityClaimedV1,
    claim_event: Event,
}

fn sealed_v3_activity_claim_fixture() -> SealedV3ActivityClaimFixture {
    sealed_v3_activity_claim_fixture_with_compute_budget(Some(60_000))
}

fn sealed_v3_activity_claim_fixture_with_compute_budget(
    max_compute_time_ms: Option<u32>,
) -> SealedV3ActivityClaimFixture {
    let run_id = RunId::new();
    let dispatch = dispatch_v3_with_action_evidence_and_compute_budget(
        ActionEvidenceVersionV1::SealedV3,
        max_compute_time_ms,
    );
    let request = action_request(run_id, &dispatch, "heartbeat-effect");
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch),
    );
    let request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request.clone()),
    );
    let claim = activity_claim(run_id, &dispatch_event, &request_event, &request);
    let claim_event = activity_claim_event(run_id, &claim);
    let mut state = ReplayState::default();
    for event in [dispatch_event, request_event, claim_event.clone()] {
        apply(&mut state, &event);
    }
    assert!(
        state.issues.is_empty(),
        "valid sealed_v3 activity claim fixture: {:#?}",
        state.issues
    );
    SealedV3ActivityClaimFixture {
        state,
        run_id,
        claim,
        claim_event,
    }
}

#[derive(Clone)]
struct FailedRetryAttemptFixture {
    prior_dispatch: DispatchEnvelopeV3,
    receipt: ActionReceiptRecordedV2,
    terminal_event: Event,
}

fn failed_terminal(dispatch: &DispatchEnvelopeV3) -> WorkflowTerminalV1 {
    WorkflowTerminalV1 {
        workflow_id: dispatch.body.workflow_id.clone(),
        workflow_revision: dispatch.body.workflow_revision.clone(),
        unit_id: dispatch.body.unit_id.clone(),
        attempt: dispatch.body.attempt,
        outcome: WorkflowTerminalOutcomeV1::Failed,
        candidate_digest: None,
        promotion_result_ref: None,
        reconciliation_resolution_ref: None,
        reason: Some("terminal effect failure".into()),
        idempotency_key: format!(
            "terminal:{}:{}:{}",
            dispatch.body.workflow_id, dispatch.body.unit_id, dispatch.body.attempt
        ),
        completed_at: "2026-07-17T00:00:03Z".into(),
    }
}

fn apply_failed_retry_attempt(state: &mut ReplayState, run_id: RunId) -> FailedRetryAttemptFixture {
    let prior_dispatch = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    let request = action_request(run_id, &prior_dispatch, "retryable-effect");
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(prior_dispatch.clone()),
    );
    let request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request.clone()),
    );
    apply(state, &dispatch_event);
    apply(state, &request_event);
    let claim = activity_claim(run_id, &dispatch_event, &request_event, &request);
    let claim_event = activity_claim_event(run_id, &claim);
    apply(state, &claim_event);
    let result = activity_result(&claim_event, &claim, ActivityResultOutcomeV1::Failed);
    apply(state, &activity_result_event(run_id, &claim_event, &result));
    let receipt = action_receipt(&request, ActionReceiptOutcomeV2::Failed);
    apply(
        state,
        &event_of(
            run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(receipt.clone()),
        ),
    );
    let terminal_event = event_of(
        run_id,
        EventKind::WorkflowTerminal,
        Payload::WorkflowTerminalV1(failed_terminal(&prior_dispatch)),
    );
    apply(state, &terminal_event);
    assert!(
        state.issues.is_empty(),
        "valid failed retry setup: terminal={:#?}; issues={:#?}; workflows={:#?}",
        failed_terminal(&prior_dispatch),
        state.issues,
        state.workflow_instances
    );
    FailedRetryAttemptFixture {
        prior_dispatch,
        receipt,
        terminal_event,
    }
}

fn retry_attempt_context(
    run_id: RunId,
    fixture: &FailedRetryAttemptFixture,
    next_dispatch: &DispatchEnvelopeV3,
) -> AttemptContextRecordedV1 {
    let mut context = AttemptContextRecordedV1 {
        run_id: run_id.to_string(),
        workflow_id: fixture.prior_dispatch.body.workflow_id.clone(),
        workflow_revision: fixture.prior_dispatch.body.workflow_revision.clone(),
        unit_id: fixture.prior_dispatch.body.unit_id.clone(),
        prior_attempt: fixture.prior_dispatch.body.attempt,
        next_attempt: next_dispatch.body.attempt,
        prior_dispatch_envelope_digest: fixture.prior_dispatch.envelope_digest.clone(),
        prior_terminal_event_ref: fixture.terminal_event.id.to_string(),
        prior_terminal_event_digest: canonical_event_hash(&fixture.terminal_event)
            .expect("hash terminal event"),
        prior_action_receipt_ref: fixture.receipt.action_receipt_ref.clone(),
        prior_action_receipt_digest: action_receipt_recorded_v2_digest(&fixture.receipt)
            .expect("hash terminal receipt"),
        feedback_ref: "cas:retry-feedback:workflow-1:unit-1:2".into(),
        feedback_digest: DIGEST_C.into(),
        next_dispatch_envelope_digest: next_dispatch.envelope_digest.clone(),
        next_dispatch_idempotency_key: next_dispatch.body.idempotency_key.clone(),
        retry_action_namespace: "retry-action:workflow-1:unit-1:2".into(),
        idempotency_key: "retry-context:workflow-1:unit-1:1:2".into(),
        recorded_at: "2026-07-17T00:00:04Z".into(),
        attempt_context_digest: String::new(),
    };
    context.attempt_context_digest =
        attempt_context_recorded_v1_digest(&context).expect("hash retry attempt context");
    context
}

fn model_action_authorization(
    request: &ActionRequestedV2,
    dispatch_event: &Event,
    request_event: &Event,
    authorization_ref: &str,
    candidate_binding: Option<(&str, &str)>,
) -> ModelActionAuthorizedV1 {
    let (candidate_digest, candidate_view_digest) = candidate_binding
        .map(|(candidate_digest, candidate_view_digest)| {
            (
                Some(candidate_digest.into()),
                Some(candidate_view_digest.into()),
            )
        })
        .unwrap_or((None, None));
    let mut authorization = ModelActionAuthorizedV1 {
        run_id: request.run_id.clone(),
        workflow_id: request.workflow_id.clone(),
        unit_id: request.unit_id.clone(),
        attempt: request.attempt,
        provenance_ref: request.provenance_ref.clone(),
        action_id: request.action_id.clone(),
        idempotency_key: request.idempotency_key.clone(),
        dispatch_event_ref: dispatch_event.id.to_string(),
        dispatch_envelope_digest: request.dispatch_envelope_digest.clone(),
        action_request_ref: request_event.id.to_string(),
        action_request_digest: action_requested_v2_digest(request).expect("hash action request"),
        packet_digest: request
            .governed_packet_digest
            .clone()
            .unwrap_or_else(|| DIGEST_A.into()),
        canonical_input_digest: request.canonical_input_digest.clone(),
        model_request_digest: DIGEST_B.into(),
        trust_scope_digest: DIGEST_C.into(),
        context_manifest_digest: request.context_manifest_digest.clone(),
        policy_digest: request.policy_digest.clone(),
        sandbox_profile_digest: request.sandbox_profile_digest.clone(),
        execution_role: request.execution_role,
        candidate_digest,
        candidate_view_digest,
        authorization_actor: "kernel".into(),
        expires_at: "2026-07-17T00:00:30Z".into(),
        authorization_ref: authorization_ref.into(),
        authorization_digest: String::new(),
    };
    authorization.authorization_digest =
        model_action_authorized_v1_digest(&authorization).expect("hash model authorization");
    authorization
}

fn model_action_intent(
    request: &ActionRequestedV2,
    dispatch_event: &Event,
    request_event: &Event,
) -> ModelActionIntentV1 {
    let mut intent = ModelActionIntentV1 {
        run_id: request.run_id.clone(),
        workflow_id: request.workflow_id.clone(),
        unit_id: request.unit_id.clone(),
        attempt: request.attempt,
        provenance_ref: request.provenance_ref.clone(),
        action_id: request.action_id.clone(),
        idempotency_key: request.idempotency_key.clone(),
        dispatch_event_ref: dispatch_event.id,
        dispatch_envelope_digest: request.dispatch_envelope_digest.clone(),
        action_request_event_ref: request_event.id,
        action_request_digest: action_requested_v2_digest(request).expect("hash action request"),
        canonical_input_ref: request.canonical_input_ref.clone(),
        canonical_input_digest: request.canonical_input_digest.clone(),
        model_request_evidence: ModelRequestEvidenceV1 {
            schema_version: MODEL_REQUEST_EVIDENCE_V1_SCHEMA_VERSION,
            cas_ref: format!("cas:{DIGEST_B}"),
            digest: DIGEST_B.into(),
        },
        trust_scope_evidence: TrustScopeEvidenceV1 {
            schema_version: TRUST_SCOPE_EVIDENCE_V1_SCHEMA_VERSION,
            cas_ref: format!("cas:{DIGEST_C}"),
            digest: DIGEST_C.into(),
        },
        candidate_binding: None,
        intent_actor: "kernel".into(),
        intended_at: "2026-07-17T00:00:03Z".into(),
        intent_digest: String::new(),
    };
    intent.intent_digest = model_action_intent_v1_digest(&intent).expect("hash model intent");
    intent
}

fn model_action_intent_event(run_id: RunId, intent: &ModelActionIntentV1) -> Event {
    let mut event = event_of(
        run_id,
        EventKind::ModelActionIntentV1,
        Payload::ModelActionIntentV1(intent.clone()),
    );
    event.parent_event_id = Some(intent.action_request_event_ref);
    event_occurred_at(&mut event, &intent.intended_at);
    event
}

fn model_action_authorization_v2(
    intent_event: &Event,
    intent: &ModelActionIntentV1,
) -> ModelActionAuthorizedV2 {
    let mut authorization = ModelActionAuthorizedV2 {
        intent_event_ref: intent_event.id,
        intent_digest: intent.intent_digest.clone(),
        model_request_evidence: intent.model_request_evidence.clone(),
        trust_scope_evidence: intent.trust_scope_evidence.clone(),
        candidate_binding: intent.candidate_binding.clone(),
        authorization_actor: "kernel".into(),
        expires_at: "2026-07-17T00:00:30Z".into(),
        authorization_ref: format!("authorization:{}", intent.action_id),
        authorization_digest: String::new(),
    };
    authorization.authorization_digest =
        model_action_authorized_v2_digest(&authorization).expect("hash V2 model authorization");
    authorization
}

fn model_action_authorization_v2_event(
    run_id: RunId,
    intent_event: &Event,
    authorization: &ModelActionAuthorizedV2,
) -> Event {
    let mut event = event_of(
        run_id,
        EventKind::ModelActionAuthorizedV2,
        Payload::ModelActionAuthorizedV2(authorization.clone()),
    );
    event.parent_event_id = Some(intent_event.id);
    event_occurred_at(&mut event, "2026-07-17T00:00:04Z");
    event
}

fn action_receipt_set(
    request: &ActionRequestedV2,
    receipt: &ActionReceiptRecordedV2,
) -> ActionReceiptSetRecordedV1 {
    let mut set = ActionReceiptSetRecordedV1 {
        run_id: request.run_id.clone(),
        workflow_id: request.workflow_id.clone(),
        unit_id: request.unit_id.clone(),
        attempt: request.attempt,
        provenance_ref: request.provenance_ref.clone(),
        dispatch_envelope_digest: request.dispatch_envelope_digest.clone(),
        action_receipt_set_ref: "receipt-set:1".into(),
        action_receipt_set_digest: String::new(),
        receipts: vec![ActionReceiptSetEntryV1 {
            action_id: request.action_id.clone(),
            action_receipt_ref: receipt.action_receipt_ref.clone(),
            action_receipt_digest: action_receipt_recorded_v2_digest(receipt)
                .expect("hash action receipt"),
        }],
        sealed_at: "2026-07-17T00:00:03Z".into(),
    };
    set.action_receipt_set_digest = action_receipt_set_v1_digest(&set).expect("hash receipt set");
    set
}

fn candidate_v2(
    run_id: RunId,
    dispatch: &DispatchEnvelopeV3,
    set: &ActionReceiptSetRecordedV1,
) -> CandidateCreatedV2 {
    CandidateCreatedV2 {
        run_id: run_id.to_string(),
        candidate_id: "candidate-v2-1".into(),
        candidate_ref: "refs/buildplane/candidates/candidate-v2-1/run-1/1".into(),
        workflow_id: dispatch.body.workflow_id.clone(),
        unit_id: dispatch.body.unit_id.clone(),
        attempt: dispatch.body.attempt,
        provenance_ref: dispatch.body.provenance_ref.clone(),
        candidate_digest: DIGEST_A.into(),
        base_commit_sha: dispatch.body.base_commit_sha.clone(),
        candidate_commit_sha: "2".repeat(40),
        commit_digest: DIGEST_B.into(),
        tree_digest: DIGEST_C.into(),
        patch_digest: DIGEST_A.into(),
        changed_files_digest: DIGEST_B.into(),
        envelope_digest: dispatch.envelope_digest.clone(),
        action_receipt_set_ref: set.action_receipt_set_ref.clone(),
        action_receipt_set_digest: set.action_receipt_set_digest.clone(),
    }
}

fn candidate_completion(
    candidate: &CandidateCreatedV2,
    candidate_event: &Event,
    request: &ActionRequestedV2,
    request_event: &Event,
    claim_event: &Event,
    result_event: &Event,
    receipt: &ActionReceiptRecordedV2,
) -> CandidateCompletionRecordedV1 {
    let mut completion = CandidateCompletionRecordedV1 {
        run_id: candidate.run_id.clone(),
        workflow_id: candidate.workflow_id.clone(),
        unit_id: candidate.unit_id.clone(),
        attempt: candidate.attempt,
        provenance_ref: candidate.provenance_ref.clone(),
        candidate_created_event_ref: candidate_event.id,
        candidate_digest: candidate.candidate_digest.clone(),
        candidate_create_action_id: request.action_id.clone(),
        action_request_ref: request_event.id,
        action_request_digest: action_requested_v2_digest(request)
            .expect("hash candidate action request"),
        activity_claim_event_ref: claim_event.id,
        activity_claim_event_digest: canonical_event_hash(claim_event)
            .expect("hash candidate activity claim"),
        activity_result_event_ref: result_event.id,
        activity_result_event_digest: canonical_event_hash(result_event)
            .expect("hash candidate activity result"),
        action_receipt_ref: receipt.action_receipt_ref.clone(),
        action_receipt_digest: action_receipt_recorded_v2_digest(receipt)
            .expect("hash candidate action receipt"),
        completion_digest: String::new(),
        completed_at: "2026-07-17T00:00:04Z".into(),
    };
    completion.completion_digest =
        candidate_completion_recorded_v1_digest(&completion).expect("hash candidate completion");
    completion
}

fn candidate_completion_event(
    run_id: RunId,
    candidate_event: &Event,
    completion: &CandidateCompletionRecordedV1,
) -> Event {
    let mut event = event_of(
        run_id,
        EventKind::CandidateCompletionRecordedV1,
        Payload::CandidateCompletionRecordedV1(completion.clone()),
    );
    event.parent_event_id = Some(candidate_event.id);
    event_occurred_at(&mut event, &completion.completed_at);
    event
}

#[derive(Clone)]
struct V2ReviewFixture {
    run_id: RunId,
    candidate_dispatch: DispatchEnvelopeV3,
    candidate_request: ActionRequestedV2,
    candidate_receipt: ActionReceiptRecordedV2,
    candidate_set: ActionReceiptSetRecordedV1,
    candidate: CandidateCreatedV2,
    candidate_acceptance: CandidateAcceptanceRecordedV1,
    reviewer_dispatch: DispatchEnvelopeV3,
    reviewer_request: ActionRequestedV2,
    reviewer_receipt: ActionReceiptRecordedV2,
    reviewer_set: ActionReceiptSetRecordedV1,
    verdict: ReviewVerdictRecordedV2,
}

fn v2_review_fixture() -> V2ReviewFixture {
    let run_id = RunId::new();
    let candidate_dispatch = dispatch_v3();
    let candidate_request = action_request(run_id, &candidate_dispatch, "implement-action-1");
    let candidate_receipt = action_receipt(&candidate_request, ActionReceiptOutcomeV2::Succeeded);
    let candidate_set = action_receipt_set(&candidate_request, &candidate_receipt);
    let candidate = candidate_v2(run_id, &candidate_dispatch, &candidate_set);
    let candidate_acceptance = acceptance(CandidateAcceptanceOutcomeV1::Passed);
    let reviewer_dispatch = reviewer_dispatch_v3();
    let mut reviewer_request = action_request(run_id, &reviewer_dispatch, "review-action-1");
    reviewer_request.action_kind = ActionKindV1::Model;
    let mut reviewer_receipt = action_receipt(&reviewer_request, ActionReceiptOutcomeV2::Succeeded);
    let candidate_view = review_v2_candidate_view(&reviewer_dispatch);
    let review_output_digest = review_verdict_output_v1_digest(&review_v2_output(&candidate_view))
        .expect("hash closed review output");
    reviewer_receipt.result_ref = Some(format!("cas:{review_output_digest}"));
    reviewer_receipt.result_digest = Some(review_output_digest);
    reviewer_receipt.authorization_ref = Some("authorization:review-action-1".into());
    let reviewer_set = action_receipt_set(&reviewer_request, &reviewer_receipt);
    let verdict = review_v2(
        run_id,
        &candidate_dispatch,
        &reviewer_dispatch,
        &candidate_acceptance,
        &reviewer_request,
        &reviewer_receipt,
        &reviewer_set,
    );

    V2ReviewFixture {
        run_id,
        candidate_dispatch,
        candidate_request,
        candidate_receipt,
        candidate_set,
        candidate,
        candidate_acceptance,
        reviewer_dispatch,
        reviewer_request,
        reviewer_receipt,
        reviewer_set,
        verdict,
    }
}

fn apply_candidate_v2_history(
    state: &mut ReplayState,
    run_id: RunId,
    dispatch: &DispatchEnvelopeV3,
    request: &ActionRequestedV2,
    receipt: &ActionReceiptRecordedV2,
    set: &ActionReceiptSetRecordedV1,
    candidate: &CandidateCreatedV2,
    candidate_acceptance: &CandidateAcceptanceRecordedV1,
) -> Event {
    for (kind, payload) in [
        (
            EventKind::DispatchEnvelopeV3,
            Payload::DispatchEnvelopeV3(dispatch.clone()),
        ),
        (
            EventKind::ActionRequestedV2,
            Payload::ActionRequestedV2(request.clone()),
        ),
        (
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(receipt.clone()),
        ),
        (
            EventKind::ActionReceiptSetRecordedV1,
            Payload::ActionReceiptSetRecordedV1(set.clone()),
        ),
    ] {
        apply(state, &event_of(run_id, kind, payload));
    }
    let candidate_event = event_of(
        run_id,
        EventKind::CandidateCreatedV2,
        Payload::CandidateCreatedV2(candidate.clone()),
    );
    apply(state, &candidate_event);
    apply(
        state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(candidate_acceptance.clone()),
        ),
    );
    candidate_event
}

fn apply_v2_review_prefix(state: &mut ReplayState, fixture: &V2ReviewFixture) {
    for (kind, payload) in [
        (
            EventKind::DispatchEnvelopeV3,
            Payload::DispatchEnvelopeV3(fixture.candidate_dispatch.clone()),
        ),
        (
            EventKind::ActionRequestedV2,
            Payload::ActionRequestedV2(fixture.candidate_request.clone()),
        ),
        (
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(fixture.candidate_receipt.clone()),
        ),
        (
            EventKind::ActionReceiptSetRecordedV1,
            Payload::ActionReceiptSetRecordedV1(fixture.candidate_set.clone()),
        ),
        (
            EventKind::CandidateCreatedV2,
            Payload::CandidateCreatedV2(fixture.candidate.clone()),
        ),
        (
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(fixture.candidate_acceptance.clone()),
        ),
    ] {
        apply(state, &event_of(fixture.run_id, kind, payload));
    }

    let reviewer_dispatch_event = event_of(
        fixture.run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(fixture.reviewer_dispatch.clone()),
    );
    apply(state, &reviewer_dispatch_event);
    let reviewer_request_event = event_of(
        fixture.run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(fixture.reviewer_request.clone()),
    );
    apply(state, &reviewer_request_event);
    let reviewer_authorization_ref = fixture
        .reviewer_receipt
        .authorization_ref
        .as_deref()
        .expect("reviewer model receipt fixture must name its authorization");
    let reviewer_authorization = model_action_authorization(
        &fixture.reviewer_request,
        &reviewer_dispatch_event,
        &reviewer_request_event,
        reviewer_authorization_ref,
        Some((
            fixture.verdict.candidate_digest.as_str(),
            fixture.verdict.candidate_view_digest.as_str(),
        )),
    );
    apply(
        state,
        &event_of(
            fixture.run_id,
            EventKind::ModelActionAuthorizedV1,
            Payload::ModelActionAuthorizedV1(reviewer_authorization),
        ),
    );
    for (kind, payload) in [
        (
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(fixture.reviewer_receipt.clone()),
        ),
        (
            EventKind::ActionReceiptSetRecordedV1,
            Payload::ActionReceiptSetRecordedV1(fixture.reviewer_set.clone()),
        ),
    ] {
        apply(state, &event_of(fixture.run_id, kind, payload));
    }
}

#[test]
fn v2_review_binds_passed_candidate_and_sealed_reviewer_action_evidence() {
    let fixture = v2_review_fixture();
    let reviewer_set_digest = fixture.reviewer_set.action_receipt_set_digest.clone();
    let mut state = ReplayState::default();
    apply_v2_review_prefix(&mut state, &fixture);
    apply(
        &mut state,
        &event_of(
            fixture.run_id,
            EventKind::ReviewVerdictRecordedV2,
            Payload::ReviewVerdictRecordedV2(fixture.verdict.clone()),
        ),
    );

    let workflow = state
        .workflow_instances
        .values()
        .find(|workflow| {
            workflow.workflow_id == fixture.candidate_dispatch.body.workflow_id
                && workflow.unit_id == fixture.candidate_dispatch.body.unit_id
                && workflow.attempt == fixture.candidate_dispatch.body.attempt
        })
        .expect("candidate workflow");
    assert_eq!(workflow.phase, WorkflowPhaseV1::ReviewApproved);
    let review = workflow.reviews.get("review-v2:1").expect("V2 review");
    assert_eq!(review.review_version, 2);
    assert_eq!(review.reviewer_unit_id.as_deref(), Some("review-unit-1"));
    assert_eq!(
        review.review_action_receipt_set_digest.as_deref(),
        Some(reviewer_set_digest.as_str())
    );
    assert_eq!(
        review
            .candidate_view
            .as_ref()
            .map(|view| view.candidate_ref.as_str()),
        Some("refs/buildplane/candidates/candidate-v2-1/run-1/1")
    );
}

#[test]
fn recorded_approval_request_binds_the_subsequent_promotion_decision() {
    let fixture = v2_review_fixture();
    let mut state = ReplayState::default();
    apply_v2_review_prefix(&mut state, &fixture);
    apply(
        &mut state,
        &event_of(
            fixture.run_id,
            EventKind::ReviewVerdictRecordedV2,
            Payload::ReviewVerdictRecordedV2(fixture.verdict.clone()),
        ),
    );

    let request = promotion_approval_request(&fixture);
    let request_event = event_of(
        fixture.run_id,
        EventKind::PromotionApprovalRequested,
        Payload::PromotionApprovalRequestedV1(request.clone()),
    );
    apply(&mut state, &request_event);

    let workflow = state
        .workflow_instances
        .values()
        .find(|workflow| {
            workflow.workflow_id == fixture.candidate_dispatch.body.workflow_id
                && workflow.unit_id == fixture.candidate_dispatch.body.unit_id
                && workflow.attempt == fixture.candidate_dispatch.body.attempt
        })
        .expect("candidate workflow");
    assert_eq!(workflow.phase, WorkflowPhaseV1::PromotionApprovalPending);
    assert_eq!(
        workflow
            .promotion_approval
            .as_ref()
            .expect("approval request projection")
            .event_id,
        request_event.id
    );

    let mut unbound_decision = promotion_decision_for_approval_request(&request);
    unbound_decision.promotion_approval_request_ref = None;
    apply(
        &mut state,
        &event_of(
            fixture.run_id,
            EventKind::PromotionDecisionRecorded,
            Payload::PromotionDecisionRecordedV1(unbound_decision),
        ),
    );
    let workflow = state
        .workflow_instance
        .as_ref()
        .expect("candidate workflow");
    assert_eq!(workflow.phase, WorkflowPhaseV1::PromotionApprovalPending);
    assert!(workflow.promotion.is_none());
    assert!(state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("promotion approval request")
    )));

    let mut wrong_target = promotion_decision_for_approval_request(&request);
    wrong_target.promotion_approval_request_ref = Some(request_event.id.to_string());
    wrong_target.target_ref = Some("refs/heads/other".into());
    apply(
        &mut state,
        &event_of(
            fixture.run_id,
            EventKind::PromotionDecisionRecorded,
            Payload::PromotionDecisionRecordedV1(wrong_target),
        ),
    );
    let workflow = state
        .workflow_instance
        .as_ref()
        .expect("candidate workflow");
    assert_eq!(workflow.phase, WorkflowPhaseV1::PromotionApprovalPending);
    assert!(workflow.promotion.is_none());

    let mut bound_decision = promotion_decision_for_approval_request(&request);
    bound_decision.promotion_approval_request_ref = Some(request_event.id.to_string());
    apply(
        &mut state,
        &event_of(
            fixture.run_id,
            EventKind::PromotionDecisionRecorded,
            Payload::PromotionDecisionRecordedV1(bound_decision),
        ),
    );
    let workflow = state
        .workflow_instance
        .as_ref()
        .expect("candidate workflow");
    assert_eq!(workflow.phase, WorkflowPhaseV1::PromotionPending);
    let request_ref = request_event.id.to_string();
    assert_eq!(
        workflow
            .promotion
            .as_ref()
            .expect("promotion decision")
            .decision
            .promotion_approval_request_ref
            .as_deref(),
        Some(request_ref.as_str())
    );
}

#[test]
fn approval_request_requires_approved_review_and_has_one_physical_event_identity() {
    let fixture = v2_review_fixture();
    let mut state = ReplayState::default();
    apply_v2_review_prefix(&mut state, &fixture);

    let request = promotion_approval_request(&fixture);
    apply(
        &mut state,
        &event_of(
            fixture.run_id,
            EventKind::PromotionApprovalRequested,
            Payload::PromotionApprovalRequestedV1(request.clone()),
        ),
    );
    let workflow = state
        .workflow_instances
        .values()
        .find(|workflow| {
            workflow.workflow_id == fixture.candidate_dispatch.body.workflow_id
                && workflow.unit_id == fixture.candidate_dispatch.body.unit_id
                && workflow.attempt == fixture.candidate_dispatch.body.attempt
        })
        .expect("candidate workflow");
    assert_eq!(workflow.phase, WorkflowPhaseV1::AcceptancePassed);
    assert!(workflow.promotion_approval.is_none());
    assert!(
        !state.issues.is_empty(),
        "unreviewed approval must be rejected"
    );

    let mut state = ReplayState::default();
    apply_v2_review_prefix(&mut state, &fixture);
    apply(
        &mut state,
        &event_of(
            fixture.run_id,
            EventKind::ReviewVerdictRecordedV2,
            Payload::ReviewVerdictRecordedV2(fixture.verdict.clone()),
        ),
    );
    let request_event = event_of(
        fixture.run_id,
        EventKind::PromotionApprovalRequested,
        Payload::PromotionApprovalRequestedV1(request.clone()),
    );
    apply(&mut state, &request_event);
    apply(&mut state, &request_event);
    assert!(state.issues.is_empty());

    apply(
        &mut state,
        &event_of(
            fixture.run_id,
            EventKind::PromotionApprovalRequested,
            Payload::PromotionApprovalRequestedV1(request),
        ),
    );
    let workflow = state
        .workflow_instance
        .as_ref()
        .expect("candidate workflow");
    assert_eq!(workflow.phase, WorkflowPhaseV1::PromotionApprovalPending);
    assert_eq!(
        workflow
            .promotion_approval
            .as_ref()
            .expect("original approval request")
            .event_id,
        request_event.id
    );
    assert!(state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("different promotion approval request")
    )));
}

#[test]
fn sealed_v3_reviewer_authorized_for_candidate_a_cannot_issue_verdict_for_candidate_b() {
    let run_id = RunId::new();
    let candidate_a_dispatch = dispatch_v3();
    let candidate_a_request = action_request(run_id, &candidate_a_dispatch, "candidate-a-action");
    let candidate_a_receipt =
        action_receipt(&candidate_a_request, ActionReceiptOutcomeV2::Succeeded);
    let candidate_a_set = action_receipt_set(&candidate_a_request, &candidate_a_receipt);
    let candidate_a = candidate_v2(run_id, &candidate_a_dispatch, &candidate_a_set);
    let candidate_a_acceptance = acceptance(CandidateAcceptanceOutcomeV1::Passed);

    let mut candidate_b_dispatch = dispatch_v3();
    candidate_b_dispatch.body.unit_id = "unit-2".into();
    candidate_b_dispatch.body.idempotency_key = "dispatch:workflow-1:unit-2:1".into();
    candidate_b_dispatch.envelope_digest = dispatch_envelope_v3_body_digest(
        &candidate_b_dispatch.body,
        candidate_b_dispatch.action_evidence_version,
        &candidate_b_dispatch.repository_binding_digest,
        &candidate_b_dispatch.ledger_authority_realm_digest,
        candidate_b_dispatch.governed_packet_digest.as_deref(),
    )
    .expect("serialize candidate B dispatch body");
    let candidate_b_request = action_request(run_id, &candidate_b_dispatch, "candidate-b-action");
    let candidate_b_receipt =
        action_receipt(&candidate_b_request, ActionReceiptOutcomeV2::Succeeded);
    let candidate_b_set = action_receipt_set(&candidate_b_request, &candidate_b_receipt);
    let mut candidate_b = candidate_v2(run_id, &candidate_b_dispatch, &candidate_b_set);
    candidate_b.candidate_id = "candidate-v2-2".into();
    candidate_b.candidate_ref = "refs/buildplane/candidates/candidate-v2-2/run-1/1".into();
    candidate_b.candidate_digest = DIGEST_B.into();
    candidate_b.candidate_commit_sha = "3".repeat(40);
    candidate_b.tree_digest = DIGEST_A.into();
    let mut candidate_b_acceptance = acceptance(CandidateAcceptanceOutcomeV1::Passed);
    candidate_b_acceptance.candidate_digest = candidate_b.candidate_digest.clone();
    candidate_b_acceptance.candidate_commit_sha = candidate_b.candidate_commit_sha.clone();
    candidate_b_acceptance.acceptance_ref = "acceptance:2".into();

    let reviewer_dispatch =
        reviewer_dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    let mut reviewer_request = action_request(run_id, &reviewer_dispatch, "review-action-a");
    reviewer_request.action_kind = ActionKindV1::Model;
    let candidate_view_a = review_v2_candidate_view(&reviewer_dispatch);
    let candidate_view_a_digest =
        candidate_view_v1_digest(&candidate_view_a).expect("hash candidate A view");
    let mut candidate_view_b = candidate_view_a.clone();
    candidate_view_b.candidate_ref = candidate_b.candidate_ref.clone();
    candidate_view_b.candidate_digest = candidate_b.candidate_digest.clone();
    candidate_view_b.candidate_commit_sha = candidate_b.candidate_commit_sha.clone();
    candidate_view_b.tree_digest = candidate_b.tree_digest.clone();
    let candidate_view_b_digest =
        candidate_view_v1_digest(&candidate_view_b).expect("hash candidate B view");
    let review_output_b = ReviewVerdictOutputV1 {
        candidate_digest: candidate_b.candidate_digest.clone(),
        candidate_commit_sha: candidate_b.candidate_commit_sha.clone(),
        decision: ReviewDecisionV1::Approve,
        findings: vec![],
        confidence: 0.98,
        candidate_view_digest: candidate_view_b_digest.clone(),
    };
    let review_output_b_digest =
        review_verdict_output_v1_digest(&review_output_b).expect("hash candidate B review output");
    let mut reviewer_receipt = action_receipt(&reviewer_request, ActionReceiptOutcomeV2::Succeeded);
    reviewer_receipt.result_ref = Some(format!("cas:{review_output_b_digest}"));
    reviewer_receipt.result_digest = Some(review_output_b_digest.clone());
    reviewer_receipt.authorization_ref =
        Some(format!("authorization:{}", reviewer_request.action_id));
    reviewer_receipt.completed_at = "2026-07-17T00:00:06Z".into();
    let reviewer_set = action_receipt_set(&reviewer_request, &reviewer_receipt);
    let mut verdict_b = review_v2(
        run_id,
        &candidate_b_dispatch,
        &reviewer_dispatch,
        &candidate_b_acceptance,
        &reviewer_request,
        &reviewer_receipt,
        &reviewer_set,
    );
    verdict_b.candidate_digest = candidate_b.candidate_digest.clone();
    verdict_b.candidate_commit_sha = candidate_b.candidate_commit_sha.clone();
    verdict_b.candidate_view = candidate_view_b;
    verdict_b.candidate_view_ref = "cas:candidate-view:b".into();
    verdict_b.candidate_view_digest = candidate_view_b_digest;
    verdict_b.review_output_ref = reviewer_receipt
        .result_ref
        .clone()
        .expect("reviewer receipt has a closed output ref");
    verdict_b.review_output_digest = review_output_b_digest;

    let mut state = ReplayState::default();
    let candidate_a_event = apply_candidate_v2_history(
        &mut state,
        run_id,
        &candidate_a_dispatch,
        &candidate_a_request,
        &candidate_a_receipt,
        &candidate_a_set,
        &candidate_a,
        &candidate_a_acceptance,
    );
    apply_candidate_v2_history(
        &mut state,
        run_id,
        &candidate_b_dispatch,
        &candidate_b_request,
        &candidate_b_receipt,
        &candidate_b_set,
        &candidate_b,
        &candidate_b_acceptance,
    );

    let reviewer_dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(reviewer_dispatch.clone()),
    );
    apply(&mut state, &reviewer_dispatch_event);
    let reviewer_request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(reviewer_request.clone()),
    );
    apply(&mut state, &reviewer_request_event);
    let mut intent = model_action_intent(
        &reviewer_request,
        &reviewer_dispatch_event,
        &reviewer_request_event,
    );
    intent.candidate_binding = Some(ModelActionCandidateBindingV1 {
        candidate_created_event_ref: candidate_a_event.id,
        candidate_digest: candidate_a.candidate_digest.clone(),
        candidate_commit_sha: candidate_a.candidate_commit_sha.clone(),
        candidate_view_ref: "cas:candidate-view:a".into(),
        candidate_view_digest: candidate_view_a_digest,
        candidate_view: candidate_view_a,
    });
    intent.intent_digest =
        model_action_intent_v1_digest(&intent).expect("rehash candidate A intent");
    let intent_event = model_action_intent_event(run_id, &intent);
    apply(&mut state, &intent_event);
    let authorization = model_action_authorization_v2(&intent_event, &intent);
    apply(
        &mut state,
        &model_action_authorization_v2_event(run_id, &intent_event, &authorization),
    );
    let mut reviewer_claim = activity_claim(
        run_id,
        &reviewer_dispatch_event,
        &reviewer_request_event,
        &reviewer_request,
    );
    reviewer_claim.claimed_at = "2026-07-17T00:00:05Z".into();
    let reviewer_claim_event = activity_claim_event(run_id, &reviewer_claim);
    apply(&mut state, &reviewer_claim_event);
    let mut reviewer_result = activity_result(
        &reviewer_claim_event,
        &reviewer_claim,
        ActivityResultOutcomeV1::Succeeded,
    );
    reviewer_result.result_ref = reviewer_receipt.result_ref.clone();
    reviewer_result.result_digest = reviewer_receipt.result_digest.clone();
    reviewer_result.recorded_at = "2026-07-17T00:00:06Z".into();
    apply(
        &mut state,
        &activity_result_event(run_id, &reviewer_claim_event, &reviewer_result),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(reviewer_receipt),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionReceiptSetRecordedV1,
            Payload::ActionReceiptSetRecordedV1(reviewer_set),
        ),
    );
    assert!(
        state.issues.is_empty(),
        "valid test setup: {:#?}",
        state.issues
    );

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ReviewVerdictRecordedV2,
            Payload::ReviewVerdictRecordedV2(verdict_b),
        ),
    );

    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("review verdict action intent and authorization must bind the exact target candidate"))
    }));
    let candidate_b_workflow = state
        .workflow_instances
        .values()
        .find(|workflow| workflow.unit_id == "unit-2")
        .expect("candidate B workflow");
    assert_eq!(
        candidate_b_workflow.phase,
        WorkflowPhaseV1::AcceptancePassed
    );
    assert!(candidate_b_workflow.reviews.is_empty());
}

#[test]
fn v2_review_rejects_mismatched_run_role_candidate_action_set_and_acceptance() {
    let fixture = v2_review_fixture();
    let mut state = ReplayState::default();
    apply_v2_review_prefix(&mut state, &fixture);

    let mut wrong_run = fixture.verdict.clone();
    wrong_run.run_id = "other-run".into();
    let mut wrong_role = fixture.verdict.clone();
    wrong_role.reviewer_execution_role = ExecutionRoleV1::Implementer;
    let mut wrong_candidate = fixture.verdict.clone();
    wrong_candidate.candidate_digest = DIGEST_B.into();
    wrong_candidate.review_output_digest =
        review_verdict_output_v1_digest(&ReviewVerdictOutputV1 {
            candidate_digest: wrong_candidate.candidate_digest.clone(),
            candidate_commit_sha: wrong_candidate.candidate_commit_sha.clone(),
            decision: wrong_candidate.decision,
            findings: wrong_candidate.findings.clone(),
            confidence: wrong_candidate.confidence,
            candidate_view_digest: wrong_candidate.candidate_view_digest.clone(),
        })
        .expect("rehash malformed candidate review output");
    let mut wrong_action_set = fixture.verdict.clone();
    wrong_action_set.review_action_receipt_set_digest = DIGEST_C.into();
    let mut missing_acceptance = fixture.verdict.clone();
    missing_acceptance.acceptance_ref = "acceptance:missing".into();

    for verdict in [
        wrong_run,
        wrong_role,
        wrong_candidate,
        wrong_action_set,
        missing_acceptance,
    ] {
        apply(
            &mut state,
            &event_of(
                fixture.run_id,
                EventKind::ReviewVerdictRecordedV2,
                Payload::ReviewVerdictRecordedV2(verdict),
            ),
        );
    }

    let candidate = state
        .workflow_instances
        .values()
        .find(|workflow| workflow.unit_id == "unit-1")
        .expect("candidate workflow remains projected");
    assert_eq!(candidate.phase, WorkflowPhaseV1::AcceptancePassed);
    let rejection_reasons = state
        .issues
        .iter()
        .filter_map(|issue| match issue {
            ReplayIssue::WorkflowTransitionRejected { reason, .. } => Some(reason.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert!(rejection_reasons
        .iter()
        .any(|reason| reason.contains("payload run_id")));
    assert!(rejection_reasons
        .iter()
        .any(|reason| reason.contains("read-only review role")));
    assert!(rejection_reasons.len() >= 5);
    assert!(rejection_reasons
        .iter()
        .any(|reason| reason.contains("sealed reviewer action receipt set")));
    assert!(rejection_reasons
        .iter()
        .any(|reason| reason.contains("acceptance evidence")));
}

#[test]
fn v3_candidate_does_not_accept_a_legacy_free_standing_review() {
    let fixture = v2_review_fixture();
    let mut state = ReplayState::default();
    apply_v2_review_prefix(&mut state, &fixture);

    apply(
        &mut state,
        &event_of(
            fixture.run_id,
            EventKind::ReviewVerdictRecorded,
            Payload::ReviewVerdictRecordedV1(review(ReviewDecisionV1::Approve)),
        ),
    );

    let candidate = state
        .workflow_instances
        .values()
        .find(|workflow| workflow.unit_id == "unit-1")
        .expect("candidate workflow remains projected");
    assert_eq!(candidate.phase, WorkflowPhaseV1::AcceptancePassed);
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("requires review_verdict_recorded_v2 evidence"))
    }));
}

#[test]
fn v3_action_request_projects_pending_recovery_before_candidate_creation() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3();
    let request = action_request(run_id, &dispatch, "action-1");
    let mut state = ReplayState::default();

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::DispatchEnvelopeV3,
            Payload::DispatchEnvelopeV3(dispatch),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionRequestedV2,
            Payload::ActionRequestedV2(request),
        ),
    );

    let workflow = state.workflow_instance.as_ref().expect("V3 workflow state");
    let evidence = workflow
        .action_evidence
        .as_ref()
        .expect("V3 action evidence projection");
    assert_eq!(evidence.pending_action_ids, vec!["action-1"]);
    assert!(evidence.unknown_action_ids.is_empty());
    assert!(workflow.candidate.is_none());
}

#[test]
fn sealed_v3_retry_dispatch_requires_a_recorded_prior_attempt_context() {
    let run_id = RunId::new();
    let mut retry = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    retry.body.attempt = 2;
    retry.body.idempotency_key = "dispatch:workflow-1:unit-1:2".into();
    retry.envelope_digest = dispatch_envelope_v3_body_digest(
        &retry.body,
        retry.action_evidence_version,
        &retry.repository_binding_digest,
        &retry.ledger_authority_realm_digest,
        retry.governed_packet_digest.as_deref(),
    )
    .expect("serialize retry dispatch body");
    let mut state = ReplayState::default();

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::DispatchEnvelopeV3,
            Payload::DispatchEnvelopeV3(retry),
        ),
    );

    assert!(state.workflow_instances.is_empty());
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("recorded prior-attempt context"))
    }));
}

#[test]
fn sealed_v3_retry_dispatch_projects_a_second_attempt_after_valid_lineage() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    let fixture = apply_failed_retry_attempt(&mut state, run_id);
    let retry = retry_dispatch(&fixture.prior_dispatch);
    let context = retry_attempt_context(run_id, &fixture, &retry);

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::AttemptContextRecordedV1,
            Payload::AttemptContextRecordedV1(context),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::DispatchEnvelopeV3,
            Payload::DispatchEnvelopeV3(retry),
        ),
    );

    assert!(
        state.issues.is_empty(),
        "valid retry lineage: {:#?}",
        state.issues
    );
    assert_eq!(state.attempt_contexts.len(), 1);
    assert!(state
        .workflow_instances
        .values()
        .any(|workflow| { workflow.attempt == 1 && workflow.phase == WorkflowPhaseV1::Failed }));
    assert!(state.workflow_instances.values().any(|workflow| {
        workflow.attempt == 2 && workflow.phase == WorkflowPhaseV1::Dispatched
    }));
    let retry_workflow = state
        .workflow_instances
        .values()
        .find(|workflow| workflow.attempt == 2)
        .expect("projected retry workflow");
    let consumed_context = retry_workflow
        .retry_context
        .as_ref()
        .expect("retry workflow records its consumed context");
    assert_eq!(
        consumed_context.context.retry_action_namespace,
        "retry-action:workflow-1:unit-1:2"
    );
    assert_eq!(
        consumed_context.context.next_dispatch_envelope_digest,
        retry_workflow.dispatch.envelope_digest
    );
}

#[test]
fn graph_bound_v4_retry_replays_json_round_tripped_authority_and_outer_envelope_context() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    let fixture = apply_failed_retry_attempt(&mut state, run_id);
    let retry_v3 = retry_dispatch(&fixture.prior_dispatch);
    let mut graph = WorkflowGraphDeclaredV2 {
        run_id: run_id.to_string(),
        workflow_id: retry_v3.body.workflow_id.clone(),
        workflow_revision: retry_v3.body.workflow_revision.clone(),
        nodes: vec![WorkflowGraphNodeV2 {
            unit_id: retry_v3.body.unit_id.clone(),
            depends_on: vec![],
            execution_role: retry_v3.body.execution_role,
            governed_packet_digest: retry_v3
                .governed_packet_digest
                .clone()
                .expect("sealed_v3 retry carries its packet digest"),
        }],
        max_concurrent: 1,
        graph_digest: String::new(),
        idempotency_key: "graph-v2:workflow-1:r1".into(),
        declared_at: "2026-07-17T00:00:03Z".into(),
    };
    graph.graph_digest = workflow_graph_v2_digest(&graph).expect("hash graph declaration");
    let graph_event = event_of(
        run_id,
        EventKind::WorkflowGraphDeclaredV2,
        Payload::WorkflowGraphDeclaredV2(graph.clone()),
    );

    let mut retry_v4 = DispatchEnvelopeV4 {
        dispatch_v3: retry_v3.clone(),
        workflow_graph_digest: graph.graph_digest.clone(),
        workflow_graph_declaration_event_ref: graph_event.id,
        envelope_digest: String::new(),
    };
    retry_v4.envelope_digest = dispatch_envelope_v4_digest(
        &retry_v4.dispatch_v3,
        &retry_v4.workflow_graph_digest,
        &retry_v4.workflow_graph_declaration_event_ref,
    )
    .expect("hash graph-bound retry envelope");
    let mut retry_v4_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV4,
        Payload::DispatchEnvelopeV4(retry_v4.clone()),
    );
    retry_v4_event.parent_event_id = Some(graph_event.id);

    let mut context = retry_attempt_context(run_id, &fixture, &retry_v3);
    context.next_dispatch_envelope_digest = retry_v4.envelope_digest.clone();
    context.next_dispatch_idempotency_key = retry_v4.dispatch_v3.body.idempotency_key.clone();
    context.attempt_context_digest =
        attempt_context_recorded_v1_digest(&context).expect("hash V4 retry context");
    let context_event = event_of(
        run_id,
        EventKind::AttemptContextRecordedV1,
        Payload::AttemptContextRecordedV1(context),
    );

    let persisted_graph_event: Event =
        serde_json::from_str(&serde_json::to_string(&graph_event).expect("serialize graph event"))
            .expect("deserialize graph event");
    let persisted_context_event: Event = serde_json::from_str(
        &serde_json::to_string(&context_event).expect("serialize retry context event"),
    )
    .expect("deserialize retry context event");
    let persisted_retry_event: Event = serde_json::from_str(
        &serde_json::to_string(&retry_v4_event).expect("serialize V4 retry event"),
    )
    .expect("deserialize V4 retry event");

    apply(&mut state, &persisted_graph_event);
    apply(&mut state, &persisted_context_event);
    apply(&mut state, &persisted_retry_event);

    assert!(
        state.issues.is_empty(),
        "JSON-round-tripped V4 retry lineage: {:#?}",
        state.issues
    );
    let workflow = state
        .workflow_instances
        .values()
        .find(|workflow| workflow.dispatch.envelope_digest == retry_v4.envelope_digest)
        .expect("replayed V4 retry workflow");
    let body = &retry_v4.dispatch_v3.body;
    assert_eq!(workflow.attempt, 2);
    assert_eq!(workflow.dispatch.dispatch_version, 4);
    assert_eq!(workflow.dispatch.envelope_digest, retry_v4.envelope_digest);
    assert_eq!(workflow.dispatch.provenance_ref, body.provenance_ref);
    assert_eq!(workflow.dispatch.base_commit_sha, body.base_commit_sha);
    assert_eq!(
        workflow.dispatch.repository_binding_digest.as_deref(),
        Some(retry_v4.dispatch_v3.repository_binding_digest.as_str())
    );
    assert_eq!(
        workflow.dispatch.ledger_authority_realm_digest.as_deref(),
        Some(retry_v4.dispatch_v3.ledger_authority_realm_digest.as_str())
    );
    assert_eq!(
        workflow.dispatch.governed_packet_digest.as_deref(),
        retry_v4.dispatch_v3.governed_packet_digest.as_deref()
    );
    assert_eq!(
        workflow.dispatch.workflow_graph_digest.as_deref(),
        Some(retry_v4.workflow_graph_digest.as_str())
    );
    assert_eq!(
        workflow.dispatch.workflow_graph_declaration_event_ref,
        Some(graph_event.id)
    );
    assert_eq!(
        workflow.dispatch.capability_bundle_digest,
        body.capability_bundle_digest
    );
    assert_eq!(
        workflow.dispatch.acceptance_contract_digest,
        body.acceptance_contract_digest
    );
    assert_eq!(
        workflow.dispatch.context_manifest_digest,
        body.context_manifest_digest
    );
    assert_eq!(
        workflow.dispatch.worker_manifest_digest,
        body.worker_manifest_digest
    );
    assert_eq!(
        workflow.dispatch.sandbox_profile_digest,
        body.sandbox_profile_digest
    );
    assert_eq!(workflow.dispatch.execution_role, body.execution_role);
    assert_eq!(workflow.dispatch.commit_mode, body.commit_mode);
    assert_eq!(workflow.dispatch.budget, body.budget);
    assert_eq!(workflow.dispatch.trust_tier, body.trust_tier);
    assert_eq!(workflow.dispatch.idempotency_key, body.idempotency_key);
    assert_eq!(workflow.dispatch.issued_at, body.issued_at);
    assert_eq!(workflow.dispatch.expires_at, body.expires_at);
    assert_eq!(
        workflow.dispatch.action_evidence_version,
        Some(retry_v4.dispatch_v3.action_evidence_version)
    );
    assert_eq!(
        workflow
            .retry_context
            .as_ref()
            .expect("replayed retry context")
            .context
            .next_dispatch_envelope_digest,
        retry_v4.envelope_digest
    );
}

#[test]
fn sealed_v3_retry_action_request_rejects_a_reused_prior_attempt_identity_before_evidence() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    let fixture = apply_failed_retry_attempt(&mut state, run_id);
    let retry = retry_dispatch(&fixture.prior_dispatch);
    let context = retry_attempt_context(run_id, &fixture, &retry);

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::AttemptContextRecordedV1,
            Payload::AttemptContextRecordedV1(context),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::DispatchEnvelopeV3,
            Payload::DispatchEnvelopeV3(retry.clone()),
        ),
    );

    // This duplicates the exact action identity that produced the terminal
    // failure in attempt 1. A retry must use its signed context namespace,
    // rather than treating the fresh dispatch as permission to reuse it.
    let reused_request = action_request(run_id, &retry, "retryable-effect");
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionRequestedV2,
            Payload::ActionRequestedV2(reused_request),
        ),
    );

    let retry_workflow = state
        .workflow_instances
        .values()
        .find(|workflow| workflow.attempt == 2)
        .expect("projected retry workflow");
    assert!(
        retry_workflow
            .action_evidence
            .as_ref()
            .expect("sealed V3 action evidence")
            .actions
            .is_empty(),
        "rejected retry identity must not enter action evidence"
    );
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("retry action") && reason.contains("namespace"))
    }));
}

#[test]
fn sealed_v3_retry_action_request_accepts_both_identities_in_the_signed_namespace() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    let fixture = apply_failed_retry_attempt(&mut state, run_id);
    let retry = retry_dispatch(&fixture.prior_dispatch);
    let context = retry_attempt_context(run_id, &fixture, &retry);
    let retry_namespace = context.retry_action_namespace.clone();

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::AttemptContextRecordedV1,
            Payload::AttemptContextRecordedV1(context),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::DispatchEnvelopeV3,
            Payload::DispatchEnvelopeV3(retry.clone()),
        ),
    );

    let mut request = action_request(
        run_id,
        &retry,
        &format!("{retry_namespace}:retryable-effect"),
    );
    request.idempotency_key = format!("{retry_namespace}:effect:retryable-effect");
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionRequestedV2,
            Payload::ActionRequestedV2(request.clone()),
        ),
    );

    assert!(
        state.issues.is_empty(),
        "namespaced retry action remains valid: {:#?}",
        state.issues
    );
    let retry_workflow = state
        .workflow_instances
        .values()
        .find(|workflow| workflow.attempt == 2)
        .expect("projected retry workflow");
    assert!(retry_workflow
        .action_evidence
        .as_ref()
        .expect("sealed V3 action evidence")
        .actions
        .contains_key(&request.action_id));
}

#[test]
fn sealed_v3_retry_context_rejects_conflicting_prior_lineage_and_next_envelope() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    let fixture = apply_failed_retry_attempt(&mut state, run_id);
    let retry = retry_dispatch(&fixture.prior_dispatch);
    let mut conflicting = retry_attempt_context(run_id, &fixture, &retry);
    conflicting.prior_dispatch_envelope_digest = DIGEST_C.into();
    conflicting.attempt_context_digest =
        attempt_context_recorded_v1_digest(&conflicting).expect("rehash conflicting retry context");

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::AttemptContextRecordedV1,
            Payload::AttemptContextRecordedV1(conflicting),
        ),
    );
    assert!(state.attempt_contexts.is_empty());
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("prior dispatch envelope digest"))
    }));

    let context = retry_attempt_context(run_id, &fixture, &retry);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::AttemptContextRecordedV1,
            Payload::AttemptContextRecordedV1(context),
        ),
    );
    let mut substituted_retry = retry;
    substituted_retry.body.idempotency_key = "dispatch:workflow-1:unit-1:2:substituted".into();
    substituted_retry.envelope_digest = dispatch_envelope_v3_body_digest(
        &substituted_retry.body,
        substituted_retry.action_evidence_version,
        &substituted_retry.repository_binding_digest,
        &substituted_retry.ledger_authority_realm_digest,
        substituted_retry.governed_packet_digest.as_deref(),
    )
    .expect("serialize substituted retry dispatch body");
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::DispatchEnvelopeV3,
            Payload::DispatchEnvelopeV3(substituted_retry),
        ),
    );

    assert!(!state
        .workflow_instances
        .values()
        .any(|workflow| workflow.attempt == 2));
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("exact next dispatch envelope digest"))
    }));
}

#[test]
fn sealed_v3_retry_context_allows_exact_event_replay_but_rejects_a_physical_duplicate() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    let fixture = apply_failed_retry_attempt(&mut state, run_id);
    let retry = retry_dispatch(&fixture.prior_dispatch);
    let context = retry_attempt_context(run_id, &fixture, &retry);
    let context_event = event_of(
        run_id,
        EventKind::AttemptContextRecordedV1,
        Payload::AttemptContextRecordedV1(context.clone()),
    );

    apply(&mut state, &context_event);
    apply(&mut state, &context_event);
    assert!(
        state.issues.is_empty(),
        "same event replay stays idempotent"
    );
    assert_eq!(state.attempt_contexts.len(), 1);

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::AttemptContextRecordedV1,
            Payload::AttemptContextRecordedV1(context),
        ),
    );

    assert_eq!(state.attempt_contexts.len(), 1);
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("physical duplicate attempt context"))
    }));
}

#[test]
fn sealed_v3_action_request_rejects_a_caller_selected_policy_digest() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    let mut request = action_request(run_id, &dispatch, "action-1");
    request.policy_digest = DIGEST_A.into();
    let mut state = ReplayState::default();

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::DispatchEnvelopeV3,
            Payload::DispatchEnvelopeV3(dispatch),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionRequestedV2,
            Payload::ActionRequestedV2(request),
        ),
    );

    let workflow = state.workflow_instance.as_ref().expect("V3 workflow state");
    assert!(workflow
        .action_evidence
        .as_ref()
        .expect("V3 action evidence")
        .actions
        .is_empty());
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("policy_digest does not match the policy binding"))
    }));
}

#[test]
fn v3_receipt_requires_a_prior_write_ahead_request() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3();
    let request = action_request(run_id, &dispatch, "action-1");
    let receipt = action_receipt(&request, ActionReceiptOutcomeV2::Succeeded);
    let mut state = ReplayState::default();

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::DispatchEnvelopeV3,
            Payload::DispatchEnvelopeV3(dispatch),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(receipt),
        ),
    );

    let workflow = state.workflow_instance.as_ref().expect("V3 workflow state");
    assert!(workflow
        .action_evidence
        .as_ref()
        .expect("action evidence")
        .actions
        .is_empty());
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("no prior V3 write-ahead request"))
    }));
}

#[test]
fn v3_divergent_receipt_cannot_replace_the_first_terminal_result() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3();
    let request = action_request(run_id, &dispatch, "action-1");
    let receipt = action_receipt(&request, ActionReceiptOutcomeV2::Succeeded);
    let mut divergent = receipt.clone();
    divergent.evidence_ref = "cas:evidence:tampered".into();
    let mut state = ReplayState::default();

    for (kind, payload) in [
        (
            EventKind::DispatchEnvelopeV3,
            Payload::DispatchEnvelopeV3(dispatch.clone()),
        ),
        (
            EventKind::ActionRequestedV2,
            Payload::ActionRequestedV2(request),
        ),
        (
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(receipt.clone()),
        ),
        (
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(divergent),
        ),
    ] {
        apply(&mut state, &event_of(run_id, kind, payload));
    }

    let receipt_state = state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("action-1"))
        .and_then(|action| action.receipt.as_ref())
        .expect("first immutable receipt remains");
    assert_eq!(receipt_state.evidence_ref, receipt.evidence_ref);
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("replace an immutable action result"))
    }));
}

#[test]
fn v3_seal_blocks_pending_unknown_and_post_seal_effects_before_candidate_creation() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3();
    let request = action_request(run_id, &dispatch, "action-1");
    let receipt = action_receipt(&request, ActionReceiptOutcomeV2::Succeeded);
    let set = action_receipt_set(&request, &receipt);
    let mut state = ReplayState::default();

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::DispatchEnvelopeV3,
            Payload::DispatchEnvelopeV3(dispatch.clone()),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionRequestedV2,
            Payload::ActionRequestedV2(request.clone()),
        ),
    );
    // A durable pending effect blocks sealing and therefore candidate creation.
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionReceiptSetRecordedV1,
            Payload::ActionReceiptSetRecordedV1(set.clone()),
        ),
    );
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("effects remain pending"))
    }));

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(receipt),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionReceiptSetRecordedV1,
            Payload::ActionReceiptSetRecordedV1(set.clone()),
        ),
    );

    let mut mismatched_candidate = candidate_v2(run_id, &dispatch, &set);
    mismatched_candidate.action_receipt_set_digest = DIGEST_C.into();
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateCreatedV2,
            Payload::CandidateCreatedV2(mismatched_candidate),
        ),
    );
    assert!(state
        .workflow_instance
        .as_ref()
        .is_some_and(|workflow| workflow.candidate.is_none()));

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateCreatedV2,
            Payload::CandidateCreatedV2(candidate_v2(run_id, &dispatch, &set)),
        ),
    );
    let workflow = state.workflow_instance.as_ref().expect("V3 workflow state");
    assert_eq!(workflow.phase, WorkflowPhaseV1::CandidateCreated);
    assert_eq!(
        workflow
            .candidate
            .as_ref()
            .and_then(|candidate| candidate.action_receipt_set_digest.as_deref()),
        Some(set.action_receipt_set_digest.as_str())
    );

    // The set is immutable: even a new valid request after it is sealed must
    // not become candidate lineage.
    let post_seal = action_request(run_id, &dispatch, "action-2");
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionRequestedV2,
            Payload::ActionRequestedV2(post_seal),
        ),
    );
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("after the action receipt set is sealed"))
    }));
}

#[test]
fn v3_unknown_receipt_is_exposed_for_recovery_and_cannot_be_sealed() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3();
    let request = action_request(run_id, &dispatch, "action-unknown");
    let unknown = action_receipt(&request, ActionReceiptOutcomeV2::Unknown);
    let set = action_receipt_set(&request, &unknown);
    let mut state = ReplayState::default();

    for (kind, payload) in [
        (
            EventKind::DispatchEnvelopeV3,
            Payload::DispatchEnvelopeV3(dispatch.clone()),
        ),
        (
            EventKind::ActionRequestedV2,
            Payload::ActionRequestedV2(request),
        ),
        (
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(unknown),
        ),
        (
            EventKind::ActionReceiptSetRecordedV1,
            Payload::ActionReceiptSetRecordedV1(set.clone()),
        ),
    ] {
        apply(&mut state, &event_of(run_id, kind, payload));
    }

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateCreatedV2,
            Payload::CandidateCreatedV2(candidate_v2(run_id, &dispatch, &set)),
        ),
    );

    let evidence = state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .expect("V3 action evidence");
    assert!(evidence.pending_action_ids.is_empty());
    assert_eq!(evidence.unknown_action_ids, vec!["action-unknown"]);
    assert!(evidence.sealed_receipt_set.is_none());
    assert!(state
        .workflow_instance
        .as_ref()
        .is_some_and(|workflow| workflow.candidate.is_none()));
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("action effects are unknown"))
    }));
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("pending or unknown"))
    }));
}

#[test]
fn v3_activity_claim_and_result_bind_one_exact_action_before_its_receipt() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3();
    let request = action_request(run_id, &dispatch, "action-claim");
    let mut state = ReplayState::default();
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch),
    );
    apply(&mut state, &dispatch_event);
    let request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request.clone()),
    );
    apply(&mut state, &request_event);

    let claim = activity_claim(run_id, &dispatch_event, &request_event, &request);
    let mut claim_event = event_of(
        run_id,
        EventKind::ActivityClaimedV1,
        Payload::ActivityClaimedV1(claim.clone()),
    );
    claim_event.parent_event_id = Some(request_event.id);
    apply(&mut state, &claim_event);

    let evidence = state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .expect("V3 action evidence");
    let projected_claim = evidence
        .actions
        .get("action-claim")
        .and_then(|action| action.activity_claim.as_ref())
        .expect("claim is projected under its exact action");
    assert_eq!(projected_claim.action_request_event_id, request_event.id);
    assert_eq!(projected_claim.dispatch_event_id, dispatch_event.id);
    assert!(projected_claim.result.is_none());

    let mut forged = activity_result(&claim_event, &claim, ActivityResultOutcomeV1::Succeeded);
    forged.claim_event_digest = DIGEST_B.into();
    let mut forged_event = event_of(
        run_id,
        EventKind::ActivityResultRecordedV1,
        Payload::ActivityResultRecordedV1(forged),
    );
    forged_event.parent_event_id = Some(claim_event.id);
    apply(&mut state, &forged_event);
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::ActivityTransitionRejected { reason, .. }
            if reason.contains("exact immutable execution lease"))
    }));

    let result = activity_result(&claim_event, &claim, ActivityResultOutcomeV1::Succeeded);
    let mut result_event = event_of(
        run_id,
        EventKind::ActivityResultRecordedV1,
        Payload::ActivityResultRecordedV1(result),
    );
    result_event.parent_event_id = Some(claim_event.id);
    apply(&mut state, &result_event);
    let receipt = action_receipt(&request, ActionReceiptOutcomeV2::Succeeded);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(receipt),
        ),
    );

    let action = state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("action-claim"))
        .expect("action projection");
    assert_eq!(
        action
            .activity_claim
            .as_ref()
            .and_then(|claim| claim.result.as_ref())
            .map(|result| result.outcome),
        Some(ActivityResultOutcomeV1::Succeeded)
    );
    assert!(action.receipt.is_some());
}

#[test]
fn activity_claim_projection_preserves_purpose_and_rejects_a_same_event_purpose_swap() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3();
    let request = action_request(run_id, &dispatch, "purpose-bound-claim");
    let mut state = ReplayState::default();
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch),
    );
    apply(&mut state, &dispatch_event);
    let request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request.clone()),
    );
    apply(&mut state, &request_event);

    let mut claim = activity_claim(run_id, &dispatch_event, &request_event, &request);
    claim.purpose = ActivityClaimPurposeV1::GovernedVerifierV1;
    let claim_event = activity_claim_event(run_id, &claim);
    apply(&mut state, &claim_event);

    let projected_claim = state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("purpose-bound-claim"))
        .and_then(|action| action.activity_claim.as_ref())
        .expect("claim is projected");
    assert_eq!(
        projected_claim.purpose,
        ActivityClaimPurposeV1::GovernedVerifierV1
    );

    // A legacy cached projection may have decoded the newly-added field as
    // `Generic`. Replaying the exact purpose-bound signed event must not treat
    // that cache entry as idempotent: the purpose is part of claim equality.
    state
        .workflow_instances
        .values_mut()
        .next()
        .and_then(|workflow| workflow.action_evidence.as_mut())
        .and_then(|evidence| evidence.actions.get_mut("purpose-bound-claim"))
        .and_then(|action| action.activity_claim.as_mut())
        .expect("claim remains projected")
        .purpose = ActivityClaimPurposeV1::Generic;
    apply(&mut state, &claim_event);

    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::ActivityTransitionRejected { reason, .. }
            if reason.contains("attempts to replace an immutable execution lease"))
    }));
}

#[test]
fn sealed_v3_requires_a_terminal_activity_result_but_sealed_v2_replays_legacy_receipts() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    let request = action_request(run_id, &dispatch, "sealed-v3-no-claim");
    let receipt = action_receipt(&request, ActionReceiptOutcomeV2::Succeeded);
    let mut state = ReplayState::default();

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::DispatchEnvelopeV3,
            Payload::DispatchEnvelopeV3(dispatch),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionRequestedV2,
            Payload::ActionRequestedV2(request),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(receipt),
        ),
    );
    assert!(state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("sealed-v3-no-claim"))
        .is_some_and(|action| action.receipt.is_none()));
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("sealed_v3 action receipts require a prior terminal activity claim result"))
    }));

    // The same receipt-only history remains readable under the prior sealed
    // protocol: SealedV3 is an additive hardening revision, not a historical
    // replay rewrite.
    let legacy_run_id = RunId::new();
    let legacy_dispatch = dispatch_v3();
    let legacy_request = action_request(legacy_run_id, &legacy_dispatch, "sealed-v2-legacy");
    let legacy_receipt = action_receipt(&legacy_request, ActionReceiptOutcomeV2::Succeeded);
    let mut legacy_state = ReplayState::default();
    apply(
        &mut legacy_state,
        &event_of(
            legacy_run_id,
            EventKind::DispatchEnvelopeV3,
            Payload::DispatchEnvelopeV3(legacy_dispatch),
        ),
    );
    apply(
        &mut legacy_state,
        &event_of(
            legacy_run_id,
            EventKind::ActionRequestedV2,
            Payload::ActionRequestedV2(legacy_request),
        ),
    );
    apply(
        &mut legacy_state,
        &event_of(
            legacy_run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(legacy_receipt),
        ),
    );
    assert!(legacy_state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("sealed-v2-legacy"))
        .is_some_and(|action| action.receipt.is_some()));
}

#[test]
fn sealed_v3_rejects_missing_or_mismatched_action_request_packet_digest() {
    for (label, governed_packet_digest) in
        [("missing", None), ("mismatched", Some(DIGEST_A.into()))]
    {
        let run_id = RunId::new();
        let dispatch = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
        let mut request = action_request(run_id, &dispatch, &format!("packet-{label}"));
        request.governed_packet_digest = governed_packet_digest;
        let mut state = ReplayState::default();

        apply(
            &mut state,
            &event_of(
                run_id,
                EventKind::DispatchEnvelopeV3,
                Payload::DispatchEnvelopeV3(dispatch),
            ),
        );
        apply(
            &mut state,
            &event_of(
                run_id,
                EventKind::ActionRequestedV2,
                Payload::ActionRequestedV2(request),
            ),
        );

        assert!(state
            .workflow_instance
            .as_ref()
            .and_then(|workflow| workflow.action_evidence.as_ref())
            .is_some_and(|evidence| evidence.actions.is_empty()));
        assert!(state.issues.iter().any(|issue| {
            matches!(issue, ReplayIssue::WorkflowTransitionRejected { reason, .. }
                if reason.contains("action evidence lineage does not match the signed V3 dispatch envelope"))
        }), "{label} packet digest must be rejected before replay projects an action");
    }
}

#[test]
fn activity_claim_cannot_arrive_after_its_terminal_receipt() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3();
    let request = action_request(run_id, &dispatch, "claim-after-receipt");
    let mut state = ReplayState::default();
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch),
    );
    let request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request.clone()),
    );
    apply(&mut state, &dispatch_event);
    apply(&mut state, &request_event);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(action_receipt(
                &request,
                ActionReceiptOutcomeV2::Succeeded,
            )),
        ),
    );

    let claim = activity_claim(run_id, &dispatch_event, &request_event, &request);
    apply(&mut state, &activity_claim_event(run_id, &claim));
    assert!(state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("claim-after-receipt"))
        .is_some_and(|action| action.activity_claim.is_none()));
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::ActivityTransitionRejected { reason, .. }
            if reason.contains("before its terminal action receipt"))
    }));
}

#[test]
fn sealed_v3_binds_activity_event_times_and_all_result_evidence_to_the_receipt() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    let request = action_request(run_id, &dispatch, "occurred-at-binding");
    let mut state = ReplayState::default();
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch),
    );
    let request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request.clone()),
    );
    apply(&mut state, &dispatch_event);
    apply(&mut state, &request_event);

    let claim = activity_claim(run_id, &dispatch_event, &request_event, &request);
    let mut mismatched_claim_event = event_of(
        run_id,
        EventKind::ActivityClaimedV1,
        Payload::ActivityClaimedV1(claim.clone()),
    );
    mismatched_claim_event.parent_event_id = Some(request_event.id);
    apply(&mut state, &mismatched_claim_event);
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::ActivityTransitionRejected { reason, .. }
            if reason.contains("bind claimed_at to event occurred_at"))
    }));

    let claim_event = activity_claim_event(run_id, &claim);
    apply(&mut state, &claim_event);
    let result = activity_result(&claim_event, &claim, ActivityResultOutcomeV1::Succeeded);
    let mut mismatched_result_event = event_of(
        run_id,
        EventKind::ActivityResultRecordedV1,
        Payload::ActivityResultRecordedV1(result.clone()),
    );
    mismatched_result_event.parent_event_id = Some(claim_event.id);
    apply(&mut state, &mismatched_result_event);
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::ActivityTransitionRejected { reason, .. }
            if reason.contains("bind recorded_at to event occurred_at"))
    }));

    apply(
        &mut state,
        &activity_result_event(run_id, &claim_event, &result),
    );
    let mut mismatched_receipt = action_receipt(&request, ActionReceiptOutcomeV2::Succeeded);
    mismatched_receipt.evidence_ref = "cas:evidence:substituted".into();
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(mismatched_receipt),
        ),
    );
    assert!(state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("occurred-at-binding"))
        .is_some_and(|action| action.receipt.is_none()));
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("does not agree with the immutable activity-claim terminal result"))
    }));

    // The evidence-ref equality check is semantic for every terminal result,
    // rather than a success-only output hash check.
    for (suffix, result_outcome, receipt_outcome) in [
        (
            "failed",
            ActivityResultOutcomeV1::Failed,
            ActionReceiptOutcomeV2::Failed,
        ),
        (
            "unknown",
            ActivityResultOutcomeV1::Unknown,
            ActionReceiptOutcomeV2::Unknown,
        ),
    ] {
        let case_run_id = RunId::new();
        let case_dispatch = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
        let case_request = action_request(case_run_id, &case_dispatch, suffix);
        let mut case_state = ReplayState::default();
        let case_dispatch_event = event_of(
            case_run_id,
            EventKind::DispatchEnvelopeV3,
            Payload::DispatchEnvelopeV3(case_dispatch),
        );
        let case_request_event = event_of(
            case_run_id,
            EventKind::ActionRequestedV2,
            Payload::ActionRequestedV2(case_request.clone()),
        );
        apply(&mut case_state, &case_dispatch_event);
        apply(&mut case_state, &case_request_event);
        let case_claim = activity_claim(
            case_run_id,
            &case_dispatch_event,
            &case_request_event,
            &case_request,
        );
        let case_claim_event = activity_claim_event(case_run_id, &case_claim);
        apply(&mut case_state, &case_claim_event);
        let case_result = activity_result(&case_claim_event, &case_claim, result_outcome);
        apply(
            &mut case_state,
            &activity_result_event(case_run_id, &case_claim_event, &case_result),
        );
        let mut case_receipt = action_receipt(&case_request, receipt_outcome);
        case_receipt.evidence_digest = DIGEST_B.into();
        apply(
            &mut case_state,
            &event_of(
                case_run_id,
                EventKind::ActionReceiptRecordedV2,
                Payload::ActionReceiptRecordedV2(case_receipt),
            ),
        );
        assert!(case_state
            .workflow_instance
            .as_ref()
            .and_then(|workflow| workflow.action_evidence.as_ref())
            .and_then(|evidence| evidence.actions.get(suffix))
            .is_some_and(|action| action.receipt.is_none()));
    }
}

#[test]
fn sealed_v3_failed_activity_is_terminal_not_pending_and_cannot_seal_a_candidate() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    let request = action_request(run_id, &dispatch, "terminal-failure");
    let mut state = ReplayState::default();
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch.clone()),
    );
    let request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request.clone()),
    );
    apply(&mut state, &dispatch_event);
    apply(&mut state, &request_event);
    let claim = activity_claim(run_id, &dispatch_event, &request_event, &request);
    let claim_event = activity_claim_event(run_id, &claim);
    apply(&mut state, &claim_event);
    let result = activity_result(&claim_event, &claim, ActivityResultOutcomeV1::Failed);
    apply(
        &mut state,
        &activity_result_event(run_id, &claim_event, &result),
    );
    let mut retryable_receipt = action_receipt(&request, ActionReceiptOutcomeV2::Failed);
    retryable_receipt
        .failure
        .as_mut()
        .expect("failed receipt has failure metadata")
        .retryable = true;
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(retryable_receipt),
        ),
    );
    assert!(state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("terminal-failure"))
        .is_some_and(|action| action.receipt.is_none()));

    let receipt = action_receipt(&request, ActionReceiptOutcomeV2::Failed);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(receipt.clone()),
        ),
    );

    let evidence = state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .expect("sealed-v3 action evidence");
    assert!(evidence.pending_action_ids.is_empty());
    assert!(evidence.unknown_action_ids.is_empty());
    assert_eq!(evidence.failed_action_ids, vec!["terminal-failure"]);

    let set = action_receipt_set(&request, &receipt);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionReceiptSetRecordedV1,
            Payload::ActionReceiptSetRecordedV1(set.clone()),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateCreatedV2,
            Payload::CandidateCreatedV2(candidate_v2(run_id, &dispatch, &set)),
        ),
    );
    assert!(state
        .workflow_instance
        .as_ref()
        .is_some_and(|workflow| workflow.candidate.is_none()));
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("terminal action failures remain"))
    }));
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("does not agree with the immutable activity-claim terminal result"))
    }));
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("cannot be created after a terminal action failure"))
    }));
}

#[test]
fn v3_expired_unknown_activity_result_blocks_candidate_recovery() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3();
    let request = action_request(run_id, &dispatch, "action-unknown-claim");
    let mut state = ReplayState::default();
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch),
    );
    apply(&mut state, &dispatch_event);
    let request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request.clone()),
    );
    apply(&mut state, &request_event);
    let mut claim = activity_claim(run_id, &dispatch_event, &request_event, &request);
    claim.lease_expires_at = "2026-07-17T00:00:01.500Z".into();
    let mut claim_event = event_of(
        run_id,
        EventKind::ActivityClaimedV1,
        Payload::ActivityClaimedV1(claim.clone()),
    );
    claim_event.parent_event_id = Some(request_event.id);
    apply(&mut state, &claim_event);
    let result = activity_result(&claim_event, &claim, ActivityResultOutcomeV1::Unknown);
    let mut result_event = event_of(
        run_id,
        EventKind::ActivityResultRecordedV1,
        Payload::ActivityResultRecordedV1(result),
    );
    result_event.parent_event_id = Some(claim_event.id);
    apply(&mut state, &result_event);
    let unknown_receipt = action_receipt(&request, ActionReceiptOutcomeV2::Unknown);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(unknown_receipt),
        ),
    );

    let evidence = state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .expect("V3 action evidence");
    assert!(evidence.pending_action_ids.is_empty());
    assert_eq!(evidence.unknown_action_ids, vec!["action-unknown-claim"]);
}

#[test]
fn v3_succeeded_model_receipt_requires_matching_native_authorization_evidence() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3();
    let mut request = action_request(run_id, &dispatch, "model-action-1");
    request.action_kind = ActionKindV1::Model;
    let mut receipt = action_receipt(&request, ActionReceiptOutcomeV2::Succeeded);
    let mut state = ReplayState::default();

    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch),
    );
    apply(&mut state, &dispatch_event);
    let request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request.clone()),
    );
    apply(&mut state, &request_event);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(receipt.clone()),
        ),
    );
    assert!(state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("model-action-1"))
        .is_some_and(|action| action.receipt.is_none()));
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("ModelActionAuthorizedV1"))
    }));

    let authorization = model_action_authorization(
        &request,
        &dispatch_event,
        &request_event,
        "authorization:model-action-1",
        None,
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ModelActionAuthorizedV1,
            Payload::ModelActionAuthorizedV1(authorization.clone()),
        ),
    );
    receipt.authorization_ref = Some("authorization:substituted-model-action-1".into());
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(receipt.clone()),
        ),
    );
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("does not match its native authorization record"))
    }));

    receipt.authorization_ref = Some(authorization.authorization_ref.clone());
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(receipt),
        ),
    );
    assert_eq!(
        state
            .workflow_instance
            .as_ref()
            .and_then(|workflow| workflow.action_evidence.as_ref())
            .and_then(|evidence| evidence.actions.get("model-action-1"))
            .and_then(|action| action.receipt.as_ref())
            .and_then(|stored| stored.authorization_ref.as_deref()),
        Some("authorization:model-action-1")
    );
    assert_eq!(
        state
            .workflow_instance
            .as_ref()
            .and_then(|workflow| workflow.action_evidence.as_ref())
            .and_then(|evidence| evidence.actions.get("model-action-1"))
            .and_then(|action| action.model_authorization.as_ref())
            .map(|stored| stored.model_request_digest.as_str()),
        Some(DIGEST_B)
    );
}

#[test]
fn v3_model_authorization_rejects_substituted_request_and_expired_authority() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3();
    let mut request = action_request(run_id, &dispatch, "model-action-lineage");
    request.action_kind = ActionKindV1::Model;
    let mut state = ReplayState::default();

    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch),
    );
    apply(&mut state, &dispatch_event);
    let request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request.clone()),
    );
    apply(&mut state, &request_event);

    let mut substituted_request = model_action_authorization(
        &request,
        &dispatch_event,
        &request_event,
        "authorization:substituted-request",
        None,
    );
    substituted_request.action_request_ref = EventId::new().to_string();
    substituted_request.authorization_digest =
        model_action_authorized_v1_digest(&substituted_request)
            .expect("rehash substituted request");
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ModelActionAuthorizedV1,
            Payload::ModelActionAuthorizedV1(substituted_request),
        ),
    );
    assert!(state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("model-action-lineage"))
        .is_some_and(|action| action.model_authorization.is_none()));
    assert!(
        !state.issues.is_empty(),
        "legacy V1 authority must be rejected"
    );

    let mut expired = model_action_authorization(
        &request,
        &dispatch_event,
        &request_event,
        "authorization:expired",
        None,
    );
    expired.expires_at = request.requested_at.clone();
    expired.authorization_digest =
        model_action_authorized_v1_digest(&expired).expect("rehash expired authorization");
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ModelActionAuthorizedV1,
            Payload::ModelActionAuthorizedV1(expired),
        ),
    );
    assert!(state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("model-action-lineage"))
        .is_some_and(|action| action.model_authorization.is_none()));
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("must outlive its V3 write-ahead request"))
    }));
}

#[test]
fn model_authorizations_cannot_outlive_the_signed_compute_deadline() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3_with_action_evidence_and_compute_budget(
        ActionEvidenceVersionV1::SealedV2,
        Some(10_000),
    );
    let mut request = action_request(run_id, &dispatch, "model-compute-deadline-v1");
    request.action_kind = ActionKindV1::Model;
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch),
    );
    let request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request.clone()),
    );
    let mut state = ReplayState::default();
    apply(&mut state, &dispatch_event);
    apply(&mut state, &request_event);
    let mut authorization = model_action_authorization(
        &request,
        &dispatch_event,
        &request_event,
        "authorization:compute-deadline-v1",
        None,
    );
    authorization.expires_at = "2026-07-17T00:00:20Z".into();
    authorization.authorization_digest =
        model_action_authorized_v1_digest(&authorization).expect("rehash V1 authorization");
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ModelActionAuthorizedV1,
            Payload::ModelActionAuthorizedV1(authorization),
        ),
    );
    assert!(state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("model-compute-deadline-v1"))
        .is_some_and(|action| action.model_authorization.is_none()));

    let run_id = RunId::new();
    let dispatch = dispatch_v3_with_action_evidence_and_compute_budget(
        ActionEvidenceVersionV1::SealedV3,
        Some(10_000),
    );
    let mut request = action_request(run_id, &dispatch, "model-compute-deadline-v2");
    request.action_kind = ActionKindV1::Model;
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch),
    );
    let request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request.clone()),
    );
    let mut state_v2 = ReplayState::default();
    apply(&mut state_v2, &dispatch_event);
    apply(&mut state_v2, &request_event);
    let intent = model_action_intent(&request, &dispatch_event, &request_event);
    let intent_event = model_action_intent_event(run_id, &intent);
    apply(&mut state_v2, &intent_event);
    let mut authorization = model_action_authorization_v2(&intent_event, &intent);
    authorization.expires_at = "2026-07-17T00:00:20Z".into();
    authorization.authorization_digest =
        model_action_authorized_v2_digest(&authorization).expect("rehash V2 authorization");
    apply(
        &mut state_v2,
        &model_action_authorization_v2_event(run_id, &intent_event, &authorization),
    );
    assert!(state_v2
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("model-compute-deadline-v2"))
        .is_some_and(|action| action.model_authorization.is_none()));
    assert!(has_activity_transition_rejection(
        &state,
        "signed compute deadline"
    ));
    assert!(has_activity_transition_rejection(
        &state_v2,
        "signed compute deadline"
    ));
}

#[test]
fn sealed_v3_model_authorization_requires_the_dispatch_packet_digest() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    let mut request = action_request(run_id, &dispatch, "model-packet-binding");
    request.action_kind = ActionKindV1::Model;
    let mut state = ReplayState::default();
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch),
    );
    apply(&mut state, &dispatch_event);
    let request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request.clone()),
    );
    apply(&mut state, &request_event);

    let mut authorization = model_action_authorization(
        &request,
        &dispatch_event,
        &request_event,
        "authorization:substituted-packet",
        None,
    );
    authorization.packet_digest = DIGEST_A.into();
    authorization.authorization_digest =
        model_action_authorized_v1_digest(&authorization).expect("rehash substituted packet");
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ModelActionAuthorizedV1,
            Payload::ModelActionAuthorizedV1(authorization),
        ),
    );

    assert!(state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("model-packet-binding"))
        .is_some_and(|action| action.model_authorization.is_none()));
    assert!(
        !state.issues.is_empty(),
        "legacy V1 authority must be rejected"
    );
}

#[test]
fn sealed_v3_model_actions_do_not_treat_legacy_v1_authorization_as_current_authority() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    let mut request = action_request(run_id, &dispatch, "model-v2-intent-required");
    request.action_kind = ActionKindV1::Model;
    let mut state = ReplayState::default();

    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch),
    );
    apply(&mut state, &dispatch_event);
    let request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request.clone()),
    );
    apply(&mut state, &request_event);

    let legacy_authorization = model_action_authorization(
        &request,
        &dispatch_event,
        &request_event,
        "authorization:legacy-v1",
        None,
    );
    let mut legacy_event = event_of(
        run_id,
        EventKind::ModelActionAuthorizedV1,
        Payload::ModelActionAuthorizedV1(legacy_authorization),
    );
    legacy_event.parent_event_id = Some(request_event.id);
    apply(&mut state, &legacy_event);

    assert!(state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("model-v2-intent-required"))
        .is_some_and(|action| action.model_authorization.is_none()));
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("ModelActionAuthorizedV2"))
    }));
}

#[test]
fn sealed_v3_model_action_authority_requires_parented_intent_and_exact_v2_evidence() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    let mut request = action_request(run_id, &dispatch, "model-v2-chain");
    request.action_kind = ActionKindV1::Model;
    let mut state = ReplayState::default();

    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch),
    );
    apply(&mut state, &dispatch_event);
    let request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request.clone()),
    );
    apply(&mut state, &request_event);

    let intent = model_action_intent(&request, &dispatch_event, &request_event);
    let intent_event = model_action_intent_event(run_id, &intent);
    apply(&mut state, &intent_event);

    let mut substituted_authorization = model_action_authorization_v2(&intent_event, &intent);
    substituted_authorization.trust_scope_evidence.digest = DIGEST_A.into();
    substituted_authorization.authorization_digest =
        model_action_authorized_v2_digest(&substituted_authorization)
            .expect("rehash substituted V2 authorization");
    apply(
        &mut state,
        &model_action_authorization_v2_event(run_id, &intent_event, &substituted_authorization),
    );
    assert!(state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("model-v2-chain"))
        .is_some_and(|action| action.model_authorization.is_none()));
    assert!(
        !state.issues.is_empty(),
        "substituted dynamic evidence must reject"
    );

    let authorization = model_action_authorization_v2(&intent_event, &intent);
    apply(
        &mut state,
        &model_action_authorization_v2_event(run_id, &intent_event, &authorization),
    );
    let action = state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("model-v2-chain"))
        .expect("model action projection");
    assert_eq!(
        action
            .model_intent
            .as_ref()
            .map(|stored| stored.intent_digest.as_str()),
        Some(intent.intent_digest.as_str())
    );
    assert_eq!(
        action
            .model_authorization
            .as_ref()
            .map(|stored| stored.authorization_version),
        Some(2)
    );
    assert_eq!(
        action
            .model_authorization
            .as_ref()
            .and_then(|stored| stored.intent_event_ref),
        Some(intent_event.id)
    );
}

#[test]
fn sealed_v3_action_request_must_bind_requested_at_to_its_signed_event() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    let request = action_request(run_id, &dispatch, "request-event-timestamp");
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch),
    );
    let mut request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request),
    );
    event_occurred_at(&mut request_event, "2026-07-17T00:00:01.000001Z");
    let mut state = ReplayState::default();
    apply(&mut state, &dispatch_event);
    apply(&mut state, &request_event);

    assert!(state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .is_some_and(|evidence| evidence.actions.is_empty()));
    assert!(has_activity_transition_rejection(
        &state,
        "sealed_v3 action request requested_at must equal its signed event occurred_at"
    ));
}

#[test]
fn sealed_v3_model_intent_cannot_predate_its_write_ahead_request() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    let mut request = action_request(run_id, &dispatch, "model-pre-request-intent");
    request.action_kind = ActionKindV1::Model;
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch),
    );
    let request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request.clone()),
    );
    let mut state = ReplayState::default();
    apply(&mut state, &dispatch_event);
    apply(&mut state, &request_event);

    let mut intent = model_action_intent(&request, &dispatch_event, &request_event);
    intent.intended_at = "2026-07-17T00:00:00Z".into();
    intent.intent_digest =
        model_action_intent_v1_digest(&intent).expect("rehash pre-request model intent");
    apply(&mut state, &model_action_intent_event(run_id, &intent));

    assert!(state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("model-pre-request-intent"))
        .is_some_and(|action| action.model_intent.is_none()));
    assert!(has_activity_transition_rejection(
        &state,
        "model action intent must not predate its V3 write-ahead request"
    ));
}

#[test]
fn sealed_v3_model_claim_keeps_full_precision_authorization_time() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    let mut request = action_request(run_id, &dispatch, "model-submillisecond-authority");
    request.action_kind = ActionKindV1::Model;
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch),
    );
    let request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request.clone()),
    );
    let intent = model_action_intent(&request, &dispatch_event, &request_event);
    let intent_event = model_action_intent_event(run_id, &intent);
    let authorization = model_action_authorization_v2(&intent_event, &intent);
    let mut authorization_event =
        model_action_authorization_v2_event(run_id, &intent_event, &authorization);
    event_occurred_at(&mut authorization_event, "2026-07-17T00:00:04.999900Z");
    let mut claim = activity_claim(run_id, &dispatch_event, &request_event, &request);
    claim.claimed_at = "2026-07-17T00:00:04.999500Z".into();
    let claim_event = activity_claim_event(run_id, &claim);
    let mut state = ReplayState::default();

    for event in [
        dispatch_event,
        request_event,
        intent_event,
        authorization_event,
        claim_event,
    ] {
        apply(&mut state, &event);
    }

    assert!(state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("model-submillisecond-authority"))
        .is_some_and(|action| action.activity_claim.is_none()));
    assert!(!state.issues.is_empty(), "early model claim must reject");
}

#[test]
fn sealed_v3_model_claim_requires_prior_intent_and_v2_authorization() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    let mut request = action_request(run_id, &dispatch, "model-claim-authority");
    request.action_kind = ActionKindV1::Model;
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch),
    );
    let request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request.clone()),
    );
    let claim = activity_claim(run_id, &dispatch_event, &request_event, &request);
    let claim_event = activity_claim_event(run_id, &claim);
    let mut state = ReplayState::default();

    apply(&mut state, &dispatch_event);
    apply(&mut state, &request_event);
    apply(&mut state, &claim_event);

    assert!(state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("model-claim-authority"))
        .is_some_and(|action| action.activity_claim.is_none()));
    assert!(
        !state.issues.is_empty(),
        "unapproved model claim must reject"
    );
}

#[test]
fn sealed_v3_model_result_requires_a_live_prior_authorization() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    let mut request = action_request(run_id, &dispatch, "model-result-authority");
    request.action_kind = ActionKindV1::Model;
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch),
    );
    let request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request.clone()),
    );
    let intent = model_action_intent(&request, &dispatch_event, &request_event);
    let intent_event = model_action_intent_event(run_id, &intent);
    let mut authorization = model_action_authorization_v2(&intent_event, &intent);
    authorization.expires_at = "2026-07-17T00:00:05.500Z".into();
    authorization.authorization_digest =
        model_action_authorized_v2_digest(&authorization).expect("rehash expiring authorization");
    let authorization_event =
        model_action_authorization_v2_event(run_id, &intent_event, &authorization);
    let mut claim = activity_claim(run_id, &dispatch_event, &request_event, &request);
    claim.claimed_at = "2026-07-17T00:00:05Z".into();
    let claim_event = activity_claim_event(run_id, &claim);
    let mut result = activity_result(&claim_event, &claim, ActivityResultOutcomeV1::Succeeded);
    result.recorded_at = "2026-07-17T00:00:06Z".into();
    let result_event = activity_result_event(run_id, &claim_event, &result);
    let mut state = ReplayState::default();

    for event in [
        dispatch_event,
        request_event,
        intent_event,
        authorization_event,
        claim_event,
        result_event,
    ] {
        apply(&mut state, &event);
    }

    assert!(state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("model-result-authority"))
        .and_then(|action| action.activity_claim.as_ref())
        .is_some_and(|claim| claim.result.is_none()));
    assert!(
        !state.issues.is_empty(),
        "expired model authorization must reject"
    );
}

#[test]
fn sealed_v3_signed_max_tokens_requires_complete_successful_model_usage() {
    for (case, input_tokens, output_tokens, expected_reason) in [
        (
            "missing",
            None,
            None,
            "requires both input_tokens and output_tokens",
        ),
        (
            "partial",
            Some(1),
            None,
            "must provide input_tokens and output_tokens together",
        ),
    ] {
        let run_id = RunId::new();
        let dispatch = sealed_v3_dispatch_with_max_tokens(10);
        let dispatch_event = event_of(
            run_id,
            EventKind::DispatchEnvelopeV3,
            Payload::DispatchEnvelopeV3(dispatch.clone()),
        );
        let mut state = ReplayState::default();
        apply(&mut state, &dispatch_event);
        let action_id = format!("model-token-usage-{case}");
        let mut receipt = sealed_v3_model_receipt(
            &mut state,
            run_id,
            &dispatch_event,
            &dispatch,
            &action_id,
            ActionReceiptOutcomeV2::Succeeded,
        );
        receipt.resource_usage.input_tokens = input_tokens;
        receipt.resource_usage.output_tokens = output_tokens;
        apply(
            &mut state,
            &event_of(
                run_id,
                EventKind::ActionReceiptRecordedV2,
                Payload::ActionReceiptRecordedV2(receipt),
            ),
        );

        assert!(
            state
                .workflow_instance
                .as_ref()
                .and_then(|workflow| workflow.action_evidence.as_ref())
                .and_then(|evidence| evidence.actions.get(&action_id))
                .is_some_and(|action| action.receipt.is_none()),
            "{case} model usage must not mutate the action receipt projection"
        );
        assert!(
            has_activity_transition_rejection(&state, expected_reason),
            "{case} model usage rejection: {:#?}",
            state.issues
        );
    }
}

#[test]
fn sealed_v3_model_receipt_cannot_predate_its_native_authorization() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch.clone()),
    );
    let mut state = ReplayState::default();
    apply(&mut state, &dispatch_event);
    let mut receipt = sealed_v3_model_receipt(
        &mut state,
        run_id,
        &dispatch_event,
        &dispatch,
        "model-receipt-before-authorization",
        ActionReceiptOutcomeV2::Succeeded,
    );
    receipt.completed_at = "2026-07-17T00:00:03.999999Z".into();
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(receipt),
        ),
    );

    assert!(state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("model-receipt-before-authorization"))
        .is_some_and(|action| action.receipt.is_none()));
    assert!(has_activity_transition_rejection(
        &state,
        "sealed_v3 model action receipt completed before its native authorization"
    ));
}

#[test]
fn sealed_v3_model_receipt_cannot_predate_its_native_activity_claim() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch.clone()),
    );
    let mut state = ReplayState::default();
    apply(&mut state, &dispatch_event);
    let mut receipt = sealed_v3_model_receipt(
        &mut state,
        run_id,
        &dispatch_event,
        &dispatch,
        "model-receipt-before-claim",
        ActionReceiptOutcomeV2::Succeeded,
    );
    receipt.completed_at = "2026-07-17T00:00:04.999999Z".into();
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(receipt),
        ),
    );

    assert!(state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("model-receipt-before-claim"))
        .is_some_and(|action| action.receipt.is_none()));
    assert!(has_activity_transition_rejection(
        &state,
        "sealed_v3 model action receipt completed before its native activity claim"
    ));
}

#[test]
fn sealed_v3_model_receipt_cannot_follow_its_terminal_activity_result() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch.clone()),
    );
    let mut state = ReplayState::default();
    apply(&mut state, &dispatch_event);
    let mut receipt = sealed_v3_model_receipt(
        &mut state,
        run_id,
        &dispatch_event,
        &dispatch,
        "model-receipt-after-result",
        ActionReceiptOutcomeV2::Succeeded,
    );
    receipt.completed_at = "2026-07-17T00:00:06.000001Z".into();
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(receipt),
        ),
    );

    assert!(state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("model-receipt-after-result"))
        .is_some_and(|action| action.receipt.is_none()));
    assert!(has_activity_transition_rejection(
        &state,
        "sealed_v3 model action receipt completed after its recorded terminal activity result"
    ));
}

#[test]
fn sealed_v3_signed_max_tokens_counts_metered_failed_model_calls() {
    let run_id = RunId::new();
    let dispatch = sealed_v3_dispatch_with_max_tokens(10);
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch.clone()),
    );
    let mut state = ReplayState::default();
    apply(&mut state, &dispatch_event);

    let mut metered_failure = sealed_v3_model_receipt(
        &mut state,
        run_id,
        &dispatch_event,
        &dispatch,
        "metered-model-failure",
        ActionReceiptOutcomeV2::Failed,
    );
    metered_failure.resource_usage.input_tokens = Some(8);
    metered_failure.resource_usage.output_tokens = Some(2);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(metered_failure),
        ),
    );
    assert!(
        state
            .workflow_instance
            .as_ref()
            .and_then(|workflow| workflow.action_evidence.as_ref())
            .and_then(|evidence| evidence.actions.get("metered-model-failure"))
            .is_some_and(|action| action.receipt.is_some()),
        "the failed but metered call is durable evidence"
    );

    let success = sealed_v3_model_receipt(
        &mut state,
        run_id,
        &dispatch_event,
        &dispatch,
        "model-success-after-metered-failure",
        ActionReceiptOutcomeV2::Succeeded,
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(success),
        ),
    );

    assert!(
        state
            .workflow_instance
            .as_ref()
            .and_then(|workflow| workflow.action_evidence.as_ref())
            .and_then(|evidence| evidence.actions.get("model-success-after-metered-failure"))
            .is_some_and(|action| action.receipt.is_none()),
        "a success that takes the aggregate from 10 to 12 must not be stored"
    );
    assert!(has_activity_transition_rejection(
        &state,
        "aggregate 12 exceeds the signed max_tokens budget of 10"
    ));
}

#[test]
fn sealed_v3_unmetered_model_failure_blocks_later_model_success_regardless_of_failure_code() {
    let run_id = RunId::new();
    let dispatch = sealed_v3_dispatch_with_max_tokens(10);
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch.clone()),
    );
    let mut state = ReplayState::default();
    apply(&mut state, &dispatch_event);

    let mut missing_usage = sealed_v3_model_receipt(
        &mut state,
        run_id,
        &dispatch_event,
        &dispatch,
        "invalid-model-completion-without-usage",
        ActionReceiptOutcomeV2::Failed,
    );
    missing_usage.resource_usage.input_tokens = None;
    missing_usage.resource_usage.output_tokens = None;
    missing_usage
        .failure
        .as_mut()
        .expect("failed receipt has failure evidence")
        .code = "invalid-model-completion".into();
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(missing_usage),
        ),
    );

    let success = sealed_v3_model_receipt(
        &mut state,
        run_id,
        &dispatch_event,
        &dispatch,
        "model-success-after-unmetered-failure",
        ActionReceiptOutcomeV2::Succeeded,
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(success),
        ),
    );

    assert!(
        state
            .workflow_instance
            .as_ref()
            .and_then(|workflow| workflow.action_evidence.as_ref())
            .and_then(|evidence| evidence
                .actions
                .get("model-success-after-unmetered-failure"))
            .is_some_and(|action| action.receipt.is_none()),
        "a later model success cannot make an unmetered failure auditable"
    );
    assert!(has_activity_transition_rejection(
        &state,
		"prior model receipt under signed max_tokens lacks a complete input_tokens/output_tokens pair"
    ));
}

#[test]
fn v3_non_success_model_receipts_remain_readable_without_authorization_reference() {
    for outcome in [
        ActionReceiptOutcomeV2::Failed,
        ActionReceiptOutcomeV2::Denied,
        ActionReceiptOutcomeV2::Unknown,
    ] {
        let run_id = RunId::new();
        let dispatch = dispatch_v3();
        let mut request = action_request(run_id, &dispatch, "model-action-non-success");
        request.action_kind = ActionKindV1::Model;
        let receipt = action_receipt(&request, outcome);
        let mut state = ReplayState::default();

        for (kind, payload) in [
            (
                EventKind::DispatchEnvelopeV3,
                Payload::DispatchEnvelopeV3(dispatch),
            ),
            (
                EventKind::ActionRequestedV2,
                Payload::ActionRequestedV2(request),
            ),
            (
                EventKind::ActionReceiptRecordedV2,
                Payload::ActionReceiptRecordedV2(receipt),
            ),
        ] {
            apply(&mut state, &event_of(run_id, kind, payload));
        }

        assert_eq!(
            state
                .workflow_instance
                .as_ref()
                .and_then(|workflow| workflow.action_evidence.as_ref())
                .and_then(|evidence| evidence.actions.get("model-action-non-success"))
                .and_then(|action| action.receipt.as_ref())
                .map(|stored| stored.outcome),
            Some(outcome)
        );
        assert!(!state.issues.iter().any(|issue| {
            matches!(issue, ReplayIssue::WorkflowTransitionRejected { reason, .. }
                if reason.contains("authorization_ref"))
        }));
    }
}

#[test]
fn v3_dispatch_rejects_legacy_candidate_events_before_they_can_bypass_action_sealing() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3();
    let mut legacy_candidate = candidate();
    legacy_candidate.workflow_id = dispatch.body.workflow_id.clone();
    legacy_candidate.unit_id = dispatch.body.unit_id.clone();
    legacy_candidate.attempt = dispatch.body.attempt;
    legacy_candidate.provenance_ref = dispatch.body.provenance_ref.clone();
    legacy_candidate.base_commit_sha = dispatch.body.base_commit_sha.clone();
    legacy_candidate.envelope_digest = dispatch.envelope_digest.clone();
    let mut state = ReplayState::default();

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::DispatchEnvelopeV3,
            Payload::DispatchEnvelopeV3(dispatch),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateCreated,
            Payload::CandidateCreatedV1(legacy_candidate),
        ),
    );

    assert!(state
        .workflow_instance
        .as_ref()
        .is_some_and(|workflow| workflow.candidate.is_none()));
    assert!(state.issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("legacy candidate v1 is not allowed"))
    }));
}

fn candidate() -> CandidateCreatedV1 {
    CandidateCreatedV1 {
        candidate_id: "candidate-1".into(),
        candidate_ref: "refs/buildplane/candidates/candidate-1/run-1/1".into(),
        workflow_id: "workflow-1".into(),
        unit_id: "unit-1".into(),
        attempt: 1,
        provenance_ref: "admission:1".into(),
        candidate_digest: DIGEST_A.into(),
        base_commit_sha: "1".repeat(40),
        candidate_commit_sha: "2".repeat(40),
        commit_digest: DIGEST_B.into(),
        tree_digest: DIGEST_C.into(),
        patch_digest: DIGEST_A.into(),
        changed_files_digest: DIGEST_B.into(),
        envelope_digest: DIGEST_C.into(),
        action_receipt_digest: DIGEST_A.into(),
    }
}

fn acceptance(outcome: CandidateAcceptanceOutcomeV1) -> CandidateAcceptanceRecordedV1 {
    CandidateAcceptanceRecordedV1 {
        candidate_digest: DIGEST_A.into(),
        candidate_commit_sha: "2".repeat(40),
        acceptance_ref: "acceptance:1".into(),
        acceptance_contract_digest: DIGEST_B.into(),
        acceptance_digest: DIGEST_B.into(),
        outcome,
        evaluated_at: "2026-07-17T00:01:00Z".into(),
    }
}

fn review(decision: ReviewDecisionV1) -> ReviewVerdictRecordedV1 {
    ReviewVerdictRecordedV1 {
        candidate_digest: DIGEST_A.into(),
        candidate_commit_sha: "2".repeat(40),
        review_ref: "review:1".into(),
        review_verdict_action_id: None,
        review_action_request_digest: None,
        review_action_receipt_ref: None,
        review_action_receipt_digest: None,
        review_output_ref: None,
        review_output_digest: None,
        decision,
        findings: vec![],
        confidence: 0.98,
        reviewer_manifest_digest: DIGEST_B.into(),
        reviewed_at: "2026-07-17T00:02:00Z".into(),
    }
}

fn review_v2(
    run_id: RunId,
    candidate_dispatch: &DispatchEnvelopeV3,
    reviewer_dispatch: &DispatchEnvelopeV3,
    acceptance: &CandidateAcceptanceRecordedV1,
    reviewer_request: &ActionRequestedV2,
    reviewer_receipt: &ActionReceiptRecordedV2,
    reviewer_set: &ActionReceiptSetRecordedV1,
) -> ReviewVerdictRecordedV2 {
    let candidate_view = review_v2_candidate_view(reviewer_dispatch);
    let review_output = review_v2_output(&candidate_view);
    let review_output_digest =
        review_verdict_output_v1_digest(&review_output).expect("hash closed review output");
    ReviewVerdictRecordedV2 {
        run_id: run_id.to_string(),
        workflow_id: candidate_dispatch.body.workflow_id.clone(),
        unit_id: candidate_dispatch.body.unit_id.clone(),
        attempt: candidate_dispatch.body.attempt,
        provenance_ref: candidate_dispatch.body.provenance_ref.clone(),
        candidate_digest: DIGEST_A.into(),
        candidate_commit_sha: "2".repeat(40),
        review_ref: "review-v2:1".into(),
        review_verdict_action_id: reviewer_request.action_id.clone(),
        review_action_request_digest: action_requested_v2_digest(reviewer_request)
            .expect("hash review action request"),
        review_action_receipt_ref: reviewer_receipt.action_receipt_ref.clone(),
        review_action_receipt_digest: action_receipt_recorded_v2_digest(reviewer_receipt)
            .expect("hash review action receipt"),
        review_output_ref: format!("cas:{review_output_digest}"),
        review_output_digest,
        decision: review_output.decision,
        findings: review_output.findings,
        confidence: review_output.confidence,
        acceptance_ref: acceptance.acceptance_ref.clone(),
        acceptance_digest: acceptance.acceptance_digest.clone(),
        acceptance_contract_digest: acceptance.acceptance_contract_digest.clone(),
        candidate_envelope_digest: candidate_dispatch.envelope_digest.clone(),
        reviewer_workflow_id: reviewer_dispatch.body.workflow_id.clone(),
        reviewer_dispatch_envelope_digest: reviewer_dispatch.envelope_digest.clone(),
        reviewer_unit_id: reviewer_dispatch.body.unit_id.clone(),
        reviewer_attempt: reviewer_dispatch.body.attempt,
        reviewer_execution_role: reviewer_dispatch.body.execution_role,
        review_action_receipt_set_ref: reviewer_set.action_receipt_set_ref.clone(),
        review_action_receipt_set_digest: reviewer_set.action_receipt_set_digest.clone(),
        candidate_view,
        candidate_view_ref: "cas:candidate-view:1".into(),
        candidate_view_digest: review_output.candidate_view_digest,
        reviewer_manifest_digest: reviewer_dispatch.body.worker_manifest_digest.clone(),
        reviewer_authority: "reviewer".into(),
        reviewed_at: "2026-07-17T00:02:00Z".into(),
    }
}

fn review_v2_candidate_view(reviewer_dispatch: &DispatchEnvelopeV3) -> CandidateViewV1 {
    CandidateViewV1 {
        candidate_ref: "refs/buildplane/candidates/candidate-v2-1/run-1/1".into(),
        candidate_digest: DIGEST_A.into(),
        candidate_commit_sha: "2".repeat(40),
        tree_digest: DIGEST_C.into(),
        reviewer_context_manifest_digest: reviewer_dispatch.body.context_manifest_digest.clone(),
        reviewer_sandbox_profile_digest: reviewer_dispatch.body.sandbox_profile_digest.clone(),
        mount_path_digest: DIGEST_B.into(),
        read_only: true,
        network_disabled: true,
    }
}

fn review_v2_output(candidate_view: &CandidateViewV1) -> ReviewVerdictOutputV1 {
    ReviewVerdictOutputV1 {
        candidate_digest: DIGEST_A.into(),
        candidate_commit_sha: "2".repeat(40),
        decision: ReviewDecisionV1::Approve,
        findings: vec![],
        confidence: 0.98,
        candidate_view_digest: candidate_view_v1_digest(candidate_view)
            .expect("hash closed review candidate view"),
    }
}

fn promotion_decision(decision: PromotionDecisionKindV1) -> PromotionDecisionRecordedV1 {
    PromotionDecisionRecordedV1 {
        candidate_digest: DIGEST_A.into(),
        base_commit_sha: "1".repeat(40),
        target_ref: Some("refs/heads/main".into()),
        envelope_digest: DIGEST_C.into(),
        acceptance_ref: "acceptance:1".into(),
        review_refs: vec!["review:1".into()],
        promotion_approval_request_ref: None,
        decision,
        authority: "operator".into(),
        decided_by: "operator".into(),
        decided_at: "2026-07-17T00:03:00Z".into(),
        idempotency_key: "promotion:1".into(),
    }
}

fn promotion_execution_claim(
    run_id: RunId,
    dispatch_event: &Event,
    candidate_digest: &str,
    candidate_ref: &str,
    candidate_commit_sha: &str,
    candidate_tree_digest: &str,
    base_commit_sha: &str,
    dispatch_envelope_digest: &str,
    decision_event: &Event,
    decision: &PromotionDecisionRecordedV1,
) -> PromotionExecutionClaimedV1 {
    let mut claim = PromotionExecutionClaimedV1 {
        run_id: run_id.to_string(),
        promotion_decision_event_ref: decision_event.id,
        promotion_decision_event_digest: canonical_event_hash(decision_event)
            .expect("hash promotion decision"),
        dispatch_event_ref: dispatch_event.id,
        dispatch_envelope_digest: dispatch_envelope_digest.into(),
        candidate_digest: candidate_digest.into(),
        candidate_ref: candidate_ref.into(),
        candidate_commit_sha: candidate_commit_sha.into(),
        candidate_tree_digest: candidate_tree_digest.into(),
        base_commit_sha: base_commit_sha.into(),
        target_ref: decision.target_ref.clone().expect("bound promotion target"),
        idempotency_key: decision.idempotency_key.clone(),
        authority_actor: "kernel".into(),
        lease_id: "promotion-lease:fixture".into(),
        claimed_at: "2026-07-17T00:03:01Z".into(),
        lease_expires_at: "2026-07-17T00:04:01Z".into(),
        promotion_execution_claim_digest: String::new(),
    };
    claim.promotion_execution_claim_digest =
        promotion_execution_claimed_v1_digest(&claim).expect("hash promotion execution claim");
    claim
}

fn promotion_execution_claim_event(run_id: RunId, claim: &PromotionExecutionClaimedV1) -> Event {
    let mut event = event_of(
        run_id,
        EventKind::PromotionExecutionClaimedV1,
        Payload::PromotionExecutionClaimedV1(claim.clone()),
    );
    event.parent_event_id = Some(claim.promotion_decision_event_ref);
    event_occurred_at(&mut event, &claim.claimed_at);
    event
}

fn promotion_approval_request(fixture: &V2ReviewFixture) -> PromotionApprovalRequestedV1 {
    PromotionApprovalRequestedV1 {
        candidate_digest: fixture.candidate.candidate_digest.clone(),
        base_commit_sha: fixture.candidate.base_commit_sha.clone(),
        target_ref: "refs/heads/main".into(),
        envelope_digest: fixture.candidate.envelope_digest.clone(),
        acceptance_ref: fixture.candidate_acceptance.acceptance_ref.clone(),
        review_refs: vec![fixture.verdict.review_ref.clone()],
        requested_by: "kernel".into(),
        requested_at: "2026-07-17T00:03:00Z".into(),
        idempotency_key: "promotion:1".into(),
    }
}

fn promotion_decision_for_approval_request(
    request: &PromotionApprovalRequestedV1,
) -> PromotionDecisionRecordedV1 {
    PromotionDecisionRecordedV1 {
        candidate_digest: request.candidate_digest.clone(),
        base_commit_sha: request.base_commit_sha.clone(),
        target_ref: Some(request.target_ref.clone()),
        envelope_digest: request.envelope_digest.clone(),
        acceptance_ref: request.acceptance_ref.clone(),
        review_refs: request.review_refs.clone(),
        promotion_approval_request_ref: None,
        decision: PromotionDecisionKindV1::Promote,
        authority: "operator".into(),
        decided_by: "operator".into(),
        decided_at: "2026-07-17T00:04:00Z".into(),
        idempotency_key: request.idempotency_key.clone(),
    }
}

fn promotion_result(
    outcome: PromotionResultOutcomeV1,
    promotion_decision_ref: String,
) -> PromotionResultRecordedV1 {
    PromotionResultRecordedV1 {
        candidate_digest: DIGEST_A.into(),
        idempotency_key: "promotion:1".into(),
        promotion_decision_ref,
        outcome,
        merged_head_sha: match outcome {
            PromotionResultOutcomeV1::Promoted
            | PromotionResultOutcomeV1::ReconciliationRequired => Some("3".repeat(40)),
            PromotionResultOutcomeV1::Rejected => None,
        },
        promotion_git_binding: match outcome {
            PromotionResultOutcomeV1::Promoted => Some(PromotionGitBindingV1 {
                target_ref: "refs/heads/main".into(),
                target_head_before_sha: "1".repeat(40),
                target_head_after_sha: Some("3".repeat(40)),
                merged_head_sha: Some("3".repeat(40)),
                candidate_commit_sha: "2".repeat(40),
                merge_parent_shas: Some(vec!["1".repeat(40), "2".repeat(40)]),
                merged_tree_sha: Some("4".repeat(40)),
                merged_tree_digest: DIGEST_C.into(),
                promotion_receipt_ref: Some(
                    "refs/buildplane/promotions/candidate-1/run-1/1".into(),
                ),
                worktree_sync_state: Some(PromotionWorktreeSyncStateV1::PendingReconciliation),
            }),
            PromotionResultOutcomeV1::ReconciliationRequired => Some(PromotionGitBindingV1 {
                target_ref: "refs/heads/main".into(),
                target_head_before_sha: "1".repeat(40),
                target_head_after_sha: Some("4".repeat(40)),
                merged_head_sha: Some("3".repeat(40)),
                candidate_commit_sha: "2".repeat(40),
                merge_parent_shas: Some(vec!["1".repeat(40), "2".repeat(40)]),
                merged_tree_sha: Some("5".repeat(40)),
                merged_tree_digest: DIGEST_C.into(),
                promotion_receipt_ref: Some(
                    "refs/buildplane/promotions/candidate-1/run-1/1".into(),
                ),
                worktree_sync_state: Some(PromotionWorktreeSyncStateV1::TargetAdvanced),
            }),
            PromotionResultOutcomeV1::Rejected => None,
        },
        promotion_execution_lease_binding: None,
        completed_at: "2026-07-17T00:04:00Z".into(),
    }
}

#[test]
fn promotion_execution_claim_projects_an_exact_pending_promotion_binding() {
    let (mut state, run_id, _dispatch, dispatch_event, _schedule, _schedule_event) =
        lifecycle_timer_fixture();
    let reviewed =
        apply_sealed_v3_reviewed_candidate(&mut state, run_id, &_dispatch, &dispatch_event);
    let decision = PromotionDecisionRecordedV1 {
        candidate_digest: reviewed.candidate.candidate_digest.clone(),
        base_commit_sha: reviewed.candidate.base_commit_sha.clone(),
        target_ref: Some("refs/heads/main".into()),
        envelope_digest: reviewed.candidate.envelope_digest.clone(),
        acceptance_ref: reviewed.candidate_acceptance.acceptance_ref.clone(),
        review_refs: vec![reviewed.verdict.review_ref.clone()],
        promotion_approval_request_ref: None,
        decision: PromotionDecisionKindV1::Promote,
        authority: "operator".into(),
        decided_by: "operator".into(),
        decided_at: "2026-07-17T00:03:00Z".into(),
        idempotency_key: "promotion:execution-claim".into(),
    };
    let decision_event = event_of(
        run_id,
        EventKind::PromotionDecisionRecorded,
        Payload::PromotionDecisionRecordedV1(decision.clone()),
    );
    apply(&mut state, &decision_event);
    let candidate = state
        .workflow_instance
        .as_ref()
        .expect("workflow state")
        .candidate
        .as_ref()
        .expect("immutable candidate")
        .clone();

    let claim = promotion_execution_claim(
        run_id,
        &dispatch_event,
        &candidate.candidate_digest,
        &candidate.candidate_ref,
        &candidate.candidate_commit_sha,
        &candidate.tree_digest,
        &candidate.base_commit_sha,
        &candidate.envelope_digest,
        &decision_event,
        &decision,
    );
    let claim_event = promotion_execution_claim_event(run_id, &claim);
    apply(&mut state, &claim_event);

    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    let claim_state = workflow
        .promotion
        .as_ref()
        .expect("promotion state")
        .execution_claim
        .as_ref()
        .expect("immutable promotion execution claim");
    assert_eq!(workflow.phase, WorkflowPhaseV1::PromotionPending);
    assert_eq!(claim_state.event_id, claim_event.id);
    assert_eq!(claim_state.claim, claim);
    assert!(state.issues.is_empty());

    // Replaying the same signed event is idempotent, but a second claim for
    // the same promotion can never replace the immutable first projection.
    apply(&mut state, &claim_event);
    let mut divergent_claim = claim.clone();
    divergent_claim.lease_id = "promotion-lease:substituted".into();
    divergent_claim.promotion_execution_claim_digest =
        promotion_execution_claimed_v1_digest(&divergent_claim)
            .expect("rehash substituted promotion execution claim");
    apply(
        &mut state,
        &promotion_execution_claim_event(run_id, &divergent_claim),
    );
    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert_eq!(
        workflow
            .promotion
            .as_ref()
            .expect("promotion state")
            .execution_claim
            .as_ref()
            .expect("immutable promotion execution claim")
            .claim,
        claim
    );
    assert!(has_activity_transition_rejection(
        &state,
        "already has a different immutable execution claim"
    ));

    // `execution_claim` is additive projection evidence. A snapshot emitted
    // before this claim type existed must remain readable as a legacy tape
    // projection rather than gaining an invented claim.
    let mut legacy_snapshot =
        serde_json::to_value(workflow).expect("serialize pre-claim workflow snapshot");
    legacy_snapshot["promotion"]
        .as_object_mut()
        .expect("promotion projection")
        .remove("execution_claim");
    let restored: WorkflowInstanceV1 = serde_json::from_value(legacy_snapshot)
        .expect("pre-claim workflow snapshot remains readable");
    assert!(restored
        .promotion
        .as_ref()
        .expect("legacy promotion state")
        .execution_claim
        .is_none());
}

#[test]
fn promotion_result_after_execution_claim_rejects_a_substituted_lease_binding() {
    let (mut state, run_id, dispatch, dispatch_event, _schedule, _schedule_event) =
        lifecycle_timer_fixture();
    let reviewed =
        apply_sealed_v3_reviewed_candidate(&mut state, run_id, &dispatch, &dispatch_event);
    let decision = PromotionDecisionRecordedV1 {
        candidate_digest: reviewed.candidate.candidate_digest.clone(),
        base_commit_sha: reviewed.candidate.base_commit_sha.clone(),
        target_ref: Some("refs/heads/main".into()),
        envelope_digest: reviewed.candidate.envelope_digest.clone(),
        acceptance_ref: reviewed.candidate_acceptance.acceptance_ref.clone(),
        review_refs: vec![reviewed.verdict.review_ref.clone()],
        promotion_approval_request_ref: None,
        decision: PromotionDecisionKindV1::Promote,
        authority: "operator".into(),
        decided_by: "operator".into(),
        decided_at: "2026-07-17T00:03:00Z".into(),
        idempotency_key: "promotion:execution-claim-result".into(),
    };
    let decision_event = event_of(
        run_id,
        EventKind::PromotionDecisionRecorded,
        Payload::PromotionDecisionRecordedV1(decision.clone()),
    );
    apply(&mut state, &decision_event);
    let candidate = state
        .workflow_instance
        .as_ref()
        .expect("workflow state")
        .candidate
        .as_ref()
        .expect("immutable candidate")
        .clone();
    let claim = promotion_execution_claim(
        run_id,
        &dispatch_event,
        &candidate.candidate_digest,
        &candidate.candidate_ref,
        &candidate.candidate_commit_sha,
        &candidate.tree_digest,
        &candidate.base_commit_sha,
        &candidate.envelope_digest,
        &decision_event,
        &decision,
    );
    let claim_event = promotion_execution_claim_event(run_id, &claim);
    apply(&mut state, &claim_event);

    let mut result = promotion_result(
        PromotionResultOutcomeV1::ReconciliationRequired,
        decision_event.id.to_string(),
    );
    result.idempotency_key = decision.idempotency_key.clone();
    result.promotion_execution_lease_binding = Some(PromotionExecutionLeaseBindingV1 {
        promotion_execution_claim_event_ref: claim_event.id,
        promotion_execution_claim_event_digest: canonical_event_hash(&claim_event)
            .expect("hash promotion execution claim event"),
        lease_id: "substituted-promotion-lease".into(),
    });
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionResultRecorded,
            Payload::PromotionResultRecordedV1(result),
        ),
    );

    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert!(workflow
        .promotion
        .as_ref()
        .expect("promotion state")
        .result
        .is_none());
    assert!(has_activity_transition_rejection(
        &state,
        "does not bind the exact immutable execution claim"
    ));

    let mut exact_result = promotion_result(
        PromotionResultOutcomeV1::ReconciliationRequired,
        decision_event.id.to_string(),
    );
    exact_result.idempotency_key = decision.idempotency_key.clone();
    exact_result
        .promotion_git_binding
        .as_mut()
        .expect("strict reconciliation binding")
        .promotion_receipt_ref = Some(format!(
        "refs/buildplane/promotions/{}",
        candidate
            .candidate_ref
            .strip_prefix("refs/buildplane/candidates/")
            .expect("canonical candidate ref")
    ));
    exact_result.promotion_execution_lease_binding = Some(PromotionExecutionLeaseBindingV1 {
        promotion_execution_claim_event_ref: claim_event.id,
        promotion_execution_claim_event_digest: canonical_event_hash(&claim_event)
            .expect("hash promotion execution claim event"),
        lease_id: claim.lease_id.clone(),
    });
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionResultRecorded,
            Payload::PromotionResultRecordedV1(exact_result),
        ),
    );

    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert_eq!(
        workflow.phase,
        WorkflowPhaseV1::PromotionReconciliationRequired,
        "promotion reconciliation result was rejected: {:#?}",
        state.issues
    );
    assert!(workflow
        .promotion
        .as_ref()
        .expect("promotion state")
        .result
        .as_ref()
        .expect("exact claim binding result")
        .promotion_execution_lease_binding
        .is_some());
}

#[test]
fn promotion_execution_claim_rejects_substituted_parent_and_lineage_facts() {
    let (mut state, run_id, dispatch, dispatch_event, _schedule, _schedule_event) =
        lifecycle_timer_fixture();
    let reviewed =
        apply_sealed_v3_reviewed_candidate(&mut state, run_id, &dispatch, &dispatch_event);
    let decision = PromotionDecisionRecordedV1 {
        candidate_digest: reviewed.candidate.candidate_digest.clone(),
        base_commit_sha: reviewed.candidate.base_commit_sha.clone(),
        target_ref: Some("refs/heads/main".into()),
        envelope_digest: reviewed.candidate.envelope_digest.clone(),
        acceptance_ref: reviewed.candidate_acceptance.acceptance_ref.clone(),
        review_refs: vec![reviewed.verdict.review_ref.clone()],
        promotion_approval_request_ref: None,
        decision: PromotionDecisionKindV1::Promote,
        authority: "operator".into(),
        decided_by: "operator".into(),
        decided_at: "2026-07-17T00:03:00Z".into(),
        idempotency_key: "promotion:execution-claim-substitution".into(),
    };
    let decision_event = event_of(
        run_id,
        EventKind::PromotionDecisionRecorded,
        Payload::PromotionDecisionRecordedV1(decision.clone()),
    );
    apply(&mut state, &decision_event);
    let candidate = state
        .workflow_instance
        .as_ref()
        .expect("workflow state")
        .candidate
        .as_ref()
        .expect("immutable candidate")
        .clone();
    let valid = promotion_execution_claim(
        run_id,
        &dispatch_event,
        &candidate.candidate_digest,
        &candidate.candidate_ref,
        &candidate.candidate_commit_sha,
        &candidate.tree_digest,
        &candidate.base_commit_sha,
        &candidate.envelope_digest,
        &decision_event,
        &decision,
    );

    let mut wrong_decision_digest = valid.clone();
    wrong_decision_digest.promotion_decision_event_digest = DIGEST_B.into();
    wrong_decision_digest.promotion_execution_claim_digest =
        promotion_execution_claimed_v1_digest(&wrong_decision_digest)
            .expect("rehash substituted decision digest");
    let mut wrong_dispatch = valid.clone();
    wrong_dispatch.dispatch_envelope_digest = DIGEST_B.into();
    wrong_dispatch.promotion_execution_claim_digest =
        promotion_execution_claimed_v1_digest(&wrong_dispatch)
            .expect("rehash substituted dispatch");
    let mut wrong_candidate = valid.clone();
    wrong_candidate.candidate_ref = "refs/buildplane/candidates/other/run-1/1".into();
    wrong_candidate.promotion_execution_claim_digest =
        promotion_execution_claimed_v1_digest(&wrong_candidate)
            .expect("rehash substituted candidate");
    let mut wrong_target = valid.clone();
    wrong_target.target_ref = "refs/heads/release".into();
    wrong_target.promotion_execution_claim_digest =
        promotion_execution_claimed_v1_digest(&wrong_target).expect("rehash substituted target");
    let mut wrong_idempotency = valid.clone();
    wrong_idempotency.idempotency_key = "promotion:other".into();
    wrong_idempotency.promotion_execution_claim_digest =
        promotion_execution_claimed_v1_digest(&wrong_idempotency)
            .expect("rehash substituted idempotency key");

    let mut wrong_parent_event = promotion_execution_claim_event(run_id, &valid);
    wrong_parent_event.parent_event_id = Some(EventId::new());
    apply(&mut state, &wrong_parent_event);
    for claim in [
        wrong_decision_digest,
        wrong_dispatch,
        wrong_candidate,
        wrong_target,
        wrong_idempotency,
    ] {
        apply(&mut state, &promotion_execution_claim_event(run_id, &claim));
    }

    let promotion = state
        .workflow_instance
        .as_ref()
        .expect("workflow state")
        .promotion
        .as_ref()
        .expect("promotion state");
    assert!(promotion.execution_claim.is_none());
    assert!(state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("parent_event_id")
    )));
    assert!(state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("does not bind the exact sealed decision")
    )));
}

fn terminal(
    outcome: WorkflowTerminalOutcomeV1,
    promotion_result_ref: Option<String>,
) -> WorkflowTerminalV1 {
    WorkflowTerminalV1 {
        workflow_id: "workflow-1".into(),
        workflow_revision: "r1".into(),
        unit_id: "unit-1".into(),
        attempt: 1,
        outcome,
        candidate_digest: Some(DIGEST_A.into()),
        promotion_result_ref,
        reconciliation_resolution_ref: None,
        reason: None,
        idempotency_key: "terminal:1".into(),
        completed_at: "2026-07-17T00:05:00Z".into(),
    }
}

fn reconciliation_resolution(
    outcome: ReconciliationResolutionOutcomeV1,
    promotion_decision_ref: String,
    promotion_result_ref: String,
    promotion_receipt_ref: String,
) -> PromotionReconciliationResolvedV1 {
    PromotionReconciliationResolvedV1 {
        candidate_digest: DIGEST_A.into(),
        promotion_decision_ref,
        promotion_result_ref,
        promotion_receipt_ref,
        outcome,
        authority: "operator".into(),
        resolved_by: "operator".into(),
        idempotency_key: "reconciliation:promotion:1".into(),
        resolved_at: "2026-07-17T00:04:30Z".into(),
    }
}

fn apply_dispatch_and_candidate(state: &mut ReplayState, run_id: RunId) {
    apply(
        state,
        &event_of(
            run_id,
            EventKind::DispatchEnvelope,
            Payload::DispatchEnvelopeV1(dispatch()),
        ),
    );
    apply(
        state,
        &event_of(
            run_id,
            EventKind::CandidateCreated,
            Payload::CandidateCreatedV1(candidate()),
        ),
    );
}

#[test]
fn second_physical_candidate_created_v1_event_is_rejected_even_when_payload_is_identical() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelope,
        Payload::DispatchEnvelopeV1(dispatch()),
    );
    let candidate_payload = candidate();
    let first_candidate_event = event_of(
        run_id,
        EventKind::CandidateCreated,
        Payload::CandidateCreatedV1(candidate_payload.clone()),
    );
    let second_candidate_event = event_of(
        run_id,
        EventKind::CandidateCreated,
        Payload::CandidateCreatedV1(candidate_payload),
    );

    assert_ne!(first_candidate_event.id, second_candidate_event.id);
    apply(&mut state, &dispatch_event);
    apply(&mut state, &first_candidate_event);
    apply(&mut state, &second_candidate_event);

    let workflow = state
        .workflow_instance
        .as_ref()
        .expect("workflow has its first candidate");
    assert_eq!(
        workflow
            .candidate
            .as_ref()
            .map(|candidate| candidate.event_id),
        Some(first_candidate_event.id)
    );
    assert!(state.issues.iter().any(|issue| {
        matches!(issue,
            ReplayIssue::WorkflowTransitionRejected { event_id, reason, .. }
                if *event_id == second_candidate_event.id
                    && reason.contains("workflow already has a different immutable candidate"))
    }));
}

#[test]
fn second_physical_candidate_created_v2_event_is_rejected_even_when_payload_is_identical() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3();
    let request = action_request(run_id, &dispatch, "candidate-action");
    let receipt = action_receipt(&request, ActionReceiptOutcomeV2::Succeeded);
    let set = action_receipt_set(&request, &receipt);
    let candidate_payload = candidate_v2(run_id, &dispatch, &set);
    let first_candidate_event = event_of(
        run_id,
        EventKind::CandidateCreatedV2,
        Payload::CandidateCreatedV2(candidate_payload.clone()),
    );
    let second_candidate_event = event_of(
        run_id,
        EventKind::CandidateCreatedV2,
        Payload::CandidateCreatedV2(candidate_payload),
    );
    let mut state = ReplayState::default();

    assert_ne!(first_candidate_event.id, second_candidate_event.id);
    for (kind, payload) in [
        (
            EventKind::DispatchEnvelopeV3,
            Payload::DispatchEnvelopeV3(dispatch),
        ),
        (
            EventKind::ActionRequestedV2,
            Payload::ActionRequestedV2(request),
        ),
        (
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(receipt),
        ),
        (
            EventKind::ActionReceiptSetRecordedV1,
            Payload::ActionReceiptSetRecordedV1(set),
        ),
    ] {
        apply(&mut state, &event_of(run_id, kind, payload));
    }
    apply(&mut state, &first_candidate_event);
    apply(&mut state, &second_candidate_event);

    let workflow = state
        .workflow_instance
        .as_ref()
        .expect("workflow has its first candidate");
    assert_eq!(
        workflow
            .candidate
            .as_ref()
            .map(|candidate| candidate.event_id),
        Some(first_candidate_event.id)
    );
    assert!(state.issues.iter().any(|issue| {
        matches!(issue,
            ReplayIssue::WorkflowTransitionRejected { event_id, reason, .. }
                if *event_id == second_candidate_event.id
                    && reason.contains("workflow already has a different immutable candidate"))
    }));
}

#[test]
fn concurrent_unit_attempts_keep_independent_candidate_transactions() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();

    let first_dispatch = dispatch();
    let mut second_dispatch = dispatch();
    second_dispatch.unit_id = "unit-2".into();
    second_dispatch.attempt = 2;
    second_dispatch.idempotency_key = "dispatch:workflow-1:unit-2:2".into();
    second_dispatch.envelope_digest = DIGEST_A.into();

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::DispatchEnvelope,
            Payload::DispatchEnvelopeV1(first_dispatch),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::DispatchEnvelope,
            Payload::DispatchEnvelopeV1(second_dispatch),
        ),
    );

    let first_candidate = candidate();
    let mut second_candidate = candidate();
    second_candidate.candidate_id = "candidate-2".into();
    second_candidate.candidate_ref = "refs/buildplane/candidates/candidate-2".into();
    second_candidate.unit_id = "unit-2".into();
    second_candidate.attempt = 2;
    second_candidate.candidate_digest = DIGEST_B.into();
    second_candidate.candidate_commit_sha = "4".repeat(40);
    second_candidate.envelope_digest = DIGEST_A.into();

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateCreated,
            Payload::CandidateCreatedV1(first_candidate),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateCreated,
            Payload::CandidateCreatedV1(second_candidate),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(acceptance(
                CandidateAcceptanceOutcomeV1::Passed,
            )),
        ),
    );

    let mut second_acceptance = acceptance(CandidateAcceptanceOutcomeV1::Passed);
    second_acceptance.candidate_digest = DIGEST_B.into();
    second_acceptance.candidate_commit_sha = "4".repeat(40);
    second_acceptance.acceptance_ref = "acceptance:2".into();
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(second_acceptance),
        ),
    );
    let mut second_review = review(ReviewDecisionV1::Approve);
    second_review.candidate_digest = DIGEST_B.into();
    second_review.candidate_commit_sha = "4".repeat(40);
    second_review.review_ref = "review:2".into();
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ReviewVerdictRecorded,
            Payload::ReviewVerdictRecordedV1(second_review),
        ),
    );
    let mut second_promotion = promotion_decision(PromotionDecisionKindV1::Promote);
    second_promotion.candidate_digest = DIGEST_B.into();
    second_promotion.envelope_digest = DIGEST_A.into();
    second_promotion.acceptance_ref = "acceptance:2".into();
    second_promotion.review_refs = vec!["review:2".into()];
    second_promotion.idempotency_key = "promotion:2".into();
    let second_decision_event = event_of(
        run_id,
        EventKind::PromotionDecisionRecorded,
        Payload::PromotionDecisionRecordedV1(second_promotion),
    );
    let second_decision_ref = second_decision_event.id.to_string();
    apply(&mut state, &second_decision_event);
    let mut second_result = promotion_result(
        PromotionResultOutcomeV1::ReconciliationRequired,
        second_decision_ref,
    );
    second_result.candidate_digest = DIGEST_B.into();
    second_result.idempotency_key = "promotion:2".into();
    second_result.merged_head_sha = Some("5".repeat(40));
    second_result
        .promotion_git_binding
        .as_mut()
        .expect("promoted result binding")
        .candidate_commit_sha = "4".repeat(40);
    second_result
        .promotion_git_binding
        .as_mut()
        .expect("promoted result binding")
        .merge_parent_shas = Some(vec!["1".repeat(40), "4".repeat(40)]);
    second_result
        .promotion_git_binding
        .as_mut()
        .expect("promoted result binding")
        .merged_head_sha = Some("5".repeat(40));
    second_result
        .promotion_git_binding
        .as_mut()
        .expect("promoted result binding")
        .promotion_receipt_ref = Some("refs/buildplane/promotions/candidate-2".into());
    second_result
        .promotion_git_binding
        .as_mut()
        .expect("promoted result binding")
        .merged_tree_digest = DIGEST_C.into();
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionResultRecorded,
            Payload::PromotionResultRecordedV1(second_result),
        ),
    );

    assert_eq!(state.workflow_instances.len(), 2);
    let first = state
        .workflow_instances
        .values()
        .find(|workflow| workflow.unit_id == "unit-1" && workflow.attempt == 1)
        .expect("first unit attempt");
    let second = state
        .workflow_instances
        .values()
        .find(|workflow| workflow.unit_id == "unit-2" && workflow.attempt == 2)
        .expect("second unit attempt");
    assert_eq!(first.phase, WorkflowPhaseV1::AcceptancePassed);
    assert_eq!(
        second.phase,
        WorkflowPhaseV1::PromotionReconciliationRequired,
        "second promotion reconciliation was rejected: {:#?}",
        state.issues
    );
    assert_eq!(
        second
            .candidate
            .as_ref()
            .expect("second candidate")
            .candidate_digest,
        DIGEST_B
    );
    assert_eq!(
        state
            .workflow_instance
            .as_ref()
            .expect("compatibility view")
            .unit_id,
        "unit-2"
    );
    assert!(state.issues.is_empty());
}

#[test]
fn pre_candidate_terminal_binds_its_exact_graph_unit_attempt() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();

    let first_dispatch = dispatch();
    let mut second_dispatch = dispatch();
    second_dispatch.unit_id = "unit-2".into();
    second_dispatch.attempt = 2;
    second_dispatch.idempotency_key = "dispatch:workflow-1:unit-2:2".into();
    second_dispatch.envelope_digest = DIGEST_A.into();

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::DispatchEnvelope,
            Payload::DispatchEnvelopeV1(first_dispatch),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::DispatchEnvelope,
            Payload::DispatchEnvelopeV1(second_dispatch),
        ),
    );
    let mut failed_terminal = terminal(WorkflowTerminalOutcomeV1::Failed, None);
    failed_terminal.unit_id = "unit-2".into();
    failed_terminal.attempt = 2;
    failed_terminal.candidate_digest = None;
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::WorkflowTerminal,
            Payload::WorkflowTerminalV1(failed_terminal),
        ),
    );

    let first = state
        .workflow_instances
        .values()
        .find(|workflow| workflow.unit_id == "unit-1" && workflow.attempt == 1)
        .expect("first unit attempt");
    let second = state
        .workflow_instances
        .values()
        .find(|workflow| workflow.unit_id == "unit-2" && workflow.attempt == 2)
        .expect("second unit attempt");
    assert_eq!(first.phase, WorkflowPhaseV1::Dispatched);
    assert_eq!(second.phase, WorkflowPhaseV1::Failed);
    assert!(second.terminal.is_some());
    assert!(state.issues.is_empty());
}

#[test]
fn governed_dispatch_rejects_unsupported_commit_mode_before_creating_workflow_state() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    let mut invalid = dispatch();
    invalid.commit_mode = CommitModeV1::Saga;

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::DispatchEnvelope,
            Payload::DispatchEnvelopeV1(invalid),
        ),
    );

    assert!(state.workflow_instance.is_none());
    assert!(state.workflow_instances.is_empty());
    assert!(matches!(
        state.issues.as_slice(),
        [ReplayIssue::WorkflowTransitionRejected { reason, .. }]
            if reason.contains("only atomic commit mode")
    ));
}

#[test]
fn v2_dispatch_rejects_a_mutated_body_digest_before_creating_workflow_state() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    let mut invalid = dispatch_v2();
    invalid.envelope_digest = DIGEST_A.into();

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::DispatchEnvelopeV2,
            Payload::DispatchEnvelopeV2(invalid),
        ),
    );

    assert!(state.workflow_instance.is_none());
    assert!(state.workflow_instances.is_empty());
    assert!(matches!(
        state.issues.as_slice(),
        [ReplayIssue::WorkflowTransitionRejected { reason, .. }]
            if reason.contains("does not match the canonical body digest")
    ));
}

#[test]
fn v1_and_v2_dispatches_cannot_substitute_for_the_same_workflow_key() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::DispatchEnvelope,
            Payload::DispatchEnvelopeV1(dispatch()),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::DispatchEnvelopeV2,
            Payload::DispatchEnvelopeV2(dispatch_v2()),
        ),
    );

    let workflow = state.workflow_instance.as_ref().expect("v1 workflow state");
    assert_eq!(workflow.dispatch.dispatch_version, 1);
    assert!(workflow.dispatch.signature_ref.is_some());
    assert!(matches!(
        state.issues.as_slice(),
        [ReplayIssue::WorkflowTransitionRejected { event_kind, .. }]
            if event_kind == "dispatch_envelope_v2"
    ));
}

#[test]
fn legacy_v1_dispatch_snapshots_default_the_added_version_and_keep_signature_ref() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::DispatchEnvelope,
            Payload::DispatchEnvelopeV1(dispatch()),
        ),
    );

    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    let mut legacy_snapshot = serde_json::to_value(workflow).expect("serialize workflow state");
    legacy_snapshot["dispatch"]
        .as_object_mut()
        .expect("dispatch object")
        .remove("dispatch_version");
    legacy_snapshot
        .as_object_mut()
        .expect("workflow object")
        .remove("retry_context");
    let restored: WorkflowInstanceV1 =
        serde_json::from_value(legacy_snapshot).expect("deserialize legacy workflow state");

    assert_eq!(restored.dispatch.dispatch_version, 1);
    assert!(restored.dispatch.signature_ref.is_some());
    assert!(restored.retry_context.is_none());
}

#[test]
fn candidate_id_and_ref_are_unique_across_workflow_unit_attempts() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    let first_dispatch = dispatch();
    let mut second_dispatch = dispatch();
    second_dispatch.unit_id = "unit-2".into();
    second_dispatch.attempt = 2;
    second_dispatch.idempotency_key = "dispatch:workflow-1:unit-2:2".into();
    second_dispatch.envelope_digest = DIGEST_A.into();

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::DispatchEnvelope,
            Payload::DispatchEnvelopeV1(first_dispatch),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::DispatchEnvelope,
            Payload::DispatchEnvelopeV1(second_dispatch),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateCreated,
            Payload::CandidateCreatedV1(candidate()),
        ),
    );
    let mut colliding = candidate();
    colliding.unit_id = "unit-2".into();
    colliding.attempt = 2;
    colliding.envelope_digest = DIGEST_A.into();
    colliding.candidate_digest = DIGEST_B.into();
    colliding.candidate_commit_sha = "4".repeat(40);
    // Deliberately retain candidate_id and candidate_ref from the first unit.
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateCreated,
            Payload::CandidateCreatedV1(colliding),
        ),
    );

    let second = state
        .workflow_instances
        .values()
        .find(|workflow| workflow.unit_id == "unit-2")
        .expect("second workflow");
    assert!(second.candidate.is_none());
    assert!(state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("candidate digest, id, or ref")
    )));
}

#[test]
fn strict_target_bound_promotion_suspends_for_root_checkout_reconciliation() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();

    apply_dispatch_and_candidate(&mut state, run_id);
    assert_eq!(
        state.workflow_instance.as_ref().unwrap().phase,
        WorkflowPhaseV1::CandidateCreated
    );

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(acceptance(
                CandidateAcceptanceOutcomeV1::Passed,
            )),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ReviewVerdictRecorded,
            Payload::ReviewVerdictRecordedV1(review(ReviewDecisionV1::Approve)),
        ),
    );
    let decision_event = event_of(
        run_id,
        EventKind::PromotionDecisionRecorded,
        Payload::PromotionDecisionRecordedV1(promotion_decision(PromotionDecisionKindV1::Promote)),
    );
    let decision_ref = decision_event.id.to_string();
    apply(&mut state, &decision_event);
    let mut result = promotion_result(
        PromotionResultOutcomeV1::ReconciliationRequired,
        decision_ref,
    );
    let binding = result
        .promotion_git_binding
        .as_mut()
        .expect("reconciliation result carries Git binding");
    binding.target_head_after_sha = Some("3".repeat(40));
    binding.worktree_sync_state = Some(PromotionWorktreeSyncStateV1::RootCheckoutStale);
    let result_event = event_of(
        run_id,
        EventKind::PromotionResultRecorded,
        Payload::PromotionResultRecordedV1(result),
    );
    apply(&mut state, &result_event);

    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert_eq!(
        workflow.phase,
        WorkflowPhaseV1::PromotionReconciliationRequired
    );
    assert_eq!(
        workflow.candidate.as_ref().unwrap().candidate_digest,
        DIGEST_A
    );
    assert_eq!(
        workflow.acceptance.as_ref().unwrap().outcome,
        CandidateAcceptanceOutcomeV1::Passed
    );
    assert_eq!(
        workflow.reviews.get("review:1").unwrap().decision,
        ReviewDecisionV1::Approve
    );
    assert_eq!(
        workflow
            .promotion
            .as_ref()
            .unwrap()
            .result
            .as_ref()
            .unwrap()
            .outcome,
        PromotionResultOutcomeV1::ReconciliationRequired
    );
    assert!(workflow.terminal.is_none());
    assert!(state.issues.is_empty());
}

#[test]
fn repeated_promotion_decision_event_is_idempotent_but_a_second_event_is_rejected() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    apply_dispatch_and_candidate(&mut state, run_id);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(acceptance(
                CandidateAcceptanceOutcomeV1::Passed,
            )),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ReviewVerdictRecorded,
            Payload::ReviewVerdictRecordedV1(review(ReviewDecisionV1::Approve)),
        ),
    );
    let first_decision_event = event_of(
        run_id,
        EventKind::PromotionDecisionRecorded,
        Payload::PromotionDecisionRecordedV1(promotion_decision(PromotionDecisionKindV1::Promote)),
    );
    let duplicate_payload = match &first_decision_event.payload {
        Payload::PromotionDecisionRecordedV1(payload) => payload.clone(),
        _ => unreachable!("first decision event has its expected payload"),
    };
    let first_decision_digest =
        canonical_event_hash(&first_decision_event).expect("canonical promotion decision");
    apply(&mut state, &first_decision_event);
    apply(&mut state, &first_decision_event);
    assert!(state.issues.is_empty());

    // An event reference alone is not immutable evidence. If a corrupted tape
    // repeats the same event ID with altered envelope metadata, it must not
    // be treated as the idempotent first decision.
    let mut same_id_different_bytes = first_decision_event.clone();
    same_id_different_bytes.parent_event_id = Some(EventId::new());
    apply(&mut state, &same_id_different_bytes);

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionDecisionRecorded,
            Payload::PromotionDecisionRecordedV1(duplicate_payload),
        ),
    );

    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert_eq!(workflow.phase, WorkflowPhaseV1::PromotionPending);
    assert_eq!(
        workflow
            .promotion
            .as_ref()
            .expect("first decision remains projected")
            .decision
            .event_id,
        first_decision_event.id
    );
    assert_eq!(
        workflow
            .promotion
            .as_ref()
            .expect("first decision remains projected")
            .decision
            .event_digest,
        first_decision_digest
    );
    assert!(state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("different promotion decision")
    )));
}

#[test]
fn repeated_acceptance_and_v1_review_events_require_the_same_physical_event() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    apply_dispatch_and_candidate(&mut state, run_id);

    let acceptance_payload = acceptance(CandidateAcceptanceOutcomeV1::Passed);
    let first_acceptance_event = event_of(
        run_id,
        EventKind::CandidateAcceptanceRecorded,
        Payload::CandidateAcceptanceRecordedV1(acceptance_payload.clone()),
    );
    apply(&mut state, &first_acceptance_event);
    apply(&mut state, &first_acceptance_event);

    let review_payload = review(ReviewDecisionV1::Approve);
    let first_review_event = event_of(
        run_id,
        EventKind::ReviewVerdictRecorded,
        Payload::ReviewVerdictRecordedV1(review_payload.clone()),
    );
    apply(&mut state, &first_review_event);
    apply(&mut state, &first_review_event);
    assert!(state.issues.is_empty());

    let second_acceptance_event = event_of(
        run_id,
        EventKind::CandidateAcceptanceRecorded,
        Payload::CandidateAcceptanceRecordedV1(acceptance_payload),
    );
    let second_review_event = event_of(
        run_id,
        EventKind::ReviewVerdictRecorded,
        Payload::ReviewVerdictRecordedV1(review_payload),
    );
    assert_ne!(first_acceptance_event.id, second_acceptance_event.id);
    assert_ne!(first_review_event.id, second_review_event.id);
    apply(&mut state, &second_acceptance_event);
    apply(&mut state, &second_review_event);

    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert_eq!(
        workflow
            .acceptance
            .as_ref()
            .expect("first acceptance")
            .event_id,
        first_acceptance_event.id
    );
    assert_eq!(
        workflow
            .reviews
            .get("review:1")
            .expect("first review")
            .event_id,
        first_review_event.id
    );
    assert!(state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("candidate already has a different deterministic acceptance record")
    )));
    assert!(state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("review_ref is already bound to a different verdict")
    )));
}

#[test]
fn sealed_v3_repeated_acceptance_and_v2_review_events_require_the_same_physical_event() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch.clone()),
    );
    let mut state = ReplayState::default();
    apply(&mut state, &dispatch_event);
    let fixture =
        apply_sealed_v3_reviewed_candidate(&mut state, run_id, &dispatch, &dispatch_event);

    let first_acceptance_event_id = state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.acceptance.as_ref())
        .expect("first acceptance")
        .event_id;
    let first_review_event_id = state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.reviews.get(&fixture.verdict.review_ref))
        .expect("first review")
        .event_id;
    let second_acceptance_event = event_of(
        run_id,
        EventKind::CandidateAcceptanceRecorded,
        Payload::CandidateAcceptanceRecordedV1(fixture.candidate_acceptance.clone()),
    );
    let second_review_event = event_of(
        run_id,
        EventKind::ReviewVerdictRecordedV2,
        Payload::ReviewVerdictRecordedV2(fixture.verdict.clone()),
    );
    assert_ne!(first_acceptance_event_id, second_acceptance_event.id);
    assert_ne!(first_review_event_id, second_review_event.id);
    apply(&mut state, &second_acceptance_event);
    apply(&mut state, &second_review_event);

    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert_eq!(
        workflow
            .acceptance
            .as_ref()
            .expect("first acceptance")
            .event_id,
        first_acceptance_event_id
    );
    assert_eq!(
        workflow
            .reviews
            .get(&fixture.verdict.review_ref)
            .expect("first review")
            .event_id,
        first_review_event_id
    );
    assert!(state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("candidate already has a different deterministic acceptance record")
    )));
    assert!(state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("review_ref is already bound to a different verdict")
    )));
}

#[test]
fn repeated_promotion_result_event_is_idempotent_but_a_second_event_is_rejected() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    apply_dispatch_and_candidate(&mut state, run_id);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(acceptance(
                CandidateAcceptanceOutcomeV1::Passed,
            )),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ReviewVerdictRecorded,
            Payload::ReviewVerdictRecordedV1(review(ReviewDecisionV1::Approve)),
        ),
    );
    let decision_event = event_of(
        run_id,
        EventKind::PromotionDecisionRecorded,
        Payload::PromotionDecisionRecordedV1(promotion_decision(PromotionDecisionKindV1::Promote)),
    );
    let decision_ref = decision_event.id.to_string();
    apply(&mut state, &decision_event);

    let result_payload = promotion_result(
        PromotionResultOutcomeV1::ReconciliationRequired,
        decision_ref,
    );
    let first_result_event = event_of(
        run_id,
        EventKind::PromotionResultRecorded,
        Payload::PromotionResultRecordedV1(result_payload.clone()),
    );
    apply(&mut state, &first_result_event);
    apply(&mut state, &first_result_event);
    assert!(state.issues.is_empty());
    let duplicate_result_event = event_of(
        run_id,
        EventKind::PromotionResultRecorded,
        Payload::PromotionResultRecordedV1(result_payload),
    );
    apply(&mut state, &duplicate_result_event);

    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert_eq!(
        workflow.phase,
        WorkflowPhaseV1::PromotionReconciliationRequired
    );
    assert_eq!(
        workflow
            .promotion
            .as_ref()
            .and_then(|promotion| promotion.result.as_ref())
            .expect("first result remains projected")
            .event_id,
        first_result_event.id
    );
    assert!(state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("different recorded result")
    )));
}

#[test]
fn repeated_promotion_reconciliation_event_is_idempotent_but_a_second_event_is_rejected() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    apply_dispatch_and_candidate(&mut state, run_id);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(acceptance(
                CandidateAcceptanceOutcomeV1::Passed,
            )),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ReviewVerdictRecorded,
            Payload::ReviewVerdictRecordedV1(review(ReviewDecisionV1::Approve)),
        ),
    );
    let decision_event = event_of(
        run_id,
        EventKind::PromotionDecisionRecorded,
        Payload::PromotionDecisionRecordedV1(promotion_decision(PromotionDecisionKindV1::Promote)),
    );
    apply(&mut state, &decision_event);
    let result_event = event_of(
        run_id,
        EventKind::PromotionResultRecorded,
        Payload::PromotionResultRecordedV1(promotion_result(
            PromotionResultOutcomeV1::ReconciliationRequired,
            decision_event.id.to_string(),
        )),
    );
    apply(&mut state, &result_event);
    let first_reconciliation_event = event_of(
        run_id,
        EventKind::PromotionReconciliationResolved,
        Payload::PromotionReconciliationResolvedV1(reconciliation_resolution(
            ReconciliationResolutionOutcomeV1::Abandon,
            decision_event.id.to_string(),
            result_event.id.to_string(),
            "refs/buildplane/promotions/candidate-1/run-1/1".into(),
        )),
    );
    let duplicate_payload = match &first_reconciliation_event.payload {
        Payload::PromotionReconciliationResolvedV1(payload) => payload.clone(),
        _ => unreachable!("first reconciliation event has its expected payload"),
    };
    apply(&mut state, &first_reconciliation_event);
    apply(&mut state, &first_reconciliation_event);
    assert!(state.issues.is_empty());

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionReconciliationResolved,
            Payload::PromotionReconciliationResolvedV1(duplicate_payload),
        ),
    );

    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert_eq!(
        workflow.phase,
        WorkflowPhaseV1::PromotionReconciliationResolved
    );
    assert_eq!(
        workflow
            .promotion
            .as_ref()
            .and_then(|promotion| promotion.reconciliation.as_ref())
            .expect("first reconciliation remains projected")
            .event_id,
        first_reconciliation_event.id
    );
    assert!(state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("different recorded reconciliation resolution")
    )));
}

#[test]
fn divergent_duplicate_promotion_result_is_rejected_without_replacing_the_first_event() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    apply_dispatch_and_candidate(&mut state, run_id);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(acceptance(
                CandidateAcceptanceOutcomeV1::Passed,
            )),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ReviewVerdictRecorded,
            Payload::ReviewVerdictRecordedV1(review(ReviewDecisionV1::Approve)),
        ),
    );
    let decision_event = event_of(
        run_id,
        EventKind::PromotionDecisionRecorded,
        Payload::PromotionDecisionRecordedV1(promotion_decision(PromotionDecisionKindV1::Promote)),
    );
    let decision_ref = decision_event.id.to_string();
    apply(&mut state, &decision_event);

    let first_result_event = event_of(
        run_id,
        EventKind::PromotionResultRecorded,
        Payload::PromotionResultRecordedV1(promotion_result(
            PromotionResultOutcomeV1::ReconciliationRequired,
            decision_ref,
        )),
    );
    apply(&mut state, &first_result_event);
    let mut divergent_payload = match &first_result_event.payload {
        Payload::PromotionResultRecordedV1(payload) => payload.clone(),
        _ => unreachable!("first result event has its expected payload"),
    };
    divergent_payload.completed_at = "2026-07-17T00:04:01Z".into();
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionResultRecorded,
            Payload::PromotionResultRecordedV1(divergent_payload),
        ),
    );

    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert_eq!(
        workflow.phase,
        WorkflowPhaseV1::PromotionReconciliationRequired
    );
    assert_eq!(
        workflow
            .promotion
            .as_ref()
            .and_then(|promotion| promotion.result.as_ref())
            .expect("first result remains projected")
            .event_id,
        first_result_event.id
    );
    assert!(state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("different recorded result")
    )));
}

#[test]
fn target_bound_promotion_requires_matching_adapter_git_evidence() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    apply_dispatch_and_candidate(&mut state, run_id);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(acceptance(
                CandidateAcceptanceOutcomeV1::Passed,
            )),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ReviewVerdictRecorded,
            Payload::ReviewVerdictRecordedV1(review(ReviewDecisionV1::Approve)),
        ),
    );
    let decision_event = event_of(
        run_id,
        EventKind::PromotionDecisionRecorded,
        Payload::PromotionDecisionRecordedV1(promotion_decision(PromotionDecisionKindV1::Promote)),
    );
    let decision_ref = decision_event.id.to_string();
    apply(&mut state, &decision_event);

    let mut missing_binding = promotion_result(
        PromotionResultOutcomeV1::ReconciliationRequired,
        decision_ref.clone(),
    );
    missing_binding.promotion_git_binding = None;
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionResultRecorded,
            Payload::PromotionResultRecordedV1(missing_binding),
        ),
    );

    let mut wrong_target = promotion_result(
        PromotionResultOutcomeV1::ReconciliationRequired,
        decision_ref.clone(),
    );
    wrong_target
        .promotion_git_binding
        .as_mut()
        .expect("promoted result binding")
        .target_ref = "refs/heads/other".into();
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionResultRecorded,
            Payload::PromotionResultRecordedV1(wrong_target),
        ),
    );

    // A full-length, syntactically valid SHA is still invalid unless the
    // adapter binding proves it is the exact merge object it observed.
    let mut wrong_merge_sha = promotion_result(
        PromotionResultOutcomeV1::ReconciliationRequired,
        decision_ref.clone(),
    );
    wrong_merge_sha.merged_head_sha = Some("9".repeat(40));
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionResultRecorded,
            Payload::PromotionResultRecordedV1(wrong_merge_sha),
        ),
    );

    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert_eq!(workflow.phase, WorkflowPhaseV1::PromotionPending);
    assert!(workflow
        .promotion
        .as_ref()
        .expect("promotion state")
        .result
        .is_none());

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionResultRecorded,
            Payload::PromotionResultRecordedV1(promotion_result(
                PromotionResultOutcomeV1::ReconciliationRequired,
                decision_ref,
            )),
        ),
    );
    assert_eq!(
        state
            .workflow_instance
            .as_ref()
            .expect("workflow state")
            .phase,
        WorkflowPhaseV1::PromotionReconciliationRequired
    );
}

#[test]
fn promotion_receipt_rejects_a_candidate_ref_outside_the_canonical_grammar() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    apply_dispatch_and_candidate(&mut state, run_id);

    let forged_candidate_ref = "refs/buildplane/candidates/candidate~rewrite/run-1";
    state
        .workflow_instances
        .values_mut()
        .next()
        .expect("candidate workflow")
        .candidate
        .as_mut()
        .expect("candidate projection")
        .candidate_ref = forged_candidate_ref.into();

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(acceptance(
                CandidateAcceptanceOutcomeV1::Passed,
            )),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ReviewVerdictRecorded,
            Payload::ReviewVerdictRecordedV1(review(ReviewDecisionV1::Approve)),
        ),
    );
    let decision_event = event_of(
        run_id,
        EventKind::PromotionDecisionRecorded,
        Payload::PromotionDecisionRecordedV1(promotion_decision(PromotionDecisionKindV1::Promote)),
    );
    let decision_ref = decision_event.id.to_string();
    apply(&mut state, &decision_event);

    let mut result = promotion_result(
        PromotionResultOutcomeV1::ReconciliationRequired,
        decision_ref,
    );
    result
        .promotion_git_binding
        .as_mut()
        .expect("promoted result binding")
        .promotion_receipt_ref = Some("refs/buildplane/promotions/candidate~rewrite/run-1".into());
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionResultRecorded,
            Payload::PromotionResultRecordedV1(result),
        ),
    );

    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert_eq!(workflow.phase, WorkflowPhaseV1::PromotionPending);
    assert!(workflow
        .promotion
        .as_ref()
        .expect("promotion state")
        .result
        .is_none());
}

#[test]
fn target_advanced_promotion_is_recorded_without_becoming_completed() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    apply_dispatch_and_candidate(&mut state, run_id);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(acceptance(
                CandidateAcceptanceOutcomeV1::Passed,
            )),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ReviewVerdictRecorded,
            Payload::ReviewVerdictRecordedV1(review(ReviewDecisionV1::Approve)),
        ),
    );
    let decision_event = event_of(
        run_id,
        EventKind::PromotionDecisionRecorded,
        Payload::PromotionDecisionRecordedV1(promotion_decision(PromotionDecisionKindV1::Promote)),
    );
    let decision_ref = decision_event.id.to_string();
    apply(&mut state, &decision_event);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionResultRecorded,
            Payload::PromotionResultRecordedV1(promotion_result(
                PromotionResultOutcomeV1::ReconciliationRequired,
                decision_ref,
            )),
        ),
    );

    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert_eq!(
        workflow.phase,
        WorkflowPhaseV1::PromotionReconciliationRequired
    );
    assert_eq!(
        workflow
            .promotion
            .as_ref()
            .expect("promotion state")
            .result
            .as_ref()
            .expect("recorded result")
            .outcome,
        PromotionResultOutcomeV1::ReconciliationRequired
    );
    assert!(workflow.terminal.is_none());
}

#[test]
fn root_checkout_stale_promotion_is_recorded_without_becoming_completed() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    apply_dispatch_and_candidate(&mut state, run_id);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(acceptance(
                CandidateAcceptanceOutcomeV1::Passed,
            )),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ReviewVerdictRecorded,
            Payload::ReviewVerdictRecordedV1(review(ReviewDecisionV1::Approve)),
        ),
    );
    let decision_event = event_of(
        run_id,
        EventKind::PromotionDecisionRecorded,
        Payload::PromotionDecisionRecordedV1(promotion_decision(PromotionDecisionKindV1::Promote)),
    );
    let decision_ref = decision_event.id.to_string();
    apply(&mut state, &decision_event);
    let mut result = promotion_result(
        PromotionResultOutcomeV1::ReconciliationRequired,
        decision_ref,
    );
    let binding = result
        .promotion_git_binding
        .as_mut()
        .expect("reconciliation result carries Git binding");
    binding.target_head_after_sha = Some("3".repeat(40));
    binding.worktree_sync_state = Some(PromotionWorktreeSyncStateV1::RootCheckoutStale);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionResultRecorded,
            Payload::PromotionResultRecordedV1(result),
        ),
    );

    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert_eq!(
        workflow.phase,
        WorkflowPhaseV1::PromotionReconciliationRequired
    );
    assert_eq!(
        workflow
            .promotion
            .as_ref()
            .and_then(|promotion| promotion.result.as_ref())
            .and_then(|result| result.promotion_git_binding.as_ref())
            .and_then(|binding| binding.worktree_sync_state),
        Some(PromotionWorktreeSyncStateV1::RootCheckoutStale)
    );
    assert!(workflow.terminal.is_none());
    assert!(state.issues.is_empty());
}

#[test]
fn pending_reconciliation_result_cannot_project_as_promoted_or_completed() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    apply_dispatch_and_candidate(&mut state, run_id);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(acceptance(
                CandidateAcceptanceOutcomeV1::Passed,
            )),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ReviewVerdictRecorded,
            Payload::ReviewVerdictRecordedV1(review(ReviewDecisionV1::Approve)),
        ),
    );
    let decision_event = event_of(
        run_id,
        EventKind::PromotionDecisionRecorded,
        Payload::PromotionDecisionRecordedV1(promotion_decision(PromotionDecisionKindV1::Promote)),
    );
    let decision_ref = decision_event.id.to_string();
    apply(&mut state, &decision_event);

    let result_event = event_of(
        run_id,
        EventKind::PromotionResultRecorded,
        Payload::PromotionResultRecordedV1(promotion_result(
            PromotionResultOutcomeV1::Promoted,
            decision_ref,
        )),
    );
    let result_ref = result_event.id.to_string();
    apply(&mut state, &result_event);

    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert_eq!(workflow.phase, WorkflowPhaseV1::PromotionPending);
    assert!(workflow
        .promotion
        .as_ref()
        .expect("promotion state")
        .result
        .is_none());
    assert!(workflow.terminal.is_none());

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::WorkflowTerminal,
            Payload::WorkflowTerminalV1(terminal(
                WorkflowTerminalOutcomeV1::Completed,
                Some(result_ref),
            )),
        ),
    );

    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert_eq!(workflow.phase, WorkflowPhaseV1::PromotionPending);
    assert!(workflow.terminal.is_none());
}

#[test]
fn target_advanced_promotion_requires_bound_operator_resolution_before_terminal_failure() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    apply_dispatch_and_candidate(&mut state, run_id);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(acceptance(
                CandidateAcceptanceOutcomeV1::Passed,
            )),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ReviewVerdictRecorded,
            Payload::ReviewVerdictRecordedV1(review(ReviewDecisionV1::Approve)),
        ),
    );
    let decision_event = event_of(
        run_id,
        EventKind::PromotionDecisionRecorded,
        Payload::PromotionDecisionRecordedV1(promotion_decision(PromotionDecisionKindV1::Promote)),
    );
    let decision_ref = decision_event.id.to_string();
    apply(&mut state, &decision_event);

    let result_payload = promotion_result(
        PromotionResultOutcomeV1::ReconciliationRequired,
        decision_ref.clone(),
    );
    let receipt_ref = result_payload
        .promotion_git_binding
        .as_ref()
        .and_then(|binding| binding.promotion_receipt_ref.clone())
        .expect("target-advanced result has a receipt ref");
    let result_event = event_of(
        run_id,
        EventKind::PromotionResultRecorded,
        Payload::PromotionResultRecordedV1(result_payload),
    );
    let result_ref = result_event.id.to_string();
    apply(&mut state, &result_event);

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::WorkflowTerminal,
            Payload::WorkflowTerminalV1(terminal(
                WorkflowTerminalOutcomeV1::Failed,
                Some(result_ref.clone()),
            )),
        ),
    );
    assert_eq!(
        state
            .workflow_instance
            .as_ref()
            .expect("workflow state")
            .phase,
        WorkflowPhaseV1::PromotionReconciliationRequired
    );

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionReconciliationResolved,
            Payload::PromotionReconciliationResolvedV1(reconciliation_resolution(
                ReconciliationResolutionOutcomeV1::Abandon,
                decision_ref.clone(),
                result_ref.clone(),
                "refs/buildplane/promotions/candidate-1/run-1/other".into(),
            )),
        ),
    );
    assert_eq!(
        state
            .workflow_instance
            .as_ref()
            .expect("workflow state")
            .phase,
        WorkflowPhaseV1::PromotionReconciliationRequired
    );

    let resolution_payload = reconciliation_resolution(
        ReconciliationResolutionOutcomeV1::Abandon,
        decision_ref,
        result_ref.clone(),
        receipt_ref,
    );
    let resolution_event = event_of(
        run_id,
        EventKind::PromotionReconciliationResolved,
        Payload::PromotionReconciliationResolvedV1(resolution_payload.clone()),
    );
    apply(&mut state, &resolution_event);
    assert_eq!(
        state
            .workflow_instance
            .as_ref()
            .expect("workflow state")
            .phase,
        WorkflowPhaseV1::PromotionReconciliationResolved
    );
    assert_eq!(
        state
            .workflow_instance
            .as_ref()
            .and_then(|workflow| workflow.promotion.as_ref())
            .and_then(|promotion| promotion.reconciliation.as_ref())
            .expect("first reconciliation resolution remains projected")
            .event_id,
        resolution_event.id
    );

    let mut terminal = terminal(WorkflowTerminalOutcomeV1::Failed, Some(result_ref));
    terminal.reconciliation_resolution_ref = Some(resolution_event.id.to_string());
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::WorkflowTerminal,
            Payload::WorkflowTerminalV1(terminal),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionReconciliationResolved,
            Payload::PromotionReconciliationResolvedV1(resolution_payload),
        ),
    );

    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert_eq!(workflow.phase, WorkflowPhaseV1::Failed);
    assert_eq!(
        workflow
            .promotion
            .as_ref()
            .and_then(|promotion| promotion.result.as_ref())
            .expect("original result remains projected")
            .event_id,
        result_event.id
    );
    assert_eq!(
        workflow
            .terminal
            .as_ref()
            .expect("terminal workflow record")
            .reconciliation_resolution_ref,
        Some(resolution_event.id.to_string())
    );
}

#[test]
fn rejected_target_advanced_promotion_terminalizes_only_as_cancelled() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    apply_dispatch_and_candidate(&mut state, run_id);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(acceptance(
                CandidateAcceptanceOutcomeV1::Passed,
            )),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ReviewVerdictRecorded,
            Payload::ReviewVerdictRecordedV1(review(ReviewDecisionV1::Approve)),
        ),
    );
    let decision_event = event_of(
        run_id,
        EventKind::PromotionDecisionRecorded,
        Payload::PromotionDecisionRecordedV1(promotion_decision(PromotionDecisionKindV1::Promote)),
    );
    let decision_ref = decision_event.id.to_string();
    apply(&mut state, &decision_event);
    let result_payload = promotion_result(
        PromotionResultOutcomeV1::ReconciliationRequired,
        decision_ref.clone(),
    );
    let receipt_ref = result_payload
        .promotion_git_binding
        .as_ref()
        .and_then(|binding| binding.promotion_receipt_ref.clone())
        .expect("target-advanced result has a receipt ref");
    let result_event = event_of(
        run_id,
        EventKind::PromotionResultRecorded,
        Payload::PromotionResultRecordedV1(result_payload),
    );
    let result_ref = result_event.id.to_string();
    apply(&mut state, &result_event);
    let resolution_event = event_of(
        run_id,
        EventKind::PromotionReconciliationResolved,
        Payload::PromotionReconciliationResolvedV1(reconciliation_resolution(
            ReconciliationResolutionOutcomeV1::Reject,
            decision_ref,
            result_ref.clone(),
            receipt_ref,
        )),
    );
    apply(&mut state, &resolution_event);

    let mut failed_terminal = terminal(WorkflowTerminalOutcomeV1::Failed, Some(result_ref.clone()));
    failed_terminal.reconciliation_resolution_ref = Some(resolution_event.id.to_string());
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::WorkflowTerminal,
            Payload::WorkflowTerminalV1(failed_terminal),
        ),
    );
    assert_eq!(
        state
            .workflow_instance
            .as_ref()
            .expect("workflow state")
            .phase,
        WorkflowPhaseV1::PromotionReconciliationResolved
    );

    let mut cancelled_terminal = terminal(WorkflowTerminalOutcomeV1::Cancelled, Some(result_ref));
    cancelled_terminal.reconciliation_resolution_ref = Some(resolution_event.id.to_string());
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::WorkflowTerminal,
            Payload::WorkflowTerminalV1(cancelled_terminal),
        ),
    );
    assert_eq!(
        state
            .workflow_instance
            .as_ref()
            .expect("workflow state")
            .phase,
        WorkflowPhaseV1::Cancelled
    );
    assert!(state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("terminal outcome")
    )));
}

#[test]
fn legacy_unbound_promotion_records_replay_without_new_git_binding() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    apply_dispatch_and_candidate(&mut state, run_id);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(acceptance(
                CandidateAcceptanceOutcomeV1::Passed,
            )),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ReviewVerdictRecorded,
            Payload::ReviewVerdictRecordedV1(review(ReviewDecisionV1::Approve)),
        ),
    );
    let mut legacy_decision = promotion_decision(PromotionDecisionKindV1::Promote);
    legacy_decision.target_ref = None;
    let decision_event = event_of(
        run_id,
        EventKind::PromotionDecisionRecorded,
        Payload::PromotionDecisionRecordedV1(legacy_decision),
    );
    let decision_ref = decision_event.id.to_string();
    apply(&mut state, &decision_event);
    let mut legacy_result = promotion_result(PromotionResultOutcomeV1::Promoted, decision_ref);
    legacy_result.promotion_git_binding = None;
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionResultRecorded,
            Payload::PromotionResultRecordedV1(legacy_result),
        ),
    );

    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert_eq!(workflow.phase, WorkflowPhaseV1::Promoted);
    assert!(state.issues.is_empty());
}

#[test]
fn rejected_legacy_promotion_result_cannot_carry_git_binding() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    apply_dispatch_and_candidate(&mut state, run_id);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(acceptance(
                CandidateAcceptanceOutcomeV1::Passed,
            )),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ReviewVerdictRecorded,
            Payload::ReviewVerdictRecordedV1(review(ReviewDecisionV1::Approve)),
        ),
    );
    let mut legacy_decision = promotion_decision(PromotionDecisionKindV1::Promote);
    legacy_decision.target_ref = None;
    let decision_event = event_of(
        run_id,
        EventKind::PromotionDecisionRecorded,
        Payload::PromotionDecisionRecordedV1(legacy_decision),
    );
    let decision_ref = decision_event.id.to_string();
    apply(&mut state, &decision_event);

    let mut malformed = promotion_result(PromotionResultOutcomeV1::Rejected, decision_ref);
    malformed.promotion_git_binding = Some(PromotionGitBindingV1 {
        target_ref: "refs/heads/main".into(),
        target_head_before_sha: "1".repeat(40),
        target_head_after_sha: None,
        merged_head_sha: None,
        candidate_commit_sha: "2".repeat(40),
        merge_parent_shas: None,
        merged_tree_sha: None,
        merged_tree_digest: DIGEST_C.into(),
        promotion_receipt_ref: None,
        worktree_sync_state: None,
    });
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionResultRecorded,
            Payload::PromotionResultRecordedV1(malformed),
        ),
    );

    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert_eq!(workflow.phase, WorkflowPhaseV1::PromotionPending);
    assert!(workflow
        .promotion
        .as_ref()
        .expect("promotion state")
        .result
        .is_none());
    assert!(state
        .issues
        .iter()
        .any(|issue| matches!(issue, ReplayIssue::WorkflowTransitionRejected { .. })));
}

#[test]
fn replay_engine_skips_unsigned_trust_spine_events_by_default() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelope,
        Payload::DispatchEnvelopeV1(dispatch()),
    );
    let dispatch_event_id = dispatch_event.id;
    store
        .append(&dispatch_event)
        .expect("append unsigned dispatch");

    let mut replay = ReplayEngine::open(&run_id.to_string(), &db_path).expect("replay engine");
    assert_eq!(replay.by_ref().count(), 1);
    assert!(replay.state().workflow_instance.is_none());
    assert!(replay.state().workflow_instances.is_empty());
    assert!(matches!(
        replay.state().issues.as_slice(),
        [ReplayIssue::UnverifiedTrustSpineEvent {
            event_id,
            event_kind,
            verification: VerificationStatus::Unsigned,
        }] if *event_id == dispatch_event_id && event_kind.as_str() == "dispatch_envelope"
    ));
}

#[test]
fn replay_engine_skips_signed_trust_spine_events_without_a_trusted_key() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let signing_key = SigningKey::from_bytes(&[7; 32]);
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelope,
        Payload::DispatchEnvelopeV1(dispatch()),
    );
    let dispatch_event_id = dispatch_event.id;
    store
        .append_signed(&dispatch_event, &signing_key, &kernel_signer())
        .expect("append signed dispatch");

    let empty_keys = TrustedPublicKeys::default();
    let mut replay =
        ReplayEngine::open_with_trusted_keys(&run_id.to_string(), &db_path, &empty_keys)
            .expect("replay engine");
    assert_eq!(replay.by_ref().count(), 1);
    assert!(replay.state().workflow_instance.is_none());
    assert!(matches!(
        replay.state().issues.as_slice(),
        [ReplayIssue::UnverifiedTrustSpineEvent {
            event_id,
            verification: VerificationStatus::MissingKey,
            ..
        }] if *event_id == dispatch_event_id
    ));
}

#[test]
fn replay_engine_rebuilds_a_suspended_strict_promotion_from_a_trusted_signed_tape() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let signing_key = SigningKey::from_bytes(&[7; 32]);
    let trusted_authorities = trusted_authorities(&signing_key);

    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelope,
        Payload::DispatchEnvelopeV1(dispatch()),
    );
    let candidate_event = event_of(
        run_id,
        EventKind::CandidateCreated,
        Payload::CandidateCreatedV1(candidate()),
    );
    let acceptance_event = event_of(
        run_id,
        EventKind::CandidateAcceptanceRecorded,
        Payload::CandidateAcceptanceRecordedV1(acceptance(CandidateAcceptanceOutcomeV1::Passed)),
    );
    let review_event = event_of(
        run_id,
        EventKind::ReviewVerdictRecorded,
        Payload::ReviewVerdictRecordedV1(review(ReviewDecisionV1::Approve)),
    );
    let decision_event = event_of(
        run_id,
        EventKind::PromotionDecisionRecorded,
        Payload::PromotionDecisionRecordedV1(promotion_decision(PromotionDecisionKindV1::Promote)),
    );
    let decision_ref = decision_event.id.to_string();
    let result_event = event_of(
        run_id,
        EventKind::PromotionResultRecorded,
        Payload::PromotionResultRecordedV1(promotion_result(
            PromotionResultOutcomeV1::ReconciliationRequired,
            decision_ref,
        )),
    );
    let events = vec![
        dispatch_event,
        candidate_event,
        acceptance_event,
        review_event,
        decision_event,
        result_event,
    ];
    for event in &events {
        let signer = match &event.payload {
            Payload::ReviewVerdictRecordedV1(_) => reviewer_signer(),
            Payload::PromotionDecisionRecordedV1(_) => operator_signer(),
            _ => kernel_signer(),
        };
        store
            .append_signed(event, &signing_key, &signer)
            .expect("append signed trust-spine event");
    }

    let mut replay = ReplayEngine::open_with_trusted_authorities(
        &run_id.to_string(),
        &db_path,
        &trusted_authorities,
    )
    .expect("replay engine");
    assert_eq!(replay.by_ref().count(), 6);
    let workflow = replay
        .state()
        .workflow_instance
        .as_ref()
        .expect("workflow state");
    assert_eq!(
        workflow.phase,
        WorkflowPhaseV1::PromotionReconciliationRequired
    );
    assert_eq!(
        workflow.candidate.as_ref().unwrap().candidate_digest,
        DIGEST_A
    );
    assert!(workflow.terminal.is_none());
    assert!(replay.state().issues.is_empty());
}

#[test]
fn replay_engine_refuses_a_cryptographically_valid_signer_without_kernel_authority() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let signing_key = SigningKey::from_bytes(&[8; 32]);
    let mut authorities = TrustedReplayAuthorities::new(trusted_keys(&signing_key));
    authorities.allow_signer(
        TrustSpineSignerRole::Reviewer,
        signer_with_public_key(reviewer_signer(), &signing_key),
    );
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelope,
        Payload::DispatchEnvelopeV1(dispatch()),
    );
    store
        .append_signed(&dispatch_event, &signing_key, &kernel_signer())
        .expect("append signed dispatch");

    let mut replay =
        ReplayEngine::open_with_trusted_authorities(&run_id.to_string(), &db_path, &authorities)
            .expect("replay engine");
    assert_eq!(replay.by_ref().count(), 1);
    assert!(replay.state().workflow_instance.is_none());
    assert!(matches!(
        replay.state().issues.as_slice(),
        [ReplayIssue::UnauthorizedTrustSpineSigner { required_role, .. }]
            if required_role == "kernel"
    ));
}

#[test]
fn replay_engine_rejects_a_reviewer_signed_promotion_execution_claim() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let signing_key = SigningKey::from_bytes(&[29; 32]);
    let authorities = trusted_authorities(&signing_key);
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV2,
        Payload::DispatchEnvelopeV2(dispatch_v2()),
    );
    let decision = promotion_decision(PromotionDecisionKindV1::Promote);
    let decision_event = event_of(
        run_id,
        EventKind::PromotionDecisionRecorded,
        Payload::PromotionDecisionRecordedV1(decision.clone()),
    );
    let claim = promotion_execution_claim(
        run_id,
        &dispatch_event,
        DIGEST_A,
        "refs/buildplane/candidates/candidate-1/run-1/1",
        &"2".repeat(40),
        DIGEST_C,
        &"1".repeat(40),
        DIGEST_C,
        &decision_event,
        &decision,
    );
    let claim_event = promotion_execution_claim_event(run_id, &claim);
    store
        .append_signed(&decision_event, &signing_key, &operator_signer())
        .expect("append signed promotion decision parent");
    store
        .append_signed(&claim_event, &signing_key, &reviewer_signer())
        .expect("append reviewer-signed promotion execution claim");

    let mut replay =
        ReplayEngine::open_with_trusted_authorities(&run_id.to_string(), &db_path, &authorities)
            .expect("replay engine");
    assert_eq!(replay.by_ref().count(), 2);
    assert!(replay.state().issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::UnauthorizedTrustSpineSigner {
            event_id,
            event_kind,
            required_role,
            reason,
            ..
        } if *event_id == claim_event.id
            && event_kind == "promotion_execution_claimed_v1"
            && required_role == "kernel"
            && reason.contains("not authorized for this trust-spine event role")
    )));
}

#[test]
fn replay_engine_rejects_a_kernel_signed_promotion_execution_claim_with_a_forged_actor() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let signing_key = SigningKey::from_bytes(&[30; 32]);
    let authorities = trusted_authorities(&signing_key);
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelope,
        Payload::DispatchEnvelopeV1(dispatch()),
    );
    let decision = promotion_decision(PromotionDecisionKindV1::Promote);
    let decision_event = event_of(
        run_id,
        EventKind::PromotionDecisionRecorded,
        Payload::PromotionDecisionRecordedV1(decision.clone()),
    );
    let mut claim = promotion_execution_claim(
        run_id,
        &dispatch_event,
        DIGEST_A,
        "refs/buildplane/candidates/candidate-1/run-1/1",
        &"2".repeat(40),
        DIGEST_C,
        &"1".repeat(40),
        DIGEST_C,
        &decision_event,
        &decision,
    );
    claim.authority_actor = "forged-kernel".into();
    claim.promotion_execution_claim_digest = promotion_execution_claimed_v1_digest(&claim)
        .expect("rehash forged promotion execution claim actor");
    let claim_event = promotion_execution_claim_event(run_id, &claim);
    store
        .append_signed(&decision_event, &signing_key, &operator_signer())
        .expect("append signed promotion decision parent");
    store
        .append_signed(&claim_event, &signing_key, &kernel_signer())
        .expect("append kernel-signed forged-actor claim");

    let mut replay =
        ReplayEngine::open_with_trusted_authorities(&run_id.to_string(), &db_path, &authorities)
            .expect("replay engine");
    assert_eq!(replay.by_ref().count(), 2);
    assert!(replay.state().issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::UnauthorizedTrustSpineSigner {
            event_id,
            event_kind,
            required_role,
            reason,
            ..
        } if *event_id == claim_event.id
            && event_kind == "promotion_execution_claimed_v1"
            && required_role == "kernel"
            && reason.contains("authority_actor")
    )));
}

#[test]
fn replay_engine_rejects_a_kernel_signed_approval_request_with_a_mismatched_requester() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let signing_key = SigningKey::from_bytes(&[28; 32]);
    let authorities = trusted_authorities(&signing_key);
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV2,
        Payload::DispatchEnvelopeV2(dispatch_v2()),
    );
    store
        .append_signed(&dispatch_event, &signing_key, &kernel_signer())
        .expect("append signed governed dispatch");

    let mut request = promotion_approval_request(&v2_review_fixture());
    request.requested_by = "forged-kernel".into();
    let request_event = event_of(
        run_id,
        EventKind::PromotionApprovalRequested,
        Payload::PromotionApprovalRequestedV1(request),
    );
    store
        .append_signed(&request_event, &signing_key, &kernel_signer())
        .expect("append mismatched approval requester");

    let mut replay =
        ReplayEngine::open_with_trusted_authorities(&run_id.to_string(), &db_path, &authorities)
            .expect("replay engine");
    replay.by_ref().for_each(drop);

    assert!(
        !replay.state().issues.is_empty(),
        "forged approval requester must fail trusted replay (events={}): {:#?}",
        replay.by_ref().count(),
        replay.state().issues
    );
}

#[test]
fn replay_engine_keeps_v1_placeholder_inner_signature_compatibility() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let signing_key = SigningKey::from_bytes(&[10; 32]);
    let trusted_authorities = trusted_authorities(&signing_key);
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelope,
        Payload::DispatchEnvelopeV1(dispatch()),
    );
    store
        .append_signed(&dispatch_event, &signing_key, &kernel_signer())
        .expect("append signed v1 dispatch");

    let mut replay = ReplayEngine::open_with_trusted_authorities(
        &run_id.to_string(),
        &db_path,
        &trusted_authorities,
    )
    .expect("replay engine");
    assert_eq!(replay.by_ref().count(), 1);
    let workflow = replay
        .state()
        .workflow_instance
        .as_ref()
        .expect("workflow state");
    assert_eq!(workflow.dispatch.dispatch_version, 1);
    assert_eq!(
        workflow
            .dispatch
            .signature_ref
            .as_ref()
            .expect("v1 inner signature")
            .signature,
        "detached-signature"
    );
    assert!(replay.state().issues.is_empty());
}

#[test]
fn replay_engine_projects_a_v2_dispatch_from_an_authorized_kernel() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let signing_key = SigningKey::from_bytes(&[11; 32]);
    let trusted_authorities = trusted_authorities(&signing_key);
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV2,
        Payload::DispatchEnvelopeV2(dispatch_v2()),
    );
    store
        .append_signed(&dispatch_event, &signing_key, &kernel_signer())
        .expect("append signed v2 dispatch");

    let mut replay = ReplayEngine::open_with_trusted_authorities(
        &run_id.to_string(),
        &db_path,
        &trusted_authorities,
    )
    .expect("replay engine");
    assert_eq!(replay.by_ref().count(), 1);
    let workflow = replay
        .state()
        .workflow_instance
        .as_ref()
        .expect("workflow state");
    assert_eq!(workflow.phase, WorkflowPhaseV1::Dispatched);
    assert_eq!(workflow.dispatch.dispatch_version, 2);
    assert!(workflow.dispatch.signature_ref.is_none());
    assert!(replay.state().issues.is_empty());
}

#[test]
fn replay_engine_requires_a_kernel_signer_for_v3_action_evidence() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let signing_key = SigningKey::from_bytes(&[43; 32]);
    let authorities = trusted_authorities(&signing_key);
    let dispatch = dispatch_v3();
    let mut request = action_request(run_id, &dispatch, "action-1");
    request.action_kind = ActionKindV1::Model;
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch),
    );
    let forged_request = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request.clone()),
    );
    let accepted_request = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request.clone()),
    );
    let forged_authorization = event_of(
        run_id,
        EventKind::ModelActionAuthorizedV1,
        Payload::ModelActionAuthorizedV1(model_action_authorization(
            &request,
            &dispatch_event,
            &accepted_request,
            "authorization:forged-action-1",
            None,
        )),
    );
    let mut mismatched_actor_authorization_payload = model_action_authorization(
        &request,
        &dispatch_event,
        &accepted_request,
        "authorization:mismatched-actor-action-1",
        None,
    );
    mismatched_actor_authorization_payload.authorization_actor = "kernel-other".into();
    mismatched_actor_authorization_payload.authorization_digest =
        model_action_authorized_v1_digest(&mismatched_actor_authorization_payload)
            .expect("rehash mismatched model authorization actor");
    let mismatched_actor_authorization = event_of(
        run_id,
        EventKind::ModelActionAuthorizedV1,
        Payload::ModelActionAuthorizedV1(mismatched_actor_authorization_payload),
    );
    let accepted_authorization = event_of(
        run_id,
        EventKind::ModelActionAuthorizedV1,
        Payload::ModelActionAuthorizedV1(model_action_authorization(
            &request,
            &dispatch_event,
            &accepted_request,
            "authorization:accepted-action-1",
            None,
        )),
    );

    store
        .append_signed(&dispatch_event, &signing_key, &kernel_signer())
        .expect("append signed V3 dispatch");
    store
        .append_signed(&forged_request, &signing_key, &reviewer_signer())
        .expect("append reviewer-signed forged request");
    store
        .append_signed(&accepted_request, &signing_key, &kernel_signer())
        .expect("append kernel-signed request");
    store
        .append_signed(&forged_authorization, &signing_key, &reviewer_signer())
        .expect("append reviewer-signed forged model authorization");
    store
        .append_signed(
            &mismatched_actor_authorization,
            &signing_key,
            &kernel_signer(),
        )
        .expect("append kernel-signed mismatched model authorization actor");
    store
        .append_signed(&accepted_authorization, &signing_key, &kernel_signer())
        .expect("append kernel-signed model authorization");

    let mut replay =
        ReplayEngine::open_with_trusted_authorities(&run_id.to_string(), &db_path, &authorities)
            .expect("replay engine");
    assert_eq!(replay.by_ref().count(), 6);
    let evidence = replay
        .state()
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .expect("V3 action evidence");
    assert_eq!(evidence.pending_action_ids, vec!["action-1"]);
    assert!(replay.state().issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::UnauthorizedTrustSpineSigner {
            event_id,
            event_kind,
            required_role,
            ..
        } if *event_id == forged_request.id
            && event_kind == "action_requested_v2"
            && required_role == "kernel")
    }));
    assert!(replay.state().issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::UnauthorizedTrustSpineSigner {
            event_id,
            event_kind,
            required_role,
            ..
        } if *event_id == forged_authorization.id
            && event_kind == "model_action_authorized_v1"
            && required_role == "kernel")
    }));
    assert!(replay.state().issues.iter().any(|issue| {
        matches!(issue, ReplayIssue::UnauthorizedTrustSpineSigner {
            event_id,
            event_kind,
            required_role,
            reason,
            ..
        } if *event_id == mismatched_actor_authorization.id
            && event_kind == "model_action_authorized_v1"
            && required_role == "kernel"
            && reason.contains("authorization_actor"))
    }));
    assert_eq!(
        evidence
            .actions
            .get("action-1")
            .and_then(|action| action.model_authorization.as_ref())
            .map(|authorization| authorization.authorization_ref.as_str()),
        Some("authorization:accepted-action-1")
    );
}

#[test]
fn replay_engine_refuses_a_v2_dispatch_from_an_untrusted_kernel_signer() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let signing_key = SigningKey::from_bytes(&[12; 32]);
    let mut authorities = TrustedReplayAuthorities::new(trusted_keys(&signing_key));
    authorities.allow_signer(
        TrustSpineSignerRole::Reviewer,
        signer_with_public_key(reviewer_signer(), &signing_key),
    );
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV2,
        Payload::DispatchEnvelopeV2(dispatch_v2()),
    );
    let dispatch_event_id = dispatch_event.id;
    store
        .append_signed(&dispatch_event, &signing_key, &kernel_signer())
        .expect("append signed v2 dispatch");

    let mut replay =
        ReplayEngine::open_with_trusted_authorities(&run_id.to_string(), &db_path, &authorities)
            .expect("replay engine");
    assert_eq!(replay.by_ref().count(), 1);
    assert!(replay.state().workflow_instance.is_none());
    assert!(matches!(
        replay.state().issues.as_slice(),
        [ReplayIssue::UnauthorizedTrustSpineSigner {
            event_id,
            event_kind,
            required_role,
            ..
        }] if *event_id == dispatch_event_id
            && event_kind == "dispatch_envelope_v2"
            && required_role == "kernel"
    ));
}

#[test]
fn replay_engine_requires_an_operator_signer_for_reconciliation_resolution() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let signing_key = SigningKey::from_bytes(&[9; 32]);
    let trusted_authorities = trusted_authorities(&signing_key);
    let resolution_event = event_of(
        run_id,
        EventKind::PromotionReconciliationResolved,
        Payload::PromotionReconciliationResolvedV1(reconciliation_resolution(
            ReconciliationResolutionOutcomeV1::Abandon,
            "decision:1".into(),
            "result:1".into(),
            "refs/buildplane/promotions/candidate-1/run-1/1".into(),
        )),
    );
    let resolution_event_id = resolution_event.id;
    store
        .append_signed(&resolution_event, &signing_key, &kernel_signer())
        .expect("append signed resolution with the wrong role");

    let mut replay = ReplayEngine::open_with_trusted_authorities(
        &run_id.to_string(),
        &db_path,
        &trusted_authorities,
    )
    .expect("replay engine");
    assert_eq!(replay.by_ref().count(), 1);
    assert!(replay.state().workflow_instance.is_none());
    assert!(matches!(
        replay.state().issues.as_slice(),
        [ReplayIssue::UnauthorizedTrustSpineSigner {
            event_id,
            event_kind,
            required_role,
            ..
        }] if *event_id == resolution_event_id
            && event_kind == "promotion_reconciliation_resolved"
            && required_role == "operator"
    ));
}

#[test]
fn replay_engine_does_not_adopt_unsigned_pre_dispatch_activity_brackets() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let signing_key = SigningKey::from_bytes(&[17; 32]);
    let authorities = trusted_authorities(&signing_key);

    // These events sort before the dispatch. The replay engine must learn from
    // the later authorized dispatch that this whole run is governed, reject
    // both untrusted brackets, and allow only the later kernel-owned retry.
    let forged_started = activity_started(run_id, "pre-dispatch-unsigned", "sha256:input");
    let forged_completed = activity_completed(
        run_id,
        "pre-dispatch-unsigned",
        "sha256:forged-result",
        serde_json::json!({ "status": "forged" }),
    );
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelope,
        Payload::DispatchEnvelopeV1(dispatch()),
    );
    let accepted_started = activity_started(run_id, "pre-dispatch-unsigned", "sha256:input");
    let accepted_completed = activity_completed(
        run_id,
        "pre-dispatch-unsigned",
        "sha256:accepted-result",
        serde_json::json!({ "status": "accepted" }),
    );

    store
        .append(&forged_started)
        .expect("append unsigned pre-dispatch start");
    store
        .append(&forged_completed)
        .expect("append unsigned pre-dispatch completion");
    store
        .append_signed(&dispatch_event, &signing_key, &kernel_signer())
        .expect("append governed dispatch");
    store
        .append_signed(&accepted_started, &signing_key, &kernel_signer())
        .expect("append kernel retry start");
    store
        .append_signed(&accepted_completed, &signing_key, &kernel_signer())
        .expect("append kernel retry completion");

    let mut replay =
        ReplayEngine::open_with_trusted_authorities(&run_id.to_string(), &db_path, &authorities)
            .expect("replay engine");
    assert_eq!(replay.by_ref().count(), 5);

    assert!(replay.state().workflow_instance.is_some());
    let activity = replay
        .state()
        .activities
        .get("pre-dispatch-unsigned")
        .expect("only the kernel retry becomes recovery state");
    assert_eq!(activity.started_event_id, Some(accepted_started.id));
    assert_eq!(activity.completed_event_id, Some(accepted_completed.id));
    assert_eq!(
        activity.result,
        Some(serde_json::json!({ "status": "accepted" }))
    );
    assert_eq!(
        replay
            .state()
            .issues
            .iter()
            .filter(|issue| {
                matches!(
                    issue,
                    ReplayIssue::UnverifiedTrustSpineEvent { event_id, event_kind, .. }
                        if (*event_id == forged_started.id || *event_id == forged_completed.id)
                            && (event_kind == "activity_started" || event_kind == "activity_completed")
                )
            })
            .count(),
        2
    );
}

#[test]
fn replay_engine_does_not_adopt_wrong_role_pre_dispatch_activity_brackets() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let signing_key = SigningKey::from_bytes(&[18; 32]);
    let authorities = trusted_authorities(&signing_key);

    let forged_started = activity_started(run_id, "pre-dispatch-wrong-role", "sha256:input");
    let forged_completed = activity_completed(
        run_id,
        "pre-dispatch-wrong-role",
        "sha256:forged-result",
        serde_json::json!({ "status": "forged" }),
    );
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelope,
        Payload::DispatchEnvelopeV1(dispatch()),
    );
    let accepted_started = activity_started(run_id, "pre-dispatch-wrong-role", "sha256:input");
    let accepted_completed = activity_completed(
        run_id,
        "pre-dispatch-wrong-role",
        "sha256:accepted-result",
        serde_json::json!({ "status": "accepted" }),
    );

    store
        .append_signed(&forged_started, &signing_key, &reviewer_signer())
        .expect("append reviewer pre-dispatch start");
    store
        .append_signed(&forged_completed, &signing_key, &reviewer_signer())
        .expect("append reviewer pre-dispatch completion");
    store
        .append_signed(&dispatch_event, &signing_key, &kernel_signer())
        .expect("append governed dispatch");
    store
        .append_signed(&accepted_started, &signing_key, &kernel_signer())
        .expect("append kernel retry start");
    store
        .append_signed(&accepted_completed, &signing_key, &kernel_signer())
        .expect("append kernel retry completion");

    let mut replay =
        ReplayEngine::open_with_trusted_authorities(&run_id.to_string(), &db_path, &authorities)
            .expect("replay engine");
    assert_eq!(replay.by_ref().count(), 5);

    assert!(replay.state().workflow_instance.is_some());
    let activity = replay
        .state()
        .activities
        .get("pre-dispatch-wrong-role")
        .expect("only the kernel retry becomes recovery state");
    assert_eq!(activity.started_event_id, Some(accepted_started.id));
    assert_eq!(activity.completed_event_id, Some(accepted_completed.id));
    assert_eq!(
        activity.result,
        Some(serde_json::json!({ "status": "accepted" }))
    );
    assert_eq!(
        replay
            .state()
            .issues
            .iter()
            .filter(|issue| {
                matches!(
                    issue,
                    ReplayIssue::UnauthorizedTrustSpineSigner {
                        event_id,
                        event_kind,
                        required_role,
                        ..
                    } if (*event_id == forged_started.id || *event_id == forged_completed.id)
                        && (event_kind == "activity_started" || event_kind == "activity_completed")
                        && required_role == "kernel"
                )
            })
            .count(),
        2
    );
}

#[test]
fn replay_engine_skips_unsigned_activity_brackets_for_a_governed_workflow() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let signing_key = SigningKey::from_bytes(&[13; 32]);
    let authorities = trusted_authorities(&signing_key);

    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelope,
        Payload::DispatchEnvelopeV1(dispatch()),
    );
    store
        .append_signed(&dispatch_event, &signing_key, &kernel_signer())
        .expect("append signed governed dispatch");

    let started = activity_started(run_id, "unsigned-governed-activity", "sha256:input");
    let completed = activity_completed(
        run_id,
        "unsigned-governed-activity",
        "sha256:result",
        serde_json::json!({ "status": "forged" }),
    );
    store
        .append(&started)
        .expect("append unsigned activity start");
    store
        .append(&completed)
        .expect("append unsigned activity completion");

    let mut replay =
        ReplayEngine::open_with_trusted_authorities(&run_id.to_string(), &db_path, &authorities)
            .expect("replay engine");
    assert_eq!(replay.by_ref().count(), 3);

    assert!(replay
        .state()
        .activities
        .get("unsigned-governed-activity")
        .is_none());
    assert_eq!(
        replay
            .state()
            .issues
            .iter()
            .filter(|issue| {
                matches!(
                    issue,
                    ReplayIssue::UnverifiedTrustSpineEvent { event_kind, .. }
                        if event_kind == "activity_started" || event_kind == "activity_completed"
                )
            })
            .count(),
        2
    );
}

#[test]
fn replay_engine_rejects_wrong_role_activity_events_without_changing_governed_recovery() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let signing_key = SigningKey::from_bytes(&[14; 32]);
    let authorities = trusted_authorities(&signing_key);

    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelope,
        Payload::DispatchEnvelopeV1(dispatch()),
    );
    store
        .append_signed(&dispatch_event, &signing_key, &kernel_signer())
        .expect("append signed governed dispatch");

    let wrong_started = activity_started(run_id, "wrong-role-activity", "sha256:input");
    store
        .append_signed(&wrong_started, &signing_key, &reviewer_signer())
        .expect("append reviewer-signed activity start");
    let accepted_started = activity_started(run_id, "wrong-role-activity", "sha256:input");
    store
        .append_signed(&accepted_started, &signing_key, &kernel_signer())
        .expect("append kernel-signed activity start");
    let wrong_completed = activity_completed(
        run_id,
        "wrong-role-activity",
        "sha256:forged-result",
        serde_json::json!({ "status": "forged" }),
    );
    store
        .append_signed(&wrong_completed, &signing_key, &reviewer_signer())
        .expect("append reviewer-signed activity completion");

    let mut replay =
        ReplayEngine::open_with_trusted_authorities(&run_id.to_string(), &db_path, &authorities)
            .expect("replay engine");
    assert_eq!(replay.by_ref().count(), 4);

    let activity = replay
        .state()
        .activities
        .get("wrong-role-activity")
        .expect("only the kernel-signed start is recovered");
    assert_eq!(activity.started_event_id, Some(accepted_started.id));
    assert_eq!(activity.completed_event_id, None);
    assert_eq!(
        replay
            .state()
            .issues
            .iter()
            .filter(|issue| {
                matches!(
                    issue,
                    ReplayIssue::UnauthorizedTrustSpineSigner {
                        event_kind,
                        required_role,
                        ..
                    } if (event_kind == "activity_started" || event_kind == "activity_completed")
                        && required_role == "kernel"
                )
            })
            .count(),
        2
    );
}

#[test]
fn replay_engine_preserves_the_first_governed_activity_intent_and_result_on_divergence() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let signing_key = SigningKey::from_bytes(&[15; 32]);
    let authorities = trusted_authorities(&signing_key);

    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelope,
        Payload::DispatchEnvelopeV1(dispatch()),
    );
    store
        .append_signed(&dispatch_event, &signing_key, &kernel_signer())
        .expect("append signed governed dispatch");
    let started = activity_started(run_id, "divergent-governed-activity", "sha256:input-a");
    store
        .append_signed(&started, &signing_key, &kernel_signer())
        .expect("append first activity start");
    let divergent_started =
        activity_started(run_id, "divergent-governed-activity", "sha256:input-b");
    store
        .append_signed(&divergent_started, &signing_key, &kernel_signer())
        .expect("append divergent activity start");
    let completed = activity_completed(
        run_id,
        "divergent-governed-activity",
        "sha256:result-a",
        serde_json::json!({ "attempt": 1 }),
    );
    store
        .append_signed(&completed, &signing_key, &kernel_signer())
        .expect("append first activity completion");
    let divergent_completed = activity_completed(
        run_id,
        "divergent-governed-activity",
        "sha256:result-b",
        serde_json::json!({ "attempt": 2 }),
    );
    store
        .append_signed(&divergent_completed, &signing_key, &kernel_signer())
        .expect("append divergent activity completion");

    let mut replay =
        ReplayEngine::open_with_trusted_authorities(&run_id.to_string(), &db_path, &authorities)
            .expect("replay engine");
    assert_eq!(replay.by_ref().count(), 5);

    let activity = replay
        .state()
        .activities
        .get("divergent-governed-activity")
        .expect("governed activity state");
    assert_eq!(activity.started_event_id, Some(started.id));
    assert_eq!(activity.completed_event_id, Some(completed.id));
    assert_eq!(activity.input_digest.as_deref(), Some("sha256:input-a"));
    assert_eq!(activity.result_digest.as_deref(), Some("sha256:result-a"));
    assert_eq!(activity.result, Some(serde_json::json!({ "attempt": 1 })));
    assert_eq!(
        replay
            .state()
            .issues
            .iter()
            .filter(|issue| matches!(issue, ReplayIssue::ActivityTransitionRejected { .. }))
            .count(),
        2
    );
}

#[test]
fn replay_engine_keeps_unsigned_activity_replay_for_legacy_runs() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let started = activity_started(run_id, "legacy-activity", "sha256:legacy-input");
    let completed = activity_completed(
        run_id,
        "legacy-activity",
        "sha256:legacy-result",
        serde_json::json!({ "status": "legacy" }),
    );
    store.append(&started).expect("append legacy start");
    store.append(&completed).expect("append legacy completion");

    let mut replay = ReplayEngine::open(&run_id.to_string(), &db_path).expect("replay engine");
    assert_eq!(replay.by_ref().count(), 2);

    let activity = replay
        .state()
        .activities
        .get("legacy-activity")
        .expect("legacy activity remains replayable");
    assert_eq!(activity.started_event_id, Some(started.id));
    assert_eq!(activity.completed_event_id, Some(completed.id));
    assert_eq!(
        activity.result,
        Some(serde_json::json!({ "status": "legacy" }))
    );
    assert!(replay.state().issues.is_empty());
}

#[test]
fn replay_engine_keeps_unsigned_activity_replay_for_raw_workflows() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("ledger store");
    let run_id = RunId::new();
    let signing_key = SigningKey::from_bytes(&[16; 32]);
    let authorities = trusted_authorities(&signing_key);

    let mut raw_dispatch = dispatch();
    raw_dispatch.trust_tier = TrustTierV1::Raw;
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelope,
        Payload::DispatchEnvelopeV1(raw_dispatch),
    );
    store
        .append_signed(&dispatch_event, &signing_key, &kernel_signer())
        .expect("append signed raw dispatch");

    let started = activity_started(run_id, "raw-activity", "sha256:raw-input");
    let completed = activity_completed(
        run_id,
        "raw-activity",
        "sha256:raw-result",
        serde_json::json!({ "status": "raw" }),
    );
    store.append(&started).expect("append raw activity start");
    store
        .append(&completed)
        .expect("append raw activity completion");

    let mut replay =
        ReplayEngine::open_with_trusted_authorities(&run_id.to_string(), &db_path, &authorities)
            .expect("replay engine");
    assert_eq!(replay.by_ref().count(), 3);

    let activity = replay
        .state()
        .activities
        .get("raw-activity")
        .expect("raw activity remains replayable");
    assert_eq!(activity.started_event_id, Some(started.id));
    assert_eq!(activity.completed_event_id, Some(completed.id));
    assert_eq!(
        activity.result,
        Some(serde_json::json!({ "status": "raw" }))
    );
    assert!(replay.state().issues.is_empty());
}

#[test]
fn unchecked_reducer_rejects_first_governed_dispatch_after_a_prior_activity_bracket() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    let legacy_started = activity_started(run_id, "pre-dispatch-direct", "sha256:input");
    let governed_dispatch = event_of(
        run_id,
        EventKind::DispatchEnvelope,
        Payload::DispatchEnvelopeV1(dispatch()),
    );

    apply(&mut state, &legacy_started);
    apply(&mut state, &governed_dispatch);

    assert!(state.workflow_instance.is_none());
    assert!(matches!(
        state.issues.last(),
        Some(ReplayIssue::WorkflowTransitionRejected { event_id, reason, .. })
            if *event_id == governed_dispatch.id
                && reason.contains("first governed dispatch must precede every activity")
    ));
}

#[test]
fn activity_v1_scope_is_run_wide_and_mixed_tier_dispatches_are_rejected() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    let first_governed_dispatch = event_of(
        run_id,
        EventKind::DispatchEnvelope,
        Payload::DispatchEnvelopeV1(dispatch()),
    );
    apply(&mut state, &first_governed_dispatch);

    let mut raw_unit = dispatch();
    raw_unit.unit_id = "unit-raw".into();
    raw_unit.idempotency_key = "dispatch:workflow-1:unit-raw:1".into();
    raw_unit.envelope_digest = DIGEST_A.into();
    raw_unit.trust_tier = TrustTierV1::Raw;
    let raw_dispatch = event_of(
        run_id,
        EventKind::DispatchEnvelope,
        Payload::DispatchEnvelopeV1(raw_unit),
    );
    apply(&mut state, &raw_dispatch);

    assert_eq!(state.workflow_instances.len(), 1);
    assert!(matches!(
        state.issues.last(),
        Some(ReplayIssue::WorkflowTransitionRejected { event_id, reason, .. })
            if *event_id == raw_dispatch.id
                && reason.contains("cannot mix within one activity V1 run scope")
    ));

    let mut second_governed_unit = dispatch();
    second_governed_unit.unit_id = "unit-2".into();
    second_governed_unit.idempotency_key = "dispatch:workflow-1:unit-2:1".into();
    second_governed_unit.envelope_digest = DIGEST_B.into();
    let second_governed_dispatch = event_of(
        run_id,
        EventKind::DispatchEnvelope,
        Payload::DispatchEnvelopeV1(second_governed_unit),
    );
    apply(&mut state, &second_governed_dispatch);

    let activity = activity_started(run_id, "graph-wide-activity", "sha256:input");
    apply(&mut state, &activity);

    assert_eq!(state.workflow_instances.len(), 2);
    assert_eq!(
        state
            .activities
            .get("graph-wide-activity")
            .and_then(|entry| entry.started_event_id),
        Some(activity.id)
    );
}

#[test]
fn mismatched_evidence_never_advances_or_replaces_candidate_state() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    apply_dispatch_and_candidate(&mut state, run_id);

    let mut wrong_acceptance = acceptance(CandidateAcceptanceOutcomeV1::Passed);
    wrong_acceptance.candidate_digest = DIGEST_B.into();
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(wrong_acceptance),
        ),
    );
    let workflow = state.workflow_instance.as_ref().unwrap();
    assert_eq!(workflow.phase, WorkflowPhaseV1::CandidateCreated);
    assert!(workflow.acceptance.is_none());

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(acceptance(
                CandidateAcceptanceOutcomeV1::Passed,
            )),
        ),
    );
    let mut wrong_review = review(ReviewDecisionV1::Approve);
    wrong_review.candidate_commit_sha = "9".repeat(40);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ReviewVerdictRecorded,
            Payload::ReviewVerdictRecordedV1(wrong_review),
        ),
    );
    let workflow = state.workflow_instance.as_ref().unwrap();
    assert_eq!(workflow.phase, WorkflowPhaseV1::AcceptancePassed);
    assert!(workflow.reviews.is_empty());

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ReviewVerdictRecorded,
            Payload::ReviewVerdictRecordedV1(review(ReviewDecisionV1::Approve)),
        ),
    );
    let mut wrong_decision = promotion_decision(PromotionDecisionKindV1::Promote);
    wrong_decision.base_commit_sha = "8".repeat(40);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionDecisionRecorded,
            Payload::PromotionDecisionRecordedV1(wrong_decision),
        ),
    );
    let workflow = state.workflow_instance.as_ref().unwrap();
    assert_eq!(workflow.phase, WorkflowPhaseV1::ReviewApproved);
    assert!(workflow.promotion.is_none());

    let decision_event = event_of(
        run_id,
        EventKind::PromotionDecisionRecorded,
        Payload::PromotionDecisionRecordedV1(promotion_decision(PromotionDecisionKindV1::Promote)),
    );
    let decision_ref = decision_event.id.to_string();
    apply(&mut state, &decision_event);
    let mut wrong_result = promotion_result(
        PromotionResultOutcomeV1::ReconciliationRequired,
        decision_ref,
    );
    wrong_result.idempotency_key = "promotion:other".into();
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionResultRecorded,
            Payload::PromotionResultRecordedV1(wrong_result),
        ),
    );
    let workflow = state.workflow_instance.as_ref().unwrap();
    assert_eq!(workflow.phase, WorkflowPhaseV1::PromotionPending);
    assert!(workflow.promotion.as_ref().unwrap().result.is_none());

    assert_eq!(
        state
            .issues
            .iter()
            .filter(|issue| matches!(issue, ReplayIssue::WorkflowTransitionRejected { .. }))
            .count(),
        4
    );
}

#[test]
fn candidate_acceptance_requires_the_signed_dispatch_acceptance_contract_digest() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    apply_dispatch_and_candidate(&mut state, run_id);

    let mut wrong_acceptance = acceptance(CandidateAcceptanceOutcomeV1::Passed);
    wrong_acceptance.acceptance_contract_digest = DIGEST_C.into();
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(wrong_acceptance),
        ),
    );

    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert_eq!(workflow.phase, WorkflowPhaseV1::CandidateCreated);
    assert!(workflow.acceptance.is_none());
    assert!(state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("acceptance contract digest")
    )));
}

#[test]
fn promotion_and_terminal_references_bind_exact_tape_event_ids() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    apply_dispatch_and_candidate(&mut state, run_id);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(acceptance(
                CandidateAcceptanceOutcomeV1::Passed,
            )),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ReviewVerdictRecorded,
            Payload::ReviewVerdictRecordedV1(review(ReviewDecisionV1::Approve)),
        ),
    );
    let decision_event = event_of(
        run_id,
        EventKind::PromotionDecisionRecorded,
        Payload::PromotionDecisionRecordedV1(promotion_decision(PromotionDecisionKindV1::Promote)),
    );
    let decision_ref = decision_event.id.to_string();
    apply(&mut state, &decision_event);

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionResultRecorded,
            Payload::PromotionResultRecordedV1(promotion_result(
                PromotionResultOutcomeV1::ReconciliationRequired,
                "forged-decision-ref".into(),
            )),
        ),
    );
    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert_eq!(workflow.phase, WorkflowPhaseV1::PromotionPending);
    assert!(workflow
        .promotion
        .as_ref()
        .expect("promotion state")
        .result
        .is_none());

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionResultRecorded,
            Payload::PromotionResultRecordedV1({
                let mut malformed = promotion_result(
                    PromotionResultOutcomeV1::ReconciliationRequired,
                    decision_ref.clone(),
                );
                malformed.merged_head_sha = Some("not-a-git-object".into());
                malformed
            }),
        ),
    );

    let result_event = event_of(
        run_id,
        EventKind::PromotionResultRecorded,
        Payload::PromotionResultRecordedV1(promotion_result(
            PromotionResultOutcomeV1::ReconciliationRequired,
            decision_ref,
        )),
    );
    apply(&mut state, &result_event);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::WorkflowTerminal,
            Payload::WorkflowTerminalV1(terminal(
                WorkflowTerminalOutcomeV1::Completed,
                Some("forged-result-ref".into()),
            )),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::WorkflowTerminal,
            Payload::WorkflowTerminalV1(terminal(
                WorkflowTerminalOutcomeV1::Failed,
                Some(result_event.id.to_string()),
            )),
        ),
    );

    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert_eq!(
        workflow.phase,
        WorkflowPhaseV1::PromotionReconciliationRequired
    );
    assert!(workflow.terminal.is_none());
    assert_eq!(
        state
            .issues
            .iter()
            .filter(|issue| matches!(issue, ReplayIssue::WorkflowTransitionRejected { .. }))
            .count(),
        4
    );
}

#[test]
fn terminal_failure_cannot_hide_a_pending_promote_reconciliation() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    apply_dispatch_and_candidate(&mut state, run_id);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(acceptance(
                CandidateAcceptanceOutcomeV1::Passed,
            )),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ReviewVerdictRecorded,
            Payload::ReviewVerdictRecordedV1(review(ReviewDecisionV1::Approve)),
        ),
    );
    let decision_event = event_of(
        run_id,
        EventKind::PromotionDecisionRecorded,
        Payload::PromotionDecisionRecordedV1(promotion_decision(PromotionDecisionKindV1::Promote)),
    );
    let decision_ref = decision_event.id.to_string();
    apply(&mut state, &decision_event);

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::WorkflowTerminal,
            Payload::WorkflowTerminalV1(terminal(WorkflowTerminalOutcomeV1::Failed, None)),
        ),
    );
    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert_eq!(workflow.phase, WorkflowPhaseV1::PromotionPending);
    assert!(workflow.terminal.is_none());

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionResultRecorded,
            Payload::PromotionResultRecordedV1(promotion_result(
                PromotionResultOutcomeV1::ReconciliationRequired,
                decision_ref,
            )),
        ),
    );
    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert_eq!(
        workflow.phase,
        WorkflowPhaseV1::PromotionReconciliationRequired
    );
    assert!(workflow
        .promotion
        .as_ref()
        .expect("promotion state")
        .result
        .is_some());
    assert_eq!(
        state
            .issues
            .iter()
            .filter(|issue| matches!(issue, ReplayIssue::WorkflowTransitionRejected { .. }))
            .count(),
        1
    );
}

#[test]
fn rejection_decision_requires_candidate_acceptance_and_review_evidence() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    apply_dispatch_and_candidate(&mut state, run_id);

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionDecisionRecorded,
            Payload::PromotionDecisionRecordedV1(promotion_decision(
                PromotionDecisionKindV1::Reject,
            )),
        ),
    );
    assert!(state
        .workflow_instance
        .as_ref()
        .expect("workflow state")
        .promotion
        .is_none());

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(acceptance(
                CandidateAcceptanceOutcomeV1::Passed,
            )),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ReviewVerdictRecorded,
            Payload::ReviewVerdictRecordedV1(review(ReviewDecisionV1::Approve)),
        ),
    );
    let mut missing_reviews = promotion_decision(PromotionDecisionKindV1::Reject);
    missing_reviews.review_refs.clear();
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionDecisionRecorded,
            Payload::PromotionDecisionRecordedV1(missing_reviews),
        ),
    );

    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert_eq!(workflow.phase, WorkflowPhaseV1::ReviewApproved);
    assert!(workflow.promotion.is_none());
    assert_eq!(
        state
            .issues
            .iter()
            .filter(|issue| matches!(issue, ReplayIssue::WorkflowTransitionRejected { .. }))
            .count(),
        2
    );
}

#[test]
fn rejected_promotion_decision_cannot_record_promoted_or_reconciliation_results() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    apply_dispatch_and_candidate(&mut state, run_id);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(acceptance(
                CandidateAcceptanceOutcomeV1::Passed,
            )),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ReviewVerdictRecorded,
            Payload::ReviewVerdictRecordedV1(review(ReviewDecisionV1::Approve)),
        ),
    );
    let decision_event = event_of(
        run_id,
        EventKind::PromotionDecisionRecorded,
        Payload::PromotionDecisionRecordedV1(promotion_decision(PromotionDecisionKindV1::Reject)),
    );
    let decision_ref = decision_event.id.to_string();
    apply(&mut state, &decision_event);

    for outcome in [
        PromotionResultOutcomeV1::Promoted,
        PromotionResultOutcomeV1::ReconciliationRequired,
    ] {
        apply(
            &mut state,
            &event_of(
                run_id,
                EventKind::PromotionResultRecorded,
                Payload::PromotionResultRecordedV1(promotion_result(outcome, decision_ref.clone())),
            ),
        );
    }

    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert_eq!(workflow.phase, WorkflowPhaseV1::Rejected);
    assert!(workflow
        .promotion
        .as_ref()
        .expect("rejection decision")
        .result
        .is_none());
    assert_eq!(
        state
            .issues
            .iter()
            .filter(|issue| matches!(issue, ReplayIssue::WorkflowTransitionRejected { .. }))
            .count(),
        2
    );
}

#[test]
fn rejected_review_is_terminal_for_the_candidate_and_cannot_be_promoted() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    apply_dispatch_and_candidate(&mut state, run_id);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(acceptance(
                CandidateAcceptanceOutcomeV1::Passed,
            )),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ReviewVerdictRecorded,
            Payload::ReviewVerdictRecordedV1(review(ReviewDecisionV1::Reject)),
        ),
    );
    assert_eq!(
        state.workflow_instance.as_ref().unwrap().phase,
        WorkflowPhaseV1::Rejected
    );

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionDecisionRecorded,
            Payload::PromotionDecisionRecordedV1(promotion_decision(
                PromotionDecisionKindV1::Promote,
            )),
        ),
    );

    let workflow = state.workflow_instance.as_ref().unwrap();
    assert_eq!(workflow.phase, WorkflowPhaseV1::Rejected);
    assert!(workflow.promotion.is_none());
    assert!(state
        .issues
        .iter()
        .any(|issue| matches!(issue, ReplayIssue::WorkflowTransitionRejected { .. })));
}

#[test]
fn workflow_projection_state_is_closed_and_rejects_unknown_phase_data() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::DispatchEnvelope,
            Payload::DispatchEnvelopeV1(dispatch()),
        ),
    );

    let mut value = serde_json::to_value(state.workflow_instance.as_ref().unwrap()).unwrap();
    value["unrecognized_authority_field"] = serde_json::json!(true);
    assert!(serde_json::from_value::<WorkflowInstanceV1>(value).is_err());
}

#[test]
fn workflow_projection_snapshots_before_promotion_approval_remain_readable() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::DispatchEnvelope,
            Payload::DispatchEnvelopeV1(dispatch()),
        ),
    );

    let mut legacy_snapshot =
        serde_json::to_value(state.workflow_instance.as_ref().expect("workflow state"))
            .expect("serialize current workflow projection");
    legacy_snapshot
        .as_object_mut()
        .expect("workflow projection object")
        .remove("promotion_approval");

    let restored = serde_json::from_value::<WorkflowInstanceV1>(legacy_snapshot)
        .expect("pre-approval workflow snapshot remains readable");
    assert!(restored.promotion_approval.is_none());
    assert_eq!(restored.phase, WorkflowPhaseV1::Dispatched);
}

#[test]
fn legacy_tape_events_and_legacy_serialized_state_remain_replay_compatible() {
    let run_id = RunId::new();
    let mut state = ReplayState::default();
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::RunStarted,
            Payload::RunStartedV1(RunStartedV1 {
                packet_hash: "sha256:legacy".into(),
                git_head: "deadbeef".into(),
                workspace_path: "/workspace".into(),
                config: BTreeMap::new(),
                parent_run_id: None,
                parent_event_id: None,
            }),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::RunCompleted,
            Payload::RunCompletedV1(RunCompletedV1 {
                outcome: RunOutcome::Passed,
                duration_ms: "0".into(),
                event_count: "2".into(),
                unit_count: "0".into(),
            }),
        ),
    );
    assert_eq!(state.workflow_instance, None);

    let legacy_state = serde_json::json!({
        "run_id": null,
        "parent_run_id": null,
        "parent_event_id": null,
        "current_unit": null,
        "parent_chain": [],
        "observed_files": {},
        "checkpoints": [],
        "issues": []
    });
    let restored: ReplayState = serde_json::from_value(legacy_state).expect("legacy replay state");
    assert_eq!(restored.workflow_instance, None);
    assert!(restored.workflow_instances.is_empty());

    let SealedV3ActivityClaimFixture { state, .. } = sealed_v3_activity_claim_fixture();
    let mut pre_heartbeat_snapshot =
        serde_json::to_value(state).expect("serialize pre-heartbeat workflow snapshot");
    pre_heartbeat_snapshot["workflow_instance"]["action_evidence"]["actions"]["heartbeat-effect"]
        ["activity_claim"]
        .as_object_mut()
        .expect("activity claim projection")
        .remove("heartbeats");
    let restored: ReplayState = serde_json::from_value(pre_heartbeat_snapshot)
        .expect("pre-heartbeat sealed_v3 workflow snapshot remains readable");
    assert!(restored
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("heartbeat-effect"))
        .and_then(|action| action.activity_claim.as_ref())
        .is_some_and(|claim| claim.heartbeats.is_empty()));
}

#[test]
fn sealed_v3_candidate_requires_closed_completion_lineage_before_acceptance() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    let mut request = action_request(
        run_id,
        &dispatch,
        "git-candidate-create:candidate-v2-1/run-1/1",
    );
    request.action_kind = ActionKindV1::Git;
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch.clone()),
    );
    let request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request.clone()),
    );
    let claim = activity_claim(run_id, &dispatch_event, &request_event, &request);
    let claim_event = activity_claim_event(run_id, &claim);
    let result = activity_result(&claim_event, &claim, ActivityResultOutcomeV1::Succeeded);
    let result_event = activity_result_event(run_id, &claim_event, &result);
    let receipt = action_receipt(&request, ActionReceiptOutcomeV2::Succeeded);
    let receipt_set = action_receipt_set(&request, &receipt);
    let candidate = candidate_v2(run_id, &dispatch, &receipt_set);
    let candidate_event = event_of(
        run_id,
        EventKind::CandidateCreatedV2,
        Payload::CandidateCreatedV2(candidate.clone()),
    );

    let mut state = ReplayState::default();
    for event in [
        dispatch_event.clone(),
        request_event.clone(),
        claim_event.clone(),
        result_event.clone(),
        event_of(
            run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(receipt.clone()),
        ),
        event_of(
            run_id,
            EventKind::ActionReceiptSetRecordedV1,
            Payload::ActionReceiptSetRecordedV1(receipt_set),
        ),
        candidate_event.clone(),
    ] {
        apply(&mut state, &event);
    }
    assert!(
        state.issues.is_empty(),
        "candidate setup: {:#?}",
        state.issues
    );

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(acceptance(
                CandidateAcceptanceOutcomeV1::Passed,
            )),
        ),
    );
    assert_eq!(
        state
            .workflow_instance
            .as_ref()
            .expect("workflow state")
            .phase,
        WorkflowPhaseV1::CandidateCreated
    );
    assert!(has_activity_transition_rejection(
        &state,
        "candidate completion evidence"
    ));

    let mut review_without_completion = v2_review_fixture().verdict;
    review_without_completion.run_id = run_id.to_string();
    review_without_completion.workflow_id = candidate.workflow_id.clone();
    review_without_completion.unit_id = candidate.unit_id.clone();
    review_without_completion.attempt = candidate.attempt;
    review_without_completion.provenance_ref = candidate.provenance_ref.clone();
    review_without_completion.candidate_digest = candidate.candidate_digest.clone();
    review_without_completion.candidate_commit_sha = candidate.candidate_commit_sha.clone();
    review_without_completion.candidate_envelope_digest = candidate.envelope_digest.clone();
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ReviewVerdictRecordedV2,
            Payload::ReviewVerdictRecordedV2(review_without_completion),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionApprovalRequested,
            Payload::PromotionApprovalRequestedV1(PromotionApprovalRequestedV1 {
                candidate_digest: candidate.candidate_digest.clone(),
                base_commit_sha: candidate.base_commit_sha.clone(),
                target_ref: "refs/heads/main".into(),
                envelope_digest: candidate.envelope_digest.clone(),
                acceptance_ref: "acceptance:1".into(),
                review_refs: vec!["review-v2:1".into()],
                requested_by: "kernel".into(),
                requested_at: "2026-07-17T00:03:00Z".into(),
                idempotency_key: "promotion:completion-gate".into(),
            }),
        ),
    );
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionDecisionRecorded,
            Payload::PromotionDecisionRecordedV1(PromotionDecisionRecordedV1 {
                candidate_digest: candidate.candidate_digest.clone(),
                base_commit_sha: candidate.base_commit_sha.clone(),
                target_ref: Some("refs/heads/main".into()),
                envelope_digest: candidate.envelope_digest.clone(),
                acceptance_ref: "acceptance:1".into(),
                review_refs: vec!["review-v2:1".into()],
                promotion_approval_request_ref: None,
                decision: PromotionDecisionKindV1::Promote,
                authority: "operator".into(),
                decided_by: "operator".into(),
                decided_at: "2026-07-17T00:04:00Z".into(),
                idempotency_key: "promotion:completion-gate".into(),
            }),
        ),
    );
    assert!(has_activity_transition_rejection(
        &state,
        "candidate review requires closed candidate completion"
    ));
    assert!(has_activity_transition_rejection(
        &state,
        "promotion approval requires closed candidate completion"
    ));
    assert!(has_activity_transition_rejection(
        &state,
        "promotion decision requires closed candidate completion"
    ));

    let completion = candidate_completion(
        &candidate,
        &candidate_event,
        &request,
        &request_event,
        &claim_event,
        &result_event,
        &receipt,
    );
    apply(
        &mut state,
        &candidate_completion_event(run_id, &candidate_event, &completion),
    );
    assert!(state
        .workflow_instance
        .as_ref()
        .expect("workflow state")
        .candidate_completion
        .is_some());

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(acceptance(
                CandidateAcceptanceOutcomeV1::Passed,
            )),
        ),
    );
    assert_eq!(
        state
            .workflow_instance
            .as_ref()
            .expect("workflow state")
            .phase,
        WorkflowPhaseV1::AcceptancePassed
    );
}

#[test]
fn sealed_v3_candidate_completion_rejects_an_unrelated_git_action() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    let mut request = action_request(run_id, &dispatch, "git-unrelated-candidate-effect");
    request.action_kind = ActionKindV1::Git;
    let dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch.clone()),
    );
    let request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request.clone()),
    );
    let claim = activity_claim(run_id, &dispatch_event, &request_event, &request);
    let claim_event = activity_claim_event(run_id, &claim);
    let result = activity_result(&claim_event, &claim, ActivityResultOutcomeV1::Succeeded);
    let result_event = activity_result_event(run_id, &claim_event, &result);
    let receipt = action_receipt(&request, ActionReceiptOutcomeV2::Succeeded);
    let receipt_set = action_receipt_set(&request, &receipt);
    let candidate = candidate_v2(run_id, &dispatch, &receipt_set);
    let candidate_event = event_of(
        run_id,
        EventKind::CandidateCreatedV2,
        Payload::CandidateCreatedV2(candidate.clone()),
    );

    let mut state = ReplayState::default();
    for event in [
        dispatch_event.clone(),
        request_event.clone(),
        claim_event.clone(),
        result_event.clone(),
        event_of(
            run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(receipt.clone()),
        ),
        event_of(
            run_id,
            EventKind::ActionReceiptSetRecordedV1,
            Payload::ActionReceiptSetRecordedV1(receipt_set),
        ),
        candidate_event.clone(),
    ] {
        apply(&mut state, &event);
    }
    assert!(
        state.issues.is_empty(),
        "candidate setup: {:#?}",
        state.issues
    );

    let completion = candidate_completion(
        &candidate,
        &candidate_event,
        &request,
        &request_event,
        &claim_event,
        &result_event,
        &receipt,
    );
    apply(
        &mut state,
        &candidate_completion_event(run_id, &candidate_event, &completion),
    );

    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert!(workflow.candidate_completion.is_none());
    assert!(has_activity_transition_rejection(
        &state,
        "exact Git candidate-create action"
    ));
}

#[test]
fn sealed_v3_activity_heartbeat_extends_a_live_lease_and_allows_a_result_within_the_extension() {
    let SealedV3ActivityClaimFixture {
        mut state,
        run_id,
        claim,
        claim_event,
    } = sealed_v3_activity_claim_fixture_with_compute_budget(None);
    let heartbeat = activity_heartbeat(
        &claim_event,
        &claim,
        "2026-07-17T00:00:30Z",
        "2026-07-17T00:02:00Z",
    );
    apply(
        &mut state,
        &activity_heartbeat_event(run_id, &claim_event, &heartbeat),
    );

    let projected_claim = state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("heartbeat-effect"))
        .and_then(|action| action.activity_claim.as_ref())
        .expect("projected activity claim");
    assert_eq!(projected_claim.lease_expires_at, heartbeat.lease_expires_at);
    assert_eq!(projected_claim.heartbeats.len(), 1);
    assert_eq!(
        projected_claim.heartbeats[0].heartbeat_id,
        heartbeat.heartbeat_id
    );
    assert_eq!(
        projected_claim.heartbeats[0].heartbeat_request_digest,
        heartbeat.heartbeat_request_digest
    );
    assert_eq!(
        projected_claim.heartbeats[0].prior_lease_expires_at,
        claim.lease_expires_at
    );
    assert!(
        state.issues.is_empty(),
        "heartbeat issues: {:#?}",
        state.issues
    );

    let mut result = activity_result(&claim_event, &claim, ActivityResultOutcomeV1::Succeeded);
    result.recorded_at = "2026-07-17T00:01:30Z".into();
    apply(
        &mut state,
        &activity_result_event(run_id, &claim_event, &result),
    );
    assert!(
        state.issues.is_empty(),
        "the extended lease must admit its in-window result: {:#?}",
        state.issues
    );
}

#[test]
fn sealed_v3_claims_and_heartbeats_cannot_outlive_the_signed_compute_deadline() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3_with_action_evidence_and_compute_budget(
        ActionEvidenceVersionV1::SealedV3,
        Some(30_000),
    );
    let mut dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch.clone()),
    );
    event_occurred_at(&mut dispatch_event, "2026-07-17T00:00:00Z");
    let request = action_request(run_id, &dispatch, "claim-compute-deadline");
    let request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request.clone()),
    );
    let claim = activity_claim(run_id, &dispatch_event, &request_event, &request);
    let mut state = ReplayState::default();
    apply(&mut state, &dispatch_event);
    apply(&mut state, &request_event);
    apply(&mut state, &activity_claim_event(run_id, &claim));
    assert!(state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("claim-compute-deadline"))
        .is_some_and(|action| action.activity_claim.is_none()));
    assert!(has_activity_transition_rejection(
        &state,
        "signed compute deadline"
    ));

    let SealedV3ActivityClaimFixture {
        mut state,
        run_id,
        claim,
        claim_event,
    } = sealed_v3_activity_claim_fixture();
    let heartbeat = activity_heartbeat(
        &claim_event,
        &claim,
        "2026-07-17T00:00:30Z",
        "2026-07-17T00:02:00Z",
    );
    apply(
        &mut state,
        &activity_heartbeat_event(run_id, &claim_event, &heartbeat),
    );
    let projected_claim = state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("heartbeat-effect"))
        .and_then(|action| action.activity_claim.as_ref())
        .expect("original claim remains projected");
    assert_eq!(projected_claim.lease_expires_at, claim.lease_expires_at);
    assert!(has_activity_transition_rejection(
        &state,
        "signed compute deadline"
    ));
}

#[test]
fn sealed_v3_activity_heartbeat_rejects_a_substituted_claim_reference() {
    let SealedV3ActivityClaimFixture {
        mut state,
        run_id,
        claim,
        claim_event,
    } = sealed_v3_activity_claim_fixture();
    let mut heartbeat = activity_heartbeat(
        &claim_event,
        &claim,
        "2026-07-17T00:00:30Z",
        "2026-07-17T00:02:00Z",
    );
    heartbeat.claim_event_id = EventId::new();
    let mut event = activity_heartbeat_event(run_id, &claim_event, &heartbeat);
    event.parent_event_id = Some(heartbeat.claim_event_id);
    apply(&mut state, &event);

    assert!(has_activity_transition_rejection(
        &state,
        "no prior immutable activity claim"
    ));
}

#[test]
fn sealed_v3_activity_heartbeat_rejects_mismatched_lease_or_dispatch_bindings() {
    let SealedV3ActivityClaimFixture {
        mut state,
        run_id,
        claim,
        claim_event,
    } = sealed_v3_activity_claim_fixture();
    let mut lease_substitution = activity_heartbeat(
        &claim_event,
        &claim,
        "2026-07-17T00:00:30Z",
        "2026-07-17T00:02:00Z",
    );
    lease_substitution.lease_id = "lease:substituted".into();
    apply(
        &mut state,
        &activity_heartbeat_event(run_id, &claim_event, &lease_substitution),
    );

    let mut dispatch_substitution = activity_heartbeat(
        &claim_event,
        &claim,
        "2026-07-17T00:00:31Z",
        "2026-07-17T00:02:00Z",
    );
    dispatch_substitution.dispatch_event_id = EventId::new();
    apply(
        &mut state,
        &activity_heartbeat_event(run_id, &claim_event, &dispatch_substitution),
    );

    assert_eq!(
        state
            .issues
            .iter()
            .filter(|issue| {
                matches!(issue, ReplayIssue::ActivityTransitionRejected { reason, .. }
                    if reason.contains("exact immutable execution lease"))
            })
            .count(),
        2,
        "each changed authority binding must be rejected"
    );
}

#[test]
fn sealed_v3_activity_heartbeat_cannot_revive_an_expired_lease() {
    let SealedV3ActivityClaimFixture {
        mut state,
        run_id,
        claim,
        claim_event,
    } = sealed_v3_activity_claim_fixture();
    let heartbeat = activity_heartbeat(
        &claim_event,
        &claim,
        "2026-07-17T00:01:00Z",
        "2026-07-17T00:02:00Z",
    );
    apply(
        &mut state,
        &activity_heartbeat_event(run_id, &claim_event, &heartbeat),
    );

    let projected_claim = state
        .workflow_instance
        .as_ref()
        .and_then(|workflow| workflow.action_evidence.as_ref())
        .and_then(|evidence| evidence.actions.get("heartbeat-effect"))
        .and_then(|action| action.activity_claim.as_ref())
        .expect("projected activity claim");
    assert_eq!(projected_claim.lease_expires_at, claim.lease_expires_at);
    assert!(has_activity_transition_rejection(
        &state,
        "before the current lease expires"
    ));
}

#[test]
fn sealed_v3_activity_heartbeat_rejects_a_terminal_activity() {
    let SealedV3ActivityClaimFixture {
        mut state,
        run_id,
        claim,
        claim_event,
    } = sealed_v3_activity_claim_fixture();
    let result = activity_result(&claim_event, &claim, ActivityResultOutcomeV1::Succeeded);
    apply(
        &mut state,
        &activity_result_event(run_id, &claim_event, &result),
    );
    assert!(
        state.issues.is_empty(),
        "terminal setup: {:#?}",
        state.issues
    );

    let heartbeat = activity_heartbeat(
        &claim_event,
        &claim,
        "2026-07-17T00:00:30Z",
        "2026-07-17T00:02:00Z",
    );
    apply(
        &mut state,
        &activity_heartbeat_event(run_id, &claim_event, &heartbeat),
    );

    assert!(has_activity_transition_rejection(
        &state,
        "after its terminal activity result"
    ));
}

fn workflow_timer_schedule(
    run_id: RunId,
    dispatch_event: &Event,
    dispatch: &DispatchEnvelopeV3,
    timer_id: &str,
) -> WorkflowTimerScheduledV1 {
    WorkflowTimerScheduledV1 {
        run_id: run_id.to_string(),
        workflow_id: dispatch.body.workflow_id.clone(),
        workflow_revision: dispatch.body.workflow_revision.clone(),
        unit_id: dispatch.body.unit_id.clone(),
        attempt: dispatch.body.attempt,
        dispatch_event_ref: dispatch_event.id,
        dispatch_envelope_digest: dispatch.envelope_digest.clone(),
        timer_id: timer_id.into(),
        timer_kind: WorkflowTimerKindV1::WorkflowDeadline,
        due_at: "2026-07-17T00:05:00Z".into(),
        idempotency_key: format!("timer:{timer_id}"),
        scheduled_by: "kernel".into(),
        scheduled_at: "2026-07-17T00:01:00Z".into(),
    }
}

fn workflow_timer_schedule_event(run_id: RunId, schedule: &WorkflowTimerScheduledV1) -> Event {
    let mut event = event_of(
        run_id,
        EventKind::WorkflowTimerScheduledV1,
        Payload::WorkflowTimerScheduledV1(schedule.clone()),
    );
    event.parent_event_id = Some(schedule.dispatch_event_ref);
    event_occurred_at(&mut event, &schedule.scheduled_at);
    event
}

fn workflow_timer_fired(
    run_id: RunId,
    schedule_event: &Event,
    schedule: &WorkflowTimerScheduledV1,
    fired_at: &str,
) -> WorkflowTimerFiredV1 {
    WorkflowTimerFiredV1 {
        run_id: run_id.to_string(),
        workflow_id: schedule.workflow_id.clone(),
        workflow_revision: schedule.workflow_revision.clone(),
        unit_id: schedule.unit_id.clone(),
        attempt: schedule.attempt,
        timer_id: schedule.timer_id.clone(),
        timer_schedule_event_ref: schedule_event.id,
        timer_schedule_event_digest: canonical_event_hash(schedule_event)
            .expect("hash timer schedule event"),
        dispatch_event_ref: schedule.dispatch_event_ref,
        dispatch_envelope_digest: schedule.dispatch_envelope_digest.clone(),
        idempotency_key: schedule.idempotency_key.clone(),
        fired_by: "kernel".into(),
        fired_at: fired_at.into(),
    }
}

fn workflow_timer_fired_event(run_id: RunId, fired: &WorkflowTimerFiredV1) -> Event {
    let mut event = event_of(
        run_id,
        EventKind::WorkflowTimerFiredV1,
        Payload::WorkflowTimerFiredV1(fired.clone()),
    );
    event.parent_event_id = Some(fired.timer_schedule_event_ref);
    event_occurred_at(&mut event, &fired.fired_at);
    event
}

fn timeout_cancellation(
    run_id: RunId,
    schedule: &WorkflowTimerScheduledV1,
    fired_event: &Event,
) -> WorkflowCancellationRequestedV1 {
    WorkflowCancellationRequestedV1 {
        run_id: run_id.to_string(),
        workflow_id: schedule.workflow_id.clone(),
        workflow_revision: schedule.workflow_revision.clone(),
        unit_id: schedule.unit_id.clone(),
        attempt: schedule.attempt,
        dispatch_event_ref: schedule.dispatch_event_ref,
        dispatch_envelope_digest: schedule.dispatch_envelope_digest.clone(),
        cancellation_id: format!("cancel:{}", schedule.timer_id),
        cause: WorkflowCancellationCauseV1::TimerElapsed,
        timer_fired_event_ref: Some(fired_event.id),
        timer_fired_event_digest: Some(
            canonical_event_hash(fired_event).expect("hash timer fired event"),
        ),
        requested_by: "kernel".into(),
        idempotency_key: format!("cancel:{}", schedule.timer_id),
        requested_at: "2026-07-17T00:05:00Z".into(),
    }
}

fn cancellation_event(run_id: RunId, cancellation: &WorkflowCancellationRequestedV1) -> Event {
    let mut event = event_of(
        run_id,
        EventKind::WorkflowCancellationRequestedV1,
        Payload::WorkflowCancellationRequestedV1(cancellation.clone()),
    );
    event.parent_event_id = cancellation.timer_fired_event_ref;
    event_occurred_at(&mut event, &cancellation.requested_at);
    event
}

fn cancelled_terminal_v2(
    dispatch: &DispatchEnvelopeV3,
    cancellation_event: &Event,
) -> WorkflowTerminalV2 {
    WorkflowTerminalV2 {
        workflow_id: dispatch.body.workflow_id.clone(),
        workflow_revision: dispatch.body.workflow_revision.clone(),
        unit_id: dispatch.body.unit_id.clone(),
        attempt: dispatch.body.attempt,
        outcome: WorkflowTerminalOutcomeV1::Cancelled,
        candidate_digest: None,
        promotion_result_ref: None,
        reconciliation_resolution_ref: None,
        cancellation_request_event_ref: Some(cancellation_event.id),
        cancellation_request_event_digest: Some(
            canonical_event_hash(cancellation_event).expect("hash cancellation event"),
        ),
        reason: Some("workflow deadline elapsed".into()),
        idempotency_key: "workflow-terminal:timer-1".into(),
        completed_at: "2026-07-17T00:05:00Z".into(),
    }
}

fn workflow_terminal_v2_event(run_id: RunId, terminal: &WorkflowTerminalV2) -> Event {
    let mut event = event_of(
        run_id,
        EventKind::WorkflowTerminalV2,
        Payload::WorkflowTerminalV2(terminal.clone()),
    );
    event.parent_event_id = terminal.cancellation_request_event_ref;
    event_occurred_at(&mut event, &terminal.completed_at);
    event
}

struct SealedV3ReviewedCandidateFixture {
    candidate: CandidateCreatedV2,
    candidate_acceptance: CandidateAcceptanceRecordedV1,
    verdict: ReviewVerdictRecordedV2,
}

/// Project the complete sealed-v3 candidate and reviewer evidence chain used
/// by promotion tests. The caller supplies an already-projected implementer
/// dispatch so lifecycle tests can add their own timer/cancellation events.
fn apply_sealed_v3_reviewed_candidate(
    state: &mut ReplayState,
    run_id: RunId,
    dispatch: &DispatchEnvelopeV3,
    dispatch_event: &Event,
) -> SealedV3ReviewedCandidateFixture {
    let mut candidate_request = action_request(
        run_id,
        dispatch,
        "git-candidate-create:candidate-v2-1/run-1/1",
    );
    candidate_request.action_kind = ActionKindV1::Git;
    let candidate_request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(candidate_request.clone()),
    );
    let candidate_claim = activity_claim(
        run_id,
        dispatch_event,
        &candidate_request_event,
        &candidate_request,
    );
    let candidate_claim_event = activity_claim_event(run_id, &candidate_claim);
    let candidate_result = activity_result(
        &candidate_claim_event,
        &candidate_claim,
        ActivityResultOutcomeV1::Succeeded,
    );
    let candidate_result_event =
        activity_result_event(run_id, &candidate_claim_event, &candidate_result);
    let candidate_receipt = action_receipt(&candidate_request, ActionReceiptOutcomeV2::Succeeded);
    let candidate_set = action_receipt_set(&candidate_request, &candidate_receipt);
    let candidate = candidate_v2(run_id, dispatch, &candidate_set);
    let candidate_event = event_of(
        run_id,
        EventKind::CandidateCreatedV2,
        Payload::CandidateCreatedV2(candidate.clone()),
    );
    for event in [
        candidate_request_event.clone(),
        candidate_claim_event.clone(),
        candidate_result_event.clone(),
        event_of(
            run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(candidate_receipt.clone()),
        ),
        event_of(
            run_id,
            EventKind::ActionReceiptSetRecordedV1,
            Payload::ActionReceiptSetRecordedV1(candidate_set),
        ),
        candidate_event.clone(),
    ] {
        apply(state, &event);
    }
    let completion = candidate_completion(
        &candidate,
        &candidate_event,
        &candidate_request,
        &candidate_request_event,
        &candidate_claim_event,
        &candidate_result_event,
        &candidate_receipt,
    );
    apply(
        state,
        &candidate_completion_event(run_id, &candidate_event, &completion),
    );
    let candidate_acceptance = acceptance(CandidateAcceptanceOutcomeV1::Passed);
    apply(
        state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(candidate_acceptance.clone()),
        ),
    );

    let reviewer_dispatch =
        reviewer_dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    let reviewer_dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(reviewer_dispatch.clone()),
    );
    apply(state, &reviewer_dispatch_event);
    let mut reviewer_request = action_request(run_id, &reviewer_dispatch, "review-action-cancel");
    reviewer_request.action_kind = ActionKindV1::Model;
    let reviewer_request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(reviewer_request.clone()),
    );
    apply(state, &reviewer_request_event);
    let candidate_view = review_v2_candidate_view(&reviewer_dispatch);
    let review_output = review_v2_output(&candidate_view);
    let review_output_digest =
        review_verdict_output_v1_digest(&review_output).expect("hash closed review output");
    let mut reviewer_receipt = action_receipt(&reviewer_request, ActionReceiptOutcomeV2::Succeeded);
    reviewer_receipt.result_ref = Some(format!("cas:{review_output_digest}"));
    reviewer_receipt.result_digest = Some(review_output_digest);
    reviewer_receipt.authorization_ref =
        Some(format!("authorization:{}", reviewer_request.action_id));
    // This is the provider-completion time. It must follow the native
    // authorization and precede (or equal) the recorded activity result.
    reviewer_receipt.completed_at = "2026-07-17T00:00:06Z".into();
    let reviewer_set = action_receipt_set(&reviewer_request, &reviewer_receipt);
    let verdict = review_v2(
        run_id,
        dispatch,
        &reviewer_dispatch,
        &candidate_acceptance,
        &reviewer_request,
        &reviewer_receipt,
        &reviewer_set,
    );
    let mut intent = model_action_intent(
        &reviewer_request,
        &reviewer_dispatch_event,
        &reviewer_request_event,
    );
    intent.candidate_binding = Some(ModelActionCandidateBindingV1 {
        candidate_created_event_ref: candidate_event.id,
        candidate_digest: candidate.candidate_digest.clone(),
        candidate_commit_sha: candidate.candidate_commit_sha.clone(),
        candidate_view_ref: verdict.candidate_view_ref.clone(),
        candidate_view_digest: verdict.candidate_view_digest.clone(),
        candidate_view: candidate_view.clone(),
    });
    intent.intent_digest = model_action_intent_v1_digest(&intent).expect("rehash review intent");
    let intent_event = model_action_intent_event(run_id, &intent);
    apply(state, &intent_event);
    let reviewer_authorization = model_action_authorization_v2(&intent_event, &intent);
    apply(
        state,
        &model_action_authorization_v2_event(run_id, &intent_event, &reviewer_authorization),
    );
    let mut reviewer_claim = activity_claim(
        run_id,
        &reviewer_dispatch_event,
        &reviewer_request_event,
        &reviewer_request,
    );
    reviewer_claim.claimed_at = "2026-07-17T00:00:05Z".into();
    let reviewer_claim_event = activity_claim_event(run_id, &reviewer_claim);
    apply(state, &reviewer_claim_event);
    let mut reviewer_result = activity_result(
        &reviewer_claim_event,
        &reviewer_claim,
        ActivityResultOutcomeV1::Succeeded,
    );
    reviewer_result.result_ref = reviewer_receipt.result_ref.clone();
    reviewer_result.result_digest = reviewer_receipt.result_digest.clone();
    reviewer_result.recorded_at = "2026-07-17T00:00:06Z".into();
    apply(
        state,
        &activity_result_event(run_id, &reviewer_claim_event, &reviewer_result),
    );
    for (kind, payload) in [
        (
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(reviewer_receipt),
        ),
        (
            EventKind::ActionReceiptSetRecordedV1,
            Payload::ActionReceiptSetRecordedV1(reviewer_set),
        ),
        (
            EventKind::ReviewVerdictRecordedV2,
            Payload::ReviewVerdictRecordedV2(verdict.clone()),
        ),
    ] {
        apply(state, &event_of(run_id, kind, payload));
    }
    assert_eq!(
        state
            .workflow_instance
            .as_ref()
            .expect("reviewed candidate workflow")
            .phase,
        WorkflowPhaseV1::ReviewApproved,
        "valid sealed-v3 candidate and review setup: {:#?}",
        state.issues
    );
    assert!(
        state.issues.is_empty(),
        "valid sealed-v3 candidate and review setup: {:#?}",
        state.issues
    );

    SealedV3ReviewedCandidateFixture {
        candidate,
        candidate_acceptance,
        verdict,
    }
}

#[test]
fn workflow_deadline_timer_drives_an_exactly_bound_cancellation_terminal() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    let mut dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch.clone()),
    );
    event_occurred_at(&mut dispatch_event, "2026-07-17T00:00:00Z");
    let schedule = workflow_timer_schedule(run_id, &dispatch_event, &dispatch, "timer-1");
    let schedule_event = workflow_timer_schedule_event(run_id, &schedule);
    let fired = workflow_timer_fired(run_id, &schedule_event, &schedule, "2026-07-17T00:05:00Z");
    let fired_event = workflow_timer_fired_event(run_id, &fired);
    let cancellation = timeout_cancellation(run_id, &schedule, &fired_event);
    let cancellation_event = cancellation_event(run_id, &cancellation);
    let terminal = cancelled_terminal_v2(&dispatch, &cancellation_event);

    let mut state = ReplayState::default();
    for event in [
        dispatch_event,
        schedule_event,
        fired_event,
        cancellation_event,
        workflow_terminal_v2_event(run_id, &terminal),
    ] {
        apply(&mut state, &event);
    }

    let workflow = state.workflow_instance.expect("workflow projection");
    assert_eq!(workflow.phase, WorkflowPhaseV1::Cancelled);
    assert!(workflow
        .timers
        .get("timer-1")
        .is_some_and(|timer| timer.fired.is_some()));
    assert!(workflow.cancellation.is_some());
    assert!(state.issues.is_empty(), "issues: {:#?}", state.issues);
}

#[test]
fn cancellation_rejects_a_valid_promotion_rejection_and_allows_the_cancelled_terminal() {
    let (mut state, run_id, dispatch, dispatch_event, schedule, schedule_event) =
        lifecycle_timer_fixture();

    let mut candidate_request = action_request(
        run_id,
        &dispatch,
        "git-candidate-create:candidate-v2-1/run-1/1",
    );
    candidate_request.action_kind = ActionKindV1::Git;
    let candidate_request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(candidate_request.clone()),
    );
    let candidate_claim = activity_claim(
        run_id,
        &dispatch_event,
        &candidate_request_event,
        &candidate_request,
    );
    let candidate_claim_event = activity_claim_event(run_id, &candidate_claim);
    let candidate_result = activity_result(
        &candidate_claim_event,
        &candidate_claim,
        ActivityResultOutcomeV1::Succeeded,
    );
    let candidate_result_event =
        activity_result_event(run_id, &candidate_claim_event, &candidate_result);
    let candidate_receipt = action_receipt(&candidate_request, ActionReceiptOutcomeV2::Succeeded);
    let candidate_set = action_receipt_set(&candidate_request, &candidate_receipt);
    let candidate = candidate_v2(run_id, &dispatch, &candidate_set);
    let candidate_event = event_of(
        run_id,
        EventKind::CandidateCreatedV2,
        Payload::CandidateCreatedV2(candidate.clone()),
    );
    for event in [
        candidate_request_event.clone(),
        candidate_claim_event.clone(),
        candidate_result_event.clone(),
        event_of(
            run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(candidate_receipt.clone()),
        ),
        event_of(
            run_id,
            EventKind::ActionReceiptSetRecordedV1,
            Payload::ActionReceiptSetRecordedV1(candidate_set),
        ),
        candidate_event.clone(),
    ] {
        apply(&mut state, &event);
    }
    let completion = candidate_completion(
        &candidate,
        &candidate_event,
        &candidate_request,
        &candidate_request_event,
        &candidate_claim_event,
        &candidate_result_event,
        &candidate_receipt,
    );
    apply(
        &mut state,
        &candidate_completion_event(run_id, &candidate_event, &completion),
    );
    let candidate_acceptance = acceptance(CandidateAcceptanceOutcomeV1::Passed);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::CandidateAcceptanceRecorded,
            Payload::CandidateAcceptanceRecordedV1(candidate_acceptance.clone()),
        ),
    );

    let reviewer_dispatch =
        reviewer_dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    let reviewer_dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(reviewer_dispatch.clone()),
    );
    apply(&mut state, &reviewer_dispatch_event);
    let mut reviewer_request = action_request(run_id, &reviewer_dispatch, "review-action-cancel");
    reviewer_request.action_kind = ActionKindV1::Model;
    let reviewer_request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(reviewer_request.clone()),
    );
    apply(&mut state, &reviewer_request_event);
    let candidate_view = review_v2_candidate_view(&reviewer_dispatch);
    let review_output = review_v2_output(&candidate_view);
    let review_output_digest =
        review_verdict_output_v1_digest(&review_output).expect("hash closed review output");
    let mut reviewer_receipt = action_receipt(&reviewer_request, ActionReceiptOutcomeV2::Succeeded);
    reviewer_receipt.result_ref = Some(format!("cas:{review_output_digest}"));
    reviewer_receipt.result_digest = Some(review_output_digest);
    reviewer_receipt.authorization_ref =
        Some(format!("authorization:{}", reviewer_request.action_id));
    reviewer_receipt.completed_at = "2026-07-17T00:00:06Z".into();
    let reviewer_set = action_receipt_set(&reviewer_request, &reviewer_receipt);
    let verdict = review_v2(
        run_id,
        &dispatch,
        &reviewer_dispatch,
        &candidate_acceptance,
        &reviewer_request,
        &reviewer_receipt,
        &reviewer_set,
    );
    let mut intent = model_action_intent(
        &reviewer_request,
        &reviewer_dispatch_event,
        &reviewer_request_event,
    );
    intent.candidate_binding = Some(ModelActionCandidateBindingV1 {
        candidate_created_event_ref: candidate_event.id,
        candidate_digest: candidate.candidate_digest.clone(),
        candidate_commit_sha: candidate.candidate_commit_sha.clone(),
        candidate_view_ref: verdict.candidate_view_ref.clone(),
        candidate_view_digest: verdict.candidate_view_digest.clone(),
        candidate_view: candidate_view.clone(),
    });
    intent.intent_digest = model_action_intent_v1_digest(&intent).expect("rehash review intent");
    let intent_event = model_action_intent_event(run_id, &intent);
    apply(&mut state, &intent_event);
    let reviewer_authorization = model_action_authorization_v2(&intent_event, &intent);
    apply(
        &mut state,
        &model_action_authorization_v2_event(run_id, &intent_event, &reviewer_authorization),
    );
    let mut reviewer_claim = activity_claim(
        run_id,
        &reviewer_dispatch_event,
        &reviewer_request_event,
        &reviewer_request,
    );
    reviewer_claim.claimed_at = "2026-07-17T00:00:05Z".into();
    let reviewer_claim_event = activity_claim_event(run_id, &reviewer_claim);
    apply(&mut state, &reviewer_claim_event);
    let mut reviewer_result = activity_result(
        &reviewer_claim_event,
        &reviewer_claim,
        ActivityResultOutcomeV1::Succeeded,
    );
    reviewer_result.result_ref = reviewer_receipt.result_ref.clone();
    reviewer_result.result_digest = reviewer_receipt.result_digest.clone();
    reviewer_result.recorded_at = "2026-07-17T00:00:06Z".into();
    apply(
        &mut state,
        &activity_result_event(run_id, &reviewer_claim_event, &reviewer_result),
    );
    for (kind, payload) in [
        (
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(reviewer_receipt.clone()),
        ),
        (
            EventKind::ActionReceiptSetRecordedV1,
            Payload::ActionReceiptSetRecordedV1(reviewer_set.clone()),
        ),
        (
            EventKind::ReviewVerdictRecordedV2,
            Payload::ReviewVerdictRecordedV2(verdict.clone()),
        ),
    ] {
        apply(&mut state, &event_of(run_id, kind, payload));
    }
    assert_eq!(
        state
            .workflow_instance
            .as_ref()
            .expect("reviewed candidate workflow")
            .phase,
        WorkflowPhaseV1::ReviewApproved
    );
    assert!(
        state.issues.is_empty(),
        "valid candidate and review setup: {:#?}",
        state.issues
    );

    let fired = workflow_timer_fired(run_id, &schedule_event, &schedule, "2026-07-17T00:05:00Z");
    let fired_event = workflow_timer_fired_event(run_id, &fired);
    let cancellation = timeout_cancellation(run_id, &schedule, &fired_event);
    let cancellation_event = cancellation_event(run_id, &cancellation);
    apply(&mut state, &fired_event);
    apply(&mut state, &cancellation_event);
    assert_eq!(
        state
            .workflow_instance
            .as_ref()
            .expect("candidate workflow")
            .phase,
        WorkflowPhaseV1::CancellationRequested
    );

    let rejection = PromotionDecisionRecordedV1 {
        candidate_digest: candidate.candidate_digest.clone(),
        base_commit_sha: candidate.base_commit_sha.clone(),
        target_ref: Some("refs/heads/main".into()),
        envelope_digest: candidate.envelope_digest.clone(),
        acceptance_ref: candidate_acceptance.acceptance_ref.clone(),
        review_refs: vec![verdict.review_ref.clone()],
        promotion_approval_request_ref: None,
        decision: PromotionDecisionKindV1::Reject,
        authority: "operator".into(),
        decided_by: "operator".into(),
        decided_at: "2026-07-17T00:05:01Z".into(),
        idempotency_key: "promotion:cancelled-candidate".into(),
    };
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionDecisionRecorded,
            Payload::PromotionDecisionRecordedV1(rejection),
        ),
    );

    let workflow = state
        .workflow_instance
        .as_ref()
        .expect("candidate workflow after rejected promotion");
    assert_eq!(workflow.phase, WorkflowPhaseV1::CancellationRequested);
    assert!(workflow.promotion.is_none());
    assert!(has_activity_transition_rejection(
        &state,
        "promotion decision cannot be recorded after workflow cancellation"
    ));

    let mut terminal = cancelled_terminal_v2(&dispatch, &cancellation_event);
    terminal.candidate_digest = Some(candidate.candidate_digest.clone());
    apply(&mut state, &workflow_terminal_v2_event(run_id, &terminal));
    assert_eq!(
        state
            .workflow_instance
            .as_ref()
            .expect("cancelled candidate workflow")
            .phase,
        WorkflowPhaseV1::Cancelled,
        "cancellation terminal was rejected: {:#?}",
        state.issues
    );
}

#[test]
fn sealed_v3_candidate_completion_rejects_an_unbound_promotion_chain() {
    let (mut state, run_id, dispatch, dispatch_event, _schedule, _schedule_event) =
        lifecycle_timer_fixture();
    let reviewed =
        apply_sealed_v3_reviewed_candidate(&mut state, run_id, &dispatch, &dispatch_event);
    let decision = PromotionDecisionRecordedV1 {
        candidate_digest: reviewed.candidate.candidate_digest.clone(),
        base_commit_sha: reviewed.candidate.base_commit_sha.clone(),
        target_ref: None,
        envelope_digest: reviewed.candidate.envelope_digest.clone(),
        acceptance_ref: reviewed.candidate_acceptance.acceptance_ref.clone(),
        review_refs: vec![reviewed.verdict.review_ref.clone()],
        promotion_approval_request_ref: None,
        decision: PromotionDecisionKindV1::Promote,
        authority: "operator".into(),
        decided_by: "operator".into(),
        decided_at: "2026-07-17T00:04:00Z".into(),
        idempotency_key: "promotion:sealed-v3-unbound".into(),
    };
    let decision_event = event_of(
        run_id,
        EventKind::PromotionDecisionRecorded,
        Payload::PromotionDecisionRecordedV1(decision),
    );
    let result = PromotionResultRecordedV1 {
        candidate_digest: reviewed.candidate.candidate_digest.clone(),
        idempotency_key: "promotion:sealed-v3-unbound".into(),
        promotion_decision_ref: decision_event.id.to_string(),
        outcome: PromotionResultOutcomeV1::Promoted,
        merged_head_sha: Some("3".repeat(40)),
        promotion_git_binding: None,
        promotion_execution_lease_binding: None,
        completed_at: "2026-07-17T00:04:01Z".into(),
    };

    apply(&mut state, &decision_event);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::PromotionResultRecorded,
            Payload::PromotionResultRecordedV1(result),
        ),
    );

    let workflow = state
        .workflow_instances
        .values()
        .find(|workflow| workflow.unit_id == dispatch.body.unit_id)
        .expect("sealed-v3 candidate workflow");
    assert_eq!(workflow.phase, WorkflowPhaseV1::ReviewApproved);
    assert!(workflow.promotion.is_none());
    assert!(state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("sealed_v3 promotion decision requires a canonical target_ref")
    )));
}

fn lifecycle_timer_fixture() -> (
    ReplayState,
    RunId,
    DispatchEnvelopeV3,
    Event,
    WorkflowTimerScheduledV1,
    Event,
) {
    let run_id = RunId::new();
    let dispatch = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    let mut dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch.clone()),
    );
    event_occurred_at(&mut dispatch_event, "2026-07-17T00:00:00Z");
    let schedule = workflow_timer_schedule(run_id, &dispatch_event, &dispatch, "timer-fixture");
    let schedule_event = workflow_timer_schedule_event(run_id, &schedule);
    let mut state = ReplayState::default();
    apply(&mut state, &dispatch_event);
    apply(&mut state, &schedule_event);
    assert!(state.issues.is_empty(), "timer setup: {:#?}", state.issues);
    (
        state,
        run_id,
        dispatch,
        dispatch_event,
        schedule,
        schedule_event,
    )
}

#[test]
fn workflow_timer_rejects_early_substituted_and_duplicate_fires() {
    let (mut state, run_id, _dispatch, _dispatch_event, schedule, schedule_event) =
        lifecycle_timer_fixture();

    let early = workflow_timer_fired(run_id, &schedule_event, &schedule, "2026-07-17T00:04:59Z");
    apply(&mut state, &workflow_timer_fired_event(run_id, &early));

    let mut substituted =
        workflow_timer_fired(run_id, &schedule_event, &schedule, "2026-07-17T00:05:00Z");
    substituted.timer_schedule_event_digest = DIGEST_A.into();
    apply(
        &mut state,
        &workflow_timer_fired_event(run_id, &substituted),
    );

    let valid = workflow_timer_fired(run_id, &schedule_event, &schedule, "2026-07-17T00:05:00Z");
    apply(&mut state, &workflow_timer_fired_event(run_id, &valid));
    apply(&mut state, &workflow_timer_fired_event(run_id, &valid));

    let workflow = state.workflow_instance.as_ref().expect("workflow state");
    assert!(workflow
        .timers
        .get("timer-fixture")
        .is_some_and(|timer| timer.fired.is_some()));
    assert!(has_activity_transition_rejection(
        &state,
        "no earlier than due_at"
    ));
    assert!(has_activity_transition_rejection(
        &state,
        "bind the exact schedule"
    ));
    assert!(has_activity_transition_rejection(
        &state,
        "cannot replace an immutable firing record"
    ));
}

#[test]
fn workflow_lifecycle_controls_require_governed_sealed_v3_dispatch() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3();
    let mut dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch.clone()),
    );
    event_occurred_at(&mut dispatch_event, "2026-07-17T00:00:00Z");
    let schedule = workflow_timer_schedule(run_id, &dispatch_event, &dispatch, "legacy-timer");
    let mut state = ReplayState::default();
    apply(&mut state, &dispatch_event);
    apply(
        &mut state,
        &workflow_timer_schedule_event(run_id, &schedule),
    );
    assert!(has_activity_transition_rejection(
        &state,
        "governed atomic sealed_v3 dispatch envelope"
    ));

    let run_id = RunId::new();
    let mut preview = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    preview.body.trust_tier = TrustTierV1::Raw;
    preview.envelope_digest = dispatch_envelope_v3_body_digest(
        &preview.body,
        preview.action_evidence_version,
        &preview.repository_binding_digest,
        &preview.ledger_authority_realm_digest,
        preview.governed_packet_digest.as_deref(),
    )
    .expect("recompute preview fixture digest");
    let mut preview_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(preview.clone()),
    );
    event_occurred_at(&mut preview_event, "2026-07-17T00:00:00Z");
    let schedule = workflow_timer_schedule(run_id, &preview_event, &preview, "preview-timer");
    let mut state = ReplayState::default();
    apply(&mut state, &preview_event);
    apply(
        &mut state,
        &workflow_timer_schedule_event(run_id, &schedule),
    );
    assert!(has_activity_transition_rejection(
        &state,
        "governed atomic sealed_v3 dispatch envelope"
    ));
}

#[test]
fn cancellation_requires_v2_terminal_with_exact_request_binding() {
    let (mut state, run_id, dispatch, _dispatch_event, schedule, schedule_event) =
        lifecycle_timer_fixture();
    let fired = workflow_timer_fired(run_id, &schedule_event, &schedule, "2026-07-17T00:05:00Z");
    let fired_event = workflow_timer_fired_event(run_id, &fired);
    let cancellation = timeout_cancellation(run_id, &schedule, &fired_event);
    let cancellation_event = cancellation_event(run_id, &cancellation);
    apply(&mut state, &fired_event);
    apply(&mut state, &cancellation_event);

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::WorkflowTerminal,
            Payload::WorkflowTerminalV1(failed_terminal(&dispatch)),
        ),
    );
    let mut wrong_terminal = cancelled_terminal_v2(&dispatch, &cancellation_event);
    wrong_terminal.cancellation_request_event_ref = Some(EventId::new());
    apply(
        &mut state,
        &workflow_terminal_v2_event(run_id, &wrong_terminal),
    );
    let mut reconciliation_terminal = cancelled_terminal_v2(&dispatch, &cancellation_event);
    reconciliation_terminal.reconciliation_resolution_ref = Some("reconcile:wrong".into());
    apply(
        &mut state,
        &workflow_terminal_v2_event(run_id, &reconciliation_terminal),
    );

    assert_eq!(
        state
            .workflow_instance
            .as_ref()
            .expect("workflow state")
            .phase,
        WorkflowPhaseV1::CancellationRequested
    );
    assert!(has_activity_transition_rejection(
        &state,
        "workflow_terminal_v1 cannot close a newly requested cancellation"
    ));
    assert!(has_activity_transition_rejection(
        &state,
        "terminal outcome does not match the recorded promotion or cancellation state"
    ));
}

#[test]
fn cancellation_cannot_bypass_pending_promotion_or_reconciliation() {
    for phase in [
        WorkflowPhaseV1::PromotionApprovalPending,
        WorkflowPhaseV1::PromotionPending,
        WorkflowPhaseV1::PromotionReconciliationRequired,
        WorkflowPhaseV1::PromotionReconciliationResolved,
    ] {
        let (mut state, run_id, _dispatch, dispatch_event, schedule, _schedule_event) =
            lifecycle_timer_fixture();
        state
            .workflow_instance
            .as_mut()
            .expect("workflow state")
            .phase = phase;
        state
            .workflow_instances
            .values_mut()
            .next()
            .expect("workflow instance state")
            .phase = phase;
        let cancellation = WorkflowCancellationRequestedV1 {
            run_id: run_id.to_string(),
            workflow_id: schedule.workflow_id.clone(),
            workflow_revision: schedule.workflow_revision.clone(),
            unit_id: schedule.unit_id.clone(),
            attempt: schedule.attempt,
            dispatch_event_ref: schedule.dispatch_event_ref,
            dispatch_envelope_digest: schedule.dispatch_envelope_digest.clone(),
            cancellation_id: format!("operator-cancel:{phase:?}"),
            cause: WorkflowCancellationCauseV1::OperatorRequested,
            timer_fired_event_ref: None,
            timer_fired_event_digest: None,
            requested_by: "operator".into(),
            idempotency_key: format!("operator-cancel:{phase:?}"),
            requested_at: "2026-07-17T00:02:00Z".into(),
        };
        let mut event = cancellation_event(run_id, &cancellation);
        event.parent_event_id = Some(dispatch_event.id);
        apply(&mut state, &event);
        assert!(has_activity_transition_rejection(
            &state,
            "cancellation cannot bypass terminal, promotion-pending, or reconciliation state"
        ));
        assert_eq!(
            state
                .workflow_instance
                .as_ref()
                .expect("workflow state")
                .phase,
            phase
        );
    }
}

#[test]
fn cancellation_allows_only_inflight_effect_reconciliation_before_terminalization() {
    let run_id = RunId::new();
    let dispatch = dispatch_v3_with_action_evidence(ActionEvidenceVersionV1::SealedV3);
    let mut dispatch_event = event_of(
        run_id,
        EventKind::DispatchEnvelopeV3,
        Payload::DispatchEnvelopeV3(dispatch.clone()),
    );
    event_occurred_at(&mut dispatch_event, "2026-07-17T00:00:00Z");
    let request = action_request(run_id, &dispatch, "inflight-effect");
    let request_event = event_of(
        run_id,
        EventKind::ActionRequestedV2,
        Payload::ActionRequestedV2(request.clone()),
    );
    let claim = activity_claim(run_id, &dispatch_event, &request_event, &request);
    let claim_event = activity_claim_event(run_id, &claim);
    let schedule = workflow_timer_schedule(run_id, &dispatch_event, &dispatch, "inflight-timer");
    let schedule_event = workflow_timer_schedule_event(run_id, &schedule);
    let fired = workflow_timer_fired(run_id, &schedule_event, &schedule, "2026-07-17T00:05:00Z");
    let fired_event = workflow_timer_fired_event(run_id, &fired);
    let cancellation = timeout_cancellation(run_id, &schedule, &fired_event);
    let cancellation_event = cancellation_event(run_id, &cancellation);
    let terminal = cancelled_terminal_v2(&dispatch, &cancellation_event);

    let mut state = ReplayState::default();
    for event in [
        dispatch_event.clone(),
        request_event,
        claim_event.clone(),
        schedule_event,
        fired_event,
        cancellation_event,
    ] {
        apply(&mut state, &event);
    }
    assert_eq!(
        state
            .workflow_instance
            .as_ref()
            .expect("workflow state")
            .phase,
        WorkflowPhaseV1::CancellationRequested
    );

    let heartbeat = activity_heartbeat(
        &claim_event,
        &claim,
        "2026-07-17T00:00:30Z",
        "2026-07-17T00:02:00Z",
    );
    apply(
        &mut state,
        &activity_heartbeat_event(run_id, &claim_event, &heartbeat),
    );
    apply(&mut state, &workflow_terminal_v2_event(run_id, &terminal));
    assert_eq!(
        state
            .workflow_instance
            .as_ref()
            .expect("workflow state")
            .phase,
        WorkflowPhaseV1::CancellationRequested
    );

    let result = activity_result(&claim_event, &claim, ActivityResultOutcomeV1::Succeeded);
    apply(
        &mut state,
        &activity_result_event(run_id, &claim_event, &result),
    );
    let receipt = action_receipt(&request, ActionReceiptOutcomeV2::Succeeded);
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::ActionReceiptRecordedV2,
            Payload::ActionReceiptRecordedV2(receipt),
        ),
    );
    apply(&mut state, &workflow_terminal_v2_event(run_id, &terminal));

    assert!(has_activity_transition_rejection(
        &state,
        "activity heartbeat is not allowed from workflow phase"
    ));
    assert_eq!(
        state
            .workflow_instance
            .as_ref()
            .expect("workflow state")
            .phase,
        WorkflowPhaseV1::Cancelled
    );
}

#[test]
fn workflow_snapshot_defaults_added_lifecycle_fields() {
    let (mut state, run_id, dispatch, _, _, _) = lifecycle_timer_fixture();
    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::WorkflowTerminal,
            Payload::WorkflowTerminalV1(failed_terminal(&dispatch)),
        ),
    );
    let workflow = state.workflow_instance.expect("workflow projection");
    let mut snapshot = serde_json::to_value(workflow).expect("serialize workflow snapshot");
    snapshot
        .as_object_mut()
        .expect("workflow object")
        .remove("timers");
    snapshot
        .as_object_mut()
        .expect("workflow object")
        .remove("cancellation");
    let terminal = snapshot["terminal"]
        .as_object_mut()
        .expect("terminal object");
    terminal.remove("terminal_version");
    terminal.remove("cancellation_request_event_ref");
    terminal.remove("cancellation_request_event_digest");
    let restored: WorkflowInstanceV1 =
        serde_json::from_value(snapshot).expect("deserialize legacy workflow snapshot");
    assert!(restored.timers.is_empty());
    assert!(restored.cancellation.is_none());
    assert_eq!(
        restored.terminal.expect("legacy terminal").terminal_version,
        1
    );
}
