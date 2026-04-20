//! Unit lifecycle payloads: UnitStarted, UnitCompleted, UnitFailed, UnitCancelled.

use crate::id::EventId;
use crate::types::U64;
use serde::{Deserialize, Serialize};
use typeshare::typeshare;

#[typeshare]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UnitStartedV1 {
    pub unit_id: String,
    pub parent_unit_id: Option<String>,
    pub unit_kind: String,
    /// Snapshot of policy at unit start (opaque JSON).
    pub policy: serde_json::Value,
}

#[typeshare]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UnitCompletedV1 {
    pub unit_id: String,
    pub outcome: UnitOutcome,
    /// Artifacts produced, addressed by CAS hash.
    pub artifacts: Vec<ArtifactRef>,
}

#[typeshare]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UnitFailedV1 {
    pub unit_id: String,
    pub reason: String,
    pub terminating_event_id: Option<EventId>,
}

#[typeshare]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UnitCancelledV1 {
    pub unit_id: String,
    pub cause: CancelCause,
}

#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnitOutcome {
    Passed,
    Failed,
}

#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelCause {
    Timeout,
    ParentFailed,
    OperatorInterrupt,
}

#[typeshare]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ArtifactRef {
    pub path: String,
    pub hash: String,
    pub size_bytes: U64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unit_started_v1_round_trips() {
        let p = UnitStartedV1 {
            unit_id: "u-1".into(),
            parent_unit_id: None,
            unit_kind: "command".into(),
            policy: json!({"retries": 0}),
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<UnitStartedV1>(&s).unwrap());
    }

    #[test]
    fn unit_completed_v1_round_trips() {
        let p = UnitCompletedV1 {
            unit_id: "u-1".into(),
            outcome: UnitOutcome::Passed,
            artifacts: vec![ArtifactRef {
                path: "out.txt".into(),
                hash: "sha256:aa".into(),
                size_bytes: 3,
            }],
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<UnitCompletedV1>(&s).unwrap());
    }

    #[test]
    fn unit_failed_v1_round_trips() {
        let p = UnitFailedV1 {
            unit_id: "u-1".into(),
            reason: "non-zero exit".into(),
            terminating_event_id: None,
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<UnitFailedV1>(&s).unwrap());
    }

    #[test]
    fn unit_cancelled_v1_round_trips() {
        let p = UnitCancelledV1 {
            unit_id: "u-1".into(),
            cause: CancelCause::Timeout,
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<UnitCancelledV1>(&s).unwrap());
    }
}
