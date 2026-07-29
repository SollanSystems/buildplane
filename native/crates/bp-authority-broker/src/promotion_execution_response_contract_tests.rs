use crate::promotion_execution_response::{
    sign_promotion_execution_response_for_test, verify_promotion_execution_response_for_test,
    PromotionExecutionResponseBindingV1, PromotionExecutionResponseStatusV1,
};
use ed25519_dalek::SigningKey;

const REQUEST_ID: &str = "018f2e40-0000-7000-8000-000000000121";
const OTHER_REQUEST_ID: &str = "018f2e40-0000-7000-8000-000000000122";
const DECISION_EVENT_ID: &str = "123e4567-e89b-12d3-a456-426614174011";
const OTHER_DECISION_EVENT_ID: &str = "123e4567-e89b-12d3-a456-426614174012";

fn binding(
    request_id: &'static str,
    decision_event_id: &'static str,
) -> PromotionExecutionResponseBindingV1<'static> {
    PromotionExecutionResponseBindingV1::new(request_id, decision_event_id).unwrap()
}

#[test]
fn signed_response_binds_nonce_decision_event_status_protocol_domain_and_key() {
    let signer = SigningKey::from_bytes(&[101; 32]);
    let expected = binding(REQUEST_ID, DECISION_EVENT_ID);
    let payload = sign_promotion_execution_response_for_test(
        &signer,
        expected,
        PromotionExecutionResponseStatusV1::Recorded,
    )
    .expect("protected execution host signs its closed response");

    assert_eq!(
        verify_promotion_execution_response_for_test(&payload, &signer.verifying_key(), expected,)
            .expect("the exact signed response verifies"),
        PromotionExecutionResponseStatusV1::Recorded
    );

    for substituted in [
        binding(OTHER_REQUEST_ID, DECISION_EVENT_ID),
        binding(REQUEST_ID, OTHER_DECISION_EVENT_ID),
    ] {
        assert!(
            verify_promotion_execution_response_for_test(
                &payload,
                &signer.verifying_key(),
                substituted,
            )
            .is_err(),
            "an execution response must not be reusable for substituted request bindings"
        );
    }

    let wrong_key = SigningKey::from_bytes(&[102; 32]);
    assert!(verify_promotion_execution_response_for_test(
        &payload,
        &wrong_key.verifying_key(),
        expected,
    )
    .is_err());
}

#[test]
fn response_accepts_only_the_closed_status_set_and_rejects_tampering_or_extension() {
    let signer = SigningKey::from_bytes(&[103; 32]);
    let expected = binding(REQUEST_ID, DECISION_EVENT_ID);

    for status in [
        PromotionExecutionResponseStatusV1::Rejected,
        PromotionExecutionResponseStatusV1::Pending,
        PromotionExecutionResponseStatusV1::Completed,
        PromotionExecutionResponseStatusV1::Recorded,
        PromotionExecutionResponseStatusV1::LeaseExpired,
        PromotionExecutionResponseStatusV1::ReconciliationRequired,
    ] {
        let payload =
            sign_promotion_execution_response_for_test(&signer, expected, status).unwrap();
        assert_eq!(
            verify_promotion_execution_response_for_test(
                &payload,
                &signer.verifying_key(),
                expected,
            )
            .unwrap(),
            status
        );
    }

    let recorded = sign_promotion_execution_response_for_test(
        &signer,
        expected,
        PromotionExecutionResponseStatusV1::Recorded,
    )
    .unwrap();
    let replace = |from: &str, to: &str| {
        String::from_utf8(recorded.clone())
            .unwrap()
            .replace(from, to)
            .into_bytes()
    };
    let mut wrong_signature = recorded.clone();
    let signature_offset = String::from_utf8(wrong_signature.clone())
        .unwrap()
        .find(r#""signature":""#)
        .unwrap()
        + r#""signature":""#.len();
    wrong_signature[signature_offset] = if wrong_signature[signature_offset] == b'0' {
        b'1'
    } else {
        b'0'
    };

    for rejected in [
        wrong_signature,
        replace(r#""status":"recorded""#, r#""status":"approved""#),
        replace(
            r#""protocol":"buildplane-promotion-execution""#,
            r#""protocol":"other-protocol""#,
        ),
        replace(
            r#""domain":"protected-authority-response""#,
            r#""domain":"other-domain""#,
        ),
        replace(r#""schema_version":1"#, r#""schema_version":2"#),
        br#"{"schema_version":1,"status":"recorded"}"#.to_vec(),
        [
            recorded.as_slice().strip_suffix(b"}").unwrap(),
            br#","unexpected":true}"#,
        ]
        .concat(),
    ] {
        assert!(verify_promotion_execution_response_for_test(
            &rejected,
            &signer.verifying_key(),
            expected,
        )
        .is_err());
    }
}
