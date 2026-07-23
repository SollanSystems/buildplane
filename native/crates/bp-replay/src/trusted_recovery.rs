//! Canonical, read-only governed recovery snapshots.
//!
//! A normal [`crate::ReplayEngine`] intentionally keeps legacy tapes
//! inspectable even when governed evidence cannot be trusted. This module is
//! the stricter recovery boundary: it exhausts purpose-authorized replay and
//! verifies the complete signed tape-root chain before exposing any governed
//! workflow evidence.

use crate::activity_decision::{
    blocked, classify_replayed_governed_action_v1, query_is_well_formed,
    ActionDecisionBlockReasonV1, RecordedActionDecisionQueryV1, RecordedActionDecisionV1,
    RECORDED_ACTION_DECISION_SCHEMA_VERSION_V1,
};
use crate::engine::{EngineError, ReplayEngine, TrustSpineSignerRole, TrustedReplayAuthorities};
use crate::otel_projection::{VerifiedOtelProjectionErrorV1, VerifiedOtelProjectionV1};
use crate::state::{ReplayIssue, WorkflowInstanceV1};
use crate::tape_integrity::{
    verify_full_tape_integrity_v1, TapeIntegrityError, TapeIntegrityReportV1,
};
use bp_ledger::canonicalize::{
    is_canonical_buildplane_candidate_ref, BUILDPANE_CANDIDATE_REF_PREFIX,
};
use bp_ledger::payload::trust_spine::{
    ActionEvidenceVersionV1, CommitModeV1, PromotionDecisionKindV1, PromotionResultOutcomeV1,
    ReconciliationResolutionOutcomeV1, TrustTierV1,
};
use bp_ledger::signing::ActorKeyRef;
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

/// Why a governed recovery snapshot could not be constructed.
#[derive(Debug, thiserror::Error)]
pub enum TrustedGovernedRecoveryError {
    #[error("open trusted replay: {0}")]
    Replay(#[from] EngineError),
    #[error("pinned governed recovery kernel signer is not authorized for the kernel role")]
    PinnedKernelSignerUnauthorized { signer: ActorKeyRef },
    #[error(
        "trusted governed replay fact was not verified and authorized, or has conflicting workflow evidence ({issue:?}); recovery is blocked"
    )]
    ReplayIssue { issue: ReplayIssue },
    #[error("governed tape integrity verification failed: {0}")]
    TapeIntegrity(#[from] TapeIntegrityError),
    #[error(
        "trusted governed recovery requires at least one governed atomic sealed_v3 or graph-bound V4 workflow"
    )]
    NoSealedV3GovernedWorkflow,
    #[error(
        "candidate digest {candidate_digest} is bound to more than one verified governed workflow ({first_dispatch_event_ref}, {conflicting_dispatch_event_ref})"
    )]
    CandidateIdentityConflict {
        candidate_digest: String,
        first_dispatch_event_ref: String,
        conflicting_dispatch_event_ref: String,
    },
    #[error(
        "promotion identity ({candidate_digest}, {idempotency_key}) is bound to more than one verified governed workflow ({first_dispatch_event_ref}, {conflicting_dispatch_event_ref})"
    )]
    PromotionIdentityConflict {
        candidate_digest: String,
        idempotency_key: String,
        first_dispatch_event_ref: String,
        conflicting_dispatch_event_ref: String,
    },
    #[error(
        "promotion evidence for candidate {candidate_digest} is not bound to its immutable candidate"
    )]
    PromotionCandidateConflict { candidate_digest: String },
}

/// Immutable, tape-derived identity for a governed promotion decision.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct PromotionIdentity {
    candidate_digest: String,
    idempotency_key: String,
}

/// Closed wire-schema revision for a read-only recorded-promotion recovery
/// classification.
///
/// This API deliberately exposes only immutable tape evidence. In particular,
/// it has no project path, target ref, worktree, lease, capability, or retry
/// field, and no result can be interpreted as permission to run a promotion.
pub const RECORDED_PROMOTION_RECOVERY_SCHEMA_VERSION_V1: u16 = 1;

/// Immutable identity that a caller expects to find in a fully verified
/// governed recovery snapshot.
///
/// The exact decision event and digest are mandatory. A candidate digest plus
/// idempotency key alone is insufficient because it could otherwise bind an
/// observation to a substituted promotion decision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordedPromotionRecoveryIdentityV1 {
    pub run_id: String,
    pub workflow_id: String,
    pub workflow_revision: String,
    pub unit_id: String,
    pub attempt: u32,
    pub dispatch_event_ref: String,
    pub dispatch_envelope_digest: String,
    pub candidate_digest: String,
    pub promotion_decision_event_ref: String,
    pub promotion_decision_event_digest: String,
    pub idempotency_key: String,
}

/// Read-only query for the current recorded state of one immutable promotion.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordedPromotionRecoveryQueryV1 {
    pub schema_version: u16,
    pub identity: RecordedPromotionRecoveryIdentityV1,
}

/// Exhaustive, non-authorizing promotion recovery disposition.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromotionRecoveryDispositionV1 {
    /// The immutable promotion result is already recorded and can be reused as
    /// evidence. It does not grant a new target-branch mutation.
    ReuseRecordedPromotion,
    /// A signed rejection decision or result is terminal evidence; recovery
    /// must not retry or promote.
    RecordedRejection,
    /// The existing effect's external state is unresolved. A reconciler must
    /// observe it; no new promotion attempt may be issued from this result.
    ReconciliationRequired,
    /// Evidence is missing, malformed, substituted, or unsupported.
    Blocked,
}

/// Closed reasons why a promotion recovery classification cannot reuse a
/// result. None of these reasons authorize a fresh effect.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromotionRecoveryBlockReasonV1 {
    UnsupportedSchemaVersion,
    MalformedQuery,
    SnapshotRunMismatch,
    WorkflowNotFound,
    WorkflowIdentityMismatch,
    UnsupportedDispatch,
    CandidateMissing,
    CandidateIdentityMismatch,
    PromotionNotFound,
    PromotionIdentityMismatch,
    MissingDecisionDigest,
    ResultIdentityMismatch,
    MissingResultDigest,
    ReconciliationIdentityMismatch,
    MissingReconciliationDigest,
    PromotionResultMissing,
    RecordedPromotionReconciliationRequired,
    ContradictoryPromotionEvidence,
}

/// Immutable recorded promotion result returned only as replay evidence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordedPromotionResultV1 {
    pub promotion_result_event_ref: String,
    pub promotion_result_event_digest: String,
    pub outcome: PromotionResultOutcomeV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged_head_sha: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub promotion_receipt_ref: Option<String>,
    pub completed_at: String,
}

/// Immutable operator reconciliation evidence for a recorded promotion result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordedPromotionReconciliationV1 {
    pub promotion_reconciliation_event_ref: String,
    pub promotion_reconciliation_event_digest: String,
    pub outcome: ReconciliationResolutionOutcomeV1,
    pub promotion_receipt_ref: String,
    pub resolved_at: String,
}

/// Closed, versioned output from
/// [`TrustedGovernedRecoverySnapshot::classify_recorded_governed_promotion_recovery_v1`].
///
/// It deliberately has no retry, issue, promote, or action-request field.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordedPromotionRecoveryDecisionV1 {
    pub schema_version: u16,
    pub identity: RecordedPromotionRecoveryIdentityV1,
    pub disposition: PromotionRecoveryDispositionV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<RecordedPromotionResultV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reconciliation: Option<RecordedPromotionReconciliationV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<PromotionRecoveryBlockReasonV1>,
}

/// A recovery authority snapshot built only from a fully verified tape.
///
/// Its fields are private on purpose. Callers receive immutable references to
/// workflow projections and cannot mutate the state used to derive the
/// candidate or promotion indexes. This type provides no effect, lease, or
/// transition APIs.
#[derive(Debug)]
pub struct TrustedGovernedRecoverySnapshot {
    run_id: String,
    pinned_kernel_signer: ActorKeyRef,
    tape_integrity: TapeIntegrityReportV1,
    workflows_by_dispatch_event_ref: BTreeMap<String, WorkflowInstanceV1>,
    candidate_dispatch_index: BTreeMap<String, String>,
    promotion_dispatch_index: BTreeMap<PromotionIdentity, String>,
    /// Lookup-only index for one exact signed promotion decision. A caller
    /// still needs the ledger's sealed write-ahead claim before any effect.
    promotion_decision_dispatch_index: BTreeMap<String, String>,
}

