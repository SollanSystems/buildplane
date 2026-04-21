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

describe("fork without --packet", () => {
	it("errors cleanly in Phase E (Phase F enables parent-packet-from-CAS)", async () => {
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
			const unitId = (
				db
					.prepare(
						"SELECT id FROM events WHERE kind = 'unit_started' ORDER BY id ASC LIMIT 1",
					)
					.get() as { id: string }
			).id;
			db.close();

			// No --packet flag.
			const result = await runForkCli(
				["fork", runId, "--at", unitId, "--workspace", parent.dir],
				parent.dir,
			);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toMatch(/packet/i);
		} finally {
			await parent.cleanup();
		}
	}, 60_000);
});
