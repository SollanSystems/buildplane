import { createHash } from "node:crypto";
import {
	canonicalGovernedUnitPacketV1Digest,
	type EventBus,
	type GovernedDispatchLineageV3,
	type GovernedLedgerAuthorityRealmPort,
	type GovernedRepositoryBindingPort,
	parseGovernedUnitPacket,
	type RunPacketOptions,
	type RunPacketResult,
	type UnitPacket,
} from "@buildplane/kernel";
import type { ResolvedGovernedDispatchSnapshot } from "./ledger-governed-dispatch-resolver.js";

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

/**
 * Starts one clean, candidate-only attempt. This helper intentionally owns no
 * promotion API and rejects all partially executed/recovery state: a future
 * reducer-driven resume path must reconcile those states rather than issuing a
 * second worker effect from process memory.
 */
export async function executeGovernedCandidateSession(
	input: ExecuteGovernedCandidateSessionInput,
): Promise<RunPacketResult> {
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
	if (
		!result.candidate ||
		result.failure ||
		result.mergedHeadSha !== undefined
	) {
		throw new Error(
			"governed candidate session did not produce an immutable candidate without target-branch mutation.",
		);
	}
	if (
		result.candidate.baseSha !== prepared.dispatch.baseCommitSha ||
		result.candidate.runId !== prepared.dispatch.runId ||
		result.candidate.attempt !== prepared.dispatch.attempt
	) {
		throw new Error(
			"governed candidate session returned a candidate whose base/run/attempt does not match the verified dispatch.",
		);
	}
	return result;
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
	const now = Date.now();
	if (
		!Number.isFinite(Date.parse(dispatch.issuedAt)) ||
		!Number.isFinite(Date.parse(dispatch.expiresAt)) ||
		Date.parse(dispatch.issuedAt) >= Date.parse(dispatch.expiresAt) ||
		Date.parse(dispatch.expiresAt) <= now
	) {
		throw new TypeError(
			"governed candidate session requires an active verified dispatch authority window.",
		);
	}
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
