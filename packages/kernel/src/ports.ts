import type { EventBus } from "./events.js";
import type {
	ExtractedLearning,
	LearningKind,
	LearningScope,
} from "./outcome-extractor.js";
import type {
	BudgetConstraints,
	PolicyProfile,
	ResourceUsageSnapshot,
} from "./policy.js";
import type {
	ApprovedPolicyDecision,
	ExecutionReceipt,
	InspectSnapshot,
	PolicyDecision,
	RejectedPolicyDecision,
	RunInfrastructureFailure,
	StatusSnapshot,
	UnitPacket,
} from "./run-loop.js";
import type { Run } from "./types.js";

export interface CreateRunOptions {
	readonly parentRunId?: string;
	readonly strategyId?: string;
}

export interface BuildplaneStoragePort {
	initializeProject(): {
		created: boolean;
		projectRoot: string;
		stateDbPath: string;
	};
	createRun(packet: UnitPacket, options?: CreateRunOptions): Run;
	getChildRuns(parentRunId: string): Run[];
	markRunRunning(runId: string): void;
	recordExecutionEvidence(runId: string, receipt: ExecutionReceipt): void;
	recordDecision(runId: string, decision: PolicyDecision): void;
	completeRun(runId: string, status: Run["status"]): Run;
	recordWorkspacePrepared(
		runId: string,
		workspace: {
			path: string;
			headSha: string;
			sourceProjectRoot: string;
		},
	): void;
	commitRunFailureOutcome(
		runId: string,
		payload:
			| {
					decision: RejectedPolicyDecision;
					infrastructureFailure?: never;
					workspaceStatus: "retained";
			  }
			| {
					decision?: never;
					infrastructureFailure: RunInfrastructureFailure;
					workspaceStatus?: "retained";
			  },
	): Run;
	commitRunSuccessOutcome(runId: string, decision: ApprovedPolicyDecision): Run;
	recordWorkspaceDeleted(runId: string): void;
	recordWorkspaceCleanupFailed(runId: string, message: string): void;
	suspendRun(runId: string): Run;
	approveRun(runId: string): Run;
	rejectSuspendedRun(runId: string): Run;
	getStatusSnapshot(): StatusSnapshot;
	inspectTarget(id: string): InspectSnapshot;
}

export interface BuildplaneRuntimePort {
	executePacket(packet: UnitPacket, projectRoot: string): ExecutionReceipt;
	executePacketAsync?(
		packet: UnitPacket,
		projectRoot: string,
		eventBus: EventBus,
		signal?: AbortSignal,
	): Promise<ExecutionReceipt>;
}

export interface BuildplanePolicyPort {
	evaluateRun(
		packet: UnitPacket,
		receipt: ExecutionReceipt,
		profile?: PolicyProfile,
		attemptCount?: number,
	): PolicyDecision;

	/**
	 * Mid-execution budget evaluation.
	 * Returns a reject decision if a hard limit is breached, null otherwise.
	 */
	evaluateBudgets?(
		packet: UnitPacket,
		usage: ResourceUsageSnapshot,
		budgets?: BudgetConstraints,
	): PolicyDecision | null;

	/**
	 * Pre-execution trust gate for tool calls.
	 * Returns a reject decision if the tool is restricted, null if allowed.
	 */
	evaluateTrustGate?(
		toolName: string,
		profile?: PolicyProfile,
	): PolicyDecision | null;
}

export interface BuildplaneProfileRegistryPort {
	resolve(name: string): PolicyProfile;
}

export interface BuildplaneWorkspacePort {
	assertRunnableRepository(projectRoot: string): { headSha: string };
	prepareWorkspace(
		projectRoot: string,
		runId: string,
		headSha: string,
	): {
		path: string;
		headSha: string;
	};
	commitAndMergeWorkspace?(workspace: {
		path: string;
		runId: string;
		projectRoot?: string;
	}): void;
	deleteWorkspace(workspace: { path: string; projectRoot?: string }): {
		deleted: boolean;
		cleanupError?: string;
	};
}

export interface StoredLearning extends ExtractedLearning {
	readonly id: string;
	readonly runId: string;
	readonly status: "active" | "superseded" | "archived";
	readonly createdAt: string;
	readonly seenCount: number;
}

export interface BuildplaneMemoryPort {
	/**
	 * Persist extracted learnings for a completed run.
	 * Synchronous (backed by DatabaseSync — never returns a Promise).
	 */
	writeLearnings(runId: string, learnings: readonly ExtractedLearning[]): void;
	/**
	 * Retrieve active learnings for injection into the next run's prompt.
	 * Synchronous. Default limit: 20.
	 */
	fetchLearnings(options?: {
		scope?: LearningScope;
		kind?: LearningKind;
		limit?: number;
	}): readonly StoredLearning[];
}
