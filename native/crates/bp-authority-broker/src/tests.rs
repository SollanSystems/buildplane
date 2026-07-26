use super::admission_protocol::ParsedAuthorityBrokerOpenReviewerSessionRequestV1;
use super::confinement::{BrokerHostConfinementErrorV1, BrokerHostConfinementPolicyV1};
use super::dispatch_admission::{
    BrokerDispatchAdmissionAuthority, BrokerDispatchAdmissionDisposition, DispatchAdmissionBackend,
    DispatchAdmissionBackendError, DispatchAdmissionRequestResolver,
    DispatchAdmissionResolverError, DispatchAdmissionSnapshotError,
    DispatchAdmissionSnapshotVerifier, LedgerDispatchAdmissionBackend, ResolvedDispatchAdmission,
    SealedDispatchAdmissionEvidence, TrustedDispatchAdmissionSnapshotVerifier,
};
use super::governed_reviewer_authority::{
    execute_governed_reviewer_run_v1, open_governed_reviewer_session_v1,
    resolve_governed_reviewer_run_v1, GovernedReviewerAuthorityErrorV1,
};
use super::governed_session_token::issue_recovery_token_v1;
use super::promotion_decision_handler::{
    handle_promotion_decision_wire, parse_promotion_decision_request, PromotionDecisionHandlerError,
};
use super::promotion_execution::{
    BrokerPromotionExecutionAuthority, BrokerPromotionExecutionRequest,
    BrokerPromotionExecutionStatus, PromotionEffectGateway, PromotionExecutionBackend,
    PromotionExecutionError, PromotionExecutionGrant, PromotionReplaySnapshotVerifier,
    PromotionResultDisposition, TrustedPromotionBinding, TrustedPromotionVerifier,
};
use super::promotion_execution_handler::{
    handle_promotion_execution_wire_for_tests, parse_promotion_execution_request,
    PromotionExecutionHandlerError,
};
use super::promotion_git::{
    PromotionCapabilityError, PromotionGitError, PromotionGitGateway, PromotionGitOutcome,
    TestFixedGitRunner, TestGitOperation, TestGitOutput, VerifiedPromotionCapability,
};
use super::reviewer_session::{
    resolve_reviewer_model_evidence_for_candidate_recovery_v1,
    resolve_reviewer_model_evidence_from_snapshot_v1, ReviewerSessionResolutionErrorV1,
};
use super::v5_dispatch_admission::{
    handle_v5_dispatch_admission_wire, parse_v5_dispatch_admission_request,
    BrokerV5DispatchAdmissionDisposition, LedgerV5DispatchAdmissionBackend,
    V5DispatchAdmissionHandlerError, V5DispatchAdmissionRequest, V5DispatchAdmissionStartupError,
};
use super::{
    AuthorityBackend, AuthorityBackendError, AuthorityGrant, BrokerModelActionRequest,
    BrokerModelActionStatus, BrokerModelAuthority, BrokerPromotionDecisionAuthority,
    BrokerPromotionDecisionDisposition, BrokerPromotionDecisionStartupError,
    BrokerPromotionReconciliationDisposition, BrokerPromotionReconciliationIngressRequest,
    BrokerPromotionReconciliationStartupError, CredentialGateway, GatewayCompletion, LeasePolicy,
    PairedGatewayResult, PrivateModelCapability, ProtectedPromotionDecisionAuthority,
    ProtectedPromotionReconciliationAuthority, ReplaySnapshotVerifier, ResultDisposition,
    TrustedReplayBinding, TrustedReplayVerificationError, TrustedReplayVerifier,
};
use bp_ledger::canonicalize::canonical_event_hash;
use bp_ledger::event::Event;
use bp_ledger::kind::EventKind;
use bp_ledger::payload::activity::{ActivityStartedV1, ActivityType};
use bp_ledger::payload::activity_claim::{
    ActivityClaimPurposeV1, ActivityClaimedV1, ActivityHeartbeatRecordedV1,
    ActivityResultOutcomeV1, ActivityResultRecordedV1,
};
use bp_ledger::payload::run_lifecycle::RunStartedV1;
use bp_ledger::payload::trust_spine::{
    action_receipt_recorded_v2_digest, action_receipt_set_v1_digest, action_requested_v2_digest,
    candidate_completion_recorded_v1_digest, candidate_view_v1_digest,
    context_manifest_content_v1_digest, dispatch_envelope_v3_body_digest,
    dispatch_envelope_v4_digest, dispatch_envelope_v5_digest, governed_dispatch_policy_digest_v1,
    model_action_authorized_v2_digest, model_action_intent_v1_digest,
    review_verdict_output_v1_digest, sandbox_profile_content_v1_digest,
    worker_manifest_content_v1_digest, workflow_graph_v2_digest, ActionEvidenceVersionV1,
    ActionFailureV1, ActionKindV1, ActionReceiptOutcomeV2, ActionReceiptRecordedV2,
    ActionReceiptSetEntryV1, ActionReceiptSetRecordedV1, ActionRequestedV2, ActionResourceUsageV1,
    CandidateAcceptanceOutcomeV1, CandidateAcceptanceRecordedV1, CandidateCompletionRecordedV1,
    CandidateCreatedV2, CandidateViewV1, CommitModeV1, ContextManifestContentV1,
    ContextManifestDeclaredV1, ContextManifestEntryKindV1, ContextManifestEntryV1, ContextTaintV1,
    ContextTrustLevelV1, DispatchBudgetV1, DispatchEnvelopeBodyV2, DispatchEnvelopeV3,
    DispatchEnvelopeV4, DispatchEnvelopeV5, ExecutionRoleV1, ModelActionAuthorizedV2,
    ModelActionCandidateBindingV1, ModelActionIntentV1, ModelRequestEvidenceV1,
    PromotionApprovalRequestedV1, PromotionDecisionKindV1, PromotionExecutionClaimedV1,
    PromotionExecutionLeaseBindingV1, PromotionGitBindingV1, PromotionResultOutcomeV1,
    PromotionWorktreeSyncStateV1, ReconciliationResolutionOutcomeV1, ReviewDecisionV1,
    ReviewVerdictOutputV1, ReviewVerdictRecordedV2, SandboxProfileContentV1,
    SandboxProfileDeclaredV1, SandboxRuntimeV1, TrustScopeEvidenceV1, TrustTierV1, WorkerHarnessV1,
    WorkerManifestContentV1, WorkerManifestDeclaredV1, WorkerProviderV1,
    WorkflowCancellationCauseV1, WorkflowCancellationRequestedV1, WorkflowGraphDeclaredV2,
    WorkflowGraphNodeV2, WorkflowTerminalOutcomeV1, WorkflowTerminalV2,
    MODEL_REQUEST_EVIDENCE_V1_SCHEMA_VERSION, TRUST_SCOPE_EVIDENCE_V1_SCHEMA_VERSION,
};
use bp_ledger::payload::Payload;
use bp_ledger::signing::{public_key_hash, sign_event, ActorKeyRef, TrustedPublicKeys};
use bp_ledger::storage::sqlite::{
    CheckpointPolicy, GovernedCandidateCompletionDispositionV1,
    GovernedCandidateCompletionRequestV1, GovernedDispatchAdmissionAuthorityV1,
    GovernedDispatchAdmissionRequestV1, GovernedDispatchV5AdmissionAuthorityV1,
    GovernedPromotionAuthorityV1, GovernedPromotionDecisionRequestV1,
    GovernedPromotionExecutionClaimDispositionV1, GovernedPromotionExecutionClaimRequestV1,
    GovernedPromotionReconciliationDispositionV1, GovernedPromotionReconciliationRequestV1,
    GovernedPromotionResultDispositionV1, GovernedPromotionResultRequestV1, SqliteStore,
};
use bp_ledger::{EventId, LedgerError, RunId};
use bp_replay::{
    engine::EngineError, reader::ReaderError,
    trusted_recovery::TRUSTED_GOVERNED_RECOVERY_MAX_EVENTS_V1, TrustSpineSignerRole,
    TrustedGovernedRecoveryError, TrustedGovernedRecoverySnapshot, TrustedReplayAuthorities,
    WorkflowPhaseV1,
};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use ed25519_dalek::SigningKey;
use std::cell::RefCell;
use std::collections::VecDeque;
use std::fs;
use std::path::PathBuf;
use std::rc::Rc;
use tempfile::TempDir;

const MIN_LEASE_MS: u64 = 1_000;
const MAX_LEASE_MS: u64 = 15 * 60 * 1_000;
const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST_C: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const DIGEST_D: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const DIGEST_E: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const AUTHORITY_BROKER_TS_ADMISSION_DIGEST: &str =
    "sha256:a8eba84025a9f3b6c6d44a9b4fe8446de7c9d7b75cfa335a6e83af202df38ed5";
const AUTHORITY_BROKER_TS_LOOKUP_DIGEST: &str =
    "sha256:157768414de8d5e557af7345a3fe28eb8e52b434da8bb732aef0af8372069978";
const AUTHORITY_BROKER_OPEN_REVIEWER_SESSION_DIGEST: &str =
    "sha256:63d67b9f5b70aebbab13f0ccac147ae308c2ad35ed3892b70a245e5e26c9a1ff";

fn authority_broker_digest(character: char) -> String {
    format!("sha256:{}", character.to_string().repeat(64))
}

/// This wire fixture is emitted by the TypeScript `admissionInput()` contract
/// in `apps/cli/test/governed-authority-broker-client.test.ts`. Its digest was
/// recorded by invoking the TypeScript request builder, not by native code.
fn authority_broker_admission_wire() -> String {
    format!(
        r#"{{"schema_version":1,"operation":"admit","request_id":"123e4567-e89b-12d3-a456-426614174000","request":{{"run_id":"123e4567-e89b-12d3-a456-426614174003","workflow_id":"workflow-trust-spine","workflow_revision":"v1","unit_id":"unit-admit","attempt":1,"idempotency_key":"workflow-trust-spine:unit-admit:1","repository_target_ref":"broker://repositories/trust-spine","expected_repository_binding_digest":"{binding_digest}","governed_packet_ref":"cas://packets/trust-spine/admit","governed_packet_digest":"{packet_digest}"}},"request_digest":"{request_digest}"}}"#,
        binding_digest = authority_broker_digest('f'),
        packet_digest = authority_broker_digest('2'),
        request_digest = AUTHORITY_BROKER_TS_ADMISSION_DIGEST,
    )
}

fn authority_broker_lookup_wire() -> String {
    format!(
        r#"{{"schema_version":1,"operation":"lookup_preauthorized","request_id":"123e4567-e89b-12d3-a456-426614174000","request":{{"run_id":"123e4567-e89b-12d3-a456-426614174003","workflow_id":"workflow-trust-spine","workflow_revision":"v1","unit_id":"unit-admit","attempt":1,"idempotency_key":"workflow-trust-spine:unit-admit:1","repository_target_ref":"broker://repositories/trust-spine","expected_repository_binding_digest":"{binding_digest}","preauthorization_ref":"broker://preauthorizations/approved-123","governed_packet_ref":"cas://packets/trust-spine/admit","governed_packet_digest":"{packet_digest}"}},"request_digest":"{request_digest}"}}"#,
        binding_digest = authority_broker_digest('f'),
        packet_digest = authority_broker_digest('2'),
        request_digest = AUTHORITY_BROKER_TS_LOOKUP_DIGEST,
    )
}

/// A future protected host may send only opaque, digest-bound reviewer
/// activity claims, then must resolve them through trusted replay. This parser
/// fixture carries no candidate path, mount, prompt, tool, provider, secret,
/// verdict, or promotion input.
fn authority_broker_open_reviewer_session_wire() -> String {
    format!(
        r#"{{"schema_version":1,"operation":"open_reviewer_session","request_id":"123e4567-e89b-12d3-a456-426614174000","request":{{"run_id":"123e4567-e89b-12d3-a456-426614174003","reviewer_dispatch_event_ref":"123e4567-e89b-12d3-a456-426614174004","reviewer_action_request_event_ref":"123e4567-e89b-12d3-a456-426614174005"}},"request_digest":"{request_digest}"}}"#,
        request_digest = AUTHORITY_BROKER_OPEN_REVIEWER_SESSION_DIGEST,
    )
}

#[test]
fn authority_broker_parser_accepts_the_typescript_admission_fixture_digest() {
    let parsed = super::admission_protocol::parse_authority_broker_request_v1(
        authority_broker_admission_wire().as_bytes(),
    )
    .expect("the TypeScript admission fixture must have its recorded digest");

    assert!(matches!(
        parsed,
        super::admission_protocol::ParsedAuthorityBrokerRequestV1 {
            operation: super::admission_protocol::AuthorityBrokerOperationV1::Admit,
            request: super::admission_protocol::ParsedAuthorityBrokerRequestBodyV1::Admit(_),
            request_digest,
            ..
        } if request_digest == AUTHORITY_BROKER_TS_ADMISSION_DIGEST
    ));
}

#[test]
fn authority_broker_parser_accepts_the_typescript_lookup_contract() {
    let parsed = super::admission_protocol::parse_authority_broker_request_v1(
        authority_broker_lookup_wire().as_bytes(),
    )
    .expect("the TypeScript lookup fixture must have its recorded digest");

    assert!(matches!(
        parsed,
        super::admission_protocol::ParsedAuthorityBrokerRequestV1 {
            operation: super::admission_protocol::AuthorityBrokerOperationV1::LookupPreauthorized,
            request:
                super::admission_protocol::ParsedAuthorityBrokerRequestBodyV1::LookupPreauthorized(_),
            request_digest,
            ..
        } if request_digest == AUTHORITY_BROKER_TS_LOOKUP_DIGEST
    ));
}

#[test]
fn authority_broker_parser_accepts_only_opaque_reviewer_session_identity() {
    let parsed = super::admission_protocol::parse_authority_broker_request_v1(
        authority_broker_open_reviewer_session_wire().as_bytes(),
    )
    .expect("the closed reviewer-session request fixture must parse");

    assert!(matches!(
        parsed,
        super::admission_protocol::ParsedAuthorityBrokerRequestV1 {
            operation: super::admission_protocol::AuthorityBrokerOperationV1::OpenReviewerSession,
            request:
                super::admission_protocol::ParsedAuthorityBrokerRequestBodyV1::OpenReviewerSession(_),
            request_digest,
            ..
        } if request_digest == AUTHORITY_BROKER_OPEN_REVIEWER_SESSION_DIGEST
    ));
}

#[test]
fn authority_broker_parser_rejects_substituted_or_expanded_reviewer_session_requests() {
    let wrong_digest = authority_broker_open_reviewer_session_wire().replacen(
        AUTHORITY_BROKER_OPEN_REVIEWER_SESSION_DIGEST,
        authority_broker_digest('0').as_str(),
        1,
    );
    assert!(matches!(
        super::admission_protocol::parse_authority_broker_request_v1(wrong_digest.as_bytes()),
        Err(super::admission_protocol::AdmissionProtocolError::RequestDigestMismatch)
    ));

    let operation_substitution = authority_broker_admission_wire().replacen(
        r#""operation":"admit""#,
        r#""operation":"open_reviewer_session""#,
        1,
    );
    assert!(matches!(
        super::admission_protocol::parse_authority_broker_request_v1(
            operation_substitution.as_bytes()
        ),
        Err(super::admission_protocol::AdmissionProtocolError::OperationRequestMismatch)
    ));

    let extra_field = authority_broker_open_reviewer_session_wire().replacen(
        r#""reviewer_action_request_event_ref":"123e4567-e89b-12d3-a456-426614174005""#,
        r#""reviewer_action_request_event_ref":"123e4567-e89b-12d3-a456-426614174005","candidate_path":"/workspace/candidate""#,
        1,
    );
    assert!(matches!(
        super::admission_protocol::parse_authority_broker_request_v1(extra_field.as_bytes()),
        Err(super::admission_protocol::AdmissionProtocolError::Json(_))
    ));

    let invalid_event_ref = authority_broker_open_reviewer_session_wire().replacen(
        "123e4567-e89b-12d3-a456-426614174004",
        "not-a-canonical-event-id",
        1,
    );
    assert!(matches!(
        super::admission_protocol::parse_authority_broker_request_v1(invalid_event_ref.as_bytes()),
        Err(
            super::admission_protocol::AdmissionProtocolError::InvalidUuid {
                field: "reviewer_dispatch_event_ref"
            }
        )
    ));
}

#[test]
fn authority_broker_parser_rejects_noncanonical_integer_wire_spellings() {
    for (label, source, replacement) in [
        (
            "decimal schema version",
            r#""schema_version":1"#,
            r#""schema_version":1.0"#,
        ),
        (
            "exponent schema version",
            r#""schema_version":1"#,
            r#""schema_version":1e0"#,
        ),
        ("decimal attempt", r#""attempt":1"#, r#""attempt":1.0"#),
        ("exponent attempt", r#""attempt":1"#, r#""attempt":1e0"#),
    ] {
        let wire = authority_broker_admission_wire().replacen(source, replacement, 1);

        assert!(
            matches!(
                super::admission_protocol::parse_authority_broker_request_v1(wire.as_bytes()),
                Err(super::admission_protocol::AdmissionProtocolError::Json(_))
            ),
            "{label} must not normalize into a canonical integer request"
        );
    }
}

#[test]
fn authority_broker_parser_rejects_fractional_and_unsafe_attempt_values() {
    let fractional =
        authority_broker_admission_wire().replacen(r#""attempt":1"#, r#""attempt":1.5"#, 1);
    assert!(matches!(
        super::admission_protocol::parse_authority_broker_request_v1(fractional.as_bytes()),
        Err(super::admission_protocol::AdmissionProtocolError::Json(_))
    ));

    let unsafe_attempt = authority_broker_admission_wire().replacen(
        r#""attempt":1"#,
        r#""attempt":9007199254740992"#,
        1,
    );
    assert!(matches!(
        super::admission_protocol::parse_authority_broker_request_v1(unsafe_attempt.as_bytes()),
        Err(super::admission_protocol::AdmissionProtocolError::InvalidAttempt { field: "attempt" })
    ));
}

#[test]
fn authority_broker_parser_rejects_an_extra_outer_field() {
    let wire = authority_broker_admission_wire().replacen(
        r#","request_digest":"#,
        r#","unexpected_authority_input":"ignored","request_digest":"#,
        1,
    );

    assert!(matches!(
        super::admission_protocol::parse_authority_broker_request_v1(wire.as_bytes()),
        Err(super::admission_protocol::AdmissionProtocolError::Json(_))
    ));
}

#[test]
fn authority_broker_parser_rejects_a_request_digest_mismatch() {
    let wrong_digest = authority_broker_digest('0');
    let wire = authority_broker_admission_wire().replacen(
        AUTHORITY_BROKER_TS_ADMISSION_DIGEST,
        wrong_digest.as_str(),
        1,
    );

    assert!(matches!(
        super::admission_protocol::parse_authority_broker_request_v1(wire.as_bytes()),
        Err(super::admission_protocol::AdmissionProtocolError::RequestDigestMismatch)
    ));
}

#[test]
fn authority_broker_parser_rejects_a_path_shaped_opaque_reference() {
    let wire = authority_broker_admission_wire().replacen(
        "cas://packets/trust-spine/admit",
        "cas://C:/workspace/packet.json",
        1,
    );

    assert!(matches!(
        super::admission_protocol::parse_authority_broker_request_v1(wire.as_bytes()),
        Err(
            super::admission_protocol::AdmissionProtocolError::InvalidOpaqueReference {
                field: "governed_packet_ref"
            }
        )
    ));
}

#[test]
fn authority_broker_parser_rejects_an_admit_operation_with_a_lookup_body() {
    let wire = authority_broker_lookup_wire().replacen(
        r#""operation":"lookup_preauthorized""#,
        r#""operation":"admit""#,
        1,
    );

    assert!(matches!(
        super::admission_protocol::parse_authority_broker_request_v1(wire.as_bytes()),
        Err(super::admission_protocol::AdmissionProtocolError::OperationRequestMismatch)
    ));
}

#[test]
fn authority_broker_parser_accepts_only_bytes_and_returns_parsed_data() {
    type ParseResult = Result<
        super::admission_protocol::ParsedAuthorityBrokerRequestV1,
        super::admission_protocol::AdmissionProtocolError,
    >;

    let parser: fn(&[u8]) -> ParseResult =
        super::admission_protocol::parse_authority_broker_request_v1;
    assert!(parser(authority_broker_admission_wire().as_bytes()).is_ok());
}

#[cfg(target_os = "linux")]
#[test]
fn broker_host_confinement_rejects_a_same_uid_unix_socket_peer() {
    use std::os::unix::net::UnixStream;

    let broker_uid = unsafe { libc::geteuid() };
    let configured_worker_uid = broker_uid.checked_add(1).unwrap_or(broker_uid - 1);
    let policy = BrokerHostConfinementPolicyV1::new(broker_uid, [configured_worker_uid])
        .expect("a distinct configured worker identity is valid");
    let attestation = policy
        .attest_current_broker_process()
        .expect("the test process is the configured broker identity");
    let (broker_stream, _same_uid_worker_stream) =
        UnixStream::pair().expect("create a local Unix socket pair");

    assert!(matches!(
        policy.verify_linux_connected_worker(&attestation, &broker_stream),
        Err(BrokerHostConfinementErrorV1::PeerUsesBrokerUid { uid }) if uid == broker_uid
    ));
}

#[cfg(target_os = "linux")]
#[test]
fn broker_protocol_rejects_a_same_uid_peer_before_consuming_its_framed_request() {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    let broker_uid = unsafe { libc::geteuid() };
    let configured_worker_uid = broker_uid.checked_add(1).unwrap_or(broker_uid - 1);
    let policy = BrokerHostConfinementPolicyV1::new(broker_uid, [configured_worker_uid])
        .expect("a distinct configured worker identity is valid");
    let attestation = policy
        .attest_current_broker_process()
        .expect("the test process is the configured broker identity");
    let (mut broker_stream, mut same_uid_worker_stream) =
        UnixStream::pair().expect("create a local Unix socket pair");
    let payload = authority_broker_admission_wire().into_bytes();
    let mut frame = u32::try_from(payload.len())
        .expect("the canonical fixture fits the V1 frame length")
        .to_be_bytes()
        .to_vec();
    frame.extend_from_slice(&payload);
    same_uid_worker_stream
        .write_all(&frame)
        .expect("queue a valid-looking framed request");

    assert!(matches!(
        super::protocol::read_authenticated_authority_broker_request_v1(
            &policy,
            &attestation,
            &mut broker_stream,
        ),
        Err(super::protocol::BrokerProtocolErrorV1::PeerRejected)
    ));

    broker_stream
        .set_read_timeout(Some(Duration::from_millis(250)))
        .expect("bound an assertion failure if the gate consumed the frame");
    let mut observed = vec![0; frame.len()];
    broker_stream
        .read_exact(&mut observed)
        .expect("peer authentication must fail before any frame byte is read");
    assert_eq!(observed, frame);
}

#[cfg(target_os = "linux")]
#[test]
fn broker_host_confinement_rejects_an_attestation_from_a_different_policy() {
    use std::os::unix::net::UnixStream;

    let current_uid = unsafe { libc::geteuid() };
    let other_uid = current_uid.checked_add(1).unwrap_or(current_uid - 1);
    let broker_policy = BrokerHostConfinementPolicyV1::new(current_uid, [other_uid])
        .expect("a separately configured worker identity is valid");
    let attestation = broker_policy
        .attest_current_broker_process()
        .expect("the test process is the configured broker identity");
    let different_policy = BrokerHostConfinementPolicyV1::new(other_uid, [current_uid])
        .expect("the current process is a distinct configured worker for this policy");
    let (broker_stream, _worker_stream) =
        UnixStream::pair().expect("create a local Unix socket pair");

    let result = std::panic::catch_unwind(|| {
        different_policy.verify_linux_connected_worker(&attestation, &broker_stream)
    });
    assert!(matches!(
        result,
        Ok(Err(BrokerHostConfinementErrorV1::AttestationPolicyMismatch {
            attested_broker_uid,
            configured_broker_uid,
        })) if attested_broker_uid == current_uid && configured_broker_uid == other_uid
    ));
}

fn request() -> BrokerModelActionRequest {
    BrokerModelActionRequest {
        dispatch_event_id: EventId::new(),
        action_request_event_id: EventId::new(),
    }
}

fn bounded_recovery_error() -> TrustedGovernedRecoveryError {
    TrustedGovernedRecoveryError::Replay(EngineError::Reader(ReaderError::EventLimitExceeded {
        max_events: TRUSTED_GOVERNED_RECOVERY_MAX_EVENTS_V1,
    }))
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct VerifyCall {
    run_id: RunId,
    request: BrokerModelActionRequest,
}

struct FakeVerifier {
    calls: Rc<RefCell<Vec<VerifyCall>>>,
    results: VecDeque<Result<TrustedReplayBinding, TrustedReplayVerificationError>>,
}

impl TrustedReplayVerifier for FakeVerifier {
    fn verify_exact_action(
        &mut self,
        run_id: RunId,
        request: &BrokerModelActionRequest,
    ) -> Result<TrustedReplayBinding, TrustedReplayVerificationError> {
        self.calls.borrow_mut().push(VerifyCall {
            run_id,
            request: request.clone(),
        });
        self.results
            .pop_front()
            .expect("test configured a replay result")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AuthorizeCall {
    run_id: RunId,
    request: BrokerModelActionRequest,
    execution_role: ExecutionRoleV1,
    lease_duration_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ResultCall {
    run_id: RunId,
    lease_id: String,
    outcome: ActivityResultOutcomeV1,
    result_digest: Option<String>,
    result_ref: Option<String>,
    evidence_digest: String,
    evidence_ref: String,
}

#[derive(Default)]
struct BackendState {
    authorize_calls: Vec<AuthorizeCall>,
    result_calls: Vec<ResultCall>,
}

struct FakeBackend {
    state: Rc<RefCell<BackendState>>,
    grants: VecDeque<Result<AuthorityGrant, AuthorityBackendError>>,
    results: VecDeque<Result<ResultDisposition, AuthorityBackendError>>,
}

impl AuthorityBackend for FakeBackend {
    fn authorize_and_claim(
        &mut self,
        run_id: RunId,
        request: &BrokerModelActionRequest,
        execution_role: ExecutionRoleV1,
        lease_duration_ms: u64,
    ) -> Result<AuthorityGrant, AuthorityBackendError> {
        self.state.borrow_mut().authorize_calls.push(AuthorizeCall {
            run_id,
            request: request.clone(),
            execution_role,
            lease_duration_ms,
        });
        self.grants
            .pop_front()
            .expect("test configured an authorization disposition")
    }

    fn record_result(
        &mut self,
        run_id: RunId,
        lease_id: String,
        completion: GatewayCompletion,
    ) -> Result<ResultDisposition, AuthorityBackendError> {
        self.state.borrow_mut().result_calls.push(ResultCall {
            run_id,
            lease_id,
            outcome: completion.outcome,
            result_digest: completion.result_digest,
            result_ref: completion.result_ref,
            evidence_digest: completion.evidence_digest,
            evidence_ref: completion.evidence_ref,
        });
        self.results
            .pop_front()
            .expect("test configured a result disposition")
    }
}

#[derive(Default)]
struct GatewayState {
    calls: usize,
    capabilities: Vec<(RunId, EventId, EventId, ExecutionRoleV1, String)>,
}

struct FakeGateway {
    state: Rc<RefCell<GatewayState>>,
    completion: Option<GatewayCompletion>,
}

impl CredentialGateway for FakeGateway {
    fn invoke(&mut self, capability: PrivateModelCapability) -> PairedGatewayResult {
        let mut state = self.state.borrow_mut();
        state.calls += 1;
        state.capabilities.push((
            capability.run_id,
            capability.dispatch_event_id,
            capability.action_request_event_id,
            capability.execution_role,
            capability.authorization_ref.clone(),
        ));
        drop(state);
        capability.complete(
            self.completion
                .take()
                .expect("one-use capability invokes the gateway at most once"),
        )
    }
}

fn succeeded_completion() -> GatewayCompletion {
    GatewayCompletion {
        outcome: ActivityResultOutcomeV1::Succeeded,
        result_digest: Some(format!("sha256:{}", "11".repeat(32))),
        result_ref: Some("cas://model-result".into()),
        evidence_digest: format!("sha256:{}", "22".repeat(32)),
        evidence_ref: "cas://provider-evidence".into(),
    }
}

fn unknown_completion() -> GatewayCompletion {
    GatewayCompletion::unknown(
        format!("sha256:{}", "33".repeat(32)),
        "cas://provider-failure-evidence".into(),
    )
}

fn exact_binding(run_id: RunId, request: &BrokerModelActionRequest) -> TrustedReplayBinding {
    TrustedReplayBinding {
        run_id,
        dispatch_event_id: request.dispatch_event_id,
        action_request_event_id: request.action_request_event_id,
        dispatch_role: ExecutionRoleV1::Implementer,
        action_role: ExecutionRoleV1::Implementer,
        has_existing_claim: false,
    }
}

fn timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn kernel_signer() -> ActorKeyRef {
    ActorKeyRef {
        actor_id: "kernel".into(),
        key_id: "kernel-main".into(),
        public_key_hash: None,
    }
}

fn trusted_replay_authorities(key: &SigningKey) -> (TrustedReplayAuthorities, ActorKeyRef) {
    let hash = public_key_hash(&key.verifying_key());
    let pinned_kernel = ActorKeyRef {
        public_key_hash: Some(hash.clone()),
        ..kernel_signer()
    };
    let mut keys = TrustedPublicKeys::default();
    keys.insert_public_key(hash, key.verifying_key().to_bytes().to_vec());
    let mut authorities = TrustedReplayAuthorities::new(keys);
    authorities.allow_signer(TrustSpineSignerRole::Kernel, pinned_kernel.clone());
    (authorities, pinned_kernel)
}

fn checkpointed_dispatch(now: DateTime<Utc>) -> DispatchEnvelopeV3 {
    let body = DispatchEnvelopeBodyV2 {
        workflow_id: "workflow-1".into(),
        workflow_revision: "r1".into(),
        unit_id: "unit-1".into(),
        attempt: 1,
        execution_role: ExecutionRoleV1::Implementer,
        commit_mode: CommitModeV1::Atomic,
        provenance_ref: "admission:1".into(),
        base_commit_sha: "1".repeat(40),
        capability_bundle_digest: DIGEST_A.into(),
        acceptance_contract_digest: DIGEST_B.into(),
        context_manifest_digest: DIGEST_C.into(),
        worker_manifest_digest: DIGEST_D.into(),
        sandbox_profile_digest: DIGEST_E.into(),
        budget: DispatchBudgetV1 {
            max_tokens: Some(1_024),
            max_compute_time_ms: Some(10_000),
        },
        trust_tier: TrustTierV1::Governed,
        idempotency_key: "dispatch:workflow-1:unit-1:1".into(),
        issued_at: timestamp(now - Duration::seconds(1)),
        expires_at: timestamp(now + Duration::minutes(10)),
    };
    let action_evidence_version = ActionEvidenceVersionV1::SealedV3;
    let envelope_digest = dispatch_envelope_v3_body_digest(
        &body,
        action_evidence_version,
        DIGEST_A,
        DIGEST_B,
        Some(DIGEST_C),
    )
    .expect("canonical sealed V3 dispatch");
    DispatchEnvelopeV3 {
        body,
        action_evidence_version,
        repository_binding_digest: DIGEST_A.into(),
        ledger_authority_realm_digest: DIGEST_B.into(),
        governed_packet_digest: Some(DIGEST_C.into()),
        envelope_digest,
    }
}

fn checkpointed_action_request(
    run_id: RunId,
    dispatch: &DispatchEnvelopeV3,
    now: DateTime<Utc>,
) -> ActionRequestedV2 {
    ActionRequestedV2 {
        run_id: run_id.to_string(),
        workflow_id: dispatch.body.workflow_id.clone(),
        unit_id: dispatch.body.unit_id.clone(),
        attempt: dispatch.body.attempt,
        provenance_ref: dispatch.body.provenance_ref.clone(),
        action_id: "model-action-1".into(),
        idempotency_key: "action:model-action-1".into(),
        action_kind: ActionKindV1::Model,
        canonical_input_digest: DIGEST_D.into(),
        canonical_input_ref: "cas://canonical-model-input".into(),
        dispatch_envelope_digest: dispatch.envelope_digest.clone(),
        repository_binding_digest: dispatch.repository_binding_digest.clone(),
        ledger_authority_realm_digest: dispatch.ledger_authority_realm_digest.clone(),
        governed_packet_digest: dispatch.governed_packet_digest.clone(),
        capability_bundle_digest: dispatch.body.capability_bundle_digest.clone(),
        policy_digest: governed_dispatch_policy_digest_v1(
            &dispatch.body.acceptance_contract_digest,
        )
        .expect("derive sealed V3 action policy"),
        context_manifest_digest: dispatch.body.context_manifest_digest.clone(),
        worker_manifest_digest: dispatch.body.worker_manifest_digest.clone(),
        sandbox_profile_digest: dispatch.body.sandbox_profile_digest.clone(),
        authority_actor: "kernel".into(),
        execution_role: ExecutionRoleV1::Implementer,
        requested_at: timestamp(now),
    }
}

fn authority(
    run_id: RunId,
    request: &BrokerModelActionRequest,
    grants: impl IntoIterator<Item = Result<AuthorityGrant, AuthorityBackendError>>,
    results: impl IntoIterator<Item = Result<ResultDisposition, AuthorityBackendError>>,
    completion: GatewayCompletion,
) -> (
    BrokerModelAuthority<FakeVerifier, FakeBackend, FakeGateway>,
    Rc<RefCell<Vec<VerifyCall>>>,
    Rc<RefCell<BackendState>>,
    Rc<RefCell<GatewayState>>,
) {
    let verifier_calls = Rc::new(RefCell::new(Vec::new()));
    let backend_state = Rc::new(RefCell::new(BackendState::default()));
    let gateway_state = Rc::new(RefCell::new(GatewayState::default()));
    let verifier = FakeVerifier {
        calls: Rc::clone(&verifier_calls),
        results: [
            Ok(exact_binding(run_id, request)),
            Ok(exact_binding(run_id, request)),
        ]
        .into_iter()
        .collect(),
    };
    let backend = FakeBackend {
        state: Rc::clone(&backend_state),
        grants: grants.into_iter().collect(),
        results: results.into_iter().collect(),
    };
    let gateway = FakeGateway {
        state: Rc::clone(&gateway_state),
        completion: Some(completion),
    };
    (
        BrokerModelAuthority::new(
            run_id,
            verifier,
            backend,
            gateway,
            LeasePolicy::from_startup_config(30_000).expect("valid startup lease"),
        ),
        verifier_calls,
        backend_state,
        gateway_state,
    )
}

#[test]
fn lease_policy_is_validated_once_at_startup() {
    assert!(LeasePolicy::from_startup_config(MIN_LEASE_MS - 1).is_err());
    assert!(LeasePolicy::from_startup_config(MAX_LEASE_MS + 1).is_err());
    assert_eq!(
        LeasePolicy::from_startup_config(30_000)
            .expect("valid policy")
            .duration_ms(),
        30_000
    );
}

#[test]
fn verified_grant_moves_one_private_capability_and_pairs_the_gateway_result() {
    let run_id = RunId::new();
    let request = request();
    let (mut authority, verifier_calls, backend_state, gateway_state) = authority(
        run_id,
        &request,
        [Ok(AuthorityGrant::Granted {
            run_id,
            lease_id: "private-lease".into(),
            authorization_ref: "authorization://opaque".into(),
        })],
        [Ok(ResultDisposition::Recorded {
            run_id,
            outcome: ActivityResultOutcomeV1::Succeeded,
        })],
        succeeded_completion(),
    );

    assert_eq!(
        authority.authorize_and_execute(request.clone()).unwrap(),
        BrokerModelActionStatus::Recorded
    );
    assert_eq!(
        verifier_calls.borrow().as_slice(),
        &[VerifyCall {
            run_id,
            request: request.clone()
        }]
    );
    assert_eq!(gateway_state.borrow().calls, 1);
    assert_eq!(
        gateway_state.borrow().capabilities,
        vec![(
            run_id,
            request.dispatch_event_id,
            request.action_request_event_id,
            ExecutionRoleV1::Implementer,
            "authorization://opaque".into(),
        )]
    );
    assert_eq!(
        backend_state.borrow().authorize_calls[0].lease_duration_ms,
        30_000
    );
    assert_eq!(backend_state.borrow().result_calls.len(), 1);
    assert_eq!(
        backend_state.borrow().result_calls[0].lease_id,
        "private-lease"
    );
}

#[test]
fn checkpointed_sqlite_replay_gate_binds_the_exact_run_dispatch_and_model_action() {
    let temp = TempDir::new().expect("temporary ledger directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("open SQLite ledger");
    let run_id = RunId::new();
    let key = SigningKey::from_bytes(&[41; 32]);
    let (replay_authorities, pinned_kernel) = trusted_replay_authorities(&key);
    let now = DateTime::parse_from_rfc3339("2026-07-20T00:10:00.000Z")
        .expect("parse fixture timestamp")
        .with_timezone(&Utc);
    let dispatch = checkpointed_dispatch(now);
    let dispatch_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::DispatchEnvelopeV3,
        occurred_at: now - Duration::seconds(1),
        payload: Payload::DispatchEnvelopeV3(dispatch.clone()),
    };
    store
        .append_signed_with_checkpoint(
            &dispatch_event,
            &key,
            &kernel_signer(),
            &CheckpointPolicy::every(1),
        )
        .expect("append checkpointed dispatch");
    let action_event = Event {
        id: EventId::new(),
        run_id,
        parent_event_id: Some(dispatch_event.id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::ActionRequestedV2,
        occurred_at: now,
        payload: Payload::ActionRequestedV2(checkpointed_action_request(run_id, &dispatch, now)),
    };
    store
        .append_signed_with_checkpoint(
            &action_event,
            &key,
            &kernel_signer(),
            &CheckpointPolicy::every(1),
        )
        .expect("append checkpointed model action");

    let request = BrokerModelActionRequest {
        dispatch_event_id: dispatch_event.id,
        action_request_event_id: action_event.id,
    };
    let backend_state = Rc::new(RefCell::new(BackendState::default()));
    let gateway_state = Rc::new(RefCell::new(GatewayState::default()));
    let mut authority = BrokerModelAuthority::new(
        run_id,
        ReplaySnapshotVerifier::from_prevalidated_startup(
            &db_path,
            &replay_authorities,
            &pinned_kernel,
        ),
        FakeBackend {
            state: Rc::clone(&backend_state),
            grants: [Ok(AuthorityGrant::Granted {
                run_id,
                lease_id: "integration-lease".into(),
                authorization_ref: "authorization://integration".into(),
            })]
            .into_iter()
            .collect(),
            results: [Ok(ResultDisposition::Recorded {
                run_id,
                outcome: ActivityResultOutcomeV1::Succeeded,
            })]
            .into_iter()
            .collect(),
        },
        FakeGateway {
            state: Rc::clone(&gateway_state),
            completion: Some(succeeded_completion()),
        },
        LeasePolicy::from_startup_config(30_000).expect("valid startup lease"),
    );

    assert_eq!(
        authority.authorize_and_execute(request.clone()).unwrap(),
        BrokerModelActionStatus::Recorded
    );
    assert_eq!(gateway_state.borrow().calls, 1);
    assert_eq!(backend_state.borrow().authorize_calls.len(), 1);
    assert_eq!(backend_state.borrow().authorize_calls[0].run_id, run_id);
    assert_eq!(backend_state.borrow().authorize_calls[0].request, request);
}

#[test]
fn replay_mismatch_is_rejected_before_storage_or_gateway() {
    let run_id = RunId::new();
    let request = request();
    let verifier_calls = Rc::new(RefCell::new(Vec::new()));
    let backend_state = Rc::new(RefCell::new(BackendState::default()));
    let gateway_state = Rc::new(RefCell::new(GatewayState::default()));
    let verifier = FakeVerifier {
        calls: Rc::clone(&verifier_calls),
        results: [Ok(TrustedReplayBinding {
            run_id: RunId::new(),
            dispatch_event_id: request.dispatch_event_id,
            action_request_event_id: request.action_request_event_id,
            dispatch_role: ExecutionRoleV1::Implementer,
            action_role: ExecutionRoleV1::Implementer,
            has_existing_claim: false,
        })]
        .into_iter()
        .collect(),
    };
    let mut authority = BrokerModelAuthority::new(
        run_id,
        verifier,
        FakeBackend {
            state: Rc::clone(&backend_state),
            grants: VecDeque::new(),
            results: VecDeque::new(),
        },
        FakeGateway {
            state: Rc::clone(&gateway_state),
            completion: Some(succeeded_completion()),
        },
        LeasePolicy::from_startup_config(30_000).unwrap(),
    );

    assert!(matches!(
        authority.authorize_and_execute(request),
        Err(AuthorityBackendError::TrustedReplayBindingMismatch)
    ));
    assert!(backend_state.borrow().authorize_calls.is_empty());
    assert_eq!(gateway_state.borrow().calls, 0);
}

#[test]
fn trusted_snapshot_failure_never_claims_or_invokes_the_model_gateway() {
    // A bounded recovery refusal is also surfaced as this snapshot error, so
    // no recovery failure may become an authority claim or provider effect.
    let run_id = RunId::new();
    let request = request();
    let verifier_calls = Rc::new(RefCell::new(Vec::new()));
    let backend_state = Rc::new(RefCell::new(BackendState::default()));
    let gateway_state = Rc::new(RefCell::new(GatewayState::default()));
    let mut authority = BrokerModelAuthority::new(
        run_id,
        FakeVerifier {
            calls: Rc::clone(&verifier_calls),
            results: [Err(TrustedReplayVerificationError::Snapshot(
                bounded_recovery_error(),
            ))]
            .into_iter()
            .collect(),
        },
        FakeBackend {
            state: Rc::clone(&backend_state),
            grants: VecDeque::new(),
            results: VecDeque::new(),
        },
        FakeGateway {
            state: Rc::clone(&gateway_state),
            completion: None,
        },
        LeasePolicy::from_startup_config(30_000).unwrap(),
    );

    assert!(matches!(
        authority.authorize_and_execute(request),
        Err(AuthorityBackendError::TrustedReplay(
            TrustedReplayVerificationError::Snapshot(_)
        ))
    ));
    assert_eq!(verifier_calls.borrow().len(), 1);
    assert!(backend_state.borrow().authorize_calls.is_empty());
    assert!(backend_state.borrow().result_calls.is_empty());
    assert_eq!(gateway_state.borrow().calls, 0);
}

#[test]
fn non_implementer_replay_binding_is_rejected_before_storage() {
    let run_id = RunId::new();
    let request = request();
    let verifier_calls = Rc::new(RefCell::new(Vec::new()));
    let backend_state = Rc::new(RefCell::new(BackendState::default()));
    let gateway_state = Rc::new(RefCell::new(GatewayState::default()));
    let verifier = FakeVerifier {
        calls: Rc::clone(&verifier_calls),
        results: [Ok(TrustedReplayBinding {
            run_id,
            dispatch_event_id: request.dispatch_event_id,
            action_request_event_id: request.action_request_event_id,
            dispatch_role: ExecutionRoleV1::Reviewer,
            action_role: ExecutionRoleV1::Reviewer,
            has_existing_claim: false,
        })]
        .into_iter()
        .collect(),
    };
    let mut authority = BrokerModelAuthority::new(
        run_id,
        verifier,
        FakeBackend {
            state: Rc::clone(&backend_state),
            grants: VecDeque::new(),
            results: VecDeque::new(),
        },
        FakeGateway {
            state: Rc::clone(&gateway_state),
            completion: Some(succeeded_completion()),
        },
        LeasePolicy::from_startup_config(30_000).unwrap(),
    );

    assert!(matches!(
        authority.authorize_and_execute(request),
        Err(AuthorityBackendError::TrustedReplayBindingMismatch)
    ));
    assert!(backend_state.borrow().authorize_calls.is_empty());
    assert_eq!(gateway_state.borrow().calls, 0);
}

#[test]
fn reviewer_model_authority_accepts_only_startup_selected_reviewer_evidence() {
    let run_id = RunId::new();
    let request = request();
    let backend_state = Rc::new(RefCell::new(BackendState::default()));
    let gateway_state = Rc::new(RefCell::new(GatewayState::default()));
    let verifier = FakeVerifier {
        calls: Rc::new(RefCell::new(Vec::new())),
        results: [Ok(TrustedReplayBinding {
            run_id,
            dispatch_event_id: request.dispatch_event_id,
            action_request_event_id: request.action_request_event_id,
            dispatch_role: ExecutionRoleV1::Reviewer,
            action_role: ExecutionRoleV1::Reviewer,
            has_existing_claim: false,
        })]
        .into_iter()
        .collect(),
    };
    let mut authority = BrokerModelAuthority::new_for_role(
        run_id,
        ExecutionRoleV1::Reviewer,
        verifier,
        FakeBackend {
            state: Rc::clone(&backend_state),
            grants: [Ok(AuthorityGrant::Granted {
                run_id,
                lease_id: "reviewer-lease".into(),
                authorization_ref: "authorization://reviewer".into(),
            })]
            .into_iter()
            .collect(),
            results: [Ok(ResultDisposition::Recorded {
                run_id,
                outcome: ActivityResultOutcomeV1::Succeeded,
            })]
            .into_iter()
            .collect(),
        },
        FakeGateway {
            state: Rc::clone(&gateway_state),
            completion: Some(succeeded_completion()),
        },
        LeasePolicy::from_startup_config(30_000).unwrap(),
    )
    .expect("reviewer is a supported startup role");

    assert_eq!(
        authority.authorize_and_execute(request).unwrap(),
        BrokerModelActionStatus::Recorded
    );
    assert_eq!(backend_state.borrow().authorize_calls.len(), 1);
    assert_eq!(
        backend_state.borrow().authorize_calls[0].execution_role,
        ExecutionRoleV1::Reviewer
    );
    assert_eq!(gateway_state.borrow().calls, 1);
}

#[test]
fn candidate_role_cannot_construct_a_model_effect_authority() {
    let run_id = RunId::new();
    let request = request();
    let result = BrokerModelAuthority::new_for_role(
        run_id,
        ExecutionRoleV1::Candidate,
        FakeVerifier {
            calls: Rc::new(RefCell::new(Vec::new())),
            results: [Ok(exact_binding(run_id, &request))].into_iter().collect(),
        },
        FakeBackend {
            state: Rc::new(RefCell::new(BackendState::default())),
            grants: VecDeque::new(),
            results: VecDeque::new(),
        },
        FakeGateway {
            state: Rc::new(RefCell::new(GatewayState::default())),
            completion: None,
        },
        LeasePolicy::from_startup_config(30_000).unwrap(),
    );
    assert!(result.is_err());
}

#[test]
fn durable_retry_states_are_status_only_and_never_reenter_the_gateway() {
    let run_id = RunId::new();
    let cases = [
        (
            AuthorityGrant::Pending { run_id },
            BrokerModelActionStatus::Pending,
        ),
        (
            AuthorityGrant::Recorded {
                run_id,
                outcome: ActivityResultOutcomeV1::Succeeded,
            },
            BrokerModelActionStatus::Recorded,
        ),
        (
            AuthorityGrant::Recorded {
                run_id,
                outcome: ActivityResultOutcomeV1::Failed,
            },
            BrokerModelActionStatus::Failed,
        ),
        (
            AuthorityGrant::Recorded {
                run_id,
                outcome: ActivityResultOutcomeV1::Unknown,
            },
            BrokerModelActionStatus::ReconciliationRequired,
        ),
        (
            AuthorityGrant::LeaseExpired { run_id },
            BrokerModelActionStatus::LeaseExpired,
        ),
    ];

    for (grant, expected) in cases {
        let request = request();
        let (mut authority, _, backend_state, gateway_state) =
            authority(run_id, &request, [Ok(grant)], [], succeeded_completion());
        assert_eq!(authority.authorize_and_execute(request).unwrap(), expected);
        assert_eq!(gateway_state.borrow().calls, 0);
        assert!(backend_state.borrow().result_calls.is_empty());
    }
}

#[test]
fn cross_run_backend_grant_becomes_reconciliation_without_gateway_entry() {
    let run_id = RunId::new();
    let request = request();
    let (mut authority, _, backend_state, gateway_state) = authority(
        run_id,
        &request,
        [Ok(AuthorityGrant::Granted {
            run_id: RunId::new(),
            lease_id: "wrong-run-lease".into(),
            authorization_ref: "authorization://wrong-run".into(),
        })],
        [],
        succeeded_completion(),
    );

    assert_eq!(
        authority.authorize_and_execute(request).unwrap(),
        BrokerModelActionStatus::ReconciliationRequired
    );
    assert_eq!(gateway_state.borrow().calls, 0);
    assert!(backend_state.borrow().result_calls.is_empty());
}

#[test]
fn preexisting_replayed_claim_can_only_resolve_to_a_status_not_a_fresh_gateway_call() {
    let run_id = RunId::new();
    let request = request();
    let verifier_calls = Rc::new(RefCell::new(Vec::new()));
    let backend_state = Rc::new(RefCell::new(BackendState::default()));
    let gateway_state = Rc::new(RefCell::new(GatewayState::default()));
    let verifier = FakeVerifier {
        calls: Rc::clone(&verifier_calls),
        results: [Ok(TrustedReplayBinding {
            run_id,
            dispatch_event_id: request.dispatch_event_id,
            action_request_event_id: request.action_request_event_id,
            dispatch_role: ExecutionRoleV1::Implementer,
            action_role: ExecutionRoleV1::Implementer,
            has_existing_claim: true,
        })]
        .into_iter()
        .collect(),
    };
    let mut authority = BrokerModelAuthority::new(
        run_id,
        verifier,
        FakeBackend {
            state: Rc::clone(&backend_state),
            grants: [Ok(AuthorityGrant::Granted {
                run_id,
                lease_id: "must-not-be-reissued".into(),
                authorization_ref: "authorization://must-not-be-reissued".into(),
            })]
            .into_iter()
            .collect(),
            results: VecDeque::new(),
        },
        FakeGateway {
            state: Rc::clone(&gateway_state),
            completion: Some(succeeded_completion()),
        },
        LeasePolicy::from_startup_config(30_000).unwrap(),
    );

    assert_eq!(
        authority.authorize_and_execute(request).unwrap(),
        BrokerModelActionStatus::ReconciliationRequired
    );
    assert_eq!(backend_state.borrow().authorize_calls.len(), 1);
    assert_eq!(gateway_state.borrow().calls, 0);
}

#[test]
fn replayed_unknown_result_requires_reconciliation_without_gateway_reentry() {
    let run_id = RunId::new();
    let request = request();
    let backend_state = Rc::new(RefCell::new(BackendState::default()));
    let gateway_state = Rc::new(RefCell::new(GatewayState::default()));
    let mut authority = BrokerModelAuthority::new(
        run_id,
        FakeVerifier {
            calls: Rc::new(RefCell::new(Vec::new())),
            results: [Ok(TrustedReplayBinding {
                run_id,
                dispatch_event_id: request.dispatch_event_id,
                action_request_event_id: request.action_request_event_id,
                dispatch_role: ExecutionRoleV1::Implementer,
                action_role: ExecutionRoleV1::Implementer,
                has_existing_claim: true,
            })]
            .into_iter()
            .collect(),
        },
        FakeBackend {
            state: Rc::clone(&backend_state),
            grants: [Ok(AuthorityGrant::Recorded {
                run_id,
                outcome: ActivityResultOutcomeV1::Unknown,
            })]
            .into_iter()
            .collect(),
            results: VecDeque::new(),
        },
        FakeGateway {
            state: Rc::clone(&gateway_state),
            completion: Some(succeeded_completion()),
        },
        LeasePolicy::from_startup_config(30_000).unwrap(),
    );

    assert_eq!(
        authority.authorize_and_execute(request).unwrap(),
        BrokerModelActionStatus::ReconciliationRequired
    );
    assert_eq!(backend_state.borrow().authorize_calls.len(), 1);
    assert!(backend_state.borrow().result_calls.is_empty());
    assert_eq!(gateway_state.borrow().calls, 0);
}

#[test]
fn provider_failure_after_grant_is_paired_and_durably_recorded_unknown() {
    let run_id = RunId::new();
    let request = request();
    let (mut authority, _, backend_state, gateway_state) = authority(
        run_id,
        &request,
        [Ok(AuthorityGrant::Granted {
            run_id,
            lease_id: "ambiguous-lease".into(),
            authorization_ref: "authorization://ambiguous".into(),
        })],
        [Ok(ResultDisposition::Recorded {
            run_id,
            outcome: ActivityResultOutcomeV1::Unknown,
        })],
        unknown_completion(),
    );

    assert_eq!(
        authority.authorize_and_execute(request).unwrap(),
        BrokerModelActionStatus::ReconciliationRequired
    );
    assert_eq!(gateway_state.borrow().calls, 1);
    assert_eq!(
        backend_state.borrow().result_calls[0].outcome,
        ActivityResultOutcomeV1::Unknown
    );
    assert_eq!(backend_state.borrow().result_calls[0].result_digest, None);
    assert_eq!(backend_state.borrow().result_calls[0].result_ref, None);
}

#[test]
fn result_side_lease_expiry_requires_reconciliation_and_repeat_never_reenters_gateway() {
    let run_id = RunId::new();
    let request = request();
    let (mut authority, _, backend_state, gateway_state) = authority(
        run_id,
        &request,
        [
            Ok(AuthorityGrant::Granted {
                run_id,
                lease_id: "result-expired-lease".into(),
                authorization_ref: "authorization://result-expired".into(),
            }),
            Ok(AuthorityGrant::LeaseExpired { run_id }),
        ],
        [Ok(ResultDisposition::LeaseExpired { run_id })],
        succeeded_completion(),
    );

    assert_eq!(
        authority.authorize_and_execute(request.clone()).unwrap(),
        BrokerModelActionStatus::ReconciliationRequired
    );
    assert_eq!(gateway_state.borrow().calls, 1);
    assert_eq!(backend_state.borrow().result_calls.len(), 1);

    // The retry resolves the existing expired lease on the pre-effect path;
    // it must not hand a second capability to the gateway.
    assert_eq!(
        authority.authorize_and_execute(request).unwrap(),
        BrokerModelActionStatus::LeaseExpired
    );
    assert_eq!(gateway_state.borrow().calls, 1);
    assert_eq!(backend_state.borrow().result_calls.len(), 1);
}

#[test]
fn result_persistence_failure_after_grant_is_reconciliation_not_a_retryable_error() {
    let run_id = RunId::new();
    let request = request();
    let (mut authority, _, _, gateway_state) = authority(
        run_id,
        &request,
        [Ok(AuthorityGrant::Granted {
            run_id,
            lease_id: "uncertain-result-lease".into(),
            authorization_ref: "authorization://uncertain-result".into(),
        })],
        [Err(AuthorityBackendError::Ledger(
            LedgerError::InvalidPayload {
                kind: "test_result_persistence".into(),
                reason: "simulated durable write failure".into(),
            },
        ))],
        unknown_completion(),
    );

    assert_eq!(
        authority.authorize_and_execute(request).unwrap(),
        BrokerModelActionStatus::ReconciliationRequired
    );
    assert_eq!(gateway_state.borrow().calls, 1);
}

#[test]
fn reconciliation_is_status_only_and_never_reenters_the_gateway() {
    let run_id = RunId::new();
    let request = request();
    let (mut authority, _, backend_state, gateway_state) = authority(
        run_id,
        &request,
        [Err(AuthorityBackendError::ReconciliationRequired)],
        [],
        succeeded_completion(),
    );

    assert_eq!(
        authority.authorize_and_execute(request).unwrap(),
        BrokerModelActionStatus::ReconciliationRequired
    );
    assert_eq!(gateway_state.borrow().calls, 0);
    assert!(backend_state.borrow().result_calls.is_empty());
}

fn promotion_actor(actor_id: &str, key_id: &str, key: &SigningKey) -> ActorKeyRef {
    ActorKeyRef {
        actor_id: actor_id.into(),
        key_id: key_id.into(),
        public_key_hash: Some(public_key_hash(&key.verifying_key())),
    }
}

fn promotion_trusted_keys(keys: &[&SigningKey]) -> TrustedPublicKeys {
    let mut trusted = TrustedPublicKeys::default();
    for key in keys {
        trusted.insert_public_key(
            public_key_hash(&key.verifying_key()),
            key.verifying_key().to_bytes().to_vec(),
        );
    }
    trusted
}

fn promotion_dispatch(now: DateTime<Utc>, realm_digest: &str) -> DispatchEnvelopeV3 {
    let body = DispatchEnvelopeBodyV2 {
        workflow_id: "promotion-workflow-1".into(),
        workflow_revision: "r1".into(),
        unit_id: "implementation-unit-1".into(),
        attempt: 1,
        execution_role: ExecutionRoleV1::Implementer,
        commit_mode: CommitModeV1::Atomic,
        provenance_ref: "admission:promotion-1".into(),
        base_commit_sha: "1".repeat(40),
        capability_bundle_digest: DIGEST_A.into(),
        acceptance_contract_digest: DIGEST_B.into(),
        context_manifest_digest: DIGEST_C.into(),
        worker_manifest_digest: DIGEST_D.into(),
        sandbox_profile_digest: DIGEST_E.into(),
        budget: DispatchBudgetV1 {
            max_tokens: Some(1_024),
            max_compute_time_ms: Some(60_000),
        },
        trust_tier: TrustTierV1::Governed,
        idempotency_key: "dispatch:promotion-workflow-1:implementation-unit-1:1".into(),
        issued_at: timestamp(now - Duration::seconds(1)),
        expires_at: timestamp(now + Duration::minutes(10)),
    };
    let action_evidence_version = ActionEvidenceVersionV1::SealedV3;
    let envelope_digest = dispatch_envelope_v3_body_digest(
        &body,
        action_evidence_version,
        DIGEST_A,
        realm_digest,
        Some(DIGEST_C),
    )
    .expect("hash governed implementation dispatch");
    DispatchEnvelopeV3 {
        body,
        action_evidence_version,
        repository_binding_digest: DIGEST_A.into(),
        ledger_authority_realm_digest: realm_digest.into(),
        governed_packet_digest: Some(DIGEST_C.into()),
        envelope_digest,
    }
}

fn promotion_reviewer_dispatch(now: DateTime<Utc>, realm_digest: &str) -> DispatchEnvelopeV3 {
    let mut dispatch = promotion_dispatch(now, realm_digest);
    dispatch.body.unit_id = "review-unit-1".into();
    dispatch.body.execution_role = ExecutionRoleV1::Reviewer;
    dispatch.body.idempotency_key = "dispatch:promotion-workflow-1:review-unit-1:1".into();
    dispatch.envelope_digest = dispatch_envelope_v3_body_digest(
        &dispatch.body,
        dispatch.action_evidence_version,
        &dispatch.repository_binding_digest,
        &dispatch.ledger_authority_realm_digest,
        dispatch.governed_packet_digest.as_deref(),
    )
    .expect("hash governed reviewer dispatch");
    dispatch
}

fn promotion_event(
    run_id: RunId,
    parent_event_id: Option<EventId>,
    kind: EventKind,
    occurred_at: DateTime<Utc>,
    payload: Payload,
) -> Event {
    Event {
        id: EventId::new(),
        run_id,
        parent_event_id,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind,
        occurred_at,
        payload,
    }
}

struct PromotionActionEvidence {
    request_event: Event,
    request: ActionRequestedV2,
    claim_event: Event,
    result_event: Event,
    receipt_event: Event,
    receipt: ActionReceiptRecordedV2,
    receipt_set_event: Option<Event>,
    receipt_set: Option<ActionReceiptSetRecordedV1>,
}

impl PromotionActionEvidence {
    fn sealed_receipt_set(&self) -> &ActionReceiptSetRecordedV1 {
        self.receipt_set
            .as_ref()
            .expect("promotion action fixture was expected to append a receipt set")
    }

    fn sealed_receipt_set_event(&self) -> &Event {
        self.receipt_set_event
            .as_ref()
            .expect("promotion action fixture was expected to append a receipt set event")
    }
}

#[derive(Clone, Copy)]
struct PromotionActionEvidenceOptions {
    requested_at: Option<DateTime<Utc>>,
    lease_expires_at: Option<DateTime<Utc>>,
    heartbeat: Option<(DateTime<Utc>, DateTime<Utc>)>,
    result_at: Option<DateTime<Utc>>,
    result_outcome: ActivityResultOutcomeV1,
    receipt_outcome: ActionReceiptOutcomeV2,
    emit_receipt_set: bool,
}

impl Default for PromotionActionEvidenceOptions {
    fn default() -> Self {
        Self {
            requested_at: None,
            lease_expires_at: None,
            heartbeat: None,
            result_at: None,
            result_outcome: ActivityResultOutcomeV1::Succeeded,
            receipt_outcome: ActionReceiptOutcomeV2::Succeeded,
            emit_receipt_set: true,
        }
    }
}

fn unsealed_promotion_action_options() -> PromotionActionEvidenceOptions {
    PromotionActionEvidenceOptions {
        emit_receipt_set: false,
        ..PromotionActionEvidenceOptions::default()
    }
}

fn append_promotion_action_evidence(
    store: &SqliteStore,
    run_id: RunId,
    dispatch: &DispatchEnvelopeV3,
    dispatch_event: &Event,
    kernel_key: &SigningKey,
    kernel: &ActorKeyRef,
    action_id: &str,
    action_kind: ActionKindV1,
    at: DateTime<Utc>,
    receipt_result: Option<(String, String)>,
    model_candidate_binding: Option<ModelActionCandidateBindingV1>,
) -> PromotionActionEvidence {
    append_promotion_action_evidence_with_options(
        store,
        run_id,
        dispatch,
        dispatch_event,
        kernel_key,
        kernel,
        action_id,
        action_kind,
        at,
        receipt_result,
        model_candidate_binding,
        PromotionActionEvidenceOptions::default(),
    )
}

#[allow(clippy::too_many_arguments)]
fn append_promotion_action_evidence_with_options(
    store: &SqliteStore,
    run_id: RunId,
    dispatch: &DispatchEnvelopeV3,
    dispatch_event: &Event,
    kernel_key: &SigningKey,
    kernel: &ActorKeyRef,
    action_id: &str,
    action_kind: ActionKindV1,
    at: DateTime<Utc>,
    receipt_result: Option<(String, String)>,
    model_candidate_binding: Option<ModelActionCandidateBindingV1>,
    options: PromotionActionEvidenceOptions,
) -> PromotionActionEvidence {
    let requested_at = options.requested_at.unwrap_or(at);
    let lease_expires_at = options
        .lease_expires_at
        .unwrap_or(at + Duration::seconds(30));
    let request = ActionRequestedV2 {
        run_id: run_id.to_string(),
        workflow_id: dispatch.body.workflow_id.clone(),
        unit_id: dispatch.body.unit_id.clone(),
        attempt: dispatch.body.attempt,
        provenance_ref: dispatch.body.provenance_ref.clone(),
        action_id: action_id.into(),
        idempotency_key: format!("action:{action_id}"),
        action_kind,
        canonical_input_digest: DIGEST_A.into(),
        canonical_input_ref: format!("cas:input:{action_id}"),
        dispatch_envelope_digest: dispatch.envelope_digest.clone(),
        repository_binding_digest: dispatch.repository_binding_digest.clone(),
        ledger_authority_realm_digest: dispatch.ledger_authority_realm_digest.clone(),
        governed_packet_digest: dispatch.governed_packet_digest.clone(),
        capability_bundle_digest: dispatch.body.capability_bundle_digest.clone(),
        policy_digest: governed_dispatch_policy_digest_v1(
            &dispatch.body.acceptance_contract_digest,
        )
        .expect("derive governed action policy"),
        context_manifest_digest: dispatch.body.context_manifest_digest.clone(),
        worker_manifest_digest: dispatch.body.worker_manifest_digest.clone(),
        sandbox_profile_digest: dispatch.body.sandbox_profile_digest.clone(),
        authority_actor: kernel.actor_id.clone(),
        execution_role: dispatch.body.execution_role,
        requested_at: timestamp(requested_at),
    };
    let request_event = promotion_event(
        run_id,
        Some(dispatch_event.id),
        EventKind::ActionRequestedV2,
        at,
        Payload::ActionRequestedV2(request.clone()),
    );
    store
        .append_signed(&request_event, kernel_key, kernel)
        .expect("append action request");

    let authorization_ref = if action_kind == ActionKindV1::Model {
        let mut intent = ModelActionIntentV1 {
            run_id: run_id.to_string(),
            workflow_id: dispatch.body.workflow_id.clone(),
            unit_id: dispatch.body.unit_id.clone(),
            attempt: dispatch.body.attempt,
            provenance_ref: dispatch.body.provenance_ref.clone(),
            action_id: action_id.into(),
            idempotency_key: request.idempotency_key.clone(),
            dispatch_event_ref: dispatch_event.id,
            dispatch_envelope_digest: dispatch.envelope_digest.clone(),
            action_request_event_ref: request_event.id,
            action_request_digest: action_requested_v2_digest(&request)
                .expect("hash model action request"),
            canonical_input_ref: request.canonical_input_ref.clone(),
            canonical_input_digest: request.canonical_input_digest.clone(),
            model_request_evidence: ModelRequestEvidenceV1 {
                schema_version: MODEL_REQUEST_EVIDENCE_V1_SCHEMA_VERSION,
                cas_ref: format!("cas:{DIGEST_B}"),
                digest: DIGEST_B.into(),
            },
            trust_scope_evidence: TrustScopeEvidenceV1 {
                schema_version: TRUST_SCOPE_EVIDENCE_V1_SCHEMA_VERSION,
                cas_ref: format!("cas:{DIGEST_C}"),
                digest: DIGEST_C.into(),
            },
            candidate_binding: model_candidate_binding,
            intent_actor: kernel.actor_id.clone(),
            intended_at: timestamp(at + Duration::milliseconds(1)),
            intent_digest: String::new(),
        };
        intent.intent_digest = model_action_intent_v1_digest(&intent).expect("hash model intent");
        let intent_event = promotion_event(
            run_id,
            Some(request_event.id),
            EventKind::ModelActionIntentV1,
            at + Duration::milliseconds(1),
            Payload::ModelActionIntentV1(intent.clone()),
        );
        store
            .append_signed(&intent_event, kernel_key, kernel)
            .expect("append model intent");
        let mut authorization = ModelActionAuthorizedV2 {
            intent_event_ref: intent_event.id,
            intent_digest: intent.intent_digest,
            model_request_evidence: intent.model_request_evidence,
            trust_scope_evidence: intent.trust_scope_evidence,
            candidate_binding: intent.candidate_binding,
            authorization_actor: kernel.actor_id.clone(),
            expires_at: timestamp(at + Duration::seconds(30)),
            authorization_ref: format!("authorization:{action_id}"),
            authorization_digest: String::new(),
        };
        authorization.authorization_digest =
            model_action_authorized_v2_digest(&authorization).expect("hash model authorization");
        let authorization_event = promotion_event(
            run_id,
            Some(intent_event.id),
            EventKind::ModelActionAuthorizedV2,
            at + Duration::milliseconds(2),
            Payload::ModelActionAuthorizedV2(authorization.clone()),
        );
        store
            .append_signed(&authorization_event, kernel_key, kernel)
            .expect("append model authorization");
        Some(authorization.authorization_ref)
    } else {
        None
    };

    let claim = ActivityClaimedV1 {
        run_id,
        activity_id: action_id.into(),
        idempotency_key: request.idempotency_key.clone(),
        action_kind,
        action_request_event_id: request_event.id,
        action_request_digest: action_requested_v2_digest(&request).expect("hash action request"),
        dispatch_event_id: dispatch_event.id,
        dispatch_envelope_digest: dispatch.envelope_digest.clone(),
        authority_actor: kernel.actor_id.clone(),
        purpose: ActivityClaimPurposeV1::Generic,
        lease_id: format!("lease:{action_id}"),
        lease_expires_at: timestamp(lease_expires_at),
        claimed_at: timestamp(at + Duration::milliseconds(3)),
    };
    let claim_event = promotion_event(
        run_id,
        Some(request_event.id),
        EventKind::ActivityClaimedV1,
        at + Duration::milliseconds(3),
        Payload::ActivityClaimedV1(claim.clone()),
    );
    store
        .append_signed(&claim_event, kernel_key, kernel)
        .expect("append action claim");

    if let Some((heartbeat_at, heartbeat_lease_expires_at)) = options.heartbeat {
        let heartbeat = ActivityHeartbeatRecordedV1 {
            run_id,
            activity_id: action_id.into(),
            idempotency_key: request.idempotency_key.clone(),
            heartbeat_id: Some(format!("heartbeat:{action_id}")),
            heartbeat_request_digest: Some(DIGEST_B.into()),
            claim_event_id: claim_event.id,
            claim_event_digest: canonical_event_hash(&claim_event)
                .expect("hash action claim for heartbeat"),
            lease_id: claim.lease_id.clone(),
            dispatch_event_id: dispatch_event.id,
            dispatch_envelope_digest: dispatch.envelope_digest.clone(),
            lease_expires_at: timestamp(heartbeat_lease_expires_at),
            heartbeat_at: timestamp(heartbeat_at),
        };
        let heartbeat_event = promotion_event(
            run_id,
            Some(claim_event.id),
            EventKind::ActivityHeartbeatRecordedV1,
            heartbeat_at,
            Payload::ActivityHeartbeatRecordedV1(heartbeat),
        );
        store
            .append_signed(&heartbeat_event, kernel_key, kernel)
            .expect("append action heartbeat");
    }

    let result_at = options.result_at.unwrap_or(at + Duration::milliseconds(4));
    let terminal_result =
        (options.result_outcome == ActivityResultOutcomeV1::Succeeded).then(|| {
            receipt_result
                .as_ref()
                .map(|(digest, reference)| (digest.clone(), reference.clone()))
                .unwrap_or_else(|| (DIGEST_C.into(), format!("cas:result:{action_id}")))
        });
    let result = ActivityResultRecordedV1 {
        run_id,
        activity_id: action_id.into(),
        idempotency_key: request.idempotency_key.clone(),
        claim_event_id: claim_event.id,
        claim_event_digest: canonical_event_hash(&claim_event).expect("hash action claim event"),
        lease_id: claim.lease_id.clone(),
        outcome: options.result_outcome,
        result_digest: terminal_result.as_ref().map(|(digest, _)| digest.clone()),
        result_ref: terminal_result
            .as_ref()
            .map(|(_, reference)| reference.clone()),
        evidence_digest: DIGEST_A.into(),
        evidence_ref: format!("cas:evidence:{action_id}"),
        recorded_at: timestamp(result_at),
    };
    let result_event = promotion_event(
        run_id,
        Some(claim_event.id),
        EventKind::ActivityResultRecordedV1,
        result_at,
        Payload::ActivityResultRecordedV1(result.clone()),
    );
    store
        .append_signed(&result_event, kernel_key, kernel)
        .expect("append action result");

    let receipt = ActionReceiptRecordedV2 {
        run_id: run_id.to_string(),
        workflow_id: dispatch.body.workflow_id.clone(),
        unit_id: dispatch.body.unit_id.clone(),
        attempt: dispatch.body.attempt,
        provenance_ref: dispatch.body.provenance_ref.clone(),
        action_id: action_id.into(),
        idempotency_key: request.idempotency_key.clone(),
        action_request_digest: action_requested_v2_digest(&request).expect("hash action request"),
        dispatch_envelope_digest: dispatch.envelope_digest.clone(),
        capability_bundle_digest: dispatch.body.capability_bundle_digest.clone(),
        policy_digest: request.policy_digest.clone(),
        context_manifest_digest: dispatch.body.context_manifest_digest.clone(),
        worker_manifest_digest: dispatch.body.worker_manifest_digest.clone(),
        sandbox_profile_digest: dispatch.body.sandbox_profile_digest.clone(),
        authority_actor: kernel.actor_id.clone(),
        execution_role: dispatch.body.execution_role,
        outcome: options.receipt_outcome,
        result_digest: (options.receipt_outcome == ActionReceiptOutcomeV2::Succeeded)
            .then(|| result.result_digest.clone())
            .flatten(),
        result_ref: (options.receipt_outcome == ActionReceiptOutcomeV2::Succeeded)
            .then(|| result.result_ref.clone())
            .flatten(),
        evidence_digest: DIGEST_A.into(),
        evidence_ref: format!("cas:evidence:{action_id}"),
        resource_usage: ActionResourceUsageV1 {
            wall_time_ms: 1,
            cpu_time_ms: Some(1),
            peak_memory_bytes: Some(1),
            input_bytes: Some(1),
            output_bytes: Some(1),
            input_tokens: (action_kind == ActionKindV1::Model).then_some(1),
            output_tokens: (action_kind == ActionKindV1::Model).then_some(1),
        },
        redactions: vec![],
        failure: (options.receipt_outcome != ActionReceiptOutcomeV2::Succeeded).then_some(
            ActionFailureV1 {
                code: "test_failure".into(),
                message_digest: DIGEST_D.into(),
                retryable: false,
            },
        ),
        authorization_ref,
        action_receipt_ref: format!("receipt:{action_id}"),
        completed_at: timestamp(result_at),
    };
    let receipt_event = promotion_event(
        run_id,
        Some(result_event.id),
        EventKind::ActionReceiptRecordedV2,
        result_at + Duration::milliseconds(1),
        Payload::ActionReceiptRecordedV2(receipt.clone()),
    );
    store
        .append_signed(&receipt_event, kernel_key, kernel)
        .expect("append action receipt");

    let (receipt_set_event, receipt_set) = if options.emit_receipt_set {
        let mut receipt_set = ActionReceiptSetRecordedV1 {
            run_id: run_id.to_string(),
            workflow_id: dispatch.body.workflow_id.clone(),
            unit_id: dispatch.body.unit_id.clone(),
            attempt: dispatch.body.attempt,
            provenance_ref: dispatch.body.provenance_ref.clone(),
            dispatch_envelope_digest: dispatch.envelope_digest.clone(),
            action_receipt_set_ref: format!("receipt-set:{action_id}"),
            action_receipt_set_digest: String::new(),
            receipts: vec![ActionReceiptSetEntryV1 {
                action_id: action_id.into(),
                action_receipt_ref: receipt.action_receipt_ref.clone(),
                action_receipt_digest: action_receipt_recorded_v2_digest(&receipt)
                    .expect("hash action receipt"),
            }],
            sealed_at: timestamp(result_at + Duration::milliseconds(2)),
        };
        receipt_set.action_receipt_set_digest =
            action_receipt_set_v1_digest(&receipt_set).expect("hash action receipt set");
        let receipt_set_event = promotion_event(
            run_id,
            Some(receipt_event.id),
            EventKind::ActionReceiptSetRecordedV1,
            result_at + Duration::milliseconds(2),
            Payload::ActionReceiptSetRecordedV1(receipt_set.clone()),
        );
        store
            .append_signed(&receipt_set_event, kernel_key, kernel)
            .expect("append action receipt set");
        (Some(receipt_set_event), Some(receipt_set))
    } else {
        (None, None)
    };

    PromotionActionEvidence {
        request_event,
        request,
        claim_event,
        result_event,
        receipt_event,
        receipt,
        receipt_set_event,
        receipt_set,
    }
}

const PROMOTION_CANDIDATE_ID: &str = "candidate-promotion-1";

fn promotion_candidate_ref(run_id: &RunId, attempt: u32) -> String {
    format!("refs/buildplane/candidates/{PROMOTION_CANDIDATE_ID}/{run_id}/{attempt}")
}

fn promotion_candidate_create_action_id(run_id: &RunId, attempt: u32) -> String {
    format!("git-candidate-create:{PROMOTION_CANDIDATE_ID}/{run_id}/{attempt}")
}

fn promotion_candidate(
    run_id: RunId,
    dispatch: &DispatchEnvelopeV3,
    receipt_set: &ActionReceiptSetRecordedV1,
) -> CandidateCreatedV2 {
    CandidateCreatedV2 {
        run_id: run_id.to_string(),
        candidate_id: PROMOTION_CANDIDATE_ID.into(),
        candidate_ref: promotion_candidate_ref(&run_id, dispatch.body.attempt),
        workflow_id: dispatch.body.workflow_id.clone(),
        unit_id: dispatch.body.unit_id.clone(),
        attempt: dispatch.body.attempt,
        provenance_ref: dispatch.body.provenance_ref.clone(),
        candidate_digest: DIGEST_A.into(),
        base_commit_sha: dispatch.body.base_commit_sha.clone(),
        candidate_commit_sha: "2".repeat(40),
        commit_digest: DIGEST_B.into(),
        // The reconciliation façade's read-only Git observer independently
        // hashes this empty fixture tree. Keep the signed candidate fact equal
        // to that deterministic observation rather than using a placeholder
        // digest that no real Git tree could satisfy.
        tree_digest: PROMOTION_TREE_DIGEST.into(),
        patch_digest: DIGEST_D.into(),
        changed_files_digest: DIGEST_E.into(),
        envelope_digest: dispatch.envelope_digest.clone(),
        action_receipt_set_ref: receipt_set.action_receipt_set_ref.clone(),
        action_receipt_set_digest: receipt_set.action_receipt_set_digest.clone(),
    }
}

fn promotion_receipt_set_entry(action: &PromotionActionEvidence) -> ActionReceiptSetEntryV1 {
    ActionReceiptSetEntryV1 {
        action_id: action.request.action_id.clone(),
        action_receipt_ref: action.receipt.action_receipt_ref.clone(),
        action_receipt_digest: action_receipt_recorded_v2_digest(&action.receipt)
            .expect("hash promotion action receipt"),
    }
}

fn append_candidate_receipt_set(
    store: &SqliteStore,
    run_id: RunId,
    dispatch: &DispatchEnvelopeV3,
    kernel_key: &SigningKey,
    kernel: &ActorKeyRef,
    parent_event_id: EventId,
    action_receipt_set_ref: &str,
    mut receipts: Vec<ActionReceiptSetEntryV1>,
    sealed_at: DateTime<Utc>,
) -> (Event, ActionReceiptSetRecordedV1) {
    receipts.sort_by(|left, right| left.action_id.cmp(&right.action_id));
    let mut receipt_set = ActionReceiptSetRecordedV1 {
        run_id: run_id.to_string(),
        workflow_id: dispatch.body.workflow_id.clone(),
        unit_id: dispatch.body.unit_id.clone(),
        attempt: dispatch.body.attempt,
        provenance_ref: dispatch.body.provenance_ref.clone(),
        dispatch_envelope_digest: dispatch.envelope_digest.clone(),
        action_receipt_set_ref: action_receipt_set_ref.into(),
        action_receipt_set_digest: String::new(),
        receipts,
        sealed_at: timestamp(sealed_at),
    };
    receipt_set.action_receipt_set_digest =
        action_receipt_set_v1_digest(&receipt_set).expect("hash candidate receipt set");
    let event = promotion_event(
        run_id,
        Some(parent_event_id),
        EventKind::ActionReceiptSetRecordedV1,
        sealed_at,
        Payload::ActionReceiptSetRecordedV1(receipt_set.clone()),
    );
    store
        .append_signed(&event, kernel_key, kernel)
        .expect("append candidate receipt set");
    (event, receipt_set)
}

fn append_candidate_artifact(
    store: &SqliteStore,
    run_id: RunId,
    dispatch: &DispatchEnvelopeV3,
    kernel_key: &SigningKey,
    kernel: &ActorKeyRef,
    receipt_set_event: &Event,
    receipt_set: &ActionReceiptSetRecordedV1,
    created_at: DateTime<Utc>,
) -> (CandidateCreatedV2, Event) {
    let candidate = promotion_candidate(run_id, dispatch, receipt_set);
    let event = promotion_event(
        run_id,
        Some(receipt_set_event.id),
        EventKind::CandidateCreatedV2,
        created_at,
        Payload::CandidateCreatedV2(candidate.clone()),
    );
    store
        .append_signed(&event, kernel_key, kernel)
        .expect("append candidate artifact");
    (candidate, event)
}

struct CandidateCompletionFixture {
    _temp: TempDir,
    store: SqliteStore,
    run_id: RunId,
    authority: GovernedPromotionAuthorityV1,
    kernel_key: SigningKey,
    kernel: ActorKeyRef,
    operator_key: SigningKey,
    operator: ActorKeyRef,
    dispatch: DispatchEnvelopeV3,
    dispatch_event: Event,
    candidate_action: PromotionActionEvidence,
    now: DateTime<Utc>,
}

fn candidate_completion_fixture(seed: u8) -> CandidateCompletionFixture {
    candidate_completion_fixture_with_options(seed, PromotionActionEvidenceOptions::default())
}

fn candidate_completion_fixture_with_options(
    seed: u8,
    candidate_action_options: PromotionActionEvidenceOptions,
) -> CandidateCompletionFixture {
    let now = DateTime::parse_from_rfc3339(&timestamp(Utc::now() - Duration::seconds(60)))
        .expect("round fixture timestamp to canonical milliseconds")
        .with_timezone(&Utc);
    candidate_completion_fixture_at(seed, now, candidate_action_options)
}

fn candidate_completion_fixture_at(
    seed: u8,
    now: DateTime<Utc>,
    candidate_action_options: PromotionActionEvidenceOptions,
) -> CandidateCompletionFixture {
    candidate_completion_fixture_for_attempt_at(seed, now, 1, candidate_action_options)
}

fn candidate_completion_fixture_for_attempt_at(
    seed: u8,
    now: DateTime<Utc>,
    attempt: u32,
    candidate_action_options: PromotionActionEvidenceOptions,
) -> CandidateCompletionFixture {
    let temp = TempDir::new().expect("temporary candidate-completion fixture directory");
    let store = SqliteStore::open(temp.path().join("events.db")).expect("open SQLite ledger");
    let run_id = RunId::new();
    let kernel_key = SigningKey::from_bytes(&[seed; 32]);
    let reviewer_key = SigningKey::from_bytes(&[seed.wrapping_add(1); 32]);
    let operator_key = SigningKey::from_bytes(&[seed.wrapping_add(2); 32]);
    let kernel = promotion_actor("candidate-fixture-kernel", "kernel-main", &kernel_key);
    let reviewer = promotion_actor("candidate-fixture-reviewer", "reviewer-main", &reviewer_key);
    let operator = promotion_actor("candidate-fixture-operator", "operator-main", &operator_key);
    let authority = GovernedPromotionAuthorityV1::new_governed_realm(
        promotion_trusted_keys(&[&kernel_key, &reviewer_key, &operator_key]),
        kernel.clone(),
        vec![reviewer],
        operator.clone(),
        DIGEST_E.into(),
    )
    .expect("construct candidate-completion authority");
    let mut dispatch = promotion_dispatch(now, DIGEST_E);
    if attempt != 1 {
        dispatch.body.attempt = attempt;
        dispatch.body.idempotency_key =
            format!("dispatch:promotion-workflow-1:implementation-unit-1:{attempt}");
        dispatch.envelope_digest = dispatch_envelope_v3_body_digest(
            &dispatch.body,
            dispatch.action_evidence_version,
            &dispatch.repository_binding_digest,
            &dispatch.ledger_authority_realm_digest,
            dispatch.governed_packet_digest.as_deref(),
        )
        .expect("rehash governed retry dispatch");
    }
    let dispatch_event = promotion_event(
        run_id,
        None,
        EventKind::DispatchEnvelopeV3,
        now,
        Payload::DispatchEnvelopeV3(dispatch.clone()),
    );
    store
        .append_signed(&dispatch_event, &kernel_key, &kernel)
        .expect("append governed implementation dispatch");
    let candidate_action_id = promotion_candidate_create_action_id(&run_id, dispatch.body.attempt);
    let candidate_action = append_promotion_action_evidence_with_options(
        &store,
        run_id,
        &dispatch,
        &dispatch_event,
        &kernel_key,
        &kernel,
        &candidate_action_id,
        ActionKindV1::Git,
        now + Duration::milliseconds(100),
        None,
        None,
        candidate_action_options,
    );
    CandidateCompletionFixture {
        _temp: temp,
        store,
        run_id,
        authority,
        kernel_key,
        kernel,
        operator_key,
        operator,
        dispatch,
        dispatch_event,
        candidate_action,
        now,
    }
}

/// A deliberately narrow graph-bound fixture: one first-attempt implementer
/// node with no dependencies and a one-slot graph. The native candidate lane
/// can reconstruct this topology without pretending to be the full replay
/// scheduler; dependency, multi-node, concurrent, and retry graphs remain
/// fail-closed until their shared reducer is available.
fn singleton_graph_bound_v4_candidate_completion_fixture(seed: u8) -> CandidateCompletionFixture {
    graph_bound_v4_candidate_completion_fixture(seed, 1, false, false, false)
}

fn graph_bound_v4_candidate_completion_fixture(
    seed: u8,
    max_concurrent: u32,
    include_second_node: bool,
    include_prior_governed_dispatch: bool,
    include_pre_dispatch_checkpoint: bool,
) -> CandidateCompletionFixture {
    let now = DateTime::parse_from_rfc3339(&timestamp(Utc::now() - Duration::seconds(60)))
        .expect("round singleton V4 fixture timestamp to canonical milliseconds")
        .with_timezone(&Utc);
    let temp = TempDir::new().expect("temporary singleton V4 candidate fixture directory");
    let store = SqliteStore::open(temp.path().join("events.db"))
        .expect("open singleton V4 candidate SQLite ledger");
    let run_id = RunId::new();
    let kernel_key = SigningKey::from_bytes(&[seed; 32]);
    let reviewer_key = SigningKey::from_bytes(&[seed.wrapping_add(1); 32]);
    let operator_key = SigningKey::from_bytes(&[seed.wrapping_add(2); 32]);
    let kernel = promotion_actor("singleton-v4-kernel", "kernel-main", &kernel_key);
    let reviewer = promotion_actor("singleton-v4-reviewer", "reviewer-main", &reviewer_key);
    let operator = promotion_actor("singleton-v4-operator", "operator-main", &operator_key);
    let authority = GovernedPromotionAuthorityV1::new_governed_realm(
        promotion_trusted_keys(&[&kernel_key, &reviewer_key, &operator_key]),
        kernel.clone(),
        vec![reviewer],
        operator.clone(),
        DIGEST_E.into(),
    )
    .expect("construct singleton V4 candidate completion authority");

    let nested_dispatch = promotion_dispatch(now, DIGEST_E);
    let graph_declared_at = now - Duration::milliseconds(500);
    let mut nodes = vec![WorkflowGraphNodeV2 {
        unit_id: nested_dispatch.body.unit_id.clone(),
        depends_on: vec![],
        execution_role: nested_dispatch.body.execution_role,
        governed_packet_digest: nested_dispatch
            .governed_packet_digest
            .clone()
            .expect("sealed V3 fixture carries a governed packet digest"),
    }];
    if include_second_node {
        nodes.push(WorkflowGraphNodeV2 {
            unit_id: "secondary-implementation-unit".into(),
            depends_on: vec![],
            execution_role: ExecutionRoleV1::Implementer,
            governed_packet_digest: DIGEST_C.into(),
        });
    }
    let mut graph = WorkflowGraphDeclaredV2 {
        run_id: run_id.to_string(),
        workflow_id: nested_dispatch.body.workflow_id.clone(),
        workflow_revision: nested_dispatch.body.workflow_revision.clone(),
        nodes,
        max_concurrent,
        graph_digest: String::new(),
        idempotency_key: "graph:promotion-workflow-1:r1".into(),
        declared_at: timestamp(graph_declared_at),
    };
    graph.graph_digest = workflow_graph_v2_digest(&graph).expect("hash singleton V4 graph");
    let graph_event = promotion_event(
        run_id,
        None,
        EventKind::WorkflowGraphDeclaredV2,
        graph_declared_at,
        Payload::WorkflowGraphDeclaredV2(graph.clone()),
    );
    if include_pre_dispatch_checkpoint {
        store
            .append_signed_with_checkpoint(
                &graph_event,
                &kernel_key,
                &kernel,
                &CheckpointPolicy::Enabled { cadence: 1 },
            )
            .expect("append graph declaration and authenticated singleton V4 prefix checkpoint");
    } else {
        store
            .append_signed(&graph_event, &kernel_key, &kernel)
            .expect("append signed singleton V4 graph declaration");
    }

    if include_prior_governed_dispatch {
        let prior_dispatch_event = promotion_event(
            run_id,
            Some(graph_event.id),
            EventKind::DispatchEnvelopeV3,
            now - Duration::milliseconds(250),
            Payload::DispatchEnvelopeV3(nested_dispatch.clone()),
        );
        store
            .append_signed(&prior_dispatch_event, &kernel_key, &kernel)
            .expect("append a valid signed pre-V4 governed dispatch");
    }

    let mut graph_dispatch = DispatchEnvelopeV4 {
        dispatch_v3: nested_dispatch.clone(),
        workflow_graph_digest: graph.graph_digest.clone(),
        workflow_graph_declaration_event_ref: graph_event.id,
        envelope_digest: String::new(),
    };
    graph_dispatch.envelope_digest = dispatch_envelope_v4_digest(
        &graph_dispatch.dispatch_v3,
        &graph_dispatch.workflow_graph_digest,
        &graph_dispatch.workflow_graph_declaration_event_ref,
    )
    .expect("hash singleton V4 dispatch");
    let graph_dispatch_event = promotion_event(
        run_id,
        Some(graph_event.id),
        EventKind::DispatchEnvelopeV4,
        now,
        Payload::DispatchEnvelopeV4(graph_dispatch.clone()),
    );
    store
        .append_signed(&graph_dispatch_event, &kernel_key, &kernel)
        .expect("append signed singleton V4 dispatch");

    // V4 keeps nested V3 authority fields but every effect must carry the
    // outer V4 lineage digest. The fixture-only clone is never appended as a
    // V3 dispatch; it provides that outer digest to the existing action and
    // candidate evidence builder.
    let mut outer_lineage_dispatch = nested_dispatch;
    outer_lineage_dispatch.envelope_digest = graph_dispatch.envelope_digest;
    let candidate_action_id =
        promotion_candidate_create_action_id(&run_id, outer_lineage_dispatch.body.attempt);
    let candidate_action = append_promotion_action_evidence(
        &store,
        run_id,
        &outer_lineage_dispatch,
        &graph_dispatch_event,
        &kernel_key,
        &kernel,
        &candidate_action_id,
        ActionKindV1::Git,
        now + Duration::milliseconds(100),
        None,
        None,
    );
    CandidateCompletionFixture {
        _temp: temp,
        store,
        run_id,
        authority,
        kernel_key,
        kernel,
        operator_key,
        operator,
        dispatch: outer_lineage_dispatch,
        dispatch_event: graph_dispatch_event,
        candidate_action,
        now,
    }
}

fn candidate_completion_request(
    fixture: &CandidateCompletionFixture,
    candidate_event: &Event,
) -> GovernedCandidateCompletionRequestV1 {
    GovernedCandidateCompletionRequestV1 {
        run_id: fixture.run_id,
        dispatch_event_id: fixture.dispatch_event.id,
        candidate_created_event_id: candidate_event.id,
    }
}

fn assert_candidate_completion_authority_rejected(
    fixture: &CandidateCompletionFixture,
    candidate_event: &Event,
) {
    let request = candidate_completion_request(fixture, candidate_event);
    let outcome = fixture.store.record_governed_candidate_completion_v1(
        &request,
        &fixture.authority,
        &fixture.kernel_key,
        &fixture.kernel,
    );
    assert!(
        matches!(
            &outcome,
            Err(LedgerError::CandidateCompletionAuthorityRejected { .. })
        ),
        "replay-ineligible candidate evidence must fail closed: {outcome:?}",
    );
    assert_eq!(
        promotion_event_count(
            &fixture.store,
            fixture.run_id,
            "candidate_completion_recorded_v1",
        ),
        0,
        "rejected candidate evidence must not append a completion proof",
    );
}

fn promotion_candidate_completion(
    candidate: &CandidateCreatedV2,
    candidate_event_id: EventId,
    action: &PromotionActionEvidence,
    completed_at: DateTime<Utc>,
) -> CandidateCompletionRecordedV1 {
    let mut completion = CandidateCompletionRecordedV1 {
        run_id: candidate.run_id.clone(),
        workflow_id: candidate.workflow_id.clone(),
        unit_id: candidate.unit_id.clone(),
        attempt: candidate.attempt,
        provenance_ref: candidate.provenance_ref.clone(),
        candidate_created_event_ref: candidate_event_id,
        candidate_digest: candidate.candidate_digest.clone(),
        candidate_create_action_id: action.request.action_id.clone(),
        action_request_ref: action.request_event.id,
        action_request_digest: action_requested_v2_digest(&action.request)
            .expect("hash candidate action request"),
        activity_claim_event_ref: action.claim_event.id,
        activity_claim_event_digest: canonical_event_hash(&action.claim_event)
            .expect("hash candidate action claim"),
        activity_result_event_ref: action.result_event.id,
        activity_result_event_digest: canonical_event_hash(&action.result_event)
            .expect("hash candidate action result"),
        action_receipt_ref: action.receipt.action_receipt_ref.clone(),
        action_receipt_digest: action_receipt_recorded_v2_digest(&action.receipt)
            .expect("hash candidate action receipt"),
        completion_digest: String::new(),
        completed_at: timestamp(completed_at),
    };
    completion.completion_digest =
        candidate_completion_recorded_v1_digest(&completion).expect("hash candidate completion");
    completion
}

fn promotion_acceptance(
    candidate: &CandidateCreatedV2,
    dispatch: &DispatchEnvelopeV3,
    now: DateTime<Utc>,
) -> CandidateAcceptanceRecordedV1 {
    CandidateAcceptanceRecordedV1 {
        candidate_digest: candidate.candidate_digest.clone(),
        candidate_commit_sha: candidate.candidate_commit_sha.clone(),
        acceptance_ref: "acceptance:candidate-promotion-1".into(),
        acceptance_contract_digest: dispatch.body.acceptance_contract_digest.clone(),
        acceptance_digest: DIGEST_E.into(),
        outcome: CandidateAcceptanceOutcomeV1::Passed,
        evaluated_at: timestamp(now),
    }
}

fn promotion_review(
    run_id: RunId,
    candidate: &CandidateCreatedV2,
    candidate_dispatch: &DispatchEnvelopeV3,
    reviewer_dispatch: &DispatchEnvelopeV3,
    acceptance: &CandidateAcceptanceRecordedV1,
    action: &PromotionActionEvidence,
    reviewer: &ActorKeyRef,
    now: DateTime<Utc>,
) -> ReviewVerdictRecordedV2 {
    let (candidate_view, candidate_view_digest, review_output_digest) =
        promotion_review_output(candidate, reviewer_dispatch);
    ReviewVerdictRecordedV2 {
        run_id: run_id.to_string(),
        workflow_id: candidate.workflow_id.clone(),
        unit_id: candidate.unit_id.clone(),
        attempt: candidate.attempt,
        provenance_ref: candidate.provenance_ref.clone(),
        candidate_digest: candidate.candidate_digest.clone(),
        candidate_commit_sha: candidate.candidate_commit_sha.clone(),
        review_ref: "review:candidate-promotion-1".into(),
        review_verdict_action_id: action.request.action_id.clone(),
        review_action_request_digest: action_requested_v2_digest(&action.request)
            .expect("hash review action request"),
        review_action_receipt_ref: action.receipt.action_receipt_ref.clone(),
        review_action_receipt_digest: action_receipt_recorded_v2_digest(&action.receipt)
            .expect("hash review action receipt"),
        review_output_ref: format!("cas:{review_output_digest}"),
        review_output_digest,
        decision: ReviewDecisionV1::Approve,
        findings: Vec::new(),
        confidence: 1.0,
        acceptance_ref: acceptance.acceptance_ref.clone(),
        acceptance_digest: acceptance.acceptance_digest.clone(),
        acceptance_contract_digest: acceptance.acceptance_contract_digest.clone(),
        candidate_envelope_digest: candidate_dispatch.envelope_digest.clone(),
        reviewer_workflow_id: reviewer_dispatch.body.workflow_id.clone(),
        reviewer_dispatch_envelope_digest: reviewer_dispatch.envelope_digest.clone(),
        reviewer_unit_id: reviewer_dispatch.body.unit_id.clone(),
        reviewer_attempt: reviewer_dispatch.body.attempt,
        reviewer_execution_role: ExecutionRoleV1::Reviewer,
        review_action_receipt_set_ref: action.sealed_receipt_set().action_receipt_set_ref.clone(),
        review_action_receipt_set_digest: action
            .sealed_receipt_set()
            .action_receipt_set_digest
            .clone(),
        candidate_view,
        candidate_view_ref: format!("cas:{candidate_view_digest}"),
        candidate_view_digest,
        reviewer_manifest_digest: reviewer_dispatch.body.worker_manifest_digest.clone(),
        reviewer_authority: reviewer.actor_id.clone(),
        reviewed_at: timestamp(now),
    }
}

fn promotion_review_output(
    candidate: &CandidateCreatedV2,
    reviewer_dispatch: &DispatchEnvelopeV3,
) -> (CandidateViewV1, String, String) {
    let candidate_view = CandidateViewV1 {
        candidate_ref: candidate.candidate_ref.clone(),
        candidate_digest: candidate.candidate_digest.clone(),
        candidate_commit_sha: candidate.candidate_commit_sha.clone(),
        tree_digest: candidate.tree_digest.clone(),
        reviewer_context_manifest_digest: reviewer_dispatch.body.context_manifest_digest.clone(),
        reviewer_sandbox_profile_digest: reviewer_dispatch.body.sandbox_profile_digest.clone(),
        mount_path_digest: DIGEST_A.into(),
        read_only: true,
        network_disabled: true,
    };
    let candidate_view_digest =
        candidate_view_v1_digest(&candidate_view).expect("hash read-only candidate view");
    let review_output_digest = review_verdict_output_v1_digest(&ReviewVerdictOutputV1 {
        candidate_digest: candidate.candidate_digest.clone(),
        candidate_commit_sha: candidate.candidate_commit_sha.clone(),
        decision: ReviewDecisionV1::Approve,
        findings: Vec::new(),
        confidence: 1.0,
        candidate_view_digest: candidate_view_digest.clone(),
    })
    .expect("hash review output");
    (candidate_view, candidate_view_digest, review_output_digest)
}

fn promotion_approval(
    candidate: &CandidateCreatedV2,
    dispatch: &DispatchEnvelopeV3,
    acceptance: &CandidateAcceptanceRecordedV1,
    review: &ReviewVerdictRecordedV2,
    kernel: &ActorKeyRef,
    now: DateTime<Utc>,
) -> PromotionApprovalRequestedV1 {
    PromotionApprovalRequestedV1 {
        candidate_digest: candidate.candidate_digest.clone(),
        base_commit_sha: candidate.base_commit_sha.clone(),
        target_ref: "refs/heads/main".into(),
        envelope_digest: dispatch.envelope_digest.clone(),
        acceptance_ref: acceptance.acceptance_ref.clone(),
        review_refs: vec![review.review_ref.clone()],
        requested_by: kernel.actor_id.clone(),
        requested_at: timestamp(now),
        idempotency_key: "promotion:candidate-promotion-1".into(),
    }
}

struct PromotionFixture {
    _temp: TempDir,
    store: SqliteStore,
    authority: GovernedPromotionAuthorityV1,
    kernel_key: SigningKey,
    kernel: ActorKeyRef,
    reviewer_key: SigningKey,
    reviewer: ActorKeyRef,
    operator_key: SigningKey,
    operator: ActorKeyRef,
    request: GovernedPromotionDecisionRequestV1,
}

fn promotion_fixture() -> PromotionFixture {
    let temp = TempDir::new().expect("temporary ledger directory");
    let store = SqliteStore::open(temp.path().join("events.db")).expect("open SQLite ledger");
    let run_id = RunId::new();
    let kernel_key = SigningKey::from_bytes(&[61; 32]);
    let reviewer_key = SigningKey::from_bytes(&[62; 32]);
    let operator_key = SigningKey::from_bytes(&[63; 32]);
    let kernel = promotion_actor("promotion-kernel", "kernel-main", &kernel_key);
    let reviewer = promotion_actor("promotion-reviewer", "reviewer-main", &reviewer_key);
    let operator = promotion_actor("promotion-operator", "operator-main", &operator_key);
    let authority = GovernedPromotionAuthorityV1::new_governed_realm(
        promotion_trusted_keys(&[&kernel_key, &reviewer_key, &operator_key]),
        kernel.clone(),
        vec![reviewer.clone()],
        operator.clone(),
        DIGEST_E.into(),
    )
    .expect("construct distinct promotion authority");
    let request = append_promotion_evidence(
        &store,
        run_id,
        &authority,
        &kernel_key,
        &kernel,
        &reviewer_key,
        &reviewer,
    );

    PromotionFixture {
        _temp: temp,
        store,
        authority,
        kernel_key,
        kernel,
        reviewer_key,
        reviewer,
        operator_key,
        operator,
        request,
    }
}

fn append_promotion_evidence(
    store: &SqliteStore,
    run_id: RunId,
    authority: &GovernedPromotionAuthorityV1,
    kernel_key: &SigningKey,
    kernel: &ActorKeyRef,
    reviewer_key: &SigningKey,
    reviewer: &ActorKeyRef,
) -> GovernedPromotionDecisionRequestV1 {
    let now = DateTime::parse_from_rfc3339(&timestamp(Utc::now() - Duration::seconds(60)))
        .expect("round fixture timestamp to canonical milliseconds")
        .with_timezone(&Utc);
    let dispatch = promotion_dispatch(now, DIGEST_E);
    let dispatch_event = promotion_event(
        run_id,
        None,
        EventKind::DispatchEnvelopeV3,
        now,
        Payload::DispatchEnvelopeV3(dispatch.clone()),
    );
    store
        .append_signed(&dispatch_event, kernel_key, kernel)
        .expect("append governed implementation dispatch");

    let candidate_action_id = promotion_candidate_create_action_id(&run_id, dispatch.body.attempt);
    let candidate_action = append_promotion_action_evidence(
        store,
        run_id,
        &dispatch,
        &dispatch_event,
        kernel_key,
        kernel,
        &candidate_action_id,
        ActionKindV1::Git,
        now + Duration::milliseconds(100),
        None,
        None,
    );
    let candidate = promotion_candidate(run_id, &dispatch, candidate_action.sealed_receipt_set());
    let candidate_event = promotion_event(
        run_id,
        Some(candidate_action.sealed_receipt_set_event().id),
        EventKind::CandidateCreatedV2,
        now + Duration::seconds(1),
        Payload::CandidateCreatedV2(candidate.clone()),
    );
    store
        .append_signed(&candidate_event, kernel_key, kernel)
        .expect("append candidate");

    let completion_event_id = match store
        .record_governed_candidate_completion_v1(
            &GovernedCandidateCompletionRequestV1 {
                run_id,
                dispatch_event_id: dispatch_event.id,
                candidate_created_event_id: candidate_event.id,
            },
            authority,
            kernel_key,
            kernel,
        )
        .expect("record and seal native candidate completion")
    {
        GovernedCandidateCompletionDispositionV1::Recorded {
            candidate_completion_event_id,
            ..
        }
        | GovernedCandidateCompletionDispositionV1::Existing {
            candidate_completion_event_id,
            ..
        } => candidate_completion_event_id,
    };

    let acceptance = promotion_acceptance(&candidate, &dispatch, now + Duration::seconds(3));
    let acceptance_event = promotion_event(
        run_id,
        Some(completion_event_id),
        EventKind::CandidateAcceptanceRecorded,
        now + Duration::seconds(3),
        Payload::CandidateAcceptanceRecordedV1(acceptance.clone()),
    );
    store
        .append_signed(&acceptance_event, kernel_key, kernel)
        .expect("append passed acceptance");

    let reviewer_dispatch = promotion_reviewer_dispatch(now + Duration::seconds(4), DIGEST_E);
    let reviewer_dispatch_event = promotion_event(
        run_id,
        Some(acceptance_event.id),
        EventKind::DispatchEnvelopeV3,
        now + Duration::seconds(4),
        Payload::DispatchEnvelopeV3(reviewer_dispatch.clone()),
    );
    store
        .append_signed(&reviewer_dispatch_event, kernel_key, kernel)
        .expect("append governed reviewer dispatch");

    let (reviewer_candidate_view, reviewer_candidate_view_digest, reviewer_output_digest) =
        promotion_review_output(&candidate, &reviewer_dispatch);
    let reviewer_candidate_binding = ModelActionCandidateBindingV1 {
        candidate_created_event_ref: candidate_event.id,
        candidate_digest: candidate.candidate_digest.clone(),
        candidate_commit_sha: candidate.candidate_commit_sha.clone(),
        candidate_view_ref: format!("cas:{reviewer_candidate_view_digest}"),
        candidate_view_digest: reviewer_candidate_view_digest,
        candidate_view: reviewer_candidate_view,
    };
    let reviewer_action = append_promotion_action_evidence(
        store,
        run_id,
        &reviewer_dispatch,
        &reviewer_dispatch_event,
        kernel_key,
        kernel,
        "review-action-promotion-1",
        ActionKindV1::Model,
        now + Duration::milliseconds(4_100),
        Some((
            reviewer_output_digest.clone(),
            format!("cas:{reviewer_output_digest}"),
        )),
        Some(reviewer_candidate_binding),
    );
    let review = promotion_review(
        run_id,
        &candidate,
        &dispatch,
        &reviewer_dispatch,
        &acceptance,
        &reviewer_action,
        reviewer,
        now + Duration::seconds(5),
    );
    let review_event = promotion_event(
        run_id,
        Some(reviewer_action.sealed_receipt_set_event().id),
        EventKind::ReviewVerdictRecordedV2,
        now + Duration::seconds(5),
        Payload::ReviewVerdictRecordedV2(review.clone()),
    );
    store
        .append_signed(&review_event, reviewer_key, reviewer)
        .expect("append reviewer verdict");

    let approval = promotion_approval(
        &candidate,
        &dispatch,
        &acceptance,
        &review,
        kernel,
        now + Duration::seconds(6),
    );
    let approval_event = promotion_event(
        run_id,
        Some(review_event.id),
        EventKind::PromotionApprovalRequested,
        now + Duration::seconds(6),
        Payload::PromotionApprovalRequestedV1(approval),
    );
    store
        .append_signed(&approval_event, kernel_key, kernel)
        .expect("append promotion approval request");

    GovernedPromotionDecisionRequestV1 {
        run_id,
        dispatch_event_id: dispatch_event.id,
        candidate_created_event_id: candidate_event.id,
        candidate_completion_event_id: completion_event_id,
        acceptance_event_id: acceptance_event.id,
        review_event_ids: vec![review_event.id],
        promotion_approval_request_event_id: approval_event.id,
        decision: PromotionDecisionKindV1::Promote,
    }
}

fn promotion_broker<'a>(fixture: &'a PromotionFixture) -> BrokerPromotionDecisionAuthority<'a> {
    BrokerPromotionDecisionAuthority::from_prevalidated_startup(
        fixture.request.run_id,
        &fixture.store,
        &fixture.authority,
        &fixture.operator_key,
        &fixture.operator,
        &fixture.kernel_key,
        &fixture.kernel,
    )
    .expect("inject distinct protected promotion dependencies")
}

fn promotion_replay_authorities(fixture: &PromotionFixture) -> TrustedReplayAuthorities {
    let mut authorities = TrustedReplayAuthorities::new(promotion_trusted_keys(&[
        &fixture.kernel_key,
        &fixture.reviewer_key,
        &fixture.operator_key,
    ]));
    authorities.allow_signer(TrustSpineSignerRole::Kernel, fixture.kernel.clone());
    authorities.allow_signer(TrustSpineSignerRole::Reviewer, fixture.reviewer.clone());
    authorities.allow_signer(TrustSpineSignerRole::Operator, fixture.operator.clone());
    authorities
}

fn record_reconciliation_required_promotion_result(
    fixture: &PromotionFixture,
) -> (EventId, EventId, String) {
    let decision_event_id = match fixture
        .store
        .record_governed_promotion_decision_v1(
            &fixture.request,
            &fixture.authority,
            &fixture.operator_key,
            &fixture.operator,
        )
        .expect("record one operator promotion decision")
    {
        bp_ledger::storage::sqlite::GovernedPromotionDecisionDispositionV1::AwaitingKernelSeal {
            promotion_decision_event_id,
            ..
        }
        | bp_ledger::storage::sqlite::GovernedPromotionDecisionDispositionV1::Sealed {
            promotion_decision_event_id,
            ..
        } => promotion_decision_event_id,
    };
    fixture
        .store
        .seal_governed_promotion_decision_v1(
            &bp_ledger::storage::sqlite::GovernedPromotionDecisionSealRequestV1 {
                run_id: fixture.request.run_id,
                promotion_decision_event_id: decision_event_id,
            },
            &fixture.authority,
            &fixture.kernel_key,
            &fixture.kernel,
        )
        .expect("seal the promotion decision before its one effect claim");

    let (claim_event_id, claim_event_digest, lease_id) = match fixture
        .store
        .claim_governed_promotion_execution_v1(
            &GovernedPromotionExecutionClaimRequestV1 {
                run_id: fixture.request.run_id,
                promotion_decision_event_id: decision_event_id,
                lease_duration_ms: 30_000,
            },
            &fixture.authority,
            &fixture.kernel_key,
            &fixture.kernel,
        )
        .expect("reserve the one promotion execution lease")
    {
        GovernedPromotionExecutionClaimDispositionV1::Granted {
            promotion_execution_claim_event_id,
            promotion_execution_claim_event_digest,
            claim,
        } => (
            promotion_execution_claim_event_id,
            promotion_execution_claim_event_digest,
            claim.lease_id,
        ),
        other => panic!("fixture must grant one promotion lease, got {other:?}"),
    };

    let candidate_event = fixture
        .store
        .events_for_run(&fixture.request.run_id.to_string())
        .expect("read fixture candidate")
        .into_iter()
        .find(|event| event.id == fixture.request.candidate_created_event_id.to_string())
        .expect("fixture must contain the immutable candidate")
        .to_event()
        .expect("decode fixture candidate");
    let Payload::CandidateCreatedV2(candidate) = candidate_event.payload else {
        panic!("fixture candidate event must carry CandidateCreatedV2");
    };
    let merged_head_sha = "3".repeat(40);
    let receipt_suffix = candidate
        .candidate_ref
        .strip_prefix("refs/buildplane/candidates/")
        .expect("fixture candidate ref is canonical");
    let result = fixture
        .store
        .record_governed_promotion_result_v1(
            &GovernedPromotionResultRequestV1 {
                run_id: fixture.request.run_id,
                promotion_decision_event_id: decision_event_id,
                outcome: PromotionResultOutcomeV1::ReconciliationRequired,
                merged_head_sha: Some(merged_head_sha.clone()),
                promotion_git_binding: Some(PromotionGitBindingV1 {
                    target_ref: "refs/heads/main".into(),
                    target_head_before_sha: candidate.base_commit_sha.clone(),
                    target_head_after_sha: Some(merged_head_sha.clone()),
                    merged_head_sha: Some(merged_head_sha),
                    candidate_commit_sha: candidate.candidate_commit_sha.clone(),
                    merge_parent_shas: Some(vec![
                        candidate.base_commit_sha.clone(),
                        candidate.candidate_commit_sha.clone(),
                    ]),
                    merged_tree_sha: Some("4".repeat(40)),
                    merged_tree_digest: candidate.tree_digest.clone(),
                    promotion_receipt_ref: Some(format!(
                        "refs/buildplane/promotions/{receipt_suffix}"
                    )),
                    worktree_sync_state: Some(PromotionWorktreeSyncStateV1::RootCheckoutStale),
                }),
                promotion_execution_lease_binding: Some(PromotionExecutionLeaseBindingV1 {
                    promotion_execution_claim_event_ref: claim_event_id,
                    promotion_execution_claim_event_digest: claim_event_digest,
                    lease_id,
                }),
            },
            &fixture.authority,
            &fixture.kernel_key,
            &fixture.kernel,
        )
        .expect("record the known post-CAS reconciliation-required result");
    let result_event_id = match result {
        GovernedPromotionResultDispositionV1::Recorded {
            promotion_result_event_id,
            ..
        }
        | GovernedPromotionResultDispositionV1::Existing {
            promotion_result_event_id,
            ..
        } => promotion_result_event_id,
    };

    (
        decision_event_id,
        result_event_id,
        candidate.candidate_digest,
    )
}

#[test]
fn promotion_reconciliation_writer_appends_or_resolves_one_exact_operator_abandonment() {
    let fixture = promotion_fixture();
    let (promotion_decision_event_id, promotion_result_event_id, candidate_digest) =
        record_reconciliation_required_promotion_result(&fixture);
    let request = GovernedPromotionReconciliationRequestV1 {
        run_id: fixture.request.run_id,
        promotion_decision_event_id,
        promotion_result_event_id,
    };
    let event_count_before = fixture.store.event_count().expect("count signed tape");

    let first = fixture
        .store
        .record_governed_promotion_reconciliation_abandon_v1(
            &request,
            &fixture.authority,
            &fixture.operator_key,
            &fixture.operator,
            &fixture.kernel_key,
            &fixture.kernel,
        )
        .expect("append one operator-owned reconciliation abandonment");
    let (reconciliation_event_id, reconciliation_event_digest) = match first {
        GovernedPromotionReconciliationDispositionV1::Recorded {
            promotion_reconciliation_event_id,
            promotion_reconciliation_event_digest,
            outcome,
        } => {
            assert_eq!(outcome, ReconciliationResolutionOutcomeV1::Abandon);
            (
                promotion_reconciliation_event_id,
                promotion_reconciliation_event_digest,
            )
        }
        other => panic!("first reconciliation must append, got {other:?}"),
    };
    assert_eq!(
        fixture
            .store
            .event_count()
            .expect("count appended resolution"),
        event_count_before + 2,
        "the operator resolution and its kernel checkpoint must be durable"
    );

    let reconciliation_event = fixture
        .store
        .events_for_run(&fixture.request.run_id.to_string())
        .expect("read reconciliation tape")
        .into_iter()
        .find(|event| event.id == reconciliation_event_id.to_string())
        .expect("the reported reconciliation event is durable")
        .to_event()
        .expect("decode reconciliation event");
    assert_eq!(
        reconciliation_event.kind,
        EventKind::PromotionReconciliationResolved
    );
    let Payload::PromotionReconciliationResolvedV1(resolution) = reconciliation_event.payload
    else {
        panic!("reconciliation writer must emit the dedicated payload");
    };
    assert_eq!(resolution.candidate_digest, candidate_digest);
    assert_eq!(
        resolution.promotion_decision_ref,
        promotion_decision_event_id.to_string()
    );
    assert_eq!(
        resolution.promotion_result_ref,
        promotion_result_event_id.to_string()
    );
    assert_eq!(
        resolution.outcome,
        ReconciliationResolutionOutcomeV1::Abandon
    );
    assert_eq!(resolution.authority, fixture.operator.actor_id);
    assert_eq!(resolution.resolved_by, fixture.operator.actor_id);

    let generic_append = Event {
        id: EventId::new(),
        run_id: fixture.request.run_id,
        parent_event_id: Some(promotion_result_event_id),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::PromotionReconciliationResolved,
        occurred_at: Utc::now(),
        payload: Payload::PromotionReconciliationResolvedV1(resolution.clone()),
    };
    assert!(matches!(
        fixture
            .store
            .append_signed(&generic_append, &fixture.operator_key, &fixture.operator),
        Err(LedgerError::CallerSuppliedTrustSpineEvent { kind })
            if kind == "promotion_reconciliation_resolved"
    ));

    let replay_authorities = promotion_replay_authorities(&fixture);
    let snapshot = TrustedGovernedRecoverySnapshot::open_bounded_v1(
        &fixture.request.run_id.to_string(),
        fixture._temp.path().join("events.db"),
        &replay_authorities,
        &fixture.kernel,
    )
    .expect("the sealed abandonment must be visible to a fresh trusted replay");
    let workflow = snapshot
        .workflow_for_promotion_decision_event_ref(&promotion_decision_event_id.to_string())
        .expect("the exact promotion workflow remains replayable");
    assert_eq!(
        workflow.phase,
        WorkflowPhaseV1::PromotionReconciliationResolved
    );
    assert!(workflow
        .promotion
        .as_ref()
        .and_then(|promotion| promotion.reconciliation.as_ref())
        .is_some_and(|reconciliation| reconciliation.event_id == reconciliation_event_id));

    let second = fixture
        .store
        .record_governed_promotion_reconciliation_abandon_v1(
            &request,
            &fixture.authority,
            &fixture.operator_key,
            &fixture.operator,
            &fixture.kernel_key,
            &fixture.kernel,
        )
        .expect("retry resolves the exact existing reconciliation event");
    assert!(matches!(
        second,
        GovernedPromotionReconciliationDispositionV1::Existing {
            promotion_reconciliation_event_id: existing_event_id,
            promotion_reconciliation_event_digest: existing_event_digest,
            outcome: ReconciliationResolutionOutcomeV1::Abandon,
        } if existing_event_id == reconciliation_event_id
            && existing_event_digest == reconciliation_event_digest
    ));
    assert_eq!(
        fixture
            .store
            .event_count()
            .expect("count duplicate resolution"),
        event_count_before + 2,
        "a duplicate reconciliation must not append another operator event or checkpoint"
    );
}

#[test]
fn protected_reconciliation_facade_derives_abandonment_only_from_replayed_decision_and_reuses_it() {
    let fixture = promotion_fixture();
    let (promotion_decision_event_id, promotion_result_event_id, _) =
        record_reconciliation_required_promotion_result(&fixture);
    let replay_authorities = promotion_replay_authorities(&fixture);
    let (gateway, git_state) =
        reconciliation_fixture_gateway(&fixture, promotion_result_event_id, true);
    let mut authority = ProtectedPromotionReconciliationAuthority::
        from_prevalidated_startup_with_gateway_for_tests(
            fixture.request.run_id,
            fixture._temp.path().join("events.db"),
            &replay_authorities,
            &fixture.kernel,
            &fixture.store,
            &fixture.authority,
            &fixture.operator_key,
            &fixture.operator,
            &fixture.kernel_key,
            &fixture.kernel,
            gateway,
        )
        .expect("startup owns the protected reconciliation dependencies");
    let request = BrokerPromotionReconciliationIngressRequest {
        // The controller names only the already-recorded decision. It cannot
        // select a result, outcome, signer, repository path, or Git capability.
        promotion_decision_event_id,
    };
    let count_before = fixture
        .store
        .event_count()
        .expect("count durable fixture events");

    let first = authority.record_abandon_from_replayed_promotion(request.clone());
    assert_eq!(first, BrokerPromotionReconciliationDisposition::Recorded);
    assert_eq!(
        fixture
            .store
            .event_count()
            .expect("count recorded abandonment"),
        count_before + 2,
        "the façade may append only its operator abandonment and kernel checkpoint"
    );
    let git_operations_after_first = git_state.borrow().operations.len();

    let second = authority.record_abandon_from_replayed_promotion(request);
    assert_eq!(second, BrokerPromotionReconciliationDisposition::Existing);
    assert_eq!(
        fixture
            .store
            .event_count()
            .expect("count duplicate abandonment"),
        count_before + 2,
        "an exact retry must return the same durable reconciliation rather than append"
    );

    let state = git_state.borrow();
    assert_eq!(
        state.operations.len(),
        git_operations_after_first,
        "a sealed exact retry must not re-observe mutable Git state"
    );
    assert_eq!(state.create_merge_calls, 0);
    assert_eq!(state.atomic_update_calls, 0);
    assert!(state
        .operations
        .iter()
        .any(|operation| matches!(operation, TestGitOperation::InspectReceipt { .. })));
}

#[test]
fn protected_reconciliation_facade_checkpoint_failure_rolls_back_then_retries_once() {
    let fixture = promotion_fixture();
    let (promotion_decision_event_id, promotion_result_event_id, _) =
        record_reconciliation_required_promotion_result(&fixture);
    let replay_authorities = promotion_replay_authorities(&fixture);
    let (gateway, git_state) =
        reconciliation_fixture_gateway(&fixture, promotion_result_event_id, true);
    let mut authority = ProtectedPromotionReconciliationAuthority::
        from_prevalidated_startup_with_gateway_for_tests(
            fixture.request.run_id,
            fixture._temp.path().join("events.db"),
            &replay_authorities,
            &fixture.kernel,
            &fixture.store,
            &fixture.authority,
            &fixture.operator_key,
            &fixture.operator,
            &fixture.kernel_key,
            &fixture.kernel,
            gateway,
        )
        .expect("startup owns the protected reconciliation dependencies");
    let request = BrokerPromotionReconciliationIngressRequest {
        promotion_decision_event_id,
    };
    let count_before = fixture
        .store
        .event_count()
        .expect("count durable fixture events");

    fixture
        .store
        .fail_next_checkpoint_signature_insert_for_tests();
    assert_eq!(
        authority.record_abandon_from_replayed_promotion(request.clone()),
        BrokerPromotionReconciliationDisposition::ReconciliationRequired,
        "a checkpoint failure must not leave an unsealed abandonment event behind"
    );
    assert_eq!(
        fixture
            .store
            .event_count()
            .expect("count rolled-back attempt"),
        count_before,
        "the abandonment append and checkpoint seal must share one transaction"
    );

    assert_eq!(
        authority.record_abandon_from_replayed_promotion(request),
        BrokerPromotionReconciliationDisposition::Recorded,
        "retry after an atomic rollback records one sealed abandonment"
    );
    assert_eq!(
        fixture.store.event_count().expect("count sealed retry"),
        count_before + 2,
        "the retry appends exactly one operator abandonment and one checkpoint"
    );
    let state = git_state.borrow();
    assert_eq!(state.create_merge_calls, 0);
    assert_eq!(state.atomic_update_calls, 0);
    assert!(
        state.operations.iter().all(|operation| !matches!(
            operation,
            TestGitOperation::CreateMergeCommit { .. } | TestGitOperation::AtomicAdvance { .. }
        )),
        "the recovery façade may only read the existing receipt"
    );
}

#[test]
fn protected_reconciliation_facade_blocks_missing_receipt_before_writer_or_git_mutation() {
    let fixture = promotion_fixture();
    let (promotion_decision_event_id, promotion_result_event_id, _) =
        record_reconciliation_required_promotion_result(&fixture);
    let replay_authorities = promotion_replay_authorities(&fixture);
    let (gateway, git_state) =
        reconciliation_fixture_gateway(&fixture, promotion_result_event_id, false);
    let mut authority = ProtectedPromotionReconciliationAuthority::
        from_prevalidated_startup_with_gateway_for_tests(
            fixture.request.run_id,
            fixture._temp.path().join("events.db"),
            &replay_authorities,
            &fixture.kernel,
            &fixture.store,
            &fixture.authority,
            &fixture.operator_key,
            &fixture.operator,
            &fixture.kernel_key,
            &fixture.kernel,
            gateway,
        )
        .expect("startup owns the protected reconciliation dependencies");
    let count_before = fixture
        .store
        .event_count()
        .expect("count durable fixture events");

    let result = authority.record_abandon_from_replayed_promotion(
        BrokerPromotionReconciliationIngressRequest {
            promotion_decision_event_id,
        },
    );

    assert_eq!(
        result,
        BrokerPromotionReconciliationDisposition::ReconciliationRequired
    );
    assert_eq!(
        fixture
            .store
            .event_count()
            .expect("count blocked abandonment"),
        count_before,
        "a missing receipt must not reach the raw ledger writer"
    );
    let state = git_state.borrow();
    assert_eq!(state.create_merge_calls, 0);
    assert_eq!(state.atomic_update_calls, 0);
    assert!(state.operations.iter().all(|operation| !matches!(
        operation,
        TestGitOperation::CreateMergeCommit { .. } | TestGitOperation::AtomicAdvance { .. }
    )));
}

#[test]
fn protected_reconciliation_facade_rejects_existing_evidence_from_a_different_allowed_operator() {
    let fixture = promotion_fixture();
    let (promotion_decision_event_id, promotion_result_event_id, _) =
        record_reconciliation_required_promotion_result(&fixture);
    let durable_request = GovernedPromotionReconciliationRequestV1 {
        run_id: fixture.request.run_id,
        promotion_decision_event_id,
        promotion_result_event_id,
    };
    fixture
        .store
        .record_governed_promotion_reconciliation_abandon_v1(
            &durable_request,
            &fixture.authority,
            &fixture.operator_key,
            &fixture.operator,
            &fixture.kernel_key,
            &fixture.kernel,
        )
        .expect("record the fixture operator's sealed abandonment");

    // Replay may intentionally trust multiple operators, but this startup-bound
    // writer is authorized for exactly one. A sealed event from the fixture
    // operator must not be returned as `Existing` to a differently configured
    // broker instance.
    let other_operator_key = SigningKey::from_bytes(&[64; 32]);
    let other_operator = promotion_actor(
        "promotion-operator-other",
        "operator-other",
        &other_operator_key,
    );
    let mut replay_authorities = TrustedReplayAuthorities::new(promotion_trusted_keys(&[
        &fixture.kernel_key,
        &fixture.reviewer_key,
        &fixture.operator_key,
        &other_operator_key,
    ]));
    replay_authorities.allow_signer(TrustSpineSignerRole::Kernel, fixture.kernel.clone());
    replay_authorities.allow_signer(TrustSpineSignerRole::Reviewer, fixture.reviewer.clone());
    replay_authorities.allow_signer(TrustSpineSignerRole::Operator, fixture.operator.clone());
    replay_authorities.allow_signer(TrustSpineSignerRole::Operator, other_operator.clone());
    let facade_authority = GovernedPromotionAuthorityV1::new_governed_realm(
        promotion_trusted_keys(&[
            &fixture.kernel_key,
            &fixture.reviewer_key,
            &fixture.operator_key,
            &other_operator_key,
        ]),
        fixture.kernel.clone(),
        vec![fixture.reviewer.clone()],
        other_operator.clone(),
        DIGEST_E.into(),
    )
    .expect("construct a distinct but valid startup authority realm");
    let (gateway, git_state) =
        reconciliation_fixture_gateway(&fixture, promotion_result_event_id, true);
    let mut authority = ProtectedPromotionReconciliationAuthority::
        from_prevalidated_startup_with_gateway_for_tests(
            fixture.request.run_id,
            fixture._temp.path().join("events.db"),
            &replay_authorities,
            &fixture.kernel,
            &fixture.store,
            &facade_authority,
            &other_operator_key,
            &other_operator,
            &fixture.kernel_key,
            &fixture.kernel,
            gateway,
        )
        .expect("the local operator matches this facade authority");
    let count_before = fixture
        .store
        .event_count()
        .expect("count the sealed fixture abandonment");

    assert_eq!(
        authority.record_abandon_from_replayed_promotion(
            BrokerPromotionReconciliationIngressRequest {
                promotion_decision_event_id,
            },
        ),
        BrokerPromotionReconciliationDisposition::ReconciliationRequired,
        "a trusted-but-different operator must not reuse this broker's recovery result"
    );
    assert_eq!(
        fixture.store.event_count().expect("count rejected retry"),
        count_before,
        "a signer mismatch must not reach the raw ledger writer"
    );
    assert!(
        git_state.borrow().operations.is_empty(),
        "an existing signer mismatch must reject before observing mutable Git state"
    );
}

#[test]
fn protected_reconciliation_facade_startup_rejects_a_different_pinned_kernel() {
    let fixture = promotion_fixture();
    let (_, promotion_result_event_id, _) =
        record_reconciliation_required_promotion_result(&fixture);
    let replay_authorities = promotion_replay_authorities(&fixture);
    let mismatched_kernel_key = SigningKey::from_bytes(&[65; 32]);
    let mismatched_kernel = promotion_actor(
        "promotion-kernel-other",
        "kernel-other",
        &mismatched_kernel_key,
    );
    let (gateway, _) = reconciliation_fixture_gateway(&fixture, promotion_result_event_id, true);

    let startup =
        ProtectedPromotionReconciliationAuthority::from_prevalidated_startup_with_gateway_for_tests(
            fixture.request.run_id,
            fixture._temp.path().join("events.db"),
            &replay_authorities,
            &mismatched_kernel,
            &fixture.store,
            &fixture.authority,
            &fixture.operator_key,
            &fixture.operator,
            &fixture.kernel_key,
            &fixture.kernel,
            gateway,
        );

    assert!(matches!(
        startup,
        Err(BrokerPromotionReconciliationStartupError::PinnedKernelSignerMismatch)
    ));
}

#[test]
fn protected_reconciliation_facade_startup_rejects_signers_that_differ_from_its_authority_realm() {
    let fixture = promotion_fixture();
    let (_, promotion_result_event_id, _) =
        record_reconciliation_required_promotion_result(&fixture);
    let replay_authorities = promotion_replay_authorities(&fixture);

    let other_operator_key = SigningKey::from_bytes(&[64; 32]);
    let other_operator = promotion_actor(
        "promotion-operator-other",
        "operator-other",
        &other_operator_key,
    );
    let (operator_gateway, _) =
        reconciliation_fixture_gateway(&fixture, promotion_result_event_id, true);
    let operator_startup =
        ProtectedPromotionReconciliationAuthority::from_prevalidated_startup_with_gateway_for_tests(
            fixture.request.run_id,
            fixture._temp.path().join("events.db"),
            &replay_authorities,
            &fixture.kernel,
            &fixture.store,
            &fixture.authority,
            &other_operator_key,
            &other_operator,
            &fixture.kernel_key,
            &fixture.kernel,
            operator_gateway,
        );
    assert!(matches!(
        operator_startup,
        Err(BrokerPromotionReconciliationStartupError::ConfiguredOperatorSignerMismatch)
    ));

    let other_kernel_key = SigningKey::from_bytes(&[65; 32]);
    let other_kernel = promotion_actor("promotion-kernel-other", "kernel-other", &other_kernel_key);
    let (kernel_gateway, _) =
        reconciliation_fixture_gateway(&fixture, promotion_result_event_id, true);
    let kernel_startup =
        ProtectedPromotionReconciliationAuthority::from_prevalidated_startup_with_gateway_for_tests(
            fixture.request.run_id,
            fixture._temp.path().join("events.db"),
            &replay_authorities,
            &other_kernel,
            &fixture.store,
            &fixture.authority,
            &fixture.operator_key,
            &fixture.operator,
            &other_kernel_key,
            &other_kernel,
            kernel_gateway,
        );
    assert!(matches!(
        kernel_startup,
        Err(BrokerPromotionReconciliationStartupError::ConfiguredKernelSignerMismatch)
    ));
}

fn reviewer_session_snapshot_fixture() -> (
    TrustedGovernedRecoverySnapshot,
    ParsedAuthorityBrokerOpenReviewerSessionRequestV1,
) {
    reviewer_session_snapshot_fixture_with_authorization(false, false)
}

fn reviewer_session_snapshot_fixture_with_authorization(
    authorize_reviewer_action: bool,
    cancel_reviewer_workflow: bool,
) -> (
    TrustedGovernedRecoverySnapshot,
    ParsedAuthorityBrokerOpenReviewerSessionRequestV1,
) {
    let fixture = promotion_fixture();
    let run_id = fixture.request.run_id;
    let candidate_event = fixture
        .store
        .events_for_run(&run_id.to_string())
        .expect("read immutable candidate event")
        .into_iter()
        .find(|event| event.id == fixture.request.candidate_created_event_id.to_string())
        .expect("promotion fixture records one immutable candidate")
        .to_event()
        .expect("decode immutable candidate event");
    let candidate_event_id = candidate_event.id;
    let Payload::CandidateCreatedV2(candidate) = candidate_event.payload else {
        panic!("promotion fixture candidate id must name a CandidateCreatedV2 event");
    };

    let now = DateTime::parse_from_rfc3339(&timestamp(Utc::now()))
        .expect("round reviewer-session fixture timestamp to canonical milliseconds")
        .with_timezone(&Utc);
    let mut reviewer_dispatch = promotion_reviewer_dispatch(now, DIGEST_E);
    reviewer_dispatch.body.workflow_id = "reviewer-session-workflow-1".into();
    reviewer_dispatch.body.unit_id = "reviewer-session-unit-1".into();
    reviewer_dispatch.body.idempotency_key =
        "dispatch:reviewer-session-workflow-1:reviewer-session-unit-1:1".into();
    reviewer_dispatch.envelope_digest = dispatch_envelope_v3_body_digest(
        &reviewer_dispatch.body,
        reviewer_dispatch.action_evidence_version,
        &reviewer_dispatch.repository_binding_digest,
        &reviewer_dispatch.ledger_authority_realm_digest,
        reviewer_dispatch.governed_packet_digest.as_deref(),
    )
    .expect("hash governed reviewer-session dispatch");
    let reviewer_dispatch_event = promotion_event(
        run_id,
        Some(fixture.request.acceptance_event_id),
        EventKind::DispatchEnvelopeV3,
        now,
        Payload::DispatchEnvelopeV3(reviewer_dispatch.clone()),
    );
    fixture
        .store
        .append_signed(
            &reviewer_dispatch_event,
            &fixture.kernel_key,
            &fixture.kernel,
        )
        .expect("append governed reviewer-session dispatch");

    let action_id = "reviewer-session-model-action";
    let action_request = ActionRequestedV2 {
        run_id: run_id.to_string(),
        workflow_id: reviewer_dispatch.body.workflow_id.clone(),
        unit_id: reviewer_dispatch.body.unit_id.clone(),
        attempt: reviewer_dispatch.body.attempt,
        provenance_ref: reviewer_dispatch.body.provenance_ref.clone(),
        action_id: action_id.into(),
        idempotency_key: format!("action:{action_id}"),
        action_kind: ActionKindV1::Model,
        canonical_input_digest: DIGEST_A.into(),
        canonical_input_ref: format!("cas:input:{action_id}"),
        dispatch_envelope_digest: reviewer_dispatch.envelope_digest.clone(),
        repository_binding_digest: reviewer_dispatch.repository_binding_digest.clone(),
        ledger_authority_realm_digest: reviewer_dispatch.ledger_authority_realm_digest.clone(),
        governed_packet_digest: reviewer_dispatch.governed_packet_digest.clone(),
        capability_bundle_digest: reviewer_dispatch.body.capability_bundle_digest.clone(),
        policy_digest: governed_dispatch_policy_digest_v1(
            &reviewer_dispatch.body.acceptance_contract_digest,
        )
        .expect("derive reviewer-session action policy"),
        context_manifest_digest: reviewer_dispatch.body.context_manifest_digest.clone(),
        worker_manifest_digest: reviewer_dispatch.body.worker_manifest_digest.clone(),
        sandbox_profile_digest: reviewer_dispatch.body.sandbox_profile_digest.clone(),
        authority_actor: fixture.kernel.actor_id.clone(),
        execution_role: ExecutionRoleV1::Reviewer,
        requested_at: timestamp(now + Duration::milliseconds(1)),
    };
    let action_request_event = promotion_event(
        run_id,
        Some(reviewer_dispatch_event.id),
        EventKind::ActionRequestedV2,
        now + Duration::milliseconds(1),
        Payload::ActionRequestedV2(action_request.clone()),
    );
    fixture
        .store
        .append_signed(&action_request_event, &fixture.kernel_key, &fixture.kernel)
        .expect("append unclaimed reviewer-session model request");

    let (candidate_view, candidate_view_digest, _) =
        promotion_review_output(&candidate, &reviewer_dispatch);
    let candidate_binding = ModelActionCandidateBindingV1 {
        candidate_created_event_ref: candidate_event_id,
        candidate_digest: candidate.candidate_digest.clone(),
        candidate_commit_sha: candidate.candidate_commit_sha.clone(),
        candidate_view_ref: format!("cas:{candidate_view_digest}"),
        candidate_view_digest,
        candidate_view,
    };
    let intent_at = now + Duration::milliseconds(2);
    let mut intent = ModelActionIntentV1 {
        run_id: run_id.to_string(),
        workflow_id: reviewer_dispatch.body.workflow_id.clone(),
        unit_id: reviewer_dispatch.body.unit_id.clone(),
        attempt: reviewer_dispatch.body.attempt,
        provenance_ref: reviewer_dispatch.body.provenance_ref.clone(),
        action_id: action_id.into(),
        idempotency_key: action_request.idempotency_key.clone(),
        dispatch_event_ref: reviewer_dispatch_event.id,
        dispatch_envelope_digest: reviewer_dispatch.envelope_digest.clone(),
        action_request_event_ref: action_request_event.id,
        action_request_digest: action_requested_v2_digest(&action_request)
            .expect("hash reviewer-session action request"),
        canonical_input_ref: action_request.canonical_input_ref.clone(),
        canonical_input_digest: action_request.canonical_input_digest.clone(),
        model_request_evidence: ModelRequestEvidenceV1 {
            schema_version: MODEL_REQUEST_EVIDENCE_V1_SCHEMA_VERSION,
            cas_ref: format!("cas:{DIGEST_B}"),
            digest: DIGEST_B.into(),
        },
        trust_scope_evidence: TrustScopeEvidenceV1 {
            schema_version: TRUST_SCOPE_EVIDENCE_V1_SCHEMA_VERSION,
            cas_ref: format!("cas:{DIGEST_C}"),
            digest: DIGEST_C.into(),
        },
        candidate_binding: Some(candidate_binding),
        intent_actor: fixture.kernel.actor_id.clone(),
        intended_at: timestamp(intent_at),
        intent_digest: String::new(),
    };
    intent.intent_digest = model_action_intent_v1_digest(&intent).expect("hash reviewer intent");
    let intent_event = promotion_event(
        run_id,
        Some(action_request_event.id),
        EventKind::ModelActionIntentV1,
        intent_at,
        Payload::ModelActionIntentV1(intent.clone()),
    );
    if authorize_reviewer_action {
        fixture
            .store
            .append_signed(&intent_event, &fixture.kernel_key, &fixture.kernel)
            .expect("append reviewer-session intent before authorization");
        let mut authorization = ModelActionAuthorizedV2 {
            intent_event_ref: intent_event.id,
            intent_digest: intent.intent_digest.clone(),
            model_request_evidence: intent.model_request_evidence.clone(),
            trust_scope_evidence: intent.trust_scope_evidence.clone(),
            candidate_binding: intent.candidate_binding.clone(),
            authorization_actor: fixture.kernel.actor_id.clone(),
            expires_at: timestamp(now + Duration::seconds(30)),
            authorization_ref: "authorization:reviewer-session-model-action".into(),
            authorization_digest: String::new(),
        };
        authorization.authorization_digest = model_action_authorized_v2_digest(&authorization)
            .expect("hash reviewer-session authorization");
        let authorization_event = promotion_event(
            run_id,
            Some(intent_event.id),
            EventKind::ModelActionAuthorizedV2,
            now + Duration::milliseconds(3),
            Payload::ModelActionAuthorizedV2(authorization),
        );
        fixture
            .store
            .append_signed_with_checkpoint(
                &authorization_event,
                &fixture.kernel_key,
                &fixture.kernel,
                &CheckpointPolicy::every(1),
            )
            .expect("append checkpointed reviewer-session authorization");
    } else if cancel_reviewer_workflow {
        fixture
            .store
            .append_signed(&intent_event, &fixture.kernel_key, &fixture.kernel)
            .expect("append reviewer-session intent before cancellation");
        let cancellation_at = now + Duration::milliseconds(3);
        let cancellation = WorkflowCancellationRequestedV1 {
            run_id: run_id.to_string(),
            workflow_id: reviewer_dispatch.body.workflow_id.clone(),
            workflow_revision: reviewer_dispatch.body.workflow_revision.clone(),
            unit_id: reviewer_dispatch.body.unit_id.clone(),
            attempt: reviewer_dispatch.body.attempt,
            dispatch_event_ref: reviewer_dispatch_event.id,
            dispatch_envelope_digest: reviewer_dispatch.envelope_digest.clone(),
            cancellation_id: "cancel:reviewer-session-workflow-1".into(),
            cause: WorkflowCancellationCauseV1::OperatorRequested,
            timer_fired_event_ref: None,
            timer_fired_event_digest: None,
            requested_by: fixture.operator.actor_id.clone(),
            idempotency_key: "cancel:reviewer-session-workflow-1:1".into(),
            requested_at: timestamp(cancellation_at),
        };
        let cancellation_event = promotion_event(
            run_id,
            Some(reviewer_dispatch_event.id),
            EventKind::WorkflowCancellationRequestedV1,
            cancellation_at,
            Payload::WorkflowCancellationRequestedV1(cancellation),
        );
        fixture
            .store
            .append_signed(
                &cancellation_event,
                &fixture.operator_key,
                &fixture.operator,
            )
            .expect("append reviewer-session cancellation");
        let terminal_at = now + Duration::milliseconds(4);
        let terminal = WorkflowTerminalV2 {
            workflow_id: reviewer_dispatch.body.workflow_id.clone(),
            workflow_revision: reviewer_dispatch.body.workflow_revision.clone(),
            unit_id: reviewer_dispatch.body.unit_id.clone(),
            attempt: reviewer_dispatch.body.attempt,
            outcome: WorkflowTerminalOutcomeV1::Cancelled,
            candidate_digest: None,
            promotion_result_ref: None,
            reconciliation_resolution_ref: None,
            cancellation_request_event_ref: Some(cancellation_event.id),
            cancellation_request_event_digest: Some(
                canonical_event_hash(&cancellation_event)
                    .expect("hash reviewer-session cancellation"),
            ),
            reason: Some("operator cancelled reviewer session".into()),
            idempotency_key: "workflow-terminal:reviewer-session-workflow-1:1".into(),
            completed_at: timestamp(terminal_at),
        };
        let terminal_event = promotion_event(
            run_id,
            Some(cancellation_event.id),
            EventKind::WorkflowTerminalV2,
            terminal_at,
            Payload::WorkflowTerminalV2(terminal),
        );
        fixture
            .store
            .append_signed_with_checkpoint(
                &terminal_event,
                &fixture.kernel_key,
                &fixture.kernel,
                &CheckpointPolicy::every(1),
            )
            .expect("append checkpointed reviewer-session cancellation terminal");
    } else {
        fixture
            .store
            .append_signed_with_checkpoint(
                &intent_event,
                &fixture.kernel_key,
                &fixture.kernel,
                &CheckpointPolicy::every(1),
            )
            .expect("append checkpointed unclaimed reviewer-session intent");
    }

    let replay_authorities = promotion_replay_authorities(&fixture);
    let snapshot = TrustedGovernedRecoverySnapshot::open_bounded_v1(
        &run_id.to_string(),
        fixture._temp.path().join("events.db"),
        &replay_authorities,
        &fixture.kernel,
    )
    .expect("open a complete trusted reviewer-session snapshot");
    let request = ParsedAuthorityBrokerOpenReviewerSessionRequestV1 {
        run_id: run_id.to_string(),
        reviewer_dispatch_event_ref: reviewer_dispatch_event.id.to_string(),
        reviewer_action_request_event_ref: action_request_event.id.to_string(),
    };
    (snapshot, request)
}

#[test]
fn reviewer_session_resolver_returns_only_exact_unclaimed_reviewer_evidence() {
    let (snapshot, request) = reviewer_session_snapshot_fixture();

    let evidence = resolve_reviewer_model_evidence_from_snapshot_v1(&snapshot, &request)
        .expect("an unclaimed governed reviewer action has exact immutable evidence");

    assert_eq!(evidence.run_id, request.run_id);
    assert_eq!(
        evidence.reviewer_dispatch_event_ref.to_string(),
        request.reviewer_dispatch_event_ref
    );
    assert_eq!(
        evidence.reviewer_action_request_event_ref.to_string(),
        request.reviewer_action_request_event_ref
    );
    assert_eq!(evidence.execution_role, ExecutionRoleV1::Reviewer);
    assert_eq!(evidence.candidate.candidate_digest, DIGEST_A);
    assert!(evidence.candidate.candidate_view.read_only);
    assert!(evidence.candidate.candidate_view.network_disabled);
}

#[test]
fn reviewer_recovery_derives_the_single_action_from_candidate_identity() {
    let (snapshot, request) = reviewer_session_snapshot_fixture();
    let candidate_dispatch_event_ref = snapshot
        .workflow_for_candidate_digest(DIGEST_A)
        .expect("fixture candidate")
        .dispatch
        .event_id
        .to_string();

    let evidence = resolve_reviewer_model_evidence_for_candidate_recovery_v1(
        &snapshot,
        &candidate_dispatch_event_ref,
    )
    .expect("candidate recovery derives one pending reviewer");

    assert_eq!(evidence.run_id, request.run_id);
    assert_eq!(
        evidence.reviewer_dispatch_event_ref.to_string(),
        request.reviewer_dispatch_event_ref
    );
    assert_eq!(
        evidence.reviewer_action_request_event_ref.to_string(),
        request.reviewer_action_request_event_ref
    );
}

#[test]
fn reviewer_recovery_rejects_a_substituted_candidate_identity() {
    let (snapshot, _) = reviewer_session_snapshot_fixture();
    assert_eq!(
        resolve_reviewer_model_evidence_for_candidate_recovery_v1(
            &snapshot,
            &EventId::new().to_string(),
        )
        .expect_err("an unknown candidate recovery identity must not select a reviewer"),
        ReviewerSessionResolutionErrorV1::CandidateRecoveryNotFound,
    );
}

#[test]
fn reviewer_recovery_never_reopens_advanced_or_cancelled_actions() {
    for (snapshot, _) in [
        reviewer_session_snapshot_fixture_with_authorization(true, false),
        reviewer_session_snapshot_fixture_with_authorization(false, true),
    ] {
        let candidate_dispatch_event_ref = snapshot
            .workflow_for_candidate_digest(DIGEST_A)
            .expect("fixture candidate")
            .dispatch
            .event_id
            .to_string();
        assert_eq!(
            resolve_reviewer_model_evidence_for_candidate_recovery_v1(
                &snapshot,
                &candidate_dispatch_event_ref,
            )
            .expect_err("recovery must not reopen an advanced reviewer action"),
            ReviewerSessionResolutionErrorV1::ReviewerRecoveryNotFound,
        );
    }
}

#[test]
fn governed_reviewer_open_binds_signed_recovery_to_repository_and_replay() {
    let (snapshot, request) = reviewer_session_snapshot_fixture();
    let candidate_dispatch_event_ref = snapshot
        .workflow_for_candidate_digest(DIGEST_A)
        .expect("fixture candidate")
        .dispatch
        .event_id
        .to_string();
    let token_key = SigningKey::from_bytes(&[75; 32]);
    let recovery_ref = issue_recovery_token_v1(
        &token_key,
        snapshot.run_id(),
        &candidate_dispatch_event_ref,
        DIGEST_B,
    )
    .expect("signed recovery");
    let session = open_governed_reviewer_session_v1(
        &snapshot,
        &token_key,
        DIGEST_B,
        &recovery_ref,
        "01919000-0000-7000-8000-000000000110",
    )
    .expect("open reviewer from trusted recovery");

    assert_eq!(session.recovery_ref(), recovery_ref);
    assert_eq!(session.evidence().run_id, request.run_id);
    assert_eq!(
        session
            .evidence()
            .reviewer_action_request_event_ref
            .to_string(),
        request.reviewer_action_request_event_ref
    );
    assert!(session.session_ref().starts_with("gs1.r."));

    let resumed = resolve_governed_reviewer_run_v1(
        &snapshot,
        &token_key.verifying_key(),
        session.recovery_ref(),
        session.session_ref(),
    )
    .expect("session token reopens only the same pending reviewer evidence");
    assert_eq!(
        resumed.reviewer_action_request_event_ref,
        session.evidence().reviewer_action_request_event_ref
    );

    let run_id = RunId::from_uuid(uuid::Uuid::parse_str(&request.run_id).expect("fixture run id"));
    let backend_state = Rc::new(RefCell::new(BackendState::default()));
    let gateway_state = Rc::new(RefCell::new(GatewayState::default()));
    let mut authority = BrokerModelAuthority::new_for_role(
        run_id,
        ExecutionRoleV1::Reviewer,
        FakeVerifier {
            calls: Rc::new(RefCell::new(Vec::new())),
            results: [Ok(TrustedReplayBinding {
                run_id,
                dispatch_event_id: resumed.reviewer_dispatch_event_ref,
                action_request_event_id: resumed.reviewer_action_request_event_ref,
                dispatch_role: ExecutionRoleV1::Reviewer,
                action_role: ExecutionRoleV1::Reviewer,
                has_existing_claim: false,
            })]
            .into_iter()
            .collect(),
        },
        FakeBackend {
            state: Rc::clone(&backend_state),
            grants: [Ok(AuthorityGrant::Granted {
                run_id,
                lease_id: "reviewer-session-lease".into(),
                authorization_ref: "authorization://reviewer-session".into(),
            })]
            .into_iter()
            .collect(),
            results: [Ok(ResultDisposition::Recorded {
                run_id,
                outcome: ActivityResultOutcomeV1::Succeeded,
            })]
            .into_iter()
            .collect(),
        },
        FakeGateway {
            state: Rc::clone(&gateway_state),
            completion: Some(succeeded_completion()),
        },
        LeasePolicy::from_startup_config(30_000).unwrap(),
    )
    .expect("reviewer authority");
    assert_eq!(
        execute_governed_reviewer_run_v1(
            &snapshot,
            &token_key.verifying_key(),
            session.recovery_ref(),
            session.session_ref(),
            &mut authority,
        )
        .expect("session identity enters the broker-owned authority transaction"),
        BrokerModelActionStatus::Recorded
    );
    assert_eq!(
        backend_state.borrow().authorize_calls[0].execution_role,
        ExecutionRoleV1::Reviewer
    );
    assert_eq!(gateway_state.borrow().calls, 1);
}

#[test]
fn governed_reviewer_open_rejects_repository_and_run_substitution() {
    let (snapshot, _) = reviewer_session_snapshot_fixture();
    let candidate_dispatch_event_ref = snapshot
        .workflow_for_candidate_digest(DIGEST_A)
        .expect("fixture candidate")
        .dispatch
        .event_id
        .to_string();
    let token_key = SigningKey::from_bytes(&[76; 32]);
    let recovery_ref = issue_recovery_token_v1(
        &token_key,
        snapshot.run_id(),
        &candidate_dispatch_event_ref,
        DIGEST_B,
    )
    .expect("signed recovery");
    assert_eq!(
        open_governed_reviewer_session_v1(
            &snapshot,
            &token_key,
            DIGEST_C,
            &recovery_ref,
            "01919000-0000-7000-8000-000000000111",
        )
        .expect_err("another repository identity must not open the reviewer"),
        GovernedReviewerAuthorityErrorV1::RecoveryRejected,
    );

    let other_run_recovery = issue_recovery_token_v1(
        &token_key,
        "01919000-0000-7000-8000-000000000112",
        &candidate_dispatch_event_ref,
        DIGEST_B,
    )
    .expect("other run recovery");
    assert_eq!(
        open_governed_reviewer_session_v1(
            &snapshot,
            &token_key,
            DIGEST_B,
            &other_run_recovery,
            "01919000-0000-7000-8000-000000000113",
        )
        .expect_err("another run must not open the reviewer"),
        GovernedReviewerAuthorityErrorV1::RunMismatch,
    );
}

#[test]
fn governed_reviewer_run_rejects_recovery_or_session_substitution() {
    let (snapshot, _) = reviewer_session_snapshot_fixture();
    let candidate_dispatch_event_ref = snapshot
        .workflow_for_candidate_digest(DIGEST_A)
        .expect("fixture candidate")
        .dispatch
        .event_id
        .to_string();
    let token_key = SigningKey::from_bytes(&[77; 32]);
    let recovery_ref = issue_recovery_token_v1(
        &token_key,
        snapshot.run_id(),
        &candidate_dispatch_event_ref,
        DIGEST_B,
    )
    .expect("signed recovery");
    let session = open_governed_reviewer_session_v1(
        &snapshot,
        &token_key,
        DIGEST_B,
        &recovery_ref,
        "01919000-0000-7000-8000-000000000114",
    )
    .expect("reviewer session");
    let other_recovery = issue_recovery_token_v1(
        &token_key,
        snapshot.run_id(),
        &candidate_dispatch_event_ref,
        DIGEST_C,
    )
    .expect("other signed recovery");

    assert_eq!(
        resolve_governed_reviewer_run_v1(
            &snapshot,
            &token_key.verifying_key(),
            &other_recovery,
            session.session_ref(),
        )
        .expect_err("session token must bind the exact recovery token"),
        GovernedReviewerAuthorityErrorV1::SessionRejected,
    );
    assert_eq!(
        resolve_governed_reviewer_run_v1(
            &snapshot,
            &token_key.verifying_key(),
            session.recovery_ref(),
            "gs1.r.01919000-0000-7000-8000-000000000115.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .expect_err("forged session token must not reach replay evidence"),
        GovernedReviewerAuthorityErrorV1::SessionRejected,
    );
}

#[test]
fn reviewer_session_resolver_fails_closed_for_substituted_or_already_advanced_actions() {
    let (snapshot, request) = reviewer_session_snapshot_fixture();

    let substituted_run = ParsedAuthorityBrokerOpenReviewerSessionRequestV1 {
        run_id: RunId::new().to_string(),
        ..request.clone()
    };
    assert_eq!(
        resolve_reviewer_model_evidence_from_snapshot_v1(&snapshot, &substituted_run)
            .expect_err("a request from another run must not resolve"),
        ReviewerSessionResolutionErrorV1::RunMismatch,
    );

    let substituted_dispatch = ParsedAuthorityBrokerOpenReviewerSessionRequestV1 {
        reviewer_dispatch_event_ref: EventId::new().to_string(),
        ..request.clone()
    };
    assert_eq!(
        resolve_reviewer_model_evidence_from_snapshot_v1(&snapshot, &substituted_dispatch)
            .expect_err("a substituted reviewer dispatch must not resolve"),
        ReviewerSessionResolutionErrorV1::ReviewerDispatchNotFound,
    );

    let substituted_action = ParsedAuthorityBrokerOpenReviewerSessionRequestV1 {
        reviewer_action_request_event_ref: EventId::new().to_string(),
        ..request
    };
    assert_eq!(
        resolve_reviewer_model_evidence_from_snapshot_v1(&snapshot, &substituted_action)
            .expect_err("a substituted reviewer action must not resolve"),
        ReviewerSessionResolutionErrorV1::ReviewerActionNotFound,
    );

    let (advanced_snapshot, advanced_request) =
        reviewer_session_snapshot_fixture_with_authorization(true, false);
    assert_eq!(
        resolve_reviewer_model_evidence_from_snapshot_v1(&advanced_snapshot, &advanced_request)
            .expect_err("an authorized model action must be reconciled, never reopened"),
        ReviewerSessionResolutionErrorV1::ReviewerActionAlreadyAdvanced,
    );
}

#[test]
fn reviewer_session_resolver_rejects_an_unclaimed_action_after_workflow_cancellation() {
    let (snapshot, request) = reviewer_session_snapshot_fixture_with_authorization(false, true);

    assert_eq!(
        resolve_reviewer_model_evidence_from_snapshot_v1(&snapshot, &request)
            .expect_err("a cancelled workflow must not reopen an unclaimed reviewer action"),
        ReviewerSessionResolutionErrorV1::ReviewerWorkflowNotActive,
    );
}

fn promotion_event_count(store: &SqliteStore, run_id: RunId, kind: &str) -> usize {
    store
        .events_for_run(&run_id.to_string())
        .expect("read promotion tape")
        .iter()
        .filter(|event| event.kind == kind)
        .count()
}

#[test]
fn native_candidate_completion_records_one_tape_proof_and_resolves_an_exact_retry() {
    let temp = TempDir::new().expect("temporary candidate-completion ledger directory");
    let store = SqliteStore::open(temp.path().join("events.db")).expect("open SQLite ledger");
    let run_id = RunId::new();
    let kernel_key = SigningKey::from_bytes(&[71; 32]);
    let reviewer_key = SigningKey::from_bytes(&[72; 32]);
    let operator_key = SigningKey::from_bytes(&[73; 32]);
    let kernel = promotion_actor("completion-kernel", "kernel-main", &kernel_key);
    let reviewer = promotion_actor("completion-reviewer", "reviewer-main", &reviewer_key);
    let operator = promotion_actor("completion-operator", "operator-main", &operator_key);
    let authority = GovernedPromotionAuthorityV1::new_governed_realm(
        promotion_trusted_keys(&[&kernel_key, &reviewer_key, &operator_key]),
        kernel.clone(),
        vec![reviewer],
        operator,
        DIGEST_E.into(),
    )
    .expect("construct governed candidate-completion authority");
    let now = DateTime::parse_from_rfc3339(&timestamp(Utc::now() - Duration::seconds(60)))
        .expect("round fixture timestamp to canonical milliseconds")
        .with_timezone(&Utc);
    let dispatch = promotion_dispatch(now, DIGEST_E);
    let dispatch_event = promotion_event(
        run_id,
        None,
        EventKind::DispatchEnvelopeV3,
        now,
        Payload::DispatchEnvelopeV3(dispatch.clone()),
    );
    store
        .append_signed(&dispatch_event, &kernel_key, &kernel)
        .expect("append governed implementation dispatch");
    let candidate_action_id = promotion_candidate_create_action_id(&run_id, dispatch.body.attempt);
    let candidate_action = append_promotion_action_evidence(
        &store,
        run_id,
        &dispatch,
        &dispatch_event,
        &kernel_key,
        &kernel,
        &candidate_action_id,
        ActionKindV1::Git,
        now + Duration::milliseconds(100),
        None,
        None,
    );
    let candidate = promotion_candidate(run_id, &dispatch, candidate_action.sealed_receipt_set());
    let candidate_event = promotion_event(
        run_id,
        Some(candidate_action.sealed_receipt_set_event().id),
        EventKind::CandidateCreatedV2,
        now + Duration::seconds(1),
        Payload::CandidateCreatedV2(candidate.clone()),
    );
    store
        .append_signed(&candidate_event, &kernel_key, &kernel)
        .expect("append immutable candidate");

    let request = GovernedCandidateCompletionRequestV1 {
        run_id,
        dispatch_event_id: dispatch_event.id,
        candidate_created_event_id: candidate_event.id,
    };
    let before = promotion_event_count(&store, run_id, "candidate_completion_recorded_v1");
    let first = store
        .record_governed_candidate_completion_v1(&request, &authority, &kernel_key, &kernel)
        .expect("record native candidate completion");
    let (event_id, event_digest, completion_digest) = match first {
        GovernedCandidateCompletionDispositionV1::Recorded {
            candidate_completion_event_id,
            candidate_completion_event_digest,
            completion_digest,
        } => (
            candidate_completion_event_id,
            candidate_completion_event_digest,
            completion_digest,
        ),
        other => panic!("expected first completion record, received {other:?}"),
    };
    assert_eq!(
        promotion_event_count(&store, run_id, "candidate_completion_recorded_v1"),
        before + 1,
        "the native completion operation appends exactly one proof",
    );

    let retry = store
        .record_governed_candidate_completion_v1(&request, &authority, &kernel_key, &kernel)
        .expect("resolve exact native candidate-completion retry");
    assert_eq!(
        retry,
        GovernedCandidateCompletionDispositionV1::Existing {
            candidate_completion_event_id: event_id,
            candidate_completion_event_digest: event_digest.clone(),
            completion_digest: completion_digest.clone(),
        },
    );
    assert_eq!(
        promotion_event_count(&store, run_id, "candidate_completion_recorded_v1"),
        before + 1,
        "an exact retry must not append a second candidate completion",
    );

    let reopened = SqliteStore::open(temp.path().join("events.db"))
        .expect("reopen the durable candidate-completion ledger");
    let retry_after_reopen = reopened
        .record_governed_candidate_completion_v1(&request, &authority, &kernel_key, &kernel)
        .expect("resolve exact candidate-completion retry after reopening the store");
    assert_eq!(
        retry_after_reopen,
        GovernedCandidateCompletionDispositionV1::Existing {
            candidate_completion_event_id: event_id,
            candidate_completion_event_digest: event_digest,
            completion_digest,
        },
        "a second broker connection must resolve the one durable completion proof",
    );
    assert_eq!(
        promotion_event_count(&reopened, run_id, "candidate_completion_recorded_v1"),
        before + 1,
        "a reopened store must not append a competing candidate completion",
    );

    let conflicting_request = GovernedCandidateCompletionRequestV1 {
        run_id,
        dispatch_event_id: EventId::new(),
        candidate_created_event_id: candidate_event.id,
    };
    let conflicting_result = reopened.record_governed_candidate_completion_v1(
        &conflicting_request,
        &authority,
        &kernel_key,
        &kernel,
    );
    assert!(
        matches!(
            &conflicting_result,
            Err(LedgerError::PromotionAuthorityRejected { .. })
        ),
        "a conflicting immutable request must be rejected by authority: {conflicting_result:?}",
    );
    assert_eq!(
        promotion_event_count(&reopened, run_id, "candidate_completion_recorded_v1"),
        before + 1,
        "a conflicting immutable request must fail closed without a second completion",
    );

    let completion_at =
        DateTime::parse_from_rfc3339(&candidate_action.sealed_receipt_set().sealed_at)
            .expect("candidate receipt set must use a canonical timestamp")
            .with_timezone(&Utc);
    let sibling_event = promotion_event(
        run_id,
        Some(candidate_event.id),
        EventKind::CandidateCompletionRecordedV1,
        completion_at,
        Payload::CandidateCompletionRecordedV1(promotion_candidate_completion(
            &candidate,
            candidate_event.id,
            &candidate_action,
            completion_at,
        )),
    );
    reopened
        .append_signed(&sibling_event, &kernel_key, &kernel)
        .expect("append a competing completion proof for reconciliation coverage");
    let sibling_result = reopened.record_governed_candidate_completion_v1(
        &request,
        &authority,
        &kernel_key,
        &kernel,
    );
    assert!(
        matches!(
            &sibling_result,
            Err(LedgerError::CandidateCompletionReconciliationRequired { .. })
        ),
        "a projected completion must still block on any competing sibling proof: {sibling_result:?}",
    );
    assert_eq!(
        promotion_event_count(&reopened, run_id, "candidate_completion_recorded_v1"),
        before + 2,
        "reconciliation must not append a third completion after a sibling proof",
    );
}

#[test]
fn native_candidate_completion_blocks_an_orphaned_tape_proof() {
    let temp = TempDir::new().expect("temporary orphaned-completion ledger directory");
    let store = SqliteStore::open(temp.path().join("events.db")).expect("open SQLite ledger");
    let run_id = RunId::new();
    let kernel_key = SigningKey::from_bytes(&[74; 32]);
    let reviewer_key = SigningKey::from_bytes(&[75; 32]);
    let operator_key = SigningKey::from_bytes(&[76; 32]);
    let kernel = promotion_actor("orphan-kernel", "kernel-main", &kernel_key);
    let reviewer = promotion_actor("orphan-reviewer", "reviewer-main", &reviewer_key);
    let operator = promotion_actor("orphan-operator", "operator-main", &operator_key);
    let authority = GovernedPromotionAuthorityV1::new_governed_realm(
        promotion_trusted_keys(&[&kernel_key, &reviewer_key, &operator_key]),
        kernel.clone(),
        vec![reviewer],
        operator,
        DIGEST_E.into(),
    )
    .expect("construct governed candidate-completion authority");
    let now = DateTime::parse_from_rfc3339(&timestamp(Utc::now() - Duration::seconds(60)))
        .expect("round fixture timestamp to canonical milliseconds")
        .with_timezone(&Utc);
    let dispatch = promotion_dispatch(now, DIGEST_E);
    let dispatch_event = promotion_event(
        run_id,
        None,
        EventKind::DispatchEnvelopeV3,
        now,
        Payload::DispatchEnvelopeV3(dispatch.clone()),
    );
    store
        .append_signed(&dispatch_event, &kernel_key, &kernel)
        .expect("append governed implementation dispatch");
    let candidate_action_id = promotion_candidate_create_action_id(&run_id, dispatch.body.attempt);
    let candidate_action = append_promotion_action_evidence(
        &store,
        run_id,
        &dispatch,
        &dispatch_event,
        &kernel_key,
        &kernel,
        &candidate_action_id,
        ActionKindV1::Git,
        now + Duration::milliseconds(100),
        None,
        None,
    );
    let candidate = promotion_candidate(run_id, &dispatch, candidate_action.sealed_receipt_set());
    let candidate_event = promotion_event(
        run_id,
        Some(candidate_action.sealed_receipt_set_event().id),
        EventKind::CandidateCreatedV2,
        now + Duration::seconds(1),
        Payload::CandidateCreatedV2(candidate.clone()),
    );
    store
        .append_signed(&candidate_event, &kernel_key, &kernel)
        .expect("append immutable candidate");
    let completion_at =
        DateTime::parse_from_rfc3339(&candidate_action.sealed_receipt_set().sealed_at)
            .expect("candidate receipt set must use a canonical timestamp")
            .with_timezone(&Utc);
    let orphaned_completion = promotion_candidate_completion(
        &candidate,
        candidate_event.id,
        &candidate_action,
        completion_at,
    );
    let orphaned_event = promotion_event(
        run_id,
        Some(candidate_event.id),
        EventKind::CandidateCompletionRecordedV1,
        completion_at,
        Payload::CandidateCompletionRecordedV1(orphaned_completion),
    );
    store
        .append_signed(&orphaned_event, &kernel_key, &kernel)
        .expect("append an orphaned legacy completion proof");

    let request = GovernedCandidateCompletionRequestV1 {
        run_id,
        dispatch_event_id: dispatch_event.id,
        candidate_created_event_id: candidate_event.id,
    };
    let before = promotion_event_count(&store, run_id, "candidate_completion_recorded_v1");
    let outcome =
        store.record_governed_candidate_completion_v1(&request, &authority, &kernel_key, &kernel);
    assert!(
        matches!(
            &outcome,
            Err(LedgerError::CandidateCompletionReconciliationRequired { .. })
        ),
        "a tape completion without the native atomic projection must block reconciliation: {outcome:?}",
    );
    assert_eq!(
        promotion_event_count(&store, run_id, "candidate_completion_recorded_v1"),
        before,
        "reconciliation must not append a competing completion after an orphaned proof",
    );
}

#[test]
fn native_candidate_completion_blocks_an_off_parent_payload_referenced_tape_proof() {
    let fixture = candidate_completion_fixture(93);
    let (candidate, candidate_event) = append_candidate_artifact(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.kernel_key,
        &fixture.kernel,
        fixture.candidate_action.sealed_receipt_set_event(),
        fixture.candidate_action.sealed_receipt_set(),
        fixture.now + Duration::seconds(1),
    );
    let completion_at = fixture.now + Duration::seconds(2);
    let off_parent_completion = promotion_event(
        fixture.run_id,
        Some(fixture.dispatch_event.id),
        EventKind::CandidateCompletionRecordedV1,
        completion_at,
        Payload::CandidateCompletionRecordedV1(promotion_candidate_completion(
            &candidate,
            candidate_event.id,
            &fixture.candidate_action,
            completion_at,
        )),
    );
    fixture
        .store
        .append_signed(&off_parent_completion, &fixture.kernel_key, &fixture.kernel)
        .expect("append a completion payload with a substituted tape parent");

    let request = candidate_completion_request(&fixture, &candidate_event);
    let before = promotion_event_count(
        &fixture.store,
        fixture.run_id,
        "candidate_completion_recorded_v1",
    );
    let outcome = fixture.store.record_governed_candidate_completion_v1(
        &request,
        &fixture.authority,
        &fixture.kernel_key,
        &fixture.kernel,
    );
    assert!(
        matches!(
            &outcome,
            Err(LedgerError::CandidateCompletionReconciliationRequired { .. })
        ),
        "a completion payload that names the candidate but has a substituted parent must block reconciliation: {outcome:?}",
    );
    assert_eq!(
        promotion_event_count(
            &fixture.store,
            fixture.run_id,
            "candidate_completion_recorded_v1",
        ),
        before,
        "reconciliation must not append a native completion beside an off-parent tape proof",
    );
}

#[test]
fn native_candidate_completion_rejects_graph_bound_v4_without_a_signed_graph_admission() {
    let fixture = candidate_completion_fixture(95);
    let (_, candidate_event) = append_candidate_artifact(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.kernel_key,
        &fixture.kernel,
        fixture.candidate_action.sealed_receipt_set_event(),
        fixture.candidate_action.sealed_receipt_set(),
        fixture.now + Duration::seconds(1),
    );
    let graph_declaration_event_ref = EventId::new();
    let mut graph_bound_dispatch = DispatchEnvelopeV4 {
        dispatch_v3: fixture.dispatch.clone(),
        workflow_graph_digest: DIGEST_A.into(),
        workflow_graph_declaration_event_ref: graph_declaration_event_ref,
        envelope_digest: String::new(),
    };
    graph_bound_dispatch.envelope_digest = dispatch_envelope_v4_digest(
        &graph_bound_dispatch.dispatch_v3,
        &graph_bound_dispatch.workflow_graph_digest,
        &graph_bound_dispatch.workflow_graph_declaration_event_ref,
    )
    .expect("hash syntactically valid graph-bound dispatch");
    let graph_bound_dispatch_event = promotion_event(
        fixture.run_id,
        Some(fixture.dispatch_event.id),
        EventKind::DispatchEnvelopeV4,
        fixture.now + Duration::seconds(2),
        Payload::DispatchEnvelopeV4(graph_bound_dispatch),
    );
    fixture
        .store
        .append_signed(
            &graph_bound_dispatch_event,
            &fixture.kernel_key,
            &fixture.kernel,
        )
        .expect("append signed graph-bound dispatch");

    let request = GovernedCandidateCompletionRequestV1 {
        run_id: fixture.run_id,
        dispatch_event_id: graph_bound_dispatch_event.id,
        candidate_created_event_id: candidate_event.id,
    };
    let outcome = fixture.store.record_governed_candidate_completion_v1(
        &request,
        &fixture.authority,
        &fixture.kernel_key,
        &fixture.kernel,
    );
    assert!(
        matches!(
            &outcome,
            Err(LedgerError::CandidateCompletionAuthorityRejected { .. })
        ),
        "graph-bound V4 dispatches without a signed graph admission must fail closed: {outcome:?}",
    );
    assert_eq!(
        promotion_event_count(
            &fixture.store,
            fixture.run_id,
            "candidate_completion_recorded_v1",
        ),
        0,
        "an unsupported V4 dispatch must not receive a native completion proof",
    );
}

#[test]
fn native_candidate_completion_records_a_singleton_first_attempt_graph_bound_v4_candidate() {
    let fixture = singleton_graph_bound_v4_candidate_completion_fixture(96);
    let (_, candidate_event) = append_candidate_artifact(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.kernel_key,
        &fixture.kernel,
        fixture.candidate_action.sealed_receipt_set_event(),
        fixture.candidate_action.sealed_receipt_set(),
        fixture.now + Duration::seconds(1),
    );
    let request = candidate_completion_request(&fixture, &candidate_event);

    let (completion_event_id, completion_event_digest, completion_digest) = match fixture
        .store
        .record_governed_candidate_completion_v1(
            &request,
            &fixture.authority,
            &fixture.kernel_key,
            &fixture.kernel,
        )
        .expect("singleton first-attempt V4 evidence should be certifiable")
    {
        GovernedCandidateCompletionDispositionV1::Recorded {
            candidate_completion_event_id,
            candidate_completion_event_digest,
            completion_digest,
        } => (
            candidate_completion_event_id,
            candidate_completion_event_digest,
            completion_digest,
        ),
        other => panic!("expected a first V4 completion record, received {other:?}"),
    };

    assert_eq!(
        fixture
            .store
            .record_governed_candidate_completion_v1(
                &request,
                &fixture.authority,
                &fixture.kernel_key,
                &fixture.kernel,
            )
            .expect("the exact V4 retry should resolve the immutable completion"),
        GovernedCandidateCompletionDispositionV1::Existing {
            candidate_completion_event_id: completion_event_id,
            candidate_completion_event_digest: completion_event_digest,
            completion_digest,
        },
    );
    assert_eq!(
        promotion_event_count(
            &fixture.store,
            fixture.run_id,
            "candidate_completion_recorded_v1",
        ),
        1,
        "exact V4 retries must not append a second completion proof",
    );
}

#[test]
fn native_candidate_completion_records_a_checkpointed_singleton_graph_bound_v4_candidate() {
    let fixture = graph_bound_v4_candidate_completion_fixture(102, 1, false, false, true);
    let (_, candidate_event) = append_candidate_artifact(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.kernel_key,
        &fixture.kernel,
        fixture.candidate_action.sealed_receipt_set_event(),
        fixture.candidate_action.sealed_receipt_set(),
        fixture.now + Duration::seconds(1),
    );
    let request = candidate_completion_request(&fixture, &candidate_event);

    let recorded = fixture
        .store
        .record_governed_candidate_completion_v1(
            &request,
            &fixture.authority,
            &fixture.kernel_key,
            &fixture.kernel,
        )
        .expect("a signed checkpoint is tape metadata, not competing graph state");
    assert!(matches!(
        recorded,
        GovernedCandidateCompletionDispositionV1::Recorded { .. }
    ));
    assert_eq!(
        promotion_event_count(
            &fixture.store,
            fixture.run_id,
            "candidate_completion_recorded_v1",
        ),
        1,
        "a checkpointed singleton V4 candidate must receive exactly one completion proof",
    );
}

#[test]
fn native_candidate_completion_keeps_wider_or_concurrent_graph_bound_v4_admission_closed() {
    for (label, max_concurrent, include_second_node, seed) in [
        ("multiple nodes", 1, true, 97),
        ("max concurrent above one", 2, false, 98),
    ] {
        let fixture = graph_bound_v4_candidate_completion_fixture(
            seed,
            max_concurrent,
            include_second_node,
            false,
            false,
        );
        let (_, candidate_event) = append_candidate_artifact(
            &fixture.store,
            fixture.run_id,
            &fixture.dispatch,
            &fixture.kernel_key,
            &fixture.kernel,
            fixture.candidate_action.sealed_receipt_set_event(),
            fixture.candidate_action.sealed_receipt_set(),
            fixture.now + Duration::seconds(1),
        );
        let outcome = fixture.store.record_governed_candidate_completion_v1(
            &candidate_completion_request(&fixture, &candidate_event),
            &fixture.authority,
            &fixture.kernel_key,
            &fixture.kernel,
        );
        assert!(
            matches!(
                outcome,
                Err(LedgerError::CandidateCompletionAuthorityRejected { .. })
            ),
            "{label} graph admission must remain fail-closed until the full reducer is shared",
        );
        assert_eq!(
            promotion_event_count(
                &fixture.store,
                fixture.run_id,
                "candidate_completion_recorded_v1",
            ),
            0,
            "{label} graph must not receive a completion proof",
        );
    }
}

#[test]
fn native_candidate_completion_rejects_a_prior_signed_dispatch_before_singleton_v4_admission() {
    let fixture = graph_bound_v4_candidate_completion_fixture(99, 1, false, true, false);
    let (_, candidate_event) = append_candidate_artifact(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.kernel_key,
        &fixture.kernel,
        fixture.candidate_action.sealed_receipt_set_event(),
        fixture.candidate_action.sealed_receipt_set(),
        fixture.now + Duration::seconds(1),
    );

    let outcome = fixture.store.record_governed_candidate_completion_v1(
        &candidate_completion_request(&fixture, &candidate_event),
        &fixture.authority,
        &fixture.kernel_key,
        &fixture.kernel,
    );
    assert!(
        matches!(
            &outcome,
            Err(LedgerError::CandidateCompletionAuthorityRejected { reason })
                if reason.contains(
                    "candidate completion singleton graph-bound V4 admission rejects prior run activity or competing dispatch state"
                )
        ),
        "a valid signed pre-V4 dispatch must reach the strict singleton-prefix rejection: {outcome:?}",
    );
    assert_eq!(
        promotion_event_count(
            &fixture.store,
            fixture.run_id,
            "candidate_completion_recorded_v1",
        ),
        0,
        "a singleton V4 prefix conflict must not append a completion proof",
    );
}

#[test]
fn native_candidate_completion_rejects_an_unsigned_activity_after_v4_dispatch() {
    let fixture = singleton_graph_bound_v4_candidate_completion_fixture(100);
    let (_, candidate_event) = append_candidate_artifact(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.kernel_key,
        &fixture.kernel,
        fixture.candidate_action.sealed_receipt_set_event(),
        fixture.candidate_action.sealed_receipt_set(),
        fixture.now + Duration::seconds(1),
    );
    let unsigned_activity = promotion_event(
        fixture.run_id,
        Some(candidate_event.id),
        EventKind::ActivityStarted,
        fixture.now + Duration::seconds(2),
        Payload::ActivityStartedV1(ActivityStartedV1 {
            run_id: fixture.run_id,
            activity_id: "raw-post-v4".into(),
            activity_type: ActivityType::Tool,
            input_digest: DIGEST_A.into(),
        }),
    );
    fixture
        .store
        .append(&unsigned_activity)
        .expect("append an unsigned legacy activity bracket");

    let outcome = fixture.store.record_governed_candidate_completion_v1(
        &candidate_completion_request(&fixture, &candidate_event),
        &fixture.authority,
        &fixture.kernel_key,
        &fixture.kernel,
    );
    assert!(
        matches!(
            &outcome,
            Err(LedgerError::CandidateCompletionAuthorityRejected { .. })
        ),
        "an unsigned activity in a governed V4 run must block candidate completion: {outcome:?}",
    );
    assert_eq!(
        promotion_event_count(
            &fixture.store,
            fixture.run_id,
            "candidate_completion_recorded_v1",
        ),
        0,
        "an unverified governed activity must not be sealed beside a candidate completion",
    );
}

#[test]
fn native_candidate_completion_rejects_a_signed_v3_dispatch_after_v4_candidate() {
    let fixture = singleton_graph_bound_v4_candidate_completion_fixture(101);
    let (_, candidate_event) = append_candidate_artifact(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.kernel_key,
        &fixture.kernel,
        fixture.candidate_action.sealed_receipt_set_event(),
        fixture.candidate_action.sealed_receipt_set(),
        fixture.now + Duration::seconds(1),
    );
    let Payload::DispatchEnvelopeV4(graph_dispatch) = &fixture.dispatch_event.payload else {
        unreachable!("singleton fixture must carry the graph-bound V4 dispatch")
    };
    let later_dispatch = promotion_event(
        fixture.run_id,
        Some(candidate_event.id),
        EventKind::DispatchEnvelopeV3,
        fixture.now + Duration::seconds(2),
        Payload::DispatchEnvelopeV3(graph_dispatch.dispatch_v3.clone()),
    );
    fixture
        .store
        .append_signed(&later_dispatch, &fixture.kernel_key, &fixture.kernel)
        .expect("append a canonical signed nested V3 dispatch after the V4 candidate");

    let outcome = fixture.store.record_governed_candidate_completion_v1(
        &candidate_completion_request(&fixture, &candidate_event),
        &fixture.authority,
        &fixture.kernel_key,
        &fixture.kernel,
    );
    assert!(
        matches!(
            &outcome,
            Err(LedgerError::CandidateCompletionAuthorityRejected { reason })
                if reason.contains(
                    "candidate completion singleton graph-bound V4 tape contains an unmodeled ordinary event"
                )
        ),
        "a signed V4-to-V3 workflow collision must reach the singleton closure: {outcome:?}",
    );
    assert_eq!(
        promotion_event_count(
            &fixture.store,
            fixture.run_id,
            "candidate_completion_recorded_v1",
        ),
        0,
        "a replay-invalid signed V3 tail must not receive a V4 completion proof",
    );
}

#[test]
fn native_candidate_completion_uses_outer_v4_lineage_when_a_graph_workflow_is_cancelled() {
    let fixture = singleton_graph_bound_v4_candidate_completion_fixture(99);
    let (_, candidate_event) = append_candidate_artifact(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.kernel_key,
        &fixture.kernel,
        fixture.candidate_action.sealed_receipt_set_event(),
        fixture.candidate_action.sealed_receipt_set(),
        fixture.now + Duration::seconds(1),
    );
    let cancellation_at = fixture.now + Duration::seconds(2);
    let cancellation = WorkflowCancellationRequestedV1 {
        run_id: fixture.run_id.to_string(),
        workflow_id: fixture.dispatch.body.workflow_id.clone(),
        workflow_revision: fixture.dispatch.body.workflow_revision.clone(),
        unit_id: fixture.dispatch.body.unit_id.clone(),
        attempt: fixture.dispatch.body.attempt,
        dispatch_event_ref: fixture.dispatch_event.id,
        dispatch_envelope_digest: fixture.dispatch.envelope_digest.clone(),
        cancellation_id: "cancel:singleton-v4".into(),
        cause: WorkflowCancellationCauseV1::OperatorRequested,
        timer_fired_event_ref: None,
        timer_fired_event_digest: None,
        requested_by: fixture.operator.actor_id.clone(),
        idempotency_key: "cancel:singleton-v4:1".into(),
        requested_at: timestamp(cancellation_at),
    };
    let cancellation_event = promotion_event(
        fixture.run_id,
        Some(fixture.dispatch_event.id),
        EventKind::WorkflowCancellationRequestedV1,
        cancellation_at,
        Payload::WorkflowCancellationRequestedV1(cancellation),
    );
    fixture
        .store
        .append_signed(
            &cancellation_event,
            &fixture.operator_key,
            &fixture.operator,
        )
        .expect("append outer-lineage V4 cancellation");

    assert!(
        matches!(
            fixture.store.record_governed_candidate_completion_v1(
                &candidate_completion_request(&fixture, &candidate_event),
                &fixture.authority,
                &fixture.kernel_key,
                &fixture.kernel,
            ),
            Err(LedgerError::CandidateCompletionAuthorityRejected { .. })
        ),
        "an outer-lineage V4 cancellation must close candidate completion",
    );
    assert_eq!(
        promotion_event_count(
            &fixture.store,
            fixture.run_id,
            "candidate_completion_recorded_v1",
        ),
        0,
        "a cancelled V4 workflow must not receive a completion proof",
    );
}

#[test]
fn native_candidate_completion_rejects_a_candidate_without_the_receipt_set_parent() {
    let temp = TempDir::new().expect("temporary invalid-parent completion ledger directory");
    let store = SqliteStore::open(temp.path().join("events.db")).expect("open SQLite ledger");
    let run_id = RunId::new();
    let kernel_key = SigningKey::from_bytes(&[77; 32]);
    let reviewer_key = SigningKey::from_bytes(&[78; 32]);
    let operator_key = SigningKey::from_bytes(&[79; 32]);
    let kernel = promotion_actor("invalid-parent-kernel", "kernel-main", &kernel_key);
    let reviewer = promotion_actor("invalid-parent-reviewer", "reviewer-main", &reviewer_key);
    let operator = promotion_actor("invalid-parent-operator", "operator-main", &operator_key);
    let authority = GovernedPromotionAuthorityV1::new_governed_realm(
        promotion_trusted_keys(&[&kernel_key, &reviewer_key, &operator_key]),
        kernel.clone(),
        vec![reviewer],
        operator,
        DIGEST_E.into(),
    )
    .expect("construct governed candidate-completion authority");
    let now = DateTime::parse_from_rfc3339(&timestamp(Utc::now() - Duration::seconds(60)))
        .expect("round fixture timestamp to canonical milliseconds")
        .with_timezone(&Utc);
    let dispatch = promotion_dispatch(now, DIGEST_E);
    let dispatch_event = promotion_event(
        run_id,
        None,
        EventKind::DispatchEnvelopeV3,
        now,
        Payload::DispatchEnvelopeV3(dispatch.clone()),
    );
    store
        .append_signed(&dispatch_event, &kernel_key, &kernel)
        .expect("append governed implementation dispatch");
    let candidate_action_id = promotion_candidate_create_action_id(&run_id, dispatch.body.attempt);
    let candidate_action = append_promotion_action_evidence(
        &store,
        run_id,
        &dispatch,
        &dispatch_event,
        &kernel_key,
        &kernel,
        &candidate_action_id,
        ActionKindV1::Git,
        now + Duration::milliseconds(100),
        None,
        None,
    );
    let candidate = promotion_candidate(run_id, &dispatch, candidate_action.sealed_receipt_set());
    let candidate_event = promotion_event(
        run_id,
        // The signed payload binds the real receipt set, but the tape parent
        // is deliberately substituted. Native completion must reject this
        // instead of certifying a replay-invalid ordering.
        Some(dispatch_event.id),
        EventKind::CandidateCreatedV2,
        now + Duration::seconds(1),
        Payload::CandidateCreatedV2(candidate),
    );
    store
        .append_signed(&candidate_event, &kernel_key, &kernel)
        .expect("append candidate with a substituted parent");

    let request = GovernedCandidateCompletionRequestV1 {
        run_id,
        dispatch_event_id: dispatch_event.id,
        candidate_created_event_id: candidate_event.id,
    };
    let outcome =
        store.record_governed_candidate_completion_v1(&request, &authority, &kernel_key, &kernel);
    assert!(
        matches!(
            &outcome,
            Err(LedgerError::CandidateCompletionAuthorityRejected { .. })
        ),
        "a candidate without the exact receipt-set parent must not receive a completion proof: {outcome:?}",
    );
    assert_eq!(
        promotion_event_count(&store, run_id, "candidate_completion_recorded_v1"),
        0,
        "invalid receipt-set ordering must not append a completion proof",
    );
}

#[test]
fn native_candidate_completion_rejects_model_actions_in_a_complete_receipt_set() {
    let fixture =
        candidate_completion_fixture_with_options(80, unsealed_promotion_action_options());
    let model_action = append_promotion_action_evidence_with_options(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.dispatch_event,
        &fixture.kernel_key,
        &fixture.kernel,
        "model-implementation-sibling",
        ActionKindV1::Model,
        fixture.now + Duration::milliseconds(200),
        None,
        None,
        unsealed_promotion_action_options(),
    );
    let (receipt_set_event, receipt_set) = append_candidate_receipt_set(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.kernel_key,
        &fixture.kernel,
        model_action.receipt_event.id,
        "receipt-set:candidate-with-model",
        vec![
            promotion_receipt_set_entry(&fixture.candidate_action),
            promotion_receipt_set_entry(&model_action),
        ],
        fixture.now + Duration::milliseconds(210),
    );
    let (_, candidate_event) = append_candidate_artifact(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.kernel_key,
        &fixture.kernel,
        &receipt_set_event,
        &receipt_set,
        fixture.now + Duration::seconds(1),
    );

    assert_candidate_completion_authority_rejected(&fixture, &candidate_event);
}

#[test]
fn native_candidate_completion_rejects_receipt_sets_missing_a_signed_action() {
    let fixture =
        candidate_completion_fixture_with_options(81, unsealed_promotion_action_options());
    let sibling = append_promotion_action_evidence_with_options(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.dispatch_event,
        &fixture.kernel_key,
        &fixture.kernel,
        "git-sibling-action",
        ActionKindV1::Git,
        fixture.now + Duration::milliseconds(200),
        None,
        None,
        unsealed_promotion_action_options(),
    );
    let (receipt_set_event, receipt_set) = append_candidate_receipt_set(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.kernel_key,
        &fixture.kernel,
        sibling.receipt_event.id,
        "receipt-set:missing-sibling",
        vec![promotion_receipt_set_entry(&fixture.candidate_action)],
        fixture.now + Duration::milliseconds(210),
    );
    let (_, candidate_event) = append_candidate_artifact(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.kernel_key,
        &fixture.kernel,
        &receipt_set_event,
        &receipt_set,
        fixture.now + Duration::seconds(1),
    );

    assert_candidate_completion_authority_rejected(&fixture, &candidate_event);
}

#[test]
fn native_candidate_completion_rejects_receipt_sets_with_pending_actions() {
    let fixture =
        candidate_completion_fixture_with_options(82, unsealed_promotion_action_options());
    let pending_at = fixture.now + Duration::milliseconds(200);
    let mut pending_request = fixture.candidate_action.request.clone();
    pending_request.action_id = "git-pending-sibling".into();
    pending_request.idempotency_key = "action:git-pending-sibling".into();
    pending_request.canonical_input_ref = "cas:input:git-pending-sibling".into();
    pending_request.requested_at = timestamp(pending_at);
    let pending_event = promotion_event(
        fixture.run_id,
        Some(fixture.dispatch_event.id),
        EventKind::ActionRequestedV2,
        pending_at,
        Payload::ActionRequestedV2(pending_request),
    );
    fixture
        .store
        .append_signed(&pending_event, &fixture.kernel_key, &fixture.kernel)
        .expect("append request-only pending sibling action");
    let (receipt_set_event, receipt_set) = append_candidate_receipt_set(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.kernel_key,
        &fixture.kernel,
        pending_event.id,
        "receipt-set:pending-sibling",
        vec![
            promotion_receipt_set_entry(&fixture.candidate_action),
            ActionReceiptSetEntryV1 {
                action_id: "git-pending-sibling".into(),
                action_receipt_ref: "receipt:git-pending-sibling".into(),
                action_receipt_digest: DIGEST_A.into(),
            },
        ],
        fixture.now + Duration::milliseconds(210),
    );
    let (_, candidate_event) = append_candidate_artifact(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.kernel_key,
        &fixture.kernel,
        &receipt_set_event,
        &receipt_set,
        fixture.now + Duration::seconds(1),
    );

    assert_candidate_completion_authority_rejected(&fixture, &candidate_event);
}

#[test]
fn native_candidate_completion_rejects_failed_or_unknown_actions_in_full_receipt_sets() {
    for (seed, result_outcome, receipt_outcome, label) in [
        (
            83,
            ActivityResultOutcomeV1::Failed,
            ActionReceiptOutcomeV2::Failed,
            "failed",
        ),
        (
            84,
            ActivityResultOutcomeV1::Unknown,
            ActionReceiptOutcomeV2::Unknown,
            "unknown",
        ),
    ] {
        let fixture =
            candidate_completion_fixture_with_options(seed, unsealed_promotion_action_options());
        let sibling = append_promotion_action_evidence_with_options(
            &fixture.store,
            fixture.run_id,
            &fixture.dispatch,
            &fixture.dispatch_event,
            &fixture.kernel_key,
            &fixture.kernel,
            &format!("git-{label}-sibling"),
            ActionKindV1::Git,
            fixture.now + Duration::milliseconds(200),
            None,
            None,
            PromotionActionEvidenceOptions {
                result_outcome,
                receipt_outcome,
                emit_receipt_set: false,
                ..PromotionActionEvidenceOptions::default()
            },
        );
        let (receipt_set_event, receipt_set) = append_candidate_receipt_set(
            &fixture.store,
            fixture.run_id,
            &fixture.dispatch,
            &fixture.kernel_key,
            &fixture.kernel,
            sibling.receipt_event.id,
            &format!("receipt-set:{label}-sibling"),
            vec![
                promotion_receipt_set_entry(&fixture.candidate_action),
                promotion_receipt_set_entry(&sibling),
            ],
            fixture.now + Duration::milliseconds(210),
        );
        let (_, candidate_event) = append_candidate_artifact(
            &fixture.store,
            fixture.run_id,
            &fixture.dispatch,
            &fixture.kernel_key,
            &fixture.kernel,
            &receipt_set_event,
            &receipt_set,
            fixture.now + Duration::seconds(1),
        );

        assert_candidate_completion_authority_rejected(&fixture, &candidate_event);
    }
}

#[test]
fn native_candidate_completion_rejects_receipt_sets_with_extra_entries() {
    let fixture =
        candidate_completion_fixture_with_options(85, unsealed_promotion_action_options());
    let (receipt_set_event, receipt_set) = append_candidate_receipt_set(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.kernel_key,
        &fixture.kernel,
        fixture.candidate_action.receipt_event.id,
        "receipt-set:extra-entry",
        vec![
            promotion_receipt_set_entry(&fixture.candidate_action),
            ActionReceiptSetEntryV1 {
                action_id: "git-extra-entry".into(),
                action_receipt_ref: "receipt:git-extra-entry".into(),
                action_receipt_digest: DIGEST_A.into(),
            },
        ],
        fixture.now + Duration::milliseconds(110),
    );
    let (_, candidate_event) = append_candidate_artifact(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.kernel_key,
        &fixture.kernel,
        &receipt_set_event,
        &receipt_set,
        fixture.now + Duration::seconds(1),
    );

    assert_candidate_completion_authority_rejected(&fixture, &candidate_event);
}

#[test]
fn native_candidate_completion_rejects_a_request_timestamp_that_differs_from_its_event() {
    let now = DateTime::parse_from_rfc3339("2026-07-01T00:00:00.000Z")
        .expect("parse fixed fixture time")
        .with_timezone(&Utc);
    let fixture = candidate_completion_fixture_at(
        86,
        now,
        PromotionActionEvidenceOptions {
            requested_at: Some(now + Duration::milliseconds(99)),
            emit_receipt_set: false,
            ..PromotionActionEvidenceOptions::default()
        },
    );
    let (receipt_set_event, receipt_set) = append_candidate_receipt_set(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.kernel_key,
        &fixture.kernel,
        fixture.candidate_action.receipt_event.id,
        "receipt-set:request-timestamp-mismatch",
        vec![promotion_receipt_set_entry(&fixture.candidate_action)],
        now + Duration::milliseconds(110),
    );
    let (_, candidate_event) = append_candidate_artifact(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.kernel_key,
        &fixture.kernel,
        &receipt_set_event,
        &receipt_set,
        now + Duration::seconds(1),
    );

    assert_candidate_completion_authority_rejected(&fixture, &candidate_event);
}

#[test]
fn native_candidate_completion_rejects_a_lease_outside_the_signed_compute_deadline() {
    let now = DateTime::parse_from_rfc3339("2026-07-02T00:00:00.000Z")
        .expect("parse fixed fixture time")
        .with_timezone(&Utc);
    let fixture = candidate_completion_fixture_at(
        87,
        now,
        PromotionActionEvidenceOptions {
            lease_expires_at: Some(now + Duration::seconds(70)),
            emit_receipt_set: false,
            ..PromotionActionEvidenceOptions::default()
        },
    );
    let (receipt_set_event, receipt_set) = append_candidate_receipt_set(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.kernel_key,
        &fixture.kernel,
        fixture.candidate_action.receipt_event.id,
        "receipt-set:lease-deadline-mismatch",
        vec![promotion_receipt_set_entry(&fixture.candidate_action)],
        now + Duration::milliseconds(110),
    );
    let (_, candidate_event) = append_candidate_artifact(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.kernel_key,
        &fixture.kernel,
        &receipt_set_event,
        &receipt_set,
        now + Duration::seconds(1),
    );

    assert_candidate_completion_authority_rejected(&fixture, &candidate_event);
}

#[test]
fn native_candidate_completion_accepts_a_result_within_a_valid_heartbeat_extension() {
    let now = DateTime::parse_from_rfc3339("2026-07-03T00:00:00.000Z")
        .expect("parse fixed fixture time")
        .with_timezone(&Utc);
    let fixture = candidate_completion_fixture_at(
        88,
        now,
        PromotionActionEvidenceOptions {
            lease_expires_at: Some(now + Duration::seconds(30)),
            heartbeat: Some((now + Duration::seconds(20), now + Duration::seconds(50))),
            result_at: Some(now + Duration::seconds(40)),
            ..PromotionActionEvidenceOptions::default()
        },
    );
    let (candidate, candidate_event) = append_candidate_artifact(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.kernel_key,
        &fixture.kernel,
        fixture.candidate_action.sealed_receipt_set_event(),
        fixture.candidate_action.sealed_receipt_set(),
        now + Duration::seconds(41),
    );
    let request = candidate_completion_request(&fixture, &candidate_event);
    let outcome = fixture.store.record_governed_candidate_completion_v1(
        &request,
        &fixture.authority,
        &fixture.kernel_key,
        &fixture.kernel,
    );
    assert!(
        matches!(
            outcome,
            Ok(GovernedCandidateCompletionDispositionV1::Recorded { .. })
        ),
        "a valid heartbeat extension must preserve a certifiable candidate: {outcome:?}",
    );
    assert_eq!(candidate.candidate_digest, DIGEST_A);
}

#[test]
fn native_candidate_completion_rejects_an_off_parent_same_attempt_action_request() {
    let fixture = candidate_completion_fixture(89);
    let off_parent_at = fixture.now + Duration::milliseconds(200);
    let mut off_parent_request = fixture.candidate_action.request.clone();
    off_parent_request.action_id = "git-off-parent-sibling".into();
    off_parent_request.idempotency_key = "action:git-off-parent-sibling".into();
    off_parent_request.canonical_input_ref = "cas:input:git-off-parent-sibling".into();
    off_parent_request.requested_at = timestamp(off_parent_at);
    let off_parent_event = promotion_event(
        fixture.run_id,
        Some(fixture.candidate_action.receipt_event.id),
        EventKind::ActionRequestedV2,
        off_parent_at,
        Payload::ActionRequestedV2(off_parent_request),
    );
    fixture
        .store
        .append_signed(&off_parent_event, &fixture.kernel_key, &fixture.kernel)
        .expect("append off-parent same-attempt action request");
    let (_, candidate_event) = append_candidate_artifact(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.kernel_key,
        &fixture.kernel,
        fixture.candidate_action.sealed_receipt_set_event(),
        fixture.candidate_action.sealed_receipt_set(),
        fixture.now + Duration::seconds(1),
    );

    assert_candidate_completion_authority_rejected(&fixture, &candidate_event);
}

#[test]
fn native_candidate_completion_rejects_retry_attempts_without_native_retry_replay_inputs() {
    let now = DateTime::parse_from_rfc3339("2026-07-04T00:00:00.000Z")
        .expect("parse fixed fixture time")
        .with_timezone(&Utc);
    let fixture = candidate_completion_fixture_for_attempt_at(
        90,
        now,
        2,
        PromotionActionEvidenceOptions::default(),
    );
    let (_, candidate_event) = append_candidate_artifact(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.kernel_key,
        &fixture.kernel,
        fixture.candidate_action.sealed_receipt_set_event(),
        fixture.candidate_action.sealed_receipt_set(),
        now + Duration::seconds(1),
    );

    assert_candidate_completion_authority_rejected(&fixture, &candidate_event);
}

#[test]
fn native_candidate_completion_rejects_a_valid_matching_cancellation_before_candidate_creation() {
    let fixture = candidate_completion_fixture(91);
    let cancellation_at = fixture.now + Duration::milliseconds(500);
    let cancellation = WorkflowCancellationRequestedV1 {
        run_id: fixture.run_id.to_string(),
        workflow_id: fixture.dispatch.body.workflow_id.clone(),
        workflow_revision: fixture.dispatch.body.workflow_revision.clone(),
        unit_id: fixture.dispatch.body.unit_id.clone(),
        attempt: fixture.dispatch.body.attempt,
        dispatch_event_ref: fixture.dispatch_event.id,
        dispatch_envelope_digest: fixture.dispatch.envelope_digest.clone(),
        cancellation_id: "cancel-before-candidate".into(),
        cause: WorkflowCancellationCauseV1::OperatorRequested,
        timer_fired_event_ref: None,
        timer_fired_event_digest: None,
        requested_by: fixture.operator.actor_id.clone(),
        idempotency_key: "cancel:before-candidate".into(),
        requested_at: timestamp(cancellation_at),
    };
    let cancellation_event = promotion_event(
        fixture.run_id,
        Some(fixture.dispatch_event.id),
        EventKind::WorkflowCancellationRequestedV1,
        cancellation_at,
        Payload::WorkflowCancellationRequestedV1(cancellation),
    );
    fixture
        .store
        .append_signed(
            &cancellation_event,
            &fixture.operator_key,
            &fixture.operator,
        )
        .expect("append matching operator cancellation");
    let (_, candidate_event) = append_candidate_artifact(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.kernel_key,
        &fixture.kernel,
        fixture.candidate_action.sealed_receipt_set_event(),
        fixture.candidate_action.sealed_receipt_set(),
        fixture.now + Duration::seconds(1),
    );

    assert_candidate_completion_authority_rejected(&fixture, &candidate_event);
}

#[test]
fn native_candidate_completion_rejects_a_valid_matching_cancellation_after_candidate_creation() {
    let fixture = candidate_completion_fixture(94);
    let (_, candidate_event) = append_candidate_artifact(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.kernel_key,
        &fixture.kernel,
        fixture.candidate_action.sealed_receipt_set_event(),
        fixture.candidate_action.sealed_receipt_set(),
        fixture.now + Duration::seconds(1),
    );
    let cancellation_at = fixture.now + Duration::seconds(2);
    let cancellation = WorkflowCancellationRequestedV1 {
        run_id: fixture.run_id.to_string(),
        workflow_id: fixture.dispatch.body.workflow_id.clone(),
        workflow_revision: fixture.dispatch.body.workflow_revision.clone(),
        unit_id: fixture.dispatch.body.unit_id.clone(),
        attempt: fixture.dispatch.body.attempt,
        dispatch_event_ref: fixture.dispatch_event.id,
        dispatch_envelope_digest: fixture.dispatch.envelope_digest.clone(),
        cancellation_id: "cancel-after-candidate".into(),
        cause: WorkflowCancellationCauseV1::OperatorRequested,
        timer_fired_event_ref: None,
        timer_fired_event_digest: None,
        requested_by: fixture.operator.actor_id.clone(),
        idempotency_key: "cancel:after-candidate".into(),
        requested_at: timestamp(cancellation_at),
    };
    let cancellation_event = promotion_event(
        fixture.run_id,
        Some(fixture.dispatch_event.id),
        EventKind::WorkflowCancellationRequestedV1,
        cancellation_at,
        Payload::WorkflowCancellationRequestedV1(cancellation),
    );
    fixture
        .store
        .append_signed(
            &cancellation_event,
            &fixture.operator_key,
            &fixture.operator,
        )
        .expect("append matching operator cancellation after candidate creation");

    assert_candidate_completion_authority_rejected(&fixture, &candidate_event);
}

#[test]
fn native_candidate_completion_preserves_nanosecond_candidate_timestamps() {
    let fixture = candidate_completion_fixture(92);
    let created_at = fixture.now + Duration::seconds(1) + Duration::nanoseconds(123_456_789);
    let (_, candidate_event) = append_candidate_artifact(
        &fixture.store,
        fixture.run_id,
        &fixture.dispatch,
        &fixture.kernel_key,
        &fixture.kernel,
        fixture.candidate_action.sealed_receipt_set_event(),
        fixture.candidate_action.sealed_receipt_set(),
        created_at,
    );
    let request = candidate_completion_request(&fixture, &candidate_event);
    let outcome = fixture
        .store
        .record_governed_candidate_completion_v1(
            &request,
            &fixture.authority,
            &fixture.kernel_key,
            &fixture.kernel,
        )
        .expect("record candidate completion with nanosecond parent timestamp");
    let completion_event_id = match outcome {
        GovernedCandidateCompletionDispositionV1::Recorded {
            candidate_completion_event_id,
            ..
        } => candidate_completion_event_id,
        other => panic!("expected first completion record, received {other:?}"),
    };
    let completion_event = fixture
        .store
        .events_for_run(&fixture.run_id.to_string())
        .expect("read native completion tape")
        .into_iter()
        .map(|row| row.to_event().expect("canonical completion event"))
        .find(|event| event.id == completion_event_id)
        .expect("completion event exists");
    let Payload::CandidateCompletionRecordedV1(completion) = completion_event.payload else {
        panic!("native completion event must carry a candidate completion payload")
    };
    assert_eq!(completion_event.occurred_at, created_at);
    assert_eq!(
        completion.completed_at,
        created_at.to_rfc3339_opts(SecondsFormat::Nanos, true),
    );
}

#[test]
fn broker_promotion_decision_records_seals_and_replays_only_a_sealed_disposition() {
    let fixture = promotion_fixture();
    let broker = promotion_broker(&fixture);

    let first = broker.record_then_seal(fixture.request.clone());
    let replay = broker.record_then_seal(fixture.request.clone());

    assert_eq!(first, BrokerPromotionDecisionDisposition::Sealed);
    assert_eq!(replay, BrokerPromotionDecisionDisposition::Sealed);
    assert_eq!(
        promotion_event_count(
            &fixture.store,
            fixture.request.run_id,
            "promotion_decision_recorded",
        ),
        1
    );
    assert_eq!(
        promotion_event_count(&fixture.store, fixture.request.run_id, "tape_checkpoint"),
        2,
        "one checkpoint seals native candidate completion and one seals promotion"
    );
}

#[test]
fn promotion_replay_verifier_reopens_the_exact_sealed_decision_and_rejects_substitution() {
    let fixture = promotion_fixture();
    let broker = promotion_broker(&fixture);
    assert_eq!(
        broker.record_then_seal(fixture.request.clone()),
        BrokerPromotionDecisionDisposition::Sealed
    );
    let decision_event_id = fixture
        .store
        .events_for_run(&fixture.request.run_id.to_string())
        .expect("read sealed promotion tape")
        .into_iter()
        .find_map(|row| {
            let event = row.to_event().expect("stored promotion event is canonical");
            matches!(&event.payload, Payload::PromotionDecisionRecordedV1(_)).then_some(event.id)
        })
        .expect("sealed decision event exists");
    let replay_authorities = promotion_replay_authorities(&fixture);
    let mut verifier = PromotionReplaySnapshotVerifier::from_prevalidated_startup(
        fixture._temp.path().join("events.db"),
        &replay_authorities,
        &fixture.kernel,
    );

    let valid_binding = verifier.verify_exact_promotion(
        fixture.request.run_id,
        &BrokerPromotionExecutionRequest {
            promotion_decision_event_id: decision_event_id,
        },
    );
    let valid_error = valid_binding.err();
    assert!(
        valid_error.is_none(),
        "sealed promotion must reopen from the trusted snapshot: {valid_error:?}"
    );
    assert!(matches!(
        verifier.verify_exact_promotion(
            fixture.request.run_id,
            &BrokerPromotionExecutionRequest {
                promotion_decision_event_id: EventId::new(),
            },
        ),
        Err(PromotionExecutionError::TrustedReplayBindingMismatch)
    ));
}

#[test]
fn broker_promotion_decision_reconciles_substituted_tape_references_without_recording() {
    let fixture = promotion_fixture();
    let broker = promotion_broker(&fixture);
    let mut substituted = fixture.request.clone();
    substituted.acceptance_event_id = EventId::new();

    assert_eq!(
        broker.record_then_seal(substituted),
        BrokerPromotionDecisionDisposition::ReconciliationRequired
    );
    assert_eq!(
        promotion_event_count(
            &fixture.store,
            fixture.request.run_id,
            "promotion_decision_recorded",
        ),
        0
    );
    assert_eq!(
        promotion_event_count(&fixture.store, fixture.request.run_id, "tape_checkpoint"),
        1,
        "the fixture's native candidate completion is sealed before a rejected promotion request"
    );
}

#[test]
fn broker_promotion_decision_reconciles_a_cross_run_request_before_recording() {
    let fixture = promotion_fixture();
    let broker = promotion_broker(&fixture);
    let mut cross_run = fixture.request.clone();
    cross_run.run_id = RunId::new();

    assert_eq!(
        broker.record_then_seal(cross_run),
        BrokerPromotionDecisionDisposition::ReconciliationRequired
    );
    assert_eq!(
        promotion_event_count(
            &fixture.store,
            fixture.request.run_id,
            "promotion_decision_recorded",
        ),
        0
    );
    assert_eq!(
        promotion_event_count(&fixture.store, fixture.request.run_id, "tape_checkpoint"),
        1,
        "the fixture's native candidate completion is sealed before a cross-run rejection"
    );
}

#[test]
fn broker_promotion_decision_reconciles_a_same_store_cross_run_event_reference() {
    let fixture = promotion_fixture();
    let second_run_request = append_promotion_evidence(
        &fixture.store,
        RunId::new(),
        &fixture.authority,
        &fixture.kernel_key,
        &fixture.kernel,
        &fixture.reviewer_key,
        &fixture.reviewer,
    );
    let broker = promotion_broker(&fixture);
    let mut substituted = fixture.request.clone();
    substituted.acceptance_event_id = second_run_request.acceptance_event_id;

    assert_eq!(substituted.run_id, fixture.request.run_id);
    assert_eq!(
        broker.record_then_seal(substituted),
        BrokerPromotionDecisionDisposition::ReconciliationRequired
    );
    assert_eq!(
        promotion_event_count(
            &fixture.store,
            fixture.request.run_id,
            "promotion_decision_recorded",
        ),
        0
    );
    assert_eq!(
        promotion_event_count(
            &fixture.store,
            second_run_request.run_id,
            "promotion_decision_recorded",
        ),
        0
    );
}

#[test]
fn broker_promotion_decision_retries_an_existing_record_after_a_failed_seal_without_reissue() {
    let fixture = promotion_fixture();
    let wrong_kernel_key = SigningKey::from_bytes(&[64; 32]);
    let failed_seal_broker = BrokerPromotionDecisionAuthority::from_prevalidated_startup(
        fixture.request.run_id,
        &fixture.store,
        &fixture.authority,
        &fixture.operator_key,
        &fixture.operator,
        &wrong_kernel_key,
        &fixture.kernel,
    )
    .expect("a non-aliased but untrusted kernel key is a recoverable startup injection");

    assert_eq!(
        failed_seal_broker.record_then_seal(fixture.request.clone()),
        BrokerPromotionDecisionDisposition::ReconciliationRequired
    );
    assert_eq!(
        promotion_event_count(
            &fixture.store,
            fixture.request.run_id,
            "promotion_decision_recorded",
        ),
        1
    );
    assert_eq!(
        promotion_event_count(&fixture.store, fixture.request.run_id, "tape_checkpoint"),
        1,
        "failed promotion sealing must not erase the prior candidate-completion checkpoint"
    );

    let recovered_broker = promotion_broker(&fixture);
    assert_eq!(
        recovered_broker.record_then_seal(fixture.request.clone()),
        BrokerPromotionDecisionDisposition::Sealed
    );
    assert_eq!(
        promotion_event_count(
            &fixture.store,
            fixture.request.run_id,
            "promotion_decision_recorded",
        ),
        1
    );
    assert_eq!(
        promotion_event_count(&fixture.store, fixture.request.run_id, "tape_checkpoint"),
        2,
        "retry adds only the promotion checkpoint after the native candidate-completion checkpoint"
    );
}

#[test]
fn broker_promotion_startup_rejects_shared_operator_and_kernel_key_material() {
    let fixture = promotion_fixture();

    let startup = BrokerPromotionDecisionAuthority::from_prevalidated_startup(
        fixture.request.run_id,
        &fixture.store,
        &fixture.authority,
        &fixture.operator_key,
        &fixture.operator,
        &fixture.operator_key,
        &fixture.kernel,
    );

    assert!(matches!(
        startup,
        Err(BrokerPromotionDecisionStartupError::SharedSigningKeyMaterial)
    ));
}

#[test]
fn broker_promotion_startup_rejects_shared_operator_and_kernel_signer_identity() {
    let fixture = promotion_fixture();

    let startup = BrokerPromotionDecisionAuthority::from_prevalidated_startup(
        fixture.request.run_id,
        &fixture.store,
        &fixture.authority,
        &fixture.operator_key,
        &fixture.operator,
        &fixture.kernel_key,
        &fixture.operator,
    );

    assert!(matches!(
        startup,
        Err(BrokerPromotionDecisionStartupError::SharedSignerIdentity)
    ));
}

const PROMOTION_CANDIDATE_DIGEST: &str =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PROMOTION_TREE_DIGEST: &str =
    "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const PROMOTION_BASE_COMMIT: &str = "1111111111111111111111111111111111111111";
const PROMOTION_CANDIDATE_COMMIT: &str = "2222222222222222222222222222222222222222";
const PROMOTION_CANDIDATE_TREE: &str = "3333333333333333333333333333333333333333";
const PROMOTION_MERGE_COMMIT: &str = "4444444444444444444444444444444444444444";
const PROMOTION_TARGET_ADVANCED: &str = "5555555555555555555555555555555555555555";
const PROMOTION_CANDIDATE_REF: &str = "refs/buildplane/candidates/candidate-a";
const PROMOTION_TARGET_REF: &str = "refs/heads/main";
const PROMOTION_RECEIPT_REF: &str = "refs/buildplane/promotions/candidate-a";

fn promotion_capability() -> VerifiedPromotionCapability {
    VerifiedPromotionCapability::from_verified_facts(
        PROMOTION_CANDIDATE_DIGEST.into(),
        PROMOTION_CANDIDATE_REF.into(),
        PROMOTION_CANDIDATE_COMMIT.into(),
        PROMOTION_TREE_DIGEST.into(),
        PROMOTION_BASE_COMMIT.into(),
        PROMOTION_TARGET_REF.into(),
        "promotion:workflow-1:attempt-1".into(),
    )
    .expect("test capability is structurally verified")
}

fn promotion_execution_request() -> BrokerPromotionExecutionRequest {
    BrokerPromotionExecutionRequest {
        promotion_decision_event_id: EventId::new(),
    }
}

fn promotion_execution_binding(
    run_id: RunId,
    request: &BrokerPromotionExecutionRequest,
    dispatch_event_id: EventId,
    has_existing_claim: bool,
) -> TrustedPromotionBinding {
    TrustedPromotionBinding::for_tests(
        run_id,
        request.promotion_decision_event_id,
        DIGEST_A.into(),
        dispatch_event_id,
        DIGEST_B.into(),
        PromotionDecisionKindV1::Promote,
        ExecutionRoleV1::Implementer,
        CommitModeV1::Atomic,
        PROMOTION_CANDIDATE_DIGEST.into(),
        PROMOTION_CANDIDATE_REF.into(),
        PROMOTION_CANDIDATE_COMMIT.into(),
        PROMOTION_TREE_DIGEST.into(),
        PROMOTION_BASE_COMMIT.into(),
        PROMOTION_TARGET_REF.into(),
        "promotion:workflow-1:attempt-1".into(),
        has_existing_claim,
    )
}

struct FakePromotionVerifier {
    binding: Option<TrustedPromotionBinding>,
}

impl TrustedPromotionVerifier for FakePromotionVerifier {
    fn verify_exact_promotion(
        &mut self,
        _run_id: RunId,
        _request: &BrokerPromotionExecutionRequest,
    ) -> Result<TrustedPromotionBinding, PromotionExecutionError> {
        Ok(self
            .binding
            .take()
            .expect("test configured a promotion binding"))
    }
}

struct FailingPromotionVerifier {
    error: Option<PromotionExecutionError>,
}

impl TrustedPromotionVerifier for FailingPromotionVerifier {
    fn verify_exact_promotion(
        &mut self,
        _run_id: RunId,
        _request: &BrokerPromotionExecutionRequest,
    ) -> Result<TrustedPromotionBinding, PromotionExecutionError> {
        Err(self
            .error
            .take()
            .expect("test configured a trusted promotion replay error"))
    }
}

#[derive(Default)]
struct FakePromotionBackendState {
    claim_calls: usize,
    result_calls: usize,
}

struct FakePromotionBackend {
    state: Rc<RefCell<FakePromotionBackendState>>,
    grants: VecDeque<Result<PromotionExecutionGrant, PromotionExecutionError>>,
    results: VecDeque<Result<PromotionResultDisposition, PromotionExecutionError>>,
}

impl PromotionExecutionBackend for FakePromotionBackend {
    fn claim(
        &mut self,
        _run_id: RunId,
        _request: &BrokerPromotionExecutionRequest,
        _lease_duration_ms: u64,
    ) -> Result<PromotionExecutionGrant, PromotionExecutionError> {
        self.state.borrow_mut().claim_calls += 1;
        self.grants.pop_front().expect("test configured a grant")
    }

    fn record_result(
        &mut self,
        _run_id: RunId,
        _request: &BrokerPromotionExecutionRequest,
        _outcome: PromotionResultOutcomeV1,
        _binding: PromotionGitBindingV1,
        _lease_binding: bp_ledger::payload::trust_spine::PromotionExecutionLeaseBindingV1,
    ) -> Result<PromotionResultDisposition, PromotionExecutionError> {
        self.state.borrow_mut().result_calls += 1;
        self.results.pop_front().expect("test configured a result")
    }
}

#[derive(Default)]
struct FakePromotionGatewayState {
    calls: usize,
}

struct FakePromotionGateway {
    state: Rc<RefCell<FakePromotionGatewayState>>,
    outcome: Option<Result<PromotionGitOutcome, PromotionGitError>>,
}

impl PromotionEffectGateway for FakePromotionGateway {
    fn promote(
        &mut self,
        _capability: VerifiedPromotionCapability,
    ) -> Result<PromotionGitOutcome, PromotionGitError> {
        self.state.borrow_mut().calls += 1;
        self.outcome.take().expect("test configured a Git outcome")
    }
}

fn promotion_execution_claim(
    run_id: RunId,
    request: &BrokerPromotionExecutionRequest,
    dispatch_event_id: EventId,
) -> PromotionExecutionClaimedV1 {
    PromotionExecutionClaimedV1 {
        run_id: run_id.to_string(),
        promotion_decision_event_ref: request.promotion_decision_event_id,
        promotion_decision_event_digest: DIGEST_A.into(),
        dispatch_event_ref: dispatch_event_id,
        dispatch_envelope_digest: DIGEST_B.into(),
        candidate_digest: PROMOTION_CANDIDATE_DIGEST.into(),
        candidate_ref: PROMOTION_CANDIDATE_REF.into(),
        candidate_commit_sha: PROMOTION_CANDIDATE_COMMIT.into(),
        candidate_tree_digest: PROMOTION_TREE_DIGEST.into(),
        base_commit_sha: PROMOTION_BASE_COMMIT.into(),
        target_ref: PROMOTION_TARGET_REF.into(),
        idempotency_key: "promotion:workflow-1:attempt-1".into(),
        authority_actor: "promotion-kernel".into(),
        lease_id: "opaque-promotion-lease".into(),
        claimed_at: "2026-07-20T00:00:00.000Z".into(),
        lease_expires_at: "2026-07-20T00:01:00.000Z".into(),
        promotion_execution_claim_digest: DIGEST_C.into(),
    }
}

fn promotion_execution_outcome() -> PromotionGitOutcome {
    PromotionGitOutcome::RootPendingReconciliation {
        binding: PromotionGitBindingV1 {
            target_ref: PROMOTION_TARGET_REF.into(),
            target_head_before_sha: PROMOTION_BASE_COMMIT.into(),
            target_head_after_sha: Some(PROMOTION_MERGE_COMMIT.into()),
            merged_head_sha: Some(PROMOTION_MERGE_COMMIT.into()),
            candidate_commit_sha: PROMOTION_CANDIDATE_COMMIT.into(),
            merge_parent_shas: Some(vec![
                PROMOTION_BASE_COMMIT.into(),
                PROMOTION_CANDIDATE_COMMIT.into(),
            ]),
            merged_tree_sha: Some(PROMOTION_CANDIDATE_TREE.into()),
            merged_tree_digest: PROMOTION_TREE_DIGEST.into(),
            promotion_receipt_ref: Some(PROMOTION_RECEIPT_REF.into()),
            worktree_sync_state: Some(PromotionWorktreeSyncStateV1::RootCheckoutStale),
        },
    }
}

#[test]
fn promotion_execution_moves_one_sealed_claim_through_git_and_result_recording() {
    let run_id = RunId::new();
    let request = promotion_execution_request();
    let dispatch_event_id = EventId::new();
    let binding = promotion_execution_binding(run_id, &request, dispatch_event_id, false);
    let backend_state = Rc::new(RefCell::new(FakePromotionBackendState::default()));
    let gateway_state = Rc::new(RefCell::new(FakePromotionGatewayState::default()));
    let claim = promotion_execution_claim(run_id, &request, dispatch_event_id);
    let mut authority = BrokerPromotionExecutionAuthority::new(
        run_id,
        FakePromotionVerifier {
            binding: Some(binding),
        },
        FakePromotionBackend {
            state: Rc::clone(&backend_state),
            grants: [Ok(PromotionExecutionGrant::Granted {
                run_id,
                claim_event_id: EventId::new(),
                claim_event_digest: DIGEST_D.into(),
                claim,
            })]
            .into_iter()
            .collect(),
            results: [Ok(PromotionResultDisposition::Recorded { run_id })]
                .into_iter()
                .collect(),
        },
        FakePromotionGateway {
            state: Rc::clone(&gateway_state),
            outcome: Some(Ok(promotion_execution_outcome())),
        },
        LeasePolicy::from_startup_config(30_000).expect("valid promotion lease policy"),
    );

    assert_eq!(
        authority.claim_execute_and_record(request).unwrap(),
        BrokerPromotionExecutionStatus::Recorded
    );
    assert_eq!(backend_state.borrow().claim_calls, 1);
    assert_eq!(backend_state.borrow().result_calls, 1);
    assert_eq!(gateway_state.borrow().calls, 1);
}

#[test]
fn trusted_promotion_snapshot_failure_never_claims_or_enters_git() {
    // A bounded recovery refusal is also surfaced as this replay error, so
    // it cannot be downgraded into reconciliation or a new Git attempt.
    let run_id = RunId::new();
    let request = promotion_execution_request();
    let backend_state = Rc::new(RefCell::new(FakePromotionBackendState::default()));
    let gateway_state = Rc::new(RefCell::new(FakePromotionGatewayState::default()));
    let mut authority = BrokerPromotionExecutionAuthority::new(
        run_id,
        FailingPromotionVerifier {
            error: Some(PromotionExecutionError::Replay(bounded_recovery_error())),
        },
        FakePromotionBackend {
            state: Rc::clone(&backend_state),
            grants: VecDeque::new(),
            results: VecDeque::new(),
        },
        FakePromotionGateway {
            state: Rc::clone(&gateway_state),
            outcome: None,
        },
        LeasePolicy::from_startup_config(30_000).expect("valid promotion lease policy"),
    );

    assert!(matches!(
        authority.claim_execute_and_record(request),
        Err(PromotionExecutionError::Replay(_))
    ));
    assert_eq!(backend_state.borrow().claim_calls, 0);
    assert_eq!(backend_state.borrow().result_calls, 0);
    assert_eq!(gateway_state.borrow().calls, 0);
}

#[test]
fn promotion_execution_never_reenters_git_when_replay_already_contains_a_claim() {
    let run_id = RunId::new();
    let request = promotion_execution_request();
    let dispatch_event_id = EventId::new();
    let binding = promotion_execution_binding(run_id, &request, dispatch_event_id, true);
    let backend_state = Rc::new(RefCell::new(FakePromotionBackendState::default()));
    let gateway_state = Rc::new(RefCell::new(FakePromotionGatewayState::default()));
    let claim = promotion_execution_claim(run_id, &request, dispatch_event_id);
    let mut authority = BrokerPromotionExecutionAuthority::new(
        run_id,
        FakePromotionVerifier {
            binding: Some(binding),
        },
        FakePromotionBackend {
            state: Rc::clone(&backend_state),
            grants: [Ok(PromotionExecutionGrant::Granted {
                run_id,
                claim_event_id: EventId::new(),
                claim_event_digest: DIGEST_D.into(),
                claim,
            })]
            .into_iter()
            .collect(),
            results: VecDeque::new(),
        },
        FakePromotionGateway {
            state: Rc::clone(&gateway_state),
            outcome: Some(Ok(promotion_execution_outcome())),
        },
        LeasePolicy::from_startup_config(30_000).expect("valid promotion lease policy"),
    );

    assert_eq!(
        authority.claim_execute_and_record(request).unwrap(),
        BrokerPromotionExecutionStatus::ReconciliationRequired
    );
    assert_eq!(backend_state.borrow().claim_calls, 1);
    assert_eq!(backend_state.borrow().result_calls, 0);
    assert_eq!(gateway_state.borrow().calls, 0);
}

#[test]
fn promotion_execution_rejects_a_claim_substituted_from_another_dispatch_before_git() {
    let run_id = RunId::new();
    let request = promotion_execution_request();
    let dispatch_event_id = EventId::new();
    let binding = promotion_execution_binding(run_id, &request, dispatch_event_id, false);
    let backend_state = Rc::new(RefCell::new(FakePromotionBackendState::default()));
    let gateway_state = Rc::new(RefCell::new(FakePromotionGatewayState::default()));
    let claim = promotion_execution_claim(run_id, &request, EventId::new());
    let mut authority = BrokerPromotionExecutionAuthority::new(
        run_id,
        FakePromotionVerifier {
            binding: Some(binding),
        },
        FakePromotionBackend {
            state: Rc::clone(&backend_state),
            grants: [Ok(PromotionExecutionGrant::Granted {
                run_id,
                claim_event_id: EventId::new(),
                claim_event_digest: DIGEST_D.into(),
                claim,
            })]
            .into_iter()
            .collect(),
            results: VecDeque::new(),
        },
        FakePromotionGateway {
            state: Rc::clone(&gateway_state),
            outcome: Some(Ok(promotion_execution_outcome())),
        },
        LeasePolicy::from_startup_config(30_000).expect("valid promotion lease policy"),
    );

    assert!(matches!(
        authority.claim_execute_and_record(request),
        Err(PromotionExecutionError::TrustedReplayBindingMismatch)
    ));
    assert_eq!(backend_state.borrow().claim_calls, 1);
    assert_eq!(backend_state.borrow().result_calls, 0);
    assert_eq!(gateway_state.borrow().calls, 0);
}

fn promotion_decision_wire(
    request_id: &str,
    promotion_approval_request_event_id: &str,
    decision: &str,
) -> String {
    format!(
        r#"{{"request_id":"{request_id}","promotion_approval_request_event_id":"{promotion_approval_request_event_id}","decision":"{decision}"}}"#
    )
}

fn promotion_decision_wire_with_injected_field(
    request_id: &str,
    promotion_approval_request_event_id: &str,
    decision: &str,
    injected_field: &str,
) -> String {
    let mut wire =
        promotion_decision_wire(request_id, promotion_approval_request_event_id, decision);
    wire.pop()
        .expect("the canonical promotion decision wire ends in an object delimiter");
    format!(r#"{wire},"{injected_field}":"caller-controlled"}}"#)
}

#[test]
fn protected_promotion_decision_wire_accepts_only_closed_canonical_approval_identity_and_decision()
{
    let approval_event_id = EventId::new();
    let wire = promotion_decision_wire(
        "123e4567-e89b-12d3-a456-426614174000",
        &approval_event_id.to_string(),
        "promote",
    );

    let parsed = parse_promotion_decision_request(wire.as_bytes())
        .expect("the closed canonical promotion approval identity must parse");
    assert_eq!(
        parsed.promotion_approval_request_event_id,
        approval_event_id,
    );
    assert_eq!(parsed.decision, PromotionDecisionKindV1::Promote);

    for (label, malformed_wire) in [
        (
            "unknown authority field",
            promotion_decision_wire_with_injected_field(
                "123e4567-e89b-12d3-a456-426614174000",
                &approval_event_id.to_string(),
                "promote",
                "run_id",
            ),
        ),
        (
            "unknown lineage field",
            promotion_decision_wire_with_injected_field(
                "123e4567-e89b-12d3-a456-426614174000",
                &approval_event_id.to_string(),
                "promote",
                "candidate_created_event_id",
            ),
        ),
        (
            "missing decision",
            format!(
                r#"{{"request_id":"123e4567-e89b-12d3-a456-426614174000","promotion_approval_request_event_id":"{approval_event_id}"}}"#
            ),
        ),
        (
            "noncanonical request ID",
            promotion_decision_wire(
                "123E4567-e89b-12d3-a456-426614174000",
                &approval_event_id.to_string(),
                "promote",
            ),
        ),
        (
            "noncanonical approval ID",
            promotion_decision_wire(
                "123e4567-e89b-12d3-a456-426614174000",
                "123E4567-e89b-12d3-a456-426614174000",
                "promote",
            ),
        ),
        (
            "unsupported decision",
            promotion_decision_wire(
                "123e4567-e89b-12d3-a456-426614174000",
                &approval_event_id.to_string(),
                "PROMOTE",
            ),
        ),
    ] {
        assert!(
            matches!(
                parse_promotion_decision_request(malformed_wire.as_bytes()),
                Err(PromotionDecisionHandlerError::RequestRejected)
            ),
            "{label} must fail closed before the decision authority is entered"
        );
    }
}

fn checkpoint_pending_promotion_approval_for_trusted_replay(fixture: &PromotionFixture) {
    let checkpointed_at =
        DateTime::parse_from_rfc3339(&timestamp(Utc::now() + Duration::seconds(1)))
            .expect("round trusted replay checkpoint timestamp to canonical milliseconds")
            .with_timezone(&Utc);
    let checkpoint_trigger = promotion_event(
        fixture.request.run_id,
        None,
        EventKind::RunStarted,
        checkpointed_at,
        Payload::RunStartedV1(RunStartedV1 {
            packet_hash: DIGEST_A.into(),
            git_head: "0123456789abcdef0123456789abcdef01234567".into(),
            workspace_path: "/trusted/replay/fixture".into(),
            config: Default::default(),
            parent_run_id: None,
            parent_event_id: None,
        }),
    );
    fixture
        .store
        .append_signed_with_checkpoint(
            &checkpoint_trigger,
            &fixture.kernel_key,
            &fixture.kernel,
            &CheckpointPolicy::every(1),
        )
        .expect("seal the pending approval prefix for trusted replay");
}

fn protected_promotion_decision_authority<'a>(
    fixture: &'a PromotionFixture,
    replay_authorities: &'a TrustedReplayAuthorities,
) -> ProtectedPromotionDecisionAuthority<'a> {
    ProtectedPromotionDecisionAuthority::from_prevalidated_startup(
        fixture.request.run_id,
        fixture._temp.path().join("events.db"),
        replay_authorities,
        &fixture.kernel,
        &fixture.store,
        &fixture.authority,
        &fixture.operator_key,
        &fixture.operator,
        &fixture.kernel_key,
        &fixture.kernel,
    )
    .expect("inject the protected replay, ledger, and signer startup dependencies")
}

#[test]
fn protected_promotion_decision_handler_derives_verified_pending_lineage_then_seals() {
    let fixture = promotion_fixture();
    checkpoint_pending_promotion_approval_for_trusted_replay(&fixture);
    let replay_authorities = promotion_replay_authorities(&fixture);
    let mut authority = protected_promotion_decision_authority(&fixture, &replay_authorities);
    let wire = promotion_decision_wire(
        "123e4567-e89b-12d3-a456-426614174000",
        &fixture
            .request
            .promotion_approval_request_event_id
            .to_string(),
        "promote",
    );

    assert_eq!(
        handle_promotion_decision_wire(&mut authority, wire.as_bytes())
            .expect("a canonical opaque decision must reach the protected authority"),
        BrokerPromotionDecisionDisposition::Sealed
    );
    assert_eq!(
        promotion_event_count(
            &fixture.store,
            fixture.request.run_id,
            "promotion_decision_recorded",
        ),
        1
    );

    let recorded = fixture
        .store
        .events_for_run(&fixture.request.run_id.to_string())
        .expect("read the sealed promotion tape")
        .into_iter()
        .find_map(|row| {
            let event = row.to_event().expect("stored event remains canonical");
            match event.payload {
                Payload::PromotionDecisionRecordedV1(recorded) => Some(recorded),
                _ => None,
            }
        })
        .expect("the derived decision must be durably recorded");
    let approval = fixture
        .store
        .events_for_run(&fixture.request.run_id.to_string())
        .expect("read the source approval event")
        .into_iter()
        .find_map(|row| {
            let event = row.to_event().expect("stored event remains canonical");
            match event.payload {
                Payload::PromotionApprovalRequestedV1(approval) => Some(approval),
                _ => None,
            }
        })
        .expect("the fixture contains one signed approval request");
    assert_eq!(recorded.candidate_digest, approval.candidate_digest);
    assert_eq!(recorded.base_commit_sha, approval.base_commit_sha);
    assert_eq!(
        recorded.target_ref.as_deref(),
        Some(approval.target_ref.as_str())
    );
    assert_eq!(recorded.envelope_digest, approval.envelope_digest);
    assert_eq!(recorded.acceptance_ref, approval.acceptance_ref);
    assert_eq!(recorded.review_refs, approval.review_refs);
    assert_eq!(
        recorded.promotion_approval_request_ref.as_deref(),
        Some(
            fixture
                .request
                .promotion_approval_request_event_id
                .to_string()
                .as_str()
        )
    );
    assert_eq!(recorded.decision, PromotionDecisionKindV1::Promote);
}

#[test]
fn canonical_candidate_ref_run_substitution_reconciles_decision_and_never_enters_promotion_gateway()
{
    let fixture = promotion_fixture();
    let mut substituted_candidate = reconciliation_fixture_candidate(&fixture);
    let substituted_run_id = RunId::new();
    assert_ne!(substituted_run_id, fixture.request.run_id);
    substituted_candidate.candidate_ref = format!(
        "refs/buildplane/candidates/{}/{}/{}",
        substituted_candidate.candidate_id, substituted_run_id, substituted_candidate.attempt,
    );
    let malformed_at = DateTime::parse_from_rfc3339(&timestamp(Utc::now() + Duration::seconds(1)))
        .expect("round malformed candidate timestamp to canonical milliseconds")
        .with_timezone(&Utc);
    let malformed_candidate_event = promotion_event(
        fixture.request.run_id,
        Some(fixture.request.promotion_approval_request_event_id),
        EventKind::CandidateCreatedV2,
        malformed_at,
        Payload::CandidateCreatedV2(substituted_candidate),
    );
    fixture
        .store
        .append_signed_with_checkpoint(
            &malformed_candidate_event,
            &fixture.kernel_key,
            &fixture.kernel,
            &CheckpointPolicy::every(1),
        )
        .expect("append the canonical-but-cross-run candidate ref to the signed tape");

    let replay_authorities = promotion_replay_authorities(&fixture);
    let mut decision_authority =
        protected_promotion_decision_authority(&fixture, &replay_authorities);
    let decision_wire = promotion_decision_wire(
        "123e4567-e89b-12d3-a456-426614174000",
        &fixture
            .request
            .promotion_approval_request_event_id
            .to_string(),
        "promote",
    );

    assert_eq!(
        handle_promotion_decision_wire(&mut decision_authority, decision_wire.as_bytes())
            .expect("the canonical opaque decision request reaches trusted replay"),
        BrokerPromotionDecisionDisposition::ReconciliationRequired,
        "a candidate ref whose UUID run segment differs from the signed event run must not make a decision"
    );
    assert_eq!(
        promotion_event_count(
            &fixture.store,
            fixture.request.run_id,
            "promotion_decision_recorded",
        ),
        0,
        "rejected candidate lineage must not record a promotion decision"
    );

    let backend_state = Rc::new(RefCell::new(FakePromotionBackendState::default()));
    let gateway_state = Rc::new(RefCell::new(FakePromotionGatewayState::default()));
    let mut execution_authority = BrokerPromotionExecutionAuthority::new(
        fixture.request.run_id,
        PromotionReplaySnapshotVerifier::from_prevalidated_startup(
            fixture._temp.path().join("events.db"),
            &replay_authorities,
            &fixture.kernel,
        ),
        FakePromotionBackend {
            state: Rc::clone(&backend_state),
            grants: VecDeque::new(),
            results: VecDeque::new(),
        },
        FakePromotionGateway {
            state: Rc::clone(&gateway_state),
            outcome: None,
        },
        LeasePolicy::from_startup_config(30_000).expect("valid promotion lease policy"),
    );

    assert!(matches!(
        execution_authority.claim_execute_and_record(BrokerPromotionExecutionRequest {
            promotion_decision_event_id: EventId::new(),
        }),
        Err(PromotionExecutionError::Replay(_))
    ));
    assert_eq!(backend_state.borrow().claim_calls, 0);
    assert_eq!(backend_state.borrow().result_calls, 0);
    assert_eq!(gateway_state.borrow().calls, 0);
}

#[test]
fn protected_promotion_decision_response_loss_retry_records_at_most_one_decision() {
    let fixture = promotion_fixture();
    checkpoint_pending_promotion_approval_for_trusted_replay(&fixture);
    let replay_authorities = promotion_replay_authorities(&fixture);
    let mut authority = protected_promotion_decision_authority(&fixture, &replay_authorities);
    let other_run_fixture = promotion_fixture();
    let cross_run_wire = promotion_decision_wire(
        "123e4567-e89b-12d3-a456-426614174000",
        &other_run_fixture
            .request
            .promotion_approval_request_event_id
            .to_string(),
        "reject",
    );

    assert_eq!(
        handle_promotion_decision_wire(&mut authority, cross_run_wire.as_bytes())
            .expect("a canonical but cross-run identity reaches the protected authority"),
        BrokerPromotionDecisionDisposition::ReconciliationRequired
    );
    assert_eq!(
        promotion_event_count(
            &fixture.store,
            fixture.request.run_id,
            "promotion_decision_recorded",
        ),
        0,
        "a cross-run approval request must not create any decision"
    );

    let pending_wire = promotion_decision_wire(
        "123e4567-e89b-12d3-a456-426614174000",
        &fixture
            .request
            .promotion_approval_request_event_id
            .to_string(),
        "reject",
    );
    assert_eq!(
        handle_promotion_decision_wire(&mut authority, pending_wire.as_bytes())
            .expect("the exact pending approval must be resolved once"),
        BrokerPromotionDecisionDisposition::Sealed
    );
    // Model a response that was lost after the sealed effect. The client
    // retries the identical request; replay must not authorize another
    // decision record.
    assert_eq!(
        handle_promotion_decision_wire(&mut authority, pending_wire.as_bytes())
            .expect("a now-nonpending approval remains an opaque request"),
        BrokerPromotionDecisionDisposition::ReconciliationRequired
    );
    assert_eq!(
        promotion_event_count(
            &fixture.store,
            fixture.request.run_id,
            "promotion_decision_recorded",
        ),
        1,
        "a nonpending approval request must not create a second decision"
    );
}

#[test]
fn protected_promotion_decision_handler_reconciles_when_recovery_path_is_a_distinct_copy_of_store()
{
    let fixture = promotion_fixture();
    checkpoint_pending_promotion_approval_for_trusted_replay(&fixture);
    let copied_recovery_database_path = fixture._temp.path().join("copied-events.db");
    let source_database_path = fixture._temp.path().join("events.db");
    let checkpoint =
        rusqlite::Connection::open(&source_database_path).expect("open source ledger for copy");
    checkpoint
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .expect("flush the verified source ledger before copying it");
    fs::copy(&source_database_path, &copied_recovery_database_path)
        .expect("copy the otherwise-valid trusted recovery ledger");

    let replay_authorities = promotion_replay_authorities(&fixture);
    let mut authority = ProtectedPromotionDecisionAuthority::from_prevalidated_startup(
        fixture.request.run_id,
        &copied_recovery_database_path,
        &replay_authorities,
        &fixture.kernel,
        &fixture.store,
        &fixture.authority,
        &fixture.operator_key,
        &fixture.operator,
        &fixture.kernel_key,
        &fixture.kernel,
    )
    .expect("startup dependencies remain otherwise valid");
    let wire = promotion_decision_wire(
        "123e4567-e89b-12d3-a456-426614174000",
        &fixture
            .request
            .promotion_approval_request_event_id
            .to_string(),
        "promote",
    );

    assert_eq!(
        handle_promotion_decision_wire(&mut authority, wire.as_bytes())
            .expect("the opaque request reaches the protected authority"),
        BrokerPromotionDecisionDisposition::ReconciliationRequired
    );
    assert_eq!(
        promotion_event_count(
            &fixture.store,
            fixture.request.run_id,
            "promotion_decision_recorded",
        ),
        0,
        "a copied recovery ledger must never authorize a write to the protected store"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn protected_promotion_decision_authenticated_frame_reader_rejects_same_uid_before_consuming_frame()
{
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    let broker_uid = unsafe { libc::geteuid() };
    let configured_worker_uid = broker_uid.checked_add(1).unwrap_or(broker_uid - 1);
    let policy = BrokerHostConfinementPolicyV1::new(broker_uid, [configured_worker_uid])
        .expect("a distinct configured worker identity is valid");
    let attestation = policy
        .attest_current_broker_process()
        .expect("the test process is the configured broker identity");
    let (mut broker_stream, mut same_uid_worker_stream) =
        UnixStream::pair().expect("create a local Unix socket pair");
    let payload = promotion_decision_wire(
        "123e4567-e89b-12d3-a456-426614174000",
        &EventId::new().to_string(),
        "reject",
    )
    .into_bytes();
    let mut frame = u32::try_from(payload.len())
        .expect("the canonical promotion-decision fixture fits the bounded frame")
        .to_be_bytes()
        .to_vec();
    frame.extend_from_slice(&payload);
    same_uid_worker_stream
        .write_all(&frame)
        .expect("queue a valid-looking promotion-decision frame");

    assert!(matches!(
        super::promotion_decision_handler::read_authenticated_promotion_decision_frame(
            &policy,
            &attestation,
            &mut broker_stream,
        ),
        Err(PromotionDecisionHandlerError::PeerRejected)
    ));

    broker_stream
        .set_read_timeout(Some(Duration::from_millis(250)))
        .expect("bound an assertion failure if the gate consumed the frame");
    let mut observed = vec![0; frame.len()];
    broker_stream
        .read_exact(&mut observed)
        .expect("peer authentication must fail before any frame byte is read");
    assert_eq!(observed, frame);
}

#[cfg(target_os = "linux")]
#[test]
fn protected_promotion_decision_frame_reader_rejects_zero_oversized_and_truncated_frames() {
    use std::io::Write;
    use std::os::unix::net::UnixStream;

    let cases = [
        ("zero length", 0_u32.to_be_bytes().to_vec()),
        (
            "oversized",
            u32::try_from(16 * 1024 + 1)
                .expect("the bounded-frame test length fits u32")
                .to_be_bytes()
                .to_vec(),
        ),
        ("truncated payload", {
            let mut frame = 4_u32.to_be_bytes().to_vec();
            frame.extend_from_slice(&[1_u8, 2_u8]);
            frame
        }),
    ];

    for (label, frame) in cases {
        let (mut broker_stream, mut worker_stream) =
            UnixStream::pair().expect("create a local Unix socket pair");
        worker_stream
            .write_all(&frame)
            .expect("queue the malformed promotion-decision frame");
        drop(worker_stream);

        assert!(
            matches!(
                super::promotion_decision_handler::read_bounded_promotion_decision_frame(
                    &mut broker_stream
                ),
                Err(PromotionDecisionHandlerError::FrameRejected)
            ),
            "{label} frame must fail closed without allocating or parsing a request"
        );
    }
}

#[cfg(target_os = "linux")]
#[test]
fn protected_promotion_decision_timeout_reader_rejects_held_open_partial_header_within_deadline() {
    use std::io::Write;
    use std::os::unix::net::UnixStream;
    use std::time::{Duration, Instant};

    let (mut broker_stream, mut worker_stream) =
        UnixStream::pair().expect("create a local Unix socket pair");
    worker_stream
        .write_all(&[0_u8, 0_u8])
        .expect("send only part of the frame header while retaining the peer");

    let started = Instant::now();
    assert!(matches!(
        super::promotion_decision_handler::read_bounded_promotion_decision_frame_with_timeout_for_tests(
            &mut broker_stream,
            Duration::from_millis(25),
        ),
        Err(PromotionDecisionHandlerError::FrameRejected)
    ));
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "a held-open partial frame must be rejected by the bounded timeout rather than pinning the broker"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn protected_promotion_decision_timeout_reader_rejects_held_open_partial_body_within_deadline() {
    use std::io::Write;
    use std::os::unix::net::UnixStream;
    use std::time::{Duration, Instant};

    let (mut broker_stream, mut worker_stream) =
        UnixStream::pair().expect("create a local Unix socket pair");
    worker_stream
        .write_all(&[0_u8, 0_u8, 0_u8, 4_u8, 1_u8])
        .expect("send a complete header and partial body while retaining the peer");

    let started = Instant::now();
    assert!(matches!(
        super::promotion_decision_handler::read_bounded_promotion_decision_frame_with_timeout_for_tests(
            &mut broker_stream,
            Duration::from_millis(25),
        ),
        Err(PromotionDecisionHandlerError::FrameRejected)
    ));
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "a held-open partial frame must be rejected by the bounded timeout rather than pinning the broker"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn protected_promotion_decision_timeout_reader_rejects_a_slow_drip_header_past_its_absolute_deadline(
) {
    use std::io::Write;
    use std::os::unix::net::UnixStream;
    use std::thread;
    use std::time::{Duration, Instant};

    const READ_TIMEOUT: Duration = Duration::from_millis(100);
    const DRIP_INTERVAL: Duration = Duration::from_millis(40);

    let (mut broker_stream, mut worker_stream) =
        UnixStream::pair().expect("create a local Unix socket pair");
    worker_stream
        .write_all(&[0_u8])
        .expect("send the first header byte before beginning a slow drip");
    let drip = thread::spawn(move || {
        for chunk in [&[0_u8][..], &[0_u8][..], &[1_u8, b'x'][..]] {
            thread::sleep(DRIP_INTERVAL);
            worker_stream
                .write_all(chunk)
                .expect("keep each slow-drip gap below the per-read timeout");
        }
    });

    let started = Instant::now();
    let result =
        super::promotion_decision_handler::read_bounded_promotion_decision_frame_with_timeout_for_tests(
            &mut broker_stream,
            READ_TIMEOUT,
        );
    let elapsed = started.elapsed();
    drip.join().expect("complete the slow-drip writer");
    assert!(matches!(
        result,
        Err(PromotionDecisionHandlerError::FrameRejected)
    ));
    assert!(
        elapsed < Duration::from_secs(1),
        "slow-dripped header bytes must not extend the absolute frame deadline"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn protected_promotion_decision_timeout_reader_rejects_a_slow_drip_body_past_its_absolute_deadline()
{
    use std::io::Write;
    use std::os::unix::net::UnixStream;
    use std::thread;
    use std::time::{Duration, Instant};

    const READ_TIMEOUT: Duration = Duration::from_millis(100);
    const DRIP_INTERVAL: Duration = Duration::from_millis(40);

    let (mut broker_stream, mut worker_stream) =
        UnixStream::pair().expect("create a local Unix socket pair");
    worker_stream
        .write_all(&[0_u8, 0_u8, 0_u8, 4_u8, b'a'])
        .expect("send a complete header and the first body byte");
    let drip = thread::spawn(move || {
        for byte in [b'b', b'c', b'd'] {
            thread::sleep(DRIP_INTERVAL);
            worker_stream
                .write_all(&[byte])
                .expect("keep each slow-drip gap below the per-read timeout");
        }
    });

    let started = Instant::now();
    let result =
        super::promotion_decision_handler::read_bounded_promotion_decision_frame_with_timeout_for_tests(
            &mut broker_stream,
            READ_TIMEOUT,
        );
    let elapsed = started.elapsed();
    drip.join().expect("complete the slow-drip writer");
    assert!(matches!(
        result,
        Err(PromotionDecisionHandlerError::FrameRejected)
    ));
    assert!(
        elapsed < Duration::from_secs(1),
        "slow-dripped body bytes must not extend the absolute frame deadline"
    );
}

fn promotion_execution_wire(request_id: &str, promotion_decision_event_id: &str) -> String {
    format!(
        r#"{{"request_id":"{request_id}","promotion_decision_event_id":"{promotion_decision_event_id}"}}"#
    )
}

fn promotion_execution_wire_with_injected_field(
    request_id: &str,
    promotion_decision_event_id: &str,
    injected_field: &str,
) -> String {
    let mut wire = promotion_execution_wire(request_id, promotion_decision_event_id);
    wire.pop()
        .expect("the canonical promotion execution wire ends in an object delimiter");
    format!(r#"{wire},"{injected_field}":"caller-controlled"}}"#)
}

#[test]
fn protected_promotion_execution_wire_accepts_only_closed_canonical_decision_identity() {
    let decision_event_id = EventId::new();
    let wire = promotion_execution_wire(
        "123e4567-e89b-12d3-a456-426614174000",
        &decision_event_id.to_string(),
    );

    assert_eq!(
        parse_promotion_execution_request(wire.as_bytes())
            .expect("the closed canonical promotion identity must parse"),
        BrokerPromotionExecutionRequest {
            promotion_decision_event_id: decision_event_id,
        }
    );

    for (label, malformed_wire) in [
        (
            "missing request ID",
            format!(r#"{{"promotion_decision_event_id":"{decision_event_id}"}}"#),
        ),
        (
            "missing decision ID",
            r#"{"request_id":"123e4567-e89b-12d3-a456-426614174000"}"#.into(),
        ),
        (
            "noncanonical request ID",
            promotion_execution_wire(
                "123E4567-e89b-12d3-a456-426614174000",
                &decision_event_id.to_string(),
            ),
        ),
        (
            "noncanonical decision ID",
            promotion_execution_wire(
                "123e4567-e89b-12d3-a456-426614174000",
                "123E4567-e89b-12d3-a456-426614174000",
            ),
        ),
    ] {
        assert!(
            matches!(
                parse_promotion_execution_request(malformed_wire.as_bytes()),
                Err(PromotionExecutionHandlerError::RequestRejected)
            ),
            "{label} must fail closed before broker entry"
        );
    }
}

#[test]
fn protected_promotion_execution_wire_rejects_caller_supplied_authority_and_effect_fields() {
    let run_id = RunId::new();
    let request = promotion_execution_request();
    let backend_state = Rc::new(RefCell::new(FakePromotionBackendState::default()));
    let gateway_state = Rc::new(RefCell::new(FakePromotionGatewayState::default()));
    let mut authority = BrokerPromotionExecutionAuthority::new(
        run_id,
        FakePromotionVerifier { binding: None },
        FakePromotionBackend {
            state: Rc::clone(&backend_state),
            grants: VecDeque::new(),
            results: VecDeque::new(),
        },
        FakePromotionGateway {
            state: Rc::clone(&gateway_state),
            outcome: None,
        },
        LeasePolicy::from_startup_config(30_000).expect("valid promotion lease policy"),
    );

    for injected_field in [
        "run_id",
        "authority",
        "candidate_digest",
        "candidate_ref",
        "repository_root",
        "git",
        "command",
        "target_ref",
        "lease_duration_ms",
        "signing_key",
        "idempotency_key",
    ] {
        let wire = promotion_execution_wire_with_injected_field(
            "123e4567-e89b-12d3-a456-426614174000",
            &request.promotion_decision_event_id.to_string(),
            injected_field,
        );
        assert!(
            matches!(
                handle_promotion_execution_wire_for_tests(&mut authority, wire.as_bytes()),
                Err(PromotionExecutionHandlerError::RequestRejected)
            ),
            "{injected_field} must be rejected before broker entry"
        );
        assert_eq!(backend_state.borrow().claim_calls, 0);
        assert_eq!(backend_state.borrow().result_calls, 0);
        assert_eq!(gateway_state.borrow().calls, 0);
    }
}

#[test]
fn protected_promotion_execution_wire_converts_replay_failure_to_reconciliation_without_git() {
    let run_id = RunId::new();
    let request = promotion_execution_request();
    let backend_state = Rc::new(RefCell::new(FakePromotionBackendState::default()));
    let gateway_state = Rc::new(RefCell::new(FakePromotionGatewayState::default()));
    let mut authority = BrokerPromotionExecutionAuthority::new(
        run_id,
        FailingPromotionVerifier {
            error: Some(PromotionExecutionError::Replay(bounded_recovery_error())),
        },
        FakePromotionBackend {
            state: Rc::clone(&backend_state),
            grants: VecDeque::new(),
            results: VecDeque::new(),
        },
        FakePromotionGateway {
            state: Rc::clone(&gateway_state),
            outcome: None,
        },
        LeasePolicy::from_startup_config(30_000).expect("valid promotion lease policy"),
    );
    let wire = promotion_execution_wire(
        "123e4567-e89b-12d3-a456-426614174000",
        &request.promotion_decision_event_id.to_string(),
    );

    assert_eq!(
        handle_promotion_execution_wire_for_tests(&mut authority, wire.as_bytes())
            .expect("a valid opaque wire must reach the broker"),
        BrokerPromotionExecutionStatus::ReconciliationRequired
    );
    assert_eq!(backend_state.borrow().claim_calls, 0);
    assert_eq!(backend_state.borrow().result_calls, 0);
    assert_eq!(gateway_state.borrow().calls, 0);
}

#[test]
fn protected_promotion_execution_wire_for_reject_decision_never_claims_or_enters_git() {
    let run_id = RunId::new();
    let request = promotion_execution_request();
    let dispatch_event_id = EventId::new();
    let reject_binding = TrustedPromotionBinding::for_tests(
        run_id,
        request.promotion_decision_event_id,
        DIGEST_A.into(),
        dispatch_event_id,
        DIGEST_B.into(),
        PromotionDecisionKindV1::Reject,
        ExecutionRoleV1::Implementer,
        CommitModeV1::Atomic,
        PROMOTION_CANDIDATE_DIGEST.into(),
        PROMOTION_CANDIDATE_REF.into(),
        PROMOTION_CANDIDATE_COMMIT.into(),
        PROMOTION_TREE_DIGEST.into(),
        PROMOTION_BASE_COMMIT.into(),
        PROMOTION_TARGET_REF.into(),
        "promotion:workflow-1:attempt-1".into(),
        false,
    );
    let backend_state = Rc::new(RefCell::new(FakePromotionBackendState::default()));
    let gateway_state = Rc::new(RefCell::new(FakePromotionGatewayState::default()));
    let mut authority = BrokerPromotionExecutionAuthority::new(
        run_id,
        FakePromotionVerifier {
            binding: Some(reject_binding),
        },
        FakePromotionBackend {
            state: Rc::clone(&backend_state),
            grants: VecDeque::new(),
            results: VecDeque::new(),
        },
        FakePromotionGateway {
            state: Rc::clone(&gateway_state),
            outcome: None,
        },
        LeasePolicy::from_startup_config(30_000).expect("valid promotion lease policy"),
    );
    let wire = promotion_execution_wire(
        "123e4567-e89b-12d3-a456-426614174000",
        &request.promotion_decision_event_id.to_string(),
    );

    assert_eq!(
        handle_promotion_execution_wire_for_tests(&mut authority, wire.as_bytes())
            .expect("a valid opaque reject decision wire must reach the broker"),
        BrokerPromotionExecutionStatus::Rejected
    );
    assert_eq!(backend_state.borrow().claim_calls, 0);
    assert_eq!(backend_state.borrow().result_calls, 0);
    assert_eq!(gateway_state.borrow().calls, 0);
}

#[test]
fn protected_promotion_execution_wire_can_record_exactly_one_existing_authority_effect() {
    let run_id = RunId::new();
    let request = promotion_execution_request();
    let dispatch_event_id = EventId::new();
    let binding = promotion_execution_binding(run_id, &request, dispatch_event_id, false);
    let backend_state = Rc::new(RefCell::new(FakePromotionBackendState::default()));
    let gateway_state = Rc::new(RefCell::new(FakePromotionGatewayState::default()));
    let claim = promotion_execution_claim(run_id, &request, dispatch_event_id);
    let mut authority = BrokerPromotionExecutionAuthority::new(
        run_id,
        FakePromotionVerifier {
            binding: Some(binding),
        },
        FakePromotionBackend {
            state: Rc::clone(&backend_state),
            grants: [Ok(PromotionExecutionGrant::Granted {
                run_id,
                claim_event_id: EventId::new(),
                claim_event_digest: DIGEST_D.into(),
                claim,
            })]
            .into_iter()
            .collect(),
            results: [Ok(PromotionResultDisposition::Recorded { run_id })]
                .into_iter()
                .collect(),
        },
        FakePromotionGateway {
            state: Rc::clone(&gateway_state),
            outcome: Some(Ok(promotion_execution_outcome())),
        },
        LeasePolicy::from_startup_config(30_000).expect("valid promotion lease policy"),
    );
    let wire = promotion_execution_wire(
        "123e4567-e89b-12d3-a456-426614174000",
        &request.promotion_decision_event_id.to_string(),
    );

    assert_eq!(
        handle_promotion_execution_wire_for_tests(&mut authority, wire.as_bytes())
            .expect("the exact closed decision identity must reach the authority"),
        BrokerPromotionExecutionStatus::Recorded
    );
    assert_eq!(backend_state.borrow().claim_calls, 1);
    assert_eq!(backend_state.borrow().result_calls, 1);
    assert_eq!(gateway_state.borrow().calls, 1);
}

#[cfg(target_os = "linux")]
#[test]
fn protected_promotion_execution_authenticated_frame_reader_rejects_same_uid_before_consuming_frame(
) {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    let broker_uid = unsafe { libc::geteuid() };
    let configured_worker_uid = broker_uid.checked_add(1).unwrap_or(broker_uid - 1);
    let policy = BrokerHostConfinementPolicyV1::new(broker_uid, [configured_worker_uid])
        .expect("a distinct configured worker identity is valid");
    let attestation = policy
        .attest_current_broker_process()
        .expect("the test process is the configured broker identity");
    let (mut broker_stream, mut same_uid_worker_stream) =
        UnixStream::pair().expect("create a local Unix socket pair");
    let payload = promotion_execution_wire(
        "123e4567-e89b-12d3-a456-426614174000",
        &EventId::new().to_string(),
    )
    .into_bytes();
    let mut frame = u32::try_from(payload.len())
        .expect("the canonical promotion fixture fits the bounded frame")
        .to_be_bytes()
        .to_vec();
    frame.extend_from_slice(&payload);
    same_uid_worker_stream
        .write_all(&frame)
        .expect("queue a valid-looking promotion frame");

    assert!(matches!(
        super::promotion_execution_handler::read_authenticated_promotion_execution_frame(
            &policy,
            &attestation,
            &mut broker_stream,
        ),
        Err(PromotionExecutionHandlerError::PeerRejected)
    ));

    broker_stream
        .set_read_timeout(Some(Duration::from_millis(250)))
        .expect("bound an assertion failure if the gate consumed the frame");
    let mut observed = vec![0; frame.len()];
    broker_stream
        .read_exact(&mut observed)
        .expect("peer authentication must fail before any frame byte is read");
    assert_eq!(observed, frame);
}

#[cfg(target_os = "linux")]
#[test]
fn protected_promotion_execution_frame_reader_rejects_zero_oversized_and_truncated_frames() {
    use std::io::Write;
    use std::os::unix::net::UnixStream;

    let cases = [
        ("zero length", 0_u32.to_be_bytes().to_vec()),
        (
            "oversized",
            u32::try_from(16 * 1024 + 1)
                .expect("the bounded-frame test length fits u32")
                .to_be_bytes()
                .to_vec(),
        ),
        ("truncated payload", {
            let mut frame = 4_u32.to_be_bytes().to_vec();
            frame.extend_from_slice(&[1_u8, 2_u8]);
            frame
        }),
    ];

    for (label, frame) in cases {
        let (mut broker_stream, mut worker_stream) =
            UnixStream::pair().expect("create a local Unix socket pair");
        worker_stream
            .write_all(&frame)
            .expect("queue the malformed promotion frame");
        drop(worker_stream);

        assert!(
            matches!(
                super::promotion_execution_handler::read_bounded_promotion_execution_frame(
                    &mut broker_stream
                ),
                Err(PromotionExecutionHandlerError::FrameRejected)
            ),
            "{label} frame must fail closed without allocating or parsing a request"
        );
    }
}

#[cfg(target_os = "linux")]
#[test]
fn protected_promotion_execution_timeout_reader_rejects_held_open_partial_header_within_deadline() {
    use std::io::Write;
    use std::os::unix::net::UnixStream;
    use std::time::{Duration, Instant};

    let (mut broker_stream, mut worker_stream) =
        UnixStream::pair().expect("create a local Unix socket pair");
    worker_stream
        .write_all(&[0_u8, 0_u8])
        .expect("send only part of the frame header while retaining the peer");

    let started = Instant::now();
    assert!(matches!(
        super::promotion_execution_handler::read_bounded_promotion_execution_frame_with_timeout_for_tests(
            &mut broker_stream,
            Duration::from_millis(25),
        ),
        Err(PromotionExecutionHandlerError::FrameRejected)
    ));
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "a held-open partial frame must be rejected by the bounded timeout rather than pinning the broker"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn protected_promotion_execution_timeout_reader_rejects_held_open_partial_body_within_deadline() {
    use std::io::Write;
    use std::os::unix::net::UnixStream;
    use std::time::{Duration, Instant};

    let (mut broker_stream, mut worker_stream) =
        UnixStream::pair().expect("create a local Unix socket pair");
    worker_stream
        .write_all(&[0_u8, 0_u8, 0_u8, 4_u8, 1_u8])
        .expect("send a complete header and partial body while retaining the peer");

    let started = Instant::now();
    assert!(matches!(
        super::promotion_execution_handler::read_bounded_promotion_execution_frame_with_timeout_for_tests(
            &mut broker_stream,
            Duration::from_millis(25),
        ),
        Err(PromotionExecutionHandlerError::FrameRejected)
    ));
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "a held-open partial frame must be rejected by the bounded timeout rather than pinning the broker"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn protected_promotion_execution_timeout_reader_rejects_a_slow_drip_header_past_its_absolute_deadline(
) {
    use std::io::Write;
    use std::os::unix::net::UnixStream;
    use std::thread;
    use std::time::{Duration, Instant};

    const READ_TIMEOUT: Duration = Duration::from_millis(100);
    const DRIP_INTERVAL: Duration = Duration::from_millis(40);

    let (mut broker_stream, mut worker_stream) =
        UnixStream::pair().expect("create a local Unix socket pair");
    worker_stream
        .write_all(&[0_u8])
        .expect("send the first header byte before beginning a slow drip");
    let drip = thread::spawn(move || {
        for chunk in [&[0_u8][..], &[0_u8][..], &[1_u8, b'x'][..]] {
            thread::sleep(DRIP_INTERVAL);
            worker_stream
                .write_all(chunk)
                .expect("keep each slow-drip gap below the per-read timeout");
        }
    });

    let started = Instant::now();
    let result =
        super::promotion_execution_handler::read_bounded_promotion_execution_frame_with_timeout_for_tests(
            &mut broker_stream,
            READ_TIMEOUT,
        );
    let elapsed = started.elapsed();
    drip.join().expect("complete the slow-drip writer");
    assert!(matches!(
        result,
        Err(PromotionExecutionHandlerError::FrameRejected)
    ));
    assert!(
        elapsed < Duration::from_secs(1),
        "slow-dripped header bytes must not extend the absolute frame deadline"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn protected_promotion_execution_timeout_reader_rejects_a_slow_drip_body_past_its_absolute_deadline(
) {
    use std::io::Write;
    use std::os::unix::net::UnixStream;
    use std::thread;
    use std::time::{Duration, Instant};

    const READ_TIMEOUT: Duration = Duration::from_millis(100);
    const DRIP_INTERVAL: Duration = Duration::from_millis(40);

    let (mut broker_stream, mut worker_stream) =
        UnixStream::pair().expect("create a local Unix socket pair");
    worker_stream
        .write_all(&[0_u8, 0_u8, 0_u8, 4_u8, b'a'])
        .expect("send a complete header and the first body byte");
    let drip = thread::spawn(move || {
        for byte in [b'b', b'c', b'd'] {
            thread::sleep(DRIP_INTERVAL);
            worker_stream
                .write_all(&[byte])
                .expect("keep each slow-drip gap below the per-read timeout");
        }
    });

    let started = Instant::now();
    let result =
        super::promotion_execution_handler::read_bounded_promotion_execution_frame_with_timeout_for_tests(
            &mut broker_stream,
            READ_TIMEOUT,
        );
    let elapsed = started.elapsed();
    drip.join().expect("complete the slow-drip writer");
    assert!(matches!(
        result,
        Err(PromotionExecutionHandlerError::FrameRejected)
    ));
    assert!(
        elapsed < Duration::from_secs(1),
        "slow-dripped body bytes must not extend the absolute frame deadline"
    );
}

fn promotion_receipt_message() -> String {
    format!(
        "buildplane governed promotion receipt v1\n\
candidate_digest: {PROMOTION_CANDIDATE_DIGEST}\n\
candidate_ref: {PROMOTION_CANDIDATE_REF}\n\
candidate_commit: {PROMOTION_CANDIDATE_COMMIT}\n\
candidate_tree: {PROMOTION_CANDIDATE_TREE}\n\
candidate_tree_digest: {PROMOTION_TREE_DIGEST}\n\
base_commit: {PROMOTION_BASE_COMMIT}\n\
target_ref: {PROMOTION_TARGET_REF}\n\
idempotency_key: promotion:workflow-1:attempt-1"
    )
}

fn candidate_commit_object(tree: &str) -> String {
    format!(
        "tree {tree}\n\
parent {PROMOTION_BASE_COMMIT}\n\
author test <test@example.invalid> 0 +0000\n\
committer test <test@example.invalid> 0 +0000\n\
\n\
candidate\n"
    )
}

fn merge_commit_object(tree: &str) -> String {
    format!(
        "tree {tree}\n\
parent {PROMOTION_BASE_COMMIT}\n\
parent {PROMOTION_CANDIDATE_COMMIT}\n\
author test <test@example.invalid> 0 +0000\n\
committer test <test@example.invalid> 0 +0000\n\
\n\
{}\n",
        promotion_receipt_message()
    )
}

#[derive(Default)]
struct PromotionGitRunnerState {
    operations: Vec<TestGitOperation>,
    receipt_present: bool,
    target_head: String,
    target_contains_merge: bool,
    candidate_tree: String,
    merge_tree: String,
    tree_listing: Vec<u8>,
    create_merge_calls: usize,
    atomic_update_calls: usize,
}

struct PromotionGitRunner {
    state: Rc<RefCell<PromotionGitRunnerState>>,
}

impl PromotionGitRunner {
    fn new(receipt_present: bool) -> (Self, Rc<RefCell<PromotionGitRunnerState>>) {
        let state = Rc::new(RefCell::new(PromotionGitRunnerState {
            receipt_present,
            target_head: if receipt_present {
                PROMOTION_MERGE_COMMIT.into()
            } else {
                PROMOTION_BASE_COMMIT.into()
            },
            candidate_tree: PROMOTION_CANDIDATE_TREE.into(),
            merge_tree: PROMOTION_CANDIDATE_TREE.into(),
            tree_listing: Vec::new(),
            ..PromotionGitRunnerState::default()
        }));
        (
            Self {
                state: state.clone(),
            },
            state,
        )
    }

    fn success(stdout: impl Into<Vec<u8>>) -> TestGitOutput {
        TestGitOutput::success(stdout.into())
    }
}

impl TestFixedGitRunner for PromotionGitRunner {
    fn invoke(&mut self, operation: TestGitOperation) -> TestGitOutput {
        let mut state = self.state.borrow_mut();
        state.operations.push(operation.clone());
        match operation {
            TestGitOperation::ResolveCandidateRef { .. } => {
                Self::success(format!("{PROMOTION_CANDIDATE_COMMIT}\n"))
            }
            TestGitOperation::ReadCommit { commit } if commit == PROMOTION_CANDIDATE_COMMIT => {
                Self::success(candidate_commit_object(&state.candidate_tree))
            }
            TestGitOperation::ReadCommit { commit } if commit == PROMOTION_MERGE_COMMIT => {
                Self::success(merge_commit_object(&state.merge_tree))
            }
            TestGitOperation::ReadTreeListing { .. } => Self::success(state.tree_listing.clone()),
            TestGitOperation::InspectReceipt { .. } => {
                if state.receipt_present {
                    Self::success(format!("{PROMOTION_MERGE_COMMIT}\n"))
                } else {
                    TestGitOutput::failure(1)
                }
            }
            TestGitOperation::ResolveTarget { .. } => {
                Self::success(format!("{}\n", state.target_head))
            }
            TestGitOperation::CreateMergeCommit { .. } => {
                state.create_merge_calls += 1;
                Self::success(format!("{PROMOTION_MERGE_COMMIT}\n"))
            }
            TestGitOperation::AtomicAdvance { .. } => {
                state.atomic_update_calls += 1;
                state.receipt_present = true;
                state.target_head = PROMOTION_MERGE_COMMIT.into();
                Self::success(Vec::new())
            }
            TestGitOperation::IsAncestor { .. } if state.target_contains_merge => {
                Self::success(Vec::new())
            }
            TestGitOperation::IsAncestor { .. } => TestGitOutput::failure(1),
            other => panic!("unexpected fixed Git operation: {other:?}"),
        }
    }
}

fn test_promotion_gateway(runner: PromotionGitRunner) -> PromotionGitGateway {
    PromotionGitGateway::with_test_runner("/broker-test-root", Box::new(runner))
        .expect("test root is canonical by construction")
}

#[derive(Clone)]
struct ReconciliationFixtureGitFacts {
    candidate_digest: String,
    candidate_ref: String,
    candidate_commit: String,
    candidate_tree_digest: String,
    candidate_tree: String,
    base_commit: String,
    target_ref: String,
    target_head: String,
    merge_commit: String,
    receipt_ref: String,
    idempotency_key: String,
}

#[derive(Default)]
struct ReconciliationFixtureGitRunnerState {
    operations: Vec<TestGitOperation>,
    create_merge_calls: usize,
    atomic_update_calls: usize,
}

struct ReconciliationFixtureGitRunner {
    facts: ReconciliationFixtureGitFacts,
    receipt_present: bool,
    state: Rc<RefCell<ReconciliationFixtureGitRunnerState>>,
}

fn reconciliation_fixture_candidate(fixture: &PromotionFixture) -> CandidateCreatedV2 {
    let event = fixture
        .store
        .events_for_run(&fixture.request.run_id.to_string())
        .expect("read fixture candidate")
        .into_iter()
        .find(|event| event.id == fixture.request.candidate_created_event_id.to_string())
        .expect("fixture contains the immutable candidate")
        .to_event()
        .expect("decode fixture candidate event");
    let Payload::CandidateCreatedV2(candidate) = event.payload else {
        panic!("fixture candidate event must carry CandidateCreatedV2");
    };
    candidate
}

fn reconciliation_fixture_gateway(
    fixture: &PromotionFixture,
    promotion_result_event_id: EventId,
    receipt_present: bool,
) -> (
    PromotionGitGateway,
    Rc<RefCell<ReconciliationFixtureGitRunnerState>>,
) {
    let candidate = reconciliation_fixture_candidate(fixture);
    let event = fixture
        .store
        .events_for_run(&fixture.request.run_id.to_string())
        .expect("read fixture result")
        .into_iter()
        .find(|event| event.id == promotion_result_event_id.to_string())
        .expect("fixture contains the recorded reconciliation result")
        .to_event()
        .expect("decode fixture promotion result");
    let Payload::PromotionResultRecordedV1(result) = event.payload else {
        panic!("fixture result event must carry PromotionResultRecordedV1");
    };
    let binding = result
        .promotion_git_binding
        .expect("fixture result carries exact Git reconciliation evidence");
    let facts = ReconciliationFixtureGitFacts {
        candidate_digest: candidate.candidate_digest,
        candidate_ref: candidate.candidate_ref,
        candidate_commit: candidate.candidate_commit_sha,
        candidate_tree_digest: candidate.tree_digest,
        candidate_tree: binding
            .merged_tree_sha
            .expect("fixture result binds an observed merge tree"),
        base_commit: candidate.base_commit_sha,
        target_ref: binding.target_ref,
        target_head: binding
            .target_head_after_sha
            .expect("fixture result records the post-CAS target head"),
        merge_commit: result
            .merged_head_sha
            .expect("fixture result records the immutable merge"),
        receipt_ref: binding
            .promotion_receipt_ref
            .expect("fixture result records the immutable receipt ref"),
        idempotency_key: result.idempotency_key,
    };
    let state = Rc::new(RefCell::new(ReconciliationFixtureGitRunnerState::default()));
    let gateway = PromotionGitGateway::with_test_runner(
        "/broker-test-root",
        Box::new(ReconciliationFixtureGitRunner {
            facts,
            receipt_present,
            state: state.clone(),
        }),
    )
    .expect("test root is canonical by construction");
    (gateway, state)
}

fn reconciliation_fixture_receipt_message(facts: &ReconciliationFixtureGitFacts) -> String {
    format!(
        "buildplane governed promotion receipt v1\ncandidate_digest: {}\ncandidate_ref: {}\ncandidate_commit: {}\ncandidate_tree: {}\ncandidate_tree_digest: {}\nbase_commit: {}\ntarget_ref: {}\nidempotency_key: {}",
        facts.candidate_digest,
        facts.candidate_ref,
        facts.candidate_commit,
        facts.candidate_tree,
        facts.candidate_tree_digest,
        facts.base_commit,
        facts.target_ref,
        facts.idempotency_key,
    )
}

fn reconciliation_fixture_candidate_commit(facts: &ReconciliationFixtureGitFacts) -> String {
    format!(
        "tree {}\nparent {}\nauthor test <test@example.invalid> 0 +0000\ncommitter test <test@example.invalid> 0 +0000\n\ncandidate\n",
        facts.candidate_tree, facts.base_commit
    )
}

fn reconciliation_fixture_merge_commit(facts: &ReconciliationFixtureGitFacts) -> String {
    format!(
        "tree {}\nparent {}\nparent {}\nauthor test <test@example.invalid> 0 +0000\ncommitter test <test@example.invalid> 0 +0000\n\n{}\n",
        facts.candidate_tree,
        facts.base_commit,
        facts.candidate_commit,
        reconciliation_fixture_receipt_message(facts),
    )
}

impl TestFixedGitRunner for ReconciliationFixtureGitRunner {
    fn invoke(&mut self, operation: TestGitOperation) -> TestGitOutput {
        self.state.borrow_mut().operations.push(operation.clone());
        match operation {
            TestGitOperation::ResolveCandidateRef { candidate_ref }
                if candidate_ref == self.facts.candidate_ref =>
            {
                TestGitOutput::success(format!("{}\n", self.facts.candidate_commit).into())
            }
            TestGitOperation::ReadCommit { commit } if commit == self.facts.candidate_commit => {
                TestGitOutput::success(reconciliation_fixture_candidate_commit(&self.facts).into())
            }
            TestGitOperation::ReadCommit { commit } if commit == self.facts.merge_commit => {
                TestGitOutput::success(reconciliation_fixture_merge_commit(&self.facts).into())
            }
            TestGitOperation::ReadTreeListing { commit }
                if commit == self.facts.candidate_commit || commit == self.facts.merge_commit =>
            {
                TestGitOutput::success(Vec::new())
            }
            TestGitOperation::InspectReceipt { receipt_ref }
                if receipt_ref == self.facts.receipt_ref && self.receipt_present =>
            {
                TestGitOutput::success(format!("{}\n", self.facts.merge_commit).into())
            }
            TestGitOperation::InspectReceipt { receipt_ref }
                if receipt_ref == self.facts.receipt_ref =>
            {
                TestGitOutput::failure(1)
            }
            TestGitOperation::ResolveTarget { target_ref }
                if target_ref == self.facts.target_ref =>
            {
                TestGitOutput::success(format!("{}\n", self.facts.target_head).into())
            }
            TestGitOperation::CreateMergeCommit { .. } => {
                self.state.borrow_mut().create_merge_calls += 1;
                TestGitOutput::failure(2)
            }
            TestGitOperation::AtomicAdvance { .. } => {
                self.state.borrow_mut().atomic_update_calls += 1;
                TestGitOutput::failure(2)
            }
            TestGitOperation::IsAncestor { .. } => TestGitOutput::failure(1),
            _ => TestGitOutput::failure(2),
        }
    }
}

#[test]
fn promotion_capability_rejects_malformed_digest_and_crosses_no_git_boundary() {
    let malformed = VerifiedPromotionCapability::from_verified_facts(
        "sha256:not-a-digest".into(),
        PROMOTION_CANDIDATE_REF.into(),
        PROMOTION_CANDIDATE_COMMIT.into(),
        PROMOTION_TREE_DIGEST.into(),
        PROMOTION_BASE_COMMIT.into(),
        PROMOTION_TARGET_REF.into(),
        "promotion:workflow-1:attempt-1".into(),
    );

    assert!(matches!(
        malformed,
        Err(PromotionCapabilityError::MalformedCandidateDigest)
    ));
}

#[test]
fn promotion_gateway_creates_one_verified_merge_then_atomically_advances_target_and_receipt() {
    let (runner, state) = PromotionGitRunner::new(false);
    let mut gateway = test_promotion_gateway(runner);

    let outcome = gateway
        .promote(promotion_capability())
        .expect("the scripted Git facts are exact");

    assert!(matches!(
        outcome,
        PromotionGitOutcome::RootPendingReconciliation { .. }
    ));
    assert_eq!(
        outcome.ledger_outcome(),
        PromotionResultOutcomeV1::ReconciliationRequired
    );
    assert_eq!(
        outcome.binding().worktree_sync_state,
        Some(PromotionWorktreeSyncStateV1::RootCheckoutStale)
    );
    let state = state.borrow();
    let expected_receipt_message = promotion_receipt_message();
    assert_eq!(state.create_merge_calls, 1);
    assert_eq!(state.atomic_update_calls, 1);
    assert!(state.operations.iter().any(|operation| matches!(
        operation,
        TestGitOperation::CreateMergeCommit {
            tree,
            base,
            candidate,
            receipt_message,
        } if tree == PROMOTION_CANDIDATE_TREE
            && base == PROMOTION_BASE_COMMIT
            && candidate == PROMOTION_CANDIDATE_COMMIT
            && receipt_message == &expected_receipt_message
    )));
    assert!(state.operations.iter().any(|operation| matches!(
        operation,
        TestGitOperation::AtomicAdvance {
            target_ref,
            expected_base,
            receipt_ref,
            ..
        } if target_ref == PROMOTION_TARGET_REF
            && expected_base == PROMOTION_BASE_COMMIT
            && receipt_ref == PROMOTION_RECEIPT_REF
    )));
}

#[test]
fn promotion_gateway_reuses_an_existing_candidate_receipt_without_a_second_merge_or_cas() {
    let (runner, state) = PromotionGitRunner::new(true);
    let mut gateway = test_promotion_gateway(runner);

    let outcome = gateway
        .promote(promotion_capability())
        .expect("an exact immutable receipt is reusable");

    assert!(matches!(
        outcome,
        PromotionGitOutcome::RootPendingReconciliation { .. }
    ));
    assert_eq!(
        outcome.binding().worktree_sync_state,
        Some(PromotionWorktreeSyncStateV1::RootCheckoutStale)
    );
    let state = state.borrow();
    assert_eq!(state.create_merge_calls, 0);
    assert_eq!(state.atomic_update_calls, 0);
    assert!(state
        .operations
        .iter()
        .any(|operation| matches!(operation, TestGitOperation::InspectReceipt { .. })));
}

#[test]
fn promotion_gateway_read_only_receipt_observation_never_creates_or_advances() {
    let (runner, state) = PromotionGitRunner::new(true);
    let mut gateway = test_promotion_gateway(runner);

    let outcome = gateway
        .observe_existing_receipt(promotion_capability())
        .expect("an exact immutable receipt is observable during recovery");

    assert!(matches!(
        outcome,
        PromotionGitOutcome::RootPendingReconciliation { .. }
    ));
    let state = state.borrow();
    assert_eq!(state.create_merge_calls, 0);
    assert_eq!(state.atomic_update_calls, 0);
    assert!(state.operations.iter().all(|operation| !matches!(
        operation,
        TestGitOperation::CreateMergeCommit { .. } | TestGitOperation::AtomicAdvance { .. }
    )));
}

#[test]
fn promotion_gateway_read_only_receipt_observation_blocks_when_receipt_is_missing() {
    let (runner, state) = PromotionGitRunner::new(false);
    let mut gateway = test_promotion_gateway(runner);

    assert!(gateway
        .observe_existing_receipt(promotion_capability())
        .is_err());
    let state = state.borrow();
    assert_eq!(state.create_merge_calls, 0);
    assert_eq!(state.atomic_update_calls, 0);
    assert!(state.operations.iter().all(|operation| !matches!(
        operation,
        TestGitOperation::CreateMergeCommit { .. } | TestGitOperation::AtomicAdvance { .. }
    )));
}

#[test]
fn promotion_gateway_read_only_receipt_observation_reports_divergent_target_without_mutation() {
    let (runner, state) = PromotionGitRunner::new(true);
    state.borrow_mut().target_head = PROMOTION_TARGET_ADVANCED.into();
    let mut gateway = test_promotion_gateway(runner);

    let outcome = gateway
        .observe_existing_receipt(promotion_capability())
        .expect("an exact receipt may truthfully observe a target that advanced later");

    assert!(matches!(
        outcome,
        PromotionGitOutcome::TargetAdvanced { .. }
    ));
    assert_eq!(
        outcome.binding().worktree_sync_state,
        Some(PromotionWorktreeSyncStateV1::TargetAdvanced)
    );
    let state = state.borrow();
    assert_eq!(state.create_merge_calls, 0);
    assert_eq!(state.atomic_update_calls, 0);
    assert!(state.operations.iter().all(|operation| !matches!(
        operation,
        TestGitOperation::CreateMergeCommit { .. } | TestGitOperation::AtomicAdvance { .. }
    )));
}

#[test]
fn promotion_gateway_rejects_a_receipt_whose_actual_merge_tree_differs_from_the_verified_candidate()
{
    let (runner, state) = PromotionGitRunner::new(true);
    state.borrow_mut().merge_tree = "6666666666666666666666666666666666666666".into();
    let mut gateway = test_promotion_gateway(runner);

    assert!(gateway.promote(promotion_capability()).is_err());
    let state = state.borrow();
    assert_eq!(state.create_merge_calls, 0);
    assert_eq!(state.atomic_update_calls, 0);
}

#[test]
fn promotion_gateway_rejects_a_candidate_whose_semantic_tree_digest_is_not_verified() {
    let (runner, state) = PromotionGitRunner::new(false);
    state.borrow_mut().tree_listing = b"not-the-verified-tree-listing".to_vec();
    let mut gateway = test_promotion_gateway(runner);

    assert!(gateway.promote(promotion_capability()).is_err());
    let state = state.borrow();
    assert_eq!(state.create_merge_calls, 0);
    assert_eq!(state.atomic_update_calls, 0);
}

#[test]
fn promotion_gateway_derives_and_rejects_an_invalid_raw_tree_before_the_cas() {
    let (runner, state) = PromotionGitRunner::new(false);
    state.borrow_mut().candidate_tree = "not-a-git-object".into();
    let mut gateway = test_promotion_gateway(runner);

    assert!(gateway.promote(promotion_capability()).is_err());
    let state = state.borrow();
    assert_eq!(state.create_merge_calls, 0);
    assert_eq!(state.atomic_update_calls, 0);
}

#[test]
fn promotion_gateway_reports_target_advanced_when_an_exact_receipt_is_no_longer_on_the_target() {
    let (runner, state) = PromotionGitRunner::new(true);
    state.borrow_mut().target_head = PROMOTION_TARGET_ADVANCED.into();
    let mut gateway = test_promotion_gateway(runner);

    let outcome = gateway
        .promote(promotion_capability())
        .expect("target movement is an observed reconciliation outcome");

    assert!(matches!(
        outcome,
        PromotionGitOutcome::TargetAdvanced { .. }
    ));
    assert_eq!(
        outcome.binding().worktree_sync_state,
        Some(PromotionWorktreeSyncStateV1::TargetAdvanced)
    );
    let state = state.borrow();
    assert_eq!(state.create_merge_calls, 0);
    assert_eq!(state.atomic_update_calls, 0);
}

#[test]
fn promotion_gateway_reports_target_advanced_when_a_descendant_still_contains_the_merge() {
    let (runner, state) = PromotionGitRunner::new(true);
    {
        let mut state = state.borrow_mut();
        state.target_head = PROMOTION_TARGET_ADVANCED.into();
        state.target_contains_merge = true;
    }
    let mut gateway = test_promotion_gateway(runner);

    let outcome = gateway
        .promote(promotion_capability())
        .expect("a descendant target remains an observed reconciliation outcome");

    assert!(matches!(
        outcome,
        PromotionGitOutcome::TargetAdvanced { .. }
    ));
    assert_eq!(
        outcome.binding().worktree_sync_state,
        Some(PromotionWorktreeSyncStateV1::TargetAdvanced)
    );
    let state = state.borrow();
    assert_eq!(state.create_merge_calls, 0);
    assert_eq!(state.atomic_update_calls, 0);
    assert!(state.operations.iter().any(|operation| matches!(
        operation,
        TestGitOperation::IsAncestor {
            ancestor,
            descendant,
        } if ancestor == PROMOTION_MERGE_COMMIT && descendant == PROMOTION_TARGET_ADVANCED
    )));
}

struct DispatchAdmissionFixture {
    _temp: TempDir,
    db_path: PathBuf,
    store: SqliteStore,
    authority: GovernedDispatchAdmissionAuthorityV1,
    dispatch_key: SigningKey,
    dispatch_signer: ActorKeyRef,
    checkpoint_key: SigningKey,
    checkpoint_signer: ActorKeyRef,
    replay_authorities: TrustedReplayAuthorities,
    parsed: super::admission_protocol::ParsedAuthorityBrokerRequestV1,
    request: GovernedDispatchAdmissionRequestV1,
}

fn dispatch_admission_fixture() -> DispatchAdmissionFixture {
    let parsed = super::admission_protocol::parse_authority_broker_request_v1(
        authority_broker_admission_wire().as_bytes(),
    )
    .expect("parse strict authority-broker admit fixture");
    let admit = match &parsed.request {
        super::admission_protocol::ParsedAuthorityBrokerRequestBodyV1::Admit(admit) => {
            admit.clone()
        }
        other => panic!("expected parsed admit request, received {other:?}"),
    };
    let run_id: RunId = serde_json::from_value(serde_json::Value::String(admit.run_id.clone()))
        .expect("strict parsed run id must deserialize as a ledger run id");
    let now = Utc::now();
    let body = DispatchEnvelopeBodyV2 {
        workflow_id: admit.workflow_id.clone(),
        workflow_revision: admit.workflow_revision.clone(),
        unit_id: admit.unit_id.clone(),
        attempt: u32::try_from(admit.attempt).expect("fixture attempt fits u32"),
        execution_role: ExecutionRoleV1::Implementer,
        commit_mode: CommitModeV1::Atomic,
        provenance_ref: "protected:broker-dispatch-admission".into(),
        base_commit_sha: "1".repeat(40),
        capability_bundle_digest: DIGEST_A.into(),
        acceptance_contract_digest: DIGEST_B.into(),
        context_manifest_digest: DIGEST_C.into(),
        worker_manifest_digest: DIGEST_D.into(),
        sandbox_profile_digest: DIGEST_E.into(),
        budget: DispatchBudgetV1 {
            max_tokens: Some(1_024),
            max_compute_time_ms: Some(60_000),
        },
        trust_tier: TrustTierV1::Governed,
        idempotency_key: admit.idempotency_key.clone(),
        issued_at: timestamp(now - Duration::seconds(1)),
        expires_at: timestamp(now + Duration::minutes(10)),
    };
    let envelope_digest = dispatch_envelope_v3_body_digest(
        &body,
        ActionEvidenceVersionV1::SealedV3,
        &admit.expected_repository_binding_digest,
        DIGEST_E,
        Some(&admit.governed_packet_digest),
    )
    .expect("hash protected broker dispatch fixture");
    let request = GovernedDispatchAdmissionRequestV1 {
        run_id,
        dispatch: DispatchEnvelopeV3 {
            body,
            action_evidence_version: ActionEvidenceVersionV1::SealedV3,
            repository_binding_digest: admit.expected_repository_binding_digest,
            ledger_authority_realm_digest: DIGEST_E.into(),
            governed_packet_digest: Some(admit.governed_packet_digest),
            envelope_digest,
        },
    };

    let temp = TempDir::new().expect("open temporary dispatch-admission directory");
    let db_path = temp.path().join("events.db");
    let store = SqliteStore::open(&db_path).expect("open dispatch-admission SQLite ledger");
    let dispatch_key = SigningKey::from_bytes(&[111; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[112; 32]);
    let dispatch_signer = promotion_actor("broker-dispatch", "dispatch-main", &dispatch_key);
    let checkpoint_signer =
        promotion_actor("broker-checkpoint", "checkpoint-main", &checkpoint_key);
    let authority = GovernedDispatchAdmissionAuthorityV1::new_governed_realm(
        promotion_trusted_keys(&[&dispatch_key, &checkpoint_key]),
        dispatch_signer.clone(),
        checkpoint_signer.clone(),
        DIGEST_E.into(),
    )
    .expect("inject distinct dispatch and checkpoint authorities");
    let mut replay_authorities =
        TrustedReplayAuthorities::new(promotion_trusted_keys(&[&dispatch_key, &checkpoint_key]));
    replay_authorities.allow_signer(TrustSpineSignerRole::Kernel, dispatch_signer.clone());
    replay_authorities.allow_signer(TrustSpineSignerRole::Kernel, checkpoint_signer.clone());

    DispatchAdmissionFixture {
        _temp: temp,
        db_path,
        store,
        authority,
        dispatch_key,
        dispatch_signer,
        checkpoint_key,
        checkpoint_signer,
        replay_authorities,
        parsed,
        request,
    }
}

fn dispatch_admission_event_count(fixture: &DispatchAdmissionFixture) -> usize {
    fixture
        .store
        .events_for_run(&fixture.request.run_id.to_string())
        .expect("read dispatch-admission tape")
        .iter()
        .filter(|event| event.kind == "dispatch_envelope_v3")
        .count()
}

fn dispatch_admission_checkpoint_count(fixture: &DispatchAdmissionFixture) -> usize {
    fixture
        .store
        .events_for_run(&fixture.request.run_id.to_string())
        .expect("read dispatch-admission tape")
        .iter()
        .filter(|event| event.kind == "tape_checkpoint")
        .count()
}

fn append_later_valid_checkpointed_dispatch(fixture: &DispatchAdmissionFixture) {
    let now = Utc::now();
    let mut dispatch = fixture.request.dispatch.clone();
    dispatch.body.unit_id = "unit-after-admission".into();
    dispatch.body.idempotency_key = "workflow-trust-spine:unit-after-admission:1".into();
    dispatch.body.issued_at = timestamp(now - Duration::seconds(1));
    dispatch.body.expires_at = timestamp(now + Duration::minutes(10));
    dispatch.envelope_digest = dispatch_envelope_v3_body_digest(
        &dispatch.body,
        dispatch.action_evidence_version,
        &dispatch.repository_binding_digest,
        &dispatch.ledger_authority_realm_digest,
        dispatch.governed_packet_digest.as_deref(),
    )
    .expect("hash later valid dispatch");
    let event = Event {
        id: EventId::new(),
        run_id: fixture.request.run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::DispatchEnvelopeV3,
        occurred_at: now,
        payload: Payload::DispatchEnvelopeV3(dispatch),
    };
    fixture
        .store
        .append_signed_with_checkpoint(
            &event,
            &fixture.checkpoint_key,
            &fixture.checkpoint_signer,
            &CheckpointPolicy::every(1),
        )
        .expect("append later valid signed dispatch and checkpoint");
}

fn exact_checkpoint_evidence(
    fixture: &DispatchAdmissionFixture,
    ordinal: usize,
) -> (EventId, String) {
    let checkpoint = fixture
        .store
        .events_for_run(&fixture.request.run_id.to_string())
        .expect("read checkpointed dispatch-admission tape")
        .into_iter()
        .filter(|event| event.kind == "tape_checkpoint")
        .nth(ordinal)
        .expect("fixture must contain the requested checkpoint")
        .to_event()
        .expect("checkpoint row must decode");
    (
        checkpoint.id,
        canonical_event_hash(&checkpoint).expect("hash immutable checkpoint evidence"),
    )
}

struct FixtureDispatchAdmissionResolver {
    request: GovernedDispatchAdmissionRequestV1,
    calls: Rc<RefCell<usize>>,
}

impl DispatchAdmissionRequestResolver for FixtureDispatchAdmissionResolver {
    fn resolve_exact_admit(
        &mut self,
        admit: &super::admission_protocol::ParsedAuthorityBrokerAdmitRequestV1,
    ) -> Result<ResolvedDispatchAdmission, DispatchAdmissionResolverError> {
        *self.calls.borrow_mut() += 1;
        Ok(ResolvedDispatchAdmission::from_protected_registry(
            self.request.clone(),
            admit.repository_target_ref.clone(),
            admit.governed_packet_ref.clone(),
        ))
    }
}

#[derive(Clone, Copy)]
enum SubstitutedOpaqueReference {
    RepositoryTarget,
    GovernedPacket,
}

struct SubstitutingOpaqueReferenceResolver {
    request: GovernedDispatchAdmissionRequestV1,
    substitution: SubstitutedOpaqueReference,
}

impl DispatchAdmissionRequestResolver for SubstitutingOpaqueReferenceResolver {
    fn resolve_exact_admit(
        &mut self,
        admit: &super::admission_protocol::ParsedAuthorityBrokerAdmitRequestV1,
    ) -> Result<ResolvedDispatchAdmission, DispatchAdmissionResolverError> {
        let repository_target_ref = match self.substitution {
            SubstitutedOpaqueReference::RepositoryTarget => "broker://repositories/other".into(),
            SubstitutedOpaqueReference::GovernedPacket => admit.repository_target_ref.clone(),
        };
        let governed_packet_ref = match self.substitution {
            SubstitutedOpaqueReference::RepositoryTarget => admit.governed_packet_ref.clone(),
            SubstitutedOpaqueReference::GovernedPacket => "cas://packets/other".into(),
        };
        Ok(ResolvedDispatchAdmission::from_protected_registry(
            self.request.clone(),
            repository_target_ref,
            governed_packet_ref,
        ))
    }
}

struct NeverDispatchAdmissionSnapshotVerifier {
    calls: Rc<RefCell<usize>>,
}

impl DispatchAdmissionSnapshotVerifier for NeverDispatchAdmissionSnapshotVerifier {
    fn verify_fresh_sealed_admission(
        &mut self,
        _request: &GovernedDispatchAdmissionRequestV1,
        _sealed: &SealedDispatchAdmissionEvidence,
    ) -> Result<(), DispatchAdmissionSnapshotError> {
        *self.calls.borrow_mut() += 1;
        Err(DispatchAdmissionSnapshotError::Rejected {
            reason: "test verifier must not be called".into(),
        })
    }
}

#[derive(Clone)]
enum SubstitutedDispatchAdmissionEvidence {
    DispatchEventDigest,
    CheckpointEventDigest,
    EarlierCheckpoint {
        event_id: EventId,
        event_digest: String,
    },
}

struct SubstitutingDispatchAdmissionBackend<B> {
    inner: B,
    substitution: SubstitutedDispatchAdmissionEvidence,
}

impl<B> DispatchAdmissionBackend for SubstitutingDispatchAdmissionBackend<B>
where
    B: DispatchAdmissionBackend,
{
    fn record_then_exact_seal(
        &mut self,
        request: &GovernedDispatchAdmissionRequestV1,
    ) -> Result<SealedDispatchAdmissionEvidence, DispatchAdmissionBackendError> {
        let mut sealed = self.inner.record_then_exact_seal(request)?;
        match &self.substitution {
            SubstitutedDispatchAdmissionEvidence::DispatchEventDigest => {
                sealed.dispatch_event_digest = DIGEST_A.into()
            }
            SubstitutedDispatchAdmissionEvidence::CheckpointEventDigest => {
                sealed.checkpoint_event_digest = DIGEST_A.into()
            }
            SubstitutedDispatchAdmissionEvidence::EarlierCheckpoint {
                event_id,
                event_digest,
            } => {
                sealed.checkpoint_event_id = event_id.clone();
                sealed.checkpoint_event_digest = event_digest.clone();
            }
        }
        Ok(sealed)
    }
}

struct CopyingDispatchAdmissionBackend<B> {
    inner: B,
    source_database_path: PathBuf,
    copied_snapshot_database_path: PathBuf,
}

impl<B> DispatchAdmissionBackend for CopyingDispatchAdmissionBackend<B>
where
    B: DispatchAdmissionBackend,
{
    fn record_then_exact_seal(
        &mut self,
        request: &GovernedDispatchAdmissionRequestV1,
    ) -> Result<SealedDispatchAdmissionEvidence, DispatchAdmissionBackendError> {
        let sealed = self.inner.record_then_exact_seal(request)?;
        let checkpoint =
            rusqlite::Connection::open(&self.source_database_path).map_err(LedgerError::from)?;
        checkpoint
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(LedgerError::from)?;
        fs::copy(
            &self.source_database_path,
            &self.copied_snapshot_database_path,
        )
        .map_err(LedgerError::from)?;
        Ok(sealed)
    }
}

#[test]
fn broker_dispatch_admission_records_seals_and_confirms_a_fresh_trusted_snapshot() {
    let fixture = dispatch_admission_fixture();
    let resolver_calls = Rc::new(RefCell::new(0));
    let resolver = FixtureDispatchAdmissionResolver {
        request: fixture.request.clone(),
        calls: Rc::clone(&resolver_calls),
    };
    let backend = LedgerDispatchAdmissionBackend::from_prevalidated_startup(
        &fixture.store,
        &fixture.authority,
        &fixture.dispatch_key,
        &fixture.dispatch_signer,
        &fixture.checkpoint_key,
        &fixture.checkpoint_signer,
    )
    .expect("startup injects independently configured ledger signers");
    let snapshot = TrustedDispatchAdmissionSnapshotVerifier::from_prevalidated_startup(
        &fixture.store,
        &fixture.db_path,
        &fixture.replay_authorities,
        &fixture.checkpoint_signer,
    );
    let mut broker = BrokerDispatchAdmissionAuthority::new(resolver, backend, snapshot);

    let outcome = broker.admit(fixture.parsed.clone());

    assert!(matches!(
        outcome,
        BrokerDispatchAdmissionDisposition::Sealed(_)
    ));
    assert_eq!(*resolver_calls.borrow(), 1);
    assert_eq!(dispatch_admission_event_count(&fixture), 1);
    assert_eq!(dispatch_admission_checkpoint_count(&fixture), 1);
}

#[test]
fn broker_dispatch_admission_exact_retry_returns_the_existing_sealed_identity_without_a_dispatch() {
    let fixture = dispatch_admission_fixture();
    let resolver = FixtureDispatchAdmissionResolver {
        request: fixture.request.clone(),
        calls: Rc::new(RefCell::new(0)),
    };
    let backend = LedgerDispatchAdmissionBackend::from_prevalidated_startup(
        &fixture.store,
        &fixture.authority,
        &fixture.dispatch_key,
        &fixture.dispatch_signer,
        &fixture.checkpoint_key,
        &fixture.checkpoint_signer,
    )
    .expect("startup injects independently configured ledger signers");
    let snapshot = TrustedDispatchAdmissionSnapshotVerifier::from_prevalidated_startup(
        &fixture.store,
        &fixture.db_path,
        &fixture.replay_authorities,
        &fixture.checkpoint_signer,
    );
    let mut broker = BrokerDispatchAdmissionAuthority::new(resolver, backend, snapshot);

    let first = broker.admit(fixture.parsed.clone());
    let retry = broker.admit(fixture.parsed.clone());

    assert!(matches!(
        first,
        BrokerDispatchAdmissionDisposition::Sealed(_)
    ));
    assert_eq!(retry, first, "exact retry must reuse the sealed proof");
    assert_eq!(dispatch_admission_event_count(&fixture), 1);
    assert_eq!(dispatch_admission_checkpoint_count(&fixture), 1);
}

#[test]
fn broker_dispatch_admission_exact_retry_stays_sealed_after_a_later_valid_checkpoint() {
    let fixture = dispatch_admission_fixture();
    let resolver = FixtureDispatchAdmissionResolver {
        request: fixture.request.clone(),
        calls: Rc::new(RefCell::new(0)),
    };
    let backend = LedgerDispatchAdmissionBackend::from_prevalidated_startup(
        &fixture.store,
        &fixture.authority,
        &fixture.dispatch_key,
        &fixture.dispatch_signer,
        &fixture.checkpoint_key,
        &fixture.checkpoint_signer,
    )
    .expect("startup injects independently configured ledger signers");
    let snapshot = TrustedDispatchAdmissionSnapshotVerifier::from_prevalidated_startup(
        &fixture.store,
        &fixture.db_path,
        &fixture.replay_authorities,
        &fixture.checkpoint_signer,
    );
    let mut broker = BrokerDispatchAdmissionAuthority::new(resolver, backend, snapshot);

    let first = broker.admit(fixture.parsed.clone());
    assert!(matches!(
        first,
        BrokerDispatchAdmissionDisposition::Sealed(_)
    ));
    append_later_valid_checkpointed_dispatch(&fixture);
    assert_eq!(dispatch_admission_event_count(&fixture), 2);
    assert_eq!(dispatch_admission_checkpoint_count(&fixture), 2);

    let retry = broker.admit(fixture.parsed.clone());

    assert_eq!(
        retry, first,
        "later valid work must not revoke a sealed retry"
    );
    assert_eq!(dispatch_admission_event_count(&fixture), 2);
    assert_eq!(dispatch_admission_checkpoint_count(&fixture), 2);
}

#[test]
fn broker_dispatch_admission_reconciles_when_injected_real_checkpoint_precedes_its_dispatch() {
    let fixture = dispatch_admission_fixture();
    append_later_valid_checkpointed_dispatch(&fixture);
    let (earlier_checkpoint_event_id, earlier_checkpoint_event_digest) =
        exact_checkpoint_evidence(&fixture, 0);
    let resolver = FixtureDispatchAdmissionResolver {
        request: fixture.request.clone(),
        calls: Rc::new(RefCell::new(0)),
    };
    let backend = SubstitutingDispatchAdmissionBackend {
        inner: LedgerDispatchAdmissionBackend::from_prevalidated_startup(
            &fixture.store,
            &fixture.authority,
            &fixture.dispatch_key,
            &fixture.dispatch_signer,
            &fixture.checkpoint_key,
            &fixture.checkpoint_signer,
        )
        .expect("startup injects independently configured ledger signers"),
        substitution: SubstitutedDispatchAdmissionEvidence::EarlierCheckpoint {
            event_id: earlier_checkpoint_event_id,
            event_digest: earlier_checkpoint_event_digest,
        },
    };
    let snapshot = TrustedDispatchAdmissionSnapshotVerifier::from_prevalidated_startup(
        &fixture.store,
        &fixture.db_path,
        &fixture.replay_authorities,
        &fixture.checkpoint_signer,
    );
    let mut broker = BrokerDispatchAdmissionAuthority::new(resolver, backend, snapshot);

    assert!(matches!(
        broker.admit(fixture.parsed.clone()),
        BrokerDispatchAdmissionDisposition::ReconciliationRequired
    ));
    assert_eq!(dispatch_admission_event_count(&fixture), 2);
    assert_eq!(dispatch_admission_checkpoint_count(&fixture), 2);
}

#[test]
fn broker_dispatch_admission_reconciles_when_snapshot_path_is_a_distinct_copy_of_store() {
    let fixture = dispatch_admission_fixture();
    let copied_snapshot_database_path = fixture._temp.path().join("copied-events.db");
    let resolver = FixtureDispatchAdmissionResolver {
        request: fixture.request.clone(),
        calls: Rc::new(RefCell::new(0)),
    };
    let backend = CopyingDispatchAdmissionBackend {
        inner: LedgerDispatchAdmissionBackend::from_prevalidated_startup(
            &fixture.store,
            &fixture.authority,
            &fixture.dispatch_key,
            &fixture.dispatch_signer,
            &fixture.checkpoint_key,
            &fixture.checkpoint_signer,
        )
        .expect("startup injects independently configured ledger signers"),
        source_database_path: fixture.db_path.clone(),
        copied_snapshot_database_path: copied_snapshot_database_path.clone(),
    };
    let snapshot = TrustedDispatchAdmissionSnapshotVerifier::from_prevalidated_startup(
        &fixture.store,
        &copied_snapshot_database_path,
        &fixture.replay_authorities,
        &fixture.checkpoint_signer,
    );
    let mut broker = BrokerDispatchAdmissionAuthority::new(resolver, backend, snapshot);

    assert!(matches!(
        broker.admit(fixture.parsed.clone()),
        BrokerDispatchAdmissionDisposition::ReconciliationRequired
    ));
    assert!(
        copied_snapshot_database_path.exists(),
        "backend must create the otherwise-valid copied recovery database"
    );
    assert_eq!(dispatch_admission_event_count(&fixture), 1);
    assert_eq!(dispatch_admission_checkpoint_count(&fixture), 1);
}

#[test]
fn broker_dispatch_admission_rejects_every_resolved_tuple_or_digest_mismatch_before_ledger_write() {
    for mismatch in [
        "run",
        "workflow",
        "revision",
        "unit",
        "attempt",
        "idempotency",
        "repository_binding",
        "governed_packet",
    ] {
        let fixture = dispatch_admission_fixture();
        let mut mismatched = fixture.request.clone();
        match mismatch {
            "run" => mismatched.run_id = RunId::new(),
            "workflow" => mismatched.dispatch.body.workflow_id = "other-workflow".into(),
            "revision" => mismatched.dispatch.body.workflow_revision = "other-revision".into(),
            "unit" => mismatched.dispatch.body.unit_id = "other-unit".into(),
            "attempt" => mismatched.dispatch.body.attempt += 1,
            "idempotency" => mismatched.dispatch.body.idempotency_key = "other-key".into(),
            "repository_binding" => mismatched.dispatch.repository_binding_digest = DIGEST_A.into(),
            "governed_packet" => mismatched.dispatch.governed_packet_digest = Some(DIGEST_B.into()),
            other => panic!("unknown mismatch fixture {other}"),
        }
        let resolver = FixtureDispatchAdmissionResolver {
            request: mismatched,
            calls: Rc::new(RefCell::new(0)),
        };
        let backend = LedgerDispatchAdmissionBackend::from_prevalidated_startup(
            &fixture.store,
            &fixture.authority,
            &fixture.dispatch_key,
            &fixture.dispatch_signer,
            &fixture.checkpoint_key,
            &fixture.checkpoint_signer,
        )
        .expect("startup injects independently configured ledger signers");
        let snapshot = TrustedDispatchAdmissionSnapshotVerifier::from_prevalidated_startup(
            &fixture.store,
            &fixture.db_path,
            &fixture.replay_authorities,
            &fixture.checkpoint_signer,
        );
        let mut broker = BrokerDispatchAdmissionAuthority::new(resolver, backend, snapshot);

        assert!(matches!(
            broker.admit(fixture.parsed.clone()),
            BrokerDispatchAdmissionDisposition::ReconciliationRequired
        ));
        assert_eq!(
            dispatch_admission_event_count(&fixture),
            0,
            "{mismatch} mismatch must be rejected before dispatch recording"
        );
        assert_eq!(
            dispatch_admission_checkpoint_count(&fixture),
            0,
            "{mismatch} mismatch must be rejected before checkpoint sealing"
        );
    }
}

#[test]
fn broker_dispatch_admission_rejects_opaque_reference_substitution_before_ledger_write() {
    for substitution in [
        SubstitutedOpaqueReference::RepositoryTarget,
        SubstitutedOpaqueReference::GovernedPacket,
    ] {
        let fixture = dispatch_admission_fixture();
        let resolver = SubstitutingOpaqueReferenceResolver {
            request: fixture.request.clone(),
            substitution,
        };
        let backend = LedgerDispatchAdmissionBackend::from_prevalidated_startup(
            &fixture.store,
            &fixture.authority,
            &fixture.dispatch_key,
            &fixture.dispatch_signer,
            &fixture.checkpoint_key,
            &fixture.checkpoint_signer,
        )
        .expect("startup injects independently configured ledger signers");
        let snapshot = TrustedDispatchAdmissionSnapshotVerifier::from_prevalidated_startup(
            &fixture.store,
            &fixture.db_path,
            &fixture.replay_authorities,
            &fixture.checkpoint_signer,
        );
        let mut broker = BrokerDispatchAdmissionAuthority::new(resolver, backend, snapshot);

        assert!(matches!(
            broker.admit(fixture.parsed.clone()),
            BrokerDispatchAdmissionDisposition::ReconciliationRequired
        ));
        assert_eq!(dispatch_admission_event_count(&fixture), 0);
        assert_eq!(dispatch_admission_checkpoint_count(&fixture), 0);
    }
}

#[test]
fn broker_dispatch_admission_fails_closed_for_lookup_without_resolver_or_ledger_effects() {
    let mut fixture = dispatch_admission_fixture();
    fixture.parsed = super::admission_protocol::parse_authority_broker_request_v1(
        authority_broker_lookup_wire().as_bytes(),
    )
    .expect("parse strict authority-broker lookup fixture");
    let resolver_calls = Rc::new(RefCell::new(0));
    let snapshot_calls = Rc::new(RefCell::new(0));
    let resolver = FixtureDispatchAdmissionResolver {
        request: fixture.request.clone(),
        calls: Rc::clone(&resolver_calls),
    };
    let backend = LedgerDispatchAdmissionBackend::from_prevalidated_startup(
        &fixture.store,
        &fixture.authority,
        &fixture.dispatch_key,
        &fixture.dispatch_signer,
        &fixture.checkpoint_key,
        &fixture.checkpoint_signer,
    )
    .expect("startup injects independently configured ledger signers");
    let mut broker = BrokerDispatchAdmissionAuthority::new(
        resolver,
        backend,
        NeverDispatchAdmissionSnapshotVerifier {
            calls: Rc::clone(&snapshot_calls),
        },
    );

    assert!(matches!(
        broker.admit(fixture.parsed.clone()),
        BrokerDispatchAdmissionDisposition::ReconciliationRequired
    ));
    assert_eq!(*resolver_calls.borrow(), 0);
    assert_eq!(*snapshot_calls.borrow(), 0);
    assert_eq!(dispatch_admission_event_count(&fixture), 0);
    assert_eq!(dispatch_admission_checkpoint_count(&fixture), 0);
}

#[test]
fn broker_dispatch_admission_reconciles_after_a_real_seal_when_fresh_snapshot_evidence_mismatches()
{
    let fixture = dispatch_admission_fixture();
    let resolver = FixtureDispatchAdmissionResolver {
        request: fixture.request.clone(),
        calls: Rc::new(RefCell::new(0)),
    };
    let backend = SubstitutingDispatchAdmissionBackend {
        inner: LedgerDispatchAdmissionBackend::from_prevalidated_startup(
            &fixture.store,
            &fixture.authority,
            &fixture.dispatch_key,
            &fixture.dispatch_signer,
            &fixture.checkpoint_key,
            &fixture.checkpoint_signer,
        )
        .expect("startup injects independently configured ledger signers"),
        substitution: SubstitutedDispatchAdmissionEvidence::CheckpointEventDigest,
    };
    let snapshot = TrustedDispatchAdmissionSnapshotVerifier::from_prevalidated_startup(
        &fixture.store,
        &fixture.db_path,
        &fixture.replay_authorities,
        &fixture.checkpoint_signer,
    );
    let mut broker = BrokerDispatchAdmissionAuthority::new(resolver, backend, snapshot);

    assert!(matches!(
        broker.admit(fixture.parsed.clone()),
        BrokerDispatchAdmissionDisposition::ReconciliationRequired
    ));
    assert_eq!(dispatch_admission_event_count(&fixture), 1);
    assert_eq!(dispatch_admission_checkpoint_count(&fixture), 1);
}

#[test]
fn broker_dispatch_admission_reconciles_after_a_real_seal_when_dispatch_event_digest_mismatches() {
    let fixture = dispatch_admission_fixture();
    let resolver = FixtureDispatchAdmissionResolver {
        request: fixture.request.clone(),
        calls: Rc::new(RefCell::new(0)),
    };
    let backend = SubstitutingDispatchAdmissionBackend {
        inner: LedgerDispatchAdmissionBackend::from_prevalidated_startup(
            &fixture.store,
            &fixture.authority,
            &fixture.dispatch_key,
            &fixture.dispatch_signer,
            &fixture.checkpoint_key,
            &fixture.checkpoint_signer,
        )
        .expect("startup injects independently configured ledger signers"),
        substitution: SubstitutedDispatchAdmissionEvidence::DispatchEventDigest,
    };
    let snapshot = TrustedDispatchAdmissionSnapshotVerifier::from_prevalidated_startup(
        &fixture.store,
        &fixture.db_path,
        &fixture.replay_authorities,
        &fixture.checkpoint_signer,
    );
    let mut broker = BrokerDispatchAdmissionAuthority::new(resolver, backend, snapshot);

    assert!(matches!(
        broker.admit(fixture.parsed.clone()),
        BrokerDispatchAdmissionDisposition::ReconciliationRequired
    ));
    assert_eq!(dispatch_admission_event_count(&fixture), 1);
    assert_eq!(dispatch_admission_checkpoint_count(&fixture), 1);
}

#[test]
fn broker_dispatch_admission_never_reports_success_when_checkpoint_sealing_fails() {
    let fixture = dispatch_admission_fixture();
    let resolver = FixtureDispatchAdmissionResolver {
        request: fixture.request.clone(),
        calls: Rc::new(RefCell::new(0)),
    };
    let wrong_checkpoint_key = SigningKey::from_bytes(&[113; 32]);
    let backend = LedgerDispatchAdmissionBackend::from_prevalidated_startup(
        &fixture.store,
        &fixture.authority,
        &fixture.dispatch_key,
        &fixture.dispatch_signer,
        &wrong_checkpoint_key,
        &fixture.checkpoint_signer,
    )
    .expect("distinct but untrusted checkpoint material is a runtime reconciliation case");
    let snapshot = TrustedDispatchAdmissionSnapshotVerifier::from_prevalidated_startup(
        &fixture.store,
        &fixture.db_path,
        &fixture.replay_authorities,
        &fixture.checkpoint_signer,
    );
    let mut broker = BrokerDispatchAdmissionAuthority::new(resolver, backend, snapshot);

    assert!(matches!(
        broker.admit(fixture.parsed.clone()),
        BrokerDispatchAdmissionDisposition::ReconciliationRequired
    ));
    assert_eq!(dispatch_admission_event_count(&fixture), 1);
    assert_eq!(dispatch_admission_checkpoint_count(&fixture), 0);
}

/// A minimal, real signed V5 source tape. The broker adapter is deliberately
/// exercised against the ledger's V5 admission transaction rather than a fake
/// backend so a source envelope cannot be confused with the later host-signed
/// admission receipt.
pub(crate) struct V5BrokerAdmissionFixture {
    store: SqliteStore,
    pub(crate) run_id: RunId,
    source_dispatch_event_id: EventId,
    pub(crate) v5_envelope_digest: String,
    source_key: SigningKey,
    source_signer: ActorKeyRef,
    admission_key: SigningKey,
    admission_signer: ActorKeyRef,
    checkpoint_key: SigningKey,
    checkpoint_signer: ActorKeyRef,
    authority: GovernedDispatchV5AdmissionAuthorityV1,
}

fn v5_broker_event(run_id: RunId, kind: EventKind, payload: Payload) -> Event {
    Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind,
        occurred_at: Utc::now(),
        payload,
    }
}

pub(crate) fn v5_broker_admission_fixture() -> V5BrokerAdmissionFixture {
    v5_broker_admission_fixture_with_exact_signer_flood_before_source(0)
}

fn v5_broker_admission_fixture_with_exact_signer_flood_before_source(
    forged_count: usize,
) -> V5BrokerAdmissionFixture {
    let store = SqliteStore::open_in_memory().expect("open V5 broker admission ledger");
    let source_key = SigningKey::from_bytes(&[241; 32]);
    let admission_key = SigningKey::from_bytes(&[242; 32]);
    let checkpoint_key = SigningKey::from_bytes(&[243; 32]);
    let source_signer = promotion_actor("broker:v5-source", "source-1", &source_key);
    let admission_signer = promotion_actor("kernel:v5-admission", "admission-1", &admission_key);
    let checkpoint_signer =
        promotion_actor("kernel:v5-checkpoint", "checkpoint-1", &checkpoint_key);
    let authority = GovernedDispatchV5AdmissionAuthorityV1::new_governed_realm(
        promotion_trusted_keys(&[&source_key, &admission_key, &checkpoint_key]),
        source_signer.clone(),
        admission_signer.clone(),
        checkpoint_signer.clone(),
        authority_broker_digest('9'),
    )
    .expect("construct three-way V5 admission authority");

    let run_id = RunId::new();
    let now = Utc::now();
    let context_manifest = ContextManifestContentV1 {
        entries: vec![ContextManifestEntryV1 {
            kind: ContextManifestEntryKindV1::RepositoryFile,
            reference: "repo:AGENTS.md".into(),
            digest: authority_broker_digest('a'),
            provenance_ref: "provenance:repository".into(),
            trust: ContextTrustLevelV1::Verified,
            taint: ContextTaintV1::Clean,
        }],
    };
    let worker_manifest = WorkerManifestContentV1 {
        provider: WorkerProviderV1::OpenAi,
        model: "gpt-5".into(),
        harness: WorkerHarnessV1::OpenAiApiSdk,
        image_digest: authority_broker_digest('b'),
        tool_manifest_digest: authority_broker_digest('c'),
        skill_manifest_digest: authority_broker_digest('d'),
        capability_bundle_digest: authority_broker_digest('e'),
        execution_role: ExecutionRoleV1::Implementer,
    };
    let sandbox_profile = SandboxProfileContentV1 {
        runtime: SandboxRuntimeV1::RootlessOci,
        rootless: true,
        image_digest: worker_manifest.image_digest.clone(),
        read_only_rootfs: true,
        writable_overlay_digest: authority_broker_digest('f'),
        mount_manifest_digest: authority_broker_digest('a'),
        environment_manifest_digest: authority_broker_digest('b'),
        network_policy_digest: authority_broker_digest('c'),
        resource_policy_digest: authority_broker_digest('d'),
        secret_handle_manifest_digest: authority_broker_digest('e'),
    };
    let context_declaration = ContextManifestDeclaredV1 {
        run_id: run_id.to_string(),
        workflow_id: "workflow-v5".into(),
        workflow_revision: "r1".into(),
        unit_id: "unit-v5".into(),
        attempt: 1,
        provenance_ref: "admission:v5".into(),
        context_manifest_digest: context_manifest_content_v1_digest(&context_manifest)
            .expect("hash V5 context manifest"),
        context_manifest,
        idempotency_key: "context-manifest:workflow-v5:unit-v5:1".into(),
        declared_at: timestamp(now),
    };
    let worker_declaration = WorkerManifestDeclaredV1 {
        run_id: run_id.to_string(),
        workflow_id: "workflow-v5".into(),
        workflow_revision: "r1".into(),
        unit_id: "unit-v5".into(),
        attempt: 1,
        provenance_ref: "admission:v5".into(),
        worker_manifest_digest: worker_manifest_content_v1_digest(&worker_manifest)
            .expect("hash V5 worker manifest"),
        worker_manifest,
        idempotency_key: "worker-manifest:workflow-v5:unit-v5:1".into(),
        declared_at: timestamp(now),
    };
    let sandbox_declaration = SandboxProfileDeclaredV1 {
        run_id: run_id.to_string(),
        workflow_id: "workflow-v5".into(),
        workflow_revision: "r1".into(),
        unit_id: "unit-v5".into(),
        attempt: 1,
        provenance_ref: "admission:v5".into(),
        sandbox_profile_digest: sandbox_profile_content_v1_digest(&sandbox_profile)
            .expect("hash V5 sandbox profile"),
        sandbox_profile,
        idempotency_key: "sandbox-profile:workflow-v5:unit-v5:1".into(),
        declared_at: timestamp(now),
    };

    let graph_packet_digest = authority_broker_digest('f');
    let mut graph = WorkflowGraphDeclaredV2 {
        run_id: run_id.to_string(),
        workflow_id: "workflow-v5".into(),
        workflow_revision: "r1".into(),
        nodes: vec![WorkflowGraphNodeV2 {
            unit_id: "unit-v5".into(),
            depends_on: vec![],
            execution_role: ExecutionRoleV1::Implementer,
            governed_packet_digest: graph_packet_digest.clone(),
        }],
        max_concurrent: 1,
        graph_digest: String::new(),
        idempotency_key: "graph-v2:workflow-v5:r1".into(),
        declared_at: timestamp(now),
    };
    graph.graph_digest = workflow_graph_v2_digest(&graph).expect("hash V5 graph");
    let graph_event = v5_broker_event(
        run_id,
        EventKind::WorkflowGraphDeclaredV2,
        Payload::WorkflowGraphDeclaredV2(graph.clone()),
    );
    let context_event = v5_broker_event(
        run_id,
        EventKind::ContextManifestDeclaredV1,
        Payload::ContextManifestDeclaredV1(context_declaration.clone()),
    );
    let worker_event = v5_broker_event(
        run_id,
        EventKind::WorkerManifestDeclaredV1,
        Payload::WorkerManifestDeclaredV1(worker_declaration.clone()),
    );
    let sandbox_event = v5_broker_event(
        run_id,
        EventKind::SandboxProfileDeclaredV1,
        Payload::SandboxProfileDeclaredV1(sandbox_declaration.clone()),
    );
    let body = DispatchEnvelopeBodyV2 {
        workflow_id: "workflow-v5".into(),
        workflow_revision: "r1".into(),
        unit_id: "unit-v5".into(),
        attempt: 1,
        execution_role: ExecutionRoleV1::Implementer,
        commit_mode: CommitModeV1::Atomic,
        provenance_ref: "admission:v5".into(),
        base_commit_sha: "1".repeat(40),
        capability_bundle_digest: worker_declaration
            .worker_manifest
            .capability_bundle_digest
            .clone(),
        acceptance_contract_digest: authority_broker_digest('c'),
        context_manifest_digest: context_declaration.context_manifest_digest.clone(),
        worker_manifest_digest: worker_declaration.worker_manifest_digest.clone(),
        sandbox_profile_digest: sandbox_declaration.sandbox_profile_digest.clone(),
        budget: DispatchBudgetV1 {
            max_tokens: Some(1_024),
            max_compute_time_ms: Some(60_000),
        },
        trust_tier: TrustTierV1::Governed,
        idempotency_key: "dispatch:workflow-v5:unit-v5:1".into(),
        issued_at: timestamp(now - Duration::seconds(1)),
        expires_at: timestamp(now + Duration::minutes(10)),
    };
    let dispatch_v3 = DispatchEnvelopeV3 {
        envelope_digest: dispatch_envelope_v3_body_digest(
            &body,
            ActionEvidenceVersionV1::SealedV3,
            &authority_broker_digest('a'),
            &authority_broker_digest('9'),
            Some(&graph_packet_digest),
        )
        .expect("hash V5 dispatch V3 layer"),
        body,
        action_evidence_version: ActionEvidenceVersionV1::SealedV3,
        repository_binding_digest: authority_broker_digest('a'),
        ledger_authority_realm_digest: authority_broker_digest('9'),
        governed_packet_digest: Some(graph_packet_digest),
    };
    let dispatch_v4 = DispatchEnvelopeV4 {
        envelope_digest: dispatch_envelope_v4_digest(
            &dispatch_v3,
            &graph.graph_digest,
            &graph_event.id,
        )
        .expect("hash V5 dispatch V4 layer"),
        dispatch_v3,
        workflow_graph_digest: graph.graph_digest,
        workflow_graph_declaration_event_ref: graph_event.id,
    };
    let mut dispatch = DispatchEnvelopeV5 {
        dispatch_v4,
        context_manifest_declaration_event_ref: context_event.id,
        context_manifest_digest: context_declaration.context_manifest_digest,
        worker_manifest_declaration_event_ref: worker_event.id,
        worker_manifest_digest: worker_declaration.worker_manifest_digest,
        sandbox_profile_declaration_event_ref: sandbox_event.id,
        sandbox_profile_digest: sandbox_declaration.sandbox_profile_digest,
        attempt_context_declaration_event_ref: None,
        attempt_context_digest: None,
        envelope_digest: String::new(),
    };
    dispatch.envelope_digest = dispatch_envelope_v5_digest(&dispatch).expect("hash V5 envelope");
    let dispatch_event = v5_broker_event(
        run_id,
        EventKind::DispatchEnvelopeV5,
        Payload::DispatchEnvelopeV5(dispatch.clone()),
    );

    for event in [&graph_event, &context_event, &worker_event, &sandbox_event] {
        store
            .append_signed(event, &source_key, &source_signer)
            .expect("append signed V5 source evidence");
    }
    store
        .append(&dispatch_event)
        .expect("append V5 source event before detached signature");
    if forged_count > 0 {
        let tx = store
            .conn_for_tests()
            .unchecked_transaction()
            .expect("begin pre-source exact-signer flood");
        for _ in 0..forged_count {
            let forged = Event {
                id: EventId::new(),
                occurred_at: Utc::now(),
                ..dispatch_event.clone()
            };
            let mut invalid = sign_event(&forged, &admission_key, &source_signer, Utc::now())
                .expect("construct invalid pre-source exact-signer signature");
            invalid.signer = source_signer.clone();
            insert_v5_flood_event(&tx, &forged, Some((&invalid, "ed25519")));
        }
        tx.commit().expect("commit pre-source exact-signer flood");
    }
    let source_signature = sign_event(&dispatch_event, &source_key, &source_signer, Utc::now())
        .expect("sign V5 source event");
    store
        .append_event_signature(&source_signature)
        .expect("append V5 source detached signature");

    V5BrokerAdmissionFixture {
        store,
        run_id,
        source_dispatch_event_id: dispatch_event.id,
        v5_envelope_digest: dispatch.envelope_digest,
        source_key,
        source_signer,
        admission_key,
        admission_signer,
        checkpoint_key,
        checkpoint_signer,
        authority,
    }
}

fn append_matching_v5_source(
    fixture: &V5BrokerAdmissionFixture,
    signing_key: Option<&SigningKey>,
    signer: Option<&ActorKeyRef>,
) {
    let duplicate = matching_v5_source_event(fixture);
    match (signing_key, signer) {
        (Some(signing_key), Some(signer)) => fixture
            .store
            .append_signed(&duplicate, signing_key, signer)
            .expect("append matching signed V5 source"),
        (None, None) => fixture
            .store
            .append(&duplicate)
            .expect("append matching unsigned V5 source"),
        _ => panic!("test source requires both signing key and signer"),
    }
}

fn matching_v5_source_event(fixture: &V5BrokerAdmissionFixture) -> Event {
    let (source, _) = fixture
        .store
        .signed_events_for_run(&fixture.run_id.to_string())
        .expect("read V5 source tape")
        .into_iter()
        .find(|(event, _)| event.id == fixture.source_dispatch_event_id)
        .expect("find original V5 source");
    Event {
        id: EventId::new(),
        occurred_at: Utc::now(),
        ..source
    }
}

fn insert_v5_flood_event(
    tx: &rusqlite::Transaction<'_>,
    event: &Event,
    signature: Option<(&bp_ledger::signing::EventSignatureV1, &str)>,
) {
    tx.execute(
        r#"INSERT INTO events
           (id, run_id, parent_event_id, schema_version, kind, occurred_at, payload)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#,
        rusqlite::params![
            event.id.to_string(),
            event.run_id.to_string(),
            event.parent_event_id.map(|id| id.to_string()),
            event.schema_version,
            event.kind_str(),
            event.occurred_at.to_rfc3339(),
            serde_json::to_string(&event.payload).expect("serialize flood payload"),
        ],
    )
    .expect("insert realistic flood event");
    if let Some((signature, algorithm)) = signature {
        tx.execute(
            r#"INSERT INTO event_signatures
               (event_id, canonical_event_hash, actor_id, key_id, public_key_hash,
                algorithm, signature, signed_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"#,
            rusqlite::params![
                signature.event_id.to_string(),
                signature.canonical_event_hash,
                signature.signer.actor_id,
                signature.signer.key_id,
                signature.signer.public_key_hash,
                algorithm,
                signature.signature,
                signature.signed_at.to_rfc3339(),
            ],
        )
        .expect("insert realistic flood signature");
    }
}

pub(crate) fn v5_broker_admission_receipt_count(fixture: &V5BrokerAdmissionFixture) -> usize {
    fixture
        .store
        .events_for_run(&fixture.run_id.to_string())
        .expect("read V5 broker admission tape")
        .iter()
        .filter(|event| event.kind == "governed_dispatch_v5_admission_recorded_v1")
        .count()
}

pub(crate) fn v5_broker_checkpoint_count(fixture: &V5BrokerAdmissionFixture) -> usize {
    fixture
        .store
        .events_for_run(&fixture.run_id.to_string())
        .expect("read V5 broker admission tape")
        .iter()
        .filter(|event| event.kind == "tape_checkpoint")
        .count()
}

fn v5_broker_admission_request(fixture: &V5BrokerAdmissionFixture) -> V5DispatchAdmissionRequest {
    V5DispatchAdmissionRequest {
        request_id: uuid::Uuid::parse_str("123e4567-e89b-12d3-a456-426614174000")
            .expect("canonical test request id"),
        run_id: fixture.run_id,
        v5_envelope_digest: fixture.v5_envelope_digest.clone(),
    }
}

fn v5_broker_admission_wire(request_id: &str, run_id: &str, v5_envelope_digest: &str) -> String {
    format!(
        r#"{{"request_id":"{request_id}","run_id":"{run_id}","v5_envelope_digest":"{v5_envelope_digest}"}}"#
    )
}

fn v5_broker_admission_wire_with_injected_field(
    fixture: &V5BrokerAdmissionFixture,
    injected_field: &str,
) -> String {
    let mut wire = v5_broker_admission_wire(
        "123e4567-e89b-12d3-a456-426614174000",
        &fixture.run_id.to_string(),
        &fixture.v5_envelope_digest,
    );
    wire.pop()
        .expect("the canonical V5 wire ends in an object delimiter");
    format!(r#"{wire},"{injected_field}":"caller-controlled"}}"#)
}

pub(crate) fn v5_broker_admission_backend(
    fixture: &V5BrokerAdmissionFixture,
) -> LedgerV5DispatchAdmissionBackend<'_> {
    LedgerV5DispatchAdmissionBackend::from_prevalidated_startup(
        &fixture.store,
        &fixture.authority,
        &fixture.admission_key,
        &fixture.admission_signer,
        &fixture.checkpoint_key,
        &fixture.checkpoint_signer,
    )
    .expect("inject distinct V5 admission and checkpoint dependencies")
}

#[test]
fn protected_v5_admission_wire_accepts_only_closed_canonical_identity_and_seals() {
    let fixture = v5_broker_admission_fixture();
    let broker = v5_broker_admission_backend(&fixture);
    let wire = v5_broker_admission_wire(
        "123e4567-e89b-12d3-a456-426614174000",
        &fixture.run_id.to_string(),
        &fixture.v5_envelope_digest,
    );

    let parsed = parse_v5_dispatch_admission_request(wire.as_bytes())
        .expect("the exact closed V5 identity wire must parse");
    assert_eq!(parsed, v5_broker_admission_request(&fixture));

    let outcome = handle_v5_dispatch_admission_wire(&broker, wire.as_bytes())
        .expect("the parsed V5 request must reach the startup-bound backend");
    assert!(matches!(
        outcome,
        BrokerV5DispatchAdmissionDisposition::Sealed(_)
    ));
    assert_eq!(v5_broker_admission_receipt_count(&fixture), 1);
    assert_eq!(v5_broker_checkpoint_count(&fixture), 1);
    assert_eq!(
        fixture.store.event_count().expect("count sealed V5 tape"),
        7
    );
}

#[test]
fn protected_v5_admission_wire_rejects_injected_authority_fields_before_tape_mutation() {
    let fixture = v5_broker_admission_fixture();
    let broker = v5_broker_admission_backend(&fixture);

    for injected_field in [
        "authority",
        "admission_signing_key",
        "checkpoint_signing_key",
        "signer",
        "trusted_keys",
        "authority_realm",
        "source_dispatch_event_id",
        "workspace",
    ] {
        let wire = v5_broker_admission_wire_with_injected_field(&fixture, injected_field);
        assert!(
            matches!(
                handle_v5_dispatch_admission_wire(&broker, wire.as_bytes()),
                Err(V5DispatchAdmissionHandlerError::RequestRejected)
            ),
            "{injected_field} must be rejected by the closed V5 wire before backend entry"
        );
        assert_eq!(v5_broker_admission_receipt_count(&fixture), 0);
        assert_eq!(v5_broker_checkpoint_count(&fixture), 0);
        assert_eq!(
            fixture
                .store
                .event_count()
                .expect("count unchanged V5 tape"),
            5
        );
    }
}

#[test]
fn protected_v5_admission_wire_rejects_missing_and_noncanonical_ids_before_tape_mutation() {
    let fixture = v5_broker_admission_fixture();
    let broker = v5_broker_admission_backend(&fixture);
    let canonical_request_id = "123e4567-e89b-12d3-a456-426614174000";
    let canonical_run_id = fixture.run_id.to_string();
    let canonical_v5_envelope_digest = fixture.v5_envelope_digest.clone();

    let malformed_wires = [
        (
            "missing request_id",
            format!(
                r#"{{"run_id":"{canonical_run_id}","v5_envelope_digest":"{canonical_v5_envelope_digest}"}}"#
            ),
        ),
        (
            "missing run_id",
            format!(
                r#"{{"request_id":"{canonical_request_id}","v5_envelope_digest":"{canonical_v5_envelope_digest}"}}"#
            ),
        ),
        (
            "missing v5_envelope_digest",
            format!(r#"{{"request_id":"{canonical_request_id}","run_id":"{canonical_run_id}"}}"#),
        ),
        (
            "noncanonical request_id",
            v5_broker_admission_wire(
                "123E4567-e89b-12d3-a456-426614174000",
                &canonical_run_id,
                &canonical_v5_envelope_digest,
            ),
        ),
        (
            "noncanonical run_id",
            v5_broker_admission_wire(
                canonical_request_id,
                "123E4567-e89b-12d3-a456-426614174000",
                &canonical_v5_envelope_digest,
            ),
        ),
        (
            "noncanonical v5_envelope_digest",
            v5_broker_admission_wire(
                canonical_request_id,
                &canonical_run_id,
                "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            ),
        ),
    ];

    for (label, wire) in malformed_wires {
        assert!(
            matches!(
                handle_v5_dispatch_admission_wire(&broker, wire.as_bytes()),
                Err(V5DispatchAdmissionHandlerError::RequestRejected)
            ),
            "{label} must be rejected before backend entry"
        );
        assert_eq!(v5_broker_admission_receipt_count(&fixture), 0);
        assert_eq!(v5_broker_checkpoint_count(&fixture), 0);
        assert_eq!(
            fixture
                .store
                .event_count()
                .expect("count unchanged V5 tape"),
            5
        );
    }
}

#[test]
fn protected_v5_admission_wire_returns_reconciliation_for_wrong_run_and_unknown_digest() {
    let fixture = v5_broker_admission_fixture();
    let broker = v5_broker_admission_backend(&fixture);
    let request_id = "123e4567-e89b-12d3-a456-426614174000";
    let wrong_run = RunId::new().to_string();

    for (label, wire) in [
        (
            "wrong run",
            v5_broker_admission_wire(request_id, &wrong_run, &fixture.v5_envelope_digest),
        ),
        (
            "unknown digest",
            v5_broker_admission_wire(
                request_id,
                &fixture.run_id.to_string(),
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ),
        ),
    ] {
        assert!(
            matches!(
                handle_v5_dispatch_admission_wire(&broker, wire.as_bytes()),
                Ok(BrokerV5DispatchAdmissionDisposition::ReconciliationRequired)
            ),
            "{label} must reconcile without granting or writing"
        );
        assert_eq!(v5_broker_admission_receipt_count(&fixture), 0);
        assert_eq!(v5_broker_checkpoint_count(&fixture), 0);
        assert_eq!(
            fixture
                .store
                .event_count()
                .expect("count unchanged V5 tape"),
            5
        );
    }
}

#[cfg(target_os = "linux")]
#[test]
fn protected_v5_authenticated_handler_rejects_same_uid_before_consuming_its_frame() {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    let fixture = v5_broker_admission_fixture();
    let broker = v5_broker_admission_backend(&fixture);
    let broker_uid = unsafe { libc::geteuid() };
    let configured_worker_uid = broker_uid.checked_add(1).unwrap_or(broker_uid - 1);
    let policy = BrokerHostConfinementPolicyV1::new(broker_uid, [configured_worker_uid])
        .expect("a distinct configured worker identity is valid");
    let attestation = policy
        .attest_current_broker_process()
        .expect("the test process is the configured broker identity");
    let (mut broker_stream, mut same_uid_worker_stream) =
        UnixStream::pair().expect("create a local Unix socket pair");
    let payload = v5_broker_admission_wire(
        "123e4567-e89b-12d3-a456-426614174000",
        &fixture.run_id.to_string(),
        &fixture.v5_envelope_digest,
    )
    .into_bytes();
    let mut frame = u32::try_from(payload.len())
        .expect("the canonical V5 fixture fits the bounded frame")
        .to_be_bytes()
        .to_vec();
    frame.extend_from_slice(&payload);
    same_uid_worker_stream
        .write_all(&frame)
        .expect("queue a valid-looking V5 framed request");

    assert!(matches!(
        super::v5_dispatch_admission::handle_authenticated_v5_dispatch_admission_request(
            &policy,
            &attestation,
            &mut broker_stream,
            &broker,
        ),
        Err(V5DispatchAdmissionHandlerError::PeerRejected)
    ));
    assert_eq!(
        fixture
            .store
            .event_count()
            .expect("count unchanged V5 tape"),
        5
    );
    assert_eq!(v5_broker_admission_receipt_count(&fixture), 0);
    assert_eq!(v5_broker_checkpoint_count(&fixture), 0);

    broker_stream
        .set_read_timeout(Some(Duration::from_millis(250)))
        .expect("bound an assertion failure if the gate consumed the frame");
    let mut observed = vec![0; frame.len()];
    broker_stream
        .read_exact(&mut observed)
        .expect("peer authentication must fail before any frame byte is read");
    assert_eq!(observed, frame);
}

#[cfg(target_os = "linux")]
#[test]
fn protected_v5_framed_handler_rejects_trailing_data_before_any_ledger_mutation() {
    use std::io::Write;
    use std::net::Shutdown;
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    for trailing in [b"trailing".to_vec(), {
        let mut second = 2_u32.to_be_bytes().to_vec();
        second.extend_from_slice(b"{}");
        second
    }] {
        let fixture = v5_broker_admission_fixture();
        let broker = v5_broker_admission_backend(&fixture);
        let (mut broker_stream, mut client_stream) =
            UnixStream::pair().expect("create local Unix socket pair");
        let payload = v5_broker_admission_wire(
            "123e4567-e89b-12d3-a456-426614174000",
            &fixture.run_id.to_string(),
            &fixture.v5_envelope_digest,
        );
        let mut frame = (payload.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(payload.as_bytes());
        frame.extend_from_slice(&trailing);
        client_stream
            .write_all(&frame)
            .expect("request plus trailing frame");
        client_stream
            .shutdown(Shutdown::Write)
            .expect("single request EOF");

        assert!(
            super::v5_dispatch_admission::handle_v5_dispatch_admission_framed_with_binding_for_test(
                &mut broker_stream,
                &broker,
                fixture.run_id,
                Duration::from_millis(250),
            )
            .is_err()
        );
        assert_eq!(v5_broker_admission_receipt_count(&fixture), 0);
        assert_eq!(v5_broker_checkpoint_count(&fixture), 0);
        assert_eq!(fixture.store.event_count().expect("unchanged tape"), 5);
    }
}

#[test]
fn broker_v5_dispatch_admission_records_and_seals_real_v5_source_evidence() {
    let fixture = v5_broker_admission_fixture();
    let broker = LedgerV5DispatchAdmissionBackend::from_prevalidated_startup(
        &fixture.store,
        &fixture.authority,
        &fixture.admission_key,
        &fixture.admission_signer,
        &fixture.checkpoint_key,
        &fixture.checkpoint_signer,
    )
    .expect("inject distinct V5 admission and checkpoint dependencies");

    let outcome = broker.record_then_exact_seal(v5_broker_admission_request(&fixture));

    let sealed = match outcome {
        BrokerV5DispatchAdmissionDisposition::Sealed(sealed) => sealed,
        BrokerV5DispatchAdmissionDisposition::ReconciliationRequired => {
            panic!("valid V5 source evidence must seal")
        }
    };
    assert_eq!(sealed.run_id, fixture.run_id);
    assert_eq!(
        sealed.source_dispatch_event_id,
        fixture.source_dispatch_event_id
    );
    assert_eq!(sealed.v5_envelope_digest, fixture.v5_envelope_digest);
    assert_ne!(
        sealed.admission_event_id, fixture.source_dispatch_event_id,
        "the host receipt must be distinct from the source dispatch"
    );
    assert_eq!(v5_broker_admission_receipt_count(&fixture), 1);
    assert_eq!(v5_broker_checkpoint_count(&fixture), 1);
    assert_eq!(
        fixture.store.event_count().expect("count sealed V5 tape"),
        7
    );
}

#[test]
fn broker_v5_dispatch_admission_exact_retry_returns_the_same_sealed_evidence() {
    let fixture = v5_broker_admission_fixture();
    let broker = LedgerV5DispatchAdmissionBackend::from_prevalidated_startup(
        &fixture.store,
        &fixture.authority,
        &fixture.admission_key,
        &fixture.admission_signer,
        &fixture.checkpoint_key,
        &fixture.checkpoint_signer,
    )
    .expect("inject distinct V5 admission and checkpoint dependencies");

    let first = broker.record_then_exact_seal(v5_broker_admission_request(&fixture));
    let retry = broker.record_then_exact_seal(v5_broker_admission_request(&fixture));

    assert!(matches!(
        first,
        BrokerV5DispatchAdmissionDisposition::Sealed(_)
    ));
    assert_eq!(retry, first, "retry must reuse the exact sealed evidence");
    assert_eq!(v5_broker_admission_receipt_count(&fixture), 1);
    assert_eq!(v5_broker_checkpoint_count(&fixture), 1);
    assert_eq!(
        fixture.store.event_count().expect("count stable V5 tape"),
        7
    );
}

#[test]
fn broker_v5_dispatch_admission_rejects_duplicate_verified_sources_by_digest() {
    let fixture = v5_broker_admission_fixture();
    append_matching_v5_source(
        &fixture,
        Some(&fixture.source_key),
        Some(&fixture.source_signer),
    );
    let broker = v5_broker_admission_backend(&fixture);

    assert!(matches!(
        broker.record_then_exact_seal(v5_broker_admission_request(&fixture)),
        BrokerV5DispatchAdmissionDisposition::ReconciliationRequired
    ));
    assert_eq!(v5_broker_admission_receipt_count(&fixture), 0);
    assert_eq!(v5_broker_checkpoint_count(&fixture), 0);
}

#[test]
fn broker_v5_dispatch_admission_ignores_unsigned_matching_source_poisoning() {
    let fixture = v5_broker_admission_fixture();
    append_matching_v5_source(&fixture, None, None);
    let broker = v5_broker_admission_backend(&fixture);

    let outcome = broker.record_then_exact_seal(v5_broker_admission_request(&fixture));
    assert!(
        matches!(outcome, BrokerV5DispatchAdmissionDisposition::Sealed(_)),
        "unexpected V5 admission outcome: {outcome:?}"
    );
    assert_eq!(v5_broker_admission_receipt_count(&fixture), 1);
    assert_eq!(v5_broker_checkpoint_count(&fixture), 1);
}

#[test]
fn broker_v5_dispatch_admission_ignores_unsigned_noncanonical_digest_poisoning() {
    let fixture = v5_broker_admission_fixture();
    let mut forged = matching_v5_source_event(&fixture);
    let Payload::DispatchEnvelopeV5(dispatch) = &mut forged.payload else {
        panic!("matching V5 source fixture must carry a V5 envelope");
    };
    dispatch.dispatch_v4.dispatch_v3.body.base_commit_sha = "2".repeat(40);
    fixture
        .store
        .conn_for_tests()
        .execute(
            "INSERT INTO events (
                id, run_id, parent_event_id, schema_version, kind, occurred_at, payload
             ) VALUES (?1, ?2, NULL, ?3, 'dispatch_envelope_v5', ?4, ?5)",
            rusqlite::params![
                forged.id.to_string(),
                forged.run_id.to_string(),
                forged.schema_version,
                forged
                    .occurred_at
                    .to_rfc3339_opts(SecondsFormat::Millis, true),
                serde_json::to_string(&forged.payload).expect("serialize forged V5 source"),
            ],
        )
        .expect("inject unsigned V5 source with forged embedded digest");
    let broker = v5_broker_admission_backend(&fixture);

    let outcome = broker.record_then_exact_seal(v5_broker_admission_request(&fixture));
    assert!(
        matches!(outcome, BrokerV5DispatchAdmissionDisposition::Sealed(_)),
        "unsigned noncanonical copy must not poison verified V5 admission: {outcome:?}"
    );
    assert_eq!(v5_broker_admission_receipt_count(&fixture), 1);
    assert_eq!(v5_broker_checkpoint_count(&fixture), 1);
}

#[test]
fn broker_v5_dispatch_admission_ignores_wrong_role_matching_source_poisoning() {
    let fixture = v5_broker_admission_fixture();
    append_matching_v5_source(
        &fixture,
        Some(&fixture.admission_key),
        Some(&fixture.admission_signer),
    );
    let broker = v5_broker_admission_backend(&fixture);

    let outcome = broker.record_then_exact_seal(v5_broker_admission_request(&fixture));
    assert!(
        matches!(outcome, BrokerV5DispatchAdmissionDisposition::Sealed(_)),
        "unexpected wrong-role V5 admission outcome: {outcome:?}"
    );
    assert_eq!(v5_broker_admission_receipt_count(&fixture), 1);
    assert_eq!(v5_broker_checkpoint_count(&fixture), 1);
}

#[test]
fn broker_v5_dispatch_admission_ignores_invalid_signature_matching_source_poisoning() {
    let fixture = v5_broker_admission_fixture();
    let duplicate = matching_v5_source_event(&fixture);
    fixture
        .store
        .append(&duplicate)
        .expect("append matching V5 source before detached signature");
    let invalid = sign_event(
        &duplicate,
        &fixture.admission_key,
        &fixture.source_signer,
        Utc::now(),
    )
    .expect("construct a structurally valid but cryptographically invalid source signature");
    fixture
        .store
        .append_event_signature(&invalid)
        .expect("append invalid detached signature fixture");
    let broker = v5_broker_admission_backend(&fixture);

    assert!(matches!(
        broker.record_then_exact_seal(v5_broker_admission_request(&fixture)),
        BrokerV5DispatchAdmissionDisposition::Sealed(_)
    ));
    assert_eq!(v5_broker_admission_receipt_count(&fixture), 1);
    assert_eq!(v5_broker_checkpoint_count(&fixture), 1);
}

#[test]
fn broker_v5_dispatch_admission_ignores_unsupported_signature_matching_source_poisoning() {
    let fixture = v5_broker_admission_fixture();
    let duplicate = matching_v5_source_event(&fixture);
    fixture
        .store
        .append(&duplicate)
        .expect("append matching V5 source before unsupported signature");
    let signature = sign_event(
        &duplicate,
        &fixture.source_key,
        &fixture.source_signer,
        Utc::now(),
    )
    .expect("construct source signature fixture");
    fixture
        .store
        .conn_for_tests()
        .execute(
            "INSERT INTO event_signatures (
                event_id, canonical_event_hash, actor_id, key_id,
                public_key_hash, algorithm, signature, signed_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'unsupported-v1', ?6, ?7)",
            rusqlite::params![
                signature.event_id.to_string(),
                signature.canonical_event_hash,
                signature.signer.actor_id,
                signature.signer.key_id,
                signature.signer.public_key_hash,
                signature.signature,
                signature
                    .signed_at
                    .to_rfc3339_opts(SecondsFormat::Millis, true),
            ],
        )
        .expect("append unsupported detached signature fixture");
    let broker = v5_broker_admission_backend(&fixture);

    let outcome = broker.record_then_exact_seal(v5_broker_admission_request(&fixture));
    assert!(
        matches!(outcome, BrokerV5DispatchAdmissionDisposition::Sealed(_)),
        "unexpected unsupported-signature V5 admission outcome: {outcome:?}"
    );
    assert_eq!(v5_broker_admission_receipt_count(&fixture), 1);
    assert_eq!(v5_broker_checkpoint_count(&fixture), 1);
}

#[test]
fn broker_v5_digest_resolution_verifies_only_indexed_candidates_on_a_large_run() {
    let fixture = v5_broker_admission_fixture();
    let (unrelated, _) = fixture
        .store
        .signed_events_for_run(&fixture.run_id.to_string())
        .expect("read V5 fixture tape")
        .into_iter()
        .find(|(event, _)| event.id != fixture.source_dispatch_event_id)
        .expect("find unrelated signed event");
    for _ in 0..512 {
        fixture
            .store
            .append_signed(
                &Event {
                    id: EventId::new(),
                    occurred_at: Utc::now(),
                    ..unrelated.clone()
                },
                &fixture.source_key,
                &fixture.source_signer,
            )
            .expect("append unrelated signed event");
    }
    let template = matching_v5_source_event(&fixture);
    let unrelated_run = RunId::new();
    let unrelated_digest = authority_broker_digest('8');
    let tx = fixture
        .store
        .conn_for_tests()
        .unchecked_transaction()
        .expect("begin unrelated V5 flood");
    for _ in 0..1_000 {
        let wrong_run = Event {
            id: EventId::new(),
            run_id: unrelated_run,
            occurred_at: Utc::now(),
            ..template.clone()
        };
        let wrong_run_signature = sign_event(
            &wrong_run,
            &fixture.source_key,
            &fixture.source_signer,
            Utc::now(),
        )
        .expect("sign wrong-run V5 row");
        insert_v5_flood_event(&tx, &wrong_run, Some((&wrong_run_signature, "ed25519")));

        let mut wrong_digest = Event {
            id: EventId::new(),
            occurred_at: Utc::now(),
            ..template.clone()
        };
        let Payload::DispatchEnvelopeV5(dispatch) = &mut wrong_digest.payload else {
            panic!("V5 template payload");
        };
        dispatch.envelope_digest = unrelated_digest.clone();
        let mut wrong_digest_signature = sign_event(
            &template,
            &fixture.source_key,
            &fixture.source_signer,
            Utc::now(),
        )
        .expect("sign source template for wrong-digest metadata row");
        wrong_digest_signature.event_id = wrong_digest.id;
        insert_v5_flood_event(
            &tx,
            &wrong_digest,
            Some((&wrong_digest_signature, "ed25519")),
        );
    }
    tx.commit().expect("commit unrelated V5 flood");
    fixture
        .store
        .reset_v5_source_candidate_verification_count_for_tests();
    let query_plan = fixture
        .store
        .v5_source_scan_query_plan_for_tests(
            fixture.run_id,
            &fixture.v5_envelope_digest,
            &fixture.authority,
        )
        .expect("explain exact production V5 source scan");
    assert!(
        query_plan
            .iter()
            .any(|detail| detail.contains("idx_governed_dispatch_v5_signature_scan_exact")),
        "V5 resolver query must use signer predicates and the rowid cursor index: {query_plan:?}"
    );
    assert!(
        query_plan
            .iter()
            .any(|detail| detail.contains("sqlite_autoindex_event_signatures_1"))
            && query_plan
                .iter()
                .any(|detail| detail.contains("sqlite_autoindex_events_1")),
        "the bounded signer batch must join append-only signature and event rows by their unique identities: {query_plan:?}"
    );
    let broker = v5_broker_admission_backend(&fixture);

    let mut sealed = false;
    for _ in 0..=16 {
        if matches!(
            broker.record_then_exact_seal(v5_broker_admission_request(&fixture)),
            BrokerV5DispatchAdmissionDisposition::Sealed(_)
        ) {
            sealed = true;
            break;
        }
    }
    assert!(
        sealed,
        "bounded signer scan must eventually pass unrelated rows"
    );
    assert_eq!(
        fixture
            .store
            .v5_source_candidate_verification_count_for_tests(),
        1,
        "unrelated events must not trigger signature loading or cryptographic verification"
    );
    assert_eq!(
        fixture.store.v5_source_candidate_loaded_count_for_tests(),
        2,
        "only the exact run+digest event bootstrap and candidate row may consume keyed budget"
    );
}

#[test]
fn broker_v5_digest_resolution_sql_filters_large_unsigned_and_wrong_role_floods() {
    let fixture = v5_broker_admission_fixture();
    let template = matching_v5_source_event(&fixture);
    let tx = fixture
        .store
        .conn_for_tests()
        .unchecked_transaction()
        .expect("begin flood fixture transaction");
    for _ in 0..1_000 {
        let unsigned = Event {
            id: EventId::new(),
            occurred_at: Utc::now(),
            ..template.clone()
        };
        insert_v5_flood_event(&tx, &unsigned, None);
        let wrong_role = Event {
            id: EventId::new(),
            occurred_at: Utc::now(),
            ..template.clone()
        };
        let signature = sign_event(
            &wrong_role,
            &fixture.admission_key,
            &fixture.admission_signer,
            Utc::now(),
        )
        .expect("sign wrong-role flood event");
        insert_v5_flood_event(&tx, &wrong_role, Some((&signature, "ed25519")));
        let unsupported = Event {
            id: EventId::new(),
            occurred_at: Utc::now(),
            ..template.clone()
        };
        let unsupported_signature = sign_event(
            &unsupported,
            &fixture.source_key,
            &fixture.source_signer,
            Utc::now(),
        )
        .expect("sign unsupported-algorithm flood event");
        insert_v5_flood_event(
            &tx,
            &unsupported,
            Some((&unsupported_signature, "future-signature-v9")),
        );
    }
    tx.commit().expect("commit flood fixture transaction");
    fixture
        .store
        .reset_v5_source_candidate_verification_count_for_tests();
    let broker = v5_broker_admission_backend(&fixture);

    let mut sealed = false;
    for _ in 0..=64 {
        if matches!(
            broker.record_then_exact_seal(v5_broker_admission_request(&fixture)),
            BrokerV5DispatchAdmissionDisposition::Sealed(_)
        ) {
            sealed = true;
            break;
        }
    }
    assert!(
        sealed,
        "finite same-digest metadata must not poison resolution"
    );
    assert!(
        fixture.store.v5_source_candidate_loaded_count_for_tests()
            <= u64::try_from(fixture.store.v5_source_scan_batch_limit_for_tests())
                .expect("batch fits u64")
    );
    assert_eq!(
        fixture
            .store
            .v5_source_candidate_verification_count_for_tests(),
        1
    );
}

#[test]
fn broker_v5_digest_resolution_makes_bounded_monotonic_progress_through_exact_signer_floods() {
    let fixture = v5_broker_admission_fixture_with_exact_signer_flood_before_source(1_000);
    let template = matching_v5_source_event(&fixture);
    let tx = fixture
        .store
        .conn_for_tests()
        .unchecked_transaction()
        .expect("begin post-source exact-signer flood transaction");
    for _ in 0..1_000 {
        let duplicate = Event {
            id: EventId::new(),
            occurred_at: Utc::now(),
            ..template.clone()
        };
        let mut invalid = sign_event(
            &duplicate,
            &fixture.admission_key,
            &fixture.source_signer,
            Utc::now(),
        )
        .expect("construct invalid exact-signer signature");
        invalid.signer = fixture.source_signer.clone();
        insert_v5_flood_event(&tx, &duplicate, Some((&invalid, "ed25519")));
    }
    tx.commit()
        .expect("commit post-source exact-signer flood transaction");
    let broker = v5_broker_admission_backend(&fixture);
    let tape_before_admission = fixture.store.event_count().expect("count flooded tape");
    let batch_limit = fixture.store.v5_source_scan_batch_limit_for_tests();
    let mut previous_cursor = 0_i64;
    let mut sealed = false;

    for _ in 0..=80 {
        fixture
            .store
            .reset_v5_source_candidate_verification_count_for_tests();
        let outcome = broker.record_then_exact_seal(v5_broker_admission_request(&fixture));
        assert!(
            fixture.store.v5_source_candidate_loaded_count_for_tests()
                <= u64::try_from(batch_limit).expect("batch limit fits u64")
        );
        assert!(
            fixture
                .store
                .v5_source_candidate_verification_count_for_tests()
                <= u64::try_from(batch_limit).expect("batch limit fits u64")
        );
        let (cursor, observed_high_water, complete_through, ambiguous, candidate) = fixture
            .store
            .v5_source_projection_state_for_tests(
                fixture.run_id,
                &fixture.v5_envelope_digest,
                &fixture.authority,
            )
            .expect("read durable V5 source scan projection")
            .expect("projection exists after first retry");
        assert!(
            cursor >= previous_cursor,
            "projection cursor must not regress"
        );
        assert!(cursor <= observed_high_water);
        assert!(!ambiguous);
        previous_cursor = cursor;

        if matches!(outcome, BrokerV5DispatchAdmissionDisposition::Sealed(_)) {
            assert_eq!(complete_through, Some(observed_high_water));
            assert_eq!(candidate, Some(fixture.source_dispatch_event_id));
            sealed = true;
            break;
        }
        assert!(matches!(
            outcome,
            BrokerV5DispatchAdmissionDisposition::ReconciliationRequired
        ));
        assert_eq!(
            fixture.store.event_count().expect("unchanged tape"),
            tape_before_admission,
            "projection retries must not append tape evidence before the authoritative scan completes"
        );
        assert_eq!(v5_broker_admission_receipt_count(&fixture), 0);
        assert_eq!(v5_broker_checkpoint_count(&fixture), 0);
    }

    assert!(
        sealed,
        "finite forged rows must not permanently poison resolution"
    );
    assert_eq!(v5_broker_admission_receipt_count(&fixture), 1);
    assert_eq!(v5_broker_checkpoint_count(&fixture), 1);
}

#[test]
fn broker_v5_source_projection_corruption_fails_closed_without_tape_mutation() {
    let fixture = v5_broker_admission_fixture();
    let before = fixture.store.event_count().expect("count source tape");
    fixture
        .store
        .resolve_unique_governed_dispatch_v5_source_by_digest_v1(
            fixture.run_id,
            &fixture.v5_envelope_digest,
            &fixture.authority,
        )
        .expect("complete one-row authoritative projection");
    fixture
        .store
        .conn_for_tests()
        .execute(
            "UPDATE governed_dispatch_v5_source_scans
             SET candidate_event_digest = ?1",
            rusqlite::params![authority_broker_digest('0')],
        )
        .expect("corrupt mutable scan cache");
    let broker = v5_broker_admission_backend(&fixture);

    assert!(matches!(
        broker.record_then_exact_seal(v5_broker_admission_request(&fixture)),
        BrokerV5DispatchAdmissionDisposition::ReconciliationRequired
    ));
    assert_eq!(fixture.store.event_count().expect("unchanged tape"), before);
    assert_eq!(v5_broker_admission_receipt_count(&fixture), 0);
    assert_eq!(v5_broker_checkpoint_count(&fixture), 0);
}

#[test]
fn broker_v5_post_schema_signatures_are_indexed_and_scan_index_is_immutable() {
    let fixture = v5_broker_admission_fixture();
    let duplicate = matching_v5_source_event(&fixture);
    fixture
        .store
        .append(&duplicate)
        .expect("append post-schema unsigned V5 source");
    let signature = sign_event(
        &duplicate,
        &fixture.source_key,
        &fixture.source_signer,
        Utc::now(),
    )
    .expect("sign post-schema V5 source");
    fixture
        .store
        .append_event_signature(&signature)
        .expect("append post-schema detached signature");
    let indexed: i64 = fixture
        .store
        .conn_for_tests()
        .query_row(
            "SELECT COUNT(*)
             FROM governed_dispatch_v5_signature_scan_index
             WHERE event_id = ?1 AND signature_rowid > 0",
            rusqlite::params![duplicate.id.to_string()],
            |row| row.get(0),
        )
        .expect("query append-derived V5 scan index");
    assert_eq!(indexed, 1);
    assert!(
        fixture
            .store
            .conn_for_tests()
            .execute(
                "UPDATE governed_dispatch_v5_signature_scan_index
                 SET actor_id = 'attacker'",
                [],
            )
            .is_err(),
        "append-derived scan rows must reject update"
    );
    assert!(
        fixture
            .store
            .conn_for_tests()
            .execute("DELETE FROM governed_dispatch_v5_signature_scan_index", [])
            .is_err(),
        "append-derived scan rows must reject delete"
    );
}

#[test]
fn broker_v5_missing_scan_trigger_or_index_fails_closed_without_tape_mutation() {
    for schema_object in [
        "DROP TRIGGER governed_dispatch_v5_signature_scan_after_insert",
        "DROP INDEX idx_governed_dispatch_v5_signature_scan_exact",
    ] {
        let fixture = v5_broker_admission_fixture();
        let before = fixture.store.event_count().expect("count source tape");
        fixture
            .store
            .conn_for_tests()
            .execute_batch(schema_object)
            .expect("corrupt required scan schema");
        let broker = v5_broker_admission_backend(&fixture);

        assert!(matches!(
            broker.record_then_exact_seal(v5_broker_admission_request(&fixture)),
            BrokerV5DispatchAdmissionDisposition::ReconciliationRequired
        ));
        assert_eq!(fixture.store.event_count().expect("unchanged tape"), before);
        assert_eq!(v5_broker_admission_receipt_count(&fixture), 0);
        assert_eq!(v5_broker_checkpoint_count(&fixture), 0);
    }
}

#[test]
fn broker_v5_semantically_substituted_scan_schema_fails_closed_without_tape_mutation() {
    let substitutions = [
        (
            "after-insert no-op",
            "DROP TRIGGER governed_dispatch_v5_signature_scan_after_insert;
             CREATE TRIGGER governed_dispatch_v5_signature_scan_after_insert
             AFTER INSERT ON event_signatures
             BEGIN SELECT NEW.rowid; END;",
        ),
        (
            "update marker without abort",
            "DROP TRIGGER governed_dispatch_v5_signature_scan_no_update;
             CREATE TRIGGER governed_dispatch_v5_signature_scan_no_update
             BEFORE UPDATE ON governed_dispatch_v5_signature_scan_index
             BEGIN SELECT 'UPDATE forbidden'; END;",
        ),
        (
            "delete marker without abort",
            "DROP TRIGGER governed_dispatch_v5_signature_scan_no_delete;
             CREATE TRIGGER governed_dispatch_v5_signature_scan_no_delete
             BEFORE DELETE ON governed_dispatch_v5_signature_scan_index
             BEGIN SELECT 'DELETE forbidden'; END;",
        ),
        (
            "weakened exact index",
            "DROP INDEX idx_governed_dispatch_v5_signature_scan_exact;
             CREATE INDEX idx_governed_dispatch_v5_signature_scan_exact
             ON governed_dispatch_v5_signature_scan_index(
                 v5_envelope_digest,
                 signature_rowid
             );",
        ),
        (
            "lexical token-boundary collision",
            "DROP TRIGGER governed_dispatch_v5_signature_scan_after_insert;
             DROP TRIGGER governed_dispatch_v5_signature_scan_no_update;
             DROP TRIGGER governed_dispatch_v5_signature_scan_no_delete;
             DROP INDEX idx_governed_dispatch_v5_signature_scan_exact;
             DROP TABLE governed_dispatch_v5_signature_scan_index;
             CREATE TABLE governed_dispatch_v5_signature_scan_index (
                 signature_rowid INTEGERPRIMARYKEY CHECK(signature_rowid > 0),
                 event_rowid INTEGERNOTNULL CHECK(event_rowid > 0),
                 event_id TEXTNOTNULLUNIQUE,
                 run_id TEXTNOTNULL,
                 v5_envelope_digest TEXTNOTNULL,
                 actor_id TEXTNOTNULL,
                 key_id TEXTNOTNULL,
                 public_key_hash TEXT,
                 algorithm TEXTNOTNULL,
                 FOREIGN KEY(event_id) REFERENCES events(id)
             );
             CREATE INDEX idx_governed_dispatch_v5_signature_scan_exact
             ON governed_dispatch_v5_signature_scan_index(
                 run_id, v5_envelope_digest, actor_id, key_id,
                 public_key_hash, algorithm, signature_rowid
             );
             CREATE TRIGGER governed_dispatch_v5_signature_scan_after_insert
             AFTER INSERT ON event_signatures
             BEGIN
                 INSERT INTO governed_dispatch_v5_signature_scan_index (
                     signature_rowid, event_rowid, event_id, run_id,
                     v5_envelope_digest, actor_id, key_id,
                     public_key_hash, algorithm
                 )
                 SELECT NEW.rowid, e.rowid, e.id, e.run_id,
                        json_extract(e.payload, '$.DispatchEnvelopeV5.envelope_digest'),
                        NEW.actor_id, NEW.key_id, NEW.public_key_hash, NEW.algorithm
                 FROM events e
                 WHERE e.id = NEW.event_id AND e.kind = 'dispatch_envelope_v5';
             END;
             CREATE TRIGGER governed_dispatch_v5_signature_scan_no_update
             BEFORE UPDATE ON governed_dispatch_v5_signature_scan_index
             BEGIN
                 SELECT RAISE(ABORT, 'V5 signature scan index is append-derived: UPDATE forbidden');
             END;
             CREATE TRIGGER governed_dispatch_v5_signature_scan_no_delete
             BEFORE DELETE ON governed_dispatch_v5_signature_scan_index
             BEGIN
                 SELECT RAISE(ABORT, 'V5 signature scan index is append-derived: DELETE forbidden');
             END;",
        ),
    ];

    for (name, substitution) in substitutions {
        let fixture = v5_broker_admission_fixture();
        let before = fixture.store.event_count().expect("count source tape");
        fixture
            .store
            .conn_for_tests()
            .execute_batch(substitution)
            .unwrap_or_else(|error| panic!("install {name} substitution: {error}"));
        let broker = v5_broker_admission_backend(&fixture);

        assert!(
            matches!(
                broker.record_then_exact_seal(v5_broker_admission_request(&fixture)),
                BrokerV5DispatchAdmissionDisposition::ReconciliationRequired
            ),
            "{name} substitution must fail closed"
        );
        assert_eq!(
            fixture.store.event_count().expect("unchanged tape"),
            before,
            "{name} substitution must not append tape evidence"
        );
        assert_eq!(v5_broker_admission_receipt_count(&fixture), 0);
        assert_eq!(v5_broker_checkpoint_count(&fixture), 0);
    }
}

#[test]
fn broker_v5_scan_schema_guard_accepts_harmless_keyword_case_and_formatting() {
    let fixture = v5_broker_admission_fixture();
    fixture
        .store
        .conn_for_tests()
        .execute_batch(
            "DROP TRIGGER governed_dispatch_v5_signature_scan_no_update;
             create trigger governed_dispatch_v5_signature_scan_no_update
               before    update
               on governed_dispatch_v5_signature_scan_index
             begin
               select raise(abort,
                 'V5 signature scan index is append-derived: UPDATE forbidden');
             end;",
        )
        .expect("replace trigger with semantically identical formatting");
    let broker = v5_broker_admission_backend(&fixture);

    assert!(matches!(
        broker.record_then_exact_seal(v5_broker_admission_request(&fixture)),
        BrokerV5DispatchAdmissionDisposition::Sealed(_)
    ));
    assert_eq!(v5_broker_admission_receipt_count(&fixture), 1);
    assert_eq!(v5_broker_checkpoint_count(&fixture), 1);
}

#[test]
fn broker_v5_later_verified_duplicate_sets_ambiguous_projection_and_reconciles() {
    let fixture = v5_broker_admission_fixture();
    let broker = v5_broker_admission_backend(&fixture);
    assert!(matches!(
        broker.record_then_exact_seal(v5_broker_admission_request(&fixture)),
        BrokerV5DispatchAdmissionDisposition::Sealed(_)
    ));
    append_matching_v5_source(
        &fixture,
        Some(&fixture.source_key),
        Some(&fixture.source_signer),
    );

    assert!(matches!(
        broker.record_then_exact_seal(v5_broker_admission_request(&fixture)),
        BrokerV5DispatchAdmissionDisposition::ReconciliationRequired
    ));
    let (_, _, _, ambiguous, _) = fixture
        .store
        .v5_source_projection_state_for_tests(
            fixture.run_id,
            &fixture.v5_envelope_digest,
            &fixture.authority,
        )
        .expect("read ambiguous projection")
        .expect("projection exists");
    assert!(ambiguous);
    assert_eq!(v5_broker_admission_receipt_count(&fixture), 1);
    assert_eq!(v5_broker_checkpoint_count(&fixture), 1);
}

#[test]
fn broker_v5_dispatch_admission_reconciles_then_retries_without_duplicate_receipt() {
    let fixture = v5_broker_admission_fixture();
    let wrong_checkpoint_key = SigningKey::from_bytes(&[244; 32]);
    let wrong_checkpoint_broker = LedgerV5DispatchAdmissionBackend::from_prevalidated_startup(
        &fixture.store,
        &fixture.authority,
        &fixture.admission_key,
        &fixture.admission_signer,
        &wrong_checkpoint_key,
        &fixture.checkpoint_signer,
    )
    .expect("untrusted but distinct checkpoint key is a runtime reconciliation case");

    assert!(matches!(
        wrong_checkpoint_broker.record_then_exact_seal(v5_broker_admission_request(&fixture)),
        BrokerV5DispatchAdmissionDisposition::ReconciliationRequired
    ));
    assert_eq!(v5_broker_admission_receipt_count(&fixture), 1);
    assert_eq!(v5_broker_checkpoint_count(&fixture), 0);

    let correct_broker = LedgerV5DispatchAdmissionBackend::from_prevalidated_startup(
        &fixture.store,
        &fixture.authority,
        &fixture.admission_key,
        &fixture.admission_signer,
        &fixture.checkpoint_key,
        &fixture.checkpoint_signer,
    )
    .expect("re-create broker with correct checkpoint key");
    assert!(matches!(
        correct_broker.record_then_exact_seal(v5_broker_admission_request(&fixture)),
        BrokerV5DispatchAdmissionDisposition::Sealed(_)
    ));
    assert_eq!(v5_broker_admission_receipt_count(&fixture), 1);
    assert_eq!(v5_broker_checkpoint_count(&fixture), 1);
}

#[test]
fn dedicated_serial_mutation_owner_makes_concurrent_exact_retries_one_receipt_and_checkpoint() {
    let fixture = v5_broker_admission_fixture();
    let request = v5_broker_admission_request(&fixture);
    let (request_tx, request_rx) = std::sync::mpsc::sync_channel(2);
    let first_tx = request_tx.clone();
    let first_request = request.clone();
    let first = std::thread::spawn(move || first_tx.send(first_request).expect("first retry"));
    let second = std::thread::spawn(move || request_tx.send(request).expect("second retry"));
    first.join().expect("first sender");
    second.join().expect("second sender");

    let result = std::thread::spawn(move || {
        let broker = v5_broker_admission_backend(&fixture);
        let mut sealed = 0;
        for _ in 0..2 {
            if matches!(
                broker.record_then_exact_seal(request_rx.recv().expect("queued exact retry")),
                BrokerV5DispatchAdmissionDisposition::Sealed(_)
            ) {
                sealed += 1;
            }
        }
        (
            sealed,
            v5_broker_admission_receipt_count(&fixture),
            v5_broker_checkpoint_count(&fixture),
        )
    })
    .join()
    .expect("dedicated mutation owner");

    assert_eq!(result, (2, 1, 1));
}

#[test]
fn broker_v5_dispatch_admission_reconciles_wrong_run_without_tape_mutation() {
    let fixture = v5_broker_admission_fixture();
    let broker = LedgerV5DispatchAdmissionBackend::from_prevalidated_startup(
        &fixture.store,
        &fixture.authority,
        &fixture.admission_key,
        &fixture.admission_signer,
        &fixture.checkpoint_key,
        &fixture.checkpoint_signer,
    )
    .expect("inject valid V5 dependencies");
    let request = V5DispatchAdmissionRequest {
        request_id: uuid::Uuid::now_v7(),
        run_id: RunId::new(),
        v5_envelope_digest: fixture.v5_envelope_digest.clone(),
    };

    assert!(matches!(
        broker.record_then_exact_seal(request),
        BrokerV5DispatchAdmissionDisposition::ReconciliationRequired
    ));
    assert_eq!(v5_broker_admission_receipt_count(&fixture), 0);
    assert_eq!(v5_broker_checkpoint_count(&fixture), 0);
    assert_eq!(
        fixture
            .store
            .event_count()
            .expect("count unchanged V5 tape"),
        5
    );
}

#[test]
fn protected_v5_host_run_binding_blocks_a_valid_other_run_before_tape_mutation() {
    let fixture = v5_broker_admission_fixture();
    let broker = v5_broker_admission_backend(&fixture);
    let before = fixture.store.event_count().expect("count V5 tape");
    let disposition = super::v5_dispatch_admission::record_v5_admission_for_expected_run(
        &broker,
        v5_broker_admission_request(&fixture),
        RunId::new(),
    );

    assert!(matches!(
        disposition,
        BrokerV5DispatchAdmissionDisposition::ReconciliationRequired
    ));
    assert_eq!(
        fixture
            .store
            .event_count()
            .expect("count unchanged V5 tape"),
        before
    );
    assert_eq!(v5_broker_admission_receipt_count(&fixture), 0);
    assert_eq!(v5_broker_checkpoint_count(&fixture), 0);
}

#[test]
fn broker_v5_dispatch_admission_reconciles_unknown_digest_without_tape_mutation() {
    let fixture = v5_broker_admission_fixture();
    let broker = LedgerV5DispatchAdmissionBackend::from_prevalidated_startup(
        &fixture.store,
        &fixture.authority,
        &fixture.admission_key,
        &fixture.admission_signer,
        &fixture.checkpoint_key,
        &fixture.checkpoint_signer,
    )
    .expect("inject valid V5 dependencies");
    let request = V5DispatchAdmissionRequest {
        request_id: uuid::Uuid::now_v7(),
        run_id: fixture.run_id,
        v5_envelope_digest:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
    };

    assert!(matches!(
        broker.record_then_exact_seal(request),
        BrokerV5DispatchAdmissionDisposition::ReconciliationRequired
    ));
    assert_eq!(v5_broker_admission_receipt_count(&fixture), 0);
    assert_eq!(v5_broker_checkpoint_count(&fixture), 0);
    assert_eq!(
        fixture
            .store
            .event_count()
            .expect("count unchanged V5 tape"),
        5
    );
}

#[test]
fn broker_v5_dispatch_admission_constructor_rejects_shared_key_material_and_signer_identity() {
    let fixture = v5_broker_admission_fixture();

    assert!(matches!(
        LedgerV5DispatchAdmissionBackend::from_prevalidated_startup(
            &fixture.store,
            &fixture.authority,
            &fixture.admission_key,
            &fixture.admission_signer,
            &fixture.admission_key,
            &fixture.checkpoint_signer,
        ),
        Err(V5DispatchAdmissionStartupError::SharedSigningKeyMaterial)
    ));
    assert!(matches!(
        LedgerV5DispatchAdmissionBackend::from_prevalidated_startup(
            &fixture.store,
            &fixture.authority,
            &fixture.admission_key,
            &fixture.admission_signer,
            &fixture.checkpoint_key,
            &fixture.admission_signer,
        ),
        Err(V5DispatchAdmissionStartupError::SharedSignerIdentity)
    ));
}
