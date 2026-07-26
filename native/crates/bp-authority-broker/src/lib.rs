//! Broker-private composition for durable governed model authority.
//!
//! This crate exposes one opaque, no-argument promotion-decision host runner
//! and one no-authority, fixed-path client runner. All authority constructors,
//! custody types, ledger/CAS state, signers, paths, and protocol internals
//! remain private. The host consumes only its fixed protected deployment
//! config and pre-opened Linux listener; the client consumes only its closed
//! decision input and protected public identity pin. Other authority roles
//! remain composition boundaries and must not be wired to
//! `buildplane-native`, the generic ledger server, or a same-UID signer.
//! A production gateway must convert every catchable provider failure after
//! capability receipt into paired `Unknown` evidence. Process death or panic
//! before that pairing still requires an OS-supervised reconciliation path and
//! is not claimed as solved by this in-process slice.

use bp_ledger::error::LedgerError;
use bp_ledger::payload::activity_claim::ActivityResultOutcomeV1;
use bp_ledger::payload::trust_spine::{
    CandidateAcceptanceOutcomeV1, PromotionDecisionKindV1, PromotionResultOutcomeV1,
    ReconciliationResolutionOutcomeV1, ReviewDecisionV1,
};
use bp_ledger::signing::ActorKeyRef;
use bp_ledger::storage::sqlite::{
    ActivityClaimAuthorityV1, ActivityResultDispositionV1,
    GovernedModelActionAuthorizeAndClaimDispositionV1,
    GovernedModelActionAuthorizeAndClaimRequestV1, GovernedModelActionResultRequestV1,
    GovernedPromotionAuthorityV1, GovernedPromotionDecisionDispositionV1,
    GovernedPromotionDecisionRequestV1, GovernedPromotionDecisionSealRequestV1,
    GovernedPromotionReconciliationDispositionV1, GovernedPromotionReconciliationRequestV1,
    ProviderTokenPreflightForModelActionRequestV1, SqliteStore, MAX_ACTIVITY_LEASE_MS,
    MIN_ACTIVITY_LEASE_MS,
};
use bp_ledger::storage::Cas;
use bp_ledger::{EventId, RunId};
use bp_replay::{
    TrustedGovernedRecoveryError, TrustedGovernedRecoverySnapshot, TrustedReplayAuthorities,
    WorkflowPhaseV1,
};
use ed25519_dalek::SigningKey;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[allow(dead_code)]
mod admission_protocol;
mod confinement;
#[allow(dead_code)]
mod dispatch_admission;
#[allow(dead_code)] // Open evidence is consumed by the protected OCI reviewer handler next.
mod governed_reviewer_authority;
mod governed_session_client;
#[cfg(test)]
mod governed_session_client_contract_tests;
#[cfg(target_os = "linux")]
#[allow(dead_code)] // Transport-only until trusted replay and OCI handlers are composed.
mod governed_session_host;
#[cfg(all(test, target_os = "linux"))]
mod governed_session_host_contract_tests;
mod governed_session_response;
#[cfg(test)]
mod governed_session_response_contract_tests;
mod governed_session_startup;
#[cfg(test)]
mod governed_session_startup_contract_tests;
mod governed_session_token;
#[cfg(test)]
mod governed_session_token_contract_tests;
mod host_cas_custody;
mod host_config;
mod host_config_loader;
mod host_key_custody;
#[allow(dead_code)] // Constructed by the native authority host listener in the next slice.
mod host_ledger_custody;
mod promotion_decision_client;
#[cfg(test)]
mod promotion_decision_client_contract_tests;
#[allow(dead_code)]
mod promotion_decision_handler;
mod promotion_decision_host;
mod promotion_decision_response;
#[cfg(test)]
mod promotion_decision_response_contract_tests;
mod promotion_execution;
#[allow(dead_code)]
mod promotion_execution_handler;
mod promotion_git;
#[cfg(target_os = "linux")]
#[allow(dead_code)]
mod protocol;
#[allow(dead_code)] // Production ledger/counter composition follows the closed lifecycle tests.
mod provider_preflight;
#[cfg(test)]
mod provider_preflight_contract_tests;
mod provider_request;
#[cfg(test)]
mod provider_request_contract_tests;
mod provider_result;
#[cfg(test)]
mod provider_result_contract_tests;
#[allow(dead_code)]
mod reviewer_session;
mod rootless_oci;
#[cfg(test)]
mod rootless_oci_contract_tests;
mod v5_admission_client;
mod v5_admission_host;
#[allow(dead_code)]
mod v5_admission_host_config;
mod v5_admission_response;
#[cfg(test)]
mod v5_admission_response_contract_tests;
#[allow(dead_code)]
mod v5_dispatch_admission;

pub use governed_session_client::run_default_governed_session_client_v1;
pub use promotion_decision_client::run_default_promotion_decision_client_v1;
pub use promotion_decision_host::run_default_promotion_decision_host_v1;
pub use v5_admission_client::run_default_v5_admission_client_v1;
pub use v5_admission_host::run_default_v5_admission_host_v1;

use crate::promotion_git::{
    PromotionGitGateway, PromotionGitStartupError, VerifiedPromotionCapability,
};

/// The complete request surface accepted from a run-bound broker controller.
///
/// Workspace paths, CAS roots, signer identities, role, prompt/model/provider,
/// idempotency, and lease duration are deliberately absent. The native ledger
/// reconstructs those values from signed tape and protected CAS.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BrokerModelActionRequest {
    pub(crate) dispatch_event_id: EventId,
    pub(crate) action_request_event_id: EventId,
}

/// Startup-derived policy. There is no per-request lease override.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct LeasePolicy {
    duration_ms: u64,
}

impl LeasePolicy {
    pub(crate) fn from_startup_config(duration_ms: u64) -> Result<Self, StartupPolicyError> {
        if !(MIN_ACTIVITY_LEASE_MS..=MAX_ACTIVITY_LEASE_MS).contains(&duration_ms) {
            return Err(StartupPolicyError::LeaseDurationOutOfRange {
                duration_ms,
                min_ms: MIN_ACTIVITY_LEASE_MS,
                max_ms: MAX_ACTIVITY_LEASE_MS,
            });
        }
        Ok(Self { duration_ms })
    }

