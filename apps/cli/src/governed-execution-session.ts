import {
	createGovernedGitWorktreeAdapter,
	type GovernedGitWorktreeAdapter,
} from "@buildplane/adapters-git";
import {
	createGovernedCommandWorkerExecutionPort,
	podmanGovernedSandboxProfileDigest,
} from "@buildplane/adapters-tools";
import {
	type CandidateEvidencePort,
	canonicalGovernedUnitPacketV1Digest,
	type EventBus,
	type GovernedActionEvidencePort,
	type GovernedActivityClaimPort,
	type GovernedDispatchLineageV3,
	type GovernedLedgerAuthorityRealmPort,
	type GovernedRepositoryBindingPort,
	type GovernedWorkerExecutionPort,
	parseGovernedUnitPacket,
	type Run,
	type UnitPacket,
	type WorkspaceCandidateArtifact,
} from "@buildplane/kernel";
import {
	candidateIdForDispatch,
	executeGovernedCandidateSession,
	type GovernedCandidateSessionOrchestrator,
} from "./governed-candidate-session.js";
import { createGovernedCommandEvidenceStore } from "./governed-command-evidence-store.js";
import {
	readHostOwnedGovernedExecutionAuthority,
	resolveHostOwnedGovernedExecutionAuthority,
} from "./governed-execution-authority.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const PINNED_IMAGE = /^[^\s@]+@sha256:[a-f0-9]{64}$/;

export type GovernedExecutionUnavailableCode =
	| "INVALID_INPUT"
	| "AUTHORITY_UNAVAILABLE"
	| "DISPATCH_UNAVAILABLE"
	| "DISPATCH_EXPIRED"
	| "RESOLUTION_UNAVAILABLE"
	| "RECOVERY_REQUIRED"
	| "UNSUPPORTED_WORKER"
	| "ACTION_EVIDENCE_UNAVAILABLE"
	| "ACTIVITY_AUTHORITY_UNAVAILABLE"
	| "CANDIDATE_EVIDENCE_UNAVAILABLE"
	| "REPOSITORY_BINDING_UNAVAILABLE"
	| "REPOSITORY_BINDING_REJECTED"
	| "LEDGER_AUTHORITY_UNAVAILABLE"
	| "LEDGER_AUTHORITY_REJECTED"
	| "SANDBOX_UNAVAILABLE"
	| "SANDBOX_PROFILE_MISMATCH"
	| "ORCHESTRATOR_UNAVAILABLE"
	| "CANDIDATE_EXECUTION_FAILED";

export type GovernedExecutionSessionResult =
	| {
			readonly state: "candidate-awaiting-review";
			readonly candidate: WorkspaceCandidateArtifact;
			readonly run: Run;
	  }
	| GovernedExecutionUnavailableResult;

type GovernedExecutionUnavailableResult = {
	readonly state: "unavailable";
	readonly code: GovernedExecutionUnavailableCode;
	readonly reason: string;
};

export interface GovernedExecutionSessionOrchestratorInput {
	readonly projectRoot: string;
	readonly workspace: GovernedGitWorktreeAdapter;
	readonly governedWorkerExecutionPort: GovernedWorkerExecutionPort;
	readonly governedActionEvidencePort: GovernedActionEvidencePort;
	readonly governedActivityClaimPort: GovernedActivityClaimPort;
	readonly candidateEvidencePort: CandidateEvidencePort;
	readonly governedRepositoryBindingPort: GovernedRepositoryBindingPort;
	readonly governedLedgerAuthorityRealmPort: GovernedLedgerAuthorityRealmPort;
	readonly governedDispatch: GovernedDispatchLineageV3;
}

export interface RunGovernedExecutionSessionInput {
	readonly eventBus?: EventBus;
}

type CapturedHostOwnedGovernedExecutionAuthority = NonNullable<
	ReturnType<typeof readHostOwnedGovernedExecutionAuthority>
>;
type PreparedGovernedExecutionSession =
	CapturedHostOwnedGovernedExecutionAuthority;

/**
 * Composes a single candidate-producing governed execution attempt. This is a
 * host integration seam for an external authority broker, not a CLI fallback:
 * unavailable authority is returned as a tagged block, and no raw executor or
 * promotion API is reachable from this module.
 */
