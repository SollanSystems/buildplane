import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	LEDGER_TEST_REPO_ROOT,
	resolveNativeBinaryForLedgerTests,
} from "./fixtures.ts";

// M6-S7 (A1): a `planforge dispatch` run that reaches its terminal `passed` outcome
// emits a kernel-signed `result_ready` write-ahead of any merge/quarantine decision,
// over the REAL signed ledger. Asserts (a) result_ready lands in events.db and
// verifies under the kernel key, (b) it chains to the plan_admitted + a real
// acceptance_recorded event, (c) the derived inbox surface is unchanged —
// acceptance_recorded coexists — and (d) it is write-ahead (no operator decision has
// happened yet). Mirrors planforge-dispatch.test.ts.

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
): Promise<{ code: number; out: string; err: string }> {
	const runCli = await loadRunCli();
	const out: string[] = [];
	const err: string[] = [];
	const code = await runCli(argv, {
		cwd,
		stdout: (l) => out.push(l),
		stderr: (l) => err.push(l),
	});
	return { code, out: out.join("\n"), err: err.join("\n") };
}

async function makeEnv(): Promise<Env> {
	const dir = await mkdtemp(join(tmpdir(), "bp-resultready-ws-"));
	const home = await mkdtemp(join(tmpdir(), "bp-resultready-home-"));
	const binDir = await mkdtemp(join(tmpdir(), "bp-resultready-bin-"));
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

function installPnpmShim(binDir: string): void {
	const shim = join(binDir, "pnpm");
	writeFileSync(
		shim,
		'#!/bin/sh\nif [ "$1" = "install" ]; then exit 0; fi\nexit 0\n',
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

interface TapeRow {
	id: string;
	kind: string;
	payload: string;
}

async function readTape(eventsDbPath: string): Promise<{
	rows: TapeRow[];
	signedIds: Set<string>;
	kernelSignedIds: Set<string>;
}> {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(eventsDbPath, { readOnly: true });
	try {
		const rows = db
			.prepare("SELECT id, kind, payload FROM events ORDER BY id ASC")
			.all() as unknown as TapeRow[];
		const sigs = db
			.prepare("SELECT event_id, actor_id, key_id FROM event_signatures")
			.all() as unknown as {
			event_id: string;
			actor_id: string;
			key_id: string;
		}[];
		const signedIds = new Set(sigs.map((s) => s.event_id));
		const kernelSignedIds = new Set(
			sigs
				.filter((s) => s.actor_id === "kernel" && s.key_id === "kernel-main")
				.map((s) => s.event_id),
		);
		return { rows, signedIds, kernelSignedIds };
	} finally {
		db.close();
	}
}

describe("planforge dispatch — signed result_ready at terminal passed (M6-S7)", () => {
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
		process.env.PATH = `${env.binDir}:${originalPath ?? ""}`;
		installClaudeShim(env.binDir);
		installPnpmShim(env.binDir);
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

	it("emits a kernel-signed result_ready chained to acceptance + admission, coexisting with acceptance_recorded, write-ahead of any merge decision", async () => {
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
		expect(admittedEventId).toBeTruthy();

		const dispatch = await runCliCapture(
			["planforge", "dispatch", "--input", GOAL_INPUT, "--json"],
			env.dir,
		);
		expect(dispatch.err).toBe("");
		expect(dispatch.code).toBe(0);
		const dispatchResult = JSON.parse(dispatch.out) as {
			runs: { task: string; run_id: string; status: string }[];
		};
		const passedRunIds = dispatchResult.runs
			.filter((r) => r.status === "passed")
			.map((r) => r.run_id);
		expect(passedRunIds.length).toBeGreaterThan(0);

		const { rows, kernelSignedIds } = await readTape(env.eventsDbPath);
		const resultReady = rows.filter((r) => r.kind === "result_ready");
		const acceptance = rows.filter((r) => r.kind === "acceptance_recorded");

		// One result_ready per passed run.
		expect(resultReady).toHaveLength(passedRunIds.length);

		// (c) Coexistence — the derived inbox surface (acceptance_recorded) is
		// unchanged: an acceptance verdict still lands per run alongside result_ready.
		expect(acceptance.length).toBeGreaterThanOrEqual(passedRunIds.length);
		const acceptanceIds = new Set(acceptance.map((r) => r.id));

		// (d) Write-ahead — no operator merge/quarantine decision has happened yet.
		expect(rows.some((r) => r.kind === "operator_decision_recorded")).toBe(
			false,
		);
		expect(rows.some((r) => r.kind === "run_completed")).toBe(false);

		for (const rr of resultReady) {
			const payload = JSON.parse(rr.payload).ResultReadyV1;
			// (b) chains to the plan_admitted event.
			expect(payload.admission_event_id).toBe(admittedEventId);
			// (b) chains to a REAL acceptance_recorded event id on this tape.
			expect(acceptanceIds.has(payload.acceptance_event_id)).toBe(true);
			expect(passedRunIds).toContain(payload.run_id);
			// (a) verifies under the kernel key.
			expect(kernelSignedIds.has(rr.id)).toBe(true);
		}
	}, 60_000);
});
