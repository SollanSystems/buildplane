//! Trust-spine payloads.
//!
//! These records are deliberately evidence bindings, not authority evaluators.
//! The signed tape attests that a record was appended; policy, key trust, and
//! promotion eligibility remain kernel-owned checks. Every authority-shaped
//! struct opts into `deny_unknown_fields` so an older reducer never silently
//! accepts a newer field as if it had understood it.

use crate::id::EventId;
use serde::{
    de::Error as DeError, ser::Error as SerError, Deserialize, Deserializer, Serialize, Serializer,
};
use sha2::{Digest, Sha256};
use typeshare::typeshare;

/// The signed execution role determines the permitted worker surface.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionRoleV1 {
    Implementer,
    Reviewer,
    Adversary,
    Judge,
    Candidate,
}

/// Commit semantics carried by a dispatch envelope. Governed admission may
/// support only `atomic` while still preserving the closed wire vocabulary.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommitModeV1 {
    Atomic,
    Incremental,
    Saga,
}

/// Trust lane selected by the caller before admission.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustTierV1 {
    Raw,
    Governed,
}

/// Signature reference carried by a dispatch envelope. This is a reference
/// shape only; validation happens at the admission/signing boundary.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignatureRefV1 {
    pub algorithm: String,
    pub key_id: String,
    pub signature: String,
}

/// Bounded worker budget. `u32` keeps the generated TypeScript number exact.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DispatchBudgetV1 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_compute_time_ms: Option<u32>,
}

/// `dispatch_envelope` payload — the durable, signed admission boundary for
/// one unit attempt. A valid payload is not itself proof that the referenced
/// signature or policy authority is trusted.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DispatchEnvelopeV1 {
    pub workflow_id: String,
    pub workflow_revision: String,
    pub unit_id: String,
    pub attempt: u32,
    pub execution_role: ExecutionRoleV1,
    pub commit_mode: CommitModeV1,
    pub provenance_ref: String,
    pub base_commit_sha: String,
    pub capability_bundle_digest: String,
    pub acceptance_contract_digest: String,
    pub context_manifest_digest: String,
    pub worker_manifest_digest: String,
    pub sandbox_profile_digest: String,
    pub budget: DispatchBudgetV1,
    pub trust_tier: TrustTierV1,
    pub idempotency_key: String,
    /// RFC3339 UTC timestamp.
    pub issued_at: String,
    /// RFC3339 UTC timestamp.
    pub expires_at: String,
    pub envelope_digest: String,
    pub signature_ref: SignatureRefV1,
}

/// The authority-bearing portion of a V2 dispatch envelope. It deliberately
/// carries every V1 authority field except the envelope digest and detached
/// signature reference so those bytes can be hashed without a circular
/// dependency.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DispatchEnvelopeBodyV2 {
    pub workflow_id: String,
    pub workflow_revision: String,
    pub unit_id: String,
    pub attempt: u32,
    pub execution_role: ExecutionRoleV1,
    pub commit_mode: CommitModeV1,
    pub provenance_ref: String,
    pub base_commit_sha: String,
    pub capability_bundle_digest: String,
    pub acceptance_contract_digest: String,
    pub context_manifest_digest: String,
    pub worker_manifest_digest: String,
    pub sandbox_profile_digest: String,
    pub budget: DispatchBudgetV1,
    pub trust_tier: TrustTierV1,
    pub idempotency_key: String,
    /// RFC3339 UTC timestamp.
    pub issued_at: String,
    /// RFC3339 UTC timestamp.
    pub expires_at: String,
}

/// `dispatch_envelope_v2` payload — a signed detached event wrapping a
/// non-circular, deterministically hashed authority body.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DispatchEnvelopeV2 {
    pub body: DispatchEnvelopeBodyV2,
    pub envelope_digest: String,
}

/// Domain separator for [`dispatch_envelope_v2_body_digest`].
pub const DISPATCH_ENVELOPE_V2_DIGEST_DOMAIN: &[u8] = b"buildplane.dispatch-envelope.v2\0";

/// Return the deterministic body digest used by a V2 dispatch envelope.
///
/// The byte sequence is the declaration-ordered Rust `serde_json` encoding of
/// [`DispatchEnvelopeBodyV2`], prefixed with the V2 domain separator. The body
/// has no maps or floating-point fields, so this encoding is stable for a
/// given struct value without normalizing or reserializing a caller-supplied
/// JSON object.
pub fn dispatch_envelope_v2_body_digest(
    body: &DispatchEnvelopeBodyV2,
) -> Result<String, serde_json::Error> {
    let bytes = serde_json::to_vec(body)?;
    let mut hasher = Sha256::new();
    hasher.update(DISPATCH_ENVELOPE_V2_DIGEST_DOMAIN);
    hasher.update(bytes);
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

/// Action-evidence sealing protocol selected by an additive V3 dispatch
/// envelope. The wire value is part of the signed authority bytes. Keep the
/// V2 spelling readable for existing tapes, while the V3 spelling is an
/// explicit underscore-delimited protocol revision rather than an implicit
/// serde naming convention.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActionEvidenceVersionV1 {
    #[serde(rename = "sealed-v2")]
    SealedV2,
    #[serde(rename = "sealed_v3")]
    SealedV3,
}

/// `dispatch_envelope_v3` payload — the V2 admission body plus an explicit
/// sealed action-evidence contract. The detached envelope digest covers both
/// the exact V2 authority body and this protocol selector.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DispatchEnvelopeV3 {
    pub body: DispatchEnvelopeBodyV2,
    pub action_evidence_version: ActionEvidenceVersionV1,
    /// Canonical binding of the target repository instance. A base object id
    /// alone can be present in another clone or fork and is not authority.
    pub repository_binding_digest: String,
    /// Host-owned realm which holds the non-workspace activity claim register.
    pub ledger_authority_realm_digest: String,
    /// Present on sealed_v3 envelopes to bind the exact normalized admitted
    /// packet before a worker can choose an action. It stays optional on the
    /// wire solely so pre-binding sealed-v2 history remains replay-readable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub governed_packet_digest: Option<String>,
    pub envelope_digest: String,
}

/// Domain separator for [`dispatch_envelope_v3_body_digest`].
pub const DISPATCH_ENVELOPE_V3_DIGEST_DOMAIN: &[u8] = b"buildplane.dispatch-envelope.v3\0";

#[derive(Serialize)]
struct DispatchEnvelopeV3DigestMaterial<'a> {
    body: &'a DispatchEnvelopeBodyV2,
    action_evidence_version: ActionEvidenceVersionV1,
    repository_binding_digest: &'a str,
    ledger_authority_realm_digest: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    governed_packet_digest: Option<&'a str>,
}

/// Return the deterministic detached digest for a V3 dispatch envelope.
///
/// V3 intentionally hashes the V2 body as a nested field, preserving the V2
/// canonical bytes as an immutable authority component while binding the
/// action-evidence protocol with a distinct domain separator.
pub fn dispatch_envelope_v3_body_digest(
    body: &DispatchEnvelopeBodyV2,
    action_evidence_version: ActionEvidenceVersionV1,
    repository_binding_digest: &str,
    ledger_authority_realm_digest: &str,
    governed_packet_digest: Option<&str>,
) -> Result<String, serde_json::Error> {
    let material = DispatchEnvelopeV3DigestMaterial {
        body,
        action_evidence_version,
        repository_binding_digest,
        ledger_authority_realm_digest,
        governed_packet_digest,
    };
    domain_separated_digest(DISPATCH_ENVELOPE_V3_DIGEST_DOMAIN, &material)
}

/// `dispatch_envelope_v4` payload — an additive, graph-bound governed
/// dispatch. The complete V3 envelope remains a nested immutable value rather
/// than being copied field-by-field, so V4 cannot accidentally omit a V3
/// authority component when it binds the exact workflow topology.
///
/// The referenced graph declaration is not resolved by payload
/// canonicalization: that requires the signed tape order and is enforced by
/// the replay reducer. The detached V4 digest nevertheless binds both the
/// graph digest and the exact declaration event identity before recovery can
/// project authority.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DispatchEnvelopeV4 {
    /// The unchanged V3 authority material this revision extends.
    pub dispatch_v3: DispatchEnvelopeV3,
    /// Canonical digest of the immutable `workflow_graph_declared_v2` graph.
    pub workflow_graph_digest: String,
    /// Exact signed graph declaration event. Event identity is required in
    /// addition to the graph digest so an equivalent graph cannot be rebound
    /// from another run, declaration delivery, or workflow revision.
    pub workflow_graph_declaration_event_ref: EventId,
    /// Detached V4 digest over the nested V3 material and graph binding.
    pub envelope_digest: String,
}

/// Domain separator for [`dispatch_envelope_v4_digest`].
pub const DISPATCH_ENVELOPE_V4_DIGEST_DOMAIN: &[u8] = b"buildplane.dispatch-envelope.v4\0";

#[derive(Serialize)]
struct DispatchEnvelopeV4DigestMaterial<'a> {
    dispatch_v3: &'a DispatchEnvelopeV3,
    workflow_graph_digest: &'a str,
    workflow_graph_declaration_event_ref: &'a EventId,
}

