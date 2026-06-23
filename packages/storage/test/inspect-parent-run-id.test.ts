import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBuildplaneStorage } from "../src";

function packet(unitId: string) {
	return {
		unit: {
			id: unitId,
			kind: "planforge-task",
			scope: ".",
			inputRefs: [],
			expectedOutputs: [],
			verificationContract: "true",
			policyProfile: "default",
		},
		execution: { command: "true" },
		verification: { requiredOutputs: [] },
	} as never;
}

describe("inspectTarget parentRunId", () => {
	let root: string;
	let storage: ReturnType<typeof createBuildplaneStorage>;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "bp-parent-"));
		storage = createBuildplaneStorage(root);
		storage.initializeProject();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("threads parent_run_id from runs into the inspect snapshot run", () => {
		const parent = storage.createRun(packet("plan-parent:PF1"));
		const child = storage.createRun(packet("plan-child:PF1"), {
			parentRunId: parent.id,
		});

		const snapshot = storage.inspectTarget(child.id);
		expect(snapshot.run.parentRunId).toBe(parent.id);
	});

	it("leaves parentRunId undefined for a root run", () => {
		const root_ = storage.createRun(packet("plan-root:PF1"));
		const snapshot = storage.inspectTarget(root_.id);
		expect(snapshot.run.parentRunId).toBeUndefined();
	});
});
