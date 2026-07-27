use crate::governed_session_client::{
    exchange_governed_session_with_stream_for_test,
    exchange_governed_session_with_stream_with_timeout_for_test,
    parse_governed_session_client_request, parse_protected_governed_session_client_config_json,
    CandidateApprovalV1, GovernedSessionClientOperationV1, ParsedGovernedSessionClientRequestV1,
};
use crate::governed_session_response::sign_governed_session_response_v1;
use ed25519_dalek::SigningKey;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

fn request(operation: &str, fields: &str) -> Vec<u8> {
    format!(
        r#"{{"schema_version":1,"protocol":"buildplane-governed-session","request_id":"01919000-0000-7000-8000-000000000081","operation":"{operation}",{fields}}}"#
    )
    .into_bytes()
}

fn reviewer_request(recovery_ref: &str) -> Vec<u8> {
    request(
        "open_reviewer_session",
        &format!(
            r#""project_root":"/srv/buildplane/repositories/example","recovery_ref":"{recovery_ref}""#
        ),
    )
}

#[test]
fn parses_closed_candidate_recovery_and_reviewer_session_requests() {
    let candidate = parse_governed_session_client_request(&request(
        "open_candidate_session",
        r#""packet_source":"{\"schema_version\":1}","project_root":"/srv/buildplane/repositories/example","approval":{"kind":"operator_requested"}"#,
    ))
    .expect("candidate request");
    assert_eq!(
        candidate.operation(),
        GovernedSessionClientOperationV1::OpenCandidateSession
    );
    match candidate {
        ParsedGovernedSessionClientRequestV1::OpenCandidateSession { approval, .. } => {
            assert_eq!(approval, CandidateApprovalV1::OperatorRequested);
        }
        _ => panic!("candidate operation must select candidate body"),
    }

    let recovery = parse_governed_session_client_request(&request(
        "open_recovery_session",
        r#""project_root":"/srv/buildplane/repositories/example","recovery_ref":"host-recovery/session-0001","approval":{"kind":"operator_requested"}"#,
    ))
    .expect("recovery request");
    assert_eq!(
        recovery.operation(),
        GovernedSessionClientOperationV1::OpenRecoverySession
    );

    let reviewer = parse_governed_session_client_request(&request(
        "open_reviewer_session",
        r#""project_root":"/srv/buildplane/repositories/example","recovery_ref":"host-recovery/session-0001""#,
    ))
    .expect("reviewer request");
    assert_eq!(
        reviewer.operation(),
        GovernedSessionClientOperationV1::OpenReviewerSession
    );
    assert_eq!(reviewer.recovery_ref(), Some("host-recovery/session-0001"));

    let candidate_run = parse_governed_session_client_request(&request(
        "run_candidate_session",
        r#""recovery_ref":"host-recovery/session-0001","session_ref":"host-session/session-0001""#,
    ))
    .expect("opaque candidate run request");
    assert_eq!(
        candidate_run.operation(),
        GovernedSessionClientOperationV1::RunCandidateSession
    );
    assert_eq!(
        candidate_run.recovery_ref(),
        Some("host-recovery/session-0001")
    );
    assert_eq!(
        candidate_run.session_ref(),
        Some("host-session/session-0001")
    );
    assert!(
        parse_governed_session_client_request(&request(
            "run_candidate_session",
            r#""packet_source":"{}","recovery_ref":"host-recovery/session-0001","session_ref":"host-session/session-0001""#,
        ))
        .is_err(),
        "a resumed candidate run must not accept caller replacement packet bytes"
    );
}

#[test]
fn probe_is_an_exact_capability_check_with_no_authority_inputs() {
    let probe = br#"{"schema_version":1,"protocol":"buildplane-governed-session","request_id":"01919000-0000-7000-8000-000000000080","operation":"probe"}"#;
    let parsed = parse_governed_session_client_request(probe).expect("closed protected-host probe");
    assert_eq!(parsed.operation(), GovernedSessionClientOperationV1::Probe);

    let with_override = br#"{"schema_version":1,"protocol":"buildplane-governed-session","request_id":"01919000-0000-7000-8000-000000000080","operation":"probe","socket":"/tmp/attacker.sock"}"#;
    assert!(parse_governed_session_client_request(with_override).is_err());
}

