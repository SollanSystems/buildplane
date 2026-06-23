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

function insertEventRow(
	root: string,
	kind: string,
	runId: string,
	payloadExtra: Record<string, unknown> = {},
): void {
	const layout = resolveProjectLayout(root);
	const database = new DatabaseSync(layout.stateDbPath);
	try {
		database
			.prepare(
				`INSERT INTO events (id, kind, occurred_at, payload) VALUES (?, ?, ?, ?)`,
			)
			.run(
				`evt-${kind}-${runId}-${Math.random().toString(36).slice(2)}`,
				kind,
				new Date().toISOString(),
				JSON.stringify({ runId, ...payloadExtra }),
			);
	} finally {
		database.close();
	}
}

describe("listDecidedUnexecutedDecisions / markers", () => {
	let root: string;
	let storage: ReturnType<typeof createBuildplaneStorage>;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "bp-ldud-"));
		storage = createBuildplaneStorage(root);
		storage.initializeProject();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns a decided-but-unexecuted run", () => {
		const a = storage.createRun(packet("plan-a:PF1"));
		insertEventRow(root, "operator_decision_recorded", a.id, {
			decision: "approved",
			subject: "merge",
		});

		const feed = storage.listDecidedUnexecutedDecisions();
		expect(feed).toEqual([
			{ runId: a.id, decision: "approved", subject: "merge" },
		]);
	});

	it("F5: deduplicates duplicate shadows to at most one row per run", () => {
		const a = storage.createRun(packet("plan-a:PF1"));
		// Two operator_decision_recorded shadows for the same run (the residual
		// crash-window operator re-decide). The reconciler feed must not double-feed.
		insertEventRow(root, "operator_decision_recorded", a.id, {
			decision: "approved",
			subject: "merge",
		});
		insertEventRow(root, "operator_decision_recorded", a.id, {
			decision: "approved",
			subject: "merge",
		});

		const feed = storage.listDecidedUnexecutedDecisions();
		expect(feed).toHaveLength(1);
		expect(feed[0]).toMatchObject({ runId: a.id, subject: "merge" });
	});

	it("excludes a run once an operator_decision_executed marker exists", () => {
		const a = storage.createRun(packet("plan-a:PF1"));
		insertEventRow(root, "operator_decision_recorded", a.id, {
			decision: "approved",
			subject: "merge",
		});
		insertEventRow(root, "operator_decision_executed", a.id);

		expect(storage.listDecidedUnexecutedDecisions()).toEqual([]);
	});

	it("isOperatorDecisionExecuted reflects the marker presence", () => {
		const a = storage.createRun(packet("plan-a:PF1"));
		expect(storage.isOperatorDecisionExecuted(a.id)).toBe(false);
		storage.markOperatorDecisionExecuted(a.id, {
			mergedHeadSha: "f".repeat(40),
		});
		expect(storage.isOperatorDecisionExecuted(a.id)).toBe(true);
	});

	it("getRunAcceptanceOutcome reads the recorded acceptance shadow", () => {
		const a = storage.createRun(packet("plan-a:PF1"));
		expect(storage.getRunAcceptanceOutcome(a.id)).toBeNull();
		storage.recordAcceptanceShadow(a.id, "passed");
		expect(storage.getRunAcceptanceOutcome(a.id)).toBe("passed");
	});
});
