//! No-authority client boundary for one protected promotion decision.
//!
//! This module can submit only one existing approval event identity and one
//! closed operator choice. It owns no signer, ledger, reducer, Git, worker, or
//! promotion-execution capability.

use crate::promotion_decision_response::{
    verify_promotion_decision_response, PromotionDecisionResponseBindingV1,
    PromotionDecisionResponseStatusV1,
};
use crate::promotion_execution_response::{
    verify_promotion_execution_response, PromotionExecutionResponseBindingV1,
    PromotionExecutionResponseStatusV1,
};
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
#[cfg(all(test, target_os = "linux"))]
use std::path::Component;
#[cfg(target_os = "linux")]
use std::path::Path;
use std::process::ExitCode;
#[cfg(target_os = "linux")]
use std::time::Duration;
use thiserror::Error;
use uuid::Uuid;

const MAX_PROMOTION_DECISION_REQUEST_FRAME_BYTES: usize = 16 * 1024;
const MAX_PROMOTION_DECISION_RESPONSE_FRAME_BYTES: usize = 4 * 1024;
#[cfg(target_os = "linux")]
const MAX_PROTECTED_CLIENT_CONFIG_BYTES: usize = 4 * 1024;
#[cfg(target_os = "linux")]
const PROMOTION_DECISION_IO_TIMEOUT: Duration = Duration::from_secs(5);
const RECONCILIATION_REQUIRED_RESPONSE_JSON: &[u8] =
    br#"{"schema_version":2,"status":"reconciliation_required","promotion_decision_event_id":null}"#;
#[cfg(target_os = "linux")]
const PROTECTED_CLIENT_CONFIG_PARENT_COMPONENTS: [&[u8]; 3] =
    [b"etc", b"buildplane", b"authority-host"];
