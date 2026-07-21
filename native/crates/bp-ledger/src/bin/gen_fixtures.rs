//! Emit one canonical Payload JSON per variant into a single fixture file.
//! Phase B drift alarm: TS exhaustive switch is kept in sync by comparing
//! against this generated file in CI.

use bp_ledger::id::{EventId, RunId};
use bp_ledger::payload::acceptance::{AcceptanceCheckResultV1, AcceptanceRecordedV1};
use bp_ledger::payload::activity::{ActivityCompletedV1, ActivityStartedV1, ActivityType};
use bp_ledger::payload::activity_claim::{
    ActivityClaimPurposeV1, ActivityClaimedV1, ActivityHeartbeatRecordedV1,
    ActivityResultOutcomeV1, ActivityResultRecordedV1,
};
use bp_ledger::payload::capability_broker::CapabilityDeniedV1;
use bp_ledger::payload::checkpoint::{TapeCheckpointV1, TapeRootAlgorithm};
use bp_ledger::payload::git_checkpoint::{CheckpointBoundary, GitCheckpointV1, GitStatus};
use bp_ledger::payload::model_io::{
    Message, ModelRequestV1, ModelResponseV1, SamplingParams, Usage,
};
use bp_ledger::payload::operator_decision::OperatorDecisionRecordedV1;
use bp_ledger::payload::plan_lifecycle::{
    PlanAdmittedV1, PlanReceiptOutcome, PlanReceiptRecordedV1,
};
use bp_ledger::payload::run_lifecycle::{
    ResultReadyV1, RunAdmissionDecision, RunAdmissionEvidenceInputV1, RunAdmissionRecordedV1,
    RunCompletedV1, RunFailedV1, RunOutcome, RunStartedV1,
};
use bp_ledger::payload::tool_io::{EnvRedaction, ToolRequestStoredV1, ToolResultV1};
use bp_ledger::payload::trust_spine::{
    action_receipt_recorded_v2_digest, action_receipt_set_v1_digest, action_requested_v2_digest,
    attempt_context_recorded_v1_digest, candidate_completion_recorded_v1_digest,
    candidate_view_v1_digest, dispatch_envelope_v2_body_digest, dispatch_envelope_v3_body_digest,
    dispatch_envelope_v4_digest, model_action_authorized_v1_digest,
    model_action_authorized_v2_digest, model_action_intent_v1_digest,
    review_verdict_output_v1_digest, workflow_graph_v1_digest, workflow_graph_v2_digest,
    ActionEvidenceVersionV1, ActionKindV1, ActionReceiptOutcomeV2, ActionReceiptRecordedV2,
    ActionReceiptSetEntryV1, ActionReceiptSetRecordedV1, ActionRequestedV2, ActionResourceUsageV1,
    AttemptContextRecordedV1, CandidateAcceptanceOutcomeV1, CandidateAcceptanceRecordedV1,
    CandidateCompletionRecordedV1, CandidateCreatedV1, CandidateCreatedV2, CandidateViewV1,
    CommitModeV1, DispatchBudgetV1, DispatchEnvelopeBodyV2, DispatchEnvelopeV1, DispatchEnvelopeV2,
    DispatchEnvelopeV3, DispatchEnvelopeV4, ExecutionRoleV1, ModelActionAuthorizedV1,
    ModelActionAuthorizedV2, ModelActionIntentV1, ModelRequestEvidenceV1,
    PromotionApprovalRequestedV1, PromotionDecisionKindV1, PromotionDecisionRecordedV1,
    PromotionExecutionClaimedV1, PromotionGitBindingV1, PromotionReconciliationResolvedV1,
    PromotionResultOutcomeV1, PromotionResultRecordedV1, PromotionWorktreeSyncStateV1,
    ReconciliationResolutionOutcomeV1, ReviewDecisionV1, ReviewFindingSeverityV1, ReviewFindingV1,
    ReviewVerdictOutputV1, ReviewVerdictRecordedV1, ReviewVerdictRecordedV2, SignatureRefV1,
    TrustScopeEvidenceV1, TrustTierV1, WorkflowCancellationCauseV1,
    WorkflowCancellationRequestedV1, WorkflowGraphDeclaredV1, WorkflowGraphDeclaredV2,
    WorkflowGraphNodeV1, WorkflowGraphNodeV2, WorkflowTerminalOutcomeV1, WorkflowTerminalV1,
    WorkflowTerminalV2, WorkflowTimerFiredV1, WorkflowTimerKindV1, WorkflowTimerScheduledV1,
    MODEL_REQUEST_EVIDENCE_V1_SCHEMA_VERSION, TRUST_SCOPE_EVIDENCE_V1_SCHEMA_VERSION,
    TYPESCRIPT_SAFE_INTEGER_MAX,
};
use bp_ledger::payload::unit_lifecycle::{
    ArtifactRef, CancelCause, UnitCancelledV1, UnitCompletedV1, UnitFailedV1, UnitOutcome,
    UnitStartedV1,
};
use bp_ledger::payload::workspace::{PostWriteState, WorkspaceReadV1, WorkspaceWriteV1};
use bp_ledger::payload::Payload;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

/// Fixed deterministic EventIds for fixture stability (no EventId::new() in generators).
fn fixed_event_id(n: u8) -> EventId {
    EventId::from_uuid(
        uuid::Uuid::parse_str(&format!("01919000-0000-7000-8000-{:012}", n)).unwrap(),
    )
}

/// Fixed deterministic RunId for fixture stability.
fn fixed_run_id() -> RunId {
    RunId::from_uuid(uuid::Uuid::parse_str("01919000-0000-7000-8000-0000000000ff").unwrap())
}

