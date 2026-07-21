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
	WorkspaceCandidateArtifact,
} from "./run-loop.js";
import type {
	ActionEvidenceVersionV1,
	ActionReceiptRecordedV2,
	ActionReceiptSetRecordedV1,
	ActionRequestedV2,
	CandidateCompletionRecordedV1,
	CandidateCreatedV2,
	DispatchBudgetV1,
	ExecutionRoleV1,
	PromotionDecisionV1,
	PromotionGitBindingV1,
	ReviewVerdictV1,
} from "./trust-spine.js";
import type { Run, RunStatus } from "./types.js";

export interface CreateRunOptions {
	readonly runId?: string;
	readonly parentRunId?: string;
	readonly strategyId?: string;
	/**
	 * Durable execution lane. This is intentionally a record of how the run was
	 * entered, not a claim made by its worker. `unsafe` is used for the explicit
	 * raw compatibility lane and must never be upgraded by later verification.
	 */
	readonly trustLane?: "legacy" | "unsafe" | "governed";
}

/**
 * Kernel execution controls. This extends the storage-only run identity
 * options without leaking finalization behavior into `storage.createRun`.
 */
export interface RunPacketOptions extends CreateRunOptions {
	/**
	 * `auto-merge` is legal only with the explicit `unsafe` trust lane. Omitted
	 * and legacy options default to `discard`; governed work must use
	 * `create-candidate` and the promotion transaction.
	 */
	readonly finalizationMode?: "auto-merge" | "create-candidate" | "discard";
	/** Verified commit at which an isolated reviewer/validator workspace starts. */
	readonly workspaceBaseSha?: string;
	/** Stable strategy/workflow candidate identity when freezing a worktree. */
	readonly candidateIdentity?: {
		readonly candidateId: string;
		readonly attempt: number;
	};
	/**
	 * Supplied only by a governed dispatcher after its signed envelope and action
	 * receipt exist. The candidate finalizer copies this atomically with the
	 * immutable Git material; it never guesses authority from a legacy packet.
	 *
	 * @deprecated V1 lineage is readable for migration only. New governed work
	 * must use `governedDispatch`, which cannot carry a pre-effect receipt
	 * digest.
	 */
	readonly candidateGovernance?: CandidateGovernanceLineage;
	/**
	 * Verified pre-effect V3 dispatch lineage. The worker may only return
	 * durable action receipt references; the orchestrator seals their set after
	 * all effects and records CandidateCreatedV2 before candidate persistence.
	 */
	readonly governedDispatch?: GovernedDispatchLineageV3;
}

/**
 * The minimum signed lineage a candidate needs before it can be presented for
 * promotion. A missing field deliberately leaves an otherwise valid Git
 * candidate in the raw/deferred lane rather than fabricating governed proof.
 */
export interface CandidateGovernanceLineage {
	readonly workflowId: string;
	readonly provenanceRef: string;
	readonly envelopeDigest: string;
	/** Exact acceptance contract digest carried by the signed dispatch envelope. */
	readonly acceptanceContractDigest: string;
	readonly actionReceiptDigest: string;
}

/**
 * Immutable, verified admission facts supplied to a V3 action plane before it
 * can perform any effect. This is deliberately receipt-free: no candidate or
 * action receipt digest exists at dispatch time.
 *
 * The CLI/ledger admission boundary must verify the signed V3 envelope and
 * `dispatchEnvelopeRef` before constructing this object. The kernel repeats
 * all equality checks against the packet before delegating to the worker.
 */
export interface GovernedDispatchLineageV3 {
	readonly schemaVersion: 3;
	readonly runId: string;
	readonly workflowId: string;
	readonly workflowRevision: string;
	readonly unitId: string;
	readonly attempt: number;
	readonly provenanceRef: string;
	readonly dispatchEnvelopeRef: string;
	readonly envelopeDigest: string;
	readonly baseCommitSha: string;
	/** Exact repository instance/target binding verified before any V3 effect. */
	readonly repositoryBindingDigest: string;
	/** Exact host-owned ledger realm that owns activity uniqueness for this run. */
	readonly ledgerAuthorityRealmDigest: string;
	/** Exact normalized packet admitted into the signed sealed_v3 envelope. */
	readonly governedPacketDigest: string;
	readonly executionRole: ExecutionRoleV1;
	readonly commitMode: "atomic";
	readonly trustTier: "governed";
	readonly capabilityBundleDigest: string;
	readonly acceptanceContractDigest: string;
	readonly policyDigest: string;
	readonly contextManifestDigest: string;
	readonly workerManifestDigest: string;
	readonly sandboxProfileDigest: string;
	readonly budget: DispatchBudgetV1;
	readonly idempotencyKey: string;
	readonly authorityActor: string;
	readonly actionEvidenceVersion: ActionEvidenceVersionV1;
	readonly issuedAt: string;
	readonly expiresAt: string;
}

