import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CAPABILITY_BUNDLE_SCHEMA_VERSION,
	type CapabilityBundleV0,
} from "@buildplane/capability-broker";
import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../src/index";
import { writeFile } from "../src/write-file";

function m6DemoBundle(): CapabilityBundleV0 {
	return {
		schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
		bundleId: "m6-demo",
		fsWrite: ["src/**", "test/**"],
		tools: { write_file: { enabled: true } },
	};
}

describe("write_file capability broker (src/** test/**)", () => {
	function makeWorktree(): string {
		return mkdtempSync(join(tmpdir(), "bp-tools-cap-"));
	}

	it("allows in-scope write under src/**", () => {
		const root = makeWorktree();
		const result = writeFile({ path: "src/foo.ts", content: "ok" }, root, {
			capabilityBundle: m6DemoBundle(),
		});
		expect(result.success).toBe(true);
		expect(readFileSync(join(root, "src/foo.ts"), "utf8")).toBe("ok");
	});

	it("denies out-of-scope write with broker reason", () => {
		const root = makeWorktree();
		const result = writeFile(
			{ path: "docs/readme.md", content: "nope" },
			root,
			{ capabilityBundle: m6DemoBundle() },
		);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/capability broker/i);
		expect(result.error).toMatch(/fsWrite/i);
		expect(existsSync(join(root, "docs/readme.md"))).toBe(false);
	});

	it("registry forwards capability bundle to write_file", () => {
		const root = makeWorktree();
		const registry = createToolRegistry(root, {
			capabilityBundle: m6DemoBundle(),
		});
		const denied = registry.write_file({
			path: "outside.txt",
			content: "x",
		});
		expect(denied.success).toBe(false);
		expect(denied.error).toMatch(/capability broker/i);
	});

	it("without bundle, only sandbox applies (backward compatible)", () => {
		const root = makeWorktree();
		const result = writeFile({ path: "anywhere.txt", content: "ok" }, root);
		expect(result.success).toBe(true);
	});
});
