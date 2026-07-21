import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	type CreateRunAdmissionReceiptDryRunInput,
	createRunAdmissionReceiptLive,
	type JsonRecord,
	type RunAdmissionEvidenceInput,
	type RunAdmissionLocalEvidenceStore,
	type RunAdmissionReceiptAttemptRecord,
	recordRunAdmissionReceiptAttempt,
	recordRunAdmissionReceiptAttemptSync,
} from "./admission-receipts.js";
import {
	type AdmittedPlanReader,
	type AdmittedPlanRecord,
	createDefaultAdmittedPlanReader,
} from "./admitted-plan-reader.js";
import type { EventBus, EventContext } from "./events.js";
import {
	createGovernedV3RetryRequestV1,
	type GovernedV3RetryContextResolverPort,
	inspectUntrustedGovernedV3RetryContextResolution,
} from "./governed-retry-authority.js";
import {
	createGraphScheduler,
	type GraphResult,
	type UnitGraph,
} from "./graph.js";
import { extractLearnings } from "./outcome-extractor.js";
import {
	carriesGovernanceFields,
	parseGovernedUnitPacket,
	parseUnitPacket,
} from "./packet.js";
import type {
	AcceptanceCheckResult,
	AcceptanceContractV0,
	BudgetConstraints,
	PolicyProfile,
} from "./policy.js";
import type {
	AcceptanceRecordInput,
	BuildplaneAcceptanceEvidencePort,
	BuildplaneAcceptancePort,
	BuildplaneMemoryPort,
	BuildplanePolicyPort,
	BuildplaneProfileRegistryPort,
	BuildplaneRuntimePort,
	BuildplaneStoragePort,
	BuildplaneWorkspacePort,
	CandidateAcceptanceEvidenceInput,
	CandidateAcceptanceRecord,
	CandidateArtifactProjection,
	CandidateArtifactProjectionInput,
	CandidateCreateActionEvidenceV1,
	CandidateEvidencePort,
	CandidateGovernanceLineage,
	CandidatePromotionDecisionPort,
	CandidatePromotionExecutionLeaseV1,
	CandidatePromotionIntent,
	CandidatePromotionIntentInput,
	CandidatePromotionOutcome,
	CandidateReviewEvidenceInput,
	CandidateReviewRecord,
	DurableActionReceiptReferenceV2,
	GovernedActionEvidencePort,
	GovernedActivityClaimPort,
	GovernedDispatchLineageV3,
	GovernedLedgerAuthorityRealmPort,
	GovernedRepositoryBindingPort,
	GovernedWorkerExecutionPort,
	LedgerActivityPort,
	OperatorDecisionPort,
	OperatorDecisionSubject,
	OperatorDecisionVerdict,
	RecordOperatorDecisionInput,
	RecordRunCompletedInput,
	ResultReadyPort,
	RunCompletionOutcome,
	RunCompletionPort,
	RunPacketOptions,
} from "./ports.js";
import {
	defaultOutcomeRoutingConfig,
	fillRoutingHints,
	type OutcomeRoutingConfig,
} from "./routing-producer.js";
import type {
	ExecutionReceipt,
	InspectSnapshot,
	PolicyDecision,
	RunInfrastructureFailure,
	RunPacketResult,
	StatusSnapshot,
	UnitPacket,
	WorkspaceCandidateArtifact,
	WorkspaceSnapshot,
} from "./run-loop.js";
import { createRunScopedBus } from "./run-scoped-bus.js";
import {
	runStrategy,
	type StrategyExecutionOptions,
} from "./strategy-executor.js";
import {
	type ActionReceiptSetRecordedV1,
	type CandidateCompletionRecordedV1,
	canonicalCandidateCompletionRecordedV1Digest,
	canonicalGovernedUnitPacketV1Digest,
	canonicalSha256Digest,
	isCanonicalBuildplaneCandidateRef,
	type PromotionDecisionV1,
	type PromotionGitBindingV1,
	type PromotionWorktreeSyncStateV1,
	parseActionReceiptSetRecordedV1,
	parseCandidateCompletionRecordedV1,
	parseCandidateCreatedV2,
	parsePromotionDecisionV1,
	parseReviewVerdictV1,
	parseSignablePromotionDecisionV1,
	type ReviewVerdictV1,
} from "./trust-spine.js";
import type { Run, StrategyPacket, StrategyResult } from "./types.js";
import { validatePacketForWorkspaceRoot } from "./workspace-paths.js";

/** A no-op event bus for the sync path when no bus is provided. */
const noopBus: EventBus = {
	subscribe: () => () => {},
	emit: () => {},
};

const DEFAULT_ADMISSION_STEM = "run_admission";
const MAX_ADMISSION_STEM_LENGTH = 120;

/**
 * Minimal deterministic descriptor of a packet's activity input, digested into
 * `ActivityStartedV1.input_digest`. Command packets describe the command line;
 * model packets describe the model block (or intent, when present).
 */
function activityInputDescriptor(p: UnitPacket): unknown {
	if (p.model) {
		return p.intent ? { intent: p.intent } : { model: p.model };
	}
	return {
		command: p.execution?.command ?? "",
		args: p.execution?.args ?? [],
	};
}

/**
 * Deterministic descriptor of an execution receipt, digested into
 * `ActivityCompletedV1.result_digest` and stored inline as the recorded result.
 */
function activityResultDescriptor(r: ExecutionReceipt): unknown {
	return {
		exitCode: r.exitCode,
		stdout: r.stdout,
		stderr: r.stderr,
	};
}

/**
 * The signed dispatch and the executed acceptance contract must use the same
 * content address. This intentionally mirrors PlanForge's canonical JSON rule
 * without making the kernel depend on the plan compiler.
 */
function canonicalizeAcceptanceContractValue(value: unknown): unknown {
	if (value === null || typeof value !== "object") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(canonicalizeAcceptanceContractValue);
	}
	const source = value as Record<string, unknown>;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(source).sort()) {
		const child = source[key];
		if (child !== undefined) {
			sorted[key] = canonicalizeAcceptanceContractValue(child);
		}
	}
	return sorted;
}

function digestAcceptanceContract(contract: AcceptanceContractV0): string {
	const canonicalJson =
		JSON.stringify(canonicalizeAcceptanceContractValue(contract)) ?? "null";
	return `sha256:${createHash("sha256")
		.update(canonicalJson, "utf8")
		.digest("hex")}`;
}

// Must equal @buildplane/planforge's PLANFORGE_AUTHORIZED_NEXT_STEP.
const PLAN_ADMITTED_AUTHORIZED_NEXT_STEP = "dispatch_admitted_plan";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// V3 sealed receipt sets are ordered by actionId in Rust. Keep the cross-
// language comparison byte-stable by accepting only printable ASCII action IDs
// at the kernel boundary instead of relying on locale-sensitive collation.
const PRINTABLE_ASCII_ACTION_ID_PATTERN = /^[\x21-\x7e]+$/;

// Strict RFC3339 timestamp (M5-S4 F7): `Date.parse` accepts non-RFC3339 forms
// like "06/23/2026", so a decision's `decidedAt` is matched against this regex
// AND round-tripped through Date before it can be signed. Named groups capture the
// wall-clock fields for the calendar round-trip (P1.7): the regex matches the
// SHAPE but not the calendar, and `Date.parse` silently normalizes rolled-over
// fields (Feb 31 → Mar 3), so an impossible calendar date could otherwise sign.
const RFC3339_PATTERN =
	/^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})[Tt](?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const RFC3339_UTC_MILLIS_PATTERN =
	/^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.\d{1,3})?Z$/;

/**
 * Thrown by `recordOperatorDecision` validation (M5-S4 D5) BEFORE any tape emit,
 * so a malformed decision can never be signed. A typed error class lets callers
 * distinguish a rejected-input from an infrastructure failure.
 */
export class OperatorDecisionValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OperatorDecisionValidationError";
	}
}

/**
 * Thrown before a candidate-promotion tape write or Git effect when the
 * immutable candidate, its evidence, or its decision do not form one exact
 * binding. This protocol is intentionally separate from legacy run/worktree
 * operator decisions.
 */
export class CandidatePromotionValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CandidatePromotionValidationError";
	}
}

/**
 * V3 dispatches are serialized into the signed native ledger, whose canonical
 * rules require an RFC3339 UTC timestamp. `Date.parse` alone accepts offset,
 * lower-case, and calendar-impossible forms, so validate the exact wire shape
 * and its calendar fields before comparing expiry.
 */
function requireRfc3339UtcEpoch(value: unknown, field: string): number {
	if (typeof value !== "string") {
		throw new CandidatePromotionValidationError(
			`${field} must be an RFC3339 UTC timestamp.`,
		);
	}
	const match = RFC3339_UTC_MILLIS_PATTERN.exec(value);
	const epochMs = Date.parse(value);
	if (match === null || !Number.isFinite(epochMs)) {
		throw new CandidatePromotionValidationError(
			`${field} must be an RFC3339 UTC timestamp.`,
		);
	}
	const fields = match.groups as {
		year: string;
		month: string;
		day: string;
		hour: string;
		minute: string;
		second: string;
	};
	const year = Number(fields.year);
	const month = Number(fields.month);
	const day = Number(fields.day);
	const hour = Number(fields.hour);
	const minute = Number(fields.minute);
	const second = Number(fields.second);
	const calendar = new Date(
		Date.UTC(year, month - 1, day, hour, minute, second),
	);
	if (
		calendar.getUTCFullYear() !== year ||
		calendar.getUTCMonth() !== month - 1 ||
		calendar.getUTCDate() !== day ||
		calendar.getUTCHours() !== hour ||
		calendar.getUTCMinutes() !== minute ||
		calendar.getUTCSeconds() !== second
	) {
		throw new CandidatePromotionValidationError(
			`${field} must be a real RFC3339 UTC calendar timestamp.`,
		);
	}
	return epochMs;
}

/** Caller-supplied candidate evidence for an operator/preauthorized decision. */
export interface RecordCandidatePromotionInput {
	readonly runId: string;
	readonly decision: PromotionDecisionV1;
	readonly acceptance: CandidateAcceptanceRecord;
	readonly review: CandidateReviewRecord;
}

export interface CandidatePromotionResult {
	readonly candidateDigest: string;
	readonly outcome: CandidatePromotionOutcome;
	readonly mergedHeadSha?: string;
	readonly promotionGitBinding?: PromotionGitBindingV1;
	/** True when recovery or a duplicate request observed a completed promotion. */
	readonly replayed: boolean;
}

export interface PendingCandidatePromotionRecoveryFailure {
	readonly candidateDigest: string;
	readonly error: string;
}

export interface PendingCandidatePromotionRecovery {
	readonly recovered: number;
	readonly failed: readonly PendingCandidatePromotionRecoveryFailure[];
}

/** One decided-but-unexecuted record the startup reconciler failed to re-drive. */
export interface PendingDecisionRecoveryFailure {
	readonly runId: string;
	readonly error: string;
}

/**
 * Summary of a `recoverPendingDecisions` pass: how many decided-but-unexecuted
 * side effects were re-driven, and any records whose re-drive threw (per-item
 * isolation — one bad record never wedges the batch).
 */
export interface PendingDecisionRecovery {
	readonly recovered: number;
	readonly failed: readonly PendingDecisionRecoveryFailure[];
}

export interface BuildplaneOrchestrator {
	initializeProject(): ReturnType<BuildplaneStoragePort["initializeProject"]>;
	runPacket(
		packet: UnitPacket,
		eventBus?: EventBus,
		runOptions?: RunPacketOptions,
	): RunPacketResult;
	runPacketAsync(
		packet: UnitPacket,
		eventBus?: EventBus,
		runOptions?: RunPacketOptions,
	): Promise<RunPacketResult>;
	/** Present only when the configured workspace and storage ports can retain an immutable candidate. */
	runCandidatePacketAsync?(
		packet: UnitPacket,
		candidateIdentity: {
			readonly candidateId: string;
			readonly attempt: number;
		},
		eventBus?: EventBus,
		governedDispatch?: GovernedDispatchLineageV3,
	): Promise<RunPacketResult>;
	getStatus(): StatusSnapshot;
	inspect(id: string): InspectSnapshot;
	approveRun(runId: string): Run;
	rejectSuspendedRun(runId: string): Run;
	/**
	 * Record one operator decision on the tape and apply its side effect (M5-S4).
	 * Validate → emit + flush the signed `operator_decision_recorded` (write-ahead)
	 * → Tier-1 mirror → side effect (resume / reject / merge / quarantine) → mark
	 * the decision executed. Resolves once the side effect is complete.
	 */
	recordOperatorDecision(input: RecordOperatorDecisionInput): Promise<void>;
	/**
	 * Write-ahead, candidate-digest-keyed promotion. The candidate is frozen
	 * before this API runs; this method never calls legacy worktree merge.
	 */
	recordCandidatePromotion(
		input: RecordCandidatePromotionInput,
	): Promise<CandidatePromotionResult>;
	/**
	 * Persist a closed review verdict for an immutable candidate. This is the
	 * only kernel path a strategy may use before returning awaiting-promotion.
	 */
	recordCandidateReview(
		input: CandidateReviewEvidenceInput,
	): Promise<CandidateReviewRecord>;
	/**
	 * Startup reconciler (M5-S4 D2): re-drive any decided-but-unexecuted side
	 * effect EXACTLY ONCE, gated on a missing execution marker. Never re-emits the
	 * Tier-2 signed event and never double-merges. Per-item isolation (R2): a
	 * record whose re-drive throws is captured under `failed`, and the batch
	 * continues. Resolves with a summary of what was recovered.
	 */
	recoverPendingDecisions(): Promise<PendingDecisionRecovery>;
	/** Reconcile candidate promotions interrupted after their write-ahead intent. */
	recoverPendingCandidatePromotions(): Promise<PendingCandidatePromotionRecovery>;
	runGraphAsync(
		graph: UnitGraph,
		eventBus?: EventBus,
		options?: { readonly lane?: "raw-legacy" },
	): Promise<GraphResult>;
	runStrategy(
		strategy: StrategyPacket,
		eventBus?: EventBus,
		options?: StrategyExecutionOptions,
	): Promise<StrategyResult>;
}

export interface CreateBuildplaneOrchestratorOptions {
	readonly projectRoot: string;
	readonly storage: BuildplaneStoragePort;
	readonly runtime: BuildplaneRuntimePort;
	readonly policy: BuildplanePolicyPort;
	readonly workspace: BuildplaneWorkspacePort;
	readonly admissionStore?: RunAdmissionLocalEvidenceStore | null;
	readonly admittedPlanReader?: AdmittedPlanReader;
	readonly eventBus?: EventBus;
	readonly profileRegistry?: BuildplaneProfileRegistryPort;
	readonly budgets?: BudgetConstraints;
	readonly memoryPort?: BuildplaneMemoryPort;
	readonly outcomeRouting?: OutcomeRoutingConfig;
	readonly ledgerActivityPort?: LedgerActivityPort;
	readonly acceptanceEvidencePort?: BuildplaneAcceptanceEvidencePort;
	readonly acceptancePort?: BuildplaneAcceptancePort;
	readonly operatorDecisionPort?: OperatorDecisionPort;
	/**
	 * Candidate-promotion signed-tape boundary. It must validate the authority
	 * and candidate-bound acceptance/review references before recording either
	 * event; without it candidate promotion is fail-closed.
	 */
	readonly candidatePromotionDecisionPort?: CandidatePromotionDecisionPort;
	/**
	 * Signed candidate acceptance/review evidence. Its absence never grants a
	 * governed candidate promotion eligibility.
	 */
	readonly candidateEvidencePort?: CandidateEvidencePort;
	/**
	 * Deliberate construction marker for the quarantined pre-trust-spine
	 * compatibility surface. It is not a governed execution lane and cannot be
	 * combined with any V3 action-plane or governed-workspace capability.
	 */
	readonly unsafeLegacyExecutionLane?: "raw-legacy";
	/**
	 * Explicit compatibility escape hatch for pre-trust-spine callers only.
	 * It is never enabled by the CLI or Mission Control. A normal orchestrator
	 * must not accept the legacy run-level `merge` decision because that record
	 * is not bound to an immutable candidate, review, or promotion receipt.
	 */
	readonly unsafeLegacyMergeDecisionMode?: boolean;
	/**
	 * Explicitly unsafe compatibility lane for pre-sealed-V3 candidate promotion.
	 * It exists only for raw migration/test callers and is never wired by the
	 * CLI. Governed callers must omit it, which makes V1 and sealed-v2 candidate
	 * records replay-readable but incapable of mutating a target branch.
	 */
	readonly unsafeLegacyCandidatePromotionMode?: boolean;
	/**
	 * Required for a governed candidate. Its implementation owns the OCI
	 * sandbox and ActionGateway; the generic legacy runtime is never a fallback.
	 */
	readonly governedWorkerExecutionPort?: GovernedWorkerExecutionPort;
	/**
	 * Mandatory durable V3 action evidence boundary. Its absence blocks a V3
	 * governed candidate before any worker or workspace effect starts.
	 */
	readonly governedActionEvidencePort?: GovernedActionEvidencePort;
	/**
	 * Mandatory native activity lease/result boundary for V3 candidate Git
	 * materialization. The same immutable port used by a worker must be passed
	 * to the workspace adapter before it can create a candidate ref.
	 */
	readonly governedActivityClaimPort?: GovernedActivityClaimPort;
	/**
	 * Mandatory local Git identity verifier for V3. A dispatch's base object can
	 * exist in several clones, so this port binds it to this exact repository
	 * before a workspace or target-branch-adjacent effect is prepared.
	 */
	readonly governedRepositoryBindingPort?: GovernedRepositoryBindingPort;
	/** Host-owned realm verifier; required before V3 workspace preparation. */
	readonly governedLedgerAuthorityRealmPort?: GovernedLedgerAuthorityRealmPort;
	/**
	 * Structural retry-context resolver for a sealed-V3 retry. Its response is
	 * explicitly untrusted and contains neither native signature nor tape proof;
	 * a future native attestation boundary remains mandatory before activation.
	 */
	readonly governedRetryContextResolverPort?: GovernedV3RetryContextResolverPort;
	/**
	 * Signed `result_ready` emit seam (M6-S7). When present, the orchestrator emits
	 * a write-ahead `result_ready` once a run reaches its terminal `passed` outcome.
	 */
	readonly resultReadyPort?: ResultReadyPort;
	/**
	 * Signed `run_completed` emit seam (M6-S7). When present, the orchestrator emits
	 * a write-ahead `run_completed` after an operator decision's terminal side effect.
	 */
	readonly runCompletionPort?: RunCompletionPort;
	/**
	 * Optional hook invoked after the isolated worktree is created and before
	 * the workspace row is recorded / admission proceeds. Intended for dependency
	 * provisioning (e.g. `pnpm install --frozen-lockfile`) so acceptance-check
	 * commands that invoke workspace tooling have their binaries and packages
	 * available. Any thrown error surfaces as a `workspace-provision-failed`
	 * infrastructure failure; the worktree is retained for operator inspection.
	 */
	readonly provisionDeps?: (workspacePath: string) => void;
}

