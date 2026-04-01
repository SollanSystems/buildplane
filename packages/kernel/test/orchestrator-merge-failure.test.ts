import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	BuildplanePolicyPort,
	BuildplaneRuntimePort,
	BuildplaneStoragePort,
	BuildplaneWorkspacePort,
	ExecutionReceipt,
	StatusSnapshot,
	UnitPacket,
} from "@buildplane/kernel";
import { describe, expect, it } from "vitest";

import { createBuildplaneOrchestrator } from "../src/orchestrator";

const packet: UnitPacket = {
	unit: {
		id: "merge-fail-unit",
		kind: "command",
		scope: "task",
		inputRefs: [],
		expectedOutputs: [],
		verificationContract: "exit-0-and-required-outputs",
		policyProfile: "default",
	},
	execution: {
		command: "node",
		cwd: ".",
	},
	verification: {
		requiredOutputs: [],
	},
};

function createMergeFailureHarness() {
	const runEvents: string[] = [];
	const root = mkdtempSync(join(tmpdir(), "buildplane-merge-fail-"));
	const workspacePath = join(root, ".buildplane", "workspaces", "run-1");

	const baseReceipt: ExecutionReceipt = {
		command: "node",
		args: [],
		cwd: workspacePath,
		startedAt: "2026-03-31T00:00:00.000Z",
		completedAt: "2026-03-31T00:00:01.000Z",
		exitCode: 0,
		stdout: "ok",
		stderr: "",
		outputChecks: [],
	};

	const statusSnapshot: StatusSnapshot = {
		initialized: true,
		latestRunUsedWorkspace: false,
		actionableWorkspaces: [],
		runCounts: { pending: 0, running: 0, passed: 0, failed: 0, cancelled: 0 },
	};

	const storage: BuildplaneStoragePort = {
		initializeProject() {
			return {
				created: true,
				projectRoot: root,
				stateDbPath: join(root, ".buildplane", "state.db"),
			};
		},
		createRun() {
			runEvents.push("create-run");
			return { id: "run-1", unitId: packet.unit.id, status: "pending" };
		},
		markRunRunning() {
			runEvents.push("mark-run-running");
		},
		recordExecutionEvidence() {
			runEvents.push("record-execution-evidence");
		},
		recordDecision() {
			throw new Error("legacy recordDecision should not be used");
		},
		completeRun() {
			throw new Error("legacy completeRun should not be used");
		},
		recordWorkspacePrepared() {
			runEvents.push("record-workspace-prepared");
		},
		commitRunFailureOutcome(_runId, _payload) {
			runEvents.push("commit-run-failure-outcome");
			return { id: "run-1", unitId: packet.unit.id, status: "failed" };
		},
		commitRunSuccessOutcome() {
			runEvents.push("commit-run-success-outcome");
			return { id: "run-1", unitId: packet.unit.id, status: "passed" };
		},
		recordWorkspaceDeleted() {
			runEvents.push("record-workspace-deleted");
		},
		recordWorkspaceCleanupFailed() {
			runEvents.push("record-workspace-cleanup-failed");
		},
		getStatusSnapshot() {
			return statusSnapshot;
		},
		inspectTarget() {
			throw new Error("not used in merge failure tests");
		},
	};

	const runtime: BuildplaneRuntimePort = {
		executePacket(_packet, _root) {
			runEvents.push("execute-packet");
			return baseReceipt;
		},
		async executePacketAsync(_packet, _root, _bus) {
			runEvents.push("execute-packet");
			return baseReceipt;
		},
	};

	const policy: BuildplanePolicyPort = {
		evaluateRun() {
			runEvents.push("evaluate-run");
			return { kind: "advance-run", outcome: "approved", reasons: [] };
		},
	};

	const workspace: BuildplaneWorkspacePort = {
		assertRunnableRepository() {
			return { headSha: "abc123" };
		},
		prepareWorkspace() {
			runEvents.push("prepare-workspace");
			return { path: workspacePath, headSha: "abc123" };
		},
		deleteWorkspace() {
			runEvents.push("delete-workspace");
			return { deleted: true };
		},
		commitAndMergeWorkspace() {
			runEvents.push("commit-and-merge-workspace");
			throw new Error("git merge failed: conflict in src/foo.ts");
		},
	};

	return {
		root,
		workspacePath,
		runEvents,
		orchestrator: createBuildplaneOrchestrator({
			projectRoot: root,
			storage,
			runtime,
			policy,
			workspace,
		}),
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

describe("merge failure handling", () => {
	it("marks run as failed when commitAndMergeWorkspace throws", () => {
		const { orchestrator, cleanup } = createMergeFailureHarness();

		try {
			const result = orchestrator.runPacket(packet);

			// Run must be marked failed, not passed
			expect(result.run.status).toBe("failed");

			// Failure reason must be merge-failed
			expect(result.failure?.kind).toBe("merge-failed");
			expect(result.failure?.message).toContain("git merge failed");
		} finally {
			cleanup();
		}
	});

	it("retains workspace when commitAndMergeWorkspace throws", () => {
		const { orchestrator, runEvents, cleanup } = createMergeFailureHarness();

		try {
			const result = orchestrator.runPacket(packet);

			// Workspace must be retained — do NOT delete it
			expect(result.workspace?.status).toBe("retained");
			expect(runEvents).not.toContain("delete-workspace");
		} finally {
			cleanup();
		}
	});

	it("does not record success when commitAndMergeWorkspace throws", () => {
		const { orchestrator, runEvents, cleanup } = createMergeFailureHarness();

		try {
			orchestrator.runPacket(packet);

			// commitRunSuccessOutcome must NOT have been called
			expect(runEvents).not.toContain("commit-run-success-outcome");

			// commitRunFailureOutcome MUST have been called
			expect(runEvents).toContain("commit-run-failure-outcome");

			// The merge was attempted before any outcome was recorded
			const mergeIdx = runEvents.indexOf("commit-and-merge-workspace");
			const failureIdx = runEvents.indexOf("commit-run-failure-outcome");
			expect(mergeIdx).toBeLessThan(failureIdx);
		} finally {
			cleanup();
		}
	});
});
