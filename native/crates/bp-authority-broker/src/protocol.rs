//! Linux-only, authenticated framing for the private authority-broker wire.
//!
//! This is preparation for a future protected host, not a listener or broker
//! activation surface. The caller supplies an already-connected stream, and
//! the confinement policy must authenticate its peer before this module reads
//! a single request byte.

use crate::admission_protocol::{
    parse_authority_broker_request_v1, ParsedAuthorityBrokerRequestV1,
};
use crate::confinement::{BrokerHostConfinementAttestationV1, BrokerHostConfinementPolicyV1};
use std::io::Read;
use std::os::unix::net::UnixStream;
use thiserror::Error;

/// Requests are bounded to 16 KiB so an untrusted length prefix can never
/// select an unbounded allocation. This comfortably exceeds the V1 fixtures.
const MAX_AUTHORITY_BROKER_FRAME_BYTES_V1: usize = 16 * 1024;

/// Closed protocol failures suitable for a future host-level error mapping.
///
/// Deliberately no confinement, I/O, or parser detail crosses this boundary.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum BrokerProtocolErrorV1 {
    #[error("authority broker peer was rejected")]
    PeerRejected,
    #[error("authority broker request frame was rejected")]
    FrameRejected,
    #[error("authority broker request payload was rejected")]
    RequestRejected,
}

/// Authenticate an already-connected Linux worker, then parse one V1 frame.
///
/// This has no listener, writes, dispatcher, handler, issuer, or authority
/// effect. Authentication is intentionally the first operation: an invalid
/// peer returns before any frame header or payload byte is consumed.
pub(crate) fn read_authenticated_authority_broker_request_v1(
    policy: &BrokerHostConfinementPolicyV1,
    attestation: &BrokerHostConfinementAttestationV1,
    stream: &mut UnixStream,
) -> Result<ParsedAuthorityBrokerRequestV1, BrokerProtocolErrorV1> {
    policy
        .verify_linux_connected_worker(attestation, stream)
        .map_err(|_| BrokerProtocolErrorV1::PeerRejected)?;

    read_bounded_authority_broker_request_v1(stream)
}

/// Read exactly one bounded frame and defer every semantic decision to V1.
fn read_bounded_authority_broker_request_v1(
    stream: &mut UnixStream,
) -> Result<ParsedAuthorityBrokerRequestV1, BrokerProtocolErrorV1> {
    let payload = read_bounded_frame(stream)?;
    parse_authority_broker_request_v1(&payload).map_err(|_| BrokerProtocolErrorV1::RequestRejected)
}

