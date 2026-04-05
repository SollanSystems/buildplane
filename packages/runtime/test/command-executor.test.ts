import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { UnitPacket } from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import { executePacket } from "../src/command-executor";

describe("command executor", () => {
	it("resolves execution cwd and output checks relative to the supplied workspace root", () => {
		const sourceCheckout = process.cwd();
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "buildplane-runtime-workspace-"),
		);
		const outputPath = `tmp/out-${Date.now()}-nested.txt`;
		mkdirSync(join(workspaceRoot, "nested"), { recursive: true });
		const packet: UnitPacket = {
			unit: {
				id: "unit-runtime",
				kind: "command",
				scope: "task",
				inputRefs: [],
				expectedOutputs: [outputPath],
				verificationContract: "exit-0-and-required-outputs",
				policyProfile: "default",
			},
			execution: {
				command: "node",
				cwd: "nested",
				args: [
					"-e",
					`const fs = require('node:fs'); const path = require('node:path'); const output = path.resolve('..', ${JSON.stringify(outputPath)}); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, 'ok'); console.log('done');`,
				],
			},
			verification: {
				requiredOutputs: [outputPath],
			},
		};

		const receipt = executePacket(packet, workspaceRoot);

		expect(receipt.exitCode).toBe(0);
		expect(receipt.cwd).toBe(join(workspaceRoot, "nested"));
		expect(receipt.stdout).toContain("done");
		expect(receipt.outputChecks).toEqual([{ path: outputPath, exists: true }]);
		expect(readFileSync(join(workspaceRoot, outputPath), "utf8")).toBe("ok");
		expect(existsSync(join(sourceCheckout, outputPath))).toBe(false);
	});

	it("uses the supplied workspace root as the default cwd for receipts and output checks", () => {
		const sourceCheckout = process.cwd();
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "buildplane-runtime-workspace-"),
		);
		const executionRoot = relative(sourceCheckout, workspaceRoot);
		const outputPath = `tmp/out-${Date.now()}-root.txt`;
		const packet: UnitPacket = {
			unit: {
				id: "unit-runtime-default-cwd",
				kind: "command",
				scope: "task",
				inputRefs: [],
				expectedOutputs: [outputPath],
				verificationContract: "exit-0-and-required-outputs",
				policyProfile: "default",
			},
			execution: {
				command: "node",
				args: [
					"-e",
					`const fs = require('node:fs'); fs.mkdirSync('tmp', { recursive: true }); fs.writeFileSync(${JSON.stringify(outputPath)}, 'ok'); console.log('done');`,
				],
			},
			verification: {
				requiredOutputs: [outputPath],
			},
		};

		const receipt = executePacket(packet, executionRoot);

		expect(receipt.exitCode).toBe(0);
		expect(receipt.cwd).toBe(resolve(workspaceRoot));
		expect(receipt.stdout).toContain("done");
		expect(receipt.outputChecks).toEqual([{ path: outputPath, exists: true }]);
		expect(readFileSync(join(workspaceRoot, outputPath), "utf8")).toBe("ok");
		expect(existsSync(join(sourceCheckout, outputPath))).toBe(false);
	});

	it("rejects a symlinked cwd that resolves outside the supplied workspace root", () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "buildplane-runtime-workspace-"),
		);
		const outsideRoot = mkdtempSync(
			join(tmpdir(), "buildplane-runtime-outside-"),
		);
		symlinkSync(outsideRoot, join(workspaceRoot, "link-out"));
		const packet: UnitPacket = {
			unit: {
				id: "unit-runtime-symlink-cwd",
				kind: "command",
				scope: "task",
				inputRefs: [],
				expectedOutputs: ["link-out/escape.txt"],
				verificationContract: "exit-0-and-required-outputs",
				policyProfile: "default",
			},
			execution: {
				command: "node",
				cwd: "link-out",
				args: ["-e", "process.exit(0);"],
			},
			verification: {
				requiredOutputs: ["link-out/escape.txt"],
			},
		};

		expect(() => executePacket(packet, workspaceRoot)).toThrow(
			/outside the worktree root|outside the workspace root|symlink/i,
		);
	});
});
