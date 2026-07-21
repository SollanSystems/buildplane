import type {
	ExecutionRole,
	RenderedPrompt,
	TaskIntent,
	TaskRenderer,
} from "@buildplane/kernel";

/**
 * Renders a TaskIntent into an 8-section prompt for Claude Code.
 *
 * Sections (mirrors SuperClaude DispatchBuilder):
 * 1. Task header         — objective + task type + role
 * 2. Safe autonomy       — what the model may/may not do autonomously
 * 3. Instructions        — step-by-step guidance derived from taskType + role
 * 4. Matched skills      — codebase hints / conventions
 * 5. Project memories    — injected memory IDs
 * 6. Prior work          — summaries from earlier tasks in strategy
 * 7. Preset              — constraint scope + verification commands
 * 8. Retry context       — what failed on a prior attempt (omitted if none)
 */
export function createClaudeRenderer(): TaskRenderer {
	return {
		provider: "anthropic",

		render(intent: TaskIntent, role: ExecutionRole): RenderedPrompt {
			const sections: string[] = [];

			// ── 1. Task header ─────────────────────────────────────
			const roleLabel = roleHeading(role);
			sections.push(
				`# ${roleLabel}: ${intent.taskType.toUpperCase()}\n\n${intent.objective}`,
			);

			// ── 2. Safe autonomy contract ──────────────────────────
			sections.push(buildAutonomyContract(role, intent));

			// ── 3. Instructions ────────────────────────────────────
			sections.push(buildInstructions(role, intent));

			// ── 4. Matched skills / codebase hints ─────────────────
			if (intent.context.codebaseHints) {
				sections.push(
					`## Codebase Conventions\n\n${intent.context.codebaseHints}`,
				);
			}

			// ── 5. Project memories ────────────────────────────────
			if (intent.context.memories && intent.context.memories.length > 0) {
				const memoryList = intent.context.memories
					.map((m) => `- ${m}`)
					.join("\n");
				sections.push(`## Relevant Memories\n\n${memoryList}`);
			}

			// ── 6. Prior work ──────────────────────────────────────
			if (intent.context.priorWork && intent.context.priorWork.length > 0) {
				const priorList = intent.context.priorWork
					.map((p, i) => `${i + 1}. ${p}`)
					.join("\n");
				sections.push(`## Prior Work in This Strategy\n\n${priorList}`);
			}

			// ── 7. Preset (scope + verification) ──────────────────
			sections.push(buildPreset(intent));

			// ── 8. Retry context (omit if none) ────────────────────
			if (intent.context.retryContext) {
				sections.push(
					`## Retry Context\n\nThe previous attempt failed. Here is what went wrong:\n\n${intent.context.retryContext}`,
				);
			}

			return {
				prompt: sections.join("\n\n---\n\n"),
			};
		},
	};
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function roleHeading(role: ExecutionRole): string {
	switch (role) {
		case "implementer":
			return "Implementation Task";
		case "reviewer":
			return "Code Review Task";
		case "adversary":
			return "Adversarial Review Task";
		case "judge":
			return "Judge Task";
		case "candidate":
			return "Candidate Implementation";
	}
}

function buildAutonomyContract(
	role: ExecutionRole,
	intent: TaskIntent,
): string {
	const forbidden =
		intent.constraints.forbidden && intent.constraints.forbidden.length > 0
			? `\n\nYou MUST NOT modify:\n${intent.constraints.forbidden.map((p) => `- ${p}`).join("\n")}`
			: "";

	if (isReadOnlyEvaluationRole(role)) {
		return `## Safe Autonomy Contract\n\nYou are acting as a **${role}**. Your task is to evaluate existing work, not produce new code.\n\n- Read files freely within scope\n- Do NOT modify source files or create persistent files\n- Do NOT run mutating or destructive commands\n- Produce a verdict: approve, request-changes, or reject${forbidden}`;
	}

	return `## Safe Autonomy Contract\n\nYou may autonomously:\n- Read any file in scope\n- Write and edit files within the allowed scope\n- Run verification commands listed in the Preset section\n- Create new files if required by the task\n\nYou MUST NOT:\n- Modify files outside the allowed scope\n- Run destructive git operations (force push, reset --hard, branch -D)\n- Skip verification gates${forbidden}`;
}

function buildInstructions(role: ExecutionRole, intent: TaskIntent): string {
	const header = "## Instructions";

	if (isReadOnlyEvaluationRole(role)) {
		const reviewSteps = [
			"1. Read all files in the scope listed under Preset.",
			"2. Review the Prior Work section to understand what the implementer produced.",
			"3. Evaluate correctness, test coverage, and adherence to codebase conventions.",
			"4. Run the verification commands listed under Preset.",
			"5. Produce a verdict:",
			"   - **approve** — implementation meets requirements and all gates pass",
			"   - **request-changes** — list specific required changes with file:line references",
			"   - **reject** — fundamental approach is wrong; explain why",
		].join("\n");
		return `${header}\n\n${reviewSteps}`;
	}

	// Implementer / candidate
	const typeInstructions = taskTypeInstructions(intent.taskType);
	const fileList =
		intent.context.files.length > 0
			? `\n\nRelevant files:\n${intent.context.files.map((f) => `- ${f}`).join("\n")}`
			: "";
	return `${header}\n\n${typeInstructions}${fileList}`;
}

/** Judge decisions are evaluative evidence, never an implementation request. */
function isReadOnlyEvaluationRole(
	role: ExecutionRole,
): role is "reviewer" | "adversary" | "judge" {
	return role === "reviewer" || role === "adversary" || role === "judge";
}

function taskTypeInstructions(taskType: string): string {
	switch (taskType) {
		case "implement":
			return "Implement the described feature. Write clean, idiomatic code that matches existing conventions. Add or update tests as needed.";
		case "review":
			return "Review the described code. Identify bugs, style violations, and missing tests. Be specific with file:line references.";
		case "diagnose":
			return "Diagnose the described issue. Trace the execution path, identify the root cause, and propose a minimal fix.";
		case "refactor":
			return "Refactor the described code. Preserve all existing behaviour. Run the full test suite before and after.";
		case "test-gen":
			return "Generate comprehensive tests for the described code. Cover happy paths, edge cases, and error conditions. Do not modify source files.";
		case "security-audit":
			return "Audit the described code for security vulnerabilities. Focus on OWASP Top 10, injection vectors, and authentication/authorisation flaws. Produce a prioritised finding list.";
		case "migration":
			return "Execute the described migration. Preserve data integrity. Produce a rollback plan as a comment block at the top of each modified file.";
		case "architecture":
			return "Design the described architecture. Produce a decision record with trade-offs, chosen approach, and a phased implementation plan.";
		default:
			return "Complete the described task following project conventions.";
	}
}

function buildPreset(intent: TaskIntent): string {
	const scopeList = intent.constraints.scope.map((p) => `- ${p}`).join("\n");
	const verifyList = intent.constraints.verification
		.map((cmd) => `- \`${cmd}\``)
		.join("\n");

	const complexityLine =
		intent.features.estimatedComplexity !== undefined
			? `\n\n**Estimated complexity:** ${intent.features.estimatedComplexity}`
			: "";
	const languageLine = intent.features.language
		? `\n**Language:** ${intent.features.language}`
		: "";
	const frameworkLine = intent.features.framework
		? `\n**Framework:** ${intent.features.framework}`
		: "";

	return [
		"## Preset",
		"",
		"**Allowed scope:**",
		scopeList,
		"",
		"**Verification gates** (must all pass before declaring success):",
		verifyList,
		complexityLine + languageLine + frameworkLine,
	]
		.join("\n")
		.trim();
}
