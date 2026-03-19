import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");

describe("README contract", () => {
	it("documents the repo-dev bootstrap command", () => {
		expect(readme).toContain("pnpm buildplane init");
	});

	it("documents the in-repo built CLI path", () => {
		expect(readme).toContain("node apps/cli/dist/index.js init");
	});

	it("mentions the clean git working tree precondition", () => {
		expect(readme).toMatch(/clean git working tree/i);
	});

	it("includes a labeled distribution or published-install note", () => {
		expect(readme).toMatch(/distribution|published.*(install|usage)/i);
	});

	it("does not present npm install -g as the current bootstrap path", () => {
		expect(readme).not.toMatch(/npm install -g buildplane/);
	});
});
