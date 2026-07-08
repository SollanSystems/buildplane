import { describe, expect, it } from "vitest";
import {
	architectureDiffScopeDecision,
	evaluateArchitectureDiffScope,
} from "../src/diff-scope";

describe("architecture.diff_scope gate", () => {
	const gate = {
		allowedPaths: ["src/**", "tests/**", "package.json"],
		deniedPaths: ["src/legacy/**"],
	};

	it("passes deterministic diffs that stay inside allowed architecture scope", () => {
		const result = evaluateArchitectureDiffScope(
			["./src/domain/runBundle.ts", "tests/runBundle.test.ts", "package.json"],
			gate,
		);
		expect(result).toMatchObject({
			gate: "architecture.diff_scope",
			status: "passed",
			outOfScopeFiles: [],
			deniedFiles: [],
		});
		expect(result.changedFiles).toEqual([
			"src/domain/runBundle.ts",
			"tests/runBundle.test.ts",
			"package.json",
		]);
		expect(architectureDiffScopeDecision(result)).toBeUndefined();
	});

	it("matches middle-wildcard allowed globs the way the broker's minimatch does", () => {
		const result = evaluateArchitectureDiffScope(
			[
				"packages/kernel/src/orchestrator.ts",
				"native/crates/bp-ledger/src/kind.rs",
				"packages/kernel/test/loop.test.ts",
			],
			{
				allowedPaths: ["packages/**/src/**", "native/crates/**/src/**"],
			},
		);
		expect(result.status).toBe("blocked");
		expect(result.outOfScopeFiles).toEqual([
			"packages/kernel/test/loop.test.ts",
		]);
	});

	it("applies middle-wildcard denied globs", () => {
		const result = evaluateArchitectureDiffScope(
			["packages/kernel/src/generated/types.ts"],
			{
				allowedPaths: ["packages/**"],
				deniedPaths: ["packages/**/generated/**"],
			},
		);
		expect(result.status).toBe("blocked");
		expect(result.deniedFiles).toEqual([
			"packages/kernel/src/generated/types.ts",
		]);
	});

	it("no longer matches the bare prefix as a file for trailing /** (minimatch semantics)", () => {
		const result = evaluateArchitectureDiffScope(["src"], {
			allowedPaths: ["src/**"],
		});
		expect(result.status).toBe("blocked");
		expect(result.outOfScopeFiles).toEqual(["src"]);
	});

	it("treats * as a single top-level segment (minimatch semantics)", () => {
		const result = evaluateArchitectureDiffScope(["readme.md", "docs/x.md"], {
			allowedPaths: ["*"],
		});
		expect(result.status).toBe("blocked");
		expect(result.changedFiles).toEqual(["readme.md", "docs/x.md"]);
		expect(result.outOfScopeFiles).toEqual(["docs/x.md"]);
	});

	it("blocks out-of-scope or denied diffs without LLM judgment", () => {
		const result = evaluateArchitectureDiffScope(
			[
				"src/feature.ts",
				"src/legacy/unsafe.ts",
				"infra/prod.tf",
				"../outside.txt",
			],
			gate,
		);
		expect(result.status).toBe("blocked");
		expect(result.deniedFiles).toEqual(["src/legacy/unsafe.ts"]);
		expect(result.outOfScopeFiles).toEqual(["infra/prod.tf"]);
		expect(result.reasons).toEqual(
			expect.arrayContaining([
				expect.stringContaining(
					"architecture.diff_scope blocked src/legacy/unsafe.ts",
				),
				expect.stringContaining(
					"architecture.diff_scope blocked infra/prod.tf",
				),
				expect.stringContaining("Invalid diff path ../outside.txt"),
			]),
		);
		expect(architectureDiffScopeDecision(result)).toMatchObject({
			outcome: "rejected",
			kind: "architecture.diff_scope",
		});
	});
});
