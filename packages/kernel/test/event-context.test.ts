import { describe, expect, it } from "vitest";
import type { EventContext, ExecutionEvent } from "../src/events.js";
import { createEventBus, createRunScopedBus } from "../src/events.js";

describe("EventContext propagation", () => {
	function collectEvents(
		bus: ReturnType<typeof createEventBus>,
	): ExecutionEvent[] {
		const collected: ExecutionEvent[] = [];
		bus.subscribe((e) => collected.push(e));
		return collected;
	}

	it("events emitted through run-scoped bus have context populated", () => {
		const inner = createEventBus();
		const events = collectEvents(inner);

		const ctx: EventContext = {
			runId: "run-abc",
			executor: "command",
		};
		const scoped = createRunScopedBus(ctx, inner);

		scoped.emit({
			kind: "execution-started",
			runId: "run-abc",
			timestamp: new Date().toISOString(),
			executionType: "command",
		});

		expect(events).toHaveLength(1);
		expect(events[0].context).toBeDefined();
		expect(events[0].context?.runId).toBe("run-abc");
		expect(events[0].context?.executor).toBe("command");
	});

	it("parentRunId and strategyId propagate correctly when provided", () => {
		const inner = createEventBus();
		const events = collectEvents(inner);

		const ctx: EventContext = {
			runId: "run-child-1",
			executor: "claude-code",
			parentRunId: "strat-run-parent",
			strategyId: "strat-xyz",
			role: "implementer",
		};
		const scoped = createRunScopedBus(ctx, inner);

		scoped.emit({
			kind: "run-started",
			runId: "run-child-1",
			unitId: "unit-1",
			status: "running",
			timestamp: new Date().toISOString(),
		});

		const emitted = events[0];
		expect(emitted.context?.parentRunId).toBe("strat-run-parent");
		expect(emitted.context?.strategyId).toBe("strat-xyz");
		expect(emitted.context?.role).toBe("implementer");
	});

	it("events without context (legacy path) still work", () => {
		const bus = createEventBus();
		const events = collectEvents(bus);

		// Emit directly to bus without a run-scoped wrapper
		bus.emit({
			kind: "execution-started",
			runId: "run-legacy",
			timestamp: new Date().toISOString(),
			executionType: "model",
		});

		expect(events).toHaveLength(1);
		expect(events[0].context).toBeUndefined();
		expect(events[0].runId).toBe("run-legacy");
	});

	it("cost fields propagate from EventContext when provided", () => {
		const inner = createEventBus();
		const events = collectEvents(inner);

		const ctx: EventContext = {
			runId: "run-cost",
			executor: "ai-sdk",
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			cost: {
				inputTokens: 1000,
				outputTokens: 500,
				estimatedUsd: 0.0045,
			},
		};
		const scoped = createRunScopedBus(ctx, inner);

		scoped.emit({
			kind: "model-response-complete",
			runId: "run-cost",
			timestamp: new Date().toISOString(),
			text: "Done",
			finishReason: "stop",
		});

		const emitted = events[0];
		expect(emitted.context?.cost?.inputTokens).toBe(1000);
		expect(emitted.context?.cost?.outputTokens).toBe(500);
		expect(emitted.context?.cost?.estimatedUsd).toBe(0.0045);
		expect(emitted.context?.model).toBe("claude-sonnet-4-6");
		expect(emitted.context?.provider).toBe("anthropic");
	});
});
