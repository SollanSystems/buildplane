import type { MemoryStatus } from "./memory-types.js";
import type { Run, RunStatus, Unit } from "./types.js";

export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;
}

export interface ModelExecutionBlock {
	readonly provider: string;
	readonly model: string;
	readonly prompt?: string;
	readonly systemPrompt?: string;
	readonly tools?: readonly ToolDefinition[];
}

export interface RoutingHints {
	readonly preferredWorker?: "claude-code" | "codex";
	readonly preferredModel?: string;
	readonly effort?: "low" | "medium" | "high";
}

export interface CommandExecutionBlock {
	readonly command: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
}

export interface UnitPacket {
	readonly unit: Unit;
	readonly execution?: CommandExecutionBlock;
	readonly model?: ModelExecutionBlock;
	readonly intent?: import("./types.js").TaskIntent;
	readonly verification: {
		readonly requiredOutputs: readonly string[];
	};
	readonly routingHints?: RoutingHints;
	/**
	 * Tape pointer to the signed `plan_admitted` event id authorizing this
	 * packet's dispatch. Empty string for packets not dispatched via PlanForge
	 * admission; when non-empty, the kernel admission gate (added later in this
	 * slice) verifies this pointer before dispatch.
	 */
	readonly provenance_ref: string;
	/** Reserved for M3 capability broker — typed but unused in M2. */
	readonly capability_bundle?: unknown;
	/** Reserved for M4 acceptance contract — typed but unused in M2. */
	readonly acceptance_contract?: unknown;
	/** Reserved for M3 trust scoping — typed but unused in M2. */
	readonly trust_scope?: unknown;
}

export interface OutputCheck {
	readonly path: string;
	readonly exists: boolean;
}

/**
 * Runtime receipt for a side effect that crosses the local read/compute boundary.
 * Examples: creating a PR draft, publishing a comment, mutating remote state.
 */
