//! Closed release-evaluation evidence contract tests.

use bp_ledger::id::EventId;
use bp_ledger::kind::EventKind;
use bp_ledger::payload::release_evaluation::{
    release_evaluation_evidence_v1_claim_digest, validate_release_evaluation_evidence_v1,
    ReleaseEvaluationBackwardReplayCompatibilityClaimV1, ReleaseEvaluationCheckConclusionV1,
    ReleaseEvaluationClaimKindV1, ReleaseEvaluationClaimV1, ReleaseEvaluationEvidenceV1,
    ReleaseEvaluationGovernanceV1, ReleaseEvaluationRequiredCheckClaimV1,
    ReleaseEvaluationSourceEventRefV1, ReleaseEvaluationTargetBranchImmutabilityClaimV1,
    ReleaseEvaluationTrialClaimV1, ReleaseEvaluationTrialSourcesV1,
    RELEASE_EVALUATION_EVIDENCE_V1_SCHEMA_VERSION,
};
use bp_ledger::payload::Payload;
use uuid::Uuid;

fn sha256(byte: char) -> String {
    format!("sha256:{}", byte.to_string().repeat(64))
}

fn source(index: u128, digest_byte: char) -> ReleaseEvaluationSourceEventRefV1 {
    ReleaseEvaluationSourceEventRefV1 {
        source_event_id: EventId::from_uuid(Uuid::from_u128(index)),
        source_canonical_event_hash: sha256(digest_byte),
    }
}

fn trial_sources() -> ReleaseEvaluationTrialSourcesV1 {
    ReleaseEvaluationTrialSourcesV1 {
        model_request: source(1, 'a'),
        candidate: source(2, 'b'),
        acceptance: source(3, 'c'),
        review: source(4, 'd'),
        recovery: source(5, 'e'),
        terminal: source(6, 'f'),
    }
}

fn signed_evidence(
    claim_kind: ReleaseEvaluationClaimKindV1,
    claim: ReleaseEvaluationClaimV1,
) -> ReleaseEvaluationEvidenceV1 {
    let mut evidence = ReleaseEvaluationEvidenceV1 {
        schema_version: RELEASE_EVALUATION_EVIDENCE_V1_SCHEMA_VERSION,
        release_commit: "a".repeat(40),
        release_ref: "refs/heads/main".into(),
        policy_digest: sha256('f'),
        claim_kind,
        claim,
        claim_digest: String::new(),
    };
    evidence.claim_digest = release_evaluation_evidence_v1_claim_digest(&evidence).unwrap();
    evidence
}

fn trial_evidence() -> ReleaseEvaluationEvidenceV1 {
    signed_evidence(
        ReleaseEvaluationClaimKindV1::Trial,
        ReleaseEvaluationClaimV1::Trial(ReleaseEvaluationTrialClaimV1 {
            task_id: "task-a".into(),
            provider: "openai".into(),
            trust_tier: "standard".into(),
            trial: 1,
            governance: ReleaseEvaluationGovernanceV1::Governed,
            passed: true,
            cost_usd_micros: 1_250_000,
            latency_ms: 250,
            tokens: 4_096,
            tool_calls: 3,
            candidate_count: 1,
            reviewer_disagreed: false,
            false_approval: false,
            unauthorized_effects: 0,
            duplicate_effects: 0,
            safety_violations: 0,
            recovery_correct: true,
            illegitimate_success: false,
            sources: trial_sources(),
        }),
    )
}

#[test]
fn trial_claim_round_trips_in_the_payload_enum() {
    let evidence = trial_evidence();
    validate_release_evaluation_evidence_v1(&evidence).unwrap();

    let payload = Payload::ReleaseEvaluationEvidenceV1(evidence.clone());
    let json = serde_json::to_value(&payload).unwrap();
    let body = json
        .get("ReleaseEvaluationEvidenceV1")
        .expect("payload must use the stable externally tagged variant");
    assert_eq!(body["claim_kind"], "trial");
    assert_eq!(body["claim"]["cost_usd_micros"], 1_250_000);
    assert_eq!(body["claim"]["unauthorized_effects"], 0);
    assert_eq!(
        body["claim"]["sources"]["terminal"]["source_canonical_event_hash"],
        sha256('f')
    );

    let decoded: Payload = serde_json::from_value(json).unwrap();
    assert_eq!(decoded, payload);
    assert_eq!(
        EventKind::ReleaseEvaluationEvidenceV1.as_wire(),
        "release_evaluation_evidence_v1"
    );
}

