import type { BudgetLimits, BudgetSnapshot } from "./run-loop.js";

/** Exhaustion report when a budget dimension is exceeded. */
export interface BudgetExhaustion {
	readonly dimension: "time" | "tokens" | "commands" | "steps";
	readonly limit: number;
	readonly consumed: number;
}

/**
 * Pure in-memory budget tracker.
 *
 * The orchestrator calls `check()` before each step and after
 * each tool call. If any dimension is exhausted the run should
 * be terminated.
 */
export interface BudgetEnforcer {
	/** Record token consumption. Returns true if still within budget. */
	recordTokens(count: number): boolean;

	/** Record a shell/command execution. Returns true if still within budget. */
	recordCommand(): boolean;

	/** Record one orchestrator step. Returns true if still within budget. */
	recordStep(): boolean;

	/** Check if any dimension is exhausted. Returns null if all ok. */
	check(): BudgetExhaustion | null;

	/** Current consumption snapshot. */
	snapshot(): BudgetSnapshot;
}

export function createBudgetEnforcer(
	limits: BudgetLimits,
	startTime: number,
): BudgetEnforcer {
	let totalTokens = 0;
	let commandCount = 0;
	let stepCount = 0;

	function now(): number {
		return Date.now();
	}

	function elapsedMs(): number {
		return now() - startTime;
	}

	const enforcer: BudgetEnforcer = {
		recordTokens(count: number): boolean {
			totalTokens += count;
			return enforcer.check() === null;
		},

		recordCommand(): boolean {
			commandCount += 1;
			return enforcer.check() === null;
		},

		recordStep(): boolean {
			stepCount += 1;
			return enforcer.check() === null;
		},

		check(): BudgetExhaustion | null {
			if (
				limits.maxDurationMs !== undefined &&
				elapsedMs() >= limits.maxDurationMs
			) {
				return {
					dimension: "time",
					limit: limits.maxDurationMs,
					consumed: elapsedMs(),
				};
			}
			if (
				limits.maxTotalTokens !== undefined &&
				totalTokens > limits.maxTotalTokens
			) {
				return {
					dimension: "tokens",
					limit: limits.maxTotalTokens,
					consumed: totalTokens,
				};
			}
			if (
				limits.maxCommandCount !== undefined &&
				commandCount > limits.maxCommandCount
			) {
				return {
					dimension: "commands",
					limit: limits.maxCommandCount,
					consumed: commandCount,
				};
			}
			if (limits.maxSteps !== undefined && stepCount > limits.maxSteps) {
				return {
					dimension: "steps",
					limit: limits.maxSteps,
					consumed: stepCount,
				};
			}
			return null;
		},

		snapshot(): BudgetSnapshot {
			return {
				elapsedMs: elapsedMs(),
				totalTokens,
				commandCount,
				stepCount,
			};
		},
	};

	return enforcer;
}
