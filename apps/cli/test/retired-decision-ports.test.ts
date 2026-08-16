import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OperatorDecisionSurfaceRetiredError } from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import {
	createRetiredOperatorDecisionPort,
	createRetiredRunCompletionPort,
	RETIRED_OPERATOR_DECISION_SURFACE_REASON,
} from "../src/retired-decision-ports.js";

const runCliSource = readFileSync(
	resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "run-cli.ts"),
	"utf8",
);

describe("retired operator-decision ports", () => {
	it("states one reason that names the decision, the refused kinds, and the matrix", () => {
		expect(RETIRED_OPERATOR_DECISION_SURFACE_REASON).toContain("2026-08-15");
		expect(RETIRED_OPERATOR_DECISION_SURFACE_REASON).toContain(
			"operator_decision_recorded",
		);
		expect(RETIRED_OPERATOR_DECISION_SURFACE_REASON).toContain("run_completed");
		expect(RETIRED_OPERATOR_DECISION_SURFACE_REASON).toContain(
			"docs/operations/trust-spine-compatibility-matrix.md",
		);
	});

	it("marks both ports retired with that single shared reason", () => {
		expect(createRetiredOperatorDecisionPort().retired).toEqual({
			reason: RETIRED_OPERATOR_DECISION_SURFACE_REASON,
		});
		expect(createRetiredRunCompletionPort().retired).toEqual({
			reason: RETIRED_OPERATOR_DECISION_SURFACE_REASON,
		});
	});

	// Defense in depth: the orchestrator refuses on the `retired` marker long
	// before either method runs, so reaching one at all means the guard was
	// bypassed. Neither may then quietly succeed.
	it("throws the retirement error from both record methods", async () => {
		await expect(
			createRetiredOperatorDecisionPort().recordDecision({
				runId: "run-1",
				decision: "approved",
				subject: "merge",
				decidedBy: "web-operator",
				decidedAt: "2026-08-15T00:00:00Z",
			}),
		).rejects.toBeInstanceOf(OperatorDecisionSurfaceRetiredError);

		await expect(
			createRetiredRunCompletionPort().recordRunCompleted({
				runId: "run-1",
				outcome: "failed",
				durationMs: "1",
				eventCount: "1",
				unitCount: "1",
			}),
		).rejects.toThrow(RETIRED_OPERATOR_DECISION_SURFACE_REASON);
	});
});

// `loadCliOrchestrator` is module-private, so its default wiring is pinned at
// the source level. This is what makes the retirement real for `bp web`: the
// shipped default must be the retired port, while an explicit `opts` injection
// (the seam every dispatch/e2e test uses) must still win.
describe("run-cli default port wiring", () => {
	it("defaults both operator-decision-path ports to the retired ports", () => {
		expect(runCliSource).toContain(
			"opts?.operatorDecisionPort ?? createRetiredOperatorDecisionPort()",
		);
		expect(runCliSource).toContain(
			"opts?.runCompletionPort ?? createRetiredRunCompletionPort()",
		);
	});

	it("no longer default-wires the signed ledger writers the protocol refuses", () => {
		expect(runCliSource).not.toContain("createOperatorDecisionPort(");
		expect(runCliSource).not.toContain("createRunCompletionPort(");
	});
});
