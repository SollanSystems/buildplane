//! Broker-private composition for durable governed model authority.
//!
//! This crate intentionally exposes no public authority endpoint. It is a
//! composition boundary for a future broker process whose startup must inject
//! an already-open protected ledger/CAS realm, trusted signer configuration,
//! and credential-owning gateway. Production OS peer authentication and
//! credential isolation remain integration gates; this crate must not be wired
//! to `buildplane-native`, the generic ledger server, or a same-UID signer.
//! A production gateway must convert every catchable provider failure after
//! capability receipt into paired `Unknown` evidence. Process death or panic
//! before that pairing still requires an OS-supervised reconciliation path and
//! is not claimed as solved by this in-process slice.

use bp_ledger::error::LedgerError;
use bp_ledger::payload::activity_claim::ActivityResultOutcomeV1;
use bp_ledger::signing::ActorKeyRef;
use bp_ledger::storage::sqlite::{
    ActivityClaimAuthorityV1, ActivityResultDispositionV1,
    GovernedModelActionAuthorizeAndClaimDispositionV1,
    GovernedModelActionAuthorizeAndClaimRequestV1, GovernedModelActionResultRequestV1,
    GovernedPromotionAuthorityV1, GovernedPromotionDecisionDispositionV1,
    GovernedPromotionDecisionRequestV1, GovernedPromotionDecisionSealRequestV1, SqliteStore,
    MAX_ACTIVITY_LEASE_MS, MIN_ACTIVITY_LEASE_MS,
};
use bp_ledger::storage::Cas;
use bp_ledger::{EventId, RunId};
use bp_replay::{
    TrustedGovernedRecoveryError, TrustedGovernedRecoverySnapshot, TrustedReplayAuthorities,
};
use ed25519_dalek::SigningKey;
use std::path::{Path, PathBuf};
use thiserror::Error;

mod promotion_execution;
mod promotion_git;

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
    lease_id: String,
    #[allow(dead_code)]
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
    verifier: V,
    backend: B,
    gateway: G,
    lease_policy: LeasePolicy,
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
            verifier,
            backend,
            gateway,
            lease_policy,
        }
    }

    pub(crate) fn authorize_and_execute(
        &mut self,
        request: BrokerModelActionRequest,
    ) -> Result<BrokerModelActionStatus, AuthorityBackendError> {
        let replay_binding = self.verifier.verify_exact_action(self.run_id, &request)?;
        if replay_binding.run_id != self.run_id
            || replay_binding.dispatch_event_id != request.dispatch_event_id
            || replay_binding.action_request_event_id != request.action_request_event_id
            || replay_binding.dispatch_role
                != bp_ledger::payload::trust_spine::ExecutionRoleV1::Implementer
            || replay_binding.action_role
                != bp_ledger::payload::trust_spine::ExecutionRoleV1::Implementer
        {
            return Err(AuthorityBackendError::TrustedReplayBindingMismatch);
        }
        let replay_already_claimed = replay_binding.has_existing_claim;

        let grant = match self.backend.authorize_and_claim(
            self.run_id,
            &request,
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
        lease_duration_ms: u64,
    ) -> Result<AuthorityGrant, AuthorityBackendError> {
        let request = GovernedModelActionAuthorizeAndClaimRequestV1 {
            run_id,
            dispatch_event_id: request.dispatch_event_id,
            action_request_event_id: request.action_request_event_id,
            lease_duration_ms,
        };
        let disposition = self
            .store
            .authorize_and_claim_governed_model_action_v1(
                &request,
                self.cas,
                self.authority,
                self.signing_key,
                self.signer,
            )
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
