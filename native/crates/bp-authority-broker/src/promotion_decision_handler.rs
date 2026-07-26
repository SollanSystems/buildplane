//! Private authenticated ingress for one opaque operator promotion decision.
//!
//! This module deliberately starts no listener, writes no response, and has no
//! CLI, TypeScript, generic protocol, or controller registration. A future
//! protected Linux broker host may call the authenticated entrypoint only after
//! it has constructed a startup-bound decision authority from protected replay,
//! ledger, and signer dependencies.

#[cfg(target_os = "linux")]
use crate::confinement::{
    BrokerAuthorityRoleV1, BrokerHostConfinementAttestationV1, BrokerHostConfinementPolicyV1,
};
use crate::{
    BrokerPromotionDecisionDisposition, BrokerPromotionDecisionIngressRequest,
    ProtectedPromotionDecisionAuthority,
};
use bp_ledger::payload::trust_spine::PromotionDecisionKindV1;
use bp_ledger::EventId;
use serde::Deserialize;
#[cfg(target_os = "linux")]
use std::io::Read;
#[cfg(target_os = "linux")]
use std::os::unix::net::UnixStream;
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};
use thiserror::Error;
use uuid::Uuid;

#[cfg(target_os = "linux")]
const PROMOTION_DECISION_FRAME_READ_TIMEOUT: Duration = Duration::from_secs(5);

/// Closed local failures for the private authenticated operator-decision
/// ingress. Replay, ledger, authority, and reconciliation internals never
/// cross this wire boundary.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum PromotionDecisionHandlerError {
    #[error("promotion decision peer was rejected")]
    PeerRejected,
    #[error("promotion decision frame was rejected")]
    FrameRejected,
    #[error("promotion decision request was rejected")]
    RequestRejected,
}

/// The entire caller-controlled promotion-decision wire contract.
///
/// The startup-bound authority owns the run identity and all candidate,
/// completion, acceptance, review, authority, target, signer, and idempotency
/// lineage. The caller may name only an existing durable approval work item,
/// choose a closed outcome, and supply discard-only correlation metadata.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PromotionDecisionWire {
    request_id: String,
    promotion_approval_request_event_id: String,
    decision: String,
}

/// Parse one closed operator promotion-decision request.
///
/// The request ID is canonicalized only as correlation metadata and then
/// discarded. The returned request cannot retain caller authority or lineage.
pub(crate) fn parse_promotion_decision_request(
    wire: &[u8],
) -> Result<BrokerPromotionDecisionIngressRequest, PromotionDecisionHandlerError> {
    let wire: PromotionDecisionWire =
        serde_json::from_slice(wire).map_err(|_| PromotionDecisionHandlerError::RequestRejected)?;
    let _request_id = parse_canonical_uuid(wire.request_id)?;
    let promotion_approval_request_event_id = EventId::from_uuid(parse_canonical_uuid(
        wire.promotion_approval_request_event_id,
    )?);
    let decision = match wire.decision.as_str() {
        "promote" => PromotionDecisionKindV1::Promote,
        "reject" => PromotionDecisionKindV1::Reject,
        _ => return Err(PromotionDecisionHandlerError::RequestRejected),
    };
    Ok(BrokerPromotionDecisionIngressRequest {
        promotion_approval_request_event_id,
        decision,
    })
}

/// Require canonical lower-case hyphenated UUID text before creating a typed
/// ledger identifier. Transparent serde UUID parsing would accept multiple
/// spelling variants and is therefore intentionally not used here.
fn parse_canonical_uuid(value: String) -> Result<Uuid, PromotionDecisionHandlerError> {
    let uuid =
        Uuid::parse_str(&value).map_err(|_| PromotionDecisionHandlerError::RequestRejected)?;
    if uuid.hyphenated().to_string() != value {
        return Err(PromotionDecisionHandlerError::RequestRejected);
    }
    Ok(uuid)
}

/// Handle one already-authenticated opaque operator decision.
///
/// A successful sealed result means only that the one derived decision is
/// durable. It is not a promotion execution capability, target-ref effect, or
/// workflow-completion signal. Every replay or ledger issue is collapsed by
/// the protected authority to reconciliation required.
pub(crate) fn handle_promotion_decision_wire(
    authority: &mut ProtectedPromotionDecisionAuthority<'_>,
    wire: &[u8],
) -> Result<BrokerPromotionDecisionDisposition, PromotionDecisionHandlerError> {
    let request = parse_promotion_decision_request(wire)?;
    Ok(authority.record_from_approval_decision(request))
}

/// Authenticate a connected Linux worker before reading exactly one bounded
/// promotion-decision frame, then run the opaque decision handler.
///
/// This function starts no listener and writes no response. Peer verification
/// is intentionally its first operation, so a rejected same-UID or
/// unconfigured worker cannot cause even a frame-header read or a tape write.
/// Every individual socket read is also preceded by a fresh peer check and a
/// fixed host-owned deadline.
#[cfg(target_os = "linux")]
pub(crate) fn handle_authenticated_promotion_decision_request(
    policy: &BrokerHostConfinementPolicyV1,
    attestation: &BrokerHostConfinementAttestationV1,
    stream: &mut UnixStream,
    authority: &mut ProtectedPromotionDecisionAuthority<'_>,
) -> Result<BrokerPromotionDecisionDisposition, PromotionDecisionHandlerError> {
    let payload = read_authenticated_promotion_decision_frame(policy, attestation, stream)?;
    handle_promotion_decision_wire(authority, &payload)
}

