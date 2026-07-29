//! A closed, redacted OpenTelemetry projection for verified governed replay.
//!
//! This module deliberately has no public input API. The only public way to
//! obtain [`VerifiedOtelProjectionV1`] is through
//! [`crate::TrustedGovernedRecoverySnapshot::verified_otel_projection_v1`],
//! after that snapshot has fully replayed and verified its tape.

use crate::state::{ActionReplayState, WorkflowInstanceV1, WorkflowPhaseV1};
use crate::tape_integrity::TapeIntegrityReportV1;
use bp_ledger::id::EventId;
use bp_ledger::payload::checkpoint::TapeRootAlgorithm;
use bp_ledger::payload::trust_spine::{
    ActionKindV1, ActionReceiptOutcomeV2, CandidateAcceptanceOutcomeV1, PromotionDecisionKindV1,
    ReviewDecisionV1,
};
use chrono::DateTime;
use serde::{Serialize, Serializer};
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Closed wire-schema revision for a verified, evidence-only OTel projection.
pub const VERIFIED_OTEL_PROJECTION_SCHEMA_VERSION_V1: u16 = 1;

/// Closed failures emitted while converting a verified tape into the bounded
/// OpenTelemetry timestamp representation.
///
/// This error deliberately carries no source timestamp or replay facts, so a
/// failed evidence export cannot disclose an arbitrary tape value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum VerifiedOtelProjectionErrorV1 {
    #[error("verified OTel projection contains an invalid RFC3339 timestamp")]
    InvalidRfc3339Timestamp,
    #[error(
        "verified OTel projection timestamp is outside the OpenTelemetry i64 nanosecond range"
    )]
    TimestampOutsideOpenTelemetryRange,
}

/// A serializable, read-only OTel-shaped projection of a fully verified tape.
///
/// The type intentionally derives [`Serialize`] but not [`serde::Deserialize`]:
/// callers cannot submit telemetry-shaped JSON as verified evidence.
///
/// ```compile_fail
/// # let mut projection: bp_replay::VerifiedOtelProjectionV1 = unreachable!();
/// projection.spans.clear();
/// ```
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
#[non_exhaustive]
pub struct VerifiedOtelProjectionV1 {
    schema_version: u16,
    authority: VerifiedOtelAuthorityV1,
    resource: VerifiedOtelResourceV1,
    spans: Vec<VerifiedOtelSpanV1>,
}

/// Fixed evidence authority for the projection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
#[non_exhaustive]
pub struct VerifiedOtelAuthorityV1 {
    tape: VerifiedOtelTapeAuthorityV1,
    export: VerifiedOtelExportAuthorityV1,
}

/// This projection can only represent a tape verified by governed recovery.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum VerifiedOtelTapeAuthorityV1 {
    Verified,
}

/// A projection is evidence export only; it can never issue authority.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum VerifiedOtelExportAuthorityV1 {
    None,
}

/// Fixed OTel resource facts. No caller-defined attribute map is accepted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
#[non_exhaustive]
pub struct VerifiedOtelResourceV1 {
    service_name: String,
    scope_name: String,
    scope_version: String,
    projection_schema: String,
    tape_integrity: VerifiedOtelTapeIntegrityFactsV1,
}

/// Redacted tape-integrity facts that bind the projection to one verified tape.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
#[non_exhaustive]
pub struct VerifiedOtelTapeIntegrityFactsV1 {
    schema_version: u8,
    checkpoint_event_ref: String,
    checkpoint_event_digest: String,
    through_event_ref: String,
    #[serde(serialize_with = "serialize_u64_decimal")]
    signed_non_checkpoint_event_count: u64,
    tape_root_hash: String,
    algorithm: TapeRootAlgorithm,
}

/// One fixed-shape OTel span. Its attributes are a closed enum-like structure,
/// never an open telemetry metadata map.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
#[non_exhaustive]
pub struct VerifiedOtelSpanV1 {
    trace_id: String,
    span_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_span_id: Option<String>,
    name: VerifiedOtelSpanNameV1,
    start_time_unix_nano: String,
    end_time_unix_nano: String,
    attributes: VerifiedOtelSpanAttributesV1,
}

