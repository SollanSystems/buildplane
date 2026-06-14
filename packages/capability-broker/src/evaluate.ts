import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";
import type { CapabilityBundleV0 } from "./schema.js";

export type ToolInvocation =
	| { tool: "write_file"; path: string }
	| { tool: "run_command"; command: string; args?: string[] };

export type EvaluateToolContext = {
	worktreeRoot: string;
};

export type EvaluateToolResult =
	| { decision: "allow" }
	| { decision: "deny"; reason: string; quarantine: true };

function deny(reason: string): EvaluateToolResult {
	return { decision: "deny", reason, quarantine: true };
}

function normalizeRelativePath(
	worktreeRoot: string,
	inputPath: string,
): { ok: true; relativePosix: string } | { ok: false; reason: string } {
	if (isAbsolute(inputPath)) {
		return { ok: false, reason: "write path must be relative to the worktree" };
	}
	const normalizedRoot = resolve(worktreeRoot);
	const normalizedRelative = normalize(inputPath);
	const resolvedPath = resolve(normalizedRoot, normalizedRelative);
	const rel = relative(normalizedRoot, resolvedPath);
	if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
		return { ok: false, reason: "write path escapes the worktree root" };
	}
	const relativePosix = rel.split(sep).join("/");
	return { ok: true, relativePosix };
}

function pathMatchesFsWriteGlobs(
	relativePosix: string,
	globs: string[],
): boolean {
	return globs.some((pattern) =>
		minimatch(relativePosix, pattern, { dot: true, matchBase: false }),
	);
}

function commandMatchesAllowlist(
	command: string,
	args: string[] | undefined,
	allowlist: string[],
): boolean {
	const trimmed = command.trim();
	if (trimmed.length === 0) {
		return false;
	}
	const parts = trimmed.split(/\s+/);
	const argv0 = parts[0];
	for (const entry of allowlist) {
		if (entry === argv0) {
			return true;
		}
		if (trimmed === entry || trimmed.startsWith(`${entry} `)) {
			return true;
		}
	}
	if (args && args.length > 0) {
		for (const entry of allowlist) {
			if (entry === args[0]) {
				return true;
			}
		}
	}
	return false;
}

export function evaluateToolInvocation(
	bundle: CapabilityBundleV0,
	invocation: ToolInvocation,
	ctx: EvaluateToolContext,
): EvaluateToolResult {
	if (invocation.tool === "write_file") {
		if (bundle.tools?.write_file?.enabled === false) {
			return deny("write_file is disabled in capability bundle");
		}
		const globs = bundle.fsWrite ?? [];
		if (globs.length === 0) {
			return deny("no fsWrite globs in capability bundle");
		}
		const normalized = normalizeRelativePath(ctx.worktreeRoot, invocation.path);
		if (!normalized.ok) {
			return deny(normalized.reason);
		}
		if (!pathMatchesFsWriteGlobs(normalized.relativePosix, globs)) {
			return deny(
				`write path "${normalized.relativePosix}" is outside fsWrite allowlist`,
			);
		}
		return { decision: "allow" };
	}

	const allowlist = bundle.tools?.run_command?.allowlist ?? [];
	if (allowlist.length === 0) {
		return deny("no run_command allowlist in capability bundle");
	}
	if (
		!commandMatchesAllowlist(invocation.command, invocation.args, allowlist)
	) {
		return deny("command is not in run_command allowlist");
	}
	return { decision: "allow" };
}
