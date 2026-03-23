import { createGitWorkspaceAdapter as createGitWorkspaceAdapterImpl } from "./worktree-adapter.ts";

/** @type {typeof import('./worktree-adapter.ts').createGitWorkspaceAdapter} */
export const createGitWorkspaceAdapter = createGitWorkspaceAdapterImpl;
