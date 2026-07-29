//! Broker-private composition for one sealed governed-dispatch admission.
//!
//! This module deliberately accepts only an already parsed strict broker
//! request. Opaque `broker://` and `cas://` references remain resolver-owned
//! registry keys: they are never treated as paths or decoded as raw CAS
//! digests here. A protected host must inject the resolver, ledger backend,
//! and fresh trusted-replay verifier before this composition can become part
//! of a real authenticated broker process.

use crate::admission_protocol::{
    AuthorityBrokerOperationV1, ParsedAuthorityBrokerAdmitRequestV1,
    ParsedAuthorityBrokerRequestBodyV1, ParsedAuthorityBrokerRequestV1,
};
use bp_ledger::canonicalize::canonical_event_hash;
use bp_ledger::error::LedgerError;
use bp_ledger::kind::EventKind;
use bp_ledger::payload::checkpoint::{tape_root_hash, TapeRootAlgorithm};
use bp_ledger::payload::trust_spine::{
    ActionEvidenceVersionV1, CommitModeV1, ExecutionRoleV1, TrustTierV1,
};
use bp_ledger::payload::Payload;
use bp_ledger::signing::ActorKeyRef;
use bp_ledger::storage::sqlite::{
    GovernedDispatchAdmissionAuthorityV1, GovernedDispatchAdmissionDispositionV1,
    GovernedDispatchAdmissionRequestV1, GovernedDispatchAdmissionSealRequestV1, SqliteStore,
};
use bp_ledger::{EventId, RunId};
use bp_replay::{
    TrustedGovernedRecoveryError, TrustedGovernedRecoverySnapshot, TrustedReplayAuthorities,
};
use ed25519_dalek::SigningKey;
use std::path::{Path, PathBuf};
use thiserror::Error;

/// The only completion state surfaced by this private composition.
///
/// The proof is sealed recovery evidence only. It contains no packet bytes,
/// unsigned envelope, pre-seal disposition, signer material, or reusable
/// capability.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum BrokerDispatchAdmissionDisposition {
    Sealed(BrokerSealedDispatchAdmissionProof),
    ReconciliationRequired,
}

/// Opaque, crate-private identity of a sealed admission.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BrokerSealedDispatchAdmissionProof {
    dispatch_event_id: EventId,
    dispatch_event_digest: String,
    envelope_digest: String,
    checkpoint_event_id: EventId,
    checkpoint_event_digest: String,
}

impl From<SealedDispatchAdmissionEvidence> for BrokerSealedDispatchAdmissionProof {
    fn from(value: SealedDispatchAdmissionEvidence) -> Self {
        Self {
            dispatch_event_id: value.dispatch_event_id,
            dispatch_event_digest: value.dispatch_event_digest,
            envelope_digest: value.envelope_digest,
            checkpoint_event_id: value.checkpoint_event_id,
            checkpoint_event_digest: value.checkpoint_event_digest,
        }
    }
}

/// Injected protected-host registry boundary.
///
/// Implementations must resolve the opaque repository and packet references
/// through protected registries only. Before returning, they must have checked
/// those references and constructed an already normalized ledger request for
/// the complete run/workflow/revision/unit/attempt/idempotency tuple plus the
/// expected repository-binding and governed-packet digests. The composition
/// repeats the tuple/digest comparison before it calls its ledger backend.
pub(crate) trait DispatchAdmissionRequestResolver {
    fn resolve_exact_admit(
        &mut self,
        admit: &ParsedAuthorityBrokerAdmitRequestV1,
    ) -> Result<ResolvedDispatchAdmission, DispatchAdmissionResolverError>;
}

#[derive(Debug, Error)]
#[allow(dead_code)]
pub(crate) enum DispatchAdmissionResolverError {
    #[error(
        "protected dispatch-admission resolver rejected the opaque registry request: {reason}"
    )]
    Rejected { reason: String },
}

/// Protected registry resolution that binds opaque references to the exact
/// normalized ledger request. The broker compares both references with the
/// strict parsed request before any ledger write.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ResolvedDispatchAdmission {
    request: GovernedDispatchAdmissionRequestV1,
    repository_target_ref: String,
    governed_packet_ref: String,
}

