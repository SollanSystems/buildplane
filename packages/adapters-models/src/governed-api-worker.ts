import { createHash } from "node:crypto";
import type {
	ActionReceiptRecordedV2,
	ActionRedactionV2,
	ActionRequestedV2,
	ActionResourceUsageV2,
	DurableActionReceiptReferenceV2,
	DurableActionRequestV2,
	ExecutionReceipt,
	ExecutionRoleV1,
	GovernedActionEvidencePort,
	GovernedActivityClaimPort,
	GovernedActivityResultOutcomeV1,
	GovernedDispatchLineageV3,
	GovernedReviewCandidateContextV1,
	GovernedWorkerExecutionPort,
	GrantedGovernedActivityClaimV1,
	RecordActionReceiptV2Input,
	ReviewVerdictOutputV1,
	ReviewVerdictV1,
	TaskIntent,
	UnitPacket,
} from "@buildplane/kernel";
import {
	canonicalActionReceiptRecordedV2Digest,
	canonicalActionRequestedV2Digest,
	canonicalCandidateViewV1Digest as canonicalKernelCandidateViewV1Digest,
	canonicalGovernedUnitPacketV1Digest as canonicalKernelGovernedUnitPacketV1Digest,
	canonicalReviewVerdictOutputV1Digest as canonicalKernelReviewVerdictOutputV1Digest,
	parseActionReceiptRecordedV2,
	parseActionRequestedV2,
	parseGovernedUnitPacket,
	parseReviewVerdictV1,
} from "@buildplane/kernel";
import type {
	ModelActionAuthorizedV2,
	ModelActionCandidateBindingV1,
	ModelActionIntentV1,
	ModelRequestEvidenceV1,
	TrustScopeEvidenceV1,
} from "@buildplane/ledger-client";
import { isTrustedGovernedActivityClaimPort } from "./governed-activity-claim-provenance.js";
import { isRegisteredNativeModelActionAuthorityResolver } from "./governed-model-authority-provenance.js";
import {
	isTrustedGovernedModelActionGateway,
	trustedGovernedModelActionGatewayAuthorizeAndComplete,
} from "./governed-model-gateway-provenance.js";

/** The only API identities admitted by this worker; CLI host identities are excluded. */
export type GovernedApiProvider = "anthropic" | "openai";

/** V3's reviewable roles; `candidate` is intentionally not a provider-worker role. */
export type GovernedApiExecutionRole = Exclude<ExecutionRoleV1, "candidate">;

/**
 * Declarative tool contract visible to a model. This worker has no tool
 * executor: a returned call always blocks rather than falling through to a
 * shell or filesystem. A later typed action-plane adapter may consume this
 * vocabulary explicitly.
 */
export interface GovernedApiToolCapabilityV1 {
	readonly schemaVersion: 1;
	readonly capabilityId: string;
	readonly kind: "mcp" | "a2a" | "external_service";
	readonly inputSchemaDigest: string;
	readonly outputSchemaDigest: string;
}

/** A model-proposed capability call. It is never executed by this adapter. */
export interface GovernedApiToolCallV1 {
	readonly schemaVersion: 1;
	readonly capabilityId: string;
	readonly input: unknown;
}

/**
 * The credential-free portion of an API request. The injected host client owns
 * any provider credentials and must not add them to this structure.
 */
export interface GovernedApiModelInput {
	readonly provider: GovernedApiProvider;
	readonly model: string;
	readonly prompt: string;
	readonly systemPrompt?: string;
	readonly context?: TaskIntent["context"];
	readonly expectedCandidateDigest?: string;
	/** Present only for reviewer/adversary/judge model actions. */
	readonly reviewCandidate?: GovernedReviewCandidateDescriptorV1;
	readonly toolCapabilities: readonly GovernedApiToolCapabilityV1[];
}

/**
 * The immutable effect budget derived from the signed dispatch.  The gateway
 * receives an absolute deadline rather than a duration so queueing, retries,
 * and clock time spent before the provider boundary cannot extend authority.
 * `maxTotalTokens` is the complete prompt-plus-completion allowance, not a
 * provider-specific output-only hint.
 */
export interface GovernedApiModelBudgetV1 {
	readonly schemaVersion: 1;
	readonly deadlineAt: string;
	readonly maxTotalTokens?: number;
}

/**
 * Role-derived closed output schema supplied to a provider's native structured
 * output feature. The digest is deterministic from the signed execution role;
 * it is never accepted from a prompt, worker, or factory option.
 */
export interface GovernedApiResponseSchemaV1 {
	readonly schemaVersion: 1;
	readonly kind: "implementer_completion_v1" | "review_verdict_v1";
	readonly digest: string;
}

/** Input passed to the injected API host client. It deliberately has no credentials field. */
export interface GovernedApiClientRequest extends GovernedApiModelInput {
	readonly executionRole: GovernedApiExecutionRole;
	/** Signed, request-bound provider limit enforced by the host gateway. */
	readonly budget: GovernedApiModelBudgetV1;
	/** The gateway must apply this exact schema natively or deny the action. */
	readonly responseSchema: GovernedApiResponseSchemaV1;
	readonly structuredOutputRequired: true;
	readonly signal: AbortSignal;
}

/** Host-observed usage facts eligible for a durable action receipt. */
export interface GovernedApiClientUsage {
	readonly wallTimeMs?: number;
	readonly inputBytes?: number;
	readonly outputBytes?: number;
	/** Provider-reported prompt tokens. Required when maxTotalTokens is set. */
	readonly inputTokens?: number;
	/** Provider-reported completion tokens. Required when maxTotalTokens is set. */
	readonly outputTokens?: number;
}

/** Raw provider response at the adapter boundary. `completion` is parsed by role below. */
export interface GovernedApiClientResponse {
	readonly completion: unknown;
	readonly toolCalls?: readonly GovernedApiToolCallV1[];
	readonly resourceUsage?: GovernedApiClientUsage;
}

/**
 * Provider-neutral, injected API transport. Provider SDK setup and credentials
 * remain inside this host-owned object; there is no SDK, environment, or CLI
 * fallback in the governed worker.
 */
export interface GovernedApiClient {
	complete(input: GovernedApiClientRequest): Promise<GovernedApiClientResponse>;
}

/**
 * Immutable, host-verified candidate material available to review roles only.
 * The worker receives no writable project path, credentials, or ambient tools.
 */
export type GovernedReviewCandidateDescriptorV1 =
	GovernedReviewCandidateContextV1;

/** The worker-side authority limits the host gate must enforce for this action. */
export interface GovernedModelActionConstraintsV1 {
	readonly schemaVersion: 1;
	/** Exact signed dispatch budget that constrains the provider HTTP effect. */
	readonly budget: GovernedApiModelBudgetV1;
	readonly responseSchema: GovernedApiResponseSchemaV1;
	readonly structuredOutputRequired: true;
	readonly reviewOnly: boolean;
	readonly filesystemAccess: "none" | "candidate-read-only";
	readonly processAccess: "none";
	readonly toolCapabilities: readonly string[];
	readonly workerSecretAccess: "none";
	readonly workerNetworkAccess: "none";
	readonly brokeredModelNetwork: "provider-only";
}

/**
 * Immutable V1 request delivered to the host-owned model ActionGateway after
 * the durable action-request write. It contains every authority input the
 * gateway must evaluate and is intentionally credential-free.
 */
export interface GovernedModelActionGatewayRequestV1 {
	readonly schemaVersion: 1;
	readonly actionId: string;
	readonly idempotencyKey: string;
	readonly actionRequestRef: string;
	readonly actionRequestDigest: string;
	/** Canonical, credential-free digest of the exact request the gateway sees. */
	readonly modelRequestDigest: string;
	readonly dispatch: GovernedDispatchLineageV3;
	readonly executionRole: GovernedApiExecutionRole;
	readonly packetAuthority: {
		readonly provenanceRef: string;
		readonly capabilityBundleDigest: string;
		readonly acceptanceContractDigest: string;
		readonly trustScopeDigest: string;
		readonly policyDigest: string;
		readonly sandboxProfileDigest: string;
	};
	readonly constraints: GovernedModelActionConstraintsV1;
	readonly modelRequest: GovernedApiClientRequest;
	readonly reviewCandidate?: GovernedReviewCandidateDescriptorV1;
	/** Opaque native-backed V2 authority verified again by the host ActionGateway. */
	readonly modelActionAuthority: VerifiedModelActionAuthorityV2;
}

/** Explicit host-gateway outcome bound to the exact model action request. */
export interface GovernedModelActionAuthorizationV1 {
	readonly schemaVersion: 1;
	readonly decision: "allow" | "deny";
	readonly actionId: string;
	readonly idempotencyKey: string;
	readonly actionRequestDigest: string;
	readonly modelRequestDigest: string;
	readonly dispatchEnvelopeDigest: string;
	readonly acceptanceContractDigest: string;
	readonly trustScopeDigest: string;
	readonly policyDigest: string;
	readonly sandboxProfileDigest: string;
	readonly executionRole: GovernedApiExecutionRole;
	readonly candidateDigest?: string;
	readonly candidateViewDigest?: string;
	readonly authorizationRef: string;
	readonly denialCode?: string;
}

/** A host gate either denies before an effect or returns the brokered response. */
export interface GovernedModelActionGatewayResultV1 {
	readonly authorization: GovernedModelActionAuthorizationV1;
	readonly response?: GovernedApiClientResponse;
}

/**
 * The sole API-effect boundary for this worker. The gateway owns provider
 * credentials and network access, evaluates the signed dispatch/role/policy/
 * sandbox/candidate context, and must be frozen for the life of the run.
 */
export interface GovernedModelActionGateway {
	/**
	 * Host-owned provider boundary. It must recheck the dispatch and native
	 * authority expiry immediately before issuing the provider request, after
	 * every queue/wait internal to the gateway. The adapter's pre-gateway check
	 * is defense in depth, not a substitute for this effect-edge check. Expiry
	 * bounds completion in the governed lane: the gateway must impose a deadline
	 * that leaves time to persist a terminal receipt and report an unknown effect
	 * if a provider may have received work but cannot complete before expiry.
	 *
	 * The credential holder must atomically claim/consume `authorizationRef` (or
	 * the action-request/idempotency identity) immediately before HTTP. A second
	 * caller must be denied or reconciled, never issue another provider call; a
	 * crash after claim is an unknown effect unless provider idempotency proves
	 * the result.
	 */
	authorizeAndComplete(
		input: GovernedModelActionGatewayRequestV1,
	): Promise<GovernedModelActionGatewayResultV1>;
}

/**
 * Complete post-write-ahead binding supplied to the native V2 authority
 * resolver. The resolver returns the signed parent `ModelActionIntentV1` and
 * child `ModelActionAuthorizedV2` records. The adapter never mints either
 * record and deliberately does not accept the retired flat V1 grant shape.
 */
export interface GovernedModelActionAuthorityInputV2 {
	readonly schemaVersion: 2;
	readonly dispatch: GovernedDispatchLineageV3;
	/** Exact action identity from the already-durable ActionRequestedV2 record. */
	readonly actionId: string;
	/** Exact idempotency identity from the already-durable ActionRequestedV2 record. */
	readonly idempotencyKey: string;
	/** UUID of the durable ActionRequestedV2 parent event. */
	readonly actionRequestEventRef: string;
	readonly actionRequestDigest: string;
	readonly canonicalInputRef: string;
	readonly canonicalInputDigest: string;
	readonly executionRole: GovernedApiExecutionRole;
	/** Present exactly for reviewer/adversary/judge actions. */
	readonly reviewCandidate?: GovernedReviewCandidateDescriptorV1;
}

/**
 * Native resolver output before this module mints its opaque capability. The
 * parent event reference is carried beside the generated payload because an
 * event id is metadata, not a field of ModelActionIntentV1 itself.
 */
export interface GovernedModelActionAuthorityGrantV2 {
	readonly schemaVersion: 2;
	readonly intentEventRef: string;
	readonly intent: ModelActionIntentV1;
	readonly authorization: ModelActionAuthorizedV2;
}

/**
 * Opaque, module-minted capability. Callers can inspect it for telemetry, but
 * cannot construct an object accepted by `isVerifiedModelActionAuthority`.
 */
export interface VerifiedModelActionAuthorityV2
	extends GovernedModelActionAuthorityGrantV2 {
	readonly verifiedAt: string;
}

/**
 * Internal host-only bridge to the future native transactional authority RPC.
 * It must verify the signed dispatch/request and atomically resolve-or-append
 * parented `ModelActionIntentV1` plus `ModelActionAuthorizedV2`; a
 * TapeEmitter, SQLite row, or JS-only lookup is
 * not an acceptable implementation. The current CLI deliberately does not
 * construct this resolver, so governed runs remain preview-only until that
 * native RPC exists.
 *
 * @internal
 */
export interface NativeModelActionAuthorityResolver {
	authorize(
		input: GovernedModelActionAuthorityInputV2,
	): Promise<GovernedModelActionAuthorityGrantV2>;
}

/**
 * Immutable host-owned authority port. It is intentionally injected by a
 * trusted composition root, never by a worker packet or model response.
 *
 * @internal
 */
export interface GovernedModelActionAuthorityPort {
	bind(
		input: GovernedModelActionAuthorityInputV2,
	): Promise<VerifiedModelActionAuthorityV2>;
}

const verifiedModelActionAuthorities = new WeakSet<object>();

/**
 * @internal
 *
 * Host-composition seam used by the future native live-authority RPC and by
 * focused adapter tests. It establishes object provenance and immutable
 * binding only; it cannot turn an arbitrary JavaScript resolver into a
 * cryptographic verifier. Do not export or wire this into a governed CLI path
 * until the resolver is backed by native verified replay plus atomic signed
 * resolve-or-authorize semantics.
 */
export function createGovernedModelActionAuthorityPort(input: {
	readonly resolver: NativeModelActionAuthorityResolver;
	readonly now?: () => string;
}): GovernedModelActionAuthorityPort {
	if (
		input === null ||
		typeof input !== "object" ||
		!input.resolver ||
		typeof input.resolver.authorize !== "function"
	) {
		throw new TypeError(
			"createGovernedModelActionAuthorityPort requires a native-backed authority resolver.",
		);
	}
	if (!isRegisteredNativeModelActionAuthorityResolver(input.resolver)) {
		throw new TypeError(
			"createGovernedModelActionAuthorityPort requires a resolver registered by the trusted native authority bridge.",
		);
	}
	const resolver = input.resolver;
	const now = input.now ?? (() => new Date().toISOString());
	if (typeof now !== "function") {
		throw new TypeError(
			"createGovernedModelActionAuthorityPort now must be a function when provided.",
		);
	}
	const authorize = resolver.authorize.bind(resolver);
	return Object.freeze({
		async bind(authorityInput: GovernedModelActionAuthorityInputV2) {
			const grant = normalizeModelActionAuthorityGrant(
				await authorize(authorityInput),
				authorityInput,
				readTimestamp(now, "governed model authority verifiedAt"),
			);
			verifiedModelActionAuthorities.add(grant);
			return grant;
		},
	});
}

/** @internal Predicate for the host provider gateway; no minting capability is public. */
export function isVerifiedModelActionAuthority(
	input: unknown,
): input is VerifiedModelActionAuthorityV2 {
	return (
		typeof input === "object" &&
		input !== null &&
		verifiedModelActionAuthorities.has(input)
	);
}

/**
 * Reparses and freezes a native V2 authority bundle before it crosses into the
 * provider adapter. The native bridge is responsible for detached signatures,
 * tape parentage, and atomic claim/consume semantics. This boundary proves
 * that the returned authorization still repeats the exact parent intent and
 * dynamic evidence that existed at the provider-effect edge.
 */
function normalizeModelActionAuthorityGrant(
	input: unknown,
	expected: GovernedModelActionAuthorityInputV2,
	verifiedAt: string,
): VerifiedModelActionAuthorityV2 {
	const record = readClosedRecord(
		input,
		"governed model action authority V2 grant",
		["schemaVersion", "intentEventRef", "intent", "authorization"],
	);
	if (record.schemaVersion !== 2) {
		throw new TypeError(
			"governed model action authority grant schemaVersion must be 2.",
		);
	}
	const grant: VerifiedModelActionAuthorityV2 = Object.freeze({
		schemaVersion: 2,
		intentEventRef: assertLedgerEventId(
			record.intentEventRef,
			"governed model action authority grant intentEventRef",
		),
		intent: normalizeModelActionIntentV1(record.intent),
		authorization: normalizeModelActionAuthorizedV2(record.authorization),
		verifiedAt,
	});
	assertVerifiedModelActionAuthorityMatches(grant, expected);
	if (grant.intent.intent_actor !== expected.dispatch.authorityActor) {
		throw new TypeError(
			"governed model action intent signer must match the signed dispatch authority actor.",
		);
	}
	if (
		grant.authorization.authorization_actor !== expected.dispatch.authorityActor
	) {
		throw new TypeError(
			"governed model action authority grant signer must match the signed dispatch authority actor.",
		);
	}
	if (
		grant.intent.intent_digest !==
		canonicalModelActionIntentV1Digest(grant.intent)
	) {
		throw new TypeError(
			"governed model action intent intent_digest does not match the native canonical record.",
		);
	}
	if (
		grant.authorization.authorization_digest !==
		canonicalModelActionAuthorizedV2Digest(grant.authorization)
	) {
		throw new TypeError(
			"governed model action authority authorization_digest does not match the native canonical record.",
		);
	}
	if (!isModelActionAuthorityUnexpired(grant, verifiedAt)) {
		throw new TypeError(
			"governed model action authority grant is already expired.",
		);
	}
	if (
		Date.parse(grant.authorization.expires_at) >
		Date.parse(expected.dispatch.expiresAt)
	) {
		throw new TypeError(
			"governed model action authority grant must not outlive its dispatch.",
		);
	}
	return grant;
}

/**
 * Recompute the native `ModelActionIntentV1` digest. This boundary duplicates
 * the canonical material so a bridge cannot modify the parent intent between
 * tape verification and the provider gateway.
 */
