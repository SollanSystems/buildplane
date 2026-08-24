//! Contract coverage for the protected plan-admission host.
//!
//! The end-to-end test at the bottom is the point of the slice: an
//! authenticated peer hands the host sealed plan bytes over the socket, the
//! host stages them into its own CAS, mints and seals a `plan_admitted` against
//! a real store, and the external verifier accepts the exported tape. Nothing
//! in that path is a fixture except the plan text itself.

use crate::confinement::{BrokerAuthorityRoleV1, BrokerHostConfinementPolicyV1};
use crate::plan_admission_handler::{
    read_authenticated_plan_admission_ingress_detailed, PlanAdmissionIngressRefusal,
};
use crate::plan_admission_host::{
    resolve_operator_identity_for_peer, serve_one_authenticated_plan_admission,
    OperationalDiagnosticV1, LISTENER_PARENT_COMPONENTS, LISTENER_SOCKET_FILE_NAME,
    PLAN_ADMISSION_LISTENER_FD, PLAN_ADMISSION_SOCKET_PATH,
};
use crate::plan_admission_host_config::{
    parse_plan_admission_host_config_v1, PlanAdmissionHostConfigV1,
};
use crate::plan_admission_response::{
    verify_plan_admission_response, PlanAdmissionResponseBindingV1, PlanAdmissionResponseStatusV1,
};
use crate::promotion_decision_host::validate_listener_path_from_anchor;
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::run_lifecycle::RunStartedV1;
use bp_ledger::payload::Payload;
use bp_ledger::signing::{public_key_hash, ActorKeyRef};
use bp_ledger::storage::cas::Cas;
use bp_ledger::storage::sqlite::SqliteStore;
use bp_ledger::tape_export::export_signed_tape;
use chrono::Utc;
use ed25519_dalek::SigningKey;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use tempfile::TempDir;
use uuid::Uuid;

const MFD_CLOEXEC: libc::c_uint = 0x0001;
const MFD_ALLOW_SEALING: libc::c_uint = 0x0002;
const REQUIRED_CONTENT_SEALS: libc::c_int =
    libc::F_SEAL_WRITE | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_SEAL;

const KERNEL_SEED: [u8; 32] = [83u8; 32];
const RUN_UUID: &str = "01919000-0000-7000-8000-00000000cd01";
const OTHER_RUN_UUID: &str = "01919000-0000-7000-8000-00000000cd09";
const RUN_STARTED_EVENT_UUID: &str = "01919000-0000-7000-8000-00000000cd02";
const SECOND_RUN_STARTED_EVENT_UUID: &str = "01919000-0000-7000-8000-00000000cd08";
const REQUEST_UUID: &str = "01919000-0000-7000-8000-00000000cd03";
const OPERATOR_IDENTITY: &str = "operator:release-engineer";
const DECOY_IDENTITY: &str = "operator:decoy";

fn current_uid() -> u32 {
    unsafe { libc::geteuid() }
}

fn current_gid() -> u32 {
    unsafe { libc::getegid() }
}

fn kernel_key() -> SigningKey {
    SigningKey::from_bytes(&KERNEL_SEED)
}

fn kernel_signer() -> ActorKeyRef {
    ActorKeyRef {
        actor_id: "kernel".into(),
        key_id: "kernel-main".into(),
        public_key_hash: Some(public_key_hash(&kernel_key().verifying_key())),
    }
}

fn run_id() -> RunId {
    RunId::from_uuid(Uuid::parse_str(RUN_UUID).unwrap())
}

fn trusted_base() -> String {
    "c".repeat(40)
}

fn plan_bytes() -> Vec<u8> {
    b"## Title\nAuthenticated ingress\n\n## Goal\nMint through the socket.\n".to_vec()
}

fn content_ref() -> String {
    format!("cas://sha256:{:x}", Sha256::digest(plan_bytes()))
}

fn host_config(authority_root: &Path) -> PlanAdmissionHostConfigV1 {
    host_config_with_clients(
        authority_root,
        json!([{ "uid": current_uid(), "decided_by": OPERATOR_IDENTITY }]),
    )
}

