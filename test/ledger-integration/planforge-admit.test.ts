import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface AdmitEnvironment {
	root: string;
	inputPath: string;
}

async function runAdmit(
	argv: string[],
	cwd: string,
): Promise<{ code: number; stderr: string[] }> {
	const { runCli } = (await import("../../apps/cli/src/run-cli.js")) as {
		runCli: (
			args: string[],
			options: {
				cwd: string;
				stdout: (line: string) => void;
				stderr: (line: string) => void;
			},
		) => Promise<number>;
	};
	const stderr: string[] = [];
	const code = await runCli(argv, {
		cwd,
		stdout: () => {},
		stderr: (line) => stderr.push(line),
	});
	return { code, stderr };
}

describe("PlanForge admission host boundary", () => {
	let env: AdmitEnvironment;

	beforeEach(() => {
		const root = mkdtempSync(join(tmpdir(), "bp-planforge-admit-"));
		const inputPath = join(root, "untrusted-plan.md");
		writeFileSync(inputPath, "untrusted plan source\n");
		env = { root, inputPath };
	});

	afterEach(() => {
		rmSync(env.root, { recursive: true, force: true });
	});

	it("fails closed without a privileged host and creates no local authority", async () => {
		const result = await runAdmit(
			["planforge", "admit", "--input", env.inputPath, "--approve", "--json"],
			env.root,
		);

		expect(result.code).not.toBe(0);
		expect(existsSync(join(env.root, ".buildplane"))).toBe(false);
		expect(
			existsSync(join(env.root, ".buildplane", "ledger", "events.db")),
		).toBe(false);
	});

	it("rejects the retired local operator argument before any admission effect", async () => {
		const result = await runAdmit(
			[
				"planforge",
				"admit",
				"--input",
				env.inputPath,
				"--approve",
				"--operator",
				"khall",
			],
			env.root,
		);

		expect(result.code).not.toBe(0);
		expect(result.stderr.join("\n")).toMatch(/unsupported.*operator/i);
		expect(existsSync(join(env.root, ".buildplane"))).toBe(false);
	});

	it("requires explicit approval before it resolves host authority", async () => {
		const result = await runAdmit(
			["planforge", "admit", "--input", env.inputPath],
			env.root,
		);

		expect(result.code).not.toBe(0);
		expect(result.stderr.join("\n")).toMatch(/requires explicit --approve/i);
		expect(existsSync(join(env.root, ".buildplane"))).toBe(false);
	});
});
