//! Private authenticated ingress for one opaque promotion-execution request.
//!
//! This module deliberately starts no listener, writes no response, and has no
//! CLI, TypeScript, generic protocol, or controller registration. A future
//! protected Linux broker host may call the authenticated entrypoint only after
//! it has constructed a startup-bound promotion authority from its protected
//! ledger, replay, signer, and fixed-Git dependencies.

#[cfg(target_os = "linux")]
use crate::confinement::{BrokerHostConfinementAttestationV1, BrokerHostConfinementPolicyV1};
#[cfg(test)]
use crate::promotion_execution::{
    BrokerPromotionExecutionAuthority, PromotionEffectGateway, PromotionExecutionBackend,
    TrustedPromotionVerifier,
};
use crate::promotion_execution::{
    BrokerPromotionExecutionRequest, BrokerPromotionExecutionStatus,
    ProtectedPromotionExecutionAuthority,
};
use bp_ledger::EventId;
use serde::Deserialize;
#[cfg(target_os = "linux")]
use std::io::Read;
#[cfg(target_os = "linux")]
use std::os::unix::net::UnixStream;
use thiserror::Error;
use uuid::Uuid;

/// Closed local failures for the private authenticated promotion-execution
/// ingress. Authority, tape, replay, Git, and reconciliation internals never
/// cross this wire boundary.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum PromotionExecutionHandlerError {
    #[error("promotion execution peer was rejected")]
    PeerRejected,
    #[error("promotion execution frame was rejected")]
    FrameRejected,
    #[error("promotion execution request was rejected")]
    RequestRejected,
}

/// The entire caller-controlled promotion-execution wire contract.
///
/// The startup-bound authority already owns the run identity. Callers may name
/// only an existing sealed promotion-decision event; candidate, repository,
/// target-ref, Git, lease, signer, key, command, policy, idempotency, and
/// authority values are intentionally absent.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PromotionExecutionWire {
    request_id: String,
    promotion_decision_event_id: String,
}

/// Parse one closed promotion-execution identity request.
///
/// The request ID is canonicalized only as correlation metadata and then
/// discarded. The returned authority request has no field that can retain or
/// act on it.
pub(crate) fn parse_promotion_execution_request(
    wire: &[u8],
) -> Result<BrokerPromotionExecutionRequest, PromotionExecutionHandlerError> {
    let wire: PromotionExecutionWire = serde_json::from_slice(wire)
        .map_err(|_| PromotionExecutionHandlerError::RequestRejected)?;
    let _request_id = parse_canonical_uuid(wire.request_id)?;
    let promotion_decision_event_id =
        EventId::from_uuid(parse_canonical_uuid(wire.promotion_decision_event_id)?);
    Ok(BrokerPromotionExecutionRequest {
        promotion_decision_event_id,
    })
}

/// Require canonical lower-case hyphenated UUID text before creating a typed
/// ledger identifier. Transparent serde UUID parsing would accept multiple
/// spelling variants and is therefore intentionally not used here.
fn parse_canonical_uuid(value: String) -> Result<Uuid, PromotionExecutionHandlerError> {
    let uuid =
        Uuid::parse_str(&value).map_err(|_| PromotionExecutionHandlerError::RequestRejected)?;
    if uuid.hyphenated().to_string() != value {
        return Err(PromotionExecutionHandlerError::RequestRejected);
    }
    Ok(uuid)
}

/// Handle one already-authenticated opaque promotion-execution request.
///
/// Every authority error is reconciliation-only. In particular, replay,
/// ledger, claim, Git, and result-recording uncertainty cannot be observed as
/// a permission to retry or construct a second promotion capability.
///
/// A returned Recorded status means only that an existing authority effect has
/// a durable result record. It is not a workflow-completion signal or evidence
/// that the root checkout is synchronized; the reducer and reconciliation flow
/// remain authoritative for that conclusion.
pub(crate) fn handle_promotion_execution_wire(
    authority: &mut ProtectedPromotionExecutionAuthority<'_>,
    wire: &[u8],
) -> Result<BrokerPromotionExecutionStatus, PromotionExecutionHandlerError> {
    let request = parse_promotion_execution_request(wire)?;
    Ok(status_or_reconciliation(
        authority.claim_execute_and_record(request),
    ))
}

