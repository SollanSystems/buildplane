import { describe, expect, it } from "vitest";
import {
	ActionEvidenceVersionV1,
	type ActionFailureV1,
	ActionKindV1,
	ActionReceiptOutcomeV2,
	type ActionReceiptRecordedV2,
	type ActionReceiptSetEntryV1,
	type ActionReceiptSetRecordedV1,
	type ActionRedactionV1,
	type ActionRequestedV2,
	type ActionResourceUsageV1,
	type ActivityClaimedV1,
	ActivityClaimPurposeV1,
	type ActivityHeartbeatRecordedV1,
	ActivityResultOutcomeV1,
	type ActivityResultRecordedV1,
	CandidateAcceptanceOutcomeV1,
	type CandidateAcceptanceRecordedV1,
	type CandidateCompletionRecordedV1,
	type CandidateCreatedV1,
	type CandidateCreatedV2,
	type CandidateViewV1,
	CommitModeV1,
	type DispatchEnvelopeBodyV2,
	type DispatchEnvelopeV1,
	type DispatchEnvelopeV2,
	type DispatchEnvelopeV3,
	type DispatchEnvelopeV4,
	EventKind,
	ExecutionRoleV1,
	type ModelActionAuthorizedV1,
	type PromotionApprovalRequestedV1,
	PromotionDecisionKindV1,
	type PromotionDecisionRecordedV1,
	type PromotionExecutionClaimedV1,
	type PromotionExecutionLeaseBindingV1,
	type PromotionReconciliationResolvedV1,
	PromotionResultOutcomeV1,
	type PromotionResultRecordedV1,
	PromotionWorktreeSyncStateV1,
	ReconciliationResolutionOutcomeV1,
	ReleaseEvaluationClaimKindV1,
	type ReleaseEvaluationEvidenceV1,
	ReleaseEvaluationGovernanceV1,
	ReviewDecisionV1,
	type ReviewVerdictRecordedV1,
	type ReviewVerdictRecordedV2,
	TrustTierV1,
	WorkflowCancellationCauseV1,
	type WorkflowCancellationRequestedV1,
	type WorkflowGraphDeclaredV2,
	WorkflowTerminalOutcomeV1,
	type WorkflowTerminalV1,
	type WorkflowTerminalV2,
	type WorkflowTimerFiredV1,
	WorkflowTimerKindV1,
	type WorkflowTimerScheduledV1,
} from "../src/generated/index.js";
import type { Payload } from "../src/payload.js";
import {
	ACTION_RESOURCE_USAGE_MAX_SAFE_INTEGER,
	assertActionReceiptRecordedV2SafeIntegerResources,
	assertActionResourceUsageV1SafeIntegers,
} from "../src/payload.js";

const digest = `sha256:${"a".repeat(64)}`;

