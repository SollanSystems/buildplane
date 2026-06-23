import type {
	BuildplanePolicyPort,
	BuildplaneRuntimePort,
	BuildplaneStoragePort,
	BuildplaneWorkspacePort,
	DecidedUnexecutedDecision,
	InspectSnapshot,
	OperatorDecisionPort,
	OperatorDecisionShadow,
	RecordOperatorDecisionInput,
	Run,
	RunStatus,
	StatusSnapshot,
} from "@buildplane/kernel";
import {
	createBuildplaneOrchestrator,
	OperatorDecisionValidationError,
} from "@buildplane/kernel";
import { describe, expect, it } from "vitest";

const ROOT = "/tmp/buildplane-operator-decision-test";
const RUN_ID = "01919000-0000-7000-8000-0000000000ff";
const MERGED_SHA = "a".repeat(40);
const WORKSPACE_PATH = `${ROOT}/.buildplane/workspaces/${RUN_ID}`;

interface FakeRunState {
	status: RunStatus;
	workspacePath?: string;
}

interface Harness {
	orchestrator: ReturnType<typeof createBuildplaneOrchestrator>;
	state: FakeRunState;
	shadows: OperatorDecisionShadow[];
	executed: { runId: string; mergedHeadSha?: string }[];
	mergeCalls: { path: string; runId: string }[];
	approveCalls: string[];
	rejectSuspendedCalls: string[];
	rejectMergeCalls: string[];
	decisionEmits: RecordOperatorDecisionInput[];
	emitOrder: string[];
}

