import { isAbsolute } from "node:path";
import {
	type ActionReceiptRecordedV2,
	type ActionReceiptSetRecordedV1,
	type ActionRequestedV2,
	canonicalActionReceiptRecordedV2Digest,
	canonicalActionRequestedV2Digest,
	canonicalCandidateCompletionRecordedV1Digest,
	type DispatchBudgetV1,
	type DurableActionReceiptV2,
	type DurableActionRequestV2,
	type GovernedDispatchLineageV3,
	parseActionReceiptRecordedV2,
	parseActionReceiptSetRecordedV1,
	parseActionRequestedV2,
	parseCandidateCompletionRecordedV1,
	parseCandidateCreatedV2,
} from "@buildplane/kernel";
import {
	GOVERNED_AUTHORITY_BROKER_REQUIRED,
	type TrustedGovernedLedgerAuthorityRealmV1,
} from "./governed-ledger-authority.js";
import { deriveGovernedDispatchPolicyDigestV1 } from "./governed-policy-binding.js";
import type { GovernedActivityClaimReferenceResolver } from "./ledger-activity-claim-port.js";
import type { TrustedGovernedLedgerBinary } from "./ledger-emit.js";
import {
	assertCandidateCompletionBindsRecovery,
	type GovernedActionEvidenceRecoveryResolver,
	type GovernedActionEvidenceRecoverySnapshot,
	type GovernedRecoveredActivityClaimV1,
	type GovernedRecoveredCandidateCompletionV1,
} from "./ledger-trust-spine-port.js";

const EVENT_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CANONICAL_U64_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const MAX_U64_DECIMAL = "18446744073709551615";
const NATIVE_RECOVERY_FIELDS = [
	"phase",
	"requests",
	"activity_claims",
	"receipts",
	"receipt_set",
	"candidates",
	"candidate_completion",
	"acceptance",
	"reviews",
	"promotion_approval",
	"promotion",
	"terminal",
	"timers",
	"cancellation",
	"pending_action_ids",
	"unknown_action_ids",
	"failed_action_ids",
] as const;
const NATIVE_RECOVERY_REQUIRED_FIELDS = NATIVE_RECOVERY_FIELDS.filter(
	(field) => field !== "promotion_approval" && field !== "candidate_completion",
);

/**
 * The native resolver is the only supported bridge from a signed tape event
 * to a V3 execution lineage. A JSON envelope on disk is intentionally not an
 * input here: callers name a concrete tape event and an explicitly configured
 * local kernel key instead.
 */
export interface ResolveNativeGovernedDispatchV3Input {
	readonly workspace: string;
	readonly projectRoot: string;
	readonly runId: string;
	readonly dispatchEventRef: string;
	readonly kernelActorId: string;
	readonly kernelKeyId: string;
}

export interface NativeGovernedDispatchCommandResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly error?: string;
}

export interface CreateNativeGovernedDispatchResolverOptions
	extends ResolveNativeGovernedDispatchV3Input {
	/**
	 * Explicit package-owned binary identity for a longer-lived governed
	 * session. It is rechecked before every resolver call.
	 */
	readonly trustedBinary?: TrustedGovernedLedgerBinary;
}

/**
 * Closed context for parsing a committed native resolver fixture in tests.
 * This carries only the identity that the fixture must prove; it deliberately
 * has no subprocess, binary, authority-realm, or recovery-port surface.
 */
export interface TestOnlyNativeGovernedDispatchSnapshotContext {
	readonly runId: string;
	readonly dispatchEventRef: string;
	readonly kernelActorId: string;
	readonly kernelKeyId: string;
}

/**
 * A verified V3 dispatch plus its deliberately narrow recovery ports. The
 * ports re-query native replay for every lookup that can race with a newly
 * flushed event, so a process-local map can never become recovery authority.
 */
export interface NativeGovernedDispatchResolution {
	/** Present only for the production package-pinned resolver. */
	readonly authorityRealm?: TrustedGovernedLedgerAuthorityRealmV1;
	readonly recoveryResolver: GovernedActionEvidenceRecoveryResolver;
	readonly activityClaimReferences: GovernedActivityClaimReferenceResolver;
	/** Fresh verified projection; intended for blocked/resume diagnostics. */
	resolveCurrent(): Promise<ResolvedGovernedDispatchSnapshot>;
}

export interface ResolvedGovernedDispatchSnapshot {
	readonly dispatch: GovernedDispatchLineageV3;
	readonly recovery: GovernedActionEvidenceRecoverySnapshot;
	readonly phase: string;
	/**
	 * Persisted operator work item, present only while the signed reducer is
	 * awaiting a durable decision. This is status data only.
	 */
	readonly promotionApproval?: GovernedPromotionApprovalHandoffStatusV1;
	/**
	 * Signed reducer lifecycle facts for status and blocked-resume diagnostics.
	 * They deliberately expose no emitter, lease, or execution capability.
	 */
	readonly lifecycle: GovernedWorkflowLifecycleStatusV1;
	readonly pendingActionIds: readonly string[];
	readonly unknownActionIds: readonly string[];
	readonly failedActionIds: readonly string[];
}

export interface GovernedWorkflowTimerFiringStatusV1 {
	readonly eventRef: string;
	readonly eventDigest: string;
	readonly timerScheduleEventRef: string;
	readonly timerScheduleEventDigest: string;
	readonly firedBy: string;
	readonly firedAt: string;
}

export interface GovernedWorkflowTimerStatusV1 {
	readonly eventRef: string;
	readonly eventDigest: string;
	readonly timerId: string;
	readonly timerKind: "workflow_deadline";
	readonly dueAt: string;
	readonly idempotencyKey: string;
	readonly scheduledBy: string;
	readonly scheduledAt: string;
	readonly fired?: GovernedWorkflowTimerFiringStatusV1;
}

export interface GovernedWorkflowCancellationStatusV1 {
	readonly eventRef: string;
	readonly eventDigest: string;
	readonly cancellationId: string;
	readonly cause: "operator_requested" | "timer_elapsed";
	readonly timerFiredEventRef?: string;
	readonly timerFiredEventDigest?: string;
	readonly requestedBy: string;
	readonly idempotencyKey: string;
	readonly requestedAt: string;
}

/**
 * Pure status projection. Its contents explain why a future broker-owned
 * resume must reconcile; they are never execution or promotion authority.
 */
export interface GovernedWorkflowLifecycleStatusV1 {
	readonly timers: readonly GovernedWorkflowTimerStatusV1[];
	readonly cancellation?: GovernedWorkflowCancellationStatusV1;
}

/**
 * Read-only projection of a kernel-signed promotion approval request. It has
 * no decision, execution, retry, resolver, or authority surface: action
 * recovery and promotion remain blocked until a separate durable decision is
 * independently verified by the governed reducer.
 */
export interface GovernedPromotionApprovalHandoffStatusV1 {
	readonly state: "operator_decision_required";
	readonly authority: "none";
	readonly eventRef: string;
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
 * Policy is not a field of the native V3 dispatch body. We therefore never
 * accept it as a caller-selected execution value. Instead the action-plane
 * binding is deterministically derived from the signed acceptance contract
 * digest. This is a temporary V3 compatibility projection; a future native
 * dispatch revision can carry an independently signed policy manifest digest.
 */
export const governedPolicyDigestForAcceptanceContract =
	deriveGovernedDispatchPolicyDigestV1;

/**
 * Construct the production resolver. This fails closed before a local native
 * process can be spawned: a same-UID subprocess cannot be a governed
 * authority broker. The test-only parser below returns status data only and
 * cannot manufacture a callable authority surface.
 */
export function createNativeGovernedDispatchResolver(
	options: CreateNativeGovernedDispatchResolverOptions,
): NativeGovernedDispatchResolution {
	normalizeProductionResolverOptions(options);
	throw new Error(GOVERNED_AUTHORITY_BROKER_REQUIRED);
}

/**
 * Parse a committed native-resolution fixture into untrusted status data.
 *
 * This deliberately does not construct a resolver, a recovery port, action
 * reference port, binary invocation, or authority realm. It exists solely so
 * tests can exercise the closed native wire contract without manufacturing a
 * callable authority object from an arbitrary runner.
 *
 * @internal Test-only fixture parser; never a production authority route.
 */
export function __testOnlyParseNativeGovernedDispatchSnapshot(
	text: string,
	context: TestOnlyNativeGovernedDispatchSnapshotContext,
): ResolvedGovernedDispatchSnapshot {
	return parseNativeResolution(text, normalizeTestSnapshotContext(context));
}

type NormalizedResolverConfig = Required<ResolveNativeGovernedDispatchV3Input>;

function normalizeProductionResolverOptions(
	input: CreateNativeGovernedDispatchResolverOptions,
): NormalizedResolverConfig & {
	readonly trustedBinary?: TrustedGovernedLedgerBinary;
} {
	assertClosedResolverOptions(input, "createNativeGovernedDispatchResolver", [
		"workspace",
		"projectRoot",
		"runId",
		"dispatchEventRef",
		"kernelActorId",
		"kernelKeyId",
		"trustedBinary",
	]);
	return Object.freeze({
		...normalizeResolverInput(input),
		...(input.trustedBinary === undefined
			? {}
			: { trustedBinary: input.trustedBinary }),
	});
}

function normalizeTestSnapshotContext(
	input: TestOnlyNativeGovernedDispatchSnapshotContext,
): Required<
	Pick<
		ResolveNativeGovernedDispatchV3Input,
		"runId" | "dispatchEventRef" | "kernelActorId" | "kernelKeyId"
	>
> {
	assertClosedResolverOptions(
		input,
		"__testOnlyParseNativeGovernedDispatchSnapshot",
		["runId", "dispatchEventRef", "kernelActorId", "kernelKeyId"],
	);
	return Object.freeze({
		runId: requireEventId(input.runId, "runId"),
		dispatchEventRef: requireEventId(
			input.dispatchEventRef,
			"dispatchEventRef",
		),
		kernelActorId: requireNonEmpty(input.kernelActorId, "kernelActorId"),
		kernelKeyId: requireNonEmpty(input.kernelKeyId, "kernelKeyId"),
	});
}

function normalizeResolverInput(
	input: ResolveNativeGovernedDispatchV3Input,
): NormalizedResolverConfig {
	if (!input || typeof input !== "object") {
		throw new TypeError(
			"governed dispatch resolver requires an explicit resolver configuration.",
		);
	}
	if (!isAbsolute(input.workspace) || input.workspace.includes("\0")) {
		throw new TypeError(
			"governed dispatch resolver workspace must be an absolute path.",
		);
	}
	if (!isAbsolute(input.projectRoot) || input.projectRoot.includes("\0")) {
		throw new TypeError(
			"governed dispatch resolver projectRoot must be an absolute path.",
		);
	}
	return Object.freeze({
		workspace: input.workspace,
		projectRoot: input.projectRoot,
		runId: requireEventId(input.runId, "runId"),
		dispatchEventRef: requireEventId(
			input.dispatchEventRef,
			"dispatchEventRef",
		),
		kernelActorId: requireNonEmpty(input.kernelActorId, "kernelActorId"),
		kernelKeyId: requireNonEmpty(input.kernelKeyId, "kernelKeyId"),
	});
}

function assertClosedResolverOptions(
	input: unknown,
	label: string,
	allowedFields: readonly string[],
): asserts input is Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new TypeError(`${label} requires an options object.`);
	}
	const allowed = new Set(allowedFields);
	for (const field of Object.getOwnPropertyNames(input)) {
		if (!allowed.has(field)) {
			throw new TypeError(`${label} contains unsupported field ${field}.`);
		}
	}
}

