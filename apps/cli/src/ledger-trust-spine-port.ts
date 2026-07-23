import type {
	ActionEvidenceVersionV1,
	CandidateAcceptanceEvidenceInput,
	CandidateAcceptanceRecord,
	CandidateEvidencePort,
	CandidatePromotionDecisionPort,
	CandidatePromotionIntentInput,
	CandidateReviewEvidenceInput,
	CandidateReviewRecord,
	DurableActionReceiptV2,
	DurableActionRequestV2,
	GovernedActionEvidencePort,
	GovernedDispatchLineageV3,
	GovernedReviewCandidateContextV1,
	ActionReceiptRecordedV2 as KernelActionReceiptRecordedV2,
	ActionReceiptSetEntryV1 as KernelActionReceiptSetEntryV1,
	ActionReceiptSetRecordedV1 as KernelActionReceiptSetRecordedV1,
	ActionRequestedV2 as KernelActionRequestedV2,
	CandidateCompletionRecordedV1 as KernelCandidateCompletionRecordedV1,
	CandidateCreatedV2 as KernelCandidateCreatedV2,
	ReviewVerdictRecordedV2 as KernelReviewVerdictRecordedV2,
	PromotionDecisionV1,
	RecordActionReceiptV2Input,
	RecordCandidatePromotionResultInput,
	SealActionReceiptSetV1Input,
} from "@buildplane/kernel";
import {
	canonicalActionReceiptRecordedV2Digest,
	canonicalActionReceiptSetRecordedV1Digest,
	canonicalActionRequestedV2Digest,
	canonicalCandidateCompletionRecordedV1Digest,
	canonicalCandidateViewV1Digest,
	canonicalReviewVerdictOutputV1Digest,
	canonicalSha256Digest,
	isCanonicalBuildplaneCandidateRef,
	type PromotionGitBindingV1,
	parseActionReceiptRecordedV2,
	parseActionReceiptSetRecordedV1,
	parseActionRequestedV2,
	parseCandidateCompletionRecordedV1,
	parseCandidateCreatedV2,
	parseReviewVerdictRecordedV2,
	parseReviewVerdictV1,
	parseSignablePromotionDecisionV1,
	type ReviewVerdictV1,
} from "@buildplane/kernel";
import {
	ActionKindV1,
	ActionReceiptOutcomeV2,
	CandidateAcceptanceOutcomeV1,
	type CandidateAcceptanceRecordedV1,
	ExecutionRoleV1,
	type ActionReceiptRecordedV2 as LedgerActionReceiptRecordedV2,
	type ActionReceiptSetRecordedV1 as LedgerActionReceiptSetRecordedV1,
	type ActionRequestedV2 as LedgerActionRequestedV2,
	type CandidateCompletionRecordedV1 as LedgerCandidateCompletionRecordedV1,
	type CandidateCreatedV2 as LedgerCandidateCreatedV2,
	type ReviewVerdictRecordedV2 as LedgerReviewVerdictRecordedV2,
	newEventId,
	type Payload,
	PromotionDecisionKindV1,
	type PromotionDecisionRecordedV1,
	PromotionResultOutcomeV1,
	type PromotionResultRecordedV1,
	PromotionWorktreeSyncStateV1,
	ReviewDecisionV1,
	ReviewFindingSeverityV1,
	type ReviewVerdictRecordedV1,
	type TapeEmitter,
} from "@buildplane/ledger-client";
import { digest } from "@buildplane/planforge";
import { isNativeRfc3339Utc } from "./native-rfc3339-utc.js";

const FULL_GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * The protected native authority service is currently a single writer per
 * governed run. These process-wide gates close the additional same-process
 * case where two TypeScript port instances share that authority session. A
 * future multi-writer broker must replace this with a native atomic
 * append-or-resolve operation keyed by candidate-created event ID.
 */
const candidateCompletionTails = new Map<string, Promise<void>>();
const indeterminateCandidateCompletionWrites = new Map<string, Error>();

/**
 * A mandatory signed-tape verifier and durable lookup. The promotion writer
 * deliberately cannot infer authority from caller-provided refs: the resolver
 * must verify the exact candidate, acceptance, review, envelope, and operator
 * authority before a decision event is emitted. It also returns the actual
 * signed payloads for recovery, so a stale local intent can never be silently
 * reclassified as an existing tape decision/result.
 */
export interface PromotionReferenceResolver {
	verifyPromotionIntent(input: VerifiedPromotionIntent): Promise<void>;
	/**
	 * Resolve the immutable Git receipt and its referenced objects through the
	 * caller-owned action gateway before a strict terminal result can become a
	 * signed tape event. Parsed caller strings are only lookup requests: this
	 * verifier must independently check the candidate ref/digest, target/base,
	 * merge commit and parents, tree, post-CAS target head, and sync state.
	 */
	verifyPromotionResult(input: VerifiedPromotionResult): Promise<void>;
	findDecisionReference(input: {
		readonly runId: string;
		readonly candidateDigest: string;
		readonly idempotencyKey: string;
	}): Promise<ResolvedPromotionDecision | undefined>;
	findResultReference(input: {
		readonly runId: string;
		readonly candidateDigest: string;
		readonly idempotencyKey: string;
	}): Promise<ResolvedPromotionResult | undefined>;
}

export interface CandidatePromotionLedgerPortOptions {
	/** Clock injection keeps the signed wire record deterministic in tests. */
	readonly now?: () => string;
	/** Signed candidate/evidence/authority verification and recovery lookup. */
	readonly references: PromotionReferenceResolver;
}

/**
 * Native-replay-derived data used only to shape a V2 review wire projection.
 *
 * This is deliberately not named or treated as local authority: TypeScript
 * objects are forgeable, including the nested binding marker below. A future
 * native `governed-review-v2` recorder must rederive these facts from the
 * protected tape and CAS before it signs or appends a verdict. This module
 * only validates structural consistency for tests and adapter development;
 * it never appends `review_verdict_recorded_v2` itself.
 */
export interface NativeReviewVerdictV2Projection {
	readonly candidate: {
		readonly candidate: KernelCandidateCreatedV2;
		readonly dispatch: GovernedDispatchLineageV3;
		readonly acceptance: CandidateAcceptanceRecordedV1;
	};
	readonly reviewer: {
		readonly dispatch: GovernedDispatchLineageV3;
		readonly actionRequest: DurableActionRequestV2;
		readonly actionReceipt: DurableActionReceiptV2;
		readonly actionReceiptSet: KernelActionReceiptSetRecordedV1;
		readonly candidateViewRef: string;
		readonly candidateView: GovernedReviewCandidateContextV1;
		/** Identity of the detached reviewer signer, verified by native replay. */
		readonly reviewerAuthority: string;
	};
}

/** Input to the pure V2 review wire serializer; it is not a tape append API. */
export interface CreateReviewVerdictV2ProjectionInput {
	readonly evidence: NativeReviewVerdictV2Projection;
	readonly verdict: ReviewVerdictV1;
	readonly reviewRef: string;
	readonly reviewedAt: string;
}

/** Immutable, normalized evidence passed to the tape-backed authority verifier. */
export type VerifiedPromotionCandidateV1 = Readonly<{
	readonly schemaVersion: 1;
	readonly candidateDigest: string;
	readonly candidateCommitSha: string;
	readonly baseCommitSha: string;
	readonly envelopeDigest: string;
	readonly acceptanceContractDigest: string;
	/** Legacy pre-effect receipt evidence is valid only for V1 candidates. */
	readonly actionReceiptDigest: string;
	readonly candidateCreatedRef?: never;
	readonly actionReceiptSetRef?: never;
	readonly actionReceiptSetDigest?: never;
}>;

export type VerifiedPromotionCandidateV2 = Readonly<{
	readonly schemaVersion: 2;
	readonly candidateDigest: string;
	readonly candidateCommitSha: string;
	readonly baseCommitSha: string;
	readonly envelopeDigest: string;
	readonly acceptanceContractDigest: string;
	readonly actionEvidenceVersion: ActionEvidenceVersionV1;
	/** Signed immutable candidate evidence required by all V2/V3 candidates. */
	readonly candidateCreatedRef: string;
	readonly actionReceiptSetRef: string;
	readonly actionReceiptSetDigest: string;
	/** A V2 candidate must never be verified through V1 receipt lineage. */
	readonly actionReceiptDigest?: never;
}>;

export interface VerifiedPromotionIntent {
	readonly runId: string;
	readonly candidate:
		| VerifiedPromotionCandidateV1
		| VerifiedPromotionCandidateV2;
	readonly acceptance: CandidateAcceptanceRecord;
	readonly review: {
		readonly candidateDigest: string;
		readonly candidateCommitSha: string;
		readonly reviewRef: string;
		readonly verdict: ReviewVerdictV1;
	};
	readonly decision: PromotionDecisionV1;
}

/**
 * Normalized strict post-CAS evidence submitted to the caller-owned receipt
 * resolver. `candidateRef` is derived from the candidate-keyed receipt name
 * only as a Git lookup request; the resolver must resolve and verify it rather
 * than trusting this parsed value.
 */
export interface VerifiedPromotionResult {
	readonly runId: string;
	readonly candidate: {
		readonly candidateDigest: string;
		readonly candidateRef: string;
		readonly candidateCommitSha: string;
		readonly baseCommitSha: string;
	};
	readonly idempotencyKey: string;
	readonly promotionDecisionRef: string;
	readonly decision: {
		readonly targetRef: string;
		readonly baseCommitSha: string;
	};
	readonly outcome: "promoted" | "reconciliation_required";
	readonly mergedHeadSha: string;
	readonly promotionGitBinding: PromotionGitBindingV1;
}

/** A decision recovered from the signed tape, including its exact payload. */
export interface ResolvedPromotionDecision {
	readonly reference: string;
	readonly payload: PromotionDecisionRecordedV1;
}

/** A terminal result recovered from the signed tape, including its exact payload. */
export interface ResolvedPromotionResult {
	readonly reference: string;
	readonly payload: PromotionResultRecordedV1;
}

interface CandidateIdentity {
	readonly candidateDigest: string;
	readonly candidateCommitSha: string;
}

interface DecisionReference {
	readonly reference: string;
	readonly fingerprint: string;
	readonly decision: PromotionDecisionKindV1;
	readonly strictBinding?: StrictPromotionDecisionBinding;
}

interface StrictPromotionDecisionBinding {
	readonly targetRef: string;
	readonly baseCommitSha: string;
}

/** Historical bindings written before post-CAS facts were introduced. */
interface LegacyPromotionGitBindingV1 {
	readonly targetRef: string;
	readonly targetHeadBeforeSha: string;
	readonly candidateCommitSha: string;
	readonly mergedTreeDigest: string;
}

type PromotionGitBindingFingerprint =
	| PromotionGitBindingV1
	| LegacyPromotionGitBindingV1;

function requireNonEmpty(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${field} must be a non-empty string.`);
	}
	return value;
}

function canonicalDigest(value: unknown, field: string): string {
	if (typeof value !== "string") {
		throw new TypeError(`${field} must be a canonical SHA-256 digest.`);
	}
	try {
		return canonicalSha256Digest(value);
	} catch (error) {
		throw new TypeError(
			`${field} must be a canonical SHA-256 digest: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

function canonicalGitObjectId(value: unknown, field: string): string {
	if (typeof value !== "string" || !FULL_GIT_OBJECT_ID.test(value)) {
		throw new TypeError(`${field} must be a full 40- or 64-hex Git object ID.`);
	}
	return value.toLowerCase();
}

function canonicalTargetRef(value: unknown, field: string): string {
	if (typeof value !== "string") {
		throw new TypeError(`${field} must be a canonical refs/heads branch ref.`);
	}
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
		branch.includes("@{") ||
		!branch
			.split("/")
			.every(
				(component) =>
					component.length > 0 &&
					!component.startsWith(".") &&
					!component.endsWith(".") &&
					component !== "@" &&
					/^[A-Za-z0-9_.@-]+$/.test(component),
			)
	) {
		throw new TypeError(`${field} must be a canonical refs/heads branch ref.`);
	}
	return value;
}

function canonicalPromotionReceiptRef(value: unknown, field: string): string {
	const prefix = "refs/buildplane/promotions/";
	if (typeof value !== "string" || !value.startsWith(prefix)) {
		throw new TypeError(
			`${field} must be a canonical candidate-keyed promotion receipt ref.`,
		);
	}
	const candidateRef = `refs/buildplane/candidates/${value.slice(prefix.length)}`;
	if (!isCanonicalBuildplaneCandidateRef(candidateRef)) {
		throw new TypeError(
			`${field} must mirror a canonical Buildplane candidate ref.`,
		);
	}
	return value;
}

function candidateRefForPromotionReceipt(receiptRef: string): string {
	const prefix = "refs/buildplane/promotions/";
	if (!receiptRef.startsWith(prefix)) {
		throw new TypeError(
			"promotion receipt ref must be rooted under refs/buildplane/promotions/.",
		);
	}
	const candidateRef = `refs/buildplane/candidates/${receiptRef.slice(prefix.length)}`;
	if (!isCanonicalBuildplaneCandidateRef(candidateRef)) {
		throw new TypeError(
			"promotion receipt ref must derive a canonical Buildplane candidate ref.",
		);
	}
	return candidateRef;
}

function canonicalPromotionGitBinding(
	binding: PromotionGitBindingV1 | undefined,
	field: string,
): PromotionGitBindingV1 {
	if (!binding || typeof binding !== "object") {
		throw new TypeError(`${field} must contain strict Git-binding evidence.`);
	}
	if (
		!Array.isArray(binding.mergeParentShas) ||
		binding.mergeParentShas.length !== 2
	) {
		throw new TypeError(
			`${field}.mergeParentShas must contain exactly two SHAs.`,
		);
	}
	return {
		targetRef: canonicalTargetRef(binding.targetRef, `${field}.targetRef`),
		targetHeadBeforeSha: canonicalGitObjectId(
			binding.targetHeadBeforeSha,
			`${field}.targetHeadBeforeSha`,
		),
		targetHeadAfterSha: canonicalGitObjectId(
			binding.targetHeadAfterSha,
			`${field}.targetHeadAfterSha`,
		),
		mergedHeadSha: canonicalGitObjectId(
			binding.mergedHeadSha,
			`${field}.mergedHeadSha`,
		),
		candidateCommitSha: canonicalGitObjectId(
			binding.candidateCommitSha,
			`${field}.candidateCommitSha`,
		),
		mergeParentShas: [
			canonicalGitObjectId(
				binding.mergeParentShas[0],
				`${field}.mergeParentShas[0]`,
			),
			canonicalGitObjectId(
				binding.mergeParentShas[1],
				`${field}.mergeParentShas[1]`,
			),
		],
		mergedTreeSha: canonicalGitObjectId(
			binding.mergedTreeSha,
			`${field}.mergedTreeSha`,
		),
		mergedTreeDigest: canonicalDigest(
			binding.mergedTreeDigest,
			`${field}.mergedTreeDigest`,
		),
		promotionReceiptRef: canonicalPromotionReceiptRef(
			binding.promotionReceiptRef,
			`${field}.promotionReceiptRef`,
		),
		worktreeSyncState: canonicalPromotionWorktreeSyncState(
			binding.worktreeSyncState,
			`${field}.worktreeSyncState`,
		),
	};
}

function canonicalPromotionWorktreeSyncState(
	value: unknown,
	field: string,
): PromotionGitBindingV1["worktreeSyncState"] {
	if (
		value === "pending_reconciliation" ||
		value === "root_checkout_stale" ||
		value === "target_advanced"
	) {
		return value;
	}
	throw new TypeError(
		`${field} must be 'pending_reconciliation', 'root_checkout_stale', or 'target_advanced'.`,
	);
}

function requirePromotionGitBindingForOutcome(
	binding: PromotionGitBindingV1,
	mergedHeadSha: string,
	outcome: "promoted" | "reconciliation_required",
	field: string,
): PromotionGitBindingV1 {
	if (binding.mergedHeadSha !== mergedHeadSha) {
		throw new TypeError(
			`${field}.mergedHeadSha must equal the promotion result mergedHeadSha.`,
		);
	}
	if (
		binding.mergeParentShas[0] !== binding.targetHeadBeforeSha ||
		binding.mergeParentShas[1] !== binding.candidateCommitSha
	) {
		throw new TypeError(
			`${field}.mergeParentShas must bind the target base and immutable candidate commit in order.`,
		);
	}
	if (outcome === "promoted") {
		throw new TypeError(
			`${field} strict target-bound promotion results must record reconciliation_required with root_checkout_stale or target_advanced; historical unbound promoted records are read-only compatibility.`,
		);
	}
	const isExpectedState =
		binding.worktreeSyncState === "root_checkout_stale" ||
		binding.worktreeSyncState === "target_advanced";
	if (!isExpectedState) {
		throw new TypeError(
			`${field}.worktreeSyncState must be 'root_checkout_stale' or 'target_advanced' for reconciliation_required.`,
		);
	}
	if (binding.worktreeSyncState === "root_checkout_stale") {
		if (binding.targetHeadAfterSha !== mergedHeadSha) {
			throw new TypeError(
				`${field}.targetHeadAfterSha must equal mergedHeadSha when the root checkout is stale.`,
			);
		}
	} else if (
		binding.worktreeSyncState === "target_advanced" &&
		binding.targetHeadAfterSha === mergedHeadSha
	) {
		throw new TypeError(
			`${field}.targetHeadAfterSha cannot equal mergedHeadSha when the target advanced.`,
		);
	}
	return binding;
}

function toPromotionWorktreeSyncStateWire(
	value: PromotionGitBindingV1["worktreeSyncState"],
): PromotionWorktreeSyncStateV1 {
	switch (value) {
		case "pending_reconciliation":
			return PromotionWorktreeSyncStateV1.PendingReconciliation;
		case "root_checkout_stale":
			return PromotionWorktreeSyncStateV1.RootCheckoutStale;
		case "target_advanced":
			return PromotionWorktreeSyncStateV1.TargetAdvanced;
	}
	throw new TypeError("unsupported promotion worktree-sync state.");
}

