//! The protected plan-admission host: the authenticated ingress for the native
//! `plan_admitted` mint.
//!
//! It owns one socket, one role, one run, and one kernel signer. Deployment
//! inputs are compiled into this crate or loaded from the single protected
//! default config; the runner accepts no paths, descriptors, identities,
//! authority material, or environment overrides, and never exposes its private
//! startup or connection errors.
//!
//! **Standing constraint.** This slice lands the ingress and nothing that
//! drives it. Nothing in the production TypeScript control plane reaches this
//! socket, and the mint must not gain a transport-reachable consumer before the
//! approval arm learns to load, verify, and require checkpoint coverage of the
//! admission it names.

#[cfg(target_os = "linux")]
use crate::confinement::{
    BrokerAuthorityRoleV1, BrokerHostConfinementAttestationV1, BrokerHostConfinementPolicyV1,
};
#[cfg(target_os = "linux")]
use crate::host_cas_custody::{load_plan_admission_cas_v1, ProtectedV5CasV1};
#[cfg(target_os = "linux")]
use crate::host_config_loader::{
    load_default_plan_admission_host_config_v1, ValidatedPlanAdmissionHostStartupV1,
};
#[cfg(target_os = "linux")]
use crate::host_key_custody::load_plan_admission_signing_key_v1;
#[cfg(target_os = "linux")]
use crate::host_ledger_custody::{
    load_plan_admission_ledger_v1, ProtectedPromotionDecisionLedgerV1,
};
#[cfg(target_os = "linux")]
use crate::plan_admission::{
    BrokerPlanAdmissionAuthority, BrokerPlanAdmissionDisposition, LedgerPlanAdmissionBackend,
    LoadedPlanContent, PlanAdmissionIdentityError, PlanAdmissionIdentityResolver, PlanContentRefV1,
    PlanContentResolver, PlanContentResolverError, PlanRepositoryDescriptorError,
    PlanRepositoryDescriptorResolver, ResolvedOperatorIdentity, ResolvedRepositoryDescriptor,
    TrustedPlanAdmissionSnapshotVerifier,
};
#[cfg(target_os = "linux")]
use crate::plan_admission_handler::read_authenticated_plan_admission_ingress;
#[cfg(target_os = "linux")]
use crate::plan_admission_host_config::PlanAdmissionHostConfigV1;
#[cfg(target_os = "linux")]
use crate::plan_admission_response::{
    sign_plan_admission_response, PlanAdmissionResponseBindingV1, PlanAdmissionResponseStatusV1,
};
#[cfg(target_os = "linux")]
use crate::promotion_decision_host::{
    claim_and_validate_preopened_listener, validate_listener_path_from_anchor,
};

#[cfg(target_os = "linux")]
use bp_ledger::id::RunId;
#[cfg(target_os = "linux")]
use bp_ledger::kind::EventKind;
#[cfg(target_os = "linux")]
use bp_ledger::payload::Payload;
#[cfg(target_os = "linux")]
use bp_ledger::signing::{ActorKeyRef, TrustedPublicKeys, VerificationStatus};
#[cfg(target_os = "linux")]
use bp_ledger::storage::cas::{CanonicalCasRef, Cas};
#[cfg(target_os = "linux")]
use bp_ledger::storage::sqlite::SqliteStore;
#[cfg(target_os = "linux")]
use ed25519_dalek::SigningKey;
#[cfg(target_os = "linux")]
use std::fs::File;
#[cfg(target_os = "linux")]
use std::io::Write;
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(target_os = "linux")]
use std::os::unix::net::{UnixListener, UnixStream};
#[cfg(target_os = "linux")]
use std::path::Path;
use std::process::ExitCode;
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};
use thiserror::Error;

#[cfg(target_os = "linux")]
pub(crate) const PLAN_ADMISSION_LISTENER_FD: libc::c_int = 3;
#[cfg(target_os = "linux")]
pub(crate) const PLAN_ADMISSION_SOCKET_PATH: &str =
    "/run/buildplane/authority-host/plan-admission-v1.sock";
