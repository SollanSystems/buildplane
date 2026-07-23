use super::promotion_execution::{
    BrokerPromotionExecutionAuthority, BrokerPromotionExecutionRequest,
    BrokerPromotionExecutionStatus, PromotionEffectGateway, PromotionExecutionBackend,
    PromotionExecutionError, PromotionExecutionGrant, PromotionReplaySnapshotVerifier,
    PromotionResultDisposition, TrustedPromotionBinding, TrustedPromotionVerifier,
};
use super::promotion_git::{
    PromotionCapabilityError, PromotionGitError, PromotionGitGateway, PromotionGitOutcome,
    TestFixedGitRunner, TestGitOperation, TestGitOutput, VerifiedPromotionCapability,
};
use super::{
    AuthorityBackend, AuthorityBackendError, AuthorityGrant, BrokerModelActionRequest,
    BrokerModelActionStatus, BrokerModelAuthority, BrokerPromotionDecisionAuthority,
    BrokerPromotionDecisionDisposition, BrokerPromotionDecisionStartupError, CredentialGateway,
    GatewayCompletion, LeasePolicy, PairedGatewayResult, PrivateModelCapability,
    ReplaySnapshotVerifier, ResultDisposition, TrustedReplayBinding,
    TrustedReplayVerificationError, TrustedReplayVerifier,
};
use bp_ledger::canonicalize::canonical_event_hash;
use bp_ledger::event::Event;
use bp_ledger::kind::EventKind;
use bp_ledger::payload::activity_claim::{
    ActivityClaimPurposeV1, ActivityClaimedV1, ActivityHeartbeatRecordedV1,
    ActivityResultOutcomeV1, ActivityResultRecordedV1,
};
use bp_ledger::payload::trust_spine::{
    action_receipt_recorded_v2_digest, action_receipt_set_v1_digest, action_requested_v2_digest,
    candidate_completion_recorded_v1_digest, candidate_view_v1_digest,
    dispatch_envelope_v3_body_digest, dispatch_envelope_v4_digest,
    governed_dispatch_policy_digest_v1, model_action_authorized_v2_digest,
    model_action_intent_v1_digest, review_verdict_output_v1_digest, ActionEvidenceVersionV1,
    ActionFailureV1, ActionKindV1, ActionReceiptOutcomeV2, ActionReceiptRecordedV2,
    ActionReceiptSetEntryV1, ActionReceiptSetRecordedV1, ActionRequestedV2, ActionResourceUsageV1,
    CandidateAcceptanceOutcomeV1, CandidateAcceptanceRecordedV1, CandidateCompletionRecordedV1,
    CandidateCreatedV2, CandidateViewV1, CommitModeV1, DispatchBudgetV1, DispatchEnvelopeBodyV2,
    DispatchEnvelopeV3, DispatchEnvelopeV4, ExecutionRoleV1, ModelActionAuthorizedV2,
    ModelActionCandidateBindingV1, ModelActionIntentV1, ModelRequestEvidenceV1,
    PromotionApprovalRequestedV1, PromotionDecisionKindV1, PromotionExecutionClaimedV1,
    PromotionGitBindingV1, PromotionResultOutcomeV1, PromotionWorktreeSyncStateV1,
    ReviewDecisionV1, ReviewVerdictOutputV1, ReviewVerdictRecordedV2, TrustScopeEvidenceV1,
    TrustTierV1, WorkflowCancellationCauseV1, WorkflowCancellationRequestedV1,
    MODEL_REQUEST_EVIDENCE_V1_SCHEMA_VERSION, TRUST_SCOPE_EVIDENCE_V1_SCHEMA_VERSION,
};
use bp_ledger::payload::Payload;
use bp_ledger::signing::{public_key_hash, ActorKeyRef, TrustedPublicKeys};
use bp_ledger::storage::sqlite::{
    CheckpointPolicy, GovernedCandidateCompletionDispositionV1,
    GovernedCandidateCompletionRequestV1, GovernedPromotionAuthorityV1,
    GovernedPromotionDecisionRequestV1, SqliteStore,
};
use bp_ledger::{EventId, LedgerError, RunId};
use bp_replay::{
    engine::EngineError, reader::ReaderError,
    trusted_recovery::TRUSTED_GOVERNED_RECOVERY_MAX_EVENTS_V1, TrustSpineSignerRole,
    TrustedGovernedRecoveryError, TrustedReplayAuthorities,
};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use ed25519_dalek::SigningKey;
use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;
use tempfile::TempDir;

const MIN_LEASE_MS: u64 = 1_000;
const MAX_LEASE_MS: u64 = 15 * 60 * 1_000;
const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST_C: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const DIGEST_D: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const DIGEST_E: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

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
        lease_duration_ms: u64,
    ) -> Result<AuthorityGrant, AuthorityBackendError> {
        self.state.borrow_mut().authorize_calls.push(AuthorizeCall {
            run_id,
            request: request.clone(),
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
}

struct FakeGateway {
    state: Rc<RefCell<GatewayState>>,
    completion: Option<GatewayCompletion>,
}

impl CredentialGateway for FakeGateway {
    fn invoke(&mut self, capability: PrivateModelCapability) -> PairedGatewayResult {
        self.state.borrow_mut().calls += 1;
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
        &[VerifyCall { run_id, request }]
    );
    assert_eq!(gateway_state.borrow().calls, 1);
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

fn promotion_candidate(
    run_id: RunId,
    dispatch: &DispatchEnvelopeV3,
    receipt_set: &ActionReceiptSetRecordedV1,
) -> CandidateCreatedV2 {
    CandidateCreatedV2 {
        run_id: run_id.to_string(),
        candidate_id: "candidate-promotion-1".into(),
        candidate_ref: "refs/buildplane/candidates/candidate-promotion-1/run-1/1".into(),
        workflow_id: dispatch.body.workflow_id.clone(),
        unit_id: dispatch.body.unit_id.clone(),
        attempt: dispatch.body.attempt,
        provenance_ref: dispatch.body.provenance_ref.clone(),
        candidate_digest: DIGEST_A.into(),
        base_commit_sha: dispatch.body.base_commit_sha.clone(),
        candidate_commit_sha: "2".repeat(40),
        commit_digest: DIGEST_B.into(),
        tree_digest: DIGEST_C.into(),
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
    let candidate_action = append_promotion_action_evidence_with_options(
        &store,
        run_id,
        &dispatch,
        &dispatch_event,
        &kernel_key,
        &kernel,
        "git-candidate-create:candidate-promotion-1/run-1/1",
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

    let candidate_action = append_promotion_action_evidence(
        store,
        run_id,
        &dispatch,
        &dispatch_event,
        kernel_key,
        kernel,
        "git-candidate-create:candidate-promotion-1/run-1/1",
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
    let candidate_action = append_promotion_action_evidence(
        &store,
        run_id,
        &dispatch,
        &dispatch_event,
        &kernel_key,
        &kernel,
        "git-candidate-create:candidate-promotion-1/run-1/1",
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
    let candidate_action = append_promotion_action_evidence(
        &store,
        run_id,
        &dispatch,
        &dispatch_event,
        &kernel_key,
        &kernel,
        "git-candidate-create:candidate-promotion-1/run-1/1",
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
fn native_candidate_completion_rejects_graph_bound_v4_until_native_admission_is_available() {
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
        "V4 dispatches must fail closed until native graph admission is reconstructed: {outcome:?}",
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
    let candidate_action = append_promotion_action_evidence(
        &store,
        run_id,
        &dispatch,
        &dispatch_event,
        &kernel_key,
        &kernel,
        "git-candidate-create:candidate-promotion-1/run-1/1",
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
