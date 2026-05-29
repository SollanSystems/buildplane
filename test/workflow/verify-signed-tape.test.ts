import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCRIPT = join(ROOT, "scripts", "verify-signed-tape.mjs");
const VALID = join(ROOT, "test", "fixtures", "signed-tape", "valid");

interface ExecResult {
	status: number;
	stdout: string;
}

function runVerifier(fixtureDir: string): ExecResult {
	try {
		const stdout = execFileSync("node", [SCRIPT, "--fixture", fixtureDir], {
			encoding: "utf8",
		});
		return { status: 0, stdout };
	} catch (err) {
		const e = err as { status?: number; stdout?: Buffer | string };
		return {
			status: typeof e.status === "number" ? e.status : 1,
			stdout: e.stdout ? e.stdout.toString() : "",
		};
	}
}

function loadValidTape(): any {
	return JSON.parse(readFileSync(join(VALID, "tape.json"), "utf8"));
}

function writeTempFixture(tape: any): string {
	const dir = mkdtempSync(join(tmpdir(), "signed-tape-"));
	writeFileSync(join(dir, "tape.json"), JSON.stringify(tape));
	return dir;
}

describe("verify-signed-tape", () => {
	it("verifies a valid signed tape (exit 0)", () => {
		const result = runVerifier(VALID);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("OK: signed tape verified");
	});

	it("rejects a tampered event payload (exit 1, hash_mismatch)", () => {
		const result = runVerifier(
			join(ROOT, "test", "fixtures", "signed-tape", "tampered"),
		);
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("hash_mismatch");
	});

	it("rejects a checkpoint with a bad tape root (exit 1, root_mismatch)", () => {
		const result = runVerifier(
			join(ROOT, "test", "fixtures", "signed-tape", "bad-root"),
		);
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("root_mismatch");
	});

	it("rejects a bad signature (exit 1, bad_signature)", () => {
		const tape = loadValidTape();
		const sig: string = tape.events[0].signature.signature;
		tape.events[0].signature.signature =
			sig[0] === "A" ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
		const result = runVerifier(writeTempFixture(tape));
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("bad_signature");
	});

	it("rejects a tape with no trusted key (exit 1, missing_key)", () => {
		const tape = loadValidTape();
		tape.trusted_keys = [];
		const result = runVerifier(writeTempFixture(tape));
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("missing_key");
	});
});
