import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/run-cli";

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

describe("cli command surface", () => {
	it("returns machine-readable NOT_INITIALIZED errors before init", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-uninit-"));

		const status = await runCliCapture(root, ["status", "--json"]);
		const inspect = await runCliCapture(root, ["inspect", "run-1", "--json"]);

		expect(status.exitCode).toBe(1);
		expect(JSON.parse(status.stdout.join("\n"))).toMatchObject({
			error: { code: "NOT_INITIALIZED" },
		});
		expect(inspect.exitCode).toBe(1);
		expect(JSON.parse(inspect.stdout.join("\n"))).toMatchObject({
			error: { code: "NOT_INITIALIZED" },
		});
	});

	it("initializes project state", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-init-"));

		const result = await runCliCapture(root, ["init"]);

		expect(result.exitCode).toBe(0);
		expect(existsSync(join(root, ".buildplane", "state.db"))).toBe(true);
	});

	it("runs packets, reports stable run output, and supports status/inspect queries", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-run-"));
		const passingPacketPath = join(root, "passing-packet.json");
		const failingPacketPath = join(root, "failing-packet.json");

		await runCliCapture(root, ["init"]);

		writeFileSync(
			passingPacketPath,
			JSON.stringify({
				unit: {
					id: "unit-pass",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["tmp/pass.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: {
					command: "node",
					args: [
						"-e",
						"const fs = require('node:fs'); fs.mkdirSync('tmp', { recursive: true }); fs.writeFileSync('tmp/pass.txt', 'ok'); console.log('pass');",
					],
				},
				verification: {
					requiredOutputs: ["tmp/pass.txt"],
				},
			}),
		);
		writeFileSync(
			failingPacketPath,
			JSON.stringify({
				unit: {
					id: "unit-fail",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["tmp/fail.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: {
					command: "node",
					args: ["-e", "process.exit(1);"],
				},
				verification: {
					requiredOutputs: ["tmp/fail.txt"],
				},
			}),
		);

		const passResult = await runCliCapture(root, [
			"run",
			"--packet",
			passingPacketPath,
		]);
		const passRunId =
			passResult.stdout.find((line) => line.startsWith("run-id: "))?.slice(8) ??
			"";
		const status = await runCliCapture(root, ["status", "--json"]);
		const inspect = await runCliCapture(root, ["inspect", passRunId, "--json"]);
		const failResult = await runCliCapture(root, [
			"run",
			"--packet",
			failingPacketPath,
		]);
		const missingInspect = await runCliCapture(root, [
			"inspect",
			"missing-id",
			"--json",
		]);

		expect(passResult.exitCode).toBe(0);
		expect(passResult.stdout).toContain(`run-id: ${passRunId}`);
		expect(passResult.stdout).toContain("status: passed");
		expect(status.exitCode).toBe(0);
		expect(JSON.parse(status.stdout.join("\n"))).toMatchObject({
			initialized: true,
			latestRun: { id: passRunId, status: "passed" },
		});
		expect(inspect.exitCode).toBe(0);
		expect(JSON.parse(inspect.stdout.join("\n"))).toMatchObject({
			kind: "run",
			run: { id: passRunId, status: "passed" },
		});

		expect(failResult.exitCode).toBe(1);
		expect(failResult.stdout.some((line) => line.startsWith("run-id: "))).toBe(
			true,
		);
		expect(failResult.stdout).toContain("status: failed");

		expect(missingInspect.exitCode).toBe(1);
		expect(JSON.parse(missingInspect.stdout.join("\n"))).toMatchObject({
			error: { code: "NOT_FOUND" },
		});
	});
});
