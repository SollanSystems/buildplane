import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { assertPathWithinWorkspace } from "../path-guard.js";
import type { ToolContext, ToolImplementation } from "../tool-router.js";

export const shellTool: ToolImplementation = {
	name: "shell",
	description:
		"Execute a shell command in the workspace. The command runs synchronously and returns stdout, stderr, and exit code.",
	parameters: {
		type: "object",
		properties: {
			command: {
				type: "string",
				description: "The command to execute (e.g. 'npm test')",
			},
			cwd: {
				type: "string",
				description:
					"Working directory relative to workspace root. Defaults to workspace root.",
			},
		},
		required: ["command"],
	},

	async execute(
		args: Record<string, unknown>,
		context: ToolContext,
	): Promise<unknown> {
		const command = String(args.command ?? "");
		const cwdRel = args.cwd !== undefined ? String(args.cwd) : undefined;

		if (cwdRel !== undefined) {
			assertPathWithinWorkspace(context.workspaceRoot, cwdRel, "shell cwd");
		}

		const cwd = cwdRel
			? resolve(context.workspaceRoot, cwdRel)
			: context.workspaceRoot;

		context.budgetEnforcer?.recordCommand();

		const result = spawnSync(command, {
			cwd,
			shell: true,
			encoding: "utf8",
			timeout: 120_000,
		});

		return {
			exitCode: result.status ?? 1,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
		};
	},
};
