//! Closed, domain-separated authentication for protected V5 admission replies.

use crate::v5_dispatch_admission::{
    BrokerV5DispatchAdmissionDisposition, SealedV5DispatchAdmissionEvidence,
};
use bp_ledger::{EventId, RunId};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

const SIGNATURE_DOMAIN: &[u8] = b"buildplane.protected-v5-dispatch-admission.response.v1\0";
const PROTOCOL: &str = "buildplane-v5-dispatch-admission";
const DOMAIN: &str = "protected-authority-response";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct V5AdmissionResponseRequestBindingV1 {
    request_id: Uuid,
    run_id: RunId,
    v5_envelope_digest: String,
}

impl V5AdmissionResponseRequestBindingV1 {
    pub(crate) fn new(
        request_id: Uuid,
        run_id: RunId,
        v5_envelope_digest: String,
    ) -> Result<Self, V5AdmissionResponseErrorV1> {
        if !is_canonical_digest(&v5_envelope_digest) {
            return Err(V5AdmissionResponseErrorV1::InvalidBinding);
        }
        Ok(Self {
            request_id,
            run_id,
            v5_envelope_digest,
        })
    }

    pub(crate) fn request_id(&self) -> Uuid {
        self.request_id
    }

    pub(crate) fn run_id(&self) -> RunId {
        self.run_id
    }

