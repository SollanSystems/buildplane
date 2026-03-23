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
import { evaluateBudgets } from "../../packages/policy/src/budgets";
import { evaluateRun } from "../../packages/policy/src/decision";

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
			id: "unit-budget-e2e",
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
		verification: {
			requiredOutputs: [],
		},
	};
}

/**
 * Create a stream function that yields N text-delta chunks
 * and then a finish-step. Each delta is one "token" for budget counting.
 */
function streamWithTokenCount(n: number): StreamFunction {
	return () => ({
		fullStream: (async function* () {
			for (let i = 0; i < n; i++) {
				yield { type: "text-delta" as const, textDelta: `token${i} ` };
			}
			yield {
				type: "finish-step" as const,
				finishReason: "stop",
				usage: { promptTokens: 10, completionTokens: n },
			};
		})(),
	});
}

describe("budget enforcement end-to-end", () => {
	it("aborts a model run that exceeds the token budget", async () => {
		const bus = createEventBus();
		const events: ExecutionEvent[] = [];
		bus.subscribe((e) => events.push(e));

		const root = realpathSync(mkdtempSync(join(tmpdir(), "bp-budget-e2e-")));

		// Stream 20 tokens, but budget is 10
		const executor = createModelExecutor({
			streamFn: streamWithTokenCount(20),
			modelResolver: mockModelResolver(),
			toolBuilder: (() => ({})) as ToolBuilder,
		});

		// Minimal mock storage
		const runs: Record<string, { id: string; unitId: string; status: string }> =
			{};
		const mockStorage = {
			initializeProject: () => ({
				created: true,
				projectRoot: root,
				stateDbPath: join(root, "state.db"),
			}),
			createRun: (packet: UnitPacket) => {
				const id = `run-${Date.now()}`;
				const run = { id, unitId: packet.unit.id, status: "pending" };
				runs[id] = run;
				return run;
			},
			markRunRunning: (runId: string) => {
				if (runs[runId]) runs[runId].status = "running";
			},
			recordExecutionEvidence: () => {},
			recordDecision: () => {},
			completeRun: (runId: string, status: string) => {
				if (runs[runId]) runs[runId].status = status;
				return runs[runId];
			},
			getStatusSnapshot: () => ({
				initialized: true,
				latestRunUsedWorkspace: false,
				actionableWorkspaces: [],
				runCounts: {
					pending: 0,
					running: 0,
					passed: 0,
					failed: 0,
					cancelled: 0,
				},
			}),
			inspectTarget: () => {
				throw new Error("not implemented");
			},
			recordWorkspacePrepared: () => {},
			commitRunFailureOutcome: () => {
				throw new Error("not implemented");
			},
			commitRunSuccessOutcome: () => {
				throw new Error("not implemented");
			},
			recordWorkspaceDeleted: () => {},
			recordWorkspaceCleanupFailed: () => {},
		};

		const mockWorkspace = {
			assertRunnableRepository: () => ({ headSha: "abc123" }),
			prepareWorkspace: () => ({ path: root, headSha: "abc123" }),
			deleteWorkspace: () => ({ deleted: true }),
		};

		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: root,
			storage: mockStorage as never,
			runtime: {
				executePacket: executor.executePacket,
				executePacketAsync: executor.executePacketAsync,
			},
			policy: {
				evaluateRun,
				evaluateBudgets,
			},
			workspace: mockWorkspace,
			eventBus: bus,
			budgets: { maxTokens: 10 },
		});

		const result = await orchestrator.runPacketAsync(makeModelPacket(), bus);

		// Run should fail due to budget breach
		expect(result.run.status).toBe("failed");

		// Should have a policy-budget-breached event
		const budgetEvent = events.find((e) => e.kind === "policy-budget-breached");
		expect(budgetEvent).toBeDefined();
		if (budgetEvent?.kind === "policy-budget-breached") {
			expect(budgetEvent.budgetType).toBe("tokens");
			expect(budgetEvent.limit).toBe(10);
			expect(budgetEvent.actual).toBeGreaterThan(10);
		}

		// The model response should be aborted (not all 20 tokens)
		const responseComplete = events.find(
			(e) => e.kind === "model-response-complete",
		);
		expect(responseComplete).toBeDefined();
		if (responseComplete?.kind === "model-response-complete") {
			expect(responseComplete.finishReason).toBe("aborted");
		}
	});

	it("allows a model run that stays within budget", async () => {
		const bus = createEventBus();
		const events: ExecutionEvent[] = [];
		bus.subscribe((e) => events.push(e));

		const root = realpathSync(mkdtempSync(join(tmpdir(), "bp-budget-e2e-")));

		// Stream 5 tokens, budget is 10
		const executor = createModelExecutor({
			streamFn: streamWithTokenCount(5),
			modelResolver: mockModelResolver(),
			toolBuilder: (() => ({})) as ToolBuilder,
		});

		const runs: Record<string, { id: string; unitId: string; status: string }> =
			{};
		const mockStorage = {
			initializeProject: () => ({
				created: true,
				projectRoot: root,
				stateDbPath: join(root, "state.db"),
			}),
			createRun: (packet: UnitPacket) => {
				const id = `run-${Date.now()}`;
				const run = { id, unitId: packet.unit.id, status: "pending" };
				runs[id] = run;
				return run;
			},
			markRunRunning: (runId: string) => {
				if (runs[runId]) runs[runId].status = "running";
			},
			recordExecutionEvidence: () => {},
			recordDecision: () => {},
			completeRun: (runId: string, status: string) => {
				if (runs[runId]) runs[runId].status = status;
				return runs[runId];
			},
			getStatusSnapshot: () => ({
				initialized: true,
				latestRunUsedWorkspace: false,
				actionableWorkspaces: [],
				runCounts: {
					pending: 0,
					running: 0,
					passed: 0,
					failed: 0,
					cancelled: 0,
				},
			}),
			inspectTarget: () => {
				throw new Error("not implemented");
			},
			recordWorkspacePrepared: () => {},
			commitRunFailureOutcome: () => {
				throw new Error("not implemented");
			},
			commitRunSuccessOutcome: () => {
				throw new Error("not implemented");
			},
			recordWorkspaceDeleted: () => {},
			recordWorkspaceCleanupFailed: () => {},
		};

		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: root,
			storage: mockStorage as never,
			runtime: {
				executePacket: executor.executePacket,
				executePacketAsync: executor.executePacketAsync,
			},
			policy: {
				evaluateRun,
				evaluateBudgets,
			},
			workspace: {
				assertRunnableRepository: () => ({ headSha: "abc123" }),
				prepareWorkspace: () => ({ path: root, headSha: "abc123" }),
				deleteWorkspace: () => ({ deleted: true }),
			},
			eventBus: bus,
			budgets: { maxTokens: 10 },
		});

		const result = await orchestrator.runPacketAsync(makeModelPacket(), bus);

		// Run should pass — within budget
		expect(result.run.status).toBe("passed");

		// No budget breach events
		const budgetEvent = events.find((e) => e.kind === "policy-budget-breached");
		expect(budgetEvent).toBeUndefined();
	});

	it("runs without budget enforcement when no budgets are configured", async () => {
		const bus = createEventBus();

		const root = realpathSync(mkdtempSync(join(tmpdir(), "bp-budget-e2e-")));

		const executor = createModelExecutor({
			streamFn: streamWithTokenCount(100),
			modelResolver: mockModelResolver(),
			toolBuilder: (() => ({})) as ToolBuilder,
		});

		const runs: Record<string, { id: string; unitId: string; status: string }> =
			{};
		const mockStorage = {
			initializeProject: () => ({
				created: true,
				projectRoot: root,
				stateDbPath: join(root, "state.db"),
			}),
			createRun: (packet: UnitPacket) => {
				const id = `run-${Date.now()}`;
				const run = { id, unitId: packet.unit.id, status: "pending" };
				runs[id] = run;
				return run;
			},
			markRunRunning: (runId: string) => {
				if (runs[runId]) runs[runId].status = "running";
			},
			recordExecutionEvidence: () => {},
			recordDecision: () => {},
			completeRun: (runId: string, status: string) => {
				if (runs[runId]) runs[runId].status = status;
				return runs[runId];
			},
			getStatusSnapshot: () => ({
				initialized: true,
				latestRunUsedWorkspace: false,
				actionableWorkspaces: [],
				runCounts: {
					pending: 0,
					running: 0,
					passed: 0,
					failed: 0,
					cancelled: 0,
				},
			}),
			inspectTarget: () => {
				throw new Error("not implemented");
			},
			recordWorkspacePrepared: () => {},
			commitRunFailureOutcome: () => {
				throw new Error("not implemented");
			},
			commitRunSuccessOutcome: () => {
				throw new Error("not implemented");
			},
			recordWorkspaceDeleted: () => {},
			recordWorkspaceCleanupFailed: () => {},
		};

		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: root,
			storage: mockStorage as never,
			runtime: {
				executePacket: executor.executePacket,
				executePacketAsync: executor.executePacketAsync,
			},
			policy: { evaluateRun },
			workspace: {
				assertRunnableRepository: () => ({ headSha: "abc123" }),
				prepareWorkspace: () => ({ path: root, headSha: "abc123" }),
				deleteWorkspace: () => ({ deleted: true }),
			},
			eventBus: bus,
			// No budgets configured
		});

		const result = await orchestrator.runPacketAsync(makeModelPacket(), bus);

		// All 100 tokens should stream, run should pass
		expect(result.run.status).toBe("passed");
	});
});