/// A config whose *lowest* configured client UID is not this process.
///
/// The identity map is ordered, so a host that indexed the configured client
/// list instead of using the authenticated UID would record `DECOY_IDENTITY`
/// here while still passing every single-client test.
fn host_config_with_a_lower_decoy_client(authority_root: &Path) -> PlanAdmissionHostConfigV1 {
    host_config_with_clients(
        authority_root,
        json!([
            { "uid": current_uid().checked_sub(1).unwrap(), "decided_by": DECOY_IDENTITY },
            { "uid": current_uid(), "decided_by": OPERATOR_IDENTITY },
        ]),
    )
}

fn host_config_with_clients(
    authority_root: &Path,
    clients: serde_json::Value,
) -> PlanAdmissionHostConfigV1 {
    let config = json!({
        "schema_version": 1,
        "run_id": RUN_UUID,
        // A broker identity distinct from this process, so a same-process peer
        // is a configured *client* rather than the broker itself.
        "broker_uid": current_uid().checked_add(1).unwrap(),
        "plan_admission_clients": clients,
        "socket_group_gid": current_gid(),
        "authority_root": authority_root.to_string_lossy(),
        "authority_realm_digest": format!("sha256:{}", "ab".repeat(32)),
        "kernel": {
            "actor_id": "kernel",
            "key_id": "kernel-main",
            "public_key": kernel_key().verifying_key().to_bytes().to_vec(),
        },
    });
    parse_plan_admission_host_config_v1(&config.to_string()).expect("valid host config")
}

/// How the run's start event reaches the protected tape.
///
/// The resolver treats the run start as an *attestation*, so every way that
/// attestation can be absent or unconvincing is a distinct refusal path. These
/// exist to drive the production resolver, not S2's injected fake.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RunStart {
    KernelSigned,
    Absent,
    Unsigned,
    /// Signed by a key that is not among the realm's pinned trusted keys, so it
    /// reads back as unverified rather than as a different signer.
    UntrustedKey,
    /// Signed by the trusted kernel *key* but under a different actor/key
    /// identity. Verification succeeds; only the signer comparison refuses it.
    MismatchedSignerIdentity,
    Duplicated,
}

fn stranger_key() -> SigningKey {
    SigningKey::from_bytes(&[84u8; 32])
}

fn run_started_event(event_uuid: &str, git_head: &str) -> Event {
    Event {
        id: EventId::from_uuid(Uuid::parse_str(event_uuid).unwrap()),
        run_id: run_id(),
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::RunStarted,
        occurred_at: Utc::now(),
        payload: Payload::RunStartedV1(RunStartedV1 {
            packet_hash: "sha256:aa".into(),
            git_head: git_head.to_string(),
            workspace_path: "/ws".into(),
            config: BTreeMap::new(),
            parent_run_id: None,
            parent_event_id: None,
        }),
    }
}

fn seed_run_start(store: &SqliteStore, variant: RunStart, git_head: &str) {
    let event = run_started_event(RUN_STARTED_EVENT_UUID, git_head);
    match variant {
        RunStart::Absent => {}
        RunStart::KernelSigned => {
            store
                .append_signed(&event, &kernel_key(), &kernel_signer())
                .expect("the protected tape records a kernel-signed run start");
        }
        RunStart::Unsigned => {
            store.append(&event).expect("an unsigned run start lands");
        }
        RunStart::UntrustedKey => {
            let signer = ActorKeyRef {
                actor_id: "kernel".into(),
                key_id: "kernel-main".into(),
                public_key_hash: Some(public_key_hash(&stranger_key().verifying_key())),
            };
            store
                .append_signed(&event, &stranger_key(), &signer)
                .expect("a run start signed by an unpinned key lands");
        }
        RunStart::MismatchedSignerIdentity => {
            let signer = ActorKeyRef {
                actor_id: "operator:impostor".into(),
                key_id: "kernel-main".into(),
                public_key_hash: Some(public_key_hash(&kernel_key().verifying_key())),
            };
            store
                .append_signed(&event, &kernel_key(), &signer)
                .expect("a run start under another identity lands");
        }
        RunStart::Duplicated => {
            store
                .append_signed(&event, &kernel_key(), &kernel_signer())
                .expect("the first run start lands");
            let second = run_started_event(SECOND_RUN_STARTED_EVENT_UUID, "d".repeat(40).as_str());
            store
                .append_signed(&second, &kernel_key(), &kernel_signer())
                .expect("a second run start lands");
        }
    }
}

