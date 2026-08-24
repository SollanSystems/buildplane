//! Domain-separated authentication for protected plan-admission responses.
//!
//! The host is the only production caller that can sign, and it can sign only
//! this closed response shape. A client verifies the signature and every
//! request binding before interpreting the status.
//!
//! The binding deliberately names the request and the content reference the
//! caller asked about — never the derived `decided_by`, `trusted_base`,
//! `plan_id`, or `input_digest`. Those are facts the mint derived; echoing them
//! back over the wire would invite a caller to treat a response as a place to
//! read authority state out of.

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::Deserialize;
use thiserror::Error;
use uuid::Uuid;

const RESPONSE_SCHEMA_VERSION: u8 = 1;
const RESPONSE_PROTOCOL: &str = "buildplane-plan-admission";
const RESPONSE_DOMAIN: &str = "protected-authority-response";
const SIGNATURE_DOMAIN: &[u8] = b"buildplane.protected-plan-admission.response.v1\0";

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum PlanAdmissionResponseErrorV1 {
    #[error("plan admission response binding was rejected")]
    InvalidBinding,
    #[allow(dead_code)] // Produced only by the verification half.
    #[error("plan admission response payload was rejected")]
    InvalidPayload,
    #[allow(dead_code)] // Produced only by the verification half.
    #[error("plan admission response signature was rejected")]
    InvalidSignature,
}

/// The whole outward vocabulary. Sealed recovery evidence or reconciliation —
/// never a refusal reason, and never effect authority.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PlanAdmissionResponseStatusV1 {
    Sealed,
    ReconciliationRequired,
}

