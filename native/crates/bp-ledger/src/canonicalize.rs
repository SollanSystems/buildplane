//! Per-(kind, version) payload canonicalization.
//!
//! At v1, `canonicalize` is the identity: every stored event is already in
//! canonical shape. The function exists so v2+ can add migration logic without
//! changing callers.

use crate::error::{LedgerError, Result};
use crate::event::Event;
use crate::payload::Payload;

/// Canonicalize an event's payload, applying migrations if necessary.
///
/// Reads the envelope's `schema_version` and, if supported, returns the event
/// with its payload in the canonical (latest) shape. On v1 this is a passthrough.
pub fn canonicalize(event: Event) -> Result<Event> {
    if event.schema_version != Event::CURRENT_SCHEMA_VERSION {
        return Err(LedgerError::UnsupportedSchemaVersion {
            received: event.schema_version,
            supported: Event::CURRENT_SCHEMA_VERSION,
        });
    }
    Ok(event)
}

/// Same as [`canonicalize`] but operates on a bare payload value when you
/// already know the kind and version. Useful for storage-layer reads that
/// don't reconstitute the full envelope.
pub fn canonicalize_payload(kind: &str, version: u32, payload: serde_json::Value) -> Result<Payload> {
    if version != Event::CURRENT_SCHEMA_VERSION {
        return Err(LedgerError::UnsupportedSchemaVersion {
            received: version,
            supported: Event::CURRENT_SCHEMA_VERSION,
        });
    }
    let variant = kind_to_variant(kind)?;
    let wrapped = serde_json::json!({ variant: payload });
    serde_json::from_value::<Payload>(wrapped).map_err(LedgerError::from)
}

fn kind_to_variant(kind: &str) -> Result<&'static str> {
    Ok(match kind {
        "run_started" => "RunStartedV1",
        "run_completed" => "RunCompletedV1",
        "run_failed" => "RunFailedV1",
        "unit_started" => "UnitStartedV1",
        "unit_completed" => "UnitCompletedV1",
        "unit_failed" => "UnitFailedV1",
        "unit_cancelled" => "UnitCancelledV1",
        "git_checkpoint" => "GitCheckpointV1",
        "model_request" => "ModelRequestV1",
        "model_response" => "ModelResponseV1",
        "tool_request" => "ToolRequestStoredV1",
        "tool_result" => "ToolResultV1",
        "workspace_read" => "WorkspaceReadV1",
        "workspace_write" => "WorkspaceWriteV1",
        other => {
            return Err(LedgerError::InvalidPayload {
                kind: other.to_string(),
                reason: "unknown kind".into(),
            })
        }
    })
}
