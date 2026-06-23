import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveNativeBinaryForLedgerTests } from "./fixtures.ts";

// GAP-10: `planforge authorize-envelope` spawns `ledger serve --sign` and
// appends a kernel-signed operator_decision_recorded{subject=authorize-envelope}
// to the repo-root tape. Mirrors planforge-admit.test.ts: a kernel ed25519 seed
// under a temp HOME drives the real native binary, no process.chdir.

interface EnvelopeEnv {
	dir: string;
	home: string;
	eventsDbPath: string;
	cleanup: () => Promise<void>;
}

async function makeEnvelopeEnv(): Promise<EnvelopeEnv> {
	const dir = await mkdtemp(join(tmpdir(), "bp-envelope-ws-"));
	const home = await mkdtemp(join(tmpdir(), "bp-envelope-home-"));
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

interface DecisionRow {
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
	decisions: DecisionRow[];
	signatures: SignatureRow[];
}> {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(eventsDbPath, { readOnly: true });
	try {
		const decisions = db
			.prepare(
				"SELECT id, payload FROM events WHERE kind = 'operator_decision_recorded'",
			)
			.all() as unknown as DecisionRow[];
		const signatures = db
			.prepare(
				"SELECT event_id, actor_id, key_id, algorithm FROM event_signatures",
			)
			.all() as unknown as SignatureRow[];
		return { decisions, signatures };
	} finally {
		db.close();
	}
}

async function runEnvelope(
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

const ENVELOPE_ARGS = [
	"planforge",
	"authorize-envelope",
	"--milestone",
	"M5",
	"--side-effects",
	"code-edit",
	"--path-globs",
	"src/**,test/**",
	"--max-iterations",
	"8",
	"--token-budget",
	"4000000",
	"--verification-cmds",
	"pnpm,cargo,tsc",
	"--expires-at",
	"2026-07-01T00:00:00Z",
	"--approve",
	"--operator",
	"khall",
];

describe.sequential("authorize-envelope signed tape", () => {
	let env: EnvelopeEnv;
	let originalHome: string | undefined;
	let originalNativeBin: string | undefined;

	beforeEach(async () => {
		env = await makeEnvelopeEnv();
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

	it("records a kernel-signed operator_decision_recorded with the envelope", async () => {
		const { code } = await runEnvelope([...ENVELOPE_ARGS, "--json"], env.dir);
		expect(code).toBe(0);

		const { decisions, signatures } = await readTape(env.eventsDbPath);
		expect(decisions).toHaveLength(1);
		const payload = JSON.parse(decisions[0].payload).OperatorDecisionRecordedV1;
		expect(payload.subject).toBe("authorize-envelope");
		expect(payload.decision).toBe("approved");
		expect(payload.decided_by).toBe("operator:khall");
		expect(payload.envelope).toContain('"milestone":"M5"');
		// canonical-json keys are sorted: allowed_side_effects precedes path_globs.
		expect(payload.envelope.indexOf("allowed_side_effects")).toBeLessThan(
			payload.envelope.indexOf("path_globs"),
		);

		const sig = signatures.find((s) => s.event_id === decisions[0].id);
		expect(sig?.actor_id).toBe("kernel");
		expect(sig?.key_id).toBe("kernel-main");
		expect(sig?.algorithm).toBe("ed25519");
	});

	it("is idempotent: re-authorizing the identical envelope writes no second event", async () => {
		const first = await runEnvelope(ENVELOPE_ARGS, env.dir);
		const second = await runEnvelope(ENVELOPE_ARGS, env.dir);
		expect(first.code).toBe(0);
		expect(second.code).toBe(0);

		const { decisions } = await readTape(env.eventsDbPath);
		expect(decisions).toHaveLength(1);
	});

	it("fails closed with no tape write when --approve is missing", async () => {
		const { code, threw } = await runEnvelope(
			ENVELOPE_ARGS.filter((a) => a !== "--approve"),
			env.dir,
		);
		expect(threw || code !== 0).toBe(true);
		expect(existsSync(env.eventsDbPath)).toBe(false);
	});

	it("re-authorizing the SIGNED envelope is idempotent (kernel-signed row suppresses)", async () => {
		// Companion to the unit-level GAP-10 P2 test: a real kernel-signed row DOES
		// suppress a second emit. Together they prove the signature gate distinguishes
		// signed from unsigned matching rows end-to-end.
		const first = await runEnvelope(ENVELOPE_ARGS, env.dir);
		expect(first.code).toBe(0);
		const second = await runEnvelope(ENVELOPE_ARGS, env.dir);
		expect(second.code).toBe(0);
		const { decisions } = await readTape(env.eventsDbPath);
		expect(decisions).toHaveLength(1);
	});
});
