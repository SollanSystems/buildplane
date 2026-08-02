/**
 * SKIPPED — blocked at the protocol level, not flaky and not unfinished.
 *
 * `plan_admitted` cannot be written to a SIGNED tape through the generic ingest
 * endpoint, by design. `native/crates/bp-ledger/src/serve.rs:251`
 * `reject_caller_supplied_authority_event` carries a denylist that includes
 * `EventKind::PlanAdmitted` (serve.rs:312), and serve.rs:729-733 applies that
 * denylist whenever the append is signed
 * (`matches!(signing, SigningConfig::Signed { .. })`).
 *
 * The exact signed-path rejection:
 *
 *   caller_supplied_authority_event: caller-supplied signed authority event
 *   plan_admitted is rejected: the generic signed ingest endpoint cannot bless
 *   workflow lifecycle or decision records
 *
 * On the unsigned path the event lands, but then
 * `node scripts/verify-signed-tape.mjs --fixture <dir>` exits 1 with
 * `event <id> [plan_admitted] -> unsigned` followed by
 * `FAIL: signed tape did not verify`. There is no third path.
 *
 * Unblocking requires a dedicated native control that mints `plan_admitted`
 * from verified state — the serve.rs comment names exactly this ("must use a
 * dedicated native control that replays and verifies the preceding evidence").
 * That is an L0 slice, not a test fix.
 *
 * WHAT THIS TEST DID PROVE before hitting the wall: on the unsigned path the
 * kernel's own `createDefaultAdmittedPlanReader` read the event back through
 * its exact-8-key parser, confirming the `{ PlanAdmittedV1: {...} }`
 * variant-wrapped payload shape is correct. A flat payload would have failed
 * there.
 *
 * The adapter discipline below is the reviewed-correct pattern and is the
 * reusable artifact: pre-mint the id with `newLedgerEventId()` (exported ONLY
 * from `packages/ledger-client/src/envelope.ts`, NOT re-exported from the
 * package index), pass it via `EmitOptions.id`, emit, `await flush()`, and
 * return the pre-minted id. Do NOT use `emitter.stats().lastAckedEventId`.
 */

import { spawnSync } from "node:child_process";
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

describe.skip("plan_admitted writer on a real signed tape", () => {
	it("lands a verifiable, correctly shaped plan_admitted event", async () => {
		const fixture = await makeLedgerFixture({ sign: true });
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
			// misnamed payload fails here rather than surviving to slice 2.
			const eventsDbPath = join(
				fixture.dir,
				".buildplane",
				"ledger",
				"events.db",
			);
			const record = await createDefaultAdmittedPlanReader().read(
				eventsDbPath,
				eventId,
			);
			expect(record).toBeDefined();
			expect(record?.authorizedNextStep).toBe(PLANFORGE_AUTHORIZED_NEXT_STEP);

			// External Ed25519 verification of the exported tape.
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
					env: { ...process.env, HOME: fixture.homeDir },
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
			expect(verified.stdout).toContain("[plan_admitted] -> verified");
			expect(verified.stdout).toContain("OK: signed tape verified");
			expect(verified.status).toBe(0);
		} finally {
			await fixture.cleanup();
		}
	}, 60_000);
});
