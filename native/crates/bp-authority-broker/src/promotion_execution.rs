//! Private composition of sealed promotion claims, fixed Git, and result tape
//! records.
//!
//! This module is deliberately not a controller protocol. It is an internal
//! call-frame for a future OS-authenticated broker: replay is reopened before
//! a claim, the lease never leaves the broker, and a retry with an existing
//! claim cannot re-enter the Git gateway.

use crate::promotion_git::{
    PromotionGitError, PromotionGitGateway, PromotionGitOutcome, PromotionGitStartupError,
    VerifiedPromotionCapability,
};
use crate::LeasePolicy;
use bp_ledger::payload::trust_spine::{
    CommitModeV1, ExecutionRoleV1, PromotionDecisionKindV1, PromotionExecutionClaimedV1,
    PromotionExecutionLeaseBindingV1, PromotionGitBindingV1, PromotionResultOutcomeV1,
};
use bp_ledger::storage::sqlite::{
    GovernedPromotionAuthorityV1, GovernedPromotionExecutionClaimDispositionV1,
    GovernedPromotionExecutionClaimRequestV1, GovernedPromotionResultDispositionV1,
    GovernedPromotionResultRequestV1, SqliteStore,
};
use bp_ledger::{EventId, LedgerError, RunId};
use bp_replay::{
    TrustedGovernedRecoveryError, TrustedGovernedRecoverySnapshot, TrustedReplayAuthorities,
};
use ed25519_dalek::SigningKey;
use std::path::{Path, PathBuf};
use thiserror::Error;

/// The only controller-supplied promotion execution input. All candidate, Git,
/// target-ref, and idempotency facts are re-derived from the verified tape.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BrokerPromotionExecutionRequest {
    pub(crate) promotion_decision_event_id: EventId,
}

/// Controller-safe execution state. No variant contains a lease, Git command,
/// ref, workspace path, or capability that can be reused outside the broker.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BrokerPromotionExecutionStatus {
    Rejected,
    Pending,
    Recorded,
    LeaseExpired,
    ReconciliationRequired,
}

/// Tape facts needed to derive the fixed Git capability, returned only from a
/// fully checked recovery snapshot.
pub(crate) struct TrustedPromotionBinding {
    run_id: RunId,
    promotion_decision_event_id: EventId,
    promotion_decision_event_digest: String,
    dispatch_event_id: EventId,
    dispatch_envelope_digest: String,
    decision: PromotionDecisionKindV1,
    dispatch_role: ExecutionRoleV1,
    commit_mode: CommitModeV1,
    candidate_digest: String,
    candidate_ref: String,
    candidate_commit_sha: String,
    candidate_tree_digest: String,
    base_commit_sha: String,
    target_ref: String,
    idempotency_key: String,
    has_existing_claim: bool,
}

#[cfg(test)]
impl TrustedPromotionBinding {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn for_tests(
        run_id: RunId,
        promotion_decision_event_id: EventId,
        promotion_decision_event_digest: String,
        dispatch_event_id: EventId,
        dispatch_envelope_digest: String,
        decision: PromotionDecisionKindV1,
        dispatch_role: ExecutionRoleV1,
        commit_mode: CommitModeV1,
        candidate_digest: String,
        candidate_ref: String,
        candidate_commit_sha: String,
        candidate_tree_digest: String,
        base_commit_sha: String,
        target_ref: String,
        idempotency_key: String,
        has_existing_claim: bool,
    ) -> Self {
        Self {
            run_id,
            promotion_decision_event_id,
            promotion_decision_event_digest,
            dispatch_event_id,
            dispatch_envelope_digest,
            decision,
            dispatch_role,
            commit_mode,
            candidate_digest,
            candidate_ref,
            candidate_commit_sha,
            candidate_tree_digest,
            base_commit_sha,
            target_ref,
            idempotency_key,
            has_existing_claim,
        }
    }
}

pub(crate) trait TrustedPromotionVerifier {
    fn verify_exact_promotion(
        &mut self,
        run_id: RunId,
        request: &BrokerPromotionExecutionRequest,
    ) -> Result<TrustedPromotionBinding, PromotionExecutionError>;
}

pub(crate) trait PromotionExecutionBackend {
    fn claim(
        &mut self,
        run_id: RunId,
        request: &BrokerPromotionExecutionRequest,
        lease_duration_ms: u64,
    ) -> Result<PromotionExecutionGrant, PromotionExecutionError>;

