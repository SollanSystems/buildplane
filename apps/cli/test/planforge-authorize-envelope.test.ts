import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const localAuthorityPath = vi.hoisted(() => {
	const emit = vi.fn();
	const createTapeEmitter = vi.fn(async () => ({
		emit,
		flush: vi.fn(async () => undefined),
		close: vi.fn(async () => undefined),
		stats: () => ({ lastAckedEventId: "event-local-authority" }),
	}));
	return {
		emit,
		createTapeEmitter,
		assertKernelSigningKey: vi.fn(),
		resolveLedgerBinary: vi.fn(() => "buildplane-native-test"),
		spawnLedgerSubprocess: vi.fn(() => ({
			child: { exitCode: 0, kill: vi.fn() },
			stdin: {},
			stderr: {},
			exit: Promise.resolve(0),
		})),
	};
});

vi.mock("@buildplane/ledger-client", () => ({
	createTapeEmitter: localAuthorityPath.createTapeEmitter,
}));

vi.mock("../src/ledger-emit.js", () => ({
	assertKernelSigningKey: localAuthorityPath.assertKernelSigningKey,
	PLANFORGE_KERNEL_SIGNING_KEY_ID: "kernel-main",
	resolveLedgerBinary: localAuthorityPath.resolveLedgerBinary,
	spawnLedgerSubprocess: localAuthorityPath.spawnLedgerSubprocess,
}));

const {
	buildAuthorizeEnvelopePayload,
	findExistingAuthorizeEnvelope,
	parseEnvelopeArgs,
	runPlanForgeAuthorizeEnvelopeCommand,
} = await import("../src/planforge-authorize-envelope.js");
const { GOVERNED_AUTHORITY_BROKER_REQUIRED } = await import(
	"../src/governed-ledger-authority.js"
);

const baseArgs = [
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
	"pnpm vitest run,cargo test,tsc --noEmit",
	"--expires-at",
	"2027-07-01T00:00:00Z",
	"--approve",
	"--operator",
	"khall",
];

