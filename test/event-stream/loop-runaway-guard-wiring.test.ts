import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runawayGuardProfile } from "../../apps/cli/src/loop-supervisor";
import { makeDefaultLoopDispatch } from "../../apps/cli/src/run-cli";
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
import type { PolicyProfile } from "../../packages/kernel/src/policy";
import type { BuildplaneProfileRegistryPort } from "../../packages/kernel/src/ports";
import type { UnitPacket } from "../../packages/kernel/src/run-loop";
import { evaluateBudgets } from "../../packages/policy/src/budgets";
import { evaluateRun } from "../../packages/policy/src/decision";
import { createMockStorage } from "../helpers/mock-storage";

function mockModelResolver(): ModelResolver {
	return (provider: string, modelId: string) => ({
		provider,
		modelId,
		fake: true,
	});
}

function makeModelPacket(policyProfile: string): UnitPacket {
	return {
		unit: {
			id: "unit-loop-guard",
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
			systemPrompt: "Test",
		},
		verification: {
			requiredOutputs: [],
		},
	};
}

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

/**
 * GAP-7 CRITICAL-1 regression: the supervisor loop's runaway guard
 * (`runawayGuardProfile`) carries `budgets`, and those budgets must reach
 * `createBuildplaneOrchestrator` so the per-packet AbortController aborts a
 * runaway model worker mid-stream — even while the dispatched packet routes
 * through its per-task acceptance profile (which carries trustGates but NO
 * budgets).
 *
 * This pins the abort behavior at the orchestrator wiring contract the CLI
 * dispatch path must satisfy: top-level `budgets` (= the guard's budgets) +
 * `evaluateBudgets`, with the dispatched packet on an acceptance profile.
 * `effectiveBudgets = resolvedProfile?.budgets ?? topLevelBudgets`, so the
 * acceptance profile (no budgets) must fall through to the guard's budgets.
 */
describe("loop runaway guard wiring", () => {
	it("aborts a runaway worker when the guard's budgets are threaded to the orchestrator (even with an acceptance profile on the packet)", async () => {
		const bus = createEventBus();
		const events: ExecutionEvent[] = [];
		bus.subscribe((e) => events.push(e));

		const root = realpathSync(mkdtempSync(join(tmpdir(), "bp-loop-guard-")));

		// Stream 50 tokens; the guard caps at 10.
		const executor = createModelExecutor({
			streamFn: streamWithTokenCount(50),
			modelResolver: mockModelResolver(),
			toolBuilder: (() => ({})) as ToolBuilder,
		});

		// The guard the supervisor loop builds. Only maxTokens/maxComputeTimeMs.
		const guard = runawayGuardProfile({
			profileName: "planforge-loop-guard",
			maxTokens: 10,
			maxComputeTimeMs: 30 * 60_000,
		});

		// The dispatched packet routes through its per-task ACCEPTANCE profile,
		// which carries trustGates but NO budgets — mirroring the real dispatch.
		const acceptanceProfile: PolicyProfile = {
			name: "planforge-acceptance",
			trustGates: {},
		};
		const profileRegistry: BuildplaneProfileRegistryPort = {
			resolve(name) {
				if (name === acceptanceProfile.name) return acceptanceProfile;
				throw new Error(`unknown policy profile: ${name}`);
			},
		};

		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: root,
			storage: createMockStorage(),
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
				checkWorktreeClean: () => true,
				prepareWorkspace: () => ({ path: root, headSha: "abc123" }),
				deleteWorkspace: () => ({ deleted: true }),
			},
			eventBus: bus,
			profileRegistry,
			// The guard's budgets, delivered as top-level orchestrator budgets.
			budgets: guard.budgets,
		});

		const result = await orchestrator.runPacketAsync(
			makeModelPacket(acceptanceProfile.name),
			bus,
		);

		// Runaway worker is aborted → run does not complete normally.
		expect(result.run.status).toBe("failed");

		const budgetEvent = events.find((e) => e.kind === "policy-budget-breached");
		expect(budgetEvent).toBeDefined();
		if (budgetEvent?.kind === "policy-budget-breached") {
			expect(budgetEvent.budgetType).toBe("tokens");
			expect(budgetEvent.limit).toBe(10);
		}

		const responseComplete = events.find(
			(e) => e.kind === "model-response-complete",
		);
		expect(responseComplete).toBeDefined();
		if (responseComplete?.kind === "model-response-complete") {
			expect(responseComplete.finishReason).toBe("aborted");
		}
	});

	it("the default loop dispatch threads the guard's budgets to the dispatch command (GAP-7 CRITICAL-1 regression)", async () => {
		// Spy the dispatch command the loop port routes through, capture its opts.
		const dispatchSpy = vi.fn(
			async (
				_args: readonly string[],
				_cwd: string,
				_stdout: (line: string) => void,
				opts?: { budgets?: unknown; claudeMaxTurns?: number },
			) => {
				opts?.onOutcome?.({
					allPassed: true,
					mergedHeadSha: null,
					tokenUsage: 0,
					runs: [],
				} as never);
				return 0;
			},
		);

		const guard = runawayGuardProfile({
			profileName: "planforge-loop-guard",
			maxTokens: 200_000,
			maxComputeTimeMs: 30 * 60_000,
		});

		const dispatch = makeDefaultLoopDispatch(
			12,
			dispatchSpy as unknown as Parameters<typeof makeDefaultLoopDispatch>[1],
		);
		await dispatch("/tmp/plan.md", "/tmp/ws", guard);

		expect(dispatchSpy).toHaveBeenCalledOnce();
		const passedOpts = dispatchSpy.mock.calls[0]?.[3] as
			| { budgets?: { maxTokens?: number; maxComputeTimeMs?: number } }
			| undefined;
		// The OLD wiring discarded the guard and passed NO budgets — this asserts
		// the guard's budgets now reach the dispatch (→ the orchestrator).
		expect(passedOpts?.budgets).toEqual(guard.budgets);
		expect(passedOpts?.budgets?.maxTokens).toBe(200_000);
	});
});