#[cfg(target_os = "linux")]
pub(crate) const LISTENER_PARENT_COMPONENTS: [&[u8]; 3] =
    [b"run", b"buildplane", b"authority-host"];
#[cfg(target_os = "linux")]
pub(crate) const LISTENER_SOCKET_FILE_NAME: &[u8] = b"plan-admission-v1.sock";
#[cfg(target_os = "linux")]
const MAX_PLAN_ADMISSION_RESPONSE_FRAME_BYTES: usize = 4 * 1024;
#[cfg(target_os = "linux")]
const PLAN_ADMISSION_RESPONSE_WRITE_TIMEOUT: Duration = Duration::from_secs(5);

/// Closed host failures. No variant renders a path, descriptor, signer,
/// storage, CAS, or reconciliation detail.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum ProtectedPlanAdmissionHostErrorV1 {
    #[error("protected plan-admission host startup failed")]
    StartupFailed,
    #[error("protected plan-admission host connection failed")]
    ConnectionFailed,
    #[error("protected plan-admission host accept failed")]
    AcceptFailed,
}

/// The only operational text this host ever emits. It names a class, never a
/// path, identity, or reason.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OperationalDiagnosticV1 {
    StartupFailed,
    AcceptFailed,
    /// Constructible under `cfg(test)` on every platform so the exact text the
    /// non-Linux runner emits stays pinned by a test that can actually run.
    #[cfg(any(test, not(target_os = "linux")))]
    UnsupportedPlatform,
}

impl OperationalDiagnosticV1 {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::StartupFailed => "startup_failed",
            Self::AcceptFailed => "accept_failed",
            #[cfg(any(test, not(target_os = "linux")))]
            Self::UnsupportedPlatform => "unsupported_platform",
        }
    }
}

/// Activate the sole production plan-admission authority endpoint.
pub fn run_default_plan_admission_host_v1() -> ExitCode {
    #[cfg(target_os = "linux")]
    {
        return match run_default_plan_admission_host_linux_v1() {
            Ok(()) => ExitCode::SUCCESS,
            Err(ProtectedPlanAdmissionHostErrorV1::AcceptFailed) => {
                eprintln!("{}", OperationalDiagnosticV1::AcceptFailed.as_str());
                ExitCode::FAILURE
            }
            Err(_) => {
                eprintln!("{}", OperationalDiagnosticV1::StartupFailed.as_str());
                ExitCode::FAILURE
            }
        };
    }

    #[cfg(not(target_os = "linux"))]
    {
        // The confinement boundary, the key/ledger/CAS custody, and SCM_RIGHTS
        // delivery are all Linux-only, so there is no reduced mode to fall back
        // to. PlanForge admission fails closed everywhere else: no listener is
        // claimed, no config is read, and no key is opened.
        eprintln!("{}", OperationalDiagnosticV1::UnsupportedPlatform.as_str());
        ExitCode::FAILURE
    }
}

#[cfg(target_os = "linux")]
fn run_default_plan_admission_host_linux_v1() -> Result<(), ProtectedPlanAdmissionHostErrorV1> {
    let listener = claim_and_validate_preopened_listener(
        PLAN_ADMISSION_LISTENER_FD,
        Path::new(PLAN_ADMISSION_SOCKET_PATH),
    )
    .map_err(|_| ProtectedPlanAdmissionHostErrorV1::StartupFailed)?;
    let startup = load_default_plan_admission_host_config_v1()
        .map_err(|_| ProtectedPlanAdmissionHostErrorV1::StartupFailed)?;
    validate_default_listener_path(startup.config().socket_group_gid)?;
    let host = ProtectedPlanAdmissionHostV1::from_validated_startup(startup)?;
    serve_sequential_connections(&listener, |stream| host.handle_connection(stream))
}

