use crate::promotion_decision_response::{
    sign_promotion_decision_response_for_test, verify_promotion_decision_response_for_test,
    PromotionDecisionResponseBindingV1, PromotionDecisionResponseStatusV1,
};
use ed25519_dalek::SigningKey;

const REQUEST_ID: &str = "018f2e40-0000-7000-8000-000000000111";
const OTHER_REQUEST_ID: &str = "018f2e40-0000-7000-8000-000000000112";
const APPROVAL_EVENT_ID: &str = "123e4567-e89b-12d3-a456-426614174001";
const OTHER_APPROVAL_EVENT_ID: &str = "123e4567-e89b-12d3-a456-426614174002";
const DECISION_EVENT_ID: &str = "123e4567-e89b-12d3-a456-426614174003";

fn binding(
    request_id: &'static str,
    event_id: &'static str,
    decision: &'static str,
) -> PromotionDecisionResponseBindingV1<'static> {
    PromotionDecisionResponseBindingV1::new(request_id, event_id, decision).unwrap()
}

#[test]
fn signed_response_binds_nonce_event_decision_status_protocol_domain_and_key() {
    let signer = SigningKey::from_bytes(&[91; 32]);
    let expected = binding(REQUEST_ID, APPROVAL_EVENT_ID, "promote");
    let payload = sign_promotion_decision_response_for_test(
        &signer,
        expected,
        PromotionDecisionResponseStatusV1::Sealed,
        Some(DECISION_EVENT_ID),
    )
    .expect("protected host signs its closed response");

    assert_eq!(
        verify_promotion_decision_response_for_test(&payload, &signer.verifying_key(), expected,)
            .expect("the exact signed response verifies"),
        (
            PromotionDecisionResponseStatusV1::Sealed,
            Some(DECISION_EVENT_ID.to_string())
        )
    );

    for substituted in [
        binding(OTHER_REQUEST_ID, APPROVAL_EVENT_ID, "promote"),
        binding(REQUEST_ID, OTHER_APPROVAL_EVENT_ID, "promote"),
        binding(REQUEST_ID, APPROVAL_EVENT_ID, "reject"),
    ] {
        assert!(
            verify_promotion_decision_response_for_test(
                &payload,
                &signer.verifying_key(),
                substituted,
            )
            .is_err(),
            "a response must not be reusable for substituted request bindings"
        );
    }

    let wrong_key = SigningKey::from_bytes(&[92; 32]);
    assert!(verify_promotion_decision_response_for_test(
        &payload,
        &wrong_key.verifying_key(),
        expected,
    )
    .is_err());
}

#[test]
fn response_rejects_replay_wrong_status_signature_and_unsigned_or_extended_shapes() {
    let signer = SigningKey::from_bytes(&[93; 32]);
    let expected = binding(REQUEST_ID, APPROVAL_EVENT_ID, "reject");
    let sealed = sign_promotion_decision_response_for_test(
        &signer,
        expected,
        PromotionDecisionResponseStatusV1::Sealed,
        Some(DECISION_EVENT_ID),
    )
    .unwrap();
    let reconciliation = sign_promotion_decision_response_for_test(
        &signer,
        expected,
        PromotionDecisionResponseStatusV1::ReconciliationRequired,
        None,
    )
    .unwrap();

    assert_eq!(
        verify_promotion_decision_response_for_test(
            &reconciliation,
            &signer.verifying_key(),
            expected,
        )
        .unwrap(),
        (
            PromotionDecisionResponseStatusV1::ReconciliationRequired,
            None
        )
    );

    let mut wrong_signature = sealed.clone();
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
    let replace = |from: &str, to: &str| {
        String::from_utf8(sealed.clone())
            .unwrap()
            .replace(from, to)
            .into_bytes()
    };
    for rejected in [
        wrong_signature,
        replace(
            r#""status":"sealed""#,
            r#""status":"reconciliation_required""#,
        ),
        replace(
            r#""protocol":"buildplane-promotion-decision""#,
            r#""protocol":"other-protocol""#,
        ),
        replace(
            r#""domain":"protected-authority-response""#,
            r#""domain":"other-domain""#,
        ),
        replace(r#""schema_version":2"#, r#""schema_version":1"#),
        br#"{"schema_version":1,"status":"sealed"}"#.to_vec(),
        [
            sealed.as_slice().strip_suffix(b"}").unwrap(),
            br#","unexpected":true}"#,
        ]
        .concat(),
    ] {
        assert!(verify_promotion_decision_response_for_test(
            &rejected,
            &signer.verifying_key(),
            expected,
        )
        .is_err());
    }
}
