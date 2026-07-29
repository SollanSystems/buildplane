import type { GovernedGitWorktreeAdapter } from "@buildplane/adapters-git";
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
	GovernedWorkerExecutionPort,
	UnitPacket,
} from "@buildplane/kernel";
import type { GovernedCandidateSessionOrchestrator } from "./governed-candidate-session.js";
import type { ResolvedGovernedDispatchSnapshot } from "./ledger-governed-dispatch-resolver.js";

declare const hostOwnedGovernedExecutionAuthorityBrand: unique symbol;

/**
 * An opaque host-owned handle. Its visible fields are descriptive only: the
 * private WeakMap below is the provenance boundary that determines whether a
 * handle is associated with captured execution authority.
 */
export interface HostOwnedGovernedExecutionAuthorityV1 {
	readonly kind: "host-owned-governed-execution-authority-v1";
	readonly [hostOwnedGovernedExecutionAuthorityBrand]: true;
}

/**
 * The narrow, candidate-only kernel composition shape. It is not accepted by
 * the public session entrypoint; it is supplied only from captured authority.
 */
interface GovernedExecutionSessionOrchestratorInput {
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

interface CapturedGovernedOciExecutionPrerequisites {
	readonly image: string;
	readonly profile: PodmanGovernedSandboxProfileV1;
	readonly executor: GovernedActionExecutor;
	/** Immutable sandbox attestation snapshot captured with the executor. */
	readonly sandbox: Readonly<Record<string, unknown>>;
}

/**
 * This state is intentionally module-private. A privileged native host bridge
 * may populate `authorityStates` in a future integration; no JavaScript
 * registration, minting, or fixture construction API is exported here.
 */
interface CapturedHostOwnedGovernedExecutionAuthority {
	readonly packet: UnitPacket;
	readonly projectRoot: string;
	readonly dispatch: GovernedDispatchLineageV3;
	readonly resolution: ResolvedGovernedDispatchSnapshot;
	readonly actionEvidencePort: GovernedActionEvidencePort;
	readonly activityClaimPort: GovernedActivityClaimPort;
	readonly candidateEvidencePort: CandidateEvidencePort;
	readonly repositoryBindingPort: GovernedRepositoryBindingPort;
	readonly ledgerAuthorityRealmPort: GovernedLedgerAuthorityRealmPort;
	readonly oci: CapturedGovernedOciExecutionPrerequisites;
	readonly createOrchestrator: (
		input: GovernedExecutionSessionOrchestratorInput,
	) => GovernedCandidateSessionOrchestrator;
}

const authorityStates = new WeakMap<
	object,
	CapturedHostOwnedGovernedExecutionAuthority
>();

/**
 * There is deliberately no JavaScript production resolver or registration
 * path yet. Failing closed is safer than converting caller-selected structural
 * ports, callbacks, or serialized data into governed execution authority.
 */
export async function resolveHostOwnedGovernedExecutionAuthority(): Promise<
	HostOwnedGovernedExecutionAuthorityV1 | undefined
> {
	return undefined;
}

/**
 * Lookup deliberately performs no structural inspection. A forged object,
 * proxy, or JSON round-trip cannot recreate the private WeakMap association.
 */
export function readHostOwnedGovernedExecutionAuthority(
	authority: unknown,
): CapturedHostOwnedGovernedExecutionAuthority | undefined {
	if (typeof authority !== "object" || authority === null) return undefined;
	return authorityStates.get(authority);
}
