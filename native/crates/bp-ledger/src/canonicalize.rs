//! Per-(kind, version) payload canonicalization.
//!
//! At v1, `canonicalize` is the identity: every stored event is already in
//! canonical shape. The function exists so v2+ can add migration logic without
//! changing callers.

use crate::error::{LedgerError, Result};
use crate::event::Event;
use crate::payload::activity_claim::{
    validate_activity_claimed_v1, validate_activity_heartbeat_recorded_v1,
    validate_activity_result_recorded_v1,
};
use crate::payload::release_evaluation::validate_release_evaluation_evidence_v1;
use crate::payload::trust_spine::{
    action_receipt_recorded_v2_digest, action_receipt_set_v1_digest, action_requested_v2_digest,
    attempt_context_recorded_v1_digest, candidate_completion_recorded_v1_digest,
    candidate_view_v1_digest, dispatch_envelope_v2_body_digest, dispatch_envelope_v3_body_digest,
    dispatch_envelope_v4_digest, model_action_authorized_v1_digest,
    model_action_authorized_v2_digest, model_action_intent_v1_digest,
    promotion_execution_claimed_v1_digest, review_verdict_output_v1_digest,
    workflow_graph_v1_digest, workflow_graph_v2_digest, ActionEvidenceVersionV1,
    ActionReceiptOutcomeV2, ActionReceiptRecordedV2, ActionReceiptSetRecordedV1, ActionRequestedV2,
    AttemptContextRecordedV1, CandidateCompletionRecordedV1, CandidateCreatedV1,
    CandidateCreatedV2, CandidateViewV1, CommitModeV1, DispatchEnvelopeBodyV2, DispatchEnvelopeV3,
    DispatchEnvelopeV4, ExecutionRoleV1, ModelActionAuthorizedV1, ModelActionAuthorizedV2,
    ModelActionCandidateBindingV1, ModelActionIntentV1, ModelRequestEvidenceV1,
    PromotionApprovalRequestedV1, PromotionDecisionRecordedV1, PromotionExecutionClaimedV1,
    PromotionExecutionLeaseBindingV1, PromotionGitBindingV1, PromotionReconciliationResolvedV1,
    PromotionResultOutcomeV1, PromotionResultRecordedV1, PromotionWorktreeSyncStateV1,
    ReviewVerdictOutputV1, ReviewVerdictRecordedV2, TrustScopeEvidenceV1, TrustTierV1,
    WorkflowCancellationCauseV1, WorkflowCancellationRequestedV1, WorkflowGraphDeclaredV1,
    WorkflowGraphDeclaredV2, WorkflowGraphNodeV1, WorkflowGraphNodeV2, WorkflowTerminalOutcomeV1,
    WorkflowTerminalV2, WorkflowTimerFiredV1, WorkflowTimerScheduledV1,
    MODEL_REQUEST_EVIDENCE_V1_SCHEMA_VERSION, TRUST_SCOPE_EVIDENCE_V1_SCHEMA_VERSION,
};
use crate::payload::Payload;
use crate::storage::cas::CanonicalCasRef;
use chrono::DateTime;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

/// The only Git-ref namespace that can name a Buildplane candidate.
pub const BUILDPANE_CANDIDATE_REF_PREFIX: &str = "refs/buildplane/candidates/";

/// Return whether `candidate_ref` is a canonical Buildplane candidate ref.
///
/// Candidate refs are capability-bearing Git identifiers, so this intentionally
/// uses a stricter grammar than Git's general ref syntax: the fixed namespace
/// is followed by one or more slash-separated ASCII segments, each beginning
/// with an alphanumeric byte and then containing only alphanumeric bytes,
/// dots, underscores, or hyphens. This keeps candidate creation, review views,
/// and promotion receipts on one traversal-safe namespace.
pub fn is_canonical_buildplane_candidate_ref(candidate_ref: &str) -> bool {
    let Some(suffix) = candidate_ref.strip_prefix(BUILDPANE_CANDIDATE_REF_PREFIX) else {
        return false;
    };

    is_canonical_buildplane_ref_suffix(candidate_ref, suffix)
}

fn is_canonical_buildplane_promotion_receipt_ref(receipt_ref: &str) -> bool {
    let Some(suffix) = receipt_ref.strip_prefix("refs/buildplane/promotions/") else {
        return false;
    };

    is_canonical_buildplane_ref_suffix(receipt_ref, suffix)
}

fn is_canonical_buildplane_ref_suffix(reference: &str, suffix: &str) -> bool {
    if suffix.is_empty()
        || !reference.is_ascii()
        || reference
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
        || reference.contains("..")
        || reference.contains("//")
        || reference.contains("@{")
    {
        return false;
    }

    suffix.split('/').all(|segment| {
        !segment.is_empty()
            && !segment.starts_with('.')
            && !segment.ends_with('.')
            && !segment.ends_with(".lock")
            && segment.bytes().enumerate().all(|(index, byte)| {
                byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
            })
    })
}

