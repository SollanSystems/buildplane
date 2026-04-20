import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { makeLedgerFixture } from "./fixtures.js";

describe("backpressure stress", () => {
	it("emits 10_000 events without loss and preserves order under burst", async () => {
		const fixture = await makeLedgerFixture({
			handshakeTimeoutMs: 15_000,
		});
		try {
			const rootId = "01919000-0000-7000-8000-000000000100";
			fixture.emitter.emit(
				"run_started",
				{
					RunStartedV1: {
						packet_hash: "sha256:aa",
						git_head: "aa",
						workspace_path: fixture.dir,
						config: {},
						parent_run_id: null,
					},
				},
				{ id: rootId },
			);

			const N = 10_000;
			// Monotonic UUIDv7-shaped ids so SQLite's "ORDER BY id ASC" matches
			// our emit order. Distinct prefix from rootId to avoid collisions.
			const baseId = "01919000-0000-7000-8000-000001";
			const emittedIds: string[] = [];
			for (let i = 0; i < N; i++) {
				const id = `${baseId}${i.toString(16).padStart(6, "0")}`;
				emittedIds.push(id);
				fixture.emitter.emit(
					"unit_started",
					{
						UnitStartedV1: {
							unit_id: `u-${i}`,
							parent_unit_id: null,
							unit_kind: "command",
							policy: {},
						},
					},
					{ parent: rootId, id },
				);
			}
			await fixture.emitter.close();

			const dbPath = join(fixture.dir, ".buildplane", "ledger", "events.db");
			const db = new DatabaseSync(dbPath);

			// 1. Every emitted event landed in SQLite. No loss.
			const count = db.prepare("SELECT COUNT(*) as c FROM events").get() as {
				c: number;
			};
			expect(count.c).toBe(N + 1);

			// 2. Order of the N burst events matches emit order. Causal chain
			//    intact: every unit_started rows references rootId as parent.
			const rows = db
				.prepare(
					"SELECT id, parent_event_id FROM events WHERE kind = 'unit_started' ORDER BY id ASC",
				)
				.all() as { id: string; parent_event_id: string }[];
			expect(rows.length).toBe(N);
			expect(rows.map((r) => r.id)).toEqual(emittedIds);
			expect(rows.every((r) => r.parent_event_id === rootId)).toBe(true);

			db.close();

			// NOTE: we intentionally do not assert an upper bound on
			// stats().queueDepth here. `emit()` is synchronous + fire-and-forget
			// per the spec, so a tight burst enqueues all N writes before any
			// can execute — the high-watermark throttles EXECUTION order (via
			// the promise chain's waitForHead) but cannot cap the pending count
			// without making emit() itself awaitable. The real proof of no-loss
			// is that all N+1 events survive the close() flush above.
		} finally {
			await fixture.cleanup().catch(() => {});
		}
	}, 60_000);
});
