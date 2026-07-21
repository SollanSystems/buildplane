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

	it("marks raw capability observations as unsafe and blocked strategies as non-governed", () => {
		expect(benchmarkDoc).toContain("unsafe/shadow capability benchmark");
		expect(benchmarkDoc).toContain(
			"strategy-derived rates currently remain zero",
		);
		expect(benchmarkDoc).toContain("memory-strategy-combined-only");
		expect(benchmarkDoc).toContain("does not prove provider quality");
		expect(benchmarkDoc).toMatch(/duration .* environment-sensitive/i);
	});

	it("documents reviewer-rescue as a blocked historical path", () => {
		expect(benchmarkDoc).toContain("raw one-shot execution");
		expect(benchmarkDoc).toContain("implement-then-review");
		expect(benchmarkDoc).toContain("reviewer-rescue");
		expect(benchmarkDoc).toMatch(/signed review\s+evidence/);
		expect(benchmarkDoc).toContain("read-only candidate reviewer");
	});
});