fn sealed_memfd(bytes: &[u8]) -> OwnedFd {
    let name = std::ffi::CString::new("bp-plan-admission-host-test").unwrap();
    let raw = unsafe { libc::memfd_create(name.as_ptr(), MFD_CLOEXEC | MFD_ALLOW_SEALING) };
    assert!(raw >= 0);
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    let written = unsafe { libc::pwrite(fd.as_raw_fd(), bytes.as_ptr().cast(), bytes.len(), 0) };
    assert_eq!(written, bytes.len() as isize);
    assert_eq!(
        unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_ADD_SEALS, REQUIRED_CONTENT_SEALS) },
        0
    );
    fd
}

fn send_with_descriptors(stream: &UnixStream, bytes: &[u8], descriptors: &[RawFd]) {
    let mut iov = libc::iovec {
        iov_base: bytes.as_ptr() as *mut libc::c_void,
        iov_len: bytes.len(),
    };
    let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
    message.msg_iov = std::ptr::addr_of_mut!(iov);
    message.msg_iovlen = 1;
    let control_bytes = unsafe {
        libc::CMSG_SPACE((descriptors.len() * std::mem::size_of::<libc::c_int>()) as u32)
    } as usize;
    let mut control = vec![0_u64; control_bytes.div_ceil(8).max(1)];
    if !descriptors.is_empty() {
        message.msg_control = control.as_mut_ptr().cast();
        message.msg_controllen = control_bytes;
        let header = unsafe { libc::CMSG_FIRSTHDR(&message) };
        assert!(!header.is_null());
        unsafe {
            (*header).cmsg_level = libc::SOL_SOCKET;
            (*header).cmsg_type = libc::SCM_RIGHTS;
            (*header).cmsg_len =
                libc::CMSG_LEN((descriptors.len() * std::mem::size_of::<libc::c_int>()) as u32)
                    as usize;
            std::ptr::copy_nonoverlapping(
                descriptors.as_ptr(),
                libc::CMSG_DATA(header).cast::<libc::c_int>(),
                descriptors.len(),
            );
        }
    }
    let sent = unsafe { libc::sendmsg(stream.as_raw_fd(), &message, 0) };
    assert_eq!(sent, bytes.len() as isize);
}

fn send_request(stream: &UnixStream, frame: &str, descriptor: Option<RawFd>) {
    let header = (frame.len() as u32).to_be_bytes();
    send_with_descriptors(stream, &header, descriptor.as_slice());
    send_with_descriptors(stream, frame.as_bytes(), &[]);
}

fn request_frame(run_uuid: &str) -> String {
    custom_request_frame(run_uuid, &content_ref(), "PASS")
}

fn custom_request_frame(run_uuid: &str, plan_content_ref: &str, validation_status: &str) -> String {
    json!({
        "schema_version": 1,
        "request_id": REQUEST_UUID,
        "run_id": run_uuid,
        "plan_content_ref": plan_content_ref,
        "asserted": {
            "validation_status": validation_status,
            "plan_digest": format!("sha256:{}", "cd".repeat(32)),
            "idempotency_key": "planforge:v0:buildplane:cccccccc:abcd1234",
        },
    })
    .to_string()
}

fn read_response(stream: &mut UnixStream) -> Vec<u8> {
    let mut length = [0_u8; 4];
    stream.read_exact(&mut length).expect("a response header");
    let mut payload = vec![0_u8; u32::from_be_bytes(length) as usize];
    stream.read_exact(&mut payload).expect("a response payload");
    payload
}

struct HostFixture {
    _root: TempDir,
    authority_root: PathBuf,
    database_path: PathBuf,
    keyring_root: PathBuf,
    store: SqliteStore,
    cas: Cas,
    config: PlanAdmissionHostConfigV1,
}

impl HostFixture {
    fn new() -> Self {
        Self::with_run_start(RunStart::KernelSigned)
    }

    /// The same fixture, but configured with a lower-UID decoy client so the
    /// recorded identity discriminates between "the peer that connected" and
    /// "the first client in the config".
    fn with_a_lower_decoy_client() -> Self {
        let mut fixture = Self::with_run_start(RunStart::KernelSigned);
        fixture.config = host_config_with_a_lower_decoy_client(&fixture.authority_root);
        fixture
    }

