import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export function openBuildplaneDatabase(path: string): DatabaseSync {
	const database = new DatabaseSync(path);

	database.exec(`
		CREATE TABLE IF NOT EXISTS projects (
			project_root TEXT PRIMARY KEY,
			initialized_at TEXT NOT NULL,
			default_policy_profile TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS events (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			occurred_at TEXT NOT NULL,
			payload TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_events_run_id_occurred_at
			ON events (json_extract(payload, '$.runId'), occurred_at);
	`);

	return database;
}

export function assertBuildplaneDatabaseIsInitialized(
	path: string,
	projectRoot: string,
): void {
	const database = new DatabaseSync(path, { open: true });

	try {
		const projectTable = database
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'`,
			)
			.get() as { name: string } | undefined;
		const eventsTable = database
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'`,
			)
			.get() as { name: string } | undefined;

		if (!projectTable || !eventsTable) {
			throw new Error(
				"Buildplane state is incomplete: state.db is missing required schema. Remove .buildplane or repair the database before rerunning `buildplane init`.",
			);
		}

		const projectRow = database
			.prepare(
				`SELECT project_root FROM projects WHERE project_root = ? LIMIT 1`,
			)
			.get(projectRoot) as { project_root: string } | undefined;

		if (!projectRow) {
			throw new Error(
				"Buildplane state is incomplete: state.db is missing the initialized project record. Remove .buildplane or repair the database before rerunning `buildplane init`.",
			);
		}
	} finally {
		database.close();
	}
}

export function insertProjectInitializedEvent(
	database: DatabaseSync,
	payload: Record<string, unknown>,
): void {
	database
		.prepare(
			`INSERT INTO events (id, kind, occurred_at, payload) VALUES (?, ?, ?, ?)`,
		)
		.run(
			randomUUID(),
			"project-initialized",
			new Date().toISOString(),
			JSON.stringify(payload),
		);
}
