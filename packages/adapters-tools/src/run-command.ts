import { spawnSync } from "node:child_process";
import {
	type CapabilityBundleV0,
	evaluateToolInvocation,
} from "@buildplane/capability-broker";
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

export interface RunCommandOptions {
	readonly capabilityBundle?: CapabilityBundleV0;
	/** When set, invoked on broker deny before returning (M3-S6 tape quarantine). */
	readonly onCapabilityDenied?: (detail: {
		tool: string;
		reason: string;
		target: string;
	}) => void;
}

/**
 * Run a shell command within the worktree sandbox.
 *
 * When `capabilityBundle` is set, the broker runs before spawn (M3-S7b), matching
 * the `write_file` gate (M3-S4): a command whose argv0 is not in the bundle's
 * `run_command.allowlist` is denied — fail closed, never spawned.
 * The command runs with cwd set to the worktree root (or a sandboxed subdirectory).
 * Returns a structured result — never throws on sandbox violations.
 */
export function runCommand(
	input: RunCommandInput,
	worktreeRoot: string,
	options?: RunCommandOptions,
): RunCommandResult {
	if (options?.capabilityBundle) {
		const decision = evaluateToolInvocation(
			options.capabilityBundle,
			{ tool: "run_command", command: input.command, args: input.args },
			{ worktreeRoot },
		);
		if (decision.decision === "deny") {
			const target = [input.command, ...(input.args ?? [])].join(" ");
			options?.onCapabilityDenied?.({
				tool: "run_command",
				reason: decision.reason,
				target,
			});
			return {
				success: false,
				exitCode: 1,
				stdout: "",
				stderr: "",
				error: `capability broker: ${decision.reason}`,
			};
		}
	}

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
