//! Durable, candidate-bound promotion-decision coverage.
//!
//! This exercises only the broker-private write-ahead decision and kernel
//! checkpoint boundary. It deliberately does not invoke Git: a sealed
//! decision is recovery evidence, not a target-branch mutation.

use bp_ledger::canonicalize::canonical_event_hash;
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::activity_claim::{
    ActivityClaimPurposeV1, ActivityClaimedV1, ActivityResultOutcomeV1, ActivityResultRecordedV1,
};
use bp_ledger::payload::trust_spine::{
    action_receipt_recorded_v2_digest, action_receipt_set_v1_digest, action_requested_v2_digest,
    attempt_context_recorded_v1_digest, candidate_completion_recorded_v1_digest,
    candidate_view_v1_digest, dispatch_envelope_v3_body_digest, dispatch_envelope_v4_digest,
    dispatch_envelope_v5_digest, governed_dispatch_policy_digest_v1,
    review_verdict_output_v1_digest, ActionEvidenceVersionV1, ActionFailureV1, ActionKindV1,
    ActionReceiptOutcomeV2, ActionReceiptRecordedV2, ActionReceiptSetEntryV1,
    ActionReceiptSetRecordedV1, ActionRequestedV2, ActionResourceUsageV1, AttemptContextRecordedV1,
    CandidateAcceptanceOutcomeV1, CandidateAcceptanceRecordedV1, CandidateCompletionRecordedV1,
    CandidateCreatedV2, CandidateViewV1, CommitModeV1, DispatchBudgetV1, DispatchEnvelopeBodyV2,
    DispatchEnvelopeV3, DispatchEnvelopeV4, DispatchEnvelopeV5, ExecutionRoleV1,
    PromotionApprovalRequestedV1, PromotionDecisionKindV1, PromotionExecutionLeaseBindingV1,
    PromotionGitBindingV1, PromotionResultOutcomeV1, PromotionWorktreeSyncStateV1,
    ReviewDecisionV1, ReviewVerdictOutputV1, ReviewVerdictRecordedV2, TrustTierV1,
    WorkflowTerminalOutcomeV1, WorkflowTerminalV1,
};
use bp_ledger::payload::Payload;
use bp_ledger::signing::{public_key_hash, ActorKeyRef, TrustedPublicKeys, VerificationStatus};
use bp_ledger::storage::sqlite::{
    ActivityClaimAuthorityV1, ActivityClaimDispositionV1, ActivityClaimRequestV1,
    GovernedCandidateCompletionDispositionV1, GovernedCandidateCompletionRequestV1,
    GovernedPromotionAuthorityV1, GovernedPromotionDecisionDispositionV1,
    GovernedPromotionDecisionRequestV1, GovernedPromotionDecisionSealRequestV1,
    GovernedPromotionExecutionClaimDispositionV1, GovernedPromotionExecutionClaimRequestV1,
    GovernedPromotionResultDispositionV1, GovernedPromotionResultRequestV1,
    ResolveGovernedV3RetryCandidateActionIdentityRequestV1, SqliteStore,
};
use bp_ledger::LedgerError;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use ed25519_dalek::SigningKey;

const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST_C: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const DIGEST_D: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const DIGEST_E: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

fn timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn actor(actor_id: &str, key_id: &str, key: &SigningKey) -> ActorKeyRef {
    ActorKeyRef {
        actor_id: actor_id.into(),
        key_id: key_id.into(),
        public_key_hash: Some(public_key_hash(&key.verifying_key())),
    }
}

fn trusted_keys(keys: &[&SigningKey]) -> TrustedPublicKeys {
    let mut trusted = TrustedPublicKeys::default();
    for key in keys {
        trusted.insert_public_key(
            public_key_hash(&key.verifying_key()),
            key.verifying_key().to_bytes().to_vec(),
        );
    }
    trusted
}

fn dispatch(now: DateTime<Utc>, realm_digest: &str) -> DispatchEnvelopeV3 {
    let body = DispatchEnvelopeBodyV2 {
        workflow_id: "workflow-1".into(),
        workflow_revision: "r1".into(),
        unit_id: "implement-unit-1".into(),
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
            max_tokens: Some(1024),
            max_compute_time_ms: Some(60_000),
        },
        trust_tier: TrustTierV1::Governed,
        idempotency_key: "dispatch:workflow-1:implement-unit-1:1".into(),
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
    .expect("hash governed implementer dispatch");
    DispatchEnvelopeV3 {
        body,
        action_evidence_version,
        repository_binding_digest: DIGEST_A.into(),
        ledger_authority_realm_digest: realm_digest.into(),
        governed_packet_digest: Some(DIGEST_C.into()),
        envelope_digest,
    }
}

fn reviewer_dispatch(now: DateTime<Utc>, realm_digest: &str) -> DispatchEnvelopeV3 {
    let mut dispatch = dispatch(now, realm_digest);
    dispatch.body.unit_id = "review-unit-1".into();
    dispatch.body.execution_role = ExecutionRoleV1::Reviewer;
    dispatch.body.idempotency_key = "dispatch:workflow-1:review-unit-1:1".into();
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

fn event(
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

fn candidate(run_id: RunId, dispatch: &DispatchEnvelopeV3) -> CandidateCreatedV2 {
    CandidateCreatedV2 {
        run_id: run_id.to_string(),
        candidate_id: "candidate-1".into(),
        candidate_ref: format!(
            "refs/buildplane/candidates/candidate-1/{run_id}/{}",
            dispatch.body.attempt
        ),
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
        action_receipt_set_ref: "receipt-set:candidate-1".into(),
        action_receipt_set_digest: DIGEST_B.into(),
    }
}

fn candidate_completion(
    candidate: &CandidateCreatedV2,
    candidate_event_id: EventId,
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
        candidate_create_action_id: "candidate-create:candidate-1".into(),
        action_request_ref: EventId::new(),
        action_request_digest: DIGEST_A.into(),
        activity_claim_event_ref: EventId::new(),
        activity_claim_event_digest: DIGEST_B.into(),
        activity_result_event_ref: EventId::new(),
        activity_result_event_digest: DIGEST_C.into(),
        action_receipt_ref: "receipt:candidate-create:candidate-1".into(),
        action_receipt_digest: DIGEST_D.into(),
        completion_digest: String::new(),
        completed_at: timestamp(completed_at),
    };
    completion.completion_digest =
        candidate_completion_recorded_v1_digest(&completion).expect("hash candidate completion");
    completion
}

fn acceptance(
    candidate: &CandidateCreatedV2,
    dispatch: &DispatchEnvelopeV3,
    now: DateTime<Utc>,
) -> CandidateAcceptanceRecordedV1 {
    CandidateAcceptanceRecordedV1 {
        candidate_digest: candidate.candidate_digest.clone(),
        candidate_commit_sha: candidate.candidate_commit_sha.clone(),
        acceptance_ref: "acceptance:candidate-1".into(),
        acceptance_contract_digest: dispatch.body.acceptance_contract_digest.clone(),
        acceptance_digest: DIGEST_E.into(),
        outcome: CandidateAcceptanceOutcomeV1::Passed,
        evaluated_at: timestamp(now),
    }
}

fn review(
    run_id: RunId,
    candidate: &CandidateCreatedV2,
    candidate_dispatch: &DispatchEnvelopeV3,
    reviewer_dispatch: &DispatchEnvelopeV3,
    acceptance: &CandidateAcceptanceRecordedV1,
    reviewer: &ActorKeyRef,
    now: DateTime<Utc>,
) -> ReviewVerdictRecordedV2 {
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
    .expect("hash closed review output");
    ReviewVerdictRecordedV2 {
        run_id: run_id.to_string(),
        workflow_id: candidate.workflow_id.clone(),
        unit_id: candidate.unit_id.clone(),
        attempt: candidate.attempt,
        provenance_ref: candidate.provenance_ref.clone(),
        candidate_digest: candidate.candidate_digest.clone(),
        candidate_commit_sha: candidate.candidate_commit_sha.clone(),
        review_ref: "review:candidate-1".into(),
        review_verdict_action_id: "review-action-1".into(),
        review_action_request_digest: DIGEST_A.into(),
        review_action_receipt_ref: "receipt:review-action-1".into(),
        review_action_receipt_digest: DIGEST_B.into(),
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
        review_action_receipt_set_ref: "receipt-set:review-action-1".into(),
        review_action_receipt_set_digest: DIGEST_C.into(),
        candidate_view,
        candidate_view_ref: format!("cas:{candidate_view_digest}"),
        candidate_view_digest,
        reviewer_manifest_digest: reviewer_dispatch.body.worker_manifest_digest.clone(),
        reviewer_authority: reviewer.actor_id.clone(),
        reviewed_at: timestamp(now),
    }
}

fn approval(
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
        idempotency_key: "promotion:candidate-1".into(),
    }
}

fn graph_bound_dispatch_v4(dispatch_v3: DispatchEnvelopeV3) -> DispatchEnvelopeV4 {
    let mut dispatch_v4 = DispatchEnvelopeV4 {
        dispatch_v3,
        workflow_graph_digest: DIGEST_A.into(),
        workflow_graph_declaration_event_ref: EventId::new(),
        envelope_digest: String::new(),
    };
    dispatch_v4.envelope_digest = dispatch_envelope_v4_digest(
        &dispatch_v4.dispatch_v3,
        &dispatch_v4.workflow_graph_digest,
        &dispatch_v4.workflow_graph_declaration_event_ref,
    )
    .expect("hash graph-bound promotion dispatch");
    dispatch_v4
}

fn manifest_bound_retry_dispatch_v5(now: DateTime<Utc>) -> DispatchEnvelopeV5 {
    let dispatch_v4 = graph_bound_dispatch_v4(retry_candidate_dispatch(now, DIGEST_E));
    let mut dispatch = DispatchEnvelopeV5 {
        context_manifest_declaration_event_ref: EventId::new(),
        context_manifest_digest: dispatch_v4.dispatch_v3.body.context_manifest_digest.clone(),
        worker_manifest_declaration_event_ref: EventId::new(),
        worker_manifest_digest: dispatch_v4.dispatch_v3.body.worker_manifest_digest.clone(),
        sandbox_profile_declaration_event_ref: EventId::new(),
        sandbox_profile_digest: dispatch_v4.dispatch_v3.body.sandbox_profile_digest.clone(),
        attempt_context_declaration_event_ref: Some(EventId::new()),
        attempt_context_digest: Some(DIGEST_A.into()),
        dispatch_v4,
        envelope_digest: String::new(),
    };
    dispatch.envelope_digest = dispatch_envelope_v5_digest(&dispatch).expect("hash V5 retry");
    dispatch
}

#[derive(Clone, Copy)]
enum V4PromotionDigestBinding {
    Outer,
    Nested,
    Wrong,
}

#[derive(Clone, Copy)]
enum PromotionCandidateRefBinding {
    Exact,
    CandidateIdMismatch,
    RunIdMismatch,
    AttemptMismatch,
}

fn promotion_digest_for(
    binding: V4PromotionDigestBinding,
    dispatch_v4: &DispatchEnvelopeV4,
) -> String {
    match binding {
        V4PromotionDigestBinding::Outer => dispatch_v4.envelope_digest.clone(),
        V4PromotionDigestBinding::Nested => dispatch_v4.dispatch_v3.envelope_digest.clone(),
        V4PromotionDigestBinding::Wrong => DIGEST_B.into(),
    }
}

