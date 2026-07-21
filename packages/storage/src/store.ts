import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
	type AcceptanceShadowOutcome,
	type AppendRunOutcomeInput,
	type ApprovedPolicyDecision,
	type BuildplaneStoragePort,
	type CreateProcedureInput,
	type CreateRunOptions,
	type CreateSearchableDocumentInput,
	canonicalSha256Digest,
	createRankedMemoryResult,
	type DecidedUnexecutedDecision,
	dedupeRankedMemoryResults,
	type ExecutionEvent,
	type ExecutionReceipt,
	type InjectedMemoryRecord,
	type InspectSnapshot,
	type MemoryScopeType,
	type OperatorDecisionShadow,
	type PendingOperatorDecision,
	type PersistedInjectedMemoryRecord,
	type PolicyDecision,
	type ProcedureMemory,
	type ProcedureRetrievalQuery,
	type PromotedStructuredMemoryRecord,
	type PromotionGitBindingV1,
	parsePromotionDecisionV1,
	parseReviewVerdictV1,
	parseUnitPacket,
	type RankedProcedureResult,
	type RankedRepoFactResult,
	type RankedSearchableDocumentResult,
	type RejectedPolicyDecision,
	type RepoFact,
	type RepoFactRetrievalQuery,
	type RepoFactScopeCandidate,
	type Run,
	type RunOutcome,
	type RunPage,
	type RunStatus,
	type SearchableDocument,
	type SearchableDocumentRetrievalQuery,
	type StatusSnapshot,
	type StatusWorkspaceSummary,
	type Unit,
	type UnitPacket,
	type UpsertRepoFactInput,
	type WorkerLabel,
	type WorkspaceSnapshot,
} from "@buildplane/kernel";
import type {
	CandidateAcceptanceRecord as KernelCandidateAcceptanceRecord,
	CandidateArtifactProjection as KernelCandidateArtifactProjection,
	CandidateArtifactProjectionInput as KernelCandidateArtifactProjectionInput,
	CandidateOutcomeInput as KernelCandidateOutcomeInput,
	CandidatePromotionIntent as KernelCandidatePromotionIntent,
	CandidatePromotionIntentInput as KernelCandidatePromotionIntentInput,
	CandidatePromotionOutcome as KernelCandidatePromotionOutcome,
	CandidatePromotionState as KernelCandidatePromotionState,
	CandidateReviewRecord as KernelCandidateReviewRecord,
} from "@buildplane/kernel/ports";
import {
	assertBuildplaneDatabaseIsInitialized,
	openBuildplaneDatabase,
} from "./database.js";
import { createEventStore } from "./event-store.js";
import { resolveProjectLayout } from "./project-layout.js";

interface StoredRunRow {
	readonly id: string;
	readonly unit_id: string;
	readonly status:
		| "pending"
		| "running"
		| "passed"
		| "failed"
		| "cancelled"
		| "suspended";
	readonly unit_snapshot?: string;
	readonly used_workspace: number;
	readonly parent_run_id: string | null;
	readonly strategy_id: string | null;
	readonly trust_lane: "legacy" | "unsafe" | "governed";
}

interface StoredDecisionRow {
	readonly id: string;
	readonly kind: PolicyDecision["kind"];
	readonly outcome: PolicyDecision["outcome"];
	readonly reasons: string;
}

interface StoredWorkspaceRow {
	readonly run_id: string;
	readonly source_project_root: string;
	readonly path: string;
	readonly head_sha: string;
	readonly status: "active" | "deleted" | "retained" | "cleanup-failed";
	readonly created_at: string;
	readonly finalized_at: string | null;
	readonly cleanup_error: string | null;
}

interface StoredCandidateArtifactRow {
	readonly run_id: string;
	readonly schema_version: number;
	readonly candidate_id: string;
	readonly candidate_key: string;
	readonly candidate_ref: string;
	readonly workflow_id: string | null;
	readonly unit_id: string;
	readonly attempt: number;
	readonly provenance_ref: string | null;
	readonly candidate_digest: string;
	readonly base_commit_sha: string;
	readonly candidate_commit_sha: string;
	readonly commit_digest: string;
	readonly tree_digest: string;
	readonly patch_digest: string;
	readonly changed_files_digest: string;
	readonly envelope_digest: string | null;
	readonly acceptance_contract_digest: string | null;
	readonly action_receipt_digest: string | null;
	readonly action_receipt_set_ref: string | null;
	readonly action_receipt_set_digest: string | null;
	readonly action_evidence_version: string | null;
	readonly candidate_created_ref: string | null;
	readonly created_at: string;
}

/**
 * Tier-1 candidate-promotion write-ahead projection. The signed ledger remains
 * the authority for a promotion decision; this row only gives recovery a
 * durable, candidate-bound intent and terminal-effect marker.
 */
interface StoredCandidatePromotionRow {
	readonly candidate_digest: string;
	readonly idempotency_key: string;
	readonly run_id: string;
	readonly state: string;
	readonly candidate_json: string;
	readonly decision_json: string;
	readonly acceptance_json: string;
	readonly review_json: string;
	readonly intent_canonical_json: string;
	readonly prepared_at: string;
	readonly recorded_at: string | null;
	readonly executed_at: string | null;
	readonly executed_outcome: string | null;
	readonly merged_head_sha: string | null;
	readonly promotion_git_binding_json: string | null;
	readonly execution_claim_token: string | null;
	readonly execution_claimed_at: string | null;
	readonly execution_lease_expires_at: string | null;
	readonly execution_claim_epoch: number;
}

interface StoredRepoFactRow {
	readonly id: string;
	readonly repo_id: string;
	readonly fact_key: string;
	readonly fact_value_json: string;
	readonly value_type: "string" | "number" | "boolean" | "json";
	readonly scope_type: MemoryScopeType;
	readonly scope_key: string | null;
	readonly confidence: number;
	readonly source_run_id: string | null;
	readonly source_task_id: string | null;
	readonly created_by: "system" | "worker" | "operator";
	readonly branch: string | null;
	readonly commit_sha: string | null;
	readonly status: "active" | "stale" | "superseded" | "archived";
	readonly valid_from_commit: string | null;
	readonly valid_to_commit: string | null;
	readonly created_at: string;
	readonly updated_at: string;
}

interface StoredProcedureRow {
	readonly id: string;
	readonly repo_id: string | null;
	readonly name: string;
	readonly task_type: string | null;
	readonly body_markdown: string;
	readonly metadata_json: string | null;
	readonly confidence: number;
	readonly source_run_id: string | null;
	readonly source_task_id: string | null;
	readonly created_by: "system" | "worker" | "operator";
	readonly branch: string | null;
	readonly commit_sha: string | null;
	readonly status: "active" | "stale" | "superseded" | "archived";
	readonly created_at: string;
	readonly updated_at: string;
}

interface StoredRunOutcomeRow {
	readonly id: string;
	readonly repo_id: string;
	readonly task_type: string;
	readonly worker: WorkerLabel;
	readonly success: number;
	readonly source_run_id: string;
	readonly created_at: string;
}

interface StoredSearchableDocumentRow {
	readonly id: string;
	readonly repo_id: string;
	readonly source_table: string | null;
	readonly source_id: string | null;
	readonly document_kind: string;
	readonly title: string | null;
	readonly body_text: string;
	readonly metadata_json: string | null;
	readonly created_at: string;
	readonly updated_at: string;
}

interface StoredInjectedMemoryRow {
	readonly id: string;
	readonly run_id: string;
	readonly memory_kind: InjectedMemoryRecord["memoryKind"];
	readonly memory_id: string;
	readonly display_text: string;
	readonly match_reason: string;
	readonly match_class: InjectedMemoryRecord["matchClass"];
	readonly scope_preference_index: number | null;
	readonly created_at: string;
}

interface StoredInspectEventRow {
	readonly id: string;
	readonly kind: string;
	readonly occurred_at: string;
	readonly payload: string;
}

export interface StorageTestingHooks {
	readonly failpoint?: (name: string) => void;
	/** Deterministic clock for storage transition tests. */
	readonly now?: () => Date;
}

export interface CreateStorageStoreOptions {
	readonly testingHooks?: StorageTestingHooks;
}

/**
 * Storage's immutable candidate projection input.
 *
 * `candidateId`, `candidateKey`, `candidateRef`, `attempt`, and
 * `commitDigest` are the recovery identity emitted by the Git adapter. They
 * let a later promotion/recovery path reconstruct the exact candidate without
 * treating a run record as merge authority.
 *
 * This is deliberately not an admission or promotion contract. Governed
 * callers may supply every V1 lineage field; raw and legacy callers may leave
 * the V1-only fields absent while still retaining an immutable Git candidate.
 * The storage adapter never treats these values as a signature or authority.
 */
export type CandidateArtifactProjectionInput =
	KernelCandidateArtifactProjectionInput;

/**
 * Durable, immutable candidate metadata associated with one run.
 *
 * Optional governance lineage is present only when supplied by the caller;
 * this projection does not infer authority for legacy/raw execution.
 */
export type CandidateArtifactProjection = KernelCandidateArtifactProjection;

export type CandidateOutcomeInput = KernelCandidateOutcomeInput;

export type CandidateAcceptanceRecord = KernelCandidateAcceptanceRecord;
export type CandidateReviewRecord = KernelCandidateReviewRecord;
export type CandidatePromotionState = KernelCandidatePromotionState;
export type CandidatePromotionOutcome = KernelCandidatePromotionOutcome;
export type CandidatePromotionIntentInput = KernelCandidatePromotionIntentInput;
export type CandidatePromotionIntent = KernelCandidatePromotionIntent;

/**
 * Opaque, single-owner capability required to record a promotion effect after
 * the write-ahead decision has been claimed. It is deliberately local to the
 * durable projection: the signed decision/tape remains the authority for the
 * decision itself, while this lease prevents two recoverers from entering the
 * same Git effect concurrently.
 */
export interface CandidatePromotionExecutionLeaseV1 {
	readonly schemaVersion: 1;
	readonly state: "active";
	readonly candidateDigest: string;
	readonly idempotencyKey: string;
	readonly leaseToken: string;
	readonly claimedAt: string;
	readonly leaseExpiresAt: string;
	readonly claimEpoch: number;
}

/** Durable recovery view for a candidate-promotion execution lease. */
export interface CandidatePromotionExecutionClaimStateV1 {
	readonly schemaVersion: 1;
	readonly state: "pending" | "active" | "expired" | "completed";
	readonly candidateDigest: string;
	readonly idempotencyKey: string;
	readonly claimEpoch: number;
	readonly claimedAt?: string;
	readonly leaseExpiresAt?: string;
	readonly executedAt?: string;
	readonly executedOutcome?: CandidatePromotionOutcome;
}

type WorkspaceAwareStatusSnapshot = StatusSnapshot & {
	readonly latestRunUsedWorkspace: boolean;
	readonly latestWorkspace?: StatusWorkspaceSummary;
	readonly actionableWorkspaces: readonly WorkspaceSnapshot[];
};

type WorkspaceAwareInspectSnapshot = InspectSnapshot & {
	readonly workspace?: WorkspaceSnapshot;
	readonly candidate?: CandidateArtifactProjection;
	readonly strategy?: {
		readonly strategyId: string;
	};
	readonly injectedMemories?: readonly PersistedInjectedMemoryRecord[];
	readonly promotedStructuredMemories?: readonly PromotedStructuredMemoryRecord[];
};

const RAW_CANDIDATE_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const GOVERNED_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const FULL_GIT_COMMIT_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const PROMOTION_EXECUTION_LEASE_MS = 5 * 60 * 1000;
const PROMOTION_EXECUTION_LEASE_TOKEN_PATTERN =
	/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

interface WorkspaceAwareStorageStore
	extends Omit<BuildplaneStoragePort, "initializeProject"> {
	recordWorkspacePrepared(
		runId: string,
		workspace: {
			path: string;
			headSha: string;
			sourceProjectRoot: string;
		},
	): void;
	commitRunFailureOutcome(
		runId: string,
		payload:
			| {
					decision: RejectedPolicyDecision;
					infrastructureFailure?: never;
					workspaceStatus: "retained";
			  }
			| {
					decision?: never;
					infrastructureFailure: {
						kind: string;
						message: string;
					};
					workspaceStatus?: "retained";
			  },
	): Run;
	commitRunSuccessOutcome(runId: string, decision: ApprovedPolicyDecision): Run;
	commitRunCandidateOutcome(runId: string, input: CandidateOutcomeInput): Run;
	getCandidateArtifact(runId: string): CandidateArtifactProjection | null;
	prepareCandidatePromotion(
		input: CandidatePromotionIntentInput,
	): CandidatePromotionIntent;
	markCandidatePromotionRecorded(
		candidateDigest: string,
		idempotencyKey: string,
	): void;
	claimCandidatePromotionExecution(
		candidateDigest: string,
		idempotencyKey: string,
	): CandidatePromotionExecutionLeaseV1;
	getCandidatePromotionExecutionClaimState(
		candidateDigest: string,
		idempotencyKey: string,
	): CandidatePromotionExecutionClaimStateV1;
	markCandidatePromotionExecuted(
		candidateDigest: string,
		idempotencyKey: string,
		outcome: {
			outcome: CandidatePromotionOutcome;
			mergedHeadSha?: string;
			promotionGitBinding?: PromotionGitBindingV1;
		},
		executionLeaseToken?: string,
	): void;
	listPendingCandidatePromotions(): readonly CandidatePromotionIntent[];
	recordWorkspaceDeleted(runId: string): void;
	recordWorkspaceCleanupFailed(runId: string, message: string): void;
	recordWorkspaceCleanedUp(runId: string): void;
	getStatusSnapshot(): WorkspaceAwareStatusSnapshot;
	inspectTarget(id: string): WorkspaceAwareInspectSnapshot;
	getRunHistory(): RunHistoryEntry[];
	recordRunStrategyId(runId: string, strategyId: string): void;
	getPacketSnapshot(runId: string): UnitPacket | null;
}

function encodeRunCursor(rowid: number): string {
	return Buffer.from(`run:${rowid}`, "utf8").toString("base64url");
}

function decodeRunCursor(cursor: string | undefined): number | undefined {
	if (cursor === undefined) {
		return undefined;
	}
	const decoded = Buffer.from(cursor, "base64url").toString("utf8");
	const match = decoded.match(/^run:(\d+)$/);
	if (!match) {
		throw new Error(`Invalid run cursor: '${cursor}'`);
	}
	return Number(match[1]);
}

function tableHasColumn(
	database: DatabaseSync,
	tableName: string,
	columnName: string,
): boolean {
	const columns = database.prepare(`PRAGMA table_info(${tableName})`).all() as {
		name: string;
	}[];
	return columns.some((column) => column.name === columnName);
}

function ensureEvidenceMessageColumn(database: DatabaseSync): void {
	if (!tableHasColumn(database, "evidence", "message")) {
		database.exec(`ALTER TABLE evidence ADD COLUMN message TEXT`);
	}
}

function ensureRunsUsedWorkspaceColumn(database: DatabaseSync): void {
	if (!tableHasColumn(database, "runs", "used_workspace")) {
		database.exec(
			`ALTER TABLE runs ADD COLUMN used_workspace INTEGER NOT NULL DEFAULT 0`,
		);
	}
}

function ensureRunsStepColumns(database: DatabaseSync): void {
	if (!tableHasColumn(database, "runs", "step_count")) {
		database.exec(
			`ALTER TABLE runs ADD COLUMN step_count INTEGER NOT NULL DEFAULT 0`,
		);
	}
	if (!tableHasColumn(database, "runs", "budget_snapshot")) {
		database.exec(`ALTER TABLE runs ADD COLUMN budget_snapshot TEXT`);
	}
}

function ensureRunsStrategyColumns(database: DatabaseSync): void {
	if (!tableHasColumn(database, "runs", "parent_run_id")) {
		database.exec("ALTER TABLE runs ADD COLUMN parent_run_id TEXT");
	}
	if (!tableHasColumn(database, "runs", "strategy_id")) {
		database.exec("ALTER TABLE runs ADD COLUMN strategy_id TEXT");
		database.exec(
			"CREATE INDEX IF NOT EXISTS idx_runs_strategy_id ON runs (strategy_id)",
		);
	}
}

function ensureRunsAcceptanceShadowColumn(database: DatabaseSync): void {
	if (!tableHasColumn(database, "runs", "acceptance_outcome")) {
		database.exec("ALTER TABLE runs ADD COLUMN acceptance_outcome TEXT");
	}
}

/**
 * Execution authority is durable state, not a presentation flag. Historical
 * rows are deliberately `legacy`; raw invocations are written as `unsafe` and
 * can never acquire a trusted final verdict later in the run lifecycle.
 */
function ensureRunsTrustLaneColumn(database: DatabaseSync): void {
	if (!tableHasColumn(database, "runs", "trust_lane")) {
		database.exec(
			"ALTER TABLE runs ADD COLUMN trust_lane TEXT NOT NULL DEFAULT 'legacy'",
		);
	}
}

/**
 * Candidate artifacts predate the explicit acceptance-contract binding. Keep
 * the column nullable for raw/legacy candidates, while governed promotion
 * requires the value below. This migration must run before the strict schema
 * assertion so existing state databases remain readable.
 */
function ensureCandidateArtifactAcceptanceContractDigestColumn(
	database: DatabaseSync,
): void {
	if (
		tableExists(database, "candidate_artifacts") &&
		!tableHasColumn(
			database,
			"candidate_artifacts",
			"acceptance_contract_digest",
		)
	) {
		database.exec(
			"ALTER TABLE candidate_artifacts ADD COLUMN acceptance_contract_digest TEXT",
		);
	}
}

/**
 * V3 governed candidates replace the single pre-effect receipt digest with a
 * sealed receipt-set reference and digest. These columns are deliberately
 * nullable: rows written by V1/raw/legacy paths remain readable and cannot be
 * retroactively represented as V3 evidence.
 */
function ensureCandidateArtifactActionEvidenceColumns(
	database: DatabaseSync,
): void {
	if (!tableExists(database, "candidate_artifacts")) return;

	for (const statement of [
		"ALTER TABLE candidate_artifacts ADD COLUMN action_receipt_set_ref TEXT",
		"ALTER TABLE candidate_artifacts ADD COLUMN action_receipt_set_digest TEXT",
		"ALTER TABLE candidate_artifacts ADD COLUMN action_evidence_version TEXT",
		"ALTER TABLE candidate_artifacts ADD COLUMN candidate_created_ref TEXT",
	] as const) {
		const columnName = statement.match(/ADD COLUMN ([^ ]+)/)?.[1];
		if (
			columnName &&
			!tableHasColumn(database, "candidate_artifacts", columnName)
		) {
			database.exec(statement);
		}
	}
}

/**
 * SQLite cannot widen the old executed_outcome CHECK constraint in place.
 * Rebuild the narrow promotion projection transactionally so pre-existing
 * prepared/recorded/promoted/rejected rows remain readable while every newly
 * written strict result can retain its Git binding and reconciliation state.
 */
