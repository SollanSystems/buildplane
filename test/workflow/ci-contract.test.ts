import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ciWorkflow = readFileSync(
	join(process.cwd(), ".github/workflows/ci.yml"),
	"utf8",
);

describe("CI trust gate contract", () => {
	it("runs explicit deterministic verification steps", () => {
		for (const { name, command } of [
			{ name: "Run lint", command: "pnpm lint" },
			{ name: "Run typecheck", command: "pnpm typecheck" },
			{ name: "Run tests", command: "pnpm test" },
			{ name: "Run build", command: "pnpm build" },
			{
				name: "Run Rust tests",
				command: "cargo test --manifest-path native/Cargo.toml",
			},
			{
				name: "Verify published bootstrap",
				command: "pnpm verify:published-bootstrap",
			},
		]) {
			expect(ciWorkflow).toContain(`name: ${name}`);
			expect(ciWorkflow).toContain(`run: ${command}`);
		}
	});

	it("keeps the wrong-Node guard job", () => {
		expect(ciWorkflow).toContain("verify-wrong-node");
		expect(ciWorkflow).toContain("24.13.0");
		expect(ciWorkflow).toContain("Verify wrong-Node guard");
	});
});
