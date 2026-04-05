import { describe, expect, it } from "vitest";
import { createCommandPacket1, createCommandPacket2 } from "../src/demo.js";

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