/// Read a big-endian u32 length-prefixed payload without attacker-sized allocs.
fn read_bounded_frame(stream: &mut UnixStream) -> Result<Vec<u8>, BrokerProtocolErrorV1> {
    let mut encoded_length = [0_u8; std::mem::size_of::<u32>()];
    stream
        .read_exact(&mut encoded_length)
        .map_err(|_| BrokerProtocolErrorV1::FrameRejected)?;

    let payload_length = u32::from_be_bytes(encoded_length) as usize;
    if payload_length == 0 || payload_length > MAX_AUTHORITY_BROKER_FRAME_BYTES_V1 {
        return Err(BrokerProtocolErrorV1::FrameRejected);
    }

    let mut payload = vec![0_u8; payload_length];
    stream
        .read_exact(&mut payload)
        .map_err(|_| BrokerProtocolErrorV1::FrameRejected)?;
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const AUTHORITY_BROKER_TS_ADMISSION_DIGEST: &str =
        "sha256:a8eba84025a9f3b6c6d44a9b4fe8446de7c9d7b75cfa335a6e83af202df38ed5";

    fn canonical_admission_wire() -> Vec<u8> {
        format!(
            r#"{{"schema_version":1,"operation":"admit","request_id":"123e4567-e89b-12d3-a456-426614174000","request":{{"run_id":"123e4567-e89b-12d3-a456-426614174003","workflow_id":"workflow-trust-spine","workflow_revision":"v1","unit_id":"unit-admit","attempt":1,"idempotency_key":"workflow-trust-spine:unit-admit:1","repository_target_ref":"broker://repositories/trust-spine","expected_repository_binding_digest":"sha256:{binding_digest}","governed_packet_ref":"cas://packets/trust-spine/admit","governed_packet_digest":"sha256:{packet_digest}"}},"request_digest":"{AUTHORITY_BROKER_TS_ADMISSION_DIGEST}"}}"#,
            binding_digest = "f".repeat(64),
            packet_digest = "2".repeat(64),
        )
        .into_bytes()
    }

    fn frame(payload: &[u8]) -> Vec<u8> {
        let mut framed = u32::try_from(payload.len())
            .expect("test payload fits the V1 frame length")
            .to_be_bytes()
            .to_vec();
        framed.extend_from_slice(payload);
        framed
    }

    fn read_frame_from_bytes(frame: &[u8]) -> Result<Vec<u8>, BrokerProtocolErrorV1> {
        let (mut broker_stream, mut worker_stream) =
            UnixStream::pair().expect("create a local Unix socket pair");
        worker_stream
            .write_all(frame)
            .expect("write the test frame before closing its peer");
        drop(worker_stream);
        read_bounded_frame(&mut broker_stream)
    }

    #[test]
    fn bounded_frame_reader_rejects_zero_oversized_and_truncated_frames() {
        assert_eq!(MAX_AUTHORITY_BROKER_FRAME_BYTES_V1, 16 * 1024);
        let oversized_length = u32::try_from(MAX_AUTHORITY_BROKER_FRAME_BYTES_V1 + 1)
            .expect("the small fixed maximum has a representable next value");
        let truncated_payload = [0, 0, 0, 4, b'{', b'}'];

        for (label, frame) in [
            ("zero-length", 0_u32.to_be_bytes().to_vec()),
            (
                "oversized header only",
                oversized_length.to_be_bytes().to_vec(),
            ),
            ("truncated header", vec![0, 0, 0]),
            ("truncated payload", truncated_payload.to_vec()),
        ] {
            assert!(
                matches!(
                    read_frame_from_bytes(&frame),
                    Err(BrokerProtocolErrorV1::FrameRejected)
                ),
                "{label} frame must fail closed"
            );
        }
    }

    #[test]
    fn bounded_request_reader_hands_valid_payload_to_v1_parser_and_closes_parser_failures() {
        let valid_frame = frame(&canonical_admission_wire());
        let (mut broker_stream, mut worker_stream) =
            UnixStream::pair().expect("create a local Unix socket pair");
        worker_stream
            .write_all(&valid_frame)
            .expect("write a canonical V1 fixture");
        drop(worker_stream);

        let parsed = read_bounded_authority_broker_request_v1(&mut broker_stream)
            .expect("the bounded canonical payload must reach the V1 parser");
        assert!(matches!(
            parsed,
            ParsedAuthorityBrokerRequestV1 {
                operation: crate::admission_protocol::AuthorityBrokerOperationV1::Admit,
                ..
            }
        ));

        let malformed_frame = frame(br#"{"not":"a closed V1 request"}"#);
        let (mut broker_stream, mut worker_stream) =
            UnixStream::pair().expect("create a second local Unix socket pair");
        worker_stream
            .write_all(&malformed_frame)
            .expect("write a malformed V1 payload");
        drop(worker_stream);

        assert!(matches!(
            read_bounded_authority_broker_request_v1(&mut broker_stream),
            Err(BrokerProtocolErrorV1::RequestRejected)
        ));
    }

    #[test]
    fn authenticated_gate_exposes_only_confinement_stream_and_parsed_request() {
        type Gate = fn(
            &BrokerHostConfinementPolicyV1,
            &BrokerHostConfinementAttestationV1,
            &mut UnixStream,
        ) -> Result<ParsedAuthorityBrokerRequestV1, BrokerProtocolErrorV1>;

        let gate: Gate = read_authenticated_authority_broker_request_v1;
        let _ = gate;
    }
}
