/**
 * Strategy executor end-to-end integration tests.
 *
 * Exercises run-strategy via the CLI (same pattern as local-run-loop e2e tests)
 * to avoid direct package imports that may not resolve in the root test context.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../apps/cli/src/run-cli.js";

function isolatedGitEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_")) {
			delete env[key];
		}
	}
	return env;
}

function git(root: string, args: string[]): void {
	execFileSync("git", args, {
		cwd: root,
		env: isolatedGitEnv(),
		stdio: "pipe",
	});
}

function createGitRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "bp-strategy-e2e-"));

	git(root, ["init"]);
	git(root, ["config", "user.name", "Test"]);
	git(root, ["config", "user.email", "test@example.com"]);
	writeFileSync(join(root, ".gitignore"), ".buildplane/\n");
	writeFileSync(join(root, "readme.txt"), "initial\n");
	git(root, ["add", "."]);
	git(root, ["commit", "-m", "baseline"]);

	return root;
}

function writeCommittedJson(root: string, name: string, data: unknown): string {
	const path = join(root, name);
	writeFileSync(path, JSON.stringify(data));
	git(root, ["add", name]);
	git(root, ["commit", "-m", `add ${name}`]);
	return path;
}

async function runCliCapture(cwd: string, argv: string[]) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const exitCode = await runCli(argv, {
		cwd,
		stdout: (line) => stdout.push(line),
		stderr: (line) => stderr.push(line),
	});
	return { exitCode, stdout, stderr };
}

function makeCommandPacket(id: string, command: string, args: string[] = []) {
	return {
		unit: {
			id,
			kind: "command",
			scope: "task",
			inputRefs: [],
			expectedOutputs: [],
			verificationContract: "exit-0",
			policyProfile: "default",
		},
		execution: { command, ...(args.length > 0 ? { args } : {}) },
		verification: { requiredOutputs: [] },
	};
}

describe("strategy executor end-to-end", () => {
	it("single mode: passing command → outcome passed, merge accepted", async () => {
		const root = createGitRepo();
		await runCliCapture(root, ["init"]);

		const strategyPath = writeCommittedJson(root, "strategy.json", {
			id: "strategy-single-pass",
			mode: "single",
			mergePolicy: "direct",
			children: [
				{
					role: "implementer",
					packet: makeCommandPacket("unit-impl", "node", [
						"-e",
						"process.stdout.write('hello')",
					]),
				},
			],
		});

		const { exitCode, stdout } = await runCliCapture(root, [
			"run-strategy",
			"--raw",
			"--strategy",
			strategyPath,
		]);

		expect(exitCode).toBe(0);
		expect(stdout.join("\n")).toContain("passed");
		expect(stdout.join("\n")).toContain("accepted");
	});

	it("single mode: failing command → outcome failed, merge rejected", async () => {
		const root = createGitRepo();
		await runCliCapture(root, ["init"]);

		const strategyPath = writeCommittedJson(root, "strategy.json", {
			id: "strategy-single-fail",
			mode: "single",
			mergePolicy: "direct",
			children: [
				{
					role: "implementer",
					packet: makeCommandPacket("unit-impl-fail", "false"),
				},
			],
		});

		const { exitCode, stdout } = await runCliCapture(root, [
			"run-strategy",
			"--raw",
			"--strategy",
			strategyPath,
		]);

		expect(exitCode).toBe(1);
		expect(stdout.join("\n")).toContain("failed");
		expect(stdout.join("\n")).toContain("rejected");
	});

	it("run-strategy blocks a raw review strategy before either child dispatches", async () => {
		const root = createGitRepo();
		await runCliCapture(root, ["init"]);

		const strategyPath = writeCommittedJson(root, "strategy.json", {
			id: "strategy-itr-pass",
			mode: "implement-then-review",
			mergePolicy: "reviewer-must-approve",
			children: [
				{
					role: "implementer",
					packet: makeCommandPacket("unit-impl-itr", "node", [
						"-e",
						"process.stdout.write('implemented')",
					]),
				},
				{
					role: "reviewer",
					packet: makeCommandPacket("unit-reviewer-itr", "node", [
						"-e",
						"process.stdout.write('approved')",
					]),
					dependsOn: ["unit-impl-itr"],
				},
			],
		});

		const { exitCode, stdout } = await runCliCapture(root, [
			"run-strategy",
			"--raw",
			"--strategy",
			strategyPath,
		]);

		expect(exitCode).toBe(1);
		expect(stdout.join("\n")).toContain("governance: unsafe");
		expect(stdout.join("\n")).toContain("failed");
		expect(stdout.join("\n")).toMatch(
			/raw review strategies are blocked.*pre-promotion review/i,
		);
	});

	it("raw review strategy does not run an implementer before a rejecting reviewer", async () => {
		const root = createGitRepo();
		await runCliCapture(root, ["init"]);

		const strategyPath = writeCommittedJson(root, "strategy.json", {
			id: "strategy-itr-reject",
			mode: "implement-then-review",
			mergePolicy: "reviewer-must-approve",
			children: [
				{
					role: "implementer",
					packet: makeCommandPacket("unit-impl-reject", "node", [
						"-e",
						"require('fs').writeFileSync('implemented.txt', 'candidate')",
					]),
				},
				{
					role: "reviewer",
					packet: makeCommandPacket("unit-reviewer-reject", "false"),
					dependsOn: ["unit-impl-reject"],
				},
			],
		});
		const { exitCode, stdout } = await runCliCapture(root, [
			"run-strategy",
			"--raw",
			"--strategy",
			strategyPath,
		]);

		expect(exitCode).toBe(1);
		expect(stdout.join("\n")).toContain("rejected");
		expect(stdout.join("\n")).toContain("governance: unsafe");
		expect(stdout.join("\n")).toMatch(
			/raw review strategies are blocked.*pre-promotion review/i,
		);
		expect(existsSync(join(root, "implemented.txt"))).toBe(false);
	});

	it("raw review strategy blocks before an otherwise failing implementer dispatches", async () => {
		const root = createGitRepo();
		await runCliCapture(root, ["init"]);

		const strategyPath = writeCommittedJson(root, "strategy.json", {
			id: "strategy-itr-impl-fail",
			mode: "implement-then-review",
			mergePolicy: "reviewer-must-approve",
			children: [
				{
					role: "implementer",
					packet: makeCommandPacket("unit-impl-fail-itr", "false"),
				},
				{
					role: "reviewer",
					packet: makeCommandPacket("unit-reviewer-noop", "echo", ["review"]),
					dependsOn: ["unit-impl-fail-itr"],
				},
			],
		});

		const { exitCode, stdout } = await runCliCapture(root, [
			"run-strategy",
			"--raw",
			"--strategy",
			strategyPath,
		]);

		expect(exitCode).toBe(1);
		expect(stdout.join("\n")).toContain("rejected");
		expect(stdout.join("\n")).toMatch(
			/raw review strategies are blocked.*pre-promotion review/i,
		);
	});
});
