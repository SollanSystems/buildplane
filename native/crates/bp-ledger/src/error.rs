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

    #[error("caller-supplied tape_checkpoint events are rejected: checkpoints are ledger-internal and created only by the checkpoint emitter")]
    CallerSuppliedCheckpoint,

    #[error("caller-supplied trust-spine event {kind} is rejected: authority-bearing records must use a dedicated native control")]
    CallerSuppliedTrustSpineEvent { kind: String },

    #[error("caller-supplied signed authority event {kind} is rejected: the generic signed ingest endpoint cannot bless workflow lifecycle or decision records")]
    CallerSuppliedSignedAuthorityEvent { kind: String },

    #[error("caller-supplied event {kind} is rejected on the governed serve endpoint: governed tape records must be issued only by protected native controls")]
    CallerSuppliedGovernedEvent { kind: String },

    #[error("governed serve run mismatch: expected {expected_run_id}, received {received_run_id}")]
    GovernedServeRunMismatch {
        expected_run_id: String,
        received_run_id: String,
    },

    #[error("non-monotonic event id for run {run_id}: incoming event id must be strictly greater than the latest existing event id for the same run")]
    NonMonotonicEventId { run_id: String },

    #[error("activity claim authority rejected: {reason}")]
    ActivityClaimAuthorityRejected { reason: String },

    #[error("activity claim idempotency conflict for run {run_id} and key {idempotency_key}")]
    ActivityClaimIdempotencyConflict {
        run_id: String,
        idempotency_key: String,
    },

    #[error("activity claim not found for run {run_id} and key {idempotency_key}")]
    ActivityClaimNotFound {
        run_id: String,
        idempotency_key: String,
    },

    #[error("activity claim lease does not match for run {run_id} and key {idempotency_key}")]
    ActivityClaimLeaseMismatch {
        run_id: String,
        idempotency_key: String,
    },

    #[error(
        "activity heartbeat idempotency conflict for run {run_id} and heartbeat {heartbeat_id}"
    )]
    ActivityHeartbeatIdempotencyConflict {
        run_id: String,
        heartbeat_id: String,
    },

    #[error("model action intent authority rejected: {reason}")]
    ModelActionIntentAuthorityRejected { reason: String },

    #[error("model action intent idempotency conflict for run {run_id} and action request {action_request_event_id}")]
    ModelActionIntentIdempotencyConflict {
        run_id: String,
        action_request_event_id: String,
    },

    #[error("model action authorization idempotency conflict for run {run_id} and action request {action_request_event_id}")]
    ModelActionAuthorizationIdempotencyConflict {
        run_id: String,
        action_request_event_id: String,
    },

    #[error("model action authorization requires reconciliation for run {run_id} and action request {action_request_event_id}: {reason}")]
    ModelActionAuthorizationReconciliationRequired {
        run_id: String,
        action_request_event_id: String,
        reason: String,
    },

    #[error("governed candidate completion authority rejected: {reason}")]
    CandidateCompletionAuthorityRejected { reason: String },

    #[error("governed candidate completion requires reconciliation for run {run_id} and candidate-created event {candidate_created_event_id}: {reason}")]
    CandidateCompletionReconciliationRequired {
        run_id: String,
        candidate_created_event_id: String,
        reason: String,
    },

    #[error("governed promotion authority rejected: {reason}")]
    PromotionAuthorityRejected { reason: String },

    #[error("governed promotion decision idempotency conflict for run {run_id} and key {idempotency_key}")]
    PromotionDecisionIdempotencyConflict {
        run_id: String,
        idempotency_key: String,
    },

    #[error("governed promotion decision requires reconciliation for run {run_id} and candidate {candidate_digest}: {reason}")]
    PromotionDecisionReconciliationRequired {
        run_id: String,
        candidate_digest: String,
        reason: String,
    },

    #[error("governed promotion execution claim requires reconciliation for run {run_id} and candidate {candidate_digest}: {reason}")]
    PromotionExecutionClaimReconciliationRequired {
        run_id: String,
        candidate_digest: String,
        reason: String,
    },

    #[error("governed promotion result requires reconciliation for run {run_id} and candidate {candidate_digest}: {reason}")]
    PromotionResultReconciliationRequired {
        run_id: String,
        candidate_digest: String,
        reason: String,
    },
}

pub type Result<T> = std::result::Result<T, LedgerError>;
