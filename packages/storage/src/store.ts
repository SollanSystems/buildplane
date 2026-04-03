import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
	ApprovedPolicyDecision,
	BuildplaneStoragePort,
	CreateRunOptions,
	ExecutionReceipt,
	InspectSnapshot,
	PolicyDecision,
	RejectedPolicyDecision,
	Run,
	RunStatus,
	StatusSnapshot,
	StatusWorkspaceSummary,
	Unit,
	UnitPacket,
	WorkspaceSnapshot,
} from "@buildplane/kernel";
import {
	assertBuildplaneDatabaseIsInitialized,
	openBuildplaneDatabase,
} from "./database.js";
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
	getStatusSnapshot(): WorkspaceAwareStatusSnapshot;
	inspectTarget(id: string): WorkspaceAwareInspectSnapshot;
	getRunHistory(): RunHistoryEntry[];
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

function tableExists(database: DatabaseSync, tableName: string): boolean {
	const row = database
		.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
		)
		.get(tableName) as { name: string } | undefined;
	return row?.name === tableName;
}

function assertWorkspaceTableColumns(database: DatabaseSync): void {
	for (const columnName of [
		"run_id",
		"source_project_root",
		"path",
		"head_sha",
		"status",
		"created_at",
		"finalized_at",
		"cleanup_error",
	] as const) {
		if (!tableHasColumn(database, "workspaces", columnName)) {
			throw new Error(
				"Buildplane state is incomplete: state.db is missing required projection schema. Remove .buildplane or repair the database before rerunning `buildplane init`.",
			);
		}
	}
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
	`);

	ensureEvidenceMessageColumn(database);
	ensureRunsUsedWorkspaceColumn(database);
	ensureRunsStrategyColumns(database);
	assertWorkspaceTableColumns(database);
}

export function assertBaselineStorageProjectionSchema(
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
}

export interface RunHistoryEntry {
	readonly id: string;
	readonly unitId: string;
	readonly status: RunStatus;
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
			.get(runId) as StoredRunRow | undefined;

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
			.get(runId) as StoredWorkspaceRow | undefined;
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
			const runId = randomUUID();
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
				appendEvent("run-started", { runId, status: "running" }, database);
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
						`SELECT id, unit_id, status, unit_snapshot, used_workspace FROM runs WHERE id = ?`,
					)
					.get(id) as StoredRunRow | undefined;

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
					const snapshot = {
						kind: "run",
						unit,
						run: toRun(runRow),
						workspace: readWorkspaceSnapshot(runRow.id, database),
						runHistory: [{ id: runRow.id, status: runRow.status }],
						evidence: readEvidence(runRow.id, database),
						decisions: readDecisions(runRow.id, database),
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
					const snapshot = {
						kind: "unit",
						unit,
						run: toRun(run),
						workspace: readWorkspaceSnapshot(run.id, database),
						runHistory,
						evidence: readEvidence(run.id, database),
						decisions: readDecisions(run.id, database),
						artifacts: readArtifacts(run.id, database),
					};
					return snapshot as WorkspaceAwareInspectSnapshot;
				}

				throw new Error(`No run or unit found for id '${id}'`);
			} finally {
				database.close();
			}
		},

		getRunHistory(): RunHistoryEntry[] {
			ensureInitialized();
			const database = openStoreDatabase();

			const rows = database
				.prepare(
					`SELECT id, unit_id, status, created_at, completed_at FROM runs ORDER BY created_at DESC, rowid DESC`,
				)
				.all() as unknown as {
				id: string;
				unit_id: string;
				status: RunStatus;
				created_at: string;
				completed_at: string | null;
			}[];

			database.close();

			return rows.map((row) => ({
				id: row.id,
				unitId: row.unit_id,
				status: row.status,
				createdAt: row.created_at,
				completedAt: row.completed_at ?? undefined,
			}));
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
