import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const benchmarkDocPath = join(repoRoot, "docs/benchmarks/model-codex.md");
const benchmarkDoc = existsSync(benchmarkDocPath)
	? readFileSync(benchmarkDocPath, "utf8")
	: "";
const fixtureNames = readdirSync(join(repoRoot, "eval/suites/model-codex"), {
	withFileTypes: true,
})
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.sort();

describe("benchmark summary contract", () => {
	it("publishes the model-codex rerun contract and aggregate vocabulary", () => {
		expect(existsSync(benchmarkDocPath)).toBe(true);
		expect(benchmarkDoc).toContain("model-codex");
		expect(benchmarkDoc).toContain("BUILDPLANE_EVAL_MODEL=1");
		expect(benchmarkDoc).toContain("npx pnpm eval --suite model-codex --json");
		expect(benchmarkDoc).toContain("passRate");
		expect(benchmarkDoc).toContain("memoryInjectedRate");
		expect(benchmarkDoc).toContain("memoryHelpedRate");
		expect(benchmarkDoc).toContain("strategyHelpedRate");
		expect(benchmarkDoc).toContain("meanDurationMs");
	});

	it("documents every current model-codex fixture", () => {
		for (const fixtureName of fixtureNames) {
			expect(benchmarkDoc).toContain(`\`${fixtureName}\``);
		}
	});

	it("explains the three benchmark deltas in plain language", () => {
		expect(benchmarkDoc).toContain("memory changes the outcome");
		expect(benchmarkDoc).toContain("strategy changes the outcome");
		expect(benchmarkDoc).toContain("only `memory+strategy` succeeds");
		expect(benchmarkDoc).toMatch(/duration .* environment-sensitive/i);
	});
});
