import { describe, expect, it } from "vitest";
import { EventKind, type ResultReadyV1 } from "../src/generated/index.js";
import type { Payload } from "../src/payload.js";

// Guards step 8 of the derivation (M6-S6): the hand-edited `Payload` union in
// payload.ts must include the new `result_ready` variant. This is not
// compiler-guaranteed against the Rust source, so an explicit assignability +
// narrowing test pins it.
describe("result_ready payload", () => {
	it("parses through the hand-edited Payload union", () => {
		const ready: ResultReadyV1 = {
			run_id: "01919000-0000-7000-8000-0000000000ff",
			admission_event_id: "01919000-0000-7000-8000-000000000004",
			acceptance_event_id: "01919000-0000-7000-8000-000000000005",
		};
		const payload: Payload = { ResultReadyV1: ready };

		expect("ResultReadyV1" in payload).toBe(true);
		if ("ResultReadyV1" in payload) {
			expect(payload.ResultReadyV1.run_id).toBe(
				"01919000-0000-7000-8000-0000000000ff",
			);
			expect(payload.ResultReadyV1.admission_event_id).toBe(
				"01919000-0000-7000-8000-000000000004",
			);
			expect(payload.ResultReadyV1.acceptance_event_id).toBe(
				"01919000-0000-7000-8000-000000000005",
			);
		}
	});

	it("exposes the wire kind on the EventKind enum", () => {
		expect(EventKind.ResultReady).toBe("result_ready");
	});
});
