//! Tool I/O payloads: ToolRequest, ToolResult.

use crate::id::EventId;
use bp_ledger_macros::RedactSecrets;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Write-side tool request shape — uses RedactSecrets to redact `env` on
/// serialize. Does not derive Serialize directly because RedactSecrets
/// generates that impl.
#[derive(RedactSecrets)]
pub struct ToolRequestV1 {
    pub tool_name: String,
    pub arguments: serde_json::Value,
    #[secret(hint = "env_var")]
    pub env: BTreeMap<String, String>,
    pub working_directory: String,
    pub unit_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolResultV1 {
    pub tool_request_id: EventId,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub output: Option<serde_json::Value>,
    pub duration_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tool_request_env_is_redacted() {
        let mut env = BTreeMap::new();
        env.insert("AWS_SECRET_ACCESS_KEY".into(), "hunter2".into());
        let p = ToolRequestV1 {
            tool_name: "shell".into(),
            arguments: json!({"cmd": "ls"}),
            env,
            working_directory: "/tmp".into(),
            unit_id: "u-1".into(),
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["env"]["redacted"], true);
        assert_eq!(v["env"]["hint"], "env_var");
        let text = serde_json::to_string(&p).unwrap();
        assert!(!text.contains("hunter2"), "env secret leaked");
    }

    #[test]
    fn tool_result_round_trips() {
        let p = ToolResultV1 {
            tool_request_id: EventId::new(),
            stdout: "hello\n".into(),
            stderr: String::new(),
            exit_code: Some(0),
            output: None,
            duration_ms: 12,
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<ToolResultV1>(&s).unwrap());
    }
}