/// Hold the plan-admission socket to exactly the ownership and mode policy the
/// promotion-decision endpoint already proved live: a root-owned `0755` parent
/// chain and a root-owned, deployment-group, `0660`, single-link socket. The
/// validator itself is shared rather than copied, so the two endpoints cannot
/// drift apart.
#[cfg(target_os = "linux")]
fn validate_default_listener_path(
    expected_group: u32,
) -> Result<(), ProtectedPlanAdmissionHostErrorV1> {
    let root_descriptor = unsafe {
        libc::open(
            c"/".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if root_descriptor < 0 {
        return Err(ProtectedPlanAdmissionHostErrorV1::StartupFailed);
    }
    let root = unsafe { File::from_raw_fd(root_descriptor) };
    validate_listener_path_from_anchor(
        root.as_raw_fd(),
        &LISTENER_PARENT_COMPONENTS,
        LISTENER_SOCKET_FILE_NAME,
        0,
        expected_group,
    )
    .map(|_| ())
    .map_err(|_| ProtectedPlanAdmissionHostErrorV1::StartupFailed)
}

#[cfg(target_os = "linux")]
struct ProtectedPlanAdmissionHostV1 {
    startup: ValidatedPlanAdmissionHostStartupV1,
    kernel_signing_key: SigningKey,
    ledger: ProtectedPromotionDecisionLedgerV1,
    cas: ProtectedV5CasV1,
    policy: BrokerHostConfinementPolicyV1,
    attestation: BrokerHostConfinementAttestationV1,
}

#[cfg(target_os = "linux")]
impl ProtectedPlanAdmissionHostV1 {
    fn from_validated_startup(
        startup: ValidatedPlanAdmissionHostStartupV1,
    ) -> Result<Self, ProtectedPlanAdmissionHostErrorV1> {
        let policy = BrokerHostConfinementPolicyV1::new_for_role(
            startup.config().broker_uid,
            BrokerAuthorityRoleV1::PlanAdmission,
            startup.config().plan_admission_client_uids(),
        )
        .map_err(|_| ProtectedPlanAdmissionHostErrorV1::StartupFailed)?;
        let attestation = policy
            .attest_current_broker_process()
            .map_err(|_| ProtectedPlanAdmissionHostErrorV1::StartupFailed)?;
        let kernel_signing_key = load_plan_admission_signing_key_v1(&startup)
            .map_err(|_| ProtectedPlanAdmissionHostErrorV1::StartupFailed)?;
        let ledger = load_plan_admission_ledger_v1(&startup)
            .map_err(|_| ProtectedPlanAdmissionHostErrorV1::StartupFailed)?;
        let cas = load_plan_admission_cas_v1(&startup)
            .map_err(|_| ProtectedPlanAdmissionHostErrorV1::StartupFailed)?;
        Ok(Self {
            startup,
            kernel_signing_key,
            ledger,
            cas,
            policy,
            attestation,
        })
    }

    fn handle_connection(
        &self,
        stream: &mut UnixStream,
    ) -> Result<(), ProtectedPlanAdmissionHostErrorV1> {
        serve_one_authenticated_plan_admission(
            &self.policy,
            &self.attestation,
            stream,
            self.startup.config(),
            self.ledger.store(),
            self.ledger.recovery_database_path(),
            self.cas.cas(),
            &self.kernel_signing_key,
        )
    }
}

/// Handle exactly one authenticated plan-admission request end to end.
///
/// The order is load-bearing. The peer is authenticated and the frame is read
/// before anything is staged; the bytes are staged into the broker-owned CAS
/// before the mint runs, because the mint must resolve content through the same
/// protected store every other admission input comes from; and the derived
/// operator identity is looked up from the authenticated UID, never taken from
/// the request. A caller that never authenticates causes no CAS write at all.
#[cfg(target_os = "linux")]
#[allow(clippy::too_many_arguments)]
pub(crate) fn serve_one_authenticated_plan_admission(
    policy: &BrokerHostConfinementPolicyV1,
    attestation: &BrokerHostConfinementAttestationV1,
    stream: &mut UnixStream,
    config: &PlanAdmissionHostConfigV1,
    store: &SqliteStore,
    recovery_database_path: &Path,
    cas: &Cas,
    kernel_signing_key: &SigningKey,
) -> Result<(), ProtectedPlanAdmissionHostErrorV1> {
    let staged = read_authenticated_plan_admission_ingress(policy, attestation, stream)
        .map_err(|_| ProtectedPlanAdmissionHostErrorV1::ConnectionFailed)?;
    let parsed = staged.request;
    // This endpoint serves exactly one run. Without this check an authenticated
    // client could mint an admission against any run on the protected tape,
    // which is a wider authority than the deployment configured.
    if parsed.run_id != config.run_id {
        return Err(ProtectedPlanAdmissionHostErrorV1::ConnectionFailed);
    }
    let operator = resolve_operator_identity_for_peer(config, staged.peer_uid)
        .map_err(|_| ProtectedPlanAdmissionHostErrorV1::ConnectionFailed)?;

    // The broker is the only principal that writes this CAS. A failed write is
    // an uncertainty, not a refusal reason: the mint below will simply fail to
    // resolve the reference and answer with reconciliation.
    let _ = cas.put_canonical_bytes(&staged.plan_bytes);

    let binding_request_id = parsed.request_id.hyphenated().to_string();
    let binding_content_ref = parsed.plan_content_ref.as_str().to_string();

    let disposition = BrokerPlanAdmissionAuthority::new(
        ProtectedPlanContentResolver { cas },
        LedgerPlanRepositoryDescriptorResolver {
            store,
            trusted_keys: config.trusted_keys(),
            kernel_signer: &config.kernel_signer,
        },
        AuthenticatedPeerIdentityResolver {
            operator: Some(operator),
        },
        LedgerPlanAdmissionBackend::from_prevalidated_startup(
            store,
            &config.admission_authority,
            kernel_signing_key,
            &config.kernel_signer,
        ),
        TrustedPlanAdmissionSnapshotVerifier::from_prevalidated_startup(
            store,
            recovery_database_path,
            &config.admission_authority,
        ),
    )
    .admit(parsed);

    write_authenticated_plan_admission_response(
        policy,
        attestation,
        stream,
        kernel_signing_key,
        &binding_request_id,
        &binding_content_ref,
        disposition,
    )
}

/// Map one already-authenticated peer UID onto the operator identity the mint
/// will record.
///
/// The host policy admits exactly the UIDs this map names, so in a composed
/// host a verified peer always resolves. It is still a checked lookup rather
/// than an index: `decided_by` is signed onto the tape, and fabricating one for
/// an unmapped principal is precisely the self-assertion this slice removes.
#[cfg(target_os = "linux")]
pub(crate) fn resolve_operator_identity_for_peer(
    config: &PlanAdmissionHostConfigV1,
    peer_uid: u32,
) -> Result<ResolvedOperatorIdentity, PlanAdmissionIdentityError> {
    config
        .operator_identity_for_uid(peer_uid)
        .map(|decided_by| ResolvedOperatorIdentity::from_authenticated_peer(decided_by.to_string()))
        .ok_or(PlanAdmissionIdentityError::PeerRejected)
}

/// Resolve the named content through the broker-owned CAS only.
///
/// The reference is a digest, and the CAS re-hashes what it returns, so this
/// seam cannot decide the admission identity: it can only produce the object
/// that hashes to the name the caller gave, or nothing.
#[cfg(target_os = "linux")]
struct ProtectedPlanContentResolver<'a> {
    cas: &'a Cas,
}

#[cfg(target_os = "linux")]
impl PlanContentResolver for ProtectedPlanContentResolver<'_> {
    fn load_exact_plan_content(
        &mut self,
        content_ref: &PlanContentRefV1,
    ) -> Result<LoadedPlanContent, PlanContentResolverError> {
        let canonical =
            CanonicalCasRef::from_digest(content_ref.digest().to_string()).map_err(|_| {
                PlanContentResolverError::Rejected {
                    reason: "plan content reference is not a canonical CAS digest".into(),
                }
            })?;
        let bytes = self
            .cas
            .get_verified_canonical_bytes(&canonical.to_cas_ref(), canonical.digest())
            .map_err(|_| PlanContentResolverError::Absent)?;
        Ok(LoadedPlanContent::from_protected_store(bytes))
    }
}