    fn with_run_start(variant: RunStart) -> Self {
        let root = TempDir::new().unwrap();
        let authority_root = root.path().join("authority");
        fs::create_dir(&authority_root).unwrap();
        let database_path = root.path().join("events.db");
        let store = SqliteStore::open(&database_path).unwrap();
        seed_run_start(&store, variant, &trusted_base());
        let cas = Cas::open(root.path().join("cas")).unwrap();
        let keyring_root = root.path().join("keys");
        fs::create_dir_all(keyring_root.join("kernel")).unwrap();
        fs::write(
            keyring_root.join("kernel").join("kernel-main.ed25519"),
            KERNEL_SEED,
        )
        .unwrap();
        let config = host_config(&authority_root);
        Self {
            _root: root,
            authority_root,
            database_path,
            keyring_root,
            store,
            cas,
            config,
        }
    }

    fn policy(&self) -> BrokerHostConfinementPolicyV1 {
        BrokerHostConfinementPolicyV1::new_for_role(
            self.config.broker_uid,
            BrokerAuthorityRoleV1::PlanAdmission,
            self.config.plan_admission_client_uids(),
        )
        .expect("the config's client policy is a valid confinement policy")
    }

    fn cas_is_empty(&self) -> bool {
        self.cas
            .get_bytes(&format!("sha256:{:x}", Sha256::digest(plan_bytes())))
            .is_err()
    }

    fn plan_admitted_event_count(&self) -> usize {
        self.store
            .events_for_run(RUN_UUID)
            .unwrap()
            .into_iter()
            .filter(|row| row.kind == "plan_admitted")
            .count()
    }

    fn projection_is_empty(&self) -> bool {
        let connection = rusqlite::Connection::open(&self.database_path).unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM plan_admissions", [], |row| row.get(0))
            .unwrap();
        count == 0
    }

    /// Drive one complete authenticated request and return the signed status
    /// the peer receives.
    fn mint_and_read_status(&self) -> PlanAdmissionResponseStatusV1 {
        let (mut client, mut server) = UnixStream::pair().unwrap();
        let object = sealed_memfd(&plan_bytes());
        send_request(&client, &request_frame(RUN_UUID), Some(object.as_raw_fd()));
        drop(object);
        self.serve_once(&mut server)
            .expect("a well-formed authenticated request always receives a signed answer");
        let response = read_response(&mut client);
        let expected_content_ref = content_ref();
        let binding =
            PlanAdmissionResponseBindingV1::new(RUN_UUID, REQUEST_UUID, &expected_content_ref)
                .unwrap();
        verify_plan_admission_response(&response, &kernel_key().verifying_key(), binding)
            .expect("the host signs every answer it gives")
            .0
    }

    fn serve_once(&self, stream: &mut UnixStream) -> Result<(), impl std::fmt::Debug> {
        let policy = self.policy();
        let attestation = policy.attestation_for_same_process_socket_tests();
        serve_one_authenticated_plan_admission(
            &policy,
            &attestation,
            stream,
            &self.config,
            &self.store,
            &self.database_path,
            &self.cas,
            &kernel_key(),
        )
    }
}

#[test]
fn the_socket_deliverable_is_the_named_path_on_the_inherited_listener() {
    assert_eq!(
        PLAN_ADMISSION_SOCKET_PATH,
        "/run/buildplane/authority-host/plan-admission-v1.sock"
    );
    assert_eq!(PLAN_ADMISSION_LISTENER_FD, 3);
    assert_eq!(LISTENER_SOCKET_FILE_NAME, b"plan-admission-v1.sock");
    // The validated components and the constant path must be the same place.
    let rebuilt = LISTENER_PARENT_COMPONENTS
        .iter()
        .map(|component| String::from_utf8(component.to_vec()).unwrap())
        .collect::<Vec<_>>()
        .join("/");
    assert_eq!(
        format!(
            "/{rebuilt}/{}",
            std::str::from_utf8(LISTENER_SOCKET_FILE_NAME).unwrap()
        ),
        PLAN_ADMISSION_SOCKET_PATH
    );
}

