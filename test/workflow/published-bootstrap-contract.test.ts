import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const root = process.cwd();
const rootPkg = readJson("package.json");
const cliPkg = readJson("apps/cli/package.json");

function readJson(path: string) {
	return JSON.parse(readFileSync(join(root, path), "utf8"));
}

describe("published bootstrap contract", () => {
	describe("root package.json scripts", () => {
		it("defines stage:published-bootstrap script", () => {
			expect(rootPkg.scripts?.["stage:published-bootstrap"]).toBe(
				"node ./scripts/published-bootstrap/stage-package.mjs",
			);
		});

		it("defines verify:published-bootstrap script", () => {
			expect(rootPkg.scripts?.["verify:published-bootstrap"]).toBe(
				"node ./scripts/published-bootstrap/verify-positive.mjs",
			);
		});
	});

	describe("apps/cli/package.json source of truth", () => {
		it("is named buildplane", () => {
			expect(cliPkg.name).toBe("buildplane");
		});

		it("is publishable — no private flag, public access (M6-S13)", () => {
			expect(cliPkg.private).toBeUndefined();
			expect(cliPkg.publishConfig?.access).toBe("public");
		});

		it("points bin.buildplane at the built artifact", () => {
			expect(cliPkg.bin?.buildplane).toBe("./dist/index.js");
		});

		it("declares a supported Node 24 runtime range", () => {
			expect(cliPkg.engines?.node).toBe(">=24.13.1 <25");
		});
	});

	describe("derived publish manifest", () => {
		let derivePublishManifest: (
			sourceManifest?: Record<string, unknown>,
		) => Record<string, unknown>;
		let publishManifest: Record<string, unknown>;

		beforeAll(async () => {
			const mod = await import(
				"../../scripts/published-bootstrap/manifest.mjs"
			);
			derivePublishManifest = mod.derivePublishManifest;
			publishManifest = derivePublishManifest();
		});

		it("keeps the package name", () => {
			expect(publishManifest.name).toBe("buildplane");
		});

		it("omits private field", () => {
			expect(publishManifest.private).toBeUndefined();
		});

		it("keeps version aligned with apps/cli/package.json", () => {
			expect(publishManifest.version).toBe(cliPkg.version);
		});

		it("keeps description", () => {
			expect(publishManifest.description).toBe("Buildplane CLI");
		});

		it("keeps type", () => {
			expect(publishManifest.type).toBe("module");
		});

		it("keeps bin.buildplane", () => {
			const bin = publishManifest.bin as Record<string, string>;
			expect(bin?.buildplane).toBe("./dist/index.js");
		});

		it("keeps engines.node range", () => {
			const engines = publishManifest.engines as Record<string, string>;
			expect(engines?.node).toBe(">=24.13.1 <25");
		});

		it("emits files covering dist, vendor, and README.md", () => {
			const files = publishManifest.files as string[];
			expect(files).toContain("dist");
			expect(files).toContain("vendor");
			expect(files).toContain("README.md");
			expect(files).toHaveLength(3);
		});

		it("omits workspace-only scripts", () => {
			const scripts = publishManifest.scripts as
				| Record<string, string>
				| undefined;
			// The derived manifest should have no scripts at all,
			// since the source scripts are workspace-only
			expect(scripts).toBeUndefined();
		});

		it("omits internal @buildplane/* runtime dependencies", () => {
			const deps = (publishManifest.dependencies ?? {}) as Record<
				string,
				string
			>;
			for (const key of Object.keys(deps)) {
				expect(key).not.toMatch(/^@buildplane\//);
			}
		});

		it("keeps publish-safe external runtime dependencies", () => {
			const manifest = derivePublishManifest({
				...cliPkg,
				dependencies: {
					"@buildplane/runtime": "workspace:*",
					chalk: "^5.6.2",
				},
			});

			expect(manifest.dependencies).toEqual({
				chalk: "^5.6.2",
			});
		});

		it("includes uuid for the vendored ledger client runtime", () => {
			const deps = (publishManifest.dependencies ?? {}) as Record<
				string,
				string
			>;
			expect(deps.uuid).toBe("^14");
		});

		it("rejects publish-unsafe external dependency specifiers", () => {
			const unsafeSpecs = [
				"workspace:*",
				"file:../shared-runtime",
				"link:../shared-runtime",
				"/tmp/shared-runtime",
				"C:\\temp\\shared-runtime",
				".",
				"..",
				"../shared-runtime",
				"./shared-runtime",
				"..\\shared-runtime",
				".\\shared-runtime",
				"\\temp\\shared-runtime",
				"C:temp\\shared-runtime",
			];

			for (const unsafeSpec of unsafeSpecs) {
				let thrown: Error | undefined;

				try {
					derivePublishManifest({
						...cliPkg,
						dependencies: {
							chalk: unsafeSpec,
						},
					});
				} catch (error) {
					thrown = error as Error;
				}

				expect(thrown).toBeInstanceOf(Error);
				expect(thrown?.message).toContain("chalk");
				expect(thrown?.message).toContain(unsafeSpec);
			}
		});

		it("emits no lifecycle install hooks", () => {
			const scripts = publishManifest.scripts as
				| Record<string, string>
				| undefined;
			if (scripts) {
				expect(scripts.preinstall).toBeUndefined();
				expect(scripts.install).toBeUndefined();
				expect(scripts.postinstall).toBeUndefined();
			}
		});
	});
});
