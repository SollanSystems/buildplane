import type { TaskIntent } from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import {
	createClaudeRenderer,
	createCodexRenderer,
} from "../src/renderers/index.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const minimalIntent: TaskIntent = {
	objective: "Add a health-check endpoint to the Express server.",
	taskType: "implement",
	context: {
		files: ["src/server.ts"],
		priorWork: [],
		memories: [],
	},
	constraints: {
		scope: ["src/"],
		verification: ["pnpm test", "pnpm typecheck"],
	},
	features: {
		ambiguity: "low",
		reversibility: "easy",
		verifierStrength: "strong",
		language: "TypeScript",
		framework: "Express",
		estimatedComplexity: "low",
	},
};

const richIntent: TaskIntent = {
	objective: "Refactor authentication middleware to use JWT.",
	taskType: "refactor",
	context: {
		files: ["src/auth.ts", "src/middleware.ts"],
		priorWork: ["Implemented basic session auth in task 1"],
		memories: ["MEM042", "MEM017"],
		codebaseHints: "Use the node:crypto module, not external libs.",
		retryContext: "Previous attempt failed: missing token expiry check.",
	},
	constraints: {
		scope: ["src/auth.ts", "src/middleware.ts"],
		forbidden: ["src/legacy/"],
		verification: ["pytest tests/", "ruff check ."],
	},
	features: {
		ambiguity: "medium",
		reversibility: "hard",
		verifierStrength: "strong",
		language: "TypeScript",
		estimatedComplexity: "high",
	},
};

// ---------------------------------------------------------------------------
// Claude renderer
// ---------------------------------------------------------------------------

describe("createClaudeRenderer", () => {
	const renderer = createClaudeRenderer();

	it("has provider=anthropic", () => {
		expect(renderer.provider).toBe("anthropic");
	});

	it("produces an 8-section prompt from a minimal TaskIntent", () => {
		const { prompt } = renderer.render(minimalIntent, "implementer");

		// Section 1 — task header
		expect(prompt).toContain("Implementation Task");
		expect(prompt).toContain("IMPLEMENT");
		expect(prompt).toContain(minimalIntent.objective);

		// Section 2 — safe autonomy contract
		expect(prompt).toContain("Safe Autonomy Contract");
		expect(prompt).toContain("You may autonomously");

		// Section 3 — instructions
		expect(prompt).toContain("Instructions");
		expect(prompt).toContain("Implement the described feature");

		// Section 7 — preset
		expect(prompt).toContain("Preset");
		expect(prompt).toContain("pnpm test");
		expect(prompt).toContain("pnpm typecheck");
		expect(prompt).toContain("src/");
	});

	it("adapts section content for reviewer role", () => {
		const { prompt } = renderer.render(minimalIntent, "reviewer");

		expect(prompt).toContain("Code Review Task");
		// Reviewer autonomy contract is different
		expect(prompt).toContain("reviewer");
		expect(prompt).toContain(
			"Do NOT modify source files unless explicitly correcting",
		);
		// Instructions are review-focused
		expect(prompt).toContain("Produce a verdict");
	});

	it("adapts for adversary role", () => {
		const { prompt } = renderer.render(minimalIntent, "adversary");

		expect(prompt).toContain("Adversarial Review Task");
		expect(prompt).toContain("adversary");
	});

	it("includes codebase hints when present", () => {
		const { prompt } = renderer.render(richIntent, "implementer");

		expect(prompt).toContain("Codebase Conventions");
		expect(prompt).toContain("node:crypto module");
	});

	it("includes memories when present", () => {
		const { prompt } = renderer.render(richIntent, "implementer");

		expect(prompt).toContain("Relevant Memories");
		expect(prompt).toContain("MEM042");
		expect(prompt).toContain("MEM017");
	});

	it("includes prior work when present", () => {
		const { prompt } = renderer.render(richIntent, "implementer");

		expect(prompt).toContain("Prior Work in This Strategy");
		expect(prompt).toContain("Implemented basic session auth");
	});

	it("includes retry context when present", () => {
		const { prompt } = renderer.render(richIntent, "implementer");

		expect(prompt).toContain("Retry Context");
		expect(prompt).toContain("missing token expiry check");
	});

	it("omits retry context section when none provided", () => {
		const { prompt } = renderer.render(minimalIntent, "implementer");

		expect(prompt).not.toContain("Retry Context");
	});

	it("includes forbidden paths in autonomy contract", () => {
		const { prompt } = renderer.render(richIntent, "implementer");

		expect(prompt).toContain("src/legacy/");
		expect(prompt).toContain("MUST NOT");
	});

	it("includes verification commands in preset", () => {
		const { prompt } = renderer.render(richIntent, "implementer");

		expect(prompt).toContain("pytest tests/");
		expect(prompt).toContain("ruff check .");
	});

	it("handles missing optional fields gracefully", () => {
		const bare: TaskIntent = {
			objective: "Do something.",
			taskType: "implement",
			context: { files: [] },
			constraints: { scope: ["./"], verification: [] },
			features: {
				ambiguity: "low",
				reversibility: "easy",
				verifierStrength: "none",
			},
		};
		// Should not throw
		expect(() => renderer.render(bare, "implementer")).not.toThrow();
		const { prompt } = renderer.render(bare, "implementer");
		expect(prompt).toContain("Do something.");
	});
});

