//! Reconstruction of one executable provider request from verified authority.
//!
//! No field in this module is accepted from a worker request. The caller must
//! supply the one-use broker capability, signed dispatch, verified model and
//! trust-scope CAS documents, and the verified result of a separately recorded
//! provider token-count activity.

use crate::PrivateModelCapability;
use bp_ledger::payload::model_evidence::{
    verify_trust_scope_evidence_matches_model_request, ModelProviderV1,
    VerifiedModelRequestEvidenceDocumentV1, VerifiedProviderTokenPreflightInputV1,
    VerifiedProviderTokenPreflightResultV1, VerifiedTrustScopeEvidenceDocumentV1,
};
use bp_ledger::payload::trust_spine::{
    ActionEvidenceVersionV1, ActionKindV1, CommitModeV1, DispatchEnvelopeV3, ExecutionRoleV1,
    ModelActionCandidateBindingV1, TrustTierV1,
};
use bp_provider_sdk::{provider_response_contract_v1, ProviderExecutionRoleV1, ProviderRequest};
use chrono::{DateTime, Duration};
use thiserror::Error;

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum ProviderRequestBuildErrorV1 {
    #[error("provider request evidence does not match the exact broker capability")]
    CapabilityBindingMismatch,
    #[error("provider request evidence does not match the signed dispatch")]
    DispatchBindingMismatch,
    #[error("provider request trust-scope evidence is invalid")]
    TrustScopeMismatch,
    #[error("provider token preflight evidence is invalid")]
    PreflightMismatch,
    #[error("provider request role or candidate binding is invalid")]
    RoleBindingMismatch,
    #[error("provider request uses unsupported authority or tool settings")]
    UnsupportedAuthority,
    #[error("provider request budget is invalid")]
    InvalidBudget,
    #[error("provider request contract is invalid")]
    InvalidProviderContract,
}

#[derive(Debug)]
pub(crate) struct BoundProviderRequestV1 {
    pub(crate) provider: ModelProviderV1,
    pub(crate) request: ProviderRequest,
}

