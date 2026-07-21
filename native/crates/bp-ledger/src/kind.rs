//! Event kind discriminator — one variant per event type at the envelope level.

use serde::{Deserialize, Serialize};
use typeshare::typeshare;

/// The kind discriminator identifies which payload variant an event carries.
///
/// Kinds are grouped: run lifecycle, unit lifecycle, git checkpoint, model I/O,
/// tool I/O, workspace observation.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    // Run lifecycle
    RunStarted,
    RunCompleted,
    RunFailed,
    RunAdmissionRecorded,
    // PlanForge lifecycle (M2)
    PlanAdmitted,
    #[serde(rename = "plan_receipt")]
    PlanReceiptRecorded,
    ActivityStarted,
    ActivityCompleted,
    // Unit lifecycle
    UnitStarted,
    UnitCompleted,
    UnitFailed,
    UnitCancelled,
    // Git checkpoint
    GitCheckpoint,
    // Model I/O
    ModelRequest,
    ModelResponse,
    // Tool I/O
    ToolRequest,
    ToolResult,
    // Workspace observation
    WorkspaceRead,
    WorkspaceWrite,
    // M3 capability broker
    CapabilityDenied,
    // M4 acceptance contract
    AcceptanceRecorded,
    // M5 operator decision
    OperatorDecisionRecorded,
    // M6 result-ready signal
    ResultReady,
    // Trust-spine workflow authority/evidence records.
    DispatchEnvelope,
    DispatchEnvelopeV2,
    DispatchEnvelopeV3,
    DispatchEnvelopeV4,
    WorkflowGraphDeclaredV1,
    WorkflowGraphDeclaredV2,
    ActionRequestedV2,
    ModelActionIntentV1,
    ModelActionAuthorizedV1,
    ModelActionAuthorizedV2,
    ActivityClaimedV1,
    ActivityHeartbeatRecordedV1,
    ActivityResultRecordedV1,
    ActionReceiptRecordedV2,
    ActionReceiptSetRecordedV1,
    AttemptContextRecordedV1,
    CandidateCreated,
    CandidateCreatedV2,
    CandidateCompletionRecordedV1,
    CandidateAcceptanceRecorded,
    ReviewVerdictRecorded,
    ReviewVerdictRecordedV2,
    PromotionApprovalRequested,
    PromotionDecisionRecorded,
    PromotionExecutionClaimedV1,
    PromotionResultRecorded,
    PromotionReconciliationResolved,
    ReleaseEvaluationEvidenceV1,
    WorkflowTimerScheduledV1,
    WorkflowTimerFiredV1,
    WorkflowCancellationRequestedV1,
    WorkflowTerminal,
    WorkflowTerminalV2,
    // Tape-root checkpoint (M1-S6) — unrelated to the unit-boundary GitCheckpoint.
    TapeCheckpoint,
}

