import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getBootstrapBanner } from "../src/index";

const root = resolve(import.meta.dirname, "../../..");
const cliSourceEntrypoint = resolve(root, "apps/cli/src/index.ts");
const tsxLoaderEntrypoint = resolve(root, "node_modules/tsx/dist/loader.mjs");
const cleanupPaths: string[] = [];

afterEach(() => {
	for (const path of cleanupPaths.splice(0)) {
		rmSync(path, { force: true, recursive: true });
	}
});

describe("cli bootstrap", () => {
	it("returns the buildplane bootstrap banner", () => {
		expect(getBootstrapBanner()).toContain("Buildplane");
	});

	it("emits real CLI output when invoked via the root script entrypoint", () => {
		const output = execFileSync(
			process.execPath,
			["--import", "tsx", "./apps/cli/src/index.ts"],
			{ cwd: root, encoding: "utf8" },
		).trim();

		expect(output).toBe("Buildplane by SollanSystems");
	});

	it("runs init when the source CLI is invoked through a symlinked entrypoint", () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "buildplane-cli-symlink-"));
		const workspaceRoot = join(tempRoot, "workspace");
		const symlinkPath = join(tempRoot, "buildplane");
		cleanupPaths.push(tempRoot);
		mkdirSync(workspaceRoot, { recursive: true });
		symlinkSync(cliSourceEntrypoint, symlinkPath, "file");

		execFileSync(
			process.execPath,
			["--import", tsxLoaderEntrypoint, symlinkPath, "init"],
			{
				cwd: workspaceRoot,
				encoding: "utf8",
			},
		);

		expect(existsSync(join(workspaceRoot, ".buildplane", "state.db"))).toBe(
			true,
		);
	});
});
