use std::process::ExitCode;

pub(crate) const V5_ADMISSION_LISTENER_FD: libc::c_int = 3;
pub(crate) const V5_ADMISSION_SOCKET_PATH: &str =
    "/run/buildplane/authority-host/v5-dispatch-admission-v1.sock";

#[cfg(target_os = "linux")]
use crate::confinement::{
    BrokerAuthorityRoleV1, BrokerHostConfinementAttestationV1, BrokerHostConfinementPolicyV1,
};
#[cfg(target_os = "linux")]
use crate::host_config_loader::{
    load_default_v5_admission_host_config_v1, ValidatedV5AdmissionHostStartupV1,
};
#[cfg(target_os = "linux")]
use crate::host_key_custody::{
    load_v5_admission_signing_keys_v1, ProtectedV5AdmissionSigningKeysV1,
};
#[cfg(target_os = "linux")]
use crate::host_ledger_custody::{load_v5_admission_ledger_v1, ProtectedPromotionDecisionLedgerV1};
#[cfg(target_os = "linux")]
use crate::v5_admission_response::{
    sign_v5_admission_response_v1, V5AdmissionResponseRequestBindingV1,
};
#[cfg(target_os = "linux")]
use crate::v5_dispatch_admission::{
    handle_authenticated_v5_dispatch_admission_request_with_binding,
    LedgerV5DispatchAdmissionBackend,
};
#[cfg(target_os = "linux")]
use std::fs::File;
#[cfg(target_os = "linux")]
use std::io::Write;
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
#[cfg(target_os = "linux")]
use std::os::unix::net::{UnixListener, UnixStream};
#[cfg(target_os = "linux")]
use std::path::Path;
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};
use thiserror::Error;

const MAX_RESPONSE_FRAME_BYTES: usize = 16 * 1024;
#[cfg(target_os = "linux")]
const SOCKET_PARENT_COMPONENTS: [&[u8]; 3] = [b"run", b"buildplane", b"authority-host"];
#[cfg(target_os = "linux")]
const SOCKET_FILE_NAME: &[u8] = b"v5-dispatch-admission-v1.sock";

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
enum V5AdmissionHostErrorV1 {
    #[error("protected V5 admission host startup failed")]
    Startup,
    #[error("protected V5 admission host connection failed")]
    Connection,
    #[error("protected V5 admission host accept failed")]
    Accept,
}

#[cfg(target_os = "linux")]
struct V5AdmissionHostV1 {
    startup: ValidatedV5AdmissionHostStartupV1,
    keys: ProtectedV5AdmissionSigningKeysV1,
    ledger: ProtectedPromotionDecisionLedgerV1,
    policy: BrokerHostConfinementPolicyV1,
    attestation: BrokerHostConfinementAttestationV1,
}

#[cfg(target_os = "linux")]
impl V5AdmissionHostV1 {
    fn from_startup(
        startup: ValidatedV5AdmissionHostStartupV1,
    ) -> Result<Self, V5AdmissionHostErrorV1> {
        let policy = BrokerHostConfinementPolicyV1::new_for_role(
            startup.config().broker_uid,
            BrokerAuthorityRoleV1::DispatchAdmission,
            startup
                .config()
                .dispatch_admission_client_uids
                .iter()
                .copied(),
        )
        .map_err(|_| V5AdmissionHostErrorV1::Startup)?;
        let attestation = policy
            .attest_current_broker_process()
            .map_err(|_| V5AdmissionHostErrorV1::Startup)?;
        let keys = load_v5_admission_signing_keys_v1(&startup)
            .map_err(|_| V5AdmissionHostErrorV1::Startup)?;
        let ledger =
            load_v5_admission_ledger_v1(&startup).map_err(|_| V5AdmissionHostErrorV1::Startup)?;
        LedgerV5DispatchAdmissionBackend::from_prevalidated_startup(
            ledger.store(),
            &startup.config().admission_authority,
            keys.admission(),
            &startup.config().admission_record_signer,
            keys.checkpoint(),
            &startup.config().checkpoint_signer,
        )
        .map_err(|_| V5AdmissionHostErrorV1::Startup)?;
        Ok(Self {
            startup,
            keys,
            ledger,
            policy,
            attestation,
        })
    }

