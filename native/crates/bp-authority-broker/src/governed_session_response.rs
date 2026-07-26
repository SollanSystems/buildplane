//! Canonical, domain-separated authentication for protected session replies.

use crate::governed_session_client::{
    GovernedSessionClientOperationV1, ParsedGovernedSessionClientRequestV1,
};
use crate::BrokerModelActionStatus;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

const PROTOCOL: &str = "buildplane-governed-session";
const DOMAIN: &str = "protected-authority-response";
const SIGNATURE_DOMAIN: &[u8] = b"buildplane.protected-governed-session.response.v1\0";
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VerifiedGovernedSessionResponseV1 {
    projection_json: Vec<u8>,
}

impl VerifiedGovernedSessionResponseV1 {
    pub(crate) fn projection_json(&self) -> &[u8] {
        &self.projection_json
    }
}

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum GovernedSessionResponseErrorV1 {
    #[error("governed session response binding is invalid")]
    InvalidBinding,
    #[error("governed session response payload is invalid")]
    InvalidPayload,
    #[error("governed session response signature is invalid")]
    InvalidSignature,
}

#[derive(Serialize)]
struct UnsignedResponseWireV1<'a> {
    schema_version: u8,
    protocol: &'static str,
    domain: &'static str,
    request_id: &'a str,
    operation: &'static str,
    status: &'static str,
    recovery_ref: Option<&'a str>,
    session_ref: Option<&'a str>,
    result: Option<&'a Value>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedResponseWireV1 {
    schema_version: u8,
    protocol: String,
    domain: String,
    request_id: String,
    operation: String,
    status: String,
    recovery_ref: Option<String>,
    session_ref: Option<String>,
    result: Option<Value>,
    signature: String,
}

#[derive(Serialize)]
struct ProjectionWireV1<'a> {
    schema_version: u8,
    protocol: &'static str,
    request_id: &'a str,
    operation: &'static str,
    status: &'static str,
    recovery_ref: Option<&'a str>,
    session_ref: Option<&'a str>,
    result: Option<&'a Value>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GovernedReviewerRunResultWireV1 {
    schema_version: u8,
    kind: String,
    status: String,
}

pub(crate) fn governed_reviewer_run_result_v1(status: BrokerModelActionStatus) -> Value {
    let status = match status {
        BrokerModelActionStatus::Pending => "pending",
        BrokerModelActionStatus::Recorded => "recorded",
        BrokerModelActionStatus::Failed => "failed",
        BrokerModelActionStatus::LeaseExpired => "lease_expired",
        BrokerModelActionStatus::ReconciliationRequired => "reconciliation_required",
    };
    serde_json::to_value(GovernedReviewerRunResultWireV1 {
        schema_version: 1,
        kind: "governed_reviewer_run_result_v1".into(),
        status: status.into(),
    })
    .expect("fixed governed reviewer result is serializable")
}

pub(crate) fn sign_governed_session_response_v1(
    signing_key: &SigningKey,
    request: &ParsedGovernedSessionClientRequestV1,
    recovery_ref: &str,
    session_ref: &str,
    result: Option<Value>,
) -> Result<Vec<u8>, GovernedSessionResponseErrorV1> {
    let response = validate_response_binding(
        request,
        Some(recovery_ref),
        Some(session_ref),
        result.as_ref(),
    )?;
    let unsigned = encode_unsigned(request, &response)?;
    let signature = signing_key.sign(&signature_message(&unsigned));
    let encoded = encode_signed(
        request,
        &response,
        result.clone(),
        encode_hex(&signature.to_bytes()),
    )?;
    if encoded.len() > MAX_RESPONSE_BYTES {
        return Err(GovernedSessionResponseErrorV1::InvalidPayload);
    }
    Ok(encoded)
}

pub(crate) fn sign_governed_session_probe_response_v1(
    signing_key: &SigningKey,
    request: &ParsedGovernedSessionClientRequestV1,
) -> Result<Vec<u8>, GovernedSessionResponseErrorV1> {
    if request.operation() != GovernedSessionClientOperationV1::Probe {
        return Err(GovernedSessionResponseErrorV1::InvalidBinding);
    }
    let result = probe_result();
    let response = validate_response_binding(request, None, None, Some(&result))?;
    let unsigned = encode_unsigned(request, &response)?;
    let signature = signing_key.sign(&signature_message(&unsigned));
    encode_signed(
        request,
        &response,
        Some(result.clone()),
        encode_hex(&signature.to_bytes()),
    )
}