/// Fixed Buildplane span names; raw tape events never become spans.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub enum VerifiedOtelSpanNameV1 {
    #[serde(rename = "buildplane.workflow")]
    Workflow,
    #[serde(rename = "buildplane.action")]
    Action,
    #[serde(rename = "buildplane.decision")]
    Decision,
}

/// Exactly one typed fact group is present for every span.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
#[non_exhaustive]
pub struct VerifiedOtelSpanAttributesV1 {
    #[serde(skip_serializing_if = "Option::is_none")]
    workflow: Option<VerifiedOtelWorkflowFactsV1>,
    #[serde(skip_serializing_if = "Option::is_none")]
    action: Option<VerifiedOtelActionFactsV1>,
    #[serde(skip_serializing_if = "Option::is_none")]
    decision: Option<VerifiedOtelDecisionFactsV1>,
}

/// Redacted reducer-owned workflow facts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
#[non_exhaustive]
pub struct VerifiedOtelWorkflowFactsV1 {
    run_id: String,
    attempt: u32,
    status: WorkflowPhaseV1,
    dispatch_event_ref: String,
    dispatch_envelope_digest: String,
    capability_bundle_digest: String,
    acceptance_contract_digest: String,
    context_manifest_digest: String,
    worker_manifest_digest: String,
    sandbox_profile_digest: String,
    action_count: u64,
    decision_count: u64,
}

/// Redacted reducer-owned action facts. Inputs, outputs, evidence refs,
/// idempotency keys, leases, and worker identity are intentionally absent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
#[non_exhaustive]
pub struct VerifiedOtelActionFactsV1 {
    action_kind: ActionKindV1,
    outcome: VerifiedOtelActionOutcomeV1,
    action_request_event_ref: String,
    action_request_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    action_receipt_digest: Option<String>,
}

/// Closed recovery-safe action outcomes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum VerifiedOtelActionOutcomeV1 {
    Pending,
    Succeeded,
    Failed,
    Denied,
    Unknown,
}

/// Redacted reducer-owned decision facts. Review findings, reasons, refs, and
/// reviewer identity are intentionally absent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
#[non_exhaustive]
pub struct VerifiedOtelDecisionFactsV1 {
    decision_id: String,
    kind: VerifiedOtelDecisionKindV1,
    outcome: VerifiedOtelDecisionOutcomeV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    decision_digest: Option<String>,
}

/// Closed decision categories present in the governed reducer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum VerifiedOtelDecisionKindV1 {
    Acceptance,
    Review,
    Promotion,
}

/// Closed decision outcomes; the vocabulary records evidence and grants no
/// action or promotion capability.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum VerifiedOtelDecisionOutcomeV1 {
    AcceptancePassed,
    AcceptanceRejected,
    ReviewApproved,
    ReviewRequestChanges,
    ReviewRejected,
    ReviewAbstained,
    PromotionPromote,
    PromotionReject,
}