export function createBuildplaneOrchestrator(
	options: CreateBuildplaneOrchestratorOptions,
): BuildplaneOrchestrator {
	const { projectRoot, storage, runtime, policy, workspace } = options;
	const unsafeLegacyExecutionLane = options.unsafeLegacyExecutionLane;
	const unsafeLegacyCompatibilityRequested =
		unsafeLegacyExecutionLane === "raw-legacy" ||
		options.unsafeLegacyMergeDecisionMode === true ||
		options.unsafeLegacyCandidatePromotionMode === true;
	if (
		unsafeLegacyExecutionLane !== undefined &&
		unsafeLegacyExecutionLane !== "raw-legacy"
	) {
		throw new CandidatePromotionValidationError(
			"unsafe legacy execution lane must be exactly 'raw-legacy'.",
		);
	}
	if (
		unsafeLegacyCompatibilityRequested &&
		unsafeLegacyExecutionLane !== "raw-legacy"
	) {
		throw new CandidatePromotionValidationError(
			"unsafe legacy compatibility modes require an explicit raw-legacy construction lane.",
		);
	}
	// Constructing an ordinary orchestrator must not inspect ambient workspace
	// ports.  In particular, packet validation needs to fail before an
	// untrusted/absent port can run a getter or acquire a resource.  The
	// incompatibility check only matters for the explicitly unsafe raw lane, so
	// defer those reads until that lane is actually requested.
	if (unsafeLegacyCompatibilityRequested) {
		const hasGovernedV3Construction =
			options.governedWorkerExecutionPort !== undefined ||
			options.governedActionEvidencePort !== undefined ||
			options.governedActivityClaimPort !== undefined ||
			options.governedRepositoryBindingPort !== undefined ||
			options.governedLedgerAuthorityRealmPort !== undefined ||
			options.governedRetryContextResolverPort !== undefined ||
			workspace.governedWorkspaceBoundary === "pinned-governed-git-v1" ||
			workspace.createGovernedWorkspaceCandidate !== undefined ||
			workspace.promoteGovernedWorkspaceCandidate !== undefined ||
			workspace.inspectGovernedWorkspaceCandidatePromotion !== undefined;
		if (hasGovernedV3Construction) {
			throw new CandidatePromotionValidationError(
				"unsafe legacy compatibility modes cannot be constructed with governed V3 ports or workspace capabilities.",
			);
		}
	}
	const unsafeLegacyMergeDecisionMode =
		unsafeLegacyExecutionLane === "raw-legacy" &&
		options.unsafeLegacyMergeDecisionMode === true;
	const unsafeLegacyCandidatePromotionMode =
		unsafeLegacyExecutionLane === "raw-legacy" &&
		options.unsafeLegacyCandidatePromotionMode === true;
	const profileRegistry = options.profileRegistry;
	const topLevelBudgets = options.budgets;
	const defaultBus = options.eventBus ?? noopBus;
	const admissionStore =
		options.admissionStore === undefined
			? createDefaultRunAdmissionStore(projectRoot)
			: options.admissionStore;
	const admittedPlanReader =
		options.admittedPlanReader ?? createDefaultAdmittedPlanReader();
	const memoryPort = options.memoryPort;
	const ledgerActivityPort = options.ledgerActivityPort;
	const acceptanceEvidencePort =
		options.acceptanceEvidencePort ?? createDefaultAcceptanceEvidencePort();
	const acceptancePort = options.acceptancePort;
	const operatorDecisionPort = options.operatorDecisionPort;
	const candidatePromotionDecisionPort = options.candidatePromotionDecisionPort;
	const candidateEvidencePort = options.candidateEvidencePort;
	const governedWorkerExecutionPort = options.governedWorkerExecutionPort;
	const governedActionEvidencePort = options.governedActionEvidencePort;
	const governedActivityClaimPort = options.governedActivityClaimPort;
	const governedRepositoryBindingPort = options.governedRepositoryBindingPort;
	const governedLedgerAuthorityRealmPort =
		options.governedLedgerAuthorityRealmPort;
	const governedRetryContextResolverPort =
		options.governedRetryContextResolverPort;
	/**
	 * In-memory handoff only within one orchestrator invocation. A set enters
	 * this map exclusively after the evidence port durably seals it; callers
	 * cannot place a pre-effect digest in RunPacketOptions.
	 */
	const sealedActionReceiptSetsByRunId = new Map<
		string,
		ActionReceiptSetRecordedV1
	>();
	const candidateCreatedRefsByRunId = new Map<string, string>();
	const resultReadyPort = options.resultReadyPort;
	const runCompletionPort = options.runCompletionPort;
	const provisionDeps = options.provisionDeps;
	const outcomeRouting = options.outcomeRouting ?? defaultOutcomeRoutingConfig;
	const strategyWorkflowPromotionRule =
		"multi-round-strategy-workflow->procedure";

	function infrastructureFailure(
		kind: string,
		error: unknown,
	): RunInfrastructureFailure {
		return {
			kind,
			message: error instanceof Error ? error.message : String(error),
		};
	}

	// M5-S4 D5 — validate BEFORE any emit, so a malformed decision can never be
	// signed onto the tape. Throws a typed error on the first violation.
	function validateOperatorDecisionInput(
		input: RecordOperatorDecisionInput,
	): void {
		if (input.decision !== "approved" && input.decision !== "rejected") {
			throw new OperatorDecisionValidationError(
				`decision must be 'approved' or 'rejected', got '${input.decision}'.`,
			);
		}
		if (input.subject !== "merge" && input.subject !== "resume") {
			throw new OperatorDecisionValidationError(
				`subject must be 'merge' or 'resume', got '${input.subject}'.`,
			);
		}
		if (!UUID_PATTERN.test(input.runId)) {
			throw new OperatorDecisionValidationError(
				`runId must be a UUID, got '${input.runId}'.`,
			);
		}
		// F3 — the live write-ahead path must NEVER carry a mergeCommit: at emit
		// time the merge has not happened (D1), so a present SHA would sign a
		// false/pre-merge value onto the immutable tape. `mergeCommit` stays on the
		// input type for a future post-hoc decision API, but this live path rejects it.
		if (input.mergeCommit !== undefined) {
			throw new OperatorDecisionValidationError(
				"mergeCommit must be absent in the live write-ahead path (the merge has not happened at emit time, D1).",
			);
		}
		if (input.decidedBy.trim().length === 0) {
			throw new OperatorDecisionValidationError("decidedBy must be non-empty.");
		}
		// F7 / P1.7 — strict RFC3339: regex SHAPE + parseable instant + a real
		// calendar round-trip. The shape regex and `Date.parse` both accept
		// calendar-impossible dates (`2026-02-31` parses and normalizes to Mar 3),
		// so an invalid date could be signed onto the immutable tape. After the shape
		// matches, rebuild the captured wall-clock fields through `Date.UTC` and
		// confirm no field rolled over — month 00/13, day 32, hour 24, minute 60, or
		// Feb 31 all fail this equality (offset just shifts the instant, never the
		// captured wall-clock components, so this is offset-independent).
		const match = RFC3339_PATTERN.exec(input.decidedAt);
		if (match === null || Number.isNaN(Date.parse(input.decidedAt))) {
			throw new OperatorDecisionValidationError(
				`decidedAt must be RFC3339, got '${input.decidedAt}'.`,
			);
		}
		const fields = match.groups as {
			year: string;
			month: string;
			day: string;
			hour: string;
			minute: string;
			second: string;
		};
		const year = Number(fields.year);
		const month = Number(fields.month);
		const day = Number(fields.day);
		const hour = Number(fields.hour);
		const minute = Number(fields.minute);
		const second = Number(fields.second);
		const roundTrip = new Date(
			Date.UTC(year, month - 1, day, hour, minute, second),
		);
		if (
			roundTrip.getUTCFullYear() !== year ||
			roundTrip.getUTCMonth() !== month - 1 ||
			roundTrip.getUTCDate() !== day ||
			roundTrip.getUTCHours() !== hour ||
			roundTrip.getUTCMinutes() !== minute ||
			roundTrip.getUTCSeconds() !== second
		) {
			throw new OperatorDecisionValidationError(
				`decidedAt must be a real calendar date, got '${input.decidedAt}'.`,
			);
		}

		// Run state must match the subject (D5): resume → suspended.
		const snapshot = storage.inspectTarget(input.runId);
		const status = snapshot.run.status;
		if (input.subject === "resume" && status !== "suspended") {
			throw new OperatorDecisionValidationError(
				`resume decision requires a suspended run, got '${status}'.`,
			);
		}
		// F2 — a merge decision is only signable when the run is in the legitimate
		// merge-eligible state: status `passed` (the only post-state that sets
		// acceptance_outcome='passed' is commitRunSuccessOutcome, which transitions
		// running→passed; recordAcceptanceShadow then sets the shadow without
		// touching status), acceptance PASSED, AND a retained worktree to merge. The
		// status gate is load-bearing on its own: a degenerate run can carry
		// acceptance_outcome='passed' + a retained workspace while its status was
		// later flipped (e.g. `failed` from an infra failure) — without this gate
		// such a run would sign a merge decision and the merge-reject status gate
		// would then false-heal it. Any other state (failed/pending/running/
		// cancelled/suspended, or passed-without-acceptance, or passed-without-
		// workspace) must throw BEFORE the emit so a state-malformed merge decision
		// can never reach the immutable tape.
		if (input.subject === "merge") {
			const candidate = storage.getCandidateArtifact?.(input.runId);
			if (candidate && isSealedV3Candidate(candidate)) {
				requireNoUnsafeLegacyCompatibilityForGovernedLineage(
					"a sealed V3 candidate",
				);
			}
			if (!unsafeLegacyMergeDecisionMode) {
				throw new OperatorDecisionValidationError(
					"legacy run-level merge decisions are disabled; promote an immutable candidate through recordCandidatePromotion instead.",
				);
			}
			// A governed candidate has a different promotion protocol: its review,
			// signed candidate-bound decision, stale-base check, and CAS merge must
			// all run through recordCandidatePromotion. The legacy run-level merge
			// decision cannot reconstruct those bindings, so block it before a
			// write-ahead operator record or Git side effect is emitted.
			if (candidate) {
				throw new OperatorDecisionValidationError(
					`merge decision for governed candidate run '${input.runId}' is unsupported; use recordCandidatePromotion.`,
				);
			}
			if (status !== "passed") {
				throw new OperatorDecisionValidationError(
					`merge decision requires a passed run, got '${status}'.`,
				);
			}
			if (storage.getRunAcceptanceOutcome(input.runId) !== "passed") {
				throw new OperatorDecisionValidationError(
					"merge decision requires a run whose acceptance passed.",
				);
			}
			if (!snapshot.workspace?.path) {
				throw new OperatorDecisionValidationError(
					`merge decision requires a retained worktree for run '${input.runId}'.`,
				);
			}
		}
	}

	// M6-S7 — captured by `applyOperatorDecisionSideEffect` (which stays
	// synchronous/`void` so the D2–D4 marker ordering is preserved and its callers
	// are NOT promoted to `await` the side effect) and awaited by those async
	// callers so a signed `run_completed` is durable before control returns.
	let pendingRunCompletedEmit: Promise<void> | null = null;

	// M6-S7 (pre-build resolution 8) — build the `run_completed` fields SYNCHRONOUSLY
	// from the already-loaded inspect snapshot: `duration_ms` from the first tape
	// event's timestamp (the `run_started` occurrence — the synchronous run-start
	// proxy, since `Run` carries no createdAt), `event_count` from the tape summary,
	// `unit_count` from the run history. All strings on the wire (the U64 → TS-number
	// hazard).
	function buildRunCompletedInput(
		runId: string,
		outcome: RunCompletionOutcome,
	): RecordRunCompletedInput {
		const snapshot = storage.inspectTarget(runId);
		const startedAt = snapshot.eventTape?.firstOccurredAt;
		const startedMs = startedAt ? Date.parse(startedAt) : Number.NaN;
		const durationMs = Number.isNaN(startedMs)
			? 0
			: Math.max(0, Date.now() - startedMs);
		return {
			runId,
			outcome,
			durationMs: String(durationMs),
			eventCount: String(snapshot.eventTape?.eventCount ?? 0),
			unitCount: String(snapshot.runHistory.length),
		};
	}

	// Await and clear the write-ahead `run_completed` emit captured by the last
	// synchronous `applyOperatorDecisionSideEffect` call (M6-S7).
	async function flushPendingRunCompletedEmit(): Promise<void> {
		const emit = pendingRunCompletedEmit;
		pendingRunCompletedEmit = null;
		if (emit) {
			await emit;
		}
	}

	// M6-S7 (A1) — emit the signed `result_ready` at the finalizeRun terminal `passed`
	// advance (NOT the per-attempt acceptance pass), chaining it to the plan_admitted +
	// acceptance_recorded events. A non-passed terminal, or a run with no recorded
	// acceptance/admission id, emits nothing.
	//
	// Per-flow ordering vs the worktree merge (F4 — the signed event is identical either
	// way; only the point at which it fires differs):
	//   • Auto-merge flow (this runPacketAsync path): finalizeRun merges the worktree
	//     INTERNALLY before returning terminal `passed`, so `result_ready` is a
	//     POST-MERGE terminal signal — it is NOT write-ahead of that merge.
	//   • Operator-gated flow: the terminal merge/quarantine is driven later by
	//     recordOperatorDecision, where the write-ahead completion signal is the signed
	//     `run_completed` (see applyOperatorDecisionSideEffect); `result_ready`, when
	//     emitted, precedes that operator decision.
	async function finalizeWithResultReady(
		result: RunPacketResult,
		chain: {
			readonly admissionEventId?: string;
			readonly acceptanceEventId?: string;
		},
		options?: { readonly emitResultReady?: boolean },
	): Promise<RunPacketResult> {
		if (
			options?.emitResultReady !== false &&
			resultReadyPort &&
			result.run.status === "passed" &&
			chain.admissionEventId &&
			chain.acceptanceEventId
		) {
			await resultReadyPort.recordResultReady(
				result.run.id,
				chain.admissionEventId,
				chain.acceptanceEventId,
			);
		}
		return result;
	}

	// Shared by recordOperatorDecision and the reconciler. The execution marker is
	// the exactly-once gate (D2/D4): we record it only after the side effect
	// succeeds, so a re-drive of an already-merged run is impossible.
	function applyOperatorDecisionSideEffect(
		runId: string,
		subject: OperatorDecisionSubject,
		decision: OperatorDecisionVerdict,
	): void {
		// Reset the write-ahead slot: an already-executed decision (fast-path below)
		// must not leave a prior iteration's emit for the caller to re-await.
		pendingRunCompletedEmit = null;

		// F1/F5 — marker check-and-claim. If the side effect already completed for
		// this run (post-marker reconciler re-drive, operator re-decide, or a
		// duplicate shadow that escaped the DISTINCT feed), no-op. Combined with the
		// adapter's runId-keyed merge idempotency, this closes the
		// crash-after-merge-before-marker double-merge window: even if the merge ran
		// but the marker write was lost, the adapter detects the prior merge and
		// returns its SHA without creating a second commit.
		if (storage.isOperatorDecisionExecuted(runId)) {
			return;
		}

		// Fix B (D2) — the marker fast-path covers the post-marker re-drive, but a
		// crash AFTER the side effect ran and BEFORE the marker write leaves the run
		// in `listDecidedUnexecutedDecisions` with no marker. Re-driving the
		// transition unguarded would throw (approveRun/rejectSuspendedRun require a
		// suspended run) or DUPLICATE a terminal event (rejectMergeDecision is
		// unguarded). So gate each transition on the run not already being in its
		// post-side-effect state (the crash-surviving signal, analogous to the
		// merge-approved git-history probe), then ALWAYS heal the marker. A second
		// pass therefore neither throws nor creates a second state transition.
		const currentStatus = storage.inspectTarget(runId).run.status;

		// M6-S7 (A2) — the terminal run outcome this decision produces, or null for a
		// non-terminal transition (resume+approved re-dispatches → `pending`). Emitted
		// ONCE at the single exit so no branch silently skips the signed completion.
		let terminalOutcome: RunCompletionOutcome | null = null;
		// The Tier-1 execution marker payload to write once the side effect (and, for a
		// terminal decision, the signed run_completed) has durably landed. Carries the
		// merge HEAD for an approved merge; `undefined` otherwise.
		let markerOutcome: { mergedHeadSha?: string } | undefined;

		if (subject === "resume") {
			if (decision === "approved") {
				// Post-state of approveRun is `pending`; only transition if still suspended.
				if (currentStatus === "suspended") {
					storage.approveRun(runId);
				}
				// resume+approved re-dispatches the run — not a terminal completion.
			} else {
				// Post-state of rejectSuspendedRun is `failed`; only transition if still suspended.
				if (currentStatus === "suspended") {
					storage.rejectSuspendedRun(runId);
				}
				terminalOutcome = "failed";
			}
		} else if (decision === "rejected") {
			// merge + rejected — quarantine: no merge, worktree retained, run marked
			// failed. Post-state is `failed`; only transition if not already failed
			// (rejectMergeDecision is unguarded in storage, so a re-drive would append
			// a duplicate terminal).
			if (currentStatus !== "failed") {
				storage.rejectMergeDecision(runId);
			}
			terminalOutcome = "failed";
		} else {
			// merge + approved — merge the retained worktree, then record the marker
			// carrying the merge HEAD (D4 no-double-merge: the marker's presence keeps
			// listDecidedUnexecutedDecisions from ever returning this run again).
			const snapshot = storage.inspectTarget(runId);
			const workspacePath = snapshot.workspace?.path;
			if (!workspacePath) {
				throw new Error(
					`merge decision for run '${runId}' has no retained worktree to merge.`,
				);
			}
			if (!workspace.commitAndMergeWorkspace) {
				throw new Error(
					"merge decision requires a workspace adapter with commitAndMergeWorkspace.",
				);
			}
			const mergeResult = workspace.commitAndMergeWorkspace({
				path: workspacePath,
				runId,
				projectRoot,
			});
			markerOutcome = { mergedHeadSha: mergeResult.mergedHeadSha };
			terminalOutcome = "passed";
		}

		// M6-S7 (F2) — for a terminal decision, emit + FLUSH the signed run_completed
		// BEFORE writing the execution marker, then write the marker in the post-flush
		// continuation. Ordering is load-bearing: if the marker were written first, a
		// transient emit failure would leave the run marked-executed — so the
		// reconciler's listDecidedUnexecutedDecisions would never re-drive it — and
		// permanently lose the run_completed. Emitting first means a crash between the
		// emit and the marker leaves the run in the pending set for the reconciler to
		// re-drive; the git merge is runId-keyed idempotent (see the marker check-and-
		// claim above) and recordRunCompleted dedups on the tape, so the re-drive neither
		// double-merges nor double-emits. Captured (not awaited) so this function stays
		// synchronous; the async callers await `pendingRunCompletedEmit`.
		if (terminalOutcome !== null && runCompletionPort) {
			const outcome = terminalOutcome;
			const marker = markerOutcome;
			pendingRunCompletedEmit = (async () => {
				await runCompletionPort.recordRunCompleted(
					buildRunCompletedInput(runId, outcome),
				);
				storage.markOperatorDecisionExecuted(runId, marker);
			})();
		} else {
			// Non-terminal (resume+approved re-dispatch), or no completion port wired:
			// there is no run_completed to flush, so the marker is safe to write
			// synchronously — preserving the original ordering for those paths.
			storage.markOperatorDecisionExecuted(runId, markerOutcome);
		}
	}

	function requireCandidatePromotionDependencies(options?: {
		readonly recovery?: boolean;
	}): {
		readonly port: CandidatePromotionDecisionPort;
		readonly prepare: (
			input: CandidatePromotionIntentInput,
		) => CandidatePromotionIntent;
		readonly markRecorded: (
			candidateDigest: string,
			idempotencyKey: string,
		) => void;
		readonly claimExecution: (
			candidateDigest: string,
			idempotencyKey: string,
		) => CandidatePromotionExecutionLeaseV1;
		readonly markExecuted: (
			candidateDigest: string,
			idempotencyKey: string,
			outcome: {
				readonly outcome: CandidatePromotionOutcome;
				readonly mergedHeadSha?: string;
				readonly promotionGitBinding?: PromotionGitBindingV1;
			},
			executionLeaseToken: string,
		) => void;
		readonly listPending?: () => readonly CandidatePromotionIntent[];
	} {
		const prepare = storage.prepareCandidatePromotion;
		const markRecorded = storage.markCandidatePromotionRecorded;
		const claimExecution = storage.claimCandidatePromotionExecution;
		const markExecuted = storage.markCandidatePromotionExecuted;
		const listPending = storage.listPendingCandidatePromotions;
		if (
			!candidatePromotionDecisionPort ||
			!prepare ||
			!markRecorded ||
			!claimExecution ||
			!markExecuted ||
			(options?.recovery === true && !listPending)
		) {
			throw new CandidatePromotionValidationError(
				"candidate promotion requires a signed promotion port and durable promotion storage.",
			);
		}

		return {
			port: candidatePromotionDecisionPort,
			prepare: (input) => prepare.call(storage, input),
			markRecorded: (candidateDigest, idempotencyKey) =>
				markRecorded.call(storage, candidateDigest, idempotencyKey),
			claimExecution: (candidateDigest, idempotencyKey) =>
				claimExecution.call(storage, candidateDigest, idempotencyKey),
			markExecuted: (
				candidateDigest,
				idempotencyKey,
				outcome,
				executionLeaseToken,
			) =>
				markExecuted.call(
					storage,
					candidateDigest,
					idempotencyKey,
					outcome,
					executionLeaseToken,
				),
			...(listPending ? { listPending: () => listPending.call(storage) } : {}),
		};
	}

	/**
	 * The durable storage claim is a capability, not an advisory marker. Check
	 * its complete binding immediately before any promotion path can observe
	 * Git. An expired or substituted lease fails closed; recovery must acquire a
	 * new lease and reconcile the immutable Git receipt instead of finalizing a
	 * possibly foreign effect.
	 */
	function requireCandidatePromotionExecutionLease(
		lease: CandidatePromotionExecutionLeaseV1,
		candidateDigest: string,
		idempotencyKey: string,
	): string {
		if (
			!lease ||
			lease.schemaVersion !== 1 ||
			lease.state !== "active" ||
			lease.candidateDigest !== candidateDigest ||
			lease.idempotencyKey !== idempotencyKey ||
			typeof lease.leaseToken !== "string" ||
			lease.leaseToken.trim().length === 0 ||
			!Number.isSafeInteger(lease.claimEpoch) ||
			lease.claimEpoch < 1
		) {
			throw new CandidatePromotionValidationError(
				"candidate promotion execution requires an exact active durable lease.",
			);
		}
		const claimedAt = Date.parse(lease.claimedAt);
		const leaseExpiresAt = Date.parse(lease.leaseExpiresAt);
		if (
			!Number.isFinite(claimedAt) ||
			!Number.isFinite(leaseExpiresAt) ||
			claimedAt >= leaseExpiresAt ||
			leaseExpiresAt <= Date.now()
		) {
			throw new CandidatePromotionValidationError(
				"candidate promotion execution lease is expired or has an invalid time window; reconcile before retrying.",
			);
		}
		return lease.leaseToken;
	}

	function requirePromotionReference(value: unknown, field: string): string {
		if (typeof value !== "string" || value.trim().length === 0) {
			throw new CandidatePromotionValidationError(
				`${field} must be a non-empty string.`,
			);
		}
		return value;
	}

	function requireCanonicalActionId(value: unknown, field: string): string {
		const actionId = requirePromotionReference(value, field);
		if (!PRINTABLE_ASCII_ACTION_ID_PATTERN.test(actionId)) {
			throw new CandidatePromotionValidationError(
				`${field} must contain printable ASCII only so sealed action ordering is byte-stable across the kernel and native reducer.`,
			);
		}
		return actionId;
	}

	function compareCanonicalActionIds(left: string, right: string): number {
		if (left === right) return 0;
		return left < right ? -1 : 1;
	}

	function canonicalCandidateDigest(value: unknown, field: string): string {
		if (typeof value !== "string") {
			throw new CandidatePromotionValidationError(
				`${field} must be a SHA-256 digest.`,
			);
		}
		try {
			return canonicalSha256Digest(value);
		} catch (error) {
			throw new CandidatePromotionValidationError(
				`${field} is not a canonical SHA-256 digest: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	function canonicalCommitSha(value: unknown, field: string): string {
		if (
			typeof value !== "string" ||
			!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)
		) {
			throw new CandidatePromotionValidationError(
				`${field} must be a full 40- or 64-hex Git commit object ID.`,
			);
		}
		return value.toLowerCase();
	}

	function normalizeCandidateAcceptanceRecord(
		record: CandidateAcceptanceRecord,
		candidate: WorkspaceCandidateArtifact,
		expectedOutcome?: "passed" | "rejected",
		expectedAcceptanceContractDigest?: string,
	): CandidateAcceptanceRecord {
		const candidateDigest = canonicalCandidateDigest(
			candidate.candidateDigest,
			"candidate.candidateDigest",
		);
		const recordDigest = canonicalCandidateDigest(
			record.candidateDigest,
			"candidateAcceptance.candidateDigest",
		);
		const candidateCommitSha = canonicalCommitSha(
			candidate.candidateCommitSha,
			"candidate.candidateCommitSha",
		);
		const recordCommitSha = canonicalCommitSha(
			record.candidateCommitSha,
			"candidateAcceptance.candidateCommitSha",
		);
		const acceptanceRef = requirePromotionReference(
			record.acceptanceRef,
			"candidateAcceptance.acceptanceRef",
		);
		const acceptanceContractDigest =
			record.acceptanceContractDigest === undefined
				? undefined
				: canonicalCandidateDigest(
						record.acceptanceContractDigest,
						"candidateAcceptance.acceptanceContractDigest",
					);
		const expectedContractDigest =
			expectedAcceptanceContractDigest === undefined
				? undefined
				: canonicalCandidateDigest(
						expectedAcceptanceContractDigest,
						"expectedAcceptanceContractDigest",
					);
		if (
			recordDigest !== candidateDigest ||
			recordCommitSha !== candidateCommitSha
		) {
			throw new CandidatePromotionValidationError(
				"candidate acceptance must bind the exact frozen candidate digest and commit.",
			);
		}
		if (record.outcome !== "passed" && record.outcome !== "rejected") {
			throw new CandidatePromotionValidationError(
				"candidateAcceptance.outcome must be 'passed' or 'rejected'.",
			);
		}
		if (expectedOutcome && record.outcome !== expectedOutcome) {
			throw new CandidatePromotionValidationError(
				"candidate acceptance record outcome does not match the deterministic acceptance result.",
			);
		}
		if (
			expectedContractDigest !== undefined &&
			acceptanceContractDigest !== expectedContractDigest
		) {
			throw new CandidatePromotionValidationError(
				"candidate acceptance must bind the exact signed acceptance-contract digest.",
			);
		}
		return {
			candidateDigest,
			candidateCommitSha,
			...(acceptanceContractDigest ? { acceptanceContractDigest } : {}),
			acceptanceRef,
			outcome: record.outcome,
		};
	}

	function normalizeCandidateReviewRecord(
		record: CandidateReviewRecord,
		input: CandidateReviewEvidenceInput,
	): CandidateReviewRecord {
		const candidateDigest = canonicalCandidateDigest(
			input.candidate.candidateDigest,
			"candidate.candidateDigest",
		);
		const recordDigest = canonicalCandidateDigest(
			record.candidateDigest,
			"candidateReview.candidateDigest",
		);
		const candidateCommitSha = canonicalCommitSha(
			input.candidate.candidateCommitSha,
			"candidate.candidateCommitSha",
		);
		const recordCommitSha = canonicalCommitSha(
			record.candidateCommitSha,
			"candidateReview.candidateCommitSha",
		);
		const reviewRef = requirePromotionReference(
			record.reviewRef,
			"candidateReview.reviewRef",
		);
		const verdict = parseReviewVerdictV1(record.verdict);
		if (
			recordDigest !== candidateDigest ||
			recordCommitSha !== candidateCommitSha ||
			verdict.candidateDigest !== candidateDigest ||
			verdict.candidateDigest !== input.verdict.candidateDigest
		) {
			throw new CandidatePromotionValidationError(
				"candidate review must bind the exact frozen candidate digest and commit.",
			);
		}
		return {
			candidateDigest,
			candidateCommitSha,
			reviewRef,
			verdict,
		};
	}

	function candidateProjectionForFinalization(
		candidate: WorkspaceCandidateArtifact,
		packet: UnitPacket,
		legacyGovernance: CandidateGovernanceLineage | undefined,
		governedDispatch: GovernedDispatchLineageV3 | undefined,
	): CandidateArtifactProjectionInput {
		if (governedDispatch) {
			const sealedSet = sealedActionReceiptSetsByRunId.get(candidate.runId);
			if (!sealedSet) {
				throw new CandidatePromotionValidationError(
					"V3 candidate finalization requires a kernel-sealed action receipt set.",
				);
			}
			const candidateCreatedRef = candidateCreatedRefsByRunId.get(
				candidate.runId,
			);
			if (!candidateCreatedRef) {
				throw new CandidatePromotionValidationError(
					"V3 candidate finalization requires a durable CandidateCreatedV2 record.",
				);
			}
			if (
				sealedSet.runId !== candidate.runId ||
				sealedSet.workflowId !== governedDispatch.workflowId ||
				sealedSet.unitId !== governedDispatch.unitId ||
				sealedSet.attempt !== governedDispatch.attempt ||
				sealedSet.provenanceRef !== governedDispatch.provenanceRef ||
				sealedSet.dispatchEnvelopeDigest !== governedDispatch.envelopeDigest
			) {
				throw new CandidatePromotionValidationError(
					"kernel-sealed action receipt set does not bind the exact V3 governed dispatch.",
				);
			}
			if (packet.provenance_ref !== governedDispatch.provenanceRef) {
				throw new CandidatePromotionValidationError(
					"V3 governed dispatch provenanceRef must equal the dispatched packet provenance_ref.",
				);
			}
			return {
				...candidate,
				schemaVersion: 2,
				workflowId: governedDispatch.workflowId,
				unitId: governedDispatch.unitId,
				provenanceRef: governedDispatch.provenanceRef,
				envelopeDigest: governedDispatch.envelopeDigest,
				acceptanceContractDigest: governedDispatch.acceptanceContractDigest,
				actionEvidenceVersion: "sealed_v3",
				actionReceiptSetRef: sealedSet.actionReceiptSetRef,
				actionReceiptSetDigest: sealedSet.actionReceiptSetDigest,
				candidateCreatedRef,
			};
		}
		if (!legacyGovernance) {
			// A raw candidate remains durable and reviewable, but its missing V1
			// lineage keeps promotion fail-closed. Do not infer any authority from
			// packet metadata here.
			return candidate;
		}
		const workflowId = requirePromotionReference(
			legacyGovernance.workflowId,
			"candidateGovernance.workflowId",
		);
		const provenanceRef = requirePromotionReference(
			legacyGovernance.provenanceRef,
			"candidateGovernance.provenanceRef",
		);
		if (provenanceRef !== packet.provenance_ref) {
			throw new CandidatePromotionValidationError(
				"candidate governance provenanceRef must equal the dispatched packet provenance_ref.",
			);
		}
		return {
			...candidate,
			workflowId,
			unitId: packet.unit.id,
			provenanceRef,
			envelopeDigest: canonicalCandidateDigest(
				legacyGovernance.envelopeDigest,
				"candidateGovernance.envelopeDigest",
			),
			acceptanceContractDigest: canonicalCandidateDigest(
				legacyGovernance.acceptanceContractDigest,
				"candidateGovernance.acceptanceContractDigest",
			),
			actionReceiptDigest: canonicalCandidateDigest(
				legacyGovernance.actionReceiptDigest,
				"candidateGovernance.actionReceiptDigest",
			),
		};
	}

	function validateGovernedDispatchLineageV3(
		packet: UnitPacket,
		lineage: GovernedDispatchLineageV3,
		options?: {
			readonly expectedRunId?: string;
			readonly expectedBaseSha?: string;
		},
	): void {
		if (
			lineage.schemaVersion !== 3 ||
			lineage.commitMode !== "atomic" ||
			lineage.trustTier !== "governed" ||
			lineage.actionEvidenceVersion !== "sealed_v3"
		) {
			throw new CandidatePromotionValidationError(
				"new V3 governed dispatches must use schemaVersion 3, governed atomic mode, and sealed_v3 activity-claim action evidence.",
			);
		}
		if (lineage.executionRole !== "implementer") {
			throw new CandidatePromotionValidationError(
				"only an implementer V3 dispatch may create a governed candidate.",
			);
		}
		let governedPacket: UnitPacket;
		try {
			// Re-parse the packet through the strict source-admission boundary. A
			// normalized UnitPacket may otherwise retain the legacy default role or
			// omit a governed field that the V3 envelope claims to bind.
			governedPacket = parseGovernedUnitPacket(JSON.stringify(packet));
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new CandidatePromotionValidationError(
				`V3 governed dispatch requires a strictly admitted packet: ${detail}`,
			);
		}
		if (
			governedPacket.acceptance_contract === undefined ||
			governedPacket.trust_scope === undefined ||
			governedPacket.capability_bundle === undefined ||
			governedPacket.capability_bundle_digest === undefined
		) {
			throw new CandidatePromotionValidationError(
				"V3 governed dispatch requires acceptance, trust scope, and capability authority in the packet.",
			);
		}
		const packetAcceptanceContractDigest = digestAcceptanceContract(
			governedPacket.acceptance_contract as AcceptanceContractV0,
		);
		if (packetAcceptanceContractDigest !== lineage.acceptanceContractDigest) {
			throw new CandidatePromotionValidationError(
				"V3 governed dispatch acceptance contract digest does not match the dispatched packet.",
			);
		}
		if (
			governedPacket.unit.id !== lineage.unitId ||
			governedPacket.execution_role !== lineage.executionRole ||
			governedPacket.provenance_ref !== lineage.provenanceRef ||
			governedPacket.capability_bundle_digest !== lineage.capabilityBundleDigest
		) {
			throw new CandidatePromotionValidationError(
				"V3 governed dispatch does not exactly match packet unit, role, provenance, and capability authority.",
			);
		}
		if (
			canonicalGovernedUnitPacketV1Digest(governedPacket) !==
			lineage.governedPacketDigest
		) {
			throw new CandidatePromotionValidationError(
				"V3 governed dispatch does not bind the exact admitted packet used for execution.",
			);
		}
		if (options?.expectedRunId && lineage.runId !== options.expectedRunId) {
			throw new CandidatePromotionValidationError(
				"V3 governed dispatch runId does not match the kernel-created run.",
			);
		}
		if (
			options?.expectedBaseSha &&
			canonicalCommitSha(
				lineage.baseCommitSha,
				"governedDispatch.baseCommitSha",
			) !== canonicalCommitSha(options.expectedBaseSha, "workspace base SHA")
		) {
			throw new CandidatePromotionValidationError(
				"V3 governed dispatch base commit does not match the isolated workspace base.",
			);
		}
		if (!Number.isSafeInteger(lineage.attempt) || lineage.attempt < 1) {
			throw new CandidatePromotionValidationError(
				"V3 governed dispatch attempt must be a positive safe integer.",
			);
		}
		for (const [field, value] of [
			["governedDispatch.envelopeDigest", lineage.envelopeDigest],
			[
				"governedDispatch.repositoryBindingDigest",
				lineage.repositoryBindingDigest,
			],
			[
				"governedDispatch.ledgerAuthorityRealmDigest",
				lineage.ledgerAuthorityRealmDigest,
			],
			["governedDispatch.governedPacketDigest", lineage.governedPacketDigest],
			[
				"governedDispatch.capabilityBundleDigest",
				lineage.capabilityBundleDigest,
			],
			[
				"governedDispatch.acceptanceContractDigest",
				lineage.acceptanceContractDigest,
			],
			["governedDispatch.policyDigest", lineage.policyDigest],
			["governedDispatch.contextManifestDigest", lineage.contextManifestDigest],
			["governedDispatch.workerManifestDigest", lineage.workerManifestDigest],
			["governedDispatch.sandboxProfileDigest", lineage.sandboxProfileDigest],
		] as const) {
			canonicalCandidateDigest(value, field);
		}
		for (const [field, value] of [
			["governedDispatch.workflowId", lineage.workflowId],
			["governedDispatch.workflowRevision", lineage.workflowRevision],
			["governedDispatch.provenanceRef", lineage.provenanceRef],
			["governedDispatch.dispatchEnvelopeRef", lineage.dispatchEnvelopeRef],
			["governedDispatch.idempotencyKey", lineage.idempotencyKey],
			["governedDispatch.authorityActor", lineage.authorityActor],
			["governedDispatch.issuedAt", lineage.issuedAt],
			["governedDispatch.expiresAt", lineage.expiresAt],
		] as const) {
			requirePromotionReference(value, field);
		}
		const issuedAtEpochMs = requireRfc3339UtcEpoch(
			lineage.issuedAt,
			"governedDispatch.issuedAt",
		);
		const expiresAtEpochMs = requireRfc3339UtcEpoch(
			lineage.expiresAt,
			"governedDispatch.expiresAt",
		);
		if (issuedAtEpochMs >= expiresAtEpochMs) {
			throw new CandidatePromotionValidationError(
				"V3 governed dispatch expiresAt must be later than issuedAt.",
			);
		}
		if (expiresAtEpochMs <= Date.now()) {
			throw new CandidatePromotionValidationError(
				"V3 governed dispatch is expired and cannot authorize a worker effect.",
			);
		}
	}

	function normalizeDurableActionReceiptReferencesV3(
		input: readonly DurableActionReceiptReferenceV2[],
	): readonly DurableActionReceiptReferenceV2[] {
		if (!Array.isArray(input)) {
			throw new CandidatePromotionValidationError(
				"V3 governed worker must return an array of durable action receipt references.",
			);
		}
		const seenIds = new Set<string>();
		const seenRefs = new Set<string>();
		const seenDigests = new Set<string>();
		const normalized: DurableActionReceiptReferenceV2[] = [];
		for (let index = 0; index < input.length; index += 1) {
			if (!Object.hasOwn(input, index)) {
				throw new CandidatePromotionValidationError(
					"V3 governed worker action receipt references cannot be sparse.",
				);
			}
			const receipt = input[index];
			if (!receipt || typeof receipt !== "object") {
				throw new CandidatePromotionValidationError(
					"V3 governed worker action receipt reference must be an object.",
				);
			}
			const actionId = requireCanonicalActionId(
				receipt.actionId,
				"V3 action receipt actionId",
			);
			const actionReceiptRef = requirePromotionReference(
				receipt.actionReceiptRef,
				"V3 action receipt actionReceiptRef",
			);
			const actionReceiptDigest = canonicalCandidateDigest(
				receipt.actionReceiptDigest,
				"V3 action receipt actionReceiptDigest",
			);
			if (
				seenIds.has(actionId) ||
				seenRefs.has(actionReceiptRef) ||
				seenDigests.has(actionReceiptDigest)
			) {
				throw new CandidatePromotionValidationError(
					"V3 governed worker action receipt references must be unique.",
				);
			}
			seenIds.add(actionId);
			seenRefs.add(actionReceiptRef);
			seenDigests.add(actionReceiptDigest);
			normalized.push({ actionId, actionReceiptRef, actionReceiptDigest });
		}
		return normalized.sort((left, right) =>
			compareCanonicalActionIds(left.actionId, right.actionId),
		);
	}

	function isGovernedWorkerExecutionResultV3(
		value:
			| ExecutionReceipt
			| import("./ports.js").GovernedWorkerExecutionResultV3,
	): value is import("./ports.js").GovernedWorkerExecutionResultV3 {
		return (
			value !== null &&
			typeof value === "object" &&
			"executionReceipt" in value &&
			"actionReceipts" in value
		);
	}

	async function sealActionReceiptSetV3(
		lineage: GovernedDispatchLineageV3,
		receipts: readonly DurableActionReceiptReferenceV2[],
	): Promise<ActionReceiptSetRecordedV1> {
		if (!governedActionEvidencePort) {
			throw new CandidatePromotionValidationError(
				"V3 governed candidate execution requires a durable action evidence port.",
			);
		}
		const sealed = parseActionReceiptSetRecordedV1(
			await governedActionEvidencePort.sealActionReceiptSet({
				runId: lineage.runId,
				workflowId: lineage.workflowId,
				unitId: lineage.unitId,
				attempt: lineage.attempt,
				provenanceRef: lineage.provenanceRef,
				dispatchEnvelopeDigest: lineage.envelopeDigest,
				receipts: normalizeDurableActionReceiptReferencesV3(receipts),
				sealedAt: new Date().toISOString(),
			}),
		);
		if (
			sealed.runId !== lineage.runId ||
			sealed.workflowId !== lineage.workflowId ||
			sealed.unitId !== lineage.unitId ||
			sealed.attempt !== lineage.attempt ||
			sealed.provenanceRef !== lineage.provenanceRef ||
			sealed.dispatchEnvelopeDigest !== lineage.envelopeDigest
		) {
			throw new CandidatePromotionValidationError(
				"sealed V3 action receipt set does not match the governed dispatch.",
			);
		}
		return sealed;
	}

	async function recordCandidateCreatedV3(
		candidate: WorkspaceCandidateArtifact,
		lineage: GovernedDispatchLineageV3,
		sealedSet: ActionReceiptSetRecordedV1,
		candidateCreateActionEvidence: CandidateCreateActionEvidenceV1,
	): Promise<void> {
		if (!governedActionEvidencePort) {
			throw new CandidatePromotionValidationError(
				"V3 candidate creation requires a durable action evidence port.",
			);
		}
		const recordCandidateCompletion =
			governedActionEvidencePort.recordCandidateCompletion;
		if (!recordCandidateCompletion) {
			throw new CandidatePromotionValidationError(
				"V3 candidate creation requires a durable candidate-completion evidence port.",
			);
		}
		const [candidateCreateReceipt] = normalizeDurableActionReceiptReferencesV3([
			candidateCreateActionEvidence,
		]);
		if (!candidateCreateReceipt) {
			throw new CandidatePromotionValidationError(
				"V3 candidate completion requires one candidate-create action receipt.",
			);
		}
		if (
			!sealedSet.receipts.some(
				(receipt) =>
					receipt.actionId === candidateCreateReceipt.actionId &&
					receipt.actionReceiptRef ===
						candidateCreateReceipt.actionReceiptRef &&
					receipt.actionReceiptDigest ===
						candidateCreateReceipt.actionReceiptDigest,
			)
		) {
			throw new CandidatePromotionValidationError(
				"V3 candidate completion requires its candidate-create receipt in the sealed action set.",
			);
		}
		const candidateCreated = parseCandidateCreatedV2({
			runId: candidate.runId,
			candidateId: candidate.candidateId,
			candidateRef: candidate.candidateRef,
			workflowId: lineage.workflowId,
			unitId: lineage.unitId,
			attempt: lineage.attempt,
			provenanceRef: lineage.provenanceRef,
			candidateDigest: canonicalCandidateDigest(
				candidate.candidateDigest,
				"candidate.candidateDigest",
			),
			baseCommitSha: canonicalCommitSha(candidate.baseSha, "candidate.baseSha"),
			candidateCommitSha: canonicalCommitSha(
				candidate.candidateCommitSha,
				"candidate.candidateCommitSha",
			),
			commitDigest: canonicalCandidateDigest(
				candidate.commitDigest,
				"candidate.commitDigest",
			),
			treeDigest: canonicalCandidateDigest(
				candidate.treeDigest,
				"candidate.treeDigest",
			),
			patchDigest: canonicalCandidateDigest(
				candidate.patchDigest,
				"candidate.patchDigest",
			),
			changedFilesDigest: canonicalCandidateDigest(
				candidate.changedFilesDigest,
				"candidate.changedFilesDigest",
			),
			envelopeDigest: lineage.envelopeDigest,
			actionReceiptSetRef: sealedSet.actionReceiptSetRef,
			actionReceiptSetDigest: sealedSet.actionReceiptSetDigest,
		});
		const candidateCreatedRef = requirePromotionReference(
			await governedActionEvidencePort.recordCandidateCreatedV2(
				candidateCreated,
			),
			"candidateCreatedV2 ref",
		);
		const completionWithoutDigest: Omit<
			CandidateCompletionRecordedV1,
			"completionDigest"
		> = {
			runId: candidate.runId,
			workflowId: lineage.workflowId,
			unitId: lineage.unitId,
			attempt: lineage.attempt,
			provenanceRef: lineage.provenanceRef,
			candidateCreatedEventRef: candidateCreatedRef,
			candidateDigest: candidateCreated.candidateDigest,
			candidateCreateActionId: candidateCreateReceipt.actionId,
			actionRequestRef: candidateCreateActionEvidence.actionRequestRef,
			actionRequestDigest: candidateCreateActionEvidence.actionRequestDigest,
			activityClaimEventRef:
				candidateCreateActionEvidence.activityClaimEventRef,
			activityClaimEventDigest:
				candidateCreateActionEvidence.activityClaimEventDigest,
			activityResultEventRef:
				candidateCreateActionEvidence.activityResultEventRef,
			activityResultEventDigest:
				candidateCreateActionEvidence.activityResultEventDigest,
			actionReceiptRef: candidateCreateReceipt.actionReceiptRef,
			actionReceiptDigest: candidateCreateReceipt.actionReceiptDigest,
			// The seal is written only after the activity result and receipt. Reusing
			// its durable timestamp makes a post-write retry derive the same proof.
			completedAt: sealedSet.sealedAt,
		};
		const completion = parseCandidateCompletionRecordedV1({
			...completionWithoutDigest,
			completionDigest: canonicalCandidateCompletionRecordedV1Digest(
				completionWithoutDigest,
			),
		});
		const durableCompletion = await recordCandidateCompletion.call(
			governedActionEvidencePort,
			completion,
		);
		requirePromotionReference(
			durableCompletion.candidateCompletionRef,
			"candidateCompletion ref",
		);
		if (durableCompletion.completionDigest !== completion.completionDigest) {
			throw new CandidatePromotionValidationError(
				"V3 candidate completion port returned a mismatched completion digest.",
			);
		}
		candidateCreatedRefsByRunId.set(candidate.runId, candidateCreatedRef);
	}

	/**
	 * A caller must not be able to attach candidate lineage and accidentally fall
	 * back to the legacy auto-merge finalizer. Normalize only the omitted lane
	 * marker; reject every combination that could turn governed intent into an
	 * ambient execution or merge.
	 */
	function normalizeRunPacketOptions(
		packet: UnitPacket,
		options?: RunPacketOptions,
	): RunPacketOptions | undefined {
		const hasGovernanceFields = carriesGovernanceFields(packet);
		if (!options) {
			if (hasGovernanceFields) {
				throw new CandidatePromotionValidationError(
					"Packets carrying governance fields require a verified sealed_v3 dispatch; they cannot execute through the legacy runtime.",
				);
			}
			// The raw-legacy construction marker is the explicit compatibility
			// boundary. Preserve its historical successful-run behavior while
			// leaving unmarked/ambient callers discard-only.
			return unsafeLegacyExecutionLane === "raw-legacy"
				? { trustLane: "unsafe", finalizationMode: "auto-merge" }
				: undefined;
		}
		// A raw-legacy construction remains explicit even when its caller supplies
		// only an override such as `finalizationMode: "discard"`. Explicit trust
		// lane values retain their meaning, so a caller can still opt out.
		const normalizedOptions =
			unsafeLegacyExecutionLane === "raw-legacy" &&
			options.trustLane === undefined
				? { ...options, trustLane: "unsafe" as const }
				: options;
		const hasCandidateGovernance =
			normalizedOptions.candidateGovernance !== undefined;
		const governedDispatch = normalizedOptions.governedDispatch;
		const hasGovernedDispatchV3 = governedDispatch !== undefined;
		if (hasCandidateGovernance && hasGovernedDispatchV3) {
			throw new CandidatePromotionValidationError(
				"candidateGovernance is V1 migration-only and cannot be combined with a V3 governed dispatch.",
			);
		}
		if (hasGovernedDispatchV3) {
			requireNoUnsafeLegacyCompatibilityForGovernedLineage(
				"a V3 governed dispatch",
			);
			if (normalizedOptions.finalizationMode !== "create-candidate") {
				throw new CandidatePromotionValidationError(
					"V3 governed dispatch requires finalizationMode 'create-candidate'.",
				);
			}
			if (normalizedOptions.trustLane === "unsafe") {
				throw new CandidatePromotionValidationError(
					"V3 governed dispatch cannot execute in the unsafe raw lane.",
				);
			}
			// `hasGovernedDispatchV3` is derived from this local binding so the
			// validation and the later worker handoff use one exact immutable value.
			if (!governedDispatch) {
				throw new CandidatePromotionValidationError(
					"V3 governed dispatch was missing after admission option normalization.",
				);
			}
			validateGovernedDispatchLineageV3(packet, governedDispatch);
			if (
				!governedWorkerExecutionPort ||
				!governedActionEvidencePort?.recordCandidateCompletion ||
				!governedActivityClaimPort ||
				!governedRepositoryBindingPort ||
				!governedLedgerAuthorityRealmPort ||
				!candidateEvidencePort ||
				workspace.governedWorkspaceBoundary !== "pinned-governed-git-v1" ||
				!workspace.createGovernedWorkspaceCandidate ||
				!storage.commitRunCandidateOutcome
			) {
				throw new CandidatePromotionValidationError(
					"V3 governed candidate execution requires OCI ActionGateway, durable action evidence and candidate-completion evidence, native activity claims, repository and ledger-realm binding, a pinned governed Git workspace, candidate acceptance, and storage ports before any effect starts.",
				);
			}
			governedRepositoryBindingPort.assertDispatchRepositoryBinding({
				projectRoot,
				dispatch: governedDispatch,
			});
			governedLedgerAuthorityRealmPort.assertDispatchLedgerAuthorityRealm({
				dispatch: governedDispatch,
			});
			return { ...normalizedOptions, trustLane: "governed" };
		}
		if (hasGovernanceFields) {
			throw new CandidatePromotionValidationError(
				"Packets carrying governance fields require a verified sealed_v3 dispatch; they cannot execute through the legacy runtime.",
			);
		}
		if (hasCandidateGovernance) {
			throw new CandidatePromotionValidationError(
				"candidateGovernance is replay-only compatibility evidence and cannot authorize a new governed execution; provide a verified sealed_v3 dispatch.",
			);
		}
		if (normalizedOptions.trustLane === "governed") {
			throw new CandidatePromotionValidationError(
				"the governed trust lane requires signed candidate governance lineage.",
			);
		}
		if (
			normalizedOptions.finalizationMode === "auto-merge" &&
			normalizedOptions.trustLane !== "unsafe"
		) {
			throw new CandidatePromotionValidationError(
				"auto-merge is available only through the explicit unsafe raw lane; use create-candidate for governed promotion.",
			);
		}
		return normalizedOptions;
	}

	function toWorkspaceCandidateArtifact(
		candidate: CandidateArtifactProjection,
	): WorkspaceCandidateArtifact {
		return {
			schemaVersion: 1,
			candidateId: candidate.candidateId,
			runId: candidate.runId,
			attempt: candidate.attempt,
			candidateKey: candidate.candidateKey,
			candidateRef: candidate.candidateRef,
			baseSha: candidate.baseSha,
			candidateCommitSha: candidate.candidateCommitSha,
			commitDigest: candidate.commitDigest,
			treeDigest: candidate.treeDigest,
			patchDigest: candidate.patchDigest,
			changedFilesDigest: candidate.changedFilesDigest,
			candidateDigest: candidate.candidateDigest,
		};
	}

	function intentInputOf(
		intent: CandidatePromotionIntent,
	): CandidatePromotionIntentInput {
		return {
			runId: intent.runId,
			candidate: intent.candidate,
			decision: intent.decision,
			acceptance: intent.acceptance,
			review: intent.review,
			preparedAt: intent.preparedAt,
		};
	}

	/**
	 * Validates all local equality bindings before the promotion port can sign or
	 * the workspace adapter can mutate the target. The promotion port remains the
	 * authority/signature verifier for the evidence references themselves.
	 */
	function validateCandidatePromotionBinding(
		input: RecordCandidatePromotionInput,
		candidate: CandidateArtifactProjection,
	): CandidatePromotionIntentInput {
		let decision: PromotionDecisionV1;
		let verdict: ReviewVerdictV1;
		try {
			decision = parseSignablePromotionDecisionV1(input.decision);
			verdict = parseReviewVerdictV1(input.review.verdict);
		} catch (error) {
			throw new CandidatePromotionValidationError(
				`candidate promotion contract is invalid: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}

		if (candidate.runId !== input.runId) {
			throw new CandidatePromotionValidationError(
				"candidate run identity does not match the requested promotion run.",
			);
		}
		if (
			!candidate.workflowId ||
			!candidate.provenanceRef ||
			!candidate.envelopeDigest ||
			!candidate.acceptanceContractDigest
		) {
			throw new CandidatePromotionValidationError(
				"candidate lacks required governed workflow, provenance, envelope, or acceptance-contract lineage.",
			);
		}
		if (candidate.schemaVersion === 1) {
			canonicalCandidateDigest(
				candidate.actionReceiptDigest,
				"candidate.actionReceiptDigest",
			);
			if (
				candidate.actionEvidenceVersion !== undefined ||
				candidate.actionReceiptSetRef !== undefined ||
				candidate.actionReceiptSetDigest !== undefined ||
				candidate.candidateCreatedRef !== undefined
			) {
				throw new CandidatePromotionValidationError(
					"V1 candidate lineage cannot carry sealed V3 action-evidence fields.",
				);
			}
		} else if (candidate.schemaVersion === 2) {
			if (candidate.actionReceiptDigest !== undefined) {
				throw new CandidatePromotionValidationError(
					"V2 candidate lineage must not carry the legacy V1 action-receipt digest.",
				);
			}
			if (
				candidate.actionEvidenceVersion !== "sealed-v2" &&
				candidate.actionEvidenceVersion !== "sealed_v3"
			) {
				throw new CandidatePromotionValidationError(
					"V2 candidate lineage requires actionEvidenceVersion 'sealed-v2' or 'sealed_v3'.",
				);
			}
			requirePromotionReference(
				candidate.actionReceiptSetRef,
				"candidate.actionReceiptSetRef",
			);
			canonicalCandidateDigest(
				candidate.actionReceiptSetDigest,
				"candidate.actionReceiptSetDigest",
			);
			requirePromotionReference(
				candidate.candidateCreatedRef,
				"candidate.candidateCreatedRef",
			);
		} else {
			throw new CandidatePromotionValidationError(
				"candidate schemaVersion must be 1 or 2.",
			);
		}
		if (!decision.targetRef) {
			throw new CandidatePromotionValidationError(
				"governed candidate promotion requires a signed canonical targetRef.",
			);
		}

		const candidateDigest = canonicalCandidateDigest(
			candidate.candidateDigest,
			"candidate.candidateDigest",
		);
		const acceptanceCandidateDigest = canonicalCandidateDigest(
			input.acceptance.candidateDigest,
			"acceptance.candidateDigest",
		);
		const acceptanceCandidateCommitSha = canonicalCommitSha(
			input.acceptance.candidateCommitSha,
			"acceptance.candidateCommitSha",
		);
		const reviewCandidateDigest = canonicalCandidateDigest(
			input.review.candidateDigest,
			"review.candidateDigest",
		);
		const reviewCandidateCommitSha = canonicalCommitSha(
			input.review.candidateCommitSha,
			"review.candidateCommitSha",
		);
		const acceptanceRef = requirePromotionReference(
			input.acceptance.acceptanceRef,
			"acceptance.acceptanceRef",
		);
		const candidateAcceptanceContractDigest = canonicalCandidateDigest(
			candidate.acceptanceContractDigest,
			"candidate.acceptanceContractDigest",
		);
		const acceptanceContractDigest = canonicalCandidateDigest(
			input.acceptance.acceptanceContractDigest,
			"acceptance.acceptanceContractDigest",
		);
		const reviewRef = requirePromotionReference(
			input.review.reviewRef,
			"review.reviewRef",
		);

		if (
			decision.candidateDigest !== candidateDigest ||
			acceptanceCandidateDigest !== candidateDigest ||
			reviewCandidateDigest !== candidateDigest ||
			acceptanceCandidateCommitSha !== candidate.candidateCommitSha ||
			reviewCandidateCommitSha !== candidate.candidateCommitSha ||
			verdict.candidateDigest !== candidateDigest
		) {
			throw new CandidatePromotionValidationError(
				"promotion, acceptance, review, and candidate digests/commits must all bind the same immutable candidate.",
			);
		}
		if (decision.baseCommitSha !== candidate.baseSha) {
			throw new CandidatePromotionValidationError(
				"promotion decision baseCommitSha does not match the candidate base.",
			);
		}
		if (decision.envelopeDigest !== candidate.envelopeDigest) {
			throw new CandidatePromotionValidationError(
				"promotion decision envelopeDigest does not match the candidate envelope.",
			);
		}
		if (acceptanceContractDigest !== candidateAcceptanceContractDigest) {
			throw new CandidatePromotionValidationError(
				"promotion acceptance contract does not match the signed candidate envelope contract.",
			);
		}
		if (decision.acceptanceRef !== acceptanceRef) {
			throw new CandidatePromotionValidationError(
				"promotion decision acceptanceRef does not match the candidate acceptance record.",
			);
		}
		if (!decision.reviewRefs.includes(reviewRef)) {
			throw new CandidatePromotionValidationError(
				"promotion decision reviewRefs does not include the candidate review record.",
			);
		}
		if (decision.decision === "promote") {
			if (input.acceptance.outcome !== "passed") {
				throw new CandidatePromotionValidationError(
					"promotion requires deterministic candidate acceptance to pass.",
				);
			}
			if (verdict.decision !== "approve") {
				throw new CandidatePromotionValidationError(
					"promotion requires an affirmative structured review verdict.",
				);
			}
		}

		return {
			runId: input.runId,
			candidate,
			decision,
			acceptance: {
				candidateDigest,
				candidateCommitSha: acceptanceCandidateCommitSha,
				acceptanceContractDigest,
				acceptanceRef,
				outcome: input.acceptance.outcome,
			},
			review: {
				candidateDigest,
				candidateCommitSha: reviewCandidateCommitSha,
				reviewRef,
				verdict,
			},
			preparedAt: new Date().toISOString(),
		};
	}

	function isSealedV3Candidate(
		candidate: CandidateArtifactProjection,
	): boolean {
		return (
			candidate.schemaVersion === 2 &&
			candidate.actionEvidenceVersion === "sealed_v3"
		);
	}

	/**
	 * Raw compatibility controls are construction-scoped and never authorize a
	 * V3 governed action. Check again at each lineage boundary because an
	 * embedding can load a sealed candidate or dispatch after construction.
	 */
	function requireNoUnsafeLegacyCompatibilityForGovernedLineage(
		lineage: string,
	): void {
		if (!unsafeLegacyCompatibilityRequested) return;
		throw new CandidatePromotionValidationError(
			`unsafe legacy compatibility modes cannot execute ${lineage}; construct a governed orchestrator without unsafe legacy switches.`,
		);
	}

	/**
	 * A structurally injected TypeScript workspace adapter cannot be the
	 * promotion authority. Keep pre-sealed-V3 candidate lineage readable for
	 * inspection/replay, but prevent it from reaching the normal mutation API.
	 * The raw compatibility switch is intentionally explicit and never supplied
	 * by the CLI; sealed V3 remains separately blocked until native execution
	 * owns decision verification and the target-ref CAS under the ledger lock.
	 */
	function requireCandidatePromotionExecutionLane(
		candidate: CandidateArtifactProjection,
	): void {
		if (isSealedV3Candidate(candidate)) {
			requireNoUnsafeLegacyCompatibilityForGovernedLineage(
				"a sealed V3 candidate",
			);
			return;
		}
		if (unsafeLegacyCandidatePromotionMode) {
			return;
		}
		throw new CandidatePromotionValidationError(
			"pre-sealed V3 candidate promotion is replay-only; target mutation requires a sealed_v3 candidate and a native decision-bound promotion executor.",
		);
	}

	/**
	 * A sealed V3 promotion is authority-bearing from the first durable record,
	 * not merely from the eventual Git CAS. Until the native executor exists,
	 * do not create a local write-ahead intent that recovery cannot execute.
	 * Rejections remain recordable because they never reach a target mutation.
	 */
	function requireSealedV3PromotionExecutorBeforePreparation(
		candidate: CandidateArtifactProjection,
		decision: PromotionDecisionV1,
	): void {
		if (!isSealedV3Candidate(candidate) || decision.decision !== "promote") {
			return;
		}
		if (workspace.governedWorkspaceBoundary !== "pinned-governed-git-v1") {
			throw new CandidatePromotionValidationError(
				"sealed V3 candidate promotion requires a pinned governed Git workspace boundary.",
			);
		}
		throw new CandidatePromotionValidationError(
			"sealed V3 candidate promotion requires a native decision-bound promotion executor; generic workspace promotion is not authority.",
		);
	}

	function requireStrictPromotionTargetRef(
		decision: PromotionDecisionV1,
		field: string,
	): string {
		let parsed: PromotionDecisionV1;
		try {
			parsed = parsePromotionDecisionV1(decision);
		} catch (error) {
			throw new CandidatePromotionValidationError(
				`${field} is invalid: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		if (!parsed.targetRef) {
			throw new CandidatePromotionValidationError(
				`${field} lacks the required signed targetRef.`,
			);
		}
		return parsed.targetRef;
	}

	function promotionReceiptRefForCandidate(
		candidate: CandidateArtifactProjection,
	): string {
		if (!isCanonicalBuildplaneCandidateRef(candidate.candidateRef)) {
			throw new CandidatePromotionValidationError(
				"candidate artifact lacks a canonical immutable candidate ref for promotion receipt binding.",
			);
		}
		const suffix = candidate.candidateRef.slice(
			"refs/buildplane/candidates/".length,
		);
		return `refs/buildplane/promotions/${suffix}`;
	}

	function normalizePromotionGitBinding(
		binding: PromotionGitBindingV1 | undefined,
		candidate: CandidateArtifactProjection,
		targetRef: string,
		mergedHeadSha: string,
		expectedWorktreeSyncState: PromotionWorktreeSyncStateV1,
	): PromotionGitBindingV1 {
		if (!binding || typeof binding !== "object") {
			throw new CandidatePromotionValidationError(
				"candidate promotion adapter result is missing strict Git-binding evidence.",
			);
		}
		if (binding.targetRef !== targetRef) {
			throw new CandidatePromotionValidationError(
				"candidate promotion adapter targetRef does not match the signed promotion decision.",
			);
		}
		const targetHeadBeforeSha = canonicalCommitSha(
			binding.targetHeadBeforeSha,
			"candidate promotion adapter result targetHeadBeforeSha",
		);
		const candidateCommitSha = canonicalCommitSha(
			binding.candidateCommitSha,
			"candidate promotion adapter result candidateCommitSha",
		);
		const targetHeadAfterSha = canonicalCommitSha(
			binding.targetHeadAfterSha,
			"candidate promotion adapter result targetHeadAfterSha",
		);
		const bindingMergedHeadSha = canonicalCommitSha(
			binding.mergedHeadSha,
			"candidate promotion adapter result binding mergedHeadSha",
		);
		if (
			!Array.isArray(binding.mergeParentShas) ||
			binding.mergeParentShas.length !== 2
		) {
			throw new CandidatePromotionValidationError(
				"candidate promotion adapter result must bind exactly two merge parents.",
			);
		}
		const mergeParentShas: readonly [string, string] = [
			canonicalCommitSha(
				binding.mergeParentShas[0],
				"candidate promotion adapter result first merge parent",
			),
			canonicalCommitSha(
				binding.mergeParentShas[1],
				"candidate promotion adapter result second merge parent",
			),
		];
		const mergedTreeSha = canonicalCommitSha(
			binding.mergedTreeSha,
			"candidate promotion adapter result mergedTreeSha",
		);
		const mergedTreeDigest = canonicalCandidateDigest(
			binding.mergedTreeDigest,
			"candidate promotion adapter result mergedTreeDigest",
		);
		const promotionReceiptRef = promotionReceiptRefForCandidate(candidate);
		if (
			targetHeadBeforeSha !== candidate.baseSha ||
			bindingMergedHeadSha !== mergedHeadSha ||
			candidateCommitSha !== candidate.candidateCommitSha ||
			mergeParentShas[0] !== candidate.baseSha ||
			mergeParentShas[1] !== candidate.candidateCommitSha ||
			binding.promotionReceiptRef !== promotionReceiptRef ||
			mergedTreeDigest !==
				canonicalCandidateDigest(candidate.treeDigest, "candidate.treeDigest")
		) {
			throw new CandidatePromotionValidationError(
				"candidate promotion adapter Git-binding evidence does not match the immutable candidate.",
			);
		}
		if (binding.worktreeSyncState !== expectedWorktreeSyncState) {
			throw new CandidatePromotionValidationError(
				"candidate promotion adapter worktree-sync state does not match its terminal outcome.",
			);
		}
		const targetStillEqualsMerge = targetHeadAfterSha === bindingMergedHeadSha;
		if (
			expectedWorktreeSyncState === "target_advanced" &&
			targetStillEqualsMerge
		) {
			throw new CandidatePromotionValidationError(
				"candidate promotion adapter cannot report target_advanced when the target still equals the merge.",
			);
		}
		if (
			(expectedWorktreeSyncState === "pending_reconciliation" ||
				expectedWorktreeSyncState === "root_checkout_stale") &&
			!targetStillEqualsMerge
		) {
			throw new CandidatePromotionValidationError(
				"candidate promotion adapter cannot report a pending or root-stale checkout while the target no longer equals the merge.",
			);
		}
		return {
			targetRef,
			targetHeadBeforeSha,
			targetHeadAfterSha,
			mergedHeadSha: bindingMergedHeadSha,
			candidateCommitSha,
			mergeParentShas,
			mergedTreeSha,
			mergedTreeDigest,
			promotionReceiptRef,
			worktreeSyncState: expectedWorktreeSyncState,
		};
	}

	async function executeCandidatePromotionIntent(
		intent: CandidatePromotionIntent,
		replayed: boolean,
		options?: { readonly recovery?: boolean },
	): Promise<CandidatePromotionResult> {
		const recovery = options?.recovery === true;
		const canonicalDigest = canonicalCandidateDigest(
			intent.candidate.candidateDigest,
			"candidate.candidateDigest",
		);
		if (intent.decision.candidateDigest !== canonicalDigest) {
			throw new CandidatePromotionValidationError(
				"stored promotion intent candidate digest no longer matches its candidate artifact.",
			);
		}
		// This receipt ref is a capability-bearing derivation from the candidate
		// identity. Validate it before recording/claiming the promotion or exposing
		// the candidate to a target-ref mutation adapter.
		promotionReceiptRefForCandidate(intent.candidate);
		requireCandidatePromotionExecutionLane(intent.candidate);
		const dependencies = requireCandidatePromotionDependencies(
			recovery ? { recovery: true } : undefined,
		);

		if (intent.state === "executed") {
			if (!intent.executedOutcome) {
				throw new CandidatePromotionValidationError(
					"executed promotion intent is missing its terminal outcome.",
				);
			}
			return {
				candidateDigest: canonicalDigest,
				outcome: intent.executedOutcome,
				...(intent.mergedHeadSha
					? { mergedHeadSha: intent.mergedHeadSha }
					: {}),
				...(intent.promotionGitBinding
					? { promotionGitBinding: intent.promotionGitBinding }
					: {}),
				replayed: true,
			};
		}

		// Always present the recovered intent to the signed boundary. Apart from
		// deduplicating a crash-after-flush replay, this makes the tape authority
		// reject a locally tampered `recorded` row before it can reach Git.
		const promotionDecisionRef = requirePromotionReference(
			await dependencies.port.recordPromotionDecision({
				intent: intentInputOf(intent),
			}),
			"promotionDecisionRef",
		);
		if (intent.state === "prepared") {
			dependencies.markRecorded(
				canonicalDigest,
				intent.decision.idempotencyKey,
			);
		}

		const executionLeaseToken = requireCandidatePromotionExecutionLease(
			dependencies.claimExecution(
				canonicalDigest,
				intent.decision.idempotencyKey,
			),
			canonicalDigest,
			intent.decision.idempotencyKey,
		);

		if (intent.decision.decision === "reject") {
			await dependencies.port.recordPromotionResult({
				runId: intent.runId,
				candidateDigest: canonicalDigest,
				idempotencyKey: intent.decision.idempotencyKey,
				promotionDecisionRef,
				outcome: "rejected",
			});
			dependencies.markExecuted(
				canonicalDigest,
				intent.decision.idempotencyKey,
				{ outcome: "rejected" },
				executionLeaseToken,
			);
			return {
				candidateDigest: canonicalDigest,
				outcome: "rejected",
				replayed,
			};
		}

		const sealedV3Candidate = isSealedV3Candidate(intent.candidate);
		if (
			sealedV3Candidate &&
			workspace.governedWorkspaceBoundary !== "pinned-governed-git-v1"
		) {
			throw new CandidatePromotionValidationError(
				"sealed V3 candidate promotion requires a pinned governed Git workspace boundary.",
			);
		}
		if (sealedV3Candidate && !recovery) {
			// A generic workspace port is structurally injectable and cannot prove
			// that it verified the signed decision before its target-ref CAS. Keep
			// sealed V3 promotion blocked until the native, decision-bound executor
			// owns that single mutation under the ledger lock.
			throw new CandidatePromotionValidationError(
				"sealed V3 candidate promotion requires a native decision-bound promotion executor; generic workspace promotion is not authority.",
			);
		}
		const targetRef = requireStrictPromotionTargetRef(
			intent.decision,
			"stored promotion decision",
		);
		const promotionInput = {
			projectRoot,
			candidate: toWorkspaceCandidateArtifact(intent.candidate),
			targetRef,
		};
		const promotion = recovery
			? (() => {
					// A startup replay must first prove that the original target CAS
					// happened by reading the immutable candidate-keyed receipt. It is
					// never allowed to retry a merge or manufacture historical receipt
					// evidence in this crash window.
					const inspectCandidate = sealedV3Candidate
						? workspace.inspectGovernedWorkspaceCandidatePromotion
						: workspace.inspectWorkspaceCandidatePromotion;
					if (!inspectCandidate) {
						throw new CandidatePromotionValidationError(
							sealedV3Candidate
								? "sealed V3 candidate promotion recovery requires inspectGovernedWorkspaceCandidatePromotion."
								: "candidate promotion recovery requires inspectWorkspaceCandidatePromotion.",
						);
					}
					const inspected = inspectCandidate(promotionInput);
					if (!inspected) {
						throw new CandidatePromotionValidationError(
							sealedV3Candidate
								? "sealed V3 candidate promotion recovery found no immutable promotion receipt."
								: "candidate promotion recovery found no immutable promotion receipt.",
						);
					}
					return inspected;
				})()
			: (() => {
					// The sealed-V3 branch returned above, so only the explicitly
					// compatibility candidate transaction may select this raw workspace
					// mutation capability.
					const promoteCandidate = workspace.promoteWorkspaceCandidate;
					const promoted = promoteCandidate?.(promotionInput);
					if (!promoted) {
						throw new CandidatePromotionValidationError(
							"candidate promotion requires a workspace adapter with promoteWorkspaceCandidate.",
						);
					}
					return promoted;
				})();
		const adapterCandidateDigest = canonicalCandidateDigest(
			promotion.candidateDigest,
			"candidate promotion adapter result candidateDigest",
		);
		if (adapterCandidateDigest !== canonicalDigest) {
			throw new CandidatePromotionValidationError(
				"candidate promotion adapter returned a result for a different candidate.",
			);
		}
		const mergedHeadSha = canonicalCommitSha(
			promotion.mergedHeadSha,
			"candidate promotion adapter result mergedHeadSha",
		);
		const adapterWorktreeSyncState: PromotionWorktreeSyncStateV1 =
			promotion.status === "reconciliation_required"
				? "target_advanced"
				: "pending_reconciliation";
		const adapterPromotionGitBinding = normalizePromotionGitBinding(
			promotion.promotionGitBinding,
			intent.candidate,
			targetRef,
			mergedHeadSha,
			adapterWorktreeSyncState,
		);
		// `promoteWorkspaceCandidate` advances only the target ref. Its
		// `pending_reconciliation` observation is therefore not a successful root
		// checkout handoff: reporting `promoted` would let storage mark this run
		// passed while the files under projectRoot still represent the old base.
		// Do not attempt a reset/checkout here: an operator edit can race the
		// post-CAS observation. Terminalize the exact, still-recoverable state so
		// an explicit reconciler can later use a clean/base/branch-validated
		// fast-forward-equivalent operation. A replaced target remains the separate
		// `target_advanced` case.
		const outcome: CandidatePromotionOutcome = "reconciliation_required";
		const promotionGitBinding: PromotionGitBindingV1 =
			adapterWorktreeSyncState === "pending_reconciliation"
				? {
						...adapterPromotionGitBinding,
						worktreeSyncState: "root_checkout_stale",
					}
				: adapterPromotionGitBinding;
		await dependencies.port.recordPromotionResult({
			runId: intent.runId,
			candidateDigest: canonicalDigest,
			idempotencyKey: intent.decision.idempotencyKey,
			promotionDecisionRef,
			outcome,
			mergedHeadSha,
			promotionGitBinding,
		});
		dependencies.markExecuted(
			canonicalDigest,
			intent.decision.idempotencyKey,
			{
				outcome,
				mergedHeadSha,
				promotionGitBinding,
			},
			executionLeaseToken,
		);
		return {
			candidateDigest: canonicalDigest,
			outcome,
			mergedHeadSha,
			promotionGitBinding,
			replayed: replayed || promotion.status === "already_promoted",
		};
	}

	function createDefaultRunAdmissionStore(
		root: string,
	): RunAdmissionLocalEvidenceStore {
		const admissionDir = resolve(
			resolveGitMetadataDir(root),
			"buildplane",
			"admission",
		);
		const receiptsDir = resolve(admissionDir, "receipts");
		const eventsPath = resolve(admissionDir, "events.jsonl");
		return {
			writeReceiptArtifact(input) {
				mkdirSync(receiptsDir, { recursive: true });
				const receiptId =
					typeof input.receipt.receipt_id === "string" &&
					input.receipt.receipt_id.length > 0
						? input.receipt.receipt_id
						: input.receiptDigest.replace(/^sha256:/, "");
				const path = resolve(
					receiptsDir,
					`${sanitizeAdmissionStoreStem(receiptId)}.json`,
				);
				writeFileSync(path, input.contents, "utf8");
				return {
					ref: `artifact://run-admission/${input.receiptDigest}`,
					path,
				};
			},
			appendAdmissionEvent(input) {
				mkdirSync(admissionDir, { recursive: true });
				appendFileSync(eventsPath, `${JSON.stringify(input.event)}\n`, "utf8");
				return {
					ref: createDefaultRunAdmissionEventRef(input),
					path: eventsPath,
				};
			},
		};
	}

	function resolveGitMetadataDir(repositoryRoot: string): string {
		try {
			return execFileSync(
				"git",
				["-C", repositoryRoot, "rev-parse", "--absolute-git-dir"],
				{
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				},
			).trim();
		} catch {
			return resolve(repositoryRoot, ".git");
		}
	}

	function sanitizeAdmissionStoreStem(value: string): string {
		const safe = value
			.replace(/[^A-Za-z0-9_-]/g, "_")
			.slice(0, MAX_ADMISSION_STEM_LENGTH);
		return safe.length > 0 ? safe : DEFAULT_ADMISSION_STEM;
	}

	function stableAdmissionJson(value: unknown): string {
		if (value === null || typeof value !== "object") {
			return JSON.stringify(value);
		}
		if (Array.isArray(value)) {
			return `[${value.map((item) => stableAdmissionJson(item)).join(",")}]`;
		}
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(
				(key) => `${JSON.stringify(key)}:${stableAdmissionJson(record[key])}`,
			)
			.join(",")}}`;
	}

	function createDefaultRunAdmissionEventRef(input: {
		event: JsonRecord;
		receipt: JsonRecord;
	}): string {
		const eventKind =
			typeof input.event.kind === "string" && input.event.kind.length > 0
				? input.event.kind
				: "run_admission_recorded";
		const recordedAt =
			typeof input.event.recorded_at === "string" &&
			input.event.recorded_at.length > 0
				? input.event.recorded_at
				: "";
		const payload =
			typeof input.event.payload === "object" &&
			input.event.payload !== null &&
			!Array.isArray(input.event.payload)
				? (input.event.payload as JsonRecord)
				: undefined;
		const receiptId =
			typeof payload?.receipt_id === "string"
				? payload.receipt_id
				: typeof input.receipt.receipt_id === "string"
					? input.receipt.receipt_id
					: DEFAULT_ADMISSION_STEM;
		const eventDigest = createHash("sha256")
			.update(
				stableAdmissionJson({
					eventKind,
					recordedAt,
					receiptId,
					payload,
					receipt: input.receipt,
				}),
			)
			.digest("hex");
		return `event://run-admission/${sanitizeAdmissionStoreStem(receiptId)}/${eventDigest}`;
	}

	function toWorkspaceSnapshot(
		run: Run,
		preparedWorkspace: {
			path: string;
			headSha: string;
		},
	): WorkspaceSnapshot {
		return {
			runId: run.id,
			path: preparedWorkspace.path,
			headSha: preparedWorkspace.headSha,
			status: "active",
		};
	}

	function collectWorkspaceChangedFiles(
		workspaceRoot: string,
	): readonly string[] {
		try {
			const tracked = execFileSync(
				"git",
				["-C", workspaceRoot, "diff", "--name-only", "HEAD", "--"],
				{
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				},
			);
			const untracked = execFileSync(
				"git",
				["-C", workspaceRoot, "ls-files", "--others", "--exclude-standard"],
				{
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				},
			);
			return Array.from(
				new Set(
					[...tracked.split(/\r?\n/), ...untracked.split(/\r?\n/)]
						.map((path) => path.trim())
						.filter(Boolean),
				),
			).sort();
		} catch {
			return ["../buildplane-diff-unavailable"];
		}
	}

	/**
	 * Deterministic candidate diff. Unlike a live worktree diff, this remains
	 * stable after a check process runs because both endpoints are immutable Git
	 * objects. A failed lookup returns the same fail-closed sentinel used by the
	 * legacy acceptance gate.
	 */
	function collectCandidateChangedFiles(
		workspaceRoot: string,
		baseSha: string,
		candidateCommitSha: string,
	): readonly string[] {
		try {
			const changed = execFileSync(
				"git",
				[
					"-C",
					workspaceRoot,
					"diff",
					"--name-only",
					`${baseSha}..${candidateCommitSha}`,
					"--",
				],
				{
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				},
			);
			return Array.from(
				new Set(
					changed
						.split(/\r?\n/)
						.map((path) => path.trim())
						.filter(Boolean),
				),
			).sort();
		} catch {
			return ["../buildplane-diff-unavailable"];
		}
	}

	/**
	 * Current HEAD of the worktree, or null if it cannot be read. The acceptance
	 * gate diffs against `HEAD`, so a worker (or an unsandboxed check) that
	 * `git commit`s inside the detached worktree during execution advances HEAD and
	 * makes `git diff HEAD` report an empty diff — blinding the diff-scope arm to a
	 * committed, possibly out-of-scope delta the merge would still ship. The gate
	 * compares this against the immutable recorded base SHA and rejects fail-closed
	 * on any advance.
	 */
	function readWorkspaceHeadSha(workspaceRoot: string): string | null {
		try {
			return execFileSync("git", ["-C", workspaceRoot, "rev-parse", "HEAD"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch {
			return null;
		}
	}

	function createDefaultAcceptanceEvidencePort(): BuildplaneAcceptanceEvidencePort {
		return {
			collectCheckResults(input) {
				return collectAcceptanceCheckResults(
					input.contract,
					input.workspacePath,
				);
			},
		};
	}

	function collectAcceptanceCheckResults(
		contract: AcceptanceContractV0,
		workspacePath: string,
	): readonly AcceptanceCheckResult[] {
		return contract.checks.map((check) => {
			const result = spawnSync(check.command, {
				cwd: workspacePath,
				encoding: "utf8",
				shell: true,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});

			return {
				command: check.command,
				exitCode: result.status ?? 1,
			};
		});
	}

	function evaluateAcceptanceBeforeFinalization(input: {
		readonly resolvedProfile: PolicyProfile | undefined;
		readonly workspacePath: string;
		readonly currentPacket: UnitPacket;
		readonly currentReceipt: ExecutionReceipt;
		readonly attemptCount: number;
	}): PolicyDecision | null {
		const acceptanceContract =
			input.resolvedProfile?.trustGates?.acceptanceContract;
		if (!acceptanceContract) {
			return null;
		}

		if (!policy.evaluateAcceptanceContract) {
			return {
				kind: "acceptance.contract",
				outcome: "rejected",
				reasons: [
					"acceptance.contract configured but no evaluator is available.",
				],
			};
		}

		let checkResults: readonly AcceptanceCheckResult[];
		try {
			checkResults = acceptanceEvidencePort.collectCheckResults({
				contract: acceptanceContract,
				workspacePath: input.workspacePath,
				packet: input.currentPacket,
				receipt: input.currentReceipt,
				attemptCount: input.attemptCount,
			});
		} catch (error) {
			return {
				kind: "acceptance.contract",
				outcome: "rejected",
				reasons: [
					`acceptance.contract check collection failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				],
			};
		}

		return policy.evaluateAcceptanceContract(acceptanceContract, {
			changedFiles: input.currentReceipt.changedFiles,
			checkResults,
		});
	}

	/**
	 * Finalization-time acceptance gate for the async run loop. Candidate callers
	 * pass a frozen Git artifact: checks execute only while the worktree still
	 * names that commit, policy evaluates the immutable base..candidate diff, and
	 * the result is written through the candidate evidence port. A raw/legacy run
	 * retains the existing acceptance-record behavior.
	 */
	async function evaluateAndRecordAcceptanceAsync(input: {
		readonly resolvedProfile: PolicyProfile | undefined;
		readonly workspacePath: string;
		readonly baseSha: string;
		readonly currentPacket: UnitPacket;
		readonly currentReceipt: ExecutionReceipt;
		readonly attemptCount: number;
		readonly runId: string;
		/** Present only after immutable candidate creation. */
		readonly candidate?: WorkspaceCandidateArtifact;
		/** Governed candidates require a contract and candidate-bound evidence. */
		readonly requireCandidateEvidence?: boolean;
		/** Exact contract digest extracted from the signed dispatch envelope. */
		readonly expectedAcceptanceContractDigest?: string;
	}): Promise<{
		decision: PolicyDecision | null;
		acceptanceEventId?: string;
		candidateAcceptance?: CandidateAcceptanceRecord;
	}> {
		const acceptanceContract =
			input.resolvedProfile?.trustGates?.acceptanceContract;
		if (!acceptanceContract) {
			if (input.requireCandidateEvidence) {
				return {
					decision: {
						kind: "acceptance.contract",
						outcome: "rejected",
						reasons: [
							"Governed candidate finalization requires an acceptance contract bound to the frozen candidate.",
						],
					},
				};
			}
			return { decision: null };
		}
		let boundAcceptanceContractDigest: string | undefined;
		if (input.requireCandidateEvidence) {
			try {
				boundAcceptanceContractDigest = canonicalCandidateDigest(
					input.expectedAcceptanceContractDigest,
					"candidateGovernance.acceptanceContractDigest",
				);
				const evaluatedContractDigest =
					digestAcceptanceContract(acceptanceContract);
				if (evaluatedContractDigest !== boundAcceptanceContractDigest) {
					return {
						decision: {
							kind: "acceptance.contract",
							outcome: "rejected",
							reasons: [
								"Governed candidate acceptance contract does not match the signed dispatch envelope.",
							],
						},
					};
				}
			} catch (error) {
				return {
					decision: {
						kind: "acceptance.contract",
						outcome: "rejected",
						reasons: [
							`Governed candidate acceptance contract binding is invalid: ${
								error instanceof Error ? error.message : String(error)
							}`,
						],
					},
				};
			}
		}
		if (input.requireCandidateEvidence && !candidateEvidencePort) {
			return {
				decision: {
					kind: "acceptance.contract",
					outcome: "rejected",
					reasons: [
						"Governed candidate finalization requires a signed candidate acceptance evidence port.",
					],
				},
			};
		}

		if (!policy.evaluateAcceptanceContract) {
			return {
				decision: {
					kind: "acceptance.contract",
					outcome: "rejected",
					reasons: [
						"acceptance.contract configured but no evaluator is available.",
					],
				},
			};
		}

		let candidateIntegrityFailure: string | undefined;
		let frozenCandidateCommitSha: string | undefined;
		if (input.candidate) {
			try {
				frozenCandidateCommitSha = canonicalCommitSha(
					input.candidate.candidateCommitSha,
					"candidate.candidateCommitSha",
				);
				const currentHead = readWorkspaceHeadSha(input.workspacePath);
				if (
					currentHead === null ||
					canonicalCommitSha(currentHead, "candidate workspace HEAD") !==
						frozenCandidateCommitSha ||
					!workspace.checkWorktreeClean(input.workspacePath)
				) {
					candidateIntegrityFailure =
						"candidate workspace no longer exactly matches the frozen candidate before deterministic checks.";
				}
			} catch (error) {
				candidateIntegrityFailure = `candidate integrity could not be verified before deterministic checks: ${
					error instanceof Error ? error.message : String(error)
				}`;
			}
		}

		let checkResults: readonly AcceptanceCheckResult[];
		if (candidateIntegrityFailure) {
			checkResults = [];
		} else {
			try {
				checkResults = acceptanceEvidencePort.collectCheckResults({
					contract: acceptanceContract,
					workspacePath: input.workspacePath,
					packet: input.currentPacket,
					receipt: input.currentReceipt,
					attemptCount: input.attemptCount,
				});
			} catch (error) {
				return {
					decision: {
						kind: "acceptance.contract",
						outcome: "rejected",
						reasons: [
							`acceptance.contract check collection failed: ${
								error instanceof Error ? error.message : String(error)
							}`,
						],
					},
				};
			}
		}

		let changedFiles: readonly string[];
		let integrityFailed = candidateIntegrityFailure !== undefined;
		if (input.candidate && frozenCandidateCommitSha) {
			changedFiles = collectCandidateChangedFiles(
				input.workspacePath,
				input.candidate.baseSha,
				frozenCandidateCommitSha,
			);
			try {
				const currentHead = readWorkspaceHeadSha(input.workspacePath);
				if (
					currentHead === null ||
					canonicalCommitSha(currentHead, "candidate workspace HEAD") !==
						frozenCandidateCommitSha ||
					!workspace.checkWorktreeClean(input.workspacePath)
				) {
					integrityFailed = true;
					candidateIntegrityFailure ??=
						"candidate workspace changed while deterministic checks were running; checks must evaluate the frozen candidate only.";
				}
			} catch (error) {
				integrityFailed = true;
				candidateIntegrityFailure ??= `candidate integrity could not be verified after deterministic checks: ${
					error instanceof Error ? error.message : String(error)
				}`;
			}
		} else {
			// Legacy mode re-captures live worktree changes so a check that mutates a
			// file cannot escape the diff-scope policy.
			changedFiles = collectWorkspaceChangedFiles(input.workspacePath);
			const currentHeadSha = readWorkspaceHeadSha(input.workspacePath);
			integrityFailed =
				currentHeadSha !== null && currentHeadSha !== input.baseSha;
			if (integrityFailed) {
				candidateIntegrityFailure = `acceptance.contract: worktree HEAD advanced from ${input.baseSha} to ${
					currentHeadSha ?? "unreadable"
				} during execution — a committed in-worktree change escapes the diff-scope gate; rejecting fail-closed.`;
			}
		}

		const decision: PolicyDecision | null = integrityFailed
			? {
					kind: "acceptance.contract",
					outcome: "rejected",
					reasons: [
						candidateIntegrityFailure ?? "acceptance integrity failed.",
					],
				}
			: policy.evaluateAcceptanceContract(acceptanceContract, {
					changedFiles,
					checkResults,
				});

		let acceptanceEventId: string | undefined;
		const diffScope = integrityFailed
			? { status: "blocked" as const, outOfScopeFiles: [] }
			: (policy.evaluateAcceptanceDiffScope?.(
					changedFiles,
					acceptanceContract,
				) ?? { status: "passed" as const, outOfScopeFiles: [] });
		if (acceptancePort) {
			const record: AcceptanceRecordInput = {
				runId: input.runId,
				admissionEventId: input.currentPacket.provenance_ref,
				outcome: decision ? "rejected" : "passed",
				diffScopeStatus: diffScope.status,
				outOfScopeFiles: diffScope.outOfScopeFiles,
				checkResults,
				evaluatedAt: new Date().toISOString(),
			};
			const recorded = await acceptancePort.recordAcceptance(record);
			acceptanceEventId = typeof recorded === "string" ? recorded : undefined;
		}

		let candidateAcceptance: CandidateAcceptanceRecord | undefined;
		if (input.candidate) {
			if (!candidateEvidencePort) {
				throw new CandidatePromotionValidationError(
					"Candidate acceptance requires a signed candidate evidence port.",
				);
			}
			const evidenceInput: CandidateAcceptanceEvidenceInput = {
				runId: input.runId,
				candidate: input.candidate,
				outcome: decision ? "rejected" : "passed",
				...(boundAcceptanceContractDigest
					? { acceptanceContractDigest: boundAcceptanceContractDigest }
					: {}),
				diffScopeStatus: diffScope.status,
				outOfScopeFiles: diffScope.outOfScopeFiles,
				checkResults,
				evaluatedAt: new Date().toISOString(),
				...(acceptanceEventId ? { acceptanceEventId } : {}),
			};
			candidateAcceptance = normalizeCandidateAcceptanceRecord(
				await candidateEvidencePort.recordCandidateAcceptance(evidenceInput),
				input.candidate,
				decision ? "rejected" : "passed",
				boundAcceptanceContractDigest,
			);
		}

		storage.recordAcceptanceShadow(
			input.runId,
			decision ? "rejected" : "passed",
		);

		return {
			decision,
			...(acceptanceEventId ? { acceptanceEventId } : {}),
			...(candidateAcceptance ? { candidateAcceptance } : {}),
		};
	}

	function createRunAdmissionDigest(
		value: JsonRecord | readonly JsonRecord[],
	): string {
		return `sha256:${createHash("sha256")
			.update(JSON.stringify(value))
			.digest("hex")}`;
	}

	function uniqueStrings(values: readonly string[]): readonly string[] {
		return Array.from(new Set(values));
	}

	function collectDeclaredScopeAllowedPaths(
		validatedPacket: UnitPacket,
	): readonly string[] {
		return uniqueStrings([
			...validatedPacket.unit.expectedOutputs,
			...validatedPacket.verification.requiredOutputs,
		]);
	}

	function deriveRunAdmissionRequestedSideEffects(
		validatedPacket: UnitPacket,
	): readonly string[] {
		const requestedSideEffects = ["fs.read:repo"];
		if (collectDeclaredScopeAllowedPaths(validatedPacket).length > 0) {
			requestedSideEffects.push("fs.write:declared_scope");
		}
		if (validatedPacket.execution !== undefined) {
			requestedSideEffects.push("command.execute:verification");
		}
		return uniqueStrings(requestedSideEffects);
	}

	function createRunAdmissionEvidenceInputs(ctx: {
		run: Run;
		validatedPacket: UnitPacket;
		workspace: WorkspaceSnapshot;
		worktreeClean: boolean;
	}): readonly RunAdmissionEvidenceInput[] {
		const scope = {
			allowed_paths: collectDeclaredScopeAllowedPaths(ctx.validatedPacket),
			network_allowed: false,
		};
		return [
			{
				kind: "git.status",
				ref: `workspace://${ctx.run.id}/git-status-preflight`,
				digest: createRunAdmissionDigest({
					run_id: ctx.run.id,
					worktree_path: ctx.workspace.path,
					status: ctx.worktreeClean ? "clean" : "dirty",
				}),
				required: true,
				status: "present",
			},
			{
				kind: "git.rev-parse",
				ref: `workspace://${ctx.run.id}/rev-parse-head`,
				digest: createRunAdmissionDigest({
					run_id: ctx.run.id,
					head_commit: ctx.workspace.headSha,
				}),
				required: true,
				status: "present",
			},
			{
				kind: "declared_scope",
				ref: `workspace://${ctx.run.id}/declared-scope`,
				digest: createRunAdmissionDigest(scope),
				required: true,
				status: "present",
			},
		];
	}

	function createRunAdmissionReceiptInput(ctx: {
		run: Run;
		validatedPacket: UnitPacket;
		workspace: WorkspaceSnapshot;
		projectRoot: string;
	}): CreateRunAdmissionReceiptDryRunInput {
		const { run, validatedPacket, workspace: preparedWorkspace } = ctx;
		const worktreeClean = workspace.checkWorktreeClean(preparedWorkspace.path);
		const declaredScope = {
			allowed_paths: collectDeclaredScopeAllowedPaths(validatedPacket),
			network_allowed: false,
		};
		const requestedSideEffects =
			deriveRunAdmissionRequestedSideEffects(validatedPacket);
		return {
			receiptId: `run_admission_${run.id}`,
			decidedAt: new Date().toISOString(),
			run: {
				run_id: run.id,
				unit_id: validatedPacket.unit.id,
				unit_kind: validatedPacket.unit.kind,
				unit_scope: validatedPacket.unit.scope,
				policy_profile: validatedPacket.unit.policyProfile,
				verification_contract: validatedPacket.unit.verificationContract,
				provenance_ref: validatedPacket.provenance_ref,
			} satisfies JsonRecord,
			repo: {
				path: ctx.projectRoot,
				worktree_path: preparedWorkspace.path,
				expected_remote: "local-first",
				base_ref: "HEAD",
				base_commit: preparedWorkspace.headSha,
				head_commit: preparedWorkspace.headSha,
				worktree_clean: worktreeClean,
			},
			request: {
				requested_capabilities: requestedSideEffects,
				requested_side_effects: requestedSideEffects,
				declared_scope: declaredScope,
			},
			policyProfileId: validatedPacket.unit.policyProfile,
			evidenceInputs: createRunAdmissionEvidenceInputs({
				run,
				validatedPacket,
				workspace: preparedWorkspace,
				worktreeClean,
			}),
			actor: "kernel.orchestrator",
			source: "run-loop",
			host: "kernel",
		};
	}

	function admissionDeniedFailure(
		record: RunAdmissionReceiptAttemptRecord,
	): RunInfrastructureFailure {
		return {
			kind: "run-admission-denied",
			message: `Run admission ${record.payload.decision}: ${[
				...record.payload.missing_evidence,
				...record.payload.unsafe_requests,
			].join(" ")}`,
		};
	}

	function finalizeAdmissionRecordingFailure(
		ctx: {
			run: Run;
			workspace: WorkspaceSnapshot;
		},
		error: unknown,
	): RunPacketResult {
		return finalizeInfrastructureFailure(
			ctx.run,
			infrastructureFailure("run-admission-record-failed", error),
			{
				workspace: ctx.workspace,
				workspaceStatus: "retained",
			},
		);
	}

	function finalizeAdmissionStoreUnavailable(ctx: {
		run: Run;
		workspace: WorkspaceSnapshot;
	}): RunPacketResult {
		return finalizeInfrastructureFailure(
			ctx.run,
			infrastructureFailure(
				"run-admission-store-unavailable",
				"Run admission evidence store is required before live worker execution.",
			),
			{
				workspace: ctx.workspace,
				workspaceStatus: "retained",
			},
		);
	}

	function admitPreparedRunSync(ctx: {
		run: Run;
		validatedPacket: UnitPacket;
		workspace: WorkspaceSnapshot;
		projectRoot: string;
	}): { ok: true } | { ok: false; result: RunPacketResult } {
		if (!admissionStore) {
			return {
				ok: false,
				result: finalizeAdmissionStoreUnavailable(ctx),
			};
		}
		try {
			const receipt = createRunAdmissionReceiptLive(
				createRunAdmissionReceiptInput(ctx),
			);
			const record = recordRunAdmissionReceiptAttemptSync({
				receipt,
				store: admissionStore,
			});
			if (
				record.payload.decision !== "PASS" ||
				record.payload.will_execute_worker !== true
			) {
				return {
					ok: false,
					result: finalizeInfrastructureFailure(
						ctx.run,
						admissionDeniedFailure(record),
						{
							workspace: ctx.workspace,
							workspaceStatus: "retained",
						},
					),
				};
			}
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				result: finalizeAdmissionRecordingFailure(ctx, error),
			};
		}
	}

	async function admitPreparedRunAsync(ctx: {
		run: Run;
		validatedPacket: UnitPacket;
		workspace: WorkspaceSnapshot;
		projectRoot: string;
	}): Promise<{ ok: true } | { ok: false; result: RunPacketResult }> {
		if (!admissionStore) {
			return {
				ok: false,
				result: finalizeAdmissionStoreUnavailable(ctx),
			};
		}
		try {
			const provenanceRef = ctx.validatedPacket.provenance_ref;
			if (provenanceRef) {
				const eventsDbPath = resolve(
					ctx.projectRoot,
					".buildplane",
					"ledger",
					"events.db",
				);
				let admitted: AdmittedPlanRecord | undefined;
				try {
					admitted = await admittedPlanReader.read(eventsDbPath, provenanceRef);
				} catch (err) {
					return {
						ok: false,
						result: finalizeInfrastructureFailure(
							ctx.run,
							infrastructureFailure(
								"plan-not-admitted",
								`plan_admitted tape read failed for provenance_ref "${provenanceRef}": ${String(err)}`,
							),
							{ workspace: ctx.workspace, workspaceStatus: "retained" },
						),
					};
				}
				if (
					!admitted?.signedByKernel ||
					admitted.authorizedNextStep !== PLAN_ADMITTED_AUTHORIZED_NEXT_STEP
				) {
					return {
						ok: false,
						result: finalizeInfrastructureFailure(
							ctx.run,
							infrastructureFailure(
								"plan-not-admitted",
								`No signed plan_admitted authorizing dispatch found on the tape for provenance_ref "${provenanceRef}".`,
							),
							{ workspace: ctx.workspace, workspaceStatus: "retained" },
						),
					};
				}
			}
			const receipt = createRunAdmissionReceiptLive(
				createRunAdmissionReceiptInput(ctx),
			);
			const record = await recordRunAdmissionReceiptAttempt({
				receipt,
				store: admissionStore,
			});
			if (
				record.payload.decision !== "PASS" ||
				record.payload.will_execute_worker !== true
			) {
				return {
					ok: false,
					result: finalizeInfrastructureFailure(
						ctx.run,
						admissionDeniedFailure(record),
						{
							workspace: ctx.workspace,
							workspaceStatus: "retained",
						},
					),
				};
			}
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				result: finalizeAdmissionRecordingFailure(ctx, error),
			};
		}
	}

	function buildStrategyProcedureCandidate(
		strategy: StrategyPacket,
		strategyResult: StrategyResult,
		workflowLearning: {
			readonly kind: string;
			readonly title: string;
			readonly body: string;
		},
	): Parameters<BuildplaneStoragePort["createProcedure"]>[0] | null {
		if (strategyResult.outcome !== "passed") {
			return null;
		}

		const implementer = strategy.children.find(
			(child) => child.role === "implementer",
		);
		const taskType = implementer?.packet.intent?.taskType;
		if (!implementer || !taskType) {
			return null;
		}

		return {
			name: `${strategy.mode} workflow for ${taskType} tasks`,
			taskType,
			bodyMarkdown: `Use an ${strategy.mode} workflow for ${taskType} tasks.\n\nObserved learning: ${workflowLearning.body}`,
			metadata: {
				promotionRule: strategyWorkflowPromotionRule,
				strategyMode: strategy.mode,
				sourceLearningTitle: workflowLearning.title,
				sourceLearningKind: workflowLearning.kind,
				sourceStrategyId: strategy.id,
			},
			createdBy: "worker",
			sourceRunId: strategyResult.winnerRunId,
			sourceTaskId: implementer.packet.unit.id,
		};
	}

	function promoteStrategyWorkflowProcedure(
		strategy: StrategyPacket,
		strategyResult: StrategyResult,
		learnings: readonly {
			readonly kind: string;
			readonly title: string;
			readonly body: string;
		}[],
	): void {
		const workflowLearning = learnings.find(
			(learning) => learning.kind === "workflow",
		);
		if (!workflowLearning) {
			return;
		}

		const candidate = buildStrategyProcedureCandidate(
			strategy,
			strategyResult,
			workflowLearning,
		);
		if (!candidate?.taskType) {
			return;
		}

		storage.upsertProcedure(candidate, {
			matchMetadata: {
				promotionRule: strategyWorkflowPromotionRule,
				strategyMode: strategy.mode,
			},
			skipIfConflictingActiveName: true,
		});
	}

	function finalizeInfrastructureFailure(
		run: Run,
		failure: RunInfrastructureFailure,
		options?: {
			receipt?: ExecutionReceipt;
			decision?: PolicyDecision;
			workspace?: WorkspaceSnapshot;
			workspaceStatus?: "retained";
		},
	): RunPacketResult {
		try {
			const failedRun = storage.commitRunFailureOutcome(
				run.id,
				options?.workspaceStatus === "retained"
					? {
							infrastructureFailure: failure,
							workspaceStatus: "retained",
						}
					: {
							infrastructureFailure: failure,
						},
			);

			return {
				run: failedRun,
				receipt: options?.receipt,
				decision: options?.decision,
				failure,
				workspace:
					options?.workspaceStatus === "retained" && options.workspace
						? {
								...options.workspace,
								status: "retained",
							}
						: undefined,
			};
		} catch (finalizationError) {
			return {
				run: {
					id: run.id,
					unitId: run.unitId,
					status: "failed",
				},
				receipt: options?.receipt,
				decision: options?.decision,
				failure: infrastructureFailure(
					"run-failure-finalization-failed",
					finalizationError,
				),
			};
		}
	}

	type PrepareRunResult =
		| {
				ok: true;
				ctx: {
					run: Run;
					validatedPacket: UnitPacket;
					workspace: WorkspaceSnapshot;
					projectRoot: string;
				};
		  }
		| { ok: false; result: RunPacketResult };

	function prepareRun(
		packet: UnitPacket,
		runOptions?: RunPacketOptions,
	): PrepareRunResult {
		storage.getStatusSnapshot();

		const validatedPacket = validatePacketForWorkspaceRoot(
			packet,
			join(projectRoot, ".buildplane", "workspaces", "future-run-id"),
		);
		// Outcome-driven routing producer (opt-in, default OFF). Fills
		// routingHints.preferredWorker from run_outcomes scores. Must run before
		// createRun so the persisted unit_snapshot equals the executed route, and
		// the recorder reads the same routedPacket — recorded route == actual route.
		// V1 threads no per-run seed (exploreSeed undefined); cold-start rotation
		// guarantees coverage without ε.
		const routedPacket = fillRoutingHints(
			validatedPacket,
			storage,
			outcomeRouting,
			Date.now(),
		);
		const { headSha: targetHeadSha } =
			workspace.assertRunnableRepository(projectRoot);
		const headSha = runOptions?.workspaceBaseSha ?? targetHeadSha;
		const run = storage.createRun(routedPacket, runOptions);
		if (runOptions?.governedDispatch) {
			try {
				validateGovernedDispatchLineageV3(
					routedPacket,
					runOptions.governedDispatch,
					{
						expectedRunId: run.id,
						expectedBaseSha: headSha,
					},
				);
			} catch (error) {
				return {
					ok: false,
					result: finalizeInfrastructureFailure(
						run,
						infrastructureFailure("governed-dispatch-lineage-invalid", error),
					),
				};
			}
		}

		let preparedWorkspace: WorkspaceSnapshot;

		try {
			const createdWorkspace = workspace.prepareWorkspace(
				projectRoot,
				run.id,
				headSha,
			);
			preparedWorkspace = toWorkspaceSnapshot(run, createdWorkspace);
		} catch (error) {
			const failure = infrastructureFailure("workspace-prepare-failed", error);
			return { ok: false, result: finalizeInfrastructureFailure(run, failure) };
		}

		if (provisionDeps) {
			try {
				provisionDeps(preparedWorkspace.path);
			} catch (error) {
				// The worktree exists but its dependencies could not be provisioned.
				// Retain it so the operator can inspect the failed state; do not
				// record the workspace row or proceed to admission/execution — a run
				// whose acceptance checks cannot execute must never reach the gate.
				const failure = infrastructureFailure(
					"workspace-provision-failed",
					error,
				);
				return {
					ok: false,
					result: finalizeInfrastructureFailure(run, failure, {
						workspace: preparedWorkspace,
						workspaceStatus: "retained",
					}),
				};
			}
		}

		try {
			storage.recordWorkspacePrepared(run.id, {
				path: preparedWorkspace.path,
				headSha: preparedWorkspace.headSha,
				sourceProjectRoot: projectRoot,
			});
		} catch (error) {
			let cleanupDetail: string | undefined;
			try {
				const cleanupResult = workspace.deleteWorkspace({
					path: preparedWorkspace.path,
					projectRoot,
				});
				if (!cleanupResult.deleted) {
					cleanupDetail =
						cleanupResult.cleanupError ?? "workspace cleanup failed";
				}
			} catch (cleanupError) {
				cleanupDetail =
					cleanupError instanceof Error
						? cleanupError.message
						: String(cleanupError);
			}

			const failure = infrastructureFailure(
				"workspace-persistence-failed",
				cleanupDetail
					? `${error instanceof Error ? error.message : String(error)}; cleanup also failed: ${cleanupDetail}`
					: error,
			);
			return { ok: false, result: finalizeInfrastructureFailure(run, failure) };
		}

		try {
			storage.markRunRunning(run.id);
		} catch (error) {
			const failure = infrastructureFailure("run-start-failed", error);
			return {
				ok: false,
				result: finalizeInfrastructureFailure(run, failure, {
					workspace: preparedWorkspace,
					workspaceStatus: "retained",
				}),
			};
		}

		return {
			ok: true,
			ctx: {
				run,
				validatedPacket: routedPacket,
				workspace: preparedWorkspace,
				projectRoot,
			},
		};
	}

	function recordModelOutcome(
		ctx: { run: Run; validatedPacket: UnitPacket },
		success: boolean,
	): void {
		const packet = ctx.validatedPacket;
		if (packet.model === undefined) {
			return;
		}
		try {
			storage.appendRunOutcome({
				taskType: packet.intent?.taskType ?? packet.unit.kind,
				worker: packet.routingHints?.preferredWorker ?? "sdk",
				success,
				sourceRunId: ctx.run.id,
			});
		} catch {
			// Silent — a write-only memory row must never break run finalization.
		}
	}

	function finalizeRun(
		ctx: {
			run: Run;
			validatedPacket: UnitPacket;
			workspace: WorkspaceSnapshot;
			attemptCount?: number;
		},
		receipt: ExecutionReceipt,
		preEvaluatedDecision?: PolicyDecision,
		runOptions?: RunPacketOptions,
		frozenCandidate?: WorkspaceCandidateArtifact,
		candidateAcceptance?: CandidateAcceptanceRecord,
	): RunPacketResult {
		const {
			run,
			validatedPacket,
			workspace: preparedWorkspace,
			attemptCount,
		} = ctx;

		if (!preEvaluatedDecision) {
			try {
				storage.recordExecutionEvidence(run.id, receipt);
			} catch (error) {
				const failure = infrastructureFailure(
					"execution-evidence-persistence-failed",
					error,
				);
				return finalizeInfrastructureFailure(run, failure, {
					receipt,
					workspace: preparedWorkspace,
					workspaceStatus: "retained",
				});
			}
		}

		let decision: PolicyDecision;
		if (preEvaluatedDecision) {
			decision = preEvaluatedDecision;
		} else {
			try {
				decision = policy.evaluateRun(validatedPacket, receipt);
			} catch (error) {
				const failure = infrastructureFailure(
					"policy-evaluation-failed",
					error,
				);
				return finalizeInfrastructureFailure(run, failure, {
					receipt,
					workspace: preparedWorkspace,
					workspaceStatus: "retained",
				});
			}
		}

		if (decision.outcome === "rejected" || decision.outcome === "retrying") {
			const rejectedDecision =
				decision.outcome === "rejected"
					? decision
					: {
							kind: "reject-run" as const,
							outcome: "rejected" as const,
							reasons: decision.reasons,
						};
			try {
				const failedRun = storage.commitRunFailureOutcome(run.id, {
					decision: rejectedDecision,
					workspaceStatus: "retained",
				});

				// Extract constraint learnings from rejection — silent (rejected outcome only, not retrying)
				if (memoryPort && decision.outcome === "rejected") {
					try {
						const learnings = extractLearnings({
							run: failedRun,
							receipt,
							decision: rejectedDecision,
							packet: validatedPacket,
							attemptCount,
						});
						if (learnings.length > 0) {
							memoryPort.writeLearnings(failedRun.id, learnings);
						}
						memoryPort.promoteLearnings(failedRun.id);
					} catch {
						// Silent
					}
				}

				// retrying is not a terminal quality signal — record only a true
				// rejection (mirrors the rejected-only learnings guard above).
				if (decision.outcome === "rejected") {
					recordModelOutcome(ctx, false);
				}

				return {
					run: failedRun,
					receipt,
					decision: rejectedDecision,
					workspace: {
						...preparedWorkspace,
						status: "retained",
					},
				};
			} catch (error) {
				return {
					run: {
						id: run.id,
						unitId: run.unitId,
						status: "failed",
					},
					receipt,
					decision: rejectedDecision,
					failure: infrastructureFailure(
						"run-failure-finalization-failed",
						error,
					),
				};
			}
		}

		// At this point decision.outcome === "approved"
		const approvedDecision =
			decision as import("./run-loop.js").ApprovedPolicyDecision;
		// An ambient/programmatic run may still be useful for local diagnostics,
		// but it is not authorization to mutate the target branch. Only the
		// explicitly named unsafe raw lane retains the legacy auto-merge behavior;
		// every omitted or legacy lane defaults to discard after evidence capture.
		const finalizationMode =
			runOptions?.finalizationMode ??
			(runOptions?.trustLane === "unsafe" ? "auto-merge" : "discard");

		if (finalizationMode === "create-candidate") {
			const governedCandidate =
				runOptions?.candidateGovernance !== undefined ||
				runOptions?.governedDispatch !== undefined;
			if (governedCandidate && !frozenCandidate) {
				return finalizeInfrastructureFailure(
					run,
					infrastructureFailure(
						"candidate-finalization-order-invalid",
						"Governed candidate finalization requires a candidate frozen before deterministic acceptance.",
					),
					{
						receipt,
						decision,
						workspace: preparedWorkspace,
						workspaceStatus: "retained",
					},
				);
			}
			if (governedCandidate && !candidateAcceptance) {
				return finalizeInfrastructureFailure(
					run,
					infrastructureFailure(
						"candidate-acceptance-unavailable",
						"Governed candidate finalization requires deterministic acceptance recorded against the frozen candidate.",
					),
					{
						receipt,
						decision,
						workspace: preparedWorkspace,
						workspaceStatus: "retained",
					},
				);
			}
			const candidateIdentity = runOptions?.candidateIdentity;
			const governedDispatchV3 = runOptions?.governedDispatch;
			if (
				!candidateIdentity ||
				!storage.commitRunCandidateOutcome ||
				(!governedDispatchV3 && !workspace.createWorkspaceCandidate) ||
				(governedDispatchV3 && !workspace.createGovernedWorkspaceCandidate)
			) {
				return finalizeInfrastructureFailure(
					run,
					infrastructureFailure(
						"candidate-finalization-unavailable",
						"Immutable candidate finalization requires candidate-capable workspace and storage ports plus a candidate identity.",
					),
					{
						receipt,
						decision,
						workspace: preparedWorkspace,
						workspaceStatus: "retained",
					},
				);
			}

			try {
				let candidate: WorkspaceCandidateArtifact;
				if (frozenCandidate) {
					candidate = frozenCandidate;
				} else {
					const createWorkspaceCandidate = workspace.createWorkspaceCandidate;
					if (!createWorkspaceCandidate) {
						throw new CandidatePromotionValidationError(
							"Immutable candidate finalization requires a candidate-capable workspace adapter.",
						);
					}
					candidate = createWorkspaceCandidate({
						candidateId: candidateIdentity.candidateId,
						runId: run.id,
						attempt: candidateIdentity.attempt,
						path: preparedWorkspace.path,
						baseSha: preparedWorkspace.headSha,
						projectRoot,
					});
				}
				const completedRun = storage.commitRunCandidateOutcome(run.id, {
					decision: approvedDecision,
					candidate: candidateProjectionForFinalization(
						candidate,
						validatedPacket,
						runOptions?.candidateGovernance,
						runOptions?.governedDispatch,
					),
				});
				recordModelOutcome(ctx, true);
				return {
					run: completedRun,
					receipt,
					decision,
					candidate,
					...(candidateAcceptance ? { candidateAcceptance } : {}),
					workspace: {
						...preparedWorkspace,
						status: "retained",
					},
				};
			} catch (error) {
				return finalizeInfrastructureFailure(
					run,
					infrastructureFailure("candidate-finalization-failed", error),
					{
						receipt,
						decision,
						workspace: preparedWorkspace,
						workspaceStatus: "retained",
					},
				);
			}
		}

		// Merge workspace changes first — if this fails we must not mark the run as passed
		// and must retain the workspace so changes are not lost.
		let mergedHeadSha: string | undefined;
		if (
			finalizationMode === "auto-merge" &&
			workspace.commitAndMergeWorkspace
		) {
			try {
				const mergeResult = workspace.commitAndMergeWorkspace({
					path: preparedWorkspace.path,
					runId: run.id,
					projectRoot,
				});
				mergedHeadSha = mergeResult.mergedHeadSha;
			} catch (error) {
				return finalizeInfrastructureFailure(
					run,
					infrastructureFailure("merge-failed", error),
					{
						receipt,
						decision,
						workspace: preparedWorkspace,
						workspaceStatus: "retained",
					},
				);
			}
		}

		let completedRun: Run;
		try {
			completedRun = storage.commitRunSuccessOutcome(run.id, approvedDecision);
		} catch (error) {
			const failure = infrastructureFailure(
				"run-success-persistence-failed",
				error,
			);
			return finalizeInfrastructureFailure(run, failure, {
				receipt,
				decision,
				workspace: preparedWorkspace,
				workspaceStatus: "retained",
			});
		}

		recordModelOutcome(ctx, true);

		// Extract and persist learnings — silent, never breaks the run
		if (memoryPort) {
			try {
				const learnings = extractLearnings({
					run: completedRun,
					receipt,
					decision: approvedDecision,
					packet: validatedPacket,
					attemptCount,
				});
				if (learnings.length > 0) {
					memoryPort.writeLearnings(completedRun.id, learnings);
				}
				memoryPort.promoteLearnings(completedRun.id);
			} catch {
				// Silent — follows event bus subscriber convention
			}
		}

		let cleanupResult: { deleted: boolean; cleanupError?: string };
		try {
			cleanupResult = workspace.deleteWorkspace({
				path: preparedWorkspace.path,
				projectRoot,
			});
		} catch (error) {
			cleanupResult = {
				deleted: false,
				cleanupError: error instanceof Error ? error.message : String(error),
			};
		}
		if (!cleanupResult.deleted) {
			const cleanupError =
				cleanupResult.cleanupError ?? "workspace cleanup failed";
			try {
				storage.recordWorkspaceCleanupFailed(run.id, cleanupError);
			} catch (error) {
				return {
					run: completedRun,
					receipt,
					decision,
					failure: infrastructureFailure(
						"workspace-cleanup-persistence-failed",
						error,
					),
					workspace: {
						...preparedWorkspace,
						status: "cleanup-failed",
						cleanupError,
					},
				};
			}

			return {
				run: completedRun,
				receipt,
				decision,
				workspace: {
					...preparedWorkspace,
					status: "cleanup-failed",
					cleanupError,
				},
			};
		}

		try {
			storage.recordWorkspaceDeleted(run.id);
		} catch (error) {
			return {
				run: completedRun,
				receipt,
				decision,
				failure: infrastructureFailure(
					"workspace-delete-persistence-failed",
					error,
				),
				workspace: preparedWorkspace,
			};
		}

		return {
			run: completedRun,
			receipt,
			decision,
			mergedHeadSha,
		};
	}

	const orchestrator: BuildplaneOrchestrator = {
		initializeProject() {
			return storage.initializeProject();
		},
		runPacket(packet, eventBus?, createRunOptions?) {
			createRunOptions = normalizeRunPacketOptions(packet, createRunOptions);
			const bus = eventBus ?? defaultBus;
			const prepared = prepareRun(packet, createRunOptions);
			if (!prepared.ok) return prepared.result;
			const { ctx } = prepared;
			if (createRunOptions?.trustLane !== "unsafe") {
				const admitted = admitPreparedRunSync(ctx);
				if (admitted.ok === false) return admitted.result;
			}

			// Candidate finalization needs async signed acceptance/review evidence and
			// must freeze the worktree before deterministic checks. The synchronous
			// legacy API cannot uphold that transaction, so it must never silently
			// fall through to finalizeRun's auto-merge default.
			if (createRunOptions?.finalizationMode === "create-candidate") {
				return finalizeInfrastructureFailure(
					ctx.run,
					infrastructureFailure(
						"governed-candidate-async-required",
						"Immutable candidate finalization requires runPacketAsync so the candidate can be frozen and its evidence recorded before completion.",
					),
					{
						workspace: ctx.workspace,
						workspaceStatus: "retained",
					},
				);
			}

			const profileName = ctx.validatedPacket.unit.policyProfile;
			let resolvedProfile: PolicyProfile | undefined;
			if (profileRegistry && profileName) {
				try {
					resolvedProfile = profileRegistry.resolve(profileName);
				} catch (error) {
					return finalizeInfrastructureFailure(
						ctx.run,
						infrastructureFailure("profile-resolution-failed", error),
						{
							workspace: ctx.workspace,
							workspaceStatus: "retained",
						},
					);
				}
			}

			bus.emit({
				kind: "execution-started",
				runId: ctx.run.id,
				timestamp: new Date().toISOString(),
				executionType: "command",
			});

			let receipt: ExecutionReceipt;
			try {
				receipt = runtime.executePacket(
					ctx.validatedPacket,
					ctx.workspace.path,
				);
				receipt = {
					...receipt,
					changedFiles: collectWorkspaceChangedFiles(ctx.workspace.path),
				};
			} catch (error) {
				bus.emit({
					kind: "execution-error",
					runId: ctx.run.id,
					timestamp: new Date().toISOString(),
					message: error instanceof Error ? error.message : String(error),
					phase: "execution",
				});
				const failure = infrastructureFailure(
					"runtime-execution-failed",
					error,
				);
				return finalizeInfrastructureFailure(ctx.run, failure, {
					workspace: ctx.workspace,
					workspaceStatus: "retained",
				});
			}

			bus.emit({
				kind: "command-execution-complete",
				runId: ctx.run.id,
				timestamp: new Date().toISOString(),
				exitCode: receipt.exitCode,
				outputChecks: receipt.outputChecks.map((c) => ({
					path: c.path,
					exists: c.exists,
				})),
			});

			const acceptanceDecision = evaluateAcceptanceBeforeFinalization({
				resolvedProfile,
				workspacePath: ctx.workspace.path,
				currentPacket: ctx.validatedPacket,
				currentReceipt: receipt,
				attemptCount: 0,
			});
			if (acceptanceDecision) {
				try {
					storage.recordExecutionEvidence(ctx.run.id, receipt);
				} catch (error) {
					return finalizeInfrastructureFailure(
						ctx.run,
						infrastructureFailure(
							"execution-evidence-persistence-failed",
							error,
						),
						{
							receipt,
							workspace: ctx.workspace,
							workspaceStatus: "retained",
						},
					);
				}
				return finalizeRun(
					{ ...ctx, attemptCount: 0 },
					receipt,
					acceptanceDecision,
					createRunOptions,
				);
			}

			return finalizeRun(ctx, receipt, undefined, createRunOptions);
		},
		async runPacketAsync(packet, eventBus?, createRunOptions?) {
			createRunOptions = normalizeRunPacketOptions(packet, createRunOptions);
			const bus = eventBus ?? defaultBus;
			const emitResultReady =
				(createRunOptions?.finalizationMode ??
					(createRunOptions?.trustLane === "unsafe"
						? "auto-merge"
						: "discard")) === "auto-merge" &&
				createRunOptions?.trustLane !== "unsafe";

			// Resolve policy profile from registry
			const profileName = packet.unit.policyProfile;
			let resolvedProfile: PolicyProfile | undefined;
			if (profileRegistry && profileName) {
				try {
					resolvedProfile = profileRegistry.resolve(profileName);
				} catch (error) {
					// Unknown profile — fail the run without workspace preparation
					const failure = infrastructureFailure(
						"profile-resolution-failed",
						error,
					);
					try {
						const validatedPacket = validatePacketForWorkspaceRoot(
							packet,
							join(projectRoot, ".buildplane", "workspaces", "future-run-id"),
						);
						const run = storage.createRun(validatedPacket, createRunOptions);
						return finalizeInfrastructureFailure(run, failure);
					} catch {
						return {
							run: {
								id: "profile-error",
								unitId: packet.unit.id,
								status: "failed" as const,
							},
							failure,
						};
					}
				}
			}

			// Operator suspension gate — check before workspace preparation
			if (resolvedProfile?.trustGates?.requiresApproval === true) {
				const validatedPacket = validatePacketForWorkspaceRoot(
					packet,
					join(projectRoot, ".buildplane", "workspaces", "future-run-id"),
				);
				const run = storage.createRun(validatedPacket, createRunOptions);
				storage.markRunRunning(run.id);
				const suspendedRun = storage.suspendRun(run.id);
				bus.emit({
					kind: "run-suspended",
					runId: run.id,
					unitId: packet.unit.id,
					timestamp: new Date().toISOString(),
					profileName: resolvedProfile.name,
					reason: "policy profile requires operator approval before execution",
				});
				return { run: suspendedRun, suspended: true } as RunPacketResult;
			}

			const prepared = prepareRun(packet, createRunOptions);
			if (!prepared.ok) {
				// Emit a visible event when workspace preparation fails
				if (prepared.result.failure?.kind === "workspace-prepare-failed") {
					bus.emit({
						kind: "execution-error",
						runId: prepared.result.run.id,
						timestamp: new Date().toISOString(),
						message: prepared.result.failure.message,
						phase: "workspace-prepare",
					});
				}
				return prepared.result;
			}
			const { ctx } = prepared;
			if (createRunOptions?.trustLane !== "unsafe") {
				const admitted = await admitPreparedRunAsync(ctx);
				if (admitted.ok === false) return admitted.result;
			}

			const runContext: EventContext = {
				runId: ctx.run.id,
				executor:
					ctx.validatedPacket.routingHints?.preferredWorker ??
					(ctx.validatedPacket.model ? "ai-sdk" : "command"),
			};
			const scopedBus = createRunScopedBus(runContext, bus);

			// Budget enforcement: count tokens mid-stream and abort if limit exceeded
			const effectiveBudgets = resolvedProfile?.budgets ?? topLevelBudgets;
			const abortController = new AbortController();
			let budgetUnsubscribe: (() => void) | undefined;
			/** Accumulates only port-issued receipts for all worker attempts. */
			const governedActionReceipts: DurableActionReceiptReferenceV2[] = [];

			if (effectiveBudgets && policy.evaluateBudgets) {
				const runStartTime = Date.now();
				let tokenCount = 0;
				let budgetBreached = false;

				budgetUnsubscribe = scopedBus.subscribe((event) => {
					if (budgetBreached || abortController.signal.aborted) return;
					if (event.kind !== "model-token-delta") return;
					if (event.runId !== ctx.run.id) return;

					tokenCount++;
					const elapsedMs = Date.now() - runStartTime;
					const usage = {
						promptTokens: 0,
						completionTokens: tokenCount,
						totalTokens: tokenCount,
						elapsedMs,
					};

					const decision = policy.evaluateBudgets?.(
						ctx.validatedPacket,
						usage,
						effectiveBudgets,
					);
					if (decision) {
						budgetBreached = true;
						const isTokensBreach =
							effectiveBudgets.maxTokens !== undefined &&
							tokenCount > effectiveBudgets.maxTokens;
						const budgetType: "tokens" | "time" = isTokensBreach
							? "tokens"
							: "time";
						const limit = isTokensBreach
							? (effectiveBudgets.maxTokens ?? 0)
							: (effectiveBudgets.maxComputeTimeMs ?? 0);
						const actual = isTokensBreach ? tokenCount : elapsedMs;
						scopedBus.emit({
							kind: "policy-budget-breached",
							runId: ctx.run.id,
							timestamp: new Date().toISOString(),
							budgetType,
							limit,
							actual,
						});
						abortController.abort();
					}
				});
			}

			async function executeOnce(p: UnitPacket): Promise<ExecutionReceipt> {
				const activityType = p.model
					? ("model" as const)
					: ("command" as const);
				scopedBus.emit({
					kind: "execution-started",
					runId: ctx.run.id,
					timestamp: new Date().toISOString(),
					executionType: activityType,
				});
				const activityId = randomUUID();
				if (ledgerActivityPort) {
					// write-ahead: resolves only once activity_started is durable on the tape
					await ledgerActivityPort.activityStarted({
						runId: ctx.run.id,
						activityId,
						activityType,
						input: activityInputDescriptor(p),
					});
				}
				let r: ExecutionReceipt;
				const governedDispatch = createRunOptions?.governedDispatch;
				if (createRunOptions?.candidateGovernance || governedDispatch) {
					// NormalizeRunPacketOptions already requires this port before any
					// workspace effect. Keep the local guard too so a future call path
					// cannot degrade governed work to the ambient runtime.
					if (!governedWorkerExecutionPort) {
						throw new CandidatePromotionValidationError(
							"governed candidate execution has no OCI ActionGateway worker port.",
						);
					}
					const workerResult =
						await governedWorkerExecutionPort.executeCandidatePacketAsync({
							runId: ctx.run.id,
							packet: p,
							projectRoot: ctx.workspace.path,
							eventBus: scopedBus,
							signal: abortController.signal,
							...(createRunOptions?.candidateGovernance
								? {
										candidateGovernance: createRunOptions.candidateGovernance,
									}
								: {}),
							...(governedDispatch
								? {
										governedDispatch,
										actionEvidencePort: governedActionEvidencePort,
									}
								: {}),
						});
					if (governedDispatch) {
						if (!isGovernedWorkerExecutionResultV3(workerResult)) {
							throw new CandidatePromotionValidationError(
								"V3 governed worker must return durable action receipt references; a bare execution receipt is not accepted.",
							);
						}
						governedActionReceipts.push(
							...normalizeDurableActionReceiptReferencesV3(
								workerResult.actionReceipts,
							),
						);
						r = workerResult.executionReceipt;
					} else {
						if (isGovernedWorkerExecutionResultV3(workerResult)) {
							throw new CandidatePromotionValidationError(
								"legacy V1 governed execution cannot consume a V3 action-evidence worker result.",
							);
						}
						r = workerResult;
					}
				} else if (runtime.executePacketAsync) {
					r = await runtime.executePacketAsync(
						p,
						ctx.workspace.path,
						scopedBus,
						abortController.signal,
					);
				} else {
					r = runtime.executePacket(p, ctx.workspace.path);
					scopedBus.emit({
						kind: "command-execution-complete",
						runId: ctx.run.id,
						timestamp: new Date().toISOString(),
						exitCode: r.exitCode,
						outputChecks: r.outputChecks.map((c) => ({
							path: c.path,
							exists: c.exists,
						})),
					});
				}
				if (ledgerActivityPort) {
					await ledgerActivityPort.activityCompleted({
						runId: ctx.run.id,
						activityId,
						result: activityResultDescriptor(r),
					});
				}
				return r;
			}

			async function executeOnceWithChangedFiles(
				p: UnitPacket,
			): Promise<ExecutionReceipt> {
				const receipt = await executeOnce(p);
				return {
					...receipt,
					changedFiles: collectWorkspaceChangedFiles(ctx.workspace.path),
				};
			}

			let currentPacket = ctx.validatedPacket;
			let currentReceipt: ExecutionReceipt;

			try {
				currentReceipt = await executeOnceWithChangedFiles(currentPacket);
			} catch (error) {
				budgetUnsubscribe?.();
				const message = error instanceof Error ? error.message : String(error);
				scopedBus.emit({
					kind: "execution-error",
					runId: ctx.run.id,
					timestamp: new Date().toISOString(),
					message,
					phase: "execution",
				});
				return finalizeInfrastructureFailure(
					ctx.run,
					infrastructureFailure("runtime-execution-failed", error),
					{
						workspace: ctx.workspace,
						workspaceStatus: "retained",
					},
				);
			}
			// Retry-aware policy loop — budget subscriber stays active across all attempts
			// so token usage accumulates cumulatively. budgetUnsubscribe is called in the
			// finally block after ALL attempts complete (success, rejection, or error).
			let attemptCount = 0;
			// M6-S7 — the signed `acceptance_recorded` event id from the latest
			// attempt, chained onto a terminal `result_ready` (A1).
			let acceptanceEventId: string | undefined;
			const governedCandidateFinalization =
				createRunOptions?.finalizationMode === "create-candidate" &&
				(createRunOptions.candidateGovernance !== undefined ||
					createRunOptions.governedDispatch !== undefined);
			const governedDispatchV3 = createRunOptions?.governedDispatch;
			try {
				while (true) {
					storage.recordExecutionEvidence(ctx.run.id, currentReceipt);

					if (governedCandidateFinalization) {
						// A governed candidate is frozen only after execution policy selects
						// a terminal advance. Retry/reject decisions never manufacture a
						// candidate, and deterministic acceptance runs only after the ref is
						// immutable.
						const decision = policy.evaluateRun(
							currentPacket,
							currentReceipt,
							resolvedProfile,
							attemptCount,
						);
						scopedBus.emit({
							kind: "policy-decision",
							runId: ctx.run.id,
							timestamp: new Date().toISOString(),
							decisionKind: decision.kind,
							outcome: decision.outcome,
							reasons: decision.reasons,
						});

						if (decision.kind === "retry-run") {
							if (governedDispatchV3) {
								const finalizeGovernedRetryFailure = (
									kind: string,
									message: string,
								) =>
									finalizeInfrastructureFailure(
										ctx.run,
										infrastructureFailure(kind, message),
										{
											receipt: currentReceipt,
											decision,
											workspace: ctx.workspace,
											workspaceStatus: "retained",
										},
									);
								if (!governedRetryContextResolverPort) {
									return finalizeGovernedRetryFailure(
										"governed-v3-retry-context-resolver-unavailable",
										"Governed V3 retry is inactive because no structural retry-context resolver is configured. A resolver response would still require native signature/tape attestation before retry activation.",
									);
								}
								const retryRequest = createGovernedV3RetryRequestV1({
									dispatch: governedDispatchV3,
									nextAttempt: decision.attemptNumber,
									feedbackContext: decision.feedbackContext,
									predecessorActions: governedActionReceipts,
								});
								let untrustedResolution: Awaited<
									ReturnType<
										GovernedV3RetryContextResolverPort["resolveUntrustedAttemptContext"]
									>
								>;
								try {
									untrustedResolution =
										await governedRetryContextResolverPort.resolveUntrustedAttemptContext(
											retryRequest,
										);
								} catch (error) {
									return finalizeGovernedRetryFailure(
										"governed-v3-retry-context-resolver-failed",
										`Governed V3 retry structural context resolver failed: ${
											error instanceof Error ? error.message : String(error)
										}`,
									);
								}
								if (!untrustedResolution) {
									return finalizeGovernedRetryFailure(
										"governed-v3-retry-context-resolver-no-response",
										"Governed V3 retry structural context resolver returned no context for the exact failed dispatch.",
									);
								}
								const retryContextInspection =
									inspectUntrustedGovernedV3RetryContextResolution(
										retryRequest,
										untrustedResolution,
									);
								if (
									retryContextInspection.status !==
									"structurally-consistent-untrusted"
								) {
									return finalizeGovernedRetryFailure(
										`governed-v3-retry-context-structural-${retryContextInspection.status}`,
										retryContextInspection.message,
									);
								}
								// Structural consistency is intentionally insufficient for a
								// second execution. TypeScript has no signature or tape proof
								// that this native-shaped data is authoritative, and the current
								// worker/ActionGateway contract cannot receive a next dispatch,
								// attempt context, or retry namespace. Keep the no-second-worker
								// gate until a native retry-attestation boundary activates it.
								return finalizeGovernedRetryFailure(
									"governed-v3-retry-native-attestation-required",
									"Governed V3 retry received structurally consistent but untrusted context data. It is not native signature/tape proof; a native retry-attestation boundary is required before a next dispatch, retry namespace, or second worker execution can begin.",
								);
							}
							attemptCount = decision.attemptNumber;
							const feedbackSuffix =
								decision.feedbackContext.length > 0
									? `\n\nPrevious attempt failed:\n${decision.feedbackContext.join("\n")}\n\nPlease fix these issues and try again.`
									: "";
							if (currentPacket.model) {
								currentPacket = {
									...currentPacket,
									model: {
										...currentPacket.model,
										systemPrompt:
											(currentPacket.model.systemPrompt ?? "") + feedbackSuffix,
									},
								};
							}
							try {
								currentReceipt =
									await executeOnceWithChangedFiles(currentPacket);
								continue;
							} catch (error) {
								const message =
									error instanceof Error ? error.message : String(error);
								scopedBus.emit({
									kind: "execution-error",
									runId: ctx.run.id,
									timestamp: new Date().toISOString(),
									message,
									phase: "retry-execution",
								});
								return finalizeInfrastructureFailure(
									ctx.run,
									infrastructureFailure("runtime-execution-failed", error),
									{
										workspace: ctx.workspace,
										workspaceStatus: "retained",
									},
								);
							}
						}

						if (decision.outcome !== "approved") {
							return finalizeWithResultReady(
								finalizeRun(
									{ ...ctx, attemptCount },
									currentReceipt,
									decision,
									createRunOptions,
								),
								{
									admissionEventId: currentPacket.provenance_ref,
									acceptanceEventId,
								},
								{ emitResultReady },
							);
						}

						const candidateIdentity = createRunOptions?.candidateIdentity;
						if (
							!candidateIdentity ||
							(!governedDispatchV3 && !workspace.createWorkspaceCandidate) ||
							(governedDispatchV3 &&
								!workspace.createGovernedWorkspaceCandidate)
						) {
							return finalizeWithResultReady(
								finalizeRun(
									{ ...ctx, attemptCount },
									currentReceipt,
									decision,
									createRunOptions,
								),
								{
									admissionEventId: currentPacket.provenance_ref,
									acceptanceEventId,
								},
								{ emitResultReady },
							);
						}

						let frozenCandidate: WorkspaceCandidateArtifact;
						try {
							if (governedDispatchV3) {
								const createGovernedWorkspaceCandidate =
									workspace.createGovernedWorkspaceCandidate;
								const actionEvidencePort = governedActionEvidencePort;
								const activityClaimPort = governedActivityClaimPort;
								if (
									!createGovernedWorkspaceCandidate ||
									!actionEvidencePort ||
									!activityClaimPort
								) {
									throw new CandidatePromotionValidationError(
										"V3 candidate materialization requires the governed workspace adapter, durable action evidence, and native activity-claim ports.",
									);
								}
								const materialized = await createGovernedWorkspaceCandidate({
									candidateId: candidateIdentity.candidateId,
									runId: ctx.run.id,
									attempt: candidateIdentity.attempt,
									path: ctx.workspace.path,
									baseSha: ctx.workspace.headSha,
									projectRoot,
									governedDispatch: governedDispatchV3,
									actionEvidencePort,
									activityClaimPort,
								});
								frozenCandidate = materialized.candidate;
								governedActionReceipts.push(
									...normalizeDurableActionReceiptReferencesV3([
										materialized.actionReceipt,
									]),
								);
								const sealedSet = await sealActionReceiptSetV3(
									governedDispatchV3,
									governedActionReceipts,
								);
								sealedActionReceiptSetsByRunId.set(ctx.run.id, sealedSet);
								await recordCandidateCreatedV3(
									frozenCandidate,
									governedDispatchV3,
									sealedSet,
									materialized.candidateCreateActionEvidence,
								);
							} else {
								const createWorkspaceCandidate =
									workspace.createWorkspaceCandidate;
								if (!createWorkspaceCandidate) {
									throw new CandidatePromotionValidationError(
										"Candidate materialization requires a candidate-capable workspace adapter.",
									);
								}
								frozenCandidate = createWorkspaceCandidate({
									candidateId: candidateIdentity.candidateId,
									runId: ctx.run.id,
									attempt: candidateIdentity.attempt,
									path: ctx.workspace.path,
									baseSha: ctx.workspace.headSha,
									projectRoot,
								});
							}
						} catch (error) {
							return finalizeInfrastructureFailure(
								ctx.run,
								infrastructureFailure("candidate-finalization-failed", error),
								{
									receipt: currentReceipt,
									decision,
									workspace: ctx.workspace,
									workspaceStatus: "retained",
								},
							);
						}

						const architectureGate =
							resolvedProfile?.trustGates?.architectureDiffScope;
						if (architectureGate && policy.evaluateArchitectureDiffScope) {
							const architectureDecision = policy.evaluateArchitectureDiffScope(
								collectCandidateChangedFiles(
									ctx.workspace.path,
									frozenCandidate.baseSha,
									frozenCandidate.candidateCommitSha,
								),
								architectureGate,
							);
							if (architectureDecision) {
								return finalizeWithResultReady(
									finalizeRun(
										{ ...ctx, attemptCount },
										currentReceipt,
										architectureDecision,
										createRunOptions,
										frozenCandidate,
									),
									{
										admissionEventId: currentPacket.provenance_ref,
										acceptanceEventId,
									},
									{ emitResultReady },
								);
							}
						}

						let acceptance: {
							readonly decision: PolicyDecision | null;
							readonly acceptanceEventId?: string;
							readonly candidateAcceptance?: CandidateAcceptanceRecord;
						};
						try {
							acceptance = await evaluateAndRecordAcceptanceAsync({
								resolvedProfile,
								workspacePath: ctx.workspace.path,
								baseSha: ctx.workspace.headSha,
								currentPacket,
								currentReceipt,
								attemptCount,
								runId: ctx.run.id,
								candidate: frozenCandidate,
								requireCandidateEvidence: true,
								expectedAcceptanceContractDigest:
									governedDispatchV3?.acceptanceContractDigest ??
									createRunOptions?.candidateGovernance
										?.acceptanceContractDigest,
							});
						} catch (error) {
							return finalizeInfrastructureFailure(
								ctx.run,
								infrastructureFailure(
									"candidate-acceptance-record-failed",
									error,
								),
								{
									receipt: currentReceipt,
									workspace: ctx.workspace,
									workspaceStatus: "retained",
								},
							);
						}
						if (acceptance.acceptanceEventId) {
							acceptanceEventId = acceptance.acceptanceEventId;
						}
						if (acceptance.decision) {
							return finalizeWithResultReady(
								finalizeRun(
									{ ...ctx, attemptCount },
									currentReceipt,
									acceptance.decision,
									createRunOptions,
									frozenCandidate,
									acceptance.candidateAcceptance,
								),
								{
									admissionEventId: currentPacket.provenance_ref,
									acceptanceEventId,
								},
								{ emitResultReady },
							);
						}
						return finalizeWithResultReady(
							finalizeRun(
								{ ...ctx, attemptCount },
								currentReceipt,
								decision,
								createRunOptions,
								frozenCandidate,
								acceptance.candidateAcceptance,
							),
							{
								admissionEventId: currentPacket.provenance_ref,
								acceptanceEventId,
							},
							{ emitResultReady },
						);
					}

					const architectureGate =
						resolvedProfile?.trustGates?.architectureDiffScope;
					if (architectureGate && policy.evaluateArchitectureDiffScope) {
						const architectureDecision = policy.evaluateArchitectureDiffScope(
							currentReceipt.changedFiles ?? [],
							architectureGate,
						);
						if (architectureDecision) {
							return finalizeWithResultReady(
								finalizeRun(
									{
										run: ctx.run,
										validatedPacket: currentPacket,
										workspace: ctx.workspace,
										attemptCount,
									},
									currentReceipt,
									architectureDecision,
									createRunOptions,
								),
								{
									admissionEventId: currentPacket.provenance_ref,
									acceptanceEventId,
								},
								{ emitResultReady },
							);
						}
					}

					let acceptanceDecision: PolicyDecision | null;
					try {
						const acceptance = await evaluateAndRecordAcceptanceAsync({
							resolvedProfile,
							workspacePath: ctx.workspace.path,
							baseSha: ctx.workspace.headSha,
							currentPacket,
							currentReceipt,
							attemptCount,
							runId: ctx.run.id,
						});
						acceptanceDecision = acceptance.decision;
						if (acceptance.acceptanceEventId) {
							acceptanceEventId = acceptance.acceptanceEventId;
						}
					} catch (error) {
						// Recording the signed verdict is a write-ahead gate. If it fails
						// the run must NOT escape unfinalized — fail closed and quarantine.
						return finalizeInfrastructureFailure(
							ctx.run,
							infrastructureFailure("acceptance-record-failed", error),
							{
								receipt: currentReceipt,
								workspace: ctx.workspace,
								workspaceStatus: "retained",
							},
						);
					}
					if (acceptanceDecision) {
						return finalizeWithResultReady(
							finalizeRun(
								{
									run: ctx.run,
									validatedPacket: currentPacket,
									workspace: ctx.workspace,
									attemptCount,
								},
								currentReceipt,
								acceptanceDecision,
								createRunOptions,
							),
							{
								admissionEventId: currentPacket.provenance_ref,
								acceptanceEventId,
							},
							{ emitResultReady },
						);
					}

					const decision = policy.evaluateRun(
						currentPacket,
						currentReceipt,
						resolvedProfile,
						attemptCount,
					);

					scopedBus.emit({
						kind: "policy-decision",
						runId: ctx.run.id,
						timestamp: new Date().toISOString(),
						decisionKind: decision.kind,
						outcome: decision.outcome,
						reasons: decision.reasons,
					});

					if (decision.kind !== "retry-run") {
						return finalizeWithResultReady(
							finalizeRun(
								{ ...ctx, attemptCount },
								currentReceipt,
								decision,
								createRunOptions,
							),
							{
								admissionEventId: currentPacket.provenance_ref,
								acceptanceEventId,
							},
							{ emitResultReady },
						);
					}

					// Retry: augment packet with feedback and re-execute
					attemptCount = decision.attemptNumber;
					const feedbackSuffix =
						decision.feedbackContext.length > 0
							? `\n\nPrevious attempt failed:\n${decision.feedbackContext.join("\n")}\n\nPlease fix these issues and try again.`
							: "";

					if (currentPacket.model) {
						currentPacket = {
							...currentPacket,
							model: {
								...currentPacket.model,
								systemPrompt:
									(currentPacket.model.systemPrompt ?? "") + feedbackSuffix,
							},
						};
					}

					try {
						currentReceipt = await executeOnceWithChangedFiles(currentPacket);
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						scopedBus.emit({
							kind: "execution-error",
							runId: ctx.run.id,
							timestamp: new Date().toISOString(),
							message,
							phase: "retry-execution",
						});
						return finalizeInfrastructureFailure(
							ctx.run,
							infrastructureFailure("runtime-execution-failed", error),
							{
								workspace: ctx.workspace,
								workspaceStatus: "retained",
							},
						);
					}
				}
			} finally {
				budgetUnsubscribe?.();
			}
		},
		getStatus() {
			return storage.getStatusSnapshot();
		},
		inspect(id) {
			const snapshot = storage.inspectTarget(id);
			if (!snapshot.workspace?.path) {
				return snapshot;
			}

			return {
				...snapshot,
				workspace: {
					...snapshot.workspace,
					existsOnDisk: existsSync(snapshot.workspace.path),
				},
			};
		},

		approveRun(runId) {
			return storage.approveRun(runId);
		},

		rejectSuspendedRun(runId) {
			return storage.rejectSuspendedRun(runId);
		},

		async recordOperatorDecision(
			input: RecordOperatorDecisionInput,
		): Promise<void> {
			// F4 — fail-closed: an L0 side effect must never run unsigned. Without a
			// port there is no way to emit the write-ahead record, so reject BEFORE
			// validation/shadow/side-effect rather than silently applying it unsigned.
			if (!operatorDecisionPort) {
				throw new OperatorDecisionValidationError(
					"recordOperatorDecision requires an operatorDecisionPort (an L0 side effect must never run unsigned).",
				);
			}

			validateOperatorDecisionInput(input);

			// D1 — write-ahead is primary. Emit + flush the signed decision BEFORE
			// any side effect; the merge has not happened, so `mergeCommit` is
			// absent in the live path (the merge SHA is captured downstream, never
			// written back into the immutable signed event).
			await operatorDecisionPort.recordDecision(input);

			// D2 step 3 — the TS-readable exactly-once anchor. The reconciler cannot
			// read the Tier-2 events.db, so the Tier-1 mirror is what makes a decided
			// run detectable (and excludes it from the pending inbox).
			storage.recordOperatorDecisionShadow({
				runId: input.runId,
				decision: input.decision,
				subject: input.subject,
				decidedBy: input.decidedBy,
				decidedAt: input.decidedAt,
			});

			// D3 — side effect, gated on no prior execution marker (so a crash
			// between the mirror and the marker, then an operator re-decide, never
			// double-applies). Then D2 step 5 — mark the decision executed.
			applyOperatorDecisionSideEffect(
				input.runId,
				input.subject,
				input.decision,
			);

			// M6-S7 — flush the signed `run_completed` the (synchronous) side effect
			// captured for a terminal decision, so it is durable before returning.
			await flushPendingRunCompletedEmit();
		},

		async recordCandidatePromotion(
			input: RecordCandidatePromotionInput,
		): Promise<CandidatePromotionResult> {
			const candidate = storage.getCandidateArtifact?.(input.runId);
			if (!candidate) {
				throw new CandidatePromotionValidationError(
					`no immutable candidate artifact is recorded for run '${input.runId}'.`,
				);
			}

			// Validate the closed contracts and every equality binding before the
			// local write-ahead intent or signed decision can be emitted.
			const intentInput = validateCandidatePromotionBinding(input, candidate);
			promotionReceiptRefForCandidate(intentInput.candidate);
			requireCandidatePromotionExecutionLane(intentInput.candidate);
			requireSealedV3PromotionExecutorBeforePreparation(
				intentInput.candidate,
				intentInput.decision,
			);
			const dependencies = requireCandidatePromotionDependencies();
			const intent = dependencies.prepare(intentInput);
			return executeCandidatePromotionIntent(
				intent,
				intent.state !== "prepared",
			);
		},

		async recordCandidateReview(
			input: CandidateReviewEvidenceInput,
		): Promise<CandidateReviewRecord> {
			if (!candidateEvidencePort) {
				throw new CandidatePromotionValidationError(
					"candidate review requires a signed candidate evidence port.",
				);
			}
			if (
				typeof input.reviewerRunId !== "string" ||
				input.reviewerRunId.trim().length === 0
			) {
				throw new CandidatePromotionValidationError(
					"candidate review requires a non-empty reviewer run id.",
				);
			}
			if (
				typeof input.reviewedAt !== "string" ||
				Number.isNaN(Date.parse(input.reviewedAt))
			) {
				throw new CandidatePromotionValidationError(
					"candidate review requires a valid reviewedAt timestamp.",
				);
			}
			let verdict: ReviewVerdictV1;
			try {
				verdict = parseReviewVerdictV1(input.verdict);
			} catch (error) {
				throw new CandidatePromotionValidationError(
					`candidate review verdict is invalid: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			const acceptance = normalizeCandidateAcceptanceRecord(
				input.acceptance,
				input.candidate,
				"passed",
			);
			const candidateDigest = canonicalCandidateDigest(
				input.candidate.candidateDigest,
				"candidate.candidateDigest",
			);
			if (verdict.candidateDigest !== candidateDigest) {
				throw new CandidatePromotionValidationError(
					"candidate review verdict does not bind the accepted immutable candidate.",
				);
			}
			return normalizeCandidateReviewRecord(
				await candidateEvidencePort.recordCandidateReview({
					...input,
					acceptance,
					verdict,
				}),
				{ ...input, acceptance, verdict },
			);
		},

		async recoverPendingDecisions(): Promise<PendingDecisionRecovery> {
			// D2 — re-drive every decided-but-unexecuted side effect EXACTLY ONCE.
			// `listDecidedUnexecutedDecisions` returns only runs with a Tier-1
			// decision mirror and no execution marker; NEVER re-emit Tier-2.
			//
			// R2 — per-item isolation: one poisoned record (a re-drive that throws)
			// must not wedge the batch, or a single bad row would block startup
			// recovery for every other pending decision. Catch, record, and continue;
			// the failed record keeps its missing marker, so a later pass retries it.
			let recovered = 0;
			const failed: PendingDecisionRecoveryFailure[] = [];
			for (const pending of storage.listDecidedUnexecutedDecisions()) {
				if (pending.subject === "merge") {
					try {
						const candidate = storage.getCandidateArtifact?.(pending.runId);
						if (candidate && isSealedV3Candidate(candidate)) {
							requireNoUnsafeLegacyCompatibilityForGovernedLineage(
								"a sealed V3 candidate",
							);
						}
					} catch (error) {
						failed.push({
							runId: pending.runId,
							error: error instanceof Error ? error.message : String(error),
						});
						continue;
					}
				}
				// Local SQLite shadows are not signed candidate-promotion authority.
				// Never let a normal startup turn an old or forged legacy `merge`
				// shadow into a target-branch effect. The compatibility mode is
				// explicit and is intentionally never enabled by CLI/web wiring.
				if (pending.subject === "merge" && !unsafeLegacyMergeDecisionMode) {
					failed.push({
						runId: pending.runId,
						error:
							"legacy merge recovery is disabled; reconcile only a verified candidate promotion.",
					});
					continue;
				}
				try {
					applyOperatorDecisionSideEffect(
						pending.runId,
						pending.subject,
						pending.decision,
					);
					await flushPendingRunCompletedEmit();
					recovered += 1;
				} catch (error) {
					failed.push({
						runId: pending.runId,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			return { recovered, failed };
		},

		async recoverPendingCandidatePromotions(): Promise<PendingCandidatePromotionRecovery> {
			const dependencies = requireCandidatePromotionDependencies({
				recovery: true,
			});
			const listPending = dependencies.listPending;
			if (!listPending) {
				throw new CandidatePromotionValidationError(
					"candidate promotion recovery requires durable pending-promotion storage.",
				);
			}

			let recovered = 0;
			const failed: PendingCandidatePromotionRecoveryFailure[] = [];
			for (const intent of listPending()) {
				try {
					await executeCandidatePromotionIntent(intent, true, {
						recovery: true,
					});
					recovered += 1;
				} catch (error) {
					failed.push({
						candidateDigest: intent.decision.candidateDigest,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			return { recovered, failed };
		},

		async runGraphAsync(
			graph: UnitGraph,
			eventBus?: EventBus,
			options?: { readonly lane?: "raw-legacy" },
		): Promise<GraphResult> {
			if (options?.lane !== "raw-legacy") {
				throw new CandidatePromotionValidationError(
					"Graph execution requires an explicit raw-legacy lane; governed graphs must use the immutable candidate transaction.",
				);
			}
			const bus = eventBus ?? defaultBus;
			const graphId = randomUUID();
			const normalizedGraph: UnitGraph = {
				nodes: graph.nodes.map((graphNode) => {
					const { dependsOn, ...packetInput } = graphNode;
					let normalizedDependsOn: readonly string[] | undefined;
					if (dependsOn !== undefined) {
						if (
							!Array.isArray(dependsOn) ||
							!Array.from(dependsOn).every(
								(dependency) => typeof dependency === "string",
							)
						) {
							throw new TypeError(
								"UnitGraph: dependsOn must be an array of strings",
							);
						}
						normalizedDependsOn = [...dependsOn];
					}
					const packet = parseUnitPacket(JSON.stringify(packetInput));
					return normalizedDependsOn === undefined
						? packet
						: { ...packet, dependsOn: normalizedDependsOn };
				}),
				...(graph.maxConcurrent === undefined
					? {}
					: { maxConcurrent: graph.maxConcurrent }),
			};
			const scheduler = createGraphScheduler(normalizedGraph);
			const carriesGovernance = normalizedGraph.nodes.some(
				carriesGovernanceFields,
			);
			if (carriesGovernance) {
				throw new CandidatePromotionValidationError(
					"Graph packets carrying governance fields cannot execute in the raw-legacy lane; use the immutable candidate transaction.",
				);
			}

			// Map from unitId → runId for toResult()
			const runIdMap = new Map<string, string>();
			const decisionReasonsMap = new Map<string, readonly string[]>();

			bus.emit({
				kind: "graph-started",
				runId: graphId,
				graphId,
				unitCount: normalizedGraph.nodes.length,
				timestamp: new Date().toISOString(),
			});

			// Build a lookup from unitId → UnitGraphNode for dispatch
			const nodeById = new Map(
				normalizedGraph.nodes.map((node) => [node.unit.id, node]),
			);

			// In-flight set: promises tagged with their unitId
			const inFlight = new Map<
				string,
				Promise<{ unitId: string; result: RunPacketResult }>
			>();

			/**
			 * Drain the scheduler: dispatch all newly ready units, then wait for
			 * one to complete (via Promise.race). Repeat until done.
			 */
			async function drainLoop(): Promise<void> {
				while (!scheduler.isDone()) {
					// Dispatch all ready units that aren't already in-flight
					for (const unitId of scheduler.readyUnits()) {
						if (inFlight.has(unitId)) continue;
						const graphNode = nodeById.get(unitId);
						if (!graphNode) continue;
						const { dependsOn: _dependsOn, ...packet } = graphNode;
						scheduler.markRunning(unitId);
						const promise = orchestrator
							.runPacketAsync(packet, bus, { trustLane: "unsafe" })
							.then((result) => ({
								unitId,
								result,
							}));
						inFlight.set(unitId, promise);
					}

					if (inFlight.size === 0) {
						// No ready units and nothing in-flight — graph is stuck or done
						break;
					}

					// Wait for the next unit to complete
					const { unitId, result } = await Promise.race(inFlight.values());
					inFlight.delete(unitId);

					if (result.run.id) {
						runIdMap.set(unitId, result.run.id);
					}
					if (result.decision?.reasons) {
						decisionReasonsMap.set(unitId, result.decision.reasons);
					}

					if (result.run.status === "passed") {
						scheduler.markPassed(unitId);
					} else {
						// failed, cancelled, suspended all count as failure for graph purposes
						scheduler.markFailed(unitId);
					}
				}
			}

			await drainLoop();

			const graphResult = scheduler.toResult(runIdMap, decisionReasonsMap);

			bus.emit({
				kind: "graph-completed",
				runId: graphId,
				graphId,
				outcome: graphResult.outcome,
				timestamp: new Date().toISOString(),
			});

			return graphResult;
		},

		async runStrategy(
			strategy: StrategyPacket,
			eventBus?: EventBus,
			strategyOptions?: StrategyExecutionOptions,
		): Promise<StrategyResult> {
			const strategyResult = await runStrategy(
				strategy,
				orchestrator,
				eventBus,
				strategyOptions,
			);

			// Post-strategy memory hook — fires once when all strategy children complete
			if (strategyResult.rounds && strategyResult.rounds.length > 1) {
				let learnings: ReturnType<typeof extractLearnings>;
				try {
					const strategyDecision: PolicyDecision =
						strategyResult.outcome === "passed"
							? {
									kind: "advance-run" as const,
									outcome: "approved" as const,
									reasons: strategyResult.mergeDecision.reasons,
								}
							: {
									kind: "reject-run" as const,
									outcome: "rejected" as const,
									reasons: strategyResult.mergeDecision.reasons,
								};

					learnings = extractLearnings({
						run: {
							id: strategyResult.strategyId,
							unitId: strategyResult.strategyId,
							status: strategyResult.outcome === "passed" ? "passed" : "failed",
						},
						receipt: {
							command: "",
							args: [],
							cwd: "",
							startedAt: new Date().toISOString(),
							completedAt: new Date().toISOString(),
							exitCode: strategyResult.outcome === "passed" ? 0 : 1,
							stdout: "",
							stderr: "",
							outputChecks: [],
						},
						decision: strategyDecision,
						packet: {
							unit: {
								id: strategyResult.strategyId,
								kind: "command",
								scope: "task",
								inputRefs: [],
								expectedOutputs: [],
								verificationContract: "exit-0",
								policyProfile: "default",
							},
							execution: { command: "", args: [] },
							verification: { requiredOutputs: [] },
							provenance_ref: "",
							execution_role: "implementer",
						},
						strategyResult,
					});
				} catch {
					// Silent — follows event bus subscriber convention
					return strategyResult;
				}

				if (memoryPort && learnings.length > 0) {
					try {
						memoryPort.writeLearnings(strategyResult.strategyId, learnings);
					} catch {
						// Silent — follows event bus subscriber convention
					}
				}

				try {
					promoteStrategyWorkflowProcedure(strategy, strategyResult, learnings);
				} catch {
					// Silent — follows event bus subscriber convention
				}
			}

			return strategyResult;
		},
	};

	// Do not advertise V3 candidate strategies until their governed materializer
	// and persistence half are both present. Older/raw adapters retain their
	// legacy graph behavior; a candidate-capable kernel instead freezes output
	// before it can be reviewed.
	if (
		"createGovernedWorkspaceCandidate" in workspace &&
		"commitRunCandidateOutcome" in storage
	) {
		orchestrator.runCandidatePacketAsync = (
			packet,
			candidateIdentity,
			eventBus,
			governedDispatch,
		) =>
			orchestrator.runPacketAsync(packet, eventBus, {
				finalizationMode: "create-candidate",
				candidateIdentity,
				...(governedDispatch
					? {
							governedDispatch,
							runId: governedDispatch.runId,
							trustLane: "governed" as const,
						}
					: {}),
			});
	}

	return orchestrator;
}
