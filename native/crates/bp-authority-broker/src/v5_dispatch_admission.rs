//! Broker-private composition for a sealed V5 admission receipt.
//!
//! The caller names only a run and the canonical digest of an already-signed
//! V5 source dispatch. The protected ledger resolves exactly one source event,
//! re-derives every graph and manifest witness, records the separate host
//! admission receipt, and seals its exact tape prefix. This module returns
//! recovery evidence only: it deliberately has no action, worker, lease,
//! capability, candidate, or promotion surface.

#[cfg(target_os = "linux")]
use crate::confinement::{
    BrokerAuthorityRoleV1, BrokerHostConfinementAttestationV1, BrokerHostConfinementPolicyV1,
};
use bp_ledger::signing::ActorKeyRef;
use bp_ledger::storage::sqlite::{
    GovernedDispatchV5AdmissionAuthorityV1, GovernedDispatchV5AdmissionDispositionV1,
    GovernedDispatchV5AdmissionRequestV1, GovernedDispatchV5AdmissionSealRequestV1, SqliteStore,
};
use bp_ledger::{EventId, RunId};
use ed25519_dalek::SigningKey;
use serde::Deserialize;
#[cfg(target_os = "linux")]
use std::io::Read;
#[cfg(target_os = "linux")]
use std::os::unix::net::UnixStream;
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};
use thiserror::Error;
use uuid::Uuid;

/// The entire caller-controlled request surface for the V5 admission
/// composition. The source envelope, manifests, signer identities, and all
/// authority facts remain in protected startup dependencies or signed tape.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct V5DispatchAdmissionRequest {
    pub(crate) request_id: Uuid,
    pub(crate) run_id: RunId,
    pub(crate) v5_envelope_digest: String,
}

/// Closed local failures for the private authenticated V5 admission ingress.
///
/// The broker deliberately maps peer, framing, and request parsing details to
/// these three local states. It does not expose a signer, authority, storage,
/// ledger, or reconciliation error through the wire boundary.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum V5DispatchAdmissionHandlerError {
    #[error("V5 dispatch admission peer was rejected")]
    PeerRejected,
    #[error("V5 dispatch admission frame was rejected")]
    FrameRejected,
    #[error("V5 dispatch admission request was rejected")]
    RequestRejected,
}

/// The entire V5 admission wire contract. In particular, it contains no
/// authority, realm, signer, key, envelope, workspace, worker, action,
/// candidate, or promotion input.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct V5DispatchAdmissionWire {
    request_id: String,
    run_id: String,
    v5_envelope_digest: String,
}

/// Parse the only caller-controlled V5 admission identity request.
///
/// `request_id` is validated solely as correlation metadata and is then
/// discarded. The returned type has no place for it, so it cannot affect
/// authority, idempotency, ledger evidence, or sealing.
pub(crate) fn parse_v5_dispatch_admission_request(
    wire: &[u8],
) -> Result<V5DispatchAdmissionRequest, V5DispatchAdmissionHandlerError> {
    let wire: V5DispatchAdmissionWire = serde_json::from_slice(wire)
        .map_err(|_| V5DispatchAdmissionHandlerError::RequestRejected)?;
    let request_id = parse_canonical_uuid(wire.request_id)?;
    let run_id = RunId::from_uuid(parse_canonical_uuid(wire.run_id)?);
    if !is_canonical_sha256_digest(&wire.v5_envelope_digest) {
        return Err(V5DispatchAdmissionHandlerError::RequestRejected);
    }
    Ok(V5DispatchAdmissionRequest {
        request_id,
        run_id,
        v5_envelope_digest: wire.v5_envelope_digest,
    })
}

fn is_canonical_sha256_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value.as_bytes()[7..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

/// Require the canonical lowercase hyphenated representation before converting
/// a wire identifier to a typed ledger ID. This intentionally does not rely
/// on transparent serde parsing, which would accept noncanonical spellings.
fn parse_canonical_uuid(value: String) -> Result<Uuid, V5DispatchAdmissionHandlerError> {
    let uuid =
        Uuid::parse_str(&value).map_err(|_| V5DispatchAdmissionHandlerError::RequestRejected)?;
    if uuid.hyphenated().to_string() != value {
        return Err(V5DispatchAdmissionHandlerError::RequestRejected);
    }
    Ok(uuid)
}

/// Only sealed, immutable evidence can leave this composition. In particular,
/// `ReconciliationRequired` never grants a retry permit or authority.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum BrokerV5DispatchAdmissionDisposition {
    Sealed(SealedV5DispatchAdmissionEvidence),
    ReconciliationRequired,
}