impl TrustedGovernedRecoverySnapshot {
    /// Open, fully replay, and integrity-check one governed recovery tape.
    ///
    /// The whole replay is consumed before the root chain is verified, and
    /// both operations use the same immutable event snapshot loaded by
    /// [`ReplayEngine`]. A partial replay state can therefore never be paired
    /// with a full-tape integrity report.
    pub fn open(
        run_id: &str,
        db_path: impl AsRef<Path>,
        authorities: &TrustedReplayAuthorities,
        pinned_kernel_signer: &ActorKeyRef,
    ) -> Result<Self, TrustedGovernedRecoveryError> {
        if !authorities.permits(TrustSpineSignerRole::Kernel, pinned_kernel_signer) {
            return Err(
                TrustedGovernedRecoveryError::PinnedKernelSignerUnauthorized {
                    signer: pinned_kernel_signer.clone(),
                },
            );
        }

        let mut replay = ReplayEngine::open_with_trusted_authorities(run_id, db_path, authorities)?;
        for _ in replay.by_ref() {}
        reject_governed_replay_issues(replay.state().issues.as_slice())?;

        // Never expose a projection until the same tape snapshot that formed
        // it has a pinned-kernel checkpoint chain covering every signed tail.
        let tape_integrity =
            verify_full_tape_integrity_v1(replay.verified_events(), run_id, pinned_kernel_signer)?;

        Self::from_verified_replay(
            run_id,
            pinned_kernel_signer.clone(),
            tape_integrity,
            replay.state().workflow_instances.values(),
        )
    }

    /// The run whose full tape was verified for this snapshot.
    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    /// The host-pinned kernel signer that authenticated the checkpoint chain.
    pub fn pinned_kernel_signer(&self) -> &ActorKeyRef {
        &self.pinned_kernel_signer
    }

    /// Full-prefix tape-root evidence for this immutable recovery view.
    pub fn tape_integrity(&self) -> &TapeIntegrityReportV1 {
        &self.tape_integrity
    }

    /// Project this already verified recovery snapshot as redacted,
    /// evidence-only OpenTelemetry facts.
    ///
    /// There is intentionally no free projector taking caller facts, replay
    /// state, JSON, or raw tape data. This snapshot exists only after
    /// [`Self::open`] has exhausted trusted replay and verified the same
    /// immutable tape's complete checkpoint chain. The result carries no
    /// action, promotion, receipt, or export authority.
    ///
    /// # Errors
    ///
    /// Returns a closed error when a verified RFC3339 timestamp cannot be
    /// represented as an OpenTelemetry `i64` nanosecond timestamp. The error
    /// contains no timestamp or raw replay facts.
    pub fn verified_otel_projection_v1(
        &self,
    ) -> Result<VerifiedOtelProjectionV1, VerifiedOtelProjectionErrorV1> {
        crate::otel_projection::project_verified_snapshot_v1(
            &self.tape_integrity,
            self.workflows_by_dispatch_event_ref.values(),
        )
    }

    /// Find an exact governed recovery workflow by its signed dispatch event.
    ///
    /// Historical sealed V3 workflows remain eligible without a graph. A V4
    /// workflow is eligible only after trusted replay projected both pieces of
    /// the exact V2 graph binding; transitions write those fields only after
    /// they validate the declaration event reference and graph digest.
    pub fn workflow_for_dispatch_event_ref(
        &self,
        dispatch_event_ref: &str,
    ) -> Option<&WorkflowInstanceV1> {
        self.workflows_by_dispatch_event_ref.get(dispatch_event_ref)
    }

    /// Find an exact immutable candidate by its tape-derived digest.
    pub fn workflow_for_candidate_digest(
        &self,
        candidate_digest: &str,
    ) -> Option<&WorkflowInstanceV1> {
        self.candidate_dispatch_index
            .get(candidate_digest)
            .and_then(|dispatch_event_ref| {
                self.workflows_by_dispatch_event_ref.get(dispatch_event_ref)
            })
    }

    /// Find an exact promotion only when both its candidate digest and
    /// idempotency key match tape-derived decision evidence.
    pub fn workflow_for_promotion_identity(
        &self,
        candidate_digest: &str,
        idempotency_key: &str,
    ) -> Option<&WorkflowInstanceV1> {
        self.promotion_dispatch_index
            .get(&PromotionIdentity {
                candidate_digest: candidate_digest.to_string(),
                idempotency_key: idempotency_key.to_string(),
            })
            .and_then(|dispatch_event_ref| {
                self.workflows_by_dispatch_event_ref.get(dispatch_event_ref)
            })
    }

    /// Find the one workflow containing an exact signed promotion decision.
    ///
    /// This is a read-only recovery query, not promotion authority. A
    /// `promote` decision returned here remains insufficient to mutate a
    /// target ref without a sealed ledger execution claim.
    pub fn workflow_for_promotion_decision_event_ref(
        &self,
        promotion_decision_event_ref: &str,
    ) -> Option<&WorkflowInstanceV1> {
        self.promotion_decision_dispatch_index
            .get(promotion_decision_event_ref)
            .and_then(|dispatch_event_ref| {
                self.workflows_by_dispatch_event_ref.get(dispatch_event_ref)
            })
    }

    /// Classify an already-recorded governed action from this fully verified
    /// tape snapshot.
    ///
    /// The snapshot was built only after complete signed replay and tape-root
    /// verification. This method is therefore the public recovery entrypoint
    /// for a future authority service. It has no effect-issuance capability:
    /// absent, stale, malformed, or unsupported evidence always returns a
    /// blocked/reconciliation/failure decision rather than a new lease.
    pub fn classify_recorded_governed_action_v1(
        &self,
        query: &RecordedActionDecisionQueryV1,
    ) -> RecordedActionDecisionV1 {
        if query.schema_version != RECORDED_ACTION_DECISION_SCHEMA_VERSION_V1 {
            return blocked(query, ActionDecisionBlockReasonV1::UnsupportedSchemaVersion);
        }
        if !query_is_well_formed(query) {
            return blocked(query, ActionDecisionBlockReasonV1::MalformedQuery);
        }
        if query.identity.run_id != self.run_id {
            return blocked(query, ActionDecisionBlockReasonV1::SnapshotRunMismatch);
        }
        let Some(workflow) = self
            .workflows_by_dispatch_event_ref
            .get(&query.identity.dispatch_event_ref)
        else {
            return blocked(query, ActionDecisionBlockReasonV1::WorkflowNotFound);
        };
        classify_replayed_governed_action_v1(workflow, query)
    }

    /// Classify only immutable promotion evidence from this fully verified
    /// tape snapshot.
    ///
    /// This is deliberately a recovery observation, not a promotion API. In
    /// particular, a recorded `promote` decision without a terminal result is
    /// classified as reconciliation-required: it can never be retried or
    /// treated as authority to mutate the target branch.
    pub fn classify_recorded_governed_promotion_recovery_v1(
        &self,
        query: &RecordedPromotionRecoveryQueryV1,
    ) -> RecordedPromotionRecoveryDecisionV1 {
        if query.schema_version != RECORDED_PROMOTION_RECOVERY_SCHEMA_VERSION_V1 {
            return promotion_blocked(
                query,
                PromotionRecoveryBlockReasonV1::UnsupportedSchemaVersion,
            );
        }
        if !promotion_recovery_query_is_well_formed(query) {
            return promotion_blocked(query, PromotionRecoveryBlockReasonV1::MalformedQuery);
        }
        if query.identity.run_id != self.run_id {
            return promotion_blocked(query, PromotionRecoveryBlockReasonV1::SnapshotRunMismatch);
        }
        let Some(workflow) = self
            .workflows_by_dispatch_event_ref
            .get(&query.identity.dispatch_event_ref)
        else {
            return promotion_blocked(query, PromotionRecoveryBlockReasonV1::WorkflowNotFound);
        };
        classify_replayed_governed_promotion_recovery_v1(workflow, query)
    }