#[test]
fn reviewer_wire_cannot_select_candidate_dispatch_action_or_worker_authority() {
    for injected in [
        r#""project_root":"/srv/buildplane/repositories/example","recovery_ref":"host-recovery/session-0001","run_id":"01919000-0000-7000-8000-000000000082""#,
        r#""project_root":"/srv/buildplane/repositories/example","recovery_ref":"host-recovery/session-0001","reviewer_dispatch_event_ref":"01919000-0000-7000-8000-000000000083""#,
        r#""project_root":"/srv/buildplane/repositories/example","recovery_ref":"host-recovery/session-0001","reviewer_action_request_event_ref":"01919000-0000-7000-8000-000000000084""#,
        r#""project_root":"/srv/buildplane/repositories/example","recovery_ref":"host-recovery/session-0001","candidate_digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa""#,
        r#""project_root":"/srv/buildplane/repositories/example","recovery_ref":"host-recovery/session-0001","model":"attacker-selected""#,
    ] {
        assert!(
            parse_governed_session_client_request(&request("open_reviewer_session", injected))
                .is_err(),
            "{injected} must be rejected"
        );
    }
}

#[test]
fn rejects_operation_body_mismatch_unsafe_paths_references_and_source_sizes() {
    let cases = [
        request(
            "run_candidate_session",
            r#""project_root":"/srv/buildplane/repositories/example","recovery_ref":"host-recovery/session-0001""#,
        ),
        request(
            "open_reviewer_session",
            r#""project_root":"/srv/buildplane/../secrets","recovery_ref":"host-recovery/session-0001""#,
        ),
        request(
            "open_reviewer_session",
            r#""project_root":"relative/repository","recovery_ref":"host-recovery/session-0001""#,
        ),
        request(
            "open_reviewer_session",
            r#""project_root":"/srv/buildplane/repositories/example","recovery_ref":"host-recovery/../other""#,
        ),
        request(
            "open_reviewer_session",
            r#""project_root":"/srv/buildplane/repositories/example","recovery_ref":"host-recovery//other""#,
        ),
    ];
    for wire in cases {
        assert!(parse_governed_session_client_request(&wire).is_err());
    }

    let oversized = "x".repeat(512 * 1024 + 1);
    let wire = serde_json::json!({
        "schema_version": 1,
        "protocol": "buildplane-governed-session",
        "request_id": "01919000-0000-7000-8000-000000000081",
        "operation": "open_candidate_session",
        "packet_source": oversized,
        "project_root": "/srv/buildplane/repositories/example",
        "approval": {"kind": "operator_requested"}
    });
    assert!(parse_governed_session_client_request(&serde_json::to_vec(&wire).unwrap()).is_err());
}

#[test]
fn parses_both_preauthorization_forms_without_deriving_session_identity() {
    let by_ref = parse_governed_session_client_request(&request(
        "open_candidate_session",
        r#""packet_source":"{}","project_root":"/srv/buildplane/repositories/example","approval":{"kind":"preauthorization_ref","preauthorization_ref":"preauth/approved-0001"}"#,
    ))
    .expect("preauthorization reference");
    assert!(matches!(
        by_ref,
        ParsedGovernedSessionClientRequestV1::OpenCandidateSession {
            approval: CandidateApprovalV1::PreauthorizationRef(_),
            ..
        }
    ));

    let by_source = parse_governed_session_client_request(&request(
        "open_candidate_session",
        r#""packet_source":"{}","project_root":"/srv/buildplane/repositories/example","approval":{"kind":"preauthorized_envelope_source","preauthorized_envelope_source":"{\"signed\":\"carrier\"}"}"#,
    ))
    .expect("preauthorized envelope source");
    assert!(matches!(
        by_source,
        ParsedGovernedSessionClientRequestV1::OpenCandidateSession {
            approval: CandidateApprovalV1::PreauthorizedEnvelopeSource(_),
            ..
        }
    ));
}

