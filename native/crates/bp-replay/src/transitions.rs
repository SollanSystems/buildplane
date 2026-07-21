//! Per-EventKind state transition functions.

use crate::state::{
    ActionEvidenceReplayState, ActionReceiptReplayState, ActionReceiptSetReplayState,
    ActionReplayState, ActionRequestReplayState, ActivityClaimReplayState,
    ActivityHeartbeatReplayState, ActivityResultReplayState, AttemptContextReplayState,
    CandidateAcceptanceReplayState, CandidateArtifactReplayState, CandidateCompletionReplayState,
    CheckpointRef, FileObservation, ModelActionAuthorizationReplayState,
    ModelActionIntentReplayState, PlanAcceptanceReplayState, PlanAdmissionReplayState,
    PlanReceiptReplayState, PromotionApprovalRequestReplayState, PromotionDecisionReplayState,
    PromotionExecutionClaimReplayState, PromotionReconciliationReplayState, PromotionReplayState,
    PromotionResultReplayState, RecordedActivityState, ReplayIssue, ReplayState,
    ReviewVerdictReplayState, WorkflowCancellationReplayState, WorkflowDispatchReplayState,
    WorkflowGraphReplayState, WorkflowGraphV2ReplayState, WorkflowInstanceV1, WorkflowPhaseV1,
    WorkflowTerminalReplayState, WorkflowTimerFiredReplayState, WorkflowTimerReplayState,
};
use bp_ledger::canonicalize::{
    canonical_event_hash, canonicalize, is_canonical_buildplane_candidate_ref,
    BUILDPANE_CANDIDATE_REF_PREFIX,
};
use bp_ledger::event::Event;
use bp_ledger::id::EventId;
use bp_ledger::payload::{
    acceptance::AcceptanceRecordedV1,
    activity::{ActivityCompletedV1, ActivityStartedV1, ActivityType},
    activity_claim::{
        ActivityClaimedV1, ActivityHeartbeatRecordedV1, ActivityResultOutcomeV1,
        ActivityResultRecordedV1,
    },
    git_checkpoint::{CheckpointBoundary, GitCheckpointV1, GitStatus},
    plan_lifecycle::{PlanAdmittedV1, PlanReceiptOutcome, PlanReceiptRecordedV1},
    run_lifecycle::{RunCompletedV1, RunFailedV1, RunStartedV1},
    tool_io::{ToolRequestStoredV1, ToolResultV1},
    trust_spine::{
        action_receipt_recorded_v2_digest, action_receipt_set_v1_digest,
        action_requested_v2_digest, candidate_completion_recorded_v1_digest,
        candidate_view_v1_digest, dispatch_envelope_v2_body_digest,
        dispatch_envelope_v3_body_digest, dispatch_envelope_v4_digest,
        governed_dispatch_policy_digest_v1, model_action_authorized_v1_digest,
        model_action_authorized_v2_digest, model_action_intent_v1_digest,
        promotion_execution_claimed_v1_digest, review_verdict_output_v1_digest,
        ActionEvidenceVersionV1, ActionKindV1, ActionReceiptOutcomeV2, ActionReceiptRecordedV2,
        ActionReceiptSetRecordedV1, ActionRequestedV2, ActionResourceUsageV1,
        AttemptContextRecordedV1, CandidateAcceptanceOutcomeV1, CandidateAcceptanceRecordedV1,
        CandidateCompletionRecordedV1, CandidateCreatedV1, CandidateCreatedV2, CommitModeV1,
        DispatchBudgetV1, DispatchEnvelopeBodyV2, DispatchEnvelopeV1, DispatchEnvelopeV2,
        DispatchEnvelopeV3, DispatchEnvelopeV4, ExecutionRoleV1, ModelActionAuthorizedV1,
        ModelActionAuthorizedV2, ModelActionCandidateBindingV1, ModelActionIntentV1,
        PromotionApprovalRequestedV1, PromotionDecisionKindV1, PromotionDecisionRecordedV1,
        PromotionExecutionClaimedV1, PromotionGitBindingV1, PromotionReconciliationResolvedV1,
        PromotionResultOutcomeV1, PromotionResultRecordedV1, PromotionWorktreeSyncStateV1,
        ReconciliationResolutionOutcomeV1, ReviewDecisionV1, ReviewVerdictOutputV1,
        ReviewVerdictRecordedV1, ReviewVerdictRecordedV2, TrustTierV1, WorkflowCancellationCauseV1,
        WorkflowCancellationRequestedV1, WorkflowGraphDeclaredV1, WorkflowGraphDeclaredV2,
        WorkflowTerminalOutcomeV1, WorkflowTerminalV1, WorkflowTerminalV2, WorkflowTimerFiredV1,
        WorkflowTimerScheduledV1,
    },
    unit_lifecycle::{UnitCancelledV1, UnitCompletedV1, UnitFailedV1, UnitStartedV1},
    workspace::{PostWriteState, WorkspaceWriteV1},
    Payload,
};
use bp_ledger::signing::ActorKeyRef;
use chrono::{DateTime, Duration, SecondsFormat, Utc};

/// Apply an event without detached-signature or signer-purpose verification.
///
/// This is retained exclusively for legacy deterministic projection tests and
/// snapshot migration tooling. Governed production recovery must enter through
/// [`crate::TrustedGovernedRecoverySnapshot`] or [`crate::ReplayEngine`].
pub fn apply_legacy_projection_unchecked(state: &mut ReplayState, event: &Event) {
    apply_with_verified_signer(state, event, None);
}

/// Historical unchecked reducer compatibility surface.
///
/// New callers must use [`apply_legacy_projection_unchecked`] only in
/// tests/migration tooling, or use trusted replay for governed authority.
#[deprecated(
    note = "unchecked reducer projection is legacy/test-only; use ReplayEngine or TrustedGovernedRecoverySnapshot for governed recovery"
)]
pub fn apply(state: &mut ReplayState, event: &Event) {
    apply_legacy_projection_unchecked(state, event);
}

/// Apply one tape event with the detached signer that an authoritative replay
/// engine already verified. The direct reducer API deliberately remains
/// signer-free for legacy projection and migration tests; only the engine can
/// populate this context, which lets activity-result transitions prove the
/// terminal writer is the exact signer that held the original lease.
pub(crate) fn apply_with_verified_signer(
    state: &mut ReplayState,
    event: &Event,
    signer: Option<&ActorKeyRef>,
) {
    match &event.payload {
        Payload::RunStartedV1(p) => apply_run_started(state, event, p),
        Payload::RunCompletedV1(p) => apply_run_completed(state, event, p),
        Payload::RunFailedV1(p) => apply_run_failed(state, event, p),
        Payload::UnitStartedV1(p) => apply_unit_started(state, event, p),
        Payload::UnitCompletedV1(p) => apply_unit_completed(state, event, p),
        Payload::UnitFailedV1(p) => apply_unit_failed(state, event, p),
        Payload::UnitCancelledV1(p) => apply_unit_cancelled(state, event, p),
        Payload::GitCheckpointV1(p) => apply_git_checkpoint(state, event, p),
		// Admission and release campaign evidence are authoritative tape metadata,
		// not workflow-state transitions. They remain available to verified
		// recovery/query paths without changing the reducer projection.
        Payload::RunAdmissionRecordedV1(_) | Payload::ReleaseEvaluationEvidenceV1(_) => {}
        Payload::PlanAdmittedV1(p) => apply_plan_admitted(state, event, p),
        Payload::PlanReceiptRecordedV1(p) => apply_plan_receipt(state, event, p),
        Payload::ActivityStartedV1(p) => apply_activity_started(state, event, p),
        Payload::ActivityCompletedV1(p) => apply_activity_completed(state, event, p),
        Payload::ModelRequestV1(_)
        | Payload::ModelResponseV1(_)
        // Tape-root checkpoints (M1-S6) are tape-integrity metadata, not
        // replayable state transitions — no-op during replay.
        | Payload::TapeCheckpointV1(_) => {}
        Payload::ToolRequestStoredV1(p) => apply_tool_request(state, event, p),
        Payload::ToolResultV1(p) => apply_tool_result(state, event, p),
        Payload::WorkspaceReadV1(_) => {}
        Payload::WorkspaceWriteV1(p) => apply_workspace_write(state, event, p),
        Payload::CapabilityDeniedV1(_) => {},
        Payload::AcceptanceRecordedV1(p) => apply_acceptance_recorded(state, event, p),
        Payload::DispatchEnvelopeV1(p) => apply_dispatch_envelope(state, event, p),
        Payload::DispatchEnvelopeV2(p) => apply_dispatch_envelope_v2(state, event, p),
        Payload::DispatchEnvelopeV3(p) => apply_dispatch_envelope_v3(state, event, p),
        Payload::DispatchEnvelopeV4(p) => apply_dispatch_envelope_v4(state, event, p),
        Payload::WorkflowGraphDeclaredV1(p) => {
            apply_workflow_graph_declared_v1(state, event, p)
        }
        Payload::WorkflowGraphDeclaredV2(p) => {
            apply_workflow_graph_declared_v2(state, event, p)
        }
        Payload::ActionRequestedV2(p) => apply_action_requested_v2(state, event, p),
        Payload::ModelActionIntentV1(p) => apply_model_action_intent_v1(state, event, p),
        Payload::ActivityClaimedV1(p) => apply_activity_claimed_v1(state, event, p, signer),
        Payload::ActivityHeartbeatRecordedV1(p) => {
            apply_activity_heartbeat_recorded_v1(state, event, p, signer)
        }
        Payload::ActivityResultRecordedV1(p) => {
            apply_activity_result_recorded_v1(state, event, p, signer)
        }
        Payload::ModelActionAuthorizedV1(p) => apply_model_action_authorized_v1(state, event, p),
        Payload::ModelActionAuthorizedV2(p) => apply_model_action_authorized_v2(state, event, p),
        Payload::ActionReceiptRecordedV2(p) => apply_action_receipt_recorded_v2(state, event, p),
        Payload::ActionReceiptSetRecordedV1(p) => {
            apply_action_receipt_set_recorded_v1(state, event, p)
        }
        Payload::AttemptContextRecordedV1(p) => {
            apply_attempt_context_recorded_v1(state, event, p)
        }
        Payload::CandidateCreatedV1(p) => apply_candidate_created(state, event, p),
        Payload::CandidateCreatedV2(p) => apply_candidate_created_v2(state, event, p),
        Payload::CandidateCompletionRecordedV1(p) => {
            apply_candidate_completion_recorded_v1(state, event, p)
        }
        Payload::CandidateAcceptanceRecordedV1(p) => {
            apply_candidate_acceptance(state, event, p)
        }
        Payload::ReviewVerdictRecordedV1(p) => apply_review_verdict(state, event, p),
        Payload::ReviewVerdictRecordedV2(p) => apply_review_verdict_v2(state, event, p),
        Payload::PromotionApprovalRequestedV1(p) => {
            apply_promotion_approval_requested(state, event, p)
        }
        Payload::PromotionDecisionRecordedV1(p) => apply_promotion_decision(state, event, p),
        Payload::PromotionExecutionClaimedV1(p) => {
            apply_promotion_execution_claimed_v1(state, event, p, signer)
        }
        Payload::PromotionResultRecordedV1(p) => apply_promotion_result(state, event, p),
        Payload::PromotionReconciliationResolvedV1(p) => {
            apply_promotion_reconciliation_resolved(state, event, p)
        }
        Payload::WorkflowTimerScheduledV1(p) => apply_workflow_timer_scheduled_v1(state, event, p),
        Payload::WorkflowTimerFiredV1(p) => apply_workflow_timer_fired_v1(state, event, p),
        Payload::WorkflowCancellationRequestedV1(p) => {
            apply_workflow_cancellation_requested_v1(state, event, p)
        }
        Payload::WorkflowTerminalV1(p) => apply_workflow_terminal(state, event, p),
        Payload::WorkflowTerminalV2(p) => apply_workflow_terminal_v2(state, event, p),
        // M5 operator decisions are tape metadata, not replayable state — no-op.
        Payload::OperatorDecisionRecordedV1(_) => {}
        // M6 result-ready is a terminal tape signal, not replayable state — no-op.
        Payload::ResultReadyV1(_) => {}
    }
}

fn apply_run_started(state: &mut ReplayState, event: &Event, p: &RunStartedV1) {
    state.run_id = Some(event.run_id.to_string());
    state.parent_run_id = p.parent_run_id.as_ref().map(|id| id.to_string());
    state.parent_event_id = p.parent_event_id.as_ref().map(|id| id.to_string());
    state.parent_chain.push(event.id);
}

fn apply_run_completed(state: &mut ReplayState, _event: &Event, _p: &RunCompletedV1) {
    state.parent_chain.clear();
}

fn apply_run_failed(state: &mut ReplayState, _event: &Event, _p: &RunFailedV1) {
    state.parent_chain.clear();
}

fn apply_unit_started(state: &mut ReplayState, event: &Event, p: &UnitStartedV1) {
    state.current_unit = Some(p.unit_id.clone());
    state.parent_chain.push(event.id);
}

fn apply_unit_completed(state: &mut ReplayState, _event: &Event, _p: &UnitCompletedV1) {
    state.current_unit = None;
    state.parent_chain.pop();
}

fn apply_unit_failed(state: &mut ReplayState, _event: &Event, _p: &UnitFailedV1) {
    state.current_unit = None;
    state.parent_chain.pop();
}

fn apply_unit_cancelled(state: &mut ReplayState, _event: &Event, _p: &UnitCancelledV1) {
    state.current_unit = None;
    state.parent_chain.pop();
}

fn apply_git_checkpoint(state: &mut ReplayState, event: &Event, p: &GitCheckpointV1) {
    match &p.git_status {
        GitStatus::Ok => {
            state.checkpoints.push(CheckpointRef {
                boundary: match p.boundary {
                    CheckpointBoundary::PreUnit => "pre-unit".to_string(),
                    CheckpointBoundary::PostUnit => "post-unit".to_string(),
                },
                reference: p.reference.clone(),
                commit_sha: p.commit_sha.clone(),
                unit_id: p.unit_id.clone(),
                from_event_id: event.id,
            });
        }
        GitStatus::Failed { error } => {
            state.issues.push(ReplayIssue::CheckpointFailed {
                unit_id: p.unit_id.clone(),
                step: "unknown".to_string(),
                error: error.clone(),
            });
        }
    }
}

fn apply_plan_admitted(state: &mut ReplayState, event: &Event, p: &PlanAdmittedV1) {
    state.plan_cycle_phase = "plan_admitted".to_string();
    state.plan_admission = Some(PlanAdmissionReplayState {
        event_id: event.id,
        plan_id: p.plan_id.clone(),
        plan_digest: p.plan_digest.clone(),
        input_digest: p.input_digest.clone(),
        trusted_base: p.trusted_base.clone(),
        decided_by: p.decided_by.clone(),
        decided_at: p.decided_at.clone(),
        idempotency_key: p.idempotency_key.clone(),
        authorized_next_step: p.authorized_next_step.clone(),
    });
}

fn apply_acceptance_recorded(state: &mut ReplayState, event: &Event, p: &AcceptanceRecordedV1) {
    state.plan_cycle_phase = "acceptance_recorded".to_string();
    state.plan_acceptance = Some(PlanAcceptanceReplayState {
        event_id: event.id,
        plan_id: p.plan_id.clone(),
        admission_event_id: p.admission_event_id.clone(),
        contract_digest: p.contract_digest.clone(),
        outcome: p.outcome.clone(),
        diff_scope_status: p.diff_scope_status.clone(),
        out_of_scope_files: p.out_of_scope_files.clone(),
        evaluated_at: p.evaluated_at.clone(),
    });
}

fn apply_activity_started(state: &mut ReplayState, event: &Event, p: &ActivityStartedV1) {
    if governed_activity_bracketing_is_required(state, event, &p.activity_id) {
        if p.run_id != event.run_id {
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                "activity_started payload run_id does not match its event run_id".into(),
            );
            return;
        }

        let activity_type = activity_type_wire(p.activity_type);
        let activity_run_id = p.run_id.to_string();
        if let Some(existing) = state.activities.get(&p.activity_id) {
            if existing.completed_event_id.is_some() {
                reject_activity_transition(
                    state,
                    event,
                    &p.activity_id,
                    "activity_started received after an immutable completed result".into(),
                );
                return;
            }
            if existing.started_event_id.is_some()
                && existing.run_id.as_deref() == Some(activity_run_id.as_str())
                && existing.activity_type.as_deref() == Some(activity_type)
                && existing.input_digest.as_deref() == Some(p.input_digest.as_str())
            {
                // Retried delivery of the same write-ahead intent must not
                // replace the original event identity or alter recovery state.
                return;
            }
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                "activity_started does not match the existing governed write-ahead intent".into(),
            );
            return;
        }
    }

    state.plan_cycle_phase = "activity_started".to_string();
    let entry = state
        .activities
        .entry(p.activity_id.clone())
        .or_insert_with(|| RecordedActivityState {
            activity_id: p.activity_id.clone(),
            ..RecordedActivityState::default()
        });
    entry.run_id = Some(p.run_id.to_string());
    entry.activity_type = Some(activity_type_wire(p.activity_type).to_string());
    entry.input_digest = Some(p.input_digest.clone());
    entry.started_event_id = Some(event.id);
}

fn apply_activity_completed(state: &mut ReplayState, event: &Event, p: &ActivityCompletedV1) {
    if governed_activity_bracketing_is_required(state, event, &p.activity_id) {
        if p.run_id != event.run_id {
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                "activity_completed payload run_id does not match its event run_id".into(),
            );
            return;
        }

        // Read the existing state first. This keeps rejection paths free to
        // append an issue without holding a mutable map entry borrow.
        let Some(existing) = state.activities.get(&p.activity_id) else {
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                "activity_completed has no prior governed write-ahead intent".into(),
            );
            return;
        };
        let recorded_run_id = existing.run_id.clone();
        let started_event_id = existing.started_event_id;
        let completed_event_id = existing.completed_event_id;
        let recorded_result_digest = existing.result_digest.clone();
        let recorded_result = existing.result.clone();
        let activity_run_id = p.run_id.to_string();
        if recorded_run_id.as_deref() != Some(activity_run_id.as_str())
            || started_event_id.is_none()
        {
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                "activity_completed does not bind the recorded governed write-ahead intent".into(),
            );
            return;
        }
        if completed_event_id.is_some() {
            if recorded_result_digest.as_deref() == Some(p.result_digest.as_str())
                && recorded_result.as_ref() == Some(&p.result)
            {
                // The completion result is immutable. A duplicate delivery of
                // the same result is a no-op, not a new recovery outcome.
                return;
            }
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                "activity_completed attempts to replace an immutable governed result".into(),
            );
            return;
        }

        state.plan_cycle_phase = "activity_completed".to_string();
        let entry = state
            .activities
            .get_mut(&p.activity_id)
            .expect("activity was checked above");
        entry.completed_event_id = Some(event.id);
        entry.result_digest = Some(p.result_digest.clone());
        entry.result = Some(p.result.clone());
        return;
    }

    state.plan_cycle_phase = "activity_completed".to_string();
    let entry = state
        .activities
        .entry(p.activity_id.clone())
        .or_insert_with(|| RecordedActivityState {
            activity_id: p.activity_id.clone(),
            ..RecordedActivityState::default()
        });
    entry.run_id = Some(p.run_id.to_string());
    entry.completed_event_id = Some(event.id);
    entry.result_digest = Some(p.result_digest.clone());
    entry.result = Some(p.result.clone());
}

/// Activity V1 is explicitly **run-scoped**: it carries a `run_id` and a
/// stable per-run `activity_id`, but no workflow/unit/attempt identity. Every
/// activity in a governed run therefore uses the same kernel-signed
/// write-ahead/result contract, even when that run contains multiple graph
/// units. Callers must allocate activity IDs uniquely across those units.
///
/// A run cannot mix raw and governed dispatches, and its first governed
/// dispatch must precede every activity bracket. Those two rules avoid an
/// ambiguous activity tier without changing legacy or raw-only replay. The
/// authority-aware engine may additionally predeclare a governed run from a
/// later valid dispatch, so an untrusted earlier bracket is never adopted by
/// idempotency when replay reaches that dispatch.
pub(crate) fn governed_activity_bracketing_is_required(
    state: &ReplayState,
    event: &Event,
    activity_id: &str,
) -> bool {
    governed_activity_bracketing_is_required_for_run(state, event, activity_id, false)
}

/// Same run-scoped activity decision as
/// [`governed_activity_bracketing_is_required`], with the engine's
/// authority-verified dispatch pre-scan included. Direct reducer users pass
/// `false`; they are protected separately because a first governed dispatch
/// rejects any pre-existing activity bracket in the run.
pub(crate) fn governed_activity_bracketing_is_required_for_run(
    state: &ReplayState,
    event: &Event,
    activity_id: &str,
    predeclared_governed_run: bool,
) -> bool {
    predeclared_governed_run
        || governed_workflow_run_exists(state, &event.run_id.to_string())
        || state
            .activities
            .get(activity_id)
            .and_then(|activity| activity.run_id.as_deref())
            .is_some_and(|run_id| governed_workflow_run_exists(state, run_id))
}

/// A first governed dispatch is an admission boundary. The unchecked reducer
/// cannot inspect detached signatures attached to previously applied
/// activities, so it must fail closed rather than adopting those records as
/// governed write-ahead state. The `ReplayEngine` pre-scan prevents this path
/// for normal tape replay by refusing the untrusted earlier brackets first.
fn validate_dispatch_run_scope(
    state: &ReplayState,
    event: &Event,
    incoming_trust_tier: TrustTierV1,
) -> Result<(), String> {
    let run_id = event.run_id.to_string();
    let existing_run_workflows = state
        .workflow_instances
        .values()
        .filter(|workflow| workflow.run_id == run_id)
        .collect::<Vec<_>>();

    if existing_run_workflows
        .iter()
        .any(|workflow| workflow.dispatch.trust_tier != incoming_trust_tier)
    {
        return Err(
            "raw and governed dispatch envelopes cannot mix within one activity V1 run scope"
                .into(),
        );
    }

    if incoming_trust_tier == TrustTierV1::Governed
        && existing_run_workflows.is_empty()
        && state
            .activities
            .values()
            .any(|activity| activity.run_id.as_deref() == Some(run_id.as_str()))
    {
        return Err(
            "first governed dispatch must precede every activity V1 bracket in its run scope"
                .into(),
        );
    }

    Ok(())
}

fn governed_workflow_run_exists(state: &ReplayState, run_id: &str) -> bool {
    state.workflow_instances.values().any(|workflow| {
        workflow.run_id == run_id && workflow.dispatch.trust_tier == TrustTierV1::Governed
    }) || state.workflow_instance.as_ref().is_some_and(|workflow| {
        workflow.run_id == run_id && workflow.dispatch.trust_tier == TrustTierV1::Governed
    })
}

fn reject_activity_transition(
    state: &mut ReplayState,
    event: &Event,
    activity_id: &str,
    reason: String,
) {
    state.issues.push(ReplayIssue::ActivityTransitionRejected {
        event_id: event.id,
        activity_id: activity_id.to_string(),
        reason,
    });
}

fn apply_plan_receipt(state: &mut ReplayState, event: &Event, p: &PlanReceiptRecordedV1) {
    state.plan_cycle_phase = "plan_receipt".to_string();
    state.plan_receipt = Some(PlanReceiptReplayState {
        event_id: event.id,
        plan_id: p.plan_id.clone(),
        admission_event_id: p.admission_event_id,
        outcome: plan_receipt_outcome_wire(p.outcome).to_string(),
        side_effects: p.side_effects.clone(),
        result_digest: p.result_digest.clone(),
        decided_at: p.decided_at.clone(),
    });
}

fn workflow_instance_key(workflow_id: &str, unit_id: &str, attempt: u32) -> String {
    // Length-prefix the untrusted identifiers rather than using a delimiter.
    // A caller-controlled NUL in either identifier must not let two different
    // workflow/unit tuples collide in the durable projection key.
    format!(
        "{}:{workflow_id}{}:{unit_id}:{attempt}",
        workflow_id.len(),
        unit_id.len()
    )
}

/// Migrate a snapshot created before the multi-unit projection was added. The
/// singular field remains a compatibility view; the keyed map is authoritative
/// whenever trust-spine events are replayed.
fn ensure_workflow_instances(state: &mut ReplayState) {
    if state.workflow_instances.is_empty() {
        if let Some(workflow) = state.workflow_instance.clone() {
            let key =
                workflow_instance_key(&workflow.workflow_id, &workflow.unit_id, workflow.attempt);
            state.workflow_instances.insert(key, workflow);
        }
    }
}

fn sync_workflow_compatibility_view(state: &mut ReplayState, key: &str) {
    state.workflow_instance = state.workflow_instances.get(key).cloned();
}

fn workflow_graph_key(run_id: &str, workflow_id: &str, workflow_revision: &str) -> String {
    // Length-prefix untrusted identifiers so caller-controlled delimiters or
    // NULs cannot make two graph identities collide in the durable map.
    format!(
        "{}:{run_id}{}:{workflow_id}{}:{workflow_revision}",
        run_id.len(),
        workflow_id.len(),
        workflow_revision.len(),
    )
}

fn workflow_graph_matches(
    existing: &WorkflowGraphReplayState,
    declaration: &WorkflowGraphDeclaredV1,
) -> bool {
    existing.run_id == declaration.run_id
        && existing.workflow_id == declaration.workflow_id
        && existing.workflow_revision == declaration.workflow_revision
        && existing.nodes == declaration.nodes
        && existing.max_concurrent == declaration.max_concurrent
        && existing.graph_digest == declaration.graph_digest
        && existing.idempotency_key == declaration.idempotency_key
        && existing.declared_at == declaration.declared_at
}

fn workflow_graph_v2_matches(
    existing: &WorkflowGraphV2ReplayState,
    declaration: &WorkflowGraphDeclaredV2,
) -> bool {
    existing.run_id == declaration.run_id
        && existing.workflow_id == declaration.workflow_id
        && existing.workflow_revision == declaration.workflow_revision
        && existing.nodes == declaration.nodes
        && existing.max_concurrent == declaration.max_concurrent
        && existing.graph_digest == declaration.graph_digest
        && existing.idempotency_key == declaration.idempotency_key
        && existing.declared_at == declaration.declared_at
}

fn workflow_graph_has_dispatched(
    state: &ReplayState,
    run_id: &str,
    workflow_id: &str,
    workflow_revision: &str,
) -> bool {
    state.workflow_instances.values().any(|workflow| {
        workflow.run_id == run_id
            && workflow.workflow_id == workflow_id
            && workflow.workflow_revision == workflow_revision
    }) || state.workflow_instance.as_ref().is_some_and(|workflow| {
        workflow.run_id == run_id
            && workflow.workflow_id == workflow_id
            && workflow.workflow_revision == workflow_revision
    })
}

/// V2 graph declarations gate only V4 dispatches. A V3 record is deliberately
/// not retrofitted with a graph requirement, so it cannot make a later V2
/// declaration invalid merely by sharing the same workflow identity.
fn workflow_graph_v2_has_dispatched(
    state: &ReplayState,
    run_id: &str,
    workflow_id: &str,
    workflow_revision: &str,
) -> bool {
    state.workflow_instances.values().any(|workflow| {
        workflow.dispatch.dispatch_version == 4
            && workflow.run_id == run_id
            && workflow.workflow_id == workflow_id
            && workflow.workflow_revision == workflow_revision
    }) || state.workflow_instance.as_ref().is_some_and(|workflow| {
        workflow.dispatch.dispatch_version == 4
            && workflow.run_id == run_id
            && workflow.workflow_id == workflow_id
            && workflow.workflow_revision == workflow_revision
    })
}

/// The durable workflow-instance projection predates graph revisions: its
/// identity and the identities in downstream evidence records are
/// `(workflow_id, unit_id, attempt)`. Until every evidence schema carries a
/// revision, accepting two V2 graphs for the same run/workflow under different
/// revisions would advertise a combination that cannot be represented without
/// a collision. Reject it at declaration time rather than silently letting a
/// later V4 dispatch bind the wrong revision.
fn workflow_graph_v2_has_other_revision(
    state: &ReplayState,
    run_id: &str,
    workflow_id: &str,
    workflow_revision: &str,
) -> bool {
    state.workflow_graphs_v2.values().any(|graph| {
        graph.run_id == run_id
            && graph.workflow_id == workflow_id
            && graph.workflow_revision != workflow_revision
    })
}

/// Existing evidence keys do not include a workflow revision. Keep the V4
/// admission rule explicit for mixed historical V3/V4 tapes too, so a graph
/// declaration is never followed by an ambiguous generic key-collision error.
fn workflow_instance_has_cross_revision_identity(
    state: &ReplayState,
    event: &Event,
    workflow_id: &str,
    workflow_revision: &str,
    unit_id: &str,
    attempt: u32,
) -> bool {
    state.workflow_instances.values().any(|workflow| {
        event_matches_workflow_run(workflow, event)
            && workflow.workflow_id == workflow_id
            && workflow.unit_id == unit_id
            && workflow.attempt == attempt
            && workflow.workflow_revision != workflow_revision
    })
}

/// Project one immutable workflow topology declaration. This is deliberately
/// declaration-only: current dispatch envelopes do not carry `graph_digest`,
/// so this reducer must not infer dispatch gating that the signed envelope did
/// not authorize.
fn apply_workflow_graph_declared_v1(
    state: &mut ReplayState,
    event: &Event,
    declaration: &WorkflowGraphDeclaredV1,
) {
    if let Err(error) = canonicalize(event.clone()) {
        reject_workflow_transition(
            state,
            event,
            format!("workflow graph declaration failed canonical validation: {error}"),
        );
        return;
    }
    if declaration.run_id != event.run_id.to_string() {
        reject_workflow_transition(
            state,
            event,
            "workflow graph declaration run_id does not match its event run_id".into(),
        );
        return;
    }
    if workflow_graph_has_dispatched(
        state,
        &declaration.run_id,
        &declaration.workflow_id,
        &declaration.workflow_revision,
    ) {
        reject_workflow_transition(
            state,
            event,
            "workflow graph declaration arrived after dispatch for that workflow revision".into(),
        );
        return;
    }

    let key = workflow_graph_key(
        &declaration.run_id,
        &declaration.workflow_id,
        &declaration.workflow_revision,
    );
    if let Some(existing) = state.workflow_graphs.get(&key) {
        if existing.event_id == event.id && workflow_graph_matches(existing, declaration) {
            // Replay can revisit the exact signed event without replacing the
            // original projection or making delivery metadata mutable.
            return;
        }
        let reason = if existing.event_id == event.id {
            "workflow graph declaration event id conflicts with its existing projection"
        } else {
            "workflow graph declaration conflicts with an existing immutable declaration"
        };
        reject_workflow_transition(state, event, reason.into());
        return;
    }

    state.workflow_graphs.insert(
        key,
        WorkflowGraphReplayState {
            event_id: event.id,
            run_id: declaration.run_id.clone(),
            workflow_id: declaration.workflow_id.clone(),
            workflow_revision: declaration.workflow_revision.clone(),
            nodes: declaration.nodes.clone(),
            max_concurrent: declaration.max_concurrent,
            graph_digest: declaration.graph_digest.clone(),
            idempotency_key: declaration.idempotency_key.clone(),
            declared_at: declaration.declared_at.clone(),
        },
    );
}

/// Project a graph-bound V2 topology. Unlike V1, a later V4 dispatch can only
/// consume the exact event/digest in this separate map; V1 topology is never
/// consulted for graph-bound authority.
fn apply_workflow_graph_declared_v2(
    state: &mut ReplayState,
    event: &Event,
    declaration: &WorkflowGraphDeclaredV2,
) {
    if let Err(error) = canonicalize(event.clone()) {
        reject_workflow_transition(
            state,
            event,
            format!("workflow graph declaration v2 failed canonical validation: {error}"),
        );
        return;
    }
    if declaration.run_id != event.run_id.to_string() {
        reject_workflow_transition(
            state,
            event,
            "workflow graph declaration v2 run_id does not match its event run_id".into(),
        );
        return;
    }
    if workflow_graph_v2_has_other_revision(
        state,
        &declaration.run_id,
        &declaration.workflow_id,
        &declaration.workflow_revision,
    ) {
        reject_workflow_transition(
            state,
            event,
            "workflow graph declaration v2 cannot reuse a run/workflow identity across revisions until workflow evidence keys include the revision"
                .into(),
        );
        return;
    }
    if workflow_graph_v2_has_dispatched(
        state,
        &declaration.run_id,
        &declaration.workflow_id,
        &declaration.workflow_revision,
    ) {
        reject_workflow_transition(
            state,
            event,
            "workflow graph declaration v2 arrived after V4 dispatch for that workflow revision"
                .into(),
        );
        return;
    }

    let key = workflow_graph_key(
        &declaration.run_id,
        &declaration.workflow_id,
        &declaration.workflow_revision,
    );
    if let Some(existing) = state.workflow_graphs_v2.get(&key) {
        if existing.event_id == event.id && workflow_graph_v2_matches(existing, declaration) {
            return;
        }
        let reason = if existing.event_id == event.id {
            "workflow graph declaration v2 event id conflicts with its existing projection"
        } else {
            "workflow graph declaration v2 conflicts with an existing immutable declaration"
        };
        reject_workflow_transition(state, event, reason.into());
        return;
    }

    state.workflow_graphs_v2.insert(
        key,
        WorkflowGraphV2ReplayState {
            event_id: event.id,
            run_id: declaration.run_id.clone(),
            workflow_id: declaration.workflow_id.clone(),
            workflow_revision: declaration.workflow_revision.clone(),
            nodes: declaration.nodes.clone(),
            max_concurrent: declaration.max_concurrent,
            graph_digest: declaration.graph_digest.clone(),
            idempotency_key: declaration.idempotency_key.clone(),
            declared_at: declaration.declared_at.clone(),
        },
    );
}

fn find_workflow_key_for_candidate(
    state: &ReplayState,
    event: &Event,
    candidate_digest: &str,
    candidate_commit_sha: Option<&str>,
) -> Result<String, String> {
    let matches = state
        .workflow_instances
        .iter()
        .filter(|(_, workflow)| {
            event_matches_workflow_run(workflow, event)
                && workflow.candidate.as_ref().is_some_and(|candidate| {
                    candidate.candidate_digest == candidate_digest
                        && candidate_commit_sha
                            .map(|commit| candidate.candidate_commit_sha == commit)
                            .unwrap_or(true)
                })
        })
        .map(|(key, _)| key.clone())
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [key] => Ok(key.clone()),
        [] => Err("candidate evidence has no matching immutable candidate/workflow".into()),
        _ => Err("candidate evidence is ambiguous across workflow unit attempts".into()),
    }
}

fn find_workflow_key_for_terminal(
    state: &ReplayState,
    event: &Event,
    terminal: &WorkflowTerminalFields,
) -> Result<String, String> {
    let key = workflow_instance_key(&terminal.workflow_id, &terminal.unit_id, terminal.attempt);
    let Some(workflow) = state.workflow_instances.get(&key) else {
        return Err("terminal workflow record has no matching workflow unit attempt".into());
    };
    if !event_matches_workflow_run(workflow, event)
        || workflow.workflow_revision != terminal.workflow_revision
        || !match terminal.candidate_digest.as_deref() {
            Some(candidate_digest) => workflow
                .candidate
                .as_ref()
                .is_some_and(|candidate| candidate.candidate_digest == candidate_digest),
            None => workflow.candidate.is_none(),
        }
    {
        return Err(
            "terminal workflow record does not bind the matching workflow unit attempt".into(),
        );
    }
    Ok(key)
}

fn find_workflow_key_for_lifecycle(
    state: &ReplayState,
    event: &Event,
    run_id: &str,
    workflow_id: &str,
    workflow_revision: &str,
    unit_id: &str,
    attempt: u32,
    dispatch_event_ref: EventId,
    dispatch_envelope_digest: &str,
) -> Result<String, String> {
    if run_id != event.run_id.to_string() {
        return Err("workflow lifecycle record run_id does not match its event run_id".into());
    }
    let key = workflow_instance_key(workflow_id, unit_id, attempt);
    let Some(workflow) = state.workflow_instances.get(&key) else {
        return Err("workflow lifecycle record has no prior dispatch envelope".into());
    };
    if !event_matches_workflow_run(workflow, event)
        || workflow.workflow_revision != workflow_revision
        || workflow.dispatch.event_id != dispatch_event_ref
        || workflow.dispatch.envelope_digest != dispatch_envelope_digest
    {
        return Err(
            "workflow lifecycle record does not bind the exact dispatched unit attempt".into(),
        );
    }
    if !workflow_is_governed_atomic_sealed_v3(workflow) {
        return Err(
            "workflow lifecycle records require a governed atomic sealed_v3 dispatch envelope"
                .into(),
        );
    }
    Ok(key)
}

