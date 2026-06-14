import { describe, expect, it } from "vitest";
import {
	CAPABILITY_BUNDLE_SCHEMA_VERSION,
	type CapabilityBundleV0,
} from "../src/schema.ts";

export function minimalValidBundle(): CapabilityBundleV0 {
	return {
		schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
		bundleId: "test-bundle-001",
	};
}

describe("capability bundle schema", () => {
	it("exposes the v0 schema version constant", () => {
		expect(CAPABILITY_BUNDLE_SCHEMA_VERSION).toBe(
			"buildplane.capability_bundle.v0",
		);
	});

	it("minimal fixture satisfies CapabilityBundleV0 shape", () => {
		const bundle = minimalValidBundle();
		expect(bundle.bundleId).toBe("test-bundle-001");
		expect(bundle.schemaVersion).toBe(CAPABILITY_BUNDLE_SCHEMA_VERSION);
	});
});
