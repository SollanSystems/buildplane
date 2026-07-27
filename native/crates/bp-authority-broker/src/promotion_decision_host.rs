use crate::{BrokerPromotionDecisionDisposition, BrokerPromotionDecisionDisposition::*};
use thiserror::Error;

#[cfg(target_os = "linux")]
use crate::confinement::{
    BrokerAuthorityRoleV1, BrokerHostConfinementAttestationV1, BrokerHostConfinementPolicyV1,
};
#[cfg(target_os = "linux")]
use crate::host_config_loader::load_default_promotion_decision_host_config_v1;
#[cfg(target_os = "linux")]
use crate::host_config_loader::ValidatedPromotionDecisionHostStartupV1;
#[cfg(target_os = "linux")]
use crate::host_key_custody::{
    load_promotion_decision_signing_keys_v1, ProtectedPromotionDecisionSigningKeysV1,
};
#[cfg(target_os = "linux")]
use crate::host_ledger_custody::{
    load_promotion_decision_ledger_v1, ProtectedPromotionDecisionLedgerV1,
};
#[cfg(target_os = "linux")]
use crate::promotion_decision_handler::handle_authenticated_promotion_decision_request;
#[cfg(target_os = "linux")]
use crate::promotion_decision_handler::HandledPromotionDecisionV1;
use crate::promotion_decision_response::{
    sign_promotion_decision_response, PromotionDecisionResponseBindingV1,
    PromotionDecisionResponseStatusV1,
};
#[cfg(target_os = "linux")]
use crate::ProtectedPromotionDecisionAuthority;

#[cfg(target_os = "linux")]
use std::fs::File;
use std::io::Write;
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
#[cfg(target_os = "linux")]
use std::os::unix::fs::MetadataExt;
#[cfg(target_os = "linux")]
use std::os::unix::net::{UnixListener, UnixStream};
#[cfg(target_os = "linux")]
use std::path::Path;
use std::process::ExitCode;
use std::time::{Duration, Instant};

const PROMOTION_DECISION_LISTENER_FD: libc::c_int = 3;
const PROMOTION_DECISION_SOCKET_PATH: &str =
    "/run/buildplane/authority-host/promotion-decision-v1.sock";
const LISTENER_PARENT_COMPONENTS: [&[u8]; 3] = [b"run", b"buildplane", b"authority-host"];
const LISTENER_SOCKET_FILE_NAME: &[u8] = b"promotion-decision-v1.sock";
const MAX_PROMOTION_DECISION_RESPONSE_FRAME_BYTES: usize = 4 * 1024;
const PROMOTION_DECISION_RESPONSE_WRITE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
enum ProtectedPromotionDecisionHostErrorV1 {
    #[error("protected promotion-decision host startup failed")]
    StartupFailed,
    #[error("protected promotion-decision host connection failed")]
    ConnectionFailed,
    #[error("protected promotion-decision host accept failed")]
    AcceptFailed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OperationalDiagnosticV1 {
    StartupFailed,
    AcceptFailed,
    #[cfg(any(test, not(target_os = "linux")))]
    UnsupportedPlatform,
}

impl OperationalDiagnosticV1 {
    fn as_str(self) -> &'static str {
        match self {
            Self::StartupFailed => "startup_failed",
            Self::AcceptFailed => "accept_failed",
            #[cfg(any(test, not(target_os = "linux")))]
            Self::UnsupportedPlatform => "unsupported_platform",
        }
    }
}

fn operational_diagnostic_for_error(
    error: ProtectedPromotionDecisionHostErrorV1,
) -> OperationalDiagnosticV1 {
    match error {
        ProtectedPromotionDecisionHostErrorV1::AcceptFailed => {
            OperationalDiagnosticV1::AcceptFailed
        }
        ProtectedPromotionDecisionHostErrorV1::StartupFailed
        | ProtectedPromotionDecisionHostErrorV1::ConnectionFailed => {
            OperationalDiagnosticV1::StartupFailed
        }
    }
}

