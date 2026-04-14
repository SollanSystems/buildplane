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
	ProcedureMemory,
	StrategyPacket,
	TaskType,
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

function makeProcedureAwareStorage() {
	let runCount = 0;
	let procedureCount = 0;
	const runUnits = new Map<string, string>();
	const procedures: ProcedureMemory[] = [];

	const storage = {
		initializeProject: vi
			.fn()
			.mockReturnValue({ created: true, projectRoot: "/tmp", stateDbPath: "" }),
		createRun: vi.fn().mockImplementation((createdPacket: UnitPacket) => {
			const id = `run-${++runCount}`;
			runUnits.set(id, createdPacket.unit.id);
			return { id, unitId: createdPacket.unit.id, status: "pending" };
		}),
		getChildRuns: vi.fn().mockReturnValue([]),
		markRunRunning: vi.fn(),
		recordExecutionEvidence: vi.fn(),
		recordDecision: vi.fn(),
		completeRun: vi.fn(),
		recordWorkspacePrepared: vi.fn(),
		commitRunFailureOutcome: vi.fn().mockImplementation((runId: string) => ({
			id: runId,
			unitId: runUnits.get(runId) ?? "unknown",
			status: "failed",
		})),
		commitRunSuccessOutcome: vi.fn().mockImplementation((runId: string) => ({
			id: runId,
			unitId: runUnits.get(runId) ?? "unknown",
			status: "passed",
		})),
		recordWorkspaceDeleted: vi.fn(),
		recordWorkspaceCleanupFailed: vi.fn(),
		suspendRun: vi.fn(),
		approveRun: vi.fn(),
		rejectSuspendedRun: vi.fn(),
		upsertRepoFact: vi.fn(),
		getRepoFact: vi.fn().mockReturnValue(null),
		listRepoFacts: vi.fn().mockReturnValue([]),
		retrieveRepoFacts: vi.fn().mockReturnValue([]),
		supersedeRepoFact: vi.fn().mockReturnValue(0),
		createProcedure: vi
			.fn()
			.mockImplementation(
				(input: Parameters<BuildplaneStoragePort["createProcedure"]>[0]) => {
					const now = new Date().toISOString();
					const procedure: ProcedureMemory = {
						id: `procedure-${++procedureCount}`,
						memoryType: "procedure",
						scopeType: "repo",
						status: "active",
						provenance: {
							createdBy: input.createdBy,
							createdAt: now,
							updatedAt: now,
							confidence: input.confidence ?? 1,
							repoId: "/tmp/project",
							branch: input.branch,
							commitSha: input.commitSha,
							sourceRunId: input.sourceRunId,
							sourceTaskId: input.sourceTaskId,
						},
						name: input.name,
						taskType: input.taskType,
						bodyMarkdown: input.bodyMarkdown,
						metadata: input.metadata,
					};
					procedures.push(procedure);
					return procedure;
				},
			),
		upsertProcedure: vi
			.fn()
			.mockImplementation(
				(
					input: Parameters<BuildplaneStoragePort["upsertProcedure"]>[0],
					options?: Parameters<BuildplaneStoragePort["upsertProcedure"]>[1],
				) => {
					const sameNamedProcedures = procedures.filter(
						(procedure) =>
							procedure.status === "active" &&
							procedure.name === input.name &&
							procedure.taskType === input.taskType,
					);
					const matchingProcedures = sameNamedProcedures.filter((procedure) =>
						Object.entries(options?.matchMetadata ?? {}).every(
							([key, value]) => procedure.metadata?.[key] === value,
						),
					);
					if (
						options?.skipIfConflictingActiveName &&
						sameNamedProcedures.length > 0 &&
						matchingProcedures.length !== sameNamedProcedures.length
					) {
						return null;
					}
					const identicalProcedure = matchingProcedures.find(
						(procedure) => procedure.bodyMarkdown === input.bodyMarkdown,
					);
					if (identicalProcedure) {
						for (const procedure of matchingProcedures) {
							if (procedure.id !== identicalProcedure.id) {
								storage.supersedeProcedure(procedure.id);
							}
						}
						return identicalProcedure;
					}
					for (const procedure of matchingProcedures) {
						storage.supersedeProcedure(procedure.id);
					}
					return storage.createProcedure(input);
				},
			),
		listProcedures: vi
			.fn()
			.mockImplementation(
				(options?: Parameters<BuildplaneStoragePort["listProcedures"]>[0]) =>
					procedures.filter(
						(procedure) =>
							procedure.status === "active" &&
							(!options?.taskType || procedure.taskType === options.taskType),
					),
			),
		findProceduresByTaskType: vi
			.fn()
			.mockImplementation((taskType: string) =>
				procedures.filter(
					(procedure) =>
						procedure.status === "active" && procedure.taskType === taskType,
				),
			),
		retrieveProcedures: vi.fn().mockReturnValue([]),
		supersedeProcedure: vi.fn().mockImplementation((id: string) => {
			let changes = 0;
			for (const procedure of procedures) {
				if (procedure.id === id && procedure.status === "active") {
					procedure.status = "superseded";
					changes += 1;
				}
			}
			return changes;
		}),
		createSearchableDocument: vi.fn(),
		getSearchableDocument: vi.fn(),
		listSearchableDocuments: vi.fn().mockReturnValue([]),
		searchSearchableDocuments: vi.fn().mockReturnValue([]),
		retrieveSearchableDocuments: vi.fn().mockReturnValue([]),
		recordInjectedMemories: vi.fn(),
		listInjectedMemories: vi.fn().mockReturnValue([]),
		getStatusSnapshot: vi.fn().mockReturnValue({
			initialized: true,
			runCounts: {},
			actionableWorkspaces: [],
		}),
		inspectTarget: vi.fn(),
	} as BuildplaneStoragePort & { procedures: ProcedureMemory[] };

	storage.procedures = procedures;
	return storage;
}

