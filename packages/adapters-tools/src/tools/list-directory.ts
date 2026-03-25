import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertPathWithinWorkspace } from "../path-guard.js";
import type { ToolContext, ToolImplementation } from "../tool-router.js";

export const listDirectoryTool: ToolImplementation = {
	name: "list_directory",
	description:
		"List the contents of a directory within the workspace. Returns an array of entries with name and type.",
	parameters: {
		type: "object",
		properties: {
			path: {
				type: "string",
				description:
					"Directory path relative to the workspace root. Defaults to workspace root.",
			},
		},
	},

	async execute(
		args: Record<string, unknown>,
		context: ToolContext,
	): Promise<unknown> {
		const dirPath = args.path !== undefined ? String(args.path) : ".";
		if (dirPath !== ".") {
			assertPathWithinWorkspace(
				context.workspaceRoot,
				dirPath,
				"list_directory path",
			);
		}

		const absolutePath = resolve(context.workspaceRoot, dirPath);
		try {
			const entries = readdirSync(absolutePath);
			return {
				entries: entries.map((name) => {
					try {
						const st = statSync(join(absolutePath, name));
						return {
							name,
							type: st.isDirectory() ? "directory" : "file",
						};
					} catch {
						return { name, type: "unknown" };
					}
				}),
			};
		} catch (err) {
			return {
				error: `Failed to list directory: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	},
};