/// Return the deterministic detached digest for a graph-bound V4 dispatch.
///
/// This deliberately serializes the complete nested V3 envelope, including
/// its own detached digest. A V4 dispatch is therefore bound to the exact V3
/// authority bytes, not merely an independently reconstructed subset of them.
pub fn dispatch_envelope_v4_digest(
    dispatch_v3: &DispatchEnvelopeV3,
    workflow_graph_digest: &str,
    workflow_graph_declaration_event_ref: &EventId,
) -> Result<String, serde_json::Error> {
    let material = DispatchEnvelopeV4DigestMaterial {
        dispatch_v3,
        workflow_graph_digest,
        workflow_graph_declaration_event_ref,
    };
    domain_separated_digest(DISPATCH_ENVELOPE_V4_DIGEST_DOMAIN, &material)
}

/// One node in a declared workflow graph. Both this list and each node's
/// `depends_on` list are ordered authority bytes: canonicalization rejects any
/// duplicate or non-lexical order rather than normalizing caller input.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowGraphNodeV1 {
    pub unit_id: String,
    pub depends_on: Vec<String>,
}

/// `workflow_graph_declared_v1` payload — the durable, signed topology for a
/// workflow revision. It records a graph before dispatch but deliberately does
/// not bind a graph digest into `DispatchEnvelopeV3`; dispatch gating requires
/// a later additive envelope revision.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowGraphDeclaredV1 {
    pub run_id: String,
    pub workflow_id: String,
    pub workflow_revision: String,
    pub nodes: Vec<WorkflowGraphNodeV1>,
    pub max_concurrent: u32,
    /// Canonical digest of the immutable graph material below, excluding this
    /// detached digest and declaration-delivery metadata.
    pub graph_digest: String,
    pub idempotency_key: String,
    /// RFC3339 UTC timestamp.
    pub declared_at: String,
}

/// Domain separator for [`workflow_graph_v1_digest`].
pub const WORKFLOW_GRAPH_V1_DIGEST_DOMAIN: &[u8] = b"buildplane.workflow-graph.v1\0";

/// The graph's semantic authority material. Delivery metadata remains outside
/// this digest so retries can prove they declared the same topology without
/// making a timestamp part of the graph itself.
#[derive(Serialize)]
struct WorkflowGraphV1DigestMaterial<'a> {
    run_id: &'a str,
    workflow_id: &'a str,
    workflow_revision: &'a str,
    nodes: &'a [WorkflowGraphNodeV1],
    max_concurrent: u32,
}

/// Return the domain-separated canonical digest for a workflow graph.
///
/// Canonicalization validates that `nodes` and `depends_on` have already been
/// supplied in strict lexical order, so declaration-ordered `serde_json` bytes
/// form one stable representation without silently sorting caller input.
pub fn workflow_graph_v1_digest(
    declaration: &WorkflowGraphDeclaredV1,
) -> Result<String, serde_json::Error> {
    let material = WorkflowGraphV1DigestMaterial {
        run_id: &declaration.run_id,
        workflow_id: &declaration.workflow_id,
        workflow_revision: &declaration.workflow_revision,
        nodes: &declaration.nodes,
        max_concurrent: declaration.max_concurrent,
    };
    domain_separated_digest(WORKFLOW_GRAPH_V1_DIGEST_DOMAIN, &material)
}

/// One node in a graph-bound V2 workflow declaration. The node carries the
/// role and normalized governed-packet digest which a V4 dispatch must repeat
/// exactly. `nodes` and `depends_on` remain ordered authority bytes: callers
/// must supply strict lexical order rather than relying on normalization.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowGraphNodeV2 {
    pub unit_id: String,
    pub depends_on: Vec<String>,
    pub execution_role: ExecutionRoleV1,
    pub governed_packet_digest: String,
}

/// `workflow_graph_declared_v2` payload — a V2 graph carries the per-node
/// governed dispatch material required for an additive V4 envelope to prove
/// its place in an immutable workflow topology. V1 remains readable and
/// intentionally stays unbound to V3 dispatches.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowGraphDeclaredV2 {
    pub run_id: String,
    pub workflow_id: String,
    pub workflow_revision: String,
    pub nodes: Vec<WorkflowGraphNodeV2>,
    pub max_concurrent: u32,
    /// Canonical digest of the immutable graph material below, excluding this
    /// detached digest and declaration-delivery metadata.
    pub graph_digest: String,
    pub idempotency_key: String,
    /// RFC3339 UTC timestamp.
    pub declared_at: String,
}

/// Domain separator for [`workflow_graph_v2_digest`].
pub const WORKFLOW_GRAPH_V2_DIGEST_DOMAIN: &[u8] = b"buildplane.workflow-graph.v2\0";

#[derive(Serialize)]
struct WorkflowGraphV2DigestMaterial<'a> {
    run_id: &'a str,
    workflow_id: &'a str,
    workflow_revision: &'a str,
    nodes: &'a [WorkflowGraphNodeV2],
    max_concurrent: u32,
}

/// Return the domain-separated canonical digest for a graph-bound V2
/// workflow declaration.
pub fn workflow_graph_v2_digest(
    declaration: &WorkflowGraphDeclaredV2,
) -> Result<String, serde_json::Error> {
    let material = WorkflowGraphV2DigestMaterial {
        run_id: &declaration.run_id,
        workflow_id: &declaration.workflow_id,
        workflow_revision: &declaration.workflow_revision,
        nodes: &declaration.nodes,
        max_concurrent: declaration.max_concurrent,
    };
    domain_separated_digest(WORKFLOW_GRAPH_V2_DIGEST_DOMAIN, &material)
}

/// Domain separator for the action-plane policy binding derived from a
/// governed dispatch's already-signed acceptance-contract digest.
///
/// V3 predates a separately signed policy-manifest field. Until an additive
/// dispatch revision carries one, the native authority boundary must derive
/// this value itself rather than accepting a caller-selected `policy_digest`.
pub const GOVERNED_DISPATCH_POLICY_DIGEST_V1_DOMAIN: &[u8] =
    b"buildplane.governed-dispatch-policy.v1\0";

/// Derive the canonical action-plane policy digest for a governed dispatch.
///
/// The input is deliberately the textual canonical SHA-256 acceptance-contract
/// digest, not decoded digest bytes. This exactly matches the TypeScript
/// admission compiler and gives a future native activity claimer one
/// deterministic binding to validate before it leases an effect.
pub fn governed_dispatch_policy_digest_v1(
    acceptance_contract_digest: &str,
) -> Result<String, &'static str> {
    if !is_canonical_sha256_digest(acceptance_contract_digest) {
        return Err("acceptance_contract_digest must be a canonical sha256 digest");
    }

    let mut hasher = Sha256::new();
    hasher.update(GOVERNED_DISPATCH_POLICY_DIGEST_V1_DOMAIN);
    hasher.update(acceptance_contract_digest.as_bytes());
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

fn is_canonical_sha256_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Closed typed effect vocabulary admitted through the V3 action gateway.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionKindV1 {
    Filesystem,
    Process,
    Git,
    Model,
    Network,
    Secret,
    Mcp,
    A2a,
    ExternalService,
}

/// Terminality of an action receipt. `Unknown` is a durable reconciliation
/// state, not permission to retry the effect: it blocks candidate sealing.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionReceiptOutcomeV2 {
    Succeeded,
    Failed,
    Denied,
    Unknown,
}

/// Largest integer that can cross the Rust/TypeScript JSON boundary without
/// losing precision in a JavaScript `number`.
pub const TYPESCRIPT_SAFE_INTEGER_MAX: u64 = 9_007_199_254_740_991;

/// A JavaScript-safe unsigned integer on the signed wire. The runtime
/// representation remains `u64`; the alias selects the existing Typeshare
/// `U64 -> number` mapping while serde rejects values above the safe bound.
pub type U64 = u64;

fn safe_integer_error(value: u64) -> String {
    format!(
        "resource usage value {value} exceeds JavaScript Number.MAX_SAFE_INTEGER ({TYPESCRIPT_SAFE_INTEGER_MAX})"
    )
}

fn serialize_typescript_safe_u64<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    if *value > TYPESCRIPT_SAFE_INTEGER_MAX {
        return Err(<S::Error as SerError>::custom(safe_integer_error(*value)));
    }
    serializer.serialize_u64(*value)
}

fn deserialize_typescript_safe_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u64::deserialize(deserializer)?;
    if value > TYPESCRIPT_SAFE_INTEGER_MAX {
        return Err(<D::Error as DeError>::custom(safe_integer_error(value)));
    }
    Ok(value)
}

fn serialize_optional_typescript_safe_u64<S>(
    value: &Option<u64>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    match value {
        Some(value) => serialize_typescript_safe_u64(value, serializer),
        None => serializer.serialize_none(),
    }
}

fn deserialize_optional_typescript_safe_u64<'de, D>(
    deserializer: D,
) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<u64>::deserialize(deserializer)?;
    match value {
        Some(value) if value > TYPESCRIPT_SAFE_INTEGER_MAX => {
            Err(<D::Error as DeError>::custom(safe_integer_error(value)))
        }
        value => Ok(value),
    }
}

