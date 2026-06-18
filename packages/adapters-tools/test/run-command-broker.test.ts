import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CAPABILITY_BUNDLE_SCHEMA_VERSION,
	type CapabilityBundleV0,
} from "@buildplane/capability-broker";
import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../src/index";
import { runCommand } from "../src/run-command";

function commandBundle(): CapabilityBundleV0 {
	return {
		schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
		bundleId: "m6-cmd",
		tools: { run_command: { allowlist: ["node", "git"] } },
	};
}

describe("run_command capability broker (allowlist)", () => {
	function makeWorktree(): string {
		return mkdtempSync(join(tmpdir(), "bp-cmd-cap-"));
	}

	it("allows an allowlisted command", () => {
		const root = makeWorktree();
		const result = runCommand(
			{ command: "node", args: ["-e", "process.exit(0)"] },
			root,
			{ capabilityBundle: commandBundle() },
		);
		expect(result.success).toBe(true);
		expect(result.exitCode).toBe(0);
	});

	it("denies a command outside the allowlist with a broker reason, without spawning", () => {
		const root = makeWorktree();
		const result = runCommand({ command: "echo", args: ["x"] }, root, {
			capabilityBundle: commandBundle(),
		});
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/capability broker/i);
		expect(result.error).toMatch(/allowlist/i);
		// A real `echo` spawn would have exitCode 0 + stdout "x"; the deny short-circuits.
		expect(result.stdout).toBe("");
	});

	it("fires onCapabilityDenied without spawning when the broker denies", () => {
		const root = makeWorktree();
		const denied: Array<{ tool: string; target: string }> = [];
		const result = runCommand(
			{ command: "echo", args: ["hello", "world"] },
			root,
			{
				capabilityBundle: commandBundle(),
				onCapabilityDenied: (detail) => {
					denied.push({ tool: detail.tool, target: detail.target });
				},
			},
		);
		expect(result.success).toBe(false);
		expect(denied).toEqual([
			{ tool: "run_command", target: "echo hello world" },
		]);
	});

	it("fail-closes when the bundle has no run_command allowlist", () => {
		const root = makeWorktree();
		const result = runCommand({ command: "node", args: ["-v"] }, root, {
			capabilityBundle: {
				schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
				bundleId: "no-commands",
				fsWrite: ["src/**"],
				tools: { write_file: { enabled: true } },
			},
		});
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/capability broker/i);
	});

	it("registry forwards the capability bundle to run_command", () => {
		const root = makeWorktree();
		const registry = createToolRegistry(root, {
			capabilityBundle: commandBundle(),
		});
		const denied = registry.run_command({ command: "echo", args: ["x"] });
		expect(denied.success).toBe(false);
		expect(denied.error).toMatch(/capability broker/i);
	});

	it("without a bundle, only the sandbox applies (backward compatible)", () => {
		const root = makeWorktree();
		const result = runCommand(
			{ command: "node", args: ["-e", "process.exit(0)"] },
			root,
		);
		expect(result.success).toBe(true);
	});
});
