use bp_host_registry::NativeHostRegistry;
use bp_host_sdk::{
    AuthState, DetectionContext, HostBridgePlan, HostExecutionRequest, HostRegistry,
    HostSessionContext, HostStatus, RegisteredHostAdapter,
};
use bp_pack_loader::{load_pack_from_native_root, LoadedPack};
use bp_runtime::{resolve_transport, ExecutionRoute, RuntimeSelection, RuntimeSelectionInput};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InspectPackRequest {
    pub pack_id: String,
    pub native_root: PathBuf,
    pub workspace_root: PathBuf,
    pub explicit_host: Option<String>,
    pub explicit_provider: Option<String>,
    pub detected_hosts: Vec<String>,
    pub process_env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostInspectionRow {
    pub host: String,
    pub display_name: String,
    pub status: HostStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DetectionSource {
    Environment,
    CliOverride,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackInspectionReport {
    pub workspace_root: PathBuf,
    pub selection: RuntimeSelection,
    pub host_rows: Vec<HostInspectionRow>,
    pub effective_detected_hosts: Vec<String>,
    pub detection_source: DetectionSource,
    pub bridge_plan: Option<HostBridgePlan>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedPackInspection {
    pub loaded: LoadedPack,
    pub report: PackInspectionReport,
}

pub fn collect_process_env() -> BTreeMap<String, String> {
    std::env::vars().collect()
}

pub fn bridge_request(loaded: &LoadedPack, workspace_root: &Path) -> HostExecutionRequest {
    HostExecutionRequest {
        session: HostSessionContext {
            pack_id: loaded.manifest.pack.id.clone(),
            mode_id: loaded.manifest.default_mode().map(|mode| mode.id.clone()),
            workspace_root: workspace_root.to_path_buf(),
        },
        messages: Vec::new(),
        tools: Vec::new(),
        max_tokens: None,
        temperature: None,
    }
}

pub async fn inspect_pack(request: &InspectPackRequest) -> Result<LoadedPackInspection, String> {
    let loaded = load_pack_from_native_root(&request.native_root, &request.pack_id)
        .map_err(|err| err.to_string())?;
    let report = build_pack_report(&loaded, request).await?;

    Ok(LoadedPackInspection { loaded, report })
}

pub async fn build_pack_report(
    loaded: &LoadedPack,
    request: &InspectPackRequest,
) -> Result<PackInspectionReport, String> {
    let context = DetectionContext {
        workspace_root: request.workspace_root.clone(),
        env: request.process_env.clone(),
    };
    let registry = NativeHostRegistry;
    let host_adapters = registry.host_adapters();
    let mut host_rows = Vec::with_capacity(host_adapters.len());
    for adapter in host_adapters.iter() {
        host_rows.push(
            inspect_host(
                adapter.id(),
                adapter.display_name(),
                &context,
                adapter.as_ref(),
            )
            .await?,
        );
    }

    let (effective_detected_hosts, detection_source) = if request.detected_hosts.is_empty() {
        (
            collect_detected_hosts(&host_rows),
            DetectionSource::Environment,
        )
    } else {
        (
            dedupe_preserve_order(request.detected_hosts.clone()),
            DetectionSource::CliOverride,
        )
    };

    let selection = resolve_transport(
        &loaded.manifest,
        &RuntimeSelectionInput {
            explicit_host: request.explicit_host.clone(),
            explicit_provider: request.explicit_provider.clone(),
            detected_hosts: effective_detected_hosts.clone(),
        },
    );

    let bridge_plan = build_bridge_plan(
        &registry,
        &selection,
        &host_rows,
        &context,
        loaded,
        &request.workspace_root,
    )
    .await?;

    Ok(PackInspectionReport {
        workspace_root: request.workspace_root.clone(),
        selection,
        host_rows,
        effective_detected_hosts,
        detection_source,
        bridge_plan,
    })
}

async fn inspect_host(
    host_id: &str,
    display_name: &str,
    context: &DetectionContext,
    adapter: &dyn RegisteredHostAdapter,
) -> Result<HostInspectionRow, String> {
    let status = adapter
        .status(context)
        .await
        .map_err(|err| format!("failed to inspect host '{host_id}': {err}"))?;

    Ok(HostInspectionRow {
        host: host_id.to_string(),
        display_name: display_name.to_string(),
        status,
    })
}

async fn build_bridge_plan(
    registry: &NativeHostRegistry,
    selection: &RuntimeSelection,
    host_rows: &[HostInspectionRow],
    context: &DetectionContext,
    loaded: &LoadedPack,
    workspace_root: &Path,
) -> Result<Option<HostBridgePlan>, String> {
    let ExecutionRoute::Host(host_id) = &selection.route else {
        return Ok(None);
    };

    let Some(host_row) = host_rows.iter().find(|row| row.host == host_id.as_str()) else {
        return Ok(None);
    };

    if !host_status_is_bridgeable(&host_row.status) {
        return Ok(None);
    }

    let request = bridge_request(loaded, workspace_root);
    registry
        .plan_bridge_for_host(host_id, context, &request)
        .await
        .map(Some)
        .map_err(|err| format!("failed to plan bridge for host '{host_id}': {err}"))
}

fn collect_detected_hosts(host_rows: &[HostInspectionRow]) -> Vec<String> {
    host_rows
        .iter()
        .filter(|row| row.status.detected)
        .map(|row| row.host.clone())
        .collect()
}

fn dedupe_preserve_order(hosts: Vec<String>) -> Vec<String> {
    let mut unique_hosts = Vec::new();
    for host in hosts {
        if !unique_hosts.iter().any(|candidate| candidate == &host) {
            unique_hosts.push(host);
        }
    }
    unique_hosts
}

fn host_status_is_bridgeable(status: &HostStatus) -> bool {
    status.detected && matches!(status.auth, AuthState::Available)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bp_runtime::{ExecutionRoute, RuntimeSelectionProvenance};
    use futures::executor::block_on;

    #[derive(Debug, Clone, Default)]
    struct InspectOverrides {
        workspace_root: Option<PathBuf>,
        explicit_host: Option<String>,
        explicit_provider: Option<String>,
        detected_hosts: Vec<String>,
    }

    fn native_root_for_tests() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    fn env_map_for_test(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
        entries
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    fn inspect_request_for_test(
        pack_id: &str,
        env_entries: &[(&str, &str)],
        overrides: InspectOverrides,
    ) -> InspectPackRequest {
        let InspectOverrides {
            workspace_root,
            explicit_host,
            explicit_provider,
            detected_hosts,
        } = overrides;

        InspectPackRequest {
            pack_id: pack_id.to_string(),
            native_root: native_root_for_tests(),
            workspace_root: workspace_root
                .unwrap_or_else(|| PathBuf::from("/tmp/buildplane-test-workspace")),
            explicit_host,
            explicit_provider,
            detected_hosts,
            process_env: env_map_for_test(env_entries),
        }
    }

    fn inspect_report_for_test(
        pack_id: &str,
        env_entries: &[(&str, &str)],
        overrides: InspectOverrides,
    ) -> Result<PackInspectionReport, String> {
        let request = inspect_request_for_test(pack_id, env_entries, overrides);
        let inspection = block_on(inspect_pack(&request))?;
        Ok(inspection.report)
    }

    #[test]
    fn detects_claude_and_selects_host_route_for_superclaude() {
        let report = inspect_report_for_test(
            "superclaude",
            &[("CLAUDE_CODE", "1")],
            InspectOverrides::default(),
        )
        .expect("inspection should succeed");

        assert_eq!(
            report.selection.route,
            ExecutionRoute::Host("claude".to_string())
        );
        assert_eq!(
            report.selection.provenance,
            RuntimeSelectionProvenance::DetectedPreferredHost {
                matched_host: "claude".to_string(),
            }
        );
        assert_eq!(report.detection_source, DetectionSource::Environment);
        assert_eq!(report.effective_detected_hosts, vec!["claude".to_string()]);
        assert!(
            report
                .host_rows
                .iter()
                .any(|row| row.host == "claude" && row.status.detected),
            "expected Claude row to be detected"
        );
        assert!(report.bridge_plan.is_some(), "expected Claude bridge plan");
    }

    #[test]
    fn explicit_provider_override_wins_even_when_host_is_detected() {
        let report = inspect_report_for_test(
            "superclaude",
            &[("CLAUDE_CODE", "1")],
            InspectOverrides {
                explicit_provider: Some("openai".to_string()),
                ..InspectOverrides::default()
            },
        )
        .expect("inspection should succeed");

        assert_eq!(
            report.selection.route,
            ExecutionRoute::Provider("openai".to_string())
        );
        assert_eq!(
            report.selection.provenance,
            RuntimeSelectionProvenance::ExplicitProvider
        );
        assert!(
            report.bridge_plan.is_none(),
            "provider routes should not produce a bridge plan"
        );
    }

    #[test]
    fn pack_with_no_detected_hosts_falls_back_to_default_provider() {
        let report = inspect_report_for_test("supercodex", &[], InspectOverrides::default())
            .expect("inspection should succeed");

        assert_eq!(
            report.selection.route,
            ExecutionRoute::Provider("openai".to_string())
        );
        assert_eq!(
            report.selection.provenance,
            RuntimeSelectionProvenance::PackDefaultProvider
        );
        assert!(
            report.bridge_plan.is_none(),
            "provider routes should not produce a bridge plan"
        );
    }

    #[test]
    fn cli_detected_host_override_selects_codex_bridge_for_superclaude() {
        let report = inspect_report_for_test(
            "superclaude",
            &[("OPENAI_CODEX", "1")],
            InspectOverrides {
                detected_hosts: vec!["codex".to_string(), "codex".to_string()],
                ..InspectOverrides::default()
            },
        )
        .expect("inspection should succeed");

        assert_eq!(report.detection_source, DetectionSource::CliOverride);
        assert_eq!(report.effective_detected_hosts, vec!["codex".to_string()]);
        assert_eq!(
            report.selection.route,
            ExecutionRoute::Host("codex".to_string())
        );
        assert_eq!(
            report.selection.provenance,
            RuntimeSelectionProvenance::DetectedPreferredHost {
                matched_host: "codex".to_string(),
            }
        );
        assert!(report.bridge_plan.is_some(), "expected Codex bridge plan");
    }
}
