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
	AcceptanceCheckResult,
	AcceptanceContractV0,
	AcceptanceEvidence,
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
import type { Run, RunStatus } from "./types.js";

export interface CreateRunOptions {
	readonly runId?: string;
	readonly parentRunId?: string;
	readonly strategyId?: string;
}

export type AcceptanceShadowOutcome = "passed" | "rejected";

/**
 * A page of runs. Extends `readonly Run[]` so existing callers keep `.map`,
 * iteration, and `.length`; `cursor` is the opaque token to fetch the next page.
 */
export interface RunPage extends ReadonlyArray<Run> {
	readonly cursor?: string;
}

export interface PendingOperatorDecision {
	readonly runId: string;
	readonly subject: "resume" | "merge";
	readonly since: string;
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
	/**
	 * Every run currently in `status`, oldest first. Used by S7 crash recovery to
	 * find orphaned `running` runs whose process died before a terminal status and
	 * by Mission Control's run lists. The result is an array (iterable, `.map`,
	 * `.length`) carrying an opaque `cursor` when more rows remain past `limit`;
	 * pass it back as `options.cursor` to fetch the next page. Without `limit` the
	 * full set is returned and `cursor` is `undefined`.
	 */
	listRunsByStatus(
		status: RunStatus,
		options?: { limit?: number; cursor?: string },
	): RunPage;
	/**
	 * Write the Tier-1 acceptance shadow for a run — the only read-back source for
	 * "this run passed acceptance." Set from the M4 acceptance path alongside the
	 * signed `acceptance_recorded` event; additive and idempotent per run.
	 */
	recordAcceptanceShadow(runId: string, outcome: AcceptanceShadowOutcome): void;
	/**
	 * The operator inbox feed: every suspended run (subject `resume`) plus every
	 * run whose acceptance shadow `passed` with no `operator_decision_recorded`
	 * event yet on the Tier-1 events mirror (subject `merge`). Oldest first.
	 */
	listPendingOperatorDecisions(): readonly PendingOperatorDecision[];
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

export type LedgerActivityType = "model" | "tool" | "command";

export interface LedgerActivityStartInput {
	readonly runId: string;
	readonly activityId: string;
	readonly activityType: LedgerActivityType;
	/** Deterministic activity input; the impl digests it into ActivityStartedV1.input_digest. */
	readonly input: unknown;
}

export interface LedgerActivityCompleteInput {
	readonly runId: string;
	readonly activityId: string;
	/** Recorded activity result; the impl digests it into result_digest and stores it inline. */
	readonly result: unknown;
}

/**
 * Kernel-facing seam for emitting signed activity bracket events. The concrete
 * impl (CLI layer) wraps a signed ledger TapeEmitter. `activityStarted` MUST
 * resolve only once the event is durably on the tape (write-ahead), so the
 * orchestrator can `await` it before invoking the activity.
 */
export interface LedgerActivityPort {
	activityStarted(input: LedgerActivityStartInput): Promise<void>;
	activityCompleted(input: LedgerActivityCompleteInput): Promise<void>;
}

export interface AcceptanceCheckCollectionInput {
	readonly contract: AcceptanceContractV0;
	readonly workspacePath: string;
	readonly packet: UnitPacket;
	readonly receipt: ExecutionReceipt;
	readonly attemptCount: number;
}

/**
 * Kernel-owned finalization seam for collecting acceptance-check evidence.
 * Runtime receipts are worker-produced evidence; acceptance checks must be
 * gathered by the finalization path before a run may be marked successful.
 */
export interface BuildplaneAcceptanceEvidencePort {
	collectCheckResults(
		input: AcceptanceCheckCollectionInput,
	): readonly AcceptanceCheckResult[];
}

/** Structured diff-scope arm of an acceptance verdict (for the signed event). */
export interface AcceptanceDiffScopeResult {
	readonly status: "passed" | "blocked";
	readonly outOfScopeFiles: readonly string[];
}

/**
 * Verdict the kernel independently computed for an acceptance contract at
 * finalization. The kernel supplies what it observed against reality; the plan
 * identity (`plan_id`, `contract_digest`) is held by the CLI port closure that
 * built the per-task profile, so it is not re-derived here. `outcome ===
 * "rejected"` carries the diff-scope status and the escaping files; a pass
 * leaves them empty.
 */
export interface AcceptanceRecordInput {
	readonly runId: string;
	/** Tape pointer to the signed `plan_admitted` (the packet's `provenance_ref`). */
	readonly admissionEventId: string;
	readonly outcome: "passed" | "rejected";
	readonly diffScopeStatus: "passed" | "blocked";
	readonly outOfScopeFiles: readonly string[];
	readonly checkResults: readonly AcceptanceCheckResult[];
	/** RFC3339 evaluation timestamp. */
	readonly evaluatedAt: string;
}

/**
 * Kernel-facing seam for appending the signed `acceptance_recorded` finalization
 * verdict. The concrete impl (CLI layer) wraps a signed ledger TapeEmitter and
 * supplies the plan identity it closed over. `recordAcceptance` MUST resolve only
 * once the event is durably on the tape (write-ahead — mirrors
 * `LedgerActivityPort.activityStarted`), so the kernel can `await` it before the
 * workspace is merged or quarantined.
 */
export interface BuildplaneAcceptancePort {
	recordAcceptance(input: AcceptanceRecordInput): Promise<void>;
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
	 * Finalization-time acceptance contract gate.
	 * Returns a rejected decision when required acceptance evidence is missing
	 * or failing. Returns null when finalization may continue.
	 */
	evaluateAcceptanceContract?(
		contract: AcceptanceContractV0,
		evidence: AcceptanceEvidence,
	): RejectedPolicyDecision | null;

	/**
	 * Structured diff-scope arm of the acceptance verdict, used to populate the
	 * `acceptance_recorded` event's `diff_scope_status` + `out_of_scope_files`.
	 * Separate from {@link evaluateAcceptanceContract} (which collapses to a
	 * reason list) because the signed event records the escaping files verbatim.
	 */
	evaluateAcceptanceDiffScope?(
		changedFiles: readonly string[],
		contract: AcceptanceContractV0,
	): AcceptanceDiffScopeResult;

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
	}): { mergedHeadSha: string };
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
