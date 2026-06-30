export const PLANFORGE_INPUT_SCHEMA_VERSION = "planforge.input.v0";
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
	"tasks",
] as const;

export const PLANFORGE_ALLOWED_SIDE_EFFECTS = [
	"local-doc",
	"local-fixture",
	"local-receipt",
	"code-edit",
] as const;

export const PLANFORGE_FORBIDDEN_SIDE_EFFECTS = [
	"execute-code",
	"board-write",
	"network-write",
	"push",
	"deploy",
	"merge",
] as const;

export const PLANFORGE_EVIDENCE_KINDS = [
	"operator_goal",
	"repo_state",
	"planning_artifact",
	"review_note",
	"fixture",
] as const;

export type PlanForgeInputSchemaVersion = typeof PLANFORGE_INPUT_SCHEMA_VERSION;
export type PlanForgePlanSchemaVersion = typeof PLANFORGE_PLAN_SCHEMA_VERSION;
export type PlanForgeReceiptSchemaVersion =
	typeof PLANFORGE_RECEIPT_SCHEMA_VERSION;
export type PlanForgeValidationStatus =
	(typeof PLANFORGE_VALIDATION_STATUSES)[number];
export type PlanForgeRiskClass = "low" | "medium" | "high";
export type PlanForgeRequiredEvidence =
	(typeof PLANFORGE_REQUIRED_EVIDENCE)[number];
export type PlanForgeAllowedSideEffect =
	(typeof PLANFORGE_ALLOWED_SIDE_EFFECTS)[number];
export type PlanForgeForbiddenSideEffect =
	(typeof PLANFORGE_FORBIDDEN_SIDE_EFFECTS)[number];
export type PlanForgeEvidenceKind = (typeof PLANFORGE_EVIDENCE_KINDS)[number];

export interface PlanForgeEvidenceRef {
	readonly kind: PlanForgeEvidenceKind;
	readonly uri: string;
	readonly sha256?: string;
	readonly summary?: string;
}

export interface PlanForgeInput {
	readonly schemaVersion: PlanForgeInputSchemaVersion;
	readonly goal: string;
	readonly requester?: string;
	readonly repository: {
		readonly remote: string;
		readonly trustedBase: string;
		readonly worktreePolicy: "isolated-worktree-required";
	};
	readonly constraints: {
		readonly dryRun: true;
		readonly localFirst: true;
		readonly noNetworkSideEffects: true;
		readonly noBoardWrites: true;
		readonly noPushDeployMerge: true;
	};
	readonly evidence: readonly PlanForgeEvidenceRef[];
	readonly idempotencyKey: string;
}

export interface PlanForgeValidationCheck {
	id: string;
	status: PlanForgeValidationStatus;
	message: string;
	evidenceRefs: string[];
}

export interface PlanForgeValidation {
	status: PlanForgeValidationStatus;
	riskClass: PlanForgeRiskClass;
	checks: PlanForgeValidationCheck[];
	requiredEvidence: readonly PlanForgeRequiredEvidence[];
	missingEvidence: PlanForgeRequiredEvidence[];
	unsafeReasons: string[];
}

export interface PlanForgeTask {
	id: string;
	title: string;
	objective: string;
	assigneeHint: string;
	workspace: string;
	dependsOn: string[];
	allowedSideEffects: PlanForgeAllowedSideEffect[];
	forbiddenSideEffects: PlanForgeForbiddenSideEffect[];
	acceptanceCriteria: string[];
	verificationCommands: string[];
}

export interface PlanForgeReceiptPreview {
	schemaVersion: PlanForgeReceiptSchemaVersion;
	status: PlanForgeValidationStatus;
	riskClass: PlanForgeRiskClass;
	/**
	 * Declarative network-egress allowlist (host names) for the admitted plan —
	 * the deterministic union of every task's declared egress (M6-S9).
	 * Declarative-only / not yet enforced; `[]` = default-deny. Surfaced here for
	 * preview rendering, mirroring `riskClass`. Excluded from `planDigest`
	 * (receiptPreview is documentation/fixture only).
	 */
	netEgress: string[];
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

export interface PlanForgeReceipt {
	readonly schemaVersion: PlanForgeReceiptSchemaVersion;
	readonly status: PlanForgeValidationStatus;
	readonly planId: string;
	readonly idempotencyKey: string;
	readonly inputDigest: string;
	readonly planDigest: string;
	readonly trustedBase: string;
	readonly admittedBy: "buildplane-kernel";
	readonly generatedAt: string;
	readonly dryRun: true;
	readonly sideEffects: readonly [];
	readonly notes: readonly string[];
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
