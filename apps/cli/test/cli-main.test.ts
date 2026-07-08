import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCliIfExecutedDirectly } from "../src/cli-main";

describe("runCliIfExecutedDirectly — entrypoint promise handling", () => {
	const previousExitCode = process.exitCode;

	afterEach(() => {
		process.exitCode = previousExitCode;
		vi.restoreAllMocks();
	});

	function directEntry(): { entryUrl: string; argv: string[]; dir: string } {
		const dir = mkdtempSync(join(tmpdir(), "bp-cli-main-"));
		const entry = join(dir, "cli.js");
		writeFileSync(entry, "");
		return {
			entryUrl: pathToFileURL(entry).href,
			argv: ["node", entry, "web"],
			dir,
		};
	}

	it("propagates the resolved exit code", async () => {
		const { entryUrl, argv, dir } = directEntry();
		try {
			runCliIfExecutedDirectly(entryUrl, argv, async () => 3);
			await vi.waitFor(() => expect(process.exitCode).toBe(3));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("sets exit code 1 and reports the error when runCli rejects (no unhandled rejection)", async () => {
		const { entryUrl, argv, dir } = directEntry();
		const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			runCliIfExecutedDirectly(entryUrl, argv, async () => {
				throw new Error("cli dispatch failed");
			});
			await vi.waitFor(() => expect(process.exitCode).toBe(1));
			expect(stderrSpy).toHaveBeenCalledWith(
				expect.stringContaining("cli dispatch failed"),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
