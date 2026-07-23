//! Forward-iteration replay engine over a bp-ledger events.db.

mod activity_decision;
pub mod engine;
mod otel_projection;
pub mod reader;
pub mod state;
pub mod tape_integrity;
/// Low-level, unchecked state projection helpers. Public callers should use
/// [`ReplayEngine`] so detached signatures and signer-purpose authorization
/// are evaluated before a trust-spine transition is applied. This module stays
/// available for legacy deterministic projection tests and snapshot migration
/// tooling only.
#[doc(hidden)]
pub mod transitions;
pub mod trusted_recovery;

pub use activity_decision::{
    ActionDecisionBlockReasonV1, ActionDecisionDispositionV1, PendingActivityRecoveryErrorV1,
    PendingActivityRecoveryStateV1, PendingActivityRecoveryWorkV1, RecordedActionDecisionQueryV1,
    RecordedActionDecisionV1, RecordedActionIdentityV1, RecordedActivityResultV1,
    PENDING_ACTIVITY_RECOVERY_WORK_SCHEMA_VERSION_V1, RECORDED_ACTION_DECISION_SCHEMA_VERSION_V1,
};
pub use engine::{ReplayEngine, ReplayStep, TrustSpineSignerRole, TrustedReplayAuthorities};
pub use otel_projection::{
    VerifiedOtelActionFactsV1, VerifiedOtelActionOutcomeV1, VerifiedOtelAuthorityV1,
    VerifiedOtelDecisionFactsV1, VerifiedOtelDecisionKindV1, VerifiedOtelDecisionOutcomeV1,
    VerifiedOtelExportAuthorityV1, VerifiedOtelProjectionErrorV1, VerifiedOtelProjectionV1,
    VerifiedOtelResourceV1, VerifiedOtelSpanAttributesV1, VerifiedOtelSpanNameV1,
    VerifiedOtelSpanV1, VerifiedOtelTapeAuthorityV1, VerifiedOtelTapeIntegrityFactsV1,
    VerifiedOtelWorkflowFactsV1, VERIFIED_OTEL_PROJECTION_SCHEMA_VERSION_V1,
};
pub use state::{
    ActionEvidenceReplayState, ActionReceiptReplayState, ActionReceiptSetReplayState,
    ActionReplayState, ActionRequestReplayState, ActivityClaimReplayState,
    ActivityResultReplayState, AttemptContextReplayState, CandidateAcceptanceReplayState,
    CandidateArtifactReplayState, CandidateCompletionReplayState, CheckpointRef, FileObservation,
    ModelActionAuthorizationReplayState, PlanAdmissionReplayState, PlanReceiptReplayState,
    PromotionApprovalRequestReplayState, PromotionDecisionReplayState,
    PromotionReconciliationReplayState, PromotionReplayState, PromotionResultReplayState,
    RecordedActivityState, ReplayIssue, ReplayState, ReviewVerdictReplayState,
    WorkflowCancellationReplayState, WorkflowDispatchReplayState, WorkflowGraphReplayState,
    WorkflowGraphV2ReplayState, WorkflowInstanceV1, WorkflowPhaseV1, WorkflowTerminalReplayState,
    WorkflowTimerReplayState,
};
pub use tape_integrity::{
    verify_full_tape_integrity_v1, TapeIntegrityError, TapeIntegrityReportV1,
};
/// The only public governed recovery-classification capability is a fully
/// verified [`TrustedGovernedRecoverySnapshot`]. An arbitrary replay
/// projection cannot be classified by external callers.
///
/// ```compile_fail
/// use bp_replay::classify_replayed_governed_action_v1;
/// ```
pub use trusted_recovery::{
    PromotionRecoveryBlockReasonV1, PromotionRecoveryDispositionV1,
    RecordedPromotionReconciliationV1, RecordedPromotionRecoveryDecisionV1,
    RecordedPromotionRecoveryIdentityV1, RecordedPromotionRecoveryQueryV1,
    RecordedPromotionResultV1, TrustedGovernedRecoveryError, TrustedGovernedRecoverySnapshot,
    WorkflowInstanceSnapshotCachePersistenceErrorV1,
    WorkflowInstanceSnapshotCacheProjectionErrorV1, RECORDED_PROMOTION_RECOVERY_SCHEMA_VERSION_V1,
};

#[cfg(test)]
mod activity_decision_tests;
