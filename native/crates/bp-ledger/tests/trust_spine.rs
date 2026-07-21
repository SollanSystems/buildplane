//! Additive V1 tape vocabulary for the governed trust spine.

use bp_ledger::canonicalize::{canonicalize, canonicalize_payload};
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::trust_spine::{
    action_receipt_recorded_v2_digest, action_receipt_set_v1_digest, action_requested_v2_digest,
    candidate_completion_recorded_v1_digest, candidate_view_v1_digest,
    dispatch_envelope_v2_body_digest, dispatch_envelope_v3_body_digest,
    governed_dispatch_policy_digest_v1, model_action_authorized_v1_digest,
    model_action_authorized_v2_digest, model_action_intent_v1_digest,
    review_verdict_output_v1_digest, ActionEvidenceVersionV1, ActionKindV1, ActionReceiptOutcomeV2,
    ActionReceiptRecordedV2, ActionReceiptSetEntryV1, ActionReceiptSetRecordedV1,
    ActionRequestedV2, ActionResourceUsageV1, CandidateAcceptanceOutcomeV1,
    CandidateAcceptanceRecordedV1, CandidateCompletionRecordedV1, CandidateCreatedV1,
    CandidateCreatedV2, CandidateViewV1, CommitModeV1, DispatchBudgetV1, DispatchEnvelopeBodyV2,
    DispatchEnvelopeV1, DispatchEnvelopeV2, DispatchEnvelopeV3, ExecutionRoleV1,
    ModelActionAuthorizedV1, ModelActionAuthorizedV2, ModelActionIntentV1, ModelRequestEvidenceV1,
    PromotionApprovalRequestedV1, PromotionDecisionKindV1, PromotionDecisionRecordedV1,
    PromotionGitBindingV1, PromotionReconciliationResolvedV1, PromotionResultOutcomeV1,
    PromotionResultRecordedV1, PromotionWorktreeSyncStateV1, ReconciliationResolutionOutcomeV1,
    ReviewDecisionV1, ReviewFindingSeverityV1, ReviewFindingV1, ReviewVerdictOutputV1,
    ReviewVerdictRecordedV1, ReviewVerdictRecordedV2, SignatureRefV1, TrustScopeEvidenceV1,
    TrustTierV1, WorkflowTerminalOutcomeV1, WorkflowTerminalV1,
    MODEL_REQUEST_EVIDENCE_V1_SCHEMA_VERSION, TRUST_SCOPE_EVIDENCE_V1_SCHEMA_VERSION,
    TYPESCRIPT_SAFE_INTEGER_MAX,
};
use bp_ledger::payload::Payload;
use chrono::Utc;
use serde_json::json;

const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST_C: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

#[test]
fn governed_dispatch_policy_digest_matches_the_typescript_known_answer() {
    assert_eq!(
        governed_dispatch_policy_digest_v1(DIGEST_A).expect("canonical acceptance digest"),
        "sha256:04b00ddd982621ce587015c4d6d14442b19b19ea1b0609370c921ce82383c22c"
    );
}

#[test]
fn governed_dispatch_policy_digest_rejects_noncanonical_acceptance_digests() {
    for digest in [
        "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "sha512:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "not-a-digest",
    ] {
        assert!(
            governed_dispatch_policy_digest_v1(digest).is_err(),
            "expected {digest:?} to be rejected"
        );
    }
}

fn dispatch() -> DispatchEnvelopeV1 {
    DispatchEnvelopeV1 {
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
        context_manifest_digest: DIGEST_A.into(),
        worker_manifest_digest: DIGEST_B.into(),
        sandbox_profile_digest: DIGEST_A.into(),
        budget: DispatchBudgetV1 {
            max_tokens: Some(2_048),
            max_compute_time_ms: Some(60_000),
        },
        trust_tier: TrustTierV1::Governed,
        idempotency_key: "dispatch:workflow-1:unit-1:1".into(),
        issued_at: "2026-07-17T00:00:00Z".into(),
        expires_at: "2026-07-17T01:00:00Z".into(),
        envelope_digest: DIGEST_B.into(),
        signature_ref: SignatureRefV1 {
            algorithm: "ed25519".into(),
            key_id: "kernel-main".into(),
            signature: "base64url-signature".into(),
        },
    }
}

fn dispatch_v2_body() -> DispatchEnvelopeBodyV2 {
    let v1 = dispatch();
    DispatchEnvelopeBodyV2 {
        workflow_id: v1.workflow_id,
        workflow_revision: v1.workflow_revision,
        unit_id: v1.unit_id,
        attempt: v1.attempt,
        execution_role: v1.execution_role,
        commit_mode: v1.commit_mode,
        provenance_ref: v1.provenance_ref,
        base_commit_sha: v1.base_commit_sha,
        capability_bundle_digest: v1.capability_bundle_digest,
        acceptance_contract_digest: v1.acceptance_contract_digest,
        context_manifest_digest: v1.context_manifest_digest,
        worker_manifest_digest: v1.worker_manifest_digest,
        sandbox_profile_digest: v1.sandbox_profile_digest,
        budget: v1.budget,
        trust_tier: v1.trust_tier,
        idempotency_key: v1.idempotency_key,
        issued_at: v1.issued_at,
        expires_at: v1.expires_at,
    }
}

fn dispatch_v2() -> DispatchEnvelopeV2 {
    let body = dispatch_v2_body();
    let envelope_digest = dispatch_envelope_v2_body_digest(&body).expect("serialize v2 body");
    DispatchEnvelopeV2 {
        body,
        envelope_digest,
    }
}

fn dispatch_v3() -> DispatchEnvelopeV3 {
    let body = dispatch_v2_body();
    let action_evidence_version = ActionEvidenceVersionV1::SealedV3;
    DispatchEnvelopeV3 {
        envelope_digest: dispatch_envelope_v3_body_digest(
            &body,
            action_evidence_version,
            DIGEST_A,
            DIGEST_B,
            Some(DIGEST_C),
        )
        .expect("serialize v3 body"),
        body,
        action_evidence_version,
        repository_binding_digest: DIGEST_A.into(),
        ledger_authority_realm_digest: DIGEST_B.into(),
        governed_packet_digest: Some(DIGEST_C.into()),
    }
}

fn action_request() -> ActionRequestedV2 {
    let dispatch = dispatch_v3();
    ActionRequestedV2 {
        run_id: "run-1".into(),
        workflow_id: dispatch.body.workflow_id.clone(),
        unit_id: dispatch.body.unit_id.clone(),
        attempt: dispatch.body.attempt,
        provenance_ref: dispatch.body.provenance_ref.clone(),
        action_id: "action-1".into(),
        idempotency_key: "action:1".into(),
        action_kind: ActionKindV1::Process,
        canonical_input_digest: DIGEST_A.into(),
        canonical_input_ref: "cas:input:1".into(),
        dispatch_envelope_digest: dispatch.envelope_digest,
        repository_binding_digest: dispatch.repository_binding_digest,
        ledger_authority_realm_digest: dispatch.ledger_authority_realm_digest,
        governed_packet_digest: dispatch.governed_packet_digest,
        capability_bundle_digest: dispatch.body.capability_bundle_digest.clone(),
        policy_digest: governed_dispatch_policy_digest_v1(
            &dispatch.body.acceptance_contract_digest,
        )
        .expect("fixture dispatch has a canonical acceptance-contract digest"),
        context_manifest_digest: dispatch.body.context_manifest_digest.clone(),
        worker_manifest_digest: dispatch.body.worker_manifest_digest.clone(),
        sandbox_profile_digest: dispatch.body.sandbox_profile_digest.clone(),
        authority_actor: "kernel".into(),
        execution_role: dispatch.body.execution_role,
        requested_at: "2026-07-17T00:00:01Z".into(),
    }
}

