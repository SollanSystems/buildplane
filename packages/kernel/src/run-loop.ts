import type { Run, RunStatus, Unit } from "./types.js";

export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;
}

export interface ModelExecutionBlock {
	readonly provider: string;
	readonly model: string;
	readonly systemPrompt?: string;
	readonly prompt?: string;
	readonly tools?: readonly ToolDefinition[];
}

export interface CommandExecutionBlock {
	readonly command: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
}

export interface RoutingHints {
	readonly preferredWorker?: "claude-code";
	readonly preferredModel?: string;
	readonly effort?: "low" | "medium" | "high";
}

export interface UnitPacket {
	readonly unit: Unit;
	readonly execution?: CommandExecutionBlock;
	readonly model?: ModelExecutionBlock;
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

export interface PolicyDecision {
	readonly kind: "advance-run" | "reject-run";
	readonly outcome: "approved" | "rejected";
	readonly reasons: readonly string[];
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
	};
}

export interface InspectSnapshot {
	readonly kind: "run" | "unit";
	readonly unit: Unit;
	readonly run: Run;
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
	readonly receipt: ExecutionReceipt;
	readonly decision: PolicyDecision;
}
