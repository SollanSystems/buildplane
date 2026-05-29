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
	OutcomeRoutingConfig,
	RunOutcome,
	UnitPacket,
	WorkerLabel,
} from "@buildplane/kernel";
import { describe, expect, it } from "vitest";

import { createBuildplaneOrchestrator } from "../src/orchestrator";
import { defaultOutcomeRoutingConfig } from "../src/routing-producer";

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

const NOW = Date.parse("2026-05-28T00:00:00.000Z");
const ENABLED: OutcomeRoutingConfig = {
	...defaultOutcomeRoutingConfig,
	enabled: true,
};

const row = (worker: WorkerLabel, success: boolean): RunOutcome => ({
	id: `${worker}-${success}-${Math.random()}`,
	repoId: "/r",
	taskType: "implement",
	worker,
	success,
	sourceRunId: `${worker}-${Math.random()}`,
	createdAt: new Date(NOW).toISOString(),
});

// fully covered (every candidate ≥ minSamples=5), codex best rate
function codexBestRows(): RunOutcome[] {
	const rows: RunOutcome[] = [];
	for (let i = 0; i < 5; i++) {
		rows.push(row("sdk", false));
		rows.push(row("claude-code", false));
		rows.push(row("codex", true));
	}
	return rows;
}

interface HarnessOptions {
	readonly outcomeRouting?: OutcomeRoutingConfig;
	readonly seededRows?: readonly RunOutcome[];
}

function createHarness(packet: UnitPacket, options: HarnessOptions = {}) {
	const { outcomeRouting, seededRows = [] } = options;
	const appended: AppendRunOutcomeInput[] = [];
	const createRunPackets: UnitPacket[] = [];
	const executedPackets: UnitPacket[] = [];
	let listCalls = 0;
	const root = mkdtempSync(join(tmpdir(), "buildplane-routing-producer-"));
	const workspacePath = join(root, ".buildplane", "workspaces", "run-1");

	const baseReceipt: ExecutionReceipt = {
		command: "node",
		args: [],
		cwd: workspacePath,
		startedAt: "2026-03-17T00:00:00.000Z",
		completedAt: "2026-03-17T00:00:01.000Z",
		exitCode: 0,
		stdout: "ok",
		stderr: "",
		outputChecks: [{ path: "tmp/out.txt", exists: true }],
	};

	const storage: BuildplaneStoragePort = {
		initializeProject() {
			return {
				created: true,
				projectRoot: root,
				stateDbPath: join(root, ".buildplane", "state.db"),
			};
		},
		createRun(p: UnitPacket) {
			createRunPackets.push(p);
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
			listCalls++;
			return seededRows;
		},
	} as unknown as BuildplaneStoragePort;

	const runtime: BuildplaneRuntimePort = {
		executePacket(p: UnitPacket) {
			executedPackets.push(p);
			return baseReceipt;
		},
	};

	const policy: BuildplanePolicyPort = {
		evaluateRun() {
			return { kind: "advance-run", outcome: "approved", reasons: [] };
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
		createRunPackets,
		executedPackets,
		listCalls: () => listCalls,
		orchestrator: createBuildplaneOrchestrator({
			projectRoot: root,
			storage,
			runtime,
			policy,
			workspace,
			...(outcomeRouting ? { outcomeRouting } : {}),
		}),
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

describe("prepareRun outcome-routing producer", () => {
	it("default OFF: routing unchanged and listRunOutcomes never queried", () => {
		const packet = modelPacket();
		const h = createHarness(packet, { seededRows: codexBestRows() });
		try {
			h.orchestrator.runPacket(packet);
			// snapshot packet has no hint
			expect(
				h.createRunPackets[0]?.routingHints?.preferredWorker,
			).toBeUndefined();
			// executed packet has no hint
			expect(
				h.executedPackets[0]?.routingHints?.preferredWorker,
			).toBeUndefined();
			// recorder sees the default sdk worker
			expect(h.appended[0]?.worker).toBe("sdk");
			// the producer never queried the table
			expect(h.listCalls()).toBe(0);
		} finally {
			h.cleanup();
		}
	});

	it("enabled + codex-best: recorded route == actual route == snapshot (codex)", () => {
		const packet = modelPacket();
		const h = createHarness(packet, {
			outcomeRouting: ENABLED,
			seededRows: codexBestRows(),
		});
		try {
			const result = h.orchestrator.runPacket(packet);
			expect(result.run.status).toBe("passed");
			// snapshot (createRun) carries the filled hint
			expect(h.createRunPackets[0]?.routingHints?.preferredWorker).toBe(
				"codex",
			);
			// executed packet is the SAME filled packet
			expect(h.executedPackets[0]?.routingHints?.preferredWorker).toBe("codex");
			expect(h.executedPackets[0]).toBe(h.createRunPackets[0]);
			// recorder records codex (recorded == actual)
			expect(h.appended).toEqual([
				{
					taskType: "implement",
					worker: "codex",
					success: true,
					sourceRunId: "run-1",
				},
			]);
		} finally {
			h.cleanup();
		}
	});

	it("enabled + cold start (empty table): least-sampled = sdk ⇒ hint absent", () => {
		const packet = modelPacket();
		const h = createHarness(packet, {
			outcomeRouting: ENABLED,
			seededRows: [],
		});
		try {
			h.orchestrator.runPacket(packet);
			expect(
				h.createRunPackets[0]?.routingHints?.preferredWorker,
			).toBeUndefined();
			expect(h.appended[0]?.worker).toBe("sdk");
			expect(h.listCalls()).toBeGreaterThanOrEqual(1);
		} finally {
			h.cleanup();
		}
	});

	it("enabled + cold start (claude-code unsampled): routes to least-sampled candidate", () => {
		// sdk + codex covered, claude-code has zero rows ⇒ claude-code is least-sampled
		const rows: RunOutcome[] = [];
		for (let i = 0; i < 5; i++) {
			rows.push(row("sdk", true));
			rows.push(row("codex", true));
		}
		const packet = modelPacket();
		const h = createHarness(packet, {
			outcomeRouting: ENABLED,
			seededRows: rows,
		});
		try {
			h.orchestrator.runPacket(packet);
			expect(h.createRunPackets[0]?.routingHints?.preferredWorker).toBe(
				"claude-code",
			);
			expect(h.appended[0]?.worker).toBe("claude-code");
		} finally {
			h.cleanup();
		}
	});

	it("enabled: explicit preferredWorker is preserved (fill-not-override)", () => {
		const packet = modelPacket({
			routingHints: { preferredWorker: "claude-code" },
		});
		const h = createHarness(packet, {
			outcomeRouting: ENABLED,
			seededRows: codexBestRows(),
		});
		try {
			h.orchestrator.runPacket(packet);
			expect(h.createRunPackets[0]?.routingHints?.preferredWorker).toBe(
				"claude-code",
			);
			expect(h.appended[0]?.worker).toBe("claude-code");
			// never queried — short-circuited on the explicit hint
			expect(h.listCalls()).toBe(0);
		} finally {
			h.cleanup();
		}
	});

	it("enabled: command packet is never routed (model unset)", () => {
		const packet = commandPacket();
		const h = createHarness(packet, {
			outcomeRouting: ENABLED,
			seededRows: codexBestRows(),
		});
		try {
			h.orchestrator.runPacket(packet);
			expect(
				h.createRunPackets[0]?.routingHints?.preferredWorker,
			).toBeUndefined();
			expect(h.listCalls()).toBe(0);
			// command packet ⇒ recorder appends no row
			expect(h.appended).toHaveLength(0);
		} finally {
			h.cleanup();
		}
	});
});
