//! `buildplane-native ledger ...` subcommands.
//!
//! Phase A: only `serve` is wired. Phase D adds `inspect`.

use bp_ledger::serve::serve_with_protocol;
use bp_ledger::storage::sqlite::SqliteStore;
use bp_ledger::storage::Cas;
use std::io::{self, Write};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LedgerCommand {
    Serve(ServeArgs),
    Help,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServeArgs {
    pub run_id: String,
    pub workspace: PathBuf,
    pub schema_version: u32,
}

/// Parse `ledger <subcommand> [args...]` into a LedgerCommand.
pub fn parse_ledger_command(args: &[String]) -> Result<LedgerCommand, String> {
    match args.first().map(String::as_str) {
        Some("serve") => parse_serve(&args[1..]).map(LedgerCommand::Serve),
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

pub fn usage_text() -> String {
    r#"usage: buildplane-native ledger <subcommand>

subcommands:
  serve   Run a ledger ingest loop against stdin (JSONL events).

flags for `serve`:
  --run-id <id>             run identifier (required)
  --workspace <path>        absolute path to the workspace root (required)
  --schema-version <n>      wire schema version (default: 1)
"#
    .to_string()
}