function requireRfc3339Utc(value: unknown, field: string): string {
	if (!isNativeRfc3339Utc(value)) {
		throw new TypeError(`${field} must be a valid RFC3339 UTC timestamp.`);
	}
	return value;
}

function candidateIdentity(candidate: {
	readonly candidateDigest: string;
	readonly candidateCommitSha: string;
}): CandidateIdentity {
	return {
		candidateDigest: canonicalDigest(
			candidate.candidateDigest,
			"candidate.candidateDigest",
		),
		candidateCommitSha: canonicalGitObjectId(
			candidate.candidateCommitSha,
			"candidate.candidateCommitSha",
		),
	};
}

function candidateKey(
	runId: string,
	candidateDigest: string,
	idempotencyKey: string,
): string {
	return `${runId}\u0000${candidateDigest}\u0000${idempotencyKey}`;
}

function requireCheckResults(
	checks: readonly { readonly command: string; readonly exitCode: number }[],
): readonly { readonly command: string; readonly exitCode: number }[] {
	return checks.map((check, index) => {
		const command = requireNonEmpty(
			check.command,
			`checkResults[${index}].command`,
		);
		if (!Number.isSafeInteger(check.exitCode)) {
			throw new TypeError(
				`checkResults[${index}].exitCode must be a safe integer.`,
			);
		}
		return { command, exitCode: check.exitCode };
	});
}

function toCandidateAcceptanceOutcome(
	outcome: "passed" | "rejected",
): CandidateAcceptanceOutcomeV1 {
	return outcome === "passed"
		? CandidateAcceptanceOutcomeV1.Passed
		: CandidateAcceptanceOutcomeV1.Rejected;
}

function toReviewDecision(decision: string): ReviewDecisionV1 {
	switch (decision) {
		case "approve":
			return ReviewDecisionV1.Approve;
		case "request_changes":
			return ReviewDecisionV1.RequestChanges;
		case "reject":
			return ReviewDecisionV1.Reject;
		case "abstain":
			return ReviewDecisionV1.Abstain;
		default:
			throw new TypeError(`Unsupported review decision: ${decision}`);
	}
}

function toReviewFindingSeverity(severity: string): ReviewFindingSeverityV1 {
	switch (severity) {
		case "info":
			return ReviewFindingSeverityV1.Info;
		case "low":
			return ReviewFindingSeverityV1.Low;
		case "medium":
			return ReviewFindingSeverityV1.Medium;
		case "high":
			return ReviewFindingSeverityV1.High;
		case "critical":
			return ReviewFindingSeverityV1.Critical;
		default:
			throw new TypeError(`Unsupported review finding severity: ${severity}`);
	}
}

function toPromotionDecisionKind(
	decision: "promote" | "reject",
): PromotionDecisionKindV1 {
	return decision === "promote"
		? PromotionDecisionKindV1.Promote
		: PromotionDecisionKindV1.Reject;
}

function requirePromotionDecisionKind(
	value: unknown,
	field: string,
): PromotionDecisionKindV1 {
	if (value === PromotionDecisionKindV1.Promote) {
		return PromotionDecisionKindV1.Promote;
	}
	if (value === PromotionDecisionKindV1.Reject) {
		return PromotionDecisionKindV1.Reject;
	}
	throw new TypeError(`${field} must be 'promote' or 'reject'.`);
}

function flushWriteAhead(emitter: TapeEmitter): Promise<void> {
	// `emit` is synchronous and may throw. `flush` is the durable boundary: no
	// caller receives a candidate evidence/reference until its event is on tape.
	return emitter.flush();
}

/**
 * Converts immutable deterministic-check evidence to the closed Rust wire
 * shape. `acceptance_ref` is the explicit UUID of this event, so callers never
 * infer an evidence link from the mutable emitter's latest ack.
 */
export function toCandidateAcceptanceWirePayload(
	input: CandidateAcceptanceEvidenceInput,
	acceptanceRef: string,
): CandidateAcceptanceRecordedV1 {
	const identity = candidateIdentity(input.candidate);
	const runId = requireNonEmpty(input.runId, "runId");
	const evaluatedAt = requireRfc3339Utc(input.evaluatedAt, "evaluatedAt");
	const checks = requireCheckResults(input.checkResults);
	const acceptanceContractDigest = canonicalDigest(
		input.acceptanceContractDigest,
		"acceptanceContractDigest",
	);
	if (input.outcome !== "passed" && input.outcome !== "rejected") {
		throw new TypeError("outcome must be 'passed' or 'rejected'.");
	}
	if (
		input.diffScopeStatus !== "passed" &&
		input.diffScopeStatus !== "blocked"
	) {
		throw new TypeError("diffScopeStatus must be 'passed' or 'blocked'.");
	}
	const outOfScopeFiles = input.outOfScopeFiles.map((file, index) =>
		requireNonEmpty(file, `outOfScopeFiles[${index}]`),
	);
	const reference = requireNonEmpty(acceptanceRef, "acceptanceRef");
	const acceptanceEventId = input.acceptanceEventId
		? requireNonEmpty(input.acceptanceEventId, "acceptanceEventId")
		: undefined;

	return {
		candidate_digest: identity.candidateDigest,
		candidate_commit_sha: identity.candidateCommitSha,
		acceptance_ref: reference,
		acceptance_contract_digest: acceptanceContractDigest,
		acceptance_digest: digest({
			runId,
			candidateDigest: identity.candidateDigest,
			candidateCommitSha: identity.candidateCommitSha,
			acceptanceContractDigest,
			outcome: input.outcome,
			diffScopeStatus: input.diffScopeStatus,
			outOfScopeFiles,
			checkResults: checks,
			evaluatedAt,
			acceptanceEventId: acceptanceEventId ?? null,
		}),
		outcome: toCandidateAcceptanceOutcome(input.outcome),
		evaluated_at: evaluatedAt,
	};
}

/** Converts a closed semantic-review contract to its signed tape payload. */
export function toReviewVerdictWirePayload(
	input: CandidateReviewEvidenceInput,
	reviewRef: string,
): ReviewVerdictRecordedV1 {
	const identity = candidateIdentity(input.candidate);
	const acceptanceDigest = canonicalDigest(
		input.acceptance.candidateDigest,
		"acceptance.candidateDigest",
	);
	const acceptanceCommitSha = canonicalGitObjectId(
		input.acceptance.candidateCommitSha,
		"acceptance.candidateCommitSha",
	);
	if (
		acceptanceDigest !== identity.candidateDigest ||
		acceptanceCommitSha !== identity.candidateCommitSha
	) {
		throw new TypeError(
			"acceptance evidence must bind the exact immutable candidate digest and commit.",
		);
	}
	if (input.acceptance.outcome !== "passed") {
		throw new TypeError(
			"semantic review requires a passed deterministic candidate acceptance record.",
		);
	}
	canonicalDigest(
		input.acceptance.acceptanceContractDigest,
		"acceptance.acceptanceContractDigest",
	);
	requireNonEmpty(input.acceptance.acceptanceRef, "acceptance.acceptanceRef");
	requireNonEmpty(input.reviewerRunId, "reviewerRunId");
	const reviewedAt = requireRfc3339Utc(input.reviewedAt, "reviewedAt");
	const reference = requireNonEmpty(reviewRef, "reviewRef");
	const verdict = parseReviewVerdictV1(input.verdict);
	if (verdict.candidateDigest !== identity.candidateDigest) {
		throw new TypeError(
			"review verdict must bind the exact immutable candidate digest.",
		);
	}

	return {
		candidate_digest: identity.candidateDigest,
		candidate_commit_sha: identity.candidateCommitSha,
		review_ref: reference,
		decision: toReviewDecision(verdict.decision),
		findings: verdict.findings.map((finding) => ({
			severity: toReviewFindingSeverity(finding.severity),
			check_id: finding.checkId,
			file: finding.file,
			line: finding.line,
			explanation: finding.explanation,
			evidence_refs: [...finding.evidenceRefs],
		})),
		confidence: verdict.confidence,
		reviewer_manifest_digest: verdict.reviewerManifestDigest,
		reviewed_at: reviewedAt,
	};
}

/**
 * Convert native-replay-derived evidence into the exact V2 review tape shape.
 *
 * This is deliberately a pure serializer. It is not a `TapeEmitter` port and
 * must not be used as a substitute for the future native `governed-review-v2`
 * endpoint, which alone can prove the detached reviewer signature and the
 * sealed V3 model-intent/authorization bindings.
 */
export function toReviewVerdictV2WirePayloadFromProjection(
	input: CreateReviewVerdictV2ProjectionInput,
): LedgerReviewVerdictRecordedV2 {
	const record = requireReviewVerdictV2Projection(input);
	return toReviewVerdictRecordedV2WirePayload(record);
}

/**
 * Convert the kernel's closed V2 review record to the native snake-case wire
 * body. The parser rechecks the candidate-view and closed-output digests so a
 * direct converter caller cannot accidentally serialize a stale verdict.
 */
export function toReviewVerdictRecordedV2WirePayload(
	input: KernelReviewVerdictRecordedV2,
): LedgerReviewVerdictRecordedV2 {
	const review = parseReviewVerdictRecordedV2(input);
	return {
		run_id: review.runId,
		workflow_id: review.workflowId,
		unit_id: review.unitId,
		attempt: review.attempt,
		provenance_ref: review.provenanceRef,
		candidate_digest: review.candidateDigest,
		candidate_commit_sha: review.candidateCommitSha,
		review_ref: review.reviewRef,
		review_verdict_action_id: review.reviewVerdictActionId,
		review_action_request_digest: review.reviewActionRequestDigest,
		review_action_receipt_ref: review.reviewActionReceiptRef,
		review_action_receipt_digest: review.reviewActionReceiptDigest,
		review_output_ref: review.reviewOutputRef,
		review_output_digest: review.reviewOutputDigest,
		decision: toReviewDecision(review.decision),
		findings: review.findings.map((finding) => ({
			severity: toReviewFindingSeverity(finding.severity),
			check_id: finding.checkId,
			file: finding.file,
			line: finding.line,
			explanation: finding.explanation,
			evidence_refs: [...finding.evidenceRefs],
		})),
		confidence: review.confidence,
		acceptance_ref: review.acceptanceRef,
		acceptance_digest: review.acceptanceDigest,
		acceptance_contract_digest: review.acceptanceContractDigest,
		candidate_envelope_digest: review.candidateEnvelopeDigest,
		reviewer_workflow_id: review.reviewerWorkflowId,
		reviewer_dispatch_envelope_digest: review.reviewerDispatchEnvelopeDigest,
		reviewer_unit_id: review.reviewerUnitId,
		reviewer_attempt: review.reviewerAttempt,
		reviewer_execution_role: toExecutionRoleWire(review.reviewerExecutionRole),
		review_action_receipt_set_ref: review.reviewActionReceiptSetRef,
		review_action_receipt_set_digest: review.reviewActionReceiptSetDigest,
		candidate_view: {
			candidate_ref: review.candidateView.candidateRef,
			candidate_digest: review.candidateView.candidateDigest,
			candidate_commit_sha: review.candidateView.candidateCommitSha,
			tree_digest: review.candidateView.treeDigest,
			reviewer_context_manifest_digest:
				review.candidateView.reviewerContextManifestDigest,
			reviewer_sandbox_profile_digest:
				review.candidateView.reviewerSandboxProfileDigest,
			mount_path_digest: review.candidateView.mountPathDigest,
			read_only: review.candidateView.readOnly,
			network_disabled: review.candidateView.networkDisabled,
		},
		candidate_view_ref: review.candidateViewRef,
		candidate_view_digest: review.candidateViewDigest,
		reviewer_manifest_digest: review.reviewerManifestDigest,
		reviewer_authority: review.reviewerAuthority,
		reviewed_at: review.reviewedAt,
	};
}

function requireReviewVerdictV2Projection(
	input: CreateReviewVerdictV2ProjectionInput,
): KernelReviewVerdictRecordedV2 {
	if (!input || typeof input !== "object") {
		throw new TypeError("V2 review projection input must be an object.");
	}
	if (!input.evidence || typeof input.evidence !== "object") {
		throw new TypeError("V2 review projection input requires native evidence.");
	}
	const evidence = input.evidence;
	if (!evidence.candidate || !evidence.reviewer) {
		throw new TypeError(
			"V2 review projection input requires candidate and reviewer evidence.",
		);
	}
	const candidate = parseCandidateCreatedV2(evidence.candidate.candidate);
	const candidateDispatch = evidence.candidate.dispatch;
	assertSealedV3Dispatch(
		candidateDispatch,
		"candidate dispatch",
		"implementer",
	);
	if (
		candidate.runId !== candidateDispatch.runId ||
		candidate.workflowId !== candidateDispatch.workflowId ||
		candidate.unitId !== candidateDispatch.unitId ||
		candidate.attempt !== candidateDispatch.attempt ||
		candidate.provenanceRef !== candidateDispatch.provenanceRef ||
		candidate.baseCommitSha !== candidateDispatch.baseCommitSha ||
		candidate.envelopeDigest !== candidateDispatch.envelopeDigest
	) {
		throw new TypeError(
			"V2 review projection candidate must exactly bind its sealed V3 implementer dispatch.",
		);
	}
	const acceptance = evidence.candidate.acceptance;
	if (!acceptance || typeof acceptance !== "object") {
		throw new TypeError(
			"V2 review projection requires a candidate acceptance record.",
		);
	}
	if (
		acceptance.outcome !== CandidateAcceptanceOutcomeV1.Passed ||
		canonicalDigest(
			acceptance.candidate_digest,
			"acceptance.candidate_digest",
		) !== candidate.candidateDigest ||
		canonicalGitObjectId(
			acceptance.candidate_commit_sha,
			"acceptance.candidate_commit_sha",
		) !== candidate.candidateCommitSha ||
		canonicalDigest(
			acceptance.acceptance_contract_digest,
			"acceptance.acceptance_contract_digest",
		) !== candidateDispatch.acceptanceContractDigest
	) {
		throw new TypeError(
			"V2 review projection acceptance must prove the exact candidate passed its signed acceptance contract.",
		);
	}

	const reviewer = evidence.reviewer;
	const reviewerDispatch = reviewer.dispatch;
	assertSealedV3Dispatch(
		reviewerDispatch,
		"reviewer dispatch",
		"reviewer",
		"adversary",
		"judge",
	);
	if (candidate.runId !== reviewerDispatch.runId) {
		throw new TypeError(
			"V2 review projection candidate and reviewer dispatches must belong to the same run.",
		);
	}
	if (
		candidate.workflowId === reviewerDispatch.workflowId &&
		candidate.unitId === reviewerDispatch.unitId &&
		candidate.attempt === reviewerDispatch.attempt
	) {
		throw new TypeError(
			"V2 review projection requires an independent reviewer workflow unit.",
		);
	}
	const candidateView = reviewer.candidateView;
	if (
		!candidateView ||
		candidateView.schemaVersion !== 1 ||
		candidateView.readOnlyMount?.mode !== "read-only" ||
		candidateView.candidateDigest !== candidate.candidateDigest ||
		candidateView.candidateCommitSha !== candidate.candidateCommitSha ||
		candidateView.candidateRef !== candidate.candidateRef ||
		candidateView.candidateTreeDigest !== candidate.treeDigest ||
		candidateView.context?.contextManifestDigest !==
			reviewerDispatch.contextManifestDigest ||
		candidateView.context?.contextRef === undefined ||
		candidateView.readOnlyMount?.mountDigest === undefined
	) {
		throw new TypeError(
			"V2 review projection candidate view must bind the immutable candidate and reviewer context through a read-only mount.",
		);
	}
	const candidateViewRef = requireNonEmpty(
		reviewer.candidateViewRef,
		"candidateViewRef",
	);
	if (candidateViewRef !== candidateView.candidateViewRef) {
		throw new TypeError(
			"V2 review projection candidateViewRef must match the native-bound candidate view.",
		);
	}
	const candidateViewDigest = canonicalCandidateViewV1Digest({
		candidateRef: candidateView.candidateRef,
		candidateDigest: candidateView.candidateDigest,
		candidateCommitSha: candidateView.candidateCommitSha,
		treeDigest: candidateView.candidateTreeDigest,
		reviewerContextManifestDigest: candidateView.context.contextManifestDigest,
		reviewerSandboxProfileDigest: reviewerDispatch.sandboxProfileDigest,
		mountPathDigest: candidateView.readOnlyMount.mountDigest,
		readOnly: true,
		networkDisabled: true,
	});
	if (candidateView.candidateViewDigest !== candidateViewDigest) {
		throw new TypeError(
			"V2 review projection candidate view digest does not bind its exact read-only, no-network view.",
		);
	}

	const durableRequest = reviewer.actionRequest;
	if (!durableRequest || typeof durableRequest !== "object") {
		throw new TypeError(
			"V2 review projection requires a durable reviewer action request.",
		);
	}
	const actionRequest = parseActionRequestedV2(durableRequest.actionRequest);
	const actionRequestDigest = canonicalActionRequestedV2Digest(actionRequest);
	if (
		durableRequest.actionRequestDigest !== actionRequestDigest ||
		requireNonEmpty(durableRequest.actionRequestRef, "actionRequestRef") ===
			"" ||
		actionRequest.actionKind !== "model"
	) {
		throw new TypeError(
			"V2 review projection requires one durable model action request with its canonical digest.",
		);
	}
	assertReviewActionRequestBindsDispatch(actionRequest, reviewerDispatch);

	const durableReceipt = reviewer.actionReceipt;
	if (!durableReceipt || typeof durableReceipt !== "object") {
		throw new TypeError(
			"V2 review projection requires a durable reviewer action receipt.",
		);
	}
	const actionReceipt = parseActionReceiptRecordedV2(durableReceipt.receipt);
	const actionReceiptDigest =
		canonicalActionReceiptRecordedV2Digest(actionReceipt);
	if (
		durableReceipt.actionReceiptDigest !== actionReceiptDigest ||
		actionReceipt.actionRequestDigest !== actionRequestDigest ||
		actionReceipt.actionId !== actionRequest.actionId ||
		actionReceipt.idempotencyKey !== actionRequest.idempotencyKey ||
		actionReceipt.outcome !== "succeeded" ||
		!actionReceipt.authorizationRef ||
		actionReceipt.authorizationRef.trim().length === 0
	) {
		throw new TypeError(
			"V2 review projection requires a succeeded, authorized receipt for its exact model request.",
		);
	}
	assertReviewActionReceiptBindsDispatch(actionReceipt, reviewerDispatch);

	const receiptSet = parseActionReceiptSetRecordedV1(reviewer.actionReceiptSet);
	if (
		receiptSet.runId !== reviewerDispatch.runId ||
		receiptSet.workflowId !== reviewerDispatch.workflowId ||
		receiptSet.unitId !== reviewerDispatch.unitId ||
		receiptSet.attempt !== reviewerDispatch.attempt ||
		receiptSet.provenanceRef !== reviewerDispatch.provenanceRef ||
		receiptSet.dispatchEnvelopeDigest !== reviewerDispatch.envelopeDigest ||
		!receiptSet.receipts.some(
			(entry) =>
				entry.actionId === actionRequest.actionId &&
				entry.actionReceiptRef === actionReceipt.actionReceiptRef &&
				entry.actionReceiptDigest === actionReceiptDigest,
		)
	) {
		throw new TypeError(
			"V2 review projection receipt set must seal the exact succeeded reviewer model receipt.",
		);
	}

	const verdict = parseReviewVerdictV1(input.verdict);
	if (
		verdict.candidateDigest !== candidate.candidateDigest ||
		verdict.reviewerManifestDigest !== reviewerDispatch.workerManifestDigest
	) {
		throw new TypeError(
			"V2 review projection verdict must bind the candidate and signed reviewer manifest.",
		);
	}
	const reviewOutputDigest = canonicalReviewVerdictOutputV1Digest({
		candidateDigest: candidate.candidateDigest,
		candidateCommitSha: candidate.candidateCommitSha,
		decision: verdict.decision,
		findings: verdict.findings,
		confidence: verdict.confidence,
		candidateViewDigest,
	});
	const reviewOutputRef = `cas:${reviewOutputDigest}`;
	if (
		actionReceipt.resultDigest !== reviewOutputDigest ||
		actionReceipt.resultRef !== reviewOutputRef
	) {
		throw new TypeError(
			"V2 review projection receipt must bind the exact CAS-backed closed review output.",
		);
	}

	return parseReviewVerdictRecordedV2({
		runId: candidate.runId,
		workflowId: candidate.workflowId,
		unitId: candidate.unitId,
		attempt: candidate.attempt,
		provenanceRef: candidate.provenanceRef,
		candidateDigest: candidate.candidateDigest,
		candidateCommitSha: candidate.candidateCommitSha,
		reviewRef: requireNonEmpty(input.reviewRef, "reviewRef"),
		reviewVerdictActionId: actionRequest.actionId,
		reviewActionRequestDigest: actionRequestDigest,
		reviewActionReceiptRef: actionReceipt.actionReceiptRef,
		reviewActionReceiptDigest: actionReceiptDigest,
		reviewOutputRef,
		reviewOutputDigest,
		decision: verdict.decision,
		findings: verdict.findings,
		confidence: verdict.confidence,
		acceptanceRef: requireNonEmpty(
			acceptance.acceptance_ref,
			"acceptance.acceptance_ref",
		),
		acceptanceDigest: canonicalDigest(
			acceptance.acceptance_digest,
			"acceptance.acceptance_digest",
		),
		acceptanceContractDigest: canonicalDigest(
			acceptance.acceptance_contract_digest,
			"acceptance.acceptance_contract_digest",
		),
		candidateEnvelopeDigest: candidate.envelopeDigest,
		reviewerWorkflowId: reviewerDispatch.workflowId,
		reviewerDispatchEnvelopeDigest: reviewerDispatch.envelopeDigest,
		reviewerUnitId: reviewerDispatch.unitId,
		reviewerAttempt: reviewerDispatch.attempt,
		reviewerExecutionRole: reviewerDispatch.executionRole,
		reviewActionReceiptSetRef: receiptSet.actionReceiptSetRef,
		reviewActionReceiptSetDigest: receiptSet.actionReceiptSetDigest,
		candidateView: {
			candidateRef: candidateView.candidateRef,
			candidateDigest: candidateView.candidateDigest,
			candidateCommitSha: candidateView.candidateCommitSha,
			treeDigest: candidateView.candidateTreeDigest,
			reviewerContextManifestDigest:
				candidateView.context.contextManifestDigest,
			reviewerSandboxProfileDigest: reviewerDispatch.sandboxProfileDigest,
			mountPathDigest: candidateView.readOnlyMount.mountDigest,
			readOnly: true,
			networkDisabled: true,
		},
		candidateViewRef,
		candidateViewDigest,
		reviewerManifestDigest: reviewerDispatch.workerManifestDigest,
		reviewerAuthority: requireNonEmpty(
			reviewer.reviewerAuthority,
			"reviewerAuthority",
		),
		reviewedAt: requireRfc3339Utc(input.reviewedAt, "reviewedAt"),
	});
}