/// Trust-spine fixtures are appended after the legacy fixture sequence so old
/// fixture indexes and tape compatibility tests remain stable.
fn trust_spine_fixtures() -> Vec<Value> {
    // Keep the V2 body independently admissible by the strict kernel parser.
    // The legacy V1 fixture intentionally preserves its historical abbreviated
    // placeholder digests, but V2 is the non-circular governed wire contract
    // consumed by the CLI preview adapter.
    const V2_DIGEST_A: &str =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const V2_DIGEST_B: &str =
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const V2_DIGEST_C: &str =
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const V2_DIGEST_D: &str =
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const V2_DIGEST_E: &str =
        "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    vec![
        serde_json::to_value(Payload::DispatchEnvelopeV1(DispatchEnvelopeV1 {
            workflow_id: "workflow-fixture".into(),
            workflow_revision: "r1".into(),
            unit_id: "unit-fixture".into(),
            attempt: 1,
            execution_role: ExecutionRoleV1::Implementer,
            commit_mode: CommitModeV1::Atomic,
            provenance_ref: "admission:fixture".into(),
            base_commit_sha: "0".repeat(40),
            capability_bundle_digest: "sha256:aa".into(),
            acceptance_contract_digest: "sha256:bb".into(),
            context_manifest_digest: "sha256:cc".into(),
            worker_manifest_digest: "sha256:dd".into(),
            sandbox_profile_digest: "sha256:ee".into(),
            budget: DispatchBudgetV1 {
                max_tokens: Some(100),
                max_compute_time_ms: Some(1_000),
            },
            trust_tier: TrustTierV1::Governed,
            idempotency_key: "dispatch:fixture".into(),
            issued_at: "2026-07-17T00:00:00Z".into(),
            expires_at: "2026-07-17T01:00:00Z".into(),
            envelope_digest: "sha256:ff".into(),
            signature_ref: SignatureRefV1 {
                algorithm: "ed25519".into(),
                key_id: "kernel-fixture".into(),
                signature: "fixture".into(),
            },
        }))
        .unwrap(),
        serde_json::to_value(Payload::DispatchEnvelopeV2({
            let body = DispatchEnvelopeBodyV2 {
                workflow_id: "workflow-fixture-v2".into(),
                workflow_revision: "r1".into(),
                unit_id: "unit-fixture-v2".into(),
                attempt: 1,
                execution_role: ExecutionRoleV1::Implementer,
                commit_mode: CommitModeV1::Atomic,
                provenance_ref: "admission:fixture-v2".into(),
                base_commit_sha: "0".repeat(40),
                capability_bundle_digest: V2_DIGEST_A.into(),
                acceptance_contract_digest: V2_DIGEST_B.into(),
                context_manifest_digest: V2_DIGEST_C.into(),
                worker_manifest_digest: V2_DIGEST_D.into(),
                sandbox_profile_digest: V2_DIGEST_E.into(),
                budget: DispatchBudgetV1 {
                    max_tokens: Some(100),
                    max_compute_time_ms: Some(1_000),
                },
                trust_tier: TrustTierV1::Governed,
                idempotency_key: "dispatch:fixture-v2".into(),
                issued_at: "2026-07-17T00:00:00Z".into(),
                expires_at: "2026-07-17T01:00:00Z".into(),
            };
            DispatchEnvelopeV2 {
                envelope_digest: dispatch_envelope_v2_body_digest(&body)
                    .expect("serialize deterministic v2 dispatch fixture body"),
                body,
            }
        }))
        .unwrap(),
        serde_json::to_value(Payload::CandidateCreatedV1(CandidateCreatedV1 {
            candidate_id: "candidate-fixture".into(),
            candidate_ref: "refs/buildplane/candidates/candidate-fixture/run-fixture/1".into(),
            workflow_id: "workflow-fixture".into(),
            unit_id: "unit-fixture".into(),
            attempt: 1,
            provenance_ref: "admission:fixture".into(),
            candidate_digest: "sha256:aa".into(),
            base_commit_sha: "0".repeat(40),
            candidate_commit_sha: "1".repeat(40),
            commit_digest: "sha256:bb".into(),
            tree_digest: "sha256:cc".into(),
            patch_digest: "sha256:dd".into(),
            changed_files_digest: "sha256:ee".into(),
            envelope_digest: "sha256:ff".into(),
            action_receipt_digest: "sha256:aa".into(),
        }))
        .unwrap(),
        serde_json::to_value(Payload::CandidateAcceptanceRecordedV1(
            CandidateAcceptanceRecordedV1 {
                candidate_digest: "sha256:aa".into(),
                candidate_commit_sha: "1".repeat(40),
                acceptance_ref: "acceptance:fixture".into(),
                acceptance_contract_digest: "sha256:acceptance-contract".into(),
                acceptance_digest: "sha256:bb".into(),
                outcome: CandidateAcceptanceOutcomeV1::Passed,
                evaluated_at: "2026-07-17T00:01:00Z".into(),
            },
        ))
        .unwrap(),
        serde_json::to_value(Payload::ReviewVerdictRecordedV1(ReviewVerdictRecordedV1 {
            candidate_digest: "sha256:aa".into(),
            candidate_commit_sha: "1".repeat(40),
            review_ref: "review:fixture".into(),
            review_verdict_action_id: None,
            review_action_request_digest: None,
            review_action_receipt_ref: None,
            review_action_receipt_digest: None,
            review_output_ref: None,
            review_output_digest: None,
            decision: ReviewDecisionV1::Approve,
            findings: vec![ReviewFindingV1 {
                severity: ReviewFindingSeverityV1::Info,
                check_id: "lint".into(),
                file: "src/index.ts".into(),
                line: 1,
                explanation: "fixture".into(),
                evidence_refs: vec!["evidence:lint".into()],
            }],
            confidence: 1.0,
            reviewer_manifest_digest: "sha256:cc".into(),
            reviewed_at: "2026-07-17T00:02:00Z".into(),
        }))
        .unwrap(),
        serde_json::to_value(Payload::PromotionApprovalRequestedV1(
            PromotionApprovalRequestedV1 {
                candidate_digest: "sha256:aa".into(),
                base_commit_sha: "0".repeat(40),
                target_ref: "refs/heads/main".into(),
                envelope_digest: "sha256:ff".into(),
                acceptance_ref: "acceptance:fixture".into(),
                review_refs: vec!["review:fixture".into()],
                requested_by: "kernel".into(),
                requested_at: "2026-07-17T00:02:30Z".into(),
                idempotency_key: "promotion:fixture".into(),
            },
        ))
        .unwrap(),
        serde_json::to_value(Payload::PromotionDecisionRecordedV1(
            PromotionDecisionRecordedV1 {
                candidate_digest: "sha256:aa".into(),
                base_commit_sha: "0".repeat(40),
                target_ref: Some("refs/heads/main".into()),
                envelope_digest: "sha256:ff".into(),
                acceptance_ref: "acceptance:fixture".into(),
                review_refs: vec!["review:fixture".into()],
                promotion_approval_request_ref: None,
                decision: PromotionDecisionKindV1::Promote,
                authority: "operator".into(),
                decided_by: "operator".into(),
                decided_at: "2026-07-17T00:03:00Z".into(),
                idempotency_key: "promotion:fixture".into(),
            },
        ))
        .unwrap(),
        serde_json::to_value(Payload::PromotionExecutionClaimedV1(
            PromotionExecutionClaimedV1 {
                run_id: fixed_run_id().to_string(),
                promotion_decision_event_ref: fixed_event_id(93),
                promotion_decision_event_digest: "sha256:decision-event".into(),
                dispatch_event_ref: fixed_event_id(94),
                dispatch_envelope_digest: "sha256:ff".into(),
                candidate_digest: "sha256:aa".into(),
                candidate_ref: "refs/buildplane/candidates/candidate-fixture/run-fixture".into(),
                candidate_commit_sha: "1".repeat(40),
                candidate_tree_digest: "sha256:dd".into(),
                base_commit_sha: "0".repeat(40),
                target_ref: "refs/heads/main".into(),
                idempotency_key: "promotion:fixture".into(),
                authority_actor: "kernel".into(),
                lease_id: "lease:fixture".into(),
                claimed_at: "2026-07-17T00:03:30Z".into(),
                lease_expires_at: "2026-07-17T00:08:30Z".into(),
                promotion_execution_claim_digest: "sha256:claim".into(),
            },
        ))
        .unwrap(),
        serde_json::to_value(Payload::PromotionResultRecordedV1(
            PromotionResultRecordedV1 {
                candidate_digest: "sha256:aa".into(),
                idempotency_key: "promotion:fixture".into(),
                promotion_decision_ref: "decision:fixture".into(),
                outcome: PromotionResultOutcomeV1::ReconciliationRequired,
                merged_head_sha: Some("2".repeat(40)),
                promotion_git_binding: Some(PromotionGitBindingV1 {
                    target_ref: "refs/heads/main".into(),
                    target_head_before_sha: "0".repeat(40),
                    target_head_after_sha: Some("2".repeat(40)),
                    merged_head_sha: Some("2".repeat(40)),
                    candidate_commit_sha: "1".repeat(40),
                    merge_parent_shas: Some(vec!["0".repeat(40), "1".repeat(40)]),
                    merged_tree_sha: Some("3".repeat(40)),
                    merged_tree_digest: "sha256:dd".into(),
                    promotion_receipt_ref: Some(
                        "refs/buildplane/promotions/candidate-fixture/run-fixture/1".into(),
                    ),
                    worktree_sync_state: Some(PromotionWorktreeSyncStateV1::RootCheckoutStale),
                }),
                promotion_execution_lease_binding: None,
                completed_at: "2026-07-17T00:04:00Z".into(),
            },
        ))
        .unwrap(),
        serde_json::to_value(Payload::PromotionReconciliationResolvedV1(
            PromotionReconciliationResolvedV1 {
                candidate_digest: "sha256:aa".into(),
                promotion_decision_ref: "decision:fixture".into(),
                promotion_result_ref: "result:fixture".into(),
                promotion_receipt_ref: "refs/buildplane/promotions/candidate-fixture/run-fixture/1"
                    .into(),
                outcome: ReconciliationResolutionOutcomeV1::Abandon,
                authority: "operator".into(),
                resolved_by: "operator".into(),
                idempotency_key: "reconcile:fixture".into(),
                resolved_at: "2026-07-17T00:04:30Z".into(),
            },
        ))
        .unwrap(),
        serde_json::to_value(Payload::WorkflowTerminalV1(WorkflowTerminalV1 {
            workflow_id: "workflow-fixture".into(),
            workflow_revision: "r1".into(),
            unit_id: "unit-fixture".into(),
            attempt: 1,
            outcome: WorkflowTerminalOutcomeV1::Completed,
            candidate_digest: Some("sha256:aa".into()),
            promotion_result_ref: Some("result:fixture".into()),
            reconciliation_resolution_ref: None,
            reason: None,
            idempotency_key: "workflow-terminal:fixture".into(),
            completed_at: "2026-07-17T00:05:00Z".into(),
        }))
        .unwrap(),
    ]
}

