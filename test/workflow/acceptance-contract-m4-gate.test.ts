import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	LEDGER_TEST_REPO_ROOT,
	resolveNativeBinaryForLedgerTests,
} from "../ledger-integration/fixtures.ts";

/**
 * M4 GATE — the acceptance contract is an enforceable fail-closed finalization
 * gate over the REAL dispatch + finalization path, not a documentary one.
 *
 * Drives the production `planforge dispatch --enforce-acceptance` over the toy
 * goal fixture (same admit→dispatch→finalize path as M2/M3) and proves all three
 * terminal outcomes end-to-end against the real git worktree, real signed tape,
 * and real check runner:
 *   (a) in-scope diff + green checks → acceptance_recorded{passed} AND merge;
 *   (b) out-of-scope diff (a green check that writes outside diff-scope) →
 *       acceptance_recorded{rejected} AND no merge AND worktree preserved;
 *   (c) failing check command → acceptance_recorded{rejected} AND no merge.
 *
 * Then proves replaying the signed tape reconstructs the ordered chain
 * plan_admitted → acceptance_recorded → plan_receipt via the external verifier
 * (`scripts/verify-signed-tape.mjs`) — the same utility planforge-receipt uses.
 *
 * The toy plan's first task (PF1) checks are `git status …`, `git diff --check`,
 * and `pnpm lint`. The first two always pass in a fresh worktree; the run's
 * outcome is steered purely by a `pnpm` shim prepended to PATH for the check
 * subprocess — exactly the independent worktree check surface the gate runs.
 */

const GOAL_INPUT = resolve(
	LEDGER_TEST_REPO_ROOT,
	"apps/cli/test/fixtures/planforge/goal-input.md",
);
const VERIFIER = resolve(
	LEDGER_TEST_REPO_ROOT,
	"scripts/verify-signed-tape.mjs",
);

