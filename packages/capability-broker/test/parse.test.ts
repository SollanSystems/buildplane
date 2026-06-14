import { describe, expect, it } from "vitest";
import { parseCapabilityBundle } from "../src/parse.ts";
import { CAPABILITY_BUNDLE_SCHEMA_VERSION } from "../src/schema.ts";

describe("parseCapabilityBundle", () => {
	it("rejects non-objects", () => {
		expect(parseCapabilityBundle(null)).toEqual({
			ok: false,
			errors: ["bundle must be a JSON object"],
		});
	});

	it("parses a minimal valid bundle", () => {
		const result = parseCapabilityBundle({
			schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
			bundleId: "abc",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.bundle.bundleId).toBe("abc");
		}
	});

	it("rejects wrong schemaVersion", () => {
		const result = parseCapabilityBundle({
			schemaVersion: "other",
			bundleId: "abc",
		});
		expect(result.ok).toBe(false);
	});
});
