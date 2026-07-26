use std::process::ExitCode;

pub(crate) const V5_ADMISSION_LISTENER_FD: libc::c_int = 3;
pub(crate) const V5_ADMISSION_SOCKET_PATH: &str =
    "/run/buildplane/authority-host/v5-dispatch-admission-v1.sock";

#[cfg(target_os = "linux")]
use crate::confinement::{
    BrokerAuthorityRoleV1, BrokerHostConfinementAttestationV1, BrokerHostConfinementPolicyV1,
};
#[cfg(target_os = "linux")]
use crate::host_cas_custody::{load_protected_v5_cas_v1, ProtectedV5CasV1};
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
    parse_v5_dispatch_admission_request, read_authenticated_v5_dispatch_admission_frame,
    record_v5_admission_for_expected_run, LedgerV5DispatchAdmissionBackend,
};
#[cfg(target_os = "linux")]
use std::collections::{HashMap, VecDeque};
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
use std::sync::{mpsc, Arc, Mutex};
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};
use thiserror::Error;

const MAX_RESPONSE_FRAME_BYTES: usize = 16 * 1024;
#[cfg(target_os = "linux")]
const INGRESS_WORKER_COUNT: usize = 4;
#[cfg(target_os = "linux")]
const MAX_TOTAL_IN_FLIGHT: usize = 8;
#[cfg(target_os = "linux")]
const MAX_PER_UID_IN_FLIGHT: usize = 2;
#[cfg(target_os = "linux")]
const MAX_PER_UID_PER_WINDOW: usize = 16;
#[cfg(target_os = "linux")]
const PER_UID_RATE_WINDOW: Duration = Duration::from_secs(1);
#[cfg(target_os = "linux")]
const MUTATION_RESPONSE_TIMEOUT: Duration = Duration::from_secs(5);
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
    _cas: ProtectedV5CasV1,
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
        let cas = load_protected_v5_cas_v1(
            startup.authority_root().directory(),
            startup.config().broker_uid,
        )
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
            _cas: cas,
            keys,
            ledger,
            policy,
            attestation,
        })
    }

    fn mutate_and_encode_response(
        &self,
        payload: &[u8],
    ) -> Result<Vec<u8>, V5AdmissionHostErrorV1> {
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
        let request = parse_v5_dispatch_admission_request(payload)
            .map_err(|_| V5AdmissionHostErrorV1::Connection)?;
        let disposition =
            record_v5_admission_for_expected_run(&backend, request.clone(), config.run_id);
        let binding = V5AdmissionResponseRequestBindingV1::new(
            request.request_id,
            request.run_id,
            request.v5_envelope_digest.clone(),
        )
        .map_err(|_| V5AdmissionHostErrorV1::Connection)?;
        let payload = sign_v5_admission_response_v1(self.keys.checkpoint(), &binding, &disposition)
            .map_err(|_| V5AdmissionHostErrorV1::Connection)?;
        if payload.is_empty() || payload.len() > MAX_RESPONSE_FRAME_BYTES {
            return Err(V5AdmissionHostErrorV1::Connection);
        }
        let mut frame = u32::try_from(payload.len())
            .map_err(|_| V5AdmissionHostErrorV1::Connection)?
            .to_be_bytes()
            .to_vec();
        frame.extend_from_slice(&payload);
        Ok(frame)
    }
}

