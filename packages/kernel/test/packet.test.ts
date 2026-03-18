import { describe, expect, it } from "vitest";
import { parseUnitPacket } from "../src/packet";

describe("parseUnitPacket", () => {
	it("parses a valid unit packet", () => {
		const packet = parseUnitPacket({
			unit: {
				id: "unit-hello",
				kind: "execute",
				scope: "task",
				inputRefs: [],
				expectedOutputs: ["tmp/out.txt"],
				verificationContract: "required-outputs",
				policyProfile: "default",
			},
			execution: {
				command: "node",
				args: ["scripts/hello.mjs"],
				cwd: ".",
			},
			verification: {
				requiredOutputs: ["tmp/out.txt"],
			},
		});

		expect(packet.unit.id).toBe("unit-hello");
		expect(packet.execution.command).toBe("node");
		expect(packet.verification.requiredOutputs).toEqual(["tmp/out.txt"]);
	});
});
