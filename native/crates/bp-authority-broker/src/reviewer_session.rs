//! Replay-backed evidence resolution for a future protected reviewer session.
//!
//! This module deliberately resolves only already-verified tape state.  It
//! neither opens a transport session nor authorizes, claims, mounts, executes,
//! or promotes anything.  A protected host must still enforce the returned
//! evidence at its own action boundary before it lets a reviewer observe a
//! candidate.

use crate::admission_protocol::ParsedAuthorityBrokerOpenReviewerSessionRequestV1;
use bp_ledger::payload::trust_spine::{
    candidate_view_v1_digest, ActionEvidenceVersionV1, ActionKindV1, CandidateAcceptanceOutcomeV1,
    CommitModeV1, ExecutionRoleV1, ModelActionCandidateBindingV1, ModelRequestEvidenceV1,
    TrustScopeEvidenceV1, TrustTierV1,
};
use bp_ledger::EventId;
use bp_replay::{
    state::{WorkflowInstanceV1, WorkflowPhaseV1},
    TrustedGovernedRecoverySnapshot,
};
use thiserror::Error;

/// Immutable evidence a protected host may use to construct a reviewer-only
/// model action.  This is evidence, not a capability: it contains no path,
/// prompt bytes, provider credential, sandbox handle, process, mount, verdict,
/// or promotion authority.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ResolvedReviewerModelEvidenceV1 {
    pub(crate) run_id: String,
    pub(crate) candidate_dispatch_event_ref: EventId,
    pub(crate) reviewer_dispatch_event_ref: EventId,
    pub(crate) reviewer_action_request_event_ref: EventId,
    pub(crate) reviewer_dispatch_envelope_digest: String,
    pub(crate) execution_role: ExecutionRoleV1,
    pub(crate) model_request_evidence: ModelRequestEvidenceV1,
    pub(crate) trust_scope_evidence: TrustScopeEvidenceV1,
    pub(crate) candidate: ModelActionCandidateBindingV1,
}

/// A closed failure vocabulary for replay-backed reviewer resolution.  Error
/// variants intentionally describe classes of rejected state rather than
/// returning paths, model input, credentials, or mutable runtime details.
#[derive(Debug, Error, PartialEq, Eq)]
pub(crate) enum ReviewerSessionResolutionErrorV1 {
    #[error("candidate recovery identity is not present in the trusted snapshot")]
    CandidateRecoveryNotFound,
    #[error("candidate recovery has no eligible reviewer activity")]
    ReviewerRecoveryNotFound,
    #[error("candidate recovery resolves to more than one eligible reviewer activity")]
    ReviewerRecoveryAmbiguous,
    #[error("reviewer request run does not match the trusted recovery snapshot")]
    RunMismatch,
    #[error("reviewer dispatch reference is not present in the trusted snapshot")]
    ReviewerDispatchNotFound,
    #[error("reviewer dispatch is not a governed atomic sealed_v3 review workflow")]
    ReviewerDispatchNotGovernedSealedV3,
    #[error("reviewer dispatch has an unsupported execution role")]
    UnsupportedReviewerRole,
    #[error("reviewer workflow is not active for a new reviewer action")]
    ReviewerWorkflowNotActive,
    #[error("reviewer dispatch has no sealed action evidence")]
    ReviewerActionEvidenceMissing,
    #[error("reviewer action request reference is not present in its dispatch")]
    ReviewerActionNotFound,
    #[error("reviewer action request reference resolves to more than one action")]
    ReviewerActionAmbiguous,
    #[error("reviewer action request is not a model action for the signed reviewer role")]
    ReviewerActionNotModelRoleBound,
    #[error("reviewer model action has no candidate-bound write-ahead intent")]
    ReviewerIntentMissing,
    #[error("reviewer model action intent does not match its signed dispatch and request")]
    ReviewerIntentLineageMismatch,
    #[error("reviewer model action has already advanced beyond the pre-effect state")]
    ReviewerActionAlreadyAdvanced,
    #[error("candidate referenced by the reviewer intent is not present in the trusted snapshot")]
    CandidateNotFound,
    #[error("reviewer candidate must belong to a distinct workflow in the same run")]
    CandidateWorkflowMismatch,
    #[error("candidate does not have governed atomic sealed_v3 implementation lineage")]
    CandidateDispatchNotGovernedSealedV3,
    #[error("candidate artifact does not match the reviewer candidate binding")]
    CandidateBindingMismatch,
    #[error("candidate has no matching immutable completion proof")]
    CandidateCompletionMissing,
    #[error("candidate has no passed deterministic acceptance record")]
    CandidateAcceptanceNotPassed,
    #[error("candidate view is not an exact read-only, network-disabled reviewer view")]
    CandidateViewMismatch,
}

