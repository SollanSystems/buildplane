use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderExecutionRoleV1 {
    Implementer,
    Reviewer,
    Adversary,
    Judge,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderToolDefinitionV1 {
    pub name: String,
    pub input_schema_digest: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderRequest {
    pub schema_version: u8,
    pub request_id: String,
    pub model: String,
    pub execution_role: ProviderExecutionRoleV1,
    pub system_prompt: Option<String>,
    pub prompt: String,
    pub response_schema_name: String,
    pub response_schema_digest: String,
    pub response_schema: Value,
    pub candidate_digest: Option<String>,
    pub max_input_tokens: u32,
    pub max_output_tokens: u32,
    pub deadline_unix_ms: i64,
    pub tools: Vec<ProviderToolDefinitionV1>,
}

impl ProviderRequest {
    pub fn validate(&self) -> Result<(), ProviderError> {
        if self.schema_version != 1 {
            return Err(ProviderError::InvalidContract(
                "provider request schema_version must be 1".into(),
            ));
        }
        for (field, value) in [
            ("request_id", self.request_id.as_str()),
            ("model", self.model.as_str()),
            ("prompt", self.prompt.as_str()),
            ("response_schema_name", self.response_schema_name.as_str()),
        ] {
            if value.trim().is_empty() || value != value.trim() {
                return Err(ProviderError::InvalidContract(format!(
                    "{field} must be canonical non-whitespace text"
                )));
            }
        }
        if !is_sha256_digest(&self.response_schema_digest)
            || provider_json_schema_digest_v1(&self.response_schema)? != self.response_schema_digest
        {
            return Err(ProviderError::InvalidContract(
                "response_schema_digest must match the canonical response schema".into(),
            ));
        }
        if self.max_input_tokens == 0 || self.max_output_tokens == 0 || self.deadline_unix_ms <= 0 {
            return Err(ProviderError::InvalidContract(
                "provider token ceilings and deadline must be positive".into(),
            ));
        }
        match self.execution_role {
            ProviderExecutionRoleV1::Implementer if self.candidate_digest.is_some() => {
                return Err(ProviderError::InvalidContract(
                    "implementer provider requests cannot bind a review candidate".into(),
                ));
            }
            ProviderExecutionRoleV1::Reviewer
            | ProviderExecutionRoleV1::Adversary
            | ProviderExecutionRoleV1::Judge
                if self
                    .candidate_digest
                    .as_deref()
                    .is_none_or(|digest| !is_sha256_digest(digest)) =>
            {
                return Err(ProviderError::InvalidContract(
                    "review-like provider requests require a canonical candidate digest".into(),
                ));
            }
            _ => {}
        }
        for tool in &self.tools {
            if tool.name.trim().is_empty()
                || tool.name != tool.name.trim()
                || !is_sha256_digest(&tool.input_schema_digest)
                || provider_json_schema_digest_v1(&tool.input_schema)? != tool.input_schema_digest
            {
                return Err(ProviderError::InvalidContract(
                    "provider tool definitions must have canonical names and matching schema digests"
                        .into(),
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderStopReasonV1 {
    Completed,
    ToolCall,
    MaxOutputTokens,
    Refusal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderResponse {
    pub schema_version: u8,
    pub request_id: String,
    pub output: Value,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub stop_reason: ProviderStopReasonV1,
}

impl ProviderResponse {
    pub fn validate_against(
        &self,
        max_input_tokens: u32,
        max_output_tokens: u32,
    ) -> Result<(), ProviderError> {
        if self.schema_version != 1
            || self.request_id.trim().is_empty()
            || self.request_id != self.request_id.trim()
        {
            return Err(ProviderError::InvalidContract(
                "provider response identity is invalid".into(),
            ));
        }
        if self.input_tokens > max_input_tokens || self.output_tokens > max_output_tokens {
            return Err(ProviderError::InvalidContract(
                "provider response exceeds the signed token ceiling".into(),
            ));
        }
        Ok(())
    }
}

#[async_trait]
pub trait ProviderAdapter: Send + Sync {
    fn id(&self) -> &'static str;

    async fn available(&self) -> Result<bool, ProviderError>;

    async fn complete(&self, request: &ProviderRequest) -> Result<ProviderResponse, ProviderError>;
}

#[derive(Debug, Error)]
pub enum ProviderError {
    #[error("provider contract is invalid: {0}")]
    InvalidContract(String),
    #[error("provider adapter is not implemented: {0}")]
    Unsupported(&'static str),
    #[error("provider transport failure: {0}")]
    Transport(String),
}

fn is_sha256_digest(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn provider_json_schema_digest_v1(schema: &Value) -> Result<String, ProviderError> {
    if !schema.is_object() {
        return Err(ProviderError::InvalidContract(
            "provider JSON schemas must be objects".into(),
        ));
    }
    let canonical = serde_json::to_vec(schema).map_err(|error| {
        ProviderError::InvalidContract(format!("provider JSON schema is not serializable: {error}"))
    })?;
    let mut digest = Sha256::new();
    digest.update(b"buildplane.provider-json-schema.v1\0");
    digest.update(canonical);
    Ok(format!("sha256:{:x}", digest.finalize()))
}

#[cfg(test)]
mod tests {
    use super::{
        provider_json_schema_digest_v1, ProviderExecutionRoleV1, ProviderRequest, ProviderResponse,
        ProviderStopReasonV1,
    };
    use serde_json::json;

    fn request_json() -> serde_json::Value {
        let response_schema = json!({
            "type": "object",
            "properties": {
                "decision": {
                    "type": "string",
                    "enum": ["approve", "request_changes", "reject", "abstain"]
                }
            },
            "required": ["decision"],
            "additionalProperties": false
        });
        json!({
            "schema_version": 1,
            "request_id": "provider:reviewer:1",
            "model": "gpt-5.6",
            "execution_role": "reviewer",
            "system_prompt": "Review only the immutable candidate.",
            "prompt": "Return the closed review verdict.",
            "response_schema_name": "review_verdict_v1",
            "response_schema_digest": provider_json_schema_digest_v1(&response_schema)
                .expect("canonical response schema"),
            "response_schema": response_schema,
            "candidate_digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "max_input_tokens": 12000,
            "max_output_tokens": 2000,
            "deadline_unix_ms": 1784246400000_i64,
            "tools": []
        })
    }

    #[test]
    fn provider_request_is_closed_and_role_bound() {
        let request: ProviderRequest =
            serde_json::from_value(request_json()).expect("closed provider request");
        assert_eq!(request.execution_role, ProviderExecutionRoleV1::Reviewer);
        request.validate().expect("valid reviewer contract");

        let mut unknown = request_json();
        unknown["ambient_api_key"] = json!("must-not-cross");
        assert!(serde_json::from_value::<ProviderRequest>(unknown).is_err());

        let mut missing_candidate = request_json();
        missing_candidate["candidate_digest"] = serde_json::Value::Null;
        let request: ProviderRequest =
            serde_json::from_value(missing_candidate).expect("closed shape");
        assert!(request.validate().is_err());

        let request: ProviderRequest =
            serde_json::from_value(request_json()).expect("closed provider request");
        let mut substituted_schema = request.clone();
        substituted_schema.response_schema["required"] = json!([]);
        assert!(substituted_schema.validate().is_err());
    }

    #[test]
    fn provider_tool_schema_is_bound_to_its_digest() {
        let mut raw = request_json();
        let input_schema = json!({
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
            "additionalProperties": false
        });
        raw["tools"] = json!([{
            "name": "read_candidate_file",
            "input_schema_digest": provider_json_schema_digest_v1(&input_schema)
                .expect("canonical input schema"),
            "input_schema": input_schema
        }]);
        let request: ProviderRequest =
            serde_json::from_value(raw).expect("closed provider request");
        request.validate().expect("valid tool schema binding");

        let mut substituted_schema = request;
        substituted_schema.tools[0].input_schema["required"] = json!([]);
        assert!(substituted_schema.validate().is_err());
    }

    #[test]
    fn provider_response_requires_metered_closed_output() {
        let response: ProviderResponse = serde_json::from_value(json!({
            "schema_version": 1,
            "request_id": "provider:reviewer:1",
            "output": {"decision": "approve"},
            "input_tokens": 321,
            "output_tokens": 45,
            "stop_reason": "completed"
        }))
        .expect("closed provider response");
        assert_eq!(response.stop_reason, ProviderStopReasonV1::Completed);
        response
            .validate_against(12000, 2000)
            .expect("within budget");

        let mut unknown = serde_json::to_value(&response).expect("encode response");
        unknown["raw_headers"] = json!({"authorization": "secret"});
        assert!(serde_json::from_value::<ProviderResponse>(unknown).is_err());
    }
}