/// One canonical workflow-topology declaration keeps the TypeScript external
/// payload union and native graph-digest contract in the fixture drift alarm.
fn workflow_graph_fixtures() -> Vec<Value> {
    let mut declaration = WorkflowGraphDeclaredV1 {
        run_id: fixed_run_id().to_string(),
        workflow_id: "workflow-graph-fixture".into(),
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
        idempotency_key: "workflow-graph:fixture".into(),
        declared_at: "2026-07-19T00:00:00Z".into(),
    };
    declaration.graph_digest = workflow_graph_v1_digest(&declaration)
        .expect("serialize deterministic workflow graph fixture");
    vec![serde_json::to_value(Payload::WorkflowGraphDeclaredV1(declaration)).unwrap()]
}

/// Graph-bound V4 fixtures keep the V2 topology and the nested V3 authority
/// bytes in the generated drift surface. The declaration and dispatch are
/// separate payload fixtures because event ordering is a replay concern.
fn graph_bound_dispatch_v4_fixtures() -> Vec<Value> {
    const DIGEST_A: &str =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const DIGEST_B: &str =
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const DIGEST_C: &str =
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const DIGEST_D: &str =
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const DIGEST_E: &str =
        "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    let mut graph = WorkflowGraphDeclaredV2 {
        run_id: fixed_run_id().to_string(),
        workflow_id: "workflow-fixture-v4".into(),
        workflow_revision: "r1".into(),
        nodes: vec![WorkflowGraphNodeV2 {
            unit_id: "unit-fixture-v4".into(),
            depends_on: vec![],
            execution_role: ExecutionRoleV1::Implementer,
            governed_packet_digest: DIGEST_A.into(),
        }],
        max_concurrent: 1,
        graph_digest: String::new(),
        idempotency_key: "graph-v2:fixture-v4:r1".into(),
        declared_at: "2026-07-19T00:00:00Z".into(),
    };
    graph.graph_digest = workflow_graph_v2_digest(&graph)
        .expect("serialize deterministic graph-bound V2 workflow fixture");

    let body = DispatchEnvelopeBodyV2 {
        workflow_id: graph.workflow_id.clone(),
        workflow_revision: graph.workflow_revision.clone(),
        unit_id: graph.nodes[0].unit_id.clone(),
        attempt: 1,
        execution_role: ExecutionRoleV1::Implementer,
        commit_mode: CommitModeV1::Atomic,
        provenance_ref: "admission:fixture-v4".into(),
        base_commit_sha: "0".repeat(40),
        capability_bundle_digest: DIGEST_B.into(),
        acceptance_contract_digest: DIGEST_C.into(),
        context_manifest_digest: DIGEST_D.into(),
        worker_manifest_digest: DIGEST_E.into(),
        sandbox_profile_digest: DIGEST_A.into(),
        budget: DispatchBudgetV1 {
            max_tokens: Some(100),
            max_compute_time_ms: Some(1_000),
        },
        trust_tier: TrustTierV1::Governed,
        idempotency_key: "dispatch:fixture-v4:unit-fixture-v4:1".into(),
        issued_at: "2026-07-19T00:01:00Z".into(),
        expires_at: "2026-07-19T01:01:00Z".into(),
    };
    let dispatch_v3 = DispatchEnvelopeV3 {
        envelope_digest: dispatch_envelope_v3_body_digest(
            &body,
            ActionEvidenceVersionV1::SealedV3,
            DIGEST_B,
            DIGEST_C,
            Some(DIGEST_A),
        )
        .expect("serialize deterministic nested V3 graph-bound fixture"),
        body,
        action_evidence_version: ActionEvidenceVersionV1::SealedV3,
        repository_binding_digest: DIGEST_B.into(),
        ledger_authority_realm_digest: DIGEST_C.into(),
        governed_packet_digest: Some(DIGEST_A.into()),
    };
    let declaration_event_ref = fixed_event_id(60);
    let mut dispatch = DispatchEnvelopeV4 {
        dispatch_v3,
        workflow_graph_digest: graph.graph_digest.clone(),
        workflow_graph_declaration_event_ref: declaration_event_ref,
        envelope_digest: String::new(),
    };
    dispatch.envelope_digest = dispatch_envelope_v4_digest(
        &dispatch.dispatch_v3,
        &dispatch.workflow_graph_digest,
        &dispatch.workflow_graph_declaration_event_ref,
    )
    .expect("serialize deterministic graph-bound V4 dispatch fixture");

    vec![
        serde_json::to_value(Payload::WorkflowGraphDeclaredV2(graph)).unwrap(),
        serde_json::to_value(Payload::DispatchEnvelopeV4(dispatch)).unwrap(),
    ]
}

