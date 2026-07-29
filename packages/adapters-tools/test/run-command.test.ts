import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/run-command";

describe("run_command tool", () => {
	function makeWorktree(): string {
		return realpathSync(mkdtempSync(join(tmpdir(), "bp-tools-run-")));
	}

	it("runs a command in the worktree root", () => {
		const root = makeWorktree();
		const result = runCommand(
			{ command: "node", args: ["-e", "console.log('hello')"] },
			root,
		);

		expect(result.success).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("hello");
	});

	it("captures stderr", () => {
		const root = makeWorktree();
		const result = runCommand(
			{ command: "node", args: ["-e", "console.error('oops')"] },
			root,
		);

		expect(result.exitCode).toBe(0);
		expect(result.stderr.trim()).toBe("oops");
	});

	it("returns non-zero exit code on failure", () => {
		const root = makeWorktree();
		const result = runCommand(
			{ command: "node", args: ["-e", "process.exit(42)"] },
			root,
		);

		expect(result.success).toBe(false);
		expect(result.exitCode).toBe(42);
	});

	it("runs in a subdirectory when cwd is specified", () => {
		const root = makeWorktree();
		mkdirSync(join(root, "subdir"));
		const result = runCommand(
			{
				command: "node",
				args: ["-e", "console.log(process.cwd())"],
				cwd: "subdir",
			},
			root,
		);

		expect(result.success).toBe(true);
		expect(result.stdout.trim()).toBe(join(root, "subdir"));
	});

	it("defaults cwd to the worktree root", () => {
		const root = makeWorktree();
		const result = runCommand(
			{ command: "node", args: ["-e", "console.log(process.cwd())"] },
			root,
		);

		expect(result.success).toBe(true);
		expect(result.stdout.trim()).toBe(root);
	});

	it("rejects cwd that escapes the worktree via ../", () => {
		const root = makeWorktree();
		const result = runCommand(
			{ command: "echo", args: ["nope"], cwd: "../" },
			root,
		);

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/escapes the worktree/i);
	});

	it("rejects absolute cwd", () => {
		const root = makeWorktree();
		const result = runCommand(
			{ command: "echo", args: ["nope"], cwd: "/tmp" },
			root,
		);

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/absolute/i);
	});

	it("rejects cwd through a symlink that escapes", () => {
		const root = makeWorktree();
		const outside = mkdtempSync(join(tmpdir(), "bp-tools-outside-"));
		symlinkSync(outside, join(root, "link-out"));

		const result = runCommand(
			{ command: "echo", args: ["nope"], cwd: "link-out" },
			root,
		);

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/symlink/i);
	});

	it("returns structured error when command is not found", () => {
		const root = makeWorktree();
		const result = runCommand({ command: "nonexistent-binary-xyz-123" }, root);

		expect(result.success).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.error).toBeDefined();
	});
});