    fn duration_ms(self) -> u64 {
        self.duration_ms
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub(crate) enum StartupPolicyError {
    #[error("broker model lease duration {duration_ms}ms is outside {min_ms}..={max_ms}ms")]
    LeaseDurationOutOfRange {
        duration_ms: u64,
        min_ms: u64,
        max_ms: u64,
    },
}

/// Startup validation for the sealed promotion-decision composition.
///
/// The ledger verifies that the injected keys match its configured authority
/// identities on every record/seal operation. The broker additionally rejects
/// obvious operator/kernel key or identity aliasing before it can accept a
/// controller request.
#[derive(Debug, Error, PartialEq, Eq)]
pub(crate) enum BrokerPromotionDecisionStartupError {
    #[error("governed promotion operator and kernel signing keys must use distinct material")]
    SharedSigningKeyMaterial,
    #[error("governed promotion operator and kernel signer identities must be distinct")]
    SharedSignerIdentity,
}

/// The only controller-visible result of the private promotion composition.
///
/// `Sealed` is recovery evidence only, never target-ref, Git, process, or
/// capability authority. Any failed, malformed, substituted, or incomplete
/// transition is deliberately collapsed to reconciliation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BrokerPromotionDecisionDisposition {
    Sealed,
    ReconciliationRequired,
}

/// The only parsed controller input accepted by the private operator-decision
/// path. The wire may name a durable approval work item and choose one closed
/// outcome; all decision lineage remains broker-derived.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct BrokerPromotionDecisionIngressRequest {
    pub(crate) promotion_approval_request_event_id: EventId,
    pub(crate) decision: PromotionDecisionKindV1,
}

/// Private broker composition for one startup-bound promotion-decision run.
///
/// Callers can supply only the pre-existing closed ledger request, whose
/// mutable choice is already restricted to `promote | reject`. The protected
/// store, authority realm, and separate operator/kernel keys are startup
/// dependencies and never cross the controller boundary. This composition
/// intentionally has no Git, workspace, process, result-writer, or capability
/// dependency.
pub(crate) struct BrokerPromotionDecisionAuthority<'a> {
    run_id: RunId,
    store: &'a SqliteStore,
    authority: &'a GovernedPromotionAuthorityV1,
    operator_signing_key: &'a SigningKey,
    operator_signer: &'a ActorKeyRef,
    kernel_signing_key: &'a SigningKey,
    kernel_signer: &'a ActorKeyRef,
}

impl<'a> BrokerPromotionDecisionAuthority<'a> {
    /// Construct only from protected startup dependencies. This remains crate
    /// private until an externally authenticated broker process owns startup.
    pub(crate) fn from_prevalidated_startup(
        run_id: RunId,
        store: &'a SqliteStore,
        authority: &'a GovernedPromotionAuthorityV1,
        operator_signing_key: &'a SigningKey,
        operator_signer: &'a ActorKeyRef,
        kernel_signing_key: &'a SigningKey,
        kernel_signer: &'a ActorKeyRef,
    ) -> Result<Self, BrokerPromotionDecisionStartupError> {
        if operator_signing_key.to_bytes() == kernel_signing_key.to_bytes() {
            return Err(BrokerPromotionDecisionStartupError::SharedSigningKeyMaterial);
        }
        if operator_signer == kernel_signer {
            return Err(BrokerPromotionDecisionStartupError::SharedSignerIdentity);
        }
        Ok(Self {
            run_id,
            store,
            authority,
            operator_signing_key,
            operator_signer,
            kernel_signing_key,
            kernel_signer,
        })
    }

    /// Durably record then seal one closed promotion decision.
    ///
    /// A request outside the startup-bound run is rejected before the first
    /// write. The ledger's record path owns evidence validation and
    /// idempotency; its intermediate `AwaitingKernelSeal` state remains
    /// private, is immediately supplied to the kernel seal operation, and is
    /// never returned to the controller. Retries may resolve an existing
    /// record, but they can yield only `Sealed` or reconciliation.
    pub(crate) fn record_then_seal(
        &self,
        request: GovernedPromotionDecisionRequestV1,
    ) -> BrokerPromotionDecisionDisposition {
        if request.run_id != self.run_id {
            return BrokerPromotionDecisionDisposition::ReconciliationRequired;
        }

        let promotion_decision_event_id = match self.store.record_governed_promotion_decision_v1(
            &request,
            self.authority,
            self.operator_signing_key,
            self.operator_signer,
        ) {
            Ok(
                GovernedPromotionDecisionDispositionV1::AwaitingKernelSeal {
                    promotion_decision_event_id,
                    ..
                }
                | GovernedPromotionDecisionDispositionV1::Sealed {
                    promotion_decision_event_id,
                    ..
                },
            ) => promotion_decision_event_id,
            Err(_) => return BrokerPromotionDecisionDisposition::ReconciliationRequired,
        };

        let seal_request = GovernedPromotionDecisionSealRequestV1 {
            run_id: self.run_id,
            promotion_decision_event_id,
        };
        match self.store.seal_governed_promotion_decision_v1(
            &seal_request,
            self.authority,
            self.kernel_signing_key,
            self.kernel_signer,
        ) {
            Ok(GovernedPromotionDecisionDispositionV1::Sealed { .. }) => {
                BrokerPromotionDecisionDisposition::Sealed
            }
            Ok(GovernedPromotionDecisionDispositionV1::AwaitingKernelSeal { .. }) | Err(_) => {
                BrokerPromotionDecisionDisposition::ReconciliationRequired
            }
        }
    }
}

/// Opaque production composition for one startup-bound operator promotion
/// decision path.
///
/// A caller never receives the enclosed trusted replay, protected ledger, or
/// signer dependencies. For each opaque approval identity this authority
/// reopens the full bounded recovery view and reconstructs the sole accepted
/// storage request from tape-derived workflow state.
pub(crate) struct ProtectedPromotionDecisionAuthority<'a> {
    run_id: RunId,
    database_path: PathBuf,
    replay_authorities: &'a TrustedReplayAuthorities,
    pinned_kernel_signer: &'a ActorKeyRef,
    inner: BrokerPromotionDecisionAuthority<'a>,
}

impl<'a> ProtectedPromotionDecisionAuthority<'a> {
    /// Construct only from protected startup dependencies. No caller may
    /// select a run, database, trusted signer set, authority realm, or signing
    /// key after this boundary has been created.
    #[allow(dead_code)]
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_prevalidated_startup(
        run_id: RunId,
        database_path: impl AsRef<Path>,
        replay_authorities: &'a TrustedReplayAuthorities,
        pinned_kernel_signer: &'a ActorKeyRef,
        store: &'a SqliteStore,
        authority: &'a GovernedPromotionAuthorityV1,
        operator_signing_key: &'a SigningKey,
        operator_signer: &'a ActorKeyRef,
        kernel_signing_key: &'a SigningKey,
        kernel_signer: &'a ActorKeyRef,
    ) -> Result<Self, BrokerPromotionDecisionStartupError> {
        let inner = BrokerPromotionDecisionAuthority::from_prevalidated_startup(
            run_id,
            store,
            authority,
            operator_signing_key,
            operator_signer,
            kernel_signing_key,
            kernel_signer,
        )?;
        Ok(Self {
            run_id,
            database_path: database_path.as_ref().to_path_buf(),
            replay_authorities,
            pinned_kernel_signer,
            inner,
        })
    }

