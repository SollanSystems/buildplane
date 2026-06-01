import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	LEDGER_TEST_REPO_ROOT,
	resolveNativeBinaryForLedgerTests,
} from "./fixtures.ts";

// End-to-end admit→dispatch over REAL machinery: the signed ledger subprocess
// (native binary) appends a kernel-signed plan_admitted; `planforge dispatch`
// reads it back via findExistingPlanAdmitted, builds one packet per task, and
// runs each through the kernel orchestrator's runPacketAsync (prepareRun →
// assertRunnableRepository → prepareWorkspace (git worktree add) → admission gate
// (re-verifies the signed plan_admitted by event id) → execute `true` → finalize).
//
// No process.chdir here (it races under vitest parallel workers, per the
// fixtures.ts corruption note) — runCli takes an explicit cwd, and the binary +
// kernel key resolve via env. This file is intentionally separate so its
// worker-per-file isolation never overlaps with makeBuildplaneRunFixture's chdir.

const GOAL_INPUT = resolve(
	LEDGER_TEST_REPO_ROOT,
	"apps/cli/test/fixtures/planforge/goal-input.md",
);

interface DispatchEnv {
	dir: string;
	home: string;
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

/**
 * Create an isolated git-initialized + buildplane-initialized workspace under a
 * temp HOME carrying a kernel ed25519 seed (so `ledger serve --sign` produces
 * real detached signatures). Mirrors makeBuildplaneRunFixture's runnable-project
 * setup (git init + commit + `buildplane init` + commit) — but with an explicit
 * cwd instead of process.chdir, and without running a packet.
 */
async function makeDispatchEnv(): Promise<DispatchEnv> {
	const dir = await mkdtemp(join(tmpdir(), "bp-dispatch-ws-"));
	const home = await mkdtemp(join(tmpdir(), "bp-dispatch-home-"));
	const keyDir = join(home, ".buildplane", "keys", "kernel");
	mkdirSync(keyDir, { recursive: true });
	// Raw 32-byte ed25519 seed (copied from planforge-admit.test.ts) — the value
	// is irrelevant, only that the kernel key resolves so signing succeeds.
	writeFileSync(join(keyDir, "kernel-main.ed25519"), Buffer.alloc(32, 7));

	runGit(dir, ["init", "-q"]);
	runGit(dir, ["config", "user.email", "test@test"]);
	runGit(dir, ["config", "user.name", "test"]);
	runGit(dir, ["commit", "-q", "--allow-empty", "-m", "init"]);

	return {
		dir,
		home,
		eventsDbPath: join(dir, ".buildplane", "ledger", "events.db"),
		cleanup: async () => {
			await rm(dir, { recursive: true, force: true });
			await rm(home, { recursive: true, force: true });
		},
	};
}

/** Initialize the Buildplane project (state.db + project.json) and commit the
 * artifacts so the run-loop's assertRunnableRepository sees a clean worktree. */
async function initBuildplaneProject(dir: string): Promise<void> {
	const res = await runCliCapture(["init"], dir);
	expect(res.code).toBe(0);
	runGit(dir, ["add", "-A"]);
	runGit(dir, ["commit", "-q", "-m", "buildplane: init"]);
}

interface AdmissionReceiptRun {
	run_id?: string;
	provenance_ref?: string;
}
interface AdmissionReceipt {
	run?: AdmissionReceiptRun;
}

/** Read every admission receipt written under <git-dir>/buildplane/admission/
 * receipts/*.json. The kernel default admission store resolves the git dir via
 * `git rev-parse --absolute-git-dir`; for a plain repo that is <dir>/.git. */
function readAdmissionReceipts(dir: string): AdmissionReceipt[] {
	const receiptsDir = join(dir, ".git", "buildplane", "admission", "receipts");
	if (!existsSync(receiptsDir)) {
		return [];
	}
	return readdirSync(receiptsDir)
		.filter((f) => f.endsWith(".json"))
		.map(
			(f) =>
				JSON.parse(readFileSync(join(receiptsDir, f), "utf8")) as AdmissionReceipt,
		);
}

interface DispatchJson {
	status: string;
	plan_id: string;
	admitted_event_id: string;
	runs: Array<{ task: string; run_id: string; status: string }>;
}

describe("planforge admit→dispatch — signed-gate end-to-end", () => {
	let env: DispatchEnv;
	let originalHome: string | undefined;
	let originalNativeBin: string | undefined;

	beforeEach(async () => {
		env = await makeDispatchEnv();
		originalHome = process.env.HOME;
		originalNativeBin = process.env.BUILDPLANE_NATIVE_BIN;
		process.env.HOME = env.home;
		process.env.BUILDPLANE_NATIVE_BIN = resolveNativeBinaryForLedgerTests();
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
		await env.cleanup();
	});

	it("dispatches an admitted plan as one passed run per task, all carrying admitted_event_id", async () => {
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
		const admitJson = JSON.parse(admit.out) as {
			status: string;
			event_id: string;
		};
		expect(admitJson.status).toBe("admitted");
		const admittedEventId = admitJson.event_id;
		expect(admittedEventId).toBeTruthy();

		const dispatch = await runCliCapture(
			["planforge", "dispatch", "--input", GOAL_INPUT, "--json"],
			env.dir,
		);
		expect(dispatch.err).toBe("");
		expect(dispatch.code).toBe(0);

		const result = JSON.parse(dispatch.out) as DispatchJson;
		expect(result.status).toBe("dispatched");
		expect(result.admitted_event_id).toBe(admittedEventId);
		expect(result.runs).toHaveLength(2);
		for (const run of result.runs) {
			expect(run.status).toBe("passed");
			expect(run.run_id).toBeTruthy();
		}
		// One run per PlanForgeTask (PF1, PF2), in plan order.
		expect(result.runs.map((r) => r.task)).toEqual([
			"pf-plan-95d7132e:PF1",
			"pf-plan-95d7132e:PF2",
		]);
	}, 30_000);

	it("lands provenance_ref == admitted_event_id on each run's admission receipt", async () => {
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
		const admittedEventId = (JSON.parse(admit.out) as { event_id: string })
			.event_id;

		const dispatch = await runCliCapture(
			["planforge", "dispatch", "--input", GOAL_INPUT, "--json"],
			env.dir,
		);
		expect(dispatch.code).toBe(0);
		const result = JSON.parse(dispatch.out) as DispatchJson;
		expect(result.runs).toHaveLength(2);

		const receipts = readAdmissionReceipts(env.dir);
		// One admission receipt per dispatched run.
		const byRunId = new Map<string, AdmissionReceipt>();
		for (const receipt of receipts) {
			const runId = receipt.run?.run_id;
			if (runId) {
				byRunId.set(runId, receipt);
			}
		}
		for (const run of result.runs) {
			const receipt = byRunId.get(run.run_id);
			expect(
				receipt,
				`expected an admission receipt for run ${run.run_id}`,
			).toBeDefined();
			expect(receipt?.run?.provenance_ref).toBe(admittedEventId);
		}
	}, 30_000);

	it("fails closed (plan-not-admitted) when dispatching a plan with no signed plan_admitted", async () => {
		await initBuildplaneProject(env.dir);
		// No admit step: the tape has no plan_admitted for this plan.

		const dispatch = await runCliCapture(
			["planforge", "dispatch", "--input", GOAL_INPUT, "--json"],
			env.dir,
		);
		expect(dispatch.threw || dispatch.code !== 0).toBe(true);
		expect(`${dispatch.err}\n${dispatch.out}`).toContain("plan-not-admitted");
	}, 30_000);
});