/// Derive the trusted base from the run's own signed tape.
///
/// This is deliberately not a live `git rev-parse` and not a configuration
/// value. `run_started` carries the repository head the run was cut from, it is
/// already on the protected tape, and it is kernel-signed — so the trusted base
/// is a fact the broker re-derives from evidence it already holds, verified
/// against the same pinned signer the mint itself signs with. Anything less
/// than exactly one verified, kernel-signed `run_started` is refused.
#[cfg(target_os = "linux")]
struct LedgerPlanRepositoryDescriptorResolver<'a> {
    store: &'a SqliteStore,
    trusted_keys: &'a TrustedPublicKeys,
    kernel_signer: &'a ActorKeyRef,
}

#[cfg(target_os = "linux")]
impl PlanRepositoryDescriptorResolver for LedgerPlanRepositoryDescriptorResolver<'_> {
    fn resolve_repository_descriptor(
        &mut self,
        run_id: RunId,
    ) -> Result<ResolvedRepositoryDescriptor, PlanRepositoryDescriptorError> {
        let rejected = |reason: &str| PlanRepositoryDescriptorError::Rejected {
            reason: reason.to_string(),
        };
        let rows = self
            .store
            .verified_events_for_run(&run_id.to_string(), self.trusted_keys)
            .map_err(|_| rejected("protected ledger could not be read for the run"))?;

        let mut trusted_base: Option<String> = None;
        for row in rows {
            let event = row
                .event
                .to_event()
                .map_err(|_| rejected("protected ledger holds an unreadable event"))?;
            if event.kind != EventKind::RunStarted {
                continue;
            }
            if row.verification != VerificationStatus::Verified {
                return Err(rejected("the run start on the tape is not verified"));
            }
            let Some(signature) = row.signature else {
                return Err(rejected("the run start on the tape is unsigned"));
            };
            if signature.signer.actor_id != self.kernel_signer.actor_id
                || signature.signer.key_id != self.kernel_signer.key_id
            {
                return Err(rejected("the run start was not signed by the kernel"));
            }
            let Payload::RunStartedV1(started) = event.payload else {
                return Err(rejected("the run start carries an unexpected payload"));
            };
            if trusted_base.replace(started.git_head).is_some() {
                return Err(rejected("the run has more than one recorded start"));
            }
        }

        let trusted_base =
            trusted_base.ok_or_else(|| rejected("the run has no verified recorded start"))?;
        Ok(ResolvedRepositoryDescriptor::from_retained_custody(
            run_id,
            trusted_base,
        ))
    }
}

