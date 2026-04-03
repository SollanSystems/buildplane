import type {
	BuildplanePolicyPort,
	BuildplaneRuntimePort,
	BuildplaneStoragePort,
	ExecutionReceipt,
	InspectSnapshot,
	PolicyDecision,
	StatusSnapshot,
	UnitPacket,
} from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import { createBuildplaneOrchestrator } from "../src/orchestrator";

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
	},
	verification: {
		requiredOutputs: ["tmp/out.txt"],
	},
};

const receipt: ExecutionReceipt = {
	command: "node",
	args: [],
	cwd: "/tmp/project",
	startedAt: "2026-03-17T00:00:00.000Z",
	completedAt: "2026-03-17T00:00:01.000Z",
	exitCode: 0,
	stdout: "ok",
	stderr: "",
	outputChecks: [{ path: "tmp/out.txt", exists: true }],
};

function createHarness(outcome: PolicyDecision["outcome"]) {
	const runEvents: string[] = [];
	const statusSnapshot: StatusSnapshot = {
		initialized: true,
		runCounts: {
			pending: 0,
			running: 0,
			passed: outcome === "approved" ? 1 : 0,
			failed: outcome === "rejected" ? 1 : 0,
			cancelled: 0,
		},
		latestRun: {
			id: "run-1",
			unitId: packet.unit.id,
			status: outcome === "approved" ? "passed" : "failed",
		},
	};
	const inspectSnapshot: InspectSnapshot = {
		kind: "run",
		unit: packet.unit,
		run: {
			id: "run-1",
			unitId: packet.unit.id,
			status: outcome === "approved" ? "passed" : "failed",
		},
		runHistory: [
			{ id: "run-1", status: outcome === "approved" ? "passed" : "failed" },
		],
		evidence: [{ id: "evidence-1", kind: "command-exit", status: "pass" }],
		decisions: [
			{
				id: "decision-1",
				kind: outcome === "approved" ? "advance-run" : "reject-run",
				outcome,
				reasons: outcome === "approved" ? [] : ["command exited with code 1"],
			},
		],
		artifacts: [],
	};

	const storage: BuildplaneStoragePort = {
		initializeProject() {
			runEvents.push("initializeProject");
			return {
				created: true,
				projectRoot: "/tmp/project",
				stateDbPath: "/tmp/project/.buildplane/state.db",
			};
		},
		createRun() {
			runEvents.push("createRun");
			return { id: "run-1", unitId: packet.unit.id, status: "pending" };
		},
		markRunRunning() {
			runEvents.push("markRunRunning");
		},
		recordExecutionEvidence() {
			runEvents.push("recordExecutionEvidence");
		},
		recordDecision() {
			runEvents.push("recordDecision");
		},
		completeRun(_runId, status) {
			runEvents.push(`completeRun:${status}`);
			return { id: "run-1", unitId: packet.unit.id, status };
		},
		getStatusSnapshot() {
			return statusSnapshot;
		},
		inspectTarget() {
			return inspectSnapshot;
		},
	};

	const runtime: BuildplaneRuntimePort = {
		executePacket() {
			return {
				...receipt,
				exitCode: outcome === "approved" ? 0 : 1,
				outputChecks: [{ path: "tmp/out.txt", exists: outcome === "approved" }],
			};
		},
	};

	const policy: BuildplanePolicyPort = {
		evaluateRun() {
			return outcome === "approved"
				? { kind: "advance-run", outcome: "approved", reasons: [] }
				: {
						kind: "reject-run",
						outcome: "rejected",
						reasons: ["command exited with code 1"],
					};
		},
	};

	return {
		runEvents,
		statusSnapshot,
		inspectSnapshot,
		orchestrator: createBuildplaneOrchestrator({
			projectRoot: "/tmp/project",
			storage,
			runtime,
			policy,
		}),
	};
}

describe("kernel orchestrator", () => {
	it("orchestrates a successful packet run", () => {
		const { orchestrator, runEvents } = createHarness("approved");

		const result = orchestrator.runPacket(packet);

		expect(runEvents).toEqual([
			"createRun",
			"markRunRunning",
			"recordExecutionEvidence",
			"recordDecision",
			"completeRun:passed",
		]);
		expect(result.run.status).toBe("passed");
		expect(result.decision.outcome).toBe("approved");
	});

	it("orchestrates a rejected packet run", () => {
		const { orchestrator } = createHarness("rejected");

		const result = orchestrator.runPacket(packet);

		expect(result.run.status).toBe("failed");
		expect(result.decision.outcome).toBe("rejected");
	});

	it("delegates init, status, and inspect to storage", () => {
		const { orchestrator, runEvents, statusSnapshot, inspectSnapshot } =
			createHarness("approved");

		expect(orchestrator.initializeProject()).toEqual({
			created: true,
			projectRoot: "/tmp/project",
			stateDbPath: "/tmp/project/.buildplane/state.db",
		});
		expect(runEvents).toContain("initializeProject");
		expect(orchestrator.getStatus()).toBe(statusSnapshot);
		expect(orchestrator.inspect("run-1")).toBe(inspectSnapshot);
	});
});