impl EventKind {
    /// Canonical snake_case string for the kind, used in wire format and SQL.
    pub fn as_wire(&self) -> &'static str {
        match self {
            Self::RunStarted => "run_started",
            Self::RunCompleted => "run_completed",
            Self::RunFailed => "run_failed",
            Self::RunAdmissionRecorded => "run_admission_recorded",
            Self::PlanAdmitted => "plan_admitted",
            Self::PlanReceiptRecorded => "plan_receipt",
            Self::ActivityStarted => "activity_started",
            Self::ActivityCompleted => "activity_completed",
            Self::UnitStarted => "unit_started",
            Self::UnitCompleted => "unit_completed",
            Self::UnitFailed => "unit_failed",
            Self::UnitCancelled => "unit_cancelled",
            Self::GitCheckpoint => "git_checkpoint",
            Self::ModelRequest => "model_request",
            Self::ModelResponse => "model_response",
            Self::ToolRequest => "tool_request",
            Self::ToolResult => "tool_result",
            Self::WorkspaceRead => "workspace_read",
            Self::WorkspaceWrite => "workspace_write",
            Self::CapabilityDenied => "capability_denied",
            Self::AcceptanceRecorded => "acceptance_recorded",
            Self::OperatorDecisionRecorded => "operator_decision_recorded",
            Self::ResultReady => "result_ready",
            Self::DispatchEnvelope => "dispatch_envelope",
            Self::DispatchEnvelopeV2 => "dispatch_envelope_v2",
            Self::DispatchEnvelopeV3 => "dispatch_envelope_v3",
            Self::DispatchEnvelopeV4 => "dispatch_envelope_v4",
            Self::WorkflowGraphDeclaredV1 => "workflow_graph_declared_v1",
            Self::WorkflowGraphDeclaredV2 => "workflow_graph_declared_v2",
            Self::ActionRequestedV2 => "action_requested_v2",
            Self::ModelActionIntentV1 => "model_action_intent_v1",
            Self::ModelActionAuthorizedV1 => "model_action_authorized_v1",
            Self::ModelActionAuthorizedV2 => "model_action_authorized_v2",
            Self::ActivityClaimedV1 => "activity_claimed_v1",
            Self::ActivityHeartbeatRecordedV1 => "activity_heartbeat_recorded_v1",
            Self::ActivityResultRecordedV1 => "activity_result_recorded_v1",
            Self::ActionReceiptRecordedV2 => "action_receipt_recorded_v2",
            Self::ActionReceiptSetRecordedV1 => "action_receipt_set_recorded_v1",
            Self::AttemptContextRecordedV1 => "attempt_context_recorded_v1",
            Self::CandidateCreated => "candidate_created",
            Self::CandidateCreatedV2 => "candidate_created_v2",
            Self::CandidateCompletionRecordedV1 => "candidate_completion_recorded_v1",
            Self::CandidateAcceptanceRecorded => "candidate_acceptance_recorded",
            Self::ReviewVerdictRecorded => "review_verdict_recorded",
            Self::ReviewVerdictRecordedV2 => "review_verdict_recorded_v2",
            Self::PromotionApprovalRequested => "promotion_approval_requested",
            Self::PromotionDecisionRecorded => "promotion_decision_recorded",
            Self::PromotionExecutionClaimedV1 => "promotion_execution_claimed_v1",
            Self::PromotionResultRecorded => "promotion_result_recorded",
            Self::PromotionReconciliationResolved => "promotion_reconciliation_resolved",
            Self::ReleaseEvaluationEvidenceV1 => "release_evaluation_evidence_v1",
            Self::WorkflowTimerScheduledV1 => "workflow_timer_scheduled_v1",
            Self::WorkflowTimerFiredV1 => "workflow_timer_fired_v1",
            Self::WorkflowCancellationRequestedV1 => "workflow_cancellation_requested_v1",
            Self::WorkflowTerminal => "workflow_terminal",
            Self::WorkflowTerminalV2 => "workflow_terminal_v2",
            Self::TapeCheckpoint => "tape_checkpoint",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_serializes_to_snake_case() {
        let s = serde_json::to_string(&EventKind::ModelRequest).unwrap();
        assert_eq!(s, r#""model_request""#);
    }

    #[test]
    fn as_wire_matches_serde_output() {
        for kind in [
            EventKind::RunStarted,
            EventKind::RunCompleted,
            EventKind::RunFailed,
            EventKind::RunAdmissionRecorded,
            EventKind::PlanAdmitted,
            EventKind::PlanReceiptRecorded,
            EventKind::ActivityStarted,
            EventKind::ActivityCompleted,
            EventKind::UnitStarted,
            EventKind::UnitCompleted,
            EventKind::UnitFailed,
            EventKind::UnitCancelled,
            EventKind::GitCheckpoint,
            EventKind::ModelRequest,
            EventKind::ModelResponse,
            EventKind::ToolRequest,
            EventKind::ToolResult,
            EventKind::WorkspaceRead,
            EventKind::WorkspaceWrite,
            EventKind::CapabilityDenied,
            EventKind::AcceptanceRecorded,
            EventKind::OperatorDecisionRecorded,
            EventKind::ResultReady,
            EventKind::DispatchEnvelope,
            EventKind::DispatchEnvelopeV2,
            EventKind::DispatchEnvelopeV3,
            EventKind::DispatchEnvelopeV4,
            EventKind::WorkflowGraphDeclaredV1,
            EventKind::WorkflowGraphDeclaredV2,
            EventKind::ActionRequestedV2,
            EventKind::ModelActionIntentV1,
            EventKind::ModelActionAuthorizedV1,
            EventKind::ModelActionAuthorizedV2,
            EventKind::ActivityClaimedV1,
            EventKind::ActivityHeartbeatRecordedV1,
            EventKind::ActivityResultRecordedV1,
            EventKind::ActionReceiptRecordedV2,
            EventKind::ActionReceiptSetRecordedV1,
            EventKind::AttemptContextRecordedV1,
            EventKind::CandidateCreated,
            EventKind::CandidateCreatedV2,
            EventKind::CandidateCompletionRecordedV1,
            EventKind::CandidateAcceptanceRecorded,
            EventKind::ReviewVerdictRecorded,
            EventKind::ReviewVerdictRecordedV2,
            EventKind::PromotionApprovalRequested,
            EventKind::PromotionDecisionRecorded,
            EventKind::PromotionExecutionClaimedV1,
            EventKind::PromotionResultRecorded,
            EventKind::PromotionReconciliationResolved,
            EventKind::ReleaseEvaluationEvidenceV1,
            EventKind::WorkflowTimerScheduledV1,
            EventKind::WorkflowTimerFiredV1,
            EventKind::WorkflowCancellationRequestedV1,
            EventKind::WorkflowTerminal,
            EventKind::WorkflowTerminalV2,
            EventKind::TapeCheckpoint,
        ] {
            let json = serde_json::to_string(&kind).unwrap();
            let stripped = json.trim_matches('"');
            assert_eq!(stripped, kind.as_wire(), "mismatch for {:?}", kind);
        }
    }
}
