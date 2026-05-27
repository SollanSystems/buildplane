//! Event payload definitions, versioned per kind.

pub mod checkpoint;
pub mod git_checkpoint;
pub mod model_io;
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
    RunAdmissionRecordedV1(run_lifecycle::RunAdmissionRecordedV1),
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
}