export function canonicalModelActionIntentV1Digest(
	input: Omit<ModelActionIntentV1, "intent_digest">,
): string {
	const candidateBinding = optionalModelActionCandidateBinding(
		input.candidate_binding,
		"governed model action intent candidate_binding",
	);
	return sha256WithDomain(
		"buildplane.model-action-intent.v1\u0000",
		JSON.stringify({
			run_id: assertNonEmptyString(
				input.run_id,
				"governed model action intent run_id",
			),
			workflow_id: assertNonEmptyString(
				input.workflow_id,
				"governed model action intent workflow_id",
			),
			unit_id: assertNonEmptyString(
				input.unit_id,
				"governed model action intent unit_id",
			),
			attempt: assertPositiveSafeInteger(
				input.attempt,
				"governed model action intent attempt",
			),
			provenance_ref: assertNonEmptyString(
				input.provenance_ref,
				"governed model action intent provenance_ref",
			),
			action_id: assertNonEmptyString(
				input.action_id,
				"governed model action intent action_id",
			),
			idempotency_key: assertNonEmptyString(
				input.idempotency_key,
				"governed model action intent idempotency_key",
			),
			dispatch_event_ref: assertLedgerEventId(
				input.dispatch_event_ref,
				"governed model action intent dispatch_event_ref",
			),
			dispatch_envelope_digest: assertSha256Digest(
				input.dispatch_envelope_digest,
				"governed model action intent dispatch_envelope_digest",
			),
			action_request_event_ref: assertLedgerEventId(
				input.action_request_event_ref,
				"governed model action intent action_request_event_ref",
			),
			action_request_digest: assertSha256Digest(
				input.action_request_digest,
				"governed model action intent action_request_digest",
			),
			canonical_input_ref: assertCanonicalCasReference(
				input.canonical_input_ref,
				"governed model action intent canonical_input_ref",
			),
			canonical_input_digest: assertSha256Digest(
				input.canonical_input_digest,
				"governed model action intent canonical_input_digest",
			),
			model_request_evidence: normalizeModelRequestEvidence(
				input.model_request_evidence,
				"governed model action intent model_request_evidence",
			),
			trust_scope_evidence: normalizeTrustScopeEvidence(
				input.trust_scope_evidence,
				"governed model action intent trust_scope_evidence",
			),
			candidate_binding: candidateBinding ?? null,
			intent_actor: assertCanonicalAuthorityActor(
				input.intent_actor,
				"governed model action intent intent_actor",
			),
			intended_at: assertRfc3339UtcTimestamp(
				input.intended_at,
				"governed model action intent intended_at",
			),
		}),
	);
}

/**
 * Recompute the native `ModelActionAuthorizedV2` digest. The authorization
 * repeats every dynamic evidence descriptor from its parent intent, so a
 * changed provider request, trust scope, or candidate view changes this
 * digest and is rejected before the gateway receives authority.
 */
export function canonicalModelActionAuthorizedV2Digest(
	input: Omit<ModelActionAuthorizedV2, "authorization_digest">,
): string {
	const candidateBinding = optionalModelActionCandidateBinding(
		input.candidate_binding,
		"governed model action authorization candidate_binding",
	);
	return sha256WithDomain(
		"buildplane.model-action-authorized.v2\u0000",
		JSON.stringify({
			intent_event_ref: assertLedgerEventId(
				input.intent_event_ref,
				"governed model action authorization intent_event_ref",
			),
			intent_digest: assertSha256Digest(
				input.intent_digest,
				"governed model action authorization intent_digest",
			),
			model_request_evidence: normalizeModelRequestEvidence(
				input.model_request_evidence,
				"governed model action authorization model_request_evidence",
			),
			trust_scope_evidence: normalizeTrustScopeEvidence(
				input.trust_scope_evidence,
				"governed model action authorization trust_scope_evidence",
			),
			candidate_binding: candidateBinding ?? null,
			authorization_actor: assertCanonicalAuthorityActor(
				input.authorization_actor,
				"governed model action authorization authorization_actor",
			),
			expires_at: assertRfc3339UtcTimestamp(
				input.expires_at,
				"governed model action authorization expires_at",
			),
			authorization_ref: assertNonEmptyString(
				input.authorization_ref,
				"governed model action authorization authorization_ref",
			),
		}),
	);
}

function normalizeModelActionIntentV1(input: unknown): ModelActionIntentV1 {
	const record = readClosedRecord(input, "governed model action intent", [
		"run_id",
		"workflow_id",
		"unit_id",
		"attempt",
		"provenance_ref",
		"action_id",
		"idempotency_key",
		"dispatch_event_ref",
		"dispatch_envelope_digest",
		"action_request_event_ref",
		"action_request_digest",
		"canonical_input_ref",
		"canonical_input_digest",
		"model_request_evidence",
		"trust_scope_evidence",
		"candidate_binding",
		"intent_actor",
		"intended_at",
		"intent_digest",
	]);
	const intent: ModelActionIntentV1 = Object.freeze({
		run_id: assertNonEmptyString(
			record.run_id,
			"governed model action intent run_id",
		),
		workflow_id: assertNonEmptyString(
			record.workflow_id,
			"governed model action intent workflow_id",
		),
		unit_id: assertNonEmptyString(
			record.unit_id,
			"governed model action intent unit_id",
		),
		attempt: assertPositiveSafeInteger(
			record.attempt,
			"governed model action intent attempt",
		),
		provenance_ref: assertNonEmptyString(
			record.provenance_ref,
			"governed model action intent provenance_ref",
		),
		action_id: assertNonEmptyString(
			record.action_id,
			"governed model action intent action_id",
		),
		idempotency_key: assertNonEmptyString(
			record.idempotency_key,
			"governed model action intent idempotency_key",
		),
		dispatch_event_ref: assertLedgerEventId(
			record.dispatch_event_ref,
			"governed model action intent dispatch_event_ref",
		),
		dispatch_envelope_digest: assertSha256Digest(
			record.dispatch_envelope_digest,
			"governed model action intent dispatch_envelope_digest",
		),
		action_request_event_ref: assertLedgerEventId(
			record.action_request_event_ref,
			"governed model action intent action_request_event_ref",
		),
		action_request_digest: assertSha256Digest(
			record.action_request_digest,
			"governed model action intent action_request_digest",
		),
		canonical_input_ref: assertCanonicalCasReference(
			record.canonical_input_ref,
			"governed model action intent canonical_input_ref",
		),
		canonical_input_digest: assertSha256Digest(
			record.canonical_input_digest,
			"governed model action intent canonical_input_digest",
		),
		model_request_evidence: normalizeModelRequestEvidence(
			record.model_request_evidence,
			"governed model action intent model_request_evidence",
		),
		trust_scope_evidence: normalizeTrustScopeEvidence(
			record.trust_scope_evidence,
			"governed model action intent trust_scope_evidence",
		),
		...(record.candidate_binding === undefined
			? {}
			: {
					candidate_binding: normalizeModelActionCandidateBinding(
						record.candidate_binding,
						"governed model action intent candidate_binding",
					),
				}),
		intent_actor: assertCanonicalAuthorityActor(
			record.intent_actor,
			"governed model action intent intent_actor",
		),
		intended_at: assertRfc3339UtcTimestamp(
			record.intended_at,
			"governed model action intent intended_at",
		),
		intent_digest: assertSha256Digest(
			record.intent_digest,
			"governed model action intent intent_digest",
		),
	});
	if (intent.intent_digest !== canonicalModelActionIntentV1Digest(intent)) {
		throw new TypeError(
			"governed model action intent intent_digest does not match the native canonical record.",
		);
	}
	return intent;
}

function normalizeModelActionAuthorizedV2(
	input: unknown,
): ModelActionAuthorizedV2 {
	const record = readClosedRecord(
		input,
		"governed model action authorization",
		[
			"intent_event_ref",
			"intent_digest",
			"model_request_evidence",
			"trust_scope_evidence",
			"candidate_binding",
			"authorization_actor",
			"expires_at",
			"authorization_ref",
			"authorization_digest",
		],
	);
	const authorization: ModelActionAuthorizedV2 = Object.freeze({
		intent_event_ref: assertLedgerEventId(
			record.intent_event_ref,
			"governed model action authorization intent_event_ref",
		),
		intent_digest: assertSha256Digest(
			record.intent_digest,
			"governed model action authorization intent_digest",
		),
		model_request_evidence: normalizeModelRequestEvidence(
			record.model_request_evidence,
			"governed model action authorization model_request_evidence",
		),
		trust_scope_evidence: normalizeTrustScopeEvidence(
			record.trust_scope_evidence,
			"governed model action authorization trust_scope_evidence",
		),
		...(record.candidate_binding === undefined
			? {}
			: {
					candidate_binding: normalizeModelActionCandidateBinding(
						record.candidate_binding,
						"governed model action authorization candidate_binding",
					),
				}),
		authorization_actor: assertCanonicalAuthorityActor(
			record.authorization_actor,
			"governed model action authorization authorization_actor",
		),
		expires_at: assertRfc3339UtcTimestamp(
			record.expires_at,
			"governed model action authorization expires_at",
		),
		authorization_ref: assertNonEmptyString(
			record.authorization_ref,
			"governed model action authorization authorization_ref",
		),
		authorization_digest: assertSha256Digest(
			record.authorization_digest,
			"governed model action authorization authorization_digest",
		),
	});
	if (
		authorization.authorization_digest !==
		canonicalModelActionAuthorizedV2Digest(authorization)
	) {
		throw new TypeError(
			"governed model action authorization authorization_digest does not match the native canonical record.",
		);
	}
	return authorization;
}

function normalizeModelRequestEvidence(
	input: unknown,
	label: string,
): ModelRequestEvidenceV1 {
	const record = readClosedRecord(input, label, [
		"schema_version",
		"cas_ref",
		"digest",
	]);
	const digest = assertSha256Digest(record.digest, `${label}.digest`);
	return Object.freeze({
		schema_version: assertEvidenceSchemaVersion(record.schema_version, label),
		cas_ref: assertDigestCasReference(
			record.cas_ref,
			digest,
			`${label}.cas_ref`,
		),
		digest,
	});
}

function normalizeTrustScopeEvidence(
	input: unknown,
	label: string,
): TrustScopeEvidenceV1 {
	const record = readClosedRecord(input, label, [
		"schema_version",
		"cas_ref",
		"digest",
	]);
	const digest = assertSha256Digest(record.digest, `${label}.digest`);
	return Object.freeze({
		schema_version: assertEvidenceSchemaVersion(record.schema_version, label),
		cas_ref: assertDigestCasReference(
			record.cas_ref,
			digest,
			`${label}.cas_ref`,
		),
		digest,
	});
}

function optionalModelActionCandidateBinding(
	input: unknown,
	label: string,
): ModelActionCandidateBindingV1 | undefined {
	return input === undefined
		? undefined
		: normalizeModelActionCandidateBinding(input, label);
}

function normalizeModelActionCandidateBinding(
	input: unknown,
	label: string,
): ModelActionCandidateBindingV1 {
	const record = readClosedRecord(input, label, [
		"candidate_created_event_ref",
		"candidate_digest",
		"candidate_commit_sha",
		"candidate_view_ref",
		"candidate_view_digest",
		"candidate_view",
	]);
	const candidateView = normalizeNativeCandidateView(
		record.candidate_view,
		`${label}.candidate_view`,
	);
	const binding: ModelActionCandidateBindingV1 = Object.freeze({
		candidate_created_event_ref: assertLedgerEventId(
			record.candidate_created_event_ref,
			`${label}.candidate_created_event_ref`,
		),
		candidate_digest: assertSha256Digest(
			record.candidate_digest,
			`${label}.candidate_digest`,
		),
		candidate_commit_sha: assertCommitSha(
			record.candidate_commit_sha,
			`${label}.candidate_commit_sha`,
		),
		candidate_view_ref: assertCanonicalCasReference(
			record.candidate_view_ref,
			`${label}.candidate_view_ref`,
		),
		candidate_view_digest: assertSha256Digest(
			record.candidate_view_digest,
			`${label}.candidate_view_digest`,
		),
		candidate_view: candidateView,
	});
	if (
		binding.candidate_view.candidate_digest !== binding.candidate_digest ||
		binding.candidate_view.candidate_commit_sha !==
			binding.candidate_commit_sha ||
		binding.candidate_view_digest !==
			canonicalNativeCandidateViewV1Digest(candidateView)
	) {
		throw new TypeError(
			`${label} must bind a canonical immutable candidate view.`,
		);
	}
	return binding;
}

function normalizeNativeCandidateView(
	input: unknown,
	label: string,
): ModelActionCandidateBindingV1["candidate_view"] {
	const record = readClosedRecord(input, label, [
		"candidate_ref",
		"candidate_digest",
		"candidate_commit_sha",
		"tree_digest",
		"reviewer_context_manifest_digest",
		"reviewer_sandbox_profile_digest",
		"mount_path_digest",
		"read_only",
		"network_disabled",
	]);
	const view = Object.freeze({
		candidate_ref: assertCandidateRef(
			record.candidate_ref,
			`${label}.candidate_ref`,
		),
		candidate_digest: assertSha256Digest(
			record.candidate_digest,
			`${label}.candidate_digest`,
		),
		candidate_commit_sha: assertCommitSha(
			record.candidate_commit_sha,
			`${label}.candidate_commit_sha`,
		),
		tree_digest: assertSha256Digest(record.tree_digest, `${label}.tree_digest`),
		reviewer_context_manifest_digest: assertSha256Digest(
			record.reviewer_context_manifest_digest,
			`${label}.reviewer_context_manifest_digest`,
		),
		reviewer_sandbox_profile_digest: assertSha256Digest(
			record.reviewer_sandbox_profile_digest,
			`${label}.reviewer_sandbox_profile_digest`,
		),
		mount_path_digest: assertSha256Digest(
			record.mount_path_digest,
			`${label}.mount_path_digest`,
		),
		read_only: assertExactBoolean(record.read_only, `${label}.read_only`),
		network_disabled: assertExactBoolean(
			record.network_disabled,
			`${label}.network_disabled`,
		),
	});
	if (!view.read_only || !view.network_disabled) {
		throw new TypeError(`${label} must be read-only with network disabled.`);
	}
	return view;
}

function canonicalNativeCandidateViewV1Digest(
	input: ModelActionCandidateBindingV1["candidate_view"],
): string {
	return sha256WithDomain(
		"buildplane.candidate-view.v1\u0000",
		JSON.stringify(input),
	);
}

function assertIntentCandidateBindingMatchesExpected(
	intent: ModelActionIntentV1,
	expected: GovernedModelActionAuthorityInputV2,
): void {
	const binding = intent.candidate_binding;
	if (!isReviewRole(expected.executionRole)) {
		if (binding !== undefined) {
			throw new TypeError(
				"governed implementer model action intent must not bind a review candidate.",
			);
		}
		return;
	}
	const candidate = expected.reviewCandidate;
	if (candidate === undefined || binding === undefined) {
		throw new TypeError(
			"governed reviewer, adversary, and judge model action authority requires a candidate view binding.",
		);
	}
	const view = binding.candidate_view;
	if (
		binding.candidate_digest !== candidate.candidateDigest ||
		binding.candidate_commit_sha !== candidate.candidateCommitSha ||
		binding.candidate_view_ref !== candidate.candidateViewRef ||
		binding.candidate_view_digest !== candidate.candidateViewDigest ||
		view.candidate_ref !== candidate.candidateRef ||
		view.candidate_digest !== candidate.candidateDigest ||
		view.candidate_commit_sha !== candidate.candidateCommitSha ||
		view.tree_digest !== candidate.candidateTreeDigest ||
		view.reviewer_context_manifest_digest !==
			candidate.context.contextManifestDigest ||
		view.reviewer_sandbox_profile_digest !==
			expected.dispatch.sandboxProfileDigest ||
		view.mount_path_digest !== candidate.readOnlyMount.mountDigest ||
		!view.read_only ||
		!view.network_disabled
	) {
		throw new TypeError(
			"governed model action candidate binding does not match the immutable read-only candidate view.",
		);
	}
}

function canonicalJsonEqual(
	left: unknown,
	right: unknown,
	label: string,
): boolean {
	if (left === undefined || right === undefined) {
		return left === right;
	}
	return (
		JSON.stringify(canonicalizeJsonValue(left, label, new Set<object>())) ===
		JSON.stringify(canonicalizeJsonValue(right, label, new Set<object>()))
	);
}

function assertVerifiedModelActionAuthorityMatches(
	grant: VerifiedModelActionAuthorityV2,
	expected: GovernedModelActionAuthorityInputV2,
): void {
	const intent = grant.intent;
	if (
		grant.schemaVersion !== 2 ||
		intent.run_id !== expected.dispatch.runId ||
		intent.workflow_id !== expected.dispatch.workflowId ||
		intent.unit_id !== expected.dispatch.unitId ||
		intent.attempt !== expected.dispatch.attempt ||
		intent.provenance_ref !== expected.dispatch.provenanceRef ||
		intent.action_id !== expected.actionId ||
		intent.idempotency_key !== expected.idempotencyKey ||
		intent.dispatch_event_ref !==
			assertLedgerEventId(
				expected.dispatch.dispatchEnvelopeRef,
				"governed model action authority expected dispatchEnvelopeRef",
			) ||
		intent.dispatch_envelope_digest !== expected.dispatch.envelopeDigest ||
		intent.action_request_event_ref !== expected.actionRequestEventRef ||
		intent.action_request_digest !== expected.actionRequestDigest ||
		intent.canonical_input_ref !== expected.canonicalInputRef ||
		intent.canonical_input_digest !== expected.canonicalInputDigest
	) {
		throw new TypeError(
			"governed model action intent does not bind the exact signed dispatch and post-write-ahead model action.",
		);
	}
	assertIntentCandidateBindingMatchesExpected(intent, expected);
	const authorization = grant.authorization;
	if (
		authorization.intent_event_ref !== grant.intentEventRef ||
		authorization.intent_digest !== intent.intent_digest ||
		!canonicalJsonEqual(
			authorization.model_request_evidence,
			intent.model_request_evidence,
			"governed model authorization model request evidence",
		) ||
		!canonicalJsonEqual(
			authorization.trust_scope_evidence,
			intent.trust_scope_evidence,
			"governed model authorization trust scope evidence",
		) ||
		!canonicalJsonEqual(
			authorization.candidate_binding,
			intent.candidate_binding,
			"governed model authorization candidate binding",
		)
	) {
		throw new TypeError(
			"governed model action authorization must repeat its exact parent intent event, digest, and dynamic evidence.",
		);
	}
}

function isModelActionAuthorityUnexpired(
	grant: VerifiedModelActionAuthorityV2,
	observedAt: string,
): boolean {
	return Date.parse(grant.authorization.expires_at) > Date.parse(observedAt);
}

/** Closed completion vocabulary for an implementer model response. */
export interface ImplementerCompletionV1 {
	readonly schemaVersion: 1;
	readonly outcome: "completed";
	readonly summary: string;
	readonly outputRefs: readonly string[];
}

export type GovernedWorkerCompletionV1 =
	| ImplementerCompletionV1
	| ReviewVerdictV1;

/**
 * Canonical review-model output written as the model action result. Candidate
 * commit and view identity are derived from the kernel-owned descriptor, not
 * accepted from model text. This is the exact shape later bound by
 * ReviewVerdictRecordedV2 and its succeeded model receipt.
 */
export type GovernedReviewVerdictOutputV1 = ReviewVerdictOutputV1;

/**
 * Closed, redacted request-evidence binding written before provider authority is
 * requested. It deliberately carries digests rather than prompt content: the
 * worker recomputes `modelInputDigest` and `canonicalInputDigest` from the
 * exact credential-free request it will hand to the gateway. `canonicalInputRef`
 * is therefore a deterministic CAS address, not store-controlled metadata.
 */
export interface ModelInputEvidenceV1 {
	readonly schemaVersion: 1;
	/** Digest of the exact credential-free model input supplied to the gateway. */
	readonly modelInputDigest: string;
	/** Digest of the role/constraint-bound provider request. */
	readonly modelRequestDigest: string;
	readonly canonicalInputDigest: string;
	readonly canonicalInputRef: string;
	readonly redactions: readonly ActionRedactionV2[];
}

