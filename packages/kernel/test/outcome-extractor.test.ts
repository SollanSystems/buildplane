import type {
	ApprovedPolicyDecision,
	ExecutionReceipt,
	RejectedPolicyDecision,
	Run,
	UnitPacket,
} from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import { extractLearnings } from "../src/outcome-extractor.js";

const baseRun: Run = { id: "run-1", unitId: "unit-1", status: "passed" };

const baseReceipt: ExecutionReceipt = {
	command: "node",
	args: [],
	cwd: "/tmp/workspace",
	startedAt: "2026-04-04T00:00:00.000Z",
	completedAt: "2026-04-04T00:00:01.000Z",
	exitCode: 0,
	stdout: "ok",
	stderr: "",
	outputChecks: [],
};

const basePacket: UnitPacket = {
	unit: {
		id: "unit-1",
		kind: "command",
		scope: "task",
		inputRefs: [],
		expectedOutputs: [],
		verificationContract: "exit-0",
		policyProfile: "default",
	},
	execution: { command: "node", args: [] },
	verification: { requiredOutputs: [] },
};

const approved: ApprovedPolicyDecision = {
	kind: "advance-run",
	outcome: "approved",
	reasons: ["All checks passed"],
};

const rejected: RejectedPolicyDecision = {
	kind: "reject-run",
	outcome: "rejected",
	reasons: ["Missing error handling in auth module"],
};

describe("extractLearnings", () => {
	it("extracts a session-scoped fact on approval", () => {
		const learnings = extractLearnings({
			run: baseRun,
			receipt: baseReceipt,
			decision: approved,
			packet: basePacket,
		});
		const fact = learnings.find((l) => l.kind === "fact");
		expect(fact).toBeDefined();
		expect(fact?.scope).toBe("session");
		expect(fact?.body).toContain("All checks passed");
	});

	it("extracts a session-scoped constraint on rejection", () => {
		const learnings = extractLearnings({
			run: { ...baseRun, status: "failed" },
			receipt: { ...baseReceipt, exitCode: 1 },
			decision: rejected,
			packet: basePacket,
		});
		const constraint = learnings.find((l) => l.kind === "constraint");
		expect(constraint).toBeDefined();
		expect(constraint?.scope).toBe("session");
		expect(constraint?.body).toContain("Missing error handling in auth module");
	});

	it("extracts a workspace-scoped decision when taskType is present", () => {
		const packetWithIntent: UnitPacket = {
			...basePacket,
			intent: {
				objective: "Implement auth module",
				taskType: "implement",
				context: { files: [] },
				constraints: { scope: [], verification: [] },
				features: {
					ambiguity: "low",
					reversibility: "easy",
					verifierStrength: "strong",
				},
			},
		};
		const learnings = extractLearnings({
			run: baseRun,
			receipt: baseReceipt,
			decision: approved,
			packet: packetWithIntent,
		});
		const decision = learnings.find((l) => l.kind === "decision");
		expect(decision).toBeDefined();
		expect(decision?.scope).toBe("workspace");
		expect(decision?.body).toContain("implement");
	});

	it("extracts a workspace-scoped provider_heuristic when attemptCount > 0", () => {
		const learnings = extractLearnings({
			run: baseRun,
			receipt: baseReceipt,
			decision: approved,
			packet: basePacket,
			attemptCount: 1,
		});
		const heuristic = learnings.find((l) => l.kind === "provider_heuristic");
		expect(heuristic).toBeDefined();
		expect(heuristic?.scope).toBe("workspace");
		expect(heuristic?.body).toContain("attempt");
	});

	it("extracts a workspace-scoped workflow when strategy used multiple rounds", () => {
		const learnings = extractLearnings({
			run: baseRun,
			receipt: baseReceipt,
			decision: approved,
			packet: basePacket,
			strategyResult: {
				strategyId: "strat-1",
				mode: "parallel-candidates",
				outcome: "passed",
				childResults: new Map(),
				mergeDecision: { policy: "direct", outcome: "accepted", reasons: [] },
				rounds: [new Map(), new Map()], // 2 rounds
			},
		});
		const workflow = learnings.find((l) => l.kind === "workflow");
		expect(workflow).toBeDefined();
		expect(workflow?.scope).toBe("workspace");
		expect(workflow?.body).toContain("2");
		expect(workflow?.body.toLowerCase()).toContain("feedback");
	});

	it("handles approved decision with empty reasons using fallback body", () => {
		const learnings = extractLearnings({
			run: baseRun,
			receipt: baseReceipt,
			decision: { kind: "advance-run", outcome: "approved", reasons: [] },
			packet: basePacket,
		});
		const fact = learnings.find((l) => l.kind === "fact");
		expect(fact).toBeDefined();
		expect(fact?.body).toContain("run completed successfully");
	});
});
