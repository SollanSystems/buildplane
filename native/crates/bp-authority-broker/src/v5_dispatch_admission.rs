//! Broker-private composition for a sealed V5 admission receipt.
//!
//! The caller names only a run and an already-signed V5 source dispatch. The
//! protected ledger re-derives every graph and manifest witness, records the
//! separate host admission receipt, and seals its exact tape prefix. This
//! module returns recovery evidence only: it deliberately has no action,
//! worker, lease, capability, candidate, or promotion surface.

use bp_ledger::signing::ActorKeyRef;
use bp_ledger::storage::sqlite::{
    GovernedDispatchV5AdmissionAuthorityV1, GovernedDispatchV5AdmissionDispositionV1,
    GovernedDispatchV5AdmissionRequestV1, GovernedDispatchV5AdmissionSealRequestV1, SqliteStore,
};
use bp_ledger::{EventId, RunId};
use ed25519_dalek::SigningKey;
use thiserror::Error;

/// The entire caller-controlled request surface for the V5 admission
/// composition. The source envelope, manifests, signer identities, and all
/// authority facts remain in protected startup dependencies or signed tape.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct V5DispatchAdmissionRequest {
    pub(crate) run_id: RunId,
    pub(crate) source_dispatch_event_id: EventId,
}

/// Only sealed, immutable evidence can leave this composition. In particular,
/// `ReconciliationRequired` never grants a retry permit or authority.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum BrokerV5DispatchAdmissionDisposition {
    Sealed(SealedV5DispatchAdmissionEvidence),
    ReconciliationRequired,
}

/// Closed evidence for one sealed V5 admission transaction.
///
/// All fields identify signed historical records or their canonical digests.
/// This is intentionally not a capability: it lacks worker, action, lease,
/// path, tool, secret, candidate, and promotion data.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SealedV5DispatchAdmissionEvidence {
    pub(crate) run_id: RunId,
    pub(crate) source_dispatch_event_id: EventId,
    pub(crate) source_dispatch_event_digest: String,
    pub(crate) admission_event_id: EventId,
    pub(crate) admission_event_digest: String,
    pub(crate) v5_envelope_digest: String,
    pub(crate) witness_evidence_digest: String,
    pub(crate) semantic_identity_digest: String,
    pub(crate) idempotency_key: String,
    pub(crate) checkpoint_event_id: EventId,
    pub(crate) checkpoint_event_digest: String,
}

/// Startup validation for the two signing channels retained in the protected
/// broker process. The V5 ledger authority separately enforces the complete
/// three-way source/admission/checkpoint identity split.
#[derive(Debug, Error, PartialEq, Eq)]
pub(crate) enum V5DispatchAdmissionStartupError {
    #[error("governed V5 admission and checkpoint signing keys must use distinct material")]
    SharedSigningKeyMaterial,
    #[error("governed V5 admission and checkpoint signer identities must be distinct")]
    SharedSignerIdentity,
}

/// One protected-host V5 record-then-exact-seal composition.
///
/// This is crate-private until an authenticated broker host supplies its
/// startup dependencies. It must not be attached to the generic ledger
/// server, TypeScript broker protocol, CLI, or any action/promotion path.
pub(crate) struct LedgerV5DispatchAdmissionBackend<'a> {
    store: &'a SqliteStore,
    authority: &'a GovernedDispatchV5AdmissionAuthorityV1,
    admission_signing_key: &'a SigningKey,
    admission_signer: &'a ActorKeyRef,
    checkpoint_signing_key: &'a SigningKey,
    checkpoint_signer: &'a ActorKeyRef,
}

impl<'a> LedgerV5DispatchAdmissionBackend<'a> {
    /// Construct only from protected startup dependencies. Per-request
    /// signer/configuration injection is intentionally impossible.
    pub(crate) fn from_prevalidated_startup(
        store: &'a SqliteStore,
        authority: &'a GovernedDispatchV5AdmissionAuthorityV1,
        admission_signing_key: &'a SigningKey,
        admission_signer: &'a ActorKeyRef,
        checkpoint_signing_key: &'a SigningKey,
        checkpoint_signer: &'a ActorKeyRef,
    ) -> Result<Self, V5DispatchAdmissionStartupError> {
        if admission_signing_key.to_bytes() == checkpoint_signing_key.to_bytes() {
            return Err(V5DispatchAdmissionStartupError::SharedSigningKeyMaterial);
        }
        if admission_signer == checkpoint_signer {
            return Err(V5DispatchAdmissionStartupError::SharedSignerIdentity);
        }
        Ok(Self {
            store,
            authority,
            admission_signing_key,
            admission_signer,
            checkpoint_signing_key,
            checkpoint_signer,
        })
    }

