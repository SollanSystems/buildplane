import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function readJson(relativePath: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(ROOT, relativePath), "utf8"));
}

describe("apps/web build isolation (M5-S8)", () => {
	it("chains both the vite build and the tsc build into the root build script", () => {
		const pkg = readJson("package.json") as {
			scripts: Record<string, string>;
		};
		// Order-agnostic: apps/web is independent of the TS build graph. The web
		// build runs first so a forwarded `pnpm build --force` reaches `tsc --build`
		// (vite rejects unknown flags) — see test/workflow/published-bootstrap-stage.
		expect(pkg.scripts.build).toContain("tsc --build");
		expect(pkg.scripts.build).toContain("pnpm -C apps/web build");
	});

	it("keeps apps/web OUT of the root tsconfig project references", () => {
		const tsconfig = readJson("tsconfig.json") as {
			references?: { path: string }[];
		};
		const paths = (tsconfig.references ?? []).map((ref) => ref.path);
		// apps/web uses moduleResolution:Bundler + noEmit, incompatible with
		// composite project references — it must never join the root build graph.
		expect(paths.some((p) => p.includes("apps/web"))).toBe(false);
	});

	it("covers apps/web with a standalone tsc --noEmit typecheck", () => {
		const webPkg = readJson("apps/web/package.json") as {
			scripts: Record<string, string>;
		};
		expect(webPkg.scripts.typecheck).toBe("tsc --noEmit");
	});

	it("runs the apps/web typecheck as its own CI step", () => {
		const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
		expect(ci).toMatch(/pnpm -C apps\/web (run )?typecheck/);
	});

	it("gitignores the apps/web/dist build output", () => {
		const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
		const lines = gitignore.split("\n").map((line) => line.trim());
		// The bare `dist/` rule already covers apps/web/dist tree-wide.
		const covered = lines.includes("dist/") || lines.includes("apps/web/dist");
		expect(covered).toBe(true);
	});

	it("declares @buildplane/mission-control-server as an apps/cli dependency", () => {
		const cliPkg = readJson("apps/cli/package.json") as {
			dependencies: Record<string, string>;
		};
		expect(cliPkg.dependencies["@buildplane/mission-control-server"]).toBe(
			"workspace:*",
		);
	});

	it("references mission-control-server from apps/cli tsconfig for the lazy import", () => {
		const cliTsconfig = readJson("apps/cli/tsconfig.json") as {
			references: { path: string }[];
		};
		const paths = cliTsconfig.references.map((ref) => ref.path);
		expect(paths).toContain("../../packages/mission-control-server");
	});
});
