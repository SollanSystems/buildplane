import type { Run, RunStatus, Unit } from "./types.js";

export interface UnitPacket {
	readonly unit: Unit;
	readonly execution: {
		readonly command: string;
		readonly args?: readonly string[];
		readonly cwd?: string;
	};
	readonly verification: {
		readonly requiredOutputs: readonly string[];
	};
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

export type PolicyDecision = ApprovedPolicyDecision | RejectedPolicyDecision;

export interface WorkspaceSnapshot {
	readonly runId: string;
	readonly path: string;
	readonly headSha: string;
	readonly status: "active" | "deleted" | "retained" | "cleanup-failed";
	readonly finalizedAt?: string;
	readonly cleanupError?: string;
}

export interface StatusWorkspaceSummary {
	readonly runId: string;
	readonly path?: string;
	readonly headSha: string;
	readonly status: "active" | "deleted" | "retained" | "cleanup-failed";
	readonly finalizedAt?: string;
	readonly cleanupError?: string;
}

export interface RunInfrastructureFailure {
	readonly kind: string;
	readonly message: string;
}

export interface StatusSnapshot {
	readonly initialized: boolean;
	readonly latestRun?: {
		readonly id: string;
		readonly unitId: string;
		readonly status: RunStatus;
	};
	readonly latestRunUsedWorkspace: boolean;
	readonly latestWorkspace?: StatusWorkspaceSummary;
	readonly actionableWorkspaces: readonly WorkspaceSnapshot[];
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
	readonly workspace?: WorkspaceSnapshot;
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
}
