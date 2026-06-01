import type { EventBus, ExecutionEvent } from "./events.js";
import type {
	ProcedureRetrievalQuery,
	RankedProcedureResult,
	RankedRepoFactResult,
	RankedSearchableDocumentResult,
	RepoFactRetrievalQuery,
	SearchableDocumentRetrievalQuery,
} from "./memory-retrieval.js";
import type {
	AppendRunOutcomeInput,
	CreateProcedureInput,
	CreateSearchableDocumentInput,
	MemoryScopeType,
	ProcedureMemory,
	RepoFact,
	RunOutcome,
	SearchableDocument,
	UpsertRepoFactInput,
	WorkerLabel,
} from "./memory-types.js";
import type {
	ExtractedLearning,
	LearningKind,
	LearningScope,
} from "./outcome-extractor.js";
import type {
	ArchitectureDiffScopeGate,
	BudgetConstraints,
	PolicyProfile,
	ResourceUsageSnapshot,
} from "./policy.js";
import type {
	ApprovedPolicyDecision,
	ExecutionReceipt,
	InjectedMemoryRecord,
	InspectSnapshot,
	PersistedInjectedMemoryRecord,
	PolicyDecision,
	RejectedPolicyDecision,
	RunInfrastructureFailure,
	StatusSnapshot,
	UnitPacket,
} from "./run-loop.js";
import type { Run } from "./types.js";

export interface CreateRunOptions {
	readonly runId?: string;
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
	upsertRepoFact(input: UpsertRepoFactInput): RepoFact;
	getRepoFact(
		factKey: string,
		options?: {
			scopeType?: MemoryScopeType;
			scopeKey?: string;
		},
	): RepoFact | null;
	listRepoFacts(options?: {
		scopeType?: MemoryScopeType;
		scopeKey?: string;
	}): readonly RepoFact[];
	retrieveRepoFacts(
		query: RepoFactRetrievalQuery,
	): readonly RankedRepoFactResult[];
	supersedeRepoFact(
		factKey: string,
		options?: {
			scopeType?: MemoryScopeType;
			scopeKey?: string;
		},
	): number;
	createProcedure(input: CreateProcedureInput): ProcedureMemory;
	upsertProcedure(
		input: CreateProcedureInput,
		options?: {
			matchMetadata?: Record<string, string>;
			skipIfConflictingActiveName?: boolean;
		},
	): ProcedureMemory | null;
	listProcedures(options?: { taskType?: string }): readonly ProcedureMemory[];
	findProceduresByTaskType(taskType: string): readonly ProcedureMemory[];
	retrieveProcedures(
		query: ProcedureRetrievalQuery,
	): readonly RankedProcedureResult[];
	supersedeProcedure(id: string): number;
	createSearchableDocument(
		input: CreateSearchableDocumentInput,
	): SearchableDocument;
	getSearchableDocument(id: string): SearchableDocument | undefined;
	listSearchableDocuments(options?: {
		documentKind?: string;
		sourceTable?: string;
		sourceId?: string;
		limit?: number;
	}): readonly SearchableDocument[];
	searchSearchableDocuments(
		query: string,
		options?: {
			documentKind?: string;
			limit?: number;
		},
	): readonly SearchableDocument[];
	retrieveSearchableDocuments(
		query: SearchableDocumentRetrievalQuery,
	): readonly RankedSearchableDocumentResult[];
	recordInjectedMemories(
		runId: string,
		records: readonly InjectedMemoryRecord[],
	): void;
	listInjectedMemories(runId: string): readonly PersistedInjectedMemoryRecord[];
	getStatusSnapshot(): StatusSnapshot;
	inspectTarget(id: string): InspectSnapshot;
	listEvents(options: {
		runId: string;
		limit?: number;
	}): readonly ExecutionEvent[];
	appendRunOutcome(input: AppendRunOutcomeInput): RunOutcome;
	listRunOutcomes(options?: {
		repoId?: string;
		taskType?: string;
		worker?: WorkerLabel;
	}): readonly RunOutcome[];
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
	 * Deterministic architecture diff-scope trust gate.
	 * Returns a rejected decision when changed files escape the configured scope.
	 * Returns null when the gate passes.
	 */
	evaluateArchitectureDiffScope?(
		changedFiles: readonly string[],
		gate: ArchitectureDiffScopeGate,
	): RejectedPolicyDecision | null;

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
	/**
	 * Real `git status` of an already-prepared isolated worktree, with the same
	 * `.buildplane/**` exclusions `assertRunnableRepository` uses (ledger WAL files
	 * under `.buildplane/ledger/` would otherwise read as dirty). Returns false on
	 * any git error — fail closed.
	 */
	checkWorktreeClean(worktreePath: string): boolean;
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
	/**
	 * Promote learnings that have crossed the seen-count threshold.
	 * session (seen_count >= 3) → workspace; workspace (seen_count >= 5) → user.
	 * Idempotent — skips if a promoted row already exists.
	 */
	promoteLearnings(runId: string): void;
	/**
	 * Retrieve a single learning by its ID. Returns undefined if not found or not active.
	 * Synchronous.
	 */
	fetchLearningById(id: string): StoredLearning | undefined;
	/**
	 * Retrieve all active learnings produced by a specific run.
	 * Synchronous. No limit — a single run produces at most a few learnings.
	 */
	fetchLearningsByRunId(runId: string): readonly StoredLearning[];
}
