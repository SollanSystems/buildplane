//! Durable activity-claim payloads.
//!
//! The mutable SQLite claim projection is only a cache of these signed tape
//! records. A grant is never valid unless its `ActivityClaimedV1` event and
//! detached signature committed in the same transaction as the projection
//! row. Likewise, a terminal result is backed by `ActivityResultRecordedV1`.

use crate::error::{LedgerError, Result};
use crate::id::{EventId, RunId};
use crate::payload::trust_spine::ActionKindV1;
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use typeshare::typeshare;

/// Terminal reconciliation outcome for one claimed activity.
///
/// `Unknown` is deliberately terminal and non-retryable. It records that a
/// lease expired or an effect could not be reconciled, rather than granting a
/// second attempt that could duplicate an external side effect.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityResultOutcomeV1 {
    Succeeded,
    Failed,
    Unknown,
}

/// Immutable purpose of a signed activity reservation.
///
/// The omitted/default `Generic` value preserves canonical replay of
/// historical `ActivityClaimedV1` records. New purpose-specific lanes must
/// write an explicit non-generic value, which becomes part of the signed
/// claim event rather than a mutable projection-side interpretation.
#[typeshare]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityClaimPurposeV1 {
    #[default]
    Generic,
    GovernedVerifierV1,
    /// A provider model lease issued only by the protected native
    /// model-authority transaction. Generic claim controls must never mint
    /// this purpose because a sealed V3 model effect additionally requires a
    /// parented `ModelActionIntentV1` and `ModelActionAuthorizedV2`.
    GovernedModelActionV1,
}

fn is_generic_claim_purpose(value: &ActivityClaimPurposeV1) -> bool {
    *value == ActivityClaimPurposeV1::Generic
}

/// Signed write-ahead execution reservation for one action request.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivityClaimedV1 {
    pub run_id: RunId,
    pub activity_id: String,
    pub idempotency_key: String,
    pub action_kind: ActionKindV1,
    pub action_request_event_id: EventId,
    pub action_request_digest: String,
    pub dispatch_event_id: EventId,
    pub dispatch_envelope_digest: String,
    /// Kernel-owned signer identity that issued this reservation.
    pub authority_actor: String,
    /// Fixed-purpose lanes must bind their purpose into the signed claim.
    /// Omitted historical claims are deliberately interpreted as `generic`.
    #[serde(default, skip_serializing_if = "is_generic_claim_purpose")]
    pub purpose: ActivityClaimPurposeV1,
    /// Opaque lease token. It is never returned to a duplicate claimant.
    pub lease_id: String,
    /// RFC3339 UTC timestamp.
    pub lease_expires_at: String,
    /// RFC3339 UTC timestamp.
    pub claimed_at: String,
}

/// Signed liveness record that extends one already-issued activity lease.
///
/// A heartbeat is never a second claim: it repeats the immutable claim,
/// dispatch, activity, and idempotency bindings, retains the original lease
/// token, and can only move the current expiry forward during replay. New
/// heartbeats also bind the caller's exact idempotency identity and closed
/// request digest into the signed event, so a mutable cache cannot remap one
/// recorded extension to another request.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivityHeartbeatRecordedV1 {
    pub run_id: RunId,
    pub activity_id: String,
    pub idempotency_key: String,
    /// Caller-chosen exactly-once identity for this one lease extension.
    ///
    /// Omitted only by historical heartbeat records, whose canonical signed
    /// representation must remain replayable. Governed issuance requires it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heartbeat_id: Option<String>,
    /// Canonical domain-separated SHA-256 digest of the complete closed
    /// heartbeat request, including [`Self::heartbeat_id`].
    ///
    /// Omitted only by historical heartbeat records. Governed issuance and
    /// idempotency replay require it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heartbeat_request_digest: Option<String>,
    pub claim_event_id: EventId,
    /// Canonical event digest of the exact signed claim being extended.
    pub claim_event_digest: String,
    /// The immutable lease token issued by the claim; heartbeats cannot swap
    /// to a neighbouring activity's reservation.
    pub lease_id: String,
    pub dispatch_event_id: EventId,
    pub dispatch_envelope_digest: String,
    /// Requested new RFC3339 UTC lease expiry. Replay additionally requires
    /// it to be later than the currently effective expiry and within dispatch
    /// authority.
    pub lease_expires_at: String,
    /// RFC3339 UTC timestamp bound to the enclosing event in sealed V3 mode.
    pub heartbeat_at: String,
}

