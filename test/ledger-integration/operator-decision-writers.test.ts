/**
 * REGRESSION PIN — the two operator-decision-path signed-tape writers cannot
 * append. This file records what IS true; it does not assert what SHOULD be
 * true.
 *
 * WHY THESE WRITERS CANNOT APPEND
 * -------------------------------
 * `createOperatorDecisionPort` (`apps/cli/src/ledger-operator-decision.ts`) and
 * `createRunCompletionPort` (`apps/cli/src/ledger-run-completed.ts`) each spawn
 * their own `ledger serve --sign` subprocess and append
 * `operator_decision_recorded` / `run_completed` through the GENERIC ingest
 * endpoint. `native/crates/bp-ledger/src/serve.rs`
 * `reject_caller_supplied_authority_event` carries a second denylist that is
 * applied whenever the append is signed (serve.rs:731-733,
 * `matches!(signing, SigningConfig::Signed { .. })`), and both of those kinds are
 * on it (`EventKind::OperatorDecisionRecorded` serve.rs:324,
 * `EventKind::RunCompleted` serve.rs:309). So every call to either port throws.
 *
 * They are NO LONGER DEFAULT-WIRED. Both were, until the surface was retired by
 * operator decision (2026-08-15): `loadCliOrchestrator` now supplies
 * `createRetiredOperatorDecisionPort()` / `createRetiredRunCompletionPort()`
 * (`apps/cli/src/retired-decision-ports.ts`), so `bp web`
 * `POST /api/runs/:runId/decision` answers an explicit HTTP 501 with a stated
 * reason instead of the opaque 500 this rejection used to produce. These two
 * ports are therefore no longer on any live path — which is exactly why this
 * file must keep driving them DIRECTLY: it is the only remaining check that the
 * native rejection they were retired for is still real.
 *
 * VERBATIM REJECTION (the native error control line, surfaced through the
 * emitter's failure path into the rejected `flush()`):
 *
 *   caller_supplied_authority_event: caller-supplied signed authority event
 *   operator_decision_recorded is rejected: the generic signed ingest endpoint
 *   cannot bless workflow lifecycle or decision records
 *
 * IT FAILS CLOSED. serve.rs rejects BEFORE `store.append_signed_with_checkpoint`,
 * so no event is persisted; and in the orchestrator the shadow row
 * (`orchestrator.ts:5011`) and the side effect (`:5022`) both sit AFTER the
 * throwing await (`:5006`), so there is no false evidence and no partial merge.
 * The empty-tape assertions below pin exactly that property — it is what made
 * the break tolerable rather than corrupting, and it is what the retirement
 * preserves.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Commit `a53519b` introduced both denylists and deleted 15 ledger-integration
 * test files, three of which (operator-decision-merge, operator-decision-resume,
 * run-completed-emit) were the ONLY coverage of these two writers. After that
 * commit ZERO tests referenced `createOperatorDecisionPort` or
 * `createRunCompletionPort`, and the surviving mission-control router test mocks
 * the broken orchestrator method (`mission-control-server/test/router.test.ts:56`),
 * so nothing anywhere would notice this break.
 *
 * RESOLVED 2026-08-15 (it was UNRESOLVED when this file landed — nothing in
 * `a53519b`, its changeset, or the trust-spine docs took a position): the
 * operator retired the `bp web` decision write surface rather than repairing it.
 * See `docs/operations/trust-spine-compatibility-matrix.md`. Retirement did NOT
 * change these two ports or the native denylist; it stopped wiring them.
 *
 * A FUTURE FIX MUST UPDATE THIS TEST, NOT DELETE IT. If a live operator-decision
 * write path is ever restored — necessarily through a dedicated native control
 * that mints these records from verified state, never by removing a kind from
 * the denylist — this file must be rewritten to assert the new success path (and
 * to keep the fail-closed pin). Deleting it re-creates the exact blind spot
 * `a53519b` created.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOperatorDecisionPort } from "../../apps/cli/src/ledger-operator-decision.js";
import { createRunCompletionPort } from "../../apps/cli/src/ledger-run-completed.js";
import { resolveNativeBinaryForLedgerTests } from "./fixtures.js";

const OPERATOR_DECISION_RUN_ID = "01919000-0000-7000-8000-0000000000d1";
const RUN_COMPLETED_RUN_ID = "01919000-0000-7000-8000-0000000000d2";

const DENYLIST_REASON = /cannot bless workflow lifecycle or decision records/;

/**
 * Both ports resolve the kernel signing key from `$HOME/.buildplane/keys`
 * (`ledger-emit.ts` `kernelSigningKeyPath`) and spawn their subprocess WITHOUT
 * an explicit `env`, so the child inherits `process.env`. Seeding an isolated
 * HOME with a raw 32-byte Ed25519 seed — the technique `makeLedgerFixture({
 * sign: true })` uses — therefore makes both the parent precondition check and
 * the child's key resolution hermetic: the developer's real `~/.buildplane/keys`
 * is never read and never written.
 *
 * `process.env` mutation is process-global, so these tests must not run
 * concurrently with each other. Vitest's default (worker-per-file, sequential
 * tests within a file) satisfies that; do not mark them `concurrent`.
 */
