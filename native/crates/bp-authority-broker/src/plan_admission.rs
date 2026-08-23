//! Broker-private composition for one sealed PlanForge admission.
//!
//! This module deliberately accepts only an already parsed strict broker
//! request and **contains no transport, listener, socket, role, startup
//! configuration, credential, filesystem, or process capability**. A protected
//! host must inject the content, repository-descriptor, authenticated-identity,
//! ledger, and fresh trusted-recovery seams before this composition can become
//! part of a real authenticated broker process; grounding the identity seam in
//! SO_PEERCRED is the next slice's job, not this one's.
//!
//! Why this control exists at all: `plan_admitted` is the only trust-spine kind
//! whose evidence is not already signed tape. Its digests are computed off-tape
//! by three mutually incompatible TypeScript canonicalization schemes, so there
//! is nothing on the tape to replay. The rule this module enforces instead is
//! the same one that makes the V5 admission non-vacuous, applied honestly:
//!
//! > The authority basis may contain only facts the control derives itself.
//! > Every other field is recorded as caller-asserted and explicitly
//! > non-authoritative.
//!
//! Containment, not authentication: because the control digests the bytes it
//! loaded and treats that digest as the identity, a mis-staged or substituted
//! object cannot become a forged admission. It is either refused outright (the
//! bytes do not hash to their own reference) or, under a different reference,
//! produces a *different* admission identity.
//!
//! The outward disposition is sealed recovery evidence or reconciliation —
//! never effect authority, and never a disclosing reason.

use bp_ledger::error::LedgerError;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::storage::sqlite::{
    PlanAdmissionAuthorityV1, PlanAdmissionDispositionV1, PlanAdmissionRequestV1,
    PlanAdmissionSealRequestV1, SqliteStore,
};
use ed25519_dalek::SigningKey;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use thiserror::Error;
use uuid::Uuid;

/// The one validation verdict this control will proceed on.
///
/// A native control cannot verify a TypeScript validator, so the status is
/// recorded as caller-asserted metadata and is never an authority input. It is
/// still a fail-closed *precondition*: recording a verdict the control was
/// never given would be a fabrication, and proceeding without one would discard
/// a gate the current builder enforces.
const REQUIRED_ASSERTED_VALIDATION_STATUS: &str = "PASS";

/// Closed wire shape. `deny_unknown_fields` is load-bearing: the caller surface
/// must stay no larger than a request id, a run id, one content reference, and
/// the advisory block. In particular there is deliberately no field by which a
/// caller could supply `input_digest`, `plan_id`, `trusted_base`, `decided_by`,
/// or `decided_at` — those are derived.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct PlanAdmissionWireRequestV1 {
    pub(crate) schema_version: u32,
    pub(crate) request_id: String,
    pub(crate) run_id: String,
    pub(crate) plan_content_ref: String,
    pub(crate) asserted: PlanAdmissionCallerAssertionsV1,
}

/// Caller assertions recorded verbatim as non-authoritative metadata.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct PlanAdmissionCallerAssertionsV1 {
    pub(crate) validation_status: String,
    pub(crate) plan_digest: String,
    pub(crate) idempotency_key: String,
}

/// An opaque, already-validated content reference.
///
/// It is a protected-registry key, never a path. It names content by digest, so
/// the control can hold the bytes it loads to the reference the caller named
/// without ever accepting a digest *value* from the caller.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PlanContentRefV1 {
    reference: String,
    digest: String,
}

impl PlanContentRefV1 {
    fn parse(reference: &str) -> Option<Self> {
        let digest = reference.strip_prefix("cas://")?;
        if !is_canonical_sha256_digest(digest) {
            return None;
        }
        Some(Self {
            reference: reference.to_string(),
            digest: digest.to_string(),
        })
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.reference
    }

    pub(crate) fn digest(&self) -> &str {
        &self.digest
    }
}

/// A strict parsed request. Canonical UUID parsing happens here, before any
/// seam is touched and before any authority work begins.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ParsedPlanAdmissionRequestV1 {
    pub(crate) request_id: Uuid,
    pub(crate) run_id: RunId,
    pub(crate) plan_content_ref: PlanContentRefV1,
    pub(crate) asserted_validation_status: String,
    pub(crate) asserted_plan_digest: String,
    pub(crate) asserted_idempotency_key: String,
}

