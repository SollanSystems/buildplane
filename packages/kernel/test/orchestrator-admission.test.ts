import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AdmittedPlanReader,
	type BuildplanePolicyPort,
	type BuildplaneRuntimePort,
	type BuildplaneStoragePort,
	type BuildplaneWorkspacePort,
	createBuildplaneOrchestrator,
	createEventBus,
	type ExecutionReceipt,
	type PolicyDecision,
	type Run,
	type RunAdmissionEventAppendInput,
	type RunAdmissionLocalEvidenceStore,
	type RunAdmissionReceiptArtifactWriteInput,
	type RunAdmissionRecordedPayload,
	type UnitPacket,
} from "../src/index.js";

function credentialShapedSentinel(parts: readonly string[]): string {
	return parts.join("");
}

const FAKE_OPERATOR_TOKEN = credentialShapedSentinel([
	"gh",
	"p_FAKE_SECRET_SENTINEL_DO_NOT_USE_1234567890",
]);

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

interface HarnessOptions {
	readonly packet?: UnitPacket;
	readonly admissionStore?: RunAdmissionLocalEvidenceStore | null;
	readonly appendAdmissionEvent?: RunAdmissionLocalEvidenceStore["appendAdmissionEvent"];
	readonly writeReceiptArtifact?: RunAdmissionLocalEvidenceStore["writeReceiptArtifact"];
	readonly worktreeClean?: boolean;
	readonly admittedPlanReader?: AdmittedPlanReader;
}

interface Harness {
	readonly projectRoot: string;
	readonly packet: UnitPacket;
	readonly runEvents: string[];
	readonly runtime: BuildplaneRuntimePort;
	readonly artifacts: RunAdmissionReceiptArtifactWriteInput[];
	readonly admissionEvents: RunAdmissionEventAppendInput[];
	readonly admissionPayloads: RunAdmissionRecordedPayload[];
	readonly orchestrator: ReturnType<typeof createBuildplaneOrchestrator>;
	cleanup(): void;
}

