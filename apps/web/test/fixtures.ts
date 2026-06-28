import type { InspectorProjection } from "../src/types";

/**
 * A passing run projection. `outcomeStrip.verdict` is "PASSED" and is the source
 * of truth the UI must render verbatim — the UI never recomputes a verdict.
 */
export function makeProjection(
	overrides: Partial<InspectorProjection> = {},
): InspectorProjection {
	return {
		kind: "run-inspector",
		runId: "run-1",
		outcomeStrip: {
			verdict: "PASSED",
			runStatus: "passed",
			terminalEventKind: "plan_receipt",
			eventCount: 3,
			evidenceCount: 2,
			decisionCount: 1,
			artifactCount: 1,
			missingEvidenceCount: 0,
		},
		eventTimeline: [
			{
				id: "e1",
				kind: "plan_admitted",
				occurredAt: "2026-06-28T00:00:00.000Z",
				summary: "plan admitted",
			},
			{
				id: "e2",
				kind: "activity_started",
				occurredAt: "2026-06-28T00:01:00.000Z",
				summary: "activity started",
				metadata: { unit: "u1" },
			},
			{
				id: "e3",
				kind: "plan_receipt",
				occurredAt: "2026-06-28T00:02:00.000Z",
				summary: "receipt emitted",
			},
		],
		evidencePane: {
			evidence: [
				{ id: "ev1", kind: "ci", status: "passed", message: "all green" },
				{ id: "ev2", kind: "lint", status: "passed" },
			],
			decisions: [
				{
					id: "d1",
					kind: "acceptance.contract",
					outcome: "approved",
					reasons: ["diff in scope", "ci passed"],
				},
			],
			artifacts: [
				{
					id: "a1",
					type: "diff",
					location: ".buildplane/runs/run-1/diff.patch",
				},
			],
		},
		missingEvidence: [],
		...overrides,
	};
}

/**
 * A blocked run projection: `runStatus` is "suspended" but the kernel-computed
 * `verdict` is "BLOCKED" with non-empty `missingEvidence`. A UI that recomputed
 * a verdict from `runStatus` would not produce "BLOCKED" — so asserting the
 * rendered verdict is "BLOCKED" proves the UI reuses the projection verbatim.
 */
export function makeBlockedProjection(): InspectorProjection {
	return makeProjection({
		runId: "run-blocked",
		outcomeStrip: {
			verdict: "BLOCKED",
			runStatus: "suspended",
			eventCount: 2,
			evidenceCount: 0,
			decisionCount: 1,
			artifactCount: 0,
			missingEvidenceCount: 2,
			failure: {
				kind: "acceptance_blocked",
				message: "missing required evidence",
			},
		},
		evidencePane: {
			evidence: [],
			decisions: [
				{
					id: "d1",
					kind: "acceptance.contract",
					outcome: "rejected",
					reasons: ["missing evidence: ci", "missing evidence: lint"],
				},
			],
			artifacts: [],
		},
		// NOTE: real kernel `missingEvidence` entries are formatted "<kind>: <status|message>"
		// (e.g. "ci: failed") by createMissingEvidence; these bare ids are a fixture shorthand,
		// not the projection's real output shape.
		missingEvidence: ["ci", "lint"],
	});
}