/// A claim and its terminal result exercise the durable activity-claim wire
/// contracts together while keeping their event references deterministic.
fn activity_claim_fixtures() -> Vec<Value> {
    const DIGEST_A: &str =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const DIGEST_B: &str =
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const DIGEST_C: &str =
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const DIGEST_D: &str =
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

    let claim = ActivityClaimedV1 {
        run_id: fixed_run_id(),
        activity_id: "activity-claim-fixture".into(),
        idempotency_key: "activity-claim:fixture".into(),
        action_kind: ActionKindV1::Process,
        action_request_event_id: fixed_event_id(42),
        action_request_digest: DIGEST_A.into(),
        dispatch_event_id: fixed_event_id(43),
        dispatch_envelope_digest: DIGEST_B.into(),
        authority_actor: "kernel:fixture".into(),
        purpose: ActivityClaimPurposeV1::Generic,
        lease_id: "lease:fixture".into(),
        lease_expires_at: "2026-07-17T00:05:00Z".into(),
        claimed_at: "2026-07-17T00:00:00Z".into(),
    };
    let result = ActivityResultRecordedV1 {
        run_id: claim.run_id,
        activity_id: claim.activity_id.clone(),
        idempotency_key: claim.idempotency_key.clone(),
        claim_event_id: fixed_event_id(44),
        claim_event_digest: DIGEST_C.into(),
        lease_id: claim.lease_id.clone(),
        outcome: ActivityResultOutcomeV1::Succeeded,
        result_digest: Some(DIGEST_D.into()),
        result_ref: Some("cas:activity-result:fixture".into()),
        evidence_digest: DIGEST_A.into(),
        evidence_ref: "cas:activity-evidence:fixture".into(),
        recorded_at: "2026-07-17T00:00:01Z".into(),
    };
    let heartbeat = ActivityHeartbeatRecordedV1 {
        run_id: claim.run_id,
        activity_id: claim.activity_id.clone(),
        idempotency_key: claim.idempotency_key.clone(),
        heartbeat_id: Some("heartbeat:fixture".into()),
        heartbeat_request_digest: Some(DIGEST_A.into()),
        claim_event_id: fixed_event_id(44),
        claim_event_digest: DIGEST_C.into(),
        lease_id: claim.lease_id.clone(),
        dispatch_event_id: claim.dispatch_event_id,
        dispatch_envelope_digest: claim.dispatch_envelope_digest.clone(),
        lease_expires_at: "2026-07-17T00:10:00Z".into(),
        heartbeat_at: "2026-07-17T00:00:00.500Z".into(),
    };

    vec![
        serde_json::to_value(Payload::ActivityClaimedV1(claim)).unwrap(),
        serde_json::to_value(Payload::ActivityHeartbeatRecordedV1(heartbeat)).unwrap(),
        serde_json::to_value(Payload::ActivityResultRecordedV1(result)).unwrap(),
    ]
}

/// Lifecycle-control fixtures are deliberately appended as one causally
/// ordered sequence. They exercise the external wire union without claiming
/// that the standalone payload fixture is a replayable signed tape.
fn workflow_lifecycle_fixtures() -> Vec<Value> {
    const DIGEST_A: &str =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const DIGEST_B: &str =
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const DIGEST_C: &str =
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    let scheduled = WorkflowTimerScheduledV1 {
        run_id: fixed_run_id().to_string(),
        workflow_id: "workflow-lifecycle-fixture".into(),
        workflow_revision: "r1".into(),
        unit_id: "unit-lifecycle-fixture".into(),
        attempt: 1,
        dispatch_event_ref: fixed_event_id(89),
        dispatch_envelope_digest: DIGEST_A.into(),
        timer_id: "deadline:fixture".into(),
        timer_kind: WorkflowTimerKindV1::WorkflowDeadline,
        due_at: "2026-07-17T00:10:00Z".into(),
        idempotency_key: "timer:fixture".into(),
        scheduled_by: "kernel:fixture".into(),
        scheduled_at: "2026-07-17T00:00:00Z".into(),
    };
    let fired = WorkflowTimerFiredV1 {
        run_id: scheduled.run_id.clone(),
        workflow_id: scheduled.workflow_id.clone(),
        workflow_revision: scheduled.workflow_revision.clone(),
        unit_id: scheduled.unit_id.clone(),
        attempt: scheduled.attempt,
        timer_id: scheduled.timer_id.clone(),
        timer_schedule_event_ref: fixed_event_id(90),
        timer_schedule_event_digest: DIGEST_B.into(),
        dispatch_event_ref: scheduled.dispatch_event_ref,
        dispatch_envelope_digest: scheduled.dispatch_envelope_digest.clone(),
        idempotency_key: scheduled.idempotency_key.clone(),
        fired_by: "kernel:fixture".into(),
        fired_at: "2026-07-17T00:10:00Z".into(),
    };
    let cancellation = WorkflowCancellationRequestedV1 {
        run_id: scheduled.run_id.clone(),
        workflow_id: scheduled.workflow_id.clone(),
        workflow_revision: scheduled.workflow_revision.clone(),
        unit_id: scheduled.unit_id.clone(),
        attempt: scheduled.attempt,
        dispatch_event_ref: scheduled.dispatch_event_ref,
        dispatch_envelope_digest: scheduled.dispatch_envelope_digest.clone(),
        cancellation_id: "cancellation:fixture".into(),
        cause: WorkflowCancellationCauseV1::TimerElapsed,
        timer_fired_event_ref: Some(fixed_event_id(91)),
        timer_fired_event_digest: Some(DIGEST_C.into()),
        requested_by: "kernel:fixture".into(),
        idempotency_key: "cancellation:fixture".into(),
        requested_at: "2026-07-17T00:10:01Z".into(),
    };
    let terminal = WorkflowTerminalV2 {
        workflow_id: scheduled.workflow_id.clone(),
        workflow_revision: scheduled.workflow_revision.clone(),
        unit_id: scheduled.unit_id.clone(),
        attempt: scheduled.attempt,
        outcome: WorkflowTerminalOutcomeV1::Cancelled,
        candidate_digest: None,
        promotion_result_ref: None,
        reconciliation_resolution_ref: None,
        cancellation_request_event_ref: Some(fixed_event_id(92)),
        cancellation_request_event_digest: Some(DIGEST_A.into()),
        reason: Some("deadline elapsed".into()),
        idempotency_key: "workflow-terminal-v2:fixture".into(),
        completed_at: "2026-07-17T00:10:02Z".into(),
    };

    vec![
        serde_json::to_value(Payload::WorkflowTimerScheduledV1(scheduled)).unwrap(),
        serde_json::to_value(Payload::WorkflowTimerFiredV1(fired)).unwrap(),
        serde_json::to_value(Payload::WorkflowCancellationRequestedV1(cancellation)).unwrap(),
        serde_json::to_value(Payload::WorkflowTerminalV2(terminal)).unwrap(),
    ]
}

