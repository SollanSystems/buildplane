//! Private authenticated ingress for one plan-admission mint request.
//!
//! This module starts no listener, writes no response, opens no ledger, holds
//! no signer, and touches no CAS. It authenticates a connected Linux peer,
//! reads exactly one bounded frame, and takes delivery of the compiled plan
//! bytes that rode with that frame. Everything downstream — staging the bytes
//! into the broker-owned CAS, resolving the operator identity for the verified
//! UID, and driving the mint — belongs to the protected host.
//!
//! **Why the bytes travel over this socket.** `plan_admitted` is the one
//! trust-spine kind with no signed predecessor on the tape, so the mint's trust
//! root is the broker-owned CAS, and that CAS is `0700` and broker-uid-owned:
//! the requester structurally cannot stage its own object into it
//! (`WorkerUidAliasesBroker` forbids a client UID from equalling the broker
//! UID). The ratified resolution is that the bytes ride the authenticated
//! channel and the broker performs the only CAS write. They cannot ride inside
//! the frame — every broker wire protocol caps a frame at 16 KiB while the
//! admission input bound is 1 MiB — so they arrive as a **sealed memfd passed
//! by `SCM_RIGHTS`**.
//!
//! Sealing is load-bearing, not decoration. An ordinary descriptor would leave
//! the sender able to rewrite the object between the moment the host digests it
//! and the moment the mint records that digest. Requiring
//! `F_SEAL_WRITE | F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_SEAL` makes the content
//! immutable for the lifetime of the descriptor, so "the bytes the host hashed"
//! and "the bytes the host staged" are the same bytes by construction.

#[cfg(target_os = "linux")]
use crate::confinement::{
    BrokerAuthorityRoleV1, BrokerHostConfinementAttestationV1, BrokerHostConfinementPolicyV1,
};
#[cfg(target_os = "linux")]
use crate::plan_admission::{
    parse_plan_admission_request_v1, ParsedPlanAdmissionRequestV1, PlanAdmissionRequestRejection,
};
use thiserror::Error;

#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
#[cfg(target_os = "linux")]
use std::os::unix::net::UnixStream;
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};

#[cfg(target_os = "linux")]
const PLAN_ADMISSION_FRAME_READ_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(target_os = "linux")]
const MAX_PLAN_ADMISSION_FRAME_BYTES: usize = 16 * 1024;
/// Mirrors `MAX_PLAN_ADMISSION_INPUT_BYTES` in the storage layer. The ingress
/// refuses oversized content before it allocates, so the storage bound stays a
/// second line of defence rather than the only one.
#[cfg(target_os = "linux")]
const MAX_PLAN_ADMISSION_CONTENT_BYTES: u64 = 1 << 20;
#[cfg(target_os = "linux")]
const REQUIRED_CONTENT_SEALS: libc::c_int =
    libc::F_SEAL_WRITE | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_SEAL;

#[cfg(all(test, target_os = "linux"))]
pub(crate) fn max_plan_admission_content_bytes_for_test() -> usize {
    MAX_PLAN_ADMISSION_CONTENT_BYTES as usize
}

/// Closed local failures for the private authenticated plan-admission ingress.
///
/// Signer, ledger, CAS, storage, and reconciliation internals never cross this
/// boundary. The content descriptor rides with the frame, so every way it can
/// be unusable is reported as a rejected frame.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum PlanAdmissionHandlerError {
    #[error("plan admission peer was rejected")]
    PeerRejected,
    #[error("plan admission frame was rejected")]
    FrameRejected,
    #[error("plan admission request was rejected")]
    RequestRejected,
}

/// Crate-private diagnostic detail for exactly why one ingress attempt failed.
///
/// **Never serialized to a peer.** It exists for the same reason
/// `PlanAdmissionRefusal` does in the composition: eleven distinct refusals
/// collapsing to three wire variants would make a suite that only asserts the
/// wire variant pass even if most of the checks were deleted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PlanAdmissionIngressRefusal {
    PeerRejected,
    FrameHeaderRejected,
    FrameBodyRejected,
    ContentDescriptorMissing,
    ContentDescriptorAmbiguous,
    ContentDescriptorNotSealed,
    ContentDescriptorNotRegularFile,
    ContentEmpty,
    ContentTooLarge,
    ContentReadFailed,
    RequestNotClosed,
    RequestIdentifiersRejected,
}

