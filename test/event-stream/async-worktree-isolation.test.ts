import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createEventBus,
	type ExecutionEvent,
} from "../../packages/kernel/src/events";
import { createBuildplaneOrchestrator } from "../../packages/kernel/src/orchestrator";
import type { UnitPacket } from "../../packages/kernel/src/run-loop";
import { evaluateBudgets } from "../../packages/policy/src/budgets";
import { evaluateRun } from "../../packages/policy/src/decision";
import { createMockStorage as createSharedMockStorage } from "../helpers/mock-storage";

function makeCommandPacket(): UnitPacket {
	return {
		unit: {
			id: "unit-worktree-test",
			kind: "command",
			scope: "task",
			inputRefs: [],
			expectedOutputs: [],
			verificationContract: "exit-0",
			policyProfile: "default",
		},
		execution: {
			command: "echo",
			args: ["hello"],
		},
		verification: { requiredOutputs: [] },
	};
}

function makeMockStorage() {
	return createSharedMockStorage();
}

describe("async worktree isolation", () => {
	it("uses the worktree path from prepareWorkspace, not projectRoot", async () => {
		const projectRoot = realpathSync(
			mkdtempSync(join(tmpdir(), "bp-wt-project-")),
		);
		const worktreeRoot = realpathSync(
			mkdtempSync(join(tmpdir(), "bp-wt-workspace-")),
		);

		// These should be different paths
		expect(worktreeRoot).not.toBe(projectRoot);

		const executedInPaths: string[] = [];
		const mockRuntime = {
			executePacket: (_pkt: UnitPacket, root: string) => {
				executedInPaths.push(root);
				return {
					command: "echo",
					args: [],
					cwd: root,
					startedAt: new Date().toISOString(),
					completedAt: new Date().toISOString(),
					exitCode: 0,
					stdout: "hello",
					stderr: "",
					outputChecks: [],
				};
			},
		};

		const bus = createEventBus();
		const orchestrator = createBuildplaneOrchestrator({
			projectRoot,
			storage: makeMockStorage(),
			runtime: mockRuntime,
			policy: { evaluateRun, evaluateBudgets },
			workspace: {
				assertRunnableRepository: () => ({ headSha: "abc" }),
				prepareWorkspace: () => ({ path: worktreeRoot, headSha: "abc" }),
				deleteWorkspace: () => ({ deleted: true }),
			},
			eventBus: bus,
		});

		const result = await orchestrator.runPacketAsync(makeCommandPacket(), bus);

		expect(result.run.status).toBe("passed");
		// Execution must have happened inside the worktree, not the project root
		expect(executedInPaths).toHaveLength(1);
		expect(executedInPaths[0]).toBe(worktreeRoot);
		expect(executedInPaths[0]).not.toBe(projectRoot);
	});

	it("cleans up the workspace after a successful run", async () => {
		const projectRoot = realpathSync(
			mkdtempSync(join(tmpdir(), "bp-wt-project-")),
		);
		const worktreeRoot = realpathSync(
			mkdtempSync(join(tmpdir(), "bp-wt-workspace-")),
		);

		const deletedPaths: string[] = [];
		const mockRuntime = {
			executePacket: (_pkt: UnitPacket, root: string) => ({
				command: "echo",
				args: [],
				cwd: root,
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
				exitCode: 0,
				stdout: "",
				stderr: "",
				outputChecks: [],
			}),
		};

		const bus = createEventBus();
		const orchestrator = createBuildplaneOrchestrator({
			projectRoot,
			storage: makeMockStorage(),
			runtime: mockRuntime,
			policy: { evaluateRun, evaluateBudgets },
			workspace: {
				assertRunnableRepository: () => ({ headSha: "abc" }),
				prepareWorkspace: () => ({ path: worktreeRoot, headSha: "abc" }),
				deleteWorkspace: ({ path }) => {
					deletedPaths.push(path);
					return { deleted: true };
				},
			},
			eventBus: bus,
		});

		await orchestrator.runPacketAsync(makeCommandPacket(), bus);

		expect(deletedPaths).toHaveLength(1);
		expect(deletedPaths[0]).toBe(worktreeRoot);
	});

	it("retains the workspace after a failed run", async () => {
		const projectRoot = realpathSync(
			mkdtempSync(join(tmpdir(), "bp-wt-project-")),
		);
		const worktreeRoot = realpathSync(
			mkdtempSync(join(tmpdir(), "bp-wt-workspace-")),
		);

		const deletedPaths: string[] = [];
		const mockRuntime = {
			executePacket: (_pkt: UnitPacket, root: string) => ({
				command: "echo",
				args: [],
				cwd: root,
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
				exitCode: 1, // fail
				stdout: "",
				stderr: "something went wrong",
				outputChecks: [],
			}),
		};

		const bus = createEventBus();
		const orchestrator = createBuildplaneOrchestrator({
			projectRoot,
			storage: makeMockStorage(),
			runtime: mockRuntime,
			policy: { evaluateRun, evaluateBudgets },
			workspace: {
				assertRunnableRepository: () => ({ headSha: "abc" }),
				prepareWorkspace: () => ({ path: worktreeRoot, headSha: "abc" }),
				deleteWorkspace: ({ path }) => {
					deletedPaths.push(path);
					return { deleted: true };
				},
			},
			eventBus: bus,
		});

		const result = await orchestrator.runPacketAsync(makeCommandPacket(), bus);

		// Failed runs retain the workspace (not deleted) for inspection
		expect(result.run.status).toBe("failed");
		expect(deletedPaths).toHaveLength(0);
		expect(result.workspace?.status).toBe("retained");
	});

	it("fails run when workspace preparation throws", async () => {
		const projectRoot = realpathSync(
			mkdtempSync(join(tmpdir(), "bp-wt-project-")),
		);

		const mockRuntime = {
			executePacket: () => {
				throw new Error("should not be called");
			},
		};

		const bus = createEventBus();
		const events: ExecutionEvent[] = [];
		bus.subscribe((e) => events.push(e));

		const orchestrator = createBuildplaneOrchestrator({
			projectRoot,
			storage: makeMockStorage(),
			runtime: mockRuntime,
			policy: { evaluateRun, evaluateBudgets },
			workspace: {
				assertRunnableRepository: () => ({ headSha: "abc" }),
				prepareWorkspace: () => {
					throw new Error("git worktree add failed");
				},
				deleteWorkspace: () => ({ deleted: true }),
			},
			eventBus: bus,
		});

		const result = await orchestrator.runPacketAsync(makeCommandPacket(), bus);

		expect(result.run.status).toBe("failed");
		const errEvent = events.find((e) => e.kind === "execution-error");
		expect(errEvent).toBeDefined();
		if (errEvent?.kind === "execution-error") {
			expect(errEvent.message).toContain("git worktree add failed");
			expect(errEvent.phase).toBe("workspace-prepare");
		}
	});
});
