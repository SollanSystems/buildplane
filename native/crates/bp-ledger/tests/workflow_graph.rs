use bp_ledger::{
    canonicalize::{canonicalize, canonicalize_payload},
    event::Event,
    id::{EventId, RunId},
    kind::EventKind,
    payload::{
        trust_spine::{workflow_graph_v1_digest, WorkflowGraphDeclaredV1, WorkflowGraphNodeV1},
        Payload,
    },
    storage::sqlite::SqliteStore,
    LedgerError,
};
use chrono::Utc;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const WORKFLOW_GRAPH_V1_DIGEST_DOMAIN: &[u8] = b"buildplane.workflow-graph.v1\0";

fn matching_graph_digest() -> String {
    // This is the declaration-ordered canonical JSON for the graph material:
    // run/workflow identity, sorted nodes, sorted dependencies, and limit.
    let graph_bytes = br#"{"run_id":"run-1","workflow_id":"workflow-1","workflow_revision":"r1","nodes":[{"unit_id":"unit-a","depends_on":[]},{"unit_id":"unit-b","depends_on":["unit-a"]}],"max_concurrent":2}"#;
    let mut hasher = Sha256::new();
    hasher.update(WORKFLOW_GRAPH_V1_DIGEST_DOMAIN);
    hasher.update(graph_bytes);
    format!("sha256:{:x}", hasher.finalize())
}

fn declaration() -> WorkflowGraphDeclaredV1 {
    WorkflowGraphDeclaredV1 {
        run_id: "run-1".into(),
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
        graph_digest: matching_graph_digest(),
        idempotency_key: "graph:run-1:workflow-1:r1".into(),
        declared_at: "2026-07-19T00:00:00Z".into(),
    }
}

fn declared_payload(declaration: WorkflowGraphDeclaredV1) -> Value {
    serde_json::to_value(Payload::WorkflowGraphDeclaredV1(declaration)).unwrap()
}

fn declared_event(run_id: RunId, declaration: WorkflowGraphDeclaredV1) -> Event {
    Event {
        id: EventId::new(),
        run_id,
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::WorkflowGraphDeclaredV1,
        occurred_at: Utc::now(),
        payload: Payload::WorkflowGraphDeclaredV1(declaration),
    }
}

fn assert_rejected(mut declaration: WorkflowGraphDeclaredV1) {
    declaration.graph_digest = workflow_graph_v1_digest(&declaration).unwrap();
    let result = canonicalize_payload(
        "workflow_graph_declared_v1",
        Event::CURRENT_SCHEMA_VERSION,
        declared_payload(declaration),
    );
    assert!(
        result.is_err(),
        "malformed graph declaration must be rejected"
    );
}

#[test]
fn workflow_graph_declaration_with_matching_canonical_digest_is_admitted() {
    let payload = json!({
        "WorkflowGraphDeclaredV1": {
            "run_id": "run-1",
            "workflow_id": "workflow-1",
            "workflow_revision": "r1",
            "nodes": [
                { "unit_id": "unit-a", "depends_on": [] },
                { "unit_id": "unit-b", "depends_on": ["unit-a"] }
            ],
            "max_concurrent": 2,
            "graph_digest": matching_graph_digest(),
            "idempotency_key": "graph:run-1:workflow-1:r1",
            "declared_at": "2026-07-19T00:00:00Z"
        }
    });

    let result = canonicalize_payload(
        "workflow_graph_declared_v1",
        Event::CURRENT_SCHEMA_VERSION,
        payload,
    );

    assert!(
        result.is_ok(),
        "matching graph declaration should be admitted: {result:?}"
    );
    assert_eq!(
        matching_graph_digest(),
        workflow_graph_v1_digest(&declaration()).unwrap()
    );
}

#[test]
fn event_canonicalization_rejects_a_workflow_graph_bound_to_a_different_run() {
    let event_run_id = RunId::new();
    let mut declaration = declaration();
    declaration.run_id = "different-run-id".into();
    declaration.graph_digest = workflow_graph_v1_digest(&declaration).unwrap();

    assert!(
        canonicalize_payload(
            "workflow_graph_declared_v1",
            Event::CURRENT_SCHEMA_VERSION,
            declared_payload(declaration.clone()),
        )
        .is_ok(),
        "payload-only canonicalization must keep historical replay compatible"
    );

    let result = canonicalize(declared_event(event_run_id, declaration));

    assert!(matches!(
        result,
        Err(LedgerError::InvalidPayload { kind, reason })
            if kind == "workflow_graph_declared_v1"
                && reason == "workflow graph declaration run_id must match the enclosing event run_id"
    ));
}

