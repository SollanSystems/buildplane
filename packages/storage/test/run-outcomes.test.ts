import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBuildplaneStorage } from "../src";

describe("run_outcomes storage", () => {
	it("appends raw per-run rows and lists them scoped by task/worker", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-run-outcomes-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const a = storage.appendRunOutcome({
			taskType: "implement",
			worker: "codex",
			success: true,
			sourceRunId: "run-1",
		});
		storage.appendRunOutcome({
			taskType: "implement",
			worker: "sdk",
			success: false,
			sourceRunId: "run-2",
		});
		storage.appendRunOutcome({
			taskType: "review",
			worker: "codex",
			success: true,
			sourceRunId: "run-3",
		});

		expect(a.repoId).toBe(root);
		expect(a.id).toMatch(/[0-9a-f-]{36}/);
		expect(a.taskType).toBe("implement");
		expect(a.worker).toBe("codex");
		expect(a.success).toBe(true);
		expect(a.sourceRunId).toBe("run-1");
		expect(a.createdAt).toMatch(/\d{4}-\d{2}-\d{2}T/);

		expect(storage.listRunOutcomes({ taskType: "implement" })).toHaveLength(2);
		expect(
			storage.listRunOutcomes({ taskType: "implement", worker: "codex" }),
		).toHaveLength(1);
		expect(storage.listRunOutcomes()).toHaveLength(3);

		// append-only: repeating the same grain with a NEW source_run_id does NOT
		// supersede — it adds a row.
		storage.appendRunOutcome({
			taskType: "implement",
			worker: "codex",
			success: false,
			sourceRunId: "run-4",
		});
		expect(
			storage.listRunOutcomes({ taskType: "implement", worker: "codex" }),
		).toHaveLength(2);
	});

	it("is idempotent for a repeated source_run_id (one run = at most one row)", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-run-outcomes-idem-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const first = storage.appendRunOutcome({
			taskType: "implement",
			worker: "codex",
			success: true,
			sourceRunId: "run-dup",
		});
		// A double-fire (retry/replay/two finalization paths) must NOT add a second
		// row, even if the success flag differs — the first write wins.
		const second = storage.appendRunOutcome({
			taskType: "implement",
			worker: "sdk",
			success: false,
			sourceRunId: "run-dup",
		});

		expect(storage.listRunOutcomes()).toHaveLength(1);
		expect(second.id).toBe(first.id);
		expect(second.worker).toBe("codex");
		expect(second.success).toBe(true);
	});

	it("defaults the repoId filter to the store root", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-run-outcomes-scope-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		storage.appendRunOutcome({
			taskType: "implement",
			worker: "claude-code",
			success: true,
			sourceRunId: "run-a",
		});

		const row = storage.appendRunOutcome({
			taskType: "implement",
			worker: "claude-code",
			success: true,
			sourceRunId: "run-a",
		});
		expect(row.repoId).toBe(root);
		expect(storage.listRunOutcomes({ repoId: root })).toHaveLength(1);
	});
});
