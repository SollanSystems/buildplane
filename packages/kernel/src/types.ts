import type { UnitPacket } from "./run-loop.js";

// ── Strategy execution roles & modes ───────────────────────

export type ExecutionRole =
	| "implementer"
	| "reviewer"
	| "adversary"
	| "judge"
	| "candidate";

export type StrategyMode =
	| "single"
	| "implement-then-review"
	| "parallel-candidates"
	| "escalate-on-disagreement"
	| "adversarial";

export type MergePolicy =
	| "direct"
	| "reviewer-must-approve"
	| "best-by-objective"
	| "judge-decides"
	| "adversary-loop";

export interface StrategyChild {
	readonly packet: UnitPacket;
	readonly role: ExecutionRole;
	readonly dependsOn?: readonly string[];
}

export interface StrategyPacket {
	readonly id: string;
	readonly mode: StrategyMode;
	readonly children: readonly StrategyChild[];
	readonly mergePolicy: MergePolicy;
}

export interface MergeDecision {
	readonly policy: MergePolicy;
	readonly outcome: "accepted" | "rejected" | "escalated";
	readonly reasons: readonly string[];
	readonly selectedCandidateId?: string;
}

export interface StrategyResult {
	readonly strategyId: string;
	readonly mode: StrategyMode;
	readonly outcome: "passed" | "failed" | "mixed";
	readonly childResults: Map<string, import("./run-loop.js").RunPacketResult>;
	readonly winnerRunId?: string;
	readonly mergeDecision: MergeDecision;
}

// ── Task intent + renderer types ───────────────────────────

export type TaskType =
	| "implement"
	| "review"
	| "diagnose"
	| "refactor"
	| "test-gen"
	| "security-audit"
	| "migration"
	| "architecture";

export interface TaskFeatures {
	readonly ambiguity: "low" | "medium" | "high";
	readonly reversibility: "easy" | "hard";
	readonly verifierStrength: "strong" | "weak" | "none";
	readonly language?: string;
	readonly framework?: string;
	readonly estimatedComplexity?: "low" | "medium" | "high";
	readonly changeSurface?: number;
}

export interface TaskIntent {
	readonly objective: string;
	readonly taskType: TaskType;
	readonly context: {
		readonly files: readonly string[];
		readonly priorWork?: readonly string[];
		readonly memories?: readonly string[];
		readonly codebaseHints?: string;
		readonly retryContext?: string;
	};
	readonly constraints: {
		readonly scope: readonly string[];
		readonly forbidden?: readonly string[];
		readonly verification: readonly string[];
	};
	readonly features: TaskFeatures;
}

export interface RenderedPrompt {
	readonly system?: string;
	readonly prompt: string;
	readonly maxTokens?: number;
	readonly tools?: readonly import("./run-loop.js").ToolDefinition[];
}

export interface TaskRenderer {
	readonly provider: string;
	render(intent: TaskIntent, role: ExecutionRole): RenderedPrompt;
}

// ── Core kernel types ───────────────────────────────────────

/**
 * A bounded piece of work dispatched by the execution kernel.
 *
 * Units are the atomic scheduling primitive in Buildplane.
 * The kernel owns their lifecycle; runtime executes them;
 * policy gates their advancement.
 */
export interface Unit {
	/** Unique identifier for this unit. */
	readonly id: string;

	/** The kind of work this unit represents. */
	readonly kind: string;

	/** The scope boundary for execution (e.g. "task", "step"). */
	readonly scope: string;

	/** References to inputs this unit depends on. */
	readonly inputRefs: readonly string[];

	/** Descriptions of outputs this unit is expected to produce. */
	readonly expectedOutputs: readonly string[];

	/** The verification contract that must be satisfied for completion. */
	readonly verificationContract: string;

	/** The policy profile governing this unit's execution. */
	readonly policyProfile: string;
}

export type RunStatus =
	| "pending"
	| "running"
	| "passed"
	| "failed"
	| "cancelled"
	| "suspended";

/**
 * One end-to-end execution attempt of a Unit under a policy profile.
 *
 * Runs are append-only entries in the event log. The kernel
 * creates them; runtime populates evidence; policy evaluates
 * whether the run's outcome is acceptable.
 */
export interface Run {
	/** Unique identifier for this run. */
	readonly id: string;

	/** The unit this run is executing. */
	readonly unitId: string;

	/** Current lifecycle status of the run. */
	readonly status: RunStatus;
}