function makeHarness(
	options: {
		initialStatus?: RunStatus;
		withWorkspace?: boolean;
		operatorDecisionPort?: OperatorDecisionPort;
		decidedUnexecuted?: () => readonly DecidedUnexecutedDecision[];
		acceptanceOutcome?: "passed" | "rejected" | null;
		preExecutedMarker?: boolean;
		omitOperatorDecisionPort?: boolean;
	} = {},
): Harness {
	const state: FakeRunState = {
		status: options.initialStatus ?? "suspended",
		workspacePath: options.withWorkspace ? WORKSPACE_PATH : undefined,
	};
	const executedMarkers = new Set<string>(
		options.preExecutedMarker ? [RUN_ID] : [],
	);
	const shadows: OperatorDecisionShadow[] = [];
	const executed: { runId: string; mergedHeadSha?: string }[] = [];
	const mergeCalls: { path: string; runId: string }[] = [];
	const approveCalls: string[] = [];
	const rejectSuspendedCalls: string[] = [];
	const rejectMergeCalls: string[] = [];
	const decisionEmits: RecordOperatorDecisionInput[] = [];
	const emitOrder: string[] = [];

	const statusSnapshot: StatusSnapshot = {
		initialized: true,
		latestRunUsedWorkspace: false,
		actionableWorkspaces: [],
		runCounts: { pending: 0, running: 0, passed: 0, failed: 0, cancelled: 0 },
	};

	function snapshotRun(): InspectSnapshot {
		return {
			kind: "run",
			unit: {
				id: "u",
				kind: "command",
				scope: "task",
				inputRefs: [],
				expectedOutputs: [],
				verificationContract: "exit-0-and-required-outputs",
				policyProfile: "default",
			},
			run: { id: RUN_ID, unitId: "u", status: state.status },
			...(state.workspacePath
				? {
						workspace: {
							runId: RUN_ID,
							path: state.workspacePath,
							headSha: "b".repeat(40),
							status: "retained" as const,
						},
					}
				: {}),
			runHistory: [],
			evidence: [],
		};
	}

	const storage: BuildplaneStoragePort = {
		initializeProject() {
			return { created: true, projectRoot: ROOT, stateDbPath: `${ROOT}/x.db` };
		},
		createRun() {
			return { id: RUN_ID, unitId: "u", status: "pending" };
		},
		getChildRuns() {
			return [];
		},
		markRunRunning() {},
		recordExecutionEvidence() {},
		recordDecision() {},
		completeRun() {
			return { id: RUN_ID, unitId: "u", status: "passed" };
		},
		recordWorkspacePrepared() {},
		commitRunFailureOutcome() {
			return { id: RUN_ID, unitId: "u", status: "failed" };
		},
		commitRunSuccessOutcome() {
			return { id: RUN_ID, unitId: "u", status: "passed" };
		},
		recordWorkspaceDeleted() {},
		recordWorkspaceCleanupFailed() {},
		suspendRun() {
			return { id: RUN_ID, unitId: "u", status: "suspended" };
		},
		approveRun(runId): Run {
			emitOrder.push("approveRun");
			approveCalls.push(runId);
			state.status = "pending";
			return { id: runId, unitId: "u", status: "pending" };
		},
		rejectSuspendedRun(runId): Run {
			emitOrder.push("rejectSuspendedRun");
			rejectSuspendedCalls.push(runId);
			state.status = "failed";
			return { id: runId, unitId: "u", status: "failed" };
		},
		rejectMergeDecision(runId): Run {
			emitOrder.push("rejectMergeDecision");
			rejectMergeCalls.push(runId);
			state.status = "failed";
			return { id: runId, unitId: "u", status: "failed" };
		},
		recordOperatorDecisionShadow(shadow) {
			emitOrder.push("shadow");
			shadows.push(shadow);
		},
		markOperatorDecisionExecuted(runId, outcome) {
			emitOrder.push("markExecuted");
			executedMarkers.add(runId);
			executed.push({ runId, mergedHeadSha: outcome?.mergedHeadSha });
		},
		isOperatorDecisionExecuted(runId) {
			return executedMarkers.has(runId);
		},
		getRunAcceptanceOutcome(runId) {
			void runId;
			if ("acceptanceOutcome" in options) {
				return options.acceptanceOutcome ?? null;
			}
			return options.withWorkspace ? "passed" : null;
		},
		listDecidedUnexecutedDecisions() {
			return options.decidedUnexecuted?.() ?? [];
		},
		listPendingOperatorDecisions() {
			return [];
		},
		recordAcceptanceShadow() {},
		getStatusSnapshot() {
			return statusSnapshot;
		},
		inspectTarget() {
			return snapshotRun();
		},
		// Unused-by-these-tests members.
	} as unknown as BuildplaneStoragePort;

	const runtime: BuildplaneRuntimePort = {
		executePacket() {
			throw new Error("unused");
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
			return { path: WORKSPACE_PATH, headSha };
		},
		commitAndMergeWorkspace(ws) {
			emitOrder.push("merge");
			mergeCalls.push({ path: ws.path, runId: ws.runId });
			return { mergedHeadSha: MERGED_SHA };
		},
		deleteWorkspace() {
			return { deleted: true };
		},
	};

	const operatorDecisionPort: OperatorDecisionPort =
		options.operatorDecisionPort ?? {
			async recordDecision(input) {
				emitOrder.push("emitTier2");
				decisionEmits.push(input);
			},
		};

	const orchestrator = createBuildplaneOrchestrator({
		projectRoot: ROOT,
		storage,
		runtime,
		policy,
		workspace,
		admissionStore: null,
		...(options.omitOperatorDecisionPort ? {} : { operatorDecisionPort }),
	});

	return {
		orchestrator,
		state,
		shadows,
		executed,
		mergeCalls,
		approveCalls,
		rejectSuspendedCalls,
		rejectMergeCalls,
		decisionEmits,
		emitOrder,
	};
}

function input(
	over: Partial<RecordOperatorDecisionInput> = {},
): RecordOperatorDecisionInput {
	return {
		runId: RUN_ID,
		decision: "approved",
		subject: "resume",
		decidedBy: "operator:khall",
		decidedAt: "2026-06-23T00:00:00Z",
		...over,
	};
}

describe("recordOperatorDecision — write-ahead ordering (D1/D2)", () => {
	it("emits + flushes Tier-2, mirrors Tier-1, then applies the side effect", async () => {
		const h = makeHarness({ initialStatus: "suspended" });
		await h.orchestrator.recordOperatorDecision(input());

		// Tier-2 emit precedes the Tier-1 mirror, which precedes the side effect.
		expect(h.emitOrder).toEqual([
			"emitTier2",
			"shadow",
			"approveRun",
			"markExecuted",
		]);
		expect(h.decisionEmits).toHaveLength(1);
		expect(h.shadows).toHaveLength(1);
		expect(h.shadows[0].runId).toBe(RUN_ID);
	});

	it("emits with mergeCommit absent in the live write-ahead path (D1)", async () => {
		const h = makeHarness({ initialStatus: "suspended" });
		await h.orchestrator.recordOperatorDecision(input());
		expect(h.decisionEmits[0].mergeCommit).toBeUndefined();
	});
});