impl ResolvedDispatchAdmission {
    /// Construct only at the protected registry boundary after resolving the
    /// opaque references. This does not parse paths or raw CAS digests.
    pub(crate) fn from_protected_registry(
        request: GovernedDispatchAdmissionRequestV1,
        repository_target_ref: String,
        governed_packet_ref: String,
    ) -> Self {
        Self {
            request,
            repository_target_ref,
            governed_packet_ref,
        }
    }
}

/// Sealed facts produced only by the durable record-then-seal boundary.
///
/// This is internal glue between the ledger and snapshot seams. It is not a
/// controller response and cannot represent an awaiting checkpoint state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SealedDispatchAdmissionEvidence {
    pub(crate) run_id: RunId,
    pub(crate) dispatch_event_id: EventId,
    pub(crate) dispatch_event_digest: String,
    pub(crate) envelope_digest: String,
    pub(crate) checkpoint_event_id: EventId,
    pub(crate) checkpoint_event_digest: String,
}

/// Injected durable transition seam. Production must use independent dispatch
/// and checkpoint signers; it may never return `AwaitingCheckpoint`.
pub(crate) trait DispatchAdmissionBackend {
    fn record_then_exact_seal(
        &mut self,
        request: &GovernedDispatchAdmissionRequestV1,
    ) -> Result<SealedDispatchAdmissionEvidence, DispatchAdmissionBackendError>;
}