/// Derive the one pending reviewer activity from a host-issued candidate
/// recovery identity.
///
/// The untrusted client supplies no reviewer dispatch, action, model, role, or
/// candidate digest. The candidate dispatch reference is recovered from the
/// host's authenticated opaque token, then trusted replay supplies all reviewer
/// candidates. Zero, multiple, stale, cancelled, or already-advanced matches
/// fail closed.
pub(crate) fn resolve_reviewer_model_evidence_for_candidate_recovery_v1(
    snapshot: &TrustedGovernedRecoverySnapshot,
    candidate_dispatch_event_ref: &str,
) -> Result<ResolvedReviewerModelEvidenceV1, ReviewerSessionResolutionErrorV1> {
    let candidate_workflow = snapshot
        .workflow_for_dispatch_event_ref(candidate_dispatch_event_ref)
        .ok_or(ReviewerSessionResolutionErrorV1::CandidateRecoveryNotFound)?;
    validate_candidate_workflow(candidate_workflow)?;
    let candidate = candidate_workflow
        .candidate
        .as_ref()
        .ok_or(ReviewerSessionResolutionErrorV1::CandidateRecoveryNotFound)?;

    let mut resolved = Vec::new();
    for (reviewer_workflow, action_event_ref) in
        snapshot.reviewer_action_candidates_for_candidate_digest(&candidate.candidate_digest)
    {
        let request = ParsedAuthorityBrokerOpenReviewerSessionRequestV1 {
            run_id: snapshot.run_id().to_string(),
            reviewer_dispatch_event_ref: reviewer_workflow.dispatch.event_id.to_string(),
            reviewer_action_request_event_ref: action_event_ref.to_string(),
        };
        if let Ok(evidence) = resolve_reviewer_model_evidence_from_snapshot_v1(snapshot, &request) {
            resolved.push(evidence);
        }
    }

    match resolved.len() {
        1 => Ok(resolved.remove(0)),
        0 => Err(ReviewerSessionResolutionErrorV1::ReviewerRecoveryNotFound),
        _ => Err(ReviewerSessionResolutionErrorV1::ReviewerRecoveryAmbiguous),
    }
}

