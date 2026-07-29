//! Dedicated protected host for exactly-once promotion execution.

use crate::confinement::{
    BrokerAuthorityRoleV1, BrokerHostConfinementAttestationV1, BrokerHostConfinementPolicyV1,
};
use crate::host_config_loader::{
    load_default_promotion_decision_host_config_v1, ValidatedPromotionDecisionHostStartupV1,
};
use crate::host_key_custody::load_promotion_execution_signing_key_v1;
use crate::host_ledger_custody::{
    load_promotion_decision_ledger_v1, ProtectedPromotionDecisionLedgerV1,
};
use crate::promotion_decision_host::{
    claim_and_validate_preopened_listener, validate_listener_path_from_anchor,
};
use crate::promotion_execution::{
    BrokerPromotionExecutionStatus, ProtectedPromotionExecutionAuthority,
};
use crate::promotion_execution_handler::{
    handle_authenticated_promotion_execution_request_with_binding, HandledPromotionExecutionV1,
};
use crate::promotion_execution_response::{
    sign_promotion_execution_response, PromotionExecutionResponseBindingV1,
    PromotionExecutionResponseStatusV1,
};
use crate::promotion_repository_custody::{
    load_promotion_repository_v1, ProtectedPromotionRepositoryV1,
};
use crate::LeasePolicy;
use ed25519_dalek::SigningKey;
use std::fs::File;
use std::io::Write;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::process::ExitCode;
use std::time::{Duration, Instant};
use thiserror::Error;

const PROMOTION_EXECUTION_LISTENER_FD: libc::c_int = 3;
const PROMOTION_EXECUTION_SOCKET_PATH: &str =
    "/run/buildplane/authority-host/promotion-execution-v1.sock";
const LISTENER_PARENT_COMPONENTS: [&[u8]; 3] = [b"run", b"buildplane", b"authority-host"];
const LISTENER_SOCKET_FILE_NAME: &[u8] = b"promotion-execution-v1.sock";
const MAX_PROMOTION_EXECUTION_RESPONSE_FRAME_BYTES: usize = 4 * 1024;
const PROMOTION_EXECUTION_RESPONSE_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const PROMOTION_EXECUTION_LEASE_MS: u64 = 30_000;

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
enum ProtectedPromotionExecutionHostErrorV1 {
    #[error("protected promotion-execution host startup failed")]
    StartupFailed,
    #[error("protected promotion-execution host connection failed")]
    ConnectionFailed,
    #[error("protected promotion-execution host accept failed")]
    AcceptFailed,
}

struct ProtectedPromotionExecutionHostV1 {
    startup: ValidatedPromotionDecisionHostStartupV1,
    kernel_signing_key: SigningKey,
    ledger: ProtectedPromotionDecisionLedgerV1,
    repository: ProtectedPromotionRepositoryV1,
    policy: BrokerHostConfinementPolicyV1,
    attestation: BrokerHostConfinementAttestationV1,
    lease_policy: LeasePolicy,
}

impl ProtectedPromotionExecutionHostV1 {
    fn from_validated_startup(
        startup: ValidatedPromotionDecisionHostStartupV1,
    ) -> Result<Self, ProtectedPromotionExecutionHostErrorV1> {
        let policy = BrokerHostConfinementPolicyV1::new_for_role(
            startup.config().broker_uid,
            BrokerAuthorityRoleV1::PromotionExecution,
            startup
                .config()
                .promotion_decision_client_uids
                .iter()
                .copied(),
        )
        .map_err(|_| ProtectedPromotionExecutionHostErrorV1::StartupFailed)?;
        let attestation = policy
            .attest_current_broker_process()
            .map_err(|_| ProtectedPromotionExecutionHostErrorV1::StartupFailed)?;
        let kernel_signing_key = load_promotion_execution_signing_key_v1(&startup)
            .map_err(|_| ProtectedPromotionExecutionHostErrorV1::StartupFailed)?;
        let ledger = load_promotion_decision_ledger_v1(&startup)
            .map_err(|_| ProtectedPromotionExecutionHostErrorV1::StartupFailed)?;
        let repository = load_promotion_repository_v1(&startup)
            .map_err(|_| ProtectedPromotionExecutionHostErrorV1::StartupFailed)?;
        let lease_policy = LeasePolicy::from_startup_config(PROMOTION_EXECUTION_LEASE_MS)
            .map_err(|_| ProtectedPromotionExecutionHostErrorV1::StartupFailed)?;
        let host = Self {
            startup,
            kernel_signing_key,
            ledger,
            repository,
            policy,
            attestation,
            lease_policy,
        };
        host.authority()?;
        Ok(host)
    }