#[derive(Debug, Error)]
pub(crate) enum DispatchAdmissionBackendError {
    #[error(transparent)]
    Ledger(#[from] LedgerError),
    #[error("governed dispatch admission remained awaiting a checkpoint")]
    AwaitingCheckpoint,
    #[error("record and seal returned different governed dispatch identities")]
    SealIdentityMismatch,
}

/// Injected postcondition seam. It must reopen trusted recovery after the
/// seal and verify the exact sealed evidence; cached or pre-seal snapshots are
/// not sufficient.
pub(crate) trait DispatchAdmissionSnapshotVerifier {
    fn verify_fresh_sealed_admission(
        &mut self,
        request: &GovernedDispatchAdmissionRequestV1,
        sealed: &SealedDispatchAdmissionEvidence,
    ) -> Result<(), DispatchAdmissionSnapshotError>;
}

#[derive(Debug, Error)]
pub(crate) enum DispatchAdmissionSnapshotError {
    #[error("fresh trusted dispatch-admission snapshot rejected the sealed evidence: {reason}")]
    Rejected { reason: String },
    #[error(transparent)]
    Ledger(#[from] LedgerError),
    #[error(transparent)]
    Snapshot(#[from] TrustedGovernedRecoveryError),
}

/// Private composition over protected host dependencies.
///
/// It accepts no paths, signers, packet bytes, envelopes, CAS roots, or
/// mutable authority assertions from its caller. `LookupPreauthorized` is
/// intentionally a fail-closed no-op in this slice.
pub(crate) struct BrokerDispatchAdmissionAuthority<R, B, V> {
    resolver: R,
    backend: B,
    snapshot_verifier: V,
}

impl<R, B, V> BrokerDispatchAdmissionAuthority<R, B, V>
where
    R: DispatchAdmissionRequestResolver,
    B: DispatchAdmissionBackend,
    V: DispatchAdmissionSnapshotVerifier,
{
    pub(crate) fn new(resolver: R, backend: B, snapshot_verifier: V) -> Self {
        Self {
            resolver,
            backend,
            snapshot_verifier,
        }
    }

    /// Admit one strict parsed request only after a durable seal and a fresh
    /// exact trusted-recovery confirmation. Any uncertainty is reconciliation
    /// evidence, never authority.
    pub(crate) fn admit(
        &mut self,
        parsed: ParsedAuthorityBrokerRequestV1,
    ) -> BrokerDispatchAdmissionDisposition {
        if parsed.schema_version != 1 {
            return BrokerDispatchAdmissionDisposition::ReconciliationRequired;
        }
        let admit = match (parsed.operation, parsed.request) {
            (
                AuthorityBrokerOperationV1::Admit,
                ParsedAuthorityBrokerRequestBodyV1::Admit(admit),
            ) => admit,
            // In particular, `LookupPreauthorized` cannot reach the resolver,
            // ledger, or snapshot verifier in this admission-only slice.
            _ => return BrokerDispatchAdmissionDisposition::ReconciliationRequired,
        };

        let resolved = match self.resolver.resolve_exact_admit(&admit) {
            Ok(resolved) => resolved,
            Err(_) => return BrokerDispatchAdmissionDisposition::ReconciliationRequired,
        };
        if !resolved_matches_parsed_admit(&resolved, &admit)
            || !request_matches_parsed_admit(&resolved.request, &admit)
        {
            return BrokerDispatchAdmissionDisposition::ReconciliationRequired;
        }
        let request = resolved.request;

        let sealed = match self.backend.record_then_exact_seal(&request) {
            Ok(sealed) if sealed_matches_request(&sealed, &request) => sealed,
            Ok(_) | Err(_) => return BrokerDispatchAdmissionDisposition::ReconciliationRequired,
        };
        if self
            .snapshot_verifier
            .verify_fresh_sealed_admission(&request, &sealed)
            .is_err()
        {
            return BrokerDispatchAdmissionDisposition::ReconciliationRequired;
        }

        BrokerDispatchAdmissionDisposition::Sealed(sealed.into())
    }
}

fn resolved_matches_parsed_admit(
    resolved: &ResolvedDispatchAdmission,
    admit: &ParsedAuthorityBrokerAdmitRequestV1,
) -> bool {
    resolved.repository_target_ref == admit.repository_target_ref
        && resolved.governed_packet_ref == admit.governed_packet_ref
}

fn request_matches_parsed_admit(
    request: &GovernedDispatchAdmissionRequestV1,
    admit: &ParsedAuthorityBrokerAdmitRequestV1,
) -> bool {
    request.run_id.to_string() == admit.run_id
        && request.dispatch.body.workflow_id == admit.workflow_id
        && request.dispatch.body.workflow_revision == admit.workflow_revision
        && request.dispatch.body.unit_id == admit.unit_id
        && u64::from(request.dispatch.body.attempt) == admit.attempt
        && request.dispatch.body.idempotency_key == admit.idempotency_key
        && request.dispatch.repository_binding_digest == admit.expected_repository_binding_digest
        && request.dispatch.governed_packet_digest.as_deref()
            == Some(admit.governed_packet_digest.as_str())
}

fn sealed_matches_request(
    sealed: &SealedDispatchAdmissionEvidence,
    request: &GovernedDispatchAdmissionRequestV1,
) -> bool {
    sealed.run_id == request.run_id && sealed.envelope_digest == request.dispatch.envelope_digest
}

/// Startup validation for independently configured durable ledger signers.
#[derive(Debug, Error, PartialEq, Eq)]
pub(crate) enum DispatchAdmissionStartupError {
    #[error("governed dispatch and checkpoint signing keys must use distinct material")]
    SharedSigningKeyMaterial,
    #[error("governed dispatch and checkpoint signer identities must be distinct")]
    SharedSignerIdentity,
}

/// Production ledger adapter over protected startup dependencies.
///
/// It uses the existing specialized record and exact seal operations rather
/// than a generic signed append, and it retains both signer channels inside
/// the protected process boundary.
pub(crate) struct LedgerDispatchAdmissionBackend<'a> {
    store: &'a SqliteStore,
    authority: &'a GovernedDispatchAdmissionAuthorityV1,
    dispatch_signing_key: &'a SigningKey,
    dispatch_signer: &'a ActorKeyRef,
    checkpoint_signing_key: &'a SigningKey,
    checkpoint_signer: &'a ActorKeyRef,
}

impl<'a> LedgerDispatchAdmissionBackend<'a> {
    pub(crate) fn from_prevalidated_startup(
        store: &'a SqliteStore,
        authority: &'a GovernedDispatchAdmissionAuthorityV1,
        dispatch_signing_key: &'a SigningKey,
        dispatch_signer: &'a ActorKeyRef,
        checkpoint_signing_key: &'a SigningKey,
        checkpoint_signer: &'a ActorKeyRef,
    ) -> Result<Self, DispatchAdmissionStartupError> {
        if dispatch_signing_key.to_bytes() == checkpoint_signing_key.to_bytes() {
            return Err(DispatchAdmissionStartupError::SharedSigningKeyMaterial);
        }
        if dispatch_signer == checkpoint_signer {
            return Err(DispatchAdmissionStartupError::SharedSignerIdentity);
        }
        Ok(Self {
            store,
            authority,
            dispatch_signing_key,
            dispatch_signer,
            checkpoint_signing_key,
            checkpoint_signer,
        })
    }
}

impl DispatchAdmissionBackend for LedgerDispatchAdmissionBackend<'_> {
    fn record_then_exact_seal(
        &mut self,
        request: &GovernedDispatchAdmissionRequestV1,
    ) -> Result<SealedDispatchAdmissionEvidence, DispatchAdmissionBackendError> {
        let recorded = self.store.record_governed_dispatch_admission_v1(
            request,
            self.authority,
            self.dispatch_signing_key,
            self.dispatch_signer,
        )?;
        let recorded_event_id = match recorded {
            GovernedDispatchAdmissionDispositionV1::AwaitingCheckpoint {
                dispatch_event_id,
                ..
            }
            | GovernedDispatchAdmissionDispositionV1::Sealed {
                dispatch_event_id, ..
            } => dispatch_event_id,
        };
        let sealed = self.store.seal_governed_dispatch_admission_v1(
            &GovernedDispatchAdmissionSealRequestV1 {
                run_id: request.run_id,
                dispatch_event_id: recorded_event_id,
            },
            self.authority,
            self.checkpoint_signing_key,
            self.checkpoint_signer,
        )?;
        match sealed {
            GovernedDispatchAdmissionDispositionV1::Sealed {
                dispatch_event_id,
                dispatch_event_digest,
                checkpoint_event_id,
                checkpoint_event_digest,
                ..
            } if dispatch_event_id == recorded_event_id => Ok(SealedDispatchAdmissionEvidence {
                run_id: request.run_id,
                dispatch_event_id,
                dispatch_event_digest,
                envelope_digest: request.dispatch.envelope_digest.clone(),
                checkpoint_event_id,
                checkpoint_event_digest,
            }),
            GovernedDispatchAdmissionDispositionV1::Sealed { .. } => {
                Err(DispatchAdmissionBackendError::SealIdentityMismatch)
            }
            GovernedDispatchAdmissionDispositionV1::AwaitingCheckpoint { .. } => {
                Err(DispatchAdmissionBackendError::AwaitingCheckpoint)
            }
        }
    }
}

/// Production postcondition adapter. Every call opens a fresh bounded trusted
/// snapshot from the durable ledger and compares the exact sealed facts.
pub(crate) struct TrustedDispatchAdmissionSnapshotVerifier<'a> {
    store: &'a SqliteStore,
    database_path: PathBuf,
    authorities: &'a TrustedReplayAuthorities,
    pinned_kernel_signer: &'a ActorKeyRef,
}

