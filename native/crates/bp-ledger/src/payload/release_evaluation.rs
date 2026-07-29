//! Closed release-evaluation evidence payloads.
//!
//! A `release_evaluation_evidence_v1` event is a signed, per-claim bridge
//! between an externally assembled release campaign and the ledger. It does
//! not decide whether a release is eligible: it makes every input used by the
//! TypeScript release gate an explicit, typed, and hash-bound claim. Consumers
//! must still verify that each referenced source event is covered by a trusted
//! signed tape.
//!
//! The claim digest is deliberately over the complete typed claim *and* its
//! release/policy bindings. A digest of only source references would let an
//! evaluator substitute metrics or invariant outcomes after the event was
//! signed.

use crate::error::{LedgerError, Result};
use crate::id::EventId;
use crate::payload::trust_spine::U64;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use typeshare::typeshare;

/// Current schema carried inside [`ReleaseEvaluationEvidenceV1`]. This is
/// intentionally distinct from the ledger event-envelope schema version: a
/// future claim schema must not be mistaken for a V1 release evaluation.
pub const RELEASE_EVALUATION_EVIDENCE_V1_SCHEMA_VERSION: u32 = 1;

/// Domain separator for [`release_evaluation_evidence_v1_claim_digest`].
pub const RELEASE_EVALUATION_EVIDENCE_V1_DIGEST_DOMAIN: &[u8] =
    b"buildplane.release-evaluation-evidence.v1\0";

const PAYLOAD_KIND: &str = "release_evaluation_evidence_v1";
const TYPESCRIPT_SAFE_INTEGER_MAX: u64 = 9_007_199_254_740_991;

/// `release_evaluation_evidence_v1` payload.
///
/// `claim_kind` is a closed wire discriminator. `claim` is a typed untagged
/// union so the discriminator remains a stable top-level field for the
/// TypeScript release gate; [`validate_release_evaluation_evidence_v1`]
/// rejects any discriminator/body mismatch before the payload is signed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseEvaluationEvidenceV1 {
    /// Must equal [`RELEASE_EVALUATION_EVIDENCE_V1_SCHEMA_VERSION`].
    pub schema_version: u32,
    /// Full lowercase Git object id (SHA-1 or SHA-256) being released.
    pub release_commit: String,
    /// Canonical target branch ref, always `refs/heads/<name>`.
    pub release_ref: String,
    /// Canonical SHA-256 digest of the pinned release policy.
    pub policy_digest: String,
    pub claim_kind: ReleaseEvaluationClaimKindV1,
    /// Actual gate input values, including the signed source-event references
    /// that support them. This must match [`Self::claim_kind`].
    pub claim: ReleaseEvaluationClaimV1,
    /// Domain-separated SHA-256 digest over every preceding field in this
    /// payload, including the complete typed claim and its source references.
    pub claim_digest: String,
}

/// Closed vocabulary for one release-evaluation claim.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseEvaluationClaimKindV1 {
    Trial,
    TargetBranchImmutability,
    BackwardReplayCompatibility,
    RequiredCheck,
}

/// Closed governance lane recorded for one evaluation trial.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseEvaluationGovernanceV1 {
    Governed,
    Raw,
}

/// Closed conclusion vocabulary for a required release check.
///
/// The release gate treats only `success` as resolved; every other conclusion
/// remains an unresolved required check.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseEvaluationCheckConclusionV1 {
    Success,
    Failure,
    Cancelled,
    Skipped,
    TimedOut,
    Neutral,
    ActionRequired,
}

/// An exact source event on a separately verified signed tape.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseEvaluationSourceEventRefV1 {
    pub source_event_id: EventId,
    pub source_canonical_event_hash: String,
}

/// Source-event roles required to support a complete trial claim.
///
/// Keeping the roles named rather than using an open map prevents an evaluator
/// from silently treating an incomplete or differently-shaped source set as a
/// complete trial.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseEvaluationTrialSourcesV1 {
    pub model_request: ReleaseEvaluationSourceEventRefV1,
    pub candidate: ReleaseEvaluationSourceEventRefV1,
    pub acceptance: ReleaseEvaluationSourceEventRefV1,
    pub review: ReleaseEvaluationSourceEventRefV1,
    pub recovery: ReleaseEvaluationSourceEventRefV1,
    pub terminal: ReleaseEvaluationSourceEventRefV1,
}