impl From<PlanAdmissionIngressRefusal> for PlanAdmissionHandlerError {
    fn from(value: PlanAdmissionIngressRefusal) -> Self {
        match value {
            PlanAdmissionIngressRefusal::PeerRejected => Self::PeerRejected,
            PlanAdmissionIngressRefusal::RequestNotClosed
            | PlanAdmissionIngressRefusal::RequestIdentifiersRejected => Self::RequestRejected,
            _ => Self::FrameRejected,
        }
    }
}

/// One authenticated ingress delivery: the strict parsed request, the compiled
/// plan bytes that rode with it, and the kernel-observed UID that sent both.
///
/// The UID is the only identity in this record. There is deliberately no field
/// through which a request could name the operator it wishes to be recorded as.
#[cfg(target_os = "linux")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StagedPlanAdmissionIngressV1 {
    pub(crate) request: ParsedPlanAdmissionRequestV1,
    pub(crate) plan_bytes: Vec<u8>,
    pub(crate) peer_uid: u32,
}

/// Authenticate a connected Linux worker, then read exactly one bounded
/// plan-admission frame and take delivery of its sealed content descriptor.
///
/// Peer verification is intentionally the first operation: a rejected
/// same-UID, unconfigured, or wrong-role worker cannot cause even a frame
/// header read, let alone a CAS write or a tape append. Every individual socket
/// read is also preceded by a fresh peer check under a host-owned deadline.
#[cfg(target_os = "linux")]
pub(crate) fn read_authenticated_plan_admission_ingress(
    policy: &BrokerHostConfinementPolicyV1,
    attestation: &BrokerHostConfinementAttestationV1,
    stream: &mut UnixStream,
) -> Result<StagedPlanAdmissionIngressV1, PlanAdmissionHandlerError> {
    read_authenticated_plan_admission_ingress_detailed(policy, attestation, stream)
        .map_err(PlanAdmissionHandlerError::from)
}

#[cfg(target_os = "linux")]
pub(crate) fn read_authenticated_plan_admission_ingress_detailed(
    policy: &BrokerHostConfinementPolicyV1,
    attestation: &BrokerHostConfinementAttestationV1,
    stream: &mut UnixStream,
) -> Result<StagedPlanAdmissionIngressV1, PlanAdmissionIngressRefusal> {
    // First operation, before a deadline exists and before a single frame byte
    // is read. A rejected peer costs one getsockopt and nothing else.
    let peer_uid = verified_plan_admission_peer_uid(policy, attestation, stream)?;

    let deadline = Instant::now()
        .checked_add(PLAN_ADMISSION_FRAME_READ_TIMEOUT)
        .ok_or(PlanAdmissionIngressRefusal::FrameHeaderRejected)?;
    let mut descriptors: Vec<OwnedFd> = Vec::new();

    let mut encoded_length = [0_u8; std::mem::size_of::<u32>()];
    receive_frame_chunk(
        policy,
        attestation,
        stream,
        deadline,
        &mut encoded_length,
        &mut descriptors,
        PlanAdmissionIngressRefusal::FrameHeaderRejected,
    )?;
    let payload_length = u32::from_be_bytes(encoded_length) as usize;
    if payload_length == 0 || payload_length > MAX_PLAN_ADMISSION_FRAME_BYTES {
        return Err(PlanAdmissionIngressRefusal::FrameHeaderRejected);
    }

    let mut frame = vec![0_u8; payload_length];
    receive_frame_chunk(
        policy,
        attestation,
        stream,
        deadline,
        &mut frame,
        &mut descriptors,
        PlanAdmissionIngressRefusal::FrameBodyRejected,
    )?;

    let content_descriptor = match descriptors.len() {
        0 => return Err(PlanAdmissionIngressRefusal::ContentDescriptorMissing),
        1 => &descriptors[0],
        _ => return Err(PlanAdmissionIngressRefusal::ContentDescriptorAmbiguous),
    };
    let plan_bytes = read_sealed_plan_content(content_descriptor)?;

    let frame =
        std::str::from_utf8(&frame).map_err(|_| PlanAdmissionIngressRefusal::RequestNotClosed)?;
    let request = parse_plan_admission_request_v1(frame).map_err(|rejection| match rejection {
        PlanAdmissionRequestRejection::FrameRejected => {
            PlanAdmissionIngressRefusal::RequestNotClosed
        }
        PlanAdmissionRequestRejection::RequestRejected => {
            PlanAdmissionIngressRefusal::RequestIdentifiersRejected
        }
    })?;

    Ok(StagedPlanAdmissionIngressV1 {
        request,
        plan_bytes,
        peer_uid,
    })
}