/// Bounded resource observations attached to an action receipt. These values
/// are evidence only; resource enforcement happens in the action gateway.
/// JSON representations fail closed above [`TYPESCRIPT_SAFE_INTEGER_MAX`] so
/// TypeScript consumers never silently round a sealed evidence value.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionResourceUsageV1 {
    #[serde(
        serialize_with = "serialize_typescript_safe_u64",
        deserialize_with = "deserialize_typescript_safe_u64"
    )]
    pub wall_time_ms: U64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_optional_typescript_safe_u64",
        deserialize_with = "deserialize_optional_typescript_safe_u64"
    )]
    pub cpu_time_ms: Option<U64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_optional_typescript_safe_u64",
        deserialize_with = "deserialize_optional_typescript_safe_u64"
    )]
    pub peak_memory_bytes: Option<U64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_optional_typescript_safe_u64",
        deserialize_with = "deserialize_optional_typescript_safe_u64"
    )]
    pub input_bytes: Option<U64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_optional_typescript_safe_u64",
        deserialize_with = "deserialize_optional_typescript_safe_u64"
    )]
    pub output_bytes: Option<U64>,
    /// Provider-observed prompt token count. This remains optional for
    /// historical receipts; newly governed sealed_v3 model success receipts
    /// under a signed `max_tokens` budget must carry this together with
    /// `output_tokens` before replay will admit them.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_optional_typescript_safe_u64",
        deserialize_with = "deserialize_optional_typescript_safe_u64"
    )]
    pub input_tokens: Option<U64>,
    /// Provider-observed completion token count. It is intentionally a
    /// separate optional field so old receipt bytes and digests remain stable
    /// when both token observations are absent.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_optional_typescript_safe_u64",
        deserialize_with = "deserialize_optional_typescript_safe_u64"
    )]
    pub output_tokens: Option<U64>,
}

/// One intentionally redacted action-output field. The raw secret/content is
/// never carried by the tape; an optional digest lets an evidence store prove
/// what was withheld without making it replay-visible.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionRedactionV1 {
    pub field: String,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redacted_digest: Option<String>,
}

/// Structured failure information for failed, denied, or unknown actions.
/// Human-readable error text remains out of the signed tape; callers store a
/// redacted evidence reference instead.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionFailureV1 {
    pub code: String,
    pub message_digest: String,
    pub retryable: bool,
}

/// `action_requested_v2` payload — the immutable write-ahead intent for one
/// typed gateway effect. It deliberately has no candidate digest because a
/// candidate is created only after the sealed set proves which effects ran.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionRequestedV2 {
    pub run_id: String,
    pub workflow_id: String,
    pub unit_id: String,
    pub attempt: u32,
    pub provenance_ref: String,
    pub action_id: String,
    pub idempotency_key: String,
    pub action_kind: ActionKindV1,
    pub canonical_input_digest: String,
    pub canonical_input_ref: String,
    pub dispatch_envelope_digest: String,
    /// Exact repository binding copied from the signed V3 dispatch envelope.
    pub repository_binding_digest: String,
    /// Exact protected ledger realm copied from the V3 dispatch envelope.
    pub ledger_authority_realm_digest: String,
    /// Exact admitted packet binding copied from a sealed_v3 dispatch. It is
    /// optional only for replaying action records predating packet binding.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub governed_packet_digest: Option<String>,
    pub capability_bundle_digest: String,
    pub policy_digest: String,
    pub context_manifest_digest: String,
    pub worker_manifest_digest: String,
    pub sandbox_profile_digest: String,
    pub authority_actor: String,
    pub execution_role: ExecutionRoleV1,
    /// RFC3339 UTC timestamp.
    pub requested_at: String,
}

/// Closed, content-addressed evidence of the canonical provider request that
/// a model gateway evaluated. The payload keeps the request out of the tape:
/// callers must resolve the immutable CAS object, parse this schema version,
/// and recompute `digest` before a kernel signs a model-action intent.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelRequestEvidenceV1 {
    /// The schema of the CAS object, not the ledger envelope schema.
    pub schema_version: u32,
    /// Canonical content-addressed storage reference for the credential-free
    /// normalized provider request.
    pub cas_ref: String,
    /// Digest of the canonical CAS object bytes, `sha256:<hex>`.
    pub digest: String,
}

/// The only model-request evidence object schema understood by this intent
/// revision. A future schema needs a new typed payload instead of silently
/// reinterpreting its bytes as V1.
pub const MODEL_REQUEST_EVIDENCE_V1_SCHEMA_VERSION: u32 = 1;

/// Closed, content-addressed evidence of the trust scope that was evaluated
/// with a model request. Its independent schema version prevents a future
/// reducer from silently treating a new trust policy shape as V1.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrustScopeEvidenceV1 {
    /// The schema of the CAS object, not the ledger envelope schema.
    pub schema_version: u32,
    /// Canonical content-addressed storage reference for the normalized trust
    /// scope evidence.
    pub cas_ref: String,
    /// Digest of the canonical CAS object bytes, `sha256:<hex>`.
    pub digest: String,
}

/// The only trust-scope evidence object schema understood by this intent
/// revision. See [`MODEL_REQUEST_EVIDENCE_V1_SCHEMA_VERSION`] for why this is
/// explicit rather than an open integer.
pub const TRUST_SCOPE_EVIDENCE_V1_SCHEMA_VERSION: u32 = 1;

/// All-or-none proof that a model action was authorized against a particular
/// immutable candidate and read-only candidate view. Keeping this as one
/// nested object prevents a caller from presenting a candidate digest without
/// the event/commit/view evidence that gives it meaning.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelActionCandidateBindingV1 {
    pub candidate_created_event_ref: EventId,
    pub candidate_digest: String,
    pub candidate_commit_sha: String,
    pub candidate_view_ref: String,
    pub candidate_view_digest: String,
    /// The complete replay-verifiable read-only view. The accompanying CAS
    /// reference is durable external evidence; this closed copy lets replay
    /// reject a forged writable/networked or wrong-context view without
    /// dereferencing external storage.
    pub candidate_view: CandidateViewV1,
}

/// `model_action_intent_v1` payload — the kernel-signed, write-ahead intent
/// for one model action. It parents directly to the immutable
/// `action_requested_v2` event and binds all dynamic provider/trust/candidate
/// evidence before any authorization can be issued.
///
/// Dispatch context, policy, sandbox profile, execution role, and governed
/// packet are intentionally absent: replay derives them from the already
/// signed dispatch and action request rather than trusting a second mutable
/// copy in this payload.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelActionIntentV1 {
    pub run_id: String,
    pub workflow_id: String,
    pub unit_id: String,
    pub attempt: u32,
    pub provenance_ref: String,
    pub action_id: String,
    pub idempotency_key: String,
    pub dispatch_event_ref: EventId,
    pub dispatch_envelope_digest: String,
    pub action_request_event_ref: EventId,
    pub action_request_digest: String,
    pub canonical_input_ref: String,
    pub canonical_input_digest: String,
    pub model_request_evidence: ModelRequestEvidenceV1,
    pub trust_scope_evidence: TrustScopeEvidenceV1,
    /// Candidate evidence is present only for model actions which are
    /// intentionally candidate/view-bound (reviewer, adversary, or judge).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_binding: Option<ModelActionCandidateBindingV1>,
    /// Identity of the kernel actor that prepared this intent. ReplayEngine
    /// requires the verified detached kernel signer to equal this value.
    pub intent_actor: String,
    /// RFC3339 UTC timestamp, equal to the signed event's `occurred_at`.
    pub intended_at: String,
    /// Domain-separated digest of this record excluding this field itself.
    pub intent_digest: String,
}

/// `model_action_authorized_v2` payload — the kernel-signed authorization
/// which follows one exact [`ModelActionIntentV1`]. The event must parent to
/// `intent_event_ref`; the repeated evidence is deliberate and must equal the
/// intent exactly, preventing an authorization from swapping a model request,
/// trust scope, or candidate view after intent creation.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelActionAuthorizedV2 {
    pub intent_event_ref: EventId,
    pub intent_digest: String,
    pub model_request_evidence: ModelRequestEvidenceV1,
    pub trust_scope_evidence: TrustScopeEvidenceV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_binding: Option<ModelActionCandidateBindingV1>,
    /// Identity of the kernel actor that issued this authorization. ReplayEngine
    /// requires the verified detached kernel signer to equal this value.
    pub authorization_actor: String,
    /// RFC3339 UTC timestamp. Authority is invalid at or after this instant.
    pub expires_at: String,
    /// Stable reference the terminal action receipt must repeat exactly.
    pub authorization_ref: String,
    /// Domain-separated digest of this record excluding this field itself.
    pub authorization_digest: String,
}

/// Domain separator for [`model_action_intent_v1_digest`].
pub const MODEL_ACTION_INTENT_V1_DIGEST_DOMAIN: &[u8] = b"buildplane.model-action-intent.v1\0";

/// Domain separator for [`model_action_authorized_v2_digest`].
pub const MODEL_ACTION_AUTHORIZED_V2_DIGEST_DOMAIN: &[u8] =
    b"buildplane.model-action-authorized.v2\0";

#[derive(Serialize)]
struct ModelActionIntentV1DigestMaterial<'a> {
    run_id: &'a str,
    workflow_id: &'a str,
    unit_id: &'a str,
    attempt: u32,
    provenance_ref: &'a str,
    action_id: &'a str,
    idempotency_key: &'a str,
    dispatch_event_ref: &'a EventId,
    dispatch_envelope_digest: &'a str,
    action_request_event_ref: &'a EventId,
    action_request_digest: &'a str,
    canonical_input_ref: &'a str,
    canonical_input_digest: &'a str,
    model_request_evidence: &'a ModelRequestEvidenceV1,
    trust_scope_evidence: &'a TrustScopeEvidenceV1,
    candidate_binding: &'a Option<ModelActionCandidateBindingV1>,
    intent_actor: &'a str,
    intended_at: &'a str,
}