export async function runGovernedExecutionSession(
	input: RunGovernedExecutionSessionInput,
): Promise<GovernedExecutionSessionResult> {
	let authority: unknown;
	try {
		authority = await resolveHostOwnedGovernedExecutionAuthority();
	} catch {
		return unavailable(
			"AUTHORITY_UNAVAILABLE",
			"governed execution requires a host-owned verified execution authority.",
		);
	}
	const capturedAuthority = readHostOwnedGovernedExecutionAuthority(authority);
	if (!capturedAuthority) {
		return unavailable(
			"AUTHORITY_UNAVAILABLE",
			"governed execution requires a host-owned verified execution authority.",
		);
	}

	let preflight:
		| PreparedGovernedExecutionSession
		| GovernedExecutionUnavailableResult;
	try {
		preflight = prepareSession(capturedAuthority);
	} catch {
		return unavailable(
			"AUTHORITY_UNAVAILABLE",
			"host-owned governed execution authority is malformed.",
		);
	}
	if (isUnavailable(preflight)) return preflight;
	let eventBus: EventBus | undefined;
	try {
		eventBus = readEventBus(input);
	} catch {
		return unavailable(
			"INVALID_INPUT",
			"governed execution eventBus input is malformed.",
		);
	}

	let worker: GovernedWorkerExecutionPort;
	try {
		const evidenceStore = createGovernedCommandEvidenceStore({
			projectRoot: preflight.projectRoot,
		});
		worker = createGovernedCommandWorkerExecutionPort({
			actionExecutor: preflight.oci.executor,
			evidenceStore,
			activityClaimPort: preflight.activityClaimPort,
		});
	} catch {
		return unavailable(
			"SANDBOX_UNAVAILABLE",
			"governed OCI ActionGateway could not be initialized.",
		);
	}

	let orchestrator: GovernedCandidateSessionOrchestrator;
	try {
		orchestrator = preflight.createOrchestrator(
			Object.freeze({
				projectRoot: preflight.projectRoot,
				workspace: createGovernedGitWorktreeAdapter(),
				governedWorkerExecutionPort: worker,
				governedActionEvidencePort: preflight.actionEvidencePort,
				governedActivityClaimPort: preflight.activityClaimPort,
				candidateEvidencePort: preflight.candidateEvidencePort,
				governedRepositoryBindingPort: preflight.repositoryBindingPort,
				governedLedgerAuthorityRealmPort: preflight.ledgerAuthorityRealmPort,
				governedDispatch: preflight.dispatch,
			}),
		);
		if (!orchestrator || typeof orchestrator.runPacketAsync !== "function") {
			return unavailable(
				"ORCHESTRATOR_UNAVAILABLE",
				"governed orchestration factory did not return a candidate-only orchestrator.",
			);
		}
	} catch {
		return unavailable(
			"ORCHESTRATOR_UNAVAILABLE",
			"governed orchestration could not be composed.",
		);
	}

	try {
		const result = await executeGovernedCandidateSession({
			packet: preflight.packet,
			dispatch: preflight.dispatch,
			resolution: preflight.resolution,
			projectRoot: preflight.projectRoot,
			repositoryBindingPort: preflight.repositoryBindingPort,
			ledgerAuthorityRealmPort: preflight.ledgerAuthorityRealmPort,
			orchestrator,
			...(eventBus === undefined ? {} : { eventBus }),
		});
		if (
			!result.candidate ||
			result.run.id !== preflight.dispatch.runId ||
			result.run.unitId !== preflight.dispatch.unitId ||
			result.candidate.candidateId !==
				candidateIdForDispatch(preflight.dispatch)
		) {
			return unavailable(
				"CANDIDATE_EXECUTION_FAILED",
				"governed candidate session returned an identity that does not match the sealed dispatch.",
			);
		}
		return Object.freeze({
			state: "candidate-awaiting-review" as const,
			candidate: result.candidate,
			run: result.run,
		});
	} catch {
		return unavailable(
			"CANDIDATE_EXECUTION_FAILED",
			"governed candidate session was blocked.",
		);
	}
}

function prepareSession(
	input: CapturedHostOwnedGovernedExecutionAuthority,
): PreparedGovernedExecutionSession | GovernedExecutionUnavailableResult {
	const dispatch = input.dispatch;
	const dispatchStatus = validateDispatch(dispatch);
	if (dispatchStatus) return dispatchStatus;
	const packetStatus = validateCommandPacket(input.packet, dispatch);
	if (packetStatus) return packetStatus;
	const resolutionStatus = validateResolution(input.resolution, dispatch);
	if (resolutionStatus) return resolutionStatus;
	const portsStatus = validatePorts(input);
	if (portsStatus) return portsStatus;
	const authorityStatus = verifyDispatchAuthority(input, dispatch);
	if (authorityStatus) return authorityStatus;
	const ociStatus = validateOciPrerequisites(input.oci, dispatch);
	if (ociStatus) return ociStatus;
	return input;
}

