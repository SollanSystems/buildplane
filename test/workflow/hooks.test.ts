import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(path: string) {
	return readFileSync(join(root, path), "utf8");
}

describe("local git hooks and commit policy", () => {
	it("defines the expected husky hooks", () => {
		expect(existsSync(join(root, ".husky/pre-commit"))).toBe(true);
		expect(existsSync(join(root, ".husky/commit-msg"))).toBe(true);
		expect(existsSync(join(root, ".husky/pre-push"))).toBe(true);

		expect(read(".husky/pre-commit")).toContain("pnpm lint");
		expect(read(".husky/commit-msg")).toContain('commitlint --edit "$1"');
		expect(read(".husky/pre-push")).toContain("pnpm check");
	});

	it("defines commitlint with the conventional baseline and husky prepare hook", () => {
		const pkg = JSON.parse(read("package.json"));
		const commitlint = read("commitlint.config.cjs");

		expect(pkg.scripts?.prepare).toBe("husky");
		expect(pkg.devDependencies?.husky).toBeDefined();
		expect(pkg.devDependencies?.["@commitlint/cli"]).toBeDefined();
		expect(
			pkg.devDependencies?.["@commitlint/config-conventional"],
		).toBeDefined();
		expect(commitlint).toContain("@commitlint/config-conventional");
	});
});