    fn from_verified_replay<'a>(
        run_id: &str,
        pinned_kernel_signer: ActorKeyRef,
        tape_integrity: TapeIntegrityReportV1,
        workflows: impl Iterator<Item = &'a WorkflowInstanceV1>,
    ) -> Result<Self, TrustedGovernedRecoveryError> {
        let mut workflows_by_dispatch_event_ref = BTreeMap::new();
        let mut candidate_dispatch_index = BTreeMap::new();
        let mut promotion_dispatch_index = BTreeMap::new();
        let mut promotion_decision_dispatch_index = BTreeMap::new();

        for workflow in workflows.filter(|workflow| is_trusted_governed_recovery_workflow(workflow))
        {
            let dispatch_event_ref = workflow.dispatch.event_id.to_string();
            if let Some(candidate) = workflow.candidate.as_ref() {
                if let Some(first_dispatch_event_ref) = candidate_dispatch_index.insert(
                    candidate.candidate_digest.clone(),
                    dispatch_event_ref.clone(),
                ) {
                    return Err(TrustedGovernedRecoveryError::CandidateIdentityConflict {
                        candidate_digest: candidate.candidate_digest.clone(),
                        first_dispatch_event_ref,
                        conflicting_dispatch_event_ref: dispatch_event_ref,
                    });
                }
            }

            if let Some(promotion) = workflow.promotion.as_ref() {
                let candidate = workflow.candidate.as_ref().ok_or_else(|| {
                    TrustedGovernedRecoveryError::PromotionCandidateConflict {
                        candidate_digest: promotion.decision.candidate_digest.clone(),
                    }
                })?;
                if promotion.decision.candidate_digest != candidate.candidate_digest {
                    return Err(TrustedGovernedRecoveryError::PromotionCandidateConflict {
                        candidate_digest: promotion.decision.candidate_digest.clone(),
                    });
                }
                let identity = PromotionIdentity {
                    candidate_digest: promotion.decision.candidate_digest.clone(),
                    idempotency_key: promotion.decision.idempotency_key.clone(),
                };
                if let Some(first_dispatch_event_ref) =
                    promotion_dispatch_index.insert(identity.clone(), dispatch_event_ref.clone())
                {
                    return Err(TrustedGovernedRecoveryError::PromotionIdentityConflict {
                        candidate_digest: identity.candidate_digest,
                        idempotency_key: identity.idempotency_key,
                        first_dispatch_event_ref,
                        conflicting_dispatch_event_ref: dispatch_event_ref,
                    });
                }
                if let Some(first_dispatch_event_ref) = promotion_decision_dispatch_index.insert(
                    promotion.decision.event_id.to_string(),
                    dispatch_event_ref.clone(),
                ) {
                    return Err(TrustedGovernedRecoveryError::PromotionIdentityConflict {
                        candidate_digest: identity.candidate_digest,
                        idempotency_key: identity.idempotency_key,
                        first_dispatch_event_ref,
                        conflicting_dispatch_event_ref: dispatch_event_ref,
                    });
                }
            }

            workflows_by_dispatch_event_ref.insert(dispatch_event_ref, workflow.clone());
        }

        if workflows_by_dispatch_event_ref.is_empty() {
            return Err(TrustedGovernedRecoveryError::NoSealedV3GovernedWorkflow);
        }

        Ok(Self {
            run_id: run_id.to_string(),
            pinned_kernel_signer,
            tape_integrity,
            workflows_by_dispatch_event_ref,
            candidate_dispatch_index,
            promotion_dispatch_index,
            promotion_decision_dispatch_index,
        })
    }
}

/// Pure, read-only classifier for promotion evidence projected by a fully
/// verified [`TrustedGovernedRecoverySnapshot`]. Keeping it crate-private
/// prevents callers with an arbitrary replay projection from treating a state
/// snapshot as governed recovery authority.
fn classify_replayed_governed_promotion_recovery_v1(
    workflow: &WorkflowInstanceV1,
    query: &RecordedPromotionRecoveryQueryV1,
) -> RecordedPromotionRecoveryDecisionV1 {
    if query.schema_version != RECORDED_PROMOTION_RECOVERY_SCHEMA_VERSION_V1 {
        return promotion_blocked(
            query,
            PromotionRecoveryBlockReasonV1::UnsupportedSchemaVersion,
        );
    }
    if !promotion_recovery_query_is_well_formed(query) {
        return promotion_blocked(query, PromotionRecoveryBlockReasonV1::MalformedQuery);
    }
    if !promotion_workflow_identity_matches_query(workflow, query) {
        return promotion_blocked(
            query,
            PromotionRecoveryBlockReasonV1::WorkflowIdentityMismatch,
        );
    }
    if !is_trusted_governed_recovery_workflow(workflow) {
        return promotion_blocked(query, PromotionRecoveryBlockReasonV1::UnsupportedDispatch);
    }

    let Some(candidate) = workflow.candidate.as_ref() else {
        return promotion_blocked(query, PromotionRecoveryBlockReasonV1::CandidateMissing);
    };
    if candidate.candidate_digest != query.identity.candidate_digest
        || candidate.envelope_digest != workflow.dispatch.envelope_digest
    {
        return promotion_blocked(
            query,
            PromotionRecoveryBlockReasonV1::CandidateIdentityMismatch,
        );
    }

    let Some(promotion) = workflow.promotion.as_ref() else {
        return promotion_blocked(query, PromotionRecoveryBlockReasonV1::PromotionNotFound);
    };
    let decision = &promotion.decision;
    if !is_canonical_sha256_digest(&decision.event_digest) {
        // Older snapshots intentionally decode with an empty value, but that
        // legacy display compatibility must never become recovery authority.
        return promotion_blocked(query, PromotionRecoveryBlockReasonV1::MissingDecisionDigest);
    }
    if !promotion_decision_identity_matches_query(decision, query)
        || decision.base_commit_sha != candidate.base_commit_sha
        || decision.envelope_digest != candidate.envelope_digest
    {
        return promotion_blocked(
            query,
            PromotionRecoveryBlockReasonV1::PromotionIdentityMismatch,
        );
    }

    let Some(result) = promotion.result.as_ref() else {
        return match decision.decision {
            // The write-ahead intent may have reached the external Git CAS
            // before the process crashed. Its absence is therefore an unknown
            // effect state, not permission to issue a second mutation.
            PromotionDecisionKindV1::Promote => promotion_reconciliation_required(
                query,
                None,
                PromotionRecoveryBlockReasonV1::PromotionResultMissing,
            ),
            PromotionDecisionKindV1::Reject => recorded_promotion_rejection(query, None, None),
        };
    };

    if !is_canonical_sha256_digest(&result.event_digest) {
        return promotion_blocked(query, PromotionRecoveryBlockReasonV1::MissingResultDigest);
    }
    if !promotion_result_identity_matches_decision(result, decision) {
        return promotion_blocked(
            query,
            PromotionRecoveryBlockReasonV1::ResultIdentityMismatch,
        );
    }
    let recorded_result = recorded_promotion_result(result);
    if promoted_result_declares_unreconciled_checkout(result) {
        return promotion_reconciliation_required(
            query,
            Some(recorded_result),
            PromotionRecoveryBlockReasonV1::RecordedPromotionReconciliationRequired,
        );
    }
    if !promotion_result_evidence_is_well_formed(candidate, decision, result) {
        return promotion_blocked(
            query,
            PromotionRecoveryBlockReasonV1::ContradictoryPromotionEvidence,
        );
    }

    match (decision.decision, result.outcome) {
        (PromotionDecisionKindV1::Promote, PromotionResultOutcomeV1::Promoted) => {
            if promotion.reconciliation.is_some() {
                return promotion_blocked(
                    query,
                    PromotionRecoveryBlockReasonV1::ContradictoryPromotionEvidence,
                );
            }
            RecordedPromotionRecoveryDecisionV1 {
                schema_version: RECORDED_PROMOTION_RECOVERY_SCHEMA_VERSION_V1,
                identity: query.identity.clone(),
                disposition: PromotionRecoveryDispositionV1::ReuseRecordedPromotion,
                result: Some(recorded_result),
                reconciliation: None,
                reason: None,
            }
        }
        (PromotionDecisionKindV1::Promote, PromotionResultOutcomeV1::ReconciliationRequired) => {
            classify_recorded_promotion_reconciliation(query, promotion, recorded_result)
        }
        (
            PromotionDecisionKindV1::Promote | PromotionDecisionKindV1::Reject,
            PromotionResultOutcomeV1::Rejected,
        ) => {
            if promotion.reconciliation.is_some() {
                return promotion_blocked(
                    query,
                    PromotionRecoveryBlockReasonV1::ContradictoryPromotionEvidence,
                );
            }
            recorded_promotion_rejection(query, Some(recorded_result), None)
        }
        (
            PromotionDecisionKindV1::Reject,
            PromotionResultOutcomeV1::Promoted | PromotionResultOutcomeV1::ReconciliationRequired,
        ) => promotion_blocked(
            query,
            PromotionRecoveryBlockReasonV1::ContradictoryPromotionEvidence,
        ),
    }
}

fn promoted_result_declares_unreconciled_checkout(
    result: &crate::state::PromotionResultReplayState,
) -> bool {
    result.outcome == PromotionResultOutcomeV1::Promoted
        && result
            .promotion_git_binding
            .as_ref()
            .and_then(|binding| binding.worktree_sync_state)
            .is_some()
}