describe("trust-spine ledger payloads", () => {
	it("keeps every additive trust-spine event assignable to the externally-tagged Payload union", () => {
		const dispatch: DispatchEnvelopeV1 = {
			workflow_id: "workflow-1",
			workflow_revision: "r1",
			unit_id: "unit-1",
			attempt: 1,
			execution_role: ExecutionRoleV1.Implementer,
			commit_mode: CommitModeV1.Atomic,
			provenance_ref: "admission:1",
			base_commit_sha: "1".repeat(40),
			capability_bundle_digest: digest,
			acceptance_contract_digest: digest,
			context_manifest_digest: digest,
			worker_manifest_digest: digest,
			sandbox_profile_digest: digest,
			budget: { max_tokens: 100, max_compute_time_ms: 1_000 },
			trust_tier: TrustTierV1.Governed,
			idempotency_key: "dispatch:1",
			issued_at: "2026-07-17T00:00:00Z",
			expires_at: "2026-07-17T01:00:00Z",
			envelope_digest: digest,
			signature_ref: {
				algorithm: "ed25519",
				key_id: "kernel-1",
				signature: "fixture",
			},
		};
		const candidate: CandidateCreatedV1 = {
			candidate_id: "candidate-1",
			candidate_ref: "refs/buildplane/candidates/candidate-1/run-1/1",
			workflow_id: "workflow-1",
			unit_id: "unit-1",
			attempt: 1,
			provenance_ref: "admission:1",
			candidate_digest: digest,
			base_commit_sha: "1".repeat(40),
			candidate_commit_sha: "2".repeat(40),
			commit_digest: digest,
			tree_digest: digest,
			patch_digest: digest,
			changed_files_digest: digest,
			envelope_digest: digest,
			action_receipt_digest: digest,
		};
		const dispatchV2Body: DispatchEnvelopeBodyV2 = {
			workflow_id: "workflow-2",
			workflow_revision: "r1",
			unit_id: "unit-2",
			attempt: 1,
			execution_role: ExecutionRoleV1.Implementer,
			commit_mode: CommitModeV1.Atomic,
			provenance_ref: "admission:2",
			base_commit_sha: "1".repeat(40),
			capability_bundle_digest: digest,
			acceptance_contract_digest: digest,
			context_manifest_digest: digest,
			worker_manifest_digest: digest,
			sandbox_profile_digest: digest,
			budget: { max_tokens: 100, max_compute_time_ms: 1_000 },
			trust_tier: TrustTierV1.Governed,
			idempotency_key: "dispatch:2",
			issued_at: "2026-07-17T00:00:00Z",
			expires_at: "2026-07-17T01:00:00Z",
		};
		const dispatchV2: DispatchEnvelopeV2 = {
			body: dispatchV2Body,
			envelope_digest: digest,
		};
		const acceptance: CandidateAcceptanceRecordedV1 = {
			candidate_digest: digest,
			candidate_commit_sha: "2".repeat(40),
			acceptance_ref: "acceptance:1",
			acceptance_contract_digest: digest,
			acceptance_digest: digest,
			outcome: CandidateAcceptanceOutcomeV1.Passed,
			evaluated_at: "2026-07-17T00:01:00Z",
		};
		const review: ReviewVerdictRecordedV1 = {
			candidate_digest: digest,
			candidate_commit_sha: "2".repeat(40),
			review_ref: "review:1",
			decision: ReviewDecisionV1.Approve,
			findings: [],
			confidence: 0.99,
			reviewer_manifest_digest: digest,
			reviewed_at: "2026-07-17T00:02:00Z",
		};
		const candidateView: CandidateViewV1 = {
			candidate_ref: candidate.candidate_ref,
			candidate_digest: candidate.candidate_digest,
			candidate_commit_sha: candidate.candidate_commit_sha,
			tree_digest: candidate.tree_digest,
			reviewer_context_manifest_digest: digest,
			reviewer_sandbox_profile_digest: digest,
			mount_path_digest: digest,
			read_only: true,
			network_disabled: true,
		};
		const reviewV2: ReviewVerdictRecordedV2 = {
			run_id: "run-1",
			workflow_id: candidate.workflow_id,
			unit_id: candidate.unit_id,
			attempt: candidate.attempt,
			provenance_ref: candidate.provenance_ref,
			candidate_digest: candidate.candidate_digest,
			candidate_commit_sha: candidate.candidate_commit_sha,
			review_ref: "review-v2:1",
			review_verdict_action_id: "review-action:1",
			review_action_request_digest: digest,
			review_action_receipt_ref: "receipt:review-action:1",
			review_action_receipt_digest: digest,
			review_output_ref: `cas:${digest}`,
			review_output_digest: digest,
			decision: ReviewDecisionV1.Approve,
			findings: [],
			confidence: 0.99,
			acceptance_ref: acceptance.acceptance_ref,
			acceptance_digest: acceptance.acceptance_digest,
			acceptance_contract_digest: acceptance.acceptance_contract_digest,
			candidate_envelope_digest: candidate.envelope_digest,
			reviewer_workflow_id: "workflow-1",
			reviewer_dispatch_envelope_digest: digest,
			reviewer_unit_id: "review-unit-1",
			reviewer_attempt: 1,
			reviewer_execution_role: ExecutionRoleV1.Reviewer,
			review_action_receipt_set_ref: "receipt-set:review:1",
			review_action_receipt_set_digest: digest,
			candidate_view: candidateView,
			candidate_view_ref: "candidate-view:1",
			candidate_view_digest: digest,
			reviewer_manifest_digest: digest,
			reviewer_authority: "reviewer",
			reviewed_at: "2026-07-17T00:02:00Z",
		};
		const decision: PromotionDecisionRecordedV1 = {
			candidate_digest: digest,
			base_commit_sha: "1".repeat(40),
			target_ref: "refs/heads/main",
			envelope_digest: digest,
			acceptance_ref: "acceptance:1",
			review_refs: ["review:1"],
			decision: PromotionDecisionKindV1.Promote,
			authority: "operator",
			decided_by: "operator",
			decided_at: "2026-07-17T00:03:00Z",
			idempotency_key: "promotion:1",
		};
		const approvalRequest: PromotionApprovalRequestedV1 = {
			candidate_digest: digest,
			base_commit_sha: "1".repeat(40),
			target_ref: "refs/heads/main",
			envelope_digest: digest,
			acceptance_ref: "acceptance:1",
			review_refs: ["review:1"],
			requested_by: "kernel",
			requested_at: "2026-07-17T00:02:30Z",
			idempotency_key: "promotion:1",
		};
		const result: PromotionResultRecordedV1 = {
			candidate_digest: digest,
			idempotency_key: "promotion:1",
			promotion_decision_ref: "decision:1",
			outcome: PromotionResultOutcomeV1.Promoted,
			merged_head_sha: "3".repeat(40),
			promotion_git_binding: {
				target_ref: "refs/heads/main",
				target_head_before_sha: "1".repeat(40),
				target_head_after_sha: "3".repeat(40),
				merged_head_sha: "3".repeat(40),
				candidate_commit_sha: "2".repeat(40),
				merge_parent_shas: ["1".repeat(40), "2".repeat(40)],
				merged_tree_sha: "4".repeat(40),
				merged_tree_digest: digest,
				promotion_receipt_ref: "refs/buildplane/promotions/candidate-1/run-1/1",
				worktree_sync_state: PromotionWorktreeSyncStateV1.PendingReconciliation,
			},
			completed_at: "2026-07-17T00:04:00Z",
		};
		const reconciliation: PromotionReconciliationResolvedV1 = {
			candidate_digest: digest,
			promotion_decision_ref: "decision:1",
			promotion_result_ref: "result:1",
			promotion_receipt_ref: "refs/buildplane/promotions/candidate-1/run-1/1",
			outcome: ReconciliationResolutionOutcomeV1.Abandon,
			authority: "operator",
			resolved_by: "operator",
			idempotency_key: "promotion-reconciliation:1",
			resolved_at: "2026-07-17T00:04:30Z",
		};
		const releaseEvaluation: ReleaseEvaluationEvidenceV1 = {
			schema_version: 1,
			release_commit: "a".repeat(40),
			release_ref: "refs/heads/main",
			policy_digest: digest,
			claim_kind: ReleaseEvaluationClaimKindV1.Trial,
			claim: {
				task_id: "task-1",
				provider: "openai",
				trust_tier: "governed",
				trial: 1,
				governance: ReleaseEvaluationGovernanceV1.Governed,
				passed: true,
				cost_usd_micros: 125_000,
				latency_ms: 100,
				tokens: 10,
				tool_calls: 1,
				candidate_count: 1,
				reviewer_disagreed: false,
				false_approval: false,
				unauthorized_effects: 0,
				duplicate_effects: 0,
				safety_violations: 0,
				recovery_correct: true,
				illegitimate_success: false,
				sources: {
					model_request: {
						source_event_id: "01919000-0000-7000-8000-000000000001",
						source_canonical_event_hash: digest,
					},
					candidate: {
						source_event_id: "01919000-0000-7000-8000-000000000002",
						source_canonical_event_hash: digest,
					},
					acceptance: {
						source_event_id: "01919000-0000-7000-8000-000000000003",
						source_canonical_event_hash: digest,
					},
					review: {
						source_event_id: "01919000-0000-7000-8000-000000000004",
						source_canonical_event_hash: digest,
					},
					recovery: {
						source_event_id: "01919000-0000-7000-8000-000000000005",
						source_canonical_event_hash: digest,
					},
					terminal: {
						source_event_id: "01919000-0000-7000-8000-000000000006",
						source_canonical_event_hash: digest,
					},
				},
			},
			claim_digest: digest,
		};
		const terminal: WorkflowTerminalV1 = {
			workflow_id: "workflow-1",
			workflow_revision: "r1",
			unit_id: "unit-1",
			attempt: 1,
			outcome: WorkflowTerminalOutcomeV1.Completed,
			candidate_digest: digest,
			promotion_result_ref: "result:1",
			reconciliation_resolution_ref: "reconciliation:1",
			idempotency_key: "workflow-terminal:1",
			completed_at: "2026-07-17T00:05:00Z",
		};

		const payloads: readonly Payload[] = [
			{ DispatchEnvelopeV1: dispatch },
			{ DispatchEnvelopeV2: dispatchV2 },
			{ CandidateCreatedV1: candidate },
			{ CandidateAcceptanceRecordedV1: acceptance },
			{ ReviewVerdictRecordedV1: review },
			{ ReviewVerdictRecordedV2: reviewV2 },
			{ PromotionApprovalRequestedV1: approvalRequest },
			{ PromotionDecisionRecordedV1: decision },
			{ PromotionResultRecordedV1: result },
			{ PromotionReconciliationResolvedV1: reconciliation },
			{ ReleaseEvaluationEvidenceV1: releaseEvaluation },
			{ WorkflowTerminalV1: terminal },
		];

		expect(payloads).toHaveLength(12);
		expect(EventKind.DispatchEnvelope).toBe("dispatch_envelope");
		expect(EventKind.DispatchEnvelopeV2).toBe("dispatch_envelope_v2");
		expect(EventKind.ReviewVerdictRecordedV2).toBe(
			"review_verdict_recorded_v2",
		);
		expect(EventKind.PromotionApprovalRequested).toBe(
			"promotion_approval_requested",
		);
		expect(EventKind.ReleaseEvaluationEvidenceV1).toBe(
			"release_evaluation_evidence_v1",
		);
		expect(EventKind.WorkflowTerminal).toBe("workflow_terminal");
	});
	it("keeps sealed V3 action evidence closed and assignable to the externally-tagged Payload union", () => {
		const body: DispatchEnvelopeBodyV2 = {
			workflow_id: "workflow-v3",
			workflow_revision: "r2",
			unit_id: "unit-v3",
			attempt: 2,
			execution_role: ExecutionRoleV1.Implementer,
			commit_mode: CommitModeV1.Atomic,
			provenance_ref: "admission:v3",
			base_commit_sha: "1".repeat(40),
			capability_bundle_digest: digest,
			acceptance_contract_digest: digest,
			context_manifest_digest: digest,
			worker_manifest_digest: digest,
			sandbox_profile_digest: digest,
			budget: { max_tokens: 100, max_compute_time_ms: 1_000 },
			trust_tier: TrustTierV1.Governed,
			idempotency_key: "dispatch:v3",
			issued_at: "2026-07-18T00:00:00Z",
			expires_at: "2026-07-18T01:00:00Z",
		};
		const dispatch: DispatchEnvelopeV3 = {
			body,
			action_evidence_version: ActionEvidenceVersionV1.SealedV2,
			repository_binding_digest: digest,
			ledger_authority_realm_digest: digest,
			envelope_digest: digest,
		};
		const request: ActionRequestedV2 = {
			run_id: "run-v3",
			workflow_id: body.workflow_id,
			unit_id: body.unit_id,
			attempt: body.attempt,
			provenance_ref: body.provenance_ref,
			action_id: "action-v3",
			idempotency_key: "action:v3",
			action_kind: ActionKindV1.Model,
			canonical_input_digest: digest,
			canonical_input_ref: "cas:input:v3",
			dispatch_envelope_digest: dispatch.envelope_digest,
			repository_binding_digest: dispatch.repository_binding_digest,
			ledger_authority_realm_digest: dispatch.ledger_authority_realm_digest,
			capability_bundle_digest: body.capability_bundle_digest,
			policy_digest: digest,
			context_manifest_digest: body.context_manifest_digest,
			worker_manifest_digest: body.worker_manifest_digest,
			sandbox_profile_digest: body.sandbox_profile_digest,
			authority_actor: "kernel",
			execution_role: body.execution_role,
			requested_at: "2026-07-18T00:00:01Z",
		};
		const authorization: ModelActionAuthorizedV1 = {
			run_id: request.run_id,
			workflow_id: request.workflow_id,
			unit_id: request.unit_id,
			attempt: request.attempt,
			provenance_ref: request.provenance_ref,
			action_id: request.action_id,
			idempotency_key: request.idempotency_key,
			dispatch_event_ref: "event:dispatch:v3",
			dispatch_envelope_digest: request.dispatch_envelope_digest,
			action_request_ref: "event:action-request:v3",
			action_request_digest: digest,
			packet_digest: digest,
			canonical_input_digest: request.canonical_input_digest,
			model_request_digest: digest,
			trust_scope_digest: digest,
			context_manifest_digest: request.context_manifest_digest,
			policy_digest: request.policy_digest,
			sandbox_profile_digest: request.sandbox_profile_digest,
			execution_role: request.execution_role,
			authorization_actor: "kernel",
			expires_at: "2026-07-18T00:30:00Z",
			authorization_ref: "authorization:model:v3",
			authorization_digest: digest,
		};
		const redaction: ActionRedactionV1 = {
			field: "stdout",
			reason: "secret",
			redacted_digest: digest,
		};
		const failure: ActionFailureV1 = {
			code: "policy_denied",
			message_digest: digest,
			retryable: false,
		};
		const resourceUsage: ActionResourceUsageV1 = {
			wall_time_ms: 100,
			cpu_time_ms: 80,
			peak_memory_bytes: 1_024,
			input_bytes: 512,
			output_bytes: 256,
			input_tokens: 8,
			output_tokens: 13,
		};
		const receipt: ActionReceiptRecordedV2 = {
			run_id: request.run_id,
			workflow_id: request.workflow_id,
			unit_id: request.unit_id,
			attempt: request.attempt,
			provenance_ref: request.provenance_ref,
			action_id: request.action_id,
			idempotency_key: request.idempotency_key,
			action_request_digest: digest,
			dispatch_envelope_digest: request.dispatch_envelope_digest,
			capability_bundle_digest: request.capability_bundle_digest,
			policy_digest: request.policy_digest,
			context_manifest_digest: request.context_manifest_digest,
			worker_manifest_digest: request.worker_manifest_digest,
			sandbox_profile_digest: request.sandbox_profile_digest,
			authority_actor: request.authority_actor,
			execution_role: request.execution_role,
			outcome: ActionReceiptOutcomeV2.Denied,
			result_digest: digest,
			result_ref: "cas:result:v3",
			evidence_digest: digest,
			evidence_ref: "cas:evidence:v3",
			resource_usage: resourceUsage,
			redactions: [redaction],
			failure,
			authorization_ref: authorization.authorization_ref,
			action_receipt_ref: "receipt:v3",
			completed_at: "2026-07-18T00:00:02Z",
		};
		const receiptEntry: ActionReceiptSetEntryV1 = {
			action_id: receipt.action_id,
			action_receipt_ref: receipt.action_receipt_ref,
			action_receipt_digest: digest,
		};
		const receiptSet: ActionReceiptSetRecordedV1 = {
			run_id: request.run_id,
			workflow_id: request.workflow_id,
			unit_id: request.unit_id,
			attempt: request.attempt,
			provenance_ref: request.provenance_ref,
			dispatch_envelope_digest: request.dispatch_envelope_digest,
			action_receipt_set_ref: "receipt-set:v3",
			action_receipt_set_digest: digest,
			receipts: [receiptEntry],
			sealed_at: "2026-07-18T00:00:03Z",
		};
		const candidate: CandidateCreatedV2 = {
			run_id: request.run_id,
			candidate_id: "candidate-v3",
			candidate_ref: "refs/buildplane/candidates/candidate-v3/run-v3/2",
			workflow_id: request.workflow_id,
			unit_id: request.unit_id,
			attempt: request.attempt,
			provenance_ref: request.provenance_ref,
			candidate_digest: digest,
			base_commit_sha: "1".repeat(40),
			candidate_commit_sha: "2".repeat(40),
			commit_digest: digest,
			tree_digest: digest,
			patch_digest: digest,
			changed_files_digest: digest,
			envelope_digest: dispatch.envelope_digest,
			action_receipt_set_ref: receiptSet.action_receipt_set_ref,
			action_receipt_set_digest: receiptSet.action_receipt_set_digest,
		};
		const completion: CandidateCompletionRecordedV1 = {
			run_id: candidate.run_id,
			workflow_id: candidate.workflow_id,
			unit_id: candidate.unit_id,
			attempt: candidate.attempt,
			provenance_ref: candidate.provenance_ref,
			candidate_created_event_ref: "01919000-0000-7000-8000-000000000046",
			candidate_digest: candidate.candidate_digest,
			candidate_create_action_id: request.action_id,
			action_request_ref: "01919000-0000-7000-8000-000000000041",
			action_request_digest: receipt.action_request_digest,
			activity_claim_event_ref: "01919000-0000-7000-8000-000000000047",
			activity_claim_event_digest: digest,
			activity_result_event_ref: "01919000-0000-7000-8000-000000000048",
			activity_result_event_digest: digest,
			action_receipt_ref: receipt.action_receipt_ref,
			action_receipt_digest: digest,
			completion_digest: digest,
			completed_at: "2026-07-18T00:00:04Z",
		};

		const payloads: readonly Payload[] = [
			{ DispatchEnvelopeV3: dispatch },
			{ ActionRequestedV2: request },
			{ ModelActionAuthorizedV1: authorization },
			{ ActionReceiptRecordedV2: receipt },
			{ ActionReceiptSetRecordedV1: receiptSet },
			{ CandidateCreatedV2: candidate },
			{ CandidateCompletionRecordedV1: completion },
		];

		expect(payloads).toHaveLength(7);
		expect(Object.values(ActionEvidenceVersionV1)).toEqual([
			"sealed-v2",
			"sealed_v3",
		]);
		expect(Object.values(ActionKindV1)).toEqual([
			"filesystem",
			"process",
			"git",
			"model",
			"network",
			"secret",
			"mcp",
			"a2a",
			"external_service",
		]);
		expect(Object.values(ActionReceiptOutcomeV2)).toEqual([
			"succeeded",
			"failed",
			"denied",
			"unknown",
		]);
		expect(EventKind.DispatchEnvelopeV3).toBe("dispatch_envelope_v3");
		expect(EventKind.ActionRequestedV2).toBe("action_requested_v2");
		expect(EventKind.ModelActionAuthorizedV1).toBe(
			"model_action_authorized_v1",
		);
		expect(EventKind.ActionReceiptRecordedV2).toBe(
			"action_receipt_recorded_v2",
		);
		expect(EventKind.ActionReceiptSetRecordedV1).toBe(
			"action_receipt_set_recorded_v1",
		);
		expect(EventKind.CandidateCreatedV2).toBe("candidate_created_v2");
		expect(EventKind.CandidateCompletionRecordedV1).toBe(
			"candidate_completion_recorded_v1",
		);
	});

	it("keeps graph-bound V4 dispatches and V2 workflow declarations assignable with their native snake_case shape", () => {
		const graph: WorkflowGraphDeclaredV2 = {
			run_id: "run-v4",
			workflow_id: "workflow-v4",
			workflow_revision: "r1",
			nodes: [
				{
					unit_id: "unit-a",
					depends_on: [],
					execution_role: ExecutionRoleV1.Implementer,
					governed_packet_digest: digest,
				},
			],
			max_concurrent: 1,
			graph_digest: digest,
			idempotency_key: "graph-v2:workflow-v4:r1",
			declared_at: "2026-07-19T00:00:00Z",
		};
		const dispatchV3: DispatchEnvelopeV3 = {
			body: {
				workflow_id: graph.workflow_id,
				workflow_revision: graph.workflow_revision,
				unit_id: "unit-a",
				attempt: 1,
				execution_role: ExecutionRoleV1.Implementer,
				commit_mode: CommitModeV1.Atomic,
				provenance_ref: "admission:workflow-v4",
				base_commit_sha: "1".repeat(40),
				capability_bundle_digest: digest,
				acceptance_contract_digest: digest,
				context_manifest_digest: digest,
				worker_manifest_digest: digest,
				sandbox_profile_digest: digest,
				budget: { max_tokens: 100, max_compute_time_ms: 1_000 },
				trust_tier: TrustTierV1.Governed,
				idempotency_key: "dispatch:workflow-v4:unit-a:1",
				issued_at: "2026-07-19T00:01:00Z",
				expires_at: "2026-07-19T01:01:00Z",
			},
			action_evidence_version: ActionEvidenceVersionV1.SealedV3,
			repository_binding_digest: digest,
			ledger_authority_realm_digest: digest,
			governed_packet_digest: digest,
			envelope_digest: digest,
		};
		const dispatchV4: DispatchEnvelopeV4 = {
			dispatch_v3: dispatchV3,
			workflow_graph_digest: graph.graph_digest,
			workflow_graph_declaration_event_ref:
				"01919000-0000-7000-8000-0000000000f4",
			envelope_digest: digest,
		};
		const payloads: readonly Payload[] = [
			{ WorkflowGraphDeclaredV2: graph },
			{ DispatchEnvelopeV4: dispatchV4 },
		];

		expect(payloads).toHaveLength(2);
		expect(EventKind.WorkflowGraphDeclaredV2).toBe(
			"workflow_graph_declared_v2",
		);
		expect(EventKind.DispatchEnvelopeV4).toBe("dispatch_envelope_v4");
	});

	it("keeps durable activity claims, heartbeats, and terminal reconciliations in the externally-tagged Payload union", () => {
		const claim: ActivityClaimedV1 = {
			run_id: "01919000-0000-7000-8000-0000000000ff",
			activity_id: "activity-claim-1",
			idempotency_key: "activity:claim:1",
			action_kind: ActionKindV1.Process,
			action_request_event_id: "01919000-0000-7000-8000-000000000090",
			action_request_digest: digest,
			dispatch_event_id: "01919000-0000-7000-8000-000000000091",
			dispatch_envelope_digest: digest,
			authority_actor: "kernel",
			lease_id: "lease:activity-claim-1",
			lease_expires_at: "2026-07-18T00:01:00Z",
			claimed_at: "2026-07-18T00:00:00Z",
		};
		const result: ActivityResultRecordedV1 = {
			run_id: claim.run_id,
			activity_id: claim.activity_id,
			idempotency_key: claim.idempotency_key,
			claim_event_id: "01919000-0000-7000-8000-000000000092",
			claim_event_digest: digest,
			lease_id: claim.lease_id,
			outcome: ActivityResultOutcomeV1.Unknown,
			evidence_digest: digest,
			evidence_ref: "cas:evidence:activity-claim-1",
			recorded_at: "2026-07-18T00:02:00Z",
		};
		const heartbeat: ActivityHeartbeatRecordedV1 = {
			run_id: claim.run_id,
			activity_id: claim.activity_id,
			idempotency_key: claim.idempotency_key,
			heartbeat_id: "heartbeat:activity-claim-1",
			heartbeat_request_digest: digest,
			claim_event_id: "01919000-0000-7000-8000-000000000092",
			claim_event_digest: digest,
			lease_id: claim.lease_id,
			dispatch_event_id: claim.dispatch_event_id,
			dispatch_envelope_digest: claim.dispatch_envelope_digest,
			heartbeat_at: "2026-07-18T00:00:30Z",
			lease_expires_at: "2026-07-18T00:02:00Z",
		};

		const payloads: readonly Payload[] = [
			{ ActivityClaimedV1: claim },
			{ ActivityHeartbeatRecordedV1: heartbeat },
			{ ActivityResultRecordedV1: result },
		];

		expect(payloads).toHaveLength(3);
		expect(Object.values(ActivityResultOutcomeV1)).toEqual([
			"succeeded",
			"failed",
			"unknown",
		]);
		expect(Object.values(ActivityClaimPurposeV1)).toEqual([
			"generic",
			"governed_verifier_v1",
			"governed_model_action_v1",
		]);
		expect(EventKind.ActivityClaimedV1).toBe("activity_claimed_v1");
		expect(EventKind.ActivityHeartbeatRecordedV1).toBe(
			"activity_heartbeat_recorded_v1",
		);
		expect(EventKind.ActivityResultRecordedV1).toBe(
			"activity_result_recorded_v1",
		);
		expect(result).not.toHaveProperty("result_digest");
		expect(result).not.toHaveProperty("result_ref");
		expect(heartbeat.heartbeat_request_digest).toBe(digest);
	});

	it("keeps a promotion execution claim as tape evidence while preserving legacy promotion results", () => {
		const claim: PromotionExecutionClaimedV1 = {
			run_id: "01919000-0000-7000-8000-0000000000f1",
			promotion_decision_event_ref: "01919000-0000-7000-8000-0000000000f2",
			promotion_decision_event_digest: digest,
			dispatch_event_ref: "01919000-0000-7000-8000-0000000000f3",
			dispatch_envelope_digest: digest,
			candidate_digest: digest,
			candidate_ref: "refs/buildplane/candidates/candidate-1/run-1/1",
			candidate_commit_sha: "2".repeat(40),
			candidate_tree_digest: digest,
			base_commit_sha: "1".repeat(40),
			target_ref: "refs/heads/main",
			idempotency_key: "promotion:claim:1",
			authority_actor: "kernel",
			lease_id: "opaque-promotion-lease",
			claimed_at: "2026-07-20T00:00:00Z",
			lease_expires_at: "2026-07-20T00:01:00Z",
			promotion_execution_claim_digest: digest,
		};
		const binding: PromotionExecutionLeaseBindingV1 = {
			promotion_execution_claim_event_ref:
				"01919000-0000-7000-8000-0000000000f4",
			promotion_execution_claim_event_digest: digest,
			lease_id: claim.lease_id,
		};
		const legacyResult: PromotionResultRecordedV1 = {
			candidate_digest: claim.candidate_digest,
			idempotency_key: claim.idempotency_key,
			promotion_decision_ref: claim.promotion_decision_event_ref,
			outcome: PromotionResultOutcomeV1.Rejected,
			completed_at: "2026-07-20T00:00:02Z",
		};
		const boundResult: PromotionResultRecordedV1 = {
			...legacyResult,
			promotion_execution_lease_binding: binding,
		};

		const payloads: readonly Payload[] = [
			{ PromotionExecutionClaimedV1: claim },
			{ PromotionResultRecordedV1: legacyResult },
			{ PromotionResultRecordedV1: boundResult },
		];

		expect(payloads).toHaveLength(3);
		expect(EventKind.PromotionExecutionClaimedV1).toBe(
			"promotion_execution_claimed_v1",
		);
		expect(legacyResult).not.toHaveProperty(
			"promotion_execution_lease_binding",
		);
		expect(boundResult.promotion_execution_lease_binding).toEqual(binding);
	});

	it("keeps reducer-owned workflow lifecycle records in the externally-tagged Payload union", () => {
		const runId = "01919000-0000-7000-8000-0000000000ff";
		const dispatchEventRef = "01919000-0000-7000-8000-0000000000a1";
		const scheduleEventRef = "01919000-0000-7000-8000-0000000000a2";
		const firedEventRef = "01919000-0000-7000-8000-0000000000a3";
		const cancellationEventRef = "01919000-0000-7000-8000-0000000000a4";
		const schedule: WorkflowTimerScheduledV1 = {
			run_id: runId,
			workflow_id: "workflow-lifecycle-1",
			workflow_revision: "r1",
			unit_id: "unit-lifecycle-1",
			attempt: 1,
			dispatch_event_ref: dispatchEventRef,
			dispatch_envelope_digest: digest,
			timer_id: "deadline:workflow-lifecycle-1:1",
			timer_kind: WorkflowTimerKindV1.WorkflowDeadline,
			due_at: "2026-07-19T00:10:00Z",
			idempotency_key: "timer:workflow-lifecycle-1:1",
			scheduled_by: "kernel",
			scheduled_at: "2026-07-19T00:00:00Z",
		};
		const fired: WorkflowTimerFiredV1 = {
			run_id: schedule.run_id,
			workflow_id: schedule.workflow_id,
			workflow_revision: schedule.workflow_revision,
			unit_id: schedule.unit_id,
			attempt: schedule.attempt,
			timer_id: schedule.timer_id,
			timer_schedule_event_ref: scheduleEventRef,
			timer_schedule_event_digest: digest,
			dispatch_event_ref: schedule.dispatch_event_ref,
			dispatch_envelope_digest: schedule.dispatch_envelope_digest,
			idempotency_key: schedule.idempotency_key,
			fired_by: "kernel",
			fired_at: schedule.due_at,
		};
		const cancellation: WorkflowCancellationRequestedV1 = {
			run_id: schedule.run_id,
			workflow_id: schedule.workflow_id,
			workflow_revision: schedule.workflow_revision,
			unit_id: schedule.unit_id,
			attempt: schedule.attempt,
			dispatch_event_ref: schedule.dispatch_event_ref,
			dispatch_envelope_digest: schedule.dispatch_envelope_digest,
			cancellation_id: "cancel:workflow-lifecycle-1:1",
			cause: WorkflowCancellationCauseV1.TimerElapsed,
			timer_fired_event_ref: firedEventRef,
			timer_fired_event_digest: digest,
			requested_by: "kernel",
			idempotency_key: "cancel:workflow-lifecycle-1:1",
			requested_at: fired.fired_at,
		};
		const terminal: WorkflowTerminalV2 = {
			workflow_id: schedule.workflow_id,
			workflow_revision: schedule.workflow_revision,
			unit_id: schedule.unit_id,
			attempt: schedule.attempt,
			outcome: WorkflowTerminalOutcomeV1.Cancelled,
			cancellation_request_event_ref: cancellationEventRef,
			cancellation_request_event_digest: digest,
			idempotency_key: "terminal:workflow-lifecycle-1:1",
			completed_at: "2026-07-19T00:10:01Z",
		};

		const payloads: readonly Payload[] = [
			{ WorkflowTimerScheduledV1: schedule },
			{ WorkflowTimerFiredV1: fired },
			{ WorkflowCancellationRequestedV1: cancellation },
			{ WorkflowTerminalV2: terminal },
		];

		expect(payloads).toHaveLength(4);
		expect(Object.values(WorkflowTimerKindV1)).toEqual(["workflow_deadline"]);
		expect(Object.values(WorkflowCancellationCauseV1)).toEqual([
			"operator_requested",
			"timer_elapsed",
		]);
		expect(EventKind.WorkflowTimerScheduledV1).toBe(
			"workflow_timer_scheduled_v1",
		);
		expect(EventKind.WorkflowTimerFiredV1).toBe("workflow_timer_fired_v1");
		expect(EventKind.WorkflowCancellationRequestedV1).toBe(
			"workflow_cancellation_requested_v1",
		);
		expect(EventKind.WorkflowTerminalV2).toBe("workflow_terminal_v2");
	});

	it("fails closed on resource values outside JavaScript's exact-number range", () => {
		const safeResourceUsage: ActionResourceUsageV1 = {
			wall_time_ms: ACTION_RESOURCE_USAGE_MAX_SAFE_INTEGER,
			cpu_time_ms: ACTION_RESOURCE_USAGE_MAX_SAFE_INTEGER,
			peak_memory_bytes: ACTION_RESOURCE_USAGE_MAX_SAFE_INTEGER,
			input_bytes: ACTION_RESOURCE_USAGE_MAX_SAFE_INTEGER,
			output_bytes: ACTION_RESOURCE_USAGE_MAX_SAFE_INTEGER,
			input_tokens: ACTION_RESOURCE_USAGE_MAX_SAFE_INTEGER,
			output_tokens: ACTION_RESOURCE_USAGE_MAX_SAFE_INTEGER,
		};
		expect(() =>
			assertActionResourceUsageV1SafeIntegers(safeResourceUsage),
		).not.toThrow();

		expect(() =>
			assertActionReceiptRecordedV2SafeIntegerResources({
				resource_usage: {
					...safeResourceUsage,
					input_bytes: ACTION_RESOURCE_USAGE_MAX_SAFE_INTEGER + 1,
				},
			}),
		).toThrow(/input_bytes/);
		expect(() =>
			assertActionReceiptRecordedV2SafeIntegerResources({
				resource_usage: {
					...safeResourceUsage,
					output_tokens: ACTION_RESOURCE_USAGE_MAX_SAFE_INTEGER + 1,
				},
			}),
		).toThrow(/output_tokens/);
		expect(() =>
			assertActionReceiptRecordedV2SafeIntegerResources({
				resource_usage: {
					wall_time_ms: ACTION_RESOURCE_USAGE_MAX_SAFE_INTEGER,
					cpu_time_ms: null,
				},
			}),
		).not.toThrow();
		expect(() =>
			assertActionReceiptRecordedV2SafeIntegerResources({
				ActionReceiptRecordedV2: {
					resource_usage: {
						...safeResourceUsage,
						wall_time_ms: ACTION_RESOURCE_USAGE_MAX_SAFE_INTEGER + 1,
					},
				},
			}),
		).toThrow(/wall_time_ms/);
		expect(() =>
			assertActionReceiptRecordedV2SafeIntegerResources({
				resource_usage: safeResourceUsage,
				authorization_ref: "   ",
			}),
		).toThrow(/authorization_ref/);
	});
});
