//! Read-only recovery decisions for already-recorded governed actions.
//!
//! This module intentionally has no transition, signing, lease-issuance, or
//! effect APIs. It classifies immutable evidence projected by trusted replay so
//! a future host-owned authority service can reuse a recorded result, wait for
//! an existing lease, or stop for reconciliation. In particular, no outcome
//! here ever means "issue an action" or "retry an effect".

use crate::state::{
    ActionReplayState, ActionRequestReplayState, ActivityClaimReplayState,
    ActivityResultReplayState, WorkflowInstanceV1, WorkflowPhaseV1,
};
use bp_ledger::payload::activity_claim::ActivityResultOutcomeV1;
use bp_ledger::payload::trust_spine::{
    ActionEvidenceVersionV1, ActionKindV1, ActionReceiptOutcomeV2, CommitModeV1, TrustTierV1,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

/// Closed wire-schema revision for a recorded-action decision query/result.
pub const RECORDED_ACTION_DECISION_SCHEMA_VERSION_V1: u16 = 1;

/// Immutable identity a caller expects to find in a trusted replay snapshot.
///
/// The claim identity is deliberately mandatory. A caller that only knows an
/// action request has no eligible recorded effect yet and must receive a
/// blocked outcome rather than a synthetic permission to create a lease.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordedActionIdentityV1 {
    pub run_id: String,
    pub workflow_id: String,
    pub workflow_revision: String,
    pub unit_id: String,
    pub attempt: u32,
    pub dispatch_event_ref: String,
    pub dispatch_envelope_digest: String,
    pub action_id: String,
    pub idempotency_key: String,
    pub action_request_event_ref: String,
    pub action_request_digest: String,
    pub activity_claim_event_ref: String,
    pub activity_claim_event_digest: String,
    pub lease_id: String,
}

/// Read-only request to classify a previously-recorded action.
///
/// `observed_at` is used only to classify an existing lease as active or
/// expired. It is not authority and cannot make this API issue an effect.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordedActionDecisionQueryV1 {
    pub schema_version: u16,
    pub identity: RecordedActionIdentityV1,
    /// RFC3339 UTC time used to assess the recorded lease's current state.
    pub observed_at: String,
}

/// Exhaustive, non-authorizing result of classifying a recorded action.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionDecisionDispositionV1 {
    /// The exact immutable terminal result can be returned to recovery code.
    ReuseRecordedResult,
    /// The recorded lease remains live and another service owns completion.
    WaitForActiveLease,
    /// External reality is unresolved; a reconciler must determine it.
    ReconciliationRequired,
    /// A recorded terminal failure/denial exists and is never retryable here.
    TerminalFailure,
    /// Evidence is absent, stale, unsupported, or malformed. No effect may run.
    Blocked,
}

/// Why a non-reuse decision stopped. These values are deliberately closed so
/// a caller cannot reinterpret a new failure mode as an effect authorization.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionDecisionBlockReasonV1 {
    UnsupportedSchemaVersion,
    MalformedQuery,
    SnapshotRunMismatch,
    WorkflowNotFound,
    WorkflowIdentityMismatch,
    UnsupportedDispatch,
    MissingActionEvidence,
    ActionNotFound,
    ActionIdentityMismatch,
    ClaimMissing,
    ClaimIdentityMismatch,
    MalformedEvidence,
    LeaseExpired,
    UnknownTerminalState,
    TerminalFailure,
    WorkflowNotActive,
}

/// Reusable immutable terminal result. This is evidence only; it contains no
/// capability, lease token, or permission to invoke a replacement action.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordedActivityResultV1 {
    pub result_event_ref: String,
    pub result_event_digest: String,
    pub result_digest: String,
    pub result_ref: String,
    pub evidence_digest: String,
    pub evidence_ref: String,
    pub recorded_at: String,
}