fn promotion_recovery_query_is_well_formed(query: &RecordedPromotionRecoveryQueryV1) -> bool {
    let identity = &query.identity;
    query.schema_version == RECORDED_PROMOTION_RECOVERY_SCHEMA_VERSION_V1
        && identity.attempt > 0
        && strings_are_non_empty([
            &identity.run_id,
            &identity.workflow_id,
            &identity.workflow_revision,
            &identity.unit_id,
            &identity.dispatch_event_ref,
            &identity.promotion_decision_event_ref,
            &identity.idempotency_key,
        ])
        && is_canonical_sha256_digest(&identity.dispatch_envelope_digest)
        && is_canonical_sha256_digest(&identity.candidate_digest)
        && is_canonical_sha256_digest(&identity.promotion_decision_event_digest)
}

fn promotion_workflow_identity_matches_query(
    workflow: &WorkflowInstanceV1,
    query: &RecordedPromotionRecoveryQueryV1,
) -> bool {
    let identity = &query.identity;
    workflow.run_id == identity.run_id
        && workflow.workflow_id == identity.workflow_id
        && workflow.workflow_revision == identity.workflow_revision
        && workflow.unit_id == identity.unit_id
        && workflow.attempt == identity.attempt
        && workflow.dispatch.event_id.to_string() == identity.dispatch_event_ref
        && workflow.dispatch.envelope_digest == identity.dispatch_envelope_digest
}

fn promotion_decision_identity_matches_query(
    decision: &crate::state::PromotionDecisionReplayState,
    query: &RecordedPromotionRecoveryQueryV1,
) -> bool {
    decision.event_id.to_string() == query.identity.promotion_decision_event_ref
        && decision.event_digest == query.identity.promotion_decision_event_digest
        && decision.candidate_digest == query.identity.candidate_digest
        && decision.idempotency_key == query.identity.idempotency_key
}

fn promotion_result_identity_matches_decision(
    result: &crate::state::PromotionResultReplayState,
    decision: &crate::state::PromotionDecisionReplayState,
) -> bool {
    result.candidate_digest == decision.candidate_digest
        && result.idempotency_key == decision.idempotency_key
        && result.promotion_decision_ref == decision.event_id.to_string()
}

fn promotion_result_evidence_is_well_formed(
    candidate: &crate::state::CandidateArtifactReplayState,
    decision: &crate::state::PromotionDecisionReplayState,
    result: &crate::state::PromotionResultReplayState,
) -> bool {
    if !is_rfc3339_utc(&result.completed_at) {
        return false;
    }
    match result.outcome {
        PromotionResultOutcomeV1::Promoted | PromotionResultOutcomeV1::ReconciliationRequired => {
            let Some(merged_head_sha) = result.merged_head_sha.as_deref() else {
                return false;
            };
            let Some(binding) = result.promotion_git_binding.as_ref() else {
                return false;
            };
            let Some(target_ref) = decision.target_ref.as_deref() else {
                return false;
            };
            let Some(target_head_after_sha) = binding.target_head_after_sha.as_deref() else {
                return false;
            };
            let Some(binding_merged_head_sha) = binding.merged_head_sha.as_deref() else {
                return false;
            };
            let Some(merge_parent_shas) = binding.merge_parent_shas.as_deref() else {
                return false;
            };
            let Some(merged_tree_sha) = binding.merged_tree_sha.as_deref() else {
                return false;
            };
            let Some(promotion_receipt_ref) = binding.promotion_receipt_ref.as_deref() else {
                return false;
            };
            let Some(worktree_sync_state) = binding.worktree_sync_state else {
                return false;
            };
            let expected_sync_state = match result.outcome {
                // A strict binding always reports a post-CAS checkout state;
                // none of those states proves the root checkout reconciled.
                PromotionResultOutcomeV1::Promoted => false,
                PromotionResultOutcomeV1::ReconciliationRequired => matches!(
                    worktree_sync_state,
                    bp_ledger::payload::trust_spine::PromotionWorktreeSyncStateV1::RootCheckoutStale
                        | bp_ledger::payload::trust_spine::PromotionWorktreeSyncStateV1::TargetAdvanced
                ),
                PromotionResultOutcomeV1::Rejected => false,
            };
            is_canonical_target_ref(target_ref)
                && binding.target_ref == target_ref
                && binding.target_head_before_sha == decision.base_commit_sha
                && binding.target_head_before_sha == candidate.base_commit_sha
                && is_canonical_git_object_id(&binding.target_head_before_sha)
                && is_canonical_git_object_id(target_head_after_sha)
                && binding_merged_head_sha == merged_head_sha
                && is_canonical_git_object_id(binding_merged_head_sha)
                && binding.candidate_commit_sha == candidate.candidate_commit_sha
                && is_canonical_git_object_id(&binding.candidate_commit_sha)
                && merge_parent_shas.len() == 2
                && merge_parent_shas[0] == binding.target_head_before_sha
                && merge_parent_shas[1] == binding.candidate_commit_sha
                && merge_parent_shas
                    .iter()
                    .all(|sha| is_canonical_git_object_id(sha))
                && is_canonical_git_object_id(merged_tree_sha)
                && binding.merged_tree_digest == candidate.tree_digest
                && is_canonical_sha256_digest(&binding.merged_tree_digest)
                && promotion_receipt_ref_matches_candidate(promotion_receipt_ref, &candidate.candidate_ref)
                && expected_sync_state
                && match worktree_sync_state {
                    bp_ledger::payload::trust_spine::PromotionWorktreeSyncStateV1::PendingReconciliation
                    | bp_ledger::payload::trust_spine::PromotionWorktreeSyncStateV1::RootCheckoutStale => {
                        target_head_after_sha == merged_head_sha
                    }
                    bp_ledger::payload::trust_spine::PromotionWorktreeSyncStateV1::TargetAdvanced => {
                        target_head_after_sha != merged_head_sha
                    }
                }
        }
        PromotionResultOutcomeV1::Rejected => {
            result.merged_head_sha.is_none() && result.promotion_git_binding.is_none()
        }
    }
}

fn classify_recorded_promotion_reconciliation(
    query: &RecordedPromotionRecoveryQueryV1,
    promotion: &crate::state::PromotionReplayState,
    recorded_result: RecordedPromotionResultV1,
) -> RecordedPromotionRecoveryDecisionV1 {
    let result = promotion
        .result
        .as_ref()
        .expect("caller supplies a recorded promotion result");
    let Some(reconciliation) = promotion.reconciliation.as_ref() else {
        return promotion_reconciliation_required(
            query,
            Some(recorded_result),
            PromotionRecoveryBlockReasonV1::RecordedPromotionReconciliationRequired,
        );
    };
    if !is_canonical_sha256_digest(&reconciliation.event_digest) {
        return promotion_blocked(
            query,
            PromotionRecoveryBlockReasonV1::MissingReconciliationDigest,
        );
    }
    let Some(promotion_receipt_ref) = recorded_result.promotion_receipt_ref.as_deref() else {
        return promotion_blocked(
            query,
            PromotionRecoveryBlockReasonV1::ContradictoryPromotionEvidence,
        );
    };
    if !promotion_reconciliation_identity_matches(
        reconciliation,
        &promotion.decision,
        result,
        promotion_receipt_ref,
    ) {
        return promotion_blocked(
            query,
            PromotionRecoveryBlockReasonV1::ReconciliationIdentityMismatch,
        );
    }

    RecordedPromotionRecoveryDecisionV1 {
        schema_version: RECORDED_PROMOTION_RECOVERY_SCHEMA_VERSION_V1,
        identity: query.identity.clone(),
        disposition: PromotionRecoveryDispositionV1::RecordedRejection,
        result: Some(recorded_result),
        reconciliation: Some(RecordedPromotionReconciliationV1 {
            promotion_reconciliation_event_ref: reconciliation.event_id.to_string(),
            promotion_reconciliation_event_digest: reconciliation.event_digest.clone(),
            outcome: reconciliation.outcome,
            promotion_receipt_ref: reconciliation.promotion_receipt_ref.clone(),
            resolved_at: reconciliation.resolved_at.clone(),
        }),
        reason: None,
    }
}

fn promotion_reconciliation_identity_matches(
    reconciliation: &crate::state::PromotionReconciliationReplayState,
    decision: &crate::state::PromotionDecisionReplayState,
    result: &crate::state::PromotionResultReplayState,
    promotion_receipt_ref: &str,
) -> bool {
    reconciliation.candidate_digest == decision.candidate_digest
        && reconciliation.promotion_decision_ref == decision.event_id.to_string()
        && reconciliation.promotion_result_ref == result.event_id.to_string()
        && reconciliation.promotion_receipt_ref == promotion_receipt_ref
        && !reconciliation.authority.trim().is_empty()
        && reconciliation.authority == reconciliation.resolved_by
        && !reconciliation.idempotency_key.trim().is_empty()
        && is_rfc3339_utc(&reconciliation.resolved_at)
}

