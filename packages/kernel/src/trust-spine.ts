import { createHash } from "node:crypto";
import type { UnitGraph } from "./graph.js";
import { parseGovernedUnitPacket } from "./packet.js";

/**
 * Pure V1 contracts for the trust spine.
 *
 * Parsing in this module validates only the structural shape of a contract.
 * It does not calculate digests, verify signatures, check ledger entries, or
 * authorize any side effect. Those checks must occur before execution or
 * promotion is allowed to have an effect.
 */

export type ExecutionRoleV1 =
	| "implementer"
	| "reviewer"
	| "adversary"
	| "judge"
	| "candidate";

export type CommitModeV1 = "atomic" | "incremental" | "saga";

export type TrustTierV1 = "raw" | "governed";

/**
 * The signed selector for V3 action evidence. `sealed-v2` remains readable so
 * historical tapes replay identically; new governed execution must select
 * `sealed_v3`, which requires a native activity lease/result chain.
 */
export type ActionEvidenceVersionV1 = "sealed-v2" | "sealed_v3";

export type ReviewDecisionV1 =
	| "approve"
	| "request_changes"
	| "reject"
	| "abstain";

export type PromotionDecisionKindV1 = "promote" | "reject";

export type ReviewFindingSeverityV1 =
	| "info"
	| "low"
	| "medium"
	| "high"
	| "critical";

export interface SignatureRefV1 {
	readonly algorithm: string;
	readonly keyId: string;
	readonly signature: string;
}

/** The existing kernel budget vocabulary carried by a V1 dispatch. */
export interface DispatchBudgetV1 {
	readonly maxTokens?: number;
	readonly maxComputeTimeMs?: number;
}

/**
 * A bounded request to execute one workflow unit.
 *
 * `signatureRef` is parsed structurally only. It is not a proof that the
 * envelope was signed by a trusted key.
 */
export interface DispatchEnvelopeV1 {
	readonly schemaVersion: 1;
	readonly workflowId: string;
	readonly workflowRevision: string;
	readonly unitId: string;
	readonly attempt: number;
	readonly executionRole: ExecutionRoleV1;
	readonly commitMode: CommitModeV1;
	readonly provenanceRef: string;
	readonly baseCommitSha: string;
	readonly capabilityBundleDigest: string;
	readonly acceptanceContractDigest: string;
	readonly contextManifestDigest: string;
	readonly workerManifestDigest: string;
	readonly sandboxProfileDigest: string;
	readonly budget: DispatchBudgetV1;
	readonly trustTier: TrustTierV1;
	readonly idempotencyKey: string;
	readonly issuedAt: string;
	readonly expiresAt: string;
	readonly envelopeDigest: string;
	readonly signatureRef: SignatureRefV1;
}

/**
 * The authority-bearing portion of a non-circular dispatch envelope.
 *
 * Unlike V1, this body deliberately excludes both its digest and a nested
 * signature reference. The ledger owns the canonical body bytes and binds
 * them with its detached event signature; a model or CLI parser must never
 * calculate this digest and treat the result as execution authority.
 */
export interface DispatchEnvelopeBodyV2 {
	readonly workflowId: string;
	readonly workflowRevision: string;
	readonly unitId: string;
	readonly attempt: number;
	readonly executionRole: ExecutionRoleV1;
	readonly commitMode: CommitModeV1;
	readonly provenanceRef: string;
	readonly baseCommitSha: string;
	readonly capabilityBundleDigest: string;
	readonly acceptanceContractDigest: string;
	readonly contextManifestDigest: string;
	readonly workerManifestDigest: string;
	readonly sandboxProfileDigest: string;
	readonly budget: DispatchBudgetV1;
	readonly trustTier: TrustTierV1;
	readonly idempotencyKey: string;
	readonly issuedAt: string;
	readonly expiresAt: string;
}

/**
 * Additive non-circular dispatch proposal. A structural V2 parse is useful
 * for preview and diagnostics only: execution still requires a verified
 * detached ledger signature and exact kernel authority.
 */
export interface DispatchEnvelopeV2 {
	readonly schemaVersion: 2;
	readonly body: DispatchEnvelopeBodyV2;
	readonly envelopeDigest: string;
}

/**
 * The exact bytes addressed by a V3 dispatch digest. V3 keeps the V2
 * authority body intact and adds a protocol selector outside that body; on
 * the wire this is `{ body, action_evidence_version }` before the detached
 * digest is added.
 */
export interface DispatchEnvelopeBodyV3 {
	readonly body: DispatchEnvelopeBodyV2;
	readonly actionEvidenceVersion: ActionEvidenceVersionV1;
	/**
	 * Canonical binding of the target repository instance, object format,
	 * target ref, and configured remote identity. A base commit alone is not a
	 * repository authority: the same object can exist in another clone/fork.
	 */
	readonly repositoryBindingDigest: string;
	/** Host-owned, non-workspace ledger authority realm for exactly-once effects. */
	readonly ledgerAuthorityRealmDigest: string;
	/**
	 * Optional only for readable sealed-v2 history. Every new sealed_v3
	 * envelope must carry this exact normalized governed-packet digest.
	 */
	readonly governedPacketDigest?: string;
}

/**
 * Additive dispatch proposal for the sealed action-evidence protocol.
 * Parsing checks the supplied digest against the closed V3 digest body, but
 * still does not turn that value into execution authority; the signed tape and
 * kernel admission verifier remain mandatory.
 */
export interface DispatchEnvelopeV3 extends DispatchEnvelopeBodyV3 {
	readonly schemaVersion: 3;
	readonly envelopeDigest: string;
}

/**
 * Additive graph-bound dispatch proposal. V4 nests the complete V3 envelope
 * so graph binding cannot accidentally omit an existing V3 authority field.
 * Like earlier envelope parsers, this is structural validation only: a signed
 * tape event and the broker-owned admission boundary remain mandatory before
 * any effect may occur.
 */
export interface DispatchEnvelopeV4 {
	readonly schemaVersion: 4;
	readonly dispatchV3: DispatchEnvelopeV3;
	readonly workflowGraphDigest: string;
	readonly workflowGraphDeclarationEventRef: string;
	readonly envelopeDigest: string;
}

/** One canonically ordered, packet-bound node in a V2 workflow topology. */
export interface WorkflowGraphNodeV2 {
	readonly unitId: string;
	readonly dependsOn: readonly string[];
	readonly executionRole: ExecutionRoleV1;
	readonly governedPacketDigest: string;
}

/**
 * Immutable graph topology that a V4 dispatch references by both digest and
 * exact signed declaration event. Delivery metadata is intentionally excluded
 * from `graphDigest`, matching the native ledger payload.
 */
export interface WorkflowGraphDeclaredV2 {
	readonly runId: string;
	readonly workflowId: string;
	readonly workflowRevision: string;
	readonly nodes: readonly WorkflowGraphNodeV2[];
	readonly maxConcurrent: number;
	readonly graphDigest: string;
	readonly idempotencyKey: string;
	readonly declaredAt: string;
}

/**
 * Pure compiler inputs for a packet-bound workflow declaration. The graph's
 * node role and packet digest are derived from each packet; callers cannot
 * provide a parallel role/digest pair for the compiler to trust.
 */
export interface GovernedWorkflowGraphV2CompilerInput {
	readonly runId: string;
	readonly workflowId: string;
	readonly workflowRevision: string;
	readonly graph: UnitGraph;
	readonly declaredAt: string;
	readonly idempotencyKey?: string;
}

/**
 * An immutable candidate binding. `candidateDigest` comes from the caller's
 * artifact/ledger system; this module deliberately does not calculate it.
 */
export interface CandidateArtifactV1 {
	readonly schemaVersion: 1;
	readonly workflowId: string;
	readonly unitId: string;
	readonly attempt: number;
	readonly provenanceRef: string;
	readonly candidateDigest: string;
	readonly baseCommitSha: string;
	readonly candidateCommitSha: string;
	readonly treeDigest: string;
	readonly patchDigest: string;
	readonly changedFilesDigest: string;
	readonly envelopeDigest: string;
	readonly actionReceiptDigest: string;
}

/**
 * Immutable candidate evidence for the sealed action-evidence protocol. A V2
 * candidate binds the kernel-sealed receipt set, never a pre-effect receipt.
 */
export interface CandidateArtifactV2 {
	readonly schemaVersion: 2;
	readonly workflowId: string;
	readonly unitId: string;
	readonly attempt: number;
	readonly provenanceRef: string;
	readonly candidateDigest: string;
	readonly baseCommitSha: string;
	readonly candidateCommitSha: string;
	readonly commitDigest: string;
	readonly treeDigest: string;
	readonly patchDigest: string;
	readonly changedFilesDigest: string;
	readonly envelopeDigest: string;
	readonly actionReceiptSetRef: string;
	readonly actionReceiptSetDigest: string;
}

/**
 * Signed-tape candidate creation payload V2. The raw Git candidate identity
 * comes from the workspace adapter; this record attaches the exact V3 action
 * receipt set. Action requests and receipts intentionally never carry a
 * candidate digest, so an effect cannot claim a candidate before it exists.
 */
export interface CandidateCreatedV2 {
	readonly runId: string;
	readonly candidateId: string;
	readonly candidateRef: string;
	readonly workflowId: string;
	readonly unitId: string;
	readonly attempt: number;
	readonly provenanceRef: string;
	readonly candidateDigest: string;
	readonly baseCommitSha: string;
	readonly candidateCommitSha: string;
	readonly commitDigest: string;
	readonly treeDigest: string;
	readonly patchDigest: string;
	readonly changedFilesDigest: string;
	readonly envelopeDigest: string;
	readonly actionReceiptSetRef: string;
	readonly actionReceiptSetDigest: string;
}

/**
 * Closed post-materialization evidence for one governed sealed_v3 candidate.
 *
 * `CandidateCreatedV2` records immutable Git facts and the complete receipt
 * set. This additive record binds that candidate event to the exact
 * candidate-create action request, native activity claim/result, and terminal
 * receipt that produced it. The detached digest excludes only itself.
 */
export interface CandidateCompletionRecordedV1 {
	readonly runId: string;
	readonly workflowId: string;
	readonly unitId: string;
	readonly attempt: number;
	readonly provenanceRef: string;
	readonly candidateCreatedEventRef: string;
	readonly candidateDigest: string;
	readonly candidateCreateActionId: string;
	readonly actionRequestRef: string;
	readonly actionRequestDigest: string;
	readonly activityClaimEventRef: string;
	readonly activityClaimEventDigest: string;
	readonly activityResultEventRef: string;
	readonly activityResultEventDigest: string;
	readonly actionReceiptRef: string;
	readonly actionReceiptDigest: string;
	readonly completionDigest: string;
	readonly completedAt: string;
}

export interface ReviewFindingV1 {
	readonly severity: ReviewFindingSeverityV1;
	readonly checkId: string;
	readonly file: string;
	readonly line: number;
	readonly explanation: string;
	readonly evidenceRefs: readonly string[];
}

export interface ReviewVerdictV1 {
	readonly schemaVersion: 1;
	readonly candidateDigest: string;
	readonly decision: ReviewDecisionV1;
	readonly findings: readonly ReviewFindingV1[];
	readonly confidence: number;
	readonly reviewerManifestDigest: string;
}

/**
 * The closed semantic output produced by a review worker. It deliberately
 * excludes reviewer identity and action receipts: those belong to the
 * surrounding signed V2 review record, while this digest binds only what the
 * worker concluded about one immutable candidate view.
 */
export interface ReviewVerdictOutputV1 {
	readonly candidateDigest: string;
	readonly candidateCommitSha: string;
	readonly decision: ReviewDecisionV1;
	readonly findings: readonly ReviewFindingV1[];
	readonly confidence: number;
	readonly candidateViewDigest: string;
}

/**
 * The complete, reconstructible read-only candidate view supplied to a
 * reviewer. The outer V2 review record separately binds the durable view
 * reference; this value binds the immutable candidate, reviewer context,
 * sandbox, and mount policy across the TypeScript and Rust boundaries.
 */
export interface CandidateViewV1 {
	readonly candidateRef: string;
	readonly candidateDigest: string;
	readonly candidateCommitSha: string;
	readonly treeDigest: string;
	readonly reviewerContextManifestDigest: string;
	readonly reviewerSandboxProfileDigest: string;
	readonly mountPathDigest: string;
	readonly readOnly: boolean;
	readonly networkDisabled: boolean;
}

/**
 * Evidence-complete V2 review payload. It is a closed, replay-verifiable
 * record shape, not authority to append evidence or promote a candidate. A
 * native signed-replay endpoint must derive and sign this record before it is
 * written to a governed tape.
 */
export interface ReviewVerdictRecordedV2 {
	readonly runId: string;
	readonly workflowId: string;
	readonly unitId: string;
	readonly attempt: number;
	readonly provenanceRef: string;
	readonly candidateDigest: string;
	readonly candidateCommitSha: string;
	readonly reviewRef: string;
	readonly reviewVerdictActionId: string;
	readonly reviewActionRequestDigest: string;
	readonly reviewActionReceiptRef: string;
	readonly reviewActionReceiptDigest: string;
	readonly reviewOutputRef: string;
	readonly reviewOutputDigest: string;
	readonly decision: ReviewDecisionV1;
	readonly findings: readonly ReviewFindingV1[];
	readonly confidence: number;
	readonly acceptanceRef: string;
	readonly acceptanceDigest: string;
	readonly acceptanceContractDigest: string;
	readonly candidateEnvelopeDigest: string;
	readonly reviewerWorkflowId: string;
	readonly reviewerDispatchEnvelopeDigest: string;
	readonly reviewerUnitId: string;
	readonly reviewerAttempt: number;
	readonly reviewerExecutionRole: Exclude<
		ExecutionRoleV1,
		"implementer" | "candidate"
	>;
	readonly reviewActionReceiptSetRef: string;
	readonly reviewActionReceiptSetDigest: string;
	readonly candidateView: CandidateViewV1;
	readonly candidateViewRef: string;
	readonly candidateViewDigest: string;
	readonly reviewerManifestDigest: string;
	readonly reviewerAuthority: string;
	readonly reviewedAt: string;
}

/**
 * A structural promotion binding only.
 *
 * Parsing this object neither cryptographically verifies its referenced
 * evidence nor authorizes a merge. A caller must verify signed-ledger evidence
 * and enforce its own authority policy before any effect is authorized.
 */
export interface PromotionDecisionV1 {
	readonly schemaVersion: 1;
	readonly candidateDigest: string;
	readonly baseCommitSha: string;
	/**
	 * Signed target branch for strict governed promotion. Omitted only while
	 * parsing a historical unbound record; callers that authorize a new
	 * candidate promotion must require it.
	 */
	readonly targetRef?: string;
	readonly envelopeDigest: string;
	readonly acceptanceRef: string;
	readonly reviewRefs: readonly string[];
	/**
	 * Exact kernel-signed approval-request event when this decision resolves a
	 * durable request. Omitted for historical direct decisions.
	 */
	readonly promotionApprovalRequestRef?: string;
	readonly decision: PromotionDecisionKindV1;
	readonly authority: string;
	readonly decidedBy: string;
	readonly decidedAt: string;
	readonly idempotencyKey: string;
}

/**
 * A closed, candidate-bound request for an operator promotion decision.
 *
 * This structural record has no merge authority. The ledger signer and
 * workflow reducer separately prove that a kernel created it and that an
 * operator decision binds its exact event reference.
 */
export interface PromotionApprovalRequestedV1 {
	readonly schemaVersion: 1;
	readonly candidateDigest: string;
	readonly baseCommitSha: string;
	readonly targetRef: string;
	readonly envelopeDigest: string;
	readonly acceptanceRef: string;
	readonly reviewRefs: readonly string[];
	readonly requestedBy: string;
	readonly requestedAt: string;
	readonly idempotencyKey: string;
}

/**
 * Explicit post-CAS state. `pending_reconciliation` is adapter-local evidence
 * captured immediately after the target-ref CAS. The kernel must terminalize a
 * still-stale root checkout as `root_checkout_stale`, never as a passed
 * promotion; `target_advanced` remains the distinct concurrent-ref case.
 */
export type PromotionWorktreeSyncStateV1 =
	| "pending_reconciliation"
	| "root_checkout_stale"
	| "target_advanced";

/**
 * Adapter-observed proof of the exact target-ref mutation performed for a
 * promoted candidate. The adapter reads merge parents/tree from the actual
 * object and records the post-CAS target observation before a signed result is
 * written; these fields are never inferred from a worker narrative.
 */
export interface PromotionGitBindingV1 {
	readonly targetRef: string;
	readonly targetHeadBeforeSha: string;
	readonly targetHeadAfterSha: string;
	readonly mergedHeadSha: string;
	readonly candidateCommitSha: string;
	readonly mergeParentShas: readonly [string, string];
	readonly mergedTreeSha: string;
	readonly mergedTreeDigest: string;
	/** Candidate-keyed immutable Git ref that must resolve to `mergedHeadSha`. */
	readonly promotionReceiptRef: string;
	readonly worktreeSyncState: PromotionWorktreeSyncStateV1;
}

/** Typed, closed action intent; execution remains a separate authorization step. */
export interface ActionRequestV1 {
	readonly schemaVersion: 1;
	readonly workflowId: string;
	readonly unitId: string;
	readonly attempt: number;
	readonly provenanceRef: string;
	readonly actionId: string;
	readonly dispatchEnvelopeDigest: string;
	readonly capabilityBundleDigest: string;
	readonly contextManifestDigest: string;
	readonly workerManifestDigest: string;
	readonly sandboxProfileDigest: string;
	readonly authority: string;
	readonly idempotencyKey: string;
	readonly requestedAt: string;
}

/** Closed action result record; it never by itself authorizes a retry. */
export interface ActionReceiptV1 {
	readonly schemaVersion: 1;
	readonly workflowId: string;
	readonly unitId: string;
	readonly attempt: number;
	readonly provenanceRef: string;
	readonly actionId: string;
	readonly actionRequestDigest: string;
	readonly dispatchEnvelopeDigest: string;
	readonly candidateDigest: string;
	readonly contextManifestDigest: string;
	readonly workerManifestDigest: string;
	readonly sandboxProfileDigest: string;
	readonly authority: string;
	readonly outcome: "succeeded" | "failed" | "denied";
	readonly evidenceDigest: string;
	readonly completedAt: string;
}

/** Closed effect vocabulary for the V3 action plane. */
export type ActionKindV2 =
	| "filesystem"
	| "process"
	| "git"
	| "model"
	| "network"
	| "secret"
	| "mcp"
	| "a2a"
	| "external_service";

/** Every durable action terminates explicitly, including reconciliation-only unknowns. */
export type ActionOutcomeV2 = "succeeded" | "failed" | "denied" | "unknown";

/** Resource facts observed by the host action gateway, not a worker narrative. */
export interface ActionResourceUsageV2 {
	readonly wallTimeMs: number;
	readonly cpuTimeMs?: number;
	readonly peakMemoryBytes?: number;
	readonly inputBytes?: number;
	readonly outputBytes?: number;
	/** Host-verified provider prompt tokens. Present only when metered. */
	readonly inputTokens?: number;
	/** Host-verified provider completion tokens. Present only when metered. */
	readonly outputTokens?: number;
}

/** A redacted field is still evidence-addressable without leaking its value. */
export interface ActionRedactionV2 {
	readonly field: string;
	readonly reason: string;
	readonly redactedDigest?: string;
}

/** Closed durable failure state for a non-success action. */
export interface ActionFailureV2 {
	readonly code: string;
	readonly messageDigest: string;
	readonly retryable: boolean;
}

/**
 * Write-ahead intent for one typed action. `canonicalInputRef` must point to
 * the canonical, redacted input blob addressed by `canonicalInputDigest`.
 * This record deliberately contains no candidate digest.
 */
