import { type RunCommandResult, runCommand } from "./run-command.js";
import { type WriteFileResult, writeFile } from "./write-file.js";

export {
	type RunCommandInput,
	type RunCommandResult,
	runCommand,
} from "./run-command.js";
export { resolveSandboxedPath } from "./sandbox.js";
export {
	type WriteFileInput,
	type WriteFileResult,
	writeFile,
} from "./write-file.js";

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
 * Each tool function is pre-bound to the worktree, so callers
 * don't need to pass the root on every invocation.
 */
export function createToolRegistry(worktreeRoot: string): ToolRegistry {
	return {
		write_file(input) {
			return writeFile(input, worktreeRoot);
		},
		run_command(input) {
			return runCommand(input, worktreeRoot);
		},
	};
}