/// Ancillary capacity for two descriptors. One is the contract; the second slot
/// exists so a two-descriptor frame is *observed and refused* rather than
/// silently truncated into a one-descriptor frame by the kernel.
#[cfg(target_os = "linux")]
const CONTROL_CAPACITY_BYTES: usize =
    unsafe { libc::CMSG_SPACE((2 * std::mem::size_of::<libc::c_int>()) as libc::c_uint) } as usize;
#[cfg(target_os = "linux")]
const CONTROL_CAPACITY_WORDS: usize = CONTROL_CAPACITY_BYTES.div_ceil(std::mem::size_of::<u64>());

#[cfg(target_os = "linux")]
fn verified_plan_admission_peer_uid(
    policy: &BrokerHostConfinementPolicyV1,
    attestation: &BrokerHostConfinementAttestationV1,
    stream: &UnixStream,
) -> Result<u32, PlanAdmissionIngressRefusal> {
    policy
        .verified_linux_connected_worker_uid_for_role(
            BrokerAuthorityRoleV1::PlanAdmission,
            attestation,
            stream,
        )
        .map_err(|_| PlanAdmissionIngressRefusal::PeerRejected)
}

/// Fill one buffer under a host-owned absolute deadline, re-verifying the peer
/// immediately before every syscall that can block, and taking delivery of any
/// descriptors the kernel attaches to the bytes read.
#[cfg(target_os = "linux")]
#[allow(clippy::too_many_arguments)]
fn receive_frame_chunk(
    policy: &BrokerHostConfinementPolicyV1,
    attestation: &BrokerHostConfinementAttestationV1,
    stream: &mut UnixStream,
    deadline: Instant,
    buffer: &mut [u8],
    descriptors: &mut Vec<OwnedFd>,
    chunk_refusal: PlanAdmissionIngressRefusal,
) -> Result<(), PlanAdmissionIngressRefusal> {
    let mut filled = 0;
    while filled < buffer.len() {
        if Instant::now() >= deadline {
            return Err(chunk_refusal);
        }
        verified_plan_admission_peer_uid(policy, attestation, stream)?;
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or(chunk_refusal)?;
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|_| chunk_refusal)?;

        let mut control = [0_u64; CONTROL_CAPACITY_WORDS];
        let mut iov = libc::iovec {
            iov_base: buffer[filled..].as_mut_ptr().cast(),
            iov_len: buffer.len() - filled,
        };
        let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
        message.msg_iov = std::ptr::addr_of_mut!(iov);
        message.msg_iovlen = 1;
        message.msg_control = control.as_mut_ptr().cast();
        message.msg_controllen = CONTROL_CAPACITY_BYTES;

        let received = unsafe {
            libc::recvmsg(
                stream.as_raw_fd(),
                std::ptr::addr_of_mut!(message),
                libc::MSG_CMSG_CLOEXEC,
            )
        };
        // Take ownership of anything the kernel attached before deciding what
        // the byte count means, so a descriptor delivered alongside a failed
        // read is still closed by `OwnedFd`.
        if received >= 0 {
            collect_attached_descriptors(&message, descriptors)?;
        }
        if received <= 0 {
            return Err(chunk_refusal);
        }
        filled += received as usize;
        // Only a buffer that still needs another read can be refused for time.
        // Checking unconditionally would reject a frame that arrived complete
        // exactly at the deadline, after all its bytes were already in hand.
        if filled < buffer.len() && Instant::now() >= deadline {
            return Err(chunk_refusal);
        }
    }
    Ok(())
}

/// Take ownership of every descriptor the kernel attached, then decide.
///
/// **Ownership must precede judgement.** `MSG_CTRUNC` does not mean the kernel
/// delivered nothing: it installs as many descriptors as the control buffer
/// holds and closes only the remainder. Refusing before wrapping the installed
/// ones in `OwnedFd` therefore leaks them into the host process, and because
/// the accept loop runs forever, an authenticated peer could repeat one
/// oversized frame until the descriptor table is exhausted. The same reasoning
/// applies to a malformed payload length: whole descriptors that are already
/// installed are taken first, and only then is the frame refused.
#[cfg(target_os = "linux")]
fn collect_attached_descriptors(
    message: &libc::msghdr,
    descriptors: &mut Vec<OwnedFd>,
) -> Result<(), PlanAdmissionIngressRefusal> {
    let taken = take_attached_descriptors(message, descriptors);
    if message.msg_flags & libc::MSG_CTRUNC != 0 {
        // Whatever fit is now owned above and will be closed; the sender asked
        // for more than one content object, so the request is unresolvable.
        return Err(PlanAdmissionIngressRefusal::ContentDescriptorAmbiguous);
    }
    taken
}

