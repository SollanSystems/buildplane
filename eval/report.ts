export type Condition =
	| "memory+strategy"
	| "memory+raw"
	| "nomemory+strategy"
	| "nomemory+raw";

export interface ConditionResult {
	readonly condition: Condition;
	readonly passed: boolean;
	readonly rounds: number;
	readonly learningsWritten: number;
	readonly memoriesInjected: number;
	readonly durationMs: number;
}

export interface FixtureResult {
	readonly name: string;
	readonly description: string;
	readonly conditions: readonly ConditionResult[];
}

export interface EvalReport {
	readonly suiteId: string;
	readonly fixtures: readonly FixtureResult[];
	readonly aggregates: {
		readonly totalFixtures: number;
		readonly totalConditions: number;
		readonly passRate: number;
		readonly memoryInjectedRate: number;
		readonly memoryHelpedRate: number;
		readonly strategyHelpedRate: number;
		readonly combinedHelpedRate: number;
		readonly meanDurationMs: number;
	};
}

export function computeAggregates(
	fixtures: readonly FixtureResult[],
): EvalReport["aggregates"] {
	const allConditions = fixtures.flatMap((f) => f.conditions);
	const total = allConditions.length;
	const passed = allConditions.filter((c) => c.passed).length;
	const totalDuration = allConditions.reduce((sum, c) => sum + c.durationMs, 0);

	const memoryOnFixtures = fixtures.filter((f) =>
		f.conditions.some(
			(c) =>
				(c.condition === "memory+strategy" || c.condition === "memory+raw") &&
				c.memoriesInjected > 0,
		),
	);

	let memoryHelped = 0;
	let strategyHelped = 0;
	let combinedHelped = 0;
	for (const f of fixtures) {
		const memStrat = f.conditions.find(
			(c) => c.condition === "memory+strategy",
		);
		const noMemStrat = f.conditions.find(
			(c) => c.condition === "nomemory+strategy",
		);
		const memRaw = f.conditions.find((c) => c.condition === "memory+raw");
		const noMemRaw = f.conditions.find((c) => c.condition === "nomemory+raw");
		if (memStrat && noMemStrat) {
			if (
				(memStrat.passed && !noMemStrat.passed) ||
				(memStrat.passed &&
					noMemStrat.passed &&
					memStrat.rounds > 0 &&
					memStrat.rounds < noMemStrat.rounds)
			) {
				memoryHelped++;
			}
		}
		if (
			(memStrat?.passed === true && memRaw?.passed === false) ||
			(noMemStrat?.passed === true && noMemRaw?.passed === false)
		) {
			strategyHelped++;
		}
		if (
			memStrat?.passed === true &&
			memRaw?.passed === false &&
			noMemStrat?.passed === false &&
			noMemRaw?.passed === false
		) {
			combinedHelped++;
		}
	}

	return {
		totalFixtures: fixtures.length,
		totalConditions: total,
		passRate: total > 0 ? passed / total : 0,
		memoryInjectedRate:
			fixtures.length > 0 ? memoryOnFixtures.length / fixtures.length : 0,
		memoryHelpedRate: fixtures.length > 0 ? memoryHelped / fixtures.length : 0,
		strategyHelpedRate:
			fixtures.length > 0 ? strategyHelped / fixtures.length : 0,
		combinedHelpedRate:
			fixtures.length > 0 ? combinedHelped / fixtures.length : 0,
		meanDurationMs: total > 0 ? Math.round(totalDuration / total) : 0,
	};
}

export function formatEvalReport(report: EvalReport): string {
	const lines: string[] = [];
	lines.push("━━━ Buildplane Eval Report ━━━━━━━━━━━━━━━━━━━━");
	lines.push("");

	const hdr = [
		"Fixture".padEnd(25),
		"Condition".padEnd(20),
		"Passed".padEnd(8),
		"Rounds".padEnd(8),
		"Memories".padEnd(10),
		"Duration",
	].join("");
	lines.push(hdr);

	for (const f of report.fixtures) {
		for (const c of f.conditions) {
			const row = [
				f.name.padEnd(25),
				c.condition.padEnd(20),
				(c.passed ? "✓" : "✗").padEnd(8),
				(c.rounds > 0 ? String(c.rounds) : "—").padEnd(8),
				String(c.memoriesInjected).padEnd(10),
				`${c.durationMs}ms`,
			].join("");
			lines.push(row);
		}
	}

	lines.push("");
	lines.push("━━━ Aggregates ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
	lines.push("");

	const a = report.aggregates;
	const pct = (n: number) => `${Math.round(n * 100)}%`;
	lines.push(`  Fixtures:              ${a.totalFixtures}`);
	lines.push(`  Total conditions:      ${a.totalConditions}`);
	lines.push(
		`  Pass rate:             ${pct(a.passRate)} (${Math.round(a.passRate * a.totalConditions)}/${a.totalConditions})`,
	);
	lines.push(`  Memory injected rate:  ${pct(a.memoryInjectedRate)}`);
	lines.push(`  Memory helped rate:    ${pct(a.memoryHelpedRate)}`);
	lines.push(`  Strategy helped rate:  ${pct(a.strategyHelpedRate)}`);
	lines.push(`  Combined helped rate:  ${pct(a.combinedHelpedRate)}`);
	lines.push(`  Mean duration:         ${a.meanDurationMs}ms`);

	return lines.join("\n");
}