impl PlanAdmissionResponseStatusV1 {
    fn as_str(self) -> &'static str {
        match self {
            Self::Sealed => "sealed",
            Self::ReconciliationRequired => "reconciliation_required",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PlanAdmissionResponseBindingV1<'a> {
    request_id: &'a str,
    plan_content_ref: &'a str,
}

impl<'a> PlanAdmissionResponseBindingV1<'a> {
    pub(crate) fn new(
        request_id: &'a str,
        plan_content_ref: &'a str,
    ) -> Result<Self, PlanAdmissionResponseErrorV1> {
        if !is_canonical_uuid(request_id) || !is_canonical_plan_content_ref(plan_content_ref) {
            return Err(PlanAdmissionResponseErrorV1::InvalidBinding);
        }
        Ok(Self {
            request_id,
            plan_content_ref,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)] // Read only by the verification half, above.
struct SignedPlanAdmissionResponseWireV1 {
    schema_version: u8,
    protocol: String,
    domain: String,
    request_id: String,
    plan_content_ref: String,
    admission_event_id: Option<String>,
    status: String,
    signature: String,
}

pub(crate) fn sign_plan_admission_response(
    signing_key: &SigningKey,
    binding: PlanAdmissionResponseBindingV1<'_>,
    status: PlanAdmissionResponseStatusV1,
    admission_event_id: Option<&str>,
) -> Result<Vec<u8>, PlanAdmissionResponseErrorV1> {
    validate_outcome_binding(status, admission_event_id)?;
    let unsigned = canonical_unsigned_payload(binding, status, admission_event_id);
    let signature = signing_key.sign(&signature_message(&unsigned));
    Ok(canonical_signed_payload(
        binding,
        status,
        admission_event_id,
        &encode_hex(&signature.to_bytes()),
    ))
}

/// No production caller until a plan-admission client lands: the host signs,
/// and only the contract tests read back. It ships now so a later client cannot
/// invent a second, looser reading of the same bytes.
#[allow(dead_code)]
pub(crate) fn verify_plan_admission_response(
    payload: &[u8],
    verifying_key: &VerifyingKey,
    expected: PlanAdmissionResponseBindingV1<'_>,
) -> Result<(PlanAdmissionResponseStatusV1, Option<String>), PlanAdmissionResponseErrorV1> {
    let wire: SignedPlanAdmissionResponseWireV1 = serde_json::from_slice(payload)
        .map_err(|_| PlanAdmissionResponseErrorV1::InvalidPayload)?;
    if wire.schema_version != RESPONSE_SCHEMA_VERSION
        || wire.protocol != RESPONSE_PROTOCOL
        || wire.domain != RESPONSE_DOMAIN
        || wire.request_id != expected.request_id
        || wire.plan_content_ref != expected.plan_content_ref
    {
        return Err(PlanAdmissionResponseErrorV1::InvalidPayload);
    }
    let status = match wire.status.as_str() {
        "sealed" => PlanAdmissionResponseStatusV1::Sealed,
        "reconciliation_required" => PlanAdmissionResponseStatusV1::ReconciliationRequired,
        _ => return Err(PlanAdmissionResponseErrorV1::InvalidPayload),
    };
    validate_outcome_binding(status, wire.admission_event_id.as_deref())?;
    let signature_bytes = decode_signature_hex(&wire.signature)?;
    // Byte equality against the canonical rendering is what makes the accepted
    // payload unique: no second spelling of the same fields can verify.
    let canonical = canonical_signed_payload(
        expected,
        status,
        wire.admission_event_id.as_deref(),
        &wire.signature,
    );
    if payload != canonical {
        return Err(PlanAdmissionResponseErrorV1::InvalidPayload);
    }
    let unsigned = canonical_unsigned_payload(expected, status, wire.admission_event_id.as_deref());
    verifying_key
        .verify_strict(
            &signature_message(&unsigned),
            &Signature::from_bytes(&signature_bytes),
        )
        .map_err(|_| PlanAdmissionResponseErrorV1::InvalidSignature)?;
    Ok((status, wire.admission_event_id))
}

fn canonical_unsigned_payload(
    binding: PlanAdmissionResponseBindingV1<'_>,
    status: PlanAdmissionResponseStatusV1,
    admission_event_id: Option<&str>,
) -> Vec<u8> {
    let admission_event_id = admission_event_id
        .map(|event_id| format!(r#""{event_id}""#))
        .unwrap_or_else(|| "null".into());
    format!(
        r#"{{"schema_version":{RESPONSE_SCHEMA_VERSION},"protocol":"{RESPONSE_PROTOCOL}","domain":"{RESPONSE_DOMAIN}","request_id":"{}","plan_content_ref":"{}","admission_event_id":{},"status":"{}"}}"#,
        binding.request_id,
        binding.plan_content_ref,
        admission_event_id,
        status.as_str()
    )
    .into_bytes()
}

fn canonical_signed_payload(
    binding: PlanAdmissionResponseBindingV1<'_>,
    status: PlanAdmissionResponseStatusV1,
    admission_event_id: Option<&str>,
    signature: &str,
) -> Vec<u8> {
    let mut unsigned = canonical_unsigned_payload(binding, status, admission_event_id);
    unsigned.pop();
    unsigned.extend_from_slice(br#","signature":""#);
    unsigned.extend_from_slice(signature.as_bytes());
    unsigned.extend_from_slice(br#""}"#);
    unsigned
}

fn validate_outcome_binding(
    status: PlanAdmissionResponseStatusV1,
    admission_event_id: Option<&str>,
) -> Result<(), PlanAdmissionResponseErrorV1> {
    match (status, admission_event_id) {
        (PlanAdmissionResponseStatusV1::Sealed, Some(event_id)) if is_canonical_uuid(event_id) => {
            Ok(())
        }
        (PlanAdmissionResponseStatusV1::ReconciliationRequired, None) => Ok(()),
        _ => Err(PlanAdmissionResponseErrorV1::InvalidBinding),
    }
}

fn signature_message(unsigned: &[u8]) -> Vec<u8> {
    let mut message = Vec::with_capacity(SIGNATURE_DOMAIN.len() + unsigned.len());
    message.extend_from_slice(SIGNATURE_DOMAIN);
    message.extend_from_slice(unsigned);
    message
}

fn is_canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value)
        .map(|uuid| uuid.hyphenated().to_string() == value)
        .unwrap_or(false)
}

/// The same closed `cas://sha256:<64 lowercase hex>` shape the ingress parses.
/// The binding is echoed into a hand-built canonical payload, so a value that
/// could carry a quote or a control character must never reach it.
fn is_canonical_plan_content_ref(value: &str) -> bool {
    value.strip_prefix("cas://sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

#[allow(dead_code)] // Verification half only.
fn decode_signature_hex(value: &str) -> Result<[u8; 64], PlanAdmissionResponseErrorV1> {
    if value.len() != 128 || !value.as_bytes().iter().all(u8::is_ascii_hexdigit) {
        return Err(PlanAdmissionResponseErrorV1::InvalidSignature);
    }
    let mut bytes = [0_u8; 64];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        bytes[index] = (decode_nibble(pair[0])? << 4) | decode_nibble(pair[1])?;
    }
    Ok(bytes)
}

#[allow(dead_code)] // Verification half only.
fn decode_nibble(byte: u8) -> Result<u8, PlanAdmissionResponseErrorV1> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        _ => Err(PlanAdmissionResponseErrorV1::InvalidSignature),
    }
}