#[cfg(target_os = "linux")]
fn take_attached_descriptors(
    message: &libc::msghdr,
    descriptors: &mut Vec<OwnedFd>,
) -> Result<(), PlanAdmissionIngressRefusal> {
    let header = unsafe { libc::CMSG_FIRSTHDR(message) };
    if header.is_null() {
        return Ok(());
    }
    let (level, kind, length) = unsafe {
        (
            (*header).cmsg_level,
            (*header).cmsg_type,
            (*header).cmsg_len,
        )
    };
    if level != libc::SOL_SOCKET || kind != libc::SCM_RIGHTS {
        // Not a descriptor payload, so there is nothing installed to take.
        return Err(PlanAdmissionIngressRefusal::ContentDescriptorAmbiguous);
    }
    let payload_length = length.saturating_sub(unsafe { libc::CMSG_LEN(0) } as usize);
    let data = unsafe { libc::CMSG_DATA(header) }.cast::<libc::c_int>();
    for index in 0..payload_length / std::mem::size_of::<libc::c_int>() {
        let raw: RawFd = unsafe { std::ptr::read_unaligned(data.add(index)) };
        descriptors.push(unsafe { OwnedFd::from_raw_fd(raw) });
    }
    if payload_length == 0 || payload_length % std::mem::size_of::<libc::c_int>() != 0 {
        return Err(PlanAdmissionIngressRefusal::ContentDescriptorAmbiguous);
    }
    Ok(())
}

