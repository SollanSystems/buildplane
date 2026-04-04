/**
 * Regression test for the "budget across retries" bug.
 *
 * Before the fix, the budget subscriber was unsubscribed after the FIRST
 * executeOnce call, so retries ran without budget enforcement. A model
 * that used 60 tokens on attempt 1 and 60 more on attempt 2 would never
 * trigger a 100-token budget breach.
 *
 * After the fix, the subscriber stays active across all attempts via a
 * try/finally around the retry loop. Token usage accumulates cumulatively
 * and the breach fires during attempt 2 once total tokens exceed the budget.
 */
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createModelExecutor,
	type ModelResolver,
	type StreamFunction,
	type ToolBuilder,
} from "../../packages/adapters-models/src/model-executor";
import {
	createEventBus,
	type ExecutionEvent,
} from "../../packages/kernel/src/events";
import { createBuildplaneOrchestrator } from "../../packages/kernel/src/orchestrator";
import type { UnitPacket } from "../../packages/kernel/src/run-loop";
import type {
	BudgetConstraints,
	ExecutionReceipt,
	PolicyDecision,
	PolicyProfile,
	ResourceUsageSnapshot,
} from "../../packages/kernel/src/types";
import { evaluateBudgets } from "../../packages/policy/src/budgets";
import { createMockStorage } from "../helpers/mock-storage";

function mockModelResolver(): ModelResolver {
	return (provider: string, modelId: string) => ({
		provider,
		modelId,
		fake: true,
	});
}

function makeModelPacket(): UnitPacket {
	return {
		unit: {
			id: "unit-budget-retry",
			kind: "model",
			scope: "task",
			inputRefs: [],
			expectedOutputs: [],
			verificationContract: "exit-0-and-required-outputs",
			policyProfile: "default",
		},
		model: {
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
			systemPrompt: "Test",
		},
		verification: { requiredOutputs: [] },
	};
}

/** Stream N text-delta chunks then finish. Each delta is one model-token-delta event. */
function streamWithTokenCount(n: number): StreamFunction {
	return () => ({
		fullStream: (async function* () {
			for (let i = 0; i < n; i++) {
				yield { type: "text-delta" as const, textDelta: `t${i} ` };
			}
			yield {
				type: "finish-step" as const,
				finishReason: "stop",
				usage: { promptTokens: 10, completionTokens: n },
			};
		})(),
	});
}

/**
 * Policy that forces exactly one retry on a SUCCESSFUL first attempt (exitCode=0),
 * then approves a clean second attempt or rejects a failed one.
 * When the budget aborts attempt 2, the model executor returns exitCode=1,
 * which this policy correctly rejects — allowing the budget-breach to be the
 * visible cause of failure.
 */
function retryOnceThenApprove() {
	return {
		evaluateRun(
			_packet: UnitPacket,
			receipt: ExecutionReceipt,
			_profile?: PolicyProfile,
			attemptCount?: number,
		): PolicyDecision {
			// A non-zero exit code (including abort) always means failure
			if (receipt.exitCode !== 0) {
				return {
					kind: "reject-run",
					outcome: "rejected",
					reasons: [`exit code ${receipt.exitCode}`],
				};
			}
			// Force a retry on the first clean attempt
			if ((attemptCount ?? 0) === 0) {
				return {
					kind: "retry-run",
					outcome: "retrying",
					reasons: ["forced-retry-for-budget-test"],
					attemptNumber: 1,
					feedbackContext: [],
				};
			}
			return { kind: "advance-run", outcome: "approved", reasons: [] };
		},
		evaluateBudgets(
			_packet: UnitPacket,
			usage: ResourceUsageSnapshot,
			budgets: BudgetConstraints,
		) {
			return evaluateBudgets(_packet, usage, budgets);
		},
	};
}

describe("budget enforcement across retries", () => {
	it("accumulates token usage across attempts and breaches budget on attempt 2", async () => {
		const bus = createEventBus();
		const events: ExecutionEvent[] = [];
		bus.subscribe((e) => events.push(e));

		const root = realpathSync(mkdtempSync(join(tmpdir(), "bp-budget-retry-")));

		// 60 tokens per attempt. With budget=100: attempt 1 uses 60 (ok),
		// attempt 2 pushes cumulative total over 100 → breach.
		let callCount = 0;
		const streamFn: StreamFunction = () => {
			callCount++;
			return streamWithTokenCount(60)();
		};

		const executor = createModelExecutor({
			streamFn,
			modelResolver: mockModelResolver(),
			toolBuilder: (() => ({})) as ToolBuilder,
		});

		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: root,
			storage: createMockStorage(),
			runtime: {
				executePacket: executor.executePacket,
				executePacketAsync: executor.executePacketAsync,
			},
			policy: retryOnceThenApprove(),
			workspace: {
				assertRunnableRepository: () => ({ headSha: "abc123" }),
				prepareWorkspace: () => ({ path: root, headSha: "abc123" }),
				deleteWorkspace: () => ({ deleted: true }),
			},
			eventBus: bus,
			budgets: { maxTokens: 100 },
		});

		const result = await orchestrator.runPacketAsync(makeModelPacket(), bus);

		// Assert: run is aborted, not allowed to complete
		expect(result.run.status).toBe("failed");

		// Assert: policy-budget-breached event is emitted during attempt 2
		const breachEvent = events.find((e) => e.kind === "policy-budget-breached");
		expect(breachEvent).toBeDefined();
		if (breachEvent?.kind === "policy-budget-breached") {
			expect(breachEvent.budgetType).toBe("tokens");
			expect(breachEvent.limit).toBe(100);
			// Cumulative from both attempts: actual > 100
			expect(breachEvent.actual).toBeGreaterThan(100);
		}

		// Two attempts must have occurred — breach happens during attempt 2
		expect(callCount).toBeGreaterThanOrEqual(2);
	});

	it("does not breach when cumulative tokens stay under budget", async () => {
		// 60 + 60 = 120 total tokens, budget = 150 → no breach
		const bus = createEventBus();
		const events: ExecutionEvent[] = [];
		bus.subscribe((e) => events.push(e));

		const root = realpathSync(
			mkdtempSync(join(tmpdir(), "bp-budget-retry-ok-")),
		);

		const streamFn: StreamFunction = () => streamWithTokenCount(60)();
		const executor = createModelExecutor({
			streamFn,
			modelResolver: mockModelResolver(),
			toolBuilder: (() => ({})) as ToolBuilder,
		});

		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: root,
			storage: createMockStorage(),
			runtime: {
				executePacket: executor.executePacket,
				executePacketAsync: executor.executePacketAsync,
			},
			policy: retryOnceThenApprove(),
			workspace: {
				assertRunnableRepository: () => ({ headSha: "abc123" }),
				prepareWorkspace: () => ({ path: root, headSha: "abc123" }),
				deleteWorkspace: () => ({ deleted: true }),
			},
			eventBus: bus,
			budgets: { maxTokens: 150 },
		});

		const result = await orchestrator.runPacketAsync(makeModelPacket(), bus);

		// 60 + 60 = 120 < 150 → passes
		expect(result.run.status).toBe("passed");

		// No budget breach event
		expect(
			events.find((e) => e.kind === "policy-budget-breached"),
		).toBeUndefined();
	});
});
