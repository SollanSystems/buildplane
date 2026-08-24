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
use ed25519_dalek::{Signer, SigningKey};

const RUN_UUID: &str = "01919000-0000-7000-8000-0000000000e1";
const OTHER_RUN_UUID: &str = "01919000-0000-7000-8000-0000000000e9";
const REQUEST_UUID: &str = "01919000-0000-7000-8000-0000000000f1";
const ADMISSION_UUID: &str = "01919000-0000-7000-8000-0000000000f2";
const CONTENT_REF: &str =
    "cas://sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn signing_key() -> SigningKey {
    SigningKey::from_bytes(&[71; 32])
}

fn binding() -> PlanAdmissionResponseBindingV1<'static> {
    PlanAdmissionResponseBindingV1::new(RUN_UUID, REQUEST_UUID, CONTENT_REF)
        .expect("a canonical binding")
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

    let (status, admission_event_id) =
        verify_plan_admission_response(&payload, &signing_key().verifying_key(), binding())
            .expect("the response verifies against its own binding");
    assert_eq!(status, PlanAdmissionResponseStatusV1::Sealed);
    assert_eq!(admission_event_id.as_deref(), Some(ADMISSION_UUID));

    let other_request = PlanAdmissionResponseBindingV1::new(
        RUN_UUID,
        "01919000-0000-7000-8000-0000000000f9",
        CONTENT_REF,
    )
    .unwrap();
    assert_eq!(
        verify_plan_admission_response(&payload, &signing_key().verifying_key(), other_request),
        Err(PlanAdmissionResponseErrorV1::InvalidPayload)
    );

    let other_content = PlanAdmissionResponseBindingV1::new(
        RUN_UUID,
        REQUEST_UUID,
        "cas://sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    )
    .unwrap();
    assert_eq!(
        verify_plan_admission_response(&payload, &signing_key().verifying_key(), other_content),
        Err(PlanAdmissionResponseErrorV1::InvalidPayload)
    );
}

/// H2: a sealed response signed for one run must not verify for another.
///
/// `request_id` is caller-controlled and unique only within a run, so without
/// `run_id` in the signed bytes a sealed response for run A would verify
/// identically as a response for run B that reused the same request id and
/// content reference. The run is now part of the signed binding, so it does not.
#[test]
fn a_response_signed_for_one_run_does_not_verify_for_another() {
    let payload = sign_plan_admission_response(
        &signing_key(),
        binding(),
        PlanAdmissionResponseStatusV1::Sealed,
        Some(ADMISSION_UUID),
    )
    .expect("the host signs a sealed response for RUN_UUID");

    // Same request id, same content reference, different run.
    let other_run = PlanAdmissionResponseBindingV1::new(OTHER_RUN_UUID, REQUEST_UUID, CONTENT_REF)
        .expect("a canonical binding for a different run");
    assert_eq!(
        verify_plan_admission_response(&payload, &signing_key().verifying_key(), other_run),
        Err(PlanAdmissionResponseErrorV1::InvalidPayload),
        "a response for RUN_UUID must not authorize OTHER_RUN_UUID"
    );

    // The positive control: the same bytes still verify for their own run.
    assert_eq!(
        verify_plan_admission_response(&payload, &signing_key().verifying_key(), binding())
            .expect("the response verifies for its own run")
            .0,
        PlanAdmissionResponseStatusV1::Sealed
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
    assert_eq!(
        status,
        PlanAdmissionResponseStatusV1::ReconciliationRequired
    );
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
fn a_binding_is_only_a_canonical_run_request_and_content_reference() {
    for (run_id, request_id, content_ref) in [
        (
            "01919000-0000-7000-8000-0000000000E1",
            REQUEST_UUID,
            CONTENT_REF,
        ),
        ("not-a-uuid", REQUEST_UUID, CONTENT_REF),
        (
            RUN_UUID,
            "01919000-0000-7000-8000-0000000000F1",
            CONTENT_REF,
        ),
        (RUN_UUID, "not-a-uuid", CONTENT_REF),
        (RUN_UUID, REQUEST_UUID, "cas:sha256:aa"),
        (RUN_UUID, REQUEST_UUID, "cas://sha256:not-hex"),
        (
            RUN_UUID,
            REQUEST_UUID,
            "cas://sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ),
        (
            RUN_UUID,
            REQUEST_UUID,
            r#"cas://sha256:aa","status":"sealed"#,
        ),
    ] {
        assert_eq!(
            PlanAdmissionResponseBindingV1::new(run_id, request_id, content_ref).err(),
            Some(PlanAdmissionResponseErrorV1::InvalidBinding),
            "{run_id} / {request_id} / {content_ref} must not become a response binding"
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
    let swapped = String::from_utf8(payload.clone()).unwrap().replace(
        r#""status":"sealed""#,
        r#""status":"reconciliation_required""#,
    );
    assert!(verify_plan_admission_response(
        swapped.as_bytes(),
        &signing_key().verifying_key(),
        binding()
    )
    .is_err());

    // Trailing bytes are not a valid canonical payload even when the prefix is.
    let mut trailing = payload.clone();
    trailing.push(b' ');
    assert!(
        verify_plan_admission_response(&trailing, &signing_key().verifying_key(), binding())
            .is_err()
    );
}

/// Domain separation, tested by consequence rather than by restating it.
///
/// A signature over the *same bytes* by the *same key*, lacking only the domain
/// prefix, must not verify. That is what stops a signature this key produced
/// for some other buildplane protocol from being replayed into a
/// plan-admission response — and, unlike asserting that the prefix function
/// prepends its own constant, it can actually fail.
#[test]
fn a_signature_over_the_undomained_payload_does_not_verify() {
    let payload = sign_plan_admission_response(
        &signing_key(),
        binding(),
        PlanAdmissionResponseStatusV1::Sealed,
        Some(ADMISSION_UUID),
    )
    .unwrap();
    let signed = String::from_utf8(payload).unwrap();

    // Recover the exact bytes that were signed, minus the domain prefix.
    let split = signed
        .find(r#","signature":""#)
        .expect("a signed response always carries its signature member");
    let undomained_message = format!("{}}}", &signed[..split]);

    let forged = signing_key().sign(undomained_message.as_bytes());
    let forged_payload = format!(
        r#"{},"signature":"{}"}}"#,
        &signed[..split],
        encode_hex(&forged.to_bytes())
    );

    // Sanity: the forgery is byte-identical to the real thing except for the
    // signature, so a failure below is about the domain and nothing else.
    assert_eq!(&forged_payload[..split], &signed[..split]);
    assert_ne!(forged_payload, signed);

    assert_eq!(
        verify_plan_admission_response(
            forged_payload.as_bytes(),
            &signing_key().verifying_key(),
            binding()
        ),
        Err(PlanAdmissionResponseErrorV1::InvalidSignature),
        "a signature over the undomained message must not verify"
    );
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
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
