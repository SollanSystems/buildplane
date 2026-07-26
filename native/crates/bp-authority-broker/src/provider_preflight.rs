use async_trait::async_trait;
use bp_ledger::payload::activity_claim::ActivityResultOutcomeV1;
use bp_ledger::payload::model_evidence::{
    provider_token_preflight_result_v1_bytes, ModelProviderV1, ProviderTokenPreflightResultV1,
    VerifiedProviderTokenPreflightInputV1,
};
use bp_ledger::storage::Cas;
use bp_provider_sdk::{ProviderTokenCountRequestV1, ProviderTokenCounterV1};
use serde::Serialize;
use thiserror::Error;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProviderTokenPreflightStatusV1 {
    Pending,
    Recorded,
    Failed,
    LeaseExpired,
    ReconciliationRequired,
}

pub(crate) struct PrivateProviderTokenPreflightCapabilityV1 {
    run_id: String,
    lease_id: String,
    provider: ModelProviderV1,
    request: ProviderTokenCountRequestV1,
}

impl PrivateProviderTokenPreflightCapabilityV1 {
    pub(crate) fn new(
        run_id: String,
        lease_id: String,
        provider: ModelProviderV1,
        request: ProviderTokenCountRequestV1,
    ) -> Self {
        Self {
            run_id,
            lease_id,
            provider,
            request,
        }
    }

    pub(crate) fn provider(&self) -> ModelProviderV1 {
        self.provider
    }

    pub(crate) fn request(&self) -> &ProviderTokenCountRequestV1 {
        &self.request
    }

    pub(crate) fn complete(
        self,
        completion: ProviderTokenPreflightGatewayCompletionV1,
    ) -> PairedProviderTokenPreflightResultV1 {
        PairedProviderTokenPreflightResultV1 {
            capability: self,
            completion,
        }
    }
}

pub(crate) enum ProviderTokenPreflightGrantV1 {
    Granted {
        run_id: String,
        lease_id: String,
        provider: ModelProviderV1,
        request: ProviderTokenCountRequestV1,
    },
    Pending {
        run_id: String,
    },
    Recorded {
        run_id: String,
        outcome: ActivityResultOutcomeV1,
    },
    LeaseExpired {
        run_id: String,
    },
}

pub(crate) struct ProviderTokenPreflightGatewayCompletionV1 {
    pub(crate) outcome: ActivityResultOutcomeV1,
    pub(crate) input_tokens: Option<u32>,
    pub(crate) result_digest: Option<String>,
    pub(crate) result_ref: Option<String>,
    pub(crate) evidence_digest: String,
    pub(crate) evidence_ref: String,
}

impl ProviderTokenPreflightGatewayCompletionV1 {
    pub(crate) fn succeeded(
        input_tokens: u32,
        result_digest: String,
        result_ref: String,
        evidence_digest: String,
        evidence_ref: String,
    ) -> Self {
        Self {
            outcome: ActivityResultOutcomeV1::Succeeded,
            input_tokens: Some(input_tokens),
            result_digest: Some(result_digest),
            result_ref: Some(result_ref),
            evidence_digest,
            evidence_ref,
        }
    }

    pub(crate) fn unknown(evidence_digest: String, evidence_ref: String) -> Self {
        Self {
            outcome: ActivityResultOutcomeV1::Unknown,
            input_tokens: None,
            result_digest: None,
            result_ref: None,
            evidence_digest,
            evidence_ref,
        }
    }

    fn is_closed(&self) -> bool {
        !self.evidence_digest.trim().is_empty()
            && !self.evidence_ref.trim().is_empty()
            && match self.outcome {
                ActivityResultOutcomeV1::Succeeded => {
                    self.input_tokens.is_some_and(|value| value > 0)
                        && self
                            .result_digest
                            .as_deref()
                            .is_some_and(|value| !value.trim().is_empty())
                        && self
                            .result_ref
                            .as_deref()
                            .is_some_and(|value| !value.trim().is_empty())
                }
                ActivityResultOutcomeV1::Failed | ActivityResultOutcomeV1::Unknown => {
                    self.input_tokens.is_none()
                        && self.result_digest.is_none()
                        && self.result_ref.is_none()
                }
            }
    }
}

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
struct ProviderTokenPreflightUnknownEvidenceV1 {
    schema_version: u8,
    outcome: &'static str,
    provider_request_id: String,
    preflight_input_digest: String,
    model_request_digest: String,
    failure_class: &'static str,
}