/// Resolve only an exact, unclaimed reviewer/adversary/judge model action from
/// an already-open trusted recovery snapshot.
///
/// This function is pure over `snapshot` and `request`: it performs no tape,
/// CAS, filesystem, signing, lease, gateway, socket, mount, process, provider,
/// credential, or promotion operation.  In particular, it must be called
/// before a future host creates the reviewer action authorization or activity
/// claim.  Once either exists, recovery must reconcile that action rather than
/// reopening it through this path.
pub(crate) fn resolve_reviewer_model_evidence_from_snapshot_v1(
    snapshot: &TrustedGovernedRecoverySnapshot,
    request: &ParsedAuthorityBrokerOpenReviewerSessionRequestV1,
) -> Result<ResolvedReviewerModelEvidenceV1, ReviewerSessionResolutionErrorV1> {
    if request.run_id != snapshot.run_id() {
        return Err(ReviewerSessionResolutionErrorV1::RunMismatch);
    }

    let reviewer = snapshot
        .workflow_for_dispatch_event_ref(&request.reviewer_dispatch_event_ref)
        .ok_or(ReviewerSessionResolutionErrorV1::ReviewerDispatchNotFound)?;
    if reviewer.run_id != request.run_id {
        return Err(ReviewerSessionResolutionErrorV1::RunMismatch);
    }
    validate_reviewer_dispatch(reviewer)?;
    if reviewer.phase != WorkflowPhaseV1::Dispatched {
        return Err(ReviewerSessionResolutionErrorV1::ReviewerWorkflowNotActive);
    }

    let action_evidence = reviewer
        .action_evidence
        .as_ref()
        .ok_or(ReviewerSessionResolutionErrorV1::ReviewerActionEvidenceMissing)?;
    if action_evidence.action_evidence_version != ActionEvidenceVersionV1::SealedV3 {
        return Err(ReviewerSessionResolutionErrorV1::ReviewerActionEvidenceMissing);
    }

    let mut matching_actions = action_evidence.actions.values().filter(|action| {
        action.request.event_id.to_string() == request.reviewer_action_request_event_ref
    });
    let action = matching_actions
        .next()
        .ok_or(ReviewerSessionResolutionErrorV1::ReviewerActionNotFound)?;
    if matching_actions.next().is_some() {
        return Err(ReviewerSessionResolutionErrorV1::ReviewerActionAmbiguous);
    }
    if action.request.action_kind != ActionKindV1::Model
        || action.request.execution_role != reviewer.dispatch.execution_role
    {
        return Err(ReviewerSessionResolutionErrorV1::ReviewerActionNotModelRoleBound);
    }
    if action.model_authorization.is_some()
        || action.activity_claim.is_some()
        || action.receipt.is_some()
    {
        return Err(ReviewerSessionResolutionErrorV1::ReviewerActionAlreadyAdvanced);
    }

    let intent = action
        .model_intent
        .as_ref()
        .ok_or(ReviewerSessionResolutionErrorV1::ReviewerIntentMissing)?;
    let candidate = intent
        .candidate_binding
        .as_ref()
        .ok_or(ReviewerSessionResolutionErrorV1::ReviewerIntentMissing)?;
    if intent.dispatch_event_ref != reviewer.dispatch.event_id
        || intent.dispatch_envelope_digest != reviewer.dispatch.envelope_digest
        || intent.action_request_event_ref != action.request.event_id
        || intent.action_request_digest != action.request.action_request_digest
    {
        return Err(ReviewerSessionResolutionErrorV1::ReviewerIntentLineageMismatch);
    }

    let candidate_workflow = snapshot
        .workflow_for_candidate_digest(&candidate.candidate_digest)
        .ok_or(ReviewerSessionResolutionErrorV1::CandidateNotFound)?;
    if candidate_workflow.run_id != request.run_id
        || candidate_workflow.dispatch.event_id == reviewer.dispatch.event_id
    {
        return Err(ReviewerSessionResolutionErrorV1::CandidateWorkflowMismatch);
    }
    validate_candidate_workflow(candidate_workflow)?;
    validate_candidate_binding(candidate_workflow, reviewer, candidate)?;

    Ok(ResolvedReviewerModelEvidenceV1 {
        run_id: request.run_id.clone(),
        candidate_dispatch_event_ref: candidate_workflow.dispatch.event_id,
        reviewer_dispatch_event_ref: reviewer.dispatch.event_id,
        reviewer_action_request_event_ref: action.request.event_id,
        reviewer_dispatch_envelope_digest: reviewer.dispatch.envelope_digest.clone(),
        execution_role: reviewer.dispatch.execution_role,
        model_request_evidence: intent.model_request_evidence.clone(),
        trust_scope_evidence: intent.trust_scope_evidence.clone(),
        candidate: candidate.clone(),
    })
}

fn validate_reviewer_dispatch(
    workflow: &WorkflowInstanceV1,
) -> Result<(), ReviewerSessionResolutionErrorV1> {
    if !has_complete_governed_sealed_dispatch_authority(workflow)
        || workflow.dispatch.commit_mode != CommitModeV1::Atomic
    {
        return Err(ReviewerSessionResolutionErrorV1::ReviewerDispatchNotGovernedSealedV3);
    }
    if !is_reviewer_role(workflow.dispatch.execution_role) {
        return Err(ReviewerSessionResolutionErrorV1::UnsupportedReviewerRole);
    }
    Ok(())
}

