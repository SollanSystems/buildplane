import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const fixtureRoot = join(process.cwd(), "fixtures", "demo-repo");

describe("demo-repo fixture (M6 killer-demo target)", () => {
	it("ships the full fixture tree", () => {
		const expected = [
			"package.json",
			join("src", "server.js"),
			join("test", "login.test.js"),
			"README.md",
			"goal.md",
		];

		for (const relative of expected) {
			expect(
				existsSync(join(fixtureRoot, relative)),
				`expected fixtures/demo-repo/${relative} to exist`,
			).toBe(true);
		}
	});

	it("declares a buildplane-demo-repo package with express", () => {
		const pkg = JSON.parse(
			readFileSync(join(fixtureRoot, "package.json"), "utf8"),
		) as {
			name: string;
			private: boolean;
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};

		expect(pkg.name).toBe("buildplane-demo-repo");
		expect(pkg.private).toBe(true);
		expect(pkg.dependencies?.express).toBeDefined();
		expect(pkg.devDependencies?.["express-rate-limit"]).toBeDefined();
		expect(pkg.devDependencies?.supertest).toBeDefined();
	});

	it("provides a goal.md with a non-empty Tasks section", () => {
		const goal = readFileSync(join(fixtureRoot, "goal.md"), "utf8");

		expect(goal).toContain("## Goal");
		expect(goal).toContain("## Repository context");
		expect(goal).toContain("## Safety constraints");

		const tasksMatch = goal.match(/##\s+Tasks\s*\n([\s\S]*?)(?:\n##\s|$)/);
		expect(tasksMatch, "goal.md must contain a ## Tasks section").not.toBeNull();

		const tasksBody = (tasksMatch?.[1] ?? "").trim();
		expect(tasksBody.length).toBeGreaterThan(0);
		const seedTasks = tasksBody
			.split("\n")
			.filter((line) => /^\s*[-*]\s+\S/.test(line));
		expect(seedTasks.length).toBeGreaterThanOrEqual(2);
	});
});
