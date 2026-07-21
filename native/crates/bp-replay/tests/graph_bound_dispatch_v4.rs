//! Graph-bound V4 dispatch reducer tests.
//!
//! These tests use the unchecked legacy reducer deliberately to exercise the
//! reducer's own fail-closed relationship checks. Production replay supplies
//! detached signer authorization before reaching the same transitions.

use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::trust_spine::{
    dispatch_envelope_v3_body_digest, dispatch_envelope_v4_digest, workflow_graph_v2_digest,
    ActionEvidenceVersionV1, CommitModeV1, DispatchBudgetV1, DispatchEnvelopeBodyV2,
    DispatchEnvelopeV3, DispatchEnvelopeV4, ExecutionRoleV1, TrustTierV1, WorkflowGraphDeclaredV2,
    WorkflowGraphNodeV2,
};
use bp_ledger::payload::Payload;
use bp_replay::state::{ReplayIssue, ReplayState};
use bp_replay::transitions::apply;
use chrono::Utc;

fn digest(hex: char) -> String {
    format!("sha256:{}", hex.to_string().repeat(64))
}

fn declared_graph(
    run_id: RunId,
    role: ExecutionRoleV1,
    packet_digest: String,
    max_concurrent: u32,
) -> WorkflowGraphDeclaredV2 {
    let mut declaration = WorkflowGraphDeclaredV2 {
        run_id: run_id.to_string(),
        workflow_id: "workflow-v4".into(),
        workflow_revision: "r1".into(),
        nodes: vec![WorkflowGraphNodeV2 {
            unit_id: "unit-a".into(),
            depends_on: vec![],
            execution_role: role,
            governed_packet_digest: packet_digest,
        }],
        max_concurrent,
        graph_digest: String::new(),
        idempotency_key: "graph-v2:workflow-v4:r1".into(),
        declared_at: "2026-07-19T00:00:00Z".into(),
    };
    declaration.graph_digest = workflow_graph_v2_digest(&declaration).unwrap();
    declaration
}

fn declaration_event(run_id: RunId, declaration: WorkflowGraphDeclaredV2) -> Event {
    Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::WorkflowGraphDeclaredV2,
        occurred_at: Utc::now(),
        payload: Payload::WorkflowGraphDeclaredV2(declaration),
    }
}

fn dispatch_v3(
    unit_id: &str,
    execution_role: ExecutionRoleV1,
    governed_packet_digest: String,
) -> DispatchEnvelopeV3 {
    let body = DispatchEnvelopeBodyV2 {
        workflow_id: "workflow-v4".into(),
        workflow_revision: "r1".into(),
        unit_id: unit_id.into(),
        attempt: 1,
        execution_role,
        commit_mode: CommitModeV1::Atomic,
        provenance_ref: "admission:workflow-v4".into(),
        base_commit_sha: "1".repeat(40),
        capability_bundle_digest: digest('b'),
        acceptance_contract_digest: digest('c'),
        context_manifest_digest: digest('d'),
        worker_manifest_digest: digest('e'),
        sandbox_profile_digest: digest('f'),
        budget: DispatchBudgetV1 {
            max_tokens: Some(100),
            max_compute_time_ms: Some(1_000),
        },
        trust_tier: TrustTierV1::Governed,
        idempotency_key: format!("dispatch:workflow-v4:{unit_id}:1"),
        issued_at: "2026-07-19T00:01:00Z".into(),
        expires_at: "2026-07-19T01:01:00Z".into(),
    };
    let action_evidence_version = ActionEvidenceVersionV1::SealedV3;
    let repository_binding_digest = digest('8');
    let ledger_authority_realm_digest = digest('9');
    let envelope_digest = dispatch_envelope_v3_body_digest(
        &body,
        action_evidence_version,
        &repository_binding_digest,
        &ledger_authority_realm_digest,
        Some(governed_packet_digest.as_str()),
    )
    .unwrap();
    DispatchEnvelopeV3 {
        body,
        action_evidence_version,
        repository_binding_digest,
        ledger_authority_realm_digest,
        governed_packet_digest: Some(governed_packet_digest),
        envelope_digest,
    }
}