fn action_receipt(request: &ActionRequestedV2) -> ActionReceiptRecordedV2 {
    ActionReceiptRecordedV2 {
        run_id: request.run_id.clone(),
        workflow_id: request.workflow_id.clone(),
        unit_id: request.unit_id.clone(),
        attempt: request.attempt,
        provenance_ref: request.provenance_ref.clone(),
        action_id: request.action_id.clone(),
        idempotency_key: request.idempotency_key.clone(),
        action_request_digest: action_requested_v2_digest(request).expect("hash request"),
        dispatch_envelope_digest: request.dispatch_envelope_digest.clone(),
        capability_bundle_digest: request.capability_bundle_digest.clone(),
        policy_digest: request.policy_digest.clone(),
        context_manifest_digest: request.context_manifest_digest.clone(),
        worker_manifest_digest: request.worker_manifest_digest.clone(),
        sandbox_profile_digest: request.sandbox_profile_digest.clone(),
        authority_actor: request.authority_actor.clone(),
        execution_role: request.execution_role,
        outcome: ActionReceiptOutcomeV2::Succeeded,
        result_digest: Some(DIGEST_A.into()),
        result_ref: Some("cas:result:1".into()),
        evidence_digest: DIGEST_B.into(),
        evidence_ref: "cas:evidence:1".into(),
        resource_usage: ActionResourceUsageV1 {
            wall_time_ms: 1,
            cpu_time_ms: Some(1),
            peak_memory_bytes: Some(1),
            input_bytes: Some(1),
            output_bytes: Some(1),
            input_tokens: None,
            output_tokens: None,
        },
        redactions: vec![],
        failure: None,
        authorization_ref: None,
        action_receipt_ref: "receipt:1".into(),
        completed_at: "2026-07-17T00:00:02Z".into(),
    }
}

fn model_action_authorization(request: &ActionRequestedV2) -> ModelActionAuthorizedV1 {
    let mut authorization = ModelActionAuthorizedV1 {
        run_id: request.run_id.clone(),
        workflow_id: request.workflow_id.clone(),
        unit_id: request.unit_id.clone(),
        attempt: request.attempt,
        provenance_ref: request.provenance_ref.clone(),
        action_id: request.action_id.clone(),
        idempotency_key: request.idempotency_key.clone(),
        dispatch_event_ref: "dispatch-event:1".into(),
        dispatch_envelope_digest: request.dispatch_envelope_digest.clone(),
        action_request_ref: "action-request-event:1".into(),
        action_request_digest: action_requested_v2_digest(request).expect("hash request"),
        packet_digest: DIGEST_A.into(),
        canonical_input_digest: request.canonical_input_digest.clone(),
        model_request_digest: DIGEST_B.into(),
        trust_scope_digest: DIGEST_A.into(),
        context_manifest_digest: request.context_manifest_digest.clone(),
        policy_digest: request.policy_digest.clone(),
        sandbox_profile_digest: request.sandbox_profile_digest.clone(),
        execution_role: request.execution_role,
        candidate_digest: None,
        candidate_view_digest: None,
        authorization_actor: "kernel:action-gateway".into(),
        expires_at: "2026-07-17T00:30:00Z".into(),
        authorization_ref: "model-authorization-event:1".into(),
        authorization_digest: String::new(),
    };
    authorization.authorization_digest =
        model_action_authorized_v1_digest(&authorization).expect("hash model authorization");
    authorization
}

fn model_action_intent(request: &ActionRequestedV2) -> ModelActionIntentV1 {
    let mut intent = ModelActionIntentV1 {
        run_id: request.run_id.clone(),
        workflow_id: request.workflow_id.clone(),
        unit_id: request.unit_id.clone(),
        attempt: request.attempt,
        provenance_ref: request.provenance_ref.clone(),
        action_id: request.action_id.clone(),
        idempotency_key: request.idempotency_key.clone(),
        dispatch_event_ref: EventId::new(),
        dispatch_envelope_digest: request.dispatch_envelope_digest.clone(),
        action_request_event_ref: EventId::new(),
        action_request_digest: action_requested_v2_digest(request).expect("hash request"),
        canonical_input_ref: request.canonical_input_ref.clone(),
        canonical_input_digest: request.canonical_input_digest.clone(),
        model_request_evidence: ModelRequestEvidenceV1 {
            schema_version: MODEL_REQUEST_EVIDENCE_V1_SCHEMA_VERSION,
            cas_ref: format!("cas:{DIGEST_A}"),
            digest: DIGEST_A.into(),
        },
        trust_scope_evidence: TrustScopeEvidenceV1 {
            schema_version: TRUST_SCOPE_EVIDENCE_V1_SCHEMA_VERSION,
            cas_ref: format!("cas:{DIGEST_B}"),
            digest: DIGEST_B.into(),
        },
        candidate_binding: None,
        intent_actor: "kernel:action-gateway".into(),
        intended_at: "2026-07-17T00:00:03Z".into(),
        intent_digest: String::new(),
    };
    intent.intent_digest = model_action_intent_v1_digest(&intent).expect("hash model intent");
    intent
}

fn model_action_authorization_v2(intent: &ModelActionIntentV1) -> ModelActionAuthorizedV2 {
    let mut authorization = ModelActionAuthorizedV2 {
        intent_event_ref: EventId::new(),
        intent_digest: intent.intent_digest.clone(),
        model_request_evidence: intent.model_request_evidence.clone(),
        trust_scope_evidence: intent.trust_scope_evidence.clone(),
        candidate_binding: intent.candidate_binding.clone(),
        authorization_actor: "kernel:action-gateway".into(),
        expires_at: "2026-07-17T00:30:00Z".into(),
        authorization_ref: "model-authorization-v2-event:1".into(),
        authorization_digest: String::new(),
    };
    authorization.authorization_digest =
        model_action_authorized_v2_digest(&authorization).expect("hash V2 model authorization");
    authorization
}

fn action_receipt_set(
    request: &ActionRequestedV2,
    receipt: &ActionReceiptRecordedV2,
) -> ActionReceiptSetRecordedV1 {
    let mut set = ActionReceiptSetRecordedV1 {
        run_id: request.run_id.clone(),
        workflow_id: request.workflow_id.clone(),
        unit_id: request.unit_id.clone(),
        attempt: request.attempt,
        provenance_ref: request.provenance_ref.clone(),
        dispatch_envelope_digest: request.dispatch_envelope_digest.clone(),
        action_receipt_set_ref: "receipt-set:1".into(),
        action_receipt_set_digest: String::new(),
        receipts: vec![ActionReceiptSetEntryV1 {
            action_id: request.action_id.clone(),
            action_receipt_ref: receipt.action_receipt_ref.clone(),
            action_receipt_digest: action_receipt_recorded_v2_digest(receipt)
                .expect("hash receipt"),
        }],
        sealed_at: "2026-07-17T00:00:03Z".into(),
    };
    set.action_receipt_set_digest = action_receipt_set_v1_digest(&set).expect("hash receipt set");
    set
}

