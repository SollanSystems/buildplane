import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(path: string): string {
	return readFileSync(join(root, path), "utf8");
}

/**
 * O6: `changeset publish` publishes apps/cli/package.json AS-IS, whose
 * `workspace:*` dependencies on unpublished internal @buildplane/* packages
 * would ship an uninstallable tarball. The release workflow must instead
 * publish the self-contained, vendored artifact produced by stage-package.mjs.
 */
describe("O6 vendored publish", () => {
	it("wires the release workflow publish command to the vendored release:publish path", () => {
		const pkg = JSON.parse(read("package.json"));
		expect(pkg.scripts?.["release:publish"]).toBeDefined();

		const workflow = read(".github/workflows/release.yml");
		// The changesets/action publish command must be the vendored path.
		expect(workflow).toContain("publish: pnpm release:publish");
		// The raw `changeset publish` (an `npm publish` of apps/cli/package.json
		// AS-IS, carrying workspace:* deps on unpublished @buildplane/* packages)
		// must no longer be the publish command anywhere in the workflow.
		expect(workflow).not.toContain("changeset publish");
	});

	it("publishes through stage-package.mjs (reuses the vendoring, no duplicated logic)", () => {
		const pkg = JSON.parse(read("package.json"));
		const script: string = pkg.scripts["release:publish"];
		expect(script).toContain("publish-npm.mjs");

		const publisher = read("scripts/published-bootstrap/publish-npm.mjs");
		// The publisher imports the shared staging helper rather than
		// re-implementing the vendoring.
		expect(publisher).toContain('from "./stage-package.mjs"');
		expect(publisher).toContain("stagePublishedPackage");
		// It publishes the staged package root, not the repo's apps/cli directory.
		expect(publisher).toContain("packageRoot");
		expect(publisher).toContain("publish");
		// It emits the changesets/action `New tag:` line so the action still
		// creates the git tag + GitHub release for the published version.
		expect(publisher).toContain("New tag:");
	});

	it("creates the local git tag the changesets action pushes", () => {
		const publisher = read("scripts/published-bootstrap/publish-npm.mjs");
		// The action reacts to `New tag:` by running `git push origin <tag>` —
		// against the local ref. The 0.14.0 publish failed exactly here (`src
		// refspec buildplane@0.14.0 does not match any`): the line was printed
		// but the tag was never created. The publisher must create the tag
		// before announcing it.
		expect(publisher).toContain("ensureReleaseTag");
		expect(publisher).toMatch(/execFileSync\(\s*"git",\s*\["tag"/);
	});

	it("skips republish when the version is already on the registry", () => {
		const publisher = read("scripts/published-bootstrap/publish-npm.mjs");
		// With no pending changesets, every push to main re-runs the publish
		// command for the current version; npm rejects republishing (E403), so
		// without a registry check every post-release push turns main red.
		expect(publisher).toContain("isVersionPublished");
		expect(publisher).toMatch(/\["view",/);
	});

	it("derives a published manifest with no workspace:* / internal @buildplane deps", async () => {
		const { derivePublishManifest } = await import(
			"../../scripts/published-bootstrap/manifest.mjs"
		);
		const manifest = derivePublishManifest() as {
			dependencies?: Record<string, string>;
		};
		const deps = manifest.dependencies ?? {};
		for (const [name, specifier] of Object.entries(deps)) {
			expect(name.startsWith("@buildplane/")).toBe(false);
			expect(specifier.startsWith("workspace:")).toBe(false);
			expect(specifier.startsWith("file:")).toBe(false);
			expect(specifier.startsWith("link:")).toBe(false);
		}
		// The full serialized manifest must be free of workspace-protocol leakage.
		expect(JSON.stringify(manifest)).not.toContain("workspace:");
	});
});