fn append_v4_promotion_evidence(
    store: &SqliteStore,
    kernel_key: &SigningKey,
    kernel: &ActorKeyRef,
    reviewer_key: &SigningKey,
    reviewer: &ActorKeyRef,
    run_id: RunId,
    now: DateTime<Utc>,
    binding: V4PromotionDigestBinding,
    candidate_ref_binding: PromotionCandidateRefBinding,
) -> (GovernedPromotionDecisionRequestV1, String) {
    let implementation_v4 = graph_bound_dispatch_v4(dispatch(now, DIGEST_E));
    let dispatch_event = event(
        run_id,
        None,
        EventKind::DispatchEnvelopeV4,
        now,
        Payload::DispatchEnvelopeV4(implementation_v4.clone()),
    );
    store
        .append_signed(&dispatch_event, kernel_key, kernel)
        .expect("append graph-bound implementation dispatch");

    let mut candidate = candidate(run_id, &implementation_v4.dispatch_v3);
    candidate.envelope_digest = promotion_digest_for(binding, &implementation_v4);
    candidate.candidate_ref = match candidate_ref_binding {
        PromotionCandidateRefBinding::Exact => candidate.candidate_ref.clone(),
        PromotionCandidateRefBinding::CandidateIdMismatch => format!(
            "refs/buildplane/candidates/candidate-2/{run_id}/{}",
            candidate.attempt
        ),
        PromotionCandidateRefBinding::RunIdMismatch => format!(
            "refs/buildplane/candidates/{}/{}/{}",
            candidate.candidate_id,
            RunId::new(),
            candidate.attempt
        ),
        PromotionCandidateRefBinding::AttemptMismatch => format!(
            "refs/buildplane/candidates/{}/{run_id}/{}",
            candidate.candidate_id,
            candidate.attempt + 1
        ),
    };
    let candidate_event = event(
        run_id,
        Some(dispatch_event.id),
        EventKind::CandidateCreatedV2,
        now + Duration::seconds(1),
        Payload::CandidateCreatedV2(candidate.clone()),
    );
    store
        .append_signed(&candidate_event, kernel_key, kernel)
        .expect("append outer-bound candidate");

    let completion =
        candidate_completion(&candidate, candidate_event.id, now + Duration::seconds(2));
    let completion_event = event(
        run_id,
        Some(candidate_event.id),
        EventKind::CandidateCompletionRecordedV1,
        now + Duration::seconds(2),
        Payload::CandidateCompletionRecordedV1(completion),
    );
    store
        .append_signed(&completion_event, kernel_key, kernel)
        .expect("append candidate completion");

    let acceptance = acceptance(
        &candidate,
        &implementation_v4.dispatch_v3,
        now + Duration::seconds(3),
    );
    let acceptance_event = event(
        run_id,
        Some(completion_event.id),
        EventKind::CandidateAcceptanceRecorded,
        now + Duration::seconds(3),
        Payload::CandidateAcceptanceRecordedV1(acceptance.clone()),
    );
    store
        .append_signed(&acceptance_event, kernel_key, kernel)
        .expect("append passed acceptance");

    let reviewer_v4 =
        graph_bound_dispatch_v4(reviewer_dispatch(now + Duration::seconds(4), DIGEST_E));
    let review_dispatch_event = event(
        run_id,
        Some(acceptance_event.id),
        EventKind::DispatchEnvelopeV4,
        now + Duration::seconds(4),
        Payload::DispatchEnvelopeV4(reviewer_v4.clone()),
    );
    store
        .append_signed(&review_dispatch_event, kernel_key, kernel)
        .expect("append graph-bound reviewer dispatch");

    let mut review = review(
        run_id,
        &candidate,
        &implementation_v4.dispatch_v3,
        &reviewer_v4.dispatch_v3,
        &acceptance,
        reviewer,
        now + Duration::seconds(5),
    );
    review.candidate_envelope_digest = promotion_digest_for(binding, &implementation_v4);
    review.reviewer_dispatch_envelope_digest = promotion_digest_for(binding, &reviewer_v4);
    let review_event = event(
        run_id,
        Some(review_dispatch_event.id),
        EventKind::ReviewVerdictRecordedV2,
        now + Duration::seconds(5),
        Payload::ReviewVerdictRecordedV2(review.clone()),
    );
    store
        .append_signed(&review_event, reviewer_key, reviewer)
        .expect("append outer-bound review verdict");

    let mut approval = approval(
        &candidate,
        &implementation_v4.dispatch_v3,
        &acceptance,
        &review,
        kernel,
        now + Duration::seconds(6),
    );
    approval.envelope_digest = promotion_digest_for(binding, &implementation_v4);
    let approval_event = event(
        run_id,
        Some(review_event.id),
        EventKind::PromotionApprovalRequested,
        now + Duration::seconds(6),
        Payload::PromotionApprovalRequestedV1(approval),
    );
    store
        .append_signed(&approval_event, kernel_key, kernel)
        .expect("append outer-bound promotion approval");

    (
        GovernedPromotionDecisionRequestV1 {
            run_id,
            dispatch_event_id: dispatch_event.id,
            candidate_created_event_id: candidate_event.id,
            candidate_completion_event_id: completion_event.id,
            acceptance_event_id: acceptance_event.id,
            review_event_ids: vec![review_event.id],
            promotion_approval_request_event_id: approval_event.id,
            decision: PromotionDecisionKindV1::Promote,
        },
        implementation_v4.envelope_digest,
    )
}

#[test]
fn governed_promotion_v4_binds_the_outer_dispatch_digest_and_rejects_inner_or_wrong_digests() {
    let kernel_key = SigningKey::from_bytes(&[41; 32]);
    let reviewer_key = SigningKey::from_bytes(&[42; 32]);
    let operator_key = SigningKey::from_bytes(&[43; 32]);
    let kernel = actor("kernel", "kernel-main", &kernel_key);
    let reviewer = actor("reviewer", "reviewer-main", &reviewer_key);
    let operator = actor("operator", "operator-main", &operator_key);
    let authority = GovernedPromotionAuthorityV1::new_governed_realm(
        trusted_keys(&[&kernel_key, &reviewer_key, &operator_key]),
        kernel.clone(),
        vec![reviewer.clone()],
        operator.clone(),
        DIGEST_E.into(),
    )
    .expect("construct promotion authority");
    let now = DateTime::parse_from_rfc3339("2026-07-20T12:00:00.000Z")
        .expect("parse fixture time")
        .with_timezone(&Utc);

    let store = SqliteStore::open_in_memory().expect("open promotion store");
    let (request, outer_digest) = append_v4_promotion_evidence(
        &store,
        &kernel_key,
        &kernel,
        &reviewer_key,
        &reviewer,
        RunId::new(),
        now,
        V4PromotionDigestBinding::Outer,
        PromotionCandidateRefBinding::Exact,
    );
    let recorded = store
        .record_governed_promotion_decision_v1_at_for_tests(
            &request,
            &authority,
            &operator_key,
            &operator,
            now + Duration::seconds(7),
        )
        .expect("only the outer V4 digest may authorize promotion");
    assert!(matches!(
        recorded,
        GovernedPromotionDecisionDispositionV1::AwaitingKernelSeal { .. }
    ));
    let decision = store
        .events_for_run(&request.run_id.to_string())
        .expect("read promotion tape")
        .into_iter()
        .find_map(
            |row| match row.to_event().expect("decode decision event").payload {
                Payload::PromotionDecisionRecordedV1(decision) => Some(decision),
                _ => None,
            },
        )
        .expect("recorded promotion decision");
    assert_eq!(decision.envelope_digest, outer_digest);

    for (label, binding) in [
        ("nested V3", V4PromotionDigestBinding::Nested),
        ("unrelated", V4PromotionDigestBinding::Wrong),
    ] {
        let rejected_store = SqliteStore::open_in_memory().expect("open rejected promotion store");
        let (rejected_request, _) = append_v4_promotion_evidence(
            &rejected_store,
            &kernel_key,
            &kernel,
            &reviewer_key,
            &reviewer,
            RunId::new(),
            now,
            binding,
            PromotionCandidateRefBinding::Exact,
        );
        let error = rejected_store
            .record_governed_promotion_decision_v1_at_for_tests(
                &rejected_request,
                &authority,
                &operator_key,
                &operator,
                now + Duration::seconds(7),
            )
            .expect_err("nested or unrelated V4 digest must not authorize promotion");
        assert!(matches!(
            error,
            LedgerError::PromotionAuthorityRejected { .. }
        ));
        assert_eq!(
            rejected_store
                .event_count()
                .expect("count rejected promotion tape"),
            7,
            "{label} digest must not append a promotion decision"
        );
    }
}

fn assert_governed_promotion_candidate_ref_binding_rejected(
    candidate_ref_binding: PromotionCandidateRefBinding,
    label: &str,
) {
    let kernel_key = SigningKey::from_bytes(&[44; 32]);
    let reviewer_key = SigningKey::from_bytes(&[45; 32]);
    let operator_key = SigningKey::from_bytes(&[46; 32]);
    let kernel = actor("kernel", "kernel-main", &kernel_key);
    let reviewer = actor("reviewer", "reviewer-main", &reviewer_key);
    let operator = actor("operator", "operator-main", &operator_key);
    let authority = GovernedPromotionAuthorityV1::new_governed_realm(
        trusted_keys(&[&kernel_key, &reviewer_key, &operator_key]),
        kernel.clone(),
        vec![reviewer.clone()],
        operator.clone(),
        DIGEST_E.into(),
    )
    .expect("construct promotion authority");
    let now = DateTime::parse_from_rfc3339("2026-07-20T12:00:00.000Z")
        .expect("parse fixture time")
        .with_timezone(&Utc);
    let store = SqliteStore::open_in_memory().expect("open promotion store");
    let (request, _) = append_v4_promotion_evidence(
        &store,
        &kernel_key,
        &kernel,
        &reviewer_key,
        &reviewer,
        RunId::new(),
        now,
        V4PromotionDigestBinding::Outer,
        candidate_ref_binding,
    );
    let event_count_before_decision = store.event_count().expect("count promotion evidence");

    let error = store
        .record_governed_promotion_decision_v1_at_for_tests(
            &request,
            &authority,
            &operator_key,
            &operator,
            now + Duration::seconds(7),
        )
        .expect_err("an unbound canonical candidate ref must not authorize promotion");
    assert!(
        matches!(
            error,
            LedgerError::PromotionAuthorityRejected { ref reason }
                if reason.contains("candidate ref must bind the signed candidate id, run, and attempt")
        ),
        "expected {label} candidate-ref binding rejection, got {error:?}"
    );
    assert_eq!(
        store.event_count().expect("count rejected promotion tape"),
        event_count_before_decision,
        "{label} candidate ref must not append a promotion decision that could be claimed"
    );
}

#[test]
fn governed_promotion_rejects_a_canonical_candidate_ref_with_a_different_candidate_id() {
    assert_governed_promotion_candidate_ref_binding_rejected(
        PromotionCandidateRefBinding::CandidateIdMismatch,
        "candidate-id mismatch",
    );
}

#[test]
fn governed_promotion_rejects_a_canonical_candidate_ref_for_a_different_run() {
    assert_governed_promotion_candidate_ref_binding_rejected(
        PromotionCandidateRefBinding::RunIdMismatch,
        "run-id mismatch",
    );
}

#[test]
fn governed_promotion_rejects_a_canonical_candidate_ref_for_a_different_attempt() {
    assert_governed_promotion_candidate_ref_binding_rejected(
        PromotionCandidateRefBinding::AttemptMismatch,
        "attempt mismatch",
    );
}

