import { describe, expect, it } from "vitest";
import type { ExecutionEvent } from "../../packages/kernel/src/events";
import {
	initialRunViewState,
	type RunViewState,
	reduceRunState,
} from "../../packages/ui-tui/src/hooks/use-run-state";

function now(): string {
	return new Date().toISOString();
}

function applyEvents(
	events: ExecutionEvent[],
	initialState: RunViewState = initialRunViewState,
): RunViewState {
	return events.reduce(
		(state, event) => reduceRunState(state, event),
		initialState,
	);
}

function makeLifecycleEvents(
	runId: string,
	unitId: string,
	outcome: "passed" | "failed" = "passed",
): ExecutionEvent[] {
	return [
		{ kind: "run-created", runId, unitId, status: "pending", timestamp: now() },
		{ kind: "run-started", runId, unitId, status: "running", timestamp: now() },
		{
			kind: "execution-started",
			runId,
			executionType: "model",
			timestamp: now(),
		},
		{ kind: "model-token-delta", runId, delta: "Hello", timestamp: now() },
		{ kind: "model-token-delta", runId, delta: " world", timestamp: now() },
		{
			kind: "model-response-complete",
			runId,
			text: "Hello world",
			finishReason: "stop",
			timestamp: now(),
		},
		{
			kind: "evidence-recorded",
			runId,
			evidenceKind: "command-exit",
			status: "pass",
			timestamp: now(),
		},
		{
			kind: "policy-decision",
			runId,
			decisionKind: outcome === "passed" ? "advance-run" : "reject-run",
			outcome: outcome === "passed" ? "approved" : "rejected",
			reasons: outcome === "passed" ? [] : ["exit code 1"],
			timestamp: now(),
		},
		{
			kind: "run-completed",
			runId,
			unitId,
			status: outcome,
			timestamp: now(),
		},
	];
}