async function withIsolatedSigningHome<T>(
	body: (workspace: string) => Promise<T>,
): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "bp-decision-writers-"));
	const home = join(dir, "home");
	const workspace = join(dir, "workspace");
	mkdirSync(workspace, { recursive: true });
	const keyDir = join(home, ".buildplane", "keys", "kernel");
	mkdirSync(keyDir, { recursive: true });
	writeFileSync(join(keyDir, "kernel-main.ed25519"), randomBytes(32));

	const nativeBinary = resolveNativeBinaryForLedgerTests();
	const originalHome = process.env.HOME;
	const originalUserProfile = process.env.USERPROFILE;
	const originalNativeBin = process.env.BUILDPLANE_NATIVE_BIN;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.BUILDPLANE_NATIVE_BIN = nativeBinary;
	try {
		return await body(workspace);
	} finally {
		restoreEnv("HOME", originalHome);
		restoreEnv("USERPROFILE", originalUserProfile);
		restoreEnv("BUILDPLANE_NATIVE_BIN", originalNativeBin);
		await rm(dir, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 100,
		});
	}
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

function ledgerEventsDbPath(workspace: string): string {
	return join(workspace, ".buildplane", "ledger", "events.db");
}

function ledgerStoreExists(workspace: string): boolean {
	return existsSync(ledgerEventsDbPath(workspace));
}

/**
 * Every event kind persisted for `runId`, or `[]` when nothing was written.
 *
 * Note the retry: on rejection both ports `kill("SIGTERM")` their ledger child
 * and throw WITHOUT awaiting its exit, so the subprocess can still hold the
 * SQLite lock when the assertion runs — a read straight after the rejection
 * intermittently throws `database is locked`. Retrying only that condition
 * keeps the assertion about the tape's contents rather than about teardown
 * timing; any other sqlite error still fails the test.
 */
async function persistedEventKinds(
	workspace: string,
	runId: string,
): Promise<string[]> {
	const eventsDbPath = ledgerEventsDbPath(workspace);
	if (!existsSync(eventsDbPath)) {
		return [];
	}
	const { DatabaseSync } = await import("node:sqlite");
	const deadline = Date.now() + 15_000;
	for (;;) {
		try {
			return readEventKinds(DatabaseSync, eventsDbPath, runId);
		} catch (error) {
			if (
				!String(error).includes("database is locked") ||
				Date.now() >= deadline
			) {
				throw error;
			}
			await new Promise((settle) => setTimeout(settle, 50));
		}
	}
}

function readEventKinds(
	DatabaseSync: typeof import("node:sqlite").DatabaseSync,
	eventsDbPath: string,
	runId: string,
): string[] {
	const db = new DatabaseSync(eventsDbPath, { readOnly: true });
	try {
		const table = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='events'",
			)
			.get() as { name: string } | undefined;
		if (!table) {
			return [];
		}
		const rows = db
			.prepare("SELECT kind FROM events WHERE run_id = ? ORDER BY id")
			.all(runId) as Array<{ kind: string }>;
		return rows.map((row) => row.kind);
	} finally {
		db.close();
	}
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
	const outcome = await promise.then(
		() => undefined,
		(error: unknown) => error,
	);
	if (outcome === undefined) {
		throw new Error("expected the writer to reject, but it resolved");
	}
	expect(outcome).toBeInstanceOf(Error);
	return outcome as Error;
}

describe("operator-decision-path signed-tape writers (currently rejected)", () => {
	it("createOperatorDecisionPort is rejected by the signed generic-ingest denylist and writes nothing", async () => {
		await withIsolatedSigningHome(async (workspace) => {
			const port = createOperatorDecisionPort(workspace);

			const error = await rejectionOf(
				port.recordDecision({
					runId: OPERATOR_DECISION_RUN_ID,
					decision: "approved",
					subject: "merge",
					decidedBy: "operator:regression-pin",
					decidedAt: "2026-07-31T00:00:00Z",
				}),
			);

			expect(error.message).toContain(
				"operator-decision: failed to append signed operator_decision_recorded",
			);
			expect(error.message).toContain("caller_supplied_authority_event");
			expect(error.message).toContain(
				"caller-supplied signed authority event operator_decision_recorded is rejected",
			);
			expect(error.message).toMatch(DENYLIST_REASON);

			// Non-vacuity guard: the signed subprocess really did start and create
			// its store (the handshake succeeded, and `events` is created at
			// startup), so the emptiness assertion below is about the rejection
			// rather than about nothing having run.
			expect(ledgerStoreExists(workspace)).toBe(true);

			// Fail-closed: serve.rs rejects before the append, so the tape stays empty.
			expect(
				await persistedEventKinds(workspace, OPERATOR_DECISION_RUN_ID),
			).toEqual([]);
		});
	}, 60_000);

	it("createRunCompletionPort is rejected by the signed generic-ingest denylist and writes nothing", async () => {
		await withIsolatedSigningHome(async (workspace) => {
			const port = createRunCompletionPort(workspace);

			const error = await rejectionOf(
				port.recordRunCompleted({
					runId: RUN_COMPLETED_RUN_ID,
					outcome: "passed",
					durationMs: "1",
					eventCount: "1",
					unitCount: "1",
				}),
			);

			expect(error.message).toContain(
				"run-completed: failed to append signed run_completed",
			);
			expect(error.message).toContain("caller_supplied_authority_event");
			expect(error.message).toContain(
				"caller-supplied signed authority event run_completed is rejected",
			);
			expect(error.message).toMatch(DENYLIST_REASON);

			expect(ledgerStoreExists(workspace)).toBe(true);

			expect(
				await persistedEventKinds(workspace, RUN_COMPLETED_RUN_ID),
			).toEqual([]);
		});
	}, 60_000);
});
