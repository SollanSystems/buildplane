//! Run lifecycle payloads: RunStarted, RunCompleted, RunFailed.

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

/// `run_failed` payload — a terminal failure that the run can't recover from.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunFailedV1 {
    pub reason: String,
    pub terminating_event_id: Option<EventId>,
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
