import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createBuildplaneStorage } from "../src";

describe("project initialization", () => {
	it("creates the .buildplane layout and project metadata idempotently", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-init-"));
		const storage = createBuildplaneStorage(root);

		const first = storage.initializeProject();
		const second = storage.initializeProject();
		const projectJson = JSON.parse(
			readFileSync(join(root, ".buildplane", "project.json"), "utf8"),
		);

		expect(first.created).toBe(true);
		expect(first.projectRoot).toBe(root);
		expect(first.stateDbPath).toBe(join(root, ".buildplane", "state.db"));
		expect(second.created).toBe(false);
		expect(second.projectRoot).toBe(root);
		expect(second.stateDbPath).toBe(join(root, ".buildplane", "state.db"));
		expect(projectJson).toMatchObject({
			schemaVersion: 1,
			defaultPolicyProfile: "default",
		});
		expect(projectJson.initializedAt).toEqual(expect.any(String));
		expect(existsSync(join(root, ".buildplane", "workspaces"))).toBe(true);
	});

	it("migrates older initialized projects to add workspace and evidence-message support", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-legacy-init-"));
		const buildplaneDir = join(root, ".buildplane");
		mkdirSync(buildplaneDir, { recursive: true });
		mkdirSync(join(buildplaneDir, "artifacts"), { recursive: true });
		mkdirSync(join(buildplaneDir, "evidence"), { recursive: true });
		mkdirSync(join(buildplaneDir, "runs"), { recursive: true });
		mkdirSync(join(buildplaneDir, "logs"), { recursive: true });
		writeFileSync(
			join(buildplaneDir, "project.json"),
			JSON.stringify({
				schemaVersion: 1,
				defaultPolicyProfile: "default",
				initializedAt: "2026-03-17T00:00:00.000Z",
			}),
		);

		const database = new DatabaseSync(join(buildplaneDir, "state.db"));
		database.exec(`
			CREATE TABLE projects (
				project_root TEXT PRIMARY KEY,
				initialized_at TEXT NOT NULL,
				default_policy_profile TEXT NOT NULL
			);

			CREATE TABLE events (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				occurred_at TEXT NOT NULL,
				payload TEXT NOT NULL
			);

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
				completed_at TEXT
			);

			CREATE TABLE evidence (
				id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				status TEXT NOT NULL
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
		`);
		database
			.prepare(
				`INSERT INTO projects (project_root, initialized_at, default_policy_profile) VALUES (?, ?, ?)`,
			)
			.run(root, "2026-03-17T00:00:00.000Z", "default");
		database
			.prepare(
				`INSERT INTO events (id, kind, occurred_at, payload) VALUES (?, ?, ?, ?)`,
			)
			.run(
				"event-1",
				"project-initialized",
				"2026-03-17T00:00:00.000Z",
				JSON.stringify({ projectRoot: root }),
			);
		database.close();

		const storage = createBuildplaneStorage(root);
		const result = storage.initializeProject();

		expect(result.created).toBe(false);
		expect(existsSync(join(buildplaneDir, "workspaces"))).toBe(true);

		const migratedDatabase = new DatabaseSync(join(buildplaneDir, "state.db"));
		const evidenceColumns = migratedDatabase
			.prepare(`PRAGMA table_info(evidence)`)
			.all() as { name: string }[];
		const runColumns = migratedDatabase
			.prepare(`PRAGMA table_info(runs)`)
			.all() as { name: string }[];
		const workspaceTable = migratedDatabase
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'`,
			)
			.get() as { name: string } | undefined;
		migratedDatabase.close();

		expect(evidenceColumns.map((column) => column.name)).toContain("message");
		expect(runColumns.map((column) => column.name)).toContain("used_workspace");
		expect(workspaceTable?.name).toBe("workspaces");
	});

	it("fails without mutating invalid state databases", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-invalid-init-"));
		const buildplaneDir = join(root, ".buildplane");
		mkdirSync(buildplaneDir, { recursive: true });
		writeFileSync(
			join(buildplaneDir, "project.json"),
			JSON.stringify({
				schemaVersion: 1,
				defaultPolicyProfile: "default",
				initializedAt: "2026-03-17T00:00:00.000Z",
			}),
		);

		const database = new DatabaseSync(join(buildplaneDir, "state.db"));
		database.exec(`
			CREATE TABLE projects (
				project_root TEXT PRIMARY KEY,
				initialized_at TEXT NOT NULL,
				default_policy_profile TEXT NOT NULL
			);
		`);
		database.close();

		const storage = createBuildplaneStorage(root);

		expect(() => storage.initializeProject()).toThrow(
			/initialized project record|required schema|repair/i,
		);

		const unchangedDatabase = new DatabaseSync(join(buildplaneDir, "state.db"));
		const unitsTable = unchangedDatabase
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'units'`,
			)
			.get() as { name: string } | undefined;
		const workspacesTable = unchangedDatabase
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'`,
			)
			.get() as { name: string } | undefined;
		unchangedDatabase.close();

		expect(unitsTable).toBeUndefined();
		expect(workspacesTable).toBeUndefined();
	});

	it("fails fast when baseline projection tables are missing from an existing project", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-missing-projections-"));
		const buildplaneDir = join(root, ".buildplane");
		mkdirSync(buildplaneDir, { recursive: true });
		writeFileSync(
			join(buildplaneDir, "project.json"),
			JSON.stringify({
				schemaVersion: 1,
				defaultPolicyProfile: "default",
				initializedAt: "2026-03-17T00:00:00.000Z",
			}),
		);

		const database = new DatabaseSync(join(buildplaneDir, "state.db"));
		database.exec(`
			CREATE TABLE projects (
				project_root TEXT PRIMARY KEY,
				initialized_at TEXT NOT NULL,
				default_policy_profile TEXT NOT NULL
			);

			CREATE TABLE events (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				occurred_at TEXT NOT NULL,
				payload TEXT NOT NULL
			);
		`);
		database
			.prepare(
				`INSERT INTO projects (project_root, initialized_at, default_policy_profile) VALUES (?, ?, ?)`,
			)
			.run(root, "2026-03-17T00:00:00.000Z", "default");
		database
			.prepare(
				`INSERT INTO events (id, kind, occurred_at, payload) VALUES (?, ?, ?, ?)`,
			)
			.run(
				"event-1",
				"project-initialized",
				"2026-03-17T00:00:00.000Z",
				JSON.stringify({ projectRoot: root }),
			);
		database.close();

		const storage = createBuildplaneStorage(root);

		expect(() => storage.initializeProject()).toThrow(
			/required projection schema|repair/i,
		);

		const unchangedDatabase = new DatabaseSync(join(buildplaneDir, "state.db"));
		const unitsTable = unchangedDatabase
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'units'`,
			)
			.get() as { name: string } | undefined;
		unchangedDatabase.close();

		expect(unitsTable).toBeUndefined();
	});

	it("fails fast when an existing workspaces table is missing required columns", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-partial-workspaces-"));
		const buildplaneDir = join(root, ".buildplane");
		mkdirSync(buildplaneDir, { recursive: true });
		mkdirSync(join(buildplaneDir, "artifacts"), { recursive: true });
		mkdirSync(join(buildplaneDir, "evidence"), { recursive: true });
		mkdirSync(join(buildplaneDir, "runs"), { recursive: true });
		mkdirSync(join(buildplaneDir, "logs"), { recursive: true });
		writeFileSync(
			join(buildplaneDir, "project.json"),
			JSON.stringify({
				schemaVersion: 1,
				defaultPolicyProfile: "default",
				initializedAt: "2026-03-17T00:00:00.000Z",
			}),
		);

		const database = new DatabaseSync(join(buildplaneDir, "state.db"));
		database.exec(`
			CREATE TABLE projects (
				project_root TEXT PRIMARY KEY,
				initialized_at TEXT NOT NULL,
				default_policy_profile TEXT NOT NULL
			);

			CREATE TABLE events (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				occurred_at TEXT NOT NULL,
				payload TEXT NOT NULL
			);

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
				completed_at TEXT
			);

			CREATE TABLE evidence (
				id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				status TEXT NOT NULL
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
				path TEXT NOT NULL
			);
		`);
		database
			.prepare(
				`INSERT INTO projects (project_root, initialized_at, default_policy_profile) VALUES (?, ?, ?)`,
			)
			.run(root, "2026-03-17T00:00:00.000Z", "default");
		database
			.prepare(
				`INSERT INTO events (id, kind, occurred_at, payload) VALUES (?, ?, ?, ?)`,
			)
			.run(
				"event-1",
				"project-initialized",
				"2026-03-17T00:00:00.000Z",
				JSON.stringify({ projectRoot: root }),
			);
		database.close();

		const storage = createBuildplaneStorage(root);

		expect(() => storage.initializeProject()).toThrow(
			/workspaces|required projection schema|repair/i,
		);
	});

	it("fails with guidance when project.json exists but state.db is missing", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-bad-init-"));
		const buildplaneDir = join(root, ".buildplane");
		mkdirSync(buildplaneDir, { recursive: true });
		writeFileSync(
			join(buildplaneDir, "project.json"),
			JSON.stringify({
				schemaVersion: 1,
				defaultPolicyProfile: "default",
				initializedAt: new Date().toISOString(),
			}),
		);

		const storage = createBuildplaneStorage(root);

		expect(() => storage.initializeProject()).toThrow(
			/state\.db is missing|incomplete/i,
		);
	});
});
