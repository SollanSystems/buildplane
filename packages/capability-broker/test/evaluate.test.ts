import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateToolInvocation } from "../src/evaluate.ts";
import type { CapabilityBundleV0 } from "../src/schema.ts";
import { CAPABILITY_BUNDLE_SCHEMA_VERSION } from "../src/schema.ts";

function demoBundle(): CapabilityBundleV0 {
	return {
		schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
		bundleId: "m6-demo",
		fsWrite: ["src/**", "test/**"],
		tools: {
			write_file: { enabled: true },
			run_command: { allowlist: ["npm", "git"] },
		},
	};
}

describe("evaluateToolInvocation write_file (src/** test/** globs)", () => {
	let worktreeRoot: string;

	it("allows in-scope write under src/**", () => {
		worktreeRoot = mkdtempSync(join(tmpdir(), "bp-cap-"));
		const result = evaluateToolInvocation(
			demoBundle(),
			{ tool: "write_file", path: "src/foo.ts" },
			{ worktreeRoot },
		);
		expect(result).toEqual({ decision: "allow" });
		rmSync(worktreeRoot, { recursive: true, force: true });
	});

	it("allows in-scope write under test/**", () => {
		worktreeRoot = mkdtempSync(join(tmpdir(), "bp-cap-"));
		const result = evaluateToolInvocation(
			demoBundle(),
			{ tool: "write_file", path: "test/bar.test.ts" },
			{ worktreeRoot },
		);
		expect(result).toEqual({ decision: "allow" });
		rmSync(worktreeRoot, { recursive: true, force: true });
	});

	it("denies out-of-scope write outside src/** and test/**", () => {
		worktreeRoot = mkdtempSync(join(tmpdir(), "bp-cap-"));
		const result = evaluateToolInvocation(
			demoBundle(),
			{ tool: "write_file", path: "docs/readme.md" },
			{ worktreeRoot },
		);
		expect(result.decision).toBe("deny");
		if (result.decision === "deny") {
			expect(result.quarantine).toBe(true);
			expect(result.reason).toContain("fsWrite");
		}
		rmSync(worktreeRoot, { recursive: true, force: true });
	});

	it("denies write when write_file tool is disabled", () => {
		worktreeRoot = mkdtempSync(join(tmpdir(), "bp-cap-"));
		const bundle: CapabilityBundleV0 = {
			...demoBundle(),
			tools: {
				write_file: { enabled: false },
				run_command: { allowlist: ["npm"] },
			},
		};
		const result = evaluateToolInvocation(
			bundle,
			{ tool: "write_file", path: "src/x.ts" },
			{ worktreeRoot },
		);
		expect(result).toMatchObject({
			decision: "deny",
			quarantine: true,
		});
		rmSync(worktreeRoot, { recursive: true, force: true });
	});
});

describe("evaluateToolInvocation run_command allowlist", () => {
	const worktreeRoot = "/tmp/worktree";

	it("allows allowlisted npm test command prefix", () => {
		const result = evaluateToolInvocation(
			demoBundle(),
			{ tool: "run_command", command: "npm", args: ["test"] },
			{ worktreeRoot },
		);
		expect(result).toEqual({ decision: "allow" });
	});

	it("allows git subcommand via argv0", () => {
		const result = evaluateToolInvocation(
			demoBundle(),
			{ tool: "run_command", command: "git", args: ["status"] },
			{ worktreeRoot },
		);
		expect(result).toEqual({ decision: "allow" });
	});

	it("denies forbidden command not on allowlist", () => {
		const result = evaluateToolInvocation(
			demoBundle(),
			{
				tool: "run_command",
				command: "curl",
				args: ["https://evil.example"],
			},
			{ worktreeRoot },
		);
		expect(result).toMatchObject({
			decision: "deny",
			quarantine: true,
			reason: expect.stringContaining("allowlist"),
		});
	});

	it("denies forbidden command even when args[0] is allowlisted", () => {
		const result = evaluateToolInvocation(
			demoBundle(),
			{ tool: "run_command", command: "curl", args: ["npm"] },
			{ worktreeRoot },
		);
		expect(result).toMatchObject({
			decision: "deny",
			quarantine: true,
			reason: expect.stringContaining("allowlist"),
		});
	});
});
