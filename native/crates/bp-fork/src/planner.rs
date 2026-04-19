//! build_fork_plan implementation. Drives bp-replay to fast-forward to a
//! target, validates it's a unit_started, extracts the pre-unit checkpoint,
//! reads the packet file, returns a ForkPlan.

use crate::plan::ForkPlan;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PlanError {
    #[error("replay: {0}")]
    Replay(String),
    #[error("target event must be unit_started; got {kind} at {event_id}. \
             Nearest enclosing unit_started: {nearest}")]
    TargetNotUnitStarted {
        kind: String,
        event_id: String,
        nearest: String,
    },
    #[error("cannot fork at run_started; use `buildplane run` directly")]
    ForkAtRoot,
    #[error("event {event_id} not found in run {run_id}")]
    EventNotFound { event_id: String, run_id: String },
    #[error("no pre-unit git_checkpoint for unit {unit_id} (corrupted or partial tape)")]
    MissingPreCheckpoint { unit_id: String },
    #[error("packet file {path}: {source}")]
    PacketIo { path: String, #[source] source: std::io::Error },
    #[error("packet file {path} is not valid JSON: {source}")]
    PacketJson { path: String, #[source] source: serde_json::Error },
}

/// Build a ForkPlan from a parent run's events.db, a target event_id,
/// a workspace path, and a new packet file path.
///
/// Phase E stub. Full implementation lands in Task 2.
pub fn build_fork_plan(
    _parent_run_id: &str,
    _target_event_id: &str,
    _workspace: &std::path::Path,
    _packet_path: &std::path::Path,
) -> Result<ForkPlan, PlanError> {
    Err(PlanError::Replay("not yet implemented".into()))
}