function createHarness(options: HarnessOptions = {}): Harness {
	const projectRoot = mkdtempSync(
		join(tmpdir(), "buildplane-kernel-admission-"),
	);
	const packet = options.packet ?? createPacket();
	const runEvents: string[] = [];
	const artifacts: RunAdmissionReceiptArtifactWriteInput[] = [];
	const admissionEvents: RunAdmissionEventAppendInput[] = [];
	const admissionPayloads: RunAdmissionRecordedPayload[] = [];
	const run: Run = {
		id: "run-1",
		unitId: packet.unit.id,
		status: "pending",
	};

	const storage: BuildplaneStoragePort = {
		initializeProject: vi.fn(),
		createRun: vi.fn((createdPacket: UnitPacket) => {
			runEvents.push("create-run");
			return { ...run, unitId: createdPacket.unit.id };
		}),
		recordWorkspacePrepared: vi.fn(() => {
			runEvents.push("workspace-prepared");
		}),
		markRunRunning: vi.fn(() => {
			runEvents.push("run-started");
			return { ...run, status: "running" };
		}),
		recordExecutionEvidence: vi.fn(() => {
			runEvents.push("record-execution-evidence");
		}),
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
	};

	const workspace: BuildplaneWorkspacePort = {
		assertRunnableRepository: vi.fn(() => ({ headSha: "abc123" })),
		checkWorktreeClean: vi.fn().mockReturnValue(options.worktreeClean ?? true),
		prepareWorkspace: vi.fn((_projectRoot, runId, headSha) => {
			runEvents.push("prepare-workspace");
			const path = join(projectRoot, ".buildplane", "workspaces", runId);
			mkdirSync(path, { recursive: true });
			return {
				path,
				headSha,
			};
		}),
		deleteWorkspace: vi.fn(() => ({ deleted: true })),
	};

	const runtime: BuildplaneRuntimePort = {
		executePacket: vi.fn((_packet, cwd) => {
			runEvents.push("runtime");
			return passingReceipt(cwd);
		}),
		executePacketAsync: vi.fn(async (_packet, cwd) => {
			runEvents.push("runtime");
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

	const defaultAdmissionStore: RunAdmissionLocalEvidenceStore = {
		writeReceiptArtifact:
			options.writeReceiptArtifact ??
			vi.fn((input) => {
				runEvents.push("write-admission-artifact");
				artifacts.push(input);
				return {
					ref: `artifact://${input.receipt.receipt_id}`,
					path: join(
						projectRoot,
						".buildplane",
						"artifacts",
						`${input.receipt.receipt_id}.json`,
					),
				};
			}),
		appendAdmissionEvent:
			options.appendAdmissionEvent ??
			vi.fn((input) => {
				runEvents.push(input.event.kind);
				admissionEvents.push(input);
				admissionPayloads.push(input.event.payload);
				return {
					ref: `event://${input.event.payload.receipt_id}`,
				};
			}),
	};
	const admissionStore =
		options.admissionStore === undefined
			? defaultAdmissionStore
			: options.admissionStore;

	const bus = createEventBus();
	bus.subscribe((event) => {
		if (event.kind === "execution-started") {
			runEvents.push("execution-started");
		}
	});

	const orchestrator = createBuildplaneOrchestrator({
		projectRoot,
		storage,
		runtime,
		policy,
		workspace,
		eventBus: bus,
		admissionStore,
		admittedPlanReader: options.admittedPlanReader,
	});

	return {
		projectRoot,
		packet,
		runEvents,
		runtime,
		artifacts,
		admissionEvents,
		admissionPayloads,
		orchestrator,
		cleanup() {
			rmSync(projectRoot, { recursive: true, force: true });
		},
	};
}

describe("orchestrator run admission", () => {
	const cleanup: Array<() => void> = [];
	afterEach(() => {
		while (cleanup.length > 0) cleanup.pop()?.();
	});

	it("records live sync admission after run-started and before execution-started", () => {
		const harness = createHarness();
		cleanup.push(harness.cleanup);

		const result = harness.orchestrator.runPacket(harness.packet);

		expect(result.run.status).toBe("passed");
		expect(harness.runEvents).toEqual([
			"create-run",
			"prepare-workspace",
			"workspace-prepared",
			"run-started",
			"write-admission-artifact",
			"run_admission_recorded",
			"execution-started",
			"runtime",
			"record-execution-evidence",
		]);
		expect(harness.artifacts).toHaveLength(1);
		expect(harness.artifacts[0]?.receipt.admission).toMatchObject({
			decision: "PASS",
			will_execute_worker: true,
			authorized_next_step: "dispatch_worker",
		});
		expect(harness.admissionPayloads[0]).toMatchObject({
			receipt_id: "run_admission_run-1",
			run_id: "run-1",
			unit_id: "unit-1",
			decision: "PASS",
			receipt_ref: expect.stringMatching(/^artifact:\/\//),
			policy_profile_id: "default",
			allowed_side_effects: [
				"fs.read:repo",
				"fs.write:declared_scope",
				"command.execute:verification",
			],
		});
		expect(
			harness.artifacts[0]?.receipt.policy.denied_side_effects.map(
				({ effect }) => effect,
			),
		).toEqual(["git.push:remote", "github.pr.create", "deploy:production"]);
	});

	it("derives live admission side effects from command packet semantics", () => {
		const harness = createHarness();
		cleanup.push(harness.cleanup);

		const result = harness.orchestrator.runPacket(harness.packet);

		expect(result.run.status).toBe("passed");
		expect(
			harness.artifacts[0]?.receipt.request.requested_side_effects,
		).toEqual([
			"fs.read:repo",
			"fs.write:declared_scope",
			"command.execute:verification",
		]);
		expect(harness.admissionPayloads[0]?.allowed_side_effects).toEqual([
			"fs.read:repo",
			"fs.write:declared_scope",
			"command.execute:verification",
		]);
	});

	it("admits model packets using only local repo and declared-scope side effects", () => {
		const packet = createPacket({
			execution: undefined,
			model: {
				provider: "test-provider",
				model: "test-model",
				prompt: "Summarize the local fixture.",
			},
		});
		const harness = createHarness({ packet });
		cleanup.push(harness.cleanup);

		const result = harness.orchestrator.runPacket(packet);

		expect(result.run.status).toBe("passed");
		expect(harness.runtime.executePacket).toHaveBeenCalledTimes(1);
		expect(harness.admissionPayloads[0]).toMatchObject({
			decision: "PASS",
			requested_side_effects: ["fs.read:repo", "fs.write:declared_scope"],
			allowed_side_effects: ["fs.read:repo", "fs.write:declared_scope"],
			unsafe_requests: [],
		});
	});

	it("records live async admission before async execution", async () => {
		const harness = createHarness();
		cleanup.push(harness.cleanup);

		const result = await harness.orchestrator.runPacketAsync(harness.packet);

		expect(result.run.status).toBe("passed");
		expect(harness.runEvents.slice(0, 8)).toEqual([
			"create-run",
			"prepare-workspace",
			"workspace-prepared",
			"run-started",
			"write-admission-artifact",
			"run_admission_recorded",
			"execution-started",
			"runtime",
		]);
		expect(harness.admissionEvents).toHaveLength(1);
		expect(harness.artifacts[0]?.receipt.admission.will_execute_worker).toBe(
			true,
		);
	});

	it("fails closed before sync or async runtime when no admission store is configured", async () => {
		const syncHarness = createHarness({ admissionStore: null });
		cleanup.push(syncHarness.cleanup);

		const syncResult = syncHarness.orchestrator.runPacket(syncHarness.packet);

		expect(syncResult.run.status).toBe("failed");
		expect(syncResult.failure?.kind).toBe("run-admission-store-unavailable");
		expect(syncHarness.runtime.executePacket).not.toHaveBeenCalled();
		expect(syncHarness.artifacts).toHaveLength(0);
		expect(syncHarness.admissionEvents).toHaveLength(0);
		expect(syncHarness.runEvents).not.toContain("execution-started");
		expect(syncHarness.runEvents).not.toContain("runtime");

		const asyncHarness = createHarness({ admissionStore: null });
		cleanup.push(asyncHarness.cleanup);

		const asyncResult = await asyncHarness.orchestrator.runPacketAsync(
			asyncHarness.packet,
		);

		expect(asyncResult.run.status).toBe("failed");
		expect(asyncResult.failure?.kind).toBe("run-admission-store-unavailable");
		expect(asyncHarness.runtime.executePacketAsync).not.toHaveBeenCalled();
		expect(asyncHarness.artifacts).toHaveLength(0);
		expect(asyncHarness.admissionEvents).toHaveLength(0);
		expect(asyncHarness.runEvents).not.toContain("execution-started");
		expect(asyncHarness.runEvents).not.toContain("runtime");
	});

	it("fails closed before runtime when admission input contains credential-shaped values", () => {
		const packet = createPacket({
			unit: {
				...createPacket().unit,
				policyProfile: FAKE_OPERATOR_TOKEN,
			},
		});
		const harness = createHarness({ packet });
		cleanup.push(harness.cleanup);

		const result = harness.orchestrator.runPacket(packet);
		const serializedResult = JSON.stringify(result);

		expect(result.run.status).toBe("failed");
		expect(result.failure?.kind).toBe("run-admission-record-failed");
		expect(harness.runtime.executePacket).not.toHaveBeenCalled();
		expect(harness.artifacts).toHaveLength(0);
		expect(harness.admissionEvents).toHaveLength(0);
		expect(serializedResult).toContain("credential-shaped");
		expect(serializedResult).not.toContain(FAKE_OPERATOR_TOKEN);
		expect(harness.runEvents).not.toContain("execution-started");
		expect(harness.runEvents).not.toContain("runtime");
	});

	it("fails closed before runtime when admission event append fails", async () => {
		const harness = createHarness({
			appendAdmissionEvent: vi.fn(() => {
				throw new Error("append failed");
			}),
		});
		cleanup.push(harness.cleanup);

		const result = await harness.orchestrator.runPacketAsync(harness.packet);

		expect(result.run.status).toBe("failed");
		expect(result.failure?.kind).toBe("run-admission-record-failed");
		expect(result.failure?.message).toContain("append failed");
		expect(harness.runtime.executePacketAsync).not.toHaveBeenCalled();
		expect(harness.artifacts).toHaveLength(1);
		expect(harness.admissionEvents).toHaveLength(0);
		expect(harness.runEvents).toContain("write-admission-artifact");
		expect(harness.runEvents).not.toContain("execution-started");
		expect(harness.runEvents).not.toContain("runtime");
	});

	it("denies admission when the worktree is dirty", async () => {
		const harness = createHarness({ worktreeClean: false });
		cleanup.push(harness.cleanup);

		const result = await harness.orchestrator.runPacketAsync(harness.packet);

		expect(result.run.status).not.toBe("passed");
		expect(harness.artifacts[0]?.receipt.admission).toMatchObject({
			decision: "INSUFFICIENT_EVIDENCE",
			will_execute_worker: false,
		});
		expect(harness.artifacts[0]?.receipt.admission.missing_evidence).toContain(
			"repo.worktree_clean",
		);
		expect(harness.runtime.executePacketAsync).not.toHaveBeenCalled();
		expect(harness.runEvents).not.toContain("execution-started");
		expect(harness.runEvents).not.toContain("runtime");
	});

	it("rejects dispatch when provenance_ref has no signed plan_admitted on the tape", async () => {
		const harness = createHarness({
			packet: createPacket({ provenance_ref: "evt-missing" }),
			admittedPlanReader: { read: async () => undefined },
		});
		cleanup.push(harness.cleanup);

		const result = await harness.orchestrator.runPacketAsync(harness.packet);

		expect(result.run.status).not.toBe("passed");
		expect(result.failure?.kind).toBe("plan-not-admitted");
		expect(harness.runtime.executePacketAsync).not.toHaveBeenCalled();
		expect(harness.runEvents).not.toContain("runtime");
	});

	it("allows dispatch when provenance_ref resolves to a kernel-signed admission", async () => {
		const harness = createHarness({
			packet: createPacket({ provenance_ref: "evt-1" }),
			admittedPlanReader: {
				read: async () => ({
					authorizedNextStep: "dispatch_admitted_plan",
					signedByKernel: true,
				}),
			},
		});
		cleanup.push(harness.cleanup);

		const result = await harness.orchestrator.runPacketAsync(harness.packet);

		expect(result.run.status).toBe("passed");
	});

	it("records provenance_ref on the admission receipt run record", async () => {
		const harness = createHarness({
			packet: createPacket({ provenance_ref: "evt-prov" }),
			admittedPlanReader: {
				read: async () => ({
					authorizedNextStep: "dispatch_admitted_plan",
					signedByKernel: true,
				}),
			},
		});
		cleanup.push(harness.cleanup);

		const result = await harness.orchestrator.runPacketAsync(harness.packet);

		expect(result.run.status).toBe("passed");
		expect(harness.artifacts[0]?.receipt.run.provenance_ref).toBe("evt-prov");
	});

	it("rejects dispatch when the admission is unsigned or mis-authorized", async () => {
		const harness = createHarness({
			packet: createPacket({ provenance_ref: "evt-1" }),
			admittedPlanReader: {
				read: async () => ({
					authorizedNextStep: "dispatch_admitted_plan",
					signedByKernel: false,
				}),
			},
		});
		cleanup.push(harness.cleanup);

		const result = await harness.orchestrator.runPacketAsync(harness.packet);

		expect(result.run.status).not.toBe("passed");
		expect(result.failure?.kind).toBe("plan-not-admitted");
		expect(harness.runtime.executePacketAsync).not.toHaveBeenCalled();
		expect(harness.runEvents).not.toContain("runtime");
	});

	it("rejects dispatch when admission is kernel-signed but authorizedNextStep is wrong", async () => {
		const harness = createHarness({
			packet: createPacket({ provenance_ref: "evt-1" }),
			admittedPlanReader: {
				read: async () => ({
					authorizedNextStep: "some_other_step",
					signedByKernel: true,
				}),
			},
		});
		cleanup.push(harness.cleanup);

		const result = await harness.orchestrator.runPacketAsync(harness.packet);

		expect(result.run.status).not.toBe("passed");
		expect(result.failure?.kind).toBe("plan-not-admitted");
		expect(harness.runtime.executePacketAsync).not.toHaveBeenCalled();
		expect(harness.runEvents).not.toContain("runtime");
	});

	it("fails closed (plan-not-admitted) when the tape reader throws", async () => {
		const harness = createHarness({
			packet: createPacket({ provenance_ref: "evt-1" }),
			admittedPlanReader: {
				read: async () => {
					throw new Error("corrupt tape");
				},
			},
		});
		cleanup.push(harness.cleanup);

		const result = await harness.orchestrator.runPacketAsync(harness.packet);

		expect(result.run.status).not.toBe("passed");
		expect(result.failure?.kind).toBe("plan-not-admitted");
		expect(harness.runtime.executePacketAsync).not.toHaveBeenCalled();
		expect(harness.runEvents).not.toContain("runtime");
	});

	it("skips the tape gate for non-PlanForge packets (empty provenance_ref)", async () => {
		const read = vi.fn();
		const harness = createHarness({
			packet: createPacket({ provenance_ref: "" }),
			admittedPlanReader: { read },
		});
		cleanup.push(harness.cleanup);

		await harness.orchestrator.runPacketAsync(harness.packet);

		expect(read).not.toHaveBeenCalled();
	});
});