    /// Record then exactly seal a separately signed V5 admission receipt.
    ///
    /// Every non-sealed state, ledger failure, or value substitution is
    /// reconciliation-only. A record retry may resolve an existing receipt,
    /// but the exact receipt identity is always sent back through the seal
    /// transaction before evidence is returned.
    pub(crate) fn record_then_exact_seal(
        &self,
        request: V5DispatchAdmissionRequest,
    ) -> BrokerV5DispatchAdmissionDisposition {
        let recorded = match self.store.record_governed_dispatch_v5_admission_v1(
            &GovernedDispatchV5AdmissionRequestV1 {
                run_id: request.run_id,
                dispatch_event_id: request.source_dispatch_event_id,
            },
            self.authority,
            self.admission_signing_key,
            self.admission_signer,
        ) {
            Ok(recorded) => recorded,
            Err(_) => return BrokerV5DispatchAdmissionDisposition::ReconciliationRequired,
        };
        let recorded = match RecordedV5AdmissionFacts::from_recorded(recorded, &request) {
            Some(recorded) => recorded,
            None => return BrokerV5DispatchAdmissionDisposition::ReconciliationRequired,
        };

        let sealed = match self.store.seal_governed_dispatch_v5_admission_v1(
            &GovernedDispatchV5AdmissionSealRequestV1 {
                run_id: request.run_id,
                admission_event_id: recorded.admission_event_id,
            },
            self.authority,
            self.checkpoint_signing_key,
            self.checkpoint_signer,
        ) {
            Ok(GovernedDispatchV5AdmissionDispositionV1::Sealed {
                source_dispatch_event_id,
                source_dispatch_event_digest,
                admission_event_id,
                admission_event_digest,
                v5_envelope_digest,
                witness_evidence_digest,
                semantic_identity_digest,
                idempotency_key,
                checkpoint_event_id,
                checkpoint_event_digest,
            }) => SealedV5DispatchAdmissionEvidence {
                run_id: request.run_id,
                source_dispatch_event_id,
                source_dispatch_event_digest,
                admission_event_id,
                admission_event_digest,
                v5_envelope_digest,
                witness_evidence_digest,
                semantic_identity_digest,
                idempotency_key,
                checkpoint_event_id,
                checkpoint_event_digest,
            },
            Ok(GovernedDispatchV5AdmissionDispositionV1::AwaitingCheckpoint { .. }) | Err(_) => {
                return BrokerV5DispatchAdmissionDisposition::ReconciliationRequired
            }
        };

        if !recorded.matches_sealed(&sealed, &request) {
            return BrokerV5DispatchAdmissionDisposition::ReconciliationRequired;
        }
        BrokerV5DispatchAdmissionDisposition::Sealed(sealed)
    }
}

/// Facts that must remain invariant across the record and seal transitions.
/// They are not exposed to callers while a receipt is still unsealed.
struct RecordedV5AdmissionFacts {
    source_dispatch_event_id: EventId,
    source_dispatch_event_digest: String,
    admission_event_id: EventId,
    admission_event_digest: String,
    v5_envelope_digest: String,
    witness_evidence_digest: String,
    semantic_identity_digest: String,
    idempotency_key: String,
}

impl RecordedV5AdmissionFacts {
    fn from_recorded(
        disposition: GovernedDispatchV5AdmissionDispositionV1,
        request: &V5DispatchAdmissionRequest,
    ) -> Option<Self> {
        let (
            source_dispatch_event_id,
            source_dispatch_event_digest,
            admission_event_id,
            admission_event_digest,
            v5_envelope_digest,
            witness_evidence_digest,
            semantic_identity_digest,
            idempotency_key,
        ) = match disposition {
            GovernedDispatchV5AdmissionDispositionV1::AwaitingCheckpoint {
                source_dispatch_event_id,
                source_dispatch_event_digest,
                admission_event_id,
                admission_event_digest,
                v5_envelope_digest,
                witness_evidence_digest,
                semantic_identity_digest,
                idempotency_key,
            }
            | GovernedDispatchV5AdmissionDispositionV1::Sealed {
                source_dispatch_event_id,
                source_dispatch_event_digest,
                admission_event_id,
                admission_event_digest,
                v5_envelope_digest,
                witness_evidence_digest,
                semantic_identity_digest,
                idempotency_key,
                ..
            } => (
                source_dispatch_event_id,
                source_dispatch_event_digest,
                admission_event_id,
                admission_event_digest,
                v5_envelope_digest,
                witness_evidence_digest,
                semantic_identity_digest,
                idempotency_key,
            ),
        };
        if source_dispatch_event_id != request.source_dispatch_event_id
            || admission_event_id == source_dispatch_event_id
        {
            return None;
        }
        Some(Self {
            source_dispatch_event_id,
            source_dispatch_event_digest,
            admission_event_id,
            admission_event_digest,
            v5_envelope_digest,
            witness_evidence_digest,
            semantic_identity_digest,
            idempotency_key,
        })
    }

    fn matches_sealed(
        &self,
        sealed: &SealedV5DispatchAdmissionEvidence,
        request: &V5DispatchAdmissionRequest,
    ) -> bool {
        sealed.run_id == request.run_id
            && sealed.source_dispatch_event_id == request.source_dispatch_event_id
            && sealed.source_dispatch_event_id == self.source_dispatch_event_id
            && sealed.source_dispatch_event_digest == self.source_dispatch_event_digest
            && sealed.admission_event_id == self.admission_event_id
            && sealed.admission_event_id != sealed.source_dispatch_event_id
            && sealed.admission_event_digest == self.admission_event_digest
            && sealed.v5_envelope_digest == self.v5_envelope_digest
            && sealed.witness_evidence_digest == self.witness_evidence_digest
            && sealed.semantic_identity_digest == self.semantic_identity_digest
            && sealed.idempotency_key == self.idempotency_key
            && sealed.checkpoint_event_id != sealed.source_dispatch_event_id
            && sealed.checkpoint_event_id != sealed.admission_event_id
    }
}
