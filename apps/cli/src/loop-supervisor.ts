import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
	BudgetConstraints,
	EnvelopeProposal,
	LedgerActivityPort,
	PolicyProfile,
} from "@buildplane/kernel";
import type { TapeEmitter } from "@buildplane/ledger-client";
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
	// Infra/dispatch failure: the worker never produced side effects (e.g. a 429
	// rejection — 0 tokens, 0 turns, empty diff) and exited non-zero. Kept distinct
	// from `acceptance-fail`, where the worker DID run and built a diff the
	// acceptance contract then rejected. The distinction makes an infra death
	// honestly labelled and the loop re-fireable rather than looking like a real
	// build attempt that failed review.
	| "dispatch-error"
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
	| { type: "dispatch-error"; detail: string }
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

/**
 * Seed a fresh loop's `trustedBase` from the workspace git HEAD (R7 FIX 3). A
 * bare `planforge loop --reset` deletes `loop-state.json`; the next fresh init
 * otherwise starts with `trustedBase: null`, which makes the planner report
 * INSUFFICIENT_EVIDENCE and the loop die before it ever dispatches. Mirroring
 * `bp goal`'s HEAD auto-detect closes that gap so `--reset` then re-fire works.
 *
 * `resolveHead` is injected (rather than reading git directly) so this stays a
 * pure, unit-testable function. Returns `null` when HEAD cannot be resolved
 * (e.g. a non-git workspace) — the caller keeps the prior null-base behaviour
 * rather than crashing.
 */
export function seedTrustedBaseFromHead(
	resolveHead: () => string | null,
): string | null {
	const head = resolveHead()?.trim();
	return head && head.length > 0 ? head : null;
}

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
		case "dispatch-error":
			return terminate(prev, { reason: "dispatch-error", detail: t.detail });
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

/**
 * `planforge loop --reset`: delete the persisted `loop-state.json` so the next
 * loop invocation starts a fresh run. A loop that halted on a terminal state
 * (e.g. `dispatch-error` from a 429) otherwise resumes straight back into that
 * sticky terminal; clearing the file is the re-fire path. Returns `true` if a
 * file was removed, `false` if none existed (idempotent — never throws).
 */
export function clearLoopState(workspace: string): boolean {
	const p = loopStatePath(workspace);
	if (!existsSync(p)) return false;
	rmSync(p, { force: true });
	return true;
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
 *
 * Precision note: the orchestrator counts `model-token-delta` events, which the
 * claude executor emits one-per-assistant-text-block (NOT one-per-token), so
 * `maxTokens` here is an APPROXIMATE response-volume proxy — a worker emitting
 * mostly tool_use blocks under-counts. `maxComputeTimeMs` is the precise time
 * bound. The accurate token figure is the cumulative `tokenBudget` cap, fed from
 * each dispatch's real terminal `result.usage`.
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

/**
 * Demo crash-injection guard (M6 Property 1: crash-and-resume). When the
 * `BUILDPLANE_CRASH_AFTER_ACTIVITY=1` environment variable is set, wrap a
 * {@link LedgerActivityPort} so the process aborts HARD immediately after the
 * first `activity_completed` is appended AND flushed durable+signed to the tape —
 * before any terminal `plan_receipt`. This deterministically reproduces a worker
 * crashing mid-dispatch so `planforge recover`/`resume` can be exercised against a
 * real signed tape.
 *
 * NO-OP by default: with the env var unset (the production case) this returns the
 * port unchanged, so dispatch behaviour is byte-identical. It reads ONLY the env
 * var — it adds no CLI flag and never touches the argument parser. `abort` is
 * injectable so a unit test can assert the guard fires without killing the runner.
 */
export function withCrashAfterActivityGuard(
	port: LedgerActivityPort,
	emitter: Pick<TapeEmitter, "flush">,
	abort: () => never = () => process.exit(137),
): LedgerActivityPort {
	if (process.env.BUILDPLANE_CRASH_AFTER_ACTIVITY !== "1") {
		return port;
	}
	return {
		...port,
		async activityCompleted(input) {
			await port.activityCompleted(input);
			// Make the completion durable+signed on the tape before the crash so the
			// recovered run reuses the recorded result instead of re-invoking.
			await emitter.flush();
			abort();
		},
	};
}
