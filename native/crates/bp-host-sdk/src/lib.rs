use async_trait::async_trait;
use futures_core::Stream;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::pin::Pin;
use thiserror::Error;

pub type HostEventStream = Pin<Box<dyn Stream<Item = Result<HostEvent, HostError>> + Send>>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DetectionContext {
    pub workspace_root: PathBuf,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostCapabilities {
    pub supports_streaming: bool,
    pub supports_tools: bool,
    pub supports_patch_apply: bool,
    pub supports_memory_bridge: bool,
    pub supports_oauth_reuse: bool,
}

impl Default for HostCapabilities {
    fn default() -> Self {
        Self {
            supports_streaming: true,
            supports_tools: true,
            supports_patch_apply: false,
            supports_memory_bridge: true,
            supports_oauth_reuse: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AuthState {
    Available,
    RequiresLogin,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostStatus {
    pub detected: bool,
    pub auth: AuthState,
    pub capabilities: HostCapabilities,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostSessionContext {
    pub pack_id: String,
    pub mode_id: Option<String>,
    pub workspace_root: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChatMessage {
    pub role: MessageRole,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolSpec {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HostExecutionRequest {
    pub session: HostSessionContext,
    #[serde(default)]
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub tools: Vec<ToolSpec>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TokenUsage {
    pub input: u32,
    pub output: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FinishReason {
    Completed,
    MaxTokens,
    Interrupted,
    ToolCall,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum HostEvent {
    SessionStarted {
        host: String,
    },
    TextDelta {
        text: String,
    },
    ToolCallRequested {
        name: String,
    },
    Completed {
        reason: FinishReason,
        usage: Option<TokenUsage>,
    },
}

pub struct HostExecutionHandle {
    pub events: HostEventStream,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum HostBridgeProtocol {
    BrokeredCli,
    StructuredStdIo,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum HostBridgeAuthOwnership {
    HostManaged,
    BuildplaneManaged,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostBridgeDescriptor {
    pub host: String,
    pub display_name: String,
    pub entrypoint_hint: Option<String>,
    pub protocol: HostBridgeProtocol,
    pub auth_ownership: HostBridgeAuthOwnership,
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostBridgePlan {
    pub descriptor: HostBridgeDescriptor,
    pub working_dir: PathBuf,
    pub mode_hint: Option<String>,
    #[serde(default)]
    pub activation_env: BTreeMap<String, String>,
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostSelectionInput {
    pub explicit_host: Option<String>,
    pub explicit_provider: Option<String>,
    #[serde(default)]
    pub detected_hosts: Vec<String>,
    #[serde(default)]
    pub preferred_hosts: Vec<String>,
}

#[async_trait]
pub trait HostAdapter: Send + Sync {
    fn id(&self) -> &'static str;

    fn display_name(&self) -> &'static str;

    fn capabilities(&self) -> HostCapabilities;

    async fn detect(&self, context: &DetectionContext) -> Result<bool, HostError>;

    async fn status(&self, context: &DetectionContext) -> Result<HostStatus, HostError>;

    async fn execute(
        &self,
        request: HostExecutionRequest,
    ) -> Result<HostExecutionHandle, HostError>;
}

#[async_trait]
pub trait HostBridgeAdapter: Send + Sync {
    fn bridge_descriptor(&self) -> HostBridgeDescriptor;

    async fn plan_bridge(
        &self,
        context: &DetectionContext,
        request: &HostExecutionRequest,
    ) -> Result<HostBridgePlan, HostError>;
}

pub trait RegisteredHostAdapter: HostAdapter + HostBridgeAdapter {}

impl<T> RegisteredHostAdapter for T where T: HostAdapter + HostBridgeAdapter {}

pub trait HostRegistry {
    fn host_adapters(&self) -> Vec<Box<dyn RegisteredHostAdapter>>;

    fn available_hosts(&self) -> Vec<&'static str> {
        self.host_adapters()
            .into_iter()
            .map(|adapter| adapter.id())
            .collect()
    }

    fn adapter_for_host(&self, host_id: &str) -> Option<Box<dyn RegisteredHostAdapter>> {
        self.host_adapters()
            .into_iter()
            .find(|adapter| adapter.id() == host_id)
    }
}

pub fn select_host(input: &HostSelectionInput) -> Option<String> {
    if let Some(host) = &input.explicit_host {
        return Some(host.clone());
    }

    for preferred in &input.preferred_hosts {
        if input
            .detected_hosts
            .iter()
            .any(|candidate| candidate == preferred)
        {
            return Some(preferred.clone());
        }
    }

    input.detected_hosts.first().cloned()
}

#[derive(Debug, Error)]
pub enum HostError {
    #[error("host adapter is not implemented: {0}")]
    Unsupported(&'static str),
    #[error("host adapter could not be detected")]
    NotDetected,
    #[error("host adapter requires login or reusable auth")]
    AuthUnavailable,
    #[error("transport failure: {0}")]
    Transport(String),
    #[error("internal host error: {0}")]
    Internal(String),
}
