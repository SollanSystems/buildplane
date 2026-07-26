//! Authenticated transport boundary for a future protected governed-session host.
//!
//! The transport authenticates the fixed client peer, parses one bounded closed
//! request, invokes a broker-owned authority handler, validates the handler's
//! response against the original request, and signs exactly one response. It
//! deliberately exposes no production listener or default runner until the
//! candidate and reviewer authority handler is backed by trusted replay and
//! the OCI action plane.

use crate::governed_session_client::{
    parse_governed_session_client_request, ParsedGovernedSessionClientRequestV1,
};
use crate::governed_session_response::{
    sign_governed_session_probe_response_v1, sign_governed_session_response_v1,
};
use ed25519_dalek::SigningKey;
use serde_json::Value;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};
use thiserror::Error;

const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum GovernedSessionHostDispositionV1 {
    Ready,
    Opened {
        recovery_ref: String,
        session_ref: String,
    },
    Completed {
        recovery_ref: String,
        session_ref: String,
        result: Value,
    },
}

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum GovernedSessionHostErrorV1 {
    #[error("governed session connection rejected")]
    ConnectionRejected,
    #[error("governed session request rejected")]
    RequestRejected,
    #[error("governed session authority rejected")]
    AuthorityRejected,
    #[error("governed session response rejected")]
    ResponseRejected,
}

fn validate_peer(stream: &UnixStream, expected_uid: u32) -> Result<(), GovernedSessionHostErrorV1> {
    let mut credentials = std::mem::MaybeUninit::<libc::ucred>::uninit();
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            credentials.as_mut_ptr().cast(),
            &mut length,
        )
    };
    if result != 0 || length as usize != std::mem::size_of::<libc::ucred>() {
        return Err(GovernedSessionHostErrorV1::ConnectionRejected);
    }
    let credentials = unsafe { credentials.assume_init() };
    if credentials.pid <= 0 || credentials.uid != expected_uid {
        return Err(GovernedSessionHostErrorV1::ConnectionRejected);
    }
    Ok(())
}

fn remaining_until(deadline: Instant) -> Result<Duration, GovernedSessionHostErrorV1> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or(GovernedSessionHostErrorV1::ConnectionRejected)
}

fn read_exact_with_deadline(
    stream: &mut UnixStream,
    bytes: &mut [u8],
    deadline: Instant,
    expected_uid: u32,
) -> Result<(), GovernedSessionHostErrorV1> {
    let mut read = 0;
    while read < bytes.len() {
        validate_peer(stream, expected_uid)?;
        stream
            .set_read_timeout(Some(remaining_until(deadline)?))
            .map_err(|_| GovernedSessionHostErrorV1::ConnectionRejected)?;
        let count = stream
            .read(&mut bytes[read..])
            .map_err(|_| GovernedSessionHostErrorV1::ConnectionRejected)?;
        if count == 0 || Instant::now() >= deadline {
            return Err(GovernedSessionHostErrorV1::ConnectionRejected);
        }
        read += count;
    }
    Ok(())
}

fn require_request_eof(
    stream: &mut UnixStream,
    deadline: Instant,
    expected_uid: u32,
) -> Result<(), GovernedSessionHostErrorV1> {
    validate_peer(stream, expected_uid)?;
    stream
        .set_read_timeout(Some(remaining_until(deadline)?))
        .map_err(|_| GovernedSessionHostErrorV1::ConnectionRejected)?;
    let mut trailing = [0_u8; 1];
    match stream.read(&mut trailing) {
        Ok(0) if Instant::now() < deadline => Ok(()),
        Ok(_) | Err(_) => Err(GovernedSessionHostErrorV1::RequestRejected),
    }
}

