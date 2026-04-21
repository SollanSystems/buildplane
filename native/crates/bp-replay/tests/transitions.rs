//! Per-EventKind state transition tests.

use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::git_checkpoint::{CheckpointBoundary, GitCheckpointV1, GitStatus};
use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome, RunStartedV1};
use bp_ledger::payload::unit_lifecycle::UnitStartedV1;
use bp_ledger::payload::workspace::{PostWriteState, WorkspaceWriteV1};
use bp_ledger::payload::Payload;
use bp_replay::state::{ReplayIssue, ReplayState};
use bp_replay::transitions::apply;
use chrono::Utc;
use std::collections::BTreeMap;

fn event_of(kind: EventKind, payload: Payload) -> Event {
    Event {
        id: EventId::new(),
        run_id: RunId::new(),
        parent_event_id: None,
        schema_version: 1,
        kind,
        occurred_at: Utc::now(),
        payload,
    }
}

#[test]
fn run_started_sets_run_id_and_pushes_parent_chain() {
    let mut state = ReplayState::default();
    let event = event_of(
        EventKind::RunStarted,
        Payload::RunStartedV1(RunStartedV1 {
            packet_hash: "sha256:aa".into(),
            git_head: "dead".into(),
            workspace_path: "/ws".into(),
            config: BTreeMap::new(),
            parent_run_id: None,
            parent_event_id: None,
        }),
    );
    apply(&mut state, &event);
    assert!(state.run_id.is_some());
    assert_eq!(state.parent_chain.len(), 1);
    assert_eq!(state.parent_chain[0], event.id);
}

#[test]
fn unit_started_sets_current_unit() {
    let mut state = ReplayState::default();
    let event = event_of(
        EventKind::UnitStarted,
        Payload::UnitStartedV1(UnitStartedV1 {
            unit_id: "u-1".into(),
            parent_unit_id: None,
            unit_kind: "command".into(),
            policy: serde_json::json!({}),
        }),
    );
    apply(&mut state, &event);
    assert_eq!(state.current_unit, Some("u-1".to_string()));
}

#[test]
fn run_completed_clears_parent_chain() {
    let mut state = ReplayState {
        parent_chain: vec![EventId::new(), EventId::new()],
        ..ReplayState::default()
    };
    let event = event_of(
        EventKind::RunCompleted,
        Payload::RunCompletedV1(RunCompletedV1 {
            outcome: RunOutcome::Passed,
            duration_ms: 0,
            event_count: 0,
            unit_count: 0,
        }),
    );
    apply(&mut state, &event);
    assert_eq!(state.parent_chain.len(), 0);
}

#[test]
fn git_checkpoint_ok_pushes_to_checkpoints() {
    let mut state = ReplayState::default();
    let event = event_of(
        EventKind::GitCheckpoint,
        Payload::GitCheckpointV1(GitCheckpointV1 {
            boundary: CheckpointBoundary::PreUnit,
            reference: "refs/buildplane/run/X".into(),
            commit_sha: "a".repeat(40),
            unit_id: "u-1".into(),
            git_status: GitStatus::Ok,
        }),
    );
    apply(&mut state, &event);
    assert_eq!(state.checkpoints.len(), 1);
    assert_eq!(state.checkpoints[0].commit_sha, "a".repeat(40));
    assert_eq!(state.issues.len(), 0);
}

#[test]
fn git_checkpoint_failed_pushes_to_issues() {
    let mut state = ReplayState::default();
    let event = event_of(
        EventKind::GitCheckpoint,
        Payload::GitCheckpointV1(GitCheckpointV1 {
            boundary: CheckpointBoundary::PreUnit,
            reference: "refs/buildplane/run/X".into(),
            commit_sha: String::new(),
            unit_id: "u-1".into(),
            git_status: GitStatus::Failed { error: "worktree dirty".into() },
        }),
    );
    apply(&mut state, &event);
    assert_eq!(state.checkpoints.len(), 0);
    assert_eq!(state.issues.len(), 1);
    assert!(matches!(&state.issues[0], ReplayIssue::CheckpointFailed { .. }));
}

#[test]
fn workspace_write_captured_updates_observed_files() {
    let mut state = ReplayState::default();
    let event = event_of(
        EventKind::WorkspaceWrite,
        Payload::WorkspaceWriteV1(WorkspaceWriteV1 {
            tool_request_id: EventId::new(),
            path: "out.txt".into(),
            hash_before: None,
            after: PostWriteState::Captured { hash: "sha256:bb".into(), size_bytes: 3 },
        }),
    );
    apply(&mut state, &event);
    assert_eq!(state.observed_files.len(), 1);
    let obs = state.observed_files.get("out.txt").unwrap();
    assert_eq!(obs.last_known_hash, "sha256:bb");
}

#[test]
fn workspace_write_unreadable_pushes_issue() {
    let mut state = ReplayState::default();
    let event = event_of(
        EventKind::WorkspaceWrite,
        Payload::WorkspaceWriteV1(WorkspaceWriteV1 {
            tool_request_id: EventId::new(),
            path: "locked.txt".into(),
            hash_before: None,
            after: PostWriteState::Unreadable { reason: "EACCES".into() },
        }),
    );
    apply(&mut state, &event);
    assert_eq!(state.observed_files.len(), 0);
    assert_eq!(state.issues.len(), 1);
    assert!(matches!(&state.issues[0], ReplayIssue::UnreadablePostWrite { .. }));
}