#[cfg(target_os = "linux")]
const PROTECTED_CLIENT_CONFIG_FILE_NAME: &[u8] = b"promotion-decision-client-v1.json";
#[cfg(target_os = "linux")]
const PROTECTED_EXECUTION_CLIENT_CONFIG_FILE_NAME: &[u8] = b"promotion-execution-client-v1.json";
#[cfg(target_os = "linux")]
const AUTHORITY_SOCKET_PARENT_COMPONENTS: [&[u8]; 3] = [b"run", b"buildplane", b"authority-host"];
#[cfg(target_os = "linux")]
const AUTHORITY_SOCKET_FILE_NAME: &[u8] = b"promotion-decision-v1.sock";
#[cfg(target_os = "linux")]
const EXECUTION_SOCKET_FILE_NAME: &[u8] = b"promotion-execution-v1.sock";
#[cfg(target_os = "linux")]
const AUTHORITY_SOCKET_PATH: &str = "/run/buildplane/authority-host/promotion-decision-v1.sock";
#[cfg(target_os = "linux")]
const EXECUTION_SOCKET_PATH: &str = "/run/buildplane/authority-host/promotion-execution-v1.sock";
#[cfg(target_os = "linux")]
const INSTALLED_CLIENT_PARENT_COMPONENTS: [&[u8]; 3] = [b"usr", b"libexec", b"buildplane"];
#[cfg(target_os = "linux")]
const INSTALLED_CLIENT_FILE_NAME: &[u8] = b"buildplane-authority-client";
#[cfg(target_os = "linux")]
const INSTALLED_CLIENT_PATH: &str = "/usr/libexec/buildplane/buildplane-authority-client";

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum PromotionDecisionClientErrorV1 {
    #[error("promotion decision client input was rejected")]
    InvalidInput,
    #[error("promotion decision client configuration was rejected")]
    InvalidConfig,
    #[error("promotion decision client response was rejected")]
    InvalidResponse,
    #[error("promotion decision client connection was rejected")]
    ConnectionRejected,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClientRequestWireV1 {
    schema_version: u8,
    promotion_approval_request_event_id: String,
    decision: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PromotionExecutionClientRequestWireV1 {
    schema_version: u8,
    operation: String,
    promotion_decision_event_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PromotionDecisionClientRequestV1 {
    promotion_approval_request_event_id: String,
    decision: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PromotionExecutionClientRequestV1 {
    promotion_decision_event_id: String,
}

impl PromotionExecutionClientRequestV1 {
    #[cfg(test)]
    pub(crate) fn promotion_decision_event_id(&self) -> &str {
        &self.promotion_decision_event_id
    }
}

impl PromotionDecisionClientRequestV1 {
    #[cfg(test)]
    pub(crate) fn promotion_approval_request_event_id(&self) -> &str {
        &self.promotion_approval_request_event_id
    }

    #[cfg(test)]
    pub(crate) fn decision(&self) -> &str {
        &self.decision
    }
}

pub(crate) fn parse_client_request_stdin(
    bytes: &[u8],
) -> Result<PromotionDecisionClientRequestV1, PromotionDecisionClientErrorV1> {
    let wire: ClientRequestWireV1 =
        serde_json::from_slice(bytes).map_err(|_| PromotionDecisionClientErrorV1::InvalidInput)?;
    if wire.schema_version != 1
        || !is_canonical_uuid(&wire.promotion_approval_request_event_id)
        || (wire.decision != "promote" && wire.decision != "reject")
    {
        return Err(PromotionDecisionClientErrorV1::InvalidInput);
    }
    Ok(PromotionDecisionClientRequestV1 {
        promotion_approval_request_event_id: wire.promotion_approval_request_event_id,
        decision: wire.decision,
    })
}

pub(crate) fn parse_promotion_execution_client_request_stdin(
    bytes: &[u8],
) -> Result<PromotionExecutionClientRequestV1, PromotionDecisionClientErrorV1> {
    let wire: PromotionExecutionClientRequestWireV1 =
        serde_json::from_slice(bytes).map_err(|_| PromotionDecisionClientErrorV1::InvalidInput)?;
    if wire.schema_version != 1
        || wire.operation != "execute_promotion"
        || !is_canonical_uuid(&wire.promotion_decision_event_id)
    {
        return Err(PromotionDecisionClientErrorV1::InvalidInput);
    }
    Ok(PromotionExecutionClientRequestV1 {
        promotion_decision_event_id: wire.promotion_decision_event_id,
    })
}

fn is_canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value)
        .map(|uuid| uuid.hyphenated().to_string() == value)
        .unwrap_or(false)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProtectedClientConfigWireV1 {
    schema_version: u8,
    listener_creator_uid: u32,
    socket_group_gid: u32,
    broker_identity_public_key: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProtectedPromotionDecisionClientConfigV1 {
    listener_creator_uid: u32,
    socket_group_gid: u32,
    broker_identity_public_key: VerifyingKey,
}

impl ProtectedPromotionDecisionClientConfigV1 {
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

pub(crate) fn parse_protected_client_config_json(
    bytes: &[u8],
) -> Result<ProtectedPromotionDecisionClientConfigV1, PromotionDecisionClientErrorV1> {
    let wire: ProtectedClientConfigWireV1 =
        serde_json::from_slice(bytes).map_err(|_| PromotionDecisionClientErrorV1::InvalidConfig)?;
    if wire.schema_version != 1 || wire.listener_creator_uid != 0 {
        return Err(PromotionDecisionClientErrorV1::InvalidConfig);
    }
    let public_key: [u8; 32] = wire
        .broker_identity_public_key
        .try_into()
        .map_err(|_| PromotionDecisionClientErrorV1::InvalidConfig)?;
    let broker_identity_public_key = VerifyingKey::from_bytes(&public_key)
        .map_err(|_| PromotionDecisionClientErrorV1::InvalidConfig)?;
    Ok(ProtectedPromotionDecisionClientConfigV1 {
        listener_creator_uid: wire.listener_creator_uid,
        socket_group_gid: wire.socket_group_gid,
        broker_identity_public_key,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClientConfigDescriptorKindV1 {
    Directory,
    RegularFile,
    Symlink,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ClientConfigDescriptorFactsV1 {
    kind: ClientConfigDescriptorKindV1,
    uid: u32,
    mode: u32,
    link_count: u64,
}

impl ClientConfigDescriptorFactsV1 {
    pub(crate) fn new(
        kind: ClientConfigDescriptorKindV1,
        uid: u32,
        mode: u32,
        link_count: u64,
    ) -> Self {
        Self {
            kind,
            uid,
            mode,
            link_count,
        }
    }
}

pub(crate) fn validate_client_config_file_facts(
    facts: ClientConfigDescriptorFactsV1,
) -> Result<(), PromotionDecisionClientErrorV1> {
    if facts.kind != ClientConfigDescriptorKindV1::RegularFile
        || facts.uid != 0
        || facts.mode != 0o644
        || facts.link_count != 1
    {
        return Err(PromotionDecisionClientErrorV1::InvalidConfig);
    }
    Ok(())
}

pub(crate) fn validate_client_executable_facts(
    facts: ClientConfigDescriptorFactsV1,
) -> Result<(), PromotionDecisionClientErrorV1> {
    if facts.kind != ClientConfigDescriptorKindV1::RegularFile
        || facts.uid != 0
        || facts.mode != 0o755
        || facts.link_count != 1
    {
        return Err(PromotionDecisionClientErrorV1::InvalidConfig);
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ClientParentDescriptorFactsV1 {
    kind: ClientConfigDescriptorKindV1,
    uid: u32,
    mode: u32,
}

impl ClientParentDescriptorFactsV1 {
    pub(crate) fn new(kind: ClientConfigDescriptorKindV1, uid: u32, mode: u32) -> Self {
        Self { kind, uid, mode }
    }
}

pub(crate) fn validate_client_parent_facts(
    facts: ClientParentDescriptorFactsV1,
) -> Result<(), PromotionDecisionClientErrorV1> {
    if facts.kind != ClientConfigDescriptorKindV1::Directory
        || facts.uid != 0
        || facts.mode != 0o755
    {
        return Err(PromotionDecisionClientErrorV1::InvalidConfig);
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SocketDescriptorKindV1 {
    UnixSocket,
    Symlink,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SocketDescriptorFactsV1 {
    kind: SocketDescriptorKindV1,
    uid: u32,
    gid: u32,
    mode: u32,
    link_count: u64,
    device: u64,
    inode: u64,
}

impl SocketDescriptorFactsV1 {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        kind: SocketDescriptorKindV1,
        uid: u32,
        gid: u32,
        mode: u32,
        link_count: u64,
        device: u64,
        inode: u64,
    ) -> Self {
        Self {
            kind,
            uid,
            gid,
            mode,
            link_count,
            device,
            inode,
        }
    }
}

pub(crate) fn validate_socket_facts(
    facts: SocketDescriptorFactsV1,
    expected_group: u32,
) -> Result<(), PromotionDecisionClientErrorV1> {
    if facts.kind != SocketDescriptorKindV1::UnixSocket
        || facts.uid != 0
        || facts.gid != expected_group
        || facts.mode != 0o660
        || facts.link_count != 1
        || facts.device == 0
        || facts.inode == 0
    {
        return Err(PromotionDecisionClientErrorV1::InvalidConfig);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn validate_connected_listener_creator(
    stream: &std::os::unix::net::UnixStream,
    expected_listener_creator_uid: u32,
) -> Result<(), PromotionDecisionClientErrorV1> {
    use std::os::fd::AsRawFd;
    let mut credentials = std::mem::MaybeUninit::<libc::ucred>::zeroed();
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            credentials.as_mut_ptr().cast(),
            std::ptr::addr_of_mut!(length),
        )
    } != 0
        || length as usize != std::mem::size_of::<libc::ucred>()
    {
        return Err(PromotionDecisionClientErrorV1::InvalidConfig);
    }
    let credentials = unsafe { credentials.assume_init() };
    if credentials.pid <= 0 || credentials.uid != expected_listener_creator_uid {
        return Err(PromotionDecisionClientErrorV1::InvalidConfig);
    }
    Ok(())
}

#[cfg(all(test, target_os = "linux"))]
pub(crate) fn validate_connected_listener_creator_for_test(
    stream: &std::os::unix::net::UnixStream,
    expected_listener_creator_uid: u32,
) -> Result<(), PromotionDecisionClientErrorV1> {
    validate_connected_listener_creator(stream, expected_listener_creator_uid)
}

#[cfg(test)]
pub(crate) fn encode_promotion_decision_request_frame(
    request: &PromotionDecisionClientRequestV1,
) -> Result<Vec<u8>, PromotionDecisionClientErrorV1> {
    encode_promotion_decision_request_frame_with_id(request).map(|encoded| encoded.frame)
}

struct EncodedPromotionDecisionRequestV1 {
    request_id: String,
    frame: Vec<u8>,
}

struct EncodedPromotionExecutionRequestV1 {
    request_id: String,
    frame: Vec<u8>,
}

fn encode_promotion_decision_request_frame_with_id(
    request: &PromotionDecisionClientRequestV1,
) -> Result<EncodedPromotionDecisionRequestV1, PromotionDecisionClientErrorV1> {
    let request_id = Uuid::now_v7().hyphenated().to_string();
    let payload = format!(
        r#"{{"request_id":"{request_id}","promotion_approval_request_event_id":"{}","decision":"{}"}}"#,
        request.promotion_approval_request_event_id, request.decision
    );
    if payload.is_empty() || payload.len() > MAX_PROMOTION_DECISION_REQUEST_FRAME_BYTES {
        return Err(PromotionDecisionClientErrorV1::InvalidInput);
    }
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload.as_bytes());
    Ok(EncodedPromotionDecisionRequestV1 { request_id, frame })
}

#[cfg(test)]
pub(crate) fn encode_promotion_execution_request_frame(
    request: &PromotionExecutionClientRequestV1,
) -> Result<Vec<u8>, PromotionDecisionClientErrorV1> {
    encode_promotion_execution_request_frame_with_id(request).map(|encoded| encoded.frame)
}

fn encode_promotion_execution_request_frame_with_id(
    request: &PromotionExecutionClientRequestV1,
) -> Result<EncodedPromotionExecutionRequestV1, PromotionDecisionClientErrorV1> {
    let request_id = Uuid::now_v7().hyphenated().to_string();
    let payload = format!(
        r#"{{"request_id":"{request_id}","promotion_decision_event_id":"{}"}}"#,
        request.promotion_decision_event_id
    );
    if payload.is_empty() || payload.len() > MAX_PROMOTION_DECISION_REQUEST_FRAME_BYTES {
        return Err(PromotionDecisionClientErrorV1::InvalidInput);
    }
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload.as_bytes());
    Ok(EncodedPromotionExecutionRequestV1 { request_id, frame })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PromotionDecisionClientStatusV1 {
    Sealed { promotion_decision_event_id: String },
    ReconciliationRequired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PromotionExecutionClientStatusV1 {
    Rejected,
    Pending,
    Completed,
    Recorded,
    LeaseExpired,
    ReconciliationRequired,
}

#[cfg(target_os = "linux")]
fn exchange_promotion_decision_with_stream(
    stream: &mut UnixStream,
    expected_listener_creator_uid: u32,
    broker_identity_public_key: &VerifyingKey,
    request: &PromotionDecisionClientRequestV1,
) -> Result<PromotionDecisionClientStatusV1, PromotionDecisionClientErrorV1> {
    validate_connected_listener_creator(stream, expected_listener_creator_uid)?;
    stream
        .set_write_timeout(Some(PROMOTION_DECISION_IO_TIMEOUT))
        .map_err(|_| PromotionDecisionClientErrorV1::ConnectionRejected)?;
    let encoded = encode_promotion_decision_request_frame_with_id(request)?;
    stream
        .write_all(&encoded.frame)
        .map_err(|_| PromotionDecisionClientErrorV1::ConnectionRejected)?;

    validate_connected_listener_creator(stream, expected_listener_creator_uid)?;
    stream
        .set_read_timeout(Some(PROMOTION_DECISION_IO_TIMEOUT))
        .map_err(|_| PromotionDecisionClientErrorV1::ConnectionRejected)?;
    let mut header = [0_u8; 4];
    stream
        .read_exact(&mut header)
        .map_err(|_| PromotionDecisionClientErrorV1::InvalidResponse)?;
    let payload_length = u32::from_be_bytes(header) as usize;
    if payload_length == 0 || payload_length > MAX_PROMOTION_DECISION_RESPONSE_FRAME_BYTES {
        return Err(PromotionDecisionClientErrorV1::InvalidResponse);
    }
    validate_connected_listener_creator(stream, expected_listener_creator_uid)?;
    let mut payload = vec![0_u8; payload_length];
    stream
        .read_exact(&mut payload)
        .map_err(|_| PromotionDecisionClientErrorV1::InvalidResponse)?;
    let binding = PromotionDecisionResponseBindingV1::new(
        &encoded.request_id,
        &request.promotion_approval_request_event_id,
        &request.decision,
    )
    .map_err(|_| PromotionDecisionClientErrorV1::InvalidResponse)?;
    let status = verify_promotion_decision_response(&payload, broker_identity_public_key, binding)
        .map_err(|_| PromotionDecisionClientErrorV1::InvalidResponse)?;
    validate_connected_listener_creator(stream, expected_listener_creator_uid)?;
    let mut trailing = [0_u8; 1];
    if stream
        .read(&mut trailing)
        .map_err(|_| PromotionDecisionClientErrorV1::InvalidResponse)?
        != 0
    {
        return Err(PromotionDecisionClientErrorV1::InvalidResponse);
    }
    match status {
        (PromotionDecisionResponseStatusV1::Sealed, Some(promotion_decision_event_id)) => {
            Ok(PromotionDecisionClientStatusV1::Sealed {
                promotion_decision_event_id,
            })
        }
        (PromotionDecisionResponseStatusV1::ReconciliationRequired, None) => {
            Ok(PromotionDecisionClientStatusV1::ReconciliationRequired)
        }
        _ => Err(PromotionDecisionClientErrorV1::InvalidResponse),
    }
}

#[cfg(target_os = "linux")]
fn exchange_promotion_execution_with_stream(
    stream: &mut UnixStream,
    expected_listener_creator_uid: u32,
    broker_identity_public_key: &VerifyingKey,
    request: &PromotionExecutionClientRequestV1,
) -> Result<PromotionExecutionClientStatusV1, PromotionDecisionClientErrorV1> {
    validate_connected_listener_creator(stream, expected_listener_creator_uid)?;
    stream
        .set_write_timeout(Some(PROMOTION_DECISION_IO_TIMEOUT))
        .map_err(|_| PromotionDecisionClientErrorV1::ConnectionRejected)?;
    let encoded = encode_promotion_execution_request_frame_with_id(request)?;
    stream
        .write_all(&encoded.frame)
        .map_err(|_| PromotionDecisionClientErrorV1::ConnectionRejected)?;

    validate_connected_listener_creator(stream, expected_listener_creator_uid)?;
    stream
        .set_read_timeout(Some(PROMOTION_DECISION_IO_TIMEOUT))
        .map_err(|_| PromotionDecisionClientErrorV1::ConnectionRejected)?;
    let mut header = [0_u8; 4];
    stream
        .read_exact(&mut header)
        .map_err(|_| PromotionDecisionClientErrorV1::InvalidResponse)?;
    let payload_length = u32::from_be_bytes(header) as usize;
    if payload_length == 0 || payload_length > MAX_PROMOTION_DECISION_RESPONSE_FRAME_BYTES {
        return Err(PromotionDecisionClientErrorV1::InvalidResponse);
    }
    validate_connected_listener_creator(stream, expected_listener_creator_uid)?;
    let mut payload = vec![0_u8; payload_length];
    stream
        .read_exact(&mut payload)
        .map_err(|_| PromotionDecisionClientErrorV1::InvalidResponse)?;
    let binding = PromotionExecutionResponseBindingV1::new(
        &encoded.request_id,
        &request.promotion_decision_event_id,
    )
    .map_err(|_| PromotionDecisionClientErrorV1::InvalidResponse)?;
    let status = verify_promotion_execution_response(&payload, broker_identity_public_key, binding)
        .map_err(|_| PromotionDecisionClientErrorV1::InvalidResponse)?;
    validate_connected_listener_creator(stream, expected_listener_creator_uid)?;
    let mut trailing = [0_u8; 1];
    if stream
        .read(&mut trailing)
        .map_err(|_| PromotionDecisionClientErrorV1::InvalidResponse)?
        != 0
    {
        return Err(PromotionDecisionClientErrorV1::InvalidResponse);
    }
    Ok(match status {
        PromotionExecutionResponseStatusV1::Rejected => PromotionExecutionClientStatusV1::Rejected,
        PromotionExecutionResponseStatusV1::Pending => PromotionExecutionClientStatusV1::Pending,
        PromotionExecutionResponseStatusV1::Completed => {
            PromotionExecutionClientStatusV1::Completed
        }
        PromotionExecutionResponseStatusV1::Recorded => PromotionExecutionClientStatusV1::Recorded,
        PromotionExecutionResponseStatusV1::LeaseExpired => {
            PromotionExecutionClientStatusV1::LeaseExpired
        }
        PromotionExecutionResponseStatusV1::ReconciliationRequired => {
            PromotionExecutionClientStatusV1::ReconciliationRequired
        }
    })
}

#[cfg(target_os = "linux")]
fn open_directory_at(
    parent: RawFd,
    component: &[u8],
) -> Result<File, PromotionDecisionClientErrorV1> {
    let component = std::ffi::CString::new(component)
        .map_err(|_| PromotionDecisionClientErrorV1::InvalidConfig)?;
    let descriptor = unsafe {
        libc::openat(
            parent,
            component.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(PromotionDecisionClientErrorV1::InvalidConfig);
    }
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

#[cfg(target_os = "linux")]
fn config_kind_from_mode(mode: libc::mode_t) -> ClientConfigDescriptorKindV1 {
    match mode & libc::S_IFMT {
        libc::S_IFDIR => ClientConfigDescriptorKindV1::Directory,
        libc::S_IFREG => ClientConfigDescriptorKindV1::RegularFile,
        libc::S_IFLNK => ClientConfigDescriptorKindV1::Symlink,
        _ => ClientConfigDescriptorKindV1::Other,
    }
}

#[cfg(target_os = "linux")]
fn validate_directory_for_owner(
    directory: &File,
    expected_owner: u32,
) -> Result<(), PromotionDecisionClientErrorV1> {
    let metadata = directory
        .metadata()
        .map_err(|_| PromotionDecisionClientErrorV1::InvalidConfig)?;
    if metadata.uid() != expected_owner {
        return Err(PromotionDecisionClientErrorV1::InvalidConfig);
    }
    validate_client_parent_facts(ClientParentDescriptorFactsV1::new(
        config_kind_from_mode(metadata.mode()),
        0,
        metadata.mode() & 0o7777,
    ))
}

#[cfg(target_os = "linux")]
fn open_validated_parent_from_anchor(
    anchor: &File,
    components: &[Vec<u8>],
    expected_owner: u32,
) -> Result<File, PromotionDecisionClientErrorV1> {
    let duplicate = unsafe { libc::fcntl(anchor.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
    if duplicate < 0 {
        return Err(PromotionDecisionClientErrorV1::InvalidConfig);
    }
    let mut current = unsafe { File::from_raw_fd(duplicate) };
    validate_directory_for_owner(&current, expected_owner)?;
    for component in components {
        let child = open_directory_at(current.as_raw_fd(), component)?;
        validate_directory_for_owner(&child, expected_owner)?;
        current = child;
    }
    Ok(current)
}

#[cfg(target_os = "linux")]
fn open_config_at(
    parent: RawFd,
    file_name: &[u8],
    expected_owner: u32,
) -> Result<File, PromotionDecisionClientErrorV1> {
    let file_name = std::ffi::CString::new(file_name)
        .map_err(|_| PromotionDecisionClientErrorV1::InvalidConfig)?;
    let descriptor = unsafe {
        libc::openat(
            parent,
            file_name.as_ptr(),
            libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(PromotionDecisionClientErrorV1::InvalidConfig);
    }
    let file = unsafe { File::from_raw_fd(descriptor) };
    let metadata = file
        .metadata()
        .map_err(|_| PromotionDecisionClientErrorV1::InvalidConfig)?;
    if metadata.uid() != expected_owner {
        return Err(PromotionDecisionClientErrorV1::InvalidConfig);
    }
    let facts = ClientConfigDescriptorFactsV1::new(
        config_kind_from_mode(metadata.mode()),
        0,
        metadata.mode() & 0o7777,
        metadata.nlink(),
    );
    validate_client_config_file_facts(facts)?;
    Ok(file)
}

#[cfg(target_os = "linux")]
fn read_bounded_client_config(file: &mut File) -> Result<Vec<u8>, PromotionDecisionClientErrorV1> {
    let mut bytes = Vec::with_capacity(MAX_PROTECTED_CLIENT_CONFIG_BYTES);
    file.take((MAX_PROTECTED_CLIENT_CONFIG_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| PromotionDecisionClientErrorV1::InvalidConfig)?;
    if bytes.len() > MAX_PROTECTED_CLIENT_CONFIG_BYTES {
        return Err(PromotionDecisionClientErrorV1::InvalidConfig);
    }
    Ok(bytes)
}

#[cfg(all(test, target_os = "linux"))]
fn relative_components(
    path: &Path,
    anchor: &Path,
) -> Result<(Vec<Vec<u8>>, Vec<u8>), PromotionDecisionClientErrorV1> {
    use std::os::unix::ffi::OsStrExt;
    let relative = path
        .strip_prefix(anchor)
        .map_err(|_| PromotionDecisionClientErrorV1::InvalidConfig)?;
    let mut components = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(value) => components.push(value.as_bytes().to_vec()),
            _ => return Err(PromotionDecisionClientErrorV1::InvalidConfig),
        }
    }
    let file_name = components
        .pop()
        .filter(|name| !name.is_empty())
        .ok_or(PromotionDecisionClientErrorV1::InvalidConfig)?;
    Ok((components, file_name))
}

#[cfg(all(test, target_os = "linux"))]
pub(crate) fn load_client_config_from_trusted_anchor_for_test(
    config_path: &Path,
    trusted_anchor: &Path,
    expected_owner: u32,
) -> Result<ProtectedPromotionDecisionClientConfigV1, PromotionDecisionClientErrorV1> {
    use std::os::unix::ffi::OsStrExt;
    let anchor_name = std::ffi::CString::new(trusted_anchor.as_os_str().as_bytes())
        .map_err(|_| PromotionDecisionClientErrorV1::InvalidConfig)?;
    let descriptor = unsafe {
        libc::open(
            anchor_name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(PromotionDecisionClientErrorV1::InvalidConfig);
    }
    let anchor = unsafe { File::from_raw_fd(descriptor) };
    let (components, file_name) = relative_components(config_path, trusted_anchor)?;
    let parent = open_validated_parent_from_anchor(&anchor, &components, expected_owner)?;
    let mut config = open_config_at(parent.as_raw_fd(), &file_name, expected_owner)?;
    parse_protected_client_config_json(&read_bounded_client_config(&mut config)?)
}

#[cfg(target_os = "linux")]
fn socket_facts_at(
    parent: RawFd,
    file_name: &[u8],
    expected_owner: u32,
    expected_group: u32,
) -> Result<SocketDescriptorFactsV1, PromotionDecisionClientErrorV1> {
    let file_name = std::ffi::CString::new(file_name)
        .map_err(|_| PromotionDecisionClientErrorV1::InvalidConfig)?;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
    if unsafe {
        libc::fstatat(
            parent,
            file_name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(PromotionDecisionClientErrorV1::InvalidConfig);
    }
    let stat = unsafe { stat.assume_init() };
    if stat.st_uid != expected_owner {
        return Err(PromotionDecisionClientErrorV1::InvalidConfig);
    }
    let kind = match stat.st_mode & libc::S_IFMT {
        libc::S_IFSOCK => SocketDescriptorKindV1::UnixSocket,
        libc::S_IFLNK => SocketDescriptorKindV1::Symlink,
        _ => SocketDescriptorKindV1::Other,
    };
    let facts = SocketDescriptorFactsV1::new(
        kind,
        0,
        stat.st_gid,
        stat.st_mode & 0o7777,
        stat.st_nlink,
        stat.st_dev,
        stat.st_ino,
    );
    validate_socket_facts(facts, expected_group)?;
    Ok(facts)
}

#[cfg(all(test, target_os = "linux"))]
pub(crate) fn validate_socket_path_from_trusted_anchor_for_test(
    socket_path: &Path,
    trusted_anchor: &Path,
    expected_owner: u32,
    expected_group: u32,
) -> Result<SocketDescriptorFactsV1, PromotionDecisionClientErrorV1> {
    use std::os::unix::ffi::OsStrExt;
    let anchor_name = std::ffi::CString::new(trusted_anchor.as_os_str().as_bytes())
        .map_err(|_| PromotionDecisionClientErrorV1::InvalidConfig)?;
    let descriptor = unsafe {
        libc::open(
            anchor_name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(PromotionDecisionClientErrorV1::InvalidConfig);
    }
    let anchor = unsafe { File::from_raw_fd(descriptor) };
    let (components, file_name) = relative_components(socket_path, trusted_anchor)?;
    let parent = open_validated_parent_from_anchor(&anchor, &components, expected_owner)?;
    socket_facts_at(
        parent.as_raw_fd(),
        &file_name,
        expected_owner,
        expected_group,
    )
}

#[cfg(target_os = "linux")]
fn open_root() -> Result<File, PromotionDecisionClientErrorV1> {
    let descriptor = unsafe {
        libc::open(
            c"/".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(PromotionDecisionClientErrorV1::InvalidConfig);
    }
    let root = unsafe { File::from_raw_fd(descriptor) };
    validate_directory_for_owner(&root, 0)?;
    Ok(root)
}

#[cfg(target_os = "linux")]
fn fixed_components(components: &[&[u8]]) -> Vec<Vec<u8>> {
    components
        .iter()
        .map(|component| component.to_vec())
        .collect()
}

#[cfg(target_os = "linux")]
fn load_default_client_config(
) -> Result<ProtectedPromotionDecisionClientConfigV1, PromotionDecisionClientErrorV1> {
    load_default_client_config_for(PROTECTED_CLIENT_CONFIG_FILE_NAME)
}

#[cfg(target_os = "linux")]
fn load_default_client_config_for(
    file_name: &[u8],
) -> Result<ProtectedPromotionDecisionClientConfigV1, PromotionDecisionClientErrorV1> {
    let root = open_root()?;
    let parent = open_validated_parent_from_anchor(
        &root,
        &fixed_components(&PROTECTED_CLIENT_CONFIG_PARENT_COMPONENTS),
        0,
    )?;
    let mut file = open_config_at(parent.as_raw_fd(), file_name, 0)?;
    parse_protected_client_config_json(&read_bounded_client_config(&mut file)?)
}

#[cfg(target_os = "linux")]
fn validate_default_socket_path_for(
    file_name: &[u8],
    expected_group: u32,
) -> Result<SocketDescriptorFactsV1, PromotionDecisionClientErrorV1> {
    let root = open_root()?;
    let parent = open_validated_parent_from_anchor(
        &root,
        &fixed_components(&AUTHORITY_SOCKET_PARENT_COMPONENTS),
        0,
    )?;
    socket_facts_at(parent.as_raw_fd(), file_name, 0, expected_group)
}

#[cfg(target_os = "linux")]
fn validate_installed_client_executable() -> Result<(), PromotionDecisionClientErrorV1> {
    let root = open_root()?;
    let parent = open_validated_parent_from_anchor(
        &root,
        &fixed_components(&INSTALLED_CLIENT_PARENT_COMPONENTS),
        0,
    )?;
    let file_name = std::ffi::CString::new(INSTALLED_CLIENT_FILE_NAME)
        .map_err(|_| PromotionDecisionClientErrorV1::InvalidConfig)?;
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            file_name.as_ptr(),
            libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(PromotionDecisionClientErrorV1::InvalidConfig);
    }
    let installed = unsafe { File::from_raw_fd(descriptor) };
    let installed_metadata = installed
        .metadata()
        .map_err(|_| PromotionDecisionClientErrorV1::InvalidConfig)?;
    validate_client_executable_facts(ClientConfigDescriptorFactsV1::new(
        config_kind_from_mode(installed_metadata.mode()),
        installed_metadata.uid(),
        installed_metadata.mode() & 0o7777,
        installed_metadata.nlink(),
    ))?;
    let process_path = std::fs::read_link("/proc/self/exe")
        .map_err(|_| PromotionDecisionClientErrorV1::InvalidConfig)?;
    if process_path != Path::new(INSTALLED_CLIENT_PATH) {
        return Err(PromotionDecisionClientErrorV1::InvalidConfig);
    }
    let process_metadata = std::fs::metadata("/proc/self/exe")
        .map_err(|_| PromotionDecisionClientErrorV1::InvalidConfig)?;
    if process_metadata.dev() != installed_metadata.dev()
        || process_metadata.ino() != installed_metadata.ino()
    {
        return Err(PromotionDecisionClientErrorV1::InvalidConfig);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn read_bounded_stdin() -> Result<Vec<u8>, PromotionDecisionClientErrorV1> {
    let mut bytes = Vec::with_capacity(4 * 1024);
    std::io::stdin()
        .take(4 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| PromotionDecisionClientErrorV1::InvalidInput)?;
    if bytes.is_empty() || bytes.len() > 4 * 1024 {
        return Err(PromotionDecisionClientErrorV1::InvalidInput);
    }
    Ok(bytes)
}

#[cfg(target_os = "linux")]
enum ProtectedAuthorityClientStatusV1 {
    Decision(PromotionDecisionClientStatusV1),
    Execution(PromotionExecutionClientStatusV1),
}

#[cfg(target_os = "linux")]
fn connect_validated_fixed_socket(
    socket_path: &Path,
    socket_file_name: &[u8],
    config: &ProtectedPromotionDecisionClientConfigV1,
) -> Result<UnixStream, PromotionDecisionClientErrorV1> {
    let before = validate_default_socket_path_for(socket_file_name, config.socket_group_gid())?;
    let stream = UnixStream::connect(socket_path)
        .map_err(|_| PromotionDecisionClientErrorV1::ConnectionRejected)?;
    if stream
        .peer_addr()
        .ok()
        .and_then(|address| address.as_pathname().map(Path::to_path_buf))
        .as_deref()
        != Some(socket_path)
    {
        return Err(PromotionDecisionClientErrorV1::ConnectionRejected);
    }
    validate_connected_listener_creator(&stream, config.listener_creator_uid())?;
    let after = validate_default_socket_path_for(socket_file_name, config.socket_group_gid())?;
    if before != after {
        return Err(PromotionDecisionClientErrorV1::ConnectionRejected);
    }
    Ok(stream)
}

#[cfg(target_os = "linux")]
fn run_linux_client() -> Result<ProtectedAuthorityClientStatusV1, PromotionDecisionClientErrorV1> {
    validate_installed_client_executable()?;
    let input = read_bounded_stdin()?;
    if let Ok(request) = parse_client_request_stdin(&input) {
        let config = load_default_client_config()?;
        let mut stream = connect_validated_fixed_socket(
            Path::new(AUTHORITY_SOCKET_PATH),
            AUTHORITY_SOCKET_FILE_NAME,
            &config,
        )?;
        return exchange_promotion_decision_with_stream(
            &mut stream,
            config.listener_creator_uid(),
            config.broker_identity_public_key(),
            &request,
        )
        .map(ProtectedAuthorityClientStatusV1::Decision);
    }
    let request = parse_promotion_execution_client_request_stdin(&input)?;
    let config = load_default_client_config_for(PROTECTED_EXECUTION_CLIENT_CONFIG_FILE_NAME)?;
    let mut stream = connect_validated_fixed_socket(
        Path::new(EXECUTION_SOCKET_PATH),
        EXECUTION_SOCKET_FILE_NAME,
        &config,
    )?;
    exchange_promotion_execution_with_stream(
        &mut stream,
        config.listener_creator_uid(),
        config.broker_identity_public_key(),
        &request,
    )
    .map(ProtectedAuthorityClientStatusV1::Execution)
}

/// Run the fixed-path, no-authority promotion-decision client.
///
/// The runner accepts no path, endpoint, broker identity, or authority
/// override. All failures are collapsed to one redacted category.
pub fn run_default_promotion_decision_client_v1() -> ExitCode {
    #[cfg(target_os = "linux")]
    {
        let status = match run_linux_client() {
            Ok(status) => status,
            Err(_) => {
                eprintln!("client_blocked");
                return ExitCode::FAILURE;
            }
        };
        let payload = match status {
            ProtectedAuthorityClientStatusV1::Decision(
                PromotionDecisionClientStatusV1::Sealed {
                    promotion_decision_event_id,
                },
            ) => format!(
                r#"{{"schema_version":2,"status":"sealed","promotion_decision_event_id":"{promotion_decision_event_id}"}}"#
            )
            .into_bytes(),
            ProtectedAuthorityClientStatusV1::Decision(
                PromotionDecisionClientStatusV1::ReconciliationRequired,
            ) => RECONCILIATION_REQUIRED_RESPONSE_JSON.to_vec(),
            ProtectedAuthorityClientStatusV1::Execution(status) => format!(
                r#"{{"schema_version":1,"status":"{}"}}"#,
                match status {
                    PromotionExecutionClientStatusV1::Rejected => "rejected",
                    PromotionExecutionClientStatusV1::Pending => "pending",
                    PromotionExecutionClientStatusV1::Completed => "completed",
                    PromotionExecutionClientStatusV1::Recorded => "recorded",
                    PromotionExecutionClientStatusV1::LeaseExpired => "lease_expired",
                    PromotionExecutionClientStatusV1::ReconciliationRequired =>
                        "reconciliation_required",
                }
            )
            .into_bytes(),
        };
        if std::io::stdout()
            .write_all(&payload)
            .and_then(|_| std::io::stdout().write_all(b"\n"))
            .is_err()
        {
            return ExitCode::FAILURE;
        }
        ExitCode::SUCCESS
    }
    #[cfg(not(target_os = "linux"))]
    {
        eprintln!("unsupported_platform");
        ExitCode::FAILURE
    }
}

#[cfg(all(test, target_os = "linux"))]
pub(crate) fn exchange_promotion_decision_with_stream_for_test(
    stream: &mut UnixStream,
    expected_listener_creator_uid: u32,
    broker_identity_public_key: &VerifyingKey,
    request: &PromotionDecisionClientRequestV1,
) -> Result<PromotionDecisionClientStatusV1, PromotionDecisionClientErrorV1> {
    exchange_promotion_decision_with_stream(
        stream,
        expected_listener_creator_uid,
        broker_identity_public_key,
        request,
    )
}

#[cfg(all(test, target_os = "linux"))]
pub(crate) fn exchange_promotion_execution_with_stream_for_test(
    stream: &mut UnixStream,
    expected_listener_creator_uid: u32,
    broker_identity_public_key: &VerifyingKey,
    request: &PromotionExecutionClientRequestV1,
) -> Result<PromotionExecutionClientStatusV1, PromotionDecisionClientErrorV1> {
    exchange_promotion_execution_with_stream(
        stream,
        expected_listener_creator_uid,
        broker_identity_public_key,
        request,
    )
}
