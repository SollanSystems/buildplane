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
import { createBuildplaneStorage } from "@buildplane/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writePlanForgeDispatchManifest } from "../../apps/cli/src/run-cli.ts";
import {
	LEDGER_TEST_REPO_ROOT,
	resolveNativeBinaryForLedgerTests,
} from "./fixtures.ts";

// S7 startup crash-recovery coverage. `planforge recover` (no --input) scans
// storage for orphaned `running` PlanForge dispatches via the dispatch-manifest
// sidecar, replays the signed tape for each, executes only the remaining suffix,
// and emits the missing terminal plan_receipt — re-establishing worker trust FROM
// THE TAPE. Also covers the D5 dedup-on-append guard: a second terminal-receipt
// emit appends at most one plan_receipt.

const GOAL_INPUT = resolve(
	LEDGER_TEST_REPO_ROOT,
	"apps/cli/test/fixtures/planforge/goal-input.md",
);
const PLAN_ID = "pf-plan-95d7132e";
const RECORDED_TASK_RUN_ID = "01919000-0000-7000-8000-000000000801";
const RECORDED_ACTIVITY_ID = "recorded-pf1";
const RECORDED_ACTIVITY_RESULT = { exitCode: 0, stdout: "", stderr: "" };

interface RecoverEnv {
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

async function makeRecoverEnv(): Promise<RecoverEnv> {
	const dir = await mkdtemp(join(tmpdir(), "bp-recover-ws-"));
	const home = await mkdtemp(join(tmpdir(), "bp-recover-home-"));
	const binDir = await mkdtemp(join(tmpdir(), "bp-recover-bin-"));
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

function installClaudeShim(binDir: string): void {
	const shim = join(binDir, "claude");
	writeFileSync(shim, '#!/bin/sh\necho \'{"result":"ok"}\'\nexit 0\n', "utf8");
	chmodSync(shim, 0o755);
}

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

function waitForExit(child: ChildProcess): Promise<number> {
	const exit = new Promise<number>((resolveExit, reject) => {
		child.on("exit", (code) => resolveExit(code ?? -1));
		child.on("error", (err) => reject(err));
	});
	exit.catch(() => {});
	return exit;
}

function pf1AcceptanceContractDigest(): string {
	const plan = createPlanForgeDryRunPlan(GOAL_INPUT);
	return acceptanceContractDigest(
		deriveAcceptanceContract(plan, plan.tasks[0]),
	);
}

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
					input: "recover-fixture",
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
			// M6-F1: seed the matching signed acceptance verdict so the recorded PF1
			// counts as accepted on resume/recover (default enforcement ON).
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

describe("planforge recover — startup crash auto-resume", () => {
	let env: RecoverEnv;
	let originalHome: string | undefined;
	let originalNativeBin: string | undefined;
	let originalPath: string | undefined;

	beforeEach(async () => {
		env = await makeRecoverEnv();
		originalHome = process.env.HOME;
		originalNativeBin = process.env.BUILDPLANE_NATIVE_BIN;
		originalPath = process.env.PATH;
		process.env.HOME = env.home;
		process.env.BUILDPLANE_NATIVE_BIN = resolveNativeBinaryForLedgerTests();
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

	it("emitting a terminal receipt twice appends exactly one plan_receipt (dedup on idempotency_key)", async () => {
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

		// First resume emits the missing receipt.
		await appendRecordedCompletedActivity({
			dir: env.dir,
			home: env.home,
			runId: admitted.run_id,
			acceptance: { admittedEventId: admitted.event_id },
		});
		const first = await runCliCapture(
			["planforge", "resume", "--input", GOAL_INPUT, "--json"],
			env.dir,
		);
		expect(first.err).toBe("");
		expect(first.code).toBe(0);

		// Second resume must short-circuit (already_receipted) and never double-append.
		const second = await runCliCapture(
			["planforge", "resume", "--input", GOAL_INPUT, "--json"],
			env.dir,
		);
		expect(second.code).toBe(0);

		const rows = await readEvents(env.eventsDbPath);
		expect(rows.filter((r) => r.kind === "plan_receipt")).toHaveLength(1);
	}, 30_000);

	it("recover scans running rows, replays the suffix, emits the missing receipt (no --input)", async () => {
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

		// Simulate a crash mid-dispatch: suffix incomplete, manifest written, a
		// storage row left `running`. The recorded PF1 carries its acceptance verdict
		// so recover resumes it to completion (default enforcement ON).
		await appendRecordedCompletedActivity({
			dir: env.dir,
			home: env.home,
			runId: admitted.run_id,
			acceptance: { admittedEventId: admitted.event_id },
		});
		writePlanForgeDispatchManifest(env.dir, {
			runId: admitted.run_id,
			inputPath: GOAL_INPUT,
			planId: PLAN_ID,
			idempotencyKey: "unused-in-recover",
			createdAt: new Date().toISOString(),
		});
		const storage = createBuildplaneStorage(env.dir);
		const orphan = storage.createRun({
			unit: {
				id: `${PLAN_ID}:PF2`,
				kind: "planforge-task",
				scope: ".",
				inputRefs: [],
				expectedOutputs: [],
				verificationContract: "true",
				policyProfile: "default",
			},
			execution: { command: "true" },
			verification: { requiredOutputs: [] },
		} as never);
		storage.markRunRunning(orphan.id);

		const recover = await runCliCapture(
			["planforge", "recover", "--json"],
			env.dir,
		);
		expect(recover.err).toBe("");
		expect(recover.code).toBe(0);
		const result = JSON.parse(recover.out) as {
			status: string;
			recovered: Array<{ plan_id: string; status: string }>;
		};
		expect(result.status).toBe("recovered");
		expect(result.recovered).toHaveLength(1);
		expect(result.recovered[0]).toMatchObject({
			plan_id: PLAN_ID,
			status: "resumed",
		});

		const rows = await readEvents(env.eventsDbPath);
		expect(rows.filter((r) => r.kind === "plan_receipt")).toHaveLength(1);

		// D4 reconcile: the orphaned `running` storage row is flipped to a terminal
		// status consistent with the receipt — no longer `running` (closes the M2
		// "receipt on tape but running in storage → reconcile" contract line).
		const stillRunning = createBuildplaneStorage(env.dir)
			.listRunsByStatus("running")
			.map((r) => r.id);
		expect(stillRunning).not.toContain(orphan.id);
		const reconciled = createBuildplaneStorage(env.dir)
			.listRunsByStatus("passed")
			.map((r) => r.id);
		expect(reconciled).toContain(orphan.id);

		// AC4 idempotency: a second recover pass finds no orphans (the reconciled row
		// is no longer `running`, and the tape already carries the terminal receipt).
		const secondPass = await runCliCapture(
			["planforge", "recover", "--json"],
			env.dir,
		);
		expect(secondPass.code).toBe(0);
		const secondResult = JSON.parse(secondPass.out) as { status: string };
		expect(secondResult.status).toBe("no_orphans");
		expect(
			(await readEvents(env.eventsDbPath)).filter(
				(r) => r.kind === "plan_receipt",
			),
		).toHaveLength(1);
	}, 30_000);

	it("recover is a no-op when there are no orphans", async () => {
		await initBuildplaneProject(env.dir);
		const recover = await runCliCapture(
			["planforge", "recover", "--json"],
			env.dir,
		);
		expect(recover.code).toBe(0);
		const result = JSON.parse(recover.out) as {
			status: string;
			recovered: unknown[];
		};
		expect(result.status).toBe("no_orphans");
		expect(result.recovered).toEqual([]);
	}, 30_000);
});