/// Closed, non-disclosing local rejection vocabulary for a malformed frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error)]
pub(crate) enum PlanAdmissionRequestRejection {
    #[error("plan admission request frame is not a closed schema-1 request")]
    FrameRejected,
    #[error("plan admission request identifiers are not canonical")]
    RequestRejected,
}

pub(crate) fn parse_plan_admission_request_v1(
    frame: &str,
) -> Result<ParsedPlanAdmissionRequestV1, PlanAdmissionRequestRejection> {
    let wire: PlanAdmissionWireRequestV1 =
        serde_json::from_str(frame).map_err(|_| PlanAdmissionRequestRejection::FrameRejected)?;
    if wire.schema_version != 1 {
        return Err(PlanAdmissionRequestRejection::FrameRejected);
    }
    let request_id = Uuid::parse_str(&wire.request_id)
        .map_err(|_| PlanAdmissionRequestRejection::RequestRejected)?;
    let run_id = Uuid::parse_str(&wire.run_id)
        .map(RunId::from_uuid)
        .map_err(|_| PlanAdmissionRequestRejection::RequestRejected)?;
    let plan_content_ref = PlanContentRefV1::parse(&wire.plan_content_ref)
        .ok_or(PlanAdmissionRequestRejection::RequestRejected)?;
    Ok(ParsedPlanAdmissionRequestV1 {
        request_id,
        run_id,
        plan_content_ref,
        asserted_validation_status: wire.asserted.validation_status,
        asserted_plan_digest: wire.asserted.plan_digest,
        asserted_idempotency_key: wire.asserted.idempotency_key,
    })
}

/// Injected protected-host content boundary.
///
/// Implementations must resolve the opaque reference through a protected,
/// broker-owned store only — never a caller-supplied path. The composition
/// digests whatever bytes come back and holds them to the reference, so this
/// seam cannot decide the admission identity.
pub(crate) trait PlanContentResolver {
    fn load_exact_plan_content(
        &mut self,
        content_ref: &PlanContentRefV1,
    ) -> Result<LoadedPlanContent, PlanContentResolverError>;
}

/// Bytes produced only at the protected content boundary.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LoadedPlanContent {
    bytes: Vec<u8>,
}

impl LoadedPlanContent {
    pub(crate) fn from_protected_store(bytes: Vec<u8>) -> Self {
        Self { bytes }
    }

    fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

#[derive(Debug, Error)]
pub(crate) enum PlanContentResolverError {
    #[error("protected plan content store has no object for the named reference")]
    Absent,
    #[error("protected plan content store rejected the named reference: {reason}")]
    Rejected { reason: String },
}

/// Injected repository-descriptor boundary. The trusted base is a fact the
/// protected host retains for a run; it is never read from the request.
pub(crate) trait PlanRepositoryDescriptorResolver {
    fn resolve_repository_descriptor(
        &mut self,
        run_id: RunId,
    ) -> Result<ResolvedRepositoryDescriptor, PlanRepositoryDescriptorError>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ResolvedRepositoryDescriptor {
    run_id: RunId,
    trusted_base: String,
}

impl ResolvedRepositoryDescriptor {
    pub(crate) fn from_retained_custody(run_id: RunId, trusted_base: String) -> Self {
        Self {
            run_id,
            trusted_base,
        }
    }
}

#[derive(Debug, Error)]
pub(crate) enum PlanRepositoryDescriptorError {
    #[error("protected repository custody rejected the run: {reason}")]
    Rejected { reason: String },
}

/// Injected authenticated-identity boundary. S3 grounds this in SO_PEERCRED
/// role verification performed before any frame bytes are read; until then the
/// composition simply refuses whatever this seam refuses.
pub(crate) trait PlanAdmissionIdentityResolver {
    fn resolve_authenticated_operator(
        &mut self,
    ) -> Result<ResolvedOperatorIdentity, PlanAdmissionIdentityError>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ResolvedOperatorIdentity {
    decided_by: String,
}

impl ResolvedOperatorIdentity {
    pub(crate) fn from_authenticated_peer(decided_by: String) -> Self {
        Self { decided_by }
    }
}

#[derive(Debug, Error)]
pub(crate) enum PlanAdmissionIdentityError {
    #[error("authenticated peer was rejected")]
    PeerRejected,
}

/// Sealed facts produced only by the durable record-then-seal boundary. This is
/// internal glue; it cannot represent an awaiting-checkpoint state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SealedPlanAdmissionEvidence {
    pub(crate) run_id: RunId,
    pub(crate) admission_event_id: EventId,
    pub(crate) admission_event_digest: String,
    pub(crate) admission_identity_digest: String,
    pub(crate) plan_id: String,
    pub(crate) input_digest: String,
    pub(crate) checkpoint_event_id: EventId,
    pub(crate) checkpoint_event_digest: String,
}

/// Injected durable transition seam. It may never return `AwaitingCheckpoint`.
pub(crate) trait PlanAdmissionBackend {
    fn record_then_exact_seal(
        &mut self,
        request: &PlanAdmissionRequestV1,
    ) -> Result<SealedPlanAdmissionEvidence, PlanAdmissionBackendError>;
}

#[derive(Debug, Error)]
pub(crate) enum PlanAdmissionBackendError {
    #[error(transparent)]
    Ledger(#[from] LedgerError),
    #[error("plan admission remained awaiting a checkpoint")]
    AwaitingCheckpoint,
    #[error("record and seal returned different plan admission identities")]
    SealIdentityMismatch,
}

/// Injected postcondition seam. It must reopen trusted recovery after the seal
/// and verify the exact sealed evidence; cached or pre-seal snapshots are not
/// sufficient.
pub(crate) trait PlanAdmissionSnapshotVerifier {
    fn verify_fresh_sealed_admission(
        &mut self,
        request: &PlanAdmissionRequestV1,
        sealed: &SealedPlanAdmissionEvidence,
    ) -> Result<(), PlanAdmissionSnapshotError>;
}

#[derive(Debug, Error)]
pub(crate) enum PlanAdmissionSnapshotError {
    #[error("fresh trusted plan-admission snapshot rejected the sealed evidence: {reason}")]
    Rejected { reason: String },
    #[error(transparent)]
    Ledger(#[from] LedgerError),
}

/// The only completion state surfaced by this private composition.
///
/// The proof is sealed **recovery evidence** only, mirroring the V5 admission
/// receipt's stance. It contains no plan bytes, no signer material, no pre-seal
/// disposition, and no reusable capability, and it is not effect authority.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum BrokerPlanAdmissionDisposition {
    Sealed(BrokerSealedPlanAdmissionProof),
    ReconciliationRequired,
}

/// Opaque, crate-private identity of a sealed plan admission.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BrokerSealedPlanAdmissionProof {
    admission_event_id: EventId,
    admission_event_digest: String,
    plan_id: String,
    input_digest: String,
    checkpoint_event_id: EventId,
    checkpoint_event_digest: String,
}

impl From<SealedPlanAdmissionEvidence> for BrokerSealedPlanAdmissionProof {
    fn from(value: SealedPlanAdmissionEvidence) -> Self {
        Self {
            admission_event_id: value.admission_event_id,
            admission_event_digest: value.admission_event_digest,
            plan_id: value.plan_id,
            input_digest: value.input_digest,
            checkpoint_event_id: value.checkpoint_event_id,
            checkpoint_event_digest: value.checkpoint_event_digest,
        }
    }
}

/// Why one admission attempt did not become sealed evidence.
///
/// **This vocabulary is crate-private diagnostic detail and must never be
/// serialized to a peer.** A protected host calls [`BrokerPlanAdmissionAuthority::admit`],
/// which collapses every variant here to `ReconciliationRequired` so the wire
/// boundary discloses nothing about signer, storage, content, or reconciliation
/// state. `admit_detailed` exists so the negative controls can prove that six
/// different refusals really are six different code paths rather than one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PlanAdmissionRefusal {
    ValidationNotAsserted,
    PlanContentAbsent,
    PlanInputRejected,
    PlanInputDigestMismatch,
    TrustedBaseMismatch,
    PeerRejected,
    PlanAdmissionIdempotencyConflict,
    LedgerReconciliationRequired,
    FreshSnapshotRejected,
}

/// Private composition over protected host dependencies.
///
/// It accepts no paths, signers, plan bytes, CAS roots, digests, or mutable
/// authority assertions from its caller.
pub(crate) struct BrokerPlanAdmissionAuthority<C, R, I, B, V> {
    content: C,
    repository: R,
    identity: I,
    backend: B,
    snapshot_verifier: V,
}

impl<C, R, I, B, V> BrokerPlanAdmissionAuthority<C, R, I, B, V>
where
    C: PlanContentResolver,
    R: PlanRepositoryDescriptorResolver,
    I: PlanAdmissionIdentityResolver,
    B: PlanAdmissionBackend,
    V: PlanAdmissionSnapshotVerifier,
{
    pub(crate) fn new(
        content: C,
        repository: R,
        identity: I,
        backend: B,
        snapshot_verifier: V,
    ) -> Self {
        Self {
            content,
            repository,
            identity,
            backend,
            snapshot_verifier,
        }
    }

    /// Admit one strict parsed request only after a durable seal and a fresh
    /// exact trusted-recovery confirmation. Any uncertainty is reconciliation
    /// evidence, never authority, and never a disclosing reason.
    pub(crate) fn admit(
        &mut self,
        parsed: ParsedPlanAdmissionRequestV1,
    ) -> BrokerPlanAdmissionDisposition {
        match self.admit_detailed(parsed) {
            Ok(proof) => BrokerPlanAdmissionDisposition::Sealed(proof),
            Err(_) => BrokerPlanAdmissionDisposition::ReconciliationRequired,
        }
    }

    /// Recover the injected backend so a test can inspect exactly what the
    /// composition handed the ledger. Test-only: production never unpacks a
    /// composition.
    #[cfg(test)]
    pub(crate) fn into_backend_for_tests(self) -> B {
        self.backend
    }

    pub(crate) fn admit_detailed(
        &mut self,
        parsed: ParsedPlanAdmissionRequestV1,
    ) -> Result<BrokerSealedPlanAdmissionProof, PlanAdmissionRefusal> {
        if parsed.asserted_validation_status != REQUIRED_ASSERTED_VALIDATION_STATUS {
            return Err(PlanAdmissionRefusal::ValidationNotAsserted);
        }

        let content = self
            .content
            .load_exact_plan_content(&parsed.plan_content_ref)
            .map_err(|error| match error {
                PlanContentResolverError::Absent => PlanAdmissionRefusal::PlanContentAbsent,
                PlanContentResolverError::Rejected { .. } => {
                    PlanAdmissionRefusal::PlanInputRejected
                }
            })?;
        let plan_bytes = content.as_bytes();
        if plan_bytes.is_empty() {
            return Err(PlanAdmissionRefusal::PlanInputRejected);
        }
        // The control digests what it loaded and holds it to the reference the
        // caller named. A caller never supplies a digest value.
        let input_digest = format!("sha256:{:x}", Sha256::digest(plan_bytes));
        if input_digest != parsed.plan_content_ref.digest() {
            return Err(PlanAdmissionRefusal::PlanInputDigestMismatch);
        }

        let descriptor = self
            .repository
            .resolve_repository_descriptor(parsed.run_id)
            .map_err(|_| PlanAdmissionRefusal::TrustedBaseMismatch)?;
        if descriptor.run_id != parsed.run_id
            || !is_canonical_git_commit_sha(&descriptor.trusted_base)
        {
            return Err(PlanAdmissionRefusal::TrustedBaseMismatch);
        }

        let operator = self
            .identity
            .resolve_authenticated_operator()
            .map_err(|_| PlanAdmissionRefusal::PeerRejected)?;
        if operator.decided_by.trim().is_empty() {
            return Err(PlanAdmissionRefusal::PeerRejected);
        }

        let request = PlanAdmissionRequestV1 {
            run_id: parsed.run_id,
            request_id: parsed.request_id,
            plan_content_ref: parsed.plan_content_ref.as_str().to_string(),
            plan_bytes: plan_bytes.to_vec(),
            trusted_base: descriptor.trusted_base,
            decided_by: operator.decided_by,
            asserted_plan_digest: parsed.asserted_plan_digest,
            asserted_idempotency_key: parsed.asserted_idempotency_key,
            asserted_validation_status: parsed.asserted_validation_status,
        };

        let sealed = self
            .backend
            .record_then_exact_seal(&request)
            .map_err(refusal_for_backend_error)?;
        if sealed.run_id != request.run_id || sealed.input_digest != input_digest {
            return Err(PlanAdmissionRefusal::LedgerReconciliationRequired);
        }

        self.snapshot_verifier
            .verify_fresh_sealed_admission(&request, &sealed)
            .map_err(|_| PlanAdmissionRefusal::FreshSnapshotRejected)?;

        Ok(sealed.into())
    }
}

fn refusal_for_backend_error(error: PlanAdmissionBackendError) -> PlanAdmissionRefusal {
    match error {
        PlanAdmissionBackendError::Ledger(LedgerError::PlanAdmissionIdempotencyConflict {
            ..
        }) => PlanAdmissionRefusal::PlanAdmissionIdempotencyConflict,
        PlanAdmissionBackendError::Ledger(LedgerError::PlanInputDigestMismatch { .. }) => {
            PlanAdmissionRefusal::PlanInputDigestMismatch
        }
        PlanAdmissionBackendError::Ledger(LedgerError::PlanInputRejected { .. }) => {
            PlanAdmissionRefusal::PlanInputRejected
        }
        _ => PlanAdmissionRefusal::LedgerReconciliationRequired,
    }
}

fn is_canonical_sha256_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value.as_bytes()[7..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn is_canonical_git_commit_sha(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

/// Production ledger adapter over protected startup dependencies.
///
/// It uses the dedicated plan-admission record and exact seal operations rather
/// than a generic signed append — the generic paths refuse `plan_admitted`
/// outright — and it retains the kernel signer inside the protected process
/// boundary. The realm configures a single kernel identity for both the
/// admission and its checkpoint (see `PlanAdmissionAuthorityV1`), so this
/// adapter deliberately holds one signer rather than two.
pub(crate) struct LedgerPlanAdmissionBackend<'a> {
    store: &'a SqliteStore,
    authority: &'a PlanAdmissionAuthorityV1,
    kernel_signing_key: &'a SigningKey,
    kernel_signer: &'a bp_ledger::signing::ActorKeyRef,
}

impl<'a> LedgerPlanAdmissionBackend<'a> {
    pub(crate) fn from_prevalidated_startup(
        store: &'a SqliteStore,
        authority: &'a PlanAdmissionAuthorityV1,
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

impl PlanAdmissionBackend for LedgerPlanAdmissionBackend<'_> {
    fn record_then_exact_seal(
        &mut self,
        request: &PlanAdmissionRequestV1,
    ) -> Result<SealedPlanAdmissionEvidence, PlanAdmissionBackendError> {
        let recorded = self.store.record_plan_admission_v1(
            request,
            self.authority,
            self.kernel_signing_key,
            self.kernel_signer,
        )?;
        let recorded_event_id = match &recorded {
            PlanAdmissionDispositionV1::AwaitingCheckpoint {
                admission_event_id, ..
            }
            | PlanAdmissionDispositionV1::Sealed {
                admission_event_id, ..
            } => *admission_event_id,
        };
        let sealed = self.store.seal_plan_admission_v1(
            &PlanAdmissionSealRequestV1 {
                run_id: request.run_id,
                admission_event_id: recorded_event_id,
            },
            self.authority,
            self.kernel_signing_key,
            self.kernel_signer,
        )?;
        sealed_evidence_from_disposition(request.run_id, recorded_event_id, sealed)
    }
}

fn sealed_evidence_from_disposition(
    run_id: RunId,
    expected_event_id: EventId,
    disposition: PlanAdmissionDispositionV1,
) -> Result<SealedPlanAdmissionEvidence, PlanAdmissionBackendError> {
    match disposition {
        PlanAdmissionDispositionV1::Sealed {
            admission_event_id,
            admission_event_digest,
            admission_identity_digest,
            plan_id,
            input_digest,
            checkpoint_event_id,
            checkpoint_event_digest,
        } if admission_event_id == expected_event_id => Ok(SealedPlanAdmissionEvidence {
            run_id,
            admission_event_id,
            admission_event_digest,
            admission_identity_digest,
            plan_id,
            input_digest,
            checkpoint_event_id,
            checkpoint_event_digest,
        }),
        PlanAdmissionDispositionV1::Sealed { .. } => {
            Err(PlanAdmissionBackendError::SealIdentityMismatch)
        }
        PlanAdmissionDispositionV1::AwaitingCheckpoint { .. } => {
            Err(PlanAdmissionBackendError::AwaitingCheckpoint)
        }
    }
}

/// Production postcondition adapter.
///
/// Every call binds the protected store and the recovery reader to one
/// canonical durable database identity, then opens a **fresh** durable
/// connection and re-derives the sealed evidence through it. A matching digest
/// read back through the same handle that performed the write is not a trusted
/// proof; neither is a cached or pre-seal snapshot.
pub(crate) struct TrustedPlanAdmissionSnapshotVerifier<'a> {
    store: &'a SqliteStore,
    database_path: PathBuf,
    authority: &'a PlanAdmissionAuthorityV1,
}

impl<'a> TrustedPlanAdmissionSnapshotVerifier<'a> {
    pub(crate) fn from_prevalidated_startup(
        store: &'a SqliteStore,
        database_path: impl AsRef<Path>,
        authority: &'a PlanAdmissionAuthorityV1,
    ) -> Self {
        Self {
            store,
            database_path: database_path.as_ref().to_path_buf(),
            authority,
        }
    }

    fn canonical_recovery_database_path(&self) -> Result<PathBuf, PlanAdmissionSnapshotError> {
        let store_path = self.store.canonical_database_path()?;
        let recovery_path = std::fs::canonicalize(&self.database_path).map_err(|_| {
            PlanAdmissionSnapshotError::Rejected {
                reason: "trusted recovery database path has no canonical durable identity".into(),
            }
        })?;
        if store_path != recovery_path {
            return Err(PlanAdmissionSnapshotError::Rejected {
                reason: "protected ledger store and trusted recovery database differ".into(),
            });
        }
        Ok(recovery_path)
    }
}

impl PlanAdmissionSnapshotVerifier for TrustedPlanAdmissionSnapshotVerifier<'_> {
    fn verify_fresh_sealed_admission(
        &mut self,
        request: &PlanAdmissionRequestV1,
        sealed: &SealedPlanAdmissionEvidence,
    ) -> Result<(), PlanAdmissionSnapshotError> {
        let recovery_database_path = self.canonical_recovery_database_path()?;
        let reopened = SqliteStore::open(&recovery_database_path)?;
        let resolved = reopened.resolve_sealed_plan_admission_v1(
            request.run_id,
            sealed.admission_event_id,
            self.authority,
        )?;
        let PlanAdmissionDispositionV1::Sealed {
            admission_event_id,
            admission_event_digest,
            admission_identity_digest,
            plan_id,
            input_digest,
            checkpoint_event_id,
            checkpoint_event_digest,
        } = resolved
        else {
            return Err(PlanAdmissionSnapshotError::Rejected {
                reason: "fresh trusted recovery does not hold sealed plan admission evidence"
                    .into(),
            });
        };
        if admission_event_id != sealed.admission_event_id
            || admission_event_digest != sealed.admission_event_digest
            || admission_identity_digest != sealed.admission_identity_digest
            || plan_id != sealed.plan_id
            || input_digest != sealed.input_digest
            || checkpoint_event_id != sealed.checkpoint_event_id
            || checkpoint_event_digest != sealed.checkpoint_event_digest
        {
            return Err(PlanAdmissionSnapshotError::Rejected {
                reason: "fresh trusted recovery does not bind the exact sealed plan admission"
                    .into(),
            });
        }
        Ok(())
    }
}
