import { describe, expect, it } from "vitest";
import type { Run, Unit } from "../src/types";

describe("kernel contract exports", () => {
	it("defines Unit and Run shapes", () => {
		const unit: Unit = {
			id: "unit-1",
			kind: "execute",
			scope: "task",
			inputRefs: [],
			expectedOutputs: [],
			verificationContract: "artifact-exists",
			policyProfile: "default",
		};

		const run: Run = {
			id: "run-1",
			unitId: unit.id,
			status: "pending",
		};

		expect(run.unitId).toBe(unit.id);
	});
});
