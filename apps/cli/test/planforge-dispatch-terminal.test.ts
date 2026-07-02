import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanForgePlan } from "../src/planforge-schema.js";
import {
	emitPlanForgeTerminalReceipt,
	planForgeReceiptExists,
	summarizeDispatchOutcome,
} from "../src/run-cli.js";

// R1 loop terminal fidelity — unit coverage for the two dispatch-classification
// invariants the supervisor depends on:
//
//   FIX 1  summarizeDispatchOutcome must attribute `producedSideEffects` to the
//          FAILING task's own evidence, never an OR across the dispatch — so a
//          pass-then-infra-fail chain (PF1 merges, PF2 dies with a 429) is a
//          `dispatch-error`, not a mislabelled `acceptance-fail`. This drives the
//          REAL fold the dispatch command runs, not a fabricated loopDispatch.
//   FIX 2  the terminal plan_receipt is gated on planForgeReceiptExists (via
//          emitPlanForgeTerminalReceipt) so re-firing the same plan/idempotencyKey
//          (same deterministic runId) never appends a second signed plan_receipt.

interface SpyEmitter {
	readonly emitter: unknown;
	readonly emits: Array<{ kind: string; payload: unknown }>;
	readonly state: { flushes: number };
}

/** Minimal TapeEmitter stand-in: emitPlanForgeTerminalReceipt only ever calls
 * `emit` + `flush` (via createLedgerReceiptPort), and only on the non-deduped
 * emit path — so a recorded/never-touched spy proves whether it emitted. */
function makeSpyEmitter(): SpyEmitter {
	const emits: Array<{ kind: string; payload: unknown }> = [];
	const state = { flushes: 0 };
	const emitter = {
		emit(kind: string, payload: unknown) {
			emits.push({ kind, payload });
		},
		async flush() {
			state.flushes += 1;
		},
	};
	return { emitter, emits, state };
}

/** Write a `.buildplane/ledger/events.db` carrying a single `plan_receipt` row —
 * the durable-tape shape planForgeReceiptExists probes. */
async function seedReceiptOnTape(
	workspace: string,
	runId: string,
	planId: string,
	admittedEventId: string,
): Promise<void> {
	const dbPath = resolve(workspace, ".buildplane", "ledger", "events.db");
	mkdirSync(dirname(dbPath), { recursive: true });
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(dbPath);
	try {
		db.exec(
			"CREATE TABLE events (id INTEGER PRIMARY KEY, run_id TEXT, kind TEXT, payload TEXT)",
		);
		db.prepare(
			"INSERT INTO events (run_id, kind, payload) VALUES (?, 'plan_receipt', ?)",
		).run(
			runId,
			JSON.stringify({
				PlanReceiptRecordedV1: {
					plan_id: planId,
					admission_event_id: admittedEventId,
				},
			}),
		);
	} finally {
		db.close();
	}
}

function minimalPlan(id: string): PlanForgePlan {
	return { id, tasks: [] } as unknown as PlanForgePlan;
}

