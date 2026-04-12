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
	readonly seen_count: number;
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
			const findExisting = database.prepare(
				`SELECT id FROM run_learnings WHERE scope = ? AND kind = ? AND title = ? AND status = 'active' LIMIT 1`,
			);
			const updateExisting = database.prepare(
				`UPDATE run_learnings SET body = ?, updated_at = ?, seen_count = seen_count + 1 WHERE id = ?`,
			);
			const insert = database.prepare(
				`INSERT INTO run_learnings (id, run_id, scope, kind, title, body, status, seen_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
			);
			for (const l of learnings) {
				const existing = findExisting.all(
					l.scope,
					l.kind,
					l.title,
				) as unknown as { id: string }[];
				if (existing.length > 0) {
					updateExisting.run(l.body, now, existing[0].id);
				} else {
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
					`SELECT id, run_id, scope, kind, title, body, status, created_at, seen_count
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
				seenCount: row.seen_count,
			}));
		},

		promoteLearnings(runId: string): void {
			const now = new Date().toISOString();
			const checkPromoted = database.prepare(
				`SELECT 1 FROM run_learnings WHERE promoted_from_id = ? AND status = 'active' LIMIT 1`,
			);
			const insertPromoted = database.prepare(
				`INSERT INTO run_learnings (id, run_id, scope, kind, title, body, status, promoted_from_id, source_run_id, seen_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, 1, ?, ?)`,
			);

			// Session → Workspace (threshold: 3)
			const sessionCandidates = database
				.prepare(
					`SELECT id, kind, title, body FROM run_learnings
           WHERE scope = 'session' AND status = 'active' AND seen_count >= 3`,
				)
				.all() as unknown as {
				id: string;
				kind: string;
				title: string;
				body: string;
			}[];

			for (const c of sessionCandidates) {
				const existing = checkPromoted.all(c.id) as unknown as unknown[];
				if (existing.length === 0) {
					insertPromoted.run(
						randomUUID(),
						runId,
						"workspace",
						c.kind,
						c.title,
						c.body,
						c.id,
						runId,
						now,
						now,
					);
				}
			}

			// Workspace → User (threshold: 5)
			const workspaceCandidates = database
				.prepare(
					`SELECT id, kind, title, body FROM run_learnings
           WHERE scope = 'workspace' AND status = 'active' AND seen_count >= 5`,
				)
				.all() as unknown as {
				id: string;
				kind: string;
				title: string;
				body: string;
			}[];

			for (const c of workspaceCandidates) {
				const existing = checkPromoted.all(c.id) as unknown as unknown[];
				if (existing.length === 0) {
					insertPromoted.run(
						randomUUID(),
						runId,
						"user",
						c.kind,
						c.title,
						c.body,
						c.id,
						runId,
						now,
						now,
					);
				}
			}
		},
	};
}