fn emit_operational_diagnostic(category: OperationalDiagnosticV1) {
    eprintln!("{}", category.as_str());
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ListenerPathEntryKindV1 {
    Directory,
    UnixSocket,
    Symlink,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ListenerPathFactsV1 {
    kind: ListenerPathEntryKindV1,
    uid: u32,
    gid: u32,
    mode: u32,
    link_count: u64,
}

#[cfg(target_os = "linux")]
struct ProtectedPromotionDecisionHostV1 {
    startup: ValidatedPromotionDecisionHostStartupV1,
    signing_keys: ProtectedPromotionDecisionSigningKeysV1,
    ledger: ProtectedPromotionDecisionLedgerV1,
    policy: BrokerHostConfinementPolicyV1,
    attestation: BrokerHostConfinementAttestationV1,
}

#[cfg(target_os = "linux")]
impl ProtectedPromotionDecisionHostV1 {
    fn from_validated_startup(
        startup: ValidatedPromotionDecisionHostStartupV1,
        socket_facts: ListenerPathFactsV1,
    ) -> Result<Self, ProtectedPromotionDecisionHostErrorV1> {
        let policy = BrokerHostConfinementPolicyV1::new_for_role(
            startup.config().broker_uid,
            BrokerAuthorityRoleV1::PromotionDecision,
            startup
                .config()
                .promotion_decision_client_uids
                .iter()
                .copied(),
        )
        .map_err(|_| ProtectedPromotionDecisionHostErrorV1::StartupFailed)?;
        let attestation = policy
            .attest_current_broker_process()
            .map_err(|_| ProtectedPromotionDecisionHostErrorV1::StartupFailed)?;
        validate_listener_socket_facts(socket_facts, startup.config().socket_group_gid)?;
        let signing_keys = load_promotion_decision_signing_keys_v1(&startup)
            .map_err(|_| ProtectedPromotionDecisionHostErrorV1::StartupFailed)?;
        let ledger = load_promotion_decision_ledger_v1(&startup)
            .map_err(|_| ProtectedPromotionDecisionHostErrorV1::StartupFailed)?;
        let host = Self {
            startup,
            signing_keys,
            ledger,
            policy,
            attestation,
        };
        host.authority()?;
        Ok(host)
    }

    fn authority(
        &self,
    ) -> Result<ProtectedPromotionDecisionAuthority<'_>, ProtectedPromotionDecisionHostErrorV1>
    {
        let config = self.startup.config();
        ProtectedPromotionDecisionAuthority::from_prevalidated_startup(
            config.run_id,
            self.ledger.recovery_database_path(),
            &config.replay_authorities,
            &config.kernel_signer,
            self.ledger.store(),
            &config.promotion_authority,
            self.signing_keys.operator(),
            &config.operator_signer,
            self.signing_keys.kernel(),
            &config.kernel_signer,
        )
        .map_err(|_| ProtectedPromotionDecisionHostErrorV1::StartupFailed)
    }

    fn handle_connection(
        &self,
        stream: &mut UnixStream,
    ) -> Result<(), ProtectedPromotionDecisionHostErrorV1> {
        complete_request_with_response(
            stream,
            |stream| {
                let mut authority = self.authority()?;
                handle_authenticated_promotion_decision_request(
                    &self.policy,
                    &self.attestation,
                    stream,
                    &mut authority,
                )
                .map_err(|_| ProtectedPromotionDecisionHostErrorV1::ConnectionFailed)
            },
            |stream, handled| {
                write_authenticated_promotion_decision_response(
                    &self.policy,
                    &self.attestation,
                    stream,
                    self.signing_keys.kernel(),
                    &handled,
                )
            },
        )
    }

    #[cfg(test)]
    fn validate_authority_composition_for_test(
        &self,
    ) -> Result<(), ProtectedPromotionDecisionHostErrorV1> {
        self.authority().map(|_| ())
    }
}

fn validate_listener_parent_facts(
    facts: ListenerPathFactsV1,
) -> Result<(), ProtectedPromotionDecisionHostErrorV1> {
    if facts.kind != ListenerPathEntryKindV1::Directory || facts.uid != 0 || facts.mode != 0o755 {
        return Err(ProtectedPromotionDecisionHostErrorV1::StartupFailed);
    }
    Ok(())
}

fn validate_listener_socket_facts(
    facts: ListenerPathFactsV1,
    expected_group: u32,
) -> Result<(), ProtectedPromotionDecisionHostErrorV1> {
    if facts.kind != ListenerPathEntryKindV1::UnixSocket
        || facts.uid != 0
        || facts.gid != expected_group
        || facts.mode != 0o660
        || facts.link_count != 1
    {
        return Err(ProtectedPromotionDecisionHostErrorV1::StartupFailed);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn validate_listener_path_from_anchor(
    anchor_descriptor: RawFd,
    parent_components: &[&[u8]],
    socket_file_name: &[u8],
    expected_owner: u32,
    expected_group: u32,
) -> Result<ListenerPathFactsV1, ProtectedPromotionDecisionHostErrorV1> {
    let mut current_directory: Option<File> = None;
    let mut parent_descriptor = anchor_descriptor;
    for component in parent_components {
        let opened = open_listener_parent_at(parent_descriptor, component)?;
        let metadata = opened
            .metadata()
            .map_err(|_| ProtectedPromotionDecisionHostErrorV1::StartupFailed)?;
        let parent_facts = listener_path_facts_from_metadata(&metadata);
        if parent_facts.uid != expected_owner {
            return Err(ProtectedPromotionDecisionHostErrorV1::StartupFailed);
        }
        validate_listener_parent_facts(ListenerPathFactsV1 {
            uid: 0,
            ..parent_facts
        })?;
        parent_descriptor = opened.as_raw_fd();
        current_directory = Some(opened);
    }
    let final_parent = current_directory
        .as_ref()
        .ok_or(ProtectedPromotionDecisionHostErrorV1::StartupFailed)?;
    let socket_facts = listener_path_facts_at(final_parent.as_raw_fd(), socket_file_name)?;
    if expected_owner == 0 {
        validate_listener_socket_facts(socket_facts, expected_group)?;
    } else {
        let test_owned_facts = ListenerPathFactsV1 {
            uid: 0,
            ..socket_facts
        };
        if socket_facts.uid != expected_owner {
            return Err(ProtectedPromotionDecisionHostErrorV1::StartupFailed);
        }
        validate_listener_socket_facts(test_owned_facts, expected_group)?;
    }
    Ok(socket_facts)
}

#[cfg(target_os = "linux")]
fn open_listener_parent_at(
    parent_descriptor: RawFd,
    component: &[u8],
) -> Result<File, ProtectedPromotionDecisionHostErrorV1> {
    let component = std::ffi::CString::new(component)
        .map_err(|_| ProtectedPromotionDecisionHostErrorV1::StartupFailed)?;
    let descriptor = unsafe {
        libc::openat(
            parent_descriptor,
            component.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(ProtectedPromotionDecisionHostErrorV1::StartupFailed);
    }
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

#[cfg(target_os = "linux")]
fn listener_path_facts_from_metadata(metadata: &std::fs::Metadata) -> ListenerPathFactsV1 {
    ListenerPathFactsV1 {
        kind: listener_path_kind(metadata.mode()),
        uid: metadata.uid(),
        gid: metadata.gid(),
        mode: metadata.mode() & 0o7777,
        link_count: metadata.nlink(),
    }
}

#[cfg(target_os = "linux")]
fn listener_path_facts_at(
    parent_descriptor: RawFd,
    file_name: &[u8],
) -> Result<ListenerPathFactsV1, ProtectedPromotionDecisionHostErrorV1> {
    let file_name = std::ffi::CString::new(file_name)
        .map_err(|_| ProtectedPromotionDecisionHostErrorV1::StartupFailed)?;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
    if unsafe {
        libc::fstatat(
            parent_descriptor,
            file_name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(ProtectedPromotionDecisionHostErrorV1::StartupFailed);
    }
    let stat = unsafe { stat.assume_init() };
    Ok(ListenerPathFactsV1 {
        kind: listener_path_kind(stat.st_mode),
        uid: stat.st_uid,
        gid: stat.st_gid,
        mode: stat.st_mode & 0o7777,
        link_count: stat.st_nlink,
    })
}

#[cfg(target_os = "linux")]
fn listener_path_kind(mode: libc::mode_t) -> ListenerPathEntryKindV1 {
    match mode & libc::S_IFMT {
        libc::S_IFDIR => ListenerPathEntryKindV1::Directory,
        libc::S_IFSOCK => ListenerPathEntryKindV1::UnixSocket,
        libc::S_IFLNK => ListenerPathEntryKindV1::Symlink,
        _ => ListenerPathEntryKindV1::Other,
    }
}

#[cfg(all(test, target_os = "linux"))]
fn validate_listener_path_from_anchor_for_test(
    anchor_descriptor: RawFd,
    parent_components: &[&[u8]],
    socket_file_name: &[u8],
    expected_owner: u32,
    expected_group: u32,
) -> Result<ListenerPathFactsV1, ProtectedPromotionDecisionHostErrorV1> {
    validate_listener_path_from_anchor(
        anchor_descriptor,
        parent_components,
        socket_file_name,
        expected_owner,
        expected_group,
    )
}

#[cfg(target_os = "linux")]
fn validate_default_listener_path(
    expected_group: u32,
) -> Result<ListenerPathFactsV1, ProtectedPromotionDecisionHostErrorV1> {
    let root_descriptor = unsafe {
        libc::open(
            c"/".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if root_descriptor < 0 {
        return Err(ProtectedPromotionDecisionHostErrorV1::StartupFailed);
    }
    let root = unsafe { File::from_raw_fd(root_descriptor) };
    validate_listener_path_from_anchor(
        root.as_raw_fd(),
        &LISTENER_PARENT_COMPONENTS,
        LISTENER_SOCKET_FILE_NAME,
        0,
        expected_group,
    )
}

#[cfg(target_os = "linux")]
fn duplicate_and_validate_owned_preopened_listener(
    listener_fd: OwnedFd,
    expected_path: &Path,
) -> Result<UnixListener, ProtectedPromotionDecisionHostErrorV1> {
    let duplicated_fd = unsafe { libc::fcntl(listener_fd.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 4) };
    if duplicated_fd < 0 {
        return Err(ProtectedPromotionDecisionHostErrorV1::StartupFailed);
    }
    let listener = unsafe { UnixListener::from_raw_fd(duplicated_fd) };

    let mut stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
    if unsafe { libc::fstat(listener.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
        return Err(ProtectedPromotionDecisionHostErrorV1::StartupFailed);
    }
    let stat = unsafe { stat.assume_init() };
    if stat.st_mode & libc::S_IFMT != libc::S_IFSOCK
        || socket_option(listener.as_raw_fd(), libc::SO_DOMAIN)? != libc::AF_UNIX
        || socket_option(listener.as_raw_fd(), libc::SO_TYPE)? != libc::SOCK_STREAM
        || socket_option(listener.as_raw_fd(), libc::SO_ACCEPTCONN)? != 1
    {
        return Err(ProtectedPromotionDecisionHostErrorV1::StartupFailed);
    }
    if listener
        .local_addr()
        .ok()
        .and_then(|address| address.as_pathname().map(Path::to_path_buf))
        .as_deref()
        != Some(expected_path)
    {
        return Err(ProtectedPromotionDecisionHostErrorV1::StartupFailed);
    }
    Ok(listener)
}

#[cfg(target_os = "linux")]
fn claim_and_validate_preopened_listener(
    listener_fd: RawFd,
    expected_path: &Path,
) -> Result<UnixListener, ProtectedPromotionDecisionHostErrorV1> {
    let descriptor_flags = unsafe { libc::fcntl(listener_fd, libc::F_GETFD) };
    if descriptor_flags < 0
        || unsafe {
            libc::fcntl(
                listener_fd,
                libc::F_SETFD,
                descriptor_flags | libc::FD_CLOEXEC,
            )
        } != 0
    {
        return Err(ProtectedPromotionDecisionHostErrorV1::StartupFailed);
    }
    let listener_fd = unsafe { OwnedFd::from_raw_fd(listener_fd) };
    duplicate_and_validate_owned_preopened_listener(listener_fd, expected_path)
}

#[cfg(target_os = "linux")]
fn validate_listener_then_load_startup<T, F>(
    listener_fd: RawFd,
    expected_path: &Path,
    load_startup: F,
) -> Result<(UnixListener, T), ProtectedPromotionDecisionHostErrorV1>
where
    F: FnOnce() -> Result<T, ProtectedPromotionDecisionHostErrorV1>,
{
    let listener = claim_and_validate_preopened_listener(listener_fd, expected_path)?;
    let startup = load_startup()?;
    Ok((listener, startup))
}

#[cfg(all(test, target_os = "linux"))]
fn validate_listener_then_load_startup_for_test<T, F>(
    listener_fd: RawFd,
    expected_path: &Path,
    load_startup: F,
) -> Result<(UnixListener, T), ProtectedPromotionDecisionHostErrorV1>
where
    F: FnOnce() -> Result<T, ProtectedPromotionDecisionHostErrorV1>,
{
    validate_listener_then_load_startup(listener_fd, expected_path, load_startup)
}

#[cfg(target_os = "linux")]
fn socket_option(
    descriptor: RawFd,
    option: libc::c_int,
) -> Result<libc::c_int, ProtectedPromotionDecisionHostErrorV1> {
    let mut value = 0;
    let mut length = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            descriptor,
            libc::SOL_SOCKET,
            option,
            std::ptr::addr_of_mut!(value).cast(),
            std::ptr::addr_of_mut!(length),
        )
    };
    if result != 0 || length as usize != std::mem::size_of::<libc::c_int>() {
        return Err(ProtectedPromotionDecisionHostErrorV1::StartupFailed);
    }
    Ok(value)
}

#[cfg(all(test, target_os = "linux"))]
fn duplicate_and_validate_preopened_listener_for_test(
    listener_fd: RawFd,
    expected_path: &Path,
) -> Result<UnixListener, ProtectedPromotionDecisionHostErrorV1> {
    let owned_duplicate = unsafe { libc::fcntl(listener_fd, libc::F_DUPFD_CLOEXEC, 4) };
    if owned_duplicate < 0 {
        return Err(ProtectedPromotionDecisionHostErrorV1::StartupFailed);
    }
    duplicate_and_validate_owned_preopened_listener(
        unsafe { OwnedFd::from_raw_fd(owned_duplicate) },
        expected_path,
    )
}

#[cfg(all(test, target_os = "linux"))]
fn duplicate_and_validate_owned_preopened_listener_for_test(
    listener_fd: OwnedFd,
    expected_path: &Path,
) -> Result<UnixListener, ProtectedPromotionDecisionHostErrorV1> {
    duplicate_and_validate_owned_preopened_listener(listener_fd, expected_path)
}

fn encode_promotion_decision_response_frame(
    broker_identity_signing_key: &ed25519_dalek::SigningKey,
    binding: PromotionDecisionResponseBindingV1<'_>,
    disposition: BrokerPromotionDecisionDisposition,
) -> Result<Vec<u8>, ProtectedPromotionDecisionHostErrorV1> {
    let status = match disposition {
        Sealed { .. } => PromotionDecisionResponseStatusV1::Sealed,
        ReconciliationRequired => PromotionDecisionResponseStatusV1::ReconciliationRequired,
    };
    let promotion_decision_event_id = match disposition {
        Sealed {
            promotion_decision_event_id,
        } => Some(promotion_decision_event_id.to_string()),
        ReconciliationRequired => None,
    };
    // The kernel key is reused only through this domain-separated, closed
    // response constructor. There is no generic or caller-supplied signing
    // surface at the host boundary.
    let payload = sign_promotion_decision_response(
        broker_identity_signing_key,
        binding,
        status,
        promotion_decision_event_id.as_deref(),
    )
    .map_err(|_| ProtectedPromotionDecisionHostErrorV1::ConnectionFailed)?;
    let mut frame = u32::try_from(payload.len())
        .map_err(|_| ProtectedPromotionDecisionHostErrorV1::ConnectionFailed)?
        .to_be_bytes()
        .to_vec();
    frame.extend_from_slice(&payload);
    Ok(frame)
}

fn write_response_frame_with_deadline<W, F>(
    writer: &mut W,
    frame: &[u8],
    timeout: Duration,
    mut before_write: F,
) -> Result<(), ProtectedPromotionDecisionHostErrorV1>
where
    W: Write,
    F: FnMut(&mut W, Instant) -> Result<(), ProtectedPromotionDecisionHostErrorV1>,
{
    if frame.is_empty() || frame.len() > MAX_PROMOTION_DECISION_RESPONSE_FRAME_BYTES {
        return Err(ProtectedPromotionDecisionHostErrorV1::ConnectionFailed);
    }
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or(ProtectedPromotionDecisionHostErrorV1::ConnectionFailed)?;
    let mut written = 0;
    while written < frame.len() {
        if Instant::now() >= deadline {
            return Err(ProtectedPromotionDecisionHostErrorV1::ConnectionFailed);
        }
        before_write(writer, deadline)?;
        if Instant::now() >= deadline {
            return Err(ProtectedPromotionDecisionHostErrorV1::ConnectionFailed);
        }
        let bytes_written = writer
            .write(&frame[written..])
            .map_err(|_| ProtectedPromotionDecisionHostErrorV1::ConnectionFailed)?;
        if bytes_written == 0 {
            return Err(ProtectedPromotionDecisionHostErrorV1::ConnectionFailed);
        }
        written += bytes_written;
        if Instant::now() >= deadline {
            return Err(ProtectedPromotionDecisionHostErrorV1::ConnectionFailed);
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn write_authenticated_promotion_decision_response(
    policy: &BrokerHostConfinementPolicyV1,
    attestation: &BrokerHostConfinementAttestationV1,
    stream: &mut UnixStream,
    broker_identity_signing_key: &ed25519_dalek::SigningKey,
    handled: &HandledPromotionDecisionV1,
) -> Result<(), ProtectedPromotionDecisionHostErrorV1> {
    let binding = PromotionDecisionResponseBindingV1::new(
        &handled.request_id,
        &handled.promotion_approval_request_event_id,
        &handled.decision,
    )
    .map_err(|_| ProtectedPromotionDecisionHostErrorV1::ConnectionFailed)?;
    let frame = encode_promotion_decision_response_frame(
        broker_identity_signing_key,
        binding,
        handled.disposition,
    )?;
    write_response_frame_with_deadline(
        stream,
        &frame,
        PROMOTION_DECISION_RESPONSE_WRITE_TIMEOUT,
        |stream, deadline| {
            policy
                .verify_linux_connected_worker_for_role(
                    BrokerAuthorityRoleV1::PromotionDecision,
                    attestation,
                    stream,
                )
                .map_err(|_| ProtectedPromotionDecisionHostErrorV1::ConnectionFailed)?;
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .filter(|remaining| !remaining.is_zero())
                .ok_or(ProtectedPromotionDecisionHostErrorV1::ConnectionFailed)?;
            stream
                .set_write_timeout(Some(remaining))
                .map_err(|_| ProtectedPromotionDecisionHostErrorV1::ConnectionFailed)
        },
    )
}

fn complete_request_with_response<S, H, R, T>(
    subject: &mut S,
    handle_request: H,
    write_response: R,
) -> Result<(), ProtectedPromotionDecisionHostErrorV1>
where
    H: FnOnce(&mut S) -> Result<T, ProtectedPromotionDecisionHostErrorV1>,
    R: FnOnce(&mut S, T) -> Result<(), ProtectedPromotionDecisionHostErrorV1>,
{
    let disposition = handle_request(subject)?;
    write_response(subject, disposition)
}

#[cfg(test)]
fn complete_request_with_response_for_test<S, H, R, T>(
    subject: &mut S,
    handle_request: H,
    write_response: R,
) -> Result<(), ProtectedPromotionDecisionHostErrorV1>
where
    H: FnOnce(&mut S) -> Result<T, ProtectedPromotionDecisionHostErrorV1>,
    R: FnOnce(&mut S, T) -> Result<(), ProtectedPromotionDecisionHostErrorV1>,
{
    complete_request_with_response(subject, handle_request, write_response)
}

#[cfg(target_os = "linux")]
fn serve_sequential_connections<F>(
    listener: &UnixListener,
    mut handle_connection: F,
) -> Result<(), ProtectedPromotionDecisionHostErrorV1>
where
    F: FnMut(&mut UnixStream) -> Result<(), ProtectedPromotionDecisionHostErrorV1>,
{
    loop {
        let (mut stream, _) = listener
            .accept()
            .map_err(|_| ProtectedPromotionDecisionHostErrorV1::AcceptFailed)?;
        match handle_connection(&mut stream) {
            Ok(()) | Err(ProtectedPromotionDecisionHostErrorV1::ConnectionFailed) => {}
            Err(error) => return Err(error),
        }
    }
}

/// Activate the sole production promotion-decision authority endpoint.
///
/// Deployment inputs are compiled into this crate or loaded from the one
/// protected default config. The runner accepts no paths, descriptors,
/// identities, authority material, or environment overrides and never exposes
/// its private startup or connection errors.
pub fn run_default_promotion_decision_host_v1() -> ExitCode {
    #[cfg(target_os = "linux")]
    {
        return match run_default_promotion_decision_host_linux_v1() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                emit_operational_diagnostic(operational_diagnostic_for_error(error));
                ExitCode::FAILURE
            }
        };
    }

    #[cfg(not(target_os = "linux"))]
    {
        emit_operational_diagnostic(OperationalDiagnosticV1::UnsupportedPlatform);
        ExitCode::FAILURE
    }
}

#[cfg(target_os = "linux")]
fn run_default_promotion_decision_host_linux_v1(
) -> Result<(), ProtectedPromotionDecisionHostErrorV1> {
    let (listener, startup) = validate_listener_then_load_startup(
        PROMOTION_DECISION_LISTENER_FD,
        Path::new(PROMOTION_DECISION_SOCKET_PATH),
        || {
            load_default_promotion_decision_host_config_v1()
                .map_err(|_| ProtectedPromotionDecisionHostErrorV1::StartupFailed)
        },
    )?;
    let socket_facts = validate_default_listener_path(startup.config().socket_group_gid)?;
    let host = ProtectedPromotionDecisionHostV1::from_validated_startup(startup, socket_facts)?;
    serve_sequential_connections(&listener, |stream| host.handle_connection(stream))
}

#[cfg(all(test, target_os = "linux"))]
fn serve_sequential_connections_for_test<F>(
    listener: &UnixListener,
    handle_connection: F,
) -> Result<(), ProtectedPromotionDecisionHostErrorV1>
where
    F: FnMut(&mut UnixStream) -> Result<(), ProtectedPromotionDecisionHostErrorV1>,
{
    serve_sequential_connections(listener, handle_connection)
}

#[cfg(test)]
fn write_response_frame_with_deadline_for_test<W, F>(
    writer: &mut W,
    frame: &[u8],
    timeout: Duration,
    before_write: F,
) -> Result<(), ProtectedPromotionDecisionHostErrorV1>
where
    W: Write,
    F: FnMut(&mut W, Instant) -> Result<(), ProtectedPromotionDecisionHostErrorV1>,
{
    write_response_frame_with_deadline(writer, frame, timeout, before_write)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_response_signing_key() -> ed25519_dalek::SigningKey {
        ed25519_dalek::SigningKey::from_bytes(&[94; 32])
    }

    fn test_response_binding() -> PromotionDecisionResponseBindingV1<'static> {
        PromotionDecisionResponseBindingV1::new(
            "018f2e40-0000-7000-8000-000000000111",
            "123e4567-e89b-12d3-a456-426614174001",
            "promote",
        )
        .unwrap()
    }

    fn test_response_frame(disposition: BrokerPromotionDecisionDisposition) -> Vec<u8> {
        encode_promotion_decision_response_frame(
            &test_response_signing_key(),
            test_response_binding(),
            disposition,
        )
        .unwrap()
    }

    fn test_handled_decision() -> HandledPromotionDecisionV1 {
        HandledPromotionDecisionV1 {
            disposition: test_sealed_disposition(),
            request_id: "018f2e40-0000-7000-8000-000000000111".to_string(),
            promotion_approval_request_event_id: "123e4567-e89b-12d3-a456-426614174001".to_string(),
            decision: "promote".to_string(),
        }
    }

    fn test_sealed_disposition() -> BrokerPromotionDecisionDisposition {
        BrokerPromotionDecisionDisposition::Sealed {
            promotion_decision_event_id: bp_ledger::EventId::from_uuid(
                uuid::Uuid::parse_str("123e4567-e89b-12d3-a456-426614174003").unwrap(),
            ),
        }
    }

    #[test]
    fn response_frames_are_bounded_closed_canonical_and_broker_signed() {
        use crate::promotion_decision_response::{
            verify_promotion_decision_response_for_test, PromotionDecisionResponseStatusV1,
        };
        use ed25519_dalek::SigningKey;

        let signing_key = SigningKey::from_bytes(&[94; 32]);
        let binding = test_response_binding();
        let frame = encode_promotion_decision_response_frame(
            &signing_key,
            binding,
            test_sealed_disposition(),
        )
        .unwrap();
        let payload_length = u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize;
        assert_eq!(payload_length, frame.len() - 4);
        assert!(frame.len() <= MAX_PROMOTION_DECISION_RESPONSE_FRAME_BYTES);
        assert_eq!(
            verify_promotion_decision_response_for_test(
                &frame[4..],
                &signing_key.verifying_key(),
                binding,
            )
            .unwrap(),
            (
                PromotionDecisionResponseStatusV1::Sealed,
                Some("123e4567-e89b-12d3-a456-426614174003".to_string())
            )
        );
    }

    #[test]
    fn listener_path_metadata_requires_root_owned_exact_modes_and_configured_group() {
        let parent = ListenerPathFactsV1 {
            kind: ListenerPathEntryKindV1::Directory,
            uid: 0,
            gid: 0,
            mode: 0o755,
            link_count: 2,
        };
        assert!(validate_listener_parent_facts(parent).is_ok());
        for unsafe_parent in [
            ListenerPathFactsV1 {
                kind: ListenerPathEntryKindV1::Symlink,
                ..parent
            },
            ListenerPathFactsV1 {
                kind: ListenerPathEntryKindV1::Other,
                ..parent
            },
            ListenerPathFactsV1 { uid: 1, ..parent },
            ListenerPathFactsV1 {
                mode: 0o750,
                ..parent
            },
            ListenerPathFactsV1 {
                mode: 0o775,
                ..parent
            },
        ] {
            assert!(validate_listener_parent_facts(unsafe_parent).is_err());
        }

        let socket = ListenerPathFactsV1 {
            kind: ListenerPathEntryKindV1::UnixSocket,
            uid: 0,
            gid: 4_200,
            mode: 0o660,
            link_count: 1,
        };
        assert!(validate_listener_socket_facts(socket, 4_200).is_ok());
        for unsafe_socket in [
            ListenerPathFactsV1 {
                kind: ListenerPathEntryKindV1::Symlink,
                ..socket
            },
            ListenerPathFactsV1 {
                kind: ListenerPathEntryKindV1::Other,
                ..socket
            },
            ListenerPathFactsV1 { uid: 1, ..socket },
            ListenerPathFactsV1 {
                gid: 4_201,
                ..socket
            },
            ListenerPathFactsV1 {
                mode: 0o600,
                ..socket
            },
            ListenerPathFactsV1 {
                mode: 0o666,
                ..socket
            },
            ListenerPathFactsV1 {
                link_count: 2,
                ..socket
            },
        ] {
            assert!(validate_listener_socket_facts(unsafe_socket, 4_200).is_err());
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn preopened_listener_validation_accepts_kernel_bound_path_without_inode_equivalence() {
        use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
        use std::os::unix::fs::MetadataExt;
        use std::os::unix::net::{UnixListener, UnixStream};

        let anchor = tempfile::tempdir().expect("temporary socket directory");
        let socket_path = anchor.path().join("promotion-decision.sock");
        let original = UnixListener::bind(&socket_path).expect("bind a real Unix listener");

        let mut fd_stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
        let rc = unsafe { libc::fstat(original.as_raw_fd(), fd_stat.as_mut_ptr()) };
        assert_eq!(rc, 0);
        let fd_stat = unsafe { fd_stat.assume_init() };
        let path_metadata =
            std::fs::symlink_metadata(&socket_path).expect("bound socket path metadata");
        assert_ne!(
            (fd_stat.st_dev as u64, fd_stat.st_ino as u64),
            (path_metadata.dev(), path_metadata.ino()),
            "Linux AF_UNIX listener and pathname identities are intentionally distinct"
        );

        let owned_input_raw =
            unsafe { libc::fcntl(original.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 4) };
        assert!(owned_input_raw >= 0);
        let owned_input = unsafe { OwnedFd::from_raw_fd(owned_input_raw) };
        let validated =
            duplicate_and_validate_owned_preopened_listener_for_test(owned_input, &socket_path)
                .expect("valid listening stream with exact kernel pathname");
        assert_eq!(
            unsafe { libc::fcntl(owned_input_raw, libc::F_GETFD) },
            -1,
            "successful validation must consume and close the inherited listener descriptor"
        );
        assert_eq!(
            validated
                .local_addr()
                .expect("validated local address")
                .as_pathname(),
            Some(socket_path.as_path())
        );
        let descriptor_flags = unsafe { libc::fcntl(validated.as_raw_fd(), libc::F_GETFD) };
        assert_ne!(descriptor_flags, -1);
        assert_ne!(descriptor_flags & libc::FD_CLOEXEC, 0);

        let _client = UnixStream::connect(&socket_path).expect("connect to validated listener");
        validated
            .accept()
            .expect("returned listener remains functional after consuming the inherited fd");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn preopened_listener_validation_rejects_missing_wrong_path_and_non_stream_descriptors() {
        use std::os::fd::AsRawFd;
        use std::os::unix::net::{UnixDatagram, UnixListener};

        let anchor = tempfile::tempdir().expect("temporary socket directory");
        let datagram_path = anchor.path().join("datagram.sock");
        let datagram = UnixDatagram::bind(&datagram_path).expect("bind Unix datagram");
        assert!(
            duplicate_and_validate_preopened_listener_for_test(
                datagram.as_raw_fd(),
                &datagram_path
            )
            .is_err(),
            "a pathname-bound datagram must not masquerade as a stream listener"
        );

        let stream_path = anchor.path().join("stream.sock");
        let listener = UnixListener::bind(&stream_path).expect("bind Unix stream listener");
        assert!(
            duplicate_and_validate_preopened_listener_for_test(
                listener.as_raw_fd(),
                &anchor.path().join("substituted.sock")
            )
            .is_err(),
            "kernel-reported pathname must equal the expected pathname exactly"
        );
        assert!(
            duplicate_and_validate_preopened_listener_for_test(-1, &stream_path).is_err(),
            "a missing inherited descriptor must fail closed"
        );
    }

    #[test]
    fn deployment_listener_contract_is_fixed_at_compile_time() {
        assert_eq!(
            PROMOTION_DECISION_LISTENER_FD, 3,
            "socket activation must pass exactly descriptor 3"
        );
        assert_eq!(
            PROMOTION_DECISION_SOCKET_PATH,
            "/run/buildplane/authority-host/promotion-decision-v1.sock"
        );
        assert_eq!(
            LISTENER_PARENT_COMPONENTS,
            [b"run".as_slice(), b"buildplane", b"authority-host"]
        );
        assert_eq!(LISTENER_SOCKET_FILE_NAME, b"promotion-decision-v1.sock");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn descriptor_walk_accepts_exact_socket_metadata_and_rejects_symlinked_parent() {
        use std::fs;
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::{symlink, PermissionsExt};
        use std::os::unix::net::UnixListener;

        let anchor = tempfile::tempdir().expect("temporary descriptor anchor");
        let run = anchor.path().join("run");
        let buildplane = run.join("buildplane");
        let host = buildplane.join("authority-host");
        fs::create_dir(&run).expect("create run");
        fs::create_dir(&buildplane).expect("create buildplane");
        fs::create_dir(&host).expect("create authority host");
        for directory in [&run, &buildplane, &host] {
            fs::set_permissions(directory, fs::Permissions::from_mode(0o755))
                .expect("set exact parent mode");
        }
        let socket_path = host.join("promotion-decision-v1.sock");
        let _listener = UnixListener::bind(&socket_path).expect("bind test socket");
        fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o660))
            .expect("set exact socket mode");
        let anchor_descriptor = std::fs::File::open(anchor.path()).expect("open anchor descriptor");
        let owner = unsafe { libc::geteuid() };
        let group = unsafe { libc::getegid() };

        validate_listener_path_from_anchor_for_test(
            anchor_descriptor.as_raw_fd(),
            &LISTENER_PARENT_COMPONENTS,
            LISTENER_SOCKET_FILE_NAME,
            owner,
            group,
        )
        .expect("descriptor walk accepts exact real metadata");

        let real_buildplane = run.join("buildplane-real");
        fs::rename(&buildplane, &real_buildplane).expect("move real parent");
        symlink(&real_buildplane, &buildplane).expect("substitute symlinked parent");
        assert!(
            validate_listener_path_from_anchor_for_test(
                anchor_descriptor.as_raw_fd(),
                &LISTENER_PARENT_COMPONENTS,
                LISTENER_SOCKET_FILE_NAME,
                owner,
                group,
            )
            .is_err(),
            "openat no-follow traversal must reject a symlinked parent"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn invalid_listener_descriptor_fails_before_startup_loader_runs() {
        use std::cell::Cell;
        use std::path::Path;

        let startup_loader_called = Cell::new(false);
        let result = validate_listener_then_load_startup_for_test(
            -1,
            Path::new(PROMOTION_DECISION_SOCKET_PATH),
            || {
                startup_loader_called.set(true);
                Ok(())
            },
        );

        assert!(result.is_err());
        assert!(
            !startup_loader_called.get(),
            "invalid or missing FD 3 must fail before config, key, or ledger loading"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn host_composition_owns_validated_startup_keys_ledger_and_role_attestation() {
        use crate::host_config::parse_promotion_decision_host_config;
        use crate::host_config_loader::validate_promotion_decision_host_startup_from_trusted_anchor_for_test;
        use bp_ledger::storage::sqlite::SqliteStore;
        use ed25519_dalek::SigningKey;
        use serde_json::json;
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let anchor = tempfile::tempdir().expect("temporary protected host anchor");
        fs::set_permissions(anchor.path(), fs::Permissions::from_mode(0o700))
            .expect("private trusted anchor");
        let authority_root = anchor.path().join("authority");
        fs::create_dir(&authority_root).expect("create authority root");
        fs::set_permissions(&authority_root, fs::Permissions::from_mode(0o700))
            .expect("private authority root");

        let create_private_directory = |path: &Path| {
            fs::create_dir(path).expect("create private directory");
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))
                .expect("set private directory mode");
        };
        let keys = authority_root.join("keys");
        create_private_directory(&keys);
        let kernel_directory = keys.join("kernel");
        create_private_directory(&kernel_directory);
        let operator_directory = keys.join("operator");
        create_private_directory(&operator_directory);
        let operator_primary_directory = operator_directory.join("primary");
        create_private_directory(&operator_primary_directory);
        let kernel_seed = [1_u8; 32];
        let operator_seed = [2_u8; 32];
        let kernel_key_path = kernel_directory.join("kernel-main.ed25519");
        let operator_key_path = operator_primary_directory.join("operator-main.ed25519");
        fs::write(&kernel_key_path, kernel_seed).expect("write kernel key");
        fs::write(&operator_key_path, operator_seed).expect("write operator key");
        fs::set_permissions(&kernel_key_path, fs::Permissions::from_mode(0o600))
            .expect("protect kernel key");
        fs::set_permissions(&operator_key_path, fs::Permissions::from_mode(0o600))
            .expect("protect operator key");

        let ledger_directory = authority_root.join("ledger");
        create_private_directory(&ledger_directory);
        let database_path = ledger_directory.join("events.db");
        drop(SqliteStore::open(&database_path).expect("create real Buildplane ledger"));
        fs::set_permissions(&database_path, fs::Permissions::from_mode(0o600))
            .expect("protect ledger");

        let owner = unsafe { libc::geteuid() };
        let group = unsafe { libc::getegid() };
        let client_uid = if owner == 1 { 2 } else { 1 };
        let signer = |actor_id: &str, key_id: &str, seed: [u8; 32]| {
            let key = SigningKey::from_bytes(&seed);
            json!({
                "actor_id": actor_id,
                "key_id": key_id,
                "public_key": key.verifying_key().to_bytes().to_vec(),
            })
        };
        let config = json!({
            "schema_version": 1,
            "run_id": "018f2e40-0000-7000-8000-000000000001",
            "broker_uid": owner,
            "promotion_decision_client_uids": [client_uid],
            "socket_group_gid": group,
            "authority_root": authority_root.to_string_lossy(),
            "authority_realm_digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "kernel": signer("kernel", "kernel-main", kernel_seed),
            "operator": signer("operator:primary", "operator-main", operator_seed),
            "reviewers": [signer("reviewer", "reviewer-main", [3; 32])],
        });
        let config =
            parse_promotion_decision_host_config(&config.to_string()).expect("valid host config");
        let startup = validate_promotion_decision_host_startup_from_trusted_anchor_for_test(
            config,
            anchor.path(),
            owner,
        )
        .expect("validated startup/root descriptor");
        let socket_facts = ListenerPathFactsV1 {
            kind: ListenerPathEntryKindV1::UnixSocket,
            uid: 0,
            gid: group,
            mode: 0o660,
            link_count: 1,
        };

        let host = ProtectedPromotionDecisionHostV1::from_validated_startup(startup, socket_facts)
            .expect("compose protected promotion-decision host");
        host.validate_authority_composition_for_test()
            .expect("host fields reconstruct exactly one startup-bound authority");

        let (mut broker_stream, _same_uid_client) =
            UnixStream::pair().expect("connected same-UID client");
        assert_eq!(
            host.handle_connection(&mut broker_stream),
            Err(ProtectedPromotionDecisionHostErrorV1::ConnectionFailed),
            "the composed host must enforce its role-bound peer policy before request reads"
        );
    }

    #[test]
    fn response_writer_rechecks_gate_before_every_partial_write_and_obeys_bound() {
        use std::io::{self, Write};
        use std::time::Duration;

        #[derive(Default)]
        struct PartialWriter {
            bytes: Vec<u8>,
            writes: usize,
        }

        impl Write for PartialWriter {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.writes += 1;
                let accepted = bytes.len().min(3);
                self.bytes.extend_from_slice(&bytes[..accepted]);
                Ok(accepted)
            }

            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let frame = test_response_frame(test_sealed_disposition());
        let mut writer = PartialWriter::default();
        let mut gate_calls = 0;
        write_response_frame_with_deadline_for_test(
            &mut writer,
            &frame,
            Duration::from_secs(1),
            |_, _| {
                gate_calls += 1;
                Ok(())
            },
        )
        .expect("bounded response is fully written");

        assert_eq!(writer.bytes, frame);
        assert_eq!(gate_calls, writer.writes);
        assert!(gate_calls > 1, "test must exercise partial writes");
        assert!(frame.len() <= MAX_PROMOTION_DECISION_RESPONSE_FRAME_BYTES);
    }

    #[test]
    fn response_writer_rejects_completion_after_its_absolute_deadline() {
        use std::io::{self, Write};
        use std::time::Duration;

        struct SlowWriter;
        impl Write for SlowWriter {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                std::thread::sleep(Duration::from_millis(20));
                Ok(bytes.len())
            }

            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let frame = test_response_frame(test_sealed_disposition());
        assert_eq!(
            write_response_frame_with_deadline_for_test(
                &mut SlowWriter,
                &frame,
                Duration::from_millis(5),
                |_, _| Ok(()),
            ),
            Err(ProtectedPromotionDecisionHostErrorV1::ConnectionFailed)
        );

        #[derive(Default)]
        struct CountingWriter {
            writes: usize,
        }
        impl Write for CountingWriter {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.writes += 1;
                Ok(bytes.len())
            }

            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let mut writer = CountingWriter::default();
        assert_eq!(
            write_response_frame_with_deadline_for_test(
                &mut writer,
                &frame,
                Duration::from_millis(5),
                |_, _| {
                    std::thread::sleep(Duration::from_millis(20));
                    Ok(())
                },
            ),
            Err(ProtectedPromotionDecisionHostErrorV1::ConnectionFailed)
        );
        assert_eq!(
            writer.writes, 0,
            "a peer check that consumes the absolute deadline must not enter write"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn authenticated_response_writer_rejects_same_uid_before_any_response_byte() {
        use std::io::Read;
        use std::os::unix::net::UnixStream;
        use std::time::Duration;

        let broker_uid = unsafe { libc::geteuid() };
        let configured_client_uid = if broker_uid == 1 { 2 } else { 1 };
        let policy = BrokerHostConfinementPolicyV1::new_for_role(
            broker_uid,
            BrokerAuthorityRoleV1::PromotionDecision,
            [configured_client_uid],
        )
        .expect("distinct promotion-decision client policy");
        let attestation = policy
            .attest_current_broker_process()
            .expect("current process attestation");
        let (mut broker_stream, mut same_uid_client) =
            UnixStream::pair().expect("connected Unix stream");
        let signing_key = test_response_signing_key();
        let handled = test_handled_decision();

        assert!(
            write_authenticated_promotion_decision_response(
                &policy,
                &attestation,
                &mut broker_stream,
                &signing_key,
                &handled,
            )
            .is_err(),
            "same-UID peer must be rechecked and rejected before write"
        );
        same_uid_client
            .set_read_timeout(Some(Duration::from_millis(50)))
            .expect("bound no-response assertion");
        let mut byte = [0_u8; 1];
        assert!(
            same_uid_client.read(&mut byte).is_err(),
            "peer rejection must write no response bytes"
        );
        assert!(PROMOTION_DECISION_RESPONSE_WRITE_TIMEOUT <= Duration::from_secs(5));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn sequential_accept_loop_continues_after_connection_rejection_and_fails_on_accept_error() {
        use std::os::unix::net::{UnixListener, UnixStream};

        let anchor = tempfile::tempdir().expect("temporary listener directory");
        let socket_path = anchor.path().join("loop.sock");
        let listener = UnixListener::bind(&socket_path).expect("bind sequential test listener");
        let _first_client = UnixStream::connect(&socket_path).expect("queue first connection");
        let _second_client = UnixStream::connect(&socket_path).expect("queue second connection");
        listener
            .set_nonblocking(true)
            .expect("bound accept loop after queued connections");

        let mut handled = 0;
        let result = serve_sequential_connections_for_test(&listener, |_| {
            handled += 1;
            if handled == 1 {
                Err(ProtectedPromotionDecisionHostErrorV1::ConnectionFailed)
            } else {
                Ok(())
            }
        });

        assert_eq!(handled, 2, "connection rejection must not stop the host");
        assert_eq!(
            result,
            Err(ProtectedPromotionDecisionHostErrorV1::AcceptFailed),
            "accept failure is fatal so the supervisor can restart the host"
        );

        let fatal_socket_path = anchor.path().join("fatal-loop.sock");
        let fatal_listener =
            UnixListener::bind(&fatal_socket_path).expect("bind fatal test listener");
        let _fatal_client =
            UnixStream::connect(&fatal_socket_path).expect("queue fatal connection");
        fatal_listener
            .set_nonblocking(true)
            .expect("bound fatal loop");
        assert_eq!(
            serve_sequential_connections_for_test(&fatal_listener, |_| {
                Err(ProtectedPromotionDecisionHostErrorV1::StartupFailed)
            }),
            Err(ProtectedPromotionDecisionHostErrorV1::StartupFailed),
            "an internal authority failure is host-fatal, not a rejected connection"
        );
    }

    #[test]
    fn public_activation_surface_has_no_caller_inputs() {
        let _runner: fn() -> std::process::ExitCode = crate::run_default_promotion_decision_host_v1;
    }

    #[test]
    fn authority_host_binary_guards_arguments_before_the_opaque_runner() {
        assert_eq!(
            include_str!("bin/buildplane-authority-host.rs"),
            "fn main() -> std::process::ExitCode {\n    if std::env::args_os().len() != 1 {\n        eprintln!(\"invalid_arguments\");\n        return std::process::ExitCode::FAILURE;\n    }\n    bp_authority_broker::run_default_promotion_decision_host_v1()\n}\n"
        );
    }

    #[test]
    fn malformed_or_rejected_request_never_enters_response_writer() {
        let mut response_called = false;
        let mut subject = ();
        let result = complete_request_with_response_for_test(
            &mut subject,
            |_| {
                Err::<BrokerPromotionDecisionDisposition, _>(
                    ProtectedPromotionDecisionHostErrorV1::ConnectionFailed,
                )
            },
            |_, _| {
                response_called = true;
                Ok(())
            },
        );

        assert_eq!(
            result,
            Err(ProtectedPromotionDecisionHostErrorV1::ConnectionFailed)
        );
        assert!(
            !response_called,
            "peer, frame, or closed-request rejection must produce no response"
        );
    }

    #[test]
    fn lifecycle_errors_render_only_closed_redacted_messages() {
        let rendered = [
            ProtectedPromotionDecisionHostErrorV1::StartupFailed.to_string(),
            ProtectedPromotionDecisionHostErrorV1::ConnectionFailed.to_string(),
            ProtectedPromotionDecisionHostErrorV1::AcceptFailed.to_string(),
        ];
        assert_eq!(
            rendered,
            [
                "protected promotion-decision host startup failed",
                "protected promotion-decision host connection failed",
                "protected promotion-decision host accept failed",
            ]
        );
        for message in rendered {
            for sensitive in [
                "/run/", "/etc/", "uid", "gid", "fd ", "request", "event", "signer", "sqlite",
                "errno",
            ] {
                assert!(!message.to_lowercase().contains(sensitive));
            }
        }
    }

    #[test]
    fn lifecycle_failures_map_only_to_fixed_operational_categories() {
        assert_eq!(
            [
                operational_diagnostic_for_error(
                    ProtectedPromotionDecisionHostErrorV1::StartupFailed,
                ),
                operational_diagnostic_for_error(
                    ProtectedPromotionDecisionHostErrorV1::ConnectionFailed,
                ),
                operational_diagnostic_for_error(
                    ProtectedPromotionDecisionHostErrorV1::AcceptFailed,
                ),
                OperationalDiagnosticV1::UnsupportedPlatform,
            ],
            [
                OperationalDiagnosticV1::StartupFailed,
                OperationalDiagnosticV1::StartupFailed,
                OperationalDiagnosticV1::AcceptFailed,
                OperationalDiagnosticV1::UnsupportedPlatform,
            ]
        );
        assert_eq!(
            [
                OperationalDiagnosticV1::StartupFailed.as_str(),
                OperationalDiagnosticV1::AcceptFailed.as_str(),
                OperationalDiagnosticV1::UnsupportedPlatform.as_str(),
            ],
            ["startup_failed", "accept_failed", "unsupported_platform"]
        );
    }

    #[test]
    fn runbook_keeps_redacted_diagnostics_and_restart_limits_observable() {
        let runbook = include_str!("../../../../docs/operations/trust-spine-governed-runbook.md");
        assert!(runbook.contains(
            "After=buildplane-authority-host.socket\nStartLimitIntervalSec=60s\nStartLimitBurst=5\n\n[Service]"
        ));
        assert!(runbook.contains("Restart=on-failure\nRestartSec=5s"));
        assert!(runbook.contains("StandardOutput=null\nStandardError=journal"));
        assert!(runbook.contains(
            "A compromised allowlisted operator UID can cause bounded availability loss"
        ));
        assert!(runbook.contains("cannot expand authority or create concurrent ledger writes"));
    }
}