describe("summarizeDispatchOutcome — R1 failing-task side-effect attribution", () => {
	it("pass-then-infra-fail: PF1 merges, PF2 dies with no diff/merge → producedSideEffects false (dispatch-error)", () => {
		const outcome = summarizeDispatchOutcome(
			[
				{
					task: "PF1",
					runId: "r1",
					status: "passed",
					mergedHeadSha: "sha-merged-1",
					changedFilesCount: 3,
					tokenUsage: 1000,
					reasons: [],
				},
				{
					task: "PF2",
					runId: "r2",
					status: "failed",
					mergedHeadSha: null,
					changedFilesCount: 0,
					tokenUsage: 0,
					reasons: [
						"worker rejected: 429 rate_limit_error (0 tokens, 0 turns)",
					],
				},
			],
			2,
		);
		expect(outcome.allPassed).toBe(false);
		// The bug: an earlier task's merge must NOT flip the failing task's verdict.
		expect(outcome.producedSideEffects).toBe(false);
		expect(outcome.reasons).toEqual([
			"worker rejected: 429 rate_limit_error (0 tokens, 0 turns)",
		]);
		// mergedHeadSha still aggregates the last merged tip across the dispatch.
		expect(outcome.mergedHeadSha).toBe("sha-merged-1");
		expect(outcome.runs).toEqual([
			{ task: "PF1", run_id: "r1", status: "passed" },
			{ task: "PF2", run_id: "r2", status: "failed" },
		]);
	});

	it("pass-then-acceptance-fail: PF2 built a rejected diff → producedSideEffects true (acceptance-fail)", () => {
		const outcome = summarizeDispatchOutcome(
			[
				{
					task: "PF1",
					runId: "r1",
					status: "passed",
					mergedHeadSha: "sha-merged-1",
					changedFilesCount: 2,
					tokenUsage: 500,
					reasons: [],
				},
				{
					task: "PF2",
					runId: "r2",
					status: "failed",
					mergedHeadSha: null,
					changedFilesCount: 5,
					tokenUsage: 4200,
					reasons: ["acceptance.contract: out-of-scope file src/secret.ts"],
				},
			],
			2,
		);
		expect(outcome.allPassed).toBe(false);
		expect(outcome.producedSideEffects).toBe(true);
		expect(outcome.reasons).toEqual([
			"acceptance.contract: out-of-scope file src/secret.ts",
		]);
		// tokenUsage sums across every task, including the failing one.
		expect(outcome.tokenUsage).toBe(4700);
	});

	it("single-task infra death with no side effects → producedSideEffects false", () => {
		const outcome = summarizeDispatchOutcome(
			[
				{
					task: "PF1",
					runId: "r1",
					status: "failed",
					mergedHeadSha: null,
					changedFilesCount: 0,
					tokenUsage: 0,
					reasons: ["worker rejected: 429"],
				},
			],
			2,
		);
		expect(outcome.allPassed).toBe(false);
		expect(outcome.producedSideEffects).toBe(false);
	});

	it("all tasks pass → allPassed true, producedSideEffects false (unused on success)", () => {
		const outcome = summarizeDispatchOutcome(
			[
				{
					task: "PF1",
					runId: "r1",
					status: "passed",
					mergedHeadSha: "sha-1",
					changedFilesCount: 1,
					tokenUsage: 100,
					reasons: [],
				},
				{
					task: "PF2",
					runId: "r2",
					status: "passed",
					mergedHeadSha: "sha-2",
					changedFilesCount: 1,
					tokenUsage: 200,
					reasons: [],
				},
			],
			2,
		);
		expect(outcome.allPassed).toBe(true);
		expect(outcome.producedSideEffects).toBe(false);
		expect(outcome.mergedHeadSha).toBe("sha-2");
		expect(outcome.tokenUsage).toBe(300);
	});
});

describe("emitPlanForgeTerminalReceipt — R1 dedup gate (no duplicate plan_receipt on re-fire)", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = mkdtempSync(join(tmpdir(), "bp-terminal-receipt-"));
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	it("does NOT emit a second plan_receipt when one already exists on the tape for this run", async () => {
		const planId = "pf-plan-dedup";
		const admittedEventId = "42";
		const runId = "run-dedup-1";
		await seedReceiptOnTape(workspace, runId, planId, admittedEventId);
		// Precondition: the dedup predicate sees the existing receipt.
		expect(
			await planForgeReceiptExists(workspace, runId, planId, admittedEventId),
		).toBe(true);

		const spy = makeSpyEmitter();
		await emitPlanForgeTerminalReceipt({
			emitter: spy.emitter as never,
			workspace,
			runId,
			plan: minimalPlan(planId),
			admittedEventId,
			outcome: "completed",
			result: { status: "dispatched" },
		});

		// Re-fire is a no-op: the emitter is never touched.
		expect(spy.emits).toHaveLength(0);
		expect(spy.state.flushes).toBe(0);
	});

	it("emits the plan_receipt when the tape carries none for this run", async () => {
		const planId = "pf-plan-fresh";
		const admittedEventId = "7";
		const runId = "run-fresh-1";
		expect(
			await planForgeReceiptExists(workspace, runId, planId, admittedEventId),
		).toBe(false);

		const spy = makeSpyEmitter();
		await emitPlanForgeTerminalReceipt({
			emitter: spy.emitter as never,
			workspace,
			runId,
			plan: minimalPlan(planId),
			admittedEventId,
			outcome: "completed",
			result: { status: "dispatched" },
		});

		expect(spy.emits).toHaveLength(1);
		expect(spy.emits[0]?.kind).toBe("plan_receipt");
		expect(spy.state.flushes).toBe(1);
	});

	it("emits when a receipt for a DIFFERENT plan identity exists on the same run (dedup keys on plan_id, not just run_id)", async () => {
		const planId = "pf-plan-real";
		const admittedEventId = "9";
		const runId = "run-shared-1";
		// A receipt exists on the run, but for a different plan_id — must not dedup.
		await seedReceiptOnTape(workspace, runId, "pf-plan-other", admittedEventId);
		expect(
			await planForgeReceiptExists(workspace, runId, planId, admittedEventId),
		).toBe(false);

		const spy = makeSpyEmitter();
		await emitPlanForgeTerminalReceipt({
			emitter: spy.emitter as never,
			workspace,
			runId,
			plan: minimalPlan(planId),
			admittedEventId,
			outcome: "completed",
			result: { status: "dispatched" },
		});

		expect(spy.emits).toHaveLength(1);
		expect(spy.state.flushes).toBe(1);
	});
});