/// Closed, versioned output from [`classify_replayed_governed_action_v1`].
///
/// There is intentionally no "issue", "retry", "approve", or capability
/// field. A future authority service must obtain a separate reducer-issued
/// activity intent before it can record a new effect.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordedActionDecisionV1 {
    pub schema_version: u16,
    pub identity: RecordedActionIdentityV1,
    pub disposition: ActionDecisionDispositionV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<RecordedActivityResultV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_lease_expires_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<ActionDecisionBlockReasonV1>,
}

/// Classify one action from a fully replayed workflow projection.
///
/// This is a pure crate-internal function: it reads only the supplied snapshot
/// and query, never mutates either, and does not provide an action issuance
/// path. External hosts must call it through `TrustedGovernedRecoverySnapshot`,
/// which guarantees a full signed replay and tape-root verification before
/// exposing the workflow.
pub(crate) fn classify_replayed_governed_action_v1(
    workflow: &WorkflowInstanceV1,
    query: &RecordedActionDecisionQueryV1,
) -> RecordedActionDecisionV1 {
    if query.schema_version != RECORDED_ACTION_DECISION_SCHEMA_VERSION_V1 {
        return blocked(query, ActionDecisionBlockReasonV1::UnsupportedSchemaVersion);
    }
    if !query_is_well_formed(query) {
        return blocked(query, ActionDecisionBlockReasonV1::MalformedQuery);
    }
    if !workflow_identity_matches_query(workflow, query) {
        return blocked(query, ActionDecisionBlockReasonV1::WorkflowIdentityMismatch);
    }
    if !is_supported_governed_sealed_dispatch(workflow) {
        return blocked(query, ActionDecisionBlockReasonV1::UnsupportedDispatch);
    }

    let Some(evidence) = workflow.action_evidence.as_ref() else {
        return blocked(query, ActionDecisionBlockReasonV1::MissingActionEvidence);
    };
    if evidence.action_evidence_version != ActionEvidenceVersionV1::SealedV3 {
        return blocked(query, ActionDecisionBlockReasonV1::MissingActionEvidence);
    }
    let Some(action) = evidence.actions.get(&query.identity.action_id) else {
        return blocked(query, ActionDecisionBlockReasonV1::ActionNotFound);
    };
    if !action_identity_matches_query(workflow, action, query) {
        return blocked(query, ActionDecisionBlockReasonV1::ActionIdentityMismatch);
    }
    if !action_request_is_well_formed(workflow, &action.request) {
        return blocked(query, ActionDecisionBlockReasonV1::MalformedEvidence);
    }
    let Some(claim) = action.activity_claim.as_ref() else {
        return blocked(query, ActionDecisionBlockReasonV1::ClaimMissing);
    };
    if !claim_identity_matches_query(claim, query) {
        return blocked(query, ActionDecisionBlockReasonV1::ClaimIdentityMismatch);
    }
    if !claim_is_well_formed(workflow, action, claim) {
        return blocked(query, ActionDecisionBlockReasonV1::MalformedEvidence);
    }
    if !model_action_evidence_is_well_formed(workflow, action, claim) {
        return blocked(query, ActionDecisionBlockReasonV1::MalformedEvidence);
    }
    if !heartbeats_are_well_formed(workflow, claim) {
        return blocked(query, ActionDecisionBlockReasonV1::MalformedEvidence);
    }

    let receipt_outcome = match action.receipt.as_ref() {
        Some(receipt) => {
            if !receipt_is_well_formed(action, claim, receipt) {
                return blocked(query, ActionDecisionBlockReasonV1::MalformedEvidence);
            }
            Some(receipt.outcome)
        }
        None => None,
    };

    if let Some(result) = claim.result.as_ref() {
        if !result_is_well_formed(claim, result) {
            return blocked(query, ActionDecisionBlockReasonV1::MalformedEvidence);
        }
        if !result_and_receipt_agree(result, action.receipt.as_ref()) {
            return blocked(query, ActionDecisionBlockReasonV1::MalformedEvidence);
        }
        if result.outcome == ActivityResultOutcomeV1::Succeeded
            && action.request.action_kind == ActionKindV1::Model
            && !successful_model_result_has_bound_receipt(action, result)
        {
            return blocked(query, ActionDecisionBlockReasonV1::MalformedEvidence);
        }
        return match result.outcome {
            ActivityResultOutcomeV1::Succeeded => reuse(query, result),
            ActivityResultOutcomeV1::Failed => terminal_failure(query),
            ActivityResultOutcomeV1::Unknown => {
                reconciliation(query, ActionDecisionBlockReasonV1::UnknownTerminalState)
            }
        };
    }

    // A terminal receipt without a terminal activity result is incomplete V3
    // evidence. It still never causes a retry: unknown/failure remain stopping
    // states and an unpaired success is malformed.
    if let Some(outcome) = receipt_outcome {
        return match outcome {
            ActionReceiptOutcomeV2::Unknown => {
                reconciliation(query, ActionDecisionBlockReasonV1::UnknownTerminalState)
            }
            ActionReceiptOutcomeV2::Failed | ActionReceiptOutcomeV2::Denied => {
                terminal_failure(query)
            }
            ActionReceiptOutcomeV2::Succeeded => {
                blocked(query, ActionDecisionBlockReasonV1::MalformedEvidence)
            }
        };
    }

    if workflow.phase != WorkflowPhaseV1::Dispatched {
        return blocked(query, ActionDecisionBlockReasonV1::WorkflowNotActive);
    }

    let observed_at = parse_rfc3339_utc(&query.observed_at)
        .expect("well-formed query has a parseable observed_at");
    let lease_expires_at = parse_rfc3339_utc(&claim.lease_expires_at)
        .expect("well-formed claim has a parseable lease expiry");
    if observed_at >= lease_expires_at {
        reconciliation(query, ActionDecisionBlockReasonV1::LeaseExpired)
    } else {
        RecordedActionDecisionV1 {
            schema_version: RECORDED_ACTION_DECISION_SCHEMA_VERSION_V1,
            identity: query.identity.clone(),
            disposition: ActionDecisionDispositionV1::WaitForActiveLease,
            result: None,
            effective_lease_expires_at: Some(claim.lease_expires_at.clone()),
            reason: None,
        }
    }
}

