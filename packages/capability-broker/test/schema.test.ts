import { describe, expect, it } from "vitest";
import { validateCapabilityBundle } from "../src/index.ts";
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

	it("accepts an optional declarative netEgress allowlist (M6-S9)", () => {
		const bundle: CapabilityBundleV0 = {
			...minimalValidBundle(),
			netEgress: ["registry.npmjs.org"],
		};
		expect(bundle.netEgress).toEqual(["registry.npmjs.org"]);
	});

	it("validates and preserves netEgress through parse/validate; empty array is allowed", () => {
		const validated = validateCapabilityBundle({
			schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
			bundleId: "egress-bundle",
			netEgress: ["registry.npmjs.org", "api.anthropic.com"],
		});
		if (!validated.ok) {
			throw new Error(validated.errors.join("; "));
		}
		expect(validated.bundle.netEgress).toEqual([
			"registry.npmjs.org",
			"api.anthropic.com",
		]);

		const emptyOk = validateCapabilityBundle({
			schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
			bundleId: "deny-all",
			netEgress: [],
		});
		expect(emptyOk.ok).toBe(true);
	});

	it("rejects a malformed netEgress host (whitespace / path / empty)", () => {
		const bad = validateCapabilityBundle({
			schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
			bundleId: "bad-egress",
			netEgress: ["evil.example/path", "  ", "ok.example.com"],
		});
		expect(bad.ok).toBe(false);
		if (!bad.ok) {
			expect(bad.errors.some((e) => e.includes("netEgress"))).toBe(true);
		}
	});
});
