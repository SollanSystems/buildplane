import { spawnSync } from "node:child_process";
import { resolveSandboxedPath } from "./sandbox.js";

export interface RunCommandInput {
	readonly command: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
}

export interface RunCommandResult {
	readonly success: boolean;
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly error?: string;
}

/**
 * Run a shell command within the worktree sandbox.
 *
 * The command runs with cwd set to the worktree root (or a sandboxed subdirectory).
 * Returns a structured result — never throws on sandbox violations.
 */
export function runCommand(
	input: RunCommandInput,
	worktreeRoot: string,
): RunCommandResult {
	let cwd: string;
	try {
		if (input.cwd) {
			cwd = resolveSandboxedPath(worktreeRoot, input.cwd, "run_command cwd", {
				allowRoot: true,
			});
		} else {
			cwd = worktreeRoot;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			exitCode: 1,
			stdout: "",
			stderr: "",
			error: message,
		};
	}

	try {
		const result = spawnSync(input.command, [...(input.args ?? [])], {
			cwd,
			encoding: "utf8",
			timeout: 30_000,
		});

		if (result.error) {
			return {
				success: false,
				exitCode: 1,
				stdout: "",
				stderr: result.error.message,
				error: result.error.message,
			};
		}

		const exitCode = result.status ?? 1;
		return {
			success: exitCode === 0,
			exitCode,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			exitCode: 1,
			stdout: "",
			stderr: "",
			error: message,
		};
	}
}
