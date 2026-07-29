import type { CapabilityBundleV0 } from "@buildplane/capability-broker";

export {
	type ActionGateway,
	type ActionGatewayReceipt,
	type ActionGatewayRole,
	type ActionGatewayTrustTier,
	type CreateActionGatewayOptions,
	createActionGateway,
	type GatewayAction,
	type GatewayTools,
	type GovernedActionExecutionContext,
	type GovernedActionExecutor,
	type GovernedSandboxAttestationV1,
} from "./action-gateway.js";
export {
	type CreateGovernedCommandWorkerExecutionPortOptions,
	createGovernedCommandWorkerExecutionPort,
	type GovernedActivityClaimDispositionV1,
	type GovernedActivityClaimPort,
	type GovernedActivityResultDispositionV1,
	type GovernedActivityResultOutcomeV1,
	type GovernedCommandEvidenceStore,
	type GrantedGovernedActivityClaimV1,
} from "./governed-worker.js";
export {
	PODMAN_GOVERNED_PROFILE_ID,
	type PodmanCommandResult,
	type PodmanGovernedSandboxProfileV1,
	podmanGovernedSandboxProfileDigest,
} from "./podman-governed-executor.js";
export {
	type ActionDefinition,
	approveRemoteActionProposal,
	canonicalRemoteContentDigest,
	createRemoteActionProposal,
	type LocalRemoteActionVerifier,
	type QuarantinedRemoteActionDraft,
	type QuarantinedRemoteArtifact,
	type QuarantinedRemoteInterchange,
	type QuarantinedRemoteMetadata,
	quarantineRemoteInterchange,
	type RemoteActionProposal,
	type RemoteInterchangeProtocol,
} from "./remote-interchange.js";

import { type RunCommandResult, runCommand } from "./run-command.js";
import {
	type WriteFileOptions,
	type WriteFileResult,
	writeFile,
} from "./write-file.js";

export {
	type RunCommandInput,
	type RunCommandOptions,
	type RunCommandResult,
	runCommand,
} from "./run-command.js";
export { resolveSandboxedPath } from "./sandbox.js";
export {
	type WriteFileInput,
	type WriteFileOptions,
	type WriteFileResult,
	writeFile,
} from "./write-file.js";

export interface ToolRegistryOptions {
	readonly capabilityBundle?: CapabilityBundleV0;
	readonly onCapabilityDenied?: WriteFileOptions["onCapabilityDenied"];
}

export interface ToolRegistry {
	write_file(input: { path: string; content: string }): WriteFileResult;
	run_command(input: {
		command: string;
		args?: readonly string[];
		cwd?: string;
	}): RunCommandResult;
}

/**
 * Create a tool registry scoped to a worktree root.
 *
 * When `capabilityBundle` is provided, write_file enforces fsWrite allowlists (M3-S4).
 */
export function createToolRegistry(
	worktreeRoot: string,
	options?: ToolRegistryOptions,
): ToolRegistry {
	const toolOpts =
		options?.capabilityBundle || options?.onCapabilityDenied
			? {
					capabilityBundle: options.capabilityBundle,
					onCapabilityDenied: options.onCapabilityDenied,
				}
			: undefined;
	return {
		write_file(input) {
			return writeFile(input, worktreeRoot, toolOpts);
		},
		run_command(input) {
			return runCommand(input, worktreeRoot, toolOpts);
		},
	};
}