describe("planforge authorize-envelope", () => {
	it("fails closed before local tape append when no verifier-backed V3 broker is available", async () => {
		localAuthorityPath.emit.mockClear();
		localAuthorityPath.createTapeEmitter.mockClear();
		localAuthorityPath.assertKernelSigningKey.mockClear();
		localAuthorityPath.resolveLedgerBinary.mockClear();
		localAuthorityPath.spawnLedgerSubprocess.mockClear();
		const stdout: string[] = [];
		const commandWorkspace = mkdtempSync(
			join(tmpdir(), "bp-planforge-no-broker-"),
		);
		try {
			await expect(
				runPlanForgeAuthorizeEnvelopeCommand(
					baseArgs,
					commandWorkspace,
					(line) => stdout.push(line),
				),
			).rejects.toThrow(GOVERNED_AUTHORITY_BROKER_REQUIRED);

			expect(localAuthorityPath.assertKernelSigningKey).not.toHaveBeenCalled();
			expect(localAuthorityPath.resolveLedgerBinary).not.toHaveBeenCalled();
			expect(localAuthorityPath.spawnLedgerSubprocess).not.toHaveBeenCalled();
			expect(localAuthorityPath.createTapeEmitter).not.toHaveBeenCalled();
			expect(localAuthorityPath.emit).not.toHaveBeenCalled();
			expect(stdout).toEqual([]);
		} finally {
			rmSync(commandWorkspace, { recursive: true, force: true });
		}
	});

	it("fails closed without --approve", () => {
		expect(() =>
			parseEnvelopeArgs(baseArgs.filter((a) => a !== "--approve")),
		).toThrow(/--approve/);
	});

	it("fails closed without --operator", () => {
		expect(() =>
			parseEnvelopeArgs(
				baseArgs.filter(
					(a, i) =>
						a !== "khall" &&
						baseArgs[i - 1] !== "--operator" &&
						a !== "--operator",
				),
			),
		).toThrow(/--operator/);
	});

	it("rejects a non-positive --max-iterations", () => {
		const bad = baseArgs.map((a) => (a === "8" ? "0" : a));
		expect(() => parseEnvelopeArgs(bad)).toThrow(/max-iterations/);
	});

	it("rejects --max-iterations with trailing garbage (8xyz)", () => {
		const bad = baseArgs.map((a) => (a === "8" ? "8xyz" : a));
		expect(() => parseEnvelopeArgs(bad)).toThrow(/max-iterations/);
	});

	it("rejects --token-budget with trailing garbage (4000000xyz)", () => {
		const bad = baseArgs.map((a) => (a === "4000000" ? "4000000xyz" : a));
		expect(() => parseEnvelopeArgs(bad)).toThrow(/token-budget/);
	});

	it("rejects --max-iterations above Number.MAX_SAFE_INTEGER", () => {
		const huge = "9007199254740993"; // MAX_SAFE_INTEGER + 2
		const bad = baseArgs.map((a) => (a === "8" ? huge : a));
		expect(() => parseEnvelopeArgs(bad)).toThrow(/max-iterations/);
	});

	it("rejects --token-budget above Number.MAX_SAFE_INTEGER", () => {
		const huge = "99999999999999999999"; // far beyond MAX_SAFE_INTEGER
		const bad = baseArgs.map((a) => (a === "4000000" ? huge : a));
		expect(() => parseEnvelopeArgs(bad)).toThrow(/token-budget/);
	});

	it("accepts a clean integer --max-iterations 8", () => {
		const parsed = parseEnvelopeArgs(baseArgs);
		expect(parsed.envelope.max_iterations).toBe(8);
		expect(parsed.envelope.token_budget).toBe(4000000);
	});

	it("rejects a non-RFC3339 --expires-at", () => {
		const bad = baseArgs.map((a) =>
			a === "2027-07-01T00:00:00Z" ? "not-a-date" : a,
		);
		expect(() => parseEnvelopeArgs(bad)).toThrow(/expires-at/);
	});

	it("rejects unknown, duplicate, and expired authorization inputs", () => {
		expect(() => parseEnvelopeArgs([...baseArgs, "--unrecognized"])).toThrow(
			/Unsupported/,
		);
		expect(() => parseEnvelopeArgs([...baseArgs, "--milestone", "M6"])).toThrow(
			/Duplicate --milestone/,
		);
		expect(() =>
			parseEnvelopeArgs(
				baseArgs.map((argument) =>
					argument === "2027-07-01T00:00:00Z"
						? "2020-01-01T00:00:00Z"
						: argument,
				),
			),
		).toThrow(/in the future/);
	});

	it("builds a v0 envelope payload with canonical-JSON envelope + authorize-envelope subject", () => {
		const parsed = parseEnvelopeArgs(baseArgs);
		const payload = buildAuthorizeEnvelopePayload(
			parsed,
			new Date("2026-06-22T00:00:00Z"),
		);
		expect(payload.subject).toBe("authorize-envelope");
		expect(payload.decision).toBe("approved");
		expect(payload.decided_by).toBe("operator:khall");
		expect(payload.envelope).toContain('"milestone":"M5"');
		expect(payload.envelope.indexOf("allowed_side_effects")).toBeLessThan(
			payload.envelope.indexOf("path_globs"),
		);
	});

	it("normalizes verification-cmds to their argv0 allowlist", () => {
		const parsed = parseEnvelopeArgs(baseArgs);
		expect(parsed.envelope.allowed_verification_cmds).toEqual([
			"pnpm",
			"cargo",
			"tsc",
		]);
	});

	it("is idempotent: identical envelopes produce the same run id", () => {
		const a = parseEnvelopeArgs(baseArgs);
		const b = parseEnvelopeArgs(baseArgs);
		const pa = buildAuthorizeEnvelopePayload(
			a,
			new Date("2026-06-22T00:00:00Z"),
		);
		const pb = buildAuthorizeEnvelopePayload(
			b,
			new Date("2026-06-23T11:00:00Z"),
		);
		expect(pa.run_id).toBe(pb.run_id);
	});
});