    /// Bind the trusted recovery reader to the same canonical durable ledger
    /// identity held by the protected writer. A valid copied tape must never
    /// authorize a decision write into a different store.
    fn canonical_recovery_database_path(&self) -> Option<PathBuf> {
        let store_path = self.inner.store.canonical_database_path().ok()?;
        let recovery_path = std::fs::canonicalize(&self.database_path).ok()?;
        (store_path == recovery_path).then_some(recovery_path)
    }

    /// Reopen trusted replay and record only one tape-derived promotion
    /// decision for an exact pending approval work item.
    ///
    /// Every malformed, stale, cross-run, unsupported, or incomplete state is
    /// intentionally indistinguishable to the caller: reconciliation is
    /// required and no storage write is attempted. This does not activate a
    /// promotion effect; the sealed decision remains subject to the separate
    /// execution-claim path.
    pub(crate) fn record_from_approval_decision(
        &self,
        request: BrokerPromotionDecisionIngressRequest,
    ) -> BrokerPromotionDecisionDisposition {
        let startup_run_id = self.run_id.to_string();
        let recovery_database_path = match self.canonical_recovery_database_path() {
            Some(path) => path,
            None => return BrokerPromotionDecisionDisposition::ReconciliationRequired,
        };
        let snapshot = match TrustedGovernedRecoverySnapshot::open_bounded_v1(
            &startup_run_id,
            &recovery_database_path,
            self.replay_authorities,
            self.pinned_kernel_signer,
        ) {
            Ok(snapshot) => snapshot,
            Err(_) => return BrokerPromotionDecisionDisposition::ReconciliationRequired,
        };
        if snapshot.run_id() != startup_run_id {
            return BrokerPromotionDecisionDisposition::ReconciliationRequired;
        }

        let approval_event_ref = request.promotion_approval_request_event_id.to_string();
        let workflow =
            match snapshot.workflow_for_promotion_approval_request_event_ref(&approval_event_ref) {
                Some(workflow) => workflow,
                None => return BrokerPromotionDecisionDisposition::ReconciliationRequired,
            };
        if workflow.run_id != startup_run_id
            || workflow.phase != WorkflowPhaseV1::PromotionApprovalPending
            || workflow.promotion.is_some()
        {
            return BrokerPromotionDecisionDisposition::ReconciliationRequired;
        }

        let approval = match workflow.promotion_approval.as_ref() {
            Some(approval) if approval.event_id == request.promotion_approval_request_event_id => {
                approval
            }
            _ => return BrokerPromotionDecisionDisposition::ReconciliationRequired,
        };
        let candidate = match workflow.candidate.as_ref() {
            Some(candidate) => candidate,
            None => return BrokerPromotionDecisionDisposition::ReconciliationRequired,
        };
        let candidate_completion = match workflow.candidate_completion.as_ref() {
            Some(completion) => completion,
            None => return BrokerPromotionDecisionDisposition::ReconciliationRequired,
        };
        let acceptance = match workflow.acceptance.as_ref() {
            Some(acceptance) => acceptance,
            None => return BrokerPromotionDecisionDisposition::ReconciliationRequired,
        };
        if candidate_completion.completion.run_id != startup_run_id
            || candidate_completion.completion.candidate_created_event_ref != candidate.event_id
            || candidate_completion.completion.candidate_digest != candidate.candidate_digest
            || acceptance.candidate_digest != candidate.candidate_digest
            || acceptance.candidate_commit_sha != candidate.candidate_commit_sha
            || acceptance.outcome != CandidateAcceptanceOutcomeV1::Passed
            || approval.candidate_digest != candidate.candidate_digest
            || approval.base_commit_sha != candidate.base_commit_sha
            || approval.envelope_digest != candidate.envelope_digest
            || approval.acceptance_ref != acceptance.acceptance_ref
            || approval.target_ref.trim().is_empty()
            || approval.review_refs.is_empty()
        {
            return BrokerPromotionDecisionDisposition::ReconciliationRequired;
        }

        let mut review_event_ids = Vec::with_capacity(approval.review_refs.len());
        for review_ref in &approval.review_refs {
            let review = match workflow.reviews.get(review_ref) {
                Some(review) => review,
                None => return BrokerPromotionDecisionDisposition::ReconciliationRequired,
            };
            if review.review_ref != *review_ref
                || review.decision != ReviewDecisionV1::Approve
                || review.candidate_digest != candidate.candidate_digest
                || review.candidate_commit_sha != candidate.candidate_commit_sha
                || review.acceptance_ref.as_deref() != Some(acceptance.acceptance_ref.as_str())
            {
                return BrokerPromotionDecisionDisposition::ReconciliationRequired;
            }
            review_event_ids.push(review.event_id);
        }

        self.inner
            .record_then_seal(GovernedPromotionDecisionRequestV1 {
                run_id: self.run_id,
                dispatch_event_id: workflow.dispatch.event_id,
                candidate_created_event_id: candidate.event_id,
                candidate_completion_event_id: candidate_completion.event_id,
                acceptance_event_id: acceptance.event_id,
                review_event_ids,
                promotion_approval_request_event_id: approval.event_id,
                decision: request.decision,
            })
    }
}

/// The only controller-supplied recovery identity for an already-recorded
/// promotion result. In particular, a controller cannot nominate a result,
/// reconciliation outcome, signer, repository root, or Git capability.
#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(dead_code)] // Wired only by the future OS-authenticated broker host.
pub(crate) struct BrokerPromotionReconciliationIngressRequest {
    pub(crate) promotion_decision_event_id: EventId,
}

/// Redacted result of the broker-owned reconciliation path. `Recorded` and
/// `Existing` are durable abandonment evidence only; neither grants a target
/// mutation, a root checkout update, a terminal workflow transition, or a
/// reusable Git capability.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)] // Wired only by the future OS-authenticated broker host.
pub(crate) enum BrokerPromotionReconciliationDisposition {
    Recorded,
    Existing,
    ReconciliationRequired,
}

