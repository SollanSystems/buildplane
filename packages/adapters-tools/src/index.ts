export { assertPathWithinWorkspace } from "./path-guard.js";
export type {
	ToolContext,
	ToolImplementation,
	ToolRouter,
} from "./tool-router.js";
export { createToolRouter } from "./tool-router.js";
export { listDirectoryTool } from "./tools/list-directory.js";
export { readFileTool } from "./tools/read-file.js";
export { shellTool } from "./tools/shell.js";
export { writeFileTool } from "./tools/write-file.js";

import type { ToolRouter } from "./tool-router.js";
import { createToolRouter } from "./tool-router.js";
import { listDirectoryTool } from "./tools/list-directory.js";
import { readFileTool } from "./tools/read-file.js";
import { shellTool } from "./tools/shell.js";
import { writeFileTool } from "./tools/write-file.js";

/** Create a ToolRouter with all Phase 1 tools (shell, read_file, write_file, list_directory). */
export function createDefaultToolRouter(): ToolRouter {
	return createToolRouter([
		shellTool,
		readFileTool,
		writeFileTool,
		listDirectoryTool,
	]);
}
