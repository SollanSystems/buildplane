import { describe, expect, it } from "vitest";
import {
	type Condition,
	computeAggregates,
	type FixtureResult,
	formatEvalReport,
} from "../../eval/report.js";

function condition(
	name: Condition,
	passed: boolean,
	overrides?: Partial<FixtureResult["conditions"][number]>,
): FixtureResult["conditions"][number] {
	return {
		condition: name,
		passed,
		rounds: name.endsWith("+strategy") ? 2 : 0,
		learningsWritten: 1,
		memoriesInjected: name.startsWith("memory+") ? 1 : 0,
		durationMs: 10,
		...overrides,
	};
}

function fixture(
	name: string,
	results: {
		readonly memoryStrategy: boolean;
		readonly memoryRaw: boolean;
		readonly noMemoryStrategy: boolean;
		readonly noMemoryRaw: boolean;
	},
): FixtureResult {
	return {
		name,
		description: name,
		conditions: [
			condition("memory+strategy", results.memoryStrategy),
			condition("memory+raw", results.memoryRaw),
			condition("nomemory+strategy", results.noMemoryStrategy),
			condition("nomemory+raw", results.noMemoryRaw),
		],
	};
}

describe("eval report aggregates", () => {
	it("counts fixtures where only memory plus strategy succeeds", () => {
		const aggregates = computeAggregates([
			fixture("combined-only", {
				memoryStrategy: true,
				memoryRaw: false,
				noMemoryStrategy: false,
				noMemoryRaw: false,
			}),
			fixture("strategy-only", {
				memoryStrategy: true,
				memoryRaw: false,
				noMemoryStrategy: true,
				noMemoryRaw: false,
			}),
		]);

		expect(aggregates.combinedHelpedRate).toBe(0.5);
		expect(aggregates.memoryHelpedRate).toBe(0.5);
		expect(aggregates.strategyHelpedRate).toBe(1);
	});

	it("prints the combined-helped aggregate for benchmark summaries", () => {
		const report = formatEvalReport({
			suiteId: "model-codex",
			fixtures: [],
			aggregates: {
				totalFixtures: 0,
				totalConditions: 0,
				passRate: 0,
				memoryInjectedRate: 0,
				memoryHelpedRate: 0,
				strategyHelpedRate: 0,
				combinedHelpedRate: 0,
				meanDurationMs: 0,
			},
		});

		expect(report).toContain("Combined helped rate");
	});
});
