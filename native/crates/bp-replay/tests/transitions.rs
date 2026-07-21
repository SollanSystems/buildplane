//! Per-EventKind state transition tests.

use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::activity::{ActivityCompletedV1, ActivityStartedV1, ActivityType};
use bp_ledger::payload::git_checkpoint::{CheckpointBoundary, GitCheckpointV1, GitStatus};
use bp_ledger::payload::plan_lifecycle::{
    PlanAdmittedV1, PlanReceiptOutcome, PlanReceiptRecordedV1,
};
use bp_ledger::payload::run_lifecycle::{RunCompletedV1, RunOutcome, RunStartedV1};
use bp_ledger::payload::trust_spine::{
    CommitModeV1, DispatchBudgetV1, DispatchEnvelopeV1, ExecutionRoleV1, SignatureRefV1,
    TrustTierV1,
};
use bp_ledger::payload::unit_lifecycle::UnitStartedV1;
use bp_ledger::payload::workspace::{PostWriteState, WorkspaceWriteV1};
use bp_ledger::payload::Payload;
use bp_replay::state::{ReplayIssue, ReplayState};
use bp_replay::transitions::apply;
use chrono::Utc;
use std::collections::BTreeMap;

fn event_of(kind: EventKind, payload: Payload) -> Event {
    event_for_run(RunId::new(), kind, payload)
}

fn event_for_run(run_id: RunId, kind: EventKind, payload: Payload) -> Event {
    Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: 1,
        kind,
        occurred_at: Utc::now(),
        payload,
    }
}

fn governed_dispatch_event(run_id: RunId) -> Event {
    let digest_a = format!("sha256:{}", "a".repeat(64));
    let digest_b = format!("sha256:{}", "b".repeat(64));
    let digest_c = format!("sha256:{}", "c".repeat(64));
    event_for_run(
        run_id,
        EventKind::DispatchEnvelope,
        Payload::DispatchEnvelopeV1(DispatchEnvelopeV1 {
            workflow_id: "workflow-activity".into(),
            workflow_revision: "r1".into(),
            unit_id: "unit-activity".into(),
            attempt: 1,
            execution_role: ExecutionRoleV1::Implementer,
            commit_mode: CommitModeV1::Atomic,
            provenance_ref: "admission:activity".into(),
            base_commit_sha: "1".repeat(40),
            capability_bundle_digest: digest_a.clone(),
            acceptance_contract_digest: digest_b.clone(),
            context_manifest_digest: digest_c.clone(),
            worker_manifest_digest: digest_a,
            sandbox_profile_digest: digest_b,
            budget: DispatchBudgetV1 {
                max_tokens: Some(1),
                max_compute_time_ms: Some(1),
            },
            trust_tier: TrustTierV1::Governed,
            idempotency_key: "dispatch:workflow-activity:unit-activity:1".into(),
            issued_at: "2026-07-18T00:00:00Z".into(),
            expires_at: "2026-07-18T01:00:00Z".into(),
            envelope_digest: digest_c,
            signature_ref: SignatureRefV1 {
                algorithm: "ed25519".into(),
                key_id: "kernel-main".into(),
                signature: "detached-signature".into(),
            },
        }),
    )
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
            duration_ms: "0".into(),
            event_count: "0".into(),
            unit_count: "0".into(),
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
            git_status: GitStatus::Failed {
                error: "worktree dirty".into(),
            },
        }),
    );
    apply(&mut state, &event);
    assert_eq!(state.checkpoints.len(), 0);
    assert_eq!(state.issues.len(), 1);
    assert!(matches!(
        &state.issues[0],
        ReplayIssue::CheckpointFailed { .. }
    ));
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
            after: PostWriteState::Captured {
                hash: "sha256:bb".into(),
                size_bytes: 3,
            },
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
            after: PostWriteState::Unreadable {
                reason: "EACCES".into(),
            },
        }),
    );
    apply(&mut state, &event);
    assert_eq!(state.observed_files.len(), 0);
    assert_eq!(state.issues.len(), 1);
    assert!(matches!(
        &state.issues[0],
        ReplayIssue::UnreadablePostWrite { .. }
    ));
}