fn write_all_with_deadline(
    stream: &mut UnixStream,
    bytes: &[u8],
    deadline: Instant,
    expected_uid: u32,
) -> Result<(), GovernedSessionHostErrorV1> {
    let mut written = 0;
    while written < bytes.len() {
        validate_peer(stream, expected_uid)?;
        stream
            .set_write_timeout(Some(remaining_until(deadline)?))
            .map_err(|_| GovernedSessionHostErrorV1::ConnectionRejected)?;
        let count = stream
            .write(&bytes[written..])
            .map_err(|_| GovernedSessionHostErrorV1::ConnectionRejected)?;
        if count == 0 || Instant::now() >= deadline {
            return Err(GovernedSessionHostErrorV1::ConnectionRejected);
        }
        written += count;
    }
    Ok(())
}

fn encode_disposition(
    signing_key: &SigningKey,
    request: &ParsedGovernedSessionClientRequestV1,
    disposition: GovernedSessionHostDispositionV1,
) -> Result<Vec<u8>, GovernedSessionHostErrorV1> {
    let response = match disposition {
        GovernedSessionHostDispositionV1::Ready => {
            sign_governed_session_probe_response_v1(signing_key, request)
        }
        GovernedSessionHostDispositionV1::Opened {
            recovery_ref,
            session_ref,
        } => sign_governed_session_response_v1(
            signing_key,
            request,
            &recovery_ref,
            &session_ref,
            None,
        ),
        GovernedSessionHostDispositionV1::Completed {
            recovery_ref,
            session_ref,
            result,
        } => sign_governed_session_response_v1(
            signing_key,
            request,
            &recovery_ref,
            &session_ref,
            Some(result),
        ),
    }
    .map_err(|_| GovernedSessionHostErrorV1::ResponseRejected)?;
    if response.is_empty() || response.len() > MAX_RESPONSE_BYTES {
        return Err(GovernedSessionHostErrorV1::ResponseRejected);
    }
    Ok(response)
}

pub(crate) fn handle_governed_session_connection<F>(
    stream: &mut UnixStream,
    expected_uid: u32,
    signing_key: &SigningKey,
    timeout: Duration,
    mut authorize: F,
) -> Result<(), GovernedSessionHostErrorV1>
where
    F: FnMut(
        &ParsedGovernedSessionClientRequestV1,
    ) -> Result<GovernedSessionHostDispositionV1, GovernedSessionHostErrorV1>,
{
    validate_peer(stream, expected_uid)?;
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or(GovernedSessionHostErrorV1::ConnectionRejected)?;
    let mut encoded_length = [0_u8; 4];
    read_exact_with_deadline(stream, &mut encoded_length, deadline, expected_uid)?;
    let length = u32::from_be_bytes(encoded_length) as usize;
    if length == 0 || length > MAX_REQUEST_BYTES {
        return Err(GovernedSessionHostErrorV1::RequestRejected);
    }
    let mut request_bytes = vec![0_u8; length];
    read_exact_with_deadline(stream, &mut request_bytes, deadline, expected_uid)?;
    require_request_eof(stream, deadline, expected_uid)?;
    let request = parse_governed_session_client_request(&request_bytes)
        .map_err(|_| GovernedSessionHostErrorV1::RequestRejected)?;
    let disposition =
        authorize(&request).map_err(|_| GovernedSessionHostErrorV1::AuthorityRejected)?;
    let response = encode_disposition(signing_key, &request, disposition)?;
    let mut frame = u32::try_from(response.len())
        .map_err(|_| GovernedSessionHostErrorV1::ResponseRejected)?
        .to_be_bytes()
        .to_vec();
    frame.extend_from_slice(&response);
    write_all_with_deadline(stream, &frame, deadline, expected_uid)?;
    stream
        .shutdown(std::net::Shutdown::Write)
        .map_err(|_| GovernedSessionHostErrorV1::ConnectionRejected)
}

pub(crate) fn handle_governed_session_connection_for_test<F>(
    stream: &mut UnixStream,
    expected_uid: u32,
    signing_key: &SigningKey,
    timeout: Duration,
    authorize: F,
) -> Result<(), GovernedSessionHostErrorV1>
where
    F: FnMut(
        &ParsedGovernedSessionClientRequestV1,
    ) -> Result<GovernedSessionHostDispositionV1, GovernedSessionHostErrorV1>,
{
    handle_governed_session_connection(stream, expected_uid, signing_key, timeout, authorize)
}