#[test]
fn governed_promotion_decision_is_candidate_bound_idempotent_and_kernel_sealed() {
    let store = SqliteStore::open_in_memory().expect("open store");
    let kernel_key = SigningKey::from_bytes(&[1; 32]);
    let reviewer_key = SigningKey::from_bytes(&[2; 32]);
    let operator_key = SigningKey::from_bytes(&[3; 32]);
    let kernel = actor("kernel", "kernel-main", &kernel_key);
    let reviewer = actor("reviewer", "reviewer-main", &reviewer_key);
    let operator = actor("operator", "operator-main", &operator_key);
    let trusted = trusted_keys(&[&kernel_key, &reviewer_key, &operator_key]);
    let authority = GovernedPromotionAuthorityV1::new_governed_realm(
        trusted.clone(),
        kernel.clone(),
        vec![reviewer.clone()],
        operator.clone(),
        DIGEST_E.into(),
    )
    .expect("construct distinct governed promotion authority");
    let run_id = RunId::new();
    let now = DateTime::parse_from_rfc3339("2026-07-20T12:00:00.000Z")
        .expect("parse fixture time")
        .with_timezone(&Utc);

    let implementation_dispatch = dispatch(now, DIGEST_E);
    let dispatch_event = event(
        run_id,
        None,
        EventKind::DispatchEnvelopeV3,
        now,
        Payload::DispatchEnvelopeV3(implementation_dispatch.clone()),
    );
    store
        .append_signed(&dispatch_event, &kernel_key, &kernel)
        .expect("append implementation dispatch");

    let candidate = candidate(run_id, &implementation_dispatch);
    let candidate_event = event(
        run_id,
        Some(dispatch_event.id),
        EventKind::CandidateCreatedV2,
        now + Duration::seconds(1),
        Payload::CandidateCreatedV2(candidate.clone()),
    );
    store
        .append_signed(&candidate_event, &kernel_key, &kernel)
        .expect("append candidate");

    let completion =
        candidate_completion(&candidate, candidate_event.id, now + Duration::seconds(2));
    let completion_event = event(
        run_id,
        Some(candidate_event.id),
        EventKind::CandidateCompletionRecordedV1,
        now + Duration::seconds(2),
        Payload::CandidateCompletionRecordedV1(completion),
    );
    store
        .append_signed(&completion_event, &kernel_key, &kernel)
        .expect("append candidate completion");

    let acceptance = acceptance(
        &candidate,
        &implementation_dispatch,
        now + Duration::seconds(3),
    );
    let acceptance_event = event(
        run_id,
        Some(completion_event.id),
        EventKind::CandidateAcceptanceRecorded,
        now + Duration::seconds(3),
        Payload::CandidateAcceptanceRecordedV1(acceptance.clone()),
    );
    store
        .append_signed(&acceptance_event, &kernel_key, &kernel)
        .expect("append passed acceptance");

    let review_dispatch = reviewer_dispatch(now + Duration::seconds(4), DIGEST_E);
    let review_dispatch_event = event(
        run_id,
        Some(acceptance_event.id),
        EventKind::DispatchEnvelopeV3,
        now + Duration::seconds(4),
        Payload::DispatchEnvelopeV3(review_dispatch.clone()),
    );
    store
        .append_signed(&review_dispatch_event, &kernel_key, &kernel)
        .expect("append independent reviewer dispatch");

    let review = review(
        run_id,
        &candidate,
        &implementation_dispatch,
        &review_dispatch,
        &acceptance,
        &reviewer,
        now + Duration::seconds(5),
    );
    let review_event = event(
        run_id,
        Some(review_dispatch_event.id),
        EventKind::ReviewVerdictRecordedV2,
        now + Duration::seconds(5),
        Payload::ReviewVerdictRecordedV2(review.clone()),
    );
    store
        .append_signed(&review_event, &reviewer_key, &reviewer)
        .expect("append closed reviewer verdict");

    let approval = approval(
        &candidate,
        &implementation_dispatch,
        &acceptance,
        &review,
        &kernel,
        now + Duration::seconds(6),
    );
    let approval_event = event(
        run_id,
        Some(review_event.id),
        EventKind::PromotionApprovalRequested,
        now + Duration::seconds(6),
        Payload::PromotionApprovalRequestedV1(approval),
    );
    store
        .append_signed(&approval_event, &kernel_key, &kernel)
        .expect("append candidate-bound approval request");

    let request = GovernedPromotionDecisionRequestV1 {
        run_id,
        dispatch_event_id: dispatch_event.id,
        candidate_created_event_id: candidate_event.id,
        candidate_completion_event_id: completion_event.id,
        acceptance_event_id: acceptance_event.id,
        review_event_ids: vec![review_event.id],
        promotion_approval_request_event_id: approval_event.id,
        decision: PromotionDecisionKindV1::Promote,
    };
    let first = store
        .record_governed_promotion_decision_v1_at_for_tests(
            &request,
            &authority,
            &operator_key,
            &operator,
            now + Duration::seconds(7),
        )
        .expect("record operator decision");
    let decision_event_id = match first {
        GovernedPromotionDecisionDispositionV1::AwaitingKernelSeal {
            promotion_decision_event_id,
            candidate_digest,
            idempotency_key,
            ..
        } => {
            assert_eq!(candidate_digest, candidate.candidate_digest);
            assert_eq!(idempotency_key, "promotion:candidate-1");
            promotion_decision_event_id
        }
        other => panic!("first decision must await a kernel seal, got {other:?}"),
    };
    assert_eq!(store.event_count().unwrap(), 8);

    let retry = store
        .record_governed_promotion_decision_v1_at_for_tests(
            &request,
            &authority,
            &operator_key,
            &operator,
            now + Duration::minutes(15),
        )
        .expect("exact retry resolves the original decision after its dispatch window expires");
    assert!(matches!(
        retry,
        GovernedPromotionDecisionDispositionV1::AwaitingKernelSeal {
            promotion_decision_event_id,
            ..
        } if promotion_decision_event_id == decision_event_id
    ));
    assert_eq!(
        store.event_count().unwrap(),
        8,
        "retry must not append a decision"
    );

    let sealed = store
        .seal_governed_promotion_decision_v1(
            &GovernedPromotionDecisionSealRequestV1 {
                run_id,
                promotion_decision_event_id: decision_event_id,
            },
            &authority,
            &kernel_key,
            &kernel,
        )
        .expect("kernel seals the decision prefix");
    let checkpoint_event_id = match sealed {
        GovernedPromotionDecisionDispositionV1::Sealed {
            promotion_decision_event_id: sealed_decision_id,
            checkpoint_event_id,
            ..
        } => {
            assert_eq!(sealed_decision_id, decision_event_id);
            checkpoint_event_id
        }
        other => panic!("kernel must seal the decision, got {other:?}"),
    };
    assert_eq!(store.event_count().unwrap(), 9);

    let events = store
        .signed_events_for_run(&run_id.to_string())
        .expect("read signed promotion tape");
    let checkpoint = events
        .iter()
        .find(|(event, _)| event.id == checkpoint_event_id)
        .expect("returned checkpoint is stored");
    assert_eq!(checkpoint.0.kind, EventKind::TapeCheckpoint);
    match &checkpoint.0.payload {
        Payload::TapeCheckpointV1(payload) => {
            assert_eq!(payload.through_event_id, decision_event_id);
            assert_eq!(payload.through_event_count, 8);
        }
        payload => panic!("expected tape checkpoint payload, got {payload:?}"),
    }
    assert!(
        store
            .verified_events_for_run(&run_id.to_string(), &trusted)
            .expect("verify promotion tape")
            .iter()
            .all(|row| row.verification == VerificationStatus::Verified),
        "every prerequisite, decision, and checkpoint must be detached-signature verified"
    );

    let sealed_retry = store
        .seal_governed_promotion_decision_v1(
            &GovernedPromotionDecisionSealRequestV1 {
                run_id,
                promotion_decision_event_id: decision_event_id,
            },
            &authority,
            &kernel_key,
            &kernel,
        )
        .expect("kernel seal retry resolves the original checkpoint");
    assert!(matches!(
        sealed_retry,
        GovernedPromotionDecisionDispositionV1::Sealed {
            checkpoint_event_id: retry_checkpoint_id,
            ..
        } if retry_checkpoint_id == checkpoint_event_id
    ));
    assert_eq!(
        store.event_count().unwrap(),
        9,
        "seal retry must not append a checkpoint"
    );

    let merged_head_sha = "3".repeat(40);
    let promotion_result = GovernedPromotionResultRequestV1 {
        run_id,
        promotion_decision_event_id: decision_event_id,
        outcome: PromotionResultOutcomeV1::ReconciliationRequired,
        merged_head_sha: Some(merged_head_sha.clone()),
        promotion_git_binding: Some(PromotionGitBindingV1 {
            target_ref: "refs/heads/main".into(),
            target_head_before_sha: candidate.base_commit_sha.clone(),
            target_head_after_sha: Some(merged_head_sha.clone()),
            merged_head_sha: Some(merged_head_sha.clone()),
            candidate_commit_sha: candidate.candidate_commit_sha.clone(),
            merge_parent_shas: Some(vec![
                candidate.base_commit_sha.clone(),
                candidate.candidate_commit_sha.clone(),
            ]),
            merged_tree_sha: Some("4".repeat(40)),
            merged_tree_digest: candidate.tree_digest.clone(),
            promotion_receipt_ref: Some(format!(
                "refs/buildplane/promotions/candidate-1/{run_id}/1"
            )),
            worktree_sync_state: Some(PromotionWorktreeSyncStateV1::RootCheckoutStale),
        }),
        promotion_execution_lease_binding: None,
    };
    let error = store
        .record_governed_promotion_result_v1_at_for_tests(
            &promotion_result,
            &authority,
            &kernel_key,
            &kernel,
            now + Duration::seconds(8),
        )
        .expect_err(
            "a promotion result without a durable promotion execution claim must block before recording Git evidence",
        );
    assert!(matches!(
        error,
        LedgerError::PromotionResultReconciliationRequired { .. }
    ));
    assert_eq!(
        store.event_count().unwrap(),
        9,
        "a result without a write-ahead promotion lease must not append a target-effect record"
    );
    let claim_request = GovernedPromotionExecutionClaimRequestV1 {
        run_id,
        promotion_decision_event_id: decision_event_id,
        lease_duration_ms: 1_000,
    };
    let (promotion_execution_claim_event_ref, promotion_execution_claim_event_digest, lease_id) =
        match store
            .claim_governed_promotion_execution_v1_at_for_tests(
                &claim_request,
                &authority,
                &kernel_key,
                &kernel,
                now + Duration::seconds(8),
            )
            .expect("a sealed promote decision may reserve one durable execution lease")
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
            other => panic!("first promotion claim must grant one lease, got {other:?}"),
        };
    assert_eq!(
        store.event_count().unwrap(),
        11,
        "the promotion claim and its eagerly sealed checkpoint must be durable before Git can run"
    );
    let duplicate_claim = store
        .claim_governed_promotion_execution_v1_at_for_tests(
            &claim_request,
            &authority,
            &kernel_key,
            &kernel,
            now + Duration::seconds(8),
        )
        .expect("a duplicate claim must resolve the existing reservation without its lease");
    assert!(matches!(
        duplicate_claim,
        GovernedPromotionExecutionClaimDispositionV1::Pending {
            promotion_execution_claim_event_id,
            ..
        } if promotion_execution_claim_event_id == promotion_execution_claim_event_ref
    ));
    assert_eq!(
        store.event_count().unwrap(),
        11,
        "a duplicate promotion claim must not append or disclose another lease"
    );
    let expired_claim = store
        .claim_governed_promotion_execution_v1_at_for_tests(
            &claim_request,
            &authority,
            &kernel_key,
            &kernel,
            now + Duration::seconds(9),
        )
        .expect("an expired lease must remain a terminal reconciliation state");
    assert!(matches!(
        expired_claim,
        GovernedPromotionExecutionClaimDispositionV1::LeaseExpired {
            promotion_execution_claim_event_id,
            ..
        } if promotion_execution_claim_event_id == promotion_execution_claim_event_ref
    ));
    assert_eq!(
        store.event_count().unwrap(),
        11,
        "an expired claim must not mint a replacement promotion lease"
    );
    let promotion_execution_lease_binding = Some(PromotionExecutionLeaseBindingV1 {
        promotion_execution_claim_event_ref,
        promotion_execution_claim_event_digest,
        lease_id,
    });
    let promotion_result = GovernedPromotionResultRequestV1 {
        promotion_execution_lease_binding,
        ..promotion_result
    };
    let mut malformed_result = promotion_result.clone();
    malformed_result.promotion_git_binding = Some(PromotionGitBindingV1 {
        merged_tree_sha: Some("not-a-git-object".into()),
        ..promotion_result
            .promotion_git_binding
            .clone()
            .expect("fixture carries Git binding")
    });
    let error = store
        .record_governed_promotion_result_v1_at_for_tests(
            &malformed_result,
            &authority,
            &kernel_key,
            &kernel,
            now + Duration::seconds(9),
        )
        .expect_err("malformed Git evidence cannot enter the governed tape");
    assert!(matches!(
        error,
        LedgerError::PromotionResultReconciliationRequired { .. }
    ));
    assert_eq!(
        store.event_count().unwrap(),
        11,
        "malformed promotion evidence must not append a result"
    );
    let mut substituted_lease_result = promotion_result.clone();
    substituted_lease_result.promotion_execution_lease_binding =
        Some(PromotionExecutionLeaseBindingV1 {
            lease_id: "wrong-promotion-lease".into(),
            ..promotion_result
                .promotion_execution_lease_binding
                .clone()
                .expect("fixture carries a promotion execution lease")
        });
    let error = store
        .record_governed_promotion_result_v1_at_for_tests(
            &substituted_lease_result,
            &authority,
            &kernel_key,
            &kernel,
            now + Duration::seconds(9),
        )
        .expect_err("a result must not attach a neighbouring or substituted promotion lease");
    assert!(matches!(
        error,
        LedgerError::PromotionResultReconciliationRequired { .. }
    ));
    assert_eq!(
        store.event_count().unwrap(),
        11,
        "a substituted promotion lease must not append target-effect evidence"
    );

    let recorded_result = store
        .record_governed_promotion_result_v1_at_for_tests(
            &promotion_result,
            &authority,
            &kernel_key,
            &kernel,
            now + Duration::seconds(9),
        )
        .expect("record one terminal, target-bound promotion result");
    assert!(matches!(
        recorded_result,
        GovernedPromotionResultDispositionV1::Recorded {
            outcome: PromotionResultOutcomeV1::ReconciliationRequired,
            ..
        }
    ));
    assert_eq!(
        store.event_count().unwrap(),
        13,
        "the terminal result and its required kernel checkpoint must be durable"
    );

    let replayed_result = store
        .record_governed_promotion_result_v1_at_for_tests(
            &promotion_result,
            &authority,
            &kernel_key,
            &kernel,
            now + Duration::seconds(10),
        )
        .expect("exact retry reuses the sealed terminal result");
    assert!(matches!(
        replayed_result,
        GovernedPromotionResultDispositionV1::Existing {
            outcome: PromotionResultOutcomeV1::ReconciliationRequired,
            ..
        }
    ));
    assert_eq!(
        store.event_count().unwrap(),
        13,
        "a duplicate result must not append another result or checkpoint"
    );

    let mut substituted_result = promotion_result.clone();
    substituted_result.promotion_git_binding = Some(PromotionGitBindingV1 {
        target_ref: "refs/heads/other".into(),
        ..promotion_result
            .promotion_git_binding
            .clone()
            .expect("fixture carries Git binding")
    });
    let error = store
        .record_governed_promotion_result_v1_at_for_tests(
            &substituted_result,
            &authority,
            &kernel_key,
            &kernel,
            now + Duration::seconds(11),
        )
        .expect_err("a substituted target ref cannot reuse a sealed promotion result");
    assert!(matches!(
        error,
        LedgerError::PromotionResultReconciliationRequired { .. }
    ));
    assert_eq!(
        store.event_count().unwrap(),
        13,
        "a mismatched result retry must not append target-effect evidence"
    );

    let conflict = GovernedPromotionDecisionRequestV1 {
        decision: PromotionDecisionKindV1::Reject,
        ..request
    };
    let error = store
        .record_governed_promotion_decision_v1_at_for_tests(
            &conflict,
            &authority,
            &operator_key,
            &operator,
            now + Duration::minutes(16),
        )
        .expect_err("a candidate cannot receive a second conflicting decision");
    assert!(matches!(
        error,
        LedgerError::PromotionDecisionIdempotencyConflict { .. }
    ));
    assert_eq!(
        store.event_count().unwrap(),
        13,
        "conflict must not append an event"
    );
}

