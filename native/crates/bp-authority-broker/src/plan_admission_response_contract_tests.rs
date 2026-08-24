//! Contract coverage for the signed plan-admission response.
//!
//! The response is the only thing a peer ever learns about a mint attempt, so
//! the tests here pin two properties in tension: it must be verifiable against
//! the exact request it answers, and it must disclose nothing about *why* an
//! attempt did not seal.

use crate::plan_admission_response::{
    sign_plan_admission_response, verify_plan_admission_response, PlanAdmissionResponseBindingV1,
    PlanAdmissionResponseErrorV1, PlanAdmissionResponseStatusV1,
};
use ed25519_dalek::SigningKey;

const REQUEST_UUID: &str = "01919000-0000-7000-8000-0000000000f1";
const ADMISSION_UUID: &str = "01919000-0000-7000-8000-0000000000f2";
const CONTENT_REF: &str =
    "cas://sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn signing_key() -> SigningKey {
    SigningKey::from_bytes(&[71; 32])
}

fn binding() -> PlanAdmissionResponseBindingV1<'static> {
    PlanAdmissionResponseBindingV1::new(REQUEST_UUID, CONTENT_REF).expect("a canonical binding")
}

#[test]
fn a_sealed_response_verifies_only_against_its_own_request_binding() {
    let payload = sign_plan_admission_response(
        &signing_key(),
        binding(),
        PlanAdmissionResponseStatusV1::Sealed,
        Some(ADMISSION_UUID),
    )
    .expect("the host signs a sealed response");

    let (status, admission_event_id) = verify_plan_admission_response(
        &payload,
        &signing_key().verifying_key(),
        binding(),
    )
    .expect("the response verifies against its own binding");
    assert_eq!(status, PlanAdmissionResponseStatusV1::Sealed);
    assert_eq!(admission_event_id.as_deref(), Some(ADMISSION_UUID));

    let other_request = PlanAdmissionResponseBindingV1::new(
        "01919000-0000-7000-8000-0000000000f9",
        CONTENT_REF,
    )
    .unwrap();
    assert_eq!(
        verify_plan_admission_response(&payload, &signing_key().verifying_key(), other_request),
        Err(PlanAdmissionResponseErrorV1::InvalidPayload)
    );

    let other_content = PlanAdmissionResponseBindingV1::new(
        REQUEST_UUID,
        "cas://sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    )
    .unwrap();
    assert_eq!(
        verify_plan_admission_response(&payload, &signing_key().verifying_key(), other_content),
        Err(PlanAdmissionResponseErrorV1::InvalidPayload)
    );
}

#[test]
fn a_reconciliation_response_carries_no_admission_identity_and_no_reason() {
    let payload = sign_plan_admission_response(
        &signing_key(),
        binding(),
        PlanAdmissionResponseStatusV1::ReconciliationRequired,
        None,
    )
    .expect("the host signs a reconciliation response");

    let (status, admission_event_id) =
        verify_plan_admission_response(&payload, &signing_key().verifying_key(), binding())
            .expect("the response verifies");
    assert_eq!(status, PlanAdmissionResponseStatusV1::ReconciliationRequired);
    assert_eq!(admission_event_id, None);

    let rendered = String::from_utf8(payload).expect("the payload is text");
    for leak in [
        "digest",
        "trusted_base",
        "decided_by",
        "plan_id",
        "checkpoint",
        "signer",
        "seal",
        "peer",
        "uid",
    ] {
        assert!(
            !rendered.contains(leak),
            "the response must not disclose {leak}: {rendered}"
        );
    }
}

#[test]
fn the_outcome_and_its_identity_cannot_be_paired_incorrectly() {
    assert_eq!(
        sign_plan_admission_response(
            &signing_key(),
            binding(),
            PlanAdmissionResponseStatusV1::Sealed,
            None,
        ),
        Err(PlanAdmissionResponseErrorV1::InvalidBinding)
    );
    assert_eq!(
        sign_plan_admission_response(
            &signing_key(),
            binding(),
            PlanAdmissionResponseStatusV1::ReconciliationRequired,
            Some(ADMISSION_UUID),
        ),
        Err(PlanAdmissionResponseErrorV1::InvalidBinding)
    );
    assert_eq!(
        sign_plan_admission_response(
            &signing_key(),
            binding(),
            PlanAdmissionResponseStatusV1::Sealed,
            Some("not-a-uuid"),
        ),
        Err(PlanAdmissionResponseErrorV1::InvalidBinding)
    );
}

#[test]
fn a_binding_is_only_a_canonical_request_and_content_reference() {
    for (request_id, content_ref) in [
        ("01919000-0000-7000-8000-0000000000F1", CONTENT_REF),
        ("not-a-uuid", CONTENT_REF),
        (REQUEST_UUID, "cas:sha256:aa"),
        (REQUEST_UUID, "cas://sha256:not-hex"),
        (
            REQUEST_UUID,
            "cas://sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ),
        (REQUEST_UUID, r#"cas://sha256:aa","status":"sealed"#),
    ] {
        assert_eq!(
            PlanAdmissionResponseBindingV1::new(request_id, content_ref).err(),
            Some(PlanAdmissionResponseErrorV1::InvalidBinding),
            "{request_id} / {content_ref} must not become a response binding"
        );
    }
}

#[test]
fn another_key_another_domain_and_any_tamper_all_fail_closed() {
    let payload = sign_plan_admission_response(
        &signing_key(),
        binding(),
        PlanAdmissionResponseStatusV1::Sealed,
        Some(ADMISSION_UUID),
    )
    .unwrap();

    let stranger = SigningKey::from_bytes(&[72; 32]).verifying_key();
    assert_eq!(
        verify_plan_admission_response(&payload, &stranger, binding()),
        Err(PlanAdmissionResponseErrorV1::InvalidSignature)
    );

    // A status swap keeps the signature bytes but changes the signed message.
    let swapped = String::from_utf8(payload.clone())
        .unwrap()
        .replace(r#""status":"sealed""#, r#""status":"reconciliation_required""#);
    assert!(verify_plan_admission_response(
        swapped.as_bytes(),
        &signing_key().verifying_key(),
        binding()
    )
    .is_err());

    // Trailing bytes are not a valid canonical payload even when the prefix is.
    let mut trailing = payload.clone();
    trailing.push(b' ');
    assert!(verify_plan_admission_response(
        &trailing,
        &signing_key().verifying_key(),
        binding()
    )
    .is_err());

    // The signature is over a domain-separated message, so a response signed
    // for another protocol can never be replayed into this one.
    let foreign = crate::plan_admission_response::signature_message_for_test(b"{}");
    assert!(foreign.starts_with(b"buildplane.protected-plan-admission.response.v1\0"));
}

#[test]
fn an_unknown_response_field_is_rejected_rather_than_ignored() {
    let payload = sign_plan_admission_response(
        &signing_key(),
        binding(),
        PlanAdmissionResponseStatusV1::Sealed,
        Some(ADMISSION_UUID),
    )
    .unwrap();
    let widened = String::from_utf8(payload)
        .unwrap()
        .replace(r#""status":"sealed""#, r#""status":"sealed","extra":true"#);
    assert_eq!(
        verify_plan_admission_response(
            widened.as_bytes(),
            &signing_key().verifying_key(),
            binding()
        ),
        Err(PlanAdmissionResponseErrorV1::InvalidPayload)
    );
}
