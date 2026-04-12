import type {
	ApprovedPolicyDecision,
	ExecutionReceipt,
	RejectedPolicyDecision,
	Run,
	RunPacketResult,
	UnitPacket,
} from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import { extractLearnings } from "../src/outcome-extractor.js";

const baseRun: Run = { id: "run-1", unitId: "unit-1", status: "passed" };

const basePacket: UnitPacket = {
	unit: {
		id: "unit-1",
		kind: "command",
		scope: "task",
		inputRefs: [],
		expectedOutputs: [],
		verificationContract: "exit-0 + output/result.txt",
		policyProfile: "default",
	},
	execution: { command: "node", args: [] },
	verification: { requiredOutputs: [] },
};

const passingReceipt: ExecutionReceipt = {
	command: "node",
	args: [],
	cwd: "/tmp/workspace",
	startedAt: "2026-04-04T00:00:00.000Z",
	completedAt: "2026-04-04T00:00:01.000Z",
	exitCode: 0,
	stdout: "ok",
	stderr: "",
	outputChecks: [{ path: "output/result.txt", exists: true }],
};

const failingReceipt: ExecutionReceipt = {
	command: "node",
	args: [],
	cwd: "/tmp/workspace",
	startedAt: "2026-04-04T00:00:00.000Z",
	completedAt: "2026-04-04T00:00:01.000Z",
	exitCode: 1,
	stdout: "",
	stderr: "error",
	outputChecks: [
		{ path: "output/result.txt", exists: false },
		{ path: "output/log.txt", exists: true },
	],
};

const emptyOutputReceipt: ExecutionReceipt = {
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
	it("Rule 2: rejection includes exit code, failing output path, contract, and reasons", () => {
		const learnings = extractLearnings({
			run: { ...baseRun, status: "failed" },
			receipt: failingReceipt,
			decision: rejected,
			packet: basePacket,
		});
		const constraint = learnings.find(
			(l) => l.kind === "constraint" && l.scope === "session",
		);
		expect(constraint).toBeDefined();
		expect(constraint?.body).toContain("exit code 1");
		expect(constraint?.body).toContain("Missing output: output/result.txt");
		expect(constraint?.body).toContain("exit-0 + output/result.txt");
		expect(constraint?.body).toContain("Missing error handling in auth module");
	});

	it("Rule 2 variant: rejection without failing outputs omits 'Missing output' clause", () => {
		const allPassReceipt: ExecutionReceipt = {
			...failingReceipt,
			outputChecks: [{ path: "output/result.txt", exists: true }],
		};
		const learnings = extractLearnings({
			run: { ...baseRun, status: "failed" },
			receipt: allPassReceipt,
			decision: rejected,
			packet: basePacket,
		});
		const constraint = learnings.find(
			(l) => l.kind === "constraint" && l.scope === "session",
		);
		expect(constraint).toBeDefined();
		expect(constraint?.body).not.toContain("Missing output");
		expect(constraint?.body).toContain("exit code 1");
	});

	it("Rule 3: retry heuristic quotes decision reasons and mentions attempt count", () => {
		const learnings = extractLearnings({
			run: baseRun,
			receipt: passingReceipt,
			decision: {
				kind: "advance-run",
				outcome: "approved",
				reasons: ["added explicit error boundary"],
			},
			packet: basePacket,
			attemptCount: 2,
		});
		const heuristic = learnings.find((l) => l.kind === "provider_heuristic");
		expect(heuristic).toBeDefined();
		expect(heuristic?.scope).toBe("workspace");
		expect(heuristic?.body).toContain("3 attempts");
		expect(heuristic?.body).toContain("added explicit error boundary");
	});

	it("Rule 5: multi-round workflow includes round-by-round delta with reviewer suffix keys", () => {
		const round1: Map<string, RunPacketResult> = new Map([
			[
				"impl-reviewer",
				{
					run: { id: "run-r1", unitId: "impl-reviewer", status: "failed" },
					decision: {
						kind: "reject-run",
						outcome: "rejected",
						reasons: ["missing type annotations"],
					},
				} as RunPacketResult,
			],
		]);
		const round2: Map<string, RunPacketResult> = new Map([
			[
				"impl-reviewer",
				{
					run: { id: "run-r2", unitId: "impl-reviewer", status: "passed" },
					decision: {
						kind: "advance-run",
						outcome: "approved",
						reasons: ["types added"],
					},
				} as RunPacketResult,
			],
		]);
		const learnings = extractLearnings({
			run: baseRun,
			receipt: passingReceipt,
			decision: approved,
			packet: basePacket,
			strategyResult: {
				strategyId: "strat-1",
				mode: "implement-then-review",
				outcome: "passed",
				childResults: new Map(),
				mergeDecision: { policy: "direct", outcome: "accepted", reasons: [] },
				rounds: [round1, round2],
			},
		});
		const workflow = learnings.find((l) => l.kind === "workflow");
		expect(workflow).toBeDefined();
		expect(workflow?.scope).toBe("workspace");
		expect(workflow?.body).toContain("2 rounds");
		expect(workflow?.body).toContain("Round 1");
		expect(workflow?.body).toContain("missing type annotations");
		expect(workflow?.body).toContain("Round 2");
		expect(workflow?.body).toContain("approved");
	});

	it("Rule 6: forbidden-path hit produces workspace constraint naming the failing path", () => {
		const learnings = extractLearnings({
			run: { ...baseRun, status: "failed" },
			receipt: failingReceipt,
			decision: rejected,
			packet: basePacket,
		});
		const pathConstraints = learnings.filter(
			(l) => l.kind === "constraint" && l.scope === "workspace",
		);
		expect(pathConstraints.length).toBeGreaterThanOrEqual(1);
		const failingPathConstraint = pathConstraints.find((l) =>
			l.title.includes("output/result.txt"),
		);
		expect(failingPathConstraint).toBeDefined();
		expect(failingPathConstraint?.body).toContain("output/result.txt");
		expect(failingPathConstraint?.body).toContain("exit-0 + output/result.txt");
		// log.txt exists=true should NOT produce a constraint
		const logConstraint = pathConstraints.find((l) =>
			l.title.includes("output/log.txt"),
		);
		expect(logConstraint).toBeUndefined();
	});

	it("Rule 7: verification-gate win on first attempt produces workspace fact listing outputs", () => {
		const learnings = extractLearnings({
			run: baseRun,
			receipt: passingReceipt,
			decision: approved,
			packet: basePacket,
			attemptCount: 0,
		});
		const gateFact = learnings.find(
			(l) =>
				l.kind === "fact" &&
				l.scope === "workspace" &&
				l.title === "Verification gate passed",
		);
		expect(gateFact).toBeDefined();
		expect(gateFact?.body).toContain("output/result.txt");
	});

	it("Edge: no learnings on clean approval with empty outputChecks", () => {
		const learnings = extractLearnings({
			run: baseRun,
			receipt: emptyOutputReceipt,
			decision: approved,
			packet: basePacket,
			attemptCount: 0,
		});
		// No fact (no outputs to verify), no heuristic (attemptCount=0)
		expect(learnings).toHaveLength(0);
	});

	it("Edge: early return with no learnings on retrying decision", () => {
		const learnings = extractLearnings({
			run: baseRun,
			receipt: passingReceipt,
			decision: {
				kind: "retry-run",
				outcome: "retrying",
				reasons: ["retrying now"],
			},
			packet: basePacket,
		});
		expect(learnings).toHaveLength(0);
	});
});
