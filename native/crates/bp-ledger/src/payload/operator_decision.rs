//! M5-S1: `operator_decision_recorded` payload — operator approve/reject verdict
//! on a merge or resume subject. Signed by the kernel key; the operator identity
//! is the `decided_by` payload field (same convention as `plan_admitted` /
//! `acceptance_recorded`).

use serde::{Deserialize, Serialize};
use typeshare::typeshare;

/// `operator_decision_recorded` payload — records one operator decision on the
/// tape. All fields are strings on the wire (no `u64` precision hazard).
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperatorDecisionRecordedV1 {
    pub run_id: String,
    /// `approved` | `rejected`
    pub decision: String,
    /// `merge` | `resume` (M5) | `authorize-envelope` (GAP-10)
    pub subject: String,
    /// Chains to the `acceptance_recorded` event, when present (string event id).
    pub acceptance_event_id: Option<String>,
    /// Chains to the `plan_admitted` event, when present (string event id).
    pub admission_event_id: Option<String>,
    /// Merge commit SHA, present when an approved merge produced one.
    pub merge_commit: Option<String>,
    /// Canonical-JSON of the `AuthorizationEnvelopeV0` when `subject` is
    /// `authorize-envelope` (GAP-10); `None` otherwise. A string, not a nested
    /// typeshared struct — `max_iterations`/`token_budget` integers live inside
    /// the JSON string, so the wire shape stays all-string (no `u64` hazard).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub envelope: Option<String>,
    /// Operator identity (payload field; the event is kernel-signed).
    pub decided_by: String,
    /// RFC3339
    pub decided_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> OperatorDecisionRecordedV1 {
        OperatorDecisionRecordedV1 {
            run_id: "01919000-0000-7000-8000-0000000000ff".into(),
            decision: "approved".into(),
            subject: "merge".into(),
            acceptance_event_id: Some("01919000-0000-7000-8000-000000000005".into()),
            admission_event_id: Some("01919000-0000-7000-8000-000000000004".into()),
            merge_commit: Some("deadbeef".into()),
            envelope: None,
            decided_by: "operator@buildplane".into(),
            decided_at: "2026-06-22T12:00:00Z".into(),
        }
    }

    #[test]
    fn operator_decision_recorded_v1_round_trips() {
        let p = fixture();
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(
            p,
            serde_json::from_str::<OperatorDecisionRecordedV1>(&s).unwrap()
        );
    }
}
