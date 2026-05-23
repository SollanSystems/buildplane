//! Per-(kind, version) payload canonicalization.
//!
//! At v1, `canonicalize` is the identity: every stored event is already in
//! canonical shape. The function exists so v2+ can add migration logic without
//! changing callers.

use crate::error::{LedgerError, Result};
use crate::event::Event;
use crate::payload::Payload;
use sha2::{Digest, Sha256};

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
    validate_kind_matches_payload(event.kind_str(), &event.payload)?;
    Ok(event)
}

/// Return the SHA-256 digest of the canonical serialized event bytes.
///
/// The returned value is formatted as `sha256:<hex>` for detached signatures.
pub fn canonical_event_hash(event: &Event) -> Result<String> {
    let bytes = canonical_event_bytes(event)?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

/// Serialize an event in the canonical v1 envelope form used for signing.
///
/// Signatures are detached from events, so these bytes are computed only from
/// the event envelope and payload after [`canonicalize`] has validated/migrated
/// the event.
pub fn canonical_event_bytes(event: &Event) -> Result<Vec<u8>> {
    let canonical = canonicalize(event.clone())?;
    Ok(serde_json::to_vec(&canonical)?)
}

/// Same as [`canonicalize`] but operates on a stored payload JSON value when
/// you already know the kind and version. Useful for storage-layer reads that
/// don't reconstitute the full envelope.
///
/// The `payload` argument must be the JSON representation of a [`Payload`]
/// value as written by `serde_json::to_string(&event.payload)` — i.e. an
/// externally-tagged enum object such as `{"WorkspaceReadV1": {...}}`.
pub fn canonicalize_payload(
    kind: &str,
    version: u32,
    payload: serde_json::Value,
) -> Result<Payload> {
    if version != Event::CURRENT_SCHEMA_VERSION {
        return Err(LedgerError::UnsupportedSchemaVersion {
            received: version,
            supported: Event::CURRENT_SCHEMA_VERSION,
        });
    }
    let payload = serde_json::from_value::<Payload>(payload).map_err(LedgerError::from)?;
    validate_kind_matches_payload(kind, &payload)?;
    Ok(payload)
}

fn validate_kind_matches_payload(kind: &str, payload: &Payload) -> Result<()> {
    let expected_variant = kind_to_variant(kind)?;
    if payload_variant_name(payload) != expected_variant {
        return Err(LedgerError::InvalidPayload {
            kind: kind.to_string(),
            reason: format!("payload missing expected variant key '{expected_variant}'"),
        });
    }
    Ok(())
}

fn payload_variant_name(payload: &Payload) -> &'static str {
    match payload {
        Payload::RunStartedV1(_) => "RunStartedV1",
        Payload::RunCompletedV1(_) => "RunCompletedV1",
        Payload::RunFailedV1(_) => "RunFailedV1",
        Payload::UnitStartedV1(_) => "UnitStartedV1",
        Payload::UnitCompletedV1(_) => "UnitCompletedV1",
        Payload::UnitFailedV1(_) => "UnitFailedV1",
        Payload::UnitCancelledV1(_) => "UnitCancelledV1",
        Payload::GitCheckpointV1(_) => "GitCheckpointV1",
        Payload::ModelRequestV1(_) => "ModelRequestV1",
        Payload::ModelResponseV1(_) => "ModelResponseV1",
        Payload::ToolRequestStoredV1(_) => "ToolRequestStoredV1",
        Payload::ToolResultV1(_) => "ToolResultV1",
        Payload::WorkspaceReadV1(_) => "WorkspaceReadV1",
        Payload::WorkspaceWriteV1(_) => "WorkspaceWriteV1",
    }
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