    fn handle(&self, stream: &mut UnixStream) -> Result<(), V5AdmissionHostErrorV1> {
        let config = self.startup.config();
        let backend = LedgerV5DispatchAdmissionBackend::from_prevalidated_startup(
            self.ledger.store(),
            &config.admission_authority,
            self.keys.admission(),
            &config.admission_record_signer,
            self.keys.checkpoint(),
            &config.checkpoint_signer,
        )
        .map_err(|_| V5AdmissionHostErrorV1::Startup)?;
        let handled = handle_authenticated_v5_dispatch_admission_request_with_binding(
            &self.policy,
            &self.attestation,
            stream,
            &backend,
            config.run_id,
        )
        .map_err(|_| V5AdmissionHostErrorV1::Connection)?;
        let binding = V5AdmissionResponseRequestBindingV1::new(
            handled.request.request_id,
            handled.request.run_id,
            handled.request.v5_envelope_digest.clone(),
        )
        .map_err(|_| V5AdmissionHostErrorV1::Connection)?;
        let payload =
            sign_v5_admission_response_v1(self.keys.checkpoint(), &binding, &handled.disposition)
                .map_err(|_| V5AdmissionHostErrorV1::Connection)?;
        if payload.is_empty() || payload.len() > MAX_RESPONSE_FRAME_BYTES {
            return Err(V5AdmissionHostErrorV1::Connection);
        }
        let mut frame = u32::try_from(payload.len())
            .map_err(|_| V5AdmissionHostErrorV1::Connection)?
            .to_be_bytes()
            .to_vec();
        frame.extend_from_slice(&payload);
        let deadline = Instant::now()
            .checked_add(Duration::from_secs(5))
            .ok_or(V5AdmissionHostErrorV1::Connection)?;
        let mut written = 0;
        while written < frame.len() {
            self.policy
                .verify_linux_connected_worker_for_role(
                    BrokerAuthorityRoleV1::DispatchAdmission,
                    &self.attestation,
                    stream,
                )
                .map_err(|_| V5AdmissionHostErrorV1::Connection)?;
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .filter(|remaining| !remaining.is_zero())
                .ok_or(V5AdmissionHostErrorV1::Connection)?;
            stream
                .set_write_timeout(Some(remaining))
                .map_err(|_| V5AdmissionHostErrorV1::Connection)?;
            let count = stream
                .write(&frame[written..])
                .map_err(|_| V5AdmissionHostErrorV1::Connection)?;
            if count == 0 {
                return Err(V5AdmissionHostErrorV1::Connection);
            }
            written += count;
        }
        Ok(())
    }
}