pub(crate) struct CasProviderTokenPreflightEvidenceWriterV1<'a> {
    cas: &'a Cas,
    preflight: &'a VerifiedProviderTokenPreflightInputV1,
}

impl<'a> CasProviderTokenPreflightEvidenceWriterV1<'a> {
    pub(crate) fn new(cas: &'a Cas, preflight: &'a VerifiedProviderTokenPreflightInputV1) -> Self {
        Self { cas, preflight }
    }

    fn matches(&self, capability: &PrivateProviderTokenPreflightCapabilityV1) -> bool {
        let input = self.preflight.document();
        capability.request.model == input.model
            && capability.request.max_total_tokens == input.max_total_tokens
            && match capability.provider {
                ModelProviderV1::Anthropic => input.provider == ModelProviderV1::Anthropic,
                ModelProviderV1::Openai => input.provider == ModelProviderV1::Openai,
            }
    }
}

impl ProviderTokenPreflightEvidenceWriterV1 for CasProviderTokenPreflightEvidenceWriterV1<'_> {
    fn succeeded(
        &mut self,
        capability: &PrivateProviderTokenPreflightCapabilityV1,
        input_tokens: u32,
    ) -> Option<ProviderTokenPreflightGatewayCompletionV1> {
        if !self.matches(capability) {
            return None;
        }
        let result = ProviderTokenPreflightResultV1::new(self.preflight, input_tokens).ok()?;
        let bytes = provider_token_preflight_result_v1_bytes(&result).ok()?;
        let reference = self.cas.put_canonical_bytes(&bytes).ok()?;
        Some(ProviderTokenPreflightGatewayCompletionV1::succeeded(
            input_tokens,
            reference.digest().into(),
            reference.to_cas_ref(),
            reference.digest().into(),
            reference.to_cas_ref(),
        ))
    }

    fn unknown(
        &mut self,
        capability: &PrivateProviderTokenPreflightCapabilityV1,
    ) -> Option<ProviderTokenPreflightGatewayCompletionV1> {
        if !self.matches(capability) {
            return None;
        }
        let evidence = ProviderTokenPreflightUnknownEvidenceV1 {
            schema_version: 1,
            outcome: "unknown",
            provider_request_id: capability.request.request_id.clone(),
            preflight_input_digest: self.preflight.reference().digest().into(),
            model_request_digest: self.preflight.document().model_request_digest.clone(),
            failure_class: "provider_effect_unknown",
        };
        let bytes = serde_json::to_vec(&evidence).ok()?;
        let reference = self.cas.put_canonical_bytes(&bytes).ok()?;
        Some(ProviderTokenPreflightGatewayCompletionV1::unknown(
            reference.digest().into(),
            reference.to_cas_ref(),
        ))
    }
}

pub(crate) struct PairedProviderTokenPreflightResultV1 {
    capability: PrivateProviderTokenPreflightCapabilityV1,
    completion: ProviderTokenPreflightGatewayCompletionV1,
}

#[async_trait]
pub(crate) trait ProviderTokenPreflightGatewayV1: Send {
    async fn count(
        &mut self,
        capability: PrivateProviderTokenPreflightCapabilityV1,
    ) -> PairedProviderTokenPreflightResultV1;
}

pub(crate) trait ProviderTokenPreflightEvidenceWriterV1: Send {
    fn succeeded(
        &mut self,
        capability: &PrivateProviderTokenPreflightCapabilityV1,
        input_tokens: u32,
    ) -> Option<ProviderTokenPreflightGatewayCompletionV1>;

    fn unknown(
        &mut self,
        capability: &PrivateProviderTokenPreflightCapabilityV1,
    ) -> Option<ProviderTokenPreflightGatewayCompletionV1>;
}

pub(crate) struct CredentialProviderTokenPreflightGatewayV1<C, W> {
    counter: C,
    evidence_writer: W,
}

impl<C, W> CredentialProviderTokenPreflightGatewayV1<C, W> {
    pub(crate) fn new(counter: C, evidence_writer: W) -> Self {
        Self {
            counter,
            evidence_writer,
        }
    }
}

