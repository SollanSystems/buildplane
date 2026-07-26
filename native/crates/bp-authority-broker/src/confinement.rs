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

/// Startup policy for one broker authority endpoint and the client UIDs it may
/// accept.
///
/// The broker identity must be distinct from every permitted client identity.
/// A same-UID connection can read the broker's key material or invoke its
/// native authority surface under the same OS principal, so it is never a
/// valid client boundary.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BrokerHostConfinementPolicyV1 {
    broker_uid: u32,
    role: BrokerAuthorityRoleV1,
    client_uids: BTreeSet<u32>,
}

/// Closed authority operation roles with independently configured worker UIDs.
///
/// Adding a broker endpoint requires extending this enum and explicitly
/// configuring its worker identity boundary at host startup.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BrokerAuthorityRoleV1 {
    DispatchAdmission,
    PromotionDecision,
    PromotionExecution,
    ModelAction,
}

/// A non-forgeable-in-normal-code proof that the current process started as
/// the configured broker UID. It is retained by the protected server and is
/// required when it validates a connected worker.
#[derive(Clone, Debug)]
pub(crate) struct BrokerHostConfinementAttestationV1 {
    broker_uid: u32,
}

/// Closed denial reasons for the broker OS-identity boundary.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub(crate) enum BrokerHostConfinementErrorV1 {
    #[error("broker host confinement requires at least one separately configured worker UID")]
    NoWorkerUids,
    #[error("UID 0 is not allowed for a broker or authority client")]
    UidZeroNotAllowed { uid: u32 },
    #[error("configured worker UID {uid} aliases the broker UID")]
    WorkerUidAliasesBroker { uid: u32 },
    #[error(
        "broker confinement policy role {configured_role:?} does not match requested role {requested_role:?}"
    )]
    RolePolicyMismatch {
        configured_role: BrokerAuthorityRoleV1,
        requested_role: BrokerAuthorityRoleV1,
    },
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
    /// Construct a closed startup policy for exactly one authority endpoint.
    /// Callers must derive these UIDs from protected host configuration, never
    /// from a packet, environment value, model request, or worker-controlled
    /// socket metadata.
    pub(crate) fn new_for_role(
        broker_uid: u32,
        role: BrokerAuthorityRoleV1,
        client_uids: impl IntoIterator<Item = u32>,
    ) -> Result<Self, BrokerHostConfinementErrorV1> {
        if broker_uid == 0 {
            return Err(BrokerHostConfinementErrorV1::UidZeroNotAllowed { uid: broker_uid });
        }
        let client_uids: BTreeSet<u32> = client_uids.into_iter().collect();
        if client_uids.is_empty() {
            return Err(BrokerHostConfinementErrorV1::NoWorkerUids);
        }
        if client_uids.contains(&0) {
            return Err(BrokerHostConfinementErrorV1::UidZeroNotAllowed { uid: 0 });
        }
        if client_uids.contains(&broker_uid) {
            return Err(BrokerHostConfinementErrorV1::WorkerUidAliasesBroker { uid: broker_uid });
        }
        Ok(Self {
            broker_uid,
            role,
            client_uids,
        })
    }

    /// Compatibility helper for existing internal tests. It is deliberately
    /// absent from production builds so a protected host cannot start without
    /// binding its authority boundary to an explicit role.
    #[cfg(test)]
    pub(crate) fn new(
        broker_uid: u32,
        worker_uids: impl IntoIterator<Item = u32>,
    ) -> Result<Self, BrokerHostConfinementErrorV1> {
        Self::new_for_role(broker_uid, BrokerAuthorityRoleV1::ModelAction, worker_uids)
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

    /// Compatibility helper for existing internal tests. It is deliberately
    /// absent from production builds so the generic authority boundary cannot
    /// be used by a protected host.
    #[cfg(test)]
    fn verify_peer(&self, peer: BrokerPeerIdentityV1) -> Result<(), BrokerHostConfinementErrorV1> {
        self.verify_peer_for_role(self.role, peer)
    }

    /// Validate one kernel-observed peer identity for a specific authority
    /// role. Production callers must use
    /// [`Self::verify_linux_connected_worker_for_role`] so identity is read
    /// from a connected socket rather than supplied by a worker request.
    fn verify_peer_for_role(
        &self,
        role: BrokerAuthorityRoleV1,
        peer: BrokerPeerIdentityV1,
    ) -> Result<(), BrokerHostConfinementErrorV1> {
        if role != self.role {
            return Err(BrokerHostConfinementErrorV1::RolePolicyMismatch {
                configured_role: self.role,
                requested_role: role,
            });
        }
        self.verify_peer_against_uids(peer, &self.client_uids)
    }

    fn verify_peer_against_uids(
        &self,
        peer: BrokerPeerIdentityV1,
        allowed_worker_uids: &BTreeSet<u32>,
    ) -> Result<(), BrokerHostConfinementErrorV1> {
        if peer.pid <= 0 {
            return Err(BrokerHostConfinementErrorV1::InvalidPeerPid { pid: peer.pid });
        }
        if peer.uid == self.broker_uid {
            return Err(BrokerHostConfinementErrorV1::PeerUsesBrokerUid { uid: peer.uid });
        }
        if !allowed_worker_uids.contains(&peer.uid) {
            return Err(BrokerHostConfinementErrorV1::PeerUidNotAllowed { uid: peer.uid });
        }
        Ok(())
    }

    /// Compatibility helper for existing internal tests. It is deliberately
    /// absent from production builds so a protected host must provide an
    /// explicit authority role.
    #[cfg(all(test, target_os = "linux"))]
    pub(crate) fn verify_linux_connected_worker(
        &self,
        attestation: &BrokerHostConfinementAttestationV1,
        stream: &UnixStream,
    ) -> Result<(), BrokerHostConfinementErrorV1> {
        self.verify_linux_connected_worker_for_role(self.role, attestation, stream)
    }

    /// Read Linux `SO_PEERCRED` from one accepted Unix-domain socket and
    /// validate its identity only for the requested authority role under a
    /// startup attestation.
    #[cfg(target_os = "linux")]
    pub(crate) fn verify_linux_connected_worker_for_role(
        &self,
        role: BrokerAuthorityRoleV1,
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
        self.verify_peer_for_role(role, peer)
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

    #[test]
    fn promotion_decision_role_rejects_a_uid_not_configured_for_the_endpoint() {
        let policy = BrokerHostConfinementPolicyV1::new_for_role(
            4_201,
            BrokerAuthorityRoleV1::PromotionDecision,
            [4_202],
        )
        .expect("a separately configured promotion-decision client is valid");

        policy
            .verify_peer_for_role(
                BrokerAuthorityRoleV1::PromotionDecision,
                BrokerPeerIdentityV1 {
                    pid: 104,
                    uid: 4_202,
                    gid: 4_202,
                },
            )
            .expect("the promotion-decision UID is admitted only for that role");
        assert!(matches!(
            policy.verify_peer_for_role(
                BrokerAuthorityRoleV1::PromotionDecision,
                BrokerPeerIdentityV1 {
                    pid: 105,
                    uid: 4_203,
                    gid: 4_203,
                },
            ),
            Err(BrokerHostConfinementErrorV1::PeerUidNotAllowed { uid: 4_203 })
        ));
        assert!(matches!(
            policy.verify_peer_for_role(
                BrokerAuthorityRoleV1::PromotionDecision,
                BrokerPeerIdentityV1 {
                    pid: 106,
                    uid: 4_201,
                    gid: 4_201,
                },
            ),
            Err(BrokerHostConfinementErrorV1::PeerUsesBrokerUid { uid: 4_201 })
        ));
    }

    #[test]
    fn role_bound_policy_rejects_empty_or_broker_aliased_client_sets() {
        assert!(matches!(
            BrokerHostConfinementPolicyV1::new_for_role(
                4_201,
                BrokerAuthorityRoleV1::PromotionDecision,
                [],
            ),
            Err(BrokerHostConfinementErrorV1::NoWorkerUids)
        ));
        assert!(matches!(
            BrokerHostConfinementPolicyV1::new_for_role(
                4_201,
                BrokerAuthorityRoleV1::PromotionExecution,
                [4_201],
            ),
            Err(BrokerHostConfinementErrorV1::WorkerUidAliasesBroker { uid: 4_201 })
        ));
    }

    #[test]
    fn role_bound_policy_accepts_only_its_explicit_endpoint_role() {
        let policy = BrokerHostConfinementPolicyV1::new_for_role(
            4_201,
            BrokerAuthorityRoleV1::DispatchAdmission,
            [4_202],
        )
        .expect("a separately configured endpoint client is valid");

        policy
            .verify_peer_for_role(
                BrokerAuthorityRoleV1::DispatchAdmission,
                BrokerPeerIdentityV1 {
                    pid: 107,
                    uid: 4_202,
                    gid: 4_202,
                },
            )
            .expect("the configured client is admitted for its configured endpoint");
        assert!(matches!(
            policy.verify_peer_for_role(
                BrokerAuthorityRoleV1::ModelAction,
                BrokerPeerIdentityV1 {
                    pid: 108,
                    uid: 4_202,
                    gid: 4_202,
                },
            ),
            Err(BrokerHostConfinementErrorV1::RolePolicyMismatch {
                configured_role: BrokerAuthorityRoleV1::DispatchAdmission,
                requested_role: BrokerAuthorityRoleV1::ModelAction,
            })
        ));
    }

    #[test]
    fn role_bound_policy_rejects_root_broker_and_client_uids() {
        assert!(matches!(
            BrokerHostConfinementPolicyV1::new_for_role(
                0,
                BrokerAuthorityRoleV1::PromotionDecision,
                [4_202],
            ),
            Err(BrokerHostConfinementErrorV1::UidZeroNotAllowed { uid: 0 })
        ));
        assert!(matches!(
            BrokerHostConfinementPolicyV1::new_for_role(
                4_201,
                BrokerAuthorityRoleV1::PromotionDecision,
                [0],
            ),
            Err(BrokerHostConfinementErrorV1::UidZeroNotAllowed { uid: 0 })
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
