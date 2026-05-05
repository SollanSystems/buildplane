import type { ExecutionReceipt, UnitPacket } from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import { evaluateRun } from "../src/decision";

const packet: UnitPacket = {
	unit: {
		id: "unit-grants",
		kind: "command",
		scope: "task",
		inputRefs: [],
		expectedOutputs: [],
		verificationContract: "exit-0",
		policyProfile: "publisher",
	},
	execution: { command: "node" },
	verification: { requiredOutputs: [] },
};

function buildReceipt(
	overrides: Partial<ExecutionReceipt> = {},
): ExecutionReceipt {
	return {
		command: "node",
		args: [],
		cwd: ".",
		startedAt: "2026-05-05T00:00:00.000Z",
		completedAt: "2026-05-05T00:00:01.000Z",
		exitCode: 0,
		stdout: "",
		stderr: "",
		outputChecks: [],
		...overrides,
	};
}

describe("capability grant policy", () => {
	it("approves side-effect receipts that cite a matching capability grant", () => {
		const profile = {
			name: "publisher",
			capabilityGrants: [
				{
					id: "grant-pr-dry-run",
					capability: "github.pr",
					actions: ["dry-run"],
					targets: ["repo:SollanSystems/Vector"],
				},
			],
		};
		const receipt = buildReceipt({
			sideEffects: [
				{
					id: "side-effect-pr-preview",
					capability: "github.pr",
					action: "dry-run",
					target: "repo:SollanSystems/Vector",
					grantId: "grant-pr-dry-run",
				},
			],
		});

		const decision = evaluateRun(packet, receipt, profile);

		expect(decision.kind).toBe("advance-run");
		expect(decision.outcome).toBe("approved");
		expect(decision.reasons).toEqual([]);
	});

	it("rejects and quarantines side effects that do not cite a matching grant", () => {
		const profile = {
			name: "publisher",
			capabilityGrants: [
				{
					id: "grant-pr-dry-run",
					capability: "github.pr",
					actions: ["dry-run"],
					targets: ["repo:SollanSystems/Vector"],
				},
			],
		};
		const receipt = buildReceipt({
			sideEffects: [
				{
					id: "side-effect-pr-publish",
					capability: "github.pr",
					action: "publish",
					target: "repo:SollanSystems/Vector",
					grantId: "grant-pr-dry-run",
				},
			],
		});

		const decision = evaluateRun(packet, receipt, profile);

		expect(decision.kind).toBe("reject-run");
		expect(decision.outcome).toBe("rejected");
		expect(decision.reasons).toEqual([
			expect.stringContaining("UNSAFE_TO_RUN"),
		]);
		expect(decision.reasons[0]).toContain("side-effect-pr-publish");
		expect(decision.reasons[0]).toContain("without matching capability grant");
		expect(decision.reasons[0]).toContain("quarantine");
	});
});