/// Return the deterministic digest that an intent carries. The evidence
/// descriptors are included as typed nested values, so modifying either the
/// CAS reference, schema version, or claimed content digest invalidates the
/// signed intent binding.
pub fn model_action_intent_v1_digest(
    intent: &ModelActionIntentV1,
) -> Result<String, serde_json::Error> {
    let material = ModelActionIntentV1DigestMaterial {
        run_id: &intent.run_id,
        workflow_id: &intent.workflow_id,
        unit_id: &intent.unit_id,
        attempt: intent.attempt,
        provenance_ref: &intent.provenance_ref,
        action_id: &intent.action_id,
        idempotency_key: &intent.idempotency_key,
        dispatch_event_ref: &intent.dispatch_event_ref,
        dispatch_envelope_digest: &intent.dispatch_envelope_digest,
        action_request_event_ref: &intent.action_request_event_ref,
        action_request_digest: &intent.action_request_digest,
        canonical_input_ref: &intent.canonical_input_ref,
        canonical_input_digest: &intent.canonical_input_digest,
        model_request_evidence: &intent.model_request_evidence,
        trust_scope_evidence: &intent.trust_scope_evidence,
        candidate_binding: &intent.candidate_binding,
        intent_actor: &intent.intent_actor,
        intended_at: &intent.intended_at,
    };
    domain_separated_digest(MODEL_ACTION_INTENT_V1_DIGEST_DOMAIN, &material)
}

#[derive(Serialize)]
struct ModelActionAuthorizedV2DigestMaterial<'a> {
    intent_event_ref: &'a EventId,
    intent_digest: &'a str,
    model_request_evidence: &'a ModelRequestEvidenceV1,
    trust_scope_evidence: &'a TrustScopeEvidenceV1,
    candidate_binding: &'a Option<ModelActionCandidateBindingV1>,
    authorization_actor: &'a str,
    expires_at: &'a str,
    authorization_ref: &'a str,
}

/// Return the deterministic digest carried by a V2 authorization. Its intent
/// reference/digest plus the copied dynamic evidence are all included; only
/// `authorization_digest` itself is excluded to avoid a circular hash.
pub fn model_action_authorized_v2_digest(
    authorization: &ModelActionAuthorizedV2,
) -> Result<String, serde_json::Error> {
    let material = ModelActionAuthorizedV2DigestMaterial {
        intent_event_ref: &authorization.intent_event_ref,
        intent_digest: &authorization.intent_digest,
        model_request_evidence: &authorization.model_request_evidence,
        trust_scope_evidence: &authorization.trust_scope_evidence,
        candidate_binding: &authorization.candidate_binding,
        authorization_actor: &authorization.authorization_actor,
        expires_at: &authorization.expires_at,
        authorization_ref: &authorization.authorization_ref,
    };
    domain_separated_digest(MODEL_ACTION_AUTHORIZED_V2_DIGEST_DOMAIN, &material)
}

/// `model_action_authorized_v1` payload — the native, immutable authority
/// record issued after a model action's V3 write-ahead request and before the
/// provider effect. It binds the signed dispatch and every post-write-ahead
/// digest the host model gateway evaluates. The record is intentionally
/// separate from the terminal receipt so a successful model effect cannot be
/// replayed as authorized merely because a worker supplied an opaque reference.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelActionAuthorizedV1 {
    pub run_id: String,
    pub workflow_id: String,
    pub unit_id: String,
    pub attempt: u32,
    pub provenance_ref: String,
    pub action_id: String,
    pub idempotency_key: String,
    /// Exact event id of the governed V3 dispatch envelope.
    pub dispatch_event_ref: String,
    pub dispatch_envelope_digest: String,
    /// Exact event id and canonical digest of the immutable V3 action request.
    pub action_request_ref: String,
    pub action_request_digest: String,
    /// Digest of the fully parsed governed packet, never raw packet content.
    pub packet_digest: String,
    pub canonical_input_digest: String,
    /// Credential-free canonical digest of the exact provider request.
    pub model_request_digest: String,
    pub trust_scope_digest: String,
    pub context_manifest_digest: String,
    pub policy_digest: String,
    pub sandbox_profile_digest: String,
    pub execution_role: ExecutionRoleV1,
    /// Present only when a model action is explicitly candidate/view-bound.
    /// These fields are paired so a view can never be detached from its
    /// immutable candidate identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_view_digest: Option<String>,
    /// Identity of the kernel-owned authority actor, not a worker assertion.
    pub authorization_actor: String,
    /// RFC3339 UTC timestamp. Authority is invalid at or after this instant.
    pub expires_at: String,
    /// Stable reference to this native authorization record. A successful
    /// model receipt must repeat this exact value.
    pub authorization_ref: String,
    /// Canonical detached digest of this record excluding this field itself.
    pub authorization_digest: String,
}

/// Domain separator for [`model_action_authorized_v1_digest`].
pub const MODEL_ACTION_AUTHORIZED_V1_DIGEST_DOMAIN: &[u8] =
    b"buildplane.model-action-authorized.v1\0";

#[derive(Serialize)]
struct ModelActionAuthorizedV1DigestMaterial<'a> {
    run_id: &'a str,
    workflow_id: &'a str,
    unit_id: &'a str,
    attempt: u32,
    provenance_ref: &'a str,
    action_id: &'a str,
    idempotency_key: &'a str,
    dispatch_event_ref: &'a str,
    dispatch_envelope_digest: &'a str,
    action_request_ref: &'a str,
    action_request_digest: &'a str,
    packet_digest: &'a str,
    canonical_input_digest: &'a str,
    model_request_digest: &'a str,
    trust_scope_digest: &'a str,
    context_manifest_digest: &'a str,
    policy_digest: &'a str,
    sandbox_profile_digest: &'a str,
    execution_role: ExecutionRoleV1,
    candidate_digest: &'a Option<String>,
    candidate_view_digest: &'a Option<String>,
    authorization_actor: &'a str,
    expires_at: &'a str,
    authorization_ref: &'a str,
}

/// Return the canonical authorization digest. The authorization reference is
/// part of the material, while the digest itself is excluded to avoid a
/// circular hash.
pub fn model_action_authorized_v1_digest(
    authorization: &ModelActionAuthorizedV1,
) -> Result<String, serde_json::Error> {
    let material = ModelActionAuthorizedV1DigestMaterial {
        run_id: &authorization.run_id,
        workflow_id: &authorization.workflow_id,
        unit_id: &authorization.unit_id,
        attempt: authorization.attempt,
        provenance_ref: &authorization.provenance_ref,
        action_id: &authorization.action_id,
        idempotency_key: &authorization.idempotency_key,
        dispatch_event_ref: &authorization.dispatch_event_ref,
        dispatch_envelope_digest: &authorization.dispatch_envelope_digest,
        action_request_ref: &authorization.action_request_ref,
        action_request_digest: &authorization.action_request_digest,
        packet_digest: &authorization.packet_digest,
        canonical_input_digest: &authorization.canonical_input_digest,
        model_request_digest: &authorization.model_request_digest,
        trust_scope_digest: &authorization.trust_scope_digest,
        context_manifest_digest: &authorization.context_manifest_digest,
        policy_digest: &authorization.policy_digest,
        sandbox_profile_digest: &authorization.sandbox_profile_digest,
        execution_role: authorization.execution_role,
        candidate_digest: &authorization.candidate_digest,
        candidate_view_digest: &authorization.candidate_view_digest,
        authorization_actor: &authorization.authorization_actor,
        expires_at: &authorization.expires_at,
        authorization_ref: &authorization.authorization_ref,
    };
    domain_separated_digest(MODEL_ACTION_AUTHORIZED_V1_DIGEST_DOMAIN, &material)
}

/// `action_receipt_recorded_v2` payload — the immutable terminal result for a
/// V3 action request. It binds the canonical request digest but never names a
/// candidate, preventing the worker from self-attesting its own output.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionReceiptRecordedV2 {
    pub run_id: String,
    pub workflow_id: String,
    pub unit_id: String,
    pub attempt: u32,
    pub provenance_ref: String,
    pub action_id: String,
    pub idempotency_key: String,
    pub action_request_digest: String,
    pub dispatch_envelope_digest: String,
    pub capability_bundle_digest: String,
    pub policy_digest: String,
    pub context_manifest_digest: String,
    pub worker_manifest_digest: String,
    pub sandbox_profile_digest: String,
    pub authority_actor: String,
    pub execution_role: ExecutionRoleV1,
    pub outcome: ActionReceiptOutcomeV2,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_ref: Option<String>,
    pub evidence_digest: String,
    pub evidence_ref: String,
    pub resource_usage: ActionResourceUsageV1,
    pub redactions: Vec<ActionRedactionV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<ActionFailureV1>,
    /// Immutable reference to the ActionGateway authorization decision that
    /// permitted this effect. It remains optional on the V2 wire shape so
    /// already-recorded tapes stay readable; reducer semantics require it for
    /// governed V3 model actions and new writers must always emit it there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorization_ref: Option<String>,
    /// Stable external/CAS reference for this exact receipt. Set-seal entries
    /// bind this string and the canonical receipt digest together.
    pub action_receipt_ref: String,
    /// RFC3339 UTC timestamp.
    pub completed_at: String,
}

/// One canonical entry in a sealed action-receipt set. Entries must be sorted
/// strictly by `action_id` and map one-for-one to immutable receipt records.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionReceiptSetEntryV1 {
    pub action_id: String,
    pub action_receipt_ref: String,
    pub action_receipt_digest: String,
}

/// `action_receipt_set_recorded` payload — the kernel-sealed, sorted and
/// complete action evidence set for exactly one V3 workflow attempt.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionReceiptSetRecordedV1 {
    pub run_id: String,
    pub workflow_id: String,
    pub unit_id: String,
    pub attempt: u32,
    pub provenance_ref: String,
    pub dispatch_envelope_digest: String,
    pub action_receipt_set_ref: String,
    pub action_receipt_set_digest: String,
    pub receipts: Vec<ActionReceiptSetEntryV1>,
    /// RFC3339 UTC timestamp.
    pub sealed_at: String,
}

