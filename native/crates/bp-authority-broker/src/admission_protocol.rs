//! Strict, non-executing parsing for authority-broker request wire V1.
//!
//! This module accepts only the closed request JSON emitted by the TypeScript
//! authority-broker client. It deliberately contains no transport, listener,
//! startup configuration, dispatch issuance, credential, filesystem, or
//! process capability. A future OS-authenticated broker may consume the
//! crate-private parsed data only after it has established its own protected
//! authority boundary.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

const MAX_JS_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// The two closed operations accepted by authority-broker request wire V1.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
pub(crate) enum AuthorityBrokerOperationV1 {
    #[serde(rename = "admit")]
    Admit,
    #[serde(rename = "lookup_preauthorized")]
    LookupPreauthorized,
}

impl AuthorityBrokerOperationV1 {
    fn wire_name(self) -> &'static str {
        match self {
            Self::Admit => "admit",
            Self::LookupPreauthorized => "lookup_preauthorized",
        }
    }
}

/// Parsed, validated V1 request data with no execution capability.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ParsedAuthorityBrokerRequestV1 {
    pub(crate) schema_version: u8,
    pub(crate) operation: AuthorityBrokerOperationV1,
    pub(crate) request_id: String,
    pub(crate) request: ParsedAuthorityBrokerRequestBodyV1,
    pub(crate) request_digest: String,
}

/// The request shape paired to the outer V1 operation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ParsedAuthorityBrokerRequestBodyV1 {
    Admit(ParsedAuthorityBrokerAdmitRequestV1),
    LookupPreauthorized(ParsedAuthorityBrokerPreauthorizedLookupRequestV1),
}

/// Parsed fields allowed only for an admit request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ParsedAuthorityBrokerAdmitRequestV1 {
    pub(crate) run_id: String,
    pub(crate) workflow_id: String,
    pub(crate) workflow_revision: String,
    pub(crate) unit_id: String,
    pub(crate) attempt: u64,
    pub(crate) idempotency_key: String,
    pub(crate) repository_target_ref: String,
    pub(crate) expected_repository_binding_digest: String,
    pub(crate) governed_packet_ref: String,
    pub(crate) governed_packet_digest: String,
}

/// Parsed fields allowed only for a lookup_preauthorized request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ParsedAuthorityBrokerPreauthorizedLookupRequestV1 {
    pub(crate) run_id: String,
    pub(crate) workflow_id: String,
    pub(crate) workflow_revision: String,
    pub(crate) unit_id: String,
    pub(crate) attempt: u64,
    pub(crate) idempotency_key: String,
    pub(crate) repository_target_ref: String,
    pub(crate) expected_repository_binding_digest: String,
    pub(crate) preauthorization_ref: String,
    pub(crate) governed_packet_ref: String,
    pub(crate) governed_packet_digest: String,
}

