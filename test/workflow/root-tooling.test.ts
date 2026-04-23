import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function readJson(path: string) {
	return JSON.parse(readFileSync(join(root, path), "utf8"));
}

describe("root workflow tooling", () => {
	it("pins node and defines canonical workflow scripts", () => {
		const pkg = readJson("package.json");

		expect(existsSync(join(root, ".node-version"))).toBe(true);
		expect(pkg.engines?.node).toBe("24.13.1");
		expect(pkg.scripts?.lint).toBe("biome check .");
		expect(pkg.scripts?.format).toBe("biome format --write .");
		expect(pkg.scripts?.["ledger:gen"]).toBe(
			"bash ./scripts/ledger/generate-schema.sh",
		);
		expect(pkg.scripts?.["ledger:gen-fixtures"]).toBe(
			"bash ./scripts/ledger/gen-fixtures.sh",
		);
		expect(pkg.scripts?.check).toBe(
			"pnpm lint && pnpm typecheck && pnpm test && pnpm build",
		);
	});

	it("exposes the dev bootstrap script in the root workspace", () => {
		const pkg = readJson("package.json");

		expect(pkg.scripts?.buildplane).toBe(
			"node --conditions=source --import tsx ./apps/cli/src/index.ts",
		);
		expect(pkg.scripts?.typecheck).toContain("pnpm exec tsc --build");
	});

	it("keeps apps/cli bin.buildplane pointed at the built artifact", () => {
		const cliPkg = readJson("apps/cli/package.json");

		expect(cliPkg.bin?.buildplane).toBe("./dist/index.js");
	});

	it("installs biome and enables formatter, linter, import organization, and git-aware ignores", () => {
		const pkg = readJson("package.json");
		const biome = readJson("biome.json");

		expect(pkg.devDependencies?.["@biomejs/biome"]).toBeDefined();
		expect(biome.formatter?.enabled).toBe(true);
		expect(biome.linter?.enabled).toBe(true);
		expect(biome.assist?.enabled).toBe(true);
		expect(biome.assist?.actions?.source?.organizeImports).toBe("on");
		expect(biome.vcs?.enabled).toBe(true);
		expect(biome.vcs?.useIgnoreFile).toBe(true);
	});
});