#[test]
fn replay_state_deserializes_without_plan_cycle_fields_for_old_receipts() {
    let legacy = serde_json::json!({
        "run_id": null,
        "parent_run_id": null,
        "parent_event_id": null,
        "current_unit": null,
        "parent_chain": [],
        "observed_files": {},
        "checkpoints": [],
        "issues": []
    });

    let state: ReplayState = serde_json::from_value(legacy).expect("legacy replay state");

    assert_eq!(state.plan_cycle_phase, "");
    assert_eq!(state.plan_admission, None);
    assert_eq!(state.activities.len(), 0);
    assert_eq!(state.plan_receipt, None);
    assert_eq!(state.workflow_instance, None);
}

#[test]
fn plan_admitted_records_plan_cycle_phase_and_admission_state() {
    let mut state = ReplayState::default();
    let event = event_of(
        EventKind::PlanAdmitted,
        Payload::PlanAdmittedV1(PlanAdmittedV1 {
            plan_id: "pf-plan-001".into(),
            plan_digest: "sha256:plan".into(),
            input_digest: "sha256:input".into(),
            trusted_base: "deadbeef".into(),
            decided_by: "operator:khall".into(),
            decided_at: "2026-06-08T00:00:00Z".into(),
            idempotency_key: "planforge:v0:test:001".into(),
            authorized_next_step: "dispatch_admitted_plan".into(),
        }),
    );

    apply(&mut state, &event);

    assert_eq!(state.plan_cycle_phase, "plan_admitted");
    let admission = state.plan_admission.as_ref().expect("admission state");
    assert_eq!(admission.event_id, event.id);
    assert_eq!(admission.plan_id, "pf-plan-001");
    assert_eq!(admission.plan_digest, "sha256:plan");
    assert_eq!(admission.input_digest, "sha256:input");
    assert_eq!(admission.trusted_base, "deadbeef");
    assert_eq!(admission.decided_by, "operator:khall");
    assert_eq!(admission.authorized_next_step, "dispatch_admitted_plan");
}

#[test]
fn activity_started_and_completed_records_replayable_result() {
    let mut state = ReplayState::default();
    let run_id = RunId::new();
    let started = event_of(
        EventKind::ActivityStarted,
        Payload::ActivityStartedV1(ActivityStartedV1 {
            run_id,
            activity_id: "activity-1".into(),
            activity_type: ActivityType::Command,
            input_digest: "sha256:activity-input".into(),
        }),
    );
    let completed = event_of(
        EventKind::ActivityCompleted,
        Payload::ActivityCompletedV1(ActivityCompletedV1 {
            run_id,
            activity_id: "activity-1".into(),
            result_digest: "sha256:activity-result".into(),
            result: serde_json::json!({ "status": "passed", "output": "ok" }),
        }),
    );

    apply(&mut state, &started);
    assert_eq!(state.plan_cycle_phase, "activity_started");
    apply(&mut state, &completed);

    assert_eq!(state.plan_cycle_phase, "activity_completed");
    let activity = state.activities.get("activity-1").expect("activity state");
    assert_eq!(activity.started_event_id, Some(started.id));
    assert_eq!(activity.completed_event_id, Some(completed.id));
    assert_eq!(activity.activity_type.as_deref(), Some("command"));
    assert_eq!(
        activity.input_digest.as_deref(),
        Some("sha256:activity-input")
    );
    assert_eq!(
        activity.result_digest.as_deref(),
        Some("sha256:activity-result")
    );
    assert_eq!(
        activity.result,
        Some(serde_json::json!({ "status": "passed", "output": "ok" }))
    );
}

#[test]
fn orphan_activity_completed_records_partial_replay_result() {
    let mut state = ReplayState::default();
    let run_id = RunId::new();
    let completed = event_of(
        EventKind::ActivityCompleted,
        Payload::ActivityCompletedV1(ActivityCompletedV1 {
            run_id,
            activity_id: "activity-orphan".into(),
            result_digest: "sha256:orphan-result".into(),
            result: serde_json::json!({ "status": "passed" }),
        }),
    );

    apply(&mut state, &completed);

    let activity = state
        .activities
        .get("activity-orphan")
        .expect("activity state");
    assert_eq!(activity.started_event_id, None);
    assert_eq!(activity.completed_event_id, Some(completed.id));
    assert_eq!(
        activity.result_digest.as_deref(),
        Some("sha256:orphan-result")
    );
    assert_eq!(
        activity.result,
        Some(serde_json::json!({ "status": "passed" }))
    );
}