/**
 * Persisted, redacted success evidence needed by a V2 action receipt.
 *
 * The two CAS references are deliberately derived from their canonical
 * digests. A result store cannot substitute a well-formed reference from a
 * different action without changing one of the values the worker verifies
 * before it emits a succeeded receipt.
 */
export interface ModelResultEvidence {
	readonly schemaVersion: 1;
	readonly actionId: string;
	readonly actionRequestRef: string;
	readonly actionRequestDigest: string;
	readonly modelRequestDigest: string;
	readonly authorizationRef: string;
	readonly authorizationDigest: string;
	readonly resultDigest: string;
	readonly resultRef: string;
	readonly evidenceDigest: string;
	readonly evidenceRef: string;
	readonly redactions: readonly ActionRedactionV2[];
}

/** Input to the credential-free input-evidence write. */
export interface PersistCanonicalModelInput {
	readonly schemaVersion: 1;
	readonly modelInput: GovernedApiModelInput;
	readonly modelInputDigest: string;
	readonly modelRequestDigest: string;
}

/**
 * Input to the credential-free result-evidence write. The store must persist
 * exactly this binding under its derived CAS references; it may only add the
 * redaction set reflected by its returned evidence record.
 */
export interface PersistModelResult {
	readonly schemaVersion: 1;
	readonly actionId: string;
	readonly actionRequestRef: string;
	readonly actionRequestDigest: string;
	readonly modelRequestDigest: string;
	readonly authorizationRef: string;
	readonly authorizationDigest: string;
	readonly modelInput: GovernedApiModelInput;
	readonly completion: GovernedWorkerCompletionV1;
	/** Present exactly for review roles and persisted as the canonical result. */
	readonly reviewOutput?: GovernedReviewVerdictOutputV1;
}

/**
 * The host-owned evidence seam. It must persist and redact the canonical input
 * before authorization, and the normalized completion before a success receipt.
 * It has no credential fields by design.
 */
export interface GovernedModelEvidenceStore {
	persistCanonicalInput(
		input: PersistCanonicalModelInput,
	): Promise<ModelInputEvidenceV1>;
	persistModelResult(input: PersistModelResult): Promise<ModelResultEvidence>;
}

export type GovernedApiWorkerExecutionInput = Parameters<
	GovernedWorkerExecutionPort["executeCandidatePacketAsync"]
>[0];

export interface CreateGovernedApiWorkerExecutionPortOptions {
	/** Required immutable host-owned authorization and model-effect boundary. */
	readonly actionGateway: GovernedModelActionGateway;
	/**
	 * Required native-backed capability minting boundary. It runs only after the
	 * durable ActionRequestedV2 record exists and before a provider call.
	 */
	readonly modelActionAuthorityPort: GovernedModelActionAuthorityPort;
	/** Required credential-free durable evidence store. */
	readonly evidenceStore: GovernedModelEvidenceStore;
	/**
	 * Required native activity lease/result boundary. It is deliberately
	 * independent from action evidence so losing a receipt writer can never
	 * widen authority to invoke a provider API.
	 */
	readonly activityClaimPort: GovernedActivityClaimPort;
	/** Bounded native lease requested for one provider action. */
	readonly activityLeaseDurationMs?: number;
	/** Explicit, declarative tool contract; omitted means no tool capability. */
	readonly toolCapabilities?: readonly GovernedApiToolCapabilityV1[];
	/** Injectable clock for deterministic receipts. */
	readonly now?: () => string;
}

/** A client effect occurred but its terminal durable receipt is unavailable. */
export class GovernedApiUnknownEffectError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GovernedApiUnknownEffectError";
	}
}

/** Builds the API/SDK-only governed worker port with no ambient host fallback. */
export function createGovernedApiWorkerExecutionPort(
	options: CreateGovernedApiWorkerExecutionPortOptions,
): GovernedWorkerExecutionPort {
	const dependencies = captureCreateDependencies(options);
	const {
		authorizeAndComplete,
		bindModelActionAuthority,
		persistCanonicalInput,
		persistModelResult,
		activityClaimPort,
		activityLeaseDurationMs,
		now,
	} = dependencies;
	const toolCapabilities = normalizeToolCapabilities(
		dependencies.toolCapabilities,
	);
	if (toolCapabilities.length > 0) {
		throw new TypeError(
			"governed API worker does not accept configured tool capabilities until each typed tool action is derived from the signed capability bundle and routed through the action plane.",
		);
	}
	const port: GovernedWorkerExecutionPort = {
		async executeCandidatePacketAsync(input: GovernedApiWorkerExecutionInput) {
			const startedAt = readTimestamp(now, "governed API worker startedAt");
			const prepared = prepareExecutionInput(
				input,
				toolCapabilities,
				startedAt,
			);
			const modelActionRequest = createModelActionRequestDescriptor(prepared);
			const activityEvidencePort = createActivityBoundEvidencePort({
				actionEvidencePort: prepared.actionEvidencePort,
				activityClaimPort,
				dispatch: prepared.dispatch,
				leaseDurationMs: activityLeaseDurationMs,
			});
			const modelInputDigest = canonicalGovernedApiModelInputV1Digest(
				prepared.modelInput,
			);

			let canonicalInput: ModelInputEvidenceV1;
			try {
				canonicalInput = normalizeModelInputEvidence(
					await persistCanonicalInput({
						schemaVersion: 1,
						modelInput: prepared.modelInput,
						modelInputDigest,
						modelRequestDigest: modelActionRequest.modelRequestDigest,
					}),
				);
				assertModelInputEvidenceBinding(canonicalInput, {
					modelInput: prepared.modelInput,
					modelRequestDigest: modelActionRequest.modelRequestDigest,
				});
			} catch {
				throw new TypeError(
					"governed API worker could not persist canonical model input evidence before the API action.",
				);
			}

			const actionId = governedModelActionId(prepared.dispatch);
			const idempotencyKey = `${prepared.dispatch.idempotencyKey}:model`;
			const actionRequest: ActionRequestedV2 = {
				schemaVersion: 2,
				runId: prepared.dispatch.runId,
				workflowId: prepared.dispatch.workflowId,
				unitId: prepared.dispatch.unitId,
				attempt: prepared.dispatch.attempt,
				provenanceRef: prepared.dispatch.provenanceRef,
				actionId,
				idempotencyKey,
				actionKind: "model" as const,
				canonicalInputDigest: canonicalInput.canonicalInputDigest,
				canonicalInputRef: canonicalInput.canonicalInputRef,
				dispatchEnvelopeDigest: prepared.dispatch.envelopeDigest,
				capabilityBundleDigest: prepared.dispatch.capabilityBundleDigest,
				policyDigest: prepared.dispatch.policyDigest,
				contextManifestDigest: prepared.dispatch.contextManifestDigest,
				workerManifestDigest: prepared.dispatch.workerManifestDigest,
				sandboxProfileDigest: prepared.dispatch.sandboxProfileDigest,
				repositoryBindingDigest: prepared.dispatch.repositoryBindingDigest,
				ledgerAuthorityRealmDigest:
					prepared.dispatch.ledgerAuthorityRealmDigest,
				governedPacketDigest: prepared.dispatch.governedPacketDigest,
				authorityActor: prepared.dispatch.authorityActor,
				executionRole: prepared.executionRole,
				requestedAt: startedAt,
			};

			let recordedRequest: unknown;
			try {
				recordedRequest =
					await activityEvidencePort.recordActionRequested(actionRequest);
			} catch (error) {
				if (error instanceof GovernedApiUnknownEffectError) {
					throw error;
				}
				if (
					error instanceof TypeError &&
					error.message.includes("does not bind the expected V3 action request")
				) {
					throw error;
				}
				throw new TypeError(
					"governed API worker could not durably write the model action request before the API call.",
				);
			}
			const durableRequest = normalizeDurableActionRequest(
				recordedRequest,
				actionRequest,
			);

			if (input.signal.aborted) {
				await persistTerminalFailureOrThrowUnknown({
					actionEvidencePort: activityEvidencePort,
					dispatch: prepared.dispatch,
					actionId,
					idempotencyKey,
					actionRequestDigest: durableRequest.actionRequestDigest,
					evidenceDigest: durableRequest.actionRequestDigest,
					evidenceRef: durableRequest.actionRequestRef,
					redactions: canonicalInput.redactions,
					outcome: "denied",
					failureCode: "cancelled-before-api-call",
					failureMessage:
						"governed API worker execution was cancelled before the API call.",
					completedAt: readTimestamp(now, "governed API worker completedAt"),
				});
				throw new TypeError(
					"governed API worker execution was cancelled before the API call.",
				);
			}

			// The write-ahead evidence operation is an awaited nondeterministic
			// activity. Revalidate expiry immediately before the only provider
			// effect boundary so a lease cannot be extended by a slow ledger/CAS.
			const preGatewayAt = readTimestamp(
				now,
				"governed API worker pre-gateway authorization time",
			);
			if (!isModelBudgetUnexpired(prepared.modelBudget, preGatewayAt)) {
				await persistTerminalFailureOrThrowUnknown({
					actionEvidencePort: activityEvidencePort,
					dispatch: prepared.dispatch,
					actionId,
					idempotencyKey,
					actionRequestDigest: durableRequest.actionRequestDigest,
					evidenceDigest: durableRequest.actionRequestDigest,
					evidenceRef: durableRequest.actionRequestRef,
					redactions: canonicalInput.redactions,
					outcome: "denied",
					failureCode: "dispatch-expired-before-api-call",
					failureMessage:
						"governed API V3 dispatch is expired or its compute budget is exhausted after write-ahead evidence and before the API call.",
					completedAt: preGatewayAt,
				});
				throw new TypeError(
					"governed API V3 dispatch is expired or its compute budget is exhausted and cannot authorize a model action.",
				);
			}

			const gatewayRequestTemplate = createModelActionGatewayRequestTemplate({
				prepared,
				modelActionRequest,
				actionId,
				idempotencyKey,
				actionRequestRef: durableRequest.actionRequestRef,
				actionRequestDigest: durableRequest.actionRequestDigest,
				signal: input.signal,
			});
			const modelActionAuthorityInput = createModelActionAuthorityInput({
				prepared,
				canonicalInput,
				gatewayRequestTemplate,
			});
			let modelActionAuthority: VerifiedModelActionAuthorityV2;
			let gatewayRequest: GovernedModelActionGatewayRequestV1;
			try {
				modelActionAuthority = await bindModelActionAuthority(
					modelActionAuthorityInput,
				);
				gatewayRequest = createModelActionGatewayRequest(
					gatewayRequestTemplate,
					modelActionAuthority,
					modelActionAuthorityInput,
				);
			} catch {
				await persistTerminalFailureOrThrowUnknown({
					actionEvidencePort: activityEvidencePort,
					dispatch: prepared.dispatch,
					actionId,
					idempotencyKey,
					actionRequestDigest: durableRequest.actionRequestDigest,
					evidenceDigest: durableRequest.actionRequestDigest,
					evidenceRef: durableRequest.actionRequestRef,
					redactions: canonicalInput.redactions,
					outcome: "failed",
					failureCode: "model-action-authority-unavailable",
					failureMessage:
						"governed API worker could not obtain a native-backed authority grant after write-ahead evidence.",
					completedAt: readTimestamp(now, "governed API worker completedAt"),
				});
				throw new TypeError(
					"governed API worker could not obtain a verified native-backed model action authority.",
				);
			}

			// A grant is itself a time-bounded activity.  Do not let a slow native
			// reconciliation authorize a provider call after either lease expires.
			const preProviderAt = readTimestamp(
				now,
				"governed API worker pre-provider authorization time",
			);
			if (
				!isModelBudgetUnexpired(prepared.modelBudget, preProviderAt) ||
				!isModelActionAuthorityUnexpired(modelActionAuthority, preProviderAt)
			) {
				await persistTerminalFailureOrThrowUnknown({
					actionEvidencePort: activityEvidencePort,
					dispatch: prepared.dispatch,
					actionId,
					idempotencyKey,
					actionRequestDigest: durableRequest.actionRequestDigest,
					evidenceDigest: durableRequest.actionRequestDigest,
					evidenceRef: durableRequest.actionRequestRef,
					redactions: canonicalInput.redactions,
					outcome: "denied",
					failureCode: "model-action-authority-expired-before-api-call",
					failureMessage:
						"governed API model authority is expired or the dispatch compute budget is exhausted before the provider effect boundary.",
					authorizationRef:
						modelActionAuthority.authorization.authorization_ref,
					completedAt: preProviderAt,
				});
				throw new TypeError(
					"governed API model authority is expired or the dispatch compute budget is exhausted and cannot authorize a provider action.",
				);
			}
			try {
				activityEvidencePort.assertActionLeaseUnexpired(
					actionId,
					preProviderAt,
				);
			} catch (error) {
				await persistTerminalFailureOrThrowUnknown({
					actionEvidencePort: activityEvidencePort,
					dispatch: prepared.dispatch,
					actionId,
					idempotencyKey,
					actionRequestDigest: durableRequest.actionRequestDigest,
					evidenceDigest: durableRequest.actionRequestDigest,
					evidenceRef: durableRequest.actionRequestRef,
					redactions: canonicalInput.redactions,
					outcome: "denied",
					failureCode: "activity-lease-expired-before-api-call",
					failureMessage:
						error instanceof Error ? error.message : String(error),
					authorizationRef:
						modelActionAuthority.authorization.authorization_ref,
					completedAt: preProviderAt,
				});
				throw error;
			}

			if (input.signal.aborted) {
				await persistTerminalFailureOrThrowUnknown({
					actionEvidencePort: activityEvidencePort,
					dispatch: prepared.dispatch,
					actionId,
					idempotencyKey,
					actionRequestDigest: durableRequest.actionRequestDigest,
					evidenceDigest: durableRequest.actionRequestDigest,
					evidenceRef: durableRequest.actionRequestRef,
					redactions: canonicalInput.redactions,
					outcome: "denied",
					failureCode: "cancelled-before-api-call",
					failureMessage:
						"governed API worker execution was cancelled before the API call.",
					authorizationRef:
						modelActionAuthority.authorization.authorization_ref,
					completedAt: readTimestamp(now, "governed API worker completedAt"),
				});
				throw new TypeError(
					"governed API worker execution was cancelled before the API call.",
				);
			}

			let gatewayResult: GovernedModelActionGatewayResultV1;
			try {
				gatewayResult = normalizeGatewayResult(
					await authorizeAndComplete(gatewayRequest),
					gatewayRequest,
				);
			} catch {
				await persistUnknownOrThrowUnknown({
					actionEvidencePort: activityEvidencePort,
					dispatch: prepared.dispatch,
					actionId,
					idempotencyKey,
					actionRequestDigest: durableRequest.actionRequestDigest,
					actionRequestRef: durableRequest.actionRequestRef,
					redactions: canonicalInput.redactions,
					authorizationRef:
						modelActionAuthority.authorization.authorization_ref,
					completedAt: readTimestamp(now, "governed API worker completedAt"),
					failureCode: "api-call-ambiguous",
				});
				throw new GovernedApiUnknownEffectError(
					"governed API model gateway call became an unknown effect after its durable action request; do not retry.",
				);
			}
			if (gatewayResult.authorization.decision === "deny") {
				await persistTerminalFailureOrThrowUnknown({
					actionEvidencePort: activityEvidencePort,
					dispatch: prepared.dispatch,
					actionId,
					idempotencyKey,
					actionRequestDigest: durableRequest.actionRequestDigest,
					evidenceDigest: durableRequest.actionRequestDigest,
					evidenceRef: durableRequest.actionRequestRef,
					redactions: canonicalInput.redactions,
					outcome: "denied",
					failureCode:
						gatewayResult.authorization.denialCode ?? "model-action-denied",
					failureMessage:
						"governed API model action was denied by the host ActionGateway.",
					authorizationRef: gatewayResult.authorization.authorizationRef,
					completedAt: readTimestamp(now, "governed API worker completedAt"),
				});
				throw new TypeError(
					"governed API model action was denied by the host ActionGateway.",
				);
			}
			if (gatewayResult.response === undefined) {
				await persistUnknownOrThrowUnknown({
					actionEvidencePort: activityEvidencePort,
					dispatch: prepared.dispatch,
					actionId,
					idempotencyKey,
					actionRequestDigest: durableRequest.actionRequestDigest,
					actionRequestRef: durableRequest.actionRequestRef,
					redactions: canonicalInput.redactions,
					authorizationRef: gatewayResult.authorization.authorizationRef,
					completedAt: readTimestamp(now, "governed API worker completedAt"),
					failureCode: "model-gateway-allowed-without-response",
				});
				throw new GovernedApiUnknownEffectError(
					"governed API model ActionGateway allowed an action without a response; do not retry.",
				);
			}
			const response = gatewayResult.response;
			// Governed authority expires on completion, not merely at provider-call
			// start. If a gateway returned after either lease elapsed, the remote
			// provider may have observed the request but this worker must never seal
			// it as a successful V3 action. The gateway is responsible for avoiding
			// this state with an effect-edge deadline; this check keeps local output
			// compatible with the native reducer if it fails to do so.
			const postGatewayAt = readTimestamp(
				now,
				"governed API worker post-gateway authorization time",
			);
			if (
				!isModelBudgetUnexpired(prepared.modelBudget, postGatewayAt) ||
				!isModelActionAuthorityUnexpired(modelActionAuthority, postGatewayAt)
			) {
				await persistUnknownOrThrowUnknown({
					actionEvidencePort: activityEvidencePort,
					dispatch: prepared.dispatch,
					actionId,
					idempotencyKey,
					actionRequestDigest: durableRequest.actionRequestDigest,
					actionRequestRef: durableRequest.actionRequestRef,
					redactions: canonicalInput.redactions,
					resourceUsage: resourceUsage(response.resourceUsage),
					authorizationRef: gatewayResult.authorization.authorizationRef,
					completedAt: postGatewayAt,
					failureCode: "model-action-authority-expired-after-api-call",
				});
				throw new GovernedApiUnknownEffectError(
					"governed API model action completed after its authority lease or dispatch budget; do not retry.",
				);
			}

			try {
				assertResponseWithinModelTokenBudget(
					response.resourceUsage,
					prepared.modelBudget,
				);
			} catch (error) {
				const budgetError =
					error instanceof GovernedApiTokenBudgetError
						? error
						: new GovernedApiTokenBudgetError(
								"model-token-budget-invalid",
								safeErrorMessage(error, "invalid model token budget result"),
							);
				await persistTerminalFailureOrThrowUnknown({
					actionEvidencePort: activityEvidencePort,
					dispatch: prepared.dispatch,
					actionId,
					idempotencyKey,
					actionRequestDigest: durableRequest.actionRequestDigest,
					evidenceDigest: durableRequest.actionRequestDigest,
					evidenceRef: durableRequest.actionRequestRef,
					redactions: canonicalInput.redactions,
					outcome: "failed",
					failureCode: budgetError.code,
					failureMessage: budgetError.message,
					resourceUsage: resourceUsage(response.resourceUsage),
					authorizationRef: gatewayResult.authorization.authorizationRef,
					completedAt: readTimestamp(now, "governed API worker completedAt"),
				});
				throw budgetError;
			}

			let completion: GovernedWorkerCompletionV1;
			let reviewOutput: GovernedReviewVerdictOutputV1 | undefined;
			try {
				assertNoExecutableToolCalls(response.toolCalls, toolCapabilities);
				completion = parseCompletion(
					response.completion,
					prepared.executionRole,
					prepared.dispatch,
					prepared.reviewCandidate?.candidateDigest,
				);
				if (prepared.reviewCandidate !== undefined) {
					reviewOutput = reviewVerdictOutput(
						completion as ReviewVerdictV1,
						prepared.reviewCandidate,
					);
				}
			} catch (error) {
				const message = safeErrorMessage(error, "invalid model completion");
				await persistTerminalFailureOrThrowUnknown({
					actionEvidencePort: activityEvidencePort,
					dispatch: prepared.dispatch,
					actionId,
					idempotencyKey,
					actionRequestDigest: durableRequest.actionRequestDigest,
					evidenceDigest: durableRequest.actionRequestDigest,
					evidenceRef: durableRequest.actionRequestRef,
					redactions: canonicalInput.redactions,
					outcome: "failed",
					failureCode: "invalid-model-completion",
					failureMessage: message,
					resourceUsage: resourceUsage(response.resourceUsage),
					authorizationRef: gatewayResult.authorization.authorizationRef,
					completedAt: readTimestamp(now, "governed API worker completedAt"),
				});
				throw error;
			}

			let resultEvidence: ModelResultEvidence;
			try {
				resultEvidence = normalizeModelResultEvidence(
					await persistModelResult({
						schemaVersion: 1,
						actionId,
						actionRequestRef: durableRequest.actionRequestRef,
						actionRequestDigest: durableRequest.actionRequestDigest,
						modelRequestDigest: gatewayRequest.modelRequestDigest,
						authorizationRef: gatewayResult.authorization.authorizationRef,
						authorizationDigest:
							modelActionAuthority.authorization.authorization_digest,
						modelInput: prepared.modelInput,
						completion,
						...(reviewOutput === undefined ? {} : { reviewOutput }),
					}),
				);
				assertModelResultEvidenceBinding(resultEvidence, {
					actionId,
					actionRequestRef: durableRequest.actionRequestRef,
					actionRequestDigest: durableRequest.actionRequestDigest,
					modelRequestDigest: gatewayRequest.modelRequestDigest,
					authorizationRef: gatewayResult.authorization.authorizationRef,
					authorizationDigest:
						modelActionAuthority.authorization.authorization_digest,
					completion,
					...(reviewOutput === undefined ? {} : { reviewOutput }),
				});
			} catch {
				await persistUnknownOrThrowUnknown({
					actionEvidencePort: activityEvidencePort,
					dispatch: prepared.dispatch,
					actionId,
					idempotencyKey,
					actionRequestDigest: durableRequest.actionRequestDigest,
					actionRequestRef: durableRequest.actionRequestRef,
					redactions: canonicalInput.redactions,
					resourceUsage: resourceUsage(response.resourceUsage),
					authorizationRef: gatewayResult.authorization.authorizationRef,
					completedAt: readTimestamp(now, "governed API worker completedAt"),
					failureCode: "model-result-evidence-ambiguous",
				});
				throw new GovernedApiUnknownEffectError(
					"governed API result evidence became an unknown effect after the API call; do not retry.",
				);
			}

			const completedAt = readTimestamp(now, "governed API worker completedAt");
			if (
				!isModelBudgetUnexpired(prepared.modelBudget, completedAt) ||
				!isModelActionAuthorityUnexpired(modelActionAuthority, completedAt)
			) {
				await persistUnknownOrThrowUnknown({
					actionEvidencePort: activityEvidencePort,
					dispatch: prepared.dispatch,
					actionId,
					idempotencyKey,
					actionRequestDigest: durableRequest.actionRequestDigest,
					actionRequestRef: durableRequest.actionRequestRef,
					redactions: canonicalInput.redactions,
					resourceUsage: resourceUsage(response.resourceUsage),
					authorizationRef: gatewayResult.authorization.authorizationRef,
					completedAt,
					failureCode: "model-action-authority-expired-before-success-receipt",
				});
				throw new GovernedApiUnknownEffectError(
					"governed API model result reached receipt persistence after its authority lease or dispatch budget; do not retry.",
				);
			}
			const receiptInput: RecordActionReceiptV2Input = {
				schemaVersion: 2,
				runId: prepared.dispatch.runId,
				workflowId: prepared.dispatch.workflowId,
				unitId: prepared.dispatch.unitId,
				attempt: prepared.dispatch.attempt,
				provenanceRef: prepared.dispatch.provenanceRef,
				actionId,
				idempotencyKey,
				actionRequestDigest: durableRequest.actionRequestDigest,
				dispatchEnvelopeDigest: prepared.dispatch.envelopeDigest,
				capabilityBundleDigest: prepared.dispatch.capabilityBundleDigest,
				policyDigest: prepared.dispatch.policyDigest,
				contextManifestDigest: prepared.dispatch.contextManifestDigest,
				workerManifestDigest: prepared.dispatch.workerManifestDigest,
				sandboxProfileDigest: prepared.dispatch.sandboxProfileDigest,
				authorityActor: prepared.dispatch.authorityActor,
				executionRole: prepared.executionRole,
				outcome: "succeeded",
				resultDigest: resultEvidence.resultDigest,
				resultRef: resultEvidence.resultRef,
				evidenceDigest: resultEvidence.evidenceDigest,
				evidenceRef: resultEvidence.evidenceRef,
				resourceUsage: resourceUsage(response.resourceUsage),
				redactions: mergeRedactions(
					canonicalInput.redactions,
					resultEvidence.redactions,
				),
				authorizationRef: gatewayResult.authorization.authorizationRef,
				completedAt,
			};
			const durableReceipt = await recordVerifiedSuccessReceiptOrThrowUnknown({
				actionEvidencePort: activityEvidencePort,
				receiptInput,
				dispatch: prepared.dispatch,
				actionId,
				idempotencyKey,
				actionRequestDigest: durableRequest.actionRequestDigest,
				actionRequestRef: durableRequest.actionRequestRef,
				redactions: canonicalInput.redactions,
				authorizationRef: gatewayResult.authorization.authorizationRef,
				completedAt,
			});

			return {
				executionReceipt: executionReceipt(
					prepared.packet,
					prepared.modelInput,
					completion,
					input.projectRoot,
					startedAt,
					completedAt,
				),
				actionReceipts: [durableReceipt],
				...(isReviewRole(prepared.executionRole)
					? { reviewVerdict: completion as ReviewVerdictV1 }
					: {}),
			};
		},
	};
	return Object.freeze(port);
}

