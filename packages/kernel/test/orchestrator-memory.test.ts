import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	BuildplaneMemoryPort,
	BuildplanePolicyPort,
	BuildplaneRuntimePort,
	BuildplaneStoragePort,
	BuildplaneWorkspacePort,
	ExecutionReceipt,
	ExtractedLearning,
	UnitPacket,
} from "@buildplane/kernel";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/workspace-paths.js", async () => {
	const actual = await vi.importActual<
		typeof import("../src/workspace-paths.js")
	>("../src/workspace-paths.js");
	return {
		...actual,
		validatePacketForWorkspaceRoot(p: UnitPacket) {
			return p;
		},
	};
});

import { createBuildplaneOrchestrator } from "../src/orchestrator.js";

const packet: UnitPacket = {
	unit: {
		id: "unit-1",
		kind: "command",
		scope: "task",
		inputRefs: [],
		expectedOutputs: [],
		verificationContract: "exit-0",
		policyProfile: "default",
	},
	execution: { command: "echo", args: ["ok"] },
	verification: { requiredOutputs: [] },
};

const receipt: ExecutionReceipt = {
	command: "echo",
	args: ["ok"],
	cwd: "/tmp/ws",
	startedAt: "2026-04-04T00:00:00.000Z",
	completedAt: "2026-04-04T00:00:01.000Z",
	exitCode: 0,
	stdout: "ok",
	stderr: "",
	outputChecks: [{ path: "output/result.txt", exists: true }],
};

function makeStorage(policyOutcome: "approved" | "rejected") {
	return {
		initializeProject: vi
			.fn()
			.mockReturnValue({ created: true, projectRoot: "/tmp", stateDbPath: "" }),
		createRun: vi
			.fn()
			.mockReturnValue({ id: "run-1", unitId: "unit-1", status: "pending" }),
		getChildRuns: vi.fn().mockReturnValue([]),
		markRunRunning: vi.fn(),
		recordExecutionEvidence: vi.fn(),
		recordDecision: vi.fn(),
		completeRun: vi.fn().mockReturnValue({
			id: "run-1",
			unitId: "unit-1",
			status: policyOutcome === "approved" ? "passed" : "failed",
		}),
		recordWorkspacePrepared: vi.fn(),
		commitRunFailureOutcome: vi
			.fn()
			.mockReturnValue({ id: "run-1", unitId: "unit-1", status: "failed" }),
		commitRunSuccessOutcome: vi
			.fn()
			.mockReturnValue({ id: "run-1", unitId: "unit-1", status: "passed" }),
		recordWorkspaceDeleted: vi.fn(),
		recordWorkspaceCleanupFailed: vi.fn(),
		suspendRun: vi.fn(),
		approveRun: vi.fn(),
		rejectSuspendedRun: vi.fn(),
		getStatusSnapshot: vi.fn().mockReturnValue({
			initialized: true,
			runCounts: {},
			actionableWorkspaces: [],
		}),
		inspectTarget: vi.fn(),
	} as unknown as BuildplaneStoragePort;
}

function makeWorkspace(root: string) {
	const ws = join(root, "ws");
	mkdirSync(ws, { recursive: true });
	return {
		assertRunnableRepository: vi.fn().mockReturnValue({ headSha: "abc123" }),
		prepareWorkspace: vi.fn().mockReturnValue({ path: ws, headSha: "abc123" }),
		deleteWorkspace: vi.fn().mockReturnValue({ deleted: true }),
	} as unknown as BuildplaneWorkspacePort;
}