/// Begin the additive trust-spine projection. A dispatch envelope is the only
/// event that can create a workflow instance; later evidence is refused until
/// it can be bound to this immutable admission record.
fn apply_dispatch_envelope(state: &mut ReplayState, event: &Event, p: &DispatchEnvelopeV1) {
    if let Err(reason) = validate_dispatch_envelope(p) {
        reject_workflow_transition(state, event, reason);
        return;
    }
    ensure_workflow_instances(state);
    let key = workflow_instance_key(&p.workflow_id, &p.unit_id, p.attempt);
    if let Some(existing) = state.workflow_instances.get(&key) {
        if !event_matches_workflow_run(existing, event) {
            reject_workflow_transition(
                state,
                event,
                "dispatch envelope reuses a workflow/unit/attempt key from a different run".into(),
            );
            return;
        }
        if dispatch_matches(existing, p) {
            // Delivery can be retried. An identical envelope is idempotent and
            // must not reset a later workflow phase.
            sync_workflow_compatibility_view(state, &key);
            return;
        }
        let reason = format!(
            "dispatch envelope does not match existing workflow/unit/attempt {}/{} unit {} attempt {}",
            existing.workflow_id, existing.workflow_revision, existing.unit_id, existing.attempt
        );
        reject_workflow_transition(state, event, reason);
        return;
    }

    if let Err(reason) = validate_dispatch_run_scope(state, event, p.trust_tier) {
        reject_workflow_transition(state, event, reason);
        return;
    }

    state.workflow_instances.insert(
        key.clone(),
        WorkflowInstanceV1 {
            run_id: event.run_id.to_string(),
            workflow_id: p.workflow_id.clone(),
            workflow_revision: p.workflow_revision.clone(),
            unit_id: p.unit_id.clone(),
            attempt: p.attempt,
            phase: WorkflowPhaseV1::Dispatched,
            dispatch: WorkflowDispatchReplayState {
                dispatch_version: 1,
                event_id: event.id,
                envelope_digest: p.envelope_digest.clone(),
                provenance_ref: p.provenance_ref.clone(),
                base_commit_sha: p.base_commit_sha.clone(),
                repository_binding_digest: None,
                ledger_authority_realm_digest: None,
                governed_packet_digest: None,
                workflow_graph_digest: None,
                workflow_graph_declaration_event_ref: None,
                capability_bundle_digest: p.capability_bundle_digest.clone(),
                acceptance_contract_digest: p.acceptance_contract_digest.clone(),
                context_manifest_digest: p.context_manifest_digest.clone(),
                worker_manifest_digest: p.worker_manifest_digest.clone(),
                sandbox_profile_digest: p.sandbox_profile_digest.clone(),
                execution_role: p.execution_role,
                commit_mode: p.commit_mode,
                budget: p.budget.clone(),
                trust_tier: p.trust_tier,
                idempotency_key: p.idempotency_key.clone(),
                issued_at: p.issued_at.clone(),
                expires_at: p.expires_at.clone(),
                signature_ref: Some(p.signature_ref.clone()),
                action_evidence_version: None,
            },
            action_evidence: None,
            retry_context: None,
            timers: Default::default(),
            cancellation: None,
            candidate: None,
            candidate_completion: None,
            acceptance: None,
            reviews: Default::default(),
            promotion_approval: None,
            promotion: None,
            terminal: None,
        },
    );
    sync_workflow_compatibility_view(state, &key);
}

/// Project the additive V2 dispatch form after its detached body digest has
/// been verified. V2 intentionally shares the existing workflow projection,
/// but cannot be substituted for a V1 dispatch on the same immutable key.
fn apply_dispatch_envelope_v2(state: &mut ReplayState, event: &Event, p: &DispatchEnvelopeV2) {
    if let Err(reason) = validate_dispatch_envelope_v2(p) {
        reject_workflow_transition(state, event, reason);
        return;
    }
    ensure_workflow_instances(state);
    let body = &p.body;
    let key = workflow_instance_key(&body.workflow_id, &body.unit_id, body.attempt);
    if let Some(existing) = state.workflow_instances.get(&key) {
        if !event_matches_workflow_run(existing, event) {
            reject_workflow_transition(
                state,
                event,
                "dispatch envelope v2 reuses a workflow/unit/attempt key from a different run"
                    .into(),
            );
            return;
        }
        if dispatch_v2_matches(existing, p) {
            // Delivery can be retried. An identical envelope is idempotent and
            // must not reset a later workflow phase.
            sync_workflow_compatibility_view(state, &key);
            return;
        }
        let reason = format!(
            "dispatch envelope v2 does not match existing workflow/unit/attempt {}/{} unit {} attempt {}",
            existing.workflow_id, existing.workflow_revision, existing.unit_id, existing.attempt
        );
        reject_workflow_transition(state, event, reason);
        return;
    }

    if let Err(reason) = validate_dispatch_run_scope(state, event, body.trust_tier) {
        reject_workflow_transition(state, event, reason);
        return;
    }
    state.workflow_instances.insert(
        key.clone(),
        WorkflowInstanceV1 {
            run_id: event.run_id.to_string(),
            workflow_id: body.workflow_id.clone(),
            workflow_revision: body.workflow_revision.clone(),
            unit_id: body.unit_id.clone(),
            attempt: body.attempt,
            phase: WorkflowPhaseV1::Dispatched,
            dispatch: WorkflowDispatchReplayState {
                dispatch_version: 2,
                event_id: event.id,
                envelope_digest: p.envelope_digest.clone(),
                provenance_ref: body.provenance_ref.clone(),
                base_commit_sha: body.base_commit_sha.clone(),
                repository_binding_digest: None,
                ledger_authority_realm_digest: None,
                governed_packet_digest: None,
                workflow_graph_digest: None,
                workflow_graph_declaration_event_ref: None,
                capability_bundle_digest: body.capability_bundle_digest.clone(),
                acceptance_contract_digest: body.acceptance_contract_digest.clone(),
                context_manifest_digest: body.context_manifest_digest.clone(),
                worker_manifest_digest: body.worker_manifest_digest.clone(),
                sandbox_profile_digest: body.sandbox_profile_digest.clone(),
                execution_role: body.execution_role,
                commit_mode: body.commit_mode,
                budget: body.budget.clone(),
                trust_tier: body.trust_tier,
                idempotency_key: body.idempotency_key.clone(),
                issued_at: body.issued_at.clone(),
                expires_at: body.expires_at.clone(),
                signature_ref: None,
                action_evidence_version: None,
            },
            action_evidence: None,
            retry_context: None,
            timers: Default::default(),
            cancellation: None,
            candidate: None,
            candidate_completion: None,
            acceptance: None,
            reviews: Default::default(),
            promotion_approval: None,
            promotion: None,
            terminal: None,
        },
    );
    sync_workflow_compatibility_view(state, &key);
}

/// Record the kernel's immutable retry decision before the replacement V3
/// dispatch can enter the workflow projection. The context does not mutate the
/// failed attempt; it names the exact future envelope that may follow it.
fn apply_attempt_context_recorded_v1(
    state: &mut ReplayState,
    event: &Event,
    p: &AttemptContextRecordedV1,
) {
    if let Err(reason) = validate_v3_event_payload(event) {
        reject_workflow_transition(state, event, reason);
        return;
    }
    if p.run_id != event.run_id.to_string() {
        reject_workflow_transition(
            state,
            event,
            "attempt context run_id does not match its event run_id".into(),
        );
        return;
    }
    ensure_workflow_instances(state);
    if let Some(existing) = state.attempt_contexts.get(&p.next_dispatch_envelope_digest) {
        if existing.event_id == event.id && existing.context == *p {
            return;
        }
        let reason = if existing.event_id == event.id {
            "attempt context event id conflicts with an already projected context"
        } else {
            "physical duplicate attempt context cannot create new retry authority"
        };
        reject_workflow_transition(state, event, reason.into());
        return;
    }
    if state.attempt_contexts.values().any(|existing| {
        let existing = &existing.context;
        existing.run_id == p.run_id
            && (existing.idempotency_key == p.idempotency_key
                || existing.next_dispatch_idempotency_key == p.next_dispatch_idempotency_key
                || existing.retry_action_namespace == p.retry_action_namespace)
    }) {
        reject_workflow_transition(
            state,
            event,
            "attempt context reuses an existing retry idempotency or action namespace".into(),
        );
        return;
    }
    if state.attempt_contexts.values().any(|existing| {
        let existing = &existing.context;
        existing.run_id == p.run_id
            && existing.workflow_id == p.workflow_id
            && existing.unit_id == p.unit_id
            && existing.prior_attempt == p.prior_attempt
    }) {
        reject_workflow_transition(
            state,
            event,
            "attempt context prior attempt is already bound to a retry decision".into(),
        );
        return;
    }

    let prior_key = workflow_instance_key(&p.workflow_id, &p.unit_id, p.prior_attempt);
    let Some(prior) = state.workflow_instances.get(&prior_key) else {
        reject_workflow_transition(
            state,
            event,
            "attempt context has no projected prior workflow attempt".into(),
        );
        return;
    };
    if !event_matches_workflow_run(prior, event)
        || prior.workflow_id != p.workflow_id
        || prior.workflow_revision != p.workflow_revision
        || prior.unit_id != p.unit_id
        || prior.attempt != p.prior_attempt
    {
        reject_workflow_transition(
            state,
            event,
            "attempt context does not bind the same run/workflow/unit prior attempt".into(),
        );
        return;
    }
    if !matches!(prior.dispatch.dispatch_version, 3 | 4)
        || prior.dispatch.action_evidence_version != Some(ActionEvidenceVersionV1::SealedV3)
        || prior.dispatch.trust_tier != TrustTierV1::Governed
    {
        reject_workflow_transition(
            state,
            event,
            "attempt context requires a governed sealed_v3 prior dispatch".into(),
        );
        return;
    }
    if prior.dispatch.envelope_digest != p.prior_dispatch_envelope_digest {
        reject_workflow_transition(
            state,
            event,
            "attempt context prior dispatch envelope digest does not match the projected prior attempt"
                .into(),
        );
        return;
    }
    let Some(terminal) = prior.terminal.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "attempt context requires terminal failed prior-attempt evidence".into(),
        );
        return;
    };
    if prior.phase != WorkflowPhaseV1::Failed
        || terminal.outcome != WorkflowTerminalOutcomeV1::Failed
        || terminal.event_id.to_string() != p.prior_terminal_event_ref
        || terminal.event_digest.is_empty()
        || terminal.event_digest != p.prior_terminal_event_digest
    {
        reject_workflow_transition(
            state,
            event,
            "attempt context terminal prior evidence is stale or does not match the failed attempt"
                .into(),
        );
        return;
    }
    let (Some(terminal_at), Some(context_at)) = (
        parse_rfc3339_utc(&terminal.completed_at),
        parse_rfc3339_utc(&p.recorded_at),
    ) else {
        reject_workflow_transition(
            state,
            event,
            "attempt context terminal or recorded timestamp is not RFC3339 UTC".into(),
        );
        return;
    };
    if context_at < terminal_at {
        reject_workflow_transition(
            state,
            event,
            "attempt context cannot predate the terminal prior-attempt evidence".into(),
        );
        return;
    }
    let Some(evidence) = prior.action_evidence.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "attempt context prior attempt is missing sealed action evidence".into(),
        );
        return;
    };
    let matching_actions = evidence
        .actions
        .values()
        .filter(|action| {
            action.receipt.as_ref().is_some_and(|receipt| {
                receipt.action_receipt_ref == p.prior_action_receipt_ref
                    && receipt.action_receipt_digest == p.prior_action_receipt_digest
            })
        })
        .collect::<Vec<_>>();
    let [action] = matching_actions.as_slice() else {
        reject_workflow_transition(
            state,
            event,
            "attempt context prior action receipt evidence is missing or ambiguous".into(),
        );
        return;
    };
    let receipt = action
        .receipt
        .as_ref()
        .expect("matched retry receipt is present");
    let activity_failed = action
        .activity_claim
        .as_ref()
        .and_then(|claim| claim.result.as_ref())
        .is_some_and(|result| result.outcome == ActivityResultOutcomeV1::Failed);
    if receipt.outcome != ActionReceiptOutcomeV2::Failed || !activity_failed {
        reject_workflow_transition(
            state,
            event,
            "attempt context prior action receipt must bind a terminal failed activity result"
                .into(),
        );
        return;
    }
    let reuses_prior_namespace = p.next_dispatch_idempotency_key == prior.dispatch.idempotency_key
        || p.retry_action_namespace == prior.dispatch.idempotency_key
        || evidence.actions.values().any(|action| {
            p.next_dispatch_idempotency_key == action.request.idempotency_key
                || p.retry_action_namespace == action.request.idempotency_key
        });
    if reuses_prior_namespace {
        reject_workflow_transition(
            state,
            event,
            "attempt context cannot reuse the prior dispatch or action idempotency namespace"
                .into(),
        );
        return;
    }
    if state.workflow_instances.values().any(|workflow| {
        workflow.run_id == p.run_id
            && (workflow.dispatch.idempotency_key == p.next_dispatch_idempotency_key
                || workflow.dispatch.idempotency_key == p.retry_action_namespace)
    }) {
        reject_workflow_transition(
            state,
            event,
            "attempt context next dispatch idempotency or retry namespace is already projected"
                .into(),
        );
        return;
    }

    state.attempt_contexts.insert(
        p.next_dispatch_envelope_digest.clone(),
        AttemptContextReplayState {
            event_id: event.id,
            context: p.clone(),
        },
    );
}

/// Resolve the context by the immutable next envelope digest immediately before
/// projecting a governed sealed_v3 retry. A context for the same attempt but a
/// different envelope is intentionally not a fallback authorization.
fn validate_retry_dispatch_context(
    state: &ReplayState,
    event: &Event,
    dispatch: &DispatchEnvelopeV3,
) -> Result<AttemptContextReplayState, String> {
    let body = &dispatch.body;
    let Some(context) = state.attempt_contexts.get(&dispatch.envelope_digest) else {
        let has_same_retry_identity = state.attempt_contexts.values().any(|existing| {
            let existing = &existing.context;
            existing.run_id == event.run_id.to_string()
                && existing.workflow_id == body.workflow_id
                && existing.workflow_revision == body.workflow_revision
                && existing.unit_id == body.unit_id
                && existing.next_attempt == body.attempt
        });
        return Err(if has_same_retry_identity {
            "recorded prior-attempt context does not bind the exact next dispatch envelope digest"
                .into()
        } else {
            "governed sealed_v3 retry dispatch requires a recorded prior-attempt context".into()
        });
    };
    let attempt_context = &context.context;
    if attempt_context.run_id != event.run_id.to_string()
        || attempt_context.workflow_id != body.workflow_id
        || attempt_context.workflow_revision != body.workflow_revision
        || attempt_context.unit_id != body.unit_id
        || attempt_context.next_attempt != body.attempt
        || attempt_context.next_dispatch_envelope_digest != dispatch.envelope_digest
        || attempt_context.next_dispatch_idempotency_key != body.idempotency_key
    {
        return Err(
            "recorded prior-attempt context does not bind the exact next dispatch envelope digest or idempotency key"
                .into(),
        );
    }
    Ok(context.clone())
}

/// V4 retry lineage binds the *outer* graph-bound envelope digest. The nested
/// V3 digest is part of V4's immutable authority bytes, but it is not an
/// interchangeable retry identity once the graph declaration is bound.
fn validate_retry_dispatch_context_v4(
    state: &ReplayState,
    event: &Event,
    dispatch: &DispatchEnvelopeV4,
) -> Result<AttemptContextReplayState, String> {
    let body = &dispatch.dispatch_v3.body;
    let Some(context) = state.attempt_contexts.get(&dispatch.envelope_digest) else {
        let has_same_retry_identity = state.attempt_contexts.values().any(|existing| {
            let existing = &existing.context;
            existing.run_id == event.run_id.to_string()
                && existing.workflow_id == body.workflow_id
                && existing.workflow_revision == body.workflow_revision
                && existing.unit_id == body.unit_id
                && existing.next_attempt == body.attempt
        });
        return Err(if has_same_retry_identity {
            "recorded prior-attempt context does not bind the exact next graph-bound V4 dispatch envelope digest"
                .into()
        } else {
            "governed graph-bound V4 retry dispatch requires a recorded prior-attempt context"
                .into()
        });
    };
    let attempt_context = &context.context;
    if attempt_context.run_id != event.run_id.to_string()
        || attempt_context.workflow_id != body.workflow_id
        || attempt_context.workflow_revision != body.workflow_revision
        || attempt_context.unit_id != body.unit_id
        || attempt_context.next_attempt != body.attempt
        || attempt_context.next_dispatch_envelope_digest != dispatch.envelope_digest
        || attempt_context.next_dispatch_idempotency_key != body.idempotency_key
    {
        return Err(
            "recorded prior-attempt context does not bind the exact next graph-bound V4 dispatch envelope digest or idempotency key"
                .into(),
        );
    }
    Ok(context.clone())
}

/// Resolve the exact prior V2 topology for a graph-bound dispatch. The graph
/// map is keyed by run/workflow/revision, but the signed event reference is
/// independently checked so a same-content declaration cannot be rebound.
fn validate_v4_graph_binding(
    state: &ReplayState,
    event: &Event,
    dispatch: &DispatchEnvelopeV4,
) -> Result<(), String> {
    let body = &dispatch.dispatch_v3.body;
    let run_id = event.run_id.to_string();
    let key = workflow_graph_key(&run_id, &body.workflow_id, &body.workflow_revision);
    let Some(graph) = state.workflow_graphs_v2.get(&key) else {
        return Err(
            "graph-bound V4 dispatch requires a previously declared V2 workflow graph for the same run/workflow/revision"
                .into(),
        );
    };
    if graph.event_id != dispatch.workflow_graph_declaration_event_ref {
        return Err(
            "graph-bound V4 dispatch workflow_graph_declaration_event_ref does not name the immutable V2 graph declaration"
                .into(),
        );
    }
    if graph.graph_digest != dispatch.workflow_graph_digest {
        return Err(
            "graph-bound V4 dispatch workflow_graph_digest does not match the immutable V2 graph declaration"
                .into(),
        );
    }
    if graph.run_id != run_id
        || graph.workflow_id != body.workflow_id
        || graph.workflow_revision != body.workflow_revision
    {
        return Err(
            "graph-bound V4 dispatch graph declaration identity does not match its run/workflow/revision"
                .into(),
        );
    }
    let matching_nodes = graph
        .nodes
        .iter()
        .filter(|node| node.unit_id == body.unit_id)
        .collect::<Vec<_>>();
    let [node] = matching_nodes.as_slice() else {
        return Err(if matching_nodes.is_empty() {
            "graph-bound V4 dispatch unit_id is missing from its immutable V2 workflow graph".into()
        } else {
            "graph-bound V4 dispatch unit_id is ambiguous in its immutable V2 workflow graph".into()
        });
    };
    if node.execution_role != body.execution_role {
        return Err(
            "graph-bound V4 dispatch execution role does not match its immutable V2 workflow graph node"
                .into(),
        );
    }
    if dispatch.dispatch_v3.governed_packet_digest.as_deref()
        != Some(node.governed_packet_digest.as_str())
    {
        return Err(
            "graph-bound V4 dispatch governed packet digest does not match its immutable V2 workflow graph node"
                .into(),
        );
    }
    Ok(())
}

/// Graph-bound dispatches are scheduled only from their immutable V2
/// declaration. Membership validation above proves that the current envelope
/// names a node; this second gate proves that its dependencies have completed
/// successfully and that admitting it would not exceed the graph's declared
/// concurrency. The reducer deliberately uses the terminal `Completed` phase
/// as the only dependency-success signal: candidate creation, acceptance, and
/// review are all intermediate evidence and must not make a dependent effect
/// eligible on their own.
fn validate_v4_graph_schedule(
    state: &ReplayState,
    event: &Event,
    dispatch: &DispatchEnvelopeV4,
) -> Result<(), String> {
    let body = &dispatch.dispatch_v3.body;
    let run_id = event.run_id.to_string();
    let key = workflow_graph_key(&run_id, &body.workflow_id, &body.workflow_revision);
    let graph = state.workflow_graphs_v2.get(&key).ok_or_else(|| {
        "graph-bound V4 dispatch schedule has no immutable V2 workflow graph".to_string()
    })?;
    let node = graph
        .nodes
        .iter()
        .find(|node| node.unit_id == body.unit_id)
        .ok_or_else(|| {
            "graph-bound V4 dispatch schedule has no matching immutable graph node".to_string()
        })?;

    let is_same_graph_workflow = |workflow: &WorkflowInstanceV1| {
        event_matches_workflow_run(workflow, event)
            && workflow.dispatch.dispatch_version == 4
            && workflow.workflow_id == body.workflow_id
            && workflow.workflow_revision == body.workflow_revision
            && workflow.dispatch.workflow_graph_digest.as_deref()
                == Some(graph.graph_digest.as_str())
            && workflow.dispatch.workflow_graph_declaration_event_ref == Some(graph.event_id)
    };

    for dependency_unit_id in &node.depends_on {
        let dependency = state
            .workflow_instances
            .values()
            .filter(|workflow| {
                is_same_graph_workflow(workflow) && workflow.unit_id == *dependency_unit_id
            })
            .max_by_key(|workflow| workflow.attempt);
        let Some(dependency) = dependency else {
            return Err(format!(
                "graph-bound V4 dispatch dependency {dependency_unit_id} has not completed successfully"
            ));
        };
        if dependency.phase != WorkflowPhaseV1::Completed {
            return Err(format!(
                "graph-bound V4 dispatch dependency {dependency_unit_id} has not completed successfully"
            ));
        }
    }

    let active = state
        .workflow_instances
        .values()
        .filter(|workflow| is_same_graph_workflow(workflow) && !workflow.phase.is_terminal())
        .count();
    if active >= graph.max_concurrent as usize {
        return Err(format!(
            "graph-bound V4 dispatch would exceed immutable graph max_concurrent {}",
            graph.max_concurrent
        ));
    }
    Ok(())
}

/// Project a V3 dispatch. Unlike V1/V2, V3 allocates an empty action-evidence
/// projection at admission. No candidate can be created until that projection
/// is sealed from immutable request/receipt records.
fn apply_dispatch_envelope_v3(state: &mut ReplayState, event: &Event, p: &DispatchEnvelopeV3) {
    if let Err(reason) = validate_v3_event_payload(event) {
        reject_workflow_transition(state, event, reason);
        return;
    }
    if let Err(reason) = validate_dispatch_envelope_v3(p) {
        reject_workflow_transition(state, event, reason);
        return;
    }
    ensure_workflow_instances(state);
    let body = &p.body;
    let key = workflow_instance_key(&body.workflow_id, &body.unit_id, body.attempt);
    if let Some(existing) = state.workflow_instances.get(&key) {
        if !event_matches_workflow_run(existing, event) {
            reject_workflow_transition(
                state,
                event,
                "dispatch envelope v3 reuses a workflow/unit/attempt key from a different run"
                    .into(),
            );
            return;
        }
        if dispatch_v3_matches(existing, p) {
            sync_workflow_compatibility_view(state, &key);
            return;
        }
        let reason = format!(
            "dispatch envelope v3 does not match existing workflow/unit/attempt {}/{} unit {} attempt {}",
            existing.workflow_id, existing.workflow_revision, existing.unit_id, existing.attempt
        );
        reject_workflow_transition(state, event, reason);
        return;
    }

    if let Err(reason) = validate_dispatch_run_scope(state, event, body.trust_tier) {
        reject_workflow_transition(state, event, reason);
        return;
    }
    let retry_context = if body.attempt > 1
        && body.trust_tier == TrustTierV1::Governed
        && p.action_evidence_version == ActionEvidenceVersionV1::SealedV3
    {
        match validate_retry_dispatch_context(state, event, p) {
            Ok(context) => Some(context),
            Err(reason) => {
                reject_workflow_transition(state, event, reason);
                return;
            }
        }
    } else {
        None
    };

    state.workflow_instances.insert(
        key.clone(),
        WorkflowInstanceV1 {
            run_id: event.run_id.to_string(),
            workflow_id: body.workflow_id.clone(),
            workflow_revision: body.workflow_revision.clone(),
            unit_id: body.unit_id.clone(),
            attempt: body.attempt,
            phase: WorkflowPhaseV1::Dispatched,
            dispatch: WorkflowDispatchReplayState {
                dispatch_version: 3,
                event_id: event.id,
                envelope_digest: p.envelope_digest.clone(),
                provenance_ref: body.provenance_ref.clone(),
                base_commit_sha: body.base_commit_sha.clone(),
                repository_binding_digest: Some(p.repository_binding_digest.clone()),
                ledger_authority_realm_digest: Some(p.ledger_authority_realm_digest.clone()),
                governed_packet_digest: p.governed_packet_digest.clone(),
                workflow_graph_digest: None,
                workflow_graph_declaration_event_ref: None,
                capability_bundle_digest: body.capability_bundle_digest.clone(),
                acceptance_contract_digest: body.acceptance_contract_digest.clone(),
                context_manifest_digest: body.context_manifest_digest.clone(),
                worker_manifest_digest: body.worker_manifest_digest.clone(),
                sandbox_profile_digest: body.sandbox_profile_digest.clone(),
                execution_role: body.execution_role,
                commit_mode: body.commit_mode,
                budget: body.budget.clone(),
                trust_tier: body.trust_tier,
                idempotency_key: body.idempotency_key.clone(),
                issued_at: body.issued_at.clone(),
                expires_at: body.expires_at.clone(),
                signature_ref: None,
                action_evidence_version: Some(p.action_evidence_version),
            },
            action_evidence: Some(ActionEvidenceReplayState {
                action_evidence_version: p.action_evidence_version,
                actions: Default::default(),
                sealed_receipt_set: None,
                pending_action_ids: vec![],
                unknown_action_ids: vec![],
                failed_action_ids: vec![],
            }),
            retry_context,
            timers: Default::default(),
            cancellation: None,
            candidate: None,
            candidate_completion: None,
            acceptance: None,
            reviews: Default::default(),
            promotion_approval: None,
            promotion: None,
            terminal: None,
        },
    );
    sync_workflow_compatibility_view(state, &key);
}

/// Project a graph-bound V4 dispatch only after it proves an exact, earlier
/// V2 graph declaration and node binding. The reducer never infers topology
/// from a V3 envelope, preserving all historical V3 replay behavior.
fn apply_dispatch_envelope_v4(state: &mut ReplayState, event: &Event, p: &DispatchEnvelopeV4) {
    if let Err(reason) = validate_v4_event_payload(event) {
        reject_workflow_transition(state, event, reason);
        return;
    }
    if let Err(reason) = validate_dispatch_envelope_v4(p) {
        reject_workflow_transition(state, event, reason);
        return;
    }
    if let Err(reason) = validate_v4_graph_binding(state, event, p) {
        reject_workflow_transition(state, event, reason);
        return;
    }

    ensure_workflow_instances(state);
    let nested = &p.dispatch_v3;
    let body = &nested.body;
    if workflow_instance_has_cross_revision_identity(
        state,
        event,
        &body.workflow_id,
        &body.workflow_revision,
        &body.unit_id,
        body.attempt,
    ) {
        reject_workflow_transition(
            state,
            event,
            "graph-bound V4 dispatch cannot reuse a workflow/unit/attempt identity across revisions until workflow evidence keys include the revision"
                .into(),
        );
        return;
    }
    let key = workflow_instance_key(&body.workflow_id, &body.unit_id, body.attempt);
    if let Some(existing) = state.workflow_instances.get(&key) {
        if !event_matches_workflow_run(existing, event) {
            reject_workflow_transition(
                state,
                event,
                "dispatch envelope v4 reuses a workflow/unit/attempt key from a different run"
                    .into(),
            );
            return;
        }
        if dispatch_v4_matches(existing, p) {
            sync_workflow_compatibility_view(state, &key);
            return;
        }
        let reason = format!(
            "dispatch envelope v4 does not match existing workflow/unit/attempt {}/{} unit {} attempt {}",
            existing.workflow_id, existing.workflow_revision, existing.unit_id, existing.attempt
        );
        reject_workflow_transition(state, event, reason);
        return;
    }
    if let Err(reason) = validate_dispatch_run_scope(state, event, body.trust_tier) {
        reject_workflow_transition(state, event, reason);
        return;
    }
    if let Err(reason) = validate_v4_graph_schedule(state, event, p) {
        reject_workflow_transition(state, event, reason);
        return;
    }
    let retry_context = if body.attempt > 1 {
        match validate_retry_dispatch_context_v4(state, event, p) {
            Ok(context) => Some(context),
            Err(reason) => {
                reject_workflow_transition(state, event, reason);
                return;
            }
        }
    } else {
        None
    };

    state.workflow_instances.insert(
        key.clone(),
        WorkflowInstanceV1 {
            run_id: event.run_id.to_string(),
            workflow_id: body.workflow_id.clone(),
            workflow_revision: body.workflow_revision.clone(),
            unit_id: body.unit_id.clone(),
            attempt: body.attempt,
            phase: WorkflowPhaseV1::Dispatched,
            dispatch: WorkflowDispatchReplayState {
                dispatch_version: 4,
                event_id: event.id,
                envelope_digest: p.envelope_digest.clone(),
                provenance_ref: body.provenance_ref.clone(),
                base_commit_sha: body.base_commit_sha.clone(),
                repository_binding_digest: Some(nested.repository_binding_digest.clone()),
                ledger_authority_realm_digest: Some(nested.ledger_authority_realm_digest.clone()),
                governed_packet_digest: nested.governed_packet_digest.clone(),
                workflow_graph_digest: Some(p.workflow_graph_digest.clone()),
                workflow_graph_declaration_event_ref: Some(p.workflow_graph_declaration_event_ref),
                capability_bundle_digest: body.capability_bundle_digest.clone(),
                acceptance_contract_digest: body.acceptance_contract_digest.clone(),
                context_manifest_digest: body.context_manifest_digest.clone(),
                worker_manifest_digest: body.worker_manifest_digest.clone(),
                sandbox_profile_digest: body.sandbox_profile_digest.clone(),
                execution_role: body.execution_role,
                commit_mode: body.commit_mode,
                budget: body.budget.clone(),
                trust_tier: body.trust_tier,
                idempotency_key: body.idempotency_key.clone(),
                issued_at: body.issued_at.clone(),
                expires_at: body.expires_at.clone(),
                signature_ref: None,
                action_evidence_version: Some(nested.action_evidence_version),
            },
            action_evidence: Some(ActionEvidenceReplayState {
                action_evidence_version: nested.action_evidence_version,
                actions: Default::default(),
                sealed_receipt_set: None,
                pending_action_ids: vec![],
                unknown_action_ids: vec![],
                failed_action_ids: vec![],
            }),
            retry_context,
            timers: Default::default(),
            cancellation: None,
            candidate: None,
            candidate_completion: None,
            acceptance: None,
            reviews: Default::default(),
            promotion_approval: None,
            promotion: None,
            terminal: None,
        },
    );
    sync_workflow_compatibility_view(state, &key);
}

/// Apply the write-ahead record for a V3 gateway effect. The request is bound
/// to one exact governed dispatch and cannot be added after the receipt set is
/// sealed, including as a seemingly harmless retry delivery.
fn apply_action_requested_v2(state: &mut ReplayState, event: &Event, p: &ActionRequestedV2) {
    if let Err(reason) = validate_v3_event_payload(event) {
        reject_workflow_transition(state, event, reason);
        return;
    }
    // A sealed-V3 request is the only action-evidence record that carries the
    // governed packet digest. Require it here, then let later claim/result/
    // receipt records inherit that binding through the immutable request
    // digest. Requiring the field in the shared lookup would incorrectly make
    // receipts impossible: their closed schema intentionally has no governed
    // packet field to duplicate.
    let request_workflow_key = workflow_instance_key(&p.workflow_id, &p.unit_id, p.attempt);
    if state
        .workflow_instances
        .get(&request_workflow_key)
        .is_some_and(|workflow| {
            workflow.dispatch.action_evidence_version == Some(ActionEvidenceVersionV1::SealedV3)
                && p.governed_packet_digest.is_none()
        })
    {
        reject_workflow_transition(
            state,
            event,
            "action evidence lineage does not match the signed V3 dispatch envelope".into(),
        );
        return;
    }
    let key = match find_v3_workflow_key_for_action(
        state,
        event,
        &p.run_id,
        &p.workflow_id,
        &p.unit_id,
        p.attempt,
        &p.provenance_ref,
        &p.dispatch_envelope_digest,
        Some(&p.repository_binding_digest),
        Some(&p.ledger_authority_realm_digest),
        p.governed_packet_digest.as_deref(),
        &p.capability_bundle_digest,
        &p.context_manifest_digest,
        &p.worker_manifest_digest,
        &p.sandbox_profile_digest,
        p.execution_role,
    ) {
        Ok(key) => key,
        Err(reason) => {
            reject_workflow_transition(state, event, reason);
            return;
        }
    };

    let action_request_digest = match action_requested_v2_digest(p) {
        Ok(digest) => digest,
        Err(error) => {
            reject_workflow_transition(
                state,
                event,
                format!("could not canonicalize V2 action request: {error}"),
            );
            return;
        }
    };
    let Some(workflow) = state.workflow_instances.get(&key) else {
        unreachable!("find_v3_workflow_key_for_action returned an existing key")
    };
    // Sealed-V3 action requests are write-ahead authority, not a caller-owned
    // audit annotation. Their payload timestamp must therefore name the same
    // instant as the signed append event; otherwise a later request could be
    // backdated to make a model intent/authorization chain look causal.
    if workflow.dispatch.action_evidence_version == Some(ActionEvidenceVersionV1::SealedV3) {
        let Some(requested_at) = parse_rfc3339_utc(&p.requested_at) else {
            reject_workflow_transition(
                state,
                event,
                "sealed_v3 action request requested_at must be an RFC3339 UTC timestamp".into(),
            );
            return;
        };
        if requested_at != event.occurred_at {
            reject_workflow_transition(
                state,
                event,
                "sealed_v3 action request requested_at must equal its signed event occurred_at"
                    .into(),
            );
            return;
        }
    }
    // A sealed_v3 action is executable evidence rather than merely historical
    // audit data. Its policy binding is therefore derived from the signed
    // dispatch acceptance contract, never selected by the action requester.
    // Keep sealed-v2 readable so old tapes retain their original semantics.
    if workflow.dispatch.action_evidence_version == Some(ActionEvidenceVersionV1::SealedV3) {
        let expected_policy_digest =
            match governed_dispatch_policy_digest_v1(&workflow.dispatch.acceptance_contract_digest)
            {
                Ok(digest) => digest,
                Err(_) => {
                    reject_workflow_transition(
                        state,
                        event,
                        "sealed_v3 dispatch has an invalid acceptance-contract policy binding"
                            .into(),
                    );
                    return;
                }
            };
        if p.policy_digest != expected_policy_digest {
            reject_workflow_transition(
                state,
                event,
                "sealed_v3 action request policy_digest does not match the policy binding derived from the signed acceptance contract".into(),
            );
            return;
        }
    }
    if let Err(reason) = validate_retry_action_namespace(state, workflow, p) {
        reject_workflow_transition(state, event, reason);
        return;
    }
    let Some(evidence) = workflow.action_evidence.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "V3 dispatch is missing its action evidence projection".into(),
        );
        return;
    };
    if evidence.sealed_receipt_set.is_some() {
        reject_workflow_transition(
            state,
            event,
            "no action request may be recorded after the action receipt set is sealed".into(),
        );
        return;
    }
    if workflow.phase != WorkflowPhaseV1::Dispatched {
        reject_workflow_transition(
            state,
            event,
            format!(
                "action request is not allowed from phase {:?}",
                workflow.phase
            ),
        );
        return;
    }
    if let Some(existing) = evidence.actions.get(&p.action_id) {
        if action_request_matches_existing(&existing.request, p, &action_request_digest) {
            return;
        }
        reject_workflow_transition(
            state,
            event,
            "action request does not match the existing immutable action intent".into(),
        );
        return;
    }
    if evidence
        .actions
        .values()
        .any(|existing| existing.request.idempotency_key == p.idempotency_key)
    {
        reject_workflow_transition(
            state,
            event,
            "action request idempotency_key is already bound to a different action_id".into(),
        );
        return;
    }

    let workflow = state
        .workflow_instances
        .get_mut(&key)
        .expect("workflow was checked above");
    let evidence = workflow
        .action_evidence
        .as_mut()
        .expect("V3 workflow has action evidence");
    evidence.actions.insert(
        p.action_id.clone(),
        ActionReplayState {
            request: ActionRequestReplayState {
                event_id: event.id,
                action_id: p.action_id.clone(),
                idempotency_key: p.idempotency_key.clone(),
                action_kind: p.action_kind,
                canonical_input_digest: p.canonical_input_digest.clone(),
                canonical_input_ref: p.canonical_input_ref.clone(),
                repository_binding_digest: p.repository_binding_digest.clone(),
                ledger_authority_realm_digest: p.ledger_authority_realm_digest.clone(),
                governed_packet_digest: p.governed_packet_digest.clone(),
                policy_digest: p.policy_digest.clone(),
                authority_actor: p.authority_actor.clone(),
                execution_role: p.execution_role,
                requested_at: p.requested_at.clone(),
                action_request_digest,
            },
            model_intent: None,
            model_authorization: None,
            activity_claim: None,
            receipt: None,
        },
    );
    refresh_action_evidence_recovery(evidence);
    sync_workflow_compatibility_view(state, &key);
}

