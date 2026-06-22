/**
 * M2-S8 / M2-GATE vertical slice: toy fixture goal input, dry-run review chain,
 * operator admit → mid-cycle crash (one recorded activity) → explicit resume →
 * terminal receipt, then live export + external signed-tape verification.
 *
 * Recovery path: Gate C Path i (explicit `planforge resume`, not kernel startup-scan).
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
	LEDGER_TEST_REPO_ROOT,
	resolveNativeBinaryForLedgerTests,
} from "../ledger-integration/fixtures.ts";

const GOAL_INPUT = resolve(
	LEDGER_TEST_REPO_ROOT,
	"apps/cli/test/fixtures/planforge/goal-input.md",
);
const VERIFIER = resolve(
	LEDGER_TEST_REPO_ROOT,
	"scripts/verify-signed-tape.mjs",
);

interface SliceEnv {
	dir: string;
	home: string;
	binDir: string;
	eventsDbPath: string;
	cleanup: () => Promise<void>;
}

function installClaudeShim(binDir: string): void {
	const shim = join(binDir, "claude");
	writeFileSync(shim, '#!/bin/sh\necho \'{"result":"ok"}\'\nexit 0\n', "utf8");
	chmodSync(shim, 0o755);
}

/**
 * Install a `pnpm` shim on PATH. Dispatch/resume spawns a real claude-code model
 * worker (GAP-4) and the acceptance gate is ON by default (GAP-3), so `pnpm` is
 * invoked for worktree provisioning (`pnpm install --frozen-lockfile`) AND the
 * gate's `pnpm lint` check. The `install` invocation is intercepted to exit 0;
 * `body` is the shell body for the CHECK invocation. A green shim (`exit 0`) lets
 * the default-on gate pass so this slice exercises the resume behavior.
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

async function makeSliceEnv(): Promise<SliceEnv> {
	const dir = await mkdtemp(join(tmpdir(), "bp-m2-slice-ws-"));
	const home = await mkdtemp(join(tmpdir(), "bp-m2-slice-home-"));
	const binDir = await mkdtemp(join(tmpdir(), "bp-m2-slice-bin-"));
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

async function initProject(dir: string): Promise<void> {
	const res = await runCliCapture(["init"], dir);
	expect(res.code).toBe(0);
	runGit(dir, ["add", "-A"]);
	runGit(dir, ["commit", "-q", "-m", "buildplane: init"]);
}

function waitForExit(child: ChildProcess): Promise<number> {
	const exit = new Promise<number>((resolveExit, reject) => {
		child.on("exit", (code) => resolveExit(code ?? -1));
		child.on("error", (err) => reject(err));
	});
	exit.catch(() => {});
	return exit;
}

async function appendOneRecordedActivity(
	env: SliceEnv,
	runId: string,
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
	const activityId = "recorded-pf1";
	const taskRunId = "01919000-0000-7000-8000-000000000801";
	const result = { exitCode: 0, stdout: "", stderr: "" };
	try {
		emitter.emit("activity_started", {
			ActivityStartedV1: {
				run_id: taskRunId,
				activity_id: activityId,
				activity_type: "command",
				input_digest: digest({ activity: activityId }),
			},
		});
		await emitter.flush();
		emitter.emit("activity_completed", {
			ActivityCompletedV1: {
				run_id: taskRunId,
				activity_id: activityId,
				result_digest: digest(result),
				result,
			},
		});
		await emitter.flush();
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
			.all() as Array<{ kind: string }>;
		return rows.map((r) => r.kind);
	} finally {
		db.close();
	}
}

async function distinctRunId(eventsDbPath: string): Promise<string> {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(eventsDbPath, { readOnly: true });
	try {
		const rows = db
			.prepare("SELECT DISTINCT run_id FROM events")
			.all() as Array<{ run_id: string }>;
		expect(rows).toHaveLength(1);
		return rows[0].run_id;
	} finally {
		db.close();
	}
}

describe("M2-GATE — PlanForge vertical slice with recovered mid-cycle crash", () => {
	let env: SliceEnv;
	let originalHome: string | undefined;
	let originalNativeBin: string | undefined;
	let originalPath: string | undefined;

	beforeEach(async () => {
		env = await makeSliceEnv();
		originalHome = process.env.HOME;
		originalNativeBin = process.env.BUILDPLANE_NATIVE_BIN;
		originalPath = process.env.PATH;
		process.env.HOME = env.home;
		process.env.BUILDPLANE_NATIVE_BIN = resolveNativeBinaryForLedgerTests();
		// Dispatch/resume spawns a real claude-code model worker (GAP-4); shim it so
		// the model packet succeeds (no `claude` binary exists in the test sandbox).
		// The acceptance gate is ON by default (GAP-3), so a green `pnpm` shim lets
		// provisioning + checks pass and this slice exercises the resume path.
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

	it("compile→validate→preview (dry-run), admit, crash after one activity, resume, receipt, export verifies", async () => {
		await initProject(env.dir);

		const dryRun = await runCliCapture(
			["planforge", "dry-run", "--input", GOAL_INPUT, "--json"],
			env.dir,
		);
		expect(dryRun.err).toBe("");
		expect(dryRun.code).toBe(0);
		const plan = JSON.parse(dryRun.out) as {
			validation: { status: string };
			receiptPreview: { dryRun: boolean; sideEffects: unknown[] };
		};
		expect(plan.validation.status).toBe("PASS");
		expect(plan.receiptPreview.dryRun).toBe(true);
		expect(plan.receiptPreview.sideEffects).toEqual([]);

		const admit = await runCliCapture(
			[
				"planforge",
				"admit",
				"--input",
				GOAL_INPUT,
				"--approve",
				"--operator",
				"m2-gate-slice",
				"--json",
			],
			env.dir,
		);
		expect(admit.code).toBe(0);
		const admitted = JSON.parse(admit.out) as {
			event_id: string;
			run_id: string;
		};

		await appendOneRecordedActivity(env, admitted.run_id);

		const kindsMid = await readEventKinds(env.eventsDbPath);
		expect(kindsMid.filter((k) => k === "plan_receipt")).toHaveLength(0);
		expect(kindsMid.filter((k) => k === "activity_completed")).toHaveLength(1);

		const resume = await runCliCapture(
			["planforge", "resume", "--input", GOAL_INPUT, "--json"],
			env.dir,
		);
		expect(resume.err).toBe("");
		expect(resume.code).toBe(0);
		const resumed = JSON.parse(resume.out) as {
			status: string;
			recorded_activity_count?: number;
			executed_activity_count?: number;
		};
		expect(resumed.status).toBe("resumed");
		expect(resumed.recorded_activity_count).toBe(1);
		expect(resumed.executed_activity_count).toBe(1);

		const kindsFinal = await readEventKinds(env.eventsDbPath);
		expect(kindsFinal.filter((k) => k === "plan_admitted")).toHaveLength(1);
		expect(kindsFinal.filter((k) => k === "activity_completed")).toHaveLength(
			2,
		);
		expect(kindsFinal.filter((k) => k === "plan_receipt")).toHaveLength(1);

		const runId = await distinctRunId(env.eventsDbPath);
		const outDir = join(env.dir, "exported-tape");
		const exportRes = await runCliCapture(
			[
				"ledger",
				"export-signed-tape",
				"--run-id",
				runId,
				"--workspace",
				env.dir,
				"--out",
				outDir,
			],
			env.dir,
		);
		expect(exportRes.err).toBe("");
		expect(exportRes.code).toBe(0);

		const verify = spawnSync(
			"node",
			[VERIFIER, "--fixture", outDir, "--json"],
			{ encoding: "utf8" },
		);
		expect(verify.status, verify.stderr).toBe(0);
		const report = JSON.parse(verify.stdout) as {
			ok: boolean;
			events: Array<{ kind: string; status: string }>;
		};
		expect(report.ok).toBe(true);
		for (const kind of [
			"plan_admitted",
			"activity_started",
			"activity_completed",
			"plan_receipt",
		]) {
			const matched = report.events.filter((e) => e.kind === kind);
			expect(
				matched.length,
				`expected ${kind} on exported tape`,
			).toBeGreaterThan(0);
			for (const e of matched) {
				expect(e.status, `${kind} should verify`).toBe("verified");
			}
		}
	}, 60_000);
});
