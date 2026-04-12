import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtractedLearning } from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import { createLearningStore } from "../src/learning-store.js";
import { bootstrapStorageProjectionSchema } from "../src/store.js";

function makeDb(): DatabaseSync {
	const dir = mkdtempSync(join(tmpdir(), "bp-learnings-"));
	const db = new DatabaseSync(join(dir, "state.db"));
	bootstrapStorageProjectionSchema(db);
	return db;
}

const learning: ExtractedLearning = {
	kind: "fact",
	scope: "session",
	title: "Run approved",
	body: "All checks passed",
};

describe("createLearningStore", () => {
	it("writes and fetches a learning", () => {
		const store = createLearningStore(makeDb());
		store.writeLearnings("run-1", [learning]);
		const results = store.fetchLearnings();
		expect(results).toHaveLength(1);
		expect(results[0].kind).toBe("fact");
		expect(results[0].runId).toBe("run-1");
		expect(results[0].status).toBe("active");
	});

	it("filters by scope", () => {
		const store = createLearningStore(makeDb());
		store.writeLearnings("run-1", [
			{ ...learning, scope: "session" },
			{ ...learning, scope: "workspace" },
		]);
		const session = store.fetchLearnings({ scope: "session" });
		expect(session).toHaveLength(1);
		expect(session[0].scope).toBe("session");
	});

	it("filters by kind", () => {
		const store = createLearningStore(makeDb());
		store.writeLearnings("run-1", [
			{ ...learning, kind: "fact" },
			{ ...learning, kind: "constraint" },
		]);
		const constraints = store.fetchLearnings({ kind: "constraint" });
		expect(constraints).toHaveLength(1);
		expect(constraints[0].kind).toBe("constraint");
	});

	it("respects the limit option", () => {
		const store = createLearningStore(makeDb());
		const many = Array.from({ length: 5 }, (_, i) => ({
			...learning,
			title: `learning ${i}`,
		}));
		store.writeLearnings("run-1", many);
		expect(store.fetchLearnings({ limit: 3 })).toHaveLength(3);
	});

	it("only returns active learnings", () => {
		const db = makeDb();
		const store = createLearningStore(db);
		store.writeLearnings("run-1", [learning]);
		db.prepare(
			`UPDATE run_learnings SET status = 'archived' WHERE run_id = 'run-1'`,
		).run();
		expect(store.fetchLearnings()).toHaveLength(0);
	});

	it("returns empty array when no learnings exist", () => {
		expect(createLearningStore(makeDb()).fetchLearnings()).toEqual([]);
	});

	it("dedup: increments seen_count instead of inserting duplicate", () => {
		const store = createLearningStore(makeDb());
		store.writeLearnings("run-1", [learning]);
		store.writeLearnings("run-2", [learning]); // same scope+kind+title
		const results = store.fetchLearnings();
		expect(results).toHaveLength(1);
		expect(results[0].seenCount).toBe(2);
	});

	it("dedup: preserves original ID on update", () => {
		const store = createLearningStore(makeDb());
		store.writeLearnings("run-1", [learning]);
		const first = store.fetchLearnings();
		const originalId = first[0].id;
		store.writeLearnings("run-2", [learning]);
		const second = store.fetchLearnings();
		expect(second[0].id).toBe(originalId);
	});

	it("dedup: updates body with latest content", () => {
		const store = createLearningStore(makeDb());
		store.writeLearnings("run-1", [learning]);
		store.writeLearnings("run-2", [{ ...learning, body: "updated body" }]);
		const results = store.fetchLearnings();
		expect(results[0].body).toBe("updated body");
	});

	it("promotes session→workspace at seen_count >= 3", () => {
		const store = createLearningStore(makeDb());
		const sessionLearning: ExtractedLearning = {
			kind: "constraint",
			scope: "session",
			title: "Run rejected",
			body: "Rejected: exit code 1",
		};
		store.writeLearnings("run-1", [sessionLearning]);
		store.writeLearnings("run-2", [sessionLearning]);
		store.writeLearnings("run-3", [sessionLearning]); // seen_count = 3
		store.promoteLearnings("run-3");
		const workspaceLearnings = store.fetchLearnings({ scope: "workspace" });
		expect(workspaceLearnings).toHaveLength(1);
		expect(workspaceLearnings[0].title).toBe("Run rejected");
		expect(workspaceLearnings[0].scope).toBe("workspace");
	});

	it("promotes workspace→user at seen_count >= 5", () => {
		const store = createLearningStore(makeDb());
		const wsLearning: ExtractedLearning = {
			kind: "fact",
			scope: "workspace",
			title: "Verification gate passed",
			body: "All outputs verified",
		};
		for (let i = 0; i < 5; i++) {
			store.writeLearnings(`run-${i}`, [wsLearning]);
		}
		store.promoteLearnings("run-4");
		const userLearnings = store.fetchLearnings({ scope: "user" });
		expect(userLearnings).toHaveLength(1);
		expect(userLearnings[0].scope).toBe("user");
	});

	it("promotion is idempotent", () => {
		const store = createLearningStore(makeDb());
		const sessionLearning: ExtractedLearning = {
			kind: "constraint",
			scope: "session",
			title: "Run rejected",
			body: "Rejected: exit code 1",
		};
		for (let i = 0; i < 3; i++) {
			store.writeLearnings(`run-${i}`, [sessionLearning]);
		}
		store.promoteLearnings("run-2");
		store.promoteLearnings("run-2"); // second call = no-op
		const workspaceLearnings = store.fetchLearnings({ scope: "workspace" });
		expect(workspaceLearnings).toHaveLength(1);
	});

	it("fetchLearningById returns a single learning by ID", () => {
		const store = createLearningStore(makeDb());
		store.writeLearnings("run-1", [learning]);
		const all = store.fetchLearnings();
		const id = all[0].id;
		const result = store.fetchLearningById(id);
		expect(result).toBeDefined();
		expect(result!.id).toBe(id);
		expect(result!.title).toBe("Run approved");
	});

	it("fetchLearningById returns undefined for missing ID", () => {
		const store = createLearningStore(makeDb());
		expect(store.fetchLearningById("nonexistent")).toBeUndefined();
	});

	it("fetchLearningsByRunId returns learnings for that run only", () => {
		const store = createLearningStore(makeDb());
		store.writeLearnings("run-1", [learning]);
		store.writeLearnings("run-2", [{ ...learning, title: "Second learning" }]);
		const run1Learnings = store.fetchLearningsByRunId("run-1");
		expect(run1Learnings).toHaveLength(1);
		expect(run1Learnings[0].title).toBe("Run approved");
	});

	it("fetchLearningsByRunId returns empty array for unknown run", () => {
		const store = createLearningStore(makeDb());
		expect(store.fetchLearningsByRunId("nonexistent")).toEqual([]);
	});

	it("scope-ordered fetch returns user > workspace > session", () => {
		const db = makeDb();
		const store = createLearningStore(db);
		const now = new Date().toISOString();
		// Insert one learning per scope directly via SQL
		const insert = db.prepare(
			`INSERT INTO run_learnings (id, run_id, scope, kind, title, body, status, seen_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
		);
		insert.run(
			"id-session",
			"run-1",
			"session",
			"fact",
			"S",
			"session body",
			1,
			now,
			now,
		);
		insert.run(
			"id-workspace",
			"run-1",
			"workspace",
			"fact",
			"W",
			"workspace body",
			1,
			now,
			now,
		);
		insert.run(
			"id-user",
			"run-1",
			"user",
			"fact",
			"U",
			"user body",
			1,
			now,
			now,
		);

		const results = store.fetchLearnings();
		expect(results[0].scope).toBe("user");
		expect(results[1].scope).toBe("workspace");
		expect(results[2].scope).toBe("session");
	});
});
