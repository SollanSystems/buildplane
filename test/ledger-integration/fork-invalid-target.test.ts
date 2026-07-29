import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	makeLegacyForkPreflightTapeFixture,
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
		const parent = await makeLegacyForkPreflightTapeFixture();
		try {
			const packetPath = join(parent.dir, "fork.json");
			writeFileSync(
				packetPath,
				JSON.stringify({ unit: { id: "u" }, execution: {} }),
			);

			const result = await runForkCli(
				[
					"fork",
					"--raw",
					parent.runId,
					"--at",
					parent.runStartedEventId,
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
		const parent = await makeLegacyForkPreflightTapeFixture();
		try {
			const packetPath = join(parent.dir, "fork.json");
			writeFileSync(
				packetPath,
				JSON.stringify({ unit: { id: "u" }, execution: {} }),
			);

			const result = await runForkCli(
				[
					"fork",
					"--raw",
					parent.runId,
					"--at",
					parent.preUnitGitCheckpointEventId,
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
		const parent = await makeLegacyForkPreflightTapeFixture();
		try {
			const packetPath = join(parent.dir, "fork.json");
			writeFileSync(
				packetPath,
				JSON.stringify({ unit: { id: "u" }, execution: {} }),
			);

			const bogus = "01919000-0000-7000-8000-ffffffffffff";
			const result = await runForkCli(
				[
					"fork",
					"--raw",
					parent.runId,
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
