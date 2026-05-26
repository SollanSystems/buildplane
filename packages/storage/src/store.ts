import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
	type ApprovedPolicyDecision,
	type BuildplaneStoragePort,
	type CreateProcedureInput,
	type CreateRunOptions,
	type CreateSearchableDocumentInput,
	createRankedMemoryResult,
	dedupeRankedMemoryResults,
	type ExecutionEvent,
	type ExecutionReceipt,
	type InjectedMemoryRecord,
	type InspectSnapshot,
	type MemoryScopeType,
	type PersistedInjectedMemoryRecord,
	type PolicyDecision,
	type ProcedureMemory,
	type ProcedureRetrievalQuery,
	type PromotedStructuredMemoryRecord,
	type RankedProcedureResult,
	type RankedRepoFactResult,
	type RankedSearchableDocumentResult,
	type RejectedPolicyDecision,
	type RepoFact,
	type RepoFactRetrievalQuery,
	type RepoFactScopeCandidate,
	type Run,
	type RunStatus,
	type SearchableDocument,
	type SearchableDocumentRetrievalQuery,
	type StatusSnapshot,
	type StatusWorkspaceSummary,
	type Unit,
	type UnitPacket,
	type UpsertRepoFactInput,
	type WorkspaceSnapshot,
} from "@buildplane/kernel";
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
}

export interface CreateStorageStoreOptions {
	readonly testingHooks?: StorageTestingHooks;
}

type WorkspaceAwareStatusSnapshot = StatusSnapshot & {
	readonly latestRunUsedWorkspace: boolean;
	readonly latestWorkspace?: StatusWorkspaceSummary;
	readonly actionableWorkspaces: readonly WorkspaceSnapshot[];
};

type WorkspaceAwareInspectSnapshot = InspectSnapshot & {
	readonly workspace?: WorkspaceSnapshot;
	readonly strategy?: {
		readonly strategyId: string;
	};
	readonly injectedMemories?: readonly PersistedInjectedMemoryRecord[];
	readonly promotedStructuredMemories?: readonly PromotedStructuredMemoryRecord[];
};

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
	recordWorkspaceDeleted(runId: string): void;
	recordWorkspaceCleanupFailed(runId: string, message: string): void;
	recordWorkspaceCleanedUp(runId: string): void;
	getStatusSnapshot(): WorkspaceAwareStatusSnapshot;
	inspectTarget(id: string): WorkspaceAwareInspectSnapshot;
	getRunHistory(): RunHistoryEntry[];
	recordRunStrategyId(runId: string, strategyId: string): void;
	getPacketSnapshot(runId: string): UnitPacket | null;
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

export function bootstrapStorageProjectionSchema(database: DatabaseSync): void {
	if (tableExists(database, "workspaces")) {
		assertWorkspaceTableColumns(database);
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
			used_workspace INTEGER NOT NULL DEFAULT 0
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
	`);

	database.exec(`
		CREATE INDEX IF NOT EXISTS injected_memories_run_id_idx
		ON injected_memories (run_id);
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
	ensureRunLearningsTable(database);
	ensureSeenCountColumn(database);
	ensureRunsStepColumns(database);
	ensureRepoFactColumns(database);
	ensureProcedureColumns(database);
	assertWorkspaceTableColumns(database);
	assertRepoFactsTableColumns(database);
	assertProceduresTableColumns(database);
	assertSearchableDocumentsTableColumns(database);
	assertInjectedMemoriesTableColumns(database);
}

export function assertBaselineStorageProjectionSchema(
	database: DatabaseSync,
): void {
	const rows = database
		.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('units', 'runs', 'evidence', 'decisions', 'artifacts', 'repo_facts', 'procedures', 'searchable_documents', 'injected_memories')`,
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
		database.exec("BEGIN");
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
		return relative(projectRoot, destinationPath);
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
				`SELECT id, unit_id, status, unit_snapshot, used_workspace, parent_run_id, strategy_id FROM runs WHERE id = ?`,
			)
			.get(runId) as unknown as StoredRunRow | undefined;

		if (!row) {
			throw new Error(`No run found for id '${runId}'`);
		}

		return row;
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
						`INSERT INTO runs (id, unit_id, status, unit_snapshot, created_at, updated_at, completed_at, used_workspace, parent_run_id, strategy_id) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
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
					);

				appendEvent(
					"run-created",
					{ runId, unitId: packet.unit.id, status: "pending" },
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
				const runRow = readRun(runId, database);
				if (runRow.status !== "pending") {
					throw new Error("Run start requires a pending run.");
				}
				database
					.prepare(`UPDATE runs SET status = ?, updated_at = ? WHERE id = ?`)
					.run("running", updatedAt, runId);
				appendEvent(
					"run-started",
					{ runId, unitId: runRow.unit_id, status: "running" },
					database,
				);
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
				const runRow = readRun(runId, database);
				if (runRow.status !== "pending" && runRow.status !== "running") {
					throw new Error("Run completion requires a pending or running run.");
				}
				if (runRow.used_workspace === 1 || readWorkspaceRow(runId, database)) {
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
				const runRow = readRun(runId, database);
				if (runRow.status !== "running") {
					throw new Error(
						`suspendRun requires a running run, got '${runRow.status}'.`,
					);
				}
				database
					.prepare(`UPDATE runs SET status = ?, updated_at = ? WHERE id = ?`)
					.run("suspended", updatedAt, runId);
				appendEvent(
					"run-suspended",
					{ runId, unitId: runRow.unit_id, status: "suspended" },
					database,
				);
				return toRun({ ...runRow, status: "suspended" });
			} finally {
				database.close();
			}
		},

		approveRun(runId: string): Run {
			ensureInitialized();
			const database = openStoreDatabase();
			const updatedAt = new Date().toISOString();

			try {
				const runRow = readRun(runId, database);
				if (runRow.status !== "suspended") {
					throw new Error(
						`approveRun requires a suspended run, got '${runRow.status}'.`,
					);
				}
				database
					.prepare(`UPDATE runs SET status = ?, updated_at = ? WHERE id = ?`)
					.run("pending", updatedAt, runId);
				appendEvent(
					"run-resumed",
					{ runId, unitId: runRow.unit_id, status: "pending" },
					database,
				);
				return toRun({ ...runRow, status: "pending" });
			} finally {
				database.close();
			}
		},

		rejectSuspendedRun(runId: string): Run {
			ensureInitialized();
			const database = openStoreDatabase();
			const updatedAt = new Date().toISOString();

			try {
				const runRow = readRun(runId, database);
				if (runRow.status !== "suspended") {
					throw new Error(
						`rejectSuspendedRun requires a suspended run, got '${runRow.status}'.`,
					);
				}
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

			const parsed = JSON.parse(row.unit_snapshot);
			if (parsed && "unit" in parsed && "verification" in parsed) {
				return parsed as UnitPacket;
			}
			return null;
		},
	};
}
