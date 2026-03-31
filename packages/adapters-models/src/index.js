import { createClaudeCodeExecutor as createClaudeCodeExecutorImpl } from "./claude-code-executor.ts";
import { createModelExecutor as createModelExecutorImpl } from "./model-executor.ts";

/** @type {typeof import('./claude-code-executor.ts').createClaudeCodeExecutor} */
export const createClaudeCodeExecutor = createClaudeCodeExecutorImpl;
/** @type {typeof import('./model-executor.ts').createModelExecutor} */
export const createModelExecutor = createModelExecutorImpl;
