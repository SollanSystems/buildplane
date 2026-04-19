//! Replay state types.

use bp_ledger::id::EventId;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Accumulated state of a run, rebuilt by the ReplayEngine by applying each
/// event's transition function.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ReplayState {
    /// Run id. Set on first run_started event.
    pub run_id: Option<String>,
    /// Currently-active unit. Set on unit_started; cleared on
    /// unit_completed/unit_failed/unit_cancelled.
    pub current_unit: Option<String>,
    /// Causal chain of parent event ids — events "entered" but not yet "exited".
    pub parent_chain: Vec<EventId>,
    /// Last known content hash per observed file path.
    pub observed_files: BTreeMap<String, FileObservation>,
    /// All git checkpoints reachable from the run.
    pub checkpoints: Vec<CheckpointRef>,
    /// Non-fatal issues surfaced during replay.
    pub issues: Vec<ReplayIssue>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FileObservation {
    pub last_known_hash: String,
    pub from_event_id: EventId,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CheckpointRef {
    pub boundary: String,
    pub reference: String,
    pub commit_sha: String,
    pub unit_id: String,
    pub from_event_id: EventId,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReplayIssue {
    CheckpointFailed {
        unit_id: String,
        step: String,
        error: String,
    },
    UnreadablePostWrite {
        path: String,
        reason: String,
    },
    DanglingParent {
        event_id: EventId,
        parent_event_id: EventId,
    },
    TargetNotFound {
        requested: String,
    },
}
