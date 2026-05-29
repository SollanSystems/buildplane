import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ledgerDoc = readFileSync(
	join(process.cwd(), "docs", "ledger.md"),
	"utf8",
);

describe("ledger docs contract", () => {
	it("documents executable ledger replay syntax", () => {
		expect(ledgerDoc).toContain(
			"buildplane ledger replay --run-id <run-id> --workspace <path>",
		);
		expect(ledgerDoc).toContain("--run-id <id>");
		expect(ledgerDoc).toContain("--workspace <path>");
		expect(ledgerDoc).not.toContain("`buildplane ledger replay <run-id>`");
		expect(ledgerDoc).not.toContain(
			"buildplane ledger replay <run-id> --format",
		);
	});

	it("documents the external signed-tape verifier command", () => {
		expect(ledgerDoc).toContain("Verifying a signed tape");
		expect(ledgerDoc).toContain(
			"node scripts/verify-signed-tape.mjs --fixture <dir>",
		);
	});
});
