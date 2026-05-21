export const PLANFORGE_PLAN_SCHEMA_VERSION = "planforge.plan.v0";
export const PLANFORGE_RECEIPT_SCHEMA_VERSION = "planforge.receipt.v0";

export const PLANFORGE_VALIDATION_STATUS_PASS = "PASS";
export const PLANFORGE_VALIDATION_STATUS_BLOCKED = "BLOCKED";
export const PLANFORGE_VALIDATION_STATUS_FAILED = "FAILED";
export const PLANFORGE_VALIDATION_STATUS_INSUFFICIENT_EVIDENCE =
	"INSUFFICIENT_EVIDENCE";
export const PLANFORGE_VALIDATION_STATUS_UNSAFE_TO_RUN = "UNSAFE_TO_RUN";

export const PLANFORGE_VALIDATION_STATUSES = [
	PLANFORGE_VALIDATION_STATUS_PASS,
	PLANFORGE_VALIDATION_STATUS_BLOCKED,
	PLANFORGE_VALIDATION_STATUS_FAILED,
	PLANFORGE_VALIDATION_STATUS_INSUFFICIENT_EVIDENCE,
	PLANFORGE_VALIDATION_STATUS_UNSAFE_TO_RUN,
] as const;

export const PLANFORGE_REQUIRED_EVIDENCE = [
	"operator_goal",
	"repository_remote",
	"trusted_base",
	"worktree_policy",
	"dry_run_constraints",
	"trusted_boundary",
] as const;

export const PLANFORGE_TASK_IDS = ["PF1", "PF2"] as const;

export const PLANFORGE_ALLOWED_SIDE_EFFECTS = [
	"local-doc",
	"local-fixture",
	"local-receipt",
] as const;

export const PLANFORGE_FORBIDDEN_SIDE_EFFECTS = [
	"execute-code",
	"board-write",
	"network-write",
	"push",
	"deploy",
	"merge",
] as const;

export type PlanForgePlanSchemaVersion = typeof PLANFORGE_PLAN_SCHEMA_VERSION;
export type PlanForgeReceiptSchemaVersion =
	typeof PLANFORGE_RECEIPT_SCHEMA_VERSION;
export type PlanForgeValidationStatus =
	(typeof PLANFORGE_VALIDATION_STATUSES)[number];
export type PlanForgeRequiredEvidence =
	(typeof PLANFORGE_REQUIRED_EVIDENCE)[number];
export type PlanForgeTaskId = (typeof PLANFORGE_TASK_IDS)[number];
export type PlanForgeAllowedSideEffect =
	(typeof PLANFORGE_ALLOWED_SIDE_EFFECTS)[number];
export type PlanForgeForbiddenSideEffect =
	(typeof PLANFORGE_FORBIDDEN_SIDE_EFFECTS)[number];

export interface PlanForgeValidationCheck {
	id: string;
	status: PlanForgeValidationStatus;
	message: string;
	evidenceRefs: string[];
}

export interface PlanForgeValidation {
	status: PlanForgeValidationStatus;
	checks: PlanForgeValidationCheck[];
	requiredEvidence: readonly PlanForgeRequiredEvidence[];
	missingEvidence: PlanForgeRequiredEvidence[];
	unsafeReasons: string[];
}

export interface PlanForgeTask {
	id: PlanForgeTaskId;
	title: string;
	objective: string;
	assigneeHint: string;
	workspace: string;
	dependsOn: PlanForgeTaskId[];
	allowedSideEffects: PlanForgeAllowedSideEffect[];
	forbiddenSideEffects: PlanForgeForbiddenSideEffect[];
	acceptanceCriteria: string[];
	verificationCommands: string[];
}

export interface PlanForgeReceiptPreview {
	schemaVersion: PlanForgeReceiptSchemaVersion;
	status: PlanForgeValidationStatus;
	planId: string;
	idempotencyKey: string;
	inputDigest: string;
	planDigest: string;
	trustedBase: string;
	admittedBy: string;
	generatedAt: string;
	dryRun: boolean;
	sideEffects: string[];
	notes: string[];
}

export interface PlanForgePlan {
	schemaVersion: PlanForgePlanSchemaVersion;
	id: string;
	idempotencyKey: string;
	title: string;
	goal: string;
	trustedBase: string;
	tasks: PlanForgeTask[];
	validation: PlanForgeValidation;
	receiptPreview: PlanForgeReceiptPreview;
}