/// The identity seam, already resolved from SO_PEERCRED before it is built.
#[cfg(target_os = "linux")]
struct AuthenticatedPeerIdentityResolver {
    operator: Option<ResolvedOperatorIdentity>,
}

#[cfg(target_os = "linux")]
impl PlanAdmissionIdentityResolver for AuthenticatedPeerIdentityResolver {
    fn resolve_authenticated_operator(
        &mut self,
    ) -> Result<ResolvedOperatorIdentity, PlanAdmissionIdentityError> {
        // Taken, not cloned: one authenticated connection resolves one operator
        // identity once.
        self.operator
            .take()
            .ok_or(PlanAdmissionIdentityError::PeerRejected)
    }
}

#[cfg(target_os = "linux")]
#[allow(clippy::too_many_arguments)]
fn write_authenticated_plan_admission_response(
    policy: &BrokerHostConfinementPolicyV1,
    attestation: &BrokerHostConfinementAttestationV1,
    stream: &mut UnixStream,
    kernel_signing_key: &SigningKey,
    request_id: &str,
    plan_content_ref: &str,
    disposition: BrokerPlanAdmissionDisposition,
) -> Result<(), ProtectedPlanAdmissionHostErrorV1> {
    let binding = PlanAdmissionResponseBindingV1::new(request_id, plan_content_ref)
        .map_err(|_| ProtectedPlanAdmissionHostErrorV1::ConnectionFailed)?;
    let (status, admission_event_id) = match disposition {
        BrokerPlanAdmissionDisposition::Sealed(proof) => (
            PlanAdmissionResponseStatusV1::Sealed,
            Some(proof.admission_event_id().to_string()),
        ),
        BrokerPlanAdmissionDisposition::ReconciliationRequired => {
            (PlanAdmissionResponseStatusV1::ReconciliationRequired, None)
        }
    };
    // The kernel key is reused only through this domain-separated, closed
    // response constructor. There is no generic or caller-supplied signing
    // surface at the host boundary.
    let payload = sign_plan_admission_response(
        kernel_signing_key,
        binding,
        status,
        admission_event_id.as_deref(),
    )
    .map_err(|_| ProtectedPlanAdmissionHostErrorV1::ConnectionFailed)?;
    let mut frame = u32::try_from(payload.len())
        .map_err(|_| ProtectedPlanAdmissionHostErrorV1::ConnectionFailed)?
        .to_be_bytes()
        .to_vec();
    frame.extend_from_slice(&payload);
    if frame.is_empty() || frame.len() > MAX_PLAN_ADMISSION_RESPONSE_FRAME_BYTES {
        return Err(ProtectedPlanAdmissionHostErrorV1::ConnectionFailed);
    }

    let deadline = Instant::now()
        .checked_add(PLAN_ADMISSION_RESPONSE_WRITE_TIMEOUT)
        .ok_or(ProtectedPlanAdmissionHostErrorV1::ConnectionFailed)?;
    let mut written = 0;
    while written < frame.len() {
        if Instant::now() >= deadline {
            return Err(ProtectedPlanAdmissionHostErrorV1::ConnectionFailed);
        }
        policy
            .verify_linux_connected_worker_for_role(
                BrokerAuthorityRoleV1::PlanAdmission,
                attestation,
                stream,
            )
            .map_err(|_| ProtectedPlanAdmissionHostErrorV1::ConnectionFailed)?;
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or(ProtectedPlanAdmissionHostErrorV1::ConnectionFailed)?;
        stream
            .set_write_timeout(Some(remaining))
            .map_err(|_| ProtectedPlanAdmissionHostErrorV1::ConnectionFailed)?;
        let bytes_written = stream
            .write(&frame[written..])
            .map_err(|_| ProtectedPlanAdmissionHostErrorV1::ConnectionFailed)?;
        if bytes_written == 0 {
            return Err(ProtectedPlanAdmissionHostErrorV1::ConnectionFailed);
        }
        written += bytes_written;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn serve_sequential_connections<F>(
    listener: &UnixListener,
    mut handle_connection: F,
) -> Result<(), ProtectedPlanAdmissionHostErrorV1>
where
    F: FnMut(&mut UnixStream) -> Result<(), ProtectedPlanAdmissionHostErrorV1>,
{
    loop {
        let (mut stream, _) = listener
            .accept()
            .map_err(|_| ProtectedPlanAdmissionHostErrorV1::AcceptFailed)?;
        match handle_connection(&mut stream) {
            Ok(()) | Err(ProtectedPlanAdmissionHostErrorV1::ConnectionFailed) => {}
            Err(error) => return Err(error),
        }
    }
}
