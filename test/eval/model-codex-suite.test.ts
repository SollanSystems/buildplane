import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const cleanupPaths: string[] = [];
const REQUIRED_BUILD_OUTPUTS = [
	"apps/cli/dist/index.js",
	"packages/kernel/dist/index.js",
	"packages/runtime/dist/index.js",
	"packages/policy/dist/index.js",
	"packages/storage/dist/index.js",
	"packages/adapters-git/dist/index.js",
	"packages/adapters-models/dist/index.js",
	"packages/adapters-codex/dist/index.js",
] as const;
const REQUIRED_FRESHNESS_CHECKS = [
	[
		"packages/adapters-codex/src/codex-executor.ts",
		"packages/adapters-codex/dist/index.js",
	],
] as const;

function ensureWorkspaceBuildOutputs() {
	const missing = REQUIRED_BUILD_OUTPUTS.filter(
		(relativePath) => !existsSync(join(root, relativePath)),
	);
	const stale = REQUIRED_FRESHNESS_CHECKS.some(
		([sourcePath, outputPath]) =>
			existsSync(join(root, sourcePath)) &&
			existsSync(join(root, outputPath)) &&
			statSync(join(root, sourcePath)).mtimeMs >
				statSync(join(root, outputPath)).mtimeMs,
	);
	if (missing.length === 0 && !stale) {
		return;
	}
	const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
	execFileSync(npxCommand, ["pnpm", "build"], { cwd: root, stdio: "pipe" });
}

function runEval(
	args: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
) {
	return spawnSync(
		process.execPath,
		["--import", "tsx", "./eval/runner.ts", ...args],
		{
			cwd: root,
			encoding: "utf8",
			env,
		},
	);
}

function createCodexStub(binRoot: string): string {
	const stubPath = join(
		binRoot,
		process.platform === "win32" ? "codex.cmd" : "codex",
	);
	mkdirSync(binRoot, { recursive: true });
	if (process.platform === "win32") {
		const jsPath = join(
			binRoot,
			"node_modules",
			"@openai",
			"codex",
			"bin",
			"codex.js",
		);
		mkdirSync(join(binRoot, "node_modules", "@openai", "codex", "bin"), {
			recursive: true,
		});
		writeFileSync(
			jsPath,
			[
				"const fs = require('node:fs');",
				"const path = require('node:path');",
				"const prompt = process.argv.slice(2).join(' ');",
				"fs.mkdirSync('output', { recursive: true });",
				"if (prompt.includes('Review the implementer output')) {",
				"  const reviewerRescuePath = path.join('output', 'reviewer-rescue.js');",
				"  if (fs.existsSync(reviewerRescuePath)) {",
				"    const reviewerRescueBody = fs.readFileSync(reviewerRescuePath, 'utf8');",
				"    process.exit(reviewerRescueBody.includes('approved') ? 0 : 1);",
				"  }",
				"  const hasJs = fs.existsSync('output') && fs.readdirSync('output').some((entry) => entry.endsWith('.js'));",
				"  process.exit(hasJs ? 0 : 1);",
				"}",
				"if (prompt.includes('output/reviewer-rescue.js') || prompt.includes('output\\\\reviewer-rescue.js')) {",
				"  const reviewerRescueContent = prompt.includes('Reviewer feedback from round 1') ? \"console.log('approved reviewer rescue')\\n\" : \"console.log('draft reviewer rescue')\\n\";",
				"  fs.writeFileSync(path.join('output', 'reviewer-rescue.js'), reviewerRescueContent);",
				"  process.exit(0);",
				"}",
				"if (prompt.includes('output/memory-helped.js') || prompt.includes('output\\\\memory-helped.js')) {",
				"  fs.writeFileSync(path.join('output', 'memory-helped.js'), \"console.log('memory helped')\\n\");",
				"  process.exit(0);",
				"}",
				"if (prompt.includes('output/hello.js') || prompt.includes('output\\\\hello.js')) {",
				"  fs.writeFileSync(path.join('output', 'hello.js'), \"console.log('hello from codex')\\n\");",
				"  process.exit(0);",
				"}",
				"process.exit(1);",
			].join("\r\n"),
		);
		writeFileSync(
			stubPath,
			[
				"@ECHO off",
				"SETLOCAL",
				"CALL :find_dp0",
				'IF EXIST "%dp0%\\node.exe" (',
				'  SET "_prog=%dp0%\\node.exe"',
				") ELSE (",
				'  SET "_prog=node"',
				"  SET PATHEXT=%PATHEXT:;.JS;=;%",
				")",
				'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
				":find_dp0",
				"SET dp0=%~dp0",
				"EXIT /b",
			].join("\r\n"),
		);
	} else {
		writeFileSync(
			stubPath,
			[
				"#!/usr/bin/env sh",
				"set -eu",
				'prompt="$*"',
				"mkdir -p output",
				"if printf '%s' \"$prompt\" | grep -Fq 'Review the implementer output'; then",
				"  if [ -f output/reviewer-rescue.js ]; then",
				"    if grep -Fq 'approved' output/reviewer-rescue.js; then exit 0; fi",
				"    exit 1",
				"  fi",
				"  if find output -maxdepth 1 -type f -name '*.js' | grep -q .; then exit 0; fi",
				"  exit 1",
				"fi",
				"if printf '%s' \"$prompt\" | grep -Fq 'output/reviewer-rescue.js'; then",
				"  if printf '%s' \"$prompt\" | grep -Fq 'Reviewer feedback from round 1'; then",
				"    printf 'console.log(\"approved reviewer rescue\")\\n' > output/reviewer-rescue.js",
				"  else",
				"    printf 'console.log(\"draft reviewer rescue\")\\n' > output/reviewer-rescue.js",
				"  fi",
				"  exit 0",
				"fi",
				"if printf '%s' \"$prompt\" | grep -Fq 'output/memory-helped.js'; then",
				"  printf 'console.log(\"memory helped\")\\n' > output/memory-helped.js",
				"  exit 0",
				"fi",
				"if printf '%s' \"$prompt\" | grep -Fq 'output/hello.js'; then",
				"  printf 'console.log(\"hello from codex\")\\n' > output/hello.js",
				"  exit 0",
				"fi",
				"exit 1",
			].join("\n"),
		);
		spawnSync("chmod", ["+x", stubPath], { encoding: "utf8" });
	}
	return stubPath;
}