/// The plan-admission endpoint reuses the promotion-decision listener validator
/// rather than copying it, so "matches the precedent" is a property of shared
/// code. These cases pin the policy that shared validator enforces.
#[test]
fn the_listener_path_policy_is_the_promotion_decision_policy() {
    struct Layout {
        _root: TempDir,
        anchor: std::fs::File,
        socket_path: PathBuf,
        parent: PathBuf,
        _listener: UnixListener,
    }

    fn layout() -> Layout {
        let root = TempDir::new().unwrap();
        let mut parent = root.path().to_path_buf();
        for component in LISTENER_PARENT_COMPONENTS {
            parent = parent.join(std::str::from_utf8(component).unwrap());
            fs::create_dir(&parent).unwrap();
            fs::set_permissions(&parent, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let socket_path = parent.join(std::str::from_utf8(LISTENER_SOCKET_FILE_NAME).unwrap());
        let listener = UnixListener::bind(&socket_path).unwrap();
        fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o660)).unwrap();
        let anchor = std::fs::File::open(root.path()).unwrap();
        Layout {
            _root: root,
            anchor,
            socket_path,
            parent,
            _listener: listener,
        }
    }

    fn validate(layout: &Layout, expected_group: u32) -> bool {
        validate_listener_path_from_anchor(
            layout.anchor.as_raw_fd(),
            &LISTENER_PARENT_COMPONENTS,
            LISTENER_SOCKET_FILE_NAME,
            current_uid(),
            expected_group,
        )
        .is_ok()
    }

    let good = layout();
    assert!(
        validate(&good, current_gid()),
        "a 0755 parent chain and a 0660 single-link socket in the deployment group is the policy"
    );

    let wrong_group = layout();
    assert!(
        !validate(&wrong_group, current_gid().wrapping_add(1)),
        "a socket outside the configured deployment group must be refused"
    );

    for mode in [0o600, 0o666, 0o770, 0o777] {
        let wrong_socket_mode = layout();
        fs::set_permissions(
            &wrong_socket_mode.socket_path,
            fs::Permissions::from_mode(mode),
        )
        .unwrap();
        assert!(
            !validate(&wrong_socket_mode, current_gid()),
            "socket mode {mode:o} must be refused; only 0660 is the precedent"
        );
    }

    for mode in [0o700, 0o775, 0o777] {
        let wrong_parent_mode = layout();
        fs::set_permissions(&wrong_parent_mode.parent, fs::Permissions::from_mode(mode)).unwrap();
        assert!(
            !validate(&wrong_parent_mode, current_gid()),
            "parent mode {mode:o} must be refused; only 0755 is the precedent"
        );
        fs::set_permissions(&wrong_parent_mode.parent, fs::Permissions::from_mode(0o755)).unwrap();
    }

    let not_a_socket = layout();
    fs::remove_file(&not_a_socket.socket_path).unwrap();
    fs::write(&not_a_socket.socket_path, b"not a socket").unwrap();
    fs::set_permissions(&not_a_socket.socket_path, fs::Permissions::from_mode(0o660)).unwrap();
    assert!(
        !validate(&not_a_socket, current_gid()),
        "a regular file at the socket path must be refused"
    );

    let symlinked = layout();
    let elsewhere = symlinked.parent.join("elsewhere.sock");
    let _elsewhere_listener = UnixListener::bind(&elsewhere).unwrap();
    fs::remove_file(&symlinked.socket_path).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &symlinked.socket_path).unwrap();
    assert!(
        !validate(&symlinked, current_gid()),
        "a symlink at the socket path must be refused without being followed"
    );
}

/// Pins the three operational strings, including the one only the non-Linux
/// runner emits. It does not — and on a Linux runner cannot — exercise the
/// non-Linux path itself; the enum is constructible under `cfg(test)`
/// everywhere precisely so the text stays pinned by a test that can run.
#[test]
fn the_operational_diagnostic_vocabulary_is_the_three_named_classes() {
    assert_eq!(
        OperationalDiagnosticV1::UnsupportedPlatform.as_str(),
        "unsupported_platform"
    );
    assert_eq!(
        OperationalDiagnosticV1::StartupFailed.as_str(),
        "startup_failed"
    );
    assert_eq!(
        OperationalDiagnosticV1::AcceptFailed.as_str(),
        "accept_failed"
    );
}

