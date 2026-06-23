/**
 * M2-S7b phase 2: crash-replay integration built on S7-HARNESS boundary names.
 * Uses real `planforge resume` against durable tapes that model each harness kill point
 * (admit-only, one activity recorded, two activities recorded — no receipt).
 *
 * Harness `createPlanForgeCrashTape` tapes use synthetic plan ids; this file bridges via
 * goal-input admit + signed activity appends so resume verification matches production CLI.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { createTapeEmitter } from "@buildplane/ledger-client";
import { digest } from "@buildplane/planforge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	PLANFORGE_CRASH_BOUNDARIES,
	type PlanForgeCrashBoundary,
} from "./crash-harness.js";
import {
	LEDGER_TEST_REPO_ROOT,
	resolveNativeBinaryForLedgerTests,
} from "./fixtures.js";

const GOAL_INPUT = resolve(
	LEDGER_TEST_REPO_ROOT,
	"apps/cli/test/fixtures/planforge/goal-input.md",
);

interface Env {
	dir: string;
	home: string;
	binDir: string;
	eventsDbPath: string;
	cleanup: () => Promise<void>;
}

interface KindRow {
	kind: string;
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

async function runCliCapture(argv: string[], cwd: string) {
	const runCli = await loadRunCli();
	const out: string[] = [];
	const err: string[] = [];
	try {
		const code = await runCli(argv, {
			cwd,
			stdout: (l) => out.push(l),
			stderr: (l) => err.push(l),
		});
		return { code, threw: false, out: out.join("\n"), err: err.join("\n") };
	} catch (e) {
		return {
			code: 1,
			threw: true,
			out: out.join("\n"),
			err: err.join("\n") || String(e),
		};
	}
}

function runGit(cwd: string, args: string[]): void {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	}
}

async function makeEnv(): Promise<Env> {
	const dir = await mkdtemp(join(tmpdir(), "bp-crash-replay-ws-"));
	const home = await mkdtemp(join(tmpdir(), "bp-crash-replay-home-"));
	const binDir = await mkdtemp(join(tmpdir(), "bp-crash-replay-bin-"));
	const keyDir = join(home, ".buildplane", "keys", "kernel");
	mkdirSync(keyDir, { recursive: true });
	writeFileSync(join(keyDir, "kernel-main.ed25519"), Buffer.alloc(32, 7));
	runGit(dir, ["init", "-q"]);
	runGit(dir, ["config", "user.email", "test@test"]);
	runGit(dir, ["config", "user.name", "test"]);
	runGit(dir, ["commit", "-q", "--allow-empty", "-m", "init"]);
	return {
		dir,
		home,
		binDir,
		eventsDbPath: join(dir, ".buildplane", "ledger", "events.db"),
		cleanup: async () => {
			await rm(dir, { recursive: true, force: true });
			await rm(home, { recursive: true, force: true });
			await rm(binDir, { recursive: true, force: true });
		},
	};
}

/**
 * Install a `claude` shim on PATH. PlanForge resume executes the remaining
 * suffix via a real claude-code model worker (GAP-4); without a binary the
 * worker exits non-zero and resume fails. The shim emits a valid result and
 * exits 0 so the executed suffix succeeds.
 */
function installClaudeShim(binDir: string): void {
	const shim = join(binDir, "claude");
	writeFileSync(shim, '#!/bin/sh\necho \'{"result":"ok"}\'\nexit 0\n', "utf8");
	chmodSync(shim, 0o755);
}

/**
 * Install a `pnpm` shim on PATH. The acceptance gate is ON by default (GAP-3),
 * so resume invokes `pnpm` for worktree provisioning (`pnpm install
 * --frozen-lockfile`) AND the gate's `pnpm lint` check. The `install`
 * invocation is intercepted to exit 0; `body` is the shell body for the CHECK
 * invocation. A green shim (`exit 0`) lets the default-on gate pass so these
 * tests exercise crash-replay/resume, not the gate verdict.
 */
function installPnpmShim(binDir: string, body: string): void {
	const shim = join(binDir, "pnpm");
	writeFileSync(
		shim,
		`#!/bin/sh\nif [ "$1" = "install" ]; then exit 0; fi\n${body}\n`,
		"utf8",
	);
	chmodSync(shim, 0o755);
}

async function initProject(dir: string): Promise<void> {
	const res = await runCliCapture(["init"], dir);
	expect(res.code).toBe(0);
	runGit(dir, ["add", "-A"]);
	runGit(dir, ["commit", "-q", "-m", "buildplane: init"]);
}

async function admitGoal(
	env: Env,
): Promise<{ event_id: string; run_id: string }> {
	const admit = await runCliCapture(
		[
			"planforge",
			"admit",
			"--input",
			GOAL_INPUT,
			"--approve",
			"--operator",
			"op1",
			"--json",
		],
		env.dir,
	);
	expect(admit.code).toBe(0);
	return JSON.parse(admit.out) as { event_id: string; run_id: string };
}

function waitForExit(child: ChildProcess): Promise<number> {
	const exit = new Promise<number>((resolve, reject) => {
		child.on("exit", (code) => resolve(code ?? -1));
		child.on("error", (err) => reject(err));
	});
	exit.catch(() => {});
	return exit;
}