function assertSealedV3Dispatch(
	dispatch: GovernedDispatchLineageV3,
	label: string,
	...roles: readonly GovernedDispatchLineageV3["executionRole"][]
): void {
	if (
		!dispatch ||
		dispatch.schemaVersion !== 3 ||
		dispatch.trustTier !== "governed" ||
		dispatch.commitMode !== "atomic" ||
		dispatch.actionEvidenceVersion !== "sealed_v3" ||
		!roles.includes(dispatch.executionRole)
	) {
		throw new TypeError(
			`${label} must be a governed atomic sealed_v3 dispatch with an allowed role.`,
		);
	}
}

function assertReviewActionRequestBindsDispatch(
	request: KernelActionRequestedV2,
	dispatch: GovernedDispatchLineageV3,
): void {
	if (
		request.runId !== dispatch.runId ||
		request.workflowId !== dispatch.workflowId ||
		request.unitId !== dispatch.unitId ||
		request.attempt !== dispatch.attempt ||
		request.provenanceRef !== dispatch.provenanceRef ||
		request.dispatchEnvelopeDigest !== dispatch.envelopeDigest ||
		request.repositoryBindingDigest !== dispatch.repositoryBindingDigest ||
		request.ledgerAuthorityRealmDigest !==
			dispatch.ledgerAuthorityRealmDigest ||
		request.governedPacketDigest !== dispatch.governedPacketDigest ||
		request.capabilityBundleDigest !== dispatch.capabilityBundleDigest ||
		request.policyDigest !== dispatch.policyDigest ||
		request.contextManifestDigest !== dispatch.contextManifestDigest ||
		request.workerManifestDigest !== dispatch.workerManifestDigest ||
		request.sandboxProfileDigest !== dispatch.sandboxProfileDigest ||
		request.authorityActor !== dispatch.authorityActor ||
		request.executionRole !== dispatch.executionRole
	) {
		throw new TypeError(
			"V2 review projection model request must exactly bind the signed reviewer dispatch.",
		);
	}
}

function assertReviewActionReceiptBindsDispatch(
	receipt: KernelActionReceiptRecordedV2,
	dispatch: GovernedDispatchLineageV3,
): void {
	if (
		receipt.runId !== dispatch.runId ||
		receipt.workflowId !== dispatch.workflowId ||
		receipt.unitId !== dispatch.unitId ||
		receipt.attempt !== dispatch.attempt ||
		receipt.provenanceRef !== dispatch.provenanceRef ||
		receipt.dispatchEnvelopeDigest !== dispatch.envelopeDigest ||
		receipt.capabilityBundleDigest !== dispatch.capabilityBundleDigest ||
		receipt.policyDigest !== dispatch.policyDigest ||
		receipt.contextManifestDigest !== dispatch.contextManifestDigest ||
		receipt.workerManifestDigest !== dispatch.workerManifestDigest ||
		receipt.sandboxProfileDigest !== dispatch.sandboxProfileDigest ||
		receipt.authorityActor !== dispatch.authorityActor ||
		receipt.executionRole !== dispatch.executionRole
	) {
		throw new TypeError(
			"V2 review projection model receipt must exactly bind the signed reviewer dispatch.",
		);
	}
}

type ValidatedPromotionCandidateEvidence =
	| {
			readonly schemaVersion: 1;
			readonly actionReceiptDigest: string;
	  }
	| {
			readonly schemaVersion: 2;
			readonly actionEvidenceVersion: ActionEvidenceVersionV1;
			readonly candidateCreatedRef: string;
			readonly actionReceiptSetRef: string;
			readonly actionReceiptSetDigest: string;
	  };

function validatePromotionCandidateEvidence(
	candidate: CandidatePromotionIntentInput["candidate"],
): ValidatedPromotionCandidateEvidence {
	if (candidate.schemaVersion === 1) {
		if (
			candidate.actionEvidenceVersion !== undefined ||
			candidate.actionReceiptSetRef !== undefined ||
			candidate.actionReceiptSetDigest !== undefined ||
			candidate.candidateCreatedRef !== undefined
		) {
			throw new TypeError(
				"V1 candidate evidence cannot carry sealed V2 action-evidence fields.",
			);
		}
		return {
			schemaVersion: 1,
			actionReceiptDigest: canonicalDigest(
				candidate.actionReceiptDigest,
				"candidate.actionReceiptDigest",
			),
		};
	}
	if (candidate.schemaVersion === 2) {
		if (candidate.actionReceiptDigest !== undefined) {
			throw new TypeError(
				"V2 candidate evidence must not carry the legacy V1 action-receipt digest.",
			);
		}
		if (
			candidate.actionEvidenceVersion !== "sealed-v2" &&
			candidate.actionEvidenceVersion !== "sealed_v3"
		) {
			throw new TypeError(
				"V2 candidate evidence requires actionEvidenceVersion 'sealed-v2' or 'sealed_v3'.",
			);
		}
		return {
			schemaVersion: 2,
			actionEvidenceVersion: candidate.actionEvidenceVersion,
			candidateCreatedRef: requireNonEmpty(
				candidate.candidateCreatedRef,
				"candidate.candidateCreatedRef",
			),
			actionReceiptSetRef: requireNonEmpty(
				candidate.actionReceiptSetRef,
				"candidate.actionReceiptSetRef",
			),
			actionReceiptSetDigest: canonicalDigest(
				candidate.actionReceiptSetDigest,
				"candidate.actionReceiptSetDigest",
			),
		};
	}
	throw new TypeError("candidate.schemaVersion must be 1 or 2.");
}

function validatePromotionIntent(input: CandidatePromotionIntentInput): {
	readonly decision: PromotionDecisionV1;
	readonly candidateDigest: string;
	readonly candidateCommitSha: string;
	readonly acceptanceContractDigest: string;
	readonly candidateEvidence: ValidatedPromotionCandidateEvidence;
} {
	requireNonEmpty(input.runId, "runId");
	requireRfc3339Utc(input.preparedAt, "preparedAt");
	const identity = candidateIdentity(input.candidate);
	const decision = parseSignablePromotionDecisionV1(input.decision);
	if (!decision.targetRef) {
		throw new TypeError(
			"promotion decision must bind a canonical targetRef in governed mode.",
		);
	}
	if (decision.candidateDigest !== identity.candidateDigest) {
		throw new TypeError(
			"promotion decision must bind the exact immutable candidate digest.",
		);
	}
	if (
		canonicalGitObjectId(input.candidate.baseSha, "candidate.baseSha") !==
		decision.baseCommitSha
	) {
		throw new TypeError(
			"promotion decision baseCommitSha must equal the candidate base SHA.",
		);
	}
	if (
		canonicalDigest(
			input.candidate.envelopeDigest,
			"candidate.envelopeDigest",
		) !== decision.envelopeDigest
	) {
		throw new TypeError(
			"promotion decision envelopeDigest must equal the candidate envelope digest.",
		);
	}
	const candidateEvidence = validatePromotionCandidateEvidence(input.candidate);
	const candidateAcceptanceContractDigest = canonicalDigest(
		input.candidate.acceptanceContractDigest,
		"candidate.acceptanceContractDigest",
	);

	const acceptanceDigest = canonicalDigest(
		input.acceptance.candidateDigest,
		"acceptance.candidateDigest",
	);
	const acceptanceCommitSha = canonicalGitObjectId(
		input.acceptance.candidateCommitSha,
		"acceptance.candidateCommitSha",
	);
	const acceptanceContractDigest = canonicalDigest(
		input.acceptance.acceptanceContractDigest,
		"acceptance.acceptanceContractDigest",
	);
	if (acceptanceContractDigest !== candidateAcceptanceContractDigest) {
		throw new TypeError(
			"promotion acceptance contract does not match the signed candidate envelope contract.",
		);
	}
	if (
		acceptanceDigest !== identity.candidateDigest ||
		acceptanceCommitSha !== identity.candidateCommitSha ||
		input.acceptance.acceptanceRef !== decision.acceptanceRef
	) {
		throw new TypeError(
			"promotion acceptance evidence must bind the exact candidate and decision reference.",
		);
	}
	if (
		decision.decision === "promote" &&
		input.acceptance.outcome !== "passed"
	) {
		throw new TypeError("promotion requires passed deterministic acceptance.");
	}

	const reviewDigest = canonicalDigest(
		input.review.candidateDigest,
		"review.candidateDigest",
	);
	const reviewCommitSha = canonicalGitObjectId(
		input.review.candidateCommitSha,
		"review.candidateCommitSha",
	);
	const verdict = parseReviewVerdictV1(input.review.verdict);
	if (
		reviewDigest !== identity.candidateDigest ||
		reviewCommitSha !== identity.candidateCommitSha ||
		verdict.candidateDigest !== identity.candidateDigest ||
		!decision.reviewRefs.includes(input.review.reviewRef)
	) {
		throw new TypeError(
			"promotion review evidence must bind the exact candidate and decision reference.",
		);
	}
	if (decision.decision === "promote" && verdict.decision !== "approve") {
		throw new TypeError(
			"promotion requires an approving semantic review verdict.",
		);
	}

	return {
		decision,
		candidateDigest: identity.candidateDigest,
		candidateCommitSha: identity.candidateCommitSha,
		acceptanceContractDigest,
		candidateEvidence,
	};
}

function toVerifiedPromotionIntent(
	input: CandidatePromotionIntentInput,
	validated: ReturnType<typeof validatePromotionIntent>,
): VerifiedPromotionIntent {
	const candidate: VerifiedPromotionIntent["candidate"] =
		validated.candidateEvidence.schemaVersion === 1
			? Object.freeze({
					schemaVersion: 1 as const,
					candidateDigest: validated.candidateDigest,
					candidateCommitSha: validated.candidateCommitSha,
					baseCommitSha: validated.decision.baseCommitSha,
					envelopeDigest: validated.decision.envelopeDigest,
					acceptanceContractDigest: validated.acceptanceContractDigest,
					actionReceiptDigest: validated.candidateEvidence.actionReceiptDigest,
				})
			: Object.freeze({
					schemaVersion: 2 as const,
					candidateDigest: validated.candidateDigest,
					candidateCommitSha: validated.candidateCommitSha,
					baseCommitSha: validated.decision.baseCommitSha,
					envelopeDigest: validated.decision.envelopeDigest,
					acceptanceContractDigest: validated.acceptanceContractDigest,
					actionEvidenceVersion:
						validated.candidateEvidence.actionEvidenceVersion,
					candidateCreatedRef: validated.candidateEvidence.candidateCreatedRef,
					actionReceiptSetRef: validated.candidateEvidence.actionReceiptSetRef,
					actionReceiptSetDigest:
						validated.candidateEvidence.actionReceiptSetDigest,
				});
	return Object.freeze({
		runId: requireNonEmpty(input.runId, "runId"),
		candidate,
		acceptance: Object.freeze({
			candidateDigest: validated.candidateDigest,
			candidateCommitSha: validated.candidateCommitSha,
			acceptanceContractDigest: validated.acceptanceContractDigest,
			acceptanceRef: validated.decision.acceptanceRef,
			outcome: input.acceptance.outcome,
		}),
		review: Object.freeze({
			candidateDigest: validated.candidateDigest,
			candidateCommitSha: validated.candidateCommitSha,
			reviewRef: input.review.reviewRef,
			verdict: parseReviewVerdictV1(input.review.verdict),
		}),
		decision: validated.decision,
	});
}

function strictPromotionDecisionBindingFromDecision(
	decision: PromotionDecisionV1,
	field: string,
): StrictPromotionDecisionBinding {
	return Object.freeze({
		targetRef: canonicalTargetRef(decision.targetRef, `${field}.targetRef`),
		baseCommitSha: canonicalGitObjectId(
			decision.baseCommitSha,
			`${field}.baseCommitSha`,
		),
	});
}

function strictPromotionDecisionBindingFromPayload(
	payload: PromotionDecisionRecordedV1,
	candidateDigest: string,
	idempotencyKey: string,
	field: string,
): StrictPromotionDecisionBinding | undefined {
	if (payload.target_ref === undefined || payload.target_ref === null) {
		return undefined;
	}
	if (
		canonicalDigest(payload.candidate_digest, `${field}.candidate_digest`) !==
			candidateDigest ||
		requireNonEmpty(payload.idempotency_key, `${field}.idempotency_key`) !==
			idempotencyKey
	) {
		throw new TypeError(
			"recovered promotion decision does not match the requested candidate/idempotency key.",
		);
	}
	return Object.freeze({
		targetRef: canonicalTargetRef(payload.target_ref, `${field}.target_ref`),
		baseCommitSha: canonicalGitObjectId(
			payload.base_commit_sha,
			`${field}.base_commit_sha`,
		),
	});
}