pub(crate) struct HandledV5DispatchAdmissionV1 {
    pub(crate) request: V5DispatchAdmissionRequest,
    pub(crate) disposition: BrokerV5DispatchAdmissionDisposition,
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
        let source_dispatch_event_id = match self
            .store
            .resolve_unique_governed_dispatch_v5_source_by_digest_v1(
                request.run_id,
                &request.v5_envelope_digest,
                self.authority,
            ) {
            Ok(event_id) => event_id,
            Err(_) => return BrokerV5DispatchAdmissionDisposition::ReconciliationRequired,
        };
        let recorded = match self.store.record_governed_dispatch_v5_admission_v1(
            &GovernedDispatchV5AdmissionRequestV1 {
                run_id: request.run_id,
                dispatch_event_id: source_dispatch_event_id,
            },
            self.authority,
            self.admission_signing_key,
            self.admission_signer,
        ) {
            Ok(recorded) => recorded,
            Err(_) => return BrokerV5DispatchAdmissionDisposition::ReconciliationRequired,
        };
        let recorded = match RecordedV5AdmissionFacts::from_recorded(
            recorded,
            &request,
            source_dispatch_event_id,
        ) {
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

        if !recorded.matches_sealed(&sealed, &request, source_dispatch_event_id) {
            return BrokerV5DispatchAdmissionDisposition::ReconciliationRequired;
        }
        BrokerV5DispatchAdmissionDisposition::Sealed(sealed)
    }
}

/// Handle one already-authenticated V5 admission wire request.
///
/// This handler has no authority inputs beyond the backend constructed at
/// startup. Its sole effectful operation is the backend's existing
/// record-then-exact-seal composition.
pub(crate) fn handle_v5_dispatch_admission_wire(
    backend: &LedgerV5DispatchAdmissionBackend<'_>,
    wire: &[u8],
) -> Result<BrokerV5DispatchAdmissionDisposition, V5DispatchAdmissionHandlerError> {
    let request = parse_v5_dispatch_admission_request(wire)?;
    Ok(backend.record_then_exact_seal(request))
}

pub(crate) fn record_v5_admission_for_expected_run(
    backend: &LedgerV5DispatchAdmissionBackend<'_>,
    request: V5DispatchAdmissionRequest,
    expected_run_id: RunId,
) -> BrokerV5DispatchAdmissionDisposition {
    if request.run_id != expected_run_id {
        return BrokerV5DispatchAdmissionDisposition::ReconciliationRequired;
    }
    backend.record_then_exact_seal(request)
}

/// Authenticate a connected Linux worker before reading exactly one bounded
/// V5 request frame, then run the post-auth V5 handler.
///
/// This function starts no listener and writes no response. Peer verification
/// is intentionally the first operation so rejected peers cannot cause even a
/// frame header read or a ledger mutation.
#[cfg(target_os = "linux")]
pub(crate) fn handle_authenticated_v5_dispatch_admission_request(
    policy: &BrokerHostConfinementPolicyV1,
    attestation: &BrokerHostConfinementAttestationV1,
    stream: &mut UnixStream,
    backend: &LedgerV5DispatchAdmissionBackend<'_>,
) -> Result<BrokerV5DispatchAdmissionDisposition, V5DispatchAdmissionHandlerError> {
    let payload = read_authenticated_v5_dispatch_admission_frame(policy, attestation, stream)?;
    handle_v5_dispatch_admission_wire(backend, &payload)
}

#[cfg(target_os = "linux")]
pub(crate) fn handle_authenticated_v5_dispatch_admission_request_with_binding(
    policy: &BrokerHostConfinementPolicyV1,
    attestation: &BrokerHostConfinementAttestationV1,
    stream: &mut UnixStream,
    backend: &LedgerV5DispatchAdmissionBackend<'_>,
    expected_run_id: RunId,
) -> Result<HandledV5DispatchAdmissionV1, V5DispatchAdmissionHandlerError> {
    let payload = read_authenticated_v5_dispatch_admission_frame(policy, attestation, stream)?;
    let request = parse_v5_dispatch_admission_request(&payload)?;
    let disposition =
        record_v5_admission_for_expected_run(backend, request.clone(), expected_run_id);
    Ok(HandledV5DispatchAdmissionV1 {
        request,
        disposition,
    })
}

