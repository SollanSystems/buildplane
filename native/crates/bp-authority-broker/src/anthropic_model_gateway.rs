//! Host-owned Anthropic completion gateway for one opaque model capability.
//!
//! Every provider input is reconstructed from verified tape/CAS material
//! carried by the capability. Provider failures and parse failures are reduced
//! to canonical `unknown` evidence; no raw provider error crosses the gateway.

use crate::provider_request::build_provider_request_v1;
use crate::provider_result::ProviderResultWriterV1;
use crate::{
    CredentialGateway, GatewayCompletion, PairedGatewayResult, PrivateModelCapability,
    ProviderExecutionAuthorityV1,
};
use bp_ledger::payload::model_evidence::ModelProviderV1;
use bp_ledger::storage::Cas;
use bp_provider_sdk::{parse_provider_completion_v1, ProviderAdapter};
use tokio::runtime::Runtime;

pub(crate) struct AnthropicModelGatewayV1<'a, P> {
    provider: P,
    cas: &'a Cas,
    runtime: &'a Runtime,
}

impl<'a, P> AnthropicModelGatewayV1<'a, P> {
    pub(crate) fn new(provider: P, cas: &'a Cas, runtime: &'a Runtime) -> Self {
        Self {
            provider,
            cas,
            runtime,
        }
    }
}

impl<P> CredentialGateway for AnthropicModelGatewayV1<'_, P>
where
    P: ProviderAdapter,
{
    fn invoke(&mut self, capability: PrivateModelCapability) -> PairedGatewayResult {
        let completion = match &capability.provider_authority {
            ProviderExecutionAuthorityV1::Verified {
                authorization_digest,
                preflight,
            } => {
                let writer = ProviderResultWriterV1::new(self.cas);
                let bound = build_provider_request_v1(
                    &capability,
                    preflight.dispatch(),
                    preflight.model_request(),
                    preflight.trust_scope(),
                    preflight.input(),
                    preflight.result(),
                    preflight.candidate_binding(),
                );
                match bound {
                    Ok(bound) if bound.provider == ModelProviderV1::Anthropic => {
                        let successful = self
                            .runtime
                            .block_on(self.provider.complete(&bound.request))
                            .and_then(|response| {
                                parse_provider_completion_v1(&bound.request, &response)
                            })
                            .ok()
                            .and_then(|parsed| {
                                writer
                                    .persist_success(
                                        &capability,
                                        authorization_digest,
                                        preflight.model_request(),
                                        &bound,
                                        parsed,
                                    )
                                    .ok()
                            });
                        successful.unwrap_or_else(|| {
                            writer
                                .persist_unknown(
                                    &capability,
                                    authorization_digest,
                                    preflight.model_request(),
                                )
                                .unwrap_or_else(|_| unrecordable_unknown())
                        })
                    }
                    _ => writer
                        .persist_unknown(
                            &capability,
                            authorization_digest,
                            preflight.model_request(),
                        )
                        .unwrap_or_else(|_| unrecordable_unknown()),
                }
            }
            #[cfg(test)]
            ProviderExecutionAuthorityV1::Synthetic => unrecordable_unknown(),
        };
        capability.complete(completion)
    }
}

fn unrecordable_unknown() -> GatewayCompletion {
    // Empty evidence is intentionally rejected by the ledger and therefore
    // becomes reconciliation-only. This is the final fail-closed fallback if
    // even canonical unknown-evidence persistence is unavailable.
    GatewayCompletion::unknown(String::new(), String::new())
}
