import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { makeLedgerFixture } from "./fixtures.js";

describe("backpressure stress", () => {
	it("emits 10_000 events with no loss and bounded queue depth", async () => {
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
			// Use a distinct base prefix to avoid collisions with rootId
			// ("01919000-0000-7000-8000-000000000100"). Loop IDs go from
			// 01919000-0000-7000-8000-000001000000 upward.
			const baseId = "01919000-0000-7000-8000-000001";
			let maxDepth = 0;
			for (let i = 0; i < N; i++) {
				const id = `${baseId}${i.toString(16).padStart(6, "0")}`;
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
				if (i % 500 === 0) {
					const depth = fixture.emitter.stats().queueDepth;
					if (depth > maxDepth) maxDepth = depth;
				}
			}
			await fixture.emitter.close();

			const dbPath = join(fixture.dir, ".buildplane", "ledger", "events.db");
			const db = new DatabaseSync(dbPath);
			const count = db.prepare("SELECT COUNT(*) as c FROM events").get() as {
				c: number;
			};
			expect(count.c).toBe(N + 1);
			db.close();
			expect(maxDepth).toBeLessThanOrEqual(1024 + 16);
		} finally {
			await fixture.cleanup().catch(() => {});
		}
	}, 60_000);
});