function validateDispatch(
	dispatch: unknown,
): GovernedExecutionUnavailableResult | undefined {
	if (!isRecord(dispatch)) {
		return unavailable(
			"DISPATCH_UNAVAILABLE",
			"governed execution requires a sealed V3 dispatch.",
		);
	}
	if (
		dispatch.schemaVersion !== 3 ||
		dispatch.trustTier !== "governed" ||
		dispatch.commitMode !== "atomic" ||
		dispatch.actionEvidenceVersion !== "sealed_v3" ||
		dispatch.executionRole !== "implementer"
	) {
		return unavailable(
			"DISPATCH_UNAVAILABLE",
			"governed execution requires an implementer atomic sealed V3 dispatch.",
		);
	}
	const issuedAt =
		typeof dispatch.issuedAt === "string"
			? Date.parse(dispatch.issuedAt)
			: Number.NaN;
	const expiresAt =
		typeof dispatch.expiresAt === "string"
			? Date.parse(dispatch.expiresAt)
			: Number.NaN;
	if (
		!Number.isFinite(issuedAt) ||
		!Number.isFinite(expiresAt) ||
		issuedAt >= expiresAt ||
		expiresAt <= Date.now()
	) {
		return unavailable(
			"DISPATCH_EXPIRED",
			"the sealed governed dispatch authority window is expired or invalid.",
		);
	}
	return undefined;
}

function validateCommandPacket(
	packet: UnitPacket,
	dispatch: GovernedDispatchLineageV3,
): GovernedExecutionUnavailableResult | undefined {
	if (!isRecord(packet)) {
		return unavailable(
			"INVALID_INPUT",
			"governed execution requires a packet object.",
		);
	}
	if (packet.model !== undefined || packet.execution === undefined) {
		return unavailable(
			"UNSUPPORTED_WORKER",
			"governed execution currently supports only typed command packets; model and hybrid workers remain blocked.",
		);
	}
	let strictPacket: UnitPacket;
	try {
		strictPacket = parseGovernedUnitPacket(JSON.stringify(packet));
	} catch {
		return unavailable(
			"DISPATCH_UNAVAILABLE",
			"packet is not strictly governed.",
		);
	}
	if (
		strictPacket.unit.id !== dispatch.unitId ||
		strictPacket.execution_role !== dispatch.executionRole ||
		canonicalGovernedUnitPacketV1Digest(strictPacket) !==
			dispatch.governedPacketDigest
	) {
		return unavailable(
			"DISPATCH_UNAVAILABLE",
			"packet does not exactly match the sealed dispatch authority.",
		);
	}
	return undefined;
}

function validateResolution(
	resolution: unknown,
	dispatch: GovernedDispatchLineageV3,
): GovernedExecutionUnavailableResult | undefined {
	if (!isRecord(resolution) || !isRecord(resolution.dispatch)) {
		return unavailable(
			"RESOLUTION_UNAVAILABLE",
			"governed execution requires a fresh verified dispatch resolution.",
		);
	}
	if (
		!sameDispatch(
			dispatch,
			resolution.dispatch as unknown as GovernedDispatchLineageV3,
		)
	) {
		return unavailable(
			"RESOLUTION_UNAVAILABLE",
			"the broker resolution does not exactly match the sealed dispatch.",
		);
	}
	if (
		resolution.phase !== "dispatched" ||
		!isRecord(resolution.lifecycle) ||
		!isEmptyArray(resolution.lifecycle.timers) ||
		resolution.lifecycle.cancellation !== undefined ||
		!isEmptyArray(resolution.pendingActionIds) ||
		!isEmptyArray(resolution.unknownActionIds) ||
		!isEmptyArray(resolution.failedActionIds) ||
		!isRecord(resolution.recovery) ||
		!isEmptyArray(resolution.recovery.requests) ||
		!isEmptyArray(resolution.recovery.receipts) ||
		!isEmptyArray(resolution.recovery.candidates) ||
		resolution.recovery.receiptSet !== undefined
	) {
		return unavailable(
			"RECOVERY_REQUIRED",
			"the governed workflow has existing action, lifecycle, candidate, or recovery state and must reconcile before a new effect.",
		);
	}
	return undefined;
}

