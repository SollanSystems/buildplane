import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	LEDGER_TEST_REPO_ROOT,
	resolveNativeBinaryForLedgerTests,
} from "./fixtures.ts";

// First signed TS-spawned tape path: `planforge admit` spawns `ledger serve
// --sign` and appends a kernel-signed plan_admitted. These tests provision a
// kernel ed25519 seed under a temp HOME and drive the real native binary.
//
// No process.chdir here (it caused the corruption documented in fixtures.ts) —
// runCli takes an explicit cwd and the binary/key resolve via env.

const GOAL_INPUT = resolve(
	LEDGER_TEST_REPO_ROOT,
	"apps/cli/test/fixtures/planforge/goal-input.md",
);

interface AdmitEnv {
	dir: string;
	home: string;
	eventsDbPath: string;
	cleanup: () => Promise<void>;
}

async function makeAdmitEnv(): Promise<AdmitEnv> {
	const dir = await mkdtemp(join(tmpdir(), "bp-admit-ws-"));
	const home = await mkdtemp(join(tmpdir(), "bp-admit-home-"));
	const keyDir = join(home, ".buildplane", "keys", "kernel");
	mkdirSync(keyDir, { recursive: true });
	// Raw 32-byte ed25519 seed; the value is irrelevant — only that the kernel
	// key resolves so `serve --sign` produces real detached signatures.
	writeFileSync(join(keyDir, "kernel-main.ed25519"), Buffer.alloc(32, 7));
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

interface PlanAdmittedRow {
	id: string;
	payload: string;
}
interface SignatureRow {
	event_id: string;
	actor_id: string;
	key_id: string;
	algorithm: string;
}

async function readTape(eventsDbPath: string): Promise<{
	planAdmitted: PlanAdmittedRow[];
	signatures: SignatureRow[];
}> {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(eventsDbPath, { readOnly: true });
	try {
		const planAdmitted = db
			.prepare("SELECT id, payload FROM events WHERE kind = 'plan_admitted'")
			.all() as unknown as PlanAdmittedRow[];
		const signatures = db
			.prepare(
				"SELECT event_id, actor_id, key_id, algorithm FROM event_signatures",
			)
			.all() as unknown as SignatureRow[];
		return { planAdmitted, signatures };
	} finally {
		db.close();
	}
}

async function runAdmit(
	argv: string[],
	cwd: string,
): Promise<{ code: number; threw: boolean; out: string[] }> {
	const runCli = await loadRunCli();
	const out: string[] = [];
	try {
		const code = await runCli(argv, {
			cwd,
			stdout: (l) => out.push(l),
			stderr: () => {},
		});
		return { code, threw: false, out };
	} catch {
		return { code: 1, threw: true, out };
	}
}

describe("planforge admit — signed plan_admitted append", () => {
	let env: AdmitEnv;
	let originalHome: string | undefined;
	let originalNativeBin: string | undefined;

	beforeEach(async () => {
		env = await makeAdmitEnv();
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

	it("admits a PASS plan as a kernel-signed plan_admitted on the tape", async () => {
		const { code } = await runAdmit(
			[
				"planforge",
				"admit",
				"--input",
				GOAL_INPUT,
				"--approve",
				"--operator",
				"khall",
				"--json",
			],
			env.dir,
		);
		expect(code).toBe(0);

		const { planAdmitted, signatures } = await readTape(env.eventsDbPath);
		expect(planAdmitted).toHaveLength(1);
		const payload = JSON.parse(planAdmitted[0].payload).PlanAdmittedV1;
		expect(payload.decided_by).toBe("operator:khall");
		expect(payload.authorized_next_step).toBe("dispatch_admitted_plan");
		expect(payload.idempotency_key).toMatch(/^planforge:v0:buildplane:/);

		const sig = signatures.find((s) => s.event_id === planAdmitted[0].id);
		expect(sig?.actor_id).toBe("kernel");
		expect(sig?.key_id).toBe("kernel-main");
		expect(sig?.algorithm).toBe("ed25519");
	});

	it("is idempotent: re-admitting the same plan writes no second event", async () => {
		const args = [
			"planforge",
			"admit",
			"--input",
			GOAL_INPUT,
			"--approve",
			"--operator",
			"khall",
		];
		const first = await runAdmit(args, env.dir);
		const second = await runAdmit(args, env.dir);
		expect(first.code).toBe(0);
		expect(second.code).toBe(0);

		const { planAdmitted } = await readTape(env.eventsDbPath);
		expect(planAdmitted).toHaveLength(1);
	});

	it("fails closed with no tape write when --approve is missing", async () => {
		const { code, threw } = await runAdmit(
			["planforge", "admit", "--input", GOAL_INPUT, "--operator", "khall"],
			env.dir,
		);
		expect(threw || code !== 0).toBe(true);
		expect(existsSync(env.eventsDbPath)).toBe(false);
	});

	it("fails closed with no tape write when --operator is missing", async () => {
		const { code, threw } = await runAdmit(
			["planforge", "admit", "--input", GOAL_INPUT, "--approve"],
			env.dir,
		);
		expect(threw || code !== 0).toBe(true);
		expect(existsSync(env.eventsDbPath)).toBe(false);
	});

	it("fails closed with no tape write on a non-PASS plan", async () => {
		const badInput = join(env.dir, "bad-goal.md");
		writeFileSync(
			badInput,
			"# bad\n\n## Goal\nMissing repository-context and safety-constraints sections, so validation is not PASS.\n",
		);
		const { code, threw } = await runAdmit(
			[
				"planforge",
				"admit",
				"--input",
				badInput,
				"--approve",
				"--operator",
				"khall",
			],
			env.dir,
		);
		expect(threw || code !== 0).toBe(true);
		expect(existsSync(env.eventsDbPath)).toBe(false);
	});
});