/// One complete V3 action-evidence chain is enough for the generated payload
/// drift alarm: every new externally-tagged variant gets a stable fixture
/// without pretending that fixtures alone prove reducer ordering semantics.
fn action_evidence_v3_fixtures() -> Vec<Value> {
    const DIGEST_A: &str =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const DIGEST_B: &str =
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const DIGEST_C: &str =
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const DIGEST_D: &str =
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const DIGEST_E: &str =
        "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    let body = DispatchEnvelopeBodyV2 {
        workflow_id: "workflow-fixture-v3".into(),
        workflow_revision: "r1".into(),
        unit_id: "unit-fixture-v3".into(),
        attempt: 1,
        execution_role: ExecutionRoleV1::Implementer,
        commit_mode: CommitModeV1::Atomic,
        provenance_ref: "admission:fixture-v3".into(),
        base_commit_sha: "0".repeat(40),
        capability_bundle_digest: DIGEST_A.into(),
        acceptance_contract_digest: DIGEST_B.into(),
        context_manifest_digest: DIGEST_C.into(),
        worker_manifest_digest: DIGEST_D.into(),
        sandbox_profile_digest: DIGEST_E.into(),
        budget: DispatchBudgetV1 {
            max_tokens: Some(100),
            max_compute_time_ms: Some(1_000),
        },
        trust_tier: TrustTierV1::Governed,
        idempotency_key: "dispatch:fixture-v3".into(),
        issued_at: "2026-07-17T00:00:00Z".into(),
        expires_at: "2026-07-17T01:00:00Z".into(),
    };
    let dispatch = DispatchEnvelopeV3 {
        envelope_digest: dispatch_envelope_v3_body_digest(
            &body,
            ActionEvidenceVersionV1::SealedV2,
            DIGEST_A,
            DIGEST_B,
            None,
        )
        .expect("serialize deterministic V3 dispatch fixture body"),
        body: body.clone(),
        action_evidence_version: ActionEvidenceVersionV1::SealedV2,
        repository_binding_digest: DIGEST_A.into(),
        ledger_authority_realm_digest: DIGEST_B.into(),
        governed_packet_digest: None,
    };
    let request = ActionRequestedV2 {
        run_id: fixed_run_id().to_string(),
        workflow_id: body.workflow_id.clone(),
        unit_id: body.unit_id.clone(),
        attempt: body.attempt,
        provenance_ref: body.provenance_ref.clone(),
        action_id: "action-fixture-v3".into(),
        idempotency_key: "action:fixture-v3".into(),
        action_kind: ActionKindV1::Model,
        canonical_input_digest: DIGEST_A.into(),
        canonical_input_ref: "cas:input:fixture-v3".into(),
        dispatch_envelope_digest: dispatch.envelope_digest.clone(),
        repository_binding_digest: dispatch.repository_binding_digest.clone(),
        ledger_authority_realm_digest: dispatch.ledger_authority_realm_digest.clone(),
        governed_packet_digest: None,
        capability_bundle_digest: body.capability_bundle_digest.clone(),
        policy_digest: DIGEST_B.into(),
        context_manifest_digest: body.context_manifest_digest.clone(),
        worker_manifest_digest: body.worker_manifest_digest.clone(),
        sandbox_profile_digest: body.sandbox_profile_digest.clone(),
        authority_actor: "kernel".into(),
        execution_role: body.execution_role,
        requested_at: "2026-07-17T00:00:01Z".into(),
    };
    let mut authorization = ModelActionAuthorizedV1 {
        run_id: request.run_id.clone(),
        workflow_id: request.workflow_id.clone(),
        unit_id: request.unit_id.clone(),
        attempt: request.attempt,
        provenance_ref: request.provenance_ref.clone(),
        action_id: request.action_id.clone(),
        idempotency_key: request.idempotency_key.clone(),
        dispatch_event_ref: fixed_event_id(40).to_string(),
        dispatch_envelope_digest: request.dispatch_envelope_digest.clone(),
        action_request_ref: fixed_event_id(41).to_string(),
        action_request_digest: action_requested_v2_digest(&request)
            .expect("serialize deterministic V3 request fixture"),
        packet_digest: DIGEST_C.into(),
        canonical_input_digest: request.canonical_input_digest.clone(),
        model_request_digest: DIGEST_D.into(),
        trust_scope_digest: DIGEST_E.into(),
        context_manifest_digest: request.context_manifest_digest.clone(),
        policy_digest: request.policy_digest.clone(),
        sandbox_profile_digest: request.sandbox_profile_digest.clone(),
        execution_role: request.execution_role,
        candidate_digest: None,
        candidate_view_digest: None,
        authorization_actor: "kernel".into(),
        expires_at: "2026-07-17T00:30:00Z".into(),
        authorization_ref: "authorization:fixture-v3".into(),
        authorization_digest: String::new(),
    };
    authorization.authorization_digest = model_action_authorized_v1_digest(&authorization)
        .expect("serialize deterministic model action authorization fixture");
    let mut model_intent = ModelActionIntentV1 {
        run_id: request.run_id.clone(),
        workflow_id: request.workflow_id.clone(),
        unit_id: request.unit_id.clone(),
        attempt: request.attempt,
        provenance_ref: request.provenance_ref.clone(),
        action_id: request.action_id.clone(),
        idempotency_key: request.idempotency_key.clone(),
        dispatch_event_ref: fixed_event_id(42),
        dispatch_envelope_digest: request.dispatch_envelope_digest.clone(),
        action_request_event_ref: fixed_event_id(43),
        action_request_digest: action_requested_v2_digest(&request)
            .expect("serialize deterministic V3 request fixture"),
        canonical_input_ref: request.canonical_input_ref.clone(),
        canonical_input_digest: request.canonical_input_digest.clone(),
        model_request_evidence: ModelRequestEvidenceV1 {
            schema_version: MODEL_REQUEST_EVIDENCE_V1_SCHEMA_VERSION,
            cas_ref: format!("cas:{DIGEST_D}"),
            digest: DIGEST_D.into(),
        },
        trust_scope_evidence: TrustScopeEvidenceV1 {
            schema_version: TRUST_SCOPE_EVIDENCE_V1_SCHEMA_VERSION,
            cas_ref: format!("cas:{DIGEST_E}"),
            digest: DIGEST_E.into(),
        },
        candidate_binding: None,
        intent_actor: "kernel".into(),
        intended_at: "2026-07-17T00:00:03Z".into(),
        intent_digest: String::new(),
    };
    model_intent.intent_digest = model_action_intent_v1_digest(&model_intent)
        .expect("serialize deterministic model action intent fixture");
    let mut authorization_v2 = ModelActionAuthorizedV2 {
        intent_event_ref: fixed_event_id(44),
        intent_digest: model_intent.intent_digest.clone(),
        model_request_evidence: model_intent.model_request_evidence.clone(),
        trust_scope_evidence: model_intent.trust_scope_evidence.clone(),
        candidate_binding: None,
        authorization_actor: "kernel".into(),
        expires_at: "2026-07-17T00:30:00Z".into(),
        authorization_ref: "authorization:fixture-v3:v2".into(),
        authorization_digest: String::new(),
    };
    authorization_v2.authorization_digest = model_action_authorized_v2_digest(&authorization_v2)
        .expect("serialize deterministic V2 model action authorization fixture");
    let receipt = ActionReceiptRecordedV2 {
        run_id: request.run_id.clone(),
        workflow_id: request.workflow_id.clone(),
        unit_id: request.unit_id.clone(),
        attempt: request.attempt,
        provenance_ref: request.provenance_ref.clone(),
        action_id: request.action_id.clone(),
        idempotency_key: request.idempotency_key.clone(),
        action_request_digest: action_requested_v2_digest(&request)
            .expect("serialize deterministic V3 request fixture"),
        dispatch_envelope_digest: request.dispatch_envelope_digest.clone(),
        capability_bundle_digest: request.capability_bundle_digest.clone(),
        policy_digest: request.policy_digest.clone(),
        context_manifest_digest: request.context_manifest_digest.clone(),
        worker_manifest_digest: request.worker_manifest_digest.clone(),
        sandbox_profile_digest: request.sandbox_profile_digest.clone(),
        authority_actor: request.authority_actor.clone(),
        execution_role: request.execution_role,
        outcome: ActionReceiptOutcomeV2::Succeeded,
        result_digest: Some(DIGEST_C.into()),
        result_ref: Some("cas:result:fixture-v3".into()),
        evidence_digest: DIGEST_D.into(),
        evidence_ref: "cas:evidence:fixture-v3".into(),
        resource_usage: ActionResourceUsageV1 {
            wall_time_ms: TYPESCRIPT_SAFE_INTEGER_MAX,
            cpu_time_ms: Some(TYPESCRIPT_SAFE_INTEGER_MAX),
            peak_memory_bytes: Some(TYPESCRIPT_SAFE_INTEGER_MAX),
            input_bytes: Some(TYPESCRIPT_SAFE_INTEGER_MAX),
            output_bytes: Some(TYPESCRIPT_SAFE_INTEGER_MAX),
            // Keep the published fixture byte-for-byte compatible with the
            // pre-token receipt shape. Dedicated tests exercise the additive
            // token pair; old fixture tapes must remain readable unchanged.
            input_tokens: None,
            output_tokens: None,
        },
        redactions: vec![],
        failure: None,
        authorization_ref: Some(authorization.authorization_ref.clone()),
        action_receipt_ref: "receipt:fixture-v3".into(),
        completed_at: "2026-07-17T00:00:02Z".into(),
    };
    let mut set = ActionReceiptSetRecordedV1 {
        run_id: request.run_id.clone(),
        workflow_id: request.workflow_id.clone(),
        unit_id: request.unit_id.clone(),
        attempt: request.attempt,
        provenance_ref: request.provenance_ref.clone(),
        dispatch_envelope_digest: request.dispatch_envelope_digest.clone(),
        action_receipt_set_ref: "receipt-set:fixture-v3".into(),
        action_receipt_set_digest: String::new(),
        receipts: vec![ActionReceiptSetEntryV1 {
            action_id: request.action_id.clone(),
            action_receipt_ref: receipt.action_receipt_ref.clone(),
            action_receipt_digest: action_receipt_recorded_v2_digest(&receipt)
                .expect("serialize deterministic V3 receipt fixture"),
        }],
        sealed_at: "2026-07-17T00:00:03Z".into(),
    };
    set.action_receipt_set_digest =
        action_receipt_set_v1_digest(&set).expect("serialize deterministic V3 receipt set fixture");
    let mut attempt_context = AttemptContextRecordedV1 {
        run_id: request.run_id.clone(),
        workflow_id: body.workflow_id.clone(),
        workflow_revision: body.workflow_revision.clone(),
        unit_id: body.unit_id.clone(),
        prior_attempt: 1,
        next_attempt: 2,
        prior_dispatch_envelope_digest: dispatch.envelope_digest.clone(),
        prior_terminal_event_ref: fixed_event_id(45).to_string(),
        prior_terminal_event_digest: DIGEST_A.into(),
        prior_action_receipt_ref: receipt.action_receipt_ref.clone(),
        prior_action_receipt_digest: action_receipt_recorded_v2_digest(&receipt)
            .expect("serialize deterministic V3 receipt fixture"),
        feedback_ref: "cas:retry-feedback:fixture".into(),
        feedback_digest: DIGEST_B.into(),
        next_dispatch_envelope_digest: DIGEST_C.into(),
        next_dispatch_idempotency_key: "dispatch:fixture:2".into(),
        retry_action_namespace: "retry-action:fixture:2".into(),
        idempotency_key: "retry-context:fixture:1:2".into(),
        recorded_at: "2026-07-17T00:00:04Z".into(),
        attempt_context_digest: String::new(),
    };
    attempt_context.attempt_context_digest = attempt_context_recorded_v1_digest(&attempt_context)
        .expect("serialize deterministic retry attempt context fixture");
    let candidate = CandidateCreatedV2 {
        run_id: request.run_id.clone(),
        candidate_id: "candidate-fixture-v3".into(),
        candidate_ref: "refs/buildplane/candidates/candidate-fixture-v3/run-fixture/1".into(),
        workflow_id: body.workflow_id.clone(),
        unit_id: body.unit_id.clone(),
        attempt: body.attempt,
        provenance_ref: body.provenance_ref.clone(),
        candidate_digest: DIGEST_A.into(),
        base_commit_sha: body.base_commit_sha.clone(),
        candidate_commit_sha: "1".repeat(40),
        commit_digest: DIGEST_B.into(),
        tree_digest: DIGEST_C.into(),
        patch_digest: DIGEST_D.into(),
        changed_files_digest: DIGEST_E.into(),
        envelope_digest: dispatch.envelope_digest.clone(),
        action_receipt_set_ref: set.action_receipt_set_ref.clone(),
        action_receipt_set_digest: set.action_receipt_set_digest.clone(),
    };
    let mut candidate_completion = CandidateCompletionRecordedV1 {
        run_id: candidate.run_id.clone(),
        workflow_id: candidate.workflow_id.clone(),
        unit_id: candidate.unit_id.clone(),
        attempt: candidate.attempt,
        provenance_ref: candidate.provenance_ref.clone(),
        candidate_created_event_ref: fixed_event_id(46),
        candidate_digest: candidate.candidate_digest.clone(),
        candidate_create_action_id: request.action_id.clone(),
        action_request_ref: fixed_event_id(41),
        action_request_digest: action_requested_v2_digest(&request)
            .expect("serialize deterministic candidate completion request fixture"),
        activity_claim_event_ref: fixed_event_id(47),
        activity_claim_event_digest: DIGEST_C.into(),
        activity_result_event_ref: fixed_event_id(48),
        activity_result_event_digest: DIGEST_D.into(),
        action_receipt_ref: receipt.action_receipt_ref.clone(),
        action_receipt_digest: action_receipt_recorded_v2_digest(&receipt)
            .expect("serialize deterministic candidate completion receipt fixture"),
        completion_digest: String::new(),
        completed_at: "2026-07-17T00:00:04Z".into(),
    };
    candidate_completion.completion_digest =
        candidate_completion_recorded_v1_digest(&candidate_completion)
            .expect("serialize deterministic candidate completion fixture");
    let candidate_view = CandidateViewV1 {
        candidate_ref: candidate.candidate_ref.clone(),
        candidate_digest: candidate.candidate_digest.clone(),
        candidate_commit_sha: candidate.candidate_commit_sha.clone(),
        tree_digest: candidate.tree_digest.clone(),
        reviewer_context_manifest_digest: body.context_manifest_digest.clone(),
        reviewer_sandbox_profile_digest: body.sandbox_profile_digest.clone(),
        mount_path_digest: DIGEST_D.into(),
        read_only: true,
        network_disabled: true,
    };
    let candidate_view_digest = candidate_view_v1_digest(&candidate_view)
        .expect("serialize deterministic candidate view fixture");
    let review_output = ReviewVerdictOutputV1 {
        candidate_digest: candidate.candidate_digest.clone(),
        candidate_commit_sha: candidate.candidate_commit_sha.clone(),
        decision: ReviewDecisionV1::Approve,
        findings: vec![],
        confidence: 0.99,
        candidate_view_digest: candidate_view_digest.clone(),
    };
    let review_output_digest = review_verdict_output_v1_digest(&review_output)
        .expect("serialize deterministic review output fixture");
    let review = ReviewVerdictRecordedV2 {
        run_id: request.run_id.clone(),
        workflow_id: candidate.workflow_id.clone(),
        unit_id: candidate.unit_id.clone(),
        attempt: candidate.attempt,
        provenance_ref: candidate.provenance_ref.clone(),
        candidate_digest: candidate.candidate_digest.clone(),
        candidate_commit_sha: candidate.candidate_commit_sha.clone(),
        review_ref: "review:fixture-v2".into(),
        review_verdict_action_id: "review-action:fixture-v2".into(),
        review_action_request_digest: DIGEST_A.into(),
        review_action_receipt_ref: "receipt:review-action:fixture-v2".into(),
        review_action_receipt_digest: DIGEST_B.into(),
        review_output_ref: format!("cas:{review_output_digest}"),
        review_output_digest,
        decision: review_output.decision,
        findings: review_output.findings,
        confidence: review_output.confidence,
        acceptance_ref: "acceptance:fixture-v3".into(),
        acceptance_digest: DIGEST_A.into(),
        acceptance_contract_digest: body.acceptance_contract_digest.clone(),
        candidate_envelope_digest: candidate.envelope_digest.clone(),
        reviewer_workflow_id: "workflow-review-fixture-v3".into(),
        reviewer_dispatch_envelope_digest: DIGEST_B.into(),
        reviewer_unit_id: "review-unit-fixture-v3".into(),
        reviewer_attempt: 1,
        reviewer_execution_role: ExecutionRoleV1::Reviewer,
        review_action_receipt_set_ref: "receipt-set:review:fixture-v2".into(),
        review_action_receipt_set_digest: DIGEST_C.into(),
        candidate_view,
        candidate_view_ref: "candidate-view:fixture-v2".into(),
        candidate_view_digest,
        reviewer_manifest_digest: DIGEST_D.into(),
        reviewer_authority: "reviewer".into(),
        reviewed_at: "2026-07-17T00:02:00Z".into(),
    };

    vec![
        serde_json::to_value(Payload::DispatchEnvelopeV3(dispatch)).unwrap(),
        serde_json::to_value(Payload::ActionRequestedV2(request)).unwrap(),
        serde_json::to_value(Payload::ModelActionAuthorizedV1(authorization)).unwrap(),
        serde_json::to_value(Payload::ModelActionIntentV1(model_intent)).unwrap(),
        serde_json::to_value(Payload::ModelActionAuthorizedV2(authorization_v2)).unwrap(),
        serde_json::to_value(Payload::ActionReceiptRecordedV2(receipt)).unwrap(),
        serde_json::to_value(Payload::ActionReceiptSetRecordedV1(set)).unwrap(),
        serde_json::to_value(Payload::AttemptContextRecordedV1(attempt_context)).unwrap(),
        serde_json::to_value(Payload::CandidateCreatedV2(candidate)).unwrap(),
        serde_json::to_value(Payload::CandidateCompletionRecordedV1(candidate_completion)).unwrap(),
        serde_json::to_value(Payload::ReviewVerdictRecordedV2(review)).unwrap(),
    ]
}

