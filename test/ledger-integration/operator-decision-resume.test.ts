import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveNativeBinaryForLedgerTests } from "./fixtures.ts";

// M5-S4b: recordOperatorDecision({subject:"resume"}) over the REAL signed ledger +
// real storage, closing SC1(2a)'s Flow-1 (suspended-run) half. The merge test
// (operator-decision-merge.test.ts) covers Flow 3 only; the spec requires BOTH a
// suspended run AND a completed-accepted run driven through recordOperatorDecision
// at the ledger-integration level ("neither alone is sufficient"). Asserts: (a) the
// signed operator_decision_recorded(subject=resume) lands in events.db and verifies
// under the kernel key, (b) the run reaches the resumed state (status=pending) with
// exactly one run-resumed state event, and (c) a crash between flush-ack and the
// approveRun side effect re-drives to exactly-once on resume. Mirrors the merge
// test harness: a kernel ed25519 seed under a temp HOME drives `serve --sign`; no
// process.chdir.

interface ResumeEnv {
	dir: string;
	home: string;
	eventsDbPath: string;
	stateDbPath: string;
	cleanup: () => Promise<void>;
}

function git(cwd: string, args: string[]): { stdout: string } {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	}
	return { stdout: r.stdout };
}

async function makeResumeEnv(): Promise<ResumeEnv> {
	const dir = await mkdtemp(join(tmpdir(), "bp-opdec-resume-ws-"));
	const home = await mkdtemp(join(tmpdir(), "bp-opdec-resume-home-"));
	const keyDir = join(home, ".buildplane", "keys", "kernel");
	mkdirSync(keyDir, { recursive: true });
	writeFileSync(join(keyDir, "kernel-main.ed25519"), Buffer.alloc(32, 9));

	// Real git repo with one base commit. Resume needs no workspace, but the
	// orchestrator constructor still requires a workspace adapter rooted in a repo.
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
		stateDbPath: join(dir, ".buildplane", "state.db"),
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

// Read the Tier-1 state store (distinct from the signed ledger): run status + a
// count of run-lifecycle events by kind, for the exactly-once resume proof.
async function readState(stateDbPath: string): Promise<{
	runStatus: (runId: string) => string | undefined;
	countKind: (kind: string) => number;
}> {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(stateDbPath, { readOnly: true });
	try {
		const runs = db.prepare("SELECT id, status FROM runs").all() as unknown as {
			id: string;
			status: string;
		}[];
		const events = db.prepare("SELECT kind FROM events").all() as unknown as {
			kind: string;
		}[];
		return {
			runStatus: (runId) => runs.find((r) => r.id === runId)?.status,
			countKind: (kind) => events.filter((e) => e.kind === kind).length,
		};
	} finally {
		db.close();
	}
}

const PACKET = {
	unit: {
		id: "resume-unit",
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

describe.sequential("recordOperatorDecision resume — signed tape + suspended-run side effect", () => {
	let env: ResumeEnv;
	let originalHome: string | undefined;
	let originalNativeBin: string | undefined;

	beforeEach(async () => {
		env = await makeResumeEnv();
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

	it("resumes a suspended run and records a kernel-signed decision on the tape", async () => {
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

		const runId = "01919000-0000-7000-8000-0000000000cc";

		// Drive a run to suspended (Flow 1): pending → running → suspended
		// (the policy-gate `trustGates.requiresApproval` state). No workspace.
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
		});

		await orchestrator.recordOperatorDecision({
			runId: run.id,
			decision: "approved",
			subject: "resume",
			decidedBy: "operator:khall",
			decidedAt: "2026-06-28T00:00:00Z",
		});

		// (a) the signed operator_decision_recorded(subject=resume) is on the tape.
		const { decisions, signatures } = await readTape(env.eventsDbPath);
		expect(decisions).toHaveLength(1);
		const payload = JSON.parse(decisions[0].payload).OperatorDecisionRecordedV1;
		expect(payload.run_id).toBe(run.id);
		expect(payload.subject).toBe("resume");
		expect(payload.decision).toBe("approved");
		// A resume decision never carries a merge commit.
		expect(payload.merge_commit ?? null).toBeNull();

		// (b) it verifies under the kernel key.
		const sig = signatures.find((s) => s.event_id === decisions[0].id);
		expect(sig?.actor_id).toBe("kernel");
		expect(sig?.key_id).toBe("kernel-main");
		expect(sig?.algorithm).toBe("ed25519");

		// (c) the run reached the resumed state with EXACTLY ONE run-resumed event,
		//     and the execution marker is set.
		const state = await readState(env.stateDbPath);
		expect(state.runStatus(run.id)).toBe("pending");
		expect(state.countKind("run-resumed")).toBe(1);
		expect(storage.isOperatorDecisionExecuted(run.id)).toBe(true);
	});

	// M5-S4 D2 — crash-after-side-effect-before-marker on the resume path. The
	// approveRun transition COMMITTED (status now pending) but the executed marker
	// write was lost. The reconciler must re-drive to exactly-once: real
	// `approveRun` THROWS on a non-suspended run, so an unguarded re-drive would
	// throw and append a second `run-resumed`. A unit fake cannot prove the real
	// store's status guard — this drives the REAL store.
	it("re-drives exactly-once on resume when the marker is lost after approveRun", async () => {
		const { createBuildplaneStorage } = await import(
			"../../packages/storage/src/index.ts"
		);
		const { createGitWorktreeAdapter } = await import(
			"../../packages/adapters-git/src/index.ts"
		);
		const { createBuildplaneOrchestrator } = await import(
			"../../packages/kernel/src/index.ts"
		);

		const storage = createBuildplaneStorage(env.dir);
		storage.initializeProject();
		const workspace = createGitWorktreeAdapter();

		const runId = "01919000-0000-7000-8000-0000000000dd";

		const run = storage.createRun(PACKET, { runId });
		storage.markRunRunning(run.id);
		storage.suspendRun(run.id);

		// Simulate the crash window: the decision was signed + Tier-1 shadowed and
		// the approveRun side effect COMMITTED, but the executed marker write was
		// lost (decided-but-unexecuted).
		storage.recordOperatorDecisionShadow({
			runId: run.id,
			decision: "approved",
			subject: "resume",
			decidedBy: "operator:khall",
			decidedAt: "2026-06-28T00:00:00Z",
		});
		storage.approveRun(run.id);
		expect(storage.isOperatorDecisionExecuted(run.id)).toBe(false);
		expect((await readState(env.stateDbPath)).countKind("run-resumed")).toBe(1);

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
			// No port needed: the reconciler completes an already-signed decision.
			operatorDecisionPort: { async recordDecision() {} },
		});

		// approveRun already ran (status pending). A re-drive that re-called
		// approveRun would THROW; recoverPendingDecisions must skip the transition.
		await expect(
			orchestrator.recoverPendingDecisions(),
		).resolves.toBeUndefined();

		const state = await readState(env.stateDbPath);
		// EXACTLY ONE run-resumed event — no double-apply.
		expect(state.countKind("run-resumed")).toBe(1);
		expect(state.runStatus(run.id)).toBe("pending");
		// The reconciler healed the window by writing the marker.
		expect(storage.isOperatorDecisionExecuted(run.id)).toBe(true);
	});
});
