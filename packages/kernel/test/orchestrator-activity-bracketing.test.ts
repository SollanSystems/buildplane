import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type BuildplanePolicyPort,
	type BuildplaneRuntimePort,
	type BuildplaneStoragePort,
	type BuildplaneWorkspacePort,
	createBuildplaneOrchestrator,
	createEventBus,
	type ExecutionReceipt,
	type LedgerActivityCompleteInput,
	type LedgerActivityPort,
	type LedgerActivityStartInput,
	type PolicyDecision,
	type Run,
	type RunAdmissionLocalEvidenceStore,
	type UnitPacket,
} from "../src/index.js";

function createPacket(overrides: Partial<UnitPacket> = {}): UnitPacket {
	return {
		unit: {
			id: "unit-1",
			kind: "implementation",
			scope: "packages/kernel/src/**",
			inputRefs: ["task:t_4fe3fbf7"],
			expectedOutputs: ["packages/kernel/src/orchestrator.ts"],
			verificationContract: "pnpm --filter @buildplane/kernel test",
			policyProfile: "default",
		},
		execution: {
			command: "node",
			args: ["-e", "console.log('ok')"],
			cwd: ".",
		},
		verification: {
			requiredOutputs: ["packages/kernel/src/orchestrator.ts"],
		},
		provenance_ref: "",
		...overrides,
	};
}

function passingReceipt(cwd: string): ExecutionReceipt {
	return {
		command: "node",
		args: ["-e", "console.log('ok')"],
		cwd,
		startedAt: "2026-05-09T00:00:00.000Z",
		completedAt: "2026-05-09T00:00:01.000Z",
		exitCode: 0,
		stdout: "ok\n",
		stderr: "",
		outputChecks: [],
	};
}

interface FakePort extends LedgerActivityPort {
	readonly startInputs: LedgerActivityStartInput[];
	readonly completeInputs: LedgerActivityCompleteInput[];
}

interface HarnessOptions {
	readonly packet?: UnitPacket;
	readonly ledgerActivityPort?: LedgerActivityPort;
	readonly callLog?: string[];
}

interface Harness {
	readonly projectRoot: string;
	readonly packet: UnitPacket;
	readonly runtime: {
		executePacket: ReturnType<typeof vi.fn>;
		executePacketAsync: ReturnType<typeof vi.fn>;
	};
	readonly orchestrator: ReturnType<typeof createBuildplaneOrchestrator>;
	cleanup(): void;
}

function createHarness(options: HarnessOptions = {}): Harness {
	const projectRoot = mkdtempSync(
		join(tmpdir(), "buildplane-kernel-activity-"),
	);
	const packet = options.packet ?? createPacket();
	const callLog = options.callLog ?? [];
	const run: Run = {
		id: "run-1",
		unitId: packet.unit.id,
		status: "pending",
	};

	const storage = {
		initializeProject: vi.fn(),
		createRun: vi.fn((createdPacket: UnitPacket) => ({
			...run,
			unitId: createdPacket.unit.id,
		})),
		recordWorkspacePrepared: vi.fn(),
		markRunRunning: vi.fn(() => ({ ...run, status: "running" })),
		recordExecutionEvidence: vi.fn(),
		commitRunSuccessOutcome: vi.fn(() => ({ ...run, status: "passed" })),
		commitRunFailureOutcome: vi.fn(() => ({ ...run, status: "failed" })),
		recordWorkspaceCleanupFailed: vi.fn(),
		suspendRun: vi.fn(() => ({ ...run, status: "suspended" })),
		approveRun: vi.fn(() => ({ ...run, status: "running" })),
		rejectSuspendedRun: vi.fn(() => ({ ...run, status: "failed" })),
		upsertRepoFact: vi.fn((input) => ({
			id: "fact-1",
			...input,
			createdAt: "2026-05-09T00:00:00.000Z",
			updatedAt: "2026-05-09T00:00:00.000Z",
		})),
		listRepoFacts: vi.fn(() => []),
		listLearnings: vi.fn(() => []),
		addDocument: vi.fn(),
		searchDocuments: vi.fn(() => []),
		getStatusSnapshot: vi.fn(() => ({
			projectInitialized: true,
			runs: [],
			units: [],
		})),
		inspectTarget: vi.fn(() => ({
			targetType: "run" as const,
			id: run.id,
			run,
			recentEvents: [],
		})),
	} as unknown as BuildplaneStoragePort;

	const workspace: BuildplaneWorkspacePort = {
		assertRunnableRepository: vi.fn(() => ({ headSha: "abc123" })),
		checkWorktreeClean: vi.fn().mockReturnValue(true),
		prepareWorkspace: vi.fn((_projectRoot, runId, headSha) => {
			const path = join(projectRoot, ".buildplane", "workspaces", runId);
			mkdirSync(path, { recursive: true });
			return { path, headSha };
		}),
		deleteWorkspace: vi.fn(() => ({ deleted: true })),
	};

	const runtime = {
		executePacket: vi.fn((_packet: UnitPacket, cwd: string) => {
			callLog.push("invoke");
			return passingReceipt(cwd);
		}),
		executePacketAsync: vi.fn(async (_packet: UnitPacket, cwd: string) => {
			callLog.push("invoke");
			return passingReceipt(cwd);
		}),
	};

	const policy: BuildplanePolicyPort = {
		evaluateRun: vi.fn(
			() =>
				({
					kind: "advance-run",
					outcome: "approved",
					reasons: ["ok"],
				}) satisfies PolicyDecision,
		),
	};

	const admissionStore: RunAdmissionLocalEvidenceStore = {
		writeReceiptArtifact: vi.fn((input) => ({
			ref: `artifact://${input.receipt.receipt_id}`,
			path: join(
				projectRoot,
				".buildplane",
				"artifacts",
				`${input.receipt.receipt_id}.json`,
			),
		})),
		appendAdmissionEvent: vi.fn((input) => ({
			ref: `event://${input.event.payload.receipt_id}`,
		})),
	};

	const bus = createEventBus();

	const orchestrator = createBuildplaneOrchestrator({
		projectRoot,
		storage,
		runtime: runtime as unknown as BuildplaneRuntimePort,
		policy,
		workspace,
		eventBus: bus,
		admissionStore,
		ledgerActivityPort: options.ledgerActivityPort,
	});

	return {
		projectRoot,
		packet,
		runtime,
		orchestrator,
		cleanup() {
			rmSync(projectRoot, { recursive: true, force: true });
		},
	};
}