/// All report inputs for one evaluation trial.
///
/// `cost_usd_micros` is an exact integer amount; TypeScript derives
/// `costUsd` by dividing by 1,000,000. Integer metric fields avoid a
/// cross-runtime floating-point serialization ambiguity in the signed digest.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseEvaluationTrialClaimV1 {
    pub task_id: String,
    pub provider: String,
    pub trust_tier: String,
    /// Closed by validation to 1, 2, or 3.
    pub trial: u8,
    pub governance: ReleaseEvaluationGovernanceV1,
    pub passed: bool,
    pub cost_usd_micros: U64,
    pub latency_ms: U64,
    pub tokens: U64,
    pub tool_calls: u32,
    pub candidate_count: u32,
    pub reviewer_disagreed: bool,
    pub false_approval: bool,
    /// Any effect attempted or completed without matching authority. This is
    /// deliberately distinct from broader safety findings because GA requires
    /// this count to be exactly zero.
    pub unauthorized_effects: u32,
    pub duplicate_effects: u32,
    pub safety_violations: u32,
    pub recovery_correct: bool,
    pub illegitimate_success: bool,
    pub sources: ReleaseEvaluationTrialSourcesV1,
}

/// The target branch was immutable at the release binding.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseEvaluationTargetBranchImmutabilityClaimV1 {
    pub immutable: bool,
    pub source: ReleaseEvaluationSourceEventRefV1,
}

/// Backward replay compatibility for the release commit.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseEvaluationBackwardReplayCompatibilityClaimV1 {
    pub compatible: bool,
    pub source: ReleaseEvaluationSourceEventRefV1,
}

/// One required CI/check conclusion for the release commit.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseEvaluationRequiredCheckClaimV1 {
    pub name: String,
    pub conclusion: ReleaseEvaluationCheckConclusionV1,
    pub source: ReleaseEvaluationSourceEventRefV1,
}

/// Typed value of a [`ReleaseEvaluationEvidenceV1`] claim.
///
/// The surrounding `claim_kind` supplies the discriminator on the wire. Every
/// variant body denies unknown fields and validation requires the body to be
/// the one named by that discriminator.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ReleaseEvaluationClaimV1 {
    Trial(ReleaseEvaluationTrialClaimV1),
    TargetBranchImmutability(ReleaseEvaluationTargetBranchImmutabilityClaimV1),
    BackwardReplayCompatibility(ReleaseEvaluationBackwardReplayCompatibilityClaimV1),
    RequiredCheck(ReleaseEvaluationRequiredCheckClaimV1),
}

#[derive(Serialize)]
struct ReleaseEvaluationEvidenceDigestMaterial<'a> {
    schema_version: u32,
    release_commit: &'a str,
    release_ref: &'a str,
    policy_digest: &'a str,
    claim_kind: ReleaseEvaluationClaimKindV1,
    claim: &'a ReleaseEvaluationClaimV1,
}

