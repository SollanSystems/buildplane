use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ScopeKind {
    User,
    Workspace,
    Pack,
    Session,
    #[default]
    Task,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ReasoningLevel {
    Minimal,
    Fast,
    #[default]
    Balanced,
    Deep,
    #[serde(rename = "xhigh", alias = "x-high")]
    XHigh,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AutonomyLevel {
    Manual,
    #[default]
    Guided,
    Supervised,
    SpecDriven,
    Autonomous,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TransportKind {
    #[default]
    Host,
    Provider,
    Standalone,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AuthMode {
    #[default]
    HostOauth,
    DirectApiKey,
    SharedSession,
    LocalAgent,
}
