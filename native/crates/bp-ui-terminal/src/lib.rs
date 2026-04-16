use bp_host_sdk::{AuthState, HostBridgeAuthOwnership, HostBridgePlan, HostBridgeProtocol};
use bp_memory::{ExplainedMemoryItem, MemoryItem, MemoryLink};
use bp_pack_inspection::{
    selection_reason_for_report, DetectionSource, LoadedPackInspection, PackInspectionReport,
};
use bp_runtime::{ExecutionRoute, RuntimeSelection};
use std::fmt::Write as _;

pub fn render_selection(selection: &RuntimeSelection) -> String {
    format!(
        "route: {}\nreason: {}",
        format_route(&selection.route),
        selection.reason()
    )
}

pub fn render_memory_item(item: &MemoryItem) -> String {
    let mut output = String::new();
    writeln!(output, "ID: {}", item.id).expect("write id");
    writeln!(output, "Title: {}", item.title).expect("write title");
    writeln!(output, "Scope: {}:{}", item.scope, item.scope_key).expect("write scope");
    writeln!(output, "Kind: {}", item.kind).expect("write kind");
    writeln!(output, "Status: {}", item.status).expect("write status");
    writeln!(output, "Source: {}", item.source_type).expect("write source");
    if let Some(origin_pack) = &item.origin_pack {
        writeln!(output, "Origin pack: {origin_pack}").expect("write origin pack");
    }
    if let Some(promoted_from_id) = &item.promoted_from_id {
        writeln!(output, "Promoted from: {promoted_from_id}").expect("write promoted from");
    }
    writeln!(output).expect("blank line");
    writeln!(output, "Body:").expect("write body heading");
    writeln!(output, "{}", item.body).expect("write body");
    output.trim_end().to_string()
}

pub fn render_memory_list(items: &[MemoryItem]) -> String {
    if items.is_empty() {
        return "No memory items found.".to_string();
    }
    let mut output = String::new();
    writeln!(output, "Memory items: {}", items.len()).expect("write count");
    for item in items {
        writeln!(
            output,
            "- {} [{}:{}] {} ({})",
            item.id, item.scope, item.scope_key, item.title, item.status
        )
        .expect("write list row");
    }
    output.trim_end().to_string()
}

pub fn render_memory_explanations(items: &[ExplainedMemoryItem]) -> String {
    if items.is_empty() {
        return "Memory explanation: 0 items".to_string();
    }
    let mut output = String::new();
    writeln!(output, "Memory explanation: {} items", items.len()).expect("write count");
    for entry in items {
        writeln!(
            output,
            "- {} [{}:{}]",
            entry.item.title, entry.item.scope, entry.item.scope_key
        )
        .expect("write explanation row");
        writeln!(output, "  because: {}", entry.reason).expect("write explanation reason");
    }
    output.trim_end().to_string()
}

pub fn render_memory_links(links: &[MemoryLink]) -> String {
    if links.is_empty() {
        return "No links found.".to_string();
    }
    let mut output = String::new();
    writeln!(output, "Links: {}", links.len()).expect("write count");
    for link in links {
        writeln!(
            output,
            "- {} {} -> {} ({})",
            link.id, link.from_memory_id, link.to_memory_id, link.relation
        )
        .expect("write link row");
    }
    output.trim_end().to_string()
}

pub fn render_links_section(links: &[MemoryLink]) -> String {
    if links.is_empty() {
        return String::new();
    }
    let mut output = String::new();
    writeln!(output).expect("blank line");
    writeln!(output, "Links:").expect("write links heading");
    for link in links {
        writeln!(
            output,
            "  {} -> {} ({})",
            link.from_memory_id, link.to_memory_id, link.relation
        )
        .expect("write link row");
    }
    output.trim_end().to_string()
}