    fn record_result(
        &mut self,
        run_id: RunId,
        request: &BrokerPromotionExecutionRequest,
        outcome: PromotionResultOutcomeV1,
        binding: PromotionGitBindingV1,
        lease_binding: PromotionExecutionLeaseBindingV1,
    ) -> Result<PromotionResultDisposition, PromotionExecutionError>;
}

pub(crate) trait PromotionEffectGateway {
    fn promote(
        &mut self,
        capability: VerifiedPromotionCapability,
    ) -> Result<PromotionGitOutcome, PromotionGitError>;
}

impl PromotionEffectGateway for PromotionGitGateway {
    fn promote(
        &mut self,
        capability: VerifiedPromotionCapability,
    ) -> Result<PromotionGitOutcome, PromotionGitError> {
        Self::promote(self, capability)
    }
}

pub(crate) enum PromotionExecutionGrant {
    Granted {
        run_id: RunId,
        claim_event_id: EventId,
        claim_event_digest: String,
        claim: PromotionExecutionClaimedV1,
    },
    Pending {
        run_id: RunId,
    },
    Recorded {
        run_id: RunId,
    },
    LeaseExpired {
        run_id: RunId,
    },
}

pub(crate) enum PromotionResultDisposition {
    Recorded { run_id: RunId },
}

