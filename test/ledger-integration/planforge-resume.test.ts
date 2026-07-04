import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { createTapeEmitter } from "@buildplane/ledger-client";
import {
	acceptanceContractDigest,
	createPlanForgeDryRunPlan,
	deriveAcceptanceContract,
	digest,
} from "@buildplane/planforge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	LEDGER_TEST_REPO_ROOT,
	resolveNativeBinaryForLedgerTests,
} from "./fixtures.ts";

// S7b explicit-input resume regression coverage. These tests exercise the real
// signed ledger subprocess and real CLI path: resume reconstructs the plan from
// --input, verifies the signed plan_admitted payload/signature, skips durable
// recorded activities, executes only the suffix, and emits the missing terminal
// plan_receipt.

const GOAL_INPUT = resolve(
	LEDGER_TEST_REPO_ROOT,
	"apps/cli/test/fixtures/planforge/goal-input.md",
);
const RECORDED_TASK_RUN_ID = "01919000-0000-7000-8000-000000000801";
const RECORDED_ACTIVITY_ID = "recorded-pf1";
const RECORDED_ACTIVITY_RESULT = { exitCode: 0, stdout: "", stderr: "" };

interface ResumeEnv {
	dir: string;
	home: string;
	binDir: string;
	eventsDbPath: string;
	cleanup: () => Promise<void>;
}

interface EventRow {
	id: string;
	kind: string;
	payload: string;
}