pub fn render_pack_inspection(inspection: &LoadedPackInspection) -> String {
    let loaded = &inspection.loaded;
    let report = &inspection.report;
    let mut output = String::new();

    writeln!(output, "Buildplane native host-aware pack inspection").expect("write heading");
    writeln!(
        output,
        "pack: {} ({})",
        loaded.manifest.pack.id, loaded.manifest.pack.display_name
    )
    .expect("write pack metadata");
    writeln!(output, "version: {}", loaded.manifest.pack.version).expect("write version");
    writeln!(output, "pack root: {}", loaded.pack_root.display()).expect("write pack root");
    writeln!(output, "manifest: {}", loaded.manifest_path.display()).expect("write manifest");
    writeln!(
        output,
        "workspace root: {}",
        report.workspace_root.display()
    )
    .expect("write workspace root");
    match &loaded.manifest.pack.default_provider {
        Some(provider) => writeln!(output, "default provider: {provider}"),
        None => writeln!(output, "default provider: none"),
    }
    .expect("write default provider");
    match loaded.manifest.default_mode() {
        Some(mode) => writeln!(output, "default mode: {} ({})", mode.id, mode.display_name),
        None => writeln!(output, "default mode: none"),
    }
    .expect("write default mode");

    if loaded.manifest.commands.is_empty() {
        writeln!(output, "commands: none").expect("write empty commands");
    } else {
        writeln!(output, "commands:").expect("write commands header");
        for command in &loaded.manifest.commands {
            writeln!(
                output,
                "  - {} -> {} ({})",
                command.name, command.mode, command.description
            )
            .expect("write command row");
        }
    }

    if loaded.manifest.host_preferences.is_empty() {
        writeln!(output, "host preferences: none").expect("write empty host preferences");
    } else {
        writeln!(output, "host preferences:").expect("write host preferences header");
        for preference in loaded.manifest.ordered_host_preferences() {
            writeln!(
                output,
                "  - {} priority={} transport={:?}",
                preference.host, preference.priority, preference.transport
            )
            .expect("write host preference row");
        }
    }

    if report.host_rows.is_empty() {
        writeln!(output, "host status: none").expect("write empty host status");
    } else {
        writeln!(output, "host status:").expect("write host status header");
        for row in &report.host_rows {
            write!(
                output,
                "  - {}: detected={} auth={} display_name={}",
                row.host,
                row.status.detected,
                format_auth_state(&row.status.auth),
                row.display_name
            )
            .expect("write host status row");
            if let Some(detail) = &row.status.detail {
                write!(output, " detail={detail}").expect("write host detail");
            }
            writeln!(output).expect("finish host status row");
        }
    }

    if report.effective_detected_hosts.is_empty() {
        writeln!(output, "effective detected hosts: none").expect("write empty detected hosts");
    } else {
        writeln!(
            output,
            "effective detected hosts: {}",
            report.effective_detected_hosts.join(", ")
        )
        .expect("write detected hosts");
    }

    if matches!(report.detection_source, DetectionSource::CliOverride) {
        writeln!(output, "detection source: cli override (--detected-host)")
            .expect("write detection source");
    }

    writeln!(
        output,
        "selected route: {}",
        format_route(&report.selection.route)
    )
    .expect("write selected route");
    writeln!(
        output,
        "selection reason: {}",
        selection_reason_for_display(report)
    )
    .expect("write selection reason");

    if let Some(plan) = &report.bridge_plan {
        render_bridge_plan(&mut output, plan);
    } else {
        writeln!(
            output,
            "bridge plan: none (selected route does not use a detected host bridge)"
        )
        .expect("write empty bridge plan");
    }

    output.trim_end().to_string()
}

fn selection_reason_for_display(report: &PackInspectionReport) -> String {
    selection_reason_for_report(report)
}

