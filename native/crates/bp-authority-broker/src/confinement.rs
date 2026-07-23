//! Broker-side OS identity checks for a future protected Unix authority host.
//!
//! These checks are deliberately native and Linux-only. They do not start a
//! listener, discover a socket, read a configuration file, or grant any
//! authority by themselves. A protected host must establish a broker process
//! under the configured broker UID at startup, retain the resulting
//! attestation, and require a fresh kernel-provided `SO_PEERCRED` identity for
//! every worker connection before it can reach an authority operation.

use std::collections::BTreeSet;

#[cfg(target_os = "linux")]
use std::os::{fd::AsRawFd, unix::net::UnixStream};

use thiserror::Error;

/// Kernel-observed identity for one connected Unix-domain peer.
///
/// This record is intentionally not deserialized and has no caller-provided
/// constructor in a production boundary. [`BrokerHostConfinementPolicyV1`]
/// obtains it from Linux `SO_PEERCRED` before it evaluates the policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct BrokerPeerIdentityV1 {
    pid: i32,
    uid: u32,
    gid: u32,
}

/// Startup policy for the broker process and the worker UIDs it may accept.
///
/// The broker identity must be distinct from every permitted worker identity.
/// A same-UID connection can read the broker's key material or invoke its
/// native authority surface under the same OS principal, so it is never a
/// valid worker boundary.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BrokerHostConfinementPolicyV1 {
    broker_uid: u32,
    worker_uids: BTreeSet<u32>,
}

/// A non-forgeable-in-normal-code proof that the current process started as
/// the configured broker UID. It is retained by the protected server and is
/// required when it validates a connected worker.
#[derive(Debug)]
pub(crate) struct BrokerHostConfinementAttestationV1 {
    broker_uid: u32,
}

/// Closed denial reasons for the broker OS-identity boundary.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub(crate) enum BrokerHostConfinementErrorV1 {
    #[error("broker host confinement requires at least one separately configured worker UID")]
    NoWorkerUids,
    #[error("configured worker UID {uid} aliases the broker UID")]
    WorkerUidAliasesBroker { uid: u32 },
    #[cfg(not(target_os = "linux"))]
    #[error("broker host confinement is supported only on Linux")]
    UnsupportedPlatform,
    #[error(
        "current process UID {actual_uid} does not match configured broker UID {expected_uid}"
    )]
    BrokerUidMismatch { expected_uid: u32, actual_uid: u32 },
    #[error("broker confinement attestation for UID {attested_broker_uid} does not match configured broker UID {configured_broker_uid}")]
    AttestationPolicyMismatch {
        attested_broker_uid: u32,
        configured_broker_uid: u32,
    },
    #[error("kernel peer credentials were unavailable for the connected worker")]
    PeerCredentialsUnavailable,
    #[error("connected worker reported invalid process ID {pid}")]
    InvalidPeerPid { pid: i32 },
    #[error("connected worker UID {uid} aliases the broker UID")]
    PeerUsesBrokerUid { uid: u32 },
    #[error("connected worker UID {uid} is not configured for this broker")]
    PeerUidNotAllowed { uid: u32 },
}

impl BrokerHostConfinementPolicyV1 {
    /// Construct a closed startup policy. Callers must derive these UIDs from
    /// protected host configuration, never from a packet, environment value,
    /// model request, or worker-controlled socket metadata.
    pub(crate) fn new(
        broker_uid: u32,
        worker_uids: impl IntoIterator<Item = u32>,
    ) -> Result<Self, BrokerHostConfinementErrorV1> {
        let worker_uids: BTreeSet<u32> = worker_uids.into_iter().collect();
        if worker_uids.is_empty() {
            return Err(BrokerHostConfinementErrorV1::NoWorkerUids);
        }
        if worker_uids.contains(&broker_uid) {
            return Err(BrokerHostConfinementErrorV1::WorkerUidAliasesBroker { uid: broker_uid });
        }
        Ok(Self {
            broker_uid,
            worker_uids,
        })
    }

    /// Establish that this process is the separately configured broker before
    /// it accepts any worker connection. Non-Linux environments fail closed.
    pub(crate) fn attest_current_broker_process(
        &self,
    ) -> Result<BrokerHostConfinementAttestationV1, BrokerHostConfinementErrorV1> {
        #[cfg(target_os = "linux")]
        {
            let actual_uid = unsafe { libc::geteuid() };
            if actual_uid != self.broker_uid {
                return Err(BrokerHostConfinementErrorV1::BrokerUidMismatch {
                    expected_uid: self.broker_uid,
                    actual_uid,
                });
            }
            Ok(BrokerHostConfinementAttestationV1 {
                broker_uid: self.broker_uid,
            })
        }

        #[cfg(not(target_os = "linux"))]
        {
            Err(BrokerHostConfinementErrorV1::UnsupportedPlatform)
        }
    }