pub(crate) fn verify_governed_session_response_v1(
    payload: &[u8],
    verifying_key: &VerifyingKey,
    request: &ParsedGovernedSessionClientRequestV1,
) -> Result<VerifiedGovernedSessionResponseV1, GovernedSessionResponseErrorV1> {
    if payload.is_empty() || payload.len() > MAX_RESPONSE_BYTES {
        return Err(GovernedSessionResponseErrorV1::InvalidPayload);
    }
    let wire: SignedResponseWireV1 = serde_json::from_slice(payload)
        .map_err(|_| GovernedSessionResponseErrorV1::InvalidPayload)?;
    let expected_operation = operation_name(request.operation());
    if wire.schema_version != 1
        || wire.protocol != PROTOCOL
        || wire.domain != DOMAIN
        || wire.request_id != request.request_id()
        || wire.operation != expected_operation
    {
        return Err(GovernedSessionResponseErrorV1::InvalidPayload);
    }
    let response = validate_response_binding(
        request,
        wire.recovery_ref.as_deref(),
        wire.session_ref.as_deref(),
        wire.result.as_ref(),
    )?;
    if wire.status != response.status {
        return Err(GovernedSessionResponseErrorV1::InvalidPayload);
    }
    let unsigned = encode_unsigned(request, &response)?;
    let signature = decode_signature(&wire.signature)?;
    verifying_key
        .verify_strict(
            &signature_message(&unsigned),
            &Signature::from_bytes(&signature),
        )
        .map_err(|_| GovernedSessionResponseErrorV1::InvalidSignature)?;
    let canonical = encode_signed(
        request,
        &response,
        wire.result.clone(),
        wire.signature.clone(),
    )?;
    if payload != canonical {
        return Err(GovernedSessionResponseErrorV1::InvalidPayload);
    }
    let projection_json = encode_projection(request, &response)?;
    Ok(VerifiedGovernedSessionResponseV1 { projection_json })
}

struct ValidatedResponse<'a> {
    status: &'static str,
    recovery_ref: Option<&'a str>,
    session_ref: Option<&'a str>,
    result: Option<&'a Value>,
}

fn validate_response_binding<'a>(
    request: &ParsedGovernedSessionClientRequestV1,
    recovery_ref: Option<&'a str>,
    session_ref: Option<&'a str>,
    result: Option<&'a Value>,
) -> Result<ValidatedResponse<'a>, GovernedSessionResponseErrorV1> {
    let (status, result) = match request.operation() {
        GovernedSessionClientOperationV1::Probe => {
            if recovery_ref.is_some() || session_ref.is_some() || result != Some(&probe_result()) {
                return Err(GovernedSessionResponseErrorV1::InvalidBinding);
            }
            ("ready", result)
        }
        GovernedSessionClientOperationV1::OpenCandidateSession
        | GovernedSessionClientOperationV1::OpenRecoverySession
        | GovernedSessionClientOperationV1::OpenReviewerSession => {
            validate_session_refs(request, recovery_ref, session_ref)?;
            if result.is_some() {
                return Err(GovernedSessionResponseErrorV1::InvalidBinding);
            }
            ("opened", None)
        }
        GovernedSessionClientOperationV1::RunCandidateSession => {
            validate_session_refs(request, recovery_ref, session_ref)?;
            let result = result
                .filter(|value| value.is_object())
                .ok_or(GovernedSessionResponseErrorV1::InvalidBinding)?;
            ("completed", Some(result))
        }
        GovernedSessionClientOperationV1::RunReviewerSession => {
            validate_session_refs(request, recovery_ref, session_ref)?;
            let result = result.ok_or(GovernedSessionResponseErrorV1::InvalidBinding)?;
            validate_governed_reviewer_run_result(result)?;
            ("completed", Some(result))
        }
    };
    Ok(ValidatedResponse {
        status,
        recovery_ref,
        session_ref,
        result,
    })
}

fn validate_governed_reviewer_run_result(
    result: &Value,
) -> Result<(), GovernedSessionResponseErrorV1> {
    let result: GovernedReviewerRunResultWireV1 = serde_json::from_value(result.clone())
        .map_err(|_| GovernedSessionResponseErrorV1::InvalidBinding)?;
    if result.schema_version != 1
        || result.kind != "governed_reviewer_run_result_v1"
        || !matches!(
            result.status.as_str(),
            "pending" | "recorded" | "failed" | "lease_expired" | "reconciliation_required"
        )
    {
        return Err(GovernedSessionResponseErrorV1::InvalidBinding);
    }
    Ok(())
}

