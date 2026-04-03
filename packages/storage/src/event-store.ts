import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { ExecutionEvent, ExecutionEventKind } from "@buildplane/kernel";
import {
	assertBuildplaneDatabaseIsInitialized,
	openBuildplaneDatabase,
} from "./database.js";
import { resolveProjectLayout } from "./project-layout.js";

export interface EventStore {
	/** Persist a single typed execution event. */
	persistEvent(runId: string, event: ExecutionEvent): void;

	/** Retrieve all typed events for a run, ordered by occurrence. */
	getEventsByRunId(runId: string): ExecutionEvent[];

	/** Retrieve typed events for a run filtered by kind. */
	getEventsByRunIdAndKind(
		runId: string,
		kind: ExecutionEventKind,
	): ExecutionEvent[];

	/** Retrieve all typed events for a strategy (across all child runs). */
	getEventsByStrategyId(strategyId: string): ExecutionEvent[];
}

interface StoredEventRow {
	readonly id: string;
	readonly kind: string;
	readonly occurred_at: string;
	readonly payload: string;
}

export function createEventStore(projectRoot: string): EventStore {
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

	function openDb(): DatabaseSync {
		const db = openBuildplaneDatabase(layout.stateDbPath);
		// Ensure expression index exists for strategy-scoped event queries.
		const idxSql =
			"CREATE INDEX IF NOT EXISTS idx_events_strategy_id ON events " +
			"(json_extract(payload, '$.context.strategyId'))";
		db.exec(idxSql);
		return db;
	}

	function deserializeEvent(row: StoredEventRow): ExecutionEvent {
		const payload = JSON.parse(row.payload);
		return {
			kind: row.kind,
			timestamp: row.occurred_at,
			...payload,
		} as ExecutionEvent;
	}

	return {
		persistEvent(runId: string, event: ExecutionEvent): void {
			ensureInitialized();
			const database = openDb();
			// removed

			database
				.prepare(
					`INSERT INTO events (id, kind, occurred_at, payload) VALUES (?, ?, ?, ?)`,
				)
				.run(
					randomUUID(),
					String(event.kind),
					String(event.timestamp),
					JSON.stringify({ ...event, runId }),
				);

			database.close();
		},

		getEventsByRunId(runId: string): ExecutionEvent[] {
			ensureInitialized();
			const database = openDb();

			const rows = database
				.prepare(
					`SELECT id, kind, occurred_at, payload FROM events WHERE json_extract(payload, '$.runId') = ? ORDER BY occurred_at ASC, rowid ASC`,
				)
				.all(runId) as unknown as StoredEventRow[];

			database.close();
			return rows.map(deserializeEvent);
		},

		getEventsByRunIdAndKind(
			runId: string,
			kind: ExecutionEventKind,
		): ExecutionEvent[] {
			ensureInitialized();
			const database = openDb();

			const rows = database
				.prepare(
					`SELECT id, kind, occurred_at, payload FROM events WHERE json_extract(payload, '$.runId') = ? AND kind = ? ORDER BY occurred_at ASC, rowid ASC`,
				)
				.all(runId, kind) as unknown as StoredEventRow[];

			database.close();
			return rows.map(deserializeEvent);
		},

		getEventsByStrategyId(strategyId: string): ExecutionEvent[] {
			ensureInitialized();
			const database = openDb();

			const rows = database
				.prepare(
					`SELECT id, kind, occurred_at, payload FROM events WHERE json_extract(payload, '$.context.strategyId') = ? ORDER BY occurred_at ASC, rowid ASC`,
				)
				.all(strategyId) as unknown as StoredEventRow[];

			database.close();
			return rows.map(deserializeEvent);
		},
	};
}