fn render_bridge_plan(output: &mut String, plan: &HostBridgePlan) {
    writeln!(output, "bridge plan:").expect("write bridge plan header");
    writeln!(output, "  - host: {}", plan.descriptor.host).expect("write bridge host");
    writeln!(output, "  - display name: {}", plan.descriptor.display_name)
        .expect("write bridge display name");
    writeln!(
        output,
        "  - entrypoint: {}",
        plan.descriptor.entrypoint_hint.as_deref().unwrap_or("none")
    )
    .expect("write bridge entrypoint");
    writeln!(
        output,
        "  - protocol: {}",
        format_bridge_protocol(&plan.descriptor.protocol)
    )
    .expect("write bridge protocol");
    writeln!(
        output,
        "  - auth ownership: {}",
        format_bridge_auth_ownership(&plan.descriptor.auth_ownership)
    )
    .expect("write bridge auth ownership");
    writeln!(output, "  - working dir: {}", plan.working_dir.display())
        .expect("write bridge working dir");
    writeln!(
        output,
        "  - mode hint: {}",
        plan.mode_hint.as_deref().unwrap_or("none")
    )
    .expect("write bridge mode hint");

    if plan.activation_env.is_empty() {
        writeln!(output, "  - activation env: none").expect("write empty activation env");
    } else {
        let activation_env = plan
            .activation_env
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join(", ");
        writeln!(output, "  - activation env: {activation_env}").expect("write activation env");
    }

    for note in &plan.notes {
        writeln!(output, "  - note: {note}").expect("write bridge note");
    }
}

fn format_route(route: &ExecutionRoute) -> String {
    match route {
        ExecutionRoute::Host(host) => format!("host:{host}"),
        ExecutionRoute::Provider(provider) => format!("provider:{provider}"),
        ExecutionRoute::Standalone => "standalone".to_string(),
    }
}

fn format_auth_state(auth: &AuthState) -> &'static str {
    match auth {
        AuthState::Available => "available",
        AuthState::RequiresLogin => "requires-login",
        AuthState::Unsupported => "unsupported",
    }
}

fn format_bridge_protocol(protocol: &HostBridgeProtocol) -> &'static str {
    match protocol {
        HostBridgeProtocol::BrokeredCli => "brokered-cli",
        HostBridgeProtocol::StructuredStdIo => "structured-stdio",
    }
}