fn is_canonical_target_ref(value: &str) -> bool {
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

/// Canonicalize an event's payload, applying migrations if necessary.
///
/// Reads the envelope's `schema_version` and, if supported, returns the event
/// with its payload in the canonical (latest) shape. On v1 this is a passthrough.
pub fn canonicalize(event: Event) -> Result<Event> {
    if event.schema_version != Event::CURRENT_SCHEMA_VERSION {
        return Err(LedgerError::UnsupportedSchemaVersion {
            received: event.schema_version,
            supported: Event::CURRENT_SCHEMA_VERSION,
        });
    }
    validate_kind_matches_payload(event.kind_str(), &event.payload)?;
    validate_event_semantics(&event)?;
    validate_payload_semantics(event.kind_str(), &event.payload)?;
    Ok(event)
}

/// Return the SHA-256 digest of the canonical serialized event bytes.
///
/// The returned value is formatted as `sha256:<hex>` for detached signatures.
pub fn canonical_event_hash(event: &Event) -> Result<String> {
    let bytes = canonical_event_bytes(event)?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

/// Serialize an event in the canonical v1 envelope form used for signing.
///
/// Signatures are detached from events, so these bytes are computed only from
/// the event envelope and payload after [`canonicalize`] has validated/migrated
/// the event.
pub fn canonical_event_bytes(event: &Event) -> Result<Vec<u8>> {
    let canonical = canonicalize(event.clone())?;
    Ok(serde_json::to_vec(&canonical)?)
}

/// Same as [`canonicalize`] but operates on a stored payload JSON value when
/// you already know the kind and version. Useful for storage-layer reads that
/// don't reconstitute the full envelope.
///
/// The `payload` argument must be the JSON representation of a [`Payload`]
/// value as written by `serde_json::to_string(&event.payload)` — i.e. an
/// externally-tagged enum object such as `{"WorkspaceReadV1": {...}}`.
pub fn canonicalize_payload(
    kind: &str,
    version: u32,
    payload: serde_json::Value,
) -> Result<Payload> {
    if version != Event::CURRENT_SCHEMA_VERSION {
        return Err(LedgerError::UnsupportedSchemaVersion {
            received: version,
            supported: Event::CURRENT_SCHEMA_VERSION,
        });
    }
    let payload = serde_json::from_value::<Payload>(payload).map_err(LedgerError::from)?;
    validate_kind_matches_payload(kind, &payload)?;
    validate_payload_semantics(kind, &payload)?;
    Ok(payload)
}

fn validate_kind_matches_payload(kind: &str, payload: &Payload) -> Result<()> {
    let expected_variant = kind_to_variant(kind)?;
    if payload_variant_name(payload) != expected_variant {
        return Err(LedgerError::InvalidPayload {
            kind: kind.to_string(),
            reason: format!("payload missing expected variant key '{expected_variant}'"),
        });
    }
    Ok(())
}

/// Validate envelope-to-payload invariants that require both representations.
///
/// Payload-only canonicalization remains available for historical storage reads,
/// where the enclosing event envelope is not available to bind against.
fn validate_event_semantics(event: &Event) -> Result<()> {
    match &event.payload {
        Payload::WorkflowGraphDeclaredV1(declaration) => {
            if declaration.run_id != event.run_id.to_string() {
                return invalid(
                    event.kind_str(),
                    "workflow graph declaration run_id must match the enclosing event run_id",
                );
            }
        }
        Payload::WorkflowGraphDeclaredV2(declaration) => {
            if declaration.run_id != event.run_id.to_string() {
                return invalid(
                    event.kind_str(),
                    "workflow graph declaration run_id must match the enclosing event run_id",
                );
            }
        }
        _ => {}
    }
    match &event.payload {
        Payload::WorkflowTimerScheduledV1(timer) if timer.run_id != event.run_id.to_string() => {
            return invalid(
                event.kind_str(),
                "workflow timer schedule run_id must match the enclosing event run_id",
            );
        }
        Payload::WorkflowTimerFiredV1(timer) if timer.run_id != event.run_id.to_string() => {
            return invalid(
                event.kind_str(),
                "workflow timer fired run_id must match the enclosing event run_id",
            );
        }
        Payload::WorkflowCancellationRequestedV1(cancellation)
            if cancellation.run_id != event.run_id.to_string() =>
        {
            return invalid(
                event.kind_str(),
                "workflow cancellation run_id must match the enclosing event run_id",
            );
        }
        Payload::PromotionExecutionClaimedV1(claim) if claim.run_id != event.run_id.to_string() => {
            return invalid(
                event.kind_str(),
                "promotion execution claim run_id must match the enclosing event run_id",
            );
        }
        _ => {}
    }
    Ok(())
}

/// Validate payload invariants that cannot be expressed by serde structural
/// decoding alone. This belongs in canonicalization so every normal ingest path
/// rejects malformed authority-bearing payloads before signing or persistence.
fn validate_payload_semantics(kind: &str, payload: &Payload) -> Result<()> {
    match payload {
        Payload::DispatchEnvelopeV2(envelope) => {
            let expected = dispatch_envelope_v2_body_digest(&envelope.body).map_err(|error| {
                LedgerError::InvalidPayload {
                    kind: kind.to_string(),
                    reason: format!("could not canonicalize V2 dispatch body: {error}"),
                }
            })?;
            if envelope.envelope_digest != expected {
                return Err(LedgerError::InvalidPayload {
                    kind: kind.to_string(),
                    reason: "envelope_digest does not match the canonical V2 dispatch body digest"
                        .into(),
                });
            }
        }
        Payload::DispatchEnvelopeV3(envelope) => {
            validate_dispatch_envelope_v3_shape(kind, envelope)?;
        }
        Payload::DispatchEnvelopeV4(envelope) => {
            validate_dispatch_envelope_v4_shape(kind, envelope)?;
        }
        Payload::ActionRequestedV2(request) => {
            validate_action_request_shape(kind, request)?;
            action_requested_v2_digest(request).map_err(|error| LedgerError::InvalidPayload {
                kind: kind.to_string(),
                reason: format!("could not canonicalize V2 action request: {error}"),
            })?;
        }
        Payload::ModelActionIntentV1(intent) => {
            validate_model_action_intent_shape(kind, intent)?;
            let expected = model_action_intent_v1_digest(intent).map_err(|error| {
                LedgerError::InvalidPayload {
                    kind: kind.to_string(),
                    reason: format!("could not canonicalize model action intent: {error}"),
                }
            })?;
            if intent.intent_digest != expected {
                return Err(LedgerError::InvalidPayload {
                    kind: kind.to_string(),
                    reason: "intent_digest does not match the canonical model action intent".into(),
                });
            }
        }
        Payload::ModelActionAuthorizedV1(authorization) => {
            validate_model_action_authorized_shape(kind, authorization)?;
            let expected = model_action_authorized_v1_digest(authorization).map_err(|error| {
                LedgerError::InvalidPayload {
                    kind: kind.to_string(),
                    reason: format!("could not canonicalize model action authorization: {error}"),
                }
            })?;
            if authorization.authorization_digest != expected {
                return Err(LedgerError::InvalidPayload {
                    kind: kind.to_string(),
                    reason: "authorization_digest does not match the canonical model action authorization"
                        .into(),
                });
            }
        }
        Payload::ModelActionAuthorizedV2(authorization) => {
            validate_model_action_authorized_v2_shape(kind, authorization)?;
            let expected = model_action_authorized_v2_digest(authorization).map_err(|error| {
                LedgerError::InvalidPayload {
                    kind: kind.to_string(),
                    reason: format!(
                        "could not canonicalize model action authorization v2: {error}"
                    ),
                }
            })?;
            if authorization.authorization_digest != expected {
                return Err(LedgerError::InvalidPayload {
                    kind: kind.to_string(),
                    reason: "authorization_digest does not match the canonical model action authorization v2"
                        .into(),
                });
            }
        }
        Payload::ActivityClaimedV1(claim) => validate_activity_claimed_v1(claim)?,
        Payload::ActivityHeartbeatRecordedV1(heartbeat) => {
            validate_activity_heartbeat_recorded_v1(heartbeat)?
        }
        Payload::ActivityResultRecordedV1(result) => validate_activity_result_recorded_v1(result)?,
        Payload::ActionReceiptRecordedV2(receipt) => {
            validate_action_receipt_shape(kind, receipt)?;
            action_receipt_recorded_v2_digest(receipt).map_err(|error| {
                LedgerError::InvalidPayload {
                    kind: kind.to_string(),
                    reason: format!("could not canonicalize V2 action receipt: {error}"),
                }
            })?;
        }
        Payload::ActionReceiptSetRecordedV1(set) => {
            validate_action_receipt_set_shape(kind, set)?;
            let expected =
                action_receipt_set_v1_digest(set).map_err(|error| LedgerError::InvalidPayload {
                    kind: kind.to_string(),
                    reason: format!("could not canonicalize action receipt set: {error}"),
                })?;
            if set.action_receipt_set_digest != expected {
                return Err(LedgerError::InvalidPayload {
                    kind: kind.to_string(),
                    reason: "action_receipt_set_digest does not match its canonical sealed set"
                        .into(),
                });
            }
        }
        Payload::AttemptContextRecordedV1(context) => {
            validate_attempt_context_recorded_v1_shape(kind, context)?;
            let expected = attempt_context_recorded_v1_digest(context).map_err(|error| {
                LedgerError::InvalidPayload {
                    kind: kind.to_string(),
                    reason: format!("could not canonicalize attempt context: {error}"),
                }
            })?;
            if context.attempt_context_digest != expected {
                return Err(LedgerError::InvalidPayload {
                    kind: kind.to_string(),
                    reason: "attempt_context_digest does not match its canonical retry lineage"
                        .into(),
                });
            }
        }
        Payload::WorkflowGraphDeclaredV1(declaration) => {
            validate_workflow_graph_declared_v1_shape(kind, declaration)?;
            let expected = workflow_graph_v1_digest(declaration).map_err(|error| {
                LedgerError::InvalidPayload {
                    kind: kind.to_string(),
                    reason: format!("could not canonicalize workflow graph declaration: {error}"),
                }
            })?;
            if declaration.graph_digest != expected {
                return Err(LedgerError::InvalidPayload {
                    kind: kind.to_string(),
                    reason: "graph_digest does not match the canonical workflow graph".into(),
                });
            }
        }
        Payload::WorkflowGraphDeclaredV2(declaration) => {
            validate_workflow_graph_declared_v2_shape(kind, declaration)?;
            let expected = workflow_graph_v2_digest(declaration).map_err(|error| {
                LedgerError::InvalidPayload {
                    kind: kind.to_string(),
                    reason: format!(
                        "could not canonicalize workflow graph declaration v2: {error}"
                    ),
                }
            })?;
            if declaration.graph_digest != expected {
                return Err(LedgerError::InvalidPayload {
                    kind: kind.to_string(),
                    reason: "graph_digest does not match the canonical V2 workflow graph".into(),
                });
            }
        }
        Payload::CandidateCreatedV1(candidate) => {
            validate_candidate_v1_shape(kind, candidate)?;
        }
        Payload::CandidateCreatedV2(candidate) => {
            validate_candidate_v2_shape(kind, candidate)?;
        }
        Payload::CandidateCompletionRecordedV1(completion) => {
            validate_candidate_completion_recorded_v1_shape(kind, completion)?;
            let expected =
                candidate_completion_recorded_v1_digest(completion).map_err(|error| {
                    LedgerError::InvalidPayload {
                        kind: kind.to_string(),
                        reason: format!("could not canonicalize candidate completion: {error}"),
                    }
                })?;
            if completion.completion_digest != expected {
                return Err(LedgerError::InvalidPayload {
                    kind: kind.to_string(),
                    reason: "completion_digest does not match the canonical candidate completion"
                        .into(),
                });
            }
        }
        Payload::ReviewVerdictRecordedV2(review) => {
            validate_review_verdict_v2_shape(kind, review)?;
        }
        Payload::PromotionApprovalRequestedV1(request) => {
            validate_promotion_approval_requested_v1_shape(kind, request)?;
        }
        Payload::PromotionDecisionRecordedV1(decision) => {
            validate_promotion_decision_recorded_v1_shape(kind, decision)?;
        }
        Payload::PromotionExecutionClaimedV1(claim) => {
            validate_promotion_execution_claimed_v1_shape(kind, claim)?;
            let expected = promotion_execution_claimed_v1_digest(claim).map_err(|error| {
                LedgerError::InvalidPayload {
                    kind: kind.to_string(),
                    reason: format!("could not canonicalize promotion execution claim: {error}"),
                }
            })?;
            if claim.promotion_execution_claim_digest != expected {
                return Err(LedgerError::InvalidPayload {
                    kind: kind.to_string(),
                    reason: "promotion_execution_claim_digest does not match the canonical promotion execution claim".into(),
                });
            }
        }
        Payload::PromotionResultRecordedV1(result) => {
            validate_promotion_result_recorded_v1_shape(kind, result)?;
        }
        Payload::PromotionReconciliationResolvedV1(resolution) => {
            validate_promotion_reconciliation_resolved_v1_shape(kind, resolution)?;
        }
        Payload::ReleaseEvaluationEvidenceV1(evidence) => {
            validate_release_evaluation_evidence_v1(evidence)?;
        }
        Payload::WorkflowTimerScheduledV1(timer) => {
            validate_workflow_timer_scheduled_v1_shape(kind, timer)?;
        }
        Payload::WorkflowTimerFiredV1(timer) => {
            validate_workflow_timer_fired_v1_shape(kind, timer)?;
        }
        Payload::WorkflowCancellationRequestedV1(cancellation) => {
            validate_workflow_cancellation_requested_v1_shape(kind, cancellation)?;
        }
        Payload::WorkflowTerminalV2(terminal) => {
            validate_workflow_terminal_v2_shape(kind, terminal)?;
        }
        _ => {}
    }

    Ok(())
}

fn validate_action_request_shape(kind: &str, request: &ActionRequestedV2) -> Result<()> {
    validate_non_empty_fields(
        kind,
        [
            ("run_id", request.run_id.as_str()),
            ("workflow_id", request.workflow_id.as_str()),
            ("unit_id", request.unit_id.as_str()),
            ("provenance_ref", request.provenance_ref.as_str()),
            ("action_id", request.action_id.as_str()),
            ("idempotency_key", request.idempotency_key.as_str()),
            ("canonical_input_ref", request.canonical_input_ref.as_str()),
            ("authority_actor", request.authority_actor.as_str()),
        ],
    )?;
    if request.attempt == 0 {
        return invalid(kind, "action request attempt must be greater than zero");
    }
    validate_sha256_fields(
        kind,
        [
            (
                "canonical_input_digest",
                request.canonical_input_digest.as_str(),
            ),
            (
                "dispatch_envelope_digest",
                request.dispatch_envelope_digest.as_str(),
            ),
            (
                "repository_binding_digest",
                request.repository_binding_digest.as_str(),
            ),
            (
                "ledger_authority_realm_digest",
                request.ledger_authority_realm_digest.as_str(),
            ),
            (
                "capability_bundle_digest",
                request.capability_bundle_digest.as_str(),
            ),
            ("policy_digest", request.policy_digest.as_str()),
            (
                "context_manifest_digest",
                request.context_manifest_digest.as_str(),
            ),
            (
                "worker_manifest_digest",
                request.worker_manifest_digest.as_str(),
            ),
            (
                "sandbox_profile_digest",
                request.sandbox_profile_digest.as_str(),
            ),
        ],
    )?;
    if let Some(packet_digest) = request.governed_packet_digest.as_deref() {
        validate_sha256_fields(kind, [("governed_packet_digest", packet_digest)])?;
    }
    validate_rfc3339_utc(kind, "requested_at", &request.requested_at)
}

fn validate_model_action_authorized_shape(
    kind: &str,
    authorization: &ModelActionAuthorizedV1,
) -> Result<()> {
    validate_non_empty_fields(
        kind,
        [
            ("run_id", authorization.run_id.as_str()),
            ("workflow_id", authorization.workflow_id.as_str()),
            ("unit_id", authorization.unit_id.as_str()),
            ("provenance_ref", authorization.provenance_ref.as_str()),
            ("action_id", authorization.action_id.as_str()),
            ("idempotency_key", authorization.idempotency_key.as_str()),
            (
                "dispatch_event_ref",
                authorization.dispatch_event_ref.as_str(),
            ),
            (
                "action_request_ref",
                authorization.action_request_ref.as_str(),
            ),
            (
                "authorization_actor",
                authorization.authorization_actor.as_str(),
            ),
            (
                "authorization_ref",
                authorization.authorization_ref.as_str(),
            ),
        ],
    )?;
    if authorization.attempt == 0 {
        return invalid(
            kind,
            "model action authorization attempt must be greater than zero",
        );
    }
    let has_candidate_binding = match (
        authorization.candidate_digest.as_deref(),
        authorization.candidate_view_digest.as_deref(),
    ) {
        (Some(candidate_digest), Some(candidate_view_digest)) => {
            validate_sha256_fields(
                kind,
                [
                    ("candidate_digest", candidate_digest),
                    ("candidate_view_digest", candidate_view_digest),
                ],
            )?;
            true
        }
        (None, None) => false,
        _ => {
            return invalid(
                kind,
                "model action authorization candidate_digest and candidate_view_digest must be present or absent together",
            )
        }
    };
    match authorization.execution_role {
        ExecutionRoleV1::Implementer if has_candidate_binding => {
            return invalid(
                kind,
                "implementer model action authorization must not carry candidate or candidate view bindings",
            )
        }
        ExecutionRoleV1::Reviewer | ExecutionRoleV1::Adversary | ExecutionRoleV1::Judge
            if !has_candidate_binding =>
        {
            return invalid(
                kind,
                "reviewer, adversary, and judge model action authorizations require candidate and candidate view bindings",
            )
        }
        ExecutionRoleV1::Candidate => {
            return invalid(
                kind,
                "candidate execution role cannot receive model action authorization",
            )
        }
        _ => {}
    }
    if !is_canonical_authority_actor(&authorization.authorization_actor) {
        return invalid(
            kind,
            "authorization_actor must be a canonical non-whitespace actor identifier",
        );
    }
    validate_sha256_fields(
        kind,
        [
            (
                "dispatch_envelope_digest",
                authorization.dispatch_envelope_digest.as_str(),
            ),
            (
                "action_request_digest",
                authorization.action_request_digest.as_str(),
            ),
            ("packet_digest", authorization.packet_digest.as_str()),
            (
                "canonical_input_digest",
                authorization.canonical_input_digest.as_str(),
            ),
            (
                "model_request_digest",
                authorization.model_request_digest.as_str(),
            ),
            (
                "trust_scope_digest",
                authorization.trust_scope_digest.as_str(),
            ),
            (
                "context_manifest_digest",
                authorization.context_manifest_digest.as_str(),
            ),
            ("policy_digest", authorization.policy_digest.as_str()),
            (
                "sandbox_profile_digest",
                authorization.sandbox_profile_digest.as_str(),
            ),
            (
                "authorization_digest",
                authorization.authorization_digest.as_str(),
            ),
        ],
    )?;
    validate_rfc3339_utc(kind, "expires_at", &authorization.expires_at)
}

fn validate_model_action_intent_shape(kind: &str, intent: &ModelActionIntentV1) -> Result<()> {
    validate_non_empty_fields(
        kind,
        [
            ("run_id", intent.run_id.as_str()),
            ("workflow_id", intent.workflow_id.as_str()),
            ("unit_id", intent.unit_id.as_str()),
            ("provenance_ref", intent.provenance_ref.as_str()),
            ("action_id", intent.action_id.as_str()),
            ("idempotency_key", intent.idempotency_key.as_str()),
            ("canonical_input_ref", intent.canonical_input_ref.as_str()),
            ("intent_actor", intent.intent_actor.as_str()),
        ],
    )?;
    if intent.attempt == 0 {
        return invalid(
            kind,
            "model action intent attempt must be greater than zero",
        );
    }
    validate_sha256_fields(
        kind,
        [
            (
                "dispatch_envelope_digest",
                intent.dispatch_envelope_digest.as_str(),
            ),
            (
                "action_request_digest",
                intent.action_request_digest.as_str(),
            ),
            (
                "canonical_input_digest",
                intent.canonical_input_digest.as_str(),
            ),
            ("intent_digest", intent.intent_digest.as_str()),
        ],
    )?;
    validate_canonical_cas_ref(kind, "canonical_input_ref", &intent.canonical_input_ref)?;
    validate_model_request_evidence_shape(kind, &intent.model_request_evidence)?;
    validate_trust_scope_evidence_shape(kind, &intent.trust_scope_evidence)?;
    if let Some(binding) = intent.candidate_binding.as_ref() {
        validate_model_action_candidate_binding_shape(kind, binding)?;
    }
    if !is_canonical_authority_actor(&intent.intent_actor) {
        return invalid(
            kind,
            "intent_actor must be a canonical non-whitespace actor identifier",
        );
    }
    validate_rfc3339_utc(kind, "intended_at", &intent.intended_at)
}

fn validate_model_action_authorized_v2_shape(
    kind: &str,
    authorization: &ModelActionAuthorizedV2,
) -> Result<()> {
    validate_non_empty_fields(
        kind,
        [
            (
                "authorization_actor",
                authorization.authorization_actor.as_str(),
            ),
            (
                "authorization_ref",
                authorization.authorization_ref.as_str(),
            ),
        ],
    )?;
    validate_sha256_fields(
        kind,
        [
            ("intent_digest", authorization.intent_digest.as_str()),
            (
                "authorization_digest",
                authorization.authorization_digest.as_str(),
            ),
        ],
    )?;
    validate_model_request_evidence_shape(kind, &authorization.model_request_evidence)?;
    validate_trust_scope_evidence_shape(kind, &authorization.trust_scope_evidence)?;
    if let Some(binding) = authorization.candidate_binding.as_ref() {
        validate_model_action_candidate_binding_shape(kind, binding)?;
    }
    if !is_canonical_authority_actor(&authorization.authorization_actor) {
        return invalid(
            kind,
            "authorization_actor must be a canonical non-whitespace actor identifier",
        );
    }
    validate_rfc3339_utc(kind, "expires_at", &authorization.expires_at)
}

fn validate_model_request_evidence_shape(
    kind: &str,
    evidence: &ModelRequestEvidenceV1,
) -> Result<()> {
    validate_versioned_cas_evidence_shape(
        kind,
        "model_request_evidence",
        evidence.schema_version,
        &evidence.cas_ref,
        &evidence.digest,
        MODEL_REQUEST_EVIDENCE_V1_SCHEMA_VERSION,
    )
}

fn validate_trust_scope_evidence_shape(kind: &str, evidence: &TrustScopeEvidenceV1) -> Result<()> {
    validate_versioned_cas_evidence_shape(
        kind,
        "trust_scope_evidence",
        evidence.schema_version,
        &evidence.cas_ref,
        &evidence.digest,
        TRUST_SCOPE_EVIDENCE_V1_SCHEMA_VERSION,
    )
}

fn validate_versioned_cas_evidence_shape(
    kind: &str,
    field: &str,
    schema_version: u32,
    cas_ref: &str,
    digest: &str,
    expected_schema_version: u32,
) -> Result<()> {
    if schema_version != expected_schema_version {
        return invalid(
            kind,
            format!(
                "{field}.schema_version must equal the closed V{expected_schema_version} schema"
            ),
        );
    }
    let reference = match CanonicalCasRef::parse(cas_ref) {
        Ok(reference) => reference,
        Err(_) => {
            return invalid(
                kind,
                format!("{field}.cas_ref must be a strict cas:sha256:<64 lowercase hex> reference"),
            )
        }
    };
    validate_sha256_fields(kind, [("evidence.digest", digest)])?;
    if reference.digest() != digest {
        return invalid(
            kind,
            format!("{field}.cas_ref must name the exact raw digest in {field}.digest"),
        );
    }
    Ok(())
}

fn validate_model_action_candidate_binding_shape(
    kind: &str,
    binding: &ModelActionCandidateBindingV1,
) -> Result<()> {
    validate_non_empty_fields(
        kind,
        [("candidate_view_ref", binding.candidate_view_ref.as_str())],
    )?;
    validate_canonical_cas_ref(kind, "candidate_view_ref", &binding.candidate_view_ref)?;
    if !is_canonical_git_object_id(&binding.candidate_commit_sha) {
        return invalid(
            kind,
            "candidate_binding.candidate_commit_sha must be a full canonical Git object ID",
        );
    }
    validate_sha256_fields(
        kind,
        [
            (
                "candidate_binding.candidate_digest",
                binding.candidate_digest.as_str(),
            ),
            (
                "candidate_binding.candidate_view_digest",
                binding.candidate_view_digest.as_str(),
            ),
        ],
    )?;
    validate_candidate_view_v1_shape(kind, &binding.candidate_view)?;
    if binding.candidate_view.candidate_digest != binding.candidate_digest
        || binding.candidate_view.candidate_commit_sha != binding.candidate_commit_sha
    {
        return invalid(
            kind,
            "candidate binding candidate digest and commit must match its closed candidate view",
        );
    }
    let expected_candidate_view_digest = candidate_view_v1_digest(&binding.candidate_view)
        .map_err(|error| LedgerError::InvalidPayload {
            kind: kind.to_string(),
            reason: format!("could not canonicalize model candidate view: {error}"),
        })?;
    if binding.candidate_view_digest != expected_candidate_view_digest {
        return invalid(
            kind,
            "candidate_view_digest does not match the canonical closed candidate view",
        );
    }
    Ok(())
}

fn validate_canonical_cas_ref(kind: &str, field: &str, value: &str) -> Result<()> {
    if !value.starts_with("cas:")
        || value.len() == "cas:".len()
        || value.chars().any(char::is_whitespace)
        || value.contains("..")
    {
        return invalid(
            kind,
            format!("{field} must be a canonical non-relative CAS reference"),
        );
    }
    Ok(())
}

fn validate_action_receipt_shape(kind: &str, receipt: &ActionReceiptRecordedV2) -> Result<()> {
    validate_non_empty_fields(
        kind,
        [
            ("run_id", receipt.run_id.as_str()),
            ("workflow_id", receipt.workflow_id.as_str()),
            ("unit_id", receipt.unit_id.as_str()),
            ("provenance_ref", receipt.provenance_ref.as_str()),
            ("action_id", receipt.action_id.as_str()),
            ("idempotency_key", receipt.idempotency_key.as_str()),
            ("authority_actor", receipt.authority_actor.as_str()),
            ("evidence_ref", receipt.evidence_ref.as_str()),
            ("action_receipt_ref", receipt.action_receipt_ref.as_str()),
        ],
    )?;
    if receipt.attempt == 0 {
        return invalid(kind, "action receipt attempt must be greater than zero");
    }
    if let Some(authorization_ref) = receipt.authorization_ref.as_deref() {
        validate_non_empty_fields(kind, [("authorization_ref", authorization_ref)])?;
    }
    validate_sha256_fields(
        kind,
        [
            (
                "action_request_digest",
                receipt.action_request_digest.as_str(),
            ),
            (
                "dispatch_envelope_digest",
                receipt.dispatch_envelope_digest.as_str(),
            ),
            (
                "capability_bundle_digest",
                receipt.capability_bundle_digest.as_str(),
            ),
            ("policy_digest", receipt.policy_digest.as_str()),
            (
                "context_manifest_digest",
                receipt.context_manifest_digest.as_str(),
            ),
            (
                "worker_manifest_digest",
                receipt.worker_manifest_digest.as_str(),
            ),
            (
                "sandbox_profile_digest",
                receipt.sandbox_profile_digest.as_str(),
            ),
            ("evidence_digest", receipt.evidence_digest.as_str()),
        ],
    )?;

    match (&receipt.result_digest, &receipt.result_ref) {
        (Some(digest), Some(reference)) => {
            validate_sha256_fields(kind, [("result_digest", digest.as_str())])?;
            validate_non_empty_fields(kind, [("result_ref", reference.as_str())])?;
        }
        (None, None) => {}
        _ => {
            return invalid(
                kind,
                "action receipt result_digest and result_ref must be present or absent together",
            )
        }
    }

    let mut redacted_fields = BTreeSet::new();
    for redaction in &receipt.redactions {
        validate_non_empty_fields(
            kind,
            [
                ("redactions.field", redaction.field.as_str()),
                ("redactions.reason", redaction.reason.as_str()),
            ],
        )?;
        if !redacted_fields.insert(&redaction.field) {
            return invalid(kind, "action receipt redaction fields must be unique");
        }
        if let Some(digest) = redaction.redacted_digest.as_deref() {
            validate_sha256_fields(kind, [("redactions.redacted_digest", digest)])?;
        }
    }

    match receipt.outcome {
        ActionReceiptOutcomeV2::Succeeded => {
            if receipt.result_digest.is_none() || receipt.failure.is_some() {
                return invalid(
                    kind,
                    "succeeded action receipts require a result and must not contain a failure",
                );
            }
        }
        ActionReceiptOutcomeV2::Failed
        | ActionReceiptOutcomeV2::Denied
        | ActionReceiptOutcomeV2::Unknown => {
            let Some(failure) = receipt.failure.as_ref() else {
                return invalid(
                    kind,
                    "failed, denied, and unknown action receipts require structured failure evidence",
                );
            };
            validate_non_empty_fields(kind, [("failure.code", failure.code.as_str())])?;
            validate_sha256_fields(
                kind,
                [("failure.message_digest", failure.message_digest.as_str())],
            )?;
        }
    }

    validate_rfc3339_utc(kind, "completed_at", &receipt.completed_at)
}

fn validate_action_receipt_set_shape(kind: &str, set: &ActionReceiptSetRecordedV1) -> Result<()> {
    validate_non_empty_fields(
        kind,
        [
            ("run_id", set.run_id.as_str()),
            ("workflow_id", set.workflow_id.as_str()),
            ("unit_id", set.unit_id.as_str()),
            ("provenance_ref", set.provenance_ref.as_str()),
            (
                "dispatch_envelope_digest",
                set.dispatch_envelope_digest.as_str(),
            ),
            (
                "action_receipt_set_ref",
                set.action_receipt_set_ref.as_str(),
            ),
        ],
    )?;
    if set.attempt == 0 {
        return invalid(kind, "action receipt set attempt must be greater than zero");
    }
    validate_sha256_fields(
        kind,
        [
            (
                "dispatch_envelope_digest",
                set.dispatch_envelope_digest.as_str(),
            ),
            (
                "action_receipt_set_digest",
                set.action_receipt_set_digest.as_str(),
            ),
        ],
    )?;

    let mut prior_action_id: Option<&str> = None;
    let mut receipt_refs = BTreeSet::new();
    let mut receipt_digests = BTreeSet::new();
    for entry in &set.receipts {
        validate_non_empty_fields(
            kind,
            [
                ("receipts.action_id", entry.action_id.as_str()),
                (
                    "receipts.action_receipt_ref",
                    entry.action_receipt_ref.as_str(),
                ),
            ],
        )?;
        validate_sha256_fields(
            kind,
            [(
                "receipts.action_receipt_digest",
                entry.action_receipt_digest.as_str(),
            )],
        )?;
        if prior_action_id.is_some_and(|previous| previous >= entry.action_id.as_str()) {
            return invalid(
                kind,
                "action receipt set entries must be strictly sorted by unique action_id",
            );
        }
        if !receipt_refs.insert(&entry.action_receipt_ref)
            || !receipt_digests.insert(&entry.action_receipt_digest)
        {
            return invalid(
                kind,
                "action receipt set receipt refs and digests must be unique",
            );
        }
        prior_action_id = Some(&entry.action_id);
    }
    validate_rfc3339_utc(kind, "sealed_at", &set.sealed_at)
}

fn validate_attempt_context_recorded_v1_shape(
    kind: &str,
    context: &AttemptContextRecordedV1,
) -> Result<()> {
    validate_non_empty_fields(
        kind,
        [
            ("run_id", context.run_id.as_str()),
            ("workflow_id", context.workflow_id.as_str()),
            ("workflow_revision", context.workflow_revision.as_str()),
            ("unit_id", context.unit_id.as_str()),
            (
                "prior_terminal_event_ref",
                context.prior_terminal_event_ref.as_str(),
            ),
            (
                "prior_action_receipt_ref",
                context.prior_action_receipt_ref.as_str(),
            ),
            ("feedback_ref", context.feedback_ref.as_str()),
            (
                "next_dispatch_idempotency_key",
                context.next_dispatch_idempotency_key.as_str(),
            ),
            (
                "retry_action_namespace",
                context.retry_action_namespace.as_str(),
            ),
            ("idempotency_key", context.idempotency_key.as_str()),
        ],
    )?;
    if context.prior_attempt == 0 || context.next_attempt == 0 {
        return invalid(
            kind,
            "attempt context prior_attempt and next_attempt must be greater than zero",
        );
    }
    if context.prior_attempt.checked_add(1) != Some(context.next_attempt) {
        return invalid(
            kind,
            "attempt context next_attempt must be exactly one greater than prior_attempt",
        );
    }
    if context.next_dispatch_idempotency_key == context.idempotency_key
        || context.next_dispatch_idempotency_key == context.retry_action_namespace
        || context.idempotency_key == context.retry_action_namespace
    {
        return invalid(
            kind,
            "attempt context dispatch, retry-action, and context idempotency keys must be distinct",
        );
    }
    validate_sha256_fields(
        kind,
        [
            (
                "prior_dispatch_envelope_digest",
                context.prior_dispatch_envelope_digest.as_str(),
            ),
            (
                "prior_terminal_event_digest",
                context.prior_terminal_event_digest.as_str(),
            ),
            (
                "prior_action_receipt_digest",
                context.prior_action_receipt_digest.as_str(),
            ),
            ("feedback_digest", context.feedback_digest.as_str()),
            (
                "next_dispatch_envelope_digest",
                context.next_dispatch_envelope_digest.as_str(),
            ),
            (
                "attempt_context_digest",
                context.attempt_context_digest.as_str(),
            ),
        ],
    )?;
    validate_rfc3339_utc(kind, "recorded_at", &context.recorded_at)
}

/// Validate the complete V2 authority body nested by a new V4 dispatch.
///
/// Historical V3 events predate these ingress requirements and remain
/// readable, so this deliberately is not folded into the legacy V3 shape
/// validator. New graph-bound V4 events, however, must never be signed and
/// persisted with a nested body that trusted replay would later reject.
fn validate_dispatch_envelope_v2_authority_shape(
    kind: &str,
    body: &DispatchEnvelopeBodyV2,
) -> Result<()> {
    validate_non_empty_fields(
        kind,
        [
            ("workflow_id", body.workflow_id.as_str()),
            ("workflow_revision", body.workflow_revision.as_str()),
            ("unit_id", body.unit_id.as_str()),
            ("provenance_ref", body.provenance_ref.as_str()),
            ("idempotency_key", body.idempotency_key.as_str()),
        ],
    )?;
    if body.attempt == 0 {
        return invalid(kind, "attempt must be greater than zero");
    }
    if !is_canonical_git_object_id(&body.base_commit_sha) {
        return invalid(
            kind,
            "base_commit_sha must be a full canonical Git object ID",
        );
    }
    validate_sha256_fields(
        kind,
        [
            (
                "capability_bundle_digest",
                body.capability_bundle_digest.as_str(),
            ),
            (
                "acceptance_contract_digest",
                body.acceptance_contract_digest.as_str(),
            ),
            (
                "context_manifest_digest",
                body.context_manifest_digest.as_str(),
            ),
            (
                "worker_manifest_digest",
                body.worker_manifest_digest.as_str(),
            ),
            (
                "sandbox_profile_digest",
                body.sandbox_profile_digest.as_str(),
            ),
        ],
    )?;
    if body.budget.max_tokens.is_some_and(|tokens| tokens == 0)
        || body
            .budget
            .max_compute_time_ms
            .is_some_and(|milliseconds| milliseconds == 0)
    {
        return invalid(
            kind,
            "dispatch budget limits must be greater than zero when present",
        );
    }
    validate_v4_rfc3339_utc_fractional_second_precision(kind, "issued_at", &body.issued_at)?;
    validate_v4_rfc3339_utc_fractional_second_precision(kind, "expires_at", &body.expires_at)?;
    let issued_at =
        DateTime::parse_from_rfc3339(&body.issued_at).map_err(|_| LedgerError::InvalidPayload {
            kind: kind.to_string(),
            reason: "issued_at must be an RFC3339 UTC timestamp".into(),
        })?;
    let expires_at = DateTime::parse_from_rfc3339(&body.expires_at).map_err(|_| {
        LedgerError::InvalidPayload {
            kind: kind.to_string(),
            reason: "expires_at must be an RFC3339 UTC timestamp".into(),
        }
    })?;
    if expires_at <= issued_at {
        return invalid(kind, "expires_at must be later than issued_at");
    }
    Ok(())
}

/// Validate the closed V3 material before a V4 envelope can bind it. Keeping
/// this in one helper ensures a V4 cannot gain acceptance merely because its
/// outer digest is correct while its nested V3 authority bytes are malformed.
fn validate_dispatch_envelope_v3_shape(kind: &str, envelope: &DispatchEnvelopeV3) -> Result<()> {
    if envelope
        .body
        .budget
        .max_tokens
        .is_some_and(|tokens| tokens == 0)
        || envelope
            .body
            .budget
            .max_compute_time_ms
            .is_some_and(|milliseconds| milliseconds == 0)
    {
        return invalid(
            kind,
            "sealed V3 dispatch budget limits must be greater than zero when present",
        );
    }
    if !is_canonical_sha256_digest(&envelope.repository_binding_digest) {
        return invalid(
            kind,
            "repository_binding_digest must be a canonical sha256 digest",
        );
    }
    if !is_canonical_sha256_digest(&envelope.ledger_authority_realm_digest) {
        return invalid(
            kind,
            "ledger_authority_realm_digest must be a canonical sha256 digest",
        );
    }
    if envelope.action_evidence_version == ActionEvidenceVersionV1::SealedV3
        && envelope.governed_packet_digest.is_none()
    {
        return invalid(kind, "sealed_v3 dispatch requires governed_packet_digest");
    }
    if let Some(packet_digest) = envelope.governed_packet_digest.as_deref() {
        if !is_canonical_sha256_digest(packet_digest) {
            return invalid(
                kind,
                "governed_packet_digest must be a canonical sha256 digest",
            );
        }
    }
    let expected = dispatch_envelope_v3_body_digest(
        &envelope.body,
        envelope.action_evidence_version,
        &envelope.repository_binding_digest,
        &envelope.ledger_authority_realm_digest,
        envelope.governed_packet_digest.as_deref(),
    )
    .map_err(|error| LedgerError::InvalidPayload {
        kind: kind.to_string(),
        reason: format!("could not canonicalize V3 dispatch body: {error}"),
    })?;
    if envelope.envelope_digest != expected {
        return invalid(
            kind,
            "envelope_digest does not match the canonical V3 dispatch body digest",
        );
    }
    Ok(())
}

/// Validate a graph-bound V4 dispatch's complete nested V3 authority and its
/// immutable graph reference. Tape-local relationship checks (same run,
/// declaration order, node identity) are deliberately left to the reducer.
fn validate_dispatch_envelope_v4_shape(kind: &str, envelope: &DispatchEnvelopeV4) -> Result<()> {
    validate_dispatch_envelope_v2_authority_shape(kind, &envelope.dispatch_v3.body)?;
    validate_dispatch_envelope_v3_shape(kind, &envelope.dispatch_v3)?;
    let nested = &envelope.dispatch_v3;
    if nested.body.trust_tier != TrustTierV1::Governed
        || nested.body.commit_mode != CommitModeV1::Atomic
        || nested.action_evidence_version != ActionEvidenceVersionV1::SealedV3
    {
        return invalid(
            kind,
            "graph-bound V4 dispatch requires governed atomic sealed_v3 authority",
        );
    }
    if !is_canonical_sha256_digest(&envelope.workflow_graph_digest) {
        return invalid(
            kind,
            "workflow_graph_digest must be a canonical sha256 digest",
        );
    }
    let expected = dispatch_envelope_v4_digest(
        &envelope.dispatch_v3,
        &envelope.workflow_graph_digest,
        &envelope.workflow_graph_declaration_event_ref,
    )
    .map_err(|error| LedgerError::InvalidPayload {
        kind: kind.to_string(),
        reason: format!("could not canonicalize V4 dispatch body: {error}"),
    })?;
    if envelope.envelope_digest != expected {
        return invalid(
            kind,
            "envelope_digest does not match the canonical V4 dispatch body digest",
        );
    }
    Ok(())
}

fn validate_workflow_graph_declared_v1_shape(
    kind: &str,
    declaration: &WorkflowGraphDeclaredV1,
) -> Result<()> {
    validate_non_empty_fields(
        kind,
        [
            ("run_id", declaration.run_id.as_str()),
            ("workflow_id", declaration.workflow_id.as_str()),
            ("workflow_revision", declaration.workflow_revision.as_str()),
            ("idempotency_key", declaration.idempotency_key.as_str()),
        ],
    )?;
    if declaration.nodes.is_empty() {
        return invalid(
            kind,
            "workflow graph declaration must contain at least one node",
        );
    }
    if declaration.max_concurrent == 0 {
        return invalid(
            kind,
            "workflow graph declaration max_concurrent must be greater than zero",
        );
    }
    validate_rfc3339_utc(kind, "declared_at", &declaration.declared_at)?;

    let mut node_ids = BTreeSet::new();
    let mut prior_unit_id: Option<String> = None;
    for node in &declaration.nodes {
        if node.unit_id.trim().is_empty() {
            return invalid(kind, "workflow graph node unit_id must be non-empty");
        }
        if prior_unit_id
            .as_deref()
            .is_some_and(|previous| previous >= node.unit_id.as_str())
        {
            return invalid(
                kind,
                "workflow graph nodes must be in strict lexical unit_id order",
            );
        }
        if !node_ids.insert(node.unit_id.clone()) {
            return invalid(kind, "workflow graph node unit_ids must be unique");
        }
        prior_unit_id = Some(node.unit_id.clone());

        let mut dependency_ids = BTreeSet::new();
        let mut prior_dependency_id: Option<String> = None;
        for dependency in &node.depends_on {
            if dependency.trim().is_empty() {
                return invalid(kind, "workflow graph dependency ids must be non-empty");
            }
            if dependency == &node.unit_id {
                return invalid(kind, "workflow graph nodes cannot depend on themselves");
            }
            if prior_dependency_id
                .as_deref()
                .is_some_and(|previous| previous >= dependency.as_str())
            {
                return invalid(
                    kind,
                    "workflow graph dependencies must be in strict lexical order",
                );
            }
            if !dependency_ids.insert(dependency.clone()) {
                return invalid(kind, "workflow graph dependencies must be unique");
            }
            prior_dependency_id = Some(dependency.clone());
        }
    }

    for node in &declaration.nodes {
        for dependency in &node.depends_on {
            if !node_ids.contains(dependency.as_str()) {
                return invalid(
                    kind,
                    "workflow graph dependency references an unknown unit_id",
                );
            }
        }
    }
    if workflow_graph_has_cycle(&declaration.nodes) {
        return invalid(kind, "workflow graph dependencies must not contain a cycle");
    }
    Ok(())
}

fn validate_workflow_graph_declared_v2_shape(
    kind: &str,
    declaration: &WorkflowGraphDeclaredV2,
) -> Result<()> {
    validate_non_empty_fields(
        kind,
        [
            ("run_id", declaration.run_id.as_str()),
            ("workflow_id", declaration.workflow_id.as_str()),
            ("workflow_revision", declaration.workflow_revision.as_str()),
            ("idempotency_key", declaration.idempotency_key.as_str()),
        ],
    )?;
    if declaration.nodes.is_empty() {
        return invalid(
            kind,
            "workflow graph declaration v2 must contain at least one node",
        );
    }
    if declaration.max_concurrent == 0 {
        return invalid(
            kind,
            "workflow graph declaration v2 max_concurrent must be greater than zero",
        );
    }
    validate_rfc3339_utc(kind, "declared_at", &declaration.declared_at)?;

    let mut node_ids = BTreeSet::new();
    let mut prior_unit_id: Option<String> = None;
    for node in &declaration.nodes {
        if node.unit_id.trim().is_empty() {
            return invalid(kind, "workflow graph v2 node unit_id must be non-empty");
        }
        // V2 graph topology is hashed as Rust string bytes and TypeScript
        // validates its ordering with JavaScript strings. Restrict the signed
        // cross-language identity fields to ASCII so UTF-16 and UTF-8 lexical
        // ordering cannot produce different canonical graph declarations.
        if !node.unit_id.is_ascii() {
            return invalid(kind, "workflow graph v2 node unit_id must be ASCII");
        }
        if prior_unit_id
            .as_deref()
            .is_some_and(|previous| previous >= node.unit_id.as_str())
        {
            return invalid(
                kind,
                "workflow graph v2 nodes must be in strict lexical unit_id order",
            );
        }
        if !node_ids.insert(node.unit_id.clone()) {
            return invalid(kind, "workflow graph v2 node unit_ids must be unique");
        }
        prior_unit_id = Some(node.unit_id.clone());
        if !is_canonical_sha256_digest(&node.governed_packet_digest) {
            return invalid(
                kind,
                "workflow graph v2 node governed_packet_digest must be a canonical sha256 digest",
            );
        }

        let mut dependency_ids = BTreeSet::new();
        let mut prior_dependency_id: Option<String> = None;
        for dependency in &node.depends_on {
            if dependency.trim().is_empty() {
                return invalid(kind, "workflow graph v2 dependency ids must be non-empty");
            }
            if !dependency.is_ascii() {
                return invalid(kind, "workflow graph v2 dependency ids must be ASCII");
            }
            if dependency == &node.unit_id {
                return invalid(kind, "workflow graph v2 nodes cannot depend on themselves");
            }
            if prior_dependency_id
                .as_deref()
                .is_some_and(|previous| previous >= dependency.as_str())
            {
                return invalid(
                    kind,
                    "workflow graph v2 dependencies must be in strict lexical order",
                );
            }
            if !dependency_ids.insert(dependency.clone()) {
                return invalid(kind, "workflow graph v2 dependencies must be unique");
            }
            prior_dependency_id = Some(dependency.clone());
        }
    }

    for node in &declaration.nodes {
        for dependency in &node.depends_on {
            if !node_ids.contains(dependency.as_str()) {
                return invalid(
                    kind,
                    "workflow graph v2 dependency references an unknown unit_id",
                );
            }
        }
    }
    if workflow_graph_v2_has_cycle(&declaration.nodes) {
        return invalid(
            kind,
            "workflow graph v2 dependencies must not contain a cycle",
        );
    }
    Ok(())
}

fn workflow_graph_has_cycle(nodes: &[WorkflowGraphNodeV1]) -> bool {
    // Kahn's work queue keeps caller-controlled graph depth off the call stack.
    let mut in_degree = BTreeMap::<&str, usize>::new();
    let mut dependents = BTreeMap::<&str, Vec<&str>>::new();

    for node in nodes {
        in_degree.insert(node.unit_id.as_str(), node.depends_on.len());
        for dependency in &node.depends_on {
            dependents
                .entry(dependency.as_str())
                .or_default()
                .push(node.unit_id.as_str());
        }
    }

    let mut ready = in_degree
        .iter()
        .filter_map(|(unit_id, degree)| (*degree == 0).then_some(*unit_id))
        .collect::<VecDeque<_>>();
    let mut visited = 0;

    while let Some(unit_id) = ready.pop_front() {
        visited += 1;
        if let Some(waiting_nodes) = dependents.get(unit_id) {
            for dependent in waiting_nodes {
                let degree = in_degree
                    .get_mut(*dependent)
                    .expect("workflow graph references are validated before cycle detection");
                *degree -= 1;
                if *degree == 0 {
                    ready.push_back(*dependent);
                }
            }
        }
    }

    visited != nodes.len()
}

fn workflow_graph_v2_has_cycle(nodes: &[WorkflowGraphNodeV2]) -> bool {
    // Keep V2 validation iterative for the same caller-controlled graph-depth
    // reason as V1. The node authority fields do not affect topology.
    let mut in_degree = BTreeMap::<&str, usize>::new();
    let mut dependents = BTreeMap::<&str, Vec<&str>>::new();

    for node in nodes {
        in_degree.insert(node.unit_id.as_str(), node.depends_on.len());
        for dependency in &node.depends_on {
            dependents
                .entry(dependency.as_str())
                .or_default()
                .push(node.unit_id.as_str());
        }
    }

    let mut ready = in_degree
        .iter()
        .filter_map(|(unit_id, degree)| (*degree == 0).then_some(*unit_id))
        .collect::<VecDeque<_>>();
    let mut visited = 0;

    while let Some(unit_id) = ready.pop_front() {
        visited += 1;
        if let Some(waiting_nodes) = dependents.get(unit_id) {
            for dependent in waiting_nodes {
                let degree = in_degree
                    .get_mut(*dependent)
                    .expect("workflow graph references are validated before cycle detection");
                *degree -= 1;
                if *degree == 0 {
                    ready.push_back(*dependent);
                }
            }
        }
    }

    visited != nodes.len()
}

fn validate_candidate_v1_shape(kind: &str, candidate: &CandidateCreatedV1) -> Result<()> {
    if !is_canonical_buildplane_candidate_ref(&candidate.candidate_ref) {
        return invalid(
            kind,
            "candidate_ref must be a canonical buildplane candidate ref",
        );
    }
    Ok(())
}

fn validate_candidate_v2_shape(kind: &str, candidate: &CandidateCreatedV2) -> Result<()> {
    validate_non_empty_fields(
        kind,
        [
            ("run_id", candidate.run_id.as_str()),
            ("candidate_id", candidate.candidate_id.as_str()),
            ("candidate_ref", candidate.candidate_ref.as_str()),
            ("workflow_id", candidate.workflow_id.as_str()),
            ("unit_id", candidate.unit_id.as_str()),
            ("provenance_ref", candidate.provenance_ref.as_str()),
            (
                "action_receipt_set_ref",
                candidate.action_receipt_set_ref.as_str(),
            ),
        ],
    )?;
    if candidate.attempt == 0 {
        return invalid(kind, "candidate v2 attempt must be greater than zero");
    }
    if !is_canonical_buildplane_candidate_ref(&candidate.candidate_ref) {
        return invalid(
            kind,
            "candidate_ref must be a canonical buildplane candidate ref",
        );
    }
    if !is_canonical_git_object_id(&candidate.base_commit_sha)
        || !is_canonical_git_object_id(&candidate.candidate_commit_sha)
    {
        return invalid(
            kind,
            "candidate v2 base_commit_sha and candidate_commit_sha must be full canonical Git object IDs",
        );
    }
    validate_sha256_fields(
        kind,
        [
            ("candidate_digest", candidate.candidate_digest.as_str()),
            ("commit_digest", candidate.commit_digest.as_str()),
            ("tree_digest", candidate.tree_digest.as_str()),
            ("patch_digest", candidate.patch_digest.as_str()),
            (
                "changed_files_digest",
                candidate.changed_files_digest.as_str(),
            ),
            ("envelope_digest", candidate.envelope_digest.as_str()),
            (
                "action_receipt_set_digest",
                candidate.action_receipt_set_digest.as_str(),
            ),
        ],
    )
}

fn validate_candidate_completion_recorded_v1_shape(
    kind: &str,
    completion: &CandidateCompletionRecordedV1,
) -> Result<()> {
    validate_non_empty_fields(
        kind,
        [
            ("run_id", completion.run_id.as_str()),
            ("workflow_id", completion.workflow_id.as_str()),
            ("unit_id", completion.unit_id.as_str()),
            ("provenance_ref", completion.provenance_ref.as_str()),
            (
                "candidate_create_action_id",
                completion.candidate_create_action_id.as_str(),
            ),
            ("action_receipt_ref", completion.action_receipt_ref.as_str()),
        ],
    )?;
    if completion.attempt == 0 {
        return invalid(
            kind,
            "candidate completion attempt must be greater than zero",
        );
    }
    validate_sha256_fields(
        kind,
        [
            ("candidate_digest", completion.candidate_digest.as_str()),
            (
                "action_request_digest",
                completion.action_request_digest.as_str(),
            ),
            (
                "activity_claim_event_digest",
                completion.activity_claim_event_digest.as_str(),
            ),
            (
                "activity_result_event_digest",
                completion.activity_result_event_digest.as_str(),
            ),
            (
                "action_receipt_digest",
                completion.action_receipt_digest.as_str(),
            ),
            ("completion_digest", completion.completion_digest.as_str()),
        ],
    )?;
    validate_rfc3339_utc(kind, "completed_at", &completion.completed_at)
}

fn validate_review_verdict_v2_shape(kind: &str, review: &ReviewVerdictRecordedV2) -> Result<()> {
    validate_non_empty_fields(
        kind,
        [
            ("run_id", review.run_id.as_str()),
            ("workflow_id", review.workflow_id.as_str()),
            ("unit_id", review.unit_id.as_str()),
            ("provenance_ref", review.provenance_ref.as_str()),
            ("review_ref", review.review_ref.as_str()),
            (
                "review_verdict_action_id",
                review.review_verdict_action_id.as_str(),
            ),
            (
                "review_action_receipt_ref",
                review.review_action_receipt_ref.as_str(),
            ),
            ("review_output_ref", review.review_output_ref.as_str()),
            ("acceptance_ref", review.acceptance_ref.as_str()),
            ("reviewer_workflow_id", review.reviewer_workflow_id.as_str()),
            ("reviewer_unit_id", review.reviewer_unit_id.as_str()),
            (
                "review_action_receipt_set_ref",
                review.review_action_receipt_set_ref.as_str(),
            ),
            ("candidate_view_ref", review.candidate_view_ref.as_str()),
            ("reviewer_authority", review.reviewer_authority.as_str()),
        ],
    )?;
    if review.attempt == 0 || review.reviewer_attempt == 0 {
        return invalid(
            kind,
            "review v2 candidate and reviewer attempts must be greater than zero",
        );
    }
    if !is_canonical_git_object_id(&review.candidate_commit_sha) {
        return invalid(
            kind,
            "review v2 candidate_commit_sha must be a full canonical Git object ID",
        );
    }
    if !review.confidence.is_finite() || !(0.0..=1.0).contains(&review.confidence) {
        return invalid(
            kind,
            "review v2 confidence must be a finite value between zero and one",
        );
    }
    if !matches!(
        review.reviewer_execution_role,
        ExecutionRoleV1::Reviewer | ExecutionRoleV1::Adversary | ExecutionRoleV1::Judge
    ) {
        return invalid(
            kind,
            "review v2 reviewer_execution_role must be a read-only review role",
        );
    }
    validate_sha256_fields(
        kind,
        [
            ("candidate_digest", review.candidate_digest.as_str()),
            (
                "review_action_request_digest",
                review.review_action_request_digest.as_str(),
            ),
            (
                "review_action_receipt_digest",
                review.review_action_receipt_digest.as_str(),
            ),
            ("review_output_digest", review.review_output_digest.as_str()),
            ("acceptance_digest", review.acceptance_digest.as_str()),
            (
                "acceptance_contract_digest",
                review.acceptance_contract_digest.as_str(),
            ),
            (
                "candidate_envelope_digest",
                review.candidate_envelope_digest.as_str(),
            ),
            (
                "reviewer_dispatch_envelope_digest",
                review.reviewer_dispatch_envelope_digest.as_str(),
            ),
            (
                "review_action_receipt_set_digest",
                review.review_action_receipt_set_digest.as_str(),
            ),
            (
                "candidate_view_digest",
                review.candidate_view_digest.as_str(),
            ),
            (
                "reviewer_manifest_digest",
                review.reviewer_manifest_digest.as_str(),
            ),
        ],
    )?;
    validate_candidate_view_v1_shape(kind, &review.candidate_view)?;
    let expected_candidate_view_digest =
        candidate_view_v1_digest(&review.candidate_view).map_err(|error| {
            LedgerError::InvalidPayload {
                kind: kind.to_string(),
                reason: format!("could not canonicalize review v2 candidate view: {error}"),
            }
        })?;
    if review.candidate_view_digest != expected_candidate_view_digest {
        return invalid(
            kind,
            "candidate_view_digest does not match the canonical read-only candidate view",
        );
    }
    let expected_output_digest = review_verdict_output_v1_digest(&ReviewVerdictOutputV1 {
        candidate_digest: review.candidate_digest.clone(),
        candidate_commit_sha: review.candidate_commit_sha.clone(),
        decision: review.decision,
        findings: review.findings.clone(),
        confidence: review.confidence,
        candidate_view_digest: review.candidate_view_digest.clone(),
    })
    .map_err(|error| LedgerError::InvalidPayload {
        kind: kind.to_string(),
        reason: format!("could not canonicalize review v2 closed output: {error}"),
    })?;
    if review.review_output_digest != expected_output_digest {
        return invalid(
            kind,
            "review_output_digest does not match the canonical closed review output",
        );
    }
    if review.review_output_ref != format!("cas:{}", review.review_output_digest) {
        return invalid(
            kind,
            "review_output_ref must be the exact protected CAS reference for review_output_digest",
        );
    }
    validate_rfc3339_utc(kind, "reviewed_at", &review.reviewed_at)
}

fn validate_candidate_view_v1_shape(kind: &str, view: &CandidateViewV1) -> Result<()> {
    validate_non_empty_fields(
        kind,
        [
            ("candidate_view.candidate_ref", view.candidate_ref.as_str()),
            (
                "candidate_view.candidate_digest",
                view.candidate_digest.as_str(),
            ),
        ],
    )?;
    if !is_canonical_buildplane_candidate_ref(&view.candidate_ref) {
        return invalid(
            kind,
            "candidate_view.candidate_ref must be a canonical buildplane candidate ref",
        );
    }
    if !is_canonical_git_object_id(&view.candidate_commit_sha) {
        return invalid(
            kind,
            "candidate_view.candidate_commit_sha must be a full canonical Git object ID",
        );
    }
    if !view.read_only || !view.network_disabled {
        return invalid(
            kind,
            "candidate_view must be read-only with network disabled",
        );
    }
    validate_sha256_fields(
        kind,
        [
            (
                "candidate_view.candidate_digest",
                view.candidate_digest.as_str(),
            ),
            ("candidate_view.tree_digest", view.tree_digest.as_str()),
            (
                "candidate_view.reviewer_context_manifest_digest",
                view.reviewer_context_manifest_digest.as_str(),
            ),
            (
                "candidate_view.reviewer_sandbox_profile_digest",
                view.reviewer_sandbox_profile_digest.as_str(),
            ),
            (
                "candidate_view.mount_path_digest",
                view.mount_path_digest.as_str(),
            ),
        ],
    )
}

/// Validate the kernel-signed work item that can later be resolved by an
/// operator decision. It cannot prove tape-local lineage on its own, but it
/// must not carry a malformed target or a review set that replay can never
/// accept.
fn validate_promotion_approval_requested_v1_shape(
    kind: &str,
    request: &PromotionApprovalRequestedV1,
) -> Result<()> {
    validate_non_empty_fields(
        kind,
        [
            ("candidate_digest", request.candidate_digest.as_str()),
            ("base_commit_sha", request.base_commit_sha.as_str()),
            ("target_ref", request.target_ref.as_str()),
            ("envelope_digest", request.envelope_digest.as_str()),
            ("acceptance_ref", request.acceptance_ref.as_str()),
            ("requested_by", request.requested_by.as_str()),
            ("idempotency_key", request.idempotency_key.as_str()),
        ],
    )?;
    if !is_canonical_git_object_id(&request.base_commit_sha) {
        return invalid(
            kind,
            "promotion approval request base_commit_sha must be a full canonical Git object ID",
        );
    }
    if !is_canonical_target_ref(&request.target_ref) {
        return invalid(
            kind,
            "promotion approval request target_ref must be a canonical refs/heads branch ref",
        );
    }
    validate_sha256_fields(
        kind,
        [
            ("candidate_digest", request.candidate_digest.as_str()),
            ("envelope_digest", request.envelope_digest.as_str()),
        ],
    )?;
    validate_opaque_reference(kind, "acceptance_ref", &request.acceptance_ref)?;
    validate_unique_references(kind, "review_refs", &request.review_refs)?;
    if !is_canonical_authority_actor(&request.requested_by) {
        return invalid(
            kind,
            "promotion approval request requested_by must be a canonical authority actor",
        );
    }
    validate_rfc3339_utc(kind, "requested_at", &request.requested_at)
}

/// Validate a promotion decision before it can be signed. A decision that
/// resolves an approval request is new authority and therefore closes the
/// operator identity and its request reference. Historical direct decisions
/// remain readable, including the target-bound direct form that predates the
/// approval-request protocol.
fn validate_promotion_decision_recorded_v1_shape(
    kind: &str,
    decision: &PromotionDecisionRecordedV1,
) -> Result<()> {
    validate_non_empty_fields(
        kind,
        [
            ("candidate_digest", decision.candidate_digest.as_str()),
            ("base_commit_sha", decision.base_commit_sha.as_str()),
            ("envelope_digest", decision.envelope_digest.as_str()),
            ("acceptance_ref", decision.acceptance_ref.as_str()),
            ("authority", decision.authority.as_str()),
            ("decided_by", decision.decided_by.as_str()),
            ("idempotency_key", decision.idempotency_key.as_str()),
        ],
    )?;
    if !is_canonical_git_object_id(&decision.base_commit_sha) {
        return invalid(
            kind,
            "promotion decision base_commit_sha must be a full canonical Git object ID",
        );
    }
    validate_sha256_fields(
        kind,
        [
            ("candidate_digest", decision.candidate_digest.as_str()),
            ("envelope_digest", decision.envelope_digest.as_str()),
        ],
    )?;
    validate_opaque_reference(kind, "acceptance_ref", &decision.acceptance_ref)?;
    validate_unique_references(kind, "review_refs", &decision.review_refs)?;
    if !is_canonical_authority_actor(&decision.authority)
        || !is_canonical_authority_actor(&decision.decided_by)
    {
        return invalid(
            kind,
            "promotion decision authority and decided_by must be canonical authority actors",
        );
    }
    validate_rfc3339_utc(kind, "decided_at", &decision.decided_at)?;

    match (
        decision.target_ref.as_deref(),
        decision.promotion_approval_request_ref.as_deref(),
    ) {
        (Some(target_ref), Some(request_ref)) => {
            if !is_canonical_target_ref(target_ref) {
                return invalid(
                    kind,
                    "promotion decision target_ref must be a canonical refs/heads branch ref",
                );
            }
            if decision.authority != decision.decided_by {
                return invalid(
                    kind,
                    "target-bound promotion decision authority and decided_by must name the same actor",
                );
            }
            validate_opaque_reference(kind, "promotion_approval_request_ref", request_ref)?;
        }
        (Some(target_ref), None) => {
            if !is_canonical_target_ref(target_ref) {
                return invalid(
                    kind,
                    "promotion decision target_ref must be a canonical refs/heads branch ref",
                );
            }
        }
        (None, None) => {
            // Historical direct decisions are deliberately not upgraded into
            // target-bound signing authority during canonicalization.
        }
        (None, Some(_)) => {
            return invalid(
                kind,
                "promotion decision with an approval request reference must bind a target_ref",
            );
        }
    }
    Ok(())
}

/// Validate local promotion-lease bindings before the claim is signed. Cross-
/// event relationship checks (decision, dispatch, and candidate lineage) are
/// deliberately replay-owned; this rejects shapes that could never be bound.
fn validate_promotion_execution_claimed_v1_shape(
    kind: &str,
    claim: &PromotionExecutionClaimedV1,
) -> Result<()> {
    validate_non_empty_fields(
        kind,
        [
            ("run_id", claim.run_id.as_str()),
            ("candidate_ref", claim.candidate_ref.as_str()),
            ("idempotency_key", claim.idempotency_key.as_str()),
            ("authority_actor", claim.authority_actor.as_str()),
            ("lease_id", claim.lease_id.as_str()),
            ("target_ref", claim.target_ref.as_str()),
        ],
    )?;
    if !is_canonical_buildplane_candidate_ref(&claim.candidate_ref) {
        return invalid(
            kind,
            "promotion execution claim candidate_ref must be a canonical Buildplane candidate ref",
        );
    }
    if !is_canonical_git_object_id(&claim.candidate_commit_sha)
        || !is_canonical_git_object_id(&claim.base_commit_sha)
    {
        return invalid(
            kind,
            "promotion execution claim base and candidate commits must be full canonical Git object IDs",
        );
    }
    if !is_canonical_target_ref(&claim.target_ref) {
        return invalid(
            kind,
            "promotion execution claim target_ref must be a canonical refs/heads branch ref",
        );
    }
    if !is_canonical_authority_actor(&claim.authority_actor) {
        return invalid(
            kind,
            "promotion execution claim authority_actor must be a canonical authority actor",
        );
    }
    validate_opaque_reference(kind, "lease_id", &claim.lease_id)?;
    validate_sha256_fields(
        kind,
        [
            (
                "promotion_decision_event_digest",
                claim.promotion_decision_event_digest.as_str(),
            ),
            (
                "dispatch_envelope_digest",
                claim.dispatch_envelope_digest.as_str(),
            ),
            ("candidate_digest", claim.candidate_digest.as_str()),
            (
                "candidate_tree_digest",
                claim.candidate_tree_digest.as_str(),
            ),
            (
                "promotion_execution_claim_digest",
                claim.promotion_execution_claim_digest.as_str(),
            ),
        ],
    )?;
    validate_rfc3339_utc(kind, "claimed_at", &claim.claimed_at)?;
    validate_rfc3339_utc(kind, "lease_expires_at", &claim.lease_expires_at)?;
    let claimed_at = DateTime::parse_from_rfc3339(&claim.claimed_at)
        .expect("validated promotion claim claimed_at parses");
    let lease_expires_at = DateTime::parse_from_rfc3339(&claim.lease_expires_at)
        .expect("validated promotion claim lease_expires_at parses");
    if lease_expires_at <= claimed_at {
        return invalid(
            kind,
            "promotion execution claim lease_expires_at must be later than claimed_at",
        );
    }
    Ok(())
}

/// An optional result binding is itself closed evidence: if a result names a
/// claim it must name both its canonical event digest and the exact opaque
/// lease token. Replay owns cross-event equality checks.
fn validate_promotion_execution_lease_binding_v1_shape(
    kind: &str,
    binding: &PromotionExecutionLeaseBindingV1,
) -> Result<()> {
    validate_non_empty_fields(kind, [("lease_id", binding.lease_id.as_str())])?;
    validate_opaque_reference(kind, "lease_id", &binding.lease_id)?;
    validate_sha256_fields(
        kind,
        [(
            "promotion_execution_claim_event_digest",
            binding.promotion_execution_claim_event_digest.as_str(),
        )],
    )
}

/// Validate a promotion effect result. The linked decision and candidate live
/// elsewhere on the tape, so relationship checks remain in replay; this
/// validator rejects only local shapes that can never satisfy those checks.
fn validate_promotion_result_recorded_v1_shape(
    kind: &str,
    result: &PromotionResultRecordedV1,
) -> Result<()> {
    validate_non_empty_fields(
        kind,
        [
            ("candidate_digest", result.candidate_digest.as_str()),
            ("idempotency_key", result.idempotency_key.as_str()),
            (
                "promotion_decision_ref",
                result.promotion_decision_ref.as_str(),
            ),
        ],
    )?;
    validate_sha256_fields(
        kind,
        [("candidate_digest", result.candidate_digest.as_str())],
    )?;
    validate_opaque_reference(
        kind,
        "promotion_decision_ref",
        &result.promotion_decision_ref,
    )?;
    validate_rfc3339_utc(kind, "completed_at", &result.completed_at)?;
    if let Some(binding) = result.promotion_execution_lease_binding.as_ref() {
        validate_promotion_execution_lease_binding_v1_shape(kind, binding)?;
    }

    match result.outcome {
        PromotionResultOutcomeV1::Promoted => {
            // A target-bound CAS deliberately leaves the root checkout
            // untouched. Every declared sync state therefore requires an
            // explicit reconciliation; only historical unbound results may
            // remain promoted.
            validate_promotion_result_merge_evidence(kind, result, &[], false)?;
        }
        PromotionResultOutcomeV1::ReconciliationRequired => {
            validate_promotion_result_merge_evidence(
                kind,
                result,
                &[
                    PromotionWorktreeSyncStateV1::RootCheckoutStale,
                    PromotionWorktreeSyncStateV1::TargetAdvanced,
                ],
                true,
            )?;
        }
        PromotionResultOutcomeV1::Rejected => {
            if result.merged_head_sha.is_some() || result.promotion_git_binding.is_some() {
                return invalid(
                    kind,
                    "rejected promotion results must omit merge and Git-binding evidence",
                );
            }
        }
    }
    Ok(())
}

fn validate_promotion_result_merge_evidence(
    kind: &str,
    result: &PromotionResultRecordedV1,
    allowed_sync_states: &[PromotionWorktreeSyncStateV1],
    require_complete_target_bound_binding: bool,
) -> Result<()> {
    let Some(merged_head_sha) = result.merged_head_sha.as_deref() else {
        return invalid(
            kind,
            "promotion result with a merge outcome requires merged_head_sha",
        );
    };
    if !is_canonical_git_object_id(merged_head_sha) {
        return invalid(
            kind,
            "promotion result merged_head_sha must be a full canonical Git object ID",
        );
    }
    let Some(binding) = result.promotion_git_binding.as_ref() else {
        return if require_complete_target_bound_binding {
            invalid(
                kind,
                "reconciliation-required promotion results require a complete target-bound Git binding",
            )
        } else {
            Ok(())
        };
    };
    validate_promotion_git_binding_v1_shape(
        kind,
        binding,
        merged_head_sha,
        allowed_sync_states,
        require_complete_target_bound_binding,
    )?;
    Ok(())
}

/// `PromotionGitBindingV1` gained its strict evidence fields additively. An
/// entirely absent strict set remains readable as a historical binding. Once
/// any strict field is present, all of them must be present and internally
/// coherent so a malformed new target-bound result is never signed.
fn validate_promotion_git_binding_v1_shape(
    kind: &str,
    binding: &PromotionGitBindingV1,
    result_merged_head_sha: &str,
    allowed_sync_states: &[PromotionWorktreeSyncStateV1],
    require_complete_target_bound_binding: bool,
) -> Result<()> {
    validate_non_empty_fields(
        kind,
        [
            (
                "promotion_git_binding.target_ref",
                binding.target_ref.as_str(),
            ),
            (
                "promotion_git_binding.target_head_before_sha",
                binding.target_head_before_sha.as_str(),
            ),
            (
                "promotion_git_binding.candidate_commit_sha",
                binding.candidate_commit_sha.as_str(),
            ),
            (
                "promotion_git_binding.merged_tree_digest",
                binding.merged_tree_digest.as_str(),
            ),
        ],
    )?;
    if !is_canonical_target_ref(&binding.target_ref) {
        return invalid(
            kind,
            "promotion_git_binding.target_ref must be a canonical refs/heads branch ref",
        );
    }
    if !is_canonical_git_object_id(&binding.target_head_before_sha)
        || !is_canonical_git_object_id(&binding.candidate_commit_sha)
    {
        return invalid(
            kind,
            "promotion_git_binding base and candidate commits must be full canonical Git object IDs",
        );
    }
    validate_sha256_fields(
        kind,
        [(
            "promotion_git_binding.merged_tree_digest",
            binding.merged_tree_digest.as_str(),
        )],
    )?;

    match (
        binding.target_head_after_sha.as_deref(),
        binding.merged_head_sha.as_deref(),
        binding.merge_parent_shas.as_deref(),
        binding.merged_tree_sha.as_deref(),
        binding.promotion_receipt_ref.as_deref(),
        binding.worktree_sync_state,
    ) {
        (None, None, None, None, None, None) if require_complete_target_bound_binding => invalid(
            kind,
            "reconciliation-required promotion results require complete target-bound Git evidence",
        ),
        (None, None, None, None, None, None) => Ok(()),
        (
            Some(target_head_after_sha),
            Some(binding_merged_head_sha),
            Some(merge_parent_shas),
            Some(merged_tree_sha),
            Some(promotion_receipt_ref),
            Some(worktree_sync_state),
        ) => {
            if !is_canonical_git_object_id(target_head_after_sha)
                || !is_canonical_git_object_id(binding_merged_head_sha)
                || !is_canonical_git_object_id(merged_tree_sha)
            {
                return invalid(
                    kind,
                    "promotion_git_binding strict Git object IDs must be canonical",
                );
            }
            if binding_merged_head_sha != result_merged_head_sha {
                return invalid(
                    kind,
                    "promotion_git_binding merged_head_sha must equal the enclosing promotion result",
                );
            }
            if merge_parent_shas.len() != 2
                || merge_parent_shas[0] != binding.target_head_before_sha
                || merge_parent_shas[1] != binding.candidate_commit_sha
                || !merge_parent_shas
                    .iter()
                    .all(|sha| is_canonical_git_object_id(sha))
            {
                return invalid(
                    kind,
                    "promotion_git_binding merge_parent_shas must be canonical [base, candidate] evidence",
                );
            }
            if !is_canonical_buildplane_promotion_receipt_ref(promotion_receipt_ref) {
                return invalid(
                    kind,
                    "promotion_git_binding promotion_receipt_ref must be a canonical Buildplane promotion ref",
                );
            }
            if !allowed_sync_states.contains(&worktree_sync_state) {
                return invalid(
                    kind,
                    "promotion_git_binding worktree_sync_state is incompatible with the promotion result outcome",
                );
            }
            match worktree_sync_state {
                PromotionWorktreeSyncStateV1::PendingReconciliation
                | PromotionWorktreeSyncStateV1::RootCheckoutStale
                    if target_head_after_sha != binding_merged_head_sha =>
                {
                    invalid(
                        kind,
                        "promotion_git_binding target_head_after_sha must equal merged_head_sha for an unchanged target",
                    )
                }
                PromotionWorktreeSyncStateV1::TargetAdvanced
                    if target_head_after_sha == binding_merged_head_sha =>
                {
                    invalid(
                        kind,
                        "promotion_git_binding target_advanced must observe a target head distinct from merged_head_sha",
                    )
                }
                _ => Ok(()),
            }
        }
        _ => invalid(
            kind,
            "target-bound promotion_git_binding must include its complete strict evidence set",
        ),
    }
}

fn validate_promotion_reconciliation_resolved_v1_shape(
    kind: &str,
    resolution: &PromotionReconciliationResolvedV1,
) -> Result<()> {
    validate_non_empty_fields(
        kind,
        [
            ("candidate_digest", resolution.candidate_digest.as_str()),
            (
                "promotion_decision_ref",
                resolution.promotion_decision_ref.as_str(),
            ),
            (
                "promotion_result_ref",
                resolution.promotion_result_ref.as_str(),
            ),
            (
                "promotion_receipt_ref",
                resolution.promotion_receipt_ref.as_str(),
            ),
            ("authority", resolution.authority.as_str()),
            ("resolved_by", resolution.resolved_by.as_str()),
            ("idempotency_key", resolution.idempotency_key.as_str()),
        ],
    )?;
    validate_sha256_fields(
        kind,
        [("candidate_digest", resolution.candidate_digest.as_str())],
    )?;
    validate_opaque_reference(
        kind,
        "promotion_decision_ref",
        &resolution.promotion_decision_ref,
    )?;
    validate_opaque_reference(
        kind,
        "promotion_result_ref",
        &resolution.promotion_result_ref,
    )?;
    if !is_canonical_buildplane_promotion_receipt_ref(&resolution.promotion_receipt_ref) {
        return invalid(
            kind,
            "promotion_receipt_ref must be a canonical Buildplane promotion ref",
        );
    }
    if !is_canonical_authority_actor(&resolution.authority)
        || !is_canonical_authority_actor(&resolution.resolved_by)
        || resolution.authority != resolution.resolved_by
    {
        return invalid(
            kind,
            "promotion reconciliation authority and resolved_by must name the same canonical actor",
        );
    }
    validate_rfc3339_utc(kind, "resolved_at", &resolution.resolved_at)
}

fn validate_opaque_reference(kind: &str, field: &str, value: &str) -> Result<()> {
    if value.trim().is_empty()
        || !value.is_ascii()
        || value
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
    {
        return invalid(
            kind,
            format!("{field} must be a non-empty canonical opaque reference"),
        );
    }
    Ok(())
}

fn validate_unique_references(kind: &str, field: &str, references: &[String]) -> Result<()> {
    if references.is_empty() {
        return invalid(kind, format!("{field} must contain at least one reference"));
    }
    let mut seen = BTreeSet::new();
    for reference in references {
        validate_opaque_reference(kind, field, reference)?;
        if !seen.insert(reference) {
            return invalid(kind, format!("{field} must not contain duplicates"));
        }
    }
    Ok(())
}

fn validate_workflow_timer_scheduled_v1_shape(
    kind: &str,
    timer: &WorkflowTimerScheduledV1,
) -> Result<()> {
    validate_non_empty_fields(
        kind,
        [
            ("run_id", timer.run_id.as_str()),
            ("workflow_id", timer.workflow_id.as_str()),
            ("workflow_revision", timer.workflow_revision.as_str()),
            ("unit_id", timer.unit_id.as_str()),
            ("timer_id", timer.timer_id.as_str()),
            ("idempotency_key", timer.idempotency_key.as_str()),
            ("scheduled_by", timer.scheduled_by.as_str()),
        ],
    )?;
    if timer.attempt == 0 {
        return invalid(kind, "timer attempt must be greater than zero");
    }
    if !is_canonical_authority_actor(&timer.scheduled_by) {
        return invalid(kind, "scheduled_by must be a canonical authority actor");
    }
    validate_sha256_fields(
        kind,
        [(
            "dispatch_envelope_digest",
            timer.dispatch_envelope_digest.as_str(),
        )],
    )?;
    validate_rfc3339_utc(kind, "scheduled_at", &timer.scheduled_at)?;
    validate_rfc3339_utc(kind, "due_at", &timer.due_at)?;
    let scheduled_at = DateTime::parse_from_rfc3339(&timer.scheduled_at)
        .expect("validated timer scheduled_at parses");
    let due_at =
        DateTime::parse_from_rfc3339(&timer.due_at).expect("validated timer due_at parses");
    if due_at <= scheduled_at {
        return invalid(kind, "timer due_at must be later than scheduled_at");
    }
    Ok(())
}

fn validate_workflow_timer_fired_v1_shape(kind: &str, timer: &WorkflowTimerFiredV1) -> Result<()> {
    validate_non_empty_fields(
        kind,
        [
            ("run_id", timer.run_id.as_str()),
            ("workflow_id", timer.workflow_id.as_str()),
            ("workflow_revision", timer.workflow_revision.as_str()),
            ("unit_id", timer.unit_id.as_str()),
            ("timer_id", timer.timer_id.as_str()),
            ("idempotency_key", timer.idempotency_key.as_str()),
            ("fired_by", timer.fired_by.as_str()),
        ],
    )?;
    if timer.attempt == 0 {
        return invalid(kind, "timer attempt must be greater than zero");
    }
    if !is_canonical_authority_actor(&timer.fired_by) {
        return invalid(kind, "fired_by must be a canonical authority actor");
    }
    validate_sha256_fields(
        kind,
        [
            (
                "timer_schedule_event_digest",
                timer.timer_schedule_event_digest.as_str(),
            ),
            (
                "dispatch_envelope_digest",
                timer.dispatch_envelope_digest.as_str(),
            ),
        ],
    )?;
    validate_rfc3339_utc(kind, "fired_at", &timer.fired_at)
}

fn validate_workflow_cancellation_requested_v1_shape(
    kind: &str,
    cancellation: &WorkflowCancellationRequestedV1,
) -> Result<()> {
    validate_non_empty_fields(
        kind,
        [
            ("run_id", cancellation.run_id.as_str()),
            ("workflow_id", cancellation.workflow_id.as_str()),
            ("workflow_revision", cancellation.workflow_revision.as_str()),
            ("unit_id", cancellation.unit_id.as_str()),
            ("cancellation_id", cancellation.cancellation_id.as_str()),
            ("requested_by", cancellation.requested_by.as_str()),
            ("idempotency_key", cancellation.idempotency_key.as_str()),
        ],
    )?;
    if cancellation.attempt == 0 {
        return invalid(kind, "cancellation attempt must be greater than zero");
    }
    if !is_canonical_authority_actor(&cancellation.requested_by) {
        return invalid(kind, "requested_by must be a canonical authority actor");
    }
    validate_sha256_fields(
        kind,
        [(
            "dispatch_envelope_digest",
            cancellation.dispatch_envelope_digest.as_str(),
        )],
    )?;
    validate_rfc3339_utc(kind, "requested_at", &cancellation.requested_at)?;
    match (
        cancellation.cause,
        cancellation.timer_fired_event_ref,
        cancellation.timer_fired_event_digest.as_deref(),
    ) {
        (WorkflowCancellationCauseV1::OperatorRequested, None, None) => Ok(()),
        (WorkflowCancellationCauseV1::TimerElapsed, Some(_), Some(digest)) => {
            validate_sha256_fields(kind, [("timer_fired_event_digest", digest)])
        }
        (WorkflowCancellationCauseV1::OperatorRequested, _, _)
        | (WorkflowCancellationCauseV1::TimerElapsed, _, _) => invalid(
            kind,
            "operator cancellations must omit timer evidence and timer cancellations must bind both timer evidence fields",
        ),
    }
}

fn validate_workflow_terminal_v2_shape(kind: &str, terminal: &WorkflowTerminalV2) -> Result<()> {
    validate_non_empty_fields(
        kind,
        [
            ("workflow_id", terminal.workflow_id.as_str()),
            ("workflow_revision", terminal.workflow_revision.as_str()),
            ("unit_id", terminal.unit_id.as_str()),
            ("idempotency_key", terminal.idempotency_key.as_str()),
        ],
    )?;
    if terminal.attempt == 0 {
        return invalid(kind, "workflow terminal attempt must be greater than zero");
    }
    validate_rfc3339_utc(kind, "completed_at", &terminal.completed_at)?;
    if let Some(candidate_digest) = terminal.candidate_digest.as_deref() {
        validate_sha256_fields(kind, [("candidate_digest", candidate_digest)])?;
    }
    if let Some(reference) = terminal.promotion_result_ref.as_deref() {
        validate_non_empty_fields(kind, [("promotion_result_ref", reference)])?;
    }
    if let Some(reference) = terminal.reconciliation_resolution_ref.as_deref() {
        validate_non_empty_fields(kind, [("reconciliation_resolution_ref", reference)])?;
    }
    if let Some(reason) = terminal.reason.as_deref() {
        validate_non_empty_fields(kind, [("reason", reason)])?;
    }
    match (
        terminal.outcome,
        terminal.cancellation_request_event_ref,
        terminal.cancellation_request_event_digest.as_deref(),
    ) {
        (WorkflowTerminalOutcomeV1::Cancelled, Some(_), Some(digest)) => {
            validate_sha256_fields(kind, [("cancellation_request_event_digest", digest)])
        }
        (WorkflowTerminalOutcomeV1::Cancelled, _, _) => invalid(
            kind,
            "cancelled workflow_terminal_v2 requires both cancellation request evidence fields",
        ),
        (_, None, None) => Ok(()),
        (_, _, _) => invalid(
            kind,
            "non-cancelled workflow_terminal_v2 must omit cancellation request evidence",
        ),
    }
}

fn validate_non_empty_fields<'a>(
    kind: &str,
    fields: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> Result<()> {
    for (field, value) in fields {
        if value.trim().is_empty() {
            return invalid(kind, format!("{field} must be non-empty"));
        }
    }
    Ok(())
}

fn validate_sha256_fields<'a>(
    kind: &str,
    fields: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> Result<()> {
    for (field, value) in fields {
        if !is_canonical_sha256_digest(value) {
            return invalid(kind, format!("{field} must be a canonical sha256 digest"));
        }
    }
    Ok(())
}

fn validate_rfc3339_utc(kind: &str, field: &str, value: &str) -> Result<()> {
    if !value.ends_with('Z') || DateTime::parse_from_rfc3339(value).is_err() {
        return invalid(kind, format!("{field} must be an RFC3339 UTC timestamp"));
    }
    Ok(())
}

/// This helper is called only by the V4-nested authority validator above.
/// Chrono's RFC3339 parser truncates precision after nanoseconds, so V4 must
/// reject values it cannot compare exactly while legacy payloads stay readable.
fn validate_v4_rfc3339_utc_fractional_second_precision(
    kind: &str,
    field: &str,
    value: &str,
) -> Result<()> {
    validate_rfc3339_utc(kind, field, value)?;
    let fraction = value
        .strip_suffix('Z')
        .and_then(|without_utc_suffix| without_utc_suffix.rsplit_once('.'))
        .map(|(_, fraction)| fraction);
    if fraction.is_some_and(|fraction| fraction.len() > 9) {
        return invalid(
            kind,
            format!(
                "{field} fractional seconds must contain at most 9 digits for graph-bound V4 dispatch"
            ),
        );
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

fn is_canonical_authority_actor(value: &str) -> bool {
    !value.is_empty()
        && value.trim() == value
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'.' | b'_' | b'-' | b'/')
        })
}

fn invalid(kind: &str, reason: impl Into<String>) -> Result<()> {
    Err(LedgerError::InvalidPayload {
        kind: kind.to_string(),
        reason: reason.into(),
    })
}

fn payload_variant_name(payload: &Payload) -> &'static str {
    match payload {
        Payload::RunStartedV1(_) => "RunStartedV1",
        Payload::RunCompletedV1(_) => "RunCompletedV1",
        Payload::RunFailedV1(_) => "RunFailedV1",
        Payload::ResultReadyV1(_) => "ResultReadyV1",
        Payload::RunAdmissionRecordedV1(_) => "RunAdmissionRecordedV1",
        Payload::PlanAdmittedV1(_) => "PlanAdmittedV1",
        Payload::PlanReceiptRecordedV1(_) => "PlanReceiptRecordedV1",
        Payload::ActivityStartedV1(_) => "ActivityStartedV1",
        Payload::ActivityCompletedV1(_) => "ActivityCompletedV1",
        Payload::UnitStartedV1(_) => "UnitStartedV1",
        Payload::UnitCompletedV1(_) => "UnitCompletedV1",
        Payload::UnitFailedV1(_) => "UnitFailedV1",
        Payload::UnitCancelledV1(_) => "UnitCancelledV1",
        Payload::GitCheckpointV1(_) => "GitCheckpointV1",
        Payload::ModelRequestV1(_) => "ModelRequestV1",
        Payload::ModelResponseV1(_) => "ModelResponseV1",
        Payload::ToolRequestStoredV1(_) => "ToolRequestStoredV1",
        Payload::ToolResultV1(_) => "ToolResultV1",
        Payload::WorkspaceReadV1(_) => "WorkspaceReadV1",
        Payload::WorkspaceWriteV1(_) => "WorkspaceWriteV1",
        Payload::TapeCheckpointV1(_) => "TapeCheckpointV1",
        Payload::CapabilityDeniedV1(_) => "CapabilityDeniedV1",
        Payload::AcceptanceRecordedV1(_) => "AcceptanceRecordedV1",
        Payload::OperatorDecisionRecordedV1(_) => "OperatorDecisionRecordedV1",
        Payload::DispatchEnvelopeV1(_) => "DispatchEnvelopeV1",
        Payload::DispatchEnvelopeV2(_) => "DispatchEnvelopeV2",
        Payload::DispatchEnvelopeV3(_) => "DispatchEnvelopeV3",
        Payload::DispatchEnvelopeV4(_) => "DispatchEnvelopeV4",
        Payload::WorkflowGraphDeclaredV1(_) => "WorkflowGraphDeclaredV1",
        Payload::WorkflowGraphDeclaredV2(_) => "WorkflowGraphDeclaredV2",
        Payload::ActionRequestedV2(_) => "ActionRequestedV2",
        Payload::ModelActionIntentV1(_) => "ModelActionIntentV1",
        Payload::ModelActionAuthorizedV1(_) => "ModelActionAuthorizedV1",
        Payload::ModelActionAuthorizedV2(_) => "ModelActionAuthorizedV2",
        Payload::ActivityClaimedV1(_) => "ActivityClaimedV1",
        Payload::ActivityHeartbeatRecordedV1(_) => "ActivityHeartbeatRecordedV1",
        Payload::ActivityResultRecordedV1(_) => "ActivityResultRecordedV1",
        Payload::ActionReceiptRecordedV2(_) => "ActionReceiptRecordedV2",
        Payload::ActionReceiptSetRecordedV1(_) => "ActionReceiptSetRecordedV1",
        Payload::AttemptContextRecordedV1(_) => "AttemptContextRecordedV1",
        Payload::CandidateCreatedV1(_) => "CandidateCreatedV1",
        Payload::CandidateCreatedV2(_) => "CandidateCreatedV2",
        Payload::CandidateCompletionRecordedV1(_) => "CandidateCompletionRecordedV1",
        Payload::CandidateAcceptanceRecordedV1(_) => "CandidateAcceptanceRecordedV1",
        Payload::ReviewVerdictRecordedV1(_) => "ReviewVerdictRecordedV1",
        Payload::ReviewVerdictRecordedV2(_) => "ReviewVerdictRecordedV2",
        Payload::PromotionApprovalRequestedV1(_) => "PromotionApprovalRequestedV1",
        Payload::PromotionDecisionRecordedV1(_) => "PromotionDecisionRecordedV1",
        Payload::PromotionExecutionClaimedV1(_) => "PromotionExecutionClaimedV1",
        Payload::PromotionResultRecordedV1(_) => "PromotionResultRecordedV1",
        Payload::PromotionReconciliationResolvedV1(_) => "PromotionReconciliationResolvedV1",
        Payload::ReleaseEvaluationEvidenceV1(_) => "ReleaseEvaluationEvidenceV1",
        Payload::WorkflowTimerScheduledV1(_) => "WorkflowTimerScheduledV1",
        Payload::WorkflowTimerFiredV1(_) => "WorkflowTimerFiredV1",
        Payload::WorkflowCancellationRequestedV1(_) => "WorkflowCancellationRequestedV1",
        Payload::WorkflowTerminalV1(_) => "WorkflowTerminalV1",
        Payload::WorkflowTerminalV2(_) => "WorkflowTerminalV2",
    }
}

