import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
	ApprovedPolicyDecision,
	ExecutionReceipt,
	RejectedPolicyDecision,
	RunInfrastructureFailure,
	UnitPacket,
} from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import { createBuildplaneStorage } from "../src";
import {
	bootstrapStorageProjectionSchema,
	createStorageStore,
} from "../src/store";

const packet: UnitPacket = {
	unit: {
		id: "unit-1",
		kind: "command",
		scope: "task",
		inputRefs: [],
		expectedOutputs: ["tmp/out.txt"],
		verificationContract: "exit-0-and-required-outputs",
		policyProfile: "default",
	},
	execution: {
		command: "node",
		args: ["-e", "console.log('ok')"],
	},
	verification: {
		requiredOutputs: ["tmp/out.txt"],
	},
};

const receipt: ExecutionReceipt = {
	command: "node",
	args: ["-e", "console.log('ok')"],
	cwd: ".",
	startedAt: "2026-03-17T00:00:00.000Z",
	completedAt: "2026-03-17T00:00:01.000Z",
	exitCode: 0,
	stdout: "ok\n",
	stderr: "",
	outputChecks: [{ path: "tmp/out.txt", exists: true }],
};

const decision: ApprovedPolicyDecision = {
	kind: "advance-run",
	outcome: "approved",
	reasons: [],
};

const rejectedDecision: RejectedPolicyDecision = {
	kind: "reject-run",
	outcome: "rejected",
	reasons: ["command exited with code 1"],
};

const failedReceipt: ExecutionReceipt = {
	...receipt,
	exitCode: 1,
	outputChecks: [{ path: "tmp/missing.txt", exists: false }],
};

function openStateDatabase(root: string): DatabaseSync {
	return new DatabaseSync(join(root, ".buildplane", "state.db"));
}

function createWorkspacePath(root: string, runId: string): string {
	return join(root, ".buildplane", "workspaces", runId);
}

