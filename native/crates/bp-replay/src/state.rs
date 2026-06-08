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
    /// Parent run id if this is a fork. None for top-level runs.
    pub parent_run_id: Option<String>,
    /// Parent event id (unit_started) this fork branched from. None for top-level runs.
    pub parent_event_id: Option<String>,
    /// Currently-active unit. Set on unit_started; cleared on
    /// unit_completed/unit_failed/unit_cancelled.
    pub current_unit: Option<String>,
    /// Causal chain of parent event ids — events "entered" but not yet "exited".
    pub parent_chain: Vec<EventId>,
    /// Current PlanForge admission-cycle phase reconstructed from signed tape
    /// events. Empty means no PlanForge cycle event has been replayed yet.
    #[serde(default)]
    pub plan_cycle_phase: String,
    /// Last signed `plan_admitted` event observed for this run, if any.
    #[serde(default)]
    pub plan_admission: Option<PlanAdmissionReplayState>,
    /// Activity bracket state keyed by stable per-run `activity_id`. Completed
    /// activities retain their recorded result so recovery code can replay the
    /// result without reinvoking the model/tool/command.
    #[serde(default)]
    pub activities: BTreeMap<String, RecordedActivityState>,
    /// Terminal signed `plan_receipt` state, if emitted.
    #[serde(default)]
    pub plan_receipt: Option<PlanReceiptReplayState>,
    /// Last known content hash per observed file path.
    pub observed_files: BTreeMap<String, FileObservation>,
    /// All git checkpoints reachable from the run.
    pub checkpoints: Vec<CheckpointRef>,
    /// Non-fatal issues surfaced during replay.
    pub issues: Vec<ReplayIssue>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanAdmissionReplayState {
    pub event_id: EventId,
    pub plan_id: String,
    pub plan_digest: String,
    pub input_digest: String,
    pub trusted_base: String,
    pub decided_by: String,
    pub decided_at: String,
    pub idempotency_key: String,
    pub authorized_next_step: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RecordedActivityState {
    pub run_id: Option<String>,
    pub activity_id: String,
    pub activity_type: Option<String>,
    pub input_digest: Option<String>,
    pub started_event_id: Option<EventId>,
    pub completed_event_id: Option<EventId>,
    pub result_digest: Option<String>,
    pub result: Option<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanReceiptReplayState {
    pub event_id: EventId,
    pub plan_id: String,
    pub admission_event_id: EventId,
    pub outcome: String,
    pub side_effects: Vec<String>,
    pub result_digest: String,
    pub decided_at: String,
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
