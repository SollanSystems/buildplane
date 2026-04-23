//! ForkPlan: the serialized plan bp-cli emits on stdout, TS CLI consumes.

use serde::{Deserialize, Serialize};

/// Plan returned by `build_fork_plan`. Describes everything TS needs to
/// execute a fork: new run_id, workspace checkout SHA, packet bytes, lineage.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ForkPlan {
    /// Fresh UUIDv7 run_id for the fork.
    pub new_run_id: String,
    /// Absolute workspace path (mirrors the --workspace arg).
    pub workspace_path: String,
    /// Pre-unit git checkpoint SHA to `git checkout` before execution.
    pub checkout_sha: String,
    /// New packet bytes, as parsed JSON. TS re-serializes into its pipeline.
    pub packet_json: serde_json::Value,
    /// Parent run_id for lineage.
    pub parent_run_id: String,
    /// Parent event_id (the unit_started we forked at).
    pub parent_event_id: String,
}
