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

// End-to-end activity bracketing over REAL machinery (M2-S5). After admit→dispatch,
// the signed tape must carry one `activity_started`/`activity_completed` bracket per
// dispatched task, kernel-signed, write-ahead-ordered (started.id < completed.id),
// paired by activity_id, with sha256: input/result digests.
//
// Mirrors planforge-dispatch.test.ts's harness exactly (temp HOME + kernel ed25519
// seed, explicit cwd, no process.chdir — worker-per-file isolation avoids the
// fixtures.ts chdir race). readEvents/signatureFor are local node:sqlite helpers.

const GOAL_INPUT = resolve(
	LEDGER_TEST_REPO_ROOT,
	"apps/cli/test/fixtures/planforge/goal-input.md",
);

interface DispatchEnv {
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

async function makeDispatchEnv(): Promise<DispatchEnv> {
	const dir = await mkdtemp(join(tmpdir(), "bp-activity-ws-"));
	const home = await mkdtemp(join(tmpdir(), "bp-activity-home-"));
	const binDir = await mkdtemp(join(tmpdir(), "bp-activity-bin-"));
	const keyDir = join(home, ".buildplane", "keys", "kernel");
	mkdirSync(keyDir, { recursive: true });
	// Raw 32-byte ed25519 seed — value irrelevant; only that the kernel key resolves.
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
 * Install a `claude` shim on PATH. PlanForge dispatch spawns a real claude-code
 * model worker; without a binary the worker exits non-zero and the run fails.
 * The shim emits a valid result and exits 0 so the model packet succeeds.
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
 * (`exit 0`) lets the default-on gate pass so this test exercises activity
 * bracketing, not the gate verdict.
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

interface EventRow {
	id: string;
	kind: string;
	payload: string;
}
interface SignatureRow {
	actor_id: string;
	key_id: string;
	algorithm: string;
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

async function signatureFor(
	eventsDbPath: string,
	eventId: string,
): Promise<SignatureRow | undefined> {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(eventsDbPath, { readOnly: true });
	try {
		return db
			.prepare(
				"SELECT actor_id, key_id, algorithm FROM event_signatures WHERE event_id = ?",
			)
			.get(eventId) as unknown as SignatureRow | undefined;
	} finally {
		db.close();
	}
}

describe("planforge dispatch — signed activity bracketing end-to-end", () => {
	let env: DispatchEnv;
	let originalHome: string | undefined;
	let originalNativeBin: string | undefined;
	let originalPath: string | undefined;

	beforeEach(async () => {
		env = await makeDispatchEnv();
		originalHome = process.env.HOME;
		originalNativeBin = process.env.BUILDPLANE_NATIVE_BIN;
		originalPath = process.env.PATH;
		process.env.HOME = env.home;
		process.env.BUILDPLANE_NATIVE_BIN = resolveNativeBinaryForLedgerTests();
		// Dispatch spawns a real claude-code model worker; shim it so the model
		// packet succeeds (no `claude` binary exists in the test sandbox). The
		// acceptance gate is ON by default (GAP-3), so a green `pnpm` shim lets
		// provisioning + checks pass and this test stays focused on bracketing.
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

	it("brackets each dispatched activity with signed activity_started/activity_completed", async () => {
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

		const dispatch = await runCliCapture(
			["planforge", "dispatch", "--input", GOAL_INPUT, "--json"],
			env.dir,
		);
		expect(dispatch.err).toBe("");
		expect(dispatch.code).toBe(0);

		const rows = await readEvents(env.eventsDbPath);
		const started = rows.filter((r) => r.kind === "activity_started");
		const completed = rows.filter((r) => r.kind === "activity_completed");
		// One bracket per dispatched task (PF1, PF2).
		expect(started).toHaveLength(2);
		expect(completed).toHaveLength(2);

		for (const s of started) {
			const sPayload = JSON.parse(s.payload).ActivityStartedV1 as {
				activity_id: string;
				activity_type: string;
				input_digest: string;
			};
			// PlanForge dispatch packets are claude-code MODEL packets (GAP-4) → model
			// activity type.
			expect(sPayload.activity_type).toBe("model");
			const c = completed.find(
				(x) =>
					(
						JSON.parse(x.payload).ActivityCompletedV1 as {
							activity_id: string;
						}
					).activity_id === sPayload.activity_id,
			);
			expect(
				c,
				`expected a paired activity_completed for ${sPayload.activity_id}`,
			).toBeDefined();
			// Write-ahead: started's monotonic event id sorts before its completed.
			expect(s.id < (c as EventRow).id).toBe(true);
			// Kernel-signed.
			const sig = await signatureFor(env.eventsDbPath, s.id);
			expect(sig).toMatchObject({
				actor_id: "kernel",
				key_id: "kernel-main",
				algorithm: "ed25519",
			});
			// Canonical digest form.
			expect(sPayload.input_digest).toMatch(/^sha256:/);
		}

		for (const c of completed) {
			const cPayload = JSON.parse(c.payload).ActivityCompletedV1 as {
				result_digest: string;
				result: { exitCode?: number };
			};
			expect(cPayload.result_digest).toMatch(/^sha256:/);
			// Inline recorded result (D3): the no-op command exits 0.
			expect(cPayload.result).toBeDefined();
			expect(cPayload.result.exitCode).toBe(0);
			const sig = await signatureFor(env.eventsDbPath, c.id);
			expect(sig).toMatchObject({
				actor_id: "kernel",
				key_id: "kernel-main",
				algorithm: "ed25519",
			});
		}
	}, 30_000);
});
