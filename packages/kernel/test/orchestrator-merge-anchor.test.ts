import type {
	BuildplanePolicyPort,
	BuildplaneRuntimePort,
	BuildplaneStoragePort,
	BuildplaneWorkspacePort,
	ExecutionReceipt,
	RunAdmissionLocalEvidenceStore,
	StatusSnapshot,
	UnitPacket,
} from "@buildplane/kernel";
import { describe, expect, it } from "vitest";

import { createBuildplaneOrchestrator } from "../src/orchestrator";

const MERGED = "a".repeat(40);

const packet: UnitPacket = {
	unit: {
		id: "anchor-unit",
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

function createMergeAnchorHarness() {
	const root = "/tmp/buildplane-anchor-test";
	const workspacePath = `${root}/.buildplane/workspaces/anchor-unit`;

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
				stateDbPath: `${root}/.buildplane/state.db`,
			};
		},
		createRun() {
			return { id: "run-anchor", unitId: packet.unit.id, status: "pending" };
		},
		markRunRunning() {},
		recordExecutionEvidence() {},
		recordDecision() {
			throw new Error("legacy recordDecision should not be used");
		},
		completeRun() {
			throw new Error("legacy completeRun should not be used");
		},
		recordWorkspacePrepared() {},
		commitRunFailureOutcome(_runId, _payload) {
			return { id: "run-anchor", unitId: packet.unit.id, status: "failed" };
		},
		commitRunSuccessOutcome() {
			return { id: "run-anchor", unitId: packet.unit.id, status: "passed" };
		},
		recordWorkspaceDeleted() {},
		recordWorkspaceCleanupFailed() {},
		getStatusSnapshot() {
			return statusSnapshot;
		},
		inspectTarget() {
			throw new Error("not used in merge anchor tests");
		},
		getChildRuns() {
			return [];
		},
	};

	const runtime: BuildplaneRuntimePort = {
		executePacket(_packet, _root) {
			return baseReceipt;
		},
		async executePacketAsync(_packet, _root, _bus) {
			return baseReceipt;
		},
	};

	const policy: BuildplanePolicyPort = {
		evaluateRun() {
			return { kind: "advance-run", outcome: "approved", reasons: [] };
		},
	};

	const workspace: BuildplaneWorkspacePort = {
		assertRunnableRepository() {
			return { headSha: "b".repeat(40) };
		},
		checkWorktreeClean: () => true,
		prepareWorkspace(_root, _runId, headSha) {
			return { path: workspacePath, headSha };
		},
		commitAndMergeWorkspace() {
			return { mergedHeadSha: MERGED };
		},
		deleteWorkspace() {
			return { deleted: true };
		},
	};

	const admissionStore: RunAdmissionLocalEvidenceStore = {
		writeReceiptArtifact(input) {
			return {
				ref: `artifact://${input.receipt.receipt_id}`,
				path: `${root}/run-admission.json`,
			};
		},
		appendAdmissionEvent(input) {
			return {
				ref: `event://${input.event.event_id}`,
				path: `${root}/run-admission-events.jsonl`,
			};
		},
	};

	return {
		orchestrator: createBuildplaneOrchestrator({
			projectRoot: root,
			storage,
			runtime,
			policy,
			workspace,
			admissionStore,
		}),
	};
}

describe("orchestrator serial re-anchor", () => {
	it("surfaces the post-merge HEAD as result.mergedHeadSha on success", () => {
		const { orchestrator } = createMergeAnchorHarness();

		const result = orchestrator.runPacket(packet);

		expect(result.run.status).toBe("passed");
		expect(result.mergedHeadSha).toBe(MERGED);
	});

	// GAP-7 TASK 0: PlanForge dispatch routes through runPacketAsync ONLY, so the
	// supervisor loop's re-anchor reads result.mergedHeadSha off the ASYNC path.
	// Both paths funnel through the shared finalizeRun, but pin the async surface
	// explicitly so a future refactor can't drop the merged HEAD on it.
	it("surfaces the post-merge HEAD as result.mergedHeadSha on the async path", async () => {
		const { orchestrator } = createMergeAnchorHarness();

		const result = await orchestrator.runPacketAsync(packet);

		expect(result.run.status).toBe("passed");
		expect(result.mergedHeadSha).toBe(MERGED);
	});
});
