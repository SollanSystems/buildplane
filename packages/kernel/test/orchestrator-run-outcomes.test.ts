import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	AppendRunOutcomeInput,
	BuildplanePolicyPort,
	BuildplaneRuntimePort,
	BuildplaneStoragePort,
	BuildplaneWorkspacePort,
	ExecutionReceipt,
	RunOutcome,
	UnitPacket,
} from "@buildplane/kernel";
import { describe, expect, it } from "vitest";

import { createBuildplaneOrchestrator } from "../src/orchestrator";

const modelUnit = {
	id: "unit-1",
	kind: "implement",
	scope: "task" as const,
	inputRefs: [],
	expectedOutputs: ["tmp/out.txt"],
	verificationContract: "exit-0-and-required-outputs",
	policyProfile: "default",
};

function modelPacket(overrides: Partial<UnitPacket> = {}): UnitPacket {
	return {
		unit: modelUnit,
		model: { provider: "anthropic", model: "claude" },
		verification: { requiredOutputs: ["tmp/out.txt"] },
		...overrides,
	};
}

function commandPacket(): UnitPacket {
	return {
		unit: { ...modelUnit, kind: "command" },
		execution: { command: "node" },
		verification: { requiredOutputs: ["tmp/out.txt"] },
	};
}

interface HarnessOptions {
	readonly policyOutcome?: "approved" | "rejected";
}

function createHarness(packet: UnitPacket, options: HarnessOptions = {}) {
	const { policyOutcome = "approved" } = options;
	const appended: AppendRunOutcomeInput[] = [];
	const root = mkdtempSync(join(tmpdir(), "buildplane-run-outcome-recorder-"));
	const workspacePath = join(root, ".buildplane", "workspaces", "run-1");

	const baseReceipt: ExecutionReceipt = {
		command: "node",
		args: [],
		cwd: workspacePath,
		startedAt: "2026-03-17T00:00:00.000Z",
		completedAt: "2026-03-17T00:00:01.000Z",
		exitCode: policyOutcome === "approved" ? 0 : 1,
		stdout: policyOutcome === "approved" ? "ok" : "",
		stderr: policyOutcome === "approved" ? "" : "failed",
		outputChecks: [
			{ path: "tmp/out.txt", exists: policyOutcome === "approved" },
		],
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
			return { id: "run-1", unitId: packet.unit.id, status: "pending" };
		},
		markRunRunning() {},
		recordExecutionEvidence() {},
		recordDecision() {},
		completeRun() {
			throw new Error("legacy completeRun should not be used");
		},
		recordWorkspacePrepared() {},
		commitRunFailureOutcome() {
			return { id: "run-1", unitId: packet.unit.id, status: "failed" };
		},
		commitRunSuccessOutcome() {
			return { id: "run-1", unitId: packet.unit.id, status: "passed" };
		},
		recordWorkspaceDeleted() {},
		recordWorkspaceCleanupFailed() {},
		getStatusSnapshot() {
			return {
				initialized: true,
				runCounts: {
					pending: 0,
					running: 0,
					passed: 0,
					failed: 0,
					cancelled: 0,
					suspended: 0,
				},
			};
		},
		inspectTarget() {
			throw new Error("not used");
		},
		getChildRuns() {
			return [];
		},
		appendRunOutcome(input: AppendRunOutcomeInput): RunOutcome {
			appended.push(input);
			return {
				id: `outcome-${appended.length}`,
				repoId: root,
				taskType: input.taskType,
				worker: input.worker,
				success: input.success,
				sourceRunId: input.sourceRunId,
				createdAt: "2026-03-17T00:00:02.000Z",
			};
		},
		listRunOutcomes() {
			return [];
		},
	} as unknown as BuildplaneStoragePort;

	const runtime: BuildplaneRuntimePort = {
		executePacket() {
			return baseReceipt;
		},
	};

	const policy: BuildplanePolicyPort = {
		evaluateRun() {
			return policyOutcome === "approved"
				? { kind: "advance-run", outcome: "approved", reasons: [] }
				: {
						kind: "reject-run",
						outcome: "rejected",
						reasons: ["command exited with code 1"],
					};
		},
	};

	const workspace: BuildplaneWorkspacePort = {
		assertRunnableRepository() {
			return { headSha: "abc123" };
		},
		prepareWorkspace() {
			return { path: workspacePath, headSha: "abc123" };
		},
		deleteWorkspace() {
			return { deleted: true };
		},
	};

	return {
		appended,
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

describe("finalizeRun run-outcome recorder", () => {
	it("records one sdk success row for a model run with no routing hints", () => {
		const { orchestrator, appended, cleanup } = createHarness(modelPacket(), {
			policyOutcome: "approved",
		});
		try {
			const result = orchestrator.runPacket(modelPacket());
			expect(result.run.status).toBe("passed");
			expect(appended).toEqual([
				{
					taskType: "implement",
					worker: "sdk",
					success: true,
					sourceRunId: "run-1",
				},
			]);
		} finally {
			cleanup();
		}
	});

	it("records the preferredWorker hint when present", () => {
		const packet = modelPacket({
			routingHints: { preferredWorker: "codex" },
		});
		const { orchestrator, appended, cleanup } = createHarness(packet, {
			policyOutcome: "approved",
		});
		try {
			orchestrator.runPacket(packet);
			expect(appended).toHaveLength(1);
			expect(appended[0]?.worker).toBe("codex");
			expect(appended[0]?.success).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("uses intent.taskType over unit.kind when present", () => {
		const packet = modelPacket({
			intent: { taskType: "review" } as UnitPacket["intent"],
		});
		const { orchestrator, appended, cleanup } = createHarness(packet, {
			policyOutcome: "approved",
		});
		try {
			orchestrator.runPacket(packet);
			expect(appended).toHaveLength(1);
			expect(appended[0]?.taskType).toBe("review");
		} finally {
			cleanup();
		}
	});

	it("records a failure row when a model run is rejected (quality-failure)", () => {
		const { orchestrator, appended, cleanup } = createHarness(modelPacket(), {
			policyOutcome: "rejected",
		});
		try {
			const result = orchestrator.runPacket(modelPacket());
			expect(result.run.status).toBe("failed");
			expect(appended).toEqual([
				{
					taskType: "implement",
					worker: "sdk",
					success: false,
					sourceRunId: "run-1",
				},
			]);
		} finally {
			cleanup();
		}
	});

	it("does not record for a command packet (execution set, model unset)", () => {
		const packet = commandPacket();
		const { orchestrator, appended, cleanup } = createHarness(packet, {
			policyOutcome: "approved",
		});
		try {
			orchestrator.runPacket(packet);
			expect(appended).toHaveLength(0);
		} finally {
			cleanup();
		}
	});

	it("does not record for a packet with neither model nor execution", () => {
		const packet: UnitPacket = {
			unit: modelUnit,
			verification: { requiredOutputs: ["tmp/out.txt"] },
		};
		const { orchestrator, appended, cleanup } = createHarness(packet, {
			policyOutcome: "approved",
		});
		try {
			orchestrator.runPacket(packet);
			expect(appended).toHaveLength(0);
		} finally {
			cleanup();
		}
	});
});