afterEach(() => {
	for (const path of cleanupPaths.splice(0)) {
		rmSync(path, { force: true, recursive: true });
	}
});

describe("model-codex eval suite", () => {
	it("fails fast when the model suite is requested without explicit opt-in", () => {
		ensureWorkspaceBuildOutputs();

		const result = runEval(["--suite", "model-codex", "--json"]);

		expect(result.status).toBe(1);
		expect(`${result.stderr}${result.stdout}`).toContain(
			"BUILDPLANE_EVAL_MODEL=1",
		);
	});

	it("does not allow path-variant suite names to bypass the model opt-in gate", () => {
		ensureWorkspaceBuildOutputs();

		const result = runEval(["--suite", "./model-codex", "--json"]);

		expect(result.status).toBe(1);
		expect(`${result.stderr}${result.stdout}`).toContain(
			"Suite ids must be bare names without path segments",
		);
	});

	it("treats mixed-case model suite names as the same gated suite", () => {
		ensureWorkspaceBuildOutputs();

		const result = runEval(["--suite", "MODEL-CODEX", "--json"]);

		expect(result.status).toBe(1);
		expect(`${result.stderr}${result.stdout}`).toContain(
			"BUILDPLANE_EVAL_MODEL=1",
		);
	});

	it("runs the opt-in Codex model suite with a stub codex binary", {
		timeout: 10_000,
	}, () => {
		ensureWorkspaceBuildOutputs();

		const tempRoot = mkdtempSync(
			join(tmpdir(), "buildplane-model-codex-suite-"),
		);
		cleanupPaths.push(tempRoot);
		const binRoot = join(tempRoot, "bin");
		createCodexStub(binRoot);

		const env = {
			...process.env,
			BUILDPLANE_EVAL_MODEL: "1",
			PATH: [binRoot, process.env.PATH ?? ""]
				.filter(Boolean)
				.join(process.platform === "win32" ? ";" : ":"),
		};

		const result = runEval(["--suite", "model-codex", "--json"], env);

		expect(result.status).toBe(0);
		expect(result.stderr).not.toContain("Fatal error");
		const report = JSON.parse(result.stdout) as {
			suiteId: string;
			fixtures: Array<{
				name: string;
				conditions: Array<{
					condition: string;
					passed: boolean;
					memoriesInjected: number;
				}>;
			}>;
			aggregates: {
				totalFixtures: number;
				totalConditions: number;
				memoryInjectedRate: number;
				memoryHelpedRate: number;
				strategyHelpedRate: number;
			};
		};

		expect(report.suiteId).toBe("model-codex");
		expect(report.aggregates.totalFixtures).toBe(3);
		expect(report.aggregates.totalConditions).toBe(12);
		expect(report.aggregates.memoryInjectedRate).toBeGreaterThan(0);
		expect(report.aggregates.memoryHelpedRate).toBeGreaterThan(0);
		expect(report.aggregates.strategyHelpedRate).toBeGreaterThan(0);
		const fixtures = new Map(
			report.fixtures.map((fixture) => [fixture.name, fixture]),
		);
		const helloConditions =
			fixtures.get("hello-memory-smoke")?.conditions ?? [];
		expect(helloConditions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					condition: "memory+strategy",
					passed: true,
					memoriesInjected: expect.any(Number),
				}),
				expect.objectContaining({
					condition: "memory+raw",
					passed: true,
					memoriesInjected: expect.any(Number),
				}),
				expect.objectContaining({
					condition: "nomemory+strategy",
					passed: true,
					memoriesInjected: 0,
				}),
				expect.objectContaining({
					condition: "nomemory+raw",
					passed: true,
					memoriesInjected: 0,
				}),
			]),
		);
		const memoryHelpConditions =
			fixtures.get("memory-helped-path")?.conditions ?? [];
		expect(memoryHelpConditions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					condition: "memory+strategy",
					passed: true,
					memoriesInjected: expect.any(Number),
				}),
				expect.objectContaining({
					condition: "memory+raw",
					passed: true,
					memoriesInjected: expect.any(Number),
				}),
				expect.objectContaining({
					condition: "nomemory+strategy",
					passed: false,
					memoriesInjected: 0,
				}),
				expect.objectContaining({
					condition: "nomemory+raw",
					passed: false,
					memoriesInjected: 0,
				}),
			]),
		);
		const reviewerRescueConditions =
			fixtures.get("reviewer-rescue")?.conditions ?? [];
		expect(reviewerRescueConditions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ condition: "memory+strategy", passed: true }),
				expect.objectContaining({ condition: "memory+raw", passed: false }),
				expect.objectContaining({
					condition: "nomemory+strategy",
					passed: true,
				}),
				expect.objectContaining({ condition: "nomemory+raw", passed: false }),
			]),
		);
		expect(
			helloConditions
				.filter((condition) => condition.condition.startsWith("memory+"))
				.every((condition) => condition.memoriesInjected > 0),
		).toBe(true);
		expect(
			memoryHelpConditions
				.filter((condition) => condition.condition.startsWith("memory+"))
				.every((condition) => condition.memoriesInjected > 0),
		).toBe(true);
	});
});
