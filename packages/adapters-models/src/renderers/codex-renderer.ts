import type {
	ExecutionRole,
	RenderedPrompt,
	TaskIntent,
	TaskRenderer,
} from "@buildplane/kernel";

/**
 * Renders a TaskIntent into a structured XML-style prompt for the Codex CLI.
 *
 * Codex performs best with concise, explicitly structured prompts.
 * Uses XML-style blocks per gpt-5-4-prompting conventions:
 *
 * <task>       — objective, type, role
 * <context>    — files, prior work, memories, codebase hints
 * <constraints> — allowed scope, forbidden paths, verification commands
 * <retry>      — prior failure context (omitted if none)
 */
export function createCodexRenderer(): TaskRenderer {
	return {
		provider: "openai",

		render(intent: TaskIntent, role: ExecutionRole): RenderedPrompt {
			const parts: string[] = [];

			// ── <task> ─────────────────────────────────────────────
			parts.push(buildTaskBlock(intent, role));

			// ── <context> ──────────────────────────────────────────
			parts.push(buildContextBlock(intent, role));

			// ── <constraints> ──────────────────────────────────────
			parts.push(buildConstraintsBlock(intent));

			// ── <retry> (omit if no retry context) ─────────────────
			if (intent.context.retryContext) {
				parts.push(`<retry>\n${intent.context.retryContext}\n</retry>`);
			}

			return {
				prompt: parts.join("\n\n"),
			};
		},
	};
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildTaskBlock(intent: TaskIntent, role: ExecutionRole): string {
	const roleAttr = role !== "implementer" ? ` role="${role}"` : "";
	const typeAttr = ` type="${intent.taskType}"`;
	const complexityAttr = intent.features.estimatedComplexity
		? ` complexity="${intent.features.estimatedComplexity}"`
		: "";

	const attrs = `${typeAttr}${roleAttr}${complexityAttr}`;

	const roleInstructions = roleInstructionLine(role, intent.taskType);

	return `<task${attrs}>\n${intent.objective}\n\n${roleInstructions}\n</task>`;
}

function roleInstructionLine(role: ExecutionRole, taskType: string): string {
	switch (role) {
		case "reviewer":
			return "You are reviewing existing work only. Do not modify files, create persistent files, or run mutating commands. Produce a verdict: approve | request-changes | reject. Be specific with file:line references.";
		case "adversary":
			return "You are an adversarial reviewer. Do not modify files, create persistent files, or run mutating commands. Challenge every assumption. Find bugs, security issues, and design flaws. Be thorough and critical.";
		case "judge":
			return "You are arbitrating between competing implementations. Read existing candidate evidence only; do not modify files or run mutating commands. Select the best candidate and explain your reasoning.";
		case "candidate":
			return `You are producing a candidate ${taskType} for evaluation against other candidates. Focus on correctness and test coverage.`;
		default:
			return taskTypeOneLiner(taskType);
	}
}

function taskTypeOneLiner(taskType: string): string {
	switch (taskType) {
		case "implement":
			return "Implement the feature. Match existing code conventions. Add tests.";
		case "review":
			return "Review the code. List findings with file:line references and severity.";
		case "diagnose":
			return "Diagnose the issue. Identify root cause. Propose minimal fix.";
		case "refactor":
			return "Refactor while preserving all behaviour. Run tests before and after.";
		case "test-gen":
			return "Generate tests. Cover happy paths, edge cases, and errors. Do not modify source files.";
		case "security-audit":
			return "Audit for security vulnerabilities. Prioritise findings by severity.";
		case "migration":
			return "Execute the migration. Preserve data integrity. Document rollback steps.";
		case "architecture":
			return "Design the architecture. Produce a decision record with trade-offs.";
		default:
			return "Complete the task following project conventions.";
	}
}

function buildContextBlock(intent: TaskIntent, role: ExecutionRole): string {
	const lines: string[] = [];

	if (intent.context.files.length > 0) {
		const fileList = intent.context.files.map((f) => `  - ${f}`).join("\n");
		lines.push(`<files>\n${fileList}\n</files>`);
	}

	if (intent.features.language) {
		lines.push(`<language>${intent.features.language}</language>`);
	}

	if (intent.features.framework) {
		lines.push(`<framework>${intent.features.framework}</framework>`);
	}

	if (intent.context.codebaseHints) {
		lines.push(
			`<codebase-hints>\n${intent.context.codebaseHints}\n</codebase-hints>`,
		);
	}

	if (intent.context.memories && intent.context.memories.length > 0) {
		const memList = intent.context.memories.map((m) => `  ${m}`).join("\n");
		lines.push(`<memories>\n${memList}\n</memories>`);
	}

	// Reviewer/adversary needs prior work prominently
	if (intent.context.priorWork && intent.context.priorWork.length > 0) {
		const priorList = intent.context.priorWork
			.map((p, i) => `  ${i + 1}. ${p}`)
			.join("\n");
		const label =
			role === "reviewer" || role === "adversary" || role === "judge"
				? "work-to-review"
				: "prior-work";
		lines.push(`<${label}>\n${priorList}\n</${label}>`);
	}

	return `<context>\n${lines.join("\n")}\n</context>`;
}

function buildConstraintsBlock(intent: TaskIntent): string {
	const parts: string[] = [];

	const scopeList = intent.constraints.scope.map((p) => `  - ${p}`).join("\n");
	parts.push(`<scope>\n${scopeList}\n</scope>`);

	if (intent.constraints.forbidden && intent.constraints.forbidden.length > 0) {
		const forbidList = intent.constraints.forbidden
			.map((p) => `  - ${p}`)
			.join("\n");
		parts.push(`<forbidden>\n${forbidList}\n</forbidden>`);
	}

	if (intent.constraints.verification.length > 0) {
		const verifyList = intent.constraints.verification
			.map((cmd) => `  ${cmd}`)
			.join("\n");
		parts.push(`<verification-gates>\n${verifyList}\n</verification-gates>`);
	}

	return `<constraints>\n${parts.join("\n")}\n</constraints>`;
}