fn candidate() -> CandidateCreatedV1 {
    CandidateCreatedV1 {
        candidate_id: "candidate-1".into(),
        candidate_ref: "refs/buildplane/candidates/candidate-1/run-1/1".into(),
        workflow_id: "workflow-1".into(),
        unit_id: "unit-1".into(),
        attempt: 1,
        provenance_ref: "admission:1".into(),
        candidate_digest: DIGEST_A.into(),
        base_commit_sha: "1".repeat(40),
        candidate_commit_sha: "2".repeat(40),
        commit_digest: DIGEST_B.into(),
        tree_digest: DIGEST_A.into(),
        patch_digest: DIGEST_B.into(),
        changed_files_digest: DIGEST_A.into(),
        envelope_digest: DIGEST_B.into(),
        action_receipt_digest: DIGEST_A.into(),
    }
}

fn candidate_v2() -> CandidateCreatedV2 {
    CandidateCreatedV2 {
        run_id: "run-1".into(),
        candidate_id: "candidate-v2-1".into(),
        candidate_ref: "refs/buildplane/candidates/candidate-v2-1/run-1/1".into(),
        workflow_id: "workflow-1".into(),
        unit_id: "unit-1".into(),
        attempt: 1,
        provenance_ref: "admission:1".into(),
        candidate_digest: DIGEST_A.into(),
        base_commit_sha: "1".repeat(40),
        candidate_commit_sha: "2".repeat(40),
        commit_digest: DIGEST_B.into(),
        tree_digest: DIGEST_A.into(),
        patch_digest: DIGEST_B.into(),
        changed_files_digest: DIGEST_A.into(),
        envelope_digest: DIGEST_B.into(),
        action_receipt_set_ref: "receipt-set:1".into(),
        action_receipt_set_digest: DIGEST_B.into(),
    }
}

fn candidate_completion() -> CandidateCompletionRecordedV1 {
    let request = action_request();
    let receipt = action_receipt(&request);
    let candidate = candidate_v2();
    let mut completion = CandidateCompletionRecordedV1 {
        run_id: candidate.run_id.clone(),
        workflow_id: candidate.workflow_id.clone(),
        unit_id: candidate.unit_id.clone(),
        attempt: candidate.attempt,
        provenance_ref: candidate.provenance_ref.clone(),
        candidate_created_event_ref: EventId::new(),
        candidate_digest: candidate.candidate_digest.clone(),
        candidate_create_action_id: request.action_id.clone(),
        action_request_ref: EventId::new(),
        action_request_digest: action_requested_v2_digest(&request).expect("hash request"),
        activity_claim_event_ref: EventId::new(),
        activity_claim_event_digest: DIGEST_A.into(),
        activity_result_event_ref: EventId::new(),
        activity_result_event_digest: DIGEST_B.into(),
        action_receipt_ref: receipt.action_receipt_ref.clone(),
        action_receipt_digest: action_receipt_recorded_v2_digest(&receipt).expect("hash receipt"),
        completion_digest: String::new(),
        completed_at: "2026-07-17T00:00:04Z".into(),
    };
    completion.completion_digest =
        candidate_completion_recorded_v1_digest(&completion).expect("hash candidate completion");
    completion
}

fn reseal_review_v2_candidate_view(review: &mut ReviewVerdictRecordedV2) {
    review.candidate_view_digest =
        candidate_view_v1_digest(&review.candidate_view).expect("hash candidate view");
    review.review_output_digest = review_verdict_output_v1_digest(&ReviewVerdictOutputV1 {
        candidate_digest: review.candidate_digest.clone(),
        candidate_commit_sha: review.candidate_commit_sha.clone(),
        decision: review.decision,
        findings: review.findings.clone(),
        confidence: review.confidence,
        candidate_view_digest: review.candidate_view_digest.clone(),
    })
    .expect("hash closed review output");
    review.review_output_ref = format!("cas:{}", review.review_output_digest);
}

fn review() -> ReviewVerdictRecordedV1 {
    ReviewVerdictRecordedV1 {
        candidate_digest: DIGEST_A.into(),
        candidate_commit_sha: "2".repeat(40),
        review_ref: "review:1".into(),
        review_verdict_action_id: None,
        review_action_request_digest: None,
        review_action_receipt_ref: None,
        review_action_receipt_digest: None,
        review_output_ref: None,
        review_output_digest: None,
        decision: ReviewDecisionV1::Approve,
        findings: vec![ReviewFindingV1 {
            severity: ReviewFindingSeverityV1::Info,
            check_id: "lint".into(),
            file: "src/index.ts".into(),
            line: 1,
            explanation: "clean".into(),
            evidence_refs: vec!["evidence:lint".into()],
        }],
        confidence: 0.99,
        reviewer_manifest_digest: DIGEST_B.into(),
        reviewed_at: "2026-07-17T00:02:00Z".into(),
    }
}

fn review_v2() -> ReviewVerdictRecordedV2 {
    let candidate_view = CandidateViewV1 {
        candidate_ref: "refs/buildplane/candidates/candidate-1/run-1/1".into(),
        candidate_digest: DIGEST_A.into(),
        candidate_commit_sha: "2".repeat(40),
        tree_digest: DIGEST_A.into(),
        reviewer_context_manifest_digest: DIGEST_A.into(),
        reviewer_sandbox_profile_digest: DIGEST_B.into(),
        mount_path_digest: DIGEST_A.into(),
        read_only: true,
        network_disabled: true,
    };
    let candidate_view_digest =
        candidate_view_v1_digest(&candidate_view).expect("hash closed review candidate view");
    let output = ReviewVerdictOutputV1 {
        candidate_digest: DIGEST_A.into(),
        candidate_commit_sha: "2".repeat(40),
        decision: ReviewDecisionV1::Approve,
        findings: vec![],
        confidence: 0.99,
        candidate_view_digest: candidate_view_digest.clone(),
    };
    let review_output_digest =
        review_verdict_output_v1_digest(&output).expect("hash closed review output");
    ReviewVerdictRecordedV2 {
        run_id: "run-1".into(),
        workflow_id: "workflow-1".into(),
        unit_id: "unit-1".into(),
        attempt: 1,
        provenance_ref: "admission:1".into(),
        candidate_digest: output.candidate_digest.clone(),
        candidate_commit_sha: output.candidate_commit_sha.clone(),
        review_ref: "review-v2:1".into(),
        review_verdict_action_id: "review-action:1".into(),
        review_action_request_digest: DIGEST_A.into(),
        review_action_receipt_ref: "receipt:review-action:1".into(),
        review_action_receipt_digest: DIGEST_B.into(),
        review_output_ref: format!("cas:{review_output_digest}"),
        review_output_digest,
        decision: output.decision,
        findings: output.findings,
        confidence: output.confidence,
        acceptance_ref: "acceptance:1".into(),
        acceptance_digest: DIGEST_A.into(),
        acceptance_contract_digest: DIGEST_B.into(),
        candidate_envelope_digest: DIGEST_A.into(),
        reviewer_workflow_id: "workflow-1".into(),
        reviewer_dispatch_envelope_digest: DIGEST_B.into(),
        reviewer_unit_id: "review-unit-1".into(),
        reviewer_attempt: 1,
        reviewer_execution_role: ExecutionRoleV1::Reviewer,
        review_action_receipt_set_ref: "receipt-set:review-action:1".into(),
        review_action_receipt_set_digest: DIGEST_A.into(),
        candidate_view,
        candidate_view_ref: "candidate-view:1".into(),
        candidate_view_digest,
        reviewer_manifest_digest: DIGEST_B.into(),
        reviewer_authority: "reviewer:1".into(),
        reviewed_at: "2026-07-17T00:02:00Z".into(),
    }
}

