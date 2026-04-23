//! Contract tests for the `#[secret]` attribute macro (Path B: derive macro).
//!
//! `RedactSecrets` owns the full `Serialize` impl, so `#[derive(Serialize)]`
//! must be omitted from structs that use it.

use bp_ledger_macros::RedactSecrets;
use std::collections::BTreeMap;

#[derive(RedactSecrets)]
struct ToolRequest {
    name: String,
    #[secret(hint = "env_var")]
    env: BTreeMap<String, String>,
}

#[test]
fn secret_field_is_replaced_by_redaction_shape() {
    let mut env = BTreeMap::new();
    env.insert("AWS_SECRET_KEY".to_string(), "hunter2".to_string());

    let req = ToolRequest {
        name: "shell".to_string(),
        env,
    };

    let json = serde_json::to_value(&req).unwrap();
    let env_field = &json["env"];

    assert_eq!(env_field["redacted"], true);
    assert!(env_field["hash"].as_str().unwrap().starts_with("sha256:"));
    assert_eq!(env_field["hint"], "env_var");
    // The raw secret value must not appear anywhere in the serialized output.
    let text = serde_json::to_string(&req).unwrap();
    assert!(!text.contains("hunter2"), "secret leaked to output");
}
