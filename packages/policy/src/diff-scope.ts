import type {
	ArchitectureDiffScopeGate,
	RejectedPolicyDecision,
} from "@buildplane/kernel";

export interface ArchitectureDiffScopeEvaluation {
	readonly gate: "architecture.diff_scope";
	readonly status: "passed" | "blocked";
	readonly changedFiles: readonly string[];
	readonly allowedPaths: readonly string[];
	readonly deniedPaths: readonly string[];
	readonly outOfScopeFiles: readonly string[];
	readonly deniedFiles: readonly string[];
	readonly reasons: readonly string[];
}

export function evaluateArchitectureDiffScope(
	changedFiles: readonly string[],
	gate: ArchitectureDiffScopeGate,
): ArchitectureDiffScopeEvaluation {
	const allowedPaths = normalizePatterns(gate.allowedPaths);
	const deniedPaths = normalizePatterns(gate.deniedPaths ?? []);
	const normalizedFiles = changedFiles.map(normalizeChangedPath);
	const invalidFiles = normalizedFiles.filter(
		(file): file is string => file !== null && file.startsWith("!"),
	);
	const validFiles = normalizedFiles.filter(
		(file): file is string => file !== null && !file.startsWith("!"),
	);

	const deniedFiles = validFiles.filter((file) =>
		deniedPaths.some((pattern) => matchesPattern(file, pattern)),
	);
	const outOfScopeFiles = validFiles.filter(
		(file) =>
			!deniedFiles.includes(file) &&
			!allowedPaths.some((pattern) => matchesPattern(file, pattern)),
	);
	const invalidReasons = invalidFiles.map(
		(file) =>
			`Invalid diff path ${file.slice(1)} cannot be evaluated deterministically.`,
	);
	const deniedReasons = deniedFiles.map(
		(file) =>
			`architecture.diff_scope blocked ${file}: path matches denied architecture scope ${deniedPaths.join(", ")}.`,
	);
	const scopeReasons = outOfScopeFiles.map(
		(file) =>
			`architecture.diff_scope blocked ${file}: path is outside allowed architecture scope ${allowedPaths.join(", ")}.`,
	);
	const reasons = [...invalidReasons, ...deniedReasons, ...scopeReasons];

	return {
		gate: "architecture.diff_scope",
		status: reasons.length === 0 ? "passed" : "blocked",
		changedFiles: validFiles,
		allowedPaths,
		deniedPaths,
		outOfScopeFiles,
		deniedFiles,
		reasons:
			reasons.length > 0
				? reasons
				: [
						`architecture.diff_scope passed for ${validFiles.length} changed file(s).`,
					],
	};
}

export function architectureDiffScopeDecision(
	evaluation: ArchitectureDiffScopeEvaluation,
): RejectedPolicyDecision | undefined {
	if (evaluation.status === "passed") {
		return undefined;
	}
	return {
		outcome: "rejected",
		kind: "architecture.diff_scope",
		reasons: [
			...evaluation.reasons,
			`Changed files: ${evaluation.changedFiles.join(", ") || "none"}`,
			`Allowed paths: ${evaluation.allowedPaths.join(", ") || "none"}`,
		],
	} satisfies RejectedPolicyDecision;
}

function normalizePatterns(patterns: readonly string[]): string[] {
	return Array.from(
		new Set(
			patterns
				.map(normalizePattern)
				.filter((pattern): pattern is string => pattern !== null),
		),
	).sort();
}

function normalizePattern(pattern: string): string | null {
	const trimmed = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	if (
		!trimmed ||
		trimmed.includes("\0") ||
		trimmed.startsWith("/") ||
		trimmed.startsWith("../") ||
		trimmed.includes("/../")
	) {
		return null;
	}
	return trimmed;
}

function normalizeChangedPath(path: string): string | null {
	const normalized = path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	if (!normalized || normalized.includes("\0")) return null;
	if (
		normalized.startsWith("/") ||
		normalized.startsWith("../") ||
		normalized.includes("/../")
	) {
		return `!${normalized}`;
	}
	return normalized;
}

function matchesPattern(path: string, pattern: string): boolean {
	if (pattern === "**" || pattern === "*") return true;
	if (pattern.endsWith("/**")) {
		const prefix = pattern.slice(0, -3);
		return path === prefix || path.startsWith(`${prefix}/`);
	}
	if (pattern.endsWith("/")) {
		return path.startsWith(pattern);
	}
	if (pattern.includes("*")) {
		return globToRegex(pattern).test(path);
	}
	return path === pattern;
}

function globToRegex(pattern: string): RegExp {
	const escaped = pattern
		.split("**")
		.map((part) =>
			part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"),
		)
		.join(".*");
	return new RegExp(`^${escaped}$`);
}
