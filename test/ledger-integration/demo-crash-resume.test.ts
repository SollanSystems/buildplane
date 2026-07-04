import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	LEDGER_TEST_REPO_ROOT,
	resolveNativeBinaryForLedgerTests,
} from "./fixtures.ts";

// M6-S11 — demo Property 1 (crash-and-resume) over REAL machinery.
//
// A dispatch subprocess is crashed deterministically (BUILDPLANE_CRASH_AFTER_ACTIVITY=1)
// the instant the first `activity_completed` is durable+signed on the tape — before
// any terminal `plan_receipt`. A subsequent `planforge recover` replays the signed
// tape, REUSES the recorded activity result (no model re-invocation), executes only
// the remaining suffix, and emits the missing `plan_receipt`, leaving EXACTLY ONE on
// the tape. The recovered PlanForge lifecycle is structurally identical to a clean,
// never-crashed run.
//
// Harness mirrors planforge-recover.test.ts / planforge-receipt.test.ts: temp HOME +
// kernel ed25519 seed, claude/pnpm shims on PATH, explicit cwd, no process.chdir.

const GOAL_INPUT = resolve(
	LEDGER_TEST_REPO_ROOT,
	"apps/cli/test/fixtures/planforge/goal-input.md",
);
const CLI_ENTRY = resolve(LEDGER_TEST_REPO_ROOT, "apps/cli/src/index.ts");
const TSX_BIN = resolve(LEDGER_TEST_REPO_ROOT, "node_modules", ".bin", "tsx");

interface CrashEnv {
	dir: string;
	home: string;
	binDir: string;
	counterFile: string;
	eventsDbPath: string;
	cleanup: () => Promise<void>;
}

interface EventRow {
	id: string;
	kind: string;
	payload: string;
}

function runGit(cwd: string, args: string[]): void {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	}
}

