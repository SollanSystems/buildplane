use crate::command_action::BrokerCommandActionStatus;
use crate::governed_session_client::parse_governed_session_client_request;
use crate::governed_session_response::{
    governed_candidate_run_status_v1, governed_reviewer_run_result_v1,
    host_owned_governed_candidate_run_result_v1, host_owned_governed_reviewer_run_result_v1,
    sign_governed_session_probe_response_v1, sign_governed_session_response_v1,
    verify_governed_session_response_v1, GovernedCandidateReceiptProjectionV1,
    GovernedReviewReceiptProjectionV1,
};
use crate::BrokerModelActionStatus;
use bp_ledger::payload::trust_spine::{
    CandidateCreatedV2, ReviewDecisionV1, ReviewFindingSeverityV1, ReviewFindingV1,
};
use ed25519_dalek::SigningKey;

fn reviewer_request(recovery_ref: &str) -> Vec<u8> {
    format!(
        r#"{{"schema_version":1,"protocol":"buildplane-governed-session","request_id":"01919000-0000-7000-8000-000000000081","operation":"open_reviewer_session","project_root":"/srv/buildplane/repositories/example","recovery_ref":"{recovery_ref}"}}"#
    )
    .into_bytes()
}

fn candidate_run_request() -> Vec<u8> {
    br#"{"schema_version":1,"protocol":"buildplane-governed-session","request_id":"01919000-0000-7000-8000-000000000082","operation":"run_candidate_session","recovery_ref":"host-recovery/session-0001","session_ref":"host-session/session-0001"}"#.to_vec()
}

fn reviewer_run_request() -> Vec<u8> {
    br#"{"schema_version":1,"protocol":"buildplane-governed-session","request_id":"01919000-0000-7000-8000-000000000083","operation":"run_reviewer_session","recovery_ref":"host-recovery/session-0001","session_ref":"host-session/session-0001"}"#.to_vec()
}

fn candidate_receipt_projection() -> GovernedCandidateReceiptProjectionV1 {
    GovernedCandidateReceiptProjectionV1 {
        target_ref: "refs/heads/main".into(),
        candidate: CandidateCreatedV2 {
            run_id: "01919000-0000-7000-8000-000000000090".into(),
            candidate_id: "candidate-1".into(),
            candidate_ref:
                "refs/buildplane/candidates/01919000-0000-7000-8000-000000000090/1/candidate-1"
                    .into(),
            workflow_id: "workflow-1".into(),
            unit_id: "unit-1".into(),
            attempt: 1,
            provenance_ref:
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            candidate_digest:
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
            base_commit_sha: "1".repeat(40),
            candidate_commit_sha: "2".repeat(40),
            commit_digest:
                "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".into(),
            tree_digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                .into(),
            patch_digest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
                .into(),
            changed_files_digest:
                "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".into(),
            envelope_digest:
                "sha256:1111111111111111111111111111111111111111111111111111111111111111".into(),
            action_receipt_set_ref: "receipt-set:candidate-1".into(),
            action_receipt_set_digest:
                "sha256:2222222222222222222222222222222222222222222222222222222222222222".into(),
        },
        candidate_created_event_ref: "01919000-0000-7000-8000-000000000091".into(),
        candidate_completion_event_ref: "01919000-0000-7000-8000-000000000092".into(),
        candidate_completion_digest:
            "sha256:3333333333333333333333333333333333333333333333333333333333333333".into(),
        tape_root_digest: "sha256:4444444444444444444444444444444444444444444444444444444444444444"
            .into(),
        native_receipt_ref: "signed-event:01919000-0000-7000-8000-000000000092".into(),
        native_receipt_digest:
            "sha256:5555555555555555555555555555555555555555555555555555555555555555".into(),
        governed_packet_digest:
            "sha256:6666666666666666666666666666666666666666666666666666666666666666".into(),
    }
}