fn kind_to_variant(kind: &str) -> Result<&'static str> {
    Ok(match kind {
        "run_started" => "RunStartedV1",
        "run_completed" => "RunCompletedV1",
        "run_failed" => "RunFailedV1",
        "result_ready" => "ResultReadyV1",
        "run_admission_recorded" => "RunAdmissionRecordedV1",
        "plan_admitted" => "PlanAdmittedV1",
        "plan_receipt" => "PlanReceiptRecordedV1",
        "activity_started" => "ActivityStartedV1",
        "activity_completed" => "ActivityCompletedV1",
        "unit_started" => "UnitStartedV1",
        "unit_completed" => "UnitCompletedV1",
        "unit_failed" => "UnitFailedV1",
        "unit_cancelled" => "UnitCancelledV1",
        "git_checkpoint" => "GitCheckpointV1",
        "model_request" => "ModelRequestV1",
        "model_response" => "ModelResponseV1",
        "tool_request" => "ToolRequestStoredV1",
        "tool_result" => "ToolResultV1",
        "workspace_read" => "WorkspaceReadV1",
        "workspace_write" => "WorkspaceWriteV1",
        "tape_checkpoint" => "TapeCheckpointV1",
        "capability_denied" => "CapabilityDeniedV1",
        "acceptance_recorded" => "AcceptanceRecordedV1",
        "operator_decision_recorded" => "OperatorDecisionRecordedV1",
        "dispatch_envelope" => "DispatchEnvelopeV1",
        "dispatch_envelope_v2" => "DispatchEnvelopeV2",
        "dispatch_envelope_v3" => "DispatchEnvelopeV3",
        "dispatch_envelope_v4" => "DispatchEnvelopeV4",
        "workflow_graph_declared_v1" => "WorkflowGraphDeclaredV1",
        "workflow_graph_declared_v2" => "WorkflowGraphDeclaredV2",
        "action_requested_v2" => "ActionRequestedV2",
        "model_action_intent_v1" => "ModelActionIntentV1",
        "model_action_authorized_v1" => "ModelActionAuthorizedV1",
        "model_action_authorized_v2" => "ModelActionAuthorizedV2",
        "activity_claimed_v1" => "ActivityClaimedV1",
        "activity_heartbeat_recorded_v1" => "ActivityHeartbeatRecordedV1",
        "activity_result_recorded_v1" => "ActivityResultRecordedV1",
        "action_receipt_recorded_v2" => "ActionReceiptRecordedV2",
        "action_receipt_set_recorded_v1" => "ActionReceiptSetRecordedV1",
        "attempt_context_recorded_v1" => "AttemptContextRecordedV1",
        "candidate_created" => "CandidateCreatedV1",
        "candidate_created_v2" => "CandidateCreatedV2",
        "candidate_completion_recorded_v1" => "CandidateCompletionRecordedV1",
        "candidate_acceptance_recorded" => "CandidateAcceptanceRecordedV1",
        "review_verdict_recorded" => "ReviewVerdictRecordedV1",
        "review_verdict_recorded_v2" => "ReviewVerdictRecordedV2",
        "promotion_approval_requested" => "PromotionApprovalRequestedV1",
        "promotion_decision_recorded" => "PromotionDecisionRecordedV1",
        "promotion_execution_claimed_v1" => "PromotionExecutionClaimedV1",
        "promotion_result_recorded" => "PromotionResultRecordedV1",
        "promotion_reconciliation_resolved" => "PromotionReconciliationResolvedV1",
        "release_evaluation_evidence_v1" => "ReleaseEvaluationEvidenceV1",
        "workflow_timer_scheduled_v1" => "WorkflowTimerScheduledV1",
        "workflow_timer_fired_v1" => "WorkflowTimerFiredV1",
        "workflow_cancellation_requested_v1" => "WorkflowCancellationRequestedV1",
        "workflow_terminal" => "WorkflowTerminalV1",
        "workflow_terminal_v2" => "WorkflowTerminalV2",
        other => {
            return Err(LedgerError::InvalidPayload {
                kind: other.to_string(),
                reason: "unknown kind".into(),
            })
        }
    })
}
