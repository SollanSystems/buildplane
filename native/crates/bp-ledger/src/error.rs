//! Error types for the ledger crate.

use thiserror::Error;

/// Top-level error type for ledger operations.
#[derive(Debug, Error)]
pub enum LedgerError {
    #[error("invalid json event: {0}")]
    InvalidJson(#[from] serde_json::Error),

    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("schema version {received} not supported (supported: {supported})")]
    UnsupportedSchemaVersion { received: u32, supported: u32 },

    #[error("append-only violation: {0}")]
    AppendOnlyViolation(String),

    #[error("cas: {0}")]
    Cas(String),

    #[error("invalid payload for kind {kind}: {reason}")]
    InvalidPayload { kind: String, reason: String },

    #[error("rejected unsafe keyring identifier ({which}): {reason}")]
    UnsafeKeyringId { which: String, reason: String },
}

pub type Result<T> = std::result::Result<T, LedgerError>;
