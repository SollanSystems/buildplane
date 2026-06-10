import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	type CapabilityBundleV0,
	evaluateToolInvocation,
} from "@buildplane/capability-broker";
import { resolveSandboxedPath } from "./sandbox.js";

export interface WriteFileInput {
	readonly path: string;
	readonly content: string;
}

export interface WriteFileResult {
	readonly success: boolean;
	readonly path?: string;
	readonly error?: string;
}

export interface WriteFileOptions {
	readonly capabilityBundle?: CapabilityBundleV0;
}

/**
 * Write a file within the worktree sandbox.
 *
 * When `capabilityBundle` is set, the broker runs before sandbox resolution (M3-S4).
 * Creates parent directories as needed.
 * Returns a structured result — never throws on sandbox violations,
 * so the model sees the error and can retry.
 */
export function writeFile(
	input: WriteFileInput,
	worktreeRoot: string,
	options?: WriteFileOptions,
): WriteFileResult {
	if (options?.capabilityBundle) {
		const decision = evaluateToolInvocation(
			options.capabilityBundle,
			{ tool: "write_file", path: input.path },
			{ worktreeRoot },
		);
		if (decision.decision === "deny") {
			return {
				success: false,
				error: `capability broker: ${decision.reason}`,
			};
		}
	}

	try {
		const resolvedPath = resolveSandboxedPath(
			worktreeRoot,
			input.path,
			"write_file path",
		);
		mkdirSync(dirname(resolvedPath), { recursive: true });
		writeFileSync(resolvedPath, input.content, "utf8");
		return { success: true, path: input.path };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { success: false, error: message };
	}
}