fn review_receipt_projection() -> GovernedReviewReceiptProjectionV1 {
    GovernedReviewReceiptProjectionV1 {
        candidate_created_event_ref: "01919000-0000-7000-8000-000000000091".into(),
        candidate_completion_event_ref: "01919000-0000-7000-8000-000000000092".into(),
        candidate_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            .into(),
        acceptance_event_ref: "01919000-0000-7000-8000-000000000093".into(),
        acceptance_digest:
            "sha256:7777777777777777777777777777777777777777777777777777777777777777".into(),
        reviewer_dispatch_event_ref: "01919000-0000-7000-8000-000000000094".into(),
        reviewer_dispatch_envelope_digest:
            "sha256:8888888888888888888888888888888888888888888888888888888888888888".into(),
        review_verdict_event_ref: "01919000-0000-7000-8000-000000000095".into(),
        promotion_approval_request_event_ref: Some("01919000-0000-7000-8000-000000000096".into()),
        decision: ReviewDecisionV1::Approve,
        findings: vec![ReviewFindingV1 {
            severity: ReviewFindingSeverityV1::Low,
            check_id: "review-check".into(),
            file: "src/lib.rs".into(),
            line: 7,
            explanation: "bounded finding".into(),
            evidence_refs: vec!["cas:review-evidence".into()],
        }],
        confidence: 0.9,
        reviewer_manifest_digest:
            "sha256:9999999999999999999999999999999999999999999999999999999999999999".into(),
        tape_root_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            .into(),
        native_receipt_ref: "signed-event:01919000-0000-7000-8000-000000000095".into(),
        native_receipt_digest:
            "sha256:abababababababababababababababababababababababababababababababab".into(),
    }
}

#[test]
fn signed_probe_proves_the_exact_fixed_operation_set_without_session_authority() {
    let key = SigningKey::from_bytes(&[40; 32]);
    let request = parse_governed_session_client_request(
        br#"{"schema_version":1,"protocol":"buildplane-governed-session","request_id":"01919000-0000-7000-8000-000000000080","operation":"probe"}"#,
    )
    .unwrap();
    let signed = sign_governed_session_probe_response_v1(&key, &request).unwrap();
    let verified =
        verify_governed_session_response_v1(&signed, &key.verifying_key(), &request).unwrap();
    assert_eq!(
        std::str::from_utf8(verified.projection_json()).unwrap(),
        r#"{"schema_version":1,"protocol":"buildplane-governed-session","request_id":"01919000-0000-7000-8000-000000000080","operation":"probe","status":"ready","recovery_ref":null,"session_ref":null,"result":{"operations":["open_candidate_session","open_recovery_session","run_candidate_session","open_reviewer_session","run_reviewer_session"]}}"#
    );
}

#[test]
fn signed_open_response_is_canonical_and_bound_to_the_exact_recovery_lookup() {
    let key = SigningKey::from_bytes(&[41; 32]);
    let request =
        parse_governed_session_client_request(&reviewer_request("host-recovery/session-0001"))
            .unwrap();
    let signed = sign_governed_session_response_v1(
        &key,
        &request,
        "host-recovery/session-0001",
        "host-session/session-0001",
        None,
    )
    .expect("sign response");
    let verified = verify_governed_session_response_v1(&signed, &key.verifying_key(), &request)
        .expect("verify response");
    assert_eq!(
        std::str::from_utf8(verified.projection_json()).unwrap(),
        r#"{"schema_version":1,"protocol":"buildplane-governed-session","request_id":"01919000-0000-7000-8000-000000000081","operation":"open_reviewer_session","status":"opened","recovery_ref":"host-recovery/session-0001","session_ref":"host-session/session-0001","result":null}"#
    );

    let substituted =
        parse_governed_session_client_request(&reviewer_request("host-recovery/session-0002"))
            .unwrap();
    assert!(
        verify_governed_session_response_v1(&signed, &key.verifying_key(), &substituted).is_err()
    );
}

