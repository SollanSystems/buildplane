import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

export type WorkflowScanSource = "shared" | "claude" | "codex";
export type WorkflowScanKind = "instructions" | "config" | "hooks";

export interface WorkflowScanFinding {
	readonly path: string;
	readonly source: WorkflowScanSource;
	readonly kind: WorkflowScanKind;
}

export interface WorkflowScanPreview {
	readonly preview: true;
	readonly findings: readonly WorkflowScanFinding[];
}

const SOURCE_ORDER: Record<WorkflowScanSource, number> = {
	shared: 0,
	claude: 1,
	codex: 2,
};

const KIND_ORDER: Record<WorkflowScanKind, number> = {
	instructions: 0,
	config: 1,
	hooks: 2,
};

function toPosixPath(value: string): string {
	return value.split(sep).join("/");
}

function maybeAddFile(
	findings: WorkflowScanFinding[],
	root: string,
	relativePath: string,
	source: WorkflowScanSource,
	kind: WorkflowScanKind,
): void {
	const absolutePath = join(root, relativePath);
	if (!existsSync(absolutePath) || !lstatSync(absolutePath).isFile()) {
		return;
	}
	findings.push({
		path: toPosixPath(relativePath),
		source,
		kind,
	});
}

function collectHookFiles(root: string, relativeDir: string): string[] {
	const absoluteDir = join(root, relativeDir);
	if (!existsSync(absoluteDir) || !lstatSync(absoluteDir).isDirectory()) {
		return [];
	}

	const found: string[] = [];
	for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
		if (!entry.isFile()) {
			continue;
		}
		found.push(toPosixPath(join(relativeDir, entry.name)));
	}
	return found;
}

export function scanWorkflowPreview(root: string): WorkflowScanPreview {
	const findings: WorkflowScanFinding[] = [];

	maybeAddFile(findings, root, "AGENTS.md", "shared", "instructions");
	maybeAddFile(findings, root, "CLAUDE.md", "shared", "instructions");
	maybeAddFile(findings, root, ".claude/settings.json", "claude", "config");
	maybeAddFile(
		findings,
		root,
		".claude/settings.local.json",
		"claude",
		"config",
	);
	for (const hookPath of collectHookFiles(root, ".claude/hooks")) {
		findings.push({ path: hookPath, source: "claude", kind: "hooks" });
	}
	maybeAddFile(findings, root, ".codex/AGENTS.md", "codex", "instructions");
	maybeAddFile(findings, root, ".codex/config.toml", "codex", "config");

	findings.sort((left, right) => {
		const sourceDiff = SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source];
		if (sourceDiff !== 0) {
			return sourceDiff;
		}
		const kindDiff = KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
		if (kindDiff !== 0) {
			return kindDiff;
		}
		if (left.path < right.path) {
			return -1;
		}
		if (left.path > right.path) {
			return 1;
		}
		return 0;
	});

	return {
		preview: true,
		findings,
	};
}