pub(crate) fn build_provider_request_v1(
    capability: &PrivateModelCapability,
    dispatch: &DispatchEnvelopeV3,
    model_request: &VerifiedModelRequestEvidenceDocumentV1,
    trust_scope: &VerifiedTrustScopeEvidenceDocumentV1,
    preflight: &VerifiedProviderTokenPreflightInputV1,
    preflight_result: &VerifiedProviderTokenPreflightResultV1,
    candidate: Option<&ModelActionCandidateBindingV1>,
) -> Result<BoundProviderRequestV1, ProviderRequestBuildErrorV1> {
    let evidence = model_request.document();
    let binding = &evidence.binding;
    if binding.run_id != capability.run_id.to_string()
        || binding.dispatch_event_ref != capability.dispatch_event_id
        || binding.action_request_event_ref != capability.action_request_event_id
        || binding.execution_role != capability.execution_role
        || binding.action_kind != ActionKindV1::Model
    {
        return Err(ProviderRequestBuildErrorV1::CapabilityBindingMismatch);
    }
    if dispatch.envelope_digest != binding.dispatch_envelope_digest
        || dispatch.body.workflow_id != binding.workflow_id
        || dispatch.body.unit_id != binding.unit_id
        || dispatch.body.attempt != binding.attempt
        || dispatch.body.provenance_ref != binding.provenance_ref
        || dispatch.body.execution_role != binding.execution_role
        || dispatch.body.commit_mode != CommitModeV1::Atomic
        || dispatch.body.trust_tier != TrustTierV1::Governed
        || dispatch.action_evidence_version != ActionEvidenceVersionV1::SealedV3
        || dispatch.repository_binding_digest != binding.repository_binding_digest
        || dispatch.ledger_authority_realm_digest != binding.ledger_authority_realm_digest
        || dispatch.governed_packet_digest.as_deref()
            != Some(binding.governed_packet_digest.as_str())
        || dispatch.body.capability_bundle_digest != binding.capability_bundle_digest
        || dispatch.body.context_manifest_digest != binding.context_manifest_digest
        || dispatch.body.worker_manifest_digest != binding.worker_manifest_digest
        || dispatch.body.sandbox_profile_digest != binding.sandbox_profile_digest
    {
        return Err(ProviderRequestBuildErrorV1::DispatchBindingMismatch);
    }
    verify_trust_scope_evidence_matches_model_request(trust_scope.document(), model_request)
        .map_err(|_| ProviderRequestBuildErrorV1::TrustScopeMismatch)?;
    if preflight.document().model_request_evidence != model_request.descriptor()
        || preflight.document().model_request_digest != evidence.model_request_digest
        || preflight_result.document().model_request_digest != evidence.model_request_digest
        || preflight_result.document().preflight_input_digest != preflight.reference().digest()
    {
        return Err(ProviderRequestBuildErrorV1::PreflightMismatch);
    }

    let role = map_role(binding.execution_role)?;
    let candidate_digest = match (binding.execution_role, candidate) {
        (ExecutionRoleV1::Implementer, None) => None,
        (
            ExecutionRoleV1::Reviewer | ExecutionRoleV1::Adversary | ExecutionRoleV1::Judge,
            Some(candidate),
        ) => Some(candidate.candidate_digest.clone()),
        _ => return Err(ProviderRequestBuildErrorV1::RoleBindingMismatch),
    };
    if !evidence.tool_capabilities.is_empty()
        || !trust_scope
            .document()
            .constraints
            .tool_capabilities
            .is_empty()
    {
        return Err(ProviderRequestBuildErrorV1::UnsupportedAuthority);
    }

    let response_contract = provider_response_contract_v1(role)
        .map_err(|_| ProviderRequestBuildErrorV1::InvalidProviderContract)?;
    let normalized = &evidence.normalized_provider_request;
    if normalized.response_schema_digest != response_contract.contract_digest
        || normalized.provider != preflight.document().provider
        || normalized.model != preflight.document().model
        || normalized.response_schema_digest != preflight.document().response_contract_digest
    {
        return Err(ProviderRequestBuildErrorV1::PreflightMismatch);
    }
    let max_total_tokens = dispatch
        .body
        .budget
        .max_tokens
        .filter(|value| *value == preflight.document().max_total_tokens)
        .ok_or(ProviderRequestBuildErrorV1::InvalidBudget)?;
    let input_tokens = preflight_result.document().input_tokens;
    let max_output_tokens = max_total_tokens
        .checked_sub(input_tokens)
        .filter(|value| *value > 0)
        .ok_or(ProviderRequestBuildErrorV1::InvalidBudget)?;
    let deadline_unix_ms = provider_deadline_unix_ms(dispatch)?;
    let provider = match normalized.provider {
        ModelProviderV1::Anthropic => "anthropic",
        ModelProviderV1::Openai => "openai",
    };
    let request = ProviderRequest {
        schema_version: 1,
        request_id: format!("{provider}:{}", binding.action_id),
        model: normalized.model.clone(),
        execution_role: role,
        system_prompt: normalized.system_prompt.clone(),
        prompt: normalized.prompt.clone(),
        response_schema_name: response_contract.name.into(),
        response_contract_digest: response_contract.contract_digest,
        response_schema_digest: response_contract.schema_digest,
        response_schema: response_contract.schema,
        candidate_digest,
        max_total_tokens,
        max_input_tokens: input_tokens,
        max_output_tokens,
        deadline_unix_ms,
        tools: vec![],
    };
    request
        .validate()
        .map_err(|_| ProviderRequestBuildErrorV1::InvalidProviderContract)?;
    Ok(BoundProviderRequestV1 {
        provider: normalized.provider,
        request,
    })
}

fn map_role(role: ExecutionRoleV1) -> Result<ProviderExecutionRoleV1, ProviderRequestBuildErrorV1> {
    match role {
        ExecutionRoleV1::Implementer => Ok(ProviderExecutionRoleV1::Implementer),
        ExecutionRoleV1::Reviewer => Ok(ProviderExecutionRoleV1::Reviewer),
        ExecutionRoleV1::Adversary => Ok(ProviderExecutionRoleV1::Adversary),
        ExecutionRoleV1::Judge => Ok(ProviderExecutionRoleV1::Judge),
        ExecutionRoleV1::Candidate => Err(ProviderRequestBuildErrorV1::RoleBindingMismatch),
    }
}

fn provider_deadline_unix_ms(
    dispatch: &DispatchEnvelopeV3,
) -> Result<i64, ProviderRequestBuildErrorV1> {
    let issued = DateTime::parse_from_rfc3339(&dispatch.body.issued_at)
        .map_err(|_| ProviderRequestBuildErrorV1::InvalidBudget)?;
    let expires = DateTime::parse_from_rfc3339(&dispatch.body.expires_at)
        .map_err(|_| ProviderRequestBuildErrorV1::InvalidBudget)?;
    let compute_ms = dispatch
        .body
        .budget
        .max_compute_time_ms
        .ok_or(ProviderRequestBuildErrorV1::InvalidBudget)?;
    let compute_deadline = issued
        .checked_add_signed(Duration::milliseconds(i64::from(compute_ms)))
        .ok_or(ProviderRequestBuildErrorV1::InvalidBudget)?;
    let deadline = expires.min(compute_deadline);
    if deadline <= issued {
        return Err(ProviderRequestBuildErrorV1::InvalidBudget);
    }
    Ok(deadline.timestamp_millis())
}
