import { describe, expect, it } from "vitest";
import { SUPPORTED_NODE_RANGE } from "../src/capabilities";
import {
	assertPublishedCliNodeVersion,
	assertSupportedNodeVersion,
	shouldBypassNodeVersionGuardForArgv,
	shouldSuppressCliWarning,
} from "../src/version-guard";

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("published CLI node guard", () => {
	it("allows compatible Node 24 versions", () => {
		expect(() => assertSupportedNodeVersion("24.13.1")).not.toThrow();
		expect(() => assertSupportedNodeVersion("24.13.2")).not.toThrow();
		expect(() => assertSupportedNodeVersion("24.14.0")).not.toThrow();
	});

	it("rejects versions below the supported range with a clear error", () => {
		const rangePattern = escapeRegExp(SUPPORTED_NODE_RANGE);
		expect(() => assertSupportedNodeVersion("24.13.0")).toThrow(
			new RegExp(`Node ${rangePattern}.*24\\.13\\.0`, "i"),
		);
		expect(() => assertSupportedNodeVersion("20.11.0")).toThrow(
			new RegExp(`Node ${rangePattern}.*20\\.11`, "i"),
		);
	});

	it("rejects newer major versions until explicitly blessed", () => {
		const rangePattern = escapeRegExp(SUPPORTED_NODE_RANGE);
		expect(() => assertSupportedNodeVersion("25.6.1")).toThrow(
			new RegExp(`Node ${rangePattern}.*25\\.6\\.1`, "i"),
		);
	});

	it("rejects malformed node versions", () => {
		expect(() => assertSupportedNodeVersion("not-a-version")).toThrow(
			/Node >=24\.13\.1 <25.*not-a-version/i,
		);
	});

	it("requires node:sqlite for non-doctor runtime paths", () => {
		expect(() =>
			assertPublishedCliNodeVersion(["run"], "24.13.2", {
				nodeSqliteAvailable: false,
			}),
		).toThrow(/requires the Node node:sqlite runtime feature/i);
		expect(() =>
			assertPublishedCliNodeVersion(["run"], "24.13.2", {
				nodeSqliteAvailable: () => true,
			}),
		).not.toThrow();
		expect(() =>
			assertPublishedCliNodeVersion(
				["bootstrap", "doctor", "--capabilities", "--json"],
				"24.13.2",
				{ nodeSqliteAvailable: false },
			),
		).not.toThrow();
	});

	it("bypasses the hard node guard only for exact bootstrap doctor forms", () => {
		expect(shouldBypassNodeVersionGuardForArgv(["bootstrap", "doctor"])).toBe(
			true,
		);
		expect(
			shouldBypassNodeVersionGuardForArgv(["bootstrap", "doctor", "--json"]),
		).toBe(true);
		expect(
			shouldBypassNodeVersionGuardForArgv([
				"bootstrap",
				"doctor",
				"--capabilities",
			]),
		).toBe(true);
		expect(
			shouldBypassNodeVersionGuardForArgv([
				"bootstrap",
				"doctor",
				"--capabilities",
				"--json",
			]),
		).toBe(true);
		expect(
			shouldBypassNodeVersionGuardForArgv([
				"bootstrap",
				"doctor",
				"--json",
				"--capabilities",
			]),
		).toBe(true);
		expect(
			shouldBypassNodeVersionGuardForArgv(["bootstrap", "doctor", "--help"]),
		).toBe(false);
		expect(
			shouldBypassNodeVersionGuardForArgv([
				"bootstrap",
				"doctor",
				"unexpected",
			]),
		).toBe(false);
		expect(
			shouldBypassNodeVersionGuardForArgv([
				"bootstrap",
				"doctor",
				"--json",
				"unexpected",
			]),
		).toBe(false);
		expect(
			shouldBypassNodeVersionGuardForArgv([
				"bootstrap",
				"doctor",
				"--capabilities",
				"--capabilities",
			]),
		).toBe(false);
		expect(
			shouldBypassNodeVersionGuardForArgv([
				"bootstrap",
				"doctor",
				"--capabilities",
				"unexpected",
			]),
		).toBe(false);
		expect(shouldBypassNodeVersionGuardForArgv(["bootstrap"])).toBe(false);
		expect(shouldBypassNodeVersionGuardForArgv(["--help"])).toBe(false);
		expect(shouldBypassNodeVersionGuardForArgv(["run", "--help"])).toBe(false);
	});

	it("allows only exact bootstrap doctor forms on unsupported node while keeping other commands strict", () => {
		expect(() =>
			assertPublishedCliNodeVersion(
				["bootstrap", "doctor", "--json"],
				"22.22.2",
			),
		).not.toThrow();
		expect(() =>
			assertPublishedCliNodeVersion(
				["bootstrap", "doctor", "--capabilities", "--json"],
				"22.22.2",
			),
		).not.toThrow();
		expect(() =>
			assertPublishedCliNodeVersion(
				["bootstrap", "doctor", "--help"],
				"22.22.2",
			),
		).toThrow(/Node >=24\.13\.1 <25.*22\.22\.2/i);
		expect(() =>
			assertPublishedCliNodeVersion(
				["bootstrap", "doctor", "unexpected"],
				"22.22.2",
			),
		).toThrow(/Node >=24\.13\.1 <25.*22\.22\.2/i);
		expect(() => assertPublishedCliNodeVersion(["--help"], "22.22.2")).toThrow(
			/Node >=24\.13\.1 <25.*22\.22\.2/i,
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
