import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getBootstrapBanner } from "../src/index";

const root = resolve(import.meta.dirname, "../../..");

describe("cli bootstrap", () => {
	it("returns the buildplane bootstrap banner", () => {
		expect(getBootstrapBanner()).toContain("Buildplane");
	});

	it("emits real CLI output when invoked via the root script entrypoint", () => {
		const output = execFileSync(
			process.execPath,
			["--import", "tsx", "./apps/cli/src/index.ts"],
			{ cwd: root, encoding: "utf8" },
		).trim();

		expect(output).toBe("Buildplane by SollanSystems");
	});
});