function parseNativeResolution(
	text: string,
	config: Required<
		Pick<
			ResolveNativeGovernedDispatchV3Input,
			"runId" | "dispatchEventRef" | "kernelActorId" | "kernelKeyId"
		>
	>,
): ResolvedGovernedDispatchSnapshot {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new TypeError(
			`trusted governed dispatch resolver returned invalid JSON: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	const root = closedRecord(raw, "governed dispatch resolution", [
		"schema_version",
		"dispatch_event_ref",
		"trusted_kernel_signer",
		"dispatch",
		"tape_integrity",
		"recovery",
	]);
	if (root.schema_version !== 1) {
		throw new TypeError(
			"governed dispatch resolution schema_version must be 1.",
		);
	}
	if (
		requireEventId(root.dispatch_event_ref, "dispatch_event_ref") !==
		config.dispatchEventRef
	) {
		throw new TypeError(
			"trusted governed dispatch resolution did not return the requested dispatch event.",
		);
	}
	parseTrustedKernelSigner(root.trusted_kernel_signer, config);
	const dispatch = parseNativeDispatch(
		root.dispatch,
		config.runId,
		config.dispatchEventRef,
		config.kernelActorId,
	);
	parseNativeTapeIntegrity(root.tape_integrity);
	const recovery = parseNativeRecovery(root.recovery, dispatch);
	return {
		dispatch,
		recovery: recovery.snapshot,
		phase: recovery.phase,
		...(recovery.promotionApproval === undefined
			? {}
			: { promotionApproval: recovery.promotionApproval }),
		lifecycle: recovery.lifecycle,
		pendingActionIds: recovery.pendingActionIds,
		unknownActionIds: recovery.unknownActionIds,
		failedActionIds: recovery.failedActionIds,
	};
}

/**
 * Validate the native V1 tape-integrity attestation carried by every sealed
 * V3 governed-resolution response. The Rust resolver is the authority that
 * verifies the checkpoint and recomputes the root against its immutable tape
 * snapshot; this TypeScript boundary intentionally validates the closed wire
 * contract rather than pretending it can reconstruct that proof without the
 * full verified tape.
 */
function parseNativeTapeIntegrity(value: unknown): void {
	const report = closedRecord(value, "tape_integrity", [
		"schema_version",
		"checkpoint_event_ref",
		"checkpoint_event_digest",
		"through_event_ref",
		"signed_non_checkpoint_event_count",
		"tape_root_hash",
		"algorithm",
	]);
	if (report.schema_version !== 1) {
		throw new TypeError("tape_integrity.schema_version must be 1.");
	}
	requireEventId(
		report.checkpoint_event_ref,
		"tape_integrity.checkpoint_event_ref",
	);
	requireDigest(
		report.checkpoint_event_digest,
		"tape_integrity.checkpoint_event_digest",
	);
	requireEventId(report.through_event_ref, "tape_integrity.through_event_ref");
	// Keep this as the native protocol's canonical decimal string. JavaScript
	// numbers cannot represent all u64 tape counts exactly, and rounding a
	// checkpoint coverage claim is never a safe compatibility fallback.
	requireCanonicalU64Decimal(
		report.signed_non_checkpoint_event_count,
		"tape_integrity.signed_non_checkpoint_event_count",
	);
	requireDigest(report.tape_root_hash, "tape_integrity.tape_root_hash");
	if (report.algorithm !== "sha256_linear") {
		throw new TypeError("tape_integrity.algorithm must be sha256_linear.");
	}
}

function parseTrustedKernelSigner(
	value: unknown,
	config: Pick<
		ResolveNativeGovernedDispatchV3Input,
		"kernelActorId" | "kernelKeyId"
	>,
): void {
	const signer = closedRecord(value, "trusted_kernel_signer", [
		"actor_id",
		"key_id",
		"public_key_hash",
	]);
	if (
		requireNonEmpty(signer.actor_id, "trusted_kernel_signer.actor_id") !==
			config.kernelActorId ||
		requireNonEmpty(signer.key_id, "trusted_kernel_signer.key_id") !==
			config.kernelKeyId
	) {
		throw new TypeError(
			"trusted governed dispatch resolver returned a signer different from the configured local kernel key.",
		);
	}
	if (signer.public_key_hash !== null && signer.public_key_hash !== undefined) {
		requireDigest(
			signer.public_key_hash,
			"trusted_kernel_signer.public_key_hash",
		);
	}
}

function parseNativeDispatch(
	value: unknown,
	expectedRunId: string,
	dispatchEventRef: string,
	authorityActor: string,
): GovernedDispatchLineageV3 {
	const dispatch = closedRecord(
		value,
		"resolved dispatch",
		[
			"run_id",
			"workflow_id",
			"workflow_revision",
			"unit_id",
			"attempt",
			"dispatch_version",
			"event_id",
			"envelope_digest",
			"provenance_ref",
			"base_commit_sha",
			"capability_bundle_digest",
			"acceptance_contract_digest",
			"context_manifest_digest",
			"worker_manifest_digest",
			"sandbox_profile_digest",
			"repository_binding_digest",
			"ledger_authority_realm_digest",
			"governed_packet_digest",
			"execution_role",
			"commit_mode",
			"budget",
			"trust_tier",
			"idempotency_key",
			"issued_at",
			"expires_at",
			"signature_ref",
			"action_evidence_version",
		],
		[
			"run_id",
			"workflow_id",
			"workflow_revision",
			"unit_id",
			"attempt",
			"dispatch_version",
			"event_id",
			"envelope_digest",
			"provenance_ref",
			"base_commit_sha",
			"capability_bundle_digest",
			"acceptance_contract_digest",
			"context_manifest_digest",
			"worker_manifest_digest",
			"sandbox_profile_digest",
			"repository_binding_digest",
			"ledger_authority_realm_digest",
			"governed_packet_digest",
			"execution_role",
			"commit_mode",
			"budget",
			"trust_tier",
			"idempotency_key",
			"issued_at",
			"expires_at",
			"action_evidence_version",
		],
	);
	if (dispatch.dispatch_version !== 3) {
		throw new TypeError("resolved dispatch must have dispatch_version 3.");
	}
	if (
		requireEventId(dispatch.run_id, "dispatch.run_id") !== expectedRunId ||
		requireEventId(dispatch.event_id, "dispatch.event_id") !== dispatchEventRef
	) {
		throw new TypeError(
			"resolved dispatch run/event identity did not match the trusted native query.",
		);
	}
	if (dispatch.action_evidence_version !== "sealed_v3") {
		throw new TypeError(
			"resolved dispatch must bind sealed_v3 action evidence.",
		);
	}
	if (dispatch.commit_mode !== "atomic") {
		throw new TypeError(
			"UNSUPPORTED_COMMIT_MODE: governed dispatch requires atomic.",
		);
	}
	if (dispatch.trust_tier !== "governed") {
		throw new TypeError("resolved dispatch trust_tier must be governed.");
	}
	const issuedAt = requireTimestamp(dispatch.issued_at, "dispatch.issued_at");
	const expiresAt = requireTimestamp(
		dispatch.expires_at,
		"dispatch.expires_at",
	);
	if (
		Date.parse(issuedAt) >= Date.parse(expiresAt) ||
		Date.parse(expiresAt) <= Date.now()
	) {
		throw new TypeError(
			"resolved governed dispatch is expired or has an invalid authority window.",
		);
	}
	const executionRole = requireRole(
		dispatch.execution_role,
		"dispatch.execution_role",
	);
	const acceptanceContractDigest = requireDigest(
		dispatch.acceptance_contract_digest,
		"dispatch.acceptance_contract_digest",
	);
	return Object.freeze({
		schemaVersion: 3,
		runId: expectedRunId,
		workflowId: requireNonEmpty(dispatch.workflow_id, "dispatch.workflow_id"),
		workflowRevision: requireNonEmpty(
			dispatch.workflow_revision,
			"dispatch.workflow_revision",
		),
		unitId: requireNonEmpty(dispatch.unit_id, "dispatch.unit_id"),
		attempt: requirePositiveInteger(dispatch.attempt, "dispatch.attempt"),
		provenanceRef: requireNonEmpty(
			dispatch.provenance_ref,
			"dispatch.provenance_ref",
		),
		dispatchEnvelopeRef: dispatchEventRef,
		envelopeDigest: requireDigest(
			dispatch.envelope_digest,
			"dispatch.envelope_digest",
		),
		baseCommitSha: requireCommitSha(
			dispatch.base_commit_sha,
			"dispatch.base_commit_sha",
		),
		executionRole,
		commitMode: "atomic",
		trustTier: "governed",
		capabilityBundleDigest: requireDigest(
			dispatch.capability_bundle_digest,
			"dispatch.capability_bundle_digest",
		),
		acceptanceContractDigest,
		policyDigest: governedPolicyDigestForAcceptanceContract(
			acceptanceContractDigest,
		),
		contextManifestDigest: requireDigest(
			dispatch.context_manifest_digest,
			"dispatch.context_manifest_digest",
		),
		workerManifestDigest: requireDigest(
			dispatch.worker_manifest_digest,
			"dispatch.worker_manifest_digest",
		),
		sandboxProfileDigest: requireDigest(
			dispatch.sandbox_profile_digest,
			"dispatch.sandbox_profile_digest",
		),
		repositoryBindingDigest: requireDigest(
			dispatch.repository_binding_digest,
			"dispatch.repository_binding_digest",
		),
		ledgerAuthorityRealmDigest: requireDigest(
			dispatch.ledger_authority_realm_digest,
			"dispatch.ledger_authority_realm_digest",
		),
		governedPacketDigest: requireDigest(
			dispatch.governed_packet_digest,
			"dispatch.governed_packet_digest",
		),
		budget: parseNativeBudget(dispatch.budget),
		idempotencyKey: requireNonEmpty(
			dispatch.idempotency_key,
			"dispatch.idempotency_key",
		),
		authorityActor,
		actionEvidenceVersion: "sealed_v3",
		issuedAt,
		expiresAt,
	});
}

function parseNativeBudget(value: unknown): DispatchBudgetV1 {
	const budget = closedRecord(value, "dispatch.budget", [
		"max_tokens",
		"max_compute_time_ms",
	]);
	const maxTokens = optionalPositiveInteger(
		budget.max_tokens,
		"budget.max_tokens",
	);
	const maxComputeTimeMs = optionalPositiveInteger(
		budget.max_compute_time_ms,
		"budget.max_compute_time_ms",
	);
	return Object.freeze({
		...(maxTokens === undefined ? {} : { maxTokens }),
		...(maxComputeTimeMs === undefined ? {} : { maxComputeTimeMs }),
	});
}

function parseNativeRecovery(
	value: unknown,
	dispatch: GovernedDispatchLineageV3,
): {
	readonly snapshot: GovernedActionEvidenceRecoverySnapshot;
	readonly phase: string;
	readonly promotionApproval?: GovernedPromotionApprovalHandoffStatusV1;
	readonly lifecycle: GovernedWorkflowLifecycleStatusV1;
	readonly pendingActionIds: readonly string[];
	readonly unknownActionIds: readonly string[];
	readonly failedActionIds: readonly string[];
} {
	const recovery = closedRecord(
		value,
		"governed recovery",
		NATIVE_RECOVERY_FIELDS,
		NATIVE_RECOVERY_REQUIRED_FIELDS,
	);
	const phase = requireWorkflowPhase(recovery.phase);
	const lifecycle = parseNativeLifecycle(
		recovery.timers,
		recovery.cancellation,
		dispatch,
		phase,
	);
	const promotionApproval = parseNativePromotionApprovalHandoff(
		recovery.promotion_approval,
		phase,
		dispatch,
	);
	const requests = parseNativeRequests(recovery.requests, dispatch);
	const receipts = parseNativeReceipts(recovery.receipts, dispatch, requests);
	const receiptSet =
		recovery.receipt_set === null || recovery.receipt_set === undefined
			? undefined
			: parseNativeReceiptSet(recovery.receipt_set, dispatch);
	const candidates = parseNativeCandidates(recovery.candidates, dispatch);
	const activityClaims = parseNativeActivityClaims(
		recovery.activity_claims,
		dispatch,
		requests,
	);
	const candidateCompletion =
		recovery.candidate_completion === null ||
		recovery.candidate_completion === undefined
			? undefined
			: parseNativeCandidateCompletion(
					recovery.candidate_completion,
					dispatch,
					candidates,
				);
	if (phase === "promotion_approval_pending") {
		if (promotionApproval === undefined) {
			throw new Error(
				"governed recovery reports promotion_approval_pending without its approval evidence; action recovery is blocked.",
			);
		}
		validatePendingPromotionApprovalRecoveryProjection({
			approval: promotionApproval,
			dispatch,
			candidates,
			candidateCompletion,
			acceptance: recovery.acceptance,
			reviews: recovery.reviews,
			promotion: recovery.promotion,
			terminal: recovery.terminal,
		});
	} else {
		// These fields are not needed to authorize an action, but silently
		// ignoring a newer native projection would be authority drift. Outside
		// the one dedicated pending-approval status path, later semantic state
		// remains deliberately blocked until its reducer view is wired.
		assertNoUnsupportedTerminalProjection(
			recovery.acceptance,
			recovery.reviews,
			recovery.promotion,
			recovery.terminal,
		);
	}
	const pendingActionIds = parseActionIds(
		recovery.pending_action_ids,
		"pending_action_ids",
	);
	const unknownActionIds = parseActionIds(
		recovery.unknown_action_ids,
		"unknown_action_ids",
	);
	const failedActionIds = parseActionIds(
		recovery.failed_action_ids,
		"failed_action_ids",
	);
	const snapshot: GovernedActionEvidenceRecoverySnapshot = Object.freeze({
		dispatchPolicyDigest: dispatch.policyDigest,
		requests,
		receipts,
		...(receiptSet === undefined ? {} : { receiptSet }),
		candidates,
		...(activityClaims.length === 0 ? {} : { activityClaims }),
		...(candidateCompletion === undefined ? {} : { candidateCompletion }),
	});
	if (candidateCompletion !== undefined) {
		assertCandidateCompletionBindsRecovery(
			snapshot,
			{
				runId: dispatch.runId,
				workflowId: dispatch.workflowId,
				unitId: dispatch.unitId,
				attempt: dispatch.attempt,
				provenanceRef: dispatch.provenanceRef,
				dispatchEnvelopeDigest: dispatch.envelopeDigest,
			},
			candidateCompletion.completion,
		);
	}
	return {
		phase,
		...(promotionApproval === undefined ? {} : { promotionApproval }),
		lifecycle,
		pendingActionIds,
		unknownActionIds,
		failedActionIds,
		snapshot,
	};
}

function parseNativeLifecycle(
	timersValue: unknown,
	cancellationValue: unknown,
	dispatch: GovernedDispatchLineageV3,
	phase: string,
): GovernedWorkflowLifecycleStatusV1 {
	const timers = parseNativeTimers(timersValue, dispatch);
	const cancellation = parseNativeCancellation(
		cancellationValue,
		timers,
		dispatch,
	);
	if (phase === "cancellation_requested" && cancellation === undefined) {
		throw new TypeError(
			"recovery.phase cancellation_requested requires exact cancellation evidence.",
		);
	}
	if (phase !== "cancellation_requested" && cancellation !== undefined) {
		throw new TypeError(
			"recovery.cancellation is only valid while recovery.phase is cancellation_requested.",
		);
	}
	return Object.freeze({
		timers,
		...(cancellation === undefined ? {} : { cancellation }),
	});
}

function parseNativeTimers(
	value: unknown,
	dispatch: GovernedDispatchLineageV3,
): readonly GovernedWorkflowTimerStatusV1[] {
	const seenTimerIds = new Set<string>();
	const seenScheduleEvents = new Set<string>();
	const seenFiringEvents = new Set<string>();
	return Object.freeze(
		requireArray(value, "recovery.timers").map((entry, index) => {
			const label = `recovery.timers[${index}]`;
			const timer = closedRecord(
				entry,
				label,
				[
					"event_id",
					"event_digest",
					"run_id",
					"workflow_id",
					"workflow_revision",
					"unit_id",
					"attempt",
					"dispatch_event_ref",
					"dispatch_envelope_digest",
					"timer_id",
					"timer_kind",
					"due_at",
					"idempotency_key",
					"scheduled_by",
					"scheduled_at",
					"fired",
				],
				[
					"event_id",
					"event_digest",
					"run_id",
					"workflow_id",
					"workflow_revision",
					"unit_id",
					"attempt",
					"dispatch_event_ref",
					"dispatch_envelope_digest",
					"timer_id",
					"timer_kind",
					"due_at",
					"idempotency_key",
					"scheduled_by",
					"scheduled_at",
				],
			);
			const eventRef = requireEventId(timer.event_id, `${label}.event_id`);
			if (seenScheduleEvents.has(eventRef)) {
				throw new TypeError(
					"recovery.timers contains duplicate schedule events.",
				);
			}
			seenScheduleEvents.add(eventRef);
			const timerId = requireNonEmpty(timer.timer_id, `${label}.timer_id`);
			if (seenTimerIds.has(timerId)) {
				throw new TypeError("recovery.timers contains duplicate timer ids.");
			}
			seenTimerIds.add(timerId);
			if (
				requireNonEmpty(timer.run_id, `${label}.run_id`) !== dispatch.runId ||
				requireNonEmpty(timer.workflow_id, `${label}.workflow_id`) !==
					dispatch.workflowId ||
				requireNonEmpty(
					timer.workflow_revision,
					`${label}.workflow_revision`,
				) !== dispatch.workflowRevision ||
				requireNonEmpty(timer.unit_id, `${label}.unit_id`) !==
					dispatch.unitId ||
				requirePositiveInteger(timer.attempt, `${label}.attempt`) !==
					dispatch.attempt ||
				requireEventId(
					timer.dispatch_event_ref,
					`${label}.dispatch_event_ref`,
				) !== dispatch.dispatchEnvelopeRef ||
				requireDigest(
					timer.dispatch_envelope_digest,
					`${label}.dispatch_envelope_digest`,
				) !== dispatch.envelopeDigest ||
				requireNonEmpty(timer.scheduled_by, `${label}.scheduled_by`) !==
					dispatch.authorityActor
			) {
				throw new TypeError(
					"recovered timer does not exactly match the verified governed dispatch.",
				);
			}
			if (timer.timer_kind !== "workflow_deadline") {
				throw new TypeError(`${label}.timer_kind is not supported.`);
			}
			const dueAt = requireTimestamp(timer.due_at, `${label}.due_at`);
			const scheduledAt = requireTimestamp(
				timer.scheduled_at,
				`${label}.scheduled_at`,
			);
			if (Date.parse(dueAt) < Date.parse(scheduledAt)) {
				throw new TypeError(`${label}.due_at precedes scheduled_at.`);
			}
			const status: GovernedWorkflowTimerStatusV1 = {
				eventRef,
				eventDigest: requireDigest(timer.event_digest, `${label}.event_digest`),
				timerId,
				timerKind: "workflow_deadline",
				dueAt,
				idempotencyKey: requireNonEmpty(
					timer.idempotency_key,
					`${label}.idempotency_key`,
				),
				scheduledBy: dispatch.authorityActor,
				scheduledAt,
			};
			if (timer.fired === undefined || timer.fired === null) {
				return Object.freeze(status);
			}
			const fired = parseNativeTimerFiring(
				timer.fired,
				label,
				status,
				dispatch,
				seenFiringEvents,
			);
			return Object.freeze({ ...status, fired });
		}),
	);
}

function parseNativeTimerFiring(
	value: unknown,
	timerLabel: string,
	timer: GovernedWorkflowTimerStatusV1,
	dispatch: GovernedDispatchLineageV3,
	seenFiringEvents: Set<string>,
): GovernedWorkflowTimerFiringStatusV1 {
	const fired = closedRecord(value, `${timerLabel}.fired`, [
		"event_id",
		"event_digest",
		"timer_schedule_event_ref",
		"timer_schedule_event_digest",
		"fired_by",
		"fired_at",
	]);
	const eventRef = requireEventId(
		fired.event_id,
		`${timerLabel}.fired.event_id`,
	);
	if (seenFiringEvents.has(eventRef)) {
		throw new TypeError("recovery.timers contains duplicate firing events.");
	}
	seenFiringEvents.add(eventRef);
	if (
		requireEventId(
			fired.timer_schedule_event_ref,
			`${timerLabel}.fired.timer_schedule_event_ref`,
		) !== timer.eventRef ||
		requireDigest(
			fired.timer_schedule_event_digest,
			`${timerLabel}.fired.timer_schedule_event_digest`,
		) !== timer.eventDigest ||
		requireNonEmpty(fired.fired_by, `${timerLabel}.fired.fired_by`) !==
			dispatch.authorityActor
	) {
		throw new TypeError(
			"recovered timer firing does not exactly bind its schedule and dispatch authority.",
		);
	}
	const firedAt = requireTimestamp(
		fired.fired_at,
		`${timerLabel}.fired.fired_at`,
	);
	if (Date.parse(firedAt) < Date.parse(timer.dueAt)) {
		throw new TypeError(`${timerLabel}.fired.fired_at precedes due_at.`);
	}
	return Object.freeze({
		eventRef,
		eventDigest: requireDigest(
			fired.event_digest,
			`${timerLabel}.fired.event_digest`,
		),
		timerScheduleEventRef: timer.eventRef,
		timerScheduleEventDigest: timer.eventDigest,
		firedBy: dispatch.authorityActor,
		firedAt,
	});
}

function parseNativeCancellation(
	value: unknown,
	timers: readonly GovernedWorkflowTimerStatusV1[],
	dispatch: GovernedDispatchLineageV3,
): GovernedWorkflowCancellationStatusV1 | undefined {
	if (value === undefined || value === null) return undefined;
	const cancellation = closedRecord(value, "recovery.cancellation", [
		"event_id",
		"event_digest",
		"cancellation_id",
		"cause",
		"timer_fired_event_ref",
		"timer_fired_event_digest",
		"requested_by",
		"idempotency_key",
		"requested_at",
	]);
	const cause = requireCancellationCause(cancellation.cause);
	const timerFiredEventRef = optionalEventId(
		cancellation.timer_fired_event_ref,
		"cancellation.timer_fired_event_ref",
	);
	const timerFiredEventDigest = optionalDigest(
		cancellation.timer_fired_event_digest,
		"cancellation.timer_fired_event_digest",
	);
	if (
		(timerFiredEventRef === undefined) !==
		(timerFiredEventDigest === undefined)
	) {
		throw new TypeError(
			"recovery.cancellation timer fired reference and digest must be present together.",
		);
	}
	const requestedBy = requireNonEmpty(
		cancellation.requested_by,
		"cancellation.requested_by",
	);
	const requestedAt = requireTimestamp(
		cancellation.requested_at,
		"cancellation.requested_at",
	);
	if (cause === "operator_requested") {
		if (timerFiredEventRef !== undefined) {
			throw new TypeError(
				"operator-requested cancellation must not bind timer firing evidence.",
			);
		}
	} else {
		if (
			timerFiredEventRef === undefined ||
			timerFiredEventDigest === undefined
		) {
			throw new TypeError(
				"timer-elapsed cancellation requires exact timer firing evidence.",
			);
		}
		if (requestedBy !== dispatch.authorityActor) {
			throw new TypeError(
				"timer-elapsed cancellation does not match the verified kernel authority.",
			);
		}
		const firing = timers
			.map((timer) => timer.fired)
			.find(
				(candidate) =>
					candidate?.eventRef === timerFiredEventRef &&
					candidate.eventDigest === timerFiredEventDigest,
			);
		if (firing === undefined) {
			throw new TypeError(
				"timer-elapsed cancellation does not bind an exact recovered timer firing.",
			);
		}
		if (Date.parse(requestedAt) < Date.parse(firing.firedAt)) {
			throw new TypeError(
				"timer-elapsed cancellation precedes its bound timer firing.",
			);
		}
	}
	return Object.freeze({
		eventRef: requireEventId(cancellation.event_id, "cancellation.event_id"),
		eventDigest: requireDigest(
			cancellation.event_digest,
			"cancellation.event_digest",
		),
		cancellationId: requireNonEmpty(
			cancellation.cancellation_id,
			"cancellation.cancellation_id",
		),
		cause,
		...(timerFiredEventRef === undefined
			? {}
			: { timerFiredEventRef, timerFiredEventDigest }),
		requestedBy,
		idempotencyKey: requireNonEmpty(
			cancellation.idempotency_key,
			"cancellation.idempotency_key",
		),
		requestedAt,
	});
}

function requireCancellationCause(
	value: unknown,
): GovernedWorkflowCancellationStatusV1["cause"] {
	if (value !== "operator_requested" && value !== "timer_elapsed") {
		throw new TypeError("cancellation.cause is not supported.");
	}
	return value;
}

/**
 * A promotion approval is an operator gate, not action-execution authority.
 * Preserve it as frozen status only; no local parser path may turn it into a
 * decision, promotion, retry, resolver, or capability.
 */
function parseNativePromotionApprovalHandoff(
	promotionApproval: unknown,
	phase: string,
	dispatch: GovernedDispatchLineageV3,
): GovernedPromotionApprovalHandoffStatusV1 | undefined {
	if (promotionApproval === undefined || promotionApproval === null) {
		if (phase === "promotion_approval_pending") {
			throw new Error(
				"governed recovery reports promotion_approval_pending without its approval evidence; action recovery is blocked.",
			);
		}
		return undefined;
	}
	const approval = parseNativePromotionApproval(promotionApproval, dispatch);
	if (phase === "promotion_approval_pending") {
		return approval;
	}
	throw new Error(
		"governed recovery includes promotion approval evidence outside promotion_approval_pending; action recovery is blocked until the dedicated approval reducer view owns that state.",
	);
}

function parseNativePromotionApproval(
	value: unknown,
	dispatch: GovernedDispatchLineageV3,
): GovernedPromotionApprovalHandoffStatusV1 {
	const approval = closedRecord(value, "promotion_approval", [
		"event_id",
		"candidate_digest",
		"base_commit_sha",
		"target_ref",
		"envelope_digest",
		"acceptance_ref",
		"review_refs",
		"requested_by",
		"requested_at",
		"idempotency_key",
	]);
	const envelopeDigest = requireDigest(
		approval.envelope_digest,
		"promotion_approval.envelope_digest",
	);
	if (envelopeDigest !== dispatch.envelopeDigest) {
		throw new TypeError(
			"promotion approval does not bind the verified dispatch envelope.",
		);
	}
	const baseCommitSha = requireCommitSha(
		approval.base_commit_sha,
		"promotion_approval.base_commit_sha",
	);
	if (baseCommitSha !== dispatch.baseCommitSha) {
		throw new TypeError(
			"promotion approval does not bind the verified dispatch base.",
		);
	}
	const reviewRefs = requireArray(
		approval.review_refs,
		"promotion_approval.review_refs",
	).map((reviewRef, index) =>
		requireNonEmpty(reviewRef, `promotion_approval.review_refs[${index}]`),
	);
	if (reviewRefs.length === 0) {
		throw new TypeError(
			"promotion_approval.review_refs must contain at least one approval reference.",
		);
	}
	if (new Set(reviewRefs).size !== reviewRefs.length) {
		throw new TypeError(
			"promotion_approval.review_refs contains duplicate references.",
		);
	}
	return Object.freeze({
		state: "operator_decision_required",
		authority: "none",
		eventRef: requireEventId(approval.event_id, "promotion_approval.event_id"),
		candidateDigest: requireDigest(
			approval.candidate_digest,
			"promotion_approval.candidate_digest",
		),
		baseCommitSha,
		targetRef: requireCanonicalPromotionTargetRef(
			approval.target_ref,
			"promotion_approval.target_ref",
		),
		envelopeDigest,
		acceptanceRef: requireNonEmpty(
			approval.acceptance_ref,
			"promotion_approval.acceptance_ref",
		),
		reviewRefs: Object.freeze(reviewRefs),
		requestedBy: requireNonEmpty(
			approval.requested_by,
			"promotion_approval.requested_by",
		),
		requestedAt: requireTimestamp(
			approval.requested_at,
			"promotion_approval.requested_at",
		),
		idempotencyKey: requireNonEmpty(
			approval.idempotency_key,
			"promotion_approval.idempotency_key",
		),
	});
}

function requireCanonicalPromotionTargetRef(
	value: unknown,
	label: string,
): string {
	const targetRef = requireNonEmpty(value, label);
	const branch = targetRef.startsWith("refs/heads/")
		? targetRef.slice("refs/heads/".length)
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
		throw new TypeError(`${label} must be a canonical refs/heads branch ref.`);
	}
	return targetRef;
}

function parseNativeRequests(
	value: unknown,
	dispatch: GovernedDispatchLineageV3,
): readonly DurableActionRequestV2[] {
	const entries = requireArray(value, "recovery.requests");
	const seen = new Set<string>();
	return Object.freeze(
		entries.map((entry, index) => {
			const request = closedRecord(entry, `recovery.requests[${index}]`, [
				"event_id",
				"action_id",
				"idempotency_key",
				"action_kind",
				"canonical_input_digest",
				"canonical_input_ref",
				"repository_binding_digest",
				"ledger_authority_realm_digest",
				"governed_packet_digest",
				"policy_digest",
				"authority_actor",
				"execution_role",
				"requested_at",
				"action_request_digest",
			]);
			const actionId = requireNonEmpty(request.action_id, "request.action_id");
			if (seen.has(actionId)) {
				throw new TypeError("recovery.requests contains duplicate action ids.");
			}
			seen.add(actionId);
			if (
				requireDigest(request.policy_digest, "request.policy_digest") !==
					dispatch.policyDigest ||
				requireDigest(
					request.repository_binding_digest,
					"request.repository_binding_digest",
				) !== dispatch.repositoryBindingDigest ||
				requireDigest(
					request.ledger_authority_realm_digest,
					"request.ledger_authority_realm_digest",
				) !== dispatch.ledgerAuthorityRealmDigest ||
				requireDigest(
					request.governed_packet_digest,
					"request.governed_packet_digest",
				) !== dispatch.governedPacketDigest ||
				requireNonEmpty(request.authority_actor, "request.authority_actor") !==
					dispatch.authorityActor ||
				requireRole(request.execution_role, "request.execution_role") !==
					dispatch.executionRole
			) {
				throw new TypeError(
					"recovered action request does not match the verified dispatch policy, repository, ledger realm, actor, or role binding.",
				);
			}
			const actionRequest: ActionRequestedV2 = parseActionRequestedV2({
				schemaVersion: 2,
				runId: dispatch.runId,
				workflowId: dispatch.workflowId,
				unitId: dispatch.unitId,
				attempt: dispatch.attempt,
				provenanceRef: dispatch.provenanceRef,
				actionId,
				idempotencyKey: requireNonEmpty(
					request.idempotency_key,
					"request.idempotency_key",
				),
				actionKind: requireActionKind(request.action_kind),
				canonicalInputDigest: requireDigest(
					request.canonical_input_digest,
					"request.canonical_input_digest",
				),
				canonicalInputRef: requireNonEmpty(
					request.canonical_input_ref,
					"request.canonical_input_ref",
				),
				dispatchEnvelopeDigest: dispatch.envelopeDigest,
				capabilityBundleDigest: dispatch.capabilityBundleDigest,
				policyDigest: dispatch.policyDigest,
				contextManifestDigest: dispatch.contextManifestDigest,
				workerManifestDigest: dispatch.workerManifestDigest,
				sandboxProfileDigest: dispatch.sandboxProfileDigest,
				repositoryBindingDigest: dispatch.repositoryBindingDigest,
				ledgerAuthorityRealmDigest: dispatch.ledgerAuthorityRealmDigest,
				governedPacketDigest: dispatch.governedPacketDigest,
				authorityActor: dispatch.authorityActor,
				executionRole: dispatch.executionRole,
				requestedAt: requireTimestamp(
					request.requested_at,
					"request.requested_at",
				),
			});
			const digest = requireDigest(
				request.action_request_digest,
				"request.action_request_digest",
			);
			if (canonicalActionRequestedV2Digest(actionRequest) !== digest) {
				throw new TypeError(
					"recovered action request canonical digest does not match the signed replay projection.",
				);
			}
			return Object.freeze({
				actionRequest,
				actionRequestRef: requireEventId(request.event_id, "request.event_id"),
				actionRequestDigest: digest,
			});
		}),
	);
}

function parseNativeReceipts(
	value: unknown,
	dispatch: GovernedDispatchLineageV3,
	requests: readonly DurableActionRequestV2[],
): readonly DurableActionReceiptV2[] {
	const byDigest = new Map(
		requests.map((request) => [request.actionRequestDigest, request] as const),
	);
	const entries = requireArray(value, "recovery.receipts");
	const seen = new Set<string>();
	return Object.freeze(
		entries.map((entry, index) => {
			const receipt = closedRecord(
				entry,
				`recovery.receipts[${index}]`,
				[
					"event_id",
					"action_id",
					"idempotency_key",
					"action_request_digest",
					"outcome",
					"result_digest",
					"result_ref",
					"evidence_digest",
					"evidence_ref",
					"resource_usage",
					"redactions",
					"failure",
					"authorization_ref",
					"action_receipt_ref",
					"action_receipt_digest",
					"completed_at",
				],
				[
					"event_id",
					"action_id",
					"idempotency_key",
					"action_request_digest",
					"outcome",
					"evidence_digest",
					"evidence_ref",
					"resource_usage",
					"redactions",
					"action_receipt_ref",
					"action_receipt_digest",
					"completed_at",
				],
			);
			const requestDigest = requireDigest(
				receipt.action_request_digest,
				"receipt.action_request_digest",
			);
			const request = byDigest.get(requestDigest);
			if (!request) {
				throw new TypeError(
					"recovered action receipt does not reference a recovered action request.",
				);
			}
			const actionId = requireNonEmpty(receipt.action_id, "receipt.action_id");
			if (
				actionId !== request.actionRequest.actionId ||
				requireNonEmpty(receipt.idempotency_key, "receipt.idempotency_key") !==
					request.actionRequest.idempotencyKey ||
				seen.has(actionId)
			) {
				throw new TypeError(
					"recovered action receipt has a duplicate or mismatched action identity.",
				);
			}
			seen.add(actionId);
			const outcome = requireReceiptOutcome(receipt.outcome);
			const resultDigest = optionalDigest(
				receipt.result_digest,
				"receipt.result_digest",
			);
			const resultRef = optionalNonEmpty(
				receipt.result_ref,
				"receipt.result_ref",
			);
			if ((resultDigest === undefined) !== (resultRef === undefined)) {
				throw new TypeError(
					"recovered action receipt result digest/reference must be present together.",
				);
			}
			const materialized: ActionReceiptRecordedV2 =
				parseActionReceiptRecordedV2({
					schemaVersion: 2,
					runId: dispatch.runId,
					workflowId: dispatch.workflowId,
					unitId: dispatch.unitId,
					attempt: dispatch.attempt,
					provenanceRef: dispatch.provenanceRef,
					actionId,
					idempotencyKey: request.actionRequest.idempotencyKey,
					actionRequestDigest: requestDigest,
					dispatchEnvelopeDigest: dispatch.envelopeDigest,
					capabilityBundleDigest: dispatch.capabilityBundleDigest,
					policyDigest: dispatch.policyDigest,
					contextManifestDigest: dispatch.contextManifestDigest,
					workerManifestDigest: dispatch.workerManifestDigest,
					sandboxProfileDigest: dispatch.sandboxProfileDigest,
					authorityActor: dispatch.authorityActor,
					executionRole: dispatch.executionRole,
					...(optionalNonEmpty(
						receipt.authorization_ref,
						"receipt.authorization_ref",
					) === undefined
						? {}
						: {
								authorizationRef: optionalNonEmpty(
									receipt.authorization_ref,
									"receipt.authorization_ref",
								),
							}),
					outcome,
					...(resultDigest === undefined
						? {}
						: { resultDigest, resultRef: resultRef as string }),
					evidenceDigest: requireDigest(
						receipt.evidence_digest,
						"receipt.evidence_digest",
					),
					evidenceRef: requireNonEmpty(
						receipt.evidence_ref,
						"receipt.evidence_ref",
					),
					resourceUsage: parseResourceUsage(receipt.resource_usage),
					redactions: parseRedactions(receipt.redactions),
					...(receipt.failure === null || receipt.failure === undefined
						? {}
						: { failure: parseFailure(receipt.failure) }),
					actionReceiptRef: requireNonEmpty(
						receipt.action_receipt_ref,
						"receipt.action_receipt_ref",
					),
					completedAt: requireTimestamp(
						receipt.completed_at,
						"receipt.completed_at",
					),
				});
			const digest = requireDigest(
				receipt.action_receipt_digest,
				"receipt.action_receipt_digest",
			);
			if (canonicalActionReceiptRecordedV2Digest(materialized) !== digest) {
				throw new TypeError(
					"recovered action receipt canonical digest does not match the signed replay projection.",
				);
			}
			return Object.freeze({
				receipt: materialized,
				actionReceiptDigest: digest,
			});
		}),
	);
}

function parseNativeReceiptSet(
	value: unknown,
	dispatch: GovernedDispatchLineageV3,
): ActionReceiptSetRecordedV1 {
	const set = closedRecord(value, "recovery.receipt_set", [
		"event_id",
		"action_receipt_set_ref",
		"action_receipt_set_digest",
		"receipts",
		"sealed_at",
	]);
	const entries = requireArray(set.receipts, "receipt_set.receipts").map(
		(entry, index) => {
			const receipt = closedRecord(entry, `receipt_set.receipts[${index}]`, [
				"action_id",
				"action_receipt_ref",
				"action_receipt_digest",
			]);
			return {
				actionId: requireNonEmpty(receipt.action_id, "receipt_set.action_id"),
				actionReceiptRef: requireNonEmpty(
					receipt.action_receipt_ref,
					"receipt_set.action_receipt_ref",
				),
				actionReceiptDigest: requireDigest(
					receipt.action_receipt_digest,
					"receipt_set.action_receipt_digest",
				),
			};
		},
	);
	return parseActionReceiptSetRecordedV1({
		schemaVersion: 1,
		runId: dispatch.runId,
		workflowId: dispatch.workflowId,
		unitId: dispatch.unitId,
		attempt: dispatch.attempt,
		provenanceRef: dispatch.provenanceRef,
		dispatchEnvelopeDigest: dispatch.envelopeDigest,
		actionReceiptSetRef: requireNonEmpty(
			set.action_receipt_set_ref,
			"receipt_set.action_receipt_set_ref",
		),
		actionReceiptSetDigest: requireDigest(
			set.action_receipt_set_digest,
			"receipt_set.action_receipt_set_digest",
		),
		receipts: entries,
		sealedAt: requireTimestamp(set.sealed_at, "receipt_set.sealed_at"),
	});
}

function parseNativeCandidates(
	value: unknown,
	dispatch: GovernedDispatchLineageV3,
): GovernedActionEvidenceRecoverySnapshot["candidates"] {
	return Object.freeze(
		requireArray(value, "recovery.candidates").map((entry, index) => {
			const candidate = closedRecord(
				entry,
				`recovery.candidates[${index}]`,
				[
					"event_id",
					"candidate_id",
					"candidate_ref",
					"candidate_digest",
					"base_commit_sha",
					"candidate_commit_sha",
					"commit_digest",
					"tree_digest",
					"patch_digest",
					"changed_files_digest",
					"envelope_digest",
					"action_receipt_digest",
					"action_receipt_set_ref",
					"action_receipt_set_digest",
				],
				[
					"event_id",
					"candidate_id",
					"candidate_ref",
					"candidate_digest",
					"base_commit_sha",
					"candidate_commit_sha",
					"commit_digest",
					"tree_digest",
					"patch_digest",
					"changed_files_digest",
					"envelope_digest",
				],
			);
			if (
				requireDigest(
					candidate.envelope_digest,
					"candidate.envelope_digest",
				) !== dispatch.envelopeDigest ||
				requireCommitSha(
					candidate.base_commit_sha,
					"candidate.base_commit_sha",
				) !== dispatch.baseCommitSha
			) {
				throw new TypeError(
					"recovered candidate does not bind the verified dispatch envelope/base.",
				);
			}
			if (
				candidate.action_receipt_digest !== null &&
				candidate.action_receipt_digest !== undefined
			) {
				throw new TypeError(
					"legacy candidate receipt lineage cannot resume a sealed_v3 workflow.",
				);
			}
			const actionReceiptSetRef = requireNonEmpty(
				candidate.action_receipt_set_ref,
				"candidate.action_receipt_set_ref",
			);
			const actionReceiptSetDigest = requireDigest(
				candidate.action_receipt_set_digest,
				"candidate.action_receipt_set_digest",
			);
			const materialized = parseCandidateCreatedV2({
				runId: dispatch.runId,
				candidateId: requireNonEmpty(
					candidate.candidate_id,
					"candidate.candidate_id",
				),
				candidateRef: requireNonEmpty(
					candidate.candidate_ref,
					"candidate.candidate_ref",
				),
				workflowId: dispatch.workflowId,
				unitId: dispatch.unitId,
				attempt: dispatch.attempt,
				provenanceRef: dispatch.provenanceRef,
				candidateDigest: requireDigest(
					candidate.candidate_digest,
					"candidate.candidate_digest",
				),
				baseCommitSha: dispatch.baseCommitSha,
				candidateCommitSha: requireCommitSha(
					candidate.candidate_commit_sha,
					"candidate.candidate_commit_sha",
				),
				commitDigest: requireDigest(
					candidate.commit_digest,
					"candidate.commit_digest",
				),
				treeDigest: requireDigest(
					candidate.tree_digest,
					"candidate.tree_digest",
				),
				patchDigest: requireDigest(
					candidate.patch_digest,
					"candidate.patch_digest",
				),
				changedFilesDigest: requireDigest(
					candidate.changed_files_digest,
					"candidate.changed_files_digest",
				),
				envelopeDigest: dispatch.envelopeDigest,
				actionReceiptSetRef,
				actionReceiptSetDigest,
			});
			return Object.freeze({
				candidate: materialized,
				candidateCreatedRef: requireEventId(
					candidate.event_id,
					"candidate.event_id",
				),
			});
		}),
	);
}

/**
 * Native activity leases are part of the signed workflow reducer, not an
 * optional telemetry stream. Keep the projection closed and bind every claim
 * to the already verified dispatch/request before exposing it to completion
 * reconciliation.
 */
function parseNativeActivityClaims(
	value: unknown,
	dispatch: GovernedDispatchLineageV3,
	requests: readonly DurableActionRequestV2[],
): readonly GovernedRecoveredActivityClaimV1[] {
	const requestsByRef = new Map(
		requests.map((request) => [request.actionRequestRef, request] as const),
	);
	const entries = requireArray(value, "recovery.activity_claims");
	const activityIds = new Set<string>();
	const idempotencyKeys = new Set<string>();
	const eventRefs = new Set<string>();
	return Object.freeze(
		entries.map((entry, index) => {
			const claim = closedRecord(
				entry,
				`recovery.activity_claims[${index}]`,
				[
					"event_id",
					"claim_event_digest",
					"run_id",
					"activity_id",
					"idempotency_key",
					"action_kind",
					"action_request_event_id",
					"action_request_digest",
					"dispatch_event_id",
					"dispatch_envelope_digest",
					"authority_actor",
					"lease_id",
					"lease_expires_at",
					"claimed_at",
					"signer",
					"result",
				],
				[
					"event_id",
					"claim_event_digest",
					"run_id",
					"activity_id",
					"idempotency_key",
					"action_kind",
					"action_request_event_id",
					"action_request_digest",
					"dispatch_event_id",
					"dispatch_envelope_digest",
					"authority_actor",
					"lease_id",
					"lease_expires_at",
					"claimed_at",
				],
			);
			const claimEventRef = requireEventId(
				claim.event_id,
				"activity_claim.event_id",
			);
			const actionRequestRef = requireEventId(
				claim.action_request_event_id,
				"activity_claim.action_request_event_id",
			);
			const request = requestsByRef.get(actionRequestRef);
			if (!request) {
				throw new TypeError(
					"recovered activity claim does not reference a recovered action request.",
				);
			}
			const activityId = requireNonEmpty(
				claim.activity_id,
				"activity_claim.activity_id",
			);
			const idempotencyKey = requireNonEmpty(
				claim.idempotency_key,
				"activity_claim.idempotency_key",
			);
			if (
				activityIds.has(activityId) ||
				idempotencyKeys.has(idempotencyKey) ||
				eventRefs.has(claimEventRef)
			) {
				throw new TypeError(
					"recovery.activity_claims contains duplicate activity, idempotency, or event identity.",
				);
			}
			activityIds.add(activityId);
			idempotencyKeys.add(idempotencyKey);
			eventRefs.add(claimEventRef);
			if (
				requireNonEmpty(claim.run_id, "activity_claim.run_id") !==
					dispatch.runId ||
				activityId !== request.actionRequest.actionId ||
				idempotencyKey !== request.actionRequest.idempotencyKey ||
				requireActionKind(claim.action_kind) !==
					request.actionRequest.actionKind ||
				requireDigest(
					claim.action_request_digest,
					"activity_claim.action_request_digest",
				) !== request.actionRequestDigest ||
				requireEventId(
					claim.dispatch_event_id,
					"activity_claim.dispatch_event_id",
				) !== dispatch.dispatchEnvelopeRef ||
				requireDigest(
					claim.dispatch_envelope_digest,
					"activity_claim.dispatch_envelope_digest",
				) !== dispatch.envelopeDigest ||
				requireNonEmpty(
					claim.authority_actor,
					"activity_claim.authority_actor",
				) !== dispatch.authorityActor
			) {
				throw new TypeError(
					"recovered activity claim does not bind the exact verified dispatch/action request.",
				);
			}
			validateNativeActivityClaimSigner(claim.signer);
			const result = parseNativeActivityResult(
				claim.result,
				claimEventRef,
				requireDigest(
					claim.claim_event_digest,
					"activity_claim.claim_event_digest",
				),
				dispatch,
				activityId,
				idempotencyKey,
				requireNonEmpty(claim.lease_id, "activity_claim.lease_id"),
			);
			return Object.freeze({
				activityId,
				idempotencyKey,
				claimEventRef,
				claimEventDigest: requireDigest(
					claim.claim_event_digest,
					"activity_claim.claim_event_digest",
				),
				actionRequestRef,
				actionRequestDigest: request.actionRequestDigest,
				leaseId: requireNonEmpty(claim.lease_id, "activity_claim.lease_id"),
				leaseExpiresAt: requireTimestamp(
					claim.lease_expires_at,
					"activity_claim.lease_expires_at",
				),
				...(result === undefined ? {} : { result }),
			});
		}),
	);
}

function validateNativeActivityClaimSigner(value: unknown): void {
	if (value === undefined || value === null) return;
	const signer = closedRecord(
		value,
		"activity_claim.signer",
		["actor_id", "key_id", "public_key_hash"],
		["actor_id", "key_id"],
	);
	requireNonEmpty(signer.actor_id, "activity_claim.signer.actor_id");
	requireNonEmpty(signer.key_id, "activity_claim.signer.key_id");
	if (signer.public_key_hash !== undefined && signer.public_key_hash !== null) {
		requireDigest(
			signer.public_key_hash,
			"activity_claim.signer.public_key_hash",
		);
	}
}

function parseNativeActivityResult(
	value: unknown,
	claimEventRef: string,
	claimEventDigest: string,
	dispatch: GovernedDispatchLineageV3,
	activityId: string,
	idempotencyKey: string,
	leaseId: string,
): GovernedRecoveredActivityClaimV1["result"] {
	if (value === undefined || value === null) return undefined;
	const result = closedRecord(
		value,
		"activity_claim.result",
		[
			"event_id",
			"event_digest",
			"run_id",
			"activity_id",
			"idempotency_key",
			"claim_event_id",
			"claim_event_digest",
			"lease_id",
			"outcome",
			"result_digest",
			"result_ref",
			"evidence_digest",
			"evidence_ref",
			"recorded_at",
		],
		[
			"event_id",
			"event_digest",
			"run_id",
			"activity_id",
			"idempotency_key",
			"claim_event_id",
			"claim_event_digest",
			"lease_id",
			"outcome",
			"evidence_digest",
			"evidence_ref",
			"recorded_at",
		],
	);
	const outcome = requireActivityResultOutcome(result.outcome);
	const resultDigest = optionalDigest(
		result.result_digest,
		"activity_result.result_digest",
	);
	const resultRef = optionalNonEmpty(
		result.result_ref,
		"activity_result.result_ref",
	);
	if ((resultDigest === undefined) !== (resultRef === undefined)) {
		throw new TypeError(
			"recovered activity result digest/reference must be present together.",
		);
	}
	if (outcome === "succeeded" && resultDigest === undefined) {
		throw new TypeError(
			"recovered succeeded activity result requires a result digest/reference.",
		);
	}
	if (outcome === "unknown" && resultDigest !== undefined) {
		throw new TypeError(
			"recovered unknown activity result must not assert a result.",
		);
	}
	if (
		requireNonEmpty(result.run_id, "activity_result.run_id") !==
			dispatch.runId ||
		requireNonEmpty(result.activity_id, "activity_result.activity_id") !==
			activityId ||
		requireNonEmpty(
			result.idempotency_key,
			"activity_result.idempotency_key",
		) !== idempotencyKey ||
		requireEventId(result.claim_event_id, "activity_result.claim_event_id") !==
			claimEventRef ||
		requireDigest(
			result.claim_event_digest,
			"activity_result.claim_event_digest",
		) !== claimEventDigest ||
		requireNonEmpty(result.lease_id, "activity_result.lease_id") !== leaseId
	) {
		throw new TypeError(
			"recovered activity result does not bind its exact native activity claim.",
		);
	}
	return Object.freeze({
		resultEventRef: requireEventId(result.event_id, "activity_result.event_id"),
		resultEventDigest: requireDigest(
			result.event_digest,
			"activity_result.event_digest",
		),
		claimEventRef,
		claimEventDigest,
		outcome,
	});
}

function requireActivityResultOutcome(
	value: unknown,
): "succeeded" | "failed" | "unknown" {
	if (value !== "succeeded" && value !== "failed" && value !== "unknown") {
		throw new TypeError(
			"recovered activity result has an unsupported outcome.",
		);
	}
	return value;
}

function parseNativeCandidateCompletion(
	value: unknown,
	dispatch: GovernedDispatchLineageV3,
	candidates: GovernedActionEvidenceRecoverySnapshot["candidates"],
): GovernedRecoveredCandidateCompletionV1 {
	const outer = closedRecord(value, "recovery.candidate_completion", [
		"event_id",
		"completion",
	]);
	const completion = closedRecord(
		outer.completion,
		"candidate_completion.completion",
		[
			"run_id",
			"workflow_id",
			"unit_id",
			"attempt",
			"provenance_ref",
			"candidate_created_event_ref",
			"candidate_digest",
			"candidate_create_action_id",
			"action_request_ref",
			"action_request_digest",
			"activity_claim_event_ref",
			"activity_claim_event_digest",
			"activity_result_event_ref",
			"activity_result_event_digest",
			"action_receipt_ref",
			"action_receipt_digest",
			"completion_digest",
			"completed_at",
		],
	);
	const materialized = parseCandidateCompletionRecordedV1({
		runId: requireNonEmpty(completion.run_id, "candidate_completion.run_id"),
		workflowId: requireNonEmpty(
			completion.workflow_id,
			"candidate_completion.workflow_id",
		),
		unitId: requireNonEmpty(completion.unit_id, "candidate_completion.unit_id"),
		attempt: requirePositiveInteger(
			completion.attempt,
			"candidate_completion.attempt",
		),
		provenanceRef: requireNonEmpty(
			completion.provenance_ref,
			"candidate_completion.provenance_ref",
		),
		candidateCreatedEventRef: requireEventId(
			completion.candidate_created_event_ref,
			"candidate_completion.candidate_created_event_ref",
		),
		candidateDigest: requireDigest(
			completion.candidate_digest,
			"candidate_completion.candidate_digest",
		),
		candidateCreateActionId: requireNonEmpty(
			completion.candidate_create_action_id,
			"candidate_completion.candidate_create_action_id",
		),
		actionRequestRef: requireEventId(
			completion.action_request_ref,
			"candidate_completion.action_request_ref",
		),
		actionRequestDigest: requireDigest(
			completion.action_request_digest,
			"candidate_completion.action_request_digest",
		),
		activityClaimEventRef: requireEventId(
			completion.activity_claim_event_ref,
			"candidate_completion.activity_claim_event_ref",
		),
		activityClaimEventDigest: requireDigest(
			completion.activity_claim_event_digest,
			"candidate_completion.activity_claim_event_digest",
		),
		activityResultEventRef: requireEventId(
			completion.activity_result_event_ref,
			"candidate_completion.activity_result_event_ref",
		),
		activityResultEventDigest: requireDigest(
			completion.activity_result_event_digest,
			"candidate_completion.activity_result_event_digest",
		),
		actionReceiptRef: requireNonEmpty(
			completion.action_receipt_ref,
			"candidate_completion.action_receipt_ref",
		),
		actionReceiptDigest: requireDigest(
			completion.action_receipt_digest,
			"candidate_completion.action_receipt_digest",
		),
		completionDigest: requireDigest(
			completion.completion_digest,
			"candidate_completion.completion_digest",
		),
		completedAt: requireTimestamp(
			completion.completed_at,
			"candidate_completion.completed_at",
		),
	});
	if (
		canonicalCandidateCompletionRecordedV1Digest(materialized) !==
		materialized.completionDigest
	) {
		throw new TypeError(
			"recovered candidate completion canonical digest does not match the signed replay projection.",
		);
	}
	if (
		materialized.runId !== dispatch.runId ||
		materialized.workflowId !== dispatch.workflowId ||
		materialized.unitId !== dispatch.unitId ||
		materialized.attempt !== dispatch.attempt ||
		materialized.provenanceRef !== dispatch.provenanceRef
	) {
		throw new TypeError(
			"recovered candidate completion does not belong to the verified dispatch.",
		);
	}
	const matchingCandidates = candidates.filter(
		(candidate) =>
			candidate.candidateCreatedRef === materialized.candidateCreatedEventRef,
	);
	if (
		matchingCandidates.length !== 1 ||
		matchingCandidates[0].candidate.candidateDigest !==
			materialized.candidateDigest
	) {
		throw new TypeError(
			"recovered candidate completion does not bind one exact recovered candidate.",
		);
	}
	return Object.freeze({
		candidateCompletionRef: requireEventId(
			outer.event_id,
			"candidate_completion.event_id",
		),
		completion: materialized,
	});
}

/**
 * The only later-workflow projection this adapter understands is a frozen
 * operator handoff while the trusted reducer waits for a promotion decision.
 * It validates the reducer's complete closed wire view, but deliberately
 * returns no resolver, claim, capability, decision, retry, or write surface.
 */
function validatePendingPromotionApprovalRecoveryProjection(input: {
	readonly approval: GovernedPromotionApprovalHandoffStatusV1;
	readonly dispatch: GovernedDispatchLineageV3;
	readonly candidates: GovernedActionEvidenceRecoverySnapshot["candidates"];
	readonly candidateCompletion?: GovernedRecoveredCandidateCompletionV1;
	readonly acceptance: unknown;
	readonly reviews: unknown;
	readonly promotion: unknown;
	readonly terminal: unknown;
}): void {
	if (
		(input.promotion !== null && input.promotion !== undefined) ||
		(input.terminal !== null && input.terminal !== undefined)
	) {
		throw new Error(
			"pending promotion approval recovery includes promotion or terminal evidence; action recovery is blocked until its dedicated reducer view owns that state.",
		);
	}
	const candidates = input.candidates.filter(
		(candidate) =>
			candidate.candidate.candidateDigest === input.approval.candidateDigest &&
			candidate.candidate.baseCommitSha === input.approval.baseCommitSha &&
			candidate.candidate.envelopeDigest === input.approval.envelopeDigest,
	);
	if (candidates.length !== 1) {
		throw new TypeError(
			"promotion approval does not bind one exact recovered candidate.",
		);
	}
	const candidate = candidates[0];
	const completion = input.candidateCompletion;
	if (
		completion === undefined ||
		completion.completion.candidateCreatedEventRef !==
			candidate.candidateCreatedRef ||
		completion.completion.candidateDigest !==
			candidate.candidate.candidateDigest
	) {
		throw new TypeError(
			"promotion approval does not bind the closed recovered candidate completion.",
		);
	}
	const acceptance = parsePendingPromotionApprovalAcceptance(
		input.acceptance,
		input.approval,
		candidate,
		input.dispatch,
	);
	const reviews = parsePendingPromotionApprovalReviews(
		input.reviews,
		candidate,
		input.dispatch,
	);
	const reviewsByRef = new Map(
		reviews.map((review) => [review.reviewRef, review]),
	);
	for (const reviewRef of input.approval.reviewRefs) {
		const review = reviewsByRef.get(reviewRef);
		if (
			review === undefined ||
			review.reviewVersion !== 2 ||
			review.decision !== "approve"
		) {
			throw new TypeError(
				"promotion approval review reference is not an approving recovered review.",
			);
		}
		if (
			review.candidateDigest !== candidate.candidate.candidateDigest ||
			review.candidateCommitSha !== candidate.candidate.candidateCommitSha
		) {
			throw new TypeError(
				"recovered approval review does not bind the exact recovered candidate.",
			);
		}
		if (review.candidateEnvelopeDigest !== input.approval.envelopeDigest) {
			throw new TypeError(
				"recovered approval review does not bind the verified dispatch envelope.",
			);
		}
		if (
			review.acceptanceRef !== acceptance.acceptanceRef ||
			review.acceptanceDigest !== acceptance.acceptanceDigest ||
			review.acceptanceContractDigest !==
				input.dispatch.acceptanceContractDigest
		) {
			throw new TypeError(
				"recovered approval review does not bind the exact passed acceptance.",
			);
		}
	}
}

function parsePendingPromotionApprovalAcceptance(
	value: unknown,
	approval: GovernedPromotionApprovalHandoffStatusV1,
	candidate: GovernedActionEvidenceRecoverySnapshot["candidates"][number],
	dispatch: GovernedDispatchLineageV3,
): Readonly<{ acceptanceRef: string; acceptanceDigest: string }> {
	const acceptance = closedRecord(value, "recovery.acceptance", [
		"event_id",
		"candidate_digest",
		"candidate_commit_sha",
		"acceptance_ref",
		"acceptance_contract_digest",
		"acceptance_digest",
		"outcome",
		"evaluated_at",
	]);
	requireEventId(acceptance.event_id, "acceptance.event_id");
	if (
		requireDigest(
			acceptance.candidate_digest,
			"acceptance.candidate_digest",
		) !== candidate.candidate.candidateDigest ||
		requireCommitSha(
			acceptance.candidate_commit_sha,
			"acceptance.candidate_commit_sha",
		) !== candidate.candidate.candidateCommitSha
	) {
		throw new TypeError(
			"recovered passed acceptance does not bind the exact recovered candidate.",
		);
	}
	const acceptanceRef = requireNonEmpty(
		acceptance.acceptance_ref,
		"acceptance.acceptance_ref",
	);
	if (acceptanceRef !== approval.acceptanceRef) {
		throw new TypeError(
			"promotion approval does not bind the passed recovered acceptance.",
		);
	}
	if (
		requireDigest(
			acceptance.acceptance_contract_digest,
			"acceptance.acceptance_contract_digest",
		) !== dispatch.acceptanceContractDigest
	) {
		throw new TypeError(
			"recovered passed acceptance does not bind the verified dispatch contract.",
		);
	}
	if (acceptance.outcome !== "passed") {
		throw new TypeError(
			"promotion approval requires a passed recovered acceptance.",
		);
	}
	const acceptanceDigest = requireDigest(
		acceptance.acceptance_digest,
		"acceptance.acceptance_digest",
	);
	requireTimestamp(acceptance.evaluated_at, "acceptance.evaluated_at");
	return Object.freeze({ acceptanceRef, acceptanceDigest });
}

function parsePendingPromotionApprovalReviews(
	value: unknown,
	candidate: GovernedActionEvidenceRecoverySnapshot["candidates"][number],
	dispatch: GovernedDispatchLineageV3,
): readonly PendingPromotionApprovalReviewV1[] {
	const seenReviewRefs = new Set<string>();
	return Object.freeze(
		requireArray(value, "recovery.reviews").map((entry, index) => {
			const label = `recovery.reviews[${index}]`;
			const reviewVersionRecord = closedRecord(
				entry,
				label,
				[
					"review_version",
					"event_id",
					"candidate_digest",
					"candidate_commit_sha",
					"review_ref",
					"decision",
					"findings",
					"confidence",
					"reviewer_manifest_digest",
					"review_verdict_action_id",
					"review_action_request_digest",
					"review_action_receipt_ref",
					"review_action_receipt_digest",
					"review_output_ref",
					"review_output_digest",
					"acceptance_ref",
					"acceptance_digest",
					"acceptance_contract_digest",
					"candidate_envelope_digest",
					"reviewer_workflow_id",
					"reviewer_dispatch_envelope_digest",
					"reviewer_unit_id",
					"reviewer_attempt",
					"reviewer_execution_role",
					"review_action_receipt_set_ref",
					"review_action_receipt_set_digest",
					"candidate_view",
					"candidate_view_ref",
					"candidate_view_digest",
					"reviewer_authority",
					"reviewed_at",
				],
				["review_version"],
			);
			const reviewVersion = requirePositiveInteger(
				reviewVersionRecord.review_version,
				`${label}.review_version`,
			);
			const review =
				reviewVersion === 1
					? closedRecord(
							entry,
							label,
							PENDING_PROMOTION_APPROVAL_REVIEW_V1_FIELDS,
						)
					: reviewVersion === 2
						? closedRecord(
								entry,
								label,
								PENDING_PROMOTION_APPROVAL_REVIEW_V2_FIELDS,
							)
						: (() => {
								throw new TypeError(
									`${label}.review_version is not supported.`,
								);
							})();
			const reviewRef = requireNonEmpty(
				review.review_ref,
				`${label}.review_ref`,
			);
			if (seenReviewRefs.has(reviewRef)) {
				throw new TypeError(
					"recovery.reviews contains duplicate review references.",
				);
			}
			seenReviewRefs.add(reviewRef);
			parsePendingPromotionApprovalReviewFindings(
				review.findings,
				`${label}.findings`,
			);
			if (
				!Number.isFinite(review.confidence) ||
				(typeof review.confidence === "number" &&
					(review.confidence < 0 || review.confidence > 1))
			) {
				throw new TypeError(
					`${label}.confidence must be between zero and one.`,
				);
			}
			const parsed: PendingPromotionApprovalReviewV1 = {
				reviewRef,
				reviewVersion,
				decision: requireReviewDecision(review.decision, `${label}.decision`),
				candidateDigest: requireDigest(
					review.candidate_digest,
					`${label}.candidate_digest`,
				),
				candidateCommitSha: requireCommitSha(
					review.candidate_commit_sha,
					`${label}.candidate_commit_sha`,
				),
			};
			requireEventId(review.event_id, `${label}.event_id`);
			requireDigest(
				review.reviewer_manifest_digest,
				`${label}.reviewer_manifest_digest`,
			);
			requireTimestamp(review.reviewed_at, `${label}.reviewed_at`);
			if (reviewVersion === 1) return Object.freeze(parsed);

			const candidateEnvelopeDigest = requireDigest(
				review.candidate_envelope_digest,
				`${label}.candidate_envelope_digest`,
			);
			const acceptanceRef = requireNonEmpty(
				review.acceptance_ref,
				`${label}.acceptance_ref`,
			);
			const acceptanceDigest = requireDigest(
				review.acceptance_digest,
				`${label}.acceptance_digest`,
			);
			const acceptanceContractDigest = requireDigest(
				review.acceptance_contract_digest,
				`${label}.acceptance_contract_digest`,
			);
			validatePendingPromotionApprovalReviewV2Evidence(
				review,
				label,
				candidate,
				dispatch,
			);
			return Object.freeze({
				...parsed,
				candidateEnvelopeDigest,
				acceptanceRef,
				acceptanceDigest,
				acceptanceContractDigest,
			});
		}),
	);
}

const PENDING_PROMOTION_APPROVAL_REVIEW_V1_FIELDS = [
	"review_version",
	"event_id",
	"candidate_digest",
	"candidate_commit_sha",
	"review_ref",
	"decision",
	"findings",
	"confidence",
	"reviewer_manifest_digest",
	"reviewed_at",
] as const;

const PENDING_PROMOTION_APPROVAL_REVIEW_V2_FIELDS = [
	...PENDING_PROMOTION_APPROVAL_REVIEW_V1_FIELDS.slice(0, 9),
	"review_verdict_action_id",
	"review_action_request_digest",
	"review_action_receipt_ref",
	"review_action_receipt_digest",
	"review_output_ref",
	"review_output_digest",
	"acceptance_ref",
	"acceptance_digest",
	"acceptance_contract_digest",
	"candidate_envelope_digest",
	"reviewer_workflow_id",
	"reviewer_dispatch_envelope_digest",
	"reviewer_unit_id",
	"reviewer_attempt",
	"reviewer_execution_role",
	"review_action_receipt_set_ref",
	"review_action_receipt_set_digest",
	"candidate_view",
	"candidate_view_ref",
	"candidate_view_digest",
	"reviewer_authority",
	"reviewed_at",
] as const;

interface PendingPromotionApprovalReviewV1 {
	readonly reviewRef: string;
	readonly reviewVersion: number;
	readonly decision: "approve" | "request_changes" | "reject" | "abstain";
	readonly candidateDigest: string;
	readonly candidateCommitSha: string;
	readonly candidateEnvelopeDigest?: string;
	readonly acceptanceRef?: string;
	readonly acceptanceDigest?: string;
	readonly acceptanceContractDigest?: string;
}

function validatePendingPromotionApprovalReviewV2Evidence(
	review: Record<string, unknown>,
	label: string,
	candidate: GovernedActionEvidenceRecoverySnapshot["candidates"][number],
	dispatch: GovernedDispatchLineageV3,
): void {
	requireNonEmpty(
		review.review_verdict_action_id,
		`${label}.review_verdict_action_id`,
	);
	requireDigest(
		review.review_action_request_digest,
		`${label}.review_action_request_digest`,
	);
	requireNonEmpty(
		review.review_action_receipt_ref,
		`${label}.review_action_receipt_ref`,
	);
	requireDigest(
		review.review_action_receipt_digest,
		`${label}.review_action_receipt_digest`,
	);
	requireNonEmpty(review.review_output_ref, `${label}.review_output_ref`);
	requireDigest(review.review_output_digest, `${label}.review_output_digest`);
	requireNonEmpty(review.reviewer_workflow_id, `${label}.reviewer_workflow_id`);
	requireDigest(
		review.reviewer_dispatch_envelope_digest,
		`${label}.reviewer_dispatch_envelope_digest`,
	);
	requireNonEmpty(review.reviewer_unit_id, `${label}.reviewer_unit_id`);
	requirePositiveInteger(review.reviewer_attempt, `${label}.reviewer_attempt`);
	if (
		requireRole(
			review.reviewer_execution_role,
			`${label}.reviewer_execution_role`,
		) !== "reviewer"
	) {
		throw new TypeError(`${label}.reviewer_execution_role must be reviewer.`);
	}
	requireNonEmpty(
		review.review_action_receipt_set_ref,
		`${label}.review_action_receipt_set_ref`,
	);
	requireDigest(
		review.review_action_receipt_set_digest,
		`${label}.review_action_receipt_set_digest`,
	);
	const candidateView = closedRecord(
		review.candidate_view,
		`${label}.candidate_view`,
		[
			"candidate_ref",
			"candidate_digest",
			"candidate_commit_sha",
			"tree_digest",
			"reviewer_context_manifest_digest",
			"reviewer_sandbox_profile_digest",
			"mount_path_digest",
			"read_only",
			"network_disabled",
		],
	);
	if (
		requireNonEmpty(
			candidateView.candidate_ref,
			`${label}.candidate_view.candidate_ref`,
		) !== candidate.candidate.candidateRef ||
		requireDigest(
			candidateView.candidate_digest,
			`${label}.candidate_view.candidate_digest`,
		) !== candidate.candidate.candidateDigest ||
		requireCommitSha(
			candidateView.candidate_commit_sha,
			`${label}.candidate_view.candidate_commit_sha`,
		) !== candidate.candidate.candidateCommitSha ||
		requireDigest(
			candidateView.tree_digest,
			`${label}.candidate_view.tree_digest`,
		) !== candidate.candidate.treeDigest
	) {
		throw new TypeError(
			`${label}.candidate_view does not bind the recovered candidate.`,
		);
	}
	requireDigest(
		candidateView.reviewer_context_manifest_digest,
		`${label}.candidate_view.reviewer_context_manifest_digest`,
	);
	requireDigest(
		candidateView.reviewer_sandbox_profile_digest,
		`${label}.candidate_view.reviewer_sandbox_profile_digest`,
	);
	requireDigest(
		candidateView.mount_path_digest,
		`${label}.candidate_view.mount_path_digest`,
	);
	if (
		candidateView.read_only !== true ||
		candidateView.network_disabled !== true
	) {
		throw new TypeError(
			`${label}.candidate_view must be read-only with network disabled.`,
		);
	}
	requireNonEmpty(review.candidate_view_ref, `${label}.candidate_view_ref`);
	requireDigest(review.candidate_view_digest, `${label}.candidate_view_digest`);
	requireNonEmpty(review.reviewer_authority, `${label}.reviewer_authority`);
	if (review.candidate_envelope_digest !== dispatch.envelopeDigest) {
		// The caller emits the more specific approval-review binding error when
		// this review is selected by approval.review_refs.
		requireDigest(
			review.candidate_envelope_digest,
			`${label}.candidate_envelope_digest`,
		);
	}
}

function parsePendingPromotionApprovalReviewFindings(
	value: unknown,
	label: string,
): void {
	for (const [index, entry] of requireArray(value, label).entries()) {
		const finding = closedRecord(entry, `${label}[${index}]`, [
			"severity",
			"check_id",
			"file",
			"line",
			"explanation",
			"evidence_refs",
		]);
		if (
			finding.severity !== "info" &&
			finding.severity !== "low" &&
			finding.severity !== "medium" &&
			finding.severity !== "high" &&
			finding.severity !== "critical"
		) {
			throw new TypeError(`${label}[${index}].severity is not supported.`);
		}
		requireNonEmpty(finding.check_id, `${label}[${index}].check_id`);
		requireNonEmpty(finding.file, `${label}[${index}].file`);
		requireNonNegativeInteger(finding.line, `${label}[${index}].line`);
		requireNonEmpty(finding.explanation, `${label}[${index}].explanation`);
		for (const [evidenceIndex, evidenceRef] of requireArray(
			finding.evidence_refs,
			`${label}[${index}].evidence_refs`,
		).entries()) {
			requireNonEmpty(
				evidenceRef,
				`${label}[${index}].evidence_refs[${evidenceIndex}]`,
			);
		}
	}
}

function requireReviewDecision(
	value: unknown,
	label: string,
): PendingPromotionApprovalReviewV1["decision"] {
	if (
		value !== "approve" &&
		value !== "request_changes" &&
		value !== "reject" &&
		value !== "abstain"
	) {
		throw new TypeError(`${label} is not supported.`);
	}
	return value;
}

function assertNoUnsupportedTerminalProjection(
	acceptance: unknown,
	reviews: unknown,
	promotion: unknown,
	terminal: unknown,
): void {
	if (
		(acceptance !== null && acceptance !== undefined) ||
		(promotion !== null && promotion !== undefined) ||
		(terminal !== null && terminal !== undefined) ||
		(Array.isArray(reviews) && reviews.length > 0)
	) {
		throw new Error(
			"this governed dispatch already has acceptance, review, promotion, or terminal evidence; execution is blocked until the dedicated recovery reducer view owns that state.",
		);
	}
	if (!Array.isArray(reviews)) {
		throw new TypeError("recovery.reviews must be an array.");
	}
}

function parseActionIds(value: unknown, label: string): readonly string[] {
	const ids = requireArray(value, `recovery.${label}`).map((id, index) =>
		requireNonEmpty(id, `${label}[${index}]`),
	);
	if (new Set(ids).size !== ids.length) {
		throw new TypeError(`recovery.${label} contains duplicate action ids.`);
	}
	return Object.freeze(ids);
}

function parseResourceUsage(
	value: unknown,
): ActionReceiptRecordedV2["resourceUsage"] {
	const usage = closedRecord(
		value,
		"receipt.resource_usage",
		[
			"wall_time_ms",
			"cpu_time_ms",
			"peak_memory_bytes",
			"input_bytes",
			"output_bytes",
			"input_tokens",
			"output_tokens",
		],
		["wall_time_ms"],
	);
	return {
		wallTimeMs: requireNonNegativeInteger(usage.wall_time_ms, "wall_time_ms"),
		...(usage.cpu_time_ms === undefined || usage.cpu_time_ms === null
			? {}
			: {
					cpuTimeMs: requireNonNegativeInteger(
						usage.cpu_time_ms,
						"cpu_time_ms",
					),
				}),
		...(usage.peak_memory_bytes === undefined ||
		usage.peak_memory_bytes === null
			? {}
			: {
					peakMemoryBytes: requireNonNegativeInteger(
						usage.peak_memory_bytes,
						"peak_memory_bytes",
					),
				}),
		...(usage.input_bytes === undefined || usage.input_bytes === null
			? {}
			: {
					inputBytes: requireNonNegativeInteger(
						usage.input_bytes,
						"input_bytes",
					),
				}),
		...(usage.output_bytes === undefined || usage.output_bytes === null
			? {}
			: {
					outputBytes: requireNonNegativeInteger(
						usage.output_bytes,
						"output_bytes",
					),
				}),
		...(usage.input_tokens === undefined || usage.input_tokens === null
			? {}
			: {
					inputTokens: requireNonNegativeInteger(
						usage.input_tokens,
						"input_tokens",
					),
				}),
		...(usage.output_tokens === undefined || usage.output_tokens === null
			? {}
			: {
					outputTokens: requireNonNegativeInteger(
						usage.output_tokens,
						"output_tokens",
					),
				}),
	};
}

function parseRedactions(
	value: unknown,
): ActionReceiptRecordedV2["redactions"] {
	return requireArray(value, "receipt.redactions").map((entry, index) => {
		const redaction = closedRecord(
			entry,
			`receipt.redactions[${index}]`,
			["field", "reason", "redacted_digest"],
			["field", "reason"],
		);
		return {
			field: requireNonEmpty(redaction.field, "redaction.field"),
			reason: requireNonEmpty(redaction.reason, "redaction.reason"),
			...(redaction.redacted_digest === null ||
			redaction.redacted_digest === undefined
				? {}
				: {
						redactedDigest: requireDigest(
							redaction.redacted_digest,
							"redaction.redacted_digest",
						),
					}),
		};
	});
}

function parseFailure(
	value: unknown,
): NonNullable<ActionReceiptRecordedV2["failure"]> {
	const failure = closedRecord(value, "receipt.failure", [
		"code",
		"message_digest",
		"retryable",
	]);
	if (typeof failure.retryable !== "boolean") {
		throw new TypeError("receipt.failure.retryable must be boolean.");
	}
	return {
		code: requireNonEmpty(failure.code, "receipt.failure.code"),
		messageDigest: requireDigest(
			failure.message_digest,
			"receipt.failure.message_digest",
		),
		retryable: failure.retryable,
	};
}

function closedRecord(
	value: unknown,
	label: string,
	allowed: readonly string[],
	required: readonly string[] = allowed,
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object.`);
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	const unknown = keys.filter((key) => !allowed.includes(key));
	if (unknown.length > 0) {
		throw new TypeError(
			`${label} contains unsupported field(s): ${unknown.join(", ")}.`,
		);
	}
	const missing = required.filter((key) => !Object.hasOwn(record, key));
	if (missing.length > 0) {
		throw new TypeError(
			`${label} is missing required field(s): ${missing.join(", ")}.`,
		);
	}
	return record;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
	if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
	return value;
}