pub(crate) fn query_is_well_formed(query: &RecordedActionDecisionQueryV1) -> bool {
    let identity = &query.identity;
    query.schema_version == RECORDED_ACTION_DECISION_SCHEMA_VERSION_V1
        && strings_are_non_empty([
            &identity.run_id,
            &identity.workflow_id,
            &identity.workflow_revision,
            &identity.unit_id,
            &identity.dispatch_event_ref,
            &identity.action_id,
            &identity.idempotency_key,
            &identity.action_request_event_ref,
            &identity.activity_claim_event_ref,
            &identity.lease_id,
        ])
        && is_canonical_digest(&identity.dispatch_envelope_digest)
        && is_canonical_digest(&identity.action_request_digest)
        && is_canonical_digest(&identity.activity_claim_event_digest)
        && parse_rfc3339_utc(&query.observed_at).is_some()
}

pub(crate) fn blocked(
    query: &RecordedActionDecisionQueryV1,
    reason: ActionDecisionBlockReasonV1,
) -> RecordedActionDecisionV1 {
    RecordedActionDecisionV1 {
        schema_version: RECORDED_ACTION_DECISION_SCHEMA_VERSION_V1,
        identity: query.identity.clone(),
        disposition: ActionDecisionDispositionV1::Blocked,
        result: None,
        effective_lease_expires_at: None,
        reason: Some(reason),
    }
}