function ensureCandidatePromotionsReconciliationSchema(
	database: DatabaseSync,
): void {
	if (!tableExists(database, "candidate_promotions")) return;
	const schema = database
		.prepare(
			`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'candidate_promotions'`,
		)
		.get() as { sql?: string } | undefined;
	const hasBinding = tableHasColumn(
		database,
		"candidate_promotions",
		"promotion_git_binding_json",
	);
	if (hasBinding && schema?.sql?.includes("reconciliation_required")) {
		return;
	}

	database.exec("BEGIN IMMEDIATE");
	try {
		database.exec(
			"ALTER TABLE candidate_promotions RENAME TO candidate_promotions_pre_reconciliation",
		);
		database.exec(`
			CREATE TABLE candidate_promotions (
				candidate_digest TEXT NOT NULL,
				idempotency_key TEXT NOT NULL,
				run_id TEXT NOT NULL,
				state TEXT NOT NULL CHECK (state IN ('prepared', 'recorded', 'executed')),
				candidate_json TEXT NOT NULL,
				decision_json TEXT NOT NULL,
				acceptance_json TEXT NOT NULL,
				review_json TEXT NOT NULL,
				intent_canonical_json TEXT NOT NULL,
				prepared_at TEXT NOT NULL,
				recorded_at TEXT,
				executed_at TEXT,
				executed_outcome TEXT CHECK (executed_outcome IN ('promoted', 'reconciliation_required', 'rejected')),
				merged_head_sha TEXT,
				promotion_git_binding_json TEXT,
				execution_claim_token TEXT,
				execution_claimed_at TEXT,
				execution_lease_expires_at TEXT,
				execution_claim_epoch INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (candidate_digest, idempotency_key),
				UNIQUE (candidate_digest),
				UNIQUE (idempotency_key)
			);
		`);
		database.exec(`
			INSERT INTO candidate_promotions (
				candidate_digest, idempotency_key, run_id, state, candidate_json,
				decision_json, acceptance_json, review_json, intent_canonical_json,
				prepared_at, recorded_at, executed_at, executed_outcome,
				merged_head_sha, promotion_git_binding_json, execution_claim_token,
				execution_claimed_at, execution_lease_expires_at, execution_claim_epoch
			)
			SELECT
				candidate_digest, idempotency_key, run_id, state, candidate_json,
				decision_json, acceptance_json, review_json, intent_canonical_json,
				prepared_at, recorded_at, executed_at, executed_outcome,
				merged_head_sha, ${hasBinding ? "promotion_git_binding_json" : "NULL"},
				NULL, NULL, NULL, 0
			FROM candidate_promotions_pre_reconciliation;
		`);
		database.exec("DROP TABLE candidate_promotions_pre_reconciliation");
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

/**
 * Promotion execution leases are additive to the existing write-ahead
 * projection. Historical rows remain replayable: a recorded row with no lease
 * is pending and must acquire a fresh owner before it can enter the Git path.
 */
function ensureCandidatePromotionExecutionLeaseColumns(
	database: DatabaseSync,
): void {
	if (!tableExists(database, "candidate_promotions")) return;

	for (const statement of [
		"ALTER TABLE candidate_promotions ADD COLUMN execution_claim_token TEXT",
		"ALTER TABLE candidate_promotions ADD COLUMN execution_claimed_at TEXT",
		"ALTER TABLE candidate_promotions ADD COLUMN execution_lease_expires_at TEXT",
		"ALTER TABLE candidate_promotions ADD COLUMN execution_claim_epoch INTEGER NOT NULL DEFAULT 0",
	] as const) {
		const columnName = statement.match(/ADD COLUMN ([^ ]+)/)?.[1];
		if (
			columnName &&
			!tableHasColumn(database, "candidate_promotions", columnName)
		) {
			database.exec(statement);
		}
	}
}

function ensureRunLearningsTable(database: DatabaseSync): void {
	database.exec(`
		CREATE TABLE IF NOT EXISTS run_learnings (
			id               TEXT PRIMARY KEY,
			run_id           TEXT NOT NULL,
			scope            TEXT NOT NULL,
			kind             TEXT NOT NULL,
			title            TEXT NOT NULL,
			body             TEXT NOT NULL,
			status           TEXT NOT NULL DEFAULT 'active',
			promoted_from_id TEXT,
			source_run_id    TEXT,
			created_at       TEXT NOT NULL,
			updated_at       TEXT NOT NULL
		)
	`);
	database.exec(
		`CREATE INDEX IF NOT EXISTS idx_run_learnings_run_id ON run_learnings (run_id)`,
	);
	database.exec(
		`CREATE INDEX IF NOT EXISTS idx_run_learnings_scope ON run_learnings (scope)`,
	);
	database.exec(
		`CREATE INDEX IF NOT EXISTS idx_run_learnings_status ON run_learnings (status)`,
	);
}

function ensureSeenCountColumn(database: DatabaseSync): void {
	if (!tableHasColumn(database, "run_learnings", "seen_count")) {
		database.exec(
			`ALTER TABLE run_learnings ADD COLUMN seen_count INTEGER NOT NULL DEFAULT 1`,
		);
	}
}

function ensureRepoFactColumns(database: DatabaseSync): void {
	for (const statement of [
		`ALTER TABLE repo_facts ADD COLUMN created_by TEXT NOT NULL DEFAULT 'system'`,
		`ALTER TABLE repo_facts ADD COLUMN branch TEXT`,
		`ALTER TABLE repo_facts ADD COLUMN commit_sha TEXT`,
		`ALTER TABLE repo_facts ADD COLUMN valid_from_commit TEXT`,
		`ALTER TABLE repo_facts ADD COLUMN valid_to_commit TEXT`,
	] as const) {
		const columnName = statement.match(/ADD COLUMN ([^ ]+)/)?.[1];
		if (columnName && !tableHasColumn(database, "repo_facts", columnName)) {
			database.exec(statement);
		}
	}
}

function ensureProcedureColumns(database: DatabaseSync): void {
	for (const statement of [
		`ALTER TABLE procedures ADD COLUMN created_by TEXT NOT NULL DEFAULT 'system'`,
		`ALTER TABLE procedures ADD COLUMN branch TEXT`,
		`ALTER TABLE procedures ADD COLUMN commit_sha TEXT`,
	] as const) {
		const columnName = statement.match(/ADD COLUMN ([^ ]+)/)?.[1];
		if (columnName && !tableHasColumn(database, "procedures", columnName)) {
			database.exec(statement);
		}
	}
}

function assertTableColumns(
	database: DatabaseSync,
	tableName: string,
	columnNames: readonly string[],
): void {
	for (const columnName of columnNames) {
		if (!tableHasColumn(database, tableName, columnName)) {
			throw new Error(
				"Buildplane state is incomplete: state.db is missing required projection schema. Remove .buildplane or repair the database before rerunning `buildplane init`.",
			);
		}
	}
}

function tableExists(database: DatabaseSync, tableName: string): boolean {
	const row = database
		.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
		)
		.get(tableName) as { name: string } | undefined;
	return row?.name === tableName;
}

function assertWorkspaceTableColumns(database: DatabaseSync): void {
	assertTableColumns(database, "workspaces", [
		"run_id",
		"source_project_root",
		"path",
		"head_sha",
		"status",
		"created_at",
		"finalized_at",
		"cleanup_error",
	] as const);
}

function assertCandidateArtifactsTableColumns(database: DatabaseSync): void {
	assertTableColumns(database, "candidate_artifacts", [
		"run_id",
		"schema_version",
		"candidate_id",
		"candidate_key",
		"candidate_ref",
		"workflow_id",
		"unit_id",
		"attempt",
		"provenance_ref",
		"candidate_digest",
		"base_commit_sha",
		"candidate_commit_sha",
		"commit_digest",
		"tree_digest",
		"patch_digest",
		"changed_files_digest",
		"envelope_digest",
		"acceptance_contract_digest",
		"action_receipt_digest",
		"action_receipt_set_ref",
		"action_receipt_set_digest",
		"action_evidence_version",
		"candidate_created_ref",
		"created_at",
	] as const);
}

function assertCandidatePromotionsTableColumns(database: DatabaseSync): void {
	assertTableColumns(database, "candidate_promotions", [
		"candidate_digest",
		"idempotency_key",
		"run_id",
		"state",
		"candidate_json",
		"decision_json",
		"acceptance_json",
		"review_json",
		"intent_canonical_json",
		"prepared_at",
		"recorded_at",
		"executed_at",
		"executed_outcome",
		"merged_head_sha",
		"promotion_git_binding_json",
		"execution_claim_token",
		"execution_claimed_at",
		"execution_lease_expires_at",
		"execution_claim_epoch",
	] as const);
}

function assertRepoFactsTableColumns(database: DatabaseSync): void {
	assertTableColumns(database, "repo_facts", [
		"id",
		"repo_id",
		"fact_key",
		"fact_value_json",
		"value_type",
		"scope_type",
		"scope_key",
		"confidence",
		"source_run_id",
		"source_task_id",
		"created_by",
		"branch",
		"commit_sha",
		"status",
		"valid_from_commit",
		"valid_to_commit",
		"created_at",
		"updated_at",
	] as const);
}

function assertProceduresTableColumns(database: DatabaseSync): void {
	assertTableColumns(database, "procedures", [
		"id",
		"repo_id",
		"name",
		"task_type",
		"body_markdown",
		"metadata_json",
		"confidence",
		"source_run_id",
		"source_task_id",
		"created_by",
		"branch",
		"commit_sha",
		"status",
		"created_at",
		"updated_at",
	] as const);
}

function assertSearchableDocumentsTableColumns(database: DatabaseSync): void {
	assertTableColumns(database, "searchable_documents", [
		"id",
		"repo_id",
		"source_table",
		"source_id",
		"document_kind",
		"title",
		"body_text",
		"metadata_json",
		"created_at",
		"updated_at",
	] as const);
}

function assertInjectedMemoriesTableColumns(database: DatabaseSync): void {
	assertTableColumns(database, "injected_memories", [
		"id",
		"run_id",
		"memory_kind",
		"memory_id",
		"display_text",
		"match_reason",
		"match_class",
		"scope_preference_index",
		"created_at",
	] as const);
}

function assertRunOutcomesTableColumns(database: DatabaseSync): void {
	assertTableColumns(database, "run_outcomes", [
		"id",
		"repo_id",
		"task_type",
		"worker",
		"success",
		"source_run_id",
		"created_at",
	] as const);
}

export function bootstrapStorageProjectionSchema(database: DatabaseSync): void {
	ensureCandidateArtifactAcceptanceContractDigestColumn(database);
	ensureCandidateArtifactActionEvidenceColumns(database);
	if (tableExists(database, "workspaces")) {
		assertWorkspaceTableColumns(database);
	}
	if (tableExists(database, "candidate_artifacts")) {
		assertCandidateArtifactsTableColumns(database);
	}
	database.exec(`
		CREATE TABLE IF NOT EXISTS units (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			scope TEXT NOT NULL,
			input_refs TEXT NOT NULL,
			expected_outputs TEXT NOT NULL,
			verification_contract TEXT NOT NULL,
			policy_profile TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS runs (
			id TEXT PRIMARY KEY,
			unit_id TEXT NOT NULL,
			status TEXT NOT NULL,
			unit_snapshot TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			completed_at TEXT,
			used_workspace INTEGER NOT NULL DEFAULT 0,
			trust_lane TEXT NOT NULL DEFAULT 'legacy'
		);

		CREATE TABLE IF NOT EXISTS evidence (
			id TEXT PRIMARY KEY,
			run_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			status TEXT NOT NULL,
			message TEXT
		);

		CREATE TABLE IF NOT EXISTS decisions (
			id TEXT PRIMARY KEY,
			run_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			outcome TEXT NOT NULL,
			reasons TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS artifacts (
			id TEXT PRIMARY KEY,
			run_id TEXT NOT NULL,
			type TEXT NOT NULL,
			location TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS workspaces (
			run_id TEXT PRIMARY KEY,
			source_project_root TEXT NOT NULL,
			path TEXT NOT NULL,
			head_sha TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			finalized_at TEXT,
			cleanup_error TEXT
		);

		CREATE TABLE IF NOT EXISTS candidate_artifacts (
			run_id TEXT PRIMARY KEY,
			schema_version INTEGER NOT NULL,
			candidate_id TEXT NOT NULL,
			candidate_key TEXT NOT NULL UNIQUE,
			candidate_ref TEXT NOT NULL UNIQUE,
			workflow_id TEXT,
			unit_id TEXT NOT NULL,
			attempt INTEGER NOT NULL,
			provenance_ref TEXT,
			candidate_digest TEXT NOT NULL UNIQUE,
			base_commit_sha TEXT NOT NULL,
			candidate_commit_sha TEXT NOT NULL,
			commit_digest TEXT NOT NULL,
			tree_digest TEXT NOT NULL,
			patch_digest TEXT NOT NULL,
			changed_files_digest TEXT NOT NULL,
			envelope_digest TEXT,
			acceptance_contract_digest TEXT,
			action_receipt_digest TEXT,
			action_receipt_set_ref TEXT,
			action_receipt_set_digest TEXT,
			action_evidence_version TEXT,
			candidate_created_ref TEXT,
			created_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS candidate_promotions (
			candidate_digest TEXT NOT NULL,
			idempotency_key TEXT NOT NULL,
			run_id TEXT NOT NULL,
			state TEXT NOT NULL CHECK (state IN ('prepared', 'recorded', 'executed')),
			candidate_json TEXT NOT NULL,
			decision_json TEXT NOT NULL,
			acceptance_json TEXT NOT NULL,
			review_json TEXT NOT NULL,
			intent_canonical_json TEXT NOT NULL,
			prepared_at TEXT NOT NULL,
			recorded_at TEXT,
			executed_at TEXT,
			executed_outcome TEXT CHECK (executed_outcome IN ('promoted', 'reconciliation_required', 'rejected')),
			merged_head_sha TEXT,
			promotion_git_binding_json TEXT,
			execution_claim_token TEXT,
			execution_claimed_at TEXT,
			execution_lease_expires_at TEXT,
			execution_claim_epoch INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (candidate_digest, idempotency_key),
			UNIQUE (candidate_digest),
			UNIQUE (idempotency_key)
		);

		CREATE TABLE IF NOT EXISTS steps (
			id TEXT PRIMARY KEY,
			run_id TEXT NOT NULL,
			step_index INTEGER NOT NULL,
			kind TEXT NOT NULL,
			status TEXT NOT NULL,
			started_at TEXT NOT NULL,
			completed_at TEXT,
			detail TEXT
		);

		CREATE TABLE IF NOT EXISTS repo_facts (
			id TEXT PRIMARY KEY,
			repo_id TEXT NOT NULL,
			fact_key TEXT NOT NULL,
			fact_value_json TEXT NOT NULL,
			value_type TEXT NOT NULL,
			scope_type TEXT NOT NULL DEFAULT 'repo',
			scope_key TEXT,
			confidence REAL NOT NULL DEFAULT 1.0,
			source_run_id TEXT,
			source_task_id TEXT,
			created_by TEXT NOT NULL DEFAULT 'system',
			branch TEXT,
			commit_sha TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			valid_from_commit TEXT,
			valid_to_commit TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS procedures (
			id TEXT PRIMARY KEY,
			repo_id TEXT,
			name TEXT NOT NULL,
			task_type TEXT,
			body_markdown TEXT NOT NULL,
			metadata_json TEXT,
			confidence REAL NOT NULL DEFAULT 1.0,
			source_run_id TEXT,
			source_task_id TEXT,
			created_by TEXT NOT NULL DEFAULT 'system',
			branch TEXT,
			commit_sha TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS searchable_documents (
			id TEXT PRIMARY KEY,
			repo_id TEXT,
			source_table TEXT NOT NULL,
			source_id TEXT NOT NULL,
			document_kind TEXT NOT NULL,
			title TEXT,
			body_text TEXT NOT NULL,
			metadata_json TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS injected_memories (
			id TEXT PRIMARY KEY,
			run_id TEXT NOT NULL,
			memory_kind TEXT NOT NULL,
			memory_id TEXT NOT NULL,
			display_text TEXT NOT NULL,
			match_reason TEXT NOT NULL,
			match_class TEXT NOT NULL,
			scope_preference_index INTEGER,
			created_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS run_outcomes (
			id TEXT PRIMARY KEY,
			repo_id TEXT NOT NULL,
			task_type TEXT NOT NULL,
			worker TEXT NOT NULL,
			success INTEGER NOT NULL,
			source_run_id TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
	`);

	ensureCandidatePromotionsReconciliationSchema(database);
	ensureCandidatePromotionExecutionLeaseColumns(database);

	database.exec(`
		CREATE INDEX IF NOT EXISTS injected_memories_run_id_idx
		ON injected_memories (run_id);
	`);

	database.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS uq_candidate_artifacts_workflow_unit_attempt
		ON candidate_artifacts (workflow_id, unit_id, attempt)
		WHERE workflow_id IS NOT NULL AND attempt IS NOT NULL;
	`);

	database.exec(`
		CREATE INDEX IF NOT EXISTS idx_candidate_promotions_pending
		ON candidate_promotions (state, prepared_at, candidate_digest, idempotency_key);
	`);

	database.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS uq_candidate_promotions_execution_claim_token
		ON candidate_promotions (execution_claim_token)
		WHERE execution_claim_token IS NOT NULL;
	`);

	database.exec(`
		CREATE INDEX IF NOT EXISTS idx_candidate_promotions_execution_lease
		ON candidate_promotions (state, execution_lease_expires_at, candidate_digest, idempotency_key);
	`);

	database.exec(`
		CREATE INDEX IF NOT EXISTS idx_run_outcomes_grain
		ON run_outcomes (repo_id, task_type, worker);
	`);

	database.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS uq_run_outcomes_run
		ON run_outcomes (repo_id, source_run_id);
	`);

	database.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS searchable_documents_fts USING fts5(
			title,
			body_text,
			content='searchable_documents',
			content_rowid='rowid'
		);
	`);

	ensureEvidenceMessageColumn(database);
	ensureRunsUsedWorkspaceColumn(database);
	ensureRunsStrategyColumns(database);
	ensureRunsAcceptanceShadowColumn(database);
	ensureRunsTrustLaneColumn(database);
	ensureRunLearningsTable(database);
	ensureSeenCountColumn(database);
	ensureRunsStepColumns(database);
	ensureRepoFactColumns(database);
	ensureProcedureColumns(database);
	assertWorkspaceTableColumns(database);
	assertCandidateArtifactsTableColumns(database);
	assertCandidatePromotionsTableColumns(database);
	assertRepoFactsTableColumns(database);
	assertProceduresTableColumns(database);
	assertSearchableDocumentsTableColumns(database);
	assertInjectedMemoriesTableColumns(database);
	assertRunOutcomesTableColumns(database);
}

export function assertBaselineStorageProjectionSchema(
	database: DatabaseSync,
): void {
	const rows = database
		.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('units', 'runs', 'evidence', 'decisions', 'artifacts', 'repo_facts', 'procedures', 'searchable_documents', 'injected_memories', 'run_outcomes')`,
		)
		.all() as unknown as { name: string }[];
	const existingTables = new Set(rows.map((row) => row.name));

	for (const tableName of [
		"units",
		"runs",
		"evidence",
		"decisions",
		"artifacts",
		"repo_facts",
		"procedures",
		"searchable_documents",
		"injected_memories",
		"run_outcomes",
	]) {
		if (!existingTables.has(tableName)) {
			throw new Error(
				"Buildplane state is incomplete: state.db is missing required projection schema. Remove .buildplane or repair the database before rerunning `buildplane init`.",
			);
		}
	}
}

export function assertInitializableStorageProjectionSchema(
	database: DatabaseSync,
): void {
	const rows = database
		.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('units', 'runs', 'evidence', 'decisions', 'artifacts')`,
		)
		.all() as unknown as { name: string }[];
	const existingTables = new Set(rows.map((row) => row.name));

	for (const tableName of [
		"units",
		"runs",
		"evidence",
		"decisions",
		"artifacts",
	]) {
		if (!existingTables.has(tableName)) {
			throw new Error(
				"Buildplane state is incomplete: state.db is missing required projection schema. Remove .buildplane or repair the database before rerunning `buildplane init`.",
			);
		}
	}
}

function assertStorageProjectionSchema(database: DatabaseSync): void {
	assertBaselineStorageProjectionSchema(database);

	if (!tableExists(database, "workspaces")) {
		throw new Error(
			"Buildplane state is incomplete: state.db is missing required projection schema. Remove .buildplane or repair the database before rerunning `buildplane init`.",
		);
	}

	for (const [tableName, columnName] of [
		["runs", "used_workspace"],
		["runs", "parent_run_id"],
		["runs", "strategy_id"],
		["runs", "acceptance_outcome"],
		["runs", "trust_lane"],
		["evidence", "message"],
	] as const) {
		if (!tableHasColumn(database, tableName, columnName)) {
			throw new Error(
				"Buildplane state is incomplete: state.db is missing required projection schema. Remove .buildplane or repair the database before rerunning `buildplane init`.",
			);
		}
	}

	assertWorkspaceTableColumns(database);
	assertRepoFactsTableColumns(database);
	assertProceduresTableColumns(database);
	assertSearchableDocumentsTableColumns(database);
	assertInjectedMemoriesTableColumns(database);
	assertRunOutcomesTableColumns(database);
}

export interface RunHistoryEntry {
	readonly id: string;
	readonly unitId: string;
	readonly status: RunStatus;
	readonly strategyId?: string;
	readonly injectedMemoryCount: number;
	readonly promotedStructuredMemoryCount: number;
	readonly routeWorker?: string;
	readonly routeSource?: "routing-hints" | "model-block" | "command-block";
	readonly policyProfile?: string;
	readonly createdAt: string;
	readonly completedAt?: string;
}