function makeStrategyPacket(taskType: TaskType = "implement"): StrategyPacket {
	return {
		id: "strategy-promote-workflow",
		mode: "implement-then-review",
		mergePolicy: "reviewer-must-approve",
		children: [
			{
				role: "implementer",
				packet: {
					unit: {
						id: "task-implementer",
						kind: "command",
						scope: "task",
						inputRefs: [],
						expectedOutputs: [],
						verificationContract: "exit-0",
						policyProfile: "default",
					},
					execution: { command: "echo", args: ["implemented"] },
					intent: {
						objective: "Implement structured memory promotion",
						taskType,
						context: {
							files: ["packages/kernel/src/orchestrator.ts"],
						},
						constraints: {
							scope: ["packages/kernel/src/orchestrator.ts"],
							verification: [
								"npx vitest run packages/kernel/test/orchestrator-memory.test.ts",
							],
						},
						features: {
							ambiguity: "low",
							reversibility: "easy",
							verifierStrength: "strong",
							estimatedComplexity: "medium",
						},
					},
					verification: { requiredOutputs: [] },
				},
			},
			{
				role: "reviewer",
				packet: {
					unit: {
						id: "task-reviewer",
						kind: "command",
						scope: "task",
						inputRefs: [],
						expectedOutputs: [],
						verificationContract: "exit-0",
						policyProfile: "default",
					},
					execution: { command: "echo", args: ["reviewed"] },
					intent: {
						objective: "Review the change",
						taskType: "review",
						context: { files: ["packages/kernel/src/orchestrator.ts"] },
						constraints: {
							scope: ["packages/kernel/src/orchestrator.ts"],
							verification: [
								"npx vitest run packages/kernel/test/orchestrator-memory.test.ts",
							],
						},
						features: {
							ambiguity: "low",
							reversibility: "easy",
							verifierStrength: "strong",
						},
					},
					verification: { requiredOutputs: [] },
				},
			},
		],
	};
}

function makeStrategyPolicy(reviewerRejectionReason: string) {
	let reviewerCalls = 0;
	return {
		evaluateRun: vi.fn().mockImplementation((evaluatedPacket: UnitPacket) => {
			if (evaluatedPacket.unit.id === "task-reviewer") {
				reviewerCalls += 1;
				if (reviewerCalls % 2 === 1) {
					return {
						kind: "reject-run" as const,
						outcome: "rejected" as const,
						reasons: [reviewerRejectionReason],
					};
				}
				return {
					kind: "advance-run" as const,
					outcome: "approved" as const,
					reasons: ["review approved"],
				};
			}

			return {
				kind: "advance-run" as const,
				outcome: "approved" as const,
				reasons: ["implementation completed"],
			};
		}),
	} as unknown as BuildplanePolicyPort;
}

