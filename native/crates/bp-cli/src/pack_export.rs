use bp_pack_loader::{load_pack_from_native_root, LoadedPack};
use serde::Serialize;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PackExportTarget {
    GithubAgent,
    GithubSkill,
}

impl PackExportTarget {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "github-agent" => Ok(Self::GithubAgent),
            "github-skill" => Ok(Self::GithubSkill),
            other => Err(format!(
                "unsupported pack export target '{other}'; expected github-agent or github-skill"
            )),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::GithubAgent => "github-agent",
            Self::GithubSkill => "github-skill",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackExportArgs {
    pub pack_id: String,
    pub native_root: PathBuf,
    pub target: PackExportTarget,
    pub out: PathBuf,
    pub json: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PackExportReceipt {
    pub kind: &'static str,
    pub pack_id: String,
    pub target: PackExportTarget,
    pub output_path: PathBuf,
    pub files: Vec<PackExportedFile>,
    pub source: PackExportSource,
    pub authority: PackExportAuthority,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PackExportedFile {
    pub path: PathBuf,
    pub role: &'static str,
    pub bytes: usize,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PackExportSource {
    pub pack_root: PathBuf,
    pub manifest_path: PathBuf,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PackExportAuthority {
    pub provider_auth: bool,
    pub execution_authority: bool,
    pub mcp_servers: bool,
    pub hooks: bool,
}

pub fn export_pack(args: PackExportArgs) -> Result<PackExportReceipt, String> {
    let loaded = load_pack_from_native_root(&args.native_root, &args.pack_id)
        .map_err(|err| err.to_string())?;
    let output_path = output_path_for_target(args.target, &args.out, &args.pack_id)?;
    let content = render_export(&loaded, args.target);
    write_export_file(&output_path, &content)?;

    Ok(PackExportReceipt {
        kind: "pack-export",
        pack_id: loaded.manifest.pack.id.clone(),
        target: args.target,
        output_path: output_path.clone(),
        files: vec![PackExportedFile {
            path: output_path,
            role: match args.target {
                PackExportTarget::GithubAgent => "github-agent-profile",
                PackExportTarget::GithubSkill => "github-skill",
            },
            bytes: content.len(),
        }],
        source: PackExportSource {
            pack_root: loaded.pack_root,
            manifest_path: loaded.manifest_path,
        },
        authority: PackExportAuthority {
            provider_auth: false,
            execution_authority: false,
            mcp_servers: false,
            hooks: false,
        },
    })
}

pub fn render_human_receipt(receipt: &PackExportReceipt) -> String {
    let mut output = String::new();
    output.push_str(&format!(
        "Exported pack '{}' as {}.\n",
        receipt.pack_id,
        receipt.target.label()
    ));
    for file in &receipt.files {
        output.push_str(&format!("  - {} ({})\n", file.path.display(), file.role));
    }
    output.push_str(
        "Authority: workflow/personality only; no provider auth, execution authority, MCP servers, or hooks granted.",
    );
    output
}

fn render_export(loaded: &LoadedPack, target: PackExportTarget) -> String {
    match target {
        PackExportTarget::GithubAgent => render_github_agent_profile(loaded),
        PackExportTarget::GithubSkill => render_github_skill(loaded),
    }
}

fn render_github_agent_profile(loaded: &LoadedPack) -> String {
    let manifest = &loaded.manifest;
    let description = agent_description(loaded);
    let mut output = String::new();
    output.push_str("---\n");
    output.push_str(&format!("name: {}\n", yaml_string(&manifest.pack.id)));
    output.push_str(&format!("description: {}\n", yaml_string(&description)));
    output.push_str("---\n\n");
    output.push_str(&render_instruction_body(loaded, "GitHub custom agent"));
    output
}

fn render_github_skill(loaded: &LoadedPack) -> String {
    let manifest = &loaded.manifest;
    let description = format!(
        "Use this skill when a task should follow the {} Buildplane workflow pack. It describes pack modes, commands, and routing metadata without granting provider auth or execution authority.",
        manifest.pack.display_name
    );
    let mut output = String::new();
    output.push_str("---\n");
    output.push_str(&format!("name: {}\n", yaml_string(&manifest.pack.id)));
    output.push_str(&format!("description: {}\n", yaml_string(&description)));
    output.push_str("---\n\n");
    output.push_str(&render_instruction_body(loaded, "GitHub skill"));
    output
}

fn render_instruction_body(loaded: &LoadedPack, export_kind: &str) -> String {
    let manifest = &loaded.manifest;
    let mut output = String::new();
    output.push_str(&format!(
        "# {} Buildplane Pack\n\n",
        manifest.pack.display_name
    ));
    output.push_str(&format!(
        "This {} was generated from Buildplane pack `{}` version `{}`.\n\n",
        export_kind, manifest.pack.id, manifest.pack.version
    ));
    if let Some(description) = &manifest.pack.description {
        output.push_str(&format!("Pack purpose: {}\n\n", description));
    }

    output.push_str("## Operating Boundaries\n\n");
    output.push_str("- Treat this file as workflow and personality guidance only.\n");
    output.push_str("- Do not infer provider credentials, GitHub write access, MCP servers, hooks, or execution authority from this export.\n");
    output.push_str("- Keep Buildplane packs, hosts, and providers separate: pack metadata can describe preferences, but the active host owns authentication and execution.\n");
    output.push_str("- Follow repository instructions, explicit user approvals, and host policy over this exported guidance.\n\n");

    output.push_str("## Pack Metadata\n\n");
    output.push_str(&format!("- Pack id: `{}`\n", manifest.pack.id));
    output.push_str(&format!("- Display name: {}\n", manifest.pack.display_name));
    match &manifest.pack.default_provider {
        Some(provider) => output.push_str(&format!(
            "- Default provider metadata: `{provider}` (routing metadata only)\n"
        )),
        None => output.push_str("- Default provider metadata: none\n"),
    }
    output.push_str(&format!(
        "- Memory policy metadata: user={}, workspace={}, pack={}\n\n",
        manifest.memory.share_user, manifest.memory.share_workspace, manifest.memory.share_pack
    ));

    output.push_str("## Modes\n\n");
    for mode in &manifest.modes {
        let default_marker = if mode.default { " (default)" } else { "" };
        output.push_str(&format!(
            "- `{}`{}: {}. Reasoning: `{}`. Autonomy: `{}`.\n",
            mode.id,
            default_marker,
            mode.display_name,
            serialized_label(&mode.reasoning),
            serialized_label(&mode.autonomy)
        ));
    }

    if !manifest.commands.is_empty() {
        output.push_str("\n## Commands\n\n");
        for command in &manifest.commands {
            output.push_str(&format!(
                "- `{}` -> mode `{}`: {}\n",
                command.name, command.mode, command.description
            ));
            if let Some(template) = &command.template {
                output.push_str(&format!("  Template: {}\n", template));
            }
        }
    }

    if !manifest.host_preferences.is_empty() {
        output.push_str("\n## Host Preferences\n\n");
        for preference in manifest.ordered_host_preferences() {
            output.push_str(&format!(
                "- `{}` via `{}` auth `{}` priority `{}` (metadata only; no authority granted)\n",
                preference.host,
                serialized_label(&preference.transport),
                serialized_label(&preference.auth),
                preference.priority
            ));
        }
    }

    output
}

fn agent_description(loaded: &LoadedPack) -> String {
    let pack = &loaded.manifest.pack;
    match &pack.description {
        Some(description) => format!(
            "Buildplane pack export for {}: {}",
            pack.display_name, description
        ),
        None => format!("Buildplane pack export for {}.", pack.display_name),
    }
}

fn serialized_label<T>(value: &T) -> String
where
    T: Serialize + std::fmt::Debug,
{
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| format!("{value:?}"))
}

fn yaml_string(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r");
    format!("\"{escaped}\"")
}

fn output_path_for_target(
    target: PackExportTarget,
    out: &Path,
    pack_id: &str,
) -> Result<PathBuf, String> {
    let out = absolutize(out)?;
    let path = match target {
        PackExportTarget::GithubAgent => {
            if out.extension().is_some_and(|extension| extension == "md") {
                out
            } else {
                out.join(format!("{pack_id}.md"))
            }
        }
        PackExportTarget::GithubSkill => {
            if out.file_name().is_some_and(|name| name == "SKILL.md") {
                out
            } else if out.file_name().is_some_and(|name| name == pack_id) {
                out.join("SKILL.md")
            } else {
                out.join(pack_id).join("SKILL.md")
            }
        }
    };
    Ok(path)
}

fn absolutize(path: &Path) -> Result<PathBuf, String> {
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }

    env::current_dir()
        .map(|cwd| cwd.join(path))
        .map_err(|err| format!("failed to inspect current directory: {err}"))
}

fn write_export_file(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|err| {
                format!(
                    "failed to create export directory {}: {err}",
                    parent.display()
                )
            })?;
        }
    }
    fs::write(path, content)
        .map_err(|err| format!("failed to write pack export {}: {err}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn native_root_for_tests() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    fn unique_temp_root(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should move forward")
            .as_nanos();
        env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()))
    }

    #[test]
    fn writes_github_agent_profile_from_pack_metadata() {
        let temp_root = unique_temp_root("bp-pack-export-agent");
        let receipt = export_pack(PackExportArgs {
            pack_id: "superclaude".to_string(),
            native_root: native_root_for_tests(),
            target: PackExportTarget::GithubAgent,
            out: temp_root.join(".github").join("agents"),
            json: true,
        })
        .expect("agent export should succeed");

        assert_eq!(
            receipt.output_path,
            temp_root
                .join(".github")
                .join("agents")
                .join("superclaude.md")
        );
        let content = fs::read_to_string(&receipt.output_path).expect("export should be readable");
        assert!(content.contains("name: \"superclaude\""));
        assert!(content.contains("description: \"Buildplane pack export for SuperClaude:"));
        assert!(content.contains("## Operating Boundaries"));
        assert!(content.contains("no authority granted"));
        assert!(content.contains("Provider-specific workflow pack"));
        assert_eq!(receipt.authority.provider_auth, false);
        assert_eq!(receipt.authority.execution_authority, false);

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn writes_github_skill_directory_with_skill_frontmatter() {
        let temp_root = unique_temp_root("bp-pack-export-skill");
        let receipt = export_pack(PackExportArgs {
            pack_id: "supercodex".to_string(),
            native_root: native_root_for_tests(),
            target: PackExportTarget::GithubSkill,
            out: temp_root.join(".github").join("skills"),
            json: true,
        })
        .expect("skill export should succeed");

        assert_eq!(
            receipt.output_path,
            temp_root
                .join(".github")
                .join("skills")
                .join("supercodex")
                .join("SKILL.md")
        );
        let content = fs::read_to_string(&receipt.output_path).expect("export should be readable");
        assert!(content.contains("name: \"supercodex\""));
        assert!(content.contains("Use this skill when a task should follow the SuperCodex"));
        assert!(content.contains("## Modes"));
        assert!(content.contains("## Commands"));
        assert!(content.contains("## Host Preferences"));

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn supports_exact_skill_md_output_path() {
        let temp_root = unique_temp_root("bp-pack-export-skill-exact");
        let skill_path = temp_root
            .join(".github")
            .join("skills")
            .join("superclaude")
            .join("SKILL.md");

        let receipt = export_pack(PackExportArgs {
            pack_id: "superclaude".to_string(),
            native_root: native_root_for_tests(),
            target: PackExportTarget::GithubSkill,
            out: skill_path.clone(),
            json: true,
        })
        .expect("exact skill export should succeed");

        assert_eq!(receipt.output_path, skill_path);
        assert!(receipt.output_path.is_file());

        let _ = fs::remove_dir_all(temp_root);
    }
}
