//! Closed CAS documents for native model-action authorization.
//!
//! These are **not** tape payloads and they do not issue authority. A future
//! protected issuer must load the strict raw-CAS bytes named by a replayed
//! `ActionRequestedV2`, parse them with the `parse_verified_*` functions in
//! this module, and construct the two evidence documents from replayed state.
//! In particular, it must never accept a worker-supplied model or trust-scope
//! proposal as an authority input.
//!
//! Every document has a closed schema, canonical bytes, a raw SHA-256 CAS
//! address, and bounded fields. Requiring the original bytes to equal the
//! declaration-ordered `serde_json` encoding rejects whitespace, duplicate
//! keys, alternate field orders, and unknown fields before an issuer can use
//! the document as evidence.

use crate::error::{LedgerError, Result};
use crate::id::EventId;
use crate::payload::trust_spine::{
    action_requested_v2_digest, dispatch_envelope_v3_body_digest,
    governed_dispatch_policy_digest_v1, ActionEvidenceVersionV1, ActionKindV1, ActionRequestedV2,
    CommitModeV1, DispatchEnvelopeV3, ExecutionRoleV1, ModelRequestEvidenceV1,
    TrustScopeEvidenceV1, TrustTierV1, MODEL_REQUEST_EVIDENCE_V1_SCHEMA_VERSION,
    TRUST_SCOPE_EVIDENCE_V1_SCHEMA_VERSION,
};
use crate::storage::cas::CanonicalCasRef;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Maximum accepted raw JSON document size. This is deliberately below a
/// typical provider request cap so parsing evidence never becomes an
/// unbounded allocation path in the issuer.
pub const MAX_MODEL_EVIDENCE_DOCUMENT_BYTES: usize = 256 * 1024;
/// Maximum bytes in the rendered user prompt carried by the canonical input.
pub const MAX_NORMALIZED_PROMPT_BYTES: usize = 128 * 1024;
/// Maximum bytes in a rendered system instruction.
pub const MAX_NORMALIZED_SYSTEM_PROMPT_BYTES: usize = 64 * 1024;
/// Maximum bytes in an opaque binding identifier or reference.
pub const MAX_BINDING_TEXT_BYTES: usize = 512;
/// Maximum bytes in a provider model identifier.
pub const MAX_MODEL_IDENTIFIER_BYTES: usize = 256;
/// Maximum declared typed capabilities per model request.
pub const MAX_MODEL_TOOL_CAPABILITIES: usize = 64;
/// Maximum redaction commitments per model request.
pub const MAX_MODEL_REDACTION_COMMITMENTS: usize = 64;
/// Maximum bytes in a redaction field or capability identifier.
pub const MAX_COMMITMENT_IDENTIFIER_BYTES: usize = 256;
/// Maximum bytes in a redaction reason.
pub const MAX_REDACTION_REASON_BYTES: usize = 2 * 1024;

/// Domain separator for the semantic provider-request digest. The raw CAS
/// digest proves exact document bytes; this digest proves the normalized
/// request and ordered commitments an issuer must compare before signing.
pub const MODEL_REQUEST_SEMANTIC_V1_DIGEST_DOMAIN: &[u8] =
    b"buildplane.model-request-semantic.v1\0";

/// Explicit schema revision of [`CanonicalModelActionInputV1`].
pub const CANONICAL_MODEL_ACTION_INPUT_V1_SCHEMA_VERSION: u32 = 1;
/// The CAS document schema agrees with the descriptor schema carried by
/// `ModelActionIntentV1`.
pub const MODEL_REQUEST_EVIDENCE_DOCUMENT_V1_SCHEMA_VERSION: u32 =
    MODEL_REQUEST_EVIDENCE_V1_SCHEMA_VERSION;
/// The CAS document schema agrees with the descriptor schema carried by
/// `ModelActionIntentV1`.
pub const TRUST_SCOPE_EVIDENCE_DOCUMENT_V1_SCHEMA_VERSION: u32 =
    TRUST_SCOPE_EVIDENCE_V1_SCHEMA_VERSION;

/// Only the API/SDK providers admitted by the governed worker lane.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelProviderV1 {
    Anthropic,
    Openai,
}

/// A typed capability the model may propose. The provider worker itself never
/// executes one: a later, separately authorized gateway action is required.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelToolCapabilityKindV1 {
    Mcp,
    A2a,
    ExternalService,
}

/// Credential-free, provider-neutral request shape. The provider adapter is
/// intentionally restricted to this fixed vocabulary in the governed lane;
/// arbitrary provider JSON, credentials, environment, and sampling knobs are
/// excluded rather than passed through as opaque values.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CredentialFreeNormalizedModelRequestV1 {
    pub provider: ModelProviderV1,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    pub prompt: String,
    /// Digest of the closed response schema the host must enforce.
    pub response_schema_digest: String,
}

/// One ordered typed capability commitment. The order is canonicalized by the
/// strict `capability_id` ordering check, which removes a hidden semantic
/// channel from otherwise equivalent provider requests.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelToolCapabilityCommitmentV1 {
    pub capability_id: String,
    pub kind: ModelToolCapabilityKindV1,
    pub input_schema_digest: String,
    pub output_schema_digest: String,
}

/// One ordered commitment describing content intentionally excluded or
/// transformed before it becomes durable evidence. The optional digest lets a
/// protected store prove the redacted source without exposing it to replay.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelRedactionCommitmentV1 {
    pub field: String,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redacted_digest: Option<String>,
}