interface CapturedGovernedApiWorkerDependencies {
	readonly authorizeAndComplete: GovernedModelActionGateway["authorizeAndComplete"];
	readonly bindModelActionAuthority: GovernedModelActionAuthorityPort["bind"];
	readonly persistCanonicalInput: GovernedModelEvidenceStore["persistCanonicalInput"];
	readonly persistModelResult: GovernedModelEvidenceStore["persistModelResult"];
	readonly activityClaimPort: GovernedActivityClaimPort;
	readonly activityLeaseDurationMs: number;
	readonly now: () => string;
	readonly toolCapabilities: readonly GovernedApiToolCapabilityV1[];
}

/**
 * Take one immutable snapshot of all host-owned dependencies.  `readonly` is
 * a TypeScript-only affordance: retaining the mutable caller options object
 * would let a later property swap replace the verified ActionGateway.
 */
function captureCreateDependencies(
	options: CreateGovernedApiWorkerExecutionPortOptions,
): CapturedGovernedApiWorkerDependencies {
	if (options === null || typeof options !== "object") {
		throw new TypeError(
			"createGovernedApiWorkerExecutionPort requires options.",
		);
	}
	const actionGateway = options.actionGateway;
	const authorizeAndComplete =
		trustedGovernedModelActionGatewayAuthorizeAndComplete(actionGateway);
	if (
		!actionGateway ||
		!isTrustedGovernedModelActionGateway(actionGateway) ||
		authorizeAndComplete === undefined ||
		!Object.isFrozen(actionGateway)
	) {
		throw new TypeError(
			"createGovernedApiWorkerExecutionPort requires a trusted immutable host model ActionGateway.",
		);
	}
	const modelActionAuthorityPort = options.modelActionAuthorityPort;
	if (
		!modelActionAuthorityPort ||
		typeof modelActionAuthorityPort.bind !== "function" ||
		!Object.isFrozen(modelActionAuthorityPort)
	) {
		throw new TypeError(
			"createGovernedApiWorkerExecutionPort requires an immutable native-backed model action authority port.",
		);
	}
	const evidenceStore = options.evidenceStore;
	if (
		!evidenceStore ||
		typeof evidenceStore.persistCanonicalInput !== "function" ||
		typeof evidenceStore.persistModelResult !== "function"
	) {
		throw new TypeError(
			"createGovernedApiWorkerExecutionPort requires a credential-free governed model evidence store.",
		);
	}
	const activityClaimPort = captureActivityClaimPort(options.activityClaimPort);
	const activityLeaseDurationMs = normalizeActivityLeaseDuration(
		options.activityLeaseDurationMs,
	);
	const now = options.now ?? (() => new Date().toISOString());
	if (typeof now !== "function") {
		throw new TypeError(
			"createGovernedApiWorkerExecutionPort now must be a function when provided.",
		);
	}
	return Object.freeze({
		authorizeAndComplete: authorizeAndComplete.bind(actionGateway),
		bindModelActionAuthority: modelActionAuthorityPort.bind.bind(
			modelActionAuthorityPort,
		),
		persistCanonicalInput:
			evidenceStore.persistCanonicalInput.bind(evidenceStore),
		persistModelResult: evidenceStore.persistModelResult.bind(evidenceStore),
		activityClaimPort,
		activityLeaseDurationMs,
		now,
		toolCapabilities: Object.freeze([...(options.toolCapabilities ?? [])]),
	});
}

/**
 * Every API receipt is subordinated to a native activity terminal result. The
 * adapter never sees a provider capability until the request has been claimed,
 * and it cannot record a receipt before that exact claim records one terminal
 * outcome. This keeps receipt persistence independent from authority while
 * making replay block rather than reissue an uncertain provider effect.
 */
type ActivityBoundEvidencePort = GovernedActionEvidencePort & {
	readonly assertActionLeaseUnexpired: (actionId: string, at: string) => void;
};

function createActivityBoundEvidencePort(input: {
	readonly actionEvidencePort: GovernedActionEvidencePort | undefined;
	readonly activityClaimPort: GovernedActivityClaimPort;
	readonly dispatch: GovernedDispatchLineageV3;
	readonly leaseDurationMs: number;
}): ActivityBoundEvidencePort {
	if (
		!input.actionEvidencePort ||
		typeof input.actionEvidencePort.recordActionRequested !== "function" ||
		typeof input.actionEvidencePort.recordActionReceipt !== "function"
	) {
		throw new TypeError(
			"sealed V3 API execution requires durable action evidence before an activity may be claimed.",
		);
	}
	const recordActionRequested =
		input.actionEvidencePort.recordActionRequested.bind(
			input.actionEvidencePort,
		);
	const recordActionReceipt = input.actionEvidencePort.recordActionReceipt.bind(
		input.actionEvidencePort,
	);
	const sealActionReceiptSet =
		input.actionEvidencePort.sealActionReceiptSet.bind(
			input.actionEvidencePort,
		);
	const recordCandidateCreatedV2 =
		input.actionEvidencePort.recordCandidateCreatedV2.bind(
			input.actionEvidencePort,
		);
	const claims = new Map<
		string,
		{
			readonly durableRequest: DurableActionRequestV2;
			readonly claim: GrantedGovernedActivityClaimV1;
		}
	>();
	const terminalOutcomes = new Map<string, GovernedActivityResultOutcomeV1>();

	return Object.freeze({
		async recordActionRequested(actionRequest: ActionRequestedV2) {
			const recorded = await recordActionRequested(actionRequest);
			const durableRequest = normalizeDurableActionRequest(
				recorded,
				actionRequest,
			);
			if (claims.has(actionRequest.actionId)) {
				throw new TypeError(
					"sealed V3 API execution cannot claim the same action identity twice.",
				);
			}
			const disposition = await input.activityClaimPort.claim({
				dispatch: input.dispatch,
				durableRequest,
				activityId: actionRequest.actionId,
				idempotencyKey: actionRequest.idempotencyKey,
				leaseDurationMs: input.leaseDurationMs,
			});
			if (disposition.state !== "granted") {
				throw new GovernedApiUnknownEffectError(
					`governed API activity ${actionRequest.actionId} is ${disposition.state}; recovery must reconcile the durable activity before any provider call.`,
				);
			}
			if (
				disposition.activityId !== actionRequest.actionId ||
				disposition.idempotencyKey !== actionRequest.idempotencyKey
			) {
				throw new TypeError(
					"native activity claim does not bind the exact governed API action identity.",
				);
			}
			claims.set(
				actionRequest.actionId,
				Object.freeze({
					durableRequest,
					claim: Object.freeze({ ...disposition }),
				}),
			);
			return durableRequest;
		},

		async recordActionReceipt(receiptInput: RecordActionReceiptV2Input) {
			const activity = claims.get(receiptInput.actionId);
			if (!activity) {
				throw new TypeError(
					"sealed V3 API receipt has no matching claimed native activity.",
				);
			}
			if (terminalOutcomes.has(receiptInput.actionId)) {
				throw new GovernedApiUnknownEffectError(
					"sealed V3 API activity already has a terminal result; receipt recovery must reconcile rather than rewrite it.",
				);
			}
			const outcome = activityOutcomeForReceipt(receiptInput.outcome);
			const disposition = await input.activityClaimPort.recordResult({
				dispatch: input.dispatch,
				durableRequest: activity.durableRequest,
				claim: activity.claim,
				outcome,
				resultDigest:
					receiptInput.outcome === "succeeded"
						? (receiptInput.resultDigest ?? null)
						: null,
				resultRef:
					receiptInput.outcome === "succeeded"
						? (receiptInput.resultRef ?? null)
						: null,
				evidenceDigest: receiptInput.evidenceDigest,
				evidenceRef: receiptInput.evidenceRef,
			});
			if (
				disposition.state !== "recorded" ||
				disposition.resultOutcome !== outcome
			) {
				throw new GovernedApiUnknownEffectError(
					"native activity terminal result was not durably recorded; the provider effect must be reconciled before a receipt is written.",
				);
			}
			terminalOutcomes.set(receiptInput.actionId, outcome);
			return recordActionReceipt(receiptInput);
		},

		sealActionReceiptSet,
		recordCandidateCreatedV2,

		assertActionLeaseUnexpired(actionId: string, at: string) {
			const activity = claims.get(actionId);
			if (!activity) {
				throw new TypeError(
					"sealed V3 API action has no native activity claim before the provider boundary.",
				);
			}
			const leaseExpiresAt = Date.parse(activity.claim.leaseExpiresAt);
			const checkedAt = Date.parse(at);
			if (!Number.isFinite(leaseExpiresAt) || !Number.isFinite(checkedAt)) {
				throw new TypeError(
					"native activity claim has an invalid lease timestamp.",
				);
			}
			if (leaseExpiresAt <= checkedAt) {
				throw new GovernedApiUnknownEffectError(
					"native activity lease expired before the provider boundary; do not issue the model request.",
				);
			}
		},
	});
}

function activityOutcomeForReceipt(
	outcome: RecordActionReceiptV2Input["outcome"],
): GovernedActivityResultOutcomeV1 {
	return outcome === "succeeded"
		? "succeeded"
		: outcome === "unknown"
			? "unknown"
			: "failed";
}

function captureActivityClaimPort(
	input: GovernedActivityClaimPort | undefined,
): GovernedActivityClaimPort {
	if (
		!input ||
		!Object.isFrozen(input) ||
		!isTrustedGovernedActivityClaimPort(input) ||
		typeof input.claim !== "function" ||
		typeof input.recordResult !== "function"
	) {
		throw new TypeError(
			"createGovernedApiWorkerExecutionPort requires a trusted immutable native activity-claim authority with claim and terminal-result methods.",
		);
	}
	return Object.freeze({
		claim: input.claim.bind(input),
		recordResult: input.recordResult.bind(input),
	});
}

function normalizeActivityLeaseDuration(value: number | undefined): number {
	const duration = value ?? 300_000;
	if (
		!Number.isSafeInteger(duration) ||
		duration < 1_000 ||
		duration > 900_000
	) {
		throw new RangeError(
			"governed API activity lease duration must be an integer from 1000 through 900000 milliseconds.",
		);
	}
	return duration;
}

function prepareExecutionInput(
	input: GovernedApiWorkerExecutionInput,
	toolCapabilities: readonly GovernedApiToolCapabilityV1[],
	observedAt: string,
): {
	readonly packet: UnitPacket;
	readonly packetDigest: string;
	readonly dispatch: GovernedDispatchLineageV3;
	readonly modelBudget: GovernedApiModelBudgetV1;
	readonly actionEvidencePort: GovernedActionEvidencePort;
	readonly executionRole: GovernedApiExecutionRole;
	readonly trustScopeDigest: string;
	readonly packetAuthority: GovernedModelActionGatewayRequestV1["packetAuthority"];
	readonly reviewCandidate?: GovernedReviewCandidateDescriptorV1;
	readonly modelInput: GovernedApiModelInput;
} {
	if (input === null || typeof input !== "object") {
		throw new TypeError("governed API worker requires execution input.");
	}
	if (input.signal.aborted) {
		throw new TypeError(
			"governed API worker execution was cancelled before authorization.",
		);
	}
	if (!input.governedDispatch) {
		throw new TypeError("governed API worker requires V3 governedDispatch.");
	}
	if (!input.actionEvidencePort) {
		throw new TypeError(
			"governed API worker requires a durable action evidence port.",
		);
	}

	const dispatch = normalizeGovernedDispatch(input.governedDispatch);
	const packet = normalizeAdmittedPacket(input.packet);
	const acceptanceContractDigest = canonicalGovernanceRecordDigest(
		packet.acceptance_contract,
		"packet.acceptance_contract",
	);
	const trustScopeDigest = canonicalGovernanceRecordDigest(
		packet.trust_scope,
		"packet.trust_scope",
	);
	assertV3DispatchMatchesPacket(
		input.runId,
		packet,
		dispatch,
		acceptanceContractDigest,
	);
	const modelBudget = deriveModelBudget(dispatch);
	assertModelBudgetUnexpired(modelBudget, observedAt);
	assertActionEvidencePort(input.actionEvidencePort);
	const executionRole = assertSupportedRole(packet.execution_role);
	if (dispatch.executionRole !== executionRole) {
		throw new TypeError(
			"governed API worker dispatch execution role must match the packet role.",
		);
	}
	if (packet.execution !== undefined) {
		throw new TypeError(
			"governed API worker accepts API model packets only; command execution has no ambient fallback.",
		);
	}
	if (!packet.model) {
		throw new TypeError(
			"governed API worker requires a model execution block.",
		);
	}
	if (packet.model.tools !== undefined) {
		throw new TypeError(
			"governed API worker rejects ambient packet tools; use the explicit typed tool capability contract.",
		);
	}

	const provider = assertProvider(packet.model.provider);
	const model = assertNonEmptyString(packet.model.model, "governed API model");
	const prompt = assertNonEmptyString(
		packet.model.prompt,
		"governed API model prompt",
	);
	const systemPrompt = optionalNonEmptyString(
		packet.model.systemPrompt,
		"governed API model systemPrompt",
	);

	let reviewCandidate: GovernedReviewCandidateDescriptorV1 | undefined;
	if (isReviewRole(executionRole)) {
		if (input.reviewCandidate === undefined) {
			throw new TypeError(
				"governed API review roles require a verified immutable candidate descriptor.",
			);
		}
		reviewCandidate = normalizeReviewCandidateDescriptor(
			input.reviewCandidate,
			dispatch,
		);
	} else if (input.reviewCandidate !== undefined) {
		throw new TypeError(
			"governed API implementer actions must not receive review candidate authority.",
		);
	}
	const modelToolCapabilities = isReviewRole(executionRole)
		? Object.freeze([] as GovernedApiToolCapabilityV1[])
		: toolCapabilities;
	const modelContext =
		packet.intent === undefined
			? undefined
			: freezeTaskIntentContext(packet.intent.context);

	return Object.freeze({
		packet,
		packetDigest: canonicalGovernedUnitPacketV1Digest(packet),
		dispatch,
		modelBudget,
		actionEvidencePort: input.actionEvidencePort,
		executionRole,
		trustScopeDigest,
		packetAuthority: Object.freeze({
			provenanceRef: dispatch.provenanceRef,
			capabilityBundleDigest: dispatch.capabilityBundleDigest,
			acceptanceContractDigest: dispatch.acceptanceContractDigest,
			trustScopeDigest,
			policyDigest: dispatch.policyDigest,
			sandboxProfileDigest: dispatch.sandboxProfileDigest,
		}),
		...(reviewCandidate === undefined ? {} : { reviewCandidate }),
		modelInput: Object.freeze({
			provider,
			model,
			prompt,
			...(systemPrompt === undefined ? {} : { systemPrompt }),
			...(modelContext === undefined ? {} : { context: modelContext }),
			...(reviewCandidate === undefined
				? {}
				: {
						expectedCandidateDigest: reviewCandidate.candidateDigest,
						reviewCandidate,
					}),
			toolCapabilities: modelToolCapabilities,
		}),
	});
}