fn recorded_promotion_result(
    result: &crate::state::PromotionResultReplayState,
) -> RecordedPromotionResultV1 {
    RecordedPromotionResultV1 {
        promotion_result_event_ref: result.event_id.to_string(),
        promotion_result_event_digest: result.event_digest.clone(),
        outcome: result.outcome,
        merged_head_sha: result.merged_head_sha.clone(),
        promotion_receipt_ref: result
            .promotion_git_binding
            .as_ref()
            .and_then(|binding| binding.promotion_receipt_ref.clone()),
        completed_at: result.completed_at.clone(),
    }
}

fn promotion_reconciliation_required(
    query: &RecordedPromotionRecoveryQueryV1,
    result: Option<RecordedPromotionResultV1>,
    reason: PromotionRecoveryBlockReasonV1,
) -> RecordedPromotionRecoveryDecisionV1 {
    RecordedPromotionRecoveryDecisionV1 {
        schema_version: RECORDED_PROMOTION_RECOVERY_SCHEMA_VERSION_V1,
        identity: query.identity.clone(),
        disposition: PromotionRecoveryDispositionV1::ReconciliationRequired,
        result,
        reconciliation: None,
        reason: Some(reason),
    }
}

fn recorded_promotion_rejection(
    query: &RecordedPromotionRecoveryQueryV1,
    result: Option<RecordedPromotionResultV1>,
    reconciliation: Option<RecordedPromotionReconciliationV1>,
) -> RecordedPromotionRecoveryDecisionV1 {
    RecordedPromotionRecoveryDecisionV1 {
        schema_version: RECORDED_PROMOTION_RECOVERY_SCHEMA_VERSION_V1,
        identity: query.identity.clone(),
        disposition: PromotionRecoveryDispositionV1::RecordedRejection,
        result,
        reconciliation,
        reason: None,
    }
}

fn promotion_blocked(
    query: &RecordedPromotionRecoveryQueryV1,
    reason: PromotionRecoveryBlockReasonV1,
) -> RecordedPromotionRecoveryDecisionV1 {
    RecordedPromotionRecoveryDecisionV1 {
        schema_version: RECORDED_PROMOTION_RECOVERY_SCHEMA_VERSION_V1,
        identity: query.identity.clone(),
        disposition: PromotionRecoveryDispositionV1::Blocked,
        result: None,
        reconciliation: None,
        reason: Some(reason),
    }
}

fn strings_are_non_empty<T: AsRef<str>>(values: impl IntoIterator<Item = T>) -> bool {
    values
        .into_iter()
        .all(|value| !value.as_ref().trim().is_empty())
}

fn is_canonical_sha256_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value.as_bytes()[7..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn is_canonical_git_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_canonical_target_ref(value: &str) -> bool {
    let Some(branch) = value.strip_prefix("refs/heads/") else {
        return false;
    };
    if branch.is_empty()
        || branch.ends_with('/')
        || branch.ends_with('.')
        || branch.ends_with(".lock")
        || branch.contains("..")
        || branch.contains("//")
        || branch.contains("@{")
    {
        return false;
    }
    branch.split('/').all(|component| {
        !component.is_empty()
            && !component.starts_with('.')
            && !component.ends_with('.')
            && component != "@"
            && component.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '@')
            })
    })
}

fn promotion_receipt_ref_matches_candidate(receipt_ref: &str, candidate_ref: &str) -> bool {
    if !is_canonical_buildplane_candidate_ref(candidate_ref) {
        return false;
    }
    let Some(candidate_suffix) = candidate_ref.strip_prefix(BUILDPANE_CANDIDATE_REF_PREFIX) else {
        return false;
    };
    receipt_ref == format!("refs/buildplane/promotions/{candidate_suffix}")
}

fn is_rfc3339_utc(value: &str) -> bool {
    value.ends_with('Z') && DateTime::parse_from_rfc3339(value).is_ok()
}

fn is_trusted_governed_recovery_workflow(workflow: &WorkflowInstanceV1) -> bool {
    let dispatch = &workflow.dispatch;
    let required_digests = [
        &dispatch.envelope_digest,
        &dispatch.capability_bundle_digest,
        &dispatch.acceptance_contract_digest,
        &dispatch.context_manifest_digest,
        &dispatch.worker_manifest_digest,
        &dispatch.sandbox_profile_digest,
    ];
    let timestamps_are_well_formed = match (
        DateTime::parse_from_rfc3339(&dispatch.issued_at),
        DateTime::parse_from_rfc3339(&dispatch.expires_at),
    ) {
        (Ok(issued_at), Ok(expires_at)) => {
            dispatch.issued_at.ends_with('Z')
                && dispatch.expires_at.ends_with('Z')
                && issued_at < expires_at
        }
        _ => false,
    };
    let sealed_governed_authority = dispatch.trust_tier == TrustTierV1::Governed
        && dispatch.commit_mode == CommitModeV1::Atomic
        && dispatch.action_evidence_version == Some(ActionEvidenceVersionV1::SealedV3)
        && required_digests
            .iter()
            .all(|digest| is_canonical_sha256_digest(digest))
        && dispatch
            .repository_binding_digest
            .as_deref()
            .is_some_and(is_canonical_sha256_digest)
        && dispatch
            .ledger_authority_realm_digest
            .as_deref()
            .is_some_and(is_canonical_sha256_digest)
        && dispatch
            .governed_packet_digest
            .as_deref()
            .is_some_and(is_canonical_sha256_digest)
        && strings_are_non_empty([
            &workflow.run_id,
            &workflow.workflow_id,
            &workflow.workflow_revision,
            &workflow.unit_id,
            &dispatch.provenance_ref,
            &dispatch.idempotency_key,
        ])
        && workflow.attempt > 0
        && is_canonical_git_object_id(&dispatch.base_commit_sha)
        && timestamps_are_well_formed;
    if !sealed_governed_authority {
        return false;
    }

    match dispatch.dispatch_version {
        // V3 had no graph contract. Its historical recovery semantics remain
        // intentionally unchanged.
        3 => true,
        // A V4 state projection is created only after `validate_v4_graph_binding`
        // succeeds in trusted replay. Require both persisted witnesses here so
        // an incomplete/migrated projection cannot be mistaken for graph-bound
        // recovery authority.
        4 => {
            dispatch.workflow_graph_digest.is_some()
                && dispatch
                    .workflow_graph_digest
                    .as_deref()
                    .is_some_and(is_canonical_sha256_digest)
                && dispatch
                    .workflow_graph_declaration_event_ref
                    .as_ref()
                    .is_some_and(|event_ref| !event_ref.to_string().trim().is_empty())
        }
        _ => false,
    }
}

