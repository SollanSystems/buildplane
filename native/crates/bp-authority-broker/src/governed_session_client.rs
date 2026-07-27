//! Closed stdin contract for the fixed governed-session native client.
//!
//! Parsing creates no authority. Paths, session identities, endpoints, signer
//! material, and protected replay state are never derived here; the installed
//! client forwards only this bounded request to its fixed authenticated host.

use ed25519_dalek::VerifyingKey;
use serde::Deserialize;
#[cfg(target_os = "linux")]
use std::fs::File;
#[cfg(target_os = "linux")]
use std::io::{Read, Write};
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
#[cfg(target_os = "linux")]
use std::os::unix::fs::MetadataExt;
#[cfg(target_os = "linux")]
use std::os::unix::net::UnixStream;
#[cfg(target_os = "linux")]
use std::path::{Path, PathBuf};
use std::process::ExitCode;
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};
use thiserror::Error;
use uuid::Uuid;

#[cfg(target_os = "linux")]
use crate::governed_session_response::verify_governed_session_response_v1;

const PROTOCOL: &str = "buildplane-governed-session";
const MAX_PACKET_SOURCE_BYTES: usize = 512 * 1024;
const MAX_CLIENT_REQUEST_BYTES: usize = 1024 * 1024;
#[cfg(target_os = "linux")]
const MAX_CLIENT_CONFIG_BYTES: usize = 4 * 1024;
#[cfg(target_os = "linux")]
const AUTHORITY_SOCKET_PATH: &str = "/run/buildplane/authority-host/governed-session-v1.sock";
#[cfg(target_os = "linux")]
const INSTALLED_CLIENT_PATH: &str = "/usr/libexec/buildplane/buildplane-governed-session-client";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GovernedSessionClientOperationV1 {
    Probe,
    OpenCandidateSession,
    OpenRecoverySession,
    RunCandidateSession,
    OpenReviewerSession,
    RunReviewerSession,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CandidateApprovalV1 {
    OperatorRequested,
    PreauthorizationRef(String),
    PreauthorizedEnvelopeSource(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ParsedGovernedSessionClientRequestV1 {
    Probe {
        request_id: String,
    },
    OpenCandidateSession {
        request_id: String,
        packet_source: String,
        project_root: String,
        approval: CandidateApprovalV1,
    },
    OpenRecoverySession {
        request_id: String,
        project_root: String,
        recovery_ref: String,
    },
    RunCandidateSession {
        request_id: String,
        recovery_ref: String,
        session_ref: String,
    },
    OpenReviewerSession {
        request_id: String,
        project_root: String,
        recovery_ref: String,
    },
    RunReviewerSession {
        request_id: String,
        recovery_ref: String,
        session_ref: String,
    },
}

impl ParsedGovernedSessionClientRequestV1 {
    pub(crate) fn operation(&self) -> GovernedSessionClientOperationV1 {
        match self {
            Self::Probe { .. } => GovernedSessionClientOperationV1::Probe,
            Self::OpenCandidateSession { .. } => {
                GovernedSessionClientOperationV1::OpenCandidateSession
            }
            Self::OpenRecoverySession { .. } => {
                GovernedSessionClientOperationV1::OpenRecoverySession
            }
            Self::RunCandidateSession { .. } => {
                GovernedSessionClientOperationV1::RunCandidateSession
            }
            Self::OpenReviewerSession { .. } => {
                GovernedSessionClientOperationV1::OpenReviewerSession
            }
            Self::RunReviewerSession { .. } => GovernedSessionClientOperationV1::RunReviewerSession,
        }
    }

    pub(crate) fn request_id(&self) -> &str {
        match self {
            Self::Probe { request_id }
            | Self::OpenCandidateSession { request_id, .. }
            | Self::OpenRecoverySession { request_id, .. }
            | Self::RunCandidateSession { request_id, .. }
            | Self::OpenReviewerSession { request_id, .. }
            | Self::RunReviewerSession { request_id, .. } => request_id,
        }
    }

    pub(crate) fn recovery_ref(&self) -> Option<&str> {
        match self {
            Self::Probe { .. } | Self::OpenCandidateSession { .. } => None,
            Self::OpenRecoverySession { recovery_ref, .. }
            | Self::RunCandidateSession { recovery_ref, .. }
            | Self::OpenReviewerSession { recovery_ref, .. }
            | Self::RunReviewerSession { recovery_ref, .. } => Some(recovery_ref),
        }
    }

    pub(crate) fn session_ref(&self) -> Option<&str> {
        match self {
            Self::RunCandidateSession { session_ref, .. }
            | Self::RunReviewerSession { session_ref, .. } => Some(session_ref),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum GovernedSessionClientErrorV1 {
    #[error("governed session client input was rejected")]
    InvalidInput,
    #[error("governed session client configuration was rejected")]
    InvalidConfig,
    #[error("governed session client connection was rejected")]
    ConnectionRejected,
    #[error("governed session client response was rejected")]
    InvalidResponse,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProtectedGovernedSessionClientConfigWireV1 {
    schema_version: u8,
    listener_creator_uid: u32,
    socket_group_gid: u32,
    broker_identity_public_key: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProtectedGovernedSessionClientConfigV1 {
    listener_creator_uid: u32,
    socket_group_gid: u32,
    broker_identity_public_key: VerifyingKey,
}

impl ProtectedGovernedSessionClientConfigV1 {
    pub(crate) fn listener_creator_uid(&self) -> u32 {
        self.listener_creator_uid
    }

    pub(crate) fn socket_group_gid(&self) -> u32 {
        self.socket_group_gid
    }

    pub(crate) fn broker_identity_public_key(&self) -> &VerifyingKey {
        &self.broker_identity_public_key
    }
}

pub(crate) fn parse_protected_governed_session_client_config_json(
    bytes: &[u8],
) -> Result<ProtectedGovernedSessionClientConfigV1, GovernedSessionClientErrorV1> {
    let wire: ProtectedGovernedSessionClientConfigWireV1 =
        serde_json::from_slice(bytes).map_err(|_| GovernedSessionClientErrorV1::InvalidConfig)?;
    if wire.schema_version != 1 || wire.listener_creator_uid != 0 {
        return Err(GovernedSessionClientErrorV1::InvalidConfig);
    }
    let public_key: [u8; 32] = wire
        .broker_identity_public_key
        .try_into()
        .map_err(|_| GovernedSessionClientErrorV1::InvalidConfig)?;
    let broker_identity_public_key = VerifyingKey::from_bytes(&public_key)
        .map_err(|_| GovernedSessionClientErrorV1::InvalidConfig)?;
    Ok(ProtectedGovernedSessionClientConfigV1 {
        listener_creator_uid: wire.listener_creator_uid,
        socket_group_gid: wire.socket_group_gid,
        broker_identity_public_key,
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenCandidateSessionWireV1 {
    schema_version: u8,
    protocol: String,
    operation: OpenCandidateOperationV1,
    request_id: String,
    packet_source: String,
    project_root: String,
    approval: CandidateApprovalWireV1,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProbeWireV1 {
    schema_version: u8,
    protocol: String,
    operation: ProbeOperationV1,
    request_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenRecoverySessionWireV1 {
    schema_version: u8,
    protocol: String,
    operation: OpenRecoveryOperationV1,
    request_id: String,
    project_root: String,
    recovery_ref: String,
    approval: OperatorApprovalWireV1,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RunCandidateSessionWireV1 {
    schema_version: u8,
    protocol: String,
    operation: RunCandidateOperationV1,
    request_id: String,
    recovery_ref: String,
    session_ref: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenReviewerSessionWireV1 {
    schema_version: u8,
    protocol: String,
    operation: OpenReviewerOperationV1,
    request_id: String,
    project_root: String,
    recovery_ref: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RunReviewerSessionWireV1 {
    schema_version: u8,
    protocol: String,
    operation: RunReviewerOperationV1,
    request_id: String,
    recovery_ref: String,
    session_ref: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum GovernedSessionClientRequestWireV1 {
    Probe(ProbeWireV1),
    OpenCandidateSession(OpenCandidateSessionWireV1),
    OpenRecoverySession(OpenRecoverySessionWireV1),
    RunCandidateSession(RunCandidateSessionWireV1),
    OpenReviewerSession(OpenReviewerSessionWireV1),
    RunReviewerSession(RunReviewerSessionWireV1),
}

#[derive(Deserialize)]
enum ProbeOperationV1 {
    #[serde(rename = "probe")]
    Probe,
}

#[derive(Deserialize)]
enum OpenCandidateOperationV1 {
    #[serde(rename = "open_candidate_session")]
    OpenCandidateSession,
}

#[derive(Deserialize)]
enum OpenRecoveryOperationV1 {
    #[serde(rename = "open_recovery_session")]
    OpenRecoverySession,
}

#[derive(Deserialize)]
enum RunCandidateOperationV1 {
    #[serde(rename = "run_candidate_session")]
    RunCandidateSession,
}

#[derive(Deserialize)]
enum OpenReviewerOperationV1 {
    #[serde(rename = "open_reviewer_session")]
    OpenReviewerSession,
}

#[derive(Deserialize)]
enum RunReviewerOperationV1 {
    #[serde(rename = "run_reviewer_session")]
    RunReviewerSession,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum CandidateApprovalWireV1 {
    OperatorRequested,
    PreauthorizationRef {
        preauthorization_ref: String,
    },
    PreauthorizedEnvelopeSource {
        preauthorized_envelope_source: String,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OperatorApprovalWireV1 {
    kind: OperatorApprovalKindV1,
}

#[derive(Deserialize)]
enum OperatorApprovalKindV1 {
    #[serde(rename = "operator_requested")]
    OperatorRequested,
}

pub(crate) fn parse_governed_session_client_request(
    bytes: &[u8],
) -> Result<ParsedGovernedSessionClientRequestV1, GovernedSessionClientErrorV1> {
    if bytes.is_empty() || bytes.len() > MAX_CLIENT_REQUEST_BYTES {
        return Err(GovernedSessionClientErrorV1::InvalidInput);
    }
    let wire: GovernedSessionClientRequestWireV1 =
        serde_json::from_slice(bytes).map_err(|_| GovernedSessionClientErrorV1::InvalidInput)?;
    match wire {
        GovernedSessionClientRequestWireV1::Probe(wire) => {
            validate_header(wire.schema_version, &wire.protocol, &wire.request_id)?;
            Ok(ParsedGovernedSessionClientRequestV1::Probe {
                request_id: wire.request_id,
            })
        }
        GovernedSessionClientRequestWireV1::OpenCandidateSession(wire) => {
            validate_header(wire.schema_version, &wire.protocol, &wire.request_id)?;
            let packet_source = require_bounded_source(wire.packet_source)?;
            let project_root = require_project_root(wire.project_root)?;
            let approval = match wire.approval {
                CandidateApprovalWireV1::OperatorRequested => {
                    CandidateApprovalV1::OperatorRequested
                }
                CandidateApprovalWireV1::PreauthorizationRef {
                    preauthorization_ref,
                } => CandidateApprovalV1::PreauthorizationRef(require_opaque_ref(
                    preauthorization_ref,
                )?),
                CandidateApprovalWireV1::PreauthorizedEnvelopeSource {
                    preauthorized_envelope_source,
                } => CandidateApprovalV1::PreauthorizedEnvelopeSource(require_bounded_source(
                    preauthorized_envelope_source,
                )?),
            };
            Ok(ParsedGovernedSessionClientRequestV1::OpenCandidateSession {
                request_id: wire.request_id,
                packet_source,
                project_root,
                approval,
            })
        }
        GovernedSessionClientRequestWireV1::OpenRecoverySession(wire) => {
            validate_header(wire.schema_version, &wire.protocol, &wire.request_id)?;
            let OperatorApprovalKindV1::OperatorRequested = wire.approval.kind;
            Ok(ParsedGovernedSessionClientRequestV1::OpenRecoverySession {
                request_id: wire.request_id,
                project_root: require_project_root(wire.project_root)?,
                recovery_ref: require_opaque_ref(wire.recovery_ref)?,
            })
        }
        GovernedSessionClientRequestWireV1::RunCandidateSession(wire) => {
            validate_header(wire.schema_version, &wire.protocol, &wire.request_id)?;
            Ok(ParsedGovernedSessionClientRequestV1::RunCandidateSession {
                request_id: wire.request_id,
                recovery_ref: require_opaque_ref(wire.recovery_ref)?,
                session_ref: require_opaque_ref(wire.session_ref)?,
            })
        }
        GovernedSessionClientRequestWireV1::OpenReviewerSession(wire) => {
            validate_header(wire.schema_version, &wire.protocol, &wire.request_id)?;
            Ok(ParsedGovernedSessionClientRequestV1::OpenReviewerSession {
                request_id: wire.request_id,
                project_root: require_project_root(wire.project_root)?,
                recovery_ref: require_opaque_ref(wire.recovery_ref)?,
            })
        }
        GovernedSessionClientRequestWireV1::RunReviewerSession(wire) => {
            validate_header(wire.schema_version, &wire.protocol, &wire.request_id)?;
            Ok(ParsedGovernedSessionClientRequestV1::RunReviewerSession {
                request_id: wire.request_id,
                recovery_ref: require_opaque_ref(wire.recovery_ref)?,
                session_ref: require_opaque_ref(wire.session_ref)?,
            })
        }
    }
}

fn validate_header(
    schema_version: u8,
    protocol: &str,
    request_id: &str,
) -> Result<(), GovernedSessionClientErrorV1> {
    if schema_version != 1 || protocol != PROTOCOL || !is_canonical_uuid(request_id) {
        return Err(GovernedSessionClientErrorV1::InvalidInput);
    }
    Ok(())
}

fn require_bounded_source(value: String) -> Result<String, GovernedSessionClientErrorV1> {
    if value.is_empty() || value.as_bytes().contains(&0) || value.len() > MAX_PACKET_SOURCE_BYTES {
        return Err(GovernedSessionClientErrorV1::InvalidInput);
    }
    Ok(value)
}

fn require_project_root(value: String) -> Result<String, GovernedSessionClientErrorV1> {
    if value.len() > 4096
        || !value.starts_with('/')
        || value.contains('\0')
        || value.contains('\\')
        || value.contains("//")
        || value
            .split('/')
            .any(|component| component == "." || component == "..")
    {
        return Err(GovernedSessionClientErrorV1::InvalidInput);
    }
    Ok(value)
}

fn require_opaque_ref(value: String) -> Result<String, GovernedSessionClientErrorV1> {
    if value.is_empty()
        || value.len() > 256
        || value.contains("..")
        || value.contains("//")
        || value.contains("@{")
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric()
                || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'/' | b'-'))
        })
    {
        return Err(GovernedSessionClientErrorV1::InvalidInput);
    }
    Ok(value)
}

fn is_canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value)
        .map(|uuid| uuid.hyphenated().to_string() == value)
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn validate_connected_listener_creator(
    stream: &UnixStream,
    expected_uid: u32,
) -> Result<(), GovernedSessionClientErrorV1> {
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
        return Err(GovernedSessionClientErrorV1::ConnectionRejected);
    }
    let credentials = unsafe { credentials.assume_init() };
    if credentials.pid <= 0 || credentials.uid != expected_uid {
        return Err(GovernedSessionClientErrorV1::ConnectionRejected);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn exchange_governed_session_with_stream(
    stream: &mut UnixStream,
    expected_listener_creator_uid: u32,
    broker_identity_public_key: &VerifyingKey,
    request: &ParsedGovernedSessionClientRequestV1,
    request_bytes: &[u8],
) -> Result<Vec<u8>, GovernedSessionClientErrorV1> {
    exchange_governed_session_with_stream_with_timeout(
        stream,
        expected_listener_creator_uid,
        broker_identity_public_key,
        request,
        request_bytes,
        Duration::from_secs(10),
    )
}

#[cfg(target_os = "linux")]
fn exchange_governed_session_with_stream_with_timeout(
    stream: &mut UnixStream,
    expected_listener_creator_uid: u32,
    broker_identity_public_key: &VerifyingKey,
    request: &ParsedGovernedSessionClientRequestV1,
    request_bytes: &[u8],
    timeout: Duration,
) -> Result<Vec<u8>, GovernedSessionClientErrorV1> {
    validate_connected_listener_creator(stream, expected_listener_creator_uid)?;
    if request_bytes.is_empty() || request_bytes.len() > MAX_CLIENT_REQUEST_BYTES {
        return Err(GovernedSessionClientErrorV1::InvalidInput);
    }
    let reparsed = parse_governed_session_client_request(request_bytes)?;
    if &reparsed != request {
        return Err(GovernedSessionClientErrorV1::InvalidInput);
    }
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or(GovernedSessionClientErrorV1::ConnectionRejected)?;
    let mut frame = u32::try_from(request_bytes.len())
        .map_err(|_| GovernedSessionClientErrorV1::InvalidInput)?
        .to_be_bytes()
        .to_vec();
    frame.extend_from_slice(request_bytes);
    write_all_with_absolute_deadline(stream, &frame, deadline, expected_listener_creator_uid)?;
    stream
        .shutdown(std::net::Shutdown::Write)
        .map_err(|_| GovernedSessionClientErrorV1::ConnectionRejected)?;

    let mut response_length = [0_u8; 4];
    read_exact_with_absolute_deadline(
        stream,
        &mut response_length,
        deadline,
        expected_listener_creator_uid,
    )?;
    let response_length = u32::from_be_bytes(response_length) as usize;
    if response_length == 0 || response_length > 1024 * 1024 {
        return Err(GovernedSessionClientErrorV1::InvalidResponse);
    }
    let mut response = vec![0_u8; response_length];
    read_exact_with_absolute_deadline(
        stream,
        &mut response,
        deadline,
        expected_listener_creator_uid,
    )?;
    require_eof_with_absolute_deadline(stream, deadline, expected_listener_creator_uid)?;
    let verified =
        verify_governed_session_response_v1(&response, broker_identity_public_key, request)
            .map_err(|_| GovernedSessionClientErrorV1::InvalidResponse)?;
    Ok(verified.projection_json().to_vec())
}

#[cfg(target_os = "linux")]
fn remaining_until(deadline: Instant) -> Result<Duration, GovernedSessionClientErrorV1> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or(GovernedSessionClientErrorV1::ConnectionRejected)
}

#[cfg(target_os = "linux")]
fn write_all_with_absolute_deadline(
    stream: &mut UnixStream,
    bytes: &[u8],
    deadline: Instant,
    expected_listener_creator_uid: u32,
) -> Result<(), GovernedSessionClientErrorV1> {
    let mut written = 0;
    while written < bytes.len() {
        validate_connected_listener_creator(stream, expected_listener_creator_uid)?;
        stream
            .set_write_timeout(Some(remaining_until(deadline)?))
            .map_err(|_| GovernedSessionClientErrorV1::ConnectionRejected)?;
        let count = stream
            .write(&bytes[written..])
            .map_err(|_| GovernedSessionClientErrorV1::ConnectionRejected)?;
        if count == 0 || Instant::now() >= deadline {
            return Err(GovernedSessionClientErrorV1::ConnectionRejected);
        }
        written += count;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn read_exact_with_absolute_deadline(
    stream: &mut UnixStream,
    bytes: &mut [u8],
    deadline: Instant,
    expected_listener_creator_uid: u32,
) -> Result<(), GovernedSessionClientErrorV1> {
    let mut read = 0;
    while read < bytes.len() {
        validate_connected_listener_creator(stream, expected_listener_creator_uid)?;
        stream
            .set_read_timeout(Some(remaining_until(deadline)?))
            .map_err(|_| GovernedSessionClientErrorV1::InvalidResponse)?;
        let count = stream
            .read(&mut bytes[read..])
            .map_err(|_| GovernedSessionClientErrorV1::InvalidResponse)?;
        if count == 0 || Instant::now() >= deadline {
            return Err(GovernedSessionClientErrorV1::InvalidResponse);
        }
        read += count;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn require_eof_with_absolute_deadline(
    stream: &mut UnixStream,
    deadline: Instant,
    expected_listener_creator_uid: u32,
) -> Result<(), GovernedSessionClientErrorV1> {
    validate_connected_listener_creator(stream, expected_listener_creator_uid)?;
    stream
        .set_read_timeout(Some(remaining_until(deadline)?))
        .map_err(|_| GovernedSessionClientErrorV1::InvalidResponse)?;
    let mut trailing = [0_u8; 1];
    match stream.read(&mut trailing) {
        Ok(0) if Instant::now() < deadline => Ok(()),
        Ok(_) | Err(_) => Err(GovernedSessionClientErrorV1::InvalidResponse),
    }
}

#[cfg(all(test, target_os = "linux"))]
pub(crate) fn exchange_governed_session_with_stream_for_test(
    stream: &mut UnixStream,
    expected_listener_creator_uid: u32,
    broker_identity_public_key: &VerifyingKey,
    request: &ParsedGovernedSessionClientRequestV1,
    request_bytes: &[u8],
) -> Result<Vec<u8>, GovernedSessionClientErrorV1> {
    exchange_governed_session_with_stream(
        stream,
        expected_listener_creator_uid,
        broker_identity_public_key,
        request,
        request_bytes,
    )
}

#[cfg(all(test, target_os = "linux"))]
pub(crate) fn exchange_governed_session_with_stream_with_timeout_for_test(
    stream: &mut UnixStream,
    expected_listener_creator_uid: u32,
    broker_identity_public_key: &VerifyingKey,
    request: &ParsedGovernedSessionClientRequestV1,
    request_bytes: &[u8],
    timeout: Duration,
) -> Result<Vec<u8>, GovernedSessionClientErrorV1> {
    exchange_governed_session_with_stream_with_timeout(
        stream,
        expected_listener_creator_uid,
        broker_identity_public_key,
        request,
        request_bytes,
        timeout,
    )
}

#[cfg(target_os = "linux")]
fn open_root() -> Result<File, GovernedSessionClientErrorV1> {
    let descriptor = unsafe {
        libc::open(
            c"/".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(GovernedSessionClientErrorV1::InvalidConfig);
    }
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

#[cfg(target_os = "linux")]
fn open_root_directory(
    parent: RawFd,
    component: &[u8],
) -> Result<File, GovernedSessionClientErrorV1> {
    let component = std::ffi::CString::new(component)
        .map_err(|_| GovernedSessionClientErrorV1::InvalidConfig)?;
    let descriptor = unsafe {
        libc::openat(
            parent,
            component.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(GovernedSessionClientErrorV1::InvalidConfig);
    }
    let directory = unsafe { File::from_raw_fd(descriptor) };
    let metadata = directory
        .metadata()
        .map_err(|_| GovernedSessionClientErrorV1::InvalidConfig)?;
    if metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
        return Err(GovernedSessionClientErrorV1::InvalidConfig);
    }
    Ok(directory)
}

#[cfg(target_os = "linux")]
fn walk_root_directories(components: &[&[u8]]) -> Result<File, GovernedSessionClientErrorV1> {
    let mut parent = open_root()?;
    for component in components {
        parent = open_root_directory(parent.as_raw_fd(), component)?;
    }
    Ok(parent)
}

#[cfg(target_os = "linux")]
fn load_default_client_config(
) -> Result<ProtectedGovernedSessionClientConfigV1, GovernedSessionClientErrorV1> {
    let parent = walk_root_directories(&[b"etc", b"buildplane", b"authority-host"])?;
    let name = std::ffi::CString::new(b"governed-session-client-v1.json".as_slice())
        .map_err(|_| GovernedSessionClientErrorV1::InvalidConfig)?;
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(GovernedSessionClientErrorV1::InvalidConfig);
    }
    let file = unsafe { File::from_raw_fd(descriptor) };
    let metadata = file
        .metadata()
        .map_err(|_| GovernedSessionClientErrorV1::InvalidConfig)?;
    if !metadata.file_type().is_file()
        || metadata.uid() != 0
        || metadata.nlink() != 1
        || metadata.mode() & 0o7777 != 0o644
    {
        return Err(GovernedSessionClientErrorV1::InvalidConfig);
    }
    let mut bytes = Vec::with_capacity(MAX_CLIENT_CONFIG_BYTES);
    file.take((MAX_CLIENT_CONFIG_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| GovernedSessionClientErrorV1::InvalidConfig)?;
    if bytes.is_empty() || bytes.len() > MAX_CLIENT_CONFIG_BYTES {
        return Err(GovernedSessionClientErrorV1::InvalidConfig);
    }
    parse_protected_governed_session_client_config_json(&bytes)
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SocketIdentityV1 {
    device: u64,
    inode: u64,
}

#[cfg(target_os = "linux")]
fn validate_default_socket_path(
    expected_group: u32,
) -> Result<SocketIdentityV1, GovernedSessionClientErrorV1> {
    let parent = walk_root_directories(&[b"run", b"buildplane", b"authority-host"])?;
    let name = std::ffi::CString::new(b"governed-session-v1.sock".as_slice())
        .map_err(|_| GovernedSessionClientErrorV1::ConnectionRejected)?;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
    if unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(GovernedSessionClientErrorV1::ConnectionRejected);
    }
    let stat = unsafe { stat.assume_init() };
    if stat.st_mode & libc::S_IFMT != libc::S_IFSOCK
        || stat.st_uid != 0
        || stat.st_gid != expected_group
        || stat.st_mode & 0o7777 != 0o660
        || stat.st_nlink != 1
    {
        return Err(GovernedSessionClientErrorV1::ConnectionRejected);
    }
    Ok(SocketIdentityV1 {
        device: stat.st_dev,
        inode: stat.st_ino,
    })
}

#[cfg(target_os = "linux")]
fn validate_installed_client() -> Result<(), GovernedSessionClientErrorV1> {
    let parent = walk_root_directories(&[b"usr", b"libexec", b"buildplane"])?;
    let name = std::ffi::CString::new(b"buildplane-governed-session-client".as_slice())
        .map_err(|_| GovernedSessionClientErrorV1::InvalidConfig)?;
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(GovernedSessionClientErrorV1::InvalidConfig);
    }
    let installed = unsafe { File::from_raw_fd(descriptor) };
    let installed_metadata = installed
        .metadata()
        .map_err(|_| GovernedSessionClientErrorV1::InvalidConfig)?;
    if !installed_metadata.file_type().is_file()
        || installed_metadata.uid() != 0
        || installed_metadata.nlink() != 1
        || installed_metadata.mode() & 0o7777 != 0o755
        || std::fs::read_link("/proc/self/exe").ok().as_deref()
            != Some(Path::new(INSTALLED_CLIENT_PATH))
    {
        return Err(GovernedSessionClientErrorV1::InvalidConfig);
    }
    let process_metadata = std::fs::metadata("/proc/self/exe")
        .map_err(|_| GovernedSessionClientErrorV1::InvalidConfig)?;
    if process_metadata.dev() != installed_metadata.dev()
        || process_metadata.ino() != installed_metadata.ino()
    {
        return Err(GovernedSessionClientErrorV1::InvalidConfig);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn read_bounded_stdin() -> Result<Vec<u8>, GovernedSessionClientErrorV1> {
    let mut bytes = Vec::with_capacity(16 * 1024);
    std::io::stdin()
        .take((MAX_CLIENT_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| GovernedSessionClientErrorV1::InvalidInput)?;
    if bytes.is_empty() || bytes.len() > MAX_CLIENT_REQUEST_BYTES {
        return Err(GovernedSessionClientErrorV1::InvalidInput);
    }
    Ok(bytes)
}

#[cfg(target_os = "linux")]
fn run_linux_client() -> Result<Vec<u8>, GovernedSessionClientErrorV1> {
    validate_installed_client()?;
    let config = load_default_client_config()?;
    let request_bytes = read_bounded_stdin()?;
    let request = parse_governed_session_client_request(&request_bytes)?;
    let before = validate_default_socket_path(config.socket_group_gid())?;
    let mut stream = UnixStream::connect(AUTHORITY_SOCKET_PATH)
        .map_err(|_| GovernedSessionClientErrorV1::ConnectionRejected)?;
    if stream
        .peer_addr()
        .ok()
        .and_then(|address| address.as_pathname().map(PathBuf::from))
        .as_deref()
        != Some(Path::new(AUTHORITY_SOCKET_PATH))
    {
        return Err(GovernedSessionClientErrorV1::ConnectionRejected);
    }
    validate_connected_listener_creator(&stream, config.listener_creator_uid())?;
    let after = validate_default_socket_path(config.socket_group_gid())?;
    if before != after {
        return Err(GovernedSessionClientErrorV1::ConnectionRejected);
    }
    exchange_governed_session_with_stream(
        &mut stream,
        config.listener_creator_uid(),
        config.broker_identity_public_key(),
        &request,
        &request_bytes,
    )
}

/// Run the fixed-path, no-authority governed-session client.
///
/// All deployment identities are compiled in or loaded from the root-owned
/// fixed config. Every failure is collapsed to one redacted category.
pub fn run_default_governed_session_client_v1() -> ExitCode {
    #[cfg(target_os = "linux")]
    {
        let projection = match run_linux_client() {
            Ok(projection) => projection,
            Err(_) => {
                eprintln!("client_blocked");
                return ExitCode::FAILURE;
            }
        };
        if std::io::stdout()
            .write_all(&projection)
            .and_then(|_| std::io::stdout().write_all(b"\n"))
            .is_err()
        {
            return ExitCode::FAILURE;
        }
        ExitCode::SUCCESS
    }
    #[cfg(not(target_os = "linux"))]
    {
        eprintln!("client_blocked");
        ExitCode::FAILURE
    }
}