function verifiedPromotionResultFromInput(
	input: RecordCandidatePromotionResultInput,
	decision: StrictPromotionDecisionBinding,
): VerifiedPromotionResult | undefined {
	if (input.outcome === "rejected") return undefined;
	if (
		input.outcome !== "promoted" &&
		input.outcome !== "reconciliation_required"
	) {
		throw new TypeError(
			"outcome must be 'promoted', 'reconciliation_required', or 'rejected'.",
		);
	}
	const promotionGitBinding = requirePromotionGitBindingForOutcome(
		canonicalPromotionGitBinding(
			input.promotionGitBinding,
			"promotionGitBinding",
		),
		canonicalGitObjectId(input.mergedHeadSha, "mergedHeadSha"),
		input.outcome,
		"promotionGitBinding",
	);
	if (
		promotionGitBinding.targetRef !== decision.targetRef ||
		promotionGitBinding.targetHeadBeforeSha !== decision.baseCommitSha
	) {
		throw new TypeError(
			"promotion result Git binding does not match the signed target/base decision.",
		);
	}
	const frozenBinding = Object.freeze({
		...promotionGitBinding,
		mergeParentShas: Object.freeze([
			...promotionGitBinding.mergeParentShas,
		]) as PromotionGitBindingV1["mergeParentShas"],
	});
	return Object.freeze({
		runId: requireNonEmpty(input.runId, "runId"),
		candidate: Object.freeze({
			candidateDigest: canonicalDigest(
				input.candidateDigest,
				"candidateDigest",
			),
			candidateRef: candidateRefForPromotionReceipt(
				frozenBinding.promotionReceiptRef,
			),
			candidateCommitSha: frozenBinding.candidateCommitSha,
			baseCommitSha: frozenBinding.targetHeadBeforeSha,
		}),
		idempotencyKey: requireNonEmpty(input.idempotencyKey, "idempotencyKey"),
		promotionDecisionRef: requireNonEmpty(
			input.promotionDecisionRef,
			"promotionDecisionRef",
		),
		decision: Object.freeze({ ...decision }),
		outcome: input.outcome,
		mergedHeadSha: frozenBinding.mergedHeadSha,
		promotionGitBinding: frozenBinding,
	});
}

function promotionResultFingerprintFromInput(
	input: RecordCandidatePromotionResultInput,
): string {
	if (
		input.outcome !== "promoted" &&
		input.outcome !== "reconciliation_required" &&
		input.outcome !== "rejected"
	) {
		throw new TypeError(
			"outcome must be 'promoted', 'reconciliation_required', or 'rejected'.",
		);
	}
	if (input.outcome === "rejected" && input.mergedHeadSha !== undefined) {
		throw new TypeError(
			"rejected promotion result must not contain a mergedHeadSha.",
		);
	}
	if (input.outcome === "rejected" && input.promotionGitBinding !== undefined) {
		throw new TypeError(
			"rejected promotion result must not contain Git-binding evidence.",
		);
	}
	const hasPromotionEffect = input.outcome !== "rejected";
	const mergedHeadSha = hasPromotionEffect
		? canonicalGitObjectId(input.mergedHeadSha, "mergedHeadSha")
		: null;
	const promotionGitBinding = hasPromotionEffect
		? requirePromotionGitBindingForOutcome(
				canonicalPromotionGitBinding(
					input.promotionGitBinding,
					"promotionGitBinding",
				),
				mergedHeadSha as string,
				input.outcome,
				"promotionGitBinding",
			)
		: null;
	return digest({
		runId: requireNonEmpty(input.runId, "runId"),
		candidateDigest: canonicalDigest(input.candidateDigest, "candidateDigest"),
		idempotencyKey: requireNonEmpty(input.idempotencyKey, "idempotencyKey"),
		promotionDecisionRef: requireNonEmpty(
			input.promotionDecisionRef,
			"promotionDecisionRef",
		),
		outcome: input.outcome,
		mergedHeadSha,
		promotionGitBinding,
	});
}

function promotionResultFingerprintFromPayload(
	payload: PromotionResultRecordedV1,
	runId: string,
	legacyDecision: boolean,
): string {
	const outcome =
		payload.outcome === PromotionResultOutcomeV1.Promoted
			? "promoted"
			: payload.outcome === PromotionResultOutcomeV1.ReconciliationRequired
				? "reconciliation_required"
				: payload.outcome === PromotionResultOutcomeV1.Rejected
					? "rejected"
					: (() => {
							throw new TypeError(
								"recovered promotion result has an unsupported outcome.",
							);
						})();
	const mergedHeadSha =
		payload.merged_head_sha === undefined || payload.merged_head_sha === null
			? null
			: canonicalGitObjectId(
					payload.merged_head_sha,
					"recovered promotion result merged_head_sha",
				);
	const hasPromotionEffect = outcome !== "rejected";
	const strictPromotionResult =
		outcome === "reconciliation_required" || !legacyDecision;
	if (hasPromotionEffect && mergedHeadSha === null && strictPromotionResult) {
		throw new TypeError(
			"recovered promotion result is missing merged_head_sha.",
		);
	}
	if (outcome === "rejected" && mergedHeadSha !== null) {
		throw new TypeError(
			"recovered rejected result must not contain merged_head_sha.",
		);
	}
	const rawPromotionGitBinding =
		payload.promotion_git_binding === undefined ||
		payload.promotion_git_binding === null
			? null
			: payload.promotion_git_binding;
	const promotionGitBinding: PromotionGitBindingFingerprint | null = (() => {
		if (rawPromotionGitBinding === null) return null;
		const extendedValues = [
			rawPromotionGitBinding.target_head_after_sha,
			rawPromotionGitBinding.merged_head_sha,
			rawPromotionGitBinding.merge_parent_shas,
			rawPromotionGitBinding.merged_tree_sha,
			rawPromotionGitBinding.promotion_receipt_ref,
			rawPromotionGitBinding.worktree_sync_state,
		];
		const hasAnyExtendedEvidence = extendedValues.some(
			(value) => value !== undefined && value !== null,
		);
		const hasEveryExtendedEvidence = extendedValues.every(
			(value) => value !== undefined && value !== null,
		);
		if (!hasAnyExtendedEvidence) {
			if (!legacyDecision) {
				throw new TypeError(
					"recovered strict promotion result is missing post-CAS Git-binding evidence.",
				);
			}
			return {
				targetRef: canonicalTargetRef(
					rawPromotionGitBinding.target_ref,
					"recovered legacy promotion result promotion_git_binding.target_ref",
				),
				targetHeadBeforeSha: canonicalGitObjectId(
					rawPromotionGitBinding.target_head_before_sha,
					"recovered legacy promotion result promotion_git_binding.target_head_before_sha",
				),
				candidateCommitSha: canonicalGitObjectId(
					rawPromotionGitBinding.candidate_commit_sha,
					"recovered legacy promotion result promotion_git_binding.candidate_commit_sha",
				),
				mergedTreeDigest: canonicalDigest(
					rawPromotionGitBinding.merged_tree_digest,
					"recovered legacy promotion result promotion_git_binding.merged_tree_digest",
				),
			};
		}
		if (!hasEveryExtendedEvidence) {
			throw new TypeError(
				"recovered promotion result has a partial post-CAS Git-binding record.",
			);
		}
		return canonicalPromotionGitBinding(
			{
				targetRef: rawPromotionGitBinding.target_ref,
				targetHeadBeforeSha: rawPromotionGitBinding.target_head_before_sha,
				candidateCommitSha: rawPromotionGitBinding.candidate_commit_sha,
				targetHeadAfterSha:
					rawPromotionGitBinding.target_head_after_sha as string,
				mergedHeadSha: rawPromotionGitBinding.merged_head_sha as string,
				mergeParentShas: [
					rawPromotionGitBinding.merge_parent_shas?.[0] as string,
					rawPromotionGitBinding.merge_parent_shas?.[1] as string,
				],
				mergedTreeSha: rawPromotionGitBinding.merged_tree_sha as string,
				mergedTreeDigest: rawPromotionGitBinding.merged_tree_digest,
				promotionReceiptRef:
					rawPromotionGitBinding.promotion_receipt_ref as string,
				worktreeSyncState:
					rawPromotionGitBinding.worktree_sync_state as PromotionGitBindingV1["worktreeSyncState"],
			},
			"recovered promotion result promotion_git_binding",
		);
	})();
	if (
		hasPromotionEffect &&
		promotionGitBinding === null &&
		strictPromotionResult
	) {
		throw new TypeError(
			"recovered promotion result is missing promotion_git_binding.",
		);
	}
	if (outcome === "rejected" && promotionGitBinding !== null) {
		throw new TypeError(
			"recovered rejected result must not contain promotion_git_binding.",
		);
	}
	const boundPromotionGitBinding =
		hasPromotionEffect &&
		promotionGitBinding !== null &&
		mergedHeadSha !== null &&
		"mergedHeadSha" in promotionGitBinding
			? requirePromotionGitBindingForOutcome(
					promotionGitBinding,
					mergedHeadSha,
					outcome,
					"recovered promotion result promotion_git_binding",
				)
			: promotionGitBinding;
	return digest({
		runId: requireNonEmpty(runId, "runId"),
		candidateDigest: canonicalDigest(
			payload.candidate_digest,
			"recovered promotion result candidate_digest",
		),
		idempotencyKey: requireNonEmpty(
			payload.idempotency_key,
			"recovered promotion result idempotency_key",
		),
		promotionDecisionRef: requireNonEmpty(
			payload.promotion_decision_ref,
			"recovered promotion result promotion_decision_ref",
		),
		outcome,
		mergedHeadSha,
		promotionGitBinding: boundPromotionGitBinding,
	});
}

/** Converts a fully bound promotion intent to its write-ahead wire payload. */
export function toPromotionDecisionWirePayload(
	input: CandidatePromotionIntentInput,
): PromotionDecisionRecordedV1 {
	const { decision } = validatePromotionIntent(input);
	return {
		candidate_digest: decision.candidateDigest,
		base_commit_sha: decision.baseCommitSha,
		target_ref: canonicalTargetRef(
			decision.targetRef,
			"promotion decision targetRef",
		),
		envelope_digest: decision.envelopeDigest,
		acceptance_ref: decision.acceptanceRef,
		review_refs: [...decision.reviewRefs],
		...(decision.promotionApprovalRequestRef === undefined
			? {}
			: {
					promotion_approval_request_ref: decision.promotionApprovalRequestRef,
				}),
		decision: toPromotionDecisionKind(decision.decision),
		authority: decision.authority,
		decided_by: decision.decidedBy,
		decided_at: decision.decidedAt,
		idempotency_key: decision.idempotencyKey,
	};
}

function toPromotionResultWirePayload(
	input: RecordCandidatePromotionResultInput,
	completedAt: string,
): PromotionResultRecordedV1 {
	requireNonEmpty(input.runId, "runId");
	const candidateDigest = canonicalDigest(
		input.candidateDigest,
		"candidateDigest",
	);
	const idempotencyKey = requireNonEmpty(
		input.idempotencyKey,
		"idempotencyKey",
	);
	const reference = requireNonEmpty(
		input.promotionDecisionRef,
		"promotionDecisionRef",
	);
	const timestamp = requireRfc3339Utc(completedAt, "completedAt");
	if (
		input.outcome !== "promoted" &&
		input.outcome !== "reconciliation_required" &&
		input.outcome !== "rejected"
	) {
		throw new TypeError(
			"outcome must be 'promoted', 'reconciliation_required', or 'rejected'.",
		);
	}
	if (input.outcome !== "rejected") {
		const mergedHeadSha = canonicalGitObjectId(
			input.mergedHeadSha,
			"mergedHeadSha",
		);
		const promotionGitBinding = requirePromotionGitBindingForOutcome(
			canonicalPromotionGitBinding(
				input.promotionGitBinding,
				"promotionGitBinding",
			),
			mergedHeadSha,
			input.outcome,
			"promotionGitBinding",
		);
		return {
			candidate_digest: candidateDigest,
			idempotency_key: idempotencyKey,
			promotion_decision_ref: reference,
			outcome:
				input.outcome === "promoted"
					? PromotionResultOutcomeV1.Promoted
					: PromotionResultOutcomeV1.ReconciliationRequired,
			merged_head_sha: mergedHeadSha,
			promotion_git_binding: {
				target_ref: promotionGitBinding.targetRef,
				target_head_before_sha: promotionGitBinding.targetHeadBeforeSha,
				target_head_after_sha: promotionGitBinding.targetHeadAfterSha,
				merged_head_sha: promotionGitBinding.mergedHeadSha,
				candidate_commit_sha: promotionGitBinding.candidateCommitSha,
				merge_parent_shas: [...promotionGitBinding.mergeParentShas],
				merged_tree_sha: promotionGitBinding.mergedTreeSha,
				merged_tree_digest: promotionGitBinding.mergedTreeDigest,
				promotion_receipt_ref: promotionGitBinding.promotionReceiptRef,
				worktree_sync_state: toPromotionWorktreeSyncStateWire(
					promotionGitBinding.worktreeSyncState,
				),
			},
			completed_at: timestamp,
		};
	}
	if (input.mergedHeadSha !== undefined) {
		throw new TypeError(
			"rejected promotion result must not contain a mergedHeadSha.",
		);
	}
	if (input.promotionGitBinding !== undefined) {
		throw new TypeError(
			"rejected promotion result must not contain Git-binding evidence.",
		);
	}
	return {
		candidate_digest: candidateDigest,
		idempotency_key: idempotencyKey,
		promotion_decision_ref: reference,
		outcome: PromotionResultOutcomeV1.Rejected,
		completed_at: timestamp,
	};
}

/**
 * Concrete kernel evidence port over an already-initialized signed tape
 * emitter. The emitter is intentionally mandatory: governed evidence has no
 * nullable/no-op path.
 */
export function createCandidateEvidencePort(
	emitter: TapeEmitter,
): CandidateEvidencePort {
	return {
		async recordCandidateAcceptance(
			input: CandidateAcceptanceEvidenceInput,
		): Promise<CandidateAcceptanceRecord> {
			const acceptanceRef = newEventId();
			const payload = toCandidateAcceptanceWirePayload(input, acceptanceRef);
			emitter.emit(
				"candidate_acceptance_recorded",
				{ CandidateAcceptanceRecordedV1: payload },
				{ id: acceptanceRef },
			);
			await flushWriteAhead(emitter);
			return {
				candidateDigest: payload.candidate_digest,
				candidateCommitSha: payload.candidate_commit_sha,
				acceptanceContractDigest: payload.acceptance_contract_digest,
				acceptanceRef,
				outcome: input.outcome,
			};
		},

		async recordCandidateReview(
			input: CandidateReviewEvidenceInput,
		): Promise<CandidateReviewRecord> {
			const reviewRef = newEventId();
			const payload = toReviewVerdictWirePayload(input, reviewRef);
			emitter.emit(
				"review_verdict_recorded",
				{ ReviewVerdictRecordedV1: payload },
				{ id: reviewRef },
			);
			await flushWriteAhead(emitter);
			return {
				candidateDigest: payload.candidate_digest,
				candidateCommitSha: payload.candidate_commit_sha,
				reviewRef,
				verdict: parseReviewVerdictV1(input.verdict),
			};
		},
	};
}

/**
 * Concrete promotion port over a mandatory signed tape emitter. It serializes
 * decision/result calls so concurrent callers cannot race the local decision
 * reference. The result carries the exact decision ref returned by the
 * kernel-facing decision call; for restart-safe deduplication, pass
 * `references` backed by a reducer/tape projection.
 */