/// Project a native activity lease only when it binds an already-recorded,
/// sealed V3 action request and its exact governed dispatch. The activity ID
/// and idempotency key are deliberately required to equal the action's values:
/// a lease for one effect must never authorize a neighbouring effect merely
/// because both share a workflow.
fn apply_activity_claimed_v1(
    state: &mut ReplayState,
    event: &Event,
    p: &ActivityClaimedV1,
    signer: Option<&ActorKeyRef>,
) {
    if let Err(reason) = validate_v3_event_payload(event) {
        reject_activity_transition(state, event, &p.activity_id, reason);
        return;
    }
    if p.run_id != event.run_id {
        reject_activity_transition(
            state,
            event,
            &p.activity_id,
            "activity claim payload run_id does not match its event run_id".into(),
        );
        return;
    }
    if event.parent_event_id != Some(p.action_request_event_id) {
        reject_activity_transition(
            state,
            event,
            &p.activity_id,
            "activity claim parent_event_id must bind the exact action request".into(),
        );
        return;
    }
    let claim_event_digest = match canonical_event_hash(event) {
        Ok(digest) => digest,
        Err(error) => {
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                format!("could not canonicalize activity claim event: {error}"),
            );
            return;
        }
    };
    let (key, action_id) = match find_v3_workflow_key_for_activity_claim(state, event, p) {
        Ok(value) => value,
        Err(reason) => {
            reject_activity_transition(state, event, &p.activity_id, reason);
            return;
        }
    };

    {
        let workflow = state
            .workflow_instances
            .get(&key)
            .expect("activity claim workflow was found");
        if workflow.phase != WorkflowPhaseV1::Dispatched {
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                format!(
                    "activity claim is not allowed from workflow phase {:?}",
                    workflow.phase
                ),
            );
            return;
        }
        let evidence = workflow
            .action_evidence
            .as_ref()
            .expect("matched V3 workflow has action evidence");
        if evidence.sealed_receipt_set.is_some() {
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                "activity claim cannot be recorded after the action receipt set is sealed".into(),
            );
            return;
        }
        let action = evidence
            .actions
            .get(&action_id)
            .expect("matched action request exists");
        if !activity_claim_matches_action(workflow, &action.request, p) {
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                "activity claim does not bind the exact V3 dispatch and write-ahead action request"
                    .into(),
            );
            return;
        }
        if !activity_claim_timestamps_are_valid(
            workflow,
            &action.request,
            event,
            p,
            requires_activity_claim_result(workflow),
        ) {
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                "activity claim lease must begin after its request and end within the signed compute deadline; sealed_v3 claims must bind claimed_at to event occurred_at"
                    .into(),
            );
            return;
        }
        if requires_activity_claim_result(workflow)
            && action.request.action_kind == ActionKindV1::Model
            && !sealed_v3_model_authority_is_live_at(workflow, action, &p.claimed_at)
        {
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                "sealed_v3 model activity claims require a prior ModelActionIntentV1 and ModelActionAuthorizedV2 that is live for the claim".into(),
            );
            return;
        }
        if action.receipt.is_some() {
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                "activity claim must be recorded before its terminal action receipt".into(),
            );
            return;
        }
        if let Some(existing) = action.activity_claim.as_ref() {
            if activity_claim_matches_existing(existing, event, p, &claim_event_digest, signer) {
                return;
            }
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                "activity claim attempts to replace an immutable execution lease".into(),
            );
            return;
        }
    }

    if state
        .workflow_instances
        .iter()
        .any(|(other_key, workflow)| {
            workflow.action_evidence.as_ref().is_some_and(|evidence| {
                evidence.actions.iter().any(|(other_action_id, action)| {
                    (other_key != &key || other_action_id != &action_id)
                        && action.activity_claim.as_ref().is_some_and(|claim| {
                            claim.run_id == p.run_id.to_string()
                                && (claim.activity_id == p.activity_id
                                    || claim.idempotency_key == p.idempotency_key)
                        })
                })
            })
        })
    {
        reject_activity_transition(
            state,
            event,
            &p.activity_id,
            "activity claim activity_id or idempotency_key is already bound to a different action"
                .into(),
        );
        return;
    }

    let workflow = state
        .workflow_instances
        .get_mut(&key)
        .expect("activity claim workflow was checked");
    let evidence = workflow
        .action_evidence
        .as_mut()
        .expect("matched V3 workflow has action evidence");
    let action = evidence
        .actions
        .get_mut(&action_id)
        .expect("matched action request exists");
    action.activity_claim = Some(ActivityClaimReplayState {
        event_id: event.id,
        claim_event_digest,
        run_id: p.run_id.to_string(),
        activity_id: p.activity_id.clone(),
        idempotency_key: p.idempotency_key.clone(),
        action_kind: p.action_kind,
        action_request_event_id: p.action_request_event_id,
        action_request_digest: p.action_request_digest.clone(),
        dispatch_event_id: p.dispatch_event_id,
        dispatch_envelope_digest: p.dispatch_envelope_digest.clone(),
        authority_actor: p.authority_actor.clone(),
        lease_id: p.lease_id.clone(),
        lease_expires_at: p.lease_expires_at.clone(),
        claimed_at: p.claimed_at.clone(),
        signer: signer.cloned(),
        heartbeats: Vec::new(),
        result: None,
    });
    refresh_action_evidence_recovery(evidence);
    sync_workflow_compatibility_view(state, &key);
}

/// Extend a single immutable activity lease without creating a replacement
/// claim. A heartbeat has no authority by itself: it must repeat the original
/// claim/event digest, lease token, dispatch binding, activity identity, and
/// idempotency key; it can only move the current expiry forward before that
/// current expiry passes. Terminal results and receipts permanently close the
/// heartbeat path.
fn apply_activity_heartbeat_recorded_v1(
    state: &mut ReplayState,
    event: &Event,
    p: &ActivityHeartbeatRecordedV1,
    signer: Option<&ActorKeyRef>,
) {
    if let Err(reason) = validate_v3_event_payload(event) {
        reject_activity_transition(state, event, &p.activity_id, reason);
        return;
    }
    if p.run_id != event.run_id {
        reject_activity_transition(
            state,
            event,
            &p.activity_id,
            "activity heartbeat payload run_id does not match its event run_id".into(),
        );
        return;
    }
    if event.parent_event_id != Some(p.claim_event_id) {
        reject_activity_transition(
            state,
            event,
            &p.activity_id,
            "activity heartbeat parent_event_id must bind the exact activity claim".into(),
        );
        return;
    }
    let heartbeat_event_digest = match canonical_event_hash(event) {
        Ok(digest) => digest,
        Err(error) => {
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                format!("could not canonicalize activity heartbeat event: {error}"),
            );
            return;
        }
    };
    let (key, action_id) = match find_v3_workflow_key_for_activity_heartbeat(state, event, p) {
        Ok(value) => value,
        Err(reason) => {
            reject_activity_transition(state, event, &p.activity_id, reason);
            return;
        }
    };

    let prior_lease_expires_at = {
        let workflow = state
            .workflow_instances
            .get(&key)
            .expect("activity heartbeat workflow was found");
        if workflow.phase != WorkflowPhaseV1::Dispatched {
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                format!(
                    "activity heartbeat is not allowed from workflow phase {:?}",
                    workflow.phase
                ),
            );
            return;
        }
        if !requires_activity_claim_result(workflow) {
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                "activity heartbeat requires a governed atomic sealed_v3 dispatch envelope".into(),
            );
            return;
        }
        let evidence = workflow
            .action_evidence
            .as_ref()
            .expect("matched V3 workflow has action evidence");
        if evidence.sealed_receipt_set.is_some() {
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                "activity heartbeat cannot be recorded after the action receipt set is sealed"
                    .into(),
            );
            return;
        }
        let action = evidence
            .actions
            .get(&action_id)
            .expect("matched activity claim action exists");
        let claim = action
            .activity_claim
            .as_ref()
            .expect("heartbeat lookup requires a claim");
        if !activity_heartbeat_matches_claim(claim, p) {
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                "activity heartbeat does not bind the exact immutable execution lease".into(),
            );
            return;
        }
        if let Some(claim_signer) = claim.signer.as_ref() {
            if signer != Some(claim_signer) {
                reject_activity_transition(
                    state,
                    event,
                    &p.activity_id,
                    "activity heartbeat signer does not match the signer that reserved the lease"
                        .into(),
                );
                return;
            }
        }
        if let Some(existing) = claim
            .heartbeats
            .iter()
            .find(|existing| existing.event_id == event.id)
        {
            if activity_heartbeat_matches_existing(existing, event, p, &heartbeat_event_digest) {
                return;
            }
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                "activity heartbeat attempts to replace an immutable lease extension".into(),
            );
            return;
        }
        if claim.result.is_some() {
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                "activity heartbeat cannot be recorded after its terminal activity result".into(),
            );
            return;
        }
        if action.receipt.is_some() {
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                "activity heartbeat cannot be recorded after its terminal action receipt".into(),
            );
            return;
        }
        if !activity_heartbeat_timestamps_are_valid(workflow, claim, event, p) {
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                "activity heartbeat must bind heartbeat_at to event occurred_at, extend before the current lease expires, move expiry forward, and remain within the signed compute deadline"
                    .into(),
            );
            return;
        }
        claim.lease_expires_at.clone()
    };

    let workflow = state
        .workflow_instances
        .get_mut(&key)
        .expect("activity heartbeat workflow was checked");
    let evidence = workflow
        .action_evidence
        .as_mut()
        .expect("matched V3 workflow has action evidence");
    let action = evidence
        .actions
        .get_mut(&action_id)
        .expect("matched activity claim action exists");
    let claim = action
        .activity_claim
        .as_mut()
        .expect("activity heartbeat has a matched claim");
    claim.heartbeats.push(ActivityHeartbeatReplayState {
        event_id: event.id,
        event_digest: heartbeat_event_digest,
        run_id: p.run_id.to_string(),
        activity_id: p.activity_id.clone(),
        idempotency_key: p.idempotency_key.clone(),
        heartbeat_id: p.heartbeat_id.clone(),
        heartbeat_request_digest: p.heartbeat_request_digest.clone(),
        claim_event_id: p.claim_event_id,
        claim_event_digest: p.claim_event_digest.clone(),
        lease_id: p.lease_id.clone(),
        dispatch_event_id: p.dispatch_event_id,
        dispatch_envelope_digest: p.dispatch_envelope_digest.clone(),
        prior_lease_expires_at,
        lease_expires_at: p.lease_expires_at.clone(),
        heartbeat_at: p.heartbeat_at.clone(),
    });
    claim.lease_expires_at = p.lease_expires_at.clone();
    refresh_action_evidence_recovery(evidence);
    sync_workflow_compatibility_view(state, &key);
}

/// Project an activity's one terminal state. A terminal result is bound to the
/// canonical claim-event digest and, in authoritative replay, to the same
/// detached signer that reserved the lease. A success/failure recorded after
/// the lease expires is rejected; only `unknown` can represent uncertainty
/// after expiry without risking a duplicate external effect.
fn apply_activity_result_recorded_v1(
    state: &mut ReplayState,
    event: &Event,
    p: &ActivityResultRecordedV1,
    signer: Option<&ActorKeyRef>,
) {
    if let Err(reason) = validate_v3_event_payload(event) {
        reject_activity_transition(state, event, &p.activity_id, reason);
        return;
    }
    if p.run_id != event.run_id {
        reject_activity_transition(
            state,
            event,
            &p.activity_id,
            "activity result payload run_id does not match its event run_id".into(),
        );
        return;
    }
    if event.parent_event_id != Some(p.claim_event_id) {
        reject_activity_transition(
            state,
            event,
            &p.activity_id,
            "activity result parent_event_id must bind the exact activity claim".into(),
        );
        return;
    }
    let result_event_digest = match canonical_event_hash(event) {
        Ok(digest) => digest,
        Err(error) => {
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                format!("could not canonicalize activity result event: {error}"),
            );
            return;
        }
    };
    let (key, action_id) = match find_v3_workflow_key_for_activity_result(state, event, p) {
        Ok(value) => value,
        Err(reason) => {
            reject_activity_transition(state, event, &p.activity_id, reason);
            return;
        }
    };

    {
        let workflow = state
            .workflow_instances
            .get(&key)
            .expect("activity result workflow was found");
        let evidence = workflow
            .action_evidence
            .as_ref()
            .expect("matched V3 workflow has action evidence");
        let action = evidence
            .actions
            .get(&action_id)
            .expect("matched activity claim action exists");
        let claim = action
            .activity_claim
            .as_ref()
            .expect("result lookup requires a claim");
        if !activity_result_matches_claim(claim, p) {
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                "activity result does not bind the exact immutable execution lease".into(),
            );
            return;
        }
        if let Some(claim_signer) = claim.signer.as_ref() {
            if signer != Some(claim_signer) {
                reject_activity_transition(
                    state,
                    event,
                    &p.activity_id,
                    "activity result signer does not match the signer that reserved the lease"
                        .into(),
                );
                return;
            }
        }
        if !activity_result_timestamp_is_valid(
            claim,
            event,
            p,
            requires_activity_claim_result(workflow),
        ) {
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                "activity result timestamp is outside the claimed lease; only an on-or-after-expiry unknown result is allowed, and sealed_v3 results must bind recorded_at to event occurred_at"
                    .into(),
            );
            return;
        }
        if requires_activity_claim_result(workflow)
            && action.request.action_kind == ActionKindV1::Model
            && !sealed_v3_model_authority_is_live_at(workflow, action, &p.recorded_at)
        {
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                "sealed_v3 model activity results require a still-live ModelActionAuthorizedV2 that predates the result".into(),
            );
            return;
        }
        if let Some(existing) = claim.result.as_ref() {
            if activity_result_matches_existing(existing, event, p) {
                return;
            }
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                "activity result attempts to replace an immutable terminal result".into(),
            );
            return;
        }
        if action.receipt.is_some() {
            reject_activity_transition(
                state,
                event,
                &p.activity_id,
                "activity result must be recorded before its terminal action receipt".into(),
            );
            return;
        }
    }

    let workflow = state
        .workflow_instances
        .get_mut(&key)
        .expect("activity result workflow was checked");
    let evidence = workflow
        .action_evidence
        .as_mut()
        .expect("matched V3 workflow has action evidence");
    let action = evidence
        .actions
        .get_mut(&action_id)
        .expect("matched activity claim action exists");
    let claim = action
        .activity_claim
        .as_mut()
        .expect("activity result has a matched claim");
    claim.result = Some(ActivityResultReplayState {
        event_id: event.id,
        event_digest: result_event_digest,
        run_id: p.run_id.to_string(),
        activity_id: p.activity_id.clone(),
        idempotency_key: p.idempotency_key.clone(),
        claim_event_id: p.claim_event_id,
        claim_event_digest: p.claim_event_digest.clone(),
        lease_id: p.lease_id.clone(),
        outcome: p.outcome,
        result_digest: p.result_digest.clone(),
        result_ref: p.result_ref.clone(),
        evidence_digest: p.evidence_digest.clone(),
        evidence_ref: p.evidence_ref.clone(),
        recorded_at: p.recorded_at.clone(),
    });
    refresh_action_evidence_recovery(evidence);
    sync_workflow_compatibility_view(state, &key);
}

/// Apply the kernel-signed, parented model-action intent. The intent is the
/// only sealed_v3 record allowed to introduce dynamic model/trust/candidate
/// evidence; the authorization that follows can only repeat it exactly.
fn apply_model_action_intent_v1(state: &mut ReplayState, event: &Event, p: &ModelActionIntentV1) {
    if let Err(reason) = validate_v3_event_payload(event) {
        reject_workflow_transition(state, event, reason);
        return;
    }
    let intent_digest = match model_action_intent_v1_digest(p) {
        Ok(digest) => digest,
        Err(error) => {
            reject_workflow_transition(
                state,
                event,
                format!("could not canonicalize model action intent: {error}"),
            );
            return;
        }
    };
    let key = workflow_instance_key(&p.workflow_id, &p.unit_id, p.attempt);
    let Some(workflow) = state.workflow_instances.get(&key) else {
        reject_workflow_transition(
            state,
            event,
            "model action intent has no prior V3 dispatch envelope".into(),
        );
        return;
    };
    if p.run_id != event.run_id.to_string() || !event_matches_workflow_run(workflow, event) {
        reject_workflow_transition(
            state,
            event,
            "model action intent belongs to a different run".into(),
        );
        return;
    }
    if !requires_activity_claim_result(workflow)
        || workflow.dispatch.trust_tier != TrustTierV1::Governed
    {
        reject_workflow_transition(
            state,
            event,
            "ModelActionIntentV1 requires a governed sealed_v3 dispatch envelope".into(),
        );
        return;
    }
    let Some(evidence) = workflow.action_evidence.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "sealed_v3 dispatch is missing its action evidence projection".into(),
        );
        return;
    };
    let Some(action) = evidence.actions.get(&p.action_id) else {
        reject_workflow_transition(
            state,
            event,
            "model action intent has no prior V3 write-ahead request".into(),
        );
        return;
    };
    if action.request.action_kind != ActionKindV1::Model {
        reject_workflow_transition(
            state,
            event,
            "model action intent may bind only a V3 model action request".into(),
        );
        return;
    }
    if event.parent_event_id != Some(action.request.event_id)
        || p.action_request_event_ref != action.request.event_id
    {
        reject_workflow_transition(
            state,
            event,
            "model action intent must parent to and reference its exact ActionRequestedV2 event"
                .into(),
        );
        return;
    }
    if !model_intent_matches_request_and_dispatch(workflow, &action.request, p) {
        reject_workflow_transition(
            state,
            event,
            "model action intent does not bind the exact signed V3 dispatch and write-ahead action request"
                .into(),
        );
        return;
    }
    let Some(intended_at) = parse_rfc3339_utc(&p.intended_at) else {
        reject_workflow_transition(
            state,
            event,
            "model action intent intended_at must be an RFC3339 UTC timestamp".into(),
        );
        return;
    };
    if intended_at != event.occurred_at {
        reject_workflow_transition(
            state,
            event,
            "model action intent intended_at must equal its signed event occurred_at".into(),
        );
        return;
    }
    let Some(requested_at) = parse_rfc3339_utc(&action.request.requested_at) else {
        reject_workflow_transition(
            state,
            event,
            "stored V3 model action requested_at must be an RFC3339 UTC timestamp".into(),
        );
        return;
    };
    if intended_at < requested_at {
        reject_workflow_transition(
            state,
            event,
            "model action intent must not predate its V3 write-ahead request".into(),
        );
        return;
    }
    match action.request.execution_role {
        ExecutionRoleV1::Implementer if p.candidate_binding.is_some() => {
            reject_workflow_transition(
                state,
                event,
                "implementer model action intents must not carry candidate bindings".into(),
            );
            return;
        }
        ExecutionRoleV1::Reviewer | ExecutionRoleV1::Adversary | ExecutionRoleV1::Judge
            if p.candidate_binding.is_none() =>
        {
            reject_workflow_transition(
                state,
                event,
                "review-like model action intents require a complete candidate binding".into(),
            );
            return;
        }
        ExecutionRoleV1::Candidate => {
            reject_workflow_transition(
                state,
                event,
                "candidate execution role cannot receive model action authority".into(),
            );
            return;
        }
        _ => {}
    }
    if let Some(binding) = p.candidate_binding.as_ref() {
        if let Err(reason) = candidate_binding_matches_replay(state, event, workflow, binding) {
            reject_workflow_transition(state, event, reason);
            return;
        }
    }
    if evidence.sealed_receipt_set.is_some()
        || action.receipt.is_some()
        || action
            .activity_claim
            .as_ref()
            .and_then(|claim| claim.result.as_ref())
            .is_some()
    {
        reject_workflow_transition(
            state,
            event,
            "model action intent must be recorded before the action receipt set, terminal receipt, or terminal activity result".into(),
        );
        return;
    }
    if let Some(existing) = action.model_intent.as_ref() {
        if existing.event_id == event.id && existing.intent_digest == intent_digest {
            return;
        }
        reject_workflow_transition(
            state,
            event,
            "model action intent attempts to replace immutable native intent evidence".into(),
        );
        return;
    }

    let workflow = state
        .workflow_instances
        .get_mut(&key)
        .expect("workflow was checked above");
    let action = workflow
        .action_evidence
        .as_mut()
        .expect("sealed_v3 workflow has action evidence")
        .actions
        .get_mut(&p.action_id)
        .expect("action request was checked above");
    action.model_intent = Some(ModelActionIntentReplayState {
        event_id: event.id,
        dispatch_event_ref: p.dispatch_event_ref,
        dispatch_envelope_digest: p.dispatch_envelope_digest.clone(),
        action_request_event_ref: p.action_request_event_ref,
        action_request_digest: p.action_request_digest.clone(),
        canonical_input_ref: p.canonical_input_ref.clone(),
        canonical_input_digest: p.canonical_input_digest.clone(),
        model_request_evidence: p.model_request_evidence.clone(),
        trust_scope_evidence: p.trust_scope_evidence.clone(),
        candidate_binding: p.candidate_binding.clone(),
        intent_actor: p.intent_actor.clone(),
        intended_at: p.intended_at.clone(),
        intent_digest,
    });
    sync_workflow_compatibility_view(state, &key);
}

/// Apply the native authority record for a model action. This record must be
/// present before a succeeded model receipt: a receipt-level string alone is
/// not evidence that a kernel-owned gateway evaluated the exact model request.
fn apply_model_action_authorized_v1(
    state: &mut ReplayState,
    event: &Event,
    p: &ModelActionAuthorizedV1,
) {
    if let Err(reason) = validate_v3_event_payload(event) {
        reject_workflow_transition(state, event, reason);
        return;
    }
    let key = match find_v3_workflow_key_for_model_authorization(state, event, p) {
        Ok(key) => key,
        Err(reason) => {
            reject_workflow_transition(state, event, reason);
            return;
        }
    };
    let authorization_digest = match model_action_authorized_v1_digest(p) {
        Ok(digest) => digest,
        Err(error) => {
            reject_workflow_transition(
                state,
                event,
                format!("could not canonicalize model action authorization: {error}"),
            );
            return;
        }
    };
    let Some(workflow) = state.workflow_instances.get(&key) else {
        unreachable!("model authorization lookup returned an existing V3 workflow")
    };
    if requires_activity_claim_result(workflow) {
        reject_workflow_transition(
            state,
            event,
            "sealed_v3 model actions require ModelActionIntentV1 followed by ModelActionAuthorizedV2; ModelActionAuthorizedV1 remains readable only for legacy tapes"
                .into(),
        );
        return;
    }
    let Some(evidence) = workflow.action_evidence.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "V3 dispatch is missing its action evidence projection".into(),
        );
        return;
    };
    if evidence.sealed_receipt_set.is_some() {
        reject_workflow_transition(
            state,
            event,
            "no model authorization may be recorded after the action receipt set is sealed".into(),
        );
        return;
    }
    if workflow.phase != WorkflowPhaseV1::Dispatched {
        reject_workflow_transition(
            state,
            event,
            format!(
                "model action authorization is not allowed from phase {:?}",
                workflow.phase
            ),
        );
        return;
    }
    let Some(action) = evidence.actions.get(&p.action_id) else {
        reject_workflow_transition(
            state,
            event,
            "model action authorization has no prior V3 write-ahead request".into(),
        );
        return;
    };
    if action.request.action_kind != ActionKindV1::Model {
        reject_workflow_transition(
            state,
            event,
            "model action authorization may bind only a V3 model action request".into(),
        );
        return;
    }
    if action.receipt.is_some() {
        reject_workflow_transition(
            state,
            event,
            "model action authorization must be recorded before the terminal action receipt".into(),
        );
        return;
    }
    if !model_authorization_matches_request_and_dispatch(workflow, &action.request, p) {
        reject_workflow_transition(
            state,
            event,
            "model action authorization does not bind the exact signed V3 dispatch and write-ahead action request".into(),
        );
        return;
    }
    let Some(expires_at) = parse_rfc3339_utc(&p.expires_at) else {
        reject_workflow_transition(
            state,
            event,
            "model action authorization expires_at must be an RFC3339 UTC timestamp".into(),
        );
        return;
    };
    let Some(effective_deadline) = effective_dispatch_effect_deadline(workflow) else {
        reject_workflow_transition(
            state,
            event,
            "signed V3 dispatch has no valid effective compute deadline".into(),
        );
        return;
    };
    let Some(requested_at) = parse_rfc3339_utc(&action.request.requested_at) else {
        reject_workflow_transition(
            state,
            event,
            "stored V3 model action requested_at must be an RFC3339 UTC timestamp".into(),
        );
        return;
    };
    if expires_at <= requested_at {
        reject_workflow_transition(
            state,
            event,
            "model action authorization must outlive its V3 write-ahead request".into(),
        );
        return;
    }
    if expires_at > effective_deadline {
        reject_workflow_transition(
            state,
            event,
            "model action authorization must not outlive its signed compute deadline".into(),
        );
        return;
    }
    if let Some(existing) = action.model_authorization.as_ref() {
        if model_authorization_matches_existing(existing, event, p, &authorization_digest) {
            return;
        }
        reject_workflow_transition(
            state,
            event,
            "model action authorization attempts to replace immutable native authority".into(),
        );
        return;
    }
    if model_authorization_ref_is_bound_elsewhere(state, &key, &p.action_id, &p.authorization_ref) {
        reject_workflow_transition(
            state,
            event,
            "model authorization_ref is already bound to a different V3 action".into(),
        );
        return;
    }

    let workflow = state
        .workflow_instances
        .get_mut(&key)
        .expect("workflow was checked above");
    let evidence = workflow
        .action_evidence
        .as_mut()
        .expect("V3 workflow has action evidence");
    let action = evidence
        .actions
        .get_mut(&p.action_id)
        .expect("action request was checked above");
    action.model_authorization = Some(ModelActionAuthorizationReplayState {
        event_id: event.id,
        authorized_at: Some(
            event
                .occurred_at
                .to_rfc3339_opts(SecondsFormat::AutoSi, true),
        ),
        authorization_version: 1,
        intent_event_ref: None,
        intent_digest: None,
        dispatch_event_ref: p.dispatch_event_ref.clone(),
        dispatch_envelope_digest: p.dispatch_envelope_digest.clone(),
        action_request_ref: p.action_request_ref.clone(),
        action_request_digest: p.action_request_digest.clone(),
        packet_digest: p.packet_digest.clone(),
        canonical_input_digest: p.canonical_input_digest.clone(),
        model_request_digest: p.model_request_digest.clone(),
        model_request_evidence_ref: None,
        model_request_evidence_schema_version: None,
        trust_scope_digest: p.trust_scope_digest.clone(),
        trust_scope_evidence_ref: None,
        trust_scope_evidence_schema_version: None,
        context_manifest_digest: p.context_manifest_digest.clone(),
        policy_digest: p.policy_digest.clone(),
        sandbox_profile_digest: p.sandbox_profile_digest.clone(),
        execution_role: p.execution_role,
        candidate_digest: p.candidate_digest.clone(),
        candidate_view_digest: p.candidate_view_digest.clone(),
        candidate_binding: None,
        authorization_actor: p.authorization_actor.clone(),
        expires_at: p.expires_at.clone(),
        authorization_ref: p.authorization_ref.clone(),
        authorization_digest,
    });
    sync_workflow_compatibility_view(state, &key);
}

/// Apply the sealed_v3 model authorization. Its only authority source is the
/// exact parented intent already projected for the action; every dynamic
/// evidence descriptor is repeated here solely so the signed tape remains
/// self-contained and is rejected if it differs from that intent.
fn apply_model_action_authorized_v2(
    state: &mut ReplayState,
    event: &Event,
    p: &ModelActionAuthorizedV2,
) {
    if let Err(reason) = validate_v3_event_payload(event) {
        reject_workflow_transition(state, event, reason);
        return;
    }
    let authorization_digest = match model_action_authorized_v2_digest(p) {
        Ok(digest) => digest,
        Err(error) => {
            reject_workflow_transition(
                state,
                event,
                format!("could not canonicalize V2 model action authorization: {error}"),
            );
            return;
        }
    };

    let mut intent_matches = Vec::new();
    for (workflow_key, workflow) in &state.workflow_instances {
        let Some(evidence) = workflow.action_evidence.as_ref() else {
            continue;
        };
        for (action_id, action) in &evidence.actions {
            if action
                .model_intent
                .as_ref()
                .is_some_and(|intent| intent.event_id == p.intent_event_ref)
            {
                intent_matches.push((workflow_key.clone(), action_id.clone()));
            }
        }
    }
    if intent_matches.len() != 1 {
        reject_workflow_transition(
            state,
            event,
            "ModelActionAuthorizedV2 must reference exactly one prior ModelActionIntentV1".into(),
        );
        return;
    }
    let (key, action_id) = intent_matches
        .pop()
        .expect("the checked intent match collection has one item");
    let Some(workflow) = state.workflow_instances.get(&key) else {
        unreachable!("model action intent lookup returned an existing workflow")
    };
    if !event_matches_workflow_run(workflow, event) {
        reject_workflow_transition(
            state,
            event,
            "ModelActionAuthorizedV2 belongs to a different run than its intent".into(),
        );
        return;
    }
    if !requires_activity_claim_result(workflow)
        || workflow.dispatch.trust_tier != TrustTierV1::Governed
    {
        reject_workflow_transition(
            state,
            event,
            "ModelActionAuthorizedV2 requires a governed sealed_v3 dispatch envelope".into(),
        );
        return;
    }
    if workflow.phase != WorkflowPhaseV1::Dispatched {
        reject_workflow_transition(
            state,
            event,
            format!(
                "model action authorization is not allowed from phase {:?}",
                workflow.phase
            ),
        );
        return;
    }
    let Some(evidence) = workflow.action_evidence.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "sealed_v3 dispatch is missing its action evidence projection".into(),
        );
        return;
    };
    if evidence.sealed_receipt_set.is_some() {
        reject_workflow_transition(
            state,
            event,
            "no model authorization may be recorded after the action receipt set is sealed".into(),
        );
        return;
    }
    let Some(action) = evidence.actions.get(&action_id) else {
        unreachable!("model action intent lookup returned an existing action")
    };
    if action.request.action_kind != ActionKindV1::Model {
        reject_workflow_transition(
            state,
            event,
            "ModelActionAuthorizedV2 may bind only a V3 model action request".into(),
        );
        return;
    }
    let Some(intent) = action.model_intent.as_ref() else {
        unreachable!("model action intent lookup returned an intent")
    };
    if event.parent_event_id != Some(intent.event_id)
        || p.intent_event_ref != intent.event_id
        || p.intent_digest != intent.intent_digest
    {
        reject_workflow_transition(
            state,
            event,
            "ModelActionAuthorizedV2 must parent to and bind its exact ModelActionIntentV1".into(),
        );
        return;
    }
    if p.model_request_evidence != intent.model_request_evidence
        || p.trust_scope_evidence != intent.trust_scope_evidence
        || p.candidate_binding != intent.candidate_binding
    {
        reject_workflow_transition(
            state,
            event,
            "ModelActionAuthorizedV2 dynamic evidence must exactly equal its parent intent".into(),
        );
        return;
    }
    if action.receipt.is_some()
        || action
            .activity_claim
            .as_ref()
            .and_then(|claim| claim.result.as_ref())
            .is_some()
    {
        reject_workflow_transition(
            state,
            event,
            "ModelActionAuthorizedV2 must be recorded before the terminal action receipt or terminal activity result".into(),
        );
        return;
    }
    let Some(intended_at) = parse_rfc3339_utc(&intent.intended_at) else {
        reject_workflow_transition(
            state,
            event,
            "stored model action intent intended_at must be an RFC3339 UTC timestamp".into(),
        );
        return;
    };
    let Some(requested_at) = parse_rfc3339_utc(&action.request.requested_at) else {
        reject_workflow_transition(
            state,
            event,
            "stored V3 model action requested_at must be an RFC3339 UTC timestamp".into(),
        );
        return;
    };
    let Some(expires_at) = parse_rfc3339_utc(&p.expires_at) else {
        reject_workflow_transition(
            state,
            event,
            "ModelActionAuthorizedV2 expires_at must be an RFC3339 UTC timestamp".into(),
        );
        return;
    };
    let Some(effective_deadline) = effective_dispatch_effect_deadline(workflow) else {
        reject_workflow_transition(
            state,
            event,
            "signed sealed_v3 dispatch has no valid effective compute deadline".into(),
        );
        return;
    };
    if intended_at < requested_at {
        reject_workflow_transition(
            state,
            event,
            "ModelActionAuthorizedV2 parent intent predates its V3 write-ahead request".into(),
        );
        return;
    }
    if expires_at <= intended_at {
        reject_workflow_transition(
            state,
            event,
            "ModelActionAuthorizedV2 must outlive its parent model action intent".into(),
        );
        return;
    }
    if expires_at > effective_deadline {
        reject_workflow_transition(
            state,
            event,
            "ModelActionAuthorizedV2 must not outlive its signed compute deadline".into(),
        );
        return;
    }
    if event.occurred_at < intended_at || event.occurred_at >= expires_at {
        reject_workflow_transition(
            state,
            event,
            "ModelActionAuthorizedV2 event time must fall after its intent and before expiry"
                .into(),
        );
        return;
    }
    let Some(packet_digest) = workflow.dispatch.governed_packet_digest.clone() else {
        reject_workflow_transition(
            state,
            event,
            "sealed_v3 model action intent is missing the governed packet binding".into(),
        );
        return;
    };
    if let Some(existing) = action.model_authorization.as_ref() {
        if model_authorization_v2_matches_existing(existing, event, p, &authorization_digest) {
            return;
        }
        reject_workflow_transition(
            state,
            event,
            "ModelActionAuthorizedV2 attempts to replace immutable native authority".into(),
        );
        return;
    }
    if model_authorization_ref_is_bound_elsewhere(state, &key, &action_id, &p.authorization_ref) {
        reject_workflow_transition(
            state,
            event,
            "model authorization_ref is already bound to a different V3 action".into(),
        );
        return;
    }

    let authorization = ModelActionAuthorizationReplayState {
        event_id: event.id,
        authorized_at: Some(
            event
                .occurred_at
                .to_rfc3339_opts(SecondsFormat::AutoSi, true),
        ),
        authorization_version: 2,
        intent_event_ref: Some(intent.event_id),
        intent_digest: Some(intent.intent_digest.clone()),
        dispatch_event_ref: intent.dispatch_event_ref.to_string(),
        dispatch_envelope_digest: intent.dispatch_envelope_digest.clone(),
        action_request_ref: intent.action_request_event_ref.to_string(),
        action_request_digest: intent.action_request_digest.clone(),
        packet_digest,
        canonical_input_digest: intent.canonical_input_digest.clone(),
        model_request_digest: intent.model_request_evidence.digest.clone(),
        model_request_evidence_ref: Some(intent.model_request_evidence.cas_ref.clone()),
        model_request_evidence_schema_version: Some(intent.model_request_evidence.schema_version),
        trust_scope_digest: intent.trust_scope_evidence.digest.clone(),
        trust_scope_evidence_ref: Some(intent.trust_scope_evidence.cas_ref.clone()),
        trust_scope_evidence_schema_version: Some(intent.trust_scope_evidence.schema_version),
        context_manifest_digest: workflow.dispatch.context_manifest_digest.clone(),
        policy_digest: action.request.policy_digest.clone(),
        sandbox_profile_digest: workflow.dispatch.sandbox_profile_digest.clone(),
        execution_role: action.request.execution_role,
        candidate_digest: intent
            .candidate_binding
            .as_ref()
            .map(|binding| binding.candidate_digest.clone()),
        candidate_view_digest: intent
            .candidate_binding
            .as_ref()
            .map(|binding| binding.candidate_view_digest.clone()),
        candidate_binding: intent.candidate_binding.clone(),
        authorization_actor: p.authorization_actor.clone(),
        expires_at: p.expires_at.clone(),
        authorization_ref: p.authorization_ref.clone(),
        authorization_digest,
    };
    let workflow = state
        .workflow_instances
        .get_mut(&key)
        .expect("workflow was checked above");
    let action = workflow
        .action_evidence
        .as_mut()
        .expect("sealed_v3 workflow has action evidence")
        .actions
        .get_mut(&action_id)
        .expect("action intent was checked above");
    action.model_authorization = Some(authorization);
    sync_workflow_compatibility_view(state, &key);
}