fn format_bridge_auth_ownership(auth_ownership: &HostBridgeAuthOwnership) -> &'static str {
    match auth_ownership {
        HostBridgeAuthOwnership::HostManaged => "host-managed",
        HostBridgeAuthOwnership::BuildplaneManaged => "buildplane-managed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bp_pack_inspection::{inspect_pack, InspectPackRequest};
    use futures::executor::block_on;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

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

    fn render_for_test(
        pack_id: &str,
        env_entries: &[(&str, &str)],
        overrides: InspectOverrides,
    ) -> String {
        let request = inspect_request_for_test(pack_id, env_entries, overrides);
        let inspection = block_on(inspect_pack(&request)).expect("inspection should succeed");
        render_pack_inspection(&inspection)
    }

    #[test]
    fn renders_detected_host_bridge_details_for_superclaude() {
        let rendered = render_for_test(
            "superclaude",
            &[("CLAUDE_CODE", "1")],
            InspectOverrides::default(),
        );

        assert!(rendered.contains("pack: superclaude (SuperClaude)"));
        assert!(rendered.contains("workspace root: /tmp/buildplane-test-workspace"));
        assert!(rendered.contains("claude: detected=true auth=available"));
        assert!(rendered.contains("selected route: host:claude"));
        assert!(rendered
            .contains("selection reason: detected preferred host 'claude' from pack manifest"));
        assert!(rendered.contains("bridge plan:"));
        assert!(rendered.contains("auth ownership: host-managed"));
    }

    #[test]
    fn renders_cli_detected_host_override_reason_and_codex_bridge() {
        let rendered = render_for_test(
            "superclaude",
            &[("OPENAI_CODEX", "1")],
            InspectOverrides {
                detected_hosts: vec!["codex".to_string()],
                ..InspectOverrides::default()
            },
        );

        assert!(rendered.contains("detection source: cli override (--detected-host)"));
        assert!(rendered.contains("effective detected hosts: codex"));
        assert!(rendered.contains("selected route: host:codex"));
        assert!(rendered.contains(
            "selection reason: matched preferred host 'codex' from pack manifest using cli override (--detected-host)"
        ));
        assert!(rendered.contains("protocol: brokered-cli"));
    }

    #[test]
    fn renders_provider_selection_without_bridge_plan() {
        let rendered = render_for_test(
            "superclaude",
            &[("CLAUDE_CODE", "1")],
            InspectOverrides {
                explicit_provider: Some("openai".to_string()),
                ..InspectOverrides::default()
            },
        );

        assert!(rendered.contains("selected route: provider:openai"));
        assert!(rendered.contains("selection reason: explicit provider requested"));
        assert!(rendered
            .contains("bridge plan: none (selected route does not use a detected host bridge)"));
    }

    #[test]
    fn renders_memory_explanations_with_reasons() {
        let rendered = render_memory_explanations(&[
            ExplainedMemoryItem {
                item: bp_memory::MemoryItem {
                    id: "mem_1".to_string(),
                    scope: bp_memory::MemoryScope::User,
                    scope_key: "global".to_string(),
                    kind: bp_memory::MemoryKind::Preference,
                    title: "prefers concise output".to_string(),
                    body: "Keep answers concise".to_string(),
                    tags: vec!["style".to_string()],
                    applicable_packs: Vec::new(),
                    source_type: bp_memory::MemorySourceType::User,
                    source_ref: None,
                    origin_pack: None,
                    status: bp_memory::MemoryStatus::Active,
                    promoted_from_id: None,
                    created_at: "1".to_string(),
                    updated_at: "1".to_string(),
                },
                reason: "user scope is shared for all packs".to_string(),
            },
            ExplainedMemoryItem {
                item: bp_memory::MemoryItem {
                    id: "mem_2".to_string(),
                    scope: bp_memory::MemoryScope::Workspace,
                    scope_key: "/tmp/buildplane".to_string(),
                    kind: bp_memory::MemoryKind::Fact,
                    title: "repo uses pnpm".to_string(),
                    body: "Use pnpm from the repo root".to_string(),
                    tags: vec!["workspace".to_string()],
                    applicable_packs: Vec::new(),
                    source_type: bp_memory::MemorySourceType::User,
                    source_ref: None,
                    origin_pack: None,
                    status: bp_memory::MemoryStatus::Active,
                    promoted_from_id: None,
                    created_at: "1".to_string(),
                    updated_at: "1".to_string(),
                },
                reason: "workspace scope matched active workspace".to_string(),
            },
        ]);

        assert!(rendered.contains("Memory explanation: 2 items"));
        assert!(rendered.contains("prefers concise output"));
        assert!(rendered.contains("because: user scope is shared for all packs"));
        assert!(rendered.contains("repo uses pnpm"));
    }

    #[test]
    fn renders_memory_links_list_and_section() {
        use bp_memory::MemoryLinkRelation;

        let links = vec![
            MemoryLink {
                id: "lnk_1".to_string(),
                from_memory_id: "mem_a".to_string(),
                to_memory_id: "mem_b".to_string(),
                relation: MemoryLinkRelation::Supports,
                created_at: "1".to_string(),
            },
            MemoryLink {
                id: "lnk_2".to_string(),
                from_memory_id: "mem_c".to_string(),
                to_memory_id: "mem_a".to_string(),
                relation: MemoryLinkRelation::DerivedFrom,
                created_at: "1".to_string(),
            },
        ];

        let list = render_memory_links(&links);
        assert!(list.contains("Links: 2"));
        assert!(list.contains("lnk_1 mem_a -> mem_b (supports)"));
        assert!(list.contains("lnk_2 mem_c -> mem_a (derived-from)"));

        let section = render_links_section(&links);
        assert!(section.contains("Links:"));
        assert!(section.contains("mem_a -> mem_b (supports)"));

        let empty_list = render_memory_links(&[]);
        assert_eq!(empty_list, "No links found.");

        let empty_section = render_links_section(&[]);
        assert!(empty_section.is_empty());
    }
}
