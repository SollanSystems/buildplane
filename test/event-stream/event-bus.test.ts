import { describe, expect, it } from "vitest";
import {
	createEventBus,
	type ExecutionEvent,
	type RunCompletedEvent,
	type RunCreatedEvent,
} from "../../packages/kernel/src/events";

function makeRunCreated(runId: string): RunCreatedEvent {
	return {
		kind: "run-created",
		runId,
		unitId: "unit-test",
		status: "pending",
		timestamp: new Date().toISOString(),
	};
}

function makeRunCompleted(
	runId: string,
	status: "passed" | "failed" = "passed",
): RunCompletedEvent {
	return {
		kind: "run-completed",
		runId,
		unitId: "unit-test",
		status,
		timestamp: new Date().toISOString(),
	};
}

describe("EventBus", () => {
	it("emits events to subscribers", () => {
		const bus = createEventBus();
		const received: ExecutionEvent[] = [];
		bus.subscribe((event) => received.push(event));

		const event = makeRunCreated("run-1");
		bus.emit(event);

		expect(received).toHaveLength(1);
		expect(received[0]).toBe(event);
	});

	it("delivers events to multiple subscribers", () => {
		const bus = createEventBus();
		const a: ExecutionEvent[] = [];
		const b: ExecutionEvent[] = [];
		bus.subscribe((e) => a.push(e));
		bus.subscribe((e) => b.push(e));

		const event = makeRunCreated("run-1");
		bus.emit(event);

		expect(a).toHaveLength(1);
		expect(b).toHaveLength(1);
		expect(a[0]).toBe(event);
		expect(b[0]).toBe(event);
	});

	it("unsubscribe stops delivery", () => {
		const bus = createEventBus();
		const received: ExecutionEvent[] = [];
		const unsub = bus.subscribe((e) => received.push(e));

		bus.emit(makeRunCreated("run-1"));
		expect(received).toHaveLength(1);

		unsub();

		bus.emit(makeRunCompleted("run-1"));
		expect(received).toHaveLength(1); // no new event
	});

	it("unsubscribe does not affect other subscribers", () => {
		const bus = createEventBus();
		const a: ExecutionEvent[] = [];
		const b: ExecutionEvent[] = [];
		const unsubA = bus.subscribe((e) => a.push(e));
		bus.subscribe((e) => b.push(e));

		bus.emit(makeRunCreated("run-1"));
		unsubA();
		bus.emit(makeRunCompleted("run-1"));

		expect(a).toHaveLength(1);
		expect(b).toHaveLength(2);
	});

	it("emits nothing when no subscribers", () => {
		const bus = createEventBus();
		// Should not throw
		bus.emit(makeRunCreated("run-1"));
	});

	it("preserves event kind discrimination", () => {
		const bus = createEventBus();
		const received: ExecutionEvent[] = [];
		bus.subscribe((e) => received.push(e));

		bus.emit(makeRunCreated("run-1"));
		bus.emit(makeRunCompleted("run-1", "failed"));

		expect(received).toHaveLength(2);
		expect(received[0].kind).toBe("run-created");
		expect(received[1].kind).toBe("run-completed");

		// Type narrowing works
		if (received[1].kind === "run-completed") {
			expect(received[1].status).toBe("failed");
		}
	});
});