/// Signed terminal activity result or reconciliation record.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivityResultRecordedV1 {
    pub run_id: RunId,
    pub activity_id: String,
    pub idempotency_key: String,
    pub claim_event_id: EventId,
    /// Canonical event digest from the signed claim's detached signature.
    pub claim_event_digest: String,
    pub lease_id: String,
    pub outcome: ActivityResultOutcomeV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_ref: Option<String>,
    pub evidence_digest: String,
    pub evidence_ref: String,
    /// RFC3339 UTC timestamp.
    pub recorded_at: String,
}

pub(crate) fn validate_activity_claimed_v1(payload: &ActivityClaimedV1) -> Result<()> {
    validate_non_empty(
        "activity_claimed_v1",
        [
            ("activity_id", payload.activity_id.as_str()),
            ("idempotency_key", payload.idempotency_key.as_str()),
            ("authority_actor", payload.authority_actor.as_str()),
            ("lease_id", payload.lease_id.as_str()),
        ],
    )?;
    validate_digest(
        "activity_claimed_v1",
        "action_request_digest",
        &payload.action_request_digest,
    )?;
    validate_digest(
        "activity_claimed_v1",
        "dispatch_envelope_digest",
        &payload.dispatch_envelope_digest,
    )?;
    validate_timestamp(
        "activity_claimed_v1",
        "lease_expires_at",
        &payload.lease_expires_at,
    )?;
    validate_timestamp("activity_claimed_v1", "claimed_at", &payload.claimed_at)?;
    Ok(())
}

pub(crate) fn validate_activity_heartbeat_recorded_v1(
    payload: &ActivityHeartbeatRecordedV1,
) -> Result<()> {
    validate_non_empty(
        "activity_heartbeat_recorded_v1",
        [
            ("activity_id", payload.activity_id.as_str()),
            ("idempotency_key", payload.idempotency_key.as_str()),
            ("lease_id", payload.lease_id.as_str()),
        ],
    )?;
    match (
        payload.heartbeat_id.as_deref(),
        payload.heartbeat_request_digest.as_deref(),
    ) {
        (Some(heartbeat_id), Some(request_digest)) => {
            validate_non_empty(
                "activity_heartbeat_recorded_v1",
                [("heartbeat_id", heartbeat_id)],
            )?;
            validate_digest(
                "activity_heartbeat_recorded_v1",
                "heartbeat_request_digest",
                request_digest,
            )?;
        }
        (None, None) => {
            // Historical signed heartbeat records predate request-identity
            // binding. Keep their canonical JSON and replay behavior intact;
            // governed issuance rejects this form at the storage boundary.
        }
        _ => {
            return invalid(
                "activity_heartbeat_recorded_v1",
                "heartbeat_id and heartbeat_request_digest must be present together",
            )
        }
    }
    validate_digest(
        "activity_heartbeat_recorded_v1",
        "claim_event_digest",
        &payload.claim_event_digest,
    )?;
    validate_digest(
        "activity_heartbeat_recorded_v1",
        "dispatch_envelope_digest",
        &payload.dispatch_envelope_digest,
    )?;
    validate_timestamp(
        "activity_heartbeat_recorded_v1",
        "lease_expires_at",
        &payload.lease_expires_at,
    )?;
    validate_timestamp(
        "activity_heartbeat_recorded_v1",
        "heartbeat_at",
        &payload.heartbeat_at,
    )?;
    let lease_expires_at = DateTime::parse_from_rfc3339(&payload.lease_expires_at)
        .expect("validated heartbeat expiry parses");
    let heartbeat_at = DateTime::parse_from_rfc3339(&payload.heartbeat_at)
        .expect("validated heartbeat timestamp parses");
    if lease_expires_at <= heartbeat_at {
        return invalid(
            "activity_heartbeat_recorded_v1",
            "lease_expires_at must be later than heartbeat_at",
        );
    }
    Ok(())
}