export interface ActionRequestedV2 {
	readonly schemaVersion: 2;
	readonly runId: string;
	readonly workflowId: string;
	readonly unitId: string;
	readonly attempt: number;
	readonly provenanceRef: string;
	readonly actionId: string;
	readonly idempotencyKey: string;
	readonly actionKind: ActionKindV2;
	readonly canonicalInputDigest: string;
	readonly canonicalInputRef: string;
	readonly dispatchEnvelopeDigest: string;
	/** Exact repository binding copied from the signed V3 dispatch. */
	readonly repositoryBindingDigest: string;
	/** Copied from the sealed V3 envelope; never inferred from a workspace path. */
	readonly ledgerAuthorityRealmDigest: string;
	/**
	 * Exact packet authority copied from a sealed_v3 dispatch. Omitted only by
	 * readable legacy action records; a sealed_v3 action must never omit it.
	 */
	readonly governedPacketDigest?: string;
	readonly capabilityBundleDigest: string;
	readonly policyDigest: string;
	readonly contextManifestDigest: string;
	readonly workerManifestDigest: string;
	readonly sandboxProfileDigest: string;
	readonly authorityActor: string;
	readonly executionRole: ExecutionRoleV1;
	readonly requestedAt: string;
}

/**
 * Durable post-effect action result. The request digest is calculated from the
 * exact V2 request and the receipt digest is calculated from this complete
 * record. Neither is provided by an untrusted worker as candidate lineage.
 */
export interface ActionReceiptRecordedV2 {
	readonly schemaVersion: 2;
	readonly runId: string;
	readonly workflowId: string;
	readonly unitId: string;
	readonly attempt: number;
	readonly provenanceRef: string;
	readonly actionId: string;
	readonly idempotencyKey: string;
	readonly actionRequestDigest: string;
	readonly dispatchEnvelopeDigest: string;
	readonly capabilityBundleDigest: string;
	readonly policyDigest: string;
	readonly contextManifestDigest: string;
	readonly workerManifestDigest: string;
	readonly sandboxProfileDigest: string;
	readonly authorityActor: string;
	readonly executionRole: ExecutionRoleV1;
	/**
	 * Host ActionGateway decision reference for an effect that was allowed.
	 * Legacy receipts remain readable without it; governed V3 model success
	 * receipts must carry it before native replay will accept promotion lineage.
	 */
	readonly authorizationRef?: string;
	readonly outcome: ActionOutcomeV2;
	readonly resultDigest?: string;
	readonly resultRef?: string;
	readonly evidenceDigest: string;
	readonly evidenceRef: string;
	readonly resourceUsage: ActionResourceUsageV2;
	readonly redactions: readonly ActionRedactionV2[];
	readonly failure?: ActionFailureV2;
	readonly actionReceiptRef: string;
	readonly completedAt: string;
}

/** One sealed member of an action-receipt set. */
export interface ActionReceiptSetEntryV1 {
	readonly actionId: string;
	readonly actionReceiptRef: string;
	readonly actionReceiptDigest: string;
}

/**
 * The kernel's complete, canonical action evidence seal for a candidate
 * attempt. Empty sets are valid for a no-op candidate, but duplicate or
 * unsorted entries are never accepted.
 */
export interface ActionReceiptSetRecordedV1 {
	readonly schemaVersion: 1;
	readonly runId: string;
	readonly workflowId: string;
	readonly unitId: string;
	readonly attempt: number;
	readonly provenanceRef: string;
	readonly dispatchEnvelopeDigest: string;
	readonly actionReceiptSetRef: string;
	readonly actionReceiptSetDigest: string;
	readonly receipts: readonly ActionReceiptSetEntryV1[];
	readonly sealedAt: string;
}

/** Closed worker/provider manifest reference. */
export interface WorkerManifestV1 {
	readonly schemaVersion: 1;
	readonly workflowId: string;
	readonly unitId: string;
	readonly attempt: number;
	readonly provenanceRef: string;
	readonly dispatchEnvelopeDigest: string;
	readonly contextManifestDigest: string;
	readonly sandboxProfileDigest: string;
	readonly workerId: string;
	readonly provider: string;
	readonly manifestDigest: string;
}

/**
 * Closed, content-addressed identity of the concrete runtime selected for one
 * worker. This is intentionally separate from `WorkerManifestV1`: the legacy
 * record remains a backwards-compatible reference while this record exposes
 * the immutable provider, harness, image, tool, skill, capability, and
 * sandbox bindings a protected host needs to verify.
 */
export interface WorkerRuntimeManifestV1 {
	readonly schemaVersion: 1;
	readonly workerId: string;
	readonly executionRole: ExecutionRoleV1;
	readonly provider: string;
	readonly model: string;
	readonly providerVersion: string;
	readonly harness: string;
	readonly harnessVersion: string;
	readonly imageDigest: string;
	readonly toolCatalogDigest: string;
	readonly skillSetDigest: string;
	readonly capabilityBundleDigest: string;
	readonly sandboxProfileDigest: string;
	readonly runtimeManifestDigest: string;
}

/** Closed injected-context manifest reference. */
export interface ContextManifestV1 {
	readonly schemaVersion: 1;
	readonly workflowId: string;
	readonly unitId: string;
	readonly attempt: number;
	readonly provenanceRef: string;
	readonly dispatchEnvelopeDigest: string;
	readonly workerManifestDigest: string;
	readonly sandboxProfileDigest: string;
	readonly contextId: string;
	readonly manifestDigest: string;
}

/** Closed per-attempt context record. */
export interface AttemptContextV1 {
	readonly schemaVersion: 1;
	readonly workflowId: string;
	readonly unitId: string;
	readonly attempt: number;
	readonly provenanceRef: string;
	readonly dispatchEnvelopeDigest: string;
	readonly contextManifestDigest: string;
	readonly workerManifestDigest: string;
	readonly sandboxProfileDigest: string;
}

/** Closed sandbox profile reference. */
export interface SandboxProfileV1 {
	readonly schemaVersion: 1;
	readonly workflowId: string;
	readonly unitId: string;
	readonly attempt: number;
	readonly provenanceRef: string;
	readonly dispatchEnvelopeDigest: string;
	readonly workerManifestDigest: string;
	readonly profileId: string;
	readonly profileDigest: string;
}

const EXECUTION_ROLES = new Set<ExecutionRoleV1>([
	"implementer",
	"reviewer",
	"adversary",
	"judge",
	"candidate",
]);

const COMMIT_MODES = new Set<CommitModeV1>(["atomic", "incremental", "saga"]);

const TRUST_TIERS = new Set<TrustTierV1>(["raw", "governed"]);

const REVIEW_DECISIONS = new Set<ReviewDecisionV1>([
	"approve",
	"request_changes",
	"reject",
	"abstain",
]);

const REVIEWER_EXECUTION_ROLES = new Set<
	Exclude<ExecutionRoleV1, "implementer" | "candidate">
>(["reviewer", "adversary", "judge"]);

const PROMOTION_DECISIONS = new Set<PromotionDecisionKindV1>([
	"promote",
	"reject",
]);

const REVIEW_FINDING_SEVERITIES = new Set<ReviewFindingSeverityV1>([
	"info",
	"low",
	"medium",
	"high",
	"critical",
]);

const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RAW_SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
// Git supports both SHA-1 and SHA-256 object formats. Governed contracts
// require a full lower-case object id, never an abbreviation.
const COMMIT_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CANONICAL_UUID_PATTERN =
	/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RFC3339_UTC_PATTERN =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;

const DISPATCH_ENVELOPE_FIELDS = [
	"schemaVersion",
	"workflowId",
	"workflowRevision",
	"unitId",
	"attempt",
	"executionRole",
	"commitMode",
	"provenanceRef",
	"baseCommitSha",
	"capabilityBundleDigest",
	"acceptanceContractDigest",
	"contextManifestDigest",
	"workerManifestDigest",
	"sandboxProfileDigest",
	"budget",
	"trustTier",
	"idempotencyKey",
	"issuedAt",
	"expiresAt",
	"envelopeDigest",
	"signatureRef",
] as const;

const DISPATCH_ENVELOPE_V2_FIELDS = [
	"schemaVersion",
	"body",
	"envelopeDigest",
] as const;

const DISPATCH_ENVELOPE_V3_FIELDS = [
	"schemaVersion",
	"body",
	"actionEvidenceVersion",
	"repositoryBindingDigest",
	"ledgerAuthorityRealmDigest",
	"governedPacketDigest",
	"envelopeDigest",
] as const;

const DISPATCH_ENVELOPE_V4_FIELDS = [
	"schemaVersion",
	"dispatchV3",
	"workflowGraphDigest",
	"workflowGraphDeclarationEventRef",
	"envelopeDigest",
] as const;

const WORKFLOW_GRAPH_DECLARED_V2_FIELDS = [
	"runId",
	"workflowId",
	"workflowRevision",
	"nodes",
	"maxConcurrent",
	"graphDigest",
	"idempotencyKey",
	"declaredAt",
] as const;

const WORKFLOW_GRAPH_NODE_V2_FIELDS = [
	"unitId",
	"dependsOn",
	"executionRole",
	"governedPacketDigest",
] as const;

const GOVERNED_WORKFLOW_GRAPH_V2_COMPILER_FIELDS = [
	"runId",
	"workflowId",
	"workflowRevision",
	"graph",
	"declaredAt",
	"idempotencyKey",
] as const;

const UNIT_GRAPH_FIELDS = ["nodes", "maxConcurrent"] as const;

const DISPATCH_ENVELOPE_BODY_V2_FIELDS = [
	"workflowId",
	"workflowRevision",
	"unitId",
	"attempt",
	"executionRole",
	"commitMode",
	"provenanceRef",
	"baseCommitSha",
	"capabilityBundleDigest",
	"acceptanceContractDigest",
	"contextManifestDigest",
	"workerManifestDigest",
	"sandboxProfileDigest",
	"budget",
	"trustTier",
	"idempotencyKey",
	"issuedAt",
	"expiresAt",
] as const;

const SIGNATURE_REF_FIELDS = ["algorithm", "keyId", "signature"] as const;
const DISPATCH_BUDGET_FIELDS = ["maxTokens", "maxComputeTimeMs"] as const;
const CANDIDATE_ARTIFACT_FIELDS = [
	"schemaVersion",
	"workflowId",
	"unitId",
	"attempt",
	"provenanceRef",
	"candidateDigest",
	"baseCommitSha",
	"candidateCommitSha",
	"treeDigest",
	"patchDigest",
	"changedFilesDigest",
	"envelopeDigest",
	"actionReceiptDigest",
] as const;
const CANDIDATE_ARTIFACT_V2_FIELDS = [
	"schemaVersion",
	"workflowId",
	"unitId",
	"attempt",
	"provenanceRef",
	"candidateDigest",
	"baseCommitSha",
	"candidateCommitSha",
	"commitDigest",
	"treeDigest",
	"patchDigest",
	"changedFilesDigest",
	"envelopeDigest",
	"actionReceiptSetRef",
	"actionReceiptSetDigest",
] as const;
const CANDIDATE_CREATED_V2_FIELDS = [
	"runId",
	"candidateId",
	"candidateRef",
	"workflowId",
	"unitId",
	"attempt",
	"provenanceRef",
	"candidateDigest",
	"baseCommitSha",
	"candidateCommitSha",
	"commitDigest",
	"treeDigest",
	"patchDigest",
	"changedFilesDigest",
	"envelopeDigest",
	"actionReceiptSetRef",
	"actionReceiptSetDigest",
] as const;
const CANDIDATE_COMPLETION_RECORDED_V1_FIELDS = [
	"runId",
	"workflowId",
	"unitId",
	"attempt",
	"provenanceRef",
	"candidateCreatedEventRef",
	"candidateDigest",
	"candidateCreateActionId",
	"actionRequestRef",
	"actionRequestDigest",
	"activityClaimEventRef",
	"activityClaimEventDigest",
	"activityResultEventRef",
	"activityResultEventDigest",
	"actionReceiptRef",
	"actionReceiptDigest",
	"completionDigest",
	"completedAt",
] as const;
const REVIEW_VERDICT_FIELDS = [
	"schemaVersion",
	"candidateDigest",
	"decision",
	"findings",
	"confidence",
	"reviewerManifestDigest",
] as const;
const CANDIDATE_VIEW_V1_FIELDS = [
	"candidateRef",
	"candidateDigest",
	"candidateCommitSha",
	"treeDigest",
	"reviewerContextManifestDigest",
	"reviewerSandboxProfileDigest",
	"mountPathDigest",
	"readOnly",
	"networkDisabled",
] as const;
const BUILDPANE_CANDIDATE_REF_PREFIX = "refs/buildplane/candidates/";
const BUILDPANE_CANDIDATE_REF_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REVIEW_VERDICT_RECORDED_V2_FIELDS = [
	"runId",
	"workflowId",
	"unitId",
	"attempt",
	"provenanceRef",
	"candidateDigest",
	"candidateCommitSha",
	"reviewRef",
	"reviewVerdictActionId",
	"reviewActionRequestDigest",
	"reviewActionReceiptRef",
	"reviewActionReceiptDigest",
	"reviewOutputRef",
	"reviewOutputDigest",
	"decision",
	"findings",
	"confidence",
	"acceptanceRef",
	"acceptanceDigest",
	"acceptanceContractDigest",
	"candidateEnvelopeDigest",
	"reviewerWorkflowId",
	"reviewerDispatchEnvelopeDigest",
	"reviewerUnitId",
	"reviewerAttempt",
	"reviewerExecutionRole",
	"reviewActionReceiptSetRef",
	"reviewActionReceiptSetDigest",
	"candidateView",
	"candidateViewRef",
	"candidateViewDigest",
	"reviewerManifestDigest",
	"reviewerAuthority",
	"reviewedAt",
] as const;
const REVIEW_FINDING_FIELDS = [
	"severity",
	"checkId",
	"file",
	"line",
	"explanation",
	"evidenceRefs",
] as const;
const PROMOTION_DECISION_FIELDS = [
	"schemaVersion",
	"candidateDigest",
	"baseCommitSha",
	"targetRef",
	"envelopeDigest",
	"acceptanceRef",
	"reviewRefs",
	"promotionApprovalRequestRef",
	"decision",
	"authority",
	"decidedBy",
	"decidedAt",
	"idempotencyKey",
] as const;
const PROMOTION_APPROVAL_REQUEST_FIELDS = [
	"schemaVersion",
	"candidateDigest",
	"baseCommitSha",
	"targetRef",
	"envelopeDigest",
	"acceptanceRef",
	"reviewRefs",
	"requestedBy",
	"requestedAt",
	"idempotencyKey",
] as const;
const ACTION_REQUEST_FIELDS = [
	"schemaVersion",
	"workflowId",
	"unitId",
	"attempt",
	"provenanceRef",
	"actionId",
	"dispatchEnvelopeDigest",
	"capabilityBundleDigest",
	"contextManifestDigest",
	"workerManifestDigest",
	"sandboxProfileDigest",
	"authority",
	"idempotencyKey",
	"requestedAt",
] as const;
const ACTION_RECEIPT_FIELDS = [
	"schemaVersion",
	"workflowId",
	"unitId",
	"attempt",
	"provenanceRef",
	"actionId",
	"actionRequestDigest",
	"dispatchEnvelopeDigest",
	"candidateDigest",
	"contextManifestDigest",
	"workerManifestDigest",
	"sandboxProfileDigest",
	"authority",
	"outcome",
	"evidenceDigest",
	"completedAt",
] as const;
const ACTION_REQUEST_V2_FIELDS = [
	"schemaVersion",
	"runId",
	"workflowId",
	"unitId",
	"attempt",
	"provenanceRef",
	"actionId",
	"idempotencyKey",
	"actionKind",
	"canonicalInputDigest",
	"canonicalInputRef",
	"dispatchEnvelopeDigest",
	"repositoryBindingDigest",
	"ledgerAuthorityRealmDigest",
	"governedPacketDigest",
	"capabilityBundleDigest",
	"policyDigest",
	"contextManifestDigest",
	"workerManifestDigest",
	"sandboxProfileDigest",
	"authorityActor",
	"executionRole",
	"requestedAt",
] as const;
const ACTION_RECEIPT_RECORDED_V2_FIELDS = [
	"schemaVersion",
	"runId",
	"workflowId",
	"unitId",
	"attempt",
	"provenanceRef",
	"actionId",
	"idempotencyKey",
	"actionRequestDigest",
	"dispatchEnvelopeDigest",
	"capabilityBundleDigest",
	"policyDigest",
	"contextManifestDigest",
	"workerManifestDigest",
	"sandboxProfileDigest",
	"authorityActor",
	"executionRole",
	"authorizationRef",
	"outcome",
	"resultDigest",
	"resultRef",
	"evidenceDigest",
	"evidenceRef",
	"resourceUsage",
	"redactions",
	"failure",
	"actionReceiptRef",
	"completedAt",
] as const;
const ACTION_RESOURCE_USAGE_V2_FIELDS = [
	"wallTimeMs",
	"cpuTimeMs",
	"peakMemoryBytes",
	"inputBytes",
	"outputBytes",
	"inputTokens",
	"outputTokens",
] as const;
const ACTION_REDACTION_V2_FIELDS = [
	"field",
	"reason",
	"redactedDigest",
] as const;
const ACTION_FAILURE_V2_FIELDS = [
	"code",
	"messageDigest",
	"retryable",
] as const;
const ACTION_RECEIPT_SET_RECORDED_V1_FIELDS = [
	"schemaVersion",
	"runId",
	"workflowId",
	"unitId",
	"attempt",
	"provenanceRef",
	"dispatchEnvelopeDigest",
	"actionReceiptSetRef",
	"actionReceiptSetDigest",
	"receipts",
	"sealedAt",
] as const;
const ACTION_RECEIPT_SET_ENTRY_V1_FIELDS = [
	"actionId",
	"actionReceiptRef",
	"actionReceiptDigest",
] as const;
const WORKER_MANIFEST_FIELDS = [
	"schemaVersion",
	"workflowId",
	"unitId",
	"attempt",
	"provenanceRef",
	"dispatchEnvelopeDigest",
	"contextManifestDigest",
	"sandboxProfileDigest",
	"workerId",
	"provider",
	"manifestDigest",
] as const;
const WORKER_RUNTIME_MANIFEST_V1_FIELDS = [
	"schemaVersion",
	"workerId",
	"executionRole",
	"provider",
	"model",
	"providerVersion",
	"harness",
	"harnessVersion",
	"imageDigest",
	"toolCatalogDigest",
	"skillSetDigest",
	"capabilityBundleDigest",
	"sandboxProfileDigest",
	"runtimeManifestDigest",
] as const;
const CONTEXT_MANIFEST_FIELDS = [
	"schemaVersion",
	"workflowId",
	"unitId",
	"attempt",
	"provenanceRef",
	"dispatchEnvelopeDigest",
	"workerManifestDigest",
	"sandboxProfileDigest",
	"contextId",
	"manifestDigest",
] as const;
const ATTEMPT_CONTEXT_FIELDS = [
	"schemaVersion",
	"workflowId",
	"unitId",
	"attempt",
	"provenanceRef",
	"dispatchEnvelopeDigest",
	"contextManifestDigest",
	"workerManifestDigest",
	"sandboxProfileDigest",
] as const;
const SANDBOX_PROFILE_FIELDS = [
	"schemaVersion",
	"workflowId",
	"unitId",
	"attempt",
	"provenanceRef",
	"dispatchEnvelopeDigest",
	"workerManifestDigest",
	"profileId",
	"profileDigest",
] as const;
const ACTION_OUTCOMES = new Set<ActionReceiptV1["outcome"]>([
	"succeeded",
	"failed",
	"denied",
]);

const ACTION_KINDS_V2 = new Set<ActionKindV2>([
	"filesystem",
	"process",
	"git",
	"model",
	"network",
	"secret",
	"mcp",
	"a2a",
	"external_service",
]);

const ACTION_OUTCOMES_V2 = new Set<ActionOutcomeV2>([
	"succeeded",
	"failed",
	"denied",
	"unknown",
]);

const SEALED_ACTION_EVIDENCE_VERSIONS = new Set<ActionEvidenceVersionV1>([
	"sealed-v2",
	"sealed_v3",
]);

/**
 * Structural parser only; the caller still needs to verify the referenced
 * signed-ledger records and `signatureRef` before permitting execution.
 */
