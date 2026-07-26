//! Domain-separated authentication for protected promotion-decision responses.
//!
//! The host is the only production caller that can sign, and it can sign only
//! this closed response shape. The client verifies the signature and every
//! request binding before interpreting the status.

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::Deserialize;
use thiserror::Error;
use uuid::Uuid;

const RESPONSE_SCHEMA_VERSION: u8 = 1;
const RESPONSE_PROTOCOL: &str = "buildplane-promotion-decision";
const RESPONSE_DOMAIN: &str = "protected-authority-response";
const SIGNATURE_DOMAIN: &[u8] = b"buildplane.protected-promotion-decision.response.v1\0";

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum PromotionDecisionResponseErrorV1 {
    #[error("promotion decision response binding was rejected")]
    InvalidBinding,
    #[error("promotion decision response payload was rejected")]
    InvalidPayload,
    #[error("promotion decision response signature was rejected")]
    InvalidSignature,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PromotionDecisionResponseStatusV1 {
    Sealed,
    ReconciliationRequired,
}

impl PromotionDecisionResponseStatusV1 {
    fn as_str(self) -> &'static str {
        match self {
            Self::Sealed => "sealed",
            Self::ReconciliationRequired => "reconciliation_required",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PromotionDecisionResponseBindingV1<'a> {
    request_id: &'a str,
    promotion_approval_request_event_id: &'a str,
    decision: &'a str,
}

impl<'a> PromotionDecisionResponseBindingV1<'a> {
    pub(crate) fn new(
        request_id: &'a str,
        promotion_approval_request_event_id: &'a str,
        decision: &'a str,
    ) -> Result<Self, PromotionDecisionResponseErrorV1> {
        if !is_canonical_uuid(request_id)
            || !is_canonical_uuid(promotion_approval_request_event_id)
            || !matches!(decision, "promote" | "reject")
        {
            return Err(PromotionDecisionResponseErrorV1::InvalidBinding);
        }
        Ok(Self {
            request_id,
            promotion_approval_request_event_id,
            decision,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedPromotionDecisionResponseWireV1 {
    schema_version: u8,
    protocol: String,
    domain: String,
    request_id: String,
    promotion_approval_request_event_id: String,
    decision: String,
    status: String,
    signature: String,
}

pub(crate) fn sign_promotion_decision_response(
    signing_key: &SigningKey,
    binding: PromotionDecisionResponseBindingV1<'_>,
    status: PromotionDecisionResponseStatusV1,
) -> Result<Vec<u8>, PromotionDecisionResponseErrorV1> {
    let unsigned = canonical_unsigned_payload(binding, status);
    let message = signature_message(&unsigned);
    let signature = signing_key.sign(&message);
    Ok(canonical_signed_payload(
        binding,
        status,
        &encode_hex(&signature.to_bytes()),
    ))
}

pub(crate) fn verify_promotion_decision_response(
    payload: &[u8],
    verifying_key: &VerifyingKey,
    expected: PromotionDecisionResponseBindingV1<'_>,
) -> Result<PromotionDecisionResponseStatusV1, PromotionDecisionResponseErrorV1> {
    let wire: SignedPromotionDecisionResponseWireV1 = serde_json::from_slice(payload)
        .map_err(|_| PromotionDecisionResponseErrorV1::InvalidPayload)?;
    if wire.schema_version != RESPONSE_SCHEMA_VERSION
        || wire.protocol != RESPONSE_PROTOCOL
        || wire.domain != RESPONSE_DOMAIN
        || wire.request_id != expected.request_id
        || wire.promotion_approval_request_event_id != expected.promotion_approval_request_event_id
        || wire.decision != expected.decision
    {
        return Err(PromotionDecisionResponseErrorV1::InvalidPayload);
    }
    let status = match wire.status.as_str() {
        "sealed" => PromotionDecisionResponseStatusV1::Sealed,
        "reconciliation_required" => PromotionDecisionResponseStatusV1::ReconciliationRequired,
        _ => return Err(PromotionDecisionResponseErrorV1::InvalidPayload),
    };
    let signature_bytes = decode_signature_hex(&wire.signature)?;
    let canonical = canonical_signed_payload(expected, status, &wire.signature);
    if payload != canonical {
        return Err(PromotionDecisionResponseErrorV1::InvalidPayload);
    }
    let unsigned = canonical_unsigned_payload(expected, status);
    verifying_key
        .verify_strict(
            &signature_message(&unsigned),
            &Signature::from_bytes(&signature_bytes),
        )
        .map_err(|_| PromotionDecisionResponseErrorV1::InvalidSignature)?;
    Ok(status)
}

fn canonical_unsigned_payload(
    binding: PromotionDecisionResponseBindingV1<'_>,
    status: PromotionDecisionResponseStatusV1,
) -> Vec<u8> {
    format!(
        r#"{{"schema_version":{RESPONSE_SCHEMA_VERSION},"protocol":"{RESPONSE_PROTOCOL}","domain":"{RESPONSE_DOMAIN}","request_id":"{}","promotion_approval_request_event_id":"{}","decision":"{}","status":"{}"}}"#,
        binding.request_id,
        binding.promotion_approval_request_event_id,
        binding.decision,
        status.as_str()
    )
    .into_bytes()
}

fn canonical_signed_payload(
    binding: PromotionDecisionResponseBindingV1<'_>,
    status: PromotionDecisionResponseStatusV1,
    signature: &str,
) -> Vec<u8> {
    let mut unsigned = canonical_unsigned_payload(binding, status);
    unsigned.pop();
    unsigned.extend_from_slice(br#","signature":""#);
    unsigned.extend_from_slice(signature.as_bytes());
    unsigned.extend_from_slice(br#""}"#);
    unsigned
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

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn decode_signature_hex(value: &str) -> Result<[u8; 64], PromotionDecisionResponseErrorV1> {
    if value.len() != 128 || !value.as_bytes().iter().all(u8::is_ascii_hexdigit) {
        return Err(PromotionDecisionResponseErrorV1::InvalidSignature);
    }
    let mut bytes = [0_u8; 64];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        bytes[index] = (decode_nibble(pair[0])? << 4) | decode_nibble(pair[1])?;
    }
    Ok(bytes)
}

fn decode_nibble(byte: u8) -> Result<u8, PromotionDecisionResponseErrorV1> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        _ => Err(PromotionDecisionResponseErrorV1::InvalidSignature),
    }
}

#[cfg(test)]
pub(crate) fn sign_promotion_decision_response_for_test(
    signing_key: &SigningKey,
    binding: PromotionDecisionResponseBindingV1<'_>,
    status: PromotionDecisionResponseStatusV1,
) -> Result<Vec<u8>, PromotionDecisionResponseErrorV1> {
    sign_promotion_decision_response(signing_key, binding, status)
}

#[cfg(test)]
pub(crate) fn verify_promotion_decision_response_for_test(
    payload: &[u8],
    verifying_key: &VerifyingKey,
    expected: PromotionDecisionResponseBindingV1<'_>,
) -> Result<PromotionDecisionResponseStatusV1, PromotionDecisionResponseErrorV1> {
    verify_promotion_decision_response(payload, verifying_key, expected)
}
