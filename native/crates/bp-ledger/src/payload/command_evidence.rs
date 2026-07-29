//! Closed CAS documents for governed process-action execution.
//!
//! These documents are evidence, not authority. The protected host may create
//! a canonical input only from a strictly admitted packet, then must bind the
//! executable bytes to a replayed `ActionRequestedV2` before an OCI executor
//! can receive them. Callers must never execute command text merely because it
//! parses as this schema.
//!
//! Exact declaration-ordered JSON bytes are required. This rejects unknown
//! fields, duplicate keys, alternate field order, whitespace variants, and
//! reference/digest substitution before executable material crosses the
//! action boundary.

use crate::error::{LedgerError, Result};
use crate::id::EventId;
use crate::payload::trust_spine::{
    action_requested_v2_digest, ActionKindV1, ActionRequestedV2, ExecutionRoleV1,
};
use crate::storage::cas::CanonicalCasRef;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const CANONICAL_COMMAND_ACTION_INPUT_V1_SCHEMA_VERSION: u32 = 1;
pub const COMMAND_INTENT_EVIDENCE_DOCUMENT_V1_SCHEMA_VERSION: u32 = 1;

pub const MAX_COMMAND_EVIDENCE_DOCUMENT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_COMMAND_BINDING_TEXT_BYTES: usize = 512;
pub const MAX_COMMAND_BYTES: usize = 64 * 1024;
pub const MAX_COMMAND_ARGUMENT_COUNT: usize = 4096;
pub const MAX_COMMAND_ARGUMENT_BYTES: usize = 64 * 1024;
pub const MAX_COMMAND_TOTAL_ARGUMENT_BYTES: usize = 1024 * 1024;
pub const MAX_COMMAND_CWD_BYTES: usize = 64 * 1024;

pub const COMMAND_INPUT_SEMANTIC_V1_DIGEST_DOMAIN: &[u8] =
    b"buildplane.command-input-semantic.v1\0";

/// Exact executable material admitted from a strict governed packet.
///
/// The semantic digest binds the identity and executable fields independently
/// of the raw CAS digest. The raw digest still remains authoritative for exact
/// byte retrieval.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CanonicalCommandActionInputV1 {
    pub schema_version: u32,
    pub run_id: String,
    pub action_id: String,
    pub command: String,
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub command_input_digest: String,
}

/// Complete static identity reconstructed from the signed write-ahead action.
///
/// The action-request digest binds every remaining field of
/// `ActionRequestedV2`, including authority actor and request timestamp, so
/// those values cannot be substituted without changing this binding.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandActionEvidenceBindingV1 {
    pub run_id: String,
    pub workflow_id: String,
    pub unit_id: String,
    pub attempt: u32,
    pub provenance_ref: String,
    pub dispatch_event_ref: EventId,
    pub dispatch_envelope_digest: String,
    pub action_request_event_ref: EventId,
    pub action_request_digest: String,
    pub action_id: String,
    pub idempotency_key: String,
    pub action_kind: ActionKindV1,
    pub canonical_input_ref: String,
    pub canonical_input_digest: String,
    pub repository_binding_digest: String,
    pub ledger_authority_realm_digest: String,
    pub governed_packet_digest: String,
    pub capability_bundle_digest: String,
    pub policy_digest: String,
    pub context_manifest_digest: String,
    pub worker_manifest_digest: String,
    pub sandbox_profile_digest: String,
    pub execution_role: ExecutionRoleV1,
}

/// Host-derived executable evidence bound to one exact replayed action.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandIntentEvidenceDocumentV1 {
    pub schema_version: u32,
    pub binding: CommandActionEvidenceBindingV1,
    pub command: String,
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub command_input_digest: String,
}

/// A canonical input whose bytes and strict CAS descriptor were verified.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedCanonicalCommandActionInputV1 {
    document: CanonicalCommandActionInputV1,
    reference: CanonicalCasRef,
}

impl VerifiedCanonicalCommandActionInputV1 {
    pub fn document(&self) -> &CanonicalCommandActionInputV1 {
        &self.document
    }

    pub fn reference(&self) -> &CanonicalCasRef {
        &self.reference
    }
}

