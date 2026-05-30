export interface PlanForgeCompileResult {
	content: string;
	goal: string | undefined;
	remote: string | undefined;
	trustedBase: string | undefined;
	worktreePolicy: string | undefined;
	safetyConstraints: string | undefined;
	inputEvidenceName: string;
	evidenceRefs: string[];
}

export function sectionText(
	content: string,
	heading: string,
): string | undefined {
	const headingPattern = new RegExp(`^## ${heading}\\s*$`, "m");
	const match = headingPattern.exec(content);
	if (!match) {
		return undefined;
	}
	const start = match.index + match[0].length;
	const rest = content.slice(start);
	const nextHeading = /^##\s+/m.exec(rest);
	return (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim();
}

export function listValue(
	section: string | undefined,
	label: string,
): string | undefined {
	if (!section) {
		return undefined;
	}
	const pattern = new RegExp(`^- ${label}:[ \t]*(.+)$`, "m");
	const match = pattern.exec(section);
	return match?.[1]?.trim();
}

export function hasLine(content: string, expected: string): boolean {
	return content
		.split(/\r?\n/)
		.some((line) => line.trim().toLowerCase() === expected.toLowerCase());
}

export function compile(
	content: string,
	inputEvidenceName: string,
): PlanForgeCompileResult {
	const goal = sectionText(content, "Goal");
	const repositoryContext = sectionText(content, "Repository context");
	const safetyConstraints = sectionText(content, "Safety constraints");
	const evidenceRefs = [
		`${inputEvidenceName}#safety-constraints`,
		`${inputEvidenceName}#repository-context`,
	];
	const remote = listValue(repositoryContext, "Remote");
	const trustedBase = listValue(repositoryContext, "Trusted base");
	const worktreePolicy = listValue(repositoryContext, "Worktree policy");
	return {
		content,
		goal,
		remote,
		trustedBase,
		worktreePolicy,
		safetyConstraints,
		inputEvidenceName,
		evidenceRefs,
	};
}
