use crate::v5_admission_host::V5_ADMISSION_SOCKET_PATH;
use crate::v5_admission_response::{
    verify_v5_admission_response_v1, V5AdmissionResponseRequestBindingV1,
};
use crate::v5_dispatch_admission::parse_v5_dispatch_admission_request;
use ed25519_dalek::VerifyingKey;
use serde::Deserialize;
use std::io::{Read, Write};
use std::process::ExitCode;
use thiserror::Error;

pub(crate) const CLIENT_CONFIG_PATH: &str =
    "/etc/buildplane/authority-host/v5-dispatch-admission-client-v1.json";
const INSTALLED_CLIENT_PATH: &str =
    "/usr/libexec/buildplane/buildplane-v5-dispatch-admission-client";
const MAX_CONFIG_BYTES: usize = 16 * 1024;
const MAX_REQUEST_BYTES: usize = 4 * 1024;
const MAX_RESPONSE_BYTES: usize = 16 * 1024;

#[cfg(target_os = "linux")]
use std::fs::File;
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
#[cfg(target_os = "linux")]
use std::os::unix::fs::MetadataExt;
#[cfg(target_os = "linux")]
use std::os::unix::net::UnixStream;
#[cfg(target_os = "linux")]
use std::path::Path;

#[derive(Debug)]
struct ClientConfigV1 {
    listener_creator_uid: u32,
    socket_group_gid: u32,
    broker_identity_public_key: VerifyingKey,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawClientConfigV1 {
    schema_version: u8,
    listener_creator_uid: u32,
    socket_group_gid: u32,
    broker_identity_public_key: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
enum V5AdmissionClientErrorV1 {
    #[error("protected V5 admission client blocked")]
    Blocked,
}

fn parse_client_config(json: &str) -> Result<ClientConfigV1, V5AdmissionClientErrorV1> {
    let raw: RawClientConfigV1 =
        serde_json::from_str(json).map_err(|_| V5AdmissionClientErrorV1::Blocked)?;
    if raw.schema_version != 1 || raw.listener_creator_uid != 0 {
        return Err(V5AdmissionClientErrorV1::Blocked);
    }
    let public_key: [u8; 32] = raw
        .broker_identity_public_key
        .as_slice()
        .try_into()
        .map_err(|_| V5AdmissionClientErrorV1::Blocked)?;
    Ok(ClientConfigV1 {
        listener_creator_uid: raw.listener_creator_uid,
        socket_group_gid: raw.socket_group_gid,
        broker_identity_public_key: VerifyingKey::from_bytes(&public_key)
            .map_err(|_| V5AdmissionClientErrorV1::Blocked)?,
    })
}

pub fn run_default_v5_admission_client_v1() -> ExitCode {
    #[cfg(target_os = "linux")]
    {
        match run_linux() {
            Ok(payload) => {
                if std::io::stdout()
                    .write_all(&payload)
                    .and_then(|_| std::io::stdout().write_all(b"\n"))
                    .is_ok()
                {
                    ExitCode::SUCCESS
                } else {
                    ExitCode::FAILURE
                }
            }
            Err(_) => {
                eprintln!("client_blocked");
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
fn run_linux() -> Result<Vec<u8>, V5AdmissionClientErrorV1> {
    validate_installed_client()?;
    let config = load_default_config()?;
    let mut input = Vec::with_capacity(MAX_REQUEST_BYTES);
    std::io::stdin()
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut input)
        .map_err(|_| V5AdmissionClientErrorV1::Blocked)?;
    if input.is_empty() || input.len() > MAX_REQUEST_BYTES {
        return Err(V5AdmissionClientErrorV1::Blocked);
    }
    let before = validate_socket_path(config.socket_group_gid)?;
    let mut stream = UnixStream::connect(V5_ADMISSION_SOCKET_PATH)
        .map_err(|_| V5AdmissionClientErrorV1::Blocked)?;
    if stream
        .peer_addr()
        .ok()
        .and_then(|address| address.as_pathname().map(Path::to_path_buf))
        .as_deref()
        != Some(Path::new(V5_ADMISSION_SOCKET_PATH))
    {
        return Err(V5AdmissionClientErrorV1::Blocked);
    }
    let after = validate_socket_path(config.socket_group_gid)?;
    if before != after {
        return Err(V5AdmissionClientErrorV1::Blocked);
    }
    exchange_with_stream(
        &mut stream,
        config.listener_creator_uid,
        &config.broker_identity_public_key,
        &input,
    )
}

#[cfg(target_os = "linux")]
fn exchange_with_stream(
    stream: &mut UnixStream,
    expected_listener_creator_uid: u32,
    broker_identity_public_key: &VerifyingKey,
    input: &[u8],
) -> Result<Vec<u8>, V5AdmissionClientErrorV1> {
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .and_then(|_| stream.set_write_timeout(Some(std::time::Duration::from_secs(5))))
        .map_err(|_| V5AdmissionClientErrorV1::Blocked)?;
    let request = parse_v5_dispatch_admission_request(&input)
        .map_err(|_| V5AdmissionClientErrorV1::Blocked)?;
    let canonical_request = format!(
        r#"{{"request_id":"{}","run_id":"{}","v5_envelope_digest":"{}"}}"#,
        request.request_id, request.run_id, request.v5_envelope_digest
    )
    .into_bytes();
    let binding = V5AdmissionResponseRequestBindingV1::new(
        request.request_id,
        request.run_id,
        request.v5_envelope_digest,
    )
    .map_err(|_| V5AdmissionClientErrorV1::Blocked)?;

    validate_listener_creator(stream, expected_listener_creator_uid)?;
    stream
        .write_all(
            &u32::try_from(canonical_request.len())
                .map_err(|_| V5AdmissionClientErrorV1::Blocked)?
                .to_be_bytes(),
        )
        .and_then(|_| stream.write_all(&canonical_request))
        .map_err(|_| V5AdmissionClientErrorV1::Blocked)?;
    let mut encoded_length = [0_u8; 4];
    stream
        .read_exact(&mut encoded_length)
        .map_err(|_| V5AdmissionClientErrorV1::Blocked)?;
    let length = u32::from_be_bytes(encoded_length) as usize;
    if length == 0 || length > MAX_RESPONSE_BYTES {
        return Err(V5AdmissionClientErrorV1::Blocked);
    }
    let mut payload = vec![0_u8; length];
    stream
        .read_exact(&mut payload)
        .map_err(|_| V5AdmissionClientErrorV1::Blocked)?;
    validate_listener_creator(stream, expected_listener_creator_uid)?;
    verify_v5_admission_response_v1(&payload, broker_identity_public_key, &binding)
        .map_err(|_| V5AdmissionClientErrorV1::Blocked)?;
    Ok(payload)
}

#[cfg(all(test, target_os = "linux"))]
fn exchange_with_stream_for_test(
    stream: &mut UnixStream,
    expected_listener_creator_uid: u32,
    broker_identity_public_key: &VerifyingKey,
    input: &[u8],
) -> Result<Vec<u8>, V5AdmissionClientErrorV1> {
    exchange_with_stream(
        stream,
        expected_listener_creator_uid,
        broker_identity_public_key,
        input,
    )
}

#[cfg(target_os = "linux")]
fn open_root() -> Result<File, V5AdmissionClientErrorV1> {
    let fd = unsafe {
        libc::open(
            c"/".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(V5AdmissionClientErrorV1::Blocked);
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(target_os = "linux")]
fn open_root_directory(parent: RawFd, component: &[u8]) -> Result<File, V5AdmissionClientErrorV1> {
    let component =
        std::ffi::CString::new(component).map_err(|_| V5AdmissionClientErrorV1::Blocked)?;
    let fd = unsafe {
        libc::openat(
            parent,
            component.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(V5AdmissionClientErrorV1::Blocked);
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let metadata = file
        .metadata()
        .map_err(|_| V5AdmissionClientErrorV1::Blocked)?;
    if metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
        return Err(V5AdmissionClientErrorV1::Blocked);
    }
    Ok(file)
}

#[cfg(target_os = "linux")]
fn walk_root_directories(components: &[&[u8]]) -> Result<File, V5AdmissionClientErrorV1> {
    let mut parent = open_root()?;
    for component in components {
        parent = open_root_directory(parent.as_raw_fd(), component)?;
    }
    Ok(parent)
}

#[cfg(target_os = "linux")]
fn load_default_config() -> Result<ClientConfigV1, V5AdmissionClientErrorV1> {
    let parent = walk_root_directories(&[b"etc", b"buildplane", b"authority-host"])?;
    let name = std::ffi::CString::new(b"v5-dispatch-admission-client-v1.json".as_slice())
        .map_err(|_| V5AdmissionClientErrorV1::Blocked)?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(V5AdmissionClientErrorV1::Blocked);
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let metadata = file
        .metadata()
        .map_err(|_| V5AdmissionClientErrorV1::Blocked)?;
    if !metadata.file_type().is_file()
        || metadata.uid() != 0
        || metadata.nlink() != 1
        || metadata.mode() & 0o7777 != 0o644
    {
        return Err(V5AdmissionClientErrorV1::Blocked);
    }
    let mut bytes = Vec::with_capacity(MAX_CONFIG_BYTES);
    file.take((MAX_CONFIG_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| V5AdmissionClientErrorV1::Blocked)?;
    if bytes.is_empty() || bytes.len() > MAX_CONFIG_BYTES {
        return Err(V5AdmissionClientErrorV1::Blocked);
    }
    parse_client_config(std::str::from_utf8(&bytes).map_err(|_| V5AdmissionClientErrorV1::Blocked)?)
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SocketIdentity {
    device: u64,
    inode: u64,
}

#[cfg(target_os = "linux")]
fn validate_socket_path(expected_group: u32) -> Result<SocketIdentity, V5AdmissionClientErrorV1> {
    let parent = walk_root_directories(&[b"run", b"buildplane", b"authority-host"])?;
    let name = std::ffi::CString::new(b"v5-dispatch-admission-v1.sock".as_slice())
        .map_err(|_| V5AdmissionClientErrorV1::Blocked)?;
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
        return Err(V5AdmissionClientErrorV1::Blocked);
    }
    let stat = unsafe { stat.assume_init() };
    if stat.st_mode & libc::S_IFMT != libc::S_IFSOCK
        || stat.st_uid != 0
        || stat.st_gid != expected_group
        || stat.st_mode & 0o7777 != 0o660
        || stat.st_nlink != 1
    {
        return Err(V5AdmissionClientErrorV1::Blocked);
    }
    Ok(SocketIdentity {
        device: stat.st_dev,
        inode: stat.st_ino,
    })
}

#[cfg(target_os = "linux")]
fn validate_listener_creator(
    stream: &UnixStream,
    expected_uid: u32,
) -> Result<(), V5AdmissionClientErrorV1> {
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
        return Err(V5AdmissionClientErrorV1::Blocked);
    }
    let credentials = unsafe { credentials.assume_init() };
    if credentials.uid != expected_uid || credentials.pid <= 0 {
        return Err(V5AdmissionClientErrorV1::Blocked);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn validate_installed_client() -> Result<(), V5AdmissionClientErrorV1> {
    let parent = walk_root_directories(&[b"usr", b"libexec", b"buildplane"])?;
    let name = std::ffi::CString::new(b"buildplane-v5-dispatch-admission-client".as_slice())
        .map_err(|_| V5AdmissionClientErrorV1::Blocked)?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(V5AdmissionClientErrorV1::Blocked);
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let metadata = file
        .metadata()
        .map_err(|_| V5AdmissionClientErrorV1::Blocked)?;
    if !metadata.file_type().is_file()
        || metadata.uid() != 0
        || metadata.nlink() != 1
        || metadata.mode() & 0o7777 != 0o755
        || std::fs::read_link("/proc/self/exe").ok().as_deref()
            != Some(Path::new(INSTALLED_CLIENT_PATH))
    {
        return Err(V5AdmissionClientErrorV1::Blocked);
    }
    let process =
        std::fs::metadata("/proc/self/exe").map_err(|_| V5AdmissionClientErrorV1::Blocked)?;
    if process.dev() != metadata.dev() || process.ino() != metadata.ino() {
        return Err(V5AdmissionClientErrorV1::Blocked);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use serde_json::json;

    #[test]
    fn client_config_is_closed_and_pins_listener_creator_and_response_key() {
        let key = SigningKey::from_bytes(&[71; 32]);
        let valid = json!({
            "schema_version": 1,
            "listener_creator_uid": 0,
            "socket_group_gid": 1002,
            "broker_identity_public_key": key.verifying_key().to_bytes().to_vec(),
        });
        assert!(parse_client_config(&valid.to_string()).is_ok());

        let mut extended = valid;
        extended["socket_path"] = json!("/tmp/attacker.sock");
        assert!(parse_client_config(&extended.to_string()).is_err());
    }

    #[test]
    fn client_endpoint_and_config_paths_are_fixed() {
        assert_eq!(
            V5_ADMISSION_SOCKET_PATH,
            "/run/buildplane/authority-host/v5-dispatch-admission-v1.sock"
        );
        assert_eq!(
            CLIENT_CONFIG_PATH,
            "/etc/buildplane/authority-host/v5-dispatch-admission-client-v1.json"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn systemd_listener_creator_is_authenticated_instead_of_acceptor() {
        use std::os::unix::net::{UnixListener, UnixStream};

        let directory = tempfile::tempdir().expect("temporary socket directory");
        let socket_path = directory.path().join("activation.sock");
        let listener = UnixListener::bind(&socket_path).expect("bind listener");
        let creator_pid = unsafe { libc::getpid() };
        let creator_uid = unsafe { libc::geteuid() };
        let acceptor_pid = unsafe { libc::fork() };
        assert!(acceptor_pid >= 0);
        if acceptor_pid == 0 {
            let result = listener.accept();
            unsafe { libc::_exit(if result.is_ok() { 0 } else { 1 }) };
        }

        let client = UnixStream::connect(&socket_path).expect("connect activated listener");
        let mut credentials = std::mem::MaybeUninit::<libc::ucred>::zeroed();
        let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        assert_eq!(
            unsafe {
                libc::getsockopt(
                    client.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_PEERCRED,
                    credentials.as_mut_ptr().cast(),
                    std::ptr::addr_of_mut!(length),
                )
            },
            0
        );
        let credentials = unsafe { credentials.assume_init() };
        assert_eq!(credentials.pid, creator_pid);
        assert_ne!(credentials.pid, acceptor_pid);
        assert_eq!(credentials.uid, creator_uid);
        assert!(validate_listener_creator(&client, creator_uid).is_ok());

        let mut status = 0;
        assert_eq!(
            unsafe { libc::waitpid(acceptor_pid, &mut status, 0) },
            acceptor_pid
        );
        assert!(libc::WIFEXITED(status));
        assert_eq!(libc::WEXITSTATUS(status), 0);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn client_exchange_accepts_only_a_signed_full_evidence_response() {
        use crate::v5_admission_response::{
            sign_v5_admission_response_v1, V5AdmissionResponseRequestBindingV1,
        };
        use crate::v5_dispatch_admission::{
            BrokerV5DispatchAdmissionDisposition, SealedV5DispatchAdmissionEvidence,
        };
        use bp_ledger::{EventId, RunId};
        use std::os::unix::net::{UnixListener, UnixStream};

        let directory = tempfile::tempdir().expect("temporary socket directory");
        let path = directory.path().join("exchange.sock");
        let listener = UnixListener::bind(&path).expect("bind mock protected host");
        let key = SigningKey::from_bytes(&[77; 32]);
        let verify = key.verifying_key();
        let run_id = RunId::new();
        let request_id = uuid::Uuid::now_v7();
        let envelope_digest =
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let request = format!(
            r#"{{"request_id":"{request_id}","run_id":"{run_id}","v5_envelope_digest":"{envelope_digest}"}}"#
        );
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept client");
            let mut header = [0_u8; 4];
            stream.read_exact(&mut header).expect("request header");
            let mut body = vec![0_u8; u32::from_be_bytes(header) as usize];
            stream.read_exact(&mut body).expect("request body");
            let parsed = parse_v5_dispatch_admission_request(&body).expect("exact request");
            let binding = V5AdmissionResponseRequestBindingV1::new(
                parsed.request_id,
                parsed.run_id,
                parsed.v5_envelope_digest.clone(),
            )
            .expect("binding");
            let evidence = SealedV5DispatchAdmissionEvidence {
                run_id: parsed.run_id,
                source_dispatch_event_id: EventId::new(),
                source_dispatch_event_digest:
                    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
                admission_event_id: EventId::new(),
                admission_event_digest:
                    "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".into(),
                v5_envelope_digest: parsed.v5_envelope_digest,
                witness_evidence_digest:
                    "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd".into(),
                semantic_identity_digest:
                    "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".into(),
                idempotency_key: "dispatch:v5:client-test".into(),
                checkpoint_event_id: EventId::new(),
                checkpoint_event_digest:
                    "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".into(),
            };
            let response = sign_v5_admission_response_v1(
                &key,
                &binding,
                &BrokerV5DispatchAdmissionDisposition::Sealed(evidence),
            )
            .expect("signed response");
            stream
                .write_all(&(response.len() as u32).to_be_bytes())
                .and_then(|_| stream.write_all(&response))
                .expect("write response");
        });
        let mut stream = UnixStream::connect(&path).expect("connect mock host");
        let payload = exchange_with_stream_for_test(
            &mut stream,
            unsafe { libc::geteuid() },
            &verify,
            request.as_bytes(),
        )
        .expect("authenticated exchange");
        assert!(String::from_utf8(payload)
            .expect("JSON")
            .contains("\"status\":\"sealed\""));
        server.join().expect("mock server");
    }
}
