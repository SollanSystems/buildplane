// Hand-written TypeScript for `Payload` — the Rust type uses serde's default
// external tag format ({ "VariantName": { ...fields } }) which typeshare cannot
// express. Phase B may introduce a wrapper type; for now this mirrors the wire
// format exactly.
//
// See: native/crates/bp-ledger/src/payload/mod.rs

import type {
	AcceptanceRecordedV1,
	ActionReceiptRecordedV2,
	ActionReceiptSetRecordedV1,
	ActionRequestedV2,
	ActionResourceUsageV1,
	ActivityClaimedV1,
	ActivityCompletedV1,
	ActivityHeartbeatRecordedV1,
	ActivityResultRecordedV1,
	ActivityStartedV1,
	AttemptContextRecordedV1,
	CandidateAcceptanceRecordedV1,
	CandidateCompletionRecordedV1,
	CandidateCreatedV1,
	CandidateCreatedV2,
	CapabilityDeniedV1,
	DispatchEnvelopeV1,
	DispatchEnvelopeV2,
	DispatchEnvelopeV3,
	DispatchEnvelopeV4,
	GitCheckpointV1,
	ModelActionAuthorizedV1,
	ModelActionAuthorizedV2,
	ModelActionIntentV1,
	ModelRequestV1,
	ModelResponseV1,
	OperatorDecisionRecordedV1,
	PlanAdmittedV1,
	PlanReceiptRecordedV1,
	PromotionApprovalRequestedV1,
	PromotionDecisionRecordedV1,
	PromotionExecutionClaimedV1,
	PromotionReconciliationResolvedV1,
	PromotionResultRecordedV1,
	ReleaseEvaluationEvidenceV1,
	ResultReadyV1,
	ReviewVerdictRecordedV1,
	ReviewVerdictRecordedV2,
	RunAdmissionRecordedV1,
	RunCompletedV1,
	RunFailedV1,
	RunStartedV1,
	TapeCheckpointV1,
	ToolRequestStoredV1,
	ToolResultV1,
	UnitCancelledV1,
	UnitCompletedV1,
	UnitFailedV1,
	UnitStartedV1,
	WorkflowCancellationRequestedV1,
	WorkflowGraphDeclaredV1,
	WorkflowGraphDeclaredV2,
	WorkflowTerminalV1,
	WorkflowTerminalV2,
	WorkflowTimerFiredV1,
	WorkflowTimerScheduledV1,
	WorkspaceReadV1,
	WorkspaceWriteV1,
} from "./generated/index.js";

/** Externally-tagged payload union — mirrors `bp_ledger::payload::Payload`. */
export type Payload =
	| { RunStartedV1: RunStartedV1 }
	| { RunCompletedV1: RunCompletedV1 }
	| { RunFailedV1: RunFailedV1 }
	| { ResultReadyV1: ResultReadyV1 }
	| { RunAdmissionRecordedV1: RunAdmissionRecordedV1 }
	| { PlanAdmittedV1: PlanAdmittedV1 }
	| { PlanReceiptRecordedV1: PlanReceiptRecordedV1 }
	| { ActivityStartedV1: ActivityStartedV1 }
	| { ActivityCompletedV1: ActivityCompletedV1 }
	| { UnitStartedV1: UnitStartedV1 }
	| { UnitCompletedV1: UnitCompletedV1 }
	| { UnitFailedV1: UnitFailedV1 }
	| { UnitCancelledV1: UnitCancelledV1 }
	| { GitCheckpointV1: GitCheckpointV1 }
	| { ModelRequestV1: ModelRequestV1 }
	| { ModelResponseV1: ModelResponseV1 }
	| { ToolRequestStoredV1: ToolRequestStoredV1 }
	| { ToolResultV1: ToolResultV1 }
	| { WorkspaceReadV1: WorkspaceReadV1 }
	| { WorkspaceWriteV1: WorkspaceWriteV1 }
	| { TapeCheckpointV1: TapeCheckpointV1 }
	| { CapabilityDeniedV1: CapabilityDeniedV1 }
	| { AcceptanceRecordedV1: AcceptanceRecordedV1 }
	| { OperatorDecisionRecordedV1: OperatorDecisionRecordedV1 }
	| { DispatchEnvelopeV1: DispatchEnvelopeV1 }
	| { DispatchEnvelopeV2: DispatchEnvelopeV2 }
	| { DispatchEnvelopeV3: DispatchEnvelopeV3 }
	| { DispatchEnvelopeV4: DispatchEnvelopeV4 }
	| { WorkflowGraphDeclaredV1: WorkflowGraphDeclaredV1 }
	| { WorkflowGraphDeclaredV2: WorkflowGraphDeclaredV2 }
	| { ActionRequestedV2: ActionRequestedV2 }
	| { ModelActionIntentV1: ModelActionIntentV1 }
	| { ModelActionAuthorizedV1: ModelActionAuthorizedV1 }
	| { ModelActionAuthorizedV2: ModelActionAuthorizedV2 }
	| { ActivityClaimedV1: ActivityClaimedV1 }
	| { ActivityHeartbeatRecordedV1: ActivityHeartbeatRecordedV1 }
	| { ActivityResultRecordedV1: ActivityResultRecordedV1 }
	| { ActionReceiptRecordedV2: ActionReceiptRecordedV2 }
	| { ActionReceiptSetRecordedV1: ActionReceiptSetRecordedV1 }
	| { AttemptContextRecordedV1: AttemptContextRecordedV1 }
	| { CandidateCreatedV1: CandidateCreatedV1 }
	| { CandidateCreatedV2: CandidateCreatedV2 }
	| { CandidateCompletionRecordedV1: CandidateCompletionRecordedV1 }
	| { CandidateAcceptanceRecordedV1: CandidateAcceptanceRecordedV1 }
	| { ReviewVerdictRecordedV1: ReviewVerdictRecordedV1 }
	| { ReviewVerdictRecordedV2: ReviewVerdictRecordedV2 }
	| { PromotionApprovalRequestedV1: PromotionApprovalRequestedV1 }
	| { PromotionDecisionRecordedV1: PromotionDecisionRecordedV1 }
	| { PromotionExecutionClaimedV1: PromotionExecutionClaimedV1 }
	| { PromotionResultRecordedV1: PromotionResultRecordedV1 }
	| { PromotionReconciliationResolvedV1: PromotionReconciliationResolvedV1 }
	| { ReleaseEvaluationEvidenceV1: ReleaseEvaluationEvidenceV1 }
	| { WorkflowTimerScheduledV1: WorkflowTimerScheduledV1 }
	| { WorkflowTimerFiredV1: WorkflowTimerFiredV1 }
	| { WorkflowCancellationRequestedV1: WorkflowCancellationRequestedV1 }
	| { WorkflowTerminalV1: WorkflowTerminalV1 }
	| { WorkflowTerminalV2: WorkflowTerminalV2 };