function assertV3DispatchMatchesPacket(
	runId: string,
	packet: UnitPacket,
	dispatch: GovernedDispatchLineageV3,
	acceptanceContractDigest: string,
): void {
	if (
		dispatch.schemaVersion !== 3 ||
		dispatch.commitMode !== "atomic" ||
		dispatch.trustTier !== "governed" ||
		dispatch.actionEvidenceVersion !== "sealed_v3"
	) {
		throw new TypeError(
			"governed API worker requires a sealed_v3, atomic, governed V3 dispatch.",
		);
	}
	if (
		dispatch.runId !== runId ||
		dispatch.unitId !== packet.unit.id ||
		dispatch.provenanceRef !== packet.provenance_ref
	) {
		throw new TypeError(
			"governed API worker V3 dispatch must match the kernel run, unit, and provenance.",
		);
	}
	if (
		packet.capability_bundle === undefined ||
		packet.capability_bundle_digest === undefined
	) {
		throw new TypeError(
			"governed API worker requires an admitted capability bundle and canonical digest.",
		);
	}
	if (packet.capability_bundle_digest !== dispatch.capabilityBundleDigest) {
		throw new TypeError(
			"governed API worker capability bundle digest must match the V3 dispatch.",
		);
	}
	if (acceptanceContractDigest !== dispatch.acceptanceContractDigest) {
		throw new TypeError(
			"governed API worker packet acceptance contract digest must match the V3 dispatch.",
		);
	}
	if (
		canonicalGovernedUnitPacketV1Digest(packet) !==
		dispatch.governedPacketDigest
	) {
		throw new TypeError(
			"governed API worker packet must match the exact packet digest bound into the V3 dispatch.",
		);
	}
	for (const [label, value] of Object.entries({
		envelopeDigest: dispatch.envelopeDigest,
		capabilityBundleDigest: dispatch.capabilityBundleDigest,
		acceptanceContractDigest: dispatch.acceptanceContractDigest,
		policyDigest: dispatch.policyDigest,
		contextManifestDigest: dispatch.contextManifestDigest,
		workerManifestDigest: dispatch.workerManifestDigest,
		sandboxProfileDigest: dispatch.sandboxProfileDigest,
		governedPacketDigest: dispatch.governedPacketDigest,
	})) {
		assertSha256Digest(value, `governed API dispatch ${label}`);
	}
	const issuedAt = Date.parse(dispatch.issuedAt);
	const expiresAt = Date.parse(dispatch.expiresAt);
	if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
		throw new TypeError(
			"governed API worker requires parseable dispatch timestamps.",
		);
	}
	if (issuedAt >= expiresAt) {
		throw new TypeError(
			"governed API worker requires dispatch expiresAt later than issuedAt.",
		);
	}
}

const MAX_ECMASCRIPT_EPOCH_MS = 8_640_000_000_000_000;

/**
 * Derive one absolute provider-effect deadline from immutable dispatch data.
 * A retry or delayed host queue is intentionally not allowed to start a fresh
 * compute window. Older envelopes without maxComputeTimeMs remain bounded by
 * their signed expiry.
 */
function deriveModelBudget(
	dispatch: GovernedDispatchLineageV3,
): GovernedApiModelBudgetV1 {
	const issuedAtMs = parseDispatchEpochMs(dispatch.issuedAt, "issuedAt");
	const expiresAtMs = parseDispatchEpochMs(dispatch.expiresAt, "expiresAt");
	if (issuedAtMs >= expiresAtMs) {
		throw new TypeError(
			"governed API V3 dispatch requires expiresAt later than issuedAt.",
		);
	}
	const { maxComputeTimeMs, maxTokens } = dispatch.budget;
	let deadlineAtMs = expiresAtMs;
	if (maxComputeTimeMs !== undefined) {
		if (maxComputeTimeMs > MAX_ECMASCRIPT_EPOCH_MS - issuedAtMs) {
			throw new TypeError(
				"governed API V3 dispatch maxComputeTimeMs overflows the absolute compute deadline.",
			);
		}
		const computeDeadlineAtMs = issuedAtMs + maxComputeTimeMs;
		if (
			!Number.isSafeInteger(computeDeadlineAtMs) ||
			computeDeadlineAtMs <= issuedAtMs ||
			computeDeadlineAtMs > MAX_ECMASCRIPT_EPOCH_MS
		) {
			throw new TypeError(
				"governed API V3 dispatch maxComputeTimeMs produces an invalid absolute compute deadline.",
			);
		}
		deadlineAtMs = Math.min(deadlineAtMs, computeDeadlineAtMs);
	}
	if (
		!Number.isSafeInteger(deadlineAtMs) ||
		deadlineAtMs <= issuedAtMs ||
		deadlineAtMs > MAX_ECMASCRIPT_EPOCH_MS
	) {
		throw new TypeError(
			"governed API V3 dispatch produces an invalid model effect deadline.",
		);
	}
	return Object.freeze({
		schemaVersion: 1,
		deadlineAt: new Date(deadlineAtMs).toISOString(),
		...(maxTokens === undefined ? {} : { maxTotalTokens: maxTokens }),
	});
}

function parseDispatchEpochMs(
	value: string,
	field: "issuedAt" | "expiresAt",
): number {
	const parsed = Date.parse(value);
	if (
		!Number.isSafeInteger(parsed) ||
		parsed < 0 ||
		parsed > MAX_ECMASCRIPT_EPOCH_MS
	) {
		throw new TypeError(
			`governed API V3 dispatch ${field} must be a safe non-negative epoch timestamp.`,
		);
	}
	return parsed;
}

/** Effect-edge timestamp comparison against the immutable budget deadline. */
function isModelBudgetUnexpired(
	budget: GovernedApiModelBudgetV1,
	observedAt: string,
): boolean {
	return Date.parse(budget.deadlineAt) > Date.parse(observedAt);
}

function assertModelBudgetUnexpired(
	budget: GovernedApiModelBudgetV1,
	observedAt: string,
): void {
	if (!isModelBudgetUnexpired(budget, observedAt)) {
		throw new TypeError(
			"governed API V3 dispatch is expired or its compute budget is exhausted and cannot authorize a model action.",
		);
	}
}

function normalizeGovernedDispatch(input: unknown): GovernedDispatchLineageV3 {
	const record = readClosedRecord(input, "governed API V3 dispatch", [
		"schemaVersion",
		"runId",
		"workflowId",
		"workflowRevision",
		"unitId",
		"attempt",
		"provenanceRef",
		"dispatchEnvelopeRef",
		"envelopeDigest",
		"baseCommitSha",
		"repositoryBindingDigest",
		"ledgerAuthorityRealmDigest",
		"governedPacketDigest",
		"executionRole",
		"commitMode",
		"trustTier",
		"capabilityBundleDigest",
		"acceptanceContractDigest",
		"policyDigest",
		"contextManifestDigest",
		"workerManifestDigest",
		"sandboxProfileDigest",
		"budget",
		"idempotencyKey",
		"authorityActor",
		"actionEvidenceVersion",
		"issuedAt",
		"expiresAt",
	]);
	if (record.schemaVersion !== 3) {
		throw new TypeError("governed API V3 dispatch schemaVersion must be 3.");
	}
	if (
		record.commitMode !== "atomic" ||
		record.trustTier !== "governed" ||
		record.actionEvidenceVersion !== "sealed_v3"
	) {
		throw new TypeError(
			"governed API worker requires a sealed_v3, atomic, governed V3 dispatch.",
		);
	}
	return Object.freeze({
		schemaVersion: 3,
		runId: assertNonEmptyString(record.runId, "governed API V3 dispatch runId"),
		workflowId: assertNonEmptyString(
			record.workflowId,
			"governed API V3 dispatch workflowId",
		),
		workflowRevision: assertNonEmptyString(
			record.workflowRevision,
			"governed API V3 dispatch workflowRevision",
		),
		unitId: assertNonEmptyString(
			record.unitId,
			"governed API V3 dispatch unitId",
		),
		attempt: assertPositiveSafeInteger(
			record.attempt,
			"governed API V3 dispatch attempt",
		),
		provenanceRef: assertNonEmptyString(
			record.provenanceRef,
			"governed API V3 dispatch provenanceRef",
		),
		dispatchEnvelopeRef: assertNonEmptyString(
			record.dispatchEnvelopeRef,
			"governed API V3 dispatch dispatchEnvelopeRef",
		),
		envelopeDigest: assertSha256Digest(
			record.envelopeDigest,
			"governed API V3 dispatch envelopeDigest",
		),
		baseCommitSha: assertCommitSha(
			record.baseCommitSha,
			"governed API V3 dispatch baseCommitSha",
		),
		repositoryBindingDigest: assertSha256Digest(
			record.repositoryBindingDigest,
			"governed API V3 dispatch repositoryBindingDigest",
		),
		ledgerAuthorityRealmDigest: assertSha256Digest(
			record.ledgerAuthorityRealmDigest,
			"governed API V3 dispatch ledgerAuthorityRealmDigest",
		),
		governedPacketDigest: assertSha256Digest(
			record.governedPacketDigest,
			"governed API V3 dispatch governedPacketDigest",
		),
		executionRole: assertSupportedRole(
			assertNonEmptyString(
				record.executionRole,
				"governed API V3 dispatch executionRole",
			),
		),
		commitMode: "atomic",
		trustTier: "governed",
		capabilityBundleDigest: assertSha256Digest(
			record.capabilityBundleDigest,
			"governed API V3 dispatch capabilityBundleDigest",
		),
		acceptanceContractDigest: assertSha256Digest(
			record.acceptanceContractDigest,
			"governed API V3 dispatch acceptanceContractDigest",
		),
		policyDigest: assertSha256Digest(
			record.policyDigest,
			"governed API V3 dispatch policyDigest",
		),
		contextManifestDigest: assertSha256Digest(
			record.contextManifestDigest,
			"governed API V3 dispatch contextManifestDigest",
		),
		workerManifestDigest: assertSha256Digest(
			record.workerManifestDigest,
			"governed API V3 dispatch workerManifestDigest",
		),
		sandboxProfileDigest: assertSha256Digest(
			record.sandboxProfileDigest,
			"governed API V3 dispatch sandboxProfileDigest",
		),
		budget: normalizeDispatchBudget(record.budget),
		idempotencyKey: assertNonEmptyString(
			record.idempotencyKey,
			"governed API V3 dispatch idempotencyKey",
		),
		authorityActor: assertNonEmptyString(
			record.authorityActor,
			"governed API V3 dispatch authorityActor",
		),
		actionEvidenceVersion: "sealed_v3",
		issuedAt: assertRfc3339UtcTimestamp(
			record.issuedAt,
			"governed API V3 dispatch issuedAt",
		),
		expiresAt: assertRfc3339UtcTimestamp(
			record.expiresAt,
			"governed API V3 dispatch expiresAt",
		),
	});
}

function normalizeDispatchBudget(
	input: unknown,
): GovernedDispatchLineageV3["budget"] {
	const record = readClosedRecord(input, "governed API V3 dispatch budget", [
		"maxTokens",
		"maxComputeTimeMs",
	]);
	return Object.freeze({
		...(record.maxTokens === undefined
			? {}
			: {
					maxTokens: assertPositiveSafeInteger(
						record.maxTokens,
						"governed API V3 dispatch budget maxTokens",
					),
				}),
		...(record.maxComputeTimeMs === undefined
			? {}
			: {
					maxComputeTimeMs: assertPositiveSafeInteger(
						record.maxComputeTimeMs,
						"governed API V3 dispatch budget maxComputeTimeMs",
					),
				}),
	});
}

function normalizeReviewCandidateDescriptor(
	input: unknown,
	dispatch: GovernedDispatchLineageV3,
): GovernedReviewCandidateDescriptorV1 {
	const record = readClosedRecord(input, "governed API review candidate", [
		"schemaVersion",
		"candidateDigest",
		"candidateCommitSha",
		"candidateRef",
		"candidateTreeDigest",
		"candidateViewRef",
		"candidateViewDigest",
		"readOnlyMount",
		"context",
	]);
	if (record.schemaVersion !== 1) {
		throw new TypeError(
			"governed API review candidate schemaVersion must be 1.",
		);
	}
	const mount = readClosedRecord(
		record.readOnlyMount,
		"governed API review candidate readOnlyMount",
		["mode", "mountPath", "mountDigest"],
	);
	if (mount.mode !== "read-only") {
		throw new TypeError(
			"governed API review candidate requires a read-only candidate mount.",
		);
	}
	const context = readClosedRecord(
		record.context,
		"governed API review candidate context",
		["contextRef", "contextManifestDigest"],
	);
	const contextManifestDigest = assertSha256Digest(
		context.contextManifestDigest,
		"governed API review candidate context contextManifestDigest",
	);
	if (contextManifestDigest !== dispatch.contextManifestDigest) {
		throw new TypeError(
			"governed API review candidate context must match the V3 dispatch context manifest.",
		);
	}
	const candidateDigest = assertSha256Digest(
		record.candidateDigest,
		"governed API review candidate candidateDigest",
	);
	const candidateCommitSha = assertCommitSha(
		record.candidateCommitSha,
		"governed API review candidate candidateCommitSha",
	);
	const candidateRef = assertCandidateRef(
		record.candidateRef,
		"governed API review candidate candidateRef",
	);
	const candidateTreeDigest = assertSha256Digest(
		record.candidateTreeDigest,
		"governed API review candidate candidateTreeDigest",
	);
	const candidateViewRef = assertNonEmptyString(
		record.candidateViewRef,
		"governed API review candidate candidateViewRef",
	);
	const readOnlyMount = Object.freeze({
		mode: "read-only" as const,
		mountPath: assertNonEmptyString(
			mount.mountPath,
			"governed API review candidate readOnlyMount mountPath",
		),
		mountDigest: assertSha256Digest(
			mount.mountDigest,
			"governed API review candidate readOnlyMount mountDigest",
		),
	});
	const normalizedContext = Object.freeze({
		contextRef: assertNonEmptyString(
			context.contextRef,
			"governed API review candidate context contextRef",
		),
		contextManifestDigest,
	});
	const expectedCandidateViewDigest = canonicalReviewCandidateViewDigest({
		candidateDigest,
		candidateCommitSha,
		candidateRef,
		candidateTreeDigest,
		readOnlyMount,
		reviewerContextManifestDigest: contextManifestDigest,
		reviewerSandboxProfileDigest: dispatch.sandboxProfileDigest,
	});
	const candidateViewDigest = assertSha256Digest(
		record.candidateViewDigest,
		"governed API review candidate candidateViewDigest",
	);
	if (candidateViewDigest !== expectedCandidateViewDigest) {
		throw new TypeError(
			"governed API review candidate candidateViewDigest must bind the exact immutable candidate, read-only mount, and context.",
		);
	}
	return Object.freeze({
		schemaVersion: 1,
		candidateDigest,
		candidateCommitSha,
		candidateRef,
		candidateTreeDigest,
		candidateViewRef,
		candidateViewDigest,
		readOnlyMount,
		context: normalizedContext,
	});
}

function canonicalReviewCandidateViewDigest(input: {
	readonly candidateDigest: string;
	readonly candidateCommitSha: string;
	readonly candidateRef: string;
	readonly candidateTreeDigest: string;
	readonly readOnlyMount: GovernedReviewCandidateDescriptorV1["readOnlyMount"];
	readonly reviewerContextManifestDigest: string;
	readonly reviewerSandboxProfileDigest: string;
}): string {
	return canonicalKernelCandidateViewV1Digest({
		candidateRef: input.candidateRef,
		candidateDigest: input.candidateDigest,
		candidateCommitSha: input.candidateCommitSha,
		treeDigest: input.candidateTreeDigest,
		reviewerContextManifestDigest: input.reviewerContextManifestDigest,
		reviewerSandboxProfileDigest: input.reviewerSandboxProfileDigest,
		mountPathDigest: input.readOnlyMount.mountDigest,
		readOnly: true,
		networkDisabled: true,
	});
}

function freezeTaskIntentContext(
	context: TaskIntent["context"],
): TaskIntent["context"] {
	return Object.freeze({
		files: Object.freeze([...context.files]),
		...(context.priorWork === undefined
			? {}
			: { priorWork: Object.freeze([...context.priorWork]) }),
		...(context.memories === undefined
			? {}
			: { memories: Object.freeze([...context.memories]) }),
		...(context.codebaseHints === undefined
			? {}
			: { codebaseHints: context.codebaseHints }),
		...(context.retryContext === undefined
			? {}
			: { retryContext: context.retryContext }),
	});
}

function canonicalGovernanceRecordDigest(
	input: unknown,
	label: string,
): string {
	if (
		input === null ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		Object.keys(input).length === 0
	) {
		throw new TypeError(`${label} must be a non-empty governance object.`);
	}
	const canonical = canonicalizeJsonValue(input, label, new Set<object>());
	return sha256(JSON.stringify(canonical));
}

