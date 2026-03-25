import { assertPathWithinWorkspace as assertPathWithinWorkspaceImpl } from "./path-guard.ts";
import { createToolRouter as createToolRouterImpl } from "./tool-router.ts";
import { listDirectoryTool as listDirectoryToolImpl } from "./tools/list-directory.ts";
import { readFileTool as readFileToolImpl } from "./tools/read-file.ts";
import { shellTool as shellToolImpl } from "./tools/shell.ts";
import { writeFileTool as writeFileToolImpl } from "./tools/write-file.ts";

/** @type {typeof import('./path-guard.ts').assertPathWithinWorkspace} */
export const assertPathWithinWorkspace = assertPathWithinWorkspaceImpl;

/** @type {typeof import('./tool-router.ts').createToolRouter} */
export const createToolRouter = createToolRouterImpl;

/** @type {typeof import('./tools/list-directory.ts').listDirectoryTool} */
export const listDirectoryTool = listDirectoryToolImpl;

/** @type {typeof import('./tools/read-file.ts').readFileTool} */
export const readFileTool = readFileToolImpl;

/** @type {typeof import('./tools/shell.ts').shellTool} */
export const shellTool = shellToolImpl;

/** @type {typeof import('./tools/write-file.ts').writeFileTool} */
export const writeFileTool = writeFileToolImpl;

/** Create a ToolRouter with all Phase 1 tools. */
export function createDefaultToolRouter() {
	return createToolRouterImpl([
		shellToolImpl,
		readFileToolImpl,
		writeFileToolImpl,
		listDirectoryToolImpl,
	]);
}
