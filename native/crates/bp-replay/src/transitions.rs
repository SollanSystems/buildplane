//! Per-EventKind state transition functions.

use crate::state::{CheckpointRef, FileObservation, ReplayIssue, ReplayState};
use bp_ledger::event::Event;
use bp_ledger::payload::{
    git_checkpoint::{CheckpointBoundary, GitCheckpointV1, GitStatus},
    run_lifecycle::{RunCompletedV1, RunFailedV1, RunStartedV1},
    tool_io::{ToolRequestStoredV1, ToolResultV1},
    unit_lifecycle::{UnitCancelledV1, UnitCompletedV1, UnitFailedV1, UnitStartedV1},
    workspace::{PostWriteState, WorkspaceWriteV1},
    Payload,
};

pub fn apply(state: &mut ReplayState, event: &Event) {
    match &event.payload {
        Payload::RunStartedV1(p) => apply_run_started(state, event, p),
        Payload::RunCompletedV1(p) => apply_run_completed(state, event, p),
        Payload::RunFailedV1(p) => apply_run_failed(state, event, p),
        Payload::UnitStartedV1(p) => apply_unit_started(state, event, p),
        Payload::UnitCompletedV1(p) => apply_unit_completed(state, event, p),
        Payload::UnitFailedV1(p) => apply_unit_failed(state, event, p),
        Payload::UnitCancelledV1(p) => apply_unit_cancelled(state, event, p),
        Payload::GitCheckpointV1(p) => apply_git_checkpoint(state, event, p),
        Payload::RunAdmissionRecordedV1(_)
        | Payload::ModelRequestV1(_)
        | Payload::ModelResponseV1(_)
        // Tape-root checkpoints (M1-S6) are tape-integrity metadata, not
        // replayable state transitions — no-op during replay.
        | Payload::TapeCheckpointV1(_) => {}
        Payload::ToolRequestStoredV1(p) => apply_tool_request(state, event, p),
        Payload::ToolResultV1(p) => apply_tool_result(state, event, p),
        Payload::WorkspaceReadV1(_) => {}
        Payload::WorkspaceWriteV1(p) => apply_workspace_write(state, event, p),
    }
}

fn apply_run_started(state: &mut ReplayState, event: &Event, p: &RunStartedV1) {
    state.run_id = Some(event.run_id.to_string());
    state.parent_run_id = p.parent_run_id.as_ref().map(|id| id.to_string());
    state.parent_event_id = p.parent_event_id.as_ref().map(|id| id.to_string());
    state.parent_chain.push(event.id);
}

fn apply_run_completed(state: &mut ReplayState, _event: &Event, _p: &RunCompletedV1) {
    state.parent_chain.clear();
}

fn apply_run_failed(state: &mut ReplayState, _event: &Event, _p: &RunFailedV1) {
    state.parent_chain.clear();
}

fn apply_unit_started(state: &mut ReplayState, event: &Event, p: &UnitStartedV1) {
    state.current_unit = Some(p.unit_id.clone());
    state.parent_chain.push(event.id);
}

fn apply_unit_completed(state: &mut ReplayState, _event: &Event, _p: &UnitCompletedV1) {
    state.current_unit = None;
    state.parent_chain.pop();
}

fn apply_unit_failed(state: &mut ReplayState, _event: &Event, _p: &UnitFailedV1) {
    state.current_unit = None;
    state.parent_chain.pop();
}

fn apply_unit_cancelled(state: &mut ReplayState, _event: &Event, _p: &UnitCancelledV1) {
    state.current_unit = None;
    state.parent_chain.pop();
}

fn apply_git_checkpoint(state: &mut ReplayState, event: &Event, p: &GitCheckpointV1) {
    match &p.git_status {
        GitStatus::Ok => {
            state.checkpoints.push(CheckpointRef {
                boundary: match p.boundary {
                    CheckpointBoundary::PreUnit => "pre-unit".to_string(),
                    CheckpointBoundary::PostUnit => "post-unit".to_string(),
                },
                reference: p.reference.clone(),
                commit_sha: p.commit_sha.clone(),
                unit_id: p.unit_id.clone(),
                from_event_id: event.id,
            });
        }
        GitStatus::Failed { error } => {
            state.issues.push(ReplayIssue::CheckpointFailed {
                unit_id: p.unit_id.clone(),
                step: "unknown".to_string(),
                error: error.clone(),
            });
        }
    }
}

fn apply_tool_request(state: &mut ReplayState, event: &Event, _p: &ToolRequestStoredV1) {
    state.parent_chain.push(event.id);
}

fn apply_tool_result(state: &mut ReplayState, _event: &Event, _p: &ToolResultV1) {
    state.parent_chain.pop();
}

fn apply_workspace_write(state: &mut ReplayState, event: &Event, p: &WorkspaceWriteV1) {
    match &p.after {
        PostWriteState::Captured { hash, .. } => {
            state.observed_files.insert(
                p.path.clone(),
                FileObservation {
                    last_known_hash: hash.clone(),
                    from_event_id: event.id,
                },
            );
        }
        PostWriteState::Unreadable { reason } => {
            state.issues.push(ReplayIssue::UnreadablePostWrite {
                path: p.path.clone(),
                reason: reason.clone(),
            });
        }
    }
}
