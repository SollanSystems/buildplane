import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

describe("CLI run-graph integration", () => {
	let projectRoot: string;
	let graphPath: string;

	beforeEach(() => {
		projectRoot = mkdtempSync(join(tmpdir(), "bp-graph-e2e-"));
		execSync("git init", { cwd: projectRoot });
		execSync('git commit --allow-empty -m "initial commit"', {
			cwd: projectRoot,
		});

		// Write a valid graph JSON
		const graph = {
			maxConcurrent: 2,
			nodes: [
				{
					unit: {
						id: "A",
						kind: "command",
						scope: "task",
						inputRefs: [],
						expectedOutputs: ["a.txt"],
						verificationContract: "exit-0-and-required-outputs",
						policyProfile: "default",
					},
					execution: {
						command: "sh",
						args: ["-c", "echo 'Hello from A' > a.txt"],
					},
					verification: { requiredOutputs: ["a.txt"] },
				},
				{
					unit: {
						id: "B",
						kind: "command",
						scope: "task",
						inputRefs: [],
						expectedOutputs: ["b.txt"],
						verificationContract: "exit-0-and-required-outputs",
						policyProfile: "default",
					},
					execution: {
						command: "sh",
						args: ["-c", "echo 'Hello from B' > b.txt"],
					},
					verification: { requiredOutputs: ["b.txt"] },
				},
				{
					unit: {
						id: "C",
						kind: "command",
						scope: "task",
						inputRefs: ["a.txt", "b.txt"],
						expectedOutputs: ["c.txt"],
						verificationContract: "exit-0-and-required-outputs",
						policyProfile: "default",
					},
					dependsOn: ["A", "B"],
					execution: {
						command: "sh",
						args: ["-c", "cat a.txt b.txt > c.txt"],
					},
					verification: { requiredOutputs: ["c.txt"] },
				},
			],
		};

		graphPath = join(projectRoot, "test-graph.json");
		writeFileSync(graphPath, JSON.stringify(graph, null, 2));

		const cliPath = join(__dirname, "../../apps/cli/dist/index.js");
		execSync(`node ${cliPath} init`, { cwd: projectRoot });

		// Create default profile
		const buildplaneDir = join(projectRoot, ".buildplane");
		const profilesDir = join(buildplaneDir, "profiles");
		execSync(`mkdir -p ${profilesDir}`);
		writeFileSync(
			join(profilesDir, "default.json"),
			JSON.stringify({
				schemaVersion: "1.0",
				rules: [],
			}),
		);

		// Git commit everything so workspace is clean
		execSync("git add .", { cwd: projectRoot });
		execSync('git commit -m "add graph and profile"', { cwd: projectRoot });
	});

	// afterEach(() => {
	// 	try {
	// 		rmSync(projectRoot, { recursive: true, force: true });
	// 	} catch {
	// 		// ignore
	// 	}
	// });

	it("executes a parallel graph and respects dependencies", () => {
		const cliPath = join(__dirname, "../../apps/cli/dist/index.js");

		// Run the CLI
		try {
			const output = execSync(
				`node ${cliPath} run-graph --graph ${graphPath}`,
				{ cwd: projectRoot, encoding: "utf8" },
			);

			expect(output).toContain("Graph Outcome: passed");
			expect(output).toContain(" - A: passed");
			expect(output).toContain(" - B: passed");
			expect(output).toContain(" - C: passed");

			// After completion, workspaces are squash-merged to head, so the files
			// should exist directly in the project root.
			const cContent = readFileSync(join(projectRoot, "c.txt"), "utf8");
			expect(cContent).toContain("Hello from A");
			expect(cContent).toContain("Hello from B");
		} catch (e: unknown) {
			const err = e as { stdout: string; stderr: string };
			console.log("--- ERROR ---");
			console.log(err.stdout);
			console.log(err.stderr);
			console.log("Project Root:", projectRoot);
			throw e;
		}
	});
});
