import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
	BudgetConstraints,
	EnvelopeProposal,
	PolicyProfile,
} from "@buildplane/kernel";
import {
	buildDefaultCapabilityBundleForPlan,
	type PlanForgePlan,
} from "@buildplane/planforge";

// ── FSM types ───────────────────────────────────────────────

export type LoopPhase =
	| "plan"
	| "dry-run"
	| "envelope-check"
	| "admit"
	| "dispatch"
	| "accept"
	| "merge"
	| "reanchor"
	| "advance";

export type LoopTerminalReason =
	| "max-iterations"
	| "roadmap-complete"
	| "stop-file"
	| "acceptance-fail"
	| "envelope-breach"
	| "token-budget"
	| "planner-error";

export interface LoopTerminal {
	readonly reason: LoopTerminalReason;
	readonly detail?: string;
}

export interface LoopState {
	readonly version: 1;
	readonly iteration: number;
	readonly maxIterations: number | null;
	readonly envelopeRef: string | null;
	/**
	 * The single base SHA the loop pins for its whole lifetime. The planner reads
	 * completed-slice ids relative to this base; advancing the base across
	 * iterations would make already-completed slices read as not-done (GAP-9
	 * carry-forward), so it is set once at loop start and never moved.
	 */
	readonly trustedBase: string | null;
	readonly lastMergedHeadSha: string | null;
	readonly cumulativeTokenDeltas: number;
	readonly tokenBudget: number | null;
	readonly phase: LoopPhase;
	readonly currentSliceId: string | null;
	readonly currentPlanPath: string | null;
	readonly terminal: LoopTerminal | null;
	readonly updatedAt: string;
}

export type LoopTransition =
	| { type: "slice-selected"; sliceId: string; planPath: string }
	| { type: "roadmap-complete" }
	| { type: "planner-error"; detail: string }
	| { type: "dry-run-ok" }
	| { type: "envelope-ok" }
	| { type: "envelope-breach"; detail: string }
	| { type: "admitted" }
	| { type: "dispatched" }
	| { type: "acceptance-failed"; detail: string }
	| { type: "accepted" }
	| { type: "merged"; headSha: string }
	| { type: "token-deltas-observed"; count: number }
	| { type: "advance" }
	| { type: "stop-file" };

// ── EnvelopeProposal adapter ────────────────────────────────

interface PlanForgePlanTaskLike {
	readonly allowedSideEffects?: readonly string[];
	readonly verificationCommands?: readonly string[];
}
interface PlanForgePlanLike {
	readonly id: string;
	readonly tasks?: readonly PlanForgePlanTaskLike[];
}

/**
 * Build the GAP-10 `EnvelopeProposal` the supervisor presents for the
 * auto-admit subset check: the deduped union of every task's
 * `allowedSideEffects` + `verificationCommands`, plus the plan's default
 * capability-bundle `fsWrite` globs.
 *
 * `milestone` is passed explicitly (the kernel `EnvelopeProposal` requires it
 * for the envelope's milestone-match gate, and a `PlanForgePlan` carries no
 * milestone field — the supervisor knows it from the roadmap slice).
 */
export function buildEnvelopeProposal(
	plan: PlanForgePlanLike,
	milestone: string,
): EnvelopeProposal {
	const sideEffects = new Set<string>();
	const verificationCommands = new Set<string>();
	for (const task of plan.tasks ?? []) {
		for (const se of task.allowedSideEffects ?? []) sideEffects.add(se);
		for (const vc of task.verificationCommands ?? [])
			verificationCommands.add(vc);
	}
	const bundle = buildDefaultCapabilityBundleForPlan(plan as PlanForgePlan);
	const pathGlobs = bundle.fsWrite ?? [];
	return {
		milestone,
		sideEffects: [...sideEffects],
		pathGlobs: [...pathGlobs],
		verificationCommands: [...verificationCommands],
	};
}

// ── Pure reducer ────────────────────────────────────────────

export function initialLoopState(opts: {
	maxIterations: number | null;
	tokenBudget: number | null;
	envelopeRef?: string | null;
	trustedBase?: string | null;
}): LoopState {
	return {
		version: 1,
		iteration: 0,
		maxIterations: opts.maxIterations,
		envelopeRef: opts.envelopeRef ?? null,
		trustedBase: opts.trustedBase ?? null,
		lastMergedHeadSha: null,
		cumulativeTokenDeltas: 0,
		tokenBudget: opts.tokenBudget,
		phase: "plan",
		currentSliceId: null,
		currentPlanPath: null,
		terminal: null,
		updatedAt: new Date().toISOString(),
	};
}

