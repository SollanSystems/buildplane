import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { makeLedgerFixture } from "./fixtures.js";

describe("crash recovery", () => {
	it("onFailure fires when ledger is SIGKILLed and state.db is consistent", async () => {
		const fixture = await makeLedgerFixture();
		try {
			const failures: unknown[] = [];
			fixture.emitter.onFailure((f) => failures.push(f));

			const id1 = "01919000-0000-7000-8000-000000000020";
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
				{ id: id1 },
			);
			await new Promise((r) => setTimeout(r, 50));

			fixture.child.kill("SIGKILL");
			await new Promise((r) => setTimeout(r, 100));

			expect(failures.length).toBeGreaterThanOrEqual(1);
			const f = failures[0] as { kind: string; exitCode: number | null };
			expect(f.kind).toBe("exit");

			const dbPath = join(fixture.dir, ".buildplane", "ledger", "events.db");
			const db = new DatabaseSync(dbPath);
			const ok = db.prepare("PRAGMA integrity_check").all() as {
				integrity_check: string;
			}[];
			expect(ok[0].integrity_check).toBe("ok");
			db.close();
		} finally {
			await fixture.cleanup().catch(() => {});
		}
	}, 15_000);
});
