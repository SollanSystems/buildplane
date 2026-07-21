//! Canonicalization tests for graph-bound V2 topology and V4 dispatch bytes.

use bp_ledger::{
    canonicalize::{canonicalize, canonicalize_payload},
    event::Event,
    id::{EventId, RunId},
    kind::EventKind,
    payload::{
        trust_spine::{
            dispatch_envelope_v3_body_digest, dispatch_envelope_v4_digest,
            workflow_graph_v2_digest, ActionEvidenceVersionV1, CommitModeV1, DispatchBudgetV1,
            DispatchEnvelopeBodyV2, DispatchEnvelopeV3, DispatchEnvelopeV4, ExecutionRoleV1,
            TrustTierV1, WorkflowGraphDeclaredV2, WorkflowGraphNodeV2,
        },
        Payload,
    },
    LedgerError,
};
use chrono::Utc;
use serde_json::json;

fn digest(hex: char) -> String {
    format!("sha256:{}", hex.to_string().repeat(64))
}

fn graph(run_id: RunId) -> WorkflowGraphDeclaredV2 {
    let mut declaration = WorkflowGraphDeclaredV2 {
        run_id: run_id.to_string(),
        workflow_id: "workflow-v4".into(),
        workflow_revision: "r1".into(),
        nodes: vec![WorkflowGraphNodeV2 {
            unit_id: "unit-a".into(),
            depends_on: vec![],
            execution_role: ExecutionRoleV1::Implementer,
            governed_packet_digest: digest('a'),
        }],
        max_concurrent: 1,
        graph_digest: String::new(),
        idempotency_key: "graph-v2:workflow-v4:r1".into(),
        declared_at: "2026-07-19T00:00:00Z".into(),
    };
    declaration.graph_digest = workflow_graph_v2_digest(&declaration).unwrap();
    declaration
}

fn dispatch_v3() -> DispatchEnvelopeV3 {
    let body = DispatchEnvelopeBodyV2 {
        workflow_id: "workflow-v4".into(),
        workflow_revision: "r1".into(),
        unit_id: "unit-a".into(),
        attempt: 1,
        execution_role: ExecutionRoleV1::Implementer,
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
        idempotency_key: "dispatch:workflow-v4:unit-a:1".into(),
        issued_at: "2026-07-19T00:01:00Z".into(),
        expires_at: "2026-07-19T01:01:00Z".into(),
    };
    let action_evidence_version = ActionEvidenceVersionV1::SealedV3;
    let repository_binding_digest = digest('8');
    let ledger_authority_realm_digest = digest('9');
    let governed_packet_digest = Some(digest('a'));
    let envelope_digest = dispatch_envelope_v3_body_digest(
        &body,
        action_evidence_version,
        &repository_binding_digest,
        &ledger_authority_realm_digest,
        governed_packet_digest.as_deref(),
    )
    .unwrap();
    DispatchEnvelopeV3 {
        body,
        action_evidence_version,
        repository_binding_digest,
        ledger_authority_realm_digest,
        governed_packet_digest,
        envelope_digest,
    }
}

