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
}

export interface OutputCheck {
	readonly path: string;
	readonly exists: boolean;
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
}

export interface ApprovedPolicyDecision {
	readonly kind: "advance-run";
	readonly outcome: "approved";
	readonly reasons: readonly string[];
}

export interface RejectedPolicyDecision {
	readonly kind: "reject-run";
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

export interface InspectSnapshot {
	readonly kind: "run" | "unit";
	readonly unit: Unit;
	readonly run: Run;
	readonly workspace?: WorkspaceSnapshot;
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