/// Read the compiled plan bytes out of a descriptor that is provably immutable.
///
/// The kind check runs before the seal check so both refusals stay reachable: a
/// descriptor that is not a regular file cannot carry seals at all, and reading
/// "not sealed" for a socket would collapse two different mistakes into one.
///
/// The read is positional. The received descriptor shares its file description
/// — and therefore its file offset — with the sender, so an offset the sender
/// happened to leave behind must not decide which bytes the host hashes.
#[cfg(target_os = "linux")]
fn read_sealed_plan_content(descriptor: &OwnedFd) -> Result<Vec<u8>, PlanAdmissionIngressRefusal> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
    if unsafe { libc::fstat(descriptor.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
        return Err(PlanAdmissionIngressRefusal::ContentReadFailed);
    }
    let stat = unsafe { stat.assume_init() };
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(PlanAdmissionIngressRefusal::ContentDescriptorNotRegularFile);
    }

    let seals = unsafe { libc::fcntl(descriptor.as_raw_fd(), libc::F_GET_SEALS) };
    if seals < 0 || seals & REQUIRED_CONTENT_SEALS != REQUIRED_CONTENT_SEALS {
        return Err(PlanAdmissionIngressRefusal::ContentDescriptorNotSealed);
    }

    if stat.st_size <= 0 {
        return Err(PlanAdmissionIngressRefusal::ContentEmpty);
    }
    let length = stat.st_size as u64;
    if length > MAX_PLAN_ADMISSION_CONTENT_BYTES {
        return Err(PlanAdmissionIngressRefusal::ContentTooLarge);
    }

    let mut bytes = vec![0_u8; length as usize];
    let mut filled = 0;
    while filled < bytes.len() {
        let read = unsafe {
            libc::pread(
                descriptor.as_raw_fd(),
                bytes[filled..].as_mut_ptr().cast(),
                bytes.len() - filled,
                filled as libc::off_t,
            )
        };
        if read <= 0 {
            return Err(PlanAdmissionIngressRefusal::ContentReadFailed);
        }
        filled += read as usize;
    }
    Ok(bytes)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::confinement::BrokerHostConfinementErrorV1;
    use std::io::Read;
    use std::os::fd::IntoRawFd;

    const MFD_CLOEXEC: libc::c_uint = 0x0001;
    const MFD_ALLOW_SEALING: libc::c_uint = 0x0002;

    fn current_uid() -> u32 {
        unsafe { libc::geteuid() }
    }

    /// A policy whose broker identity is distinct from this process, so a
    /// same-process socket peer is a *configured client*, and an attestation
    /// fabricated for that configured broker identity.
    fn client_policy(
        role: BrokerAuthorityRoleV1,
    ) -> (
        BrokerHostConfinementPolicyV1,
        BrokerHostConfinementAttestationV1,
    ) {
        let broker_uid = current_uid().checked_add(1).expect("a distinct broker uid");
        let policy = BrokerHostConfinementPolicyV1::new_for_role(broker_uid, role, [current_uid()])
            .expect("the current uid is a distinct configured client");
        let attestation = policy.attestation_for_same_process_socket_tests();
        (policy, attestation)
    }

    fn memfd(bytes: &[u8], sealed: bool) -> OwnedFd {
        named_memfd("bp-plan-admission-test", bytes, sealed)
    }

    fn named_memfd(name: &str, bytes: &[u8], sealed: bool) -> OwnedFd {
        let name = std::ffi::CString::new(name).unwrap();
        let raw = unsafe { libc::memfd_create(name.as_ptr(), MFD_CLOEXEC | MFD_ALLOW_SEALING) };
        assert!(raw >= 0, "memfd_create must succeed on Linux");
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        if !bytes.is_empty() {
            let written =
                unsafe { libc::pwrite(fd.as_raw_fd(), bytes.as_ptr().cast(), bytes.len(), 0) };
            assert_eq!(written, bytes.len() as isize, "the whole object is written");
        }
        if sealed {
            let sealed =
                unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_ADD_SEALS, REQUIRED_CONTENT_SEALS) };
            assert_eq!(sealed, 0, "the test object seals");
        }
        fd
    }

    fn send_frame(stream: &UnixStream, payload: &[u8], descriptors: &[RawFd]) {
        let header = (payload.len() as u32).to_be_bytes();
        send_with_descriptors(stream, &header, descriptors);
        if !payload.is_empty() {
            send_with_descriptors(stream, payload, &[]);
        }
    }

    fn send_with_descriptors(stream: &UnixStream, bytes: &[u8], descriptors: &[RawFd]) {
        let mut iov = libc::iovec {
            iov_base: bytes.as_ptr() as *mut libc::c_void,
            iov_len: bytes.len(),
        };
        let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
        message.msg_iov = std::ptr::addr_of_mut!(iov);
        message.msg_iovlen = 1;
        let control_bytes =
            unsafe { libc::CMSG_SPACE((descriptors.len() * size_of::<libc::c_int>()) as u32) }
                as usize;
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
                    libc::CMSG_LEN((descriptors.len() * size_of::<libc::c_int>()) as u32) as usize;
                std::ptr::copy_nonoverlapping(
                    descriptors.as_ptr(),
                    libc::CMSG_DATA(header).cast::<libc::c_int>(),
                    descriptors.len(),
                );
            }
        }
        let sent = unsafe { libc::sendmsg(stream.as_raw_fd(), &message, 0) };
        assert_eq!(sent, bytes.len() as isize, "the whole chunk is sent");
    }

    fn plan_frame() -> Vec<u8> {
        br#"{"schema_version":1,"request_id":"01919000-0000-7000-8000-0000000000f1","run_id":"01919000-0000-7000-8000-0000000000e1","plan_content_ref":"cas://sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","asserted":{"validation_status":"PASS","plan_digest":"sha256:cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd","idempotency_key":"planforge:v0:buildplane:deadbeef:abcd1234"}}"#.to_vec()
    }

    #[test]
    fn an_authenticated_peer_delivers_one_frame_and_its_sealed_content() {
        let (policy, attestation) = client_policy(BrokerAuthorityRoleV1::PlanAdmission);
        let (client, mut server) = UnixStream::pair().unwrap();
        let content =
            b"## Title\nIngress\n\n## Goal\nStage bytes over the authenticated channel.\n";
        let object = memfd(content, true);
        send_frame(&client, &plan_frame(), &[object.as_raw_fd()]);
        drop(object);
        drop(client);

        let staged =
            read_authenticated_plan_admission_ingress(&policy, &attestation, &mut server).unwrap();
        assert_eq!(
            staged.request.request_id.hyphenated().to_string(),
            "01919000-0000-7000-8000-0000000000f1"
        );
        assert_eq!(staged.request.asserted_validation_status, "PASS");
        assert_eq!(staged.plan_bytes, content.to_vec());
        assert_eq!(staged.peer_uid, current_uid());
    }

    #[test]
    fn role_verification_precedes_every_frame_byte_read() {
        // The policy is bound to a different endpoint, so this connection is
        // refused for the plan-admission role. The frame is already queued in
        // the socket when the handler runs; if the handler had read anything,
        // the bytes below would be missing.
        let (policy, attestation) = client_policy(BrokerAuthorityRoleV1::PromotionDecision);
        let (client, mut server) = UnixStream::pair().unwrap();
        let object = memfd(b"queued content", true);
        send_frame(&client, &plan_frame(), &[object.as_raw_fd()]);
        drop(object);
        drop(client);

        assert_eq!(
            read_authenticated_plan_admission_ingress_detailed(&policy, &attestation, &mut server),
            Err(PlanAdmissionIngressRefusal::PeerRejected)
        );

        let mut unread = Vec::new();
        server.read_to_end(&mut unread).unwrap();
        let expected_frame = plan_frame();
        let mut expected = (expected_frame.len() as u32).to_be_bytes().to_vec();
        expected.extend_from_slice(&expected_frame);
        assert_eq!(
            unread, expected,
            "a refused peer must not have consumed a single frame byte"
        );
    }

    #[test]
    fn an_unconfigured_client_uid_is_refused_before_any_frame_read() {
        let broker_uid = current_uid().checked_add(1).unwrap();
        let unrelated_uid = current_uid().checked_add(2).unwrap();
        let policy = BrokerHostConfinementPolicyV1::new_for_role(
            broker_uid,
            BrokerAuthorityRoleV1::PlanAdmission,
            [unrelated_uid],
        )
        .unwrap();
        let attestation = policy.attestation_for_same_process_socket_tests();
        let (client, mut server) = UnixStream::pair().unwrap();
        let object = memfd(b"queued content", true);
        send_frame(&client, &plan_frame(), &[object.as_raw_fd()]);
        drop(object);
        drop(client);

        assert_eq!(
            read_authenticated_plan_admission_ingress_detailed(&policy, &attestation, &mut server),
            Err(PlanAdmissionIngressRefusal::PeerRejected)
        );
    }

    #[test]
    fn a_peer_that_aliases_the_broker_uid_is_refused() {
        // Configure the broker as this process, so the same-process peer is the
        // broker itself rather than a separate client principal.
        let client_uid = current_uid().checked_add(1).unwrap();
        let policy = BrokerHostConfinementPolicyV1::new_for_role(
            current_uid(),
            BrokerAuthorityRoleV1::PlanAdmission,
            [client_uid],
        )
        .unwrap();
        let attestation = policy.attestation_for_same_process_socket_tests();
        let (client, mut server) = UnixStream::pair().unwrap();
        let object = memfd(b"queued content", true);
        send_frame(&client, &plan_frame(), &[object.as_raw_fd()]);
        drop(object);
        drop(client);

        assert_eq!(
            read_authenticated_plan_admission_ingress_detailed(&policy, &attestation, &mut server),
            Err(PlanAdmissionIngressRefusal::PeerRejected)
        );
    }

    #[test]
    fn uid_zero_can_never_become_a_plan_admission_principal() {
        assert!(matches!(
            BrokerHostConfinementPolicyV1::new_for_role(
                0,
                BrokerAuthorityRoleV1::PlanAdmission,
                [1_001],
            ),
            Err(BrokerHostConfinementErrorV1::UidZeroNotAllowed { uid: 0 })
        ));
        assert!(matches!(
            BrokerHostConfinementPolicyV1::new_for_role(
                1_000,
                BrokerAuthorityRoleV1::PlanAdmission,
                [0],
            ),
            Err(BrokerHostConfinementErrorV1::UidZeroNotAllowed { uid: 0 })
        ));
        assert!(matches!(
            BrokerHostConfinementPolicyV1::new_for_role(
                1_000,
                BrokerAuthorityRoleV1::PlanAdmission,
                [1_000],
            ),
            Err(BrokerHostConfinementErrorV1::WorkerUidAliasesBroker { uid: 1_000 })
        ));
    }

    #[test]
    fn a_frame_that_carries_no_content_descriptor_is_refused() {
        let (policy, attestation) = client_policy(BrokerAuthorityRoleV1::PlanAdmission);
        let (client, mut server) = UnixStream::pair().unwrap();
        send_frame(&client, &plan_frame(), &[]);
        drop(client);

        assert_eq!(
            read_authenticated_plan_admission_ingress_detailed(&policy, &attestation, &mut server),
            Err(PlanAdmissionIngressRefusal::ContentDescriptorMissing)
        );
    }

    #[test]
    fn a_frame_that_carries_more_than_one_descriptor_is_refused() {
        let (policy, attestation) = client_policy(BrokerAuthorityRoleV1::PlanAdmission);
        let (client, mut server) = UnixStream::pair().unwrap();
        let first = memfd(b"first object", true);
        let second = memfd(b"second object", true);
        send_frame(
            &client,
            &plan_frame(),
            &[first.as_raw_fd(), second.as_raw_fd()],
        );
        drop(first);
        drop(second);
        drop(client);

        assert_eq!(
            read_authenticated_plan_admission_ingress_detailed(&policy, &attestation, &mut server),
            Err(PlanAdmissionIngressRefusal::ContentDescriptorAmbiguous)
        );
    }

    /// Count this process's open descriptors that name one specific memfd.
    ///
    /// `/proc/self/fd` is process-global and cargo runs these tests on many
    /// threads, so a bare count races against every sibling test. A memfd's
    /// link target carries the name it was created with, so counting only a
    /// tag no other test uses makes the measurement exact and race-free.
    fn open_descriptors_naming(tag: &str) -> usize {
        std::fs::read_dir("/proc/self/fd")
            .expect("/proc/self/fd is readable on Linux")
            .filter_map(Result::ok)
            .filter(|entry| {
                std::fs::read_link(entry.path())
                    .map(|target| target.to_string_lossy().contains(tag))
                    .unwrap_or(false)
            })
            .count()
    }

    /// A frame carrying more descriptors than the control buffer can hold sets
    /// `MSG_CTRUNC` — but Linux still **installs as many as fit** and closes only
    /// the remainder. Refusing before taking ownership of the installed ones
    /// leaks them, and `serve_sequential_connections` accepts forever, so any
    /// authenticated peer could exhaust the host's descriptor table by repeating
    /// this frame.
    #[test]
    fn a_truncated_descriptor_frame_refuses_without_leaking_the_installed_ones() {
        const TAG: &str = "bp-plan-admission-leak-probe";
        let (policy, attestation) = client_policy(BrokerAuthorityRoleV1::PlanAdmission);
        let (client, mut server) = UnixStream::pair().unwrap();
        let first = named_memfd(TAG, b"first object", true);
        let second = named_memfd(TAG, b"second object", true);
        let third = named_memfd(TAG, b"third object", true);
        send_frame(
            &client,
            &plan_frame(),
            &[first.as_raw_fd(), second.as_raw_fd(), third.as_raw_fd()],
        );
        drop(first);
        drop(second);
        drop(third);
        drop(client);

        // Descriptors in flight live in the kernel's socket buffer, not in this
        // process's table, until `recvmsg` installs them — so the leak is only
        // observable after the call.
        assert_eq!(
            open_descriptors_naming(TAG),
            0,
            "the sender's own descriptors are closed before the handler runs"
        );
        // Asserting the variant is what keeps the count assertion honest: it
        // proves the kernel really did truncate, so descriptors really were
        // installed, so a zero count afterwards means released and not
        // never-delivered.
        assert_eq!(
            read_authenticated_plan_admission_ingress_detailed(&policy, &attestation, &mut server),
            Err(PlanAdmissionIngressRefusal::ContentDescriptorAmbiguous)
        );
        assert_eq!(
            open_descriptors_naming(TAG),
            0,
            "a truncated descriptor frame must close every descriptor the kernel installed"
        );
    }

    #[test]
    fn an_unsealed_content_descriptor_is_refused() {
        let (policy, attestation) = client_policy(BrokerAuthorityRoleV1::PlanAdmission);
        let (client, mut server) = UnixStream::pair().unwrap();
        let object = memfd(b"still writable by the sender", false);
        send_frame(&client, &plan_frame(), &[object.as_raw_fd()]);
        drop(object);
        drop(client);

        assert_eq!(
            read_authenticated_plan_admission_ingress_detailed(&policy, &attestation, &mut server),
            Err(PlanAdmissionIngressRefusal::ContentDescriptorNotSealed)
        );
    }

    #[test]
    fn a_descriptor_that_is_not_a_regular_object_is_refused() {
        let (policy, attestation) = client_policy(BrokerAuthorityRoleV1::PlanAdmission);
        let (client, mut server) = UnixStream::pair().unwrap();
        // A socket has no content and cannot carry seals, so it can never
        // satisfy the content immutability requirement.
        let (unrelated, _held) = UnixStream::pair().unwrap();
        let raw = unrelated.into_raw_fd();
        send_frame(&client, &plan_frame(), &[raw]);
        unsafe { libc::close(raw) };
        drop(client);

        assert_eq!(
            read_authenticated_plan_admission_ingress_detailed(&policy, &attestation, &mut server),
            Err(PlanAdmissionIngressRefusal::ContentDescriptorNotRegularFile)
        );
    }

    #[test]
    fn an_empty_content_object_is_refused() {
        let (policy, attestation) = client_policy(BrokerAuthorityRoleV1::PlanAdmission);
        let (client, mut server) = UnixStream::pair().unwrap();
        let object = memfd(b"", true);
        send_frame(&client, &plan_frame(), &[object.as_raw_fd()]);
        drop(object);
        drop(client);

        assert_eq!(
            read_authenticated_plan_admission_ingress_detailed(&policy, &attestation, &mut server),
            Err(PlanAdmissionIngressRefusal::ContentEmpty)
        );
    }

    #[test]
    fn oversized_content_is_refused_before_it_is_read() {
        let (policy, attestation) = client_policy(BrokerAuthorityRoleV1::PlanAdmission);
        let (client, mut server) = UnixStream::pair().unwrap();
        let oversized = vec![b'x'; MAX_PLAN_ADMISSION_CONTENT_BYTES as usize + 1];
        let object = memfd(&oversized, true);
        send_frame(&client, &plan_frame(), &[object.as_raw_fd()]);
        drop(object);
        drop(client);

        assert_eq!(
            read_authenticated_plan_admission_ingress_detailed(&policy, &attestation, &mut server),
            Err(PlanAdmissionIngressRefusal::ContentTooLarge)
        );
    }

    #[test]
    fn a_zero_length_or_oversized_frame_header_is_refused() {
        for declared in [0_u32, MAX_PLAN_ADMISSION_FRAME_BYTES as u32 + 1] {
            let (policy, attestation) = client_policy(BrokerAuthorityRoleV1::PlanAdmission);
            let (client, mut server) = UnixStream::pair().unwrap();
            let object = memfd(b"content", true);
            send_with_descriptors(&client, &declared.to_be_bytes(), &[object.as_raw_fd()]);
            drop(object);
            drop(client);

            assert_eq!(
                read_authenticated_plan_admission_ingress_detailed(
                    &policy,
                    &attestation,
                    &mut server
                ),
                Err(PlanAdmissionIngressRefusal::FrameHeaderRejected),
                "a {declared}-byte frame declaration must be refused"
            );
        }
    }

    #[test]
    fn a_truncated_frame_body_is_refused() {
        let (policy, attestation) = client_policy(BrokerAuthorityRoleV1::PlanAdmission);
        let (client, mut server) = UnixStream::pair().unwrap();
        let object = memfd(b"content", true);
        send_with_descriptors(&client, &64_u32.to_be_bytes(), &[object.as_raw_fd()]);
        send_with_descriptors(&client, b"short", &[]);
        drop(object);
        drop(client);

        assert_eq!(
            read_authenticated_plan_admission_ingress_detailed(&policy, &attestation, &mut server),
            Err(PlanAdmissionIngressRefusal::FrameBodyRejected)
        );
    }

    #[test]
    fn every_ingress_refusal_collapses_to_the_closed_wire_vocabulary() {
        for refusal in [
            PlanAdmissionIngressRefusal::PeerRejected,
            PlanAdmissionIngressRefusal::FrameHeaderRejected,
            PlanAdmissionIngressRefusal::FrameBodyRejected,
            PlanAdmissionIngressRefusal::ContentDescriptorMissing,
            PlanAdmissionIngressRefusal::ContentDescriptorAmbiguous,
            PlanAdmissionIngressRefusal::ContentDescriptorNotSealed,
            PlanAdmissionIngressRefusal::ContentDescriptorNotRegularFile,
            PlanAdmissionIngressRefusal::ContentEmpty,
            PlanAdmissionIngressRefusal::ContentTooLarge,
            PlanAdmissionIngressRefusal::ContentReadFailed,
            PlanAdmissionIngressRefusal::RequestNotClosed,
            PlanAdmissionIngressRefusal::RequestIdentifiersRejected,
        ] {
            let wire = PlanAdmissionHandlerError::from(refusal);
            let expected = match refusal {
                PlanAdmissionIngressRefusal::PeerRejected => {
                    PlanAdmissionHandlerError::PeerRejected
                }
                PlanAdmissionIngressRefusal::RequestNotClosed
                | PlanAdmissionIngressRefusal::RequestIdentifiersRejected => {
                    PlanAdmissionHandlerError::RequestRejected
                }
                _ => PlanAdmissionHandlerError::FrameRejected,
            };
            assert_eq!(wire, expected);
            assert!(
                !wire.to_string().contains("seal") && !wire.to_string().contains("descriptor"),
                "the wire vocabulary must not disclose which internal check failed"
            );
        }
    }
}