interface PlanForgeJson {
	status: string;
	plan_id: string;
	admitted_event_id: string;
	runs: Array<{
		task: string;
		run_id: string;
		status: string;
		source?: "recorded" | "executed";
		activity_id?: string;
		completed_event_id?: string;
		reason?: string;
	}>;
	recorded_activity_count?: number;
	executed_activity_count?: number;
	receipt_event_id?: string;
	receipt_outcome?: string;
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

function runGit(cwd: string, args: string[]): void {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	}
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

async function makeResumeEnv(): Promise<ResumeEnv> {
	const dir = await mkdtemp(join(tmpdir(), "bp-resume-ws-"));
	const home = await mkdtemp(join(tmpdir(), "bp-resume-home-"));
	const binDir = await mkdtemp(join(tmpdir(), "bp-resume-bin-"));
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
 * Install a `claude` shim on PATH. PlanForge dispatch/resume executes the
 * remaining suffix via a real claude-code model worker; without a binary the
 * worker exits non-zero and the run fails. The shim emits a valid result and
 * exits 0 so the executed suffix succeeds.
 */
function installClaudeShim(binDir: string): void {
	const shim = join(binDir, "claude");
	writeFileSync(shim, '#!/bin/sh\necho \'{"result":"ok"}\'\nexit 0\n', "utf8");
	chmodSync(shim, 0o755);
}

/**
 * Install a `pnpm` shim on PATH. The acceptance gate is ON by default (GAP-3), so
 * `pnpm` is invoked for worktree provisioning (`pnpm install --frozen-lockfile`)
 * AND the gate's `pnpm lint` check. The `install` invocation is intercepted to
 * exit 0; `body` is the shell body for the CHECK invocation. A green shim
 * (`exit 0`) lets the default-on gate pass so these tests exercise the resume
 * behavior, not the gate verdict.
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

async function initBuildplaneProject(dir: string): Promise<void> {
	const res = await runCliCapture(["init"], dir);
	expect(res.code).toBe(0);
	runGit(dir, ["add", "-A"]);
	runGit(dir, ["commit", "-q", "-m", "buildplane: init"]);
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

/**
 * The re-derived acceptance contract digest for the first PlanForge task (PF1),
 * computed exactly as dispatch/resume do (`deriveAcceptanceContract` +
 * `acceptanceContractDigest`). A seeded `acceptance_recorded` must carry this digest
 * for the M6-F1 fail-closed resume to count the recorded PF1 activity as `passed`.
 */
function pf1AcceptanceContractDigest(): string {
	const plan = createPlanForgeDryRunPlan(GOAL_INPUT);
	return acceptanceContractDigest(
		deriveAcceptanceContract(plan, plan.tasks[0]),
	);
}

/**
 * Append a durable, signed recorded PF1 activity to the tape — a crash prefix.
 * When `acceptance` is provided, ALSO append the matching signed
 * `acceptance_recorded` verdict (plan_id + admission_event_id + the re-derived PF1
 * contract digest + outcome), so the M6-F1 fail-closed resume treats the recorded
 * PF1 as accepted. Omit it to reproduce the crash-before-acceptance case.
 */
async function appendRecordedCompletedActivity(input: {
	dir: string;
	home: string;
	runId: string;
	acceptance?: { admittedEventId: string };
}): Promise<void> {
	const child = spawn(
		resolveNativeBinaryForLedgerTests(),
		[
			"ledger",
			"serve",
			"--run-id",
			input.runId,
			"--workspace",
			input.dir,
			"--schema-version",
			"1",
			"--sign",
			"--signing-key-id",
			"kernel-main",
		],
		{
			stdio: ["pipe", "inherit", "pipe"],
			cwd: LEDGER_TEST_REPO_ROOT,
			env: { ...process.env, HOME: input.home },
		},
	);
	if (!child.stdin || !child.stderr) {
		throw new Error("signed ledger subprocess stdio unexpectedly missing");
	}
	const exit = waitForExit(child);
	const emitter = await createTapeEmitter({
		childStdin: child.stdin as Writable,
		childStderr: child.stderr as Readable,
		childExit: exit,
		workspacePath: input.dir,
		runId: input.runId,
		handshakeTimeoutMs: 5_000,
	});
	try {
		emitter.emit("activity_started", {
			ActivityStartedV1: {
				run_id: RECORDED_TASK_RUN_ID,
				activity_id: RECORDED_ACTIVITY_ID,
				activity_type: "command",
				input_digest: digest({
					activity: RECORDED_ACTIVITY_ID,
					input: "resume-fixture",
				}),
			},
		});
		await emitter.flush();
		emitter.emit("activity_completed", {
			ActivityCompletedV1: {
				run_id: RECORDED_TASK_RUN_ID,
				activity_id: RECORDED_ACTIVITY_ID,
				result_digest: digest(RECORDED_ACTIVITY_RESULT),
				result: RECORDED_ACTIVITY_RESULT,
			},
		});
		await emitter.flush();
		if (input.acceptance) {
			emitter.emit("acceptance_recorded", {
				AcceptanceRecordedV1: {
					plan_id: createPlanForgeDryRunPlan(GOAL_INPUT).id,
					admission_event_id: input.acceptance.admittedEventId,
					contract_digest: pf1AcceptanceContractDigest(),
					outcome: "passed",
					diff_scope_status: "passed",
					out_of_scope_files: [],
					checks: [],
					evaluated_at: new Date().toISOString(),
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

function waitForExit(child: ChildProcess): Promise<number> {
	const exit = new Promise<number>((resolve, reject) => {
		child.on("exit", (code) => resolve(code ?? -1));
		child.on("error", (err) => reject(err));
	});
	exit.catch(() => {});
	return exit;
}

describe("planforge resume — explicit-input replay-skip recovery", () => {
	let env: ResumeEnv;
	let originalHome: string | undefined;
	let originalNativeBin: string | undefined;
	let originalPath: string | undefined;

	beforeEach(async () => {
		env = await makeResumeEnv();
		originalHome = process.env.HOME;
		originalNativeBin = process.env.BUILDPLANE_NATIVE_BIN;
		originalPath = process.env.PATH;
		process.env.HOME = env.home;
		process.env.BUILDPLANE_NATIVE_BIN = resolveNativeBinaryForLedgerTests();
		// Dispatch/resume spawns a real claude-code model worker; shim it so the
		// model packet succeeds (no `claude` binary exists in the test sandbox).
		// The acceptance gate is ON by default (GAP-3), so a green `pnpm` shim lets
		// provisioning + checks pass and these tests stay focused on resume.
		process.env.PATH = `${env.binDir}:${originalPath ?? ""}`;
		installClaudeShim(env.binDir);
		installPnpmShim(env.binDir, "exit 0");
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
		if (originalPath === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = originalPath;
		}
		await env.cleanup();
	});

	it("skips durable completed activities, executes only the remaining suffix, then emits the missing receipt", async () => {
		await initBuildplaneProject(env.dir);

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
		const admitted = JSON.parse(admit.out) as {
			event_id: string;
			run_id: string;
		};

		await appendRecordedCompletedActivity({
			dir: env.dir,
			home: env.home,
			runId: admitted.run_id,
			// M6-F1: a recorded PF1 counts toward a `completed` receipt only WITH a
			// matching signed acceptance verdict on the tape.
			acceptance: { admittedEventId: admitted.event_id },
		});

		const resume = await runCliCapture(
			["planforge", "resume", "--input", GOAL_INPUT, "--json"],
			env.dir,
		);
		expect(resume.err).toBe("");
		expect(resume.code).toBe(0);
		const result = JSON.parse(resume.out) as PlanForgeJson;
		expect(result.status).toBe("resumed");
		expect(result.admitted_event_id).toBe(admitted.event_id);
		expect(result.recorded_activity_count).toBe(1);
		expect(result.executed_activity_count).toBe(1);
		expect(result.runs).toHaveLength(2);
		expect(result.runs[0]).toMatchObject({
			task: "pf-plan-95d7132e:PF1",
			run_id: RECORDED_TASK_RUN_ID,
			status: "passed",
			source: "recorded",
			activity_id: RECORDED_ACTIVITY_ID,
		});
		expect(result.runs[1]).toMatchObject({
			task: "pf-plan-95d7132e:PF2",
			status: "passed",
			source: "executed",
		});

		const rows = await readEvents(env.eventsDbPath);
		expect(rows.filter((r) => r.kind === "plan_admitted")).toHaveLength(1);
		expect(rows.filter((r) => r.kind === "activity_completed")).toHaveLength(2);
		expect(rows.filter((r) => r.kind === "plan_receipt")).toHaveLength(1);
	}, 30_000);

	it("returns already_receipted and does not append a duplicate receipt after completed dispatch", async () => {
		await initBuildplaneProject(env.dir);

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
		const admitted = JSON.parse(admit.out) as { event_id: string };

		const dispatch = await runCliCapture(
			["planforge", "dispatch", "--input", GOAL_INPUT, "--json"],
			env.dir,
		);
		expect(dispatch.err).toBe("");
		expect(dispatch.code).toBe(0);
		const beforeRows = await readEvents(env.eventsDbPath);
		expect(beforeRows.filter((r) => r.kind === "plan_receipt")).toHaveLength(1);

		const resume = await runCliCapture(
			["planforge", "resume", "--input", GOAL_INPUT, "--json"],
			env.dir,
		);
		expect(resume.err).toBe("");
		expect(resume.code).toBe(0);
		const result = JSON.parse(resume.out) as PlanForgeJson;
		expect(result.status).toBe("already_receipted");
		expect(result.admitted_event_id).toBe(admitted.event_id);
		expect(result.receipt_event_id).toBeTruthy();
		expect(result.runs).toHaveLength(2);
		expect(result.runs.every((run) => run.source === "recorded")).toBe(true);

		const afterRows = await readEvents(env.eventsDbPath);
		expect(afterRows.filter((r) => r.kind === "plan_receipt")).toHaveLength(1);
	}, 30_000);

	it("fail-closes a recorded activity that has NO matching acceptance verdict (acceptance-not-evaluated)", async () => {
		await initBuildplaneProject(env.dir);

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
		const admitted = JSON.parse(admit.out) as { run_id: string };

		// Crash BEFORE the acceptance gate ran: a recorded activity_completed with NO
		// acceptance_recorded verdict on the tape.
		await appendRecordedCompletedActivity({
			dir: env.dir,
			home: env.home,
			runId: admitted.run_id,
		});

		const resume = await runCliCapture(
			["planforge", "resume", "--input", GOAL_INPUT, "--json"],
			env.dir,
		);
		// Fail-closed: enforcement is ON by default, so an unverified recorded prefix
		// must NOT be minted `completed`.
		expect(resume.code).toBe(1);
		const result = JSON.parse(resume.out) as PlanForgeJson;
		expect(result.status).toBe("failed");
		const pf1 = result.runs.find((run) => run.source === "recorded");
		expect(pf1?.reason).toBe("acceptance-not-evaluated");
		expect(pf1?.status).toBe("acceptance-not-evaluated");
		// The suffix never runs once the recorded prefix fail-closes.
		expect(result.executed_activity_count).toBe(0);

		// Exactly one terminal plan_receipt, outcome `failed`. The receipt binds its
		// result (the `runs` array carrying the machine-readable reason) via
		// `result_digest`, so the failed outcome + a non-empty result_digest prove the
		// fail-closed result was committed to the signed tape.
		const rows = await readEvents(env.eventsDbPath);
		expect(rows.filter((r) => r.kind === "plan_receipt")).toHaveLength(1);
		expect(receiptOutcomes(rows)).toEqual(["failed"]);
		const receiptRow = rows.find((r) => r.kind === "plan_receipt");
		const receiptPayload = JSON.parse(receiptRow?.payload ?? "{}") as {
			PlanReceiptRecordedV1: { result_digest: string };
		};
		expect(receiptPayload.PlanReceiptRecordedV1.result_digest).toMatch(
			/^sha256:/,
		);
	}, 30_000);

	it("--no-enforce-acceptance restores the legacy recorded-passed-on-activity-result behavior", async () => {
		await initBuildplaneProject(env.dir);

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
		const admitted = JSON.parse(admit.out) as { run_id: string };

		// No acceptance verdict on the tape — but the operator opts out of the gate.
		await appendRecordedCompletedActivity({
			dir: env.dir,
			home: env.home,
			runId: admitted.run_id,
		});

		const resume = await runCliCapture(
			[
				"planforge",
				"resume",
				"--input",
				GOAL_INPUT,
				"--no-enforce-acceptance",
				"--json",
			],
			env.dir,
		);
		expect(resume.err).toBe("");
		expect(resume.code).toBe(0);
		const result = JSON.parse(resume.out) as PlanForgeJson;
		expect(result.status).toBe("resumed");
		const pf1 = result.runs.find((run) => run.source === "recorded");
		expect(pf1?.status).toBe("passed");
		expect(pf1?.reason).toBeUndefined();
	}, 30_000);

	it("fail-closes the executed suffix when its acceptance checks fail (AC1)", async () => {
		await initBuildplaneProject(env.dir);
		// RED acceptance checks: `pnpm install` still provisions (exit 0), but every
		// verification command (`pnpm typecheck`/`pnpm vitest`/…) exits 1, so PF2's
		// finalization gate rejects the diff.
		installPnpmShim(env.binDir, "exit 1");

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
		const admitted = JSON.parse(admit.out) as {
			event_id: string;
			run_id: string;
		};

		// Recorded PF1 IS accepted (matching verdict on the tape) so the suffix runs.
		await appendRecordedCompletedActivity({
			dir: env.dir,
			home: env.home,
			runId: admitted.run_id,
			acceptance: { admittedEventId: admitted.event_id },
		});

		const resume = await runCliCapture(
			["planforge", "resume", "--input", GOAL_INPUT, "--json"],
			env.dir,
		);
		expect(resume.code).toBe(1);
		const result = JSON.parse(resume.out) as PlanForgeJson;
		expect(result.status).toBe("failed");
		const pf2 = result.runs.find((run) => run.source === "executed");
		expect(pf2).toBeDefined();
		expect(pf2?.status).not.toBe("passed");

		const rows = await readEvents(env.eventsDbPath);
		expect(rows.filter((r) => r.kind === "plan_receipt")).toHaveLength(1);
		expect(receiptOutcomes(rows)).toEqual(["failed"]);
	}, 60_000);
});