function validatePorts(
	authority: CapturedHostOwnedGovernedExecutionAuthority,
): GovernedExecutionUnavailableResult | undefined {
	if (
		!hasMethods(authority.actionEvidencePort, [
			"recordActionRequested",
			"recordActionReceipt",
			"sealActionReceiptSet",
			"recordCandidateCreatedV2",
		])
	) {
		return unavailable(
			"ACTION_EVIDENCE_UNAVAILABLE",
			"governed execution requires the signed action-evidence port before an OCI worker can start.",
		);
	}
	if (!hasMethods(authority.activityClaimPort, ["claim", "recordResult"])) {
		return unavailable(
			"ACTIVITY_AUTHORITY_UNAVAILABLE",
			"governed execution requires a native activity-claim authority before an OCI worker can start.",
		);
	}
	if (
		!hasMethods(authority.candidateEvidencePort, [
			"recordCandidateAcceptance",
			"recordCandidateReview",
		])
	) {
		return unavailable(
			"CANDIDATE_EVIDENCE_UNAVAILABLE",
			"governed execution requires candidate evidence before a candidate can be created.",
		);
	}
	if (
		!hasMethods(authority.repositoryBindingPort, [
			"assertDispatchRepositoryBinding",
		])
	) {
		return unavailable(
			"REPOSITORY_BINDING_UNAVAILABLE",
			"governed execution requires repository-binding verification before worktree preparation.",
		);
	}
	if (
		!hasMethods(authority.ledgerAuthorityRealmPort, [
			"assertDispatchLedgerAuthorityRealm",
		])
	) {
		return unavailable(
			"LEDGER_AUTHORITY_UNAVAILABLE",
			"governed execution requires ledger-authority verification before worktree preparation.",
		);
	}
	return undefined;
}

function validateOciPrerequisites(
	oci: CapturedHostOwnedGovernedExecutionAuthority["oci"],
	dispatch: GovernedDispatchLineageV3,
): GovernedExecutionUnavailableResult | undefined {
	if (!isRecord(oci) || !isRecord(oci.profile) || !isRecord(oci.executor)) {
		return unavailable(
			"SANDBOX_UNAVAILABLE",
			"governed execution requires a broker-supplied rootless OCI executor and profile.",
		);
	}
	if (typeof oci.image !== "string" || !PINNED_IMAGE.test(oci.image)) {
		return unavailable(
			"SANDBOX_UNAVAILABLE",
			"governed execution requires a digest-pinned OCI worker image.",
		);
	}
	const profile = oci.profile;
	if (profile.profileDigest !== dispatch.sandboxProfileDigest) {
		return unavailable(
			"SANDBOX_PROFILE_MISMATCH",
			"the supplied OCI profile digest does not match the sealed dispatch sandbox profile.",
		);
	}
	if (
		profile.schemaVersion !== 1 ||
		profile.profileId !== "podman-rootless-v1" ||
		typeof profile.cpuCores !== "number" ||
		typeof profile.memoryBytes !== "number" ||
		typeof profile.pidsLimit !== "number" ||
		typeof profile.tmpfsBytes !== "number" ||
		typeof profile.profileDigest !== "string" ||
		!DIGEST.test(profile.profileDigest)
	) {
		return unavailable(
			"SANDBOX_UNAVAILABLE",
			"the supplied OCI sandbox profile is malformed.",
		);
	}
	const expectedProfileDigest = podmanGovernedSandboxProfileDigest({
		image: oci.image,
		schemaVersion: profile.schemaVersion,
		profileId: profile.profileId,
		cpuCores: profile.cpuCores,
		memoryBytes: profile.memoryBytes,
		pidsLimit: profile.pidsLimit,
		tmpfsBytes: profile.tmpfsBytes,
	});
	if (expectedProfileDigest !== profile.profileDigest) {
		return unavailable(
			"SANDBOX_PROFILE_MISMATCH",
			"the supplied OCI profile does not canonically bind its image and resource limits.",
		);
	}
	const sandbox = oci.sandbox;
	if (
		!isRecord(sandbox) ||
		sandbox.schemaVersion !== 1 ||
		sandbox.runtime !== "rootless-oci" ||
		sandbox.rootless !== true ||
		sandbox.readOnlyBase !== true ||
		sandbox.writableOverlay !== true ||
		sandbox.network !== "none" ||
		sandbox.hostFallback !== false ||
		sandbox.profileDigest !== dispatch.sandboxProfileDigest
	) {
		return unavailable(
			"SANDBOX_PROFILE_MISMATCH",
			"the OCI executor attestation does not match the sealed rootless sandbox profile.",
		);
	}
	return undefined;
}