fn promotion_decision() -> PromotionDecisionRecordedV1 {
    PromotionDecisionRecordedV1 {
        candidate_digest: DIGEST_A.into(),
        base_commit_sha: "1".repeat(40),
        target_ref: Some("refs/heads/main".into()),
        envelope_digest: DIGEST_B.into(),
        acceptance_ref: "acceptance:1".into(),
        review_refs: vec!["review:1".into()],
        promotion_approval_request_ref: None,
        decision: PromotionDecisionKindV1::Promote,
        authority: "operator".into(),
        decided_by: "operator:1".into(),
        decided_at: "2026-07-17T00:03:00Z".into(),
        idempotency_key: "promotion:1".into(),
    }
}

fn promotion_approval_request() -> PromotionApprovalRequestedV1 {
    PromotionApprovalRequestedV1 {
        candidate_digest: DIGEST_A.into(),
        base_commit_sha: "1".repeat(40),
        target_ref: "refs/heads/main".into(),
        envelope_digest: DIGEST_B.into(),
        acceptance_ref: "acceptance:1".into(),
        review_refs: vec!["review:1".into()],
        requested_by: "kernel:1".into(),
        requested_at: "2026-07-17T00:02:30Z".into(),
        idempotency_key: "promotion:1".into(),
    }
}

macro_rules! assert_canonical_variant {
    ($kind:literal, $payload:expr, $variant:ident) => {{
        let value = serde_json::to_value($payload).unwrap();
        match canonicalize_payload($kind, 1, value).unwrap() {
            Payload::$variant(_) => {}
            other => panic!("unexpected payload {other:?}"),
        }
    }};
}

#[test]
fn trust_spine_kind_strings_are_stable() {
    assert_eq!(EventKind::DispatchEnvelope.as_wire(), "dispatch_envelope");
    assert_eq!(
        EventKind::DispatchEnvelopeV2.as_wire(),
        "dispatch_envelope_v2"
    );
    assert_eq!(
        EventKind::DispatchEnvelopeV3.as_wire(),
        "dispatch_envelope_v3"
    );
    assert_eq!(
        EventKind::ActionRequestedV2.as_wire(),
        "action_requested_v2"
    );
    assert_eq!(
        EventKind::ModelActionIntentV1.as_wire(),
        "model_action_intent_v1"
    );
    assert_eq!(
        EventKind::ModelActionAuthorizedV1.as_wire(),
        "model_action_authorized_v1"
    );
    assert_eq!(
        EventKind::ModelActionAuthorizedV2.as_wire(),
        "model_action_authorized_v2"
    );
    assert_eq!(
        EventKind::ActionReceiptRecordedV2.as_wire(),
        "action_receipt_recorded_v2"
    );
    assert_eq!(
        EventKind::ActionReceiptSetRecordedV1.as_wire(),
        "action_receipt_set_recorded_v1"
    );
    assert_eq!(EventKind::CandidateCreated.as_wire(), "candidate_created");
    assert_eq!(
        EventKind::CandidateCreatedV2.as_wire(),
        "candidate_created_v2"
    );
    assert_eq!(
        EventKind::CandidateCompletionRecordedV1.as_wire(),
        "candidate_completion_recorded_v1"
    );
    assert_eq!(
        EventKind::CandidateAcceptanceRecorded.as_wire(),
        "candidate_acceptance_recorded"
    );
    assert_eq!(
        EventKind::ReviewVerdictRecorded.as_wire(),
        "review_verdict_recorded"
    );
    assert_eq!(
        EventKind::ReviewVerdictRecordedV2.as_wire(),
        "review_verdict_recorded_v2"
    );
    assert_eq!(
        EventKind::PromotionApprovalRequested.as_wire(),
        "promotion_approval_requested"
    );
    assert_eq!(
        EventKind::PromotionDecisionRecorded.as_wire(),
        "promotion_decision_recorded"
    );
    assert_eq!(
        EventKind::PromotionResultRecorded.as_wire(),
        "promotion_result_recorded"
    );
    assert_eq!(
        EventKind::PromotionReconciliationResolved.as_wire(),
        "promotion_reconciliation_resolved"
    );
    assert_eq!(EventKind::WorkflowTerminal.as_wire(), "workflow_terminal");
}

#[test]
fn every_trust_spine_payload_canonicalizes_through_its_own_kind() {
    assert_canonical_variant!(
        "dispatch_envelope",
        Payload::DispatchEnvelopeV1(dispatch()),
        DispatchEnvelopeV1
    );
    assert_canonical_variant!(
        "dispatch_envelope_v2",
        Payload::DispatchEnvelopeV2(dispatch_v2()),
        DispatchEnvelopeV2
    );
    assert_canonical_variant!(
        "model_action_authorized_v1",
        Payload::ModelActionAuthorizedV1(model_action_authorization(&action_request())),
        ModelActionAuthorizedV1
    );
    assert_canonical_variant!(
        "model_action_intent_v1",
        Payload::ModelActionIntentV1(model_action_intent(&action_request())),
        ModelActionIntentV1
    );
    let intent = model_action_intent(&action_request());
    assert_canonical_variant!(
        "model_action_authorized_v2",
        Payload::ModelActionAuthorizedV2(model_action_authorization_v2(&intent)),
        ModelActionAuthorizedV2
    );
    assert_canonical_variant!(
        "candidate_created",
        Payload::CandidateCreatedV1(candidate()),
        CandidateCreatedV1
    );
    assert_canonical_variant!(
        "candidate_acceptance_recorded",
        Payload::CandidateAcceptanceRecordedV1(CandidateAcceptanceRecordedV1 {
            candidate_digest: DIGEST_A.into(),
            candidate_commit_sha: "2".repeat(40),
            acceptance_ref: "acceptance:1".into(),
            acceptance_contract_digest: DIGEST_B.into(),
            acceptance_digest: DIGEST_B.into(),
            outcome: CandidateAcceptanceOutcomeV1::Passed,
            evaluated_at: "2026-07-17T00:01:00Z".into(),
        }),
        CandidateAcceptanceRecordedV1
    );
    assert_canonical_variant!(
        "review_verdict_recorded",
        Payload::ReviewVerdictRecordedV1(review()),
        ReviewVerdictRecordedV1
    );
    assert_canonical_variant!(
        "review_verdict_recorded_v2",
        Payload::ReviewVerdictRecordedV2(review_v2()),
        ReviewVerdictRecordedV2
    );
    assert_canonical_variant!(
        "promotion_approval_requested",
        Payload::PromotionApprovalRequestedV1(promotion_approval_request()),
        PromotionApprovalRequestedV1
    );
    assert_canonical_variant!(
        "promotion_decision_recorded",
        Payload::PromotionDecisionRecordedV1(promotion_decision()),
        PromotionDecisionRecordedV1
    );
    assert_canonical_variant!(
        "promotion_result_recorded",
        Payload::PromotionResultRecordedV1(PromotionResultRecordedV1 {
            candidate_digest: DIGEST_A.into(),
            idempotency_key: "promotion:1".into(),
            promotion_decision_ref: "decision:1".into(),
            outcome: PromotionResultOutcomeV1::ReconciliationRequired,
            merged_head_sha: Some("3".repeat(40)),
            promotion_git_binding: Some(PromotionGitBindingV1 {
                target_ref: "refs/heads/main".into(),
                target_head_before_sha: "1".repeat(40),
                target_head_after_sha: Some("3".repeat(40)),
                merged_head_sha: Some("3".repeat(40)),
                candidate_commit_sha: "2".repeat(40),
                merge_parent_shas: Some(vec!["1".repeat(40), "2".repeat(40)]),
                merged_tree_sha: Some("4".repeat(40)),
                merged_tree_digest: DIGEST_A.into(),
                promotion_receipt_ref: Some(
                    "refs/buildplane/promotions/candidate-1/run-1/1".into(),
                ),
                worktree_sync_state: Some(PromotionWorktreeSyncStateV1::RootCheckoutStale,),
            }),
            promotion_execution_lease_binding: None,
            completed_at: "2026-07-17T00:04:00Z".into(),
        }),
        PromotionResultRecordedV1
    );
    assert_canonical_variant!(
        "promotion_reconciliation_resolved",
        Payload::PromotionReconciliationResolvedV1(PromotionReconciliationResolvedV1 {
            candidate_digest: DIGEST_A.into(),
            promotion_decision_ref: "decision:1".into(),
            promotion_result_ref: "result:1".into(),
            promotion_receipt_ref: "refs/buildplane/promotions/candidate-1/run-1/1".into(),
            outcome: ReconciliationResolutionOutcomeV1::Abandon,
            authority: "operator:1".into(),
            resolved_by: "operator:1".into(),
            idempotency_key: "reconciliation:1".into(),
            resolved_at: "2026-07-17T00:04:30Z".into(),
        }),
        PromotionReconciliationResolvedV1
    );
    assert_canonical_variant!(
        "workflow_terminal",
        Payload::WorkflowTerminalV1(WorkflowTerminalV1 {
            workflow_id: "workflow-1".into(),
            workflow_revision: "r1".into(),
            unit_id: "unit-1".into(),
            attempt: 1,
            outcome: WorkflowTerminalOutcomeV1::Completed,
            candidate_digest: Some(DIGEST_A.into()),
            promotion_result_ref: Some("result:1".into()),
            reconciliation_resolution_ref: None,
            reason: None,
            idempotency_key: "workflow-terminal:1".into(),
            completed_at: "2026-07-17T00:05:00Z".into(),
        }),
        WorkflowTerminalV1
    );
}

