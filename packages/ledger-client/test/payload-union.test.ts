import { describe, expect, it } from "vitest";
import type { Payload } from "../src/payload.js";

describe("operator_decision_recorded envelope variant", () => {
	it("is assignable to the Payload union with subject=authorize-envelope", () => {
		const p: Payload = {
			OperatorDecisionRecordedV1: {
				run_id: "pf-envelope-fixture",
				decision: "approved",
				subject: "authorize-envelope",
				envelope:
					'{"allowed_side_effects":["code-edit"],"envelope_version":"v0","expires_at":"2026-07-01T00:00:00Z","max_iterations":8,"milestone":"M5","path_globs":["src/**"],"token_budget":4000000}',
				decided_by: "operator:khall",
				decided_at: "2026-06-22T00:00:00Z",
			},
		};
		if ("OperatorDecisionRecordedV1" in p) {
			expect(p.OperatorDecisionRecordedV1.subject).toBe("authorize-envelope");
		}
	});
});
