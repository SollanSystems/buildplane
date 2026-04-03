import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UnitPacket } from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import { executePacket } from "../src/command-executor";

describe("command executor", () => {
	it("runs a local command and captures receipt details", () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "buildplane-runtime-"));
		const packet: UnitPacket = {
			unit: {
				id: "unit-runtime",
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
					"const fs = require('node:fs'); fs.mkdirSync('tmp', { recursive: true }); fs.writeFileSync('tmp/out.txt', 'ok'); console.log('done');",
				],
			},
			verification: {
				requiredOutputs: ["tmp/out.txt"],
			},
		};

		const receipt = executePacket(packet, projectRoot);

		expect(receipt.exitCode).toBe(0);
		expect(receipt.stdout).toContain("done");
		expect(receipt.outputChecks).toEqual([
			{ path: "tmp/out.txt", exists: true },
		]);
		expect(readFileSync(join(projectRoot, "tmp", "out.txt"), "utf8")).toBe(
			"ok",
		);
	});
});
