import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(path: string) {
	return readFileSync(join(root, path), "utf8");
}

describe("release automation scaffolding", () => {
	it("defines changesets in package scripts and config", () => {
		const pkg = JSON.parse(read("package.json"));
		const changeset = JSON.parse(read(".changeset/config.json"));

		expect(pkg.devDependencies?.["@changesets/cli"]).toBeDefined();
		expect(pkg.scripts?.changeset).toBe("changeset");
		expect(pkg.scripts?.["changeset:status"]).toBe(
			"changeset status --verbose",
		);
		expect(changeset.baseBranch).toBe("main");
		// M6-S13 cut the package public.
		expect(changeset.access).toBe("public");
	});

	it("defines a release workflow that updates the release PR and publishes to npm", () => {
		expect(existsSync(join(root, ".github/workflows/release.yml"))).toBe(true);

		const workflow = read(".github/workflows/release.yml");
		expect(workflow).toContain("changesets/action");
		expect(workflow).toContain("Create Release PR");
		expect(workflow).toContain("permissions:");
		// M6-S13 wired the publish path guarded by NPM_TOKEN; M6-O6 repointed it at
		// the vendored staged artifact (release:publish) instead of the raw
		// `changeset publish` of apps/cli/package.json.
		expect(workflow).toContain("release:publish");
		expect(workflow).toContain("NPM_TOKEN");
	});
});
