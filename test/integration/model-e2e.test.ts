import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../apps/cli/src/run-cli";

const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;

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
	const root = realpathSync(mkdtempSync(join(tmpdir(), "bp-model-e2e-")));

	git(root, ["init"]);
	git(root, ["config", "user.name", "Buildplane Tests"]);
	git(root, ["config", "user.email", "tests@example.com"]);
	writeFileSync(
		join(root, ".gitignore"),
		".buildplane/state.db\n.buildplane/project.json\n.buildplane/workspaces/\n.buildplane/artifacts/\n.buildplane/events/\n",
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
	git(root, ["commit", "-m", `add ${name}`]);
	return packetPath;
}

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

describe.skipIf(!HAS_API_KEY)(
	"model-backed execution end-to-end",
	{ timeout: 60_000 },
	() => {
		it("dispatches a model packet, Claude calls write_file, verification passes", async () => {
			const root = createGitRepo();

			const packetPath = writeCommittedPacket(root, "model-packet.json", {
				unit: {
					id: "model-e2e-write",
					kind: "model",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["output/hello.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				model: {
					provider: "anthropic",
					model: "claude-sonnet-4-20250514",
					systemPrompt:
						"You are a build assistant. Use the write_file tool to create the file output/hello.txt with the content 'Hello from Buildplane'. Do not explain — just call the tool.",
				},
				verification: {
					requiredOutputs: ["output/hello.txt"],
				},
			});

			// Initialize
			const init = await runCliCapture(root, ["init"]);
			expect(init.exitCode).toBe(0);

			// Run the model packet
			const run = await runCliCapture(root, ["run", "--packet", packetPath]);

			// Extract run ID
			const runIdLine = run.stdout.find((line) => line.startsWith("run-id: "));
			expect(runIdLine).toBeDefined();
			const runId = runIdLine?.slice("run-id: ".length) ?? "";

			// The run should pass — Claude should call write_file and create the output
			expect(run.exitCode).toBe(0);
			expect(run.stdout).toEqual(
				expect.arrayContaining([expect.stringContaining("status: passed")]),
			);

			// Inspect the run to verify events were recorded
			const inspect = await runCliCapture(root, ["inspect", runId, "--json"]);
			expect(inspect.exitCode).toBe(0);

			const inspectPayload = JSON.parse(inspect.stdout.join("\n"));
			expect(inspectPayload).toMatchObject({
				kind: "run",
				run: { id: runId, status: "passed" },
			});

			// Evidence should show the output check passed
			expect(inspectPayload.evidence).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "command-exit",
						status: "pass",
					}),
				]),
			);
		});
	},
);