#[derive(Debug, Error)]
pub(crate) enum PromotionExecutionError {
    #[error("trusted governed promotion replay requires reconciliation: {0}")]
    Replay(#[from] TrustedGovernedRecoveryError),
    #[error("trusted governed promotion replay does not match the startup-bound request")]
    TrustedReplayBindingMismatch,
    #[error("durable governed promotion operation requires reconciliation")]
    ReconciliationRequired,
    #[error(transparent)]
    Ledger(#[from] LedgerError),
}

impl PromotionExecutionError {
    fn from_ledger(error: LedgerError) -> Self {
        match error {
            LedgerError::PromotionExecutionClaimReconciliationRequired { .. }
            | LedgerError::PromotionResultReconciliationRequired { .. } => {
                Self::ReconciliationRequired
            }
            other => Self::Ledger(other),
        }
    }
}

/// One opaque, non-cloneable effect capability. It exists only after a sealed
/// claim and is consumed by the fixed Git gateway.
struct PrivatePromotionCapability {
    run_id: RunId,
    decision_event_id: EventId,
    git_capability: VerifiedPromotionCapability,
    lease_binding: PromotionExecutionLeaseBindingV1,
}

/// Keep trusted replay, write-ahead claim, Git CAS, and terminal result
/// recording in one broker-owned frame. A result-write failure after Git is
/// reconciliation-only; it never becomes permission to attempt Git again.
pub(crate) struct BrokerPromotionExecutionAuthority<V, B, G> {
    run_id: RunId,
    verifier: V,
    backend: B,
    gateway: G,
    lease_policy: LeasePolicy,
}

impl<V, B, G> BrokerPromotionExecutionAuthority<V, B, G>
where
    V: TrustedPromotionVerifier,
    B: PromotionExecutionBackend,
    G: PromotionEffectGateway,
{
    pub(crate) fn new(
        run_id: RunId,
        verifier: V,
        backend: B,
        gateway: G,
        lease_policy: LeasePolicy,
    ) -> Self {
        Self {
            run_id,
            verifier,
            backend,
            gateway,
            lease_policy,
        }
    }

    pub(crate) fn claim_execute_and_record(
        &mut self,
        request: BrokerPromotionExecutionRequest,
    ) -> Result<BrokerPromotionExecutionStatus, PromotionExecutionError> {
        let binding = self
            .verifier
            .verify_exact_promotion(self.run_id, &request)?;
        if binding.run_id != self.run_id
            || binding.promotion_decision_event_id != request.promotion_decision_event_id
            || binding.dispatch_role != ExecutionRoleV1::Implementer
            || binding.commit_mode != CommitModeV1::Atomic
        {
            return Err(PromotionExecutionError::TrustedReplayBindingMismatch);
        }
        if binding.decision == PromotionDecisionKindV1::Reject {
            return Ok(BrokerPromotionExecutionStatus::Rejected);
        }

        let already_claimed = binding.has_existing_claim;
        let grant = match self
            .backend
            .claim(self.run_id, &request, self.lease_policy.duration_ms())
        {
            Ok(grant) => grant,
            Err(PromotionExecutionError::ReconciliationRequired) => {
                return Ok(BrokerPromotionExecutionStatus::ReconciliationRequired)
            }
            Err(_) if already_claimed => {
                return Ok(BrokerPromotionExecutionStatus::ReconciliationRequired)
            }
            Err(error) => return Err(error),
        };

        let capability = match grant {
            PromotionExecutionGrant::Granted {
                run_id,
                claim_event_id,
                claim_event_digest,
                claim,
            } if run_id == self.run_id && !already_claimed => private_capability_from_claim(
                binding,
                request.promotion_decision_event_id,
                claim_event_id,
                claim_event_digest,
                claim,
            )?,
            PromotionExecutionGrant::Pending { run_id } if run_id == self.run_id => {
                return Ok(BrokerPromotionExecutionStatus::Pending)
            }
            PromotionExecutionGrant::Recorded { run_id } if run_id == self.run_id => {
                return Ok(BrokerPromotionExecutionStatus::Recorded)
            }
            PromotionExecutionGrant::LeaseExpired { run_id } if run_id == self.run_id => {
                return Ok(BrokerPromotionExecutionStatus::LeaseExpired)
            }
            _ => return Ok(BrokerPromotionExecutionStatus::ReconciliationRequired),
        };

        let outcome = match self.gateway.promote(capability.git_capability) {
            Ok(outcome) => outcome,
            // The fixed gateway treats every uncertain Git observation as
            // reconciliation. Once it may have crossed Git, never retry here.
            Err(_) => return Ok(BrokerPromotionExecutionStatus::ReconciliationRequired),
        };
        let git_binding = outcome.binding().clone();
        let result = self.backend.record_result(
            capability.run_id,
            &BrokerPromotionExecutionRequest {
                promotion_decision_event_id: capability.decision_event_id,
            },
            outcome.ledger_outcome(),
            git_binding,
            capability.lease_binding,
        );
        match result {
            Ok(PromotionResultDisposition::Recorded { run_id }) if run_id == self.run_id => {
                Ok(BrokerPromotionExecutionStatus::Recorded)
            }
            // The CAS may have happened. An uncertain result record cannot be
            // retried by this frame or converted into a fresh lease.
            Ok(_) | Err(_) => Ok(BrokerPromotionExecutionStatus::ReconciliationRequired),
        }
    }
}

impl<'a>
    BrokerPromotionExecutionAuthority<
        PromotionReplaySnapshotVerifier<'a>,
        LedgerPromotionExecutionBackend<'a>,
        PromotionGitGateway,
    >
{
    /// Build the fixed production composition only from protected startup
    /// dependencies. There is deliberately no controller-supplied repository
    /// path, signer, tape path, lease duration, or Git executable.
    #[allow(dead_code)]
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_prevalidated_startup(
        run_id: RunId,
        database_path: impl AsRef<Path>,
        replay_authorities: &'a TrustedReplayAuthorities,
        pinned_kernel_signer: &'a bp_ledger::signing::ActorKeyRef,
        store: &'a SqliteStore,
        promotion_authority: &'a GovernedPromotionAuthorityV1,
        kernel_signing_key: &'a SigningKey,
        kernel_signer: &'a bp_ledger::signing::ActorKeyRef,
        repository_root: &Path,
        lease_policy: LeasePolicy,
    ) -> Result<Self, PromotionGitStartupError> {
        let gateway = PromotionGitGateway::from_startup_repository_root(repository_root)?;
        Ok(Self::new(
            run_id,
            PromotionReplaySnapshotVerifier::from_prevalidated_startup(
                database_path,
                replay_authorities,
                pinned_kernel_signer,
            ),
            LedgerPromotionExecutionBackend::from_prevalidated_startup(
                store,
                promotion_authority,
                kernel_signing_key,
                kernel_signer,
            ),
            gateway,
            lease_policy,
        ))
    }
}

fn private_capability_from_claim(
    binding: TrustedPromotionBinding,
    decision_event_id: EventId,
    claim_event_id: EventId,
    claim_event_digest: String,
    claim: PromotionExecutionClaimedV1,
) -> Result<PrivatePromotionCapability, PromotionExecutionError> {
    if claim.promotion_decision_event_ref != decision_event_id
        || claim.promotion_decision_event_digest != binding.promotion_decision_event_digest
        || claim.dispatch_event_ref != binding.dispatch_event_id
        || claim.dispatch_envelope_digest != binding.dispatch_envelope_digest
        || claim.run_id != binding.run_id.to_string()
        || claim.candidate_digest != binding.candidate_digest
        || claim.candidate_ref != binding.candidate_ref
        || claim.candidate_commit_sha != binding.candidate_commit_sha
        || claim.candidate_tree_digest != binding.candidate_tree_digest
        || claim.base_commit_sha != binding.base_commit_sha
        || claim.target_ref != binding.target_ref
        || claim.idempotency_key != binding.idempotency_key
    {
        return Err(PromotionExecutionError::TrustedReplayBindingMismatch);
    }
    let git_capability = VerifiedPromotionCapability::from_verified_facts(
        claim.candidate_digest,
        claim.candidate_ref,
        claim.candidate_commit_sha,
        claim.candidate_tree_digest,
        claim.base_commit_sha,
        claim.target_ref,
        claim.idempotency_key,
    )
    .map_err(|_| PromotionExecutionError::TrustedReplayBindingMismatch)?;
    Ok(PrivatePromotionCapability {
        run_id: binding.run_id,
        decision_event_id,
        git_capability,
        lease_binding: PromotionExecutionLeaseBindingV1 {
            promotion_execution_claim_event_ref: claim_event_id,
            promotion_execution_claim_event_digest: claim_event_digest,
            lease_id: claim.lease_id,
        },
    })
}

/// Full-tape verifier for promotion execution. It reopens a verified snapshot
/// for every request, so a prior checkpoint can never bless a later tail.
pub(crate) struct PromotionReplaySnapshotVerifier<'a> {
    database_path: PathBuf,
    authorities: &'a TrustedReplayAuthorities,
    pinned_kernel_signer: &'a bp_ledger::signing::ActorKeyRef,
}

impl<'a> PromotionReplaySnapshotVerifier<'a> {
    #[allow(dead_code)]
    pub(crate) fn from_prevalidated_startup(
        database_path: impl AsRef<Path>,
        authorities: &'a TrustedReplayAuthorities,
        pinned_kernel_signer: &'a bp_ledger::signing::ActorKeyRef,
    ) -> Self {
        Self {
            database_path: database_path.as_ref().to_path_buf(),
            authorities,
            pinned_kernel_signer,
        }
    }
}

impl TrustedPromotionVerifier for PromotionReplaySnapshotVerifier<'_> {
    fn verify_exact_promotion(
        &mut self,
        run_id: RunId,
        request: &BrokerPromotionExecutionRequest,
    ) -> Result<TrustedPromotionBinding, PromotionExecutionError> {
        let run_id_text = run_id.to_string();
        let snapshot = TrustedGovernedRecoverySnapshot::open(
            &run_id_text,
            &self.database_path,
            self.authorities,
            self.pinned_kernel_signer,
        )?;
        let workflow = snapshot
            .workflow_for_promotion_decision_event_ref(
                &request.promotion_decision_event_id.to_string(),
            )
            .ok_or(PromotionExecutionError::TrustedReplayBindingMismatch)?;
        let candidate = workflow
            .candidate
            .as_ref()
            .ok_or(PromotionExecutionError::TrustedReplayBindingMismatch)?;
        let promotion = workflow
            .promotion
            .as_ref()
            .ok_or(PromotionExecutionError::TrustedReplayBindingMismatch)?;
        let target_ref = promotion
            .decision
            .target_ref
            .clone()
            .ok_or(PromotionExecutionError::TrustedReplayBindingMismatch)?;
        if workflow.run_id != run_id_text
            || promotion.decision.event_id != request.promotion_decision_event_id
            || promotion.decision.candidate_digest != candidate.candidate_digest
            || promotion.decision.base_commit_sha != candidate.base_commit_sha
            || promotion.decision.envelope_digest != candidate.envelope_digest
        {
            return Err(PromotionExecutionError::TrustedReplayBindingMismatch);
        }
        Ok(TrustedPromotionBinding {
            run_id,
            promotion_decision_event_id: promotion.decision.event_id,
            promotion_decision_event_digest: promotion.decision.event_digest.clone(),
            dispatch_event_id: workflow.dispatch.event_id,
            dispatch_envelope_digest: workflow.dispatch.envelope_digest.clone(),
            decision: promotion.decision.decision,
            dispatch_role: workflow.dispatch.execution_role,
            commit_mode: workflow.dispatch.commit_mode,
            candidate_digest: candidate.candidate_digest.clone(),
            candidate_ref: candidate.candidate_ref.clone(),
            candidate_commit_sha: candidate.candidate_commit_sha.clone(),
            candidate_tree_digest: candidate.tree_digest.clone(),
            base_commit_sha: candidate.base_commit_sha.clone(),
            target_ref,
            idempotency_key: promotion.decision.idempotency_key.clone(),
            has_existing_claim: promotion.execution_claim.is_some(),
        })
    }
}

