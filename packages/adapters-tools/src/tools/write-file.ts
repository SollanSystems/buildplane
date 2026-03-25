import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { assertPathWithinWorkspace } from "../path-guard.js";
import type { ToolContext, ToolImplementation } from "../tool-router.js";

export const writeFileTool: ToolImplementation = {
	name: "write_file",
	description:
		"Write content to a file within the workspace. Creates parent directories if needed.",
	parameters: {
		type: "object",
		properties: {
			path: {
				type: "string",
				description: "File path relative to the workspace root.",
			},
			content: {
				type: "string",
				description: "The content to write to the file.",
			},
		},
		required: ["path", "content"],
	},

	async execute(
		args: Record<string, unknown>,
		context: ToolContext,
	): Promise<unknown> {
		const filePath = String(args.path ?? "");
		const content = String(args.content ?? "");
		assertPathWithinWorkspace(
			context.workspaceRoot,
			filePath,
			"write_file path",
		);

		const absolutePath = resolve(context.workspaceRoot, filePath);
		try {
			mkdirSync(dirname(absolutePath), { recursive: true });
			writeFileSync(absolutePath, content, "utf8");
			return { written: filePath };
		} catch (err) {
			return {
				error: `Failed to write file: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	},
};