async function loadRunCli() {
	const mod = (await import("../../apps/cli/src/run-cli.ts")) as {
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

async function makeCrashEnv(): Promise<CrashEnv> {
	const dir = await mkdtemp(join(tmpdir(), "bp-crash-ws-"));
	const home = await mkdtemp(join(tmpdir(), "bp-crash-home-"));
	const binDir = await mkdtemp(join(tmpdir(), "bp-crash-bin-"));
	const keyDir = join(home, ".buildplane", "keys", "kernel");
	mkdirSync(keyDir, { recursive: true });
	writeFileSync(join(keyDir, "kernel-main.ed25519"), Buffer.alloc(32, 7));

	runGit(dir, ["init", "-q"]);
	runGit(dir, ["config", "user.email", "test@test"]);
	runGit(dir, ["config", "user.name", "test"]);
	runGit(dir, ["commit", "-q", "--allow-empty", "-m", "init"]);

	// counterFile lives under HOME (a non-git temp dir) so the model-shim's tally
	// never dirties the workspace's clean-tree requirement.
	const counterFile = join(home, "claude-calls.log");

	return {
		dir,
		home,
		binDir,
		counterFile,
		eventsDbPath: join(dir, ".buildplane", "ledger", "events.db"),
		cleanup: async () => {
			await rm(dir, { recursive: true, force: true });
			await rm(home, { recursive: true, force: true });
			await rm(binDir, { recursive: true, force: true });
		},
	};
}

/** Install a `claude` model shim that tallies each invocation (one byte per call)
 * so the test can assert a recovered run REUSES the recorded activity rather than
 * re-invoking the model. */
function installClaudeShim(binDir: string, counterFile: string): void {
	const shim = join(binDir, "claude");
	writeFileSync(
		shim,
		`#!/bin/sh\nprintf 'x' >> "${counterFile}"\necho '{"result":"ok"}'\nexit 0\n`,
		"utf8",
	);
	chmodSync(shim, 0o755);
}

function installPnpmShim(binDir: string): void {
	const shim = join(binDir, "pnpm");
	writeFileSync(shim, "#!/bin/sh\nexit 0\n", "utf8");
	chmodSync(shim, 0o755);
}

function claudeCalls(env: CrashEnv): number {
	if (!existsSync(env.counterFile)) {
		return 0;
	}
	return readFileSync(env.counterFile, "utf8").length;
}

function bindProcessEnv(env: CrashEnv): void {
	process.env.HOME = env.home;
	process.env.BUILDPLANE_NATIVE_BIN = resolveNativeBinaryForLedgerTests();
	process.env.PATH = `${env.binDir}:${ORIGINAL_PATH ?? ""}`;
}

async function initBuildplaneProject(dir: string): Promise<void> {
	const res = await runCliCapture(["init"], dir);
	expect(res.code).toBe(0);
	runGit(dir, ["add", "-A"]);
	runGit(dir, ["commit", "-q", "-m", "buildplane: init"]);
}

async function admitPlan(dir: string): Promise<void> {
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
		dir,
	);
	expect(admit.code).toBe(0);
}

async function readEvents(eventsDbPath: string): Promise<EventRow[]> {
	if (!existsSync(eventsDbPath)) {
		return [];
	}
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(eventsDbPath, { readOnly: true });
	try {
		return db
			.prepare("SELECT id, kind, payload FROM events ORDER BY id ASC")
			.all() as unknown as EventRow[];
	} finally {
		db.close();
	}
}

function receiptOutcomes(rows: EventRow[]): string[] {
	return rows
		.filter((r) => r.kind === "plan_receipt")
		.map(
			(r) =>
				(JSON.parse(r.payload).PlanReceiptRecordedV1 as { outcome: string })
					.outcome,
		);
}

/** Spawn the real CLI as a separate process so a hard `process.exit` crash does not
 * kill the vitest runner. Runs from a foreign cwd via the repo-local tsx loader +
 * the `source` condition so `@buildplane/*` resolve to TS. */
function spawnDispatch(env: CrashEnv, crash: boolean): Promise<number> {
	const child: ChildProcess = spawn(
		TSX_BIN,
		[
			CLI_ENTRY,
			"planforge",
			"dispatch",
			"--input",
			GOAL_INPUT,
			"--no-enforce-acceptance",
			"--json",
		],
		{
			cwd: env.dir,
			stdio: ["ignore", "ignore", "ignore"],
			env: {
				...process.env,
				NODE_OPTIONS:
					`${process.env.NODE_OPTIONS ?? ""} --conditions=source`.trim(),
				HOME: env.home,
				PATH: `${env.binDir}:${ORIGINAL_PATH ?? ""}`,
				BUILDPLANE_NATIVE_BIN: resolveNativeBinaryForLedgerTests(),
				...(crash ? { BUILDPLANE_CRASH_AFTER_ACTIVITY: "1" } : {}),
			},
		},
	);
	return new Promise<number>((resolveExit, reject) => {
		child.on("exit", (code, signal) => resolveExit(code ?? (signal ? 1 : -1)));
		child.on("error", reject);
	});
}

let ORIGINAL_PATH: string | undefined;

describe("demo crash-and-resume — Property 1", () => {
	let originalHome: string | undefined;
	let originalNativeBin: string | undefined;
	const envs: CrashEnv[] = [];

	beforeEach(() => {
		originalHome = process.env.HOME;
		originalNativeBin = process.env.BUILDPLANE_NATIVE_BIN;
		ORIGINAL_PATH = process.env.PATH;
	});

	afterEach(async () => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		if (originalNativeBin === undefined) {
			delete process.env.BUILDPLANE_NATIVE_BIN;
		} else {
			process.env.BUILDPLANE_NATIVE_BIN = originalNativeBin;
		}
		if (ORIGINAL_PATH === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = ORIGINAL_PATH;
		}
		for (const env of envs.splice(0)) {
			await env.cleanup();
		}
	});

	it("crash right after activity_completed → recover fail-closes the unverified recorded prefix (acceptance never evaluated), emitting exactly one failed plan_receipt without re-invoking the model", async () => {
		// ── Clean baseline run (never crashes) ──────────────────────────────
		const clean = await makeCrashEnv();
		envs.push(clean);
		bindProcessEnv(clean);
		installClaudeShim(clean.binDir, clean.counterFile);
		installPnpmShim(clean.binDir);
		await initBuildplaneProject(clean.dir);
		await admitPlan(clean.dir);

		const cleanExit = await spawnDispatch(clean, false);
		expect(cleanExit).toBe(0);
		const cleanRows = await readEvents(clean.eventsDbPath);
		expect(receiptOutcomes(cleanRows)).toEqual(["completed"]);
		// Both PlanForge tasks (PF1, PF2) invoked the model exactly once.
		expect(claudeCalls(clean)).toBe(2);

		// ── Crash run ───────────────────────────────────────────────────────
		const crashed = await makeCrashEnv();
		envs.push(crashed);
		bindProcessEnv(crashed);
		installClaudeShim(crashed.binDir, crashed.counterFile);
		installPnpmShim(crashed.binDir);
		await initBuildplaneProject(crashed.dir);
		await admitPlan(crashed.dir);

		const crashExit = await spawnDispatch(crashed, true);
		// Hard abort: the guard calls process.exit(137) right after the first
		// activity_completed is durable+signed, so exactly one activity is recorded
		// and NO terminal receipt exists.
		expect(crashExit).toBe(137);
		const afterCrash = await readEvents(crashed.eventsDbPath);
		expect(
			afterCrash.filter((r) => r.kind === "activity_completed").length,
		).toBe(1);
		expect(afterCrash.filter((r) => r.kind === "plan_receipt")).toHaveLength(0);
		// Only the first task's model ran before the crash.
		expect(claudeCalls(crashed)).toBe(1);

		// ── Recover (M6-F1: fail-closed) ───────────────────────────────────
		// The crash landed BEFORE the acceptance gate, so the recorded PF1 carries no
		// signed `acceptance_recorded` verdict. `recover` enforces acceptance by
		// default, so the unverified recorded prefix fail-closes rather than being
		// minted `completed` — the honest semantics this slice restores.
		bindProcessEnv(crashed);
		const recover = await runCliCapture(
			["planforge", "recover", "--json"],
			crashed.dir,
		);
		expect(recover.err).toBe("");
		expect(recover.code).toBe(1);
		const recoverResult = JSON.parse(recover.out) as {
			status: string;
			recovered: Array<{ status: string }>;
		};
		expect(recoverResult.status).toBe("failed");
		expect(recoverResult.recovered).toHaveLength(1);
		expect(recoverResult.recovered[0].status).toBe("failed");

		const afterRecover = await readEvents(crashed.eventsDbPath);
		// Still exactly one terminal plan_receipt — outcome `failed`, not `completed`.
		expect(afterRecover.filter((r) => r.kind === "plan_receipt")).toHaveLength(
			1,
		);
		expect(receiptOutcomes(afterRecover)).toEqual(["failed"]);
		// The recorded activity was REUSED for the verdict (never re-invoked) and the
		// suffix never ran, so the model call count stays at 1 (the pre-crash PF1).
		expect(claudeCalls(crashed)).toBe(1);
	}, 120_000);
});
