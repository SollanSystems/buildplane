import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function readText(path: string): string {
	return readFileSync(join(root, path), "utf8");
}

interface Semver {
	major: number;
	minor: number;
	patch: number;
}

function parseSemver(version: string): Semver {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match) {
		throw new Error(`unparseable semver: ${version}`);
	}
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
	};
}

function compareSemver(a: string, b: string): number {
	const pa = parseSemver(a);
	const pb = parseSemver(b);
	if (pa.major !== pb.major) {
		return pa.major - pb.major;
	}
	if (pa.minor !== pb.minor) {
		return pa.minor - pb.minor;
	}
	return pa.patch - pb.patch;
}

type Bump = "major" | "minor" | "patch";
const BUMP_RANK: Record<Bump, number> = { patch: 1, minor: 2, major: 3 };

function applyBump(version: string, bump: Bump): string {
	const s = parseSemver(version);
	if (bump === "major") {
		return `${s.major + 1}.0.0`;
	}
	if (bump === "minor") {
		return `${s.major}.${s.minor + 1}.0`;
	}
	return `${s.major}.${s.minor}.${s.patch + 1}`;
}

/** Highest bump declared for the `buildplane` package across all changesets. */
function highestBuildplaneBump(): Bump | null {
	const dir = join(root, ".changeset");
	let highest: Bump | null = null;
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".md") || file.toLowerCase() === "readme.md") {
			continue;
		}
		const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(
			readText(`.changeset/${file}`),
		);
		if (!frontmatter) {
			continue;
		}
		for (const line of frontmatter[1].split(/\r?\n/)) {
			const entry = /^"?([^":]+)"?\s*:\s*(major|minor|patch)\s*$/.exec(
				line.trim(),
			);
			if (!entry || entry[1] !== "buildplane") {
				continue;
			}
			const bump = entry[2] as Bump;
			if (highest === null || BUMP_RANK[bump] > BUMP_RANK[highest]) {
				highest = bump;
			}
		}
	}
	return highest;
}

describe("M6-S13 public release cut", () => {
	const cliPkg = readJson("apps/cli/package.json");
	const changesetConfig = readJson(".changeset/config.json");

	it("makes apps/cli publishable — no private flag, public access", () => {
		expect(cliPkg.private).toBeUndefined();
		expect(
			(cliPkg.publishConfig as { access?: string } | undefined)?.access,
		).toBe("public");
	});

	it("keeps the buildplane bin and drops the stale gsd2 bin", () => {
		const bin = cliPkg.bin as Record<string, string> | undefined;
		expect(bin?.buildplane).toBe("./dist/index.js");
		expect(bin?.gsd2).toBeUndefined();
	});

	it("sets changesets access to public", () => {
		expect(changesetConfig.access).toBe("public");
	});

	it("ships an MIT LICENSE file", () => {
		const license = readText("LICENSE");
		expect(license).toContain("MIT License");
		expect(license).toMatch(/Sollan Systems/i);
	});

	it("guards the npm version against a downgrade to 0.5.0", () => {
		const current = cliPkg.version as string;
		// The GitHub-release tag `v0.5.0` is independent of npm semver. npm rejects
		// publishing a version lower than the current published 0.12.2, so the
		// package version must never be hand-set to 0.5.0 — it continues upward
		// from 0.12.2 via changesets.
		expect(current).not.toBe("0.5.0");
		expect(compareSemver(current, "0.12.2")).toBeGreaterThanOrEqual(0);

		const bump = highestBuildplaneBump();
		expect(bump).not.toBeNull();
		const next = applyBump(current, bump as Bump);
		expect(next).not.toBe("0.5.0");
		expect(compareSemver(next, "0.12.2")).toBeGreaterThan(0);
		expect(compareSemver(next, "0.13.0")).toBeGreaterThanOrEqual(0);
	});

	it("wires the release workflow to publish with a guarded npm credential", () => {
		const workflow = readText(".github/workflows/release.yml");
		// M6-O6: publish the vendored staged artifact, not the raw apps/cli package.
		expect(workflow).toContain("release:publish");
		expect(workflow).toContain("NPM_TOKEN");
		expect(workflow).toContain("secrets.RELEASE_TOKEN || secrets.GITHUB_TOKEN");
		// A missing NPM_TOKEN on a release-landing push must fail loud.
		expect(workflow).toMatch(/::error::/);
	});

	it("carries a coordinating changeset that bumps buildplane", () => {
		expect(highestBuildplaneBump()).not.toBeNull();
	});
});