/**
 * Canonical packet identity bound into a post-write-ahead model authority.
 * This deliberately includes the full admitted packet, rather than only the
 * V3 lineage, so a structural dispatch cannot be replayed with a substituted
 * prompt, provider, capability, acceptance, or trust-scope object.
 */
export function canonicalGovernedUnitPacketV1Digest(input: UnitPacket): string {
	return canonicalKernelGovernedUnitPacketV1Digest(input);
}

type CanonicalJsonValue =
	| null
	| boolean
	| number
	| string
	| readonly CanonicalJsonValue[]
	| { readonly [key: string]: CanonicalJsonValue };

function canonicalizeJsonValue(
	input: unknown,
	label: string,
	seen: Set<object>,
): CanonicalJsonValue {
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
	if (Array.isArray(input)) {
		if (seen.has(input)) {
			throw new TypeError(`${label} must not contain cyclic values.`);
		}
		seen.add(input);
		const result: CanonicalJsonValue[] = [];
		for (let index = 0; index < input.length; index += 1) {
			if (!hasOwn(input, String(index))) {
				throw new TypeError(`${label} must not contain sparse arrays.`);
			}
			result.push(canonicalizeJsonValue(input[index], label, seen));
		}
		seen.delete(input);
		return Object.freeze(result);
	}
	if (typeof input !== "object") {
		throw new TypeError(`${label} must contain only JSON values.`);
	}
	if (seen.has(input)) {
		throw new TypeError(`${label} must not contain cyclic values.`);
	}
	if (Object.getOwnPropertySymbols(input).length > 0) {
		throw new TypeError(`${label} must not contain symbol fields.`);
	}
	seen.add(input);
	const source = input as Record<string, unknown>;
	const result = Object.create(null) as Record<string, CanonicalJsonValue>;
	for (const key of Object.getOwnPropertyNames(source).sort()) {
		const descriptor = Object.getOwnPropertyDescriptor(source, key);
		if (!descriptor || !("value" in descriptor)) {
			throw new TypeError(`${label}.${key} must be a data property.`);
		}
		result[key] = canonicalizeJsonValue(
			descriptor.value,
			`${label}.${key}`,
			seen,
		);
	}
	seen.delete(input);
	return Object.freeze(result);
}

type ModelActionGatewayRequestTemplateV1 = Omit<
	GovernedModelActionGatewayRequestV1,
	"modelActionAuthority"
>;

/**
 * Deterministic portion of a gateway request, computed before input evidence
 * is written so the evidence record can bind the exact request semantics.
 */
interface ModelActionRequestDescriptorV1 {
	readonly constraints: GovernedModelActionConstraintsV1;
	readonly modelRequestDigest: string;
}

function createModelActionRequestDescriptor(
	prepared: ReturnType<typeof prepareExecutionInput>,
): ModelActionRequestDescriptorV1 {
	const reviewOnly = isReviewRole(prepared.executionRole);
	const constraints: GovernedModelActionConstraintsV1 = Object.freeze({
		schemaVersion: 1,
		budget: prepared.modelBudget,
		responseSchema: responseSchemaForRole(prepared.executionRole),
		structuredOutputRequired: true,
		reviewOnly,
		filesystemAccess: reviewOnly ? "candidate-read-only" : "none",
		processAccess: "none",
		toolCapabilities: Object.freeze(
			prepared.modelInput.toolCapabilities.map(
				(capability) => capability.capabilityId,
			),
		),
		workerSecretAccess: "none",
		workerNetworkAccess: "none",
		brokeredModelNetwork: "provider-only",
	});
	return Object.freeze({
		constraints,
		modelRequestDigest: canonicalModelActionRequestDigest({
			executionRole: prepared.executionRole,
			packetAuthority: prepared.packetAuthority,
			constraints,
			modelInput: prepared.modelInput,
			...(prepared.reviewCandidate === undefined
				? {}
				: { reviewCandidate: prepared.reviewCandidate }),
		}),
	});
}

function createModelActionGatewayRequestTemplate(input: {
	readonly prepared: ReturnType<typeof prepareExecutionInput>;
	readonly modelActionRequest: ModelActionRequestDescriptorV1;
	readonly actionId: string;
	readonly idempotencyKey: string;
	readonly actionRequestRef: string;
	readonly actionRequestDigest: string;
	readonly signal: AbortSignal;
}): ModelActionGatewayRequestTemplateV1 {
	const modelRequest = Object.freeze({
		...input.prepared.modelInput,
		executionRole: input.prepared.executionRole,
		budget: input.modelActionRequest.constraints.budget,
		responseSchema: input.modelActionRequest.constraints.responseSchema,
		structuredOutputRequired:
			input.modelActionRequest.constraints.structuredOutputRequired,
		signal: input.signal,
	});
	return Object.freeze({
		schemaVersion: 1,
		actionId: input.actionId,
		idempotencyKey: input.idempotencyKey,
		actionRequestRef: input.actionRequestRef,
		actionRequestDigest: input.actionRequestDigest,
		modelRequestDigest: input.modelActionRequest.modelRequestDigest,
		dispatch: input.prepared.dispatch,
		executionRole: input.prepared.executionRole,
		packetAuthority: input.prepared.packetAuthority,
		constraints: input.modelActionRequest.constraints,
		modelRequest,
		...(input.prepared.reviewCandidate === undefined
			? {}
			: { reviewCandidate: input.prepared.reviewCandidate }),
	});
}

function createModelActionAuthorityInput(input: {
	readonly prepared: ReturnType<typeof prepareExecutionInput>;
	readonly canonicalInput: Pick<
		ModelInputEvidenceV1,
		"canonicalInputRef" | "canonicalInputDigest"
	>;
	readonly gatewayRequestTemplate: ModelActionGatewayRequestTemplateV1;
}): GovernedModelActionAuthorityInputV2 {
	return Object.freeze({
		schemaVersion: 2,
		dispatch: input.prepared.dispatch,
		actionId: input.gatewayRequestTemplate.actionId,
		idempotencyKey: input.gatewayRequestTemplate.idempotencyKey,
		actionRequestEventRef: assertLedgerEventId(
			input.gatewayRequestTemplate.actionRequestRef,
			"governed API durable model action request event reference",
		),
		actionRequestDigest: input.gatewayRequestTemplate.actionRequestDigest,
		canonicalInputRef: assertCanonicalCasReference(
			input.canonicalInput.canonicalInputRef,
			"governed API canonical input evidence reference",
		),
		canonicalInputDigest: assertSha256Digest(
			input.canonicalInput.canonicalInputDigest,
			"governed API canonical input evidence digest",
		),
		executionRole: input.prepared.executionRole,
		...(input.prepared.reviewCandidate === undefined
			? {}
			: { reviewCandidate: input.prepared.reviewCandidate }),
	});
}

function createModelActionGatewayRequest(
	template: ModelActionGatewayRequestTemplateV1,
	modelActionAuthority: VerifiedModelActionAuthorityV2,
	authorityInput: GovernedModelActionAuthorityInputV2,
): GovernedModelActionGatewayRequestV1 {
	if (!isVerifiedModelActionAuthority(modelActionAuthority)) {
		throw new TypeError(
			"governed API model ActionGateway requires a module-minted native-backed authority grant.",
		);
	}
	assertVerifiedModelActionAuthorityMatches(
		modelActionAuthority,
		authorityInput,
	);
	return Object.freeze({
		...template,
		modelActionAuthority,
	});
}

/**
 * Binds provider, model, prompts, intent context, role-derived constraints,
 * and the immutable review view to the host authorization record. The signal
 * is intentionally excluded because it is process-local and nondeterministic.
 */
function canonicalModelActionRequestDigest(input: {
	readonly executionRole: GovernedApiExecutionRole;
	readonly packetAuthority: GovernedModelActionGatewayRequestV1["packetAuthority"];
	readonly constraints: GovernedModelActionConstraintsV1;
	readonly modelInput: GovernedApiModelInput;
	readonly reviewCandidate?: GovernedReviewCandidateDescriptorV1;
}): string {
	return sha256(
		JSON.stringify(
			canonicalizeJsonValue(
				input,
				"governed API model action request",
				new Set<object>(),
			),
		),
	);
}

function normalizeGatewayResult(
	input: unknown,
	expected: GovernedModelActionGatewayRequestV1,
): GovernedModelActionGatewayResultV1 {
	const record = readClosedRecord(
		input,
		"governed API model ActionGateway result",
		["authorization", "response"],
	);
	const authorization = normalizeGatewayAuthorization(
		record.authorization,
		expected,
	);
	if (authorization.decision === "deny") {
		if (record.response !== undefined) {
			throw new TypeError(
				"governed API model ActionGateway denial must not include a model response.",
			);
		}
		return Object.freeze({ authorization });
	}
	if (record.response === undefined) {
		throw new TypeError(
			"governed API model ActionGateway allow result requires a model response.",
		);
	}
	return Object.freeze({
		authorization,
		response: normalizeClientResponse(record.response),
	});
}

function normalizeGatewayAuthorization(
	input: unknown,
	expected: GovernedModelActionGatewayRequestV1,
): GovernedModelActionAuthorizationV1 {
	const record = readClosedRecord(
		input,
		"governed API model ActionGateway authorization",
		[
			"schemaVersion",
			"decision",
			"actionId",
			"idempotencyKey",
			"actionRequestDigest",
			"modelRequestDigest",
			"dispatchEnvelopeDigest",
			"acceptanceContractDigest",
			"trustScopeDigest",
			"policyDigest",
			"sandboxProfileDigest",
			"executionRole",
			"candidateDigest",
			"candidateViewDigest",
			"authorizationRef",
			"denialCode",
		],
	);
	if (record.schemaVersion !== 1) {
		throw new TypeError(
			"governed API model ActionGateway authorization schemaVersion must be 1.",
		);
	}
	if (record.decision !== "allow" && record.decision !== "deny") {
		throw new TypeError(
			"governed API model ActionGateway authorization decision is not admitted.",
		);
	}
	const authorization: GovernedModelActionAuthorizationV1 = Object.freeze({
		schemaVersion: 1,
		decision: record.decision,
		actionId: assertNonEmptyString(
			record.actionId,
			"governed API model ActionGateway authorization actionId",
		),
		idempotencyKey: assertNonEmptyString(
			record.idempotencyKey,
			"governed API model ActionGateway authorization idempotencyKey",
		),
		actionRequestDigest: assertSha256Digest(
			record.actionRequestDigest,
			"governed API model ActionGateway authorization actionRequestDigest",
		),
		modelRequestDigest: assertSha256Digest(
			record.modelRequestDigest,
			"governed API model ActionGateway authorization modelRequestDigest",
		),
		dispatchEnvelopeDigest: assertSha256Digest(
			record.dispatchEnvelopeDigest,
			"governed API model ActionGateway authorization dispatchEnvelopeDigest",
		),
		acceptanceContractDigest: assertSha256Digest(
			record.acceptanceContractDigest,
			"governed API model ActionGateway authorization acceptanceContractDigest",
		),
		trustScopeDigest: assertSha256Digest(
			record.trustScopeDigest,
			"governed API model ActionGateway authorization trustScopeDigest",
		),
		policyDigest: assertSha256Digest(
			record.policyDigest,
			"governed API model ActionGateway authorization policyDigest",
		),
		sandboxProfileDigest: assertSha256Digest(
			record.sandboxProfileDigest,
			"governed API model ActionGateway authorization sandboxProfileDigest",
		),
		executionRole: assertSupportedRole(
			assertNonEmptyString(
				record.executionRole,
				"governed API model ActionGateway authorization executionRole",
			),
		),
		...(record.candidateDigest === undefined
			? {}
			: {
					candidateDigest: assertSha256Digest(
						record.candidateDigest,
						"governed API model ActionGateway authorization candidateDigest",
					),
				}),
		...(record.candidateViewDigest === undefined
			? {}
			: {
					candidateViewDigest: assertSha256Digest(
						record.candidateViewDigest,
						"governed API model ActionGateway authorization candidateViewDigest",
					),
				}),
		authorizationRef: assertNonEmptyString(
			record.authorizationRef,
			"governed API model ActionGateway authorization authorizationRef",
		),
		...(record.denialCode === undefined
			? {}
			: {
					denialCode: assertNonEmptyString(
						record.denialCode,
						"governed API model ActionGateway authorization denialCode",
					),
				}),
	});
	if (
		authorization.actionId !== expected.actionId ||
		authorization.idempotencyKey !== expected.idempotencyKey ||
		authorization.actionRequestDigest !== expected.actionRequestDigest ||
		authorization.modelRequestDigest !== expected.modelRequestDigest ||
		authorization.dispatchEnvelopeDigest !== expected.dispatch.envelopeDigest ||
		authorization.acceptanceContractDigest !==
			expected.packetAuthority.acceptanceContractDigest ||
		authorization.trustScopeDigest !==
			expected.packetAuthority.trustScopeDigest ||
		authorization.policyDigest !== expected.packetAuthority.policyDigest ||
		authorization.sandboxProfileDigest !==
			expected.packetAuthority.sandboxProfileDigest ||
		authorization.executionRole !== expected.executionRole ||
		authorization.authorizationRef !==
			expected.modelActionAuthority.authorization.authorization_ref
	) {
		throw new TypeError(
			"governed API model ActionGateway authorization does not bind the exact V3 action authority.",
		);
	}
	const expectedCandidateDigest = expected.reviewCandidate?.candidateDigest;
	const expectedCandidateViewDigest =
		expected.reviewCandidate?.candidateViewDigest;
	if (
		authorization.candidateDigest !== expectedCandidateDigest ||
		authorization.candidateViewDigest !== expectedCandidateViewDigest
	) {
		throw new TypeError(
			"governed API model ActionGateway authorization candidate binding does not match the immutable review candidate view.",
		);
	}
	if (
		(authorization.decision === "allow" &&
			authorization.denialCode !== undefined) ||
		(authorization.decision === "deny" &&
			authorization.denialCode === undefined)
	) {
		throw new TypeError(
			"governed API model ActionGateway authorization decision and denial code are inconsistent.",
		);
	}
	return authorization;
}

/** Reparse the worker input through governed admission; legacy defaults are not authority. */
function normalizeAdmittedPacket(input: UnitPacket): UnitPacket {
	if (
		input.capability_bundle === undefined ||
		input.capability_bundle_digest === undefined
	) {
		throw new TypeError(
			"governed API worker requires an admitted capability bundle and canonical digest.",
		);
	}
	try {
		const packet = parseGovernedUnitPacket(JSON.stringify(input));
		if (
			packet.capability_bundle === undefined ||
			packet.capability_bundle_digest === undefined ||
			packet.acceptance_contract === undefined ||
			packet.trust_scope === undefined
		) {
			throw new TypeError("missing governed packet authority");
		}
		return packet;
	} catch {
		throw new TypeError(
			"governed API worker requires admitted capability, acceptance-contract, trust-scope, and role authority.",
		);
	}
}

function assertActionEvidencePort(
	port: GovernedActionEvidencePort,
): asserts port is GovernedActionEvidencePort {
	if (
		typeof port.recordActionRequested !== "function" ||
		typeof port.recordActionReceipt !== "function"
	) {
		throw new TypeError(
			"governed API worker requires a durable action evidence port.",
		);
	}
}

function assertSupportedRole(role: string): GovernedApiExecutionRole {
	if (
		role !== "implementer" &&
		role !== "reviewer" &&
		role !== "adversary" &&
		role !== "judge"
	) {
		throw new TypeError(
			"governed API worker supports implementer, reviewer, adversary, and judge roles only.",
		);
	}
	return role;
}

function assertProvider(provider: string): GovernedApiProvider {
	if (provider !== "anthropic" && provider !== "openai") {
		throw new TypeError(
			"governed API worker supports only anthropic and openai API provider identities.",
		);
	}
	return provider;
}

function normalizeToolCapabilities(
	input: readonly GovernedApiToolCapabilityV1[],
): readonly GovernedApiToolCapabilityV1[] {
	const values = readDenseDataArray(input, "governed API tool capabilities");
	const capabilities: GovernedApiToolCapabilityV1[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < values.length; index += 1) {
		const record = readClosedRecord(
			values[index],
			`governed API tool capabilities[${index}]`,
			[
				"schemaVersion",
				"capabilityId",
				"kind",
				"inputSchemaDigest",
				"outputSchemaDigest",
			],
		);
		if (record.schemaVersion !== 1) {
			throw new TypeError(
				`governed API tool capabilities[${index}].schemaVersion must be 1.`,
			);
		}
		const capabilityId = assertNonEmptyString(
			record.capabilityId,
			`governed API tool capabilities[${index}].capabilityId`,
		);
		if (seen.has(capabilityId)) {
			throw new TypeError("governed API tool capability ids must be unique.");
		}
		seen.add(capabilityId);
		if (
			record.kind !== "mcp" &&
			record.kind !== "a2a" &&
			record.kind !== "external_service"
		) {
			throw new TypeError(
				`governed API tool capabilities[${index}].kind is not admitted.`,
			);
		}
		const inputSchemaDigest = assertSha256Digest(
			record.inputSchemaDigest,
			`governed API tool capabilities[${index}].inputSchemaDigest`,
		);
		const outputSchemaDigest = assertSha256Digest(
			record.outputSchemaDigest,
			`governed API tool capabilities[${index}].outputSchemaDigest`,
		);
		capabilities.push(
			Object.freeze({
				schemaVersion: 1,
				capabilityId,
				kind: record.kind,
				inputSchemaDigest,
				outputSchemaDigest,
			}),
		);
	}
	return Object.freeze(capabilities);
}

function normalizeModelInputEvidence(
	input: ModelInputEvidenceV1,
): ModelInputEvidenceV1 {
	const record = readClosedRecord(input, "model input evidence", [
		"schemaVersion",
		"modelInputDigest",
		"modelRequestDigest",
		"canonicalInputDigest",
		"canonicalInputRef",
		"redactions",
	]);
	return Object.freeze({
		schemaVersion: assertExactSchemaVersion(
			record.schemaVersion,
			"model input evidence",
		),
		modelInputDigest: assertSha256Digest(
			record.modelInputDigest,
			"model input evidence modelInputDigest",
		),
		modelRequestDigest: assertSha256Digest(
			record.modelRequestDigest,
			"model input evidence modelRequestDigest",
		),
		canonicalInputDigest: assertSha256Digest(
			record.canonicalInputDigest,
			"model input evidence canonicalInputDigest",
		),
		canonicalInputRef: assertNonEmptyString(
			record.canonicalInputRef,
			"model input evidence canonicalInputRef",
		),
		redactions: normalizeRedactions(
			record.redactions,
			"model input evidence redactions",
		),
	});
}

