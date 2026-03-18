import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type {
	BuildplaneStoragePort,
	ExecutionReceipt,
	InspectSnapshot,
	PolicyDecision,
	StatusSnapshot,
	Unit,
	UnitPacket,
} from "@buildplane/kernel";
import {
	assertBuildplaneDatabaseIsInitialized,
	openBuildplaneDatabase,
} from "./database.js";
import { resolveProjectLayout } from "./project-layout.js";

interface StoredRunRow {
	readonly id: string;
	readonly unit_id: string;
	readonly status: "pending" | "running" | "passed" | "failed" | "cancelled";
	readonly unit_snapshot?: string;
}

interface StoredDecisionRow {
	readonly id: string;
	readonly kind: PolicyDecision["kind"];
	readonly outcome: PolicyDecision["outcome"];
	readonly reasons: string;
}

export function bootstrapStorageProjectionSchema(database: DatabaseSync): void {
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
			completed_at TEXT
		);

		CREATE TABLE IF NOT EXISTS evidence (
			id TEXT PRIMARY KEY,
			run_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			status TEXT NOT NULL
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
	`);
}

function assertStorageProjectionSchema(database: DatabaseSync): void {
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

export function createStorageStore(
	projectRoot: string,
): Omit<BuildplaneStoragePort, "initializeProject"> {
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
		assertStorageProjectionSchema(database);
		return database;
	}

	function appendEvent(
		kind: string,
		payload: Record<string, unknown>,
		database: ReturnType<typeof openStoreDatabase>,
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

	function readUnit(
		unitId: string,
		database: ReturnType<typeof openStoreDatabase>,
	): Unit {
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

	function readRun(
		runId: string,
		database: ReturnType<typeof openStoreDatabase>,
	): StoredRunRow {
		const row = database
			.prepare(
				`SELECT id, unit_id, status, unit_snapshot FROM runs WHERE id = ?`,
			)
			.get(runId) as StoredRunRow | undefined;

		if (!row) {
			throw new Error(`No run found for id '${runId}'`);
		}

		return row;
	}

	function readEvidence(
		runId: string,
		database: ReturnType<typeof openStoreDatabase>,
	): InspectSnapshot["evidence"] {
		return database
			.prepare(
				`SELECT id, kind, status FROM evidence WHERE run_id = ? ORDER BY rowid ASC`,
			)
			.all(runId) as unknown as InspectSnapshot["evidence"];
	}

	function readDecisions(
		runId: string,
		database: ReturnType<typeof openStoreDatabase>,
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
		database: ReturnType<typeof openStoreDatabase>,
	): InspectSnapshot["artifacts"] {
		return database
			.prepare(
				`SELECT id, type, location FROM artifacts WHERE run_id = ? ORDER BY rowid ASC`,
			)
			.all(runId) as unknown as InspectSnapshot["artifacts"];
	}

	function readRunHistory(
		unitId: string,
		database: ReturnType<typeof openStoreDatabase>,
	): InspectSnapshot["runHistory"] {
		const rows = database
			.prepare(
				`SELECT id, status FROM runs WHERE unit_id = ? ORDER BY created_at DESC, rowid DESC`,
			)
			.all(unitId) as unknown as InspectSnapshot["runHistory"];

		return rows;
	}

	return {
		createRun(packet: UnitPacket) {
			ensureInitialized();
			const database = openStoreDatabase();
			const createdAt = new Date().toISOString();
			const runId = randomUUID();

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
					`INSERT INTO runs (id, unit_id, status, unit_snapshot, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
				)
				.run(
					runId,
					packet.unit.id,
					"pending",
					JSON.stringify(packet.unit),
					createdAt,
					createdAt,
				);

			appendEvent(
				"run-created",
				{ runId, unitId: packet.unit.id, status: "pending" },
				database,
			);
			database.close();

			return {
				id: runId,
				unitId: packet.unit.id,
				status: "pending",
			};
		},

		markRunRunning(runId: string) {
			ensureInitialized();
			const database = openStoreDatabase();
			const updatedAt = new Date().toISOString();

			readRun(runId, database);
			database
				.prepare(`UPDATE runs SET status = ?, updated_at = ? WHERE id = ?`)
				.run("running", updatedAt, runId);
			appendEvent("run-started", { runId, status: "running" }, database);
			database.close();
		},

		recordExecutionEvidence(runId: string, receipt: ExecutionReceipt) {
			ensureInitialized();
			const database = openStoreDatabase();

			readRun(runId, database);
			writeRunLogs(runId, receipt);

			database
				.prepare(
					`INSERT INTO evidence (id, run_id, kind, status) VALUES (?, ?, ?, ?)`,
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
						`INSERT INTO evidence (id, run_id, kind, status) VALUES (?, ?, ?, ?)`,
					)
					.run(
						randomUUID(),
						runId,
						"output-check",
						check.exists ? "pass" : "fail",
					);

				if (check.exists) {
					database
						.prepare(
							`INSERT INTO artifacts (id, run_id, type, location) VALUES (?, ?, ?, ?)`,
						)
						.run(randomUUID(), runId, "required-output", check.path);
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
			database.close();
		},

		recordDecision(runId: string, decision: PolicyDecision) {
			ensureInitialized();
			const database = openStoreDatabase();

			readRun(runId, database);
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
			database.close();
		},

		completeRun(runId: string, status) {
			ensureInitialized();
			const database = openStoreDatabase();
			const completedAt = new Date().toISOString();

			readRun(runId, database);
			database
				.prepare(
					`UPDATE runs SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
				)
				.run(status, completedAt, completedAt, runId);
			appendEvent("run-completed", { runId, status }, database);

			const row = readRun(runId, database);
			database.close();

			return {
				id: row.id,
				unitId: row.unit_id,
				status: row.status,
			};
		},

		getStatusSnapshot(): StatusSnapshot {
			ensureInitialized();
			const database = openStoreDatabase();

			const latestRun = database
				.prepare(
					`SELECT id, unit_id, status FROM runs ORDER BY created_at DESC, rowid DESC LIMIT 1`,
				)
				.get() as
				| {
						id: string;
						unit_id: string;
						status: "pending" | "running" | "passed" | "failed" | "cancelled";
				  }
				| undefined;

			const countRows = database
				.prepare(`SELECT status, COUNT(*) as count FROM runs GROUP BY status`)
				.all() as unknown as {
				status: keyof StatusSnapshot["runCounts"];
				count: number;
			}[];

			const runCounts = {
				pending: 0,
				running: 0,
				passed: 0,
				failed: 0,
				cancelled: 0,
			};

			for (const row of countRows) {
				runCounts[row.status] = row.count;
			}

			const snapshot = latestRun
				? {
						initialized: true,
						runCounts,
						latestRun: {
							id: latestRun.id,
							unitId: latestRun.unit_id,
							status: latestRun.status,
						},
					}
				: {
						initialized: true,
						runCounts,
					};

			database.close();
			return snapshot;
		},

		inspectTarget(id: string): InspectSnapshot {
			ensureInitialized();
			const database = openStoreDatabase();

			const runRow = database
				.prepare(
					`SELECT id, unit_id, status, unit_snapshot FROM runs WHERE id = ?`,
				)
				.get(id) as StoredRunRow | undefined;

			if (runRow) {
				const unit = runRow.unit_snapshot
					? (JSON.parse(runRow.unit_snapshot) as Unit)
					: readUnit(runRow.unit_id, database);
				const result: InspectSnapshot = {
					kind: "run",
					unit,
					run: {
						id: runRow.id,
						unitId: runRow.unit_id,
						status: runRow.status,
					},
					runHistory: [{ id: runRow.id, status: runRow.status }],
					evidence: readEvidence(runRow.id, database),
					decisions: readDecisions(runRow.id, database),
					artifacts: readArtifacts(runRow.id, database),
				};
				database.close();
				return result;
			}

			const unitRow = database
				.prepare(`SELECT id FROM units WHERE id = ?`)
				.get(id) as { id: string } | undefined;

			if (unitRow) {
				const unit = readUnit(unitRow.id, database);
				const runHistory = readRunHistory(unitRow.id, database);
				const latestRun = runHistory[0];

				if (!latestRun) {
					database.close();
					throw new Error(`No run found for unit '${unitRow.id}'`);
				}

				const run = readRun(latestRun.id, database);
				const result: InspectSnapshot = {
					kind: "unit",
					unit,
					run: {
						id: run.id,
						unitId: run.unit_id,
						status: run.status,
					},
					runHistory,
					evidence: readEvidence(run.id, database),
					decisions: readDecisions(run.id, database),
					artifacts: readArtifacts(run.id, database),
				};
				database.close();
				return result;
			}

			database.close();
			throw new Error(`No run or unit found for id '${id}'`);
		},
	};
}