/**
 * Kernel-owned immutable descriptor for a review/adversary/judge execution.
 * The dispatcher resolves this from a frozen candidate projection and a
 * read-only sandbox mount; workers must not recover it from packet text, a run
 * id, or ambient repository state.
 */
export interface GovernedReviewCandidateContextV1 {
	readonly schemaVersion: 1;
	readonly candidateDigest: string;
	readonly candidateCommitSha: string;
	readonly candidateRef: string;
	/** Canonical tree digest of candidateCommitSha, verified by the kernel. */
	readonly candidateTreeDigest: string;
	/**
	 * Content-addressed, kernel-created description of the exact view that a
	 * review worker may inspect.  The host gateway resolves this reference; a
	 * caller-supplied path or candidate ref is never sufficient authority.
	 */
	readonly candidateViewRef: string;
	/**
	 * Canonical `buildplane.candidate-view.v1\0` digest over candidate identity,
	 * tree, reviewer context/sandbox, read-only mount, and no-network policy.
	 * Changing any of those fields invalidates the descriptor before a reviewer
	 * can act on it.
	 */
	readonly candidateViewDigest: string;
	readonly readOnlyMount: {
		readonly mode: "read-only";
		readonly mountPath: string;
		readonly mountDigest: string;
	};
	readonly context: {
		readonly contextRef: string;
		readonly contextManifestDigest: string;
	};
}

export interface CreateWorkspaceCandidateInput {
	readonly candidateId: string;
	readonly runId: string;
	readonly attempt: number;
	readonly path: string;
	readonly baseSha: string;
	readonly projectRoot?: string;
}

/**
 * V3-only candidate materialization. Creating the candidate Git ref is itself
 * an effect, so the adapter must execute it through the action plane and
 * return the resulting durable Git receipt before the kernel can seal a set.
 */
export interface CreateGovernedWorkspaceCandidateInput
	extends CreateWorkspaceCandidateInput {
	readonly governedDispatch: GovernedDispatchLineageV3;
	readonly actionEvidencePort: GovernedActionEvidencePort;
	/** Required native lease/result authority for the candidate Git effect. */
	readonly activityClaimPort: GovernedActivityClaimPort;
}

export interface GovernedWorkspaceCandidateCreationResult {
	readonly candidate: WorkspaceCandidateArtifact;
	readonly actionReceipt: DurableActionReceiptReferenceV2;
	/**
	 * The exact governed Git action lineage that materialized this candidate.
	 * The orchestrator records it as a closed candidate-completion proof before
	 * acceptance, review, or promotion may observe the candidate.
	 */
	readonly candidateCreateActionEvidence: CandidateCreateActionEvidenceV1;
}

export interface PromoteWorkspaceCandidateInput {
	readonly projectRoot: string;
	readonly candidate: WorkspaceCandidateArtifact;
	/** Signed target branch from the strict promotion decision. */
	readonly targetRef: string;
}

export interface WorkspaceCandidatePromotionResult {
	/**
	 * This describes the target-ref CAS, not terminal root-checkout state. A
	 * `promoted`/`already_promoted` adapter result with
	 * `pending_reconciliation` must be terminalized by the kernel as
	 * `reconciliation_required` until the root checkout has explicit evidence of
	 * synchronization.
	 */
	readonly status: "promoted" | "already_promoted" | "reconciliation_required";
	readonly mergedHeadSha: string;
	readonly candidateDigest: string;
	/** Adapter evidence for the exact target-ref compare-and-swap. */
	readonly promotionGitBinding: PromotionGitBindingV1;
}

/**
 * A read-only observation can only report a prior target CAS or a target that
 * later advanced. It can never claim to have performed a new promotion.
 */
export type WorkspaceCandidatePromotionInspectionResult = Omit<
	WorkspaceCandidatePromotionResult,
	"status"
> & {
	readonly status: "already_promoted" | "reconciliation_required";
};

/**
 * Durable candidate projection shared with storage. This deliberately carries
 * raw Git identity in addition to optional governed lineage; it is not itself
 * signed authority to promote.
 */
export interface CandidateArtifactProjectionInput {
	readonly schemaVersion: 1 | 2;
	readonly candidateId: string;
	readonly runId: string;
	readonly attempt: number;
	readonly candidateKey: string;
	readonly candidateRef: string;
	readonly baseSha: string;
	readonly candidateCommitSha: string;
	readonly commitDigest: string;
	readonly treeDigest: string;
	readonly patchDigest: string;
	readonly changedFilesDigest: string;
	readonly candidateDigest: string;
	readonly workflowId?: string;
	readonly unitId?: string;
	readonly provenanceRef?: string;
	readonly envelopeDigest?: string;
	/** Present only for governed candidates, copied from their signed dispatch. */
	readonly acceptanceContractDigest?: string;
	/** @deprecated V1-only pre-effect receipt lineage. */
	readonly actionReceiptDigest?: string;
	/** V3 sealed action-evidence marker; mandatory for schemaVersion 2. */
	readonly actionEvidenceVersion?: ActionEvidenceVersionV1;
	/** Exact V3 receipt-set reference and digest sealed by the kernel. */
	readonly actionReceiptSetRef?: string;
	readonly actionReceiptSetDigest?: string;
	/** Durable signed CandidateCreatedV2 event reference returned by the port. */
	readonly candidateCreatedRef?: string;
}