describe("recordOperatorDecision — F4 unsigned-side-effect hole (port absent)", () => {
	it("throws BEFORE any side effect when operatorDecisionPort is absent", async () => {
		const h = makeHarness({
			initialStatus: "suspended",
			omitOperatorDecisionPort: true,
		});
		await expect(
			h.orchestrator.recordOperatorDecision(input()),
		).rejects.toBeInstanceOf(OperatorDecisionValidationError);
		// No side effect (an L0 side effect must never run unsigned).
		expect(h.shadows).toHaveLength(0);
		expect(h.approveCalls).toHaveLength(0);
		expect(h.executed).toHaveLength(0);
	});

	it("reconciler re-drives an already-signed decision without a port (never re-emits)", async () => {
		// The reconciler only completes a side effect for a decision already signed
		// onto the tape at decision time — it never re-emits Tier-2, so it does not
		// need a port. This must NOT throw the F4 fail-closed guard.
		const h = makeHarness({
			initialStatus: "suspended",
			omitOperatorDecisionPort: true,
			decidedUnexecuted: () => [
				{ runId: RUN_ID, decision: "approved", subject: "resume" },
			],
		});
		await h.orchestrator.recoverPendingDecisions();
		expect(h.approveCalls).toEqual([RUN_ID]);
		expect(h.decisionEmits).toHaveLength(0);
	});
});

describe("recordOperatorDecision — F3 reject mergeCommit in the live path", () => {
	it("rejects a present mergeCommit (40-hex) BEFORE any emit", async () => {
		const h = makeHarness({ initialStatus: "suspended" });
		await expect(
			h.orchestrator.recordOperatorDecision(
				input({ mergeCommit: "a".repeat(40) }),
			),
		).rejects.toBeInstanceOf(OperatorDecisionValidationError);
		expect(h.decisionEmits).toHaveLength(0);
		expect(h.shadows).toHaveLength(0);
	});
});

describe("recordOperatorDecision — F2 merge eligibility (acceptance passed + workspace)", () => {
	it("rejects merge on a failed/pending/running/cancelled run BEFORE any emit", async () => {
		for (const status of [
			"failed",
			"pending",
			"running",
			"cancelled",
		] as RunStatus[]) {
			const h = makeHarness({
				initialStatus: status,
				withWorkspace: true,
				acceptanceOutcome: null,
			});
			await expect(
				h.orchestrator.recordOperatorDecision(input({ subject: "merge" })),
			).rejects.toBeInstanceOf(OperatorDecisionValidationError);
			expect(h.decisionEmits).toHaveLength(0);
			expect(h.shadows).toHaveLength(0);
			expect(h.mergeCalls).toHaveLength(0);
		}
	});

	it("rejects merge on a passed run with NO retained workspace BEFORE any emit", async () => {
		const h = makeHarness({
			initialStatus: "passed",
			withWorkspace: false,
			acceptanceOutcome: "passed",
		});
		await expect(
			h.orchestrator.recordOperatorDecision(input({ subject: "merge" })),
		).rejects.toBeInstanceOf(OperatorDecisionValidationError);
		expect(h.decisionEmits).toHaveLength(0);
		expect(h.shadows).toHaveLength(0);
	});

	it("accepts merge on a passed run with a retained workspace", async () => {
		const h = makeHarness({
			initialStatus: "passed",
			withWorkspace: true,
			acceptanceOutcome: "passed",
		});
		await h.orchestrator.recordOperatorDecision(input({ subject: "merge" }));
		expect(h.decisionEmits).toHaveLength(1);
		expect(h.mergeCalls).toHaveLength(1);
	});
});

describe("recordOperatorDecision — F1/F5 marker check-and-claim", () => {
	it("no-ops the side effect when an execution marker already exists", async () => {
		const h = makeHarness({
			initialStatus: "passed",
			withWorkspace: true,
			acceptanceOutcome: "passed",
			preExecutedMarker: true,
			decidedUnexecuted: () => [
				{ runId: RUN_ID, decision: "approved", subject: "merge" },
			],
		});
		// Reconciler re-drive after the marker already landed must not re-merge.
		await h.orchestrator.recoverPendingDecisions();
		expect(h.mergeCalls).toHaveLength(0);
		expect(h.executed).toHaveLength(0);
	});

	it("F5: two shadows for one run apply the side effect exactly once", async () => {
		const h = makeHarness({
			initialStatus: "passed",
			withWorkspace: true,
			acceptanceOutcome: "passed",
			// Snapshot returns the SAME run twice (no DISTINCT in the fake) — the
			// orchestrator's marker claim must still apply the merge only once.
			decidedUnexecuted: () => [
				{ runId: RUN_ID, decision: "approved", subject: "merge" },
				{ runId: RUN_ID, decision: "approved", subject: "merge" },
			],
		});
		await h.orchestrator.recoverPendingDecisions();
		expect(h.mergeCalls).toHaveLength(1);
		expect(h.executed).toHaveLength(1);
	});
});