/// Generic test-only adapter for the existing authority fakes.
///
/// It is not compiled into a production broker, so the only production wire
/// handler above remains bound to ProtectedPromotionExecutionAuthority.
#[cfg(test)]
pub(crate) fn handle_promotion_execution_wire_for_tests<V, B, G>(
    authority: &mut BrokerPromotionExecutionAuthority<V, B, G>,
    wire: &[u8],
) -> Result<BrokerPromotionExecutionStatus, PromotionExecutionHandlerError>
where
    V: TrustedPromotionVerifier,
    B: PromotionExecutionBackend,
    G: PromotionEffectGateway,
{
    let request = parse_promotion_execution_request(wire)?;
    Ok(status_or_reconciliation(
        authority.claim_execute_and_record(request),
    ))
}

fn status_or_reconciliation<E>(
    result: Result<BrokerPromotionExecutionStatus, E>,
) -> BrokerPromotionExecutionStatus {
    match result {
        Ok(status) => status,
        Err(_) => BrokerPromotionExecutionStatus::ReconciliationRequired,
    }
}

/// Authenticate a connected Linux worker before reading exactly one bounded
/// promotion-execution frame, then run the opaque promotion handler.
///
/// This function starts no listener and writes no response. Peer verification
/// is intentionally its first operation, so a rejected same-UID or
/// unconfigured worker cannot cause even a frame-header read or a Git/tape
/// operation.
#[cfg(target_os = "linux")]
pub(crate) fn handle_authenticated_promotion_execution_request(
    policy: &BrokerHostConfinementPolicyV1,
    attestation: &BrokerHostConfinementAttestationV1,
    stream: &mut UnixStream,
    authority: &mut ProtectedPromotionExecutionAuthority<'_>,
) -> Result<BrokerPromotionExecutionStatus, PromotionExecutionHandlerError> {
    let payload = read_authenticated_promotion_execution_frame(policy, attestation, stream)?;
    handle_promotion_execution_wire(authority, &payload)
}

/// Authenticate a connected Linux worker, then return its one bounded opaque
/// frame. This has no promotion authority by itself; the production handler
/// above is the only caller that can pair it with the fixed authority.
#[cfg(target_os = "linux")]
pub(crate) fn read_authenticated_promotion_execution_frame(
    policy: &BrokerHostConfinementPolicyV1,
    attestation: &BrokerHostConfinementAttestationV1,
    stream: &mut UnixStream,
) -> Result<Vec<u8>, PromotionExecutionHandlerError> {
    policy
        .verify_linux_connected_worker(attestation, stream)
        .map_err(|_| PromotionExecutionHandlerError::PeerRejected)?;

    read_bounded_promotion_execution_frame(stream)
}

/// Read one big-endian length-prefixed payload without permitting an untrusted
/// frame header to allocate arbitrary memory.
#[cfg(target_os = "linux")]
pub(crate) fn read_bounded_promotion_execution_frame(
    stream: &mut UnixStream,
) -> Result<Vec<u8>, PromotionExecutionHandlerError> {
    const MAX_PROMOTION_EXECUTION_FRAME_BYTES: usize = 16 * 1024;

    let mut encoded_length = [0_u8; std::mem::size_of::<u32>()];
    stream
        .read_exact(&mut encoded_length)
        .map_err(|_| PromotionExecutionHandlerError::FrameRejected)?;

    let payload_length = u32::from_be_bytes(encoded_length) as usize;
    if payload_length == 0 || payload_length > MAX_PROMOTION_EXECUTION_FRAME_BYTES {
        return Err(PromotionExecutionHandlerError::FrameRejected);
    }

    let mut payload = vec![0_u8; payload_length];
    stream
        .read_exact(&mut payload)
        .map_err(|_| PromotionExecutionHandlerError::FrameRejected)?;
    Ok(payload)
}
