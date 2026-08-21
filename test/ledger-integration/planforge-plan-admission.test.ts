/**
 * REGRESSION PIN — the `plan_admitted` writer cannot reach a tape through
 * either generic-ingest lane. This file records what IS true; it does not
 * assert what SHOULD be true.
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
 * WHY THE UNSIGNED PATH REJECTS
 * -----------------------------
 * `plan_admitted` is signed-only on the wire, so it clears
 * `reject_caller_supplied_authority_event` unsigned and reaches
 * `store.append` (serve.rs:746) — which runs `validate_external_append`
 * (`native/crates/bp-ledger/src/storage/sqlite.rs`) first, and that guard's
 * always-blocked set now names `EventKind::PlanAdmitted`. The refusal is a
 * different typed error on a different layer, reported by the serve loop under
 * a different code:
 *
 *   storage_failure: caller-supplied trust-spine event plan_admitted is
 *   rejected: authority-bearing records must use a dedicated native control
 *
 * THERE IS NO THIRD PATH, and that property is now total: both lanes refuse
 * before anything is persisted, so an unsigned append can no longer produce
 * even unverifiable tape data.
 *
 * COVERAGE THIS FILE GAVE UP TO GET THAT. While the unsigned lane still landed
 * the event, the second test read it back with the kernel's own
 * `createDefaultAdmittedPlanReader`, joining the two halves of the payload
 * contract end to end: the port's emitted bytes really did satisfy the reader's
 * exact-8-key `{ PlanAdmittedV1: {...} }` parse. No lane can persist that event
 * any more, so the halves are now pinned only separately —
 * `apps/cli/test/plan-admission-port.test.ts` on the emitted payload,
 * `packages/kernel/test/admitted-plan-reader.test.ts` on the parse (from a raw
 * `INSERT`). Rejoining them is the mint control's round trip, not this file's.
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

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TapeEmitter } from "@buildplane/ledger-client";
import { PLANFORGE_AUTHORIZED_NEXT_STEP } from "@buildplane/planforge";
import { describe, expect, it } from "vitest";
import {
	createPlanAdmissionPort,
	type PlanAdmissionEmitter,
} from "../../apps/cli/src/plan-admission-port.js";
import { newLedgerEventId } from "../../packages/ledger-client/src/envelope.js";
import { makeLedgerFixture } from "./fixtures.js";

const DENYLIST_REASON = /cannot bless workflow lifecycle or decision records/;

const NATIVE_CONTROL_REASON =
	/authority-bearing records must use a dedicated native control/;

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

describe("plan_admitted writer on a real tape (rejected on both generic-ingest lanes)", () => {
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

	// Same `retry: 2` rationale as the signed case above: the native error line
	// on stderr races the child's `exit` event inside the emitter's
	// first-failure-wins `markFailed`. Removing `plan_admitted` from
	// `validate_external_append`'s always-blocked set makes the emit SUCCEED, so
	// `rejectionOf` still fails deterministically on every attempt.
	it("is rejected by the unsigned lane's storage guard and writes nothing", {
		retry: 2,
		timeout: 60_000,
	}, async () => {
		const fixture = await makeLedgerFixture();
		try {
			const port = createPlanAdmissionPort(
				createTapeBackedPlanAdmissionEmitter(fixture.emitter),
			);

			const error = await rejectionOf(
				port.recordPlanAdmission(admissionInput(fixture.runId)),
			);

			// A different layer and a different typed error from the signed case:
			// `validate_external_append` rejects after the wire guard cleared the
			// event, and the serve loop reports that as `storage_failure`.
			expect(error.message).toContain("storage_failure");
			expect(error.message).toContain(
				"caller-supplied trust-spine event plan_admitted is rejected",
			);
			expect(error.message).toMatch(NATIVE_CONTROL_REASON);

			// Non-vacuity guard, mirroring the signed case: the subprocess launched
			// and opened its store, so the emptiness assertion is about the
			// rejection rather than about nothing having run.
			expect(existsSync(ledgerEventsDbPath(fixture.dir))).toBe(true);

			// Fail-closed: the guard runs before `insert_event`, so the tape stays
			// empty on this lane too.
			expect(await persistedEventKinds(fixture.dir, fixture.runId)).toEqual([]);
		} finally {
			await fixture.cleanup();
		}
	});
});
