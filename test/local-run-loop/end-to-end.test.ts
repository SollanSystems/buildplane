import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

describe("local run loop end to end", () => {
	it("initializes, runs a packet, and inspects the recorded result", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-e2e-"));
		const packetPath = join(root, "packet.json");

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

		const init = await runCliCapture(root, ["init"]);
		const run = await runCliCapture(root, ["run", "--packet", packetPath]);
		const runId =
			run.stdout.find((line) => line.startsWith("run-id: "))?.slice(8) ?? "";
		const status = await runCliCapture(root, ["status", "--json"]);
		const inspect = await runCliCapture(root, ["inspect", runId, "--json"]);

		expect(init.exitCode).toBe(0);
		expect(run.exitCode).toBe(0);
		expect(existsSync(join(root, ".buildplane", "state.db"))).toBe(true);
		expect(readFileSync(join(root, "tmp", "out.txt"), "utf8")).toBe("ok");

		const statusPayload = JSON.parse(status.stdout.join("\n"));
		expect(statusPayload).toMatchObject({
			initialized: true,
			latestRun: { id: runId, status: "passed" },
			runCounts: { passed: 1 },
		});

		const inspectPayload = JSON.parse(inspect.stdout.join("\n"));
		expect(inspectPayload).toMatchObject({
			kind: "run",
			run: { id: runId, status: "passed" },
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
