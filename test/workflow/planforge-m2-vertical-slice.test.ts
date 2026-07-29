/**
 * PlanForge admission is now a broker-owned governed boundary.  The retired
 * local admit/dispatch/resume slice must never be revived as a fallback: when
 * no privileged host broker is available, the CLI stops before reading the
 * untrusted plan source or creating local project state.
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

async function runCliCapture(argv: string[], cwd: string) {
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

describe("M2-GATE — PlanForge broker-owned admission", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "bp-planforge-m2-gate-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("fails closed before reading source or mutating the root when the broker is unavailable", async () => {
		const missingPlan = join(root, "untrusted-plan-does-not-exist.md");
		const before = readdirSync(root).sort();

		const result = await runCliCapture(
			["planforge", "admit", "--input", missingPlan, "--approve", "--json"],
			root,
		);

		expect(result).toMatchObject({ code: 1, threw: false, err: "" });
		expect(JSON.parse(result.out)).toMatchObject({
			error: {
				message: expect.stringContaining(
					"PlanForge governed broker is unavailable",
				),
			},
		});
		expect(existsSync(missingPlan)).toBe(false);
		expect(existsSync(join(root, ".buildplane"))).toBe(false);
		expect(readdirSync(root).sort()).toEqual(before);
	});
});
