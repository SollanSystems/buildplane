use async_trait::async_trait;
use bp_provider_sdk::{
    ProviderAdapter, ProviderError, ProviderRequest, ProviderResponse, ProviderStopReasonV1,
};
use reqwest::{
    header::{HeaderValue, USER_AGENT},
    redirect::Policy,
    Client,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fmt,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroize;

const ANTHROPIC_MESSAGES_ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const MAX_ANTHROPIC_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AnthropicMessageRequestV1 {
    pub model: String,
    pub max_tokens: u32,
    pub system: Option<String>,
    pub messages: Vec<AnthropicMessageV1>,
    pub output_config: AnthropicOutputConfigV1,
    pub tools: Vec<AnthropicToolV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AnthropicMessageV1 {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AnthropicOutputConfigV1 {
    pub format: AnthropicOutputFormatV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AnthropicOutputFormatV1 {
    #[serde(rename = "type")]
    pub format_type: String,
    pub schema: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AnthropicToolV1 {
    pub name: String,
    pub input_schema: Value,
    pub strict: bool,
}

#[async_trait]
pub trait AnthropicTransportV1: Send + Sync {
    async fn available(&self) -> Result<bool, ProviderError>;

    async fn send_message(
        &self,
        request: AnthropicMessageRequestV1,
        deadline_unix_ms: i64,
    ) -> Result<Value, ProviderError>;
}

pub struct AnthropicApiCredentialV1(Vec<u8>);

impl AnthropicApiCredentialV1 {
    pub fn new(mut secret: Vec<u8>) -> Result<Self, ProviderError> {
        if secret.is_empty()
            || secret
                .iter()
                .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
        {
            secret.zeroize();
            return Err(ProviderError::InvalidContract(
                "Anthropic host credential is empty or unsafe for an HTTP header".into(),
            ));
        }
        if HeaderValue::from_bytes(&secret).is_err() {
            secret.zeroize();
            return Err(ProviderError::InvalidContract(
                "Anthropic host credential is invalid for an HTTP header".into(),
            ));
        }
        Ok(Self(secret))
    }

    fn header_value(&self) -> Result<HeaderValue, ProviderError> {
        HeaderValue::from_bytes(&self.0)
            .map_err(|_| ProviderError::Transport("Anthropic credential became invalid".into()))
    }
}

impl fmt::Debug for AnthropicApiCredentialV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AnthropicApiCredentialV1([REDACTED])")
    }
}

impl Drop for AnthropicApiCredentialV1 {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[async_trait]
pub trait AnthropicCredentialBrokerV1: Send + Sync {
    async fn available(&self) -> Result<bool, ProviderError>;

    async fn issue_for_messages(&self) -> Result<AnthropicApiCredentialV1, ProviderError>;
}

pub struct AnthropicHttpTransportV1 {
    client: Client,
    credential_broker: Arc<dyn AnthropicCredentialBrokerV1>,
}

impl AnthropicHttpTransportV1 {
    pub fn new<T>(credential_broker: T) -> Result<Self, ProviderError>
    where
        T: AnthropicCredentialBrokerV1 + 'static,
    {
        let client = Client::builder()
            .https_only(true)
            .redirect(Policy::none())
            .no_proxy()
            .build()
            .map_err(|error| {
                ProviderError::Transport(format!(
                    "failed to initialize protected Anthropic HTTP client: {error}"
                ))
            })?;
        Ok(Self {
            client,
            credential_broker: Arc::new(credential_broker),
        })
    }
}

#[async_trait]
impl AnthropicTransportV1 for AnthropicHttpTransportV1 {
    async fn available(&self) -> Result<bool, ProviderError> {
        self.credential_broker.available().await
    }

    async fn send_message(
        &self,
        request: AnthropicMessageRequestV1,
        deadline_unix_ms: i64,
    ) -> Result<Value, ProviderError> {
        let remaining_ms = deadline_unix_ms
            .checked_sub(now_unix_ms()?)
            .filter(|remaining| *remaining > 0)
            .ok_or_else(|| {
                ProviderError::Transport(
                    "Anthropic request deadline elapsed before HTTP transport".into(),
                )
            })?;
        let timeout = Duration::from_millis(u64::try_from(remaining_ms).map_err(|_| {
            ProviderError::Transport("Anthropic request deadline exceeds supported range".into())
        })?);
        let credential = self.credential_broker.issue_for_messages().await?;
        let response = self
            .client
            .post(ANTHROPIC_MESSAGES_ENDPOINT)
            .header("x-api-key", credential.header_value()?)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header(USER_AGENT, "buildplane-native/0.1")
            .timeout(timeout)
            .json(&request)
            .send()
            .await
            .map_err(|error| {
                ProviderError::Transport(format!("Anthropic HTTP request failed: {error}"))
            })?;
        let status = response.status();
        if !status.is_success() {
            return Err(ProviderError::Transport(format!(
                "Anthropic HTTP request returned status {status}"
            )));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_ANTHROPIC_RESPONSE_BYTES as u64)
        {
            return Err(ProviderError::Transport(
                "Anthropic HTTP response exceeded the protected size limit".into(),
            ));
        }

        let mut response = response;
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|error| {
            ProviderError::Transport(format!("failed to read Anthropic HTTP response: {error}"))
        })? {
            if body.len().saturating_add(chunk.len()) > MAX_ANTHROPIC_RESPONSE_BYTES {
                return Err(ProviderError::Transport(
                    "Anthropic HTTP response exceeded the protected size limit".into(),
                ));
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&body).map_err(|error| {
            ProviderError::InvalidContract(format!(
                "Anthropic HTTP response was not valid JSON: {error}"
            ))
        })
    }
}

pub struct AnthropicProvider {
    transport: Arc<dyn AnthropicTransportV1>,
}

impl AnthropicProvider {
    pub fn new<T>(transport: T) -> Self
    where
        T: AnthropicTransportV1 + 'static,
    {
        Self {
            transport: Arc::new(transport),
        }
    }
}

#[async_trait]
impl ProviderAdapter for AnthropicProvider {
    fn id(&self) -> &'static str {
        "anthropic"
    }

    async fn available(&self) -> Result<bool, ProviderError> {
        self.transport.available().await
    }

    async fn complete(&self, request: &ProviderRequest) -> Result<ProviderResponse, ProviderError> {
        request.validate()?;
        if now_unix_ms()? >= request.deadline_unix_ms {
            return Err(ProviderError::Transport(
                "Anthropic request deadline elapsed before transport".into(),
            ));
        }

        let wire_request = AnthropicMessageRequestV1 {
            model: request.model.clone(),
            max_tokens: request.max_output_tokens,
            system: request.system_prompt.clone(),
            messages: vec![AnthropicMessageV1 {
                role: "user".into(),
                content: request.prompt.clone(),
            }],
            output_config: AnthropicOutputConfigV1 {
                format: AnthropicOutputFormatV1 {
                    format_type: "json_schema".into(),
                    schema: request.response_schema.clone(),
                },
            },
            tools: request
                .tools
                .iter()
                .map(|tool| AnthropicToolV1 {
                    name: tool.name.clone(),
                    input_schema: tool.input_schema.clone(),
                    strict: true,
                })
                .collect(),
        };
        let raw_response = self
            .transport
            .send_message(wire_request, request.deadline_unix_ms)
            .await?;
        if now_unix_ms()? >= request.deadline_unix_ms {
            return Err(ProviderError::Transport(
                "Anthropic request deadline elapsed with an unknown transport result".into(),
            ));
        }
        parse_response(request, raw_response)
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AnthropicMessageResponseV1 {
    id: String,
    #[serde(rename = "type")]
    response_type: String,
    role: String,
    content: Vec<AnthropicContentBlockV1>,
    model: String,
    stop_reason: String,
    #[serde(default)]
    stop_sequence: Option<String>,
    usage: AnthropicUsageV1,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum AnthropicContentBlockV1 {
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AnthropicUsageV1 {
    input_tokens: u32,
    output_tokens: u32,
    #[serde(default)]
    cache_creation_input_tokens: Option<u32>,
    #[serde(default)]
    cache_read_input_tokens: Option<u32>,
    #[serde(default)]
    service_tier: Option<String>,
}

fn parse_response(
    request: &ProviderRequest,
    raw_response: Value,
) -> Result<ProviderResponse, ProviderError> {
    let response: AnthropicMessageResponseV1 = serde_json::from_value(raw_response)
        .map_err(|error| ProviderError::InvalidContract(format!("Anthropic response: {error}")))?;
    if response.id.trim().is_empty()
        || response.response_type != "message"
        || response.role != "assistant"
        || response.model != request.model
    {
        return Err(ProviderError::InvalidContract(
            "Anthropic response identity does not match the request".into(),
        ));
    }
    let _ = (
        response.stop_sequence.as_deref(),
        response.usage.service_tier.as_deref(),
    );
    let input_tokens = response
        .usage
        .input_tokens
        .checked_add(response.usage.cache_creation_input_tokens.unwrap_or(0))
        .and_then(|total| total.checked_add(response.usage.cache_read_input_tokens.unwrap_or(0)))
        .ok_or_else(|| {
            ProviderError::InvalidContract("Anthropic input-token usage overflowed".into())
        })?;

    let (stop_reason, output) = match response.stop_reason.as_str() {
        "end_turn" | "stop_sequence" => {
            let [AnthropicContentBlockV1::Text { text }] = response.content.as_slice() else {
                return Err(ProviderError::InvalidContract(
                    "completed Anthropic responses require exactly one structured text block"
                        .into(),
                ));
            };
            let output = serde_json::from_str(text).map_err(|error| {
                ProviderError::InvalidContract(format!(
                    "Anthropic structured output is invalid JSON: {error}"
                ))
            })?;
            (ProviderStopReasonV1::Completed, output)
        }
        "tool_use" => {
            let mut tool_calls = Vec::with_capacity(response.content.len());
            for block in response.content {
                match block {
                    AnthropicContentBlockV1::ToolUse { id, name, input } => {
                        if !request.tools.iter().any(|tool| tool.name == name) {
                            return Err(ProviderError::InvalidContract(
                                "Anthropic requested an undeclared tool".into(),
                            ));
                        }
                        tool_calls.push(json!({"id": id, "name": name, "input": input}));
                    }
                    AnthropicContentBlockV1::Text { .. } => {}
                }
            }
            if tool_calls.is_empty() {
                return Err(ProviderError::InvalidContract(
                    "Anthropic tool_use response contained no tool call".into(),
                ));
            }
            (
                ProviderStopReasonV1::ToolCall,
                json!({"tool_calls": tool_calls}),
            )
        }
        "max_tokens" => (ProviderStopReasonV1::MaxOutputTokens, Value::Null),
        "refusal" => (ProviderStopReasonV1::Refusal, Value::Null),
        _ => {
            return Err(ProviderError::InvalidContract(
                "Anthropic response used an unsupported stop reason".into(),
            ));
        }
    };

    let provider_response = ProviderResponse {
        schema_version: 1,
        request_id: request.request_id.clone(),
        output,
        input_tokens,
        output_tokens: response.usage.output_tokens,
        stop_reason,
    };
    provider_response.validate_against(request.max_input_tokens, request.max_output_tokens)?;
    Ok(provider_response)
}

fn now_unix_ms() -> Result<i64, ProviderError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ProviderError::Transport("system clock precedes Unix epoch".into()))?;
    i64::try_from(duration.as_millis())
        .map_err(|_| ProviderError::Transport("system clock exceeds supported range".into()))
}

#[cfg(test)]
mod tests {
    use super::{
        AnthropicApiCredentialV1, AnthropicMessageRequestV1, AnthropicProvider,
        AnthropicTransportV1,
    };
    use async_trait::async_trait;
    use bp_provider_sdk::{
        provider_json_schema_digest_v1, provider_response_contract_v1, ProviderAdapter,
        ProviderError, ProviderExecutionRoleV1, ProviderRequest, ProviderStopReasonV1,
        ProviderToolDefinitionV1,
    };
    use futures::executor::block_on;
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    struct FakeTransport {
        request: Arc<Mutex<Option<(AnthropicMessageRequestV1, i64)>>>,
        response: Value,
    }

    #[async_trait]
    impl AnthropicTransportV1 for FakeTransport {
        async fn available(&self) -> Result<bool, ProviderError> {
            Ok(true)
        }

        async fn send_message(
            &self,
            request: AnthropicMessageRequestV1,
            deadline_unix_ms: i64,
        ) -> Result<Value, ProviderError> {
            *self.request.lock().expect("request lock") = Some((request, deadline_unix_ms));
            Ok(self.response.clone())
        }
    }

    fn request() -> ProviderRequest {
        let response_contract = provider_response_contract_v1(ProviderExecutionRoleV1::Reviewer)
            .expect("response contract");
        let tool_schema = json!({
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
            "additionalProperties": false
        });
        ProviderRequest {
            schema_version: 1,
            request_id: "provider:reviewer:anthropic:1".into(),
            model: "claude-sonnet-4-6".into(),
            execution_role: ProviderExecutionRoleV1::Reviewer,
            system_prompt: Some("Review only the immutable candidate.".into()),
            prompt: "Return the verdict or request a read-only tool.".into(),
            response_schema_name: response_contract.name.into(),
            response_contract_digest: response_contract.contract_digest,
            response_schema_digest: response_contract.schema_digest,
            response_schema: response_contract.schema,
            candidate_digest: Some(format!("sha256:{}", "b".repeat(64))),
            max_input_tokens: 12_000,
            max_output_tokens: 2_000,
            deadline_unix_ms: i64::MAX,
            tools: vec![ProviderToolDefinitionV1 {
                name: "read_candidate_file".into(),
                input_schema_digest: provider_json_schema_digest_v1(&tool_schema)
                    .expect("tool schema"),
                input_schema: tool_schema,
            }],
        }
    }

    #[test]
    fn maps_closed_request_and_completed_structured_response() {
        let captured = Arc::new(Mutex::new(None));
        let transport = FakeTransport {
            request: Arc::clone(&captured),
            response: json!({
                "id": "msg_01",
                "type": "message",
                "role": "assistant",
                "content": [{"type": "text", "text": "{\"decision\":\"approve\"}"}],
                "model": "claude-sonnet-4-6",
                "stop_reason": "end_turn",
                "usage": {
                    "input_tokens": 300,
                    "cache_creation_input_tokens": 10,
                    "cache_read_input_tokens": 11,
                    "output_tokens": 45
                }
            }),
        };
        let provider = AnthropicProvider::new(transport);
        assert!(block_on(provider.available()).expect("availability"));
        let response = block_on(provider.complete(&request())).expect("provider response");
        assert_eq!(response.output, json!({"decision": "approve"}));
        assert_eq!(response.stop_reason, ProviderStopReasonV1::Completed);
        assert_eq!(response.input_tokens, 321);
        assert_eq!(response.output_tokens, 45);

        let (wire, deadline_unix_ms) = captured
            .lock()
            .expect("request lock")
            .clone()
            .expect("captured request");
        assert_eq!(deadline_unix_ms, i64::MAX);
        assert_eq!(wire.model, "claude-sonnet-4-6");
        assert_eq!(wire.max_tokens, 2_000);
        assert_eq!(
            wire.system.as_deref(),
            Some("Review only the immutable candidate.")
        );
        assert_eq!(wire.messages[0].role, "user");
        assert_eq!(wire.output_config.format.schema, request().response_schema);
        assert!(wire.tools[0].strict);
        assert_eq!(wire.tools[0].input_schema, request().tools[0].input_schema);
    }

    #[test]
    fn maps_tool_use_without_treating_it_as_approval() {
        let transport = FakeTransport {
            request: Arc::new(Mutex::new(None)),
            response: json!({
                "id": "msg_02",
                "type": "message",
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "toolu_01",
                    "name": "read_candidate_file",
                    "input": {"path": "src/lib.rs"}
                }],
                "model": "claude-sonnet-4-6",
                "stop_reason": "tool_use",
                "usage": {"input_tokens": 100, "output_tokens": 20}
            }),
        };
        let response =
            block_on(AnthropicProvider::new(transport).complete(&request())).expect("tool call");
        assert_eq!(response.stop_reason, ProviderStopReasonV1::ToolCall);
        assert_eq!(
            response.output,
            json!({"tool_calls": [{
                "id": "toolu_01",
                "name": "read_candidate_file",
                "input": {"path": "src/lib.rs"}
            }]})
        );
    }

    #[test]
    fn malformed_or_mismatched_responses_fail_closed() {
        for response in [
            json!({
                "id": "msg_03",
                "type": "message",
                "role": "assistant",
                "content": [{"type": "text", "text": "approve"}],
                "model": "claude-sonnet-4-6",
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 100, "output_tokens": 20}
            }),
            json!({
                "id": "msg_04",
                "type": "message",
                "role": "assistant",
                "content": [{"type": "text", "text": "{\"decision\":\"approve\"}"}],
                "model": "different-model",
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 100, "output_tokens": 20}
            }),
        ] {
            let transport = FakeTransport {
                request: Arc::new(Mutex::new(None)),
                response,
            };
            assert!(block_on(AnthropicProvider::new(transport).complete(&request())).is_err());
        }
    }

    #[test]
    fn host_credential_is_validated_and_redacted() {
        let credential =
            AnthropicApiCredentialV1::new(b"short-lived-host-secret".to_vec()).expect("credential");
        assert_eq!(
            format!("{credential:?}"),
            "AnthropicApiCredentialV1([REDACTED])"
        );
        assert!(AnthropicApiCredentialV1::new(Vec::new()).is_err());
        assert!(AnthropicApiCredentialV1::new(b"secret\nheader".to_vec()).is_err());
    }
}
