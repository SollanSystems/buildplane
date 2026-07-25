import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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

	it("blocks --input dispatch before it creates governed-looking state", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-planforge-dispatch-"));
		temporaryRoots.push(root);
		const input = join(root, "untrusted-plan.md");
		writeFileSync(input, "# Untrusted PlanForge source\n", "utf8");

		const result = await runCliCapture(
			["planforge", "dispatch", "--input", input, "--json"],
			root,
		);

		expect(result.code).toBe(1);
		expect(`${result.out}\n${result.err}`).toContain(
			"PlanForge legacy execution is blocked",
		);
		expect(existsSync(join(root, ".buildplane"))).toBe(false);
	});
});