/// The original strict raw-CAS input for a model action. Its raw digest/ref is
/// copied into `ActionRequestedV2`; a protected issuer later loads and parses
/// this exact document before it derives any model-action intent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CanonicalModelActionInputV1 {
    pub schema_version: u32,
    pub normalized_provider_request: CredentialFreeNormalizedModelRequestV1,
    pub tool_capabilities: Vec<ModelToolCapabilityCommitmentV1>,
    pub redaction_commitments: Vec<ModelRedactionCommitmentV1>,
    /// Domain-separated digest of the normalized request plus every ordered
    /// capability/redaction commitment.
    pub model_request_digest: String,
}

/// Replayed identity that the native issuer copies into the two evidence
/// documents. It contains the complete static `ActionRequestedV2` authority
/// surface as well as both event references and canonical event digest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelActionEvidenceBindingV1 {
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

/// Canonical, closed evidence constructed only after a verified raw canonical
/// model input is read. This is the object later described by
/// [`ModelRequestEvidenceV1`] in a `ModelActionIntentV1`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelRequestEvidenceDocumentV1 {
    pub schema_version: u32,
    pub binding: ModelActionEvidenceBindingV1,
    pub normalized_provider_request: CredentialFreeNormalizedModelRequestV1,
    pub tool_capabilities: Vec<ModelToolCapabilityCommitmentV1>,
    pub redaction_commitments: Vec<ModelRedactionCommitmentV1>,
    pub model_request_digest: String,
}

/// The only filesystem surface a governed API model worker may observe.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelFilesystemAccessV1 {
    None,
    CandidateReadOnly,
}

/// Process, ambient secret, and worker-network permissions are closed to this
/// one vocabulary. Any expansion must use a new evidence schema revision.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelDeniedWorkerAccessV1 {
    None,
}

/// Provider network access is host-brokered and never ambient worker egress.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelBrokeredNetworkAccessV1 {
    ProviderOnly,
}

/// Exact constraints derived from the signed execution role and model tool
/// commitments. Callers should use [`derive_model_action_scope_constraints_v1`]
/// instead of constructing this object from worker-provided settings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelActionScopeConstraintsV1 {
    pub review_only: bool,
    pub filesystem_access: ModelFilesystemAccessV1,
    pub process_access: ModelDeniedWorkerAccessV1,
    pub worker_secret_access: ModelDeniedWorkerAccessV1,
    pub worker_network_access: ModelDeniedWorkerAccessV1,
    pub brokered_model_network: ModelBrokeredNetworkAccessV1,
    pub tool_capabilities: Vec<String>,
}

/// Closed trust-scope evidence. Its hard-coded selector values make this
/// schema useful only for governed, atomic, sealed-v3 model actions; raw,
/// incremental, saga, and older evidence protocols cannot be reinterpreted as
/// V1 trust scope evidence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrustScopeEvidenceDocumentV1 {
    pub schema_version: u32,
    pub binding: ModelActionEvidenceBindingV1,
    pub model_request_evidence: ModelRequestEvidenceV1,
    pub acceptance_contract_digest: String,
    pub trust_tier: TrustTierV1,
    pub commit_mode: CommitModeV1,
    pub action_evidence_version: ActionEvidenceVersionV1,
    pub constraints: ModelActionScopeConstraintsV1,
}

/// A verified canonical input preserves the strict raw CAS identity alongside
/// the parsed document. Passing this wrapper to constructors prevents an
/// issuer from accidentally comparing model evidence to the right semantics
/// but the wrong action-input object.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedCanonicalModelActionInputV1 {
    document: CanonicalModelActionInputV1,
    reference: CanonicalCasRef,
}

/// A verified model-request document and its strict descriptor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedModelRequestEvidenceDocumentV1 {
    document: ModelRequestEvidenceDocumentV1,
    reference: CanonicalCasRef,
}

/// A verified trust-scope document and its strict descriptor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedTrustScopeEvidenceDocumentV1 {
    document: TrustScopeEvidenceDocumentV1,
    reference: CanonicalCasRef,
}

impl CanonicalModelActionInputV1 {
    /// Construct a canonical input and derive its semantic request digest.
    pub fn new(
        normalized_provider_request: CredentialFreeNormalizedModelRequestV1,
        tool_capabilities: Vec<ModelToolCapabilityCommitmentV1>,
        redaction_commitments: Vec<ModelRedactionCommitmentV1>,
    ) -> Result<Self> {
        let model_request_digest = model_request_semantic_v1_digest(
            &normalized_provider_request,
            &tool_capabilities,
            &redaction_commitments,
        )?;
        let document = Self {
            schema_version: CANONICAL_MODEL_ACTION_INPUT_V1_SCHEMA_VERSION,
            normalized_provider_request,
            tool_capabilities,
            redaction_commitments,
            model_request_digest,
        };
        document.validate()?;
        Ok(document)
    }

    /// Validate structural and semantic invariants before bytes are stored.
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != CANONICAL_MODEL_ACTION_INPUT_V1_SCHEMA_VERSION {
            return Err(unsupported_schema(
                "canonical_model_action_input_v1",
                self.schema_version,
                CANONICAL_MODEL_ACTION_INPUT_V1_SCHEMA_VERSION,
            ));
        }
        let expected = model_request_semantic_v1_digest(
            &self.normalized_provider_request,
            &self.tool_capabilities,
            &self.redaction_commitments,
        )?;
        validate_sha256_digest("model_request_digest", &self.model_request_digest)?;
        if self.model_request_digest != expected {
            return Err(invalid(
                "canonical_model_action_input_v1",
                "model_request_digest does not match the normalized provider request and ordered commitments",
            ));
        }
        Ok(())
    }
}