fn dispatch_v4_event(
    run_id: RunId,
    graph_event_ref: EventId,
    graph_digest: String,
    dispatch_v3: DispatchEnvelopeV3,
) -> Event {
    let mut dispatch = DispatchEnvelopeV4 {
        dispatch_v3,
        workflow_graph_digest: graph_digest,
        workflow_graph_declaration_event_ref: graph_event_ref,
        envelope_digest: String::new(),
    };
    dispatch.envelope_digest = dispatch_envelope_v4_digest(
        &dispatch.dispatch_v3,
        &dispatch.workflow_graph_digest,
        &dispatch.workflow_graph_declaration_event_ref,
    )
    .unwrap();
    Event {
        id: EventId::new(),
        run_id,
        parent_event_id: Some(graph_event_ref),
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::DispatchEnvelopeV4,
        occurred_at: Utc::now(),
        payload: Payload::DispatchEnvelopeV4(dispatch),
    }
}

fn assert_rejected_without_authority(state: &ReplayState, expected_reason: &str) {
    assert!(state.workflow_instances.is_empty());
    assert!(state.workflow_instance.is_none());
    assert!(state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. } if reason.contains(expected_reason)
    )), "expected rejection containing {expected_reason:?}, got {:?}", state.issues);
}

#[test]
fn v4_projects_only_when_bound_to_the_exact_prior_v2_graph_and_node() {
    let run_id = RunId::new();
    let packet_digest = digest('a');
    let graph = declared_graph(
        run_id,
        ExecutionRoleV1::Implementer,
        packet_digest.clone(),
        1,
    );
    let graph_event = declaration_event(run_id, graph.clone());
    let mut state = ReplayState::default();

    apply(&mut state, &graph_event);
    apply(
        &mut state,
        &dispatch_v4_event(
            run_id,
            graph_event.id,
            graph.graph_digest.clone(),
            dispatch_v3("unit-a", ExecutionRoleV1::Implementer, packet_digest),
        ),
    );

    assert!(state.issues.is_empty(), "{:?}", state.issues);
    assert_eq!(
        state.workflow_graphs.len(),
        0,
        "V1 and V2 maps stay separate"
    );
    assert_eq!(state.workflow_graphs_v2.len(), 1);
    let workflow = state.workflow_instances.values().next().unwrap();
    assert_eq!(workflow.dispatch.dispatch_version, 4);
    assert_eq!(
        workflow.dispatch.workflow_graph_digest.as_deref(),
        Some(graph.graph_digest.as_str())
    );
    assert_eq!(
        workflow.dispatch.workflow_graph_declaration_event_ref,
        Some(graph_event.id)
    );
}