fn graph_event(run_id: RunId, declaration: WorkflowGraphDeclaredV2) -> Event {
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

#[test]
fn graph_v2_and_v4_dispatch_are_closed_and_bind_nested_v3_bytes() {
    let run_id = RunId::new();
    let declaration = graph(run_id);
    let payload =
        serde_json::to_value(Payload::WorkflowGraphDeclaredV2(declaration.clone())).unwrap();
    assert!(canonicalize_payload(
        "workflow_graph_declared_v2",
        Event::CURRENT_SCHEMA_VERSION,
        payload
    )
    .is_ok());
    assert!(canonicalize(graph_event(run_id, declaration.clone())).is_ok());

    let declaration_event_ref = EventId::new();
    let dispatch_v3 = dispatch_v3();
    let mut dispatch_v4 = DispatchEnvelopeV4 {
        envelope_digest: String::new(),
        dispatch_v3,
        workflow_graph_digest: declaration.graph_digest,
        workflow_graph_declaration_event_ref: declaration_event_ref,
    };
    dispatch_v4.envelope_digest = dispatch_envelope_v4_digest(
        &dispatch_v4.dispatch_v3,
        &dispatch_v4.workflow_graph_digest,
        &dispatch_v4.workflow_graph_declaration_event_ref,
    )
    .unwrap();
    assert!(canonicalize_payload(
        "dispatch_envelope_v4",
        Event::CURRENT_SCHEMA_VERSION,
        serde_json::to_value(Payload::DispatchEnvelopeV4(dispatch_v4.clone())).unwrap(),
    )
    .is_ok());

    // A correct V4 outer digest cannot launder an invalid nested V3 digest.
    dispatch_v4.dispatch_v3.envelope_digest = digest('0');
    dispatch_v4.envelope_digest = dispatch_envelope_v4_digest(
        &dispatch_v4.dispatch_v3,
        &dispatch_v4.workflow_graph_digest,
        &dispatch_v4.workflow_graph_declaration_event_ref,
    )
    .unwrap();
    assert!(canonicalize_payload(
        "dispatch_envelope_v4",
        Event::CURRENT_SCHEMA_VERSION,
        serde_json::to_value(Payload::DispatchEnvelopeV4(dispatch_v4)).unwrap(),
    )
    .is_err());
}

#[test]
fn v4_authority_timestamps_are_limited_to_nanosecond_precision() {
    let run_id = RunId::new();
    let declaration = graph(run_id);
    let declaration_event_ref = EventId::new();
    let mut dispatch_v4 = DispatchEnvelopeV4 {
        envelope_digest: String::new(),
        dispatch_v3: dispatch_v3(),
        workflow_graph_digest: declaration.graph_digest,
        workflow_graph_declaration_event_ref: declaration_event_ref,
    };

    dispatch_v4.dispatch_v3.body.issued_at = "2026-07-19T00:01:00.123456789Z".into();
    dispatch_v4.dispatch_v3.body.expires_at = "2026-07-19T00:01:00.123456790Z".into();
    dispatch_v4.dispatch_v3.envelope_digest = dispatch_envelope_v3_body_digest(
        &dispatch_v4.dispatch_v3.body,
        dispatch_v4.dispatch_v3.action_evidence_version,
        &dispatch_v4.dispatch_v3.repository_binding_digest,
        &dispatch_v4.dispatch_v3.ledger_authority_realm_digest,
        dispatch_v4.dispatch_v3.governed_packet_digest.as_deref(),
    )
    .unwrap();
    dispatch_v4.envelope_digest = dispatch_envelope_v4_digest(
        &dispatch_v4.dispatch_v3,
        &dispatch_v4.workflow_graph_digest,
        &dispatch_v4.workflow_graph_declaration_event_ref,
    )
    .unwrap();
    assert!(canonicalize_payload(
        "dispatch_envelope_v4",
        Event::CURRENT_SCHEMA_VERSION,
        serde_json::to_value(Payload::DispatchEnvelopeV4(dispatch_v4.clone())).unwrap(),
    )
    .is_ok());

    dispatch_v4.dispatch_v3.body.issued_at = "2026-07-19T00:01:00.1234567890Z".into();
    dispatch_v4.dispatch_v3.body.expires_at = "2026-07-19T00:01:00.1234567891Z".into();
    dispatch_v4.dispatch_v3.envelope_digest = dispatch_envelope_v3_body_digest(
        &dispatch_v4.dispatch_v3.body,
        dispatch_v4.dispatch_v3.action_evidence_version,
        &dispatch_v4.dispatch_v3.repository_binding_digest,
        &dispatch_v4.dispatch_v3.ledger_authority_realm_digest,
        dispatch_v4.dispatch_v3.governed_packet_digest.as_deref(),
    )
    .unwrap();
    dispatch_v4.envelope_digest = dispatch_envelope_v4_digest(
        &dispatch_v4.dispatch_v3,
        &dispatch_v4.workflow_graph_digest,
        &dispatch_v4.workflow_graph_declaration_event_ref,
    )
    .unwrap();
    let error = canonicalize_payload(
        "dispatch_envelope_v4",
        Event::CURRENT_SCHEMA_VERSION,
        serde_json::to_value(Payload::DispatchEnvelopeV4(dispatch_v4)).unwrap(),
    )
    .unwrap_err();

    assert!(matches!(error, LedgerError::InvalidPayload { reason, .. }
        if reason.contains("fractional seconds must contain at most 9 digits")));
}

#[test]
fn v4_rejects_a_rehashed_nested_v3_body_that_replay_would_not_authorize() {
    let run_id = RunId::new();
    let declaration = graph(run_id);
    let declaration_event_ref = EventId::new();
    let mut nested = dispatch_v3();

    // Recompute both nested and outer digests after corrupting a body field.
    // An outer V4 digest alone must never allow storage to sign a record that
    // trusted replay would later reject.
    nested.body.base_commit_sha = "not-a-full-git-object-id".into();
    nested.envelope_digest = dispatch_envelope_v3_body_digest(
        &nested.body,
        nested.action_evidence_version,
        &nested.repository_binding_digest,
        &nested.ledger_authority_realm_digest,
        nested.governed_packet_digest.as_deref(),
    )
    .unwrap();
    let mut dispatch_v4 = DispatchEnvelopeV4 {
        envelope_digest: String::new(),
        dispatch_v3: nested,
        workflow_graph_digest: declaration.graph_digest,
        workflow_graph_declaration_event_ref: declaration_event_ref,
    };
    dispatch_v4.envelope_digest = dispatch_envelope_v4_digest(
        &dispatch_v4.dispatch_v3,
        &dispatch_v4.workflow_graph_digest,
        &dispatch_v4.workflow_graph_declaration_event_ref,
    )
    .unwrap();

    let error = canonicalize_payload(
        "dispatch_envelope_v4",
        Event::CURRENT_SCHEMA_VERSION,
        serde_json::to_value(Payload::DispatchEnvelopeV4(dispatch_v4)).unwrap(),
    )
    .unwrap_err();
    assert!(matches!(error, LedgerError::InvalidPayload { reason, .. }
        if reason.contains("base_commit_sha must be a full canonical Git object ID")));
}

#[test]
fn graph_v2_rejects_unknown_fields_and_noncanonical_node_packet_digests() {
    let run_id = RunId::new();
    let declaration = graph(run_id);
    let mut unknown =
        serde_json::to_value(Payload::WorkflowGraphDeclaredV2(declaration.clone())).unwrap();
    unknown["WorkflowGraphDeclaredV2"]["nodes"][0]["unexpected"] = json!(true);
    assert!(canonicalize_payload(
        "workflow_graph_declared_v2",
        Event::CURRENT_SCHEMA_VERSION,
        unknown,
    )
    .is_err());

    let mut malformed = declaration;
    malformed.nodes[0].governed_packet_digest = "not-a-digest".into();
    malformed.graph_digest = workflow_graph_v2_digest(&malformed).unwrap();
    let result = canonicalize_payload(
        "workflow_graph_declared_v2",
        Event::CURRENT_SCHEMA_VERSION,
        serde_json::to_value(Payload::WorkflowGraphDeclaredV2(malformed)).unwrap(),
    );
    assert!(matches!(result, Err(LedgerError::InvalidPayload { .. })));
}

#[test]
fn graph_v2_rejects_non_ascii_topology_identifiers_to_match_the_typescript_boundary() {
    let run_id = RunId::new();
    let mut non_ascii_node = graph(run_id);
    non_ascii_node.nodes[0].unit_id = "unit-😀".into();
    non_ascii_node.graph_digest = workflow_graph_v2_digest(&non_ascii_node).unwrap();
    let node_error = canonicalize_payload(
        "workflow_graph_declared_v2",
        Event::CURRENT_SCHEMA_VERSION,
        serde_json::to_value(Payload::WorkflowGraphDeclaredV2(non_ascii_node)).unwrap(),
    )
    .unwrap_err();
    assert!(
        matches!(node_error, LedgerError::InvalidPayload { reason, .. }
        if reason.contains("unit_id must be ASCII"))
    );

    let mut non_ascii_dependency = graph(run_id);
    non_ascii_dependency.nodes.push(WorkflowGraphNodeV2 {
        unit_id: "unit-b".into(),
        depends_on: vec!["unit-😀".into()],
        execution_role: ExecutionRoleV1::Implementer,
        governed_packet_digest: digest('a'),
    });
    non_ascii_dependency.graph_digest = workflow_graph_v2_digest(&non_ascii_dependency).unwrap();
    let dependency_error = canonicalize_payload(
        "workflow_graph_declared_v2",
        Event::CURRENT_SCHEMA_VERSION,
        serde_json::to_value(Payload::WorkflowGraphDeclaredV2(non_ascii_dependency)).unwrap(),
    )
    .unwrap_err();
    assert!(
        matches!(dependency_error, LedgerError::InvalidPayload { reason, .. }
        if reason.contains("dependency ids must be ASCII"))
    );
}
