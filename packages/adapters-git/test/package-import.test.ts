import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageDir = resolve(import.meta.dirname, "..");

describe("@buildplane/adapters-git package consumption", () => {
	it("is importable by raw Node from the package root", () => {
		const output = execFileSync(
			process.execPath,
			[
				"-e",
				"import('@buildplane/adapters-git').then((mod) => console.log(JSON.stringify(Object.keys(mod).sort())))",
			],
			{
				cwd: packageDir,
				encoding: "utf8",
			},
		).trim();

		expect(output).toBe(JSON.stringify(["createGitWorkspaceAdapter"]));
	});

	it("does not expose internal adapter implementation subpaths", () => {
		const output = execFileSync(
			process.execPath,
			[
				"-e",
				"import('@buildplane/adapters-git/worktree-adapter').then(() => console.log('resolved')).catch((error) => console.log(error.code ?? error.message))",
			],
			{
				cwd: packageDir,
				encoding: "utf8",
			},
		).trim();

		expect(output).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED");
	});
});
