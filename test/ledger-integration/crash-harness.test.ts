import { describe, expect, it } from "vitest";
import {
	assertPlanForgeCrashBoundary,
	bootFreshReadOnlyTapeProbe,
	createPlanForgeCrashTape,
	PLANFORGE_CRASH_BOUNDARIES,
} from "./crash-harness.js";

describe("M2-S7 PlanForge crash-injection harness", () => {
	it("defines the three named S7 crash boundaries in stable order", () => {
		expect(PLANFORGE_CRASH_BOUNDARIES).toEqual([
			"admit-before-execute",
			"after-activity-completed",
			"execute-before-receipt",
		]);
	});

	it.each(PLANFORGE_CRASH_BOUNDARIES)(
		"builds a signed crash-point tape and fresh read-only probe for %s",
		async (boundary) => {
			const tape = await createPlanForgeCrashTape({ boundary });
			try {
				const state = await bootFreshReadOnlyTapeProbe({
					eventsDbPath: tape.eventsDbPath,
					runId: tape.runId,
				});

				expect(state.eventsDbPath).toBe(tape.eventsDbPath);
				expect(state.runId).toBe(tape.runId);
				expect(state.events.map((event) => event.kind)).toEqual(
					tape.expectedKinds,
				);
				expect(state.signatureCount).toBe(state.events.length);
				expect(state.receiptCount).toBe(0);
				expect(state.completedActivityResults).toEqual(
					tape.expectedCompletedActivityResults,
				);
				assertPlanForgeCrashBoundary(state, boundary);
			} finally {
				await tape.cleanup();
			}
		},
		30_000,
	);

	it("fails closed when a read-only tape state is checked against the wrong boundary", async () => {
		const tape = await createPlanForgeCrashTape({
			boundary: "admit-before-execute",
		});
		try {
			const state = await bootFreshReadOnlyTapeProbe({
				eventsDbPath: tape.eventsDbPath,
				runId: tape.runId,
			});

			expect(() =>
				assertPlanForgeCrashBoundary(state, "execute-before-receipt"),
			).toThrow(/expected execute-before-receipt/i);
		} finally {
			await tape.cleanup();
		}
	});
});
