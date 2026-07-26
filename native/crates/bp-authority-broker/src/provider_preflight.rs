use async_trait::async_trait;
use bp_ledger::payload::activity_claim::ActivityResultOutcomeV1;
use bp_ledger::payload::model_evidence::ModelProviderV1;
use bp_provider_sdk::ProviderTokenCountRequestV1;
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
    pub(crate) evidence_digest: String,
    pub(crate) evidence_ref: String,
}

impl ProviderTokenPreflightGatewayCompletionV1 {
    pub(crate) fn succeeded(
        input_tokens: u32,
        evidence_digest: String,
        evidence_ref: String,
    ) -> Self {
        Self {
            outcome: ActivityResultOutcomeV1::Succeeded,
            input_tokens: Some(input_tokens),
            evidence_digest,
            evidence_ref,
        }
    }

    pub(crate) fn unknown(evidence_digest: String, evidence_ref: String) -> Self {
        Self {
            outcome: ActivityResultOutcomeV1::Unknown,
            input_tokens: None,
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
                }
                ActivityResultOutcomeV1::Failed | ActivityResultOutcomeV1::Unknown => {
                    self.input_tokens.is_none()
                }
            }
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
            } if run_id == self.run_id => PrivateProviderTokenPreflightCapabilityV1 {
                run_id,
                lease_id,
                provider,
                request,
            },
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