#[test]
fn decided_by_is_looked_up_from_the_authenticated_uid_and_never_fabricated() {
    let fixture = HostFixture::new();

    let resolved = resolve_operator_identity_for_peer(&fixture.config, current_uid())
        .expect("the configured client uid resolves its operator identity");
    assert_eq!(
        resolved,
        crate::plan_admission::ResolvedOperatorIdentity::from_authenticated_peer(
            OPERATOR_IDENTITY.to_string()
        )
    );

    for unmapped in [current_uid() + 1, current_uid() + 2, 65_534] {
        assert!(
            resolve_operator_identity_for_peer(&fixture.config, unmapped).is_err(),
            "uid {unmapped} has no configured operator identity and must not get one"
        );
    }
}

#[test]
fn a_request_cannot_name_the_operator_it_wishes_to_be_recorded_as() {
    let fixture = HostFixture::new();
    let policy = fixture.policy();
    let attestation = policy.attestation_for_same_process_socket_tests();
    let (client, mut server) = UnixStream::pair().unwrap();
    let mut widened: serde_json::Value = serde_json::from_str(&request_frame(RUN_UUID)).unwrap();
    widened["decided_by"] = json!("operator:someone-else");
    let object = sealed_memfd(&plan_bytes());
    send_request(&client, &widened.to_string(), Some(object.as_raw_fd()));
    drop(object);
    drop(client);

    assert_eq!(
        read_authenticated_plan_admission_ingress_detailed(&policy, &attestation, &mut server),
        Err(PlanAdmissionIngressRefusal::RequestNotClosed),
        "the closed request shape has no field for a caller-chosen identity"
    );
}

#[test]
fn a_request_for_another_run_is_refused_by_the_run_bound_endpoint() {
    let fixture = HostFixture::new();
    let (client, mut server) = UnixStream::pair().unwrap();
    let object = sealed_memfd(&plan_bytes());
    send_request(
        &client,
        &request_frame(OTHER_RUN_UUID),
        Some(object.as_raw_fd()),
    );
    drop(object);

    assert!(
        fixture.serve_once(&mut server).is_err(),
        "this endpoint serves exactly the run its deployment config names"
    );
    assert_eq!(
        fixture.store.events_for_run(OTHER_RUN_UUID).unwrap().len(),
        0,
        "a refused run must leave no trace on the tape"
    );
}

/// The CAS is the mint's trust root and shares a filesystem with the ledger.
/// Staging bytes the request has already disqualified turns any authenticated
/// peer into a write amplifier: 1 MiB per connection, on a loop that never
/// ends, for content that can never become an admission.
#[test]
fn a_request_whose_bytes_do_not_hash_to_its_named_reference_stages_nothing() {
    let fixture = HostFixture::new();
    let (client, mut server) = UnixStream::pair().unwrap();
    let object = sealed_memfd(&plan_bytes());
    let wrong_ref = format!("cas://sha256:{}", "ab".repeat(32));
    send_request(
        &client,
        &custom_request_frame(RUN_UUID, &wrong_ref, "PASS"),
        Some(object.as_raw_fd()),
    );
    drop(object);

    assert!(fixture.serve_once(&mut server).is_err());
    assert!(
        fixture.cas_is_empty(),
        "bytes that cannot become an admission must never reach the trust-root CAS"
    );
    assert!(fixture.projection_is_empty());
}

/// The asserted-PASS precondition is fail-closed input hygiene, so it must gate
/// the stage too — otherwise a peer sidesteps it by simply asserting FAIL.
#[test]
fn a_request_without_an_asserted_pass_stages_nothing() {
    for status in ["FAIL", "pass", "", "WARN"] {
        let fixture = HostFixture::new();
        let (client, mut server) = UnixStream::pair().unwrap();
        let object = sealed_memfd(&plan_bytes());
        send_request(
            &client,
            &custom_request_frame(RUN_UUID, &content_ref(), status),
            Some(object.as_raw_fd()),
        );
        drop(object);

        assert!(
            fixture.serve_once(&mut server).is_err(),
            "{status:?} is not an asserted PASS"
        );
        assert!(
            fixture.cas_is_empty(),
            "{status:?} must be refused before anything is staged"
        );
        assert!(fixture.projection_is_empty());
    }
}