/// Construct a projection from the private fields of an already verified
/// snapshot. This is crate-private so no external caller can submit replay
/// state, JSON, caller facts, raw tape export, or unverified data.
pub(crate) fn project_verified_snapshot_v1<'a>(
    tape_integrity: &TapeIntegrityReportV1,
    workflows: impl Iterator<Item = &'a WorkflowInstanceV1>,
) -> Result<VerifiedOtelProjectionV1, VerifiedOtelProjectionErrorV1> {
    let trace_id = trace_id(&tape_integrity.tape_root_hash);
    let mut workflows: Vec<_> = workflows.collect();
    workflows.sort_by_key(|workflow| workflow.dispatch.event_id.to_string());

    let mut spans = Vec::new();
    for workflow in workflows {
        let workflow_span_id = span_id(&workflow.dispatch.event_id);
        spans.push(workflow_span(workflow, &trace_id, &workflow_span_id)?);

        if let Some(action_evidence) = workflow.action_evidence.as_ref() {
            for action in action_evidence.actions.values() {
                spans.push(action_span(action, &trace_id, &workflow_span_id)?);
            }
        }

        if let Some(acceptance) = workflow.acceptance.as_ref() {
            spans.push(decision_span(
                &trace_id,
                &workflow_span_id,
                &acceptance.event_id,
                &acceptance.evaluated_at,
                VerifiedOtelDecisionKindV1::Acceptance,
                match acceptance.outcome {
                    CandidateAcceptanceOutcomeV1::Passed => {
                        VerifiedOtelDecisionOutcomeV1::AcceptancePassed
                    }
                    CandidateAcceptanceOutcomeV1::Rejected => {
                        VerifiedOtelDecisionOutcomeV1::AcceptanceRejected
                    }
                },
                Some(acceptance.acceptance_digest.clone()),
            )?);
        }

        for review in workflow.reviews.values() {
            spans.push(decision_span(
                &trace_id,
                &workflow_span_id,
                &review.event_id,
                &review.reviewed_at,
                VerifiedOtelDecisionKindV1::Review,
                match review.decision {
                    ReviewDecisionV1::Approve => VerifiedOtelDecisionOutcomeV1::ReviewApproved,
                    ReviewDecisionV1::RequestChanges => {
                        VerifiedOtelDecisionOutcomeV1::ReviewRequestChanges
                    }
                    ReviewDecisionV1::Reject => VerifiedOtelDecisionOutcomeV1::ReviewRejected,
                    ReviewDecisionV1::Abstain => VerifiedOtelDecisionOutcomeV1::ReviewAbstained,
                },
                None,
            )?);
        }

        if let Some(promotion) = workflow.promotion.as_ref() {
            let decision = &promotion.decision;
            spans.push(decision_span(
                &trace_id,
                &workflow_span_id,
                &decision.event_id,
                &decision.decided_at,
                VerifiedOtelDecisionKindV1::Promotion,
                match decision.decision {
                    PromotionDecisionKindV1::Promote => {
                        VerifiedOtelDecisionOutcomeV1::PromotionPromote
                    }
                    PromotionDecisionKindV1::Reject => {
                        VerifiedOtelDecisionOutcomeV1::PromotionReject
                    }
                },
                non_empty(decision.event_digest.clone()),
            )?);
        }
    }

    Ok(VerifiedOtelProjectionV1 {
        schema_version: VERIFIED_OTEL_PROJECTION_SCHEMA_VERSION_V1,
        authority: VerifiedOtelAuthorityV1 {
            tape: VerifiedOtelTapeAuthorityV1::Verified,
            export: VerifiedOtelExportAuthorityV1::None,
        },
        resource: VerifiedOtelResourceV1 {
            service_name: "buildplane".to_string(),
            scope_name: "buildplane".to_string(),
            scope_version: "1.0.0".to_string(),
            projection_schema: "buildplane.verified-governed-otel.v1".to_string(),
            tape_integrity: tape_integrity_facts(tape_integrity),
        },
        spans,
    })
}

fn tape_integrity_facts(
    tape_integrity: &TapeIntegrityReportV1,
) -> VerifiedOtelTapeIntegrityFactsV1 {
    VerifiedOtelTapeIntegrityFactsV1 {
        schema_version: tape_integrity.schema_version,
        checkpoint_event_ref: tape_integrity.checkpoint_event_ref.clone(),
        checkpoint_event_digest: tape_integrity.checkpoint_event_digest.clone(),
        through_event_ref: tape_integrity.through_event_ref.clone(),
        signed_non_checkpoint_event_count: tape_integrity.signed_non_checkpoint_event_count,
        tape_root_hash: tape_integrity.tape_root_hash.clone(),
        algorithm: tape_integrity.algorithm,
    }
}

