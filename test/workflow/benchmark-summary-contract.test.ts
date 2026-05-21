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
const documentedFixtureNames = Array.from(
	benchmarkDoc.matchAll(/^### `([^`]+)`$/gm),
	(match) => match[1],
).sort();

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
		expect(benchmarkDoc).toContain("combinedHelpedRate");
		expect(benchmarkDoc).toContain("meanDurationMs");
	});

	it("documents exactly the current model-codex fixture set", () => {
		expect(documentedFixtureNames).toEqual(fixtureNames);
	});

	it("explains the current benchmark deltas and combined-only proof", () => {
		expect(benchmarkDoc).toContain("memory changes the outcome");
		expect(benchmarkDoc).toContain("strategy changes the outcome");
		expect(benchmarkDoc).toContain("combined-only proof");
		expect(benchmarkDoc).toContain("memory-strategy-combined-only");
		expect(benchmarkDoc).not.toContain("does not currently prove");
		expect(benchmarkDoc).toMatch(/duration .* environment-sensitive/i);
	});

	it("documents a concrete reviewer-rescue comparison against raw one-shot execution", () => {
		expect(benchmarkDoc).toContain("## Concrete rescue/recovery story");
		expect(benchmarkDoc).toContain("raw one-shot path");
		expect(benchmarkDoc).toContain("implement-then-review");
		expect(benchmarkDoc).toContain("reviewer-rescue");
		expect(benchmarkDoc).toContain("`memory+raw` | fail");
		expect(benchmarkDoc).toContain("`memory+strategy` | pass");
	});
});
