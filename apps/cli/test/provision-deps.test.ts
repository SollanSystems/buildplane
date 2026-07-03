import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	provisionWorktreeDeps,
	resolveProvisionCommand,
} from "../src/run-cli.js";

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

function installShim(name: string, exitCode: number, message: string): void {
	const shim = join(binDir, name);
	const redirect = exitCode === 0 ? "" : ">&2 ";
	const script = `#!/bin/sh\n${redirect}echo "${message}"\nexit ${exitCode}\n`;
	writeFileSync(shim, script, { mode: 0o755 });
	chmodSync(shim, 0o755);
	process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

describe("resolveProvisionCommand", () => {
	it("returns undefined when the worktree has no package.json", () => {
		expect(resolveProvisionCommand(workDir)).toBeUndefined();
	});

	it("picks pnpm --frozen-lockfile for a pnpm-lock.yaml worktree", () => {
		writeFileSync(join(workDir, "package.json"), "{}");
		writeFileSync(join(workDir, "pnpm-lock.yaml"), "lockfileVersion: 9");
		expect(resolveProvisionCommand(workDir)).toEqual({
			command: "pnpm",
			args: ["install", "--frozen-lockfile"],
		});
	});

	it("picks npm ci for a package-lock.json worktree", () => {
		writeFileSync(join(workDir, "package.json"), "{}");
		writeFileSync(join(workDir, "package-lock.json"), "{}");
		expect(resolveProvisionCommand(workDir)).toEqual({
			command: "npm",
			args: ["ci"],
		});
	});

	it("picks npm install for a lockfile-less package.json worktree (the M6 demo-repo shape)", () => {
		writeFileSync(join(workDir, "package.json"), "{}");
		// --no-package-lock: a generated lockfile would dirty the worktree and
		// retrip the run-admission worktree_clean gate.
		expect(resolveProvisionCommand(workDir)).toEqual({
			command: "npm",
			args: ["install", "--no-audit", "--no-fund", "--no-package-lock"],
		});
	});
});

describe("provisionWorktreeDeps", () => {
	it("returns without throwing when pnpm exits 0", () => {
		installShim("pnpm", 0, "pnpm-shim-ok");
		writeFileSync(join(workDir, "package.json"), "{}");
		writeFileSync(join(workDir, "pnpm-lock.yaml"), "lockfileVersion: 9");
		expect(() => provisionWorktreeDeps(workDir)).not.toThrow();
	});

	it("throws with captured stderr when pnpm exits non-zero", () => {
		installShim("pnpm", 1, "frozen-lockfile mismatch");
		writeFileSync(join(workDir, "package.json"), "{}");
		writeFileSync(join(workDir, "pnpm-lock.yaml"), "lockfileVersion: 9");
		expect(() => provisionWorktreeDeps(workDir)).toThrow(
			/pnpm install --frozen-lockfile failed.*exit 1.*frozen-lockfile mismatch/s,
		);
	});

	it("provisions a lockfile-less npm worktree via npm install", () => {
		installShim("npm", 0, "npm-shim-ok");
		writeFileSync(join(workDir, "package.json"), "{}");
		expect(() => provisionWorktreeDeps(workDir)).not.toThrow();
	});

	it("throws with captured stderr when npm exits non-zero", () => {
		installShim("npm", 1, "registry unreachable");
		writeFileSync(join(workDir, "package.json"), "{}");
		expect(() => provisionWorktreeDeps(workDir)).toThrow(
			/npm install .*failed.*exit 1.*registry unreachable/s,
		);
	});

	it("skips provisioning when the worktree has no package.json", () => {
		installShim("pnpm", 1, "should-never-run");
		installShim("npm", 1, "should-never-run");
		expect(() => provisionWorktreeDeps(workDir)).not.toThrow();
	});

	it("throws when the worktree path does not exist (spawn error)", () => {
		installShim("pnpm", 0, "unreachable");
		expect(() =>
			provisionWorktreeDeps("/nonexistent-bp-gap3-dir-should-not-exist"),
		).toThrow(/does not exist/);
	});
});