/// Startup validation for the recovery-only promotion-reconciliation
/// composition. The fixed Git gateway is constructed once at broker startup;
/// no controller gets to select a path, binary, runner, or signer.
#[derive(Debug, Error, PartialEq, Eq)]
pub(crate) enum BrokerPromotionReconciliationStartupError {
    #[error("governed promotion operator and kernel signing keys must use distinct material")]
    SharedSigningKeyMaterial,
    #[error("governed promotion operator and kernel signer identities must be distinct")]
    SharedSignerIdentity,
    #[error("the trusted replay kernel signer must equal the governed promotion kernel signer")]
    PinnedKernelSignerMismatch,
    #[error("the local operator signer must equal the governed promotion authority operator")]
    ConfiguredOperatorSignerMismatch,
    #[error("the local kernel signer must equal the governed promotion authority kernel")]
    ConfiguredKernelSignerMismatch,
    #[error(transparent)]
    Git(#[from] PromotionGitStartupError),
}

/// Protected, recovery-only composition for a previously recorded governed
/// promotion result.
///
/// This is intentionally separate from effect execution. It reopens a fully
/// checkpointed trusted replay on every request, derives the exact result and
/// candidate lineage from that snapshot, observes an existing receipt through
/// the fixed Git gateway, and then asks the narrow ledger primitive to append
/// only `Abandon`. It never calls `promote`, never creates a merge, never
/// updates a target ref, and never synchronizes the root checkout.
///
/// The raw ledger writer remains public only because `bp-ledger` and this
/// broker are separate crates. It is a narrow broker FFI primitive, not an
/// external ledger-server or controller API; construction of this façade keeps
/// its signing material and authority realm outside the controller boundary.
#[allow(dead_code)] // The native host integration owns the first production call site.
pub(crate) struct ProtectedPromotionReconciliationAuthority<'a> {
    run_id: RunId,
    database_path: PathBuf,
    replay_authorities: &'a TrustedReplayAuthorities,
    pinned_kernel_signer: &'a ActorKeyRef,
    store: &'a SqliteStore,
    authority: &'a GovernedPromotionAuthorityV1,
    operator_signing_key: &'a SigningKey,
    operator_signer: &'a ActorKeyRef,
    kernel_signing_key: &'a SigningKey,
    kernel_signer: &'a ActorKeyRef,
    gateway: PromotionGitGateway,
}

