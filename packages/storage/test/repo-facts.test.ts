import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createBuildplaneStorage } from "../src";

describe("repo fact storage", () => {
	it("stores and retrieves an exact repo-scoped fact", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-repo-facts-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const stored = storage.upsertRepoFact({
			factKey: "commands.test",
			factValue: "pnpm test",
			valueType: "string",
			scopeType: "repo",
			confidence: 0.95,
			createdBy: "system",
		});

		const fetched = storage.getRepoFact("commands.test");
		const facts = storage.listRepoFacts();

		expect(stored.memoryType).toBe("repo-fact");
		expect(fetched?.factValue).toBe("pnpm test");
		expect(facts).toHaveLength(1);
		expect(facts[0]?.factKey).toBe("commands.test");
		expect(facts[0]?.provenance.repoId).toBe(root);
	});

	it("supersedes an active repo fact and preserves replacement retrieval", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-repo-facts-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		storage.upsertRepoFact({
			factKey: "commands.test",
			factValue: "pnpm test",
			valueType: "string",
			scopeType: "repo",
			createdBy: "system",
		});
		const updated = storage.upsertRepoFact({
			factKey: "commands.test",
			factValue: "pnpm test:run",
			valueType: "string",
			scopeType: "repo",
			createdBy: "operator",
		});

		expect(storage.getRepoFact("commands.test")?.factValue).toBe(
			"pnpm test:run",
		);
		expect(storage.listRepoFacts()).toHaveLength(1);

		storage.supersedeRepoFact("commands.test");

		expect(storage.getRepoFact("commands.test")).toBeNull();
		expect(storage.listRepoFacts()).toEqual([]);
		expect(updated.provenance.createdBy).toBe("operator");
	});

	it("round-trips commit validity metadata on repo facts", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-repo-facts-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		storage.upsertRepoFact({
			factKey: "commands.test",
			factValue: "pnpm test",
			valueType: "string",
			scopeType: "repo",
			createdBy: "system",
			validFromCommit: "abc123",
			validToCommit: "def456",
		});

		const fact = storage.getRepoFact("commands.test");

		expect(fact?.validFromCommit).toBe("abc123");
		expect(fact?.validToCommit).toBe("def456");
	});

	it("rejects exact scoped lookup without a scope key for keyed scopes", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-repo-facts-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		expect(() =>
			storage.getRepoFact("commands.test", { scopeType: "branch" }),
		).toThrow(/scope key/i);
	});

	it("rejects scope keys for repo-scoped facts", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-repo-facts-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		expect(() =>
			storage.upsertRepoFact({
				factKey: "commands.test",
				factValue: "pnpm test",
				valueType: "string",
				scopeType: "repo",
				scopeKey: "main",
				createdBy: "system",
			}),
		).toThrow(/scope key/i);
		expect(() =>
			storage.upsertRepoFact({
				factKey: "commands.test",
				factValue: "pnpm test",
				valueType: "string",
				scopeType: "repo",
				scopeKey: "",
				createdBy: "system",
			}),
		).toThrow(/scope key/i);
	});

	it("rejects ambiguous list filters when a scope key is provided without a valid scope", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-repo-facts-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		expect(() => storage.listRepoFacts({ scopeKey: "main" })).toThrow(/scope/i);
		expect(() =>
			storage.listRepoFacts({ scopeType: "repo", scopeKey: "main" }),
		).toThrow(/scope key/i);
		expect(() =>
			storage.listRepoFacts({ scopeType: "repo", scopeKey: "" }),
		).toThrow(/scope key/i);
	});

	it("fails fast with a schema error when opening a legacy repo_facts projection", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-repo-facts-"));
		const buildplaneDir = join(root, ".buildplane");
		const stateDbPath = join(buildplaneDir, "state.db");
		mkdirSync(buildplaneDir, { recursive: true });
		writeFileSync(
			join(buildplaneDir, "project.json"),
			JSON.stringify({
				schemaVersion: 1,
				defaultPolicyProfile: "default",
				initializedAt: "2026-04-12T00:00:00.000Z",
			}),
		);
		const database = new DatabaseSync(stateDbPath);

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
				completed_at TEXT,
				used_workspace INTEGER NOT NULL DEFAULT 0,
				step_count INTEGER NOT NULL DEFAULT 0,
				budget_snapshot TEXT
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
		database
			.prepare(
				`INSERT INTO projects (project_root, initialized_at, default_policy_profile) VALUES (?, ?, ?)`,
			)
			.run(root, "2026-04-12T00:00:00.000Z", "default");
		database.close();

		const storage = createBuildplaneStorage(root);

		expect(() => storage.listRepoFacts()).toThrow(/required projection schema/i);
	});
});