impl<'a> TrustedDispatchAdmissionSnapshotVerifier<'a> {
    pub(crate) fn from_prevalidated_startup(
        store: &'a SqliteStore,
        database_path: impl AsRef<Path>,
        authorities: &'a TrustedReplayAuthorities,
        pinned_kernel_signer: &'a ActorKeyRef,
    ) -> Self {
        Self {
            store,
            database_path: database_path.as_ref().to_path_buf(),
            authorities,
            pinned_kernel_signer,
        }
    }

    /// Read the immutable event named by a sealed admission and recompute its
    /// canonical digest. The fresh trusted snapshot verifies the exact same
    /// event's detached signature and full checkpoint chain; this lookup binds
    /// the snapshot's event identity to the admission-specific historical
    /// digest without incorrectly requiring that checkpoint to stay latest.
    fn exact_canonical_event_hash(
        &self,
        run_id: &str,
        event_id: EventId,
        expected_kind: EventKind,
    ) -> Result<String, DispatchAdmissionSnapshotError> {
        let row = self
            .store
            .events_for_run(run_id)?
            .into_iter()
            .find(|row| row.id == event_id.to_string())
            .ok_or_else(|| DispatchAdmissionSnapshotError::Rejected {
                reason: "sealed admission event is absent from the protected ledger".into(),
            })?;
        let event = row.to_event()?;
        if event.run_id.to_string() != run_id || event.id != event_id || event.kind != expected_kind
        {
            return Err(DispatchAdmissionSnapshotError::Rejected {
                reason: "sealed admission event identity does not match the protected ledger"
                    .into(),
            });
        }
        Ok(canonical_event_hash(&event)?)
    }

