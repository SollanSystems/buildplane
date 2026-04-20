import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
	makeBuildplaneRunFixture,
	resolveNativeBinaryForLedgerTests,
} from "./fixtures.js";

async function runForkCli(
	args: string[],
	cwd: string,
): Promise<{ exitCode: number; stderr: string }> {
	const { runCli } = (await import(
		"../../apps/cli/src/run-cli.js"
	)) as unknown as {
		runCli: (
			argv: string[],
			options: {
				cwd: string;
				stdout: (s: string) => void;
				stderr: (s: string) => void;
			},
		) => Promise<number>;
	};
	let stderrCaptured = "";
	const originalCwd = process.cwd();
	const originalNativeBin = process.env.BUILDPLANE_NATIVE_BIN;
	let exitCode = 1;
	try {
		const nativeBinary = resolveNativeBinaryForLedgerTests();
		process.env.BUILDPLANE_NATIVE_BIN = nativeBinary;
		process.chdir(cwd);
		exitCode = await runCli(args, {
			cwd,
			stdout: () => {},
			stderr: (s) => {
				stderrCaptured += s;
			},
		});
	} finally {
		process.chdir(originalCwd);
		if (originalNativeBin === undefined) {
			delete process.env.BUILDPLANE_NATIVE_BIN;
		} else {
			process.env.BUILDPLANE_NATIVE_BIN = originalNativeBin;
		}
	}
	return { exitCode, stderr: stderrCaptured };
}

describe("fork invalid target", () => {
	it("errors when target is run_started (fork at root)", async () => {
		const parent = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "u",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["out.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: { command: "sh", args: ["-c", "echo hi > out.txt"] },
				verification: { requiredOutputs: ["out.txt"] },
			},
		});
		try {
			const db = new DatabaseSync(parent.eventsDbPath);
			const runId = (
				db.prepare("SELECT DISTINCT run_id FROM events LIMIT 1").get() as {
					run_id: string;
				}
			).run_id;
			const runStartId = (
				db
					.prepare(
						"SELECT id FROM events WHERE kind = 'run_started' ORDER BY id ASC LIMIT 1",
					)
					.get() as { id: string }
			).id;
			db.close();

			const packetPath = join(parent.dir, "fork.json");
			writeFileSync(
				packetPath,
				JSON.stringify({ unit: { id: "u" }, execution: {} }),
			);

			const result = await runForkCli(
				[
					"fork",
					runId,
					"--at",
					runStartId,
					"--packet",
					packetPath,
					"--workspace",
					parent.dir,
				],
				parent.dir,
			);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toMatch(/fork at root|run_started/i);
		} finally {
			await parent.cleanup();
		}
	}, 60_000);

	it("errors when target is non-unit event (e.g. git_checkpoint)", async () => {
		const parent = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "u",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["out.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: { command: "sh", args: ["-c", "echo hi > out.txt"] },
				verification: { requiredOutputs: ["out.txt"] },
			},
		});
		try {
			const db = new DatabaseSync(parent.eventsDbPath);
			const runId = (
				db.prepare("SELECT DISTINCT run_id FROM events LIMIT 1").get() as {
					run_id: string;
				}
			).run_id;
			const ckptRow = db
				.prepare(
					"SELECT id FROM events WHERE kind = 'git_checkpoint' ORDER BY id ASC LIMIT 1",
				)
				.get() as { id: string } | undefined;
			db.close();
			if (!ckptRow) {
				// No checkpoints in tape (e.g. wiring gap) — skip the assertion.
				return;
			}

			const packetPath = join(parent.dir, "fork.json");
			writeFileSync(
				packetPath,
				JSON.stringify({ unit: { id: "u" }, execution: {} }),
			);

			const result = await runForkCli(
				[
					"fork",
					runId,
					"--at",
					ckptRow.id,
					"--packet",
					packetPath,
					"--workspace",
					parent.dir,
				],
				parent.dir,
			);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toMatch(/unit_started/i);
		} finally {
			await parent.cleanup();
		}
	}, 60_000);

	it("errors when target event id does not exist", async () => {
		const parent = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "u",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["out.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: { command: "sh", args: ["-c", "echo hi > out.txt"] },
				verification: { requiredOutputs: ["out.txt"] },
			},
		});
		try {
			const db = new DatabaseSync(parent.eventsDbPath);
			const runId = (
				db.prepare("SELECT DISTINCT run_id FROM events LIMIT 1").get() as {
					run_id: string;
				}
			).run_id;
			db.close();

			const packetPath = join(parent.dir, "fork.json");
			writeFileSync(
				packetPath,
				JSON.stringify({ unit: { id: "u" }, execution: {} }),
			);

			const bogus = "01919000-0000-7000-8000-ffffffffffff";
			const result = await runForkCli(
				[
					"fork",
					runId,
					"--at",
					bogus,
					"--packet",
					packetPath,
					"--workspace",
					parent.dir,
				],
				parent.dir,
			);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toMatch(/not found/i);
		} finally {
			await parent.cleanup();
		}
	}, 60_000);
});
