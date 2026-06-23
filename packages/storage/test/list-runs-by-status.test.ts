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

describe("listRunsByStatus", () => {
	let root: string;
	let storage: ReturnType<typeof createBuildplaneStorage>;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "bp-lrbs-"));
		storage = createBuildplaneStorage(root);
		storage.initializeProject();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns only runs in the requested status, oldest first", () => {
		const a = storage.createRun(packet("plan-a:PF1"));
		const b = storage.createRun(packet("plan-b:PF1"));
		storage.markRunRunning(a.id);
		storage.markRunRunning(b.id);
		storage.completeRun(b.id, "passed");

		const running = storage.listRunsByStatus("running");
		expect(running.map((r) => r.id)).toEqual([a.id]);
		expect(running[0]).toMatchObject({
			unitId: "plan-a:PF1",
			status: "running",
		});

		expect(storage.listRunsByStatus("passed").map((r) => r.id)).toEqual([b.id]);
		expect(storage.listRunsByStatus("pending")).toEqual([]);
	});
});
