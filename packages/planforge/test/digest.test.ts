import { describe, expect, it } from "vitest";
import { canonicalJson, digest } from "../src/digest.ts";

describe("canonical digest", () => {
	it("is invariant to object key order", () => {
		expect(digest({ a: 1, b: { c: 2, d: 3 } })).toBe(
			digest({ b: { d: 3, c: 2 }, a: 1 }),
		);
	});

	it("sorts keys recursively in canonicalJson", () => {
		expect(canonicalJson({ b: { d: 3, c: 2 }, a: 1 })).toBe(
			'{"a":1,"b":{"c":2,"d":3}}',
		);
	});

	it("preserves array order while sorting nested object keys", () => {
		expect(canonicalJson([{ y: 1, x: 2 }, "z"])).toBe('[{"x":2,"y":1},"z"]');
	});

	it("prefixes the sha256 hex of the canonical bytes", () => {
		const value = digest("hello");
		expect(value).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	it("distinguishes values that differ", () => {
		expect(digest({ a: 1 })).not.toBe(digest({ a: 2 }));
	});
});