#[cfg(target_os = "linux")]
fn write_authenticated_response(
    policy: &BrokerHostConfinementPolicyV1,
    attestation: &BrokerHostConfinementAttestationV1,
    stream: &mut UnixStream,
    frame: &[u8],
) -> Result<(), V5AdmissionHostErrorV1> {
    let deadline = Instant::now()
        .checked_add(Duration::from_secs(5))
        .ok_or(V5AdmissionHostErrorV1::Connection)?;
    let mut written = 0;
    while written < frame.len() {
        policy
            .verify_linux_connected_worker_for_role(
                BrokerAuthorityRoleV1::DispatchAdmission,
                attestation,
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
        if Instant::now() >= deadline {
            return Err(V5AdmissionHostErrorV1::Connection);
        }
    }
    stream
        .shutdown(std::net::Shutdown::Write)
        .map_err(|_| V5AdmissionHostErrorV1::Connection)?;
    Ok(())
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct InFlightState {
    total: usize,
    by_uid: HashMap<u32, usize>,
    recent_by_uid: HashMap<u32, VecDeque<Instant>>,
}

#[cfg(target_os = "linux")]
struct InFlightPermit {
    uid: u32,
    state: Arc<Mutex<InFlightState>>,
}

#[cfg(target_os = "linux")]
impl Drop for InFlightPermit {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.total = state.total.saturating_sub(1);
            if let Some(count) = state.by_uid.get_mut(&self.uid) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    state.by_uid.remove(&self.uid);
                }
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn try_acquire_in_flight(state: &Arc<Mutex<InFlightState>>, uid: u32) -> Option<InFlightPermit> {
    let mut counts = state.lock().ok()?;
    let per_uid = counts.by_uid.get(&uid).copied().unwrap_or(0);
    if counts.total >= MAX_TOTAL_IN_FLIGHT || per_uid >= MAX_PER_UID_IN_FLIGHT {
        return None;
    }
    let now = Instant::now();
    let recent = counts.recent_by_uid.entry(uid).or_default();
    while recent
        .front()
        .is_some_and(|accepted| now.duration_since(*accepted) >= PER_UID_RATE_WINDOW)
    {
        recent.pop_front();
    }
    if recent.len() >= MAX_PER_UID_PER_WINDOW {
        return None;
    }
    recent.push_back(now);
    counts.total += 1;
    counts.by_uid.insert(uid, per_uid + 1);
    Some(InFlightPermit {
        uid,
        state: Arc::clone(state),
    })
}

#[cfg(target_os = "linux")]
struct IngressConnection {
    stream: UnixStream,
    _permit: InFlightPermit,
}

#[cfg(target_os = "linux")]
struct MutationRequest {
    payload: Vec<u8>,
    response: mpsc::SyncSender<Result<Vec<u8>, V5AdmissionHostErrorV1>>,
}

#[cfg(target_os = "linux")]
fn connected_peer_uid(stream: &UnixStream) -> Result<u32, V5AdmissionHostErrorV1> {
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
        return Err(V5AdmissionHostErrorV1::Connection);
    }
    let credentials = unsafe { credentials.assume_init() };
    if credentials.pid <= 0 {
        return Err(V5AdmissionHostErrorV1::Connection);
    }
    Ok(credentials.uid)
}

#[cfg(target_os = "linux")]
fn run_ingress_worker(
    ingress: Arc<Mutex<mpsc::Receiver<IngressConnection>>>,
    mutation: mpsc::SyncSender<MutationRequest>,
    policy: BrokerHostConfinementPolicyV1,
    attestation: BrokerHostConfinementAttestationV1,
) {
    loop {
        let connection = match ingress
            .lock()
            .ok()
            .and_then(|receiver| receiver.recv().ok())
        {
            Some(connection) => connection,
            None => return,
        };
        let IngressConnection {
            mut stream,
            _permit,
        } = connection;
        let Ok(payload) =
            read_authenticated_v5_dispatch_admission_frame(&policy, &attestation, &mut stream)
        else {
            continue;
        };
        let (response_tx, response_rx) = mpsc::sync_channel(1);
        if mutation
            .try_send(MutationRequest {
                payload,
                response: response_tx,
            })
            .is_err()
        {
            continue;
        }
        let Ok(Ok(frame)) = response_rx.recv_timeout(MUTATION_RESPONSE_TIMEOUT) else {
            continue;
        };
        let _ = write_authenticated_response(&policy, &attestation, &mut stream, &frame);
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
    let policy = host.policy.clone();
    let attestation = host.attestation.clone();
    let (mutation_tx, mutation_rx) = mpsc::sync_channel::<MutationRequest>(MAX_TOTAL_IN_FLIGHT);
    std::thread::Builder::new()
        .name("bp-v5-admission-mutation".into())
        .spawn(move || {
            while let Ok(request) = mutation_rx.recv() {
                let result = host.mutate_and_encode_response(&request.payload);
                let _ = request.response.send(result);
            }
        })
        .map_err(|_| V5AdmissionHostErrorV1::Startup)?;
    let (ingress_tx, ingress_rx) = mpsc::sync_channel::<IngressConnection>(MAX_TOTAL_IN_FLIGHT);
    let ingress_rx = Arc::new(Mutex::new(ingress_rx));
    for index in 0..INGRESS_WORKER_COUNT {
        let receiver = Arc::clone(&ingress_rx);
        let mutation = mutation_tx.clone();
        let worker_policy = policy.clone();
        let worker_attestation = attestation.clone();
        std::thread::Builder::new()
            .name(format!("bp-v5-admission-ingress-{index}"))
            .spawn(move || {
                run_ingress_worker(receiver, mutation, worker_policy, worker_attestation)
            })
            .map_err(|_| V5AdmissionHostErrorV1::Startup)?;
    }
    let in_flight = Arc::new(Mutex::new(InFlightState::default()));
    loop {
        let (stream, _) = listener
            .accept()
            .map_err(|_| V5AdmissionHostErrorV1::Accept)?;
        if policy
            .verify_linux_connected_worker_for_role(
                BrokerAuthorityRoleV1::DispatchAdmission,
                &attestation,
                &stream,
            )
            .is_err()
        {
            continue;
        }
        let Ok(uid) = connected_peer_uid(&stream) else {
            continue;
        };
        let Some(permit) = try_acquire_in_flight(&in_flight, uid) else {
            continue;
        };
        let _ = ingress_tx.try_send(IngressConnection {
            stream,
            _permit: permit,
        });
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
    fn protected_v5_host_state_can_move_to_one_dedicated_mutation_thread() {
        fn assert_send<T: Send>() {}
        assert_send::<V5AdmissionHostV1>();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn ingress_limits_enforce_per_uid_and_total_caps_and_release_on_drop() {
        let state = Arc::new(Mutex::new(InFlightState::default()));
        let first = try_acquire_in_flight(&state, 1001).expect("first UID permit");
        let second = try_acquire_in_flight(&state, 1001).expect("second UID permit");
        assert!(try_acquire_in_flight(&state, 1001).is_none());
        let mut other = Vec::new();
        for uid in 1002..1008 {
            other.push(try_acquire_in_flight(&state, uid).expect("total permit"));
        }
        assert!(try_acquire_in_flight(&state, 2000).is_none());
        drop(first);
        assert!(try_acquire_in_flight(&state, 1001).is_some());
        drop(second);
        drop(other);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn bounded_fixed_worker_pool_allows_a_second_connection_past_a_stalled_first() {
        use std::io::Read;
        use std::net::Shutdown;

        let (task_tx, task_rx) = mpsc::sync_channel::<UnixStream>(2);
        let task_rx = Arc::new(Mutex::new(task_rx));
        let (completed_tx, completed_rx) = mpsc::sync_channel(2);
        let mut workers = Vec::new();
        for _ in 0..2 {
            let tasks = Arc::clone(&task_rx);
            let completed = completed_tx.clone();
            workers.push(std::thread::spawn(move || {
                let mut stream = tasks.lock().expect("task receiver").recv().expect("task");
                let mut byte = [0_u8; 1];
                if stream.read_exact(&mut byte).is_ok() {
                    let _ = completed.send(byte[0]);
                }
            }));
        }
        let (stalled_server, stalled_client) = UnixStream::pair().expect("stalled pair");
        let (valid_server, mut valid_client) = UnixStream::pair().expect("valid pair");
        task_tx.send(stalled_server).expect("queue stalled");
        task_tx.send(valid_server).expect("queue valid");
        valid_client.write_all(b"x").expect("valid request byte");
        valid_client.shutdown(Shutdown::Write).expect("valid EOF");

        assert_eq!(
            completed_rx
                .recv_timeout(Duration::from_millis(250))
                .expect("second connection must reach a worker"),
            b'x'
        );
        drop(stalled_client);
        drop(task_tx);
        for worker in workers {
            worker.join().expect("bounded worker");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn full_ingress_queue_rejects_without_leaking_total_or_per_uid_permits() {
        let state = Arc::new(Mutex::new(InFlightState::default()));
        let (queue_tx, queue_rx) = mpsc::sync_channel::<IngressConnection>(1);
        let (first, _first_peer) = UnixStream::pair().expect("first pair");
        let first_permit = try_acquire_in_flight(&state, 1001).expect("first permit");
        queue_tx
            .try_send(IngressConnection {
                stream: first,
                _permit: first_permit,
            })
            .expect("fill ingress queue");

        let (second, _second_peer) = UnixStream::pair().expect("second pair");
        let second_permit = try_acquire_in_flight(&state, 1001).expect("second permit");
        assert!(matches!(
            queue_tx.try_send(IngressConnection {
                stream: second,
                _permit: second_permit,
            }),
            Err(mpsc::TrySendError::Full(_))
        ));
        assert_eq!(state.lock().expect("counts").total, 1);
        assert_eq!(
            state.lock().expect("counts").by_uid.get(&1001).copied(),
            Some(1)
        );
        drop(queue_rx);
        assert_eq!(state.lock().expect("released queue permit").total, 0);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn ingress_rate_limit_rejects_a_uid_after_its_fixed_window_budget() {
        let state = Arc::new(Mutex::new(InFlightState::default()));
        for _ in 0..MAX_PER_UID_PER_WINDOW {
            drop(try_acquire_in_flight(&state, 1001).expect("rate-window permit"));
        }
        assert!(try_acquire_in_flight(&state, 1001).is_none());
        assert!(try_acquire_in_flight(&state, 1002).is_some());
    }

    #[test]
    fn production_endpoint_paths_are_fixed_and_role_specific() {
        assert_eq!(
            V5_ADMISSION_SOCKET_PATH,
            "/run/buildplane/authority-host/v5-dispatch-admission-v1.sock"
        );
        assert_eq!(V5_ADMISSION_LISTENER_FD, 3);
    }
}
