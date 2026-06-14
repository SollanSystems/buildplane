import {
	bundleDigest,
	CAPABILITY_BUNDLE_SCHEMA_VERSION,
} from "@buildplane/capability-broker";
import { describe, expect, it } from "vitest";
import { parseUnitPacket } from "../src/packet.ts";

const basePacket = {
	unit: {
		id: "u1",
		kind: "test",
		scope: "local",
		inputRefs: [],
		expectedOutputs: [],
		verificationContract: "true",
		policyProfile: "default",
	},
	execution: { command: "true" },
	verification: { requiredOutputs: [] },
};

describe("parseUnitPacket capability_bundle", () => {
	it("parses packets without capability_bundle (backward compatible)", () => {
		const parsed = parseUnitPacket(JSON.stringify(basePacket));
		expect(parsed.capability_bundle).toBeUndefined();
	});

	it("parses validated bundle with matching digest", () => {
		const capability_bundle = {
			schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
			bundleId: "test",
			fsWrite: ["src/**"],
			tools: { run_command: { allowlist: ["npm"] } },
		};
		const packet = {
			...basePacket,
			capability_bundle,
			capability_bundle_digest: bundleDigest(capability_bundle),
		};
		const parsed = parseUnitPacket(JSON.stringify(packet));
		expect(parsed.capability_bundle?.bundleId).toBe("test");
		expect(parsed.capability_bundle_digest).toBe(
			bundleDigest(capability_bundle),
		);
	});

	it("rejects digest mismatch", () => {
		const capability_bundle = {
			schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
			bundleId: "test",
		};
		const packet = {
			...basePacket,
			capability_bundle,
			capability_bundle_digest:
				"sha256:0000000000000000000000000000000000000000000000000000000000000000",
		};
		expect(() => parseUnitPacket(JSON.stringify(packet))).toThrow(
			/does not match/,
		);
	});
});