describe("orchestrator activity bracketing", () => {
	const cleanup: Array<() => void> = [];
	afterEach(() => {
		while (cleanup.length > 0) cleanup.pop()?.();
	});

	it("brackets the activity: started before invoke, completed after", async () => {
		const callLog: string[] = [];
		const startInputs: LedgerActivityStartInput[] = [];
		const completeInputs: LedgerActivityCompleteInput[] = [];
		const port: FakePort = {
			startInputs,
			completeInputs,
			async activityStarted(i) {
				callLog.push("started");
				startInputs.push(i);
			},
			async activityCompleted(i) {
				callLog.push("completed");
				completeInputs.push(i);
			},
		};
		const harness = createHarness({ ledgerActivityPort: port, callLog });
		cleanup.push(harness.cleanup);

		const result = await harness.orchestrator.runPacketAsync(harness.packet);

		expect(result.run.status).toBe("passed");
		expect(callLog).toEqual(["started", "invoke", "completed"]);
		expect(startInputs).toHaveLength(1);
		expect(completeInputs).toHaveLength(1);
		expect(startInputs[0]).toMatchObject({
			runId: "run-1",
			activityType: "command",
		});
		expect(startInputs[0]?.activityId).toBeTruthy();
		// paired: completed carries the same activity id
		expect(completeInputs[0]?.activityId).toBe(startInputs[0]?.activityId);
		expect(startInputs[0]?.runId).toBe(completeInputs[0]?.runId);
		// completed carries the recorded result
		expect(completeInputs[0]?.result).toBeTruthy();
	});

	it("awaits activityStarted before invoking the runtime (write-ahead order)", async () => {
		const callLog: string[] = [];
		let releaseStarted: (() => void) | undefined;
		const startedGate = new Promise<void>((resolveGate) => {
			releaseStarted = resolveGate;
		});
		const port: LedgerActivityPort = {
			async activityStarted() {
				callLog.push("started-enter");
				await startedGate;
				callLog.push("started-resolve");
			},
			async activityCompleted() {
				callLog.push("completed");
			},
		};
		const harness = createHarness({ ledgerActivityPort: port, callLog });
		cleanup.push(harness.cleanup);

		const runPromise = harness.orchestrator.runPacketAsync(harness.packet);
		// Let microtasks flush; the runtime must NOT have been invoked yet because
		// activityStarted is still pending on the gate.
		await new Promise((r) => setTimeout(r, 10));
		expect(harness.runtime.executePacketAsync).not.toHaveBeenCalled();
		expect(callLog).toEqual(["started-enter"]);

		releaseStarted?.();
		const result = await runPromise;
		expect(result.run.status).toBe("passed");
		expect(harness.runtime.executePacketAsync).toHaveBeenCalledTimes(1);
		expect(callLog).toEqual([
			"started-enter",
			"started-resolve",
			"invoke",
			"completed",
		]);
	});

	it("skips bracketing (byte-unchanged) when no port is injected", async () => {
		const callLog: string[] = [];
		const harness = createHarness({ callLog });
		cleanup.push(harness.cleanup);

		const result = await harness.orchestrator.runPacketAsync(harness.packet);

		expect(result.run.status).toBe("passed");
		expect(harness.runtime.executePacketAsync).toHaveBeenCalledTimes(1);
		expect(callLog).toEqual(["invoke"]);
	});

	it("reports model activity type for model packets", async () => {
		const startInputs: LedgerActivityStartInput[] = [];
		const port: LedgerActivityPort = {
			async activityStarted(i) {
				startInputs.push(i);
			},
			async activityCompleted() {},
		};
		const packet = createPacket({
			execution: undefined,
			model: {
				provider: "test-provider",
				model: "test-model",
				prompt: "Summarize the local fixture.",
			},
		});
		const harness = createHarness({
			packet,
			ledgerActivityPort: port,
		});
		cleanup.push(harness.cleanup);

		await harness.orchestrator.runPacketAsync(packet);

		expect(startInputs[0]?.activityType).toBe("model");
	});
});
