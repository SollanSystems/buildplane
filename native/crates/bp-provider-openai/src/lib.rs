use async_trait::async_trait;
use bp_provider_sdk::{ProviderAdapter, ProviderError, ProviderRequest, ProviderResponse};

pub struct OpenAiProvider;

#[async_trait]
impl ProviderAdapter for OpenAiProvider {
    fn id(&self) -> &'static str {
        "openai"
    }

    async fn available(&self) -> Result<bool, ProviderError> {
        Ok(false)
    }

    async fn complete(
        &self,
        _request: &ProviderRequest,
    ) -> Result<ProviderResponse, ProviderError> {
        Err(ProviderError::Unsupported("OpenAI provider stub"))
    }
}
