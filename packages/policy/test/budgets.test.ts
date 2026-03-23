import type {
	BudgetConstraints,
	ResourceUsageSnapshot,
	UnitPacket,
} from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import { evaluateBudgets } from "../src/budgets";

const packet: UnitPacket = {
	unit: {
		id: "unit-budget",
		kind: "model",
		scope: "task",
		inputRefs: [],
		expectedOutputs: [],
		verificationContract: "exit-0-and-required-outputs",
		policyProfile: "default",
	},
	model: {
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
	},
	verification: {
		requiredOutputs: [],
	},
};

function usage(
	overrides?: Partial<ResourceUsageSnapshot>,
): ResourceUsageSnapshot {
	return {
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		elapsedMs: 0,
		...overrides,
	};
}

describe("budget evaluation", () => {
	it("returns null when no budgets are defined", () => {
		const result = evaluateBudgets(packet, usage({ totalTokens: 1000 }));
		expect(result).toBeNull();
	});

	it("returns null when undefined budgets are passed", () => {
		const result = evaluateBudgets(
			packet,
			usage({ totalTokens: 1000 }),
			undefined,
		);
		expect(result).toBeNull();
	});

	it("returns null when usage is under the token limit", () => {
		const result = evaluateBudgets(packet, usage({ totalTokens: 49 }), {
			maxTokens: 50,
		});
		expect(result).toBeNull();
	});

	it("returns null when usage equals the token limit", () => {
		const result = evaluateBudgets(packet, usage({ totalTokens: 50 }), {
			maxTokens: 50,
		});
		expect(result).toBeNull();
	});

	it("rejects when usage exceeds token limit", () => {
		const result = evaluateBudgets(packet, usage({ totalTokens: 51 }), {
			maxTokens: 50,
		});
		expect(result).not.toBeNull();
		expect(result?.kind).toBe("reject-run");
		expect(result?.outcome).toBe("rejected");
		expect(result?.reasons).toEqual(["token budget exceeded: 51/50 tokens"]);
	});

	it("rejects on first token when maxTokens is 0", () => {
		const result = evaluateBudgets(packet, usage({ totalTokens: 1 }), {
			maxTokens: 0,
		});
		expect(result).not.toBeNull();
		expect(result?.reasons[0]).toContain("token budget exceeded: 1/0");
	});

	it("returns null when usage is under time limit", () => {
		const result = evaluateBudgets(packet, usage({ elapsedMs: 4999 }), {
			maxComputeTimeMs: 5000,
		});
		expect(result).toBeNull();
	});

	it("rejects when usage exceeds time limit", () => {
		const result = evaluateBudgets(packet, usage({ elapsedMs: 5001 }), {
			maxComputeTimeMs: 5000,
		});
		expect(result).not.toBeNull();
		expect(result?.reasons).toEqual([
			"compute time budget exceeded: 5001/5000ms",
		]);
	});

	it("reports both violations when both limits are exceeded", () => {
		const result = evaluateBudgets(
			packet,
			usage({ totalTokens: 200, elapsedMs: 6000 }),
			{ maxTokens: 100, maxComputeTimeMs: 5000 },
		);
		expect(result).not.toBeNull();
		expect(result?.reasons).toHaveLength(2);
		expect(result?.reasons[0]).toContain("token budget exceeded");
		expect(result?.reasons[1]).toContain("compute time budget exceeded");
	});

	it("returns null when budget has no maxTokens and no maxComputeTimeMs", () => {
		const result = evaluateBudgets(packet, usage({ totalTokens: 99999 }), {});
		expect(result).toBeNull();
	});
});