export function createCandidatePromotionDecisionPort(
	emitter: TapeEmitter,
	options: CandidatePromotionLedgerPortOptions,
): CandidatePromotionDecisionPort {
	if (!options?.references) {
		throw new TypeError(
			"createCandidatePromotionDecisionPort requires a signed promotion evidence/authority resolver.",
		);
	}
	const decisions = new Map<string, DecisionReference>();
	const results = new Map<string, string>();
	const now = options.now ?? (() => new Date().toISOString());
	const references = options.references;
	let tail: Promise<void> = Promise.resolve();

	function serialized<T>(operation: () => Promise<T>): Promise<T> {
		const next = tail.then(operation, operation);
		tail = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	return {
		async recordPromotionDecision({ intent }): Promise<string> {
			return serialized(async () => {
				const validated = validatePromotionIntent(intent);
				const strictBinding = strictPromotionDecisionBindingFromDecision(
					validated.decision,
					"promotion decision",
				);
				await references.verifyPromotionIntent(
					toVerifiedPromotionIntent(intent, validated),
				);
				const key = candidateKey(
					intent.runId,
					validated.candidateDigest,
					validated.decision.idempotencyKey,
				);
				const payload = toPromotionDecisionWirePayload(intent);
				const fingerprint = digest(payload);
				const existing = decisions.get(key);
				if (existing) {
					if (existing.fingerprint !== fingerprint) {
						throw new TypeError(
							"conflicting promotion decision for the same candidate and idempotency key.",
						);
					}
					return existing.reference;
				}

				const recoveredDecision = await references.findDecisionReference({
					runId: intent.runId,
					candidateDigest: validated.candidateDigest,
					idempotencyKey: validated.decision.idempotencyKey,
				});
				if (recoveredDecision) {
					const reference = requireNonEmpty(
						recoveredDecision.reference,
						"recovered promotionDecisionRef",
					);
					if (digest(recoveredDecision.payload) !== fingerprint) {
						throw new TypeError(
							"recovered promotion decision conflicts with the candidate-bound signed intent.",
						);
					}
					decisions.set(key, {
						reference,
						fingerprint,
						decision: requirePromotionDecisionKind(
							recoveredDecision.payload.decision,
							"recovered promotion decision decision",
						),
						strictBinding: strictPromotionDecisionBindingFromPayload(
							recoveredDecision.payload,
							validated.candidateDigest,
							validated.decision.idempotencyKey,
							"recovered promotion decision",
						),
					});
					return reference;
				}

				const decisionRef = newEventId();
				emitter.emit(
					"promotion_decision_recorded",
					{ PromotionDecisionRecordedV1: payload },
					{ id: decisionRef },
				);
				await flushWriteAhead(emitter);
				decisions.set(key, {
					reference: decisionRef,
					fingerprint,
					decision: toPromotionDecisionKind(validated.decision.decision),
					strictBinding,
				});
				return decisionRef;
			});
		},

		async recordPromotionResult(
			input: RecordCandidatePromotionResultInput,
		): Promise<void> {
			return serialized(async () => {
				const runId = requireNonEmpty(input.runId, "runId");
				const candidateDigest = canonicalDigest(
					input.candidateDigest,
					"candidateDigest",
				);
				const idempotencyKey = requireNonEmpty(
					input.idempotencyKey,
					"idempotencyKey",
				);
				const promotionDecisionRef = requireNonEmpty(
					input.promotionDecisionRef,
					"promotionDecisionRef",
				);
				const key = candidateKey(runId, candidateDigest, idempotencyKey);
				const localDecision = decisions.get(key);
				let knownDecisionRef = localDecision?.reference;
				let knownDecisionKind = localDecision?.decision;
				let strictDecisionBinding = localDecision?.strictBinding;
				let recoveredDecisionIsLegacy = false;
				if (!knownDecisionRef) {
					const recoveredDecision = await references.findDecisionReference({
						runId,
						candidateDigest,
						idempotencyKey,
					});
					if (recoveredDecision) {
						const recoveredPayload = recoveredDecision.payload;
						if (
							canonicalDigest(
								recoveredPayload.candidate_digest,
								"recovered promotion decision candidate_digest",
							) !== candidateDigest ||
							requireNonEmpty(
								recoveredPayload.idempotency_key,
								"recovered promotion decision idempotency_key",
							) !== idempotencyKey
						) {
							throw new TypeError(
								"recovered promotion decision does not match the requested candidate/idempotency key.",
							);
						}
						knownDecisionRef = requireNonEmpty(
							recoveredDecision.reference,
							"recovered promotionDecisionRef",
						);
						knownDecisionKind = requirePromotionDecisionKind(
							recoveredPayload.decision,
							"recovered promotion decision decision",
						);
						strictDecisionBinding = strictPromotionDecisionBindingFromPayload(
							recoveredPayload,
							candidateDigest,
							idempotencyKey,
							"recovered promotion decision",
						);
						recoveredDecisionIsLegacy = strictDecisionBinding === undefined;
					}
				}
				if (!knownDecisionRef) {
					throw new Error(
						"promotion result requires a durably recorded promotion decision reference; no reference is available for this candidate/idempotency key.",
					);
				}
				if (knownDecisionRef !== promotionDecisionRef) {
					throw new TypeError(
						"promotion result promotionDecisionRef does not match the recorded decision reference.",
					);
				}
				if (knownDecisionKind === undefined) {
					throw new Error(
						"promotion result requires a recorded promotion decision kind.",
					);
				}
				if (
					knownDecisionKind === PromotionDecisionKindV1.Reject &&
					input.outcome !== "rejected"
				) {
					throw new TypeError(
						"A rejected promotion decision cannot record a merge-producing result.",
					);
				}
				if (recoveredDecisionIsLegacy && input.outcome !== "rejected") {
					throw new TypeError(
						"A recovered legacy promotion decision cannot create a merge-producing result.",
					);
				}
				const resultFingerprint = promotionResultFingerprintFromInput(input);
				if (strictDecisionBinding) {
					const verifiedResult = verifiedPromotionResultFromInput(
						input,
						strictDecisionBinding,
					);
					if (verifiedResult) {
						await references.verifyPromotionResult(verifiedResult);
					}
				} else if (input.outcome !== "rejected" && !recoveredDecisionIsLegacy) {
					throw new TypeError(
						"strict promotion result is missing the signed target/base decision binding.",
					);
				}
				const existingResult = results.get(key);
				if (existingResult) {
					if (existingResult !== resultFingerprint) {
						throw new TypeError(
							"conflicting promotion result for the same candidate and idempotency key.",
						);
					}
					return;
				}
				const recoveredResult = await references.findResultReference({
					runId,
					candidateDigest,
					idempotencyKey,
				});
				if (recoveredResult) {
					requireNonEmpty(
						recoveredResult.reference,
						"recovered promotionResultRef",
					);
					if (
						promotionResultFingerprintFromPayload(
							recoveredResult.payload,
							runId,
							recoveredDecisionIsLegacy,
						) !== resultFingerprint
					) {
						throw new TypeError(
							"recovered promotion result conflicts with the requested terminal outcome.",
						);
					}
					results.set(key, resultFingerprint);
					return;
				}

				const payload = toPromotionResultWirePayload(input, now());
				emitter.emit("promotion_result_recorded", {
					PromotionResultRecordedV1: payload,
				});
				await flushWriteAhead(emitter);
				results.set(key, resultFingerprint);
			});
		},
	};
}

const ACTION_RECEIPT_FINGERPRINT_REF = "ledger:action-receipt-fingerprint";
const ACTION_RECEIPT_SET_PREVIEW_REF = "ledger:action-receipt-set-preview";

interface RecordedGovernedActionRequest {
	readonly actionRequest: KernelActionRequestedV2;
	readonly actionRequestRef: string;
	readonly actionRequestDigest: string;
	readonly origin: "local" | "recovered";
}

interface RecordedGovernedActionReceipt {
	readonly receipt: KernelActionReceiptRecordedV2;
	readonly actionReceiptDigest: string;
	/** Stable across retries even though the durable receipt ref is generated once. */
	readonly fingerprint: string;
	readonly origin: "local" | "recovered";
}

interface RecordedGovernedActionReceiptSet {
	readonly receiptSet: KernelActionReceiptSetRecordedV1;
	/** Excludes event ref, digest, and seal timestamp so a retry is idempotent. */
	readonly fingerprint: string;
}

interface RecordedGovernedCandidate {
	readonly candidateCreatedRef: string;
	readonly fingerprint: string;
	readonly candidate: KernelCandidateCreatedV2;
}

interface RecordedGovernedCandidateCompletion {
	readonly candidateCompletionRef: string;
	readonly completion: KernelCandidateCompletionRecordedV1;
}

type ActionReceiptSetFields = Pick<
	KernelActionReceiptSetRecordedV1,
	| "runId"
	| "workflowId"
	| "unitId"
	| "attempt"
	| "provenanceRef"
	| "dispatchEnvelopeDigest"
	| "sealedAt"
>;

/** The exact immutable V3 dispatch whose action effects are being recovered. */
export interface GovernedActionDispatchScopeV1 {
	readonly runId: string;
	readonly workflowId: string;
	readonly unitId: string;
	readonly attempt: number;
	readonly provenanceRef: string;
	readonly dispatchEnvelopeDigest: string;
}

/**
 * Authoritative signed-tape projection used to rebuild a port after restart.
 * `undefined` from the resolver means the durable tape contains no action
 * evidence for this exact dispatch; it is not a best-effort cache miss.
 */
export interface GovernedActionEvidenceRecoverySnapshot {
	/**
	 * Policy binding reconstructed from the exact signed governed dispatch.
	 * A fresh action request must equal this value; it is never inferred from
	 * the action proposal itself.
	 */
	readonly dispatchPolicyDigest: string;
	readonly requests: readonly DurableActionRequestV2[];
	readonly receipts: readonly DurableActionReceiptV2[];
	readonly receiptSet?: KernelActionReceiptSetRecordedV1;
	readonly candidates: readonly {
		readonly candidate: KernelCandidateCreatedV2;
		readonly candidateCreatedRef: string;
	}[];
	/**
	 * Exact native activity records. A candidate completion may use only a
	 * succeeded activity result whose claim binds the candidate-create request.
	 * This is recovery evidence, not permission to issue a replacement action.
	 */
	readonly activityClaims?: readonly GovernedRecoveredActivityClaimV1[];
	/**
	 * Optional because older candidate snapshots remain readable. When present,
	 * it is revalidated against the candidate/action/activity/receipt lineage
	 * before it can satisfy a completion retry.
	 */
	readonly candidateCompletion?: GovernedRecoveredCandidateCompletionV1;
}

export interface GovernedRecoveredActivityResultV1 {
	readonly resultEventRef: string;
	readonly resultEventDigest: string;
	readonly claimEventRef: string;
	readonly claimEventDigest: string;
	readonly outcome: "succeeded" | "failed" | "unknown";
}

export interface GovernedRecoveredActivityClaimV1 {
	readonly activityId: string;
	readonly idempotencyKey: string;
	readonly claimEventRef: string;
	readonly claimEventDigest: string;
	readonly actionRequestRef: string;
	readonly actionRequestDigest: string;
	readonly leaseId: string;
	readonly leaseExpiresAt: string;
	/**
	 * Optional for hand-built legacy snapshots. Native parsed claims always
	 * normalize an omitted wire field to `generic` before exposing it.
	 */
	readonly claimPurpose?:
		| "generic"
		| "governed_verifier_v1"
		| "governed_model_action_v1";
	readonly result?: GovernedRecoveredActivityResultV1;
}

export interface GovernedRecoveredCandidateCompletionV1 {
	readonly candidateCompletionRef: string;
	readonly completion: KernelCandidateCompletionRecordedV1;
}

/**
 * Caller-owned durable lookup for V3 action evidence. It must query the
 * signed tape/reducer, not process-local state or an eventually consistent
 * telemetry projection. It must return the signed dispatch policy binding
 * even when no action records exist yet; `undefined` is treated as missing
 * authority and blocks a fresh governed effect.
 */
export interface GovernedActionEvidenceRecoveryResolver {
	resolveDispatch(
		scope: GovernedActionDispatchScopeV1,
	): Promise<GovernedActionEvidenceRecoverySnapshot | undefined>;
}

export interface GovernedActionEvidencePortOptions {
	/** Mandatory for governed V3 evidence: fresh ports may not guess history. */
	readonly recoveryResolver?: GovernedActionEvidenceRecoveryResolver;
	/**
	 * A protected dispatch identity supplied by the native session constructor.
	 * It lets a newly constructed port rehydrate a candidate-completion retry
	 * before it has a process-local CandidateCreatedV2 map. The resolver still
	 * has to return signed facts for this exact scope; this object alone is not
	 * authority.
	 */
	readonly recoveryScope?: GovernedActionDispatchScopeV1;
}

/**
 * Convert the kernel's closed camel-case action-request contract to the
 * native ledger's exact snake-case externally-tagged payload body.
 */
export function toActionRequestedV2WirePayload(
	input: KernelActionRequestedV2,
): LedgerActionRequestedV2 {
	const request = parseActionRequestedV2(input);
	requireAsciiActionId(request.actionId, "actionId");
	return {
		run_id: request.runId,
		workflow_id: request.workflowId,
		unit_id: request.unitId,
		attempt: request.attempt,
		provenance_ref: request.provenanceRef,
		action_id: request.actionId,
		idempotency_key: request.idempotencyKey,
		action_kind: toActionKindWire(request.actionKind),
		canonical_input_digest: request.canonicalInputDigest,
		canonical_input_ref: request.canonicalInputRef,
		dispatch_envelope_digest: request.dispatchEnvelopeDigest,
		capability_bundle_digest: request.capabilityBundleDigest,
		policy_digest: request.policyDigest,
		context_manifest_digest: request.contextManifestDigest,
		worker_manifest_digest: request.workerManifestDigest,
		sandbox_profile_digest: request.sandboxProfileDigest,
		repository_binding_digest: request.repositoryBindingDigest,
		ledger_authority_realm_digest: request.ledgerAuthorityRealmDigest,
		...(request.governedPacketDigest === undefined
			? {}
			: { governed_packet_digest: request.governedPacketDigest }),
		authority_actor: request.authorityActor,
		execution_role: toExecutionRoleWire(request.executionRole),
		requested_at: request.requestedAt,
	};
}

/**
 * Convert a fully materialized kernel receipt to its native ledger payload.
 * The V2 parser is deliberately run here too, keeping direct helper callers
 * on the same closed-schema boundary as the port.
 */
export function toActionReceiptRecordedV2WirePayload(
	input: KernelActionReceiptRecordedV2,
): LedgerActionReceiptRecordedV2 {
	const receipt = parseActionReceiptRecordedV2(input);
	requireAsciiActionId(receipt.actionId, "actionId");
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
		execution_role: toExecutionRoleWire(receipt.executionRole),
		...(receipt.authorizationRef === undefined
			? {}
			: { authorization_ref: receipt.authorizationRef }),
		outcome: toActionReceiptOutcomeWire(receipt.outcome),
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

/** Convert a parser-validated V3 seal to the exact native tape body. */
export function toActionReceiptSetRecordedV1WirePayload(
	input: KernelActionReceiptSetRecordedV1,
): LedgerActionReceiptSetRecordedV1 {
	const receiptSet = parseActionReceiptSetRecordedV1(input);
	for (const receipt of receiptSet.receipts) {
		requireAsciiActionId(receipt.actionId, "receipt.actionId");
	}
	return {
		run_id: receiptSet.runId,
		workflow_id: receiptSet.workflowId,
		unit_id: receiptSet.unitId,
		attempt: receiptSet.attempt,
		provenance_ref: receiptSet.provenanceRef,
		dispatch_envelope_digest: receiptSet.dispatchEnvelopeDigest,
		action_receipt_set_ref: receiptSet.actionReceiptSetRef,
		action_receipt_set_digest: receiptSet.actionReceiptSetDigest,
		receipts: receiptSet.receipts.map((receipt) => ({
			action_id: receipt.actionId,
			action_receipt_ref: receipt.actionReceiptRef,
			action_receipt_digest: receipt.actionReceiptDigest,
		})),
		sealed_at: receiptSet.sealedAt,
	};
}

/** Convert immutable candidate evidence to the native V3 candidate payload. */
export function toCandidateCreatedV2WirePayload(
	input: KernelCandidateCreatedV2,
): LedgerCandidateCreatedV2 {
	const candidate = parseCandidateCreatedV2(input);
	return {
		run_id: candidate.runId,
		candidate_id: candidate.candidateId,
		candidate_ref: candidate.candidateRef,
		workflow_id: candidate.workflowId,
		unit_id: candidate.unitId,
		attempt: candidate.attempt,
		provenance_ref: candidate.provenanceRef,
		candidate_digest: candidate.candidateDigest,
		base_commit_sha: candidate.baseCommitSha,
		candidate_commit_sha: candidate.candidateCommitSha,
		commit_digest: candidate.commitDigest,
		tree_digest: candidate.treeDigest,
		patch_digest: candidate.patchDigest,
		changed_files_digest: candidate.changedFilesDigest,
		envelope_digest: candidate.envelopeDigest,
		action_receipt_set_ref: candidate.actionReceiptSetRef,
		action_receipt_set_digest: candidate.actionReceiptSetDigest,
	};
}

/** Convert exact candidate-completion lineage to the native ledger wire form. */
export function toCandidateCompletionRecordedV1WirePayload(
	input: KernelCandidateCompletionRecordedV1,
): LedgerCandidateCompletionRecordedV1 {
	const completion = parseCandidateCompletionRecordedV1(input);
	assertCandidateCompletionEventReferences(completion);
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
		completion_digest: completion.completionDigest,
		completed_at: completion.completedAt,
	};
}

/**
 * Signed-tape implementation of the V3 kernel action-evidence port.
 *
 * Requests, receipts, seals, and candidate records all share a serialization
 * queue. A call never exposes a reference until `flush()` succeeds, and every
 * later stage independently verifies the exact durable record it references.
 */
export function createGovernedActionEvidencePort(
	emitter: TapeEmitter,
	options: GovernedActionEvidencePortOptions = {},
): GovernedActionEvidencePort {
	const tape = requireGovernedActionEvidenceEmitter(emitter);
	const recoveryResolver = options.recoveryResolver;
	const recoveryScope = options.recoveryScope;
	const resolveRecoveredDispatch =
		recoveryResolver && typeof recoveryResolver.resolveDispatch === "function"
			? recoveryResolver.resolveDispatch.bind(recoveryResolver)
			: undefined;
	const requestsByDigest = new Map<string, RecordedGovernedActionRequest>();
	const requestDigestsByAction = new Map<string, string>();
	const requestDigestsByIdempotency = new Map<string, string>();
	const receiptsByRequestDigest = new Map<
		string,
		RecordedGovernedActionReceipt
	>();
	const receiptsByRef = new Map<string, RecordedGovernedActionReceipt>();
	const receiptSetsByScope = new Map<
		string,
		RecordedGovernedActionReceiptSet
	>();
	const receiptSetsByRef = new Map<string, KernelActionReceiptSetRecordedV1>();
	const candidatesByIdentity = new Map<string, RecordedGovernedCandidate>();
	const candidatesByRef = new Map<string, RecordedGovernedCandidate>();
	const candidateCompletionsByCandidateCreatedRef = new Map<
		string,
		RecordedGovernedCandidateCompletion
	>();
	const recoveredScopeKeys = new Set<string>();
	const dispatchPolicyDigestsByScope = new Map<string, string>();
	const recoveryFailuresByScope = new Map<string, Error>();
	let tail: Promise<void> = Promise.resolve();

	function serialized<T>(operation: () => Promise<T>): Promise<T> {
		const next = tail.then(operation, operation);
		tail = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	async function ensureScopeRecovered(
		scope: GovernedActionDispatchScopeV1,
	): Promise<string> {
		const scopeKey = governedActionDispatchScopeKey(scope);
		const recoveryFailure = recoveryFailuresByScope.get(scopeKey);
		if (recoveryFailure) {
			throw recoveryFailure;
		}
		if (recoveredScopeKeys.has(scopeKey)) {
			const policyDigest = dispatchPolicyDigestsByScope.get(scopeKey);
			if (!policyDigest) {
				throw new Error(
					"governed action recovery is missing the signed dispatch policy binding.",
				);
			}
			return policyDigest;
		}
		if (!resolveRecoveredDispatch) {
			throw new Error(
				"governed V3 action evidence requires a durable recovery resolver before an effect can be issued or reused.",
			);
		}
		try {
			const snapshot = await resolveRecoveredDispatch(scope);
			if (snapshot === undefined) {
				throw new Error(
					"governed action recovery did not return signed dispatch authority facts.",
				);
			}
			const dispatchPolicyDigest = canonicalDigest(
				snapshot.dispatchPolicyDigest,
				"durable action recovery dispatchPolicyDigest",
			);
			hydrateRecoveredActionEvidence(
				scope,
				snapshot,
				dispatchPolicyDigest,
				requestsByDigest,
				requestDigestsByAction,
				requestDigestsByIdempotency,
				receiptsByRequestDigest,
				receiptsByRef,
				receiptSetsByScope,
				receiptSetsByRef,
				candidatesByIdentity,
				candidatesByRef,
			);
			recoveredScopeKeys.add(scopeKey);
			dispatchPolicyDigestsByScope.set(scopeKey, dispatchPolicyDigest);
			return dispatchPolicyDigest;
		} catch (error) {
			const failure = new Error(
				"governed action evidence recovery is indeterminate; no V3 action may be issued until it is reconciled.",
				{ cause: error },
			);
			recoveryFailuresByScope.set(scopeKey, failure);
			throw failure;
		}
	}

	return Object.freeze({
		recordActionRequested(input: KernelActionRequestedV2) {
			return serialized(async () => {
				const request = parseActionRequestedV2(input);
				requireAsciiActionId(request.actionId, "actionId");
				const dispatchScope = governedActionDispatchScopeFromRequest(request);
				const dispatchPolicyDigest = await ensureScopeRecovered(dispatchScope);
				if (request.policyDigest !== dispatchPolicyDigest) {
					throw new TypeError(
						"governed action request policyDigest does not match the policy binding recovered from the signed dispatch.",
					);
				}
				const actionRequestDigest = canonicalActionRequestedV2Digest(request);
				if (
					receiptSetsByScope.has(governedActionDispatchScopeKey(dispatchScope))
				) {
					throw new Error(
						"no action request may be issued after the governed dispatch receipt set is sealed.",
					);
				}
				const existing = requestsByDigest.get(actionRequestDigest);
				if (existing) {
					if (existing.origin === "recovered") {
						throw recoveredActionCannotBeIssued(
							existing,
							receiptsByRequestDigest.get(actionRequestDigest),
						);
					}
					return {
						actionRequest: existing.actionRequest,
						actionRequestRef: existing.actionRequestRef,
						actionRequestDigest: existing.actionRequestDigest,
					};
				}
				const actionKey = governedActionRequestKey(request);
				const knownDigest = requestDigestsByAction.get(actionKey);
				if (knownDigest !== undefined && knownDigest !== actionRequestDigest) {
					throw new TypeError(
						"conflicting write-ahead action request for the same governed action identity.",
					);
				}
				const idempotencyKey = governedActionIdempotencyKey(request);
				const knownIdempotencyDigest =
					requestDigestsByIdempotency.get(idempotencyKey);
				if (
					knownIdempotencyDigest !== undefined &&
					knownIdempotencyDigest !== actionRequestDigest
				) {
					const bound = requestsByDigest.get(knownIdempotencyDigest);
					if (bound && bound.actionRequest.actionId !== request.actionId) {
						throw new TypeError(
							"action idempotency key is already bound to a different action id for this governed dispatch.",
						);
					}
					throw new TypeError(
						"conflicting write-ahead action request for the same governed action idempotency key.",
					);
				}

				const actionRequestRef = newEventId();
				const payload: Payload = {
					ActionRequestedV2: toActionRequestedV2WirePayload(request),
				};
				tape.emit("action_requested_v2", payload, { id: actionRequestRef });
				await flushWriteAhead(tape);

				const recorded: RecordedGovernedActionRequest = {
					actionRequest: request,
					actionRequestRef,
					actionRequestDigest,
					origin: "local",
				};
				requestsByDigest.set(actionRequestDigest, recorded);
				requestDigestsByAction.set(actionKey, actionRequestDigest);
				requestDigestsByIdempotency.set(idempotencyKey, actionRequestDigest);
				return {
					actionRequest: recorded.actionRequest,
					actionRequestRef: recorded.actionRequestRef,
					actionRequestDigest: recorded.actionRequestDigest,
				};
			});
		},

		recordActionReceipt(input: RecordActionReceiptV2Input) {
			return serialized(async () => {
				assertReceiptReferenceIsPortIssued(input);
				const fingerprintReceipt = parseActionReceiptRecordedV2({
					...input,
					actionReceiptRef: ACTION_RECEIPT_FINGERPRINT_REF,
				});
				requireAsciiActionId(fingerprintReceipt.actionId, "actionId");
				await ensureScopeRecovered(
					governedActionDispatchScopeFromReceipt(fingerprintReceipt),
				);
				const request = requestsByDigest.get(
					fingerprintReceipt.actionRequestDigest,
				);
				if (!request) {
					throw new Error(
						"action receipt requires a previously flushed write-ahead action request.",
					);
				}
				assertReceiptBindsRequest(fingerprintReceipt, request);
				const fingerprint =
					canonicalActionReceiptRecordedV2Digest(fingerprintReceipt);
				const existing = receiptsByRequestDigest.get(
					fingerprintReceipt.actionRequestDigest,
				);
				if (existing) {
					if (existing.fingerprint !== fingerprint) {
						throw new TypeError(
							"conflicting terminal action receipt for the same write-ahead request.",
						);
					}
					return {
						receipt: existing.receipt,
						actionReceiptDigest: existing.actionReceiptDigest,
					};
				}

				const actionReceiptRef = newEventId();
				const receipt = parseActionReceiptRecordedV2({
					...fingerprintReceipt,
					actionReceiptRef,
				});
				const actionReceiptDigest =
					canonicalActionReceiptRecordedV2Digest(receipt);
				const payload: Payload = {
					ActionReceiptRecordedV2:
						toActionReceiptRecordedV2WirePayload(receipt),
				};
				tape.emit("action_receipt_recorded_v2", payload, {
					id: actionReceiptRef,
				});
				await flushWriteAhead(tape);

				const recorded: RecordedGovernedActionReceipt = {
					receipt,
					actionReceiptDigest,
					fingerprint,
					origin: "local",
				};
				receiptsByRequestDigest.set(
					fingerprintReceipt.actionRequestDigest,
					recorded,
				);
				receiptsByRef.set(actionReceiptRef, recorded);
				return { receipt, actionReceiptDigest };
			});
		},

		sealActionReceiptSet(input: SealActionReceiptSetV1Input) {
			return serialized(async () => {
				const preliminary = buildActionReceiptSetRecord(
					input,
					ACTION_RECEIPT_SET_PREVIEW_REF,
					[],
				);
				await ensureScopeRecovered(
					governedActionDispatchScopeFromReceiptSet(preliminary),
				);
				const receipts = normalizeAndVerifyReceiptSetEntries(
					input,
					receiptsByRef,
				);
				const preview = buildActionReceiptSetRecord(
					input,
					ACTION_RECEIPT_SET_PREVIEW_REF,
					receipts,
				);
				assertReceiptSetContainsEveryTerminalAction(
					preview,
					receipts,
					requestsByDigest,
					receiptsByRequestDigest,
				);
				const scope = governedActionReceiptSetScopeKey(preview);
				const fingerprint = governedActionReceiptSetFingerprint(preview);
				const existing = receiptSetsByScope.get(scope);
				if (existing) {
					if (existing.fingerprint !== fingerprint) {
						throw new TypeError(
							"conflicting receipt-set seal for the same governed action attempt.",
						);
					}
					return existing.receiptSet;
				}

				const actionReceiptSetRef = newEventId();
				const receiptSet = buildActionReceiptSetRecord(
					preview,
					actionReceiptSetRef,
					preview.receipts,
				);
				const payload: Payload = {
					ActionReceiptSetRecordedV1:
						toActionReceiptSetRecordedV1WirePayload(receiptSet),
				};
				tape.emit("action_receipt_set_recorded_v1", payload, {
					id: actionReceiptSetRef,
				});
				await flushWriteAhead(tape);

				receiptSetsByScope.set(scope, { receiptSet, fingerprint });
				receiptSetsByRef.set(actionReceiptSetRef, receiptSet);
				return receiptSet;
			});
		},

		recordCandidateCreatedV2(input: KernelCandidateCreatedV2) {
			return serialized(async () => {
				const candidate = parseCandidateCreatedV2(input);
				await ensureScopeRecovered(
					governedActionDispatchScopeFromCandidate(candidate),
				);
				const receiptSet = receiptSetsByRef.get(candidate.actionReceiptSetRef);
				if (!receiptSet) {
					throw new Error(
						"CandidateCreatedV2 requires a previously flushed action receipt-set seal.",
					);
				}
				assertCandidateBindsReceiptSet(candidate, receiptSet);
				const identity = governedCandidateIdentityKey(candidate);
				const fingerprint = digest(candidate);
				const existing = candidatesByIdentity.get(identity);
				if (existing) {
					if (existing.fingerprint !== fingerprint) {
						throw new TypeError(
							"conflicting CandidateCreatedV2 record for the same immutable candidate identity.",
						);
					}
					return existing.candidateCreatedRef;
				}

				const candidateCreatedRef = newEventId();
				const payload: Payload = {
					CandidateCreatedV2: toCandidateCreatedV2WirePayload(candidate),
				};
				tape.emit("candidate_created_v2", payload, {
					id: candidateCreatedRef,
				});
				await flushWriteAhead(tape);
				candidatesByIdentity.set(identity, {
					candidateCreatedRef,
					fingerprint,
					candidate,
				});
				candidatesByRef.set(candidateCreatedRef, {
					candidateCreatedRef,
					fingerprint,
					candidate,
				});
				return candidateCreatedRef;
			});
		},

		recordCandidateCompletion(input: KernelCandidateCompletionRecordedV1) {
			return serialized(async () => {
				const completion = parseCandidateCompletionRecordedV1(input);
				assertCandidateCompletionEventReferences(completion);
				const completionDigest =
					canonicalCandidateCompletionRecordedV1Digest(completion);
				if (completionDigest !== completion.completionDigest) {
					throw new TypeError(
						"candidate completion digest does not match its canonical record.",
					);
				}

				return serializeCandidateCompletionAcrossPorts(
					completion.candidateCreatedEventRef,
					async () => {
						const local = candidateCompletionsByCandidateCreatedRef.get(
							completion.candidateCreatedEventRef,
						);
						if (local) {
							if (local.completion.completionDigest !== completionDigest) {
								throw new TypeError(
									"conflicting candidate-completion record for the same candidate-created event.",
								);
							}
							indeterminateCandidateCompletionWrites.delete(
								completion.candidateCreatedEventRef,
							);
							return {
								candidateCompletionRef: local.candidateCompletionRef,
								completionDigest,
							};
						}

						let recordedCandidate = candidatesByRef.get(
							completion.candidateCreatedEventRef,
						);
						if (!recordedCandidate) {
							if (!recoveryScope) {
								throw new Error(
									"candidate completion requires the exact CandidateCreatedV2 event to be durably recovered or a protected recovery scope to rehydrate it.",
								);
							}
							assertCandidateCompletionMatchesRecoveryScope(
								completion,
								recoveryScope,
							);
							await ensureScopeRecovered(recoveryScope);
							recordedCandidate = candidatesByRef.get(
								completion.candidateCreatedEventRef,
							);
							if (!recordedCandidate) {
								throw new Error(
									"candidate completion recovery did not contain the exact CandidateCreatedV2 event.",
								);
							}
						}
						const scope = governedActionDispatchScopeFromCandidate(
							recordedCandidate.candidate,
						);
						if (
							recoveryScope !== undefined &&
							governedActionDispatchScopeKey(scope) !==
								governedActionDispatchScopeKey(recoveryScope)
						) {
							throw new TypeError(
								"candidate completion recovery scope does not match the rehydrated immutable candidate.",
							);
						}
						await ensureScopeRecovered(scope);
						const freshSnapshot =
							await resolveFreshCandidateCompletionRecovery(scope);
						const recovered = assertCandidateCompletionBindsRecovery(
							freshSnapshot,
							scope,
							completion,
						);
						if (recovered) {
							indeterminateCandidateCompletionWrites.delete(
								completion.candidateCreatedEventRef,
							);
							candidateCompletionsByCandidateCreatedRef.set(
								completion.candidateCreatedEventRef,
								recovered,
							);
							return {
								candidateCompletionRef: recovered.candidateCompletionRef,
								completionDigest,
							};
						}
						const indeterminate = indeterminateCandidateCompletionWrites.get(
							completion.candidateCreatedEventRef,
						);
						if (indeterminate) {
							throw indeterminate;
						}

						const candidateCompletionRef = newEventId();
						const payload: Payload = {
							CandidateCompletionRecordedV1:
								toCandidateCompletionRecordedV1WirePayload(completion),
						};
						let appendAttempted = false;
						try {
							appendAttempted = true;
							tape.emit("candidate_completion_recorded_v1", payload, {
								id: candidateCompletionRef,
								parent: completion.candidateCreatedEventRef,
								occurredAt: completion.completedAt,
							});
							await flushWriteAhead(tape);
						} catch (error) {
							if (appendAttempted) {
								const indeterminate = new Error(
									"candidate completion append outcome is indeterminate; reconcile the signed tape before retrying.",
									{ cause: error },
								);
								indeterminateCandidateCompletionWrites.set(
									completion.candidateCreatedEventRef,
									indeterminate,
								);
								throw indeterminate;
							}
							throw error;
						}
						candidateCompletionsByCandidateCreatedRef.set(
							completion.candidateCreatedEventRef,
							{ candidateCompletionRef, completion },
						);
						return { candidateCompletionRef, completionDigest };
					},
				);
			});
		},
	});

	async function resolveFreshCandidateCompletionRecovery(
		scope: GovernedActionDispatchScopeV1,
	): Promise<GovernedActionEvidenceRecoverySnapshot> {
		if (!resolveRecoveredDispatch) {
			throw new Error(
				"candidate completion requires a signed recovery resolver; process-local evidence is not sufficient.",
			);
		}
		const snapshot = await resolveRecoveredDispatch(scope);
		if (snapshot === undefined) {
			throw new Error(
				"candidate completion recovery did not return signed dispatch authority facts.",
			);
		}
		const recoveredPolicyDigest = canonicalDigest(
			snapshot.dispatchPolicyDigest,
			"candidate completion recovery dispatchPolicyDigest",
		);
		const expectedPolicyDigest = dispatchPolicyDigestsByScope.get(
			governedActionDispatchScopeKey(scope),
		);
		if (
			!expectedPolicyDigest ||
			recoveredPolicyDigest !== expectedPolicyDigest
		) {
			throw new TypeError(
				"candidate completion recovery policy binding does not match the previously verified signed dispatch.",
			);
		}
		return snapshot;
	}
}

function requireGovernedActionEvidenceEmitter(
	emitter: TapeEmitter,
): TapeEmitter {
	if (
		!emitter ||
		typeof emitter.emit !== "function" ||
		typeof emitter.flush !== "function"
	) {
		throw new TypeError(
			"createGovernedActionEvidencePort requires a concrete signed tape emitter.",
		);
	}
	return emitter;
}

function serializeCandidateCompletionAcrossPorts<T>(
	candidateCreatedEventRef: string,
	operation: () => Promise<T>,
): Promise<T> {
	const prior =
		candidateCompletionTails.get(candidateCreatedEventRef) ?? Promise.resolve();
	const next = prior.then(operation, operation);
	const barrier = next.then(
		() => undefined,
		() => undefined,
	);
	candidateCompletionTails.set(candidateCreatedEventRef, barrier);
	void barrier.then(() => {
		if (candidateCompletionTails.get(candidateCreatedEventRef) === barrier) {
			candidateCompletionTails.delete(candidateCreatedEventRef);
		}
	});
	return next;
}

const ASCII_ACTION_ID = /^[\x21-\x7e]+$/;
const CANONICAL_EVENT_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function requireAsciiActionId(value: unknown, field: string): string {
	const actionId = requireNonEmpty(value, field);
	if (!ASCII_ACTION_ID.test(actionId)) {
		throw new TypeError(
			`${field} must contain printable ASCII only so sealed action ordering is byte-stable across the kernel and native reducer.`,
		);
	}
	return actionId;
}

function requireCanonicalEventId(value: unknown, field: string): string {
	if (typeof value !== "string" || !CANONICAL_EVENT_ID.test(value)) {
		throw new TypeError(
			`${field} must be a canonical lowercase UUID event id for the native ledger.`,
		);
	}
	return value;
}

function assertCandidateCompletionEventReferences(
	completion: KernelCandidateCompletionRecordedV1,
): void {
	requireCanonicalEventId(
		completion.candidateCreatedEventRef,
		"candidateCompletion.candidateCreatedEventRef",
	);
	requireCanonicalEventId(
		completion.actionRequestRef,
		"candidateCompletion.actionRequestRef",
	);
	requireCanonicalEventId(
		completion.activityClaimEventRef,
		"candidateCompletion.activityClaimEventRef",
	);
	requireCanonicalEventId(
		completion.activityResultEventRef,
		"candidateCompletion.activityResultEventRef",
	);
}

function assertCandidateCompletionMatchesRecoveryScope(
	completion: KernelCandidateCompletionRecordedV1,
	scope: GovernedActionDispatchScopeV1,
): void {
	if (
		completion.runId !== scope.runId ||
		completion.workflowId !== scope.workflowId ||
		completion.unitId !== scope.unitId ||
		completion.attempt !== scope.attempt ||
		completion.provenanceRef !== scope.provenanceRef
	) {
		throw new TypeError(
			"candidate completion identity does not match the protected recovery scope.",
		);
	}
}

/** Both native `BTreeMap<String>` and the kernel parser agree for ASCII. */
function compareAsciiActionIds(left: string, right: string): number {
	if (left === right) {
		return 0;
	}
	return left < right ? -1 : 1;
}

function governedActionDispatchScopeFromRequest(
	request: KernelActionRequestedV2,
): GovernedActionDispatchScopeV1 {
	return {
		runId: request.runId,
		workflowId: request.workflowId,
		unitId: request.unitId,
		attempt: request.attempt,
		provenanceRef: request.provenanceRef,
		dispatchEnvelopeDigest: request.dispatchEnvelopeDigest,
	};
}

function governedActionDispatchScopeFromReceipt(
	receipt: KernelActionReceiptRecordedV2,
): GovernedActionDispatchScopeV1 {
	return {
		runId: receipt.runId,
		workflowId: receipt.workflowId,
		unitId: receipt.unitId,
		attempt: receipt.attempt,
		provenanceRef: receipt.provenanceRef,
		dispatchEnvelopeDigest: receipt.dispatchEnvelopeDigest,
	};
}

function governedActionDispatchScopeFromReceiptSet(
	set: Pick<
		KernelActionReceiptSetRecordedV1,
		| "runId"
		| "workflowId"
		| "unitId"
		| "attempt"
		| "provenanceRef"
		| "dispatchEnvelopeDigest"
	>,
): GovernedActionDispatchScopeV1 {
	return {
		runId: set.runId,
		workflowId: set.workflowId,
		unitId: set.unitId,
		attempt: set.attempt,
		provenanceRef: set.provenanceRef,
		dispatchEnvelopeDigest: set.dispatchEnvelopeDigest,
	};
}

function governedActionDispatchScopeFromCandidate(
	candidate: KernelCandidateCreatedV2,
): GovernedActionDispatchScopeV1 {
	return {
		runId: candidate.runId,
		workflowId: candidate.workflowId,
		unitId: candidate.unitId,
		attempt: candidate.attempt,
		provenanceRef: candidate.provenanceRef,
		dispatchEnvelopeDigest: candidate.envelopeDigest,
	};
}

function governedActionDispatchScopeKey(
	scope: GovernedActionDispatchScopeV1,
): string {
	return digest({
		runId: scope.runId,
		workflowId: scope.workflowId,
		unitId: scope.unitId,
		attempt: scope.attempt,
		provenanceRef: scope.provenanceRef,
		dispatchEnvelopeDigest: scope.dispatchEnvelopeDigest,
	});
}

function assertScopeMatchesRequest(
	scope: GovernedActionDispatchScopeV1,
	request: KernelActionRequestedV2,
	field: string,
): void {
	if (
		governedActionDispatchScopeKey(scope) !==
		governedActionDispatchScopeKey(
			governedActionDispatchScopeFromRequest(request),
		)
	) {
		throw new TypeError(
			`${field} does not belong to the requested governed dispatch.`,
		);
	}
}

function assertScopeMatchesReceipt(
	scope: GovernedActionDispatchScopeV1,
	receipt: KernelActionReceiptRecordedV2,
	field: string,
): void {
	if (
		governedActionDispatchScopeKey(scope) !==
		governedActionDispatchScopeKey(
			governedActionDispatchScopeFromReceipt(receipt),
		)
	) {
		throw new TypeError(
			`${field} does not belong to the requested governed dispatch.`,
		);
	}
}

function assertScopeMatchesReceiptSet(
	scope: GovernedActionDispatchScopeV1,
	set: KernelActionReceiptSetRecordedV1,
	field: string,
): void {
	if (
		governedActionDispatchScopeKey(scope) !==
		governedActionDispatchScopeKey(
			governedActionDispatchScopeFromReceiptSet(set),
		)
	) {
		throw new TypeError(
			`${field} does not belong to the requested governed dispatch.`,
		);
	}
}

function recoveredActionCannotBeIssued(
	request: RecordedGovernedActionRequest,
	receipt: RecordedGovernedActionReceipt | undefined,
): Error {
	if (!receipt) {
		return new Error(
			`recovered action '${request.actionRequest.actionId}' is pending; reconcile it before any action can be reissued.`,
		);
	}
	if (receipt.receipt.outcome === "unknown") {
		return new Error(
			`recovered action '${request.actionRequest.actionId}' has an unknown outcome; reconciliation is required before any action can be reissued.`,
		);
	}
	return new Error(
		`recovered action '${request.actionRequest.actionId}' is already terminal; recovery must use its durable receipt rather than reissuing the effect.`,
	);
}

function hydrateRecoveredActionEvidence(
	scope: GovernedActionDispatchScopeV1,
	snapshot: GovernedActionEvidenceRecoverySnapshot,
	dispatchPolicyDigest: string,
	requestsByDigest: Map<string, RecordedGovernedActionRequest>,
	requestDigestsByAction: Map<string, string>,
	requestDigestsByIdempotency: Map<string, string>,
	receiptsByRequestDigest: Map<string, RecordedGovernedActionReceipt>,
	receiptsByRef: Map<string, RecordedGovernedActionReceipt>,
	receiptSetsByScope: Map<string, RecordedGovernedActionReceiptSet>,
	receiptSetsByRef: Map<string, KernelActionReceiptSetRecordedV1>,
	candidatesByIdentity: Map<string, RecordedGovernedCandidate>,
	candidatesByRef: Map<string, RecordedGovernedCandidate>,
): void {
	if (!snapshot || typeof snapshot !== "object") {
		throw new TypeError(
			"durable action evidence recovery must return an object or undefined.",
		);
	}
	if (!Array.isArray(snapshot.requests) || !Array.isArray(snapshot.receipts)) {
		throw new TypeError(
			"durable action evidence recovery must return request and receipt arrays.",
		);
	}

	for (let index = 0; index < snapshot.requests.length; index += 1) {
		if (!Object.hasOwn(snapshot.requests, index)) {
			throw new TypeError(
				"durable action recovery requests must not be sparse.",
			);
		}
		const recovered = snapshot.requests[index];
		if (!recovered || typeof recovered !== "object") {
			throw new TypeError(
				`durable action recovery request ${index} must be an object.`,
			);
		}
		const request = parseActionRequestedV2(recovered.actionRequest);
		requireAsciiActionId(
			request.actionId,
			`recovery.requests[${index}].actionId`,
		);
		assertScopeMatchesRequest(scope, request, `recovery.requests[${index}]`);
		if (request.policyDigest !== dispatchPolicyDigest) {
			throw new TypeError(
				`recovery.requests[${index}].policyDigest does not match the signed dispatch policy binding.`,
			);
		}
		const actionRequestRef = requireNonEmpty(
			recovered.actionRequestRef,
			`recovery.requests[${index}].actionRequestRef`,
		);
		const actionRequestDigest = canonicalActionRequestedV2Digest(request);
		if (recovered.actionRequestDigest !== actionRequestDigest) {
			throw new TypeError(
				`recovery.requests[${index}].actionRequestDigest does not match the canonical action request.`,
			);
		}
		registerRecoveredActionRequest(
			{
				actionRequest: request,
				actionRequestRef,
				actionRequestDigest,
				origin: "recovered",
			},
			requestsByDigest,
			requestDigestsByAction,
			requestDigestsByIdempotency,
		);
	}

	for (let index = 0; index < snapshot.receipts.length; index += 1) {
		if (!Object.hasOwn(snapshot.receipts, index)) {
			throw new TypeError(
				"durable action recovery receipts must not be sparse.",
			);
		}
		const recovered = snapshot.receipts[index];
		if (!recovered || typeof recovered !== "object") {
			throw new TypeError(
				`durable action recovery receipt ${index} must be an object.`,
			);
		}
		const receipt = parseActionReceiptRecordedV2(recovered.receipt);
		requireAsciiActionId(
			receipt.actionId,
			`recovery.receipts[${index}].actionId`,
		);
		assertScopeMatchesReceipt(scope, receipt, `recovery.receipts[${index}]`);
		const actionReceiptDigest = canonicalActionReceiptRecordedV2Digest(receipt);
		if (recovered.actionReceiptDigest !== actionReceiptDigest) {
			throw new TypeError(
				`recovery.receipts[${index}].actionReceiptDigest does not match the canonical action receipt.`,
			);
		}
		const request = requestsByDigest.get(receipt.actionRequestDigest);
		if (!request) {
			throw new Error(
				`recovery.receipts[${index}] has no recovered write-ahead action request.`,
			);
		}
		assertReceiptBindsRequest(receipt, request);
		const fingerprint = canonicalActionReceiptRecordedV2Digest(
			parseActionReceiptRecordedV2({
				...receipt,
				actionReceiptRef: ACTION_RECEIPT_FINGERPRINT_REF,
			}),
		);
		registerRecoveredActionReceipt(
			{ receipt, actionReceiptDigest, fingerprint, origin: "recovered" },
			receiptsByRequestDigest,
			receiptsByRef,
		);
	}

	if (snapshot.receiptSet !== undefined) {
		const receiptSet = parseActionReceiptSetRecordedV1(snapshot.receiptSet);
		assertScopeMatchesReceiptSet(scope, receiptSet, "recovery.receiptSet");
		for (const receipt of receiptSet.receipts) {
			requireAsciiActionId(
				receipt.actionId,
				"recovery.receiptSet.receipt.actionId",
			);
		}
		assertReceiptSetContainsEveryTerminalAction(
			receiptSet,
			receiptSet.receipts,
			requestsByDigest,
			receiptsByRequestDigest,
		);
		const receiptSetScope = governedActionReceiptSetScopeKey(receiptSet);
		const fingerprint = governedActionReceiptSetFingerprint(receiptSet);
		const existing = receiptSetsByScope.get(receiptSetScope);
		if (existing) {
			if (
				existing.fingerprint !== fingerprint ||
				existing.receiptSet.actionReceiptSetRef !==
					receiptSet.actionReceiptSetRef ||
				existing.receiptSet.actionReceiptSetDigest !==
					receiptSet.actionReceiptSetDigest
			) {
				throw new TypeError(
					"durable action recovery returned a conflicting receipt-set seal for the governed dispatch.",
				);
			}
		} else {
			receiptSetsByScope.set(receiptSetScope, { receiptSet, fingerprint });
			receiptSetsByRef.set(receiptSet.actionReceiptSetRef, receiptSet);
		}
	}

	const candidates = snapshot.candidates;
	if (!Array.isArray(candidates)) {
		throw new TypeError("durable action recovery candidates must be an array.");
	}
	for (let index = 0; index < candidates.length; index += 1) {
		if (!Object.hasOwn(candidates, index)) {
			throw new TypeError(
				"durable action recovery candidates must not be sparse.",
			);
		}
		const recovered = candidates[index];
		if (!recovered || typeof recovered !== "object") {
			throw new TypeError(
				`durable action recovery candidate ${index} must be an object.`,
			);
		}
		const candidate = parseCandidateCreatedV2(recovered.candidate);
		if (
			governedActionDispatchScopeKey(scope) !==
			governedActionDispatchScopeKey(
				governedActionDispatchScopeFromCandidate(candidate),
			)
		) {
			throw new TypeError(
				`recovery.candidates[${index}] does not belong to the requested governed dispatch.`,
			);
		}
		const receiptSet = receiptSetsByRef.get(candidate.actionReceiptSetRef);
		if (!receiptSet) {
			throw new Error(
				`recovery.candidates[${index}] has no recovered action receipt-set seal.`,
			);
		}
		assertCandidateBindsReceiptSet(candidate, receiptSet);
		const candidateCreatedRef = requireNonEmpty(
			recovered.candidateCreatedRef,
			`recovery.candidates[${index}].candidateCreatedRef`,
		);
		const identity = governedCandidateIdentityKey(candidate);
		const fingerprint = digest(candidate);
		const existing = candidatesByIdentity.get(identity);
		if (existing) {
			if (
				existing.fingerprint !== fingerprint ||
				existing.candidateCreatedRef !== candidateCreatedRef
			) {
				throw new TypeError(
					"durable action recovery returned a conflicting CandidateCreatedV2 record.",
				);
			}
		}
		const existingByRef = candidatesByRef.get(candidateCreatedRef);
		if (
			existingByRef &&
			(existingByRef.fingerprint !== fingerprint ||
				existingByRef.candidateCreatedRef !== candidateCreatedRef)
		) {
			throw new TypeError(
				"durable action recovery returned one candidate-created reference for conflicting candidates.",
			);
		}
		const recorded: RecordedGovernedCandidate = {
			candidateCreatedRef,
			fingerprint,
			candidate,
		};
		if (!existing) {
			candidatesByIdentity.set(identity, recorded);
		}
		if (!existingByRef) {
			candidatesByRef.set(candidateCreatedRef, recorded);
		}
	}
}

/**
 * Candidate-completion proof is the bridge between immutable Git candidate
 * materialization and later review/promotion. Re-read the protected reducer
 * view after CandidateCreatedV2 instead of accepting a caller's narrative or
 * the port's maps as evidence of the native activity lifecycle.
 */
/**
 * Validate the entire sealed V3 candidate-completion closure. Native replay
 * resolver consumers and the append/retry path share this one contract so a
 * completion-shaped projection can never become evidence by skipping the
 * Git/request/claim/result/receipt/set joins.
 */
export function assertCandidateCompletionBindsRecovery(
	snapshot: GovernedActionEvidenceRecoverySnapshot,
	scope: GovernedActionDispatchScopeV1,
	completionInput: KernelCandidateCompletionRecordedV1,
): GovernedRecoveredCandidateCompletionV1 | undefined {
	const completion = parseCandidateCompletionRecordedV1(completionInput);
	if (
		canonicalCandidateCompletionRecordedV1Digest(completion) !==
		completion.completionDigest
	) {
		throw new TypeError(
			"candidate completion recovery received a non-canonical completion digest.",
		);
	}
	if (!Array.isArray(snapshot.candidates)) {
		throw new TypeError(
			"candidate completion recovery must return a candidate array.",
		);
	}
	const matchingCandidates = snapshot.candidates.filter((entry) => {
		return (
			entry &&
			typeof entry === "object" &&
			entry.candidateCreatedRef === completion.candidateCreatedEventRef
		);
	});
	if (matchingCandidates.length !== 1) {
		throw new Error(
			"candidate completion recovery must contain exactly one referenced CandidateCreatedV2 record.",
		);
	}
	const recoveredCandidate = matchingCandidates[0];
	const candidate = parseCandidateCreatedV2(recoveredCandidate.candidate);
	if (
		governedActionDispatchScopeKey(scope) !==
		governedActionDispatchScopeKey(
			governedActionDispatchScopeFromCandidate(candidate),
		)
	) {
		throw new TypeError(
			"candidate completion recovery candidate does not belong to the governed dispatch.",
		);
	}
	if (
		candidate.candidateDigest !== completion.candidateDigest ||
		candidate.runId !== completion.runId ||
		candidate.workflowId !== completion.workflowId ||
		candidate.unitId !== completion.unitId ||
		candidate.attempt !== completion.attempt ||
		candidate.provenanceRef !== completion.provenanceRef
	) {
		throw new TypeError(
			"candidate completion does not bind the exact recovered immutable candidate identity.",
		);
	}
	const expectedActionId = candidateCreateActionId(candidate);
	if (completion.candidateCreateActionId !== expectedActionId) {
		throw new TypeError(
			"candidate completion action id is not the canonical candidate-create Git action.",
		);
	}

	if (!Array.isArray(snapshot.requests)) {
		throw new TypeError(
			"candidate completion recovery must return an action-request array.",
		);
	}
	const matchingRequests = snapshot.requests.filter((entry) => {
		return (
			entry &&
			typeof entry === "object" &&
			entry.actionRequestRef === completion.actionRequestRef &&
			entry.actionRequestDigest === completion.actionRequestDigest
		);
	});
	if (matchingRequests.length !== 1) {
		throw new Error(
			"candidate completion recovery must contain exactly one referenced action request.",
		);
	}
	const request = parseActionRequestedV2(matchingRequests[0].actionRequest);
	if (
		canonicalActionRequestedV2Digest(request) !==
			completion.actionRequestDigest ||
		request.actionId !== expectedActionId ||
		request.actionKind !== "git" ||
		request.runId !== candidate.runId ||
		request.workflowId !== candidate.workflowId ||
		request.unitId !== candidate.unitId ||
		request.attempt !== candidate.attempt ||
		request.provenanceRef !== candidate.provenanceRef ||
		request.dispatchEnvelopeDigest !== candidate.envelopeDigest
	) {
		throw new TypeError(
			"candidate completion request does not bind the exact candidate-create Git action.",
		);
	}

	if (!Array.isArray(snapshot.activityClaims)) {
		throw new Error(
			"candidate completion recovery must include signed activity claim/result evidence.",
		);
	}
	const matchingClaims = snapshot.activityClaims.filter((entry) => {
		return (
			entry &&
			typeof entry === "object" &&
			entry.activityId === expectedActionId &&
			entry.idempotencyKey === request.idempotencyKey &&
			entry.claimEventRef === completion.activityClaimEventRef &&
			entry.claimEventDigest === completion.activityClaimEventDigest &&
			entry.actionRequestRef === completion.actionRequestRef &&
			entry.actionRequestDigest === completion.actionRequestDigest
		);
	});
	if (matchingClaims.length !== 1) {
		throw new Error(
			"candidate completion recovery must contain exactly one matching activity claim.",
		);
	}
	const claim = matchingClaims[0];
	if (
		requireNonEmpty(claim.leaseId, "candidate completion claim leaseId") ===
			"" ||
		!isRfc3339Utc(claim.leaseExpiresAt)
	) {
		throw new TypeError(
			"candidate completion activity claim has an invalid lease identity or expiry.",
		);
	}
	const result = claim.result;
	if (
		!result ||
		result.outcome !== "succeeded" ||
		result.resultEventRef !== completion.activityResultEventRef ||
		result.resultEventDigest !== completion.activityResultEventDigest ||
		result.claimEventRef !== completion.activityClaimEventRef ||
		result.claimEventDigest !== completion.activityClaimEventDigest
	) {
		throw new TypeError(
			"candidate completion requires one succeeded terminal result for its exact activity claim.",
		);
	}

	if (!Array.isArray(snapshot.receipts)) {
		throw new TypeError(
			"candidate completion recovery must return an action-receipt array.",
		);
	}
	const matchingReceipts = snapshot.receipts.filter((entry) => {
		return (
			entry &&
			typeof entry === "object" &&
			entry.receipt.actionReceiptRef === completion.actionReceiptRef &&
			entry.actionReceiptDigest === completion.actionReceiptDigest
		);
	});
	if (matchingReceipts.length !== 1) {
		throw new Error(
			"candidate completion recovery must contain exactly one referenced terminal receipt.",
		);
	}
	const receipt = parseActionReceiptRecordedV2(matchingReceipts[0].receipt);
	if (
		canonicalActionReceiptRecordedV2Digest(receipt) !==
			completion.actionReceiptDigest ||
		receipt.outcome !== "succeeded" ||
		receipt.actionRequestDigest !== completion.actionRequestDigest ||
		receipt.actionId !== expectedActionId ||
		receipt.idempotencyKey !== request.idempotencyKey
	) {
		throw new TypeError(
			"candidate completion receipt does not bind the succeeded candidate-create request.",
		);
	}
	if (snapshot.receiptSet === undefined) {
		throw new Error(
			"candidate completion recovery is missing the sealed candidate receipt set.",
		);
	}
	const receiptSet = parseActionReceiptSetRecordedV1(snapshot.receiptSet);
	if (
		receiptSet.actionReceiptSetRef !== candidate.actionReceiptSetRef ||
		receiptSet.actionReceiptSetDigest !== candidate.actionReceiptSetDigest
	) {
		throw new TypeError(
			"candidate completion receipt set does not exactly match the immutable candidate.",
		);
	}
	const candidateReceiptEntries = receiptSet.receipts.filter((entry) => {
		return (
			entry.actionId === expectedActionId &&
			entry.actionReceiptRef === completion.actionReceiptRef &&
			entry.actionReceiptDigest === completion.actionReceiptDigest
		);
	});
	if (candidateReceiptEntries.length !== 1) {
		throw new Error(
			"candidate completion receipt is not a member of the immutable candidate receipt set.",
		);
	}

	const recoveredCompletion = snapshot.candidateCompletion;
	if (recoveredCompletion === undefined) {
		return undefined;
	}
	const recovered = parseCandidateCompletionRecordedV1(
		recoveredCompletion.completion,
	);
	const candidateCompletionRef = requireCanonicalEventId(
		recoveredCompletion.candidateCompletionRef,
		"candidate completion recovery candidateCompletionRef",
	);
	if (
		recovered.candidateCreatedEventRef !== completion.candidateCreatedEventRef
	) {
		throw new TypeError(
			"candidate completion recovery references a different candidate-created event.",
		);
	}
	if (recovered.completionDigest !== completion.completionDigest) {
		throw new TypeError(
			"candidate completion recovery conflicts with the requested exact completion proof.",
		);
	}
	return {
		candidateCompletionRef,
		completion: recovered,
	};
}

function candidateCreateActionId(candidate: KernelCandidateCreatedV2): string {
	if (!isCanonicalBuildplaneCandidateRef(candidate.candidateRef)) {
		throw new TypeError(
			"candidate completion requires a canonical Buildplane candidate ref.",
		);
	}
	const prefix = "refs/buildplane/candidates/";
	if (!candidate.candidateRef.startsWith(prefix)) {
		throw new TypeError(
			"candidate completion candidate ref is outside the candidate-create namespace.",
		);
	}
	return `git-candidate-create:${candidate.candidateRef.slice(prefix.length)}`;
}

function isRfc3339Utc(value: unknown): value is string {
	return isNativeRfc3339Utc(value);
}

function registerRecoveredActionRequest(
	recorded: RecordedGovernedActionRequest,
	requestsByDigest: Map<string, RecordedGovernedActionRequest>,
	requestDigestsByAction: Map<string, string>,
	requestDigestsByIdempotency: Map<string, string>,
): void {
	const existing = requestsByDigest.get(recorded.actionRequestDigest);
	if (existing) {
		if (existing.actionRequestRef !== recorded.actionRequestRef) {
			throw new TypeError(
				"durable action recovery returned duplicate action-request digests with different references.",
			);
		}
		return;
	}
	const actionKey = governedActionRequestKey(recorded.actionRequest);
	const knownActionDigest = requestDigestsByAction.get(actionKey);
	if (
		knownActionDigest !== undefined &&
		knownActionDigest !== recorded.actionRequestDigest
	) {
		throw new TypeError(
			"durable action recovery returned conflicting requests for the same governed action id.",
		);
	}
	const idempotencyKey = governedActionIdempotencyKey(recorded.actionRequest);
	const knownIdempotencyDigest =
		requestDigestsByIdempotency.get(idempotencyKey);
	if (
		knownIdempotencyDigest !== undefined &&
		knownIdempotencyDigest !== recorded.actionRequestDigest
	) {
		throw new TypeError(
			"durable action recovery returned one idempotency key bound to different action ids.",
		);
	}
	requestsByDigest.set(recorded.actionRequestDigest, recorded);
	requestDigestsByAction.set(actionKey, recorded.actionRequestDigest);
	requestDigestsByIdempotency.set(idempotencyKey, recorded.actionRequestDigest);
}

function registerRecoveredActionReceipt(
	recorded: RecordedGovernedActionReceipt,
	receiptsByRequestDigest: Map<string, RecordedGovernedActionReceipt>,
	receiptsByRef: Map<string, RecordedGovernedActionReceipt>,
): void {
	const requestDigest = recorded.receipt.actionRequestDigest;
	const existing = receiptsByRequestDigest.get(requestDigest);
	if (existing) {
		if (
			existing.fingerprint !== recorded.fingerprint ||
			existing.receipt.actionReceiptRef !== recorded.receipt.actionReceiptRef ||
			existing.actionReceiptDigest !== recorded.actionReceiptDigest
		) {
			throw new TypeError(
				"durable action recovery returned conflicting terminal receipts for one write-ahead action.",
			);
		}
		return;
	}
	const byRef = receiptsByRef.get(recorded.receipt.actionReceiptRef);
	if (byRef && byRef.receipt.actionRequestDigest !== requestDigest) {
		throw new TypeError(
			"durable action recovery returned one receipt reference for different actions.",
		);
	}
	receiptsByRequestDigest.set(requestDigest, recorded);
	receiptsByRef.set(recorded.receipt.actionReceiptRef, recorded);
}

function toActionKindWire(
	kind: KernelActionRequestedV2["actionKind"],
): ActionKindV1 {
	switch (kind) {
		case "filesystem":
			return ActionKindV1.Filesystem;
		case "process":
			return ActionKindV1.Process;
		case "git":
			return ActionKindV1.Git;
		case "model":
			return ActionKindV1.Model;
		case "network":
			return ActionKindV1.Network;
		case "secret":
			return ActionKindV1.Secret;
		case "mcp":
			return ActionKindV1.Mcp;
		case "a2a":
			return ActionKindV1.A2a;
		case "external_service":
			return ActionKindV1.ExternalService;
	}
}

function toExecutionRoleWire(
	role: KernelActionRequestedV2["executionRole"],
): ExecutionRoleV1 {
	switch (role) {
		case "implementer":
			return ExecutionRoleV1.Implementer;
		case "reviewer":
			return ExecutionRoleV1.Reviewer;
		case "adversary":
			return ExecutionRoleV1.Adversary;
		case "judge":
			return ExecutionRoleV1.Judge;
		case "candidate":
			return ExecutionRoleV1.Candidate;
	}
}

function toActionReceiptOutcomeWire(
	outcome: KernelActionReceiptRecordedV2["outcome"],
): ActionReceiptOutcomeV2 {
	switch (outcome) {
		case "succeeded":
			return ActionReceiptOutcomeV2.Succeeded;
		case "failed":
			return ActionReceiptOutcomeV2.Failed;
		case "denied":
			return ActionReceiptOutcomeV2.Denied;
		case "unknown":
			return ActionReceiptOutcomeV2.Unknown;
	}
}

function governedActionRequestKey(request: KernelActionRequestedV2): string {
	return digest({
		dispatchScope: governedActionDispatchScopeKey(
			governedActionDispatchScopeFromRequest(request),
		),
		actionId: request.actionId,
	});
}

function governedActionIdempotencyKey(
	request: KernelActionRequestedV2,
): string {
	return digest({
		dispatchScope: governedActionDispatchScopeKey(
			governedActionDispatchScopeFromRequest(request),
		),
		idempotencyKey: request.idempotencyKey,
	});
}

function assertReceiptReferenceIsPortIssued(
	input: RecordActionReceiptV2Input,
): void {
	if (
		typeof input === "object" &&
		input !== null &&
		Object.hasOwn(input, "actionReceiptRef")
	) {
		throw new TypeError(
			"actionReceiptRef is assigned by the governed action-evidence port.",
		);
	}
}

function assertReceiptBindsRequest(
	receipt: KernelActionReceiptRecordedV2,
	request: RecordedGovernedActionRequest,
): void {
	if (
		receipt.actionRequestDigest !== request.actionRequestDigest ||
		receipt.runId !== request.actionRequest.runId ||
		receipt.workflowId !== request.actionRequest.workflowId ||
		receipt.unitId !== request.actionRequest.unitId ||
		receipt.attempt !== request.actionRequest.attempt ||
		receipt.provenanceRef !== request.actionRequest.provenanceRef ||
		receipt.actionId !== request.actionRequest.actionId ||
		receipt.idempotencyKey !== request.actionRequest.idempotencyKey ||
		receipt.dispatchEnvelopeDigest !==
			request.actionRequest.dispatchEnvelopeDigest ||
		receipt.capabilityBundleDigest !==
			request.actionRequest.capabilityBundleDigest ||
		receipt.policyDigest !== request.actionRequest.policyDigest ||
		receipt.contextManifestDigest !==
			request.actionRequest.contextManifestDigest ||
		receipt.workerManifestDigest !==
			request.actionRequest.workerManifestDigest ||
		receipt.sandboxProfileDigest !==
			request.actionRequest.sandboxProfileDigest ||
		receipt.authorityActor !== request.actionRequest.authorityActor ||
		receipt.executionRole !== request.actionRequest.executionRole
	) {
		throw new TypeError(
			"action receipt does not bind the exact previously flushed action request.",
		);
	}
}

function normalizeAndVerifyReceiptSetEntries(
	input: SealActionReceiptSetV1Input,
	receiptsByRef: ReadonlyMap<string, RecordedGovernedActionReceipt>,
): readonly KernelActionReceiptSetEntryV1[] {
	if (!Array.isArray(input.receipts)) {
		throw new TypeError("action receipt set receipts must be an array.");
	}
	const actionIds = new Set<string>();
	const refs = new Set<string>();
	const digests = new Set<string>();
	const entries: KernelActionReceiptSetEntryV1[] = [];
	for (let index = 0; index < input.receipts.length; index += 1) {
		if (!Object.hasOwn(input.receipts, index)) {
			throw new TypeError("action receipt set receipts must not be sparse.");
		}
		const entry = input.receipts[index];
		if (!entry || typeof entry !== "object") {
			throw new TypeError(
				`action receipt set entry ${index} must be an object.`,
			);
		}
		const actionId = requireAsciiActionId(
			entry.actionId,
			`receipts[${index}].actionId`,
		);
		const actionReceiptRef = requireNonEmpty(
			entry.actionReceiptRef,
			`receipts[${index}].actionReceiptRef`,
		);
		const actionReceiptDigest = canonicalDigest(
			entry.actionReceiptDigest,
			`receipts[${index}].actionReceiptDigest`,
		);
		if (
			actionIds.has(actionId) ||
			refs.has(actionReceiptRef) ||
			digests.has(actionReceiptDigest)
		) {
			throw new TypeError(
				"action receipt set entries must have unique action ids, references, and digests.",
			);
		}
		actionIds.add(actionId);
		refs.add(actionReceiptRef);
		digests.add(actionReceiptDigest);

		const recorded = receiptsByRef.get(actionReceiptRef);
		if (!recorded) {
			throw new Error(
				"action receipt set references an unknown or not-yet-durable receipt.",
			);
		}
		if (
			recorded.receipt.actionId !== actionId ||
			recorded.actionReceiptDigest !== actionReceiptDigest
		) {
			throw new TypeError(
				"action receipt set entry conflicts with the durable receipt reference.",
			);
		}
		if (recorded.receipt.outcome === "unknown") {
			throw new TypeError(
				"action receipt set cannot seal an unknown action outcome; reconciliation is required.",
			);
		}
		if (
			recorded.receipt.runId !== input.runId ||
			recorded.receipt.workflowId !== input.workflowId ||
			recorded.receipt.unitId !== input.unitId ||
			recorded.receipt.attempt !== input.attempt ||
			recorded.receipt.provenanceRef !== input.provenanceRef ||
			recorded.receipt.dispatchEnvelopeDigest !== input.dispatchEnvelopeDigest
		) {
			throw new TypeError(
				"action receipt set entry does not belong to the requested governed dispatch.",
			);
		}
		entries.push({ actionId, actionReceiptRef, actionReceiptDigest });
	}
	return entries.sort((left, right) =>
		compareAsciiActionIds(left.actionId, right.actionId),
	);
}

function assertReceiptSetContainsEveryTerminalAction(
	set: Pick<
		KernelActionReceiptSetRecordedV1,
		| "runId"
		| "workflowId"
		| "unitId"
		| "attempt"
		| "provenanceRef"
		| "dispatchEnvelopeDigest"
	>,
	entries: readonly KernelActionReceiptSetEntryV1[],
	requestsByDigest: ReadonlyMap<string, RecordedGovernedActionRequest>,
	receiptsByRequestDigest: ReadonlyMap<string, RecordedGovernedActionReceipt>,
): void {
	const scope = governedActionDispatchScopeFromReceiptSet(set);
	const expected = [...requestsByDigest.values()]
		.filter(
			(request) =>
				governedActionDispatchScopeKey(
					governedActionDispatchScopeFromRequest(request.actionRequest),
				) === governedActionDispatchScopeKey(scope),
		)
		.sort((left, right) =>
			compareAsciiActionIds(
				left.actionRequest.actionId,
				right.actionRequest.actionId,
			),
		);
	const suppliedByActionId = new Map(
		entries.map((entry) => [entry.actionId, entry] as const),
	);
	if (suppliedByActionId.size !== expected.length) {
		throw new TypeError(
			"action receipt set must represent every terminal action for the governed dispatch exactly once.",
		);
	}
	for (const request of expected) {
		const receipt = receiptsByRequestDigest.get(request.actionRequestDigest);
		if (!receipt) {
			throw new Error(
				"action receipt set cannot seal while action effects remain pending.",
			);
		}
		if (receipt.receipt.outcome === "unknown") {
			throw new Error(
				"action receipt set cannot seal while an action outcome is unknown; reconciliation is required.",
			);
		}
		const supplied = suppliedByActionId.get(request.actionRequest.actionId);
		if (
			!supplied ||
			supplied.actionReceiptRef !== receipt.receipt.actionReceiptRef ||
			supplied.actionReceiptDigest !== receipt.actionReceiptDigest
		) {
			throw new TypeError(
				"action receipt set does not exactly bind every known terminal action receipt for the governed dispatch.",
			);
		}
	}
}

function buildActionReceiptSetRecord(
	fields: ActionReceiptSetFields,
	actionReceiptSetRef: string,
	receipts: readonly KernelActionReceiptSetEntryV1[],
): KernelActionReceiptSetRecordedV1 {
	const withoutDigest: Omit<
		KernelActionReceiptSetRecordedV1,
		"actionReceiptSetDigest"
	> = {
		schemaVersion: 1,
		runId: fields.runId,
		workflowId: fields.workflowId,
		unitId: fields.unitId,
		attempt: fields.attempt,
		provenanceRef: fields.provenanceRef,
		dispatchEnvelopeDigest: fields.dispatchEnvelopeDigest,
		actionReceiptSetRef,
		receipts: [...receipts],
		sealedAt: fields.sealedAt,
	};
	return parseActionReceiptSetRecordedV1({
		...withoutDigest,
		actionReceiptSetDigest:
			canonicalActionReceiptSetRecordedV1Digest(withoutDigest),
	});
}

function governedActionReceiptSetScopeKey(
	set: KernelActionReceiptSetRecordedV1,
): string {
	return governedActionDispatchScopeKey(
		governedActionDispatchScopeFromReceiptSet(set),
	);
}

function governedActionReceiptSetFingerprint(
	set: KernelActionReceiptSetRecordedV1,
): string {
	return digest({
		runId: set.runId,
		workflowId: set.workflowId,
		unitId: set.unitId,
		attempt: set.attempt,
		provenanceRef: set.provenanceRef,
		dispatchEnvelopeDigest: set.dispatchEnvelopeDigest,
		receipts: set.receipts.map((receipt) => ({
			actionId: receipt.actionId,
			actionReceiptRef: receipt.actionReceiptRef,
			actionReceiptDigest: receipt.actionReceiptDigest,
		})),
	});
}

function assertCandidateBindsReceiptSet(
	candidate: KernelCandidateCreatedV2,
	receiptSet: KernelActionReceiptSetRecordedV1,
): void {
	if (
		candidate.actionReceiptSetDigest !== receiptSet.actionReceiptSetDigest ||
		candidate.runId !== receiptSet.runId ||
		candidate.workflowId !== receiptSet.workflowId ||
		candidate.unitId !== receiptSet.unitId ||
		candidate.attempt !== receiptSet.attempt ||
		candidate.provenanceRef !== receiptSet.provenanceRef ||
		candidate.envelopeDigest !== receiptSet.dispatchEnvelopeDigest
	) {
		throw new TypeError(
			"CandidateCreatedV2 does not bind the exact previously sealed action receipt set.",
		);
	}
}

function governedCandidateIdentityKey(
	candidate: KernelCandidateCreatedV2,
): string {
	return digest({ runId: candidate.runId, candidateId: candidate.candidateId });
}