/**
 * Verify both host-owned authority bindings before constructing any evidence
 * store, ActionGateway worker, governed Git adapter, or orchestrator. The
 * candidate-session helper repeats these checks immediately before its run as
 * a defense against a caller-side mutation between composition and execution.
 */
function verifyDispatchAuthority(
	authority: CapturedHostOwnedGovernedExecutionAuthority,
	dispatch: GovernedDispatchLineageV3,
): GovernedExecutionUnavailableResult | undefined {
	try {
		authority.repositoryBindingPort.assertDispatchRepositoryBinding({
			projectRoot: authority.projectRoot,
			dispatch,
		});
	} catch {
		return unavailable(
			"REPOSITORY_BINDING_REJECTED",
			"repository binding rejected the sealed dispatch.",
		);
	}
	try {
		authority.ledgerAuthorityRealmPort.assertDispatchLedgerAuthorityRealm({
			dispatch,
		});
	} catch {
		return unavailable(
			"LEDGER_AUTHORITY_REJECTED",
			"ledger authority realm rejected the sealed dispatch.",
		);
	}
	return undefined;
}

function sameDispatch(
	left: GovernedDispatchLineageV3,
	right: GovernedDispatchLineageV3,
): boolean {
	return (
		left.schemaVersion === right.schemaVersion &&
		left.runId === right.runId &&
		left.workflowId === right.workflowId &&
		left.workflowRevision === right.workflowRevision &&
		left.unitId === right.unitId &&
		left.attempt === right.attempt &&
		left.provenanceRef === right.provenanceRef &&
		left.dispatchEnvelopeRef === right.dispatchEnvelopeRef &&
		left.envelopeDigest === right.envelopeDigest &&
		left.baseCommitSha === right.baseCommitSha &&
		left.executionRole === right.executionRole &&
		left.commitMode === right.commitMode &&
		left.trustTier === right.trustTier &&
		left.capabilityBundleDigest === right.capabilityBundleDigest &&
		left.acceptanceContractDigest === right.acceptanceContractDigest &&
		left.policyDigest === right.policyDigest &&
		left.contextManifestDigest === right.contextManifestDigest &&
		left.workerManifestDigest === right.workerManifestDigest &&
		left.sandboxProfileDigest === right.sandboxProfileDigest &&
		left.repositoryBindingDigest === right.repositoryBindingDigest &&
		left.ledgerAuthorityRealmDigest === right.ledgerAuthorityRealmDigest &&
		left.governedPacketDigest === right.governedPacketDigest &&
		left.idempotencyKey === right.idempotencyKey &&
		left.authorityActor === right.authorityActor &&
		left.actionEvidenceVersion === right.actionEvidenceVersion &&
		left.issuedAt === right.issuedAt &&
		left.expiresAt === right.expiresAt &&
		left.budget.maxTokens === right.budget.maxTokens &&
		left.budget.maxComputeTimeMs === right.budget.maxComputeTimeMs
	);
}

function hasMethods(value: unknown, names: readonly string[]): boolean {
	return (
		isRecord(value) && names.every((name) => typeof value[name] === "function")
	);
}

function isEmptyArray(value: unknown): boolean {
	return Array.isArray(value) && value.length === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEventBus(input: unknown): EventBus | undefined {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new TypeError("governed execution input must be an object.");
	}
	const descriptor = Object.getOwnPropertyDescriptor(input, "eventBus");
	if (descriptor === undefined) return undefined;
	if (!("value" in descriptor)) {
		throw new TypeError("governed execution eventBus must not be an accessor.");
	}
	return descriptor.value as EventBus | undefined;
}

function unavailable(
	code: GovernedExecutionUnavailableCode,
	reason: string,
): GovernedExecutionUnavailableResult {
	return Object.freeze({ state: "unavailable" as const, code, reason });
}

function isUnavailable(
	value: PreparedGovernedExecutionSession | GovernedExecutionUnavailableResult,
): value is GovernedExecutionUnavailableResult {
	return "state" in value && value.state === "unavailable";
}