#[test]
fn unsealed_promotion_claim_cannot_record_an_effect_bearing_result_after_checkpoint_crash() {
    let store = SqliteStore::open_in_memory().expect("open store");
    let kernel_key = SigningKey::from_bytes(&[61; 32]);
    let reviewer_key = SigningKey::from_bytes(&[62; 32]);
    let operator_key = SigningKey::from_bytes(&[63; 32]);
    let kernel = actor("kernel", "kernel-main", &kernel_key);
    let reviewer = actor("reviewer", "reviewer-main", &reviewer_key);
    let operator = actor("operator", "operator-main", &operator_key);
    let authority = GovernedPromotionAuthorityV1::new_governed_realm(
        trusted_keys(&[&kernel_key, &reviewer_key, &operator_key]),
        kernel.clone(),
        vec![reviewer.clone()],
        operator.clone(),
        DIGEST_E.into(),
    )
    .expect("construct promotion authority");
    let run_id = RunId::new();
    let now = DateTime::parse_from_rfc3339("2026-07-20T13:00:00.000Z")
        .expect("parse fixture time")
        .with_timezone(&Utc);
    let (request, _) = append_v4_promotion_evidence(
        &store,
        &kernel_key,
        &kernel,
        &reviewer_key,
        &reviewer,
        run_id,
        now,
        V4PromotionDigestBinding::Outer,
        PromotionCandidateRefBinding::Exact,
    );
    let decision_event_id = match store
        .record_governed_promotion_decision_v1_at_for_tests(
            &request,
            &authority,
            &operator_key,
            &operator,
            now + Duration::seconds(7),
        )
        .expect("record promotion decision")
    {
        GovernedPromotionDecisionDispositionV1::AwaitingKernelSeal {
            promotion_decision_event_id,
            ..
        } => promotion_decision_event_id,
        other => panic!("decision must await a kernel seal, got {other:?}"),
    };
    store
        .seal_governed_promotion_decision_v1(
            &GovernedPromotionDecisionSealRequestV1 {
                run_id,
                promotion_decision_event_id: decision_event_id,
            },
            &authority,
            &kernel_key,
            &kernel,
        )
        .expect("seal promotion decision");
    assert_eq!(store.event_count().unwrap(), 9);

    let claim_request = GovernedPromotionExecutionClaimRequestV1 {
        run_id,
        promotion_decision_event_id: decision_event_id,
        lease_duration_ms: 1_000,
    };
    store.fail_next_checkpoint_signature_insert_for_tests();
    let error = store
        .claim_governed_promotion_execution_v1_at_for_tests(
            &claim_request,
            &authority,
            &kernel_key,
            &kernel,
            now + Duration::seconds(8),
        )
        .expect_err("a checkpoint failure must withhold the new promotion lease");
    assert!(matches!(error, LedgerError::AppendOnlyViolation(_)));
    assert_eq!(
        store.event_count().unwrap(),
        10,
        "the claim event persists for reconciliation but its checkpoint rolls back"
    );

    let (claim_event_id, claim_event_digest, lease_id) = store
        .signed_events_for_run(&run_id.to_string())
        .expect("read persisted claim")
        .into_iter()
        .find_map(|(event, signature)| match (event.payload, signature) {
            (Payload::PromotionExecutionClaimedV1(claim), Some(signature)) => {
                Some((event.id, signature.canonical_event_hash, claim.lease_id))
            }
            _ => None,
        })
        .expect("checkpoint crash leaves one signed promotion claim for recovery");
    let merged_head_sha = "3".repeat(40);
    let result = GovernedPromotionResultRequestV1 {
        run_id,
        promotion_decision_event_id: decision_event_id,
        outcome: PromotionResultOutcomeV1::ReconciliationRequired,
        merged_head_sha: Some(merged_head_sha.clone()),
        promotion_git_binding: Some(PromotionGitBindingV1 {
            target_ref: "refs/heads/main".into(),
            target_head_before_sha: "1".repeat(40),
            target_head_after_sha: Some(merged_head_sha.clone()),
            merged_head_sha: Some(merged_head_sha.clone()),
            candidate_commit_sha: "2".repeat(40),
            merge_parent_shas: Some(vec!["1".repeat(40), "2".repeat(40)]),
            merged_tree_sha: Some("4".repeat(40)),
            merged_tree_digest: DIGEST_C.into(),
            promotion_receipt_ref: Some(format!(
                "refs/buildplane/promotions/candidate-1/{run_id}/1"
            )),
            worktree_sync_state: Some(PromotionWorktreeSyncStateV1::RootCheckoutStale),
        }),
        promotion_execution_lease_binding: Some(PromotionExecutionLeaseBindingV1 {
            promotion_execution_claim_event_ref: claim_event_id,
            promotion_execution_claim_event_digest: claim_event_digest,
            lease_id,
        }),
    };
    let error = store
        .record_governed_promotion_result_v1_at_for_tests(
            &result,
            &authority,
            &kernel_key,
            &kernel,
            now + Duration::seconds(9),
        )
        .expect_err("a persisted but uncheckpointed promotion claim must remain recovery-only");
    assert!(matches!(
        error,
        LedgerError::PromotionResultReconciliationRequired { .. }
    ));
    assert_eq!(
        store.event_count().unwrap(),
        10,
        "an unsealed claim must not append a promotion result or its checkpoint"
    );
}

#[test]
fn governed_promotion_authority_rejects_relabeling_one_private_key_as_every_role() {
    let shared = SigningKey::from_bytes(&[11; 32]);
    let operator = SigningKey::from_bytes(&[12; 32]);
    let kernel = actor("kernel", "kernel-main", &shared);
    let reviewer = actor("reviewer", "reviewer-main", &shared);
    let operator = actor("operator", "operator-main", &operator);
    let trusted = trusted_keys(&[&shared]);

    let error = GovernedPromotionAuthorityV1::new_governed_realm(
        trusted,
        kernel,
        vec![reviewer],
        operator,
        DIGEST_A.into(),
    )
    .expect_err("the same key must not become kernel and reviewer authority");
    assert!(matches!(
        error,
        LedgerError::PromotionAuthorityRejected { .. }
    ));
}

const RETRY_CANDIDATE_ACTION_NAMESPACE: &str = "retry-action:workflow-1:implement-unit-1:2";

#[derive(Clone, Copy)]
enum RetryCandidateEvidenceVariant {
    Valid,
    CandidateRefForAnotherRun,
    CandidateRefForWrongAttempt,
    CandidateIdDoesNotMatchRef,
    ReviewerExecutionRole,
    AlteredCandidateActionId,
    AlteredCandidateIdempotencyKey,
    MissingContext,
    SubstitutedContext,
    LegacyRetryActionIdentity,
    ReusedPriorDispatchIdempotencyKey,
    ReusedPriorActionIdempotencyNamespace,
}

fn retry_candidate_dispatch(now: DateTime<Utc>, realm_digest: &str) -> DispatchEnvelopeV3 {
    let mut retry = dispatch(now, realm_digest);
    retry.body.attempt = 2;
    retry.body.provenance_ref = "admission:retry-2".into();
    retry.body.idempotency_key = "dispatch:workflow-1:implement-unit-1:2".into();
    retry.body.issued_at = timestamp(now);
    retry.body.expires_at = timestamp(now + Duration::minutes(10));
    retry.envelope_digest = dispatch_envelope_v3_body_digest(
        &retry.body,
        retry.action_evidence_version,
        &retry.repository_binding_digest,
        &retry.ledger_authority_realm_digest,
        retry.governed_packet_digest.as_deref(),
    )
    .expect("hash retry dispatch");
    retry
}

fn retry_candidate_action_request(
    run_id: RunId,
    dispatch: &DispatchEnvelopeV3,
    action_id: String,
    idempotency_key: String,
    requested_at: DateTime<Utc>,
) -> ActionRequestedV2 {
    ActionRequestedV2 {
        run_id: run_id.to_string(),
        workflow_id: dispatch.body.workflow_id.clone(),
        unit_id: dispatch.body.unit_id.clone(),
        attempt: dispatch.body.attempt,
        provenance_ref: dispatch.body.provenance_ref.clone(),
        action_id: action_id.clone(),
        idempotency_key,
        action_kind: ActionKindV1::Git,
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
        .expect("derive governed retry action policy"),
        context_manifest_digest: dispatch.body.context_manifest_digest.clone(),
        worker_manifest_digest: dispatch.body.worker_manifest_digest.clone(),
        sandbox_profile_digest: dispatch.body.sandbox_profile_digest.clone(),
        authority_actor: "kernel".into(),
        execution_role: dispatch.body.execution_role,
        requested_at: timestamp(requested_at),
    }
}

fn retry_candidate_claim(
    run_id: RunId,
    dispatch_event: &Event,
    request_event: &Event,
    request: &ActionRequestedV2,
    claimed_at: DateTime<Utc>,
) -> ActivityClaimedV1 {
    ActivityClaimedV1 {
        run_id,
        activity_id: request.action_id.clone(),
        idempotency_key: request.idempotency_key.clone(),
        action_kind: request.action_kind,
        action_request_event_id: request_event.id,
        action_request_digest: action_requested_v2_digest(request).expect("hash action request"),
        dispatch_event_id: dispatch_event.id,
        dispatch_envelope_digest: request.dispatch_envelope_digest.clone(),
        authority_actor: "kernel".into(),
        purpose: ActivityClaimPurposeV1::Generic,
        lease_id: format!("lease:{}", request.action_id),
        lease_expires_at: timestamp(claimed_at + Duration::seconds(30)),
        claimed_at: timestamp(claimed_at),
    }
}

fn retry_candidate_result(
    claim_event: &Event,
    claim: &ActivityClaimedV1,
    outcome: ActivityResultOutcomeV1,
    recorded_at: DateTime<Utc>,
) -> ActivityResultRecordedV1 {
    let succeeded = outcome == ActivityResultOutcomeV1::Succeeded;
    ActivityResultRecordedV1 {
        run_id: claim.run_id,
        activity_id: claim.activity_id.clone(),
        idempotency_key: claim.idempotency_key.clone(),
        claim_event_id: claim_event.id,
        claim_event_digest: canonical_event_hash(claim_event).expect("hash activity claim"),
        lease_id: claim.lease_id.clone(),
        outcome,
        result_digest: succeeded.then(|| DIGEST_B.into()),
        result_ref: succeeded.then(|| format!("cas:result:{}", claim.activity_id)),
        evidence_digest: DIGEST_C.into(),
        evidence_ref: format!("cas:evidence:{}", claim.activity_id),
        recorded_at: timestamp(recorded_at),
    }
}

fn retry_candidate_receipt(
    request: &ActionRequestedV2,
    outcome: ActionReceiptOutcomeV2,
    completed_at: DateTime<Utc>,
) -> ActionReceiptRecordedV2 {
    let succeeded = outcome == ActionReceiptOutcomeV2::Succeeded;
    ActionReceiptRecordedV2 {
        run_id: request.run_id.clone(),
        workflow_id: request.workflow_id.clone(),
        unit_id: request.unit_id.clone(),
        attempt: request.attempt,
        provenance_ref: request.provenance_ref.clone(),
        action_id: request.action_id.clone(),
        idempotency_key: request.idempotency_key.clone(),
        action_request_digest: action_requested_v2_digest(request).expect("hash action request"),
        dispatch_envelope_digest: request.dispatch_envelope_digest.clone(),
        capability_bundle_digest: request.capability_bundle_digest.clone(),
        policy_digest: request.policy_digest.clone(),
        context_manifest_digest: request.context_manifest_digest.clone(),
        worker_manifest_digest: request.worker_manifest_digest.clone(),
        sandbox_profile_digest: request.sandbox_profile_digest.clone(),
        authority_actor: request.authority_actor.clone(),
        execution_role: request.execution_role,
        outcome,
        result_digest: succeeded.then(|| DIGEST_B.into()),
        result_ref: succeeded.then(|| format!("cas:result:{}", request.action_id)),
        evidence_digest: DIGEST_C.into(),
        evidence_ref: format!("cas:evidence:{}", request.action_id),
        resource_usage: ActionResourceUsageV1 {
            wall_time_ms: 1,
            cpu_time_ms: Some(1),
            peak_memory_bytes: Some(1),
            input_bytes: Some(1),
            output_bytes: Some(1),
            input_tokens: None,
            output_tokens: None,
        },
        redactions: Vec::new(),
        failure: (!succeeded).then(|| ActionFailureV1 {
            code: "effect_failed".into(),
            message_digest: DIGEST_D.into(),
            retryable: true,
        }),
        authorization_ref: None,
        action_receipt_ref: format!("receipt:{}", request.action_id),
        completed_at: timestamp(completed_at),
    }
}

fn retry_candidate_receipt_set(
    request: &ActionRequestedV2,
    receipt: &ActionReceiptRecordedV2,
    sealed_at: DateTime<Utc>,
) -> ActionReceiptSetRecordedV1 {
    let mut set = ActionReceiptSetRecordedV1 {
        run_id: request.run_id.clone(),
        workflow_id: request.workflow_id.clone(),
        unit_id: request.unit_id.clone(),
        attempt: request.attempt,
        provenance_ref: request.provenance_ref.clone(),
        dispatch_envelope_digest: request.dispatch_envelope_digest.clone(),
        action_receipt_set_ref: format!("receipt-set:{}", request.action_id),
        action_receipt_set_digest: String::new(),
        receipts: vec![ActionReceiptSetEntryV1 {
            action_id: request.action_id.clone(),
            action_receipt_ref: receipt.action_receipt_ref.clone(),
            action_receipt_digest: action_receipt_recorded_v2_digest(receipt)
                .expect("hash action receipt"),
        }],
        sealed_at: timestamp(sealed_at),
    };
    set.action_receipt_set_digest = action_receipt_set_v1_digest(&set).expect("hash receipt set");
    set
}

