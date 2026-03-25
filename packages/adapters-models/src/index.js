import { createModelExecutor as createModelExecutorImpl } from "./model-executor.ts";

/** @type {typeof import('./model-executor.ts').createModelExecutor} */
export const createModelExecutor = createModelExecutorImpl;
