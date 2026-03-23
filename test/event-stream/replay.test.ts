import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../apps/cli/src/run-cli";
import { createEventStore } from "../../packages/storage/src/event-store";

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

function setupAndRun(root: string) {
	const packetPath = join(root, "packet.json");
	writeFileSync(
		packetPath,
		JSON.stringify({
			unit: {
				id: "unit-replay-test",
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
					"const fs = require('node:fs'); fs.mkdirSync('tmp', { recursive: true }); fs.writeFileSync('tmp/out.txt', 'replayed');",
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

describe("replay command", () => {
	it("replays a command packet producing a new run", async () => {
		const root = createGitTempDir("bp-replay-");
		const packetPath = setupAndRun(root);

		await runCliCapture(root, ["init"]);
		const run = await runCliCapture(root, ["run", "--packet", packetPath]);
		const originalRunId =
			run.stdout.find((l) => l.startsWith("run-id: "))?.slice(8) ?? "";
		expect(originalRunId).not.toBe("");

		const replay = await runCliCapture(root, ["replay", originalRunId]);
		expect(replay.exitCode).toBe(0);

		const replayOutput = replay.stdout.join("\n");
		expect(replayOutput).toContain("replay of:");
		expect(replayOutput).toContain("run-id:");
		expect(replayOutput).toContain("status: passed");

		// Extract replay run ID
		const replayRunId =
			replay.stdout.find((l) => l.startsWith("run-id: "))?.slice(8) ?? "";
		expect(replayRunId).not.toBe("");
		expect(replayRunId).not.toBe(originalRunId);

		// Verify replay run has events in storage
		const eventStore = createEventStore(root);
		const events = eventStore.getEventsByRunId(replayRunId);
		expect(events.length).toBeGreaterThan(0);
		expect(events.some((e) => e.kind === "run-completed")).toBe(true);
	});

	it("replay --json returns structured output", async () => {
		const root = createGitTempDir("bp-replay-");
		const packetPath = setupAndRun(root);

		await runCliCapture(root, ["init"]);
		const run = await runCliCapture(root, ["run", "--packet", packetPath]);
		const originalRunId =
			run.stdout.find((l) => l.startsWith("run-id: "))?.slice(8) ?? "";

		const replay = await runCliCapture(root, [
			"replay",
			originalRunId,
			"--json",
		]);
		expect(replay.exitCode).toBe(0);

		const payload = JSON.parse(replay.stdout.join(""));
		expect(payload.originalRunId).toBe(originalRunId);
		expect(payload.replay.runId).toBeDefined();
		expect(payload.replay.status).toBe("passed");
	});

	it("replay with --policy override changes policy profile", async () => {
		const root = createGitTempDir("bp-replay-");
		const packetPath = setupAndRun(root);

		await runCliCapture(root, ["init"]);
		const run = await runCliCapture(root, ["run", "--packet", packetPath]);
		const originalRunId =
			run.stdout.find((l) => l.startsWith("run-id: "))?.slice(8) ?? "";

		const replay = await runCliCapture(root, [
			"replay",
			originalRunId,
			"--policy=strict",
			"--json",
		]);
		expect(replay.exitCode).toBe(0);

		const payload = JSON.parse(replay.stdout.join(""));
		expect(payload.replay.status).toBe("passed");
	});

	it("replay fails for nonexistent run", async () => {
		const root = mkdtempSync(join(tmpdir(), "bp-replay-"));
		await runCliCapture(root, ["init"]);

		const replay = await runCliCapture(root, ["replay", "nonexistent-run-id"]);
		expect(replay.exitCode).toBe(1);
	});

	it("replay without run id shows error", async () => {
		const root = mkdtempSync(join(tmpdir(), "bp-replay-"));
		await runCliCapture(root, ["init"]);

		const replay = await runCliCapture(root, ["replay"]);
		expect(replay.exitCode).toBe(1);
		expect(replay.stderr.join("\n")).toContain("Missing required run id");
	});
});
