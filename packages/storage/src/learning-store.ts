import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
	BuildplaneMemoryPort,
	ExtractedLearning,
	LearningKind,
	LearningScope,
	StoredLearning,
} from "@buildplane/kernel";

interface LearningRow {
	readonly id: string;
	readonly run_id: string;
	readonly scope: string;
	readonly kind: string;
	readonly title: string;
	readonly body: string;
	readonly status: string;
	readonly created_at: string;
}

export function createLearningStore(
	database: DatabaseSync,
): BuildplaneMemoryPort {
	return {
		writeLearnings(
			runId: string,
			learnings: readonly ExtractedLearning[],
		): void {
			const now = new Date().toISOString();
			const insert = database.prepare(
				`INSERT INTO run_learnings (id, run_id, scope, kind, title, body, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
			);
			for (const l of learnings) {
				insert.run(
					randomUUID(),
					runId,
					l.scope,
					l.kind,
					l.title,
					l.body,
					now,
					now,
				);
			}
		},

		fetchLearnings(options?: {
			scope?: LearningScope;
			kind?: LearningKind;
			limit?: number;
		}): readonly StoredLearning[] {
			const { scope, kind, limit = 20 } = options ?? {};
			const conditions: string[] = ["status = 'active'"];
			const params: SQLInputValue[] = [];

			if (scope) {
				conditions.push("scope = ?");
				params.push(scope);
			}
			if (kind) {
				conditions.push("kind = ?");
				params.push(kind);
			}
			params.push(limit);

			const rows = database
				.prepare(
					`SELECT id, run_id, scope, kind, title, body, status, created_at
           FROM run_learnings
           WHERE ${conditions.join(" AND ")}
           ORDER BY created_at DESC
           LIMIT ?`,
				)
				.all(...params) as unknown as LearningRow[];

			return rows.map((row) => ({
				id: row.id,
				runId: row.run_id,
				scope: row.scope as LearningScope,
				kind: row.kind as LearningKind,
				title: row.title,
				body: row.body,
				status: row.status as "active" | "superseded" | "archived",
				createdAt: row.created_at,
			}));
		},
	};
}
