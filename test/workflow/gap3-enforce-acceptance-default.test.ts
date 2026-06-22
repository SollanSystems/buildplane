import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	LEDGER_TEST_REPO_ROOT,
	resolveNativeBinaryForLedgerTests,
} from "../ledger-integration/fixtures.ts";

/**
 * GAP-3 — `planforge dispatch` enforces the M4 acceptance gate by DEFAULT.
 *
 * Proves the default flip end-to-end over the real admit→dispatch→finalize path:
 *   - dispatch WITHOUT any acceptance flag activates the gate (green pnpm shim →
 *     run passes AND `acceptance_recorded` verdicts land on the tape);
 *   - dispatch WITHOUT any flag with a FAILING check shim → the gate rejects
 *     (exit 1, no merge) — crisp proof the gate is genuinely active by default;
 *   - dispatch WITH `--no-enforce-acceptance` skips the gate (legacy behaviour:
 *     no `acceptance_recorded` events, run still dispatches).
 *
 * The same `pnpm` shim (exit 0 / exit 1 for any args) backs both the new
 * `pnpm install --frozen-lockfile` provisioning call and the toy plan's
 * `pnpm lint` check — the provisioning step hits the shim and exits cleanly.
 */

const GOAL_INPUT = resolve(
	LEDGER_TEST_REPO_ROOT,
	"apps/cli/test/fixtures/planforge/goal-input.md",
);

interface EventRow {
	id: string;
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

function runGit(cwd: string, args: string[]): void {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	}
}

function installPnpmShim(binDir: string, body: string): void {
	const shim = join(binDir, "pnpm");
	writeFileSync(shim, `#!/bin/sh\n${body}\n`, "utf8");
	chmodSync(shim, 0o755);
}

/**
 * Install a `claude` shim on PATH. Dispatch spawns a real claude-code model
 * worker (GAP-4); without a binary the worker exits non-zero and the run fails
 * before the acceptance verdict is meaningful. The shim emits a valid
 * `--output-format json` result and exits 0 so the model packet succeeds and the
 * run's pass/fail is governed by the acceptance gate (the GAP-3 surface here).
 */
function installClaudeShim(binDir: string): void {
	const shim = join(binDir, "claude");
	writeFileSync(shim, '#!/bin/sh\necho \'{"result":"ok"}\'\nexit 0\n', "utf8");
	chmodSync(shim, 0o755);
}

async function readEvents(eventsDbPath: string): Promise<EventRow[]> {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(eventsDbPath, { readOnly: true });
	try {
		return db
			.prepare("SELECT id, kind FROM events ORDER BY id ASC")
			.all() as unknown as EventRow[];
	} finally {
		db.close();
	}
}

