import {
	createInspectorProjection,
	type InspectorProjection,
} from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import type { InspectSnapshot } from "../src/run-loop.js";

const baseSnapshot: InspectSnapshot = {
	kind: "run",
	unit: {
		id: "implement-foo",
		kind: "command",
		scope: "task",
		inputRefs: [],
		expectedOutputs: [],
		verificationContract: "outputs-exist",
		policyProfile: "default",
	},
	run: { id: "run-xyz", unitId: "implement-foo", status: "passed" },
	runHistory: [{ id: "run-xyz", status: "passed" }],
	evidence: [],
	decisions: [],
	artifacts: [],
};

describe("createInspectorProjection", () => {
	it("produces a PASSED verdict when a passed run has supporting evidence", () => {
		const snapshot: InspectSnapshot = {
			...baseSnapshot,
			run: { id: "run-xyz", unitId: "implement-foo", status: "passed" },
			eventTape: {
				runId: "run-xyz",
				eventCount: 2,
				firstKind: "run_started",
				lastKind: "run_completed",
				terminalStatus: "passed",
				events: [
					{
						id: "event-1",
						kind: "run_started",
						occurredAt: "2026-05-16T00:00:00.000Z",
						summary: "run started",
					},
					{
						id: "event-2",
						kind: "run_completed",
						occurredAt: "2026-05-16T00:00:01.000Z",
						summary: "run completed",
					},
				],
			},
			evidence: [
				{
					id: "evidence-1",
					kind: "command-exit",
					status: "pass",
					message: "exit 0",
				},
			],
			decisions: [
				{
					id: "decision-1",
					kind: "advance-run",
					outcome: "approved",
					reasons: ["required output exists"],
				},
			],
			artifacts: [
				{ id: "artifact-1", type: "log", location: ".buildplane/log.txt" },
			],
		};

		const projection = createInspectorProjection(snapshot);

		expect(projection).toMatchObject({
			kind: "run-inspector",
			runId: "run-xyz",
			outcomeStrip: {
				verdict: "PASSED",
				eventCount: 2,
				evidenceCount: 1,
				decisionCount: 1,
				artifactCount: 1,
				missingEvidenceCount: 0,
			},
		});
		expect(projection.eventTimeline).toHaveLength(2);
		expect(projection.missingEvidence).toEqual([]);
		expect(projection.evidencePane.evidence).toBe(snapshot.evidence);
		expect(projection.evidencePane.decisions).toBe(snapshot.decisions);
		expect(projection.evidencePane.artifacts).toBe(snapshot.artifacts);
	});

	it("blocks a passed run that has no supporting evidence (missing event tape)", () => {
		const snapshot: InspectSnapshot = {
			...baseSnapshot,
			run: { id: "run-xyz", unitId: "implement-foo", status: "passed" },
		};

		const projection = createInspectorProjection(snapshot);

		expect(projection.outcomeStrip.verdict).toBe("BLOCKED");
		expect(projection.missingEvidence).toContain("event-tape: missing");
		expect(projection.outcomeStrip.missingEvidenceCount).toBeGreaterThan(0);
	});

	it("blocks a run when evidence is not passing", () => {
		const snapshot: InspectSnapshot = {
			...baseSnapshot,
			run: { id: "run-xyz", unitId: "implement-foo", status: "running" },
			eventTape: {
				runId: "run-xyz",
				eventCount: 1,
				lastKind: "run_started",
				events: [
					{
						id: "event-1",
						kind: "run_started",
						occurredAt: "2026-05-16T00:00:00.000Z",
						summary: "run started",
					},
				],
			},
			evidence: [
				{
					id: "evidence-1",
					kind: "verification",
					status: "failed",
					message: "pytest failed",
				},
			],
			decisions: [
				{
					id: "decision-1",
					kind: "reject-run",
					outcome: "rejected",
					reasons: ["verification failed"],
				},
			],
			artifacts: [],
		};

		const projection = createInspectorProjection(snapshot);

		expect(projection.outcomeStrip.verdict).toBe("BLOCKED");
		expect(projection.missingEvidence).toContain("verification: pytest failed");
		expect(projection.missingEvidence).toContain(
			"reject-run: verification failed",
		);
	});

	it("reports FAILED for a failed run and passes the event timeline through", () => {
		const snapshot: InspectSnapshot = {
			...baseSnapshot,
			run: { id: "run-xyz", unitId: "implement-foo", status: "failed" },
			eventTape: {
				runId: "run-xyz",
				eventCount: 1,
				firstKind: "run_started",
				lastKind: "run_failed",
				terminalStatus: "failed",
				events: [
					{
						id: "event-1",
						kind: "run_failed",
						occurredAt: "2026-05-16T00:00:01.000Z",
						summary: "failed",
					},
				],
			},
			evidence: [
				{
					id: "evidence-1",
					kind: "verification",
					status: "failed",
					message: "pytest failed",
				},
			],
			decisions: [
				{
					id: "decision-1",
					kind: "reject-run",
					outcome: "rejected",
					reasons: ["verification failed"],
				},
			],
			artifacts: [],
		};

		const projection = createInspectorProjection(snapshot);

		expect(projection.outcomeStrip.verdict).toBe("FAILED");
		expect(projection.eventTimeline).toHaveLength(1);
		expect(projection.eventTimeline[0]?.kind).toBe("run_failed");
	});

	it("exposes the InspectorProjection type with widened InspectSnapshot subtypes", () => {
		const projection: InspectorProjection =
			createInspectorProjection(baseSnapshot);
		expect(projection.provenance).toBeUndefined();
	});
});