async function appendRecordedActivities(
	env: Env,
	runId: string,
	count: 1 | 2,
): Promise<void> {
	const child = spawn(
		resolveNativeBinaryForLedgerTests(),
		[
			"ledger",
			"serve",
			"--run-id",
			runId,
			"--workspace",
			env.dir,
			"--schema-version",
			"1",
			"--sign",
			"--signing-key-id",
			"kernel-main",
		],
		{
			stdio: ["pipe", "inherit", "pipe"],
			cwd: LEDGER_TEST_REPO_ROOT,
			env: { ...process.env, HOME: env.home },
		},
	);
	if (!child.stdin || !child.stderr) {
		throw new Error("ledger stdio missing");
	}
	const exit = waitForExit(child);
	const emitter = await createTapeEmitter({
		childStdin: child.stdin as Writable,
		childStderr: child.stderr as Readable,
		childExit: exit,
		workspacePath: env.dir,
		runId,
		handshakeTimeoutMs: 5_000,
	});
	const specs = [
		{
			activityId: "recorded-pf1",
			run_id: "01919000-0000-7000-8000-000000000801",
			result: { exitCode: 0, stdout: "", stderr: "" },
		},
		{
			activityId: "recorded-pf2",
			run_id: "01919000-0000-7000-8000-000000000802",
			result: { exitCode: 0, stdout: "suffix-only", stderr: "" },
		},
	] as const;
	try {
		for (let i = 0; i < count; i += 1) {
			const spec = specs[i];
			emitter.emit("activity_started", {
				ActivityStartedV1: {
					run_id: spec.run_id,
					activity_id: spec.activityId,
					activity_type: "command",
					input_digest: digest({ activity: spec.activityId }),
				},
			});
			await emitter.flush();
			emitter.emit("activity_completed", {
				ActivityCompletedV1: {
					run_id: spec.run_id,
					activity_id: spec.activityId,
					result_digest: digest(spec.result),
					result: spec.result,
				},
			});
			await emitter.flush();
		}
		await emitter.close();
	} catch (err) {
		if (child.exitCode === null) {
			child.kill("SIGTERM");
		}
		throw err;
	}
}

async function readEventKinds(eventsDbPath: string): Promise<string[]> {
	if (!existsSync(eventsDbPath)) {
		return [];
	}
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(eventsDbPath, { readOnly: true });
	try {
		const rows = db
			.prepare("SELECT kind FROM events ORDER BY id ASC")
			.all() as KindRow[];
		return rows.map((r) => r.kind);
	} finally {
		db.close();
	}
}

function recordedCountForBoundary(boundary: PlanForgeCrashBoundary): 0 | 1 | 2 {
	switch (boundary) {
		case "admit-before-execute":
			return 0;
		case "after-activity-completed":
			return 1;
		case "execute-before-receipt":
			return 2;
	}
}

describe("M2-S7b crash-replay — planforge resume at harness boundaries", () => {
	let env: Env;
	let originalHome: string | undefined;
	let originalNativeBin: string | undefined;
	let originalPath: string | undefined;

	beforeEach(async () => {
		env = await makeEnv();
		originalHome = process.env.HOME;
		originalNativeBin = process.env.BUILDPLANE_NATIVE_BIN;
		originalPath = process.env.PATH;
		process.env.HOME = env.home;
		process.env.BUILDPLANE_NATIVE_BIN = resolveNativeBinaryForLedgerTests();
		// Resume executes the remaining suffix via a real claude-code model worker
		// (GAP-4); shim it so the model packet succeeds (no `claude` binary exists
		// in the test sandbox). The acceptance gate is ON by default (GAP-3), so a
		// green `pnpm` shim lets provisioning + checks pass and these tests stay
		// focused on crash-replay/resume.
		process.env.PATH = `${env.binDir}:${originalPath ?? ""}`;
		installClaudeShim(env.binDir);
		installPnpmShim(env.binDir, "exit 0");
	});

	afterEach(async () => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalNativeBin === undefined)
			delete process.env.BUILDPLANE_NATIVE_BIN;
		else process.env.BUILDPLANE_NATIVE_BIN = originalNativeBin;
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		await env.cleanup();
	});

	it.each(
		PLANFORGE_CRASH_BOUNDARIES,
	)("resumes after %s without duplicate admission and finishes with one receipt", async (boundary) => {
		await initProject(env.dir);
		const admitted = await admitGoal(env);
		const recorded = recordedCountForBoundary(boundary);
		if (recorded > 0) {
			await appendRecordedActivities(env, admitted.run_id, recorded);
		}

		const kindsBefore = await readEventKinds(env.eventsDbPath);
		expect(kindsBefore.filter((k) => k === "plan_receipt")).toHaveLength(0);

		const resume = await runCliCapture(
			["planforge", "resume", "--input", GOAL_INPUT, "--json"],
			env.dir,
		);
		expect(resume.err).toBe("");
		expect(resume.code).toBe(0);
		const body = JSON.parse(resume.out) as {
			status: string;
			recorded_activity_count?: number;
			executed_activity_count?: number;
			runs: Array<{ source?: string }>;
		};
		expect(body.status).toBe("resumed");
		expect(body.recorded_activity_count).toBe(recorded);
		expect(body.executed_activity_count).toBe(2 - recorded);

		const kindsAfter = await readEventKinds(env.eventsDbPath);
		expect(kindsAfter.filter((k) => k === "plan_admitted")).toHaveLength(1);
		expect(kindsAfter.filter((k) => k === "activity_completed")).toHaveLength(
			2,
		);
		expect(kindsAfter.filter((k) => k === "plan_receipt")).toHaveLength(1);
		expect(body.runs.filter((r) => r.source === "recorded")).toHaveLength(
			recorded,
		);
	}, 45_000);
});