/// Command-intent evidence whose exact bytes and descriptor were verified.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedCommandIntentEvidenceDocumentV1 {
    document: CommandIntentEvidenceDocumentV1,
    reference: CanonicalCasRef,
}

impl VerifiedCommandIntentEvidenceDocumentV1 {
    pub fn document(&self) -> &CommandIntentEvidenceDocumentV1 {
        &self.document
    }

    pub fn reference(&self) -> &CanonicalCasRef {
        &self.reference
    }
}

impl CanonicalCommandActionInputV1 {
    pub fn new(
        run_id: String,
        action_id: String,
        command: String,
        args: Vec<String>,
        cwd: Option<String>,
    ) -> Result<Self> {
        let command_input_digest =
            command_input_semantic_v1_digest(&run_id, &action_id, &command, &args, cwd.as_deref())?;
        let document = Self {
            schema_version: CANONICAL_COMMAND_ACTION_INPUT_V1_SCHEMA_VERSION,
            run_id,
            action_id,
            command,
            args,
            cwd,
            command_input_digest,
        };
        document.validate()?;
        Ok(document)
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != CANONICAL_COMMAND_ACTION_INPUT_V1_SCHEMA_VERSION {
            return Err(unsupported_schema(
                "canonical_command_action_input_v1",
                self.schema_version,
                CANONICAL_COMMAND_ACTION_INPUT_V1_SCHEMA_VERSION,
            ));
        }
        validate_identifier("run_id", &self.run_id)?;
        validate_identifier("action_id", &self.action_id)?;
        validate_executable(&self.command, &self.args, self.cwd.as_deref())?;
        validate_sha256_digest("command_input_digest", &self.command_input_digest)?;
        let expected = command_input_semantic_v1_digest(
            &self.run_id,
            &self.action_id,
            &self.command,
            &self.args,
            self.cwd.as_deref(),
        )?;
        if self.command_input_digest != expected {
            return Err(invalid(
                "canonical_command_action_input_v1",
                "command_input_digest does not match the executable material and identity",
            ));
        }
        Ok(())
    }
}

impl CommandActionEvidenceBindingV1 {
    /// Reconstruct the only acceptable command binding from a replayed signed
    /// process action and the actual parent event references.
    pub fn from_action_requested_v2(
        action: &ActionRequestedV2,
        dispatch_event_ref: EventId,
        action_request_event_ref: EventId,
    ) -> Result<Self> {
        if action.action_kind != ActionKindV1::Process {
            return Err(invalid(
                "command_action_evidence_binding_v1",
                "replayed action request must have action_kind process",
            ));
        }
        if action.execution_role != ExecutionRoleV1::Implementer {
            return Err(invalid(
                "command_action_evidence_binding_v1",
                "process execution requires the implementer role",
            ));
        }
        let governed_packet_digest = action.governed_packet_digest.clone().ok_or_else(|| {
            invalid(
                "command_action_evidence_binding_v1",
                "sealed process actions require governed_packet_digest",
            )
        })?;
        let action_request_digest = action_requested_v2_digest(action).map_err(|error| {
            invalid(
                "command_action_evidence_binding_v1",
                format!("could not canonicalize replayed action request: {error}"),
            )
        })?;
        let binding = Self {
            run_id: action.run_id.clone(),
            workflow_id: action.workflow_id.clone(),
            unit_id: action.unit_id.clone(),
            attempt: action.attempt,
            provenance_ref: action.provenance_ref.clone(),
            dispatch_event_ref,
            dispatch_envelope_digest: action.dispatch_envelope_digest.clone(),
            action_request_event_ref,
            action_request_digest,
            action_id: action.action_id.clone(),
            idempotency_key: action.idempotency_key.clone(),
            action_kind: action.action_kind,
            canonical_input_ref: action.canonical_input_ref.clone(),
            canonical_input_digest: action.canonical_input_digest.clone(),
            repository_binding_digest: action.repository_binding_digest.clone(),
            ledger_authority_realm_digest: action.ledger_authority_realm_digest.clone(),
            governed_packet_digest,
            capability_bundle_digest: action.capability_bundle_digest.clone(),
            policy_digest: action.policy_digest.clone(),
            context_manifest_digest: action.context_manifest_digest.clone(),
            worker_manifest_digest: action.worker_manifest_digest.clone(),
            sandbox_profile_digest: action.sandbox_profile_digest.clone(),
            execution_role: action.execution_role,
        };
        binding.validate()?;
        Ok(binding)
    }

