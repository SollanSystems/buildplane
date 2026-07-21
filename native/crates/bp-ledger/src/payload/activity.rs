//! Activity bracketing payloads (M2): ActivityStarted, ActivityCompleted.
//! These bracket every I/O activity for Temporal-style replay — on replay the
//! kernel reads the recorded `result` and never re-invokes the model/tool.

use crate::id::RunId;
use serde::{Deserialize, Serialize};
use typeshare::typeshare;

/// `activity_started` payload — write-ahead bracket appended (and signed) BEFORE
/// an I/O activity is invoked, so a crash mid-invoke is recoverable.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityStartedV1 {
    pub run_id: RunId,
    /// Stable per-run activity id; pairs with the completing event.
    pub activity_id: String,
    pub activity_type: ActivityType,
    /// Canonical digest of the activity input, `sha256:<hex>`.
    pub input_digest: String,
}

/// `activity_completed` payload — records the activity result for replay.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ActivityCompletedV1 {
    pub run_id: RunId,
    pub activity_id: String,
    /// Canonical digest binding `result`, `sha256:<hex>`.
    pub result_digest: String,
    /// Recorded model/tool/command output, replayed verbatim instead of re-invoking.
    pub result: serde_json::Value,
}

/// Closed activity-type vocabulary.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityType {
    Model,
    Tool,
    Command,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::id::RunId;
    use serde_json::json;

    #[test]
    fn activity_started_v1_round_trips() {
        let p = ActivityStartedV1 {
            run_id: RunId::new(),
            activity_id: "act-1".into(),
            activity_type: ActivityType::Model,
            input_digest: "sha256:dd".into(),
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<ActivityStartedV1>(&s).unwrap());
    }

    #[test]
    fn activity_completed_v1_round_trips_with_opaque_result() {
        let p = ActivityCompletedV1 {
            run_id: RunId::new(),
            activity_id: "act-1".into(),
            result_digest: "sha256:ee".into(),
            result: json!({"content": "ok", "tool_calls": []}),
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<ActivityCompletedV1>(&s).unwrap());
    }

    #[test]
    fn activity_type_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&ActivityType::Command).unwrap(),
            r#""command""#
        );
    }
}
