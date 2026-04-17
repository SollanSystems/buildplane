mod ledger_cli;
mod memory_cli;

#[cfg(test)]
use bp_memory::{MemoryKind, MemoryScope};
use bp_pack_inspection::{
    collect_process_env, inspect_pack, pack_inspection_json, InspectPackRequest,
    LoadedPackInspection,
};
use bp_ui_terminal::render_pack_inspection;
use futures::executor::block_on;
use memory_cli::{memory_usage_text, parse_memory_command, run_memory_command, MemoryCommand};
#[cfg(test)]
use memory_cli::{InspectMemoryArgs, PromoteMemoryArgs, RememberMemoryArgs};
use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Command {
    InspectPack(InspectPackArgs),
    Ledger(ledger_cli::LedgerCommand),
    Memory(MemoryCommand),
    Help,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InspectPackArgs {
    pack_id: String,
    native_root: PathBuf,
    workspace_root: PathBuf,
    explicit_host: Option<String>,
    explicit_provider: Option<String>,
    detected_hosts: Vec<String>,
    json: bool,
}

impl InspectPackArgs {
    fn into_request(
        self,
        process_env: std::collections::BTreeMap<String, String>,
    ) -> InspectPackRequest {
        InspectPackRequest {
            pack_id: self.pack_id,
            native_root: self.native_root,
            workspace_root: self.workspace_root,
            explicit_host: self.explicit_host,
            explicit_provider: self.explicit_provider,
            detected_hosts: self.detected_hosts,
            process_env,
        }
    }
}

fn main() {
    if let Err(message) = run() {
        eprintln!("error: {message}");
        eprintln!();
        eprintln!("{}", usage_text());
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    match parse_args_from_iter(env::args_os().skip(1))? {
        Command::InspectPack(args) => run_inspect_pack(args),
        Command::Ledger(ledger_cli::LedgerCommand::Serve(serve_args)) => {
            ledger_cli::run_serve(serve_args)
        }
        Command::Ledger(ledger_cli::LedgerCommand::Help) => {
            println!("{}", ledger_cli::usage_text());
            Ok(())
        }
        Command::Memory(command) => run_memory_command(command),
        Command::Help => {
            println!("{}", usage_text());
            Ok(())
        }
    }
}

fn run_inspect_pack(args: InspectPackArgs) -> Result<(), String> {
    let json = args.json;
    let request = args.into_request(collect_process_env());
    let inspection = block_on(inspect_pack(&request))?;
    println!("{}", render_pack_inspection_output(&inspection, json)?);
    Ok(())
}

fn render_pack_inspection_output(
    inspection: &LoadedPackInspection,
    json: bool,
) -> Result<String, String> {
    if json {
        serde_json::to_string_pretty(&pack_inspection_json(inspection))
            .map_err(|err| format!("failed to serialize pack inspection as json: {err}"))
    } else {
        Ok(render_pack_inspection(inspection))
    }
}

fn parse_args_from_iter<I, T>(iter: I) -> Result<Command, String>
where
    I: IntoIterator<Item = T>,
    T: Into<OsString>,
{
    let default_workspace_root = default_workspace_root()?;
    let default_native_root =
        default_native_root_from(&default_workspace_root).ok_or_else(|| {
            format!(
                "could not resolve the native workspace from {}; pass --native-root explicitly",
                default_workspace_root.display()
            )
        })?;
    parse_args_with_defaults(iter, default_native_root, default_workspace_root)
}

#[cfg(test)]
fn parse_args_with_default_native_root<I, T>(
    iter: I,
    default_native_root: PathBuf,
) -> Result<Command, String>
where
    I: IntoIterator<Item = T>,
    T: Into<OsString>,
{
    let default_workspace_root = default_native_root
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| default_native_root.clone());
    parse_args_with_defaults(iter, default_native_root, default_workspace_root)
}

fn parse_args_with_defaults<I, T>(
    iter: I,
    default_native_root: PathBuf,
    default_workspace_root: PathBuf,
) -> Result<Command, String>
where
    I: IntoIterator<Item = T>,
    T: Into<OsString>,
{
    let mut args = iter
        .into_iter()
        .map(Into::into)
        .collect::<Vec<_>>()
        .into_iter();

    let Some(first) = args.next() else {
        return Ok(Command::Help);
    };
    let first = parse_string(first, "subcommand")?;
    if is_help_flag(&first) {
        return Ok(Command::Help);
    }
    if first == "ledger" {
        let rest: Vec<String> = args
            .map(|a| {
                a.into_string()
                    .map_err(|_| "ledger argument must be valid UTF-8".to_string())
            })
            .collect::<Result<_, _>>()?;
        return ledger_cli::parse_ledger_command(&rest).map(Command::Ledger);
    }
    if first == "memory" {
        return parse_memory_command(args, default_workspace_root).map(Command::Memory);
    }
    if first != "pack" {
        return Err(format!("unknown subcommand '{first}'"));
    }

    let action = args
        .next()
        .ok_or_else(|| "missing pack action; expected `show`".to_string())?;
    let action = parse_string(action, "pack action")?;
    if action != "show" {
        return Err(format!("unknown pack action '{action}'"));
    }

    let pack_id = args.next().ok_or_else(|| {
        "missing pack id; expected `buildplane-native pack show <pack-id>`".to_string()
    })?;
    let pack_id = parse_string(pack_id, "pack id")?;

    let mut native_root = default_native_root;
    let mut workspace_root = default_workspace_root;
    let mut explicit_host = None;
    let mut explicit_provider = None;
    let mut detected_hosts = Vec::new();
    let mut json = false;

    while let Some(flag) = args.next() {
        let flag = parse_string(flag, "flag")?;
        match flag.as_str() {
            "--native-root" => {
                native_root = PathBuf::from(next_value(&mut args, "--native-root")?);
            }
            "--workspace-root" => {
                workspace_root = PathBuf::from(next_value(&mut args, "--workspace-root")?);
            }
            "--host" => {
                explicit_host = Some(parse_string(next_value(&mut args, "--host")?, "host")?);
            }
            "--provider" => {
                explicit_provider = Some(parse_string(
                    next_value(&mut args, "--provider")?,
                    "provider",
                )?);
            }
            "--detected-host" => {
                detected_hosts.push(parse_string(
                    next_value(&mut args, "--detected-host")?,
                    "detected host",
                )?);
            }
            "--json" => json = true,
            "--help" | "-h" => return Ok(Command::Help),
            other => return Err(format!("unknown flag '{other}'")),
        }
    }

    Ok(Command::InspectPack(InspectPackArgs {
        pack_id,
        native_root,
        workspace_root,
        explicit_host,
        explicit_provider,
        detected_hosts,
        json,
    }))
}

fn parse_string(value: OsString, label: &str) -> Result<String, String> {
    value
        .into_string()
        .map_err(|_| format!("{label} must be valid UTF-8"))
}

fn next_value(args: &mut std::vec::IntoIter<OsString>, flag: &str) -> Result<OsString, String> {
    args.next()
        .ok_or_else(|| format!("missing value for {flag}"))
}

fn default_workspace_root() -> Result<PathBuf, String> {
    env::current_dir().map_err(|err| format!("failed to inspect current directory: {err}"))
}

fn default_native_root_from(current_dir: &Path) -> Option<PathBuf> {
    let nested_native = current_dir.join("native");
    if nested_native.join("Cargo.toml").is_file() && nested_native.join("packs").is_dir() {
        return Some(nested_native);
    }

    if current_dir.join("Cargo.toml").is_file() && current_dir.join("packs").is_dir() {
        return Some(current_dir.to_path_buf());
    }

    None
}

fn is_help_flag(value: &str) -> bool {
    matches!(value, "--help" | "-h" | "help")
}

fn usage_text() -> String {
    format!(
        "Usage:
  buildplane-native pack show <pack-id> [--native-root <path>] [--workspace-root <path>] [--host <id>] [--provider <id>] [--detected-host <id>]... [--json]
  buildplane-native memory <action> [options]
  buildplane-native ledger <subcommand> [options]

Examples:
  cargo run --manifest-path native/Cargo.toml -p bp-cli -- pack show superclaude
  CLAUDE_CODE=1 cargo run --manifest-path native/Cargo.toml -p bp-cli -- pack show superclaude
  cargo run --manifest-path native/Cargo.toml -p bp-cli -- pack show superclaude --detected-host codex --workspace-root /tmp/buildplane-test-workspace
  cargo run --manifest-path native/Cargo.toml -p bp-cli -- pack show superclaude --json
  cargo run --manifest-path native/Cargo.toml -p bp-cli -- memory remember \"User prefers concise output\" --scope user --kind preference
  cargo run --manifest-path native/Cargo.toml -p bp-cli -- ledger serve --run-id <id> --workspace <path>

{}
{}",
        memory_usage_text(),
        ledger_cli::usage_text()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use bp_pack_inspection::inspect_pack;
    use std::collections::BTreeMap;

    fn native_root_for_tests() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    fn env_map_for_test(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
        entries
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    fn inspect_args_for_test(pack_id: &str) -> InspectPackArgs {
        InspectPackArgs {
            pack_id: pack_id.to_string(),
            native_root: native_root_for_tests(),
            workspace_root: PathBuf::from("/tmp/buildplane-test-workspace"),
            explicit_host: None,
            explicit_provider: None,
            detected_hosts: Vec::new(),
            json: false,
        }
    }

    #[test]
    fn returns_help_when_no_args_are_provided() {
        let command = parse_args_with_default_native_root(
            Vec::<&str>::new(),
            PathBuf::from("/tmp/buildplane/native"),
        )
        .expect("help should parse");

        assert_eq!(command, Command::Help);
    }

    #[test]
    fn parses_pack_show_with_all_overrides() {
        let native_root = PathBuf::from("/tmp/buildplane/native");
        let command = parse_args_with_default_native_root(
            vec![
                "pack",
                "show",
                "superclaude",
                "--host",
                "claude",
                "--provider",
                "anthropic",
                "--detected-host",
                "codex",
                "--detected-host",
                "claude",
            ],
            native_root.clone(),
        )
        .expect("command should parse");

        assert_eq!(
            command,
            Command::InspectPack(InspectPackArgs {
                pack_id: "superclaude".to_string(),
                native_root,
                workspace_root: PathBuf::from("/tmp/buildplane"),
                explicit_host: Some("claude".to_string()),
                explicit_provider: Some("anthropic".to_string()),
                detected_hosts: vec!["codex".to_string(), "claude".to_string()],
                json: false,
            })
        );
    }

    #[test]
    fn parses_pack_show_with_workspace_root() {
        let native_root = PathBuf::from("/tmp/buildplane/native");
        let command = parse_args_with_default_native_root(
            vec![
                "pack",
                "show",
                "superclaude",
                "--workspace-root",
                "/tmp/workspace",
                "--host",
                "claude",
            ],
            native_root.clone(),
        )
        .expect("command should parse");

        assert_eq!(
            command,
            Command::InspectPack(InspectPackArgs {
                pack_id: "superclaude".to_string(),
                native_root,
                workspace_root: PathBuf::from("/tmp/workspace"),
                explicit_host: Some("claude".to_string()),
                explicit_provider: None,
                detected_hosts: Vec::new(),
                json: false,
            })
        );
    }

    #[test]
    fn parses_pack_show_with_json() {
        let native_root = PathBuf::from("/tmp/buildplane/native");
        let command = parse_args_with_default_native_root(
            vec!["pack", "show", "superclaude", "--json"],
            native_root.clone(),
        )
        .expect("command should parse");

        assert_eq!(
            command,
            Command::InspectPack(InspectPackArgs {
                pack_id: "superclaude".to_string(),
                native_root,
                workspace_root: PathBuf::from("/tmp/buildplane"),
                explicit_host: None,
                explicit_provider: None,
                detected_hosts: Vec::new(),
                json: true,
            })
        );
    }

    #[test]
    fn rejects_unknown_flag() {
        let err = parse_args_with_default_native_root(
            vec!["pack", "show", "superclaude", "--bogus"],
            PathBuf::from("/tmp/buildplane/native"),
        )
        .expect_err("unknown flags should fail");

        assert!(err.contains("--bogus"));
    }

    #[test]
    fn inspect_pack_args_convert_into_shared_request() {
        let args = InspectPackArgs {
            pack_id: "superclaude".to_string(),
            native_root: PathBuf::from("/tmp/buildplane/native"),
            workspace_root: PathBuf::from("/tmp/workspace"),
            explicit_host: Some("claude".to_string()),
            explicit_provider: Some("anthropic".to_string()),
            detected_hosts: vec!["claude".to_string()],
            json: false,
        };

        let request = args.into_request(env_map_for_test(&[("CLAUDE_CODE", "1")]));

        assert_eq!(request.pack_id, "superclaude");
        assert_eq!(request.native_root, PathBuf::from("/tmp/buildplane/native"));
        assert_eq!(request.workspace_root, PathBuf::from("/tmp/workspace"));
        assert_eq!(request.explicit_host, Some("claude".to_string()));
        assert_eq!(request.explicit_provider, Some("anthropic".to_string()));
        assert_eq!(request.detected_hosts, vec!["claude".to_string()]);
        assert_eq!(
            request.process_env.get("CLAUDE_CODE"),
            Some(&"1".to_string())
        );
    }

    #[test]
    fn cli_smoke_test_uses_shared_inspection_and_terminal_rendering_layers() {
        let request = inspect_args_for_test("superclaude")
            .into_request(env_map_for_test(&[("CLAUDE_CODE", "1")]));
        let inspection = block_on(inspect_pack(&request)).expect("inspection should succeed");
        let rendered = render_pack_inspection(&inspection);

        assert!(rendered.contains("Buildplane native host-aware pack inspection"));
        assert!(rendered.contains("selected route: host:claude"));
        assert!(rendered.contains("bridge plan:"));
    }

    #[test]
    fn cli_smoke_test_can_render_shared_inspection_as_json() {
        let request = inspect_args_for_test("superclaude")
            .into_request(env_map_for_test(&[("CLAUDE_CODE", "1")]));
        let inspection = block_on(inspect_pack(&request)).expect("inspection should succeed");
        let rendered =
            render_pack_inspection_output(&inspection, true).expect("json rendering should work");
        let payload: serde_json::Value =
            serde_json::from_str(&rendered).expect("pack inspection json should parse");

        assert_eq!(payload["pack"]["id"], "superclaude");
        assert_eq!(payload["detectionSource"], "environment");
        assert_eq!(
            payload["selectionReason"],
            "detected preferred host 'claude' from pack manifest"
        );
        assert_eq!(payload["selection"]["route"]["route"], "host");
        assert_eq!(payload["selection"]["route"]["value"], "claude");
        assert!(payload["bridgePlan"].is_object());
    }

    #[test]
    fn parses_memory_remember_command_with_workspace_defaults() {
        let command = parse_args_with_default_native_root(
            vec![
                "memory",
                "remember",
                "User prefers concise output",
                "--scope",
                "user",
                "--kind",
                "preference",
                "--json",
            ],
            PathBuf::from("/tmp/buildplane/native"),
        )
        .expect("memory command should parse");

        assert_eq!(
            command,
            Command::Memory(MemoryCommand::Remember(RememberMemoryArgs {
                workspace_root: PathBuf::from("/tmp/buildplane"),
                body: "User prefers concise output".to_string(),
                scope: MemoryScope::User,
                kind: MemoryKind::Preference,
                title: None,
                pack_id: None,
                session_id: None,
                json: true,
            }))
        );
    }

    #[test]
    fn parses_memory_inspect_effective_for_pack_scope() {
        let command = parse_args_with_default_native_root(
            vec![
                "memory",
                "inspect",
                "--effective",
                "--pack",
                "superclaude",
                "--workspace-root",
                "/tmp/workspace",
            ],
            PathBuf::from("/tmp/buildplane/native"),
        )
        .expect("effective inspect should parse");

        assert_eq!(
            command,
            Command::Memory(MemoryCommand::Inspect(InspectMemoryArgs {
                native_root: PathBuf::from("/tmp/workspace"),
                workspace_root: PathBuf::from("/tmp/workspace"),
                id: None,
                scope: None,
                pack_id: Some("superclaude".to_string()),
                session_id: None,
                effective: true,
                include_forgotten: false,
                json: false,
            }))
        );
    }

    #[test]
    fn parses_memory_promote_into_user_scope() {
        let command = parse_args_with_default_native_root(
            vec![
                "memory",
                "promote",
                "mem_123",
                "--to",
                "user",
                "--reason",
                "validated across packs",
            ],
            PathBuf::from("/tmp/buildplane/native"),
        )
        .expect("promote should parse");

        assert_eq!(
            command,
            Command::Memory(MemoryCommand::Promote(PromoteMemoryArgs {
                workspace_root: PathBuf::from("/tmp/buildplane"),
                id: "mem_123".to_string(),
                to_scope: MemoryScope::User,
                pack_id: None,
                session_id: None,
                reason: Some("validated across packs".to_string()),
                json: false,
            }))
        );
    }
}
