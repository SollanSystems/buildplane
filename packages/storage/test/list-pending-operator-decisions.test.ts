import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBuildplaneStorage } from "../src";
import { resolveProjectLayout } from "../src/project-layout";

function packet(unitId: string) {
	return {
		unit: {
			id: unitId,
			kind: "planforge-task",
			scope: ".",
			inputRefs: [],
			expectedOutputs: [],
			verificationContract: "true",
			policyProfile: "default",
		},
		execution: { command: "true" },
		verification: { requiredOutputs: [] },
	} as never;
}

function insertEventRow(root: string, kind: string, runId: string): void {
	const layout = resolveProjectLayout(root);
	const database = new DatabaseSync(layout.stateDbPath);
	try {
		database
			.prepare(
				`INSERT INTO events (id, kind, occurred_at, payload) VALUES (?, ?, ?, ?)`,
			)
			.run(
				`evt-${kind}-${runId}`,
				kind,
				new Date().toISOString(),
				JSON.stringify({ runId }),
			);
	} finally {
		database.close();
	}
}

describe("listPendingOperatorDecisions", () => {
	let root: string;
	let storage: ReturnType<typeof createBuildplaneStorage>;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "bp-lpod-"));
		storage = createBuildplaneStorage(root);
		storage.initializeProject();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("includes suspended runs with subject 'resume'", () => {
		const a = storage.createRun(packet("plan-a:PF1"));
		storage.markRunRunning(a.id);
		storage.suspendRun(a.id);

		const feed = storage.listPendingOperatorDecisions();
		expect(feed).toHaveLength(1);
		expect(feed[0]).toMatchObject({ runId: a.id, subject: "resume" });
		expect(typeof feed[0]?.since).toBe("string");
	});

	it("includes passed-acceptance-shadow runs with no decision as subject 'merge'", () => {
		const a = storage.createRun(packet("plan-a:PF1"));
		storage.markRunRunning(a.id);
		storage.completeRun(a.id, "passed");
		storage.recordAcceptanceShadow(a.id, "passed");

		const feed = storage.listPendingOperatorDecisions();
		expect(feed).toHaveLength(1);
		expect(feed[0]).toMatchObject({ runId: a.id, subject: "merge" });
	});

	it("excludes a passed-acceptance run once an operator_decision_recorded event exists", () => {
		const a = storage.createRun(packet("plan-a:PF1"));
		storage.markRunRunning(a.id);
		storage.completeRun(a.id, "passed");
		storage.recordAcceptanceShadow(a.id, "passed");
		insertEventRow(root, "operator_decision_recorded", a.id);

		expect(storage.listPendingOperatorDecisions()).toEqual([]);
	});

	it("excludes a suspended run once an operator_decision_recorded event exists (F6)", () => {
		const a = storage.createRun(packet("plan-a:PF1"));
		storage.markRunRunning(a.id);
		storage.suspendRun(a.id);
		insertEventRow(root, "operator_decision_recorded", a.id);

		// A crash after the Tier-2 flush + Tier-1 shadow but before the resume
		// side effect leaves the run suspended; without this exclusion the operator
		// would re-decide and produce a duplicate signed decision.
		expect(storage.listPendingOperatorDecisions()).toEqual([]);
	});

	it("excludes runs whose acceptance shadow did not pass", () => {
		const a = storage.createRun(packet("plan-a:PF1"));
		storage.markRunRunning(a.id);
		storage.completeRun(a.id, "failed");
		storage.recordAcceptanceShadow(a.id, "rejected");

		expect(storage.listPendingOperatorDecisions()).toEqual([]);
	});

	it("returns suspended and accepted-undecided runs together", () => {
		const suspended = storage.createRun(packet("plan-s:PF1"));
		storage.markRunRunning(suspended.id);
		storage.suspendRun(suspended.id);

		const accepted = storage.createRun(packet("plan-a:PF1"));
		storage.markRunRunning(accepted.id);
		storage.completeRun(accepted.id, "passed");
		storage.recordAcceptanceShadow(accepted.id, "passed");

		const decided = storage.createRun(packet("plan-d:PF1"));
		storage.markRunRunning(decided.id);
		storage.completeRun(decided.id, "passed");
		storage.recordAcceptanceShadow(decided.id, "passed");
		insertEventRow(root, "operator_decision_recorded", decided.id);

		const feed = storage.listPendingOperatorDecisions();
		const bySubject = new Map(feed.map((e) => [e.runId, e.subject]));
		expect(bySubject.get(suspended.id)).toBe("resume");
		expect(bySubject.get(accepted.id)).toBe("merge");
		expect(bySubject.has(decided.id)).toBe(false);
	});
});
