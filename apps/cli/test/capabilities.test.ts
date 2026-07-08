import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type CapabilityProbeResult,
	formatUnsupportedNodeVersionMessage,
	inspectCapabilities,
	isSupportedNodeVersion,
	SUPPORTED_NODE_RANGE,
} from "../src/capabilities";

function createProbe(
	results: Record<string, CapabilityProbeResult>,
): (command: string, args: readonly string[]) => CapabilityProbeResult {
	return (command) => {
		const result = results[command];
		if (!result) {
			throw new Error(`Unexpected probe: ${command}`);
		}
		return result;
	};
}

describe("Buildplane capability primitives", () => {
	it("uses a Node 24 runtime range instead of an exact patch", () => {
		expect(SUPPORTED_NODE_RANGE).toBe(">=24.13.1 <25");
		expect(isSupportedNodeVersion("24.13.1")).toBe(true);
		expect(isSupportedNodeVersion("24.13.2")).toBe(true);
		expect(isSupportedNodeVersion("24.14.0")).toBe(true);
		expect(isSupportedNodeVersion("24.13.0")).toBe(false);
		expect(isSupportedNodeVersion("23.11.0")).toBe(false);
		expect(isSupportedNodeVersion("25.0.0")).toBe(false);
		expect(isSupportedNodeVersion("not-a-version")).toBe(false);
	});

	it("formats unsupported Node messages with the range and detected version", () => {
		expect(formatUnsupportedNodeVersionMessage("25.0.0")).toBe(
			"Buildplane requires Node >=24.13.1 <25. Detected 25.0.0.",
		);
	});

	it("reports required runtime capabilities and optional native limitations", () => {
		const report = inspectCapabilities({
			currentNodeVersion: "24.13.2",
			cwd: "/repo",
			detectNodeSqlite: () => ({
				ok: true,
				available: true,
				message: "node:sqlite import available",
			}),
			probeCommand: createProbe({
				npm: {
					ok: true,
					available: true,
					command: "npm --version",
					detected: "10.0.0",
					message: "npm 10.0.0",
				},
				git: {
					ok: true,
					available: true,
					command: "git --version",
					detected: "git version 2.49.0",
					message: "git version 2.49.0",
				},
			}),
			resolveNativeBinary: () => undefined,
			resolvePackagedNativeBinary: () => undefined,
		});

		expect(report.ok).toBe(true);
		expect(report.environment).toEqual({
			detectedNodeVersion: "24.13.2",
			supportedNodeRange: ">=24.13.1 <25",
		});
		expect(report.capabilities.map((capability) => capability.id)).toEqual([
			"node",
			"node_sqlite",
			"npm",
			"git",
			"published_run",
			"native_binary",
			"repo_local_memory",
			"published_memory",
		]);
		expect(
			report.capabilities.find((capability) => capability.id === "node"),
		).toMatchObject({
			ok: true,
			required: true,
			available: true,
			expected: ">=24.13.1 <25",
			detected: "24.13.2",
		});
		expect(
			report.capabilities.find(
				(capability) => capability.id === "published_memory",
			),
		).toMatchObject({
			ok: false,
			required: false,
			available: false,
		});
	});

	it("reports published memory only when a packaged native binary is present", () => {
		const report = inspectCapabilities({
			currentNodeVersion: "24.13.2",
			cwd: "/repo",
			detectNodeSqlite: () => ({
				ok: true,
				available: true,
				message: "node:sqlite import available",
			}),
			probeCommand: createProbe({
				npm: {
					ok: true,
					available: true,
					command: "npm --version",
					message: "10.0.0",
				},
				git: {
					ok: true,
					available: true,
					command: "git --version",
					message: "git version 2.49.0",
				},
			}),
			resolveNativeBinary: () =>
				"/pkg/vendor/native/linux-x64/buildplane-native",
			resolvePackagedNativeBinary: () =>
				"/pkg/vendor/native/linux-x64/buildplane-native",
		});

		expect(
			report.capabilities.find(
				(capability) => capability.id === "published_memory",
			),
		).toMatchObject({
			ok: true,
			required: false,
			available: true,
			detected: "/pkg/vendor/native/linux-x64/buildplane-native",
		});
	});

	it("does not treat an explicit native binary as published memory", () => {
		const report = inspectCapabilities({
			currentNodeVersion: "24.13.2",
			cwd: "/repo",
			detectNodeSqlite: () => ({
				ok: true,
				available: true,
				message: "node:sqlite import available",
			}),
			probeCommand: createProbe({
				npm: {
					ok: true,
					available: true,
					command: "npm --version",
					message: "10.0.0",
				},
				git: {
					ok: true,
					available: true,
					command: "git --version",
					message: "git version 2.49.0",
				},
			}),
			resolveNativeBinary: () => "/tmp/buildplane-native",
			resolvePackagedNativeBinary: () => undefined,
		});

		expect(
			report.capabilities.find(
				(capability) => capability.id === "native_binary",
			),
		).toMatchObject({ available: true });
		expect(
			report.capabilities.find(
				(capability) => capability.id === "published_memory",
			),
		).toMatchObject({
			ok: false,
			required: false,
			available: false,
		});
	});

	it("discovers buildplane-native from PATH when local target paths are absent", () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "buildplane-capability-path-"));
		try {
			const fakeNative = join(
				tempRoot,
				process.platform === "win32"
					? "buildplane-native.exe"
					: "buildplane-native",
			);
			writeFileSync(fakeNative, "#!/usr/bin/env sh\nexit 0\n");
			try {
				chmodSync(fakeNative, 0o755);
			} catch {
				// Ignore chmod failures on non-POSIX environments.
			}

			const report = inspectCapabilities({
				currentNodeVersion: "24.13.2",
				cwd: join(tempRoot, "repo-without-native-target"),
				env: { PATH: tempRoot, Path: tempRoot },
				detectNodeSqlite: () => ({
					ok: true,
					available: true,
					message: "node:sqlite import available",
				}),
				probeCommand: createProbe({
					npm: {
						ok: true,
						available: true,
						command: "npm --version",
						message: "10.0.0",
					},
					git: {
						ok: true,
						available: true,
						command: "git --version",
						message: "git version 2.49.0",
					},
				}),
				resolvePackagedNativeBinary: () => undefined,
			});

			expect(
				report.capabilities.find(
					(capability) => capability.id === "native_binary",
				),
			).toMatchObject({
				available: true,
				detected: fakeNative,
			});
			expect(
				report.capabilities.find(
					(capability) => capability.id === "repo_local_memory",
				),
			).toMatchObject({ available: true });
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	it("warns that the published native binary is linux-x64-only on other platforms", () => {
		const report = inspectCapabilities({
			currentNodeVersion: "24.13.2",
			cwd: "/repo",
			platform: "darwin",
			arch: "arm64",
			detectNodeSqlite: () => ({
				ok: true,
				available: true,
				message: "node:sqlite import available",
			}),
			probeCommand: createProbe({
				npm: {
					ok: true,
					available: true,
					command: "npm --version",
					message: "10.0.0",
				},
				git: {
					ok: true,
					available: true,
					command: "git --version",
					message: "git version 2.49.0",
				},
			}),
			resolveNativeBinary: () => undefined,
			resolvePackagedNativeBinary: () => undefined,
		});

		expect(
			report.notes.some(
				(note) =>
					note.includes("linux-x64 only") && note.includes("darwin-arm64"),
			),
		).toBe(true);
		expect(
			report.capabilities.find(
				(capability) => capability.id === "published_memory",
			)?.message,
		).toContain("darwin-arm64");
	});

	it("emits no platform packaging warning on linux-x64", () => {
		const report = inspectCapabilities({
			currentNodeVersion: "24.13.2",
			cwd: "/repo",
			platform: "linux",
			arch: "x64",
			detectNodeSqlite: () => ({
				ok: true,
				available: true,
				message: "node:sqlite import available",
			}),
			probeCommand: createProbe({
				npm: {
					ok: true,
					available: true,
					command: "npm --version",
					message: "10.0.0",
				},
				git: {
					ok: true,
					available: true,
					command: "git --version",
					message: "git version 2.49.0",
				},
			}),
			resolveNativeBinary: () => undefined,
			resolvePackagedNativeBinary: () => undefined,
		});

		expect(report.notes.some((note) => note.includes("linux-x64 only"))).toBe(
			false,
		);
	});

	it("fails the capability report when a required feature is missing", () => {
		const report = inspectCapabilities({
			currentNodeVersion: "24.13.2",
			cwd: "/repo",
			detectNodeSqlite: () => ({
				ok: false,
				available: false,
				message: "node:sqlite import failed",
			}),
			probeCommand: createProbe({
				npm: {
					ok: true,
					available: true,
					command: "npm --version",
					message: "10.0.0",
				},
				git: {
					ok: true,
					available: true,
					command: "git --version",
					message: "git version 2.49.0",
				},
			}),
			resolveNativeBinary: () => undefined,
			resolvePackagedNativeBinary: () => undefined,
		});

		expect(report.ok).toBe(false);
		expect(
			report.capabilities.find((capability) => capability.id === "node_sqlite"),
		).toMatchObject({
			ok: false,
			required: true,
			available: false,
		});
	});
});
