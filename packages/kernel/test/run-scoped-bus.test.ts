import { describe, expect, it, vi } from "vitest";
import type { EventBus, EventContext, ExecutionEvent } from "../src/events.js";
import { createRunScopedBus } from "../src/run-scoped-bus.js";

describe("createRunScopedBus", () => {
	function createCollectorBus(): EventBus & { emitted: ExecutionEvent[] } {
		const emitted: ExecutionEvent[] = [];
		return {
			emitted,
			emit(event: ExecutionEvent) {
				emitted.push(event);
			},
			subscribe() {
				return () => {};
			},
		};
	}

	function makeContext(overrides: Partial<EventContext> = {}): EventContext {
		return { runId: "run-123", executor: "command", ...overrides };
	}

	it("injects runId into emitted events", () => {
		const inner = createCollectorBus();
		const scoped = createRunScopedBus(makeContext({ runId: "run-123" }), inner);
		scoped.emit({
			kind: "execution-started",
			runId: "",
			timestamp: new Date().toISOString(),
			executionType: "model",
		});
		expect(inner.emitted).toHaveLength(1);
		expect(inner.emitted[0].runId).toBe("run-123");
	});

	it("overwrites any existing runId", () => {
		const inner = createCollectorBus();
		const scoped = createRunScopedBus(makeContext({ runId: "run-456" }), inner);
		scoped.emit({
			kind: "execution-started",
			runId: "wrong-id",
			timestamp: new Date().toISOString(),
			executionType: "command",
		});
		expect(inner.emitted[0].runId).toBe("run-456");
	});

	it("injects full context into emitted events", () => {
		const inner = createCollectorBus();
		const ctx: EventContext = {
			runId: "run-789",
			executor: "claude-code",
			parentRunId: "strat-001",
			strategyId: "strat-001",
			role: "implementer",
			model: "claude-sonnet-4-6",
		};
		const scoped = createRunScopedBus(ctx, inner);
		scoped.emit({
			kind: "execution-started",
			runId: "",
			timestamp: new Date().toISOString(),
			executionType: "model",
		});
		expect(inner.emitted[0].context).toEqual(ctx);
		expect(inner.emitted[0].context?.role).toBe("implementer");
		expect(inner.emitted[0].context?.strategyId).toBe("strat-001");
	});

	it("delegates subscribe to inner bus", () => {
		const inner = createCollectorBus();
		const subscribeSpy = vi.spyOn(inner, "subscribe");
		const scoped = createRunScopedBus(makeContext({ runId: "run-789" }), inner);
		const listener = vi.fn();
		scoped.subscribe(listener);
		expect(subscribeSpy).toHaveBeenCalledWith(listener);
	});
});