#[test]
fn trust_spine_payloads_reject_unknown_fields_and_mismatched_kinds() {
    let mut value = serde_json::to_value(Payload::DispatchEnvelopeV1(dispatch())).unwrap();
    value["DispatchEnvelopeV1"]["unknown_authority"] = json!(true);
    assert!(canonicalize_payload("dispatch_envelope", 1, value).is_err());

    let mut nested = serde_json::to_value(Payload::DispatchEnvelopeV1(dispatch())).unwrap();
    nested["DispatchEnvelopeV1"]["signature_ref"]["unknown_key_material"] = json!("x");
    assert!(canonicalize_payload("dispatch_envelope", 1, nested).is_err());

    let mut v2 = serde_json::to_value(Payload::DispatchEnvelopeV2(dispatch_v2())).unwrap();
    v2["DispatchEnvelopeV2"]["body"]["unknown_authority"] = json!(true);
    assert!(canonicalize_payload("dispatch_envelope_v2", 1, v2).is_err());

    let mut v2_outer = serde_json::to_value(Payload::DispatchEnvelopeV2(dispatch_v2())).unwrap();
    v2_outer["DispatchEnvelopeV2"]["unknown_envelope_field"] = json!(true);
    assert!(canonicalize_payload("dispatch_envelope_v2", 1, v2_outer).is_err());

    let mut acceptance = serde_json::to_value(Payload::CandidateAcceptanceRecordedV1(
        CandidateAcceptanceRecordedV1 {
            candidate_digest: DIGEST_A.into(),
            candidate_commit_sha: "2".repeat(40),
            acceptance_ref: "acceptance:1".into(),
            acceptance_contract_digest: DIGEST_B.into(),
            acceptance_digest: DIGEST_B.into(),
            outcome: CandidateAcceptanceOutcomeV1::Passed,
            evaluated_at: "2026-07-17T00:01:00Z".into(),
        },
    ))
    .unwrap();
    acceptance["CandidateAcceptanceRecordedV1"]
        .as_object_mut()
        .unwrap()
        .remove("candidate_commit_sha");
    assert!(canonicalize_payload("candidate_acceptance_recorded", 1, acceptance).is_err());

    let value = serde_json::to_value(Payload::CandidateCreatedV1(candidate())).unwrap();
    let error = canonicalize_payload("promotion_decision_recorded", 1, value).unwrap_err();
    assert!(error.to_string().contains("PromotionDecisionRecordedV1"));

    let mut review_v2_payload = serde_json::to_value(Payload::ReviewVerdictRecordedV2(review_v2()))
        .expect("serialize V2 review payload");
    review_v2_payload["ReviewVerdictRecordedV2"]["candidate_view"]["read_only"] = json!(false);
    let error = canonicalize_payload("review_verdict_recorded_v2", 1, review_v2_payload)
        .expect_err("a writable candidate view cannot be admitted for governed review");
    assert!(error.to_string().contains("read-only"));

    let mut detached_review_output =
        serde_json::to_value(Payload::ReviewVerdictRecordedV2(review_v2()))
            .expect("serialize V2 review payload");
    detached_review_output["ReviewVerdictRecordedV2"]["review_output_ref"] =
        json!("cas:detached-review-output");
    let error = canonicalize_payload("review_verdict_recorded_v2", 1, detached_review_output)
        .expect_err("a review output ref must be bound to its closed output digest");
    assert!(error.to_string().contains("review_output_ref"));

    let mut unknown_review_view =
        serde_json::to_value(Payload::ReviewVerdictRecordedV2(review_v2()))
            .expect("serialize V2 review payload");
    unknown_review_view["ReviewVerdictRecordedV2"]["candidate_view"]["ambient_shell"] = json!(true);
    assert!(canonicalize_payload("review_verdict_recorded_v2", 1, unknown_review_view).is_err());

    let mut approval_request = serde_json::to_value(Payload::PromotionApprovalRequestedV1(
        promotion_approval_request(),
    ))
    .expect("serialize promotion approval request");
    approval_request["PromotionApprovalRequestedV1"]["unexpected_authority"] = json!(true);
    assert!(canonicalize_payload("promotion_approval_requested", 1, approval_request).is_err());
}

#[test]
fn candidate_refs_require_one_strict_buildplane_grammar_at_each_canonicalization_boundary() {
    let invalid_refs = [
        "refs/buildplane/candidates/",
        "refs/buildplane/candidates/candidate//run-1",
        "refs/buildplane/candidates/.candidate/run-1",
        "refs/buildplane/candidates/candidate.lock/run-1",
        "refs/buildplane/candidates/candidate/../run-1",
        "refs/buildplane/candidates/candidate@{rewritten/run-1",
        "refs/buildplane/candidates/candidate./run-1",
        "refs/buildplane/candidates/candidate\\run-1",
        "refs/buildplane/candidates/candidate space/run-1",
        "refs/buildplane/candidates/candidate\tcontrol/run-1",
        "refs/buildplane/candidates/candidaté/run-1",
        "refs/buildplane/candidates/candidate~rewrite/run-1",
        "refs/buildplane/candidates/candidate^rewrite/run-1",
        "refs/buildplane/candidates/candidate:rewrite/run-1",
        "refs/buildplane/candidates/candidate?rewrite/run-1",
        "refs/buildplane/candidates/candidate*rewrite/run-1",
        "refs/buildplane/candidates/candidate[rewrite/run-1",
    ];

    for candidate_ref in invalid_refs {
        let mut legacy_candidate = candidate();
        legacy_candidate.candidate_ref = candidate_ref.into();
        let error = canonicalize_payload(
            "candidate_created",
            1,
            serde_json::to_value(Payload::CandidateCreatedV1(legacy_candidate))
                .expect("serialize legacy candidate"),
        )
        .expect_err("legacy candidates must reject a non-canonical ref");
        assert!(
            error.to_string().contains("candidate_ref"),
            "legacy candidate unexpectedly failed for another reason: {error}"
        );

        let mut v2_candidate = candidate_v2();
        v2_candidate.candidate_ref = candidate_ref.into();
        let error = canonicalize_payload(
            "candidate_created_v2",
            1,
            serde_json::to_value(Payload::CandidateCreatedV2(v2_candidate))
                .expect("serialize v2 candidate"),
        )
        .expect_err("v2 candidates must reject a non-canonical ref");
        assert!(
            error.to_string().contains("candidate_ref"),
            "v2 candidate unexpectedly failed for another reason: {error}"
        );

        let mut review = review_v2();
        review.candidate_view.candidate_ref = candidate_ref.into();
        reseal_review_v2_candidate_view(&mut review);
        let error = canonicalize_payload(
            "review_verdict_recorded_v2",
            1,
            serde_json::to_value(Payload::ReviewVerdictRecordedV2(review))
                .expect("serialize review with candidate view"),
        )
        .expect_err("candidate views must reject a non-canonical ref");
        assert!(
            error.to_string().contains("candidate_ref"),
            "candidate view unexpectedly failed for another reason: {error}"
        );
    }
}