export function parseDispatchEnvelopeV1(input: unknown): DispatchEnvelopeV1 {
	const record = readClosedRecord(
		input,
		"dispatchEnvelope",
		DISPATCH_ENVELOPE_FIELDS,
	);
	const issuedAt = readRfc3339UtcTimestamp(
		record,
		"issuedAt",
		"dispatchEnvelope",
	);
	const expiresAt = readRfc3339UtcTimestamp(
		record,
		"expiresAt",
		"dispatchEnvelope",
	);

	if (compareRfc3339UtcTimestamps(expiresAt, issuedAt) <= 0) {
		throw new TypeError(
			"dispatchEnvelope.expiresAt must be later than issuedAt",
		);
	}

	return {
		schemaVersion: readSchemaVersion(record, "dispatchEnvelope"),
		workflowId: readRequiredString(record, "workflowId", "dispatchEnvelope"),
		workflowRevision: readRequiredString(
			record,
			"workflowRevision",
			"dispatchEnvelope",
		),
		unitId: readRequiredString(record, "unitId", "dispatchEnvelope"),
		attempt: readPositiveSafeInteger(record, "attempt", "dispatchEnvelope"),
		executionRole: readEnum(
			record,
			"executionRole",
			"dispatchEnvelope",
			EXECUTION_ROLES,
		),
		commitMode: readEnum(
			record,
			"commitMode",
			"dispatchEnvelope",
			COMMIT_MODES,
		),
		provenanceRef: readRequiredString(
			record,
			"provenanceRef",
			"dispatchEnvelope",
		),
		baseCommitSha: readCommitSha(record, "baseCommitSha", "dispatchEnvelope"),
		capabilityBundleDigest: readSha256Digest(
			record,
			"capabilityBundleDigest",
			"dispatchEnvelope",
		),
		acceptanceContractDigest: readSha256Digest(
			record,
			"acceptanceContractDigest",
			"dispatchEnvelope",
		),
		contextManifestDigest: readSha256Digest(
			record,
			"contextManifestDigest",
			"dispatchEnvelope",
		),
		workerManifestDigest: readSha256Digest(
			record,
			"workerManifestDigest",
			"dispatchEnvelope",
		),
		sandboxProfileDigest: readSha256Digest(
			record,
			"sandboxProfileDigest",
			"dispatchEnvelope",
		),
		budget: readDispatchBudget(record.budget),
		trustTier: readEnum(record, "trustTier", "dispatchEnvelope", TRUST_TIERS),
		idempotencyKey: readRequiredString(
			record,
			"idempotencyKey",
			"dispatchEnvelope",
		),
		issuedAt: issuedAt.value,
		expiresAt: expiresAt.value,
		envelopeDigest: readSha256Digest(
			record,
			"envelopeDigest",
			"dispatchEnvelope",
		),
		signatureRef: readSignatureRef(record.signatureRef),
	};
}

/**
 * Parse a closed V2 dispatch proposal without treating its supplied digest as
 * a proof. Canonical digest calculation and detached signature verification
 * live in the Rust ledger so this function cannot mint governed authority.
 */
export function parseDispatchEnvelopeV2(input: unknown): DispatchEnvelopeV2 {
	const record = readClosedRecord(
		input,
		"dispatchEnvelopeV2",
		DISPATCH_ENVELOPE_V2_FIELDS,
	);
	if (!hasOwnField(record, "schemaVersion") || record.schemaVersion !== 2) {
		throw new TypeError("dispatchEnvelopeV2.schemaVersion must be 2");
	}

	return {
		schemaVersion: 2,
		body: parseDispatchEnvelopeBodyV2(record.body),
		envelopeDigest: readSha256Digest(
			record,
			"envelopeDigest",
			"dispatchEnvelopeV2",
		),
	};
}

/**
 * Parse and canonically bind a V3 sealed-action-evidence dispatch. The digest
 * check catches a substituted body at the untrusted JSON boundary; callers
 * must still verify the signed tape event before using the result as authority.
 */
export function parseDispatchEnvelopeV3(input: unknown): DispatchEnvelopeV3 {
	const record = readClosedRecord(
		input,
		"dispatchEnvelopeV3",
		DISPATCH_ENVELOPE_V3_FIELDS,
	);
	if (!hasOwnField(record, "schemaVersion") || record.schemaVersion !== 3) {
		throw new TypeError("dispatchEnvelopeV3.schemaVersion must be 3");
	}
	const actionEvidenceVersion = readRequiredString(
		record,
		"actionEvidenceVersion",
		"dispatchEnvelopeV3",
	);
	if (!isActionEvidenceVersion(actionEvidenceVersion)) {
		throw new TypeError(
			'dispatchEnvelopeV3.actionEvidenceVersion must be "sealed-v2" or "sealed_v3"',
		);
	}
	const governedPacketDigest =
		record.governedPacketDigest === undefined
			? undefined
			: readSha256Digest(record, "governedPacketDigest", "dispatchEnvelopeV3");
	if (
		actionEvidenceVersion === "sealed_v3" &&
		governedPacketDigest === undefined
	) {
		throw new TypeError(
			"dispatchEnvelopeV3.governedPacketDigest is required for sealed_v3 authority.",
		);
	}
	const parsed: DispatchEnvelopeV3 = {
		schemaVersion: 3,
		body: parseDispatchEnvelopeBodyV2(record.body),
		actionEvidenceVersion,
		repositoryBindingDigest: readSha256Digest(
			record,
			"repositoryBindingDigest",
			"dispatchEnvelopeV3",
		),
		ledgerAuthorityRealmDigest: readSha256Digest(
			record,
			"ledgerAuthorityRealmDigest",
			"dispatchEnvelopeV3",
		),
		...(governedPacketDigest === undefined ? {} : { governedPacketDigest }),
		envelopeDigest: readSha256Digest(
			record,
			"envelopeDigest",
			"dispatchEnvelopeV3",
		),
	};
	const expected = canonicalDispatchEnvelopeV3Digest(parsed);
	if (parsed.envelopeDigest !== expected) {
		throw new TypeError(
			"dispatchEnvelopeV3.envelopeDigest must equal the canonical V3 body digest",
		);
	}
	return parsed;
}

/**
 * Parse and canonically bind a graph-bound V4 dispatch. This validates the
 * complete nested V3 envelope before hashing the graph declaration identity;
 * it still cannot turn data into execution authority without signed-tape and
 * broker verification.
 */
export function parseDispatchEnvelopeV4(input: unknown): DispatchEnvelopeV4 {
	const record = readClosedRecord(
		input,
		"dispatchEnvelopeV4",
		DISPATCH_ENVELOPE_V4_FIELDS,
	);
	if (!hasOwnField(record, "schemaVersion") || record.schemaVersion !== 4) {
		throw new TypeError("dispatchEnvelopeV4.schemaVersion must be 4");
	}
	const parsed: DispatchEnvelopeV4 = {
		schemaVersion: 4,
		...readDispatchEnvelopeV4Fields(record),
		envelopeDigest: readSha256Digest(
			record,
			"envelopeDigest",
			"dispatchEnvelopeV4",
		),
	};
	const expected = canonicalDispatchEnvelopeV4Digest(parsed);
	if (parsed.envelopeDigest !== expected) {
		throw new TypeError(
			"dispatchEnvelopeV4.envelopeDigest must equal the canonical V4 graph-bound digest",
		);
	}
	return parsed;
}

/**
 * Parse a closed V2 workflow topology. The graph digest is checked against the
 * exact native snake_case material; declaration delivery and event ordering
 * remain signed-tape reducer concerns.
 */
export function parseWorkflowGraphDeclaredV2(
	input: unknown,
): WorkflowGraphDeclaredV2 {
	const record = readClosedRecord(
		input,
		"workflowGraphDeclaredV2",
		WORKFLOW_GRAPH_DECLARED_V2_FIELDS,
	);
	const parsed: WorkflowGraphDeclaredV2 = {
		...readWorkflowGraphDeclaredV2Fields(record),
		graphDigest: readSha256Digest(
			record,
			"graphDigest",
			"workflowGraphDeclaredV2",
		),
	};
	const expected = canonicalWorkflowGraphV2Digest(parsed);
	if (parsed.graphDigest !== expected) {
		throw new TypeError(
			"workflowGraphDeclaredV2.graphDigest must equal the canonical V2 workflow graph digest",
		);
	}
	return parsed;
}

/**
 * Compile one existing `UnitGraph` into its packet-bound V2 declaration.
 *
 * This is deliberately a pure projection: it derives every node role and
 * governed-packet digest from the packet itself, normalizes topology ordering,
 * and validates the resulting closed declaration. It neither signs the
 * declaration nor verifies a packet's external admission or grants authority.
 */
export function compileGovernedWorkflowGraphV2(
	input: GovernedWorkflowGraphV2CompilerInput,
): WorkflowGraphDeclaredV2 {
	const record = readClosedRecord(
		input,
		"governedWorkflowGraphV2Compiler",
		GOVERNED_WORKFLOW_GRAPH_V2_COMPILER_FIELDS,
	);
	const runId = readNonBlankString(
		record,
		"runId",
		"governedWorkflowGraphV2Compiler",
	);
	const workflowId = readNonBlankString(
		record,
		"workflowId",
		"governedWorkflowGraphV2Compiler",
	);
	const workflowRevision = readNonBlankString(
		record,
		"workflowRevision",
		"governedWorkflowGraphV2Compiler",
	);
	const graph = readClosedRecord(
		record.graph,
		"governedWorkflowGraphV2Compiler.graph",
		UNIT_GRAPH_FIELDS,
	);
	const nodeInputs = readDenseDataArray(
		graph.nodes,
		"governedWorkflowGraphV2Compiler.graph.nodes",
		"governedWorkflowGraphV2Compiler.graph.nodes must be an array",
		(index) =>
			`governedWorkflowGraphV2Compiler.graph.nodes[${index}] must be an own array element`,
	);
	if (nodeInputs.length === 0) {
		throw new TypeError(
			"governedWorkflowGraphV2Compiler.graph.nodes must contain at least one node",
		);
	}
	const maxConcurrent =
		graph.maxConcurrent === undefined
			? 2
			: readPositiveU32(
					graph,
					"maxConcurrent",
					"governedWorkflowGraphV2Compiler.graph",
				);
	const nodes = compileWorkflowGraphNodesV2(nodeInputs);
	const idempotencyKey =
		record.idempotencyKey === undefined
			? `graph-v2:${workflowId}:${workflowRevision}`
			: readNonBlankString(
					record,
					"idempotencyKey",
					"governedWorkflowGraphV2Compiler",
				);
	const declaration = {
		runId,
		workflowId,
		workflowRevision,
		nodes,
		maxConcurrent,
		idempotencyKey,
		declaredAt: readRfc3339UtcTimestamp(
			record,
			"declaredAt",
			"governedWorkflowGraphV2Compiler",
		).value,
	};
	return parseWorkflowGraphDeclaredV2({
		...declaration,
		graphDigest: canonicalWorkflowGraphV2Digest(declaration),
	});
}

function readDispatchEnvelopeV4Fields(
	record: Record<string, unknown>,
): Omit<DispatchEnvelopeV4, "schemaVersion" | "envelopeDigest"> {
	const dispatchV3 = parseDispatchEnvelopeV3(record.dispatchV3);
	assertV4AuthorityTimestampPrecision(dispatchV3);
	if (
		dispatchV3.body.trustTier !== "governed" ||
		dispatchV3.body.commitMode !== "atomic" ||
		dispatchV3.actionEvidenceVersion !== "sealed_v3"
	) {
		throw new TypeError(
			"dispatchEnvelopeV4 requires governed atomic sealed_v3 authority",
		);
	}
	return {
		dispatchV3,
		workflowGraphDigest: readSha256Digest(
			record,
			"workflowGraphDigest",
			"dispatchEnvelopeV4",
		),
		workflowGraphDeclarationEventRef: readCanonicalUuid(
			record,
			"workflowGraphDeclarationEventRef",
			"dispatchEnvelopeV4",
		),
	};
}

/**
 * V4 is replayed by the native reducer, whose RFC3339 representation is
 * nanosecond-precise. Keep this restriction at the additive V4 boundary so
 * historical V1–V3 envelope parsing remains byte-compatible.
 */
function assertV4AuthorityTimestampPrecision(
	dispatch: DispatchEnvelopeV3,
): void {
	assertRfc3339UtcFractionalSecondPrecision(
		dispatch.body.issuedAt,
		"dispatchEnvelopeV4.dispatchV3.body.issuedAt",
	);
	assertRfc3339UtcFractionalSecondPrecision(
		dispatch.body.expiresAt,
		"dispatchEnvelopeV4.dispatchV3.body.expiresAt",
	);
}

function assertRfc3339UtcFractionalSecondPrecision(
	value: string,
	label: string,
): void {
	const fraction = RFC3339_UTC_PATTERN.exec(value)?.[7] ?? "";
	if (fraction.length > 9) {
		throw new TypeError(
			`${label} fractional seconds must contain at most 9 digits`,
		);
	}
}

function readWorkflowGraphDeclaredV2Fields(
	record: Record<string, unknown>,
): Omit<WorkflowGraphDeclaredV2, "graphDigest"> {
	return {
		runId: readNonBlankString(record, "runId", "workflowGraphDeclaredV2"),
		workflowId: readNonBlankString(
			record,
			"workflowId",
			"workflowGraphDeclaredV2",
		),
		workflowRevision: readNonBlankString(
			record,
			"workflowRevision",
			"workflowGraphDeclaredV2",
		),
		nodes: readWorkflowGraphNodesV2(record.nodes),
		maxConcurrent: readPositiveU32(
			record,
			"maxConcurrent",
			"workflowGraphDeclaredV2",
		),
		idempotencyKey: readNonBlankString(
			record,
			"idempotencyKey",
			"workflowGraphDeclaredV2",
		),
		declaredAt: readRfc3339UtcTimestamp(
			record,
			"declaredAt",
			"workflowGraphDeclaredV2",
		).value,
	};
}

function readWorkflowGraphNodesV2(
	input: unknown,
): readonly WorkflowGraphNodeV2[] {
	const entries = readDenseDataArray(
		input,
		"workflowGraphDeclaredV2.nodes",
		"workflowGraphDeclaredV2.nodes must be an array",
		(index) =>
			`workflowGraphDeclaredV2.nodes[${index}] must be an own array element`,
	);
	if (entries.length === 0) {
		throw new TypeError(
			"workflowGraphDeclaredV2.nodes must contain at least one node",
		);
	}
	const nodes: WorkflowGraphNodeV2[] = [];
	const nodeIds = new Set<string>();
	let priorUnitId: string | undefined;
	for (let index = 0; index < entries.length; index += 1) {
		const label = `workflowGraphDeclaredV2.nodes[${index}]`;
		const record = readClosedRecord(
			entries[index],
			label,
			WORKFLOW_GRAPH_NODE_V2_FIELDS,
		);
		const unitId = readAsciiGraphIdentifier(record, "unitId", label);
		if (nodeIds.has(unitId)) {
			throw new TypeError(
				`workflowGraphDeclaredV2.nodes must not contain duplicate unitId "${unitId}"`,
			);
		}
		if (priorUnitId !== undefined && priorUnitId >= unitId) {
			throw new TypeError(
				"workflowGraphDeclaredV2.nodes must be in strict lexical unitId order",
			);
		}
		const dependsOn = readWorkflowGraphDependenciesV2(
			record.dependsOn,
			label,
			unitId,
		);
		nodeIds.add(unitId);
		priorUnitId = unitId;
		nodes.push({
			unitId,
			dependsOn,
			executionRole: readEnum(record, "executionRole", label, EXECUTION_ROLES),
			governedPacketDigest: readSha256Digest(
				record,
				"governedPacketDigest",
				label,
			),
		});
	}
	assertWorkflowGraphV2ReferencesAndAcyclic(nodes, nodeIds);
	return nodes;
}

function readWorkflowGraphDependenciesV2(
	input: unknown,
	label: string,
	unitId: string,
): readonly string[] {
	const entries = readDenseDataArray(
		input,
		`${label}.dependsOn`,
		`${label}.dependsOn must be an array`,
		(index) => `${label}.dependsOn[${index}] must be an own array element`,
	);
	const dependencies: string[] = [];
	const seen = new Set<string>();
	let prior: string | undefined;
	for (let index = 0; index < entries.length; index += 1) {
		const dependency = readAsciiGraphIdentifierValue(
			entries[index],
			`${label}.dependsOn[${index}]`,
		);
		if (dependency === unitId) {
			throw new TypeError(`${label}.dependsOn must not contain its own unitId`);
		}
		if (seen.has(dependency)) {
			throw new TypeError(
				`${label}.dependsOn must not contain duplicate dependency "${dependency}"`,
			);
		}
		if (prior !== undefined && prior >= dependency) {
			throw new TypeError(`${label}.dependsOn must be in strict lexical order`);
		}
		seen.add(dependency);
		prior = dependency;
		dependencies.push(dependency);
	}
	return dependencies;
}

function assertWorkflowGraphV2ReferencesAndAcyclic(
	nodes: readonly WorkflowGraphNodeV2[],
	nodeIds: ReadonlySet<string>,
): void {
	for (const node of nodes) {
		for (const dependency of node.dependsOn) {
			if (!nodeIds.has(dependency)) {
				throw new TypeError(
					"workflowGraphDeclaredV2 dependency references an unknown unitId",
				);
			}
		}
	}
	if (workflowGraphV2HasCycle(nodes)) {
		throw new TypeError(
			"workflowGraphDeclaredV2 dependencies must not contain a cycle",
		);
	}
}

function workflowGraphV2HasCycle(
	nodes: readonly WorkflowGraphNodeV2[],
): boolean {
	const inDegree = new Map<string, number>();
	const dependents = new Map<string, string[]>();
	for (const node of nodes) {
		inDegree.set(node.unitId, node.dependsOn.length);
		for (const dependency of node.dependsOn) {
			const waiting = dependents.get(dependency) ?? [];
			waiting.push(node.unitId);
			dependents.set(dependency, waiting);
		}
	}
	const ready = [...inDegree]
		.filter(([, degree]) => degree === 0)
		.map(([unitId]) => unitId);
	let visited = 0;
	for (let index = 0; index < ready.length; index += 1) {
		const unitId = ready[index];
		visited += 1;
		for (const dependent of dependents.get(unitId) ?? []) {
			const remaining = (inDegree.get(dependent) ?? 0) - 1;
			inDegree.set(dependent, remaining);
			if (remaining === 0) ready.push(dependent);
		}
	}
	return visited !== nodes.length;
}

