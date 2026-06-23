import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { provisionWorktreeDeps } from "../src/run-cli.js";

let workDir: string;
let binDir: string;
let originalPath: string | undefined;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "bp-gap3-provision-"));
	binDir = mkdtempSync(join(tmpdir(), "bp-gap3-bin-"));
	originalPath = process.env.PATH;
});

afterEach(() => {
	process.env.PATH = originalPath;
	rmSync(workDir, { recursive: true, force: true });
	rmSync(binDir, { recursive: true, force: true });
});

function installPnpmShim(exitCode: number, message: string): void {
	const shim = join(binDir, "pnpm");
	const redirect = exitCode === 0 ? "" : ">&2 ";
	const script = `#!/bin/sh\n${redirect}echo "${message}"\nexit ${exitCode}\n`;
	writeFileSync(shim, script, { mode: 0o755 });
	chmodSync(shim, 0o755);
	process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

describe("provisionWorktreeDeps", () => {
	it("returns without throwing when pnpm exits 0", () => {
		installPnpmShim(0, "pnpm-shim-ok");
		expect(() => provisionWorktreeDeps(workDir)).not.toThrow();
	});

	it("throws with captured stderr when pnpm exits non-zero", () => {
		installPnpmShim(1, "frozen-lockfile mismatch");
		expect(() => provisionWorktreeDeps(workDir)).toThrow(
			/pnpm install failed.*exit 1.*frozen-lockfile mismatch/s,
		);
	});

	it("throws when the worktree path does not exist (spawn error)", () => {
		installPnpmShim(0, "unreachable");
		expect(() =>
			provisionWorktreeDeps("/nonexistent-bp-gap3-dir-should-not-exist"),
		).toThrow(/pnpm install failed/);
	});
});