    /// Bind the protected store and the recovery reader to one canonical
    /// durable database identity before either source is allowed to confirm a
    /// sealed admission. A matching run/event digest across two different
    /// copies is not a trusted proof.
    fn canonical_recovery_database_path(&self) -> Result<PathBuf, DispatchAdmissionSnapshotError> {
        let store_path = self.store.canonical_database_path()?;
        let recovery_path = std::fs::canonicalize(&self.database_path).map_err(|_| {
            DispatchAdmissionSnapshotError::Rejected {
                reason: "trusted recovery database path has no canonical durable identity".into(),
            }
        })?;
        if store_path != recovery_path {
            return Err(DispatchAdmissionSnapshotError::Rejected {
                reason: "protected ledger store and trusted recovery database differ".into(),
            });
        }
        Ok(recovery_path)
    }

    /// Prove that the exact historical checkpoint named by the sealed
    /// evidence covers the exact sealed dispatch in its signed prefix. This
    /// intentionally does not require the named checkpoint to be latest: a
    /// later valid checkpointed dispatch must not revoke a prior seal.
    fn exact_checkpoint_covers_dispatch(
        &self,
        run_id: &str,
        sealed: &SealedDispatchAdmissionEvidence,
    ) -> Result<(), DispatchAdmissionSnapshotError> {
        let signed_events = self.store.signed_events_for_run(run_id)?;
        let (checkpoint_event, checkpoint_signature) = signed_events
            .iter()
            .find(|(event, _)| event.id == sealed.checkpoint_event_id)
            .ok_or_else(|| DispatchAdmissionSnapshotError::Rejected {
                reason: "sealed admission checkpoint is absent from the protected ledger".into(),
            })?;
        let checkpoint_signature = checkpoint_signature.as_ref().ok_or_else(|| {
            DispatchAdmissionSnapshotError::Rejected {
                reason: "sealed admission checkpoint lacks signed evidence".into(),
            }
        })?;
        let Payload::TapeCheckpointV1(checkpoint) = &checkpoint_event.payload else {
            return Err(DispatchAdmissionSnapshotError::Rejected {
                reason: "sealed admission checkpoint has the wrong payload".into(),
            });
        };
        if checkpoint_event.run_id.to_string() != run_id
            || checkpoint.run_id.to_string() != run_id
            || checkpoint_event.parent_event_id != Some(checkpoint.through_event_id)
            || checkpoint.algorithm != TapeRootAlgorithm::Sha256Linear
            || checkpoint_signature.canonical_event_hash != sealed.checkpoint_event_digest
        {
            return Err(DispatchAdmissionSnapshotError::Rejected {
                reason: "sealed admission checkpoint does not bind its signed run evidence".into(),
            });
        }

        let signed_ordinary = signed_events
            .iter()
            .filter_map(|(event, signature)| {
                (event.kind != EventKind::TapeCheckpoint)
                    .then(|| signature.as_ref().map(|signature| (event, signature)))
                    .flatten()
            })
            .collect::<Vec<_>>();
        let Some(dispatch_index) = signed_ordinary
            .iter()
            .position(|(event, _)| event.id == sealed.dispatch_event_id)
        else {
            return Err(DispatchAdmissionSnapshotError::Rejected {
                reason: "sealed admission dispatch is absent from the signed checkpoint prefix"
                    .into(),
            });
        };
        let through_count = usize::try_from(checkpoint.through_event_count).map_err(|_| {
            DispatchAdmissionSnapshotError::Rejected {
                reason: "sealed admission checkpoint count exceeds this host".into(),
            }
        })?;
        if through_count == 0
            || through_count > signed_ordinary.len()
            || dispatch_index >= through_count
        {
            return Err(DispatchAdmissionSnapshotError::Rejected {
                reason: "sealed admission checkpoint does not cover the exact dispatch".into(),
            });
        }
        let covered = &signed_ordinary[..through_count];
        let Some((through_event, _)) = covered.last() else {
            return Err(DispatchAdmissionSnapshotError::Rejected {
                reason: "sealed admission checkpoint covers an empty signed prefix".into(),
            });
        };
        let expected_root = tape_root_hash(
            &covered
                .iter()
                .map(|(_, signature)| signature.canonical_event_hash.clone())
                .collect::<Vec<_>>(),
        );
        if checkpoint.through_event_id != through_event.id
            || checkpoint.tape_root_hash != expected_root
        {
            return Err(DispatchAdmissionSnapshotError::Rejected {
                reason:
                    "sealed admission checkpoint root does not prove the signed dispatch prefix"
                        .into(),
            });
        }
        Ok(())
    }
}