/// Read one big-endian length-prefixed V5 payload without permitting an
/// untrusted frame header to allocate arbitrary memory.
#[cfg(target_os = "linux")]
fn read_bounded_v5_dispatch_admission_frame(
    stream: &mut UnixStream,
) -> Result<Vec<u8>, V5DispatchAdmissionHandlerError> {
    read_v5_frame_with_timeout(stream, Duration::from_secs(5), |_| Ok(()))
}

#[cfg(target_os = "linux")]
fn read_authenticated_v5_dispatch_admission_frame(
    policy: &BrokerHostConfinementPolicyV1,
    attestation: &BrokerHostConfinementAttestationV1,
    stream: &mut UnixStream,
) -> Result<Vec<u8>, V5DispatchAdmissionHandlerError> {
    read_v5_frame_with_timeout(stream, Duration::from_secs(5), |stream| {
        policy
            .verify_linux_connected_worker_for_role(
                BrokerAuthorityRoleV1::DispatchAdmission,
                attestation,
                stream,
            )
            .map_err(|_| V5DispatchAdmissionHandlerError::PeerRejected)
    })
}

#[cfg(target_os = "linux")]
fn read_v5_frame_with_timeout<F>(
    stream: &mut UnixStream,
    timeout: Duration,
    mut before_read: F,
) -> Result<Vec<u8>, V5DispatchAdmissionHandlerError>
where
    F: FnMut(&mut UnixStream) -> Result<(), V5DispatchAdmissionHandlerError>,
{
    const MAX_V5_DISPATCH_ADMISSION_FRAME_BYTES: usize = 16 * 1024;
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or(V5DispatchAdmissionHandlerError::FrameRejected)?;
    let mut encoded_length = [0_u8; std::mem::size_of::<u32>()];
    read_frame_chunk(stream, deadline, &mut before_read, &mut encoded_length)?;

    let payload_length = u32::from_be_bytes(encoded_length) as usize;
    if payload_length == 0 || payload_length > MAX_V5_DISPATCH_ADMISSION_FRAME_BYTES {
        return Err(V5DispatchAdmissionHandlerError::FrameRejected);
    }

    let mut payload = vec![0_u8; payload_length];
    read_frame_chunk(stream, deadline, &mut before_read, &mut payload)?;
    require_frame_eof(stream, deadline, &mut before_read)?;
    Ok(payload)
}

