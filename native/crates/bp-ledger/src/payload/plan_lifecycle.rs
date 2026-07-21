//! Plan lifecycle payloads (M2): PlanAdmitted, PlanReceiptRecorded.

use crate::id::EventId;
use serde::{Deserialize, Serialize};
use typeshare::typeshare;

/// `plan_admitted` payload — operator-approved PlanForge admission; the dispatch
/// authority. Signed by the kernel key; the operator identity is `decided_by`.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanAdmittedV1 {
    /// Stable PlanForge plan id (e.g. `pf-plan-<fingerprint>`).
    pub plan_id: String,
    /// Canonical digest of the admitted plan, `sha256:<hex>`.
    pub plan_digest: String,
    /// Canonical digest of the compiled input, `sha256:<hex>`.
    pub input_digest: String,
    /// Trusted base commit the plan was admitted against.
    pub trusted_base: String,
    /// Operator identity recorded as a payload field (kernel key signs the event).
    pub decided_by: String,
    /// Admission timestamp, RFC3339.
    pub decided_at: String,
    /// Deterministic idempotency key over normalized plan inputs.
    pub idempotency_key: String,
    /// Next step this admission authorizes.
    pub authorized_next_step: String,
}

/// `plan_receipt` payload — terminal signed receipt chaining to the admission event.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanReceiptRecordedV1 {
    pub plan_id: String,
    /// The `plan_admitted` event this receipt finalizes.
    pub admission_event_id: EventId,
    pub outcome: PlanReceiptOutcome,
    /// Actual side effects recorded for the completed plan.
    pub side_effects: Vec<String>,
    /// Canonical digest binding the recorded result, `sha256:<hex>`.
    pub result_digest: String,
    /// Receipt timestamp, RFC3339.
    pub decided_at: String,
}

/// Closed terminal outcome vocabulary for a plan receipt.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanReceiptOutcome {
    Completed,
    Failed,
    Aborted,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn admitted() -> PlanAdmittedV1 {
        PlanAdmittedV1 {
            plan_id: "pf-plan-001".into(),
            plan_digest: "sha256:aa".into(),
            input_digest: "sha256:bb".into(),
            trusted_base: "deadbeef".into(),
            decided_by: "operator:khall".into(),
            decided_at: "2026-05-30T00:00:00Z".into(),
            idempotency_key: "planforge:v0:buildplane:deadbeef:abcd1234".into(),
            authorized_next_step: "dispatch_admitted_plan".into(),
        }
    }

    #[test]
    fn plan_admitted_v1_round_trips() {
        let p = admitted();
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<PlanAdmittedV1>(&s).unwrap());
    }

    #[test]
    fn plan_receipt_v1_round_trips() {
        let p = PlanReceiptRecordedV1 {
            plan_id: "pf-plan-001".into(),
            admission_event_id: EventId::new(),
            outcome: PlanReceiptOutcome::Completed,
            side_effects: vec!["fs.write:declared_scope".into()],
            result_digest: "sha256:cc".into(),
            decided_at: "2026-05-30T00:01:00Z".into(),
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(
            p,
            serde_json::from_str::<PlanReceiptRecordedV1>(&s).unwrap()
        );
    }

    #[test]
    fn plan_receipt_outcome_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&PlanReceiptOutcome::Aborted).unwrap(),
            r#""aborted""#
        );
    }
}