interface GateEnv {
	dir: string;
	home: string;
	binDir: string;
	eventsDbPath: string;
	cleanup: () => Promise<void>;
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

async function makeGateEnv(): Promise<GateEnv> {
	const dir = await mkdtemp(join(tmpdir(), "bp-m4-gate-ws-"));
	const home = await mkdtemp(join(tmpdir(), "bp-m4-gate-home-"));
	const binDir = await mkdtemp(join(tmpdir(), "bp-m4-gate-bin-"));
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
 * Install a `pnpm` shim on PATH. `pnpm` is invoked for TWO distinct purposes:
 *   1. worktree dependency provisioning (`pnpm install --frozen-lockfile`),
 *      which GAP-3 runs before the gate — this must always succeed cleanly with
 *      no side effects, or the run fails at provisioning before the gate runs;
 *   2. the toy plan's `pnpm lint` check, which the gate's check runner invokes.
 * `body` is the shell body for the CHECK invocation only (it runs in the
 * worktree cwd), letting a test make the check pass, fail, or pass while writing
 * an out-of-scope file. The `install` invocation is intercepted to exit 0.
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

/**
 * Install a `claude` shim on PATH. Dispatch spawns a real claude-code model
 * worker; without a binary the worker exits non-zero and the run fails before
 * the acceptance verdict governs the outcome. The shim emits a valid
 * `--output-format json` result and exits 0 so the model packet succeeds and the
 * run's pass/fail is governed purely by the acceptance gate (the surface here).
 */
function installClaudeShim(binDir: string): void {
	const shim = join(binDir, "claude");
	writeFileSync(shim, '#!/bin/sh\necho \'{"result":"ok"}\'\nexit 0\n', "utf8");
	chmodSync(shim, 0o755);
}

async function initBuildplaneProject(dir: string): Promise<void> {
	const res = await runCliCapture(["init"], dir);
	expect(res.code).toBe(0);
	runGit(dir, ["add", "-A"]);
	runGit(dir, ["commit", "-q", "-m", "buildplane: init"]);
}

async function admit(dir: string): Promise<void> {
	const res = await runCliCapture(
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
	expect(res.code).toBe(0);
}

interface EventRow {
	id: string;
	kind: string;
	payload: string;
}

async function readEvents(eventsDbPath: string): Promise<EventRow[]> {
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

async function distinctRunId(eventsDbPath: string): Promise<string> {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(eventsDbPath, { readOnly: true });
	try {
		const rows = db
			.prepare("SELECT DISTINCT run_id FROM events")
			.all() as unknown as Array<{ run_id: string }>;
		expect(rows).toHaveLength(1);
		return rows[0].run_id;
	} finally {
		db.close();
	}
}

interface AcceptancePayload {
	outcome: string;
	diff_scope_status: string;
	out_of_scope_files: string[];
	checks: Array<{ command: string; status: string; exit_code: string }>;
}

function acceptanceEvents(rows: EventRow[]): AcceptancePayload[] {
	return rows
		.filter((r) => r.kind === "acceptance_recorded")
		.map(
			(r) => JSON.parse(r.payload).AcceptanceRecordedV1 as AcceptancePayload,
		);
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

/** Project-root commit subjects — a merged run leaves a "merge buildplane run"
 * commit; a quarantined run never advances the project-root history. */
function projectRootLog(dir: string): string {
	return spawnSync("git", ["-C", dir, "log", "--oneline"], {
		encoding: "utf8",
	}).stdout;
}

async function dispatchEnforced(
	dir: string,
): Promise<{ code: number; out: string; err: string }> {
	const res = await runCliCapture(
		[
			"planforge",
			"dispatch",
			"--input",
			GOAL_INPUT,
			"--enforce-acceptance",
			"--json",
		],
		dir,
	);
	return { code: res.code, out: res.out, err: res.err };
}

describe("M4 GATE — acceptance contract finalization gate (end-to-end)", () => {
	let env: GateEnv;
	let originalHome: string | undefined;
	let originalNativeBin: string | undefined;
	let originalPath: string | undefined;

	beforeEach(async () => {
		env = await makeGateEnv();
		originalHome = process.env.HOME;
		originalNativeBin = process.env.BUILDPLANE_NATIVE_BIN;
		originalPath = process.env.PATH;
		process.env.HOME = env.home;
		process.env.BUILDPLANE_NATIVE_BIN = resolveNativeBinaryForLedgerTests();
		// The shim dir is first on PATH so the gate's `pnpm lint` check resolves it.
		process.env.PATH = `${env.binDir}:${originalPath ?? ""}`;
		// Dispatch spawns a real claude-code model worker; shim it so the model
		// packet succeeds and the run outcome is governed by the acceptance gate.
		installClaudeShim(env.binDir);
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

	it("(a) in-scope diff + green checks → acceptance_recorded{passed} and the run merges", async () => {
		await initBuildplaneProject(env.dir);
		await admit(env.dir);
		// Green check that touches nothing → no diff, all checks exit 0.
		installPnpmShim(env.binDir, "exit 0");

		const dispatch = await dispatchEnforced(env.dir);
		expect(dispatch.err).toBe("");
		expect(dispatch.code).toBe(0);
		const result = JSON.parse(dispatch.out) as {
			status: string;
			runs: Array<{ status: string }>;
		};
		expect(result.status).toBe("dispatched");
		expect(result.runs.every((r) => r.status === "passed")).toBe(true);

		const rows = await readEvents(env.eventsDbPath);
		const accepted = acceptanceEvents(rows);
		// One passed verdict per task (PF1, PF2) — both pass under the green shim.
		expect(accepted.length).toBeGreaterThanOrEqual(1);
		expect(accepted.every((a) => a.outcome === "passed")).toBe(true);
		expect(accepted.every((a) => a.diff_scope_status === "passed")).toBe(true);
		expect(
			accepted.every((a) => a.checks.every((c) => c.status === "passed")),
		).toBe(true);

		// The merge occurred: project-root history carries a buildplane merge commit
		// and the run's terminal receipt reports "completed".
		expect(projectRootLog(env.dir)).toContain("merge buildplane run");
		expect(receiptOutcomes(rows)).toContain("completed");
	}, 60_000);

	it("(b) out-of-scope diff → acceptance_recorded{rejected}, no merge, worktree preserved (quarantine)", async () => {
		await initBuildplaneProject(env.dir);
		await admit(env.dir);
		const beforeLog = projectRootLog(env.dir);
		// A check that exits 0 but writes a file OUTSIDE the task's diff-scope
		// (docs/**, fixtures). The gate re-collects changed files after the checks
		// run, so the out-of-scope write is caught despite the zero exit.
		installPnpmShim(
			env.binDir,
			"mkdir -p src && echo exfil > src/sneaky.ts\nexit 0",
		);

		const dispatch = await dispatchEnforced(env.dir);
		expect(dispatch.code).toBe(1);
		const result = JSON.parse(dispatch.out) as {
			status: string;
			runs: Array<{ status: string }>;
		};
		expect(result.status).toBe("failed");
		expect(result.runs[0]?.status).not.toBe("passed");

		const rows = await readEvents(env.eventsDbPath);
		const accepted = acceptanceEvents(rows);
		// PF2 dependsOn PF1, so the chain breaks after PF1 is rejected: exactly one
		// recorded verdict, and it is the diff-scope rejection.
		expect(accepted).toHaveLength(1);
		expect(accepted[0].outcome).toBe("rejected");
		expect(accepted[0].diff_scope_status).toBe("blocked");
		expect(accepted[0].out_of_scope_files).toContain("src/sneaky.ts");
		// The checks themselves were green — this is a diff-scope rejection, not a
		// check failure.
		expect(accepted[0].checks.every((c) => c.status === "passed")).toBe(true);

		// No merge: project-root history is unchanged and the out-of-scope file
		// never landed in the project root.
		expect(projectRootLog(env.dir)).toBe(beforeLog);
		expect(existsSync(join(env.dir, "src/sneaky.ts"))).toBe(false);

		// Quarantine: the rejected run's worktree is preserved on disk, carrying the
		// out-of-scope artifact for inspection.
		const runId = await distinctRunId(env.eventsDbPath);
		const workspacesDir = join(env.dir, ".buildplane", "workspaces");
		expect(existsSync(workspacesDir)).toBe(true);
		const { readdirSync } = await import("node:fs");
		const preserved = readdirSync(workspacesDir);
		expect(preserved.length).toBeGreaterThanOrEqual(1);
		expect(existsSync(join(workspacesDir, preserved[0], "src/sneaky.ts"))).toBe(
			true,
		);
		expect(runId).toBeTruthy();

		// No completed receipt — the plan did not finalize as merged.
		expect(receiptOutcomes(rows)).not.toContain("completed");
	}, 60_000);

	it("(c) failing check command → acceptance_recorded{rejected} and no merge", async () => {
		await initBuildplaneProject(env.dir);
		await admit(env.dir);
		const beforeLog = projectRootLog(env.dir);
		// The `pnpm lint` check exits non-zero → the gate rejects before any merge.
		installPnpmShim(env.binDir, "exit 1");

		const dispatch = await dispatchEnforced(env.dir);
		expect(dispatch.code).toBe(1);
		const result = JSON.parse(dispatch.out) as {
			status: string;
			runs: Array<{ status: string }>;
		};
		expect(result.status).toBe("failed");
		expect(result.runs[0]?.status).not.toBe("passed");

		const rows = await readEvents(env.eventsDbPath);
		const accepted = acceptanceEvents(rows);
		expect(accepted).toHaveLength(1);
		expect(accepted[0].outcome).toBe("rejected");
		expect(accepted[0].checks.some((c) => c.status === "failed")).toBe(true);

		// No merge: project-root history unchanged, no completed receipt.
		expect(projectRootLog(env.dir)).toBe(beforeLog);
		expect(receiptOutcomes(rows)).not.toContain("completed");
	}, 60_000);

	it("replay reconstructs the ordered chain plan_admitted → acceptance_recorded → plan_receipt and the external verifier validates every signed event", async () => {
		await initBuildplaneProject(env.dir);
		await admit(env.dir);
		installPnpmShim(env.binDir, "exit 0");

		const dispatch = await dispatchEnforced(env.dir);
		expect(dispatch.code).toBe(0);

		const rows = await readEvents(env.eventsDbPath);
		const admitted = rows.filter((r) => r.kind === "plan_admitted");
		const accepted = rows.filter((r) => r.kind === "acceptance_recorded");
		const receipts = rows.filter((r) => r.kind === "plan_receipt");
		expect(admitted).toHaveLength(1);
		expect(accepted.length).toBeGreaterThanOrEqual(1);
		expect(receipts).toHaveLength(1);

		// Tape order (id ASC) is the replayable chain: admission precedes every
		// acceptance verdict, and the terminal receipt follows them all.
		const admittedId = admitted[0].id;
		const receiptId = receipts[0].id;
		for (const a of accepted) {
			expect(admittedId < a.id).toBe(true);
			expect(a.id < receiptId).toBe(true);
		}

		// The acceptance verdict chains back to the signed plan_admitted event id.
		const acceptedPayload = JSON.parse(accepted[0].payload)
			.AcceptanceRecordedV1 as { admission_event_id: string };
		expect(acceptedPayload.admission_event_id).toBe(admittedId);

		// Export the live signed tape and run the EXTERNAL verifier — it replays the
		// canonical hash + signature of every non-checkpoint event independently.
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
			{
				encoding: "utf8",
			},
		);
		expect(verify.status, verify.stderr).toBe(0);
		const report = JSON.parse(verify.stdout) as {
			ok: boolean;
			events: Array<{ id: string; kind: string; status: string }>;
		};
		expect(report.ok).toBe(true);

		// The full M4 chain is present and every signed event verifies.
		for (const kind of [
			"plan_admitted",
			"acceptance_recorded",
			"plan_receipt",
		]) {
			const matched = report.events.filter((e) => e.kind === kind);
			expect(matched.length, `expected at least one ${kind}`).toBeGreaterThan(
				0,
			);
			for (const e of matched) {
				expect(e.status, `${kind} should verify`).toBe("verified");
			}
		}

		// Verifier-reported order matches the replay chain: admitted → accepted → receipt.
		const idsByKind = (kind: string) =>
			report.events.filter((e) => e.kind === kind).map((e) => e.id);
		const admittedOut = idsByKind("plan_admitted")[0];
		const receiptOut = idsByKind("plan_receipt")[0];
		for (const acceptedId of idsByKind("acceptance_recorded")) {
			expect(admittedOut < acceptedId).toBe(true);
			expect(acceptedId < receiptOut).toBe(true);
		}
	}, 60_000);
});