export interface CandidateArtifactProjection
	extends CandidateArtifactProjectionInput {
	readonly runId: string;
	readonly unitId: string;
	readonly createdAt: string;
}

export interface CandidateOutcomeInput {
	readonly decision: ApprovedPolicyDecision;
	readonly candidate: CandidateArtifactProjectionInput;
}

/**
 * A deterministic acceptance result explicitly bound to an immutable candidate.
 * `acceptanceRef` is expected to identify a signed candidate-acceptance record;
 * the storage projection only preserves it and never treats it as proof.
 */
export interface CandidateAcceptanceRecord {
	readonly candidateDigest: string;
	/** Full Git commit object ID (SHA-1 or SHA-256) the checks evaluated. */
	readonly candidateCommitSha: string;
	/**
	 * Exact signed dispatch contract used for the deterministic checks. It is
	 * mandatory for governed promotion; legacy/raw projections may omit it.
	 */
	readonly acceptanceContractDigest?: string;
	readonly acceptanceRef: string;
	readonly outcome: "passed" | "rejected";
}

/**
 * A closed review verdict and the signed/tape reference that carried it. A
 * promotion may only use an affirmative verdict for the exact candidate.
 */
export interface CandidateReviewRecord {
	readonly candidateDigest: string;
	/** Full Git commit object ID (SHA-1 or SHA-256) the reviewer received. */
	readonly candidateCommitSha: string;
	readonly reviewRef: string;
	readonly verdict: ReviewVerdictV1;
}

/** Immutable candidate acceptance evidence submitted to a signed/tape port. */
export interface CandidateAcceptanceEvidenceInput {
	readonly runId: string;
	readonly candidate: WorkspaceCandidateArtifact;
	readonly outcome: "passed" | "rejected";
	/** Required by the governed V1 tape writer; absent only during raw migration. */
	readonly acceptanceContractDigest?: string;
	readonly diffScopeStatus: "passed" | "blocked";
	readonly outOfScopeFiles: readonly string[];
	readonly checkResults: readonly AcceptanceCheckResult[];
	readonly evaluatedAt: string;
	/** Optional pointer to the legacy acceptance record during the migration. */
	readonly acceptanceEventId?: string;
}

/** Immutable semantic-review evidence submitted to a signed/tape port. */
export interface CandidateReviewEvidenceInput {
	readonly candidate: WorkspaceCandidateArtifact;
	readonly acceptance: CandidateAcceptanceRecord;
	readonly reviewerRunId: string;
	readonly verdict: ReviewVerdictV1;
	readonly reviewedAt: string;
}

/**
 * Candidate-only signed evidence seam. It is deliberately separate from the
 * legacy acceptance event: V1 evidence must bind both digest and commit before
 * a strategy can become promotion-eligible.
 */
export interface CandidateEvidencePort {
	recordCandidateAcceptance(
		input: CandidateAcceptanceEvidenceInput,
	): Promise<CandidateAcceptanceRecord>;
	recordCandidateReview(
		input: CandidateReviewEvidenceInput,
	): Promise<CandidateReviewRecord>;
}

export type CandidatePromotionState = "prepared" | "recorded" | "executed";
/**
 * `promoted` is reserved for a promotion whose target and root checkout have
 * both been reconciled. A post-CAS root-stale or target-advanced result is
 * `reconciliation_required`, so storage can suspend rather than pass the run.
 */
export type CandidatePromotionOutcome =
	| "promoted"
	| "reconciliation_required"
	| "rejected";

/**
 * Opaque, durable single-owner lease for the one promotion effect associated
 * with a candidate/idempotency identity. The storage projection may cache the
 * lease, but a caller must thread the exact token into the terminal marker so
 * a concurrent recoverer cannot finalize another owner's Git attempt.
 */
export interface CandidatePromotionExecutionLeaseV1 {
	readonly schemaVersion: 1;
	readonly state: "active";
	readonly candidateDigest: string;
	readonly idempotencyKey: string;
	readonly leaseToken: string;
	readonly claimedAt: string;
	readonly leaseExpiresAt: string;
	readonly claimEpoch: number;
}

/** Read-only recovery view for a candidate-promotion execution lease. */
export interface CandidatePromotionExecutionClaimStateV1 {
	readonly schemaVersion: 1;
	readonly state: "pending" | "active" | "expired" | "completed";
	readonly candidateDigest: string;
	readonly idempotencyKey: string;
	readonly claimEpoch: number;
	readonly claimedAt?: string;
	readonly leaseExpiresAt?: string;
	readonly executedAt?: string;
	readonly executedOutcome?: CandidatePromotionOutcome;
}

