//! Workflow-graph declaration reducer tests.
//!
//! The declaration is a signed tape projection only. These tests intentionally
//! prove that it records topology without claiming DispatchEnvelopeV3 gating.

use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::trust_spine::{
    workflow_graph_v1_digest, CommitModeV1, DispatchBudgetV1, DispatchEnvelopeV1, ExecutionRoleV1,
    SignatureRefV1, TrustTierV1, WorkflowGraphDeclaredV1, WorkflowGraphNodeV1,
};
use bp_ledger::payload::Payload;
use bp_replay::state::{ReplayIssue, ReplayState};
use bp_replay::transitions::apply;
use chrono::Utc;

const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn event_of(run_id: RunId, kind: EventKind, payload: Payload) -> Event {
    Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind,
        occurred_at: Utc::now(),
        payload,
    }
}

fn declared_graph(run_id: RunId) -> WorkflowGraphDeclaredV1 {
    let mut declaration = WorkflowGraphDeclaredV1 {
        run_id: run_id.to_string(),
        workflow_id: "workflow-1".into(),
        workflow_revision: "r1".into(),
        nodes: vec![
            WorkflowGraphNodeV1 {
                unit_id: "unit-a".into(),
                depends_on: vec![],
            },
            WorkflowGraphNodeV1 {
                unit_id: "unit-b".into(),
                depends_on: vec!["unit-a".into()],
            },
        ],
        max_concurrent: 2,
        graph_digest: String::new(),
        idempotency_key: "workflow-graph:run-1:workflow-1:r1".into(),
        declared_at: "2026-07-19T00:00:00Z".into(),
    };
    declaration.graph_digest = workflow_graph_v1_digest(&declaration).unwrap();
    declaration
}

fn graph_event(run_id: RunId, declaration: WorkflowGraphDeclaredV1) -> Event {
    event_of(
        run_id,
        EventKind::WorkflowGraphDeclaredV1,
        Payload::WorkflowGraphDeclaredV1(declaration),
    )
}

fn dispatch_for_graph() -> DispatchEnvelopeV1 {
    DispatchEnvelopeV1 {
        workflow_id: "workflow-1".into(),
        workflow_revision: "r1".into(),
        unit_id: "unit-a".into(),
        attempt: 1,
        execution_role: ExecutionRoleV1::Implementer,
        commit_mode: CommitModeV1::Atomic,
        provenance_ref: "admission:workflow-1".into(),
        base_commit_sha: "1".repeat(40),
        capability_bundle_digest: DIGEST_A.into(),
        acceptance_contract_digest: DIGEST_B.into(),
        context_manifest_digest: DIGEST_A.into(),
        worker_manifest_digest: DIGEST_B.into(),
        sandbox_profile_digest: DIGEST_A.into(),
        budget: DispatchBudgetV1 {
            max_tokens: Some(100),
            max_compute_time_ms: Some(1_000),
        },
        trust_tier: TrustTierV1::Governed,
        idempotency_key: "dispatch:workflow-1:unit-a:1".into(),
        issued_at: "2026-07-19T00:01:00Z".into(),
        expires_at: "2026-07-19T01:01:00Z".into(),
        envelope_digest: DIGEST_B.into(),
        signature_ref: SignatureRefV1 {
            algorithm: "ed25519".into(),
            key_id: "kernel-main".into(),
            signature: "fixture-signature".into(),
        },
    }
}

#[test]
fn valid_declaration_projects_a_topology_keyed_by_run_workflow_and_revision() {
    let run_id = RunId::new();
    let declaration = declared_graph(run_id);
    let mut state = ReplayState::default();

    apply(&mut state, &graph_event(run_id, declaration.clone()));

    assert_eq!(state.workflow_graphs.len(), 1);
    let graph = state.workflow_graphs.values().next().unwrap();
    assert_eq!(graph.run_id, run_id.to_string());
    assert_eq!(graph.workflow_id, declaration.workflow_id);
    assert_eq!(graph.workflow_revision, declaration.workflow_revision);
    assert_eq!(graph.nodes, declaration.nodes);
    assert_eq!(graph.max_concurrent, 2);
    assert!(state.workflow_instance.is_none());
    assert!(state.issues.is_empty());
}

#[test]
fn exact_replay_is_idempotent_before_the_workflow_dispatches() {
    let run_id = RunId::new();
    let event = graph_event(run_id, declared_graph(run_id));
    let mut state = ReplayState::default();

    apply(&mut state, &event);
    let projected = state.workflow_graphs.clone();
    apply(&mut state, &event);

    assert_eq!(state.workflow_graphs, projected);
    assert!(state.issues.is_empty());
}

#[test]
fn conflicting_or_late_declarations_block_without_replacing_the_projection() {
    let run_id = RunId::new();
    let declaration = declared_graph(run_id);
    let mut state = ReplayState::default();

    apply(&mut state, &graph_event(run_id, declaration.clone()));
    let initial = state.workflow_graphs.clone();

    let mut conflicting = declaration.clone();
    conflicting.max_concurrent = 3;
    conflicting.graph_digest = workflow_graph_v1_digest(&conflicting).unwrap();
    apply(&mut state, &graph_event(run_id, conflicting));
    assert_eq!(state.workflow_graphs, initial);

    apply(
        &mut state,
        &event_of(
            run_id,
            EventKind::DispatchEnvelope,
            Payload::DispatchEnvelopeV1(dispatch_for_graph()),
        ),
    );
    assert_eq!(state.workflow_instances.len(), 1);
    let after_dispatch = state.workflow_graphs.clone();
    apply(&mut state, &graph_event(run_id, declaration));

    assert_eq!(state.workflow_graphs, after_dispatch);
    assert!(state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("workflow graph declaration")
    )));
}

#[test]
fn legacy_replay_state_without_workflow_graphs_defaults_to_an_empty_map() {
    let legacy_state = serde_json::json!({
        "run_id": null,
        "parent_run_id": null,
        "parent_event_id": null,
        "current_unit": null,
        "parent_chain": [],
        "observed_files": {},
        "checkpoints": [],
        "issues": []
    });

    let restored: ReplayState = serde_json::from_value(legacy_state).unwrap();
    assert!(restored.workflow_graphs.is_empty());
}
