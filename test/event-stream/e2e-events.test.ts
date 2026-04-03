import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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

describe("e2e model run with events", () => {
	it("command packet produces typed events in storage", async () => {
		const root = mkdtempSync(join(tmpdir(), "bp-e2e-events-"));

		const packetPath = join(root, "packet.json");
		writeFileSync(
			packetPath,
			JSON.stringify({
				unit: {
					id: "unit-e2e-events",
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

		// Init and run
		const init = await runCliCapture(root, ["init"]);
		expect(init.exitCode).toBe(0);

		const run = await runCliCapture(root, ["run", "--packet", packetPath]);
		expect(run.exitCode).toBe(0);

		const runId =
			run.stdout.find((line) => line.startsWith("run-id: "))?.slice(8) ?? "";
		expect(runId).not.toBe("");

		// Verify events in storage
		const eventStore = createEventStore(root);
		const events = eventStore.getEventsByRunId(runId);

		// Should have lifecycle events
		const kinds = events.map((e) => e.kind);
		expect(kinds).toContain("run-created");
		expect(kinds).toContain("run-started");
		expect(kinds).toContain("execution-started");
		expect(kinds).toContain("evidence-recorded");
		expect(kinds).toContain("policy-decision");
		expect(kinds).toContain("run-completed");

		// Verify run-created has correct data
		const created = events.find((e) => e.kind === "run-created");
		if (created?.kind === "run-created") {
			expect(created.unitId).toBe("unit-e2e-events");
			expect(created.status).toBe("pending");
		}

		// Verify run-completed has passed status
		const completed = events.find((e) => e.kind === "run-completed");
		if (completed?.kind === "run-completed") {
			expect(completed.status).toBe("passed");
		}

		// Verify policy decision approved
		const policy = events.find((e) => e.kind === "policy-decision");
		if (policy?.kind === "policy-decision") {
			expect(policy.outcome).toBe("approved");
		}
	});

	it("existing headless CLI behavior is unchanged", async () => {
		const root = mkdtempSync(join(tmpdir(), "bp-e2e-compat-"));

		const packetPath = join(root, "packet.json");
		writeFileSync(
			packetPath,
			JSON.stringify({
				unit: {
					id: "unit-compat",
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
						"const fs = require('node:fs'); fs.mkdirSync('tmp', { recursive: true }); fs.writeFileSync('tmp/out.txt', 'ok'); console.log('compat-check');",
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

		const statusPayload = JSON.parse(status.stdout.join("\n"));
		expect(statusPayload).toMatchObject({
			initialized: true,
			latestRun: { id: runId, status: "passed" },
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
	});
});
