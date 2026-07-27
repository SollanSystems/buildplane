use crate::command_action::BrokerCommandActionStatus;
use crate::governed_session_client::parse_governed_session_client_request;
use crate::governed_session_response::{
    governed_candidate_run_result_v1, governed_reviewer_run_result_v1,
    sign_governed_session_probe_response_v1, sign_governed_session_response_v1,
    verify_governed_session_response_v1,
};
use crate::BrokerModelActionStatus;
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
    let result = governed_candidate_run_result_v1(BrokerCommandActionStatus::Succeeded);
    let signed = sign_governed_session_response_v1(
        &key,
        &request,
        "host-recovery/session-0001",
        "host-session/session-0001",
        Some(result),
    )
    .unwrap();
    let verified = verify_governed_session_response_v1(&signed, &key.verifying_key(), &request)
        .expect("verify completed response");
    assert!(std::str::from_utf8(verified.projection_json())
        .unwrap()
        .contains(r#""status":"completed""#));

    for invalid in [None, Some(serde_json::json!(["not", "an", "object"]))] {
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
fn reviewer_completion_exposes_only_the_closed_broker_status_contract() {
    let key = SigningKey::from_bytes(&[45; 32]);
    let request = parse_governed_session_client_request(&reviewer_run_request()).unwrap();
    for status in [
        BrokerModelActionStatus::Pending,
        BrokerModelActionStatus::Recorded,
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
            "status": "recorded",
            "authorizationRef": "forged"
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