#[test]
fn claim_digest_binds_metrics_outcomes_and_each_source_reference() {
    let evidence = trial_evidence();

    let mut changed_metric = evidence.clone();
    let ReleaseEvaluationClaimV1::Trial(trial) = &mut changed_metric.claim else {
        panic!("fixture must contain a trial claim");
    };
    trial.unauthorized_effects = 1;
    assert!(validate_release_evaluation_evidence_v1(&changed_metric).is_err());

    let mut changed_outcome = evidence.clone();
    let ReleaseEvaluationClaimV1::Trial(trial) = &mut changed_outcome.claim else {
        panic!("fixture must contain a trial claim");
    };
    trial.recovery_correct = false;
    assert!(validate_release_evaluation_evidence_v1(&changed_outcome).is_err());

    let mut changed_source = evidence;
    let ReleaseEvaluationClaimV1::Trial(trial) = &mut changed_source.claim else {
        panic!("fixture must contain a trial claim");
    };
    trial.sources.review.source_canonical_event_hash = sha256('0');
    assert!(validate_release_evaluation_evidence_v1(&changed_source).is_err());
}

#[test]
fn claim_kind_and_json_shape_are_closed() {
    let evidence = trial_evidence();

    let mut mismatched_kind = evidence.clone();
    mismatched_kind.claim_kind = ReleaseEvaluationClaimKindV1::RequiredCheck;
    mismatched_kind.claim_digest =
        release_evaluation_evidence_v1_claim_digest(&mismatched_kind).unwrap();
    assert!(validate_release_evaluation_evidence_v1(&mismatched_kind).is_err());

    let mut unknown_top_level = serde_json::to_value(&evidence).unwrap();
    unknown_top_level["unexpected"] = serde_json::json!(true);
    assert!(serde_json::from_value::<ReleaseEvaluationEvidenceV1>(unknown_top_level).is_err());

    let mut unknown_claim_field = serde_json::to_value(&evidence).unwrap();
    unknown_claim_field["claim"]["unexpected"] = serde_json::json!(true);
    assert!(serde_json::from_value::<ReleaseEvaluationEvidenceV1>(unknown_claim_field).is_err());
}

#[test]
fn every_invariant_claim_carries_its_direct_gate_input_and_source() {
    let branch = signed_evidence(
        ReleaseEvaluationClaimKindV1::TargetBranchImmutability,
        ReleaseEvaluationClaimV1::TargetBranchImmutability(
            ReleaseEvaluationTargetBranchImmutabilityClaimV1 {
                immutable: false,
                source: source(7, '7'),
            },
        ),
    );
    let replay = signed_evidence(
        ReleaseEvaluationClaimKindV1::BackwardReplayCompatibility,
        ReleaseEvaluationClaimV1::BackwardReplayCompatibility(
            ReleaseEvaluationBackwardReplayCompatibilityClaimV1 {
                compatible: true,
                source: source(8, '8'),
            },
        ),
    );
    let required_check = signed_evidence(
        ReleaseEvaluationClaimKindV1::RequiredCheck,
        ReleaseEvaluationClaimV1::RequiredCheck(ReleaseEvaluationRequiredCheckClaimV1 {
            name: "verify".into(),
            conclusion: ReleaseEvaluationCheckConclusionV1::Failure,
            source: source(9, '9'),
        }),
    );

    for evidence in [&branch, &replay, &required_check] {
        validate_release_evaluation_evidence_v1(evidence).unwrap();
    }

    let ReleaseEvaluationClaimV1::TargetBranchImmutability(claim) = &branch.claim else {
        panic!("fixture must preserve the target-branch claim");
    };
    assert!(!claim.immutable);

    let ReleaseEvaluationClaimV1::BackwardReplayCompatibility(claim) = &replay.claim else {
        panic!("fixture must preserve the replay claim");
    };
    assert!(claim.compatible);

    let ReleaseEvaluationClaimV1::RequiredCheck(claim) = &required_check.claim else {
        panic!("fixture must preserve the required-check claim");
    };
    assert_eq!(claim.name, "verify");
    assert_eq!(
        claim.conclusion,
        ReleaseEvaluationCheckConclusionV1::Failure
    );
}

#[test]
fn trial_requires_closed_trial_number_and_distinct_sources_even_with_a_recomputed_digest() {
    let mut invalid_trial = trial_evidence();
    let ReleaseEvaluationClaimV1::Trial(trial) = &mut invalid_trial.claim else {
        panic!("fixture must contain a trial claim");
    };
    trial.trial = 4;
    invalid_trial.claim_digest =
        release_evaluation_evidence_v1_claim_digest(&invalid_trial).unwrap();
    assert!(validate_release_evaluation_evidence_v1(&invalid_trial).is_err());

    let mut duplicate_source = trial_evidence();
    let ReleaseEvaluationClaimV1::Trial(trial) = &mut duplicate_source.claim else {
        panic!("fixture must contain a trial claim");
    };
    trial.sources.terminal = trial.sources.review.clone();
    duplicate_source.claim_digest =
        release_evaluation_evidence_v1_claim_digest(&duplicate_source).unwrap();
    assert!(validate_release_evaluation_evidence_v1(&duplicate_source).is_err());
}