fn reuse(
    query: &RecordedActionDecisionQueryV1,
    result: &ActivityResultReplayState,
) -> RecordedActionDecisionV1 {
    RecordedActionDecisionV1 {
        schema_version: RECORDED_ACTION_DECISION_SCHEMA_VERSION_V1,
        identity: query.identity.clone(),
        disposition: ActionDecisionDispositionV1::ReuseRecordedResult,
        result: Some(RecordedActivityResultV1 {
            result_event_ref: result.event_id.to_string(),
            result_event_digest: result.event_digest.clone(),
            result_digest: result
                .result_digest
                .clone()
                .expect("validated successful result has a digest"),
            result_ref: result
                .result_ref
                .clone()
                .expect("validated successful result has a reference"),
            evidence_digest: result.evidence_digest.clone(),
            evidence_ref: result.evidence_ref.clone(),
            recorded_at: result.recorded_at.clone(),
        }),
        effective_lease_expires_at: None,
        reason: None,
    }
}

fn reconciliation(
    query: &RecordedActionDecisionQueryV1,
    reason: ActionDecisionBlockReasonV1,
) -> RecordedActionDecisionV1 {
    RecordedActionDecisionV1 {
        schema_version: RECORDED_ACTION_DECISION_SCHEMA_VERSION_V1,
        identity: query.identity.clone(),
        disposition: ActionDecisionDispositionV1::ReconciliationRequired,
        result: None,
        effective_lease_expires_at: None,
        reason: Some(reason),
    }
}

fn terminal_failure(query: &RecordedActionDecisionQueryV1) -> RecordedActionDecisionV1 {
    RecordedActionDecisionV1 {
        schema_version: RECORDED_ACTION_DECISION_SCHEMA_VERSION_V1,
        identity: query.identity.clone(),
        disposition: ActionDecisionDispositionV1::TerminalFailure,
        result: None,
        effective_lease_expires_at: None,
        reason: Some(ActionDecisionBlockReasonV1::TerminalFailure),
    }
}

fn workflow_identity_matches_query(
    workflow: &WorkflowInstanceV1,
    query: &RecordedActionDecisionQueryV1,
) -> bool {
    let identity = &query.identity;
    workflow.run_id == identity.run_id
        && workflow.workflow_id == identity.workflow_id
        && workflow.workflow_revision == identity.workflow_revision
        && workflow.unit_id == identity.unit_id
        && workflow.attempt == identity.attempt
        && workflow.dispatch.event_id.to_string() == identity.dispatch_event_ref
        && workflow.dispatch.envelope_digest == identity.dispatch_envelope_digest
}

fn is_supported_governed_sealed_dispatch(workflow: &WorkflowInstanceV1) -> bool {
    let dispatch = &workflow.dispatch;
    let required_digests = [
        &dispatch.envelope_digest,
        &dispatch.capability_bundle_digest,
        &dispatch.acceptance_contract_digest,
        &dispatch.context_manifest_digest,
        &dispatch.worker_manifest_digest,
        &dispatch.sandbox_profile_digest,
    ];
    let dispatch_times = match (
        parse_rfc3339_utc(&dispatch.issued_at),
        parse_rfc3339_utc(&dispatch.expires_at),
    ) {
        (Some(issued_at), Some(expires_at)) => issued_at < expires_at,
        _ => false,
    };
    let graph_binding_is_valid = match dispatch.dispatch_version {
        3 => true,
        4 => {
            dispatch
                .workflow_graph_digest
                .as_deref()
                .is_some_and(is_canonical_digest)
                && dispatch
                    .workflow_graph_declaration_event_ref
                    .as_ref()
                    .is_some_and(|reference| !reference.to_string().trim().is_empty())
        }
        _ => false,
    };
    matches!(dispatch.dispatch_version, 3 | 4)
        && dispatch.trust_tier == TrustTierV1::Governed
        && dispatch.commit_mode == CommitModeV1::Atomic
        && dispatch.action_evidence_version == Some(ActionEvidenceVersionV1::SealedV3)
        && required_digests
            .iter()
            .all(|value| is_canonical_digest(value.as_str()))
        && dispatch
            .repository_binding_digest
            .as_deref()
            .is_some_and(is_canonical_digest)
        && dispatch
            .ledger_authority_realm_digest
            .as_deref()
            .is_some_and(is_canonical_digest)
        && dispatch
            .governed_packet_digest
            .as_deref()
            .is_some_and(is_canonical_digest)
        && strings_are_non_empty([
            &workflow.run_id,
            &workflow.workflow_id,
            &workflow.workflow_revision,
            &workflow.unit_id,
            &dispatch.provenance_ref,
            &dispatch.base_commit_sha,
            &dispatch.idempotency_key,
        ])
        && dispatch_times
        && graph_binding_is_valid
}

