import { describe, expect, it } from "vitest";
import { assertSupportedNodeVersion } from "../src/version-guard";

describe("published CLI node guard", () => {
	it("allows Node 24.13.1", () => {
		expect(() => assertSupportedNodeVersion("24.13.1")).not.toThrow();
	});

	it("rejects other versions with a clear error", () => {
		expect(() => assertSupportedNodeVersion("24.13.0")).toThrow(
			/Node 24\.13\.1.*24\.13\.0/i,
		);
	});
});
