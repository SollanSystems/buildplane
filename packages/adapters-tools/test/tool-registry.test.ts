import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../src/index";

describe("tool registry", () => {
	function makeWorktree(): string {
		return realpathSync(mkdtempSync(join(tmpdir(), "bp-tools-registry-")));
	}

	it("returns both tools", () => {
		const root = makeWorktree();
		const registry = createToolRegistry(root);

		expect(typeof registry.write_file).toBe("function");
		expect(typeof registry.run_command).toBe("function");
	});

	it("write_file is scoped to the worktree", () => {
		const root = makeWorktree();
		const registry = createToolRegistry(root);

		const result = registry.write_file({
			path: "test.txt",
			content: "via registry",
		});

		expect(result.success).toBe(true);
		expect(readFileSync(join(root, "test.txt"), "utf8")).toBe("via registry");
	});

	it("run_command is scoped to the worktree", () => {
		const root = makeWorktree();
		const registry = createToolRegistry(root);

		const result = registry.run_command({
			command: "node",
			args: ["-e", "console.log(process.cwd())"],
		});

		expect(result.success).toBe(true);
		expect(result.stdout.trim()).toBe(root);
	});

	it("write_file rejects escapes through the registry", () => {
		const root = makeWorktree();
		const registry = createToolRegistry(root);

		const result = registry.write_file({
			path: "../escape.txt",
			content: "nope",
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/escapes the worktree/i);
	});

	it("run_command rejects cwd escapes through the registry", () => {
		const root = makeWorktree();
		const registry = createToolRegistry(root);

		const result = registry.run_command({
			command: "echo",
			args: ["nope"],
			cwd: "../",
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/escapes the worktree/i);
	});
});