fn action_identity_matches_query(
    workflow: &WorkflowInstanceV1,
    action: &ActionReplayState,
    query: &RecordedActionDecisionQueryV1,
) -> bool {
    let request = &action.request;
    request.action_id == query.identity.action_id
        && request.idempotency_key == query.identity.idempotency_key
        && request.event_id.to_string() == query.identity.action_request_event_ref
        && request.action_request_digest == query.identity.action_request_digest
        && request.repository_binding_digest
            == workflow
                .dispatch
                .repository_binding_digest
                .as_deref()
                .unwrap_or_default()
        && request.ledger_authority_realm_digest
            == workflow
                .dispatch
                .ledger_authority_realm_digest
                .as_deref()
                .unwrap_or_default()
}

fn action_request_is_well_formed(
    workflow: &WorkflowInstanceV1,
    request: &ActionRequestReplayState,
) -> bool {
    request.governed_packet_digest == workflow.dispatch.governed_packet_digest
        && request.execution_role == workflow.dispatch.execution_role
        && is_canonical_digest(&request.canonical_input_digest)
        && is_canonical_digest(&request.repository_binding_digest)
        && is_canonical_digest(&request.ledger_authority_realm_digest)
        && is_canonical_digest(&request.policy_digest)
        && is_canonical_digest(&request.action_request_digest)
        && strings_are_non_empty([
            &request.action_id,
            &request.idempotency_key,
            &request.canonical_input_ref,
            &request.authority_actor,
        ])
        && parse_rfc3339_utc(&request.requested_at).is_some()
}

/// A model action has one more immutable authorization layer than host/tool
/// actions. A lease alone is never sufficient to classify it as eligible:
/// sealed_v3 requires a kernel intent followed by the V2 native authorization
/// bound to the same request, dispatch, packet, and role.
fn model_action_evidence_is_well_formed(
    workflow: &WorkflowInstanceV1,
    action: &ActionReplayState,
    claim: &ActivityClaimReplayState,
) -> bool {
    if action.request.action_kind != ActionKindV1::Model {
        return true;
    }
    let Some(intent) = action.model_intent.as_ref() else {
        return false;
    };
    let Some(authorization) = action.model_authorization.as_ref() else {
        return false;
    };
    let Some(authorization_expires_at) = parse_rfc3339_utc(&authorization.expires_at) else {
        return false;
    };
    let Some(authorization_at) = authorization
        .authorized_at
        .as_deref()
        .and_then(parse_rfc3339_utc)
    else {
        return false;
    };
    let Some(intent_at) = parse_rfc3339_utc(&intent.intended_at) else {
        return false;
    };
    let Some(claimed_at) = parse_rfc3339_utc(&claim.claimed_at) else {
        return false;
    };
    let Some(requested_at) = parse_rfc3339_utc(&action.request.requested_at) else {
        return false;
    };
    let Some(deadline) = effective_dispatch_deadline(workflow) else {
        return false;
    };
    let receipt_authorization_is_bound = action.receipt.as_ref().map_or(true, |receipt| {
        receipt.outcome != ActionReceiptOutcomeV2::Succeeded
            || receipt.authorization_ref.as_deref()
                == Some(authorization.authorization_ref.as_str())
    });
    intent.dispatch_event_ref == workflow.dispatch.event_id
        && intent.dispatch_envelope_digest == workflow.dispatch.envelope_digest
        && intent.action_request_event_ref == action.request.event_id
        && intent.action_request_digest == action.request.action_request_digest
        && intent.canonical_input_ref == action.request.canonical_input_ref
        && intent.canonical_input_digest == action.request.canonical_input_digest
        && is_canonical_digest(&intent.intent_digest)
        && !intent.intent_actor.trim().is_empty()
        && authorization.authorization_version == 2
        && authorization.intent_event_ref == Some(intent.event_id)
        && authorization.intent_digest.as_deref() == Some(intent.intent_digest.as_str())
        && authorization.dispatch_event_ref == workflow.dispatch.event_id.to_string()
        && authorization.dispatch_envelope_digest == workflow.dispatch.envelope_digest
        && authorization.action_request_ref == action.request.event_id.to_string()
        && authorization.action_request_digest == action.request.action_request_digest
        && authorization.packet_digest.as_str()
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
        && is_canonical_digest(&authorization.model_request_digest)
        && is_canonical_digest(&authorization.trust_scope_digest)
        && is_canonical_digest(&authorization.authorization_digest)
        && !authorization.authorization_actor.trim().is_empty()
        && !authorization.authorization_ref.trim().is_empty()
        && requested_at <= intent_at
        && authorization_expires_at > requested_at
        && authorization_expires_at > authorization_at
        && authorization_expires_at <= deadline
        && intent_at <= authorization_at
        && authorization_at <= claimed_at
        && claimed_at < authorization_expires_at
        && receipt_authorization_is_bound
}