describe("findExistingAuthorizeEnvelope signature gate (GAP-10 P2)", () => {
	let workspace: string;

	function seedRow(opts: {
		runId: string;
		envelope: string;
		signature?: { actor_id: string; key_id: string; algorithm: string };
	}): void {
		const ledgerDir = join(workspace, ".buildplane", "ledger");
		mkdirSync(ledgerDir, { recursive: true });
		const db = new DatabaseSync(join(ledgerDir, "events.db"));
		db.exec(
			"CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_event_id TEXT, schema_version INTEGER NOT NULL, kind TEXT NOT NULL, occurred_at TEXT NOT NULL, payload TEXT NOT NULL)",
		);
		db.exec(
			"CREATE TABLE IF NOT EXISTS event_signatures (event_id TEXT PRIMARY KEY, canonical_event_hash TEXT NOT NULL, actor_id TEXT NOT NULL, key_id TEXT NOT NULL, public_key_hash TEXT, algorithm TEXT NOT NULL, signature TEXT NOT NULL, signed_at TEXT NOT NULL)",
		);
		const eventId = "evt-1";
		db.prepare(
			"INSERT INTO events (id, run_id, schema_version, kind, occurred_at, payload) VALUES (?, ?, 1, 'operator_decision_recorded', ?, ?)",
		).run(
			eventId,
			opts.runId,
			"2026-06-22T00:00:00Z",
			JSON.stringify({
				OperatorDecisionRecordedV1: {
					subject: "authorize-envelope",
					envelope: opts.envelope,
				},
			}),
		);
		if (opts.signature) {
			db.prepare(
				"INSERT INTO event_signatures (event_id, canonical_event_hash, actor_id, key_id, algorithm, signature, signed_at) VALUES (?, 'sha256:0', ?, ?, ?, 'sig', ?)",
			).run(
				eventId,
				opts.signature.actor_id,
				opts.signature.key_id,
				opts.signature.algorithm,
				"2026-06-22T00:00:00Z",
			);
		}
		db.close();
	}

	beforeEach(() => {
		workspace = mkdtempSync(join(tmpdir(), "bp-envprobe-"));
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	it("does NOT suppress on an unsigned matching row", async () => {
		const parsed = parseEnvelopeArgs(baseArgs);
		const payload = buildAuthorizeEnvelopePayload(parsed, new Date());
		seedRow({ runId: payload.run_id, envelope: payload.envelope });
		const found = await findExistingAuthorizeEnvelope(
			workspace,
			payload.run_id,
			payload.envelope,
		);
		expect(found).toBeUndefined();
	});

	it("does NOT suppress on a forged non-kernel-signed matching row", async () => {
		const parsed = parseEnvelopeArgs(baseArgs);
		const payload = buildAuthorizeEnvelopePayload(parsed, new Date());
		seedRow({
			runId: payload.run_id,
			envelope: payload.envelope,
			signature: {
				actor_id: "attacker",
				key_id: "evil",
				algorithm: "ed25519",
			},
		});
		const found = await findExistingAuthorizeEnvelope(
			workspace,
			payload.run_id,
			payload.envelope,
		);
		expect(found).toBeUndefined();
	});

	it("does not trust forged kernel-labelled metadata without detached verification", async () => {
		const parsed = parseEnvelopeArgs(baseArgs);
		const payload = buildAuthorizeEnvelopePayload(parsed, new Date());
		seedRow({
			runId: payload.run_id,
			envelope: payload.envelope,
			signature: {
				actor_id: "kernel",
				key_id: "kernel-main",
				algorithm: "ed25519",
			},
		});
		const found = await findExistingAuthorizeEnvelope(
			workspace,
			payload.run_id,
			payload.envelope,
		);
		expect(found).toBeUndefined();
	});
});