/// Apply an immutable terminal receipt. A receipt can only complete a prior
/// write-ahead request and duplicate delivery is a no-op only when every
/// digest, outcome, evidence reference, and timestamp is identical.
fn apply_action_receipt_recorded_v2(
    state: &mut ReplayState,
    event: &Event,
    p: &ActionReceiptRecordedV2,
) {
    if let Err(reason) = validate_v3_event_payload(event) {
        reject_workflow_transition(state, event, reason);
        return;
    }
    let key = match find_v3_workflow_key_for_action(
        state,
        event,
        &p.run_id,
        &p.workflow_id,
        &p.unit_id,
        p.attempt,
        &p.provenance_ref,
        &p.dispatch_envelope_digest,
        None,
        None,
        None,
        &p.capability_bundle_digest,
        &p.context_manifest_digest,
        &p.worker_manifest_digest,
        &p.sandbox_profile_digest,
        p.execution_role,
    ) {
        Ok(key) => key,
        Err(reason) => {
            reject_workflow_transition(state, event, reason);
            return;
        }
    };

    let action_receipt_digest = match action_receipt_recorded_v2_digest(p) {
        Ok(digest) => digest,
        Err(error) => {
            reject_workflow_transition(
                state,
                event,
                format!("could not canonicalize V2 action receipt: {error}"),
            );
            return;
        }
    };
    let Some(workflow) = state.workflow_instances.get(&key) else {
        unreachable!("find_v3_workflow_key_for_action returned an existing key")
    };
    let Some(evidence) = workflow.action_evidence.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "V3 dispatch is missing its action evidence projection".into(),
        );
        return;
    };
    if evidence.sealed_receipt_set.is_some() {
        reject_workflow_transition(
            state,
            event,
            "no action receipt may be recorded after the action receipt set is sealed".into(),
        );
        return;
    }
    let cancellation_reconciliation = workflow.phase == WorkflowPhaseV1::CancellationRequested;
    if workflow.phase != WorkflowPhaseV1::Dispatched && !cancellation_reconciliation {
        reject_workflow_transition(
            state,
            event,
            format!(
                "action receipt is not allowed from phase {:?}",
                workflow.phase
            ),
        );
        return;
    }
    let Some(action) = evidence.actions.get(&p.action_id) else {
        reject_workflow_transition(
            state,
            event,
            "action receipt has no prior V3 write-ahead request".into(),
        );
        return;
    };
    if cancellation_reconciliation
        && action
            .activity_claim
            .as_ref()
            .and_then(|claim| claim.result.as_ref())
            .is_none()
    {
        reject_workflow_transition(
            state,
            event,
            "cancellation reconciliation may record receipts only for effects with an already-recorded terminal activity result".into(),
        );
        return;
    }
    if !action_receipt_matches_request(&action.request, p) {
        reject_workflow_transition(
            state,
            event,
            "action receipt does not bind the exact V3 write-ahead request".into(),
        );
        return;
    }
    if action.request.action_kind == ActionKindV1::Model
        && p.outcome == ActionReceiptOutcomeV2::Succeeded
    {
        if let Err(reason) =
            validate_governed_model_token_budget(workflow, evidence, &p.action_id, p)
        {
            reject_workflow_transition(state, event, reason);
            return;
        }
    }
    if action.request.action_kind == ActionKindV1::Model
        && p.outcome == ActionReceiptOutcomeV2::Succeeded
    {
        let Some(authorization) = action.model_authorization.as_ref() else {
            reject_workflow_transition(
                state,
                event,
                if requires_activity_claim_result(workflow) {
                    "sealed_v3 model action receipts require a prior ModelActionIntentV1 followed by matching ModelActionAuthorizedV2 record".into()
                } else {
                    "governed V3 model action receipts require a prior matching ModelActionAuthorizedV1 record".into()
                },
            );
            return;
        };
        if requires_activity_claim_result(workflow)
            && (authorization.authorization_version != 2 || action.model_intent.is_none())
        {
            reject_workflow_transition(
                state,
                event,
                "sealed_v3 model action receipts require a prior ModelActionIntentV1 followed by matching ModelActionAuthorizedV2 record".into(),
            );
            return;
        }
        if p.authorization_ref.as_deref() != Some(authorization.authorization_ref.as_str()) {
            reject_workflow_transition(
                state,
                event,
                "governed V3 model action receipt authorization_ref does not match its native authorization record"
                    .into(),
            );
            return;
        }
        let Some(completed_at) = parse_rfc3339_utc(&p.completed_at) else {
            reject_workflow_transition(
                state,
                event,
                "model action receipt completed_at must be an RFC3339 UTC timestamp".into(),
            );
            return;
        };
        let Some(expires_at) = parse_rfc3339_utc(&authorization.expires_at) else {
            reject_workflow_transition(
                state,
                event,
                "stored model action authorization expires_at must be an RFC3339 UTC timestamp"
                    .into(),
            );
            return;
        };
        if requires_activity_claim_result(workflow) {
            let Some(authorized_at) = authorization
                .authorized_at
                .as_deref()
                .and_then(parse_rfc3339_utc)
            else {
                reject_workflow_transition(
                    state,
                    event,
                    "sealed_v3 model action receipt requires an exact native authorization timestamp"
                        .into(),
                );
                return;
            };
            if completed_at < authorized_at {
                reject_workflow_transition(
                    state,
                    event,
                    "sealed_v3 model action receipt completed before its native authorization"
                        .into(),
                );
                return;
            }
            let Some(claimed_at) = action
                .activity_claim
                .as_ref()
                .and_then(|claim| parse_rfc3339_utc(&claim.claimed_at))
            else {
                reject_workflow_transition(
                    state,
                    event,
                    "sealed_v3 model action receipt requires a prior activity claim with an RFC3339 timestamp"
                        .into(),
                );
                return;
            };
            if completed_at < claimed_at {
                reject_workflow_transition(
                    state,
                    event,
                    "sealed_v3 model action receipt completed before its native activity claim"
                        .into(),
                );
                return;
            }
            if let Some(result_recorded_at) = action
                .activity_claim
                .as_ref()
                .and_then(|claim| claim.result.as_ref())
                .and_then(|result| parse_rfc3339_utc(&result.recorded_at))
            {
                if completed_at > result_recorded_at {
                    reject_workflow_transition(
                        state,
                        event,
                        "sealed_v3 model action receipt completed after its recorded terminal activity result"
                            .into(),
                    );
                    return;
                }
            }
        }
        if completed_at >= expires_at {
            reject_workflow_transition(
                state,
                event,
                "governed V3 model action receipt completed at or after native authorization expiry"
                    .into(),
            );
            return;
        }
    }
    let requires_activity_result = requires_activity_claim_result(workflow);
    let activity_claim = action.activity_claim.as_ref();
    if requires_activity_result
        && activity_claim
            .and_then(|claim| claim.result.as_ref())
            .is_none()
    {
        reject_workflow_transition(
            state,
            event,
            "sealed_v3 action receipts require a prior terminal activity claim result".into(),
        );
        return;
    }
    if let Some(claim) = activity_claim {
        if !activity_claim_result_matches_receipt(claim, p, requires_activity_result) {
            reject_workflow_transition(
                state,
                event,
                "action receipt does not agree with the immutable activity-claim terminal result"
                    .into(),
            );
            return;
        }
    }
    if let Some(existing) = action.receipt.as_ref() {
        if action_receipt_matches_existing(existing, p, &action_receipt_digest) {
            return;
        }
        reject_workflow_transition(
            state,
            event,
            "action receipt attempts to replace an immutable action result".into(),
        );
        return;
    }
    if evidence.actions.iter().any(|(action_id, existing)| {
        action_id != &p.action_id
            && existing
                .receipt
                .as_ref()
                .is_some_and(|receipt| receipt.action_receipt_ref == p.action_receipt_ref)
    }) {
        reject_workflow_transition(
            state,
            event,
            "action receipt ref is already bound to a different action".into(),
        );
        return;
    }

    let workflow = state
        .workflow_instances
        .get_mut(&key)
        .expect("workflow was checked above");
    let evidence = workflow
        .action_evidence
        .as_mut()
        .expect("V3 workflow has action evidence");
    let action = evidence
        .actions
        .get_mut(&p.action_id)
        .expect("request was checked above");
    action.receipt = Some(ActionReceiptReplayState {
        event_id: event.id,
        action_id: p.action_id.clone(),
        idempotency_key: p.idempotency_key.clone(),
        action_request_digest: p.action_request_digest.clone(),
        outcome: p.outcome,
        result_digest: p.result_digest.clone(),
        result_ref: p.result_ref.clone(),
        evidence_digest: p.evidence_digest.clone(),
        evidence_ref: p.evidence_ref.clone(),
        resource_usage: p.resource_usage.clone(),
        redactions: p.redactions.clone(),
        failure: p.failure.clone(),
        authorization_ref: p.authorization_ref.clone(),
        action_receipt_ref: p.action_receipt_ref.clone(),
        action_receipt_digest,
        completed_at: p.completed_at.clone(),
    });
    refresh_action_evidence_recovery(evidence);
    sync_workflow_compatibility_view(state, &key);
}

/// The signed `max_tokens` budget applies to the complete model-effect set of
/// one governed sealed_v3 workflow/unit attempt, never to an individual
/// provider call. Receipt token observations are optional on the additive
/// wire shape so historical sealed-v2 tapes remain readable; the current
/// sealed_v3 authority protocol fails closed before it accepts a successful
/// model receipt without a complete, arithmetically safe pair.
///
/// Failed provider calls can still be billable. Their complete metered pairs
/// therefore consume the same durable allowance. Conversely, a prior model
/// receipt with absent or partial usage has an unknowable aggregate. It blocks
/// another model success on this exact envelope regardless of its free-form
/// failure code; those codes are diagnostic data, not an authorization
/// boundary.
fn validate_governed_model_token_budget(
    workflow: &WorkflowInstanceV1,
    evidence: &ActionEvidenceReplayState,
    current_action_id: &str,
    current: &ActionReceiptRecordedV2,
) -> Result<(), String> {
    if workflow.dispatch.trust_tier != TrustTierV1::Governed
        || !requires_activity_claim_result(workflow)
    {
        return Ok(());
    }
    let Some(max_tokens) = workflow.dispatch.budget.max_tokens else {
        return Ok(());
    };

    let current_total = model_receipt_token_total(&current.resource_usage, "successful model receipt")?
        .ok_or_else(|| {
            "governed sealed_v3 model success under signed max_tokens requires both input_tokens and output_tokens"
                .to_string()
        })?;
    let mut aggregate = 0_u64;

    for (action_id, action) in &evidence.actions {
        if action_id == current_action_id || action.request.action_kind != ActionKindV1::Model {
            continue;
        }
        let Some(receipt) = action.receipt.as_ref() else {
            continue;
        };
        let prior_total =
            model_receipt_token_total(&receipt.resource_usage, "prior model receipt")?;
        let Some(prior_total) = prior_total else {
            return Err(
                "a prior model receipt under signed max_tokens lacks a complete input_tokens/output_tokens pair, so a later model success would have an unknowable aggregate"
                    .into(),
            );
        };
        aggregate = aggregate.checked_add(prior_total).ok_or_else(|| {
            "governed model token aggregate overflowed while accounting prior receipts".to_string()
        })?;
    }

    let total = aggregate.checked_add(current_total).ok_or_else(|| {
        "governed model token aggregate overflowed while accounting the current receipt".to_string()
    })?;
    if total > u64::from(max_tokens) {
        return Err(format!(
            "governed model token aggregate {total} exceeds the signed max_tokens budget of {max_tokens}"
        ));
    }
    Ok(())
}

/// Return `None` only when neither optional token observation exists. A
/// partial pair is never useful accounting evidence, and all additions stay
/// checked even though the wire serializer constrains each value to the
/// JavaScript-safe range.
fn model_receipt_token_total(
    resource_usage: &ActionResourceUsageV1,
    label: &str,
) -> Result<Option<u64>, String> {
    match (resource_usage.input_tokens, resource_usage.output_tokens) {
        (None, None) => Ok(None),
        (Some(input), Some(output)) => input.checked_add(output).map(Some).ok_or_else(|| {
            format!("{label} input_tokens plus output_tokens overflows the durable token total")
        }),
        _ => Err(format!(
            "{label} must provide input_tokens and output_tokens together"
        )),
    }
}

/// Seal exactly the receipts that comprise a V3 candidate overlay. The set is
/// not an advisory list: it must name every request in canonical action-id
/// order, leave no pending/unknown effect, and bind each recorded receipt's
/// immutable digest/ref pair.
fn apply_action_receipt_set_recorded_v1(
    state: &mut ReplayState,
    event: &Event,
    p: &ActionReceiptSetRecordedV1,
) {
    if let Err(reason) = validate_v3_event_payload(event) {
        reject_workflow_transition(state, event, reason);
        return;
    }
    let key = match find_v3_workflow_key_for_set(state, event, p) {
        Ok(key) => key,
        Err(reason) => {
            reject_workflow_transition(state, event, reason);
            return;
        }
    };
    let Some(workflow) = state.workflow_instances.get(&key) else {
        unreachable!("find_v3_workflow_key_for_set returned an existing key")
    };
    let Some(evidence) = workflow.action_evidence.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "V3 dispatch is missing its action evidence projection".into(),
        );
        return;
    };
    if let Some(existing) = evidence.sealed_receipt_set.as_ref() {
        if action_receipt_set_matches_existing(existing, p) {
            return;
        }
        reject_workflow_transition(
            state,
            event,
            "action receipt set attempts to replace an immutable sealed set".into(),
        );
        return;
    }
    if workflow.phase != WorkflowPhaseV1::Dispatched {
        reject_workflow_transition(
            state,
            event,
            format!(
                "action receipt set is not allowed from phase {:?}",
                workflow.phase
            ),
        );
        return;
    }
    if !evidence.pending_action_ids.is_empty() {
        reject_workflow_transition(
            state,
            event,
            "action receipt set cannot seal while action effects remain pending".into(),
        );
        return;
    }
    if !evidence.unknown_action_ids.is_empty() {
        reject_workflow_transition(
            state,
            event,
            "action receipt set cannot seal while action effects are unknown".into(),
        );
        return;
    }
    if requires_activity_claim_result(workflow) {
        if !evidence.actions.values().all(|action| {
            action
                .activity_claim
                .as_ref()
                .and_then(|claim| claim.result.as_ref())
                .is_some()
        }) {
            reject_workflow_transition(
                state,
                event,
                "sealed_v3 action receipt set requires a terminal activity result for every action"
                    .into(),
            );
            return;
        }
        if !evidence.failed_action_ids.is_empty() {
            reject_workflow_transition(
                state,
                event,
                "sealed_v3 action receipt set cannot seal while terminal action failures remain"
                    .into(),
            );
            return;
        }
    }
    if p.receipts.len() != evidence.actions.len() {
        reject_workflow_transition(
            state,
            event,
            "action receipt set must represent every terminal action for the candidate overlay"
                .into(),
        );
        return;
    }
    for (entry, (action_id, action)) in p.receipts.iter().zip(&evidence.actions) {
        let Some(receipt) = action.receipt.as_ref() else {
            reject_workflow_transition(
                state,
                event,
                "action receipt set contains a pending action".into(),
            );
            return;
        };
        if entry.action_id.as_str() != action_id.as_str()
            || entry.action_receipt_ref.as_str() != receipt.action_receipt_ref.as_str()
            || entry.action_receipt_digest.as_str() != receipt.action_receipt_digest.as_str()
        {
            reject_workflow_transition(
                state,
                event,
                "action receipt set does not exactly bind its recorded terminal receipts".into(),
            );
            return;
        }
    }
    let expected_digest = match action_receipt_set_v1_digest(p) {
        Ok(digest) => digest,
        Err(error) => {
            reject_workflow_transition(
                state,
                event,
                format!("could not canonicalize action receipt set: {error}"),
            );
            return;
        }
    };
    if expected_digest != p.action_receipt_set_digest {
        reject_workflow_transition(
            state,
            event,
            "action receipt set digest does not match its canonical contents".into(),
        );
        return;
    }

    let workflow = state
        .workflow_instances
        .get_mut(&key)
        .expect("workflow was checked above");
    let evidence = workflow
        .action_evidence
        .as_mut()
        .expect("V3 workflow has action evidence");
    evidence.sealed_receipt_set = Some(ActionReceiptSetReplayState {
        event_id: event.id,
        action_receipt_set_ref: p.action_receipt_set_ref.clone(),
        action_receipt_set_digest: p.action_receipt_set_digest.clone(),
        receipts: p.receipts.clone(),
        sealed_at: p.sealed_at.clone(),
    });
    sync_workflow_compatibility_view(state, &key);
}

fn apply_candidate_created(state: &mut ReplayState, event: &Event, p: &CandidateCreatedV1) {
    if p.candidate_id.trim().is_empty() || !is_canonical_buildplane_candidate_ref(&p.candidate_ref)
    {
        reject_workflow_transition(
            state,
            event,
            "candidate must have a non-empty id and a canonical buildplane candidate ref".into(),
        );
        return;
    }
    ensure_workflow_instances(state);
    let key = workflow_instance_key(&p.workflow_id, &p.unit_id, p.attempt);
    let Some(workflow) = state.workflow_instances.get(&key) else {
        reject_workflow_transition(
            state,
            event,
            "candidate has no prior dispatch envelope".into(),
        );
        return;
    };

    if !event_matches_workflow_run(workflow, event) {
        reject_workflow_transition(state, event, "candidate belongs to a different run".into());
        return;
    }
    if workflow.phase.is_terminal() {
        reject_workflow_transition(
            state,
            event,
            "candidate received after terminal workflow phase".into(),
        );
        return;
    }
    if workflow.dispatch.trust_tier != TrustTierV1::Governed {
        reject_workflow_transition(
            state,
            event,
            "immutable candidates require a governed dispatch envelope".into(),
        );
        return;
    }
    if workflow.dispatch.commit_mode != CommitModeV1::Atomic {
        reject_workflow_transition(
            state,
            event,
            "governed replay supports only atomic candidate promotion".into(),
        );
        return;
    }
    if workflow.dispatch.dispatch_version >= 3 {
        reject_workflow_transition(
            state,
            event,
            "legacy candidate v1 is not allowed for sealed V3 action evidence".into(),
        );
        return;
    }
    if !matches!(
        workflow.dispatch.execution_role,
        ExecutionRoleV1::Implementer | ExecutionRoleV1::Candidate
    ) {
        reject_workflow_transition(
            state,
            event,
            "only implementer or candidate roles can create an immutable candidate".into(),
        );
        return;
    }
    if !candidate_matches_dispatch(workflow, p) {
        reject_workflow_transition(
            state,
            event,
            "candidate lineage does not match the signed dispatch envelope".into(),
        );
        return;
    }
    if let Some(existing) = workflow.candidate.as_ref() {
        if candidate_matches_existing(existing, event.id, p) {
            return;
        }
        reject_workflow_transition(
            state,
            event,
            "workflow already has a different immutable candidate".into(),
        );
        return;
    }
    if workflow.phase != WorkflowPhaseV1::Dispatched {
        let reason = format!("candidate is not allowed from phase {:?}", workflow.phase);
        reject_workflow_transition(state, event, reason);
        return;
    }

    if state.workflow_instances.iter().any(|(other_key, other)| {
        other_key != &key
            && other.candidate.as_ref().is_some_and(|candidate| {
                candidate.candidate_digest == p.candidate_digest
                    || candidate.candidate_id == p.candidate_id
                    || candidate.candidate_ref == p.candidate_ref
            })
    }) {
        reject_workflow_transition(
            state,
            event,
            "candidate digest, id, or ref is already bound to a different workflow unit attempt"
                .into(),
        );
        return;
    }

    let workflow = state
        .workflow_instances
        .get_mut(&key)
        .expect("workflow was checked above");
    workflow.candidate = Some(CandidateArtifactReplayState {
        event_id: event.id,
        candidate_id: p.candidate_id.clone(),
        candidate_ref: p.candidate_ref.clone(),
        candidate_digest: p.candidate_digest.clone(),
        base_commit_sha: p.base_commit_sha.clone(),
        candidate_commit_sha: p.candidate_commit_sha.clone(),
        commit_digest: p.commit_digest.clone(),
        tree_digest: p.tree_digest.clone(),
        patch_digest: p.patch_digest.clone(),
        changed_files_digest: p.changed_files_digest.clone(),
        envelope_digest: p.envelope_digest.clone(),
        action_receipt_digest: Some(p.action_receipt_digest.clone()),
        action_receipt_set_ref: None,
        action_receipt_set_digest: None,
    });
    workflow.phase = WorkflowPhaseV1::CandidateCreated;
    sync_workflow_compatibility_view(state, &key);
}

/// V3 candidate creation is permitted only after the exact action-receipt set
/// has been sealed. Its Git facts are still immutable candidate evidence, but
/// the single worker-provided legacy receipt digest is intentionally absent.
fn apply_candidate_created_v2(state: &mut ReplayState, event: &Event, p: &CandidateCreatedV2) {
    if let Err(reason) = validate_v3_event_payload(event) {
        reject_workflow_transition(state, event, reason);
        return;
    }
    if p.candidate_id.trim().is_empty() || !is_canonical_buildplane_candidate_ref(&p.candidate_ref)
    {
        reject_workflow_transition(
            state,
            event,
            "candidate v2 must have a non-empty id and a canonical buildplane candidate ref".into(),
        );
        return;
    }
    if p.run_id != event.run_id.to_string() {
        reject_workflow_transition(
            state,
            event,
            "candidate v2 belongs to a different run".into(),
        );
        return;
    }
    ensure_workflow_instances(state);
    let key = workflow_instance_key(&p.workflow_id, &p.unit_id, p.attempt);
    let Some(workflow) = state.workflow_instances.get(&key) else {
        reject_workflow_transition(
            state,
            event,
            "candidate v2 has no prior V3 dispatch envelope".into(),
        );
        return;
    };
    if !event_matches_workflow_run(workflow, event) {
        reject_workflow_transition(
            state,
            event,
            "candidate v2 belongs to a different run".into(),
        );
        return;
    }
    if !supports_sealed_action_evidence(workflow) {
        reject_workflow_transition(
            state,
            event,
            "candidate v2 requires a sealed V3 dispatch envelope".into(),
        );
        return;
    }
    if workflow.phase.is_terminal() {
        reject_workflow_transition(
            state,
            event,
            "candidate v2 received after terminal workflow phase".into(),
        );
        return;
    }
    if workflow.dispatch.trust_tier != TrustTierV1::Governed {
        reject_workflow_transition(
            state,
            event,
            "candidate v2 requires a governed V3 dispatch envelope".into(),
        );
        return;
    }
    if workflow.dispatch.commit_mode != CommitModeV1::Atomic {
        reject_workflow_transition(
            state,
            event,
            "governed replay supports only atomic candidate promotion".into(),
        );
        return;
    }
    if !matches!(
        workflow.dispatch.execution_role,
        ExecutionRoleV1::Implementer | ExecutionRoleV1::Candidate
    ) {
        reject_workflow_transition(
            state,
            event,
            "only implementer or candidate roles can create an immutable candidate".into(),
        );
        return;
    }
    if !candidate_v2_matches_dispatch(workflow, p) {
        reject_workflow_transition(
            state,
            event,
            "candidate v2 lineage does not match the signed V3 dispatch envelope".into(),
        );
        return;
    }
    let Some(evidence) = workflow.action_evidence.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "candidate v2 dispatch is missing its action evidence projection".into(),
        );
        return;
    };
    if !evidence.pending_action_ids.is_empty() || !evidence.unknown_action_ids.is_empty() {
        reject_workflow_transition(
            state,
            event,
            "candidate v2 cannot be created while action effects are pending or unknown".into(),
        );
        return;
    }
    if requires_activity_claim_result(workflow) && !evidence.failed_action_ids.is_empty() {
        reject_workflow_transition(
            state,
            event,
            "sealed_v3 candidate v2 cannot be created after a terminal action failure".into(),
        );
        return;
    }
    let Some(sealed_set) = evidence.sealed_receipt_set.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "candidate v2 requires an exact sealed action receipt set".into(),
        );
        return;
    };
    if p.action_receipt_set_ref != sealed_set.action_receipt_set_ref
        || p.action_receipt_set_digest != sealed_set.action_receipt_set_digest
    {
        reject_workflow_transition(
            state,
            event,
            "candidate v2 does not bind the exact sealed action receipt set".into(),
        );
        return;
    }
    if let Some(existing) = workflow.candidate.as_ref() {
        if candidate_v2_matches_existing(existing, event.id, p) {
            return;
        }
        reject_workflow_transition(
            state,
            event,
            "workflow already has a different immutable candidate".into(),
        );
        return;
    }
    if workflow.phase != WorkflowPhaseV1::Dispatched {
        let reason = format!(
            "candidate v2 is not allowed from phase {:?}",
            workflow.phase
        );
        reject_workflow_transition(state, event, reason);
        return;
    }
    if state.workflow_instances.iter().any(|(other_key, other)| {
        other_key != &key
            && other.candidate.as_ref().is_some_and(|candidate| {
                candidate.candidate_digest == p.candidate_digest
                    || candidate.candidate_id == p.candidate_id
                    || candidate.candidate_ref == p.candidate_ref
            })
    }) {
        reject_workflow_transition(
            state,
            event,
            "candidate digest, id, or ref is already bound to a different workflow unit attempt"
                .into(),
        );
        return;
    }

    let workflow = state
        .workflow_instances
        .get_mut(&key)
        .expect("workflow was checked above");
    workflow.candidate = Some(CandidateArtifactReplayState {
        event_id: event.id,
        candidate_id: p.candidate_id.clone(),
        candidate_ref: p.candidate_ref.clone(),
        candidate_digest: p.candidate_digest.clone(),
        base_commit_sha: p.base_commit_sha.clone(),
        candidate_commit_sha: p.candidate_commit_sha.clone(),
        commit_digest: p.commit_digest.clone(),
        tree_digest: p.tree_digest.clone(),
        patch_digest: p.patch_digest.clone(),
        changed_files_digest: p.changed_files_digest.clone(),
        envelope_digest: p.envelope_digest.clone(),
        action_receipt_digest: None,
        action_receipt_set_ref: Some(p.action_receipt_set_ref.clone()),
        action_receipt_set_digest: Some(p.action_receipt_set_digest.clone()),
    });
    workflow.phase = WorkflowPhaseV1::CandidateCreated;
    sync_workflow_compatibility_view(state, &key);
}

/// Record the closed, kernel-signed action lineage for one governed sealed_v3
/// candidate. This does not advance the candidate lifecycle; it merely makes
/// the candidate eligible for the later acceptance/review/promotion gates.
fn apply_candidate_completion_recorded_v1(
    state: &mut ReplayState,
    event: &Event,
    p: &CandidateCompletionRecordedV1,
) {
    if let Err(reason) = validate_v3_event_payload(event) {
        reject_workflow_transition(state, event, reason);
        return;
    }
    if p.run_id != event.run_id.to_string() {
        reject_workflow_transition(
            state,
            event,
            "candidate completion payload run_id does not match its event run_id".into(),
        );
        return;
    }
    let expected_completion_digest = match candidate_completion_recorded_v1_digest(p) {
        Ok(digest) => digest,
        Err(error) => {
            reject_workflow_transition(
                state,
                event,
                format!("could not canonicalize candidate completion: {error}"),
            );
            return;
        }
    };
    if p.completion_digest != expected_completion_digest {
        reject_workflow_transition(
            state,
            event,
            "candidate completion digest does not bind its closed lineage".into(),
        );
        return;
    }
    let Some(completed_at) = parse_rfc3339_utc(&p.completed_at) else {
        reject_workflow_transition(
            state,
            event,
            "candidate completion completed_at must be an RFC3339 UTC timestamp".into(),
        );
        return;
    };
    if completed_at != event.occurred_at {
        reject_workflow_transition(
            state,
            event,
            "candidate completion completed_at must equal its signed event occurred_at".into(),
        );
        return;
    }

    ensure_workflow_instances(state);
    let key = workflow_instance_key(&p.workflow_id, &p.unit_id, p.attempt);
    let Some(workflow) = state.workflow_instances.get(&key) else {
        reject_workflow_transition(
            state,
            event,
            "candidate completion has no prior V3 dispatch envelope".into(),
        );
        return;
    };
    if !event_matches_workflow_run(workflow, event) {
        reject_workflow_transition(
            state,
            event,
            "candidate completion belongs to a different run".into(),
        );
        return;
    }
    if !requires_candidate_completion(workflow) {
        reject_workflow_transition(
            state,
            event,
            "candidate completion requires a governed sealed_v3 candidate workflow".into(),
        );
        return;
    }
    if workflow.dispatch.provenance_ref != p.provenance_ref {
        reject_workflow_transition(
            state,
            event,
            "candidate completion workflow identity does not match its signed dispatch envelope"
                .into(),
        );
        return;
    }
    let Some(candidate) = workflow.candidate.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "candidate completion has no immutable candidate".into(),
        );
        return;
    };
    if p.candidate_created_event_ref != candidate.event_id
        || p.candidate_digest != candidate.candidate_digest
        || event.parent_event_id != Some(candidate.event_id)
    {
        reject_workflow_transition(
            state,
            event,
            "candidate completion must parent to and bind the exact CandidateCreatedV2 event"
                .into(),
        );
        return;
    }
    if let Some(existing) = workflow.candidate_completion.as_ref() {
        if candidate_completion_matches_existing(existing, event, p) {
            return;
        }
        reject_workflow_transition(
            state,
            event,
            "workflow already has a different immutable candidate completion proof".into(),
        );
        return;
    }
    if workflow.phase != WorkflowPhaseV1::CandidateCreated {
        reject_workflow_transition(
            state,
            event,
            format!(
                "candidate completion is not allowed from phase {:?}",
                workflow.phase
            ),
        );
        return;
    }
    let Some(evidence) = workflow.action_evidence.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "candidate completion dispatch is missing its action evidence projection".into(),
        );
        return;
    };
    let Some(sealed_set) = evidence.sealed_receipt_set.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "candidate completion requires the candidate's exact sealed action receipt set".into(),
        );
        return;
    };
    if candidate.action_receipt_set_ref.as_deref()
        != Some(sealed_set.action_receipt_set_ref.as_str())
        || candidate.action_receipt_set_digest.as_deref()
            != Some(sealed_set.action_receipt_set_digest.as_str())
    {
        reject_workflow_transition(
            state,
            event,
            "candidate completion candidate does not bind the current sealed action receipt set"
                .into(),
        );
        return;
    }
    let Some(action) = evidence.actions.get(&p.candidate_create_action_id) else {
        reject_workflow_transition(
            state,
            event,
            "candidate completion has no candidate-create action request".into(),
        );
        return;
    };
    if action.request.action_kind != ActionKindV1::Git
        || !candidate_create_action_id_matches_candidate(
            &p.candidate_create_action_id,
            &candidate.candidate_ref,
        )
    {
        reject_workflow_transition(
            state,
            event,
            "candidate completion requires the exact Git candidate-create action for its immutable candidate ref"
                .into(),
        );
        return;
    }
    if action.request.event_id != p.action_request_ref
        || action.request.action_request_digest != p.action_request_digest
    {
        reject_workflow_transition(
            state,
            event,
            "candidate completion does not bind the exact candidate-create ActionRequestedV2"
                .into(),
        );
        return;
    }
    let Some(claim) = action.activity_claim.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "candidate completion requires an immutable activity claim for its action".into(),
        );
        return;
    };
    if claim.event_id != p.activity_claim_event_ref
        || claim.claim_event_digest != p.activity_claim_event_digest
        || claim.action_request_event_id != action.request.event_id
        || claim.action_request_digest != action.request.action_request_digest
    {
        reject_workflow_transition(
            state,
            event,
            "candidate completion does not bind the exact candidate-create activity claim".into(),
        );
        return;
    }
    let Some(result) = claim.result.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "candidate completion requires a terminal activity result for its action".into(),
        );
        return;
    };
    if result.event_id != p.activity_result_event_ref
        || result.event_digest != p.activity_result_event_digest
        || result.claim_event_id != claim.event_id
        || result.claim_event_digest != claim.claim_event_digest
        || result.outcome != ActivityResultOutcomeV1::Succeeded
    {
        reject_workflow_transition(
            state,
            event,
            "candidate completion does not bind the exact succeeded candidate-create activity result"
                .into(),
        );
        return;
    }
    let Some(receipt) = action.receipt.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "candidate completion requires a terminal receipt for its action".into(),
        );
        return;
    };
    if receipt.action_receipt_ref != p.action_receipt_ref
        || receipt.action_receipt_digest != p.action_receipt_digest
        || receipt.action_request_digest != action.request.action_request_digest
        || receipt.outcome != ActionReceiptOutcomeV2::Succeeded
    {
        reject_workflow_transition(
            state,
            event,
            "candidate completion does not bind the exact succeeded candidate-create receipt"
                .into(),
        );
        return;
    }
    if !sealed_set.receipts.iter().any(|entry| {
        entry.action_id == p.candidate_create_action_id
            && entry.action_receipt_ref == p.action_receipt_ref
            && entry.action_receipt_digest == p.action_receipt_digest
    }) {
        reject_workflow_transition(
            state,
            event,
            "candidate completion receipt is absent from the candidate's sealed action receipt set"
                .into(),
        );
        return;
    }

    let workflow = state
        .workflow_instances
        .get_mut(&key)
        .expect("workflow was checked above");
    workflow.candidate_completion = Some(CandidateCompletionReplayState {
        event_id: event.id,
        completion: p.clone(),
    });
    sync_workflow_compatibility_view(state, &key);
}

fn apply_candidate_acceptance(
    state: &mut ReplayState,
    event: &Event,
    p: &CandidateAcceptanceRecordedV1,
) {
    ensure_workflow_instances(state);
    let key = match find_workflow_key_for_candidate(
        state,
        event,
        &p.candidate_digest,
        Some(&p.candidate_commit_sha),
    ) {
        Ok(key) => key,
        Err(reason) => {
            reject_workflow_transition(state, event, reason);
            return;
        }
    };
    let Some(workflow) = state.workflow_instances.get(&key) else {
        reject_workflow_transition(
            state,
            event,
            "acceptance has no prior dispatch envelope".into(),
        );
        return;
    };
    if !event_matches_workflow_run(workflow, event) {
        reject_workflow_transition(state, event, "acceptance belongs to a different run".into());
        return;
    }
    if workflow.phase.is_terminal() {
        reject_workflow_transition(
            state,
            event,
            "acceptance received after terminal workflow phase".into(),
        );
        return;
    }
    let Some(candidate) = workflow.candidate.as_ref() else {
        reject_workflow_transition(state, event, "acceptance has no immutable candidate".into());
        return;
    };
    if p.candidate_digest != candidate.candidate_digest
        || p.candidate_commit_sha != candidate.candidate_commit_sha
    {
        reject_workflow_transition(
            state,
            event,
            "acceptance candidate digest or commit does not match the immutable candidate".into(),
        );
        return;
    }
    if requires_candidate_completion(workflow) && workflow.candidate_completion.is_none() {
        reject_workflow_transition(
            state,
            event,
            "governed sealed_v3 candidate acceptance requires closed candidate completion evidence"
                .into(),
        );
        return;
    }
    if p.acceptance_contract_digest != workflow.dispatch.acceptance_contract_digest {
        reject_workflow_transition(
            state,
            event,
            "acceptance contract digest does not match the signed dispatch envelope".into(),
        );
        return;
    }
    if let Some(existing) = workflow.acceptance.as_ref() {
        if candidate_acceptance_matches_existing(existing, event.id, p) {
            return;
        }
        reject_workflow_transition(
            state,
            event,
            "candidate already has a different deterministic acceptance record".into(),
        );
        return;
    }
    if workflow.phase != WorkflowPhaseV1::CandidateCreated {
        let reason = format!("acceptance is not allowed from phase {:?}", workflow.phase);
        reject_workflow_transition(state, event, reason);
        return;
    }

    let workflow = state
        .workflow_instances
        .get_mut(&key)
        .expect("workflow was checked above");
    workflow.acceptance = Some(CandidateAcceptanceReplayState {
        event_id: event.id,
        candidate_digest: p.candidate_digest.clone(),
        candidate_commit_sha: p.candidate_commit_sha.clone(),
        acceptance_ref: p.acceptance_ref.clone(),
        acceptance_contract_digest: p.acceptance_contract_digest.clone(),
        acceptance_digest: p.acceptance_digest.clone(),
        outcome: p.outcome,
        evaluated_at: p.evaluated_at.clone(),
    });
    workflow.phase = match p.outcome {
        CandidateAcceptanceOutcomeV1::Passed => WorkflowPhaseV1::AcceptancePassed,
        CandidateAcceptanceOutcomeV1::Rejected => WorkflowPhaseV1::Rejected,
    };
    sync_workflow_compatibility_view(state, &key);
}

fn apply_review_verdict(state: &mut ReplayState, event: &Event, p: &ReviewVerdictRecordedV1) {
    if !p.confidence.is_finite() || !(0.0..=1.0).contains(&p.confidence) {
        reject_workflow_transition(
            state,
            event,
            "review confidence must be a finite value between zero and one".into(),
        );
        return;
    }
    ensure_workflow_instances(state);
    let key = match find_workflow_key_for_candidate(
        state,
        event,
        &p.candidate_digest,
        Some(&p.candidate_commit_sha),
    ) {
        Ok(key) => key,
        Err(reason) => {
            reject_workflow_transition(state, event, reason);
            return;
        }
    };
    let Some(workflow) = state.workflow_instances.get(&key) else {
        reject_workflow_transition(state, event, "review has no prior dispatch envelope".into());
        return;
    };
    if !event_matches_workflow_run(workflow, event) {
        reject_workflow_transition(state, event, "review belongs to a different run".into());
        return;
    }
    if workflow.phase.is_terminal() {
        reject_workflow_transition(
            state,
            event,
            "review received after terminal workflow phase".into(),
        );
        return;
    }
    let Some(candidate) = workflow.candidate.as_ref() else {
        reject_workflow_transition(state, event, "review has no immutable candidate".into());
        return;
    };
    if p.candidate_digest != candidate.candidate_digest
        || p.candidate_commit_sha != candidate.candidate_commit_sha
    {
        reject_workflow_transition(
            state,
            event,
            "review candidate digest or commit does not match the immutable candidate".into(),
        );
        return;
    }
    if workflow.dispatch.dispatch_version >= 3 {
        reject_workflow_transition(
            state,
            event,
            "V3 candidate review requires review_verdict_recorded_v2 evidence".into(),
        );
        return;
    }
    if !matches!(
        workflow
            .acceptance
            .as_ref()
            .map(|acceptance| acceptance.outcome),
        Some(CandidateAcceptanceOutcomeV1::Passed)
    ) {
        reject_workflow_transition(
            state,
            event,
            "review requires a passed deterministic acceptance record".into(),
        );
        return;
    }
    if !matches!(
        workflow.phase,
        WorkflowPhaseV1::AcceptancePassed | WorkflowPhaseV1::ReviewApproved
    ) {
        let reason = format!("review is not allowed from phase {:?}", workflow.phase);
        reject_workflow_transition(state, event, reason);
        return;
    }
    if let Some(existing) = workflow.reviews.get(&p.review_ref) {
        if review_matches_existing(existing, event.id, p) {
            return;
        }
        reject_workflow_transition(
            state,
            event,
            "review_ref is already bound to a different verdict".into(),
        );
        return;
    }

    let workflow = state
        .workflow_instances
        .get_mut(&key)
        .expect("workflow was checked above");
    workflow.reviews.insert(
        p.review_ref.clone(),
        ReviewVerdictReplayState {
            review_version: 1,
            event_id: event.id,
            candidate_digest: p.candidate_digest.clone(),
            candidate_commit_sha: p.candidate_commit_sha.clone(),
            review_ref: p.review_ref.clone(),
            decision: p.decision,
            findings: p.findings.clone(),
            confidence: p.confidence,
            reviewer_manifest_digest: p.reviewer_manifest_digest.clone(),
            review_verdict_action_id: None,
            review_action_request_digest: None,
            review_action_receipt_ref: None,
            review_action_receipt_digest: None,
            review_output_ref: None,
            review_output_digest: None,
            acceptance_ref: None,
            acceptance_digest: None,
            acceptance_contract_digest: None,
            candidate_envelope_digest: None,
            reviewer_workflow_id: None,
            reviewer_dispatch_envelope_digest: None,
            reviewer_unit_id: None,
            reviewer_attempt: None,
            reviewer_execution_role: None,
            review_action_receipt_set_ref: None,
            review_action_receipt_set_digest: None,
            candidate_view: None,
            candidate_view_ref: None,
            candidate_view_digest: None,
            reviewer_authority: None,
            reviewed_at: p.reviewed_at.clone(),
        },
    );
    workflow.phase = match p.decision {
        ReviewDecisionV1::Approve => WorkflowPhaseV1::ReviewApproved,
        ReviewDecisionV1::RequestChanges | ReviewDecisionV1::Reject | ReviewDecisionV1::Abstain => {
            WorkflowPhaseV1::Rejected
        }
    };
    sync_workflow_compatibility_view(state, &key);
}