// ---------------------------------------------------------------------------
// Codex renderer
// ---------------------------------------------------------------------------

describe("createCodexRenderer", () => {
	const renderer = createCodexRenderer();

	it("has provider=openai", () => {
		expect(renderer.provider).toBe("openai");
	});

	it("produces a structured XML prompt from a minimal TaskIntent", () => {
		const { prompt } = renderer.render(minimalIntent, "implementer");

		// XML-style blocks
		expect(prompt).toContain("<task");
		expect(prompt).toContain("</task>");
		expect(prompt).toContain("<context>");
		expect(prompt).toContain("</context>");
		expect(prompt).toContain("<constraints>");
		expect(prompt).toContain("</constraints>");

		// Objective inside task block
		expect(prompt).toContain(minimalIntent.objective);

		// Files inside context
		expect(prompt).toContain("src/server.ts");
	});

	it("adapts for reviewer role with work-to-review block", () => {
		const { prompt } = renderer.render(richIntent, "reviewer");

		expect(prompt).toContain('role="reviewer"');
		expect(prompt).toContain("work-to-review");
		expect(prompt).toContain("Produce a verdict");
	});

	it("adapts for adversary role", () => {
		const { prompt } = renderer.render(richIntent, "adversary");

		expect(prompt).toContain('role="adversary"');
		expect(prompt).toContain("adversarial reviewer");
	});

	it("includes codebase-hints block when present", () => {
		const { prompt } = renderer.render(richIntent, "implementer");

		expect(prompt).toContain("<codebase-hints>");
		expect(prompt).toContain("node:crypto module");
	});

	it("includes memories block when present", () => {
		const { prompt } = renderer.render(richIntent, "implementer");

		expect(prompt).toContain("<memories>");
		expect(prompt).toContain("MEM042");
	});

	it("includes prior-work block (implementer label) when present", () => {
		const { prompt } = renderer.render(richIntent, "implementer");

		expect(prompt).toContain("<prior-work>");
		expect(prompt).toContain("Implemented basic session auth");
	});

	it("includes verification-gates block when verification commands present", () => {
		const { prompt } = renderer.render(minimalIntent, "implementer");

		expect(prompt).toContain("<verification-gates>");
		expect(prompt).toContain("pnpm test");
	});

	it("includes retry block when retry context present", () => {
		const { prompt } = renderer.render(richIntent, "implementer");

		expect(prompt).toContain("<retry>");
		expect(prompt).toContain("missing token expiry check");
	});

	it("omits retry block when no retry context", () => {
		const { prompt } = renderer.render(minimalIntent, "implementer");

		expect(prompt).not.toContain("<retry>");
	});

	it("includes forbidden block when forbidden paths present", () => {
		const { prompt } = renderer.render(richIntent, "implementer");

		expect(prompt).toContain("<forbidden>");
		expect(prompt).toContain("src/legacy/");
	});

	it("omits forbidden block when no forbidden paths", () => {
		const { prompt } = renderer.render(minimalIntent, "implementer");

		expect(prompt).not.toContain("<forbidden>");
	});

	it("includes complexity attribute on task block when present", () => {
		const { prompt } = renderer.render(richIntent, "implementer");

		expect(prompt).toContain('complexity="high"');
	});

	it("handles missing optional fields gracefully", () => {
		const bare: TaskIntent = {
			objective: "Do something.",
			taskType: "implement",
			context: { files: [] },
			constraints: { scope: ["./"], verification: [] },
			features: {
				ambiguity: "low",
				reversibility: "easy",
				verifierStrength: "none",
			},
		};
		expect(() => renderer.render(bare, "implementer")).not.toThrow();
		const { prompt } = renderer.render(bare, "implementer");
		expect(prompt).toContain("Do something.");
	});
});