#[test]
fn dispatch_envelope_v2_body_digest_is_stable_and_changes_with_the_body() {
    let body = dispatch_v2_body();
    let digest = dispatch_envelope_v2_body_digest(&body).expect("serialize v2 body");
    assert_eq!(
        digest,
        "sha256:acb0e4d2ae182b0d3ed44dbecaf2e0fb1c49311f1e8b413a321d2dd26971c02a"
    );

    let mut mutated = body;
    mutated.unit_id = "unit-2".into();
    assert_ne!(
        dispatch_envelope_v2_body_digest(&mutated).expect("serialize mutated v2 body"),
        digest
    );
}

#[test]
fn dispatch_envelope_v2_rejects_a_mismatched_digest_at_canonicalization_ingress() {
    let mut envelope = dispatch_v2();
    envelope.envelope_digest = DIGEST_A.into();
    let payload = Payload::DispatchEnvelopeV2(envelope);

    let event = Event {
        id: EventId::new(),
        run_id: RunId::new(),
        parent_event_id: None,
        schema_version: 1,
        kind: EventKind::DispatchEnvelopeV2,
        occurred_at: Utc::now(),
        payload: payload.clone(),
    };
    let event_error =
        canonicalize(event).expect_err("mismatched V2 digest must fail before ingest");
    assert!(
        event_error.to_string().contains("envelope_digest"),
        "unexpected error: {event_error}"
    );

    let raw_payload = serde_json::to_value(payload).expect("serialize V2 payload");
    let payload_error = canonicalize_payload("dispatch_envelope_v2", 1, raw_payload)
        .expect_err("mismatched V2 digest must fail for payload-only canonicalization");
    assert!(
        payload_error.to_string().contains("envelope_digest"),
        "unexpected error: {payload_error}"
    );
}

#[test]
fn sealed_v3_dispatch_rejects_zero_budget_limits_at_canonicalization_ingress() {
    for field in ["max_tokens", "max_compute_time_ms"] {
        let mut envelope = dispatch_v3();
        if field == "max_tokens" {
            envelope.body.budget.max_tokens = Some(0);
        } else {
            envelope.body.budget.max_compute_time_ms = Some(0);
        }
        envelope.envelope_digest = dispatch_envelope_v3_body_digest(
            &envelope.body,
            envelope.action_evidence_version,
            &envelope.repository_binding_digest,
            &envelope.ledger_authority_realm_digest,
            envelope.governed_packet_digest.as_deref(),
        )
        .expect("the deliberately invalid budget still has a deterministic digest");

        let event = Event {
            id: EventId::new(),
            run_id: RunId::new(),
            parent_event_id: None,
            schema_version: 1,
            kind: EventKind::DispatchEnvelopeV3,
            occurred_at: Utc::now(),
            payload: Payload::DispatchEnvelopeV3(envelope),
        };
        let error = canonicalize(event)
            .expect_err("zero governed V3 budget limits must fail before tape ingest");
        assert!(
            error
                .to_string()
                .contains("budget limits must be greater than zero"),
            "unexpected error for {field}: {error}"
        );
    }
}

#[test]
fn dispatch_envelope_v3_is_an_additive_closed_payload_shape() {
    // V3 deliberately keeps the V2 authority body and adds only a sealed
    // action-evidence protocol selector plus a detached digest. This assertion
    // starts at the wire boundary so an unknown V3 variant cannot be silently
    // treated as a V2 dispatch by an older reader.
    let payload = serde_json::to_value(Payload::DispatchEnvelopeV3(dispatch_v3())).unwrap();

    let parsed = serde_json::from_value::<Payload>(payload)
        .expect("V3 dispatch envelope must deserialize as its own closed payload variant");
    assert!(format!("{parsed:?}").starts_with("DispatchEnvelopeV3("));
}

#[test]
fn v3_action_evidence_payloads_canonicalize_with_exact_digest_bindings() {
    let dispatch = dispatch_v3();
    let mut request = action_request();
    request.action_kind = ActionKindV1::Model;
    let authorization = model_action_authorization(&request);
    let receipt = action_receipt(&request);
    let set = action_receipt_set(&request, &receipt);
    let candidate = CandidateCreatedV2 {
        run_id: request.run_id.clone(),
        candidate_id: "candidate-v2-1".into(),
        candidate_ref: "refs/buildplane/candidates/candidate-v2-1/run-1/1".into(),
        workflow_id: request.workflow_id.clone(),
        unit_id: request.unit_id.clone(),
        attempt: request.attempt,
        provenance_ref: request.provenance_ref.clone(),
        candidate_digest: DIGEST_A.into(),
        base_commit_sha: "1".repeat(40),
        candidate_commit_sha: "2".repeat(40),
        commit_digest: DIGEST_B.into(),
        tree_digest: DIGEST_A.into(),
        patch_digest: DIGEST_B.into(),
        changed_files_digest: DIGEST_A.into(),
        envelope_digest: request.dispatch_envelope_digest.clone(),
        action_receipt_set_ref: set.action_receipt_set_ref.clone(),
        action_receipt_set_digest: set.action_receipt_set_digest.clone(),
    };

    assert_canonical_variant!(
        "dispatch_envelope_v3",
        Payload::DispatchEnvelopeV3(dispatch),
        DispatchEnvelopeV3
    );
    assert_canonical_variant!(
        "action_requested_v2",
        Payload::ActionRequestedV2(request),
        ActionRequestedV2
    );
    assert_canonical_variant!(
        "model_action_authorized_v1",
        Payload::ModelActionAuthorizedV1(authorization),
        ModelActionAuthorizedV1
    );
    assert_canonical_variant!(
        "action_receipt_recorded_v2",
        Payload::ActionReceiptRecordedV2(receipt),
        ActionReceiptRecordedV2
    );
    assert_canonical_variant!(
        "action_receipt_set_recorded_v1",
        Payload::ActionReceiptSetRecordedV1(set),
        ActionReceiptSetRecordedV1
    );
    assert_canonical_variant!(
        "candidate_created_v2",
        Payload::CandidateCreatedV2(candidate),
        CandidateCreatedV2
    );
}