function assertModelInputEvidenceBinding(
	evidence: ModelInputEvidenceV1,
	expected: {
		readonly modelInput: GovernedApiModelInput;
		readonly modelRequestDigest: string;
	},
): void {
	const expectedModelInputDigest = canonicalGovernedApiModelInputV1Digest(
		expected.modelInput,
	);
	const expectedModelRequestDigest = assertSha256Digest(
		expected.modelRequestDigest,
		"expected model input evidence modelRequestDigest",
	);
	if (
		evidence.modelInputDigest !== expectedModelInputDigest ||
		evidence.modelRequestDigest !== expectedModelRequestDigest
	) {
		throw new TypeError(
			"governed API model input evidence does not bind the exact provider request.",
		);
	}
	const expectedCanonicalInputDigest = canonicalModelInputEvidenceV1Digest({
		schemaVersion: evidence.schemaVersion,
		modelInputDigest: evidence.modelInputDigest,
		modelRequestDigest: evidence.modelRequestDigest,
		redactions: evidence.redactions,
	});
	if (evidence.canonicalInputDigest !== expectedCanonicalInputDigest) {
		throw new TypeError(
			"governed API model input evidence canonicalInputDigest must bind the exact request evidence record.",
		);
	}
	if (
		evidence.canonicalInputRef !==
		contentAddressedReference(evidence.canonicalInputDigest)
	) {
		throw new TypeError(
			"governed API model input evidence canonicalInputRef must be the canonical CAS reference for canonicalInputDigest.",
		);
	}
}

function normalizeModelResultEvidence(
	input: ModelResultEvidence,
): ModelResultEvidence {
	const record = readClosedRecord(input, "model result evidence", [
		"schemaVersion",
		"actionId",
		"actionRequestRef",
		"actionRequestDigest",
		"modelRequestDigest",
		"authorizationRef",
		"authorizationDigest",
		"resultDigest",
		"resultRef",
		"evidenceDigest",
		"evidenceRef",
		"redactions",
	]);
	return Object.freeze({
		schemaVersion: assertExactSchemaVersion(
			record.schemaVersion,
			"model result evidence",
		),
		actionId: assertNonEmptyString(
			record.actionId,
			"model result evidence actionId",
		),
		actionRequestRef: assertNonEmptyString(
			record.actionRequestRef,
			"model result evidence actionRequestRef",
		),
		actionRequestDigest: assertSha256Digest(
			record.actionRequestDigest,
			"model result evidence actionRequestDigest",
		),
		modelRequestDigest: assertSha256Digest(
			record.modelRequestDigest,
			"model result evidence modelRequestDigest",
		),
		authorizationRef: assertNonEmptyString(
			record.authorizationRef,
			"model result evidence authorizationRef",
		),
		authorizationDigest: assertSha256Digest(
			record.authorizationDigest,
			"model result evidence authorizationDigest",
		),
		resultDigest: assertSha256Digest(
			record.resultDigest,
			"model result evidence resultDigest",
		),
		resultRef: assertNonEmptyString(
			record.resultRef,
			"model result evidence resultRef",
		),
		evidenceDigest: assertSha256Digest(
			record.evidenceDigest,
			"model result evidence evidenceDigest",
		),
		evidenceRef: assertNonEmptyString(
			record.evidenceRef,
			"model result evidence evidenceRef",
		),
		redactions: normalizeRedactions(
			record.redactions,
			"model result evidence redactions",
		),
	});
}

function assertModelResultEvidenceBinding(
	evidence: ModelResultEvidence,
	expected: {
		readonly actionId: string;
		readonly actionRequestRef: string;
		readonly actionRequestDigest: string;
		readonly modelRequestDigest: string;
		readonly authorizationRef: string;
		readonly authorizationDigest: string;
		readonly completion: GovernedWorkerCompletionV1;
		readonly reviewOutput?: GovernedReviewVerdictOutputV1;
	},
): void {
	if (
		evidence.actionId !== expected.actionId ||
		evidence.actionRequestRef !== expected.actionRequestRef ||
		evidence.actionRequestDigest !== expected.actionRequestDigest ||
		evidence.modelRequestDigest !== expected.modelRequestDigest ||
		evidence.authorizationRef !== expected.authorizationRef ||
		evidence.authorizationDigest !== expected.authorizationDigest
	) {
		throw new TypeError(
			"governed API model result evidence does not bind the exact action, request, and native authorization.",
		);
	}
	const expectedResultDigest =
		expected.reviewOutput === undefined
			? canonicalImplementerCompletionV1Digest(
					expected.completion as ImplementerCompletionV1,
				)
			: canonicalReviewVerdictOutputV1Digest(expected.reviewOutput);
	if (evidence.resultDigest !== expectedResultDigest) {
		throw new TypeError(
			expected.reviewOutput === undefined
				? "governed API implementer result evidence must digest the exact canonical completion."
				: "governed API review result evidence must digest the exact canonical review output.",
		);
	}
	if (evidence.resultRef !== contentAddressedReference(evidence.resultDigest)) {
		throw new TypeError(
			"governed API model result evidence resultRef must be the canonical CAS reference for resultDigest.",
		);
	}
	const expectedEvidenceDigest = canonicalModelResultEvidenceV1Digest({
		schemaVersion: evidence.schemaVersion,
		actionId: evidence.actionId,
		actionRequestRef: evidence.actionRequestRef,
		actionRequestDigest: evidence.actionRequestDigest,
		modelRequestDigest: evidence.modelRequestDigest,
		authorizationRef: evidence.authorizationRef,
		authorizationDigest: evidence.authorizationDigest,
		resultDigest: evidence.resultDigest,
		resultRef: evidence.resultRef,
		redactions: evidence.redactions,
	});
	if (evidence.evidenceDigest !== expectedEvidenceDigest) {
		throw new TypeError(
			"governed API model result evidenceDigest must bind the complete canonical evidence record.",
		);
	}
	if (
		evidence.evidenceRef !== contentAddressedReference(evidence.evidenceDigest)
	) {
		throw new TypeError(
			"governed API model result evidence evidenceRef must be the canonical CAS reference for evidenceDigest.",
		);
	}
}

function contentAddressedReference(digest: string): string {
	return `cas:sha256:${assertSha256Digest(
		digest,
		"content-addressed digest",
	).slice("sha256:".length)}`;
}

function normalizeDurableActionRequest(
	input: unknown,
	expected: ActionRequestedV2,
): DurableActionRequestV2 {
	const record = readClosedRecord(input, "durable model action request", [
		"actionRequest",
		"actionRequestRef",
		"actionRequestDigest",
	]);
	const recordedRequest = parseActionRequestedV2(record.actionRequest);
	const expectedDigest = canonicalActionRequestedV2Digest(expected);
	const recordedDigest = assertSha256Digest(
		record.actionRequestDigest,
		"durable model action request actionRequestDigest",
	);
	if (
		canonicalActionRequestedV2Digest(recordedRequest) !== expectedDigest ||
		recordedDigest !== expectedDigest
	) {
		throw new TypeError(
			"durable model action request does not bind the expected V3 action request.",
		);
	}
	return {
		actionRequest: recordedRequest,
		actionRequestRef: assertNonEmptyString(
			record.actionRequestRef,
			"durable model action request actionRequestRef",
		),
		actionRequestDigest: recordedDigest,
	};
}

function normalizeDurableReceipt(
	input: unknown,
	expected: RecordActionReceiptV2Input,
): DurableActionReceiptReferenceV2 {
	const record = readClosedRecord(input, "durable model action receipt", [
		"receipt",
		"actionReceiptDigest",
	]);
	const receipt = readClosedRecord(
		record.receipt,
		"durable model action receipt receipt",
		[
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
		],
	);
	const recordedReceipt = parseActionReceiptRecordedV2(receipt);
	const expectedReceipt: ActionReceiptRecordedV2 = {
		...expected,
		actionReceiptRef: recordedReceipt.actionReceiptRef,
	};
	const expectedDigest =
		canonicalActionReceiptRecordedV2Digest(expectedReceipt);
	const recordedDigest = assertSha256Digest(
		record.actionReceiptDigest,
		"durable model action receipt actionReceiptDigest",
	);
	if (
		canonicalActionReceiptRecordedV2Digest(recordedReceipt) !==
			expectedDigest ||
		recordedDigest !== expectedDigest
	) {
		throw new TypeError(
			"durable model action receipt does not bind the expected V3 action receipt.",
		);
	}
	return {
		actionId: assertNonEmptyString(
			recordedReceipt.actionId,
			"durable model action receipt actionId",
		),
		actionReceiptRef: assertNonEmptyString(
			recordedReceipt.actionReceiptRef,
			"durable model action receipt actionReceiptRef",
		),
		actionReceiptDigest: recordedDigest,
	};
}

function normalizeClientResponse(input: unknown): GovernedApiClientResponse {
	const record = readClosedRecord(input, "governed API client response", [
		"completion",
		"toolCalls",
		"resourceUsage",
	]);
	if (!hasOwn(record, "completion")) {
		throw new TypeError("governed API client response requires completion.");
	}
	return {
		completion: record.completion,
		...(record.toolCalls === undefined
			? {}
			: { toolCalls: normalizeToolCalls(record.toolCalls) }),
		...(record.resourceUsage === undefined
			? {}
			: { resourceUsage: normalizeUsage(record.resourceUsage) }),
	};
}

function normalizeToolCalls(input: unknown): readonly GovernedApiToolCallV1[] {
	const values = readDenseDataArray(input, "governed API client toolCalls");
	const calls: GovernedApiToolCallV1[] = [];
	for (let index = 0; index < values.length; index += 1) {
		const record = readClosedRecord(
			values[index],
			`governed API client toolCalls[${index}]`,
			["schemaVersion", "capabilityId", "input"],
		);
		if (record.schemaVersion !== 1 || !hasOwn(record, "input")) {
			throw new TypeError(
				`governed API client toolCalls[${index}] must be a V1 typed capability call.`,
			);
		}
		calls.push({
			schemaVersion: 1,
			capabilityId: assertNonEmptyString(
				record.capabilityId,
				`governed API client toolCalls[${index}].capabilityId`,
			),
			input: record.input,
		});
	}
	return Object.freeze(calls);
}

function assertNoExecutableToolCalls(
	toolCalls: readonly GovernedApiToolCallV1[] | undefined,
	capabilities: readonly GovernedApiToolCapabilityV1[],
): void {
	if (!toolCalls || toolCalls.length === 0) return;
	for (const call of toolCalls) {
		if (!capabilities.some((item) => item.capabilityId === call.capabilityId)) {
			throw new TypeError(
				`governed API worker rejected undeclared tool capability "${call.capabilityId}".`,
			);
		}
	}
	throw new TypeError(
		"governed API worker has no typed tool execution port; declared tool calls are blocked rather than executed.",
	);
}

function parseCompletion(
	input: unknown,
	role: GovernedApiExecutionRole,
	dispatch: GovernedDispatchLineageV3,
	expectedCandidateDigest: string | undefined,
): GovernedWorkerCompletionV1 {
	if (role === "implementer") return parseImplementerCompletionV1(input);
	if (expectedCandidateDigest === undefined) {
		throw new TypeError(
			"governed API review verdicts require an immutable expected candidate digest.",
		);
	}
	const verdict = parseReviewVerdictV1(input);
	if (verdict.candidateDigest !== expectedCandidateDigest) {
		throw new TypeError(
			"governed API review verdict candidate digest must match the expected candidate.",
		);
	}
	if (verdict.reviewerManifestDigest !== dispatch.workerManifestDigest) {
		throw new TypeError(
			"governed API review verdict reviewer manifest digest must match the V3 dispatch.",
		);
	}
	return verdict;
}

function reviewVerdictOutput(
	verdict: ReviewVerdictV1,
	candidate: GovernedReviewCandidateDescriptorV1,
): GovernedReviewVerdictOutputV1 {
	return Object.freeze({
		candidateDigest: candidate.candidateDigest,
		candidateCommitSha: candidate.candidateCommitSha,
		decision: verdict.decision,
		findings: verdict.findings,
		confidence: verdict.confidence,
		candidateViewDigest: candidate.candidateViewDigest,
	});
}

/**
 * Exact native-compatible digest for the structured semantic reviewer output.
 * It intentionally excludes the reviewer manifest and activity receipt; those
 * belong to the surrounding signed review event, not model-generated text.
 */
export function canonicalReviewVerdictOutputV1Digest(
	input: GovernedReviewVerdictOutputV1,
): string {
	return canonicalKernelReviewVerdictOutputV1Digest(input);
}

/**
 * Exact canonical digest for a closed implementer completion. The worker uses
 * this instead of accepting an evidence-store supplied hash as the result of
 * an implementation action.
 */
export function canonicalImplementerCompletionV1Digest(
	input: ImplementerCompletionV1,
): string {
	const completion = parseImplementerCompletionV1(input);
	return sha256WithDomain(
		"buildplane.implementer-completion.v1\u0000",
		JSON.stringify({
			schema_version: completion.schemaVersion,
			outcome: completion.outcome,
			summary: completion.summary,
			output_refs: [...completion.outputRefs],
		}),
	);
}

/**
 * Canonical digest of the exact credential-free model input supplied to the
 * host gateway. The process-local abort signal and host credentials are never
 * part of this input.
 */
export function canonicalGovernedApiModelInputV1Digest(
	input: GovernedApiModelInput,
): string {
	return sha256WithDomain(
		"buildplane.model-input.v1\u0000",
		JSON.stringify(
			canonicalizeJsonValue(
				input,
				"governed API model input evidence",
				new Set<object>(),
			),
		),
	);
}

/**
 * Canonical digest for redacted model-input evidence. The CAS reference is
 * deliberately excluded because it is derived from this digest. Both the
 * input and request digests are independently recomputed by the worker before
 * any ActionRequestedV2 record or provider effect is permitted.
 */
export function canonicalModelInputEvidenceV1Digest(
	input: Omit<
		ModelInputEvidenceV1,
		"canonicalInputDigest" | "canonicalInputRef"
	>,
): string {
	if (input.schemaVersion !== 1) {
		throw new TypeError("model input evidence schemaVersion must be 1.");
	}
	const redactions = normalizeRedactions(
		input.redactions,
		"model input evidence redactions",
	);
	return sha256WithDomain(
		"buildplane.model-input-evidence.v1\u0000",
		JSON.stringify({
			schema_version: 1,
			model_input_digest: assertSha256Digest(
				input.modelInputDigest,
				"model input evidence modelInputDigest",
			),
			model_request_digest: assertSha256Digest(
				input.modelRequestDigest,
				"model input evidence modelRequestDigest",
			),
			redactions: redactions.map((redaction) => ({
				field: redaction.field,
				reason: redaction.reason,
				...(redaction.redactedDigest === undefined
					? {}
					: { redacted_digest: redaction.redactedDigest }),
			})),
		}),
	);
}

/**
 * Canonical digest for the durable model-result evidence binding. `evidenceRef`
 * is deliberately excluded: it is a deterministic CAS address derived from
 * this digest, rather than caller-controlled metadata.
 */
export function canonicalModelResultEvidenceV1Digest(
	input: Omit<ModelResultEvidence, "evidenceDigest" | "evidenceRef">,
): string {
	if (input.schemaVersion !== 1) {
		throw new TypeError("model result evidence schemaVersion must be 1.");
	}
	const redactions = normalizeRedactions(
		input.redactions,
		"model result evidence redactions",
	);
	return sha256WithDomain(
		"buildplane.model-result-evidence.v1\u0000",
		JSON.stringify({
			schema_version: 1,
			action_id: assertNonEmptyString(
				input.actionId,
				"model result evidence actionId",
			),
			action_request_ref: assertNonEmptyString(
				input.actionRequestRef,
				"model result evidence actionRequestRef",
			),
			action_request_digest: assertSha256Digest(
				input.actionRequestDigest,
				"model result evidence actionRequestDigest",
			),
			model_request_digest: assertSha256Digest(
				input.modelRequestDigest,
				"model result evidence modelRequestDigest",
			),
			authorization_ref: assertNonEmptyString(
				input.authorizationRef,
				"model result evidence authorizationRef",
			),
			authorization_digest: assertSha256Digest(
				input.authorizationDigest,
				"model result evidence authorizationDigest",
			),
			result_digest: assertSha256Digest(
				input.resultDigest,
				"model result evidence resultDigest",
			),
			result_ref: assertNonEmptyString(
				input.resultRef,
				"model result evidence resultRef",
			),
			redactions: redactions.map((redaction) => ({
				field: redaction.field,
				reason: redaction.reason,
				...(redaction.redactedDigest === undefined
					? {}
					: { redacted_digest: redaction.redactedDigest }),
			})),
		}),
	);
}

/** Strict parser for the closed implementer completion contract. */
export function parseImplementerCompletionV1(
	input: unknown,
): ImplementerCompletionV1 {
	const record = readClosedRecord(input, "implementerCompletion", [
		"schemaVersion",
		"outcome",
		"summary",
		"outputRefs",
	]);
	if (record.schemaVersion !== 1) {
		throw new TypeError("implementerCompletion.schemaVersion must be 1.");
	}
	if (record.outcome !== "completed") {
		throw new TypeError("implementerCompletion.outcome must be completed.");
	}
	return Object.freeze({
		schemaVersion: 1,
		outcome: "completed",
		summary: assertNonEmptyString(
			record.summary,
			"implementerCompletion.summary",
		),
		outputRefs: normalizeStringArray(
			record.outputRefs,
			"implementerCompletion.outputRefs",
		),
	});
}

function normalizeUsage(input: unknown): GovernedApiClientUsage {
	const record = readClosedRecord(input, "governed API client resourceUsage", [
		"wallTimeMs",
		"inputBytes",
		"outputBytes",
		"inputTokens",
		"outputTokens",
	]);
	return Object.freeze({
		...(record.wallTimeMs === undefined
			? {}
			: {
					wallTimeMs: assertNonNegativeSafeInteger(
						record.wallTimeMs,
						"governed API client resourceUsage.wallTimeMs",
					),
				}),
		...(record.inputBytes === undefined
			? {}
			: {
					inputBytes: assertNonNegativeSafeInteger(
						record.inputBytes,
						"governed API client resourceUsage.inputBytes",
					),
				}),
		...(record.outputBytes === undefined
			? {}
			: {
					outputBytes: assertNonNegativeSafeInteger(
						record.outputBytes,
						"governed API client resourceUsage.outputBytes",
					),
				}),
		...(record.inputTokens === undefined
			? {}
			: {
					inputTokens: assertNonNegativeSafeInteger(
						record.inputTokens,
						"governed API client resourceUsage.inputTokens",
					),
				}),
		...(record.outputTokens === undefined
			? {}
			: {
					outputTokens: assertNonNegativeSafeInteger(
						record.outputTokens,
						"governed API client resourceUsage.outputTokens",
					),
				}),
	});
}

/** A known post-effect budget violation is terminal failure, never success. */
class GovernedApiTokenBudgetError extends Error {
	readonly code:
		| "model-token-usage-missing"
		| "model-token-budget-exceeded"
		| "model-token-budget-invalid";

	constructor(
		code:
			| "model-token-usage-missing"
			| "model-token-budget-exceeded"
			| "model-token-budget-invalid",
		message: string,
	) {
		super(message);
		this.name = "GovernedApiTokenBudgetError";
		this.code = code;
	}
}

/**
 * The host gateway must enforce the request limit before HTTP. This check is
 * an independent receipt gate: a provider result that lacks verifiable token
 * accounting or exceeds the signed total can never advance to a candidate.
 */
