import { describe, expect, it, vi } from "vitest";
import { createRunScopedBus } from "../src/run-scoped-bus.js";
import type { EventBus, ExecutionEvent } from "../src/events.js";

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

	it("injects runId into emitted events", () => {
		const inner = createCollectorBus();
		const scoped = createRunScopedBus("run-123", inner);
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
		const scoped = createRunScopedBus("run-456", inner);
		scoped.emit({
			kind: "execution-started",
			runId: "wrong-id",
			timestamp: new Date().toISOString(),
			executionType: "command",
		});
		expect(inner.emitted[0].runId).toBe("run-456");
	});

	it("delegates subscribe to inner bus", () => {
		const inner = createCollectorBus();
		const subscribeSpy = vi.spyOn(inner, "subscribe");
		const scoped = createRunScopedBus("run-789", inner);
		const listener = vi.fn();
		scoped.subscribe(listener);
		expect(subscribeSpy).toHaveBeenCalledWith(listener);
	});
});