describe("recordOperatorDecision — F7 strict RFC3339 decidedAt", () => {
	it("rejects non-RFC3339 dates that Date.parse would accept", async () => {
		for (const bad of [
			"06/23/2026",
			"June 23, 2026",
			"2026-06-23",
			"2026/06/23T00:00:00Z",
		]) {
			const h = makeHarness({ initialStatus: "suspended" });
			await expect(
				h.orchestrator.recordOperatorDecision(input({ decidedAt: bad })),
			).rejects.toBeInstanceOf(OperatorDecisionValidationError);
			expect(h.decisionEmits).toHaveLength(0);
		}
	});

	it("accepts valid RFC3339 timestamps (Z and numeric offset)", async () => {
		for (const good of [
			"2026-06-23T00:00:00Z",
			"2026-06-23T00:00:00.123Z",
			"2026-06-23T00:00:00+02:00",
		]) {
			const h = makeHarness({ initialStatus: "suspended" });
			await h.orchestrator.recordOperatorDecision(input({ decidedAt: good }));
			expect(h.decisionEmits).toHaveLength(1);
		}
	});
});

describe("recordOperatorDecision — F8 port awaited before side effects", () => {
	it("does not shadow or apply the side effect until the port promise resolves", async () => {
		let resolvePort: (() => void) | undefined;
		const gate = new Promise<void>((res) => {
			resolvePort = res;
		});
		const deferredPort: OperatorDecisionPort = {
			async recordDecision() {
				await gate;
			},
		};
		const h = makeHarness({
			initialStatus: "suspended",
			operatorDecisionPort: deferredPort,
		});
		const pending = h.orchestrator.recordOperatorDecision(input());

		// Let any microtasks flush; the port has not resolved, so nothing after it.
		await Promise.resolve();
		await Promise.resolve();
		expect(h.shadows).toHaveLength(0);
		expect(h.approveCalls).toHaveLength(0);

		resolvePort?.();
		await pending;
		expect(h.shadows).toHaveLength(1);
		expect(h.approveCalls).toEqual([RUN_ID]);
	});
});

describe("recordOperatorDecision — side effects (D3)", () => {
	it("resume/approved → approveRun + executed marker", async () => {
		const h = makeHarness({ initialStatus: "suspended" });
		await h.orchestrator.recordOperatorDecision(
			input({ subject: "resume", decision: "approved" }),
		);
		expect(h.approveCalls).toEqual([RUN_ID]);
		expect(h.executed).toEqual([{ runId: RUN_ID, mergedHeadSha: undefined }]);
	});

	it("resume/rejected → rejectSuspendedRun", async () => {
		const h = makeHarness({ initialStatus: "suspended" });
		await h.orchestrator.recordOperatorDecision(
			input({ subject: "resume", decision: "rejected" }),
		);
		expect(h.rejectSuspendedCalls).toEqual([RUN_ID]);
		expect(h.mergeCalls).toHaveLength(0);
	});

	it("merge/approved → commitAndMergeWorkspace + marker carries mergedHeadSha", async () => {
		const h = makeHarness({ initialStatus: "passed", withWorkspace: true });
		await h.orchestrator.recordOperatorDecision(
			input({ subject: "merge", decision: "approved" }),
		);
		expect(h.mergeCalls).toEqual([{ path: WORKSPACE_PATH, runId: RUN_ID }]);
		expect(h.executed).toEqual([{ runId: RUN_ID, mergedHeadSha: MERGED_SHA }]);
	});

	it("merge/rejected quarantines: no merge, worktree retained, run failed", async () => {
		const h = makeHarness({ initialStatus: "passed", withWorkspace: true });
		await h.orchestrator.recordOperatorDecision(
			input({ subject: "merge", decision: "rejected" }),
		);
		expect(h.mergeCalls).toHaveLength(0);
		expect(h.rejectMergeCalls).toEqual([RUN_ID]);
		// Worktree retained: deleteWorkspace never invoked, path still present.
		expect(h.state.workspacePath).toBe(WORKSPACE_PATH);
		expect(h.state.status).toBe("failed");
	});
});