function requireEventId(value: unknown, label: string): string {
	if (typeof value !== "string" || !EVENT_ID.test(value)) {
		throw new TypeError(`${label} must be a UUID event id.`);
	}
	return value.toLowerCase();
}

function optionalEventId(value: unknown, label: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	return requireEventId(value, label);
}

function requireDigest(value: unknown, label: string): string {
	if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
		throw new TypeError(
			`${label} must be a canonical lowercase SHA-256 digest.`,
		);
	}
	return value;
}

function optionalDigest(value: unknown, label: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	return requireDigest(value, label);
}

function requireNonEmpty(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.includes("\0")
	) {
		throw new TypeError(`${label} must be a non-empty string.`);
	}
	return value;
}

function optionalNonEmpty(value: unknown, label: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	return requireNonEmpty(value, label);
}

function requireTimestamp(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		!RFC3339_UTC.test(value) ||
		!Number.isFinite(Date.parse(value))
	) {
		throw new TypeError(`${label} must be a RFC3339 UTC timestamp.`);
	}
	return value;
}

function requireCommitSha(value: unknown, label: string): string {
	if (typeof value !== "string" || !COMMIT_SHA.test(value)) {
		throw new TypeError(
			`${label} must be a lowercase 40- or 64-character commit SHA.`,
		);
	}
	return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		throw new TypeError(`${label} must be a positive safe integer.`);
	}
	return value as number;
}

