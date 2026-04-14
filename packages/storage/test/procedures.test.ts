import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBuildplaneStorage } from "../src";

describe("procedure storage", () => {
	it("stores and lists procedures for the current repo", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-procedures-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const procedure = storage.createProcedure({
			name: "fix TypeScript build",
			taskType: "debug_failure",
			bodyMarkdown: "1. Run typecheck\n2. Fix import path\n3. Re-run tests",
			createdBy: "worker",
			confidence: 0.88,
		});

		const procedures = storage.listProcedures();

		expect(procedure.memoryType).toBe("procedure");
		expect(procedure.name).toBe("fix TypeScript build");
		expect(procedure.provenance.repoId).toBe(root);
		expect(procedures).toHaveLength(1);
		expect(procedures[0]?.taskType).toBe("debug_failure");
	});

	it("finds procedures by task type", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-procedures-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		storage.createProcedure({
			name: "fix TypeScript build",
			taskType: "debug_failure",
			bodyMarkdown: "debug steps",
			createdBy: "worker",
		});
		storage.createProcedure({
			name: "review risky diff",
			taskType: "review_change",
			bodyMarkdown: "review steps",
			createdBy: "system",
		});

		const matching = storage.findProceduresByTaskType("debug_failure");

		expect(matching).toHaveLength(1);
		expect(matching[0]?.name).toBe("fix TypeScript build");
	});

	it("supersedes procedures and removes them from active listings", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-procedures-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const procedure = storage.createProcedure({
			name: "fix TypeScript build",
			taskType: "debug_failure",
			bodyMarkdown: "debug steps",
			createdBy: "worker",
		});

		expect(storage.listProcedures()).toHaveLength(1);

		storage.supersedeProcedure(procedure.id);

		expect(storage.listProcedures()).toEqual([]);
		expect(storage.findProceduresByTaskType("debug_failure")).toEqual([]);
	});
});
