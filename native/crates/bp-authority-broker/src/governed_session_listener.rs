//! Fixed, supervised Linux listener for the protected governed-session host.
//!
//! The host never binds or discovers a socket itself. It claims descriptor 3
//! from the service supervisor, proves that descriptor is the exact fixed Unix
//! listener, validates the root-owned socket path without following symlinks,
//! and only then loads private governed-session authority.

use std::process::ExitCode;
use thiserror::Error;

pub(crate) const GOVERNED_SESSION_LISTENER_FD: libc::c_int = 3;
pub(crate) const GOVERNED_SESSION_SOCKET_PATH: &str =
    "/run/buildplane/authority-host/governed-session-v1.sock";

#[cfg(target_os = "linux")]
use crate::governed_session_protected_host::compose_validated_governed_session_host_v1;
#[cfg(target_os = "linux")]
use crate::host_config_loader::load_default_governed_session_host_config_v1;
#[cfg(target_os = "linux")]
use std::fs::File;
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
#[cfg(target_os = "linux")]
use std::os::unix::net::UnixListener;
#[cfg(target_os = "linux")]
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::time::Duration;

#[cfg(target_os = "linux")]
const SOCKET_PARENT_COMPONENTS: [&[u8]; 3] = [b"run", b"buildplane", b"authority-host"];
#[cfg(target_os = "linux")]
const SOCKET_FILE_NAME: &[u8] = b"governed-session-v1.sock";
#[cfg(target_os = "linux")]
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
enum GovernedSessionListenerErrorV1 {
    #[error("protected governed-session listener startup failed")]
    Startup,
    #[error("protected governed-session listener accept failed")]
    Accept,
}

