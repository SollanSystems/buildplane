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
            EventKind::RunStarted, EventKind::RunCompleted, EventKind::RunFailed,
            EventKind::RunAdmissionRecorded,
            EventKind::PlanAdmitted, EventKind::PlanReceiptRecorded,
            EventKind::ActivityStarted, EventKind::ActivityCompleted,
            EventKind::UnitStarted, EventKind::UnitCompleted, EventKind::UnitFailed,
            EventKind::UnitCancelled, EventKind::GitCheckpoint,
            EventKind::ModelRequest, EventKind::ModelResponse,
            EventKind::ToolRequest, EventKind::ToolResult,
            EventKind::WorkspaceRead, EventKind::WorkspaceWrite,
            EventKind::CapabilityDenied,
            EventKind::TapeCheckpoint,
        ] {
            let json = serde_json::to_string(&kind).unwrap();
            let stripped = json.trim_matches('"');
            assert_eq!(stripped, kind.as_wire(), "mismatch for {:?}", kind);
        }
    }
}