/** Largest exact integer shared by the Rust `u64` action-resource wire shape
 * and JavaScript's JSON `number` representation. */
export const ACTION_RESOURCE_USAGE_MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertActionResourceUsageValue(
	field: string,
	value: unknown,
	required: boolean,
): void {
	if (value === undefined || (!required && value === null)) {
		if (!required) return;
		throw new TypeError(
			`action_receipt_recorded_v2 resource_usage.${field} is required`,
		);
	}
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(
			`action_receipt_recorded_v2 resource_usage.${field} must be a non-negative JavaScript safe integer`,
		);
	}
}

/** Reject resource observations that Rust cannot exchange with JavaScript
 * exactly. This is deliberately a runtime guard because generated TypeScript
 * types alone cannot distinguish unsafe `number` values. */
export function assertActionResourceUsageV1SafeIntegers(
	resourceUsage: ActionResourceUsageV1,
): void {
	assertActionResourceUsageValue(
		"wall_time_ms",
		resourceUsage.wall_time_ms,
		true,
	);
	assertActionResourceUsageValue(
		"cpu_time_ms",
		resourceUsage.cpu_time_ms,
		false,
	);
	assertActionResourceUsageValue(
		"peak_memory_bytes",
		resourceUsage.peak_memory_bytes,
		false,
	);
	assertActionResourceUsageValue(
		"input_bytes",
		resourceUsage.input_bytes,
		false,
	);
	assertActionResourceUsageValue(
		"output_bytes",
		resourceUsage.output_bytes,
		false,
	);
	assertActionResourceUsageValue(
		"input_tokens",
		resourceUsage.input_tokens,
		false,
	);
	assertActionResourceUsageValue(
		"output_tokens",
		resourceUsage.output_tokens,
		false,
	);
}

/** Validate raw and externally-tagged action-receipt payloads before the
 * client emits an envelope. Older payload kinds remain untouched. */
export function assertActionReceiptRecordedV2SafeIntegerResources(
	payload: unknown,
): void {
	const receipt =
		isRecord(payload) && Object.hasOwn(payload, "ActionReceiptRecordedV2")
			? payload.ActionReceiptRecordedV2
			: payload;
	if (!isRecord(receipt) || !isRecord(receipt.resource_usage)) {
		throw new TypeError(
			"action_receipt_recorded_v2 payload must include resource_usage",
		);
	}
	if (
		receipt.authorization_ref !== undefined &&
		(typeof receipt.authorization_ref !== "string" ||
			receipt.authorization_ref.trim().length === 0)
	) {
		throw new TypeError(
			"action_receipt_recorded_v2 authorization_ref must be a non-empty string when present",
		);
	}
	const resourceUsage = receipt.resource_usage;
	assertActionResourceUsageValue(
		"wall_time_ms",
		resourceUsage.wall_time_ms,
		true,
	);
	assertActionResourceUsageValue(
		"cpu_time_ms",
		resourceUsage.cpu_time_ms,
		false,
	);
	assertActionResourceUsageValue(
		"peak_memory_bytes",
		resourceUsage.peak_memory_bytes,
		false,
	);
	assertActionResourceUsageValue(
		"input_bytes",
		resourceUsage.input_bytes,
		false,
	);
	assertActionResourceUsageValue(
		"output_bytes",
		resourceUsage.output_bytes,
		false,
	);
	assertActionResourceUsageValue(
		"input_tokens",
		resourceUsage.input_tokens,
		false,
	);
	assertActionResourceUsageValue(
		"output_tokens",
		resourceUsage.output_tokens,
		false,
	);
}
