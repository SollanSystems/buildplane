use bp_ledger::canonicalize::canonicalize_payload;
use bp_ledger::payload::trust_spine::{
    PromotionApprovalRequestedV1, PromotionDecisionKindV1, PromotionDecisionRecordedV1,
    PromotionGitBindingV1, PromotionReconciliationResolvedV1, PromotionResultOutcomeV1,
    PromotionResultRecordedV1, PromotionWorktreeSyncStateV1, ReconciliationResolutionOutcomeV1,
};
use bp_ledger::Payload;

const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn canonicalize(kind: &str, payload: Payload) -> bp_ledger::Result<Payload> {
    canonicalize_payload(
        kind,
        1,
        serde_json::to_value(payload).expect("promotion fixture serializes"),
    )
}

fn approval_request() -> PromotionApprovalRequestedV1 {
    PromotionApprovalRequestedV1 {
        candidate_digest: DIGEST_A.into(),
        base_commit_sha: "1".repeat(40),
        target_ref: "refs/heads/main".into(),
        envelope_digest: DIGEST_B.into(),
        acceptance_ref: "acceptance:1".into(),
        review_refs: vec!["review:1".into()],
        requested_by: "kernel:promotion".into(),
        requested_at: "2026-07-20T12:00:00Z".into(),
        idempotency_key: "promotion:1".into(),
    }
}

fn target_bound_decision() -> PromotionDecisionRecordedV1 {
    PromotionDecisionRecordedV1 {
        candidate_digest: DIGEST_A.into(),
        base_commit_sha: "1".repeat(40),
        target_ref: Some("refs/heads/main".into()),
        envelope_digest: DIGEST_B.into(),
        acceptance_ref: "acceptance:1".into(),
        review_refs: vec!["review:1".into()],
        promotion_approval_request_ref: Some("approval:1".into()),
        decision: PromotionDecisionKindV1::Promote,
        authority: "operator:promotion".into(),
        decided_by: "operator:promotion".into(),
        decided_at: "2026-07-20T12:01:00Z".into(),
        idempotency_key: "promotion:1".into(),
    }
}

fn target_bound_binding(state: PromotionWorktreeSyncStateV1) -> PromotionGitBindingV1 {
    PromotionGitBindingV1 {
        target_ref: "refs/heads/main".into(),
        target_head_before_sha: "1".repeat(40),
        target_head_after_sha: Some("3".repeat(40)),
        merged_head_sha: Some("3".repeat(40)),
        candidate_commit_sha: "2".repeat(40),
        merge_parent_shas: Some(vec!["1".repeat(40), "2".repeat(40)]),
        merged_tree_sha: Some("4".repeat(40)),
        merged_tree_digest: DIGEST_A.into(),
        promotion_receipt_ref: Some("refs/buildplane/promotions/candidate-1/run-1/1".into()),
        worktree_sync_state: Some(state),
    }
}

fn promoted_result() -> PromotionResultRecordedV1 {
    PromotionResultRecordedV1 {
        candidate_digest: DIGEST_A.into(),
        idempotency_key: "promotion:1".into(),
        promotion_decision_ref: "decision:1".into(),
        outcome: PromotionResultOutcomeV1::Promoted,
        merged_head_sha: Some("3".repeat(40)),
        promotion_git_binding: Some(target_bound_binding(
            PromotionWorktreeSyncStateV1::PendingReconciliation,
        )),
        promotion_execution_lease_binding: None,
        completed_at: "2026-07-20T12:02:00Z".into(),
    }
}

fn reconciliation_required_result() -> PromotionResultRecordedV1 {
    let mut result = promoted_result();
    result.outcome = PromotionResultOutcomeV1::ReconciliationRequired;
    result
        .promotion_git_binding
        .as_mut()
        .expect("fixture carries binding")
        .worktree_sync_state = Some(PromotionWorktreeSyncStateV1::RootCheckoutStale);
    result
}

fn reconciliation() -> PromotionReconciliationResolvedV1 {
    PromotionReconciliationResolvedV1 {
        candidate_digest: DIGEST_A.into(),
        promotion_decision_ref: "decision:1".into(),
        promotion_result_ref: "result:1".into(),
        promotion_receipt_ref: "refs/buildplane/promotions/candidate-1/run-1/1".into(),
        outcome: ReconciliationResolutionOutcomeV1::Abandon,
        authority: "operator:promotion".into(),
        resolved_by: "operator:promotion".into(),
        idempotency_key: "reconciliation:1".into(),
        resolved_at: "2026-07-20T12:03:00Z".into(),
    }
}

#[test]
fn promotion_approval_request_requires_a_closed_target_and_review_set() {
    assert!(canonicalize(
        "promotion_approval_requested",
        Payload::PromotionApprovalRequestedV1(approval_request())
    )
    .is_ok());

    let mut invalid_target = approval_request();
    invalid_target.target_ref = "refs/tags/v1.0.0".into();
    assert!(canonicalize(
        "promotion_approval_requested",
        Payload::PromotionApprovalRequestedV1(invalid_target)
    )
    .is_err());

    let mut duplicate_reviews = approval_request();
    duplicate_reviews.review_refs.push("review:1".into());
    assert!(canonicalize(
        "promotion_approval_requested",
        Payload::PromotionApprovalRequestedV1(duplicate_reviews)
    )
    .is_err());
}

