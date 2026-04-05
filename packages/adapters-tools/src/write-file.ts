import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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

/**
 * Write a file within the worktree sandbox.
 *
 * Creates parent directories as needed.
 * Returns a structured result — never throws on sandbox violations,
 * so the model sees the error and can retry.
 */
export function writeFile(
	input: WriteFileInput,
	worktreeRoot: string,
): WriteFileResult {
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