fn reject_governed_replay_issues(
    issues: &[ReplayIssue],
) -> Result<(), TrustedGovernedRecoveryError> {
    let Some(issue) = issues.iter().find(|issue| {
        matches!(
            issue,
            ReplayIssue::ActivityTransitionRejected { .. }
                | ReplayIssue::UnverifiedTrustSpineEvent { .. }
                | ReplayIssue::UnauthorizedTrustSpineSigner { .. }
                | ReplayIssue::WorkflowTransitionRejected { .. }
        )
    }) else {
        return Ok(());
    };
    Err(TrustedGovernedRecoveryError::ReplayIssue {
        issue: issue.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity_decision::{
        ActionDecisionBlockReasonV1, RecordedActionDecisionQueryV1, RecordedActionIdentityV1,
        RECORDED_ACTION_DECISION_SCHEMA_VERSION_V1,
    };
    use crate::state::{
        CandidateArtifactReplayState, PromotionDecisionReplayState,
        PromotionReconciliationReplayState, PromotionReplayState, PromotionResultReplayState,
        WorkflowDispatchReplayState, WorkflowPhaseV1,
    };
    use bp_ledger::id::EventId;
    use bp_ledger::payload::checkpoint::TapeRootAlgorithm;
    use bp_ledger::payload::trust_spine::{
        ActionEvidenceVersionV1, DispatchBudgetV1, ExecutionRoleV1, PromotionDecisionKindV1,
        PromotionGitBindingV1, PromotionResultOutcomeV1, PromotionWorktreeSyncStateV1,
        ReconciliationResolutionOutcomeV1,
    };

    const DIGEST_A: &str =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const DIGEST_B: &str =
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn kernel() -> ActorKeyRef {
        ActorKeyRef {
            actor_id: "kernel".into(),
            key_id: "kernel-main".into(),
            public_key_hash: Some("sha256:kernel".into()),
        }
    }

    fn integrity() -> TapeIntegrityReportV1 {
        TapeIntegrityReportV1 {
            schema_version: 1,
            checkpoint_event_ref: "checkpoint:1".into(),
            checkpoint_event_digest: DIGEST_A.into(),
            through_event_ref: "event:1".into(),
            signed_non_checkpoint_event_count: 1,
            tape_root_hash: DIGEST_B.into(),
            algorithm: TapeRootAlgorithm::Sha256Linear,
        }
    }

    fn workflow(
        candidate_digest: &str,
        promotion_candidate_digest: Option<&str>,
    ) -> WorkflowInstanceV1 {
        let dispatch_event_id = EventId::new();
        WorkflowInstanceV1 {
            run_id: "run".into(),
            workflow_id: format!("workflow-{dispatch_event_id}"),
            workflow_revision: "r1".into(),
            unit_id: format!("unit-{dispatch_event_id}"),
            attempt: 1,
            phase: WorkflowPhaseV1::CandidateCreated,
            dispatch: WorkflowDispatchReplayState {
                dispatch_version: 3,
                event_id: dispatch_event_id,
                envelope_digest: DIGEST_A.into(),
                provenance_ref: "admission:1".into(),
                base_commit_sha: "1".repeat(40),
                repository_binding_digest: Some(DIGEST_A.into()),
                ledger_authority_realm_digest: Some(DIGEST_B.into()),
                governed_packet_digest: Some(DIGEST_A.into()),
                workflow_graph_digest: None,
                workflow_graph_declaration_event_ref: None,
                capability_bundle_digest: DIGEST_A.into(),
                acceptance_contract_digest: DIGEST_B.into(),
                context_manifest_digest: DIGEST_A.into(),
                worker_manifest_digest: DIGEST_B.into(),
                sandbox_profile_digest: DIGEST_A.into(),
                execution_role: ExecutionRoleV1::Implementer,
                commit_mode: CommitModeV1::Atomic,
                budget: DispatchBudgetV1 {
                    max_tokens: None,
                    max_compute_time_ms: None,
                },
                trust_tier: TrustTierV1::Governed,
                idempotency_key: format!("dispatch:{dispatch_event_id}"),
                issued_at: "2026-07-17T00:00:00Z".into(),
                expires_at: "2026-07-17T01:00:00Z".into(),
                signature_ref: None,
                action_evidence_version: Some(ActionEvidenceVersionV1::SealedV3),
            },
            action_evidence: None,
            retry_context: None,
            timers: BTreeMap::new(),
            cancellation: None,
            candidate: Some(CandidateArtifactReplayState {
                event_id: EventId::new(),
                candidate_id: format!("candidate-{dispatch_event_id}"),
                candidate_ref: format!("refs/buildplane/candidates/{dispatch_event_id}"),
                candidate_digest: candidate_digest.into(),
                base_commit_sha: "1".repeat(40),
                candidate_commit_sha: "2".repeat(40),
                commit_digest: DIGEST_A.into(),
                tree_digest: DIGEST_B.into(),
                patch_digest: DIGEST_A.into(),
                changed_files_digest: DIGEST_B.into(),
                envelope_digest: DIGEST_A.into(),
                action_receipt_digest: None,
                action_receipt_set_ref: Some("receipt-set:1".into()),
                action_receipt_set_digest: Some(DIGEST_B.into()),
            }),
            candidate_completion: None,
            acceptance: None,
            reviews: BTreeMap::new(),
            promotion_approval: None,
            promotion: promotion_candidate_digest.map(|promotion_candidate_digest| {
                PromotionReplayState {
                    decision: PromotionDecisionReplayState {
                        event_id: EventId::new(),
                        event_digest: DIGEST_B.into(),
                        candidate_digest: promotion_candidate_digest.into(),
                        base_commit_sha: "1".repeat(40),
                        target_ref: Some("refs/heads/main".into()),
                        envelope_digest: DIGEST_A.into(),
                        acceptance_ref: "acceptance:1".into(),
                        review_refs: vec!["review:1".into()],
                        promotion_approval_request_ref: None,
                        decision: PromotionDecisionKindV1::Promote,
                        authority: "operator".into(),
                        decided_by: "operator".into(),
                        decided_at: "2026-07-17T00:00:00Z".into(),
                        idempotency_key: "promotion:1".into(),
                    },
                    execution_claim: None,
                    result: None,
                    reconciliation: None,
                }
            }),
            terminal: None,
        }
    }

    fn promotion_query(workflow: &WorkflowInstanceV1) -> RecordedPromotionRecoveryQueryV1 {
        let candidate = workflow
            .candidate
            .as_ref()
            .expect("promotion recovery fixture has a candidate");
        let promotion = workflow
            .promotion
            .as_ref()
            .expect("promotion recovery fixture has a promotion decision");
        RecordedPromotionRecoveryQueryV1 {
            schema_version: RECORDED_PROMOTION_RECOVERY_SCHEMA_VERSION_V1,
            identity: RecordedPromotionRecoveryIdentityV1 {
                run_id: workflow.run_id.clone(),
                workflow_id: workflow.workflow_id.clone(),
                workflow_revision: workflow.workflow_revision.clone(),
                unit_id: workflow.unit_id.clone(),
                attempt: workflow.attempt,
                dispatch_event_ref: workflow.dispatch.event_id.to_string(),
                dispatch_envelope_digest: workflow.dispatch.envelope_digest.clone(),
                candidate_digest: candidate.candidate_digest.clone(),
                promotion_decision_event_ref: promotion.decision.event_id.to_string(),
                promotion_decision_event_digest: promotion.decision.event_digest.clone(),
                idempotency_key: promotion.decision.idempotency_key.clone(),
            },
        }
    }

    fn record_promotion_result(
        workflow: &mut WorkflowInstanceV1,
        outcome: PromotionResultOutcomeV1,
    ) {
        let candidate = workflow
            .candidate
            .as_ref()
            .expect("promotion result fixture has a candidate");
        let candidate_ref = candidate.candidate_ref.clone();
        let candidate_commit_sha = candidate.candidate_commit_sha.clone();
        let tree_digest = candidate.tree_digest.clone();
        let base_commit_sha = candidate.base_commit_sha.clone();
        let decision = &workflow
            .promotion
            .as_ref()
            .expect("promotion result fixture has a decision")
            .decision;
        let decision_ref = decision.event_id.to_string();
        let candidate_digest = decision.candidate_digest.clone();
        let idempotency_key = decision.idempotency_key.clone();
        let candidate_suffix = candidate_ref
            .strip_prefix(BUILDPANE_CANDIDATE_REF_PREFIX)
            .expect("fixture uses a canonical candidate ref");
        let merged_head_sha = "3".repeat(40);
        let worktree_sync_state = match outcome {
            PromotionResultOutcomeV1::Promoted => {
                PromotionWorktreeSyncStateV1::PendingReconciliation
            }
            PromotionResultOutcomeV1::ReconciliationRequired => {
                PromotionWorktreeSyncStateV1::TargetAdvanced
            }
            PromotionResultOutcomeV1::Rejected => {
                PromotionWorktreeSyncStateV1::PendingReconciliation
            }
        };
        let promotion_git_binding = match outcome {
            PromotionResultOutcomeV1::Promoted
            | PromotionResultOutcomeV1::ReconciliationRequired => Some(PromotionGitBindingV1 {
                target_ref: "refs/heads/main".into(),
                target_head_before_sha: base_commit_sha.clone(),
                target_head_after_sha: Some(match outcome {
                    PromotionResultOutcomeV1::Promoted => merged_head_sha.clone(),
                    PromotionResultOutcomeV1::ReconciliationRequired => "5".repeat(40),
                    PromotionResultOutcomeV1::Rejected => unreachable!("handled above"),
                }),
                merged_head_sha: Some(merged_head_sha.clone()),
                candidate_commit_sha,
                merge_parent_shas: Some(vec![base_commit_sha, "2".repeat(40)]),
                merged_tree_sha: Some("4".repeat(40)),
                merged_tree_digest: tree_digest,
                promotion_receipt_ref: Some(format!(
                    "refs/buildplane/promotions/{candidate_suffix}"
                )),
                worktree_sync_state: Some(worktree_sync_state),
            }),
            PromotionResultOutcomeV1::Rejected => None,
        };
        let promotion = workflow
            .promotion
            .as_mut()
            .expect("promotion result fixture has a decision");
        promotion.result = Some(PromotionResultReplayState {
            event_id: EventId::new(),
            event_digest: DIGEST_A.into(),
            candidate_digest,
            idempotency_key,
            promotion_decision_ref: decision_ref,
            outcome,
            merged_head_sha: match outcome {
                PromotionResultOutcomeV1::Rejected => None,
                PromotionResultOutcomeV1::Promoted
                | PromotionResultOutcomeV1::ReconciliationRequired => Some(merged_head_sha),
            },
            promotion_git_binding,
            promotion_execution_lease_binding: None,
            completed_at: "2026-07-17T00:00:00Z".into(),
        });
    }

    fn record_promotion_reconciliation(workflow: &mut WorkflowInstanceV1) {
        let candidate_digest = workflow
            .candidate
            .as_ref()
            .expect("reconciliation fixture has a candidate")
            .candidate_digest
            .clone();
        let promotion = workflow
            .promotion
            .as_ref()
            .expect("reconciliation fixture has a decision");
        let result = promotion
            .result
            .as_ref()
            .expect("reconciliation fixture has a result");
        let promotion_receipt_ref = result
            .promotion_git_binding
            .as_ref()
            .and_then(|binding| binding.promotion_receipt_ref.clone())
            .expect("reconciliation fixture has a receipt ref");
        let promotion_decision_ref = promotion.decision.event_id.to_string();
        let promotion_result_ref = result.event_id.to_string();
        workflow
            .promotion
            .as_mut()
            .expect("reconciliation fixture has a decision")
            .reconciliation = Some(PromotionReconciliationReplayState {
            event_id: EventId::new(),
            event_digest: DIGEST_B.into(),
            candidate_digest,
            promotion_decision_ref,
            promotion_result_ref,
            promotion_receipt_ref,
            outcome: ReconciliationResolutionOutcomeV1::Reject,
            authority: "operator".into(),
            resolved_by: "operator".into(),
            idempotency_key: "reconciliation:1".into(),
            resolved_at: "2026-07-17T00:00:00Z".into(),
        });
    }

    #[test]
    fn promotion_recovery_requires_reconciliation_for_a_recorded_promote_without_result() {
        let mut workflow = workflow(DIGEST_A, Some(DIGEST_A));
        workflow.phase = WorkflowPhaseV1::PromotionPending;
        let query = promotion_query(&workflow);
        let snapshot = TrustedGovernedRecoverySnapshot::from_verified_replay(
            "run",
            kernel(),
            integrity(),
            [&workflow].into_iter(),
        )
        .expect("fixture forms a trusted recovery snapshot");

        let decision = snapshot.classify_recorded_governed_promotion_recovery_v1(&query);

        assert_eq!(
            decision.disposition,
            PromotionRecoveryDispositionV1::ReconciliationRequired
        );
        assert_eq!(
            decision.reason,
            Some(PromotionRecoveryBlockReasonV1::PromotionResultMissing)
        );
        assert!(decision.result.is_none());
        assert!(decision.reconciliation.is_none());
    }

    #[test]
    fn promotion_recovery_blocks_substituted_or_legacy_decision_digest() {
        let primary_workflow = workflow(DIGEST_A, Some(DIGEST_A));
        let snapshot = TrustedGovernedRecoverySnapshot::from_verified_replay(
            "run",
            kernel(),
            integrity(),
            [&primary_workflow].into_iter(),
        )
        .expect("fixture forms a trusted recovery snapshot");
        let mut substituted_query = promotion_query(&primary_workflow);
        substituted_query.identity.promotion_decision_event_digest = DIGEST_A.into();

        let substituted =
            snapshot.classify_recorded_governed_promotion_recovery_v1(&substituted_query);

        assert_eq!(
            substituted.disposition,
            PromotionRecoveryDispositionV1::Blocked
        );
        assert_eq!(
            substituted.reason,
            Some(PromotionRecoveryBlockReasonV1::PromotionIdentityMismatch)
        );

        let mut legacy_workflow = workflow(DIGEST_A, Some(DIGEST_A));
        legacy_workflow
            .promotion
            .as_mut()
            .expect("fixture has a promotion")
            .decision
            .event_digest
            .clear();
        let mut legacy_query = promotion_query(&legacy_workflow);
        legacy_query.identity.promotion_decision_event_digest = DIGEST_B.into();
        let legacy_snapshot = TrustedGovernedRecoverySnapshot::from_verified_replay(
            "run",
            kernel(),
            integrity(),
            [&legacy_workflow].into_iter(),
        )
        .expect("legacy projection remains inspectable by the snapshot");

        let legacy =
            legacy_snapshot.classify_recorded_governed_promotion_recovery_v1(&legacy_query);

        assert_eq!(legacy.disposition, PromotionRecoveryDispositionV1::Blocked);
        assert_eq!(
            legacy.reason,
            Some(PromotionRecoveryBlockReasonV1::MissingDecisionDigest)
        );
    }

    #[test]
    fn promotion_recovery_treats_a_signed_reject_without_result_as_terminal() {
        let mut workflow = workflow(DIGEST_A, Some(DIGEST_A));
        workflow
            .promotion
            .as_mut()
            .expect("fixture has a promotion")
            .decision
            .decision = PromotionDecisionKindV1::Reject;
        workflow.phase = WorkflowPhaseV1::Rejected;
        let query = promotion_query(&workflow);
        let snapshot = TrustedGovernedRecoverySnapshot::from_verified_replay(
            "run",
            kernel(),
            integrity(),
            [&workflow].into_iter(),
        )
        .expect("fixture forms a trusted recovery snapshot");

        let decision = snapshot.classify_recorded_governed_promotion_recovery_v1(&query);

        assert_eq!(
            decision.disposition,
            PromotionRecoveryDispositionV1::RecordedRejection
        );
        assert!(decision.result.is_none());
        assert!(decision.reconciliation.is_none());
        assert!(decision.reason.is_none());
    }

    #[test]
    fn promotion_recovery_requires_reconciliation_for_a_pending_root_checkout() {
        let mut workflow = workflow(DIGEST_A, Some(DIGEST_A));
        record_promotion_result(&mut workflow, PromotionResultOutcomeV1::Promoted);
        workflow.phase = WorkflowPhaseV1::Promoted;
        let query = promotion_query(&workflow);
        let expected_result_ref = workflow
            .promotion
            .as_ref()
            .and_then(|promotion| promotion.result.as_ref())
            .expect("fixture recorded a result")
            .event_id
            .to_string();
        let snapshot = TrustedGovernedRecoverySnapshot::from_verified_replay(
            "run",
            kernel(),
            integrity(),
            [&workflow].into_iter(),
        )
        .expect("fixture forms a trusted recovery snapshot");

        let decision = snapshot.classify_recorded_governed_promotion_recovery_v1(&query);

        assert_eq!(
            decision.disposition,
            PromotionRecoveryDispositionV1::ReconciliationRequired
        );
        assert_eq!(
            decision
                .result
                .as_ref()
                .map(|result| result.promotion_result_event_ref.as_str()),
            Some(expected_result_ref.as_str())
        );
        assert!(decision.reconciliation.is_none());
        assert_eq!(
            decision.reason,
            Some(PromotionRecoveryBlockReasonV1::RecordedPromotionReconciliationRequired)
        );
    }

    #[test]
    fn promotion_recovery_blocks_a_promotion_receipt_bound_to_a_traversal_candidate_ref() {
        let mut workflow = workflow(DIGEST_A, Some(DIGEST_A));
        workflow
            .candidate
            .as_mut()
            .expect("fixture has a candidate")
            .candidate_ref = "refs/buildplane/candidates/../escape".into();
        record_promotion_result(
            &mut workflow,
            PromotionResultOutcomeV1::ReconciliationRequired,
        );
        let query = promotion_query(&workflow);
        let snapshot = TrustedGovernedRecoverySnapshot::from_verified_replay(
            "run",
            kernel(),
            integrity(),
            [&workflow].into_iter(),
        )
        .expect("fixture forms a trusted recovery snapshot");

        let decision = snapshot.classify_recorded_governed_promotion_recovery_v1(&query);

        assert_eq!(
            decision.disposition,
            PromotionRecoveryDispositionV1::Blocked
        );
        assert_eq!(
            decision.reason,
            Some(PromotionRecoveryBlockReasonV1::ContradictoryPromotionEvidence)
        );
    }

    #[test]
    fn promotion_recovery_never_reuses_a_reconciliation_required_result() {
        let mut workflow = workflow(DIGEST_A, Some(DIGEST_A));
        record_promotion_result(
            &mut workflow,
            PromotionResultOutcomeV1::ReconciliationRequired,
        );
        workflow.phase = WorkflowPhaseV1::PromotionReconciliationRequired;
        let query = promotion_query(&workflow);
        let snapshot = TrustedGovernedRecoverySnapshot::from_verified_replay(
            "run",
            kernel(),
            integrity(),
            [&workflow].into_iter(),
        )
        .expect("fixture forms a trusted recovery snapshot");

        let decision = snapshot.classify_recorded_governed_promotion_recovery_v1(&query);

        assert_eq!(
            decision.disposition,
            PromotionRecoveryDispositionV1::ReconciliationRequired
        );
        assert_eq!(
            decision.reason,
            Some(PromotionRecoveryBlockReasonV1::RecordedPromotionReconciliationRequired)
        );
        assert!(decision.result.is_some());
        assert!(decision.reconciliation.is_none());
    }

    #[test]
    fn promotion_recovery_records_a_bound_reconciliation_as_terminal_rejection() {
        let mut workflow = workflow(DIGEST_A, Some(DIGEST_A));
        record_promotion_result(
            &mut workflow,
            PromotionResultOutcomeV1::ReconciliationRequired,
        );
        record_promotion_reconciliation(&mut workflow);
        workflow.phase = WorkflowPhaseV1::PromotionReconciliationResolved;
        let query = promotion_query(&workflow);
        let snapshot = TrustedGovernedRecoverySnapshot::from_verified_replay(
            "run",
            kernel(),
            integrity(),
            [&workflow].into_iter(),
        )
        .expect("fixture forms a trusted recovery snapshot");

        let decision = snapshot.classify_recorded_governed_promotion_recovery_v1(&query);

        assert_eq!(
            decision.disposition,
            PromotionRecoveryDispositionV1::RecordedRejection
        );
        assert!(decision.result.is_some());
        assert_eq!(
            decision
                .reconciliation
                .as_ref()
                .map(|reconciliation| reconciliation.outcome),
            Some(ReconciliationResolutionOutcomeV1::Reject)
        );
    }

    #[test]
    fn candidate_and_promotion_indexes_bind_the_complete_identity() {
        let workflow = workflow(DIGEST_A, Some(DIGEST_A));
        let dispatch_event_ref = workflow.dispatch.event_id.to_string();
        let snapshot = TrustedGovernedRecoverySnapshot::from_verified_replay(
            "run",
            kernel(),
            integrity(),
            [&workflow].into_iter(),
        )
        .expect("unique tape-derived identities");

        assert_eq!(
            snapshot
                .workflow_for_candidate_digest(DIGEST_A)
                .map(|workflow| workflow.dispatch.event_id.to_string()),
            Some(dispatch_event_ref.clone())
        );
        assert!(snapshot.workflow_for_candidate_digest(DIGEST_B).is_none());
        assert_eq!(
            snapshot
                .workflow_for_promotion_identity(DIGEST_A, "promotion:1")
                .map(|workflow| workflow.dispatch.event_id.to_string()),
            Some(dispatch_event_ref)
        );
        assert!(snapshot
            .workflow_for_promotion_identity(DIGEST_A, "promotion:other")
            .is_none());
        assert!(snapshot
            .workflow_for_promotion_identity(DIGEST_B, "promotion:1")
            .is_none());
    }

    #[test]
    fn conflicting_candidate_or_promotion_evidence_cannot_form_an_index() {
        let first = workflow(DIGEST_A, None);
        let second = workflow(DIGEST_A, None);
        let candidate_error = TrustedGovernedRecoverySnapshot::from_verified_replay(
            "run",
            kernel(),
            integrity(),
            [&first, &second].into_iter(),
        )
        .expect_err("duplicate candidate digest must stay ambiguous");
        assert!(matches!(
            candidate_error,
            TrustedGovernedRecoveryError::CandidateIdentityConflict { .. }
        ));

        let mismatched_promotion = workflow(DIGEST_A, Some(DIGEST_B));
        let promotion_error = TrustedGovernedRecoverySnapshot::from_verified_replay(
            "run",
            kernel(),
            integrity(),
            [&mismatched_promotion].into_iter(),
        )
        .expect_err("promotion decision must bind the immutable candidate digest");
        assert!(matches!(
            promotion_error,
            TrustedGovernedRecoveryError::PromotionCandidateConflict { .. }
        ));
    }

    #[test]
    fn v4_workflow_with_both_graph_binding_witnesses_is_recovered() {
        let mut graph_bound = workflow(DIGEST_A, None);
        graph_bound.dispatch.dispatch_version = 4;
        graph_bound.dispatch.workflow_graph_digest = Some(DIGEST_B.into());
        graph_bound.dispatch.workflow_graph_declaration_event_ref = Some(EventId::new());
        let dispatch_event_ref = graph_bound.dispatch.event_id.to_string();

        let snapshot = TrustedGovernedRecoverySnapshot::from_verified_replay(
            "run",
            kernel(),
            integrity(),
            [&graph_bound].into_iter(),
        )
        .expect("a trusted replay-projected V4 binding is governed recovery authority");
        assert!(matches!(
            snapshot.workflow_for_dispatch_event_ref(&dispatch_event_ref),
            Some(workflow) if workflow.dispatch.dispatch_version == 4
        ));
    }

    #[test]
    fn v4_workflow_missing_a_graph_binding_witness_is_not_recovered() {
        let mut missing_digest = workflow(DIGEST_A, None);
        missing_digest.dispatch.dispatch_version = 4;
        missing_digest.dispatch.workflow_graph_declaration_event_ref = Some(EventId::new());

        let missing_digest_error = TrustedGovernedRecoverySnapshot::from_verified_replay(
            "run",
            kernel(),
            integrity(),
            [&missing_digest].into_iter(),
        )
        .expect_err("a V4 workflow without its graph digest must stay ineligible");
        assert!(matches!(
            missing_digest_error,
            TrustedGovernedRecoveryError::NoSealedV3GovernedWorkflow
        ));

        let mut missing_event_ref = workflow(DIGEST_A, None);
        missing_event_ref.dispatch.dispatch_version = 4;
        missing_event_ref.dispatch.workflow_graph_digest = Some(DIGEST_B.into());

        let missing_event_ref_error = TrustedGovernedRecoverySnapshot::from_verified_replay(
            "run",
            kernel(),
            integrity(),
            [&missing_event_ref].into_iter(),
        )
        .expect_err("a V4 workflow without its graph declaration ref must stay ineligible");
        assert!(matches!(
            missing_event_ref_error,
            TrustedGovernedRecoveryError::NoSealedV3GovernedWorkflow
        ));
    }

    #[test]
    fn recorded_action_decision_entrypoint_requires_the_snapshot_run_and_dispatch_identity() {
        let workflow = workflow(DIGEST_A, None);
        let dispatch_event_ref = workflow.dispatch.event_id.to_string();
        let snapshot = TrustedGovernedRecoverySnapshot::from_verified_replay(
            "run",
            kernel(),
            integrity(),
            [&workflow].into_iter(),
        )
        .expect("fixture forms a trusted recovery snapshot");
        let query = |run_id: &str, dispatch_event_ref: String| RecordedActionDecisionQueryV1 {
            schema_version: RECORDED_ACTION_DECISION_SCHEMA_VERSION_V1,
            identity: RecordedActionIdentityV1 {
                run_id: run_id.into(),
                workflow_id: workflow.workflow_id.clone(),
                workflow_revision: workflow.workflow_revision.clone(),
                unit_id: workflow.unit_id.clone(),
                attempt: workflow.attempt,
                dispatch_event_ref,
                dispatch_envelope_digest: DIGEST_A.into(),
                action_id: "action-1".into(),
                idempotency_key: "action-key-1".into(),
                action_request_event_ref: EventId::new().to_string(),
                action_request_digest: DIGEST_A.into(),
                activity_claim_event_ref: EventId::new().to_string(),
                activity_claim_event_digest: DIGEST_B.into(),
                lease_id: "lease-1".into(),
            },
            observed_at: "2026-07-17T00:00:00Z".into(),
        };

        let wrong_run = snapshot
            .classify_recorded_governed_action_v1(&query("other-run", dispatch_event_ref.clone()));
        assert_eq!(
            wrong_run.reason,
            Some(ActionDecisionBlockReasonV1::SnapshotRunMismatch)
        );

        let missing_dispatch = snapshot
            .classify_recorded_governed_action_v1(&query("run", EventId::new().to_string()));
        assert_eq!(
            missing_dispatch.reason,
            Some(ActionDecisionBlockReasonV1::WorkflowNotFound)
        );
    }
}
