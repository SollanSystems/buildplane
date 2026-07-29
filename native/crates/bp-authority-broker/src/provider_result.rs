use crate::provider_request::BoundProviderRequestV1;
use crate::{GatewayCompletion, PrivateModelCapability};
use bp_ledger::error::LedgerError;
use bp_ledger::payload::activity_claim::ActivityResultOutcomeV1;
use bp_ledger::payload::model_evidence::{
    model_provider_result_document_v1_bytes, model_provider_unknown_evidence_document_v1_bytes,
    model_result_evidence_document_v1_bytes,
    parse_verified_model_provider_unknown_evidence_document_v1, ModelProviderCompletionV1,
    ModelProviderResultDocumentV1, ModelProviderUnknownEvidenceDocumentV1, ModelProviderV1,
    ModelResultEvidenceDocumentV1, VerifiedModelRequestEvidenceDocumentV1,
};
use bp_ledger::payload::trust_spine::{
    review_verdict_output_v1_digest, ExecutionRoleV1, ModelActionCandidateBindingV1,
    ReviewDecisionV1, ReviewFindingSeverityV1, ReviewFindingV1, ReviewVerdictOutputV1,
};
use bp_ledger::storage::Cas;
use bp_provider_sdk::{
    ProviderCompletionV1, ProviderExecutionRoleV1, ProviderReviewDecisionV1,
    ProviderReviewFindingSeverityV1,
};

pub(crate) struct ProviderResultWriterV1<'a> {
    cas: &'a Cas,
}

impl<'a> ProviderResultWriterV1<'a> {
    pub(crate) fn new(cas: &'a Cas) -> Self {
        Self { cas }
    }

    pub(crate) fn persist_success(
        &self,
        capability: &PrivateModelCapability,
        authorization_digest: &str,
        model_request: &VerifiedModelRequestEvidenceDocumentV1,
        bound: &BoundProviderRequestV1,
        candidate: Option<&ModelActionCandidateBindingV1>,
        completion: ProviderCompletionV1,
    ) -> Result<GatewayCompletion, LedgerError> {
        bound
            .request
            .validate()
            .map_err(|error| invalid(error.to_string()))?;
        let binding = &model_request.document().binding;
        let normalized = &model_request.document().normalized_provider_request;
        let expected_provider = match bound.provider {
            ModelProviderV1::Anthropic => "anthropic",
            ModelProviderV1::Openai => "openai",
        };
        let expected_provider_role = map_provider_role(binding.execution_role)?;
        if capability.run_id.to_string() != binding.run_id
            || capability.dispatch_event_id != binding.dispatch_event_ref
            || capability.action_request_event_id != binding.action_request_event_ref
            || capability.execution_role != binding.execution_role
            || bound.provider != normalized.provider
            || bound.request.request_id != format!("{expected_provider}:{}", binding.action_id)
            || bound.request.model != normalized.model
            || bound.request.system_prompt != normalized.system_prompt
            || bound.request.prompt != normalized.prompt
            || bound.request.response_contract_digest != normalized.response_schema_digest
            || bound.request.execution_role != expected_provider_role
            || bound.request.worker_manifest_digest != binding.worker_manifest_digest
        {
            return Err(invalid(
                "provider result authority does not reproduce the verified capability and model request",
            ));
        }

        let result_bytes = match completion {
            ProviderCompletionV1::Implementer(completion)
                if binding.execution_role == ExecutionRoleV1::Implementer
                    && completion.schema_version == 1
                    && completion.outcome == "completed"
                    && bound.request.candidate_digest.is_none()
                    && candidate.is_none() =>
            {
                let result = ModelProviderResultDocumentV1::new(
                    binding.action_id.clone(),
                    bound.request.request_id.clone(),
                    model_request.document().model_request_digest.clone(),
                    binding.execution_role,
                    None,
                    binding.worker_manifest_digest.clone(),
                    ModelProviderCompletionV1::Implementer {
                        summary: completion.summary,
                        output_refs: completion.output_refs,
                    },
                )?;
                model_provider_result_document_v1_bytes(&result)?
            }
            ProviderCompletionV1::Review(verdict)
                if matches!(
                    binding.execution_role,
                    ExecutionRoleV1::Reviewer | ExecutionRoleV1::Adversary | ExecutionRoleV1::Judge
                ) && verdict.schema_version == 1
                    && bound.request.candidate_digest.as_deref()
                        == Some(verdict.candidate_digest.as_str())
                    && verdict.reviewer_manifest_digest == binding.worker_manifest_digest =>
            {
                let candidate = candidate.ok_or_else(|| {
                    invalid("review provider completion is missing its signed candidate binding")
                })?;
                if candidate.candidate_digest != verdict.candidate_digest
                    || candidate.candidate_view.candidate_digest != candidate.candidate_digest
                    || candidate.candidate_view.candidate_commit_sha
                        != candidate.candidate_commit_sha
                    || !candidate.candidate_view.read_only
                    || !candidate.candidate_view.network_disabled
                {
                    return Err(invalid(
                        "review provider completion does not bind the exact read-only candidate view",
                    ));
                }
                let output = ReviewVerdictOutputV1 {
                    candidate_digest: verdict.candidate_digest,
                    candidate_commit_sha: candidate.candidate_commit_sha.clone(),
                    decision: map_review_decision(verdict.decision),
                    findings: verdict
                        .findings
                        .into_iter()
                        .map(|finding| ReviewFindingV1 {
                            severity: map_finding_severity(finding.severity),
                            check_id: finding.check_id,
                            file: finding.file,
                            line: finding.line,
                            explanation: finding.explanation,
                            evidence_refs: finding.evidence_refs,
                        })
                        .collect(),
                    confidence: verdict.confidence,
                    candidate_view_digest: candidate.candidate_view_digest.clone(),
                };
                if review_verdict_output_v1_digest(&output).is_err() {
                    return Err(invalid(
                        "review provider completion cannot be canonicalized",
                    ));
                }
                serde_json::to_vec(&output).map_err(|error| invalid(error.to_string()))?
            }
            _ => {
                return Err(invalid(
                    "provider completion kind or authority binding does not match the signed role",
                ));
            }
        };

        let result_ref = self.cas.put_canonical_bytes(&result_bytes)?;
        let evidence = ModelResultEvidenceDocumentV1::new(
            binding.action_id.clone(),
            binding.action_request_event_ref.to_string(),
            binding.action_request_digest.clone(),
            model_request.document().model_request_digest.clone(),
            capability.authorization_ref.clone(),
            authorization_digest.to_string(),
            result_ref.to_cas_ref(),
            result_ref.digest().to_string(),
            model_request.document().redaction_commitments.clone(),
        )?;
        let evidence_bytes = model_result_evidence_document_v1_bytes(&evidence)?;
        let evidence_ref = self.cas.put_canonical_bytes(&evidence_bytes)?;
        Ok(GatewayCompletion {
            outcome: ActivityResultOutcomeV1::Succeeded,
            result_digest: Some(result_ref.digest().to_string()),
            result_ref: Some(result_ref.to_cas_ref()),
            evidence_digest: evidence_ref.digest().to_string(),
            evidence_ref: evidence_ref.to_cas_ref(),
        })
    }