pub fn run_default_v5_admission_host_v1() -> ExitCode {
    #[cfg(target_os = "linux")]
    {
        match run_linux() {
            Ok(()) => ExitCode::SUCCESS,
            Err(V5AdmissionHostErrorV1::Accept) => {
                eprintln!("accept_failed");
                ExitCode::FAILURE
            }
            Err(_) => {
                eprintln!("startup_failed");
                ExitCode::FAILURE
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        eprintln!("unsupported_platform");
        ExitCode::FAILURE
    }
}

#[cfg(target_os = "linux")]
fn run_linux() -> Result<(), V5AdmissionHostErrorV1> {
    let listener = claim_listener(
        V5_ADMISSION_LISTENER_FD,
        Path::new(V5_ADMISSION_SOCKET_PATH),
    )?;
    let startup =
        load_default_v5_admission_host_config_v1().map_err(|_| V5AdmissionHostErrorV1::Startup)?;
    validate_socket_path(startup.config().socket_group_gid)?;
    let host = V5AdmissionHostV1::from_startup(startup)?;
    loop {
        let (mut stream, _) = listener
            .accept()
            .map_err(|_| V5AdmissionHostErrorV1::Accept)?;
        match host.handle(&mut stream) {
            Ok(()) | Err(V5AdmissionHostErrorV1::Connection) => {}
            Err(error) => return Err(error),
        }
    }
}

#[cfg(target_os = "linux")]
fn claim_listener(fd: RawFd, expected_path: &Path) -> Result<UnixListener, V5AdmissionHostErrorV1> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } != 0 {
        return Err(V5AdmissionHostErrorV1::Startup);
    }
    let owned = unsafe { OwnedFd::from_raw_fd(fd) };
    let duplicate = unsafe { libc::fcntl(owned.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 4) };
    if duplicate < 0 {
        return Err(V5AdmissionHostErrorV1::Startup);
    }
    let listener = unsafe { UnixListener::from_raw_fd(duplicate) };
    let mut stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
    if unsafe { libc::fstat(listener.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
        return Err(V5AdmissionHostErrorV1::Startup);
    }
    let stat = unsafe { stat.assume_init() };
    if stat.st_mode & libc::S_IFMT != libc::S_IFSOCK
        || socket_option(listener.as_raw_fd(), libc::SO_DOMAIN)? != libc::AF_UNIX
        || socket_option(listener.as_raw_fd(), libc::SO_TYPE)? != libc::SOCK_STREAM
        || socket_option(listener.as_raw_fd(), libc::SO_ACCEPTCONN)? != 1
        || listener
            .local_addr()
            .ok()
            .and_then(|address| address.as_pathname().map(Path::to_path_buf))
            .as_deref()
            != Some(expected_path)
    {
        return Err(V5AdmissionHostErrorV1::Startup);
    }
    Ok(listener)
}

#[cfg(target_os = "linux")]
fn socket_option(fd: RawFd, option: libc::c_int) -> Result<libc::c_int, V5AdmissionHostErrorV1> {
    let mut value = 0;
    let mut length = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            option,
            std::ptr::addr_of_mut!(value).cast(),
            std::ptr::addr_of_mut!(length),
        )
    } != 0
        || length as usize != std::mem::size_of::<libc::c_int>()
    {
        return Err(V5AdmissionHostErrorV1::Startup);
    }
    Ok(value)
}

#[cfg(target_os = "linux")]
fn validate_socket_path(expected_group: u32) -> Result<(), V5AdmissionHostErrorV1> {
    let root_fd = unsafe {
        libc::open(
            c"/".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if root_fd < 0 {
        return Err(V5AdmissionHostErrorV1::Startup);
    }
    let root = unsafe { File::from_raw_fd(root_fd) };
    let mut parent: Option<File> = None;
    let mut parent_fd = root.as_raw_fd();
    for component in SOCKET_PARENT_COMPONENTS {
        let name =
            std::ffi::CString::new(component).map_err(|_| V5AdmissionHostErrorV1::Startup)?;
        let fd = unsafe {
            libc::openat(
                parent_fd,
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(V5AdmissionHostErrorV1::Startup);
        }
        let opened = unsafe { File::from_raw_fd(fd) };
        let mut stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
        if unsafe { libc::fstat(opened.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
            return Err(V5AdmissionHostErrorV1::Startup);
        }
        let stat = unsafe { stat.assume_init() };
        if stat.st_mode & libc::S_IFMT != libc::S_IFDIR
            || stat.st_uid != 0
            || stat.st_mode & 0o7777 != 0o755
        {
            return Err(V5AdmissionHostErrorV1::Startup);
        }
        parent_fd = opened.as_raw_fd();
        parent = Some(opened);
    }
    let parent = parent.ok_or(V5AdmissionHostErrorV1::Startup)?;
    let name =
        std::ffi::CString::new(SOCKET_FILE_NAME).map_err(|_| V5AdmissionHostErrorV1::Startup)?;
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
        return Err(V5AdmissionHostErrorV1::Startup);
    }
    let stat = unsafe { stat.assume_init() };
    if stat.st_mode & libc::S_IFMT != libc::S_IFSOCK
        || stat.st_uid != 0
        || stat.st_gid != expected_group
        || stat.st_mode & 0o7777 != 0o660
        || stat.st_nlink != 1
    {
        return Err(V5AdmissionHostErrorV1::Startup);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_endpoint_paths_are_fixed_and_role_specific() {
        assert_eq!(
            V5_ADMISSION_SOCKET_PATH,
            "/run/buildplane/authority-host/v5-dispatch-admission-v1.sock"
        );
        assert_eq!(V5_ADMISSION_LISTENER_FD, 3);
    }
}