function assertResponseWithinModelTokenBudget(
	usage: GovernedApiClientUsage | undefined,
	budget: GovernedApiModelBudgetV1,
): void {
	const maxTotalTokens = budget.maxTotalTokens;
	if (maxTotalTokens === undefined) return;
	if (usage?.inputTokens === undefined || usage.outputTokens === undefined) {
		throw new GovernedApiTokenBudgetError(
			"model-token-usage-missing",
			"governed API provider response must report inputTokens and outputTokens for a signed maxTokens budget.",
		);
	}
	if (usage.inputTokens > Number.MAX_SAFE_INTEGER - usage.outputTokens) {
		throw new GovernedApiTokenBudgetError(
			"model-token-budget-invalid",
			"governed API provider token usage overflows the total-token calculation.",
		);
	}
	const totalTokens = usage.inputTokens + usage.outputTokens;
	if (totalTokens > maxTotalTokens) {
		throw new GovernedApiTokenBudgetError(
			"model-token-budget-exceeded",
			`governed API provider used ${totalTokens} tokens, exceeding the signed maxTokens budget of ${maxTotalTokens}.`,
		);
	}
}

function resourceUsage(
	usage: GovernedApiClientUsage | undefined,
): ActionResourceUsageV2 {
	return {
		wallTimeMs: usage?.wallTimeMs ?? 0,
		...(usage?.inputBytes === undefined
			? {}
			: { inputBytes: usage.inputBytes }),
		...(usage?.outputBytes === undefined
			? {}
			: { outputBytes: usage.outputBytes }),
		...(usage?.inputTokens === undefined
			? {}
			: { inputTokens: usage.inputTokens }),
		...(usage?.outputTokens === undefined
			? {}
			: { outputTokens: usage.outputTokens }),
	};
}

async function recordVerifiedSuccessReceiptOrThrowUnknown(input: {
	readonly actionEvidencePort: GovernedActionEvidencePort;
	readonly receiptInput: RecordActionReceiptV2Input;
	readonly dispatch: GovernedDispatchLineageV3;
	readonly actionId: string;
	readonly idempotencyKey: string;
	readonly actionRequestDigest: string;
	readonly actionRequestRef: string;
	readonly redactions: readonly ActionRedactionV2[];
	readonly authorizationRef?: string;
	readonly completedAt: string;
}): Promise<DurableActionReceiptReferenceV2> {
	try {
		const recorded = await input.actionEvidencePort.recordActionReceipt(
			input.receiptInput,
		);
		return normalizeDurableReceipt(recorded, input.receiptInput);
	} catch {
		return persistUnknownOrThrowUnknown({
			actionEvidencePort: input.actionEvidencePort,
			dispatch: input.dispatch,
			actionId: input.actionId,
			idempotencyKey: input.idempotencyKey,
			actionRequestDigest: input.actionRequestDigest,
			actionRequestRef: input.actionRequestRef,
			redactions: input.redactions,
			resourceUsage: input.receiptInput.resourceUsage,
			...(input.authorizationRef === undefined
				? {}
				: { authorizationRef: input.authorizationRef }),
			completedAt: input.completedAt,
			failureCode: "success-receipt-persistence-ambiguous",
		});
	}
}

async function persistUnknownOrThrowUnknown(input: {
	readonly actionEvidencePort: GovernedActionEvidencePort;
	readonly dispatch: GovernedDispatchLineageV3;
	readonly actionId: string;
	readonly idempotencyKey: string;
	readonly actionRequestDigest: string;
	readonly actionRequestRef: string;
	readonly redactions: readonly ActionRedactionV2[];
	/** Preserve metered usage if ambiguity happened after a provider response. */
	readonly resourceUsage?: ActionResourceUsageV2;
	readonly authorizationRef?: string;
	readonly completedAt: string;
	readonly failureCode: string;
}): Promise<never> {
	try {
		await persistTerminalReceipt({
			...input,
			outcome: "unknown",
			evidenceDigest: input.actionRequestDigest,
			evidenceRef: input.actionRequestRef,
			failureMessage: input.failureCode,
		});
	} catch {
		throw new GovernedApiUnknownEffectError(
			"governed API effect is an unknown effect and its terminal receipt could not be persisted; do not retry.",
		);
	}
	throw new GovernedApiUnknownEffectError(
		"governed API effect is an unknown effect after its durable action request; do not retry.",
	);
}

async function persistTerminalFailureOrThrowUnknown(input: {
	readonly actionEvidencePort: GovernedActionEvidencePort;
	readonly dispatch: GovernedDispatchLineageV3;
	readonly actionId: string;
	readonly idempotencyKey: string;
	readonly actionRequestDigest: string;
	readonly evidenceDigest: string;
	readonly evidenceRef: string;
	readonly redactions: readonly ActionRedactionV2[];
	readonly outcome: "failed" | "denied";
	readonly failureCode: string;
	readonly failureMessage: string;
	/** Preserve host-observed provider usage on metered terminal failures. */
	readonly resourceUsage?: ActionResourceUsageV2;
	readonly authorizationRef?: string;
	readonly completedAt: string;
}): Promise<void> {
	try {
		await persistTerminalReceipt(input);
	} catch {
		throw new GovernedApiUnknownEffectError(
			"governed API terminal receipt persistence failed after authorization; this is an unknown effect and must not be retried.",
		);
	}
}

async function persistTerminalReceipt(input: {
	readonly actionEvidencePort: GovernedActionEvidencePort;
	readonly dispatch: GovernedDispatchLineageV3;
	readonly actionId: string;
	readonly idempotencyKey: string;
	readonly actionRequestDigest: string;
	readonly evidenceDigest: string;
	readonly evidenceRef: string;
	readonly redactions: readonly ActionRedactionV2[];
	readonly outcome: "failed" | "denied" | "unknown";
	readonly failureCode: string;
	readonly failureMessage: string;
	readonly resourceUsage?: ActionResourceUsageV2;
	readonly authorizationRef?: string;
	readonly completedAt: string;
}): Promise<void> {
	const receiptInput: RecordActionReceiptV2Input = {
		schemaVersion: 2,
		runId: input.dispatch.runId,
		workflowId: input.dispatch.workflowId,
		unitId: input.dispatch.unitId,
		attempt: input.dispatch.attempt,
		provenanceRef: input.dispatch.provenanceRef,
		actionId: input.actionId,
		idempotencyKey: input.idempotencyKey,
		actionRequestDigest: input.actionRequestDigest,
		dispatchEnvelopeDigest: input.dispatch.envelopeDigest,
		capabilityBundleDigest: input.dispatch.capabilityBundleDigest,
		policyDigest: input.dispatch.policyDigest,
		contextManifestDigest: input.dispatch.contextManifestDigest,
		workerManifestDigest: input.dispatch.workerManifestDigest,
		sandboxProfileDigest: input.dispatch.sandboxProfileDigest,
		authorityActor: input.dispatch.authorityActor,
		executionRole: input.dispatch.executionRole,
		...(input.authorizationRef === undefined
			? {}
			: { authorizationRef: input.authorizationRef }),
		outcome: input.outcome,
		evidenceDigest: input.evidenceDigest,
		evidenceRef: input.evidenceRef,
		resourceUsage: input.resourceUsage ?? { wallTimeMs: 0 },
		redactions: input.redactions,
		failure: {
			code: input.failureCode,
			messageDigest: sha256(input.failureMessage),
			retryable: false,
		},
		completedAt: input.completedAt,
	};
	const recorded =
		await input.actionEvidencePort.recordActionReceipt(receiptInput);
	normalizeDurableReceipt(recorded, receiptInput);
}

function executionReceipt(
	packet: UnitPacket,
	modelInput: GovernedApiModelInput,
	completion: GovernedWorkerCompletionV1,
	projectRoot: string,
	startedAt: string,
	completedAt: string,
): ExecutionReceipt {
	return {
		command: "governed-api-model",
		args: [modelInput.provider, modelInput.model],
		cwd: projectRoot,
		startedAt,
		completedAt,
		exitCode: 0,
		// Compatibility bridge for the existing strategy consumer. This is the
		// already parsed closed verdict, never raw provider text; the typed
		// `reviewVerdict` result remains the authoritative adapter output.
		stdout: isReviewVerdict(completion)
			? canonicalReviewVerdictJson(completion)
			: "",
		stderr: "",
		// This adapter deliberately has no host file access. Required outputs are
		// not claimed from an ambient filesystem and remain false until a typed
		// action-plane adapter proves them.
		outputChecks: packet.verification.requiredOutputs.map((path) => ({
			path,
			exists: false,
		})),
	};
}

function isReviewVerdict(
	completion: GovernedWorkerCompletionV1,
): completion is ReviewVerdictV1 {
	return "decision" in completion;
}

function canonicalReviewVerdictJson(verdict: ReviewVerdictV1): string {
	return JSON.stringify(
		canonicalizeJsonValue(verdict, "governed API review verdict", new Set()),
	);
}

function governedModelActionId(dispatch: GovernedDispatchLineageV3): string {
	return `model:${dispatch.runId}:${dispatch.unitId}:${dispatch.attempt}`;
}

function mergeRedactions(
	first: readonly ActionRedactionV2[],
	second: readonly ActionRedactionV2[],
): readonly ActionRedactionV2[] {
	const merged: ActionRedactionV2[] = [];
	const seen = new Set<string>();
	for (const item of [...first, ...second]) {
		if (seen.has(item.field)) continue;
		seen.add(item.field);
		merged.push(item);
	}
	return Object.freeze(merged);
}

function normalizeRedactions(
	input: unknown,
	label: string,
): readonly ActionRedactionV2[] {
	const values = readDenseDataArray(input, label);
	const redactions: ActionRedactionV2[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < values.length; index += 1) {
		const record = readClosedRecord(values[index], `${label}[${index}]`, [
			"field",
			"reason",
			"redactedDigest",
		]);
		const field = assertNonEmptyString(
			record.field,
			`${label}[${index}].field`,
		);
		if (seen.has(field)) {
			throw new TypeError(`${label} must not contain duplicate fields.`);
		}
		seen.add(field);
		redactions.push(
			Object.freeze({
				field,
				reason: assertNonEmptyString(
					record.reason,
					`${label}[${index}].reason`,
				),
				...(record.redactedDigest === undefined
					? {}
					: {
							redactedDigest: assertSha256Digest(
								record.redactedDigest,
								`${label}[${index}].redactedDigest`,
							),
						}),
			}),
		);
	}
	return Object.freeze(redactions);
}

function normalizeStringArray(
	input: unknown,
	label: string,
): readonly string[] {
	const entries = readDenseDataArray(input, label);
	const values: string[] = [];
	for (let index = 0; index < entries.length; index += 1) {
		values.push(assertNonEmptyString(entries[index], `${label}[${index}]`));
	}
	return Object.freeze(values);
}

function readDenseDataArray(input: unknown, label: string): readonly unknown[] {
	try {
		if (
			!Array.isArray(input) ||
			Object.getPrototypeOf(input) !== Array.prototype
		) {
			throw new TypeError(`${label} must be a dense data array.`);
		}
		const descriptors = Object.getOwnPropertyDescriptors(input);
		const length = Object.getOwnPropertyDescriptor(input, "length")?.value;
		if (
			typeof length !== "number" ||
			!Number.isSafeInteger(length) ||
			length < 0
		) {
			throw new TypeError(`${label} must be a dense data array.`);
		}
		const values: unknown[] = [];
		for (let index = 0; index < length; index += 1) {
			const descriptor = descriptors[String(index)];
			if (!descriptor || !("value" in descriptor)) {
				throw new TypeError(`${label} must be a dense data array.`);
			}
			values.push(descriptor.value);
		}
		for (const key of Reflect.ownKeys(descriptors)) {
			if (
				typeof key !== "string" ||
				(key !== "length" && !isArrayIndex(key, length))
			) {
				throw new TypeError(`${label} must be a dense data array.`);
			}
		}
		return values;
	} catch {
		throw new TypeError(`${label} must be a dense data array.`);
	}
}

function isArrayIndex(key: string, length: number): boolean {
	if (!/^(0|[1-9][0-9]*)$/.test(key)) return false;
	const index = Number(key);
	return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function readClosedRecord(
	input: unknown,
	label: string,
	allowedFields: readonly string[],
): Record<string, unknown> {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		throw new TypeError(`${label} must be an object.`);
	}
	const source = input as Record<string, unknown>;
	if (Object.getOwnPropertySymbols(source).length > 0) {
		throw new TypeError(`${label} has unknown symbol field.`);
	}
	const allowed = new Set(allowedFields);
	const record = Object.create(null) as Record<string, unknown>;
	for (const key of Object.getOwnPropertyNames(source)) {
		if (!hasOwn(source, key)) continue;
		if (!allowed.has(key)) {
			throw new TypeError(`${label} has unknown field "${key}".`);
		}
		const descriptor = Object.getOwnPropertyDescriptor(source, key);
		if (!descriptor || !("value" in descriptor)) {
			throw new TypeError(`${label}.${key} must be a data property.`);
		}
		record[key] = descriptor.value;
	}
	return record;
}

function assertNonEmptyString(input: unknown, label: string): string {
	if (typeof input !== "string" || input.length === 0) {
		throw new TypeError(`${label} must be a non-empty string.`);
	}
	return input;
}

function assertExactSchemaVersion(input: unknown, label: string): 1 {
	if (input !== 1) {
		throw new TypeError(`${label}.schemaVersion must be 1.`);
	}
	return 1;
}

/** Mirror the native ledger's canonical actor-id grammar at the TS boundary. */
function assertCanonicalAuthorityActor(input: unknown, label: string): string {
	const actor = assertNonEmptyString(input, label);
	if (!/^[A-Za-z0-9:._/-]+$/.test(actor)) {
		throw new TypeError(
			`${label} must contain only canonical authority actor characters.`,
		);
	}
	return actor;
}

function optionalNonEmptyString(
	input: unknown,
	label: string,
): string | undefined {
	if (input === undefined) return undefined;
	return assertNonEmptyString(input, label);
}

function assertSha256Digest(input: unknown, label: string): string {
	const value = assertNonEmptyString(input, label);
	if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
		throw new TypeError(`${label} must be a sha256 digest.`);
	}
	return value;
}

/** Matches the generated ledger EventId wire representation. */
function assertLedgerEventId(input: unknown, label: string): string {
	const value = assertNonEmptyString(input, label);
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
			value,
		)
	) {
		throw new TypeError(`${label} must be a canonical ledger event UUID.`);
	}
	return value;
}

function assertEvidenceSchemaVersion(input: unknown, label: string): number {
	if (input !== 1) {
		throw new TypeError(
			`${label}.schema_version must equal the closed V1 schema.`,
		);
	}
	return 1;
}

function assertCanonicalCasReference(input: unknown, label: string): string {
	const value = assertNonEmptyString(input, label);
	if (
		!value.startsWith("cas:") ||
		value.length === "cas:".length ||
		/\s/.test(value) ||
		value.includes("..")
	) {
		throw new TypeError(
			`${label} must be a canonical non-relative CAS reference.`,
		);
	}
	return value;
}

function assertDigestCasReference(
	input: unknown,
	digest: string,
	label: string,
): string {
	const reference = assertCanonicalCasReference(input, label);
	if (reference !== contentAddressedReference(digest)) {
		throw new TypeError(`${label} must name the exact raw evidence digest.`);
	}
	return reference;
}

function assertExactBoolean(input: unknown, label: string): boolean {
	if (typeof input !== "boolean") {
		throw new TypeError(`${label} must be a boolean.`);
	}
	return input;
}

function assertNonNegativeSafeInteger(input: unknown, label: string): number {
	if (!Number.isSafeInteger(input) || (input as number) < 0) {
		throw new TypeError(`${label} must be a non-negative safe integer.`);
	}
	return input as number;
}

function assertPositiveSafeInteger(input: unknown, label: string): number {
	if (!Number.isSafeInteger(input) || (input as number) < 1) {
		throw new TypeError(`${label} must be a positive safe integer.`);
	}
	return input as number;
}

function assertCommitSha(input: unknown, label: string): string {
	const value = assertNonEmptyString(input, label);
	if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)) {
		throw new TypeError(`${label} must be a 40- or 64-character commit SHA.`);
	}
	return value;
}

function assertCandidateRef(input: unknown, label: string): string {
	const value = assertNonEmptyString(input, label);
	const prefix = "refs/buildplane/candidates/";
	const suffix = value.startsWith(prefix) ? value.slice(prefix.length) : "";
	if (
		suffix.length === 0 ||
		suffix.endsWith("/") ||
		suffix.endsWith(".") ||
		suffix.endsWith(".lock") ||
		suffix.includes("..") ||
		suffix.includes("//") ||
		suffix.includes("@{") ||
		!suffix
			.split("/")
			.every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))
	) {
		throw new TypeError(
			`${label} must be a canonical refs/buildplane/candidates Git ref.`,
		);
	}
	return value;
}

function readTimestamp(now: () => string, label: string): string {
	return assertRfc3339UtcTimestamp(now(), label);
}

function assertRfc3339UtcTimestamp(input: unknown, label: string): string {
	const timestamp = input;
	if (
		typeof timestamp !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp) ||
		Number.isNaN(Date.parse(timestamp))
	) {
		throw new TypeError(`${label} must be an RFC3339 UTC timestamp.`);
	}
	// Date.parse accepts rollover dates such as 2099-02-30 and silently
	// normalizes them. Round-trip through ISO text so this boundary agrees with
	// the native Chrono parser rather than authorizing a different instant.
	const normalized = timestamp.includes(".")
		? timestamp
		: timestamp.replace("Z", ".000Z");
	if (new Date(Date.parse(timestamp)).toISOString() !== normalized) {
		throw new TypeError(`${label} must be an RFC3339 UTC timestamp.`);
	}
	return timestamp;
}

function isReviewRole(role: GovernedApiExecutionRole): boolean {
	return role === "reviewer" || role === "adversary" || role === "judge";
}

/**
 * This descriptor is intentionally role-derived rather than model supplied.
 * The parser remains a second line of defense, while the host gateway must
 * refuse to issue a provider request unless its native structured-output
 * facility applies this exact digest.
 */
function responseSchemaForRole(
	role: GovernedApiExecutionRole,
): GovernedApiResponseSchemaV1 {
	const kind = isReviewRole(role)
		? ("review_verdict_v1" as const)
		: ("implementer_completion_v1" as const);
	const descriptor =
		kind === "implementer_completion_v1"
			? {
					schemaVersion: 1,
					kind,
					required: ["schemaVersion", "outcome", "summary", "outputRefs"],
					outcome: "completed",
				}
			: {
					schemaVersion: 1,
					kind,
					required: [
						"schemaVersion",
						"candidateDigest",
						"decision",
						"findings",
						"confidence",
						"reviewerManifestDigest",
					],
					decisions: ["approve", "request_changes", "reject", "abstain"],
				};
	return Object.freeze({
		schemaVersion: 1,
		kind,
		digest: sha256WithDomain(
			"buildplane.governed-api-response-schema.v1\u0000",
			JSON.stringify(descriptor),
		),
	});
}

function safeErrorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message.length > 0
		? error.message
		: fallback;
}

function sha256(value: string): string {
	return sha256WithDomain("", value);
}

function sha256WithDomain(domain: string, value: string): string {
	return `sha256:${createHash("sha256")
		.update(domain, "utf8")
		.update(value, "utf8")
		.digest("hex")}`;
}

function hasOwn(input: object, key: string): boolean {
	return Object.hasOwn(input, key);
}