fn claim_identity_matches_query(
    claim: &ActivityClaimReplayState,
    query: &RecordedActionDecisionQueryV1,
) -> bool {
    claim.event_id.to_string() == query.identity.activity_claim_event_ref
        && claim.claim_event_digest == query.identity.activity_claim_event_digest
        && claim.lease_id == query.identity.lease_id
}

fn claim_is_well_formed(
    workflow: &WorkflowInstanceV1,
    action: &ActionReplayState,
    claim: &ActivityClaimReplayState,
) -> bool {
    let request = &action.request;
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
    let Some(deadline) = effective_dispatch_deadline(workflow) else {
        return false;
    };
    claim.run_id == workflow.run_id
        && claim.activity_id == request.action_id
        && claim.idempotency_key == request.idempotency_key
        && claim.action_kind == request.action_kind
        && claim.action_request_event_id == request.event_id
        && claim.action_request_digest == request.action_request_digest
        && claim.dispatch_event_id == workflow.dispatch.event_id
        && claim.dispatch_envelope_digest == workflow.dispatch.envelope_digest
        && is_canonical_digest(&claim.claim_event_digest)
        && strings_are_non_empty([
            &claim.activity_id,
            &claim.idempotency_key,
            &claim.authority_actor,
            &claim.lease_id,
        ])
        && claim.signer.as_ref().is_some_and(|signer| {
            !signer.actor_id.trim().is_empty() && !signer.key_id.trim().is_empty()
        })
        && claimed_at >= requested_at
        && claimed_at >= issued_at
        && lease_expires_at > claimed_at
        && lease_expires_at <= deadline
}