/// Domain separator for [`action_requested_v2_digest`].
pub const ACTION_REQUEST_V2_DIGEST_DOMAIN: &[u8] = b"buildplane.action-request.v2\0";
/// Domain separator for [`action_receipt_recorded_v2_digest`].
pub const ACTION_RECEIPT_V2_DIGEST_DOMAIN: &[u8] = b"buildplane.action-receipt.v2\0";
/// Domain separator for [`action_receipt_set_v1_digest`].
pub const ACTION_RECEIPT_SET_V1_DIGEST_DOMAIN: &[u8] = b"buildplane.action-receipt-set.v1\0";

/// Return the canonical request digest that a V2 receipt must bind.
pub fn action_requested_v2_digest(
    request: &ActionRequestedV2,
) -> Result<String, serde_json::Error> {
    domain_separated_digest(ACTION_REQUEST_V2_DIGEST_DOMAIN, request)
}

/// Return the canonical receipt digest recorded in a sealed receipt-set entry.
pub fn action_receipt_recorded_v2_digest(
    receipt: &ActionReceiptRecordedV2,
) -> Result<String, serde_json::Error> {
    domain_separated_digest(ACTION_RECEIPT_V2_DIGEST_DOMAIN, receipt)
}

#[derive(Serialize)]
struct ActionReceiptSetDigestMaterial<'a> {
    run_id: &'a str,
    workflow_id: &'a str,
    unit_id: &'a str,
    attempt: u32,
    provenance_ref: &'a str,
    dispatch_envelope_digest: &'a str,
    action_receipt_set_ref: &'a str,
    receipts: &'a [ActionReceiptSetEntryV1],
    sealed_at: &'a str,
}

/// Return the canonical detached digest for a sealed action receipt set.
pub fn action_receipt_set_v1_digest(
    set: &ActionReceiptSetRecordedV1,
) -> Result<String, serde_json::Error> {
    let material = ActionReceiptSetDigestMaterial {
        run_id: &set.run_id,
        workflow_id: &set.workflow_id,
        unit_id: &set.unit_id,
        attempt: set.attempt,
        provenance_ref: &set.provenance_ref,
        dispatch_envelope_digest: &set.dispatch_envelope_digest,
        action_receipt_set_ref: &set.action_receipt_set_ref,
        receipts: &set.receipts,
        sealed_at: &set.sealed_at,
    };
    domain_separated_digest(ACTION_RECEIPT_SET_V1_DIGEST_DOMAIN, &material)
}

/// `attempt_context_recorded_v1` payload — the kernel-signed retry lineage
/// decision for one otherwise terminal sealed_v3 unit attempt. The retry is
/// bound to an exact future dispatch envelope rather than changing the stable
/// `DispatchEnvelopeV3` bytes.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttemptContextRecordedV1 {
    pub run_id: String,
    pub workflow_id: String,
    pub workflow_revision: String,
    pub unit_id: String,
    pub prior_attempt: u32,
    pub next_attempt: u32,
    pub prior_dispatch_envelope_digest: String,
    /// Exact terminal `workflow_terminal` event that closed the prior attempt.
    pub prior_terminal_event_ref: String,
    /// Canonical hash of the exact terminal event, preventing an event-id-only
    /// reference from being rebound to substituted terminal evidence.
    pub prior_terminal_event_digest: String,
    /// Exact failed action receipt from the terminal prior attempt.
    pub prior_action_receipt_ref: String,
    pub prior_action_receipt_digest: String,
    /// Required immutable feedback artifact explaining this new decision.
    pub feedback_ref: String,
    pub feedback_digest: String,
    /// Exact future sealed_v3 dispatch to which this context grants lineage.
    pub next_dispatch_envelope_digest: String,
    pub next_dispatch_idempotency_key: String,
    /// Namespace for all effects in the replacement attempt. It must not reuse
    /// the prior attempt's dispatch/action idempotency namespace.
    pub retry_action_namespace: String,
    /// Idempotency key for this one context decision, distinct from dispatch
    /// and effect idempotency keys.
    pub idempotency_key: String,
    /// RFC3339 UTC timestamp.
    pub recorded_at: String,
    /// Canonical digest of every field above except this field itself.
    pub attempt_context_digest: String,
}

/// Domain separator for [`attempt_context_recorded_v1_digest`].
pub const ATTEMPT_CONTEXT_RECORDED_V1_DIGEST_DOMAIN: &[u8] =
    b"buildplane.attempt-context-recorded.v1\0";

#[derive(Serialize)]
struct AttemptContextRecordedV1DigestMaterial<'a> {
    run_id: &'a str,
    workflow_id: &'a str,
    workflow_revision: &'a str,
    unit_id: &'a str,
    prior_attempt: u32,
    next_attempt: u32,
    prior_dispatch_envelope_digest: &'a str,
    prior_terminal_event_ref: &'a str,
    prior_terminal_event_digest: &'a str,
    prior_action_receipt_ref: &'a str,
    prior_action_receipt_digest: &'a str,
    feedback_ref: &'a str,
    feedback_digest: &'a str,
    next_dispatch_envelope_digest: &'a str,
    next_dispatch_idempotency_key: &'a str,
    retry_action_namespace: &'a str,
    idempotency_key: &'a str,
    recorded_at: &'a str,
}

/// Return the canonical digest for an immutable retry-lineage decision.
pub fn attempt_context_recorded_v1_digest(
    context: &AttemptContextRecordedV1,
) -> Result<String, serde_json::Error> {
    let material = AttemptContextRecordedV1DigestMaterial {
        run_id: &context.run_id,
        workflow_id: &context.workflow_id,
        workflow_revision: &context.workflow_revision,
        unit_id: &context.unit_id,
        prior_attempt: context.prior_attempt,
        next_attempt: context.next_attempt,
        prior_dispatch_envelope_digest: &context.prior_dispatch_envelope_digest,
        prior_terminal_event_ref: &context.prior_terminal_event_ref,
        prior_terminal_event_digest: &context.prior_terminal_event_digest,
        prior_action_receipt_ref: &context.prior_action_receipt_ref,
        prior_action_receipt_digest: &context.prior_action_receipt_digest,
        feedback_ref: &context.feedback_ref,
        feedback_digest: &context.feedback_digest,
        next_dispatch_envelope_digest: &context.next_dispatch_envelope_digest,
        next_dispatch_idempotency_key: &context.next_dispatch_idempotency_key,
        retry_action_namespace: &context.retry_action_namespace,
        idempotency_key: &context.idempotency_key,
        recorded_at: &context.recorded_at,
    };
    domain_separated_digest(ATTEMPT_CONTEXT_RECORDED_V1_DIGEST_DOMAIN, &material)
}

fn domain_separated_digest<T: Serialize>(
    domain: &[u8],
    value: &T,
) -> Result<String, serde_json::Error> {
    let bytes = serde_json::to_vec(value)?;
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(bytes);
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

/// `candidate_created_v2` payload — immutable Git output whose action lineage
/// is an exact previously sealed V3 receipt set rather than a worker-provided
/// single receipt digest.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateCreatedV2 {
    pub run_id: String,
    pub candidate_id: String,
    pub candidate_ref: String,
    pub workflow_id: String,
    pub unit_id: String,
    pub attempt: u32,
    pub provenance_ref: String,
    pub candidate_digest: String,
    pub base_commit_sha: String,
    pub candidate_commit_sha: String,
    pub commit_digest: String,
    pub tree_digest: String,
    pub patch_digest: String,
    pub changed_files_digest: String,
    pub envelope_digest: String,
    pub action_receipt_set_ref: String,
    pub action_receipt_set_digest: String,
}

/// `candidate_completion_recorded_v1` payload — an immutable, closed proof
/// that the action which created a sealed V3 candidate completed through its
/// exact request, activity claim/result, and receipt lineage. It deliberately
/// stays in the candidate-created lifecycle phase: promotion remains a later,
/// separately authorized state transition.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateCompletionRecordedV1 {
    pub run_id: String,
    pub workflow_id: String,
    pub unit_id: String,
    pub attempt: u32,
    pub provenance_ref: String,
    /// Exact signed `candidate_created_v2` event this proof closes.
    pub candidate_created_event_ref: EventId,
    pub candidate_digest: String,
    pub candidate_create_action_id: String,
    /// Exact signed `action_requested_v2` event and its detached request
    /// digest. Both are present so neither identity can be rebound alone.
    pub action_request_ref: EventId,
    pub action_request_digest: String,
    /// Exact signed lease claim and terminal result events for the candidate
    /// creation activity.
    pub activity_claim_event_ref: EventId,
    pub activity_claim_event_digest: String,
    pub activity_result_event_ref: EventId,
    pub activity_result_event_digest: String,
    /// Exact receipt entry that is also required to be in the candidate's
    /// sealed receipt set.
    pub action_receipt_ref: String,
    pub action_receipt_digest: String,
    /// Canonical digest of every field above except this field itself.
    pub completion_digest: String,
    /// RFC3339 UTC timestamp.
    pub completed_at: String,
}

/// Domain separator for [`candidate_completion_recorded_v1_digest`].
pub const CANDIDATE_COMPLETION_RECORDED_V1_DIGEST_DOMAIN: &[u8] =
    b"buildplane.candidate-completion-recorded.v1\0";

