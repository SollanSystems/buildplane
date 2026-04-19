//! `buildplane-native ledger ...` subcommands.
//!
//! Phase A: `serve` is wired. Phase D adds `replay`.

use bp_ledger::serve::serve_with_protocol;
use bp_ledger::storage::sqlite::SqliteStore;
use bp_ledger::storage::Cas;
use bp_replay::engine::ReplayEngine;
use std::io::{self, Write};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LedgerCommand {
    Serve(ServeArgs),
    Replay(ReplayArgs),
    Help,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServeArgs {
    pub run_id: String,
    pub workspace: PathBuf,
    pub schema_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayArgs {
    pub run_id: String,
    pub workspace: PathBuf,
    pub format: ReplayFormat,
    pub limit: Option<usize>,
    pub at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayFormat {
    Json,
    Human,
}

/// Parse `ledger <subcommand> [args...]` into a LedgerCommand.
pub fn parse_ledger_command(args: &[String]) -> Result<LedgerCommand, String> {
    match args.first().map(String::as_str) {
        Some("serve") => parse_serve(&args[1..]).map(LedgerCommand::Serve),
        Some("replay") => parse_replay(&args[1..]).map(LedgerCommand::Replay),
        Some("--help" | "-h" | "help") | None => Ok(LedgerCommand::Help),
        Some(other) => Err(format!("unknown ledger subcommand: {other}")),
    }
}

fn parse_serve(args: &[String]) -> Result<ServeArgs, String> {
    let mut run_id: Option<String> = None;
    let mut workspace: Option<PathBuf> = None;
    let mut schema_version: u32 = 1;

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        match arg.as_str() {
            "--run-id" => {
                i += 1;
                run_id = Some(args.get(i).ok_or("--run-id requires a value")?.clone());
            }
            "--workspace" => {
                i += 1;
                workspace = Some(PathBuf::from(
                    args.get(i).ok_or("--workspace requires a value")?,
                ));
            }
            "--schema-version" => {
                i += 1;
                schema_version = args
                    .get(i)
                    .ok_or("--schema-version requires a value")?
                    .parse()
                    .map_err(|_| "--schema-version must be an integer")?;
            }
            "--help" | "-h" => {
                // Treat help flag inside serve as LedgerCommand::Help by
                // returning an Err and re-routing at call site is awkward;
                // instead just print usage and exit cleanly via Ok path by
                // returning a sentinel error the caller recognises.
                return Err("__help__".to_string());
            }
            other => return Err(format!("unknown flag: {other}")),
        }
        i += 1;
    }
    let workspace = workspace.ok_or("missing --workspace")?;
    if !workspace.is_absolute() {
        return Err(format!(
            "--workspace must be an absolute path; got: {}",
            workspace.display()
        ));
    }
    Ok(ServeArgs {
        run_id: run_id.ok_or("missing --run-id")?,
        workspace,
        schema_version,
    })
}

fn parse_replay(args: &[String]) -> Result<ReplayArgs, String> {
    let mut run_id: Option<String> = None;
    let mut workspace: Option<PathBuf> = None;
    let mut format = ReplayFormat::Json;
    let mut limit: Option<usize> = None;
    let mut at: Option<String> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--run-id" => {
                i += 1;
                run_id = Some(args.get(i).ok_or("--run-id requires a value")?.clone());
            }
            "--workspace" => {
                i += 1;
                workspace = Some(PathBuf::from(args.get(i).ok_or("--workspace requires a value")?));
            }
            "--format" => {
                i += 1;
                let v = args.get(i).ok_or("--format requires a value")?;
                format = match v.as_str() {
                    "json" => ReplayFormat::Json,
                    "human" => ReplayFormat::Human,
                    other => return Err(format!("unknown format: {other}")),
                };
            }
            "--limit" => {
                i += 1;
                limit = Some(
                    args.get(i)
                        .ok_or("--limit requires a value")?
                        .parse()
                        .map_err(|_| "--limit must be a non-negative integer")?,
                );
            }
            "--at" => {
                i += 1;
                at = Some(args.get(i).ok_or("--at requires a value")?.clone());
            }
            other => return Err(format!("unknown flag: {other}")),
        }
        i += 1;
    }
    Ok(ReplayArgs {
        run_id: run_id.ok_or("missing --run-id")?,
        workspace: workspace.ok_or("missing --workspace")?,
        format,
        limit,
        at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_serve_rejects_relative_workspace() {
        let args = vec![
            "--run-id".to_string(),
            "abc".to_string(),
            "--workspace".to_string(),
            "./relative/path".to_string(),
        ];
        let err = parse_serve(&args).unwrap_err();
        assert!(err.contains("absolute"), "expected 'absolute' in error: {err}");
    }

    #[test]
    fn parse_serve_accepts_absolute_workspace() {
        let args = vec![
            "--run-id".to_string(),
            "abc".to_string(),
            "--workspace".to_string(),
            "/tmp/abs".to_string(),
        ];
        let out = parse_serve(&args).unwrap();
        assert_eq!(out.workspace.to_str().unwrap(), "/tmp/abs");
        assert_eq!(out.run_id, "abc");
    }

    #[test]
    fn parse_replay_defaults_to_json_format() {
        let args = vec![
            "--run-id".to_string(),
            "abc".to_string(),
            "--workspace".to_string(),
            "/tmp/ws".to_string(),
        ];
        let out = parse_replay(&args).unwrap();
        assert_eq!(out.format, ReplayFormat::Json);
        assert!(out.limit.is_none());
        assert!(out.at.is_none());
    }

    #[test]
    fn parse_replay_accepts_human_format_with_limit() {
        let args = vec![
            "--run-id".to_string(),
            "run1".to_string(),
            "--workspace".to_string(),
            "/tmp/ws".to_string(),
            "--format".to_string(),
            "human".to_string(),
            "--limit".to_string(),
            "5".to_string(),
        ];
        let out = parse_replay(&args).unwrap();
        assert_eq!(out.format, ReplayFormat::Human);
        assert_eq!(out.limit, Some(5));
    }

    #[test]
    fn parse_replay_accepts_at_flag() {
        let args = vec![
            "--run-id".to_string(),
            "run1".to_string(),
            "--workspace".to_string(),
            "/tmp/ws".to_string(),
            "--at".to_string(),
            "01919000-0000-7000-8000-000000000001".to_string(),
        ];
        let out = parse_replay(&args).unwrap();
        assert_eq!(out.at.as_deref(), Some("01919000-0000-7000-8000-000000000001"));
    }

    #[test]
    fn parse_replay_rejects_unknown_format() {
        let args = vec![
            "--run-id".to_string(),
            "r".to_string(),
            "--workspace".to_string(),
            "/tmp/ws".to_string(),
            "--format".to_string(),
            "xml".to_string(),
        ];
        let err = parse_replay(&args).unwrap_err();
        assert!(err.contains("xml"), "expected format name in error: {err}");
    }
}

/// Execute the `ledger serve` command.
///
/// Resolves the ledger database path from the workspace, opens it, and runs
/// the protocol state machine against stdin.
pub fn run_serve(args: ServeArgs) -> Result<(), String> {
    if args.schema_version != 1 {
        return Err(format!(
            "schema version {} not supported in this build (supported: 1)",
            args.schema_version
        ));
    }
    let ledger_dir = args.workspace.join(".buildplane").join("ledger");
    std::fs::create_dir_all(&ledger_dir).map_err(|e| format!("creating ledger dir: {e}"))?;
    let db_path = ledger_dir.join("events.db");
    let store = SqliteStore::open(&db_path).map_err(|e| format!("opening events.db: {e}"))?;
    let cas = Cas::open(ledger_dir.join("objects")).map_err(|e| format!("opening cas: {e}"))?;

    let stdin = io::stdin();
    let locked = stdin.lock();
    let stderr = io::stderr();
    let mut stderr_lock = stderr.lock();

    serve_with_protocol(locked, &mut stderr_lock, &store, &cas, 1)
        .map_err(|e| format!("serve: {e}"))?;

    stderr_lock.flush().ok();
    Ok(())
}

/// Execute the `ledger replay` command.
pub fn run_replay(args: ReplayArgs) -> Result<(), String> {
    let db_path = args.workspace.join(".buildplane").join("ledger").join("events.db");
    let mut engine = ReplayEngine::open(&args.run_id, &db_path)
        .map_err(|e| format!("open events.db: {e}"))?;

    if let Some(target) = &args.at {
        let target_id = bp_ledger::id::EventId::from_uuid(
            uuid::Uuid::parse_str(target).map_err(|e| format!("--at parse: {e}"))?,
        );
        match engine.fast_forward_to(target_id) {
            Some(step) => {
                emit_step(&step, args.format)?;
                return Ok(());
            }
            None => {
                return Err(format!("event {target} not found in run {}", args.run_id));
            }
        }
    }

    let mut count = 0usize;
    let mut printed_lineage_header = false;

    for step in engine.by_ref() {
        if !printed_lineage_header && args.format == ReplayFormat::Human {
            if let (Some(parent), Some(event)) = (&step.state_after.parent_run_id, &step.state_after.parent_event_id) {
                println!("forked from {} at {}", parent, event);
            } else if let Some(parent) = &step.state_after.parent_run_id {
                println!("forked from {}", parent);
            }
            printed_lineage_header = true;
        }
        emit_step(&step, args.format)?;
        count += 1;
        if let Some(limit) = args.limit {
            if count >= limit {
                break;
            }
        }
    }

    if args.format == ReplayFormat::Human {
        println!(
            "\nSnapshots: git -C <workspace> log refs/buildplane/run/{}",
            args.run_id
        );
    }

    let issues = &engine.state().issues;
    if !issues.is_empty() {
        eprintln!("{} issues surfaced during replay", issues.len());
        if args.format == ReplayFormat::Human {
            for issue in issues {
                eprintln!("  - {:?}", issue);
            }
        }
    }

    Ok(())
}

fn emit_step(step: &bp_replay::engine::ReplayStep, format: ReplayFormat) -> Result<(), String> {
    match format {
        ReplayFormat::Json => {
            let line = serde_json::to_string(step).map_err(|e| format!("json: {e}"))?;
            println!("{}", line);
        }
        ReplayFormat::Human => {
            let depth = step.state_after.parent_chain.len();
            let indent = "  ".repeat(depth.saturating_sub(1));
            let kind = step.event.kind_str();
            let short_id = &step.event.id.to_string()[..8];
            println!(
                "{}{} {}{}",
                indent,
                kind,
                short_id,
                step.state_after
                    .current_unit
                    .as_ref()
                    .map(|u| format!(" unit={}", u))
                    .unwrap_or_default(),
            );
        }
    }
    Ok(())
}

pub fn usage_text() -> String {
    r#"usage: buildplane-native ledger <subcommand>

subcommands:
  serve   Run a ledger ingest loop against stdin (JSONL events).
  replay  Replay a run's events with optional fast-forward.

flags for `serve`:
  --run-id <id>             run identifier (required)
  --workspace <path>        absolute path to the workspace root (required)
  --schema-version <n>      wire schema version (default: 1)

flags for `replay`:
  --run-id <id>             run identifier (required)
  --workspace <path>        absolute path to the workspace root (required)
  --format <json|human>     output format (default: json)
  --limit <n>               stop after n events
  --at <event-id>           fast-forward to event-id, emit state there, exit
"#
    .to_string()
}
