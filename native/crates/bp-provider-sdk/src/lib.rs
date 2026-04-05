use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderRequest {
    pub prompt: String,
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderResponse {
    pub text: String,
}

#[async_trait]
pub trait ProviderAdapter: Send + Sync {
    fn id(&self) -> &'static str;

    async fn available(&self) -> Result<bool, ProviderError>;

    async fn complete(&self, request: &ProviderRequest) -> Result<ProviderResponse, ProviderError>;
}

#[derive(Debug, Error)]
pub enum ProviderError {
    #[error("provider adapter is not implemented: {0}")]
    Unsupported(&'static str),
    #[error("provider transport failure: {0}")]
    Transport(String),
}
