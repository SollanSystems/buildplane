//! Event payload definitions, versioned per kind.

pub mod acceptance;
pub mod activity;
pub mod capability_broker;
pub mod checkpoint;
pub mod git_checkpoint;
pub mod model_io;
pub mod operator_decision;
pub mod plan_lifecycle;
pub mod run_lifecycle;
pub mod tool_io;
pub mod unit_lifecycle;
pub mod workspace;

use serde::{Deserialize, Serialize};

/// The canonical payload type — what you get after `canonicalize()` reads an
/// event. Rust enum variants correspond to (kind, version) pairs; future
/// versions add variants without changing existing ones.
///
/// Note: `Payload` uses serde's default external tagging (`{"VariantV1": {...}}`).
/// typeshare requires adjacent tagging for algebraic enums, so the TS declaration
/// is maintained manually in `packages/ledger-client/src/payload.ts`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Payload {
    RunStartedV1(run_lifecycle::RunStartedV1),
    RunCompletedV1(run_lifecycle::RunCompletedV1),
    RunFailedV1(run_lifecycle::RunFailedV1),
    ResultReadyV1(run_lifecycle::ResultReadyV1),
    RunAdmissionRecordedV1(run_lifecycle::RunAdmissionRecordedV1),
    PlanAdmittedV1(plan_lifecycle::PlanAdmittedV1),
    PlanReceiptRecordedV1(plan_lifecycle::PlanReceiptRecordedV1),
    ActivityStartedV1(activity::ActivityStartedV1),
    ActivityCompletedV1(activity::ActivityCompletedV1),
    UnitStartedV1(unit_lifecycle::UnitStartedV1),
    UnitCompletedV1(unit_lifecycle::UnitCompletedV1),
    UnitFailedV1(unit_lifecycle::UnitFailedV1),
    UnitCancelledV1(unit_lifecycle::UnitCancelledV1),
    GitCheckpointV1(git_checkpoint::GitCheckpointV1),
    ModelRequestV1(model_io::ModelRequestV1),
    ModelResponseV1(model_io::ModelResponseV1),
    ToolRequestStoredV1(tool_io::ToolRequestStoredV1),
    ToolResultV1(tool_io::ToolResultV1),
    WorkspaceReadV1(workspace::WorkspaceReadV1),
    WorkspaceWriteV1(workspace::WorkspaceWriteV1),
    TapeCheckpointV1(checkpoint::TapeCheckpointV1),
    CapabilityDeniedV1(capability_broker::CapabilityDeniedV1),
    AcceptanceRecordedV1(acceptance::AcceptanceRecordedV1),
    OperatorDecisionRecordedV1(operator_decision::OperatorDecisionRecordedV1),
}