describe("TUI contract — run state reducer", () => {
	it("tracks phase transitions through a successful raw run", () => {
		const state = applyEvents(makeLifecycleEvents("run-1", "unit-1", "passed"));

		expect(state.phase).toBe("completed");
		expect(state.modelText).toBe("Hello world");
		expect(state.evidenceCount).toBe(1);
		expect(state.policyOutcome).toBe("approved");
		expect(state.done).toBe(true);
		expect(state.runId).toBe("run-1");
		expect(state.unitId).toBe("unit-1");
	});

	it("tracks tool calls through started → completed", () => {
		const state = applyEvents([
			{
				kind: "tool-call-started",
				runId: "run-1",
				timestamp: now(),
				toolCallId: "call-1",
				toolName: "read_file",
				args: { path: "/tmp/test" },
			},
			{
				kind: "tool-call-completed",
				runId: "run-1",
				timestamp: now(),
				toolCallId: "call-1",
				toolName: "read_file",
				result: "file contents",
			},
		]);

		expect(state.toolCalls).toEqual([
			{
				id: "call-1",
				name: "read_file",
				status: "completed",
				args: { path: "/tmp/test" },
				result: "file contents",
			},
		]);
	});

	it("captures execution errors", () => {
		const state = applyEvents([
			{
				kind: "execution-error",
				runId: "run-1",
				timestamp: now(),
				message: "API connection failed",
				phase: "model-execution",
			},
		]);

		expect(state.error).toBe("API connection failed");
		expect(state.phase).toBe("error");
	});

	it("tracks failed raw run outcome", () => {
		const state = applyEvents(makeLifecycleEvents("run-1", "unit-1", "failed"));

		expect(state.policyOutcome).toBe("rejected");
		expect(state.phase).toBe("failed");
		expect(state.done).toBe(true);
	});

	it("does not finish a graph-backed session until graph-completed arrives", () => {
		const stateAfterChildCompletion = applyEvents([
			{
				kind: "graph-started",
				runId: "strategy-parent",
				graphId: "strategy-graph-1",
				unitCount: 2,
				timestamp: now(),
			},
			{
				kind: "run-created",
				runId: "child-run-1",
				unitId: "implementer",
				status: "pending",
				timestamp: now(),
				context: {
					runId: "child-run-1",
					strategyId: "strategy-1",
					executor: "codex",
				},
			},
			{
				kind: "run-completed",
				runId: "child-run-1",
				unitId: "implementer",
				status: "passed",
				timestamp: now(),
				context: {
					runId: "child-run-1",
					strategyId: "strategy-1",
					executor: "codex",
				},
			},
		]);

		expect(stateAfterChildCompletion.graphActive).toBe(true);
		expect(stateAfterChildCompletion.graphId).toBe("strategy-graph-1");
		expect(stateAfterChildCompletion.graphUnitCount).toBe(2);
		expect(stateAfterChildCompletion.done).toBe(false);

		const finalState = reduceRunState(stateAfterChildCompletion, {
			kind: "graph-completed",
			runId: "strategy-parent",
			graphId: "strategy-graph-1",
			outcome: "passed",
			timestamp: now(),
		});

		expect(finalState.graphOutcome).toBe("passed");
		expect(finalState.phase).toBe("completed");
		expect(finalState.done).toBe(true);
	});

	it("treats suspended runs as a terminal operator-attention state", () => {
		const state = applyEvents([
			{
				kind: "run-created",
				runId: "run-1",
				unitId: "unit-1",
				status: "pending",
				timestamp: now(),
			},
			{
				kind: "run-suspended",
				runId: "run-1",
				unitId: "unit-1",
				profileName: "requires-approval",
				reason: "Run paused pending operator approval",
				timestamp: now(),
			},
		]);

		expect(state.phase).toBe("suspended");
		expect(state.suspensionProfile).toBe("requires-approval");
		expect(state.suspensionReason).toContain("operator approval");
		expect(state.done).toBe(true);
	});

	it("returns to a running phase when a suspended run is resumed", () => {
		const state = applyEvents([
			{
				kind: "run-created",
				runId: "run-1",
				unitId: "unit-1",
				status: "pending",
				timestamp: now(),
			},
			{
				kind: "run-suspended",
				runId: "run-1",
				unitId: "unit-1",
				profileName: "requires-approval",
				reason: "Run paused pending operator approval",
				timestamp: now(),
			},
			{
				kind: "run-resumed",
				runId: "run-1",
				unitId: "unit-1",
				approvedBy: "operator",
				timestamp: now(),
			},
		]);

		expect(state.phase).toBe("running");
		expect(state.suspensionProfile).toBeNull();
		expect(state.suspensionReason).toBeNull();
		expect(state.done).toBe(false);
	});

	it("keeps a graph failure visible after later child completions", () => {
		const state = applyEvents([
			{
				kind: "graph-started",
				runId: "strategy-parent",
				graphId: "strategy-graph-1",
				unitCount: 2,
				timestamp: now(),
			},
			{
				kind: "run-completed",
				runId: "child-run-1",
				unitId: "implementer",
				status: "failed",
				timestamp: now(),
			},
			{
				kind: "run-completed",
				runId: "child-run-2",
				unitId: "reviewer",
				status: "passed",
				timestamp: now(),
			},
		]);

		expect(state.graphActive).toBe(true);
		expect(state.phase).toBe("failed");
		expect(state.done).toBe(false);
	});

	it("keeps graph failure sticky across later non-terminal events", () => {
		const state = applyEvents([
			{
				kind: "graph-started",
				runId: "strategy-parent",
				graphId: "strategy-graph-1",
				unitCount: 2,
				timestamp: now(),
			},
			{
				kind: "run-completed",
				runId: "child-run-1",
				unitId: "implementer",
				status: "failed",
				timestamp: now(),
			},
			{
				kind: "evidence-recorded",
				runId: "child-run-2",
				evidenceKind: "command-exit",
				status: "pass",
				timestamp: now(),
			},
		]);

		expect(state.graphActive).toBe(true);
		expect(state.phase).toBe("failed");
		expect(state.done).toBe(false);
	});

	it("keeps graph-backed suspended children live until graph completion", () => {
		const state = applyEvents([
			{
				kind: "graph-started",
				runId: "strategy-parent",
				graphId: "strategy-graph-1",
				unitCount: 2,
				timestamp: now(),
			},
			{
				kind: "run-suspended",
				runId: "child-run-1",
				unitId: "implementer",
				profileName: "requires-approval",
				reason: "Run paused pending operator approval",
				timestamp: now(),
			},
		]);

		expect(state.graphActive).toBe(true);
		expect(state.phase).toBe("suspended");
		expect(state.done).toBe(false);
	});

	it("keeps graph suspension visible across later sibling events", () => {
		const state = applyEvents([
			{
				kind: "graph-started",
				runId: "strategy-parent",
				graphId: "strategy-graph-1",
				unitCount: 2,
				timestamp: now(),
			},
			{
				kind: "run-suspended",
				runId: "child-run-1",
				unitId: "implementer",
				profileName: "requires-approval",
				reason: "Run paused pending operator approval",
				timestamp: now(),
			},
			{
				kind: "run-completed",
				runId: "child-run-2",
				unitId: "reviewer",
				status: "passed",
				timestamp: now(),
			},
		]);

		expect(state.graphActive).toBe(true);
		expect(state.phase).toBe("suspended");
		expect(state.suspensionReason).toContain("operator approval");
		expect(state.done).toBe(false);
	});

	it("keeps graph failure visible even if a later child suspends", () => {
		const state = applyEvents([
			{
				kind: "graph-started",
				runId: "strategy-parent",
				graphId: "strategy-graph-1",
				unitCount: 2,
				timestamp: now(),
			},
			{
				kind: "run-completed",
				runId: "child-run-1",
				unitId: "implementer",
				status: "failed",
				timestamp: now(),
			},
			{
				kind: "run-suspended",
				runId: "child-run-2",
				unitId: "reviewer",
				profileName: "requires-approval",
				reason: "Run paused pending operator approval",
				timestamp: now(),
			},
		]);

		expect(state.graphActive).toBe(true);
		expect(state.phase).toBe("failed");
		expect(state.done).toBe(false);
	});

	it("records budget breach alerts and policy reasons", () => {
		const state = applyEvents([
			{
				kind: "policy-budget-breached",
				runId: "run-1",
				budgetType: "tokens",
				limit: 1000,
				actual: 1250,
				timestamp: now(),
			},
			{
				kind: "policy-decision",
				runId: "run-1",
				decisionKind: "reject-run",
				outcome: "rejected",
				reasons: ["token budget exceeded", "operator review required"],
				timestamp: now(),
			},
		]);

		expect(state.budgetAlert).toEqual({
			budgetType: "tokens",
			limit: 1000,
			actual: 1250,
		});
		expect(state.policyReasons).toEqual([
			"token budget exceeded",
			"operator review required",
		]);
	});

	it("captures optional event context metadata when present", () => {
		const state = applyEvents([
			{
				kind: "run-created",
				runId: "run-1",
				unitId: "reviewer",
				status: "pending",
				timestamp: now(),
				context: {
					runId: "run-1",
					parentRunId: "parent-1",
					strategyId: "strategy-1",
					role: "reviewer",
					executor: "codex",
					provider: "openai",
					model: "gpt-5.4",
					cost: {
						inputTokens: 120,
						outputTokens: 45,
						estimatedUsd: 0.12,
					},
				},
			},
		]);

		expect(state.strategyId).toBe("strategy-1");
		expect(state.parentRunId).toBe("parent-1");
		expect(state.role).toBe("reviewer");
		expect(state.provider).toBe("openai");
		expect(state.model).toBe("gpt-5.4");
		expect(state.estimatedUsd).toBe(0.12);
	});
});
