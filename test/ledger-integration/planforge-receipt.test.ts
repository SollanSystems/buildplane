import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	LEDGER_TEST_REPO_ROOT,
	resolveNativeBinaryForLedgerTests,
} from "./fixtures.ts";

// End-to-end PlanForge receipt + live-tape export over REAL machinery (M2-S6).
// After admit→dispatch, the signed tape must carry exactly one `plan_receipt`
// chaining to the `plan_admitted` event, kernel-signed, ordered after the
// activities. Then `ledger export-signed-tape` must produce a tape the external
// verifier (`scripts/verify-signed-tape.mjs`) validates end-to-end
// (admit → activities → receipt).
//
// Mirrors activity-bracketing.test.ts's harness exactly (temp HOME + kernel
// ed25519 seed, explicit cwd, no process.chdir).

const GOAL_INPUT = resolve(
	LEDGER_TEST_REPO_ROOT,
	"apps/cli/test/fixtures/planforge/goal-input.md",
);
const VERIFIER = resolve(
	LEDGER_TEST_REPO_ROOT,
	"scripts/verify-signed-tape.mjs",
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

async function makeDispatchEnv(): Promise<DispatchEnv> {
	const dir = await mkdtemp(join(tmpdir(), "bp-receipt-ws-"));
	const home = await mkdtemp(join(tmpdir(), "bp-receipt-home-"));
	const keyDir = join(home, ".buildplane", "keys", "kernel");
	mkdirSync(keyDir, { recursive: true });
	// Raw 32-byte ed25519 seed — export derives the verifying key from this same
	// seed, so the exported trusted_keys bind to the signatures.
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

describe("planforge dispatch — signed plan_receipt + live-tape export end-to-end", () => {
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

	it("emits one signed plan_receipt chaining to plan_admitted, then exports a verifier-valid tape", async () => {
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
		const admitted = rows.filter((r) => r.kind === "plan_admitted");
		const completed = rows.filter((r) => r.kind === "activity_completed");
		const receipts = rows.filter((r) => r.kind === "plan_receipt");

		// Exactly one terminal plan_receipt for the admitted plan.
		expect(admitted).toHaveLength(1);
		expect(receipts).toHaveLength(1);
		const receipt = receipts[0];
		const receiptPayload = JSON.parse(receipt.payload)
			.PlanReceiptRecordedV1 as {
			admission_event_id: string;
			outcome: string;
			result_digest: string;
			side_effects: string[];
		};

		// Chains to the real plan_admitted event id.
		expect(receiptPayload.admission_event_id).toBe(admitted[0].id);
		// Terminal outcome + canonical result digest.
		expect(receiptPayload.outcome).toBe("completed");
		expect(receiptPayload.result_digest).toMatch(/^sha256:/);
		expect(Array.isArray(receiptPayload.side_effects)).toBe(true);

		// Emitted after all activities (terminal ordering).
		for (const c of completed) {
			expect(c.id < receipt.id).toBe(true);
		}

		// Kernel-signed.
		expect(await signatureFor(env.eventsDbPath, receipt.id)).toMatchObject({
			actor_id: "kernel",
			key_id: "kernel-main",
			algorithm: "ed25519",
		});

		// --- Live export → external verifier (the S6 acceptance) ---
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

		// The full admission cycle is present and every event verified.
		for (const kind of [
			"plan_admitted",
			"activity_started",
			"activity_completed",
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
	}, 30_000);
});
