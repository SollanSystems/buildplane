import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
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

function ensureWorkspaceBuildOutputs() {
	const missing = REQUIRED_BUILD_OUTPUTS.filter(
		(relativePath) => !existsSync(join(root, relativePath)),
	);
	if (missing.length === 0) {
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
		writeFileSync(
			stubPath,
			[
				"@echo off",
				"if not exist output mkdir output",
				"echo console.log('hello from codex');> output\\hello.js",
				"exit /b 0",
			].join("\r\n"),
		);
	} else {
		writeFileSync(
			stubPath,
			[
				"#!/usr/bin/env sh",
				"mkdir -p output",
				"printf 'console.log(\"hello from codex\")\n' > output/hello.js",
				"exit 0",
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

	it("runs the opt-in Codex model suite with a stub codex binary", () => {
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
			};
		};

		expect(report.suiteId).toBe("model-codex");
		expect(report.aggregates.totalFixtures).toBe(1);
		expect(report.aggregates.totalConditions).toBe(4);
		expect(report.aggregates.memoryInjectedRate).toBeGreaterThan(0);
		const conditions = report.fixtures[0]?.conditions ?? [];
		expect(conditions).toEqual(
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
		expect(
			conditions
				.filter((condition) => condition.condition.startsWith("memory+"))
				.every((condition) => condition.memoriesInjected > 0),
		).toBe(true);
	});
});