    fn authority(
        &self,
    ) -> Result<ProtectedPromotionExecutionAuthority<'_>, ProtectedPromotionExecutionHostErrorV1>
    {
        let config = self.startup.config();
        ProtectedPromotionExecutionAuthority::from_prevalidated_startup(
            config.run_id,
            self.ledger.recovery_database_path(),
            &config.replay_authorities,
            &config.kernel_signer,
            self.ledger.store(),
            &config.promotion_authority,
            &self.kernel_signing_key,
            &config.kernel_signer,
            self.repository.gateway_path(),
            self.lease_policy,
        )
        .map_err(|_| ProtectedPromotionExecutionHostErrorV1::StartupFailed)
    }

    fn handle_connection(
        &self,
        stream: &mut UnixStream,
    ) -> Result<(), ProtectedPromotionExecutionHostErrorV1> {
        let mut authority = self.authority()?;
        let handled = handle_authenticated_promotion_execution_request_with_binding(
            &self.policy,
            &self.attestation,
            stream,
            &mut authority,
        )
        .map_err(|_| ProtectedPromotionExecutionHostErrorV1::ConnectionFailed)?;
        self.write_response(stream, &handled)
    }

    fn write_response(
        &self,
        stream: &mut UnixStream,
        handled: &HandledPromotionExecutionV1,
    ) -> Result<(), ProtectedPromotionExecutionHostErrorV1> {
        let binding = PromotionExecutionResponseBindingV1::new(
            &handled.request_id,
            &handled.promotion_decision_event_id,
        )
        .map_err(|_| ProtectedPromotionExecutionHostErrorV1::ConnectionFailed)?;
        let status = match handled.status {
            BrokerPromotionExecutionStatus::Rejected => {
                PromotionExecutionResponseStatusV1::Rejected
            }
            BrokerPromotionExecutionStatus::Pending => PromotionExecutionResponseStatusV1::Pending,
            BrokerPromotionExecutionStatus::Completed => {
                PromotionExecutionResponseStatusV1::Completed
            }
            BrokerPromotionExecutionStatus::Recorded => {
                PromotionExecutionResponseStatusV1::Recorded
            }
            BrokerPromotionExecutionStatus::LeaseExpired => {
                PromotionExecutionResponseStatusV1::LeaseExpired
            }
            BrokerPromotionExecutionStatus::ReconciliationRequired => {
                PromotionExecutionResponseStatusV1::ReconciliationRequired
            }
        };
        let payload = sign_promotion_execution_response(&self.kernel_signing_key, binding, status);
        let mut frame = u32::try_from(payload.len())
            .map_err(|_| ProtectedPromotionExecutionHostErrorV1::ConnectionFailed)?
            .to_be_bytes()
            .to_vec();
        frame.extend_from_slice(&payload);
        write_response_frame_with_deadline(
            stream,
            &frame,
            PROMOTION_EXECUTION_RESPONSE_WRITE_TIMEOUT,
            |stream, deadline| {
                self.policy
                    .verify_linux_connected_worker_for_role(
                        BrokerAuthorityRoleV1::PromotionExecution,
                        &self.attestation,
                        stream,
                    )
                    .map_err(|_| ProtectedPromotionExecutionHostErrorV1::ConnectionFailed)?;
                let remaining = deadline
                    .checked_duration_since(Instant::now())
                    .filter(|remaining| !remaining.is_zero())
                    .ok_or(ProtectedPromotionExecutionHostErrorV1::ConnectionFailed)?;
                stream
                    .set_write_timeout(Some(remaining))
                    .map_err(|_| ProtectedPromotionExecutionHostErrorV1::ConnectionFailed)
            },
        )
    }
}

fn write_response_frame_with_deadline<W, F>(
    writer: &mut W,
    frame: &[u8],
    timeout: Duration,
    mut before_write: F,
) -> Result<(), ProtectedPromotionExecutionHostErrorV1>
where
    W: Write,
    F: FnMut(&mut W, Instant) -> Result<(), ProtectedPromotionExecutionHostErrorV1>,
{
    if frame.is_empty() || frame.len() > MAX_PROMOTION_EXECUTION_RESPONSE_FRAME_BYTES {
        return Err(ProtectedPromotionExecutionHostErrorV1::ConnectionFailed);
    }
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or(ProtectedPromotionExecutionHostErrorV1::ConnectionFailed)?;
    let mut written = 0;
    while written < frame.len() {
        if Instant::now() >= deadline {
            return Err(ProtectedPromotionExecutionHostErrorV1::ConnectionFailed);
        }
        before_write(writer, deadline)?;
        if Instant::now() >= deadline {
            return Err(ProtectedPromotionExecutionHostErrorV1::ConnectionFailed);
        }
        let count = writer
            .write(&frame[written..])
            .map_err(|_| ProtectedPromotionExecutionHostErrorV1::ConnectionFailed)?;
        if count == 0 {
            return Err(ProtectedPromotionExecutionHostErrorV1::ConnectionFailed);
        }
        written += count;
    }
    Ok(())
}

