import type {
	ExecutionReceipt,
	PolicyProfile,
	UnitPacket,
} from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import { evaluateRun } from "../src/decision";

const packet: UnitPacket = {
	unit: {
		id: "unit-retry",
		kind: "model",
		scope: "task",
		inputRefs: [],
		expectedOutputs: ["out.txt"],
		verificationContract: "exit-0-and-required-outputs",
		policyProfile: "default",
	},
	model: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
	verification: { requiredOutputs: ["out.txt"] },
};

const retryProfile: PolicyProfile = {
	name: "retry-twice",
	retry: { maxRetries: 2, injectFailureContext: true },
};

function receipt(overrides?: Partial<ExecutionReceipt>): ExecutionReceipt {
	return {
		command: "model",
		args: [],
		cwd: ".",
		startedAt: "2026-03-23T00:00:00Z",
		completedAt: "2026-03-23T00:00:01Z",
		exitCode: 0,
		stdout: "",
		stderr: "",
		outputChecks: [{ path: "out.txt", exists: true }],
		...overrides,
	};
}

describe("retry-aware evaluateRun", () => {
	it("returns retry-run on first failure with retry policy", () => {
		const decision = evaluateRun(
			packet,
			receipt({ exitCode: 1 }),
			retryProfile,
			0,
		);

		expect(decision.kind).toBe("retry-run");
		expect(decision.outcome).toBe("retrying");
		if (decision.kind === "retry-run") {
			expect(decision.attemptNumber).toBe(1);
			expect(decision.feedbackContext).toContain("command exited with code 1");
		}
	});

	it("returns retry-run on second failure when retries remain", () => {
		const decision = evaluateRun(
			packet,
			receipt({ exitCode: 1 }),
			retryProfile,
			1,
		);

		expect(decision.kind).toBe("retry-run");
		if (decision.kind === "retry-run") {
			expect(decision.attemptNumber).toBe(2);
		}
	});

	it("returns reject-run when retries exhausted", () => {
		const decision = evaluateRun(
			packet,
			receipt({ exitCode: 1 }),
			retryProfile,
			2,
		);

		expect(decision.kind).toBe("reject-run");
		expect(decision.outcome).toBe("rejected");
	});

	it("returns reject-run on failure without retry policy", () => {
		const decision = evaluateRun(packet, receipt({ exitCode: 1 }));

		expect(decision.kind).toBe("reject-run");
	});

	it("returns advance-run on success regardless of retry policy", () => {
		const decision = evaluateRun(packet, receipt(), retryProfile, 0);

		expect(decision.kind).toBe("advance-run");
		expect(decision.outcome).toBe("approved");
	});

	it("omits feedback context when injectFailureContext is false", () => {
		const noFeedbackProfile: PolicyProfile = {
			name: "no-feedback",
			retry: { maxRetries: 1, injectFailureContext: false },
		};

		const decision = evaluateRun(
			packet,
			receipt({ exitCode: 1 }),
			noFeedbackProfile,
			0,
		);

		expect(decision.kind).toBe("retry-run");
		if (decision.kind === "retry-run") {
			expect(decision.feedbackContext).toEqual([]);
		}
	});

	it("retries on missing outputs", () => {
		const decision = evaluateRun(
			packet,
			receipt({ outputChecks: [{ path: "out.txt", exists: false }] }),
			retryProfile,
			0,
		);

		expect(decision.kind).toBe("retry-run");
		if (decision.kind === "retry-run") {
			expect(decision.feedbackContext).toContain(
				"required output missing: out.txt",
			);
		}
	});
});
