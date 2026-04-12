import { describe, expect, it } from "vitest";
import { createCommandPacket1, createCommandPacket2 } from "../src/demo.js";
import { runCli } from "../src/run-cli.js";

describe("demo packet factories", () => {
	it("creates command packet 1 with correct structure", () => {
		const packet = createCommandPacket1();
		expect(packet.unit.id).toBe("demo-cmd-1");
		expect(packet.unit.kind).toBe("command");
		expect(packet.unit.verificationContract).toBe(
			"exit-0-and-required-outputs",
		);
		expect(packet.execution.command).toBe("node");
		expect(packet.verification.requiredOutputs).toContain("output/result.txt");
		expect(packet.intent.taskType).toBe("implement");
	});

	it("creates command packet 2 with correct structure", () => {
		const packet = createCommandPacket2();
		expect(packet.unit.id).toBe("demo-cmd-2");
		expect(packet.verification.requiredOutputs).toContain("output/summary.txt");
		expect(packet.intent.objective).toBe("Summarize workspace state");
	});
});

describe("CLI demo dispatch", () => {
	it("dispatches buildplane demo and exits 0", async () => {
		const originalWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
		try {
			const exitCode = await runCli(["demo"], {
				stdout: () => {},
				stderr: () => {},
			});
			expect(exitCode).toBe(0);
		} finally {
			process.stdout.write = originalWrite;
		}
	}, 15_000);
});

describe("runDemo integration", () => {
	it("runs two command packets and proves flywheel loop", async () => {
		const output: string[] = [];
		const originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			output.push(chunk);
			return true;
		}) as typeof process.stdout.write;

		try {
			const { runDemo } = await import("../src/demo.js");
			await runDemo({ model: false });
		} finally {
			process.stdout.write = originalWrite;
		}

		const text = output.join("");
		expect(text).toContain("Buildplane Flywheel Demo");
		expect(text).toContain("Passed");
		expect(text).toContain("Flywheel closed");
		expect(text).toContain("learnings found");
		expect(text).toContain("[fact]");
	}, 15_000);
});
