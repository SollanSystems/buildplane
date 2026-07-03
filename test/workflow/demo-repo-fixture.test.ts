import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compile, validate } from "@buildplane/planforge";
import { describe, expect, it } from "vitest";

const fixtureRoot = join(process.cwd(), "fixtures", "demo-repo");

const TRUSTED_BASE_PLACEHOLDER = "<stamped-at-staging>";

describe("demo-repo fixture (M6 killer-demo target)", () => {
	it("ships the full fixture tree", () => {
		const expected = [
			"package.json",
			// Pinned lockfile so worktree provisioning takes the `npm ci` path —
			// a lockfile-less `npm install` GENERATES package-lock.json inside the
			// worker worktree, and the run-admission gate rejects the dirty tree.
			"package-lock.json",
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
		expect(
			tasksMatch,
			"goal.md must contain a ## Tasks section",
		).not.toBeNull();

		const tasksBody = (tasksMatch?.[1] ?? "").trim();
		expect(tasksBody.length).toBeGreaterThan(0);
		const seedTasks = tasksBody
			.split("\n")
			.filter((line) => /^\s*[-*]\s+\S/.test(line));
		expect(seedTasks.length).toBeGreaterThanOrEqual(2);
	});

	it("carries the trusted-base placeholder the demo stager stamps", () => {
		const goal = readFileSync(join(fixtureRoot, "goal.md"), "utf8");
		expect(goal).toContain(`- Trusted base: ${TRUSTED_BASE_PLACEHOLDER}`);
	});

	it("compiles and validates PASS once the trusted base is stamped (runbook step 3)", () => {
		const raw = readFileSync(join(fixtureRoot, "goal.md"), "utf8");
		const stamped = raw.replace(
			TRUSTED_BASE_PLACEHOLDER,
			"0123456789abcdef0123456789abcdef01234567",
		);

		const compiled = compile(stamped, "goal.md");
		const { status, validation } = validate(compiled);

		expect(validation.missingEvidence).toEqual([]);
		expect(validation.unsafeReasons).toEqual([]);
		expect(status).toBe("PASS");
		expect(compiled.trustedBase).toBe(
			"0123456789abcdef0123456789abcdef01234567",
		);
		expect(compiled.parsedTasks).toHaveLength(1);
		const task = compiled.parsedTasks[0];
		expect(task.allowedSideEffects).toContain("code-edit");
		expect(task.verificationCommands).toEqual(["npm test"]);
	});
});
