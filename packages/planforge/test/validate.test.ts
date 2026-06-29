import { describe, expect, it } from "vitest";
import { compile } from "../src/compile.ts";
import type { PlanForgeRiskClass } from "../src/schema.ts";
import { validate } from "../src/validate.ts";

const REPOSITORY_CONTEXT = `## Repository context

- Remote: https://github.com/SollanSystems/buildplane.git
- Trusted base: 15dbb32db0e1f0024687533755805fc23f3ef6d4
- Worktree policy: isolated-worktree-required`;

const SAFETY_CONSTRAINTS = `## Safety constraints

- Dry-run only.
- Buildplane kernel validates and admits plans.
- Coding agents are untrusted workers.
- No Kanban, GSD2, GitHub, network, push, PR, deploy, merge, or worker-spawn side effects.`;

function taskBlock(allowedSideEffects?: string): string {
	const allowedLine = allowedSideEffects
		? `\n- Allowed-side-effects: ${allowedSideEffects}`
		: "";
	return `## Tasks

### T1: Implement the slice

- Objective: Implement the slice in an isolated worktree.
- Assignee-hint: auto-coder
- Workspace: isolated-worktree${allowedLine}
- Verification-commands:
  - pnpm typecheck`;
}

function doc(goal: string, includeTasks: boolean, allowed?: string): string {
	const tasks = includeTasks ? `\n\n${taskBlock(allowed)}` : "";
	return `## Goal\n\n${goal}\n\n${REPOSITORY_CONTEXT}\n\n${SAFETY_CONSTRAINTS}${tasks}\n`;
}

function riskClassOf(content: string): PlanForgeRiskClass {
	return validate(compile(content, "fixture.md")).validation.riskClass;
}

describe("validate: riskClass rubric", () => {
	const cases: ReadonlyArray<{
		name: string;
		content: string;
		expected: PlanForgeRiskClass;
	}> = [
		{
			name: "UNSAFE_TO_RUN (forbidden goal intent) → high",
			content: doc(
				"Implement the feature and push to origin.",
				true,
				"code-edit",
			),
			expected: "high",
		},
		{
			name: "INSUFFICIENT_EVIDENCE (missing tasks) → medium",
			content: doc("Implement the feature in an isolated worktree.", false),
			expected: "medium",
		},
		{
			name: "clean PASS with a code-edit side-effect → medium",
			content: doc(
				"Implement the feature in an isolated worktree.",
				true,
				"code-edit",
			),
			expected: "medium",
		},
		{
			name: "clean PASS with no side-effects → low",
			content: doc("Implement the feature in an isolated worktree.", true),
			expected: "low",
		},
	];

	for (const { name, content, expected } of cases) {
		it(name, () => {
			expect(riskClassOf(content)).toBe(expected);
		});
	}

	it("evaluates arms top-to-bottom (unsafe wins over missing evidence)", () => {
		// Forbidden goal intent AND no tasks: both unsafeReasons and missingEvidence
		// are non-empty, but the high arm must win.
		const content = doc("Implement the feature and push to origin.", false);
		const { validation } = validate(compile(content, "fixture.md"));
		expect(validation.unsafeReasons.length).toBeGreaterThan(0);
		expect(validation.missingEvidence.length).toBeGreaterThan(0);
		expect(validation.riskClass).toBe("high");
	});
});