    pub(crate) fn persist_unknown(
        &self,
        capability: &PrivateModelCapability,
        authorization_digest: &str,
        model_request: &VerifiedModelRequestEvidenceDocumentV1,
    ) -> Result<GatewayCompletion, LedgerError> {
        let binding = &model_request.document().binding;
        let expected_provider = match model_request
            .document()
            .normalized_provider_request
            .provider
        {
            ModelProviderV1::Anthropic => "anthropic",
            ModelProviderV1::Openai => "openai",
        };
        let provider_request_id = format!("{expected_provider}:{}", binding.action_id);
        if capability.run_id.to_string() != binding.run_id
            || capability.dispatch_event_id != binding.dispatch_event_ref
            || capability.action_request_event_id != binding.action_request_event_ref
            || capability.execution_role != binding.execution_role
        {
            return Err(invalid(
                "unknown provider result authority does not reproduce the verified capability",
            ));
        }
        let evidence = ModelProviderUnknownEvidenceDocumentV1::new(
            binding.action_id.clone(),
            provider_request_id,
            model_request.document().model_request_digest.clone(),
            capability.authorization_ref.clone(),
            authorization_digest.into(),
        )?;
        let bytes = model_provider_unknown_evidence_document_v1_bytes(&evidence)?;
        let reference = self.cas.put_canonical_bytes(&bytes)?;
        parse_verified_model_provider_unknown_evidence_document_v1(
            &bytes,
            &reference.to_cas_ref(),
            reference.digest(),
        )?;
        Ok(GatewayCompletion::unknown(
            reference.digest().into(),
            reference.to_cas_ref(),
        ))
    }
}

fn map_provider_role(role: ExecutionRoleV1) -> Result<ProviderExecutionRoleV1, LedgerError> {
    match role {
        ExecutionRoleV1::Implementer => Ok(ProviderExecutionRoleV1::Implementer),
        ExecutionRoleV1::Reviewer => Ok(ProviderExecutionRoleV1::Reviewer),
        ExecutionRoleV1::Adversary => Ok(ProviderExecutionRoleV1::Adversary),
        ExecutionRoleV1::Judge => Ok(ProviderExecutionRoleV1::Judge),
        ExecutionRoleV1::Candidate => Err(invalid(
            "candidate role cannot produce a governed provider result",
        )),
    }
}

fn map_review_decision(decision: ProviderReviewDecisionV1) -> ReviewDecisionV1 {
    match decision {
        ProviderReviewDecisionV1::Approve => ReviewDecisionV1::Approve,
        ProviderReviewDecisionV1::RequestChanges => ReviewDecisionV1::RequestChanges,
        ProviderReviewDecisionV1::Reject => ReviewDecisionV1::Reject,
        ProviderReviewDecisionV1::Abstain => ReviewDecisionV1::Abstain,
    }
}

fn map_finding_severity(severity: ProviderReviewFindingSeverityV1) -> ReviewFindingSeverityV1 {
    match severity {
        ProviderReviewFindingSeverityV1::Info => ReviewFindingSeverityV1::Info,
        ProviderReviewFindingSeverityV1::Low => ReviewFindingSeverityV1::Low,
        ProviderReviewFindingSeverityV1::Medium => ReviewFindingSeverityV1::Medium,
        ProviderReviewFindingSeverityV1::High => ReviewFindingSeverityV1::High,
        ProviderReviewFindingSeverityV1::Critical => ReviewFindingSeverityV1::Critical,
    }
}

fn invalid(reason: impl Into<String>) -> LedgerError {
    LedgerError::InvalidPayload {
        kind: "provider_result_writer_v1".into(),
        reason: reason.into(),
    }
}