fn validate_default_listener_path(
    expected_group: u32,
) -> Result<(), ProtectedPromotionExecutionHostErrorV1> {
    let descriptor = unsafe {
        libc::open(
            c"/".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(ProtectedPromotionExecutionHostErrorV1::StartupFailed);
    }
    let root = unsafe { File::from_raw_fd(descriptor) };
    validate_listener_path_from_anchor(
        root.as_raw_fd(),
        &LISTENER_PARENT_COMPONENTS,
        LISTENER_SOCKET_FILE_NAME,
        0,
        expected_group,
    )
    .map(|_| ())
    .map_err(|_| ProtectedPromotionExecutionHostErrorV1::StartupFailed)
}

fn run_linux() -> Result<(), ProtectedPromotionExecutionHostErrorV1> {
    let listener = claim_and_validate_preopened_listener(
        PROMOTION_EXECUTION_LISTENER_FD,
        Path::new(PROMOTION_EXECUTION_SOCKET_PATH),
    )
    .map_err(|_| ProtectedPromotionExecutionHostErrorV1::StartupFailed)?;
    let startup = load_default_promotion_decision_host_config_v1()
        .map_err(|_| ProtectedPromotionExecutionHostErrorV1::StartupFailed)?;
    validate_default_listener_path(startup.config().socket_group_gid)?;
    let host = ProtectedPromotionExecutionHostV1::from_validated_startup(startup)?;
    serve_connections(&listener, |stream| host.handle_connection(stream))
}

fn serve_connections<F>(
    listener: &UnixListener,
    mut handle_connection: F,
) -> Result<(), ProtectedPromotionExecutionHostErrorV1>
where
    F: FnMut(&mut UnixStream) -> Result<(), ProtectedPromotionExecutionHostErrorV1>,
{
    loop {
        let (mut stream, _) = listener
            .accept()
            .map_err(|_| ProtectedPromotionExecutionHostErrorV1::AcceptFailed)?;
        match handle_connection(&mut stream) {
            Ok(()) | Err(ProtectedPromotionExecutionHostErrorV1::ConnectionFailed) => {}
            Err(error) => return Err(error),
        }
    }
}

pub fn run_default_promotion_execution_host_v1() -> ExitCode {
    match run_linux() {
        Ok(()) => ExitCode::SUCCESS,
        Err(ProtectedPromotionExecutionHostErrorV1::AcceptFailed) => {
            eprintln!("accept_failed");
            ExitCode::FAILURE
        }
        Err(_) => {
            eprintln!("startup_failed");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{self, Write};

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

    #[test]
    fn response_writer_rechecks_the_peer_gate_before_every_partial_write() {
        let frame = vec![7_u8; 31];
        let mut writer = PartialWriter::default();
        let mut gate_calls = 0;

        write_response_frame_with_deadline(&mut writer, &frame, Duration::from_secs(1), |_, _| {
            gate_calls += 1;
            Ok(())
        })
        .expect("bounded response is fully written");

        assert_eq!(writer.bytes, frame);
        assert_eq!(gate_calls, writer.writes);
        assert!(gate_calls > 1, "test must exercise partial writes");
    }

    #[test]
    fn response_writer_rejects_empty_or_oversized_frames_before_writing() {
        let mut writer = PartialWriter::default();
        let mut gate_calls = 0;
        for frame in [
            Vec::new(),
            vec![0_u8; MAX_PROMOTION_EXECUTION_RESPONSE_FRAME_BYTES + 1],
        ] {
            assert_eq!(
                write_response_frame_with_deadline(
                    &mut writer,
                    &frame,
                    Duration::from_secs(1),
                    |_, _| {
                        gate_calls += 1;
                        Ok(())
                    },
                ),
                Err(ProtectedPromotionExecutionHostErrorV1::ConnectionFailed)
            );
        }
        assert_eq!(gate_calls, 0);
        assert_eq!(writer.writes, 0);
        assert!(writer.bytes.is_empty());
    }

    #[test]
    fn response_writer_does_not_write_after_the_absolute_deadline() {
        let mut writer = PartialWriter::default();
        assert_eq!(
            write_response_frame_with_deadline(
                &mut writer,
                &[1],
                Duration::from_millis(1),
                |_, _| {
                    std::thread::sleep(Duration::from_millis(5));
                    Ok(())
                },
            ),
            Err(ProtectedPromotionExecutionHostErrorV1::ConnectionFailed)
        );
        assert_eq!(writer.writes, 0);
    }

    #[test]
    fn activation_surface_and_socket_identity_are_fixed() {
        let _runner: fn() -> ExitCode = run_default_promotion_execution_host_v1;
        assert_eq!(PROMOTION_EXECUTION_LISTENER_FD, 3);
        assert_eq!(
            PROMOTION_EXECUTION_SOCKET_PATH,
            "/run/buildplane/authority-host/promotion-execution-v1.sock"
        );
        assert_eq!(LISTENER_SOCKET_FILE_NAME, b"promotion-execution-v1.sock");
    }
}