function optionalPositiveInteger(
	value: unknown,
	label: string,
): number | undefined {
	if (value === undefined || value === null) return undefined;
	return requirePositiveInteger(value, label);
}

function requireNonNegativeInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new TypeError(`${label} must be a non-negative safe integer.`);
	}
	return value as number;
}

function requireCanonicalU64Decimal(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		!CANONICAL_U64_DECIMAL.test(value) ||
		value.length > MAX_U64_DECIMAL.length ||
		(value.length === MAX_U64_DECIMAL.length && value > MAX_U64_DECIMAL)
	) {
		throw new TypeError(
			`${label} must be a canonical unsigned 64-bit decimal string.`,
		);
	}
	return value;
}

function requireRole(
	value: unknown,
	label: string,
): GovernedDispatchLineageV3["executionRole"] {
	if (
		value !== "implementer" &&
		value !== "reviewer" &&
		value !== "adversary" &&
		value !== "judge" &&
		value !== "candidate"
	) {
		throw new TypeError(`${label} is not a supported execution role.`);
	}
	return value;
}

function requireActionKind(value: unknown): ActionRequestedV2["actionKind"] {
	if (
		value !== "filesystem" &&
		value !== "process" &&
		value !== "git" &&
		value !== "model" &&
		value !== "network" &&
		value !== "secret" &&
		value !== "mcp" &&
		value !== "a2a" &&
		value !== "external_service"
	) {
		throw new TypeError(
			"recovered action request has an unsupported action_kind.",
		);
	}
	return value;
}

function requireReceiptOutcome(
	value: unknown,
): ActionReceiptRecordedV2["outcome"] {
	if (
		value !== "succeeded" &&
		value !== "failed" &&
		value !== "denied" &&
		value !== "unknown"
	) {
		throw new TypeError("recovered action receipt has an unsupported outcome.");
	}
	return value;
}

function requireWorkflowPhase(value: unknown): string {
	if (
		value !== "dispatched" &&
		value !== "candidate_created" &&
		value !== "acceptance_passed" &&
		value !== "review_approved" &&
		value !== "promotion_approval_pending" &&
		value !== "promotion_pending" &&
		value !== "promotion_reconciliation_required" &&
		value !== "promotion_reconciliation_resolved" &&
		value !== "promoted" &&
		value !== "cancellation_requested" &&
		value !== "rejected" &&
		value !== "completed" &&
		value !== "failed" &&
		value !== "cancelled"
	) {
		throw new TypeError("recovery.phase is not a supported workflow phase.");
	}
	return value;
}