#[test]
fn v4_authority_timestamps_are_limited_to_nanosecond_precision() {
    let run_id = RunId::new();
    let packet_digest = digest('a');
    let graph = declared_graph(
        run_id,
        ExecutionRoleV1::Implementer,
        packet_digest.clone(),
        1,
    );

    let mut nanosecond_dispatch = dispatch_v3(
        "unit-a",
        ExecutionRoleV1::Implementer,
        packet_digest.clone(),
    );
    nanosecond_dispatch.body.issued_at = "2026-07-19T00:01:00.123456789Z".into();
    nanosecond_dispatch.body.expires_at = "2026-07-19T00:01:00.123456790Z".into();
    nanosecond_dispatch.envelope_digest = dispatch_envelope_v3_body_digest(
        &nanosecond_dispatch.body,
        nanosecond_dispatch.action_evidence_version,
        &nanosecond_dispatch.repository_binding_digest,
        &nanosecond_dispatch.ledger_authority_realm_digest,
        nanosecond_dispatch.governed_packet_digest.as_deref(),
    )
    .unwrap();

    let valid_graph_event = declaration_event(run_id, graph.clone());
    let mut valid_state = ReplayState::default();
    apply(&mut valid_state, &valid_graph_event);
    apply(
        &mut valid_state,
        &dispatch_v4_event(
            run_id,
            valid_graph_event.id,
            graph.graph_digest.clone(),
            nanosecond_dispatch,
        ),
    );
    assert!(valid_state.issues.is_empty(), "{:?}", valid_state.issues);
    assert_eq!(valid_state.workflow_instances.len(), 1);

    let mut overprecise_dispatch =
        dispatch_v3("unit-a", ExecutionRoleV1::Implementer, packet_digest);
    overprecise_dispatch.body.issued_at = "2026-07-19T00:01:00.1234567890Z".into();
    overprecise_dispatch.body.expires_at = "2026-07-19T00:01:00.1234567891Z".into();
    overprecise_dispatch.envelope_digest = dispatch_envelope_v3_body_digest(
        &overprecise_dispatch.body,
        overprecise_dispatch.action_evidence_version,
        &overprecise_dispatch.repository_binding_digest,
        &overprecise_dispatch.ledger_authority_realm_digest,
        overprecise_dispatch.governed_packet_digest.as_deref(),
    )
    .unwrap();

    let overprecise_graph_event = declaration_event(run_id, graph.clone());
    let mut overprecise_state = ReplayState::default();
    apply(&mut overprecise_state, &overprecise_graph_event);
    apply(
        &mut overprecise_state,
        &dispatch_v4_event(
            run_id,
            overprecise_graph_event.id,
            graph.graph_digest,
            overprecise_dispatch,
        ),
    );
    assert_rejected_without_authority(
        &overprecise_state,
        "fractional seconds must contain at most 9 digits",
    );
}

#[test]
fn v4_rejects_missing_topology_and_v2_node_role_or_packet_mismatches() {
    let run_id = RunId::new();
    let packet_digest = digest('a');
    let graph = declared_graph(
        run_id,
        ExecutionRoleV1::Implementer,
        packet_digest.clone(),
        1,
    );
    let graph_event = declaration_event(run_id, graph.clone());

    let mut missing = ReplayState::default();
    apply(
        &mut missing,
        &dispatch_v4_event(
            run_id,
            graph_event.id,
            graph.graph_digest.clone(),
            dispatch_v3(
                "unit-a",
                ExecutionRoleV1::Implementer,
                packet_digest.clone(),
            ),
        ),
    );
    assert_rejected_without_authority(&missing, "requires a previously declared V2 workflow graph");

    let mut role_mismatch = ReplayState::default();
    apply(&mut role_mismatch, &graph_event);
    apply(
        &mut role_mismatch,
        &dispatch_v4_event(
            run_id,
            graph_event.id,
            graph.graph_digest.clone(),
            dispatch_v3("unit-a", ExecutionRoleV1::Reviewer, packet_digest.clone()),
        ),
    );
    assert_rejected_without_authority(&role_mismatch, "execution role does not match");

    let mut packet_mismatch = ReplayState::default();
    apply(&mut packet_mismatch, &graph_event);
    apply(
        &mut packet_mismatch,
        &dispatch_v4_event(
            run_id,
            graph_event.id,
            graph.graph_digest.clone(),
            dispatch_v3("unit-a", ExecutionRoleV1::Implementer, digest('0')),
        ),
    );
    assert_rejected_without_authority(&packet_mismatch, "governed packet digest does not match");

    let mut missing_node = ReplayState::default();
    apply(&mut missing_node, &graph_event);
    apply(
        &mut missing_node,
        &dispatch_v4_event(
            run_id,
            graph_event.id,
            graph.graph_digest,
            dispatch_v3("unit-missing", ExecutionRoleV1::Implementer, packet_digest),
        ),
    );
    assert_rejected_without_authority(&missing_node, "unit_id is missing");
}

