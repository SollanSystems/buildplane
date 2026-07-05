import type { EmitOptions, TapeEmitter } from "@buildplane/ledger-client";
import { describe, expect, it, vi } from "vitest";
import { createDispatchToolUnitTracker } from "../src/dispatch-tool-unit-tracker.js";

interface Emitted {
	kind: string;
	payload: unknown;
	opts?: EmitOptions;
}

function fakeEmitter(): { emitter: TapeEmitter; emitted: Emitted[] } {
	const emitted: Emitted[] = [];
	const emitter: TapeEmitter = {
		emit: (kind, payload, opts) => {
			emitted.push({ kind, payload, opts });
		},
		flush: vi.fn(async () => {}),
		close: vi.fn(async () => {}),
		onFailure: vi.fn(),
		stats: vi.fn(() => ({
			eventsEmitted: emitted.length,
			lastAckedEventId: null,
			queueDepth: 0,
		})),
	};
	return { emitter, emitted };
}

describe("createDispatchToolUnitTracker", () => {
	it("returns null unit ctx before any activity_started", () => {
		const tracker = createDispatchToolUnitTracker();
		expect(tracker.getUnitCtx()).toBeNull();
		tracker.beginUnit("u-1");
		// Unit set but no activity started yet → still null (parent id unknown).
		expect(tracker.getUnitCtx()).toBeNull();
	});

	it("captures the activity_started event id as the parent and stamps the pending unit id", () => {
		const tracker = createDispatchToolUnitTracker();
		const { emitter, emitted } = fakeEmitter();
		const observed = tracker.observe(emitter);

		tracker.beginUnit("pf-plan:PF1");
		observed.emit("activity_started", { ActivityStartedV1: {} });

		expect(emitted).toHaveLength(1);
		const startedId = emitted[0].opts?.id;
		expect(startedId).toBeDefined();

		const ctx = tracker.getUnitCtx();
		expect(ctx).toEqual({ unitId: "pf-plan:PF1", parentEventId: startedId });
	});

	it("preserves an explicit activity_started id when the caller supplies one", () => {
		const tracker = createDispatchToolUnitTracker();
		const { emitter, emitted } = fakeEmitter();
		const observed = tracker.observe(emitter);

		tracker.beginUnit("u-1");
		observed.emit(
			"activity_started",
			{ ActivityStartedV1: {} },
			{ id: "fixed-id", parent: "root" },
		);

		expect(emitted[0].opts).toEqual({ id: "fixed-id", parent: "root" });
		expect(tracker.getUnitCtx()).toEqual({
			unitId: "u-1",
			parentEventId: "fixed-id",
		});
	});

	it("clears the active ctx on activity_completed", () => {
		const tracker = createDispatchToolUnitTracker();
		const { emitter } = fakeEmitter();
		const observed = tracker.observe(emitter);

		tracker.beginUnit("u-1");
		observed.emit("activity_started", { ActivityStartedV1: {} });
		expect(tracker.getUnitCtx()).not.toBeNull();

		observed.emit("activity_completed", { ActivityCompletedV1: {} });
		expect(tracker.getUnitCtx()).toBeNull();
	});

	it("re-points the ctx across sequential units to the latest activity", () => {
		const tracker = createDispatchToolUnitTracker();
		const { emitter, emitted } = fakeEmitter();
		const observed = tracker.observe(emitter);

		tracker.beginUnit("u-1");
		observed.emit("activity_started", { ActivityStartedV1: {} });
		const id1 = emitted[0].opts?.id;
		observed.emit("activity_completed", { ActivityCompletedV1: {} });

		tracker.beginUnit("u-2");
		observed.emit("activity_started", { ActivityStartedV1: {} });
		const id2 = emitted[2].opts?.id;

		expect(id1).not.toBe(id2);
		expect(tracker.getUnitCtx()).toEqual({
			unitId: "u-2",
			parentEventId: id2,
		});
	});

	it("delegates non-activity emits and lifecycle methods unchanged", async () => {
		const tracker = createDispatchToolUnitTracker();
		const { emitter, emitted } = fakeEmitter();
		const observed = tracker.observe(emitter);

		observed.emit("tool_request", { ToolRequestStoredV1: {} }, { id: "t1" });
		expect(emitted).toEqual([
			{
				kind: "tool_request",
				payload: { ToolRequestStoredV1: {} },
				opts: { id: "t1" },
			},
		]);

		await observed.flush();
		expect(emitter.flush).toHaveBeenCalledTimes(1);
		await observed.close();
		expect(emitter.close).toHaveBeenCalledTimes(1);
		observed.stats();
		expect(emitter.stats).toHaveBeenCalledTimes(1);
		const cb = () => {};
		observed.onFailure(cb);
		expect(emitter.onFailure).toHaveBeenCalledWith(cb);
	});
});