#[test]
fn candidate_completion_payload_is_closed_and_digest_bound() {
    let completion = candidate_completion();
    assert_canonical_variant!(
        "candidate_completion_recorded_v1",
        Payload::CandidateCompletionRecordedV1(completion.clone()),
        CandidateCompletionRecordedV1
    );

    let mut rebound = completion.clone();
    rebound.candidate_create_action_id = "different-action".into();
    let error = canonicalize_payload(
        "candidate_completion_recorded_v1",
        1,
        serde_json::to_value(Payload::CandidateCompletionRecordedV1(rebound))
            .expect("serialize rebound completion"),
    )
    .expect_err("completion digest must reject a rebound action lineage");
    assert!(error.to_string().contains("completion_digest"));
}

#[test]
fn v3_action_evidence_rejects_unknown_fields_and_noncanonical_receipt_sets() {
    let request = action_request();
    let receipt = action_receipt(&request);
    let mut request_value =
        serde_json::to_value(Payload::ActionRequestedV2(request.clone())).unwrap();
    request_value["ActionRequestedV2"]["candidate_digest"] = json!(DIGEST_A);
    assert!(canonicalize_payload("action_requested_v2", 1, request_value).is_err());

    let mut set = action_receipt_set(&request, &receipt);
    let duplicate = set.receipts[0].clone();
    set.receipts.push(duplicate);
    set.action_receipt_set_digest = action_receipt_set_v1_digest(&set).unwrap();
    let set_value = serde_json::to_value(Payload::ActionReceiptSetRecordedV1(set)).unwrap();
    let error = canonicalize_payload("action_receipt_set_recorded_v1", 1, set_value)
        .expect_err("a sealed receipt set must be strictly sorted and unique");
    assert!(error.to_string().contains("strictly sorted"));
}

#[test]
fn action_gateway_authorization_reference_is_compatibly_optional_but_digest_bound() {
    let request = action_request();
    let receipt = action_receipt(&request);
    let legacy_digest = action_receipt_recorded_v2_digest(&receipt)
        .expect("legacy receipt with no authorization reference remains digestible");

    let mut authorized = receipt.clone();
    authorized.authorization_ref = Some("authorization:action-1".into());
    let authorized_digest = action_receipt_recorded_v2_digest(&authorized)
        .expect("authorized receipt remains digestible");
    assert_ne!(authorized_digest, legacy_digest);

    let mut blank = authorized.clone();
    blank.authorization_ref = Some("  ".into());
    let value = serde_json::to_value(Payload::ActionReceiptRecordedV2(blank))
        .expect("serialize blank authorization reference");
    let error = canonicalize_payload("action_receipt_recorded_v2", 1, value)
        .expect_err("blank authorization reference must be rejected when present");
    assert!(error.to_string().contains("authorization_ref"));
}

#[test]
fn model_action_authorization_is_closed_digest_bound_and_requires_paired_candidate_view() {
    let mut request = action_request();
    request.action_kind = ActionKindV1::Model;
    let authorization = model_action_authorization(&request);
    let digest = authorization.authorization_digest.clone();

    assert_canonical_variant!(
        "model_action_authorized_v1",
        Payload::ModelActionAuthorizedV1(authorization.clone()),
        ModelActionAuthorizedV1
    );
    assert_eq!(
        model_action_authorized_v1_digest(&authorization).expect("rehash authorization"),
        digest
    );

    let mut mismatched_digest = authorization.clone();
    mismatched_digest.model_request_digest = DIGEST_A.into();
    let error = canonicalize_payload(
        "model_action_authorized_v1",
        1,
        serde_json::to_value(Payload::ModelActionAuthorizedV1(mismatched_digest))
            .expect("serialize mutated authorization"),
    )
    .expect_err("authorization digest must bind the exact model request");
    assert!(error.to_string().contains("authorization_digest"));

    let mut unpaired_candidate = authorization.clone();
    unpaired_candidate.candidate_digest = Some(DIGEST_A.into());
    unpaired_candidate.authorization_digest =
        model_action_authorized_v1_digest(&unpaired_candidate)
            .expect("rehash unpaired authorization");
    let error = canonicalize_payload(
        "model_action_authorized_v1",
        1,
        serde_json::to_value(Payload::ModelActionAuthorizedV1(unpaired_candidate))
            .expect("serialize unpaired authorization"),
    )
    .expect_err("candidate digest cannot be detached from its candidate view");
    assert!(error.to_string().contains("candidate_digest"));

    let mut implementer_candidate_binding = authorization.clone();
    implementer_candidate_binding.candidate_digest = Some(DIGEST_A.into());
    implementer_candidate_binding.candidate_view_digest = Some(DIGEST_B.into());
    implementer_candidate_binding.authorization_digest =
        model_action_authorized_v1_digest(&implementer_candidate_binding)
            .expect("rehash implementer candidate binding");
    let error = canonicalize_payload(
        "model_action_authorized_v1",
        1,
        serde_json::to_value(Payload::ModelActionAuthorizedV1(
            implementer_candidate_binding,
        ))
        .expect("serialize implementer candidate binding"),
    )
    .expect_err("implementers must not receive candidate review bindings");
    assert!(error.to_string().contains("implementer"));

    let mut reviewer_without_view = authorization.clone();
    reviewer_without_view.execution_role = ExecutionRoleV1::Reviewer;
    reviewer_without_view.authorization_digest =
        model_action_authorized_v1_digest(&reviewer_without_view)
            .expect("rehash reviewer without candidate view");
    let error = canonicalize_payload(
        "model_action_authorized_v1",
        1,
        serde_json::to_value(Payload::ModelActionAuthorizedV1(reviewer_without_view))
            .expect("serialize reviewer without candidate view"),
    )
    .expect_err("read-only reviewer roles require candidate view bindings");
    assert!(error.to_string().contains("require candidate"));

    let mut candidate_role = authorization.clone();
    candidate_role.execution_role = ExecutionRoleV1::Candidate;
    candidate_role.authorization_digest = model_action_authorized_v1_digest(&candidate_role)
        .expect("rehash candidate role authorization");
    let error = canonicalize_payload(
        "model_action_authorized_v1",
        1,
        serde_json::to_value(Payload::ModelActionAuthorizedV1(candidate_role))
            .expect("serialize candidate role authorization"),
    )
    .expect_err("candidate role must never gain model authority");
    assert!(error.to_string().contains("candidate execution role"));

    let mut whitespace_actor = authorization.clone();
    whitespace_actor.authorization_actor = "kernel authority".into();
    whitespace_actor.authorization_digest = model_action_authorized_v1_digest(&whitespace_actor)
        .expect("rehash whitespace authority actor");
    let error = canonicalize_payload(
        "model_action_authorized_v1",
        1,
        serde_json::to_value(Payload::ModelActionAuthorizedV1(whitespace_actor))
            .expect("serialize whitespace authority actor"),
    )
    .expect_err("authorization actor cannot contain whitespace");
    assert!(error.to_string().contains("authorization_actor"));

    let mut expired = authorization;
    expired.expires_at = "not-a-timestamp".into();
    expired.authorization_digest =
        model_action_authorized_v1_digest(&expired).expect("rehash malformed expiry");
    let error = canonicalize_payload(
        "model_action_authorized_v1",
        1,
        serde_json::to_value(Payload::ModelActionAuthorizedV1(expired))
            .expect("serialize malformed expiry"),
    )
    .expect_err("authorization expiry must be closed RFC3339 UTC");
    assert!(error.to_string().contains("expires_at"));
}

