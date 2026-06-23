import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveNativeBinaryForLedgerTests } from "./fixtures.ts";

// M5-S4: recordOperatorDecision({subject:"merge",decision:"approved"}) over the
// REAL signed ledger + real git worktree adapter + real storage. Asserts the
// three load-bearing things the L0 ceremony checks against the tape: (a) a real
// merge commit lands in the project git log, (b) the signed
// operator_decision_recorded is present in events.db, and (c) it verifies under
// the kernel key. Mirrors operator-envelope.test.ts: a kernel ed25519 seed under
// a temp HOME drives `serve --sign`; no process.chdir.

interface MergeEnv {
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

async function makeMergeEnv(): Promise<MergeEnv> {
	const dir = await mkdtemp(join(tmpdir(), "bp-opdec-ws-"));
	const home = await mkdtemp(join(tmpdir(), "bp-opdec-home-"));
	const keyDir = join(home, ".buildplane", "keys", "kernel");
	mkdirSync(keyDir, { recursive: true });
	writeFileSync(join(keyDir, "kernel-main.ed25519"), Buffer.alloc(32, 9));

	// Real git repo with one base commit.
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

async function readTape(eventsDbPath: string): Promise<{
	decisions: { id: string; payload: string }[];
	signatures: SignatureRow[];
}> {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(eventsDbPath, { readOnly: true });
	try {
		const decisions = db
			.prepare(
				"SELECT id, payload FROM events WHERE kind = 'operator_decision_recorded'",
			)
			.all() as unknown as { id: string; payload: string }[];
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

describe.sequential("recordOperatorDecision merge — signed tape + real merge", () => {
	let env: MergeEnv;
	let originalHome: string | undefined;
	let originalNativeBin: string | undefined;

	beforeEach(async () => {
		env = await makeMergeEnv();
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

	it("merges a retained worktree and records a kernel-signed decision on the tape", async () => {
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

		const storage = createBuildplaneStorage(env.dir);
		storage.initializeProject();
		const workspace = createGitWorktreeAdapter();

		const baseHead = git(env.dir, ["rev-parse", "HEAD"]).stdout.trim();
		const runId = "01919000-0000-7000-8000-0000000000aa";

		// Seed a passed run with a retained worktree carrying a real change.
		const packet = {
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
		const run = storage.createRun(packet, { runId });
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
		});

		await orchestrator.recordOperatorDecision({
			runId: run.id,
			decision: "approved",
			subject: "merge",
			decidedBy: "operator:khall",
			decidedAt: "2026-06-23T00:00:00Z",
		});

		// (a) a REAL merge commit landed in the project git log.
		const log = git(env.dir, ["log", "--oneline"]).stdout;
		expect(log).toContain(`merge buildplane run ${run.id}`);
		const mergedHead = git(env.dir, ["rev-parse", "HEAD"]).stdout.trim();
		expect(mergedHead).not.toBe(baseHead);
		// The feature file is present on the merged main line.
		const tracked = git(env.dir, ["ls-files", "FEATURE.md"]).stdout.trim();
		expect(tracked).toBe("FEATURE.md");

		// (b) the signed operator_decision_recorded is present in events.db.
		const { decisions, signatures } = await readTape(env.eventsDbPath);
		expect(decisions).toHaveLength(1);
		const payload = JSON.parse(decisions[0].payload).OperatorDecisionRecordedV1;
		expect(payload.run_id).toBe(run.id);
		expect(payload.subject).toBe("merge");
		expect(payload.decision).toBe("approved");
		// D1: the live write-ahead path carries merge_commit=null (the merge has
		// not happened at emit time); the merge SHA is never written back into the
		// immutable signed event.
		expect(payload.merge_commit ?? null).toBeNull();

		// (c) it verifies under the kernel key.
		const sig = signatures.find((s) => s.event_id === decisions[0].id);
		expect(sig?.actor_id).toBe("kernel");
		expect(sig?.key_id).toBe("kernel-main");
		expect(sig?.algorithm).toBe("ed25519");
	});
});
