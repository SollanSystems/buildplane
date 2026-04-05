import { describe, expect, it } from "vitest";
import type {
	ArtifactRecord,
	DecisionRecord,
	EvidenceRecord,
} from "../src/contracts";

describe("storage contract exports", () => {
	it("defines persisted record shapes", () => {
		const artifact: ArtifactRecord = {
			id: "artifact-1",
			runId: "run-1",
			type: "summary",
			location: ".buildplane/artifacts/summary.md",
		};

		const evidence: EvidenceRecord = {
			id: "evidence-1",
			runId: "run-1",
			kind: "command-exit",
			status: "pass",
			message: "command exited with code 1",
		};
		const evidenceWithoutMessage: EvidenceRecord = {
			id: "evidence-2",
			runId: "run-1",
			kind: "output-check",
			status: "fail",
		};

		const decision: DecisionRecord = {
			id: "decision-1",
			runId: "run-1",
			kind: "advance-unit",
			outcome: "approved",
		};

		expect([
			artifact.runId,
			evidence.runId,
			evidence.message,
			evidenceWithoutMessage.runId,
			decision.runId,
		]).toEqual([
			"run-1",
			"run-1",
			"command exited with code 1",
			"run-1",
			"run-1",
		]);
	});
});
