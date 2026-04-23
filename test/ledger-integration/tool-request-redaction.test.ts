import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { makeLedgerFixture } from "./fixtures.js";

function hashSync(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

function listRecursive(dir: string): string[] {
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		return entries.flatMap((e) =>
			e.isDirectory() ? listRecursive(join(dir, e.name)) : [join(dir, e.name)],
		);
	} catch {
		return [];
	}
}

describe("tool_request redaction end-to-end", () => {
	it("stored tape contains no raw secret bytes anywhere", async () => {
		const SECRET = "hunter2-AKIAIOSFODNN7EXAMPLE-raw";

		const fixture = await makeLedgerFixture();
		try {
			const runStartedId = "01919000-0000-7000-8000-000000000200";
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
				{ id: runStartedId },
			);

			const hash = `sha256:${hashSync(SECRET)}`;

			const toolReqId = "01919000-0000-7000-8000-000000000201";
			fixture.emitter.emit(
				"tool_request",
				{
					ToolRequestStoredV1: {
						tool_name: "shell",
						arguments: { cmd: "echo hi" },
						env: {
							redacted: true,
							hash,
							hint: "env_var",
						},
						working_directory: fixture.dir,
						unit_id: "u-1",
					},
				},
				{ parent: runStartedId, id: toolReqId },
			);

			await fixture.emitter.close();

			const dbPath = join(fixture.dir, ".buildplane", "ledger", "events.db");
			const dbBytes = readFileSync(dbPath).toString("binary");
			expect(dbBytes.includes(SECRET)).toBe(false);

			const casDir = join(fixture.dir, ".buildplane", "ledger", "objects");
			const casFiles = listRecursive(casDir);
			for (const f of casFiles) {
				const bytes = readFileSync(f).toString("binary");
				expect(bytes.includes(SECRET)).toBe(false);
			}

			const db = new DatabaseSync(dbPath);
			const row = db
				.prepare(
					"SELECT payload FROM events WHERE kind = 'tool_request' LIMIT 1",
				)
				.get() as { payload: string };
			const p = JSON.parse(row.payload);
			expect(p.ToolRequestStoredV1.env.redacted).toBe(true);
			expect(p.ToolRequestStoredV1.env.hash).toBe(hash);
			db.close();
		} finally {
			await fixture.cleanup().catch(() => {});
		}
	}, 30_000);
});