fn workflow_span(
    workflow: &WorkflowInstanceV1,
    trace_id: &str,
    span_id: &str,
) -> Result<VerifiedOtelSpanV1, VerifiedOtelProjectionErrorV1> {
    let action_count = workflow
        .action_evidence
        .as_ref()
        .map(|evidence| evidence.actions.len() as u64)
        .unwrap_or_default();
    let decision_count = u64::from(workflow.acceptance.is_some())
        + workflow.reviews.len() as u64
        + u64::from(workflow.promotion.is_some());
    let started_at = unix_nano(&workflow.dispatch.issued_at)?;
    let ended_at = unix_nano(workflow_end_timestamp(workflow))?;

    Ok(VerifiedOtelSpanV1 {
        trace_id: trace_id.to_string(),
        span_id: span_id.to_string(),
        parent_span_id: None,
        name: VerifiedOtelSpanNameV1::Workflow,
        start_time_unix_nano: started_at,
        end_time_unix_nano: ended_at,
        attributes: VerifiedOtelSpanAttributesV1 {
            workflow: Some(VerifiedOtelWorkflowFactsV1 {
                run_id: workflow.run_id.clone(),
                attempt: workflow.attempt,
                status: workflow.phase,
                dispatch_event_ref: workflow.dispatch.event_id.to_string(),
                dispatch_envelope_digest: workflow.dispatch.envelope_digest.clone(),
                capability_bundle_digest: workflow.dispatch.capability_bundle_digest.clone(),
                acceptance_contract_digest: workflow.dispatch.acceptance_contract_digest.clone(),
                context_manifest_digest: workflow.dispatch.context_manifest_digest.clone(),
                worker_manifest_digest: workflow.dispatch.worker_manifest_digest.clone(),
                sandbox_profile_digest: workflow.dispatch.sandbox_profile_digest.clone(),
                action_count,
                decision_count,
            }),
            action: None,
            decision: None,
        },
    })
}

fn action_span(
    action: &ActionReplayState,
    trace_id: &str,
    parent_span_id: &str,
) -> Result<VerifiedOtelSpanV1, VerifiedOtelProjectionErrorV1> {
    let (outcome, ended_at, action_receipt_digest) = action_outcome(action);
    let request = &action.request;
    Ok(VerifiedOtelSpanV1 {
        trace_id: trace_id.to_string(),
        span_id: span_id(&request.event_id),
        parent_span_id: Some(parent_span_id.to_string()),
        name: VerifiedOtelSpanNameV1::Action,
        start_time_unix_nano: unix_nano(&request.requested_at)?,
        end_time_unix_nano: unix_nano(ended_at)?,
        attributes: VerifiedOtelSpanAttributesV1 {
            workflow: None,
            action: Some(VerifiedOtelActionFactsV1 {
                action_kind: request.action_kind,
                outcome,
                action_request_event_ref: request.event_id.to_string(),
                action_request_digest: request.action_request_digest.clone(),
                action_receipt_digest,
            }),
            decision: None,
        },
    })
}

fn action_outcome(
    action: &ActionReplayState,
) -> (VerifiedOtelActionOutcomeV1, &str, Option<String>) {
    if let Some(receipt) = action.receipt.as_ref() {
        let outcome = match receipt.outcome {
            ActionReceiptOutcomeV2::Succeeded => VerifiedOtelActionOutcomeV1::Succeeded,
            ActionReceiptOutcomeV2::Failed => VerifiedOtelActionOutcomeV1::Failed,
            ActionReceiptOutcomeV2::Denied => VerifiedOtelActionOutcomeV1::Denied,
            ActionReceiptOutcomeV2::Unknown => VerifiedOtelActionOutcomeV1::Unknown,
        };
        return (
            outcome,
            &receipt.completed_at,
            Some(receipt.action_receipt_digest.clone()),
        );
    }

    if let Some(result) = action
        .activity_claim
        .as_ref()
        .and_then(|claim| claim.result.as_ref())
    {
        let outcome = match result.outcome {
            bp_ledger::payload::activity_claim::ActivityResultOutcomeV1::Succeeded => {
                VerifiedOtelActionOutcomeV1::Succeeded
            }
            bp_ledger::payload::activity_claim::ActivityResultOutcomeV1::Failed => {
                VerifiedOtelActionOutcomeV1::Failed
            }
            bp_ledger::payload::activity_claim::ActivityResultOutcomeV1::Unknown => {
                VerifiedOtelActionOutcomeV1::Unknown
            }
        };
        return (outcome, &result.recorded_at, None);
    }

    (
        VerifiedOtelActionOutcomeV1::Pending,
        &action.request.requested_at,
        None,
    )
}

