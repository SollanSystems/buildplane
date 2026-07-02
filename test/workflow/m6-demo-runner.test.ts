import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const runnerPath = join(repoRoot, "scripts", "run-demo.mjs");

function runDryRun(): { stdout: string; status: number } {
	try {
		const stdout = execFileSync("node", [runnerPath, "--dry-run"], {
			cwd: repoRoot,
			encoding: "utf8",
		});
		return { stdout, status: 0 };
	} catch (err) {
		const e = err as { status?: number; stdout?: string; stderr?: string };
		return {
			stdout: `${e.stdout ?? ""}${e.stderr ?? ""}`,
			status: e.status ?? 1,
		};
	}
}

describe("M6 demo runner (scripts/run-demo.mjs --dry-run)", () => {
	it("ships the runner script", () => {
		expect(existsSync(runnerPath), "scripts/run-demo.mjs must exist").toBe(
			true,
		);
	});

	it("exits 0 in --dry-run mode", () => {
		const { status } = runDryRun();
		expect(status).toBe(0);
	});

	it("enumerates all ten operator steps", () => {
		const { stdout } = runDryRun();
		for (let n = 1; n <= 10; n++) {
			expect(stdout, `expected the flow to enumerate "Step ${n}"`).toContain(
				`Step ${n}`,
			);
		}
	});

	it("enumerates the three demonstrated properties", () => {
		const { stdout } = runDryRun();
		for (let n = 1; n <= 3; n++) {
			expect(stdout, `expected "Property ${n}" in the flow`).toContain(
				`Property ${n}`,
			);
		}
	});

	it("narrates INSUFFICIENT_EVIDENCE as expected for the bare goal", () => {
		const { stdout } = runDryRun();
		expect(stdout).toContain("INSUFFICIENT_EVIDENCE");
		expect(stdout.toLowerCase()).toContain("expected");
	});

	it("narrates the two-input handoff from the bare goal string to goal.md", () => {
		const { stdout } = runDryRun();
		expect(stdout).toContain("bp goal");
		expect(stdout).toContain("goal.md");
	});

	it("ends with the signed-tape verifier (Property 3)", () => {
		const { stdout } = runDryRun();
		expect(stdout).toContain("scripts/verify-signed-tape.mjs");
	});

	it("stages nothing and spawns no process in --dry-run", () => {
		const { stdout } = runDryRun();
		expect(stdout.toLowerCase()).toContain("no processes were spawned");
	});
});