/// Rejections are parsing and integrity failures only; this module has no
/// execution or dispatch error state because it never performs either action.
#[derive(Debug, Error)]
pub(crate) enum AdmissionProtocolError {
    #[error("authority broker request must be closed V1 JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("authority broker request schema_version must be 1")]
    UnsupportedSchemaVersion,
    #[error("authority broker operation does not match its closed request body")]
    OperationRequestMismatch,
    #[error("{field} must be a canonical lowercase UUID")]
    InvalidUuid { field: &'static str },
    #[error("{field} must be a canonical SHA-256 digest")]
    InvalidDigest { field: &'static str },
    #[error("{field} must be a positive JavaScript safe integer")]
    InvalidAttempt { field: &'static str },
    #[error("{field} must be non-empty after ECMAScript trimming and contain no NUL")]
    InvalidNonEmpty { field: &'static str },
    #[error("{field} must be an opaque reference with its required scheme")]
    InvalidOpaqueReference { field: &'static str },
    #[error("authority broker request_digest does not match the canonical request")]
    RequestDigestMismatch,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireAuthorityBrokerRequestV1 {
    schema_version: f64,
    operation: AuthorityBrokerOperationV1,
    request_id: String,
    request: WireAuthorityBrokerRequestBodyV1,
    request_digest: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WireAuthorityBrokerRequestBodyV1 {
    Admit(WireAuthorityBrokerAdmitRequestV1),
    LookupPreauthorized(WireAuthorityBrokerPreauthorizedLookupRequestV1),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireAuthorityBrokerAdmitRequestV1 {
    run_id: String,
    workflow_id: String,
    workflow_revision: String,
    unit_id: String,
    attempt: f64,
    idempotency_key: String,
    repository_target_ref: String,
    expected_repository_binding_digest: String,
    governed_packet_ref: String,
    governed_packet_digest: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireAuthorityBrokerPreauthorizedLookupRequestV1 {
    run_id: String,
    workflow_id: String,
    workflow_revision: String,
    unit_id: String,
    attempt: f64,
    idempotency_key: String,
    repository_target_ref: String,
    expected_repository_binding_digest: String,
    preauthorization_ref: String,
    governed_packet_ref: String,
    governed_packet_digest: String,
}

/// Parse and validate a single closed V1 request without invoking anything.
///
/// The bytes-only signature intentionally prevents callers from supplying
/// paths, signers, keys, commands, providers, envelopes, expiry, or effect
/// dependencies to this parser.
pub(crate) fn parse_authority_broker_request_v1(
    wire: &[u8],
) -> Result<ParsedAuthorityBrokerRequestV1, AdmissionProtocolError> {
    let wire: WireAuthorityBrokerRequestV1 = serde_json::from_slice(wire)?;
    if wire.schema_version != 1.0 {
        return Err(AdmissionProtocolError::UnsupportedSchemaVersion);
    }

    let request_id = require_uuid(wire.request_id, "request_id")?;
    let request_digest = require_digest(wire.request_digest, "request_digest")?;
    let request = match (wire.operation, wire.request) {
        (AuthorityBrokerOperationV1::Admit, WireAuthorityBrokerRequestBodyV1::Admit(request)) => {
            ParsedAuthorityBrokerRequestBodyV1::Admit(parse_admit_request(request)?)
        }
        (
            AuthorityBrokerOperationV1::LookupPreauthorized,
            WireAuthorityBrokerRequestBodyV1::LookupPreauthorized(request),
        ) => {
            ParsedAuthorityBrokerRequestBodyV1::LookupPreauthorized(parse_lookup_request(request)?)
        }
        _ => return Err(AdmissionProtocolError::OperationRequestMismatch),
    };

    let parsed = ParsedAuthorityBrokerRequestV1 {
        schema_version: 1,
        operation: wire.operation,
        request_id,
        request,
        request_digest,
    };
    if canonical_request_digest(&parsed) != parsed.request_digest {
        return Err(AdmissionProtocolError::RequestDigestMismatch);
    }
    Ok(parsed)
}

fn parse_admit_request(
    request: WireAuthorityBrokerAdmitRequestV1,
) -> Result<ParsedAuthorityBrokerAdmitRequestV1, AdmissionProtocolError> {
    Ok(ParsedAuthorityBrokerAdmitRequestV1 {
        run_id: require_uuid(request.run_id, "run_id")?,
        workflow_id: require_non_empty(request.workflow_id, "workflow_id")?,
        workflow_revision: require_non_empty(request.workflow_revision, "workflow_revision")?,
        unit_id: require_non_empty(request.unit_id, "unit_id")?,
        attempt: require_positive_safe_integer(request.attempt, "attempt")?,
        idempotency_key: require_non_empty(request.idempotency_key, "idempotency_key")?,
        repository_target_ref: require_broker_reference(
            request.repository_target_ref,
            "repository_target_ref",
        )?,
        expected_repository_binding_digest: require_digest(
            request.expected_repository_binding_digest,
            "expected_repository_binding_digest",
        )?,
        governed_packet_ref: require_cas_reference(
            request.governed_packet_ref,
            "governed_packet_ref",
        )?,
        governed_packet_digest: require_digest(
            request.governed_packet_digest,
            "governed_packet_digest",
        )?,
    })
}

fn parse_lookup_request(
    request: WireAuthorityBrokerPreauthorizedLookupRequestV1,
) -> Result<ParsedAuthorityBrokerPreauthorizedLookupRequestV1, AdmissionProtocolError> {
    Ok(ParsedAuthorityBrokerPreauthorizedLookupRequestV1 {
        run_id: require_uuid(request.run_id, "run_id")?,
        workflow_id: require_non_empty(request.workflow_id, "workflow_id")?,
        workflow_revision: require_non_empty(request.workflow_revision, "workflow_revision")?,
        unit_id: require_non_empty(request.unit_id, "unit_id")?,
        attempt: require_positive_safe_integer(request.attempt, "attempt")?,
        idempotency_key: require_non_empty(request.idempotency_key, "idempotency_key")?,
        repository_target_ref: require_broker_reference(
            request.repository_target_ref,
            "repository_target_ref",
        )?,
        expected_repository_binding_digest: require_digest(
            request.expected_repository_binding_digest,
            "expected_repository_binding_digest",
        )?,
        preauthorization_ref: require_broker_reference(
            request.preauthorization_ref,
            "preauthorization_ref",
        )?,
        governed_packet_ref: require_cas_reference(
            request.governed_packet_ref,
            "governed_packet_ref",
        )?,
        governed_packet_digest: require_digest(
            request.governed_packet_digest,
            "governed_packet_digest",
        )?,
    })
}

fn require_uuid(value: String, field: &'static str) -> Result<String, AdmissionProtocolError> {
    let bytes = value.as_bytes();
    let is_valid = bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'),
        });
    if is_valid {
        Ok(value)
    } else {
        Err(AdmissionProtocolError::InvalidUuid { field })
    }
}

fn require_digest(value: String, field: &'static str) -> Result<String, AdmissionProtocolError> {
    let is_valid = value
        .strip_prefix("sha256:")
        .is_some_and(|hex| hex.len() == 64 && hex.bytes().all(is_lower_hex));
    if is_valid {
        Ok(value)
    } else {
        Err(AdmissionProtocolError::InvalidDigest { field })
    }
}

fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')
}

fn require_positive_safe_integer(
    value: f64,
    field: &'static str,
) -> Result<u64, AdmissionProtocolError> {
    if value.is_finite() && value >= 1.0 && value <= MAX_JS_SAFE_INTEGER && value.fract() == 0.0 {
        Ok(value as u64)
    } else {
        Err(AdmissionProtocolError::InvalidAttempt { field })
    }
}

fn require_non_empty(value: String, field: &'static str) -> Result<String, AdmissionProtocolError> {
    if value.contains('\0')
        || !value
            .chars()
            .any(|character| !is_ecmascript_trim_whitespace(character))
    {
        Err(AdmissionProtocolError::InvalidNonEmpty { field })
    } else {
        Ok(value)
    }
}

fn is_ecmascript_trim_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

fn require_cas_reference(
    value: String,
    field: &'static str,
) -> Result<String, AdmissionProtocolError> {
    require_opaque_reference(value, field, "cas://")
}

fn require_broker_reference(
    value: String,
    field: &'static str,
) -> Result<String, AdmissionProtocolError> {
    require_opaque_reference(value, field, "broker://")
}

fn require_opaque_reference(
    value: String,
    field: &'static str,
    prefix: &str,
) -> Result<String, AdmissionProtocolError> {
    let value = require_non_empty(value, field)?;
    let is_valid = value.strip_prefix(prefix).is_some_and(|suffix| {
        !suffix.is_empty()
            && !value.contains('\\')
            && !value.contains("..")
            && is_opaque_reference_fragment(suffix)
    });
    if is_valid {
        Ok(value)
    } else {
        Err(AdmissionProtocolError::InvalidOpaqueReference { field })
    }
}

fn is_opaque_reference_fragment(value: &str) -> bool {
    let bytes = value.as_bytes();
    matches!(bytes.first(), Some(byte) if byte.is_ascii_alphanumeric())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'/' | b'-'))
}

fn canonical_request_digest(request: &ParsedAuthorityBrokerRequestV1) -> String {
    let mut digest = Sha256::new();
    digest.update(canonical_request_json(request).as_bytes());
    format!("sha256:{:x}", digest.finalize())
}

fn canonical_request_json(request: &ParsedAuthorityBrokerRequestV1) -> String {
    let body = match &request.request {
        ParsedAuthorityBrokerRequestBodyV1::Admit(request) => canonical_admit_request_json(request),
        ParsedAuthorityBrokerRequestBodyV1::LookupPreauthorized(request) => {
            canonical_lookup_request_json(request)
        }
    };
    format!(
        r#"{{"operation":{},"request":{},"request_id":{},"schema_version":1}}"#,
        json_string(request.operation.wire_name()),
        body,
        json_string(&request.request_id),
    )
}

fn canonical_admit_request_json(request: &ParsedAuthorityBrokerAdmitRequestV1) -> String {
    format!(
        r#"{{"attempt":{},"expected_repository_binding_digest":{},"governed_packet_digest":{},"governed_packet_ref":{},"idempotency_key":{},"repository_target_ref":{},"run_id":{},"unit_id":{},"workflow_id":{},"workflow_revision":{}}}"#,
        request.attempt,
        json_string(&request.expected_repository_binding_digest),
        json_string(&request.governed_packet_digest),
        json_string(&request.governed_packet_ref),
        json_string(&request.idempotency_key),
        json_string(&request.repository_target_ref),
        json_string(&request.run_id),
        json_string(&request.unit_id),
        json_string(&request.workflow_id),
        json_string(&request.workflow_revision),
    )
}

fn canonical_lookup_request_json(
    request: &ParsedAuthorityBrokerPreauthorizedLookupRequestV1,
) -> String {
    format!(
        r#"{{"attempt":{},"expected_repository_binding_digest":{},"governed_packet_digest":{},"governed_packet_ref":{},"idempotency_key":{},"preauthorization_ref":{},"repository_target_ref":{},"run_id":{},"unit_id":{},"workflow_id":{},"workflow_revision":{}}}"#,
        request.attempt,
        json_string(&request.expected_repository_binding_digest),
        json_string(&request.governed_packet_digest),
        json_string(&request.governed_packet_ref),
        json_string(&request.idempotency_key),
        json_string(&request.preauthorization_ref),
        json_string(&request.repository_target_ref),
        json_string(&request.run_id),
        json_string(&request.unit_id),
        json_string(&request.workflow_id),
        json_string(&request.workflow_revision),
    )
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).expect("Rust strings are always JSON serializable")
}