#[test]
fn v4_rejects_topology_concurrency_and_declaration_identity_mismatches() {
    let run_id = RunId::new();
    let packet_digest = digest('a');
    let graph = declared_graph(
        run_id,
        ExecutionRoleV1::Implementer,
        packet_digest.clone(),
        1,
    );
    let graph_event = declaration_event(run_id, graph.clone());
    let alternate_concurrency = declared_graph(
        run_id,
        ExecutionRoleV1::Implementer,
        packet_digest.clone(),
        2,
    );

    let mut concurrency_mismatch = ReplayState::default();
    apply(&mut concurrency_mismatch, &graph_event);
    apply(
        &mut concurrency_mismatch,
        &dispatch_v4_event(
            run_id,
            graph_event.id,
            alternate_concurrency.graph_digest,
            dispatch_v3(
                "unit-a",
                ExecutionRoleV1::Implementer,
                packet_digest.clone(),
            ),
        ),
    );
    assert_rejected_without_authority(
        &concurrency_mismatch,
        "workflow_graph_digest does not match",
    );

    let mut wrong_event_ref = ReplayState::default();
    apply(&mut wrong_event_ref, &graph_event);
    apply(
        &mut wrong_event_ref,
        &dispatch_v4_event(
            run_id,
            EventId::new(),
            graph.graph_digest,
            dispatch_v3("unit-a", ExecutionRoleV1::Implementer, packet_digest),
        ),
    );
    assert_rejected_without_authority(&wrong_event_ref, "declaration_event_ref does not name");
}

#[test]
fn v4_enforces_declared_dependencies_and_max_concurrency_before_projection() {
    let run_id = RunId::new();
    let packet_a = digest('a');
    let packet_b = digest('b');

    let mut dependency_graph =
        declared_graph(run_id, ExecutionRoleV1::Implementer, packet_a.clone(), 2);
    dependency_graph.nodes.push(WorkflowGraphNodeV2 {
        unit_id: "unit-b".into(),
        depends_on: vec!["unit-a".into()],
        execution_role: ExecutionRoleV1::Implementer,
        governed_packet_digest: packet_b.clone(),
    });
    dependency_graph.graph_digest = workflow_graph_v2_digest(&dependency_graph).unwrap();
    let dependency_event = declaration_event(run_id, dependency_graph.clone());
    let mut dependency_state = ReplayState::default();
    apply(&mut dependency_state, &dependency_event);
    apply(
        &mut dependency_state,
        &dispatch_v4_event(
            run_id,
            dependency_event.id,
            dependency_graph.graph_digest.clone(),
            dispatch_v3("unit-b", ExecutionRoleV1::Implementer, packet_b.clone()),
        ),
    );
    assert_rejected_without_authority(
        &dependency_state,
        "dependency unit-a has not completed successfully",
    );

    let mut concurrency_graph =
        declared_graph(run_id, ExecutionRoleV1::Implementer, packet_a.clone(), 1);
    concurrency_graph.nodes.push(WorkflowGraphNodeV2 {
        unit_id: "unit-b".into(),
        depends_on: vec![],
        execution_role: ExecutionRoleV1::Implementer,
        governed_packet_digest: packet_b.clone(),
    });
    concurrency_graph.graph_digest = workflow_graph_v2_digest(&concurrency_graph).unwrap();
    let concurrency_event = declaration_event(run_id, concurrency_graph.clone());
    let mut concurrency_state = ReplayState::default();
    apply(&mut concurrency_state, &concurrency_event);
    apply(
        &mut concurrency_state,
        &dispatch_v4_event(
            run_id,
            concurrency_event.id,
            concurrency_graph.graph_digest.clone(),
            dispatch_v3("unit-a", ExecutionRoleV1::Implementer, packet_a),
        ),
    );
    apply(
        &mut concurrency_state,
        &dispatch_v4_event(
            run_id,
            concurrency_event.id,
            concurrency_graph.graph_digest,
            dispatch_v3("unit-b", ExecutionRoleV1::Implementer, packet_b),
        ),
    );
    assert_eq!(concurrency_state.workflow_instances.len(), 1);
    assert!(concurrency_state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("would exceed immutable graph max_concurrent 1")
    )));
}