#[derive(Serialize)]
struct CandidateCompletionRecordedV1DigestMaterial<'a> {
    run_id: &'a str,
    workflow_id: &'a str,
    unit_id: &'a str,
    attempt: u32,
    provenance_ref: &'a str,
    candidate_created_event_ref: &'a EventId,
    candidate_digest: &'a str,
    candidate_create_action_id: &'a str,
    action_request_ref: &'a EventId,
    action_request_digest: &'a str,
    activity_claim_event_ref: &'a EventId,
    activity_claim_event_digest: &'a str,
    activity_result_event_ref: &'a EventId,
    activity_result_event_digest: &'a str,
    action_receipt_ref: &'a str,
    action_receipt_digest: &'a str,
    completed_at: &'a str,
}

/// Return the canonical detached digest for a candidate-completion proof.
pub fn candidate_completion_recorded_v1_digest(
    completion: &CandidateCompletionRecordedV1,
) -> Result<String, serde_json::Error> {
    let material = CandidateCompletionRecordedV1DigestMaterial {
        run_id: &completion.run_id,
        workflow_id: &completion.workflow_id,
        unit_id: &completion.unit_id,
        attempt: completion.attempt,
        provenance_ref: &completion.provenance_ref,
        candidate_created_event_ref: &completion.candidate_created_event_ref,
        candidate_digest: &completion.candidate_digest,
        candidate_create_action_id: &completion.candidate_create_action_id,
        action_request_ref: &completion.action_request_ref,
        action_request_digest: &completion.action_request_digest,
        activity_claim_event_ref: &completion.activity_claim_event_ref,
        activity_claim_event_digest: &completion.activity_claim_event_digest,
        activity_result_event_ref: &completion.activity_result_event_ref,
        activity_result_event_digest: &completion.activity_result_event_digest,
        action_receipt_ref: &completion.action_receipt_ref,
        action_receipt_digest: &completion.action_receipt_digest,
        completed_at: &completion.completed_at,
    };
    domain_separated_digest(CANDIDATE_COMPLETION_RECORDED_V1_DIGEST_DOMAIN, &material)
}

/// `candidate_created` payload — immutable implementation output. The Git
/// adapter owns the raw candidate ref; this record binds it to governed lineage.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateCreatedV1 {
    pub candidate_id: String,
    pub candidate_ref: String,
    pub workflow_id: String,
    pub unit_id: String,
    pub attempt: u32,
    pub provenance_ref: String,
    pub candidate_digest: String,
    pub base_commit_sha: String,
    pub candidate_commit_sha: String,
    pub commit_digest: String,
    pub tree_digest: String,
    pub patch_digest: String,
    pub changed_files_digest: String,
    pub envelope_digest: String,
    pub action_receipt_digest: String,
}

/// Candidate-bound deterministic acceptance outcome.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateAcceptanceOutcomeV1 {
    Passed,
    Rejected,
}

/// `candidate_acceptance_recorded` payload — one deterministic acceptance
/// record for an immutable candidate, never for a mutable workspace.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateAcceptanceRecordedV1 {
    pub candidate_digest: String,
    /// Full SHA-1 or SHA-256 Git object ID the deterministic checks evaluated.
    pub candidate_commit_sha: String,
    pub acceptance_ref: String,
    /// Exact acceptance contract digest from the signed dispatch envelope.
    pub acceptance_contract_digest: String,
    pub acceptance_digest: String,
    pub outcome: CandidateAcceptanceOutcomeV1,
    /// RFC3339 UTC timestamp.
    pub evaluated_at: String,
}

/// Closed semantic-review verdict vocabulary.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDecisionV1 {
    Approve,
    RequestChanges,
    Reject,
    Abstain,
}

/// Closed severity vocabulary for structured review findings.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewFindingSeverityV1 {
    Info,
    Low,
    Medium,
    High,
    Critical,
}

/// One structured, evidence-backed review finding.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewFindingV1 {
    pub severity: ReviewFindingSeverityV1,
    pub check_id: String,
    pub file: String,
    pub line: u32,
    pub explanation: String,
    pub evidence_refs: Vec<String>,
}

/// The closed semantic result that a review model action returns. Its digest is
/// carried by `ReviewVerdictRecordedV2` and must also be the succeeded review
/// action receipt's result digest, so a sealed but unrelated action cannot
/// authorize a separately minted verdict.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewVerdictOutputV1 {
    pub candidate_digest: String,
    pub candidate_commit_sha: String,
    pub decision: ReviewDecisionV1,
    pub findings: Vec<ReviewFindingV1>,
    pub confidence: f64,
    pub candidate_view_digest: String,
}

/// Domain separator for [`review_verdict_output_v1_digest`].
pub const REVIEW_VERDICT_OUTPUT_V1_DIGEST_DOMAIN: &[u8] = b"buildplane.review-verdict-output.v1\0";

/// Return the canonical digest of the closed review model output. This does
/// not include evidence refs or authority metadata: those are recorded by the
/// enclosing V2 ledger event and its action receipt.
pub fn review_verdict_output_v1_digest(
    output: &ReviewVerdictOutputV1,
) -> Result<String, serde_json::Error> {
    domain_separated_digest(REVIEW_VERDICT_OUTPUT_V1_DIGEST_DOMAIN, output)
}

/// Canonical read-only candidate view supplied to a reviewer. The actual
/// mounted path and context remain outside the tape; their immutable digests
/// make the view reconstructible without exposing host filesystem details.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateViewV1 {
    pub candidate_ref: String,
    pub candidate_digest: String,
    pub candidate_commit_sha: String,
    pub tree_digest: String,
    pub reviewer_context_manifest_digest: String,
    pub reviewer_sandbox_profile_digest: String,
    pub mount_path_digest: String,
    pub read_only: bool,
    pub network_disabled: bool,
}

/// Domain separator for [`candidate_view_v1_digest`].
pub const CANDIDATE_VIEW_V1_DIGEST_DOMAIN: &[u8] = b"buildplane.candidate-view.v1\0";

/// Return the canonical digest of the exact read-only candidate view mounted
/// for a reviewer. Governed review rejects views that permit writes or network
/// egress regardless of their digest.
pub fn candidate_view_v1_digest(view: &CandidateViewV1) -> Result<String, serde_json::Error> {
    domain_separated_digest(CANDIDATE_VIEW_V1_DIGEST_DOMAIN, view)
}

/// `review_verdict_recorded` payload — closed semantic verdict over exactly one
/// candidate digest. Tape verification does not turn an `approve` into merge
/// authority without the separate promotion decision.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewVerdictRecordedV1 {
    pub candidate_digest: String,
    /// Full SHA-1 or SHA-256 Git object ID the reviewer received read-only.
    pub candidate_commit_sha: String,
    pub review_ref: String,
    /// Legacy V1 tapes may carry action/output references, but they are not a
    /// promotion proof. V2 makes the whole evidence set mandatory and binds it
    /// to a separate reviewer dispatch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_verdict_action_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_action_request_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_action_receipt_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_action_receipt_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_output_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_output_digest: Option<String>,
    pub decision: ReviewDecisionV1,
    pub findings: Vec<ReviewFindingV1>,
    pub confidence: f64,
    pub reviewer_manifest_digest: String,
    /// RFC3339 UTC timestamp.
    pub reviewed_at: String,
}

/// `review_verdict_recorded_v2` payload — a closed semantic review that is
/// bound to both sides of the governed transaction: the accepted immutable
/// candidate and the independent read-only V3 reviewer activity lineage.
///
/// Unlike V1, this record cannot be treated as a free-standing model claim.
/// Replay verifies that the named acceptance record passed for the exact
/// candidate, that the reviewer dispatch is a governed V3 read-only role, and
/// that its sealed action evidence set is complete before this verdict can
/// advance promotion eligibility.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewVerdictRecordedV2 {
    /// Run containing both the candidate and reviewer dispatch records.
    pub run_id: String,
    /// Candidate-producing workflow identity.
    pub workflow_id: String,
    pub unit_id: String,
    pub attempt: u32,
    pub provenance_ref: String,
    pub candidate_digest: String,
    /// Full SHA-1 or SHA-256 Git object ID mounted read-only for review.
    pub candidate_commit_sha: String,
    pub review_ref: String,
    /// Exact succeeded model action that produced the closed verdict output.
    pub review_verdict_action_id: String,
    pub review_action_request_digest: String,
    pub review_action_receipt_ref: String,
    pub review_action_receipt_digest: String,
    pub review_output_ref: String,
    pub review_output_digest: String,
    pub decision: ReviewDecisionV1,
    pub findings: Vec<ReviewFindingV1>,
    pub confidence: f64,
    /// Exact deterministic acceptance record that passed for this candidate.
    pub acceptance_ref: String,
    pub acceptance_digest: String,
    pub acceptance_contract_digest: String,
    /// Dispatch that created the immutable candidate overlay.
    pub candidate_envelope_digest: String,
    /// Independent governed V3 reviewer dispatch identity.
    pub reviewer_workflow_id: String,
    pub reviewer_dispatch_envelope_digest: String,
    pub reviewer_unit_id: String,
    pub reviewer_attempt: u32,
    pub reviewer_execution_role: ExecutionRoleV1,
    /// Complete sealed action evidence for the reviewer activity, not the
    /// implementer's candidate evidence set.
    pub review_action_receipt_set_ref: String,
    pub review_action_receipt_set_digest: String,
    pub candidate_view: CandidateViewV1,
    /// Digest of the candidate ref/mount/context view supplied read-only to
    /// the reviewer. The concrete mount is intentionally not serialized.
    pub candidate_view_ref: String,
    pub candidate_view_digest: String,
    pub reviewer_manifest_digest: String,
    /// Identity that must match the detached reviewer event signer.
    pub reviewer_authority: String,
    /// RFC3339 UTC timestamp.
    pub reviewed_at: String,
}