#[cfg(target_os = "linux")]
fn read_frame_chunk<F>(
    stream: &mut UnixStream,
    deadline: Instant,
    before_read: &mut F,
    buffer: &mut [u8],
) -> Result<(), V5DispatchAdmissionHandlerError>
where
    F: FnMut(&mut UnixStream) -> Result<(), V5DispatchAdmissionHandlerError>,
{
    let mut filled = 0;
    while filled < buffer.len() {
        before_read(stream)?;
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or(V5DispatchAdmissionHandlerError::FrameRejected)?;
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|_| V5DispatchAdmissionHandlerError::FrameRejected)?;
        let count = stream
            .read(&mut buffer[filled..])
            .map_err(|_| V5DispatchAdmissionHandlerError::FrameRejected)?;
        if count == 0 {
            return Err(V5DispatchAdmissionHandlerError::FrameRejected);
        }
        filled += count;
        if Instant::now() >= deadline {
            return Err(V5DispatchAdmissionHandlerError::FrameRejected);
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn require_frame_eof<F>(
    stream: &mut UnixStream,
    deadline: Instant,
    before_read: &mut F,
) -> Result<(), V5DispatchAdmissionHandlerError>
where
    F: FnMut(&mut UnixStream) -> Result<(), V5DispatchAdmissionHandlerError>,
{
    before_read(stream)?;
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or(V5DispatchAdmissionHandlerError::FrameRejected)?;
    stream
        .set_read_timeout(Some(remaining))
        .map_err(|_| V5DispatchAdmissionHandlerError::FrameRejected)?;
    let mut trailing = [0_u8; 1];
    match stream.read(&mut trailing) {
        Ok(0) if Instant::now() < deadline => Ok(()),
        Ok(_) | Err(_) => Err(V5DispatchAdmissionHandlerError::FrameRejected),
    }
}

#[cfg(all(test, target_os = "linux"))]
pub(crate) fn handle_v5_dispatch_admission_framed_with_binding_for_test(
    stream: &mut UnixStream,
    backend: &LedgerV5DispatchAdmissionBackend<'_>,
    expected_run_id: RunId,
    timeout: Duration,
) -> Result<HandledV5DispatchAdmissionV1, V5DispatchAdmissionHandlerError> {
    let payload = read_v5_frame_with_timeout(stream, timeout, |_| Ok(()))?;
    let request = parse_v5_dispatch_admission_request(&payload)?;
    let disposition =
        record_v5_admission_for_expected_run(backend, request.clone(), expected_run_id);
    Ok(HandledV5DispatchAdmissionV1 {
        request,
        disposition,
    })
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
        expected_source_dispatch_event_id: EventId,
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
        if source_dispatch_event_id != expected_source_dispatch_event_id
            || v5_envelope_digest != request.v5_envelope_digest
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
        source_dispatch_event_id: EventId,
    ) -> bool {
        sealed.run_id == request.run_id
            && sealed.v5_envelope_digest == request.v5_envelope_digest
            && sealed.source_dispatch_event_id == source_dispatch_event_id
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recorded_facts_reject_a_source_event_id_substituted_after_digest_resolution() {
        let run_id = RunId::new();
        let expected_source_dispatch_event_id = EventId::new();
        let substituted_source_dispatch_event_id = EventId::new();
        let request = V5DispatchAdmissionRequest {
            request_id: Uuid::now_v7(),
            run_id,
            v5_envelope_digest:
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        };
        let disposition = GovernedDispatchV5AdmissionDispositionV1::AwaitingCheckpoint {
            source_dispatch_event_id: substituted_source_dispatch_event_id,
            source_dispatch_event_digest:
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
            admission_event_id: EventId::new(),
            admission_event_digest:
                "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".into(),
            v5_envelope_digest: request.v5_envelope_digest.clone(),
            witness_evidence_digest:
                "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd".into(),
            semantic_identity_digest:
                "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".into(),
            idempotency_key: "dispatch:v5:test".into(),
        };

        assert!(RecordedV5AdmissionFacts::from_recorded(
            disposition,
            &request,
            expected_source_dispatch_event_id,
        )
        .is_none());
    }

    #[test]
    fn exact_wire_parser_retains_canonical_request_correlation_for_signed_response() {
        let request_id = "018f2e40-0000-7000-8000-000000000009";
        let run_id = "018f2e40-0000-7000-8000-000000000001";
        let digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let parsed = parse_v5_dispatch_admission_request(
            format!(
                r#"{{"request_id":"{request_id}","run_id":"{run_id}","v5_envelope_digest":"{digest}"}}"#
            )
            .as_bytes(),
        )
        .expect("closed request");

        assert_eq!(parsed.request_id.to_string(), request_id);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn bounded_reader_rejects_zero_oversized_and_truncated_frames() {
        use std::io::Write;
        use std::os::unix::net::UnixStream;

        for frame in [
            0_u32.to_be_bytes().to_vec(),
            (16_u32 * 1024 + 1).to_be_bytes().to_vec(),
            {
                let mut frame = 8_u32.to_be_bytes().to_vec();
                frame.extend_from_slice(b"short");
                frame
            },
        ] {
            let (mut reader, mut writer) = UnixStream::pair().expect("socket pair");
            writer.write_all(&frame).expect("write malformed frame");
            drop(writer);
            assert_eq!(
                read_bounded_v5_dispatch_admission_frame(&mut reader),
                Err(V5DispatchAdmissionHandlerError::FrameRejected)
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn bounded_reader_uses_one_absolute_deadline_and_rechecks_peer_before_each_read() {
        use std::io::Write;
        use std::os::unix::net::UnixStream;

        let (mut reader, mut writer) = UnixStream::pair().expect("socket pair");
        writer
            .write_all(&2_u32.to_be_bytes())
            .expect("write frame length");
        writer.write_all(b"x").expect("write partial payload");

        let mut peer_checks = 0_u32;
        let started = Instant::now();
        assert_eq!(
            read_v5_frame_with_timeout(&mut reader, Duration::from_millis(50), |_| {
                peer_checks += 1;
                Ok(())
            },),
            Err(V5DispatchAdmissionHandlerError::FrameRejected)
        );

        assert!(
            started.elapsed() < Duration::from_secs(2),
            "held-open peer exceeded the bounded absolute deadline"
        );
        assert!(
            peer_checks >= 2,
            "peer authority was not rechecked before the payload read"
        );
        drop(writer);
    }
}
