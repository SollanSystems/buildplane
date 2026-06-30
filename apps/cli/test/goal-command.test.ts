import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/run-cli.ts";

const DEMO_GOAL =
	"Add rate limiting to POST /api/login: max 5/min per IP, 429 + Retry-After";

function git(cwd: string, ...args: string[]): string {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) {
		throw new Error(r.stderr);
	}
	return r.stdout.trim();
}

function initRepo(cwd: string): string {
	git(cwd, "init", "-q");
	git(cwd, "config", "user.email", "test@test");
	git(cwd, "config", "user.name", "test");
	git(cwd, "remote", "add", "origin", "https://example.com/acme/widget.git");
	writeFileSync(join(cwd, "init.txt"), "init");
	git(cwd, "add", ".");
	git(cwd, "commit", "-q", "-m", "init");
	return git(cwd, "rev-parse", "HEAD");
}

async function runGoal(cwd: string, args: string[]) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const exitCode = await runCli(["goal", ...args], {
		cwd,
		stdout: (line) => stdout.push(line),
		stderr: (line) => stderr.push(line),
	});
	return { exitCode, stdout, stderr };
}

describe("bp goal", () => {
	let dir: string;
	let headSha: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bp-goal-"));
		headSha = initRepo(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("compiles + previews a raw goal into plan JSON with planDigest, trustedBase, riskClass", async () => {
		const { exitCode, stdout } = await runGoal(dir, [DEMO_GOAL]);
		expect(exitCode).toBe(0);

		const json = JSON.parse(stdout.join("\n")) as {
			goal: string;
			trustedBase: string;
			planDigest: string;
			riskClass: string;
			status: string;
			missingEvidence: string[];
			remote: string;
		};

		expect(json.goal).toBe(DEMO_GOAL);
		expect(json.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(json.trustedBase).toBe(headSha);
		// A bare goal is INSUFFICIENT_EVIDENCE, which the riskClass rubric pins to
		// medium — assert the exact class so a silent drop is caught.
		expect(json.riskClass).toBe("medium");
		expect(json.remote).toBe("https://example.com/acme/widget.git");
	});

	it("does not trip the forbidden-goal-intent guard for the benign demo goal", async () => {
		const { stdout } = await runGoal(dir, [DEMO_GOAL]);
		const json = JSON.parse(stdout.join("\n")) as {
			status: string;
			plan: { validation: { unsafeReasons: string[] } };
		};
		// The narrowed hasForbiddenPlanForgeGoalIntent guard would surface a
		// "goal requests a forbidden side effect" unsafeReason and force an
		// UNSAFE_TO_RUN status; the benign demo goal must do neither.
		expect(json.plan.validation.unsafeReasons).not.toContain(
			"goal requests a forbidden side effect",
		);
		expect(json.status).not.toBe("UNSAFE_TO_RUN");
	});

	it("yields INSUFFICIENT_EVIDENCE for a bare goal (empty tasks) but still displays the plan", async () => {
		const { exitCode, stdout } = await runGoal(dir, [DEMO_GOAL]);
		const json = JSON.parse(stdout.join("\n")) as {
			status: string;
			missingEvidence: string[];
		};
		expect(exitCode).toBe(0);
		expect(json.status).toBe("INSUFFICIENT_EVIDENCE");
		expect(json.missingEvidence).toContain("tasks");
	});

	it("honors a --trusted-base override", async () => {
		const override = "0".repeat(40);
		const { stdout } = await runGoal(dir, [
			DEMO_GOAL,
			"--trusted-base",
			override,
		]);
		const json = JSON.parse(stdout.join("\n")) as { trustedBase: string };
		expect(json.trustedBase).toBe(override);
	});

	it("warns on a dirty worktree when no --trusted-base is given", async () => {
		writeFileSync(join(dir, "dirty.txt"), "uncommitted");
		const { exitCode, stdout, stderr } = await runGoal(dir, [DEMO_GOAL]);
		expect(exitCode).toBe(0);
		expect(stderr.join("\n")).toMatch(/dirty|uncommitted|--trusted-base/i);
		// Still emits a usable plan against HEAD.
		const json = JSON.parse(stdout.join("\n")) as { trustedBase: string };
		expect(json.trustedBase).toBe(headSha);
	});

	it("requires a goal argument", async () => {
		const { exitCode, stderr } = await runGoal(dir, []);
		expect(exitCode).toBe(1);
		expect(stderr.join("\n")).toMatch(/goal/i);
	});

	it("flags repository_remote missing and reports no remote when origin is absent", async () => {
		const noRemote = mkdtempSync(join(tmpdir(), "bp-goal-noremote-"));
		try {
			git(noRemote, "init", "-q");
			git(noRemote, "config", "user.email", "test@test");
			git(noRemote, "config", "user.name", "test");
			writeFileSync(join(noRemote, "init.txt"), "init");
			git(noRemote, "add", ".");
			git(noRemote, "commit", "-q", "-m", "init");
			const { exitCode, stdout } = await runGoal(noRemote, [DEMO_GOAL]);
			expect(exitCode).toBe(0);
			const json = JSON.parse(stdout.join("\n")) as {
				remote?: string;
				missingEvidence: string[];
			};
			// No origin → the JSON `remote` and missingEvidence agree: both say absent.
			expect(json.missingEvidence).toContain("repository_remote");
			expect(json.remote ?? null).toBeNull();
		} finally {
			rmSync(noRemote, { recursive: true, force: true });
		}
	});
});