function terminate(prev: LoopState, terminal: LoopTerminal): LoopState {
	return { ...prev, terminal, updatedAt: new Date().toISOString() };
}
function to(prev: LoopState, patch: Partial<LoopState>): LoopState {
	return { ...prev, ...patch, updatedAt: new Date().toISOString() };
}

export function nextLoopState(prev: LoopState, t: LoopTransition): LoopState {
	if (prev.terminal) return prev;
	switch (t.type) {
		case "stop-file":
			return terminate(prev, { reason: "stop-file" });
		case "roadmap-complete":
			return terminate(prev, { reason: "roadmap-complete" });
		case "planner-error":
			return terminate(prev, { reason: "planner-error", detail: t.detail });
		case "envelope-breach":
			return terminate(prev, { reason: "envelope-breach", detail: t.detail });
		case "acceptance-failed":
			return terminate(prev, { reason: "acceptance-fail", detail: t.detail });
		case "token-deltas-observed": {
			const cumulativeTokenDeltas = prev.cumulativeTokenDeltas + t.count;
			if (
				prev.tokenBudget !== null &&
				cumulativeTokenDeltas > prev.tokenBudget
			) {
				return terminate(
					{ ...prev, cumulativeTokenDeltas },
					{
						reason: "token-budget",
						detail: `cumulative ${cumulativeTokenDeltas} > budget ${prev.tokenBudget}`,
					},
				);
			}
			return to(prev, { cumulativeTokenDeltas });
		}
		case "slice-selected":
			return to(prev, {
				phase: "dry-run",
				currentSliceId: t.sliceId,
				currentPlanPath: t.planPath,
			});
		case "dry-run-ok":
			return to(prev, { phase: "envelope-check" });
		case "envelope-ok":
			return to(prev, { phase: "admit" });
		case "admitted":
			return to(prev, { phase: "dispatch" });
		case "dispatched":
			return to(prev, { phase: "accept" });
		case "accepted":
			return to(prev, { phase: "merge" });
		case "merged":
			return to(prev, { phase: "reanchor", lastMergedHeadSha: t.headSha });
		case "advance": {
			const nextIteration = prev.iteration + 1;
			if (prev.maxIterations !== null && nextIteration > prev.maxIterations) {
				return terminate(prev, { reason: "max-iterations" });
			}
			return to(prev, {
				phase: "plan",
				iteration: nextIteration,
				currentSliceId: null,
				currentPlanPath: null,
			});
		}
	}
}

// ── Persistence + stop-file + runaway guard ─────────────────

export function loopStatePath(workspace: string): string {
	return join(workspace, ".buildplane", "loop-state.json");
}

export function readLoopState(workspace: string): LoopState | null {
	const p = loopStatePath(workspace);
	if (!existsSync(p)) return null;
	return JSON.parse(readFileSync(p, "utf8")) as LoopState;
}

export function writeLoopStateAtomic(
	workspace: string,
	state: LoopState,
): void {
	const p = loopStatePath(workspace);
	mkdirSync(dirname(p), { recursive: true });
	const tmp = `${p}.tmp.${process.pid}`;
	writeFileSync(tmp, JSON.stringify(state, null, 2));
	renameSync(tmp, p);
}

export function stopFileRequested(workspace: string): boolean {
	return existsSync(join(workspace, ".buildplane", "loop.stop"));
}

/**
 * Per-iteration runaway guard: a `PolicyProfile` carrying `budgets` so the
 * orchestrator's `AbortController` aborts a single runaway model worker once it
 * crosses `maxTokens` / `maxComputeTimeMs`. Distinct from the supervisor's
 * cumulative cross-iteration `tokenBudget` cap (tracked in `loop-state.json`).
 */
export function runawayGuardProfile(opts: {
	profileName: string;
	maxTokens: number;
	maxComputeTimeMs: number;
	baseProfile?: PolicyProfile;
}): PolicyProfile {
	const budgets: BudgetConstraints = {
		maxTokens: opts.maxTokens,
		maxComputeTimeMs: opts.maxComputeTimeMs,
	};
	return { ...(opts.baseProfile ?? {}), name: opts.profileName, budgets };
}