fn retry_candidate_artifact(
    run_id: RunId,
    dispatch: &DispatchEnvelopeV3,
    receipt_set: &ActionReceiptSetRecordedV1,
    candidate_ref: String,
) -> CandidateCreatedV2 {
    CandidateCreatedV2 {
        run_id: run_id.to_string(),
        candidate_id: "retry-candidate-2".into(),
        candidate_ref,
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

fn retry_candidate_context(
    run_id: RunId,
    prior_dispatch: &DispatchEnvelopeV3,
    prior_terminal_event: &Event,
    prior_receipt: &ActionReceiptRecordedV2,
    retry_dispatch: &DispatchEnvelopeV3,
    recorded_at: DateTime<Utc>,
) -> AttemptContextRecordedV1 {
    let mut context = AttemptContextRecordedV1 {
        run_id: run_id.to_string(),
        workflow_id: prior_dispatch.body.workflow_id.clone(),
        workflow_revision: prior_dispatch.body.workflow_revision.clone(),
        unit_id: prior_dispatch.body.unit_id.clone(),
        prior_attempt: prior_dispatch.body.attempt,
        next_attempt: retry_dispatch.body.attempt,
        prior_dispatch_envelope_digest: prior_dispatch.envelope_digest.clone(),
        prior_terminal_event_ref: prior_terminal_event.id.to_string(),
        prior_terminal_event_digest: canonical_event_hash(prior_terminal_event)
            .expect("hash prior terminal"),
        prior_action_receipt_ref: prior_receipt.action_receipt_ref.clone(),
        prior_action_receipt_digest: action_receipt_recorded_v2_digest(prior_receipt)
            .expect("hash prior failed receipt"),
        feedback_ref: "cas:retry-feedback:workflow-1:implement-unit-1:2".into(),
        feedback_digest: DIGEST_D.into(),
        next_dispatch_envelope_digest: retry_dispatch.envelope_digest.clone(),
        next_dispatch_idempotency_key: retry_dispatch.body.idempotency_key.clone(),
        retry_action_namespace: RETRY_CANDIDATE_ACTION_NAMESPACE.into(),
        idempotency_key: "retry-context:workflow-1:implement-unit-1:1:2".into(),
        recorded_at: timestamp(recorded_at),
        attempt_context_digest: String::new(),
    };
    context.attempt_context_digest =
        attempt_context_recorded_v1_digest(&context).expect("hash retry context");
    context
}

fn append_retry_candidate_completion_evidence(
    store: &SqliteStore,
    kernel_key: &SigningKey,
    kernel: &ActorKeyRef,
    run_id: RunId,
    now: DateTime<Utc>,
    variant: RetryCandidateEvidenceVariant,
) -> GovernedCandidateCompletionRequestV1 {
    let prior_dispatch = dispatch(now, DIGEST_E);
    let prior_dispatch_event = event(
        run_id,
        None,
        EventKind::DispatchEnvelopeV3,
        now,
        Payload::DispatchEnvelopeV3(prior_dispatch.clone()),
    );
    store
        .append_signed(&prior_dispatch_event, kernel_key, kernel)
        .expect("append prior dispatch");

    let prior_request = retry_candidate_action_request(
        run_id,
        &prior_dispatch,
        "prior-attempt-effect".into(),
        "prior-attempt-effect:1".into(),
        now + Duration::seconds(1),
    );
    let prior_request_event = event(
        run_id,
        Some(prior_dispatch_event.id),
        EventKind::ActionRequestedV2,
        now + Duration::seconds(1),
        Payload::ActionRequestedV2(prior_request.clone()),
    );
    store
        .append_signed(&prior_request_event, kernel_key, kernel)
        .expect("append failed prior action request");
    let prior_claim = retry_candidate_claim(
        run_id,
        &prior_dispatch_event,
        &prior_request_event,
        &prior_request,
        now + Duration::seconds(2),
    );
    let prior_claim_event = event(
        run_id,
        Some(prior_request_event.id),
        EventKind::ActivityClaimedV1,
        now + Duration::seconds(2),
        Payload::ActivityClaimedV1(prior_claim.clone()),
    );
    store
        .append_signed(&prior_claim_event, kernel_key, kernel)
        .expect("append failed prior action claim");
    let prior_result = retry_candidate_result(
        &prior_claim_event,
        &prior_claim,
        ActivityResultOutcomeV1::Failed,
        now + Duration::seconds(3),
    );
    let prior_result_event = event(
        run_id,
        Some(prior_claim_event.id),
        EventKind::ActivityResultRecordedV1,
        now + Duration::seconds(3),
        Payload::ActivityResultRecordedV1(prior_result),
    );
    store
        .append_signed(&prior_result_event, kernel_key, kernel)
        .expect("append failed prior action result");
    let prior_receipt = retry_candidate_receipt(
        &prior_request,
        ActionReceiptOutcomeV2::Failed,
        now + Duration::seconds(3),
    );
    let prior_receipt_event = event(
        run_id,
        Some(prior_result_event.id),
        EventKind::ActionReceiptRecordedV2,
        now + Duration::seconds(3),
        Payload::ActionReceiptRecordedV2(prior_receipt.clone()),
    );
    store
        .append_signed(&prior_receipt_event, kernel_key, kernel)
        .expect("append failed prior action receipt");
    let prior_terminal = WorkflowTerminalV1 {
        workflow_id: prior_dispatch.body.workflow_id.clone(),
        workflow_revision: prior_dispatch.body.workflow_revision.clone(),
        unit_id: prior_dispatch.body.unit_id.clone(),
        attempt: prior_dispatch.body.attempt,
        outcome: WorkflowTerminalOutcomeV1::Failed,
        candidate_digest: None,
        promotion_result_ref: None,
        reconciliation_resolution_ref: None,
        reason: Some("prior action failed".into()),
        idempotency_key: "terminal:workflow-1:implement-unit-1:1".into(),
        completed_at: timestamp(now + Duration::seconds(4)),
    };
    let prior_terminal_event = event(
        run_id,
        Some(prior_receipt_event.id),
        EventKind::WorkflowTerminal,
        now + Duration::seconds(4),
        Payload::WorkflowTerminalV1(prior_terminal),
    );
    store
        .append_signed(&prior_terminal_event, kernel_key, kernel)
        .expect("append failed prior terminal");

    let mut retry_dispatch = retry_candidate_dispatch(now + Duration::seconds(6), DIGEST_E);
    if matches!(
        variant,
        RetryCandidateEvidenceVariant::ReusedPriorDispatchIdempotencyKey
    ) {
        retry_dispatch.body.idempotency_key = prior_dispatch.body.idempotency_key.clone();
    }
    if matches!(
        variant,
        RetryCandidateEvidenceVariant::ReviewerExecutionRole
    ) {
        retry_dispatch.body.execution_role = ExecutionRoleV1::Reviewer;
    }
    if matches!(
        variant,
        RetryCandidateEvidenceVariant::ReusedPriorDispatchIdempotencyKey
            | RetryCandidateEvidenceVariant::ReviewerExecutionRole
    ) {
        retry_dispatch.envelope_digest = dispatch_envelope_v3_body_digest(
            &retry_dispatch.body,
            retry_dispatch.action_evidence_version,
            &retry_dispatch.repository_binding_digest,
            &retry_dispatch.ledger_authority_realm_digest,
            retry_dispatch.governed_packet_digest.as_deref(),
        )
        .expect("rehash retry dispatch after evidence mutation");
    }
    let mut retry_context = retry_candidate_context(
        run_id,
        &prior_dispatch,
        &prior_terminal_event,
        &prior_receipt,
        &retry_dispatch,
        now + Duration::seconds(5),
    );
    if matches!(variant, RetryCandidateEvidenceVariant::SubstitutedContext) {
        retry_context.next_dispatch_envelope_digest = DIGEST_A.into();
    }
    if matches!(
        variant,
        RetryCandidateEvidenceVariant::ReusedPriorActionIdempotencyNamespace
    ) {
        retry_context.retry_action_namespace = prior_request.idempotency_key.clone();
    }
    if matches!(
        variant,
        RetryCandidateEvidenceVariant::SubstitutedContext
            | RetryCandidateEvidenceVariant::ReusedPriorActionIdempotencyNamespace
    ) {
        retry_context.attempt_context_digest =
            attempt_context_recorded_v1_digest(&retry_context).expect("rehash retry context");
    }
    let retry_action_namespace = retry_context.retry_action_namespace.clone();
    let retry_dispatch_parent_event_id =
        if matches!(variant, RetryCandidateEvidenceVariant::MissingContext) {
            prior_terminal_event.id
        } else {
            let retry_context_event = event(
                run_id,
                Some(prior_terminal_event.id),
                EventKind::AttemptContextRecordedV1,
                now + Duration::seconds(5),
                Payload::AttemptContextRecordedV1(retry_context),
            );
            store
                .append_signed(&retry_context_event, kernel_key, kernel)
                .expect("append signed retry context");
            retry_context_event.id
        };
    let retry_dispatch_event = event(
        run_id,
        Some(retry_dispatch_parent_event_id),
        EventKind::DispatchEnvelopeV3,
        now + Duration::seconds(6),
        Payload::DispatchEnvelopeV3(retry_dispatch.clone()),
    );
    store
        .append_signed(&retry_dispatch_event, kernel_key, kernel)
        .expect("append retry dispatch");

    let candidate_ref = match variant {
        RetryCandidateEvidenceVariant::CandidateRefForAnotherRun => retry_candidate_ref_for(
            "retry-candidate-2",
            RunId::new(),
            retry_dispatch.body.attempt,
        ),
        RetryCandidateEvidenceVariant::CandidateRefForWrongAttempt => {
            retry_candidate_ref_for("retry-candidate-2", run_id, retry_dispatch.body.attempt + 1)
        }
        RetryCandidateEvidenceVariant::CandidateIdDoesNotMatchRef => retry_candidate_ref_for(
            "different-candidate-id",
            run_id,
            retry_dispatch.body.attempt,
        ),
        _ => retry_candidate_ref_for("retry-candidate-2", run_id, retry_dispatch.body.attempt),
    };
    let candidate_key = candidate_ref
        .strip_prefix("refs/buildplane/candidates/")
        .expect("retry candidate ref is canonical");
    let expected_candidate_action_id =
        format!("{retry_action_namespace}:git-candidate-create:{candidate_key}");
    let (candidate_action_id, candidate_action_idempotency_key) = match variant {
        RetryCandidateEvidenceVariant::Valid
        | RetryCandidateEvidenceVariant::CandidateRefForAnotherRun
        | RetryCandidateEvidenceVariant::CandidateRefForWrongAttempt
        | RetryCandidateEvidenceVariant::CandidateIdDoesNotMatchRef
        | RetryCandidateEvidenceVariant::ReviewerExecutionRole
        | RetryCandidateEvidenceVariant::MissingContext
        | RetryCandidateEvidenceVariant::SubstitutedContext
        | RetryCandidateEvidenceVariant::ReusedPriorDispatchIdempotencyKey
        | RetryCandidateEvidenceVariant::ReusedPriorActionIdempotencyNamespace => (
            expected_candidate_action_id.clone(),
            format!("{expected_candidate_action_id}:idempotency"),
        ),
        RetryCandidateEvidenceVariant::AlteredCandidateActionId => (
            format!("{expected_candidate_action_id}:substituted"),
            format!("{expected_candidate_action_id}:substituted:idempotency"),
        ),
        RetryCandidateEvidenceVariant::AlteredCandidateIdempotencyKey => (
            expected_candidate_action_id.clone(),
            format!("{expected_candidate_action_id}:substituted-idempotency"),
        ),
        RetryCandidateEvidenceVariant::LegacyRetryActionIdentity => (
            format!("git-candidate-create:{candidate_key}"),
            format!("git-candidate-create:{candidate_key}:idempotency"),
        ),
    };
    let retry_request = retry_candidate_action_request(
        run_id,
        &retry_dispatch,
        candidate_action_id,
        candidate_action_idempotency_key,
        now + Duration::seconds(7),
    );
    let retry_request_event = event(
        run_id,
        Some(retry_dispatch_event.id),
        EventKind::ActionRequestedV2,
        now + Duration::seconds(7),
        Payload::ActionRequestedV2(retry_request.clone()),
    );
    store
        .append_signed(&retry_request_event, kernel_key, kernel)
        .expect("append namespaced retry candidate action request");
    let retry_claim = retry_candidate_claim(
        run_id,
        &retry_dispatch_event,
        &retry_request_event,
        &retry_request,
        now + Duration::seconds(8),
    );
    let retry_claim_event = event(
        run_id,
        Some(retry_request_event.id),
        EventKind::ActivityClaimedV1,
        now + Duration::seconds(8),
        Payload::ActivityClaimedV1(retry_claim.clone()),
    );
    store
        .append_signed(&retry_claim_event, kernel_key, kernel)
        .expect("append retry candidate action claim");
    let retry_result = retry_candidate_result(
        &retry_claim_event,
        &retry_claim,
        ActivityResultOutcomeV1::Succeeded,
        now + Duration::seconds(9),
    );
    let retry_result_event = event(
        run_id,
        Some(retry_claim_event.id),
        EventKind::ActivityResultRecordedV1,
        now + Duration::seconds(9),
        Payload::ActivityResultRecordedV1(retry_result),
    );
    store
        .append_signed(&retry_result_event, kernel_key, kernel)
        .expect("append retry candidate action result");
    let retry_receipt = retry_candidate_receipt(
        &retry_request,
        ActionReceiptOutcomeV2::Succeeded,
        now + Duration::seconds(9),
    );
    let retry_receipt_event = event(
        run_id,
        Some(retry_result_event.id),
        EventKind::ActionReceiptRecordedV2,
        now + Duration::seconds(9),
        Payload::ActionReceiptRecordedV2(retry_receipt.clone()),
    );
    store
        .append_signed(&retry_receipt_event, kernel_key, kernel)
        .expect("append retry candidate action receipt");
    let retry_receipt_set =
        retry_candidate_receipt_set(&retry_request, &retry_receipt, now + Duration::seconds(10));
    let retry_receipt_set_event = event(
        run_id,
        Some(retry_receipt_event.id),
        EventKind::ActionReceiptSetRecordedV1,
        now + Duration::seconds(10),
        Payload::ActionReceiptSetRecordedV1(retry_receipt_set.clone()),
    );
    store
        .append_signed(&retry_receipt_set_event, kernel_key, kernel)
        .expect("append retry candidate receipt set");
    let candidate =
        retry_candidate_artifact(run_id, &retry_dispatch, &retry_receipt_set, candidate_ref);
    let candidate_event = event(
        run_id,
        Some(retry_receipt_set_event.id),
        EventKind::CandidateCreatedV2,
        now + Duration::seconds(11),
        Payload::CandidateCreatedV2(candidate),
    );
    store
        .append_signed(&candidate_event, kernel_key, kernel)
        .expect("append retry candidate");

    GovernedCandidateCompletionRequestV1 {
        run_id,
        dispatch_event_id: retry_dispatch_event.id,
        candidate_created_event_id: candidate_event.id,
    }
}

fn append_retry_candidate_claim_request(
    store: &SqliteStore,
    kernel_key: &SigningKey,
    kernel: &ActorKeyRef,
    run_id: RunId,
    retry_dispatch_event_id: EventId,
    now: DateTime<Utc>,
    execution_role: ExecutionRoleV1,
    action_id: String,
    idempotency_key: String,
) -> ActivityClaimRequestV1 {
    let mut retry_dispatch = retry_candidate_dispatch(now + Duration::seconds(6), DIGEST_E);
    retry_dispatch.body.execution_role = execution_role;
    retry_dispatch.envelope_digest = dispatch_envelope_v3_body_digest(
        &retry_dispatch.body,
        retry_dispatch.action_evidence_version,
        &retry_dispatch.repository_binding_digest,
        &retry_dispatch.ledger_authority_realm_digest,
        retry_dispatch.governed_packet_digest.as_deref(),
    )
    .expect("rehash retry candidate claim dispatch");
    let action_request = retry_candidate_action_request(
        run_id,
        &retry_dispatch,
        action_id.clone(),
        idempotency_key.clone(),
        now + Duration::seconds(12),
    );
    let action_request_event = event(
        run_id,
        Some(retry_dispatch_event_id),
        EventKind::ActionRequestedV2,
        now + Duration::seconds(12),
        Payload::ActionRequestedV2(action_request),
    );
    store
        .append_signed(&action_request_event, kernel_key, kernel)
        .expect("append retry candidate claim action request");
    ActivityClaimRequestV1 {
        run_id,
        activity_id: action_id,
        idempotency_key,
        dispatch_event_id: retry_dispatch_event_id,
        action_request_event_id: action_request_event.id,
        lease_duration_ms: 1_000,
    }
}

fn retry_candidate_activity_claim_authority(
    kernel_key: &SigningKey,
    kernel: &ActorKeyRef,
) -> ActivityClaimAuthorityV1 {
    ActivityClaimAuthorityV1::new_governed_realm(
        trusted_keys(&[kernel_key]),
        kernel.clone(),
        kernel.clone(),
        kernel.clone(),
        DIGEST_E.into(),
    )
    .expect("construct retry candidate activity-claim authority")
}

fn assert_retry_candidate_claim_rejected_before_lease(
    evidence_variant: RetryCandidateEvidenceVariant,
    action_namespace: &str,
    exact_idempotency_key: bool,
    expected_reason_fragment: &str,
) {
    let store = SqliteStore::open_in_memory().expect("open retry candidate claim store");
    let kernel_key = SigningKey::from_bytes(&[71; 32]);
    let kernel = actor("kernel", "kernel-main", &kernel_key);
    let now = retry_candidate_fixture_time();
    let run_id = RunId::new();
    let completion_request = append_retry_candidate_completion_evidence(
        &store,
        &kernel_key,
        &kernel,
        run_id,
        now,
        evidence_variant,
    );
    let action_id =
        format!("{action_namespace}:git-candidate-create:workflow-1/implement-unit-1/2");
    let idempotency_key = if exact_idempotency_key {
        format!("{action_id}:idempotency")
    } else {
        format!("{action_id}:caller-supplied")
    };
    let claim_request = append_retry_candidate_claim_request(
        &store,
        &kernel_key,
        &kernel,
        run_id,
        completion_request.dispatch_event_id,
        now,
        ExecutionRoleV1::Implementer,
        action_id.clone(),
        idempotency_key,
    );
    let event_count_before_claim = store.event_count().expect("count claim preflight tape");
    let authority = retry_candidate_activity_claim_authority(&kernel_key, &kernel);

    let error = store
        .claim_activity_v1_at_for_tests(
            &claim_request,
            &authority,
            &kernel_key,
            &kernel,
            now + Duration::seconds(13),
        )
        .expect_err("invalid retry candidate namespace must not mint a lease");
    match error {
        LedgerError::ActivityClaimAuthorityRejected { reason } => {
            assert!(
                reason.contains(expected_reason_fragment),
                "expected rejection containing {expected_reason_fragment:?}, got {reason:?}"
            );
        }
        other => panic!("expected activity-claim authority rejection, got {other:?}"),
    }
    assert_eq!(
        store
            .event_count()
            .expect("count rejected retry candidate claim"),
        event_count_before_claim,
        "the invalid retry candidate claim must fail before appending a lease"
    );
}

fn assert_retry_candidate_claim_candidate_key_rejected_before_lease(
    candidate_key: &str,
    expected_reason_fragment: &str,
) {
    let store = SqliteStore::open_in_memory().expect("open candidate-key claim store");
    let kernel_key = SigningKey::from_bytes(&[71; 32]);
    let kernel = actor("kernel", "kernel-main", &kernel_key);
    let authority = retry_candidate_activity_claim_authority(&kernel_key, &kernel);
    let now = retry_candidate_fixture_time();
    let run_id = RunId::new();
    let completion_request = append_retry_candidate_completion_evidence(
        &store,
        &kernel_key,
        &kernel,
        run_id,
        now,
        RetryCandidateEvidenceVariant::Valid,
    );
    let action_id =
        format!("{RETRY_CANDIDATE_ACTION_NAMESPACE}:git-candidate-create:{candidate_key}");
    let claim_request = append_retry_candidate_claim_request(
        &store,
        &kernel_key,
        &kernel,
        run_id,
        completion_request.dispatch_event_id,
        now,
        ExecutionRoleV1::Implementer,
        action_id.clone(),
        format!("{action_id}:idempotency"),
    );
    let event_count_before_claim = store.event_count().expect("count candidate-key claim tape");

    let error = store
        .claim_activity_v1_at_for_tests(
            &claim_request,
            &authority,
            &kernel_key,
            &kernel,
            now + Duration::seconds(13),
        )
        .expect_err("an invalid retry candidate key must not mint a lease");
    match error {
        LedgerError::ActivityClaimAuthorityRejected { reason } => {
            assert!(
                reason.contains(expected_reason_fragment),
                "expected rejection containing {expected_reason_fragment:?}, got {reason:?}"
            );
        }
        other => panic!("expected activity-claim authority rejection, got {other:?}"),
    }
    assert_eq!(
        store
            .event_count()
            .expect("count rejected candidate-key claim"),
        event_count_before_claim,
        "the generic claim verifier must reject an invalid candidate key before appending a lease"
    );
}

fn retry_candidate_completion_authority(
    kernel_key: &SigningKey,
    reviewer_key: &SigningKey,
    operator_key: &SigningKey,
) -> (ActorKeyRef, GovernedPromotionAuthorityV1) {
    let kernel = actor("kernel", "kernel-main", kernel_key);
    let reviewer = actor("reviewer", "reviewer-main", reviewer_key);
    let operator = actor("operator", "operator-main", operator_key);
    let authority = GovernedPromotionAuthorityV1::new_governed_realm(
        trusted_keys(&[kernel_key, reviewer_key, operator_key]),
        kernel.clone(),
        vec![reviewer],
        operator,
        DIGEST_E.into(),
    )
    .expect("construct governed authority");
    (kernel, authority)
}

fn retry_candidate_fixture_time() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-07-25T12:00:00.000Z")
        .expect("parse fixture time")
        .with_timezone(&Utc)
}

fn assert_retry_candidate_completion_rejected(
    variant: RetryCandidateEvidenceVariant,
    expected_reason_fragment: &str,
    expected_event_count: u64,
) {
    let store = SqliteStore::open_in_memory().expect("open candidate completion store");
    let kernel_key = SigningKey::from_bytes(&[71; 32]);
    let reviewer_key = SigningKey::from_bytes(&[72; 32]);
    let operator_key = SigningKey::from_bytes(&[73; 32]);
    let (kernel, authority) =
        retry_candidate_completion_authority(&kernel_key, &reviewer_key, &operator_key);
    let request = append_retry_candidate_completion_evidence(
        &store,
        &kernel_key,
        &kernel,
        RunId::new(),
        retry_candidate_fixture_time(),
        variant,
    );

    let error = store
        .record_governed_candidate_completion_v1(&request, &authority, &kernel_key, &kernel)
        .expect_err("the malformed sealed-V3 retry cannot record completion");
    match error {
        LedgerError::CandidateCompletionAuthorityRejected { reason } => {
            assert!(
                reason.contains(expected_reason_fragment),
                "expected rejection containing {expected_reason_fragment:?}, got {reason:?}"
            );
        }
        other => panic!("expected candidate-completion authority rejection, got {other:?}"),
    }
    assert_eq!(
        store.event_count().expect("count rejected completion tape"),
        expected_event_count,
        "a rejected retry completion must not append a completion or checkpoint"
    );
}

fn retry_candidate_identity_request(
    completion_request: &GovernedCandidateCompletionRequestV1,
) -> ResolveGovernedV3RetryCandidateActionIdentityRequestV1 {
    ResolveGovernedV3RetryCandidateActionIdentityRequestV1 {
        run_id: completion_request.run_id,
        dispatch_event_id: completion_request.dispatch_event_id,
        candidate_ref: retry_candidate_ref_for("retry-candidate-2", completion_request.run_id, 2),
    }
}

fn retry_candidate_ref_for(candidate_id: &str, run_id: RunId, attempt: u32) -> String {
    format!("refs/buildplane/candidates/{candidate_id}/{run_id}/{attempt}")
}

fn assert_governed_v3_retry_candidate_identity_rejected(
    store: &SqliteStore,
    request: &ResolveGovernedV3RetryCandidateActionIdentityRequestV1,
    authority: &ActivityClaimAuthorityV1,
    expected_reason_fragment: &str,
) {
    let event_count_before_resolution = store.event_count().expect("count resolver preflight tape");
    let error = store
        .resolve_governed_v3_retry_candidate_action_identity_v1(request, authority)
        .expect_err("invalid governed retry candidate identity must not resolve");
    match error {
        LedgerError::ActivityClaimAuthorityRejected { reason } => {
            assert!(
                reason.contains(expected_reason_fragment),
                "expected rejection containing {expected_reason_fragment:?}, got {reason:?}"
            );
        }
        other => panic!("expected activity-claim authority rejection, got {other:?}"),
    }
    assert_eq!(
        store.event_count().expect("count rejected resolver tape"),
        event_count_before_resolution,
        "the read-only resolver must not append records when it rejects"
    );
}

#[test]
fn governed_v3_retry_candidate_identity_resolver_derives_the_exact_namespaced_identity_read_only() {
    let store = SqliteStore::open_in_memory().expect("open retry identity resolver store");
    let kernel_key = SigningKey::from_bytes(&[71; 32]);
    let kernel = actor("kernel", "kernel-main", &kernel_key);
    let authority = retry_candidate_activity_claim_authority(&kernel_key, &kernel);
    let completion_request = append_retry_candidate_completion_evidence(
        &store,
        &kernel_key,
        &kernel,
        RunId::new(),
        retry_candidate_fixture_time(),
        RetryCandidateEvidenceVariant::Valid,
    );
    let request = retry_candidate_identity_request(&completion_request);
    let event_count_before_resolution = store.event_count().expect("count resolver preflight tape");

    let resolved = store
        .resolve_governed_v3_retry_candidate_action_identity_v1(&request, &authority)
        .expect("a valid sealed-V3 retry derives its candidate action identity");

    let candidate_key = request
        .candidate_ref
        .strip_prefix("refs/buildplane/candidates/")
        .expect("resolver request has a canonical candidate ref");
    let expected_action_id =
        format!("{RETRY_CANDIDATE_ACTION_NAMESPACE}:git-candidate-create:{candidate_key}");
    assert_eq!(resolved.action_id, expected_action_id);
    assert_eq!(resolved.activity_id, expected_action_id);
    assert_eq!(
        resolved.idempotency_key,
        format!("{expected_action_id}:idempotency")
    );
    assert_eq!(
        store.event_count().expect("count resolved identity tape"),
        event_count_before_resolution,
        "the read-only resolver must not append an action, claim, or effect"
    );
}

#[test]
fn governed_v3_retry_candidate_identity_resolver_rejects_a_malformed_candidate_ref_before_lookup() {
    let store = SqliteStore::open_in_memory().expect("open malformed identity resolver store");
    let kernel_key = SigningKey::from_bytes(&[71; 32]);
    let kernel = actor("kernel", "kernel-main", &kernel_key);
    let authority = retry_candidate_activity_claim_authority(&kernel_key, &kernel);
    let request = ResolveGovernedV3RetryCandidateActionIdentityRequestV1 {
        run_id: RunId::new(),
        dispatch_event_id: EventId::new(),
        candidate_ref: "refs/heads/main".into(),
    };

    assert_governed_v3_retry_candidate_identity_rejected(
        &store,
        &request,
        &authority,
        "canonical Buildplane candidate ref",
    );
}

#[test]
fn governed_v3_retry_candidate_identity_resolver_rejects_an_out_of_run_dispatch() {
    let store = SqliteStore::open_in_memory().expect("open out-of-run identity resolver store");
    let kernel_key = SigningKey::from_bytes(&[71; 32]);
    let kernel = actor("kernel", "kernel-main", &kernel_key);
    let authority = retry_candidate_activity_claim_authority(&kernel_key, &kernel);
    let completion_request = append_retry_candidate_completion_evidence(
        &store,
        &kernel_key,
        &kernel,
        RunId::new(),
        retry_candidate_fixture_time(),
        RetryCandidateEvidenceVariant::Valid,
    );
    let mut request = retry_candidate_identity_request(&completion_request);
    request.run_id = RunId::new();

    assert_governed_v3_retry_candidate_identity_rejected(
        &store,
        &request,
        &authority,
        "run_id does not match",
    );
}

#[test]
fn governed_v3_retry_candidate_identity_resolver_rejects_a_candidate_ref_for_another_run() {
    let store = SqliteStore::open_in_memory().expect("open wrong-ref-run identity resolver store");
    let kernel_key = SigningKey::from_bytes(&[71; 32]);
    let kernel = actor("kernel", "kernel-main", &kernel_key);
    let authority = retry_candidate_activity_claim_authority(&kernel_key, &kernel);
    let completion_request = append_retry_candidate_completion_evidence(
        &store,
        &kernel_key,
        &kernel,
        RunId::new(),
        retry_candidate_fixture_time(),
        RetryCandidateEvidenceVariant::Valid,
    );
    let mut request = retry_candidate_identity_request(&completion_request);
    request.candidate_ref = retry_candidate_ref_for("retry-candidate-2", RunId::new(), 2);

    assert_governed_v3_retry_candidate_identity_rejected(
        &store,
        &request,
        &authority,
        "candidate_ref must bind the signed run and attempt",
    );
}

#[test]
fn governed_v3_retry_candidate_identity_resolver_remains_candidate_id_agnostic_before_creation() {
    let store = SqliteStore::open_in_memory().expect("open pre-creation identity resolver store");
    let kernel_key = SigningKey::from_bytes(&[71; 32]);
    let kernel = actor("kernel", "kernel-main", &kernel_key);
    let authority = retry_candidate_activity_claim_authority(&kernel_key, &kernel);
    let completion_request = append_retry_candidate_completion_evidence(
        &store,
        &kernel_key,
        &kernel,
        RunId::new(),
        retry_candidate_fixture_time(),
        RetryCandidateEvidenceVariant::Valid,
    );
    let mut request = retry_candidate_identity_request(&completion_request);
    request.candidate_ref =
        retry_candidate_ref_for("candidate-id-not-yet-bound-by-dispatch", request.run_id, 2);
    let event_count_before_resolution = store.event_count().expect("count resolver preflight tape");

    let resolved = store
        .resolve_governed_v3_retry_candidate_action_identity_v1(&request, &authority)
        .expect("the pre-effect resolver cannot bind a candidate id absent from the dispatch");

    let candidate_key = request
        .candidate_ref
        .strip_prefix("refs/buildplane/candidates/")
        .expect("resolver request has a canonical candidate ref");
    assert_eq!(
        resolved.action_id,
        format!("{RETRY_CANDIDATE_ACTION_NAMESPACE}:git-candidate-create:{candidate_key}")
    );
    assert_eq!(
        store.event_count().expect("count resolver postflight tape"),
        event_count_before_resolution,
        "the pre-effect resolver remains read-only"
    );
}

#[test]
fn governed_v3_retry_candidate_identity_resolver_rejects_a_reused_signed_retry_context() {
    let store = SqliteStore::open_in_memory().expect("open reused-context identity resolver store");
    let kernel_key = SigningKey::from_bytes(&[71; 32]);
    let kernel = actor("kernel", "kernel-main", &kernel_key);
    let authority = retry_candidate_activity_claim_authority(&kernel_key, &kernel);
    let completion_request = append_retry_candidate_completion_evidence(
        &store,
        &kernel_key,
        &kernel,
        RunId::new(),
        retry_candidate_fixture_time(),
        RetryCandidateEvidenceVariant::ReusedPriorActionIdempotencyNamespace,
    );
    let request = retry_candidate_identity_request(&completion_request);

    assert_governed_v3_retry_candidate_identity_rejected(
        &store,
        &request,
        &authority,
        "reuses a prior dispatch or action idempotency namespace",
    );
}

#[test]
fn governed_v3_retry_candidate_identity_resolver_rejects_a_graph_bound_v4_retry() {
    let store = SqliteStore::open_in_memory().expect("open V4 identity resolver store");
    let kernel_key = SigningKey::from_bytes(&[71; 32]);
    let kernel = actor("kernel", "kernel-main", &kernel_key);
    let authority = retry_candidate_activity_claim_authority(&kernel_key, &kernel);
    let run_id = RunId::new();
    let dispatch = graph_bound_dispatch_v4(retry_candidate_dispatch(
        retry_candidate_fixture_time(),
        DIGEST_E,
    ));
    let dispatch_event = event(
        run_id,
        None,
        EventKind::DispatchEnvelopeV4,
        retry_candidate_fixture_time(),
        Payload::DispatchEnvelopeV4(dispatch),
    );
    store
        .append_signed(&dispatch_event, &kernel_key, &kernel)
        .expect("append graph-bound V4 retry dispatch");
    let request = ResolveGovernedV3RetryCandidateActionIdentityRequestV1 {
        run_id,
        dispatch_event_id: dispatch_event.id,
        candidate_ref: retry_candidate_ref_for("retry-candidate-v4", run_id, 2),
    };

    assert_governed_v3_retry_candidate_identity_rejected(
        &store,
        &request,
        &authority,
        "only outer sealed-V3 dispatch envelopes",
    );
}

#[test]
fn governed_v3_retry_candidate_identity_resolver_rejects_a_manifest_bound_v5_retry() {
    let store = SqliteStore::open_in_memory().expect("open V5 identity resolver store");
    let kernel_key = SigningKey::from_bytes(&[71; 32]);
    let kernel = actor("kernel", "kernel-main", &kernel_key);
    let authority = retry_candidate_activity_claim_authority(&kernel_key, &kernel);
    let run_id = RunId::new();
    let dispatch = manifest_bound_retry_dispatch_v5(retry_candidate_fixture_time());
    let dispatch_event = event(
        run_id,
        None,
        EventKind::DispatchEnvelopeV5,
        retry_candidate_fixture_time(),
        Payload::DispatchEnvelopeV5(dispatch),
    );
    store
        .append_signed(&dispatch_event, &kernel_key, &kernel)
        .expect("append manifest-bound V5 retry dispatch");
    let request = ResolveGovernedV3RetryCandidateActionIdentityRequestV1 {
        run_id,
        dispatch_event_id: dispatch_event.id,
        candidate_ref: retry_candidate_ref_for("retry-candidate-v5", run_id, 2),
    };

    assert_governed_v3_retry_candidate_identity_rejected(
        &store,
        &request,
        &authority,
        "only outer sealed-V3 dispatch envelopes",
    );
}

#[test]
fn governed_v3_retry_candidate_identity_resolver_rejects_a_first_attempt_dispatch() {
    let store = SqliteStore::open_in_memory().expect("open attempt-one identity resolver store");
    let kernel_key = SigningKey::from_bytes(&[71; 32]);
    let kernel = actor("kernel", "kernel-main", &kernel_key);
    let authority = retry_candidate_activity_claim_authority(&kernel_key, &kernel);
    let run_id = RunId::new();
    let dispatch = dispatch(retry_candidate_fixture_time(), DIGEST_E);
    let dispatch_event = event(
        run_id,
        None,
        EventKind::DispatchEnvelopeV3,
        retry_candidate_fixture_time(),
        Payload::DispatchEnvelopeV3(dispatch),
    );
    store
        .append_signed(&dispatch_event, &kernel_key, &kernel)
        .expect("append first-attempt sealed-V3 dispatch");
    let request = ResolveGovernedV3RetryCandidateActionIdentityRequestV1 {
        run_id,
        dispatch_event_id: dispatch_event.id,
        candidate_ref: retry_candidate_ref_for("retry-candidate-attempt-one", run_id, 1),
    };

    assert_governed_v3_retry_candidate_identity_rejected(
        &store,
        &request,
        &authority,
        "attempt greater than one",
    );
}

#[test]
fn governed_candidate_completion_records_a_valid_sealed_v3_attempt_two_retry() {
    let store = SqliteStore::open_in_memory().expect("open candidate completion store");
    let kernel_key = SigningKey::from_bytes(&[71; 32]);
    let reviewer_key = SigningKey::from_bytes(&[72; 32]);
    let operator_key = SigningKey::from_bytes(&[73; 32]);
    let (kernel, authority) =
        retry_candidate_completion_authority(&kernel_key, &reviewer_key, &operator_key);
    let request = append_retry_candidate_completion_evidence(
        &store,
        &kernel_key,
        &kernel,
        RunId::new(),
        retry_candidate_fixture_time(),
        RetryCandidateEvidenceVariant::Valid,
    );

    let completion = store
        .record_governed_candidate_completion_v1(&request, &authority, &kernel_key, &kernel)
        .expect("a signed, namespaced sealed-V3 attempt-2 retry records completion");
    assert!(matches!(
        completion,
        GovernedCandidateCompletionDispositionV1::Recorded { .. }
    ));
    assert_eq!(
        store
            .event_count()
            .expect("count candidate completion tape"),
        16,
        "completion and its checkpoint are the only writer additions"
    );
}

#[test]
fn governed_candidate_completion_rejects_a_canonical_retry_candidate_ref_for_another_run() {
    assert_retry_candidate_completion_rejected(
        RetryCandidateEvidenceVariant::CandidateRefForAnotherRun,
        "candidate ref must bind the signed candidate id, run, and attempt",
        14,
    );
}

#[test]
fn governed_candidate_completion_rejects_a_canonical_retry_candidate_ref_for_the_wrong_attempt() {
    assert_retry_candidate_completion_rejected(
        RetryCandidateEvidenceVariant::CandidateRefForWrongAttempt,
        "candidate ref must bind the signed candidate id, run, and attempt",
        14,
    );
}

#[test]
fn governed_candidate_completion_rejects_a_canonical_retry_ref_with_a_different_candidate_id() {
    assert_retry_candidate_completion_rejected(
        RetryCandidateEvidenceVariant::CandidateIdDoesNotMatchRef,
        "candidate ref must bind the signed candidate id, run, and attempt",
        14,
    );
}

#[test]
fn governed_candidate_completion_rejects_an_altered_sealed_v3_retry_candidate_action_id() {
    assert_retry_candidate_completion_rejected(
        RetryCandidateEvidenceVariant::AlteredCandidateActionId,
        "does not derive the candidate-create action",
        14,
    );
}

#[test]
fn governed_candidate_completion_rejects_an_altered_sealed_v3_retry_candidate_idempotency_key() {
    assert_retry_candidate_completion_rejected(
        RetryCandidateEvidenceVariant::AlteredCandidateIdempotencyKey,
        "candidate action idempotency_key does not match",
        14,
    );
}

#[test]
fn governed_candidate_completion_rejects_a_missing_sealed_v3_retry_context() {
    assert_retry_candidate_completion_rejected(
        RetryCandidateEvidenceVariant::MissingContext,
        "requires one signed recorded prior-attempt context",
        13,
    );
}

#[test]
fn governed_candidate_completion_rejects_a_substituted_sealed_v3_retry_context() {
    assert_retry_candidate_completion_rejected(
        RetryCandidateEvidenceVariant::SubstitutedContext,
        "does not bind the exact next sealed-V3 dispatch envelope digest and idempotency key",
        14,
    );
}

#[test]
fn governed_candidate_completion_rejects_a_legacy_retry_action_identity() {
    assert_retry_candidate_completion_rejected(
        RetryCandidateEvidenceVariant::LegacyRetryActionIdentity,
        "action_id and idempotency_key must each use the signed retry action namespace",
        14,
    );
}

#[test]
fn governed_candidate_completion_rejects_a_retry_context_reusing_prior_dispatch_idempotency() {
    assert_retry_candidate_completion_rejected(
        RetryCandidateEvidenceVariant::ReusedPriorDispatchIdempotencyKey,
        "reuses a prior dispatch or action idempotency namespace",
        14,
    );
}

#[test]
fn governed_candidate_completion_rejects_a_retry_context_reusing_prior_action_idempotency() {
    assert_retry_candidate_completion_rejected(
        RetryCandidateEvidenceVariant::ReusedPriorActionIdempotencyNamespace,
        "reuses a prior dispatch or action idempotency namespace",
        14,
    );
}

#[test]
fn governed_retry_candidate_claim_rejects_a_caller_selected_namespace_before_lease() {
    assert_retry_candidate_claim_rejected_before_lease(
        RetryCandidateEvidenceVariant::Valid,
        "caller-selected-retry-namespace",
        true,
        "action_id must derive from the exact signed retry action namespace",
    );
}

#[test]
fn governed_retry_candidate_claim_rejects_a_reused_prior_namespace_before_lease() {
    assert_retry_candidate_claim_rejected_before_lease(
        RetryCandidateEvidenceVariant::ReusedPriorActionIdempotencyNamespace,
        "prior-attempt-effect:1",
        true,
        "reuses a prior dispatch or action idempotency namespace",
    );
}

#[test]
fn governed_retry_candidate_claim_rejects_a_noncanonical_idempotency_before_lease() {
    assert_retry_candidate_claim_rejected_before_lease(
        RetryCandidateEvidenceVariant::Valid,
        RETRY_CANDIDATE_ACTION_NAMESPACE,
        false,
        "idempotency_key must exactly derive from its action_id",
    );
}

#[test]
fn governed_retry_candidate_claim_rejects_a_traversal_like_candidate_key_before_lease() {
    assert_retry_candidate_claim_candidate_key_rejected_before_lease(
        "../escaped",
        "candidate key must form a canonical Buildplane candidate ref",
    );
}

#[test]
fn governed_retry_candidate_claim_rejects_a_candidate_key_for_another_run_before_lease() {
    assert_retry_candidate_claim_candidate_key_rejected_before_lease(
        "candidate-retry/not-the-request-run/2",
        "candidate key must bind the signed run and attempt",
    );
}

#[test]
fn governed_retry_candidate_claim_rejects_an_unbound_authority_before_lease() {
    let store = SqliteStore::open_in_memory().expect("open unbound retry candidate claim store");
    let kernel_key = SigningKey::from_bytes(&[71; 32]);
    let kernel = actor("kernel", "kernel-main", &kernel_key);
    let now = retry_candidate_fixture_time();
    let run_id = RunId::new();
    let completion_request = append_retry_candidate_completion_evidence(
        &store,
        &kernel_key,
        &kernel,
        run_id,
        now,
        RetryCandidateEvidenceVariant::Valid,
    );
    let protected_authority = retry_candidate_activity_claim_authority(&kernel_key, &kernel);
    let resolved = store
        .resolve_governed_v3_retry_candidate_action_identity_v1(
            &retry_candidate_identity_request(&completion_request),
            &protected_authority,
        )
        .expect("resolve the valid retry candidate action identity before testing its claim");
    let claim_request = append_retry_candidate_claim_request(
        &store,
        &kernel_key,
        &kernel,
        run_id,
        completion_request.dispatch_event_id,
        now,
        ExecutionRoleV1::Implementer,
        resolved.action_id,
        resolved.idempotency_key,
    );
    let authority = ActivityClaimAuthorityV1::new(
        trusted_keys(&[&kernel_key]),
        kernel.clone(),
        kernel.clone(),
        kernel.clone(),
    )
    .expect("construct unbound activity-claim authority");
    let event_count_before_claim = store.event_count().expect("count unbound claim tape");

    let error = store
        .claim_activity_v1_at_for_tests(
            &claim_request,
            &authority,
            &kernel_key,
            &kernel,
            now + Duration::seconds(13),
        )
        .expect_err("an unbound authority must not mint a retry candidate lease");
    assert!(
        matches!(
            error,
            LedgerError::ActivityClaimAuthorityRejected { ref reason }
                if reason.contains("configured protected activity authority realm")
        ),
        "expected an unbound-realm rejection, got {error:?}"
    );
    assert_eq!(
        store.event_count().expect("count rejected unbound claim"),
        event_count_before_claim,
        "an unbound retry candidate claim must fail before appending a lease"
    );
}

#[test]
fn governed_retry_candidate_claim_rejects_a_reviewer_retry_dispatch_before_lease() {
    let store = SqliteStore::open_in_memory().expect("open reviewer retry candidate claim store");
    let kernel_key = SigningKey::from_bytes(&[71; 32]);
    let kernel = actor("kernel", "kernel-main", &kernel_key);
    let now = retry_candidate_fixture_time();
    let run_id = RunId::new();
    let completion_request = append_retry_candidate_completion_evidence(
        &store,
        &kernel_key,
        &kernel,
        run_id,
        now,
        RetryCandidateEvidenceVariant::ReviewerExecutionRole,
    );
    let candidate_ref = retry_candidate_ref_for("reviewer-retry-candidate", run_id, 2);
    let candidate_key = candidate_ref
        .strip_prefix("refs/buildplane/candidates/")
        .expect("reviewer test candidate ref is canonical");
    let action_id =
        format!("{RETRY_CANDIDATE_ACTION_NAMESPACE}:git-candidate-create:{candidate_key}");
    let claim_request = append_retry_candidate_claim_request(
        &store,
        &kernel_key,
        &kernel,
        run_id,
        completion_request.dispatch_event_id,
        now,
        ExecutionRoleV1::Reviewer,
        action_id.clone(),
        format!("{action_id}:idempotency"),
    );
    let authority = retry_candidate_activity_claim_authority(&kernel_key, &kernel);
    let event_count_before_claim = store.event_count().expect("count reviewer claim tape");

    let error = store
        .claim_activity_v1_at_for_tests(
            &claim_request,
            &authority,
            &kernel_key,
            &kernel,
            now + Duration::seconds(13),
        )
        .expect_err("a reviewer retry dispatch must not mint a candidate lease");
    assert!(
        matches!(
            error,
            LedgerError::ActivityClaimAuthorityRejected { ref reason }
                if reason.contains("outside the configured sealed-V3 realm")
        ),
        "expected a static dispatch rejection, got {error:?}"
    );
    assert_eq!(
        store.event_count().expect("count rejected reviewer claim"),
        event_count_before_claim,
        "a reviewer retry candidate claim must fail before appending a lease"
    );
}

#[test]
fn governed_retry_candidate_claim_grants_a_protected_static_valid_v3_retry() {
    let store = SqliteStore::open_in_memory().expect("open valid retry candidate claim store");
    let kernel_key = SigningKey::from_bytes(&[71; 32]);
    let kernel = actor("kernel", "kernel-main", &kernel_key);
    let now = retry_candidate_fixture_time();
    let run_id = RunId::new();
    let completion_request = append_retry_candidate_completion_evidence(
        &store,
        &kernel_key,
        &kernel,
        run_id,
        now,
        RetryCandidateEvidenceVariant::Valid,
    );
    let authority = retry_candidate_activity_claim_authority(&kernel_key, &kernel);
    let resolved = store
        .resolve_governed_v3_retry_candidate_action_identity_v1(
            &retry_candidate_identity_request(&completion_request),
            &authority,
        )
        .expect("resolve the valid retry candidate action identity before claiming it");
    let claim_request = append_retry_candidate_claim_request(
        &store,
        &kernel_key,
        &kernel,
        run_id,
        completion_request.dispatch_event_id,
        now,
        ExecutionRoleV1::Implementer,
        resolved.action_id,
        resolved.idempotency_key,
    );
    let event_count_before_claim = store.event_count().expect("count valid claim tape");

    let disposition = store
        .claim_activity_v1_at_for_tests(
            &claim_request,
            &authority,
            &kernel_key,
            &kernel,
            now + Duration::seconds(13),
        )
        .expect("a protected static-valid retry candidate claim grants one lease");
    assert!(matches!(
        disposition,
        ActivityClaimDispositionV1::Granted { .. }
    ));
    assert_eq!(
        store.event_count().expect("count granted valid claim"),
        event_count_before_claim + 1,
        "the valid retry candidate claim appends exactly one lease"
    );
}

#[test]
fn governed_retry_candidate_claim_rejects_a_graph_bound_v4_retry_before_lease() {
    let store = SqliteStore::open_in_memory().expect("open V4 retry candidate claim store");
    let kernel_key = SigningKey::from_bytes(&[71; 32]);
    let kernel = actor("kernel", "kernel-main", &kernel_key);
    let authority = retry_candidate_activity_claim_authority(&kernel_key, &kernel);
    let now = retry_candidate_fixture_time();
    let run_id = RunId::new();
    let dispatch = graph_bound_dispatch_v4(retry_candidate_dispatch(now, DIGEST_E));
    let dispatch_event = event(
        run_id,
        None,
        EventKind::DispatchEnvelopeV4,
        now,
        Payload::DispatchEnvelopeV4(dispatch.clone()),
    );
    store
        .append_signed(&dispatch_event, &kernel_key, &kernel)
        .expect("append graph-bound V4 retry dispatch");
    let action_id = format!(
        "{RETRY_CANDIDATE_ACTION_NAMESPACE}:git-candidate-create:workflow-1/implement-unit-1/2"
    );
    let mut action_request = retry_candidate_action_request(
        run_id,
        &dispatch.dispatch_v3,
        action_id.clone(),
        format!("{action_id}:idempotency"),
        now + Duration::seconds(1),
    );
    action_request.dispatch_envelope_digest = dispatch.envelope_digest.clone();
    let action_request_event = event(
        run_id,
        Some(dispatch_event.id),
        EventKind::ActionRequestedV2,
        now + Duration::seconds(1),
        Payload::ActionRequestedV2(action_request),
    );
    store
        .append_signed(&action_request_event, &kernel_key, &kernel)
        .expect("append graph-bound V4 retry candidate action request");
    let claim = ActivityClaimRequestV1 {
        run_id,
        activity_id: action_id.clone(),
        idempotency_key: format!("{action_id}:idempotency"),
        dispatch_event_id: dispatch_event.id,
        action_request_event_id: action_request_event.id,
        lease_duration_ms: 1_000,
    };

    let error = store
        .claim_activity_v1_at_for_tests(
            &claim,
            &authority,
            &kernel_key,
            &kernel,
            now + Duration::seconds(2),
        )
        .expect_err("V4 retry candidate claim cannot mint a lease");
    assert!(matches!(
        error,
        LedgerError::ActivityClaimAuthorityRejected { ref reason }
            if reason.contains("only outer sealed-V3 dispatch envelopes")
    ));
    assert_eq!(
        store.event_count().expect("count rejected V4 retry claim"),
        2,
        "the rejected V4 retry claim must not append a lease"
    );
}

#[test]
fn governed_retry_candidate_claim_rejects_a_manifest_bound_v5_retry_before_lease() {
    let store = SqliteStore::open_in_memory().expect("open V5 retry candidate claim store");
    let kernel_key = SigningKey::from_bytes(&[71; 32]);
    let kernel = actor("kernel", "kernel-main", &kernel_key);
    let authority = retry_candidate_activity_claim_authority(&kernel_key, &kernel);
    let now = retry_candidate_fixture_time();
    let run_id = RunId::new();
    let dispatch = manifest_bound_retry_dispatch_v5(now);
    let dispatch_event = event(
        run_id,
        None,
        EventKind::DispatchEnvelopeV5,
        now,
        Payload::DispatchEnvelopeV5(dispatch.clone()),
    );
    store
        .append_signed(&dispatch_event, &kernel_key, &kernel)
        .expect("append manifest-bound V5 retry dispatch");
    let action_id = format!(
        "{RETRY_CANDIDATE_ACTION_NAMESPACE}:git-candidate-create:workflow-1/implement-unit-1/2"
    );
    let mut action_request = retry_candidate_action_request(
        run_id,
        &dispatch.dispatch_v4.dispatch_v3,
        action_id.clone(),
        format!("{action_id}:idempotency"),
        now + Duration::seconds(1),
    );
    action_request.dispatch_envelope_digest = dispatch.envelope_digest.clone();
    let action_request_event = event(
        run_id,
        Some(dispatch_event.id),
        EventKind::ActionRequestedV2,
        now + Duration::seconds(1),
        Payload::ActionRequestedV2(action_request),
    );
    store
        .append_signed(&action_request_event, &kernel_key, &kernel)
        .expect("append manifest-bound V5 retry candidate action request");
    let claim = ActivityClaimRequestV1 {
        run_id,
        activity_id: action_id.clone(),
        idempotency_key: format!("{action_id}:idempotency"),
        dispatch_event_id: dispatch_event.id,
        action_request_event_id: action_request_event.id,
        lease_duration_ms: 1_000,
    };

    let error = store
        .claim_activity_v1_at_for_tests(
            &claim,
            &authority,
            &kernel_key,
            &kernel,
            now + Duration::seconds(2),
        )
        .expect_err("V5 retry candidate claim cannot mint a lease");
    assert!(matches!(
        error,
        LedgerError::ActivityClaimAuthorityRejected { ref reason }
            if reason.contains("requires a signed dispatch_envelope_v3 or graph-bound dispatch_envelope_v4")
    ));
    assert_eq!(
        store.event_count().expect("count rejected V5 retry claim"),
        2,
        "the rejected V5 retry claim must not append a lease"
    );
}

#[test]
fn governed_candidate_completion_rejects_a_graph_bound_v4_retry_before_append() {
    let store = SqliteStore::open_in_memory().expect("open V4 retry completion store");
    let kernel_key = SigningKey::from_bytes(&[71; 32]);
    let reviewer_key = SigningKey::from_bytes(&[72; 32]);
    let operator_key = SigningKey::from_bytes(&[73; 32]);
    let (kernel, authority) =
        retry_candidate_completion_authority(&kernel_key, &reviewer_key, &operator_key);
    let now = retry_candidate_fixture_time();
    let run_id = RunId::new();
    let dispatch = graph_bound_dispatch_v4(retry_candidate_dispatch(now, DIGEST_E));
    let dispatch_event = event(
        run_id,
        None,
        EventKind::DispatchEnvelopeV4,
        now,
        Payload::DispatchEnvelopeV4(dispatch),
    );
    store
        .append_signed(&dispatch_event, &kernel_key, &kernel)
        .expect("append graph-bound V4 retry dispatch");
    let request = GovernedCandidateCompletionRequestV1 {
        run_id,
        dispatch_event_id: dispatch_event.id,
        candidate_created_event_id: EventId::new(),
    };

    let error = store
        .record_governed_candidate_completion_v1(&request, &authority, &kernel_key, &kernel)
        .expect_err("V4 retry candidate completion cannot append");
    assert!(matches!(
        error,
        LedgerError::CandidateCompletionAuthorityRejected { ref reason }
            if reason.contains("singleton graph-bound V4 admission requires the exact first dispatch attempt")
    ));
    assert_eq!(
        store
            .event_count()
            .expect("count rejected V4 retry completion"),
        1,
        "the rejected V4 retry completion must not append a completion or checkpoint"
    );
}

#[test]
fn governed_candidate_completion_rejects_a_manifest_bound_v5_retry_before_append() {
    let store = SqliteStore::open_in_memory().expect("open V5 retry completion store");
    let kernel_key = SigningKey::from_bytes(&[71; 32]);
    let reviewer_key = SigningKey::from_bytes(&[72; 32]);
    let operator_key = SigningKey::from_bytes(&[73; 32]);
    let (kernel, authority) =
        retry_candidate_completion_authority(&kernel_key, &reviewer_key, &operator_key);
    let now = retry_candidate_fixture_time();
    let run_id = RunId::new();
    let dispatch = manifest_bound_retry_dispatch_v5(now);
    let dispatch_event = event(
        run_id,
        None,
        EventKind::DispatchEnvelopeV5,
        now,
        Payload::DispatchEnvelopeV5(dispatch),
    );
    store
        .append_signed(&dispatch_event, &kernel_key, &kernel)
        .expect("append manifest-bound V5 retry dispatch");
    let request = GovernedCandidateCompletionRequestV1 {
        run_id,
        dispatch_event_id: dispatch_event.id,
        candidate_created_event_id: EventId::new(),
    };

    let error = store
        .record_governed_candidate_completion_v1(&request, &authority, &kernel_key, &kernel)
        .expect_err("V5 retry candidate completion cannot append");
    assert!(matches!(
        error,
        LedgerError::CandidateCompletionAuthorityRejected { ref reason }
            if reason.contains("requires a signed sealed-V3 or graph-bound V4 dispatch envelope")
    ));
    assert_eq!(
        store
            .event_count()
            .expect("count rejected V5 retry completion"),
        1,
        "the rejected V5 retry completion must not append a completion or checkpoint"
    );
}