#[test]
fn duplicate_activity_completion_uses_last_recorded_result_deterministically() {
    let mut state = ReplayState::default();
    let run_id = RunId::new();
    let started = event_of(
        EventKind::ActivityStarted,
        Payload::ActivityStartedV1(ActivityStartedV1 {
            run_id,
            activity_id: "activity-duplicate".into(),
            activity_type: ActivityType::Tool,
            input_digest: "sha256:dup-input".into(),
        }),
    );
    let first = event_of(
        EventKind::ActivityCompleted,
        Payload::ActivityCompletedV1(ActivityCompletedV1 {
            run_id,
            activity_id: "activity-duplicate".into(),
            result_digest: "sha256:first".into(),
            result: serde_json::json!({ "attempt": 1 }),
        }),
    );
    let second = event_of(
        EventKind::ActivityCompleted,
        Payload::ActivityCompletedV1(ActivityCompletedV1 {
            run_id,
            activity_id: "activity-duplicate".into(),
            result_digest: "sha256:second".into(),
            result: serde_json::json!({ "attempt": 2 }),
        }),
    );

    apply(&mut state, &started);
    apply(&mut state, &first);
    apply(&mut state, &second);

    let activity = state
        .activities
        .get("activity-duplicate")
        .expect("activity state");
    assert_eq!(activity.started_event_id, Some(started.id));
    assert_eq!(activity.completed_event_id, Some(second.id));
    assert_eq!(activity.result_digest.as_deref(), Some("sha256:second"));
    assert_eq!(activity.result, Some(serde_json::json!({ "attempt": 2 })));
}

#[test]
fn governed_activity_rejects_orphan_completion() {
    let mut state = ReplayState::default();
    let run_id = RunId::new();
    let dispatch = governed_dispatch_event(run_id);
    let completed = event_for_run(
        run_id,
        EventKind::ActivityCompleted,
        Payload::ActivityCompletedV1(ActivityCompletedV1 {
            run_id,
            activity_id: "governed-orphan".into(),
            result_digest: "sha256:orphan-result".into(),
            result: serde_json::json!({ "status": "passed" }),
        }),
    );

    apply(&mut state, &dispatch);
    assert_eq!(state.workflow_instances.len(), 1);
    apply(&mut state, &completed);

    assert!(!state.activities.contains_key("governed-orphan"));
    assert!(matches!(
        state.issues.last(),
        Some(ReplayIssue::ActivityTransitionRejected { activity_id, .. })
            if activity_id == "governed-orphan"
    ));
}

#[test]
fn governed_activity_rejects_cross_run_completion() {
    let mut state = ReplayState::default();
    let governed_run_id = RunId::new();
    let unrelated_run_id = RunId::new();
    let dispatch = governed_dispatch_event(governed_run_id);
    let started = event_for_run(
        governed_run_id,
        EventKind::ActivityStarted,
        Payload::ActivityStartedV1(ActivityStartedV1 {
            run_id: governed_run_id,
            activity_id: "governed-cross-run".into(),
            activity_type: ActivityType::Tool,
            input_digest: "sha256:cross-run-input".into(),
        }),
    );
    let cross_run_completion = event_for_run(
        unrelated_run_id,
        EventKind::ActivityCompleted,
        Payload::ActivityCompletedV1(ActivityCompletedV1 {
            run_id: unrelated_run_id,
            activity_id: "governed-cross-run".into(),
            result_digest: "sha256:cross-run-result".into(),
            result: serde_json::json!({ "status": "passed" }),
        }),
    );

    apply(&mut state, &dispatch);
    apply(&mut state, &started);
    apply(&mut state, &cross_run_completion);

    let activity = state
        .activities
        .get("governed-cross-run")
        .expect("governed activity state");
    let governed_run_id_text = governed_run_id.to_string();
    assert_eq!(
        activity.run_id.as_deref(),
        Some(governed_run_id_text.as_str())
    );
    assert_eq!(activity.started_event_id, Some(started.id));
    assert_eq!(activity.completed_event_id, None);
    assert!(matches!(
        state.issues.last(),
        Some(ReplayIssue::ActivityTransitionRejected { activity_id, .. })
            if activity_id == "governed-cross-run"
    ));
}

