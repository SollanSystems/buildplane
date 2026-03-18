import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../apps/cli/src/run-cli";

async function runCliCapture(cwd: string, argv: string[]) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const exitCode = await runCli(argv, {
		cwd,
		stdout: (line) => stdout.push(line),
		stderr: (line) => stderr.push(line),
	});

	return {
		exitCode,
		stdout,
		stderr,
	};
}

function git(root: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd: root,
		encoding: "utf8",
	});
}

function createGitRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "buildplane-e2e-git-"));

	git(root, ["init"]);
	git(root, ["config", "user.name", "Buildplane Tests"]);
	git(root, ["config", "user.email", "tests@example.com"]);
	writeFileSync(join(root, "tracked.txt"), "baseline\n");
	git(root, ["add", "tracked.txt"]);
	git(root, ["commit", "-m", "baseline"]);

	return root;
}

describe("local run loop end to end", () => {
	it("initializes, runs a packet, and inspects the recorded result", async () => {
		const root = createGitRepo();
		const packetPath = join(root, ".buildplane", "packets", "packet.json");

		mkdirSync(join(root, ".buildplane", "packets"), { recursive: true });
		writeFileSync(
			packetPath,
			JSON.stringify({
				unit: {
					id: "unit-e2e",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["tmp/out.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: {
					command: "node",
					args: [
						"-e",
						"const fs = require('node:fs'); fs.mkdirSync('tmp', { recursive: true }); fs.writeFileSync('tmp/out.txt', 'ok'); console.log('vertical-slice');",
					],
				},
				verification: {
					requiredOutputs: ["tmp/out.txt"],
				},
			}),
		);
		git(root, ["add", ".buildplane/packets/packet.json"]);
		git(root, ["commit", "-m", "add packet fixture"]);

		const init = await runCliCapture(root, ["init"]);
		const run = await runCliCapture(root, ["run", "--packet", packetPath]);
		const runId =
			run.stdout.find((line) => line.startsWith("run-id: "))?.slice(8) ?? "";
		const status = await runCliCapture(root, ["status", "--json"]);
		const inspect = await runCliCapture(root, ["inspect", runId, "--json"]);

		expect(init.exitCode).toBe(0);
		expect(run.exitCode).toBe(0);
		expect(existsSync(join(root, ".buildplane", "state.db"))).toBe(true);
		expect(existsSync(join(root, "tmp", "out.txt"))).toBe(false);

		const statusPayload = JSON.parse(status.stdout.join("\n"));
		expect(statusPayload).toMatchObject({
			initialized: true,
			latestRun: { id: runId, status: "passed" },
			latestRunUsedWorkspace: true,
			latestWorkspace: {
				runId: runId,
				status: "deleted",
				path: expect.stringMatching(/\.buildplane\/workspaces\//),
				finalizedAt: expect.any(String),
			},
			runCounts: { passed: 1 },
		});

		const inspectPayload = JSON.parse(inspect.stdout.join("\n"));
		expect(inspectPayload).toMatchObject({
			kind: "run",
			run: { id: runId, status: "passed" },
			workspace: {
				status: "deleted",
				path: expect.stringMatching(/\.buildplane\/workspaces\//),
				existsOnDisk: false,
				finalizedAt: expect.any(String),
			},
		});
		expect(inspectPayload.evidence).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "command-exit", status: "pass" }),
			]),
		);
		expect(inspectPayload.decisions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "advance-run", outcome: "approved" }),
			]),
		);
		expect(inspectPayload.artifacts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "required-output",
					location: "tmp/out.txt",
				}),
			]),
		);
	});
});