function compileWorkflowGraphNodesV2(
	entries: readonly unknown[],
): readonly WorkflowGraphNodeV2[] {
	const nodes: WorkflowGraphNodeV2[] = [];
	const seenUnitIds = new Set<string>();
	for (let index = 0; index < entries.length; index += 1) {
		const label = `governedWorkflowGraphV2Compiler.graph.nodes[${index}]`;
		const node = readOpenDataRecord(entries[index], label);
		const packet = Object.create(null) as Record<string, unknown>;
		for (const key of Object.getOwnPropertyNames(node)) {
			if (key !== "dependsOn") packet[key] = node[key];
		}
		let governedPacket: ReturnType<typeof parseGovernedUnitPacket>;
		try {
			governedPacket = parseGovernedUnitPacket(JSON.stringify(packet));
		} catch (error) {
			throw new TypeError(
				`${label} must contain a strictly admitted governed packet: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		const unit = readOpenDataRecord(governedPacket.unit, `${label}.unit`);
		const unitId = readAsciiGraphIdentifier(unit, "id", `${label}.unit`);
		if (seenUnitIds.has(unitId)) {
			throw new TypeError(
				`governedWorkflowGraphV2Compiler.graph.nodes must not contain duplicate unit id "${unitId}"`,
			);
		}
		seenUnitIds.add(unitId);
		const rawDependencies =
			node.dependsOn === undefined
				? []
				: readCompilerWorkflowGraphDependencies(node.dependsOn, label, unitId);
		const dependsOn = [...rawDependencies].sort(compareLexically);
		nodes.push({
			unitId,
			dependsOn,
			executionRole: governedPacket.execution_role,
			governedPacketDigest: canonicalGovernedUnitPacketV1Digest(governedPacket),
		});
	}
	return nodes.sort((left, right) =>
		compareLexically(left.unitId, right.unitId),
	);
}

function readCompilerWorkflowGraphDependencies(
	input: unknown,
	label: string,
	unitId: string,
): readonly string[] {
	const entries = readDenseDataArray(
		input,
		`${label}.dependsOn`,
		`${label}.dependsOn must be an array when provided`,
		(index) => `${label}.dependsOn[${index}] must be an own array element`,
	);
	const dependencies: string[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < entries.length; index += 1) {
		const dependency = readAsciiGraphIdentifierValue(
			entries[index],
			`${label}.dependsOn[${index}]`,
		);
		if (dependency === unitId) {
			throw new TypeError(
				`${label}.dependsOn must not contain its own unit id`,
			);
		}
		if (seen.has(dependency)) {
			throw new TypeError(
				`${label}.dependsOn must not contain duplicate dependency "${dependency}"`,
			);
		}
		seen.add(dependency);
		dependencies.push(dependency);
	}
	return dependencies;
}

function compareLexically(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function parseDispatchEnvelopeBodyV2(input: unknown): DispatchEnvelopeBodyV2 {
	const record = readClosedRecord(
		input,
		"dispatchEnvelopeV2.body",
		DISPATCH_ENVELOPE_BODY_V2_FIELDS,
	);
	const issuedAt = readRfc3339UtcTimestamp(
		record,
		"issuedAt",
		"dispatchEnvelopeV2.body",
	);
	const expiresAt = readRfc3339UtcTimestamp(
		record,
		"expiresAt",
		"dispatchEnvelopeV2.body",
	);
	if (compareRfc3339UtcTimestamps(expiresAt, issuedAt) <= 0) {
		throw new TypeError(
			"dispatchEnvelopeV2.body.expiresAt must be later than issuedAt",
		);
	}

	return {
		workflowId: readRequiredString(
			record,
			"workflowId",
			"dispatchEnvelopeV2.body",
		),
		workflowRevision: readRequiredString(
			record,
			"workflowRevision",
			"dispatchEnvelopeV2.body",
		),
		unitId: readRequiredString(record, "unitId", "dispatchEnvelopeV2.body"),
		attempt: readPositiveU32(record, "attempt", "dispatchEnvelopeV2.body"),
		executionRole: readEnum(
			record,
			"executionRole",
			"dispatchEnvelopeV2.body",
			EXECUTION_ROLES,
		),
		commitMode: readEnum(
			record,
			"commitMode",
			"dispatchEnvelopeV2.body",
			COMMIT_MODES,
		),
		provenanceRef: readRequiredString(
			record,
			"provenanceRef",
			"dispatchEnvelopeV2.body",
		),
		baseCommitSha: readCommitSha(
			record,
			"baseCommitSha",
			"dispatchEnvelopeV2.body",
		),
		capabilityBundleDigest: readSha256Digest(
			record,
			"capabilityBundleDigest",
			"dispatchEnvelopeV2.body",
		),
		acceptanceContractDigest: readSha256Digest(
			record,
			"acceptanceContractDigest",
			"dispatchEnvelopeV2.body",
		),
		contextManifestDigest: readSha256Digest(
			record,
			"contextManifestDigest",
			"dispatchEnvelopeV2.body",
		),
		workerManifestDigest: readSha256Digest(
			record,
			"workerManifestDigest",
			"dispatchEnvelopeV2.body",
		),
		sandboxProfileDigest: readSha256Digest(
			record,
			"sandboxProfileDigest",
			"dispatchEnvelopeV2.body",
		),
		budget: readDispatchBudget(record.budget),
		trustTier: readEnum(
			record,
			"trustTier",
			"dispatchEnvelopeV2.body",
			TRUST_TIERS,
		),
		idempotencyKey: readRequiredString(
			record,
			"idempotencyKey",
			"dispatchEnvelopeV2.body",
		),
		issuedAt: issuedAt.value,
		expiresAt: expiresAt.value,
	};
}

export function parseCandidateArtifactV1(input: unknown): CandidateArtifactV1 {
	const record = readClosedRecord(
		input,
		"candidateArtifact",
		CANDIDATE_ARTIFACT_FIELDS,
	);

	return {
		schemaVersion: readSchemaVersion(record, "candidateArtifact"),
		workflowId: readRequiredString(record, "workflowId", "candidateArtifact"),
		unitId: readRequiredString(record, "unitId", "candidateArtifact"),
		attempt: readPositiveSafeInteger(record, "attempt", "candidateArtifact"),
		provenanceRef: readRequiredString(
			record,
			"provenanceRef",
			"candidateArtifact",
		),
		candidateDigest: readSha256Digest(
			record,
			"candidateDigest",
			"candidateArtifact",
		),
		baseCommitSha: readCommitSha(record, "baseCommitSha", "candidateArtifact"),
		candidateCommitSha: readCommitSha(
			record,
			"candidateCommitSha",
			"candidateArtifact",
		),
		treeDigest: readSha256Digest(record, "treeDigest", "candidateArtifact"),
		patchDigest: readSha256Digest(record, "patchDigest", "candidateArtifact"),
		changedFilesDigest: readSha256Digest(
			record,
			"changedFilesDigest",
			"candidateArtifact",
		),
		envelopeDigest: readSha256Digest(
			record,
			"envelopeDigest",
			"candidateArtifact",
		),
		actionReceiptDigest: readSha256Digest(
			record,
			"actionReceiptDigest",
			"candidateArtifact",
		),
	};
}

/** Parse a closed V2 candidate binding to one sealed action-receipt set. */
export function parseCandidateArtifactV2(input: unknown): CandidateArtifactV2 {
	const record = readClosedRecord(
		input,
		"candidateArtifactV2",
		CANDIDATE_ARTIFACT_V2_FIELDS,
	);
	if (!hasOwnField(record, "schemaVersion") || record.schemaVersion !== 2) {
		throw new TypeError("candidateArtifactV2.schemaVersion must be 2");
	}
	return {
		schemaVersion: 2,
		workflowId: readRequiredString(record, "workflowId", "candidateArtifactV2"),
		unitId: readRequiredString(record, "unitId", "candidateArtifactV2"),
		attempt: readPositiveSafeInteger(record, "attempt", "candidateArtifactV2"),
		provenanceRef: readRequiredString(
			record,
			"provenanceRef",
			"candidateArtifactV2",
		),
		candidateDigest: readSha256Digest(
			record,
			"candidateDigest",
			"candidateArtifactV2",
		),
		baseCommitSha: readCommitSha(
			record,
			"baseCommitSha",
			"candidateArtifactV2",
		),
		candidateCommitSha: readCommitSha(
			record,
			"candidateCommitSha",
			"candidateArtifactV2",
		),
		commitDigest: readSha256Digest(
			record,
			"commitDigest",
			"candidateArtifactV2",
		),
		treeDigest: readSha256Digest(record, "treeDigest", "candidateArtifactV2"),
		patchDigest: readSha256Digest(record, "patchDigest", "candidateArtifactV2"),
		changedFilesDigest: readSha256Digest(
			record,
			"changedFilesDigest",
			"candidateArtifactV2",
		),
		envelopeDigest: readSha256Digest(
			record,
			"envelopeDigest",
			"candidateArtifactV2",
		),
		actionReceiptSetRef: readRequiredString(
			record,
			"actionReceiptSetRef",
			"candidateArtifactV2",
		),
		actionReceiptSetDigest: readSha256Digest(
			record,
			"actionReceiptSetDigest",
			"candidateArtifactV2",
		),
	};
}

/** Parse the additive V2 candidate-created tape payload. */
export function parseCandidateCreatedV2(input: unknown): CandidateCreatedV2 {
	const record = readClosedRecord(
		input,
		"candidateCreatedV2",
		CANDIDATE_CREATED_V2_FIELDS,
	);
	return {
		runId: readRequiredString(record, "runId", "candidateCreatedV2"),
		candidateId: readRequiredString(
			record,
			"candidateId",
			"candidateCreatedV2",
		),
		candidateRef: readCanonicalBuildplaneCandidateRef(
			record,
			"candidateRef",
			"candidateCreatedV2",
		),
		workflowId: readRequiredString(record, "workflowId", "candidateCreatedV2"),
		unitId: readRequiredString(record, "unitId", "candidateCreatedV2"),
		attempt: readPositiveSafeInteger(record, "attempt", "candidateCreatedV2"),
		provenanceRef: readRequiredString(
			record,
			"provenanceRef",
			"candidateCreatedV2",
		),
		candidateDigest: readSha256Digest(
			record,
			"candidateDigest",
			"candidateCreatedV2",
		),
		baseCommitSha: readCommitSha(record, "baseCommitSha", "candidateCreatedV2"),
		candidateCommitSha: readCommitSha(
			record,
			"candidateCommitSha",
			"candidateCreatedV2",
		),
		commitDigest: readSha256Digest(
			record,
			"commitDigest",
			"candidateCreatedV2",
		),
		treeDigest: readSha256Digest(record, "treeDigest", "candidateCreatedV2"),
		patchDigest: readSha256Digest(record, "patchDigest", "candidateCreatedV2"),
		changedFilesDigest: readSha256Digest(
			record,
			"changedFilesDigest",
			"candidateCreatedV2",
		),
		envelopeDigest: readSha256Digest(
			record,
			"envelopeDigest",
			"candidateCreatedV2",
		),
		actionReceiptSetRef: readRequiredString(
			record,
			"actionReceiptSetRef",
			"candidateCreatedV2",
		),
		actionReceiptSetDigest: readSha256Digest(
			record,
			"actionReceiptSetDigest",
			"candidateCreatedV2",
		),
	};
}

/** Parse a closed candidate-completion event and verify its detached digest. */
export function parseCandidateCompletionRecordedV1(
	input: unknown,
): CandidateCompletionRecordedV1 {
	const record = readClosedRecord(
		input,
		"candidateCompletionRecordedV1",
		CANDIDATE_COMPLETION_RECORDED_V1_FIELDS,
	);
	const completion = readCandidateCompletionRecordedV1Fields(record);
	const completionDigest = readSha256Digest(
		record,
		"completionDigest",
		"candidateCompletionRecordedV1",
	);
	if (
		completionDigest !==
		canonicalCandidateCompletionRecordedV1Digest(completion)
	) {
		throw new TypeError(
			"candidateCompletionRecordedV1.completionDigest must equal the canonical candidate-completion digest",
		);
	}
	return { ...completion, completionDigest };
}
/**
 * Parses closed reviewer output as structural evidence only. An `approve`
 * decision does not grant promotion authority; signed replay must bind it to
 * the candidate, acceptance evidence, and an authorized promotion decision.
 */
export function parseReviewVerdictV1(input: unknown): ReviewVerdictV1 {
	const record = readClosedRecord(
		input,
		"reviewVerdict",
		REVIEW_VERDICT_FIELDS,
	);

	return {
		schemaVersion: readSchemaVersion(record, "reviewVerdict"),
		candidateDigest: readSha256Digest(
			record,
			"candidateDigest",
			"reviewVerdict",
		),
		decision: readEnum(record, "decision", "reviewVerdict", REVIEW_DECISIONS),
		findings: readReviewFindings(record.findings),
		confidence: readConfidence(record, "confidence", "reviewVerdict"),
		reviewerManifestDigest: readSha256Digest(
			record,
			"reviewerManifestDigest",
			"reviewVerdict",
		),
	};
}

/**
 * Candidate refs are capability-bearing Git identifiers, not arbitrary paths.
 * Keep every candidate/view/review parser on the same strict Buildplane-only
 * namespace so traversal-shaped or non-canonical references cannot become a
 * later mount, checkout, or promotion selector.
 */
export function isCanonicalBuildplaneCandidateRef(
	candidateRef: unknown,
): candidateRef is string {
	if (
		typeof candidateRef !== "string" ||
		candidateRef.length === 0 ||
		candidateRef.trim() !== candidateRef ||
		!candidateRef.startsWith(BUILDPANE_CANDIDATE_REF_PREFIX) ||
		candidateRef.includes("..") ||
		candidateRef.includes("//") ||
		candidateRef.includes("@{")
	) {
		return false;
	}

	const suffix = candidateRef.slice(BUILDPANE_CANDIDATE_REF_PREFIX.length);
	return (
		suffix.length > 0 &&
		suffix
			.split("/")
			.every(
				(segment) =>
					segment.length > 0 &&
					BUILDPANE_CANDIDATE_REF_SEGMENT.test(segment) &&
					!segment.startsWith(".") &&
					!segment.endsWith(".") &&
					!segment.endsWith(".lock"),
			)
	);
}

/**
 * Parse the exact immutable, read-only candidate view embedded in V2 review
 * evidence. This verifies only the local closed contract; native replay still
 * proves that the view belongs to the signed candidate and reviewer dispatch.
 */
export function parseCandidateViewV1(input: unknown): CandidateViewV1 {
	const record = readClosedRecord(
		input,
		"candidateViewV1",
		CANDIDATE_VIEW_V1_FIELDS,
	);
	const candidateRef = readCanonicalBuildplaneCandidateRef(
		record,
		"candidateRef",
		"candidateViewV1",
	);
	const readOnly = record.readOnly;
	if (!hasOwnField(record, "readOnly") || typeof readOnly !== "boolean") {
		throw new TypeError("candidateViewV1.readOnly must be a boolean");
	}
	const networkDisabled = record.networkDisabled;
	if (
		!hasOwnField(record, "networkDisabled") ||
		typeof networkDisabled !== "boolean"
	) {
		throw new TypeError("candidateViewV1.networkDisabled must be a boolean");
	}
	if (!readOnly || !networkDisabled) {
		throw new TypeError(
			"candidateViewV1 must be read-only with network disabled",
		);
	}
	return {
		candidateRef,
		candidateDigest: readSha256Digest(
			record,
			"candidateDigest",
			"candidateViewV1",
		),
		candidateCommitSha: readCommitSha(
			record,
			"candidateCommitSha",
			"candidateViewV1",
		),
		treeDigest: readSha256Digest(record, "treeDigest", "candidateViewV1"),
		reviewerContextManifestDigest: readSha256Digest(
			record,
			"reviewerContextManifestDigest",
			"candidateViewV1",
		),
		reviewerSandboxProfileDigest: readSha256Digest(
			record,
			"reviewerSandboxProfileDigest",
			"candidateViewV1",
		),
		mountPathDigest: readSha256Digest(
			record,
			"mountPathDigest",
			"candidateViewV1",
		),
		readOnly,
		networkDisabled,
	};
}

/**
 * Parse the additive, evidence-complete V2 review event. The returned value
 * remains an untrusted structural projection until native signed replay has
 * verified the candidate, reviewer activity, acceptance, and signer lineage.
 */
export function parseReviewVerdictRecordedV2(
	input: unknown,
): ReviewVerdictRecordedV2 {
	const record = readClosedRecord(
		input,
		"reviewVerdictRecordedV2",
		REVIEW_VERDICT_RECORDED_V2_FIELDS,
	);
	const candidateView = parseCandidateViewV1(record.candidateView);
	const candidateDigest = readSha256Digest(
		record,
		"candidateDigest",
		"reviewVerdictRecordedV2",
	);
	const candidateCommitSha = readCommitSha(
		record,
		"candidateCommitSha",
		"reviewVerdictRecordedV2",
	);
	const candidateViewDigest = readSha256Digest(
		record,
		"candidateViewDigest",
		"reviewVerdictRecordedV2",
	);
	if (candidateViewDigest !== canonicalCandidateViewV1Digest(candidateView)) {
		throw new TypeError(
			"reviewVerdictRecordedV2.candidateViewDigest must equal the canonical candidate view digest",
		);
	}
	if (
		candidateView.candidateDigest !== candidateDigest ||
		candidateView.candidateCommitSha !== candidateCommitSha
	) {
		throw new TypeError(
			"reviewVerdictRecordedV2.candidateView must bind the exact candidate digest and commit",
		);
	}
	const verdict = parseReviewVerdictV1({
		schemaVersion: 1,
		candidateDigest,
		decision: record.decision,
		findings: record.findings,
		confidence: record.confidence,
		reviewerManifestDigest: record.reviewerManifestDigest,
	});
	const reviewOutputDigest = readSha256Digest(
		record,
		"reviewOutputDigest",
		"reviewVerdictRecordedV2",
	);
	const reviewOutputRef = readNonBlankString(
		record,
		"reviewOutputRef",
		"reviewVerdictRecordedV2",
	);
	if (reviewOutputRef !== `cas:${reviewOutputDigest}`) {
		throw new TypeError(
			"reviewVerdictRecordedV2.reviewOutputRef must be the exact CAS reference for reviewOutputDigest",
		);
	}
	if (
		reviewOutputDigest !==
		canonicalReviewVerdictOutputV1Digest({
			candidateDigest,
			candidateCommitSha,
			decision: verdict.decision,
			findings: verdict.findings,
			confidence: verdict.confidence,
			candidateViewDigest,
		})
	) {
		throw new TypeError(
			"reviewVerdictRecordedV2.reviewOutputDigest must equal the canonical closed review output digest",
		);
	}
	const reviewedAt = readRfc3339UtcTimestamp(
		record,
		"reviewedAt",
		"reviewVerdictRecordedV2",
	);
	return {
		runId: readNonBlankString(record, "runId", "reviewVerdictRecordedV2"),
		workflowId: readNonBlankString(
			record,
			"workflowId",
			"reviewVerdictRecordedV2",
		),
		unitId: readNonBlankString(record, "unitId", "reviewVerdictRecordedV2"),
		attempt: readPositiveSafeInteger(
			record,
			"attempt",
			"reviewVerdictRecordedV2",
		),
		provenanceRef: readNonBlankString(
			record,
			"provenanceRef",
			"reviewVerdictRecordedV2",
		),
		candidateDigest,
		candidateCommitSha,
		reviewRef: readNonBlankString(
			record,
			"reviewRef",
			"reviewVerdictRecordedV2",
		),
		reviewVerdictActionId: readNonBlankString(
			record,
			"reviewVerdictActionId",
			"reviewVerdictRecordedV2",
		),
		reviewActionRequestDigest: readSha256Digest(
			record,
			"reviewActionRequestDigest",
			"reviewVerdictRecordedV2",
		),
		reviewActionReceiptRef: readNonBlankString(
			record,
			"reviewActionReceiptRef",
			"reviewVerdictRecordedV2",
		),
		reviewActionReceiptDigest: readSha256Digest(
			record,
			"reviewActionReceiptDigest",
			"reviewVerdictRecordedV2",
		),
		reviewOutputRef,
		reviewOutputDigest,
		decision: verdict.decision,
		findings: verdict.findings,
		confidence: verdict.confidence,
		acceptanceRef: readNonBlankString(
			record,
			"acceptanceRef",
			"reviewVerdictRecordedV2",
		),
		acceptanceDigest: readSha256Digest(
			record,
			"acceptanceDigest",
			"reviewVerdictRecordedV2",
		),
		acceptanceContractDigest: readSha256Digest(
			record,
			"acceptanceContractDigest",
			"reviewVerdictRecordedV2",
		),
		candidateEnvelopeDigest: readSha256Digest(
			record,
			"candidateEnvelopeDigest",
			"reviewVerdictRecordedV2",
		),
		reviewerWorkflowId: readNonBlankString(
			record,
			"reviewerWorkflowId",
			"reviewVerdictRecordedV2",
		),
		reviewerDispatchEnvelopeDigest: readSha256Digest(
			record,
			"reviewerDispatchEnvelopeDigest",
			"reviewVerdictRecordedV2",
		),
		reviewerUnitId: readNonBlankString(
			record,
			"reviewerUnitId",
			"reviewVerdictRecordedV2",
		),
		reviewerAttempt: readPositiveSafeInteger(
			record,
			"reviewerAttempt",
			"reviewVerdictRecordedV2",
		),
		reviewerExecutionRole: readEnum(
			record,
			"reviewerExecutionRole",
			"reviewVerdictRecordedV2",
			REVIEWER_EXECUTION_ROLES,
		),
		reviewActionReceiptSetRef: readNonBlankString(
			record,
			"reviewActionReceiptSetRef",
			"reviewVerdictRecordedV2",
		),
		reviewActionReceiptSetDigest: readSha256Digest(
			record,
			"reviewActionReceiptSetDigest",
			"reviewVerdictRecordedV2",
		),
		candidateView,
		candidateViewRef: readNonBlankString(
			record,
			"candidateViewRef",
			"reviewVerdictRecordedV2",
		),
		candidateViewDigest,
		reviewerManifestDigest: verdict.reviewerManifestDigest,
		reviewerAuthority: readNonBlankString(
			record,
			"reviewerAuthority",
			"reviewVerdictRecordedV2",
		),
		reviewedAt: reviewedAt.value,
	};
}

/**
 * Structural parser only. A returned request is not merge authorization:
 * verify its signed ledger event and workflow state before accepting an
 * operator decision.
 */
export function parsePromotionApprovalRequestedV1(
	input: unknown,
): PromotionApprovalRequestedV1 {
	const record = readClosedRecord(
		input,
		"promotionApprovalRequest",
		PROMOTION_APPROVAL_REQUEST_FIELDS,
	);
	const targetRef = readOptionalTargetRef(
		record,
		"targetRef",
		"promotionApprovalRequest",
	);
	if (targetRef === undefined) {
		throw new TypeError(
			"promotionApprovalRequest.targetRef must be a canonical refs/heads branch ref",
		);
	}
	const requestedAt = readRfc3339UtcTimestamp(
		record,
		"requestedAt",
		"promotionApprovalRequest",
	);
	return {
		schemaVersion: readSchemaVersion(record, "promotionApprovalRequest"),
		candidateDigest: readSha256Digest(
			record,
			"candidateDigest",
			"promotionApprovalRequest",
		),
		baseCommitSha: readCommitSha(
			record,
			"baseCommitSha",
			"promotionApprovalRequest",
		),
		targetRef,
		envelopeDigest: readSha256Digest(
			record,
			"envelopeDigest",
			"promotionApprovalRequest",
		),
		acceptanceRef: readRequiredString(
			record,
			"acceptanceRef",
			"promotionApprovalRequest",
		),
		reviewRefs: readNonEmptyStringArray(
			record,
			"reviewRefs",
			"promotionApprovalRequest",
		),
		requestedBy: readRequiredString(
			record,
			"requestedBy",
			"promotionApprovalRequest",
		),
		requestedAt: requestedAt.value,
		idempotencyKey: readRequiredString(
			record,
			"idempotencyKey",
			"promotionApprovalRequest",
		),
	};
}

/**
 * Structural parser only. A returned decision is not merge authorization:
 * verify the signed ledger and authority policy before causing an effect.
 */
export function parsePromotionDecisionV1(input: unknown): PromotionDecisionV1 {
	const record = readClosedRecord(
		input,
		"promotionDecision",
		PROMOTION_DECISION_FIELDS,
	);

	const decidedAt = readRfc3339UtcTimestamp(
		record,
		"decidedAt",
		"promotionDecision",
	);
	const targetRef = readOptionalTargetRef(
		record,
		"targetRef",
		"promotionDecision",
	);
	const promotionApprovalRequestRef = readOptionalRequiredString(
		record,
		"promotionApprovalRequestRef",
		"promotionDecision",
	);

	return {
		schemaVersion: readSchemaVersion(record, "promotionDecision"),
		candidateDigest: readSha256Digest(
			record,
			"candidateDigest",
			"promotionDecision",
		),
		baseCommitSha: readCommitSha(record, "baseCommitSha", "promotionDecision"),
		...(targetRef === undefined ? {} : { targetRef }),
		envelopeDigest: readSha256Digest(
			record,
			"envelopeDigest",
			"promotionDecision",
		),
		acceptanceRef: readRequiredString(
			record,
			"acceptanceRef",
			"promotionDecision",
		),
		reviewRefs: readNonEmptyStringArray(
			record,
			"reviewRefs",
			"promotionDecision",
		),
		...(promotionApprovalRequestRef === undefined
			? {}
			: { promotionApprovalRequestRef }),
		decision: readEnum(
			record,
			"decision",
			"promotionDecision",
			PROMOTION_DECISIONS,
		),
		authority: readRequiredString(record, "authority", "promotionDecision"),
		decidedBy: readRequiredString(record, "decidedBy", "promotionDecision"),
		decidedAt: decidedAt.value,
		idempotencyKey: readRequiredString(
			record,
			"idempotencyKey",
			"promotionDecision",
		),
	};
}

/**
 * Validates the additional identity binding required before emitting a new
 * signed promotion decision. The structural parser intentionally remains
 * replay-compatible with historical records; callers creating authority must
 * use this stricter entry point.
 */
export function parseSignablePromotionDecisionV1(
	input: unknown,
): PromotionDecisionV1 {
	const decision = parsePromotionDecisionV1(input);
	if (decision.authority !== decision.decidedBy) {
		throw new TypeError(
			"promotionDecision.authority must equal promotionDecision.decidedBy for a signable promotion decision",
		);
	}
	return decision;
}

/** Parse a closed, effect-free action request before gateway authorization. */
export function parseActionRequestV1(input: unknown): ActionRequestV1 {
	const record = readClosedRecord(
		input,
		"actionRequest",
		ACTION_REQUEST_FIELDS,
	);
	const requestedAt = readRfc3339UtcTimestamp(
		record,
		"requestedAt",
		"actionRequest",
	);
	return {
		schemaVersion: readSchemaVersion(record, "actionRequest"),
		workflowId: readRequiredString(record, "workflowId", "actionRequest"),
		unitId: readRequiredString(record, "unitId", "actionRequest"),
		attempt: readPositiveSafeInteger(record, "attempt", "actionRequest"),
		provenanceRef: readRequiredString(record, "provenanceRef", "actionRequest"),
		actionId: readRequiredString(record, "actionId", "actionRequest"),
		dispatchEnvelopeDigest: readSha256Digest(
			record,
			"dispatchEnvelopeDigest",
			"actionRequest",
		),
		capabilityBundleDigest: readSha256Digest(
			record,
			"capabilityBundleDigest",
			"actionRequest",
		),
		contextManifestDigest: readSha256Digest(
			record,
			"contextManifestDigest",
			"actionRequest",
		),
		workerManifestDigest: readSha256Digest(
			record,
			"workerManifestDigest",
			"actionRequest",
		),
		sandboxProfileDigest: readSha256Digest(
			record,
			"sandboxProfileDigest",
			"actionRequest",
		),
		authority: readRequiredString(record, "authority", "actionRequest"),
		idempotencyKey: readRequiredString(
			record,
			"idempotencyKey",
			"actionRequest",
		),
		requestedAt: requestedAt.value,
	};
}

/** Parse a closed action receipt. Receipt parsing never changes authorization. */
export function parseActionReceiptV1(input: unknown): ActionReceiptV1 {
	const record = readClosedRecord(
		input,
		"actionReceipt",
		ACTION_RECEIPT_FIELDS,
	);
	const completedAt = readRfc3339UtcTimestamp(
		record,
		"completedAt",
		"actionReceipt",
	);
	return {
		schemaVersion: readSchemaVersion(record, "actionReceipt"),
		workflowId: readRequiredString(record, "workflowId", "actionReceipt"),
		unitId: readRequiredString(record, "unitId", "actionReceipt"),
		attempt: readPositiveSafeInteger(record, "attempt", "actionReceipt"),
		provenanceRef: readRequiredString(record, "provenanceRef", "actionReceipt"),
		actionId: readRequiredString(record, "actionId", "actionReceipt"),
		actionRequestDigest: readSha256Digest(
			record,
			"actionRequestDigest",
			"actionReceipt",
		),
		dispatchEnvelopeDigest: readSha256Digest(
			record,
			"dispatchEnvelopeDigest",
			"actionReceipt",
		),
		candidateDigest: readSha256Digest(
			record,
			"candidateDigest",
			"actionReceipt",
		),
		contextManifestDigest: readSha256Digest(
			record,
			"contextManifestDigest",
			"actionReceipt",
		),
		workerManifestDigest: readSha256Digest(
			record,
			"workerManifestDigest",
			"actionReceipt",
		),
		sandboxProfileDigest: readSha256Digest(
			record,
			"sandboxProfileDigest",
			"actionReceipt",
		),
		authority: readRequiredString(record, "authority", "actionReceipt"),
		outcome: readEnum(record, "outcome", "actionReceipt", ACTION_OUTCOMES),
		evidenceDigest: readSha256Digest(record, "evidenceDigest", "actionReceipt"),
		completedAt: completedAt.value,
	};
}

/** Parse the write-ahead V2 action request without authorizing its effect. */
export function parseActionRequestedV2(input: unknown): ActionRequestedV2 {
	const record = readClosedRecord(
		input,
		"actionRequestedV2",
		ACTION_REQUEST_V2_FIELDS,
	);
	if (!hasOwnField(record, "schemaVersion") || record.schemaVersion !== 2) {
		throw new TypeError("actionRequestedV2.schemaVersion must be 2");
	}
	const requestedAt = readRfc3339UtcTimestamp(
		record,
		"requestedAt",
		"actionRequestedV2",
	);
	return {
		schemaVersion: 2,
		runId: readRequiredString(record, "runId", "actionRequestedV2"),
		workflowId: readRequiredString(record, "workflowId", "actionRequestedV2"),
		unitId: readRequiredString(record, "unitId", "actionRequestedV2"),
		attempt: readPositiveSafeInteger(record, "attempt", "actionRequestedV2"),
		provenanceRef: readRequiredString(
			record,
			"provenanceRef",
			"actionRequestedV2",
		),
		actionId: readRequiredString(record, "actionId", "actionRequestedV2"),
		idempotencyKey: readRequiredString(
			record,
			"idempotencyKey",
			"actionRequestedV2",
		),
		actionKind: readEnum(
			record,
			"actionKind",
			"actionRequestedV2",
			ACTION_KINDS_V2,
		),
		canonicalInputDigest: readSha256Digest(
			record,
			"canonicalInputDigest",
			"actionRequestedV2",
		),
		canonicalInputRef: readRequiredString(
			record,
			"canonicalInputRef",
			"actionRequestedV2",
		),
		dispatchEnvelopeDigest: readSha256Digest(
			record,
			"dispatchEnvelopeDigest",
			"actionRequestedV2",
		),
		repositoryBindingDigest: readSha256Digest(
			record,
			"repositoryBindingDigest",
			"actionRequestedV2",
		),
		ledgerAuthorityRealmDigest: readSha256Digest(
			record,
			"ledgerAuthorityRealmDigest",
			"actionRequestedV2",
		),
		...(record.governedPacketDigest === undefined
			? {}
			: {
					governedPacketDigest: readSha256Digest(
						record,
						"governedPacketDigest",
						"actionRequestedV2",
					),
				}),
		capabilityBundleDigest: readSha256Digest(
			record,
			"capabilityBundleDigest",
			"actionRequestedV2",
		),
		policyDigest: readSha256Digest(record, "policyDigest", "actionRequestedV2"),
		contextManifestDigest: readSha256Digest(
			record,
			"contextManifestDigest",
			"actionRequestedV2",
		),
		workerManifestDigest: readSha256Digest(
			record,
			"workerManifestDigest",
			"actionRequestedV2",
		),
		sandboxProfileDigest: readSha256Digest(
			record,
			"sandboxProfileDigest",
			"actionRequestedV2",
		),
		authorityActor: readRequiredString(
			record,
			"authorityActor",
			"actionRequestedV2",
		),
		executionRole: readEnum(
			record,
			"executionRole",
			"actionRequestedV2",
			EXECUTION_ROLES,
		),
		requestedAt: requestedAt.value,
	};
}

/** Parse a closed V2 action result and its terminal-effect invariants. */
export function parseActionReceiptRecordedV2(
	input: unknown,
): ActionReceiptRecordedV2 {
	const record = readClosedRecord(
		input,
		"actionReceiptRecordedV2",
		ACTION_RECEIPT_RECORDED_V2_FIELDS,
	);
	if (!hasOwnField(record, "schemaVersion") || record.schemaVersion !== 2) {
		throw new TypeError("actionReceiptRecordedV2.schemaVersion must be 2");
	}
	const completedAt = readRfc3339UtcTimestamp(
		record,
		"completedAt",
		"actionReceiptRecordedV2",
	);
	const outcome = readEnum(
		record,
		"outcome",
		"actionReceiptRecordedV2",
		ACTION_OUTCOMES_V2,
	);
	const resultDigest = readOptionalSha256Digest(
		record,
		"resultDigest",
		"actionReceiptRecordedV2",
	);
	const resultRef = readOptionalRequiredString(
		record,
		"resultRef",
		"actionReceiptRecordedV2",
	);
	if ((resultDigest === undefined) !== (resultRef === undefined)) {
		throw new TypeError(
			"actionReceiptRecordedV2.resultDigest and resultRef must be present together or absent together",
		);
	}
	const failure = readOptionalActionFailureV2(record.failure);
	if (outcome === "succeeded") {
		if (resultDigest === undefined || resultRef === undefined) {
			throw new TypeError(
				"actionReceiptRecordedV2.succeeded outcome requires resultDigest and resultRef",
			);
		}
		if (failure !== undefined) {
			throw new TypeError(
				"actionReceiptRecordedV2.succeeded outcome must not include failure",
			);
		}
	} else if (failure === undefined) {
		throw new TypeError(
			"actionReceiptRecordedV2.failed, denied, and unknown outcomes require failure",
		);
	}
	return {
		schemaVersion: 2,
		runId: readRequiredString(record, "runId", "actionReceiptRecordedV2"),
		workflowId: readRequiredString(
			record,
			"workflowId",
			"actionReceiptRecordedV2",
		),
		unitId: readRequiredString(record, "unitId", "actionReceiptRecordedV2"),
		attempt: readPositiveSafeInteger(
			record,
			"attempt",
			"actionReceiptRecordedV2",
		),
		provenanceRef: readRequiredString(
			record,
			"provenanceRef",
			"actionReceiptRecordedV2",
		),
		actionId: readRequiredString(record, "actionId", "actionReceiptRecordedV2"),
		idempotencyKey: readRequiredString(
			record,
			"idempotencyKey",
			"actionReceiptRecordedV2",
		),
		actionRequestDigest: readSha256Digest(
			record,
			"actionRequestDigest",
			"actionReceiptRecordedV2",
		),
		dispatchEnvelopeDigest: readSha256Digest(
			record,
			"dispatchEnvelopeDigest",
			"actionReceiptRecordedV2",
		),
		capabilityBundleDigest: readSha256Digest(
			record,
			"capabilityBundleDigest",
			"actionReceiptRecordedV2",
		),
		policyDigest: readSha256Digest(
			record,
			"policyDigest",
			"actionReceiptRecordedV2",
		),
		contextManifestDigest: readSha256Digest(
			record,
			"contextManifestDigest",
			"actionReceiptRecordedV2",
		),
		workerManifestDigest: readSha256Digest(
			record,
			"workerManifestDigest",
			"actionReceiptRecordedV2",
		),
		sandboxProfileDigest: readSha256Digest(
			record,
			"sandboxProfileDigest",
			"actionReceiptRecordedV2",
		),
		authorityActor: readRequiredString(
			record,
			"authorityActor",
			"actionReceiptRecordedV2",
		),
		executionRole: readEnum(
			record,
			"executionRole",
			"actionReceiptRecordedV2",
			EXECUTION_ROLES,
		),
		...(record.authorizationRef === undefined
			? {}
			: {
					authorizationRef: readRequiredString(
						record,
						"authorizationRef",
						"actionReceiptRecordedV2",
					),
				}),
		outcome,
		...(resultDigest === undefined ? {} : { resultDigest }),
		...(resultRef === undefined ? {} : { resultRef }),
		evidenceDigest: readSha256Digest(
			record,
			"evidenceDigest",
			"actionReceiptRecordedV2",
		),
		evidenceRef: readRequiredString(
			record,
			"evidenceRef",
			"actionReceiptRecordedV2",
		),
		resourceUsage: readActionResourceUsageV2(record.resourceUsage),
		redactions: readActionRedactionsV2(record.redactions),
		...(failure === undefined ? {} : { failure }),
		actionReceiptRef: readRequiredString(
			record,
			"actionReceiptRef",
			"actionReceiptRecordedV2",
		),
		completedAt: completedAt.value,
	};
}

/** Parse and canonical-digest-check the exact receipt set a candidate binds. */
export function parseActionReceiptSetRecordedV1(
	input: unknown,
): ActionReceiptSetRecordedV1 {
	const record = readClosedRecord(
		input,
		"actionReceiptSetRecordedV1",
		ACTION_RECEIPT_SET_RECORDED_V1_FIELDS,
	);
	if (!hasOwnField(record, "schemaVersion") || record.schemaVersion !== 1) {
		throw new TypeError("actionReceiptSetRecordedV1.schemaVersion must be 1");
	}
	const parsed: ActionReceiptSetRecordedV1 = {
		schemaVersion: 1,
		runId: readRequiredString(record, "runId", "actionReceiptSetRecordedV1"),
		workflowId: readRequiredString(
			record,
			"workflowId",
			"actionReceiptSetRecordedV1",
		),
		unitId: readRequiredString(record, "unitId", "actionReceiptSetRecordedV1"),
		attempt: readPositiveSafeInteger(
			record,
			"attempt",
			"actionReceiptSetRecordedV1",
		),
		provenanceRef: readRequiredString(
			record,
			"provenanceRef",
			"actionReceiptSetRecordedV1",
		),
		dispatchEnvelopeDigest: readSha256Digest(
			record,
			"dispatchEnvelopeDigest",
			"actionReceiptSetRecordedV1",
		),
		actionReceiptSetRef: readRequiredString(
			record,
			"actionReceiptSetRef",
			"actionReceiptSetRecordedV1",
		),
		actionReceiptSetDigest: readSha256Digest(
			record,
			"actionReceiptSetDigest",
			"actionReceiptSetRecordedV1",
		),
		receipts: readActionReceiptSetEntriesV1(record.receipts),
		sealedAt: readRfc3339UtcTimestamp(
			record,
			"sealedAt",
			"actionReceiptSetRecordedV1",
		).value,
	};
	const expected = canonicalActionReceiptSetRecordedV1Digest(parsed);
	if (parsed.actionReceiptSetDigest !== expected) {
		throw new TypeError(
			"actionReceiptSetRecordedV1.actionReceiptSetDigest must equal the canonical receipt-set digest",
		);
	}
	return parsed;
}

export function parseWorkerManifestV1(input: unknown): WorkerManifestV1 {
	const record = readClosedRecord(
		input,
		"workerManifest",
		WORKER_MANIFEST_FIELDS,
	);
	return {
		schemaVersion: readSchemaVersion(record, "workerManifest"),
		workflowId: readRequiredString(record, "workflowId", "workerManifest"),
		unitId: readRequiredString(record, "unitId", "workerManifest"),
		attempt: readPositiveSafeInteger(record, "attempt", "workerManifest"),
		provenanceRef: readRequiredString(
			record,
			"provenanceRef",
			"workerManifest",
		),
		dispatchEnvelopeDigest: readSha256Digest(
			record,
			"dispatchEnvelopeDigest",
			"workerManifest",
		),
		contextManifestDigest: readSha256Digest(
			record,
			"contextManifestDigest",
			"workerManifest",
		),
		sandboxProfileDigest: readSha256Digest(
			record,
			"sandboxProfileDigest",
			"workerManifest",
		),
		workerId: readRequiredString(record, "workerId", "workerManifest"),
		provider: readRequiredString(record, "provider", "workerManifest"),
		manifestDigest: readSha256Digest(
			record,
			"manifestDigest",
			"workerManifest",
		),
	};
}

/**
 * Parse a closed, self-addressing runtime identity. The digest validates the
 * immutable runtime fields at the untrusted boundary but remains evidence,
 * never execution authority.
 */
export function parseWorkerRuntimeManifestV1(
	input: unknown,
): WorkerRuntimeManifestV1 {
	const record = readClosedRecord(
		input,
		"workerRuntimeManifest",
		WORKER_RUNTIME_MANIFEST_V1_FIELDS,
	);
	const parsed: WorkerRuntimeManifestV1 = {
		...readWorkerRuntimeManifestV1Fields(record),
		runtimeManifestDigest: readSha256Digest(
			record,
			"runtimeManifestDigest",
			"workerRuntimeManifest",
		),
	};
	const expected = canonicalWorkerRuntimeManifestV1Digest(parsed);
	if (parsed.runtimeManifestDigest !== expected) {
		throw new TypeError(
			"workerRuntimeManifest.runtimeManifestDigest must equal the canonical runtime manifest digest",
		);
	}
	return parsed;
}

function readWorkerRuntimeManifestV1Fields(
	record: Record<string, unknown>,
): Omit<WorkerRuntimeManifestV1, "runtimeManifestDigest"> {
	return {
		schemaVersion: readSchemaVersion(record, "workerRuntimeManifest"),
		workerId: readNonBlankString(record, "workerId", "workerRuntimeManifest"),
		executionRole: readEnum(
			record,
			"executionRole",
			"workerRuntimeManifest",
			EXECUTION_ROLES,
		),
		provider: readNonBlankString(record, "provider", "workerRuntimeManifest"),
		model: readNonBlankString(record, "model", "workerRuntimeManifest"),
		providerVersion: readNonBlankString(
			record,
			"providerVersion",
			"workerRuntimeManifest",
		),
		harness: readNonBlankString(record, "harness", "workerRuntimeManifest"),
		harnessVersion: readNonBlankString(
			record,
			"harnessVersion",
			"workerRuntimeManifest",
		),
		imageDigest: readSha256Digest(
			record,
			"imageDigest",
			"workerRuntimeManifest",
		),
		toolCatalogDigest: readSha256Digest(
			record,
			"toolCatalogDigest",
			"workerRuntimeManifest",
		),
		skillSetDigest: readSha256Digest(
			record,
			"skillSetDigest",
			"workerRuntimeManifest",
		),
		capabilityBundleDigest: readSha256Digest(
			record,
			"capabilityBundleDigest",
			"workerRuntimeManifest",
		),
		sandboxProfileDigest: readSha256Digest(
			record,
			"sandboxProfileDigest",
			"workerRuntimeManifest",
		),
	};
}

export function parseContextManifestV1(input: unknown): ContextManifestV1 {
	const record = readClosedRecord(
		input,
		"contextManifest",
		CONTEXT_MANIFEST_FIELDS,
	);
	return {
		schemaVersion: readSchemaVersion(record, "contextManifest"),
		workflowId: readRequiredString(record, "workflowId", "contextManifest"),
		unitId: readRequiredString(record, "unitId", "contextManifest"),
		attempt: readPositiveSafeInteger(record, "attempt", "contextManifest"),
		provenanceRef: readRequiredString(
			record,
			"provenanceRef",
			"contextManifest",
		),
		dispatchEnvelopeDigest: readSha256Digest(
			record,
			"dispatchEnvelopeDigest",
			"contextManifest",
		),
		workerManifestDigest: readSha256Digest(
			record,
			"workerManifestDigest",
			"contextManifest",
		),
		sandboxProfileDigest: readSha256Digest(
			record,
			"sandboxProfileDigest",
			"contextManifest",
		),
		contextId: readRequiredString(record, "contextId", "contextManifest"),
		manifestDigest: readSha256Digest(
			record,
			"manifestDigest",
			"contextManifest",
		),
	};
}

export function parseAttemptContextV1(input: unknown): AttemptContextV1 {
	const record = readClosedRecord(
		input,
		"attemptContext",
		ATTEMPT_CONTEXT_FIELDS,
	);
	return {
		schemaVersion: readSchemaVersion(record, "attemptContext"),
		workflowId: readRequiredString(record, "workflowId", "attemptContext"),
		unitId: readRequiredString(record, "unitId", "attemptContext"),
		attempt: readPositiveSafeInteger(record, "attempt", "attemptContext"),
		provenanceRef: readRequiredString(
			record,
			"provenanceRef",
			"attemptContext",
		),
		dispatchEnvelopeDigest: readSha256Digest(
			record,
			"dispatchEnvelopeDigest",
			"attemptContext",
		),
		contextManifestDigest: readSha256Digest(
			record,
			"contextManifestDigest",
			"attemptContext",
		),
		workerManifestDigest: readSha256Digest(
			record,
			"workerManifestDigest",
			"attemptContext",
		),
		sandboxProfileDigest: readSha256Digest(
			record,
			"sandboxProfileDigest",
			"attemptContext",
		),
	};
}

export function parseSandboxProfileV1(input: unknown): SandboxProfileV1 {
	const record = readClosedRecord(
		input,
		"sandboxProfile",
		SANDBOX_PROFILE_FIELDS,
	);
	return {
		schemaVersion: readSchemaVersion(record, "sandboxProfile"),
		workflowId: readRequiredString(record, "workflowId", "sandboxProfile"),
		unitId: readRequiredString(record, "unitId", "sandboxProfile"),
		attempt: readPositiveSafeInteger(record, "attempt", "sandboxProfile"),
		provenanceRef: readRequiredString(
			record,
			"provenanceRef",
			"sandboxProfile",
		),
		dispatchEnvelopeDigest: readSha256Digest(
			record,
			"dispatchEnvelopeDigest",
			"sandboxProfile",
		),
		workerManifestDigest: readSha256Digest(
			record,
			"workerManifestDigest",
			"sandboxProfile",
		),
		profileId: readRequiredString(record, "profileId", "sandboxProfile"),
		profileDigest: readSha256Digest(record, "profileDigest", "sandboxProfile"),
	};
}

/** The only stable public failure code exposed by this initial contract slice. */
export const UNSUPPORTED_COMMIT_MODE = "UNSUPPORTED_COMMIT_MODE";

export const UNSUPPORTED_COMMIT_MODE_MESSAGE =
	'UNSUPPORTED_COMMIT_MODE: governed execution requires commitMode "atomic".';

export class GovernedExecutionError extends Error {
	readonly code = UNSUPPORTED_COMMIT_MODE;

	constructor() {
		super(UNSUPPORTED_COMMIT_MODE_MESSAGE);
		this.name = "GovernedExecutionError";
	}
}

/**
 * Applies the V1 guard for the governed execution path.
 *
 * Raw envelopes are deliberately not admitted to governed execution. The V1
 * governed path has no semantics for incremental or saga commits, so those
 * modes fail with the stable unsupported-mode error before any effect occurs.
 */
export function assertGovernedExecutionV1(
	dispatch: DispatchEnvelopeV1,
): asserts dispatch is DispatchEnvelopeV1 & {
	readonly trustTier: "governed";
	readonly commitMode: "atomic";
} {
	if (dispatch.trustTier !== "governed") {
		throw new TypeError('Governed execution requires trustTier "governed".');
	}

	if (dispatch.commitMode !== "atomic") {
		throw new GovernedExecutionError();
	}
}

/**
 * Pure, V3-only runtime binding check for a protected host. It validates
 * already-parsed values again to fail closed after mutation, but it does not
 * verify signatures, resolve a host, authorize a worker, or execute anything.
 * `DispatchEnvelopeV4` is deliberately unsupported here: callers must bind
 * the exact parsed nested V3 envelope explicitly. The descriptor-safe V3
 * parser remains the first operation, so untrusted accessors never run here.
 */
export function assertDispatchWorkerRuntimeManifestV1(
	dispatch: DispatchEnvelopeV3,
	runtime: WorkerRuntimeManifestV1,
): void {
	const parsedDispatch = parseDispatchEnvelopeV3(dispatch);
	const parsedRuntime = parseWorkerRuntimeManifestV1(runtime);

	if (parsedDispatch.body.trustTier !== "governed") {
		throw new TypeError(
			'Worker runtime manifest binding requires trustTier "governed".',
		);
	}
	if (parsedDispatch.actionEvidenceVersion !== "sealed_v3") {
		throw new TypeError(
			'Worker runtime manifest binding requires actionEvidenceVersion "sealed_v3".',
		);
	}
	if (parsedDispatch.body.commitMode !== "atomic") {
		throw new TypeError(
			'Worker runtime manifest binding requires commitMode "atomic".',
		);
	}
	if (
		parsedDispatch.body.workerManifestDigest !==
		parsedRuntime.runtimeManifestDigest
	) {
		throw new TypeError(
			"Worker runtime manifest binding requires dispatch workerManifestDigest to equal runtimeManifestDigest.",
		);
	}
	if (parsedDispatch.body.executionRole !== parsedRuntime.executionRole) {
		throw new TypeError(
			"Worker runtime manifest binding requires matching executionRole values.",
		);
	}
	if (
		parsedDispatch.body.capabilityBundleDigest !==
		parsedRuntime.capabilityBundleDigest
	) {
		throw new TypeError(
			"Worker runtime manifest binding requires matching capabilityBundleDigest values.",
		);
	}
	if (
		parsedDispatch.body.sandboxProfileDigest !==
		parsedRuntime.sandboxProfileDigest
	) {
		throw new TypeError(
			"Worker runtime manifest binding requires matching sandboxProfileDigest values.",
		);
	}
}

const DISPATCH_ENVELOPE_V3_DIGEST_DOMAIN = "buildplane.dispatch-envelope.v3\0";
const DISPATCH_ENVELOPE_V4_DIGEST_DOMAIN = "buildplane.dispatch-envelope.v4\0";
const WORKER_RUNTIME_MANIFEST_V1_DIGEST_DOMAIN =
	"buildplane.worker-runtime-manifest.v1\0";
const WORKFLOW_GRAPH_V2_DIGEST_DOMAIN = "buildplane.workflow-graph.v2\0";
const ACTION_REQUEST_V2_DIGEST_DOMAIN = "buildplane.action-request.v2\0";
const ACTION_RECEIPT_V2_DIGEST_DOMAIN = "buildplane.action-receipt.v2\0";
const ACTION_RECEIPT_SET_V1_DIGEST_DOMAIN =
	"buildplane.action-receipt-set.v1\0";
const CANDIDATE_COMPLETION_RECORDED_V1_DIGEST_DOMAIN =
	"buildplane.candidate-completion-recorded.v1\0";
const REVIEW_VERDICT_OUTPUT_V1_DIGEST_DOMAIN =
	"buildplane.review-verdict-output.v1\0";
const CANDIDATE_VIEW_V1_DIGEST_DOMAIN = "buildplane.candidate-view.v1\0";
const PROMOTION_APPROVAL_REQUEST_V1_DIGEST_DOMAIN =
	"buildplane.promotion-approval-request.v1\0";
const GOVERNED_UNIT_PACKET_V1_DIGEST_DOMAIN =
	"buildplane.governed-unit-packet.v1\0";

/**
 * Stable identity of the complete normalized governed packet. Sealed V3
 * dispatches bind this digest before any action request is written, so a
 * caller cannot reuse a valid capability envelope with a substituted command,
 * model prompt, verification contract, or trust scope.
 */
export function canonicalGovernedUnitPacketV1Digest(input: unknown): string {
	return canonicalDigest(
		GOVERNED_UNIT_PACKET_V1_DIGEST_DOMAIN,
		canonicalizeGovernedPacketJsonValue(
			input,
			"governed admitted unit packet",
			new Set<object>(),
		),
	);
}

/**
 * Stable structural identity for a candidate-bound promotion approval
 * request. The wire shape deliberately omits `schemaVersion`: the native
 * ledger payload is versioned by its event kind and version.
 */
export function canonicalPromotionApprovalRequestedV1Digest(
	input: unknown,
): string {
	const request = parsePromotionApprovalRequestedV1(input);
	return canonicalDigest(PROMOTION_APPROVAL_REQUEST_V1_DIGEST_DOMAIN, {
		candidate_digest: request.candidateDigest,
		base_commit_sha: request.baseCommitSha,
		target_ref: request.targetRef,
		envelope_digest: request.envelopeDigest,
		acceptance_ref: request.acceptanceRef,
		review_refs: [...request.reviewRefs],
		requested_by: request.requestedBy,
		requested_at: request.requestedAt,
		idempotency_key: request.idempotencyKey,
	});
}

/**
 * Stable, domain-separated identity for immutable worker runtime material.
 * `runtimeManifestDigest` is deliberately excluded to avoid a circular claim.
 */
export function canonicalWorkerRuntimeManifestV1Digest(
	input:
		| Omit<WorkerRuntimeManifestV1, "runtimeManifestDigest">
		| WorkerRuntimeManifestV1,
): string {
	const record = readClosedRecord(
		input,
		"workerRuntimeManifest",
		WORKER_RUNTIME_MANIFEST_V1_FIELDS,
	);
	const runtime = readWorkerRuntimeManifestV1Fields(record);
	return canonicalDigest(WORKER_RUNTIME_MANIFEST_V1_DIGEST_DOMAIN, {
		schema_version: runtime.schemaVersion,
		worker_id: runtime.workerId,
		execution_role: runtime.executionRole,
		provider: runtime.provider,
		model: runtime.model,
		provider_version: runtime.providerVersion,
		harness: runtime.harness,
		harness_version: runtime.harnessVersion,
		image_digest: runtime.imageDigest,
		tool_catalog_digest: runtime.toolCatalogDigest,
		skill_set_digest: runtime.skillSetDigest,
		capability_bundle_digest: runtime.capabilityBundleDigest,
		sandbox_profile_digest: runtime.sandboxProfileDigest,
	});
}

type CanonicalGovernedPacketJsonValue =
	| null
	| boolean
	| number
	| string
	| readonly CanonicalGovernedPacketJsonValue[]
	| { readonly [key: string]: CanonicalGovernedPacketJsonValue };

function canonicalizeGovernedPacketJsonValue(
	input: unknown,
	label: string,
	seen: Set<object>,
): CanonicalGovernedPacketJsonValue {
	if (
		input === null ||
		typeof input === "string" ||
		typeof input === "boolean"
	) {
		return input;
	}
	if (typeof input === "number") {
		if (!Number.isFinite(input)) {
			throw new TypeError(`${label} must contain only finite JSON numbers.`);
		}
		return input;
	}
	let isArray = false;
	try {
		isArray = Array.isArray(input);
	} catch {
		throw new TypeError(`${label} must be a closed data value.`);
	}
	if (isArray) {
		const arrayInput = input as readonly unknown[];
		if (seen.has(arrayInput)) {
			throw new TypeError(`${label} must not contain cyclic values.`);
		}
		seen.add(arrayInput);
		const result: CanonicalGovernedPacketJsonValue[] = [];
		const entries = readDenseDataArray(
			arrayInput,
			label,
			`${label} must contain only JSON values.`,
			() => `${label} must not contain sparse arrays.`,
		);
		for (const item of entries) {
			result.push(canonicalizeGovernedPacketJsonValue(item, label, seen));
		}
		seen.delete(arrayInput);
		return Object.freeze(result);
	}
	if (typeof input !== "object") {
		throw new TypeError(`${label} must contain only JSON values.`);
	}
	if (seen.has(input)) {
		throw new TypeError(`${label} must not contain cyclic values.`);
	}
	let symbols: symbol[];
	let keys: string[];
	try {
		symbols = Object.getOwnPropertySymbols(input);
		keys = Object.getOwnPropertyNames(input);
	} catch {
		throw new TypeError(`${label} must be a closed data object.`);
	}
	if (symbols.length > 0) {
		throw new TypeError(`${label} must not contain symbol fields.`);
	}
	seen.add(input);
	const source = input as Record<string, unknown>;
	const result = Object.create(null) as Record<
		string,
		CanonicalGovernedPacketJsonValue
	>;
	for (const key of keys.sort()) {
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(source, key);
		} catch {
			throw new TypeError(`${label} must be a closed data object.`);
		}
		if (!descriptor || !("value" in descriptor)) {
			throw new TypeError(`${label}.${key} must be a data property.`);
		}
		result[key] = canonicalizeGovernedPacketJsonValue(
			descriptor.value,
			`${label}.${key}`,
			seen,
		);
	}
	seen.delete(input);
	return Object.freeze(result);
}

/**
 * Exact cross-language V3 dispatch digest. The object is built in the same
 * declaration order as the Rust payload and uses snake_case wire names; this
 * avoids JavaScript property-order or camelCase conversion ambiguity.
 */
export function canonicalDispatchEnvelopeV3Digest(
	input: DispatchEnvelopeBodyV3 | DispatchEnvelopeV3,
): string {
	return canonicalDigest(
		DISPATCH_ENVELOPE_V3_DIGEST_DOMAIN,
		canonicalDispatchEnvelopeV3BodyWire(input),
	);
}

/**
 * Exact cross-language V4 dispatch digest. The complete V3 envelope is nested
 * as serialized native authority material, including its detached V3 digest.
 */
export function canonicalDispatchEnvelopeV4Digest(
	input: Omit<DispatchEnvelopeV4, "envelopeDigest"> | DispatchEnvelopeV4,
): string {
	const record = readClosedRecord(
		input,
		"dispatchEnvelopeV4",
		DISPATCH_ENVELOPE_V4_FIELDS,
	);
	if (!hasOwnField(record, "schemaVersion") || record.schemaVersion !== 4) {
		throw new TypeError("dispatchEnvelopeV4.schemaVersion must be 4");
	}
	const dispatch = readDispatchEnvelopeV4Fields(record);
	return canonicalDigest(DISPATCH_ENVELOPE_V4_DIGEST_DOMAIN, {
		dispatch_v3: canonicalDispatchEnvelopeV3EnvelopeWire(dispatch.dispatchV3),
		workflow_graph_digest: dispatch.workflowGraphDigest,
		workflow_graph_declaration_event_ref:
			dispatch.workflowGraphDeclarationEventRef,
	});
}

/**
 * Exact cross-language V2 workflow graph digest. Delivery metadata (`graphDigest`,
 * `idempotencyKey`, and `declaredAt`) deliberately remains outside the native
 * graph authority bytes.
 */
export function canonicalWorkflowGraphV2Digest(
	input: Omit<WorkflowGraphDeclaredV2, "graphDigest"> | WorkflowGraphDeclaredV2,
): string {
	const record = readClosedRecord(
		input,
		"workflowGraphDeclaredV2",
		WORKFLOW_GRAPH_DECLARED_V2_FIELDS,
	);
	const declaration = readWorkflowGraphDeclaredV2Fields(record);
	return canonicalDigest(WORKFLOW_GRAPH_V2_DIGEST_DOMAIN, {
		run_id: declaration.runId,
		workflow_id: declaration.workflowId,
		workflow_revision: declaration.workflowRevision,
		nodes: declaration.nodes.map((node) => ({
			unit_id: node.unitId,
			depends_on: [...node.dependsOn],
			execution_role: node.executionRole,
			governed_packet_digest: node.governedPacketDigest,
		})),
		max_concurrent: declaration.maxConcurrent,
	});
}

function canonicalDispatchEnvelopeV3BodyWire(
	input: DispatchEnvelopeBodyV3 | DispatchEnvelopeV3,
): Record<string, unknown> {
	const record = readClosedRecord(
		input,
		"dispatchEnvelopeV3",
		DISPATCH_ENVELOPE_V3_FIELDS,
	);
	const actionEvidenceVersion = readRequiredString(
		record,
		"actionEvidenceVersion",
		"dispatchEnvelopeV3",
	);
	if (!isActionEvidenceVersion(actionEvidenceVersion)) {
		throw new TypeError(
			'dispatchEnvelopeV3.actionEvidenceVersion must be "sealed-v2" or "sealed_v3"',
		);
	}
	if (
		actionEvidenceVersion === "sealed_v3" &&
		record.governedPacketDigest === undefined
	) {
		throw new TypeError(
			"dispatchEnvelopeV3.governedPacketDigest is required for sealed_v3 authority.",
		);
	}
	const body = parseDispatchEnvelopeBodyV2(record.body);
	const governedPacketDigest = readOptionalSha256Digest(
		record,
		"governedPacketDigest",
		"dispatchEnvelopeV3",
	);
	return {
		body: canonicalDispatchEnvelopeBodyV2Wire(body),
		action_evidence_version: actionEvidenceVersion,
		repository_binding_digest: readSha256Digest(
			record,
			"repositoryBindingDigest",
			"dispatchEnvelopeV3",
		),
		ledger_authority_realm_digest: readSha256Digest(
			record,
			"ledgerAuthorityRealmDigest",
			"dispatchEnvelopeV3",
		),
		...(governedPacketDigest === undefined
			? {}
			: {
					governed_packet_digest: governedPacketDigest,
				}),
	};
}

function canonicalDispatchEnvelopeV3EnvelopeWire(
	dispatch: DispatchEnvelopeV3,
): Record<string, unknown> {
	const parsed = parseDispatchEnvelopeV3(dispatch);
	return {
		...canonicalDispatchEnvelopeV3BodyWire(parsed),
		envelope_digest: parsed.envelopeDigest,
	};
}

function isActionEvidenceVersion(
	value: string,
): value is ActionEvidenceVersionV1 {
	return SEALED_ACTION_EVIDENCE_VERSIONS.has(value as ActionEvidenceVersionV1);
}

/** Exact cross-language digest for the complete write-ahead action request. */
export function canonicalActionRequestedV2Digest(
	input: ActionRequestedV2,
): string {
	const action = parseActionRequestedV2(input);
	return canonicalDigest(
		ACTION_REQUEST_V2_DIGEST_DOMAIN,
		canonicalActionRequestedV2Wire(action),
	);
}

/** Exact cross-language digest for the complete durable action receipt. */
export function canonicalActionReceiptRecordedV2Digest(
	input: ActionReceiptRecordedV2,
): string {
	const receipt = parseActionReceiptRecordedV2(input);
	return canonicalDigest(
		ACTION_RECEIPT_V2_DIGEST_DOMAIN,
		canonicalActionReceiptRecordedV2Wire(receipt),
	);
}

/**
 * Exact cross-language digest for a sealed action receipt set. The digest
 * field itself is deliberately excluded to avoid a circular pre-effect claim.
 */
export function canonicalActionReceiptSetRecordedV1Digest(
	input:
		| Omit<ActionReceiptSetRecordedV1, "actionReceiptSetDigest">
		| ActionReceiptSetRecordedV1,
): string {
	const record = readClosedRecord(
		input,
		"actionReceiptSetRecordedV1",
		ACTION_RECEIPT_SET_RECORDED_V1_FIELDS,
	);
	const set = {
		schemaVersion: readSchemaVersion(record, "actionReceiptSetRecordedV1"),
		runId: readRequiredString(record, "runId", "actionReceiptSetRecordedV1"),
		workflowId: readRequiredString(
			record,
			"workflowId",
			"actionReceiptSetRecordedV1",
		),
		unitId: readRequiredString(record, "unitId", "actionReceiptSetRecordedV1"),
		attempt: readPositiveSafeInteger(
			record,
			"attempt",
			"actionReceiptSetRecordedV1",
		),
		provenanceRef: readRequiredString(
			record,
			"provenanceRef",
			"actionReceiptSetRecordedV1",
		),
		dispatchEnvelopeDigest: readSha256Digest(
			record,
			"dispatchEnvelopeDigest",
			"actionReceiptSetRecordedV1",
		),
		actionReceiptSetRef: readRequiredString(
			record,
			"actionReceiptSetRef",
			"actionReceiptSetRecordedV1",
		),
		receipts: readActionReceiptSetEntriesV1(record.receipts),
		sealedAt: readRfc3339UtcTimestamp(
			record,
			"sealedAt",
			"actionReceiptSetRecordedV1",
		).value,
	};
	return canonicalDigest(
		ACTION_RECEIPT_SET_V1_DIGEST_DOMAIN,
		canonicalActionReceiptSetRecordedV1Wire(set),
	);
}

/**
 * Exact cross-language digest for the candidate-completion evidence contract.
 * The digest itself is excluded so a host cannot self-attest a modified
 * lineage after the candidate event was written.
 */
export function canonicalCandidateCompletionRecordedV1Digest(
	input:
		| Omit<CandidateCompletionRecordedV1, "completionDigest">
		| CandidateCompletionRecordedV1,
): string {
	const record = readClosedRecord(
		input,
		"candidateCompletionRecordedV1",
		CANDIDATE_COMPLETION_RECORDED_V1_FIELDS,
	);
	return canonicalDigest(
		CANDIDATE_COMPLETION_RECORDED_V1_DIGEST_DOMAIN,
		canonicalCandidateCompletionRecordedV1Wire(
			readCandidateCompletionRecordedV1Fields(record),
		),
	);
}

/**
 * Exact cross-language digest for the semantic output of a review action.
 * Native replay compares this value to both the V2 review record and the
 * succeeded review action receipt, preventing a worker from retargeting a
 * verdict after it was produced.
 */
export function canonicalReviewVerdictOutputV1Digest(
	input: ReviewVerdictOutputV1,
): string {
	const record = readClosedRecord(input, "reviewVerdictOutput", [
		"candidateDigest",
		"candidateCommitSha",
		"decision",
		"findings",
		"confidence",
		"candidateViewDigest",
	]);
	const verdict = parseReviewVerdictV1({
		schemaVersion: 1,
		candidateDigest: record.candidateDigest,
		decision: record.decision,
		findings: record.findings,
		confidence: record.confidence,
		// Review output intentionally excludes the reviewer manifest. Parse the
		// common semantic fields with a fixed syntactically valid placeholder;
		// V2 review evidence binds the actual manifest separately.
		reviewerManifestDigest: `sha256:${"0".repeat(64)}`,
	});
	const candidateCommitSha = readCommitSha(
		record,
		"candidateCommitSha",
		"reviewVerdictOutput",
	);
	const candidateViewDigest = readSha256Digest(
		record,
		"candidateViewDigest",
		"reviewVerdictOutput",
	);

	return canonicalDigest(REVIEW_VERDICT_OUTPUT_V1_DIGEST_DOMAIN, {
		candidate_digest: verdict.candidateDigest,
		candidate_commit_sha: candidateCommitSha,
		decision: verdict.decision,
		findings: verdict.findings.map((finding) => ({
			severity: finding.severity,
			check_id: finding.checkId,
			file: finding.file,
			line: finding.line,
			explanation: finding.explanation,
			evidence_refs: [...finding.evidenceRefs],
		})),
		confidence: verdict.confidence,
		candidate_view_digest: candidateViewDigest,
	});
}

/**
 * Exact cross-language digest for the complete reviewer candidate view. This
 * is intentionally structural: callers that authorize review must separately
 * require `readOnly` and `networkDisabled` to be true before execution.
 */
export function canonicalCandidateViewV1Digest(input: CandidateViewV1): string {
	const record = readClosedRecord(input, "candidateView", [
		"candidateRef",
		"candidateDigest",
		"candidateCommitSha",
		"treeDigest",
		"reviewerContextManifestDigest",
		"reviewerSandboxProfileDigest",
		"mountPathDigest",
		"readOnly",
		"networkDisabled",
	]);
	const readOnly = record.readOnly;
	if (!hasOwnField(record, "readOnly") || typeof readOnly !== "boolean") {
		throw new TypeError("candidateView.readOnly must be a boolean");
	}
	const networkDisabled = record.networkDisabled;
	if (
		!hasOwnField(record, "networkDisabled") ||
		typeof networkDisabled !== "boolean"
	) {
		throw new TypeError("candidateView.networkDisabled must be a boolean");
	}

	return canonicalDigest(CANDIDATE_VIEW_V1_DIGEST_DOMAIN, {
		candidate_ref: readCanonicalBuildplaneCandidateRef(
			record,
			"candidateRef",
			"candidateView",
		),
		candidate_digest: readSha256Digest(
			record,
			"candidateDigest",
			"candidateView",
		),
		candidate_commit_sha: readCommitSha(
			record,
			"candidateCommitSha",
			"candidateView",
		),
		tree_digest: readSha256Digest(record, "treeDigest", "candidateView"),
		reviewer_context_manifest_digest: readSha256Digest(
			record,
			"reviewerContextManifestDigest",
			"candidateView",
		),
		reviewer_sandbox_profile_digest: readSha256Digest(
			record,
			"reviewerSandboxProfileDigest",
			"candidateView",
		),
		mount_path_digest: readSha256Digest(
			record,
			"mountPathDigest",
			"candidateView",
		),
		read_only: readOnly,
		network_disabled: networkDisabled,
	});
}

/**
 * Normalizes the raw Git adapter's SHA-256 form into the canonical V1 digest
 * form. The adapter deliberately owns a raw content digest, whereas every
 * signed V1 contract carries the explicit `sha256:` prefix. This conversion is
 * a representation boundary only; it never calculates or attests a digest.
 */
export function canonicalSha256Digest(input: string): string {
	if (SHA256_DIGEST_PATTERN.test(input)) {
		return input;
	}
	if (RAW_SHA256_HEX_PATTERN.test(input)) {
		return `sha256:${input}`;
	}
	throw new TypeError("digest must be a lowercase SHA-256 digest");
}

function canonicalDigest(domain: string, value: unknown): string {
	const json = JSON.stringify(value);
	if (json === undefined) {
		throw new TypeError("canonical payload must be JSON serializable");
	}
	return `sha256:${createHash("sha256")
		.update(domain, "utf8")
		.update(json, "utf8")
		.digest("hex")}`;
}

function canonicalDispatchEnvelopeBodyV2Wire(
	body: DispatchEnvelopeBodyV2,
): Record<string, unknown> {
	return {
		workflow_id: body.workflowId,
		workflow_revision: body.workflowRevision,
		unit_id: body.unitId,
		attempt: body.attempt,
		execution_role: body.executionRole,
		commit_mode: body.commitMode,
		provenance_ref: body.provenanceRef,
		base_commit_sha: body.baseCommitSha,
		capability_bundle_digest: body.capabilityBundleDigest,
		acceptance_contract_digest: body.acceptanceContractDigest,
		context_manifest_digest: body.contextManifestDigest,
		worker_manifest_digest: body.workerManifestDigest,
		sandbox_profile_digest: body.sandboxProfileDigest,
		budget: canonicalDispatchBudgetV1Wire(body.budget),
		trust_tier: body.trustTier,
		idempotency_key: body.idempotencyKey,
		issued_at: body.issuedAt,
		expires_at: body.expiresAt,
	};
}

function canonicalDispatchBudgetV1Wire(
	budget: DispatchBudgetV1,
): Record<string, number> {
	return {
		...(budget.maxTokens === undefined ? {} : { max_tokens: budget.maxTokens }),
		...(budget.maxComputeTimeMs === undefined
			? {}
			: { max_compute_time_ms: budget.maxComputeTimeMs }),
	};
}

function canonicalActionRequestedV2Wire(
	action: ActionRequestedV2,
): Record<string, unknown> {
	return {
		run_id: action.runId,
		workflow_id: action.workflowId,
		unit_id: action.unitId,
		attempt: action.attempt,
		provenance_ref: action.provenanceRef,
		action_id: action.actionId,
		idempotency_key: action.idempotencyKey,
		action_kind: action.actionKind,
		canonical_input_digest: action.canonicalInputDigest,
		canonical_input_ref: action.canonicalInputRef,
		dispatch_envelope_digest: action.dispatchEnvelopeDigest,
		repository_binding_digest: action.repositoryBindingDigest,
		ledger_authority_realm_digest: action.ledgerAuthorityRealmDigest,
		...(action.governedPacketDigest === undefined
			? {}
			: { governed_packet_digest: action.governedPacketDigest }),
		capability_bundle_digest: action.capabilityBundleDigest,
		policy_digest: action.policyDigest,
		context_manifest_digest: action.contextManifestDigest,
		worker_manifest_digest: action.workerManifestDigest,
		sandbox_profile_digest: action.sandboxProfileDigest,
		authority_actor: action.authorityActor,
		execution_role: action.executionRole,
		requested_at: action.requestedAt,
	};
}

function canonicalActionReceiptRecordedV2Wire(
	receipt: ActionReceiptRecordedV2,
): Record<string, unknown> {
	return {
		run_id: receipt.runId,
		workflow_id: receipt.workflowId,
		unit_id: receipt.unitId,
		attempt: receipt.attempt,
		provenance_ref: receipt.provenanceRef,
		action_id: receipt.actionId,
		idempotency_key: receipt.idempotencyKey,
		action_request_digest: receipt.actionRequestDigest,
		dispatch_envelope_digest: receipt.dispatchEnvelopeDigest,
		capability_bundle_digest: receipt.capabilityBundleDigest,
		policy_digest: receipt.policyDigest,
		context_manifest_digest: receipt.contextManifestDigest,
		worker_manifest_digest: receipt.workerManifestDigest,
		sandbox_profile_digest: receipt.sandboxProfileDigest,
		authority_actor: receipt.authorityActor,
		execution_role: receipt.executionRole,
		...(receipt.authorizationRef === undefined
			? {}
			: { authorization_ref: receipt.authorizationRef }),
		outcome: receipt.outcome,
		...(receipt.resultDigest === undefined
			? {}
			: { result_digest: receipt.resultDigest }),
		...(receipt.resultRef === undefined
			? {}
			: { result_ref: receipt.resultRef }),
		evidence_digest: receipt.evidenceDigest,
		evidence_ref: receipt.evidenceRef,
		resource_usage: {
			wall_time_ms: receipt.resourceUsage.wallTimeMs,
			...(receipt.resourceUsage.cpuTimeMs === undefined
				? {}
				: { cpu_time_ms: receipt.resourceUsage.cpuTimeMs }),
			...(receipt.resourceUsage.peakMemoryBytes === undefined
				? {}
				: { peak_memory_bytes: receipt.resourceUsage.peakMemoryBytes }),
			...(receipt.resourceUsage.inputBytes === undefined
				? {}
				: { input_bytes: receipt.resourceUsage.inputBytes }),
			...(receipt.resourceUsage.outputBytes === undefined
				? {}
				: { output_bytes: receipt.resourceUsage.outputBytes }),
			...(receipt.resourceUsage.inputTokens === undefined
				? {}
				: { input_tokens: receipt.resourceUsage.inputTokens }),
			...(receipt.resourceUsage.outputTokens === undefined
				? {}
				: { output_tokens: receipt.resourceUsage.outputTokens }),
		},
		redactions: receipt.redactions.map((redaction) => ({
			field: redaction.field,
			reason: redaction.reason,
			...(redaction.redactedDigest === undefined
				? {}
				: { redacted_digest: redaction.redactedDigest }),
		})),
		...(receipt.failure === undefined
			? {}
			: {
					failure: {
						code: receipt.failure.code,
						message_digest: receipt.failure.messageDigest,
						retryable: receipt.failure.retryable,
					},
				}),
		action_receipt_ref: receipt.actionReceiptRef,
		completed_at: receipt.completedAt,
	};
}

function canonicalActionReceiptSetRecordedV1Wire(
	set:
		| Omit<ActionReceiptSetRecordedV1, "actionReceiptSetDigest">
		| ActionReceiptSetRecordedV1,
): Record<string, unknown> {
	return {
		run_id: set.runId,
		workflow_id: set.workflowId,
		unit_id: set.unitId,
		attempt: set.attempt,
		provenance_ref: set.provenanceRef,
		dispatch_envelope_digest: set.dispatchEnvelopeDigest,
		action_receipt_set_ref: set.actionReceiptSetRef,
		receipts: set.receipts.map((receipt) => ({
			action_id: receipt.actionId,
			action_receipt_ref: receipt.actionReceiptRef,
			action_receipt_digest: receipt.actionReceiptDigest,
		})),
		sealed_at: set.sealedAt,
	};
}

function canonicalCandidateCompletionRecordedV1Wire(
	completion: Omit<CandidateCompletionRecordedV1, "completionDigest">,
): Record<string, unknown> {
	return {
		run_id: completion.runId,
		workflow_id: completion.workflowId,
		unit_id: completion.unitId,
		attempt: completion.attempt,
		provenance_ref: completion.provenanceRef,
		candidate_created_event_ref: completion.candidateCreatedEventRef,
		candidate_digest: completion.candidateDigest,
		candidate_create_action_id: completion.candidateCreateActionId,
		action_request_ref: completion.actionRequestRef,
		action_request_digest: completion.actionRequestDigest,
		activity_claim_event_ref: completion.activityClaimEventRef,
		activity_claim_event_digest: completion.activityClaimEventDigest,
		activity_result_event_ref: completion.activityResultEventRef,
		activity_result_event_digest: completion.activityResultEventDigest,
		action_receipt_ref: completion.actionReceiptRef,
		action_receipt_digest: completion.actionReceiptDigest,
		completed_at: completion.completedAt,
	};
}

function readCandidateCompletionRecordedV1Fields(
	record: Record<string, unknown>,
): Omit<CandidateCompletionRecordedV1, "completionDigest"> {
	const label = "candidateCompletionRecordedV1";
	return {
		runId: readNonBlankString(record, "runId", label),
		workflowId: readNonBlankString(record, "workflowId", label),
		unitId: readNonBlankString(record, "unitId", label),
		attempt: readPositiveSafeInteger(record, "attempt", label),
		provenanceRef: readNonBlankString(record, "provenanceRef", label),
		candidateCreatedEventRef: readNonBlankString(
			record,
			"candidateCreatedEventRef",
			label,
		),
		candidateDigest: readSha256Digest(record, "candidateDigest", label),
		candidateCreateActionId: readNonBlankString(
			record,
			"candidateCreateActionId",
			label,
		),
		actionRequestRef: readNonBlankString(record, "actionRequestRef", label),
		actionRequestDigest: readSha256Digest(record, "actionRequestDigest", label),
		activityClaimEventRef: readNonBlankString(
			record,
			"activityClaimEventRef",
			label,
		),
		activityClaimEventDigest: readSha256Digest(
			record,
			"activityClaimEventDigest",
			label,
		),
		activityResultEventRef: readNonBlankString(
			record,
			"activityResultEventRef",
			label,
		),
		activityResultEventDigest: readSha256Digest(
			record,
			"activityResultEventDigest",
			label,
		),
		actionReceiptRef: readNonBlankString(record, "actionReceiptRef", label),
		actionReceiptDigest: readSha256Digest(record, "actionReceiptDigest", label),
		completedAt: readRfc3339UtcTimestamp(record, "completedAt", label).value,
	};
}

function readClosedRecord(
	input: unknown,
	label: string,
	allowedFields: readonly string[],
): Record<string, unknown> {
	let isArray = false;
	try {
		isArray = Array.isArray(input);
	} catch {
		throw new TypeError(`${label} must be a closed data record`);
	}
	if (input === null || typeof input !== "object" || isArray) {
		throw new TypeError(`${label} must be an object`);
	}

	const source = input as Record<string, unknown>;
	const allowed = new Set(allowedFields);
	const record = Object.create(null) as Record<string, unknown>;
	let symbols: symbol[];
	let keys: string[];
	try {
		symbols = Object.getOwnPropertySymbols(source);
		keys = Object.getOwnPropertyNames(source);
	} catch {
		throw new TypeError(`${label} must be a closed data record`);
	}
	if (symbols.length > 0) {
		throw new TypeError(`${label} has unknown symbol field`);
	}
	for (const key of keys) {
		if (!allowed.has(key)) {
			throw new TypeError(`${label} has unknown field "${key}"`);
		}

		// Parsing is an untrusted-input boundary. Reading `source[key]` would
		// execute an attacker-controlled accessor before the schema is validated.
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(source, key);
		} catch {
			throw new TypeError(`${label} must be a closed data record`);
		}
		if (!descriptor || !("value" in descriptor)) {
			throw new TypeError(`${label}.${key} must be a data property`);
		}
		record[key] = descriptor.value;
	}

	return record;
}

/**
 * Copy an unbounded packet record through own data descriptors. The graph
 * compiler intentionally accepts the existing extensible `UnitPacket` shape,
 * but must not execute a getter while stripping graph-only metadata before it
 * derives the packet digest.
 */
function readOpenDataRecord(
	input: unknown,
	label: string,
): Record<string, unknown> {
	let isArray = false;
	try {
		isArray = Array.isArray(input);
	} catch {
		throw new TypeError(`${label} must be a data record`);
	}
	if (input === null || typeof input !== "object" || isArray) {
		throw new TypeError(`${label} must be an object`);
	}
	let symbols: symbol[];
	let keys: string[];
	try {
		symbols = Object.getOwnPropertySymbols(input);
		keys = Object.getOwnPropertyNames(input);
	} catch {
		throw new TypeError(`${label} must be a data record`);
	}
	if (symbols.length > 0) {
		throw new TypeError(`${label} must not contain symbol fields`);
	}
	const source = input as Record<string, unknown>;
	const record = Object.create(null) as Record<string, unknown>;
	for (const key of keys) {
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(source, key);
		} catch {
			throw new TypeError(`${label} must be a data record`);
		}
		if (!descriptor || !("value" in descriptor)) {
			throw new TypeError(`${label}.${key} must be a data property`);
		}
		record[key] = descriptor.value;
	}
	return record;
}

function readSchemaVersion(record: Record<string, unknown>, label: string): 1 {
	if (!hasOwnField(record, "schemaVersion") || record.schemaVersion !== 1) {
		throw new TypeError(`${label}.schemaVersion must be 1`);
	}

	return 1;
}

function readRequiredString(
	record: Record<string, unknown>,
	key: string,
	label: string,
): string {
	const value = record[key];
	if (
		!hasOwnField(record, key) ||
		typeof value !== "string" ||
		value.length === 0
	) {
		throw new TypeError(`${label}.${key} must be a non-empty string`);
	}

	return value;
}

function readCanonicalBuildplaneCandidateRef(
	record: Record<string, unknown>,
	key: string,
	label: string,
): string {
	const candidateRef = readRequiredString(record, key, label);
	if (!isCanonicalBuildplaneCandidateRef(candidateRef)) {
		throw new TypeError(
			`${label}.${key} must be a canonical Buildplane candidate ref`,
		);
	}
	return candidateRef;
}

/**
 * V2 review records cross the native admission boundary, where whitespace-only
 * identities and references are rejected. Keep the TypeScript structural
 * contract aligned so a local wire projection cannot be accepted here only to
 * fail later in the signed ledger.
 */
function readNonBlankString(
	record: Record<string, unknown>,
	key: string,
	label: string,
): string {
	const value = readRequiredString(record, key, label);
	if (value.trim().length === 0) {
		throw new TypeError(`${label}.${key} must be a non-blank string`);
	}
	return value;
}

function readEnum<T extends string>(
	record: Record<string, unknown>,
	key: string,
	label: string,
	values: ReadonlySet<T>,
): T {
	const value = record[key];
	if (
		!hasOwnField(record, key) ||
		typeof value !== "string" ||
		!values.has(value as T)
	) {
		throw new TypeError(
			`${label}.${key} must be one of: ${[...values].join(", ")}`,
		);
	}

	return value as T;
}

function readPositiveSafeInteger(
	record: Record<string, unknown>,
	key: string,
	label: string,
): number {
	const value = record[key];
	if (
		!hasOwnField(record, key) ||
		!Number.isSafeInteger(value) ||
		(value as number) < 1
	) {
		throw new TypeError(`${label}.${key} must be a positive safe integer`);
	}

	return value as number;
}

function readPositiveU32(
	record: Record<string, unknown>,
	key: string,
	label: string,
): number {
	const value = record[key];
	if (
		!hasOwnField(record, key) ||
		!Number.isSafeInteger(value) ||
		(value as number) < 1 ||
		(value as number) > 0xffff_ffff
	) {
		throw new TypeError(`${label}.${key} must be a positive u32 integer`);
	}
	return value as number;
}

/**
 * Graph topology is hashed as native Rust `String` bytes. Restrict graph node
 * identifiers to ASCII at this TypeScript boundary so JavaScript UTF-16
 * ordering can never disagree with Rust's UTF-8 lexical ordering.
 */
function readAsciiGraphIdentifier(
	record: Record<string, unknown>,
	key: string,
	label: string,
): string {
	if (!hasOwnField(record, key)) {
		throw new TypeError(`${label}.${key} must be a non-blank ASCII string`);
	}
	return readAsciiGraphIdentifierValue(record[key], `${label}.${key}`);
}

function readAsciiGraphIdentifierValue(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		!isAscii(value)
	) {
		throw new TypeError(`${label} must be a non-blank ASCII string`);
	}
	return value;
}

function isAscii(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		if (value.charCodeAt(index) > 0x7f) return false;
	}
	return true;
}

function readNonNegativeSafeInteger(
	record: Record<string, unknown>,
	key: string,
	label: string,
): number {
	const value = record[key];
	if (
		!hasOwnField(record, key) ||
		!Number.isSafeInteger(value) ||
		(value as number) < 0
	) {
		throw new TypeError(`${label}.${key} must be a non-negative safe integer`);
	}
	return value as number;
}

function readOptionalNonNegativeSafeInteger(
	record: Record<string, unknown>,
	key: string,
	label: string,
): number | undefined {
	if (!hasOwnField(record, key)) return undefined;
	const value = record[key];
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new TypeError(
			`${label}.${key} must be a non-negative safe integer when provided`,
		);
	}
	return value as number;
}

function readSha256Digest(
	record: Record<string, unknown>,
	key: string,
	label: string,
): string {
	const value = record[key];
	if (
		!hasOwnField(record, key) ||
		typeof value !== "string" ||
		!SHA256_DIGEST_PATTERN.test(value)
	) {
		throw new TypeError(`${label}.${key} must be a sha256 digest`);
	}

	return value;
}

function readOptionalSha256Digest(
	record: Record<string, unknown>,
	key: string,
	label: string,
): string | undefined {
	if (!hasOwnField(record, key)) return undefined;
	return readSha256Digest(record, key, label);
}

function readCanonicalUuid(
	record: Record<string, unknown>,
	key: string,
	label: string,
): string {
	const value = readRequiredString(record, key, label);
	if (!CANONICAL_UUID_PATTERN.test(value)) {
		throw new TypeError(
			`${label}.${key} must be a canonical UUID event reference`,
		);
	}
	return value;
}

function readOptionalRequiredString(
	record: Record<string, unknown>,
	key: string,
	label: string,
): string | undefined {
	if (!hasOwnField(record, key)) return undefined;
	return readRequiredString(record, key, label);
}

function readActionResourceUsageV2(input: unknown): ActionResourceUsageV2 {
	const record = readClosedRecord(
		input,
		"actionReceiptRecordedV2.resourceUsage",
		ACTION_RESOURCE_USAGE_V2_FIELDS,
	);
	const cpuTimeMs = readOptionalNonNegativeSafeInteger(
		record,
		"cpuTimeMs",
		"actionReceiptRecordedV2.resourceUsage",
	);
	const peakMemoryBytes = readOptionalNonNegativeSafeInteger(
		record,
		"peakMemoryBytes",
		"actionReceiptRecordedV2.resourceUsage",
	);
	const inputBytes = readOptionalNonNegativeSafeInteger(
		record,
		"inputBytes",
		"actionReceiptRecordedV2.resourceUsage",
	);
	const outputBytes = readOptionalNonNegativeSafeInteger(
		record,
		"outputBytes",
		"actionReceiptRecordedV2.resourceUsage",
	);
	const inputTokens = readOptionalNonNegativeSafeInteger(
		record,
		"inputTokens",
		"actionReceiptRecordedV2.resourceUsage",
	);
	const outputTokens = readOptionalNonNegativeSafeInteger(
		record,
		"outputTokens",
		"actionReceiptRecordedV2.resourceUsage",
	);
	return {
		wallTimeMs: readNonNegativeSafeInteger(
			record,
			"wallTimeMs",
			"actionReceiptRecordedV2.resourceUsage",
		),
		...(cpuTimeMs === undefined ? {} : { cpuTimeMs }),
		...(peakMemoryBytes === undefined ? {} : { peakMemoryBytes }),
		...(inputBytes === undefined ? {} : { inputBytes }),
		...(outputBytes === undefined ? {} : { outputBytes }),
		...(inputTokens === undefined ? {} : { inputTokens }),
		...(outputTokens === undefined ? {} : { outputTokens }),
	};
}

/**
 * Copy a dense array through own descriptors. Untrusted arrays can be Proxies,
 * so direct indexed reads and `hasOwnProperty` calls are not a safe parser
 * boundary: either can run a hostile trap and leak its exception. Existing
 * accessor-backed array semantics are retained with exactly one guarded read.
 */
function readDenseDataArray(
	input: unknown,
	label: string,
	notArrayMessage: string,
	missingElementMessage: (index: number) => string,
): readonly unknown[] {
	let isArray = false;
	try {
		isArray = Array.isArray(input);
	} catch {
		throw new TypeError(`${label} must be a closed data array`);
	}
	if (!isArray) {
		throw new TypeError(notArrayMessage);
	}
	const array = input as object;

	let length = 0;
	try {
		const lengthDescriptor = Object.getOwnPropertyDescriptor(array, "length");
		if (
			!lengthDescriptor ||
			!("value" in lengthDescriptor) ||
			!Number.isSafeInteger(lengthDescriptor.value) ||
			lengthDescriptor.value < 0
		) {
			throw new TypeError("invalid array length");
		}
		length = lengthDescriptor.value;
	} catch {
		throw new TypeError(`${label} must be a closed data array`);
	}

	const values: unknown[] = [];
	for (let index = 0; index < length; index += 1) {
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(array, String(index));
		} catch {
			throw new TypeError(`${label} must be a closed data array`);
		}
		if (!descriptor) {
			throw new TypeError(missingElementMessage(index));
		}
		if ("value" in descriptor) {
			values.push(descriptor.value);
			continue;
		}
		if (typeof descriptor.get !== "function") {
			throw new TypeError(missingElementMessage(index));
		}
		try {
			// Preserve the existing one-read semantics for ordinary accessor-backed
			// arrays, while keeping a hostile getter's failure from escaping the
			// public parser boundary.
			values.push(Reflect.apply(descriptor.get, input, []));
		} catch {
			throw new TypeError(`${label} must be a closed data array`);
		}
	}
	return values;
}

function readActionRedactionsV2(input: unknown): readonly ActionRedactionV2[] {
	const entries = readDenseDataArray(
		input,
		"actionReceiptRecordedV2.redactions",
		"actionReceiptRecordedV2.redactions must be an array",
		(index) =>
			`actionReceiptRecordedV2.redactions[${index}] must be an own array element`,
	);
	const redactions: ActionRedactionV2[] = [];
	const seenFields = new Set<string>();
	for (let index = 0; index < entries.length; index += 1) {
		const label = `actionReceiptRecordedV2.redactions[${index}]`;
		const record = readClosedRecord(
			entries[index],
			label,
			ACTION_REDACTION_V2_FIELDS,
		);
		const field = readRequiredString(record, "field", label);
		if (seenFields.has(field)) {
			throw new TypeError(
				`actionReceiptRecordedV2.redactions must not contain duplicate field "${field}"`,
			);
		}
		seenFields.add(field);
		const redactedDigest = readOptionalSha256Digest(
			record,
			"redactedDigest",
			label,
		);
		redactions.push({
			field,
			reason: readRequiredString(record, "reason", label),
			...(redactedDigest === undefined ? {} : { redactedDigest }),
		});
	}
	return redactions;
}

function readOptionalActionFailureV2(
	input: unknown,
): ActionFailureV2 | undefined {
	if (input === undefined) return undefined;
	const record = readClosedRecord(
		input,
		"actionReceiptRecordedV2.failure",
		ACTION_FAILURE_V2_FIELDS,
	);
	const retryable = record.retryable;
	if (!hasOwnField(record, "retryable") || typeof retryable !== "boolean") {
		throw new TypeError(
			"actionReceiptRecordedV2.failure.retryable must be a boolean",
		);
	}
	return {
		code: readRequiredString(record, "code", "actionReceiptRecordedV2.failure"),
		messageDigest: readSha256Digest(
			record,
			"messageDigest",
			"actionReceiptRecordedV2.failure",
		),
		retryable,
	};
}

function readActionReceiptSetEntriesV1(
	input: unknown,
): readonly ActionReceiptSetEntryV1[] {
	const entries = readDenseDataArray(
		input,
		"actionReceiptSetRecordedV1.receipts",
		"actionReceiptSetRecordedV1.receipts must be an array",
		(index) =>
			`actionReceiptSetRecordedV1.receipts[${index}] must be an own array element`,
	);
	const receipts: ActionReceiptSetEntryV1[] = [];
	const seenIds = new Set<string>();
	const seenRefs = new Set<string>();
	const seenDigests = new Set<string>();
	let previousId: string | undefined;
	for (let index = 0; index < entries.length; index += 1) {
		const label = `actionReceiptSetRecordedV1.receipts[${index}]`;
		const record = readClosedRecord(
			entries[index],
			label,
			ACTION_RECEIPT_SET_ENTRY_V1_FIELDS,
		);
		const actionId = readRequiredString(record, "actionId", label);
		const actionReceiptRef = readRequiredString(
			record,
			"actionReceiptRef",
			label,
		);
		const actionReceiptDigest = readSha256Digest(
			record,
			"actionReceiptDigest",
			label,
		);
		if (previousId !== undefined && actionId <= previousId) {
			throw new TypeError(
				"actionReceiptSetRecordedV1.receipts must be strictly sorted by actionId",
			);
		}
		if (
			seenIds.has(actionId) ||
			seenRefs.has(actionReceiptRef) ||
			seenDigests.has(actionReceiptDigest)
		) {
			throw new TypeError(
				"actionReceiptSetRecordedV1.receipts must have unique actionId, actionReceiptRef, and actionReceiptDigest values",
			);
		}
		previousId = actionId;
		seenIds.add(actionId);
		seenRefs.add(actionReceiptRef);
		seenDigests.add(actionReceiptDigest);
		receipts.push({ actionId, actionReceiptRef, actionReceiptDigest });
	}
	return receipts;
}

function readCommitSha(
	record: Record<string, unknown>,
	key: string,
	label: string,
): string {
	const value = record[key];
	if (
		!hasOwnField(record, key) ||
		typeof value !== "string" ||
		!COMMIT_SHA_PATTERN.test(value)
	) {
		throw new TypeError(
			`${label}.${key} must be a full 40- or 64-character lowercase hexadecimal commit SHA`,
		);
	}

	return value;
}

function readOptionalTargetRef(
	record: Record<string, unknown>,
	key: string,
	label: string,
): string | undefined {
	if (!hasOwnField(record, key)) {
		return undefined;
	}
	const value = readRequiredString(record, key, label);
	if (!isCanonicalTargetRef(value)) {
		throw new TypeError(
			`${label}.${key} must be a canonical refs/heads branch ref`,
		);
	}
	return value;
}

function isCanonicalTargetRef(value: string): boolean {
	const branch = value.startsWith("refs/heads/")
		? value.slice("refs/heads/".length)
		: undefined;
	if (
		branch === undefined ||
		branch.length === 0 ||
		branch.endsWith("/") ||
		branch.endsWith(".") ||
		branch.endsWith(".lock") ||
		branch.includes("..") ||
		branch.includes("//") ||
		branch.includes("@{")
	) {
		return false;
	}

	return branch
		.split("/")
		.every(
			(component) =>
				component.length > 0 &&
				!component.startsWith(".") &&
				!component.endsWith(".") &&
				component !== "@" &&
				/^[A-Za-z0-9_.@-]+$/.test(component),
		);
}

function readDispatchBudget(input: unknown): DispatchBudgetV1 {
	const record = readClosedRecord(
		input,
		"dispatchEnvelope.budget",
		DISPATCH_BUDGET_FIELDS,
	);
	const maxTokens = readOptionalPositiveU32(
		record,
		"maxTokens",
		"dispatchEnvelope.budget",
	);
	const maxComputeTimeMs = readOptionalPositiveU32(
		record,
		"maxComputeTimeMs",
		"dispatchEnvelope.budget",
	);

	return {
		...(maxTokens === undefined ? {} : { maxTokens }),
		...(maxComputeTimeMs === undefined ? {} : { maxComputeTimeMs }),
	};
}

function readOptionalPositiveU32(
	record: Record<string, unknown>,
	key: string,
	label: string,
): number | undefined {
	if (!hasOwnField(record, key)) {
		return undefined;
	}
	const value = record[key];
	if (
		!Number.isSafeInteger(value) ||
		(value as number) < 1 ||
		(value as number) > 0xffff_ffff
	) {
		throw new TypeError(
			`${label}.${key} must be a positive u32 integer when provided`,
		);
	}

	return value as number;
}

function readSignatureRef(input: unknown): SignatureRefV1 {
	const record = readClosedRecord(
		input,
		"dispatchEnvelope.signatureRef",
		SIGNATURE_REF_FIELDS,
	);

	return {
		algorithm: readRequiredString(
			record,
			"algorithm",
			"dispatchEnvelope.signatureRef",
		),
		keyId: readRequiredString(record, "keyId", "dispatchEnvelope.signatureRef"),
		signature: readRequiredString(
			record,
			"signature",
			"dispatchEnvelope.signatureRef",
		),
	};
}

function readRfc3339UtcTimestamp(
	record: Record<string, unknown>,
	key: string,
	label: string,
): Rfc3339UtcTimestamp {
	const value = record[key];
	if (!hasOwnField(record, key) || typeof value !== "string") {
		throw new TypeError(`${label}.${key} must be an RFC3339 UTC timestamp`);
	}

	const match = RFC3339_UTC_PATTERN.exec(value);
	if (!match) {
		throw new TypeError(`${label}.${key} must be an RFC3339 UTC timestamp`);
	}

	const [, year, month, day, hour, minute, second, fraction] = match;
	const fractionalSecond = fraction ?? "";
	const milliseconds = fractionalSecond.slice(0, 3).padEnd(3, "0");
	const normalizedInput = `${year}-${month}-${day}T${hour}:${minute}:${second}.${milliseconds}Z`;
	const epochMs = Date.parse(normalizedInput);
	if (Number.isNaN(epochMs)) {
		throw new TypeError(`${label}.${key} must be an RFC3339 UTC timestamp`);
	}

	if (new Date(epochMs).toISOString() !== normalizedInput) {
		throw new TypeError(`${label}.${key} must be an RFC3339 UTC timestamp`);
	}

	return {
		value,
		epochMs,
		wholeSecondEpochMs: epochMs - Number(milliseconds),
		fractionalSecond,
	};
}

interface Rfc3339UtcTimestamp {
	readonly value: string;
	readonly epochMs: number;
	readonly wholeSecondEpochMs: number;
	readonly fractionalSecond: string;
}

/**
 * Date only preserves millisecond precision. Authority timestamps must retain
 * their complete RFC3339 fractional seconds, otherwise a later expiry such as
 * `.1234561Z` would be mistaken for the same instant as `.123456Z`.
 */
function compareRfc3339UtcTimestamps(
	left: Rfc3339UtcTimestamp,
	right: Rfc3339UtcTimestamp,
): number {
	if (left.wholeSecondEpochMs !== right.wholeSecondEpochMs) {
		return left.wholeSecondEpochMs - right.wholeSecondEpochMs;
	}

	const fractionalWidth = Math.max(
		left.fractionalSecond.length,
		right.fractionalSecond.length,
	);
	const leftFraction = left.fractionalSecond.padEnd(fractionalWidth, "0");
	const rightFraction = right.fractionalSecond.padEnd(fractionalWidth, "0");
	if (leftFraction === rightFraction) {
		return 0;
	}
	return leftFraction < rightFraction ? -1 : 1;
}

function readReviewFindings(input: unknown): readonly ReviewFindingV1[] {
	// Never invoke methods supplied by an untrusted array. Besides permitting an
	// overridden `map`, Array.prototype.map skips holes, which could otherwise
	// turn a sparse finding list into an apparently valid, shorter contract.
	const entries = readDenseDataArray(
		input,
		"reviewVerdict.findings",
		"reviewVerdict.findings must be an array",
		(index) => `reviewVerdict.findings[${index}] must be an own array element`,
	);
	const findings: ReviewFindingV1[] = [];
	for (let index = 0; index < entries.length; index += 1) {
		const item = entries[index];
		const label = `reviewVerdict.findings[${index}]`;
		const record = readClosedRecord(item, label, REVIEW_FINDING_FIELDS);
		findings.push({
			severity: readEnum(record, "severity", label, REVIEW_FINDING_SEVERITIES),
			checkId: readRequiredString(record, "checkId", label),
			file: readRequiredString(record, "file", label),
			line: readPositiveSafeInteger(record, "line", label),
			explanation: readRequiredString(record, "explanation", label),
			evidenceRefs: readNonEmptyStringArray(record, "evidenceRefs", label),
		});
	}
	return findings;
}

function readConfidence(
	record: Record<string, unknown>,
	key: string,
	label: string,
): number {
	const value = record[key];
	if (
		!hasOwnField(record, key) ||
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < 0 ||
		value > 1
	) {
		throw new TypeError(
			`${label}.${key} must be a finite number between 0 and 1`,
		);
	}

	return value;
}

function readNonEmptyStringArray(
	record: Record<string, unknown>,
	key: string,
	label: string,
): readonly string[] {
	const value = record[key];
	if (!hasOwnField(record, key)) {
		throw new TypeError(
			`${label}.${key} must be a non-empty array of non-empty strings`,
		);
	}
	const values = readDenseDataArray(
		value,
		`${label}.${key}`,
		`${label}.${key} must be a non-empty array of non-empty strings`,
		() => `${label}.${key} must be a non-empty array of non-empty strings`,
	);
	if (values.length === 0) {
		throw new TypeError(
			`${label}.${key} must be a non-empty array of non-empty strings`,
		);
	}

	// As above, use indexed own-element checks instead of an input-controlled
	// `some` method. Return a fresh dense array so callers never retain an alias
	// to a mutable, attacker-owned evidence array.
	const strings: string[] = [];
	for (const item of values) {
		if (typeof item !== "string" || item.length === 0) {
			throw new TypeError(
				`${label}.${key} must be a non-empty array of non-empty strings`,
			);
		}
		strings.push(item);
	}

	return strings;
}

function hasOwnField(record: object, key: string): boolean {
	// biome-ignore lint/suspicious/noPrototypeBuiltins: Contracts must not trust an input object's prototype.
	return Object.prototype.hasOwnProperty.call(record, key);
}