/// Closed promotion decision vocabulary. `Promote` still requires a signed
/// decision-port authority check before any target-branch effect.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromotionDecisionKindV1 {
    Promote,
    Reject,
}

/// `promotion_approval_requested` payload — kernel-signed, candidate-bound
/// operator work item. This is deliberately not a promotion decision and
/// never authorizes a target-branch mutation by itself.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromotionApprovalRequestedV1 {
    pub candidate_digest: String,
    pub base_commit_sha: String,
    /// New approval requests always bind the exact target branch. Historical
    /// unbound promotion decisions remain readable separately.
    pub target_ref: String,
    pub envelope_digest: String,
    pub acceptance_ref: String,
    pub review_refs: Vec<String>,
    /// Must equal the detached kernel signer actor during verified replay.
    pub requested_by: String,
    /// RFC3339 UTC timestamp.
    pub requested_at: String,
    /// Stable identity shared with the operator decision that resolves this
    /// request. It is an idempotency namespace, never a bearer credential.
    pub idempotency_key: String,
}

/// `promotion_decision_recorded` payload — candidate-bound write-ahead intent.
/// It intentionally contains no live-worktree reference.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromotionDecisionRecordedV1 {
    pub candidate_digest: String,
    pub base_commit_sha: String,
    /// Canonical branch ref authorized by this decision. Absent only on
    /// historical tapes written before target-bound promotion existed; a
    /// present value opts the reducer into strict Git-binding validation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_ref: Option<String>,
    pub envelope_digest: String,
    pub acceptance_ref: String,
    pub review_refs: Vec<String>,
    /// Exact kernel-signed `promotion_approval_requested` event when the
    /// decision resolves a durable request. Absent only for historical direct
    /// decisions written before the request protocol existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub promotion_approval_request_ref: Option<String>,
    pub decision: PromotionDecisionKindV1,
    pub authority: String,
    pub decided_by: String,
    /// RFC3339 UTC timestamp.
    pub decided_at: String,
    pub idempotency_key: String,
}

/// Terminal promotion result vocabulary. Exactly one result is expected for a
/// candidate/idempotency-key pair, reconciled by the workflow reducer.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromotionResultOutcomeV1 {
    Promoted,
    /// The target ref moved after the promotion CAS and no longer contains the
    /// immutable merge. The effect is terminal (must not be retried), but an
    /// operator must reconcile the target before the workflow can complete.
    ReconciliationRequired,
    Rejected,
}

/// Observed post-CAS target/worktree state. Governed promotion never resets a
/// user worktree after moving the target ref; reconciliation is explicit.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromotionWorktreeSyncStateV1 {
    /// The target still contains the immutable merge, but the checkout was
    /// deliberately left untouched and requires explicit reconciliation.
    PendingReconciliation,
    /// The target still contains the immutable merge, but the root checkout
    /// remains at the pre-promotion base. This is a durable suspension, never
    /// a successful workflow completion: a separately authorized reconciler
    /// must prove that updating the checkout remains safe.
    RootCheckoutStale,
    /// The target moved after the CAS and no longer contains the merge.
    TargetAdvanced,
}

/// Git facts observed by the adapter while it performed the one permitted
/// compare-and-swap target-ref mutation. The result repeats the signed target
/// ref so replay can prove the effect stayed on the intended branch rather
/// than merely naming an arbitrary merge object.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromotionGitBindingV1 {
    pub target_ref: String,
    pub target_head_before_sha: String,
    /// Exact target-ref value observed after the CAS. Optional only so a newer
    /// reader can decode historical bindings; strict target-bound decisions
    /// require it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_head_after_sha: Option<String>,
    /// The exact merge object written by the CAS. It must equal the enclosing
    /// promotion result's `merged_head_sha` in strict governed records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged_head_sha: Option<String>,
    pub candidate_commit_sha: String,
    /// Ordered parents read from the actual merge object, not inferred from
    /// candidate inputs. Strict records require exactly [base, candidate].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_parent_shas: Option<Vec<String>>,
    /// Raw Git tree object ID read from the actual merge object. This is kept
    /// alongside the semantic tree digest below so replay can bind both forms
    /// of evidence without reconstructing a repository.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged_tree_sha: Option<String>,
    pub merged_tree_digest: String,
    /// Candidate-keyed immutable receipt ref created atomically with the target
    /// compare-and-swap. Strict records require it so recovery can find the
    /// exact merge even if the target branch is replaced before tape result
    /// recording completes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub promotion_receipt_ref: Option<String>,
    /// Post-CAS checkout state. Strict records require this explicit result so
    /// a post-CAS checkout or target-ref mismatch is never silently treated as
    /// a completed promotion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_sync_state: Option<PromotionWorktreeSyncStateV1>,
}

/// `promotion_execution_claimed_v1` payload — a kernel-owned, write-ahead
/// lease for the one target-branch promotion effect. It repeats every immutable
/// decision, dispatch, candidate, and Git binding needed for replay to reject
/// a claim that was transplanted from a neighbouring promotion.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromotionExecutionClaimedV1 {
    /// Must equal the enclosing event's run ID when the event envelope is
    /// available during canonicalization.
    pub run_id: String,
    /// Exact signed promotion decision that authorized this one effect.
    pub promotion_decision_event_ref: EventId,
    pub promotion_decision_event_digest: String,
    /// Exact governed dispatch that supplied the candidate authority.
    pub dispatch_event_ref: EventId,
    pub dispatch_envelope_digest: String,
    pub candidate_digest: String,
    pub candidate_ref: String,
    pub candidate_commit_sha: String,
    pub candidate_tree_digest: String,
    pub base_commit_sha: String,
    pub target_ref: String,
    /// Stable exactly-once identity for this candidate promotion.
    pub idempotency_key: String,
    /// Kernel-owned signer identity that issued this promotion lease.
    pub authority_actor: String,
    /// Opaque token retained verbatim by the terminal promotion result.
    pub lease_id: String,
    /// RFC3339 UTC timestamp.
    pub claimed_at: String,
    /// RFC3339 UTC timestamp; it must be later than `claimed_at`.
    pub lease_expires_at: String,
    /// Canonical domain-separated digest of every field above except itself.
    pub promotion_execution_claim_digest: String,
}

/// Domain separator for [`promotion_execution_claimed_v1_digest`].
pub const PROMOTION_EXECUTION_CLAIMED_V1_DIGEST_DOMAIN: &[u8] =
    b"buildplane.promotion-execution-claimed.v1\0";

#[derive(Serialize)]
struct PromotionExecutionClaimedV1DigestMaterial<'a> {
    run_id: &'a str,
    promotion_decision_event_ref: &'a EventId,
    promotion_decision_event_digest: &'a str,
    dispatch_event_ref: &'a EventId,
    dispatch_envelope_digest: &'a str,
    candidate_digest: &'a str,
    candidate_ref: &'a str,
    candidate_commit_sha: &'a str,
    candidate_tree_digest: &'a str,
    base_commit_sha: &'a str,
    target_ref: &'a str,
    idempotency_key: &'a str,
    authority_actor: &'a str,
    lease_id: &'a str,
    claimed_at: &'a str,
    lease_expires_at: &'a str,
}

/// Return the canonical detached digest carried by one promotion execution
/// claim. The lease token is included as opaque authority material; this
/// helper deliberately does not interpret it.
pub fn promotion_execution_claimed_v1_digest(
    claim: &PromotionExecutionClaimedV1,
) -> Result<String, serde_json::Error> {
    let material = PromotionExecutionClaimedV1DigestMaterial {
        run_id: &claim.run_id,
        promotion_decision_event_ref: &claim.promotion_decision_event_ref,
        promotion_decision_event_digest: &claim.promotion_decision_event_digest,
        dispatch_event_ref: &claim.dispatch_event_ref,
        dispatch_envelope_digest: &claim.dispatch_envelope_digest,
        candidate_digest: &claim.candidate_digest,
        candidate_ref: &claim.candidate_ref,
        candidate_commit_sha: &claim.candidate_commit_sha,
        candidate_tree_digest: &claim.candidate_tree_digest,
        base_commit_sha: &claim.base_commit_sha,
        target_ref: &claim.target_ref,
        idempotency_key: &claim.idempotency_key,
        authority_actor: &claim.authority_actor,
        lease_id: &claim.lease_id,
        claimed_at: &claim.claimed_at,
        lease_expires_at: &claim.lease_expires_at,
    };
    domain_separated_digest(PROMOTION_EXECUTION_CLAIMED_V1_DIGEST_DOMAIN, &material)
}

/// Exact lease proof repeated by a promotion effect result. It is optional so
/// existing result tapes retain their canonical JSON and remain readable;
/// governed promotion issuance requires it at the storage boundary.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromotionExecutionLeaseBindingV1 {
    pub promotion_execution_claim_event_ref: EventId,
    pub promotion_execution_claim_event_digest: String,
    pub lease_id: String,
}