/// Return the deterministic claim digest for a V1 release-evaluation event.
///
/// The bytes are the declaration-ordered Rust `serde_json` encoding of the
/// typed material (with no `claim_digest` field), prefixed with
/// [`RELEASE_EVALUATION_EVIDENCE_V1_DIGEST_DOMAIN`]. All metric fields are
/// integral and bounded to JavaScript-safe values by validation, so a
/// TypeScript consumer can reproduce this exact JSON representation.
pub fn release_evaluation_evidence_v1_claim_digest(
    evidence: &ReleaseEvaluationEvidenceV1,
) -> std::result::Result<String, serde_json::Error> {
    let material = ReleaseEvaluationEvidenceDigestMaterial {
        schema_version: evidence.schema_version,
        release_commit: &evidence.release_commit,
        release_ref: &evidence.release_ref,
        policy_digest: &evidence.policy_digest,
        claim_kind: evidence.claim_kind,
        claim: &evidence.claim,
    };
    let bytes = serde_json::to_vec(&material)?;
    let mut hasher = Sha256::new();
    hasher.update(RELEASE_EVALUATION_EVIDENCE_V1_DIGEST_DOMAIN);
    hasher.update(bytes);
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

/// Validate the closed V1 shape and its detached claim digest.
///
/// The canonicalization layer calls this before signing or persisting the
/// payload. It intentionally does not resolve source references: that requires
/// the signed tape(s) presented by the release gate.
pub fn validate_release_evaluation_evidence_v1(
    evidence: &ReleaseEvaluationEvidenceV1,
) -> Result<()> {
    if evidence.schema_version != RELEASE_EVALUATION_EVIDENCE_V1_SCHEMA_VERSION {
        return invalid(format!(
            "schema_version must equal {RELEASE_EVALUATION_EVIDENCE_V1_SCHEMA_VERSION}"
        ));
    }
    if !is_canonical_git_object_id(&evidence.release_commit) {
        return invalid("release_commit must be a full lowercase Git object id");
    }
    if !is_canonical_release_ref(&evidence.release_ref) {
        return invalid("release_ref must be a canonical refs/heads/<name> reference");
    }
    validate_sha256("policy_digest", &evidence.policy_digest)?;
    validate_claim_shape(evidence)?;
    validate_sha256("claim_digest", &evidence.claim_digest)?;

    let expected = release_evaluation_evidence_v1_claim_digest(evidence)?;
    if evidence.claim_digest != expected {
        return invalid("claim_digest does not match the complete typed release-evaluation claim");
    }
    Ok(())
}

fn validate_claim_shape(evidence: &ReleaseEvaluationEvidenceV1) -> Result<()> {
    match (&evidence.claim_kind, &evidence.claim) {
        (ReleaseEvaluationClaimKindV1::Trial, ReleaseEvaluationClaimV1::Trial(claim)) => {
            validate_trial(claim)
        }
        (
            ReleaseEvaluationClaimKindV1::TargetBranchImmutability,
            ReleaseEvaluationClaimV1::TargetBranchImmutability(claim),
        ) => validate_source("claim.source", &claim.source),
        (
            ReleaseEvaluationClaimKindV1::BackwardReplayCompatibility,
            ReleaseEvaluationClaimV1::BackwardReplayCompatibility(claim),
        ) => validate_source("claim.source", &claim.source),
        (
            ReleaseEvaluationClaimKindV1::RequiredCheck,
            ReleaseEvaluationClaimV1::RequiredCheck(claim),
        ) => {
            validate_identifier("claim.name", &claim.name)?;
            validate_source("claim.source", &claim.source)
        }
        _ => invalid("claim_kind does not match the typed claim body"),
    }
}

fn validate_trial(claim: &ReleaseEvaluationTrialClaimV1) -> Result<()> {
    validate_identifier("claim.task_id", &claim.task_id)?;
    validate_release_dimension("claim.provider", &claim.provider)?;
    validate_release_dimension("claim.trust_tier", &claim.trust_tier)?;
    if !matches!(claim.trial, 1..=3) {
        return invalid("claim.trial must be 1, 2, or 3");
    }
    for (field, value) in [
        ("claim.cost_usd_micros", claim.cost_usd_micros),
        ("claim.latency_ms", claim.latency_ms),
        ("claim.tokens", claim.tokens),
    ] {
        if value > TYPESCRIPT_SAFE_INTEGER_MAX {
            return invalid(format!(
                "{field} exceeds JavaScript Number.MAX_SAFE_INTEGER ({TYPESCRIPT_SAFE_INTEGER_MAX})"
            ));
        }
    }

    let sources = [
        ("claim.sources.model_request", &claim.sources.model_request),
        ("claim.sources.candidate", &claim.sources.candidate),
        ("claim.sources.acceptance", &claim.sources.acceptance),
        ("claim.sources.review", &claim.sources.review),
        ("claim.sources.recovery", &claim.sources.recovery),
        ("claim.sources.terminal", &claim.sources.terminal),
    ];
    let mut source_ids = HashSet::with_capacity(sources.len());
    for (field, source) in sources {
        validate_source(field, source)?;
        if !source_ids.insert(source.source_event_id) {
            return invalid("claim.sources must name six distinct source events");
        }
    }
    Ok(())
}

fn validate_source(label: &str, source: &ReleaseEvaluationSourceEventRefV1) -> Result<()> {
    validate_sha256(
        &format!("{label}.source_canonical_event_hash"),
        &source.source_canonical_event_hash,
    )
}

fn validate_identifier(field: &str, value: &str) -> Result<()> {
    if value.is_empty()
        || value.trim() != value
        || value
            .chars()
            .any(|character| character.is_control() || character == '\0')
    {
        return invalid(format!("{field} must be a non-empty, trimmed identifier"));
    }
    Ok(())
}

fn validate_release_dimension(field: &str, value: &str) -> Result<()> {
    validate_identifier(field, value)?;
    if value.contains('/') {
        return invalid(format!("{field} must not contain '/'"));
    }
    Ok(())
}

fn validate_sha256(field: &str, value: &str) -> Result<()> {
    if !is_canonical_sha256_digest(value) {
        return invalid(format!("{field} must be a canonical sha256 digest"));
    }
    Ok(())
}

fn is_canonical_sha256_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value.as_bytes()[7..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn is_canonical_git_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn is_canonical_release_ref(value: &str) -> bool {
    let Some(branch) = value.strip_prefix("refs/heads/") else {
        return false;
    };
    if branch.is_empty()
        || branch.ends_with('/')
        || branch.ends_with('.')
        || branch.ends_with(".lock")
        || branch.contains("..")
        || branch.contains("//")
        || branch.contains("@{")
    {
        return false;
    }
    branch.split('/').all(|component| {
        !component.is_empty()
            && !component.starts_with('.')
            && !component.ends_with('.')
            && component != "@"
            && component.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '@')
            })
    })
}

fn invalid(reason: impl Into<String>) -> Result<()> {
    Err(LedgerError::InvalidPayload {
        kind: PAYLOAD_KIND.to_string(),
        reason: reason.into(),
    })
}