describe("recordOperatorDecision — validation before sign (D5)", () => {
	it("rejects an invalid decision BEFORE any emit", async () => {
		const h = makeHarness({ initialStatus: "suspended" });
		await expect(
			h.orchestrator.recordOperatorDecision(
				input({ decision: "maybe" as never }),
			),
		).rejects.toBeInstanceOf(OperatorDecisionValidationError);
		expect(h.decisionEmits).toHaveLength(0);
		expect(h.shadows).toHaveLength(0);
	});

	it("rejects a non-UUID runId before emit", async () => {
		const h = makeHarness({ initialStatus: "suspended" });
		await expect(
			h.orchestrator.recordOperatorDecision(input({ runId: "not-a-uuid" })),
		).rejects.toBeInstanceOf(OperatorDecisionValidationError);
		expect(h.decisionEmits).toHaveLength(0);
	});

	it("rejects a non-40-hex mergeCommit when present", async () => {
		const h = makeHarness({ initialStatus: "suspended" });
		await expect(
			h.orchestrator.recordOperatorDecision(input({ mergeCommit: "deadbeef" })),
		).rejects.toBeInstanceOf(OperatorDecisionValidationError);
	});

	it("rejects empty decidedBy and bad decidedAt", async () => {
		const h = makeHarness({ initialStatus: "suspended" });
		await expect(
			h.orchestrator.recordOperatorDecision(input({ decidedBy: "  " })),
		).rejects.toBeInstanceOf(OperatorDecisionValidationError);
		await expect(
			h.orchestrator.recordOperatorDecision(input({ decidedAt: "nope" })),
		).rejects.toBeInstanceOf(OperatorDecisionValidationError);
	});

	it("rejects resume on a non-suspended run, and merge on a suspended run", async () => {
		const resumeOnPassed = makeHarness({ initialStatus: "passed" });
		await expect(
			resumeOnPassed.orchestrator.recordOperatorDecision(
				input({ subject: "resume" }),
			),
		).rejects.toBeInstanceOf(OperatorDecisionValidationError);

		const mergeOnSuspended = makeHarness({ initialStatus: "suspended" });
		await expect(
			mergeOnSuspended.orchestrator.recordOperatorDecision(
				input({ subject: "merge" }),
			),
		).rejects.toBeInstanceOf(OperatorDecisionValidationError);
	});
});

describe("recoverPendingDecisions — exactly-once reconciler (D2/D4)", () => {
	it("completes a decided-but-unexecuted side effect exactly once, no Tier-2 re-emit", async () => {
		const h = makeHarness({
			initialStatus: "passed",
			withWorkspace: true,
			decidedUnexecuted: () => [
				{ runId: RUN_ID, decision: "approved", subject: "merge" },
			],
		});
		await h.orchestrator.recoverPendingDecisions();

		expect(h.mergeCalls).toEqual([{ path: WORKSPACE_PATH, runId: RUN_ID }]);
		expect(h.executed).toEqual([{ runId: RUN_ID, mergedHeadSha: MERGED_SHA }]);
		// NEVER re-emits Tier-2.
		expect(h.decisionEmits).toHaveLength(0);
	});

	it("no-double-merge: two reconciler passes merge once when the marker lands", async () => {
		// The storage feed gates on the executed marker: once a marker is recorded,
		// listDecidedUnexecutedDecisions stops returning the run. Drive the fake
		// feed off the real executed-marker writes the orchestrator makes — proving
		// the orchestrator's own marker write is what closes the re-drive window.
		const holder: { executed?: { runId: string }[] } = {};
		const h = makeHarness({
			initialStatus: "passed",
			withWorkspace: true,
			decidedUnexecuted: () =>
				holder.executed?.some((e) => e.runId === RUN_ID)
					? []
					: [{ runId: RUN_ID, decision: "approved", subject: "merge" }],
		});
		holder.executed = h.executed;

		await h.orchestrator.recoverPendingDecisions();
		await h.orchestrator.recoverPendingDecisions();

		expect(h.mergeCalls).toHaveLength(1);
		expect(h.executed).toHaveLength(1);
	});

	it("re-drives a resume decision (no workspace) without Tier-2 re-emit", async () => {
		const h = makeHarness({
			initialStatus: "suspended",
			decidedUnexecuted: () => [
				{ runId: RUN_ID, decision: "approved", subject: "resume" },
			],
		});
		await h.orchestrator.recoverPendingDecisions();
		expect(h.approveCalls).toEqual([RUN_ID]);
		expect(h.decisionEmits).toHaveLength(0);
	});
});