async function initAndAdmit(dir: string): Promise<void> {
	const initRes = await runCliCapture(["init"], dir);
	expect(initRes.code).toBe(0);
	runGit(dir, ["add", "-A"]);
	runGit(dir, ["commit", "-q", "-m", "buildplane: init"]);
	const admitRes = await runCliCapture(
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
	expect(admitRes.code).toBe(0);
}

describe("GAP-3: planforge dispatch enforces acceptance by default", () => {
	let dir: string;
	let home: string;
	let binDir: string;
	let eventsDbPath: string;
	let originalHome: string | undefined;
	let originalNativeBin: string | undefined;
	let originalPath: string | undefined;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bp-gap3-enforce-ws-"));
		home = await mkdtemp(join(tmpdir(), "bp-gap3-enforce-home-"));
		binDir = await mkdtemp(join(tmpdir(), "bp-gap3-enforce-bin-"));
		eventsDbPath = join(dir, ".buildplane", "ledger", "events.db");
		const keyDir = join(home, ".buildplane", "keys", "kernel");
		mkdirSync(keyDir, { recursive: true });
		writeFileSync(join(keyDir, "kernel-main.ed25519"), Buffer.alloc(32, 7));
		runGit(dir, ["init", "-q"]);
		runGit(dir, ["config", "user.email", "test@test"]);
		runGit(dir, ["config", "user.name", "test"]);
		runGit(dir, ["commit", "-q", "--allow-empty", "-m", "init"]);
		// Dispatch spawns a real claude-code model worker (GAP-4); shim it so the
		// model packet succeeds and the run's outcome is governed by the gate.
		installClaudeShim(binDir);

		originalHome = process.env.HOME;
		originalNativeBin = process.env.BUILDPLANE_NATIVE_BIN;
		originalPath = process.env.PATH;
		process.env.HOME = home;
		process.env.BUILDPLANE_NATIVE_BIN = resolveNativeBinaryForLedgerTests();
		process.env.PATH = `${binDir}:${originalPath ?? ""}`;
	});

	afterEach(async () => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalNativeBin === undefined)
			delete process.env.BUILDPLANE_NATIVE_BIN;
		else process.env.BUILDPLANE_NATIVE_BIN = originalNativeBin;
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		await rm(dir, { recursive: true, force: true });
		await rm(home, { recursive: true, force: true });
		await rm(binDir, { recursive: true, force: true });
	});

	it("dispatch WITHOUT a flag activates the gate (green shim → passes + acceptance verdicts on tape)", async () => {
		await initAndAdmit(dir);
		installPnpmShim(binDir, "exit 0");

		const dispatch = await runCliCapture(
			["planforge", "dispatch", "--input", GOAL_INPUT, "--json"],
			dir,
		);
		expect(dispatch.err).toBe("");
		expect(dispatch.code).toBe(0);
		const result = JSON.parse(dispatch.out) as {
			status: string;
			runs: Array<{ status: string }>;
		};
		expect(result.status).toBe("dispatched");
		expect(result.runs.every((r) => r.status === "passed")).toBe(true);

		// The gate ran by default: at least one acceptance verdict is on the tape.
		const rows = await readEvents(eventsDbPath);
		const accepted = rows.filter((r) => r.kind === "acceptance_recorded");
		expect(accepted.length).toBeGreaterThanOrEqual(1);
	}, 60_000);

	it("dispatch WITHOUT a flag is genuinely gated (failing check → rejected, no merge)", async () => {
		await initAndAdmit(dir);
		// The same `pnpm` binary backs BOTH the provisioning step
		// (`pnpm install --frozen-lockfile`) and the gate's `pnpm lint` check.
		// Provisioning must succeed (else the run fails before the gate); only the
		// check fails — proving the gate is genuinely active and rejecting.
		installPnpmShim(
			binDir,
			'case "$1" in install) exit 0 ;; *) exit 1 ;; esac',
		);

		const dispatch = await runCliCapture(
			["planforge", "dispatch", "--input", GOAL_INPUT, "--json"],
			dir,
		);
		expect(dispatch.code).toBe(1);
		const result = JSON.parse(dispatch.out) as {
			status: string;
			runs: Array<{ status: string }>;
		};
		expect(result.status).toBe("failed");
		expect(result.runs[0]?.status).not.toBe("passed");

		const rows = await readEvents(eventsDbPath);
		const accepted = rows.filter((r) => r.kind === "acceptance_recorded");
		expect(accepted.length).toBeGreaterThanOrEqual(1);
		// No merge: the project root never advances past its init history.
		const log = spawnSync("git", ["-C", dir, "log", "--oneline"], {
			encoding: "utf8",
		}).stdout;
		expect(log).not.toContain("merge buildplane run");
	}, 60_000);

	it("dispatch WITH --no-enforce-acceptance skips the gate (no acceptance verdicts; still dispatches)", async () => {
		await initAndAdmit(dir);
		// No pnpm shim body is exercised by the gate here; install a green one so
		// the absence of acceptance events is attributable to the opt-out, not a
		// missing binary.
		installPnpmShim(binDir, "exit 0");

		const dispatch = await runCliCapture(
			[
				"planforge",
				"dispatch",
				"--input",
				GOAL_INPUT,
				"--no-enforce-acceptance",
				"--json",
			],
			dir,
		);
		expect(dispatch.code).toBe(0);
		const result = JSON.parse(dispatch.out) as { status: string };
		expect(result.status).toBe("dispatched");

		// Gate skipped: no acceptance verdicts recorded on the tape.
		const rows = await readEvents(eventsDbPath);
		const accepted = rows.filter((r) => r.kind === "acceptance_recorded");
		expect(accepted).toHaveLength(0);
	}, 60_000);
});
