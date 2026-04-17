//! Model I/O payloads: ModelRequest, ModelResponse.
//!
//! Headers are stored with a per-key redaction enum. Sensitive keys get a
//! Redacted variant at emit time; non-sensitive keys stay Raw. Message content
//! and system prompts are raw strings; if the operator puts secrets in prompts,
//! they own that risk (documented).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelRequestV1 {
    pub provider: String,
    pub model: String,
    pub system: Option<String>,
    pub messages: Vec<Message>,
    /// Tool schemas attached to the request.
    pub tools: Vec<serde_json::Value>,
    pub sampling: SamplingParams,
    pub headers: BTreeMap<String, HeaderValue>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelResponseV1 {
    pub content: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    pub usage: Usage,
    pub stop_reason: String,
    pub latency_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SamplingParams {
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub max_tokens: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HeaderValue {
    Raw { value: String },
    Redacted { hash: String, hint: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u32,
    pub output_tokens: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn model_request_v1_round_trips() {
        let p = ModelRequestV1 {
            provider: "anthropic".into(),
            model: "claude-opus-4-7".into(),
            system: Some("you are a coder".into()),
            messages: vec![Message { role: "user".into(), content: "hi".into() }],
            tools: vec![json!({"name": "read_file"})],
            sampling: SamplingParams { temperature: Some(0.0), top_p: None, max_tokens: Some(4096) },
            headers: BTreeMap::from([
                ("user-agent".into(), HeaderValue::Raw { value: "buildplane/0.1".into() }),
                ("authorization".into(), HeaderValue::Redacted {
                    hash: "sha256:aa".into(),
                    hint: "auth_header".into(),
                }),
            ]),
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<ModelRequestV1>(&s).unwrap());
    }

    #[test]
    fn model_response_v1_round_trips() {
        let p = ModelResponseV1 {
            content: Some("ok".into()),
            tool_calls: vec![ToolCall {
                id: "tc-1".into(),
                name: "read_file".into(),
                arguments: json!({"path": "README.md"}),
            }],
            usage: Usage { input_tokens: 100, output_tokens: 5 },
            stop_reason: "end_turn".into(),
            latency_ms: 850,
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<ModelResponseV1>(&s).unwrap());
    }
}