/**
 * Candidate-digest-keyed write-ahead intent. This is deliberately separate
 * from the legacy run-id keyed operator-decision protocol: its effect is a
 * promotion of the already frozen candidate, never a merge of a live worktree.
 */
export interface CandidatePromotionIntentInput {
	readonly runId: string;
	readonly candidate: CandidateArtifactProjection;
	readonly decision: PromotionDecisionV1;
	readonly acceptance: CandidateAcceptanceRecord;
	readonly review: CandidateReviewRecord;
	readonly preparedAt: string;
}

export interface CandidatePromotionIntent
	extends CandidatePromotionIntentInput {
	readonly state: CandidatePromotionState;
	readonly executedOutcome?: CandidatePromotionOutcome;
	readonly mergedHeadSha?: string;
	readonly promotionGitBinding?: PromotionGitBindingV1;
}

/**
 * Signed-tape decision input. Implementations must deduplicate by the decision
 * idempotency key, including a replay after a crash between tape flush and the
 * local `recorded` marker.
 */
export interface RecordCandidatePromotionDecisionInput {
	readonly intent: CandidatePromotionIntentInput;
}

/**
 * Signed-tape result emitted after the Git CAS reports a terminal outcome.
 * `promotionDecisionRef` is the exact signed write-ahead decision reference
 * returned by `recordPromotionDecision`; a result must never reconstruct or
 * guess that link from mutable local state.
 */
export interface RecordCandidatePromotionResultInput {
	readonly runId: string;
	readonly candidateDigest: string;
	readonly idempotencyKey: string;
	readonly promotionDecisionRef: string;
	readonly outcome: CandidatePromotionOutcome;
	readonly mergedHeadSha?: string;
	/** Required for every strict post-CAS result; absent for rejection. */
	readonly promotionGitBinding?: PromotionGitBindingV1;
}