fn validate_candidate_workflow(
    workflow: &WorkflowInstanceV1,
) -> Result<(), ReviewerSessionResolutionErrorV1> {
    if !has_complete_governed_sealed_dispatch_authority(workflow)
        || workflow.dispatch.commit_mode != CommitModeV1::Atomic
        || workflow.dispatch.execution_role != ExecutionRoleV1::Implementer
    {
        return Err(ReviewerSessionResolutionErrorV1::CandidateDispatchNotGovernedSealedV3);
    }
    Ok(())
}

fn has_complete_governed_sealed_dispatch_authority(workflow: &WorkflowInstanceV1) -> bool {
    if workflow.dispatch.trust_tier != TrustTierV1::Governed
        || workflow.dispatch.action_evidence_version != Some(ActionEvidenceVersionV1::SealedV3)
        || workflow
            .dispatch
            .governed_packet_digest
            .as_deref()
            .is_none_or(str::is_empty)
    {
        return false;
    }
    match workflow.dispatch.dispatch_version {
        3 => true,
        4 => workflow.workflow_graph.is_some(),
        5 => {
            workflow.workflow_graph.is_some()
                && workflow.manifest_declarations.is_some()
                && workflow.v5_admission_receipt.is_some()
        }
        _ => false,
    }
}

fn validate_candidate_binding(
    candidate_workflow: &WorkflowInstanceV1,
    reviewer_workflow: &WorkflowInstanceV1,
    binding: &ModelActionCandidateBindingV1,
) -> Result<(), ReviewerSessionResolutionErrorV1> {
    let artifact = candidate_workflow
        .candidate
        .as_ref()
        .ok_or(ReviewerSessionResolutionErrorV1::CandidateBindingMismatch)?;
    if binding.candidate_created_event_ref != artifact.event_id
        || binding.candidate_digest != artifact.candidate_digest
        || binding.candidate_commit_sha != artifact.candidate_commit_sha
        || binding.candidate_view.candidate_ref != artifact.candidate_ref
        || binding.candidate_view.candidate_digest != artifact.candidate_digest
        || binding.candidate_view.candidate_commit_sha != artifact.candidate_commit_sha
        || binding.candidate_view.tree_digest != artifact.tree_digest
    {
        return Err(ReviewerSessionResolutionErrorV1::CandidateBindingMismatch);
    }

    let completion = candidate_workflow
        .candidate_completion
        .as_ref()
        .ok_or(ReviewerSessionResolutionErrorV1::CandidateCompletionMissing)?;
    if completion.completion.candidate_created_event_ref != artifact.event_id
        || completion.completion.candidate_digest != artifact.candidate_digest
    {
        return Err(ReviewerSessionResolutionErrorV1::CandidateCompletionMissing);
    }

    let acceptance = candidate_workflow
        .acceptance
        .as_ref()
        .ok_or(ReviewerSessionResolutionErrorV1::CandidateAcceptanceNotPassed)?;
    if acceptance.outcome != CandidateAcceptanceOutcomeV1::Passed
        || acceptance.candidate_digest != artifact.candidate_digest
        || acceptance.candidate_commit_sha != artifact.candidate_commit_sha
        || acceptance.acceptance_contract_digest
            != candidate_workflow.dispatch.acceptance_contract_digest
    {
        return Err(ReviewerSessionResolutionErrorV1::CandidateAcceptanceNotPassed);
    }

    let view = &binding.candidate_view;
    if !view.read_only
        || !view.network_disabled
        || view.reviewer_context_manifest_digest
            != reviewer_workflow.dispatch.context_manifest_digest
        || view.reviewer_sandbox_profile_digest != reviewer_workflow.dispatch.sandbox_profile_digest
        || candidate_view_v1_digest(view).ok().as_deref()
            != Some(binding.candidate_view_digest.as_str())
    {
        return Err(ReviewerSessionResolutionErrorV1::CandidateViewMismatch);
    }
    Ok(())
}

fn is_reviewer_role(role: ExecutionRoleV1) -> bool {
    matches!(
        role,
        ExecutionRoleV1::Reviewer | ExecutionRoleV1::Adversary | ExecutionRoleV1::Judge
    )
}