fn heartbeats_are_well_formed(
    workflow: &WorkflowInstanceV1,
    claim: &ActivityClaimReplayState,
) -> bool {
    if claim.heartbeats.is_empty() {
        return true;
    }
    let Some(claimed_at) = parse_rfc3339_utc(&claim.claimed_at) else {
        return false;
    };
    let Some(deadline) = effective_dispatch_deadline(workflow) else {
        return false;
    };
    let mut previous_expiry = None;
    let mut previous_heartbeat_at = None;
    for heartbeat in &claim.heartbeats {
        let Some(prior_expiry) = parse_rfc3339_utc(&heartbeat.prior_lease_expires_at) else {
            return false;
        };
        let Some(next_expiry) = parse_rfc3339_utc(&heartbeat.lease_expires_at) else {
            return false;
        };
        let Some(heartbeat_at) = parse_rfc3339_utc(&heartbeat.heartbeat_at) else {
            return false;
        };
        if heartbeat.run_id != claim.run_id
            || heartbeat.activity_id != claim.activity_id
            || heartbeat.idempotency_key != claim.idempotency_key
            || heartbeat.claim_event_id != claim.event_id
            || heartbeat.claim_event_digest != claim.claim_event_digest
            || heartbeat.lease_id != claim.lease_id
            || heartbeat.dispatch_event_id != claim.dispatch_event_id
            || heartbeat.dispatch_envelope_digest != claim.dispatch_envelope_digest
            || !is_canonical_digest(&heartbeat.event_digest)
            || prior_expiry <= claimed_at
            || heartbeat_at < claimed_at
            || heartbeat_at >= prior_expiry
            || next_expiry <= prior_expiry
            || next_expiry > deadline
            || previous_expiry
                .as_ref()
                .is_some_and(|previous| &prior_expiry != previous)
            || previous_heartbeat_at
                .as_ref()
                .is_some_and(|previous| &heartbeat_at <= previous)
        {
            return false;
        }
        previous_expiry = Some(next_expiry);
        previous_heartbeat_at = Some(heartbeat_at);
    }
    let Some(current_expiry) = parse_rfc3339_utc(&claim.lease_expires_at) else {
        return false;
    };
    previous_expiry.is_some_and(|expiry| expiry == current_expiry)
}

fn result_is_well_formed(
    claim: &ActivityClaimReplayState,
    result: &ActivityResultReplayState,
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
    let result_value_is_valid = match result.outcome {
        ActivityResultOutcomeV1::Succeeded => {
            result
                .result_digest
                .as_deref()
                .is_some_and(is_canonical_digest)
                && result
                    .result_ref
                    .as_deref()
                    .is_some_and(|reference| !reference.trim().is_empty())
        }
        ActivityResultOutcomeV1::Unknown => {
            result.result_digest.is_none() && result.result_ref.is_none()
        }
        ActivityResultOutcomeV1::Failed => match (&result.result_digest, &result.result_ref) {
            (Some(digest), Some(reference)) => {
                is_canonical_digest(digest) && !reference.trim().is_empty()
            }
            (None, None) => true,
            _ => false,
        },
    };
    result.run_id == claim.run_id
        && result.activity_id == claim.activity_id
        && result.idempotency_key == claim.idempotency_key
        && result.claim_event_id == claim.event_id
        && result.claim_event_digest == claim.claim_event_digest
        && result.lease_id == claim.lease_id
        && is_canonical_digest(&result.event_digest)
        && is_canonical_digest(&result.evidence_digest)
        && !result.evidence_ref.trim().is_empty()
        && result_value_is_valid
        && recorded_at >= claimed_at
        && (recorded_at < lease_expires_at || result.outcome == ActivityResultOutcomeV1::Unknown)
}

fn receipt_is_well_formed(
    action: &ActionReplayState,
    _claim: &ActivityClaimReplayState,
    receipt: &crate::state::ActionReceiptReplayState,
) -> bool {
    receipt.action_id == action.request.action_id
        && receipt.idempotency_key == action.request.idempotency_key
        && receipt.action_request_digest == action.request.action_request_digest
        && is_canonical_digest(&receipt.action_receipt_digest)
        && is_canonical_digest(&receipt.evidence_digest)
        && strings_are_non_empty([&receipt.action_receipt_ref, &receipt.evidence_ref])
        && parse_rfc3339_utc(&receipt.completed_at).is_some()
        && optional_digest_and_reference_are_well_formed(
            &receipt.result_digest,
            &receipt.result_ref,
        )
}

fn result_and_receipt_agree(
    result: &ActivityResultReplayState,
    receipt: Option<&crate::state::ActionReceiptReplayState>,
) -> bool {
    let Some(receipt) = receipt else {
        return true;
    };
    match result.outcome {
        ActivityResultOutcomeV1::Succeeded => {
            receipt.outcome == ActionReceiptOutcomeV2::Succeeded
                && receipt.result_digest == result.result_digest
                && receipt.result_ref == result.result_ref
                && receipt.evidence_digest == result.evidence_digest
                && receipt.evidence_ref == result.evidence_ref
        }
        ActivityResultOutcomeV1::Failed => receipt.outcome == ActionReceiptOutcomeV2::Failed,
        ActivityResultOutcomeV1::Unknown => receipt.outcome == ActionReceiptOutcomeV2::Unknown,
    }
}