fn encode_unsigned(
    request: &ParsedGovernedSessionClientRequestV1,
    response: &ValidatedResponse<'_>,
) -> Result<Vec<u8>, GovernedSessionResponseErrorV1> {
    serde_json::to_vec(&UnsignedResponseWireV1 {
        schema_version: 1,
        protocol: PROTOCOL,
        domain: DOMAIN,
        request_id: request.request_id(),
        operation: operation_name(request.operation()),
        status: response.status,
        recovery_ref: response.recovery_ref,
        session_ref: response.session_ref,
        result: response.result,
    })
    .map_err(|_| GovernedSessionResponseErrorV1::InvalidPayload)
}

fn encode_signed(
    request: &ParsedGovernedSessionClientRequestV1,
    response: &ValidatedResponse<'_>,
    result: Option<Value>,
    signature: String,
) -> Result<Vec<u8>, GovernedSessionResponseErrorV1> {
    serde_json::to_vec(&SignedResponseWireV1 {
        schema_version: 1,
        protocol: PROTOCOL.into(),
        domain: DOMAIN.into(),
        request_id: request.request_id().into(),
        operation: operation_name(request.operation()).into(),
        status: response.status.into(),
        recovery_ref: response.recovery_ref.map(str::to_owned),
        session_ref: response.session_ref.map(str::to_owned),
        result,
        signature,
    })
    .map_err(|_| GovernedSessionResponseErrorV1::InvalidPayload)
}

fn encode_projection(
    request: &ParsedGovernedSessionClientRequestV1,
    response: &ValidatedResponse<'_>,
) -> Result<Vec<u8>, GovernedSessionResponseErrorV1> {
    serde_json::to_vec(&ProjectionWireV1 {
        schema_version: 1,
        protocol: PROTOCOL,
        request_id: request.request_id(),
        operation: operation_name(request.operation()),
        status: response.status,
        recovery_ref: response.recovery_ref,
        session_ref: response.session_ref,
        result: response.result,
    })
    .map_err(|_| GovernedSessionResponseErrorV1::InvalidPayload)
}

fn operation_name(operation: GovernedSessionClientOperationV1) -> &'static str {
    match operation {
        GovernedSessionClientOperationV1::Probe => "probe",
        GovernedSessionClientOperationV1::OpenCandidateSession => "open_candidate_session",
        GovernedSessionClientOperationV1::OpenRecoverySession => "open_recovery_session",
        GovernedSessionClientOperationV1::RunCandidateSession => "run_candidate_session",
        GovernedSessionClientOperationV1::OpenReviewerSession => "open_reviewer_session",
        GovernedSessionClientOperationV1::RunReviewerSession => "run_reviewer_session",
    }
}

fn validate_session_refs(
    request: &ParsedGovernedSessionClientRequestV1,
    recovery_ref: Option<&str>,
    session_ref: Option<&str>,
) -> Result<(), GovernedSessionResponseErrorV1> {
    let recovery_ref = recovery_ref.ok_or(GovernedSessionResponseErrorV1::InvalidBinding)?;
    let session_ref = session_ref.ok_or(GovernedSessionResponseErrorV1::InvalidBinding)?;
    if !is_opaque_ref(recovery_ref)
        || !is_opaque_ref(session_ref)
        || request
            .recovery_ref()
            .is_some_and(|expected| expected != recovery_ref)
        || request
            .session_ref()
            .is_some_and(|expected| expected != session_ref)
    {
        return Err(GovernedSessionResponseErrorV1::InvalidBinding);
    }
    Ok(())
}

fn probe_result() -> Value {
    serde_json::json!({
        "operations": [
            "open_candidate_session",
            "open_recovery_session",
            "run_candidate_session",
            "open_reviewer_session",
            "run_reviewer_session"
        ]
    })
}

fn signature_message(unsigned: &[u8]) -> Vec<u8> {
    let mut message = Vec::with_capacity(SIGNATURE_DOMAIN.len() + unsigned.len());
    message.extend_from_slice(SIGNATURE_DOMAIN);
    message.extend_from_slice(unsigned);
    message
}

fn is_opaque_ref(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value.contains("..")
        && !value.contains("//")
        && !value.contains("@{")
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric()
                || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'/' | b'-'))
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

fn decode_signature(value: &str) -> Result<[u8; 64], GovernedSessionResponseErrorV1> {
    if value.len() != 128
        || !value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(GovernedSessionResponseErrorV1::InvalidSignature);
    }
    let mut decoded = [0_u8; 64];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        decoded[index] = (decode_nibble(pair[0])? << 4) | decode_nibble(pair[1])?;
    }
    Ok(decoded)
}

fn decode_nibble(byte: u8) -> Result<u8, GovernedSessionResponseErrorV1> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        _ => Err(GovernedSessionResponseErrorV1::InvalidSignature),
    }
}