export interface CandidatePromotionDecisionPort {
	/**
	 * Durably append or reconcile the write-ahead decision and return its exact,
	 * non-empty signed tape reference. The orchestrator passes that value through
	 * unchanged to the terminal promotion result.
	 */
	recordPromotionDecision(
		input: RecordCandidatePromotionDecisionInput,
	): Promise<string>;
	/** Must likewise deduplicate a crash after result flush but before local execution marking. */
	recordPromotionResult(
		input: RecordCandidatePromotionResultInput,
	): Promise<void>;
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

export type OperatorDecisionSubject = "resume" | "merge";
export type OperatorDecisionVerdict = "approved" | "rejected";

/**
 * The Tier-1 mirror of one operator decision. Written to the state.db `events`
 * table under kind `operator_decision_recorded` with a camelCase `runId` so
 * `listPendingOperatorDecisions` excludes the decided run AND the reconciler
 * (which cannot read the Tier-2 `events.db`) can detect a decided-but-unexecuted
 * side effect. Distinct from the signed Tier-2 wire payload (snake_case
 * `run_id`).
 */
export interface OperatorDecisionShadow {
	readonly runId: string;
	readonly decision: OperatorDecisionVerdict;
	readonly subject: OperatorDecisionSubject;
	readonly decidedBy: string;
	readonly decidedAt: string;
}

/**
 * A decided run whose side effect did not complete (no `operator_decision_executed`
 * Tier-1 marker). The reconciler re-drives the side effect exactly once.
 */
export interface DecidedUnexecutedDecision {
	readonly runId: string;
	readonly decision: OperatorDecisionVerdict;
	readonly subject: OperatorDecisionSubject;
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
	/**
	 * Candidate-specific terminal transition: records the immutable candidate,
	 * approved policy decision, passed run, and retained workspace atomically.
	 * Optional until all storage adapters have migrated.
	 */
	commitRunCandidateOutcome?(runId: string, input: CandidateOutcomeInput): Run;
	getCandidateArtifact?(runId: string): CandidateArtifactProjection | null;
	/**
	 * Candidate promotion's local write-ahead anchor. Implementations must key
	 * duplicate detection on candidate digest plus decision idempotency key and
	 * reject conflicting reuse before any signed or Git side effect.
	 */
	prepareCandidatePromotion?(
		input: CandidatePromotionIntentInput,
	): CandidatePromotionIntent;
	markCandidatePromotionRecorded?(
		candidateDigest: string,
		idempotencyKey: string,
	): void;
	/**
	 * Revalidate the durable recorded promotion claim immediately before the
	 * Git CAS. Implementations must refuse terminal/non-governed runs; the
	 * recorded marker remains the recovery identity after a crash.
	 */
	claimCandidatePromotionExecution?(
		candidateDigest: string,
		idempotencyKey: string,
	): CandidatePromotionExecutionLeaseV1;
	getCandidatePromotionExecutionClaimState?(
		candidateDigest: string,
		idempotencyKey: string,
	): CandidatePromotionExecutionClaimStateV1;
	markCandidatePromotionExecuted?(
		candidateDigest: string,
		idempotencyKey: string,
		outcome: {
			outcome: CandidatePromotionOutcome;
			mergedHeadSha?: string;
			promotionGitBinding?: PromotionGitBindingV1;
		},
		executionLeaseToken?: string,
	): void;
	listPendingCandidatePromotions?(): readonly CandidatePromotionIntent[];
	recordWorkspaceDeleted(runId: string): void;
	recordWorkspaceCleanupFailed(runId: string, message: string): void;
	suspendRun(runId: string): Run;
	approveRun(runId: string): Run;
	rejectSuspendedRun(runId: string): Run;
	/**
	 * Quarantine a passed-acceptance run whose merge the operator REJECTED (M5-S4
	 * D3): mark it failed and leave the worktree retained. Distinct from
	 * `rejectSuspendedRun` (which requires a suspended run); a merge-subject run is
	 * `passed`, not `suspended`.
	 */
	rejectMergeDecision(runId: string): Run;
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
	 * S7 / M6-F1 crash-recovery reconcile: flip every `running` run whose `unit_id`
	 * begins with `${planId}:` — the exact set `findOrphanedPlanForgeDispatches`
	 * keys on — to a terminal `status` consistent with the recovered plan_receipt
	 * outcome. Closes the M2 contract line "receipt on tape but running in storage
	 * → reconcile": without it the storage status field lies forever and every
	 * `recover` pass re-scans the same orphan. Returns the reconciled run ids;
	 * idempotent — a second pass finds none still `running`.
	 */
	reconcilePlanForgeDispatchRuns(
		planId: string,
		status: "passed" | "failed",
	): readonly string[];
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
	/**
	 * Tier-1 mirror of a signed `operator_decision_recorded` event. The
	 * TS-readable exactly-once anchor (M5-S4 D2): excludes the run from
	 * `listPendingOperatorDecisions` and lets the reconciler — which cannot read
	 * the Tier-2 `events.db` — detect a decided run. Recorded AFTER the Tier-2
	 * flush, BEFORE the side effect.
	 */
	recordOperatorDecisionShadow(shadow: OperatorDecisionShadow): void;
	/**
	 * Tier-1 side-effect-completion marker for an operator decision (M5-S4 D2/D4).
	 * Recorded after the side effect succeeds; carries the merge HEAD when an
	 * approved merge produced one. Its presence is the exactly-once gate the
	 * reconciler checks before re-driving — and the no-double-merge guard.
	 */
	markOperatorDecisionExecuted(
		runId: string,
		outcome?: { mergedHeadSha?: string },
	): void;
	/**
	 * Whether an `operator_decision_executed` Tier-1 marker already exists for the
	 * run (M5-S4 F1/F5). The orchestrator check-and-claims this immediately before
	 * each side effect so a post-marker re-drive (reconciler or operator re-decide)
	 * never re-applies it.
	 */
	isOperatorDecisionExecuted(runId: string): boolean;
	/**
	 * The run's recorded acceptance shadow outcome (`passed` / `rejected`), or
	 * `null` if none. Read during merge-eligibility validation (M5-S4 F2): a merge
	 * decision is only signable when acceptance `passed`.
	 */
	getRunAcceptanceOutcome(runId: string): "passed" | "rejected" | null;
	/**
	 * The reconciler feed: every run with an `operator_decision_recorded` Tier-1
	 * mirror but no `operator_decision_executed` marker — a decided-but-unexecuted
	 * side effect. At most one row per run. Oldest first.
	 */
	listDecidedUnexecutedDecisions(): readonly DecidedUnexecutedDecision[];
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
 *
 * Resolves to the signed `acceptance_recorded` event id (M6-S7) so the kernel can
 * chain a `result_ready` to it at terminal `passed`; `undefined` when no port
 * recorded one (existing await-only callers ignore the value).
 */
export interface BuildplaneAcceptancePort {
	recordAcceptance(input: AcceptanceRecordInput): Promise<string | undefined>;
}

/**
 * Kernel-facing seam for appending the signed `result_ready` event (M6-S7). A
 * SEPARATE port from {@link BuildplaneAcceptancePort} (pre-build resolution 7) —
 * the orchestrator emits it write-ahead of the operator merge/quarantine decision
 * once the run reaches its terminal `passed` outcome (A1: after `policy.evaluateRun`
 * decides the terminal advance, NOT when a per-attempt acceptance resolves
 * `passed`). `recordResultReady` MUST resolve only once the event is durably on the
 * tape. The three ids chain the run to the `plan_admitted` and `acceptance_recorded`
 * events that authorized and accepted it.
 */
export interface ResultReadyPort {
	recordResultReady(
		runId: string,
		admissionEventId: string,
		acceptanceEventId: string,
	): Promise<void>;
}

export type RunCompletionOutcome = "passed" | "failed" | "cancelled";

/**
 * The signed `run_completed` summary (M6-S7). All three counts are strings on the
 * wire (the U64 → TS-number hazard) and are supplied synchronously by the
 * orchestrator from the already-loaded inspect snapshot (pre-build resolution 8).
 */
export interface RecordRunCompletedInput {
	readonly runId: string;
	readonly outcome: RunCompletionOutcome;
	/** Wall-clock run duration in ms (`Date.now() - run.createdAt`), as a string. */
	readonly durationMs: string;
	/** Signed-tape event count for the run, as a string. */
	readonly eventCount: string;
	/** Units/runs in the run's history, as a string. */
	readonly unitCount: string;
}

/**
 * Kernel-facing seam for appending the signed `run_completed` event (M6-S7),
 * emitted write-ahead after the operator decision's terminal side effect
 * (merge+approved → `passed`; merge/resume rejection → `failed`). `recordRunCompleted`
 * MUST resolve only once the event is durably on the tape.
 */
export interface RunCompletionPort {
	recordRunCompleted(input: RecordRunCompletedInput): Promise<void>;
}

/**
 * One operator decision to record on the tape (M5-S4). `subject=resume` resumes
 * or rejects a suspended run; `subject=merge` merges or quarantines a retained
 * worktree whose acceptance passed. The write-ahead path emits with
 * `mergeCommit` absent (the merge has not happened at emit time, D1); a present
 * `mergeCommit` is reserved for post-hoc decision recording and must be a full
 * 40-hex sha.
 */
export interface RecordOperatorDecisionInput {
	readonly runId: string;
	readonly decision: OperatorDecisionVerdict;
	readonly subject: OperatorDecisionSubject;
	readonly decidedBy: string;
	/** RFC3339 / ISO-8601 decision timestamp. */
	readonly decidedAt: string;
	readonly acceptanceEventId?: string;
	readonly admissionEventId?: string;
	/** Full 40-hex sha when post-hoc recording a completed merge; omitted in the live write-ahead path. */
	readonly mergeCommit?: string;
}

/**
 * Kernel-facing seam for appending the signed `operator_decision_recorded`
 * event. The concrete impl (CLI layer) wraps a signed ledger TapeEmitter.
 * `recordDecision` MUST resolve only once the event is durably on the tape
 * (write-ahead — mirrors `BuildplaneAcceptancePort.recordAcceptance`), so the
 * orchestrator can `await` it before the side effect (merge / resume).
 */
export interface OperatorDecisionPort {
	recordDecision(input: RecordOperatorDecisionInput): Promise<void>;
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

/** A durable, port-issued request reference; the request digest is never supplied by a worker. */
export interface DurableActionRequestV2 {
	readonly actionRequest: ActionRequestedV2;
	readonly actionRequestRef: string;
	readonly actionRequestDigest: string;
}

/** A durable, port-issued receipt reference; only this form may join a V3 seal. */
export interface DurableActionReceiptV2 {
	readonly receipt: ActionReceiptRecordedV2;
	readonly actionReceiptDigest: string;
}

/** The worker-visible member reference is intentionally narrower than a candidate lineage. */
export interface DurableActionReceiptReferenceV2 {
	readonly actionId: string;
	readonly actionReceiptRef: string;
	readonly actionReceiptDigest: string;
}

/**
 * Closed evidence for the one governed Git action that created a candidate.
 * Every field is produced by the durable action/activity ports; worker output
 * cannot supply or relabel this lineage.
 */
export interface CandidateCreateActionEvidenceV1 {
	readonly actionId: string;
	readonly actionRequestRef: string;
	readonly actionRequestDigest: string;
	readonly activityClaimEventRef: string;
	readonly activityClaimEventDigest: string;
	readonly activityResultEventRef: string;
	readonly activityResultEventDigest: string;
	readonly actionReceiptRef: string;
	readonly actionReceiptDigest: string;
}

/** Durable reference returned after the candidate-completion proof is appended. */
export interface DurableCandidateCompletionV1 {
	readonly candidateCompletionRef: string;
	readonly completionDigest: string;
}

/**
 * Request fields used by the action gateway after a durable write-ahead
 * request. The port supplies the receipt reference itself so a worker cannot
 * choose a candidate-bound receipt identity.
 */
export type RecordActionReceiptV2Input = Omit<
	ActionReceiptRecordedV2,
	"actionReceiptRef"
>;

/** Kernel-only input to seal all completed durable action records for an attempt. */
export interface SealActionReceiptSetV1Input {
	readonly runId: string;
	readonly workflowId: string;
	readonly unitId: string;
	readonly attempt: number;
	readonly provenanceRef: string;
	readonly dispatchEnvelopeDigest: string;
	readonly receipts: readonly DurableActionReceiptReferenceV2[];
	readonly sealedAt: string;
}

/**
 * Signed-tape action-evidence boundary. Implementations must make request and
 * receipt writes durable before returning. `sealActionReceiptSet` must verify
 * every referenced receipt against the same V3 dispatch and reject pending or
 * unknown effects; it alone creates the set ref/digest. `recordCandidateCreatedV2`
 * must append before storage makes the candidate promotion-visible.
 */
export interface GovernedActionEvidencePort {
	recordActionRequested(
		input: ActionRequestedV2,
	): Promise<DurableActionRequestV2>;
	recordActionReceipt(
		input: RecordActionReceiptV2Input,
	): Promise<DurableActionReceiptV2>;
	sealActionReceiptSet(
		input: SealActionReceiptSetV1Input,
	): Promise<ActionReceiptSetRecordedV1>;
	recordCandidateCreatedV2(input: CandidateCreatedV2): Promise<string>;
	/**
	 * Optional at the static boundary while older ports are migrated. The kernel
	 * explicitly requires it for every new sealed-v3 candidate flow and rejects
	 * the flow before candidate acceptance if it is unavailable.
	 */
	recordCandidateCompletion?(
		input: CandidateCompletionRecordedV1,
	): Promise<DurableCandidateCompletionV1>;
}

/** Terminal state for one native, reducer-owned activity lease. */
export type GovernedActivityResultOutcomeV1 =
	| "succeeded"
	| "failed"
	| "unknown";

/** A native grant is the only authority that permits a V3 effect to begin. */
export interface GrantedGovernedActivityClaimV1 {
	readonly state: "granted";
	readonly activityId: string;
	readonly idempotencyKey: string;
	readonly claimEventId: string;
	readonly claimEventDigest: string;
	readonly leaseId: string;
	readonly leaseExpiresAt: string;
}

export type GovernedActivityClaimDispositionV1 =
	| GrantedGovernedActivityClaimV1
	| {
			readonly state: "pending";
			readonly claimEventId: string;
			readonly leaseExpiresAt: string;
	  }
	| {
			readonly state: "recorded";
			readonly claimEventId: string;
			readonly resultEventId: string;
			readonly resultEventDigest: string;
			readonly resultOutcome: GovernedActivityResultOutcomeV1;
	  }
	| {
			readonly state: "lease_expired";
			readonly claimEventId: string;
			readonly leaseExpiresAt: string;
	  }
	| {
			readonly state: "rejected";
			readonly code: string;
			readonly message: string;
	  };

export type GovernedActivityResultDispositionV1 =
	| {
			readonly state: "recorded";
			readonly resultEventId: string;
			readonly resultEventDigest: string;
			readonly resultOutcome: GovernedActivityResultOutcomeV1;
	  }
	| {
			readonly state: "lease_expired";
			readonly claimEventId: string;
			readonly leaseExpiresAt: string;
	  }
	| {
			readonly state: "rejected";
			readonly code: string;
			readonly message: string;
	  };

/**
 * Native tape-backed activity boundary for every sealed_v3 irreversible
 * action. A caller must write action intent, obtain a grant, record exactly
 * one terminal result, and only then write the matching action receipt.
 */
export interface GovernedActivityClaimPort {
	claim(input: {
		readonly dispatch: GovernedDispatchLineageV3;
		readonly durableRequest: DurableActionRequestV2;
		readonly activityId: string;
		readonly idempotencyKey: string;
		readonly leaseDurationMs: number;
	}): Promise<GovernedActivityClaimDispositionV1>;
	recordResult(input: {
		readonly dispatch: GovernedDispatchLineageV3;
		readonly durableRequest: DurableActionRequestV2;
		readonly claim: GrantedGovernedActivityClaimV1;
		readonly outcome: GovernedActivityResultOutcomeV1;
		readonly resultDigest: string | null;
		readonly resultRef: string | null;
		readonly evidenceDigest: string;
		readonly evidenceRef: string;
	}): Promise<GovernedActivityResultDispositionV1>;
}

/**
 * Kernel-owned guard against cross-clone/cross-repository dispatch replay.
 * The implementation must independently derive the local repository binding
 * from `projectRoot` and reject a mismatch before workspace preparation or a
 * worker/ Git effect. It is deliberately a port because the CLI/native
 * integration owns Git discovery; absence is a governed V3 hard failure.
 */
export interface GovernedRepositoryBindingPort {
	assertDispatchRepositoryBinding(input: {
		readonly projectRoot: string;
		readonly dispatch: GovernedDispatchLineageV3;
	}): void;
}

/**
 * Host-owned authority realm verifier for sealed V3 dispatch. Unlike a tape
 * workspace, this realm is outside the repository and owns the monotonic
 * activity-claim register used to prevent fork/rollback re-grants.
 */
export interface GovernedLedgerAuthorityRealmPort {
	assertDispatchLedgerAuthorityRealm(input: {
		readonly dispatch: GovernedDispatchLineageV3;
	}): void;
}

/**
 * Result shape allowed from a V3 governed worker. It carries the ordinary
 * runtime receipt plus only durable action record references; no worker input
 * can invent a receipt-set digest or candidate evidence binding.
 */
export interface GovernedWorkerExecutionResultV3 {
	readonly executionReceipt: ExecutionReceipt;
	readonly actionReceipts: readonly DurableActionReceiptReferenceV2[];
	/**
	 * Present only for reviewer/adversary/judge workers. This is a parsed,
	 * candidate-bound semantic result, not candidate-creation or promotion proof.
	 */
	readonly reviewVerdict?: ReviewVerdictV1;
}

/**
 * The only worker execution seam allowed for a governed immutable candidate.
 *
 * Unlike the legacy runtime port, an implementation of this contract must run
 * the worker behind the per-run ActionGateway and a verified OCI sandbox. The
 * kernel never substitutes `BuildplaneRuntimePort` when this port is absent:
 * missing isolation is a blocked governed run, not a host-execution fallback.
 */
export interface GovernedWorkerExecutionPort {
	executeCandidatePacketAsync(input: {
		/**
		 * Kernel-owned execution identity. The action plane must receive this
		 * rather than reconstructing identity from a worker-controlled packet so
		 * every action receipt and idempotency boundary joins the durable run.
		 */
		readonly runId: string;
		readonly packet: UnitPacket;
		readonly projectRoot: string;
		readonly eventBus: EventBus;
		readonly signal: AbortSignal;
		/** V1 migration-only lineages are never read by the V3 path. */
		readonly candidateGovernance?: CandidateGovernanceLineage;
		/** Verified V3 admission facts for the ActionGateway. */
		readonly governedDispatch?: GovernedDispatchLineageV3;
		/** Present exactly for V3, so the gateway can write ahead each effect. */
		readonly actionEvidencePort?: GovernedActionEvidencePort;
		/**
		 * Present exactly for reviewer/adversary/judge V3 actions and constructed
		 * by the kernel from an immutable candidate plus a read-only mount.
		 */
		readonly reviewCandidate?: GovernedReviewCandidateContextV1;
	}): Promise<ExecutionReceipt | GovernedWorkerExecutionResultV3>;
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
	/**
	 * Present only on a host-constructed Linux/WSL workspace adapter whose Git
	 * executable and environment are pinned for governed effects. A V3 dispatch
	 * must reject an ordinary/raw adapter before it probes or creates a worktree.
	 */
	readonly governedWorkspaceBoundary?: "pinned-governed-git-v1";
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
	/** Freeze output in an immutable candidate ref without touching target HEAD. */
	createWorkspaceCandidate?(
		input: CreateWorkspaceCandidateInput,
	): WorkspaceCandidateArtifact;
	/**
	 * V3 trusted variant of candidate creation. Absence is a hard block: the
	 * legacy candidate creator cannot create an unrecorded Git effect in a
	 * sealed action-evidence workflow.
	 */
	createGovernedWorkspaceCandidate?(
		input: CreateGovernedWorkspaceCandidateInput,
	): Promise<GovernedWorkspaceCandidateCreationResult>;
	/**
	 * Raw compatibility-only compare-and-swap promotion. The normal kernel
	 * promotion path rejects V1 and sealed-v2 candidate lineage before it can
	 * call this method; governed V3 promotion requires a native executor.
	 */
	promoteWorkspaceCandidate?(
		input: PromoteWorkspaceCandidateInput,
	): WorkspaceCandidatePromotionResult;
	/**
	 * Reads and validates the immutable candidate-keyed promotion receipt without
	 * creating a merge, advancing a ref, or reconciling the root checkout.
	 * `null` means no receipt exists; callers must not treat that as authority to
	 * retry the target-branch mutation during recovery.
	 */
	inspectWorkspaceCandidatePromotion?(
		input: PromoteWorkspaceCandidateInput,
	): WorkspaceCandidatePromotionInspectionResult | null;
	/**
	 * The only target-ref mutation permitted for a sealed V3 candidate. It must
	 * be backed by the same pinned action-plane Git boundary used to create the
	 * candidate; the generic compatibility promotion method is never enough.
	 */
	promoteGovernedWorkspaceCandidate?(
		input: PromoteWorkspaceCandidateInput,
	): WorkspaceCandidatePromotionResult;
	/**
	 * Pinned-boundary read-only receipt inspection for sealed V3 candidates.
	 * Recovery must never substitute the ambient inspection method for this
	 * governed boundary.
	 */
	inspectGovernedWorkspaceCandidatePromotion?(
		input: PromoteWorkspaceCandidateInput,
	): WorkspaceCandidatePromotionInspectionResult | null;
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