export interface SideEffectReceipt {
	readonly id: string;
	readonly capability: string;
	readonly action: string;
	readonly target: string;
	readonly grantId?: string;
	readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface ExecutionReceipt {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly startedAt: string;
	readonly completedAt: string;
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly outputChecks: readonly OutputCheck[];
	/** Deterministic repo-relative diff paths captured after execution when available. */
	readonly changedFiles?: readonly string[];
	readonly sideEffects?: readonly SideEffectReceipt[];
}

export interface ApprovedPolicyDecision {
	readonly kind: "advance-run";
	readonly outcome: "approved";
	readonly reasons: readonly string[];
}

export interface RejectedPolicyDecision {
	readonly kind: "reject-run" | "architecture.diff_scope";
	readonly outcome: "rejected";
	readonly reasons: readonly string[];
}

export interface RetryPolicyDecision {
	readonly kind: "retry-run";
	readonly outcome: "retrying";
	readonly reasons: readonly string[];
	readonly attemptNumber: number;
	readonly feedbackContext: readonly string[];
}

export type PolicyDecision =
	| ApprovedPolicyDecision
	| RejectedPolicyDecision
	| RetryPolicyDecision;

export interface RunInfrastructureFailure {
	readonly kind: string;
	readonly message: string;
}

export interface InjectedMemoryRecord {
	readonly memoryKind: "repo-fact" | "procedure" | "searchable-document";
	readonly memoryId: string;
	readonly displayText: string;
	readonly matchReason: string;
	readonly matchClass: "exact" | "fuzzy" | "full-text";
	readonly scopePreferenceIndex?: number;
}

export interface PersistedInjectedMemoryRecord extends InjectedMemoryRecord {
	readonly id: string;
	readonly runId: string;
	readonly createdAt: string;
}

export interface PromotedStructuredMemoryRecord {
	readonly memoryKind: "procedure" | "repo-fact" | "searchable-document";
	readonly memoryId: string;
	readonly title: string;
	readonly taskType?: string;
	readonly bodySummary?: string;
	readonly status: MemoryStatus;
	readonly promotionRule?: string;
	readonly sourceRunId?: string;
	readonly sourceTaskId?: string;
	readonly createdAt: string;
}

export interface WorkspaceSnapshot {
	readonly runId: string;
	readonly path: string;
	readonly headSha: string;
	readonly status: "active" | "retained" | "deleted" | "cleanup-failed";
	readonly finalizedAt?: string;
	readonly cleanupError?: string;
}

export interface StatusWorkspaceSummary {
	readonly runId: string;
	readonly path: string;
	readonly headSha: string;
	readonly status: "active" | "retained" | "deleted" | "cleanup-failed";
	readonly finalizedAt?: string;
	readonly cleanupError?: string;
}

export interface StatusSnapshot {
	readonly initialized: boolean;
	readonly latestRun?: {
		readonly id: string;
		readonly unitId: string;
		readonly status: RunStatus;
	};
	readonly runCounts: {
		readonly pending: number;
		readonly running: number;
		readonly passed: number;
		readonly failed: number;
		readonly cancelled: number;
		readonly suspended: number;
	};
}

export interface InspectProvenanceRoute {
	readonly worker: string;
	readonly source: string;
	readonly provider?: string;
	readonly model?: string;
	readonly preferredWorker?: RoutingHints["preferredWorker"];
	readonly preferredModel?: string;
	readonly effort?: RoutingHints["effort"];
}

export interface InspectProvenancePolicy {
	readonly profile: string;
	readonly decisionKind?: PolicyDecision["kind"];
	readonly decisionOutcome?: PolicyDecision["outcome"];
	readonly decisionReasons?: readonly string[];
}

export interface InspectProvenance {
	readonly route: InspectProvenanceRoute;
	readonly policy: InspectProvenancePolicy;
}

export type InspectEventTapeMetadataValue = string | number | boolean;

export interface InspectEventTapeKindCount {
	readonly kind: string;
	readonly count: number;
}

export interface InspectEventTapeEntry {
	readonly id: string;
	readonly kind: string;
	readonly occurredAt: string;
	readonly summary: string;
	readonly metadata?: Readonly<Record<string, InspectEventTapeMetadataValue>>;
}

export interface InspectEventTapeSummary {
	readonly runId: string;
	readonly eventCount: number;
	readonly firstKind?: string;
	readonly lastKind?: string;
	readonly firstOccurredAt?: string;
	readonly lastOccurredAt?: string;
	readonly terminalStatus?: RunStatus;
	readonly kindCounts?: readonly InspectEventTapeKindCount[];
	readonly events: readonly InspectEventTapeEntry[];
}

export interface InspectSnapshot {
	readonly kind: "run" | "unit";
	readonly unit: Unit;
	readonly run: Run;
	readonly eventTape?: InspectEventTapeSummary;
	readonly provenance?: {
		readonly route: {
			readonly worker: string;
			readonly source: "routing-hints" | "model-block" | "command-block";
			readonly preferredModel?: string;
			readonly effort?: string;
			readonly provider?: string;
			readonly model?: string;
		};
		readonly memory?: {
			readonly injectedCount: number;
			readonly matchReasons: readonly string[];
			readonly matchClasses: readonly PersistedInjectedMemoryRecord["matchClass"][];
		};
		readonly policy: {
			readonly profile: string;
			readonly decisions?: readonly {
				readonly kind: PolicyDecision["kind"];
				readonly outcome: PolicyDecision["outcome"];
				readonly reasons: readonly string[];
			}[];
		};
	};
	readonly workspace?: WorkspaceSnapshot;
	readonly strategy?: {
		readonly strategyId: string;
	};
	readonly injectedMemories?: readonly PersistedInjectedMemoryRecord[];
	readonly promotedStructuredMemories?: readonly PromotedStructuredMemoryRecord[];
	readonly runHistory: readonly {
		readonly id: string;
		readonly status: RunStatus;
	}[];
	readonly evidence: readonly {
		readonly id: string;
		readonly kind: string;
		readonly status: string;
		readonly message?: string;
	}[];
	readonly decisions: readonly {
		readonly id: string;
		readonly kind: PolicyDecision["kind"];
		readonly outcome: PolicyDecision["outcome"];
		readonly reasons: readonly string[];
	}[];
	readonly artifacts: readonly {
		readonly id: string;
		readonly type: string;
		readonly location: string;
	}[];
}

export interface RunPacketResult {
	readonly run: Run;
	readonly receipt?: ExecutionReceipt;
	readonly decision?: PolicyDecision;
	readonly failure?: RunInfrastructureFailure;
	readonly workspace?: WorkspaceSnapshot;
	readonly injectedMemories?: readonly PersistedInjectedMemoryRecord[];
	readonly suspended?: boolean;
}
