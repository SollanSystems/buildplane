import { realpathSync } from "node:fs";
import type {
	GovernedActionExecutor,
	PodmanGovernedSandboxProfileV1,
} from "@buildplane/adapters-tools";
import type {
	CandidateEvidencePort,
	GovernedActionEvidencePort,
	GovernedActivityClaimPort,
	GovernedDispatchLineageV3,
	GovernedLedgerAuthorityRealmPort,
	GovernedRepositoryBindingPort,
	UnitPacket,
} from "@buildplane/kernel";
import type { GovernedCandidateSessionOrchestrator } from "../../src/governed-candidate-session.js";
import type { GovernedExecutionSessionOrchestratorInput } from "../../src/governed-execution-session.js";
import type { ResolvedGovernedDispatchSnapshot } from "../../src/ledger-governed-dispatch-resolver.js";

export interface GovernedExecutionAuthorityFixtureInput {
	readonly packet: UnitPacket;
	readonly projectRoot: string;
	readonly dispatch: GovernedDispatchLineageV3;
	readonly resolution: ResolvedGovernedDispatchSnapshot;
	readonly actionEvidencePort: GovernedActionEvidencePort;
	readonly activityClaimPort: GovernedActivityClaimPort;
	readonly candidateEvidencePort: CandidateEvidencePort;
	readonly repositoryBindingPort: GovernedRepositoryBindingPort;
	readonly ledgerAuthorityRealmPort: GovernedLedgerAuthorityRealmPort;
	readonly oci:
		| {
				readonly image: string;
				readonly profile: PodmanGovernedSandboxProfileV1;
				readonly executor: GovernedActionExecutor;
		  }
		| undefined;
	readonly createOrchestrator: (
		input: GovernedExecutionSessionOrchestratorInput,
	) => GovernedCandidateSessionOrchestrator;
}

/**
 * Test-only stand-in for the captured state a future privileged host bridge
 * will provide to the production module. It deliberately snapshots data and
 * binds port/factory methods before the session starts, so adversarial tests
 * can prove that mutation after acquisition has no effect.
 */
export function captureGovernedExecutionAuthorityFixture(
	input: GovernedExecutionAuthorityFixtureInput,
): object {
	const packet = cloneAndFreeze(input.packet);
	const projectRoot = realpathSync.native(input.projectRoot);
	const dispatch = cloneAndFreeze(input.dispatch);
	const resolution = cloneAndFreeze(input.resolution);
	const actionEvidencePort = captureActionEvidencePort(
		input.actionEvidencePort,
	);
	const activityClaimPort = captureActivityClaimPort(input.activityClaimPort);
	const candidateEvidencePort = captureCandidateEvidencePort(
		input.candidateEvidencePort,
	);
	const repositoryBindingPort = captureRepositoryBindingPort(
		input.repositoryBindingPort,
	);
	const ledgerAuthorityRealmPort = captureLedgerAuthorityRealmPort(
		input.ledgerAuthorityRealmPort,
	);
	const oci = captureOci(input.oci);
	const createOrchestrator = input.createOrchestrator.bind(undefined);
	return Object.freeze({
		packet,
		projectRoot,
		dispatch,
		resolution,
		actionEvidencePort,
		activityClaimPort,
		candidateEvidencePort,
		repositoryBindingPort,
		ledgerAuthorityRealmPort,
		oci,
		createOrchestrator,
	});
}

function captureOci(
	value: GovernedExecutionAuthorityFixtureInput["oci"],
): object | undefined {
	if (!value) return undefined;
	const sandbox = cloneAndFreeze(value.executor.sandbox) as Readonly<
		Record<string, unknown>
	>;
	return Object.freeze({
		image: value.image,
		profile: cloneAndFreeze(value.profile),
		executor: value.executor,
		sandbox,
	});
}

function captureActionEvidencePort(
	port: GovernedActionEvidencePort,
): GovernedActionEvidencePort {
	const completion = port.recordCandidateCompletion?.bind(port);
	return Object.freeze({
		recordActionRequested: port.recordActionRequested.bind(port),
		recordActionReceipt: port.recordActionReceipt.bind(port),
		sealActionReceiptSet: port.sealActionReceiptSet.bind(port),
		recordCandidateCreatedV2: port.recordCandidateCreatedV2.bind(port),
		...(completion === undefined
			? {}
			: { recordCandidateCompletion: completion }),
	});
}

function captureActivityClaimPort(
	port: GovernedActivityClaimPort,
): GovernedActivityClaimPort {
	return Object.freeze({
		claim: port.claim.bind(port),
		recordResult: port.recordResult.bind(port),
	});
}

function captureCandidateEvidencePort(
	port: CandidateEvidencePort,
): CandidateEvidencePort {
	return Object.freeze({
		recordCandidateAcceptance: port.recordCandidateAcceptance.bind(port),
		recordCandidateReview: port.recordCandidateReview.bind(port),
	});
}

function captureRepositoryBindingPort(
	port: GovernedRepositoryBindingPort,
): GovernedRepositoryBindingPort {
	return Object.freeze({
		assertDispatchRepositoryBinding:
			port.assertDispatchRepositoryBinding.bind(port),
	});
}

function captureLedgerAuthorityRealmPort(
	port: GovernedLedgerAuthorityRealmPort,
): GovernedLedgerAuthorityRealmPort {
	return Object.freeze({
		assertDispatchLedgerAuthorityRealm:
			port.assertDispatchLedgerAuthorityRealm.bind(port),
	});
}

function cloneAndFreeze<T>(value: T): T {
	return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
	if (typeof value !== "object" || value === null || seen.has(value)) {
		return value;
	}
	seen.add(value);
	for (const property of Reflect.ownKeys(value)) {
		deepFreeze(Reflect.get(value, property), seen);
	}
	return Object.freeze(value);
}