#[async_trait]
impl<C, W> ProviderTokenPreflightGatewayV1 for CredentialProviderTokenPreflightGatewayV1<C, W>
where
    C: ProviderTokenCounterV1 + Send + Sync,
    W: ProviderTokenPreflightEvidenceWriterV1,
{
    async fn count(
        &mut self,
        capability: PrivateProviderTokenPreflightCapabilityV1,
    ) -> PairedProviderTokenPreflightResultV1 {
        let expected_provider = match capability.provider {
            ModelProviderV1::Anthropic => "anthropic",
            ModelProviderV1::Openai => "openai",
        };
        let completion = if self.counter.id() != expected_provider {
            None
        } else {
            match self.counter.count_input_tokens(&capability.request).await {
                Ok(input_tokens) => self.evidence_writer.succeeded(&capability, input_tokens),
                Err(_) => self.evidence_writer.unknown(&capability),
            }
        }
        .unwrap_or_else(|| ProviderTokenPreflightGatewayCompletionV1 {
            outcome: ActivityResultOutcomeV1::Unknown,
            input_tokens: None,
            result_digest: None,
            result_ref: None,
            evidence_digest: String::new(),
            evidence_ref: String::new(),
        });
        capability.complete(completion)
    }
}

pub(crate) trait ProviderTokenPreflightBackendV1 {
    fn issue_and_claim(
        &mut self,
        run_id: &str,
    ) -> Result<ProviderTokenPreflightGrantV1, ProviderTokenPreflightAuthorityErrorV1>;

    fn record(
        &mut self,
        run_id: &str,
        lease_id: String,
        completion: ProviderTokenPreflightGatewayCompletionV1,
    ) -> Result<ActivityResultOutcomeV1, ProviderTokenPreflightAuthorityErrorV1>;
}

#[derive(Debug, Error)]
pub(crate) enum ProviderTokenPreflightAuthorityErrorV1 {
    #[error("provider token preflight durable authority failed")]
    DurableAuthority,
}

pub(crate) struct ProviderTokenPreflightAuthorityV1<B, G> {
    run_id: String,
    backend: B,
    gateway: G,
}

impl<B, G> ProviderTokenPreflightAuthorityV1<B, G>
where
    B: ProviderTokenPreflightBackendV1,
    G: ProviderTokenPreflightGatewayV1,
{
    pub(crate) fn new(run_id: String, backend: B, gateway: G) -> Self {
        Self {
            run_id,
            backend,
            gateway,
        }
    }

    pub(crate) async fn authorize_and_execute(
        &mut self,
    ) -> Result<ProviderTokenPreflightStatusV1, ProviderTokenPreflightAuthorityErrorV1> {
        let capability = match self.backend.issue_and_claim(&self.run_id)? {
            ProviderTokenPreflightGrantV1::Granted {
                run_id,
                lease_id,
                provider,
                request,
            } if run_id == self.run_id => {
                PrivateProviderTokenPreflightCapabilityV1::new(run_id, lease_id, provider, request)
            }
            ProviderTokenPreflightGrantV1::Pending { run_id } if run_id == self.run_id => {
                return Ok(ProviderTokenPreflightStatusV1::Pending);
            }
            ProviderTokenPreflightGrantV1::Recorded { run_id, outcome }
                if run_id == self.run_id =>
            {
                return Ok(status_for_outcome(outcome));
            }
            ProviderTokenPreflightGrantV1::LeaseExpired { run_id } if run_id == self.run_id => {
                return Ok(ProviderTokenPreflightStatusV1::LeaseExpired);
            }
            _ => return Ok(ProviderTokenPreflightStatusV1::ReconciliationRequired),
        };

        let paired = self.gateway.count(capability).await;
        if paired.capability.run_id != self.run_id {
            return Ok(ProviderTokenPreflightStatusV1::ReconciliationRequired);
        }
        if !paired.completion.is_closed() {
            return Ok(ProviderTokenPreflightStatusV1::ReconciliationRequired);
        }
        let outcome = match self.backend.record(
            &paired.capability.run_id,
            paired.capability.lease_id,
            paired.completion,
        ) {
            Ok(outcome) => outcome,
            Err(_) => return Ok(ProviderTokenPreflightStatusV1::ReconciliationRequired),
        };
        Ok(status_for_outcome(outcome))
    }
}

fn status_for_outcome(outcome: ActivityResultOutcomeV1) -> ProviderTokenPreflightStatusV1 {
    match outcome {
        ActivityResultOutcomeV1::Succeeded => ProviderTokenPreflightStatusV1::Recorded,
        ActivityResultOutcomeV1::Failed => ProviderTokenPreflightStatusV1::Failed,
        ActivityResultOutcomeV1::Unknown => ProviderTokenPreflightStatusV1::ReconciliationRequired,
    }
}