impl<'a> ProtectedPromotionReconciliationAuthority<'a> {
    /// Construct the production recovery boundary only from startup-owned
    /// dependencies. Unsupported platforms or unavailable fixed Git block
    /// governed recovery rather than falling back to a host shell.
    #[allow(dead_code)]
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_prevalidated_startup(
        run_id: RunId,
        database_path: impl AsRef<Path>,
        replay_authorities: &'a TrustedReplayAuthorities,
        pinned_kernel_signer: &'a ActorKeyRef,
        store: &'a SqliteStore,
        authority: &'a GovernedPromotionAuthorityV1,
        operator_signing_key: &'a SigningKey,
        operator_signer: &'a ActorKeyRef,
        kernel_signing_key: &'a SigningKey,
        kernel_signer: &'a ActorKeyRef,
        repository_root: &Path,
    ) -> Result<Self, BrokerPromotionReconciliationStartupError> {
        let gateway = PromotionGitGateway::from_startup_repository_root(repository_root)?;
        Self::from_prevalidated_startup_with_gateway(
            run_id,
            database_path,
            replay_authorities,
            pinned_kernel_signer,
            store,
            authority,
            operator_signing_key,
            operator_signer,
            kernel_signing_key,
            kernel_signer,
            gateway,
        )
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_prevalidated_startup_with_gateway_for_tests(
        run_id: RunId,
        database_path: impl AsRef<Path>,
        replay_authorities: &'a TrustedReplayAuthorities,
        pinned_kernel_signer: &'a ActorKeyRef,
        store: &'a SqliteStore,
        authority: &'a GovernedPromotionAuthorityV1,
        operator_signing_key: &'a SigningKey,
        operator_signer: &'a ActorKeyRef,
        kernel_signing_key: &'a SigningKey,
        kernel_signer: &'a ActorKeyRef,
        gateway: PromotionGitGateway,
    ) -> Result<Self, BrokerPromotionReconciliationStartupError> {
        Self::from_prevalidated_startup_with_gateway(
            run_id,
            database_path,
            replay_authorities,
            pinned_kernel_signer,
            store,
            authority,
            operator_signing_key,
            operator_signer,
            kernel_signing_key,
            kernel_signer,
            gateway,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn from_prevalidated_startup_with_gateway(
        run_id: RunId,
        database_path: impl AsRef<Path>,
        replay_authorities: &'a TrustedReplayAuthorities,
        pinned_kernel_signer: &'a ActorKeyRef,
        store: &'a SqliteStore,
        authority: &'a GovernedPromotionAuthorityV1,
        operator_signing_key: &'a SigningKey,
        operator_signer: &'a ActorKeyRef,
        kernel_signing_key: &'a SigningKey,
        kernel_signer: &'a ActorKeyRef,
        gateway: PromotionGitGateway,
    ) -> Result<Self, BrokerPromotionReconciliationStartupError> {
        if operator_signing_key.to_bytes() == kernel_signing_key.to_bytes() {
            return Err(BrokerPromotionReconciliationStartupError::SharedSigningKeyMaterial);
        }
        if operator_signer == kernel_signer {
            return Err(BrokerPromotionReconciliationStartupError::SharedSignerIdentity);
        }
        if pinned_kernel_signer != kernel_signer {
            return Err(BrokerPromotionReconciliationStartupError::PinnedKernelSignerMismatch);
        }
        if authority.configured_operator_signer() != operator_signer {
            return Err(
                BrokerPromotionReconciliationStartupError::ConfiguredOperatorSignerMismatch,
            );
        }
        if authority.configured_kernel_signer() != kernel_signer {
            return Err(BrokerPromotionReconciliationStartupError::ConfiguredKernelSignerMismatch);
        }
        Ok(Self {
            run_id,
            database_path: database_path.as_ref().to_path_buf(),
            replay_authorities,
            pinned_kernel_signer,
            store,
            authority,
            operator_signing_key,
            operator_signer,
            kernel_signing_key,
            kernel_signer,
            gateway,
        })
    }

    /// Keep the trusted reader on the exact SQLite identity that the protected
    /// writer will later use. A copied tape can never authorize a write into a
    /// different store.
    #[allow(dead_code)] // Called once the native host exposes the recovery endpoint.
    fn canonical_recovery_database_path(&self) -> Option<PathBuf> {
        let store_path = self.store.canonical_database_path().ok()?;
        let recovery_path = std::fs::canonicalize(&self.database_path).ok()?;
        (store_path == recovery_path).then_some(recovery_path)
    }

    /// Observe and abandon one exact recorded target-bound promotion.
    ///
    /// Any mismatch leaves the ledger unchanged and reports reconciliation.
    /// In particular, an absent or malformed receipt is not a reason to retry
    /// promotion: `observe_existing_receipt` is the only Git entry point here.
    #[allow(dead_code)] // Called once the native host exposes the recovery endpoint.
    pub(crate) fn record_abandon_from_replayed_promotion(
        &mut self,
        request: BrokerPromotionReconciliationIngressRequest,
    ) -> BrokerPromotionReconciliationDisposition {
        let run_id_text = self.run_id.to_string();
        let recovery_database_path = match self.canonical_recovery_database_path() {
            Some(path) => path,
            None => return BrokerPromotionReconciliationDisposition::ReconciliationRequired,
        };
        let snapshot = match TrustedGovernedRecoverySnapshot::open_bounded_v1(
            &run_id_text,
            &recovery_database_path,
            self.replay_authorities,
            self.pinned_kernel_signer,
        ) {
            Ok(snapshot) => snapshot,
            Err(_) => return BrokerPromotionReconciliationDisposition::ReconciliationRequired,
        };
        if snapshot.run_id() != run_id_text {
            return BrokerPromotionReconciliationDisposition::ReconciliationRequired;
        }

        let workflow = match snapshot.workflow_for_promotion_decision_event_ref(
            &request.promotion_decision_event_id.to_string(),
        ) {
            Some(workflow) => workflow,
            None => return BrokerPromotionReconciliationDisposition::ReconciliationRequired,
        };
        let candidate = match workflow.candidate.as_ref() {
            Some(candidate) => candidate,
            None => return BrokerPromotionReconciliationDisposition::ReconciliationRequired,
        };
        let promotion = match workflow.promotion.as_ref() {
            Some(promotion) => promotion,
            None => return BrokerPromotionReconciliationDisposition::ReconciliationRequired,
        };
        let target_ref = match promotion.decision.target_ref.as_deref() {
            Some(target_ref) if !target_ref.trim().is_empty() => target_ref,
            _ => return BrokerPromotionReconciliationDisposition::ReconciliationRequired,
        };
        if workflow.run_id != run_id_text
            || !matches!(
                workflow.phase,
                WorkflowPhaseV1::PromotionReconciliationRequired
                    | WorkflowPhaseV1::PromotionReconciliationResolved
            )
            || promotion.decision.event_id != request.promotion_decision_event_id
            || promotion.decision.event_digest.trim().is_empty()
            || promotion.decision.decision != PromotionDecisionKindV1::Promote
            || promotion.decision.authority != self.operator_signer.actor_id
            || promotion.decision.decided_by != self.operator_signer.actor_id
            || promotion.decision.candidate_digest != candidate.candidate_digest
            || promotion.decision.base_commit_sha != candidate.base_commit_sha
            || promotion.decision.envelope_digest != candidate.envelope_digest
        {
            return BrokerPromotionReconciliationDisposition::ReconciliationRequired;
        }

        let result = match promotion.result.as_ref() {
            Some(result) => result,
            None => return BrokerPromotionReconciliationDisposition::ReconciliationRequired,
        };
        let claim = match promotion.execution_claim.as_ref() {
            Some(claim) => claim,
            None => return BrokerPromotionReconciliationDisposition::ReconciliationRequired,
        };
        let lease_binding = match result.promotion_execution_lease_binding.as_ref() {
            Some(binding) => binding,
            None => return BrokerPromotionReconciliationDisposition::ReconciliationRequired,
        };
        let expected_git_binding = match result.promotion_git_binding.clone() {
            Some(binding) => binding,
            None => return BrokerPromotionReconciliationDisposition::ReconciliationRequired,
        };
        let expected_receipt_ref = match expected_git_binding.promotion_receipt_ref.as_deref() {
            Some(receipt_ref) if !receipt_ref.trim().is_empty() => receipt_ref,
            _ => return BrokerPromotionReconciliationDisposition::ReconciliationRequired,
        };
        if result.event_digest.trim().is_empty()
            || result.promotion_decision_ref != request.promotion_decision_event_id.to_string()
            || result.candidate_digest != candidate.candidate_digest
            || result.idempotency_key != promotion.decision.idempotency_key
            || result.outcome != PromotionResultOutcomeV1::ReconciliationRequired
            || expected_git_binding.target_ref != target_ref
            || expected_git_binding.candidate_commit_sha != candidate.candidate_commit_sha
            || expected_git_binding.merged_tree_digest != candidate.tree_digest
            || expected_git_binding.merged_head_sha != result.merged_head_sha
            || claim.claim.promotion_decision_event_ref != request.promotion_decision_event_id
            || claim.claim.promotion_decision_event_digest != promotion.decision.event_digest
            || claim.claim.dispatch_event_ref != workflow.dispatch.event_id
            || claim.claim.dispatch_envelope_digest != workflow.dispatch.envelope_digest
            || claim.claim.run_id != run_id_text
            || claim.claim.candidate_digest != candidate.candidate_digest
            || claim.claim.candidate_ref != candidate.candidate_ref
            || claim.claim.candidate_commit_sha != candidate.candidate_commit_sha
            || claim.claim.candidate_tree_digest != candidate.tree_digest
            || claim.claim.base_commit_sha != candidate.base_commit_sha
            || claim.claim.target_ref != target_ref
            || claim.claim.idempotency_key != promotion.decision.idempotency_key
            || lease_binding.promotion_execution_claim_event_ref != claim.event_id
            || lease_binding.promotion_execution_claim_event_digest != claim.event_digest
            || lease_binding.lease_id != claim.claim.lease_id
        {
            return BrokerPromotionReconciliationDisposition::ReconciliationRequired;
        }
        if let Some(reconciliation) = promotion.reconciliation.as_ref() {
            if workflow.phase != WorkflowPhaseV1::PromotionReconciliationResolved
                || reconciliation.event_digest.trim().is_empty()
                || reconciliation.candidate_digest != candidate.candidate_digest
                || reconciliation.promotion_decision_ref
                    != request.promotion_decision_event_id.to_string()
                || reconciliation.promotion_result_ref != result.event_id.to_string()
                || reconciliation.promotion_receipt_ref != expected_receipt_ref
                || reconciliation.outcome != ReconciliationResolutionOutcomeV1::Abandon
                || reconciliation.authority != promotion.decision.authority
                || reconciliation.resolved_by != promotion.decision.authority
                || reconciliation.authority != self.operator_signer.actor_id
                || reconciliation.resolved_by != self.operator_signer.actor_id
                || reconciliation.idempotency_key
                    != format!(
                        "promotion-reconciliation-abandon:{}",
                        promotion.decision.idempotency_key
                    )
            {
                return BrokerPromotionReconciliationDisposition::ReconciliationRequired;
            }
            // The reconciliation event is already in a fully trusted,
            // checkpointed snapshot. Do not re-observe mutable Git state or
            // re-enter the writer merely to answer an exact duplicate.
            return BrokerPromotionReconciliationDisposition::Existing;
        } else if workflow.phase != WorkflowPhaseV1::PromotionReconciliationRequired {
            return BrokerPromotionReconciliationDisposition::ReconciliationRequired;
        }

        let capability = match VerifiedPromotionCapability::from_verified_facts(
            candidate.candidate_digest.clone(),
            candidate.candidate_ref.clone(),
            candidate.candidate_commit_sha.clone(),
            candidate.tree_digest.clone(),
            candidate.base_commit_sha.clone(),
            target_ref.to_string(),
            promotion.decision.idempotency_key.clone(),
        ) {
            Ok(capability) => capability,
            Err(_) => return BrokerPromotionReconciliationDisposition::ReconciliationRequired,
        };
        let observation = match self.gateway.observe_existing_receipt(capability) {
            Ok(observation) => observation,
            Err(_) => return BrokerPromotionReconciliationDisposition::ReconciliationRequired,
        };
        if observation.ledger_outcome() != PromotionResultOutcomeV1::ReconciliationRequired
            || observation.binding() != &expected_git_binding
        {
            return BrokerPromotionReconciliationDisposition::ReconciliationRequired;
        }

        match self
            .store
            .record_governed_promotion_reconciliation_abandon_v1(
                &GovernedPromotionReconciliationRequestV1 {
                    run_id: self.run_id,
                    promotion_decision_event_id: request.promotion_decision_event_id,
                    promotion_result_event_id: result.event_id,
                },
                self.authority,
                self.operator_signing_key,
                self.operator_signer,
                self.kernel_signing_key,
                self.kernel_signer,
            ) {
            Ok(GovernedPromotionReconciliationDispositionV1::Recorded {
                outcome: ReconciliationResolutionOutcomeV1::Abandon,
                ..
            }) => BrokerPromotionReconciliationDisposition::Recorded,
            Ok(GovernedPromotionReconciliationDispositionV1::Existing {
                outcome: ReconciliationResolutionOutcomeV1::Abandon,
                ..
            }) => BrokerPromotionReconciliationDisposition::Existing,
            Ok(_) | Err(_) => BrokerPromotionReconciliationDisposition::ReconciliationRequired,
        }
    }
}

/// Controller-safe state: no lease, evidence, signer, CAS, prompt, or provider
/// data can cross this boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BrokerModelActionStatus {
    Pending,
    /// A durable successful terminal result. This is the only completion state
    /// that a controller may treat as reusable success.
    Recorded,
    /// A durable, known terminal failure. It is not a retry permit.
    Failed,
    LeaseExpired,
    ReconciliationRequired,
}

fn status_for_terminal_outcome(outcome: ActivityResultOutcomeV1) -> BrokerModelActionStatus {
    match outcome {
        ActivityResultOutcomeV1::Succeeded => BrokerModelActionStatus::Recorded,
        ActivityResultOutcomeV1::Failed => BrokerModelActionStatus::Failed,
        // Unknown effects are durable evidence of ambiguity, never successful
        // completion and never permission to repeat the provider call.
        ActivityResultOutcomeV1::Unknown => BrokerModelActionStatus::ReconciliationRequired,
    }
}

/// Terminal material produced inside the credential-owning gateway.
///
/// This is not a client request. The broker creates the gateway at startup and
/// controllers cannot supply or mutate this value.
pub(crate) struct GatewayCompletion {
    outcome: ActivityResultOutcomeV1,
    result_digest: Option<String>,
    result_ref: Option<String>,
    evidence_digest: String,
    evidence_ref: String,
}

impl GatewayCompletion {
    /// Explicit terminal evidence for a provider failure whose external effect
    /// cannot be proven. Unknown is durable and never a retry permit.
    #[allow(dead_code)]
    fn unknown(evidence_digest: String, evidence_ref: String) -> Self {
        Self {
            outcome: ActivityResultOutcomeV1::Unknown,
            result_digest: None,
            result_ref: None,
            evidence_digest,
            evidence_ref,
        }
    }
}

/// One provider-effect authority. It is intentionally opaque, private,
/// non-serializable, and non-cloneable. Completion consumes it.
pub(crate) struct PrivateModelCapability {
    run_id: RunId,
    dispatch_event_id: EventId,
    action_request_event_id: EventId,
    execution_role: bp_ledger::payload::trust_spine::ExecutionRoleV1,
    lease_id: String,
    authorization_ref: String,
}

impl PrivateModelCapability {
    fn complete(self, completion: GatewayCompletion) -> PairedGatewayResult {
        PairedGatewayResult {
            capability: self,
            completion,
        }
    }
}

/// A terminal gateway result that cannot exist without consuming the exact
/// private capability delivered for that call.
pub(crate) struct PairedGatewayResult {
    capability: PrivateModelCapability,
    completion: GatewayCompletion,
}

/// Implemented only by the credential-owning broker realm. It receives no raw
/// lease and cannot clone or serialize the opaque capability.
pub(crate) trait CredentialGateway {
    /// Implementations must catch provider errors and return paired `Unknown`
    /// evidence. This intentionally has no ordinary error return after a
    /// capability has crossed the effect boundary.
    fn invoke(&mut self, capability: PrivateModelCapability) -> PairedGatewayResult;
}

/// Closed proof returned by the mandatory trusted-replay gate. The broker
/// compares every field with its startup-bound run and minimal request before
/// it permits the storage primitive to execute.
pub(crate) struct TrustedReplayBinding {
    run_id: RunId,
    dispatch_event_id: EventId,
    action_request_event_id: EventId,
    dispatch_role: bp_ledger::payload::trust_spine::ExecutionRoleV1,
    action_role: bp_ledger::payload::trust_spine::ExecutionRoleV1,
    has_existing_claim: bool,
}

pub(crate) trait TrustedReplayVerifier {
    fn verify_exact_action(
        &mut self,
        run_id: RunId,
        request: &BrokerModelActionRequest,
    ) -> Result<TrustedReplayBinding, TrustedReplayVerificationError>;
}

#[derive(Debug, Error)]
pub(crate) enum TrustedReplayVerificationError {
    #[error("trusted replay rejected the model action: {reason}")]
    Rejected { reason: String },
    #[error(transparent)]
    Snapshot(#[from] TrustedGovernedRecoveryError),
}

/// Narrow durable backend seam. Production delegates to the existing atomic
/// ledger primitive; tests use a fake without importing private CLI symbols.
pub(crate) trait AuthorityBackend {
    fn authorize_and_claim(
        &mut self,
        run_id: RunId,
        request: &BrokerModelActionRequest,
        execution_role: bp_ledger::payload::trust_spine::ExecutionRoleV1,
        lease_duration_ms: u64,
    ) -> Result<AuthorityGrant, AuthorityBackendError>;

    fn record_result(
        &mut self,
        run_id: RunId,
        lease_id: String,
        completion: GatewayCompletion,
    ) -> Result<ResultDisposition, AuthorityBackendError>;
}

pub(crate) enum AuthorityGrant {
    Granted {
        run_id: RunId,
        lease_id: String,
        authorization_ref: String,
    },
    Pending {
        run_id: RunId,
    },
    Recorded {
        run_id: RunId,
        outcome: ActivityResultOutcomeV1,
    },
    LeaseExpired {
        run_id: RunId,
    },
}

pub(crate) enum ResultDisposition {
    Recorded {
        run_id: RunId,
        outcome: ActivityResultOutcomeV1,
    },
    LeaseExpired {
        run_id: RunId,
    },
}

#[derive(Debug, Error)]
pub(crate) enum AuthorityBackendError {
    #[error(transparent)]
    TrustedReplay(#[from] TrustedReplayVerificationError),
    #[error("trusted replay returned a binding outside the startup-bound run/action")]
    TrustedReplayBindingMismatch,
    #[error("durable model authority requires reconciliation")]
    ReconciliationRequired,
    #[error(transparent)]
    Ledger(#[from] LedgerError),
}

impl AuthorityBackendError {
    fn from_ledger(error: LedgerError) -> Self {
        match error {
            LedgerError::ModelActionAuthorizationReconciliationRequired { .. } => {
                Self::ReconciliationRequired
            }
            other => Self::Ledger(other),
        }
    }
}

/// Private orchestrator that keeps issuance, gateway use, and result pairing
/// in one broker-owned call frame.
pub(crate) struct BrokerModelAuthority<V, B, G> {
    run_id: RunId,
    expected_role: bp_ledger::payload::trust_spine::ExecutionRoleV1,
    verifier: V,
    backend: B,
    gateway: G,
    lease_policy: LeasePolicy,
}

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum BrokerModelAuthorityStartupErrorV1 {
    #[error("execution role cannot own a model effect authority")]
    UnsupportedExecutionRole,
}

impl<V, B, G> BrokerModelAuthority<V, B, G>
where
    V: TrustedReplayVerifier,
    B: AuthorityBackend,
    G: CredentialGateway,
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
            expected_role: bp_ledger::payload::trust_spine::ExecutionRoleV1::Implementer,
            verifier,
            backend,
            gateway,
            lease_policy,
        }
    }

    pub(crate) fn new_for_role(
        run_id: RunId,
        expected_role: bp_ledger::payload::trust_spine::ExecutionRoleV1,
        verifier: V,
        backend: B,
        gateway: G,
        lease_policy: LeasePolicy,
    ) -> Result<Self, BrokerModelAuthorityStartupErrorV1> {
        if !matches!(
            expected_role,
            bp_ledger::payload::trust_spine::ExecutionRoleV1::Implementer
                | bp_ledger::payload::trust_spine::ExecutionRoleV1::Reviewer
                | bp_ledger::payload::trust_spine::ExecutionRoleV1::Adversary
                | bp_ledger::payload::trust_spine::ExecutionRoleV1::Judge
        ) {
            return Err(BrokerModelAuthorityStartupErrorV1::UnsupportedExecutionRole);
        }
        Ok(Self {
            run_id,
            expected_role,
            verifier,
            backend,
            gateway,
            lease_policy,
        })
    }

    pub(crate) fn authorize_and_execute(
        &mut self,
        request: BrokerModelActionRequest,
    ) -> Result<BrokerModelActionStatus, AuthorityBackendError> {
        let replay_binding = self.verifier.verify_exact_action(self.run_id, &request)?;
        if replay_binding.run_id != self.run_id
            || replay_binding.dispatch_event_id != request.dispatch_event_id
            || replay_binding.action_request_event_id != request.action_request_event_id
            || replay_binding.dispatch_role != self.expected_role
            || replay_binding.action_role != self.expected_role
        {
            return Err(AuthorityBackendError::TrustedReplayBindingMismatch);
        }
        let replay_already_claimed = replay_binding.has_existing_claim;

        let grant = match self.backend.authorize_and_claim(
            self.run_id,
            &request,
            self.expected_role,
            self.lease_policy.duration_ms(),
        ) {
            Ok(grant) => grant,
            Err(AuthorityBackendError::ReconciliationRequired) => {
                return Ok(BrokerModelActionStatus::ReconciliationRequired)
            }
            Err(_) if replay_already_claimed => {
                return Ok(BrokerModelActionStatus::ReconciliationRequired)
            }
            Err(error) => return Err(error),
        };

        let capability = match grant {
            AuthorityGrant::Granted {
                run_id,
                lease_id,
                authorization_ref,
            } if run_id == self.run_id && !replay_already_claimed => PrivateModelCapability {
                run_id,
                dispatch_event_id: request.dispatch_event_id,
                action_request_event_id: request.action_request_event_id,
                execution_role: self.expected_role,
                lease_id,
                authorization_ref,
            },
            AuthorityGrant::Pending { run_id } if run_id == self.run_id => {
                return Ok(BrokerModelActionStatus::Pending)
            }
            AuthorityGrant::Recorded { run_id, outcome } if run_id == self.run_id => {
                return Ok(status_for_terminal_outcome(outcome))
            }
            AuthorityGrant::LeaseExpired { run_id } if run_id == self.run_id => {
                return Ok(BrokerModelActionStatus::LeaseExpired)
            }
            _ => return Ok(BrokerModelActionStatus::ReconciliationRequired),
        };

        let paired = self.gateway.invoke(capability);
        let disposition = match self.backend.record_result(
            paired.capability.run_id,
            paired.capability.lease_id,
            paired.completion,
        ) {
            Ok(disposition) => disposition,
            // A provider call has already happened. Any uncertainty about the
            // terminal write is reconciliation-only and can never authorize a
            // second gateway entry.
            Err(_) => return Ok(BrokerModelActionStatus::ReconciliationRequired),
        };
        Ok(match disposition {
            ResultDisposition::Recorded { run_id, outcome } if run_id == self.run_id => {
                status_for_terminal_outcome(outcome)
            }
            // This expiry is observed only after the credential gateway has
            // crossed the provider-effect boundary. It is therefore
            // externally ambiguous, unlike a grant-side expiry that occurs
            // before any gateway entry.
            ResultDisposition::LeaseExpired { run_id } if run_id == self.run_id => {
                BrokerModelActionStatus::ReconciliationRequired
            }
            _ => BrokerModelActionStatus::ReconciliationRequired,
        })
    }
}

/// Full-tape, pinned-checkpoint verifier for the production composition. It
/// reopens an immutable snapshot on every request so a prior checkpoint can
/// never bless a later unverified action tail.
pub(crate) struct ReplaySnapshotVerifier<'a> {
    database_path: PathBuf,
    authorities: &'a TrustedReplayAuthorities,
    pinned_kernel_signer: &'a ActorKeyRef,
}

impl<'a> ReplaySnapshotVerifier<'a> {
    #[allow(dead_code)]
    fn from_prevalidated_startup(
        database_path: impl AsRef<Path>,
        authorities: &'a TrustedReplayAuthorities,
        pinned_kernel_signer: &'a ActorKeyRef,
    ) -> Self {
        Self {
            database_path: database_path.as_ref().to_path_buf(),
            authorities,
            pinned_kernel_signer,
        }
    }
}

impl TrustedReplayVerifier for ReplaySnapshotVerifier<'_> {
    fn verify_exact_action(
        &mut self,
        run_id: RunId,
        request: &BrokerModelActionRequest,
    ) -> Result<TrustedReplayBinding, TrustedReplayVerificationError> {
        let run_id_text = run_id.to_string();
        let snapshot = TrustedGovernedRecoverySnapshot::open_bounded_v1(
            &run_id_text,
            &self.database_path,
            self.authorities,
            self.pinned_kernel_signer,
        )?;
        if snapshot.run_id() != run_id_text {
            return Err(TrustedReplayVerificationError::Rejected {
                reason: "verified snapshot belongs to a different run".into(),
            });
        }
        let dispatch_event_ref = request.dispatch_event_id.to_string();
        let workflow = snapshot
            .workflow_for_dispatch_event_ref(&dispatch_event_ref)
            .ok_or_else(|| TrustedReplayVerificationError::Rejected {
                reason: "verified snapshot does not contain the exact dispatch".into(),
            })?;
        if workflow.run_id != run_id_text || workflow.dispatch.event_id != request.dispatch_event_id
        {
            return Err(TrustedReplayVerificationError::Rejected {
                reason: "verified workflow does not bind the startup run and dispatch".into(),
            });
        }
        let action = workflow
            .action_evidence
            .as_ref()
            .and_then(|evidence| {
                evidence
                    .actions
                    .values()
                    .find(|action| action.request.event_id == request.action_request_event_id)
            })
            .ok_or_else(|| TrustedReplayVerificationError::Rejected {
                reason: "verified workflow does not contain the exact action request".into(),
            })?;
        if action.request.action_kind != bp_ledger::payload::trust_spine::ActionKindV1::Model {
            return Err(TrustedReplayVerificationError::Rejected {
                reason: "verified action request is not a model action".into(),
            });
        }
        Ok(TrustedReplayBinding {
            run_id,
            dispatch_event_id: workflow.dispatch.event_id,
            action_request_event_id: action.request.event_id,
            dispatch_role: workflow.dispatch.execution_role,
            action_role: action.request.execution_role,
            has_existing_claim: action.activity_claim.is_some(),
        })
    }
}

