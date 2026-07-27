//! Strict, cross-language normalization for governed command packets.
//!
//! A dispatch digest is authority only for the normalized packet that the
//! TypeScript compiler admitted. This module independently reconstructs that
//! normalized value, verifies both the packet and capability-bundle digests,
//! and evaluates the process invocation before a protected ledger control may
//! write `ActionRequestedV2`.

use crate::error::{LedgerError, Result};
use crate::payload::trust_spine::ExecutionRoleV1;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub const GOVERNED_UNIT_PACKET_V1_DIGEST_DOMAIN: &[u8] = b"buildplane.governed-unit-packet.v1\0";
pub const CAPABILITY_BUNDLE_V0_SCHEMA_VERSION: &str = "buildplane.capability_bundle.v0";
pub const MAX_GOVERNED_COMMAND_PACKET_SOURCE_BYTES: usize = 2 * 1024 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GovernedCommandPacketV1 {
    pub unit: GovernedUnitV1,
    pub execution_role: ExecutionRoleV1,
    pub execution: GovernedCommandExecutionV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent: Option<GovernedTaskIntentV1>,
    #[serde(default)]
    pub verification: GovernedVerificationV1,
    #[serde(
        default,
        rename = "routingHints",
        skip_serializing_if = "Option::is_none"
    )]
    pub routing_hints: Option<GovernedRoutingHintsV1>,
    pub provenance_ref: String,
    pub capability_bundle: CapabilityBundleV0,
    pub capability_bundle_digest: String,
    pub acceptance_contract: GovernedAcceptanceContractV1,
    pub trust_scope: GovernedTrustScopeV1,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GovernedUnitV1 {
    pub id: String,
    pub kind: String,
    pub scope: String,
    #[serde(default, rename = "inputRefs")]
    pub input_refs: Vec<String>,
    #[serde(default, rename = "expectedOutputs")]
    pub expected_outputs: Vec<String>,
    #[serde(rename = "verificationContract")]
    pub verification_contract: String,
    #[serde(rename = "policyProfile")]
    pub policy_profile: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GovernedCommandExecutionV1 {
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GovernedVerificationV1 {
    #[serde(default, rename = "requiredOutputs")]
    pub required_outputs: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GovernedRoutingHintsV1 {
    #[serde(
        default,
        rename = "preferredWorker",
        skip_serializing_if = "Option::is_none"
    )]
    pub preferred_worker: Option<PreferredWorkerV1>,
    #[serde(
        default,
        rename = "preferredModel",
        skip_serializing_if = "Option::is_none"
    )]
    pub preferred_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<RoutingEffortV1>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PreferredWorkerV1 {
    ClaudeCode,
    Codex,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoutingEffortV1 {
    Low,
    Medium,
    High,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GovernedTaskIntentV1 {
    pub objective: String,
    #[serde(rename = "taskType")]
    pub task_type: GovernedTaskTypeV1,
    #[serde(default)]
    pub context: GovernedTaskContextV1,
    #[serde(default)]
    pub constraints: GovernedTaskConstraintsV1,
    pub features: GovernedTaskFeaturesV1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GovernedTaskTypeV1 {
    Implement,
    Review,
    Diagnose,
    Refactor,
    TestGen,
    SecurityAudit,
    Migration,
    Architecture,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GovernedTaskContextV1 {
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default, rename = "priorWork", skip_serializing_if = "Option::is_none")]
    pub prior_work: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memories: Option<Vec<String>>,
    #[serde(
        default,
        rename = "codebaseHints",
        skip_serializing_if = "Option::is_none"
    )]
    pub codebase_hints: Option<String>,
    #[serde(
        default,
        rename = "retryContext",
        skip_serializing_if = "Option::is_none"
    )]
    pub retry_context: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GovernedTaskConstraintsV1 {
    #[serde(default)]
    pub scope: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forbidden: Option<Vec<String>>,
    #[serde(default)]
    pub verification: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GovernedTaskFeaturesV1 {
    pub ambiguity: AmbiguityV1,
    pub reversibility: ReversibilityV1,
    #[serde(rename = "verifierStrength")]
    pub verifier_strength: VerifierStrengthV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub framework: Option<String>,
    #[serde(
        default,
        rename = "estimatedComplexity",
        skip_serializing_if = "Option::is_none"
    )]
    pub estimated_complexity: Option<ComplexityV1>,
    #[serde(
        default,
        rename = "changeSurface",
        skip_serializing_if = "Option::is_none"
    )]
    pub change_surface: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AmbiguityV1 {
    Low,
    Medium,
    High,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReversibilityV1 {
    Easy,
    Hard,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerifierStrengthV1 {
    Strong,
    Weak,
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComplexityV1 {
    Low,
    Medium,
    High,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityBundleV0 {
    #[serde(rename = "schemaVersion")]
    pub schema_version: String,
    #[serde(rename = "bundleId")]
    pub bundle_id: String,
    #[serde(default, rename = "fsRead", skip_serializing_if = "Option::is_none")]
    pub fs_read: Option<Vec<String>>,
    #[serde(default, rename = "fsWrite", skip_serializing_if = "Option::is_none")]
    pub fs_write: Option<Vec<String>>,
    #[serde(default, rename = "netEgress", skip_serializing_if = "Option::is_none")]
    pub net_egress: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<CapabilityToolsV0>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityToolsV0 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_file: Option<CapabilityWriteFileToolV0>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_command: Option<CapabilityRunCommandToolV0>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityWriteFileToolV0 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityRunCommandToolV0 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowlist: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GovernedAcceptanceContractV1 {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    pub contract_version: String,
    pub diff_scope: GovernedDiffScopeV1,
    pub checks: Vec<GovernedAcceptanceCheckV1>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GovernedDiffScopeV1 {
    pub allowed_globs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub denied_globs: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GovernedAcceptanceCheckV1 {
    pub command: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GovernedTrustScopeV1 {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    pub lane: String,
    pub principal: String,
    pub scope: String,
}

impl GovernedCommandPacketV1 {
    pub fn parse_and_verify(source: &str, expected_packet_digest: &str) -> Result<Self> {
        if source.len() > MAX_GOVERNED_COMMAND_PACKET_SOURCE_BYTES {
            return Err(invalid(format!(
                "governed command packet exceeds {MAX_GOVERNED_COMMAND_PACKET_SOURCE_BYTES} bytes"
            )));
        }
        let mut packet: Self = serde_json::from_str(source).map_err(|error| {
            invalid(format!(
                "governed command packet is not a closed V1 document: {error}"
            ))
        })?;
        packet.normalize();
        packet.validate()?;
        let packet_digest = packet.canonical_digest()?;
        validate_sha256_digest("expected_packet_digest", expected_packet_digest)?;
        if packet_digest != expected_packet_digest {
            return Err(invalid(
                "normalized governed packet digest does not match the signed dispatch",
            ));
        }
        Ok(packet)
    }

    pub fn canonical_digest(&self) -> Result<String> {
        canonical_struct_digest(Some(GOVERNED_UNIT_PACKET_V1_DIGEST_DOMAIN), self)
    }

    pub fn capability_bundle_digest(&self) -> Result<String> {
        canonical_struct_digest(None, &self.capability_bundle)
    }

    pub fn acceptance_contract_digest(&self) -> Result<String> {
        canonical_struct_digest(None, &self.acceptance_contract)
    }

    pub fn command_args(&self) -> &[String] {
        self.execution.args.as_deref().unwrap_or(&[])
    }

    /// Return the exact executable acceptance checks admitted to the protected
    /// V5 action plane. Legacy V0 free-form command strings remain readable as
    /// packet input, but they never become execution authority.
    pub fn protected_acceptance_checks(&self) -> Result<&[GovernedAcceptanceCheckV1]> {
        if self.acceptance_contract.schema_version != 1
            || self.acceptance_contract.contract_version != "v1"
            || self.acceptance_contract.checks.is_empty()
        {
            return Err(invalid(
                "protected acceptance requires schemaVersion 1, contract_version v1, and at least one typed check",
            ));
        }
        for check in &self.acceptance_contract.checks {
            validate_trimmed("acceptance_contract.checks.command", &check.command)?;
            if check.command.chars().any(char::is_whitespace) {
                return Err(invalid(
                    "protected acceptance check commands must name one executable without shell syntax",
                ));
            }
            validate_string_list("acceptance_contract.checks.args", &check.args)?;
            if is_ambient_shell_or_launcher(&check.command) {
                return Err(invalid(
                    "protected acceptance checks cannot invoke an ambient shell or command launcher",
                ));
            }
            self.capability_bundle
                .validate_for_process(&check.command, &check.args)?;
        }
        Ok(&self.acceptance_contract.checks)
    }

    pub fn validate(&self) -> Result<()> {
        if self.execution_role != ExecutionRoleV1::Implementer {
            return Err(invalid(
                "governed process actions require execution_role implementer",
            ));
        }
        for (field, value) in [
            ("unit.id", self.unit.id.as_str()),
            ("unit.kind", self.unit.kind.as_str()),
            ("unit.scope", self.unit.scope.as_str()),
            (
                "unit.verificationContract",
                self.unit.verification_contract.as_str(),
            ),
            ("unit.policyProfile", self.unit.policy_profile.as_str()),
            ("provenance_ref", self.provenance_ref.as_str()),
        ] {
            validate_non_empty(field, value)?;
        }
        validate_trimmed("trust_scope.principal", &self.trust_scope.principal)?;
        validate_trimmed("trust_scope.scope", &self.trust_scope.scope)?;
        validate_non_empty("execution.command", &self.execution.command)?;
        validate_string_list("execution.args", self.command_args())?;
        if let Some(cwd) = self.execution.cwd.as_deref() {
            validate_non_empty("execution.cwd", cwd)?;
            validate_relative_path("execution.cwd", cwd)?;
        }
        if self.acceptance_contract.schema_version != 1
            || !matches!(
                self.acceptance_contract.contract_version.as_str(),
                "v0" | "v1"
            )
        {
            return Err(invalid(
                "acceptance_contract must use closed schemaVersion 1 and a supported contract_version",
            ));
        }
        validate_unique_trimmed(
            "acceptance_contract.diff_scope.allowed_globs",
            &self.acceptance_contract.diff_scope.allowed_globs,
        )?;
        if let Some(globs) = self.acceptance_contract.diff_scope.denied_globs.as_deref() {
            validate_unique_trimmed("acceptance_contract.diff_scope.denied_globs", globs)?;
        }
        let check_commands = self
            .acceptance_contract
            .checks
            .iter()
            .map(|check| check.command.clone())
            .collect::<Vec<_>>();
        validate_unique_trimmed("acceptance_contract.checks.command", &check_commands)?;
        if self.acceptance_contract.contract_version == "v1" {
            self.protected_acceptance_checks()?;
        }
        if self.trust_scope.schema_version != 1 || self.trust_scope.lane != "governed" {
            return Err(invalid(
                "trust_scope must use closed schemaVersion 1 and lane governed",
            ));
        }
        if let Some(features) = self.intent.as_ref().map(|intent| &intent.features) {
            if features
                .change_surface
                .is_some_and(|value| value > MAX_SAFE_INTEGER)
            {
                return Err(invalid(
                    "intent.features.changeSurface must be a non-negative safe integer",
                ));
            }
        }
        self.capability_bundle
            .validate_for_process(&self.execution.command, self.command_args())?;
        let actual_bundle_digest = self.capability_bundle_digest()?;
        validate_sha256_digest("capability_bundle_digest", &self.capability_bundle_digest)?;
        if actual_bundle_digest != self.capability_bundle_digest {
            return Err(invalid(
                "capability_bundle_digest does not match the normalized capability bundle",
            ));
        }
        Ok(())
    }

    fn normalize(&mut self) {
        if self
            .capability_bundle
            .tools
            .as_ref()
            .is_some_and(|tools| tools.write_file.is_none() && tools.run_command.is_none())
        {
            self.capability_bundle.tools = None;
        }
    }
}

impl CapabilityBundleV0 {
    fn validate_for_process(&self, command: &str, args: &[String]) -> Result<()> {
        if self.schema_version != CAPABILITY_BUNDLE_V0_SCHEMA_VERSION {
            return Err(invalid(
                "capability_bundle.schemaVersion must be buildplane.capability_bundle.v0",
            ));
        }
        validate_non_empty("capability_bundle.bundleId", &self.bundle_id)?;
        for (field, globs) in [
            ("capability_bundle.fsRead", self.fs_read.as_deref()),
            ("capability_bundle.fsWrite", self.fs_write.as_deref()),
        ] {
            if let Some(globs) = globs {
                validate_unique_non_empty(field, globs)?;
                for glob in globs {
                    validate_relative_glob(field, glob)?;
                }
            }
        }
        if let Some(hosts) = self.net_egress.as_deref() {
            validate_unique_non_empty("capability_bundle.netEgress", hosts)?;
            for host in hosts {
                if host.chars().any(char::is_whitespace)
                    || host.contains('/')
                    || host.contains('\0')
                {
                    return Err(invalid(
                        "capability_bundle.netEgress entries must be host names without whitespace, slash, or NUL",
                    ));
                }
            }
        }
        let allowlist = self
            .tools
            .as_ref()
            .and_then(|tools| tools.run_command.as_ref())
            .and_then(|tool| tool.allowlist.as_deref())
            .unwrap_or_default();
        validate_unique_non_empty("capability_bundle.tools.run_command.allowlist", allowlist)?;
        if allowlist.is_empty() {
            return Err(invalid(
                "capability bundle does not grant run_command authority",
            ));
        }
        if let Some(token) = forbidden_permission_escape_token(command, args) {
            return Err(invalid(format!(
                "run_command contains forbidden permission-escape token {token}"
            )));
        }
        if !command_matches_allowlist(command, allowlist) {
            return Err(invalid(
                "command is not in capability_bundle.tools.run_command.allowlist",
            ));
        }
        Ok(())
    }
}

fn canonical_struct_digest<T: Serialize>(domain: Option<&[u8]>, value: &T) -> Result<String> {
    let value = serde_json::to_value(value).map_err(|error| {
        invalid(format!(
            "could not serialize normalized governed packet material: {error}"
        ))
    })?;
    let canonical = sort_json(value);
    let bytes = serde_json::to_vec(&canonical).map_err(|error| {
        invalid(format!(
            "could not encode normalized governed packet material: {error}"
        ))
    })?;
    let mut hasher = Sha256::new();
    if let Some(domain) = domain {
        hasher.update(domain);
    }
    hasher.update(bytes);
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

fn sort_json(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(sort_json).collect()),
        Value::Object(entries) => {
            let mut pairs = entries.into_iter().collect::<Vec<_>>();
            pairs.sort_by(|left, right| left.0.cmp(&right.0));
            let mut sorted = Map::new();
            for (key, value) in pairs {
                sorted.insert(key, sort_json(value));
            }
            Value::Object(sorted)
        }
        scalar => scalar,
    }
}

fn command_matches_allowlist(command: &str, allowlist: &[String]) -> bool {
    let trimmed = command.trim();
    let Some(argv0) = trimmed.split_whitespace().next() else {
        return false;
    };
    allowlist.iter().any(|entry| {
        entry == argv0
            || trimmed == entry
            || trimmed
                .strip_prefix(entry)
                .is_some_and(|suffix| suffix.starts_with(' '))
    })
}

fn forbidden_permission_escape_token<'a>(command: &'a str, args: &'a [String]) -> Option<&'a str> {
    const FORBIDDEN: &[&str] = &[
        "--dangerously-skip-permissions",
        "--dangerouslyskippermissions",
        "--dangerously-bypass-approvals-and-sandbox",
        "--permission-mode=bypasspermissions",
        "--bypass-permissions",
        "--bypasspermissions",
    ];
    command
        .split_whitespace()
        .chain(args.iter().map(String::as_str))
        .find(|token| {
            let normalized = token.trim().to_ascii_lowercase();
            FORBIDDEN.iter().any(|forbidden| {
                normalized == *forbidden || normalized.starts_with(&format!("{forbidden}="))
            }) || normalized == "bypasspermissions"
                || normalized.ends_with("=bypasspermissions")
        })
}

fn is_ambient_shell_or_launcher(command: &str) -> bool {
    let executable = command
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(command)
        .to_ascii_lowercase();
    matches!(
        executable.as_str(),
        "sh" | "bash"
            | "dash"
            | "zsh"
            | "fish"
            | "env"
            | "cmd"
            | "cmd.exe"
            | "powershell"
            | "powershell.exe"
            | "pwsh"
            | "pwsh.exe"
    )
}

fn validate_relative_glob(field: &str, value: &str) -> Result<()> {
    if value.starts_with('/')
        || value.starts_with('\\')
        || value.as_bytes().get(1) == Some(&b':')
        || value.split('/').any(|segment| segment == "..")
    {
        return Err(invalid(format!(
            "{field} entries must be relative globs without parent traversal"
        )));
    }
    Ok(())
}

fn validate_relative_path(field: &str, value: &str) -> Result<()> {
    let normalized = value.replace('\\', "/");
    if normalized.starts_with('/')
        || normalized.as_bytes().get(1) == Some(&b':')
        || normalized.split('/').any(|segment| segment == "..")
    {
        return Err(invalid(format!(
            "{field} must remain inside the candidate workspace"
        )));
    }
    Ok(())
}

fn validate_string_list(field: &str, values: &[String]) -> Result<()> {
    for value in values {
        if value.contains('\0') {
            return Err(invalid(format!("{field} must not contain NUL bytes")));
        }
    }
    Ok(())
}

fn validate_unique_non_empty(field: &str, values: &[String]) -> Result<()> {
    validate_string_list(field, values)?;
    let mut seen = HashSet::new();
    for value in values {
        validate_non_empty(field, value)?;
        if !seen.insert(value) {
            return Err(invalid(format!("{field} must not contain duplicates")));
        }
    }
    Ok(())
}

fn validate_unique_trimmed(field: &str, values: &[String]) -> Result<()> {
    let mut seen = HashSet::new();
    for value in values {
        validate_trimmed(field, value)?;
        if !seen.insert(value) {
            return Err(invalid(format!("{field} must not contain duplicates")));
        }
    }
    Ok(())
}

fn validate_trimmed(field: &str, value: &str) -> Result<()> {
    validate_non_empty(field, value)?;
    if value.trim() != value {
        return Err(invalid(format!("{field} must be trimmed")));
    }
    Ok(())
}

fn validate_non_empty(field: &str, value: &str) -> Result<()> {
    if value.is_empty() || value.contains('\0') {
        return Err(invalid(format!(
            "{field} must be a non-empty string without NUL bytes"
        )));
    }
    Ok(())
}

fn validate_sha256_digest(field: &str, value: &str) -> Result<()> {
    if value.len() != 71
        || !value.starts_with("sha256:")
        || !value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid(format!(
            "{field} must be a canonical lowercase sha256 digest"
        )));
    }
    Ok(())
}

fn invalid(reason: impl Into<String>) -> LedgerError {
    LedgerError::InvalidPayload {
        kind: "governed_command_packet_v1".into(),
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn source(capability_digest: &str) -> String {
        serde_json::to_string(&json!({
            "unit": {
                "id": "unit-1",
                "kind": "implementation",
                "scope": "task",
                "verificationContract": "tests pass",
                "policyProfile": "default"
            },
            "execution_role": "implementer",
            "execution": {
                "command": "/usr/bin/git",
                "args": ["status", "--short"],
                "cwd": "repo"
            },
            "intent": {
                "objective": "Inspect the candidate",
                "taskType": "implement",
                "features": {
                    "ambiguity": "low",
                    "reversibility": "easy",
                    "verifierStrength": "strong",
                    "changeSurface": 3
                }
            },
            "provenance_ref": "01900000-0000-7000-8000-000000000001",
            "capability_bundle": {
                "schemaVersion": "buildplane.capability_bundle.v0",
                "bundleId": "bundle-1",
                "fsRead": ["**/*"],
                "fsWrite": ["**/*"],
                "netEgress": [],
                "tools": {
                    "run_command": {
                        "allowlist": ["/usr/bin/git"]
                    }
                }
            },
            "capability_bundle_digest": capability_digest,
            "acceptance_contract": {
                "schemaVersion": 1,
                "contract_version": "v0",
                "diff_scope": { "allowed_globs": ["**/*"] },
                "checks": [{ "command": "git status --short" }]
            },
            "trust_scope": {
                "schemaVersion": 1,
                "lane": "governed",
                "principal": "operator",
                "scope": "repository"
            }
        }))
        .unwrap()
    }

    fn packet_with_computed_digests() -> (String, String, String) {
        let placeholder = format!("sha256:{}", "0".repeat(64));
        let preliminary: GovernedCommandPacketV1 =
            serde_json::from_str(&source(&placeholder)).unwrap();
        let bundle_digest = preliminary.capability_bundle_digest().unwrap();
        let source = source(&bundle_digest);
        let packet: GovernedCommandPacketV1 = serde_json::from_str(&source).unwrap();
        let packet_digest = packet.canonical_digest().unwrap();
        (source, bundle_digest, packet_digest)
    }

    #[test]
    fn normalizes_defaults_and_verifies_both_digests() {
        let (source, bundle_digest, packet_digest) = packet_with_computed_digests();
        assert_eq!(
            bundle_digest,
            "sha256:f9735004122fe5a668ec78fc26b3335ed0654d2dd1c16967bcd1d258b88dfeaa"
        );
        assert_eq!(
            packet_digest,
            "sha256:6d36115fece78efd5f4d17c9cffe6cabe78725a46b374c4b3bad0f9ce45d556c"
        );
        let packet = GovernedCommandPacketV1::parse_and_verify(&source, &packet_digest).unwrap();
        assert_eq!(
            packet.acceptance_contract_digest().unwrap(),
            "sha256:b05a1e96b6f3a5e6f415d435de0c46872a8b69ca89de30b5fc9cb7f485e301b4"
        );
        assert_eq!(packet.capability_bundle_digest, bundle_digest);
        assert!(packet.unit.input_refs.is_empty());
        assert!(packet.unit.expected_outputs.is_empty());
        assert!(packet.verification.required_outputs.is_empty());
        assert!(packet.intent.as_ref().unwrap().context.files.is_empty());
        assert!(packet.intent.as_ref().unwrap().constraints.scope.is_empty());
    }

    #[test]
    fn rejects_unknown_or_duplicate_fields() {
        let (_, bundle_digest, _) = packet_with_computed_digests();
        let unknown = source(&bundle_digest).replacen(
            "\"execution_role\":\"implementer\"",
            "\"execution_role\":\"implementer\",\"ambient_shell\":true",
            1,
        );
        assert!(serde_json::from_str::<GovernedCommandPacketV1>(&unknown).is_err());

        let duplicate = source(&bundle_digest).replacen(
            "\"command\":\"/usr/bin/git\"",
            "\"command\":\"/usr/bin/git\",\"command\":\"/bin/sh\"",
            1,
        );
        assert!(serde_json::from_str::<GovernedCommandPacketV1>(&duplicate).is_err());
    }

    #[test]
    fn rejects_digest_substitution_and_unallowlisted_commands() {
        let (source, _, packet_digest) = packet_with_computed_digests();
        let wrong = format!("sha256:{}", "f".repeat(64));
        assert!(GovernedCommandPacketV1::parse_and_verify(&source, &wrong).is_err());

        let substituted = source.replace("/usr/bin/git", "/bin/sh");
        assert!(GovernedCommandPacketV1::parse_and_verify(&substituted, &packet_digest).is_err());
    }

    #[test]
    fn rejects_permission_escape_and_candidate_path_escape() {
        let (source, _, _) = packet_with_computed_digests();
        let bypass = source.replace(
            "\"status\",\"--short\"",
            "\"status\",\"--dangerously-skip-permissions\"",
        );
        let packet: GovernedCommandPacketV1 = serde_json::from_str(&bypass).unwrap();
        assert!(packet.validate().is_err());

        let escape = source.replace("\"cwd\":\"repo\"", "\"cwd\":\"../target\"");
        let packet: GovernedCommandPacketV1 = serde_json::from_str(&escape).unwrap();
        assert!(packet.validate().is_err());
    }

    #[test]
    fn protected_acceptance_requires_typed_shell_free_checks() {
        let (_, bundle_digest, _) = packet_with_computed_digests();
        let typed = source(&bundle_digest)
            .replace("\"contract_version\":\"v0\"", "\"contract_version\":\"v1\"")
            .replace(
                "{\"command\":\"git status --short\"}",
                "{\"command\":\"/usr/bin/git\",\"args\":[\"status\",\"--short\"]}",
            );
        let packet: GovernedCommandPacketV1 = serde_json::from_str(&typed).unwrap();
        let checks = packet.protected_acceptance_checks().unwrap();
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].command, "/usr/bin/git");
        assert_eq!(checks[0].args, vec!["status", "--short"]);

        let legacy: GovernedCommandPacketV1 =
            serde_json::from_str(&source(&bundle_digest)).unwrap();
        assert!(legacy.protected_acceptance_checks().is_err());

        let shell = typed.replace("/usr/bin/git", "/bin/sh");
        let shell: GovernedCommandPacketV1 = serde_json::from_str(&shell).unwrap();
        assert!(shell.protected_acceptance_checks().is_err());
    }

    #[test]
    fn rejects_oversized_source_before_json_parsing() {
        let source = " ".repeat(MAX_GOVERNED_COMMAND_PACKET_SOURCE_BYTES + 1);
        assert!(GovernedCommandPacketV1::parse_and_verify(
            &source,
            &format!("sha256:{}", "0".repeat(64))
        )
        .is_err());
    }
}
