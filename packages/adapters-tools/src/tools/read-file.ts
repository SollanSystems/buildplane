import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertPathWithinWorkspace } from "../path-guard.js";
import type { ToolContext, ToolImplementation } from "../tool-router.js";

export const readFileTool: ToolImplementation = {
	name: "read_file",
	description:
		"Read the contents of a file within the workspace. Returns the file content as a string.",
	parameters: {
		type: "object",
		properties: {
			path: {
				type: "string",
				description: "File path relative to the workspace root.",
			},
		},
		required: ["path"],
	},

	async execute(
		args: Record<string, unknown>,
		context: ToolContext,
	): Promise<unknown> {
		const filePath = String(args.path ?? "");
		assertPathWithinWorkspace(
			context.workspaceRoot,
			filePath,
			"read_file path",
		);

		const absolutePath = resolve(context.workspaceRoot, filePath);
		try {
			const content = readFileSync(absolutePath, "utf8");
			return { content };
		} catch (err) {
			return {
				error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	},
};