#[test]
fn governed_activity_rejects_divergent_duplicate_completion() {
    let mut state = ReplayState::default();
    let run_id = RunId::new();
    let dispatch = governed_dispatch_event(run_id);
    let started = event_for_run(
        run_id,
        EventKind::ActivityStarted,
        Payload::ActivityStartedV1(ActivityStartedV1 {
            run_id,
            activity_id: "governed-divergent-duplicate".into(),
            activity_type: ActivityType::Command,
            input_digest: "sha256:duplicate-input".into(),
        }),
    );
    let first = event_for_run(
        run_id,
        EventKind::ActivityCompleted,
        Payload::ActivityCompletedV1(ActivityCompletedV1 {
            run_id,
            activity_id: "governed-divergent-duplicate".into(),
            result_digest: "sha256:first-result".into(),
            result: serde_json::json!({ "attempt": 1 }),
        }),
    );
    let divergent_duplicate = event_for_run(
        run_id,
        EventKind::ActivityCompleted,
        Payload::ActivityCompletedV1(ActivityCompletedV1 {
            run_id,
            activity_id: "governed-divergent-duplicate".into(),
            result_digest: "sha256:second-result".into(),
            result: serde_json::json!({ "attempt": 2 }),
        }),
    );

    apply(&mut state, &dispatch);
    apply(&mut state, &started);
    apply(&mut state, &first);
    apply(&mut state, &divergent_duplicate);

    let activity = state
        .activities
        .get("governed-divergent-duplicate")
        .expect("governed activity state");
    assert_eq!(activity.completed_event_id, Some(first.id));
    assert_eq!(
        activity.result_digest.as_deref(),
        Some("sha256:first-result")
    );
    assert_eq!(activity.result, Some(serde_json::json!({ "attempt": 1 })));
    assert!(matches!(
        state.issues.last(),
        Some(ReplayIssue::ActivityTransitionRejected { activity_id, .. })
            if activity_id == "governed-divergent-duplicate"
    ));
}

#[test]
fn governed_activity_ignores_identical_duplicate_completion() {
    let mut state = ReplayState::default();
    let run_id = RunId::new();
    let dispatch = governed_dispatch_event(run_id);
    let started = event_for_run(
        run_id,
        EventKind::ActivityStarted,
        Payload::ActivityStartedV1(ActivityStartedV1 {
            run_id,
            activity_id: "governed-identical-duplicate".into(),
            activity_type: ActivityType::Model,
            input_digest: "sha256:duplicate-input".into(),
        }),
    );
    let first = event_for_run(
        run_id,
        EventKind::ActivityCompleted,
        Payload::ActivityCompletedV1(ActivityCompletedV1 {
            run_id,
            activity_id: "governed-identical-duplicate".into(),
            result_digest: "sha256:stable-result".into(),
            result: serde_json::json!({ "status": "passed" }),
        }),
    );
    let identical_duplicate = event_for_run(
        run_id,
        EventKind::ActivityCompleted,
        Payload::ActivityCompletedV1(ActivityCompletedV1 {
            run_id,
            activity_id: "governed-identical-duplicate".into(),
            result_digest: "sha256:stable-result".into(),
            result: serde_json::json!({ "status": "passed" }),
        }),
    );

    apply(&mut state, &dispatch);
    apply(&mut state, &started);
    apply(&mut state, &first);
    let issues_before_duplicate = state.issues.len();
    apply(&mut state, &identical_duplicate);

    let activity = state
        .activities
        .get("governed-identical-duplicate")
        .expect("governed activity state");
    assert_eq!(activity.completed_event_id, Some(first.id));
    assert_eq!(
        activity.result_digest.as_deref(),
        Some("sha256:stable-result")
    );
    assert_eq!(
        activity.result,
        Some(serde_json::json!({ "status": "passed" }))
    );
    assert_eq!(state.issues.len(), issues_before_duplicate);
}

#[test]
fn plan_receipt_records_terminal_cycle_state() {
    let mut state = ReplayState::default();
    let admission_event_id = EventId::new();
    let event = event_of(
        EventKind::PlanReceiptRecorded,
        Payload::PlanReceiptRecordedV1(PlanReceiptRecordedV1 {
            plan_id: "pf-plan-001".into(),
            admission_event_id,
            outcome: PlanReceiptOutcome::Completed,
            side_effects: vec!["command:true".into()],
            result_digest: "sha256:receipt".into(),
            decided_at: "2026-06-08T00:00:01Z".into(),
        }),
    );

    apply(&mut state, &event);

    assert_eq!(state.plan_cycle_phase, "plan_receipt");
    let receipt = state.plan_receipt.as_ref().expect("receipt state");
    assert_eq!(receipt.event_id, event.id);
    assert_eq!(receipt.plan_id, "pf-plan-001");
    assert_eq!(receipt.admission_event_id, admission_event_id);
    assert_eq!(receipt.outcome, "completed");
    assert_eq!(receipt.side_effects, vec!["command:true".to_string()]);
    assert_eq!(receipt.result_digest, "sha256:receipt");
}
