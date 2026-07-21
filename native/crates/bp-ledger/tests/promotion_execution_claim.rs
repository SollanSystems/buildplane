//! Closed, canonical promotion-execution claim schema tests.

use bp_ledger::canonicalize::{canonical_event_hash, canonicalize, canonicalize_payload};
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::trust_spine::{
    promotion_execution_claimed_v1_digest, PromotionExecutionClaimedV1,
    PromotionExecutionLeaseBindingV1, PromotionResultOutcomeV1, PromotionResultRecordedV1,
};
use bp_ledger::payload::Payload;
use chrono::Utc;
use serde_json::{json, Value};

const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn promotion_execution_claim(run_id: RunId) -> PromotionExecutionClaimedV1 {
    let mut claim = PromotionExecutionClaimedV1 {
        run_id: run_id.to_string(),
        promotion_decision_event_ref: EventId::new(),
        promotion_decision_event_digest: DIGEST_A.into(),
        dispatch_event_ref: EventId::new(),
        dispatch_envelope_digest: DIGEST_B.into(),
        candidate_digest: DIGEST_A.into(),
        candidate_ref: "refs/buildplane/candidates/candidate-1/run-1".into(),
        candidate_commit_sha: "1".repeat(40),
        candidate_tree_digest: DIGEST_B.into(),
        base_commit_sha: "2".repeat(40),
        target_ref: "refs/heads/main".into(),
        idempotency_key: "promotion:run-1:candidate-1".into(),
        authority_actor: "kernel:promotion".into(),
        lease_id: "lease-1".into(),
        claimed_at: "2026-07-20T12:00:00Z".into(),
        lease_expires_at: "2026-07-20T12:05:00Z".into(),
        promotion_execution_claim_digest: String::new(),
    };
    claim.promotion_execution_claim_digest =
        promotion_execution_claimed_v1_digest(&claim).expect("claim fixture canonicalizes");
    claim
}

fn promotion_execution_claim_json(claim: PromotionExecutionClaimedV1) -> Value {
    serde_json::to_value(Payload::PromotionExecutionClaimedV1(claim))
        .expect("claim payload serializes")
}

fn rejected_promotion_result() -> PromotionResultRecordedV1 {
    PromotionResultRecordedV1 {
        candidate_digest: DIGEST_A.into(),
        idempotency_key: "promotion:run-1:candidate-1".into(),
        promotion_decision_ref: "decision:1".into(),
        outcome: PromotionResultOutcomeV1::Rejected,
        merged_head_sha: None,
        promotion_git_binding: None,
        promotion_execution_lease_binding: None,
        completed_at: "2026-07-20T12:01:00Z".into(),
    }
}

fn event(run_id: RunId, payload: Payload) -> Event {
    Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::PromotionExecutionClaimedV1,
        occurred_at: Utc::now(),
        payload,
    }
}

fn promotion_result_event(run_id: RunId, result: PromotionResultRecordedV1) -> Event {
    Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::PromotionResultRecorded,
        occurred_at: Utc::now(),
        payload: Payload::PromotionResultRecordedV1(result),
    }
}

#[test]
fn promotion_execution_claim_is_a_closed_canonical_kind() {
    let run_id = RunId::new();
    assert!(canonicalize_payload(
        "promotion_execution_claimed_v1",
        1,
        promotion_execution_claim_json(promotion_execution_claim(run_id)),
    )
    .is_ok());

    let mut unknown_field = promotion_execution_claim_json(promotion_execution_claim(run_id));
    unknown_field["PromotionExecutionClaimedV1"]["unexpected"] = json!(true);
    assert!(canonicalize_payload("promotion_execution_claimed_v1", 1, unknown_field).is_err());
}

#[test]
fn promotion_execution_claim_digest_binds_candidate_tree_and_expiry() {
    let run_id = RunId::new();
    let claim = promotion_execution_claim(run_id);
    assert!(canonicalize_payload(
        "promotion_execution_claimed_v1",
        1,
        promotion_execution_claim_json(claim.clone()),
    )
    .is_ok());

    let mut substituted_candidate_tree = claim.clone();
    substituted_candidate_tree.candidate_tree_digest = DIGEST_A.into();
    assert!(canonicalize_payload(
        "promotion_execution_claimed_v1",
        1,
        promotion_execution_claim_json(substituted_candidate_tree),
    )
    .is_err());

    let mut expired_at_claim = claim;
    expired_at_claim.lease_expires_at = expired_at_claim.claimed_at.clone();
    expired_at_claim.promotion_execution_claim_digest =
        promotion_execution_claimed_v1_digest(&expired_at_claim)
            .expect("expired fixture still has deterministic bytes");
    assert!(canonicalize_payload(
        "promotion_execution_claimed_v1",
        1,
        promotion_execution_claim_json(expired_at_claim),
    )
    .is_err());
}

#[test]
fn promotion_execution_claim_must_bind_the_enclosing_run() {
    let claim_run_id = RunId::new();
    let event_run_id = RunId::new();
    let claim = promotion_execution_claim(claim_run_id);

    assert!(canonicalize(event(
        event_run_id,
        Payload::PromotionExecutionClaimedV1(claim)
    ))
    .is_err());
}

#[test]
fn promotion_result_lease_binding_is_optional_but_canonical_when_present() {
    let legacy_result = rejected_promotion_result();
    assert!(canonicalize_payload(
        "promotion_result_recorded",
        1,
        serde_json::to_value(Payload::PromotionResultRecordedV1(legacy_result.clone()))
            .expect("legacy result serializes"),
    )
    .is_ok());

    let mut bound_result = legacy_result;
    bound_result.promotion_execution_lease_binding = Some(PromotionExecutionLeaseBindingV1 {
        promotion_execution_claim_event_ref: EventId::new(),
        promotion_execution_claim_event_digest: DIGEST_B.into(),
        lease_id: "lease-1".into(),
    });
    assert!(canonicalize_payload(
        "promotion_result_recorded",
        1,
        serde_json::to_value(Payload::PromotionResultRecordedV1(bound_result.clone()))
            .expect("bound result serializes"),
    )
    .is_ok());

    let run_id = RunId::new();
    let bound_event = promotion_result_event(run_id, bound_result.clone());
    let first_hash =
        canonical_event_hash(&bound_event).expect("bound result canonicalizes for signing");
    let mut altered_event = bound_event.clone();
    let Payload::PromotionResultRecordedV1(altered_lease) = &mut altered_event.payload else {
        panic!("fixture has a promotion result payload");
    };
    altered_lease
        .promotion_execution_lease_binding
        .as_mut()
        .expect("fixture has lease binding")
        .lease_id = "lease-2".into();
    let second_hash = canonical_event_hash(&altered_event)
        .expect("altered lease result remains structurally canonical");
    assert_ne!(
        first_hash, second_hash,
        "the optional lease binding must participate in the signed canonical event bytes"
    );

    let mut malformed_binding = bound_result;
    malformed_binding
        .promotion_execution_lease_binding
        .as_mut()
        .expect("fixture has lease binding")
        .promotion_execution_claim_event_digest = "sha256:not-canonical".into();
    assert!(canonicalize_payload(
        "promotion_result_recorded",
        1,
        serde_json::to_value(Payload::PromotionResultRecordedV1(malformed_binding))
            .expect("malformed binding serializes"),
    )
    .is_err());
}
