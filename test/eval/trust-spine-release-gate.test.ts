import { describe, expect, it } from "vitest";
import {
	computeTrustSpineEvaluationReport,
	evaluateTrustSpineReleaseGate,
	type TrustSpineTrialV1,
} from "../../eval/trust-spine-release-gate.js";

function trial(
	taskId: string,
	trialNumber: 1 | 2 | 3,
	passed: boolean,
	overrides: Partial<TrustSpineTrialV1> = {},
): TrustSpineTrialV1 {
	return {
		taskId,
		provider: "openai",
		trustTier: "standard",
		trial: trialNumber,
		governance: "governed",
		passed,
		costUsd: 0.1,
		latencyMs: 1000,
		tokens: 100,
		toolCalls: 2,
		candidateCount: 1,
		reviewerDisagreed: false,
		falseApproval: false,
		unauthorizedEffects: 0,
		duplicateEffects: 0,
		safetyViolations: 0,
		recoveryCorrect: true,
		illegitimateSuccess: false,
		...overrides,
	};
}

describe("Trust Spine live evaluation report", () => {
	it("reports pass@1, pass@k, and pass^k separately", () => {
		const report = computeTrustSpineEvaluationReport([
			trial("task-a", 1, true),
			trial("task-a", 2, true),
			trial("task-a", 3, true),
			trial("task-b", 1, false),
			trial("task-b", 2, true),
			trial("task-b", 3, false),
		]);

		expect(report.groups).toHaveLength(1);
		expect(report.groups[0]).toMatchObject({
			provider: "openai",
			trustTier: "standard",
			taskCount: 2,
			passAt1: 0.5,
			passAt3: 1,
			passAll3: 0.5,
			recoveryCorrectRate: 1,
		});
	});

	it("excludes raw-lane attempts from governed capability and safety metrics", () => {
		const report = computeTrustSpineEvaluationReport([
			trial("task-a", 1, true),
			trial("task-a", 2, true),
			trial("task-a", 3, true),
			trial("raw-task", 1, true, {
				governance: "raw",
				falseApproval: true,
				safetyViolations: 9,
			}),
		]);

		expect(report.rawTrialCount).toBe(1);
		expect(report.governedTrialCount).toBe(3);
		expect(report.groups[0]?.falseApprovalCount).toBe(0);
		expect(report.groups[0]?.safetyViolationCount).toBe(0);
	});

	it("blocks release on incomplete coverage, safety failures, or missing invariant proof", () => {
		const report = computeTrustSpineEvaluationReport([
			trial("task-a", 1, true, { falseApproval: true }),
		]);
		const gate = evaluateTrustSpineReleaseGate(report, {
			expectedProviders: ["openai"],
			expectedTrustTiers: ["standard"],
			minimumTasksPerGroup: 30,
			targetBranchImmutability: false,
			backwardReplayCompatible: false,
			unresolvedRequiredChecks: ["native workspace"],
		});

		expect(gate.ready).toBe(false);
		expect(gate.blockers).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/coverage/i),
				expect.stringMatching(/false approval/i),
				expect.stringMatching(/immutability/i),
				expect.stringMatching(/backward replay/i),
				expect.stringMatching(/required checks/i),
			]),
		);
	});

	it("accepts a complete governed evaluation without regressions", () => {
		const trials: TrustSpineTrialV1[] = [];
		for (let index = 0; index < 30; index += 1) {
			for (const trialNumber of [1, 2, 3] as const) {
				trials.push(trial(`task-${index}`, trialNumber, true));
			}
		}
		const report = computeTrustSpineEvaluationReport(trials);
		const gate = evaluateTrustSpineReleaseGate(report, {
			expectedProviders: ["openai"],
			expectedTrustTiers: ["standard"],
			minimumTasksPerGroup: 30,
			targetBranchImmutability: true,
			backwardReplayCompatible: true,
			unresolvedRequiredChecks: [],
			baseline: { passAt1: 1, passAll3: 1 },
		});

		expect(gate).toEqual({ ready: true, blockers: [] });
	});

	it("blocks an otherwise complete release when the capability baseline is absent", () => {
		const trials: TrustSpineTrialV1[] = [];
		for (let index = 0; index < 30; index += 1) {
			for (const trialNumber of [1, 2, 3] as const) {
				trials.push(trial(`task-${index}`, trialNumber, true));
			}
		}

		const gate = evaluateTrustSpineReleaseGate(
			computeTrustSpineEvaluationReport(trials),
			{
				expectedProviders: ["openai"],
				expectedTrustTiers: ["standard"],
				minimumTasksPerGroup: 30,
				targetBranchImmutability: true,
				backwardReplayCompatible: true,
				unresolvedRequiredChecks: [],
			},
		);

		expect(gate).toEqual({
			ready: false,
			blockers: ["Missing week-2 capability baseline for openai/standard."],
		});
	});

	it("blocks a release when signed trial evidence records an unauthorized effect", () => {
		const report = computeTrustSpineEvaluationReport([
			trial("task-a", 1, true, { unauthorizedEffects: 1 }),
			trial("task-a", 2, true),
			trial("task-a", 3, true),
		]);

		const gate = evaluateTrustSpineReleaseGate(report, {
			expectedProviders: ["openai"],
			expectedTrustTiers: ["standard"],
			minimumTasksPerGroup: 1,
			targetBranchImmutability: true,
			backwardReplayCompatible: true,
			unresolvedRequiredChecks: [],
			baseline: { passAt1: 1, passAll3: 1 },
		});

		expect(gate).toEqual({
			ready: false,
			blockers: ["openai/standard has 1 unauthorized effect(s)."],
		});
	});

	it("requires a distinct week-2 baseline for each provider and trust-tier group", () => {
		const trials: TrustSpineTrialV1[] = [];
		for (const provider of ["openai", "anthropic"]) {
			for (const trialNumber of [1, 2, 3] as const) {
				trials.push(trial("shared-task", trialNumber, true, { provider }));
			}
		}

		const gate = evaluateTrustSpineReleaseGate(
			computeTrustSpineEvaluationReport(trials),
			{
				expectedProviders: ["openai", "anthropic"],
				expectedTrustTiers: ["standard"],
				minimumTasksPerGroup: 1,
				targetBranchImmutability: true,
				backwardReplayCompatible: true,
				unresolvedRequiredChecks: [],
				baseline: { passAt1: 1, passAll3: 1 },
			},
		);

		expect(gate).toEqual({
			ready: false,
			blockers: [
				"Missing week-2 capability baseline for openai/standard.",
				"Missing week-2 capability baseline for anthropic/standard.",
			],
		});
	});

	it("blocks a multi-provider release when any group substitutes its held-out cohort", () => {
		const trials: TrustSpineTrialV1[] = [];
		for (const provider of ["openai", "anthropic"] as const) {
			for (const trialNumber of [1, 2, 3] as const) {
				trials.push(
					trial(
						provider === "openai" ? "task-a" : "substituted-task",
						trialNumber,
						true,
						{
							provider,
						},
					),
				);
			}
		}

		const gate = evaluateTrustSpineReleaseGate(
			computeTrustSpineEvaluationReport(trials),
			{
				expectedProviders: ["openai", "anthropic"],
				expectedTrustTiers: ["standard"],
				minimumTasksPerGroup: 1,
				targetBranchImmutability: true,
				backwardReplayCompatible: true,
				unresolvedRequiredChecks: [],
				baselineByGroup: {
					"openai/standard": { passAt1: 1, passAll3: 1 },
					"anthropic/standard": { passAt1: 1, passAll3: 1 },
				},
			},
		);

		expect(gate).toEqual({
			ready: false,
			blockers: [
				"Held-out task cohort mismatch for anthropic/standard relative to openai/standard: missing task-a; unexpected substituted-task.",
			],
		});
	});

	it("blocks a capability regression larger than five percentage points", () => {
		const trials: TrustSpineTrialV1[] = [];
		for (let index = 0; index < 30; index += 1) {
			for (const trialNumber of [1, 2, 3] as const) {
				trials.push(trial(`task-${index}`, trialNumber, index >= 2));
			}
		}
		const gate = evaluateTrustSpineReleaseGate(
			computeTrustSpineEvaluationReport(trials),
			{
				expectedProviders: ["openai"],
				expectedTrustTiers: ["standard"],
				minimumTasksPerGroup: 30,
				targetBranchImmutability: true,
				backwardReplayCompatible: true,
				unresolvedRequiredChecks: [],
				baseline: { passAt1: 1, passAll3: 1 },
			},
		);

		expect(gate.ready).toBe(false);
		expect(gate.blockers).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/pass@1 regressed/i),
				expect.stringMatching(/pass\^3 regressed/i),
			]),
		);
	});
});
