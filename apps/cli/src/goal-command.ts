import { resolve } from "node:path";
import {
	compile,
	type PlanForgePlan,
	preview,
	validate,
} from "@buildplane/planforge";
import { gitInWorkspace, tryGitInWorkspace } from "./git-in-workspace.js";

export interface GoalCommandOptions {
	readonly goal: string;
	readonly cwd: string;
	/** Operator-supplied trusted base SHA. Overrides git HEAD auto-detection. */
	readonly trustedBaseOverride?: string;
	readonly stdout: (line: string) => void;
	readonly stderr: (line: string) => void;
}

/** The exact five `## Safety constraints` lines `validate()` requires for the
 * dry-run + trusted-boundary evidence checks. Shared verbatim with the planner
 * emitter so a `bp goal` plan compiles to the same safety posture. */
const SAFETY_CONSTRAINTS = [
	"- Dry-run only.",
	"- Buildplane kernel validates and admits plans.",
	"- Coding agents are untrusted workers.",
	"- No Kanban, GSD2, GitHub, network, push, PR, deploy, merge, or worker-spawn side effects.",
	"- Idempotent repeated planning for the same normalized input, trusted base, and evidence set.",
].join("\n");

export interface BuildGoalPlanMarkdownInput {
	readonly goal: string;
	readonly remote: string;
	readonly trustedBase: string;
}

/**
 * Synthesize the PlanForge input markdown for a raw operator goal. Emits the
 * `## Goal` / `## Repository context` (with a `Trusted base:` line) /
 * `## Safety constraints` / `## Tasks` shape `compile()` accepts. The `## Tasks`
 * section is intentionally empty — `bp goal` is demo step 1 (compile + preview +
 * display), so a bare goal validating to INSUFFICIENT_EVIDENCE is expected.
 */
export function buildGoalPlanMarkdown(
	input: BuildGoalPlanMarkdownInput,
): string {
	const { goal, remote, trustedBase } = input;
	return [
		"# Buildplane goal — operator request",
		"",
		"This plan is synthesized by `bp goal` from a raw operator goal. The kernel validates and previews it before any worker receives write capabilities.",
		"",
		"## Goal",
		"",
		goal,
		"",
		"## Repository context",
		"",
		`- Remote: ${remote}`,
		`- Trusted base: ${trustedBase}`,
		"- Worktree policy: isolated-worktree-required",
		"",
		"## Safety constraints",
		"",
		SAFETY_CONSTRAINTS,
		"",
		"## Tasks",
		"",
	].join("\n");
}

function isWorktreeDirty(cwd: string): boolean {
	const status = tryGitInWorkspace(cwd, ["status", "--porcelain"]);
	return status !== null && status.trim().length > 0;
}

function detectTrustedBase(cwd: string): string {
	return gitInWorkspace(cwd, ["rev-parse", "HEAD"]).trim();
}

function detectRemote(cwd: string): string | undefined {
	const remote = tryGitInWorkspace(cwd, ["remote", "get-url", "origin"]);
	const trimmed = remote?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export interface GoalCommandResult {
	readonly goal: string;
	readonly trustedBase: string;
	readonly remote: string | undefined;
	readonly planDigest: string;
	readonly riskClass: PlanForgePlan["validation"]["riskClass"];
	readonly status: PlanForgePlan["validation"]["status"];
	readonly missingEvidence: PlanForgePlan["validation"]["missingEvidence"];
	readonly plan: PlanForgePlan;
}

/** Compile + preview a raw goal into a reviewable PlanForgePlan (no execution,
 * no admission, no side effects). Returns the structured result for the CLI to
 * serialize. */
export function buildGoalPlan(options: GoalCommandOptions): GoalCommandResult {
	const cwd = resolve(options.cwd);

	let trustedBase = options.trustedBaseOverride?.trim();
	if (!trustedBase) {
		if (isWorktreeDirty(cwd)) {
			options.stderr(
				"warning: worktree is dirty — pinning the plan to the current HEAD. Pass --trusted-base <sha> to pin an explicit base.",
			);
		}
		trustedBase = detectTrustedBase(cwd);
	}

	const remote = detectRemote(cwd);

	const markdown = buildGoalPlanMarkdown({
		goal: options.goal,
		remote: remote ?? "unknown",
		trustedBase,
	});

	const compiled = compile(markdown, "goal.md");
	const validated = validate(compiled);
	const plan = preview(compiled, validated);

	return {
		goal: options.goal,
		trustedBase,
		remote,
		planDigest: plan.receiptPreview.planDigest,
		riskClass: plan.validation.riskClass,
		status: plan.validation.status,
		missingEvidence: plan.validation.missingEvidence,
		plan,
	};
}
