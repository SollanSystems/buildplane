import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * GAP-3's local acceptance-default path is retired. PlanForge can only admit
 * work and open a candidate through a privileged host authority broker; the
 * legacy local dispatcher cannot be re-enabled with an acceptance opt-out.
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
	const dir = await mkdtemp(join(tmpdir(), "bp-gap3-enforce-ws-"));
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

function rootSnapshot(dir: string): {
	readonly head: string;
	readonly log: string;
	readonly status: string;
	readonly tree: string;
} {
	return {
		head: runGit(dir, ["rev-parse", "HEAD"]).trim(),
		log: runGit(dir, ["log", "--oneline"]),
		status: runGit(dir, ["status", "--porcelain=v1", "--untracked-files=all"]),
		tree: runGit(dir, ["rev-parse", "HEAD^{tree}"]).trim(),
	};
}

function expectNoLocalAuthorityOrTape(dir: string): void {
	const stateDir = join(dir, ".buildplane");
	expect(existsSync(stateDir)).toBe(false);
	expect(existsSync(join(stateDir, "ledger", "events.db"))).toBe(false);
}

describe("GAP-3: PlanForge remains a broker-governed boundary", () => {
	let env: GateEnv;

	beforeEach(async () => {
		env = await makeGateEnv();
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it("does not mint local admission authority when the host broker is unavailable", async () => {
		const before = rootSnapshot(env.dir);
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
		expect(rootSnapshot(env.dir)).toEqual(before);
	});

	it("does not start a candidate from opaque references when the host broker is unavailable", async () => {
		const before = rootSnapshot(env.dir);
		const result = await runCliCapture(
			[
				"planforge",
				"dispatch",
				"--admission-ref",
				"host-admission/plan-123",
				"--task-ref",
				"host-task/one",
				"--json",
			],
			env.dir,
		);

		expect(result.threw).toBe(false);
		expect(result.code).toBe(1);
		expect(result.err).toBe("");
		expect(result.out).toContain(
			"PlanForge governed broker is unavailable; no candidate was started.",
		);
		expectNoLocalAuthorityOrTape(env.dir);
		expect(rootSnapshot(env.dir)).toEqual(before);
	});

	it("cannot use --no-enforce-acceptance to reopen the retired local dispatch lane", async () => {
		const before = rootSnapshot(env.dir);
		const result = await runCliCapture(
			[
				"planforge",
				"dispatch",
				"--input",
				join(env.dir, "missing-plan.md"),
				"--no-enforce-acceptance",
				"--json",
			],
			env.dir,
		);

		expect(result.threw).toBe(false);
		expect(result.code).toBe(1);
		expect(result.err).toBe("");
		expect(result.out).toContain("PlanForge legacy execution is blocked");
		expectNoLocalAuthorityOrTape(env.dir);
		expect(rootSnapshot(env.dir)).toEqual(before);
	});
});
