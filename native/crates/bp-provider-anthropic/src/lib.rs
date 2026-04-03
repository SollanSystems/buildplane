use async_trait::async_trait;
use bp_provider_sdk::{ProviderAdapter, ProviderError, ProviderRequest, ProviderResponse};

pub struct AnthropicProvider;

#[async_trait]
impl ProviderAdapter for AnthropicProvider {
    fn id(&self) -> &'static str {
        "anthropic"
    }

    async fn available(&self) -> Result<bool, ProviderError> {
        Ok(false)
    }

    async fn complete(
        &self,
        _request: &ProviderRequest,
    ) -> Result<ProviderResponse, ProviderError> {
        Err(ProviderError::Unsupported("Anthropic provider stub"))
    }
}
