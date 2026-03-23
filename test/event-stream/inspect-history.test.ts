import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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
	return { exitCode, stdout, stderr };
}

function createGitTempDir(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	execFileSync("git", ["init"], { cwd: root });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
	execFileSync("git", ["config", "user.email", "t@t.co"], { cwd: root });
	writeFileSync(join(root, ".gitignore"), ".buildplane/\n");
	writeFileSync(join(root, "init.txt"), "x");
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["commit", "-m", "init"], { cwd: root });
	return root;
}

function setupProject(root: string): string {
	const packetPath = join(root, "packet.json");
	writeFileSync(
		packetPath,
		JSON.stringify({
			unit: {
				id: "unit-inspect-test",
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
					"const fs = require('node:fs'); fs.mkdirSync('tmp', { recursive: true }); fs.writeFileSync('tmp/out.txt', 'ok');",
				],
			},
			verification: {
				requiredOutputs: ["tmp/out.txt"],
			},
		}),
	);
	execFileSync("git", ["add", "packet.json"], { cwd: root });
	execFileSync("git", ["commit", "-m", "add packet"], { cwd: root });
	return packetPath;
}

describe("inspect and history commands", () => {
	it("history lists runs after execution", async () => {
		const root = createGitTempDir("bp-hist-");
		const packetPath = setupProject(root);

		await runCliCapture(root, ["init"]);
		const run = await runCliCapture(root, ["run", "--packet", packetPath]);
		expect(run.exitCode).toBe(0);

		const history = await runCliCapture(root, ["history"]);
		expect(history.exitCode).toBe(0);

		const output = history.stdout.join("\n");
		expect(output).toContain("RUN ID");
		expect(output).toContain("unit-inspect-test");
		expect(output).toContain("passed");
	});

	it("history --json returns array", async () => {
		const root = createGitTempDir("bp-hist-");
		const packetPath = setupProject(root);

		await runCliCapture(root, ["init"]);
		await runCliCapture(root, ["run", "--packet", packetPath]);

		const history = await runCliCapture(root, ["history", "--json"]);
		expect(history.exitCode).toBe(0);

		const entries = JSON.parse(history.stdout.join(""));
		expect(Array.isArray(entries)).toBe(true);
		expect(entries.length).toBeGreaterThan(0);
		expect(entries[0]).toHaveProperty("id");
		expect(entries[0]).toHaveProperty("unitId");
		expect(entries[0]).toHaveProperty("status");
		expect(entries[0]).toHaveProperty("createdAt");
	});

	it("history returns empty message when no runs", async () => {
		const root = createGitTempDir("bp-hist-");
		await runCliCapture(root, ["init"]);

		const history = await runCliCapture(root, ["history"]);
		expect(history.exitCode).toBe(0);
		expect(history.stdout.join("\n")).toContain("No runs found");
	});

	it("inspect shows structured detail in human mode", async () => {
		const root = createGitTempDir("bp-insp-");
		const packetPath = setupProject(root);

		await runCliCapture(root, ["init"]);
		const run = await runCliCapture(root, ["run", "--packet", packetPath]);
		const runId =
			run.stdout.find((l) => l.startsWith("run-id: "))?.slice(8) ?? "";

		const inspect = await runCliCapture(root, ["inspect", runId]);
		expect(inspect.exitCode).toBe(0);

		const output = inspect.stdout.join("\n");
		expect(output).toContain(`run-id: ${runId}`);
		expect(output).toContain("unit-id: unit-inspect-test");
		expect(output).toContain("status: passed");
	});

	it("inspect --json still returns full snapshot", async () => {
		const root = createGitTempDir("bp-insp-");
		const packetPath = setupProject(root);

		await runCliCapture(root, ["init"]);
		const run = await runCliCapture(root, ["run", "--packet", packetPath]);
		const runId =
			run.stdout.find((l) => l.startsWith("run-id: "))?.slice(8) ?? "";

		const inspect = await runCliCapture(root, ["inspect", runId, "--json"]);
		expect(inspect.exitCode).toBe(0);

		const payload = JSON.parse(inspect.stdout.join(""));
		expect(payload).toMatchObject({
			kind: "run",
			run: { id: runId, status: "passed" },
		});
	});
});