describe("storage adapter", () => {
	it("persists run state and query snapshots", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(packet);
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, receipt);
		storage.recordDecision(run.id, decision);
		const completedRun = storage.completeRun(run.id, "passed");

		const status = storage.getStatusSnapshot();
		const inspect = storage.inspectTarget(run.id);

		expect(completedRun.status).toBe("passed");
		expect(status.latestRun?.status).toBe("passed");
		expect(status.latestRunUsedWorkspace).toBe(false);
		expect(status.latestWorkspace).toBeUndefined();
		expect(status.actionableWorkspaces).toEqual([]);
		expect(status.runCounts.passed).toBe(1);
		expect(inspect.kind).toBe("run");
		expect(inspect.run.id).toBe(run.id);
		expect(inspect.workspace).toBeUndefined();
		expect(inspect.evidence[0].kind).toBe("command-exit");
		expect(inspect.evidence[0]?.message).toBeUndefined();
		expect(inspect.decisions[0].kind).toBe("advance-run");
		expect(
			existsSync(join(root, ".buildplane", "logs", `${run.id}.stdout.log`)),
		).toBe(true);

		const database = openStateDatabase(root);
		const eventKinds = database
			.prepare(`SELECT kind FROM events ORDER BY rowid ASC`)
			.all() as { kind: string }[];
		database.close();

		expect(eventKinds.map((row) => row.kind)).toEqual([
			"project-initialized",
			"run-created",
			"run-started",
			"execution-evidence-recorded",
			"decision-recorded",
			"run-completed",
		]);
	});

	it("persists retained workspaces for rejected runs and exposes workspace snapshots", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-workspaces-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(packet);
		const workspacePath = createWorkspacePath(root, run.id);

		storage.recordWorkspacePrepared(run.id, {
			path: workspacePath,
			headSha: "abc123",
			sourceProjectRoot: root,
		});

		const activeStatus = storage.getStatusSnapshot();
		expect(activeStatus.latestRunUsedWorkspace).toBe(true);
		expect(activeStatus.latestWorkspace).toMatchObject({
			runId: run.id,
			status: "active",
			headSha: "abc123",
		});
		expect(activeStatus.actionableWorkspaces).toEqual([]);

		storage.commitRunFailureOutcome(run.id, {
			decision: rejectedDecision,
			workspaceStatus: "retained",
		});

		const status = storage.getStatusSnapshot();
		expect(status.latestRunUsedWorkspace).toBe(true);
		expect(status.latestWorkspace).toMatchObject({
			runId: run.id,
			status: "retained",
			headSha: "abc123",
		});
		expect(status.actionableWorkspaces).toHaveLength(1);
		expect(status.actionableWorkspaces[0]?.path).toBe(workspacePath);

		const inspect = storage.inspectTarget(run.id);
		expect(inspect.workspace).toMatchObject({
			status: "retained",
			path: workspacePath,
		});
		expect(inspect.workspace?.finalizedAt).toEqual(expect.any(String));
	});

	it("persists infrastructure evidence for setup failures without fabricating a workspace row", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-setup-failure-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(packet);
		const infrastructureFailure: RunInfrastructureFailure = {
			kind: "workspace-prepare-failed",
			message: "git worktree add failed",
		};

		storage.commitRunFailureOutcome(run.id, {
			infrastructureFailure,
		});

		const status = storage.getStatusSnapshot();
		expect(status.latestRunUsedWorkspace).toBe(true);
		expect(status.latestWorkspace).toBeUndefined();
		expect(status.actionableWorkspaces).toEqual([]);

		const inspect = storage.inspectTarget(run.id);
		expect(inspect.workspace).toBeUndefined();
		expect(inspect.evidence).toContainEqual({
			id: expect.any(String),
			kind: infrastructureFailure.kind,
			status: "fail",
			message: infrastructureFailure.message,
		});

		const database = openStateDatabase(root);
		const workspaceCount = database
			.prepare(`SELECT COUNT(*) AS count FROM workspaces WHERE run_id = ?`)
			.get(run.id) as { count: number };
		database.close();

		expect(workspaceCount.count).toBe(0);
	});

	it("retains prepared workspaces and failure evidence together for post-prepare infrastructure failures", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-runtime-failure-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(packet);
		const workspacePath = createWorkspacePath(root, run.id);
		const infrastructureFailure: RunInfrastructureFailure = {
			kind: "runtime-execution-failed",
			message: "runtime crashed before completion",
		};

		storage.recordWorkspacePrepared(run.id, {
			path: workspacePath,
			headSha: "def456",
			sourceProjectRoot: root,
		});
		storage.commitRunFailureOutcome(run.id, {
			infrastructureFailure,
			workspaceStatus: "retained",
		});

		const status = storage.getStatusSnapshot();
		expect(status.latestRun?.status).toBe("failed");
		expect(status.latestRunUsedWorkspace).toBe(true);
		expect(status.latestWorkspace).toMatchObject({
			runId: run.id,
			status: "retained",
			path: workspacePath,
		});

		const inspect = storage.inspectTarget(run.id);
		expect(inspect.workspace).toMatchObject({
			status: "retained",
			path: workspacePath,
		});
		expect(inspect.evidence).toContainEqual({
			id: expect.any(String),
			kind: infrastructureFailure.kind,
			status: "fail",
			message: infrastructureFailure.message,
		});
	});

	it("marks successful workspaces as deleted without leaving actionable entries behind", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-deleted-workspace-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(packet);
		const workspacePath = createWorkspacePath(root, run.id);

		storage.recordWorkspacePrepared(run.id, {
			path: workspacePath,
			headSha: "abc123",
			sourceProjectRoot: root,
		});
		storage.markRunRunning(run.id);
		storage.commitRunSuccessOutcome(run.id, decision);
		storage.recordWorkspaceDeleted(run.id);

		const status = storage.getStatusSnapshot();
		expect(status.latestRun?.status).toBe("passed");
		expect(status.latestRunUsedWorkspace).toBe(true);
		expect(status.latestWorkspace).toMatchObject({
			runId: run.id,
			status: "deleted",
			path: workspacePath,
		});
		expect(status.actionableWorkspaces).toEqual([]);

		const inspect = storage.inspectTarget(run.id);
		expect(inspect.workspace).toMatchObject({
			status: "deleted",
			path: workspacePath,
		});
		expect(inspect.workspace?.finalizedAt).toEqual(expect.any(String));
	});

	it("copies workspace-backed required outputs into durable artifact storage", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-artifacts-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(packet);
		const workspacePath = createWorkspacePath(root, run.id);
		mkdirSync(join(workspacePath, "tmp"), { recursive: true });
		writeFileSync(join(workspacePath, "tmp", "out.txt"), "ok");

		storage.recordWorkspacePrepared(run.id, {
			path: workspacePath,
			headSha: "abc123",
			sourceProjectRoot: root,
		});
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, {
			...receipt,
			cwd: workspacePath,
		});
		storage.commitRunSuccessOutcome(run.id, decision);
		storage.recordWorkspaceDeleted(run.id);

		const inspect = storage.inspectTarget(run.id);
		expect(inspect.artifacts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "required-output",
					location: `.buildplane/artifacts/${run.id}/tmp/out.txt`,
				}),
			]),
		);
		expect(
			readFileSync(
				join(root, ".buildplane", "artifacts", run.id, "tmp", "out.txt"),
				"utf8",
			),
		).toBe("ok");
	});

	it("marks successful workspaces with cleanup failures as actionable", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-cleanup-failed-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(packet);
		const workspacePath = createWorkspacePath(root, run.id);

		storage.recordWorkspacePrepared(run.id, {
			path: workspacePath,
			headSha: "abc123",
			sourceProjectRoot: root,
		});
		storage.markRunRunning(run.id);
		storage.commitRunSuccessOutcome(run.id, decision);
		storage.recordWorkspaceCleanupFailed(run.id, "permission denied");

		const status = storage.getStatusSnapshot();
		expect(status.latestRun?.status).toBe("passed");
		expect(status.latestWorkspace).toMatchObject({
			runId: run.id,
			status: "cleanup-failed",
			cleanupError: "permission denied",
		});
		expect(status.actionableWorkspaces).toHaveLength(1);
		expect(status.actionableWorkspaces[0]).toMatchObject({
			runId: run.id,
			status: "cleanup-failed",
			path: workspacePath,
			cleanupError: "permission denied",
		});
	});

	it("marks retained workspaces as deleted when operator cleanup completes", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-cleaned-retained-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(packet);
		const workspacePath = createWorkspacePath(root, run.id);
		storage.recordWorkspacePrepared(run.id, {
			path: workspacePath,
			headSha: "abc123",
			sourceProjectRoot: root,
		});
		storage.commitRunFailureOutcome(run.id, {
			decision: rejectedDecision,
			workspaceStatus: "retained",
		});

		storage.recordWorkspaceCleanedUp(run.id);

		const status = storage.getStatusSnapshot();
		expect(status.actionableWorkspaces).toEqual([]);
		expect(status.latestWorkspace).toMatchObject({
			runId: run.id,
			status: "deleted",
			path: workspacePath,
		});
		const inspect = storage.inspectTarget(run.id);
		expect(inspect.workspace).toMatchObject({
			status: "deleted",
			path: workspacePath,
		});
	});

	it("marks cleanup-failed workspaces as deleted when operator cleanup completes", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-cleaned-failed-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(packet);
		const workspacePath = createWorkspacePath(root, run.id);
		storage.recordWorkspacePrepared(run.id, {
			path: workspacePath,
			headSha: "abc123",
			sourceProjectRoot: root,
		});
		storage.markRunRunning(run.id);
		storage.commitRunSuccessOutcome(run.id, decision);
		storage.recordWorkspaceCleanupFailed(run.id, "permission denied");

		storage.recordWorkspaceCleanedUp(run.id);

		const status = storage.getStatusSnapshot();
		expect(status.actionableWorkspaces).toEqual([]);
		expect(status.latestWorkspace).toMatchObject({
			runId: run.id,
			status: "deleted",
			path: workspacePath,
		});
		const inspect = storage.inspectTarget(run.id);
		expect(inspect.workspace).toMatchObject({
			status: "deleted",
			path: workspacePath,
		});
	});

	it("rejects operator cleanup for non-actionable workspaces", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-cleaned-invalid-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(packet);
		const workspacePath = createWorkspacePath(root, run.id);
		storage.recordWorkspacePrepared(run.id, {
			path: workspacePath,
			headSha: "abc123",
			sourceProjectRoot: root,
		});

		expect(() => storage.recordWorkspaceCleanedUp(run.id)).toThrow(
			/operator cleanup requires a retained or cleanup-failed workspace/i,
		);
	});

	it("returns actionable workspaces newest-first and excludes deleted workspaces", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-actionable-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const firstRun = storage.createRun(packet);
		storage.recordWorkspacePrepared(firstRun.id, {
			path: createWorkspacePath(root, firstRun.id),
			headSha: "head-1",
			sourceProjectRoot: root,
		});
		storage.commitRunFailureOutcome(firstRun.id, {
			decision: rejectedDecision,
			workspaceStatus: "retained",
		});

		const secondRun = storage.createRun({
			...packet,
			unit: { ...packet.unit, id: "unit-2" },
		});
		storage.recordWorkspacePrepared(secondRun.id, {
			path: createWorkspacePath(root, secondRun.id),
			headSha: "head-2",
			sourceProjectRoot: root,
		});
		storage.markRunRunning(secondRun.id);
		storage.commitRunSuccessOutcome(secondRun.id, decision);
		storage.recordWorkspaceDeleted(secondRun.id);

		const thirdRun = storage.createRun({
			...packet,
			unit: { ...packet.unit, id: "unit-3" },
		});
		storage.recordWorkspacePrepared(thirdRun.id, {
			path: createWorkspacePath(root, thirdRun.id),
			headSha: "head-3",
			sourceProjectRoot: root,
		});
		storage.markRunRunning(thirdRun.id);
		storage.commitRunSuccessOutcome(thirdRun.id, decision);
		storage.recordWorkspaceCleanupFailed(thirdRun.id, "disk busy");

		const fourthRun = storage.createRun({
			...packet,
			unit: { ...packet.unit, id: "unit-4" },
		});
		storage.recordWorkspacePrepared(fourthRun.id, {
			path: createWorkspacePath(root, fourthRun.id),
			headSha: "head-4",
			sourceProjectRoot: root,
		});
		storage.commitRunFailureOutcome(fourthRun.id, {
			decision: rejectedDecision,
			workspaceStatus: "retained",
		});

		const status = storage.getStatusSnapshot();
		expect(
			status.actionableWorkspaces.map((workspace) => workspace.runId),
		).toEqual([fourthRun.id, thirdRun.id, firstRun.id]);
		expect(
			status.actionableWorkspaces.map((workspace) => workspace.status),
		).toEqual(["retained", "cleanup-failed", "retained"]);
	});

	it("orders actionable workspaces by latest actionable transition time", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-actionable-order-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const firstRun = storage.createRun(packet);
		storage.recordWorkspacePrepared(firstRun.id, {
			path: createWorkspacePath(root, firstRun.id),
			headSha: "head-1",
			sourceProjectRoot: root,
		});
		storage.commitRunFailureOutcome(firstRun.id, {
			decision: rejectedDecision,
			workspaceStatus: "retained",
		});

		const secondRun = storage.createRun({
			...packet,
			unit: { ...packet.unit, id: "unit-order-2" },
		});
		storage.recordWorkspacePrepared(secondRun.id, {
			path: createWorkspacePath(root, secondRun.id),
			headSha: "head-2",
			sourceProjectRoot: root,
		});
		storage.markRunRunning(secondRun.id);
		storage.commitRunSuccessOutcome(secondRun.id, decision);
		storage.recordWorkspaceCleanupFailed(secondRun.id, "disk busy");

		const database = openStateDatabase(root);
		database
			.prepare(`UPDATE workspaces SET finalized_at = ? WHERE run_id = ?`)
			.run("2026-03-17T00:00:03.000Z", secondRun.id);
		database
			.prepare(`UPDATE workspaces SET finalized_at = ? WHERE run_id = ?`)
			.run("2026-03-17T00:00:04.000Z", firstRun.id);
		database.close();

		const status = storage.getStatusSnapshot();
		expect(
			status.actionableWorkspaces.map((workspace) => workspace.runId),
		).toEqual([firstRun.id, secondRun.id]);
	});

	it("writes workspace lifecycle events and projection rows together", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-projections-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(packet);
		const workspacePath = createWorkspacePath(root, run.id);

		storage.recordWorkspacePrepared(run.id, {
			path: workspacePath,
			headSha: "abc123",
			sourceProjectRoot: root,
		});
		storage.commitRunFailureOutcome(run.id, {
			decision: rejectedDecision,
			workspaceStatus: "retained",
		});

		const database = openStateDatabase(root);
		const eventKinds = database
			.prepare(
				`SELECT kind FROM events WHERE kind LIKE 'workspace-%' ORDER BY rowid ASC`,
			)
			.all() as { kind: string }[];
		const workspaceRow = database
			.prepare(
				`SELECT run_id, source_project_root, path, head_sha, status, finalized_at FROM workspaces WHERE run_id = ?`,
			)
			.get(run.id) as {
			run_id: string;
			source_project_root: string;
			path: string;
			head_sha: string;
			status: string;
			finalized_at: string | null;
		};
		database.close();

		expect(eventKinds.map((row) => row.kind)).toEqual([
			"workspace-prepared",
			"workspace-retained",
		]);
		expect(workspaceRow).toMatchObject({
			run_id: run.id,
			source_project_root: root,
			path: workspacePath,
			head_sha: "abc123",
			status: "retained",
		});
		expect(workspaceRow.finalized_at).toEqual(expect.any(String));
	});

	it("rolls back workspace preparation when a failpoint fires mid-transaction", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-failpoint-"));
		createBuildplaneStorage(root).initializeProject();
		const storage = createStorageStore(root, {
			testingHooks: {
				failpoint(name) {
					if (name === "recordWorkspacePrepared:after-workspace-upsert") {
						throw new Error("boom");
					}
				},
			},
		});

		const run = storage.createRun(packet);
		const workspacePath = createWorkspacePath(root, run.id);

		expect(() =>
			storage.recordWorkspacePrepared(run.id, {
				path: workspacePath,
				headSha: "abc123",
				sourceProjectRoot: root,
			}),
		).toThrow(/boom/);

		const database = openStateDatabase(root);
		const workspaceCount = database
			.prepare(`SELECT COUNT(*) AS count FROM workspaces WHERE run_id = ?`)
			.get(run.id) as { count: number };
		const eventCount = database
			.prepare(
				`SELECT COUNT(*) AS count FROM events WHERE kind = 'workspace-prepared'`,
			)
			.get() as { count: number };
		database.close();

		expect(workspaceCount.count).toBe(0);
		expect(eventCount.count).toBe(0);
		expect(storage.getStatusSnapshot().latestRunUsedWorkspace).toBe(false);
	});

	it("keeps per-run unit metadata snapshots when the same unit id runs again", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-history-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const firstPacket: UnitPacket = {
			...packet,
			unit: {
				...packet.unit,
				expectedOutputs: ["tmp/first.txt"],
			},
		};
		const secondPacket: UnitPacket = {
			...packet,
			unit: {
				...packet.unit,
				expectedOutputs: ["tmp/second.txt"],
			},
		};

		const firstRun = storage.createRun(firstPacket);
		storage.completeRun(firstRun.id, "passed");
		const secondRun = storage.createRun(secondPacket);
		storage.completeRun(secondRun.id, "passed");

		const inspect = storage.inspectTarget(firstRun.id);
		const unitInspect = storage.inspectTarget(packet.unit.id);

		expect(inspect.kind).toBe("run");
		expect(inspect.unit.expectedOutputs).toEqual(["tmp/first.txt"]);
		expect(unitInspect.kind).toBe("unit");
		expect(unitInspect.run.id).toBe(secondRun.id);
		expect(unitInspect.runHistory).toEqual([
			{ id: secondRun.id, status: "passed" },
			{ id: firstRun.id, status: "passed" },
		]);
	});

	it("surfaces strategy lineage and memory summary counts in inspect and history", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-strategy-history-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(
			{
				...packet,
				unit: { ...packet.unit, id: "unit-strategy-history" },
			},
			{ strategyId: "strategy-injected" },
		);
		storage.completeRun(run.id, "passed");
		storage.recordInjectedMemories(run.id, [
			{
				memoryKind: "repo-fact",
				memoryId: "fact-1",
				displayText: "[repo-fact] commands.typecheck: npx pnpm typecheck",
				matchReason: "fuzzy-fact-key",
				matchClass: "fuzzy",
			},
			{
				memoryKind: "procedure",
				memoryId: "procedure-1",
				displayText: "[procedure] fix TypeScript build: Run typecheck first.",
				matchReason: "exact-task-type",
				matchClass: "exact",
			},
		]);
		storage.createProcedure({
			name: "implement-then-review workflow for implement tasks",
			taskType: "implement",
			bodyMarkdown:
				"Use an implement-then-review workflow for implement tasks.\n\nObserved learning: missing type guards.",
			createdBy: "worker",
			sourceRunId: run.id,
			sourceTaskId: "task-implementer",
			metadata: {
				promotionRule: "multi-round-strategy-workflow->procedure",
				strategyMode: "implement-then-review",
			},
		});

		const inspect = storage.inspectTarget(run.id);
		const unitInspect = storage.inspectTarget("unit-strategy-history");
		const history = storage.getRunHistory();

		expect(inspect.strategy).toEqual({ strategyId: "strategy-injected" });
		expect(inspect.provenance).toMatchObject({
			route: {
				worker: "command",
				source: "command-block",
			},
			policy: {
				profile: "default",
			},
		});
		expect(unitInspect.strategy).toEqual({ strategyId: "strategy-injected" });
		expect(unitInspect.provenance).toMatchObject({
			route: {
				worker: "command",
				source: "command-block",
			},
			policy: {
				profile: "default",
			},
		});
		expect(history[0]).toMatchObject({
			id: run.id,
			strategyId: "strategy-injected",
			injectedMemoryCount: 2,
			promotedStructuredMemoryCount: 1,
		});
	});

	it("surfaces promoted procedure lineage in inspect snapshots, including superseded records", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-promotion-lineage-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun({
			...packet,
			unit: { ...packet.unit, id: "unit-promotion-lineage" },
		});
		storage.completeRun(run.id, "passed");

		const firstProcedure = storage.createProcedure({
			name: "implement-then-review workflow for implement tasks",
			taskType: "implement",
			bodyMarkdown:
				"Use an implement-then-review workflow for implement tasks.\n\nObserved learning: missing tests.",
			createdBy: "worker",
			sourceRunId: run.id,
			sourceTaskId: "task-implementer",
			metadata: {
				promotionRule: "multi-round-strategy-workflow->procedure",
				strategyMode: "implement-then-review",
			},
		});
		storage.supersedeProcedure(firstProcedure.id);
		const secondProcedure = storage.createProcedure({
			name: "implement-then-review workflow for implement tasks",
			taskType: "implement",
			bodyMarkdown:
				"Use an implement-then-review workflow for implement tasks.\n\nObserved learning: missing type guards.",
			createdBy: "worker",
			sourceRunId: run.id,
			sourceTaskId: "task-implementer",
			metadata: {
				promotionRule: "multi-round-strategy-workflow->procedure",
				strategyMode: "implement-then-review",
			},
		});

		const inspect = storage.inspectTarget(run.id);
		const unitInspect = storage.inspectTarget("unit-promotion-lineage");

		expect(inspect.promotedStructuredMemories).toHaveLength(2);
		expect(inspect.promotedStructuredMemories).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					memoryKind: "procedure",
					memoryId: firstProcedure.id,
					status: "superseded",
					promotionRule: "multi-round-strategy-workflow->procedure",
					sourceRunId: run.id,
					sourceTaskId: "task-implementer",
				}),
				expect.objectContaining({
					memoryKind: "procedure",
					memoryId: secondProcedure.id,
					status: "active",
					promotionRule: "multi-round-strategy-workflow->procedure",
					sourceRunId: run.id,
				}),
			]),
		);
		expect(unitInspect.promotedStructuredMemories).toEqual(
			inspect.promotedStructuredMemories,
		);
	});

	it("surfaces model routing provenance when a worker hint is present", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-model-provenance-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const modelRun = storage.createRun({
			unit: {
				...packet.unit,
				id: "unit-model-provenance",
				kind: "model",
			},
			model: {
				provider: "openai",
				model: "gpt-5.4",
			},
			routingHints: {
				preferredWorker: "codex",
				preferredModel: "gpt-5.4",
				effort: "high",
			},
			verification: {
				requiredOutputs: [],
			},
		});
		storage.completeRun(modelRun.id, "passed");

		const inspect = storage.inspectTarget(modelRun.id);
		expect(inspect.provenance).toMatchObject({
			route: {
				worker: "codex",
				source: "routing-hints",
				provider: "openai",
				model: "gpt-5.4",
				preferredWorker: "codex",
				preferredModel: "gpt-5.4",
				effort: "high",
			},
			policy: {
				profile: "default",
			},
		});
	});

	it("rejects invalid failure-outcome payload combinations", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-invalid-failure-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const rejectedRun = storage.createRun(packet);
		expect(() =>
			storage.commitRunFailureOutcome(rejectedRun.id, {
				decision: rejectedDecision,
			}),
		).toThrow(/retained/i);

		const preparedRun = storage.createRun({
			...packet,
			unit: { ...packet.unit, id: "unit-prepared" },
		});
		storage.recordWorkspacePrepared(preparedRun.id, {
			path: createWorkspacePath(root, preparedRun.id),
			headSha: "abc123",
			sourceProjectRoot: root,
		});
		expect(() =>
			storage.commitRunFailureOutcome(preparedRun.id, {
				infrastructureFailure: {
					kind: "runtime-failed",
					message: "boom",
				},
			}),
		).toThrow(/retained/i);

		const contradictoryRun = storage.createRun({
			...packet,
			unit: { ...packet.unit, id: "unit-contradictory" },
		});
		storage.recordWorkspacePrepared(contradictoryRun.id, {
			path: createWorkspacePath(root, contradictoryRun.id),
			headSha: "def456",
			sourceProjectRoot: root,
		});
		expect(() =>
			storage.commitRunFailureOutcome(contradictoryRun.id, {
				decision: decision as unknown as RejectedPolicyDecision,
				workspaceStatus: "retained",
			}),
		).toThrow(/rejected/i);

		const successRun = storage.createRun({
			...packet,
			unit: { ...packet.unit, id: "unit-invalid-success" },
		});
		expect(() =>
			storage.commitRunSuccessOutcome(
				successRun.id,
				rejectedDecision as unknown as ApprovedPolicyDecision,
			),
		).toThrow(/approved/i);
	});

	it("rejects invalid workspace finalization transitions", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-store-invalid-workspace-"),
		);
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(packet);
		storage.recordWorkspacePrepared(run.id, {
			path: createWorkspacePath(root, run.id),
			headSha: "abc123",
			sourceProjectRoot: root,
		});

		expect(() => storage.recordWorkspaceDeleted(run.id)).toThrow(/passed/i);
		expect(() => storage.recordWorkspaceCleanupFailed(run.id, "boom")).toThrow(
			/passed/i,
		);

		storage.commitRunFailureOutcome(run.id, {
			decision: rejectedDecision,
			workspaceStatus: "retained",
		});

		expect(() => storage.recordWorkspaceCleanupFailed(run.id, "boom")).toThrow(
			/active workspace/i,
		);
	});

	it("rejects invalid terminal-state transitions", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-terminal-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const completedRun = storage.createRun(packet);
		storage.completeRun(completedRun.id, "passed");
		expect(() => storage.markRunRunning(completedRun.id)).toThrow(/pending/i);
		expect(() => storage.completeRun(completedRun.id, "failed")).toThrow(
			/pending|running/i,
		);
		expect(() =>
			storage.recordWorkspacePrepared(completedRun.id, {
				path: createWorkspacePath(root, completedRun.id),
				headSha: "abc123",
				sourceProjectRoot: root,
			}),
		).toThrow(/pending/i);

		const successRun = storage.createRun({
			...packet,
			unit: { ...packet.unit, id: "unit-terminal-success" },
		});
		storage.markRunRunning(successRun.id);
		storage.commitRunSuccessOutcome(successRun.id, decision);
		expect(() =>
			storage.commitRunSuccessOutcome(successRun.id, decision),
		).toThrow(/running/i);
		expect(() =>
			storage.commitRunFailureOutcome(successRun.id, {
				infrastructureFailure: {
					kind: "late-failure",
					message: "too late",
				},
			}),
		).toThrow(/terminal|pending|running/i);

		const preparedRun = storage.createRun({
			...packet,
			unit: { ...packet.unit, id: "unit-terminal-prepared" },
		});
		storage.recordWorkspacePrepared(preparedRun.id, {
			path: createWorkspacePath(root, preparedRun.id),
			headSha: "def456",
			sourceProjectRoot: root,
		});
		expect(() => storage.completeRun(preparedRun.id, "passed")).toThrow(
			/workspace-backed|commitRun/i,
		);
		expect(() =>
			storage.recordWorkspacePrepared(preparedRun.id, {
				path: createWorkspacePath(root, `${preparedRun.id}-again`),
				headSha: "ghi789",
				sourceProjectRoot: root,
			}),
		).toThrow(/already exists/i);
	});

	it("rejects writes for unknown runs and does not create artifacts for missing outputs", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-errors-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		expect(() => storage.markRunRunning("missing-run")).toThrow(
			/No run found/i,
		);
		expect(() =>
			storage.recordExecutionEvidence("missing-run", failedReceipt),
		).toThrow(/No run found/i);
		expect(() => storage.recordDecision("missing-run", decision)).toThrow(
			/No run found/i,
		);
		expect(() => storage.completeRun("missing-run", "passed")).toThrow(
			/No run found/i,
		);
		expect(() =>
			storage.recordWorkspacePrepared("missing-run", {
				path: createWorkspacePath(root, "missing-run"),
				headSha: "abc123",
				sourceProjectRoot: root,
			}),
		).toThrow(/No run found/i);

		const run = storage.createRun(packet);
		storage.recordExecutionEvidence(run.id, failedReceipt);
		const inspect = storage.inspectTarget(run.id);

		expect(inspect.artifacts).toEqual([]);
	});

	it("fails query access when projection tables are missing instead of silently recreating them", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-store-corrupt-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		storage.createRun(packet);

		const database = openStateDatabase(root);
		database.exec(`DROP TABLE runs;`);
		database.close();

		expect(() => storage.getStatusSnapshot()).toThrow(
			/missing required projection schema|repair/i,
		);
	});

	it("bootstraps run_learnings table on fresh init", () => {
		const dir = mkdtempSync(join(tmpdir(), "bp-store-learnings-"));
		const db = new DatabaseSync(join(dir, "state.db"));
		bootstrapStorageProjectionSchema(db);
		const tables = db
			.prepare(
				`SELECT name FROM sqlite_master WHERE type='table' AND name='run_learnings'`,
			)
			.all() as { name: string }[];
		expect(tables).toHaveLength(1);
		db.close();
	});

	it("run_learnings migration is idempotent", () => {
		const dir = mkdtempSync(join(tmpdir(), "bp-store-learnings-idem-"));
		const db = new DatabaseSync(join(dir, "state.db"));
		bootstrapStorageProjectionSchema(db);
		expect(() => bootstrapStorageProjectionSchema(db)).not.toThrow();
		db.close();
	});
});