/// Successful model results are reusable only after the terminal receipt has
/// closed the same native authorization. A bare activity result is not enough:
/// it could be a forged projection or an observation made after authorization
/// expiry, neither of which is proof that a governed provider effect completed.
fn successful_model_result_has_bound_receipt(
    action: &ActionReplayState,
    result: &ActivityResultReplayState,
) -> bool {
    let Some(authorization) = action.model_authorization.as_ref() else {
        return false;
    };
    let Some(receipt) = action.receipt.as_ref() else {
        return false;
    };
    let Some(intent) = action.model_intent.as_ref() else {
        return false;
    };
    let Some(requested_at) = parse_rfc3339_utc(&action.request.requested_at) else {
        return false;
    };
    let Some(intended_at) = parse_rfc3339_utc(&intent.intended_at) else {
        return false;
    };
    let Some(claimed_at) = action
        .activity_claim
        .as_ref()
        .and_then(|claim| parse_rfc3339_utc(&claim.claimed_at))
    else {
        return false;
    };
    let Some(authorized_at) = authorization
        .authorized_at
        .as_deref()
        .and_then(parse_rfc3339_utc)
    else {
        return false;
    };
    let Some(recorded_at) = parse_rfc3339_utc(&result.recorded_at) else {
        return false;
    };
    let Some(completed_at) = parse_rfc3339_utc(&receipt.completed_at) else {
        return false;
    };
    let Some(expires_at) = parse_rfc3339_utc(&authorization.expires_at) else {
        return false;
    };

    result.outcome == ActivityResultOutcomeV1::Succeeded
        && authorization.authorization_version == 2
        && receipt.outcome == ActionReceiptOutcomeV2::Succeeded
        && receipt.authorization_ref.as_deref() == Some(authorization.authorization_ref.as_str())
        && result_and_receipt_agree(result, Some(receipt))
        && requested_at <= intended_at
        && intended_at <= authorized_at
        && authorized_at <= recorded_at
        && claimed_at <= completed_at
        && authorized_at <= completed_at
        && completed_at <= recorded_at
        && recorded_at < expires_at
        && completed_at < expires_at
}

fn optional_digest_and_reference_are_well_formed(
    digest: &Option<String>,
    reference: &Option<String>,
) -> bool {
    match (digest.as_deref(), reference.as_deref()) {
        (Some(digest), Some(reference)) => {
            is_canonical_digest(digest) && !reference.trim().is_empty()
        }
        (None, None) => true,
        _ => false,
    }
}

fn effective_dispatch_deadline(workflow: &WorkflowInstanceV1) -> Option<DateTime<Utc>> {
    let issued_at = parse_rfc3339_utc(&workflow.dispatch.issued_at)?;
    let dispatch_expires_at = parse_rfc3339_utc(&workflow.dispatch.expires_at)?;
    let compute_deadline = workflow
        .dispatch
        .budget
        .max_compute_time_ms
        .and_then(|milliseconds| {
            issued_at.checked_add_signed(Duration::milliseconds(i64::from(milliseconds)))
        });
    Some(compute_deadline.map_or(dispatch_expires_at, |deadline| {
        deadline.min(dispatch_expires_at)
    }))
}

fn strings_are_non_empty<T: AsRef<str>>(values: impl IntoIterator<Item = T>) -> bool {
    values
        .into_iter()
        .all(|value| !value.as_ref().trim().is_empty())
}

fn is_canonical_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value.as_bytes()[7..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn parse_rfc3339_utc(value: &str) -> Option<DateTime<Utc>> {
    value
        .ends_with('Z')
        .then(|| DateTime::parse_from_rfc3339(value).ok())
        .flatten()
        .map(|value| value.with_timezone(&Utc))
}
