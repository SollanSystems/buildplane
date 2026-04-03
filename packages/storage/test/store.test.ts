import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
	ExecutionReceipt,
	PolicyDecision,
	UnitPacket,
} from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import { createBuildplaneStorage } from "../src";

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

const decision: PolicyDecision = {
	kind: "advance-run",
	outcome: "approved",
	reasons: [],
};

const failedReceipt: ExecutionReceipt = {
	...receipt,
	exitCode: 1,
	outputChecks: [{ path: "tmp/missing.txt", exists: false }],
};

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
		expect(status.runCounts.passed).toBe(1);
		expect(inspect.kind).toBe("run");
		expect(inspect.run.id).toBe(run.id);
		expect(inspect.evidence[0].kind).toBe("command-exit");
		expect(inspect.decisions[0].kind).toBe("advance-run");
		expect(
			existsSync(join(root, ".buildplane", "logs", `${run.id}.stdout.log`)),
		).toBe(true);

		const database = new DatabaseSync(join(root, ".buildplane", "state.db"));
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

		const database = new DatabaseSync(join(root, ".buildplane", "state.db"));
		database.exec(`DROP TABLE runs;`);
		database.close();

		expect(() => storage.getStatusSnapshot()).toThrow(
			/missing required projection schema|repair/i,
		);
	});
});