    pub fn verify_against_action_requested_v2(
        &self,
        action: &ActionRequestedV2,
        dispatch_event_ref: EventId,
        action_request_event_ref: EventId,
    ) -> Result<()> {
        self.validate()?;
        let expected =
            Self::from_action_requested_v2(action, dispatch_event_ref, action_request_event_ref)?;
        if self != &expected {
            return Err(invalid(
                "command_action_evidence_binding_v1",
                "binding does not equal the replayed action request and event references",
            ));
        }
        Ok(())
    }

    pub fn validate(&self) -> Result<()> {
        if self.attempt == 0 {
            return Err(invalid(
                "command_action_evidence_binding_v1",
                "attempt must be greater than zero",
            ));
        }
        if self.action_kind != ActionKindV1::Process {
            return Err(invalid(
                "command_action_evidence_binding_v1",
                "action_kind must be process",
            ));
        }
        if self.execution_role != ExecutionRoleV1::Implementer {
            return Err(invalid(
                "command_action_evidence_binding_v1",
                "execution_role must be implementer",
            ));
        }
        for (field, value) in [
            ("run_id", self.run_id.as_str()),
            ("workflow_id", self.workflow_id.as_str()),
            ("unit_id", self.unit_id.as_str()),
            ("provenance_ref", self.provenance_ref.as_str()),
            ("action_id", self.action_id.as_str()),
            ("idempotency_key", self.idempotency_key.as_str()),
        ] {
            validate_identifier(field, value)?;
        }
        for (field, value) in [
            (
                "dispatch_envelope_digest",
                self.dispatch_envelope_digest.as_str(),
            ),
            ("action_request_digest", self.action_request_digest.as_str()),
            (
                "repository_binding_digest",
                self.repository_binding_digest.as_str(),
            ),
            (
                "ledger_authority_realm_digest",
                self.ledger_authority_realm_digest.as_str(),
            ),
            (
                "governed_packet_digest",
                self.governed_packet_digest.as_str(),
            ),
            (
                "capability_bundle_digest",
                self.capability_bundle_digest.as_str(),
            ),
            ("policy_digest", self.policy_digest.as_str()),
            (
                "context_manifest_digest",
                self.context_manifest_digest.as_str(),
            ),
            (
                "worker_manifest_digest",
                self.worker_manifest_digest.as_str(),
            ),
            (
                "sandbox_profile_digest",
                self.sandbox_profile_digest.as_str(),
            ),
        ] {
            validate_sha256_digest(field, value)?;
        }
        validate_raw_cas_descriptor(
            "canonical_input_ref",
            &self.canonical_input_ref,
            "canonical_input_digest",
            &self.canonical_input_digest,
        )?;
        Ok(())
    }
}

impl CommandIntentEvidenceDocumentV1 {
    /// Copy executable material only from verified raw CAS bytes, then bind it
    /// to replayed action identity. Neither caller JSON nor a digest-only
    /// commitment can create this evidence.
    pub fn from_verified_canonical_input(
        binding: CommandActionEvidenceBindingV1,
        input: &VerifiedCanonicalCommandActionInputV1,
    ) -> Result<Self> {
        binding.validate()?;
        verify_binding_matches_verified_input(&binding, input)?;
        let source = input.document();
        let document = Self {
            schema_version: COMMAND_INTENT_EVIDENCE_DOCUMENT_V1_SCHEMA_VERSION,
            binding,
            command: source.command.clone(),
            args: source.args.clone(),
            cwd: source.cwd.clone(),
            command_input_digest: source.command_input_digest.clone(),
        };
        document.validate()?;
        Ok(document)
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != COMMAND_INTENT_EVIDENCE_DOCUMENT_V1_SCHEMA_VERSION {
            return Err(unsupported_schema(
                "command_intent_evidence_document_v1",
                self.schema_version,
                COMMAND_INTENT_EVIDENCE_DOCUMENT_V1_SCHEMA_VERSION,
            ));
        }
        self.binding.validate()?;
        validate_executable(&self.command, &self.args, self.cwd.as_deref())?;
        validate_sha256_digest("command_input_digest", &self.command_input_digest)?;
        let expected = command_input_semantic_v1_digest(
            &self.binding.run_id,
            &self.binding.action_id,
            &self.command,
            &self.args,
            self.cwd.as_deref(),
        )?;
        if self.command_input_digest != expected {
            return Err(invalid(
                "command_intent_evidence_document_v1",
                "command_input_digest does not match the bound executable material",
            ));
        }
        Ok(())
    }
}

