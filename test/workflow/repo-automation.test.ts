import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(path: string) {
	return readFileSync(join(root, path), "utf8");
}

describe("repository automation", () => {
	it("defines CI that mirrors the local workflow", () => {
		expect(existsSync(join(root, ".github/workflows/ci.yml"))).toBe(true);

		const workflow = read(".github/workflows/ci.yml");
		expect(workflow).toContain("pnpm lint");
		expect(workflow).toContain("pnpm typecheck");
		expect(workflow).toContain("pnpm test");
		expect(workflow).toContain("pnpm build");
		expect(workflow).toContain("node-version-file: .node-version");
	});

	it("defines dependabot and the PR checklist", () => {
		expect(existsSync(join(root, ".github/dependabot.yml"))).toBe(true);
		expect(existsSync(join(root, ".github/pull_request_template.md"))).toBe(
			true,
		);

		const dependabot = read(".github/dependabot.yml");
		const prTemplate = read(".github/pull_request_template.md");

		expect(dependabot).toContain("package-ecosystem: npm");
		expect(dependabot).toContain("package-ecosystem: github-actions");
		expect(prTemplate).toContain("pnpm check");
		expect(prTemplate).toContain("changeset");
	});
});
