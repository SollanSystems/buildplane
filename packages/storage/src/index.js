import { createEventStore as createEventStoreImpl } from "./event-store.ts";
import { createBuildplaneStorage as createBuildplaneStorageImpl } from "./index.ts";

/** @type {typeof import('./index.ts').createBuildplaneStorage} */
export const createBuildplaneStorage = createBuildplaneStorageImpl;
/** @type {typeof import('./event-store.ts').createEventStore} */
export const createEventStore = createEventStoreImpl;
