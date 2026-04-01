import type { ExecutionReceipt, UnitPacket } from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import { evaluateRun } from "../src/decision";

const packet: UnitPacket = {
	unit: {
		id: "unit-policy",
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

function buildReceipt(overrides: Partial<ExecutionReceipt>): ExecutionReceipt {
	return {
		command: "node",
		args: [],
		cwd: ".",
		startedAt: "2026-03-17T00:00:00.000Z",
		completedAt: "2026-03-17T00:00:01.000Z",
		exitCode: 0,
		stdout: "",
		stderr: "",
		outputChecks: [{ path: "tmp/out.txt", exists: true }],
		...overrides,
	};
}

describe("policy evaluator", () => {
	it("approves successful execution when required outputs exist", () => {
		const decision = evaluateRun(packet, buildReceipt({}));

		expect(decision.kind).toBe("advance-run");
		expect(decision.outcome).toBe("approved");
		expect(decision.reasons).toEqual([]);
	});

	it("rejects non-zero exits", () => {
		const decision = evaluateRun(packet, buildReceipt({ exitCode: 1 }));

		expect(decision.kind).toBe("reject-run");
		expect(decision.outcome).toBe("rejected");
		expect(decision.reasons).toContain("command exited with code 1");
	});

	it("rejects missing required outputs", () => {
		const decision = evaluateRun(
			packet,
			buildReceipt({ outputChecks: [{ path: "tmp/out.txt", exists: false }] }),
		);

		expect(decision.kind).toBe("reject-run");
		expect(decision.outcome).toBe("rejected");
		expect(decision.reasons).toContain("required output missing: tmp/out.txt");
	});
});
