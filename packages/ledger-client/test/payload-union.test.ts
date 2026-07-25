import { describe, expect, it } from "vitest";
import type { GovernedDispatchV5AdmissionRecordedV1 } from "../src/generated/index.js";
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

describe("governed_dispatch_v5_admission_recorded_v1 envelope variant", () => {
	it("is assignable to the Payload union as a protected-host receipt", () => {
		const receipt: GovernedDispatchV5AdmissionRecordedV1 = {
			run_id: "01919000-0000-7000-8000-0000000000ff",
			source_dispatch_event_ref: "01919000-0000-7000-8000-000000000071",
			source_dispatch_event_digest: `sha256:${"a".repeat(64)}`,
			dispatch_envelope_digest: `sha256:${"b".repeat(64)}`,
			witness_evidence_digest: `sha256:${"c".repeat(64)}`,
			semantic_identity_digest: `sha256:${"d".repeat(64)}`,
			idempotency_key: "v5-admission:unit-1:attempt-1",
			ledger_authority_realm_digest: `sha256:${"e".repeat(64)}`,
			admitted_at: "2026-07-25T00:00:00Z",
		};
		const payload: Payload = {
			GovernedDispatchV5AdmissionRecordedV1: receipt,
		};
		if ("GovernedDispatchV5AdmissionRecordedV1" in payload) {
			expect(
				payload.GovernedDispatchV5AdmissionRecordedV1.source_dispatch_event_ref,
			).toBe(receipt.source_dispatch_event_ref);
		}
	});
});