/// Apply the evidence-complete V2 semantic review. The reviewer is a separate
/// V3 workflow unit: its dispatch, read-only role, sealed actions, manifest,
/// and candidate view must all agree before a verdict can affect promotion.
fn apply_review_verdict_v2(state: &mut ReplayState, event: &Event, p: &ReviewVerdictRecordedV2) {
    if let Err(reason) = validate_v3_event_payload(event) {
        reject_workflow_transition(state, event, reason);
        return;
    }
    if !p.confidence.is_finite() || !(0.0..=1.0).contains(&p.confidence) {
        reject_workflow_transition(
            state,
            event,
            "review v2 confidence must be a finite value between zero and one".into(),
        );
        return;
    }
    if p.run_id != event.run_id.to_string() {
        reject_workflow_transition(
            state,
            event,
            "review v2 payload run_id does not match its event run_id".into(),
        );
        return;
    }
    ensure_workflow_instances(state);
    let key = match find_workflow_key_for_candidate(
        state,
        event,
        &p.candidate_digest,
        Some(&p.candidate_commit_sha),
    ) {
        Ok(key) => key,
        Err(reason) => {
            reject_workflow_transition(state, event, reason);
            return;
        }
    };
    let Some(workflow) = state.workflow_instances.get(&key) else {
        reject_workflow_transition(
            state,
            event,
            "review v2 has no prior dispatch envelope".into(),
        );
        return;
    };
    if !event_matches_workflow_run(workflow, event) {
        reject_workflow_transition(state, event, "review v2 belongs to a different run".into());
        return;
    }
    if workflow.phase.is_terminal() {
        reject_workflow_transition(
            state,
            event,
            "review v2 received after terminal workflow phase".into(),
        );
        return;
    }
    if !supports_sealed_action_evidence(workflow)
        || workflow.dispatch.trust_tier != TrustTierV1::Governed
    {
        reject_workflow_transition(
            state,
            event,
            "review v2 requires a governed sealed V3 candidate dispatch".into(),
        );
        return;
    }
    if workflow.workflow_id != p.workflow_id
        || workflow.unit_id != p.unit_id
        || workflow.attempt != p.attempt
        || workflow.dispatch.provenance_ref != p.provenance_ref
    {
        reject_workflow_transition(
            state,
            event,
            "review v2 candidate workflow identity does not match the immutable candidate".into(),
        );
        return;
    }
    let Some(candidate) = workflow.candidate.as_ref() else {
        reject_workflow_transition(state, event, "review v2 has no immutable candidate".into());
        return;
    };
    if p.candidate_digest != candidate.candidate_digest
        || p.candidate_commit_sha != candidate.candidate_commit_sha
        || p.candidate_envelope_digest != candidate.envelope_digest
    {
        reject_workflow_transition(
            state,
            event,
            "review v2 candidate digest, commit, or dispatch does not match immutable candidate lineage"
                .into(),
        );
        return;
    }
    if requires_candidate_completion(workflow) && workflow.candidate_completion.is_none() {
        reject_workflow_transition(
            state,
            event,
            "governed sealed_v3 candidate review requires closed candidate completion evidence"
                .into(),
        );
        return;
    }
    let Some(candidate_evidence) = workflow.action_evidence.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "review v2 candidate is missing its V3 action evidence projection".into(),
        );
        return;
    };
    let Some(candidate_set) = candidate_evidence.sealed_receipt_set.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "review v2 candidate is missing its exact sealed action receipt set".into(),
        );
        return;
    };
    if candidate.action_receipt_set_ref.as_deref()
        != Some(candidate_set.action_receipt_set_ref.as_str())
        || candidate.action_receipt_set_digest.as_deref()
            != Some(candidate_set.action_receipt_set_digest.as_str())
    {
        reject_workflow_transition(
            state,
            event,
            "review v2 candidate does not bind its sealed action receipt set".into(),
        );
        return;
    }
    let Some(acceptance) = workflow.acceptance.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "review v2 requires a passed deterministic acceptance record".into(),
        );
        return;
    };
    if acceptance.outcome != CandidateAcceptanceOutcomeV1::Passed
        || p.acceptance_ref != acceptance.acceptance_ref
        || p.acceptance_digest != acceptance.acceptance_digest
        || p.acceptance_contract_digest != acceptance.acceptance_contract_digest
    {
        reject_workflow_transition(
            state,
            event,
            "review v2 acceptance evidence does not prove the exact candidate passed".into(),
        );
        return;
    }
    if !matches!(
        workflow.phase,
        WorkflowPhaseV1::AcceptancePassed | WorkflowPhaseV1::ReviewApproved
    ) {
        let reason = format!("review v2 is not allowed from phase {:?}", workflow.phase);
        reject_workflow_transition(state, event, reason);
        return;
    }

    let reviewer_key = match find_v3_reviewer_workflow_for_review(state, event, p) {
        Ok(key) => key,
        Err(reason) => {
            reject_workflow_transition(state, event, reason);
            return;
        }
    };
    if reviewer_key == key {
        reject_workflow_transition(
            state,
            event,
            "review v2 reviewer dispatch must be independent from the candidate unit".into(),
        );
        return;
    }
    let Some(reviewer_workflow) = state.workflow_instances.get(&reviewer_key) else {
        unreachable!("reviewer V3 lookup returned an existing workflow key")
    };
    if reviewer_workflow.phase != WorkflowPhaseV1::Dispatched {
        reject_workflow_transition(
            state,
            event,
            "review v2 reviewer dispatch must remain an unpromotable review activity".into(),
        );
        return;
    }
    let expected_candidate_view_digest = match candidate_view_v1_digest(&p.candidate_view) {
        Ok(digest) => digest,
        Err(error) => {
            reject_workflow_transition(
                state,
                event,
                format!("review v2 candidate view cannot be canonicalized: {error}"),
            );
            return;
        }
    };
    if p.candidate_view_digest != expected_candidate_view_digest
        || p.candidate_view.candidate_ref != candidate.candidate_ref
        || p.candidate_view.candidate_digest != candidate.candidate_digest
        || p.candidate_view.candidate_commit_sha != candidate.candidate_commit_sha
        || p.candidate_view.tree_digest != candidate.tree_digest
        || p.candidate_view.reviewer_context_manifest_digest
            != reviewer_workflow.dispatch.context_manifest_digest
        || p.candidate_view.reviewer_sandbox_profile_digest
            != reviewer_workflow.dispatch.sandbox_profile_digest
        || !p.candidate_view.read_only
        || !p.candidate_view.network_disabled
    {
        reject_workflow_transition(
            state,
            event,
            "review v2 candidate view does not bind the immutable candidate and read-only reviewer sandbox"
                .into(),
        );
        return;
    }
    let Some(reviewer_evidence) = reviewer_workflow.action_evidence.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "review v2 reviewer dispatch is missing its action evidence projection".into(),
        );
        return;
    };
    let Some(reviewer_set) = reviewer_evidence.sealed_receipt_set.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "review v2 requires a sealed reviewer action receipt set".into(),
        );
        return;
    };
    if p.review_action_receipt_set_ref != reviewer_set.action_receipt_set_ref
        || p.review_action_receipt_set_digest != reviewer_set.action_receipt_set_digest
    {
        reject_workflow_transition(
            state,
            event,
            "review v2 does not bind the exact sealed reviewer action receipt set".into(),
        );
        return;
    }
    if !review_action_evidence_is_successful(reviewer_evidence) {
        reject_workflow_transition(
            state,
            event,
            "review v2 requires at least one succeeded reviewer action in the sealed set".into(),
        );
        return;
    }
    let Some(review_action) = reviewer_evidence.actions.get(&p.review_verdict_action_id) else {
        reject_workflow_transition(
            state,
            event,
            "review v2 verdict action is not part of the reviewer action evidence".into(),
        );
        return;
    };
    let Some(review_receipt) = review_action.receipt.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "review v2 verdict action has no terminal receipt".into(),
        );
        return;
    };
    let Some(sealed_review_receipt) = reviewer_set
        .receipts
        .iter()
        .find(|entry| entry.action_id == p.review_verdict_action_id)
    else {
        reject_workflow_transition(
            state,
            event,
            "review v2 verdict action is missing from the sealed reviewer receipt set".into(),
        );
        return;
    };
    if review_action.request.action_request_digest != p.review_action_request_digest
        || review_receipt.action_request_digest != p.review_action_request_digest
        || review_receipt.action_receipt_ref != p.review_action_receipt_ref
        || review_receipt.action_receipt_digest != p.review_action_receipt_digest
        || sealed_review_receipt.action_receipt_ref != p.review_action_receipt_ref
        || sealed_review_receipt.action_receipt_digest != p.review_action_receipt_digest
        || review_receipt.outcome != ActionReceiptOutcomeV2::Succeeded
        || review_action.request.action_kind != ActionKindV1::Model
        || review_receipt
            .authorization_ref
            .as_deref()
            .is_none_or(|authorization_ref| authorization_ref.trim().is_empty())
        || review_receipt.result_ref.as_deref() != Some(p.review_output_ref.as_str())
        || review_receipt.result_digest.as_deref() != Some(p.review_output_digest.as_str())
    {
        reject_workflow_transition(
            state,
            event,
            "review v2 verdict action receipt does not bind the closed review output".into(),
        );
        return;
    }
    // Sealed-v3 review actions carry the candidate proof twice: once in the
    // write-ahead model intent and again in the native authorization. The
    // verdict must not be allowed to retarget either proof at a different
    // accepted candidate after the reviewer action completed. Sealed-v2 tapes
    // predate that intent/authorization pair and remain readable unchanged.
    if requires_activity_claim_result(reviewer_workflow)
        && !sealed_v3_review_action_binds_verdict_target(review_action, candidate, p)
    {
        reject_workflow_transition(
            state,
            event,
            "sealed_v3 review verdict action intent and authorization must bind the exact target candidate and candidate view".into(),
        );
        return;
    }
    let expected_output_digest = match review_verdict_output_v1_digest(&ReviewVerdictOutputV1 {
        candidate_digest: p.candidate_digest.clone(),
        candidate_commit_sha: p.candidate_commit_sha.clone(),
        decision: p.decision,
        findings: p.findings.clone(),
        confidence: p.confidence,
        candidate_view_digest: p.candidate_view_digest.clone(),
    }) {
        Ok(digest) => digest,
        Err(error) => {
            reject_workflow_transition(
                state,
                event,
                format!("review v2 closed output cannot be canonicalized: {error}"),
            );
            return;
        }
    };
    if p.review_output_digest != expected_output_digest {
        reject_workflow_transition(
            state,
            event,
            "review v2 output digest does not match its closed verdict fields".into(),
        );
        return;
    }
    if let Some(existing) = workflow.reviews.get(&p.review_ref) {
        if review_v2_matches_existing(existing, event.id, p) {
            return;
        }
        reject_workflow_transition(
            state,
            event,
            "review_ref is already bound to a different verdict".into(),
        );
        return;
    }

    let workflow = state
        .workflow_instances
        .get_mut(&key)
        .expect("workflow was checked above");
    workflow.reviews.insert(
        p.review_ref.clone(),
        ReviewVerdictReplayState {
            review_version: 2,
            event_id: event.id,
            candidate_digest: p.candidate_digest.clone(),
            candidate_commit_sha: p.candidate_commit_sha.clone(),
            review_ref: p.review_ref.clone(),
            decision: p.decision,
            findings: p.findings.clone(),
            confidence: p.confidence,
            reviewer_manifest_digest: p.reviewer_manifest_digest.clone(),
            review_verdict_action_id: Some(p.review_verdict_action_id.clone()),
            review_action_request_digest: Some(p.review_action_request_digest.clone()),
            review_action_receipt_ref: Some(p.review_action_receipt_ref.clone()),
            review_action_receipt_digest: Some(p.review_action_receipt_digest.clone()),
            review_output_ref: Some(p.review_output_ref.clone()),
            review_output_digest: Some(p.review_output_digest.clone()),
            acceptance_ref: Some(p.acceptance_ref.clone()),
            acceptance_digest: Some(p.acceptance_digest.clone()),
            acceptance_contract_digest: Some(p.acceptance_contract_digest.clone()),
            candidate_envelope_digest: Some(p.candidate_envelope_digest.clone()),
            reviewer_workflow_id: Some(p.reviewer_workflow_id.clone()),
            reviewer_dispatch_envelope_digest: Some(p.reviewer_dispatch_envelope_digest.clone()),
            reviewer_unit_id: Some(p.reviewer_unit_id.clone()),
            reviewer_attempt: Some(p.reviewer_attempt),
            reviewer_execution_role: Some(p.reviewer_execution_role),
            review_action_receipt_set_ref: Some(p.review_action_receipt_set_ref.clone()),
            review_action_receipt_set_digest: Some(p.review_action_receipt_set_digest.clone()),
            candidate_view: Some(p.candidate_view.clone()),
            candidate_view_ref: Some(p.candidate_view_ref.clone()),
            candidate_view_digest: Some(p.candidate_view_digest.clone()),
            reviewer_authority: Some(p.reviewer_authority.clone()),
            reviewed_at: p.reviewed_at.clone(),
        },
    );
    workflow.phase = match p.decision {
        ReviewDecisionV1::Approve => WorkflowPhaseV1::ReviewApproved,
        ReviewDecisionV1::RequestChanges | ReviewDecisionV1::Reject | ReviewDecisionV1::Abstain => {
            WorkflowPhaseV1::Rejected
        }
    };
    sync_workflow_compatibility_view(state, &key);
}

/// Project a kernel-signed, candidate-bound operator approval work item. It
/// intentionally has no promotion effect: only a later operator-signed
/// decision may advance the workflow to `PromotionPending`.
fn apply_promotion_approval_requested(
    state: &mut ReplayState,
    event: &Event,
    p: &PromotionApprovalRequestedV1,
) {
    ensure_workflow_instances(state);
    let key = match find_workflow_key_for_candidate(state, event, &p.candidate_digest, None) {
        Ok(key) => key,
        Err(reason) => {
            reject_workflow_transition(state, event, reason);
            return;
        }
    };
    let Some(workflow) = state.workflow_instances.get(&key) else {
        reject_workflow_transition(
            state,
            event,
            "promotion approval request has no prior dispatch envelope".into(),
        );
        return;
    };
    if !event_matches_workflow_run(workflow, event) {
        reject_workflow_transition(
            state,
            event,
            "promotion approval request belongs to a different run".into(),
        );
        return;
    }
    if workflow.phase.is_terminal() {
        reject_workflow_transition(
            state,
            event,
            "promotion approval request received after terminal workflow phase".into(),
        );
        return;
    }
    let Some(candidate) = workflow.candidate.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "promotion approval request has no immutable candidate".into(),
        );
        return;
    };
    if p.candidate_digest != candidate.candidate_digest
        || p.base_commit_sha != candidate.base_commit_sha
        || p.envelope_digest != candidate.envelope_digest
    {
        reject_workflow_transition(
            state,
            event,
            "promotion approval request does not bind the immutable candidate lineage".into(),
        );
        return;
    }
    if requires_candidate_completion(workflow) && workflow.candidate_completion.is_none() {
        reject_workflow_transition(
            state,
            event,
            "governed sealed_v3 promotion approval requires closed candidate completion evidence"
                .into(),
        );
        return;
    }
    if !is_canonical_target_ref(&p.target_ref) {
        reject_workflow_transition(
            state,
            event,
            "promotion approval request target_ref must be a canonical refs/heads branch ref"
                .into(),
        );
        return;
    }
    if p.requested_by.trim().is_empty()
        || p.idempotency_key.trim().is_empty()
        || parse_rfc3339_utc(&p.requested_at).is_none()
    {
        reject_workflow_transition(
            state,
            event,
            "promotion approval request has an invalid requester, timestamp, or idempotency key"
                .into(),
        );
        return;
    }
    if let Some(existing) = workflow.promotion_approval.as_ref() {
        if promotion_approval_request_matches_existing(existing, event.id, p) {
            return;
        }
        reject_workflow_transition(
            state,
            event,
            "candidate already has a different promotion approval request".into(),
        );
        return;
    }
    let Some(acceptance) = workflow.acceptance.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "promotion approval request requires a passed deterministic acceptance record".into(),
        );
        return;
    };
    if acceptance.outcome != CandidateAcceptanceOutcomeV1::Passed
        || p.acceptance_ref != acceptance.acceptance_ref
    {
        reject_workflow_transition(
            state,
            event,
            "promotion approval request acceptance reference does not prove a passed candidate check"
                .into(),
        );
        return;
    }
    if workflow.phase != WorkflowPhaseV1::ReviewApproved
        || p.review_refs.is_empty()
        || !review_refs_are_approved(workflow, &p.review_refs)
    {
        reject_workflow_transition(
            state,
            event,
            "promotion approval request requires explicit approving review references".into(),
        );
        return;
    }

    let workflow = state
        .workflow_instances
        .get_mut(&key)
        .expect("workflow was checked above");
    workflow.promotion_approval = Some(PromotionApprovalRequestReplayState {
        event_id: event.id,
        candidate_digest: p.candidate_digest.clone(),
        base_commit_sha: p.base_commit_sha.clone(),
        target_ref: p.target_ref.clone(),
        envelope_digest: p.envelope_digest.clone(),
        acceptance_ref: p.acceptance_ref.clone(),
        review_refs: p.review_refs.clone(),
        requested_by: p.requested_by.clone(),
        requested_at: p.requested_at.clone(),
        idempotency_key: p.idempotency_key.clone(),
    });
    workflow.phase = WorkflowPhaseV1::PromotionApprovalPending;
    sync_workflow_compatibility_view(state, &key);
}

fn apply_promotion_decision(
    state: &mut ReplayState,
    event: &Event,
    p: &PromotionDecisionRecordedV1,
) {
    ensure_workflow_instances(state);
    let decision_event_digest = match canonical_event_hash(event) {
        Ok(digest) => digest,
        Err(error) => {
            reject_workflow_transition(
                state,
                event,
                format!("promotion decision canonical hash failed: {error}"),
            );
            return;
        }
    };
    let key = match find_workflow_key_for_candidate(state, event, &p.candidate_digest, None) {
        Ok(key) => key,
        Err(reason) => {
            reject_workflow_transition(state, event, reason);
            return;
        }
    };
    let Some(workflow) = state.workflow_instances.get(&key) else {
        reject_workflow_transition(
            state,
            event,
            "promotion decision has no prior dispatch envelope".into(),
        );
        return;
    };
    if !event_matches_workflow_run(workflow, event) {
        reject_workflow_transition(
            state,
            event,
            "promotion decision belongs to a different run".into(),
        );
        return;
    }
    if workflow.phase.is_terminal() {
        reject_workflow_transition(
            state,
            event,
            "promotion decision received after terminal workflow phase".into(),
        );
        return;
    }
    if workflow.cancellation.is_some() || workflow.phase == WorkflowPhaseV1::CancellationRequested {
        reject_workflow_transition(
            state,
            event,
            "promotion decision cannot be recorded after workflow cancellation".into(),
        );
        return;
    }
    let Some(candidate) = workflow.candidate.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "promotion decision has no immutable candidate".into(),
        );
        return;
    };
    if p.candidate_digest != candidate.candidate_digest
        || p.base_commit_sha != candidate.base_commit_sha
        || p.envelope_digest != candidate.envelope_digest
    {
        reject_workflow_transition(
            state,
            event,
            "promotion decision does not bind the immutable candidate lineage".into(),
        );
        return;
    }
    if requires_candidate_completion(workflow) && workflow.candidate_completion.is_none() {
        reject_workflow_transition(
            state,
            event,
            "governed sealed_v3 promotion decision requires closed candidate completion evidence"
                .into(),
        );
        return;
    }
    if requires_candidate_completion(workflow)
        && !p.target_ref.as_deref().is_some_and(is_canonical_target_ref)
    {
        // `target_ref: None` is a legacy compatibility encoding. A sealed-v3
        // candidate has closed activity evidence and therefore must never
        // inherit that historical promotion path.
        reject_workflow_transition(
            state,
            event,
            "sealed_v3 promotion decision requires a canonical target_ref".into(),
        );
        return;
    }
    if p.target_ref
        .as_deref()
        .is_some_and(|target_ref| !is_canonical_target_ref(target_ref))
    {
        reject_workflow_transition(
            state,
            event,
            "promotion decision target_ref must be a canonical refs/heads branch ref".into(),
        );
        return;
    }
    if let Some(existing) = workflow.promotion.as_ref() {
        if promotion_decision_matches_existing(
            &existing.decision,
            event.id,
            p,
            &decision_event_digest,
        ) {
            return;
        }
        reject_workflow_transition(
            state,
            event,
            "candidate already has a different promotion decision or idempotency key".into(),
        );
        return;
    }

    let has_promotion_approval = workflow.promotion_approval.is_some();
    if let Some(request) = workflow.promotion_approval.as_ref() {
        if workflow.phase != WorkflowPhaseV1::PromotionApprovalPending
            || !promotion_decision_binds_approval_request(p, request)
        {
            reject_workflow_transition(
                state,
                event,
                "promotion decision does not bind the exact durable promotion approval request"
                    .into(),
            );
            return;
        }
    } else if p.promotion_approval_request_ref.is_some() {
        reject_workflow_transition(
            state,
            event,
            "promotion decision references a promotion approval request that is not recorded"
                .into(),
        );
        return;
    }

    match p.decision {
        PromotionDecisionKindV1::Promote => {
            let Some(acceptance) = workflow.acceptance.as_ref() else {
                reject_workflow_transition(
                    state,
                    event,
                    "promotion requires a passed deterministic acceptance record".into(),
                );
                return;
            };
            if acceptance.outcome != CandidateAcceptanceOutcomeV1::Passed
                || p.acceptance_ref != acceptance.acceptance_ref
            {
                reject_workflow_transition(
                    state,
                    event,
                    "promotion acceptance reference does not prove a passed candidate check".into(),
                );
                return;
            }
            if (!has_promotion_approval && workflow.phase != WorkflowPhaseV1::ReviewApproved)
                || p.review_refs.is_empty()
                || !review_refs_are_approved(workflow, &p.review_refs)
            {
                reject_workflow_transition(
                    state,
                    event,
                    "promotion requires explicit approving review references".into(),
                );
                return;
            }
        }
        PromotionDecisionKindV1::Reject => {
            let Some(acceptance) = workflow.acceptance.as_ref() else {
                reject_workflow_transition(
                    state,
                    event,
                    "rejection decision requires candidate acceptance evidence".into(),
                );
                return;
            };
            if p.acceptance_ref != acceptance.acceptance_ref {
                reject_workflow_transition(
                    state,
                    event,
                    "rejection decision acceptance reference does not match candidate evidence"
                        .into(),
                );
                return;
            }
            if p.review_refs.is_empty() || !review_refs_exist(workflow, &p.review_refs) {
                reject_workflow_transition(
                    state,
                    event,
                    "rejection decision requires non-empty known review references".into(),
                );
                return;
            }
        }
    }

    let workflow = state
        .workflow_instances
        .get_mut(&key)
        .expect("workflow was checked above");
    workflow.promotion = Some(PromotionReplayState {
        decision: PromotionDecisionReplayState {
            event_id: event.id,
            event_digest: decision_event_digest,
            candidate_digest: p.candidate_digest.clone(),
            base_commit_sha: p.base_commit_sha.clone(),
            target_ref: p.target_ref.clone(),
            envelope_digest: p.envelope_digest.clone(),
            acceptance_ref: p.acceptance_ref.clone(),
            review_refs: p.review_refs.clone(),
            promotion_approval_request_ref: p.promotion_approval_request_ref.clone(),
            decision: p.decision,
            authority: p.authority.clone(),
            decided_by: p.decided_by.clone(),
            decided_at: p.decided_at.clone(),
            idempotency_key: p.idempotency_key.clone(),
        },
        execution_claim: None,
        result: None,
        reconciliation: None,
    });
    workflow.phase = match p.decision {
        PromotionDecisionKindV1::Promote => WorkflowPhaseV1::PromotionPending,
        PromotionDecisionKindV1::Reject => WorkflowPhaseV1::Rejected,
    };
    sync_workflow_compatibility_view(state, &key);
}

/// Project one kernel-signed, write-ahead claim for a sealed promotion. The
/// claim remains evidence only: replay never turns it into a usable effect
/// capability, lease renewal, or promotion operation.
fn apply_promotion_execution_claimed_v1(
    state: &mut ReplayState,
    event: &Event,
    p: &PromotionExecutionClaimedV1,
    signer: Option<&ActorKeyRef>,
) {
    ensure_workflow_instances(state);
    if p.run_id != event.run_id.to_string() {
        reject_workflow_transition(
            state,
            event,
            "promotion execution claim payload run_id does not match its event run_id".into(),
        );
        return;
    }
    if event.parent_event_id != Some(p.promotion_decision_event_ref) {
        reject_workflow_transition(
            state,
            event,
            "promotion execution claim parent_event_id must bind the exact promotion decision"
                .into(),
        );
        return;
    }
    let event_digest = match canonical_event_hash(event) {
        Ok(digest) => digest,
        Err(error) => {
            reject_workflow_transition(
                state,
                event,
                format!("promotion execution claim canonical hash failed: {error}"),
            );
            return;
        }
    };
    let expected_claim_digest = match promotion_execution_claimed_v1_digest(p) {
        Ok(digest) => digest,
        Err(error) => {
            reject_workflow_transition(
                state,
                event,
                format!("promotion execution claim payload canonicalization failed: {error}"),
            );
            return;
        }
    };
    if p.promotion_execution_claim_digest != expected_claim_digest {
        reject_workflow_transition(
            state,
            event,
            "promotion execution claim digest does not bind its immutable payload".into(),
        );
        return;
    }
    let Some(claimed_at) = parse_rfc3339_utc(&p.claimed_at) else {
        reject_workflow_transition(
            state,
            event,
            "promotion execution claim claimed_at must be an RFC3339 UTC timestamp".into(),
        );
        return;
    };
    let Some(lease_expires_at) = parse_rfc3339_utc(&p.lease_expires_at) else {
        reject_workflow_transition(
            state,
            event,
            "promotion execution claim lease_expires_at must be an RFC3339 UTC timestamp".into(),
        );
        return;
    };
    if claimed_at != event.occurred_at || lease_expires_at <= claimed_at {
        reject_workflow_transition(
            state,
            event,
            "promotion execution claim event time and lease interval are invalid".into(),
        );
        return;
    }
    let key = match find_workflow_key_for_candidate(
        state,
        event,
        &p.candidate_digest,
        Some(&p.candidate_commit_sha),
    ) {
        Ok(key) => key,
        Err(reason) => {
            reject_workflow_transition(state, event, reason);
            return;
        }
    };

    {
        let workflow = state
            .workflow_instances
            .get(&key)
            .expect("promotion claim workflow was found");
        if !event_matches_workflow_run(workflow, event) {
            reject_workflow_transition(
                state,
                event,
                "promotion execution claim belongs to a different run".into(),
            );
            return;
        }
        if !workflow_is_governed_atomic_sealed_v3(workflow)
            || !requires_candidate_completion(workflow)
        {
            reject_workflow_transition(
                state,
                event,
                "promotion execution claim requires a governed atomic sealed_v3 candidate transaction"
                    .into(),
            );
            return;
        }
        if workflow.phase != WorkflowPhaseV1::PromotionPending
            || workflow.cancellation.is_some()
            || workflow.terminal.is_some()
        {
            reject_workflow_transition(
                state,
                event,
                "promotion execution claim is allowed only for a pending uncancelled promotion"
                    .into(),
            );
            return;
        }
        let Some(candidate) = workflow.candidate.as_ref() else {
            reject_workflow_transition(
                state,
                event,
                "promotion execution claim has no immutable candidate".into(),
            );
            return;
        };
        let Some(promotion) = workflow.promotion.as_ref() else {
            reject_workflow_transition(
                state,
                event,
                "promotion execution claim has no recorded promotion decision".into(),
            );
            return;
        };
        let decision = &promotion.decision;
        let Some(target_ref) = decision.target_ref.as_deref() else {
            reject_workflow_transition(
                state,
                event,
                "promotion execution claim requires a target-bound promotion decision".into(),
            );
            return;
        };
        if decision.decision != PromotionDecisionKindV1::Promote
            || p.promotion_decision_event_ref != decision.event_id
            || p.promotion_decision_event_digest != decision.event_digest
            || p.dispatch_event_ref != workflow.dispatch.event_id
            || p.dispatch_envelope_digest != workflow.dispatch.envelope_digest
            || p.candidate_digest != candidate.candidate_digest
            || p.candidate_ref != candidate.candidate_ref
            || p.candidate_commit_sha != candidate.candidate_commit_sha
            || p.candidate_tree_digest != candidate.tree_digest
            || p.base_commit_sha != candidate.base_commit_sha
            || p.base_commit_sha != decision.base_commit_sha
            || p.base_commit_sha != workflow.dispatch.base_commit_sha
            || p.target_ref != target_ref
            || p.idempotency_key != decision.idempotency_key
            || !is_canonical_target_ref(&p.target_ref)
        {
            reject_workflow_transition(
                state,
                event,
                "promotion execution claim does not bind the exact sealed decision, dispatch, candidate, and target facts"
                    .into(),
            );
            return;
        }
        let Some(dispatch_expires_at) = parse_rfc3339_utc(&workflow.dispatch.expires_at) else {
            reject_workflow_transition(
                state,
                event,
                "promotion execution claim dispatch expiry is not an RFC3339 UTC timestamp".into(),
            );
            return;
        };
        if claimed_at >= dispatch_expires_at || lease_expires_at > dispatch_expires_at {
            reject_workflow_transition(
                state,
                event,
                "promotion execution claim must remain within the signed dispatch authority window"
                    .into(),
            );
            return;
        }
        if let Some(signer) = signer {
            if p.authority_actor != signer.actor_id {
                reject_workflow_transition(
                    state,
                    event,
                    "promotion execution claim authority_actor does not match its kernel signer"
                        .into(),
                );
                return;
            }
        }
        if let Some(existing) = promotion.execution_claim.as_ref() {
            if promotion_execution_claim_matches_existing(existing, event.id, p, &event_digest) {
                return;
            }
            reject_workflow_transition(
                state,
                event,
                "promotion decision already has a different immutable execution claim".into(),
            );
            return;
        }
    }

    let workflow = state
        .workflow_instances
        .get_mut(&key)
        .expect("promotion claim workflow was checked");
    let promotion = workflow
        .promotion
        .as_mut()
        .expect("promotion decision was checked");
    promotion.execution_claim = Some(PromotionExecutionClaimReplayState {
        event_id: event.id,
        event_digest,
        claim: p.clone(),
    });
    sync_workflow_compatibility_view(state, &key);
}

fn apply_promotion_result(state: &mut ReplayState, event: &Event, p: &PromotionResultRecordedV1) {
    ensure_workflow_instances(state);
    let result_event_digest = match canonical_event_hash(event) {
        Ok(digest) => digest,
        Err(error) => {
            reject_workflow_transition(
                state,
                event,
                format!("promotion result canonical hash failed: {error}"),
            );
            return;
        }
    };
    let key = match find_workflow_key_for_candidate(state, event, &p.candidate_digest, None) {
        Ok(key) => key,
        Err(reason) => {
            reject_workflow_transition(state, event, reason);
            return;
        }
    };
    let Some(workflow) = state.workflow_instances.get(&key) else {
        reject_workflow_transition(
            state,
            event,
            "promotion result has no prior dispatch envelope".into(),
        );
        return;
    };
    if !event_matches_workflow_run(workflow, event) {
        reject_workflow_transition(
            state,
            event,
            "promotion result belongs to a different run".into(),
        );
        return;
    }
    let Some(promotion) = workflow.promotion.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "promotion result has no recorded promotion decision".into(),
        );
        return;
    };
    if p.promotion_decision_ref != promotion.decision.event_id.to_string() {
        reject_workflow_transition(
            state,
            event,
            "promotion result does not reference the exact recorded promotion decision event"
                .into(),
        );
        return;
    }
    if let Some(existing) = promotion.result.as_ref() {
        if promotion_result_matches_existing(existing, event.id, p, &result_event_digest) {
            return;
        }
        reject_workflow_transition(
            state,
            event,
            "promotion decision already has a different recorded result".into(),
        );
        return;
    }
    if workflow.terminal.is_some() {
        reject_workflow_transition(
            state,
            event,
            "promotion result received after terminal workflow record".into(),
        );
        return;
    }
    if p.candidate_digest != promotion.decision.candidate_digest
        || p.idempotency_key != promotion.decision.idempotency_key
    {
        reject_workflow_transition(
            state,
            event,
            "promotion result candidate digest or idempotency key does not match its decision"
                .into(),
        );
        return;
    }
    match promotion.execution_claim.as_ref() {
        Some(claim) => {
            let Some(binding) = p.promotion_execution_lease_binding.as_ref() else {
                reject_workflow_transition(
                    state,
                    event,
                    "promotion result after an execution claim must bind the exact immutable execution claim"
                        .into(),
                );
                return;
            };
            if binding.promotion_execution_claim_event_ref != claim.event_id
                || binding.promotion_execution_claim_event_digest != claim.event_digest
                || binding.lease_id != claim.claim.lease_id
            {
                reject_workflow_transition(
                    state,
                    event,
                    "promotion result does not bind the exact immutable execution claim".into(),
                );
                return;
            }
        }
        None if p.promotion_execution_lease_binding.is_some() => {
            reject_workflow_transition(
                state,
                event,
                "promotion result references an execution claim that replay did not project".into(),
            );
            return;
        }
        None => {}
    }
    if !promotion_result_is_semantically_valid(workflow, promotion, p) {
        reject_workflow_transition(
            state,
            event,
            "promotion result outcome is incompatible with its decision".into(),
        );
        return;
    }

    let resulting_phase = match p.outcome {
        PromotionResultOutcomeV1::Promoted => WorkflowPhaseV1::Promoted,
        PromotionResultOutcomeV1::ReconciliationRequired => {
            WorkflowPhaseV1::PromotionReconciliationRequired
        }
        PromotionResultOutcomeV1::Rejected => WorkflowPhaseV1::Rejected,
    };
    let workflow = state
        .workflow_instances
        .get_mut(&key)
        .expect("workflow was checked above");
    let promotion = workflow
        .promotion
        .as_mut()
        .expect("promotion was checked above");
    promotion.result = Some(PromotionResultReplayState {
        event_id: event.id,
        event_digest: result_event_digest,
        candidate_digest: p.candidate_digest.clone(),
        idempotency_key: p.idempotency_key.clone(),
        promotion_decision_ref: p.promotion_decision_ref.clone(),
        outcome: p.outcome,
        merged_head_sha: p.merged_head_sha.clone(),
        promotion_git_binding: p.promotion_git_binding.clone(),
        promotion_execution_lease_binding: p.promotion_execution_lease_binding.clone(),
        completed_at: p.completed_at.clone(),
    });
    workflow.phase = resulting_phase;
    sync_workflow_compatibility_view(state, &key);
}

fn apply_promotion_reconciliation_resolved(
    state: &mut ReplayState,
    event: &Event,
    p: &PromotionReconciliationResolvedV1,
) {
    ensure_workflow_instances(state);
    let reconciliation_event_digest = match canonical_event_hash(event) {
        Ok(digest) => digest,
        Err(error) => {
            reject_workflow_transition(
                state,
                event,
                format!("promotion reconciliation canonical hash failed: {error}"),
            );
            return;
        }
    };
    let key = match find_workflow_key_for_candidate(state, event, &p.candidate_digest, None) {
        Ok(key) => key,
        Err(reason) => {
            reject_workflow_transition(state, event, reason);
            return;
        }
    };
    let Some(workflow) = state.workflow_instances.get(&key) else {
        reject_workflow_transition(
            state,
            event,
            "promotion reconciliation resolution has no prior dispatch envelope".into(),
        );
        return;
    };
    if !event_matches_workflow_run(workflow, event) {
        reject_workflow_transition(
            state,
            event,
            "promotion reconciliation resolution belongs to a different run".into(),
        );
        return;
    }
    let Some(promotion) = workflow.promotion.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "promotion reconciliation resolution has no recorded promotion decision".into(),
        );
        return;
    };
    if let Some(existing) = promotion.reconciliation.as_ref() {
        if promotion_reconciliation_matches_existing(
            existing,
            event.id,
            p,
            &reconciliation_event_digest,
        ) {
            return;
        }
        reject_workflow_transition(
            state,
            event,
            "promotion result already has a different recorded reconciliation resolution".into(),
        );
        return;
    }
    if workflow.terminal.is_some() {
        reject_workflow_transition(
            state,
            event,
            "promotion reconciliation resolution received after terminal workflow record".into(),
        );
        return;
    }
    let Some(result) = promotion.result.as_ref() else {
        reject_workflow_transition(
            state,
            event,
            "promotion reconciliation resolution has no recorded promotion result".into(),
        );
        return;
    };
    if workflow.phase != WorkflowPhaseV1::PromotionReconciliationRequired
        || result.outcome != PromotionResultOutcomeV1::ReconciliationRequired
    {
        reject_workflow_transition(
            state,
            event,
            "promotion reconciliation resolution requires a target-advanced promotion result"
                .into(),
        );
        return;
    }
    if p.candidate_digest != promotion.decision.candidate_digest
        || p.candidate_digest != result.candidate_digest
        || p.promotion_decision_ref != promotion.decision.event_id.to_string()
        || p.promotion_result_ref != result.event_id.to_string()
    {
        reject_workflow_transition(
            state,
            event,
            "promotion reconciliation resolution does not bind the exact recorded decision and result"
                .into(),
        );
        return;
    }
    let expected_receipt_ref = result
        .promotion_git_binding
        .as_ref()
        .and_then(|binding| binding.promotion_receipt_ref.as_deref());
    if expected_receipt_ref != Some(p.promotion_receipt_ref.as_str()) {
        reject_workflow_transition(
            state,
            event,
            "promotion reconciliation resolution does not bind the exact recorded promotion receipt"
                .into(),
        );
        return;
    }
    if !promotion_reconciliation_is_semantically_valid(p) {
        reject_workflow_transition(
            state,
            event,
            "promotion reconciliation resolution lacks a valid operator authority binding".into(),
        );
        return;
    }

    let workflow = state
        .workflow_instances
        .get_mut(&key)
        .expect("workflow was checked above");
    let promotion = workflow
        .promotion
        .as_mut()
        .expect("promotion was checked above");
    promotion.reconciliation = Some(PromotionReconciliationReplayState {
        event_id: event.id,
        event_digest: reconciliation_event_digest,
        candidate_digest: p.candidate_digest.clone(),
        promotion_decision_ref: p.promotion_decision_ref.clone(),
        promotion_result_ref: p.promotion_result_ref.clone(),
        promotion_receipt_ref: p.promotion_receipt_ref.clone(),
        outcome: p.outcome,
        authority: p.authority.clone(),
        resolved_by: p.resolved_by.clone(),
        idempotency_key: p.idempotency_key.clone(),
        resolved_at: p.resolved_at.clone(),
    });
    workflow.phase = WorkflowPhaseV1::PromotionReconciliationResolved;
    sync_workflow_compatibility_view(state, &key);
}

/// Workflow deadlines are control records, so they may only be created or
/// fired before a cancellation, terminal state, or promotion/reconciliation
/// state that must instead be resolved through the promotion protocol.
fn workflow_lifecycle_control_is_allowed(workflow: &WorkflowInstanceV1) -> bool {
    !workflow.phase.is_terminal()
        && workflow.cancellation.is_none()
        && !matches!(
            workflow.phase,
            WorkflowPhaseV1::PromotionApprovalPending
                | WorkflowPhaseV1::PromotionPending
                | WorkflowPhaseV1::PromotionReconciliationRequired
                | WorkflowPhaseV1::PromotionReconciliationResolved
                | WorkflowPhaseV1::Promoted
        )
}

