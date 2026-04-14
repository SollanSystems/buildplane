import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertBaselineStorageProjectionSchema,
	bootstrapStorageProjectionSchema,
} from "../src/store";

const databases: DatabaseSync[] = [];

function openTempDatabase(): DatabaseSync {
	const database = new DatabaseSync(":memory:");
	databases.push(database);
	return database;
}

afterEach(() => {
	for (const database of databases.splice(0)) {
		database.close();
	}
});

describe("memory storage schema", () => {
	it("bootstraps repo memory tables", () => {
		const database = openTempDatabase();

		bootstrapStorageProjectionSchema(database);

		const tables = database
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('repo_facts', 'procedures', 'searchable_documents') ORDER BY name ASC`,
			)
			.all() as { name: string }[];

		expect(tables.map((row) => row.name)).toEqual([
			"procedures",
			"repo_facts",
			"searchable_documents",
		]);
	});

	it("adds expected repo_facts columns", () => {
		const database = openTempDatabase();

		bootstrapStorageProjectionSchema(database);

		const columns = database.prepare(`PRAGMA table_info(repo_facts)`).all() as {
			name: string;
		}[];

		expect(columns.map((column) => column.name)).toEqual(
			expect.arrayContaining([
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
				"status",
				"valid_from_commit",
				"valid_to_commit",
				"created_at",
				"updated_at",
			]),
		);
	});

	it("treats repo memory tables as part of the baseline projection schema", () => {
		const database = openTempDatabase();

		bootstrapStorageProjectionSchema(database);

		expect(() => assertBaselineStorageProjectionSchema(database)).not.toThrow();
	});

	it("upgrades a legacy repo_facts table before asserting the final schema", () => {
		const database = openTempDatabase();

		database.exec(`
			CREATE TABLE units (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				scope TEXT NOT NULL,
				input_refs TEXT NOT NULL,
				expected_outputs TEXT NOT NULL,
				verification_contract TEXT NOT NULL,
				policy_profile TEXT NOT NULL
			);
			CREATE TABLE runs (
				id TEXT PRIMARY KEY,
				unit_id TEXT NOT NULL,
				status TEXT NOT NULL,
				unit_snapshot TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				completed_at TEXT,
				used_workspace INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE evidence (
				id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				status TEXT NOT NULL,
				message TEXT
			);
			CREATE TABLE decisions (
				id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				outcome TEXT NOT NULL,
				reasons TEXT NOT NULL
			);
			CREATE TABLE artifacts (
				id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL,
				type TEXT NOT NULL,
				location TEXT NOT NULL
			);
			CREATE TABLE workspaces (
				run_id TEXT PRIMARY KEY,
				source_project_root TEXT NOT NULL,
				path TEXT NOT NULL,
				head_sha TEXT NOT NULL,
				status TEXT NOT NULL,
				created_at TEXT NOT NULL,
				finalized_at TEXT,
				cleanup_error TEXT
			);
			CREATE TABLE repo_facts (
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
				status TEXT NOT NULL DEFAULT 'active',
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`);

		expect(() => bootstrapStorageProjectionSchema(database)).not.toThrow();

		const columns = database.prepare(`PRAGMA table_info(repo_facts)`).all() as {
			name: string;
		}[];

		expect(columns.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"created_by",
				"branch",
				"commit_sha",
				"valid_from_commit",
				"valid_to_commit",
			]),
		);
	});
});