fn decision_span(
    trace_id: &str,
    parent_span_id: &str,
    event_id: &EventId,
    occurred_at: &str,
    kind: VerifiedOtelDecisionKindV1,
    outcome: VerifiedOtelDecisionOutcomeV1,
    decision_digest: Option<String>,
) -> Result<VerifiedOtelSpanV1, VerifiedOtelProjectionErrorV1> {
    let timestamp = unix_nano(occurred_at)?;
    Ok(VerifiedOtelSpanV1 {
        trace_id: trace_id.to_string(),
        span_id: span_id(event_id),
        parent_span_id: Some(parent_span_id.to_string()),
        name: VerifiedOtelSpanNameV1::Decision,
        start_time_unix_nano: timestamp.clone(),
        end_time_unix_nano: timestamp,
        attributes: VerifiedOtelSpanAttributesV1 {
            workflow: None,
            action: None,
            decision: Some(VerifiedOtelDecisionFactsV1 {
                decision_id: event_id.to_string(),
                kind,
                outcome,
                decision_digest,
            }),
        },
    })
}

fn workflow_end_timestamp(workflow: &WorkflowInstanceV1) -> &str {
    workflow
        .terminal
        .as_ref()
        .map(|terminal| terminal.completed_at.as_str())
        .or_else(|| {
            workflow
                .promotion
                .as_ref()
                .and_then(|promotion| promotion.result.as_ref())
                .map(|result| result.completed_at.as_str())
        })
        .unwrap_or(workflow.dispatch.issued_at.as_str())
}

fn non_empty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

fn trace_id(tape_root_hash: &str) -> String {
    let digest = tape_root_hash
        .strip_prefix("sha256:")
        .expect("verified tape roots use canonical SHA-256 digests");
    digest[..32].to_string()
}

fn span_id(event_id: &EventId) -> String {
    let digest = Sha256::digest(event_id.as_uuid().as_bytes());
    let value = u64::from_be_bytes(
        digest[..8]
            .try_into()
            .expect("SHA-256 digests always begin with eight bytes"),
    )
    .max(1);
    format!("{value:016x}")
}

fn serialize_u64_decimal<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serializer.serialize_str(&value.to_string())
}

fn unix_nano(timestamp: &str) -> Result<String, VerifiedOtelProjectionErrorV1> {
    let parsed = DateTime::parse_from_rfc3339(timestamp)
        .map_err(|_| VerifiedOtelProjectionErrorV1::InvalidRfc3339Timestamp)?;
    let nanos = parsed
        .timestamp_nanos_opt()
        .ok_or(VerifiedOtelProjectionErrorV1::TimestampOutsideOpenTelemetryRange)?;
    Ok(nanos.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn span_ids_use_all_event_id_bits_and_are_deterministic() {
        let first = EventId::from_uuid(
            Uuid::parse_str("01919000-0000-7000-8000-000000000001").expect("valid UUIDv7"),
        );
        let second = EventId::from_uuid(
            Uuid::parse_str("01919000-0000-7000-8000-000000000002").expect("valid UUIDv7"),
        );

        let first_uuid = first.as_uuid().simple().to_string();
        let second_uuid = second.as_uuid().simple().to_string();
        assert_eq!(&first_uuid[..16], &second_uuid[..16]);

        let first_span_id = span_id(&first);
        let second_span_id = span_id(&second);

        assert_eq!(first_span_id, span_id(&first));
        assert_eq!(second_span_id, span_id(&second));
        assert_ne!(first_span_id, second_span_id);
        for span_id in [first_span_id, second_span_id] {
            assert_eq!(span_id.len(), 16);
            assert!(span_id.bytes().all(|byte| byte.is_ascii_hexdigit()));
            assert_ne!(span_id, "0000000000000000");
        }
    }

    #[test]
    fn tape_integrity_count_serializes_as_an_exact_decimal_string() {
        let facts = VerifiedOtelTapeIntegrityFactsV1 {
            schema_version: 1,
            checkpoint_event_ref: "checkpoint:1".to_string(),
            checkpoint_event_digest: "sha256:checkpoint".to_string(),
            through_event_ref: "event:1".to_string(),
            signed_non_checkpoint_event_count: 9_007_199_254_740_992,
            tape_root_hash: "sha256:tape-root".to_string(),
            algorithm: TapeRootAlgorithm::Sha256Linear,
        };

        let encoded = serde_json::to_value(facts).expect("serialize OTel tape integrity facts");
        assert_eq!(
            encoded["signed_non_checkpoint_event_count"],
            serde_json::Value::String("9007199254740992".to_string())
        );
    }
}