describe("orchestrator memory integration", () => {
	it("writes learnings after a successful run", () => {
		const root = mkdtempSync(join(tmpdir(), "bp-orch-mem-"));
		const writtenLearnings: {
			runId: string;
			learnings: readonly ExtractedLearning[];
		}[] = [];

		const memoryPort: BuildplaneMemoryPort = {
			writeLearnings(runId, learnings) {
				writtenLearnings.push({ runId, learnings });
			},
			fetchLearnings() {
				return [];
			},
		};

		const orch = createBuildplaneOrchestrator({
			projectRoot: root,
			storage: makeStorage("approved"),
			runtime: {
				executePacket: vi.fn().mockReturnValue(receipt),
			} as unknown as BuildplaneRuntimePort,
			policy: {
				evaluateRun: vi.fn().mockReturnValue({
					kind: "advance-run",
					outcome: "approved",
					reasons: ["ok"],
				}),
			} as unknown as BuildplanePolicyPort,
			workspace: makeWorkspace(root),
			memoryPort,
		});

		orch.runPacket(packet);
		expect(writtenLearnings).toHaveLength(1);
		expect(writtenLearnings[0].runId).toBe("run-1");
		expect(writtenLearnings[0].learnings.length).toBeGreaterThan(0);
	});

	it("writes constraint learning after a rejected run", () => {
		const root = mkdtempSync(join(tmpdir(), "bp-orch-rej-"));
		const writtenLearnings: {
			runId: string;
			learnings: readonly ExtractedLearning[];
		}[] = [];

		const memoryPort: BuildplaneMemoryPort = {
			writeLearnings(runId, learnings) {
				writtenLearnings.push({ runId, learnings });
			},
			fetchLearnings() {
				return [];
			},
		};

		const orch = createBuildplaneOrchestrator({
			projectRoot: root,
			storage: makeStorage("rejected"),
			runtime: {
				executePacket: vi.fn().mockReturnValue({ ...receipt, exitCode: 1 }),
			} as unknown as BuildplaneRuntimePort,
			policy: {
				evaluateRun: vi.fn().mockReturnValue({
					kind: "reject-run",
					outcome: "rejected",
					reasons: ["bad output"],
				}),
			} as unknown as BuildplanePolicyPort,
			workspace: makeWorkspace(root),
			memoryPort,
		});

		orch.runPacket(packet);
		const allLearnings = writtenLearnings.flatMap((w) => w.learnings);
		expect(allLearnings.some((l) => l.kind === "constraint")).toBe(true);
	});

	it("does not write learnings on a retrying policy decision", () => {
		const root = mkdtempSync(join(tmpdir(), "bp-orch-retry-"));
		const writtenLearnings: {
			runId: string;
			learnings: readonly ExtractedLearning[];
		}[] = [];

		const memoryPort: BuildplaneMemoryPort = {
			writeLearnings(runId, learnings) {
				writtenLearnings.push({ runId, learnings });
			},
			fetchLearnings() {
				return [];
			},
		};

		const orch = createBuildplaneOrchestrator({
			projectRoot: root,
			storage: makeStorage("rejected"),
			runtime: {
				executePacket: vi.fn().mockReturnValue({ ...receipt, exitCode: 1 }),
			} as unknown as BuildplaneRuntimePort,
			policy: {
				evaluateRun: vi.fn().mockReturnValue({
					kind: "advance-run",
					outcome: "retrying",
					reasons: ["trying again"],
				}),
			} as unknown as BuildplanePolicyPort,
			workspace: makeWorkspace(root),
			memoryPort,
		});

		orch.runPacket(packet);
		expect(writtenLearnings).toHaveLength(0);
	});

	it("does not throw when no memoryPort is provided (backwards compat)", () => {
		const root = mkdtempSync(join(tmpdir(), "bp-orch-nomem-"));
		const orch = createBuildplaneOrchestrator({
			projectRoot: root,
			storage: makeStorage("approved"),
			runtime: {
				executePacket: vi.fn().mockReturnValue(receipt),
			} as unknown as BuildplaneRuntimePort,
			policy: {
				evaluateRun: vi.fn().mockReturnValue({
					kind: "advance-run",
					outcome: "approved",
					reasons: [],
				}),
			} as unknown as BuildplanePolicyPort,
			workspace: makeWorkspace(root),
			// no memoryPort
		});
		expect(() => orch.runPacket(packet)).not.toThrow();
	});

	it("does not break the run if memory write throws", () => {
		const root = mkdtempSync(join(tmpdir(), "bp-orch-memfail-"));
		const throwingPort: BuildplaneMemoryPort = {
			writeLearnings: vi.fn().mockImplementation(() => {
				throw new Error("db error");
			}),
			fetchLearnings: vi.fn().mockReturnValue([]),
		};

		const orch = createBuildplaneOrchestrator({
			projectRoot: root,
			storage: makeStorage("approved"),
			runtime: {
				executePacket: vi.fn().mockReturnValue(receipt),
			} as unknown as BuildplaneRuntimePort,
			policy: {
				evaluateRun: vi.fn().mockReturnValue({
					kind: "advance-run",
					outcome: "approved",
					reasons: [],
				}),
			} as unknown as BuildplanePolicyPort,
			workspace: makeWorkspace(root),
			memoryPort: throwingPort,
		});

		const result = orch.runPacket(packet);
		expect(result.run.status).toBe("passed");
	});
});
