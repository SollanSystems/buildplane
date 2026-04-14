import { describe, expect, it } from "vitest";
import {
	assertSupportedNodeVersion,
	shouldSuppressCliWarning,
} from "../src/version-guard";

describe("published CLI node guard", () => {
	it("allows Node 24.13.1", () => {
		expect(() => assertSupportedNodeVersion("24.13.1")).not.toThrow();
	});

	it("rejects older patch versions with a clear error", () => {
		expect(() => assertSupportedNodeVersion("24.13.0")).toThrow(
			/Node 24\.13\.1.*24\.13\.0/i,
		);
	});

	it("rejects newer major versions until explicitly blessed", () => {
		expect(() => assertSupportedNodeVersion("25.6.1")).toThrow(
			/Node 24\.13\.1.*25\.6\.1/i,
		);
	});

	it("rejects too-old major versions with a clear error", () => {
		expect(() => assertSupportedNodeVersion("20.11.0")).toThrow(
			/Node 24\.13\.1.*20\.11/i,
		);
	});

	it("suppresses only the sqlite experimental warning", () => {
		expect(
			shouldSuppressCliWarning(
				"SQLite is an experimental feature and might change at any time",
				["ExperimentalWarning"],
			),
		).toBe(true);
		expect(
			shouldSuppressCliWarning(new Error("something else"), [
				"ExperimentalWarning",
			]),
		).toBe(false);
		expect(
			shouldSuppressCliWarning("SQLite is an experimental feature", [
				"Warning",
			]),
		).toBe(false);
	});
});