export function createStorageStore(
	projectRoot: string,
	options: CreateStorageStoreOptions = {},
): WorkspaceAwareStorageStore {
	const layout = resolveProjectLayout(projectRoot);

	function ensureInitialized(): void {
		if (
			!existsSync(layout.projectJsonPath) ||
			!existsSync(layout.stateDbPath)
		) {
			throw new Error(
				"Buildplane project is not initialized. Run `buildplane init` first.",
			);
		}

		assertBuildplaneDatabaseIsInitialized(layout.stateDbPath, projectRoot);
	}

	function openStoreDatabase() {
		const database = openBuildplaneDatabase(layout.stateDbPath);
		try {
			assertStorageProjectionSchema(database);
			return database;
		} catch (error) {
			database.close();
			throw error;
		}
	}

	function runInTransaction<T>(database: DatabaseSync, operation: () => T): T {
		// This store owns write-ahead workflow state. Reserve SQLite's writer slot
		// before any read/check/update sequence so another process cannot insert a
		// recorded promotion claim between a terminal-state check and its update.
		// Contention fails before an effect is authorized rather than admitting a
		// split terminal/promotion projection.
		database.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			database.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				database.exec("ROLLBACK");
			} catch {
				// Ignore rollback cleanup failures and surface the original error.
			}
			throw error;
		}
	}

	function hitFailpoint(name: string): void {
		options.testingHooks?.failpoint?.(name);
	}

	function promotionExecutionNow(): Date {
		const source = options.testingHooks?.now?.() ?? new Date();
		if (!(source instanceof Date) || Number.isNaN(source.getTime())) {
			throw new Error(
				"Candidate promotion execution clock must return a valid Date.",
			);
		}
		return new Date(source.getTime());
	}

	function appendEvent(
		kind: string,
		payload: Record<string, unknown>,
		database: DatabaseSync,
	): void {
		database
			.prepare(
				`INSERT INTO events (id, kind, occurred_at, payload) VALUES (?, ?, ?, ?)`,
			)
			.run(
				randomUUID(),
				kind,
				new Date().toISOString(),
				JSON.stringify(payload),
			);
	}

	function writeRunLogs(runId: string, receipt: ExecutionReceipt): void {
		// Ensure logsDir exists — it may be absent if the workspace was restored
		// from a git checkout that pre-dates the first log write (e.g. fork replay).
		mkdirSync(layout.logsDir, { recursive: true });
		writeFileSync(`${layout.logsDir}/${runId}.stdout.log`, receipt.stdout);
		writeFileSync(`${layout.logsDir}/${runId}.stderr.log`, receipt.stderr);
	}

	function persistWorkspaceArtifact(
		workspacePath: string,
		runId: string,
		outputPath: string,
	): string {
		const sourcePath = resolve(workspacePath, outputPath);
		const destinationPath = join(layout.artifactsDir, runId, outputPath);
		mkdirSync(dirname(destinationPath), { recursive: true });
		writeFileSync(destinationPath, readFileSync(sourcePath));
		// Artifact locations are persisted in receipts and therefore form part of
		// cross-host evidence. Keep the serialized form platform-neutral instead of
		// leaking the host path separator into a digest-bound record.
		return relative(projectRoot, destinationPath).replaceAll("\\", "/");
	}

	function readUnit(unitId: string, database: DatabaseSync): Unit {
		const row = database
			.prepare(
				`SELECT id, kind, scope, input_refs, expected_outputs, verification_contract, policy_profile FROM units WHERE id = ?`,
			)
			.get(unitId) as
			| {
					id: string;
					kind: string;
					scope: string;
					input_refs: string;
					expected_outputs: string;
					verification_contract: string;
					policy_profile: string;
			  }
			| undefined;

		if (!row) {
			throw new Error(`No unit found for id '${unitId}'`);
		}

		return {
			id: row.id,
			kind: row.kind,
			scope: row.scope,
			inputRefs: JSON.parse(row.input_refs) as string[],
			expectedOutputs: JSON.parse(row.expected_outputs) as string[],
			verificationContract: row.verification_contract,
			policyProfile: row.policy_profile,
		};
	}

	function readRun(runId: string, database: DatabaseSync): StoredRunRow {
		const row = database
			.prepare(
				`SELECT id, unit_id, status, unit_snapshot, used_workspace, parent_run_id, strategy_id, trust_lane FROM runs WHERE id = ?`,
			)
			.get(runId) as unknown as StoredRunRow | undefined;

		if (!row) {
			throw new Error(`No run found for id '${runId}'`);
		}

		return row;
	}

	/**
	 * Candidate artifacts may be retained for raw and historical runs, but they
	 * never acquire promotion authority. Every write-ahead or recovery path
	 * must re-read this durable lane rather than trusting the caller's packet or
	 * a previously prepared marker.
	 */
	function requireGovernedCandidatePromotionRun(
		runId: string,
		database: DatabaseSync,
		operation: string,
	): StoredRunRow {
		const run = readRun(runId, database);
		if (run.trust_lane !== "governed") {
			throw new Error(
				`${operation} requires a governed run; ${run.trust_lane} runs cannot promote candidates.`,
			);
		}
		return run;
	}

	/**
	 * A recorded promotion decision is the durable, pre-Git execution claim. A
	 * candidate may only acquire that claim while its run is active; after the
	 * claim, generic terminal/cancellation paths must leave it running so the
	 * exact candidate can be reconciled rather than accidentally promoted from a
	 * terminal run.
	 */
	function requireActiveGovernedCandidatePromotionRun(
		runId: string,
		database: DatabaseSync,
		operation: string,
	): StoredRunRow {
		const run = requireGovernedCandidatePromotionRun(
			runId,
			database,
			operation,
		);
		if (run.status !== "running") {
			throw new Error(
				`${operation} requires an active candidate run; got '${run.status}'.`,
			);
		}
		return run;
	}

	function hasRecordedCandidatePromotionClaim(
		runId: string,
		database: DatabaseSync,
	): boolean {
		if (!tableExists(database, "candidate_promotions")) return false;
		const row = database
			.prepare(
				`SELECT 1 AS claimed
				 FROM candidate_promotions
				 WHERE run_id = ? AND state = 'recorded'
				 LIMIT 1`,
			)
			.get(runId) as { claimed: number } | undefined;
		return row?.claimed === 1;
	}

	function assertNoRecordedCandidatePromotionClaim(
		runId: string,
		database: DatabaseSync,
		operation: string,
	): void {
		if (hasRecordedCandidatePromotionClaim(runId, database)) {
			throw new Error(
				`${operation} is blocked by an active candidate promotion claim; reconcile the exact candidate before cancelling or completing the run.`,
			);
		}
	}

	function readWorkspaceRow(
		runId: string,
		database: DatabaseSync,
	): StoredWorkspaceRow | undefined {
		return database
			.prepare(
				`SELECT run_id, source_project_root, path, head_sha, status, created_at, finalized_at, cleanup_error FROM workspaces WHERE run_id = ?`,
			)
			.get(runId) as unknown as StoredWorkspaceRow | undefined;
	}

	function hasCandidateArtifactsProjection(database: DatabaseSync): boolean {
		if (!tableExists(database, "candidate_artifacts")) {
			return false;
		}
		assertCandidateArtifactsTableColumns(database);
		return true;
	}

	function requireCandidateArtifactsProjection(database: DatabaseSync): void {
		if (!hasCandidateArtifactsProjection(database)) {
			throw new Error(
				"Buildplane state is missing the candidate projection schema. Run `buildplane init` before recording a candidate.",
			);
		}
	}

	function readCandidateArtifactRow(
		runId: string,
		database: DatabaseSync,
	): StoredCandidateArtifactRow | undefined {
		if (!hasCandidateArtifactsProjection(database)) {
			return undefined;
		}

		return database
			.prepare(
				`SELECT run_id, schema_version, candidate_id, candidate_key, candidate_ref, workflow_id, unit_id, attempt, provenance_ref, candidate_digest, base_commit_sha, candidate_commit_sha, commit_digest, tree_digest, patch_digest, changed_files_digest, envelope_digest, acceptance_contract_digest, action_receipt_digest, action_receipt_set_ref, action_receipt_set_digest, action_evidence_version, candidate_created_ref, created_at FROM candidate_artifacts WHERE run_id = ?`,
			)
			.get(runId) as unknown as StoredCandidateArtifactRow | undefined;
	}

	function toCandidateArtifactProjection(
		row: StoredCandidateArtifactRow,
	): CandidateArtifactProjection {
		if (row.schema_version !== 1 && row.schema_version !== 2) {
			throw new Error(
				`Unsupported stored candidate schema version '${row.schema_version}'.`,
			);
		}

		const identity = {
			runId: row.run_id,
			candidateId: row.candidate_id,
			candidateKey: row.candidate_key,
			candidateRef: row.candidate_ref,
			unitId: row.unit_id,
			attempt: row.attempt,
			candidateDigest: row.candidate_digest,
			baseSha: row.base_commit_sha,
			candidateCommitSha: row.candidate_commit_sha,
			commitDigest: row.commit_digest,
			treeDigest: row.tree_digest,
			patchDigest: row.patch_digest,
			changedFilesDigest: row.changed_files_digest,
			createdAt: row.created_at,
		};

		if (row.schema_version === 2) {
			const workflowId = readOptionalCandidateText(
				row.workflow_id ?? undefined,
				"workflowId",
			);
			const provenanceRef = readOptionalCandidateText(
				row.provenance_ref ?? undefined,
				"provenanceRef",
			);
			const envelopeDigest = readOptionalGovernedDigest(
				row.envelope_digest ?? undefined,
				"envelopeDigest",
			);
			const acceptanceContractDigest = readOptionalGovernedDigest(
				row.acceptance_contract_digest ?? undefined,
				"acceptanceContractDigest",
			);
			const actionReceiptSetRef = readOptionalCandidateText(
				row.action_receipt_set_ref ?? undefined,
				"actionReceiptSetRef",
			);
			const actionReceiptSetDigest = readOptionalGovernedDigest(
				row.action_receipt_set_digest ?? undefined,
				"actionReceiptSetDigest",
			);
			const candidateCreatedRef = readOptionalCandidateText(
				row.candidate_created_ref ?? undefined,
				"candidateCreatedRef",
			);
			if (
				(row.action_evidence_version !== "sealed-v2" &&
					row.action_evidence_version !== "sealed_v3") ||
				!workflowId ||
				!provenanceRef ||
				!envelopeDigest ||
				!acceptanceContractDigest ||
				!actionReceiptSetRef ||
				!actionReceiptSetDigest ||
				!candidateCreatedRef
			) {
				throw new Error(
					"Stored V3 candidate projection is missing required governed action-evidence lineage.",
				);
			}
			if (row.action_receipt_digest !== null) {
				throw new Error(
					"Stored V3 candidate projection must not carry a legacy actionReceiptDigest.",
				);
			}
			return {
				...identity,
				schemaVersion: 2,
				workflowId,
				provenanceRef,
				envelopeDigest,
				acceptanceContractDigest,
				actionEvidenceVersion: row.action_evidence_version,
				actionReceiptSetRef,
				actionReceiptSetDigest,
				candidateCreatedRef,
			};
		}

		if (
			row.action_receipt_set_ref !== null ||
			row.action_receipt_set_digest !== null ||
			row.action_evidence_version !== null ||
			row.candidate_created_ref !== null
		) {
			throw new Error(
				"Stored V1 candidate projection must not carry V3 action-evidence lineage.",
			);
		}

		return {
			...identity,
			schemaVersion: 1,
			...(row.workflow_id ? { workflowId: row.workflow_id } : {}),
			...(row.provenance_ref ? { provenanceRef: row.provenance_ref } : {}),
			...(row.envelope_digest ? { envelopeDigest: row.envelope_digest } : {}),
			...(row.acceptance_contract_digest
				? { acceptanceContractDigest: row.acceptance_contract_digest }
				: {}),
			...(row.action_receipt_digest
				? { actionReceiptDigest: row.action_receipt_digest }
				: {}),
		};
	}

	function readRequiredCandidateText(value: unknown, field: string): string {
		if (typeof value !== "string" || value.trim().length === 0) {
			throw new Error(`Candidate ${field} must be a non-empty string.`);
		}
		return value;
	}

	function readOptionalCandidateText(
		value: unknown,
		field: string,
	): string | undefined {
		if (value === undefined) {
			return undefined;
		}
		return readRequiredCandidateText(value, field);
	}

	function readRawCandidateDigest(value: unknown, field: string): string {
		const digest = readRequiredCandidateText(value, field);
		if (!RAW_CANDIDATE_DIGEST_PATTERN.test(digest)) {
			throw new Error(`Candidate ${field} must be a lowercase SHA-256 digest.`);
		}
		return digest;
	}

	function readOptionalGovernedDigest(
		value: unknown,
		field: string,
	): string | undefined {
		const digest = readOptionalCandidateText(value, field);
		if (digest !== undefined && !GOVERNED_DIGEST_PATTERN.test(digest)) {
			throw new Error(`Candidate ${field} must be a canonical sha256 digest.`);
		}
		return digest;
	}

	function normalizeCandidateArtifactInput(
		input: CandidateArtifactProjectionInput,
		runId: string,
		runUnitId: string,
	): CandidateArtifactProjectionInput {
		if (input.schemaVersion !== 1 && input.schemaVersion !== 2) {
			throw new Error("Candidate schemaVersion must be 1 or 2.");
		}
		if (input.runId !== runId) {
			throw new Error(
				`Candidate run '${input.runId}' does not match storage run '${runId}'.`,
			);
		}

		const unitId = readOptionalCandidateText(input.unitId, "unitId");
		if (unitId !== undefined && unitId !== runUnitId) {
			throw new Error(
				`Candidate unit '${unitId}' does not match run unit '${runUnitId}'.`,
			);
		}

		const attempt = input.attempt;
		if (!Number.isSafeInteger(attempt) || attempt <= 0) {
			throw new Error("Candidate attempt must be a positive safe integer.");
		}

		const baseSha = readRequiredCandidateText(input.baseSha, "baseSha");
		const candidateCommitSha = readRequiredCandidateText(
			input.candidateCommitSha,
			"candidateCommitSha",
		);
		const workflowId = readOptionalCandidateText(
			input.workflowId,
			"workflowId",
		);
		const provenanceRef = readOptionalCandidateText(
			input.provenanceRef,
			"provenanceRef",
		);
		const envelopeDigest = readOptionalGovernedDigest(
			input.envelopeDigest,
			"envelopeDigest",
		);
		const acceptanceContractDigest = readOptionalGovernedDigest(
			input.acceptanceContractDigest,
			"acceptanceContractDigest",
		);
		const actionReceiptDigest = readOptionalGovernedDigest(
			input.actionReceiptDigest,
			"actionReceiptDigest",
		);
		const actionEvidenceVersion = readOptionalCandidateText(
			input.actionEvidenceVersion,
			"actionEvidenceVersion",
		);
		const actionReceiptSetRef = readOptionalCandidateText(
			input.actionReceiptSetRef,
			"actionReceiptSetRef",
		);
		const actionReceiptSetDigest = readOptionalGovernedDigest(
			input.actionReceiptSetDigest,
			"actionReceiptSetDigest",
		);
		const candidateCreatedRef = readOptionalCandidateText(
			input.candidateCreatedRef,
			"candidateCreatedRef",
		);
		if (!FULL_GIT_COMMIT_SHA_PATTERN.test(baseSha)) {
			throw new Error("Candidate baseSha must be a full Git commit SHA.");
		}
		if (!FULL_GIT_COMMIT_SHA_PATTERN.test(candidateCommitSha)) {
			throw new Error(
				"Candidate candidateCommitSha must be a full Git commit SHA.",
			);
		}

		const identity = {
			runId,
			candidateId: readRequiredCandidateText(input.candidateId, "candidateId"),
			candidateKey: readRequiredCandidateText(
				input.candidateKey,
				"candidateKey",
			),
			candidateRef: readRequiredCandidateText(
				input.candidateRef,
				"candidateRef",
			),
			attempt,
			candidateDigest: readRawCandidateDigest(
				input.candidateDigest,
				"candidateDigest",
			),
			baseSha,
			candidateCommitSha,
			commitDigest: readRawCandidateDigest(input.commitDigest, "commitDigest"),
			treeDigest: readRawCandidateDigest(input.treeDigest, "treeDigest"),
			patchDigest: readRawCandidateDigest(input.patchDigest, "patchDigest"),
			changedFilesDigest: readRawCandidateDigest(
				input.changedFilesDigest,
				"changedFilesDigest",
			),
		};

		const hasV3ActionEvidence =
			actionEvidenceVersion !== undefined ||
			actionReceiptSetRef !== undefined ||
			actionReceiptSetDigest !== undefined ||
			candidateCreatedRef !== undefined;
		if (input.schemaVersion === 1) {
			if (hasV3ActionEvidence) {
				throw new Error(
					"Candidate schemaVersion 1 must not carry V3 action-evidence lineage.",
				);
			}
			return {
				...identity,
				schemaVersion: 1,
				...(workflowId ? { workflowId } : {}),
				...(provenanceRef ? { provenanceRef } : {}),
				...(envelopeDigest ? { envelopeDigest } : {}),
				...(acceptanceContractDigest ? { acceptanceContractDigest } : {}),
				...(actionReceiptDigest ? { actionReceiptDigest } : {}),
			};
		}

		if (
			actionEvidenceVersion !== "sealed-v2" &&
			actionEvidenceVersion !== "sealed_v3"
		) {
			throw new Error(
				'Candidate schemaVersion 2 requires actionEvidenceVersion "sealed-v2" or "sealed_v3".',
			);
		}
		if (
			!workflowId ||
			!provenanceRef ||
			!envelopeDigest ||
			!acceptanceContractDigest ||
			!actionReceiptSetRef ||
			!actionReceiptSetDigest ||
			!candidateCreatedRef
		) {
			throw new Error(
				"Candidate schemaVersion 2 requires governed workflow, provenance, envelope, acceptance-contract, action receipt-set, and candidate-created bindings.",
			);
		}
		if (actionReceiptDigest !== undefined) {
			throw new Error(
				"Candidate schemaVersion 2 must not carry a legacy actionReceiptDigest.",
			);
		}
		return {
			...identity,
			schemaVersion: 2,
			workflowId,
			provenanceRef,
			envelopeDigest,
			acceptanceContractDigest,
			actionEvidenceVersion,
			actionReceiptSetRef,
			actionReceiptSetDigest,
			candidateCreatedRef,
		};
	}

	function hasCandidatePromotionsProjection(database: DatabaseSync): boolean {
		if (!tableExists(database, "candidate_promotions")) {
			return false;
		}
		assertCandidatePromotionsTableColumns(database);
		return true;
	}

	function requireCandidatePromotionsProjection(database: DatabaseSync): void {
		if (!hasCandidatePromotionsProjection(database)) {
			throw new Error(
				"Buildplane state is missing the candidate-promotion projection schema. Run `buildplane init` before preparing a promotion.",
			);
		}
	}

	/**
	 * Canonical JSON for the Tier-1 intent key. This intentionally does not use
	 * `JSON.stringify` on caller objects: getters, sparse arrays, custom
	 * prototypes, and `toJSON` hooks could otherwise make duplicate detection
	 * depend on caller-controlled behavior. The result is a stable byte-for-byte
	 * representation of plain data only.
	 */
	function canonicalPromotionJson(
		value: unknown,
		stack = new Set<object>(),
	): string {
		if (value === null) {
			return "null";
		}

		switch (typeof value) {
			case "string":
				return JSON.stringify(value);
			case "boolean":
				return value ? "true" : "false";
			case "number":
				if (!Number.isFinite(value)) {
					throw new TypeError(
						"Candidate promotion intent cannot contain a non-finite number.",
					);
				}
				return JSON.stringify(value);
			case "undefined":
			case "bigint":
			case "function":
			case "symbol":
				throw new TypeError(
					"Candidate promotion intent must contain only JSON data.",
				);
			case "object":
				break;
			default:
				throw new TypeError(
					"Candidate promotion intent must contain only JSON data.",
				);
		}

		const object = value as object;
		if (stack.has(object)) {
			throw new TypeError("Candidate promotion intent cannot contain a cycle.");
		}
		if (Object.getOwnPropertySymbols(object).length > 0) {
			throw new TypeError(
				"Candidate promotion intent cannot contain symbol properties.",
			);
		}

		stack.add(object);
		try {
			if (Array.isArray(object)) {
				const ownNames = Object.getOwnPropertyNames(object);
				if (
					ownNames.length !== object.length + 1 ||
					!ownNames.includes("length")
				) {
					throw new TypeError(
						"Candidate promotion intent arrays must be dense and free of extra properties.",
					);
				}
				const items: string[] = [];
				for (let index = 0; index < object.length; index += 1) {
					const key = String(index);
					const descriptor = Object.getOwnPropertyDescriptor(object, key);
					if (
						descriptor === undefined ||
						!("value" in descriptor) ||
						!descriptor.enumerable
					) {
						throw new TypeError(
							"Candidate promotion intent arrays must contain plain values.",
						);
					}
					items.push(canonicalPromotionJson(descriptor.value, stack));
				}
				return `[${items.join(",")}]`;
			}

			const prototype = Object.getPrototypeOf(object);
			if (prototype !== Object.prototype && prototype !== null) {
				throw new TypeError(
					"Candidate promotion intent objects must use the plain object prototype.",
				);
			}

			const entries: string[] = [];
			for (const key of Object.getOwnPropertyNames(object).sort()) {
				const descriptor = Object.getOwnPropertyDescriptor(object, key);
				if (
					descriptor === undefined ||
					!("value" in descriptor) ||
					!descriptor.enumerable
				) {
					throw new TypeError(
						"Candidate promotion intent objects must contain enumerable plain values.",
					);
				}
				entries.push(
					`${JSON.stringify(key)}:${canonicalPromotionJson(descriptor.value, stack)}`,
				);
			}
			return `{${entries.join(",")}}`;
		} finally {
			stack.delete(object);
		}
	}

	function parseCanonicalPromotionJson(value: unknown, label: string): unknown {
		try {
			return JSON.parse(canonicalPromotionJson(value));
		} catch (error) {
			throw new TypeError(
				`${label} must be canonical JSON data: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	function readClosedPromotionRecord(
		value: unknown,
		label: string,
		expectedKeys: readonly string[],
	): Record<string, unknown> {
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			throw new TypeError(`${label} must be an object.`);
		}
		const record = value as Record<string, unknown>;
		const actualKeys = Object.keys(record).sort();
		const allowedKeys = [...expectedKeys].sort();
		if (
			actualKeys.length !== allowedKeys.length ||
			actualKeys.some((key, index) => key !== allowedKeys[index])
		) {
			throw new TypeError(
				`${label} must contain exactly: ${allowedKeys.join(", ")}.`,
			);
		}
		return record;
	}

	function readRequiredPromotionText(value: unknown, label: string): string {
		if (typeof value !== "string" || value.trim().length === 0) {
			throw new TypeError(`${label} must be a non-empty string.`);
		}
		return value;
	}

	function readPromotionTimestamp(value: unknown, label: string): string {
		const timestamp = readRequiredPromotionText(value, label);
		if (!timestamp.endsWith("Z") || Number.isNaN(Date.parse(timestamp))) {
			throw new TypeError(`${label} must be an RFC3339 UTC timestamp.`);
		}
		return timestamp;
	}

	function readPromotionCandidateCommitSha(
		value: unknown,
		label: string,
	): string {
		const commitSha = readRequiredPromotionText(value, label);
		if (!FULL_GIT_COMMIT_SHA_PATTERN.test(commitSha)) {
			throw new TypeError(`${label} must be a full Git commit SHA.`);
		}
		return commitSha.toLowerCase();
	}

	function parseCandidateAcceptanceRecord(
		value: unknown,
	): CandidateAcceptanceRecord {
		const record = readClosedPromotionRecord(value, "candidate acceptance", [
			"candidateDigest",
			"candidateCommitSha",
			"acceptanceRef",
			"acceptanceContractDigest",
			"outcome",
		]);
		const outcome = record.outcome;
		if (outcome !== "passed" && outcome !== "rejected") {
			throw new TypeError(
				'candidate acceptance outcome must be "passed" or "rejected".',
			);
		}
		return {
			candidateDigest: readRequiredPromotionText(
				record.candidateDigest,
				"candidate acceptance candidateDigest",
			),
			candidateCommitSha: readPromotionCandidateCommitSha(
				record.candidateCommitSha,
				"candidate acceptance candidateCommitSha",
			),
			acceptanceRef: readRequiredPromotionText(
				record.acceptanceRef,
				"candidate acceptance acceptanceRef",
			),
			acceptanceContractDigest: (() => {
				const digest = readOptionalGovernedDigest(
					record.acceptanceContractDigest,
					"candidate acceptance acceptanceContractDigest",
				);
				if (!digest) {
					throw new TypeError(
						"candidate acceptance acceptanceContractDigest must be a canonical sha256 digest.",
					);
				}
				return digest;
			})(),
			outcome,
		};
	}

	function parseCandidateReviewRecord(value: unknown): CandidateReviewRecord {
		const record = readClosedPromotionRecord(value, "candidate review", [
			"candidateDigest",
			"candidateCommitSha",
			"reviewRef",
			"verdict",
		]);
		return {
			candidateDigest: readRequiredPromotionText(
				record.candidateDigest,
				"candidate review candidateDigest",
			),
			candidateCommitSha: readPromotionCandidateCommitSha(
				record.candidateCommitSha,
				"candidate review candidateCommitSha",
			),
			reviewRef: readRequiredPromotionText(
				record.reviewRef,
				"candidate review reviewRef",
			),
			// Structural parsing deliberately does not prove that the verdict came
			// from a trusted reviewer. The signed decision port owns that check.
			verdict: parseReviewVerdictV1(record.verdict),
		};
	}

	function parsePromotionGitBinding(
		value: unknown,
		label: string,
	): PromotionGitBindingV1 {
		const record = readClosedPromotionRecord(value, label, [
			"targetRef",
			"targetHeadBeforeSha",
			"targetHeadAfterSha",
			"mergedHeadSha",
			"candidateCommitSha",
			"mergeParentShas",
			"mergedTreeSha",
			"mergedTreeDigest",
			"promotionReceiptRef",
			"worktreeSyncState",
		]);
		if (
			!Array.isArray(record.mergeParentShas) ||
			record.mergeParentShas.length !== 2
		) {
			throw new TypeError(
				`${label}.mergeParentShas must contain exactly two Git commit SHAs.`,
			);
		}
		const targetRef = readRequiredPromotionText(
			record.targetRef,
			`${label}.targetRef`,
		);
		if (!targetRef.startsWith("refs/heads/")) {
			throw new TypeError(
				`${label}.targetRef must be a canonical refs/heads branch ref.`,
			);
		}
		const targetHeadBeforeSha = readPromotionCandidateCommitSha(
			record.targetHeadBeforeSha,
			`${label}.targetHeadBeforeSha`,
		);
		const candidateCommitSha = readPromotionCandidateCommitSha(
			record.candidateCommitSha,
			`${label}.candidateCommitSha`,
		);
		const mergeParentShas = [
			readPromotionCandidateCommitSha(
				record.mergeParentShas[0],
				`${label}.mergeParentShas[0]`,
			),
			readPromotionCandidateCommitSha(
				record.mergeParentShas[1],
				`${label}.mergeParentShas[1]`,
			),
		] as const;
		if (
			mergeParentShas[0] !== targetHeadBeforeSha ||
			mergeParentShas[1] !== candidateCommitSha
		) {
			throw new TypeError(
				`${label}.mergeParentShas must bind the target base and immutable candidate commit in order.`,
			);
		}
		const mergedTreeDigest = readOptionalGovernedDigest(
			record.mergedTreeDigest,
			`${label}.mergedTreeDigest`,
		);
		if (!mergedTreeDigest) {
			throw new TypeError(
				`${label}.mergedTreeDigest must be a canonical sha256 digest.`,
			);
		}
		const promotionReceiptRef = readRequiredPromotionText(
			record.promotionReceiptRef,
			`${label}.promotionReceiptRef`,
		);
		if (!promotionReceiptRef.startsWith("refs/buildplane/promotions/")) {
			throw new TypeError(
				`${label}.promotionReceiptRef must be a candidate-keyed promotion receipt ref.`,
			);
		}
		const worktreeSyncState = record.worktreeSyncState;
		if (
			worktreeSyncState !== "pending_reconciliation" &&
			worktreeSyncState !== "root_checkout_stale" &&
			worktreeSyncState !== "target_advanced"
		) {
			throw new TypeError(
				`${label}.worktreeSyncState must be pending_reconciliation, root_checkout_stale, or target_advanced.`,
			);
		}
		return {
			targetRef,
			targetHeadBeforeSha,
			targetHeadAfterSha: readPromotionCandidateCommitSha(
				record.targetHeadAfterSha,
				`${label}.targetHeadAfterSha`,
			),
			mergedHeadSha: readPromotionCandidateCommitSha(
				record.mergedHeadSha,
				`${label}.mergedHeadSha`,
			),
			candidateCommitSha,
			mergeParentShas,
			mergedTreeSha: readPromotionCandidateCommitSha(
				record.mergedTreeSha,
				`${label}.mergedTreeSha`,
			),
			mergedTreeDigest,
			promotionReceiptRef,
			worktreeSyncState,
		};
	}

	function normalizePromotionGitBinding(
		value: unknown,
		label: string,
	): {
		readonly binding: PromotionGitBindingV1;
		readonly canonicalJson: string;
	} {
		const binding = parsePromotionGitBinding(
			parseCanonicalPromotionJson(value, label),
			label,
		);
		return {
			binding,
			canonicalJson: canonicalPromotionJson(binding),
		};
	}

	interface NormalizedCandidatePromotionIntent {
		readonly intent: CandidatePromotionIntent;
		readonly canonicalCandidateDigest: string;
		readonly idempotencyKey: string;
		readonly candidateJson: string;
		readonly decisionJson: string;
		readonly acceptanceJson: string;
		readonly reviewJson: string;
		readonly canonicalIntentJson: string;
		/** Duplicate identity deliberately excludes the write-ahead timestamp. */
		readonly canonicalIdentityJson: string;
	}

	interface StoredCandidatePromotionExecutionLease {
		readonly leaseToken: string;
		readonly claimedAt: string;
		readonly leaseExpiresAt: string;
		readonly claimEpoch: number;
	}

	function canonicalCandidatePromotionIdentity(
		intent: CandidatePromotionIntentInput,
	): string {
		return canonicalPromotionJson({
			runId: intent.runId,
			candidate: intent.candidate,
			decision: intent.decision,
			acceptance: intent.acceptance,
			review: intent.review,
		});
	}

	function normalizeCandidatePromotionIntent(
		input: CandidatePromotionIntentInput | unknown,
		database: DatabaseSync,
	): NormalizedCandidatePromotionIntent {
		const source = parseCanonicalPromotionJson(
			input,
			"Candidate promotion intent",
		);
		const record = readClosedPromotionRecord(
			source,
			"Candidate promotion intent",
			["runId", "candidate", "decision", "acceptance", "review", "preparedAt"],
		);
		const runId = readRequiredPromotionText(
			record.runId,
			"Candidate promotion runId",
		);
		const preparedAt = readPromotionTimestamp(
			record.preparedAt,
			"Candidate promotion preparedAt",
		);
		if (
			record.candidate === null ||
			typeof record.candidate !== "object" ||
			Array.isArray(record.candidate)
		) {
			throw new TypeError("Candidate promotion candidate must be an object.");
		}

		const candidateRow = readCandidateArtifactRow(runId, database);
		if (!candidateRow) {
			throw new Error(
				`No immutable candidate artifact is recorded for run '${runId}'.`,
			);
		}
		const candidate = toCandidateArtifactProjection(candidateRow);
		const candidateJson = canonicalPromotionJson(candidate);
		if (canonicalPromotionJson(record.candidate) !== candidateJson) {
			throw new Error(
				"Candidate promotion candidate must exactly match the stored immutable candidate artifact.",
			);
		}

		// Raw/legacy candidates are intentionally not promotable through this
		// protocol. Requiring governed lineage here is a consistency check only;
		// it neither verifies nor infers the envelope's signature or authority.
		const hasV1ActionLineage =
			candidate.schemaVersion === 1 &&
			candidate.actionReceiptDigest !== undefined;
		const hasV3ActionLineage =
			candidate.schemaVersion === 2 &&
			(candidate.actionEvidenceVersion === "sealed-v2" ||
				candidate.actionEvidenceVersion === "sealed_v3") &&
			candidate.actionReceiptSetRef !== undefined &&
			candidate.actionReceiptSetDigest !== undefined &&
			candidate.candidateCreatedRef !== undefined;
		if (
			!candidate.workflowId ||
			!candidate.provenanceRef ||
			!candidate.envelopeDigest ||
			!candidate.acceptanceContractDigest ||
			(!hasV1ActionLineage && !hasV3ActionLineage)
		) {
			throw new Error(
				"Candidate promotion requires a governed candidate with workflow, provenance, envelope, acceptance-contract, and version-matched action-evidence bindings.",
			);
		}

		let canonicalCandidateDigest: string;
		try {
			canonicalCandidateDigest = canonicalSha256Digest(
				candidate.candidateDigest,
			);
		} catch (error) {
			throw new TypeError(
				`Candidate promotion candidateDigest is invalid: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}

		// Parsers establish closed structural form. They do not validate signed
		// tape records, credentials, authority, or promotion policy.
		const decision = parsePromotionDecisionV1(record.decision);
		const acceptance = parseCandidateAcceptanceRecord(record.acceptance);
		const review = parseCandidateReviewRecord(record.review);
		if (
			acceptance.acceptanceContractDigest !== candidate.acceptanceContractDigest
		) {
			throw new Error(
				"Candidate acceptance acceptanceContractDigest must match the immutable candidate's signed dispatch acceptance-contract binding.",
			);
		}

		if (decision.candidateDigest !== canonicalCandidateDigest) {
			throw new Error(
				"Promotion decision candidateDigest must match the immutable candidate.",
			);
		}
		if (
			acceptance.candidateDigest !== canonicalCandidateDigest ||
			review.candidateDigest !== canonicalCandidateDigest ||
			review.verdict.candidateDigest !== canonicalCandidateDigest
		) {
			throw new Error(
				"Candidate acceptance and review records must bind the exact immutable candidate.",
			);
		}
		const canonicalCandidateCommitSha =
			candidate.candidateCommitSha.toLowerCase();
		if (
			acceptance.candidateCommitSha !== canonicalCandidateCommitSha ||
			review.candidateCommitSha !== canonicalCandidateCommitSha
		) {
			throw new Error(
				"Candidate acceptance and review records must bind the exact immutable candidate commit SHA.",
			);
		}
		if (decision.baseCommitSha !== candidate.baseSha.toLowerCase()) {
			throw new Error(
				"Promotion decision baseCommitSha must match the immutable candidate base SHA.",
			);
		}
		if (decision.envelopeDigest !== candidate.envelopeDigest) {
			throw new Error(
				"Promotion decision envelopeDigest must match the candidate envelope binding.",
			);
		}
		if (decision.acceptanceRef !== acceptance.acceptanceRef) {
			throw new Error(
				"Promotion decision acceptanceRef must match the supplied acceptance record.",
			);
		}
		if (!decision.reviewRefs.includes(review.reviewRef)) {
			throw new Error(
				"Promotion decision reviewRefs must include the supplied review record.",
			);
		}
		if (
			decision.decision === "promote" &&
			(acceptance.outcome !== "passed" || review.verdict.decision !== "approve")
		) {
			throw new Error(
				"A promotion decision requires passed acceptance and an approving review verdict.",
			);
		}

		const normalizedIntent: CandidatePromotionIntentInput = {
			runId,
			candidate,
			decision,
			acceptance,
			review,
			preparedAt,
		};
		const decisionJson = canonicalPromotionJson(decision);
		const acceptanceJson = canonicalPromotionJson(acceptance);
		const reviewJson = canonicalPromotionJson(review);
		const canonicalIntentJson = canonicalPromotionJson(normalizedIntent);
		const canonicalIdentityJson =
			canonicalCandidatePromotionIdentity(normalizedIntent);
		return {
			intent: {
				...normalizedIntent,
				state: "prepared",
			},
			canonicalCandidateDigest,
			idempotencyKey: decision.idempotencyKey,
			candidateJson,
			decisionJson,
			acceptanceJson,
			reviewJson,
			canonicalIntentJson,
			canonicalIdentityJson,
		};
	}

	function readCandidatePromotionRowsByIdentity(
		candidateDigest: string,
		idempotencyKey: string,
		database: DatabaseSync,
	): readonly StoredCandidatePromotionRow[] {
		requireCandidatePromotionsProjection(database);
		return database
			.prepare(
				`SELECT candidate_digest, idempotency_key, run_id, state, candidate_json, decision_json, acceptance_json, review_json, intent_canonical_json, prepared_at, recorded_at, executed_at, executed_outcome, merged_head_sha, promotion_git_binding_json, execution_claim_token, execution_claimed_at, execution_lease_expires_at, execution_claim_epoch
				 FROM candidate_promotions
				 WHERE candidate_digest = ? OR idempotency_key = ?
				 ORDER BY rowid ASC`,
			)
			.all(
				candidateDigest,
				idempotencyKey,
			) as unknown as StoredCandidatePromotionRow[];
	}

	function readCandidatePromotionExecutionLease(
		row: StoredCandidatePromotionRow,
	): StoredCandidatePromotionExecutionLease | null {
		if (
			!Number.isInteger(row.execution_claim_epoch) ||
			row.execution_claim_epoch < 0
		) {
			throw new Error(
				"Candidate promotion projection is corrupt: execution claim epoch is invalid.",
			);
		}

		const fields = [
			row.execution_claim_token,
			row.execution_claimed_at,
			row.execution_lease_expires_at,
		] as const;
		const present = fields.filter((field) => field !== null).length;
		if (present === 0) {
			if (row.state !== "executed" && row.execution_claim_epoch !== 0) {
				throw new Error(
					"Candidate promotion projection is corrupt: a non-terminal execution claim epoch lacks lease evidence.",
				);
			}
			return null;
		}
		if (present !== fields.length) {
			throw new Error(
				"Candidate promotion projection is corrupt: execution lease fields are incomplete.",
			);
		}
		if (row.state !== "recorded") {
			throw new Error(
				"Candidate promotion projection is corrupt: only a recorded intent may retain an execution lease.",
			);
		}
		if (
			!PROMOTION_EXECUTION_LEASE_TOKEN_PATTERN.test(
				row.execution_claim_token ?? "",
			)
		) {
			throw new Error(
				"Candidate promotion projection is corrupt: execution lease token is invalid.",
			);
		}
		const claimedAt = readPromotionTimestamp(
			row.execution_claimed_at,
			"Candidate promotion execution claimedAt",
		);
		const leaseExpiresAt = readPromotionTimestamp(
			row.execution_lease_expires_at,
			"Candidate promotion execution leaseExpiresAt",
		);
		if (Date.parse(leaseExpiresAt) <= Date.parse(claimedAt)) {
			throw new Error(
				"Candidate promotion projection is corrupt: execution lease expiry must follow its claim time.",
			);
		}
		if (row.execution_claim_epoch < 1) {
			throw new Error(
				"Candidate promotion projection is corrupt: execution lease requires a positive claim epoch.",
			);
		}
		return {
			leaseToken: row.execution_claim_token as string,
			claimedAt,
			leaseExpiresAt,
			claimEpoch: row.execution_claim_epoch,
		};
	}

	function toCandidatePromotionExecutionClaimState(
		row: StoredCandidatePromotionRow,
		now: Date,
	): CandidatePromotionExecutionClaimStateV1 {
		const lease = readCandidatePromotionExecutionLease(row);
		const identity = {
			schemaVersion: 1 as const,
			candidateDigest: row.candidate_digest,
			idempotencyKey: row.idempotency_key,
			claimEpoch: row.execution_claim_epoch,
		};
		if (row.state === "executed") {
			if (
				row.executed_at === null ||
				(row.executed_outcome !== "promoted" &&
					row.executed_outcome !== "reconciliation_required" &&
					row.executed_outcome !== "rejected")
			) {
				throw new Error(
					"Candidate promotion projection is corrupt: completed execution lacks terminal evidence.",
				);
			}
			return {
				...identity,
				state: "completed",
				executedAt: readPromotionTimestamp(
					row.executed_at,
					"Candidate promotion executedAt",
				),
				executedOutcome: row.executed_outcome,
			};
		}
		if (row.state === "prepared" || lease === null) {
			return { ...identity, state: "pending" };
		}
		return {
			...identity,
			state:
				Date.parse(lease.leaseExpiresAt) > now.getTime() ? "active" : "expired",
			claimedAt: lease.claimedAt,
			leaseExpiresAt: lease.leaseExpiresAt,
		};
	}

	function toCandidatePromotionIntent(
		row: StoredCandidatePromotionRow,
		database: DatabaseSync,
	): CandidatePromotionIntent {
		let source: unknown;
		try {
			source = JSON.parse(row.intent_canonical_json);
		} catch {
			throw new Error(
				"Candidate promotion projection is corrupt: intent_canonical_json is not valid JSON.",
			);
		}

		const normalized = normalizeCandidatePromotionIntent(source, database);
		if (
			normalized.canonicalCandidateDigest !== row.candidate_digest ||
			normalized.idempotencyKey !== row.idempotency_key ||
			normalized.intent.runId !== row.run_id ||
			normalized.candidateJson !== row.candidate_json ||
			normalized.decisionJson !== row.decision_json ||
			normalized.acceptanceJson !== row.acceptance_json ||
			normalized.reviewJson !== row.review_json ||
			normalized.canonicalIntentJson !== row.intent_canonical_json ||
			normalized.intent.preparedAt !== row.prepared_at
		) {
			throw new Error(
				"Candidate promotion projection is corrupt: durable promotion fields do not agree.",
			);
		}

		if (
			row.state !== "prepared" &&
			row.state !== "recorded" &&
			row.state !== "executed"
		) {
			throw new Error(
				`Candidate promotion projection is corrupt: unsupported state '${row.state}'.`,
			);
		}
		readCandidatePromotionExecutionLease(row);
		if (row.state === "prepared") {
			if (
				row.recorded_at !== null ||
				row.executed_at !== null ||
				row.executed_outcome !== null ||
				row.merged_head_sha !== null ||
				row.promotion_git_binding_json !== null
			) {
				throw new Error(
					"Candidate promotion projection is corrupt: a prepared intent has effect markers.",
				);
			}
			return normalized.intent;
		}
		if (row.recorded_at === null) {
			throw new Error(
				"Candidate promotion projection is corrupt: recorded intent lacks a recorded timestamp.",
			);
		}
		if (row.state === "recorded") {
			if (
				row.executed_at !== null ||
				row.executed_outcome !== null ||
				row.merged_head_sha !== null ||
				row.promotion_git_binding_json !== null
			) {
				throw new Error(
					"Candidate promotion projection is corrupt: a recorded intent has terminal effect markers.",
				);
			}
			return {
				...normalized.intent,
				state: "recorded",
			};
		}

		if (
			row.executed_at === null ||
			(row.executed_outcome !== "promoted" &&
				row.executed_outcome !== "reconciliation_required" &&
				row.executed_outcome !== "rejected")
		) {
			throw new Error(
				"Candidate promotion projection is corrupt: executed intent lacks a terminal outcome.",
			);
		}
		if (
			normalized.intent.decision.decision === "reject" &&
			row.executed_outcome !== "rejected"
		) {
			throw new Error(
				"Candidate promotion projection is corrupt: a rejected decision recorded a merge-producing terminal outcome.",
			);
		}
		if (
			(row.executed_outcome === "promoted" ||
				row.executed_outcome === "reconciliation_required") &&
			(row.merged_head_sha === null ||
				!FULL_GIT_COMMIT_SHA_PATTERN.test(row.merged_head_sha))
		) {
			throw new Error(
				"Candidate promotion projection is corrupt: promotion effect lacks a merge commit SHA.",
			);
		}
		if (
			row.executed_outcome === "rejected" &&
			(row.merged_head_sha !== null || row.promotion_git_binding_json !== null)
		) {
			throw new Error(
				"Candidate promotion projection is corrupt: rejected intent has Git promotion evidence.",
			);
		}
		const promotionGitBinding = (() => {
			if (row.promotion_git_binding_json === null) return undefined;
			let source: unknown;
			try {
				source = JSON.parse(row.promotion_git_binding_json);
			} catch {
				throw new Error(
					"Candidate promotion projection is corrupt: promotion_git_binding_json is not valid JSON.",
				);
			}
			const normalizedBinding = normalizePromotionGitBinding(
				source,
				"stored candidate promotion Git binding",
			);
			if (normalizedBinding.canonicalJson !== row.promotion_git_binding_json) {
				throw new Error(
					"Candidate promotion projection is corrupt: promotion_git_binding_json is not canonical.",
				);
			}
			return normalizedBinding.binding;
		})();
		if (
			row.executed_outcome === "reconciliation_required" &&
			promotionGitBinding === undefined
		) {
			throw new Error(
				"Candidate promotion projection is corrupt: reconciliation-required intent lacks immutable Git binding evidence.",
			);
		}
		if (promotionGitBinding) {
			if (promotionGitBinding.mergedHeadSha !== row.merged_head_sha) {
				throw new Error(
					"Candidate promotion projection is corrupt: Git binding merge SHA does not match the terminal marker.",
				);
			}
			const syncStateMatchesOutcome =
				row.executed_outcome === "promoted"
					? promotionGitBinding.worktreeSyncState === "pending_reconciliation"
					: row.executed_outcome === "reconciliation_required"
						? promotionGitBinding.worktreeSyncState === "target_advanced" ||
							promotionGitBinding.worktreeSyncState === "root_checkout_stale"
						: false;
			if (!syncStateMatchesOutcome) {
				throw new Error(
					"Candidate promotion projection is corrupt: Git binding sync state does not match the terminal outcome.",
				);
			}
			if (
				row.executed_outcome === "reconciliation_required" &&
				promotionGitBinding.worktreeSyncState === "target_advanced" &&
				promotionGitBinding.targetHeadAfterSha === row.merged_head_sha
			) {
				throw new Error(
					"Candidate promotion projection is corrupt: target-advanced reconciliation must not still point at the merge.",
				);
			}
			if (
				row.executed_outcome === "reconciliation_required" &&
				promotionGitBinding.worktreeSyncState === "root_checkout_stale" &&
				promotionGitBinding.targetHeadAfterSha !== row.merged_head_sha
			) {
				throw new Error(
					"Candidate promotion projection is corrupt: root-checkout-stale reconciliation must retain the candidate merge on the target ref.",
				);
			}
		}

		return {
			...normalized.intent,
			state: "executed",
			executedOutcome: row.executed_outcome,
			...(row.merged_head_sha ? { mergedHeadSha: row.merged_head_sha } : {}),
			...(promotionGitBinding ? { promotionGitBinding } : {}),
		};
	}

	function toWorkspaceSnapshot(row: StoredWorkspaceRow): WorkspaceSnapshot {
		return {
			runId: row.run_id,
			path: row.path,
			headSha: row.head_sha,
			status: row.status,
			finalizedAt: row.finalized_at ?? undefined,
			cleanupError: row.cleanup_error ?? undefined,
		};
	}

	function toStatusWorkspaceSummary(
		row: StoredWorkspaceRow,
	): StatusWorkspaceSummary {
		return {
			runId: row.run_id,
			path: row.path,
			headSha: row.head_sha,
			status: row.status,
			finalizedAt: row.finalized_at ?? undefined,
			cleanupError: row.cleanup_error ?? undefined,
		};
	}

	function toRun(row: StoredRunRow) {
		return {
			id: row.id,
			unitId: row.unit_id,
			status: row.status,
			...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
		};
	}

	function toStrategySummary(row: StoredRunRow):
		| {
				readonly strategyId: string;
		  }
		| undefined {
		return row.strategy_id ? { strategyId: row.strategy_id } : undefined;
	}

	function countInjectedMemories(
		runId: string,
		database: DatabaseSync,
	): number {
		return readInjectedMemoryRows(runId, database).length;
	}

	function countPromotedStructuredMemories(
		runId: string,
		database: DatabaseSync,
	): number {
		return readPromotedStructuredMemoryRows(runId, database).length;
	}

	function toRepoFact(row: StoredRepoFactRow): RepoFact {
		return {
			id: row.id,
			memoryType: "repo-fact",
			scopeType: row.scope_type,
			scopeKey: row.scope_key ?? undefined,
			status: row.status,
			factKey: row.fact_key,
			valueType: row.value_type,
			factValue: JSON.parse(row.fact_value_json) as unknown,
			validFromCommit: row.valid_from_commit ?? undefined,
			validToCommit: row.valid_to_commit ?? undefined,
			provenance: {
				sourceRunId: row.source_run_id ?? undefined,
				sourceTaskId: row.source_task_id ?? undefined,
				createdBy: row.created_by,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				confidence: row.confidence,
				repoId: row.repo_id,
				branch: row.branch ?? undefined,
				commitSha: row.commit_sha ?? undefined,
			},
		};
	}

	function toRunOutcome(row: StoredRunOutcomeRow): RunOutcome {
		return {
			id: row.id,
			repoId: row.repo_id,
			taskType: row.task_type,
			worker: row.worker,
			success: row.success !== 0,
			sourceRunId: row.source_run_id,
			createdAt: row.created_at,
		};
	}

	function parseProcedureMetadata(
		row: StoredProcedureRow,
	): Record<string, unknown> | undefined {
		return row.metadata_json
			? (JSON.parse(row.metadata_json) as Record<string, unknown>)
			: undefined;
	}

	function summarizeProcedureBodyMarkdown(
		bodyMarkdown: string,
	): string | undefined {
		const firstLine =
			bodyMarkdown
				.split(/\r?\n/)
				.map((line) => line.trim())
				.find((line) => line.length > 0) ?? "";
		const summary = firstLine
			.replace(/^[-*]\s+/, "")
			.replace(/^\d+\.\s+/, "")
			.trim();
		return summary.length > 0 ? summary : undefined;
	}

	function toProcedureMemory(row: StoredProcedureRow): ProcedureMemory {
		return {
			id: row.id,
			memoryType: "procedure",
			scopeType: "repo",
			scopeKey: undefined,
			status: row.status,
			name: row.name,
			taskType: row.task_type ?? undefined,
			bodyMarkdown: row.body_markdown,
			metadata: parseProcedureMetadata(row),
			provenance: {
				sourceRunId: row.source_run_id ?? undefined,
				sourceTaskId: row.source_task_id ?? undefined,
				createdBy: row.created_by,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				confidence: row.confidence,
				repoId: row.repo_id ?? undefined,
				branch: row.branch ?? undefined,
				commitSha: row.commit_sha ?? undefined,
			},
		};
	}

	function toPromotedStructuredMemoryRecord(
		row: StoredProcedureRow,
	): PromotedStructuredMemoryRecord | null {
		const metadata = parseProcedureMetadata(row);
		const promotionRule = metadata?.promotionRule;
		if (typeof promotionRule !== "string" || promotionRule.length === 0) {
			return null;
		}
		return {
			memoryKind: "procedure",
			memoryId: row.id,
			title: row.name,
			taskType: row.task_type ?? undefined,
			bodySummary: summarizeProcedureBodyMarkdown(row.body_markdown),
			status: row.status,
			promotionRule,
			sourceRunId: row.source_run_id ?? undefined,
			sourceTaskId: row.source_task_id ?? undefined,
			createdAt: row.created_at,
		};
	}

	function procedureMetadataMatches(
		row: StoredProcedureRow,
		matchMetadata?: Record<string, string>,
	): boolean {
		if (!matchMetadata || Object.keys(matchMetadata).length === 0) {
			return true;
		}
		const metadata = parseProcedureMetadata(row) ?? {};
		return Object.entries(matchMetadata).every(
			([key, value]) => metadata[key] === value,
		);
	}

	function insertProcedureRow(
		database: DatabaseSync,
		input: CreateProcedureInput,
		now: string,
	): string {
		const id = randomUUID();
		database
			.prepare(
				`INSERT INTO procedures (id, repo_id, name, task_type, body_markdown, metadata_json, confidence, source_run_id, source_task_id, created_by, branch, commit_sha, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
			)
			.run(
				id,
				projectRoot,
				input.name,
				input.taskType ?? null,
				input.bodyMarkdown,
				input.metadata ? JSON.stringify(input.metadata) : null,
				input.confidence ?? 1,
				input.sourceRunId ?? null,
				input.sourceTaskId ?? null,
				input.createdBy,
				input.branch ?? null,
				input.commitSha ?? null,
				now,
				now,
			);
		return id;
	}

	function toSearchableDocument(
		row: StoredSearchableDocumentRow,
	): SearchableDocument {
		return {
			id: row.id,
			repoId: row.repo_id,
			sourceTable: row.source_table ?? "",
			sourceId: row.source_id ?? "",
			documentKind: row.document_kind,
			title: row.title ?? undefined,
			bodyText: row.body_text,
			metadata: row.metadata_json
				? (JSON.parse(row.metadata_json) as Record<string, unknown>)
				: undefined,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	function toPersistedInjectedMemoryRecord(
		row: StoredInjectedMemoryRow,
	): PersistedInjectedMemoryRecord {
		return {
			id: row.id,
			runId: row.run_id,
			memoryKind: row.memory_kind,
			memoryId: row.memory_id,
			displayText: row.display_text,
			matchReason: row.match_reason,
			matchClass: row.match_class,
			scopePreferenceIndex: row.scope_preference_index ?? undefined,
			createdAt: row.created_at,
		};
	}

	function readInjectedMemoryRows(
		runId: string,
		database: DatabaseSync,
	): PersistedInjectedMemoryRecord[] {
		const rows = database
			.prepare(
				`SELECT id, run_id, memory_kind, memory_id, display_text, match_reason, match_class, scope_preference_index, created_at
				 FROM injected_memories
				 WHERE run_id = ?
				 ORDER BY rowid ASC`,
			)
			.all(runId) as unknown as StoredInjectedMemoryRow[];
		return rows.map(toPersistedInjectedMemoryRecord);
	}

	function readRepoFactRows(
		database: DatabaseSync,
		options: {
			factKey?: string;
			scopeType?: MemoryScopeType;
			scopeKey?: string;
			branch?: string;
			includeInactive?: boolean;
		},
	): StoredRepoFactRow[] {
		const clauses = ["repo_id = ?"];
		const params: (string | null)[] = [projectRoot];

		if (options.factKey) {
			clauses.push("fact_key = ?");
			params.push(options.factKey);
		}
		if (options.scopeType) {
			clauses.push("scope_type = ?");
			params.push(options.scopeType);
		}
		if (options.scopeKey !== undefined) {
			if (options.scopeKey === "") {
				clauses.push("scope_key = ''");
			} else {
				clauses.push("scope_key = ?");
				params.push(options.scopeKey);
			}
		} else if (options.scopeType === "repo" || options.scopeType === "global") {
			clauses.push("scope_key IS NULL");
		}
		if (options.branch !== undefined) {
			clauses.push("(branch = ? OR branch IS NULL)");
			params.push(options.branch);
		}
		if (!options.includeInactive) {
			clauses.push("status = 'active'");
		}

		const query = `
			SELECT id, repo_id, fact_key, fact_value_json, value_type, scope_type, scope_key,
			       confidence, source_run_id, source_task_id, created_by, branch, commit_sha,
			       status, valid_from_commit, valid_to_commit, created_at, updated_at
			FROM repo_facts
			WHERE ${clauses.join(" AND ")}
			ORDER BY updated_at DESC, created_at DESC
		`;

		return database
			.prepare(query)
			.all(...params) as unknown as StoredRepoFactRow[];
	}

	function readProcedureRows(
		database: DatabaseSync,
		options: {
			id?: string;
			name?: string;
			taskType?: string;
			includeInactive?: boolean;
		},
	): StoredProcedureRow[] {
		const clauses = ["repo_id = ?"];
		const params: (string | null)[] = [projectRoot];

		if (options.id) {
			clauses.push("id = ?");
			params.push(options.id);
		}
		if (options.name) {
			clauses.push("name = ?");
			params.push(options.name);
		}
		if (options.taskType) {
			clauses.push("task_type = ?");
			params.push(options.taskType);
		}
		if (!options.includeInactive) {
			clauses.push("status = 'active'");
		}

		const query = `
			SELECT id, repo_id, name, task_type, body_markdown, metadata_json,
			       confidence, source_run_id, source_task_id, created_by, branch,
			       commit_sha, status, created_at, updated_at
			FROM procedures
			WHERE ${clauses.join(" AND ")}
			ORDER BY updated_at DESC, created_at DESC
		`;

		return database
			.prepare(query)
			.all(...params) as unknown as StoredProcedureRow[];
	}

	function readPromotedStructuredMemoryRows(
		runId: string,
		database: DatabaseSync,
	): PromotedStructuredMemoryRecord[] {
		const rows = database
			.prepare(
				`SELECT id, repo_id, name, task_type, body_markdown, metadata_json,
				       confidence, source_run_id, source_task_id, created_by, branch,
				       commit_sha, status, created_at, updated_at
				 FROM procedures
				 WHERE repo_id = ? AND source_run_id = ?
				 ORDER BY created_at DESC, rowid DESC`,
			)
			.all(projectRoot, runId) as unknown as StoredProcedureRow[];
		return rows
			.map(toPromotedStructuredMemoryRecord)
			.filter((row): row is PromotedStructuredMemoryRecord => row !== null);
	}

	function readSearchableDocumentRows(
		database: DatabaseSync,
		options: {
			id?: string;
			documentKind?: string;
			sourceTable?: string;
			sourceId?: string;
			limit?: number;
		},
	): StoredSearchableDocumentRow[] {
		const clauses = ["repo_id = ?"];
		const params: (string | number | null)[] = [projectRoot];

		if (options.id) {
			clauses.push("id = ?");
			params.push(options.id);
		}
		if (options.documentKind) {
			clauses.push("document_kind = ?");
			params.push(options.documentKind);
		}
		if (options.sourceTable) {
			clauses.push("source_table = ?");
			params.push(options.sourceTable);
		}
		if (options.sourceId) {
			clauses.push("source_id = ?");
			params.push(options.sourceId);
		}
		const limitClause = options.limit ? "LIMIT ?" : "";
		if (options.limit) {
			params.push(options.limit);
		}

		const query = `
			SELECT id, repo_id, source_table, source_id, document_kind, title,
			       body_text, metadata_json, created_at, updated_at
			FROM searchable_documents
			WHERE ${clauses.join(" AND ")}
			ORDER BY updated_at DESC, created_at DESC
			${limitClause}
		`;

		return database
			.prepare(query)
			.all(...params) as unknown as StoredSearchableDocumentRow[];
	}

	function searchSearchableDocumentRows(
		database: DatabaseSync,
		queryText: string,
		options?: {
			documentKind?: string;
			limit?: number;
		},
	): StoredSearchableDocumentRow[] {
		const ftsQuery = normalizeSearchableDocumentFtsQuery(queryText);
		if (!ftsQuery) {
			return [];
		}
		const clauses = [
			"searchable_documents.repo_id = ?",
			"searchable_documents_fts MATCH ?",
		];
		const params: (string | number)[] = [projectRoot, ftsQuery];

		if (options?.documentKind) {
			clauses.push("searchable_documents.document_kind = ?");
			params.push(options.documentKind);
		}
		params.push(options?.limit ?? 20);

		const query = `
			SELECT searchable_documents.id, searchable_documents.repo_id,
			       searchable_documents.source_table, searchable_documents.source_id,
			       searchable_documents.document_kind, searchable_documents.title,
			       searchable_documents.body_text, searchable_documents.metadata_json,
			       searchable_documents.created_at, searchable_documents.updated_at
			FROM searchable_documents_fts
			JOIN searchable_documents
			  ON searchable_documents.rowid = searchable_documents_fts.rowid
			WHERE ${clauses.join(" AND ")}
			ORDER BY bm25(searchable_documents_fts), searchable_documents.updated_at DESC
			LIMIT ?
		`;

		return database
			.prepare(query)
			.all(...params) as unknown as StoredSearchableDocumentRow[];
	}

	function defaultRepoFactScope(options?: {
		scopeType?: MemoryScopeType;
		scopeKey?: string;
	}): { scopeType: MemoryScopeType; scopeKey?: string } {
		return {
			scopeType: options?.scopeType ?? "repo",
			scopeKey: options?.scopeKey,
		};
	}

	function assertScopeKeyForExactLookup(
		scopeType: MemoryScopeType,
		scopeKey?: string,
	): void {
		const hasScopeKey = scopeKey !== undefined;
		const hasNonEmptyScopeKey = scopeKey !== undefined && scopeKey.length > 0;

		if (
			scopeType !== "repo" &&
			scopeType !== "global" &&
			!hasNonEmptyScopeKey
		) {
			throw new Error(
				`Exact scoped repo fact lookup for '${scopeType}' requires a scope key.`,
			);
		}
		if ((scopeType === "repo" || scopeType === "global") && hasScopeKey) {
			throw new Error(
				`Scope '${scopeType}' does not accept a scope key for exact repo fact operations.`,
			);
		}
	}

	function assertRepoFactListFilter(options?: {
		scopeType?: MemoryScopeType;
		scopeKey?: string;
	}): void {
		const hasScopeKey = options?.scopeKey !== undefined;

		if (hasScopeKey && !options?.scopeType) {
			throw new Error(
				"Listing repo facts by scope key requires a matching scope type.",
			);
		}
		if (
			hasScopeKey &&
			(options?.scopeType === "repo" || options?.scopeType === "global")
		) {
			throw new Error(
				`Scope '${options.scopeType}' does not accept a scope key for repo fact filters.`,
			);
		}
	}

	function normalizeExactText(value?: string): string | undefined {
		const trimmed = value?.trim();
		return trimmed ? trimmed : undefined;
	}

	function normalizeSearchableDocumentFtsQuery(
		queryText: string,
	): string | undefined {
		const trimmed = queryText.trim();
		if (!trimmed) {
			return undefined;
		}
		const tokens = Array.from(new Set(trimmed.match(/[A-Za-z0-9_]+/g) ?? []));
		if (tokens.length === 0) {
			return undefined;
		}
		return tokens.map((token) => `"${token}"`).join(" ");
	}

	function normalizeRetrievalLimit(limit?: number): number {
		if (limit === undefined || !Number.isFinite(limit)) {
			return 20;
		}
		return Math.max(0, Math.floor(limit));
	}

	function includesCaseInsensitive(
		value: string | null | undefined,
		searchText: string,
	): boolean {
		return (value ?? "").toLowerCase().includes(searchText.toLowerCase());
	}

	function normalizeRepoFactScopeCandidates(
		scopeCandidates?: readonly RepoFactScopeCandidate[],
	): readonly RepoFactScopeCandidate[] | undefined {
		if (!scopeCandidates || scopeCandidates.length === 0) {
			return undefined;
		}

		for (const candidate of scopeCandidates) {
			assertScopeKeyForExactLookup(candidate.scopeType, candidate.scopeKey);
		}

		return scopeCandidates;
	}

	function repoFactMatchesScopeCandidate(
		row: StoredRepoFactRow,
		candidate: RepoFactScopeCandidate,
	): boolean {
		if (row.scope_type !== candidate.scopeType) {
			return false;
		}
		if (candidate.scopeType === "repo" || candidate.scopeType === "global") {
			return row.scope_key === null;
		}
		return row.scope_key === candidate.scopeKey;
	}

	function toRankedRepoFactResult(
		row: StoredRepoFactRow,
		reason: RankedRepoFactResult["reason"],
		scopePreferenceIndex?: number,
	): RankedRepoFactResult {
		return createRankedMemoryResult({
			item: toRepoFact(row),
			reason,
			confidence: row.confidence,
			updatedAt: row.updated_at,
			scopePreferenceIndex,
		});
	}

	function toRankedProcedureResult(
		row: StoredProcedureRow,
		reason: RankedProcedureResult["reason"],
	): RankedProcedureResult {
		return createRankedMemoryResult({
			item: toProcedureMemory(row),
			reason,
			confidence: row.confidence,
			updatedAt: row.updated_at,
		});
	}

	function toRankedSearchableDocumentResult(
		row: StoredSearchableDocumentRow,
		reason: RankedSearchableDocumentResult["reason"],
	): RankedSearchableDocumentResult {
		return createRankedMemoryResult({
			item: toSearchableDocument(row),
			reason,
			confidence: 1,
			updatedAt: row.updated_at,
		});
	}

	function readActiveRepoFactRows(
		database: DatabaseSync,
		scopeCandidates?: readonly RepoFactScopeCandidate[],
		branch?: string,
	): StoredRepoFactRow[] {
		const rows = readRepoFactRows(database, { branch });
		if (!scopeCandidates || scopeCandidates.length === 0) {
			return rows;
		}
		return rows.filter((row) =>
			scopeCandidates.some((candidate) =>
				repoFactMatchesScopeCandidate(row, candidate),
			),
		);
	}

	function readExactRepoFactMatches(
		database: DatabaseSync,
		factKey: string,
		scopeCandidates?: readonly RepoFactScopeCandidate[],
		branch?: string,
	): RankedRepoFactResult[] {
		if (!scopeCandidates || scopeCandidates.length === 0) {
			return readRepoFactRows(database, { factKey, branch }).map((row) =>
				toRankedRepoFactResult(row, "exact-fact-key"),
			);
		}

		const results: RankedRepoFactResult[] = [];
		for (
			let scopePreferenceIndex = 0;
			scopePreferenceIndex < scopeCandidates.length;
			scopePreferenceIndex += 1
		) {
			const candidate = scopeCandidates[
				scopePreferenceIndex
			] as RepoFactScopeCandidate;
			for (const row of readRepoFactRows(database, {
				factKey,
				scopeType: candidate.scopeType,
				scopeKey: candidate.scopeKey,
				branch,
			})) {
				results.push(
					toRankedRepoFactResult(row, "exact-fact-key", scopePreferenceIndex),
				);
			}
		}
		return results;
	}

	function readFuzzyRepoFactMatches(
		database: DatabaseSync,
		searchText: string,
		scopeCandidates?: readonly RepoFactScopeCandidate[],
		branch?: string,
	): RankedRepoFactResult[] {
		return readActiveRepoFactRows(database, scopeCandidates, branch)
			.map((row) => {
				if (includesCaseInsensitive(row.fact_key, searchText)) {
					return toRankedRepoFactResult(row, "fuzzy-fact-key");
				}
				if (includesCaseInsensitive(row.fact_value_json, searchText)) {
					return toRankedRepoFactResult(row, "fuzzy-fact-value");
				}
				return undefined;
			})
			.filter((result): result is RankedRepoFactResult => result !== undefined);
	}

	function readRankedProcedureMatches(
		database: DatabaseSync,
		query: ProcedureRetrievalQuery,
	): RankedProcedureResult[] {
		const exactName = normalizeExactText(query.name);
		const exactTaskType = normalizeExactText(query.taskType);
		const searchText = normalizeExactText(query.searchText);
		const results: RankedProcedureResult[] = [];

		for (const row of readProcedureRows(database, {})) {
			if (exactName && row.name === exactName) {
				results.push(toRankedProcedureResult(row, "exact-name"));
			}
			if (exactTaskType && row.task_type === exactTaskType) {
				results.push(toRankedProcedureResult(row, "exact-task-type"));
			}
			if (searchText && includesCaseInsensitive(row.name, searchText)) {
				results.push(toRankedProcedureResult(row, "fuzzy-name"));
			}
			if (
				searchText &&
				includesCaseInsensitive(row.body_markdown, searchText)
			) {
				results.push(toRankedProcedureResult(row, "fuzzy-body"));
			}
		}

		return results;
	}

	function readRankedSearchableDocumentMatches(
		database: DatabaseSync,
		query: SearchableDocumentRetrievalQuery,
	): RankedSearchableDocumentResult[] {
		const exactTitle = normalizeExactText(query.title);
		const searchText = normalizeExactText(query.searchText);
		const hasExactSource = Boolean(query.sourceTable && query.sourceId);
		const results: RankedSearchableDocumentResult[] = [];

		if (hasExactSource) {
			for (const row of readSearchableDocumentRows(database, {
				documentKind: query.documentKind,
				sourceTable: query.sourceTable,
				sourceId: query.sourceId,
			})) {
				results.push(toRankedSearchableDocumentResult(row, "exact-source"));
			}
		}

		if (exactTitle) {
			for (const row of readSearchableDocumentRows(database, {
				documentKind: query.documentKind,
			})) {
				if (row.title === exactTitle) {
					results.push(toRankedSearchableDocumentResult(row, "exact-title"));
				}
			}
		}

		if (searchText) {
			for (const row of searchSearchableDocumentRows(database, searchText, {
				documentKind: query.documentKind,
				limit: Math.max(normalizeRetrievalLimit(query.limit) * 5, 20),
			})) {
				results.push(
					toRankedSearchableDocumentResult(row, "full-text-document"),
				);
			}
		}

		return results;
	}

	function readEvidence(
		runId: string,
		database: DatabaseSync,
	): InspectSnapshot["evidence"] {
		const rows = database
			.prepare(
				`SELECT id, kind, status, message FROM evidence WHERE run_id = ? ORDER BY rowid ASC`,
			)
			.all(runId) as {
			id: string;
			kind: string;
			status: string;
			message: string | null;
		}[];

		return rows.map((row) => ({
			id: row.id,
			kind: row.kind,
			status: row.status,
			message: row.message ?? undefined,
		}));
	}

	function readDecisions(
		runId: string,
		database: DatabaseSync,
	): InspectSnapshot["decisions"] {
		const rows = database
			.prepare(
				`SELECT id, kind, outcome, reasons FROM decisions WHERE run_id = ? ORDER BY rowid ASC`,
			)
			.all(runId) as unknown as StoredDecisionRow[];

		return rows.map((row) => ({
			id: row.id,
			kind: row.kind,
			outcome: row.outcome,
			reasons: JSON.parse(row.reasons) as string[],
		}));
	}

	function readArtifacts(
		runId: string,
		database: DatabaseSync,
	): InspectSnapshot["artifacts"] {
		return database
			.prepare(
				`SELECT id, type, location FROM artifacts WHERE run_id = ? ORDER BY rowid ASC`,
			)
			.all(runId) as unknown as InspectSnapshot["artifacts"];
	}

	function readRunHistory(
		unitId: string,
		database: DatabaseSync,
	): InspectSnapshot["runHistory"] {
		const rows = database
			.prepare(
				`SELECT id, status FROM runs WHERE unit_id = ? ORDER BY created_at DESC, rowid DESC`,
			)
			.all(unitId) as unknown as InspectSnapshot["runHistory"];

		return rows;
	}

	function summarizeEvent(
		kind: string,
		payload: Record<string, unknown>,
	): string {
		switch (kind) {
			case "run-created":
				return `created unit ${String(payload.unitId ?? "unknown")}`;
			case "run-started":
				return `started unit ${String(payload.unitId ?? "unknown")}`;
			case "execution-evidence-recorded": {
				const exitCode = payload.exitCode ?? "unknown";
				const outputChecks = Array.isArray(payload.outputChecks)
					? payload.outputChecks.length
					: 0;
				const sideEffects = Array.isArray(payload.sideEffects)
					? payload.sideEffects.length
					: 0;
				return `execution exit ${String(exitCode)} with ${outputChecks} output checks and ${sideEffects} side effects`;
			}
			case "decision-recorded":
				return `${String(payload.kind ?? "decision")} ${String(payload.outcome ?? "unknown")}`;
			case "run-completed":
				return `completed ${String(payload.status ?? "unknown")}`;
			default:
				return kind;
		}
	}

	function parseEventPayload(payload: string): Record<string, unknown> {
		try {
			const parsed = JSON.parse(payload) as unknown;
			return parsed && typeof parsed === "object"
				? (parsed as Record<string, unknown>)
				: {};
		} catch {
			return {};
		}
	}

	type EventMetadata = NonNullable<
		NonNullable<InspectSnapshot["eventTape"]>["events"][number]["metadata"]
	>;

	function isEventMetadataValue(
		value: unknown,
	): value is string | number | boolean {
		return (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		);
	}

	function clipEventMetadataText(value: string, maxLength = 120): string {
		return value.length <= maxLength
			? value
			: `${value.slice(0, Math.max(maxLength - 1, 0))}…`;
	}

	function extractEventMetadata(
		kind: string,
		payload: Record<string, unknown>,
	): EventMetadata | undefined {
		const metadata: Record<string, string | number | boolean> = {};

		for (const [key, value] of Object.entries(payload)) {
			if (key === "runId") {
				continue;
			}

			if (isEventMetadataValue(value)) {
				metadata[key] =
					typeof value === "string" ? clipEventMetadataText(value) : value;
				continue;
			}

			if (Array.isArray(value)) {
				metadata[`${key}Count`] = value.length;
				if (
					key !== "reasons" &&
					value.length > 0 &&
					value.every((item) => typeof item === "string")
				) {
					metadata[`${key}Preview`] = clipEventMetadataText(
						(value as string[]).slice(0, 2).join("; "),
					);
				}
			}
		}

		if (
			kind === "execution-evidence-recorded" &&
			Array.isArray(payload.outputChecks)
		) {
			const failedOutputChecks = payload.outputChecks.filter((check) => {
				return (
					check !== null &&
					typeof check === "object" &&
					(check as { exists?: unknown }).exists === false
				);
			}).length;
			metadata.failedOutputChecks = failedOutputChecks;
		}

		if (kind === "decision-recorded" && Array.isArray(payload.reasons)) {
			const firstReason = payload.reasons.find(
				(reason) => typeof reason === "string",
			) as string | undefined;
			if (firstReason) {
				metadata.reasonPreview = clipEventMetadataText(firstReason);
			}
		}

		return Object.keys(metadata).length > 0 ? metadata : undefined;
	}

	function readEventTapeSummary(
		runId: string,
		database: DatabaseSync,
	): InspectSnapshot["eventTape"] {
		const rows = database
			.prepare(
				`SELECT id, kind, occurred_at, payload FROM events WHERE json_extract(payload, '$.runId') = ? ORDER BY occurred_at ASC, rowid ASC`,
			)
			.all(runId) as unknown as StoredInspectEventRow[];

		if (rows.length === 0) {
			return undefined;
		}

		const events = rows.map((row) => {
			const payload = parseEventPayload(row.payload);
			const metadata = extractEventMetadata(row.kind, payload);
			return {
				id: row.id,
				kind: row.kind,
				occurredAt: row.occurred_at,
				summary: summarizeEvent(row.kind, payload),
				...(metadata ? { metadata } : {}),
			};
		});

		const completedRow = rows
			.slice()
			.reverse()
			.find((row) => row.kind === "run-completed");
		const completedPayload = completedRow
			? parseEventPayload(completedRow.payload)
			: {};

		const kindCountsByKind = new Map<string, number>();
		for (const event of events) {
			kindCountsByKind.set(
				event.kind,
				(kindCountsByKind.get(event.kind) ?? 0) + 1,
			);
		}
		const kindCounts = Array.from(kindCountsByKind.entries()).map(
			([kind, count]) => ({ kind, count }),
		);
		const terminalStatus =
			typeof completedPayload.status === "string" &&
			[
				"pending",
				"running",
				"passed",
				"failed",
				"cancelled",
				"suspended",
			].includes(completedPayload.status)
				? (completedPayload.status as RunStatus)
				: undefined;

		return {
			runId,
			eventCount: events.length,
			firstKind: events[0]?.kind,
			lastKind: events[events.length - 1]?.kind,
			firstOccurredAt: events[0]?.occurredAt,
			lastOccurredAt: events[events.length - 1]?.occurredAt,
			kindCounts,
			...(terminalStatus ? { terminalStatus } : {}),
			events,
		};
	}

	function buildInspectProvenance(
		packet: UnitPacket | null,
		unit: Unit,
		injectedMemories: readonly PersistedInjectedMemoryRecord[],
		decisions: InspectSnapshot["decisions"],
	): NonNullable<InspectSnapshot["provenance"]> {
		const routingHints = packet?.routingHints;
		const model = packet?.model;
		const isCommandExecution = Boolean(packet?.execution);
		const isModelRoute = Boolean(model) || unit.kind === "model";
		const source = isCommandExecution
			? "command-block"
			: routingHints?.preferredWorker
				? "routing-hints"
				: isModelRoute
					? "model-block"
					: "command-block";
		const worker = isCommandExecution
			? "command"
			: (routingHints?.preferredWorker ??
				(isModelRoute ? "ai-sdk" : "command"));
		const matchReasons = [
			...new Set(injectedMemories.map((m) => m.matchReason)),
		];
		const matchClasses = [
			...new Set(injectedMemories.map((m) => m.matchClass)),
		];
		const policyDecisions = decisions.map((decision) => ({
			kind: decision.kind,
			outcome: decision.outcome,
			reasons: decision.reasons,
		}));

		return {
			route: {
				worker,
				source,
				...(routingHints?.preferredWorker
					? { preferredWorker: routingHints.preferredWorker }
					: {}),
				...(routingHints?.preferredModel
					? { preferredModel: routingHints.preferredModel }
					: {}),
				...(routingHints?.effort ? { effort: routingHints.effort } : {}),
				...(model?.provider ? { provider: model.provider } : {}),
				...(model?.model ? { model: model.model } : {}),
			},
			...(injectedMemories.length > 0
				? {
						memory: {
							injectedCount: injectedMemories.length,
							matchReasons,
							matchClasses,
						},
					}
				: {}),
			policy: {
				profile: unit.policyProfile,
				...(policyDecisions.length > 0 ? { decisions: policyDecisions } : {}),
			},
		};
	}

	function readWorkspaceSnapshot(
		runId: string,
		database: DatabaseSync,
	): WorkspaceSnapshot | undefined {
		const row = readWorkspaceRow(runId, database);
		return row ? toWorkspaceSnapshot(row) : undefined;
	}

	function insertDecisionRecord(
		runId: string,
		decision: PolicyDecision,
		database: DatabaseSync,
	): void {
		database
			.prepare(
				`INSERT INTO decisions (id, run_id, kind, outcome, reasons) VALUES (?, ?, ?, ?, ?)`,
			)
			.run(
				randomUUID(),
				runId,
				decision.kind,
				decision.outcome,
				JSON.stringify(decision.reasons),
			);
		appendEvent(
			"decision-recorded",
			{
				runId,
				kind: decision.kind,
				outcome: decision.outcome,
				reasons: decision.reasons,
			},
			database,
		);
	}

	return {
		createRun(packet: UnitPacket, options?: CreateRunOptions) {
			ensureInitialized();
			const database = openStoreDatabase();
			const createdAt = new Date().toISOString();
			const runId = options?.runId ?? randomUUID();
			const parentRunId = options?.parentRunId ?? null;
			const strategyId = options?.strategyId ?? null;
			const trustLane = options?.trustLane ?? "legacy";
			if (
				trustLane !== "legacy" &&
				trustLane !== "unsafe" &&
				trustLane !== "governed"
			) {
				throw new Error(`Unsupported run trust lane '${String(trustLane)}'.`);
			}

			try {
				database
					.prepare(
						`INSERT OR REPLACE INTO units (id, kind, scope, input_refs, expected_outputs, verification_contract, policy_profile) VALUES (?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						packet.unit.id,
						packet.unit.kind,
						packet.unit.scope,
						JSON.stringify(packet.unit.inputRefs),
						JSON.stringify(packet.unit.expectedOutputs),
						packet.unit.verificationContract,
						packet.unit.policyProfile,
					);

				database
					.prepare(
						`INSERT INTO runs (id, unit_id, status, unit_snapshot, created_at, updated_at, completed_at, used_workspace, parent_run_id, strategy_id, trust_lane) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?)`,
					)
					.run(
						runId,
						packet.unit.id,
						"pending",
						JSON.stringify(packet),
						createdAt,
						createdAt,
						parentRunId,
						strategyId,
						trustLane,
					);

				appendEvent(
					"run-created",
					{
						runId,
						unitId: packet.unit.id,
						status: "pending",
						trustLane,
					},
					database,
				);

				return {
					id: runId,
					unitId: packet.unit.id,
					status: "pending",
				};
			} finally {
				database.close();
			}
		},

		getChildRuns(parentRunId: string): Run[] {
			ensureInitialized();
			const database = openStoreDatabase();
			try {
				const rows = database
					.prepare(
						`SELECT id, unit_id, status FROM runs WHERE parent_run_id = ? ORDER BY created_at ASC, rowid ASC`,
					)
					.all(parentRunId) as {
					id: string;
					unit_id: string;
					status: string;
				}[];

				return rows.map((row) => ({
					id: row.id,
					unitId: row.unit_id,
					status: row.status as Run["status"],
				}));
			} finally {
				database.close();
			}
		},

		markRunRunning(runId: string) {
			ensureInitialized();
			const database = openStoreDatabase();
			const updatedAt = new Date().toISOString();

			try {
				runInTransaction(database, () => {
					const runRow = readRun(runId, database);
					if (runRow.status !== "pending") {
						throw new Error("Run start requires a pending run.");
					}
					assertNoRecordedCandidatePromotionClaim(runId, database, "Run start");
					database
						.prepare(`UPDATE runs SET status = ?, updated_at = ? WHERE id = ?`)
						.run("running", updatedAt, runId);
					appendEvent(
						"run-started",
						{ runId, unitId: runRow.unit_id, status: "running" },
						database,
					);
				});
			} finally {
				database.close();
			}
		},

		reconcilePlanForgeDispatchRuns(
			planId: string,
			status: "passed" | "failed",
		): readonly string[] {
			ensureInitialized();
			const database = openStoreDatabase();
			const now = new Date().toISOString();
			try {
				return runInTransaction(database, () => {
					// Mirror `findOrphanedPlanForgeDispatches`'s predicate EXACTLY
					// (`unit_id.startsWith(`${planId}:`)`) in JS rather than a SQL LIKE, so a
					// planId containing `%`/`_` can neither over- nor under-match. Only rows
					// still `running` are reconciled — never a row already terminal.
					const prefix = `${planId}:`;
					const rows = database
						.prepare(`SELECT id, unit_id FROM runs WHERE status = 'running'`)
						.all() as { id: string; unit_id: string }[];
					const update = database.prepare(
						`UPDATE runs SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
					);
					const reconciled: string[] = [];
					for (const row of rows) {
						if (!row.unit_id.startsWith(prefix)) {
							continue;
						}
						// A PlanForge reconciliation is a generic terminal transition. It
						// must not race a recorded promotion write-ahead marker into a
						// terminal run: the candidate transaction owns that terminal state
						// until the exact Git effect is reconciled.
						assertNoRecordedCandidatePromotionClaim(
							row.id,
							database,
							"PlanForge dispatch reconciliation",
						);
						update.run(status, now, now, row.id);
						appendEvent(
							"run-completed",
							{
								runId: row.id,
								unitId: row.unit_id,
								status,
								reason: "planforge-recover-reconcile",
							},
							database,
						);
						reconciled.push(row.id);
					}
					return reconciled;
				});
			} finally {
				database.close();
			}
		},

		recordExecutionEvidence(runId: string, receipt: ExecutionReceipt) {
			ensureInitialized();
			const database = openStoreDatabase();

			try {
				readRun(runId, database);
				const workspaceRow = readWorkspaceRow(runId, database);
				writeRunLogs(runId, receipt);

				database
					.prepare(
						`INSERT INTO evidence (id, run_id, kind, status, message) VALUES (?, ?, ?, ?, NULL)`,
					)
					.run(
						randomUUID(),
						runId,
						"command-exit",
						receipt.exitCode === 0 ? "pass" : "fail",
					);

				for (const check of receipt.outputChecks) {
					database
						.prepare(
							`INSERT INTO evidence (id, run_id, kind, status, message) VALUES (?, ?, ?, ?, NULL)`,
						)
						.run(
							randomUUID(),
							runId,
							"output-check",
							check.exists ? "pass" : "fail",
						);

					if (check.exists) {
						const artifactLocation = workspaceRow
							? persistWorkspaceArtifact(workspaceRow.path, runId, check.path)
							: check.path;
						database
							.prepare(
								`INSERT INTO artifacts (id, run_id, type, location) VALUES (?, ?, ?, ?)`,
							)
							.run(randomUUID(), runId, "required-output", artifactLocation);
					}
				}

				appendEvent(
					"execution-evidence-recorded",
					{
						runId,
						exitCode: receipt.exitCode,
						outputChecks: receipt.outputChecks,
						changedFiles: receipt.changedFiles ?? [],
						sideEffects: receipt.sideEffects ?? [],
					},
					database,
				);
			} finally {
				database.close();
			}
		},

		recordDecision(runId: string, decision: PolicyDecision) {
			ensureInitialized();
			const database = openStoreDatabase();

			try {
				readRun(runId, database);
				insertDecisionRecord(runId, decision, database);
			} finally {
				database.close();
			}
		},

		completeRun(runId: string, status: RunStatus) {
			ensureInitialized();
			const database = openStoreDatabase();
			const completedAt = new Date().toISOString();

			try {
				return runInTransaction(database, () => {
					const runRow = readRun(runId, database);
					if (runRow.status !== "pending" && runRow.status !== "running") {
						throw new Error(
							"Run completion requires a pending or running run.",
						);
					}
					assertNoRecordedCandidatePromotionClaim(
						runId,
						database,
						"Run completion",
					);
					if (
						runRow.used_workspace === 1 ||
						readWorkspaceRow(runId, database)
					) {
						throw new Error(
							"Workspace-backed runs must use commitRunSuccessOutcome or commitRunFailureOutcome.",
						);
					}
					database
						.prepare(
							`UPDATE runs SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
						)
						.run(status, completedAt, completedAt, runId);
					appendEvent("run-completed", { runId, status }, database);

					return toRun(readRun(runId, database));
				});
			} finally {
				database.close();
			}
		},

		recordWorkspacePrepared(runId, workspace) {
			ensureInitialized();
			const database = openStoreDatabase();
			const preparedAt = new Date().toISOString();

			try {
				runInTransaction(database, () => {
					const runRow = readRun(runId, database);
					if (runRow.status !== "pending") {
						throw new Error("Workspace preparation requires a pending run.");
					}
					if (readWorkspaceRow(runId, database)) {
						throw new Error(`A workspace already exists for run '${runId}'.`);
					}
					database
						.prepare(
							`UPDATE runs SET used_workspace = 1, updated_at = ? WHERE id = ?`,
						)
						.run(preparedAt, runId);
					database
						.prepare(
							`INSERT INTO workspaces (run_id, source_project_root, path, head_sha, status, created_at, finalized_at, cleanup_error) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
						)
						.run(
							runId,
							workspace.sourceProjectRoot,
							workspace.path,
							workspace.headSha,
							"active",
							preparedAt,
						);
					hitFailpoint("recordWorkspacePrepared:after-workspace-upsert");
					appendEvent(
						"workspace-prepared",
						{
							runId,
							path: workspace.path,
							headSha: workspace.headSha,
							sourceProjectRoot: workspace.sourceProjectRoot,
							status: "active",
						},
						database,
					);
				});
			} finally {
				database.close();
			}
		},

		commitRunFailureOutcome(runId, payload) {
			ensureInitialized();
			const database = openStoreDatabase();
			const completedAt = new Date().toISOString();

			if (
				(payload.decision === undefined) ===
				(payload.infrastructureFailure === undefined)
			) {
				throw new Error(
					"commitRunFailureOutcome requires exactly one of decision or infrastructureFailure.",
				);
			}

			try {
				return runInTransaction(database, () => {
					const runRow = readRun(runId, database);
					if (runRow.status !== "pending" && runRow.status !== "running") {
						throw new Error(
							"Failure outcomes can only be recorded for pending or running runs.",
						);
					}
					assertNoRecordedCandidatePromotionClaim(
						runId,
						database,
						"Failure outcome",
					);
					const workspaceRow = readWorkspaceRow(runId, database);

					if (payload.decision) {
						if (
							payload.decision.kind !== "reject-run" ||
							payload.decision.outcome !== "rejected"
						) {
							throw new Error(
								"Failure outcomes only accept rejected policy decisions.",
							);
						}
						if (payload.workspaceStatus !== "retained") {
							throw new Error(
								"Rejected failure outcomes must record workspaceStatus 'retained'.",
							);
						}
						if (!workspaceRow) {
							throw new Error(
								`No workspace found for run '${runId}' to retain.`,
							);
						}
						insertDecisionRecord(runId, payload.decision, database);
					}

					if (payload.infrastructureFailure) {
						if (workspaceRow && payload.workspaceStatus !== "retained") {
							throw new Error(
								"Post-prepare infrastructure failures must record workspaceStatus 'retained'.",
							);
						}
						if (!workspaceRow && payload.workspaceStatus !== undefined) {
							throw new Error(
								"Setup failures must not record a retained workspace status.",
							);
						}
						database
							.prepare(
								`INSERT INTO evidence (id, run_id, kind, status, message) VALUES (?, ?, ?, ?, ?)`,
							)
							.run(
								randomUUID(),
								runId,
								payload.infrastructureFailure.kind,
								"fail",
								payload.infrastructureFailure.message,
							);
					}

					const usedWorkspace =
						runRow.used_workspace === 1 ||
						payload.infrastructureFailure !== undefined ||
						payload.workspaceStatus === "retained"
							? 1
							: 0;

					database
						.prepare(
							`UPDATE runs SET status = ?, updated_at = ?, completed_at = ?, used_workspace = ? WHERE id = ?`,
						)
						.run("failed", completedAt, completedAt, usedWorkspace, runId);
					appendEvent("run-completed", { runId, status: "failed" }, database);

					if (payload.workspaceStatus === "retained") {
						if (!readWorkspaceRow(runId, database)) {
							throw new Error(`No workspace found for run '${runId}'`);
						}

						database
							.prepare(
								`UPDATE workspaces SET status = ?, finalized_at = ?, cleanup_error = NULL WHERE run_id = ?`,
							)
							.run("retained", completedAt, runId);
						appendEvent(
							"workspace-retained",
							{ runId, status: "retained" },
							database,
						);
					}

					return toRun(readRun(runId, database));
				});
			} finally {
				database.close();
			}
		},

		commitRunSuccessOutcome(runId, decision) {
			ensureInitialized();
			const database = openStoreDatabase();
			const completedAt = new Date().toISOString();

			if (decision.kind !== "advance-run" || decision.outcome !== "approved") {
				throw new Error(
					"Success outcomes only accept approved policy decisions.",
				);
			}

			try {
				return runInTransaction(database, () => {
					const runRow = readRun(runId, database);
					if (runRow.status !== "running") {
						throw new Error("Success outcomes require a running run.");
					}
					assertNoRecordedCandidatePromotionClaim(
						runId,
						database,
						"Success outcome",
					);
					insertDecisionRecord(runId, decision, database);
					database
						.prepare(
							`UPDATE runs SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
						)
						.run("passed", completedAt, completedAt, runId);
					appendEvent("run-completed", { runId, status: "passed" }, database);

					return toRun(readRun(runId, database));
				});
			} finally {
				database.close();
			}
		},

		commitRunCandidateOutcome(runId, input) {
			ensureInitialized();
			const database = openStoreDatabase();
			const completedAt = new Date().toISOString();

			if (
				input.decision.kind !== "advance-run" ||
				input.decision.outcome !== "approved"
			) {
				throw new Error(
					"Candidate outcomes only accept approved policy decisions.",
				);
			}

			try {
				return runInTransaction(database, () => {
					requireCandidateArtifactsProjection(database);
					const runRow = readRun(runId, database);
					if (runRow.status !== "running") {
						throw new Error("Candidate outcomes require a running run.");
					}

					const workspaceRow = readWorkspaceRow(runId, database);
					if (!workspaceRow || workspaceRow.status !== "active") {
						throw new Error(
							"Candidate outcomes require an active workspace to retain.",
						);
					}

					const candidate = normalizeCandidateArtifactInput(
						input.candidate,
						runId,
						runRow.unit_id,
					);
					if (
						candidate.schemaVersion === 2 &&
						runRow.trust_lane !== "governed"
					) {
						throw new Error(
							"Candidate schemaVersion 2 requires a governed run.",
						);
					}
					// A packet with provenance is governed input. Preserve the raw lane for
					// legacy packets, but never allow its candidate to replace the known
					// provenance pointer with a different one.
					let packet: UnitPacket | undefined;
					if (runRow.unit_snapshot) {
						try {
							packet = parseUnitPacket(runRow.unit_snapshot);
						} catch {
							// Older or raw packet snapshots cannot establish a governed
							// provenance binding. Do not infer one while recording the
							// candidate projection.
						}
					}
					if (
						candidate.schemaVersion === 2 &&
						packet?.provenance_ref !== candidate.provenanceRef
					) {
						throw new Error(
							"Candidate schemaVersion 2 requires matching governed packet provenance.",
						);
					}
					if (
						packet?.provenance_ref &&
						candidate.provenanceRef !== packet.provenance_ref
					) {
						throw new Error(
							"Candidate provenanceRef must match the run's governed provenance reference.",
						);
					}
					if (
						candidate.baseSha.toLowerCase() !==
						workspaceRow.head_sha.toLowerCase()
					) {
						throw new Error(
							"Candidate baseSha must match the workspace base SHA.",
						);
					}

					if (readCandidateArtifactRow(runId, database)) {
						throw new Error(
							`A candidate artifact already exists for run '${runId}'. Create a new attempt before recording another candidate.`,
						);
					}

					if (candidate.workflowId !== undefined) {
						const duplicateAttempt = database
							.prepare(
								`SELECT run_id FROM candidate_artifacts WHERE workflow_id = ? AND unit_id = ? AND attempt = ?`,
							)
							.get(candidate.workflowId, runRow.unit_id, candidate.attempt) as
							| { run_id: string }
							| undefined;
						if (duplicateAttempt) {
							throw new Error(
								`A candidate already exists for workflow '${candidate.workflowId}', unit '${runRow.unit_id}', attempt ${candidate.attempt}. Create a new attempt before recording another candidate.`,
							);
						}
					}

					const duplicateIdentity = database
						.prepare(
							`SELECT run_id FROM candidate_artifacts WHERE candidate_key = ? OR candidate_ref = ? OR candidate_digest = ?`,
						)
						.get(
							candidate.candidateKey,
							candidate.candidateRef,
							candidate.candidateDigest,
						) as { run_id: string } | undefined;
					if (duplicateIdentity) {
						throw new Error(
							`Candidate identity is already recorded for run '${duplicateIdentity.run_id}'.`,
						);
					}

					database
						.prepare(
							`INSERT INTO candidate_artifacts (run_id, schema_version, candidate_id, candidate_key, candidate_ref, workflow_id, unit_id, attempt, provenance_ref, candidate_digest, base_commit_sha, candidate_commit_sha, commit_digest, tree_digest, patch_digest, changed_files_digest, envelope_digest, acceptance_contract_digest, action_receipt_digest, action_receipt_set_ref, action_receipt_set_digest, action_evidence_version, candidate_created_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						)
						.run(
							runId,
							candidate.schemaVersion,
							candidate.candidateId,
							candidate.candidateKey,
							candidate.candidateRef,
							candidate.workflowId ?? null,
							runRow.unit_id,
							candidate.attempt,
							candidate.provenanceRef ?? null,
							candidate.candidateDigest,
							candidate.baseSha,
							candidate.candidateCommitSha,
							candidate.commitDigest,
							candidate.treeDigest,
							candidate.patchDigest,
							candidate.changedFilesDigest,
							candidate.envelopeDigest ?? null,
							candidate.acceptanceContractDigest ?? null,
							candidate.actionReceiptDigest ?? null,
							candidate.actionReceiptSetRef ?? null,
							candidate.actionReceiptSetDigest ?? null,
							candidate.actionEvidenceVersion ?? null,
							candidate.candidateCreatedRef ?? null,
							completedAt,
						);
					hitFailpoint("commitRunCandidateOutcome:after-candidate-insert");
					appendEvent(
						"candidate-recorded",
						{
							runId,
							candidateId: candidate.candidateId,
							candidateKey: candidate.candidateKey,
							candidateRef: candidate.candidateRef,
							candidateDigest: candidate.candidateDigest,
							commitDigest: candidate.commitDigest,
							baseSha: candidate.baseSha,
							candidateCommitSha: candidate.candidateCommitSha,
							schemaVersion: candidate.schemaVersion,
							...(candidate.workflowId
								? { workflowId: candidate.workflowId }
								: {}),
							...(candidate.schemaVersion === 2
								? {
										actionEvidenceVersion: candidate.actionEvidenceVersion,
										actionReceiptSetRef: candidate.actionReceiptSetRef,
										actionReceiptSetDigest: candidate.actionReceiptSetDigest,
										candidateCreatedRef: candidate.candidateCreatedRef,
									}
								: {}),
							attempt: candidate.attempt,
						},
						database,
					);

					insertDecisionRecord(runId, input.decision, database);
					// Candidate creation is deliberately non-terminal. The policy decision
					// proves only that deterministic execution/acceptance may advance to
					// review; it is not a review verdict or a promotion decision. Leaving
					// the run active prevents local status/receipt projections from treating
					// an unreviewed candidate as a completed, promotable result.
					database
						.prepare(
							`UPDATE runs SET status = ?, updated_at = ?, completed_at = NULL WHERE id = ?`,
						)
						.run("running", completedAt, runId);
					appendEvent(
						"candidate-awaiting-promotion",
						{ runId, status: "running", reason: "candidate-pending-promotion" },
						database,
					);
					database
						.prepare(
							`UPDATE workspaces SET status = ?, finalized_at = ?, cleanup_error = NULL WHERE run_id = ?`,
						)
						.run("retained", completedAt, runId);
					appendEvent(
						"workspace-retained",
						{
							runId,
							status: "retained",
							reason: "candidate-pending-promotion",
						},
						database,
					);

					return toRun(readRun(runId, database));
				});
			} finally {
				database.close();
			}
		},

		getCandidateArtifact(runId) {
			ensureInitialized();
			const database = openStoreDatabase();
			try {
				const candidate = readCandidateArtifactRow(runId, database);
				return candidate ? toCandidateArtifactProjection(candidate) : null;
			} finally {
				database.close();
			}
		},

		prepareCandidatePromotion(input) {
			ensureInitialized();
			const database = openStoreDatabase();

			try {
				return runInTransaction(database, () => {
					const normalized = normalizeCandidatePromotionIntent(input, database);
					// Replays may read an already-executed governed intent after it
					// terminally completed, but no raw/legacy run can acquire even that
					// read-through identity.
					requireGovernedCandidatePromotionRun(
						normalized.intent.runId,
						database,
						"Candidate promotion preparation",
					);
					const matchingRows = readCandidatePromotionRowsByIdentity(
						normalized.canonicalCandidateDigest,
						normalized.idempotencyKey,
						database,
					);

					for (const row of matchingRows) {
						if (
							row.candidate_digest === normalized.canonicalCandidateDigest &&
							row.idempotency_key === normalized.idempotencyKey
						) {
							const existing = toCandidatePromotionIntent(row, database);
							if (
								canonicalCandidatePromotionIdentity(existing) !==
								normalized.canonicalIdentityJson
							) {
								throw new Error(
									"Candidate promotion idempotency key already exists with a different canonical intent.",
								);
							}
							return existing;
						}

						if (row.idempotency_key === normalized.idempotencyKey) {
							throw new Error(
								"Candidate promotion idempotency key is already bound to a different candidate digest.",
							);
						}
						if (row.candidate_digest === normalized.canonicalCandidateDigest) {
							throw new Error(
								"Candidate digest already has a promotion intent with a different idempotency key.",
							);
						}
					}
					requireActiveGovernedCandidatePromotionRun(
						normalized.intent.runId,
						database,
						"Candidate promotion preparation",
					);

					database
						.prepare(
							`INSERT INTO candidate_promotions (candidate_digest, idempotency_key, run_id, state, candidate_json, decision_json, acceptance_json, review_json, intent_canonical_json, prepared_at, recorded_at, executed_at, executed_outcome, merged_head_sha, promotion_git_binding_json)
							 VALUES (?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`,
						)
						.run(
							normalized.canonicalCandidateDigest,
							normalized.idempotencyKey,
							normalized.intent.runId,
							normalized.candidateJson,
							normalized.decisionJson,
							normalized.acceptanceJson,
							normalized.reviewJson,
							normalized.canonicalIntentJson,
							normalized.intent.preparedAt,
						);
					hitFailpoint("prepareCandidatePromotion:after-intent-insert");
					appendEvent(
						"candidate-promotion-prepared",
						{
							runId: normalized.intent.runId,
							candidateDigest: normalized.canonicalCandidateDigest,
							idempotencyKey: normalized.idempotencyKey,
							state: "prepared",
						},
						database,
					);
					return normalized.intent;
				});
			} finally {
				database.close();
			}
		},

		markCandidatePromotionRecorded(candidateDigest, idempotencyKey) {
			ensureInitialized();
			const database = openStoreDatabase();

			try {
				runInTransaction(database, () => {
					let canonicalCandidateDigest: string;
					try {
						canonicalCandidateDigest = canonicalSha256Digest(candidateDigest);
					} catch (error) {
						throw new TypeError(
							`Candidate promotion candidateDigest is invalid: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
					}
					const key = readRequiredPromotionText(
						idempotencyKey,
						"Candidate promotion idempotencyKey",
					);
					const rows = readCandidatePromotionRowsByIdentity(
						canonicalCandidateDigest,
						key,
						database,
					);
					const row = rows.find(
						(candidate) =>
							candidate.candidate_digest === canonicalCandidateDigest &&
							candidate.idempotency_key === key,
					);
					if (!row) {
						throw new Error(
							"Candidate promotion marker does not match a prepared candidate intent.",
						);
					}
					// Validate the persisted binding before moving the write-ahead marker.
					const intent = toCandidatePromotionIntent(row, database);
					requireGovernedCandidatePromotionRun(
						intent.runId,
						database,
						"Candidate promotion recording",
					);
					if (intent.state === "executed" || intent.state === "recorded") {
						return;
					}
					requireActiveGovernedCandidatePromotionRun(
						intent.runId,
						database,
						"Candidate promotion recording",
					);

					const recordedAt = new Date().toISOString();
					const transition = database
						.prepare(
							`UPDATE candidate_promotions
							 SET state = 'recorded', recorded_at = ?
							 WHERE candidate_digest = ? AND idempotency_key = ? AND state = 'prepared'`,
						)
						.run(recordedAt, canonicalCandidateDigest, key) as {
						changes: number;
					};
					if (transition.changes !== 1) {
						const latest = readCandidatePromotionRowsByIdentity(
							canonicalCandidateDigest,
							key,
							database,
						).find(
							(candidate) =>
								candidate.candidate_digest === canonicalCandidateDigest &&
								candidate.idempotency_key === key,
						);
						if (!latest) {
							throw new Error(
								"Candidate promotion disappeared while recording its write-ahead marker.",
							);
						}
						const latestIntent = toCandidatePromotionIntent(latest, database);
						if (
							latestIntent.state === "recorded" ||
							latestIntent.state === "executed"
						) {
							return;
						}
						throw new Error(
							"Candidate promotion state changed while recording its write-ahead marker.",
						);
					}
					hitFailpoint("markCandidatePromotionRecorded:after-marker-update");
					appendEvent(
						"candidate-promotion-recorded",
						{
							candidateDigest: canonicalCandidateDigest,
							idempotencyKey: key,
							state: "recorded",
						},
						database,
					);
				});
			} finally {
				database.close();
			}
		},

		claimCandidatePromotionExecution(candidateDigest, idempotencyKey) {
			ensureInitialized();
			const database = openStoreDatabase();

			try {
				return runInTransaction(database, () => {
					let canonicalCandidateDigest: string;
					try {
						canonicalCandidateDigest = canonicalSha256Digest(candidateDigest);
					} catch (error) {
						throw new TypeError(
							`Candidate promotion candidateDigest is invalid: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
					}
					const key = readRequiredPromotionText(
						idempotencyKey,
						"Candidate promotion idempotencyKey",
					);
					const row = readCandidatePromotionRowsByIdentity(
						canonicalCandidateDigest,
						key,
						database,
					).find(
						(candidate) =>
							candidate.candidate_digest === canonicalCandidateDigest &&
							candidate.idempotency_key === key,
					);
					if (!row) {
						throw new Error(
							"Candidate promotion execution claim does not match a recorded candidate intent.",
						);
					}
					const intent = toCandidatePromotionIntent(row, database);
					if (intent.state !== "recorded") {
						throw new Error(
							"Candidate promotion execution requires a recorded write-ahead intent.",
						);
					}
					requireActiveGovernedCandidatePromotionRun(
						intent.runId,
						database,
						"Candidate promotion execution claim",
					);
					const now = promotionExecutionNow();
					const previousLease = readCandidatePromotionExecutionLease(row);
					if (
						previousLease !== null &&
						Date.parse(previousLease.leaseExpiresAt) > now.getTime()
					) {
						throw new Error(
							`An active candidate promotion execution lease remains valid until ${previousLease.leaseExpiresAt}; only its current owner may enter the Git effect path.`,
						);
					}

					const claimedAt = now.toISOString();
					const leaseExpiresAt = new Date(
						now.getTime() + PROMOTION_EXECUTION_LEASE_MS,
					).toISOString();
					const leaseToken = randomUUID();
					const claimEpoch = row.execution_claim_epoch + 1;
					// `BEGIN IMMEDIATE` reserves the SQLite writer before the row is read.
					// The predicate still makes an accidental stale update fail closed if
					// this code is ever called from a different transaction wrapper.
					const claim = database
						.prepare(
							`UPDATE candidate_promotions
							 SET execution_claim_token = ?, execution_claimed_at = ?, execution_lease_expires_at = ?, execution_claim_epoch = ?
							 WHERE candidate_digest = ? AND idempotency_key = ? AND state = 'recorded'
							   AND (
								(execution_claim_token IS NULL AND execution_claimed_at IS NULL AND execution_lease_expires_at IS NULL)
								OR execution_lease_expires_at <= ?
							   )`,
						)
						.run(
							leaseToken,
							claimedAt,
							leaseExpiresAt,
							claimEpoch,
							canonicalCandidateDigest,
							key,
							claimedAt,
						) as { changes: number };
					if (claim.changes !== 1) {
						throw new Error(
							"Candidate promotion execution lease changed before the Git effect could begin.",
						);
					}
					hitFailpoint("claimCandidatePromotionExecution:after-lease-update");
					appendEvent(
						"candidate-promotion-execution-claimed",
						{
							candidateDigest: canonicalCandidateDigest,
							idempotencyKey: key,
							claimEpoch,
							claimedAt,
							leaseExpiresAt,
						},
						database,
					);
					return {
						schemaVersion: 1 as const,
						state: "active" as const,
						candidateDigest: canonicalCandidateDigest,
						idempotencyKey: key,
						leaseToken,
						claimedAt,
						leaseExpiresAt,
						claimEpoch,
					};
				});
			} finally {
				database.close();
			}
		},

		getCandidatePromotionExecutionClaimState(candidateDigest, idempotencyKey) {
			ensureInitialized();
			const database = openStoreDatabase();

			try {
				let canonicalCandidateDigest: string;
				try {
					canonicalCandidateDigest = canonicalSha256Digest(candidateDigest);
				} catch (error) {
					throw new TypeError(
						`Candidate promotion candidateDigest is invalid: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
				const key = readRequiredPromotionText(
					idempotencyKey,
					"Candidate promotion idempotencyKey",
				);
				const row = readCandidatePromotionRowsByIdentity(
					canonicalCandidateDigest,
					key,
					database,
				).find(
					(candidate) =>
						candidate.candidate_digest === canonicalCandidateDigest &&
						candidate.idempotency_key === key,
				);
				if (!row) {
					throw new Error(
						"Candidate promotion execution state does not match a recorded candidate intent.",
					);
				}
				// Validate all candidate/decision bindings before exposing the recovery
				// state. A local projection never becomes execution authority merely
				// because its lease fields are syntactically well-formed.
				toCandidatePromotionIntent(row, database);
				return toCandidatePromotionExecutionClaimState(
					row,
					promotionExecutionNow(),
				);
			} finally {
				database.close();
			}
		},

		markCandidatePromotionExecuted(
			candidateDigest,
			idempotencyKey,
			outcome,
			executionLeaseToken,
		) {
			ensureInitialized();
			const database = openStoreDatabase();

			try {
				runInTransaction(database, () => {
					let canonicalCandidateDigest: string;
					try {
						canonicalCandidateDigest = canonicalSha256Digest(candidateDigest);
					} catch (error) {
						throw new TypeError(
							`Candidate promotion candidateDigest is invalid: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
					}
					const key = readRequiredPromotionText(
						idempotencyKey,
						"Candidate promotion idempotencyKey",
					);
					if (
						outcome.outcome !== "promoted" &&
						outcome.outcome !== "reconciliation_required" &&
						outcome.outcome !== "rejected"
					) {
						throw new TypeError(
							'Candidate promotion outcome must be "promoted", "reconciliation_required", or "rejected".',
						);
					}
					const hasPromotionEffect = outcome.outcome !== "rejected";
					const mergedHeadSha = hasPromotionEffect
						? readPromotionCandidateCommitSha(
								outcome.mergedHeadSha,
								"Candidate promotion mergedHeadSha",
							)
						: undefined;
					if (
						hasPromotionEffect &&
						(typeof mergedHeadSha !== "string" ||
							!FULL_GIT_COMMIT_SHA_PATTERN.test(mergedHeadSha))
					) {
						throw new TypeError(
							"A promotion effect requires a full merge commit SHA.",
						);
					}
					if (outcome.outcome === "rejected" && mergedHeadSha !== undefined) {
						throw new TypeError(
							"A rejected candidate promotion cannot carry a merge commit SHA.",
						);
					}
					if (
						outcome.outcome === "rejected" &&
						outcome.promotionGitBinding !== undefined
					) {
						throw new TypeError(
							"A rejected candidate promotion cannot carry Git-binding evidence.",
						);
					}
					const normalizedPromotionGitBinding = hasPromotionEffect
						? normalizePromotionGitBinding(
								outcome.promotionGitBinding,
								"Candidate promotion Git binding",
							)
						: undefined;
					if (
						normalizedPromotionGitBinding &&
						normalizedPromotionGitBinding.binding.mergedHeadSha !==
							mergedHeadSha
					) {
						throw new TypeError(
							"Candidate promotion Git binding mergedHeadSha must match the terminal effect.",
						);
					}
					const hasMatchingSyncState =
						normalizedPromotionGitBinding === undefined ||
						(outcome.outcome === "promoted"
							? normalizedPromotionGitBinding.binding.worktreeSyncState ===
								"pending_reconciliation"
							: outcome.outcome === "reconciliation_required"
								? normalizedPromotionGitBinding.binding.worktreeSyncState ===
										"target_advanced" ||
									normalizedPromotionGitBinding.binding.worktreeSyncState ===
										"root_checkout_stale"
								: true);
					if (!hasMatchingSyncState) {
						throw new TypeError(
							"Candidate promotion Git binding sync state must match the terminal effect.",
						);
					}

					const rows = readCandidatePromotionRowsByIdentity(
						canonicalCandidateDigest,
						key,
						database,
					);
					const row = rows.find(
						(candidate) =>
							candidate.candidate_digest === canonicalCandidateDigest &&
							candidate.idempotency_key === key,
					);
					if (!row) {
						throw new Error(
							"Candidate promotion marker does not match a recorded candidate intent.",
						);
					}
					const intent = toCandidatePromotionIntent(row, database);
					if (
						intent.decision.decision === "reject" &&
						outcome.outcome !== "rejected"
					) {
						throw new Error(
							"A rejected candidate promotion decision cannot record a merge-producing effect.",
						);
					}
					if (normalizedPromotionGitBinding) {
						const binding = normalizedPromotionGitBinding.binding;
						const candidateRefPrefix = "refs/buildplane/candidates/";
						const expectedReceiptRef = intent.candidate.candidateRef.startsWith(
							candidateRefPrefix,
						)
							? `refs/buildplane/promotions/${intent.candidate.candidateRef.slice(candidateRefPrefix.length)}`
							: "";
						if (
							binding.targetRef !== intent.decision.targetRef ||
							binding.targetHeadBeforeSha !== intent.decision.baseCommitSha ||
							binding.candidateCommitSha !==
								intent.candidate.candidateCommitSha ||
							binding.mergedTreeDigest !==
								canonicalSha256Digest(intent.candidate.treeDigest) ||
							binding.promotionReceiptRef !== expectedReceiptRef
						) {
							throw new Error(
								"Candidate promotion Git binding does not match the immutable candidate and signed decision.",
							);
						}
						if (outcome.outcome === "reconciliation_required") {
							if (
								binding.worktreeSyncState === "target_advanced" &&
								binding.targetHeadAfterSha === mergedHeadSha
							) {
								throw new Error(
									"Target-advanced promotion evidence must show that the target no longer equals the candidate merge.",
								);
							}
							if (
								binding.worktreeSyncState === "root_checkout_stale" &&
								binding.targetHeadAfterSha !== mergedHeadSha
							) {
								throw new Error(
									"Root-checkout-stale promotion evidence must retain the candidate merge on the target ref.",
								);
							}
						}
					}
					requireGovernedCandidatePromotionRun(
						intent.runId,
						database,
						"Candidate promotion execution",
					);
					if (intent.state === "executed") {
						if (
							intent.executedOutcome !== outcome.outcome ||
							intent.mergedHeadSha !== mergedHeadSha ||
							canonicalPromotionJson(intent.promotionGitBinding ?? null) !==
								(normalizedPromotionGitBinding?.canonicalJson ?? "null")
						) {
							throw new Error(
								"Candidate promotion is already executed with a different terminal outcome.",
							);
						}
						return;
					}
					if (intent.state !== "recorded") {
						throw new Error(
							"Candidate promotion must be recorded before its effect can be marked executed.",
						);
					}
					const executionLease = readCandidatePromotionExecutionLease(row);
					if (executionLease === null) {
						throw new Error(
							"Candidate promotion execution requires an active execution lease before its terminal effect can be recorded.",
						);
					}
					if (
						typeof executionLeaseToken !== "string" ||
						!PROMOTION_EXECUTION_LEASE_TOKEN_PATTERN.test(executionLeaseToken)
					) {
						throw new Error(
							"Candidate promotion execution requires the exact active execution lease token.",
						);
					}
					if (executionLeaseToken !== executionLease.leaseToken) {
						throw new Error(
							"Candidate promotion execution lease token does not match the active owner.",
						);
					}
					const executionNow = promotionExecutionNow();
					if (
						Date.parse(executionLease.leaseExpiresAt) <= executionNow.getTime()
					) {
						throw new Error(
							"Candidate promotion execution lease expired before its terminal effect could be recorded; acquire a new lease and reconcile the Git effect first.",
						);
					}
					// Check durable activity immediately before writing a terminal marker.
					// This must precede the promotion-row update so a stale recovery cannot
					// make a terminal run look executed after its Git effect was denied.
					requireActiveGovernedCandidatePromotionRun(
						intent.runId,
						database,
						"Candidate promotion execution",
					);

					const executedAt = executionNow.toISOString();
					const transition = database
						.prepare(
							`UPDATE candidate_promotions
							 SET state = 'executed', executed_at = ?, executed_outcome = ?, merged_head_sha = ?, promotion_git_binding_json = ?, execution_claim_token = NULL, execution_claimed_at = NULL, execution_lease_expires_at = NULL
							 WHERE candidate_digest = ? AND idempotency_key = ? AND state = 'recorded'
							   AND execution_claim_token = ? AND execution_lease_expires_at > ?`,
						)
						.run(
							executedAt,
							outcome.outcome,
							mergedHeadSha ?? null,
							normalizedPromotionGitBinding?.canonicalJson ?? null,
							canonicalCandidateDigest,
							key,
							executionLeaseToken,
							executedAt,
						) as { changes: number };
					if (transition.changes !== 1) {
						const latest = readCandidatePromotionRowsByIdentity(
							canonicalCandidateDigest,
							key,
							database,
						).find(
							(candidate) =>
								candidate.candidate_digest === canonicalCandidateDigest &&
								candidate.idempotency_key === key,
						);
						if (!latest) {
							throw new Error(
								"Candidate promotion disappeared while recording its terminal effect marker.",
							);
						}
						const latestIntent = toCandidatePromotionIntent(latest, database);
						if (
							latestIntent.state === "executed" &&
							latestIntent.executedOutcome === outcome.outcome &&
							latestIntent.mergedHeadSha === mergedHeadSha &&
							canonicalPromotionJson(
								latestIntent.promotionGitBinding ?? null,
							) === (normalizedPromotionGitBinding?.canonicalJson ?? "null")
						) {
							return;
						}
						throw new Error(
							"Candidate promotion execution lease changed while recording its terminal effect marker.",
						);
					}
					hitFailpoint("markCandidatePromotionExecuted:after-marker-update");
					const candidateRow = database
						.prepare(
							`SELECT candidate_digest FROM candidate_artifacts WHERE run_id = ?`,
						)
						.get(intent.runId) as { candidate_digest: string } | undefined;
					if (
						!candidateRow ||
						canonicalSha256Digest(candidateRow.candidate_digest) !==
							canonicalCandidateDigest
					) {
						throw new Error(
							"Candidate promotion terminal state does not bind the recorded candidate run.",
						);
					}
					const runStatus =
						outcome.outcome === "promoted"
							? "passed"
							: outcome.outcome === "rejected"
								? "failed"
								: "suspended";
					const terminalTransition = database
						.prepare(
							`UPDATE runs
							 SET status = ?, updated_at = ?, completed_at = ?
							 WHERE id = ? AND status = 'running'`,
						)
						.run(
							runStatus,
							executedAt,
							outcome.outcome === "reconciliation_required" ? null : executedAt,
							intent.runId,
						) as {
						changes: number;
					};
					if (terminalTransition.changes !== 1) {
						throw new Error(
							"Candidate promotion can complete only an active candidate run.",
						);
					}
					appendEvent(
						"candidate-promotion-executed",
						{
							candidateDigest: canonicalCandidateDigest,
							idempotencyKey: key,
							outcome: outcome.outcome,
							...(mergedHeadSha ? { mergedHeadSha } : {}),
							...(normalizedPromotionGitBinding
								? {
										promotionGitBinding: normalizedPromotionGitBinding.binding,
									}
								: {}),
							state: "executed",
						},
						database,
					);
					if (outcome.outcome === "reconciliation_required") {
						appendEvent(
							"candidate-promotion-reconciliation-required",
							{
								runId: intent.runId,
								status: "suspended",
								reason:
									normalizedPromotionGitBinding?.binding.worktreeSyncState ===
									"root_checkout_stale"
										? "candidate-promotion-root-checkout-stale"
										: "candidate-promotion-target-advanced",
							},
							database,
						);
					} else {
						appendEvent(
							"run-completed",
							{
								runId: intent.runId,
								status: runStatus,
								reason:
									outcome.outcome === "promoted"
										? "candidate-promoted"
										: "candidate-promotion-rejected",
							},
							database,
						);
					}
				});
			} finally {
				database.close();
			}
		},

		listPendingCandidatePromotions() {
			ensureInitialized();
			// Historical initialized databases can predate the authority-lane
			// column. They cannot contain a provably governed recovery action, so
			// return no work before opening the strict write-capable projection.
			// This keeps recovery reads backward-compatible without treating an old
			// row as promotion authority or mutating a database from a read path.
			const compatibilityDatabase = openBuildplaneDatabase(layout.stateDbPath);
			try {
				if (!tableHasColumn(compatibilityDatabase, "runs", "trust_lane")) {
					return [];
				}
			} finally {
				compatibilityDatabase.close();
			}
			const database = openStoreDatabase();
			try {
				requireCandidatePromotionsProjection(database);
				// Projection recovery is deliberately fail-closed for rows that
				// predate the durable authority lane. Avoid a read-time migration:
				// absent `trust_lane` means legacy, never governed.
				const governedRunPredicate = tableHasColumn(
					database,
					"runs",
					"trust_lane",
				)
					? "runs.trust_lane = 'governed'"
					: "'legacy' = 'governed'";
				const rows = database
					.prepare(
						`SELECT candidate_digest, idempotency_key, run_id, state, candidate_json, decision_json, acceptance_json, review_json, intent_canonical_json, prepared_at, recorded_at, executed_at, executed_outcome, merged_head_sha, promotion_git_binding_json, execution_claim_token, execution_claimed_at, execution_lease_expires_at, execution_claim_epoch
						 FROM candidate_promotions
						 INNER JOIN runs ON runs.id = candidate_promotions.run_id
						 WHERE candidate_promotions.state IN ('prepared', 'recorded')
						   AND ${governedRunPredicate}
						   AND runs.status = 'running'
						 ORDER BY candidate_promotions.prepared_at ASC, candidate_promotions.rowid ASC`,
					)
					.all() as unknown as StoredCandidatePromotionRow[];
				return rows.map((row) => toCandidatePromotionIntent(row, database));
			} finally {
				database.close();
			}
		},

		recordWorkspaceDeleted(runId) {
			ensureInitialized();
			const database = openStoreDatabase();
			const finalizedAt = new Date().toISOString();

			try {
				runInTransaction(database, () => {
					const runRow = readRun(runId, database);
					const workspaceRow = readWorkspaceRow(runId, database);
					if (!workspaceRow) {
						throw new Error(`No workspace found for run '${runId}'`);
					}
					if (runRow.status !== "passed") {
						throw new Error(
							"Workspace deletion requires a passed run with an active workspace.",
						);
					}
					if (workspaceRow.status !== "active") {
						throw new Error(
							"Workspace deletion requires an active workspace transition.",
						);
					}

					database
						.prepare(
							`UPDATE workspaces SET status = ?, finalized_at = ?, cleanup_error = NULL WHERE run_id = ?`,
						)
						.run("deleted", finalizedAt, runId);
					appendEvent(
						"workspace-deleted",
						{ runId, status: "deleted" },
						database,
					);
				});
			} finally {
				database.close();
			}
		},

		recordWorkspaceCleanupFailed(runId, message) {
			ensureInitialized();
			const database = openStoreDatabase();
			const finalizedAt = new Date().toISOString();

			try {
				runInTransaction(database, () => {
					const runRow = readRun(runId, database);
					const workspaceRow = readWorkspaceRow(runId, database);
					if (!workspaceRow) {
						throw new Error(`No workspace found for run '${runId}'`);
					}
					if (runRow.status !== "passed") {
						throw new Error(
							"Workspace cleanup-failed recording requires a passed run with an active workspace.",
						);
					}
					if (workspaceRow.status !== "active") {
						throw new Error(
							"Workspace cleanup-failed recording requires an active workspace transition.",
						);
					}

					database
						.prepare(
							`UPDATE workspaces SET status = ?, finalized_at = ?, cleanup_error = ? WHERE run_id = ?`,
						)
						.run("cleanup-failed", finalizedAt, message, runId);
					appendEvent(
						"workspace-cleanup-failed",
						{ runId, status: "cleanup-failed", message },
						database,
					);
				});
			} finally {
				database.close();
			}
		},

		recordWorkspaceCleanedUp(runId) {
			ensureInitialized();
			const database = openStoreDatabase();
			const finalizedAt = new Date().toISOString();

			try {
				runInTransaction(database, () => {
					const workspaceRow = readWorkspaceRow(runId, database);
					if (!workspaceRow) {
						throw new Error(`No workspace found for run '${runId}'`);
					}
					if (
						workspaceRow.status !== "retained" &&
						workspaceRow.status !== "cleanup-failed"
					) {
						throw new Error(
							"Workspace operator cleanup requires a retained or cleanup-failed workspace.",
						);
					}

					database
						.prepare(
							`UPDATE workspaces SET status = ?, finalized_at = ?, cleanup_error = NULL WHERE run_id = ?`,
						)
						.run("deleted", finalizedAt, runId);
					appendEvent(
						"workspace-deleted",
						{
							runId,
							status: "deleted",
							previousStatus: workspaceRow.status,
							cleanedBy: "operator",
						},
						database,
					);
				});
			} finally {
				database.close();
			}
		},

		suspendRun(runId: string): Run {
			ensureInitialized();
			const database = openStoreDatabase();
			const updatedAt = new Date().toISOString();

			try {
				return runInTransaction(database, () => {
					const runRow = readRun(runId, database);
					if (runRow.status !== "running") {
						throw new Error(
							`suspendRun requires a running run, got '${runRow.status}'.`,
						);
					}
					assertNoRecordedCandidatePromotionClaim(
						runId,
						database,
						"Run suspension",
					);
					database
						.prepare(`UPDATE runs SET status = ?, updated_at = ? WHERE id = ?`)
						.run("suspended", updatedAt, runId);
					appendEvent(
						"run-suspended",
						{ runId, unitId: runRow.unit_id, status: "suspended" },
						database,
					);
					return toRun({ ...runRow, status: "suspended" });
				});
			} finally {
				database.close();
			}
		},

		approveRun(runId: string): Run {
			ensureInitialized();
			const database = openStoreDatabase();
			const updatedAt = new Date().toISOString();

			try {
				return runInTransaction(database, () => {
					const runRow = readRun(runId, database);
					if (runRow.status !== "suspended") {
						throw new Error(
							`approveRun requires a suspended run, got '${runRow.status}'.`,
						);
					}
					assertNoRecordedCandidatePromotionClaim(
						runId,
						database,
						"Run approval",
					);
					database
						.prepare(`UPDATE runs SET status = ?, updated_at = ? WHERE id = ?`)
						.run("pending", updatedAt, runId);
					appendEvent(
						"run-resumed",
						{ runId, unitId: runRow.unit_id, status: "pending" },
						database,
					);
					return toRun({ ...runRow, status: "pending" });
				});
			} finally {
				database.close();
			}
		},

		rejectSuspendedRun(runId: string): Run {
			ensureInitialized();
			const database = openStoreDatabase();
			const updatedAt = new Date().toISOString();

			try {
				return runInTransaction(database, () => {
					const runRow = readRun(runId, database);
					if (runRow.status !== "suspended") {
						throw new Error(
							`rejectSuspendedRun requires a suspended run, got '${runRow.status}'.`,
						);
					}
					assertNoRecordedCandidatePromotionClaim(
						runId,
						database,
						"Suspended-run rejection",
					);
					database
						.prepare(
							`UPDATE runs SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
						)
						.run("failed", updatedAt, updatedAt, runId);
					appendEvent(
						"run-completed",
						{
							runId,
							unitId: runRow.unit_id,
							status: "failed",
							reason: "rejected-by-operator",
						},
						database,
					);
					return toRun({ ...runRow, status: "failed" });
				});
			} finally {
				database.close();
			}
		},

		rejectMergeDecision(runId: string): Run {
			ensureInitialized();
			const database = openStoreDatabase();
			const updatedAt = new Date().toISOString();

			try {
				return runInTransaction(database, () => {
					// M5-S4 D3 quarantine: a merge-subject run is `passed` (acceptance
					// gate), not `suspended`. Mark it failed and leave the worktree
					// retained (no workspace transition here).
					const runRow = readRun(runId, database);
					assertNoRecordedCandidatePromotionClaim(
						runId,
						database,
						"Merge-decision rejection",
					);
					database
						.prepare(
							`UPDATE runs SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
						)
						.run("failed", updatedAt, updatedAt, runId);
					appendEvent(
						"run-completed",
						{
							runId,
							unitId: runRow.unit_id,
							status: "failed",
							reason: "merge-rejected-by-operator",
						},
						database,
					);
					return toRun({ ...runRow, status: "failed" });
				});
			} finally {
				database.close();
			}
		},

		upsertRepoFact(input: UpsertRepoFactInput): RepoFact {
			ensureInitialized();
			const database = openStoreDatabase();
			const now = new Date().toISOString();
			const scope = defaultRepoFactScope({
				scopeType: input.scopeType,
				scopeKey: input.scopeKey,
			});
			assertScopeKeyForExactLookup(scope.scopeType, scope.scopeKey);

			try {
				return runInTransaction(database, () => {
					database
						.prepare(
							`UPDATE repo_facts SET status = 'superseded', updated_at = ? WHERE repo_id = ? AND fact_key = ? AND scope_type = ? AND scope_key IS ? AND status = 'active'`,
						)
						.run(
							now,
							projectRoot,
							input.factKey,
							scope.scopeType,
							scope.scopeKey ?? null,
						);

					const id = randomUUID();
					database
						.prepare(
							`INSERT INTO repo_facts (id, repo_id, fact_key, fact_value_json, value_type, scope_type, scope_key, confidence, source_run_id, source_task_id, created_by, branch, commit_sha, status, valid_from_commit, valid_to_commit, created_at, updated_at)
							 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
						)
						.run(
							id,
							projectRoot,
							input.factKey,
							JSON.stringify(input.factValue),
							input.valueType,
							scope.scopeType,
							scope.scopeKey ?? null,
							input.confidence ?? 1,
							input.sourceRunId ?? null,
							input.sourceTaskId ?? null,
							input.createdBy,
							input.branch ?? null,
							input.commitSha ?? null,
							input.validFromCommit ?? null,
							input.validToCommit ?? null,
							now,
							now,
						);

					return toRepoFact(
						readRepoFactRows(database, {
							factKey: input.factKey,
							scopeType: scope.scopeType,
							scopeKey: scope.scopeKey,
						})[0] as StoredRepoFactRow,
					);
				});
			} finally {
				database.close();
			}
		},

		getRepoFact(
			factKey: string,
			options?: {
				scopeType?: MemoryScopeType;
				scopeKey?: string;
			},
		): RepoFact | null {
			ensureInitialized();
			const database = openStoreDatabase();
			const scope = defaultRepoFactScope(options);
			assertScopeKeyForExactLookup(scope.scopeType, scope.scopeKey);

			try {
				const row = readRepoFactRows(database, {
					factKey,
					scopeType: scope.scopeType,
					scopeKey: scope.scopeKey,
				})[0];
				return row ? toRepoFact(row) : null;
			} finally {
				database.close();
			}
		},

		listRepoFacts(options?: {
			scopeType?: MemoryScopeType;
			scopeKey?: string;
		}): readonly RepoFact[] {
			ensureInitialized();
			const database = openStoreDatabase();
			const scope = defaultRepoFactScope(options);
			assertRepoFactListFilter(options);

			try {
				return readRepoFactRows(database, {
					scopeType: options?.scopeType ? scope.scopeType : undefined,
					scopeKey: options?.scopeKey,
				}).map(toRepoFact);
			} finally {
				database.close();
			}
		},

		retrieveRepoFacts(
			query: RepoFactRetrievalQuery,
		): readonly RankedRepoFactResult[] {
			ensureInitialized();
			const factKey = normalizeExactText(query.factKey);
			const searchText = normalizeExactText(query.searchText);
			const scopeCandidates = normalizeRepoFactScopeCandidates(
				query.scopeCandidates,
			);
			const branch = normalizeExactText(query.branch);
			const limit = normalizeRetrievalLimit(query.limit);

			if (limit === 0 || (!factKey && !searchText)) {
				return [];
			}

			const database = openStoreDatabase();
			try {
				const candidates: RankedRepoFactResult[] = [];
				if (factKey) {
					candidates.push(
						...readExactRepoFactMatches(
							database,
							factKey,
							scopeCandidates,
							branch,
						),
					);
				}
				if (searchText) {
					candidates.push(
						...readFuzzyRepoFactMatches(
							database,
							searchText,
							scopeCandidates,
							branch,
						),
					);
				}

				return dedupeRankedMemoryResults(candidates).slice(0, limit);
			} finally {
				database.close();
			}
		},

		supersedeRepoFact(
			factKey: string,
			options?: {
				scopeType?: MemoryScopeType;
				scopeKey?: string;
			},
		): number {
			ensureInitialized();
			const database = openStoreDatabase();
			const now = new Date().toISOString();
			const scope = defaultRepoFactScope(options);
			assertScopeKeyForExactLookup(scope.scopeType, scope.scopeKey);

			try {
				const result = database
					.prepare(
						`UPDATE repo_facts SET status = 'superseded', updated_at = ? WHERE repo_id = ? AND fact_key = ? AND scope_type = ? AND scope_key IS ? AND status = 'active'`,
					)
					.run(
						now,
						projectRoot,
						factKey,
						scope.scopeType,
						scope.scopeKey ?? null,
					) as {
					changes: number;
				};

				return result.changes;
			} finally {
				database.close();
			}
		},

		createProcedure(input: CreateProcedureInput): ProcedureMemory {
			ensureInitialized();
			const database = openStoreDatabase();
			const now = new Date().toISOString();

			try {
				const id = insertProcedureRow(database, input, now);
				return toProcedureMemory(
					readProcedureRows(database, {
						id,
						includeInactive: true,
					})[0] as StoredProcedureRow,
				);
			} finally {
				database.close();
			}
		},

		upsertProcedure(
			input: CreateProcedureInput,
			options?: {
				matchMetadata?: Record<string, string>;
				skipIfConflictingActiveName?: boolean;
			},
		): ProcedureMemory | null {
			ensureInitialized();
			const database = openStoreDatabase();
			const now = new Date().toISOString();

			try {
				database.exec("BEGIN IMMEDIATE");
				try {
					const sameNamedRows = readProcedureRows(database, {
						name: input.name,
						taskType: input.taskType,
					});
					const matchingRows = sameNamedRows.filter((row) =>
						procedureMetadataMatches(row, options?.matchMetadata),
					);

					if (
						options?.skipIfConflictingActiveName &&
						sameNamedRows.length > 0 &&
						matchingRows.length !== sameNamedRows.length
					) {
						database.exec("COMMIT");
						return null;
					}

					const identicalRows = matchingRows.filter(
						(row) => row.body_markdown === input.bodyMarkdown,
					);
					if (identicalRows.length > 0) {
						const canonicalRow = identicalRows[0] as StoredProcedureRow;
						for (const row of matchingRows) {
							if (row.id !== canonicalRow.id) {
								database
									.prepare(
										`UPDATE procedures SET status = 'superseded', updated_at = ? WHERE id = ? AND repo_id = ? AND status = 'active'`,
									)
									.run(now, row.id, projectRoot);
							}
						}
						database.exec("COMMIT");
						return toProcedureMemory(canonicalRow);
					}

					for (const row of matchingRows) {
						database
							.prepare(
								`UPDATE procedures SET status = 'superseded', updated_at = ? WHERE id = ? AND repo_id = ? AND status = 'active'`,
							)
							.run(now, row.id, projectRoot);
					}

					const id = insertProcedureRow(database, input, now);
					const insertedRow = readProcedureRows(database, {
						id,
						includeInactive: true,
					})[0] as StoredProcedureRow;
					database.exec("COMMIT");
					return toProcedureMemory(insertedRow);
				} catch (error) {
					try {
						database.exec("ROLLBACK");
					} catch {
						// Ignore rollback cleanup failures and surface the original error.
					}
					throw error;
				}
			} finally {
				database.close();
			}
		},

		listProcedures(options?: {
			taskType?: string;
		}): readonly ProcedureMemory[] {
			ensureInitialized();
			const database = openStoreDatabase();

			try {
				return readProcedureRows(database, {
					taskType: options?.taskType,
				}).map(toProcedureMemory);
			} finally {
				database.close();
			}
		},

		findProceduresByTaskType(taskType: string): readonly ProcedureMemory[] {
			ensureInitialized();
			const database = openStoreDatabase();

			try {
				return readProcedureRows(database, { taskType }).map(toProcedureMemory);
			} finally {
				database.close();
			}
		},

		retrieveProcedures(
			query: ProcedureRetrievalQuery,
		): readonly RankedProcedureResult[] {
			ensureInitialized();
			const limit = normalizeRetrievalLimit(query.limit);
			const hasQuery = Boolean(
				normalizeExactText(query.name) ||
					normalizeExactText(query.taskType) ||
					normalizeExactText(query.searchText),
			);

			if (limit === 0 || !hasQuery) {
				return [];
			}

			const database = openStoreDatabase();
			try {
				return dedupeRankedMemoryResults(
					readRankedProcedureMatches(database, query),
				).slice(0, limit);
			} finally {
				database.close();
			}
		},

		supersedeProcedure(id: string): number {
			ensureInitialized();
			const database = openStoreDatabase();
			const now = new Date().toISOString();

			try {
				const result = database
					.prepare(
						`UPDATE procedures SET status = 'superseded', updated_at = ? WHERE id = ? AND repo_id = ? AND status = 'active'`,
					)
					.run(now, id, projectRoot) as { changes: number };
				return result.changes;
			} finally {
				database.close();
			}
		},

		createSearchableDocument(
			input: CreateSearchableDocumentInput,
		): SearchableDocument {
			ensureInitialized();
			const database = openStoreDatabase();
			const now = new Date().toISOString();

			try {
				const id = randomUUID();
				database
					.prepare(
						`INSERT INTO searchable_documents (id, repo_id, source_table, source_id, document_kind, title, body_text, metadata_json, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						id,
						projectRoot,
						input.sourceTable,
						input.sourceId,
						input.documentKind,
						input.title ?? null,
						input.bodyText,
						input.metadata ? JSON.stringify(input.metadata) : null,
						now,
						now,
					);

				const rowId = database
					.prepare(`SELECT rowid FROM searchable_documents WHERE id = ?`)
					.get(id) as { rowid: number };
				database
					.prepare(
						`INSERT INTO searchable_documents_fts (rowid, title, body_text) VALUES (?, ?, ?)`,
					)
					.run(rowId.rowid, input.title ?? null, input.bodyText);

				return toSearchableDocument(
					readSearchableDocumentRows(database, {
						id,
					})[0] as StoredSearchableDocumentRow,
				);
			} finally {
				database.close();
			}
		},

		getSearchableDocument(id: string): SearchableDocument | undefined {
			ensureInitialized();
			const database = openStoreDatabase();

			try {
				const row = readSearchableDocumentRows(database, { id })[0];
				return row ? toSearchableDocument(row) : undefined;
			} finally {
				database.close();
			}
		},

		listSearchableDocuments(options?: {
			documentKind?: string;
			sourceTable?: string;
			sourceId?: string;
			limit?: number;
		}): readonly SearchableDocument[] {
			ensureInitialized();
			const database = openStoreDatabase();

			try {
				return readSearchableDocumentRows(database, options ?? {}).map(
					toSearchableDocument,
				);
			} finally {
				database.close();
			}
		},

		searchSearchableDocuments(
			query: string,
			options?: {
				documentKind?: string;
				limit?: number;
			},
		): readonly SearchableDocument[] {
			ensureInitialized();
			const database = openStoreDatabase();

			try {
				return searchSearchableDocumentRows(database, query, options).map(
					toSearchableDocument,
				);
			} finally {
				database.close();
			}
		},

		retrieveSearchableDocuments(
			query: SearchableDocumentRetrievalQuery,
		): readonly RankedSearchableDocumentResult[] {
			ensureInitialized();
			const limit = normalizeRetrievalLimit(query.limit);
			const hasQuery = Boolean(
				normalizeExactText(query.title) ||
					(query.sourceTable && query.sourceId) ||
					normalizeExactText(query.searchText),
			);

			if (limit === 0 || !hasQuery) {
				return [];
			}

			const database = openStoreDatabase();
			try {
				return dedupeRankedMemoryResults(
					readRankedSearchableDocumentMatches(database, query),
				).slice(0, limit);
			} finally {
				database.close();
			}
		},

		recordInjectedMemories(
			runId: string,
			records: readonly InjectedMemoryRecord[],
		): void {
			ensureInitialized();
			const database = openStoreDatabase();
			const now = new Date().toISOString();

			try {
				runInTransaction(database, () => {
					database
						.prepare(`DELETE FROM injected_memories WHERE run_id = ?`)
						.run(runId);

					for (const record of records) {
						database
							.prepare(
								`INSERT INTO injected_memories (id, run_id, memory_kind, memory_id, display_text, match_reason, match_class, scope_preference_index, created_at)
								 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
							)
							.run(
								randomUUID(),
								runId,
								record.memoryKind,
								record.memoryId,
								record.displayText,
								record.matchReason,
								record.matchClass,
								record.scopePreferenceIndex ?? null,
								now,
							);
					}
				});
			} finally {
				database.close();
			}
		},

		listInjectedMemories(
			runId: string,
		): readonly PersistedInjectedMemoryRecord[] {
			ensureInitialized();
			const database = openStoreDatabase();
			try {
				return readInjectedMemoryRows(runId, database);
			} finally {
				database.close();
			}
		},

		getStatusSnapshot(): WorkspaceAwareStatusSnapshot {
			ensureInitialized();
			const database = openStoreDatabase();

			try {
				const latestRun = database
					.prepare(
						`SELECT id, unit_id, status, used_workspace FROM runs ORDER BY created_at DESC, rowid DESC LIMIT 1`,
					)
					.get() as
					| {
							id: string;
							unit_id: string;
							status:
								| "pending"
								| "running"
								| "passed"
								| "failed"
								| "cancelled"
								| "suspended";
							used_workspace: number;
					  }
					| undefined;

				const countRows = database
					.prepare(`SELECT status, COUNT(*) as count FROM runs GROUP BY status`)
					.all() as unknown as {
					status: RunStatus;
					count: number;
				}[];

				const runCounts: Record<RunStatus, number> = {
					pending: 0,
					running: 0,
					passed: 0,
					failed: 0,
					cancelled: 0,
					suspended: 0,
				};

				for (const row of countRows) {
					runCounts[row.status] = row.count;
				}

				const actionableWorkspaces = database
					.prepare(
						`SELECT run_id, source_project_root, path, head_sha, status, created_at, finalized_at, cleanup_error FROM workspaces WHERE status IN ('retained', 'cleanup-failed') ORDER BY COALESCE(finalized_at, created_at) DESC, rowid DESC`,
					)
					.all() as unknown as StoredWorkspaceRow[];

				const latestWorkspace = latestRun
					? readWorkspaceRow(latestRun.id, database)
					: undefined;

				if (!latestRun) {
					const snapshot = {
						initialized: true,
						latestRunUsedWorkspace: false,
						actionableWorkspaces: actionableWorkspaces.map(toWorkspaceSnapshot),
						runCounts,
					};
					return snapshot as WorkspaceAwareStatusSnapshot;
				}

				const snapshot = {
					initialized: true,
					latestRun: {
						id: latestRun.id,
						unitId: latestRun.unit_id,
						status: latestRun.status,
					},
					latestRunUsedWorkspace: latestRun.used_workspace === 1,
					latestWorkspace: latestWorkspace
						? toStatusWorkspaceSummary(latestWorkspace)
						: undefined,
					actionableWorkspaces: actionableWorkspaces.map(toWorkspaceSnapshot),
					runCounts,
				};
				return snapshot as WorkspaceAwareStatusSnapshot;
			} finally {
				database.close();
			}
		},

		listRunsByStatus(
			status: RunStatus,
			options?: { limit?: number; cursor?: string },
		): RunPage {
			ensureInitialized();
			const database = openStoreDatabase();
			try {
				const limit = options?.limit;
				const afterRowid = decodeRunCursor(options?.cursor);

				const clauses = ["status = ?"];
				const params: (string | number)[] = [status];
				if (afterRowid !== undefined) {
					clauses.push("rowid > ?");
					params.push(afterRowid);
				}
				// Over-fetch one row so a non-empty next page is detectable without a
				// second COUNT query; the sentinel is trimmed before returning.
				const limitClause =
					limit !== undefined && limit > 0 ? ` LIMIT ${limit + 1}` : "";

				const rows = database
					.prepare(
						`SELECT rowid AS rowid, id, unit_id, status, parent_run_id FROM runs WHERE ${clauses.join(
							" AND ",
						)} ORDER BY created_at ASC, rowid ASC${limitClause}`,
					)
					.all(...params) as {
					rowid: number;
					id: string;
					unit_id: string;
					status: string;
					parent_run_id: string | null;
				}[];

				const hasMore = limit !== undefined && limit > 0 && rows.length > limit;
				const pageRows = hasMore ? rows.slice(0, limit) : rows;
				const lastRow = pageRows[pageRows.length - 1];

				const runs = pageRows.map((row) => ({
					id: row.id,
					unitId: row.unit_id,
					status: row.status as RunStatus,
					...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
				})) as Run[] & { cursor?: string };

				if (hasMore && lastRow) {
					runs.cursor = encodeRunCursor(lastRow.rowid);
				}
				return runs;
			} finally {
				database.close();
			}
		},

		recordAcceptanceShadow(
			runId: string,
			outcome: AcceptanceShadowOutcome,
		): void {
			ensureInitialized();
			const database = openStoreDatabase();
			try {
				database
					.prepare(`UPDATE runs SET acceptance_outcome = ? WHERE id = ?`)
					.run(outcome, runId);
			} finally {
				database.close();
			}
		},

		listPendingOperatorDecisions(): readonly PendingOperatorDecision[] {
			ensureInitialized();
			const database = openStoreDatabase();
			try {
				const rows = database
					.prepare(
						`SELECT r.id AS id, r.status AS status, r.acceptance_outcome AS acceptance_outcome, r.updated_at AS updated_at
						 FROM runs r
						 WHERE (r.status = 'suspended' OR r.acceptance_outcome = 'passed')
						   AND NOT EXISTS (
						      SELECT 1 FROM events e
						      WHERE e.kind = 'operator_decision_recorded'
						        AND json_extract(e.payload, '$.runId') = r.id
						   )
						 ORDER BY r.created_at ASC, r.rowid ASC`,
					)
					.all() as {
					id: string;
					status: string;
					acceptance_outcome: string | null;
					updated_at: string;
				}[];

				return rows.map((row) => ({
					runId: row.id,
					subject: row.status === "suspended" ? "resume" : "merge",
					since: row.updated_at,
				}));
			} finally {
				database.close();
			}
		},

		recordOperatorDecisionShadow(shadow: OperatorDecisionShadow): void {
			ensureInitialized();
			const database = openStoreDatabase();
			try {
				// Tier-1 mirror of the signed Tier-2 event. The payload carries
				// camelCase `runId` (M5-S4 D2) — `listPendingOperatorDecisions`
				// excludes on `json_extract(payload, '$.runId')`, and the reconciler
				// reads it back here.
				appendEvent(
					"operator_decision_recorded",
					{
						runId: shadow.runId,
						decision: shadow.decision,
						subject: shadow.subject,
						decidedBy: shadow.decidedBy,
						decidedAt: shadow.decidedAt,
					},
					database,
				);
			} finally {
				database.close();
			}
		},

		markOperatorDecisionExecuted(
			runId: string,
			outcome?: { mergedHeadSha?: string },
		): void {
			ensureInitialized();
			const database = openStoreDatabase();
			try {
				// The exactly-once gate (M5-S4 D2/D4): once present, the run drops
				// out of `listDecidedUnexecutedDecisions`, so the reconciler can never
				// re-drive (or double-merge) it.
				appendEvent(
					"operator_decision_executed",
					{
						runId,
						...(outcome?.mergedHeadSha
							? { mergedHeadSha: outcome.mergedHeadSha }
							: {}),
					},
					database,
				);
			} finally {
				database.close();
			}
		},

		isOperatorDecisionExecuted(runId: string): boolean {
			ensureInitialized();
			const database = openStoreDatabase();
			try {
				const row = database
					.prepare(
						`SELECT 1 FROM events
						 WHERE kind = 'operator_decision_executed'
						   AND json_extract(payload, '$.runId') = ?
						 LIMIT 1`,
					)
					.get(runId);
				return row !== undefined;
			} finally {
				database.close();
			}
		},

		getRunAcceptanceOutcome(runId: string): "passed" | "rejected" | null {
			ensureInitialized();
			const database = openStoreDatabase();
			try {
				const row = database
					.prepare(`SELECT acceptance_outcome FROM runs WHERE id = ?`)
					.get(runId) as { acceptance_outcome: string | null } | undefined;
				const outcome = row?.acceptance_outcome ?? null;
				return outcome === "passed" || outcome === "rejected" ? outcome : null;
			} finally {
				database.close();
			}
		},

		listDecidedUnexecutedDecisions(): readonly DecidedUnexecutedDecision[] {
			ensureInitialized();
			const database = openStoreDatabase();
			try {
				// At most one row per run (M5-S4 F5): a duplicate Tier-1 shadow (e.g.
				// the residual crash-window operator re-decide) must not double-feed
				// the reconciler. GROUP BY runId keeps the earliest decision row.
				const rows = database
					.prepare(
						`SELECT json_extract(e.payload, '$.runId')   AS run_id,
						        json_extract(e.payload, '$.decision') AS decision,
						        json_extract(e.payload, '$.subject')  AS subject
						 FROM events e
						 WHERE e.kind = 'operator_decision_recorded'
						   AND NOT EXISTS (
						      SELECT 1 FROM events x
						      WHERE x.kind = 'operator_decision_executed'
						        AND json_extract(x.payload, '$.runId') = json_extract(e.payload, '$.runId')
						   )
						 GROUP BY json_extract(e.payload, '$.runId')
						 ORDER BY MIN(e.rowid) ASC`,
					)
					.all() as {
					run_id: string;
					decision: string;
					subject: string;
				}[];

				return rows.map((row) => ({
					runId: row.run_id,
					decision: row.decision as DecidedUnexecutedDecision["decision"],
					subject: row.subject as DecidedUnexecutedDecision["subject"],
				}));
			} finally {
				database.close();
			}
		},

		inspectTarget(id: string): WorkspaceAwareInspectSnapshot {
			ensureInitialized();
			const database = openStoreDatabase();

			try {
				const runRow = database
					.prepare(
						`SELECT id, unit_id, status, unit_snapshot, used_workspace, parent_run_id, strategy_id FROM runs WHERE id = ?`,
					)
					.get(id) as unknown as StoredRunRow | undefined;

				if (runRow) {
					const parsedSnapshot = runRow.unit_snapshot
						? JSON.parse(runRow.unit_snapshot)
						: null;
					const unit: Unit =
						parsedSnapshot && "unit" in parsedSnapshot
							? (parsedSnapshot.unit as Unit)
							: parsedSnapshot
								? (parsedSnapshot as Unit)
								: readUnit(runRow.unit_id, database);
					const injectedMemories = readInjectedMemoryRows(runRow.id, database);
					const decisions = readDecisions(runRow.id, database);
					const candidate = readCandidateArtifactRow(runRow.id, database);
					const snapshot = {
						kind: "run",
						unit,
						run: toRun(runRow),
						eventTape: readEventTapeSummary(runRow.id, database),
						provenance: buildInspectProvenance(
							parsedSnapshot && "unit" in parsedSnapshot
								? (parsedSnapshot as UnitPacket)
								: null,
							unit,
							injectedMemories,
							decisions,
						),
						workspace: readWorkspaceSnapshot(runRow.id, database),
						...(candidate
							? { candidate: toCandidateArtifactProjection(candidate) }
							: {}),
						strategy: toStrategySummary(runRow),
						injectedMemories,
						promotedStructuredMemories: readPromotedStructuredMemoryRows(
							runRow.id,
							database,
						),
						runHistory: [{ id: runRow.id, status: runRow.status }],
						evidence: readEvidence(runRow.id, database),
						decisions,
						artifacts: readArtifacts(runRow.id, database),
					};
					return snapshot as WorkspaceAwareInspectSnapshot;
				}

				const unitRow = database
					.prepare(`SELECT id FROM units WHERE id = ?`)
					.get(id) as { id: string } | undefined;

				if (unitRow) {
					const unit = readUnit(unitRow.id, database);
					const runHistory = readRunHistory(unitRow.id, database);
					const latestRun = runHistory[0];

					if (!latestRun) {
						throw new Error(`No run found for unit '${unitRow.id}'`);
					}

					const run = readRun(latestRun.id, database);
					const parsedSnapshot = run.unit_snapshot
						? JSON.parse(run.unit_snapshot)
						: null;
					const injectedMemories = readInjectedMemoryRows(run.id, database);
					const decisions = readDecisions(run.id, database);
					const candidate = readCandidateArtifactRow(run.id, database);
					const snapshot = {
						kind: "unit",
						unit,
						run: toRun(run),
						eventTape: readEventTapeSummary(run.id, database),
						provenance: buildInspectProvenance(
							parsedSnapshot && "unit" in parsedSnapshot
								? (parsedSnapshot as UnitPacket)
								: null,
							unit,
							injectedMemories,
							decisions,
						),
						workspace: readWorkspaceSnapshot(run.id, database),
						...(candidate
							? { candidate: toCandidateArtifactProjection(candidate) }
							: {}),
						strategy: toStrategySummary(run),
						injectedMemories,
						promotedStructuredMemories: readPromotedStructuredMemoryRows(
							run.id,
							database,
						),
						runHistory,
						evidence: readEvidence(run.id, database),
						decisions,
						artifacts: readArtifacts(run.id, database),
					};
					return snapshot as WorkspaceAwareInspectSnapshot;
				}

				throw new Error(`No run or unit found for id '${id}'`);
			} finally {
				database.close();
			}
		},

		listEvents(options: {
			runId: string;
			limit?: number;
		}): readonly ExecutionEvent[] {
			ensureInitialized();
			const events = createEventStore(projectRoot).getEventsByRunId(
				options.runId,
			);
			if (options.limit === undefined || options.limit >= events.length) {
				return events;
			}
			return events.slice(events.length - options.limit);
		},

		appendRunOutcome(input: AppendRunOutcomeInput): RunOutcome {
			ensureInitialized();
			const database = openStoreDatabase();
			const now = new Date().toISOString();

			try {
				return runInTransaction(database, () => {
					database
						.prepare(
							`INSERT INTO run_outcomes (id, repo_id, task_type, worker, success, source_run_id, created_at)
							 VALUES (?, ?, ?, ?, ?, ?, ?)
							 ON CONFLICT(repo_id, source_run_id) DO NOTHING`,
						)
						.run(
							randomUUID(),
							projectRoot,
							input.taskType,
							input.worker,
							input.success ? 1 : 0,
							input.sourceRunId,
							now,
						);

					const row = database
						.prepare(
							`SELECT id, repo_id, task_type, worker, success, source_run_id, created_at
							 FROM run_outcomes
							 WHERE repo_id = ? AND source_run_id = ?`,
						)
						.get(
							projectRoot,
							input.sourceRunId,
						) as unknown as StoredRunOutcomeRow;

					return toRunOutcome(row);
				});
			} finally {
				database.close();
			}
		},

		listRunOutcomes(options?: {
			repoId?: string;
			taskType?: string;
			worker?: WorkerLabel;
		}): readonly RunOutcome[] {
			ensureInitialized();
			const database = openStoreDatabase();
			const clauses = ["repo_id = ?"];
			const params: string[] = [options?.repoId ?? projectRoot];

			if (options?.taskType !== undefined) {
				clauses.push("task_type = ?");
				params.push(options.taskType);
			}
			if (options?.worker !== undefined) {
				clauses.push("worker = ?");
				params.push(options.worker);
			}

			try {
				const rows = database
					.prepare(
						`SELECT id, repo_id, task_type, worker, success, source_run_id, created_at
						 FROM run_outcomes
						 WHERE ${clauses.join(" AND ")}
						 ORDER BY created_at, rowid`,
					)
					.all(...params) as unknown as StoredRunOutcomeRow[];
				return rows.map(toRunOutcome);
			} finally {
				database.close();
			}
		},

		getRunHistory(): RunHistoryEntry[] {
			ensureInitialized();
			const database = openStoreDatabase();

			try {
				const rows = database
					.prepare(
						`SELECT id, unit_id, status, strategy_id, unit_snapshot, created_at, completed_at FROM runs ORDER BY created_at DESC, rowid DESC`,
					)
					.all() as unknown as {
					id: string;
					unit_id: string;
					status: RunStatus;
					strategy_id: string | null;
					unit_snapshot: string | null;
					created_at: string;
					completed_at: string | null;
				}[];

				return rows.map((row) => {
					const parsedSnapshot = row.unit_snapshot
						? JSON.parse(row.unit_snapshot)
						: null;
					const historyUnit: Unit =
						parsedSnapshot && "unit" in parsedSnapshot
							? (parsedSnapshot.unit as Unit)
							: parsedSnapshot
								? (parsedSnapshot as Unit)
								: readUnit(row.unit_id, database);
					const historyPacket =
						parsedSnapshot && "unit" in parsedSnapshot
							? (parsedSnapshot as UnitPacket)
							: null;
					const provenance = buildInspectProvenance(
						historyPacket,
						historyUnit,
						[],
						[],
					);

					return {
						id: row.id,
						unitId: row.unit_id,
						status: row.status,
						strategyId: row.strategy_id ?? undefined,
						injectedMemoryCount: countInjectedMemories(row.id, database),
						promotedStructuredMemoryCount: countPromotedStructuredMemories(
							row.id,
							database,
						),
						routeWorker: provenance.route.worker,
						routeSource: provenance.route.source,
						policyProfile: provenance.policy.profile,
						createdAt: row.created_at,
						completedAt: row.completed_at ?? undefined,
					};
				});
			} finally {
				database.close();
			}
		},

		recordRunStrategyId(runId: string, strategyId: string): void {
			ensureInitialized();
			const database = openStoreDatabase();
			try {
				readRun(runId, database);
				database
					.prepare(
						`UPDATE runs SET strategy_id = ?, updated_at = ? WHERE id = ?`,
					)
					.run(strategyId, new Date().toISOString(), runId);
			} finally {
				database.close();
			}
		},

		getPacketSnapshot(runId: string): UnitPacket | null {
			ensureInitialized();
			const database = openStoreDatabase();

			const row = database
				.prepare(`SELECT unit_snapshot FROM runs WHERE id = ?`)
				.get(runId) as { unit_snapshot: string } | undefined;

			database.close();

			if (!row?.unit_snapshot) return null;

			try {
				return parseUnitPacket(row.unit_snapshot);
			} catch {
				return null;
			}
		},
	};
}