#[test]
fn protected_client_config_is_closed_and_pins_root_listener_and_response_key() {
    let key = SigningKey::from_bytes(&[45; 32]);
    let config = serde_json::json!({
        "schema_version": 1,
        "listener_creator_uid": 0,
        "socket_group_gid": 4200,
        "broker_identity_public_key": key.verifying_key().to_bytes()
    });
    let parsed =
        parse_protected_governed_session_client_config_json(&serde_json::to_vec(&config).unwrap())
            .expect("protected config");
    assert_eq!(parsed.listener_creator_uid(), 0);
    assert_eq!(parsed.socket_group_gid(), 4200);
    assert_eq!(parsed.broker_identity_public_key(), &key.verifying_key());

    let mut non_root = config.clone();
    non_root["listener_creator_uid"] = serde_json::json!(1);
    let mut endpoint_override = config.clone();
    endpoint_override["endpoint"] = serde_json::json!("/tmp/attacker.sock");
    let mut invalid_key = config.clone();
    invalid_key["broker_identity_public_key"] = serde_json::json!([1, 2, 3]);
    for mutation in [non_root, endpoint_override, invalid_key] {
        assert!(parse_protected_governed_session_client_config_json(
            &serde_json::to_vec(&mutation).unwrap()
        )
        .is_err());
    }
}

#[test]
fn authenticated_exchange_frames_exact_request_and_verifies_signed_response() {
    let key = SigningKey::from_bytes(&[46; 32]);
    let request_bytes = reviewer_request("host-recovery/session-0001");
    let request = parse_governed_session_client_request(&request_bytes).unwrap();
    let (mut client, mut server) = UnixStream::pair().unwrap();
    let expected_request = request_bytes.clone();
    let signing_key = key.clone();
    let server_thread = std::thread::spawn(move || {
        let mut encoded_length = [0_u8; 4];
        server.read_exact(&mut encoded_length).unwrap();
        let mut received = vec![0_u8; u32::from_be_bytes(encoded_length) as usize];
        server.read_exact(&mut received).unwrap();
        assert_eq!(received, expected_request);
        let parsed = parse_governed_session_client_request(&received).unwrap();
        let response = sign_governed_session_response_v1(
            &signing_key,
            &parsed,
            "host-recovery/session-0001",
            "host-session/session-0001",
            None,
        )
        .unwrap();
        server
            .write_all(&(response.len() as u32).to_be_bytes())
            .unwrap();
        server.write_all(&response).unwrap();
    });

    let projection = exchange_governed_session_with_stream_for_test(
        &mut client,
        unsafe { libc::geteuid() },
        &key.verifying_key(),
        &request,
        &request_bytes,
    )
    .expect("authenticated exchange");
    server_thread.join().unwrap();
    assert!(std::str::from_utf8(&projection)
        .unwrap()
        .contains(r#""status":"opened""#));
}

#[test]
fn authenticated_exchange_uses_one_absolute_deadline_for_slow_drip_responses() {
    let key = SigningKey::from_bytes(&[47; 32]);
    let request_bytes = reviewer_request("host-recovery/session-0002");
    let request = parse_governed_session_client_request(&request_bytes).unwrap();
    let (mut client, mut server) = UnixStream::pair().unwrap();
    let server_thread = std::thread::spawn(move || {
        let mut encoded_length = [0_u8; 4];
        server.read_exact(&mut encoded_length).unwrap();
        let mut received = vec![0_u8; u32::from_be_bytes(encoded_length) as usize];
        server.read_exact(&mut received).unwrap();
        for byte in [0_u8, 0, 0, 8] {
            if server.write_all(&[byte]).is_err() {
                return;
            }
            std::thread::sleep(Duration::from_millis(60));
        }
    });

    let started = Instant::now();
    let result = exchange_governed_session_with_stream_with_timeout_for_test(
        &mut client,
        unsafe { libc::geteuid() },
        &key.verifying_key(),
        &request,
        &request_bytes,
        Duration::from_millis(150),
    );
    assert!(result.is_err());
    assert!(started.elapsed() < Duration::from_millis(350));
    server_thread.join().unwrap();
}
