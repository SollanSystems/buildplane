import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionEvent } from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import { createBuildplaneStorage, createEventStore } from "../src";

function seedEvent(
	root: string,
	runId: string,
	overrides: Partial<ExecutionEvent> & { timestamp: string },
): void {
	const eventStore = createEventStore(root);
	eventStore.persistEvent(runId, {
		kind: "run-created",
		runId,
		unitId: "unit-1",
		status: "pending",
		...overrides,
	} as ExecutionEvent);
}

describe("BuildplaneStoragePort.listEvents", () => {
	it("returns the events recorded for a run in chronological order", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-events-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		seedEvent(root, "run-a", {
			kind: "run-created",
			timestamp: "2026-03-17T00:00:00.000Z",
		});
		seedEvent(root, "run-a", {
			kind: "run-started",
			timestamp: "2026-03-17T00:00:01.000Z",
		});
		seedEvent(root, "run-b", {
			kind: "run-created",
			timestamp: "2026-03-17T00:00:02.000Z",
		});

		const events = storage.listEvents({ runId: "run-a" });

		expect(events.map((e) => e.kind)).toEqual(["run-created", "run-started"]);
		expect(events.every((e) => e.runId === "run-a")).toBe(true);
	});

	it("returns an empty list for a run with no events", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-events-empty-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		expect(storage.listEvents({ runId: "missing" })).toEqual([]);
	});

	it("caps the result to the most recent N events when limit is provided", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-events-limit-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		for (let i = 0; i < 5; i++) {
			seedEvent(root, "run-a", {
				kind: "model-token-delta",
				timestamp: `2026-03-17T00:00:0${i}.000Z`,
			});
		}

		const limited = storage.listEvents({ runId: "run-a", limit: 2 });

		expect(limited).toHaveLength(2);
		expect(limited.map((e) => e.timestamp)).toEqual([
			"2026-03-17T00:00:03.000Z",
			"2026-03-17T00:00:04.000Z",
		]);
	});
});
