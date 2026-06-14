import { describe, expect, it } from "vitest";
import { CAPABILITY_BUNDLE_SCHEMA_VERSION } from "../src/schema.ts";
import { validateCapabilityBundle } from "../src/validate.ts";
import { minimalValidBundle } from "./schema.test.ts";

describe("validateCapabilityBundle", () => {
	it("accepts minimal valid bundle", () => {
		const result = validateCapabilityBundle(minimalValidBundle());
		expect(result).toEqual({ ok: true, bundle: minimalValidBundle() });
	});

	it("rejects wrong schemaVersion", () => {
		const result = validateCapabilityBundle({
			schemaVersion: "buildplane.capability_bundle.v99",
			bundleId: "x",
		});
		expect(result.ok).toBe(false);
	});

	it("rejects absolute fsWrite glob", () => {
		const result = validateCapabilityBundle({
			schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
			bundleId: "x",
			fsWrite: ["/etc/**"],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("fsWrite"))).toBe(true);
		}
	});

	it('rejects ".." in glob', () => {
		const result = validateCapabilityBundle({
			schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
			bundleId: "x",
			fsWrite: ["../secret.txt"],
		});
		expect(result.ok).toBe(false);
	});

	it("rejects empty allowlist string", () => {
		const result = validateCapabilityBundle({
			schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
			bundleId: "x",
			tools: { run_command: { allowlist: [""] } },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.includes("allowlist"))).toBe(true);
		}
	});
});