pub fn run_default_governed_session_host_v1() -> ExitCode {
    #[cfg(target_os = "linux")]
    {
        match run_linux() {
            Ok(()) => ExitCode::SUCCESS,
            Err(GovernedSessionListenerErrorV1::Accept) => {
                eprintln!("accept_failed");
                ExitCode::FAILURE
            }
            Err(GovernedSessionListenerErrorV1::Startup) => {
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
fn run_linux() -> Result<(), GovernedSessionListenerErrorV1> {
    let listener = claim_preopened_listener(
        GOVERNED_SESSION_LISTENER_FD,
        Path::new(GOVERNED_SESSION_SOCKET_PATH),
    )?;
    let validated_startup = load_default_governed_session_host_config_v1()
        .map_err(|_| GovernedSessionListenerErrorV1::Startup)?;
    validate_default_socket_path(validated_startup.config().socket_group_gid)?;
    let host = compose_validated_governed_session_host_v1(validated_startup)
        .map_err(|_| GovernedSessionListenerErrorV1::Startup)?;

    loop {
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(GovernedSessionListenerErrorV1::Accept),
        };
        // Authentication, framing, replay, provider authority, and response
        // signing all remain inside the protected state. A rejected client
        // receives no fallback, unsigned error body, or host execution path.
        let _ = host.handle_authenticated_connection(&mut stream, CONNECTION_TIMEOUT);
    }
}

#[cfg(target_os = "linux")]
fn claim_preopened_listener(
    listener_fd: RawFd,
    expected_path: &Path,
) -> Result<UnixListener, GovernedSessionListenerErrorV1> {
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
        return Err(GovernedSessionListenerErrorV1::Startup);
    }
    let listener_fd = unsafe { OwnedFd::from_raw_fd(listener_fd) };
    duplicate_and_validate_listener(listener_fd, expected_path)
}

#[cfg(target_os = "linux")]
fn duplicate_and_validate_listener(
    listener_fd: OwnedFd,
    expected_path: &Path,
) -> Result<UnixListener, GovernedSessionListenerErrorV1> {
    let duplicate = unsafe { libc::fcntl(listener_fd.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 4) };
    if duplicate < 0 {
        return Err(GovernedSessionListenerErrorV1::Startup);
    }
    let listener = unsafe { UnixListener::from_raw_fd(duplicate) };
    let mut stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
    if unsafe { libc::fstat(listener.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
        return Err(GovernedSessionListenerErrorV1::Startup);
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
        return Err(GovernedSessionListenerErrorV1::Startup);
    }
    Ok(listener)
}

#[cfg(target_os = "linux")]
fn socket_option(
    descriptor: RawFd,
    option: libc::c_int,
) -> Result<libc::c_int, GovernedSessionListenerErrorV1> {
    let mut value = 0;
    let mut length = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            descriptor,
            libc::SOL_SOCKET,
            option,
            std::ptr::addr_of_mut!(value).cast(),
            std::ptr::addr_of_mut!(length),
        )
    } != 0
        || length as usize != std::mem::size_of::<libc::c_int>()
    {
        return Err(GovernedSessionListenerErrorV1::Startup);
    }
    Ok(value)
}

#[cfg(target_os = "linux")]
fn validate_default_socket_path(expected_group: u32) -> Result<(), GovernedSessionListenerErrorV1> {
    let root_fd = unsafe {
        libc::open(
            c"/".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if root_fd < 0 {
        return Err(GovernedSessionListenerErrorV1::Startup);
    }
    let root = unsafe { File::from_raw_fd(root_fd) };
    validate_socket_path_from_anchor(
        root.as_raw_fd(),
        &SOCKET_PARENT_COMPONENTS,
        SOCKET_FILE_NAME,
        0,
        expected_group,
    )
}

#[cfg(target_os = "linux")]
fn validate_socket_path_from_anchor(
    anchor_descriptor: RawFd,
    parent_components: &[&[u8]],
    socket_file_name: &[u8],
    expected_owner: u32,
    expected_group: u32,
) -> Result<(), GovernedSessionListenerErrorV1> {
    let mut parent: Option<File> = None;
    let mut parent_fd = anchor_descriptor;
    for component in parent_components {
        let name = std::ffi::CString::new(*component)
            .map_err(|_| GovernedSessionListenerErrorV1::Startup)?;
        let fd = unsafe {
            libc::openat(
                parent_fd,
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(GovernedSessionListenerErrorV1::Startup);
        }
        let opened = unsafe { File::from_raw_fd(fd) };
        let mut stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
        if unsafe { libc::fstat(opened.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
            return Err(GovernedSessionListenerErrorV1::Startup);
        }
        let stat = unsafe { stat.assume_init() };
        if stat.st_mode & libc::S_IFMT != libc::S_IFDIR
            || stat.st_uid != expected_owner
            || stat.st_mode & 0o7777 != 0o755
        {
            return Err(GovernedSessionListenerErrorV1::Startup);
        }
        parent_fd = opened.as_raw_fd();
        parent = Some(opened);
    }
    let parent = parent.ok_or(GovernedSessionListenerErrorV1::Startup)?;
    let name = std::ffi::CString::new(socket_file_name)
        .map_err(|_| GovernedSessionListenerErrorV1::Startup)?;
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
        return Err(GovernedSessionListenerErrorV1::Startup);
    }
    let stat = unsafe { stat.assume_init() };
    if stat.st_mode & libc::S_IFMT != libc::S_IFSOCK
        || stat.st_uid != expected_owner
        || stat.st_gid != expected_group
        || stat.st_mode & 0o7777 != 0o660
        || stat.st_nlink != 1
    {
        return Err(GovernedSessionListenerErrorV1::Startup);
    }
    Ok(())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn preopened_listener_must_be_the_exact_expected_unix_socket() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let socket_path = temp.path().join("governed.sock");
        let listener = UnixListener::bind(&socket_path).expect("listener");
        let duplicate = unsafe { libc::fcntl(listener.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 4) };
        assert!(duplicate >= 0);
        let validated = duplicate_and_validate_listener(
            unsafe { OwnedFd::from_raw_fd(duplicate) },
            &socket_path,
        )
        .expect("validated listener");
        assert_eq!(
            validated.local_addr().unwrap().as_pathname(),
            Some(socket_path.as_path())
        );

        let other = temp.path().join("other.sock");
        assert!(duplicate_and_validate_listener(
            unsafe {
                OwnedFd::from_raw_fd(libc::fcntl(listener.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 4))
            },
            &other,
        )
        .is_err());
    }

    #[test]
    fn descriptor_walk_rejects_mutable_parent_and_non_socket_substitution() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let owner = unsafe { libc::geteuid() };
        let group = unsafe { libc::getegid() };
        let protected = temp.path().join("protected");
        fs::create_dir(&protected).expect("protected directory");
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o755)).expect("anchor mode");
        fs::set_permissions(&protected, fs::Permissions::from_mode(0o755)).expect("protected mode");
        let socket_path = protected.join("governed.sock");
        let _listener = UnixListener::bind(&socket_path).expect("listener");
        fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o660)).expect("socket mode");
        let anchor_fd = unsafe {
            libc::open(
                std::ffi::CString::new(temp.path().as_os_str().as_encoded_bytes())
                    .unwrap()
                    .as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        assert!(anchor_fd >= 0);
        let anchor = unsafe { File::from_raw_fd(anchor_fd) };
        assert!(validate_socket_path_from_anchor(
            anchor.as_raw_fd(),
            &[b"protected"],
            b"governed.sock",
            owner,
            group,
        )
        .is_ok());

        fs::set_permissions(&protected, fs::Permissions::from_mode(0o775)).expect("mutable mode");
        assert!(validate_socket_path_from_anchor(
            anchor.as_raw_fd(),
            &[b"protected"],
            b"governed.sock",
            owner,
            group,
        )
        .is_err());
    }
}