pub fn command_input_semantic_v1_digest(
    run_id: &str,
    action_id: &str,
    command: &str,
    args: &[String],
    cwd: Option<&str>,
) -> Result<String> {
    #[derive(Serialize)]
    struct Material<'a> {
        schema_version: u32,
        run_id: &'a str,
        action_id: &'a str,
        command: &'a str,
        args: &'a [String],
        #[serde(skip_serializing_if = "Option::is_none")]
        cwd: Option<&'a str>,
    }
    validate_identifier("run_id", run_id)?;
    validate_identifier("action_id", action_id)?;
    validate_executable(command, args, cwd)?;
    let material = Material {
        schema_version: CANONICAL_COMMAND_ACTION_INPUT_V1_SCHEMA_VERSION,
        run_id,
        action_id,
        command,
        args,
        cwd,
    };
    let bytes = serde_json::to_vec(&material)?;
    let mut hasher = Sha256::new();
    hasher.update(COMMAND_INPUT_SEMANTIC_V1_DIGEST_DOMAIN);
    hasher.update(bytes);
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

pub fn canonical_command_action_input_v1_bytes(
    document: &CanonicalCommandActionInputV1,
) -> Result<Vec<u8>> {
    document.validate()?;
    canonical_document_bytes(document, "canonical_command_action_input_v1")
}

pub fn command_intent_evidence_document_v1_bytes(
    document: &CommandIntentEvidenceDocumentV1,
) -> Result<Vec<u8>> {
    document.validate()?;
    canonical_document_bytes(document, "command_intent_evidence_document_v1")
}

pub fn parse_verified_canonical_command_action_input_v1(
    bytes: &[u8],
    cas_ref: &str,
    digest: &str,
) -> Result<VerifiedCanonicalCommandActionInputV1> {
    let reference =
        verify_raw_cas_bytes("canonical_command_action_input_v1", bytes, cas_ref, digest)?;
    let document: CanonicalCommandActionInputV1 = serde_json::from_slice(bytes)?;
    let canonical = canonical_command_action_input_v1_bytes(&document)?;
    ensure_exact_canonical_bytes("canonical_command_action_input_v1", bytes, &canonical)?;
    Ok(VerifiedCanonicalCommandActionInputV1 {
        document,
        reference,
    })
}

pub fn parse_verified_command_intent_evidence_document_v1(
    bytes: &[u8],
    cas_ref: &str,
    digest: &str,
) -> Result<VerifiedCommandIntentEvidenceDocumentV1> {
    let reference = verify_raw_cas_bytes(
        "command_intent_evidence_document_v1",
        bytes,
        cas_ref,
        digest,
    )?;
    let document: CommandIntentEvidenceDocumentV1 = serde_json::from_slice(bytes)?;
    let canonical = command_intent_evidence_document_v1_bytes(&document)?;
    ensure_exact_canonical_bytes("command_intent_evidence_document_v1", bytes, &canonical)?;
    Ok(VerifiedCommandIntentEvidenceDocumentV1 {
        document,
        reference,
    })
}

fn verify_binding_matches_verified_input(
    binding: &CommandActionEvidenceBindingV1,
    input: &VerifiedCanonicalCommandActionInputV1,
) -> Result<()> {
    if binding.canonical_input_ref != input.reference().to_cas_ref()
        || binding.canonical_input_digest != input.reference().digest()
    {
        return Err(invalid(
            "command_intent_evidence_document_v1",
            "binding canonical input descriptor does not name the verified input bytes",
        ));
    }
    if binding.run_id != input.document().run_id || binding.action_id != input.document().action_id
    {
        return Err(invalid(
            "command_intent_evidence_document_v1",
            "binding identity does not match the verified command input",
        ));
    }
    Ok(())
}