impl DispatchAdmissionSnapshotVerifier for TrustedDispatchAdmissionSnapshotVerifier<'_> {
    fn verify_fresh_sealed_admission(
        &mut self,
        request: &GovernedDispatchAdmissionRequestV1,
        sealed: &SealedDispatchAdmissionEvidence,
    ) -> Result<(), DispatchAdmissionSnapshotError> {
        let run_id = request.run_id.to_string();
        let recovery_database_path = self.canonical_recovery_database_path()?;
        let snapshot = TrustedGovernedRecoverySnapshot::open_bounded_v1(
            &run_id,
            &recovery_database_path,
            self.authorities,
            self.pinned_kernel_signer,
        )?;
        if snapshot.run_id() != run_id {
            return Err(DispatchAdmissionSnapshotError::Rejected {
                reason: "trusted snapshot belongs to a different run".into(),
            });
        }

        let workflow = snapshot
            .workflow_for_dispatch_event_ref(&sealed.dispatch_event_id.to_string())
            .ok_or_else(|| DispatchAdmissionSnapshotError::Rejected {
                reason: "trusted snapshot does not contain the exact sealed dispatch".into(),
            })?;
        let dispatch = &workflow.dispatch;
        if workflow.run_id != run_id
            || workflow.workflow_id != request.dispatch.body.workflow_id
            || workflow.workflow_revision != request.dispatch.body.workflow_revision
            || workflow.unit_id != request.dispatch.body.unit_id
            || u64::from(workflow.attempt) != u64::from(request.dispatch.body.attempt)
            || dispatch.event_id != sealed.dispatch_event_id
            || dispatch.envelope_digest != request.dispatch.envelope_digest
            || sealed.envelope_digest != request.dispatch.envelope_digest
            || dispatch.execution_role != ExecutionRoleV1::Implementer
            || dispatch.trust_tier != TrustTierV1::Governed
            || dispatch.commit_mode != CommitModeV1::Atomic
            || dispatch.action_evidence_version != Some(ActionEvidenceVersionV1::SealedV3)
            || dispatch.idempotency_key != request.dispatch.body.idempotency_key
            || dispatch.repository_binding_digest.as_deref()
                != Some(request.dispatch.repository_binding_digest.as_str())
            || dispatch.governed_packet_digest.as_deref()
                != request.dispatch.governed_packet_digest.as_deref()
            || dispatch.ledger_authority_realm_digest.as_deref()
                != Some(request.dispatch.ledger_authority_realm_digest.as_str())
        {
            return Err(DispatchAdmissionSnapshotError::Rejected {
                reason: "trusted snapshot does not bind the exact governed sealed admission".into(),
            });
        }

        let dispatch_event_digest = self.exact_canonical_event_hash(
            &run_id,
            sealed.dispatch_event_id,
            EventKind::DispatchEnvelopeV3,
        )?;
        if dispatch_event_digest != sealed.dispatch_event_digest {
            return Err(DispatchAdmissionSnapshotError::Rejected {
                reason: "trusted snapshot does not bind the exact admission dispatch digest".into(),
            });
        }
        let checkpoint_event_digest = self.exact_canonical_event_hash(
            &run_id,
            sealed.checkpoint_event_id,
            EventKind::TapeCheckpoint,
        )?;
        if checkpoint_event_digest != sealed.checkpoint_event_digest {
            return Err(DispatchAdmissionSnapshotError::Rejected {
                reason: "trusted snapshot does not bind the exact admission checkpoint seal".into(),
            });
        }
        self.exact_checkpoint_covers_dispatch(&run_id, sealed)?;
        Ok(())
    }
}