#[test]
fn model_action_intent_and_v2_authorization_are_closed_digest_bound_records() {
    let mut request = action_request();
    request.action_kind = ActionKindV1::Model;
    let intent = model_action_intent(&request);
    let authorization = model_action_authorization_v2(&intent);

    assert_canonical_variant!(
        "model_action_intent_v1",
        Payload::ModelActionIntentV1(intent.clone()),
        ModelActionIntentV1
    );
    assert_eq!(
        model_action_intent_v1_digest(&intent).expect("rehash intent"),
        intent.intent_digest
    );
    assert_canonical_variant!(
        "model_action_authorized_v2",
        Payload::ModelActionAuthorizedV2(authorization.clone()),
        ModelActionAuthorizedV2
    );
    assert_eq!(
        model_action_authorized_v2_digest(&authorization).expect("rehash V2 authorization"),
        authorization.authorization_digest
    );

    let mut mutated_intent = intent.clone();
    mutated_intent.model_request_evidence.cas_ref = format!("cas:{DIGEST_B}");
    let error = canonicalize_payload(
        "model_action_intent_v1",
        1,
        serde_json::to_value(Payload::ModelActionIntentV1(mutated_intent))
            .expect("serialize mutated intent"),
    )
    .expect_err("intent digest must bind its exact model request evidence reference");
    assert!(error.to_string().contains("must name the exact raw digest"));

    let mut mismatched_evidence_reference = authorization.clone();
    mismatched_evidence_reference.trust_scope_evidence.digest = DIGEST_A.into();
    let error = canonicalize_payload(
        "model_action_authorized_v2",
        1,
        serde_json::to_value(Payload::ModelActionAuthorizedV2(
            mismatched_evidence_reference,
        ))
        .expect("serialize mutated V2 authorization"),
    )
    .expect_err("V2 authorization must reject an evidence reference that names another digest");
    assert!(error.to_string().contains("must name the exact raw digest"));

    let mut mutated_authorization = authorization;
    mutated_authorization.trust_scope_evidence.digest = DIGEST_A.into();
    mutated_authorization.trust_scope_evidence.cas_ref = format!("cas:{DIGEST_A}");
    let error = canonicalize_payload(
        "model_action_authorized_v2",
        1,
        serde_json::to_value(Payload::ModelActionAuthorizedV2(mutated_authorization))
            .expect("serialize mutated V2 authorization"),
    )
    .expect_err("V2 authorization digest must bind its exact repeated trust evidence");
    assert!(error.to_string().contains("authorization_digest"));
}

#[test]
fn action_resource_usage_rejects_values_outside_the_typescript_safe_integer_range() {
    assert_eq!(TYPESCRIPT_SAFE_INTEGER_MAX, 9_007_199_254_740_991);

    let boundary = ActionResourceUsageV1 {
        wall_time_ms: TYPESCRIPT_SAFE_INTEGER_MAX,
        cpu_time_ms: Some(TYPESCRIPT_SAFE_INTEGER_MAX),
        peak_memory_bytes: None,
        input_bytes: None,
        output_bytes: None,
        input_tokens: Some(TYPESCRIPT_SAFE_INTEGER_MAX),
        output_tokens: Some(TYPESCRIPT_SAFE_INTEGER_MAX),
    };
    let boundary_json = serde_json::to_value(&boundary)
        .expect("the JavaScript-safe integer boundary must serialize");
    assert_eq!(
        boundary_json["wall_time_ms"],
        json!(TYPESCRIPT_SAFE_INTEGER_MAX)
    );
    assert_eq!(
        boundary_json["input_tokens"],
        json!(TYPESCRIPT_SAFE_INTEGER_MAX)
    );
    assert_eq!(
        boundary_json["output_tokens"],
        json!(TYPESCRIPT_SAFE_INTEGER_MAX)
    );
    let parsed: ActionResourceUsageV1 = serde_json::from_value(boundary_json)
        .expect("the JavaScript-safe integer boundary must deserialize");
    assert_eq!(parsed, boundary);

    let legacy: ActionResourceUsageV1 = serde_json::from_value(json!({
        "wall_time_ms": 1,
    }))
    .expect("historical receipts without token observations remain readable");
    assert_eq!(legacy.input_tokens, None);
    assert_eq!(legacy.output_tokens, None);

    let unsafe_value = TYPESCRIPT_SAFE_INTEGER_MAX + 1;
    let unsafe_usage = ActionResourceUsageV1 {
        wall_time_ms: unsafe_value,
        cpu_time_ms: None,
        peak_memory_bytes: None,
        input_bytes: None,
        output_bytes: None,
        input_tokens: None,
        output_tokens: None,
    };
    assert!(
        serde_json::to_value(&unsafe_usage).is_err(),
        "Rust must not emit resource values that JavaScript cannot represent exactly"
    );
    assert!(
        serde_json::from_value::<ActionResourceUsageV1>(json!({
            "wall_time_ms": unsafe_value,
        }))
        .is_err(),
        "Rust must reject unsafe resource values arriving from JavaScript"
    );
    assert!(
        serde_json::from_value::<ActionResourceUsageV1>(json!({
            "wall_time_ms": TYPESCRIPT_SAFE_INTEGER_MAX,
            "cpu_time_ms": unsafe_value,
        }))
        .is_err(),
        "optional resource values share the same exact-number boundary"
    );
    assert!(
        serde_json::from_value::<ActionResourceUsageV1>(json!({
            "wall_time_ms": TYPESCRIPT_SAFE_INTEGER_MAX,
            "input_tokens": unsafe_value,
        }))
        .is_err(),
        "input token observations share the same exact-number boundary"
    );
    assert!(
        serde_json::from_value::<ActionResourceUsageV1>(json!({
            "wall_time_ms": TYPESCRIPT_SAFE_INTEGER_MAX,
            "output_tokens": unsafe_value,
        }))
        .is_err(),
        "output token observations share the same exact-number boundary"
    );

    let request = action_request();
    let mut receipt = action_receipt(&request);
    receipt.resource_usage.wall_time_ms = unsafe_value;
    assert!(
        action_receipt_recorded_v2_digest(&receipt).is_err(),
        "unsafe resource evidence must not be sealable into a canonical receipt digest"
    );
}

#[test]
fn legacy_promotion_payloads_without_target_or_git_binding_remain_readable() {
    let decision = json!({
        "PromotionDecisionRecordedV1": {
            "candidate_digest": DIGEST_A,
            "base_commit_sha": "1".repeat(40),
            "envelope_digest": DIGEST_B,
            "acceptance_ref": "acceptance:1",
            "review_refs": ["review:1"],
            "decision": "promote",
            "authority": "operator",
            "decided_by": "operator:1",
            "decided_at": "2026-07-17T00:03:00Z",
            "idempotency_key": "promotion:1"
        }
    });
    let result = json!({
        "PromotionResultRecordedV1": {
            "candidate_digest": DIGEST_A,
            "idempotency_key": "promotion:1",
            "promotion_decision_ref": "decision:1",
            "outcome": "promoted",
            "merged_head_sha": "3".repeat(40),
            "completed_at": "2026-07-17T00:04:00Z"
        }
    });

    let Payload::PromotionDecisionRecordedV1(parsed_decision) =
        canonicalize_payload("promotion_decision_recorded", 1, decision).unwrap()
    else {
        panic!("expected promotion decision payload");
    };
    let Payload::PromotionResultRecordedV1(parsed_result) =
        canonicalize_payload("promotion_result_recorded", 1, result).unwrap()
    else {
        panic!("expected promotion result payload");
    };

    assert!(parsed_decision.target_ref.is_none());
    assert!(parsed_decision.promotion_approval_request_ref.is_none());
    assert!(parsed_result.promotion_git_binding.is_none());
}
