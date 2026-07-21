//! build_fork_plan implementation.

use crate::plan::ForkPlan;
use bp_ledger::id::EventId;
use bp_ledger::kind::EventKind;
use bp_replay::engine::ReplayEngine;
use std::path::Path;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum PlanError {
    #[error("replay: {0}")]
    Replay(String),
    #[error(
        "target event must be unit_started; got {kind} at {event_id}. \
             Nearest enclosing unit_started: {nearest}"
    )]
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
    PacketIo {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("packet file {path} is not valid JSON: {source}")]
    PacketJson {
        path: String,
        #[source]
        source: serde_json::Error,
    },
    #[error("invalid event id {value}: {source}")]
    BadEventId {
        value: String,
        #[source]
        source: uuid::Error,
    },
}

pub fn build_fork_plan(
    parent_run_id: &str,
    target_event_id: &str,
    workspace: &Path,
    packet_path: &Path,
) -> Result<ForkPlan, PlanError> {
    // Resolve events.db under <workspace>/.buildplane/ledger/events.db.
    let db_path = workspace
        .join(".buildplane")
        .join("ledger")
        .join("events.db");
    let mut engine = ReplayEngine::open(parent_run_id, &db_path)
        .map_err(|e| PlanError::Replay(format!("{e}")))?;

    let target_uuid = Uuid::parse_str(target_event_id).map_err(|source| PlanError::BadEventId {
        value: target_event_id.to_string(),
        source,
    })?;
    let target = EventId::from_uuid(target_uuid);

    // Fast-forward to the target.
    let step = engine
        .fast_forward_to(target)
        .ok_or_else(|| PlanError::EventNotFound {
            event_id: target_event_id.to_string(),
            run_id: parent_run_id.to_string(),
        })?;

    // Validate kind.
    match step.event.kind {
        EventKind::UnitStarted => {}
        EventKind::RunStarted => return Err(PlanError::ForkAtRoot),
        other => {
            let nearest = nearest_unit_start(&step, other).unwrap_or_else(|| "unknown".to_string());
            return Err(PlanError::TargetNotUnitStarted {
                kind: format!("{other:?}"),
                event_id: target_event_id.to_string(),
                nearest,
            });
        }
    }

    // Extract unit_id from the event payload.
    let unit_id = match &step.event.payload {
        bp_ledger::payload::Payload::UnitStartedV1(p) => p.unit_id.clone(),
        _ => unreachable!("kind == UnitStarted implies payload == UnitStartedV1"),
    };

    // Find the pre-unit checkpoint for this unit in state_after.checkpoints.
    // The checkpoint may not have been seen yet at this point in iteration
    // (unit_started fires before pre-unit git_checkpoint). We need to
    // continue iteration briefly to pick up the pre-unit checkpoint.
    let pre_sha = find_pre_checkpoint_after(&mut engine, &unit_id).ok_or_else(|| {
        PlanError::MissingPreCheckpoint {
            unit_id: unit_id.clone(),
        }
    })?;

    // Read + parse packet.
    let packet_bytes = std::fs::read(packet_path).map_err(|source| PlanError::PacketIo {
        path: packet_path.display().to_string(),
        source,
    })?;
    let packet_json: serde_json::Value =
        serde_json::from_slice(&packet_bytes).map_err(|source| PlanError::PacketJson {
            path: packet_path.display().to_string(),
            source,
        })?;

    // Fresh run_id via UUIDv7.
    let new_run_id = Uuid::now_v7().to_string();

    Ok(ForkPlan {
        new_run_id,
        workspace_path: workspace.display().to_string(),
        checkout_sha: pre_sha,
        packet_json,
        parent_run_id: parent_run_id.to_string(),
        parent_event_id: target_event_id.to_string(),
    })
}

/// Walk the engine forward after fast_forward_to landed on the unit_started;
/// the pre-unit checkpoint is typically the next event. Return the SHA if
/// found before iteration ends.
fn find_pre_checkpoint_after(engine: &mut ReplayEngine, unit_id: &str) -> Option<String> {
    // After fast_forward_to, the engine's cursor is past the unit_started.
    // Scan forward through subsequent events looking for a GitCheckpoint
    // whose unit_id matches and boundary is pre-unit.
    use bp_ledger::payload::git_checkpoint::CheckpointBoundary;
    use bp_ledger::payload::Payload;

    for step in engine.by_ref() {
        if let Payload::GitCheckpointV1(p) = &step.event.payload {
            if p.unit_id == unit_id
                && matches!(p.boundary, CheckpointBoundary::PreUnit)
                && matches!(
                    p.git_status,
                    bp_ledger::payload::git_checkpoint::GitStatus::Ok
                )
            {
                return Some(p.commit_sha.clone());
            }
        }
    }
    None
}

/// Best-effort "nearest unit_started" lookup for the TargetNotUnitStarted error.
/// For Phase E's minimal impl we return the parent chain's last unit_started
/// if present; otherwise "unknown".
fn nearest_unit_start(step: &bp_replay::engine::ReplayStep, _kind: EventKind) -> Option<String> {
    step.state_after
        .parent_chain
        .iter()
        .next_back()
        .map(|id| id.to_string())
}
