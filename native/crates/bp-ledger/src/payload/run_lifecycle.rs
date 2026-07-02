//! Run lifecycle payloads: RunStarted, RunCompleted, RunFailed, RunAdmissionRecorded.

use crate::id::{EventId, RunId};
use crate::types::U64;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use typeshare::typeshare;

/// `run_started` payload — the root of the event tree.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunStartedV1 {
    /// Sha256 of the packet JSON; actual bytes in CAS.
    pub packet_hash: String,
    /// Git HEAD commit at run start.
    pub git_head: String,
    /// Workspace absolute path.
    pub workspace_path: String,
    /// Provider/model/tool config captured at start (opaque map; values stored as-is).
    pub config: BTreeMap<String, serde_json::Value>,
    /// Optional parent run id if this run was forked from another.
    pub parent_run_id: Option<RunId>,
    /// Optional parent event id (unit_started) this fork branched from.
    /// None for top-level runs and for tapes written before Phase E.
    #[serde(default)]
    pub parent_event_id: Option<EventId>,
}

/// `run_completed` payload.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunCompletedV1 {
    pub outcome: RunOutcome,
    pub duration_ms: U64,
    pub event_count: U64,
    pub unit_count: U64,
}

/// `result_ready` payload (M6-S6) — signals that a run reached a terminal,
/// operator-reviewable accepted result. Chains to the `plan_admitted` and
/// `acceptance_recorded` events that authorized and accepted the run. All fields
/// are strings on the wire (no `u64` precision hazard) so Rust↔TS digests are
/// byte-identical.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResultReadyV1 {
    pub run_id: String,
    /// Chains to the `plan_admitted` event (string event id).
    pub admission_event_id: String,
    /// Chains to the `acceptance_recorded` event (string event id).
    pub acceptance_event_id: String,
}

/// `run_failed` payload — a terminal failure that the run can't recover from.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunFailedV1 {
    pub reason: String,
    pub terminating_event_id: Option<EventId>,
}

/// `run_admission_recorded` payload — compact kernel-owned admission summary.
///
/// The full admission receipt is stored out-of-band and bound by
/// `receipt_digest`/`receipt_ref`. This event repeats only the deterministic
/// gating summary needed for inspection, replay, and dispatch decisions.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunAdmissionRecordedV1 {
    /// Stable local receipt id for this admission attempt.
    pub receipt_id: String,
    /// Sha256 of canonical full receipt JSON, formatted as `sha256:<hex>`.
    pub receipt_digest: String,
    /// Optional CAS/artifact reference for the full receipt JSON.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_ref: Option<String>,
    /// Deterministic key over normalized admission inputs.
    pub idempotency_key: String,
    /// Final fail-closed admission decision.
    pub decision: RunAdmissionDecision,
    /// Policy/admission profile used to evaluate the request.
    pub policy_profile_id: String,
    /// Side effects requested by the run/unit.
    pub requested_side_effects: Vec<String>,
    /// Explicitly granted side effects for the admitted scope.
    pub allowed_side_effects: Vec<String>,
    /// Requested side effects denied by policy, preserved for review.
    pub denied_side_effects: Vec<RunAdmissionDeniedSideEffectV1>,
    /// Required evidence that was absent, stale, or unreadable.
    pub missing_evidence: Vec<String>,
    /// Requested authority that made the attempt unsafe.
    pub unsafe_requests: Vec<String>,
    /// Local deterministic evidence inputs considered by admission.
    pub evidence_inputs: Vec<RunAdmissionEvidenceInputV1>,
    /// Whether the admitted bundle/worktree/artifacts remain quarantined.
    pub quarantine: bool,
    /// True only for live PASS admission after durable append/flush succeeds.
    pub will_execute_worker: bool,
    /// Next step authorized by this receipt, if any.
    pub authorized_next_step: String,
    /// Kernel/policy authority that produced the decision.
    pub decided_by: String,
    /// Decision timestamp captured in the full receipt.
    pub decided_at: String,
}

/// Closed admission decision vocabulary.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RunAdmissionDecision {
    Pass,
    Blocked,
    Failed,
    InsufficientEvidence,
    UnsafeToRun,
}

/// Requested side effect denied by policy with a human-readable reason.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunAdmissionDeniedSideEffectV1 {
    pub effect: String,
    pub reason: String,
}

/// Deterministic evidence input considered by run admission.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunAdmissionEvidenceInputV1 {
    pub kind: String,
    pub reference: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    pub required: bool,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunOutcome {
    Passed,
    Failed,
    Cancelled,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_started_v1_round_trips() {
        let payload = RunStartedV1 {
            packet_hash: "sha256:abc".into(),
            git_head: "deadbeef".into(),
            workspace_path: "/tmp/ws".into(),
            config: BTreeMap::new(),
            parent_run_id: None,
            parent_event_id: None,
        };
        let s = serde_json::to_string(&payload).unwrap();
        let back: RunStartedV1 = serde_json::from_str(&s).unwrap();
        assert_eq!(payload, back);
    }

    #[test]
    fn run_started_v1_backward_compat_missing_parent_event_id() {
        // Old tapes written before Phase E will not have parent_event_id.
        // Deserialization must succeed and default it to None.
        let old_json = r#"{
            "packet_hash": "sha256:abc",
            "git_head": "deadbeef",
            "workspace_path": "/tmp/ws",
            "config": {},
            "parent_run_id": null
        }"#;
        let back: RunStartedV1 = serde_json::from_str(old_json).unwrap();
        assert_eq!(back.parent_event_id, None);
    }

    #[test]
    fn run_completed_v1_round_trips() {
        let payload = RunCompletedV1 {
            outcome: RunOutcome::Passed,
            duration_ms: 1234,
            event_count: 42,
            unit_count: 3,
        };
        let s = serde_json::to_string(&payload).unwrap();
        let back: RunCompletedV1 = serde_json::from_str(&s).unwrap();
        assert_eq!(payload, back);
    }

    #[test]
    fn result_ready_v1_round_trips() {
        let payload = ResultReadyV1 {
            run_id: "01919000-0000-7000-8000-0000000000ff".into(),
            admission_event_id: "01919000-0000-7000-8000-000000000004".into(),
            acceptance_event_id: "01919000-0000-7000-8000-000000000005".into(),
        };
        let s = serde_json::to_string(&payload).unwrap();
        let back: ResultReadyV1 = serde_json::from_str(&s).unwrap();
        assert_eq!(payload, back);
    }

    #[test]
    fn run_failed_v1_round_trips() {
        let payload = RunFailedV1 {
            reason: "worker timeout".into(),
            terminating_event_id: Some(EventId::new()),
        };
        let s = serde_json::to_string(&payload).unwrap();
        let back: RunFailedV1 = serde_json::from_str(&s).unwrap();
        assert_eq!(payload, back);
    }
}