/// A cancellation stops new authority immediately, but it must not erase the
/// evidence needed to reconcile an effect that was already claimed. A V2
/// terminal cancellation is therefore blocked until every started effect has
/// a known terminal activity result and its matching immutable receipt. An
/// unclaimed request never received a lease and is safe to abandon.
fn cancellation_effects_are_reconciled(workflow: &WorkflowInstanceV1) -> bool {
    workflow.action_evidence.as_ref().is_none_or(|evidence| {
        evidence.actions.values().all(|action| {
            let Some(claim) = action.activity_claim.as_ref() else {
                return true;
            };
            let Some(result) = claim.result.as_ref() else {
                return false;
            };
            result.outcome != ActivityResultOutcomeV1::Unknown && action.receipt.is_some()
        })
    })
}

/// Lifecycle controls are new authority-bearing records. They deliberately do
/// not retrofit trust onto historical or preview dispatches: a timer or
/// cancellation must be bound to the same governed, atomic, sealed-v3 action
/// plane that it is allowed to stop.
fn workflow_is_governed_atomic_sealed_v3(workflow: &WorkflowInstanceV1) -> bool {
    workflow_supports_native_activity_claim(workflow) && requires_activity_claim_result(workflow)
}

fn apply_workflow_timer_scheduled_v1(
    state: &mut ReplayState,
    event: &Event,
    p: &WorkflowTimerScheduledV1,
) {
    if let Err(reason) = validate_v3_event_payload(event) {
        reject_workflow_transition(state, event, reason);
        return;
    }
    let key = match find_workflow_key_for_lifecycle(
        state,
        event,
        &p.run_id,
        &p.workflow_id,
        &p.workflow_revision,
        &p.unit_id,
        p.attempt,
        p.dispatch_event_ref,
        &p.dispatch_envelope_digest,
    ) {
        Ok(key) => key,
        Err(reason) => {
            reject_workflow_transition(state, event, reason);
            return;
        }
    };
    let Some(workflow) = state.workflow_instances.get(&key) else {
        unreachable!("lifecycle lookup returned an existing workflow")
    };
    if !workflow_lifecycle_control_is_allowed(workflow) {
        reject_workflow_transition(
            state,
            event,
            "workflow timer cannot be scheduled after cancellation, terminalization, or promotion control begins".into(),
        );
        return;
    }
    let Some(scheduled_at) = parse_rfc3339_utc(&p.scheduled_at) else {
        reject_workflow_transition(
            state,
            event,
            "workflow timer scheduled_at must be an RFC3339 UTC timestamp".into(),
        );
        return;
    };
    let Some(due_at) = parse_rfc3339_utc(&p.due_at) else {
        reject_workflow_transition(
            state,
            event,
            "workflow timer due_at must be an RFC3339 UTC timestamp".into(),
        );
        return;
    };
    let Some(dispatch_issued_at) = parse_rfc3339_utc(&workflow.dispatch.issued_at) else {
        reject_workflow_transition(
            state,
            event,
            "workflow dispatch issued_at is invalid".into(),
        );
        return;
    };
    let Some(dispatch_expires_at) = parse_rfc3339_utc(&workflow.dispatch.expires_at) else {
        reject_workflow_transition(
            state,
            event,
            "workflow dispatch expires_at is invalid".into(),
        );
        return;
    };
    if event.parent_event_id != Some(workflow.dispatch.event_id)
        || scheduled_at != event.occurred_at
        || scheduled_at < dispatch_issued_at
        || due_at <= scheduled_at
        || due_at > dispatch_expires_at
    {
        reject_workflow_transition(
            state,
            event,
            "workflow timer must parent to its dispatch, bind scheduled_at to the event, and remain inside dispatch authority".into(),
        );
        return;
    }
    let timer_event_digest = match canonical_event_hash(event) {
        Ok(digest) => digest,
        Err(error) => {
            reject_workflow_transition(
                state,
                event,
                format!("could not canonicalize workflow timer schedule: {error}"),
            );
            return;
        }
    };
    if let Some(existing) = workflow.timers.get(&p.timer_id) {
        if workflow_timer_schedule_matches_existing(existing, event, p, &timer_event_digest) {
            return;
        }
        reject_workflow_transition(
            state,
            event,
            "workflow timer id cannot replace an immutable schedule".into(),
        );
        return;
    }
    let workflow = state
        .workflow_instances
        .get_mut(&key)
        .expect("workflow timer schedule was checked");
    workflow.timers.insert(
        p.timer_id.clone(),
        WorkflowTimerReplayState {
            event_id: event.id,
            event_digest: timer_event_digest,
            run_id: p.run_id.clone(),
            workflow_id: p.workflow_id.clone(),
            workflow_revision: p.workflow_revision.clone(),
            unit_id: p.unit_id.clone(),
            attempt: p.attempt,
            dispatch_event_ref: p.dispatch_event_ref,
            dispatch_envelope_digest: p.dispatch_envelope_digest.clone(),
            timer_id: p.timer_id.clone(),
            timer_kind: p.timer_kind,
            due_at: p.due_at.clone(),
            idempotency_key: p.idempotency_key.clone(),
            scheduled_by: p.scheduled_by.clone(),
            scheduled_at: p.scheduled_at.clone(),
            fired: None,
        },
    );
    sync_workflow_compatibility_view(state, &key);
}

fn apply_workflow_timer_fired_v1(state: &mut ReplayState, event: &Event, p: &WorkflowTimerFiredV1) {
    if let Err(reason) = validate_v3_event_payload(event) {
        reject_workflow_transition(state, event, reason);
        return;
    }
    let key = match find_workflow_key_for_lifecycle(
        state,
        event,
        &p.run_id,
        &p.workflow_id,
        &p.workflow_revision,
        &p.unit_id,
        p.attempt,
        p.dispatch_event_ref,
        &p.dispatch_envelope_digest,
    ) {
        Ok(key) => key,
        Err(reason) => {
            reject_workflow_transition(state, event, reason);
            return;
        }
    };
    let Some(workflow) = state.workflow_instances.get(&key) else {
        unreachable!("lifecycle lookup returned an existing workflow")
    };
    if !workflow_lifecycle_control_is_allowed(workflow) {
        reject_workflow_transition(
            state,
            event,
            "workflow timer cannot fire after cancellation, terminalization, or promotion control begins".into(),
        );
        return;
    }
    let Some(timer) = workflow.timers.get(&p.timer_id) else {
        reject_workflow_transition(
            state,
            event,
            "workflow timer fired without a prior schedule".into(),
        );
        return;
    };
    let Some(fired_at) = parse_rfc3339_utc(&p.fired_at) else {
        reject_workflow_transition(
            state,
            event,
            "workflow timer fired_at must be an RFC3339 UTC timestamp".into(),
        );
        return;
    };
    let Some(due_at) = parse_rfc3339_utc(&timer.due_at) else {
        reject_workflow_transition(
            state,
            event,
            "projected workflow timer due_at is invalid".into(),
        );
        return;
    };
    if event.parent_event_id != Some(timer.event_id)
        || p.timer_schedule_event_ref != timer.event_id
        || p.timer_schedule_event_digest != timer.event_digest
        || p.run_id != timer.run_id
        || p.workflow_id != timer.workflow_id
        || p.workflow_revision != timer.workflow_revision
        || p.unit_id != timer.unit_id
        || p.attempt != timer.attempt
        || p.timer_id != timer.timer_id
        || p.dispatch_event_ref != timer.dispatch_event_ref
        || p.dispatch_envelope_digest != timer.dispatch_envelope_digest
        || p.idempotency_key != timer.idempotency_key
        || fired_at != event.occurred_at
        || fired_at < due_at
    {
        reject_workflow_transition(
            state,
            event,
            "workflow timer firing must bind the exact schedule, occur no earlier than due_at, and parent to that schedule".into(),
        );
        return;
    }
    let fired_event_digest = match canonical_event_hash(event) {
        Ok(digest) => digest,
        Err(error) => {
            reject_workflow_transition(
                state,
                event,
                format!("could not canonicalize workflow timer firing: {error}"),
            );
            return;
        }
    };
    if let Some(existing) = timer.fired.as_ref() {
        if workflow_timer_fired_matches_existing(existing, event, p, &fired_event_digest) {
            return;
        }
        reject_workflow_transition(
            state,
            event,
            "workflow timer cannot replace an immutable firing record".into(),
        );
        return;
    }
    let workflow = state
        .workflow_instances
        .get_mut(&key)
        .expect("workflow timer firing was checked");
    let timer = workflow
        .timers
        .get_mut(&p.timer_id)
        .expect("timer firing has a matching timer");
    timer.fired = Some(WorkflowTimerFiredReplayState {
        event_id: event.id,
        event_digest: fired_event_digest,
        timer_schedule_event_ref: p.timer_schedule_event_ref,
        timer_schedule_event_digest: p.timer_schedule_event_digest.clone(),
        fired_by: p.fired_by.clone(),
        fired_at: p.fired_at.clone(),
    });
    sync_workflow_compatibility_view(state, &key);
}

fn apply_workflow_cancellation_requested_v1(
    state: &mut ReplayState,
    event: &Event,
    p: &WorkflowCancellationRequestedV1,
) {
    if let Err(reason) = validate_v3_event_payload(event) {
        reject_workflow_transition(state, event, reason);
        return;
    }
    let key = match find_workflow_key_for_lifecycle(
        state,
        event,
        &p.run_id,
        &p.workflow_id,
        &p.workflow_revision,
        &p.unit_id,
        p.attempt,
        p.dispatch_event_ref,
        &p.dispatch_envelope_digest,
    ) {
        Ok(key) => key,
        Err(reason) => {
            reject_workflow_transition(state, event, reason);
            return;
        }
    };
    let Some(workflow) = state.workflow_instances.get(&key) else {
        unreachable!("lifecycle lookup returned an existing workflow")
    };
    if !workflow_lifecycle_control_is_allowed(workflow) {
        reject_workflow_transition(
            state,
            event,
            "workflow cancellation cannot bypass terminal, promotion-pending, or reconciliation state".into(),
        );
        return;
    }
    let Some(requested_at) = parse_rfc3339_utc(&p.requested_at) else {
        reject_workflow_transition(
            state,
            event,
            "workflow cancellation requested_at must be an RFC3339 UTC timestamp".into(),
        );
        return;
    };
    if requested_at != event.occurred_at {
        reject_workflow_transition(
            state,
            event,
            "workflow cancellation requested_at must equal its signed event occurred_at".into(),
        );
        return;
    }
    let timer_evidence_is_valid = match p.cause {
        WorkflowCancellationCauseV1::OperatorRequested => {
            event.parent_event_id == Some(workflow.dispatch.event_id)
        }
        WorkflowCancellationCauseV1::TimerElapsed => {
            match (
                p.timer_fired_event_ref,
                p.timer_fired_event_digest.as_deref(),
            ) {
                (Some(timer_event_ref), Some(timer_event_digest)) => {
                    workflow.timers.values().any(|timer| {
                        timer.fired.as_ref().is_some_and(|fired| {
                            event.parent_event_id == Some(fired.event_id)
                                && fired.event_id == timer_event_ref
                                && fired.event_digest == timer_event_digest
                                && parse_rfc3339_utc(&fired.fired_at)
                                    .is_some_and(|fired_at| requested_at >= fired_at)
                        })
                    })
                }
                _ => false,
            }
        }
    };
    if !timer_evidence_is_valid {
        reject_workflow_transition(
            state,
            event,
            "workflow cancellation must parent to its dispatch or exact elapsed timer evidence"
                .into(),
        );
        return;
    }
    let cancellation_event_digest = match canonical_event_hash(event) {
        Ok(digest) => digest,
        Err(error) => {
            reject_workflow_transition(
                state,
                event,
                format!("could not canonicalize workflow cancellation: {error}"),
            );
            return;
        }
    };
    if let Some(existing) = workflow.cancellation.as_ref() {
        if workflow_cancellation_matches_existing(existing, event, p, &cancellation_event_digest) {
            return;
        }
        reject_workflow_transition(
            state,
            event,
            "workflow already has an immutable cancellation request".into(),
        );
        return;
    }
    let workflow = state
        .workflow_instances
        .get_mut(&key)
        .expect("workflow cancellation was checked");
    workflow.cancellation = Some(WorkflowCancellationReplayState {
        event_id: event.id,
        event_digest: cancellation_event_digest,
        cancellation_id: p.cancellation_id.clone(),
        cause: p.cause,
        timer_fired_event_ref: p.timer_fired_event_ref,
        timer_fired_event_digest: p.timer_fired_event_digest.clone(),
        requested_by: p.requested_by.clone(),
        idempotency_key: p.idempotency_key.clone(),
        requested_at: p.requested_at.clone(),
    });
    workflow.phase = WorkflowPhaseV1::CancellationRequested;
    sync_workflow_compatibility_view(state, &key);
}

#[derive(Clone)]
struct WorkflowTerminalFields {
    workflow_id: String,
    workflow_revision: String,
    unit_id: String,
    attempt: u32,
    outcome: WorkflowTerminalOutcomeV1,
    candidate_digest: Option<String>,
    promotion_result_ref: Option<String>,
    reconciliation_resolution_ref: Option<String>,
    cancellation_request_event_ref: Option<EventId>,
    cancellation_request_event_digest: Option<String>,
    reason: Option<String>,
    idempotency_key: String,
    completed_at: String,
}

impl From<&WorkflowTerminalV1> for WorkflowTerminalFields {
    fn from(value: &WorkflowTerminalV1) -> Self {
        Self {
            workflow_id: value.workflow_id.clone(),
            workflow_revision: value.workflow_revision.clone(),
            unit_id: value.unit_id.clone(),
            attempt: value.attempt,
            outcome: value.outcome,
            candidate_digest: value.candidate_digest.clone(),
            promotion_result_ref: value.promotion_result_ref.clone(),
            reconciliation_resolution_ref: value.reconciliation_resolution_ref.clone(),
            cancellation_request_event_ref: None,
            cancellation_request_event_digest: None,
            reason: value.reason.clone(),
            idempotency_key: value.idempotency_key.clone(),
            completed_at: value.completed_at.clone(),
        }
    }
}

impl From<&WorkflowTerminalV2> for WorkflowTerminalFields {
    fn from(value: &WorkflowTerminalV2) -> Self {
        Self {
            workflow_id: value.workflow_id.clone(),
            workflow_revision: value.workflow_revision.clone(),
            unit_id: value.unit_id.clone(),
            attempt: value.attempt,
            outcome: value.outcome,
            candidate_digest: value.candidate_digest.clone(),
            promotion_result_ref: value.promotion_result_ref.clone(),
            reconciliation_resolution_ref: value.reconciliation_resolution_ref.clone(),
            cancellation_request_event_ref: value.cancellation_request_event_ref,
            cancellation_request_event_digest: value.cancellation_request_event_digest.clone(),
            reason: value.reason.clone(),
            idempotency_key: value.idempotency_key.clone(),
            completed_at: value.completed_at.clone(),
        }
    }
}

fn apply_workflow_terminal(state: &mut ReplayState, event: &Event, p: &WorkflowTerminalV1) {
    apply_workflow_terminal_record(state, event, &WorkflowTerminalFields::from(p), 1);
}

fn apply_workflow_terminal_v2(state: &mut ReplayState, event: &Event, p: &WorkflowTerminalV2) {
    if let Err(reason) = validate_v3_event_payload(event) {
        reject_workflow_transition(state, event, reason);
        return;
    }
    apply_workflow_terminal_record(state, event, &WorkflowTerminalFields::from(p), 2);
}

fn apply_workflow_terminal_record(
    state: &mut ReplayState,
    event: &Event,
    terminal: &WorkflowTerminalFields,
    terminal_version: u8,
) {
    ensure_workflow_instances(state);
    let key = match find_workflow_key_for_terminal(state, event, terminal) {
        Ok(key) => key,
        Err(reason) => {
            reject_workflow_transition(state, event, reason);
            return;
        }
    };
    let Some(workflow) = state.workflow_instances.get(&key) else {
        reject_workflow_transition(
            state,
            event,
            "workflow terminal has no prior dispatch envelope".into(),
        );
        return;
    };
    if !event_matches_workflow_run(workflow, event) {
        reject_workflow_transition(
            state,
            event,
            "workflow terminal belongs to a different run".into(),
        );
        return;
    }
    if terminal_version == 2 && !workflow_is_governed_atomic_sealed_v3(workflow) {
        reject_workflow_transition(
            state,
            event,
            "workflow_terminal_v2 requires a governed atomic sealed_v3 dispatch envelope".into(),
        );
        return;
    }
    if let Some(existing) = workflow.terminal.as_ref() {
        if workflow_terminal_matches_existing(existing, terminal, terminal_version) {
            return;
        }
        reject_workflow_transition(
            state,
            event,
            "workflow already has a terminal record".into(),
        );
        return;
    }
    if workflow.phase.is_terminal() {
        reject_workflow_transition(
            state,
            event,
            "workflow terminal received after a terminal workflow phase".into(),
        );
        return;
    }
    if terminal_version == 1 && workflow.cancellation.is_some() {
        reject_workflow_transition(
            state,
            event,
            "workflow_terminal_v1 cannot close a newly requested cancellation; use workflow_terminal_v2"
                .into(),
        );
        return;
    }
    if terminal_version == 2 && parse_rfc3339_utc(&terminal.completed_at) != Some(event.occurred_at)
    {
        reject_workflow_transition(
            state,
            event,
            "workflow_terminal_v2 completed_at must equal its signed event occurred_at".into(),
        );
        return;
    }
    if terminal.workflow_id != workflow.workflow_id
        || terminal.workflow_revision != workflow.workflow_revision
        || terminal.unit_id != workflow.unit_id
        || terminal.attempt != workflow.attempt
    {
        reject_workflow_transition(
            state,
            event,
            "terminal workflow identity does not match dispatch".into(),
        );
        return;
    }
    if let Some(candidate) = workflow.candidate.as_ref() {
        if terminal.candidate_digest.as_deref() != Some(candidate.candidate_digest.as_str()) {
            reject_workflow_transition(
                state,
                event,
                "terminal candidate digest does not match the immutable candidate".into(),
            );
            return;
        }
    } else if terminal.candidate_digest.is_some() {
        reject_workflow_transition(
            state,
            event,
            "terminal candidate digest exists without an immutable candidate".into(),
        );
        return;
    }
    if let Some(result) = workflow
        .promotion
        .as_ref()
        .and_then(|promotion| promotion.result.as_ref())
    {
        let expected_result_ref = result.event_id.to_string();
        if terminal.promotion_result_ref.as_deref() != Some(expected_result_ref.as_str()) {
            reject_workflow_transition(
                state,
                event,
                "terminal workflow record does not reference the exact recorded promotion result event"
                    .into(),
            );
            return;
        }
    } else if terminal.promotion_result_ref.is_some() {
        reject_workflow_transition(
            state,
            event,
            "terminal workflow record references a promotion result that is not projected".into(),
        );
        return;
    }
    if let Some(resolution) = workflow
        .promotion
        .as_ref()
        .and_then(|promotion| promotion.reconciliation.as_ref())
    {
        let expected_resolution_ref = resolution.event_id.to_string();
        if terminal.reconciliation_resolution_ref.as_deref()
            != Some(expected_resolution_ref.as_str())
        {
            reject_workflow_transition(
                state,
                event,
                "terminal workflow record does not reference the exact recorded reconciliation resolution event"
                    .into(),
            );
            return;
        }
    } else if terminal.reconciliation_resolution_ref.is_some() {
        reject_workflow_transition(
            state,
            event,
            "terminal workflow record references a reconciliation resolution that is not projected"
                .into(),
        );
        return;
    }
    if !workflow_terminal_is_semantically_valid(workflow, terminal, terminal_version, event) {
        reject_workflow_transition(
            state,
            event,
            "terminal outcome does not match the recorded promotion or cancellation state".into(),
        );
        return;
    }
    let terminal_event_digest = match canonical_event_hash(event) {
        Ok(digest) => digest,
        Err(error) => {
            reject_workflow_transition(
                state,
                event,
                format!("could not canonicalize terminal workflow event: {error}"),
            );
            return;
        }
    };

    let phase = match terminal.outcome {
        WorkflowTerminalOutcomeV1::Completed => WorkflowPhaseV1::Completed,
        WorkflowTerminalOutcomeV1::Failed => WorkflowPhaseV1::Failed,
        WorkflowTerminalOutcomeV1::Cancelled => WorkflowPhaseV1::Cancelled,
    };
    let workflow = state
        .workflow_instances
        .get_mut(&key)
        .expect("workflow was checked above");
    workflow.terminal = Some(WorkflowTerminalReplayState {
        event_id: event.id,
        terminal_version,
        event_digest: terminal_event_digest,
        unit_id: terminal.unit_id.clone(),
        attempt: terminal.attempt,
        outcome: terminal.outcome,
        candidate_digest: terminal.candidate_digest.clone(),
        promotion_result_ref: terminal.promotion_result_ref.clone(),
        reconciliation_resolution_ref: terminal.reconciliation_resolution_ref.clone(),
        cancellation_request_event_ref: terminal.cancellation_request_event_ref,
        cancellation_request_event_digest: terminal.cancellation_request_event_digest.clone(),
        reason: terminal.reason.clone(),
        idempotency_key: terminal.idempotency_key.clone(),
        completed_at: terminal.completed_at.clone(),
    });
    workflow.phase = phase;
    sync_workflow_compatibility_view(state, &key);
}

/// Direct reducer callers bypass the storage ingress, so V3 evidence records
/// repeat canonical ledger validation here before they can alter the durable
/// projection. ReplayEngine callers get the same check while loading events.
fn validate_v3_event_payload(event: &Event) -> Result<(), String> {
    canonicalize(event.clone())
        .map(|_| ())
        .map_err(|error| format!("V3 action evidence payload is not canonical: {error}"))
}

/// Direct reducer callers bypass storage ingress, so V4 graph-bound authority
/// repeats canonical ledger validation before it can create a workflow
/// projection. The wording is deliberately separate from V3 evidence so a
/// rejected graph binding is never reported as ordinary V3 recovery.
fn validate_v4_event_payload(event: &Event) -> Result<(), String> {
    canonicalize(event.clone())
        .map(|_| ())
        .map_err(|error| format!("graph-bound V4 dispatch payload is not canonical: {error}"))
}

/// Locate the governed V3 workflow named by a native model-authorization
/// record. The remaining action-request fields are checked against the exact
/// projected write-ahead event before the record is stored.
fn find_v3_workflow_key_for_model_authorization(
    state: &ReplayState,
    event: &Event,
    authorization: &ModelActionAuthorizedV1,
) -> Result<String, String> {
    if authorization.run_id != event.run_id.to_string() {
        return Err("model action authorization run_id does not match its event run_id".into());
    }
    let key = workflow_instance_key(
        &authorization.workflow_id,
        &authorization.unit_id,
        authorization.attempt,
    );
    let Some(workflow) = state.workflow_instances.get(&key) else {
        return Err("model action authorization has no prior V3 dispatch envelope".into());
    };
    if !event_matches_workflow_run(workflow, event) {
        return Err("model action authorization belongs to a different run".into());
    }
    if !supports_sealed_action_evidence(workflow)
        || workflow.dispatch.trust_tier != TrustTierV1::Governed
    {
        return Err(
            "model action authorization requires a governed sealed V3 dispatch envelope".into(),
        );
    }
    if workflow.workflow_id != authorization.workflow_id
        || workflow.unit_id != authorization.unit_id
        || workflow.attempt != authorization.attempt
        || workflow.dispatch.provenance_ref != authorization.provenance_ref
        || workflow.dispatch.event_id.to_string() != authorization.dispatch_event_ref
        || workflow.dispatch.envelope_digest != authorization.dispatch_envelope_digest
        || workflow.dispatch.context_manifest_digest != authorization.context_manifest_digest
        || workflow.dispatch.sandbox_profile_digest != authorization.sandbox_profile_digest
        || workflow.dispatch.execution_role != authorization.execution_role
    {
        return Err(
            "model action authorization lineage does not match the signed V3 dispatch envelope"
                .into(),
        );
    }
    Ok(key)
}

fn find_v3_workflow_key_for_action(
    state: &ReplayState,
    event: &Event,
    run_id: &str,
    workflow_id: &str,
    unit_id: &str,
    attempt: u32,
    provenance_ref: &str,
    dispatch_envelope_digest: &str,
    repository_binding_digest: Option<&str>,
    ledger_authority_realm_digest: Option<&str>,
    governed_packet_digest: Option<&str>,
    capability_bundle_digest: &str,
    context_manifest_digest: &str,
    worker_manifest_digest: &str,
    sandbox_profile_digest: &str,
    execution_role: ExecutionRoleV1,
) -> Result<String, String> {
    if run_id != event.run_id.to_string() {
        return Err("action evidence payload run_id does not match its event run_id".into());
    }
    let key = workflow_instance_key(workflow_id, unit_id, attempt);
    let Some(workflow) = state.workflow_instances.get(&key) else {
        return Err("action evidence has no prior V3 dispatch envelope".into());
    };
    if !event_matches_workflow_run(workflow, event) {
        return Err("action evidence belongs to a different run".into());
    }
    if !supports_sealed_action_evidence(workflow) {
        return Err("action evidence requires a sealed V3 dispatch envelope".into());
    }
    if workflow.dispatch.trust_tier != TrustTierV1::Governed {
        return Err("V3 action evidence requires a governed dispatch envelope".into());
    }
    if workflow.workflow_id != workflow_id
        || workflow.unit_id != unit_id
        || workflow.attempt != attempt
        || workflow.dispatch.provenance_ref != provenance_ref
        || workflow.dispatch.envelope_digest != dispatch_envelope_digest
        || repository_binding_digest.is_some_and(|digest| {
            workflow.dispatch.repository_binding_digest.as_deref() != Some(digest)
        })
        || ledger_authority_realm_digest.is_some_and(|digest| {
            workflow.dispatch.ledger_authority_realm_digest.as_deref() != Some(digest)
        })
        || governed_packet_digest.is_some_and(|digest| {
            workflow.dispatch.governed_packet_digest.as_deref() != Some(digest)
        })
        // Only ActionRequestedV2 carries this optional field. Its sealed-V3
        // presence is enforced at that write-ahead boundary; later records
        // are instead anchored through the request digest.
        || governed_packet_digest.is_some_and(|digest| {
            workflow.dispatch.governed_packet_digest.as_deref() != Some(digest)
        })
        || workflow.dispatch.capability_bundle_digest != capability_bundle_digest
        || workflow.dispatch.context_manifest_digest != context_manifest_digest
        || workflow.dispatch.worker_manifest_digest != worker_manifest_digest
        || workflow.dispatch.sandbox_profile_digest != sandbox_profile_digest
        || workflow.dispatch.execution_role != execution_role
    {
        return Err(
            "action evidence lineage does not match the signed V3 dispatch envelope".into(),
        );
    }
    Ok(key)
}

/// Locate the single V3 action request named by a native activity claim. The
/// claim carries event references rather than mutable workflow/unit names, so
/// an untrusted worker cannot redirect a lease by changing presentation-level
/// identifiers after dispatch.
fn find_v3_workflow_key_for_activity_claim(
    state: &ReplayState,
    event: &Event,
    claim: &ActivityClaimedV1,
) -> Result<(String, String), String> {
    if claim.run_id != event.run_id {
        return Err("activity claim run_id does not match its event run_id".into());
    }
    let keys = state
        .workflow_instances
        .iter()
        .filter_map(|(key, workflow)| {
            (event_matches_workflow_run(workflow, event)
                && workflow.dispatch.event_id == claim.dispatch_event_id
                && workflow.dispatch.envelope_digest == claim.dispatch_envelope_digest)
                .then(|| key.clone())
        })
        .collect::<Vec<_>>();
    let [key] = keys.as_slice() else {
        return Err(if keys.is_empty() {
            "activity claim has no exact prior V3 dispatch event/digest binding".into()
        } else {
            "activity claim dispatch event/digest binds more than one workflow".into()
        });
    };
    let workflow = state
        .workflow_instances
        .get(key)
        .expect("matched workflow key exists");
    if !workflow_supports_native_activity_claim(workflow) {
        return Err("activity claim requires a governed atomic sealed V3 dispatch envelope".into());
    }
    let evidence = workflow
        .action_evidence
        .as_ref()
        .expect("supported V3 workflow has action evidence");
    let action_ids = evidence
        .actions
        .iter()
        .filter_map(|(action_id, action)| {
            (action.request.event_id == claim.action_request_event_id).then(|| action_id.clone())
        })
        .collect::<Vec<_>>();
    let [action_id] = action_ids.as_slice() else {
        return Err(if action_ids.is_empty() {
            "activity claim has no prior exact V3 action request event binding".into()
        } else {
            "activity claim action-request event is bound to more than one action".into()
        });
    };
    Ok((key.clone(), action_id.clone()))
}

/// Locate an already-projected native claim by immutable claim-event id. A
/// result cannot name an action by its human-readable id alone, because ids
/// are caller supplied and may be repeated across workflow units.
fn find_v3_workflow_key_for_activity_result(
    state: &ReplayState,
    event: &Event,
    result: &ActivityResultRecordedV1,
) -> Result<(String, String), String> {
    if result.run_id != event.run_id {
        return Err("activity result run_id does not match its event run_id".into());
    }
    let mut matches = Vec::new();
    for (key, workflow) in &state.workflow_instances {
        if workflow.run_id != result.run_id.to_string() {
            continue;
        }
        let Some(evidence) = workflow.action_evidence.as_ref() else {
            continue;
        };
        for (action_id, action) in &evidence.actions {
            if action
                .activity_claim
                .as_ref()
                .is_some_and(|claim| claim.event_id == result.claim_event_id)
            {
                matches.push((key.clone(), action_id.clone()));
            }
        }
    }
    let [matched] = matches.as_slice() else {
        return Err(if matches.is_empty() {
            "activity result has no prior immutable activity claim".into()
        } else {
            "activity result claim event is bound to more than one action".into()
        });
    };
    Ok(matched.clone())
}

/// Locate the single immutable claim named by a heartbeat. The heartbeat does
/// not resolve by activity ID/idempotency key alone because those values are
/// human-visible identifiers; only the signed claim event is the durable
/// lease authority.
fn find_v3_workflow_key_for_activity_heartbeat(
    state: &ReplayState,
    event: &Event,
    heartbeat: &ActivityHeartbeatRecordedV1,
) -> Result<(String, String), String> {
    if heartbeat.run_id != event.run_id {
        return Err("activity heartbeat run_id does not match its event run_id".into());
    }
    let mut matches = Vec::new();
    for (key, workflow) in &state.workflow_instances {
        if workflow.run_id != heartbeat.run_id.to_string() {
            continue;
        }
        let Some(evidence) = workflow.action_evidence.as_ref() else {
            continue;
        };
        for (action_id, action) in &evidence.actions {
            if action
                .activity_claim
                .as_ref()
                .is_some_and(|claim| claim.event_id == heartbeat.claim_event_id)
            {
                matches.push((key.clone(), action_id.clone()));
            }
        }
    }
    let [matched] = matches.as_slice() else {
        return Err(if matches.is_empty() {
            "activity heartbeat has no prior immutable activity claim".into()
        } else {
            "activity heartbeat claim event is bound to more than one action".into()
        });
    };
    let workflow_key = matched.0.clone();
    let workflow = state
        .workflow_instances
        .get(&workflow_key)
        .expect("matched heartbeat workflow exists");
    if !workflow_supports_native_activity_claim(workflow)
        || !requires_activity_claim_result(workflow)
    {
        return Err(
            "activity heartbeat requires a governed atomic sealed_v3 dispatch envelope".into(),
        );
    }
    Ok(matched.clone())
}

fn workflow_supports_native_activity_claim(workflow: &WorkflowInstanceV1) -> bool {
    supports_sealed_action_evidence(workflow)
        && workflow.dispatch.trust_tier == TrustTierV1::Governed
        && workflow.dispatch.commit_mode == CommitModeV1::Atomic
        && workflow.action_evidence.is_some()
}

/// Both action-evidence revisions share the sealed V3 event shape. `sealed-v2`
/// remains readable for historical tapes, while `sealed_v3` opts into the
/// stronger native activity-claim/result protocol below.
fn supports_sealed_action_evidence(workflow: &WorkflowInstanceV1) -> bool {
    matches!(workflow.dispatch.dispatch_version, 3 | 4)
        && matches!(
            workflow.dispatch.action_evidence_version,
            Some(ActionEvidenceVersionV1::SealedV2 | ActionEvidenceVersionV1::SealedV3)
        )
}

/// Sealed V3 is the first action-evidence revision that makes the native
/// write-ahead activity lease part of the candidate eligibility contract.
/// Keeping this distinct from `supports_sealed_action_evidence` deliberately
/// preserves replay of pre-claim sealed-v2 tapes.
fn requires_activity_claim_result(workflow: &WorkflowInstanceV1) -> bool {
    workflow.dispatch.action_evidence_version == Some(ActionEvidenceVersionV1::SealedV3)
}

/// Only newly opted-in governed sealed_v3 candidate flows need the additive
/// candidate-completion event. Legacy candidate projections and sealed-v2
/// tapes remain replayable without inventing a historical completion record.
fn requires_candidate_completion(workflow: &WorkflowInstanceV1) -> bool {
    requires_activity_claim_result(workflow)
        && workflow.dispatch.trust_tier == TrustTierV1::Governed
        && workflow
            .candidate
            .as_ref()
            .is_some_and(|candidate| candidate.action_receipt_set_ref.is_some())
}

const CANDIDATE_CREATE_ACTION_ID_PREFIX: &str = "git-candidate-create:";

/// The governed Git adapter assigns the candidate action identifier from the
/// exact Buildplane candidate-ref suffix. Requiring both this deterministic
/// identity and `ActionKindV1::Git` prevents a generic completed action from
/// being retrospectively labeled as the materialization that made a candidate.
fn candidate_create_action_id_matches_candidate(action_id: &str, candidate_ref: &str) -> bool {
    let Some(candidate_key) = candidate_ref.strip_prefix(BUILDPANE_CANDIDATE_REF_PREFIX) else {
        return false;
    };
    action_id == format!("{CANDIDATE_CREATE_ACTION_ID_PREFIX}{candidate_key}")
}

/// Retry action identities use a literal colon delimiter after the signed
/// namespace: `${retry_action_namespace}:<non-empty suffix>`. Both the
/// `action_id` and `idempotency_key` must obey it so a retry cannot reuse an
/// effect identity admitted by the failed attempt.
const RETRY_ACTION_NAMESPACE_DELIMITER: &str = ":";

fn retry_action_identity_uses_namespace(identity: &str, namespace: &str) -> bool {
    if namespace.is_empty() {
        return false;
    }
    let prefix = format!("{namespace}{RETRY_ACTION_NAMESPACE_DELIMITER}");
    identity
        .strip_prefix(&prefix)
        .is_some_and(|suffix| !suffix.is_empty())
}

/// A retry context is consumed into the retry workflow projection at dispatch
/// time, not looked up ad hoc by an action. This keeps replay of the action
/// independent of a later context-map mutation and makes the signed namespace
/// explicit in the durable attempt state.
fn validate_retry_action_namespace(
    state: &ReplayState,
    workflow: &WorkflowInstanceV1,
    request: &ActionRequestedV2,
) -> Result<(), String> {
    let is_governed_sealed_v3_retry = workflow.attempt > 1
        && matches!(workflow.dispatch.dispatch_version, 3 | 4)
        && workflow.dispatch.trust_tier == TrustTierV1::Governed
        && workflow.dispatch.action_evidence_version == Some(ActionEvidenceVersionV1::SealedV3);
    if !is_governed_sealed_v3_retry {
        return Ok(());
    }

    let Some(consumed_context) = workflow.retry_context.as_ref() else {
        return Err(
            "governed sealed_v3 retry action requires the dispatch to retain its consumed retry context"
                .into(),
        );
    };
    let namespace = &consumed_context.context.retry_action_namespace;
    if !retry_action_identity_uses_namespace(&request.action_id, namespace)
        || !retry_action_identity_uses_namespace(&request.idempotency_key, namespace)
    {
        return Err(
            "governed sealed_v3 retry action_id and idempotency_key must each use the signed retry action namespace `${retry_action_namespace}:<non-empty suffix>`"
                .into(),
        );
    }

    // Namespace matching is the admission rule. This direct comparison is a
    // defensive second proof against a maliciously chosen namespace that
    // happens to prefix an identity from the immediately prior attempt.
    let context = &consumed_context.context;
    let prior_key = workflow_instance_key(
        &context.workflow_id,
        &context.unit_id,
        context.prior_attempt,
    );
    if let Some(prior) = state.workflow_instances.get(&prior_key) {
        if prior.action_evidence.as_ref().is_some_and(|evidence| {
            evidence.actions.values().any(|action| {
                action.request.action_id == request.action_id
                    || action.request.idempotency_key == request.idempotency_key
            })
        }) {
            return Err(
                "governed sealed_v3 retry action cannot reuse a prior-attempt action_id or idempotency_key"
                    .into(),
            );
        }
    }

    Ok(())
}

fn find_v3_workflow_key_for_set(
    state: &ReplayState,
    event: &Event,
    set: &ActionReceiptSetRecordedV1,
) -> Result<String, String> {
    if set.run_id != event.run_id.to_string() {
        return Err("action receipt set run_id does not match its event run_id".into());
    }
    let key = workflow_instance_key(&set.workflow_id, &set.unit_id, set.attempt);
    let Some(workflow) = state.workflow_instances.get(&key) else {
        return Err("action receipt set has no prior V3 dispatch envelope".into());
    };
    if !event_matches_workflow_run(workflow, event) {
        return Err("action receipt set belongs to a different run".into());
    }
    if !supports_sealed_action_evidence(workflow)
        || workflow.dispatch.trust_tier != TrustTierV1::Governed
    {
        return Err("action receipt set requires a governed sealed V3 dispatch envelope".into());
    }
    if workflow.dispatch.provenance_ref != set.provenance_ref
        || workflow.dispatch.envelope_digest != set.dispatch_envelope_digest
    {
        return Err(
            "action receipt set lineage does not match the signed V3 dispatch envelope".into(),
        );
    }
    Ok(key)
}