#[test]
fn signed_completed_response_requires_a_closed_object_result_and_exact_session_binding() {
    let key = SigningKey::from_bytes(&[42; 32]);
    let request = parse_governed_session_client_request(&candidate_run_request()).unwrap();
    let result = host_owned_governed_candidate_run_result_v1(
        "host-recovery/session-0001",
        candidate_receipt_projection(),
    );
    let signed = sign_governed_session_response_v1(
        &key,
        &request,
        "host-recovery/session-0001",
        "host-session/session-0001",
        Some(result.clone()),
    )
    .unwrap();
    let verified = verify_governed_session_response_v1(&signed, &key.verifying_key(), &request)
        .expect("verify completed response");
    let projection = std::str::from_utf8(verified.projection_json()).unwrap();
    assert!(projection.contains(r#""status":"completed""#));
    assert!(projection.contains(r#""kind":"host-owned-governed-candidate-run-result-v1""#));
    assert!(projection.contains(r#""schemaVersion":2"#));
    assert!(projection.contains(r#""governedPacketDigest":"sha256:6666"#));

    let mut substituted_recovery = result;
    substituted_recovery["recoveryRef"] = serde_json::json!("host-recovery/substituted-session");
    substituted_recovery["candidateReceipt"]["recoveryRef"] =
        serde_json::json!("host-recovery/substituted-session");
    for invalid in [
        None,
        Some(serde_json::json!(["not", "an", "object"])),
        Some(governed_candidate_run_status_v1(
            BrokerCommandActionStatus::Succeeded,
        )),
        Some(substituted_recovery),
    ] {
        assert!(sign_governed_session_response_v1(
            &key,
            &request,
            "host-recovery/session-0001",
            "host-session/session-0001",
            invalid,
        )
        .is_err());
    }
}

#[test]
fn reviewer_completion_requires_a_verified_receipt_for_recorded_success() {
    let key = SigningKey::from_bytes(&[45; 32]);
    let request = parse_governed_session_client_request(&reviewer_run_request()).unwrap();
    for status in [
        BrokerModelActionStatus::Pending,
        BrokerModelActionStatus::Failed,
        BrokerModelActionStatus::LeaseExpired,
        BrokerModelActionStatus::ReconciliationRequired,
    ] {
        let signed = sign_governed_session_response_v1(
            &key,
            &request,
            "host-recovery/session-0001",
            "host-session/session-0001",
            Some(governed_reviewer_run_result_v1(status)),
        )
        .expect("sign reviewer status");
        verify_governed_session_response_v1(&signed, &key.verifying_key(), &request)
            .expect("verify reviewer status");
    }

    let completed = host_owned_governed_reviewer_run_result_v1(
        "host-recovery/session-0001",
        review_receipt_projection(),
    );
    let signed = sign_governed_session_response_v1(
        &key,
        &request,
        "host-recovery/session-0001",
        "host-session/session-0001",
        Some(completed),
    )
    .expect("sign verified reviewer receipt");
    let verified = verify_governed_session_response_v1(&signed, &key.verifying_key(), &request)
        .expect("verify reviewer receipt");
    let projection = std::str::from_utf8(verified.projection_json()).unwrap();
    assert!(projection.contains(r#""kind":"host-owned-governed-reviewer-run-result-v1""#));
    assert!(projection.contains(r#""schemaVersion":2"#));
    assert!(projection.contains(r#""decision":"approve""#));
    assert!(projection
        .contains(r#""promotionApprovalRequestEventRef":"01919000-0000-7000-8000-000000000096""#));

    for invalid in [
        serde_json::json!({"status": "recorded"}),
        serde_json::json!({
            "schemaVersion": 1,
            "kind": "governed_reviewer_run_result_v1",
            "status": "retry"
        }),
        serde_json::json!({
            "schemaVersion": 1,
            "kind": "governed_reviewer_run_result_v1",
            "status": "recorded"
        }),
    ] {
        assert!(
            sign_governed_session_response_v1(
                &key,
                &request,
                "host-recovery/session-0001",
                "host-session/session-0001",
                Some(invalid),
            )
            .is_err(),
            "reviewer status must reject open or authority-bearing result shapes"
        );
    }
}

#[test]
fn response_rejects_wrong_key_tampering_unknown_fields_and_noncanonical_bytes() {
    let key = SigningKey::from_bytes(&[43; 32]);
    let wrong_key = SigningKey::from_bytes(&[44; 32]);
    let request =
        parse_governed_session_client_request(&reviewer_request("host-recovery/session-0001"))
            .unwrap();
    let signed = sign_governed_session_response_v1(
        &key,
        &request,
        "host-recovery/session-0001",
        "host-session/session-0001",
        None,
    )
    .unwrap();
    assert!(
        verify_governed_session_response_v1(&signed, &wrong_key.verifying_key(), &request).is_err()
    );

    let mut value: serde_json::Value = serde_json::from_slice(&signed).unwrap();
    value["session_ref"] = serde_json::json!("host-session/substituted");
    assert!(verify_governed_session_response_v1(
        &serde_json::to_vec(&value).unwrap(),
        &key.verifying_key(),
        &request
    )
    .is_err());

    value = serde_json::from_slice(&signed).unwrap();
    value["authority"] = serde_json::json!("forged");
    assert!(verify_governed_session_response_v1(
        &serde_json::to_vec(&value).unwrap(),
        &key.verifying_key(),
        &request
    )
    .is_err());

    let mut noncanonical = signed.clone();
    noncanonical.push(b'\n');
    assert!(
        verify_governed_session_response_v1(&noncanonical, &key.verifying_key(), &request).is_err()
    );
}
