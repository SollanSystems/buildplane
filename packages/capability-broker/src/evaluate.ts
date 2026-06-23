import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";
import type { CapabilityBundleV0 } from "./schema.js";

export type ToolInvocation =
	| { tool: "write_file"; path: string }
	| { tool: "run_command"; command: string; args?: readonly string[] };

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

/**
 * Permission-escape flags that disable a nested worker's OWN tool-permission
 * prompts. The loop worker binary (`claude`) is allowlisted so a dispatched
 * worker can recursively invoke it through `run_command`, but these flags would
 * let an unattended worker escape every downstream sandbox boundary. They have
 * NO legitimate use in any loop command, so they are denied UNCONDITIONALLY —
 * wrapper- and position-agnostic — not only when `claude` is argv0. A wrapped
 * invocation (`pnpm exec claude …`, `npx claude …`, `env X=1 claude …`) routes
 * through an allowlisted verification runner, so a worker-binary-only check let
 * the escape flag through (GAP-10 P1). The scan is case/`=`-insensitive over the
 * full token set: the packed `command` split on whitespace AND every `args[]`
 * entry (GAP-4 carry-forward, generalized).
 */
const FORBIDDEN_ESCAPE_TOKENS = [
	"--dangerously-skip-permissions",
	"--dangerouslyskippermissions",
	"--permission-mode=bypasspermissions",
	"--bypass-permissions",
	"--bypasspermissions",
] as const;

function commandMatchesAllowlist(
	command: string,
	_args: readonly string[] | undefined,
	allowlist: string[],
): boolean {
	const trimmed = command.trim();
	if (trimmed.length === 0) {
		return false;
	}
	const argv0 = trimmed.split(/\s+/)[0];
	for (const entry of allowlist) {
		if (entry === argv0) {
			return true;
		}
		if (trimmed === entry || trimmed.startsWith(`${entry} `)) {
			return true;
		}
	}
	return false;
}

/**
 * Does this run_command invocation carry a permission-escape flag anywhere?
 * `commandMatchesAllowlist` matches argv0/prefix and ignores args, and `pnpm` /
 * `npx` / `env` are allowlisted runners, so a wrapped `pnpm exec claude
 * --dangerously-skip-permissions` would otherwise be permitted. The scan is
 * wrapper- and position-agnostic: it fires on ANY token — across the packed
 * `command` string split on whitespace AND the `args[]` array — regardless of
 * argv0 (GAP-10 P1). The `bypasspermissions` value token is denied standalone so
 * the two-token `--permission-mode bypassPermissions` form is also caught.
 */
function forbiddenEscapeToken(
	command: string,
	args: readonly string[] | undefined,
): string | undefined {
	const candidate = [...command.trim().split(/\s+/), ...(args ?? [])];
	for (const token of candidate) {
		const normalized = token.trim().toLowerCase();
		if (normalized.length === 0) {
			continue;
		}
		for (const forbidden of FORBIDDEN_ESCAPE_TOKENS) {
			if (normalized === forbidden || normalized.startsWith(`${forbidden}=`)) {
				return token.trim();
			}
		}
		if (
			normalized === "bypasspermissions" ||
			normalized.endsWith("=bypasspermissions")
		) {
			return token.trim();
		}
	}
	return undefined;
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
	const forbiddenToken = forbiddenEscapeToken(
		invocation.command,
		invocation.args,
	);
	if (forbiddenToken !== undefined) {
		return deny(
			`run_command may not pass permission-escape flag "${forbiddenToken}" ` +
				"(e.g. --dangerously-skip-permissions); it would bypass nested tool-permission prompts " +
				"regardless of wrapper (pnpm/npx/env) or argv position",
		);
	}
	if (
		!commandMatchesAllowlist(invocation.command, invocation.args, allowlist)
	) {
		return deny("command is not in run_command allowlist");
	}
	return { decision: "allow" };
}
