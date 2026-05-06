import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RejectedPolicyDecision, UnitPacket } from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import {
	createBuildplaneStorage,
	exportRunBundle,
	verifyRunFinalVerdict,
} from "../src";

const packet: UnitPacket = {
	unit: {
		id: "unit-architecture-diff-scope",
		kind: "command",
		scope: "task",
		inputRefs: [],
		expectedOutputs: [],
		verificationContract: "exit-0",
		policyProfile: "architecture-safe",
	},
	execution: { command: "node", args: ["verify-arch-scope.js"] },
	verification: { requiredOutputs: [] },
};

const diffScopeDecision: RejectedPolicyDecision = {
	kind: "architecture.diff_scope",
	outcome: "rejected",
	reasons: [
		"architecture.diff_scope blocked infra/prod.tf: path is outside allowed architecture scope src/**, tests/**.",
		"Changed files: src/domain/runBundle.ts, infra/prod.tf",
		"Allowed paths: src/**, tests/**",
	],
};

function createStorage(root: string) {
	const storage = createBuildplaneStorage(root);
	storage.initializeProject();
	return storage;
}

describe("architecture.diff_scope run bundle export", () => {
	it("exports deterministic architecture scope blockers for out-of-scope diffs", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-architecture-diff-scope-"),
		);
		const storage = createStorage(root);
		const run = storage.createRun(packet, {
			runId: "run-architecture-diff-scope",
		});
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, {
			command: "node",
			args: ["verify-arch-scope.js"],
			cwd: ".",
			startedAt: "2026-05-05T00:00:00.000Z",
			completedAt: "2026-05-05T00:00:01.000Z",
			exitCode: 0,
			stdout: "changed files: src/domain/runBundle.ts infra/prod.tf\n",
			stderr: "",
			outputChecks: [],
		});
		storage.recordDecision(run.id, diffScopeDecision);
		storage.completeRun(run.id, "failed");

		const report = verifyRunFinalVerdict(root, { runId: run.id });
		const bundle = exportRunBundle(root, { runId: run.id });

		expect(report.verdict).toBe("BLOCKED");
		expect(bundle.run.blockers).toEqual([
			expect.objectContaining({
				id: "architecture-diff-scope",
				status: "open",
				severity: "high",
			}),
		]);
		expect(bundle.run.blockers[0]?.label).toContain("infra/prod.tf");
		expect(bundle.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "blocker_raised",
					target: "architecture.diff_scope",
					verification_state: "failed",
					summary: expect.stringContaining(
						"architecture.diff_scope blocked infra/prod.tf",
					),
				}),
			]),
		);
	});
});