pub(crate) fn validate_activity_result_recorded_v1(
    payload: &ActivityResultRecordedV1,
) -> Result<()> {
    validate_non_empty(
        "activity_result_recorded_v1",
        [
            ("activity_id", payload.activity_id.as_str()),
            ("idempotency_key", payload.idempotency_key.as_str()),
            ("lease_id", payload.lease_id.as_str()),
            ("evidence_ref", payload.evidence_ref.as_str()),
        ],
    )?;
    validate_digest(
        "activity_result_recorded_v1",
        "claim_event_digest",
        &payload.claim_event_digest,
    )?;
    validate_digest(
        "activity_result_recorded_v1",
        "evidence_digest",
        &payload.evidence_digest,
    )?;
    match (&payload.result_digest, &payload.result_ref, payload.outcome) {
        (Some(digest), Some(reference), _) => {
            validate_digest("activity_result_recorded_v1", "result_digest", digest)?;
            validate_non_empty(
                "activity_result_recorded_v1",
                [("result_ref", reference.as_str())],
            )?;
        }
        (None, None, ActivityResultOutcomeV1::Succeeded) => {
            return invalid(
                "activity_result_recorded_v1",
                "succeeded activity results require result_digest and result_ref",
            )
        }
        (None, None, _) => {}
        _ => {
            return invalid(
                "activity_result_recorded_v1",
                "result_digest and result_ref must be present together",
            )
        }
    }
    if payload.outcome == ActivityResultOutcomeV1::Unknown
        && (payload.result_digest.is_some() || payload.result_ref.is_some())
    {
        return invalid(
            "activity_result_recorded_v1",
            "unknown activity results must not assert a result",
        );
    }
    validate_timestamp(
        "activity_result_recorded_v1",
        "recorded_at",
        &payload.recorded_at,
    )?;
    Ok(())
}

fn validate_non_empty<'a>(
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

fn validate_digest(kind: &str, field: &str, value: &str) -> Result<()> {
    let valid = value.len() == 71
        && value.starts_with("sha256:")
        && value.as_bytes()[7..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte));
    if !valid {
        return invalid(kind, format!("{field} must be a canonical sha256 digest"));
    }
    Ok(())
}

fn validate_timestamp(kind: &str, field: &str, value: &str) -> Result<()> {
    if !value.ends_with('Z') || DateTime::parse_from_rfc3339(value).is_err() {
        return invalid(kind, format!("{field} must be an RFC3339 UTC timestamp"));
    }
    Ok(())
}

