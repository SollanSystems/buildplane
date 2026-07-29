//! Domain-separated authentication for protected promotion-execution responses.

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::Deserialize;
use thiserror::Error;
use uuid::Uuid;

const RESPONSE_SCHEMA_VERSION: u8 = 1;
const RESPONSE_PROTOCOL: &str = "buildplane-promotion-execution";
const RESPONSE_DOMAIN: &str = "protected-authority-response";
const SIGNATURE_DOMAIN: &[u8] = b"buildplane.protected-promotion-execution.response.v1\0";

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum PromotionExecutionResponseErrorV1 {
    #[error("promotion-execution response binding is invalid")]
    InvalidBinding,
    #[error("promotion-execution response payload is invalid")]
    InvalidPayload,
    #[error("promotion-execution response signature is invalid")]
    InvalidSignature,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PromotionExecutionResponseStatusV1 {
    Rejected,
    Pending,
    Completed,
    Recorded,
    LeaseExpired,
    ReconciliationRequired,
}

impl PromotionExecutionResponseStatusV1 {
    fn as_str(self) -> &'static str {
        match self {
            Self::Rejected => "rejected",
            Self::Pending => "pending",
            Self::Completed => "completed",
            Self::Recorded => "recorded",
            Self::LeaseExpired => "lease_expired",
            Self::ReconciliationRequired => "reconciliation_required",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct PromotionExecutionResponseBindingV1<'a> {
    request_id: &'a str,
    promotion_decision_event_id: &'a str,
}

impl<'a> PromotionExecutionResponseBindingV1<'a> {
    pub(crate) fn new(
        request_id: &'a str,
        promotion_decision_event_id: &'a str,
    ) -> Result<Self, PromotionExecutionResponseErrorV1> {
        if !is_canonical_uuid(request_id) || !is_canonical_uuid(promotion_decision_event_id) {
            return Err(PromotionExecutionResponseErrorV1::InvalidBinding);
        }
        Ok(Self {
            request_id,
            promotion_decision_event_id,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedPromotionExecutionResponseWireV1 {
    schema_version: u8,
    protocol: String,
    domain: String,
    request_id: String,
    promotion_decision_event_id: String,
    status: String,
    signature: String,
}

pub(crate) fn sign_promotion_execution_response(
    signing_key: &SigningKey,
    binding: PromotionExecutionResponseBindingV1<'_>,
    status: PromotionExecutionResponseStatusV1,
) -> Vec<u8> {
    let unsigned = canonical_unsigned_payload(binding, status);
    let signature = signing_key.sign(&signature_message(&unsigned));
    canonical_signed_payload(binding, status, &encode_hex(&signature.to_bytes()))
}

pub(crate) fn verify_promotion_execution_response(
    payload: &[u8],
    verifying_key: &VerifyingKey,
    expected: PromotionExecutionResponseBindingV1<'_>,
) -> Result<PromotionExecutionResponseStatusV1, PromotionExecutionResponseErrorV1> {
    let wire: SignedPromotionExecutionResponseWireV1 = serde_json::from_slice(payload)
        .map_err(|_| PromotionExecutionResponseErrorV1::InvalidPayload)?;
    if wire.schema_version != RESPONSE_SCHEMA_VERSION
        || wire.protocol != RESPONSE_PROTOCOL
        || wire.domain != RESPONSE_DOMAIN
        || wire.request_id != expected.request_id
        || wire.promotion_decision_event_id != expected.promotion_decision_event_id
    {
        return Err(PromotionExecutionResponseErrorV1::InvalidBinding);
    }
    let status = match wire.status.as_str() {
        "rejected" => PromotionExecutionResponseStatusV1::Rejected,
        "pending" => PromotionExecutionResponseStatusV1::Pending,
        "completed" => PromotionExecutionResponseStatusV1::Completed,
        "recorded" => PromotionExecutionResponseStatusV1::Recorded,
        "lease_expired" => PromotionExecutionResponseStatusV1::LeaseExpired,
        "reconciliation_required" => PromotionExecutionResponseStatusV1::ReconciliationRequired,
        _ => return Err(PromotionExecutionResponseErrorV1::InvalidPayload),
    };
    let signature_bytes = decode_signature_hex(&wire.signature)?;
    let canonical = canonical_signed_payload(expected, status, &wire.signature);
    if payload != canonical {
        return Err(PromotionExecutionResponseErrorV1::InvalidPayload);
    }
    let unsigned = canonical_unsigned_payload(expected, status);
    verifying_key
        .verify_strict(
            &signature_message(&unsigned),
            &Signature::from_bytes(&signature_bytes),
        )
        .map_err(|_| PromotionExecutionResponseErrorV1::InvalidSignature)?;
    Ok(status)
}

fn canonical_unsigned_payload(
    binding: PromotionExecutionResponseBindingV1<'_>,
    status: PromotionExecutionResponseStatusV1,
) -> Vec<u8> {
    format!(
        r#"{{"schema_version":{RESPONSE_SCHEMA_VERSION},"protocol":"{RESPONSE_PROTOCOL}","domain":"{RESPONSE_DOMAIN}","request_id":"{}","promotion_decision_event_id":"{}","status":"{}"}}"#,
        binding.request_id,
        binding.promotion_decision_event_id,
        status.as_str()
    )
    .into_bytes()
}

fn canonical_signed_payload(
    binding: PromotionExecutionResponseBindingV1<'_>,
    status: PromotionExecutionResponseStatusV1,
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

fn decode_signature_hex(value: &str) -> Result<[u8; 64], PromotionExecutionResponseErrorV1> {
    if value.len() != 128 {
        return Err(PromotionExecutionResponseErrorV1::InvalidSignature);
    }
    let mut decoded = [0_u8; 64];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        decoded[index] = (decode_nibble(pair[0])? << 4) | decode_nibble(pair[1])?;
    }
    Ok(decoded)
}

fn decode_nibble(byte: u8) -> Result<u8, PromotionExecutionResponseErrorV1> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        _ => Err(PromotionExecutionResponseErrorV1::InvalidSignature),
    }
}

#[cfg(test)]
pub(crate) fn sign_promotion_execution_response_for_test(
    signing_key: &SigningKey,
    binding: PromotionExecutionResponseBindingV1<'_>,
    status: PromotionExecutionResponseStatusV1,
) -> Result<Vec<u8>, PromotionExecutionResponseErrorV1> {
    Ok(sign_promotion_execution_response(
        signing_key,
        binding,
        status,
    ))
}

#[cfg(test)]
pub(crate) fn verify_promotion_execution_response_for_test(
    payload: &[u8],
    verifying_key: &VerifyingKey,
    expected: PromotionExecutionResponseBindingV1<'_>,
) -> Result<PromotionExecutionResponseStatusV1, PromotionExecutionResponseErrorV1> {
    verify_promotion_execution_response(payload, verifying_key, expected)
}
