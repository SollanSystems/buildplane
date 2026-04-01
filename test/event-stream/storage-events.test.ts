import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutionEvent } from "../../packages/kernel/src/events";
import { createEventStore } from "../../packages/storage/src/event-store";
import { createBuildplaneStorage } from "../../packages/storage/src/index";

function initProject(): string {
	const root = mkdtempSync(join(tmpdir(), "bp-events-"));
	const storage = createBuildplaneStorage(root);
	storage.initializeProject();
	return root;
}

function makeEvent(
	kind: string,
	runId: string,
	extra: Record<string, unknown> = {},
): ExecutionEvent {
	return {
		kind,
		runId,
		timestamp: new Date().toISOString(),
		...extra,
	} as ExecutionEvent;
}

describe("event store", () => {
	it("persists and retrieves events by runId", () => {
		const root = initProject();
		const store = createEventStore(root);

		const events: ExecutionEvent[] = [
			makeEvent("run-created", "run-1", {
				unitId: "unit-1",
				status: "pending",
			}),
			makeEvent("run-started", "run-1", {
				unitId: "unit-1",
				status: "running",
			}),
			makeEvent("execution-started", "run-1", { executionType: "command" }),
			makeEvent("run-completed", "run-1", {
				unitId: "unit-1",
				status: "passed",
			}),
		];

		for (const event of events) {
			store.persistEvent("run-1", event);
		}

		const retrieved = store.getEventsByRunId("run-1");

		expect(retrieved).toHaveLength(4);
		expect(retrieved.map((e) => e.kind)).toEqual([
			"run-created",
			"run-started",
			"execution-started",
			"run-completed",
		]);

		// Verify typed fields survived round-trip
		const first = retrieved[0];
		if (first.kind === "run-created") {
			expect(first.runId).toBe("run-1");
			expect(first.unitId).toBe("unit-1");
			expect(first.status).toBe("pending");
		}
	});

	it("filters events by kind", () => {
		const root = initProject();
		const store = createEventStore(root);

		store.persistEvent(
			"run-2",
			makeEvent("run-created", "run-2", { unitId: "u", status: "pending" }),
		);
		store.persistEvent(
			"run-2",
			makeEvent("model-token-delta", "run-2", { delta: "hello" }),
		);
		store.persistEvent(
			"run-2",
			makeEvent("model-token-delta", "run-2", { delta: " world" }),
		);
		store.persistEvent(
			"run-2",
			makeEvent("run-completed", "run-2", { unitId: "u", status: "passed" }),
		);

		const deltas = store.getEventsByRunIdAndKind("run-2", "model-token-delta");
		expect(deltas).toHaveLength(2);
		expect(deltas.every((e) => e.kind === "model-token-delta")).toBe(true);
	});

	it("returns empty array for unknown runId", () => {
		const root = initProject();
		const store = createEventStore(root);

		const events = store.getEventsByRunId("nonexistent");
		expect(events).toEqual([]);
	});

	it("isolates events between runs", () => {
		const root = initProject();
		const store = createEventStore(root);

		store.persistEvent(
			"run-a",
			makeEvent("run-created", "run-a", { unitId: "u", status: "pending" }),
		);
		store.persistEvent(
			"run-b",
			makeEvent("run-created", "run-b", { unitId: "u", status: "pending" }),
		);

		const eventsA = store.getEventsByRunId("run-a");
		const eventsB = store.getEventsByRunId("run-b");

		expect(eventsA).toHaveLength(1);
		expect(eventsB).toHaveLength(1);
		expect(eventsA[0].runId).toBe("run-a");
		expect(eventsB[0].runId).toBe("run-b");
	});
});
