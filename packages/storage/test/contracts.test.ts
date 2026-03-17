import { describe, expect, it } from "vitest";
import type { ArtifactRecord, EvidenceRecord, DecisionRecord } from "../src/contracts";

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
    };

    const decision: DecisionRecord = {
      id: "decision-1",
      runId: "run-1",
      kind: "advance-unit",
      outcome: "approved",
    };

    expect([artifact.runId, evidence.runId, decision.runId]).toEqual(["run-1", "run-1", "run-1"]);
  });
});
