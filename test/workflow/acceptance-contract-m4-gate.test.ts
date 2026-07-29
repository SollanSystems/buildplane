import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * M4's former local admit → dispatch → merge contract is deliberately retired.
 * PlanForge admission is now a broker-owned boundary: the CLI may forward source
 * bytes to a privileged host, but it cannot mint local authority or tape events.
 */

interface GateEnv {
	dir: string;
	cleanup: () => Promise<void>;
}

function runGit(cwd: string, args: readonly string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
		),
	});
}

async function makeGateEnv(): Promise<GateEnv> {
	const dir = await mkdtemp(join(tmpdir(), "bp-m4-gate-ws-"));
	runGit(dir, ["init", "-q"]);
	runGit(dir, ["config", "user.email", "test@test"]);
	runGit(dir, ["config", "user.name", "test"]);
	runGit(dir, ["commit", "-q", "--allow-empty", "-m", "init"]);
	return {
		dir,
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

async function loadRunCli() {
	const mod = (await import("../../apps/cli/src/run-cli.js")) as {
		runCli: (
			argv: string[],
			options?: {
				cwd?: string;
				stdout?: (line: string) => void;
				stderr?: (line: string) => void;
			},
		) => Promise<number>;
	};
	return mod.runCli;
}

async function runCliCapture(
	argv: string[],
	cwd: string,
): Promise<{ code: number; threw: boolean; out: string; err: string }> {
	const runCli = await loadRunCli();
	const out: string[] = [];
	const err: string[] = [];
	try {
		const code = await runCli(argv, {
			cwd,
			stdout: (line) => out.push(line),
			stderr: (line) => err.push(line),
		});
		return { code, threw: false, out: out.join("\n"), err: err.join("\n") };
	} catch (error) {
		return {
			code: 1,
			threw: true,
			out: out.join("\n"),
			err: err.join("\n") || String(error),
		};
	}
}

function projectRootLog(dir: string): string {
	return runGit(dir, ["log", "--oneline"]);
}

function expectNoLocalAuthorityOrTape(dir: string): void {
	const stateDir = join(dir, ".buildplane");
	expect(existsSync(stateDir)).toBe(false);
	expect(existsSync(join(stateDir, "ledger", "events.db"))).toBe(false);
}

describe("M4 GATE — PlanForge admission remains host-brokered", () => {
	let env: GateEnv;

	beforeEach(async () => {
		env = await makeGateEnv();
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it("fails closed without a privileged host broker before recording local admission authority", async () => {
		const beforeLog = projectRootLog(env.dir);
		const result = await runCliCapture(
			[
				"planforge",
				"admit",
				"--input",
				join(env.dir, "missing-plan.md"),
				"--approve",
				"--json",
			],
			env.dir,
		);

		expect(result.threw).toBe(false);
		expect(result.code).toBe(1);
		expect(result.err).toBe("");
		expect(result.out).toContain(
			"PlanForge governed broker is unavailable; no admission was recorded.",
		);
		expectNoLocalAuthorityOrTape(env.dir);
		expect(projectRootLog(env.dir)).toBe(beforeLog);
	});

	it("rejects the retired local --operator admit shape before it can create authority", async () => {
		const beforeLog = projectRootLog(env.dir);
		const result = await runCliCapture(
			[
				"planforge",
				"admit",
				"--input",
				join(env.dir, "missing-plan.md"),
				"--approve",
				"--operator",
				"op1",
				"--json",
			],
			env.dir,
		);

		expect(result.threw).toBe(false);
		expect(result.code).toBe(1);
		expect(result.err).toBe("");
		expect(result.out).toContain(
			"Unsupported PlanForge governed admit argument: --operator",
		);
		expectNoLocalAuthorityOrTape(env.dir);
		expect(projectRootLog(env.dir)).toBe(beforeLog);
	});
});