/// Locate the independent V3 reviewer dispatch named by a V2 verdict. The
/// sealed set is checked separately because a valid dispatch alone does not
/// prove that the review model action completed.
fn find_v3_reviewer_workflow_for_review(
    state: &ReplayState,
    event: &Event,
    review: &ReviewVerdictRecordedV2,
) -> Result<String, String> {
    if !matches!(
        review.reviewer_execution_role,
        ExecutionRoleV1::Reviewer | ExecutionRoleV1::Adversary | ExecutionRoleV1::Judge
    ) {
        return Err("review v2 requires a read-only reviewer, adversary, or judge role".into());
    }
    let key = workflow_instance_key(
        &review.reviewer_workflow_id,
        &review.reviewer_unit_id,
        review.reviewer_attempt,
    );
    let Some(workflow) = state.workflow_instances.get(&key) else {
        return Err("review v2 has no prior reviewer V3 dispatch envelope".into());
    };
    if !event_matches_workflow_run(workflow, event) {
        return Err("review v2 reviewer dispatch belongs to a different run".into());
    }
    if !supports_sealed_action_evidence(workflow)
        || workflow.dispatch.trust_tier != TrustTierV1::Governed
        || workflow.dispatch.commit_mode != CommitModeV1::Atomic
    {
        return Err("review v2 requires a governed atomic sealed V3 reviewer dispatch".into());
    }
    if workflow.workflow_id != review.reviewer_workflow_id
        || workflow.unit_id != review.reviewer_unit_id
        || workflow.attempt != review.reviewer_attempt
        || workflow.dispatch.envelope_digest != review.reviewer_dispatch_envelope_digest
        || workflow.dispatch.execution_role != review.reviewer_execution_role
        || workflow.dispatch.worker_manifest_digest != review.reviewer_manifest_digest
    {
        return Err(
            "review v2 reviewer dispatch identity does not match the signed V3 envelope".into(),
        );
    }
    Ok(key)
}

/// A review verdict must identify a completed review activity, not merely any
/// unrelated sealed effect. Rechecking every set entry avoids trusting a
/// stale/corrupted snapshot that no longer mirrors the receipt map.
fn review_action_evidence_is_successful(evidence: &ActionEvidenceReplayState) -> bool {
    let Some(set) = evidence.sealed_receipt_set.as_ref() else {
        return false;
    };
    !set.receipts.is_empty()
        && set.receipts.len() == evidence.actions.len()
        && evidence.pending_action_ids.is_empty()
        && evidence.unknown_action_ids.is_empty()
        && evidence.failed_action_ids.is_empty()
        && set.receipts.iter().all(|entry| {
            evidence
                .actions
                .get(&entry.action_id)
                .is_some_and(|action| {
                    action.receipt.as_ref().is_some_and(|receipt| {
                        receipt.outcome == ActionReceiptOutcomeV2::Succeeded
                            && receipt.action_receipt_ref == entry.action_receipt_ref
                            && receipt.action_receipt_digest == entry.action_receipt_digest
                    })
                })
        })
}

fn refresh_action_evidence_recovery(evidence: &mut ActionEvidenceReplayState) {
    let mut pending = Vec::new();
    let mut unknown = Vec::new();
    let mut failed = Vec::new();
    let sealed_v3 = evidence.action_evidence_version == ActionEvidenceVersionV1::SealedV3;
    for (action_id, action) in &evidence.actions {
        let claim_is_unknown = action
            .activity_claim
            .as_ref()
            .and_then(|claim| claim.result.as_ref())
            .is_some_and(|result| result.outcome == ActivityResultOutcomeV1::Unknown);
        let claim_is_failed = action
            .activity_claim
            .as_ref()
            .and_then(|claim| claim.result.as_ref())
            .is_some_and(|result| result.outcome == ActivityResultOutcomeV1::Failed);
        let receipt_is_unknown = action
            .receipt
            .as_ref()
            .is_some_and(|receipt| receipt.outcome == ActionReceiptOutcomeV2::Unknown);
        let receipt_is_failed = action.receipt.as_ref().is_some_and(|receipt| {
            matches!(
                receipt.outcome,
                ActionReceiptOutcomeV2::Failed | ActionReceiptOutcomeV2::Denied
            )
        });
        if claim_is_unknown || receipt_is_unknown {
            unknown.push(action_id.clone());
        } else if sealed_v3 && (claim_is_failed || receipt_is_failed) {
            // A terminal failed activity must stay visible to recovery as a
            // terminal failure. It is explicitly not returned to the pending
            // queue, where a host could mistake it for a retryable effect.
            failed.push(action_id.clone());
        } else if action.receipt.is_none() {
            pending.push(action_id.clone());
        }
    }
    evidence.pending_action_ids = pending;
    evidence.unknown_action_ids = unknown;
    evidence.failed_action_ids = failed;
}

fn activity_claim_matches_action(
    workflow: &WorkflowInstanceV1,
    request: &ActionRequestReplayState,
    claim: &ActivityClaimedV1,
) -> bool {
    claim.run_id.to_string() == workflow.run_id
        && claim.activity_id == request.action_id
        && claim.idempotency_key == request.idempotency_key
        && claim.action_kind == request.action_kind
        && claim.action_request_event_id == request.event_id
        && claim.action_request_digest == request.action_request_digest
        && claim.dispatch_event_id == workflow.dispatch.event_id
        && claim.dispatch_envelope_digest == workflow.dispatch.envelope_digest
}

fn activity_claim_timestamps_are_valid(
    workflow: &WorkflowInstanceV1,
    request: &ActionRequestReplayState,
    event: &Event,
    claim: &ActivityClaimedV1,
    require_occurred_at_binding: bool,
) -> bool {
    let Some(claimed_at) = parse_rfc3339_utc(&claim.claimed_at) else {
        return false;
    };
    let Some(lease_expires_at) = parse_rfc3339_utc(&claim.lease_expires_at) else {
        return false;
    };
    let Some(requested_at) = parse_rfc3339_utc(&request.requested_at) else {
        return false;
    };
    let Some(issued_at) = parse_rfc3339_utc(&workflow.dispatch.issued_at) else {
        return false;
    };
    let Some(effective_deadline) = effective_dispatch_effect_deadline(workflow) else {
        return false;
    };
    (!require_occurred_at_binding || claimed_at == event.occurred_at)
        && claimed_at >= requested_at
        && claimed_at >= issued_at
        && lease_expires_at > claimed_at
        && lease_expires_at <= effective_deadline
}

/// A sealed-v3 model effect is valid only while the exact native authority
/// derived from its parent intent is live. This check is deliberately made at
/// the claim/result transitions rather than only when writing a receipt: a
/// later intent or authorization must never retroactively legitimize an
/// already-recorded provider effect.
fn sealed_v3_model_authority_is_live_at(
    workflow: &WorkflowInstanceV1,
    action: &ActionReplayState,
    activity_at: &str,
) -> bool {
    let Some(intent) = action.model_intent.as_ref() else {
        return false;
    };
    let Some(authorization) = action.model_authorization.as_ref() else {
        return false;
    };
    let Some(intended_at) = parse_rfc3339_utc(&intent.intended_at) else {
        return false;
    };
    let Some(requested_at) = parse_rfc3339_utc(&action.request.requested_at) else {
        return false;
    };
    let Some(authorized_at) = authorization
        .authorized_at
        .as_deref()
        .and_then(parse_rfc3339_utc)
    else {
        return false;
    };
    let Some(activity_at) = parse_rfc3339_utc(activity_at) else {
        return false;
    };
    let Some(expires_at) = parse_rfc3339_utc(&authorization.expires_at) else {
        return false;
    };
    let Some(deadline) = effective_dispatch_effect_deadline(workflow) else {
        return false;
    };

    authorization.authorization_version == 2
        && authorization.intent_event_ref == Some(intent.event_id)
        && authorization.intent_digest.as_deref() == Some(intent.intent_digest.as_str())
        && intent.dispatch_event_ref == workflow.dispatch.event_id
        && intent.dispatch_envelope_digest == workflow.dispatch.envelope_digest
        && intent.action_request_event_ref == action.request.event_id
        && intent.action_request_digest == action.request.action_request_digest
        && intent.canonical_input_ref == action.request.canonical_input_ref
        && intent.canonical_input_digest == action.request.canonical_input_digest
        && authorization.dispatch_event_ref == workflow.dispatch.event_id.to_string()
        && authorization.dispatch_envelope_digest == workflow.dispatch.envelope_digest
        && authorization.action_request_ref == action.request.event_id.to_string()
        && authorization.action_request_digest == action.request.action_request_digest
        && authorization.packet_digest
            == workflow
                .dispatch
                .governed_packet_digest
                .as_deref()
                .unwrap_or_default()
        && authorization.canonical_input_digest == action.request.canonical_input_digest
        && authorization.context_manifest_digest == workflow.dispatch.context_manifest_digest
        && authorization.policy_digest == action.request.policy_digest
        && authorization.sandbox_profile_digest == workflow.dispatch.sandbox_profile_digest
        && authorization.execution_role == action.request.execution_role
        && authorization.candidate_binding == intent.candidate_binding
        && is_canonical_sha256_digest(&intent.intent_digest)
        && is_canonical_sha256_digest(&authorization.model_request_digest)
        && is_canonical_sha256_digest(&authorization.trust_scope_digest)
        && is_canonical_sha256_digest(&authorization.authorization_digest)
        && !intent.intent_actor.trim().is_empty()
        && !authorization.authorization_actor.trim().is_empty()
        && !authorization.authorization_ref.trim().is_empty()
        && requested_at <= intended_at
        && intended_at <= authorized_at
        && authorized_at <= activity_at
        && activity_at < expires_at
        && expires_at <= deadline
}

fn activity_claim_matches_existing(
    existing: &ActivityClaimReplayState,
    event: &Event,
    claim: &ActivityClaimedV1,
    claim_event_digest: &str,
    signer: Option<&ActorKeyRef>,
) -> bool {
    existing.event_id == event.id
        && existing.claim_event_digest == claim_event_digest
        && existing.run_id == claim.run_id.to_string()
        && existing.activity_id == claim.activity_id
        && existing.idempotency_key == claim.idempotency_key
        && existing.action_kind == claim.action_kind
        && existing.action_request_event_id == claim.action_request_event_id
        && existing.action_request_digest == claim.action_request_digest
        && existing.dispatch_event_id == claim.dispatch_event_id
        && existing.dispatch_envelope_digest == claim.dispatch_envelope_digest
        && existing.authority_actor == claim.authority_actor
        && existing.lease_id == claim.lease_id
        && existing.lease_expires_at == claim.lease_expires_at
        && existing.claimed_at == claim.claimed_at
        && existing.signer.as_ref() == signer
}

fn activity_heartbeat_matches_claim(
    claim: &ActivityClaimReplayState,
    heartbeat: &ActivityHeartbeatRecordedV1,
) -> bool {
    claim.run_id == heartbeat.run_id.to_string()
        && claim.activity_id == heartbeat.activity_id
        && claim.idempotency_key == heartbeat.idempotency_key
        && claim.event_id == heartbeat.claim_event_id
        && claim.claim_event_digest == heartbeat.claim_event_digest
        && claim.lease_id == heartbeat.lease_id
        && claim.dispatch_event_id == heartbeat.dispatch_event_id
        && claim.dispatch_envelope_digest == heartbeat.dispatch_envelope_digest
}

fn activity_heartbeat_timestamps_are_valid(
    workflow: &WorkflowInstanceV1,
    claim: &ActivityClaimReplayState,
    event: &Event,
    heartbeat: &ActivityHeartbeatRecordedV1,
) -> bool {
    let Some(claimed_at) = parse_rfc3339_utc(&claim.claimed_at) else {
        return false;
    };
    let Some(current_lease_expires_at) = parse_rfc3339_utc(&claim.lease_expires_at) else {
        return false;
    };
    let Some(heartbeat_at) = parse_rfc3339_utc(&heartbeat.heartbeat_at) else {
        return false;
    };
    let Some(next_lease_expires_at) = parse_rfc3339_utc(&heartbeat.lease_expires_at) else {
        return false;
    };
    let Some(effective_deadline) = effective_dispatch_effect_deadline(workflow) else {
        return false;
    };
    let previous_heartbeat_is_earlier = claim
        .heartbeats
        .last()
        .and_then(|previous| parse_rfc3339_utc(&previous.heartbeat_at))
        .map_or(true, |previous| previous < heartbeat_at);
    heartbeat_at == event.occurred_at
        && heartbeat_at >= claimed_at
        && heartbeat_at < current_lease_expires_at
        && next_lease_expires_at > current_lease_expires_at
        && next_lease_expires_at <= effective_deadline
        && previous_heartbeat_is_earlier
}

/// The dispatch expiry remains the outer authority boundary. When a signed
/// compute budget is present, effect leases and model authorizations must also
/// fit inside the shorter execution window starting at dispatch issuance.
/// Older envelopes without that budget retain their original expiry-only
/// semantics for replay compatibility.
fn effective_dispatch_effect_deadline(workflow: &WorkflowInstanceV1) -> Option<DateTime<Utc>> {
    let issued_at = parse_rfc3339_utc(&workflow.dispatch.issued_at)?;
    let dispatch_expires_at = parse_rfc3339_utc(&workflow.dispatch.expires_at)?;
    let Some(max_compute_time_ms) = workflow.dispatch.budget.max_compute_time_ms else {
        return Some(dispatch_expires_at);
    };
    let compute_deadline =
        issued_at.checked_add_signed(Duration::milliseconds(i64::from(max_compute_time_ms)))?;
    Some(compute_deadline.min(dispatch_expires_at))
}

fn activity_heartbeat_matches_existing(
    existing: &ActivityHeartbeatReplayState,
    event: &Event,
    heartbeat: &ActivityHeartbeatRecordedV1,
    heartbeat_event_digest: &str,
) -> bool {
    existing.event_id == event.id
        && existing.event_digest == heartbeat_event_digest
        && existing.run_id == heartbeat.run_id.to_string()
        && existing.activity_id == heartbeat.activity_id
        && existing.idempotency_key == heartbeat.idempotency_key
        && existing.heartbeat_id == heartbeat.heartbeat_id
        && existing.heartbeat_request_digest == heartbeat.heartbeat_request_digest
        && existing.claim_event_id == heartbeat.claim_event_id
        && existing.claim_event_digest == heartbeat.claim_event_digest
        && existing.lease_id == heartbeat.lease_id
        && existing.dispatch_event_id == heartbeat.dispatch_event_id
        && existing.dispatch_envelope_digest == heartbeat.dispatch_envelope_digest
        && existing.lease_expires_at == heartbeat.lease_expires_at
        && existing.heartbeat_at == heartbeat.heartbeat_at
}

fn activity_result_matches_claim(
    claim: &ActivityClaimReplayState,
    result: &ActivityResultRecordedV1,
) -> bool {
    claim.run_id == result.run_id.to_string()
        && claim.activity_id == result.activity_id
        && claim.idempotency_key == result.idempotency_key
        && claim.event_id == result.claim_event_id
        && claim.claim_event_digest == result.claim_event_digest
        && claim.lease_id == result.lease_id
}

fn activity_result_timestamp_is_valid(
    claim: &ActivityClaimReplayState,
    event: &Event,
    result: &ActivityResultRecordedV1,
    require_occurred_at_binding: bool,
) -> bool {
    let Some(claimed_at) = parse_rfc3339_utc(&claim.claimed_at) else {
        return false;
    };
    let Some(lease_expires_at) = parse_rfc3339_utc(&claim.lease_expires_at) else {
        return false;
    };
    let Some(recorded_at) = parse_rfc3339_utc(&result.recorded_at) else {
        return false;
    };
    (!require_occurred_at_binding || recorded_at == event.occurred_at)
        && recorded_at >= claimed_at
        && (recorded_at < lease_expires_at || result.outcome == ActivityResultOutcomeV1::Unknown)
}

fn activity_result_matches_existing(
    existing: &ActivityResultReplayState,
    event: &Event,
    result: &ActivityResultRecordedV1,
) -> bool {
    existing.event_id == event.id
        && existing.run_id == result.run_id.to_string()
        && existing.activity_id == result.activity_id
        && existing.idempotency_key == result.idempotency_key
        && existing.claim_event_id == result.claim_event_id
        && existing.claim_event_digest == result.claim_event_digest
        && existing.lease_id == result.lease_id
        && existing.outcome == result.outcome
        && existing.result_digest == result.result_digest
        && existing.result_ref == result.result_ref
        && existing.evidence_digest == result.evidence_digest
        && existing.evidence_ref == result.evidence_ref
        && existing.recorded_at == result.recorded_at
}

fn activity_claim_result_matches_receipt(
    claim: &ActivityClaimReplayState,
    receipt: &ActionReceiptRecordedV2,
    require_strict_activity_evidence: bool,
) -> bool {
    let Some(result) = claim.result.as_ref() else {
        return false;
    };
    if require_strict_activity_evidence
        && (receipt.evidence_digest != result.evidence_digest
            || receipt.evidence_ref != result.evidence_ref)
    {
        return false;
    }
    if require_strict_activity_evidence {
        return match result.outcome {
            ActivityResultOutcomeV1::Succeeded => {
                receipt.outcome == ActionReceiptOutcomeV2::Succeeded
                    && receipt.result_digest == result.result_digest
                    && receipt.result_ref == result.result_ref
            }
            ActivityResultOutcomeV1::Failed => {
                receipt.outcome == ActionReceiptOutcomeV2::Failed
                    && receipt
                        .failure
                        .as_ref()
                        .is_some_and(|failure| !failure.retryable)
            }
            ActivityResultOutcomeV1::Unknown => receipt.outcome == ActionReceiptOutcomeV2::Unknown,
        };
    }
    match result.outcome {
        ActivityResultOutcomeV1::Succeeded => {
            receipt.outcome == ActionReceiptOutcomeV2::Succeeded
                && receipt.result_digest == result.result_digest
                && receipt.result_ref == result.result_ref
        }
        ActivityResultOutcomeV1::Failed => receipt.outcome != ActionReceiptOutcomeV2::Succeeded,
        ActivityResultOutcomeV1::Unknown => receipt.outcome == ActionReceiptOutcomeV2::Unknown,
    }
}

fn action_request_matches_existing(
    existing: &ActionRequestReplayState,
    p: &ActionRequestedV2,
    action_request_digest: &str,
) -> bool {
    existing.action_id == p.action_id
        && existing.idempotency_key == p.idempotency_key
        && existing.action_kind == p.action_kind
        && existing.canonical_input_digest == p.canonical_input_digest
        && existing.canonical_input_ref == p.canonical_input_ref
        && existing.repository_binding_digest == p.repository_binding_digest
        && existing.ledger_authority_realm_digest == p.ledger_authority_realm_digest
        && existing.governed_packet_digest == p.governed_packet_digest
        && existing.policy_digest == p.policy_digest
        && existing.authority_actor == p.authority_actor
        && existing.execution_role == p.execution_role
        && existing.requested_at == p.requested_at
        && existing.action_request_digest == action_request_digest
}

fn model_authorization_matches_request_and_dispatch(
    workflow: &WorkflowInstanceV1,
    request: &ActionRequestReplayState,
    p: &ModelActionAuthorizedV1,
) -> bool {
    p.run_id == workflow.run_id
        && p.workflow_id == workflow.workflow_id
        && p.unit_id == workflow.unit_id
        && p.attempt == workflow.attempt
        && p.provenance_ref == workflow.dispatch.provenance_ref
        && p.action_id == request.action_id
        && p.idempotency_key == request.idempotency_key
        && p.dispatch_event_ref == workflow.dispatch.event_id.to_string()
        && p.dispatch_envelope_digest == workflow.dispatch.envelope_digest
        && p.action_request_ref == request.event_id.to_string()
        && p.action_request_digest == request.action_request_digest
        && (workflow.dispatch.action_evidence_version != Some(ActionEvidenceVersionV1::SealedV3)
            || workflow
                .dispatch
                .governed_packet_digest
                .as_deref()
                .is_some_and(|digest| p.packet_digest == digest))
        && p.canonical_input_digest == request.canonical_input_digest
        && p.context_manifest_digest == workflow.dispatch.context_manifest_digest
        && p.policy_digest == request.policy_digest
        && p.sandbox_profile_digest == workflow.dispatch.sandbox_profile_digest
        && p.execution_role == request.execution_role
        && p.execution_role == workflow.dispatch.execution_role
}

fn model_intent_matches_request_and_dispatch(
    workflow: &WorkflowInstanceV1,
    request: &ActionRequestReplayState,
    intent: &ModelActionIntentV1,
) -> bool {
    intent.run_id == workflow.run_id
        && intent.workflow_id == workflow.workflow_id
        && intent.unit_id == workflow.unit_id
        && intent.attempt == workflow.attempt
        && intent.provenance_ref == workflow.dispatch.provenance_ref
        && intent.action_id == request.action_id
        && intent.idempotency_key == request.idempotency_key
        && intent.dispatch_event_ref == workflow.dispatch.event_id
        && intent.dispatch_envelope_digest == workflow.dispatch.envelope_digest
        && intent.action_request_event_ref == request.event_id
        && intent.action_request_digest == request.action_request_digest
        && intent.canonical_input_ref == request.canonical_input_ref
        && intent.canonical_input_digest == request.canonical_input_digest
}

/// Verify the nested candidate proof against both the immutable candidate
/// projection and the independent reviewer dispatch. The candidate view is
/// embedded in the signed intent specifically so this reducer never needs to
/// trust a mutable filesystem mount or dereference an untrusted external URI.
fn candidate_binding_matches_replay(
    state: &ReplayState,
    event: &Event,
    reviewer_workflow: &WorkflowInstanceV1,
    binding: &ModelActionCandidateBindingV1,
) -> Result<(), String> {
    let reviewer_key = workflow_instance_key(
        &reviewer_workflow.workflow_id,
        &reviewer_workflow.unit_id,
        reviewer_workflow.attempt,
    );
    let mut matches = Vec::new();
    for (workflow_key, workflow) in &state.workflow_instances {
        let Some(candidate) = workflow.candidate.as_ref() else {
            continue;
        };
        if candidate.event_id == binding.candidate_created_event_ref {
            matches.push((workflow_key, workflow, candidate));
        }
    }
    if matches.len() != 1 {
        return Err(
            "model action candidate binding must reference exactly one immutable CandidateCreatedV2 event"
                .into(),
        );
    }
    let (candidate_workflow_key, candidate_workflow, candidate) = matches[0];
    if candidate_workflow_key == &reviewer_key {
        return Err(
            "model action candidate binding must target a candidate from an independent workflow"
                .into(),
        );
    }
    if !event_matches_workflow_run(candidate_workflow, event) {
        return Err("model action candidate binding belongs to a different run".into());
    }
    if candidate.candidate_digest != binding.candidate_digest
        || candidate.candidate_commit_sha != binding.candidate_commit_sha
        || candidate.candidate_ref != binding.candidate_view.candidate_ref
        || candidate.tree_digest != binding.candidate_view.tree_digest
    {
        return Err(
            "model action candidate binding does not match its immutable candidate event".into(),
        );
    }
    if !matches!(
        candidate_workflow
            .acceptance
            .as_ref()
            .map(|acceptance| acceptance.outcome),
        Some(CandidateAcceptanceOutcomeV1::Passed)
    ) {
        return Err(
            "model action candidate binding requires a passed deterministic candidate acceptance"
                .into(),
        );
    }
    if binding.candidate_view.reviewer_context_manifest_digest
        != reviewer_workflow.dispatch.context_manifest_digest
        || binding.candidate_view.reviewer_sandbox_profile_digest
            != reviewer_workflow.dispatch.sandbox_profile_digest
        || !binding.candidate_view.read_only
        || !binding.candidate_view.network_disabled
    {
        return Err(
            "model action candidate binding does not bind the read-only network-disabled reviewer context"
                .into(),
        );
    }
    Ok(())
}

/// The candidate proof on a sealed-v3 reviewer action is authority for one
/// immutable candidate, not a general permission to issue any later verdict.
/// Compare both the intent and its V2 authorization with the verdict's fully
/// embedded candidate view so a valid action for candidate A cannot approve B.
fn sealed_v3_review_action_binds_verdict_target(
    action: &ActionReplayState,
    candidate: &CandidateArtifactReplayState,
    verdict: &ReviewVerdictRecordedV2,
) -> bool {
    let Some(intent) = action.model_intent.as_ref() else {
        return false;
    };
    let Some(intent_binding) = intent.candidate_binding.as_ref() else {
        return false;
    };
    let Some(authorization) = action.model_authorization.as_ref() else {
        return false;
    };
    let Some(authorization_binding) = authorization.candidate_binding.as_ref() else {
        return false;
    };
    authorization.authorization_version == 2
        && authorization.intent_event_ref == Some(intent.event_id)
        && authorization.intent_digest.as_deref() == Some(intent.intent_digest.as_str())
        && candidate_binding_matches_review_verdict_target(intent_binding, candidate, verdict)
        && candidate_binding_matches_review_verdict_target(
            authorization_binding,
            candidate,
            verdict,
        )
}

fn candidate_binding_matches_review_verdict_target(
    binding: &ModelActionCandidateBindingV1,
    candidate: &CandidateArtifactReplayState,
    verdict: &ReviewVerdictRecordedV2,
) -> bool {
    binding.candidate_created_event_ref == candidate.event_id
        && binding.candidate_digest == candidate.candidate_digest
        && binding.candidate_digest == verdict.candidate_digest
        && binding.candidate_commit_sha == candidate.candidate_commit_sha
        && binding.candidate_commit_sha == verdict.candidate_commit_sha
        && binding.candidate_view_ref == verdict.candidate_view_ref
        && binding.candidate_view_digest == verdict.candidate_view_digest
        && binding.candidate_view == verdict.candidate_view
}

fn model_authorization_matches_existing(
    existing: &ModelActionAuthorizationReplayState,
    event: &Event,
    p: &ModelActionAuthorizedV1,
    authorization_digest: &str,
) -> bool {
    existing.event_id == event.id
        && existing.dispatch_event_ref == p.dispatch_event_ref
        && existing.dispatch_envelope_digest == p.dispatch_envelope_digest
        && existing.action_request_ref == p.action_request_ref
        && existing.action_request_digest == p.action_request_digest
        && existing.packet_digest == p.packet_digest
        && existing.canonical_input_digest == p.canonical_input_digest
        && existing.model_request_digest == p.model_request_digest
        && existing.trust_scope_digest == p.trust_scope_digest
        && existing.context_manifest_digest == p.context_manifest_digest
        && existing.policy_digest == p.policy_digest
        && existing.sandbox_profile_digest == p.sandbox_profile_digest
        && existing.execution_role == p.execution_role
        && existing.candidate_digest == p.candidate_digest
        && existing.candidate_view_digest == p.candidate_view_digest
        && existing.authorization_actor == p.authorization_actor
        && existing.expires_at == p.expires_at
        && existing.authorization_ref == p.authorization_ref
        && existing.authorization_digest == authorization_digest
}

fn model_authorization_v2_matches_existing(
    existing: &ModelActionAuthorizationReplayState,
    event: &Event,
    p: &ModelActionAuthorizedV2,
    authorization_digest: &str,
) -> bool {
    existing.authorization_version == 2
        && existing.event_id == event.id
        && existing.intent_event_ref == Some(p.intent_event_ref)
        && existing.intent_digest.as_deref() == Some(p.intent_digest.as_str())
        && existing.model_request_digest == p.model_request_evidence.digest
        && existing.model_request_evidence_ref.as_deref()
            == Some(p.model_request_evidence.cas_ref.as_str())
        && existing.model_request_evidence_schema_version
            == Some(p.model_request_evidence.schema_version)
        && existing.trust_scope_digest == p.trust_scope_evidence.digest
        && existing.trust_scope_evidence_ref.as_deref()
            == Some(p.trust_scope_evidence.cas_ref.as_str())
        && existing.trust_scope_evidence_schema_version
            == Some(p.trust_scope_evidence.schema_version)
        && existing.candidate_binding.as_ref() == p.candidate_binding.as_ref()
        && existing.authorization_actor == p.authorization_actor
        && existing.expires_at == p.expires_at
        && existing.authorization_ref == p.authorization_ref
        && existing.authorization_digest == authorization_digest
}

fn model_authorization_ref_is_bound_elsewhere(
    state: &ReplayState,
    current_workflow_key: &str,
    current_action_id: &str,
    authorization_ref: &str,
) -> bool {
    state
        .workflow_instances
        .iter()
        .any(|(workflow_key, workflow)| {
            workflow.action_evidence.as_ref().is_some_and(|evidence| {
                evidence.actions.iter().any(|(action_id, action)| {
                    (workflow_key.as_str() != current_workflow_key
                        || action_id.as_str() != current_action_id)
                        && action
                            .model_authorization
                            .as_ref()
                            .is_some_and(|authorization| {
                                authorization.authorization_ref == authorization_ref
                            })
                })
            })
        })
}

fn action_receipt_matches_request(
    request: &ActionRequestReplayState,
    p: &ActionReceiptRecordedV2,
) -> bool {
    request.action_id == p.action_id
        && request.idempotency_key == p.idempotency_key
        && request.action_request_digest == p.action_request_digest
        && request.policy_digest == p.policy_digest
        && request.authority_actor == p.authority_actor
        && request.execution_role == p.execution_role
}

fn action_receipt_matches_existing(
    existing: &ActionReceiptReplayState,
    p: &ActionReceiptRecordedV2,
    action_receipt_digest: &str,
) -> bool {
    existing.action_id == p.action_id
        && existing.idempotency_key == p.idempotency_key
        && existing.action_request_digest == p.action_request_digest
        && existing.outcome == p.outcome
        && existing.result_digest == p.result_digest
        && existing.result_ref == p.result_ref
        && existing.evidence_digest == p.evidence_digest
        && existing.evidence_ref == p.evidence_ref
        && existing.resource_usage == p.resource_usage
        && existing.redactions == p.redactions
        && existing.failure == p.failure
        && existing.authorization_ref == p.authorization_ref
        && existing.action_receipt_ref == p.action_receipt_ref
        && existing.action_receipt_digest == action_receipt_digest
        && existing.completed_at == p.completed_at
}

fn action_receipt_set_matches_existing(
    existing: &ActionReceiptSetReplayState,
    p: &ActionReceiptSetRecordedV1,
) -> bool {
    existing.action_receipt_set_ref == p.action_receipt_set_ref
        && existing.action_receipt_set_digest == p.action_receipt_set_digest
        && existing.receipts == p.receipts
        && existing.sealed_at == p.sealed_at
}

fn event_matches_workflow_run(workflow: &WorkflowInstanceV1, event: &Event) -> bool {
    workflow.run_id == event.run_id.to_string()
}

fn dispatch_matches(workflow: &WorkflowInstanceV1, p: &DispatchEnvelopeV1) -> bool {
    workflow.dispatch.dispatch_version == 1
        && workflow.workflow_id == p.workflow_id
        && workflow.workflow_revision == p.workflow_revision
        && workflow.unit_id == p.unit_id
        && workflow.attempt == p.attempt
        && workflow.dispatch.envelope_digest == p.envelope_digest
        && workflow.dispatch.provenance_ref == p.provenance_ref
        && workflow.dispatch.base_commit_sha == p.base_commit_sha
        && workflow.dispatch.capability_bundle_digest == p.capability_bundle_digest
        && workflow.dispatch.acceptance_contract_digest == p.acceptance_contract_digest
        && workflow.dispatch.context_manifest_digest == p.context_manifest_digest
        && workflow.dispatch.worker_manifest_digest == p.worker_manifest_digest
        && workflow.dispatch.sandbox_profile_digest == p.sandbox_profile_digest
        && workflow.dispatch.execution_role == p.execution_role
        && workflow.dispatch.commit_mode == p.commit_mode
        && workflow.dispatch.budget == p.budget
        && workflow.dispatch.trust_tier == p.trust_tier
        && workflow.dispatch.idempotency_key == p.idempotency_key
        && workflow.dispatch.issued_at == p.issued_at
        && workflow.dispatch.expires_at == p.expires_at
        && workflow.dispatch.signature_ref.as_ref() == Some(&p.signature_ref)
}

fn dispatch_v2_matches(workflow: &WorkflowInstanceV1, p: &DispatchEnvelopeV2) -> bool {
    let body = &p.body;
    workflow.dispatch.dispatch_version == 2
        && workflow.workflow_id == body.workflow_id
        && workflow.workflow_revision == body.workflow_revision
        && workflow.unit_id == body.unit_id
        && workflow.attempt == body.attempt
        && workflow.dispatch.envelope_digest == p.envelope_digest
        && workflow.dispatch.provenance_ref == body.provenance_ref
        && workflow.dispatch.base_commit_sha == body.base_commit_sha
        && workflow.dispatch.capability_bundle_digest == body.capability_bundle_digest
        && workflow.dispatch.acceptance_contract_digest == body.acceptance_contract_digest
        && workflow.dispatch.context_manifest_digest == body.context_manifest_digest
        && workflow.dispatch.worker_manifest_digest == body.worker_manifest_digest
        && workflow.dispatch.sandbox_profile_digest == body.sandbox_profile_digest
        && workflow.dispatch.execution_role == body.execution_role
        && workflow.dispatch.commit_mode == body.commit_mode
        && workflow.dispatch.budget == body.budget
        && workflow.dispatch.trust_tier == body.trust_tier
        && workflow.dispatch.idempotency_key == body.idempotency_key
        && workflow.dispatch.issued_at == body.issued_at
        && workflow.dispatch.expires_at == body.expires_at
        && workflow.dispatch.signature_ref.is_none()
}

fn dispatch_v3_matches(workflow: &WorkflowInstanceV1, p: &DispatchEnvelopeV3) -> bool {
    let body = &p.body;
    workflow.dispatch.dispatch_version == 3
        && workflow.workflow_id == body.workflow_id
        && workflow.workflow_revision == body.workflow_revision
        && workflow.unit_id == body.unit_id
        && workflow.attempt == body.attempt
        && workflow.dispatch.envelope_digest == p.envelope_digest
        && workflow.dispatch.provenance_ref == body.provenance_ref
        && workflow.dispatch.base_commit_sha == body.base_commit_sha
        && workflow.dispatch.repository_binding_digest.as_deref()
            == Some(p.repository_binding_digest.as_str())
        && workflow.dispatch.ledger_authority_realm_digest.as_deref()
            == Some(p.ledger_authority_realm_digest.as_str())
        && workflow.dispatch.capability_bundle_digest == body.capability_bundle_digest
        && workflow.dispatch.acceptance_contract_digest == body.acceptance_contract_digest
        && workflow.dispatch.context_manifest_digest == body.context_manifest_digest
        && workflow.dispatch.worker_manifest_digest == body.worker_manifest_digest
        && workflow.dispatch.sandbox_profile_digest == body.sandbox_profile_digest
        && workflow.dispatch.execution_role == body.execution_role
        && workflow.dispatch.commit_mode == body.commit_mode
        && workflow.dispatch.budget == body.budget
        && workflow.dispatch.trust_tier == body.trust_tier
        && workflow.dispatch.idempotency_key == body.idempotency_key
        && workflow.dispatch.issued_at == body.issued_at
        && workflow.dispatch.expires_at == body.expires_at
        && workflow.dispatch.signature_ref.is_none()
        && workflow.dispatch.action_evidence_version == Some(p.action_evidence_version)
}

fn dispatch_v4_matches(workflow: &WorkflowInstanceV1, p: &DispatchEnvelopeV4) -> bool {
    let nested = &p.dispatch_v3;
    let body = &nested.body;
    workflow.dispatch.dispatch_version == 4
        && workflow.workflow_id == body.workflow_id
        && workflow.workflow_revision == body.workflow_revision
        && workflow.unit_id == body.unit_id
        && workflow.attempt == body.attempt
        && workflow.dispatch.envelope_digest == p.envelope_digest
        && workflow.dispatch.provenance_ref == body.provenance_ref
        && workflow.dispatch.base_commit_sha == body.base_commit_sha
        && workflow.dispatch.repository_binding_digest.as_deref()
            == Some(nested.repository_binding_digest.as_str())
        && workflow.dispatch.ledger_authority_realm_digest.as_deref()
            == Some(nested.ledger_authority_realm_digest.as_str())
        && workflow.dispatch.governed_packet_digest == nested.governed_packet_digest
        && workflow.dispatch.workflow_graph_digest.as_deref()
            == Some(p.workflow_graph_digest.as_str())
        && workflow.dispatch.workflow_graph_declaration_event_ref
            == Some(p.workflow_graph_declaration_event_ref)
        && workflow.dispatch.capability_bundle_digest == body.capability_bundle_digest
        && workflow.dispatch.acceptance_contract_digest == body.acceptance_contract_digest
        && workflow.dispatch.context_manifest_digest == body.context_manifest_digest
        && workflow.dispatch.worker_manifest_digest == body.worker_manifest_digest
        && workflow.dispatch.sandbox_profile_digest == body.sandbox_profile_digest
        && workflow.dispatch.execution_role == body.execution_role
        && workflow.dispatch.commit_mode == body.commit_mode
        && workflow.dispatch.budget == body.budget
        && workflow.dispatch.trust_tier == body.trust_tier
        && workflow.dispatch.idempotency_key == body.idempotency_key
        && workflow.dispatch.issued_at == body.issued_at
        && workflow.dispatch.expires_at == body.expires_at
        && workflow.dispatch.signature_ref.is_none()
        && workflow.dispatch.action_evidence_version == Some(nested.action_evidence_version)
}

fn candidate_matches_dispatch(workflow: &WorkflowInstanceV1, p: &CandidateCreatedV1) -> bool {
    workflow.workflow_id == p.workflow_id
        && workflow.unit_id == p.unit_id
        && workflow.attempt == p.attempt
        && workflow.dispatch.provenance_ref == p.provenance_ref
        && workflow.dispatch.base_commit_sha == p.base_commit_sha
        && workflow.dispatch.envelope_digest == p.envelope_digest
}

