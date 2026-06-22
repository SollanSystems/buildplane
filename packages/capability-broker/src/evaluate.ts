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
 * The loop worker binary (`claude`) is allowlisted so a dispatched worker can
 * recursively invoke it through `run_command`. But `claude` accepts flags that
 * disable its OWN nested tool-permission prompts — an unattended worker that
 * could pass them would escape every downstream sandbox boundary. These flag
 * tokens are rejected for the worker binary regardless of allowlisting; the
 * check is case/`=`-insensitive over the full token set (GAP-4 carry-forward).
 */
const WORKER_BINARY = "claude" as const;
const WORKER_FORBIDDEN_ARGV_TOKENS = [
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
 * Is this run_command invocation the worker binary attempting to disable its
 * own nested permission prompts? `commandMatchesAllowlist` matches argv0/prefix
 * and ignores args, so without this guard a `claude --dangerously-skip-permissions`
 * invocation would be permitted purely because `claude` is allowlisted.
 */
function forbiddenWorkerArgvToken(
	command: string,
	args: readonly string[] | undefined,
): string | undefined {
	const tokens = command.trim().split(/\s+/);
	if (tokens[0] !== WORKER_BINARY) {
		return undefined;
	}
	const candidate = [...tokens.slice(1), ...(args ?? [])];
	for (const token of candidate) {
		const normalized = token.trim().toLowerCase();
		if (normalized.length === 0) {
			continue;
		}
		for (const forbidden of WORKER_FORBIDDEN_ARGV_TOKENS) {
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
	const forbiddenToken = forbiddenWorkerArgvToken(
		invocation.command,
		invocation.args,
	);
	if (forbiddenToken !== undefined) {
		return deny(
			`worker binary "${WORKER_BINARY}" may not pass permission-escape flag "${forbiddenToken}" ` +
				"(e.g. --dangerously-skip-permissions); it would bypass nested tool-permission prompts",
		);
	}
	if (
		!commandMatchesAllowlist(invocation.command, invocation.args, allowlist)
	) {
		return deny("command is not in run_command allowlist");
	}
	return { decision: "allow" };
}