fn main() {
    let mut out: Vec<Value> = vec![
        serde_json::to_value(Payload::RunStartedV1(RunStartedV1 {
            packet_hash: "sha256:aa".into(),
            git_head: "dead".into(),
            workspace_path: "/ws".into(),
            config: BTreeMap::new(),
            parent_run_id: None,
            parent_event_id: None,
        }))
        .unwrap(),
        serde_json::to_value(Payload::RunCompletedV1(RunCompletedV1 {
            outcome: RunOutcome::Passed,
            duration_ms: "0".into(),
            event_count: "0".into(),
            unit_count: "0".into(),
        }))
        .unwrap(),
        serde_json::to_value(Payload::RunFailedV1(RunFailedV1 {
            reason: "fixture".into(),
            terminating_event_id: None,
        }))
        .unwrap(),
        serde_json::to_value(Payload::ResultReadyV1(ResultReadyV1 {
            run_id: fixed_run_id().to_string(),
            admission_event_id: fixed_event_id(4).to_string(),
            acceptance_event_id: fixed_event_id(5).to_string(),
        }))
        .unwrap(),
        serde_json::to_value(Payload::RunAdmissionRecordedV1(RunAdmissionRecordedV1 {
            receipt_id: "receipt-fixture".into(),
            receipt_digest: "sha256:aa".into(),
            receipt_ref: Some("cas:sha256:aa".into()),
            idempotency_key: "run.admission:v0:fixture".into(),
            decision: RunAdmissionDecision::Pass,
            policy_profile_id: "reviewed-green".into(),
            requested_side_effects: vec!["fs.write:declared_scope".into()],
            allowed_side_effects: vec!["fs.write:declared_scope".into()],
            denied_side_effects: vec![],
            missing_evidence: vec![],
            unsafe_requests: vec![],
            evidence_inputs: vec![RunAdmissionEvidenceInputV1 {
                kind: "git.status".into(),
                reference: "evidence/git-status.txt".into(),
                digest: Some("sha256:bb".into()),
                required: true,
                status: "present".into(),
                reason: None,
            }],
            quarantine: false,
            will_execute_worker: true,
            authorized_next_step: "dispatch_after_admission_append".into(),
            decided_by: "buildplane.kernel.admission".into(),
            decided_at: "2026-05-24T22:41:16Z".into(),
        }))
        .unwrap(),
        serde_json::to_value(Payload::UnitStartedV1(UnitStartedV1 {
            unit_id: "u".into(),
            parent_unit_id: None,
            unit_kind: "command".into(),
            policy: json!({}),
        }))
        .unwrap(),
        serde_json::to_value(Payload::UnitCompletedV1(UnitCompletedV1 {
            unit_id: "u".into(),
            outcome: UnitOutcome::Passed,
            artifacts: vec![ArtifactRef {
                path: "out".into(),
                hash: "sha256:aa".into(),
                size_bytes: 0,
            }],
        }))
        .unwrap(),
        serde_json::to_value(Payload::UnitFailedV1(UnitFailedV1 {
            unit_id: "u".into(),
            reason: "fixture".into(),
            terminating_event_id: None,
        }))
        .unwrap(),
        serde_json::to_value(Payload::UnitCancelledV1(UnitCancelledV1 {
            unit_id: "u".into(),
            cause: CancelCause::Timeout,
        }))
        .unwrap(),
        serde_json::to_value(Payload::GitCheckpointV1(GitCheckpointV1 {
            boundary: CheckpointBoundary::PreUnit,
            reference: "refs/...".into(),
            commit_sha: "0".repeat(40),
            unit_id: "u".into(),
            git_status: GitStatus::Ok,
        }))
        .unwrap(),
        serde_json::to_value(Payload::ModelRequestV1(ModelRequestV1 {
            provider: "anthropic".into(),
            model: "claude-opus-4-7".into(),
            system: None,
            messages: vec![Message {
                role: "user".into(),
                content: "hi".into(),
            }],
            tools: vec![],
            sampling: SamplingParams {
                temperature: Some(0.0),
                top_p: None,
                max_tokens: Some(100),
            },
            headers: BTreeMap::new(),
        }))
        .unwrap(),
        serde_json::to_value(Payload::ModelResponseV1(ModelResponseV1 {
            content: Some("ok".into()),
            tool_calls: vec![],
            usage: Usage {
                input_tokens: 1,
                output_tokens: 1,
            },
            stop_reason: "end_turn".into(),
            latency_ms: 0,
        }))
        .unwrap(),
        serde_json::to_value(Payload::ToolRequestStoredV1(ToolRequestStoredV1 {
            tool_name: "shell".into(),
            arguments: json!({}),
            env: EnvRedaction {
                redacted: true,
                hash: "sha256:aa".into(),
                hint: "env_var".into(),
            },
            working_directory: "/".into(),
            unit_id: "u".into(),
        }))
        .unwrap(),
        serde_json::to_value(Payload::ToolResultV1(ToolResultV1 {
            tool_request_id: fixed_event_id(1),
            stdout: String::new(),
            stderr: String::new(),
            exit_code: Some(0),
            output: None,
            duration_ms: 0,
        }))
        .unwrap(),
        serde_json::to_value(Payload::WorkspaceReadV1(WorkspaceReadV1 {
            tool_request_id: fixed_event_id(2),
            path: "x".into(),
            content_hash: "sha256:aa".into(),
            size_bytes: 0,
        }))
        .unwrap(),
        serde_json::to_value(Payload::WorkspaceWriteV1(WorkspaceWriteV1 {
            tool_request_id: fixed_event_id(3),
            path: "x".into(),
            hash_before: None,
            after: PostWriteState::Captured {
                hash: "sha256:aa".into(),
                size_bytes: 0,
            },
        }))
        .unwrap(),
        serde_json::to_value(Payload::TapeCheckpointV1(TapeCheckpointV1 {
            run_id: fixed_run_id(),
            checkpoint_index: 0,
            through_event_id: fixed_event_id(4),
            through_event_count: 2,
            previous_checkpoint_event_id: None,
            tape_root_hash: "sha256:aa".into(),
            algorithm: TapeRootAlgorithm::Sha256Linear,
        }))
        .unwrap(),
        serde_json::to_value(Payload::PlanAdmittedV1(PlanAdmittedV1 {
            plan_id: "pf-plan-fixture".into(),
            plan_digest: "sha256:aa".into(),
            input_digest: "sha256:bb".into(),
            trusted_base: "deadbeef".into(),
            decided_by: "operator:fixture".into(),
            decided_at: "2026-05-30T00:00:00Z".into(),
            idempotency_key: "planforge:v0:buildplane:deadbeef:fixture".into(),
            authorized_next_step: "dispatch_admitted_plan".into(),
        }))
        .unwrap(),
        serde_json::to_value(Payload::PlanReceiptRecordedV1(PlanReceiptRecordedV1 {
            plan_id: "pf-plan-fixture".into(),
            admission_event_id: fixed_event_id(5),
            outcome: PlanReceiptOutcome::Completed,
            side_effects: vec!["fs.write:declared_scope".into()],
            result_digest: "sha256:cc".into(),
            decided_at: "2026-05-30T00:00:10Z".into(),
        }))
        .unwrap(),
        serde_json::to_value(Payload::ActivityStartedV1(ActivityStartedV1 {
            run_id: fixed_run_id(),
            activity_id: "act-1".into(),
            activity_type: ActivityType::Model,
            input_digest: "sha256:dd".into(),
        }))
        .unwrap(),
        serde_json::to_value(Payload::ActivityCompletedV1(ActivityCompletedV1 {
            run_id: fixed_run_id(),
            activity_id: "act-1".into(),
            result_digest: "sha256:ee".into(),
            result: json!({"content": "ok"}),
        }))
        .unwrap(),
        serde_json::to_value(Payload::CapabilityDeniedV1(CapabilityDeniedV1 {
            run_id: fixed_run_id().to_string(),
            bundle_digest: "sha256:ff".into(),
            tool: "write_file".into(),
            reason: "capability broker: outside fsWrite allowlist".into(),
            target: "docs/readme.md".into(),
        }))
        .unwrap(),
        serde_json::to_value(Payload::AcceptanceRecordedV1(AcceptanceRecordedV1 {
            plan_id: "pf-plan-fixture".into(),
            admission_event_id: fixed_event_id(5).to_string(),
            contract_digest: "sha256:gg".into(),
            outcome: "passed".into(),
            diff_scope_status: "passed".into(),
            out_of_scope_files: vec![],
            checks: vec![AcceptanceCheckResultV1 {
                command: "pnpm lint".into(),
                exit_code: "0".into(),
                status: "passed".into(),
            }],
            evaluated_at: "2026-06-19T12:00:00Z".into(),
        }))
        .unwrap(),
        serde_json::to_value(Payload::OperatorDecisionRecordedV1(
            OperatorDecisionRecordedV1 {
                run_id: fixed_run_id().to_string(),
                decision: "approved".into(),
                subject: "merge".into(),
                acceptance_event_id: Some(fixed_event_id(5).to_string()),
                admission_event_id: Some(fixed_event_id(4).to_string()),
                merge_commit: Some("deadbeef".into()),
                envelope: None,
                decided_by: "operator@buildplane".into(),
                decided_at: "2026-06-22T12:00:00Z".into(),
            },
        ))
        .unwrap(),
    ];
    out.extend(trust_spine_fixtures());
    out.extend(workflow_graph_fixtures());
    out.extend(graph_bound_dispatch_v4_fixtures());
    out.extend(activity_claim_fixtures());
    out.extend(action_evidence_v3_fixtures());
    out.extend(workflow_lifecycle_fixtures());

    let dest = std::env::args().nth(1).unwrap_or_else(|| {
        PathBuf::from("packages/ledger-client/fixtures/payload-variants.json")
            .to_string_lossy()
            .into_owned()
    });
    fs::create_dir_all(PathBuf::from(&dest).parent().unwrap()).unwrap();
    let mut content = serde_json::to_string_pretty(&out).unwrap();
    content.push('\n');
    fs::write(&dest, content).unwrap();
    eprintln!("wrote {}", dest);
}
