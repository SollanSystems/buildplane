import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	LEDGER_TEST_REPO_ROOT,
	resolveNativeBinaryForLedgerTests,
} from "./fixtures.ts";

// M6-F2: per-tool-call tape events on the `planforge dispatch` path. S8 (#220)
// wired `createClaudeToolLedgerEmitter` only on the `bp run` path, so the dispatch
// tape showed activity bracketing but no per-tool-call events. This drives a real
// admit→dispatch over the signed ledger with a `claude` shim that emits a
// stream-json tool_use/tool_result pair, and asserts tool_request/tool_result land
// on the DISPATCH tape correlated to the activity bracket + packet unit.
//
// Mirrors planforge-dispatch.test.ts's harness (temp HOME + kernel ed25519 seed,
// explicit cwd, no process.chdir — worker-per-file isolation avoids the
// fixtures.ts chdir race).

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
	const dir = await mkdtemp(join(tmpdir(), "bp-tool-ws-"));
	const home = await mkdtemp(join(tmpdir(), "bp-tool-home-"));
	const binDir = await mkdtemp(join(tmpdir(), "bp-tool-bin-"));
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

const TOOL_USE_ID = "toolu_f2demo";

/**
 * Install a `claude` shim on PATH that emits a stream-json tool_use/tool_result
 * pair (the schema the real claude-code executor parses into `onToolEvent`),
 * then a terminal success `result` line. This drives the executor's per-tool-call
 * callback so the dispatch tape gains tool_request/tool_result events. Exits 0 so
 * the model packet passes.
 */
function installToolEmittingClaudeShim(binDir: string): void {
	const shim = join(binDir, "claude");
	const assistant = `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"${TOOL_USE_ID}","name":"Bash","input":{"command":"echo hi"}}]}}`;
	const user = `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"${TOOL_USE_ID}","content":"hi","is_error":false}]}}`;
	const result = `{"type":"result","subtype":"success","is_error":false,"result":"ok","usage":{"input_tokens":1,"output_tokens":1}}`;
	writeFileSync(
		shim,
		`#!/bin/sh\necho '${assistant}'\necho '${user}'\necho '${result}'\nexit 0\n`,
		"utf8",
	);
	chmodSync(shim, 0o755);
}

/** Green `pnpm` shim: install is intercepted, checks pass, so the default-on
 * acceptance gate stays out of the way and the test focuses on tool capture. */
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

interface EventRow {
	id: string;
	kind: string;
	parent_event_id: string | null;
	payload: string;
}

function readEvents(eventsDbPath: string): EventRow[] {
	const db = new DatabaseSync(eventsDbPath, { readOnly: true });
	try {
		return db
			.prepare(
				"SELECT id, kind, parent_event_id, payload FROM events ORDER BY id ASC",
			)
			.all() as unknown as EventRow[];
	} finally {
		db.close();
	}
}

async function admit(dir: string): Promise<string> {
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
	const eventId = (JSON.parse(res.out) as { event_id: string }).event_id;
	expect(eventId).toBeTruthy();
	return eventId;
}

interface DispatchJson {
	status: string;
	runs: Array<{ task: string; run_id: string; status: string }>;
}

/**
 * Assert the dispatch tape carries per-tool-call events correctly correlated:
 *  - every tool_request parent == some activity_started event id
 *  - every tool_request unit_id == a dispatched task id (non-empty)
 *  - every tool_result.tool_request_id == a stored tool_request event id
 */
function assertToolCapture(
	eventsDbPath: string,
	taskIds: readonly string[],
): void {
	const events = readEvents(eventsDbPath);

	const activityStartedIds = new Set(
		events.filter((e) => e.kind === "activity_started").map((e) => e.id),
	);
	expect(activityStartedIds.size).toBeGreaterThan(0);

	const toolRequests = events.filter((e) => e.kind === "tool_request");
	const toolResults = events.filter((e) => e.kind === "tool_result");
	expect(toolRequests.length).toBeGreaterThan(0);
	expect(toolResults.length).toBeGreaterThan(0);

	const toolRequestIds = new Set(toolRequests.map((e) => e.id));
	const taskIdSet = new Set(taskIds);

	for (const req of toolRequests) {
		const stored = (
			JSON.parse(req.payload) as {
				ToolRequestStoredV1: { unit_id: string; tool_name: string };
			}
		).ToolRequestStoredV1;
		// parent == the in-flight packet's activity_started event id.
		expect(activityStartedIds.has(req.parent_event_id ?? "")).toBe(true);
		// unit_id populated with the dispatched packet's unit.
		expect(stored.unit_id).not.toBe("");
		expect(taskIdSet.has(stored.unit_id)).toBe(true);
		expect(stored.tool_name).toBe("Bash");
	}

	for (const res of toolResults) {
		const out = (
			JSON.parse(res.payload) as {
				ToolResultV1: { tool_request_id: string };
			}
		).ToolResultV1;
		// result correlates back to a stored request event id.
		expect(toolRequestIds.has(out.tool_request_id)).toBe(true);
	}
}

describe("planforge dispatch — per-tool-call tape capture end-to-end (M6-F2)", () => {
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
		process.env.PATH = `${env.binDir}:${originalPath ?? ""}`;
		installToolEmittingClaudeShim(env.binDir);
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

	it("lands tool_request/tool_result on the dispatch tape (acceptance-enforced path)", async () => {
		await initBuildplaneProject(env.dir);
		await admit(env.dir);

		const dispatch = await runCliCapture(
			["planforge", "dispatch", "--input", GOAL_INPUT, "--json"],
			env.dir,
		);
		expect(dispatch.err).toBe("");
		expect(dispatch.code).toBe(0);
		const result = JSON.parse(dispatch.out) as DispatchJson;
		expect(result.status).toBe("dispatched");
		const taskIds = result.runs.map((r) => r.task);
		expect(taskIds.length).toBeGreaterThan(0);

		assertToolCapture(env.eventsDbPath, taskIds);
	}, 30_000);

	it("lands tool_request/tool_result on the dispatch tape (no-enforce path)", async () => {
		await initBuildplaneProject(env.dir);
		await admit(env.dir);

		const dispatch = await runCliCapture(
			[
				"planforge",
				"dispatch",
				"--input",
				GOAL_INPUT,
				"--no-enforce-acceptance",
				"--json",
			],
			env.dir,
		);
		expect(dispatch.err).toBe("");
		expect(dispatch.code).toBe(0);
		const result = JSON.parse(dispatch.out) as DispatchJson;
		const taskIds = result.runs.map((r) => r.task);
		expect(taskIds.length).toBeGreaterThan(0);

		assertToolCapture(env.eventsDbPath, taskIds);
	}, 30_000);
});