impl ModelActionEvidenceBindingV1 {
    /// Construct the binding from the replayed write-ahead model action. The
    /// action digest is recomputed locally, so the future issuer never accepts
    /// a caller-provided semantic digest for the action record.
    pub fn from_action_requested_v2(
        action: &ActionRequestedV2,
        dispatch_event_ref: EventId,
        action_request_event_ref: EventId,
    ) -> Result<Self> {
        let action_request_digest = action_requested_v2_digest(action).map_err(|error| {
            invalid(
                "model_action_evidence_binding_v1",
                format!("could not canonicalize replayed action request: {error}"),
            )
        })?;
        if action.action_kind != ActionKindV1::Model {
            return Err(invalid(
                "model_action_evidence_binding_v1",
                "replayed action request must have action_kind model",
            ));
        }
        let governed_packet_digest = action.governed_packet_digest.clone().ok_or_else(|| {
            invalid(
                "model_action_evidence_binding_v1",
                "sealed-v3 model actions require governed_packet_digest",
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

    /// Verify that a parsed binding is exactly the one reconstructed from the
    /// replayed action event and its actual parent references.
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
                "model_action_evidence_binding_v1",
                "binding does not equal the replayed action request and event references",
            ));
        }
        Ok(())
    }

    /// Validate local shape without claiming that the fields came from a
    /// signed tape. That provenance is supplied only by
    /// [`Self::verify_against_action_requested_v2`].
    pub fn validate(&self) -> Result<()> {
        if self.attempt == 0 {
            return Err(invalid(
                "model_action_evidence_binding_v1",
                "attempt must be greater than zero",
            ));
        }
        if self.action_kind != ActionKindV1::Model {
            return Err(invalid(
                "model_action_evidence_binding_v1",
                "action_kind must be model",
            ));
        }
        if self.execution_role == ExecutionRoleV1::Candidate {
            return Err(invalid(
                "model_action_evidence_binding_v1",
                "candidate is not an API worker execution role",
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
            validate_binding_text(field, value)?;
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

impl ModelRequestEvidenceDocumentV1 {
    /// Build model-request evidence solely from a verified raw input and a
    /// binding reconstructed from the replayed action record.
    pub fn from_verified_canonical_input(
        binding: ModelActionEvidenceBindingV1,
        input: &VerifiedCanonicalModelActionInputV1,
    ) -> Result<Self> {
        binding.validate()?;
        verify_binding_matches_verified_input(&binding, input)?;
        let input_document = input.document();
        let document = Self {
            schema_version: MODEL_REQUEST_EVIDENCE_DOCUMENT_V1_SCHEMA_VERSION,
            binding,
            normalized_provider_request: input_document.normalized_provider_request.clone(),
            tool_capabilities: input_document.tool_capabilities.clone(),
            redaction_commitments: input_document.redaction_commitments.clone(),
            model_request_digest: input_document.model_request_digest.clone(),
        };
        document.validate()?;
        Ok(document)
    }

    /// Validate document-local structure and semantic request digest.
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != MODEL_REQUEST_EVIDENCE_DOCUMENT_V1_SCHEMA_VERSION {
            return Err(unsupported_schema(
                "model_request_evidence_document_v1",
                self.schema_version,
                MODEL_REQUEST_EVIDENCE_DOCUMENT_V1_SCHEMA_VERSION,
            ));
        }
        self.binding.validate()?;
        let expected = model_request_semantic_v1_digest(
            &self.normalized_provider_request,
            &self.tool_capabilities,
            &self.redaction_commitments,
        )?;
        validate_sha256_digest("model_request_digest", &self.model_request_digest)?;
        if self.model_request_digest != expected {
            return Err(invalid(
                "model_request_evidence_document_v1",
                "model_request_digest does not match the normalized provider request and ordered commitments",
            ));
        }
        Ok(())
    }
}

impl ModelActionScopeConstraintsV1 {
    /// Check that fixed worker denials and role-derived filesystem behavior are
    /// preserved. The capability list is checked against the model request by
    /// [`verify_trust_scope_evidence_matches_model_request`].
    pub fn validate_for_role(&self, role: ExecutionRoleV1) -> Result<()> {
        validate_ordered_identifier_list("constraints.tool_capabilities", &self.tool_capabilities)?;
        if self.process_access != ModelDeniedWorkerAccessV1::None
            || self.worker_secret_access != ModelDeniedWorkerAccessV1::None
            || self.worker_network_access != ModelDeniedWorkerAccessV1::None
            || self.brokered_model_network != ModelBrokeredNetworkAccessV1::ProviderOnly
        {
            return Err(invalid(
                "model_action_scope_constraints_v1",
                "governed model workers require no process, ambient secret, or worker network access and provider-only brokered network access",
            ));
        }
        let (review_only, filesystem_access) = role_constraints(role)?;
        if self.review_only != review_only || self.filesystem_access != filesystem_access {
            return Err(invalid(
                "model_action_scope_constraints_v1",
                "review_only and filesystem_access do not match the signed execution role",
            ));
        }
        Ok(())
    }
}

impl TrustScopeEvidenceDocumentV1 {
    /// Construct the only V1 trust-scope selector set: governed + atomic +
    /// sealed-v3. The model evidence descriptor is derived from verified bytes
    /// rather than supplied by a worker.
    pub fn from_verified_model_request_evidence(
        model_request: &VerifiedModelRequestEvidenceDocumentV1,
        acceptance_contract_digest: String,
        constraints: ModelActionScopeConstraintsV1,
    ) -> Result<Self> {
        let document = Self {
            schema_version: TRUST_SCOPE_EVIDENCE_DOCUMENT_V1_SCHEMA_VERSION,
            binding: model_request.document().binding.clone(),
            model_request_evidence: model_request.descriptor(),
            acceptance_contract_digest,
            trust_tier: TrustTierV1::Governed,
            commit_mode: CommitModeV1::Atomic,
            action_evidence_version: ActionEvidenceVersionV1::SealedV3,
            constraints,
        };
        document.validate()?;
        verify_trust_scope_evidence_matches_model_request(&document, model_request)?;
        Ok(document)
    }

    /// Validate document-local closed selectors. Cross-document equality is
    /// intentionally separate because it requires the verified model evidence
    /// object held by the protected issuer.
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != TRUST_SCOPE_EVIDENCE_DOCUMENT_V1_SCHEMA_VERSION {
            return Err(unsupported_schema(
                "trust_scope_evidence_document_v1",
                self.schema_version,
                TRUST_SCOPE_EVIDENCE_DOCUMENT_V1_SCHEMA_VERSION,
            ));
        }
        self.binding.validate()?;
        validate_model_request_evidence_descriptor(&self.model_request_evidence)?;
        validate_sha256_digest(
            "acceptance_contract_digest",
            &self.acceptance_contract_digest,
        )?;
        if self.trust_tier != TrustTierV1::Governed
            || self.commit_mode != CommitModeV1::Atomic
            || self.action_evidence_version != ActionEvidenceVersionV1::SealedV3
        {
            return Err(invalid(
                "trust_scope_evidence_document_v1",
                "V1 trust scope requires governed trust tier, atomic commit mode, and sealed_v3 action evidence",
            ));
        }
        self.constraints
            .validate_for_role(self.binding.execution_role)?;
        Ok(())
    }
}

impl VerifiedCanonicalModelActionInputV1 {
    /// Parsed canonical input document.
    pub fn document(&self) -> &CanonicalModelActionInputV1 {
        &self.document
    }

    /// Strict raw-CAS reference reconstructed from the verified descriptor.
    pub fn reference(&self) -> &CanonicalCasRef {
        &self.reference
    }

    /// Canonical external CAS reference for the exact input bytes.
    pub fn cas_ref(&self) -> String {
        self.reference.to_cas_ref()
    }

    /// Raw SHA-256 digest of the exact canonical input bytes.
    pub fn digest(&self) -> &str {
        self.reference.digest()
    }
}

impl VerifiedModelRequestEvidenceDocumentV1 {
    /// Parsed model-request evidence document.
    pub fn document(&self) -> &ModelRequestEvidenceDocumentV1 {
        &self.document
    }

    /// Strict raw-CAS reference reconstructed from the verified descriptor.
    pub fn reference(&self) -> &CanonicalCasRef {
        &self.reference
    }

    /// Descriptor to embed in a `ModelActionIntentV1` or trust-scope document.
    pub fn descriptor(&self) -> ModelRequestEvidenceV1 {
        model_request_evidence_v1_descriptor(&self.reference)
    }
}

impl VerifiedTrustScopeEvidenceDocumentV1 {
    /// Parsed trust-scope evidence document.
    pub fn document(&self) -> &TrustScopeEvidenceDocumentV1 {
        &self.document
    }

    /// Strict raw-CAS reference reconstructed from the verified descriptor.
    pub fn reference(&self) -> &CanonicalCasRef {
        &self.reference
    }

    /// Descriptor to embed in a `ModelActionIntentV1`.
    pub fn descriptor(&self) -> TrustScopeEvidenceV1 {
        trust_scope_evidence_v1_descriptor(&self.reference)
    }
}

/// Derive the only constraints a V1 governed API model worker may receive.
/// `Candidate` is intentionally denied because it is not a provider-worker
/// role; an unknown future role cannot silently inherit implementer access.
pub fn derive_model_action_scope_constraints_v1(
    execution_role: ExecutionRoleV1,
    capabilities: &[ModelToolCapabilityCommitmentV1],
) -> Result<ModelActionScopeConstraintsV1> {
    validate_tool_capabilities(capabilities)?;
    let (review_only, filesystem_access) = role_constraints(execution_role)?;
    let constraints = ModelActionScopeConstraintsV1 {
        review_only,
        filesystem_access,
        process_access: ModelDeniedWorkerAccessV1::None,
        worker_secret_access: ModelDeniedWorkerAccessV1::None,
        worker_network_access: ModelDeniedWorkerAccessV1::None,
        brokered_model_network: ModelBrokeredNetworkAccessV1::ProviderOnly,
        tool_capabilities: capabilities
            .iter()
            .map(|capability| capability.capability_id.clone())
            .collect(),
    };
    constraints.validate_for_role(execution_role)?;
    Ok(constraints)
}

/// Return the semantic digest for the normalized model request and exact
/// ordered commitments. This is intentionally independent of raw CAS bytes:
/// the issuer verifies both values so neither an altered document nor a
/// semantically substituted provider request can pass alone.
pub fn model_request_semantic_v1_digest(
    normalized_provider_request: &CredentialFreeNormalizedModelRequestV1,
    tool_capabilities: &[ModelToolCapabilityCommitmentV1],
    redaction_commitments: &[ModelRedactionCommitmentV1],
) -> Result<String> {
    validate_normalized_provider_request(normalized_provider_request)?;
    validate_tool_capabilities(tool_capabilities)?;
    validate_redaction_commitments(redaction_commitments)?;
    #[derive(Serialize)]
    struct Material<'a> {
        schema_version: u32,
        normalized_provider_request: &'a CredentialFreeNormalizedModelRequestV1,
        tool_capabilities: &'a [ModelToolCapabilityCommitmentV1],
        redaction_commitments: &'a [ModelRedactionCommitmentV1],
    }
    let material = Material {
        schema_version: CANONICAL_MODEL_ACTION_INPUT_V1_SCHEMA_VERSION,
        normalized_provider_request,
        tool_capabilities,
        redaction_commitments,
    };
    domain_separated_digest(MODEL_REQUEST_SEMANTIC_V1_DIGEST_DOMAIN, &material)
}

/// Canonical declaration-ordered bytes for a model action input. Store these
/// with `Cas::put_canonical_bytes`; never hash caller JSON directly.
pub fn canonical_model_action_input_v1_bytes(
    document: &CanonicalModelActionInputV1,
) -> Result<Vec<u8>> {
    document.validate()?;
    canonical_document_bytes(document, "canonical_model_action_input_v1")
}

/// Canonical declaration-ordered bytes for model-request evidence.
pub fn model_request_evidence_document_v1_bytes(
    document: &ModelRequestEvidenceDocumentV1,
) -> Result<Vec<u8>> {
    document.validate()?;
    canonical_document_bytes(document, "model_request_evidence_document_v1")
}

/// Canonical declaration-ordered bytes for trust-scope evidence.
pub fn trust_scope_evidence_document_v1_bytes(
    document: &TrustScopeEvidenceDocumentV1,
) -> Result<Vec<u8>> {
    document.validate()?;
    canonical_document_bytes(document, "trust_scope_evidence_document_v1")
}

/// Create the descriptor `ModelActionIntentV1` carries after protected CAS
/// storage has returned a strict raw reference.
pub fn model_request_evidence_v1_descriptor(reference: &CanonicalCasRef) -> ModelRequestEvidenceV1 {
    ModelRequestEvidenceV1 {
        schema_version: MODEL_REQUEST_EVIDENCE_DOCUMENT_V1_SCHEMA_VERSION,
        cas_ref: reference.to_cas_ref(),
        digest: reference.digest().to_string(),
    }
}

/// Create the descriptor `ModelActionIntentV1` carries after protected CAS
/// storage has returned a strict raw reference.
pub fn trust_scope_evidence_v1_descriptor(reference: &CanonicalCasRef) -> TrustScopeEvidenceV1 {
    TrustScopeEvidenceV1 {
        schema_version: TRUST_SCOPE_EVIDENCE_DOCUMENT_V1_SCHEMA_VERSION,
        cas_ref: reference.to_cas_ref(),
        digest: reference.digest().to_string(),
    }
}

/// Parse exact raw-CAS input bytes. The caller supplies the ref/digest copied
/// from a replayed `ActionRequestedV2`; a mismatch fails before JSON parsing.
pub fn parse_verified_canonical_model_action_input_v1(
    bytes: &[u8],
    cas_ref: &str,
    digest: &str,
) -> Result<VerifiedCanonicalModelActionInputV1> {
    let reference =
        verify_raw_cas_bytes("canonical_model_action_input_v1", bytes, cas_ref, digest)?;
    let document: CanonicalModelActionInputV1 = serde_json::from_slice(bytes)?;
    let canonical = canonical_model_action_input_v1_bytes(&document)?;
    ensure_exact_canonical_bytes("canonical_model_action_input_v1", bytes, &canonical)?;
    Ok(VerifiedCanonicalModelActionInputV1 {
        document,
        reference,
    })
}

/// Parse exact raw-CAS model-request evidence named by a strict descriptor.
pub fn parse_verified_model_request_evidence_document_v1(
    bytes: &[u8],
    descriptor: &ModelRequestEvidenceV1,
) -> Result<VerifiedModelRequestEvidenceDocumentV1> {
    let reference = validate_model_request_evidence_descriptor(descriptor)?;
    verify_raw_cas_bytes(
        "model_request_evidence_document_v1",
        bytes,
        &descriptor.cas_ref,
        &descriptor.digest,
    )?;
    let document: ModelRequestEvidenceDocumentV1 = serde_json::from_slice(bytes)?;
    let canonical = model_request_evidence_document_v1_bytes(&document)?;
    ensure_exact_canonical_bytes("model_request_evidence_document_v1", bytes, &canonical)?;
    Ok(VerifiedModelRequestEvidenceDocumentV1 {
        document,
        reference,
    })
}

/// Parse exact raw-CAS trust-scope evidence named by a strict descriptor.
pub fn parse_verified_trust_scope_evidence_document_v1(
    bytes: &[u8],
    descriptor: &TrustScopeEvidenceV1,
) -> Result<VerifiedTrustScopeEvidenceDocumentV1> {
    let reference = validate_trust_scope_evidence_descriptor(descriptor)?;
    verify_raw_cas_bytes(
        "trust_scope_evidence_document_v1",
        bytes,
        &descriptor.cas_ref,
        &descriptor.digest,
    )?;
    let document: TrustScopeEvidenceDocumentV1 = serde_json::from_slice(bytes)?;
    let canonical = trust_scope_evidence_document_v1_bytes(&document)?;
    ensure_exact_canonical_bytes("trust_scope_evidence_document_v1", bytes, &canonical)?;
    Ok(VerifiedTrustScopeEvidenceDocumentV1 {
        document,
        reference,
    })
}

/// Verify that a parsed model-request document reproduces the exact verified
/// input object named by its binding. This is the key no-proposal check for a
/// future intent issuer.
pub fn verify_model_request_evidence_matches_canonical_input(
    evidence: &ModelRequestEvidenceDocumentV1,
    input: &VerifiedCanonicalModelActionInputV1,
) -> Result<()> {
    evidence.validate()?;
    input.document().validate()?;
    verify_binding_matches_verified_input(&evidence.binding, input)?;
    let input_document = input.document();
    if evidence.normalized_provider_request != input_document.normalized_provider_request
        || evidence.tool_capabilities != input_document.tool_capabilities
        || evidence.redaction_commitments != input_document.redaction_commitments
        || evidence.model_request_digest != input_document.model_request_digest
    {
        return Err(invalid(
            "model_request_evidence_document_v1",
            "model evidence does not equal the verified canonical input request semantics",
        ));
    }
    Ok(())
}

/// Verify a trust-scope document against the verified model-request document
/// it names. This rejects descriptor substitution, cross-action binding, and
/// any constraint list that does not derive from the exact model capabilities.
pub fn verify_trust_scope_evidence_matches_model_request(
    trust_scope: &TrustScopeEvidenceDocumentV1,
    model_request: &VerifiedModelRequestEvidenceDocumentV1,
) -> Result<()> {
    trust_scope.validate()?;
    model_request.document().validate()?;
    if trust_scope.binding != model_request.document().binding {
        return Err(invalid(
            "trust_scope_evidence_document_v1",
            "trust scope binding does not equal the verified model-request binding",
        ));
    }
    if trust_scope.model_request_evidence != model_request.descriptor() {
        return Err(invalid(
            "trust_scope_evidence_document_v1",
            "trust scope does not name the exact verified model-request evidence object",
        ));
    }
    let expected_constraints = derive_model_action_scope_constraints_v1(
        model_request.document().binding.execution_role,
        &model_request.document().tool_capabilities,
    )?;
    if trust_scope.constraints != expected_constraints {
        return Err(invalid(
            "trust_scope_evidence_document_v1",
            "trust scope constraints do not equal the signed-role-derived model capabilities",
        ));
    }
    Ok(())
}

/// Cross-check the complete binding against replayed V3 dispatch and action
/// records. The protected issuer should call this after loading both events
/// from a verified tape and before it writes either evidence document.
pub fn validate_model_action_binding_against_replayed_dispatch_v3(
    binding: &ModelActionEvidenceBindingV1,
    action: &ActionRequestedV2,
    dispatch_event_ref: EventId,
    action_request_event_ref: EventId,
    dispatch: &DispatchEnvelopeV3,
) -> Result<()> {
    binding.verify_against_action_requested_v2(
        action,
        dispatch_event_ref,
        action_request_event_ref,
    )?;
    let expected_dispatch_digest = dispatch_envelope_v3_body_digest(
        &dispatch.body,
        dispatch.action_evidence_version,
        &dispatch.repository_binding_digest,
        &dispatch.ledger_authority_realm_digest,
        dispatch.governed_packet_digest.as_deref(),
    )
    .map_err(|error| {
        invalid(
            "model_action_evidence_binding_v1",
            format!("could not canonicalize replayed dispatch envelope: {error}"),
        )
    })?;
    if dispatch.envelope_digest != expected_dispatch_digest {
        return Err(invalid(
            "model_action_evidence_binding_v1",
            "replayed dispatch envelope_digest does not match its V3 canonical body",
        ));
    }
    if dispatch.body.trust_tier != TrustTierV1::Governed
        || dispatch.body.commit_mode != CommitModeV1::Atomic
        || dispatch.action_evidence_version != ActionEvidenceVersionV1::SealedV3
    {
        return Err(invalid(
            "model_action_evidence_binding_v1",
            "model evidence requires a governed atomic sealed-v3 dispatch",
        ));
    }
    let governed_packet_digest = dispatch.governed_packet_digest.as_deref().ok_or_else(|| {
        invalid(
            "model_action_evidence_binding_v1",
            "sealed-v3 dispatch requires governed_packet_digest",
        )
    })?;
    let expected_policy_digest =
        governed_dispatch_policy_digest_v1(&dispatch.body.acceptance_contract_digest)
            .map_err(|reason| invalid("model_action_evidence_binding_v1", reason))?;
    for (field, actual, expected) in [
        (
            "workflow_id",
            binding.workflow_id.as_str(),
            dispatch.body.workflow_id.as_str(),
        ),
        (
            "unit_id",
            binding.unit_id.as_str(),
            dispatch.body.unit_id.as_str(),
        ),
        (
            "provenance_ref",
            binding.provenance_ref.as_str(),
            dispatch.body.provenance_ref.as_str(),
        ),
        (
            "dispatch_envelope_digest",
            binding.dispatch_envelope_digest.as_str(),
            dispatch.envelope_digest.as_str(),
        ),
        (
            "repository_binding_digest",
            binding.repository_binding_digest.as_str(),
            dispatch.repository_binding_digest.as_str(),
        ),
        (
            "ledger_authority_realm_digest",
            binding.ledger_authority_realm_digest.as_str(),
            dispatch.ledger_authority_realm_digest.as_str(),
        ),
        (
            "governed_packet_digest",
            binding.governed_packet_digest.as_str(),
            governed_packet_digest,
        ),
        (
            "capability_bundle_digest",
            binding.capability_bundle_digest.as_str(),
            dispatch.body.capability_bundle_digest.as_str(),
        ),
        (
            "policy_digest",
            binding.policy_digest.as_str(),
            expected_policy_digest.as_str(),
        ),
        (
            "context_manifest_digest",
            binding.context_manifest_digest.as_str(),
            dispatch.body.context_manifest_digest.as_str(),
        ),
        (
            "worker_manifest_digest",
            binding.worker_manifest_digest.as_str(),
            dispatch.body.worker_manifest_digest.as_str(),
        ),
        (
            "sandbox_profile_digest",
            binding.sandbox_profile_digest.as_str(),
            dispatch.body.sandbox_profile_digest.as_str(),
        ),
    ] {
        if actual != expected {
            return Err(invalid(
                "model_action_evidence_binding_v1",
                format!("{field} does not equal the replayed sealed-v3 dispatch"),
            ));
        }
    }
    if binding.attempt != dispatch.body.attempt
        || binding.execution_role != dispatch.body.execution_role
    {
        return Err(invalid(
            "model_action_evidence_binding_v1",
            "attempt or execution_role does not equal the replayed sealed-v3 dispatch",
        ));
    }
    Ok(())
}

fn validate_normalized_provider_request(
    request: &CredentialFreeNormalizedModelRequestV1,
) -> Result<()> {
    validate_identifier(
        "normalized_provider_request.model",
        &request.model,
        MAX_MODEL_IDENTIFIER_BYTES,
    )?;
    validate_content(
        "normalized_provider_request.prompt",
        &request.prompt,
        MAX_NORMALIZED_PROMPT_BYTES,
        false,
    )?;
    if let Some(system_prompt) = &request.system_prompt {
        validate_content(
            "normalized_provider_request.system_prompt",
            system_prompt,
            MAX_NORMALIZED_SYSTEM_PROMPT_BYTES,
            false,
        )?;
    }
    validate_sha256_digest(
        "normalized_provider_request.response_schema_digest",
        &request.response_schema_digest,
    )
}

fn validate_tool_capabilities(capabilities: &[ModelToolCapabilityCommitmentV1]) -> Result<()> {
    if capabilities.len() > MAX_MODEL_TOOL_CAPABILITIES {
        return Err(invalid(
            "model_request_semantic_v1",
            format!("tool_capabilities exceeds maximum of {MAX_MODEL_TOOL_CAPABILITIES} entries"),
        ));
    }
    let mut prior: Option<&str> = None;
    for capability in capabilities {
        validate_identifier(
            "tool_capabilities.capability_id",
            &capability.capability_id,
            MAX_COMMITMENT_IDENTIFIER_BYTES,
        )?;
        validate_sha256_digest(
            "tool_capabilities.input_schema_digest",
            &capability.input_schema_digest,
        )?;
        validate_sha256_digest(
            "tool_capabilities.output_schema_digest",
            &capability.output_schema_digest,
        )?;
        if prior.is_some_and(|previous| previous >= capability.capability_id.as_str()) {
            return Err(invalid(
                "model_request_semantic_v1",
                "tool_capabilities must be strictly ordered by capability_id with no duplicates",
            ));
        }
        prior = Some(&capability.capability_id);
    }
    Ok(())
}

fn validate_redaction_commitments(commitments: &[ModelRedactionCommitmentV1]) -> Result<()> {
    if commitments.len() > MAX_MODEL_REDACTION_COMMITMENTS {
        return Err(invalid(
            "model_request_semantic_v1",
            format!(
                "redaction_commitments exceeds maximum of {MAX_MODEL_REDACTION_COMMITMENTS} entries"
            ),
        ));
    }
    let mut prior: Option<&str> = None;
    for commitment in commitments {
        validate_identifier(
            "redaction_commitments.field",
            &commitment.field,
            MAX_COMMITMENT_IDENTIFIER_BYTES,
        )?;
        validate_content(
            "redaction_commitments.reason",
            &commitment.reason,
            MAX_REDACTION_REASON_BYTES,
            false,
        )?;
        if let Some(digest) = &commitment.redacted_digest {
            validate_sha256_digest("redaction_commitments.redacted_digest", digest)?;
        }
        if prior.is_some_and(|previous| previous >= commitment.field.as_str()) {
            return Err(invalid(
                "model_request_semantic_v1",
                "redaction_commitments must be strictly ordered by field with no duplicates",
            ));
        }
        prior = Some(&commitment.field);
    }
    Ok(())
}

fn validate_ordered_identifier_list(field: &str, values: &[String]) -> Result<()> {
    if values.len() > MAX_MODEL_TOOL_CAPABILITIES {
        return Err(invalid(
            "model_action_scope_constraints_v1",
            format!("{field} exceeds maximum of {MAX_MODEL_TOOL_CAPABILITIES} entries"),
        ));
    }
    let mut prior: Option<&str> = None;
    for value in values {
        validate_identifier(field, value, MAX_COMMITMENT_IDENTIFIER_BYTES)?;
        if prior.is_some_and(|previous| previous >= value.as_str()) {
            return Err(invalid(
                "model_action_scope_constraints_v1",
                format!("{field} must be strictly ordered with no duplicates"),
            ));
        }
        prior = Some(value);
    }
    Ok(())
}

fn role_constraints(role: ExecutionRoleV1) -> Result<(bool, ModelFilesystemAccessV1)> {
    match role {
        ExecutionRoleV1::Implementer => Ok((false, ModelFilesystemAccessV1::None)),
        ExecutionRoleV1::Reviewer | ExecutionRoleV1::Adversary | ExecutionRoleV1::Judge => {
            Ok((true, ModelFilesystemAccessV1::CandidateReadOnly))
        }
        ExecutionRoleV1::Candidate => Err(invalid(
            "model_action_scope_constraints_v1",
            "candidate is not an API worker execution role",
        )),
    }
}

fn verify_binding_matches_verified_input(
    binding: &ModelActionEvidenceBindingV1,
    input: &VerifiedCanonicalModelActionInputV1,
) -> Result<()> {
    if binding.canonical_input_ref != input.cas_ref()
        || binding.canonical_input_digest != input.digest()
    {
        return Err(invalid(
            "model_action_evidence_binding_v1",
            "binding canonical input descriptor does not name the verified input bytes",
        ));
    }
    Ok(())
}

fn validate_model_request_evidence_descriptor(
    descriptor: &ModelRequestEvidenceV1,
) -> Result<CanonicalCasRef> {
    if descriptor.schema_version != MODEL_REQUEST_EVIDENCE_DOCUMENT_V1_SCHEMA_VERSION {
        return Err(unsupported_schema(
            "model_request_evidence_descriptor_v1",
            descriptor.schema_version,
            MODEL_REQUEST_EVIDENCE_DOCUMENT_V1_SCHEMA_VERSION,
        ));
    }
    validate_raw_cas_descriptor(
        "model_request_evidence.cas_ref",
        &descriptor.cas_ref,
        "model_request_evidence.digest",
        &descriptor.digest,
    )
}

fn validate_trust_scope_evidence_descriptor(
    descriptor: &TrustScopeEvidenceV1,
) -> Result<CanonicalCasRef> {
    if descriptor.schema_version != TRUST_SCOPE_EVIDENCE_DOCUMENT_V1_SCHEMA_VERSION {
        return Err(unsupported_schema(
            "trust_scope_evidence_descriptor_v1",
            descriptor.schema_version,
            TRUST_SCOPE_EVIDENCE_DOCUMENT_V1_SCHEMA_VERSION,
        ));
    }
    validate_raw_cas_descriptor(
        "trust_scope_evidence.cas_ref",
        &descriptor.cas_ref,
        "trust_scope_evidence.digest",
        &descriptor.digest,
    )
}

fn verify_raw_cas_bytes(
    kind: &str,
    bytes: &[u8],
    cas_ref: &str,
    digest: &str,
) -> Result<CanonicalCasRef> {
    if bytes.len() > MAX_MODEL_EVIDENCE_DOCUMENT_BYTES {
        return Err(invalid(
            kind,
            format!("document exceeds maximum of {MAX_MODEL_EVIDENCE_DOCUMENT_BYTES} raw bytes"),
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

fn validate_raw_cas_descriptor(
    reference_field: &str,
    cas_ref: &str,
    digest_field: &str,
    digest: &str,
) -> Result<CanonicalCasRef> {
    let reference = CanonicalCasRef::parse(cas_ref).map_err(|_| {
        invalid(
            "model_evidence_v1",
            format!("{reference_field} must be cas:sha256:<64 lowercase hex>"),
        )
    })?;
    let expected = CanonicalCasRef::from_digest(digest.to_string()).map_err(|_| {
        invalid(
            "model_evidence_v1",
            format!("{digest_field} must be sha256:<64 lowercase hex>"),
        )
    })?;
    if reference.digest() != expected.digest() {
        return Err(invalid(
            "model_evidence_v1",
            format!("{reference_field} must name the exact raw digest in {digest_field}"),
        ));
    }
    Ok(reference)
}

fn canonical_document_bytes<T: Serialize>(document: &T, kind: &str) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(document)?;
    if bytes.len() > MAX_MODEL_EVIDENCE_DOCUMENT_BYTES {
        return Err(invalid(
            kind,
            format!(
                "canonical document exceeds maximum of {MAX_MODEL_EVIDENCE_DOCUMENT_BYTES} bytes"
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

fn domain_separated_digest<T: Serialize>(domain: &[u8], material: &T) -> Result<String> {
    let bytes = serde_json::to_vec(material)?;
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(bytes);
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

fn raw_sha256_digest(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
}

fn validate_sha256_digest(field: &str, value: &str) -> Result<()> {
    CanonicalCasRef::from_digest(value.to_string()).map_err(|_| {
        invalid(
            "model_evidence_v1",
            format!("{field} must be sha256:<64 lowercase hex>"),
        )
    })?;
    Ok(())
}

fn validate_binding_text(field: &str, value: &str) -> Result<()> {
    validate_identifier(field, value, MAX_BINDING_TEXT_BYTES)
}

fn validate_identifier(field: &str, value: &str, max_bytes: usize) -> Result<()> {
    if value.is_empty() || value.len() > max_bytes || value.trim() != value || value.contains('\0')
    {
        return Err(invalid(
            "model_evidence_v1",
            format!("{field} must be non-empty, bounded, trimmed, and contain no NUL bytes"),
        ));
    }
    Ok(())
}

fn validate_content(field: &str, value: &str, max_bytes: usize, allow_empty: bool) -> Result<()> {
    if (!allow_empty && value.trim().is_empty()) || value.len() > max_bytes || value.contains('\0')
    {
        return Err(invalid(
            "model_evidence_v1",
            format!("{field} must be non-empty, bounded, and contain no NUL bytes"),
        ));
    }
    Ok(())
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