#[test]
fn direct_append_rejects_a_workflow_graph_bound_to_a_different_run_without_persisting() {
    let event_run_id = RunId::new();
    let mut declaration = declaration();
    declaration.run_id = "different-run-id".into();
    declaration.graph_digest = workflow_graph_v1_digest(&declaration).unwrap();
    let event = declared_event(event_run_id, declaration);
    let store = SqliteStore::open_in_memory().unwrap();

    let result = store.append(&event);

    assert!(matches!(
        result,
        Err(LedgerError::InvalidPayload { kind, reason })
            if kind == "workflow_graph_declared_v1"
                && reason == "workflow graph declaration run_id must match the enclosing event run_id"
    ));
    assert!(store
        .events_for_run(&event.run_id.to_string())
        .unwrap()
        .is_empty());
}

#[test]
fn workflow_graph_declaration_round_trips_as_a_closed_shape() {
    let declaration = declaration();
    let json = serde_json::to_string(&declaration).unwrap();
    assert_eq!(
        serde_json::from_str::<WorkflowGraphDeclaredV1>(&json).unwrap(),
        declaration
    );

    let mut unknown = serde_json::to_value(declaration).unwrap();
    unknown["unknown"] = json!(true);
    assert!(serde_json::from_value::<WorkflowGraphDeclaredV1>(unknown).is_err());
}

#[test]
fn workflow_graph_declaration_rejects_a_mismatched_digest() {
    let mut declaration = declaration();
    declaration.graph_digest =
        "sha256:0000000000000000000000000000000000000000000000000000000000000000".into();

    let result = canonicalize_payload(
        "workflow_graph_declared_v1",
        Event::CURRENT_SCHEMA_VERSION,
        declared_payload(declaration),
    );

    assert!(result.is_err());
}

#[test]
fn workflow_graph_declaration_rejects_invalid_closed_topologies() {
    let mut empty_graph = declaration();
    empty_graph.nodes.clear();
    assert_rejected(empty_graph);

    let mut empty_id = declaration();
    empty_id.workflow_id = " ".into();
    assert_rejected(empty_id);

    let mut zero_concurrency = declaration();
    zero_concurrency.max_concurrent = 0;
    assert_rejected(zero_concurrency);

    let mut unsorted_nodes = declaration();
    unsorted_nodes.nodes.reverse();
    assert_rejected(unsorted_nodes);

    let mut duplicate_node = declaration();
    duplicate_node.nodes.push(WorkflowGraphNodeV1 {
        unit_id: "unit-b".into(),
        depends_on: vec![],
    });
    assert_rejected(duplicate_node);

    let mut unsorted_dependencies = declaration();
    unsorted_dependencies.nodes.push(WorkflowGraphNodeV1 {
        unit_id: "unit-c".into(),
        depends_on: vec!["unit-b".into(), "unit-a".into()],
    });
    assert_rejected(unsorted_dependencies);

    let mut duplicate_dependency = declaration();
    duplicate_dependency.nodes[1].depends_on = vec!["unit-a".into(), "unit-a".into()];
    assert_rejected(duplicate_dependency);

    let mut unknown_dependency = declaration();
    unknown_dependency.nodes[1].depends_on = vec!["unit-z".into()];
    assert_rejected(unknown_dependency);

    let mut self_dependency = declaration();
    self_dependency.nodes[0].depends_on = vec!["unit-a".into()];
    assert_rejected(self_dependency);

    let mut cycle = declaration();
    cycle.nodes[0].depends_on = vec!["unit-b".into()];
    assert_rejected(cycle);
}

#[test]
fn workflow_graph_declaration_accepts_a_deep_acyclic_dependency_chain() {
    const DEPTH: usize = 50_000;

    let nodes = (0..DEPTH)
        .map(|index| WorkflowGraphNodeV1 {
            unit_id: format!("unit-{index:05}"),
            // This direction makes the first lexically visited node traverse
            // the whole chain under the old recursive DFS implementation.
            depends_on: (index + 1 < DEPTH)
                .then(|| vec![format!("unit-{:05}", index + 1)])
                .unwrap_or_default(),
        })
        .collect();
    let mut declaration = WorkflowGraphDeclaredV1 {
        run_id: "run-deep".into(),
        workflow_id: "workflow-deep".into(),
        workflow_revision: "r1".into(),
        nodes,
        max_concurrent: 1,
        graph_digest: String::new(),
        idempotency_key: "graph:run-deep:workflow-deep:r1".into(),
        declared_at: "2026-07-19T00:00:00Z".into(),
    };
    declaration.graph_digest = workflow_graph_v1_digest(&declaration).unwrap();

    let result = canonicalize_payload(
        "workflow_graph_declared_v1",
        Event::CURRENT_SCHEMA_VERSION,
        declared_payload(declaration),
    );

    assert!(
        result.is_ok(),
        "a deep acyclic workflow graph must validate without recursive stack exhaustion: {result:?}"
    );
}
