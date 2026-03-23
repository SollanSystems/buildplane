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
import { createProfileRegistry } from "../../packages/policy/src/profiles";
import { createMockStorage } from "../helpers/mock-storage";

function mockModelResolver(): ModelResolver {
	return (provider: string, modelId: string) => ({
		provider,
		modelId,
		fake: true,
	});
}

function makePacket(policyProfile: string): UnitPacket {
	return {
		unit: {
			id: "unit-retry-e2e",
			kind: "model",
			scope: "task",
			inputRefs: [],
			expectedOutputs: ["out.txt"],
			verificationContract: "exit-0-and-required-outputs",
			policyProfile,
		},
		model: {
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
			systemPrompt: "Test",
		},
		verification: { requiredOutputs: ["out.txt"] },
	};
}

function makeMockStorage(_root: string) {
	return createMockStorage();
}

describe("retry enforcement end-to-end", () => {
	it("retries a failed run and succeeds on second attempt", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "bp-retry-e2e-")));

		const registry = createProfileRegistry([
			{
				name: "retry-once",
				retry: { maxRetries: 1, injectFailureContext: true },
			},
		]);

		// First call fails (exit 1), second succeeds (exit 0)
		let callCount = 0;
		const streamFn: StreamFunction = () => {
			callCount++;
			const shouldFail = callCount === 1;
			return {
				fullStream: (async function* () {
					yield {
						type: "text-delta" as const,
						textDelta: shouldFail ? "failing" : "success",
					};
					yield {
						type: "finish-step" as const,
						finishReason: "stop",
						usage: { promptTokens: 5, completionTokens: 1 },
					};
				})(),
			};
		};

		const executor = createModelExecutor({
			streamFn,
			modelResolver: mockModelResolver(),
			toolBuilder: (() => ({})) as ToolBuilder,
		});

		// Mock runtime that returns exit 1 on first call, exit 0 on second
		let execCount = 0;
		const mockRuntime = {
			executePacket: executor.executePacket,
			executePacketAsync: async (
				packet: UnitPacket,
				projectRoot: string,
				eventBus: unknown,
				signal?: AbortSignal,
			) => {
				execCount++;
				const receipt = await executor.executePacketAsync(
					packet,
					projectRoot,
					eventBus as never,
					signal,
				);
				// First execution "fails" — simulate missing output
				if (execCount === 1) {
					return {
						...receipt,
						exitCode: 1,
						stderr: "output not produced",
						outputChecks: [{ path: "out.txt", exists: false }],
					};
				}
				// Second execution succeeds
				return {
					...receipt,
					exitCode: 0,
					outputChecks: [{ path: "out.txt", exists: true }],
				};
			},
		};

		const bus = createEventBus();
		const events: ExecutionEvent[] = [];
		bus.subscribe((e) => events.push(e));

		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: root,
			storage: makeMockStorage(root),
			runtime: mockRuntime,
			policy: { evaluateRun, evaluateBudgets },
			workspace: {
				assertRunnableRepository: () => ({ headSha: "abc" }),
				prepareWorkspace: () => ({ path: root, headSha: "abc" }),
				deleteWorkspace: () => ({ deleted: true }),
			},
			eventBus: bus,
			profileRegistry: registry,
		});

		const result = await orchestrator.runPacketAsync(
			makePacket("retry-once"),
			bus,
		);

		// Should pass after retry
		expect(result.run.status).toBe("passed");
		expect(execCount).toBe(2);

		// Should have retry-run and advance-run policy decisions
		const policyDecisions = events.filter((e) => e.kind === "policy-decision");
		expect(policyDecisions.length).toBeGreaterThanOrEqual(2);

		const retryDecision = policyDecisions.find(
			(e) => e.kind === "policy-decision" && e.decisionKind === "retry-run",
		);
		expect(retryDecision).toBeDefined();

		const approveDecision = policyDecisions.find(
			(e) => e.kind === "policy-decision" && e.decisionKind === "advance-run",
		);
		expect(approveDecision).toBeDefined();

		// Should have two execution-started events (original + retry)
		const execStarts = events.filter((e) => e.kind === "execution-started");
		expect(execStarts).toHaveLength(2);
	});

	it("exhausts retries and rejects", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "bp-retry-e2e-")));

		const registry = createProfileRegistry([
			{
				name: "retry-once",
				retry: { maxRetries: 1, injectFailureContext: true },
			},
		]);

		// Always fails
		const executor = createModelExecutor({
			streamFn: () => ({
				fullStream: (async function* () {
					yield { type: "text-delta" as const, textDelta: "fail" };
					yield {
						type: "finish-step" as const,
						finishReason: "stop",
						usage: { promptTokens: 5, completionTokens: 1 },
					};
				})(),
			}),
			modelResolver: mockModelResolver(),
			toolBuilder: (() => ({})) as ToolBuilder,
		});

		const alwaysFailRuntime = {
			executePacket: executor.executePacket,
			executePacketAsync: async (
				packet: UnitPacket,
				projectRoot: string,
				eventBus: unknown,
				signal?: AbortSignal,
			) => {
				const receipt = await executor.executePacketAsync(
					packet,
					projectRoot,
					eventBus as never,
					signal,
				);
				return {
					...receipt,
					exitCode: 1,
					outputChecks: [{ path: "out.txt", exists: false }],
				};
			},
		};

		const bus = createEventBus();
		const events: ExecutionEvent[] = [];
		bus.subscribe((e) => events.push(e));

		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: root,
			storage: makeMockStorage(root),
			runtime: alwaysFailRuntime,
			policy: { evaluateRun, evaluateBudgets },
			workspace: {
				assertRunnableRepository: () => ({ headSha: "abc" }),
				prepareWorkspace: () => ({ path: root, headSha: "abc" }),
				deleteWorkspace: () => ({ deleted: true }),
			},
			eventBus: bus,
			profileRegistry: registry,
		});

		const result = await orchestrator.runPacketAsync(
			makePacket("retry-once"),
			bus,
		);

		// Should fail after exhausting retries
		expect(result.run.status).toBe("failed");

		// Should have retry-run then reject-run
		const decisions = events.filter((e) => e.kind === "policy-decision");
		const retries = decisions.filter(
			(e) => e.kind === "policy-decision" && e.decisionKind === "retry-run",
		);
		const rejects = decisions.filter(
			(e) => e.kind === "policy-decision" && e.decisionKind === "reject-run",
		);
		expect(retries).toHaveLength(1);
		expect(rejects).toHaveLength(1);
	});
});