function makeMemoryPort(): BuildplaneMemoryPort {
	return {
		writeLearnings: vi.fn(),
		fetchLearnings: vi.fn().mockReturnValue([]),
		promoteLearnings: vi.fn(),
		fetchLearningById: vi.fn(),
		fetchLearningsByRunId: vi.fn().mockReturnValue([]),
	} as unknown as BuildplaneMemoryPort;
}

describe("orchestrator memory integration", () => {
	it("writes learnings after a successful run", () => {
		const root = mkdtempSync(join(tmpdir(), "bp-orch-mem-"));
		const writtenLearnings: {
			runId: string;
			learnings: readonly ExtractedLearning[];
		}[] = [];

		const memoryPort = {
			writeLearnings(runId: string, learnings: readonly ExtractedLearning[]) {
				writtenLearnings.push({ runId, learnings });
			},
			fetchLearnings() {
				return [];
			},
			promoteLearnings: vi.fn(),
		} as unknown as BuildplaneMemoryPort;

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

		const memoryPort = {
			writeLearnings(runId: string, learnings: readonly ExtractedLearning[]) {
				writtenLearnings.push({ runId, learnings });
			},
			fetchLearnings() {
				return [];
			},
			promoteLearnings: vi.fn(),
		} as unknown as BuildplaneMemoryPort;

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

		const memoryPort = {
			writeLearnings(runId: string, learnings: readonly ExtractedLearning[]) {
				writtenLearnings.push({ runId, learnings });
			},
			fetchLearnings() {
				return [];
			},
			promoteLearnings: vi.fn(),
		} as unknown as BuildplaneMemoryPort;

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
		const throwingPort = {
			writeLearnings: vi.fn().mockImplementation(() => {
				throw new Error("db error");
			}),
			fetchLearnings: vi.fn().mockReturnValue([]),
			promoteLearnings: vi.fn(),
		} as unknown as BuildplaneMemoryPort;

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

	it("promotes a multi-round strategy workflow learning into a canonical procedure", async () => {
		const root = mkdtempSync(join(tmpdir(), "bp-orch-strategy-promote-"));
		const storage = makeProcedureAwareStorage();
		const orch = createBuildplaneOrchestrator({
			projectRoot: root,
			storage,
			runtime: {
				executePacket: vi.fn().mockReturnValue(receipt),
			} as unknown as BuildplaneRuntimePort,
			policy: makeStrategyPolicy("missing tests"),
			workspace: makeWorkspace(root),
			memoryPort: makeMemoryPort(),
		});

		const result = await orch.runStrategy(makeStrategyPacket());

		expect(result.outcome).toBe("passed");
		expect(storage.createProcedure).toHaveBeenCalledTimes(1);
		const procedures = storage.listProcedures({ taskType: "implement" });
		expect(procedures).toHaveLength(1);
		expect(procedures[0]?.name).toBe(
			"implement-then-review workflow for implement tasks",
		);
		expect(procedures[0]?.bodyMarkdown).toContain(
			"Use an implement-then-review workflow for implement tasks.",
		);
		expect(procedures[0]?.bodyMarkdown).toContain("missing tests");
		expect(procedures[0]?.provenance.sourceRunId).toBe(result.winnerRunId);
		expect(procedures[0]?.provenance.sourceTaskId).toBe("task-implementer");
		expect(procedures[0]?.provenance.createdBy).toBe("worker");
		expect(procedures[0]?.metadata).toMatchObject({
			promotionRule: "multi-round-strategy-workflow->procedure",
			strategyMode: "implement-then-review",
			sourceLearningTitle: "Strategy required multiple rounds",
			sourceLearningKind: "workflow",
			sourceStrategyId: "strategy-promote-workflow",
		});
	});

	it("does not duplicate an identical promoted procedure on repeated strategy replays", async () => {
		const root = mkdtempSync(join(tmpdir(), "bp-orch-strategy-dedupe-"));
		const storage = makeProcedureAwareStorage();

		const firstOrchestrator = createBuildplaneOrchestrator({
			projectRoot: root,
			storage,
			runtime: {
				executePacket: vi.fn().mockReturnValue(receipt),
			} as unknown as BuildplaneRuntimePort,
			policy: makeStrategyPolicy("missing tests"),
			workspace: makeWorkspace(root),
			memoryPort: makeMemoryPort(),
		});
		await firstOrchestrator.runStrategy(makeStrategyPacket());

		const secondOrchestrator = createBuildplaneOrchestrator({
			projectRoot: root,
			storage,
			runtime: {
				executePacket: vi.fn().mockReturnValue(receipt),
			} as unknown as BuildplaneRuntimePort,
			policy: makeStrategyPolicy("missing tests"),
			workspace: makeWorkspace(root),
			memoryPort: makeMemoryPort(),
		});
		await secondOrchestrator.runStrategy(makeStrategyPacket());

		expect(storage.createProcedure).toHaveBeenCalledTimes(1);
		expect(storage.supersedeProcedure).not.toHaveBeenCalled();
		expect(storage.listProcedures({ taskType: "implement" })).toHaveLength(1);
	});

	it("still promotes a procedure when learning persistence fails", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "bp-orch-strategy-promote-fallback-"),
		);
		const storage = makeProcedureAwareStorage();
		const throwingMemoryPort = {
			writeLearnings: vi.fn().mockImplementation(() => {
				throw new Error("learning store unavailable");
			}),
			fetchLearnings: vi.fn().mockReturnValue([]),
			promoteLearnings: vi.fn(),
		} as unknown as BuildplaneMemoryPort;
		const orch = createBuildplaneOrchestrator({
			projectRoot: root,
			storage,
			runtime: {
				executePacket: vi.fn().mockReturnValue(receipt),
			} as unknown as BuildplaneRuntimePort,
			policy: makeStrategyPolicy("missing tests"),
			workspace: makeWorkspace(root),
			memoryPort: throwingMemoryPort,
		});

		await orch.runStrategy(makeStrategyPacket());

		expect(storage.listProcedures({ taskType: "implement" })).toHaveLength(1);
	});

	it("does not supersede or replace a same-name manual procedure", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "bp-orch-strategy-manual-collision-"),
		);
		const storage = makeProcedureAwareStorage();
		storage.createProcedure({
			name: "implement-then-review workflow for implement tasks",
			taskType: "implement",
			bodyMarkdown: "Manual operator-authored guidance",
			createdBy: "operator",
		});
		const initialProcedureCount = storage.procedures.length;
		const orch = createBuildplaneOrchestrator({
			projectRoot: root,
			storage,
			runtime: {
				executePacket: vi.fn().mockReturnValue(receipt),
			} as unknown as BuildplaneRuntimePort,
			policy: makeStrategyPolicy("missing tests"),
			workspace: makeWorkspace(root),
			memoryPort: makeMemoryPort(),
		});

		await orch.runStrategy(makeStrategyPacket());

		expect(storage.supersedeProcedure).not.toHaveBeenCalled();
		expect(storage.procedures).toHaveLength(initialProcedureCount);
		expect(storage.listProcedures({ taskType: "implement" })).toHaveLength(1);
		expect(
			storage.listProcedures({ taskType: "implement" })[0]?.bodyMarkdown,
		).toBe("Manual operator-authored guidance");
	});

	it("supersedes the active canonical procedure when the promoted workflow body changes", async () => {
		const root = mkdtempSync(join(tmpdir(), "bp-orch-strategy-supersede-"));
		const storage = makeProcedureAwareStorage();

		const firstOrchestrator = createBuildplaneOrchestrator({
			projectRoot: root,
			storage,
			runtime: {
				executePacket: vi.fn().mockReturnValue(receipt),
			} as unknown as BuildplaneRuntimePort,
			policy: makeStrategyPolicy("missing tests"),
			workspace: makeWorkspace(root),
			memoryPort: makeMemoryPort(),
		});
		await firstOrchestrator.runStrategy(makeStrategyPacket());

		const secondOrchestrator = createBuildplaneOrchestrator({
			projectRoot: root,
			storage,
			runtime: {
				executePacket: vi.fn().mockReturnValue(receipt),
			} as unknown as BuildplaneRuntimePort,
			policy: makeStrategyPolicy("missing type guards"),
			workspace: makeWorkspace(root),
			memoryPort: makeMemoryPort(),
		});
		await secondOrchestrator.runStrategy(makeStrategyPacket());

		expect(storage.createProcedure).toHaveBeenCalledTimes(2);
		expect(storage.supersedeProcedure).toHaveBeenCalledTimes(1);
		const activeProcedures = storage.listProcedures({ taskType: "implement" });
		expect(activeProcedures).toHaveLength(1);
		expect(activeProcedures[0]?.bodyMarkdown).toContain("missing type guards");
		expect(
			storage.procedures.filter(
				(procedure) => procedure.status === "superseded",
			),
		).toHaveLength(1);
	});
});