/// Authenticate a connected Linux worker, then return its one bounded opaque
/// frame. This has no decision authority by itself; the production handler
/// above is the only caller that can pair it with the fixed authority.
#[cfg(target_os = "linux")]
pub(crate) fn read_authenticated_promotion_decision_frame(
    policy: &BrokerHostConfinementPolicyV1,
    attestation: &BrokerHostConfinementAttestationV1,
    stream: &mut UnixStream,
) -> Result<Vec<u8>, PromotionDecisionHandlerError> {
    read_bounded_promotion_decision_frame_with_timeout(
        stream,
        PROMOTION_DECISION_FRAME_READ_TIMEOUT,
        |stream| {
            policy
                .verify_linux_connected_worker_for_role(
                    BrokerAuthorityRoleV1::PromotionDecision,
                    attestation,
                    stream,
                )
                .map_err(|_| PromotionDecisionHandlerError::PeerRejected)
        },
    )
}

/// Read one big-endian length-prefixed payload without permitting an untrusted
/// frame header to allocate arbitrary memory.
#[cfg(target_os = "linux")]
pub(crate) fn read_bounded_promotion_decision_frame(
    stream: &mut UnixStream,
) -> Result<Vec<u8>, PromotionDecisionHandlerError> {
    read_bounded_promotion_decision_frame_with_timeout(
        stream,
        PROMOTION_DECISION_FRAME_READ_TIMEOUT,
        |_| Ok(()),
    )
}

/// Test-only entrypoint for exercising a held-open frame without making the
/// production deadline caller-configurable.
#[cfg(all(test, target_os = "linux"))]
pub(crate) fn read_bounded_promotion_decision_frame_with_timeout_for_tests(
    stream: &mut UnixStream,
    read_timeout: Duration,
) -> Result<Vec<u8>, PromotionDecisionHandlerError> {
    read_bounded_promotion_decision_frame_with_timeout(stream, read_timeout, |_| Ok(()))
}

/// Read one bounded frame with a host-owned absolute deadline and a mandatory
/// gate just before each syscall that can block. The authenticated production
/// path uses the gate to re-check the peer before every header/body read; the
/// bare bounded reader uses a no-op gate only for isolated frame-reader tests.
#[cfg(target_os = "linux")]
fn read_bounded_promotion_decision_frame_with_timeout<F>(
    stream: &mut UnixStream,
    frame_timeout: Duration,
    mut before_read: F,
) -> Result<Vec<u8>, PromotionDecisionHandlerError>
where
    F: FnMut(&mut UnixStream) -> Result<(), PromotionDecisionHandlerError>,
{
    const MAX_PROMOTION_DECISION_FRAME_BYTES: usize = 16 * 1024;
    let deadline = Instant::now()
        .checked_add(frame_timeout)
        .ok_or(PromotionDecisionHandlerError::FrameRejected)?;

    let mut encoded_length = [0_u8; std::mem::size_of::<u32>()];
    read_frame_chunk_with_deadline(stream, deadline, &mut before_read, &mut encoded_length)?;

    let payload_length = u32::from_be_bytes(encoded_length) as usize;
    if payload_length == 0 || payload_length > MAX_PROMOTION_DECISION_FRAME_BYTES {
        return Err(PromotionDecisionHandlerError::FrameRejected);
    }

    let mut payload = vec![0_u8; payload_length];
    read_frame_chunk_with_deadline(stream, deadline, &mut before_read, &mut payload)?;
    Ok(payload)
}

#[cfg(target_os = "linux")]
fn read_frame_chunk_with_deadline<F>(
    stream: &mut UnixStream,
    deadline: Instant,
    before_read: &mut F,
    buffer: &mut [u8],
) -> Result<(), PromotionDecisionHandlerError>
where
    F: FnMut(&mut UnixStream) -> Result<(), PromotionDecisionHandlerError>,
{
    let mut filled = 0;
    while filled < buffer.len() {
        if Instant::now() >= deadline {
            return Err(PromotionDecisionHandlerError::FrameRejected);
        }

        before_read(stream)?;
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or(PromotionDecisionHandlerError::FrameRejected)?;
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|_| PromotionDecisionHandlerError::FrameRejected)?;

        let bytes_read = stream
            .read(&mut buffer[filled..])
            .map_err(|_| PromotionDecisionHandlerError::FrameRejected)?;
        if bytes_read == 0 {
            return Err(PromotionDecisionHandlerError::FrameRejected);
        }
        filled += bytes_read;
        if Instant::now() >= deadline {
            return Err(PromotionDecisionHandlerError::FrameRejected);
        }
    }
    Ok(())
}
