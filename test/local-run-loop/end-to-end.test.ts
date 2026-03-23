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
		env: isolatedGitEnv(),
		encoding: "utf8",
	});
}

function isolatedGitEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_")) {
			delete env[key];
		}
	}
	return env;
}

function createGitRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "buildplane-e2e-git-"));

	git(root, ["init"]);
	git(root, ["config", "user.name", "Buildplane Tests"]);
	git(root, ["config", "user.email", "tests@example.com"]);
	writeFileSync(
		join(root, ".gitignore"),
		".buildplane/state.db\n.buildplane/project.json\n.buildplane/workspaces/\n",
	);
	writeFileSync(join(root, "tracked.txt"), "baseline\n");
	git(root, ["add", "."]);
	git(root, ["commit", "-m", "baseline"]);

	return root;
}

function writeCommittedPacket(
	root: string,
	name: string,
	packet: unknown,
): string {
	const packetPath = join(root, ".buildplane", "packets", name);
	mkdirSync(join(root, ".buildplane", "packets"), { recursive: true });
	writeFileSync(packetPath, JSON.stringify(packet));
	git(root, ["add", `.buildplane/packets/${name}`]);
	git(root, ["commit", "-m", `add ${name} fixture`]);
	return packetPath;
}

describe("local run loop end to end", () => {
	it("initializes, runs a passing packet, and inspects the recorded result", async () => {
		const root = createGitRepo();
		const packetPath = writeCommittedPacket(root, "packet.json", {
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
		});

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
					location: `.buildplane/artifacts/${runId}/tmp/out.txt`,
				}),
			]),
		);
	});

	it("retains a failed workspace and surfaces it in status and inspect output", async () => {
		const root = createGitRepo();
		const packetPath = writeCommittedPacket(root, "failing-packet.json", {
			unit: {
				id: "unit-failed-e2e",
				kind: "command",
				scope: "task",
				inputRefs: [],
				expectedOutputs: ["tmp/out.txt"],
				verificationContract: "exit-0-and-required-outputs",
				policyProfile: "default",
			},
			execution: {
				command: "node",
				args: ["-e", "process.exit(1);"],
			},
			verification: {
				requiredOutputs: ["tmp/out.txt"],
			},
		});

		const init = await runCliCapture(root, ["init"]);
		const run = await runCliCapture(root, ["run", "--packet", packetPath]);
		const runId =
			run.stdout.find((line) => line.startsWith("run-id: "))?.slice(8) ?? "";
		const workspaceLine =
			run.stdout.find((line) => line.startsWith("workspace: ")) ?? "";
		const workspacePath = workspaceLine.slice(11).replace(/ \([^)]+\)$/, "");
		const status = await runCliCapture(root, ["status", "--json"]);
		const inspect = await runCliCapture(root, ["inspect", runId, "--json"]);

		expect(init.exitCode).toBe(0);
		expect(run.exitCode).toBe(1);
		expect(run.stdout).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^run-id: /),
				"status: failed",
				expect.stringMatching(/^workspace: .+\.buildplane\/workspaces\//),
			]),
		);
		expect(existsSync(workspacePath)).toBe(true);

		const statusPayload = JSON.parse(status.stdout.join("\n"));
		expect(statusPayload).toMatchObject({
			initialized: true,
			latestRun: { id: runId, status: "failed" },
			latestRunUsedWorkspace: true,
			latestWorkspace: {
				runId: runId,
				status: "retained",
				path: workspacePath,
			},
			actionableWorkspaces: [
				{
					runId: runId,
					status: "retained",
					path: workspacePath,
				},
			],
			runCounts: { failed: 1 },
		});

		const inspectPayload = JSON.parse(inspect.stdout.join("\n"));
		expect(inspectPayload).toMatchObject({
			kind: "run",
			run: { id: runId, status: "failed" },
			workspace: {
				status: "retained",
				path: workspacePath,
				existsOnDisk: true,
			},
		});
		expect(inspectPayload.evidence).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "command-exit", status: "fail" }),
			]),
		);
	});
});
