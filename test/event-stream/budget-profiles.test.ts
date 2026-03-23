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

function makePacket(policyProfile: string): UnitPacket {
	return {
		unit: {
			id: `unit-profile-${policyProfile}`,
			kind: "model",
			scope: "task",
			inputRefs: [],
			expectedOutputs: [],
			verificationContract: "exit-0-and-required-outputs",
			policyProfile,
		},
		model: {
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
		},
		verification: { requiredOutputs: [] },
	};
}

function makeMockStorage(_root: string) {
	return createMockStorage();
}

describe("budget enforcement with policy profiles", () => {
	it("strict profile enforces a token budget, default does not", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "bp-profile-e2e-")));

		const registry = createProfileRegistry([
			{ name: "strict", budgets: { maxTokens: 10 } },
		]);

		// Stream 20 tokens
		const executor = createModelExecutor({
			streamFn: streamWithTokenCount(20),
			modelResolver: mockModelResolver(),
			toolBuilder: (() => ({})) as ToolBuilder,
		});

		const mockWorkspace = {
			assertRunnableRepository: () => ({ headSha: "abc" }),
			prepareWorkspace: () => ({ path: root, headSha: "abc" }),
			deleteWorkspace: () => ({ deleted: true }),
		};

		// Run with "strict" profile — should be aborted
		const strictBus = createEventBus();
		const strictEvents: ExecutionEvent[] = [];
		strictBus.subscribe((e) => strictEvents.push(e));

		const strictOrchestrator = createBuildplaneOrchestrator({
			projectRoot: root,
			storage: makeMockStorage(root),
			runtime: {
				executePacket: executor.executePacket,
				executePacketAsync: executor.executePacketAsync,
			},
			policy: { evaluateRun, evaluateBudgets },
			workspace: mockWorkspace,
			eventBus: strictBus,
			profileRegistry: registry,
		});

		const strictResult = await strictOrchestrator.runPacketAsync(
			makePacket("strict"),
			strictBus,
		);
		expect(strictResult.run.status).toBe("failed");
		expect(strictEvents.some((e) => e.kind === "policy-budget-breached")).toBe(
			true,
		);

		// Run with "default" profile — should pass (no budget)
		const defaultBus = createEventBus();
		const defaultEvents: ExecutionEvent[] = [];
		defaultBus.subscribe((e) => defaultEvents.push(e));

		const defaultOrchestrator = createBuildplaneOrchestrator({
			projectRoot: root,
			storage: makeMockStorage(root),
			runtime: {
				executePacket: executor.executePacket,
				executePacketAsync: executor.executePacketAsync,
			},
			policy: { evaluateRun, evaluateBudgets },
			workspace: mockWorkspace,
			eventBus: defaultBus,
			profileRegistry: registry,
		});

		const defaultResult = await defaultOrchestrator.runPacketAsync(
			makePacket("default"),
			defaultBus,
		);
		expect(defaultResult.run.status).toBe("passed");
		expect(defaultEvents.some((e) => e.kind === "policy-budget-breached")).toBe(
			false,
		);
	});

	it("falls back to top-level budgets when no profile registry", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "bp-profile-e2e-")));

		const executor = createModelExecutor({
			streamFn: streamWithTokenCount(20),
			modelResolver: mockModelResolver(),
			toolBuilder: (() => ({})) as ToolBuilder,
		});

		const bus = createEventBus();
		const events: ExecutionEvent[] = [];
		bus.subscribe((e) => events.push(e));

		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: root,
			storage: makeMockStorage(root),
			runtime: {
				executePacket: executor.executePacket,
				executePacketAsync: executor.executePacketAsync,
			},
			policy: { evaluateRun, evaluateBudgets },
			workspace: {
				assertRunnableRepository: () => ({ headSha: "abc" }),
				prepareWorkspace: () => ({ path: root, headSha: "abc" }),
				deleteWorkspace: () => ({ deleted: true }),
			},
			eventBus: bus,
			budgets: { maxTokens: 5 },
			// No profileRegistry — should use top-level budgets
		});

		const result = await orchestrator.runPacketAsync(
			makePacket("default"),
			bus,
		);
		expect(result.run.status).toBe("failed");
		expect(events.some((e) => e.kind === "policy-budget-breached")).toBe(true);
	});

	it("throws on unknown profile name", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "bp-profile-e2e-")));

		const registry = createProfileRegistry([
			{ name: "strict", budgets: { maxTokens: 10 } },
		]);

		const executor = createModelExecutor({
			streamFn: streamWithTokenCount(5),
			modelResolver: mockModelResolver(),
			toolBuilder: (() => ({})) as ToolBuilder,
		});

		const bus = createEventBus();

		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: root,
			storage: makeMockStorage(root),
			runtime: {
				executePacket: executor.executePacket,
				executePacketAsync: executor.executePacketAsync,
			},
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
			makePacket("nonexistent"),
			bus,
		);
		// Should fail with an execution error since profile resolution throws
		expect(result.run.status).toBe("failed");
	});
});
