import type { RoadmapSlice } from "./roadmap.js";

export interface BuildPlannerPlanMarkdownInput {
	readonly slice: RoadmapSlice;
	readonly remote: string;
	readonly trustedBase: string;
}

const SAFETY_CONSTRAINTS = [
	"- Dry-run only.",
	"- Buildplane kernel validates and admits plans.",
	"- Coding agents are untrusted workers.",
	"- No Kanban, GSD2, GitHub, network, push, PR, deploy, merge, or worker-spawn side effects.",
	"- Idempotent repeated planning for the same normalized input, trusted base, and evidence set.",
].join("\n");

const FORBIDDEN_SIDE_EFFECTS =
	"execute-code, board-write, network-write, push, deploy, merge";

function renderIndentedList(label: string, items: readonly string[]): string {
	const lines = [`- ${label}:`];
	for (const item of items) {
		lines.push(`  - ${item}`);
	}
	return lines.join("\n");
}

function renderTaskBlock(slice: RoadmapSlice): string {
	// GAP-2 `## Tasks` grammar: `### <ID>: <Title>` heading + bullet fields.
	// Objective / Assignee-hint / Workspace are required scalars; Verification-commands
	// must be a non-empty indented list (parseTaskBlock returns undefined otherwise).
	return [
		`### ${slice.id}: ${slice.title}`,
		"",
		`- Objective: ${slice.objective}`,
		"- Assignee-hint: auto-coder",
		"- Workspace: isolated-worktree",
		`- Allowed-side-effects: ${slice.allowedSideEffects.join(", ")}`,
		`- Forbidden-side-effects: ${FORBIDDEN_SIDE_EFFECTS}`,
		`- Depends-on: ${slice.dependsOn.join(", ")}`,
		renderIndentedList("Acceptance-criteria", slice.acceptanceCriteria),
		renderIndentedList("Verification-commands", slice.verificationCommands),
	].join("\n");
}

/**
 * Deterministic `plan.md` emitter for a single roadmap slice. Produces the
 * `## Goal` / `## Repository context` / `## Safety constraints` / `## Tasks` /
 * `## Required output` shape that `compile()` + `validate()` accept, with the
 * `## Tasks` section in GAP-2's exact `### <ID>: <Title>` + bullet grammar. The
 * goal prose deliberately avoids push/deploy/merge wording so the (narrowed)
 * forbiddenGoalIntent guard passes.
 */
export function buildPlannerPlanMarkdown(
	input: BuildPlannerPlanMarkdownInput,
): string {
	const { slice, remote, trustedBase } = input;
	return [
		`# Buildplane self-build plan — ${slice.id}`,
		"",
		"This plan is authored by the Buildplane planning worker from the bounded roadmap. The kernel validates and admits it before any worker receives write capabilities.",
		"",
		"## Goal",
		"",
		`Implement roadmap slice ${slice.id} (${slice.title}): ${slice.objective} The worker edits source within the declared scope and verifies via the declared verification commands.`,
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
		renderTaskBlock(slice),
		"",
		"## Required output",
		"",
		`Emit a deterministic PlanForgePlan whose single task implements ${slice.id} with allowedSideEffects [${slice.allowedSideEffects.join(", ")}] and the listed verificationCommands. The only acceptable pass state is PASS.`,
		"",
	].join("\n");
}