#[test]
fn target_bound_promotion_decision_requires_matching_operator_identity() {
    assert!(canonicalize(
        "promotion_decision_recorded",
        Payload::PromotionDecisionRecordedV1(target_bound_decision())
    )
    .is_ok());

    let mut mismatched_actor = target_bound_decision();
    mismatched_actor.decided_by = "operator:other".into();
    assert!(canonicalize(
        "promotion_decision_recorded",
        Payload::PromotionDecisionRecordedV1(mismatched_actor)
    )
    .is_err());

    let mut missing_target = target_bound_decision();
    missing_target.target_ref = None;
    assert!(canonicalize(
        "promotion_decision_recorded",
        Payload::PromotionDecisionRecordedV1(missing_target)
    )
    .is_err());
}

#[test]
fn target_bound_promotion_result_requires_coherent_merge_evidence() {
    assert!(canonicalize(
        "promotion_result_recorded",
        Payload::PromotionResultRecordedV1(reconciliation_required_result())
    )
    .is_ok());

    let mut wrong_merge = reconciliation_required_result();
    wrong_merge
        .promotion_git_binding
        .as_mut()
        .expect("fixture carries binding")
        .merged_head_sha = Some("4".repeat(40));
    assert!(canonicalize(
        "promotion_result_recorded",
        Payload::PromotionResultRecordedV1(wrong_merge)
    )
    .is_err());

    let mut impossible_state = reconciliation_required_result();
    impossible_state
        .promotion_git_binding
        .as_mut()
        .expect("fixture carries binding")
        .worktree_sync_state = Some(PromotionWorktreeSyncStateV1::PendingReconciliation);
    assert!(canonicalize(
        "promotion_result_recorded",
        Payload::PromotionResultRecordedV1(impossible_state)
    )
    .is_err());

    let mut partial_binding = reconciliation_required_result();
    partial_binding
        .promotion_git_binding
        .as_mut()
        .expect("fixture carries binding")
        .target_head_after_sha = None;
    assert!(canonicalize(
        "promotion_result_recorded",
        Payload::PromotionResultRecordedV1(partial_binding)
    )
    .is_err());
}

#[test]
fn reconciliation_required_result_requires_a_complete_target_bound_binding() {
    assert!(canonicalize(
        "promotion_result_recorded",
        Payload::PromotionResultRecordedV1(reconciliation_required_result())
    )
    .is_ok());

    let mut missing_binding = reconciliation_required_result();
    missing_binding.promotion_git_binding = None;
    assert!(canonicalize(
        "promotion_result_recorded",
        Payload::PromotionResultRecordedV1(missing_binding)
    )
    .is_err());
}

#[test]
fn promoted_result_cannot_hide_pending_reconciliation() {
    assert!(canonicalize(
        "promotion_result_recorded",
        Payload::PromotionResultRecordedV1(promoted_result())
    )
    .is_err());
}

#[test]
fn promotion_reconciliation_requires_closed_refs_and_operator_binding() {
    assert!(canonicalize(
        "promotion_reconciliation_resolved",
        Payload::PromotionReconciliationResolvedV1(reconciliation())
    )
    .is_ok());

    let mut mismatched_actor = reconciliation();
    mismatched_actor.resolved_by = "operator:other".into();
    assert!(canonicalize(
        "promotion_reconciliation_resolved",
        Payload::PromotionReconciliationResolvedV1(mismatched_actor)
    )
    .is_err());

    let mut malformed_receipt = reconciliation();
    malformed_receipt.promotion_receipt_ref = "refs/buildplane/promotions/../other".into();
    assert!(canonicalize(
        "promotion_reconciliation_resolved",
        Payload::PromotionReconciliationResolvedV1(malformed_receipt)
    )
    .is_err());
}

#[test]
fn promotion_authority_records_reject_malformed_digest_ref_and_timestamp_values() {
    let mut malformed_digest = approval_request();
    malformed_digest.candidate_digest = "sha256:not-a-canonical-digest".into();
    assert!(canonicalize(
        "promotion_approval_requested",
        Payload::PromotionApprovalRequestedV1(malformed_digest)
    )
    .is_err());

    let mut non_utc_timestamp = target_bound_decision();
    non_utc_timestamp.decided_at = "2026-07-20T12:01:00+00:00".into();
    assert!(canonicalize(
        "promotion_decision_recorded",
        Payload::PromotionDecisionRecordedV1(non_utc_timestamp)
    )
    .is_err());

    let mut malformed_ref = promoted_result();
    malformed_ref.promotion_decision_ref = "decision ref".into();
    assert!(canonicalize(
        "promotion_result_recorded",
        Payload::PromotionResultRecordedV1(malformed_ref)
    )
    .is_err());

    let mut malformed_timestamp = reconciliation();
    malformed_timestamp.resolved_at = "not-a-timestamp".into();
    assert!(canonicalize(
        "promotion_reconciliation_resolved",
        Payload::PromotionReconciliationResolvedV1(malformed_timestamp)
    )
    .is_err());
}

#[test]
fn legacy_unbound_promotion_records_remain_readable() {
    let mut decision = target_bound_decision();
    decision.target_ref = None;
    decision.promotion_approval_request_ref = None;
    decision.authority = "operator".into();
    decision.decided_by = "operator:legacy".into();
    assert!(canonicalize(
        "promotion_decision_recorded",
        Payload::PromotionDecisionRecordedV1(decision)
    )
    .is_ok());

    let mut result = promoted_result();
    result.promotion_git_binding = None;
    assert!(canonicalize(
        "promotion_result_recorded",
        Payload::PromotionResultRecordedV1(result)
    )
    .is_ok());
}
