import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The old PlanForge activity, receipt, recovery, and crash tapes exercised an
// ambient local worker lane. That lane is intentionally retired: the CLI cannot
// mint its own signed authority or execute a PlanForge task outside a host-owned
// candidate session. Governed equivalents live in the broker-view, candidate
// promotion, and native workflow-reducer suites; this integration test protects
// the local fail-closed boundary itself.

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
): Promise<{ code: number; out: string; err: string }> {
	const runCli = await loadRunCli();
	const out: string[] = [];
	const err: string[] = [];
	try {
		const code = await runCli(argv, {
			cwd,
			stdout: (line) => out.push(line),
			stderr: (line) => err.push(line),
		});
		return { code, out: out.join("\n"), err: err.join("\n") };
	} catch (error) {
		return {
			code: 1,
			out: out.join("\n"),
			err: err.join("\n") || String(error),
		};
	}
}

describe("PlanForge legacy dispatch trust boundary", () => {
	const temporaryRoots: string[] = [];

	afterEach(() => {
		for (const root of temporaryRoots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("blocks every retired local execution form before it creates governed-looking state", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-planforge-dispatch-"));
		temporaryRoots.push(root);
		const input = join(root, "untrusted-plan.md");
		writeFileSync(input, "# Untrusted PlanForge source\n", "utf8");

		const invocations = [
			{
				label: "dispatch",
				argv: ["planforge", "dispatch", "--input", input, "--json"],
				expectedError: "PlanForge legacy execution is blocked",
			},
			{
				label: "resume",
				argv: ["planforge", "resume", "--input", input, "--json"],
				expectedError: "PlanForge legacy execution is blocked",
			},
			{
				label: "recover",
				argv: ["planforge", "recover", "--json"],
				expectedError: "PlanForge legacy execution is blocked",
			},
			{
				label: "loop",
				argv: ["planforge", "loop", "--once", "--json"],
				expectedError: "PlanForge legacy execution is blocked",
			},
			{
				label: "authorize-envelope",
				argv: ["planforge", "authorize-envelope", "--json"],
				expectedError: "GOVERNED_AUTHORITY_BROKER_REQUIRED",
			},
		] as const;

		for (const invocation of invocations) {
			const result = await runCliCapture([...invocation.argv], root);
			expect(result.code, invocation.label).toBe(1);
			expect(`${result.out}\n${result.err}`, invocation.label).toContain(
				invocation.expectedError,
			);
			expect(existsSync(join(root, ".buildplane")), invocation.label).toBe(
				false,
			);
		}
	});
});
