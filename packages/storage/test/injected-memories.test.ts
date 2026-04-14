import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ApprovedPolicyDecision,
	ExecutionReceipt,
	InjectedMemoryRecord,
	UnitPacket,
} from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import { createBuildplaneStorage } from "../src";

const packet: UnitPacket = {
	unit: {
		id: "unit-injected-memory",
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

describe("injected memory persistence", () => {
	it("records injected memories and exposes them through inspect snapshots", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-injected-memories-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(packet);
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, receipt);
		storage.recordDecision(run.id, decision);
		storage.completeRun(run.id, "passed");

		const records: InjectedMemoryRecord[] = [
			{
				memoryKind: "repo-fact",
				memoryId: "fact-1",
				displayText: "[repo-fact] commands.typecheck: npx pnpm typecheck",
				matchReason: "fuzzy-fact-key",
				matchClass: "fuzzy",
				scopePreferenceIndex: 1,
			},
			{
				memoryKind: "procedure",
				memoryId: "procedure-1",
				displayText:
					"[procedure] fix TypeScript build: Run typecheck before touching imports.",
				matchReason: "exact-task-type",
				matchClass: "exact",
			},
		];

		storage.recordInjectedMemories(run.id, records);

		const listed = storage.listInjectedMemories(run.id);
		const inspect = storage.inspectTarget(run.id);

		expect(listed).toMatchObject([
			{
				runId: run.id,
				memoryKind: "repo-fact",
				memoryId: "fact-1",
				matchReason: "fuzzy-fact-key",
				scopePreferenceIndex: 1,
			},
			{
				runId: run.id,
				memoryKind: "procedure",
				memoryId: "procedure-1",
				matchReason: "exact-task-type",
			},
		]);
		expect(inspect.injectedMemories).toMatchObject([
			{
				memoryKind: "repo-fact",
				memoryId: "fact-1",
				displayText: "[repo-fact] commands.typecheck: npx pnpm typecheck",
			},
			{
				memoryKind: "procedure",
				memoryId: "procedure-1",
			},
		]);
	});

	it("replaces previously recorded injected memories for a run", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-injected-memories-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const run = storage.createRun(packet);
		storage.recordInjectedMemories(run.id, [
			{
				memoryKind: "repo-fact",
				memoryId: "fact-old",
				displayText: "[repo-fact] commands.old: old",
				matchReason: "fuzzy-fact-key",
				matchClass: "fuzzy",
			},
		]);
		storage.recordInjectedMemories(run.id, [
			{
				memoryKind: "searchable-document",
				memoryId: "doc-new",
				displayText:
					"[document] Build failure summary: The branch replay failed.",
				matchReason: "exact-title",
				matchClass: "exact",
			},
		]);

		expect(storage.listInjectedMemories(run.id)).toMatchObject([
			{
				runId: run.id,
				memoryKind: "searchable-document",
				memoryId: "doc-new",
				matchReason: "exact-title",
			},
		]);
	});
});
