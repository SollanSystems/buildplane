import { createEventStore as createEventStoreImpl } from "./event-store.ts";
import { createBuildplaneStorage as createBuildplaneStorageImpl } from "./index.ts";
import { createLearningStore as createLearningStoreImpl } from "./learning-store.ts";
import { resolveProjectLayout as resolveProjectLayoutImpl } from "./project-layout.ts";
import {
	exportRunBundle as exportRunBundleImpl,
	verifyRunFinalVerdict as verifyRunFinalVerdictImpl,
} from "./run-bundle.ts";

/** @type {typeof import('./index.ts').createBuildplaneStorage} */
export const createBuildplaneStorage = createBuildplaneStorageImpl;
/** @type {typeof import('./event-store.ts').createEventStore} */
export const createEventStore = createEventStoreImpl;
/** @type {typeof import('./learning-store.ts').createLearningStore} */
export const createLearningStore = createLearningStoreImpl;
/** @type {typeof import('./project-layout.ts').resolveProjectLayout} */
export const resolveProjectLayout = resolveProjectLayoutImpl;
/** @type {typeof import('./run-bundle.ts').exportRunBundle} */
export const exportRunBundle = exportRunBundleImpl;
/** @type {typeof import('./run-bundle.ts').verifyRunFinalVerdict} */
export const verifyRunFinalVerdict = verifyRunFinalVerdictImpl;
