//! `buildplane-native fork ...` subcommands.
//!
//! Phase E: `fork plan` emits a ForkPlan JSON for the TS CLI to execute.
//! Phase F may add a `fork apply` or expand `fork plan` semantics.

use bp_fork::{build_fork_plan, ForkPlan};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForkCommand {
    Plan(ForkPlanArgs),
    Help,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForkPlanArgs {
    pub run_id: String,
    pub at: String,
    pub workspace: PathBuf,
    pub packet: PathBuf,
}

pub fn parse_fork_command(args: &[String]) -> Result<ForkCommand, String> {
    match args.first().map(String::as_str) {
        Some("plan") => parse_plan(&args[1..]).map(ForkCommand::Plan),
        Some("--help" | "-h" | "help") | None => Ok(ForkCommand::Help),
        Some(other) => Err(format!("unknown fork subcommand: {other}")),
    }
}

fn parse_plan(args: &[String]) -> Result<ForkPlanArgs, String> {
    let mut run_id: Option<String> = None;
    let mut at: Option<String> = None;
    let mut workspace: Option<PathBuf> = None;
    let mut packet: Option<PathBuf> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--run-id" => {
                i += 1;
                run_id = Some(args.get(i).ok_or("--run-id requires a value")?.clone());
            }
            "--at" => {
                i += 1;
                at = Some(args.get(i).ok_or("--at requires a value")?.clone());
            }
            "--workspace" => {
                i += 1;
                workspace = Some(PathBuf::from(args.get(i).ok_or("--workspace requires a value")?));
            }
            "--packet" => {
                i += 1;
                packet = Some(PathBuf::from(args.get(i).ok_or("--packet requires a value")?));
            }
            other => return Err(format!("unknown flag: {other}")),
        }
        i += 1;
    }

    let workspace_path = workspace.ok_or("missing --workspace")?;
    if !workspace_path.is_absolute() {
        return Err(format!(
            "--workspace must be an absolute path; got: {}",
            workspace_path.display()
        ));
    }

    Ok(ForkPlanArgs {
        run_id: run_id.ok_or("missing --run-id")?,
        at: at.ok_or("missing --at")?,
        workspace: workspace_path,
        packet: packet.ok_or("missing --packet")?,
    })
}

pub fn run_fork_plan(args: ForkPlanArgs) -> Result<(), String> {
    let plan: ForkPlan = build_fork_plan(
        &args.run_id,
        &args.at,
        &args.workspace,
        &args.packet,
    )
    .map_err(|e| format!("{e}"))?;

    let line = serde_json::to_string(&plan).map_err(|e| format!("json: {e}"))?;
    println!("{}", line);
    Ok(())
}

pub fn usage_text() -> String {
    r#"usage: buildplane-native fork <subcommand>

subcommands:
  plan    Build a fork plan and emit ForkPlan JSON on stdout.

flags for `plan`:
  --run-id <id>             parent run identifier (required)
  --at <event-id>           parent unit_started event id to fork at (required)
  --workspace <path>        absolute path to the workspace root (required)
  --packet <path>           path to the new packet json (required)
"#
    .to_string()
}
