use bp_host_claude::ClaudeHostAdapter;
use bp_host_codex::CodexHostAdapter;
use bp_host_sdk::{
    AuthState, DetectionContext, HostBridgePlan, HostError, HostExecutionHandle,
    HostExecutionRequest, HostRegistry, RegisteredHostAdapter,
};

#[derive(Debug, Default, Clone, Copy)]
pub struct NativeHostRegistry;

pub fn registered_host_adapters() -> Vec<Box<dyn RegisteredHostAdapter>> {
    vec![Box::new(ClaudeHostAdapter), Box::new(CodexHostAdapter)]
}

impl NativeHostRegistry {
    fn adapter_for_host_or_error(
        &self,
        host_id: &str,
    ) -> Result<Box<dyn RegisteredHostAdapter>, HostError> {
        self.adapter_for_host(host_id)
            .ok_or(HostError::Unsupported("requested host is not registered"))
    }

    async fn ensure_host_is_bridgeable(
        &self,
        adapter: &dyn RegisteredHostAdapter,
        context: &DetectionContext,
    ) -> Result<(), HostError> {
        let status = adapter.status(context).await?;
        if !status.detected {
            return Err(HostError::NotDetected);
        }
        if !matches!(status.auth, AuthState::Available) {
            return Err(HostError::AuthUnavailable);
        }
        Ok(())
    }

    pub async fn plan_bridge_for_host(
        &self,
        host_id: &str,
        context: &DetectionContext,
        request: &HostExecutionRequest,
    ) -> Result<HostBridgePlan, HostError> {
        let adapter = self.adapter_for_host_or_error(host_id)?;
        self.ensure_host_is_bridgeable(adapter.as_ref(), context)
            .await?;
        adapter.plan_bridge(context, request).await
    }

    pub async fn execute_for_host(
        &self,
        host_id: &str,
        context: &DetectionContext,
        request: HostExecutionRequest,
    ) -> Result<HostExecutionHandle, HostError> {
        let adapter = self.adapter_for_host_or_error(host_id)?;
        self.ensure_host_is_bridgeable(adapter.as_ref(), context)
            .await?;
        adapter.execute(request).await
    }
}

impl HostRegistry for NativeHostRegistry {
    fn host_adapters(&self) -> Vec<Box<dyn RegisteredHostAdapter>> {
        registered_host_adapters()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bp_host_sdk::{DetectionContext, HostExecutionRequest, HostSessionContext};
    use futures::executor::block_on;
    use std::path::PathBuf;

    fn detection_context(entries: &[(&str, &str)]) -> DetectionContext {
        DetectionContext {
            workspace_root: PathBuf::from("/tmp/buildplane-test-workspace"),
            env: entries
                .iter()
                .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
                .collect(),
        }
    }

    fn execution_request() -> HostExecutionRequest {
        HostExecutionRequest {
            session: HostSessionContext {
                pack_id: "superclaude".to_string(),
                mode_id: Some("default".to_string()),
                workspace_root: PathBuf::from("/tmp/buildplane-test-workspace"),
            },
            messages: Vec::new(),
            tools: Vec::new(),
            max_tokens: None,
            temperature: None,
        }
    }

    #[test]
    fn registry_lists_hosts_in_expected_order() {
        let registry = NativeHostRegistry;

        assert_eq!(registry.available_hosts(), vec!["claude", "codex"]);
    }

    #[test]
    fn registry_can_plan_codex_bridge_for_detected_host() {
        let registry = NativeHostRegistry;
        let plan = block_on(registry.plan_bridge_for_host(
            "codex",
            &detection_context(&[("OPENAI_CODEX", "1")]),
            &execution_request(),
        ))
        .expect("registered codex adapter should plan a bridge");

        assert_eq!(plan.descriptor.host, "codex");
        assert_eq!(
            plan.working_dir,
            PathBuf::from("/tmp/buildplane-test-workspace")
        );
    }

    #[test]
    fn registry_execution_bridge_requires_detected_host() {
        let registry = NativeHostRegistry;
        let result = block_on(registry.execute_for_host(
            "claude",
            &detection_context(&[]),
            execution_request(),
        ));

        match result {
            Err(HostError::NotDetected) => {}
            Err(other) => panic!("expected not-detected error, got {other:?}"),
            Ok(_) => panic!("undetected hosts should be rejected before execution"),
        }
    }

    #[test]
    fn registry_exposes_execute_bridge_seam_for_detected_host() {
        let registry = NativeHostRegistry;
        let result = block_on(registry.execute_for_host(
            "claude",
            &detection_context(&[("CLAUDE_CODE", "1")]),
            execution_request(),
        ));

        match result {
            Err(HostError::Unsupported(message))
                if message == "Claude host execute bridge stub" => {}
            Err(other) => panic!("expected Claude execute stub error, got {other:?}"),
            Ok(_) => panic!("current host adapters should still return stub execution handles"),
        }
    }
}