/// Every way the run-start attestation can fail to convince, driven through the
/// **production** resolver rather than S2's injected fake.
///
/// The signer-identity case is the one that matters most: it is the only case
/// that survives deleting the actor/key comparison, because a run start signed
/// by the trusted kernel *key* under any other identity still verifies.
#[test]
fn an_unconvincing_run_start_attestation_yields_reconciliation_and_mints_nothing() {
    for variant in [
        RunStart::Absent,
        RunStart::Unsigned,
        RunStart::UntrustedKey,
        RunStart::MismatchedSignerIdentity,
        RunStart::Duplicated,
    ] {
        let fixture = HostFixture::with_run_start(variant);
        assert_eq!(
            fixture.mint_and_read_status(),
            PlanAdmissionResponseStatusV1::ReconciliationRequired,
            "{variant:?} must not become a trusted base"
        );
        assert!(
            fixture.projection_is_empty(),
            "{variant:?} must mint no admission"
        );
        assert_eq!(
            fixture.plan_admitted_event_count(),
            0,
            "{variant:?} must leave no plan_admitted on the tape"
        );
    }
}

/// The positive control for the case above: the same fixture with a convincing
/// attestation does seal, so the refusals are about the attestation and not
/// about the harness.
#[test]
fn a_kernel_signed_run_start_is_the_only_attestation_that_mints() {
    let fixture = HostFixture::with_run_start(RunStart::KernelSigned);
    assert_eq!(
        fixture.mint_and_read_status(),
        PlanAdmissionResponseStatusV1::Sealed
    );
    assert!(!fixture.projection_is_empty());
}

/// `decided_by` must be a fact about *this connection*, not about the config.
///
/// This is the test that fails if the host ever reads the operator identity
/// from the configured client list rather than from the SO_PEERCRED UID: the
/// decoy sorts first, so an index-based lookup records the wrong operator on a
/// tape event that is then kernel-signed.
#[test]
fn the_recorded_operator_is_the_one_the_peer_authenticated_as() {
    let fixture = HostFixture::with_a_lower_decoy_client();
    assert_eq!(
        fixture.config.plan_admission_client_uids().first().copied(),
        Some(current_uid() - 1),
        "the decoy must sort ahead of this process, or the test proves nothing"
    );

    assert_eq!(
        fixture.mint_and_read_status(),
        PlanAdmissionResponseStatusV1::Sealed
    );

    let connection = rusqlite::Connection::open(&fixture.database_path).unwrap();
    let decided_by: String = connection
        .query_row("SELECT decided_by FROM plan_admissions", [], |row| {
            row.get(0)
        })
        .expect("the mint wrote its projection row");
    assert_eq!(decided_by, OPERATOR_IDENTITY);
    assert_ne!(decided_by, DECOY_IDENTITY);
}

