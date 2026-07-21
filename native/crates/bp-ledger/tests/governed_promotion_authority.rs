//! Durable, candidate-bound promotion-decision coverage.
//!
//! This exercises only the broker-private write-ahead decision and kernel
//! checkpoint boundary. It deliberately does not invoke Git: a sealed
//! decision is recovery evidence, not a target-branch mutation.

use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::trust_spine::{
    candidate_completion_recorded_v1_digest, candidate_view_v1_digest,
    dispatch_envelope_v3_body_digest, dispatch_envelope_v4_digest, review_verdict_output_v1_digest,
    ActionEvidenceVersionV1, CandidateAcceptanceOutcomeV1, CandidateAcceptanceRecordedV1,
    CandidateCompletionRecordedV1, CandidateCreatedV2, CandidateViewV1, CommitModeV1,
    DispatchBudgetV1, DispatchEnvelopeBodyV2, DispatchEnvelopeV3, DispatchEnvelopeV4,
    ExecutionRoleV1, PromotionApprovalRequestedV1, PromotionDecisionKindV1,
    PromotionExecutionLeaseBindingV1, PromotionGitBindingV1, PromotionResultOutcomeV1,
    PromotionWorktreeSyncStateV1, ReviewDecisionV1, ReviewVerdictOutputV1, ReviewVerdictRecordedV2,
    TrustTierV1,
};
use bp_ledger::payload::Payload;
use bp_ledger::signing::{public_key_hash, ActorKeyRef, TrustedPublicKeys, VerificationStatus};
use bp_ledger::storage::sqlite::{
    GovernedPromotionAuthorityV1, GovernedPromotionDecisionDispositionV1,
    GovernedPromotionDecisionRequestV1, GovernedPromotionDecisionSealRequestV1,
    GovernedPromotionExecutionClaimDispositionV1, GovernedPromotionExecutionClaimRequestV1,
    GovernedPromotionResultDispositionV1, GovernedPromotionResultRequestV1, SqliteStore,
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
        candidate_ref: "refs/buildplane/candidates/candidate-1/run-1/1".into(),
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

#[derive(Clone, Copy)]
enum V4PromotionDigestBinding {
    Outer,
    Nested,
    Wrong,
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
            promotion_receipt_ref: Some("refs/buildplane/promotions/candidate-1/run-1/1".into()),
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
            promotion_receipt_ref: Some("refs/buildplane/promotions/candidate-1/run-1/1".into()),
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
