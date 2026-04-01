import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const cliSourceEntrypoint = resolve(root, "apps/cli/src/index.ts");
const tsxLoaderEntrypoint = resolve(root, "node_modules/tsx/dist/loader.mjs");
const cleanupPaths: string[] = [];

afterEach(() => {
	for (const path of cleanupPaths.splice(0)) {
		rmSync(path, { force: true, recursive: true });
	}
});

function createCommittedRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "buildplane-graph-cli-"));
	cleanupPaths.push(root);
	execFileSync("git", ["init"], { cwd: root });
	execFileSync("git", ["config", "user.name", "test"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.com"], {
		cwd: root,
	});
	writeFileSync(join(root, "README.md"), "hello\n");
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["commit", "-m", "init"], { cwd: root });
	return root;
}

describe("CLI run-graph command", () => {
	it("can run a simple graph via CLI", () => {
		const repo = createCommittedRepo();

		execFileSync(
			process.execPath,
			["--import", tsxLoaderEntrypoint, cliSourceEntrypoint, "init"],
			{ cwd: repo, encoding: "utf8" },
		);

		const graph = {
			nodes: [
				{
					unit: { id: "unit-a" },
					dependencies: [],
					execution: {
						kind: "command",
						entrypoint: "echo",
						args: ["A"],
					},
				},
			],
		};
		const graphPath = join(repo, "graph.json");
		writeFileSync(graphPath, JSON.stringify(graph, null, 2));
		execFileSync("git", ["add", "graph.json"], { cwd: repo });
		execFileSync("git", ["commit", "-m", "add graph"], { cwd: repo });

		let stdout = "";
		let stderr = "";
		let exitCode = 0;
		try {
			stdout = execFileSync(
				process.execPath,
				[
					"--import",
					tsxLoaderEntrypoint,
					cliSourceEntrypoint,
					"run-graph",
					"--graph",
					graphPath,
				],
				{ cwd: repo, encoding: "utf8" },
			);
		} catch (e: any) {
			stdout = e.stdout;
			stderr = e.stderr;
			exitCode = e.status;
			console.log("CRASH:");
			console.log(e.stdout);
			console.log(e.stderr);
		}

		expect(exitCode).toBe(0);
		expect(stdout).toContain("Graph Outcome: passed");
		expect(stdout).toContain("- unit-a: passed");
	});
});