    /// Validate one kernel-observed peer identity. This pure helper keeps the
    /// policy testable; production callers must use
    /// [`Self::verify_linux_connected_worker`] so identity is read from the
    /// connected socket rather than supplied by a worker request.
    fn verify_peer(&self, peer: BrokerPeerIdentityV1) -> Result<(), BrokerHostConfinementErrorV1> {
        if peer.pid <= 0 {
            return Err(BrokerHostConfinementErrorV1::InvalidPeerPid { pid: peer.pid });
        }
        if peer.uid == self.broker_uid {
            return Err(BrokerHostConfinementErrorV1::PeerUsesBrokerUid { uid: peer.uid });
        }
        if !self.worker_uids.contains(&peer.uid) {
            return Err(BrokerHostConfinementErrorV1::PeerUidNotAllowed { uid: peer.uid });
        }
        Ok(())
    }

    /// Read Linux `SO_PEERCRED` from one accepted Unix-domain socket and
    /// validate the identity under a startup attestation. The caller cannot
    /// pass a UID, PID, or GID; a missing kernel credential fails closed.
    #[cfg(target_os = "linux")]
    pub(crate) fn verify_linux_connected_worker(
        &self,
        attestation: &BrokerHostConfinementAttestationV1,
        stream: &UnixStream,
    ) -> Result<(), BrokerHostConfinementErrorV1> {
        if attestation.broker_uid != self.broker_uid {
            return Err(BrokerHostConfinementErrorV1::AttestationPolicyMismatch {
                attested_broker_uid: attestation.broker_uid,
                configured_broker_uid: self.broker_uid,
            });
        }
        let peer = linux_peer_identity(stream)?;
        self.verify_peer(peer)
    }
}

#[cfg(target_os = "linux")]
fn linux_peer_identity(
    stream: &UnixStream,
) -> Result<BrokerPeerIdentityV1, BrokerHostConfinementErrorV1> {
    let mut credential = std::mem::MaybeUninit::<libc::ucred>::zeroed();
    let mut credential_length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            credential.as_mut_ptr().cast::<libc::c_void>(),
            &mut credential_length,
        )
    };
    if result != 0 || credential_length != std::mem::size_of::<libc::ucred>() as libc::socklen_t {
        return Err(BrokerHostConfinementErrorV1::PeerCredentialsUnavailable);
    }
    let credential = unsafe { credential.assume_init() };
    Ok(BrokerPeerIdentityV1 {
        pid: credential.pid,
        uid: credential.uid,
        gid: credential.gid,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_rejects_same_uid_unapproved_and_malformed_peers() {
        let policy = BrokerHostConfinementPolicyV1::new(4_201, [4_202])
            .expect("a distinct configured worker identity is valid");

        assert!(matches!(
            policy.verify_peer(BrokerPeerIdentityV1 {
                pid: 101,
                uid: 4_201,
                gid: 4_201,
            }),
            Err(BrokerHostConfinementErrorV1::PeerUsesBrokerUid { .. })
        ));
        assert!(matches!(
            policy.verify_peer(BrokerPeerIdentityV1 {
                pid: 102,
                uid: 4_203,
                gid: 4_203,
            }),
            Err(BrokerHostConfinementErrorV1::PeerUidNotAllowed { .. })
        ));
        assert!(matches!(
            policy.verify_peer(BrokerPeerIdentityV1 {
                pid: 0,
                uid: 4_202,
                gid: 4_202,
            }),
            Err(BrokerHostConfinementErrorV1::InvalidPeerPid { pid: 0 })
        ));
    }

    #[test]
    fn policy_accepts_only_a_configured_distinct_worker_identity() {
        let policy = BrokerHostConfinementPolicyV1::new(4_201, [4_202])
            .expect("a distinct configured worker identity is valid");

        policy
            .verify_peer(BrokerPeerIdentityV1 {
                pid: 103,
                uid: 4_202,
                gid: 4_202,
            })
            .expect("the configured worker identity is admitted");
        assert!(matches!(
            BrokerHostConfinementPolicyV1::new(4_201, [4_201]),
            Err(BrokerHostConfinementErrorV1::WorkerUidAliasesBroker { .. })
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn policy_rejects_a_startup_process_with_the_wrong_uid() {
        let actual_uid = unsafe { libc::geteuid() };
        let configured_broker_uid = actual_uid.checked_add(1).unwrap_or(actual_uid - 1);
        let policy = BrokerHostConfinementPolicyV1::new(configured_broker_uid, [actual_uid])
            .expect("the current UID is a distinct configured worker identity");

        assert!(matches!(
            policy.attest_current_broker_process(),
            Err(BrokerHostConfinementErrorV1::BrokerUidMismatch {
                expected_uid,
                actual_uid: observed_uid,
            }) if expected_uid == configured_broker_uid && observed_uid == actual_uid
        ));
    }
}