#[test]
fn v2_graph_declarations_reject_cross_revision_reuse_before_v4_evidence_can_collide() {
    let run_id = RunId::new();
    let graph = declared_graph(run_id, ExecutionRoleV1::Implementer, digest('a'), 1);
    let first_event = declaration_event(run_id, graph.clone());
    let mut cross_revision = graph;
    cross_revision.workflow_revision = "r2".into();
    cross_revision.idempotency_key = "graph-v2:workflow-v4:r2".into();
    cross_revision.graph_digest = workflow_graph_v2_digest(&cross_revision).unwrap();
    let second_event = declaration_event(run_id, cross_revision);

    let mut state = ReplayState::default();
    apply(&mut state, &first_event);
    apply(&mut state, &second_event);

    assert_eq!(state.workflow_graphs_v2.len(), 1);
    assert!(state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("cannot reuse a run/workflow identity across revisions")
    )));
}

#[test]
fn duplicate_or_late_v2_topology_cannot_grant_or_replace_v4_authority_and_v3_stays_compatible() {
    let run_id = RunId::new();
    let packet_digest = digest('a');
    let graph = declared_graph(
        run_id,
        ExecutionRoleV1::Implementer,
        packet_digest.clone(),
        1,
    );
    let graph_event = declaration_event(run_id, graph.clone());
    let mut state = ReplayState::default();
    apply(&mut state, &graph_event);
    apply(
        &mut state,
        &dispatch_v4_event(
            run_id,
            graph_event.id,
            graph.graph_digest.clone(),
            dispatch_v3(
                "unit-a",
                ExecutionRoleV1::Implementer,
                packet_digest.clone(),
            ),
        ),
    );
    assert_eq!(state.workflow_instances.len(), 1);

    // A second V2 declaration after a projected V4 dispatch is rejected even
    // if its topology is otherwise canonical and cannot replace the map.
    let late = declaration_event(run_id, graph.clone());
    apply(&mut state, &late);
    assert_eq!(state.workflow_graphs_v2.len(), 1);
    assert!(state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("arrived after V4 dispatch")
    )));

    // V3 remains intentionally graph-ungated for historical tapes.
    let legacy_run = RunId::new();
    let legacy_v3 = dispatch_v3("unit-a", ExecutionRoleV1::Implementer, packet_digest);
    let legacy_event = Event {
        id: EventId::new(),
        run_id: legacy_run,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::DispatchEnvelopeV3,
        occurred_at: Utc::now(),
        payload: Payload::DispatchEnvelopeV3(legacy_v3),
    };
    let mut legacy_state = ReplayState::default();
    apply(&mut legacy_state, &legacy_event);
    assert_eq!(legacy_state.workflow_instances.len(), 1);
    assert!(legacy_state.workflow_graphs_v2.is_empty());
    assert!(legacy_state.issues.is_empty(), "{:?}", legacy_state.issues);
}

#[test]
fn duplicate_v2_nodes_never_project_authority() {
    let run_id = RunId::new();
    let packet_digest = digest('a');
    let mut invalid = declared_graph(
        run_id,
        ExecutionRoleV1::Implementer,
        packet_digest.clone(),
        1,
    );
    invalid.nodes.push(WorkflowGraphNodeV2 {
        unit_id: "unit-a".into(),
        depends_on: vec![],
        execution_role: ExecutionRoleV1::Implementer,
        governed_packet_digest: packet_digest,
    });
    invalid.graph_digest = workflow_graph_v2_digest(&invalid).unwrap();
    let event = declaration_event(run_id, invalid);
    let mut state = ReplayState::default();
    apply(&mut state, &event);

    assert!(state.workflow_graphs_v2.is_empty());
    assert!(state.issues.iter().any(|issue| matches!(
        issue,
        ReplayIssue::WorkflowTransitionRejected { reason, .. }
            if reason.contains("failed canonical validation")
    )));
}
