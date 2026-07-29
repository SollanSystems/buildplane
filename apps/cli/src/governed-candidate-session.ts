import { createHash } from "node:crypto";
import {
	type ApprovedPolicyDecision,
	assertActiveGovernedDispatchAuthorityWindowV1,
	type CandidateAcceptanceRecord,
	canonicalGovernedUnitPacketV1Digest,
	canonicalSha256Digest,
	type EventBus,
	type GovernedDispatchLineageV3,
	type GovernedLedgerAuthorityRealmPort,
	type GovernedRepositoryBindingPort,
	isCanonicalBuildplaneCandidateRef,
	parseGovernedUnitPacket,
	type RunPacketOptions,
	type RunPacketResult,
	type UnitPacket,
	type WorkspaceCandidateArtifact,
} from "@buildplane/kernel";
import type { ResolvedGovernedDispatchSnapshot } from "./ledger-governed-dispatch-resolver.js";

const FULL_LOWERCASE_COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CANONICAL_UUID_V7 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The only orchestrator surface a candidate-only CLI session needs. */
export interface GovernedCandidateSessionOrchestrator {
	runPacketAsync(
		packet: UnitPacket,
		eventBus: EventBus | undefined,
		runOptions: RunPacketOptions,
	): Promise<RunPacketResult>;
}

export interface ExecuteGovernedCandidateSessionInput {
	readonly packet: UnitPacket;
	readonly dispatch: GovernedDispatchLineageV3;
	readonly projectRoot: string;
	readonly repositoryBindingPort: GovernedRepositoryBindingPort;
	readonly ledgerAuthorityRealmPort: GovernedLedgerAuthorityRealmPort;
	/** Fresh native, signature-verified replay snapshot for this exact dispatch. */
	readonly resolution: ResolvedGovernedDispatchSnapshot;
	readonly orchestrator: GovernedCandidateSessionOrchestrator;
	readonly eventBus?: EventBus;
}

/** A candidate may reach review only with deterministic acceptance evidence. */
export type GovernedCandidateSessionResult = RunPacketResult & {
	readonly candidate: WorkspaceCandidateArtifact;
	readonly decision: ApprovedPolicyDecision;
	readonly candidateAcceptance: CandidateAcceptanceRecord;
};

/**
 * Starts one clean, candidate-only attempt. This helper intentionally owns no
 * promotion API and rejects all partially executed/recovery state: a future
 * reducer-driven resume path must reconcile those states rather than issuing a
 * second worker effect from process memory.
 */
export async function executeGovernedCandidateSession(
	input: ExecuteGovernedCandidateSessionInput,
): Promise<GovernedCandidateSessionResult> {
	const prepared = validateInput(input);
	const result = await prepared.orchestrator.runPacketAsync(
		prepared.packet,
		prepared.eventBus,
		Object.freeze({
			runId: prepared.dispatch.runId,
			trustLane: "governed",
			finalizationMode: "create-candidate",
			workspaceBaseSha: prepared.dispatch.baseCommitSha,
			candidateIdentity: Object.freeze({
				candidateId: candidateIdForDispatch(prepared.dispatch),
				attempt: prepared.dispatch.attempt,
			}),
			governedDispatch: prepared.dispatch,
		}),
	);
	return assertCandidateCompletion(result, prepared.dispatch);
}

/** Stable safe ref segment; no caller-provided run text becomes a Git ref path. */
export function candidateIdForDispatch(
	dispatch: GovernedDispatchLineageV3,
): string {
	const material = [
		dispatch.runId,
		dispatch.workflowId,
		dispatch.unitId,
		String(dispatch.attempt),
		dispatch.envelopeDigest,
	].join("\0");
	return `candidate-${createHash("sha256")
		.update("buildplane.governed-candidate.v1\0")
		.update(material, "utf8")
		.digest("hex")
		.slice(0, 32)}`;
}

function candidateKeyForDispatch(dispatch: GovernedDispatchLineageV3): string {
	return `${candidateIdForDispatch(dispatch)}/${dispatch.runId}/${dispatch.attempt}`;
}

function candidateRefForDispatch(dispatch: GovernedDispatchLineageV3): string {
	return `refs/buildplane/candidates/${candidateKeyForDispatch(dispatch)}`;
}