/// Production binding over startup-injected, prevalidated protected-realm
/// dependencies. This type is private until an OS peer-authenticated broker
/// process with credential isolation owns its construction.
pub(crate) struct LedgerAuthorityBackend<'a> {
    store: &'a SqliteStore,
    cas: &'a Cas,
    authority: &'a ActivityClaimAuthorityV1,
    signing_key: &'a SigningKey,
    signer: &'a ActorKeyRef,
}

impl<'a> LedgerAuthorityBackend<'a> {
    #[allow(dead_code)]
    fn from_prevalidated_startup(
        store: &'a SqliteStore,
        cas: &'a Cas,
        authority: &'a ActivityClaimAuthorityV1,
        signing_key: &'a SigningKey,
        signer: &'a ActorKeyRef,
    ) -> Self {
        Self {
            store,
            cas,
            authority,
            signing_key,
            signer,
        }
    }
}

impl AuthorityBackend for LedgerAuthorityBackend<'_> {
    fn authorize_and_claim(
        &mut self,
        run_id: RunId,
        request: &BrokerModelActionRequest,
        execution_role: bp_ledger::payload::trust_spine::ExecutionRoleV1,
        lease_duration_ms: u64,
    ) -> Result<AuthorityGrant, AuthorityBackendError> {
        self.store
            .verify_recorded_provider_token_preflight_for_model_action_v1(
                &ProviderTokenPreflightForModelActionRequestV1 {
                    run_id,
                    dispatch_event_id: request.dispatch_event_id,
                    model_action_request_event_id: request.action_request_event_id,
                },
                self.cas,
                self.authority,
            )
            .map_err(AuthorityBackendError::from_ledger)?;
        let request = GovernedModelActionAuthorizeAndClaimRequestV1 {
            run_id,
            dispatch_event_id: request.dispatch_event_id,
            action_request_event_id: request.action_request_event_id,
            lease_duration_ms,
        };
        let disposition = match execution_role {
            bp_ledger::payload::trust_spine::ExecutionRoleV1::Implementer => {
                self.store.authorize_and_claim_governed_model_action_v1(
                    &request,
                    self.cas,
                    self.authority,
                    self.signing_key,
                    self.signer,
                )
            }
            bp_ledger::payload::trust_spine::ExecutionRoleV1::Reviewer
            | bp_ledger::payload::trust_spine::ExecutionRoleV1::Adversary
            | bp_ledger::payload::trust_spine::ExecutionRoleV1::Judge => self
                .store
                .authorize_and_claim_governed_reviewer_model_action_v1(
                    &request,
                    self.cas,
                    self.authority,
                    self.signing_key,
                    self.signer,
                ),
            bp_ledger::payload::trust_spine::ExecutionRoleV1::Candidate => {
                return Err(AuthorityBackendError::TrustedReplayBindingMismatch)
            }
        }
        .map_err(AuthorityBackendError::from_ledger)?;

        Ok(match disposition {
            GovernedModelActionAuthorizeAndClaimDispositionV1::Granted {
                lease_id,
                authorization_ref,
                ..
            } => AuthorityGrant::Granted {
                run_id,
                lease_id,
                authorization_ref,
            },
            GovernedModelActionAuthorizeAndClaimDispositionV1::Pending { .. } => {
                AuthorityGrant::Pending { run_id }
            }
            GovernedModelActionAuthorizeAndClaimDispositionV1::Recorded { outcome, .. } => {
                AuthorityGrant::Recorded { run_id, outcome }
            }
            GovernedModelActionAuthorizeAndClaimDispositionV1::LeaseExpired { .. } => {
                AuthorityGrant::LeaseExpired { run_id }
            }
        })
    }

    fn record_result(
        &mut self,
        run_id: RunId,
        lease_id: String,
        completion: GatewayCompletion,
    ) -> Result<ResultDisposition, AuthorityBackendError> {
        let request = GovernedModelActionResultRequestV1 {
            run_id,
            lease_id,
            outcome: completion.outcome,
            result_digest: completion.result_digest,
            result_ref: completion.result_ref,
            evidence_digest: completion.evidence_digest,
            evidence_ref: completion.evidence_ref,
        };
        let disposition = self
            .store
            .record_governed_model_action_result_v1(
                &request,
                self.cas,
                self.authority,
                self.signing_key,
                self.signer,
            )
            .map_err(AuthorityBackendError::from_ledger)?;

        Ok(match disposition {
            ActivityResultDispositionV1::Recorded { outcome, .. } => {
                ResultDisposition::Recorded { run_id, outcome }
            }
            ActivityResultDispositionV1::LeaseExpired { .. } => {
                ResultDisposition::LeaseExpired { run_id }
            }
        })
    }
}

#[cfg(test)]
mod tests;
