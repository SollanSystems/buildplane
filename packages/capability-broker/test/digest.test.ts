import { digest } from "@buildplane/planforge";
import { describe, expect, it } from "vitest";
import { bundleDigest } from "../src/digest.ts";
import { CAPABILITY_BUNDLE_SCHEMA_VERSION } from "../src/schema.ts";

/** Frozen golden bundle for M3-S1 receipt documentation. */
export const GOLDEN_CAPABILITY_BUNDLE = {
	schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
	bundleId: "golden-m3-s1",
	fsWrite: ["src/**", "test/**"],
	tools: {
		run_command: { allowlist: ["npm", "git"] },
		write_file: { enabled: true },
	},
};

describe("bundleDigest", () => {
	it("delegates to planforge canonical digest", () => {
		const bundle = {
			schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
			bundleId: "a",
			fsWrite: ["src/**"],
		};
		expect(bundleDigest(bundle)).toBe(digest(bundle));
	});

	it("is invariant to object key order", () => {
		const a = {
			schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
			bundleId: "order-test",
			tools: { run_command: { allowlist: ["npm"] } },
			fsWrite: ["a/**"],
		};
		const b = {
			fsWrite: ["a/**"],
			bundleId: "order-test",
			schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
			tools: { run_command: { allowlist: ["npm"] } },
		};
		expect(bundleDigest(a)).toBe(bundleDigest(b));
	});

	it("matches frozen golden vector", () => {
		const actual = bundleDigest(GOLDEN_CAPABILITY_BUNDLE);
		expect(actual).toBe(
			"sha256:c8f199e958714b3d7d7c3e7c5d9887e7658e2ccdaef7d632fe9b7543d59d3058",
		);
		expect(actual).toBe(digest(GOLDEN_CAPABILITY_BUNDLE));
	});
});
