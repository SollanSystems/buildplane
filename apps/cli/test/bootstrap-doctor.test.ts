import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type BootstrapDoctorProbeResult,
	inspectBootstrapDoctor,
} from "../src/bootstrap-doctor";
import { SUPPORTED_NODE_VERSION } from "../src/version-guard";

const root = resolve(import.meta.dirname, "../../..");
const cliSourceEntrypoint = resolve(root, "apps/cli/src/index.ts");
const tsxLoaderEntrypoint = resolve(root, "node_modules/tsx/dist/loader.mjs");
const cleanupPaths: string[] = [];

function createProbe(
	results: Record<string, BootstrapDoctorProbeResult>,
): Parameters<typeof inspectBootstrapDoctor>[0]["probeCommand"] {
	return (command, _args) => {
		const result = results[command];
		if (!result) {
			throw new Error(`Unexpected command probe: ${command}`);
		}
		return result;
	};
}

afterEach(() => {
	for (const path of cleanupPaths.splice(0)) {
		rmSync(path, { force: true, recursive: true });
	}
});

describe("bootstrap doctor report", () => {
	it("returns a deterministic passing report when all required checks succeed", () => {
		const report = inspectBootstrapDoctor({
			currentNodeVersion: SUPPORTED_NODE_VERSION,
			probeCommand: createProbe({
				npm: {
					ok: true,
					command: "npm --version",
					detected: "10.9.0",
					message: "npm 10.9.0",
				},
				git: {
					ok: true,
					command: "git --version",
					detected: "git version 2.49.0",
					message: "git version 2.49.0",
				},
			}),
		});

		expect(report.ok).toBe(true);
		expect(report.checks.map((check) => check.id)).toEqual([
			"node",
			"npm",
			"git",
		]);
		expect(report.checks).toEqual([
			expect.objectContaining({
				id: "node",
				ok: true,
				required: true,
				expected: SUPPORTED_NODE_VERSION,
				detected: SUPPORTED_NODE_VERSION,
			}),
			expect.objectContaining({
				id: "npm",
				ok: true,
				command: "npm --version",
				detected: "10.9.0",
			}),
			expect.objectContaining({
				id: "git",
				ok: true,
				command: "git --version",
				detected: "git version 2.49.0",
			}),
		]);
		expect(report.notes).toEqual([
			"Published/global installs do not yet include a verified `buildplane memory ...` contract.",
		]);
	});

	it("returns a failing report when node mismatches or required commands are unavailable", () => {
		const report = inspectBootstrapDoctor({
			currentNodeVersion: "22.22.2",
			probeCommand: createProbe({
				npm: {
					ok: false,
					command: "npm --version",
					message: "command not available",
				},
				git: {
					ok: false,
					command: "git --version",
					message: "exited with status 127",
				},
			}),
		});

		expect(report.ok).toBe(false);
		expect(report.checks.map((check) => check.ok)).toEqual([
			false,
			false,
			false,
		]);
		expect(report.checks[0]).toEqual(
			expect.objectContaining({
				id: "node",
				expected: SUPPORTED_NODE_VERSION,
				detected: "22.22.2",
			}),
		);
		expect(report.checks[1]).toEqual(
			expect.objectContaining({
				id: "npm",
				message: "command not available",
			}),
		);
		expect(report.checks[2]).toEqual(
			expect.objectContaining({
				id: "git",
				message: "exited with status 127",
			}),
		);
	});

	it("source entrypoint runs bootstrap doctor before init without creating .buildplane", () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "buildplane-bootstrap-doctor-entry-"),
		);
		cleanupPaths.push(workspaceRoot);

		const result = spawnSync(
			process.execPath,
			[
				"--conditions",
				"source",
				"--import",
				tsxLoaderEntrypoint,
				cliSourceEntrypoint,
				"bootstrap",
				"doctor",
				"--json",
			],
			{
				cwd: workspaceRoot,
				encoding: "utf8",
			},
		);

		expect(result.stderr).toBe("");
		expect(result.status).toBe(
			process.versions.node === SUPPORTED_NODE_VERSION ? 0 : 1,
		);
		const payload = JSON.parse(result.stdout);
		expect(payload.checks.map((check: { id: string }) => check.id)).toEqual([
			"node",
			"npm",
			"git",
		]);
		expect(payload.notes).toContain(
			"Published/global installs do not yet include a verified `buildplane memory ...` contract.",
		);
		expect(existsSync(join(workspaceRoot, ".buildplane"))).toBe(false);
	});

	it("source entrypoint keeps the strict node guard for other commands when current node is unsupported", () => {
		if (process.versions.node === SUPPORTED_NODE_VERSION) {
			return;
		}
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "buildplane-bootstrap-node-guard-"),
		);
		cleanupPaths.push(workspaceRoot);

		const result = spawnSync(
			process.execPath,
			[
				"--conditions",
				"source",
				"--import",
				tsxLoaderEntrypoint,
				cliSourceEntrypoint,
				"--help",
			],
			{
				cwd: workspaceRoot,
				encoding: "utf8",
			},
		);

		expect(result.status).toBe(1);
		expect(`${result.stderr}${result.stdout}`).toContain(
			`Buildplane requires Node ${SUPPORTED_NODE_VERSION}`,
		);
	});
});