/// `promotion_result_recorded` payload — effect outcome after a candidate-bound
/// compare-and-swap promotion attempt.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromotionResultRecordedV1 {
    pub candidate_digest: String,
    pub idempotency_key: String,
    pub promotion_decision_ref: String,
    pub outcome: PromotionResultOutcomeV1,
    /// Present only when `outcome` is `promoted`; semantic validation belongs to
    /// the reducer/promotion adapter, not serde shape parsing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged_head_sha: Option<String>,
    /// Required for promoted results when the linked decision carries a
    /// `target_ref`. Optional preserves replay of historical unbound records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub promotion_git_binding: Option<PromotionGitBindingV1>,
    /// Exact claim event and immutable lease token used for this effect.
    /// Omitted records are historical pre-claim results; new governed storage
    /// requires a value before it records an effect-bearing result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub promotion_execution_lease_binding: Option<PromotionExecutionLeaseBindingV1>,
    /// RFC3339 UTC timestamp.
    pub completed_at: String,
}

/// Closed operator resolution vocabulary for a promotion whose target advanced
/// after the compare-and-swap. Neither outcome promotes the original merge:
/// the immutable result remains historical evidence and terminalization is
/// explicit.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReconciliationResolutionOutcomeV1 {
    Abandon,
    Reject,
}

/// `promotion_reconciliation_resolved` payload — a distinct, operator-owned
/// resolution for a recorded `reconciliation_required` promotion result. All
/// three durable references are repeated so replay can prove the operator did
/// not resolve a substituted decision, result, or receipt.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromotionReconciliationResolvedV1 {
    pub candidate_digest: String,
    pub promotion_decision_ref: String,
    pub promotion_result_ref: String,
    pub promotion_receipt_ref: String,
    pub outcome: ReconciliationResolutionOutcomeV1,
    /// Operator actor authorized to resolve the target-advanced result.
    pub authority: String,
    /// Must equal the detached operator signer actor during verified replay.
    pub resolved_by: String,
    /// Distinct idempotency key for this resolution event.
    pub idempotency_key: String,
    /// RFC3339 UTC timestamp.
    pub resolved_at: String,
}

/// Closed terminal workflow state vocabulary.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowTerminalOutcomeV1 {
    Completed,
    Failed,
    Cancelled,
}

/// Closed timer purposes for reducer-owned workflow lifecycle control. The
/// first revision deliberately supports only a workflow deadline; future timer
/// families require a new versioned schema instead of untyped timer metadata.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowTimerKindV1 {
    WorkflowDeadline,
}

/// Kernel-signed write-ahead declaration of one workflow deadline. A timer is
/// only durable scheduling state: it cannot directly perform an effect or
/// terminalize a workflow.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowTimerScheduledV1 {
    pub run_id: String,
    pub workflow_id: String,
    pub workflow_revision: String,
    pub unit_id: String,
    pub attempt: u32,
    /// Exact dispatch event that supplied the timer authority.
    pub dispatch_event_ref: EventId,
    pub dispatch_envelope_digest: String,
    pub timer_id: String,
    pub timer_kind: WorkflowTimerKindV1,
    /// RFC3339 UTC deadline.
    pub due_at: String,
    pub idempotency_key: String,
    /// Must equal the detached kernel signer actor during verified replay.
    pub scheduled_by: String,
    /// RFC3339 UTC timestamp bound to the enclosing event.
    pub scheduled_at: String,
}

/// Kernel-signed observation that an exact scheduled timer elapsed. The event
/// repeats the canonical schedule-event digest so a neighboring deadline cannot
/// be substituted during recovery.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowTimerFiredV1 {
    pub run_id: String,
    pub workflow_id: String,
    pub workflow_revision: String,
    pub unit_id: String,
    pub attempt: u32,
    pub timer_id: String,
    pub timer_schedule_event_ref: EventId,
    pub timer_schedule_event_digest: String,
    pub dispatch_event_ref: EventId,
    pub dispatch_envelope_digest: String,
    pub idempotency_key: String,
    /// Must equal the detached kernel signer actor during verified replay.
    pub fired_by: String,
    /// RFC3339 UTC timestamp bound to the enclosing event.
    pub fired_at: String,
}

/// Closed cancellation sources. An operator may request an interrupt, while a
/// deadline cancellation must be backed by an exact elapsed timer record.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowCancellationCauseV1 {
    OperatorRequested,
    TimerElapsed,
}

/// Signed request to stop a workflow before it reaches a target-branch effect.
/// This is a durable reducer state, not a terminal record: the kernel must
/// append a bound `workflow_terminal_v2` event after it has stopped further
/// advancement and reconciled in-flight work.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowCancellationRequestedV1 {
    pub run_id: String,
    pub workflow_id: String,
    pub workflow_revision: String,
    pub unit_id: String,
    pub attempt: u32,
    pub dispatch_event_ref: EventId,
    pub dispatch_envelope_digest: String,
    pub cancellation_id: String,
    pub cause: WorkflowCancellationCauseV1,
    /// Required only for a `timer_elapsed` cancellation. It must name the exact
    /// `workflow_timer_fired_v1` event that made the cancellation eligible.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timer_fired_event_ref: Option<EventId>,
    /// Canonical digest of `timer_fired_event_ref`, required together with it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timer_fired_event_digest: Option<String>,
    /// Must equal the detached operator or kernel signer actor during verified
    /// replay, according to `cause`.
    pub requested_by: String,
    pub idempotency_key: String,
    /// RFC3339 UTC timestamp bound to the enclosing event.
    pub requested_at: String,
}

/// `workflow_terminal` payload — reducer-owned terminal workflow snapshot.
/// Optional candidate/result links make failed pre-candidate workflows
/// representable without introducing an untyped terminal event.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowTerminalV1 {
    pub workflow_id: String,
    pub workflow_revision: String,
    /// Exact unit attempt so a pre-candidate failure remains unambiguous when
    /// a workflow dispatches several graph children concurrently.
    pub unit_id: String,
    pub attempt: u32,
    pub outcome: WorkflowTerminalOutcomeV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub promotion_result_ref: Option<String>,
    /// Exact operator-owned reconciliation resolution required to terminalize a
    /// `reconciliation_required` promotion result. It is absent for all other terminal
    /// paths, preserving older terminal tapes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reconciliation_resolution_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub idempotency_key: String,
    /// RFC3339 UTC timestamp.
    pub completed_at: String,
}

/// `workflow_terminal_v2` adds exact cancellation evidence without changing
/// the readable V1 terminal contract. Only V2 `cancelled` records can close a
/// newly requested cancellation; V1 tapes retain their historical semantics.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowTerminalV2 {
    pub workflow_id: String,
    pub workflow_revision: String,
    pub unit_id: String,
    pub attempt: u32,
    pub outcome: WorkflowTerminalOutcomeV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub promotion_result_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reconciliation_resolution_ref: Option<String>,
    /// Required for `cancelled`, absent for all other outcomes. This exact
    /// event reference prevents a terminal event from borrowing a neighboring
    /// cancellation request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancellation_request_event_ref: Option<EventId>,
    /// Canonical hash of `cancellation_request_event_ref`, required together
    /// with it for a cancelled terminal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancellation_request_event_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub idempotency_key: String,
    /// RFC3339 UTC timestamp.
    pub completed_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dispatch() -> DispatchEnvelopeV1 {
        DispatchEnvelopeV1 {
            workflow_id: "workflow-1".into(),
            workflow_revision: "r1".into(),
            unit_id: "unit-1".into(),
            attempt: 1,
            execution_role: ExecutionRoleV1::Implementer,
            commit_mode: CommitModeV1::Atomic,
            provenance_ref: "admission:1".into(),
            base_commit_sha: "a".repeat(40),
            capability_bundle_digest: format!("sha256:{}", "b".repeat(64)),
            acceptance_contract_digest: format!("sha256:{}", "c".repeat(64)),
            context_manifest_digest: format!("sha256:{}", "d".repeat(64)),
            worker_manifest_digest: format!("sha256:{}", "e".repeat(64)),
            sandbox_profile_digest: format!("sha256:{}", "f".repeat(64)),
            budget: DispatchBudgetV1 {
                max_tokens: Some(1024),
                max_compute_time_ms: Some(60_000),
            },
            trust_tier: TrustTierV1::Governed,
            idempotency_key: "dispatch:1".into(),
            issued_at: "2026-07-17T00:00:00Z".into(),
            expires_at: "2026-07-17T01:00:00Z".into(),
            envelope_digest: format!("sha256:{}", "1".repeat(64)),
            signature_ref: SignatureRefV1 {
                algorithm: "ed25519".into(),
                key_id: "kernel-1".into(),
                signature: "base64url".into(),
            },
        }
    }

    #[test]
    fn dispatch_envelope_v1_round_trips_as_a_closed_shape() {
        let payload = dispatch();
        let json = serde_json::to_string(&payload).unwrap();
        assert_eq!(
            payload,
            serde_json::from_str::<DispatchEnvelopeV1>(&json).unwrap()
        );

        let unknown = format!("{},\"unknown\":true}}", json.trim_end_matches('}'));
        assert!(serde_json::from_str::<DispatchEnvelopeV1>(&unknown).is_err());
    }

    #[test]
    fn trust_spine_enums_use_closed_snake_case_wire_values() {
        assert_eq!(
            serde_json::to_string(&ExecutionRoleV1::Reviewer).unwrap(),
            r#""reviewer""#
        );
        assert_eq!(
            serde_json::to_string(&PromotionDecisionKindV1::Promote).unwrap(),
            r#""promote""#
        );
        assert_eq!(
            serde_json::to_string(&ReconciliationResolutionOutcomeV1::Abandon).unwrap(),
            r#""abandon""#
        );
        assert!(serde_json::from_str::<ExecutionRoleV1>(r#""unknown""#).is_err());
        assert!(serde_json::from_str::<ReconciliationResolutionOutcomeV1>(r#""unknown""#).is_err());
    }
}