#[test]
fn an_authenticated_mint_seals_a_plan_admission_and_verifies_under_the_external_verifier() {
    let fixture = HostFixture::new();
    let (mut client, mut server) = UnixStream::pair().unwrap();
    let object = sealed_memfd(&plan_bytes());
    send_request(&client, &request_frame(RUN_UUID), Some(object.as_raw_fd()));
    drop(object);

    fixture
        .serve_once(&mut server)
        .expect("the authenticated request mints and seals");

    // 1. The peer receives a signed, request-bound, sealed disposition.
    let response = read_response(&mut client);
    let expected_content_ref = content_ref();
    let binding =
        PlanAdmissionResponseBindingV1::new(RUN_UUID, REQUEST_UUID, &expected_content_ref).unwrap();
    let (status, admission_event_id) =
        verify_plan_admission_response(&response, &kernel_key().verifying_key(), binding)
            .expect("the response is signed by the host kernel key");
    assert_eq!(status, PlanAdmissionResponseStatusV1::Sealed);
    let admission_event_id = admission_event_id.expect("a sealed response names its admission");

    // 2. The mint recorded exactly what the *peer* was, not what it claimed.
    let connection = rusqlite::Connection::open(&fixture.database_path).unwrap();
    let (decided_by, recorded_base, input_digest): (String, String, String) = connection
        .query_row(
            "SELECT decided_by, trusted_base, input_digest FROM plan_admissions \
             WHERE admission_event_id = ?1",
            [&admission_event_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("the mint wrote its projection row");
    assert_eq!(decided_by, OPERATOR_IDENTITY);
    assert_eq!(
        recorded_base,
        trusted_base(),
        "the trusted base is re-derived from the run's own signed start"
    );
    assert_eq!(
        input_digest,
        format!("sha256:{:x}", Sha256::digest(plan_bytes())),
        "the recorded input digest is of the bytes the host itself hashed"
    );

    // 3. The projection reads `sealed` through the exact query the TypeScript
    //    admitted-plan reader issues.
    let state: String = connection
        .query_row(
            "SELECT state FROM plan_admissions WHERE admission_event_id = ?",
            [&admission_event_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "sealed");
    drop(connection);

    // 4. The bytes reached the broker-owned CAS, and only through the broker.
    assert_eq!(
        fixture
            .cas
            .get_bytes(&format!("sha256:{:x}", Sha256::digest(plan_bytes())))
            .expect("the host staged the sealed bytes it was handed"),
        plan_bytes()
    );

    // 5. The exported tape verifies externally.
    let fixture_dir = fixture.keyring_root.parent().unwrap().join("exported-tape");
    fs::create_dir_all(&fixture_dir).unwrap();
    let tape = export_signed_tape(&fixture.store, RUN_UUID, &fixture.keyring_root)
        .expect("the live run exports as a signed tape");
    fs::write(
        fixture_dir.join("tape.json"),
        serde_json::to_vec_pretty(&tape).unwrap(),
    )
    .unwrap();

    let verifier = repository_root().join("scripts/verify-signed-tape.mjs");
    assert!(verifier.is_file());
    let Some(node) = node_command() else {
        eprintln!(
            "SKIPPED the external-verifier half of \
             an_authenticated_mint_seals_a_plan_admission_and_verifies_under_the_external_verifier: \
             `node` is not on PATH. CI runs this test with node installed; a bare `cargo test` \
             outside CI skips only this assertion."
        );
        return;
    };
    let output = Command::new(node)
        .arg(&verifier)
        .arg("--fixture")
        .arg(&fixture_dir)
        .arg("--json")
        .output()
        .expect("the external verifier runs");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "verify-signed-tape.mjs must exit 0 over a tape the authenticated mint wrote.\n{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(report["ok"], true);
    assert_eq!(
        report["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["kind"] == "plan_admitted" && event["status"] == "verified")
            .count(),
        1,
        "the verifier reports the minted admission as verified: {stdout}"
    );
}

#[test]
fn an_unauthenticated_peer_causes_no_cas_write_and_no_tape_event() {
    let fixture = HostFixture::new();
    // A policy bound to a different endpoint refuses this connection for the
    // plan-admission role.
    let policy = BrokerHostConfinementPolicyV1::new_for_role(
        fixture.config.broker_uid,
        BrokerAuthorityRoleV1::PromotionDecision,
        fixture.config.plan_admission_client_uids(),
    )
    .unwrap();
    let attestation = policy.attestation_for_same_process_socket_tests();
    let (client, mut server) = UnixStream::pair().unwrap();
    let object = sealed_memfd(&plan_bytes());
    send_request(&client, &request_frame(RUN_UUID), Some(object.as_raw_fd()));
    drop(object);

    assert!(serve_one_authenticated_plan_admission(
        &policy,
        &attestation,
        &mut server,
        &fixture.config,
        &fixture.store,
        &fixture.database_path,
        &fixture.cas,
        &kernel_key(),
    )
    .is_err());

    assert!(
        fixture
            .cas
            .get_bytes(&format!("sha256:{:x}", Sha256::digest(plan_bytes())))
            .is_err(),
        "a refused peer must not cause a CAS write"
    );
    let kinds: Vec<String> = fixture
        .store
        .events_for_run(RUN_UUID)
        .unwrap()
        .into_iter()
        .map(|row| row.kind)
        .collect();
    assert_eq!(
        kinds,
        vec!["run_started".to_string()],
        "a refused peer must not cause a tape append"
    );
}

fn repository_root() -> PathBuf {
    // native/crates/bp-authority-broker -> native/crates -> native -> repo root
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("the crate is nested three levels below the repository root")
        .to_path_buf()
}

fn node_command() -> Option<&'static str> {
    Command::new("node")
        .arg("--version")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|_| "node")
}
