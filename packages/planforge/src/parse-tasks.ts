import { sectionText } from "./compile.js";
import {
	PLANFORGE_ALLOWED_SIDE_EFFECTS,
	PLANFORGE_FORBIDDEN_SIDE_EFFECTS,
	type PlanForgeAllowedSideEffect,
	type PlanForgeForbiddenSideEffect,
} from "./schema.js";

export interface ParsedTask {
	readonly id: string;
	readonly title: string;
	readonly objective: string;
	readonly assigneeHint: string;
	readonly workspace: string;
	readonly dependsOn: readonly string[];
	readonly allowedSideEffects: readonly PlanForgeAllowedSideEffect[];
	readonly forbiddenSideEffects: readonly PlanForgeForbiddenSideEffect[];
	readonly acceptanceCriteria: readonly string[];
	readonly verificationCommands: readonly string[];
}

// Matches ### <ID>: <Title> where ID is one or more non-colon, non-whitespace chars
const TASK_HEADING = /^###\s+(\S+?):\s+(.+)$/m;

function parseInlineList(value: string | undefined): string[] {
	if (!value?.trim()) {
		return [];
	}
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function parseIndentedList(block: string, fieldLabel: string): string[] {
	// Matches the field line and then consumes indented bullet items below it.
	// The field line itself is: ^- <fieldLabel>:\s*$
	// Indented items: ^  - <item>
	const fieldLine = new RegExp(
		`^-\\s+${fieldLabel}:\\s*$([\\s\\S]*?)(?=^-\\s+\\S|(?![\\s\\S]))`,
		"m",
	);
	const match = fieldLine.exec(block);
	if (!match) {
		return [];
	}
	const body = match[1];
	return body
		.split(/\r?\n/)
		.map((line) => line.replace(/^\s{1,4}-\s+/, "").trim())
		.filter(
			(line) =>
				line.length > 0 && !line.startsWith("#") && !line.startsWith("-"),
		);
}

function scalarField(block: string, label: string): string | undefined {
	const pattern = new RegExp(`^-[ \\t]+${label}:[ \\t]*(.+)$`, "m");
	const match = pattern.exec(block);
	return match?.[1]?.trim();
}

function parseTaskBlock(
	id: string,
	title: string,
	block: string,
): ParsedTask | undefined {
	const objective = scalarField(block, "Objective");
	const assigneeHint = scalarField(block, "Assignee-hint");
	const workspace = scalarField(block, "Workspace");

	if (!objective || !assigneeHint || !workspace) {
		return undefined;
	}

	const dependsOnRaw = scalarField(block, "Depends-on");
	const dependsOn = dependsOnRaw ? parseInlineList(dependsOnRaw) : [];

	const allowedRaw = scalarField(block, "Allowed-side-effects");
	const allowedTokens = allowedRaw ? parseInlineList(allowedRaw) : [];
	const allowedSet = new Set<string>(PLANFORGE_ALLOWED_SIDE_EFFECTS);
	const allowedSideEffects = allowedTokens.filter(
		(t): t is PlanForgeAllowedSideEffect => allowedSet.has(t),
	);

	const forbiddenRaw = scalarField(block, "Forbidden-side-effects");
	const forbiddenTokens = forbiddenRaw ? parseInlineList(forbiddenRaw) : [];
	const forbiddenSet = new Set<string>(PLANFORGE_FORBIDDEN_SIDE_EFFECTS);
	const forbiddenSideEffects = forbiddenTokens.filter(
		(t): t is PlanForgeForbiddenSideEffect => forbiddenSet.has(t),
	);

	const acceptanceCriteria = parseIndentedList(block, "Acceptance-criteria");
	const verificationCommands = parseIndentedList(
		block,
		"Verification-commands",
	);

	if (verificationCommands.length === 0) {
		return undefined;
	}

	return {
		id,
		title: title.trim(),
		objective,
		assigneeHint,
		workspace,
		dependsOn,
		allowedSideEffects,
		forbiddenSideEffects,
		acceptanceCriteria,
		verificationCommands,
	};
}

export function parseTasks(content: string): ParsedTask[] {
	const section = sectionText(content, "Tasks");
	if (!section) {
		return [];
	}

	const tasks: ParsedTask[] = [];
	// Split on ### headings; each part begins with a ### heading line.
	const parts = section.split(/^(?=###\s)/m);
	for (const part of parts) {
		const headingMatch = TASK_HEADING.exec(part);
		if (!headingMatch) {
			continue;
		}
		const [, id, title] = headingMatch;
		if (!id || !title) {
			continue;
		}
		// block = everything after the heading line
		const newlineIndex = part.indexOf("\n", headingMatch.index);
		const block = newlineIndex >= 0 ? part.slice(newlineIndex) : "";
		const task = parseTaskBlock(id, title, block);
		if (task) {
			tasks.push(task);
		}
	}
	return tasks;
}