    pub(crate) fn v5_envelope_digest(&self) -> &str {
        &self.v5_envelope_digest
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum VerifiedV5AdmissionResponseV1 {
    Sealed(SealedV5DispatchAdmissionEvidence),
    ReconciliationRequired,
}

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub(crate) enum V5AdmissionResponseErrorV1 {
    #[error("V5 admission response binding is invalid")]
    InvalidBinding,
    #[error("V5 admission response payload is invalid")]
    InvalidPayload,
    #[error("V5 admission response signature is invalid")]
    InvalidSignature,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct EvidenceWireV1 {
    run_id: String,
    source_dispatch_event_id: String,
    source_dispatch_event_digest: String,
    admission_event_id: String,
    admission_event_digest: String,
    v5_envelope_digest: String,
    witness_evidence_digest: String,
    semantic_identity_digest: String,
    idempotency_key: String,
    checkpoint_event_id: String,
    checkpoint_event_digest: String,
}

#[derive(Serialize)]
struct UnsignedResponseWireV1<'a> {
    schema_version: u8,
    protocol: &'static str,
    domain: &'static str,
    request_id: String,
    run_id: String,
    v5_envelope_digest: &'a str,
    status: &'static str,
    evidence: Option<&'a EvidenceWireV1>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedResponseWireV1 {
    schema_version: u8,
    protocol: String,
    domain: String,
    request_id: String,
    run_id: String,
    v5_envelope_digest: String,
    status: String,
    evidence: Option<EvidenceWireV1>,
    signature: String,
}

pub(crate) fn sign_v5_admission_response_v1(
    signing_key: &SigningKey,
    binding: &V5AdmissionResponseRequestBindingV1,
    disposition: &BrokerV5DispatchAdmissionDisposition,
) -> Result<Vec<u8>, V5AdmissionResponseErrorV1> {
    let (status, evidence) = match disposition {
        BrokerV5DispatchAdmissionDisposition::Sealed(evidence) => (
            "sealed",
            Some(validate_and_encode_evidence(evidence, binding)?),
        ),
        BrokerV5DispatchAdmissionDisposition::ReconciliationRequired => {
            ("reconciliation_required", None)
        }
    };
    let unsigned = encode_unsigned(binding, status, evidence.as_ref())?;
    let signature = signing_key.sign(&signature_message(&unsigned));
    encode_signed(binding, status, evidence, encode_hex(&signature.to_bytes()))
}

pub(crate) fn verify_v5_admission_response_v1(
    payload: &[u8],
    verifying_key: &VerifyingKey,
    expected: &V5AdmissionResponseRequestBindingV1,
) -> Result<VerifiedV5AdmissionResponseV1, V5AdmissionResponseErrorV1> {
    let wire: SignedResponseWireV1 =
        serde_json::from_slice(payload).map_err(|_| V5AdmissionResponseErrorV1::InvalidPayload)?;
    if wire.schema_version != 1
        || wire.protocol != PROTOCOL
        || wire.domain != DOMAIN
        || wire.request_id != expected.request_id.to_string()
        || wire.run_id != expected.run_id.to_string()
        || wire.v5_envelope_digest != expected.v5_envelope_digest
    {
        return Err(V5AdmissionResponseErrorV1::InvalidPayload);
    }
    let evidence = match wire.status.as_str() {
        "sealed" => Some(
            wire.evidence
                .as_ref()
                .ok_or(V5AdmissionResponseErrorV1::InvalidPayload)?,
        ),
        "reconciliation_required" if wire.evidence.is_none() => None,
        _ => return Err(V5AdmissionResponseErrorV1::InvalidPayload),
    };
    let unsigned = encode_unsigned(expected, &wire.status, evidence)?;
    let signature = decode_signature(&wire.signature)?;
    verifying_key
        .verify_strict(
            &signature_message(&unsigned),
            &Signature::from_bytes(&signature),
        )
        .map_err(|_| V5AdmissionResponseErrorV1::InvalidSignature)?;
    let canonical = encode_signed(
        expected,
        &wire.status,
        wire.evidence.clone(),
        wire.signature.clone(),
    )?;
    if payload != canonical {
        return Err(V5AdmissionResponseErrorV1::InvalidPayload);
    }
    match wire.evidence {
        Some(evidence) => Ok(VerifiedV5AdmissionResponseV1::Sealed(decode_evidence(
            evidence, expected,
        )?)),
        None => Ok(VerifiedV5AdmissionResponseV1::ReconciliationRequired),
    }
}

fn encode_unsigned(
    binding: &V5AdmissionResponseRequestBindingV1,
    status: &str,
    evidence: Option<&EvidenceWireV1>,
) -> Result<Vec<u8>, V5AdmissionResponseErrorV1> {
    let status = match status {
        "sealed" => "sealed",
        "reconciliation_required" => "reconciliation_required",
        _ => return Err(V5AdmissionResponseErrorV1::InvalidPayload),
    };
    serde_json::to_vec(&UnsignedResponseWireV1 {
        schema_version: 1,
        protocol: PROTOCOL,
        domain: DOMAIN,
        request_id: binding.request_id.to_string(),
        run_id: binding.run_id.to_string(),
        v5_envelope_digest: &binding.v5_envelope_digest,
        status,
        evidence,
    })
    .map_err(|_| V5AdmissionResponseErrorV1::InvalidPayload)
}

fn encode_signed(
    binding: &V5AdmissionResponseRequestBindingV1,
    status: &str,
    evidence: Option<EvidenceWireV1>,
    signature: String,
) -> Result<Vec<u8>, V5AdmissionResponseErrorV1> {
    serde_json::to_vec(&SignedResponseWireV1 {
        schema_version: 1,
        protocol: PROTOCOL.into(),
        domain: DOMAIN.into(),
        request_id: binding.request_id.to_string(),
        run_id: binding.run_id.to_string(),
        v5_envelope_digest: binding.v5_envelope_digest.clone(),
        status: status.into(),
        evidence,
        signature,
    })
    .map_err(|_| V5AdmissionResponseErrorV1::InvalidPayload)
}

fn validate_and_encode_evidence(
    evidence: &SealedV5DispatchAdmissionEvidence,
    expected: &V5AdmissionResponseRequestBindingV1,
) -> Result<EvidenceWireV1, V5AdmissionResponseErrorV1> {
    if evidence.run_id != expected.run_id
        || evidence.v5_envelope_digest != expected.v5_envelope_digest
        || evidence.idempotency_key.is_empty()
        || evidence.idempotency_key.len() > 1024
        || evidence.idempotency_key.chars().any(char::is_control)
    {
        return Err(V5AdmissionResponseErrorV1::InvalidBinding);
    }
    for digest in [
        &evidence.source_dispatch_event_digest,
        &evidence.admission_event_digest,
        &evidence.v5_envelope_digest,
        &evidence.witness_evidence_digest,
        &evidence.semantic_identity_digest,
        &evidence.checkpoint_event_digest,
    ] {
        if !is_canonical_digest(digest) {
            return Err(V5AdmissionResponseErrorV1::InvalidBinding);
        }
    }
    Ok(EvidenceWireV1 {
        run_id: evidence.run_id.to_string(),
        source_dispatch_event_id: evidence.source_dispatch_event_id.to_string(),
        source_dispatch_event_digest: evidence.source_dispatch_event_digest.clone(),
        admission_event_id: evidence.admission_event_id.to_string(),
        admission_event_digest: evidence.admission_event_digest.clone(),
        v5_envelope_digest: evidence.v5_envelope_digest.clone(),
        witness_evidence_digest: evidence.witness_evidence_digest.clone(),
        semantic_identity_digest: evidence.semantic_identity_digest.clone(),
        idempotency_key: evidence.idempotency_key.clone(),
        checkpoint_event_id: evidence.checkpoint_event_id.to_string(),
        checkpoint_event_digest: evidence.checkpoint_event_digest.clone(),
    })
}

fn decode_evidence(
    wire: EvidenceWireV1,
    expected: &V5AdmissionResponseRequestBindingV1,
) -> Result<SealedV5DispatchAdmissionEvidence, V5AdmissionResponseErrorV1> {
    let evidence = SealedV5DispatchAdmissionEvidence {
        run_id: RunId::from_uuid(parse_uuid(&wire.run_id)?),
        source_dispatch_event_id: EventId::from_uuid(parse_uuid(&wire.source_dispatch_event_id)?),
        source_dispatch_event_digest: wire.source_dispatch_event_digest,
        admission_event_id: EventId::from_uuid(parse_uuid(&wire.admission_event_id)?),
        admission_event_digest: wire.admission_event_digest,
        v5_envelope_digest: wire.v5_envelope_digest,
        witness_evidence_digest: wire.witness_evidence_digest,
        semantic_identity_digest: wire.semantic_identity_digest,
        idempotency_key: wire.idempotency_key,
        checkpoint_event_id: EventId::from_uuid(parse_uuid(&wire.checkpoint_event_id)?),
        checkpoint_event_digest: wire.checkpoint_event_digest,
    };
    validate_and_encode_evidence(&evidence, expected)?;
    Ok(evidence)
}

fn parse_uuid(value: &str) -> Result<Uuid, V5AdmissionResponseErrorV1> {
    let uuid = Uuid::parse_str(value).map_err(|_| V5AdmissionResponseErrorV1::InvalidPayload)?;
    if uuid.hyphenated().to_string() != value {
        return Err(V5AdmissionResponseErrorV1::InvalidPayload);
    }
    Ok(uuid)
}

fn signature_message(unsigned: &[u8]) -> Vec<u8> {
    let mut message = Vec::with_capacity(SIGNATURE_DOMAIN.len() + unsigned.len());
    message.extend_from_slice(SIGNATURE_DOMAIN);
    message.extend_from_slice(unsigned);
    message
}

fn is_canonical_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value.as_bytes()[7..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
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

fn decode_signature(value: &str) -> Result<[u8; 64], V5AdmissionResponseErrorV1> {
    if value.len() != 128
        || !value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(V5AdmissionResponseErrorV1::InvalidSignature);
    }
    let mut bytes = [0_u8; 64];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        bytes[index] = (decode_nibble(pair[0])? << 4) | decode_nibble(pair[1])?;
    }
    Ok(bytes)
}

fn decode_nibble(byte: u8) -> Result<u8, V5AdmissionResponseErrorV1> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        _ => Err(V5AdmissionResponseErrorV1::InvalidSignature),
    }
}
