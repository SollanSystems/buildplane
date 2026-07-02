import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveNativeBinaryForLedgerTests } from "./fixtures.ts";

// M6-S7 (A2/A3): recordOperatorDecision emits a kernel-signed `run_completed`
// write-ahead after the operator decision's TERMINAL side effect, over the REAL
// signed ledger + real git worktree adapter + real storage. Asserts (a) the signed
// run_completed lands in events.db and verifies under the kernel key, (b) its
// outcome tracks the terminal branch (merge+approved → passed; merge/resume reject
// → failed), (c) the U64-hazard counts are STRINGS on the wire, and (d) a
// non-terminal resume+approved decision emits NO run_completed. Mirrors
// operator-decision-merge.test.ts.

interface Env {
	dir: string;
	home: string;
	eventsDbPath: string;
	cleanup: () => Promise<void>;
}

function git(cwd: string, args: string[]): { stdout: string } {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	}
	return { stdout: r.stdout };
}

async function makeEnv(): Promise<Env> {
	const dir = await mkdtemp(join(tmpdir(), "bp-runcomp-ws-"));
	const home = await mkdtemp(join(tmpdir(), "bp-runcomp-home-"));
	const keyDir = join(home, ".buildplane", "keys", "kernel");
	mkdirSync(keyDir, { recursive: true });
	writeFileSync(join(keyDir, "kernel-main.ed25519"), Buffer.alloc(32, 9));

	git(dir, ["init", "-q", "-b", "main"]);
	git(dir, ["config", "user.email", "test@buildplane"]);
	git(dir, ["config", "user.name", "Buildplane Test"]);
	git(dir, ["config", "commit.gpgsign", "false"]);
	writeFileSync(join(dir, "README.md"), "base\n");
	git(dir, ["add", "."]);
	git(dir, ["commit", "-q", "-m", "base"]);

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

interface SignatureRow {
	event_id: string;
	actor_id: string;
	key_id: string;
	algorithm: string;
}

async function readRunCompleted(eventsDbPath: string): Promise<{
	rows: { id: string; payload: string }[];
	signatures: SignatureRow[];
}> {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(eventsDbPath, { readOnly: true });
	try {
		const rows = db
			.prepare("SELECT id, payload FROM events WHERE kind = 'run_completed'")
			.all() as unknown as { id: string; payload: string }[];
		const signatures = db
			.prepare(
				"SELECT event_id, actor_id, key_id, algorithm FROM event_signatures",
			)
			.all() as unknown as SignatureRow[];
		return { rows, signatures };
	} finally {
		db.close();
	}
}

const PACKET = {
	unit: {
		id: "merge-unit",
		kind: "command" as const,
		scope: "task" as const,
		inputRefs: [],
		expectedOutputs: [],
		verificationContract: "exit-0-and-required-outputs" as const,
		policyProfile: "default",
	},
	execution: { command: "node", cwd: "." },
	verification: { requiredOutputs: [] },
};

async function loadDeps() {
	const { createBuildplaneStorage } = await import(
		"../../packages/storage/src/index.ts"
	);
	const { createGitWorktreeAdapter } = await import(
		"../../packages/adapters-git/src/index.ts"
	);
	const { createBuildplaneOrchestrator } = await import(
		"../../packages/kernel/src/index.ts"
	);
	const { createOperatorDecisionPort } = await import(
		"../../apps/cli/src/ledger-operator-decision.ts"
	);
	const { createRunCompletionPort } = await import(
		"../../apps/cli/src/ledger-run-completed.ts"
	);
	return {
		createBuildplaneStorage,
		createGitWorktreeAdapter,
		createBuildplaneOrchestrator,
		createOperatorDecisionPort,
		createRunCompletionPort,
	};
}

describe.sequential("recordOperatorDecision — signed run_completed (M6-S7)", () => {
	let env: Env;
	let originalHome: string | undefined;
	let originalNativeBin: string | undefined;

	beforeEach(async () => {
		env = await makeEnv();
		originalHome = process.env.HOME;
		originalNativeBin = process.env.BUILDPLANE_NATIVE_BIN;
		process.env.HOME = env.home;
		process.env.BUILDPLANE_NATIVE_BIN = resolveNativeBinaryForLedgerTests();
	});

	afterEach(async () => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalNativeBin === undefined)
			delete process.env.BUILDPLANE_NATIVE_BIN;
		else process.env.BUILDPLANE_NATIVE_BIN = originalNativeBin;
		await env.cleanup();
	});

	it("emits a kernel-signed run_completed(passed) after an approved merge, counts as strings", async () => {
		const {
			createBuildplaneStorage,
			createGitWorktreeAdapter,
			createBuildplaneOrchestrator,
			createOperatorDecisionPort,
			createRunCompletionPort,
		} = await loadDeps();

		const storage = createBuildplaneStorage(env.dir);
		storage.initializeProject();
		const workspace = createGitWorktreeAdapter();

		const baseHead = git(env.dir, ["rev-parse", "HEAD"]).stdout.trim();
		const runId = "01919000-0000-7000-8000-0000000000c1";

		const run = storage.createRun(PACKET, { runId });
		const prepared = workspace.prepareWorkspace(env.dir, run.id, baseHead);
		storage.recordWorkspacePrepared(run.id, {
			path: prepared.path,
			headSha: prepared.headSha,
			sourceProjectRoot: env.dir,
		});
		writeFileSync(join(prepared.path, "FEATURE.md"), "added by run\n");
		storage.markRunRunning(run.id);
		storage.commitRunSuccessOutcome(run.id, {
			kind: "advance-run",
			outcome: "approved",
			reasons: [],
		});
		storage.recordAcceptanceShadow(run.id, "passed");

		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: env.dir,
			storage,
			runtime: {
				executePacket() {
					throw new Error("unused");
				},
			},
			policy: {
				evaluateRun() {
					return { kind: "advance-run", outcome: "approved", reasons: [] };
				},
			},
			workspace,
			admissionStore: null,
			operatorDecisionPort: createOperatorDecisionPort(env.dir),
			runCompletionPort: createRunCompletionPort(env.dir),
		});

		await orchestrator.recordOperatorDecision({
			runId: run.id,
			decision: "approved",
			subject: "merge",
			decidedBy: "operator:khall",
			decidedAt: "2026-06-23T00:00:00Z",
		});

		// The real merge happened (write-ahead ordering: run_completed lands AFTER it).
		expect(git(env.dir, ["log", "--oneline"]).stdout).toContain(
			`merge buildplane run ${run.id}`,
		);

		const { rows, signatures } = await readRunCompleted(env.eventsDbPath);
		expect(rows).toHaveLength(1);
		const payload = JSON.parse(rows[0].payload).RunCompletedV1;
		expect(payload.outcome).toBe("passed");
		// A3 — the U64-hazard counts are strings on the wire.
		expect(typeof payload.duration_ms).toBe("string");
		expect(typeof payload.event_count).toBe("string");
		expect(typeof payload.unit_count).toBe("string");
		expect(Number.isInteger(Number(payload.duration_ms))).toBe(true);
		expect(Number(payload.duration_ms)).toBeGreaterThanOrEqual(0);

		const sig = signatures.find((s) => s.event_id === rows[0].id);
		expect(sig?.actor_id).toBe("kernel");
		expect(sig?.key_id).toBe("kernel-main");
		expect(sig?.algorithm).toBe("ed25519");
	});

	it("emits run_completed(failed) after a rejected (quarantined) merge", async () => {
		const {
			createBuildplaneStorage,
			createGitWorktreeAdapter,
			createBuildplaneOrchestrator,
			createOperatorDecisionPort,
			createRunCompletionPort,
		} = await loadDeps();

		const storage = createBuildplaneStorage(env.dir);
		storage.initializeProject();
		const workspace = createGitWorktreeAdapter();
		const baseHead = git(env.dir, ["rev-parse", "HEAD"]).stdout.trim();
		const runId = "01919000-0000-7000-8000-0000000000c2";

		const run = storage.createRun(PACKET, { runId });
		const prepared = workspace.prepareWorkspace(env.dir, run.id, baseHead);
		storage.recordWorkspacePrepared(run.id, {
			path: prepared.path,
			headSha: prepared.headSha,
			sourceProjectRoot: env.dir,
		});
		writeFileSync(join(prepared.path, "FEATURE.md"), "added by run\n");
		storage.markRunRunning(run.id);
		storage.commitRunSuccessOutcome(run.id, {
			kind: "advance-run",
			outcome: "approved",
			reasons: [],
		});
		storage.recordAcceptanceShadow(run.id, "passed");

		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: env.dir,
			storage,
			runtime: {
				executePacket() {
					throw new Error("unused");
				},
			},
			policy: {
				evaluateRun() {
					return { kind: "advance-run", outcome: "approved", reasons: [] };
				},
			},
			workspace,
			admissionStore: null,
			operatorDecisionPort: createOperatorDecisionPort(env.dir),
			runCompletionPort: createRunCompletionPort(env.dir),
		});

		await orchestrator.recordOperatorDecision({
			runId: run.id,
			decision: "rejected",
			subject: "merge",
			decidedBy: "operator:khall",
			decidedAt: "2026-06-23T00:00:00Z",
		});

		// No merge commit landed on quarantine.
		expect(git(env.dir, ["log", "--oneline"]).stdout).not.toContain(
			`merge buildplane run ${run.id}`,
		);

		const { rows } = await readRunCompleted(env.eventsDbPath);
		expect(rows).toHaveLength(1);
		expect(JSON.parse(rows[0].payload).RunCompletedV1.outcome).toBe("failed");
	});

	it("emits NO run_completed for a non-terminal resume+approved decision", async () => {
		const {
			createBuildplaneStorage,
			createGitWorktreeAdapter,
			createBuildplaneOrchestrator,
			createOperatorDecisionPort,
			createRunCompletionPort,
		} = await loadDeps();

		const storage = createBuildplaneStorage(env.dir);
		storage.initializeProject();
		const workspace = createGitWorktreeAdapter();
		const runId = "01919000-0000-7000-8000-0000000000c3";

		const run = storage.createRun(PACKET, { runId });
		storage.markRunRunning(run.id);
		storage.suspendRun(run.id);

		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: env.dir,
			storage,
			runtime: {
				executePacket() {
					throw new Error("unused");
				},
			},
			policy: {
				evaluateRun() {
					return { kind: "advance-run", outcome: "approved", reasons: [] };
				},
			},
			workspace,
			admissionStore: null,
			operatorDecisionPort: createOperatorDecisionPort(env.dir),
			runCompletionPort: createRunCompletionPort(env.dir),
		});

		await orchestrator.recordOperatorDecision({
			runId: run.id,
			decision: "approved",
			subject: "resume",
			decidedBy: "operator:khall",
			decidedAt: "2026-06-23T00:00:00Z",
		});

		// resume+approved re-dispatches (→ pending): not a run completion.
		const { rows } = await readRunCompleted(env.eventsDbPath);
		expect(rows).toHaveLength(0);
	});
});