/// Protected-ledger implementation of the claim/result backend. It remains
/// private until an OS-authenticated broker owns the startup dependencies.
pub(crate) struct LedgerPromotionExecutionBackend<'a> {
    store: &'a SqliteStore,
    authority: &'a GovernedPromotionAuthorityV1,
    kernel_signing_key: &'a SigningKey,
    kernel_signer: &'a bp_ledger::signing::ActorKeyRef,
}

impl<'a> LedgerPromotionExecutionBackend<'a> {
    #[allow(dead_code)]
    pub(crate) fn from_prevalidated_startup(
        store: &'a SqliteStore,
        authority: &'a GovernedPromotionAuthorityV1,
        kernel_signing_key: &'a SigningKey,
        kernel_signer: &'a bp_ledger::signing::ActorKeyRef,
    ) -> Self {
        Self {
            store,
            authority,
            kernel_signing_key,
            kernel_signer,
        }
    }
}

impl PromotionExecutionBackend for LedgerPromotionExecutionBackend<'_> {
    fn claim(
        &mut self,
        run_id: RunId,
        request: &BrokerPromotionExecutionRequest,
        lease_duration_ms: u64,
    ) -> Result<PromotionExecutionGrant, PromotionExecutionError> {
        let request = GovernedPromotionExecutionClaimRequestV1 {
            run_id,
            promotion_decision_event_id: request.promotion_decision_event_id,
            lease_duration_ms,
        };
        let disposition = self
            .store
            .claim_governed_promotion_execution_v1(
                &request,
                self.authority,
                self.kernel_signing_key,
                self.kernel_signer,
            )
            .map_err(PromotionExecutionError::from_ledger)?;
        Ok(match disposition {
            GovernedPromotionExecutionClaimDispositionV1::Granted {
                promotion_execution_claim_event_id,
                promotion_execution_claim_event_digest,
                claim,
            } => PromotionExecutionGrant::Granted {
                run_id,
                claim_event_id: promotion_execution_claim_event_id,
                claim_event_digest: promotion_execution_claim_event_digest,
                claim,
            },
            GovernedPromotionExecutionClaimDispositionV1::Pending { .. } => {
                PromotionExecutionGrant::Pending { run_id }
            }
            GovernedPromotionExecutionClaimDispositionV1::Recorded { .. } => {
                PromotionExecutionGrant::Recorded { run_id }
            }
            GovernedPromotionExecutionClaimDispositionV1::LeaseExpired { .. } => {
                PromotionExecutionGrant::LeaseExpired { run_id }
            }
        })
    }

    fn record_result(
        &mut self,
        run_id: RunId,
        request: &BrokerPromotionExecutionRequest,
        outcome: PromotionResultOutcomeV1,
        binding: PromotionGitBindingV1,
        lease_binding: PromotionExecutionLeaseBindingV1,
    ) -> Result<PromotionResultDisposition, PromotionExecutionError> {
        let merged_head_sha = binding.merged_head_sha.clone();
        let request = GovernedPromotionResultRequestV1 {
            run_id,
            promotion_decision_event_id: request.promotion_decision_event_id,
            outcome,
            merged_head_sha,
            promotion_git_binding: Some(binding),
            promotion_execution_lease_binding: Some(lease_binding),
        };
        match self
            .store
            .record_governed_promotion_result_v1(
                &request,
                self.authority,
                self.kernel_signing_key,
                self.kernel_signer,
            )
            .map_err(PromotionExecutionError::from_ledger)?
        {
            GovernedPromotionResultDispositionV1::Recorded { .. }
            | GovernedPromotionResultDispositionV1::Existing { .. } => {
                Ok(PromotionResultDisposition::Recorded { run_id })
            }
        }
    }
}
