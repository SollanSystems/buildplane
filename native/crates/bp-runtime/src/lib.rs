use bp_pack_manifest::PackManifest;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "route", content = "value", rename_all = "kebab-case")]
pub enum ExecutionRoute {
    Host(String),
    Provider(String),
    Standalone,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RuntimeSelectionProvenance {
    ExplicitHost,
    ExplicitProvider,
    DetectedPreferredHost { matched_host: String },
    PackDefaultProvider,
    Standalone,
}

impl RuntimeSelectionProvenance {
    pub fn reason(&self) -> String {
        match self {
            Self::ExplicitHost => "explicit host requested".to_string(),
            Self::ExplicitProvider => "explicit provider requested".to_string(),
            Self::DetectedPreferredHost { matched_host } => {
                format!("detected preferred host '{matched_host}' from pack manifest")
            }
            Self::PackDefaultProvider => "falling back to pack default provider".to_string(),
            Self::Standalone => {
                "no host or provider preference available; keep runtime standalone".to_string()
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeSelection {
    pub route: ExecutionRoute,
    pub provenance: RuntimeSelectionProvenance,
}

impl RuntimeSelection {
    pub fn reason(&self) -> String {
        self.provenance.reason()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeSelectionInput {
    pub explicit_host: Option<String>,
    pub explicit_provider: Option<String>,
    #[serde(default)]
    pub detected_hosts: Vec<String>,
}

pub fn resolve_transport(
    manifest: &PackManifest,
    input: &RuntimeSelectionInput,
) -> RuntimeSelection {
    if let Some(host) = &input.explicit_host {
        return RuntimeSelection {
            route: ExecutionRoute::Host(host.clone()),
            provenance: RuntimeSelectionProvenance::ExplicitHost,
        };
    }

    if let Some(provider) = &input.explicit_provider {
        return RuntimeSelection {
            route: ExecutionRoute::Provider(provider.clone()),
            provenance: RuntimeSelectionProvenance::ExplicitProvider,
        };
    }

    for preference in manifest.ordered_host_preferences() {
        if input
            .detected_hosts
            .iter()
            .any(|candidate| candidate == &preference.host)
        {
            return RuntimeSelection {
                route: ExecutionRoute::Host(preference.host.clone()),
                provenance: RuntimeSelectionProvenance::DetectedPreferredHost {
                    matched_host: preference.host.clone(),
                },
            };
        }
    }

    if let Some(provider) = &manifest.pack.default_provider {
        return RuntimeSelection {
            route: ExecutionRoute::Provider(provider.clone()),
            provenance: RuntimeSelectionProvenance::PackDefaultProvider,
        };
    }

    RuntimeSelection {
        route: ExecutionRoute::Standalone,
        provenance: RuntimeSelectionProvenance::Standalone,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(default_provider: Option<&str>, host_preferences: &str) -> PackManifest {
        let default_provider_line = default_provider
            .map(|provider| format!("default_provider = \"{}\"\n", provider))
            .unwrap_or_default();

        let input = format!(
            r#"
            schema_version = 1

            [pack]
            id = "superclaude"
            display_name = "SuperClaude"
            version = "0.1.0"
            {default_provider_line}

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

            {host_preferences}
            "#
        );

        PackManifest::parse_str(&input).expect("valid runtime test manifest")
    }

    #[test]
    fn prefers_explicit_host_over_detected_or_provider_fallbacks() {
        let manifest = manifest(
            Some("anthropic"),
            r#"
            [[host_preferences]]
            host = "claude"
            priority = 10
            "#,
        );

        let selection = resolve_transport(
            &manifest,
            &RuntimeSelectionInput {
                explicit_host: Some("codex".to_string()),
                explicit_provider: Some("openai".to_string()),
                detected_hosts: vec!["claude".to_string()],
            },
        );

        assert_eq!(selection.route, ExecutionRoute::Host("codex".to_string()));
        assert_eq!(
            selection.provenance,
            RuntimeSelectionProvenance::ExplicitHost
        );
        assert_eq!(selection.reason(), "explicit host requested");
    }

    #[test]
    fn prefers_explicit_provider_before_detected_pack_host() {
        let manifest = manifest(
            Some("anthropic"),
            r#"
            [[host_preferences]]
            host = "claude"
            priority = 20

            [[host_preferences]]
            host = "codex"
            priority = 10
            "#,
        );

        let selection = resolve_transport(
            &manifest,
            &RuntimeSelectionInput {
                explicit_host: None,
                explicit_provider: Some("openai".to_string()),
                detected_hosts: vec!["claude".to_string(), "codex".to_string()],
            },
        );

        assert_eq!(
            selection.route,
            ExecutionRoute::Provider("openai".to_string())
        );
        assert_eq!(
            selection.provenance,
            RuntimeSelectionProvenance::ExplicitProvider
        );
        assert_eq!(selection.reason(), "explicit provider requested");
    }

    #[test]
    fn uses_detected_preferred_host_before_provider_fallback() {
        let manifest = manifest(
            Some("anthropic"),
            r#"
            [[host_preferences]]
            host = "claude"
            priority = 20

            [[host_preferences]]
            host = "codex"
            priority = 10
            "#,
        );

        let selection = resolve_transport(
            &manifest,
            &RuntimeSelectionInput {
                explicit_host: None,
                explicit_provider: None,
                detected_hosts: vec!["codex".to_string(), "claude".to_string()],
            },
        );

        assert_eq!(selection.route, ExecutionRoute::Host("codex".to_string()));
        assert_eq!(
            selection.provenance,
            RuntimeSelectionProvenance::DetectedPreferredHost {
                matched_host: "codex".to_string(),
            }
        );
        assert_eq!(
            selection.reason(),
            "detected preferred host 'codex' from pack manifest"
        );
    }

    #[test]
    fn uses_explicit_provider_when_no_host_is_selected() {
        let manifest = manifest(Some("anthropic"), "");

        let selection = resolve_transport(
            &manifest,
            &RuntimeSelectionInput {
                explicit_host: None,
                explicit_provider: Some("openai".to_string()),
                detected_hosts: Vec::new(),
            },
        );

        assert_eq!(
            selection.route,
            ExecutionRoute::Provider("openai".to_string())
        );
        assert_eq!(
            selection.provenance,
            RuntimeSelectionProvenance::ExplicitProvider
        );
        assert_eq!(selection.reason(), "explicit provider requested");
    }

    #[test]
    fn falls_back_to_pack_default_provider() {
        let manifest = manifest(Some("anthropic"), "");

        let selection = resolve_transport(&manifest, &RuntimeSelectionInput::default());

        assert_eq!(
            selection.route,
            ExecutionRoute::Provider("anthropic".to_string())
        );
        assert_eq!(
            selection.provenance,
            RuntimeSelectionProvenance::PackDefaultProvider
        );
        assert_eq!(selection.reason(), "falling back to pack default provider");
    }

    #[test]
    fn stays_standalone_when_nothing_else_is_available() {
        let manifest = manifest(None, "");

        let selection = resolve_transport(&manifest, &RuntimeSelectionInput::default());

        assert_eq!(selection.route, ExecutionRoute::Standalone);
        assert_eq!(selection.provenance, RuntimeSelectionProvenance::Standalone);
        assert_eq!(
            selection.reason(),
            "no host or provider preference available; keep runtime standalone"
        );
    }
}
