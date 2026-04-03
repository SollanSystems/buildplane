import { existsSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeFile } from "../src/write-file";

describe("write_file tool", () => {
	function makeWorktree(): string {
		return mkdtempSync(join(tmpdir(), "bp-tools-write-"));
	}

	it("writes a file into the worktree", () => {
		const root = makeWorktree();
		const result = writeFile(
			{ path: "hello.txt", content: "hello world" },
			root,
		);

		expect(result).toEqual({ success: true, path: "hello.txt" });
		expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("hello world");
	});

	it("creates parent directories as needed", () => {
		const root = makeWorktree();
		const result = writeFile(
			{ path: "deep/nested/dir/file.ts", content: "export {};" },
			root,
		);

		expect(result.success).toBe(true);
		expect(readFileSync(join(root, "deep/nested/dir/file.ts"), "utf8")).toBe(
			"export {};",
		);
	});

	it("overwrites an existing file", () => {
		const root = makeWorktree();
		writeFile({ path: "overwrite.txt", content: "first" }, root);
		const result = writeFile(
			{ path: "overwrite.txt", content: "second" },
			root,
		);

		expect(result.success).toBe(true);
		expect(readFileSync(join(root, "overwrite.txt"), "utf8")).toBe("second");
	});

	it("rejects an absolute path", () => {
		const root = makeWorktree();
		const result = writeFile({ path: "/etc/passwd", content: "nope" }, root);

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/absolute/i);
	});

	it("rejects ../traversal", () => {
		const root = makeWorktree();
		const result = writeFile({ path: "../escape.txt", content: "nope" }, root);

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/escapes the worktree/i);
	});

	it("rejects nested ../traversal", () => {
		const root = makeWorktree();
		const result = writeFile(
			{ path: "sub/../../escape.txt", content: "nope" },
			root,
		);

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/escapes the worktree/i);
	});

	it("rejects a symlink that escapes the worktree", () => {
		const root = makeWorktree();
		const outside = mkdtempSync(join(tmpdir(), "bp-tools-outside-"));
		symlinkSync(outside, join(root, "link-out"));

		const result = writeFile(
			{ path: "link-out/escape.txt", content: "nope" },
			root,
		);

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/symlink/i);
	});

	it("does not write outside the worktree on rejection", () => {
		const root = makeWorktree();
		const outside = mkdtempSync(join(tmpdir(), "bp-tools-outside-"));

		writeFile({ path: "../escape.txt", content: "nope" }, root);

		expect(existsSync(join(outside, "escape.txt"))).toBe(false);
	});
});
