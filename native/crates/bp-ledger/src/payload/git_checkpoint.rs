//! Git checkpoint payload — emitted at unit boundaries as the safety net for
//! file-system changes outside the tool adapter.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GitCheckpointV1 {
    /// Boundary position relative to the unit.
    pub boundary: CheckpointBoundary,
    /// Fully-qualified ref path, e.g. `refs/buildplane/run/<run-id>/<unit-id>`.
    pub reference: String,
    /// Commit SHA-1. Always 40 hex chars (no short form).
    pub commit_sha: String,
    /// Associated unit id.
    pub unit_id: String,
    /// If the git operation failed, this carries the reason; commit_sha may be empty.
    pub git_status: GitStatus,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CheckpointBoundary {
    PreUnit,
    PostUnit,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum GitStatus {
    Ok,
    Failed { error: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_checkpoint_ok_round_trips() {
        let p = GitCheckpointV1 {
            boundary: CheckpointBoundary::PreUnit,
            reference: "refs/buildplane/run/R/U".into(),
            commit_sha: "0".repeat(40),
            unit_id: "U".into(),
            git_status: GitStatus::Ok,
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<GitCheckpointV1>(&s).unwrap());
    }

    #[test]
    fn git_checkpoint_failed_preserves_error() {
        let p = GitCheckpointV1 {
            boundary: CheckpointBoundary::PostUnit,
            reference: "refs/buildplane/run/R/U".into(),
            commit_sha: String::new(),
            unit_id: "U".into(),
            git_status: GitStatus::Failed {
                error: "worktree is dirty".into(),
            },
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<GitCheckpointV1>(&s).unwrap());
    }
}