function validateInput(
	input: ExecuteGovernedCandidateSessionInput,
): ExecuteGovernedCandidateSessionInput {
	if (!input || typeof input !== "object") {
		throw new TypeError("governed candidate session requires an input object.");
	}
	if (
		!input.orchestrator ||
		typeof input.orchestrator.runPacketAsync !== "function"
	) {
		throw new TypeError(
			"governed candidate session requires an orchestrator with runPacketAsync.",
		);
	}
	const dispatch = input.dispatch;
	if (
		!dispatch ||
		dispatch.schemaVersion !== 3 ||
		dispatch.trustTier !== "governed" ||
		dispatch.commitMode !== "atomic" ||
		dispatch.actionEvidenceVersion !== "sealed_v3" ||
		dispatch.executionRole !== "implementer"
	) {
		throw new TypeError(
			"governed candidate session requires an implementer atomic sealed_v3 dispatch.",
		);
	}
	try {
		assertActiveGovernedDispatchAuthorityWindowV1(dispatch);
	} catch (error) {
		throw new TypeError(
			`governed candidate session requires an active verified dispatch authority window: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	if (
		typeof input.projectRoot !== "string" ||
		input.projectRoot.length === 0 ||
		input.projectRoot.includes("\0")
	) {
		throw new TypeError(
			"governed candidate session requires a non-empty projectRoot for repository binding.",
		);
	}
	if (
		!input.repositoryBindingPort ||
		typeof input.repositoryBindingPort.assertDispatchRepositoryBinding !==
			"function"
	) {
		throw new TypeError(
			"governed candidate session requires a repository binding verifier.",
		);
	}
	input.repositoryBindingPort.assertDispatchRepositoryBinding({
		projectRoot: input.projectRoot,
		dispatch,
	});
	if (
		!input.ledgerAuthorityRealmPort ||
		typeof input.ledgerAuthorityRealmPort.assertDispatchLedgerAuthorityRealm !==
			"function"
	) {
		throw new TypeError(
			"governed candidate session requires a ledger authority realm verifier.",
		);
	}
	input.ledgerAuthorityRealmPort.assertDispatchLedgerAuthorityRealm({
		dispatch,
	});
	let strictPacket: UnitPacket;
	try {
		strictPacket = parseGovernedUnitPacket(JSON.stringify(input.packet));
	} catch (error) {
		throw new TypeError(
			`governed candidate session packet is not strictly admitted: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	if (
		strictPacket.model !== undefined ||
		strictPacket.execution === undefined
	) {
		throw new TypeError(
			"the first governed candidate session supports only command packets with typed OCI actions; model packets remain blocked.",
		);
	}
	if (
		strictPacket.unit.id !== dispatch.unitId ||
		strictPacket.execution_role !== dispatch.executionRole ||
		strictPacket.provenance_ref !== dispatch.provenanceRef ||
		strictPacket.capability_bundle_digest !== dispatch.capabilityBundleDigest
	) {
		throw new TypeError(
			"governed candidate session packet does not exactly match its verified dispatch unit, role, provenance, or capability authority.",
		);
	}
	if (
		canonicalGovernedUnitPacketV1Digest(strictPacket) !==
		dispatch.governedPacketDigest
	) {
		throw new TypeError(
			"governed candidate session packet does not match the exact packet digest bound into the signed dispatch.",
		);
	}
	const resolution = input.resolution;
	if (!resolution || typeof resolution !== "object") {
		throw new TypeError(
			"governed candidate session requires a fresh native replay resolution.",
		);
	}
	assertSameDispatch(dispatch, resolution.dispatch);
	if (
		resolution.phase !== "dispatched" ||
		resolution.recovery.requests.length > 0 ||
		resolution.recovery.receipts.length > 0 ||
		resolution.recovery.candidates.length > 0 ||
		resolution.recovery.receiptSet !== undefined ||
		resolution.pendingActionIds.length > 0 ||
		resolution.unknownActionIds.length > 0 ||
		resolution.failedActionIds.length > 0
	) {
		throw new Error(
			"governed candidate session observed existing action or candidate state; recovery must reconcile it before any new worker effect.",
		);
	}
	return Object.freeze({ ...input, packet: strictPacket });
}

function assertSameDispatch(
	provided: GovernedDispatchLineageV3,
	trusted: GovernedDispatchLineageV3,
): void {
	const fields: readonly (keyof GovernedDispatchLineageV3)[] = [
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
		"executionRole",
		"commitMode",
		"trustTier",
		"capabilityBundleDigest",
		"acceptanceContractDigest",
		"policyDigest",
		"contextManifestDigest",
		"workerManifestDigest",
		"sandboxProfileDigest",
		"repositoryBindingDigest",
		"ledgerAuthorityRealmDigest",
		"governedPacketDigest",
		"idempotencyKey",
		"authorityActor",
		"actionEvidenceVersion",
		"issuedAt",
		"expiresAt",
	];
	for (const field of fields) {
		if (provided[field] !== trusted[field]) {
			throw new TypeError(
				`governed candidate session dispatch differs from trusted native replay at ${String(field)}.`,
			);
		}
	}
	if (
		provided.budget.maxTokens !== trusted.budget.maxTokens ||
		provided.budget.maxComputeTimeMs !== trusted.budget.maxComputeTimeMs
	) {
		throw new TypeError(
			"governed candidate session dispatch budget differs from trusted native replay.",
		);
	}
}

function assertCandidateCompletion(
	result: RunPacketResult,
	dispatch: GovernedDispatchLineageV3,
): GovernedCandidateSessionResult {
	const completion = captureCandidateCompletion(result);
	if (
		!completion.candidate ||
		completion.failure ||
		completion.mergedHeadSha !== undefined
	) {
		throw new Error(
			"governed candidate session did not produce an immutable candidate without target-branch mutation.",
		);
	}
	const candidate = completion.candidate;
	const dispatchBaseSha = requireFullLowercaseCommitSha(
		dispatch.baseCommitSha,
		"dispatch.baseCommitSha",
	);
	const expectedCandidateId = candidateIdForDispatch(dispatch);
	const expectedCandidateKey = candidateKeyForDispatch(dispatch);
	const expectedCandidateRef = candidateRefForDispatch(dispatch);
	const candidateBaseSha = requireFullLowercaseCommitSha(
		candidate.baseSha,
		"candidate.baseSha",
	);
	if (
		candidate.schemaVersion !== 1 ||
		candidateBaseSha !== dispatchBaseSha ||
		candidate.runId !== dispatch.runId ||
		candidate.attempt !== dispatch.attempt
	) {
		throw new Error(
			"governed candidate session returned a candidate whose base/run/attempt does not match the verified dispatch.",
		);
	}
	if (candidate.candidateId !== expectedCandidateId) {
		throw new Error(
			"governed candidate session returned a candidate whose identity does not match the verified dispatch.",
		);
	}
	const candidateRef = requireCanonicalCandidateRef(candidate.candidateRef);
	if (
		candidate.candidateKey !== expectedCandidateKey ||
		candidateRef !== expectedCandidateRef
	) {
		throw new Error(
			"governed candidate session returned a candidate key or ref that does not match the verified dispatch.",
		);
	}
	const candidateDigest = canonicalizeSourceDigest(
		candidate.candidateDigest,
		"candidate.candidateDigest",
	);
	const candidateCommitSha = requireFullLowercaseCommitSha(
		candidate.candidateCommitSha,
		"candidate.candidateCommitSha",
	);
	const commitDigest = canonicalizeSourceDigest(
		candidate.commitDigest,
		"candidate.commitDigest",
	);
	const treeDigest = canonicalizeSourceDigest(
		candidate.treeDigest,
		"candidate.treeDigest",
	);
	const patchDigest = canonicalizeSourceDigest(
		candidate.patchDigest,
		"candidate.patchDigest",
	);
	const changedFilesDigest = canonicalizeSourceDigest(
		candidate.changedFilesDigest,
		"candidate.changedFilesDigest",
	);
	if (
		!completion.run ||
		completion.run.id !== dispatch.runId ||
		completion.run.unitId !== dispatch.unitId ||
		completion.run.status !== "passed"
	) {
		throw new Error(
			"governed candidate session returned a run that is not the exact passed dispatch run and unit.",
		);
	}
	if (
		!completion.decision ||
		completion.decision.kind !== "advance-run" ||
		completion.decision.outcome !== "approved"
	) {
		throw new Error(
			"governed candidate session requires an approved policy decision and passed candidate acceptance before review.",
		);
	}
	const decision = snapshotApprovedPolicyDecision(completion.decision);
	const acceptance = completion.candidateAcceptance;
	if (!acceptance || acceptance.outcome !== "passed") {
		throw new Error(
			"governed candidate session requires a passed candidate acceptance bound to the exact candidate and dispatch contract.",
		);
	}
	const acceptanceCandidateDigest = canonicalizeSourceDigest(
		acceptance.candidateDigest,
		"candidateAcceptance.candidateDigest",
	);
	const acceptanceCandidateCommitSha = requireFullLowercaseCommitSha(
		acceptance.candidateCommitSha,
		"candidateAcceptance.candidateCommitSha",
	);
	const acceptanceContractDigest = canonicalizeSourceDigest(
		acceptance.acceptanceContractDigest,
		"candidateAcceptance.acceptanceContractDigest",
	);
	const dispatchAcceptanceContractDigest = canonicalizeSourceDigest(
		dispatch.acceptanceContractDigest,
		"dispatch.acceptanceContractDigest",
	);
	const acceptanceRef = requireCanonicalUuidV7(
		acceptance.acceptanceRef,
		"candidateAcceptance.acceptanceRef",
	);
	if (
		acceptanceCandidateDigest !== candidateDigest ||
		acceptanceCandidateCommitSha !== candidateCommitSha ||
		acceptanceContractDigest !== dispatchAcceptanceContractDigest
	) {
		throw new Error(
			"governed candidate session requires a passed candidate acceptance bound to the exact candidate and dispatch contract.",
		);
	}
	const immutableCandidate = Object.freeze({
		schemaVersion: 1 as const,
		candidateId: expectedCandidateId,
		runId: dispatch.runId,
		attempt: dispatch.attempt,
		candidateKey: expectedCandidateKey,
		candidateRef: expectedCandidateRef,
		baseSha: dispatchBaseSha,
		candidateCommitSha,
		commitDigest,
		treeDigest,
		patchDigest,
		changedFilesDigest,
		candidateDigest,
	});
	const immutableAcceptance = Object.freeze({
		candidateDigest: acceptanceCandidateDigest,
		candidateCommitSha: acceptanceCandidateCommitSha,
		acceptanceContractDigest,
		acceptanceRef,
		outcome: "passed" as const,
	});
	return Object.freeze({
		run: Object.freeze({
			id: dispatch.runId,
			unitId: dispatch.unitId,
			status: "passed" as const,
		}),
		candidate: immutableCandidate,
		decision,
		candidateAcceptance: immutableAcceptance,
	});
}

interface CapturedCandidateCompletion {
	readonly failure: unknown;
	readonly mergedHeadSha: unknown;
	readonly run: CapturedRun | undefined;
	readonly candidate: CapturedCandidate | undefined;
	readonly decision: CapturedPolicyDecision | undefined;
	readonly candidateAcceptance: CapturedCandidateAcceptance | undefined;
}

interface CapturedRun {
	readonly id: unknown;
	readonly unitId: unknown;
	readonly status: unknown;
}

interface CapturedCandidate {
	readonly schemaVersion: unknown;
	readonly candidateId: unknown;
	readonly runId: unknown;
	readonly attempt: unknown;
	readonly candidateKey: unknown;
	readonly candidateRef: unknown;
	readonly baseSha: unknown;
	readonly candidateCommitSha: unknown;
	readonly commitDigest: unknown;
	readonly treeDigest: unknown;
	readonly patchDigest: unknown;
	readonly changedFilesDigest: unknown;
	readonly candidateDigest: unknown;
}

interface CapturedPolicyDecision {
	readonly kind: unknown;
	readonly outcome: unknown;
	readonly reasons: readonly unknown[] | undefined;
	readonly attemptNumber: unknown;
	readonly feedbackContext: readonly unknown[] | undefined;
}

interface CapturedCandidateAcceptance {
	readonly candidateDigest: unknown;
	readonly candidateCommitSha: unknown;
	readonly acceptanceContractDigest: unknown;
	readonly acceptanceRef: unknown;
	readonly outcome: unknown;
}

/**
 * Untrusted adapter results can be getter-backed or Proxy-backed. Capture the
 * entire completion boundary once before validating it so no later validation
 * or review snapshot can observe a substituted value.
 */
function captureCandidateCompletion(
	result: RunPacketResult,
): CapturedCandidateCompletion {
	const source = asUnknownRecord(result, "run result");
	const failure = source.failure;
	const mergedHeadSha = source.mergedHeadSha;
	const run = source.run;
	const candidate = source.candidate;
	const decision = source.decision;
	const candidateAcceptance = source.candidateAcceptance;
	return Object.freeze({
		failure,
		mergedHeadSha,
		run: captureRun(run),
		candidate: captureCandidate(candidate),
		decision: capturePolicyDecision(decision),
		candidateAcceptance: captureCandidateAcceptance(candidateAcceptance),
	});
}

function captureRun(value: unknown): CapturedRun | undefined {
	const source = asOptionalUnknownRecord(value);
	if (!source) {
		return undefined;
	}
	return Object.freeze({
		id: source.id,
		unitId: source.unitId,
		status: source.status,
	});
}

function captureCandidate(value: unknown): CapturedCandidate | undefined {
	const source = asOptionalUnknownRecord(value);
	if (!source) {
		return undefined;
	}
	return Object.freeze({
		schemaVersion: source.schemaVersion,
		candidateId: source.candidateId,
		runId: source.runId,
		attempt: source.attempt,
		candidateKey: source.candidateKey,
		candidateRef: source.candidateRef,
		baseSha: source.baseSha,
		candidateCommitSha: source.candidateCommitSha,
		commitDigest: source.commitDigest,
		treeDigest: source.treeDigest,
		patchDigest: source.patchDigest,
		changedFilesDigest: source.changedFilesDigest,
		candidateDigest: source.candidateDigest,
	});
}

function capturePolicyDecision(
	value: unknown,
): CapturedPolicyDecision | undefined {
	const source = asOptionalUnknownRecord(value);
	if (!source) {
		return undefined;
	}
	const reasons = source.reasons;
	const feedbackContext = source.feedbackContext;
	return Object.freeze({
		kind: source.kind,
		outcome: source.outcome,
		reasons: captureUnknownArray(reasons),
		attemptNumber: source.attemptNumber,
		feedbackContext: captureUnknownArray(feedbackContext),
	});
}

function captureCandidateAcceptance(
	value: unknown,
): CapturedCandidateAcceptance | undefined {
	const source = asOptionalUnknownRecord(value);
	if (!source) {
		return undefined;
	}
	return Object.freeze({
		candidateDigest: source.candidateDigest,
		candidateCommitSha: source.candidateCommitSha,
		acceptanceContractDigest: source.acceptanceContractDigest,
		acceptanceRef: source.acceptanceRef,
		outcome: source.outcome,
	});
}

function asUnknownRecord(
	value: unknown,
	field: string,
): Record<string, unknown> {
	const source = asOptionalUnknownRecord(value);
	if (!source) {
		throw new Error(
			`governed candidate session requires a ${field} object from the orchestrator.`,
		);
	}
	return source;
}

function asOptionalUnknownRecord(
	value: unknown,
): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function captureUnknownArray(value: unknown): readonly unknown[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	return Object.freeze([...value]);
}

/**
 * Raw adapter candidates carry lowercase hex while signed V1 evidence uses the
 * explicit sha256: form. Accept only those two canonical source forms, then
 * return the V1 representation used by the immutable review snapshot.
 */
function canonicalizeSourceDigest(value: unknown, field: string): string {
	if (typeof value !== "string") {
		throw new Error(
			`governed candidate session requires ${field} to be a canonical lowercase SHA-256 digest.`,
		);
	}
	try {
		return canonicalSha256Digest(value);
	} catch {
		throw new Error(
			`governed candidate session requires ${field} to be a canonical lowercase SHA-256 digest.`,
		);
	}
}

function requireFullLowercaseCommitSha(value: unknown, field: string): string {
	if (typeof value !== "string" || !FULL_LOWERCASE_COMMIT_SHA.test(value)) {
		throw new Error(
			`governed candidate session requires ${field} to be a full lowercase Git commit SHA.`,
		);
	}
	return value;
}

function requireCanonicalCandidateRef(value: unknown): string {
	if (!isCanonicalBuildplaneCandidateRef(value)) {
		throw new Error(
			"governed candidate session requires a canonical Buildplane candidate ref.",
		);
	}
	return value;
}

function requireCanonicalUuidV7(value: unknown, field: string): string {
	if (typeof value !== "string" || !CANONICAL_UUID_V7.test(value)) {
		throw new Error(
			`governed candidate session requires ${field} to be a canonical UUIDv7 ledger event id.`,
		);
	}
	return value;
}

function snapshotApprovedPolicyDecision(
	decision: CapturedPolicyDecision,
): ApprovedPolicyDecision {
	if (!decision.reasons) {
		throw new Error(
			"governed candidate session requires approved policy decision reasons to be strings.",
		);
	}
	const reasons: string[] = [];
	for (const reason of decision.reasons) {
		if (typeof reason !== "string") {
			throw new Error(
				"governed candidate session requires approved policy decision reasons to be strings.",
			);
		}
		reasons.push(reason);
	}
	return Object.freeze({
		kind: "advance-run",
		outcome: "approved",
		reasons: Object.freeze(reasons),
	});
}
