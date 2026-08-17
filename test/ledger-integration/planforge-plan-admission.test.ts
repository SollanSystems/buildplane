/**
 * REGRESSION PIN — the `plan_admitted` writer cannot reach a signed tape, and
 * the unsigned lane cannot make one verifiable. This file records what IS
 * true; it does not assert what SHOULD be true.
 *
 * WHY THE SIGNED PATH REJECTS
 * ---------------------------
 * `plan_admitted` cannot be written to a SIGNED tape through the generic
 * ingest endpoint, by design. `native/crates/bp-ledger/src/serve.rs`
 * `reject_caller_supplied_authority_event` carries a second denylist that is
 * applied whenever the append is signed (serve.rs:731-734,
 * `matches!(signing, SigningConfig::Signed { .. })`), and
 * `EventKind::PlanAdmitted` is on it (serve.rs:312). The exact signed-path
 * rejection, surfaced through the emitter's failure path into the rejected
 * `flush()`:
 *
 *   caller_supplied_authority_event: caller-supplied signed authority event
 *   plan_admitted is rejected: the generic signed ingest endpoint cannot bless
 *   workflow lifecycle or decision records
 *
 * IT FAILS CLOSED. serve.rs rejects BEFORE the append, so no event is
 * persisted. The empty-tape assertion below pins exactly that property.
 *
 * THERE IS NO THIRD PATH. On the unsigned path the event lands — and the
 * kernel's own `createDefaultAdmittedPlanReader` reads it back through its
 * exact-8-key parser, confirming the `{ PlanAdmittedV1: {...} }`
 * variant-wrapped payload shape is correct (a flat payload would fail there) —
 * but `node scripts/verify-signed-tape.mjs` then exits 1 with
 * `event <id> [plan_admitted] -> unsigned` followed by
 * `FAIL: signed tape did not verify`. The second test pins that lane: an
 * unsigned append can never become verifiable evidence.
 *
 * Unblocking requires a dedicated native control that mints `plan_admitted`
 * from verified state — the serve.rs comment names exactly this ("must use a
 * dedicated native control that replays and verifies the preceding
 * evidence"). That is an L0 slice, not a test fix. Until it exists,
 * `createPlanAdmissionPort` stays a QUARANTINED WRITE SURFACE (operator
 * decision 2026-08-15; see the header in
 * `apps/cli/src/plan-admission-port.ts`) with no production callers, and this
 * file is the only executing check that the native rejection it was
 * quarantined for is still real.
 *
 * A FUTURE FIX MUST UPDATE THIS TEST, NOT DELETE IT. If a live plan-admission
 * write path is ever restored — necessarily through that dedicated native
 * control, never by removing the kind from the denylist — this file must be
 * rewritten to assert the new success path (and to keep the fail-closed pin).
 *
 * ADAPTER DISCIPLINE (the reviewed-correct pattern, reused below): pre-mint
 * the id with `newLedgerEventId()` (exported ONLY from
 * `packages/ledger-client/src/envelope.ts`, NOT re-exported from the package
 * index), pass it via `EmitOptions.id`, emit, `await flush()`, and return the
 * pre-minted id. Do NOT use `emitter.stats().lastAckedEventId`.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createDefaultAdmittedPlanReader } from "@buildplane/kernel";
import type { TapeEmitter } from "@buildplane/ledger-client";
import { PLANFORGE_AUTHORIZED_NEXT_STEP } from "@buildplane/planforge";
import { describe, expect, it } from "vitest";
import {
	createPlanAdmissionPort,
	type PlanAdmissionEmitter,
} from "../../apps/cli/src/plan-admission-port.js";
import { newLedgerEventId } from "../../packages/ledger-client/src/envelope.js";
import { LEDGER_TEST_REPO_ROOT, makeLedgerFixture } from "./fixtures.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const DENYLIST_REASON = /cannot bless workflow lifecycle or decision records/;

/**
 * Concrete `PlanAdmissionEmitter` over the real `TapeEmitter`.
 *
 * `TapeEmitter.emit` is synchronous fire-and-forget and returns no id, so the
 * durable id must be pre-minted and passed in via `EmitOptions.id`. Reading it
 * back from `stats().lastAckedEventId` would be wrong: that is one mutable
 * field on a per-run emitter shared by every port, so any interleaved emit
 * yields a wrong-but-non-empty id.
 */
function createTapeBackedPlanAdmissionEmitter(
	emitter: TapeEmitter,
): PlanAdmissionEmitter {
	return {
		async emit(kind: string, payload: unknown): Promise<string> {
			const eventId = newLedgerEventId();
			emitter.emit(kind, payload, { id: eventId });
			await emitter.flush();
			return eventId;
		},
	};
}

