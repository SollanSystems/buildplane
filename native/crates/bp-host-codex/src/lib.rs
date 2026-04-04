use async_trait::async_trait;
use bp_host_sdk::{
    AuthState, DetectionContext, HostAdapter, HostBridgeAdapter, HostBridgeAuthOwnership,
    HostBridgeDescriptor, HostBridgePlan, HostBridgeProtocol, HostCapabilities, HostError,
    HostExecutionHandle, HostExecutionRequest, HostStatus,
};
use std::collections::BTreeMap;

const CODEX_HOST_MARKERS: [&str; 3] = ["CODEX_HOME", "OPENAI_CODEX", "CODEX_SESSION_ID"];

pub struct CodexHostAdapter;

#[async_trait]
impl HostAdapter for CodexHostAdapter {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn display_name(&self) -> &'static str {
        "OpenAI Codex"
    }

    fn capabilities(&self) -> HostCapabilities {
        HostCapabilities {
            supports_patch_apply: true,
            ..HostCapabilities::default()
        }
    }

    async fn detect(&self, context: &DetectionContext) -> Result<bool, HostError> {
        Ok(CODEX_HOST_MARKERS
            .iter()
            .any(|key| context.env.contains_key(*key)))
    }

    async fn status(&self, context: &DetectionContext) -> Result<HostStatus, HostError> {
        let detected = self.detect(context).await?;
        let detail = if detected {
            Some(
                "Codex host environment detected; execution bridge remains a broker stub"
                    .to_string(),
            )
        } else {
            Some("No Codex host markers detected in environment".to_string())
        };

        Ok(HostStatus {
            detected,
            auth: if detected {
                AuthState::Available
            } else {
                AuthState::RequiresLogin
            },
            capabilities: self.capabilities(),
            detail,
        })
    }

    async fn execute(
        &self,
        _request: HostExecutionRequest,
    ) -> Result<HostExecutionHandle, HostError> {
        Err(HostError::Unsupported("Codex host execute bridge stub"))
    }
}

#[async_trait]
impl HostBridgeAdapter for CodexHostAdapter {
    fn bridge_descriptor(&self) -> HostBridgeDescriptor {
        HostBridgeDescriptor {
            host: self.id().to_string(),
            display_name: self.display_name().to_string(),
            entrypoint_hint: Some("codex".to_string()),
            protocol: HostBridgeProtocol::BrokeredCli,
            auth_ownership: HostBridgeAuthOwnership::HostManaged,
            notes: vec![
                "Prefer host-owned Codex auth/session reuse before direct OpenAI fallback."
                    .to_string(),
                "This descriptor sketches the bridge boundary only; the live execution broker is still TBD."
                    .to_string(),
            ],
        }
    }

    async fn plan_bridge(
        &self,
        context: &DetectionContext,
        request: &HostExecutionRequest,
    ) -> Result<HostBridgePlan, HostError> {
        if !self.detect(context).await? {
            return Err(HostError::NotDetected);
        }

        Ok(HostBridgePlan {
            descriptor: self.bridge_descriptor(),
            working_dir: request.session.workspace_root.clone(),
            mode_hint: request.session.mode_id.clone(),
            activation_env: capture_activation_env(context, &CODEX_HOST_MARKERS),
            notes: vec![
                "Translate Buildplane chat/tool events into the Codex host session boundary."
                    .to_string(),
                "Do not treat direct provider API keys as host detection; host reuse and provider fallback stay separate."
                    .to_string(),
            ],
        })
    }
}

fn capture_activation_env(context: &DetectionContext, keys: &[&str]) -> BTreeMap<String, String> {
    keys.iter()
        .filter_map(|key| {
            context
                .env
                .get(*key)
                .map(|value| ((*key).to_string(), value.clone()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use bp_host_sdk::HostBridgeAdapter;

    #[test]
    fn bridge_descriptor_points_at_codex_host() {
        let adapter = CodexHostAdapter;
        let descriptor = adapter.bridge_descriptor();

        assert_eq!(descriptor.host, "codex");
        assert_eq!(descriptor.display_name, "OpenAI Codex");
        assert_eq!(descriptor.entrypoint_hint.as_deref(), Some("codex"));
        assert_eq!(
            descriptor.auth_ownership,
            HostBridgeAuthOwnership::HostManaged
        );
    }
}
