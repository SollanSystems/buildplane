import { describe, expect, it } from "vitest";
import {
	EventKind,
	type OperatorDecisionRecordedV1,
} from "../src/generated/index.js";
import type { Payload } from "../src/payload.js";

// Guards step 8 of the derivation: the hand-edited `Payload` union in
// payload.ts must include the new variant. This is not compiler-guaranteed
// against the Rust source, so an explicit assignability + narrowing test pins it.
describe("operator_decision_recorded payload", () => {
	it("parses through the hand-edited Payload union", () => {
		const decision: OperatorDecisionRecordedV1 = {
			run_id: "01919000-0000-7000-8000-0000000000ff",
			decision: "approved",
			subject: "merge",
			acceptance_event_id: "01919000-0000-7000-8000-000000000005",
			admission_event_id: "01919000-0000-7000-8000-000000000004",
			merge_commit: "deadbeef",
			decided_by: "operator@buildplane",
			decided_at: "2026-06-22T12:00:00Z",
		};
		const payload: Payload = { OperatorDecisionRecordedV1: decision };

		expect("OperatorDecisionRecordedV1" in payload).toBe(true);
		if ("OperatorDecisionRecordedV1" in payload) {
			expect(payload.OperatorDecisionRecordedV1.decision).toBe("approved");
			expect(payload.OperatorDecisionRecordedV1.subject).toBe("merge");
		}
	});

	it("exposes the wire kind on the EventKind enum", () => {
		expect(EventKind.OperatorDecisionRecorded).toBe(
			"operator_decision_recorded",
		);
	});
});
