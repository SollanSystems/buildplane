//! Per-EventKind state transition functions.

use crate::state::{
    CheckpointRef, FileObservation, PlanAdmissionReplayState, PlanReceiptReplayState,
    RecordedActivityState, ReplayIssue, ReplayState,
};
use bp_ledger::event::Event;
use bp_ledger::payload::{
    activity::{ActivityCompletedV1, ActivityStartedV1, ActivityType},
    git_checkpoint::{CheckpointBoundary, GitCheckpointV1, GitStatus},
    plan_lifecycle::{PlanAdmittedV1, PlanReceiptOutcome, PlanReceiptRecordedV1},
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
        Payload::RunAdmissionRecordedV1(_) => {}
        Payload::PlanAdmittedV1(p) => apply_plan_admitted(state, event, p),
        Payload::PlanReceiptRecordedV1(p) => apply_plan_receipt(state, event, p),
        Payload::ActivityStartedV1(p) => apply_activity_started(state, event, p),
        Payload::ActivityCompletedV1(p) => apply_activity_completed(state, event, p),
        Payload::ModelRequestV1(_)
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

fn apply_plan_admitted(state: &mut ReplayState, event: &Event, p: &PlanAdmittedV1) {
    state.plan_cycle_phase = "plan_admitted".to_string();
    state.plan_admission = Some(PlanAdmissionReplayState {
        event_id: event.id,
        plan_id: p.plan_id.clone(),
        plan_digest: p.plan_digest.clone(),
        input_digest: p.input_digest.clone(),
        trusted_base: p.trusted_base.clone(),
        decided_by: p.decided_by.clone(),
        decided_at: p.decided_at.clone(),
        idempotency_key: p.idempotency_key.clone(),
        authorized_next_step: p.authorized_next_step.clone(),
    });
}

fn apply_activity_started(state: &mut ReplayState, event: &Event, p: &ActivityStartedV1) {
    state.plan_cycle_phase = "activity_started".to_string();
    let entry = state
        .activities
        .entry(p.activity_id.clone())
        .or_insert_with(|| RecordedActivityState {
            activity_id: p.activity_id.clone(),
            ..RecordedActivityState::default()
        });
    entry.run_id = Some(p.run_id.to_string());
    entry.activity_type = Some(activity_type_wire(p.activity_type).to_string());
    entry.input_digest = Some(p.input_digest.clone());
    entry.started_event_id = Some(event.id);
}

fn apply_activity_completed(state: &mut ReplayState, event: &Event, p: &ActivityCompletedV1) {
    state.plan_cycle_phase = "activity_completed".to_string();
    let entry = state
        .activities
        .entry(p.activity_id.clone())
        .or_insert_with(|| RecordedActivityState {
            activity_id: p.activity_id.clone(),
            ..RecordedActivityState::default()
        });
    entry.run_id = Some(p.run_id.to_string());
    entry.completed_event_id = Some(event.id);
    entry.result_digest = Some(p.result_digest.clone());
    entry.result = Some(p.result.clone());
}

fn apply_plan_receipt(state: &mut ReplayState, event: &Event, p: &PlanReceiptRecordedV1) {
    state.plan_cycle_phase = "plan_receipt".to_string();
    state.plan_receipt = Some(PlanReceiptReplayState {
        event_id: event.id,
        plan_id: p.plan_id.clone(),
        admission_event_id: p.admission_event_id,
        outcome: plan_receipt_outcome_wire(p.outcome).to_string(),
        side_effects: p.side_effects.clone(),
        result_digest: p.result_digest.clone(),
        decided_at: p.decided_at.clone(),
    });
}

fn activity_type_wire(activity_type: ActivityType) -> &'static str {
    match activity_type {
        ActivityType::Model => "model",
        ActivityType::Tool => "tool",
        ActivityType::Command => "command",
    }
}

fn plan_receipt_outcome_wire(outcome: PlanReceiptOutcome) -> &'static str {
    match outcome {
        PlanReceiptOutcome::Completed => "completed",
        PlanReceiptOutcome::Failed => "failed",
        PlanReceiptOutcome::Aborted => "aborted",
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