fn invalid(kind: &str, reason: impl Into<String>) -> Result<()> {
    Err(LedgerError::InvalidPayload {
        kind: kind.to_string(),
        reason: reason.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::id::{EventId, RunId};
    use crate::payload::trust_spine::ActionKindV1;

    const DIGEST: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn claim() -> ActivityClaimedV1 {
        ActivityClaimedV1 {
            run_id: RunId::new(),
            activity_id: "activity-1".into(),
            idempotency_key: "idempotency-1".into(),
            action_kind: ActionKindV1::Process,
            action_request_event_id: EventId::new(),
            action_request_digest: DIGEST.into(),
            dispatch_event_id: EventId::new(),
            dispatch_envelope_digest: DIGEST.into(),
            authority_actor: "kernel".into(),
            purpose: ActivityClaimPurposeV1::Generic,
            lease_id: "lease-1".into(),
            lease_expires_at: "2026-07-18T00:01:00Z".into(),
            claimed_at: "2026-07-18T00:00:00Z".into(),
        }
    }

    #[test]
    fn claim_and_terminal_result_round_trip_as_closed_payloads() {
        let claim = claim();
        assert_eq!(
            claim,
            serde_json::from_str::<ActivityClaimedV1>(&serde_json::to_string(&claim).unwrap())
                .unwrap()
        );

        let result = ActivityResultRecordedV1 {
            run_id: claim.run_id.clone(),
            activity_id: claim.activity_id.clone(),
            idempotency_key: claim.idempotency_key.clone(),
            claim_event_id: EventId::new(),
            claim_event_digest: DIGEST.into(),
            lease_id: claim.lease_id.clone(),
            outcome: ActivityResultOutcomeV1::Succeeded,
            result_digest: Some(DIGEST.into()),
            result_ref: Some("cas:result-1".into()),
            evidence_digest: DIGEST.into(),
            evidence_ref: "cas:evidence-1".into(),
            recorded_at: "2026-07-18T00:00:01Z".into(),
        };
        assert_eq!(
            result,
            serde_json::from_str::<ActivityResultRecordedV1>(
                &serde_json::to_string(&result).unwrap()
            )
            .unwrap()
        );

        let claim_json = serde_json::to_string(&claim).unwrap();
        let claim_with_unknown = format!(
            "{},\"forged_authority\":true}}",
            claim_json.trim_end_matches('}')
        );
        assert!(
            serde_json::from_str::<ActivityClaimedV1>(&claim_with_unknown).is_err(),
            "authority-bearing activity claims must reject unknown fields"
        );
    }

    #[test]
    fn generic_claim_purpose_is_omitted_so_historical_payloads_replay_identically() {
        let encoded = serde_json::to_value(claim()).unwrap();
        assert!(
            encoded.get("purpose").is_none(),
            "generic is the historical default and must not alter old canonical payloads"
        );
        let decoded: ActivityClaimedV1 = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded.purpose, ActivityClaimPurposeV1::Generic);
    }

    #[test]
    fn purpose_specific_claims_serialize_their_signed_lane_marker() {
        let mut verifier_claim = claim();
        verifier_claim.purpose = ActivityClaimPurposeV1::GovernedVerifierV1;
        let encoded = serde_json::to_value(&verifier_claim).unwrap();
        assert_eq!(
            encoded.get("purpose").and_then(serde_json::Value::as_str),
            Some("governed_verifier_v1"),
            "the fixed verifier lane must be explicit signed payload data"
        );
        assert_eq!(
            serde_json::from_value::<ActivityClaimedV1>(encoded).unwrap(),
            verifier_claim
        );

        let mut model_claim = claim();
        model_claim.purpose = ActivityClaimPurposeV1::GovernedModelActionV1;
        let encoded = serde_json::to_value(&model_claim).unwrap();
        assert_eq!(
            encoded.get("purpose").and_then(serde_json::Value::as_str),
            Some("governed_model_action_v1"),
            "the dedicated model authority lane must be explicit signed payload data"
        );
        assert_eq!(
            serde_json::from_value::<ActivityClaimedV1>(encoded).unwrap(),
            model_claim
        );
    }

    #[test]
    fn heartbeat_is_closed_and_requires_a_forward_lease_extension() {
        let claim = claim();
        let heartbeat = ActivityHeartbeatRecordedV1 {
            run_id: claim.run_id,
            activity_id: claim.activity_id,
            idempotency_key: claim.idempotency_key,
            heartbeat_id: Some("heartbeat-1".into()),
            heartbeat_request_digest: Some(DIGEST.into()),
            claim_event_id: EventId::new(),
            claim_event_digest: DIGEST.into(),
            lease_id: claim.lease_id,
            dispatch_event_id: claim.dispatch_event_id,
            dispatch_envelope_digest: DIGEST.into(),
            lease_expires_at: "2026-07-18T00:02:00Z".into(),
            heartbeat_at: "2026-07-18T00:01:00Z".into(),
        };
        assert_eq!(
            heartbeat,
            serde_json::from_str::<ActivityHeartbeatRecordedV1>(
                &serde_json::to_string(&heartbeat).unwrap()
            )
            .unwrap()
        );
        validate_activity_heartbeat_recorded_v1(&heartbeat)
            .expect("a forward heartbeat is a valid closed payload");

        let heartbeat_json = serde_json::to_string(&heartbeat).unwrap();
        let heartbeat_with_unknown = format!(
            "{},\"forged_authority\":true}}",
            heartbeat_json.trim_end_matches('}')
        );
        assert!(
            serde_json::from_str::<ActivityHeartbeatRecordedV1>(&heartbeat_with_unknown).is_err(),
            "heartbeats must reject unknown fields"
        );

        let mut legacy_json = serde_json::to_value(&heartbeat).unwrap();
        legacy_json
            .as_object_mut()
            .expect("heartbeat payload is an object")
            .remove("heartbeat_id");
        legacy_json
            .as_object_mut()
            .expect("heartbeat payload remains an object")
            .remove("heartbeat_request_digest");
        let legacy: ActivityHeartbeatRecordedV1 = serde_json::from_value(legacy_json.clone())
            .expect("historical heartbeat payloads remain readable");
        assert_eq!(legacy.heartbeat_id, None);
        assert_eq!(legacy.heartbeat_request_digest, None);
        assert_eq!(
            serde_json::to_value(&legacy).unwrap(),
            legacy_json,
            "historical heartbeat canonical JSON must not gain synthetic fields"
        );
        validate_activity_heartbeat_recorded_v1(&legacy)
            .expect("historical heartbeat payloads remain valid for replay");

        let mut partial_request_identity = heartbeat.clone();
        partial_request_identity.heartbeat_id = None;
        assert!(
            validate_activity_heartbeat_recorded_v1(&partial_request_identity).is_err(),
            "new heartbeat identity fields must be present together"
        );

        let mut backwards = heartbeat;
        backwards.lease_expires_at = backwards.heartbeat_at.clone();
        assert!(
            validate_activity_heartbeat_recorded_v1(&backwards).is_err(),
            "heartbeat payloads cannot claim an already-expired lease"
        );
    }
}