fn validate_executable(command: &str, args: &[String], cwd: Option<&str>) -> Result<()> {
    validate_command_content("command", command, MAX_COMMAND_BYTES, false)?;
    if args.len() > MAX_COMMAND_ARGUMENT_COUNT {
        return Err(invalid(
            "command_evidence_v1",
            format!("args exceeds maximum of {MAX_COMMAND_ARGUMENT_COUNT} ordered arguments"),
        ));
    }
    let mut total = 0usize;
    for argument in args {
        validate_command_content("args", argument, MAX_COMMAND_ARGUMENT_BYTES, true)?;
        total = total.checked_add(argument.len()).ok_or_else(|| {
            invalid(
                "command_evidence_v1",
                "aggregate argument byte length overflowed",
            )
        })?;
        if total > MAX_COMMAND_TOTAL_ARGUMENT_BYTES {
            return Err(invalid(
                "command_evidence_v1",
                format!(
                    "args exceeds maximum aggregate size of {MAX_COMMAND_TOTAL_ARGUMENT_BYTES} bytes"
                ),
            ));
        }
    }
    if let Some(cwd) = cwd {
        validate_command_content("cwd", cwd, MAX_COMMAND_CWD_BYTES, true)?;
    }
    Ok(())
}

fn validate_identifier(field: &str, value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > MAX_COMMAND_BINDING_TEXT_BYTES
        || value.trim() != value
        || value.contains('\0')
        || value.contains(['\r', '\n'])
    {
        return Err(invalid(
            "command_evidence_v1",
            format!(
                "{field} must be non-empty, bounded, trimmed, and contain no NUL or newline bytes"
            ),
        ));
    }
    Ok(())
}

fn validate_command_content(
    field: &str,
    value: &str,
    max_bytes: usize,
    allow_empty: bool,
) -> Result<()> {
    if (!allow_empty && value.trim().is_empty())
        || value.len() > max_bytes
        || value.contains('\0')
        || value.contains(['\r', '\n'])
    {
        return Err(invalid(
            "command_evidence_v1",
            format!("{field} must be bounded and contain no NUL or newline bytes"),
        ));
    }
    Ok(())
}

fn validate_sha256_digest(field: &str, value: &str) -> Result<()> {
    CanonicalCasRef::from_digest(value.to_string()).map_err(|_| {
        invalid(
            "command_evidence_v1",
            format!("{field} must be sha256:<64 lowercase hex>"),
        )
    })?;
    Ok(())
}

fn validate_raw_cas_descriptor(
    reference_field: &str,
    cas_ref: &str,
    digest_field: &str,
    digest: &str,
) -> Result<CanonicalCasRef> {
    let reference = CanonicalCasRef::parse(cas_ref).map_err(|_| {
        invalid(
            "command_evidence_v1",
            format!("{reference_field} must be cas:sha256:<64 lowercase hex>"),
        )
    })?;
    let expected = CanonicalCasRef::from_digest(digest.to_string()).map_err(|_| {
        invalid(
            "command_evidence_v1",
            format!("{digest_field} must be sha256:<64 lowercase hex>"),
        )
    })?;
    if reference.digest() != expected.digest() {
        return Err(invalid(
            "command_evidence_v1",
            format!("{reference_field} must name the exact raw digest in {digest_field}"),
        ));
    }
    Ok(reference)
}

fn verify_raw_cas_bytes(
    kind: &str,
    bytes: &[u8],
    cas_ref: &str,
    digest: &str,
) -> Result<CanonicalCasRef> {
    if bytes.len() > MAX_COMMAND_EVIDENCE_DOCUMENT_BYTES {
        return Err(invalid(
            kind,
            format!("document exceeds maximum of {MAX_COMMAND_EVIDENCE_DOCUMENT_BYTES} raw bytes"),
        ));
    }
    let reference = validate_raw_cas_descriptor("cas_ref", cas_ref, "digest", digest)?;
    if raw_sha256_digest(bytes) != reference.digest() {
        return Err(invalid(
            kind,
            "raw document bytes do not match the strict CAS descriptor digest",
        ));
    }
    Ok(reference)
}

