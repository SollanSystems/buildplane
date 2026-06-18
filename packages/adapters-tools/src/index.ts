import type { CapabilityBundleV0 } from "@buildplane/capability-broker";
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
