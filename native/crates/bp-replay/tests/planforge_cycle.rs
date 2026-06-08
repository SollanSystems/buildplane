//! PlanForge admission-cycle replay tests (M2-S7a).

use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::activity::{ActivityCompletedV1, ActivityStartedV1, ActivityType};
use bp_ledger::payload::plan_lifecycle::{
    PlanAdmittedV1, PlanReceiptOutcome, PlanReceiptRecordedV1,
};
use bp_ledger::payload::Payload;
use bp_ledger::storage::sqlite::SqliteStore;
use bp_replay::engine::{ReplayEngine, ReplayStep};
use chrono::Utc;
use serde_json::json;
use tempfile::TempDir;

struct PlanForgeTapeIds {
    run_id: RunId,
    admission_event_id: EventId,
    completed_event_id: EventId,
    receipt_event_id: EventId,
}

fn event_of(
    run_id: RunId,
    id: EventId,
    parent_event_id: Option<EventId>,
    kind: EventKind,
    payload: Payload,
) -> Event {
    Event {
        id,
        run_id,
        parent_event_id,
        schema_version: 1,
        kind,
        occurred_at: Utc::now(),
        payload,
    }
}

fn write_planforge_cycle_tape(db_path: &std::path::Path) -> PlanForgeTapeIds {
    let store = SqliteStore::open(db_path).unwrap();
    let run_id = RunId::new();
    let admission_event_id = EventId::new();
    let started_event_id = EventId::new();
    let completed_event_id = EventId::new();
    let receipt_event_id = EventId::new();

    store
        .append(&event_of(
            run_id,
            admission_event_id,
            None,
            EventKind::PlanAdmitted,
            Payload::PlanAdmittedV1(PlanAdmittedV1 {
                plan_id: "pf-plan-001".into(),
                plan_digest: "sha256:plan".into(),
                input_digest: "sha256:input".into(),
                trusted_base: "fb86c82".into(),
                decided_by: "operator:khall".into(),
                decided_at: "2026-06-08T00:00:00Z".into(),
                idempotency_key: "planforge:v0:test:001".into(),
                authorized_next_step: "dispatch_admitted_plan".into(),
            }),
        ))
        .unwrap();
    store
        .append(&event_of(
            run_id,
            started_event_id,
            Some(admission_event_id),
            EventKind::ActivityStarted,
            Payload::ActivityStartedV1(ActivityStartedV1 {
                run_id,
                activity_id: "pf-task-1".into(),
                activity_type: ActivityType::Command,
                input_digest: "sha256:activity-input".into(),
            }),
        ))
        .unwrap();
    store
        .append(&event_of(
            run_id,
            completed_event_id,
            Some(started_event_id),
            EventKind::ActivityCompleted,
            Payload::ActivityCompletedV1(ActivityCompletedV1 {
                run_id,
                activity_id: "pf-task-1".into(),
                result_digest: "sha256:activity-result".into(),
                result: json!({"status": "passed", "output": "activity-ok"}),
            }),
        ))
        .unwrap();
    store
        .append(&event_of(
            run_id,
            receipt_event_id,
            Some(completed_event_id),
            EventKind::PlanReceiptRecorded,
            Payload::PlanReceiptRecordedV1(PlanReceiptRecordedV1 {
                plan_id: "pf-plan-001".into(),
                admission_event_id,
                outcome: PlanReceiptOutcome::Completed,
                side_effects: vec!["command:true".into()],
                result_digest: "sha256:receipt".into(),
                decided_at: "2026-06-08T00:00:01Z".into(),
            }),
        ))
        .unwrap();

    PlanForgeTapeIds {
        run_id,
        admission_event_id,
        completed_event_id,
        receipt_event_id,
    }
}

#[test]
fn replay_reconstructs_planforge_cycle_phase_and_recorded_activity_result() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("events.db");
    let ids = write_planforge_cycle_tape(&db_path);

    let mut engine = ReplayEngine::open(&ids.run_id.to_string(), &db_path).unwrap();
    let steps: Vec<_> = engine.by_ref().collect();

    assert_eq!(steps.len(), 4);
    assert_eq!(engine.state().plan_cycle_phase, "plan_receipt");
    assert_eq!(
        engine.state().plan_admission.as_ref().unwrap().event_id,
        ids.admission_event_id,
    );
    let activity = engine.state().activities.get("pf-task-1").unwrap();
    assert_eq!(activity.completed_event_id, Some(ids.completed_event_id));
    assert_eq!(
        activity.result,
        Some(json!({"status": "passed", "output": "activity-ok"})),
    );
    assert_eq!(
        engine.state().plan_receipt.as_ref().unwrap().event_id,
        ids.receipt_event_id,
    );
    assert_eq!(engine.state().issues, vec![]);
}

#[test]
fn fast_forward_to_activity_completion_matches_iterating_to_same_event() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("events.db");
    let ids = write_planforge_cycle_tape(&db_path);

    let mut fast_forward = ReplayEngine::open(&ids.run_id.to_string(), &db_path).unwrap();
    let fast_forward_step = fast_forward
        .fast_forward_to(ids.completed_event_id)
        .expect("target event");

    let mut iterated = ReplayEngine::open(&ids.run_id.to_string(), &db_path).unwrap();
    let iterated_step: ReplayStep = iterated
        .by_ref()
        .find(|step| step.event.id == ids.completed_event_id)
        .expect("target event");

    assert_eq!(fast_forward_step.event.id, ids.completed_event_id);
    assert_eq!(fast_forward_step.state_after, iterated_step.state_after);
    assert_eq!(
        fast_forward_step.state_after.plan_cycle_phase,
        "activity_completed"
    );
    assert_eq!(fast_forward_step.state_after.plan_receipt, None);
    assert_eq!(
        fast_forward_step
            .state_after
            .activities
            .get("pf-task-1")
            .unwrap()
            .result,
        Some(json!({"status": "passed", "output": "activity-ok"})),
    );
}