fn canonical_document_bytes<T: Serialize>(document: &T, kind: &str) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(document)?;
    if bytes.len() > MAX_COMMAND_EVIDENCE_DOCUMENT_BYTES {
        return Err(invalid(
            kind,
            format!(
                "canonical document exceeds maximum of {MAX_COMMAND_EVIDENCE_DOCUMENT_BYTES} bytes"
            ),
        ));
    }
    Ok(bytes)
}

fn ensure_exact_canonical_bytes(kind: &str, supplied: &[u8], canonical: &[u8]) -> Result<()> {
    if supplied != canonical {
        return Err(invalid(
            kind,
            "document bytes are not the exact declaration-ordered canonical encoding",
        ));
    }
    Ok(())
}

fn raw_sha256_digest(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
}

fn unsupported_schema(kind: &str, received: u32, supported: u32) -> LedgerError {
    LedgerError::InvalidPayload {
        kind: kind.to_string(),
        reason: format!("schema_version {received} is not supported (expected {supported})"),
    }
}

fn invalid(kind: &str, reason: impl Into<String>) -> LedgerError {
    LedgerError::InvalidPayload {
        kind: kind.to_string(),
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::cas::Cas;
    use std::fs;
    use tempfile::tempdir;

    const DIGEST: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn canonical_input() -> CanonicalCommandActionInputV1 {
        CanonicalCommandActionInputV1::new(
            "run-1".into(),
            "action-1".into(),
            "/usr/bin/git".into(),
            vec!["status".into(), "--short".into()],
            Some("workspace".into()),
        )
        .unwrap()
    }

    fn action(input_ref: &CanonicalCasRef) -> ActionRequestedV2 {
        ActionRequestedV2 {
            run_id: "run-1".into(),
            workflow_id: "workflow-1".into(),
            unit_id: "unit-1".into(),
            attempt: 1,
            provenance_ref: "provenance-1".into(),
            action_id: "action-1".into(),
            idempotency_key: "idempotency-1".into(),
            action_kind: ActionKindV1::Process,
            canonical_input_digest: input_ref.digest().into(),
            canonical_input_ref: input_ref.to_cas_ref(),
            dispatch_envelope_digest: DIGEST.into(),
            repository_binding_digest: DIGEST.into(),
            ledger_authority_realm_digest: DIGEST.into(),
            governed_packet_digest: Some(DIGEST.into()),
            capability_bundle_digest: DIGEST.into(),
            policy_digest: DIGEST.into(),
            context_manifest_digest: DIGEST.into(),
            worker_manifest_digest: DIGEST.into(),
            sandbox_profile_digest: DIGEST.into(),
            authority_actor: "broker-1".into(),
            execution_role: ExecutionRoleV1::Implementer,
            requested_at: "2026-07-26T12:00:00Z".into(),
        }
    }

    fn stored_input() -> (
        tempfile::TempDir,
        Vec<u8>,
        CanonicalCasRef,
        VerifiedCanonicalCommandActionInputV1,
    ) {
        let directory = tempdir().unwrap();
        let cas = Cas::open(directory.path()).unwrap();
        let bytes = canonical_command_action_input_v1_bytes(&canonical_input()).unwrap();
        let reference = cas.put_canonical_bytes(&bytes).unwrap();
        let loaded = cas
            .get_verified_canonical_bytes(&reference.to_cas_ref(), reference.digest())
            .unwrap();
        let verified = parse_verified_canonical_command_action_input_v1(
            &loaded,
            &reference.to_cas_ref(),
            reference.digest(),
        )
        .unwrap();
        (directory, bytes, reference, verified)
    }

    #[test]
    fn canonical_input_and_replayed_binding_produce_closed_intent() {
        let (_directory, _bytes, reference, verified) = stored_input();
        let dispatch_ref = EventId::new();
        let action_ref = EventId::new();
        let request = action(&reference);
        let binding = CommandActionEvidenceBindingV1::from_action_requested_v2(
            &request,
            dispatch_ref,
            action_ref,
        )
        .unwrap();
        let intent =
            CommandIntentEvidenceDocumentV1::from_verified_canonical_input(binding, &verified)
                .unwrap();
        let intent_bytes = command_intent_evidence_document_v1_bytes(&intent).unwrap();
        let intent_digest = raw_sha256_digest(&intent_bytes);
        let parsed = parse_verified_command_intent_evidence_document_v1(
            &intent_bytes,
            &format!("cas:{intent_digest}"),
            &intent_digest,
        )
        .unwrap();

        assert_eq!(parsed.document(), &intent);
        assert_eq!(parsed.document().command, "/usr/bin/git");
        assert_eq!(parsed.document().args, ["status", "--short"]);
        parsed
            .document()
            .binding
            .verify_against_action_requested_v2(&request, dispatch_ref, action_ref)
            .unwrap();
    }

    #[test]
    fn parser_rejects_unknown_fields_and_noncanonical_bytes() {
        let (_directory, bytes, reference, _verified) = stored_input();
        let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("ambient_shell".into(), serde_json::Value::Bool(true));
        let forged = serde_json::to_vec(&value).unwrap();
        let forged_digest = raw_sha256_digest(&forged);
        assert!(parse_verified_canonical_command_action_input_v1(
            &forged,
            &format!("cas:{forged_digest}"),
            &forged_digest,
        )
        .is_err());

        let spaced = format!(" {}\n", String::from_utf8(bytes).unwrap()).into_bytes();
        let spaced_digest = raw_sha256_digest(&spaced);
        assert!(parse_verified_canonical_command_action_input_v1(
            &spaced,
            &format!("cas:{spaced_digest}"),
            &spaced_digest,
        )
        .is_err());
        assert_ne!(reference.digest(), spaced_digest);
    }

    #[test]
    fn parser_rejects_reference_digest_and_byte_substitution() {
        let (_directory, bytes, reference, _verified) = stored_input();
        let other = format!("sha256:{}", "b".repeat(64));
        assert!(parse_verified_canonical_command_action_input_v1(
            &bytes,
            &format!("cas:{other}"),
            &other,
        )
        .is_err());
        assert!(parse_verified_canonical_command_action_input_v1(
            &bytes,
            &reference.to_cas_ref(),
            &other,
        )
        .is_err());
    }

    #[test]
    fn semantic_mutation_and_binding_substitution_fail_closed() {
        let (_directory, _bytes, reference, verified) = stored_input();
        let mut input = canonical_input();
        input.command = "/bin/sh".into();
        assert!(canonical_command_action_input_v1_bytes(&input).is_err());

        let mut request = action(&reference);
        request.run_id = "other-run".into();
        let binding = CommandActionEvidenceBindingV1::from_action_requested_v2(
            &request,
            EventId::new(),
            EventId::new(),
        )
        .unwrap();
        assert!(
            CommandIntentEvidenceDocumentV1::from_verified_canonical_input(binding, &verified)
                .is_err()
        );
    }

    #[test]
    fn command_input_never_accepts_newlines_or_unbounded_arguments() {
        assert!(CanonicalCommandActionInputV1::new(
            "run-1".into(),
            "action-1".into(),
            "git\nstatus".into(),
            vec![],
            None,
        )
        .is_err());
        assert!(CanonicalCommandActionInputV1::new(
            "run-1".into(),
            "action-1".into(),
            "git".into(),
            vec!["x".repeat(MAX_COMMAND_ARGUMENT_BYTES + 1)],
            None,
        )
        .is_err());
    }

    #[test]
    fn cas_corruption_is_rejected_before_parsing() {
        let (directory, bytes, reference, _verified) = stored_input();
        let cas = Cas::open(directory.path()).unwrap();
        let hex = reference.digest().strip_prefix("sha256:").unwrap();
        let object_path = directory.path().join(&hex[..2]).join(&hex[2..]);
        fs::write(object_path, b"{}").unwrap();
        assert!(cas
            .get_verified_canonical_bytes(&reference.to_cas_ref(), reference.digest())
            .is_err());
        assert_ne!(bytes, b"{}");
    }
}
