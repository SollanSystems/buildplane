use bp_core::{AuthMode, AutonomyLevel, ReasoningLevel, TransportKind};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PackManifest {
    pub schema_version: u32,
    pub pack: PackMetadata,
    #[serde(default)]
    pub memory: MemoryPolicy,
    #[serde(default)]
    pub modes: Vec<PackMode>,
    #[serde(default)]
    pub commands: Vec<PackCommand>,
    #[serde(default)]
    pub host_preferences: Vec<HostPreference>,
}

impl PackManifest {
    pub fn parse_str(input: &str) -> Result<Self, ManifestError> {
        let manifest: Self = toml::from_str(input)?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn parse_file(path: impl AsRef<Path>) -> Result<Self, ManifestError> {
        let path = path.as_ref();
        let input = fs::read_to_string(path)?;
        Self::parse_str(&input)
    }

    pub fn validate(&self) -> Result<(), ManifestError> {
        if self.schema_version != 1 {
            return Err(ManifestError::UnsupportedSchemaVersion(self.schema_version));
        }

        validate_pack_id(&self.pack.id)?;

        if self.modes.is_empty() {
            return Err(ManifestError::MissingModes);
        }

        let mut seen_modes = BTreeSet::new();
        for mode in &self.modes {
            if !seen_modes.insert(mode.id.clone()) {
                return Err(ManifestError::DuplicateModeId(mode.id.clone()));
            }
        }

        let default_modes = self.modes.iter().filter(|mode| mode.default).count();
        if self.modes.len() > 1 && default_modes == 0 {
            return Err(ManifestError::MissingDefaultMode);
        }
        if default_modes > 1 {
            return Err(ManifestError::MultipleDefaultModes);
        }

        for command in &self.commands {
            if !seen_modes.contains(&command.mode) {
                return Err(ManifestError::UnknownCommandMode {
                    command: command.name.clone(),
                    mode: command.mode.clone(),
                });
            }
        }

        Ok(())
    }

    pub fn default_mode(&self) -> Option<&PackMode> {
        self.modes
            .iter()
            .find(|mode| mode.default)
            .or_else(|| self.modes.first())
    }

    pub fn ordered_host_preferences(&self) -> Vec<&HostPreference> {
        let mut refs = self.host_preferences.iter().collect::<Vec<_>>();
        refs.sort_by_key(|pref| pref.priority);
        refs
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PackMetadata {
    pub id: String,
    pub display_name: String,
    pub version: String,
    pub description: Option<String>,
    pub default_provider: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemoryPolicy {
    #[serde(default = "bool_true")]
    pub share_user: bool,
    #[serde(default = "bool_true")]
    pub share_workspace: bool,
    #[serde(default = "bool_true")]
    pub share_pack: bool,
}

impl Default for MemoryPolicy {
    fn default() -> Self {
        Self {
            share_user: true,
            share_workspace: true,
            share_pack: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PackMode {
    pub id: String,
    pub display_name: String,
    pub reasoning: ReasoningLevel,
    pub autonomy: AutonomyLevel,
    #[serde(default)]
    pub default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PackCommand {
    pub name: String,
    pub mode: String,
    pub description: String,
    pub template: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostPreference {
    pub host: String,
    #[serde(default)]
    pub transport: TransportKind,
    #[serde(default)]
    pub auth: AuthMode,
    #[serde(default)]
    pub priority: u16,
}

pub fn validate_pack_id(pack_id: &str) -> Result<(), ManifestError> {
    if pack_id.trim().is_empty() {
        return Err(ManifestError::EmptyPackId);
    }

    if !is_valid_pack_id(pack_id) {
        return Err(ManifestError::InvalidPackId(pack_id.to_string()));
    }

    Ok(())
}

pub fn is_valid_pack_id(pack_id: &str) -> bool {
    !pack_id.is_empty()
        && !pack_id.starts_with('-')
        && !pack_id.ends_with('-')
        && pack_id
            .bytes()
            .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'-'))
}

#[derive(Debug, Error)]
pub enum ManifestError {
    #[error("failed to read manifest: {0}")]
    Io(#[from] std::io::Error),
    #[error("failed to parse manifest TOML: {0}")]
    Parse(#[from] toml::de::Error),
    #[error("unsupported schema_version {0}; expected 1")]
    UnsupportedSchemaVersion(u32),
    #[error("pack.id must not be empty")]
    EmptyPackId,
    #[error("pack.id '{0}' must be a lowercase slug using only a-z, 0-9, and '-' characters")]
    InvalidPackId(String),
    #[error("manifest must declare at least one mode")]
    MissingModes,
    #[error("mode id '{0}' is declared more than once")]
    DuplicateModeId(String),
    #[error("multiple modes are marked default")]
    MultipleDefaultModes,
    #[error("manifests with more than one mode must mark exactly one default mode")]
    MissingDefaultMode,
    #[error("command '{command}' references unknown mode '{mode}'")]
    UnknownCommandMode { command: String, mode: String },
}

const fn bool_true() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_manifest_toml() -> &'static str {
        r#"
        schema_version = 1

        [pack]
        id = "superclaude"
        display_name = "SuperClaude"
        version = "0.1.0"
        default_provider = "anthropic"

        [memory]
        share_user = true
        share_workspace = true
        share_pack = true

        [[modes]]
        id = "daily"
        display_name = "Daily"
        reasoning = "fast"
        autonomy = "guided"
        default = true

        [[modes]]
        id = "deep"
        display_name = "Deep"
        reasoning = "xhigh"
        autonomy = "spec-driven"

        [[commands]]
        name = "/fast"
        mode = "daily"
        description = "Fast daily loop"

        [[host_preferences]]
        host = "claude"
        priority = 10
        "#
    }

    #[test]
    fn parses_valid_manifest_and_exposes_default_mode() {
        let manifest = PackManifest::parse_str(valid_manifest_toml()).expect("valid manifest");

        assert_eq!(manifest.pack.id, "superclaude");
        assert_eq!(
            manifest.default_mode().map(|mode| mode.id.as_str()),
            Some("daily")
        );
        assert_eq!(manifest.commands.len(), 1);
    }

    #[test]
    fn rejects_invalid_pack_ids() {
        let manifest = valid_manifest_toml().replace("id = \"superclaude\"", "id = \"../escape\"");

        let err = PackManifest::parse_str(&manifest).expect_err("invalid pack ids should fail");
        assert!(matches!(err, ManifestError::InvalidPackId(pack_id) if pack_id == "../escape"));
    }

    #[test]
    fn rejects_duplicate_mode_ids() {
        let manifest = r#"
        schema_version = 1

        [pack]
        id = "superclaude"
        display_name = "SuperClaude"
        version = "0.1.0"

        [[modes]]
        id = "daily"
        display_name = "Daily"
        reasoning = "fast"
        autonomy = "guided"
        default = true

        [[modes]]
        id = "daily"
        display_name = "Duplicate"
        reasoning = "deep"
        autonomy = "spec-driven"
        "#;

        let err = PackManifest::parse_str(manifest).expect_err("duplicate modes should fail");
        assert!(matches!(err, ManifestError::DuplicateModeId(mode) if mode == "daily"));
    }

    #[test]
    fn rejects_unknown_command_mode() {
        let manifest = r#"
        schema_version = 1

        [pack]
        id = "superclaude"
        display_name = "SuperClaude"
        version = "0.1.0"

        [[modes]]
        id = "daily"
        display_name = "Daily"
        reasoning = "fast"
        autonomy = "guided"
        default = true

        [[commands]]
        name = "/deep"
        mode = "missing"
        description = "Unknown mode"
        "#;

        let err = PackManifest::parse_str(manifest).expect_err("unknown mode should fail");
        assert!(matches!(
            err,
            ManifestError::UnknownCommandMode { command, mode }
                if command == "/deep" && mode == "missing"
        ));
    }

    #[test]
    fn requires_default_mode_when_multiple_modes_exist() {
        let manifest = r#"
        schema_version = 1

        [pack]
        id = "superclaude"
        display_name = "SuperClaude"
        version = "0.1.0"

        [[modes]]
        id = "daily"
        display_name = "Daily"
        reasoning = "fast"
        autonomy = "guided"

        [[modes]]
        id = "deep"
        display_name = "Deep"
        reasoning = "xhigh"
        autonomy = "spec-driven"
        "#;

        let err = PackManifest::parse_str(manifest).expect_err("missing default mode should fail");
        assert!(matches!(err, ManifestError::MissingDefaultMode));
    }
}