function admissionInput(runId: string) {
	return {
		planId: `pf-plan-${runId.slice(0, 8)}`,
		planDigest: `sha256:${"a".repeat(64)}`,
		inputDigest: `sha256:${"b".repeat(64)}`,
		trustedBase: "c".repeat(40),
		decidedBy: "operator:test",
		decidedAt: "2026-07-31T00:00:00Z",
		idempotencyKey: `sha256:${"d".repeat(64)}`,
		authorizedNextStep: PLANFORGE_AUTHORIZED_NEXT_STEP,
	};
}

function ledgerEventsDbPath(workspace: string): string {
	return join(workspace, ".buildplane", "ledger", "events.db");
}

/**
 * Every event kind persisted for `runId`, or `[]` when nothing was written.
 *
 * Note the retry: on the signed rejection the serve subprocess errors out and
 * can still hold the SQLite lock when the assertion runs, so a read straight
 * after the rejection intermittently throws `database is locked`. Retrying
 * only that condition keeps the assertion about the tape's contents rather
 * than about teardown timing; any other sqlite error still fails the test.
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

describe("plan_admitted writer on a real tape (currently rejected when signed)", () => {
	// `retry: 2` absorbs one narrow flake: the native error control line on
	// stderr races the child's `exit` event inside the emitter's
	// first-failure-wins `markFailed` (emitter.ts stderr `error` handler vs the
	// childExit handler), and if exit wins, `flush()` rejects with the generic
	// `ledger exited with code 1` instead of the denylist text, failing the
	// message assertions. The retry cannot mask the regression this test pins:
	// removing `plan_admitted` from the denylist makes the emit SUCCEED, so
	// `rejectionOf` fails deterministically on every attempt.
	it("is rejected by the signed generic-ingest denylist and writes nothing", {
		retry: 2,
		timeout: 60_000,
	}, async () => {
		const fixture = await makeLedgerFixture({ sign: true });
		try {
			const port = createPlanAdmissionPort(
				createTapeBackedPlanAdmissionEmitter(fixture.emitter),
			);

			const error = await rejectionOf(
				port.recordPlanAdmission(admissionInput(fixture.runId)),
			);

			expect(error.message).toContain("caller_supplied_authority_event");
			expect(error.message).toContain(
				"caller-supplied signed authority event plan_admitted is rejected",
			);
			expect(error.message).toMatch(DENYLIST_REASON);

			// Non-vacuity guard: the signed subprocess really did launch and open
			// its store (`SqliteStore::open` creates `events` unconditionally at
			// process startup, before the handshake; and `makeLedgerFixture`
			// separately awaited a successful handshake), so the emptiness
			// assertion below is about the rejection rather than about nothing
			// having run.
			expect(existsSync(ledgerEventsDbPath(fixture.dir))).toBe(true);

			// Fail-closed: serve.rs rejects before the append, so the tape stays
			// empty.
			expect(await persistedEventKinds(fixture.dir, fixture.runId)).toEqual([]);
		} finally {
			await fixture.cleanup();
		}
	});

	it("lands on the unsigned lane but can never become verifiable evidence", async () => {
		const fixture = await makeLedgerFixture();
		try {
			const port = createPlanAdmissionPort(
				createTapeBackedPlanAdmissionEmitter(fixture.emitter),
			);

			const eventId = await port.recordPlanAdmission(
				admissionInput(fixture.runId),
			);
			expect(eventId).toMatch(UUID);

			await fixture.emitter.close();

			// Read the event back through the kernel's own reader. It demands an
			// exact 8-key `PlanAdmittedV1`-wrapped payload record, so a flat or
			// misnamed payload fails here rather than surviving unnoticed.
			const record = await createDefaultAdmittedPlanReader().read(
				ledgerEventsDbPath(fixture.dir),
				eventId,
			);
			expect(record).toBeDefined();
			expect(record?.authorizedNextStep).toBe(PLANFORGE_AUTHORIZED_NEXT_STEP);

			// Export the tape and run the external verifier: the unsigned event is
			// reported `unsigned` and the tape fails verification. This is the
			// "no third path" half of the wall — landing on the unsigned lane does
			// not produce evidence.
			const outDir = join(fixture.dir, "tape-export");
			const exported = spawnSync(
				fixture.binary,
				[
					"ledger",
					"export-signed-tape",
					"--run-id",
					fixture.runId,
					"--workspace",
					fixture.dir,
					"--out",
					outDir,
				],
				{
					cwd: LEDGER_TEST_REPO_ROOT,
					encoding: "utf8",
				},
			);
			expect(exported.stderr ?? "").toBe("");
			expect(exported.status).toBe(0);

			const verified = spawnSync(
				process.execPath,
				[
					join(LEDGER_TEST_REPO_ROOT, "scripts", "verify-signed-tape.mjs"),
					"--fixture",
					outDir,
				],
				{ cwd: LEDGER_TEST_REPO_ROOT, encoding: "utf8" },
			);
			expect(verified.stdout).toContain("[plan_admitted] -> unsigned");
			expect(verified.stdout).toContain("FAIL: signed tape did not verify");
			expect(verified.status).toBe(1);
		} finally {
			await fixture.cleanup();
		}
	}, 60_000);
});