fn candidate_matches_existing(
    existing: &CandidateArtifactReplayState,
    event_id: EventId,
    p: &CandidateCreatedV1,
) -> bool {
    existing.event_id == event_id
        && existing.candidate_id == p.candidate_id
        && existing.candidate_ref == p.candidate_ref
        && existing.candidate_digest == p.candidate_digest
        && existing.base_commit_sha == p.base_commit_sha
        && existing.candidate_commit_sha == p.candidate_commit_sha
        && existing.commit_digest == p.commit_digest
        && existing.tree_digest == p.tree_digest
        && existing.patch_digest == p.patch_digest
        && existing.changed_files_digest == p.changed_files_digest
        && existing.envelope_digest == p.envelope_digest
        && existing.action_receipt_digest.as_deref() == Some(p.action_receipt_digest.as_str())
        && existing.action_receipt_set_ref.is_none()
        && existing.action_receipt_set_digest.is_none()
}

fn candidate_v2_matches_dispatch(workflow: &WorkflowInstanceV1, p: &CandidateCreatedV2) -> bool {
    workflow.workflow_id == p.workflow_id
        && workflow.unit_id == p.unit_id
        && workflow.attempt == p.attempt
        && workflow.dispatch.provenance_ref == p.provenance_ref
        && workflow.dispatch.base_commit_sha == p.base_commit_sha
        && workflow.dispatch.envelope_digest == p.envelope_digest
}

fn candidate_v2_matches_existing(
    existing: &CandidateArtifactReplayState,
    event_id: EventId,
    p: &CandidateCreatedV2,
) -> bool {
    existing.event_id == event_id
        && existing.candidate_id == p.candidate_id
        && existing.candidate_ref == p.candidate_ref
        && existing.candidate_digest == p.candidate_digest
        && existing.base_commit_sha == p.base_commit_sha
        && existing.candidate_commit_sha == p.candidate_commit_sha
        && existing.commit_digest == p.commit_digest
        && existing.tree_digest == p.tree_digest
        && existing.patch_digest == p.patch_digest
        && existing.changed_files_digest == p.changed_files_digest
        && existing.envelope_digest == p.envelope_digest
        && existing.action_receipt_digest.is_none()
        && existing.action_receipt_set_ref.as_deref() == Some(p.action_receipt_set_ref.as_str())
        && existing.action_receipt_set_digest.as_deref()
            == Some(p.action_receipt_set_digest.as_str())
}

fn candidate_completion_matches_existing(
    existing: &CandidateCompletionReplayState,
    event: &Event,
    p: &CandidateCompletionRecordedV1,
) -> bool {
    existing.event_id == event.id && existing.completion == *p
}

fn candidate_acceptance_matches_existing(
    existing: &CandidateAcceptanceReplayState,
    event_id: EventId,
    p: &CandidateAcceptanceRecordedV1,
) -> bool {
    existing.event_id == event_id
        && existing.candidate_digest == p.candidate_digest
        && existing.candidate_commit_sha == p.candidate_commit_sha
        && existing.acceptance_ref == p.acceptance_ref
        && existing.acceptance_contract_digest == p.acceptance_contract_digest
        && existing.acceptance_digest == p.acceptance_digest
        && existing.outcome == p.outcome
        && existing.evaluated_at == p.evaluated_at
}

fn review_matches_existing(
    existing: &ReviewVerdictReplayState,
    event_id: EventId,
    p: &ReviewVerdictRecordedV1,
) -> bool {
    existing.event_id == event_id
        && existing.review_version == 1
        && existing.candidate_digest == p.candidate_digest
        && existing.candidate_commit_sha == p.candidate_commit_sha
        && existing.review_ref == p.review_ref
        && existing.decision == p.decision
        && existing.findings == p.findings
        && existing.confidence.to_bits() == p.confidence.to_bits()
        && existing.reviewer_manifest_digest == p.reviewer_manifest_digest
        && existing.review_verdict_action_id.is_none()
        && existing.review_action_request_digest.is_none()
        && existing.review_action_receipt_ref.is_none()
        && existing.review_action_receipt_digest.is_none()
        && existing.review_output_ref.is_none()
        && existing.review_output_digest.is_none()
        && existing.acceptance_ref.is_none()
        && existing.acceptance_digest.is_none()
        && existing.acceptance_contract_digest.is_none()
        && existing.candidate_envelope_digest.is_none()
        && existing.reviewer_workflow_id.is_none()
        && existing.reviewer_dispatch_envelope_digest.is_none()
        && existing.reviewer_unit_id.is_none()
        && existing.reviewer_attempt.is_none()
        && existing.reviewer_execution_role.is_none()
        && existing.review_action_receipt_set_ref.is_none()
        && existing.review_action_receipt_set_digest.is_none()
        && existing.candidate_view.is_none()
        && existing.candidate_view_ref.is_none()
        && existing.candidate_view_digest.is_none()
        && existing.reviewer_authority.is_none()
        && existing.reviewed_at == p.reviewed_at
}

fn review_v2_matches_existing(
    existing: &ReviewVerdictReplayState,
    event_id: EventId,
    p: &ReviewVerdictRecordedV2,
) -> bool {
    existing.event_id == event_id
        && existing.review_version == 2
        && existing.candidate_digest == p.candidate_digest
        && existing.candidate_commit_sha == p.candidate_commit_sha
        && existing.review_ref == p.review_ref
        && existing.decision == p.decision
        && existing.findings == p.findings
        && existing.confidence.to_bits() == p.confidence.to_bits()
        && existing.reviewer_manifest_digest == p.reviewer_manifest_digest
        && existing.review_verdict_action_id.as_deref() == Some(p.review_verdict_action_id.as_str())
        && existing.review_action_request_digest.as_deref()
            == Some(p.review_action_request_digest.as_str())
        && existing.review_action_receipt_ref.as_deref()
            == Some(p.review_action_receipt_ref.as_str())
        && existing.review_action_receipt_digest.as_deref()
            == Some(p.review_action_receipt_digest.as_str())
        && existing.review_output_ref.as_deref() == Some(p.review_output_ref.as_str())
        && existing.review_output_digest.as_deref() == Some(p.review_output_digest.as_str())
        && existing.acceptance_ref.as_deref() == Some(p.acceptance_ref.as_str())
        && existing.acceptance_digest.as_deref() == Some(p.acceptance_digest.as_str())
        && existing.acceptance_contract_digest.as_deref()
            == Some(p.acceptance_contract_digest.as_str())
        && existing.candidate_envelope_digest.as_deref()
            == Some(p.candidate_envelope_digest.as_str())
        && existing.reviewer_workflow_id.as_deref() == Some(p.reviewer_workflow_id.as_str())
        && existing.reviewer_dispatch_envelope_digest.as_deref()
            == Some(p.reviewer_dispatch_envelope_digest.as_str())
        && existing.reviewer_unit_id.as_deref() == Some(p.reviewer_unit_id.as_str())
        && existing.reviewer_attempt == Some(p.reviewer_attempt)
        && existing.reviewer_execution_role == Some(p.reviewer_execution_role)
        && existing.review_action_receipt_set_ref.as_deref()
            == Some(p.review_action_receipt_set_ref.as_str())
        && existing.review_action_receipt_set_digest.as_deref()
            == Some(p.review_action_receipt_set_digest.as_str())
        && existing.candidate_view.as_ref() == Some(&p.candidate_view)
        && existing.candidate_view_ref.as_deref() == Some(p.candidate_view_ref.as_str())
        && existing.candidate_view_digest.as_deref() == Some(p.candidate_view_digest.as_str())
        && existing.reviewer_authority.as_deref() == Some(p.reviewer_authority.as_str())
        && existing.reviewed_at == p.reviewed_at
}

fn promotion_decision_matches_existing(
    existing: &PromotionDecisionReplayState,
    event_id: EventId,
    p: &PromotionDecisionRecordedV1,
    event_digest: &str,
) -> bool {
    existing.event_id == event_id
        && existing.event_digest == event_digest
        && existing.candidate_digest == p.candidate_digest
        && existing.base_commit_sha == p.base_commit_sha
        && existing.target_ref == p.target_ref
        && existing.envelope_digest == p.envelope_digest
        && existing.acceptance_ref == p.acceptance_ref
        && existing.review_refs == p.review_refs
        && existing.promotion_approval_request_ref == p.promotion_approval_request_ref
        && existing.decision == p.decision
        && existing.authority == p.authority
        && existing.decided_by == p.decided_by
        && existing.decided_at == p.decided_at
        && existing.idempotency_key == p.idempotency_key
}

fn promotion_execution_claim_matches_existing(
    existing: &PromotionExecutionClaimReplayState,
    event_id: EventId,
    p: &PromotionExecutionClaimedV1,
    event_digest: &str,
) -> bool {
    existing.event_id == event_id && existing.event_digest == event_digest && &existing.claim == p
}

fn promotion_approval_request_matches_existing(
    existing: &PromotionApprovalRequestReplayState,
    event_id: EventId,
    p: &PromotionApprovalRequestedV1,
) -> bool {
    existing.event_id == event_id
        && existing.candidate_digest == p.candidate_digest
        && existing.base_commit_sha == p.base_commit_sha
        && existing.target_ref == p.target_ref
        && existing.envelope_digest == p.envelope_digest
        && existing.acceptance_ref == p.acceptance_ref
        && existing.review_refs == p.review_refs
        && existing.requested_by == p.requested_by
        && existing.requested_at == p.requested_at
        && existing.idempotency_key == p.idempotency_key
}

fn promotion_decision_binds_approval_request(
    decision: &PromotionDecisionRecordedV1,
    request: &PromotionApprovalRequestReplayState,
) -> bool {
    let request_ref = request.event_id.to_string();
    decision.promotion_approval_request_ref.as_deref() == Some(request_ref.as_str())
        && decision.candidate_digest == request.candidate_digest
        && decision.base_commit_sha == request.base_commit_sha
        && decision.target_ref.as_deref() == Some(request.target_ref.as_str())
        && decision.envelope_digest == request.envelope_digest
        && decision.acceptance_ref == request.acceptance_ref
        && decision.review_refs == request.review_refs
        && decision.idempotency_key == request.idempotency_key
}

fn promotion_result_matches_existing(
    existing: &PromotionResultReplayState,
    event_id: EventId,
    p: &PromotionResultRecordedV1,
    event_digest: &str,
) -> bool {
    existing.event_id == event_id
        && existing.event_digest == event_digest
        && existing.candidate_digest == p.candidate_digest
        && existing.idempotency_key == p.idempotency_key
        && existing.promotion_decision_ref == p.promotion_decision_ref
        && existing.outcome == p.outcome
        && existing.merged_head_sha == p.merged_head_sha
        && existing.promotion_git_binding == p.promotion_git_binding
        && existing.promotion_execution_lease_binding == p.promotion_execution_lease_binding
        && existing.completed_at == p.completed_at
}

fn promotion_reconciliation_matches_existing(
    existing: &PromotionReconciliationReplayState,
    event_id: EventId,
    p: &PromotionReconciliationResolvedV1,
    event_digest: &str,
) -> bool {
    existing.event_id == event_id
        && existing.event_digest == event_digest
        && existing.candidate_digest == p.candidate_digest
        && existing.promotion_decision_ref == p.promotion_decision_ref
        && existing.promotion_result_ref == p.promotion_result_ref
        && existing.promotion_receipt_ref == p.promotion_receipt_ref
        && existing.outcome == p.outcome
        && existing.authority == p.authority
        && existing.resolved_by == p.resolved_by
        && existing.idempotency_key == p.idempotency_key
        && existing.resolved_at == p.resolved_at
}

fn workflow_timer_schedule_matches_existing(
    existing: &WorkflowTimerReplayState,
    event: &Event,
    p: &WorkflowTimerScheduledV1,
    event_digest: &str,
) -> bool {
    existing.event_id == event.id
        && existing.event_digest == event_digest
        && existing.run_id == p.run_id
        && existing.workflow_id == p.workflow_id
        && existing.workflow_revision == p.workflow_revision
        && existing.unit_id == p.unit_id
        && existing.attempt == p.attempt
        && existing.dispatch_event_ref == p.dispatch_event_ref
        && existing.dispatch_envelope_digest == p.dispatch_envelope_digest
        && existing.timer_id == p.timer_id
        && existing.timer_kind == p.timer_kind
        && existing.due_at == p.due_at
        && existing.idempotency_key == p.idempotency_key
        && existing.scheduled_by == p.scheduled_by
        && existing.scheduled_at == p.scheduled_at
}

fn workflow_timer_fired_matches_existing(
    existing: &WorkflowTimerFiredReplayState,
    event: &Event,
    p: &WorkflowTimerFiredV1,
    event_digest: &str,
) -> bool {
    existing.event_id == event.id
        && existing.event_digest == event_digest
        && existing.timer_schedule_event_ref == p.timer_schedule_event_ref
        && existing.timer_schedule_event_digest == p.timer_schedule_event_digest
        && existing.fired_by == p.fired_by
        && existing.fired_at == p.fired_at
}

fn workflow_cancellation_matches_existing(
    existing: &WorkflowCancellationReplayState,
    event: &Event,
    p: &WorkflowCancellationRequestedV1,
    event_digest: &str,
) -> bool {
    existing.event_id == event.id
        && existing.event_digest == event_digest
        && existing.cancellation_id == p.cancellation_id
        && existing.cause == p.cause
        && existing.timer_fired_event_ref == p.timer_fired_event_ref
        && existing.timer_fired_event_digest == p.timer_fired_event_digest
        && existing.requested_by == p.requested_by
        && existing.idempotency_key == p.idempotency_key
        && existing.requested_at == p.requested_at
}

fn workflow_terminal_matches_existing(
    existing: &WorkflowTerminalReplayState,
    terminal: &WorkflowTerminalFields,
    terminal_version: u8,
) -> bool {
    existing.terminal_version == terminal_version
        && existing.outcome == terminal.outcome
        && existing.unit_id == terminal.unit_id
        && existing.attempt == terminal.attempt
        && existing.candidate_digest == terminal.candidate_digest
        && existing.promotion_result_ref == terminal.promotion_result_ref
        && existing.reconciliation_resolution_ref == terminal.reconciliation_resolution_ref
        && existing.cancellation_request_event_ref == terminal.cancellation_request_event_ref
        && existing.cancellation_request_event_digest == terminal.cancellation_request_event_digest
        && existing.reason == terminal.reason
        && existing.idempotency_key == terminal.idempotency_key
        && existing.completed_at == terminal.completed_at
}

fn review_refs_are_approved(workflow: &WorkflowInstanceV1, review_refs: &[String]) -> bool {
    let requires_v2_review_evidence = workflow.dispatch.dispatch_version >= 3;
    let mut seen = std::collections::BTreeSet::new();
    review_refs.iter().all(|review_ref| {
        seen.insert(review_ref)
            && workflow.reviews.get(review_ref).is_some_and(|verdict| {
                verdict.decision == ReviewDecisionV1::Approve
                    && (!requires_v2_review_evidence || verdict.review_version == 2)
            })
    })
}

fn review_refs_exist(workflow: &WorkflowInstanceV1, review_refs: &[String]) -> bool {
    let requires_v2_review_evidence = workflow.dispatch.dispatch_version >= 3;
    let mut seen = std::collections::BTreeSet::new();
    review_refs.iter().all(|review_ref| {
        seen.insert(review_ref)
            && workflow
                .reviews
                .get(review_ref)
                .is_some_and(|verdict| !requires_v2_review_evidence || verdict.review_version == 2)
    })
}

fn promotion_result_is_semantically_valid(
    workflow: &WorkflowInstanceV1,
    promotion: &PromotionReplayState,
    p: &PromotionResultRecordedV1,
) -> bool {
    match (promotion.decision.decision, p.outcome) {
        (PromotionDecisionKindV1::Promote, PromotionResultOutcomeV1::Promoted) => {
            promotion_result_has_bound_merge_evidence(
                workflow,
                promotion,
                p,
                // A strict binding with any declared checkout state has not
                // reconciled the root worktree. Promoted remains only for the
                // legacy unbound compatibility path.
                &[],
            )
        }
        (PromotionDecisionKindV1::Promote, PromotionResultOutcomeV1::ReconciliationRequired) => {
            promotion_result_has_bound_merge_evidence(
                workflow,
                promotion,
                p,
                &[
                    PromotionWorktreeSyncStateV1::RootCheckoutStale,
                    PromotionWorktreeSyncStateV1::TargetAdvanced,
                ],
            )
        }
        (PromotionDecisionKindV1::Promote, PromotionResultOutcomeV1::Rejected)
        | (PromotionDecisionKindV1::Reject, PromotionResultOutcomeV1::Rejected) => {
            // A rejection records no Git mutation. This remains true for
            // historical unbound decisions: old legitimate records simply
            // omit the later-added binding field, while a nonempty binding is
            // contradictory evidence and cannot advance replay state.
            p.merged_head_sha.is_none() && p.promotion_git_binding.is_none()
        }
        (
            PromotionDecisionKindV1::Reject,
            PromotionResultOutcomeV1::Promoted | PromotionResultOutcomeV1::ReconciliationRequired,
        ) => false,
    }
}

fn promotion_reconciliation_is_semantically_valid(p: &PromotionReconciliationResolvedV1) -> bool {
    !p.candidate_digest.trim().is_empty()
        && !p.promotion_decision_ref.trim().is_empty()
        && !p.promotion_result_ref.trim().is_empty()
        && !p.promotion_receipt_ref.trim().is_empty()
        && !p.authority.trim().is_empty()
        && p.authority == p.resolved_by
        && !p.idempotency_key.trim().is_empty()
        && parse_rfc3339_utc(&p.resolved_at).is_some()
}

fn promotion_result_has_bound_merge_evidence(
    workflow: &WorkflowInstanceV1,
    promotion: &PromotionReplayState,
    p: &PromotionResultRecordedV1,
    allowed_sync_states: &[PromotionWorktreeSyncStateV1],
) -> bool {
    let Some(merged_head_sha) = p.merged_head_sha.as_deref() else {
        return false;
    };
    if !is_canonical_git_object_id(merged_head_sha) {
        return false;
    }
    if requires_candidate_completion(workflow) && promotion.decision.target_ref.is_none() {
        // Defensive replay guard for a previously projected/corrupt state: a
        // sealed-v3 candidate may never complete through the historical
        // unbound-result compatibility path.
        return false;
    }
    match promotion.decision.target_ref.as_deref() {
        // Historical pre-binding records remain readable only when the
        // binding itself is absent. A partial/new binding cannot smuggle a
        // syntactically valid unrelated merge through the legacy path.
        None => p.promotion_git_binding.is_none(),
        Some(target_ref) => p.promotion_git_binding.as_ref().is_some_and(|binding| {
            promotion_git_binding_matches_candidate(
                workflow,
                target_ref,
                &promotion.decision.base_commit_sha,
                merged_head_sha,
                allowed_sync_states,
                binding,
            )
        }),
    }
}

fn promotion_git_binding_matches_candidate(
    workflow: &WorkflowInstanceV1,
    target_ref: &str,
    decision_base_commit_sha: &str,
    merged_head_sha: &str,
    allowed_sync_states: &[PromotionWorktreeSyncStateV1],
    binding: &PromotionGitBindingV1,
) -> bool {
    workflow.candidate.as_ref().is_some_and(|candidate| {
        let Some(target_head_after_sha) = binding.target_head_after_sha.as_deref() else {
            return false;
        };
        let Some(binding_merged_head_sha) = binding.merged_head_sha.as_deref() else {
            return false;
        };
        let Some(merge_parent_shas) = binding.merge_parent_shas.as_deref() else {
            return false;
        };
        let Some(merged_tree_sha) = binding.merged_tree_sha.as_deref() else {
            return false;
        };
        let Some(promotion_receipt_ref) = binding.promotion_receipt_ref.as_deref() else {
            return false;
        };
        let Some(worktree_sync_state) = binding.worktree_sync_state else {
            return false;
        };
        is_canonical_target_ref(&binding.target_ref)
            && binding.target_ref == target_ref
            && binding.target_head_before_sha == decision_base_commit_sha
            && binding.target_head_before_sha == candidate.base_commit_sha
            && is_canonical_git_object_id(&binding.target_head_before_sha)
            && is_canonical_git_object_id(target_head_after_sha)
            && binding_merged_head_sha == merged_head_sha
            && is_canonical_git_object_id(binding_merged_head_sha)
            && binding.candidate_commit_sha == candidate.candidate_commit_sha
            && is_canonical_git_object_id(&binding.candidate_commit_sha)
            && merge_parent_shas.len() == 2
            && merge_parent_shas[0] == binding.target_head_before_sha
            && merge_parent_shas[1] == binding.candidate_commit_sha
            && merge_parent_shas
                .iter()
                .all(|sha| is_canonical_git_object_id(sha))
            && is_canonical_git_object_id(merged_tree_sha)
            && binding.merged_tree_digest == candidate.tree_digest
            && is_canonical_sha256_digest(&binding.merged_tree_digest)
            && promotion_receipt_ref_matches_candidate(
                promotion_receipt_ref,
                &candidate.candidate_ref,
            )
            && allowed_sync_states.contains(&worktree_sync_state)
            && match worktree_sync_state {
                PromotionWorktreeSyncStateV1::PendingReconciliation
                | PromotionWorktreeSyncStateV1::RootCheckoutStale => {
                    target_head_after_sha == merged_head_sha
                }
                PromotionWorktreeSyncStateV1::TargetAdvanced => {
                    target_head_after_sha != merged_head_sha
                }
            }
    })
}

fn promotion_receipt_ref_matches_candidate(receipt_ref: &str, candidate_ref: &str) -> bool {
    if !is_canonical_buildplane_candidate_ref(candidate_ref) {
        return false;
    }
    let candidate_suffix = candidate_ref
        .strip_prefix(BUILDPANE_CANDIDATE_REF_PREFIX)
        .expect("validated candidate refs always have the Buildplane prefix");
    receipt_ref == format!("refs/buildplane/promotions/{candidate_suffix}")
}

fn workflow_terminal_is_semantically_valid(
    workflow: &WorkflowInstanceV1,
    terminal: &WorkflowTerminalFields,
    terminal_version: u8,
    event: &Event,
) -> bool {
    if terminal_version == 2 && terminal.outcome == WorkflowTerminalOutcomeV1::Cancelled {
        return workflow.phase == WorkflowPhaseV1::CancellationRequested
            && workflow.cancellation.as_ref().is_some_and(|cancellation| {
                terminal.cancellation_request_event_ref == Some(cancellation.event_id)
                    && terminal.cancellation_request_event_digest.as_deref()
                        == Some(cancellation.event_digest.as_str())
                    && event.parent_event_id == Some(cancellation.event_id)
            })
            && terminal.promotion_result_ref.is_none()
            && terminal.reconciliation_resolution_ref.is_none()
            && cancellation_effects_are_reconciled(workflow);
    }
    if workflow.cancellation.is_some() {
        // Once a signed cancellation exists, V2 cancellation is the only
        // permitted terminal transition and it must bind that exact request.
        return false;
    }
    if let Some(resolution) = workflow
        .promotion
        .as_ref()
        .and_then(|promotion| promotion.reconciliation.as_ref())
    {
        let Some(result) = workflow
            .promotion
            .as_ref()
            .and_then(|promotion| promotion.result.as_ref())
        else {
            return false;
        };
        let result_ref = result.event_id.to_string();
        let resolution_ref = resolution.event_id.to_string();
        return workflow.phase == WorkflowPhaseV1::PromotionReconciliationResolved
            && result.outcome == PromotionResultOutcomeV1::ReconciliationRequired
            && terminal.candidate_digest.is_some()
            && terminal.promotion_result_ref.as_deref() == Some(result_ref.as_str())
            && terminal.reconciliation_resolution_ref.as_deref() == Some(resolution_ref.as_str())
            && matches!(
                (resolution.outcome, terminal.outcome),
                (
                    ReconciliationResolutionOutcomeV1::Abandon,
                    WorkflowTerminalOutcomeV1::Failed
                ) | (
                    ReconciliationResolutionOutcomeV1::Reject,
                    WorkflowTerminalOutcomeV1::Cancelled
                )
            );
    }
    if workflow
        .promotion
        .as_ref()
        .and_then(|promotion| promotion.result.as_ref())
        .is_some_and(|result| result.outcome == PromotionResultOutcomeV1::ReconciliationRequired)
    {
        // A target rewrite must be resolved explicitly by an authorized
        // operator. A plain failed/cancelled terminal would hide that fact and
        // make the immutable promotion result look silently settled.
        return false;
    }
    if terminal.reconciliation_resolution_ref.is_some() {
        return false;
    }
    match terminal.outcome {
        WorkflowTerminalOutcomeV1::Completed => {
            workflow.phase == WorkflowPhaseV1::Promoted
                && workflow.promotion.as_ref().is_some_and(|promotion| {
                    promotion.decision.target_ref.is_none()
                        && promotion.result.as_ref().is_some_and(|result| {
                            result.outcome == PromotionResultOutcomeV1::Promoted
                                && result.promotion_git_binding.is_none()
                        })
                })
                && terminal.candidate_digest.is_some()
                && terminal.promotion_result_ref.is_some()
        }
        WorkflowTerminalOutcomeV1::Failed | WorkflowTerminalOutcomeV1::Cancelled => {
            // A promote decision is write-ahead intent, not a final outcome.
            // If a process crashes after the Git CAS succeeds but before the
            // result event is durably appended, accepting a failed terminal
            // here would make the later reconciliation result impossible to
            // record. Keep the workflow recoverable until that exact effect
            // has a recorded result.
            workflow.phase != WorkflowPhaseV1::Promoted
                && !workflow.promotion.as_ref().is_some_and(|promotion| {
                    promotion.decision.decision == PromotionDecisionKindV1::Promote
                        && promotion.result.is_none()
                })
        }
    }
}

fn is_canonical_git_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_canonical_target_ref(value: &str) -> bool {
    let Some(branch) = value.strip_prefix("refs/heads/") else {
        return false;
    };
    if branch.is_empty()
        || branch.ends_with('/')
        || branch.ends_with('.')
        || branch.ends_with(".lock")
        || branch.contains("..")
        || branch.contains("//")
        || branch.contains("@{")
    {
        return false;
    }
    branch.split('/').all(|component| {
        !component.is_empty()
            && !component.starts_with('.')
            && !component.ends_with('.')
            && component != "@"
            && component.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '@')
            })
    })
}

fn is_canonical_sha256_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn parse_rfc3339_utc(value: &str) -> Option<chrono::DateTime<Utc>> {
    if !value.ends_with('Z') {
        return None;
    }
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| timestamp.with_timezone(&Utc))
}

/// V4 graph-bound dispatches must use timestamps the native reducer can
/// represent exactly. Historical dispatch versions retain the legacy parser.
fn validate_v4_rfc3339_utc_fractional_second_precision(
    field: &str,
    value: &str,
) -> Result<(), String> {
    let fraction = value
        .strip_suffix('Z')
        .and_then(|without_utc_suffix| without_utc_suffix.rsplit_once('.'))
        .map(|(_, fraction)| fraction);
    if fraction.is_some_and(|fraction| fraction.len() > 9) {
        return Err(format!(
            "dispatch envelope {field} fractional seconds must contain at most 9 digits for graph-bound V4 dispatch"
        ));
    }
    Ok(())
}

struct DispatchEnvelopeAuthorityFields<'a> {
    workflow_id: &'a str,
    workflow_revision: &'a str,
    unit_id: &'a str,
    attempt: u32,
    provenance_ref: &'a str,
    base_commit_sha: &'a str,
    capability_bundle_digest: &'a str,
    acceptance_contract_digest: &'a str,
    context_manifest_digest: &'a str,
    worker_manifest_digest: &'a str,
    sandbox_profile_digest: &'a str,
    budget: &'a DispatchBudgetV1,
    trust_tier: TrustTierV1,
    commit_mode: CommitModeV1,
    idempotency_key: &'a str,
    issued_at: &'a str,
    expires_at: &'a str,
}

fn dispatch_envelope_authority_fields_v1(
    p: &DispatchEnvelopeV1,
) -> DispatchEnvelopeAuthorityFields<'_> {
    DispatchEnvelopeAuthorityFields {
        workflow_id: &p.workflow_id,
        workflow_revision: &p.workflow_revision,
        unit_id: &p.unit_id,
        attempt: p.attempt,
        provenance_ref: &p.provenance_ref,
        base_commit_sha: &p.base_commit_sha,
        capability_bundle_digest: &p.capability_bundle_digest,
        acceptance_contract_digest: &p.acceptance_contract_digest,
        context_manifest_digest: &p.context_manifest_digest,
        worker_manifest_digest: &p.worker_manifest_digest,
        sandbox_profile_digest: &p.sandbox_profile_digest,
        budget: &p.budget,
        trust_tier: p.trust_tier,
        commit_mode: p.commit_mode,
        idempotency_key: &p.idempotency_key,
        issued_at: &p.issued_at,
        expires_at: &p.expires_at,
    }
}

fn dispatch_envelope_authority_fields_v2(
    body: &DispatchEnvelopeBodyV2,
) -> DispatchEnvelopeAuthorityFields<'_> {
    DispatchEnvelopeAuthorityFields {
        workflow_id: &body.workflow_id,
        workflow_revision: &body.workflow_revision,
        unit_id: &body.unit_id,
        attempt: body.attempt,
        provenance_ref: &body.provenance_ref,
        base_commit_sha: &body.base_commit_sha,
        capability_bundle_digest: &body.capability_bundle_digest,
        acceptance_contract_digest: &body.acceptance_contract_digest,
        context_manifest_digest: &body.context_manifest_digest,
        worker_manifest_digest: &body.worker_manifest_digest,
        sandbox_profile_digest: &body.sandbox_profile_digest,
        budget: &body.budget,
        trust_tier: body.trust_tier,
        commit_mode: body.commit_mode,
        idempotency_key: &body.idempotency_key,
        issued_at: &body.issued_at,
        expires_at: &body.expires_at,
    }
}

fn validate_dispatch_envelope(p: &DispatchEnvelopeV1) -> Result<(), String> {
    validate_dispatch_envelope_authority_fields(dispatch_envelope_authority_fields_v1(p))?;
    if !is_canonical_sha256_digest(&p.envelope_digest) {
        return Err("dispatch envelope envelope_digest must be a canonical sha256 digest".into());
    }
    for (field, value) in [
        ("signature_ref.key_id", p.signature_ref.key_id.as_str()),
        (
            "signature_ref.signature",
            p.signature_ref.signature.as_str(),
        ),
    ] {
        if value.trim().is_empty() {
            return Err(format!("dispatch envelope {field} must be non-empty"));
        }
    }
    if p.signature_ref.algorithm != "ed25519" {
        return Err("dispatch envelope signature_ref.algorithm must be ed25519".into());
    }
    Ok(())
}

fn validate_dispatch_envelope_v2(p: &DispatchEnvelopeV2) -> Result<(), String> {
    let expected_digest = dispatch_envelope_v2_body_digest(&p.body)
        .map_err(|error| format!("dispatch envelope v2 body could not be serialized: {error}"))?;
    if p.envelope_digest != expected_digest {
        return Err(
            "dispatch envelope v2 envelope_digest does not match the canonical body digest".into(),
        );
    }
    validate_dispatch_envelope_authority_fields(dispatch_envelope_authority_fields_v2(&p.body))
}

fn validate_dispatch_envelope_v3(p: &DispatchEnvelopeV3) -> Result<(), String> {
    let expected_digest = dispatch_envelope_v3_body_digest(
        &p.body,
        p.action_evidence_version,
        &p.repository_binding_digest,
        &p.ledger_authority_realm_digest,
        p.governed_packet_digest.as_deref(),
    )
    .map_err(|error| format!("dispatch envelope v3 body could not be serialized: {error}"))?;
    if p.envelope_digest != expected_digest {
        return Err(
            "dispatch envelope v3 envelope_digest does not match the canonical body digest".into(),
        );
    }
    if !matches!(
        p.action_evidence_version,
        ActionEvidenceVersionV1::SealedV2 | ActionEvidenceVersionV1::SealedV3
    ) {
        return Err("dispatch envelope v3 has an unsupported action evidence version".into());
    }
    if !is_canonical_sha256_digest(&p.repository_binding_digest) {
        return Err(
            "dispatch envelope v3 repository_binding_digest must be a canonical sha256 digest"
                .into(),
        );
    }
    if !is_canonical_sha256_digest(&p.ledger_authority_realm_digest) {
        return Err(
            "dispatch envelope v3 ledger_authority_realm_digest must be a canonical sha256 digest"
                .into(),
        );
    }
    if p.action_evidence_version == ActionEvidenceVersionV1::SealedV3
        && !p
            .governed_packet_digest
            .as_deref()
            .is_some_and(is_canonical_sha256_digest)
    {
        return Err(
            "sealed_v3 dispatch envelope requires a canonical governed_packet_digest".into(),
        );
    }
    validate_dispatch_envelope_authority_fields(dispatch_envelope_authority_fields_v2(&p.body))
}

fn validate_dispatch_envelope_v4(p: &DispatchEnvelopeV4) -> Result<(), String> {
    validate_v4_rfc3339_utc_fractional_second_precision(
        "issued_at",
        &p.dispatch_v3.body.issued_at,
    )?;
    validate_v4_rfc3339_utc_fractional_second_precision(
        "expires_at",
        &p.dispatch_v3.body.expires_at,
    )?;
    validate_dispatch_envelope_v3(&p.dispatch_v3)?;
    let nested = &p.dispatch_v3;
    if nested.body.trust_tier != TrustTierV1::Governed
        || nested.body.commit_mode != CommitModeV1::Atomic
        || nested.action_evidence_version != ActionEvidenceVersionV1::SealedV3
        || !nested
            .governed_packet_digest
            .as_deref()
            .is_some_and(is_canonical_sha256_digest)
    {
        return Err(
            "graph-bound V4 dispatch requires governed atomic sealed_v3 authority with a canonical governed_packet_digest"
                .into(),
        );
    }
    if !is_canonical_sha256_digest(&p.workflow_graph_digest) {
        return Err(
            "graph-bound V4 dispatch workflow_graph_digest must be a canonical sha256 digest"
                .into(),
        );
    }
    let expected_digest = dispatch_envelope_v4_digest(
        &p.dispatch_v3,
        &p.workflow_graph_digest,
        &p.workflow_graph_declaration_event_ref,
    )
    .map_err(|error| format!("dispatch envelope v4 body could not be serialized: {error}"))?;
    if p.envelope_digest != expected_digest {
        return Err(
            "dispatch envelope v4 envelope_digest does not match the canonical body digest".into(),
        );
    }
    Ok(())
}

fn validate_dispatch_envelope_authority_fields(
    p: DispatchEnvelopeAuthorityFields<'_>,
) -> Result<(), String> {
    for (field, value) in [
        ("workflow_id", p.workflow_id),
        ("workflow_revision", p.workflow_revision),
        ("unit_id", p.unit_id),
        ("provenance_ref", p.provenance_ref),
        ("idempotency_key", p.idempotency_key),
    ] {
        if value.trim().is_empty() {
            return Err(format!("dispatch envelope {field} must be non-empty"));
        }
    }
    if p.attempt == 0 {
        return Err("dispatch envelope attempt must be greater than zero".into());
    }
    if !is_canonical_git_object_id(p.base_commit_sha) {
        return Err(
            "dispatch envelope base_commit_sha must be a full canonical Git object ID".into(),
        );
    }
    for (field, value) in [
        ("capability_bundle_digest", p.capability_bundle_digest),
        ("acceptance_contract_digest", p.acceptance_contract_digest),
        ("context_manifest_digest", p.context_manifest_digest),
        ("worker_manifest_digest", p.worker_manifest_digest),
        ("sandbox_profile_digest", p.sandbox_profile_digest),
    ] {
        if !is_canonical_sha256_digest(value) {
            return Err(format!(
                "dispatch envelope {field} must be a canonical sha256 digest"
            ));
        }
    }
    if p.budget.max_tokens.is_some_and(|tokens| tokens == 0)
        || p.budget
            .max_compute_time_ms
            .is_some_and(|milliseconds| milliseconds == 0)
    {
        return Err(
            "dispatch envelope budget limits must be greater than zero when present".into(),
        );
    }
    let issued_at = parse_rfc3339_utc(p.issued_at).ok_or_else(|| {
        "dispatch envelope issued_at must be an RFC3339 UTC timestamp".to_string()
    })?;
    let expires_at = parse_rfc3339_utc(p.expires_at).ok_or_else(|| {
        "dispatch envelope expires_at must be an RFC3339 UTC timestamp".to_string()
    })?;
    if expires_at <= issued_at {
        return Err("dispatch envelope expires_at must be later than issued_at".into());
    }
    if p.trust_tier == TrustTierV1::Governed && p.commit_mode != CommitModeV1::Atomic {
        return Err("governed dispatch supports only atomic commit mode".into());
    }
    Ok(())
}

fn reject_workflow_transition(state: &mut ReplayState, event: &Event, reason: String) {
    state.issues.push(ReplayIssue::WorkflowTransitionRejected {
        event_id: event.id,
        event_kind: event.kind.as_wire().to_string(),
        phase: state
            .workflow_instance
            .as_ref()
            .map(|workflow| workflow.phase),
        reason,
    });
}

fn activity_type_wire(activity_type: ActivityType) -> &'static str {
    match activity_type {
        ActivityType::Model => "model",
        ActivityType::Tool => "tool",
        ActivityType::Command => "command",
    }
}

fn plan_receipt_outcome_wire(outcome: PlanReceiptOutcome) -> &'static str {
    match outcome {
        PlanReceiptOutcome::Completed => "completed",
        PlanReceiptOutcome::Failed => "failed",
        PlanReceiptOutcome::Aborted => "aborted",
    }
}

fn apply_tool_request(state: &mut ReplayState, event: &Event, _p: &ToolRequestStoredV1) {
    state.parent_chain.push(event.id);
}

fn apply_tool_result(state: &mut ReplayState, _event: &Event, _p: &ToolResultV1) {
    state.parent_chain.pop();
}

fn apply_workspace_write(state: &mut ReplayState, event: &Event, p: &WorkspaceWriteV1) {
    match &p.after {
        PostWriteState::Captured { hash, .. } => {
            state.observed_files.insert(
                p.path.clone(),
                FileObservation {
                    last_known_hash: hash.clone(),
                    from_event_id: event.id,
                },
            );
        }
        PostWriteState::Unreadable { reason } => {
            state.issues.push(ReplayIssue::UnreadablePostWrite {
                path: p.path.clone(),
                reason: reason.clone(),
            });
        }
    }
}
